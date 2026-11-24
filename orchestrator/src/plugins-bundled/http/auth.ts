/**
 * Daemon token and auth middleware — step 4.1.
 *
 * The file `~/.timon/daemon-token` (under TIMON_HOME) is the secret that
 * protects the API as soon as it no longer listens on the loopback only. It is
 * generated at first boot, never logged, and lives in the `secrets` zone.
 *
 * The middleware must be mounted on the app **before** `express.json`: an
 * unauthenticated 25 MB POST has no reason to be parsed. It cannot
 * live in the `apply()` of `@timon/http` — too late, `express.json` is
 * already set by `boot.ts`.
 */
import { guardPluginPublicRequest, matchPluginPublicPath } from '../../plugins/public-paths.js';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { DAEMON_TOKEN_FILE } from '../../paths.js';
import { dbApi } from '../../db.js';
import { hashSessionToken, readCookie, renewedExpiry, serializeSessionCookie, SESSION_COOKIE } from '../../users/session.js';
import { config } from '../../config/load.js';
import '../../users/identity.js';
import { freeAccountAllowed, FREE_ACCOUNT_RESTRICTED_MESSAGE } from '../../users/free-access.js';
import { EGRESS_PROXY_TOKEN_SCOPE } from '../../users/permissions.js';
import { INTEGRATION_INBOUND_PATH } from '../../plugins/integration-http-path.js';
import { TRIGGER_HOOK_PATH } from '../../triggers/hook-path.js';
import { PLUGIN_HOOK_PATH } from '../../plugins/webhook-path.js';
import { authenticateRemoteMcp, isRemoteMcpPath } from '../../remote-mcp/auth.js';
import { setupListenerExposed } from '../../users/setup-token.js';
import { isDeviceToken, lookupDevice } from '../../users/devices.js';
import { rejectConversionRoute } from '../../users/conversion-mission.js';
import { auditDeadDeviceUse, deviceTransportAllowed, noteDeviceUse, sendDeviceRequiresTls } from '../../users/devices-http.js';
import { apiError } from '../../api-error.js';
import { daemonHostPolicy, hostAllowed, type HostPolicy } from '../../http-host.js';

export { DAEMON_TOKEN_FILE };

const PUBLIC_HEALTH = '/api/health';

/**
 * secu-9 — the endpoints reachable WITHOUT an identity, listed one by one.
 *
 * The previous rule was a prefix (`/api/auth/`), so every future route mounted
 * under it inherited public access by accident — `POST /api/auth/password` is
 * exactly such a route, and it must not be. Express normalises `req.path`, so
 * the prefix was not bypassable as such; the risk was ours, not an attacker's.
 *
 * Invitations are not here any more: the plugin that serves the accounts
 * declares its own public paths (`routes.publicPaths`, `plugins/public-paths.ts`).
 */
