/**
 * Which daemon the app relays a browser request to (TODO #329, multi-machine).
 *
 * The browser only ever talks to this app, on one origin; the app relays to a
 * daemon. That daemon is the request's *target*:
 *
 *   - `localTarget()`        the daemon this app belongs to (`ORCHESTRATOR_URL`).
 *                            Workers, webhooks, the daemon-token clients and
 *                            anything that runs outside a browser request use
 *                            this one, explicitly — never `resolveTarget`.
 *   - `resolveTarget(req?)`  the machine the request names (`machineIdFromRequest`):
 *                            the `X-Timon-Machine` header when present — a
 *                            desktop window pinned to one machine — else the
 *                            non-secret `timon_machine` cookie, the machine the
 *                            browser has switched to. Both carry an id, never a
 *                            URL. Without `req`, the headers of the current
 *                            Next request scope; outside a request, local.
 *                            A remote id is resolved by the LOCAL daemon, with
 *                            the LOCAL session (`credential.ts`): it answers
 *                            the machine's URL and device token, for a machine
 *                            of that person only. When it cannot — no session,
 *                            an id that is not theirs, the daemon unable to
 *                            say — the target is `unavailable`: every relay
 *                            answers a typed refusal, and nothing is sent,
 *                            neither there nor here. Falling back to local
 *                            would send a mutation meant for one machine to
 *                            another one.
 *   - `targetFor(path, req?)` `resolveTarget`, except for the routes anchored
 *                            on the local daemon whatever the active machine
 *                            (`anchoredLocally`): the account (`/api/auth/*`,
 *                            the local session's own) and the fleet
 *                            (`/api/machines*`, which is how one gets back).
 *   - `relayFetch(target, path, init, opts?)`  the one fetch to a target. Local:
 *                            a plain `fetch(url + path, init)`, nothing changed.
 *                            Remote: the policy below, applied here and nowhere
 *                            else, so no caller can forget a piece of it.
 *
 * Remote policy:
 *   - identity: the caller's `cookie` and `authorization` are dropped; the only
 *     credential sent is the target's device token. The local session cookie
 *     and `TIMON_DAEMON_TOKEN` never leave for another machine.
 *   - session: a remote target exists only for a request that carries a local
 *     session the local daemon accepted (it is what hands out the token);
 *     without one the app would be an open relay to the remote.
 *   - `Set-Cookie` from the remote is purged: a remote `timon_session` would
 *     otherwise land on this origin and replace the local session.
 *   - `/api/auth/*` is refused: the remote account is the device token's, a
 *     relayed login/logout/password change would act on the wrong account.
 *   - origin: a device token is a Bearer, which the remote daemon never checks
 *     for cross-site requests, so the relay is the only CSRF barrier. A
 *     mutation is relayed only with the browser's headers in hand, and only
 *     when they PROVE same-origin: `Sec-Fetch-Site: same-origin`, or else an
 *     `Origin` whose host is the one the browser reached. Neither header is
 *     a refusal — the lenient rule of `foreignMutation`, fit for the local
 *     daemon which checks the cookie path itself, is not enough here.
 *     A read a foreign site started (`Sec-Fetch-Site: cross-site|same-site`)
 *     is refused too: the Lax cookie rides along a top-level navigation.
 *   - transport: HTTPS only (HTTP tolerated on loopback), redirects never
 *     followed, an unreachable machine answers a typed JSON 502.
 *
 * WebSocket upgrades (the terminal) cannot go through `fetch`: its
 * relay builds the request itself, and takes its credential and the same
 * policy from `upgradeCredential()`.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { ORCHESTRATOR_URL } from '../paths';
import { SESSION_COOKIE } from '../ui/proxy-auth';
import { foreignMutationRefusal } from '../ui/same-origin-mutation';
import { forgetMachineCredentials, machineCredential, type CredentialFailure } from './credential';
import { isMachineId, LOCAL_MACHINE_ID, MACHINE_HEADER } from './machine-id';

export type TargetKind = 'local' | 'remote' | 'unavailable';

interface TargetBase {
  /** `'local'` for the local daemon, the registry id of a remote machine. */
  readonly id: string;
  /** Daemon base URL, no trailing slash; paths are appended to it. */
  readonly url: string;
  /** Budget for a short server-side call (SSR probes); streams ignore it. */
  readonly timeoutMs: number;
}

export interface LocalTarget extends TargetBase {
  readonly kind: 'local';
}

