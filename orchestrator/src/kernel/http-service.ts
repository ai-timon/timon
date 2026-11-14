/**
 * `http` service — the Express application shared by the modules.
 *
 * Cordis knows nothing about HTTP: this service is our addition. It exposes the
 * Express app under `ctx.http` and provides `ctx.http.router()`, which creates a `Router`,
 * mounts it, and registers its removal as an effect of the CALLING module. That is what
 * makes a route reversible: unloading a module removes its routes, without a
 * restart.
 *
 * Why a service method and not a `ctx.router()` function set by
 * `ctx.provide`: a function does not know who calls it, so its effect
 * would hook onto the fiber of `@timon/http` and the routes would only leave at
 * that fiber's death. A `Service` method sees in `this.ctx` the context
 * of the caller (Cordis context tracing) — the effect lands in the right
 * place.
 *
 * Unmounting goes through a shell: Express has no `app.unuse`, and
 * hacking at `app._router.stack` breaks with every version. The mounted router therefore
 * stays in place and becomes an inert pass-through when its owner leaves.
 *
 * Route claims (audit #8): Express resolves a path with the FIRST router that
 * matches it, so two modules registering the same method+path silently shadow
 * each other — and the winner depends on load order. That is a permission bug
 * waiting to happen (an unguarded route hiding a guarded one). Every router
 * handed out by `router()` therefore claims its method+path, and a second
 * claim throws at registration time: the module fails to apply, the activation
 * audit names it, and the daemon refuses to start. Loud beats silent.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import express, { type Express, type Router, type RequestHandler } from 'express';
import { Service, type Context } from '@deepseek-ai/cordis';
import { CATALOG } from './catalog.js';
import { licenseState } from '../license/runtime.js';
import { fixedComposition, licenseCurrentlyValid } from '../license/capabilities.js';
import { covers } from '../license/license.js';
import { catchAsyncHandlers, routeErrorHandler } from './async-routes.js';
import { config } from '../config/load.js';
import { daemonHostPolicy, hostAllowed, type HostPolicy } from '../http-host.js';

declare module '@deepseek-ai/cordis' {
  interface Context {
    http: HttpService;
  }
}

/** Methods whose registration claims a path. `all`/`use` are middleware-ish
 *  (a module legitimately stacks several), so they are left unguarded. */
const CLAIMED_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type ClaimedMethod = (typeof CLAIMED_METHODS)[number];

/**
 * A WebSocket upgrade handler. Express never sees upgrades (they bypass the
 * request pipeline, auth middleware included), so a module that speaks
 * WebSocket registers here and authenticates the request ITSELF. Returns
 * true when it took the socket; false lets the next handler try.
 */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

/**
 * Whether an upgrade may reach the handlers under the daemon's `Host` policy
 * (`http-host.ts`) — the rule the auth middleware applies to every other
 * request. A bearer credential exempts it there, and does here: a browser
 * cannot attach an `Authorization` header to a WebSocket, so a page that
 * rebound its own domain onto the loopback never carries one, and the handler
 * still checks the credential itself.
 */
export function upgradeHostAllowed(req: IncomingMessage, policy: HostPolicy): boolean {
  if (/^Bearer\s+\S/i.test(req.headers.authorization ?? '')) return true;
  return hostAllowed(req.headers.host, policy);
}

/**
 * Canonical key of a route claim. Parameter NAMES are erased: `/api/roles/:id`
 * and `/api/roles/:roleId` match the same requests, so they collide.
 */