const PUBLIC_ENDPOINTS: readonly { method: string; path: RegExp }[] = [
  { method: 'POST', path: INTEGRATION_INBOUND_PATH },
  // This exact route authenticates with its own 256-bit path secret.
  { method: 'POST', path: /^\/api\/workflows\/hooks\/[a-f0-9]{64}\/?$/ },
  // Native trigger webhooks: the route verifies the trigger's own secret
  // (HMAC or shared token) on the raw body and ignores `req.auth`.
  { method: 'POST', path: TRIGGER_HOOK_PATH },
  // Plugin webhooks: the host verifies the webhook's own secret, in its
  // declared format, on the raw body before the plugin's handler runs.
  { method: 'POST', path: PLUGIN_HOOK_PATH },
  // Their subscription check (Meta's `hub.challenge`): answered by the host
  // alone with the exact verify token, no plugin code.
  { method: 'GET', path: PLUGIN_HOOK_PATH },
  // The publisher sends the browser back here from its own site, with no
  // session of ours (and on the loopback address, not the app's origin). The
  // single-use, 10-minute `state` and the PKCE verifier kept by the daemon are
  // the credential: an unknown `state` does nothing (`oauth.ts`, `takePending`).
  { method: 'GET', path: /^\/api\/mcp\/oauth\/callback$/ },
  { method: 'GET', path: /^\/api\/auth\/me$/ },
  // Only the id of the plugin that serves accounts: the invitation page asks it before any session exists.
  { method: 'GET', path: /^\/api\/auth\/account-provider$/ },
  // Only which of two built-in palettes the sign-in page wears (`users/public-theme.ts`).
  { method: 'GET', path: /^\/api\/auth\/theme$/ },
  { method: 'POST', path: /^\/api\/auth\/setup$/ },
  // Email codes (`docs/EMAIL-CODES.md`): the caller has no session by
  // definition. Setup ones answer 409 once an account exists; the reset ones
  // authenticate by the mailed code, throttled and burnt by the handler.
  { method: 'POST', path: /^\/api\/auth\/setup\/email-code(?:\/resend)?$/ },
  { method: 'POST', path: /^\/api\/auth\/password-reset(?:\/resend|\/confirm)?$/ },
  { method: 'POST', path: /^\/api\/auth\/login$/ },
  { method: 'POST', path: /^\/api\/auth\/logout$/ },
  // Followed from a mail client, which carries no session cookie of ours.
  // The token in the body is the whole credential; the handler treats it as
  // single-use and short-lived.
  { method: 'POST', path: /^\/api\/auth\/email\/confirm$/ },
  // Device pairing: the one-time code in the body is the credential, checked,
  // throttled and burnt by the handler (`users/devices-http.ts`).
  { method: 'POST', path: /^\/api\/devices\/redeem$/ },
];

/**
 * Auth is required when set to `required`, or as soon as anyone
 * but this machine can reach the daemon. A loopback daemon is not enough: an
 * exposed WebUI (`app.listen.host`) or a TLS reverse proxy reaches it from
 * 127.0.0.1 on behalf of any visitor, who would otherwise walk the whole API
 * anonymously until the first account exists (TODO #346).
 */
export function authIsRequired(cfg: {
  daemon: { auth: 'auto' | 'required' | 'off'; listen: { host: string }; behindTlsProxy: boolean };
  app: { listen: { host: string } };
}): boolean {
  const { auth, listen } = cfg.daemon;
  if (auth === 'required') return true;
  // `off` gets no branch of its own: `loadConfig` refuses it wherever `auto`
  // would require auth, and a config forced in memory (`setConfig`) that
  // skipped that check must not open an exposed listener (TODO #528).
  return listen.host !== '127.0.0.1' || setupListenerExposed(cfg);
}

/**
 * Reads the token, or creates it (64 hex, 0600) if it does not exist yet.
 * An empty file is treated as missing: we do not serve a null secret.
 * A token already set — even of another shape than a 64-char hex — is kept:
 * the operator has the right to impose one.
 */
export function ensureDaemonToken(file: string = DAEMON_TOKEN_FILE): string {
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return existing;
  } catch { /* missing or unreadable: (re)generate */ }
  const token = randomBytes(32).toString('hex');
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, token, { encoding: 'utf8', mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* FS without Unix permissions */ }
  return token;
}

/**
 * The `Authorization` header is the only place a token is read. A token in
 * the query string leaks into access logs, browser history, the `Referer`
 * header and every proxy on the way, and the SSE streams used to keep that
 * escape hatch for `EventSource`. No client needs it any more: the browser
 * reaches the streams through the app's proxy (its session cookie is relayed
 * as a header), and every other client sends a Bearer header.
 */
function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const match = /^Bearer\s+(\S+)/i.exec(header);
  return match?.[1] || undefined;
}

/**
 * A paired device's Bearer (`users/devices.ts`). Answers the request itself
 * on every refusal: a device token that names a dead row must hear 401, not
 * fall through to a cookie or to the first-run hole.
 */
