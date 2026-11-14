/**
 * A corporate proxy named by `HTTPS_PROXY` / `HTTP_PROXY` is ignored by Node
 * unless `NODE_USE_ENV_PROXY` is set too: without it the daemon and its agents
 * went out directly, and failed in a network whose only way out is the proxy.
 *
 * Node reads `NODE_USE_ENV_PROXY` once, while it starts: setting it on
 * `process.env` later changes nothing for the running process (checked on
 * Node 22.23 for both `fetch` and `node:http`). So the daemon replaces itself,
 * under the same PID, with the flag set (`process.execve`), before anything
 * else runs. Windows has no `execve`: there the flag reaches the missions and
 * the `node:http` agents, and a warning says what to set on the service.
 *
 * With the flag on, Node sends loopback requests to the proxy too unless
 * `NO_PROXY` lists them: the daemon calls itself, its app, the MCP servers and
 * local CLIs on 127.0.0.1, so the loopback is added to `NO_PROXY`.
 */
import http from 'node:http';
import https from 'node:https';
import { isMainThread } from 'node:worker_threads';

const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY'] as const;
const NO_PROXY_VARS = ['NO_PROXY', 'no_proxy'] as const;
/** The loopback in every spelling a client may match `NO_PROXY` against. */
export const LOOPBACK_NO_PROXY: readonly string[] = ['127.0.0.1', '::1', '[::1]', 'localhost'];

/** `env[name]` whatever its case: on Windows `Https_Proxy` is `HTTPS_PROXY`. */
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const upper = name.toUpperCase();
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === upper && value) return value;
  }
  return undefined;
}

/**
 * The variables to add so Node honours the proxy of `env` and keeps the
 * loopback off it. `null` when no proxy is named. An explicit
 * `NODE_USE_ENV_PROXY` (even `0`) is the operator's choice and is kept.
 */
export function envProxyChanges(env: NodeJS.ProcessEnv): Record<string, string> | null {
  if (!PROXY_VARS.some((name) => readEnv(env, name))) return null;
  const changes: Record<string, string> = {};
  if (!readEnv(env, 'NODE_USE_ENV_PROXY')) changes.NODE_USE_ENV_PROXY = '1';
  for (const name of NO_PROXY_VARS) {
    const current = env[name] ?? '';
    const entries = current.split(',').map((entry) => entry.trim()).filter(Boolean);
    const missing = LOOPBACK_NO_PROXY.filter((entry) => !entries.includes(entry));
    if (missing.length > 0) changes[name] = [...entries, ...missing].join(',');
  }
  return changes;
}

export type EnvProxyOutcome = 'none' | 'unchanged' | 'adjusted' | 'restarted' | 'children-only';

export interface EnvProxyDeps {
  env: NodeJS.ProcessEnv;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  /** `process.execve` where it exists: it does not return. */
  execve?: (file: string, args: string[], env: NodeJS.ProcessEnv) => void;
  /** Rebuilds the `node:http` / `node:https` global agents from `env`. */
  refreshAgents: (env: NodeJS.ProcessEnv) => void;
  warn: (message: string) => void;
}

/** Truthy as Node reads it: any value other than empty, `0` or `false`. */
function flagOn(value: string | undefined): boolean {
  return value !== undefined && value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

export function enableEnvProxy(deps: EnvProxyDeps): EnvProxyOutcome {
  const changes = envProxyChanges(deps.env);
  if (!changes) return 'none';
  if (Object.keys(changes).length === 0) return 'unchanged';
  const flagAtLaunch = readEnv(deps.env, 'NODE_USE_ENV_PROXY');
  // Windows reads environment names without case: assigning `no_proxy` there
  // writes `NO_PROXY` again, which is harmless.
  Object.assign(deps.env, changes);
  if (flagAtLaunch === undefined && deps.execve) {
    deps.execve(deps.execPath, [deps.execPath, ...deps.execArgv, ...deps.argv.slice(1)], deps.env);
    return 'restarted';
  }
  // `fetch` reads `NO_PROXY` on every request; the `node:http` agents keep the
  // value they were built with, as the flag set too late does.
  if (flagOn(deps.env.NODE_USE_ENV_PROXY)) deps.refreshAgents(deps.env);
  if (flagAtLaunch === undefined) {
    deps.warn('[proxy] HTTP(S)_PROXY is set: missions use it, but the daemon\'s own fetch requests go out directly until NODE_USE_ENV_PROXY=1 is set in the service environment');
    return 'children-only';
  }
  return 'adjusted';
}

/** `proxyEnv` (Node 22.21+, 24.5+) is missing from the installed typings. */
type ProxyAgentOptions = https.AgentOptions & { proxyEnv?: NodeJS.ProcessEnv };

function refreshGlobalAgents(env: NodeJS.ProcessEnv): void {
  const options: ProxyAgentOptions = { keepAlive: true, proxyEnv: { ...env } };
  http.globalAgent = new http.Agent(options);
  https.globalAgent = new https.Agent(options);
}

/** The daemon's entry calls this first, before anything opens a socket or a file. */
export function enableEnvProxyAtBoot(): EnvProxyOutcome {
  // A test runner or a worker must never replace its process.
  const replaceable = isMainThread && !process.env.NODE_TEST_CONTEXT
    && process.platform !== 'win32' && typeof process.execve === 'function';
  return enableEnvProxy({
    env: process.env,
    execPath: process.execPath,
    execArgv: process.execArgv,
    argv: process.argv,
    ...(replaceable ? { execve: (file: string, args: string[], env: NodeJS.ProcessEnv) => process.execve!(file, args, env) } : {}),
    refreshAgents: refreshGlobalAgents,
    warn: (message) => console.warn(message),
  });
}
