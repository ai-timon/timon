/**
 * MCP servers that Timon itself puts into every session, whatever the backend.
 *
 * The harness reports them in its `init` like any other server, so they must
 * never be mistaken for an account connector: a stub `ext-timon` listed next to
 * the real server read as a second `timon` with other rights, and excluding it
 * turned into `--disallowedTools mcp__timon__*`, which cut an agent off from its
 * own Kanban tools.
 *
 * Leaf module on purpose: `mcp.ts`, `agent.ts` and every dialect import it, so
 * it must not pull the database or the settings (an import cycle with `mcp.ts`).
 * `timon-browser` is therefore written here a second time; `injected-mcp.test.ts`
 * holds it to `CHROME_DEVTOOLS_MCP_KEY`.
 *
 * `chrome-devtools` is NOT in the list: it is the user's own server, which
 * Timon injects nowhere and leaves to them.
 */
import { ASK_MCP_SERVER, LEGACY_ASK_MCP_SERVER } from './ask-mcp.js';

/** Every server key a dialect registers by itself, as the claude CLI names it. */
export const INJECTED_MCP_SERVERS: readonly string[] = [
  'timon',
  ASK_MCP_SERVER,
  // Never registered any more, but a resumed session still reports it.
  LEGACY_ASK_MCP_SERVER,
  // The project's embedded browser (`CHROME_DEVTOOLS_MCP_KEY`).
  'timon-browser',
  // The project's semantic index. Reserved as a whole: the dialects drop an
  // agent's own `grepai` entry in favour of the one bound to the project.
  'grepai',
];

/** codex rewrites `-` into `_` in a server's key, claude keeps it: compare on one form. */
function normalise(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

const INJECTED = new Set(INJECTED_MCP_SERVERS.map(normalise));

/** Whether `key` (a server name as a harness reports it) is one Timon injects. */
export function isInjectedMcpServer(key: string): boolean {
  return INJECTED.has(normalise(key));
}

/** Stamp init events before persistence, replacing any claim made by the CLI.
 * Replay can then distinguish our server from a user's same-name connector. */
export function markInjectedMcpServers(payload: unknown, servers: Iterable<string>): unknown {
  if (!payload || typeof payload !== 'object') return payload;
  return { ...payload, timon_injected_mcp_servers: [...servers] };
}

export function injectedMcpServersFromInit(payload: Record<string, unknown>): Set<string> {
  const names = payload.timon_injected_mcp_servers;
  return new Set(Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string').map(normalise) : []);
}

export function isLaunchInjectedMcpServer(key: string, names: ReadonlySet<string>): boolean {
  return names.has(normalise(key));
}

/** Id prefix of the stub entries `refreshToolsCacheFromInit` writes. */
export const EXTERNAL_STUB_PREFIX = 'ext-';

/** Whether `id` is the id such a stub would have: `ext-` + an injected key. */
export function isInjectedMcpStubId(id: string): boolean {
  return id.startsWith(EXTERNAL_STUB_PREFIX) && isInjectedMcpServer(id.slice(EXTERNAL_STUB_PREFIX.length));
}