function authenticateDevice(req: Request, res: Response, given: string): boolean {
  if (!deviceTransportAllowed(req)) {
    sendDeviceRequiresTls(res);
    return false;
  }
  const found = lookupDevice(given);
  if (found.kind !== 'live') {
    if (found.kind === 'dead') auditDeadDeviceUse(req, found.device);
    res.status(401).json(apiError('device_invalid', 'unauthorized'));
    return false;
  }
  if (!freeAccountAllowed(found.user.id)) {
    res.status(403).json(apiError('free_account_restricted', FREE_ACCOUNT_RESTRICTED_MESSAGE));
    return false;
  }
  // The relay is the first CSRF barrier; when it forwards the browser's
  // origin headers, the daemon checks them too, as for a cookie.
  if (isCrossSiteMutation(req)) {
    res.status(403).json(apiError('cross_site_refused', 'cross-site request refused'));
    return false;
  }
  req.auth = {
    kind: 'device',
    user: found.user,
    isSuperadmin: found.user.is_superadmin,
    deviceId: found.device.id,
  };
  noteDeviceUse(req, found.device);
  return true;
}

function tokensEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function isPublicPath(req: Request): boolean {
  if (req.method === 'GET' && req.path === PUBLIC_HEALTH) return true;
  return PUBLIC_ENDPOINTS.some((e) => e.method === req.method && e.path.test(req.path));
}

/**
 * Resolve the caller: daemon-token (CLI/operator superadmin) first, then
 * a paired device's `tdev_` Bearer, then a live `api_tokens` Bearer (spawned
 * agents), then the session cookie.
 * Identity is attached even when auth is not required, so a loopback
 * browser that logged in is not silently treated as anonymous.
 *
 * Anonymous is tolerated only while the users table is empty (first-run
 * setup). Once any account exists, a missing identity is 401 even on
 * loopback — the Next proxy is a browser, not a CLI. CLI and MCP send
 * `Authorization: Bearer` themselves (`TIMON_API_TOKEN` = this
 * daemon-token). Spawned agents send a per-mission `api_tokens` row
 * instead — never this daemon-token.
 *
 * `/api/health` and the endpoints of `PUBLIC_ENDPOINTS` stay public in
 * every case — for a request whose `Host` the daemon's policy admits
 * (`http-host.ts`): without a bearer credential, a loopback daemon answers
 * 421 to any other name.
 */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Whether a cookie-authenticated mutation comes from another site.
 * `Sec-Fetch-Site` is authoritative when the browser sends it (`cross-site`
 * refused; `same-origin`, `same-site`, `none` = navigation/typed URL pass).
 * Without it, `Origin` is compared to the host the browser used (the Next
 * proxy relays it as `X-Forwarded-Host`, `app/src/lib/ui/proxy-auth.ts`); an
 * opaque `Origin: null` (sandboxed iframe, cross-origin redirect) is refused.
 * No header at all — a CLI, a non-browser client — passes: those do not carry
 * a cookie without meaning to.
 */
export function isCrossSiteMutation(req: Request): boolean {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return false;
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'cross-site';
  const origin = req.headers.origin;
  if (typeof origin !== 'string') return false;
  if (origin === 'null') return true;
  const host = typeof req.headers['x-forwarded-host'] === 'string'
    ? req.headers['x-forwarded-host'].split(',')[0]!.trim()
    : req.headers.host;
  try {
    return new URL(origin).host !== host;
  } catch {
    return true;
  }
}