export interface RemoteTarget extends TargetBase {
  readonly kind: 'remote';
  /** The device token this user holds for that machine (kept by the local
   *  daemon). Its only source of credential: nothing else is ever sent. */
  deviceToken(): Promise<string>;
}

/** A remote machine named by the cookie that cannot be relayed to. Carries no
 *  URL on purpose: there is nowhere to send anything. */
export interface UnavailableTarget {
  readonly kind: 'unavailable';
  /** The id the cookie named, so the page knows which machine failed. */
  readonly id: string;
  readonly failure: CredentialFailure;
  readonly timeoutMs: number;
}

export type Target = LocalTarget | RemoteTarget | UnavailableTarget;

/** Non-secret cookie naming the active machine. Holds an id, never a URL. */
export const MACHINE_COOKIE = 'timon_machine';
export { LOCAL_MACHINE_ID, MACHINE_HEADER };

const LOCAL_TIMEOUT_MS = 2_000;
/** A machine across the internet: a loopback budget would fail every read. */
const REMOTE_TIMEOUT_MS = 8_000;

export function localTarget(): LocalTarget {
  return { kind: 'local', id: LOCAL_MACHINE_ID, url: ORCHESTRATOR_URL.replace(/\/+$/, ''), timeoutMs: LOCAL_TIMEOUT_MS };
}

/** What `resolveTarget` reads of a request: its `X-Timon-Machine` and `Cookie`
 *  headers. A `Request`, a `NextRequest` or a wrapped `IncomingMessage` all fit. */
export interface TargetRequest {
  readonly headers: { get(name: string): string | null };
}

/** A Node request's headers seen as a `TargetRequest` — the WebSocket
 *  relays live in `server.ts`, outside Next's request scope. */
export function nodeRequestHeaders(headers: IncomingHttpHeaders): TargetRequest['headers'] {
  return {
    get(name: string): string | null {
      const value = headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? value.join(', ') : value;
    },
  };
}

export async function resolveTarget(req?: TargetRequest): Promise<Target> {
  const named = req ? machineIdFromRequest(req.headers) : await machineFromRequestScope();
  if (named.kind === 'malformed') return { kind: 'unavailable', id: MALFORMED_MACHINE_ID, failure: 'unknown', timeoutMs: LOCAL_TIMEOUT_MS };
  if (named.kind === 'none' || named.id === LOCAL_MACHINE_ID) return localTarget();
  const session = req ? decoded(cookieValue(req.headers.get('cookie'), SESSION_COOKIE)) : await sessionFromRequestScope();
  return remoteTargetFor(named.id, session);
}

/** What a request names as its machine. */
export type NamedMachine =
  /** Neither the header nor the cookie: the local daemon. */
  | { readonly kind: 'none' }
  | { readonly kind: 'named'; readonly id: string; readonly by: 'header' | 'cookie' }
  /** An `X-Timon-Machine` that is not an id. */
  | { readonly kind: 'malformed' };

/**
 * Id of the `unavailable` target a malformed `X-Timon-Machine` resolves to.
 * Not a machine id on purpose (`isMachineId` rejects it), so it can never
 * alias a machine of the fleet; the raw header is never echoed back.
 */
export const MALFORMED_MACHINE_ID = '!malformed';

/**
 * The one reading of which machine a request names: `X-Timon-Machine` first,
 * then the `timon_machine` cookie. Absent or blank header: the cookie, as
 * before the header existed.
 *
 * A malformed cookie is ignored (local), as it always was: the cookie is the
 * browser's default, a stale one must not lock the interface out. A malformed
 * HEADER is not: it comes from a client that pinned this request to one
 * precise machine (a desktop window, a push action), and serving it from the
 * cookie's machine, or from local, would send a mutation meant for one machine
 * to another. It resolves to `unavailable`, and nothing is sent anywhere.
 *
 * Naming a machine grants nothing: a well-formed id still goes through the
 * owner-filtered credential lookup of the local session, exactly like the
 * cookie's.
 */
export function machineIdFromRequest(headers: TargetRequest['headers']): NamedMachine {
  return namedMachine(headers.get(MACHINE_HEADER), cookieValue(headers.get('cookie'), MACHINE_COOKIE) ?? undefined);
}

function namedMachine(header: string | null | undefined, rawCookie: string | undefined): NamedMachine {
  const pinned = header?.trim();
  if (pinned) return isMachineId(pinned) ? { kind: 'named', id: pinned, by: 'header' } : { kind: 'malformed' };
  const id = validMachineId(rawCookie);
  return id === null ? { kind: 'none' } : { kind: 'named', id, by: 'cookie' };
}

