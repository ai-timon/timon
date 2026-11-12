import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

function readJson(home, name) {
  try {
    return JSON.parse(readFileSync(join(home, name), 'utf8'));
  } catch {
    return undefined;
  }
}

function validPort(port, minimum = 0) {
  return Number.isInteger(port) && port > minimum && port < 65536;
}

/**
 * The daemon port of a packaged first launch (`PACKAGED_PORTS` of
 * `src/host/service-environment.ts`, which `cli-daemon.test.ts` holds equal):
 * this file cannot import the compiled sources.
 */
export const PACKAGED_DAEMON_PORT = 3010;

/**
 * Resolve against the caller's home so separate installations stay isolated.
 * `packaged`: the CLI runs on the package's runtime. Before any config file,
 * `timon service install` gives a packaged service the first-launch port, and
 * a server installed from a terminal has no desktop bootstrap to name it.
 */
export function resolveApiUrl(home, envUrl, explicitUrl, { packaged = false } = {}) {
  // Keep an explicit profile URL paired with its selected token.
  if (explicitUrl) return explicitUrl;
  if (envUrl) return envUrl;

  const listen = readJson(home, 'timon.config.json')?.daemon?.listen;
  if (listen && typeof listen === 'object' && !Array.isArray(listen)) {
    const port = listen.port ?? 3000;
    let host = listen.host ?? '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') host = '127.0.0.1';
    if (validPort(port) && typeof host === 'string' && host && !/[\s/@?#\\]/.test(host)) {
      const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
      try {
        const url = new URL(`http://${authority}:${port}`);
        return url.origin;
      } catch {
        // An unusable listener must not hide a valid desktop bootstrap.
      }
    }
  }

  const port = readJson(home, 'desktop-bootstrap.json')?.daemonPort;
  if (validPort(port, 1024)) return `http://127.0.0.1:${port}`;
  if (packaged && !existsSync(join(home, 'timon.config.json'))) return `http://127.0.0.1:${PACKAGED_DAEMON_PORT}`;
  return 'http://localhost:3000';
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** URL hostnames of the addresses currently assigned to this machine. */
function localInterfaceHosts() {
  const hosts = new Set();
  for (const entry of Object.values(networkInterfaces()).flat()) {
    if (!entry?.address) continue;
    try {
      const literal = entry.family === 'IPv6' || entry.family === 6 ? `[${entry.address}]` : entry.address;
      hosts.add(new URL(`http://${literal}`).hostname);
    } catch {
      // A zone-scoped or otherwise unparsable address is never a listener host.
    }
  }
  return hosts;
}

/**
 * A listener declared on a LAN address (`daemon.listen.host`) is still this
 * home's own daemon, but only while that address belongs to this machine: a
 * renewed DHCP lease can hand it to another host, which must not receive the
 * token. Host names are refused because their resolution is not ours to trust.
 */
function isOwnLanListener(target, local) {
  if (target.hostname !== local.hostname) return false;
  if (isIP(local.hostname.replace(/^\[(.*)\]$/, '$1')) === 0) return false;
  return localInterfaceHosts().has(local.hostname);
}

/**
 * Whether `url` is this home's own daemon, the only place its daemon-token may
 * be sent. `TIMON_API` / `TIMON_ORCH_URL` are overrides, not proof of a local
 * listener: a remote URL, another loopback port or a path behind a proxy must
 * never receive the operator's superadmin credential.
 */
export function isLocalDaemonUrl(home, url, { packaged = false } = {}) {
  let target;
  let local;
  try {
    target = new URL(url);
    local = new URL(resolveApiUrl(home, undefined, undefined, { packaged }));
  } catch {
    return false;
  }
  const sameHost = LOOPBACK_HOSTS.has(local.hostname)
    ? LOOPBACK_HOSTS.has(target.hostname)
    : isOwnLanListener(target, local);
  return sameHost
    && target.protocol === local.protocol && target.port === local.port
    && target.pathname === '/' && !target.search && !target.hash
    && !target.username && !target.password;
}