export function createDaemonAuthMiddleware(opts: {
  token: string;
  required: boolean;
  /** Tests inject it; the daemon reads its config at every request. */
  hostPolicy?: () => HostPolicy;
}): RequestHandler {
  const hostPolicy = opts.hostPolicy ?? (() => daemonHostPolicy(config()));
  return (req: Request, res: Response, next: NextFunction): void => {
    // The remote MCP endpoint takes its own restricted token and nothing else
    // (`remote-mcp/auth.ts`): decided before any other credential is read.
    if (isRemoteMcpPath(req.path)) {
      if (authenticateRemoteMcp(req, res)) next();
      return;
    }
    const given = extractToken(req);
    if (given !== undefined && tokensEqual(opts.token, given)) {
      const user = dbApi.getActiveSuperadmin() ?? null;
      req.auth = { kind: 'daemon-token', user, isSuperadmin: true };
      next();
      return;
    }
    if (given !== undefined && isDeviceToken(given)) {
      if (authenticateDevice(req, res, given)) next();
      return;
    }
    if (given !== undefined) {
      const live = dbApi.getLiveApiToken(hashSessionToken(given));
      if (live) {
        if (live.user && !freeAccountAllowed(live.user.id)) {
          res.status(403).json(apiError('free_account_restricted', FREE_ACCOUNT_RESTRICTED_MESSAGE));
          return;
        }
        req.auth = {
          kind: 'api-token',
          user: live.user,
          isSuperadmin: live.isSuperadmin,
          actorId: live.actorId,
          permissions: live.permissions,
          missionId: live.token.mission_id,
        };
        dbApi.touchApiToken(live.token.token_hash);
        // Before any route: the token of a conversion mission reaches a closed list (#467).
        if (rejectConversionRoute(req, res)) return;
        next();
        return;
      }
      // A mission's egress proxy credential opens the proxy, never a route —
      // not even the anonymous loopback of a machine with no account (TODO #590).
      if (dbApi.getApiTokenByHash(hashSessionToken(given))?.scope === EGRESS_PROXY_TOKEN_SCOPE) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
    }
    // Past this point the caller holds no bearer credential: what it gets, it
    // gets for reaching this address (first-run setup, public paths). A page
    // that rebound its own domain onto the loopback must not be that caller.
    if (!hostAllowed(req.headers.host, hostPolicy())) {
      res.status(421).json(apiError('misdirected_request', 'misdirected request'));
      return;
    }
    const raw = readCookie(
      typeof req.headers.cookie === 'string' ? req.headers.cookie : undefined,
      SESSION_COOKIE,
    );
    if (raw) {
      const live = dbApi.getLiveSession(hashSessionToken(raw));
      if (live) {
        if (!freeAccountAllowed(live.user.id) && req.path !== '/api/auth/logout') {
          res.status(403).json(apiError('free_account_restricted', FREE_ACCOUNT_RESTRICTED_MESSAGE));
          return;
        }
        // A cookie is sent by the browser on its own: a mutation must come
        // from our own origin, or a page elsewhere drives the daemon with the
        // user's session (SECU-USERS U-10, defence in depth over SameSite).
        if (isCrossSiteMutation(req)) {
          res.status(403).json(apiError('cross_site_refused', 'cross-site request refused'));
          return;
        }
        req.auth = {
          kind: 'session',
          user: live.user,
          isSuperadmin: live.user.is_superadmin,
        };
        dbApi.touchSession(live.session.token_hash);
        const now = Date.now();
        const expiresAt = renewedExpiry(live.session, now);
        if (expiresAt !== null) {
          dbApi.setSessionExpiry(live.session.token_hash, expiresAt);
          // The browser's copy of the cookie dies on its own `Max-Age`: re-issue it with the new one.
          const { listen, behindTlsProxy } = config().daemon;
          res.append('Set-Cookie', serializeSessionCookie(raw, {
            maxAgeSec: Math.floor((expiresAt - now) / 1000),
            secure: behindTlsProxy || listen.host !== '127.0.0.1',
          }));
        }
        next();
        return;
      }
    }
    if (isPublicPath(req)) {
      next();
      return;
    }
    // An anonymous path a plugin declared (`routes.publicPaths`), behind the core's guards.
    const publicPlugin = matchPluginPublicPath(req.method, req.path);
    if (publicPlugin) {
      if (guardPluginPublicRequest(req, res, publicPlugin, { crossSite: isCrossSiteMutation(req) })) next();
      return;
    }
    // Loopback stays open only for first-run setup. After that, no
    // identity means 401 even when `required` is false.
    if (!opts.required && dbApi.countUsers() === 0) {
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}