/**
 * The target of one NAMED machine, whatever the active one: `local`, or a
 * machine of the fleet resolved exactly as `resolveTarget` resolves the
 * cookie's (local session, owner-filtered credential, `unavailable` when it
 * cannot be). For the rare request that carries its own machine — the push
 * notification's Approve/Deny, answered for the machine that notified while
 * the browser may be switched to another one. The caller validates `id`
 * (`isMachineId`); a malformed one never reaches here.
 */
export async function machineTarget(id: string, req?: TargetRequest): Promise<Target> {
  if (id === LOCAL_MACHINE_ID) return localTarget();
  const session = req ? decoded(cookieValue(req.headers.get('cookie'), SESSION_COOKIE)) : await sessionFromRequestScope();
  return remoteTargetFor(id, session);
}

/** Routes a browser reaches on THIS daemon whatever the active machine: the
 *  local account and the fleet. The switcher and the way back live there. */
export function anchoredLocally(path: string): boolean {
  const pathname = normalizedPathname(path);
  if (pathname === null) return false;
  return isUnder(pathname, '/api/auth') || isUnder(pathname, '/api/machines');
}

/** The target of one daemon path: local when anchored, else the active one. */
export async function targetFor(path: string, req?: TargetRequest): Promise<Target> {
  return anchoredLocally(path) ? localTarget() : resolveTarget(req);
}

async function remoteTargetFor(id: string, session: string | null): Promise<Target> {
  const found = await machineCredential(session, id);
  if (!found.ok) return { kind: 'unavailable', id, failure: found.failure, timeoutMs: LOCAL_TIMEOUT_MS };
  const { url, token } = found.credential;
  return { kind: 'remote', id, url, timeoutMs: REMOTE_TIMEOUT_MS, deviceToken: async () => token };
}

/** The value of cookie `name` in a raw `Cookie` header, raw (not decoded). */
function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0 || part.slice(0, eq).trim() !== name) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/** The `timon_machine` id of a raw `Cookie` header, or `null` when absent or
 *  malformed (a malformed id is ignored, not trusted). */
export function machineIdFromCookieHeader(header: string | null | undefined): string | null {
  return validMachineId(cookieValue(header, MACHINE_COOKIE) ?? undefined);
}

/**
 * `next/headers` is loaded on demand, never at the top of this module:
 * `server.ts` reaches it through the WebSocket relays before Next has
 * installed `AsyncLocalStorage` on `globalThis`, and loading it that early
 * caches a broken request store — every page then answers 500.
 */
async function requestCookie(name: string): Promise<string | undefined> {
  const { cookies } = await import('next/headers');
  return (await cookies()).get(name)?.value;
}

async function requestHeader(name: string): Promise<string | null> {
  const { headers } = await import('next/headers');
  return (await headers()).get(name);
}

/** `machineIdFromRequest` for the current Next request scope (server render,
 *  route handlers that do not pass their request). */
async function machineFromRequestScope(): Promise<NamedMachine> {
  let header: string | null = null;
  try {
    header = await requestHeader(MACHINE_HEADER);
  } catch {
    // No request headers in scope: the cookie alone decides, as before.
  }
  let cookie: string | undefined;
  try {
    cookie = await requestCookie(MACHINE_COOKIE);
  } catch {
    // Outside a request scope (build, tests, workers): the local daemon.
  }
  return namedMachine(header, cookie);
}

/** The session token, decoded as `cookies()` hands it: the credential
 *  lookup encodes it once, like `proxyAuthHeaders`. */
async function sessionFromRequestScope(): Promise<string | null> {
  try {
    return (await requestCookie(SESSION_COOKIE)) || null;
  } catch {
    return null;
  }
}

function decoded(raw: string | null): string | null {
  if (raw === null) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}

function validMachineId(raw: string | undefined): string | null {
  if (!raw) return null;
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return isMachineId(value) ? value : null;
}

export interface RelayOptions {
  /** The browser request's headers. Required to relay a mutation to a remote
   *  machine: without them the origin cannot be checked, and it is refused. */
  readonly incoming?: { get(name: string): string | null } | null;
}

