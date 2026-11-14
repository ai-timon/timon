/**
 * Which `Host` header the app may answer (DNS rebinding).
 *
 * A page on another site can make its own domain resolve to 127.0.0.1 once
 * loaded: the browser then talks to this app while believing it talks to that
 * site, and through the `/api/ui` proxy to the daemon — anonymously, which the
 * daemon accepts until the first account exists. The daemon cannot see it:
 * the proxy reaches it on its own loopback address. What gives the page away
 * is the name it uses, so a loopback app answers only names that cannot be
 * made to point here from outside.
 *
 * Same rule as the daemon's (`orchestrator/src/http-host.ts`), copied: the two
 * packages share no code. `orchestrator/src/http-host-parity.test.ts` fails
 * when the copies diverge outside their declared differences. The port is not
 * compared — Docker publishes the app on another port than it listens on, and
 * a rebinding page always uses the port it attacks anyway.
 */
import { statSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { isLoopbackHost } from './listen-hosts';

/** `open`: every name passes — the app is published, auth and the setup token guard it. */
export type HostPolicy = { open: true } | { open: false; names: ReadonlySet<string> };

/**
 * Names that resolve on this machine only, whatever a public DNS answers:
 * `.localhost` (RFC 6761, Traefik's `timon.localhost`) is mapped to the
 * loopback by the browser itself, and a `.ts.net` name is published by
 * Tailscale alone, onto tailnet addresses (`tailscale serve`).
 */
function reservedName(name: string): boolean {
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.ts.net');
}

/** The hostname of a `Host` header, lowercased, without port or trailing dot; `null` when malformed. */
export function hostnameOfHeader(value: string): string | null {
  const host = value.trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(host);
  if (v6) return isIP(v6[1]!) === 6 ? v6[1]! : null;
  const named = /^([a-z0-9_.-]+?)\.?(?::\d{1,5})?$/.exec(host);
  return named ? named[1]! : null;
}

/** An IP literal always passes: rebinding needs a name whose DNS answer the attacker controls. */
export function hostAllowed(header: string | undefined, policy: HostPolicy): boolean {
  if (policy.open || header === undefined || header === '') return true;
  const name = hostnameOfHeader(header);
  if (name === null) return false;
  return isIP(name) !== 0 || reservedName(name) || policy.names.has(name);
}

function stringAt(raw: unknown, path: readonly string[]): string | undefined {
  let node: unknown = raw;
  for (const key of path) {
    if (node === null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return typeof node === 'string' ? node : undefined;
}

function configuredName(value: string | undefined, isUrl = false): string | null {
  if (value === undefined) return null;
  let host = value;
  if (isUrl) {
    try {
      host = new URL(value).host;
    } catch {
      return null;
    }
  }
  const name = hostnameOfHeader(host);
  return name !== null && isIP(name) === 0 ? name : null;
}

/**
 * The app's policy, from the parsed `timon.config.json` (`undefined` = no
 * file: the defaults). Closed while the app is declared on the loopback with
 * no TLS proxy: that is when the daemon asks for no setup token, so the first
 * account goes to whoever reaches the form. Read from the config rather than
 * the socket: in Docker the app binds `0.0.0.0` inside its container while
 * Compose publishes it on the host loopback only.
 */
export function appHostPolicy(raw: unknown): HostPolicy {
  const appHost = stringAt(raw, ['app', 'listen', 'host']) ?? '127.0.0.1';
  const daemon = raw !== null && typeof raw === 'object' ? (raw as { daemon?: unknown }).daemon : undefined;
  const behindTlsProxy = daemon !== null && typeof daemon === 'object'
    && (daemon as { behindTlsProxy?: unknown }).behindTlsProxy === true;
  if (!isLoopbackHost(appHost) || behindTlsProxy) return { open: true };
  const names = new Set<string>();
  for (const name of [
    configuredName(appHost),
    configuredName(stringAt(raw, ['daemon', 'listen', 'host'])),
    configuredName(stringAt(raw, ['app', 'publicUrl']) ?? 'http://timon.localhost', true),
  ]) {
    if (name !== null) names.add(name);
  }
  return { open: false, names };
}

/**
 * Routes that carry their own proof and are reached through a public tunnel
 * under any name (Cloudflare Tunnel, ngrok, Caddy): signed channel and plugin
 * webhooks, trigger hooks (the daemon refuses an unsigned one relayed by the
 * app), and the remote API with its own tokens. Matched on a path that
 * needed no normalisation and encodes no separator, so `..` or an encoded
 * dot cannot borrow the exemption for another route.
 */
const EXEMPT = [
  /^\/api\/channels\/[^/]+\/inbound\/?$/,
  /^\/api\/triggers\/hooks\//,
  /^\/api\/plugins\/hooks\//,
  /^\/api\/remote\//,
];

export function hostGuardExempt(url: string | undefined): boolean {
  if (!url) return false;
  const raw = url.split('?')[0]!;
  // An encoded dot, slash or backslash is a path some layer may still decode.
  if (/%2e|%2f|%5c|\\/i.test(raw)) return false;
  let pathname: string;
  try {
    pathname = new URL(url, 'http://app.invalid').pathname;
  } catch {
    return false;
  }
  return pathname === raw && EXEMPT.some((pattern) => pattern.test(pathname));
}

/** How often the config file is looked at again: a request must not pay a `stat` each. */
const RECHECK_MS = 2_000;

/**
 * The policy of the config file in `home`, re-read when the file changes. A
 * missing or unreadable file gives the defaults, i.e. the closed policy — the
 * first run is exactly when no file exists yet.
 */
export function createHostPolicyReader(home: string, now: () => number = Date.now): () => HostPolicy {
  const file = join(home, 'timon.config.json');
  let policy = appHostPolicy(undefined);
  let stamp: number | null = null;
  let checkedAt = -Infinity;
  return () => {
    const at = now();
    if (at - checkedAt < RECHECK_MS) return policy;
    checkedAt = at;
    let mtime: number | null = null;
    try {
      mtime = statSync(file).mtimeMs;
    } catch {
      mtime = null;
    }
    if (mtime === stamp) return policy;
    stamp = mtime;
    let raw: unknown;
    try {
      raw = mtime === null ? undefined : JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      raw = undefined;
    }
    policy = appHostPolicy(raw);
    return policy;
  };
}
