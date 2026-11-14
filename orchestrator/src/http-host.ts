/**
 * Which `Host` header a request may carry (DNS rebinding).
 *
 * A page on another site can make its own domain resolve to 127.0.0.1 once
 * loaded: the browser then talks to this daemon while believing it talks to
 * that site, so `Origin` and `Host` agree and every same-origin check passes.
 * What gives it away is the name it uses: the attacker's own. A loopback
 * daemon therefore answers only names that cannot be made to point here from
 * outside.
 *
 * The port is not compared: a rebinding page always uses the port it attacks,
 * and an SSH tunnel (`ssh -L 8765:127.0.0.1:<port>`) legitimately names
 * another one.
 */
import { isIP } from 'node:net';
import { isLoopbackHost } from './users/setup-token.js';

/** `open`: every name passes — the listener is published, auth and the setup token guard it. */
export type HostPolicy = { open: true } | { open: false; names: ReadonlySet<string> };

/**
 * Names that resolve on this machine only, whatever a public DNS answers:
 * `.localhost` (RFC 6761) is mapped to the loopback by the browser itself, and
 * a `.ts.net` name is published by Tailscale alone, onto tailnet addresses.
 * `.internal` is not among them: it is reserved for private networks, so a
 * LAN or corporate resolver may answer it. Docker's `host.docker.internal` is
 * admitted by name instead (`daemonHostPolicy`).
 *
 * Copied in `app/src/lib/host-guard.ts`; `http-host-parity.test.ts` keeps the
 * two in step.
 */
function reservedName(name: string): boolean {
  return name === 'localhost' || name.endsWith('.localhost') || name.endsWith('.ts.net');
}

/**
 * The hostname a `Host` header names, lowercased, without its port or a
 * trailing dot. `null` when the value is not a plain `host[:port]`: a
 * userinfo, a path or a stray character is never read as a name.
 */
export function hostnameOfHeader(value: string): string | null {
  const host = value.trim().toLowerCase();
  const v6 = /^\[([0-9a-f:.]+)\](?::\d{1,5})?$/.exec(host);
  if (v6) return isIP(v6[1]!) === 6 ? v6[1]! : null;
  const named = /^([a-z0-9_.-]+?)\.?(?::\d{1,5})?$/.exec(host);
  return named ? named[1]! : null;
}

/**
 * Whether a request naming `header` may be served. An IP literal always may:
 * rebinding needs a name whose DNS answer the attacker controls. A request
 * without `Host` is no browser's.
 */
export function hostAllowed(header: string | undefined, policy: HostPolicy): boolean {
  if (policy.open || header === undefined || header === '') return true;
  const name = hostnameOfHeader(header);
  if (name === null) return false;
  return isIP(name) !== 0 || reservedName(name) || policy.names.has(name);
}

/** A configured name: an address that is not an IP literal, or the host of a URL. */
function configuredName(value: string, isUrl = false): string | null {
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
 * The daemon's policy. Closed while it listens on the loopback with no TLS
 * proxy declared: that is the setup where an anonymous caller is trusted as
 * the person at the keyboard (first-run account, `none` webhooks). Published
 * (`daemon.listen.host` off the loopback, or `daemon.behindTlsProxy`), auth is
 * required and the first account needs the setup token: a rebinding page gets
 * no more than any other client of that listener, and the proxy's public name
 * is not in the config to be checked.
 */
export function daemonHostPolicy(cfg: {
  daemon: { listen: { host: string }; behindTlsProxy: boolean };
  app: { listen: { host: string }; publicUrl: string };
}): HostPolicy {
  if (!isLoopbackHost(cfg.daemon.listen.host) || cfg.daemon.behindTlsProxy) return { open: true };
  const names = new Set<string>(['host.docker.internal']);
  for (const name of [
    configuredName(cfg.daemon.listen.host),
    configuredName(cfg.app.listen.host),
    configuredName(cfg.app.publicUrl, true),
  ]) {
    if (name !== null) names.add(name);
  }
  return { open: false, names };
}