export async function relayFetch(
  target: Target,
  path: string,
  init: RequestInit = {},
  opts: RelayOptions = {},
): Promise<globalThis.Response> {
  if (target.kind === 'unavailable') return unavailableAnswer(target);
  if (target.kind === 'local') {
    // An account or fleet change may revoke what the credential cache holds
    // (a logout, a machine removed or re-paired): ask again next time.
    if (!SAFE_METHODS.has((init.method ?? 'GET').toUpperCase()) && anchoredLocally(path)) forgetMachineCredentials();
    return fetch(`${target.url}${path}`, init);
  }
  return relayRemote(target, path, init, opts);
}

const UNAVAILABLE: Readonly<Record<CredentialFailure, { status: number; error: string; message: string }>> = {
  session_required: { status: 401, error: 'machine_session_required', message: 'sign in on this machine first' },
  unknown: { status: 404, error: 'machine_unknown', message: 'this machine is not in your fleet' },
  unavailable: { status: 502, error: 'machine_credential_unavailable', message: 'this machine cannot be reached from here right now' },
};

function unavailableAnswer(target: UnavailableTarget): globalThis.Response {
  const { status, error, message } = UNAVAILABLE[target.failure];
  return relayError(status, error, message);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Caller headers a remote never receives: the local identity, and the
 *  machine choice, which is this app's business and names a LOCAL fleet id. */
const LOCAL_ONLY_HEADERS = ['cookie', 'authorization', MACHINE_HEADER] as const;

/** The one account route a remote is ever asked, by the server alone. */
const ACTING_ACCOUNT_PATH = '/api/auth/me';

/**
 * `GET /api/auth/me` on a remote machine, with its device token: who that
 * device acts as there (`acting-me.ts`). The single exception to the refusal
 * of `/api/auth/*`, and narrow on purpose: the path and the method are fixed
 * here, nothing of a browser request reaches it, and the body is never handed
 * back as is — the caller projects the fields it needs. A read changes nothing
 * on either account; a relayed login, logout or password change still could,
 * and stays refused.
 */
export async function fetchActingAccount(target: RemoteTarget, signal?: AbortSignal): Promise<globalThis.Response> {
  return relayRemote(target, ACTING_ACCOUNT_PATH, {
    method: 'GET', headers: { accept: 'application/json' }, cache: 'no-store', signal,
  }, {}, true);
}

async function relayRemote(
  target: RemoteTarget,
  path: string,
  init: RequestInit,
  opts: RelayOptions,
  actingAccountRead = false,
): Promise<globalThis.Response> {
  if (!remoteUrlAllowed(target.url)) return relayError(502, 'machine_insecure', 'this machine is not reachable over HTTPS');
  if (!actingAccountRead && isAuthPath(path)) return relayError(403, 'machine_auth_route', 'account actions are not relayed to another machine');
  const method = (init.method ?? 'GET').toUpperCase();
  if (!SAFE_METHODS.has(method) && (!opts.incoming || !provenSameOrigin(opts.incoming))) {
    return foreignMutationRefusal();
  }
  if (SAFE_METHODS.has(method) && opts.incoming && foreignSiteRead(opts.incoming)) return foreignMutationRefusal();

  const headers = new Headers(init.headers);
  for (const name of LOCAL_ONLY_HEADERS) headers.delete(name);
  let upstream: globalThis.Response;
  try {
    headers.set('authorization', `Bearer ${await target.deviceToken()}`);
    upstream = await fetch(`${target.url}${path}`, { ...init, headers, redirect: 'manual' });
  } catch (err) {
    // The caller left: let the abort propagate as it does for local.
    if (init.signal?.aborted) throw err;
    return relayError(502, 'machine_unreachable', 'this machine cannot be reached');
  }
  // A redirect would send the relay (or the browser) to an address nobody
  // vetted. Not followed, not forwarded.
  if (upstream.status >= 300 && upstream.status < 400) {
    void upstream.body?.cancel().catch(() => {});
    return relayError(502, 'machine_redirect', 'this machine answered with a redirect');
  }
  const out = new Headers(upstream.headers);
  out.delete('set-cookie');
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}

/** HTTPS, or HTTP on loopback only; no credentials in the URL. */
export function remoteUrlAllowed(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHost(url.hostname);
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host);
}

/** `/api/auth` and below, after the URL parser has resolved dot segments and
 *  percent-encoded letters a crafted path could hide them behind. */
export function isAuthPath(path: string): boolean {
  const pathname = normalizedPathname(path);
  return pathname === null || isUnder(pathname, '/api/auth');
}

/** Lower-cased, decoded, dot segments resolved and slashes collapsed; `null`
 *  for a path the parser rejects (callers decide what that means). */
