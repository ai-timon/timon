/** Search routing is a launch decision, never a fallback after a failed request. */
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { resolve } from './settings.js';
import type { BuildSpawnOpts } from './backends/types.js';
import type { ProviderMcpServer } from './backends/provider-services.js';
import { isProductBackend } from './backends/registry.js';

export const PARALLEL_SEARCH_KEY = 'timon-parallel-search';
export const PARALLEL_SEARCH_TOOL = `mcp__${PARALLEL_SEARCH_KEY}__web_search`;
export const PARALLEL_SEARCH_SERVER: ProviderMcpServer = Object.freeze({
  role: 'search', type: 'http', name: PARALLEL_SEARCH_KEY,
  url: 'https://mcp.parallel.ai/mcp?tools=web_search',
  headers: Object.freeze({ 'User-Agent': 'Timon/parallel-agent-search' }),
});
const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const searchRule = (rule: string): boolean => {
  const name = rule.split('(')[0] ?? '';
  const pattern = new RegExp('^' + name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return ['WebSearch', 'web_search', PARALLEL_SEARCH_KEY, 'timon_parallel_search',
    PARALLEL_SEARCH_TOOL, 'mcp__timon_parallel_search__web_search'].some((tool) => pattern.test(tool));
};

/** Existing CLI settings may contain restrictions we cannot translate. Check only
 * their presence, never credentials, and withhold the implicit route if unsure.
 */
function hasOpaqueConfig(backend: string, cwd: string | undefined): boolean {
  const home = homedir();
  const files = backend === 'codex'
    ? [join(process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'),
       ...(process.env.CODEX_AUTH_DIR ? [join(process.env.CODEX_AUTH_DIR, 'config.toml')] : []),
       join('/etc', 'codex', 'config.toml'), join('/etc', 'codex', 'requirements.toml')]
    : [join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'settings.json'),
       join(home, '.claude.json'),
       join(process.env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.claude.json'),
       join('/etc', 'claude-code', 'managed-settings.d'),
       join('/etc', 'claude-code', 'managed-settings.json')]; // portability: Claude's Linux managed configuration location
  if (cwd) {
    let dir = resolvePath(cwd);
    for (;;) {
      if (backend === 'claude') files.push(join(dir, '.mcp.json'), join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'));
      else files.push(join(dir, '.codex', 'config.toml'));
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  if (process.platform !== 'linux') return true;
  return files.some((file) => {
    try { statSync(file); return true; }
    catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT'; }
  });
}
export function searchUnavailableReason(cfg: BuildSpawnOpts['cfg']): string | null {
  if (resolve('TIMON_WEB_SEARCH_PROVIDER')?.value === 'off') return 'web search is off';
  if (cfg.disallowed_tools?.some(searchRule) || cfg.excluded_mcp_servers?.some(searchRule)) return 'web search is excluded';
  return null;
}
export function searchPolicy(spawn: BuildSpawnOpts, backend: string | undefined, servers: readonly ProviderMcpServer[]) {
  const setting = resolve('TIMON_WEB_SEARCH_PROVIDER');
  const mode = setting?.value ?? 'parallel';
  if (!['parallel', 'native', 'off'].includes(String(mode))) throw new Error('TIMON_WEB_SEARCH_PROVIDER must be parallel, native or off');
  const native = { mode: 'native' as const, preApproved: false };
  if (!backend) return native;
  const supported = (backend === 'claude' || backend === 'codex') && isProductBackend(backend);
  if (!supported) {
    if (mode === 'parallel' && setting?.source !== 'default') throw new Error(`Parallel web search is unavailable on ${backend}`);
    return native;
  }
  if (mode === 'native') return native;
  if (mode === 'off' || searchUnavailableReason(spawn.cfg)) return { mode: 'off' as const, preApproved: false };
  const { cfg } = spawn;
  const preApproved = cfg.allowed_tools?.includes('WebSearch') === true;
  if (spawn.readOnlyTools || spawn.searchServerOverride === 'empty'
    || (spawn.oneShot && !preApproved) || (spawn.searchServerOverride === 'nonempty' && !preApproved)) {
    return { mode: 'off' as const, preApproved: false };
  }
  const ambiguous = spawn.searchConfiguredConnectors || servers.some((s) => s.role === 'user') || (cfg.mcp_servers?.length ?? 0) > 0
    || (cfg.excluded_mcp_servers?.length ?? 0) > 0
    || cfg.allowed_tools?.some((t) => searchRule(t) && t !== 'WebSearch')
    || hasOpaqueConfig(backend, cfg.cwd)
    // Independent native page reading is unqualified on Codex. Only a
    // search-only launch can replace its native tool without risking URL reads.
    || (backend === 'codex' && (!preApproved || !cfg.disallowed_tools?.includes('WebFetch')))
    || (backend === 'claude' && !preApproved && (spawn.timonMcp === false || cfg.permission_mode === 'bypassPermissions'));
  const collision = servers.some((s) => normalise(s.name) === normalise(PARALLEL_SEARCH_KEY));
  if (ambiguous || collision) {
    if (setting?.source !== 'default') throw new Error('Parallel web search is unavailable: existing search policy cannot be translated safely');
    return native;
  }
  return { mode: 'parallel' as const, preApproved };
}
