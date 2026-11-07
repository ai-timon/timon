import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountOfficialProviders, buildUnderSeal, stubCodexSignIn } from '../tests/helpers/official-providers.js';
import { searchPolicy, PARALLEL_SEARCH_KEY, PARALLEL_SEARCH_TOOL } from './web-search.js';
import { invalidateSettingsCache } from './settings.js';
import { isInjectedMcpServer, isInjectedMcpStubId } from './injected-mcp.js';
import type { BuildSpawnOpts } from './backends/types.js';

await mountOfficialProviders();
await stubCodexSignIn();
// Only an isolated, nonsecret CLI configuration folder is inspected by policy.
process.env.CLAUDE_CONFIG_DIR = join(process.env.TIMON_HOME!, 'claude');
process.env.CODEX_HOME = join(process.env.TIMON_HOME!, 'codex');
const cwd = join(process.env.TIMON_HOME!, 'work');
mkdirSync(cwd, { recursive: true });
function spawn(patch: Partial<BuildSpawnOpts> = {}): BuildSpawnOpts {
  return { missionId: 'search-policy', agentName: 'searcher', message: 'Research.', systemPrompt: '', resumeSession: null,
    cfg: { cwd, backend: 'claude', allowed_tools: ['WebSearch', 'WebFetch'] }, ...patch };
}
function setting(value?: string) {
  if (value) process.env.TIMON_WEB_SEARCH_PROVIDER = value;
  else delete process.env.TIMON_WEB_SEARCH_PROVIDER;
  invalidateSettingsCache();
}

test('search routing preserves explicit boundaries and never silently substitutes for a required route', () => {
  setting();
  const s = spawn();
  assert.equal(searchPolicy(s, 'claude', []).mode, 'parallel');
  assert.equal(searchPolicy(s, undefined, []).mode, 'native');
  assert.equal(searchPolicy(s, 'kimi', []).mode, 'native');
  assert.equal(searchPolicy(spawn({ searchConfiguredConnectors: true }), 'claude', []).mode, 'native');
  assert.equal(searchPolicy(s, 'codex', []).mode, 'native', 'native fetch is not independently qualified');
  for (const name of ['timon-parallel-search', 'timon_parallel_search']) {
    assert.equal(searchPolicy(s, 'claude', [{ role: 'user', type: 'http', name, url: 'https://example.com/mcp', headers: {} }]).mode, 'native');
  }
  for (const p of [{ readOnlyTools: true }, { searchServerOverride: 'empty' as const },
    { oneShot: true, cfg: { cwd } }, { searchServerOverride: 'nonempty' as const, cfg: { cwd } },
    { cfg: { cwd, disallowed_tools: ['WebSearch'] } }, { cfg: { cwd, excluded_mcp_servers: [PARALLEL_SEARCH_KEY] } }]) {
    assert.equal(searchPolicy(spawn(p), 'claude', []).mode, 'off', JSON.stringify(p));
  }
  for (const cfg of [{ cwd, allowed_tools: ['WebSearch(domain:example.com)'] },
    { cwd, mcp_servers: ['custom'] }, { cwd, excluded_mcp_servers: ['external'] },
    { cwd, allowed_tools: ['mcp__*'] }]) assert.equal(searchPolicy(spawn({ cfg }), 'claude', []).mode, 'native');
  assert.equal(searchPolicy(spawn({ cfg: { cwd } }), 'codex', []).mode, 'native', 'no unattended promotion');
  assert.equal(searchPolicy(spawn({ cfg: { cwd } }), 'claude', []).preApproved, false);
  setting('parallel');
  assert.throws(() => searchPolicy(s, 'kimi', []), /unavailable/);
  assert.throws(() => searchPolicy(spawn({ cfg: { cwd, mcp_servers: ['custom'] } }), 'claude', []), /unavailable/);
  setting('native');
  assert.equal(searchPolicy(s, 'claude', []).mode, 'native');
  setting('off');
  assert.equal(searchPolicy(s, 'codex', []).mode, 'off');
  setting('invalid');
  assert.throws(() => searchPolicy(s, 'claude', []), /must be/);
  setting();
});

test('real Claude launch serializes anonymous search, denies native search and maps only the exact grant', async () => {
  setting();
  const spec = await buildUnderSeal('claude', spawn());
  const args = spec.args;
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]!);
  const server = config.mcpServers[PARALLEL_SEARCH_KEY];
  assert.equal(server.url, 'https://mcp.parallel.ai/mcp?tools=web_search');
  assert.deepEqual(server.headers, { 'User-Agent': 'Timon/parallel-agent-search' });
  assert.ok(args[args.indexOf('--disallowedTools') + 1]!.split(',').includes('WebSearch'));
  assert.ok(args[args.indexOf('--allowedTools') + 1]!.split(',').includes(PARALLEL_SEARCH_TOOL));
  assert.equal(args.includes('--strict-mcp-config'), false);
  const gated = await buildUnderSeal('claude', spawn({ cfg: { cwd } }));
  assert.equal(gated.args[gated.args.indexOf('--allowedTools') + 1]!.includes(PARALLEL_SEARCH_TOOL), false);
  assert.ok(gated.args.includes('--permission-prompt-tool'));
});

test('real Codex resume disables native search before resume and rewrites the scratch config on a mode change', async () => {
  setting();
  const s = spawn({ resumeSession: 'thread-search', cfg: { cwd, allowed_tools: ['WebSearch'] } });
  const spec = await buildUnderSeal('codex', s);
  const flag = spec.args.indexOf('web_search=disabled');
  assert.ok(flag > 0 && flag < spec.args.indexOf('resume'));
  const file = join(spec.env!.CODEX_HOME!, 'config.toml');
  assert.match(readFileSync(file, 'utf8'), /mcp_servers.timon-parallel-search/);
  assert.match(readFileSync(file, 'utf8'), /http_headers = .*User-Agent/);
  setting('native');
  await buildUnderSeal('codex', s);
  assert.equal(readFileSync(file, 'utf8').includes(PARALLEL_SEARCH_KEY), false);
  setting('off');
  const off = await buildUnderSeal('codex', s);
  assert.ok(off.args.includes('web_search=disabled'));
  assert.equal(readFileSync(file, 'utf8').includes(PARALLEL_SEARCH_KEY), false);
  setting();
});

test('managed init discovery stays injected under both CLI spellings', () => {
  for (const key of [PARALLEL_SEARCH_KEY, 'timon_parallel_search']) {
    assert.ok(isInjectedMcpServer(key));
    assert.ok(isInjectedMcpStubId(`ext-${key}`));
  }
});

test('an existing native CLI configuration with disabled search is never bypassed', () => {
  const dir = process.env.CODEX_HOME!;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.toml'), 'web_search = "disabled"\n');
  setting();
  assert.equal(searchPolicy(spawn(), 'codex', []).mode, 'native');
  setting('parallel');
  assert.throws(() => searchPolicy(spawn(), 'codex', []), /cannot be translated/);
  setting();
});