function normalizedPathname(path: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(path, 'http://relay.invalid').pathname;
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, '/');
}

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function relayError(status: number, error: string, message: string): globalThis.Response {
  return new Response(JSON.stringify({ error, message }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/** The credential a relayed WebSocket upgrade carries, or why it is refused. */
export type UpgradeCredential =
  | {
    readonly ok: true;
    /** The daemon's base URL the upgrade goes to. */
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  }
  | { readonly ok: false; readonly status: number };

/**
 * Local: the browser's session cookie, as given (`sessionCookie`, already cut
 * out of the jar by the caller), and the daemon decides. Remote: the policy of
 * `relayFetch` for an upgrade — HTTPS only, the device token as the only
 * credential, and the origin checked HERE, because the remote daemon sees a
 * Bearer and no cookie. A WebSocket is never subject to CORS, and a browser
 * always sends `Origin` on one: missing, opaque or foreign, it is refused.
 *
 * A remote credential also carries the `Origin` and `X-Forwarded-Host` the
 * upgrade presents over there: the remote daemon checks them again
 * (`isSameOriginUpgrade`) against the host IT was reached at, which the TLS
 * proxy in front of it (`tailscale serve`, Caddy, Go's reverse proxy) writes
 * over `X-Forwarded-Host` — the machine's own name. The browser's origin, this
 * app's host, could never match there. Naming the machine's origin on both
 * keeps them consistent whether that proxy overwrites the header, appends to
 * it or is absent; the browser's origin was already checked here.
 */
export async function upgradeCredential(
  target: Target,
  incoming: { get(name: string): string | null },
  sessionCookie: string | undefined,
): Promise<UpgradeCredential> {
  if (target.kind === 'local') return { ok: true, url: target.url, headers: sessionCookie ? { cookie: sessionCookie } : {} };
  if (target.kind === 'unavailable') return { ok: false, status: UNAVAILABLE[target.failure].status };
  if (!remoteUrlAllowed(target.url)) return { ok: false, status: 502 };
  if (!sameOriginUpgrade(incoming)) return { ok: false, status: 403 };
  const remote = new URL(target.url);
  try {
    return {
      ok: true,
      url: target.url,
      headers: { authorization: `Bearer ${await target.deviceToken()}`, origin: remote.origin, 'x-forwarded-host': remote.host },
    };
  } catch {
    return { ok: false, status: 502 };
  }
}

function firstValue(raw: string | null): string | undefined {
  const head = raw?.split(',')[0]?.trim();
  return head || undefined;
}

/** The host the browser reached: `X-Forwarded-Host` behind a reverse proxy. */
function reachedHost(incoming: { get(name: string): string | null }): string | undefined {
  return firstValue(incoming.get('x-forwarded-host')) ?? firstValue(incoming.get('host'));
}

function originIsReachedHost(origin: string | undefined, incoming: { get(name: string): string | null }): boolean {
  if (!origin || origin === 'null') return false;
  const host = reachedHost(incoming);
  if (!host) return false;
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

/** Same rule as the daemon's `isSameOriginUpgrade`: the Origin's host is the
 *  host the browser reached. */
function sameOriginUpgrade(incoming: { get(name: string): string | null }): boolean {
  return originIsReachedHost(firstValue(incoming.get('origin')), incoming);
}

/**
 * A read the browser says another site started. The session cookie is
 * `SameSite=Lax`, so a top-level navigation from a foreign page still carries
 * it, and the relay would answer with the device token. Reads are not held to
 * the mutation rule (an `<img>`, a typed URL or a bookmark send no `Origin`):
 * only an explicit `cross-site` or `same-site` is refused — `same-site` being
 * a sibling host this app does not own. Local reads keep the daemon's rule.
 */
export function foreignSiteRead(incoming: { get(name: string): string | null }): boolean {
  const site = incoming.get('sec-fetch-site')?.trim().toLowerCase();
  return site === 'cross-site' || site === 'same-site';
}

/**
 * A mutation relayed to a remote machine must prove it comes from this app's
 * own pages. `Sec-Fetch-Site` is authoritative when present (only
 * `same-origin` passes); without it, an `Origin` naming the host the browser
 * reached. Neither header: refused — a bare client has no business driving
 * another machine through a browser's session.
 */
export function provenSameOrigin(incoming: { get(name: string): string | null }): boolean {
  const site = incoming.get('sec-fetch-site');
  if (site !== null) return site.trim().toLowerCase() === 'same-origin';
  return originIsReachedHost(firstValue(incoming.get('origin')), incoming);
}