export function routeClaimKey(method: string, prefix: string, path: string): string {
  const joined = `${prefix.replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
  const normalised = joined.replace(/:[^/]+/g, ':').replace(/\/+$/, '') || '/';
  return `${method.toUpperCase()} ${normalised}`;
}

export class HttpService extends Service {
  /** The Express app itself, for the uses `router()` does not cover. */
  public readonly app: Express;

  /** Claimed route key → owning module, for the collision guard. */
  private readonly claims = new Map<string, string>();

  /** Live upgrade handlers, in registration order. */
  private readonly upgrades = new Set<UpgradeHandler>();

  constructor(ctx: Context, app: Express) {
    super(ctx, 'http');
    this.app = app;
    // Before any module mounts a route: a rejected async handler must reach
    // `next(err)`, not take the daemon down (TODO #580).
    catchAsyncHandlers();
  }

  /**
   * Mounts `router` under `prefix` and returns what removes it. `owner` names the
   * module in the log when one of its routes fails.
   */
  mount(prefix: string, router: Router, owner = `router ${prefix}`): () => void {
    let live: Router | null = router;
    const shell: Router = express.Router();
    shell.use((req, res, next) => {
      if (!live) return next();
      live(req, res, routeErrorHandler(owner, req, res, next));
    });
    this.app.use(prefix, shell);
    return () => { live = null; };
  }

  /**
   * Creates a router mounted under `prefix`, removed when the calling module
   * unloads. It is the modules' entry point: they never write on
   * the app directly.
   */
  router(prefix = '/'): Router {
    const router = express.Router();
    const owner = this.ctx.fiber?.name ?? 'unknown';
    const release = this.claimRoutesOf(router, prefix, owner);
    const remove = this.mount(prefix, router, owner);
    this.ctx.effect(() => () => { remove(); release(); });
    return router;
  }

  /**
   * Registers a WebSocket upgrade handler, removed when the calling module
   * unloads — same reversibility as `router()`.
   */
  upgrade(handler: UpgradeHandler): void {
    this.upgrades.add(handler);
    this.ctx.effect(() => () => { this.upgrades.delete(handler); });
  }

  /**
   * Entry point wired on the HTTP server's `upgrade` event. An upgrade no
   * module claims is destroyed: leaving it open would hold a socket forever.
   * A misdirected one gets the same neutral 421 as any other request, before
   * a handler sees it: the session cookie a browser attaches to a WebSocket
   * must not open a shell to a page that rebound its domain here.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, policy: () => HostPolicy = () => daemonHostPolicy(config())): void {
    if (!upgradeHostAllowed(req, policy())) {
      socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    for (const handler of this.upgrades) {
      try {
        if (handler(req, socket, head)) return;
      } catch {
        socket.destroy();
        return;
      }
    }
    socket.destroy();
  }

  /**
   * Wraps the routing methods of `router` so each registration claims its
   * method+path. Returns the disposer that frees this router's claims — a
   * reloaded module must be able to register its routes again.
   */
  private claimRoutesOf(router: Router, prefix: string, owner: string): () => void {
    const mine: string[] = [];
    const module = CATALOG.find((entry) => entry.id === owner || entry.name === owner);
    const checkLicense: RequestHandler = (_req, res, next) => {
      if (module) {
        const state = licenseState();
        // Recomposition can be delayed or fail: a still-mounted paid route
        // must not keep accepting new requests after its rights were removed.
        // `@timon/updates` is exempt like in `planEntries`: a locked beta
        // build must still show the newer version that ends the lock.
        if (module.tier !== 'core' && !['@timon/users', '@timon/web-app', '@timon/updates'].includes(module.id) && (module.licensed || fixedComposition(state)) && (!licenseCurrentlyValid(state) || !covers(state.modules, module.id))) {
          res.status(403).json({ error: 'license_required', module: module.id });
          return;
        }
      }
      next();
    };
    for (const method of CLAIMED_METHODS) {
      const original = router[method].bind(router) as (...args: unknown[]) => Router;
      const guarded = (path: unknown, ...handlers: unknown[]): Router => {
        if (typeof path === 'string') {
          const key = routeClaimKey(method, prefix, path);
          const taken = this.claims.get(key);
          if (taken !== undefined) {
            throw new Error(
              `[http] route conflict: ${key} is already registered by ${taken}, `
              + `${owner} cannot register it too (Express would silently keep the first one)`,
            );
          }
          this.claims.set(key, owner);
          mine.push(key);
        }
        return original(path, checkLicense, ...handlers);
      };
      (router as unknown as Record<ClaimedMethod, unknown>)[method] = guarded;
    }
    return () => {
      for (const key of mine) this.claims.delete(key);
      mine.length = 0;
    };
  }
}

export const name = 'timon-http';

/** `@timon/http` plugin: publishes the Express app passed by `boot.ts`. */
export function createHttpPlugin(app: Express) {
  return {
    name,
    apply(ctx: Context) {
      ctx.plugin(HttpService, app);
    },
  };
}
