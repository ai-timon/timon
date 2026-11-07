/** Search routing is a launch decision, never a fallback after a failed request. */
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { resolve } from './settings.js';
import { splitToolList } from './skills.js';
import type { BuildSpawnOpts } from './backends/types.js';
import type { ProviderMcpServer } from './backends/provider-services.js';
import { backendTakesAccounts, isProductBackend } from './backends/registry.js';
import { splitBackendInstance } from './backends/instance-id.js';
import { accountConfigDir } from './backends/accounts.js';

export const PARALLEL_SEARCH_KEY = 'timon-parallel-search';
export const PARALLEL_SEARCH_TOOL = `mcp__${PARALLEL_SEARCH_KEY}__web_search`;
export const PARALLEL_SEARCH_SERVER: ProviderMcpServer = Object.freeze({
  role: 'search', type: 'http', name: PARALLEL_SEARCH_KEY,
  url: 'https://mcp.parallel.ai/mcp?tools=web_search',
  headers: Object.freeze({ 'User-Agent': 'Timon/parallel-agent-search' }),
});
const normalise = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '_');
const searchRule = (rule: string): boolean => {
  const name = rule.split('(')[0]?.trim() ?? '';
  const pattern = new RegExp('^' + name.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
  return ['WebSearch', 'web_search', PARALLEL_SEARCH_KEY, 'timon_parallel_search',
    `mcp__${PARALLEL_SEARCH_KEY}`, 'mcp__timon_parallel_search',
    PARALLEL_SEARCH_TOOL, 'mcp__timon_parallel_search__web_search'].some((tool) => pattern.test(tool));
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const nonempty = (value: unknown): boolean => value != null &&
  (typeof value !== 'object' || Object.keys(value).length > 0);

/** Only configuration structure is inspected, never auth stores or keychains.
 * Account/onboarding metadata, unrelated settings and other projects are not
 * search choices. Unknown or unreadable configuration withholds the route.
 */
function claudeSearchChoices(value: unknown, projects?: ReadonlySet<string> | 'all'): boolean {
  const config = record(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  const permissions = record(config.permissions);
  if (config.permissions != null && (typeof config.permissions !== 'object' || Array.isArray(config.permissions))) return true;
  // With a CLI-selected bypass there may be no approval prompt for a new MCP tool.
  if (permissions.defaultMode === 'bypassPermissions' || permissions.defaultMode === 'dontAsk') return true;
  for (const rules of [permissions.allow, permissions.deny, permissions.ask, config.allowedTools]) {
    if (rules == null) continue;
    if (!Array.isArray(rules) || rules.some((rule: unknown) => typeof rule !== 'string' || searchRule(rule) || rule.trim().startsWith('mcp__'))) return true;
  }
  if (Object.hasOwn(config, 'allowedMcpServers')) return true;
  for (const key of ['mcpServers', 'deniedMcpServers', 'enabledMcpjsonServers', 'disabledMcpjsonServers', 'disabledMcpServers', 'enabledPlugins']) {
    if (nonempty(config[key])) return true;
  }
  if (config.allowManagedMcpServersOnly === true || config.allowManagedPermissionRulesOnly === true) return true;
  for (const kind of ['PreToolUse', 'PermissionRequest']) {
    const hooks = record(config.hooks)[kind];
    if (hooks == null) continue;
    if (!Array.isArray(hooks)) return true;
    for (const hook of hooks) {
      const matcher = record(hook).matcher;
      if (typeof matcher !== 'string' || !matcher) return true;
      try { if (new RegExp(matcher).test('WebSearch') || new RegExp(matcher).test(PARALLEL_SEARCH_TOOL)) return true; }
      catch { return true; }
    }
  }
  return !!projects && Object.entries(record(config.projects)).some(([dir, project]) =>
    (projects === 'all' || projects.has(dir)) && claudeSearchChoices(project));
}

/** Inspect TOML keys, including quoted/dotted keys and tables, without interpreting
 * values or adding a TOML dependency. Strings/comments cannot supply policy keys.
 * Search controls cannot be carried into Codex's isolated scratch config: fail
 * closed for those controls rather than silently enabling native search.
 */
function codexSearchChoices(text: string): { custom: boolean; nativeRestricted: boolean } {
  let custom = false;
  let nativeRestricted = false;
  let path: string[] = [];
  let depth = 0;
  let start = true;
  let table = false;
  const inspect = () => {
    if (path.some((key) => ['web_search', 'web_search_request', 'web_search_cached', 'allowed_web_search_modes', 'permissions', 'allowed_tools', 'disallowed_tools'].includes(key))) {
      custom = nativeRestricted = true;
    }
    if (path.some((key) => ['mcp_servers', 'allowed_mcp_servers', 'denied_mcp_servers'].includes(key))) custom = true;
    path = [];
  };
  for (let i = 0; i < text.length;) {
    const ch = text[i]!;
    if (ch === '#') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (/\s/.test(ch)) {
      if (ch === '\n') { path = []; if (!depth) start = true; }
      i++; continue;
    }
    if (ch === '"' || ch === "'") {
      const triple = text.slice(i, i + 3) === ch.repeat(3);
      const delimiter = triple ? ch.repeat(3) : ch;
      const begin = i;
      i += delimiter.length;
      for (;;) {
        if (i >= text.length) throw new Error('Unreadable search configuration');
        if (text.slice(i, i + delimiter.length) === delimiter) { i += delimiter.length; break; }
        if (ch === '"' && text[i] === '\\') i += 2;
        else i++;
      }
      if (triple) path = [];
      else if (ch === "'") path.push(text.slice(begin + 1, i - 1));
      else path.push(JSON.parse(text.slice(begin, i).replace(/\\U([0-9a-fA-F]{8})/g,
        (_match, hex: string) => String.fromCodePoint(parseInt(hex, 16)))) as string);
      start = false;
      continue;
    }
    const word = /^[A-Za-z0-9_-]+/.exec(text.slice(i));
    if (word) { path.push(word[0]); i += word[0].length; start = false; continue; }
    if (ch === '[' && start && !depth) { table = true; path = []; }
    else if (ch === ']' && table) { inspect(); table = false; }
    else if (ch === '=') inspect();
    else if (ch !== '.') path = [];
    if (!table && ch === '[') depth++;
    if (!table && ch === ']') depth = Math.max(0, depth - 1);
    start = false;
    i++;
  }
  return { custom, nativeRestricted };
}

function cliSearchChoices(backend: string, cwd: string | undefined, accountDir?: string) {
  // Other platforms keep their existing native launch until their configuration is qualified.
  if (process.platform !== 'linux') return { custom: true, nativeRestricted: false };
  const home = homedir();
  const unknown = { custom: true, nativeRestricted: backend === 'codex' };
  let workDir: string;
  try { workDir = realpathSync(cwd ?? process.cwd()); } catch { return unknown; }
  const customDir = accountDir || process.env.CLAUDE_CONFIG_DIR;
  const claudeDir = customDir ? resolvePath(workDir, customDir) : join(home, '.claude');
  const files = backend === 'codex'
    ? [join(accountDir || process.env.CODEX_HOME || join(home, '.codex'), 'config.toml'),
       ...(!accountDir && process.env.CODEX_AUTH_DIR ? [join(process.env.CODEX_AUTH_DIR, 'config.toml')] : []),
       join('/etc', 'codex', 'config.toml'), join('/etc', 'codex', 'requirements.toml'),
       join('/etc', 'codex', 'managed_config.toml')]
    : [join(claudeDir, 'settings.json'),
       join(customDir ? claudeDir : home, '.claude.json'),
       join(claudeDir, 'remote-settings.json'),
       join('/etc', 'claude-code', 'managed-settings.json')]; // portability: Claude's Linux managed configuration location
  const ancestors = new Set<string>();
  let linkedCheckout = false;
  for (let dir = workDir; ; dir = dirname(dir)) {
    if (backend === 'claude') {
      ancestors.add(dir);
      files.push(join(dir, '.mcp.json'), join(dir, '.claude', 'settings.json'), join(dir, '.claude', 'settings.local.json'));
      // A linked worktree shares the main checkout's project key. If a choice
      // could apply there, let the CLI resolve it instead of guessing its root.
      try { linkedCheckout ||= statSync(join(dir, '.git'), { throwIfNoEntry: false })?.isFile() === true; }
      catch { return unknown; }
    } else files.push(join(dir, '.codex', 'config.toml'));
    if (dirname(dir) === dir) break;
  }
  if (backend === 'claude') {
    const managedDir = join('/etc', 'claude-code', 'managed-settings.d');
    try { files.push(...readdirSync(managedDir).filter((name) => name.endsWith('.json') && !name.startsWith('.')).map((name) => join(managedDir, name))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown; }
    // This source has exclusive control even when its server map is empty.
    try { statSync(join('/etc', 'claude-code', 'managed-mcp.json')); return unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown; }
  }
  let custom = false;
  let nativeRestricted = false;
  for (const file of files) {
    try {
      const stat = statSync(file);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return unknown;
      const text = readFileSync(file, 'utf8');
      const choices = backend === 'codex' ? codexSearchChoices(text)
        : { custom: claudeSearchChoices(JSON.parse(text), linkedCheckout ? 'all' : ancestors), nativeRestricted: false };
      custom ||= choices.custom;
      nativeRestricted ||= choices.nativeRestricted;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return unknown; }
  }
  return { custom, nativeRestricted };
}
export function searchUnavailableReason(cfg: BuildSpawnOpts['cfg']): string | null {
  if (resolve('TIMON_WEB_SEARCH_PROVIDER')?.value === 'off') return 'web search is off';
  if (cfg.disallowed_tools?.flatMap(splitToolList).some(searchRule) || cfg.excluded_mcp_servers?.some(searchRule)) return 'web search is excluded';
  return null;
}
export function searchPolicy(spawn: BuildSpawnOpts, backend: string | undefined, servers: readonly ProviderMcpServer[]) {
  const setting = resolve('TIMON_WEB_SEARCH_PROVIDER');
  const mode = setting?.value ?? 'parallel';
  if (!['parallel', 'native', 'off'].includes(String(mode))) throw new Error('TIMON_WEB_SEARCH_PROVIDER must be parallel, native or off');
  const native = { mode: 'native' as const, preApproved: false };
  if (!backend) return native;
  const { cfg } = spawn;
  const preApproved = cfg.allowed_tools?.includes('WebSearch') === true;
  // Providers already enforce real tool-free launches; unrelated one-shots do
  // not require a search-capable backend, even when Parallel is explicit.
  if (spawn.readOnlyTools || (spawn.oneShot && !cfg.allowed_tools?.some(searchRule))) return native;
  const { backend: provider, accountId } = splitBackendInstance(backend);
  const supported = (provider === 'claude' || provider === 'codex') && isProductBackend(backend) && backendTakesAccounts(provider);
  if (!supported) {
    if (mode === 'parallel' && setting?.source !== 'default') throw new Error(`Parallel web search is unavailable on ${backend}`);
    return native;
  }
  if (mode === 'native' && provider === 'claude') return native;
  if (mode === 'off' || searchUnavailableReason(spawn.cfg)) return { mode: 'off' as const, preApproved: false };
  const cli = cliSearchChoices(provider, cfg.cwd, accountId ? accountConfigDir(accountId) : undefined);
  const fallback = cli.nativeRestricted ? { mode: 'off' as const, preApproved: false } : native;
  if (mode === 'native' || spawn.searchServerOverride === 'empty'
    || (spawn.searchServerOverride === 'nonempty' && !preApproved)) return fallback;
  const ambiguous = spawn.searchConfiguredConnectors || servers.some((s) => s.role === 'user') || (cfg.mcp_servers?.length ?? 0) > 0
    || (cfg.excluded_mcp_servers?.length ?? 0) > 0
    || cfg.allowed_tools?.some((entry) => entry !== 'WebSearch' && splitToolList(entry).some(searchRule))
    || cli.custom
    // Independent native page reading is unqualified on Codex. Only a
    // search-only launch can replace its native tool without risking URL reads.
    || (provider === 'codex' && (!preApproved || !cfg.disallowed_tools?.includes('WebFetch')))
    || (provider === 'claude' && !preApproved && (spawn.timonMcp === false || cfg.permission_mode === 'bypassPermissions'));
  const collision = servers.some((s) => normalise(s.name) === normalise(PARALLEL_SEARCH_KEY));
  if (ambiguous || collision) {
    if (setting?.source !== 'default') throw new Error('Parallel web search is unavailable: existing search policy cannot be translated safely');
    return fallback;
  }
  return { mode: 'parallel' as const, preApproved };
}
