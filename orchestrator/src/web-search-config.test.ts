import './test-home.js';
import '../tests/helpers/search-cli-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mountOfficialProviders, buildUnderSeal, stubCodexSignIn } from '../tests/helpers/official-providers.js';
import { searchPolicy, PARALLEL_SEARCH_KEY } from './web-search.js';
import { invalidateSettingsCache } from './settings.js';
import { markInjectedMcpServers } from './injected-mcp.js';
import type { BuildSpawnOpts } from './backends/types.js';
await mountOfficialProviders();
await stubCodexSignIn();
const cwd = join(process.env.TIMON_HOME!, 'work');
mkdirSync(cwd, { recursive: true });
const spawn = (cfg: BuildSpawnOpts['cfg'] = { cwd }): BuildSpawnOpts => ({
  missionId: 'search-config', agentName: 'searcher', message: 'Research.', systemPrompt: '', resumeSession: null, cfg,
});
function setting(value?: string) {
  if (value) process.env.TIMON_WEB_SEARCH_PROVIDER = value;
  else delete process.env.TIMON_WEB_SEARCH_PROVIDER;
  invalidateSettingsCache();
}
function mcp(spec: Awaited<ReturnType<typeof buildUnderSeal>>) {
  return JSON.parse(spec.args[spec.args.indexOf('--mcp-config') + 1]!).mcpServers;
}

test('normal client/account metadata and unrelated settings allow default and explicit managed launches', async () => {
  const dir = join(process.env.HOME!, '.claude');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'settings.json');
  writeFileSync(file, JSON.stringify({ model: 'sonnet', theme: 'dark', permissions: { deny: ['Bash(*)'] }, hooks: { Notification: [] } }));
  try {
    for (const mode of [undefined, 'parallel']) {
      setting(mode);
      for (const cfg of [{ cwd }, { cwd, allowed_tools: ['WebSearch', 'WebFetch'] }]) {
        assert.equal(searchPolicy(spawn(cfg), 'claude', []).mode, 'parallel');
        assert.equal(mcp(await buildUnderSeal('claude', spawn(cfg)))[PARALLEL_SEARCH_KEY].url,
          'https://mcp.parallel.ai/mcp?tools=web_search');
      }
    }
  } finally { rmSync(file); setting(); }
});

test('active account configuration, project choices and remote managed denies retain authority', async () => {
  const dir = join(process.env.TIMON_HOME!, 'account-config');
  mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    for (const source of ['settings.json', 'remote-settings.json', '.claude.json']) {
      const file = join(dir, source);
      for (const config of [
        { permissions: { deny: ['WebSearch'] } }, { permissions: { ask: ['WebSearch'] } },
        { permissions: { allow: ['mcp__custom__search'] } }, { enabledPlugins: { 'custom@fixture': true } },
        { permissions: { allow: ['WebSearch(domain:example.com)'] } },
        { mcpServers: { [PARALLEL_SEARCH_KEY]: { type: 'http', url: 'https://example.com/mcp' } } },
        { deniedMcpServers: [{ serverName: PARALLEL_SEARCH_KEY }] }, { allowedMcpServers: [] },
        { hooks: { PreToolUse: [{ matcher: 'WebSearch|mcp__.*', hooks: [] }] } },
        { projects: { [cwd]: { allowedTools: ['WebSearch(domain:example.com)'] } } },
      ]) {
        writeFileSync(file, JSON.stringify(config));
        setting();
        assert.equal(searchPolicy(spawn(), 'claude', []).mode, 'native', source);
        const spec = await buildUnderSeal('claude', spawn());
        assert.equal(spec.env?.CLAUDE_CONFIG_DIR, dir, 'the CLI must use the directory inspected by policy');
        assert.equal(mcp(spec)[PARALLEL_SEARCH_KEY], undefined);
        setting('parallel');
        assert.throws(() => searchPolicy(spawn(), 'claude', []), /cannot be translated/);
      }
      rmSync(file);
    }
    writeFileSync(join(dir, '.claude.json'), JSON.stringify({ projects: { '/other-fixture': { allowedTools: ['WebSearch(domain:example.com)'] } } })); // portability: simulated other project
    setting();
    assert.equal(searchPolicy(spawn(), 'claude', []).mode, 'parallel');
    const project = join(cwd, '.claude');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, 'settings.local.json'), JSON.stringify({ permissions: { deny: ['WebSearch'] } }));
    assert.equal(searchPolicy(spawn(), 'claude', []).mode, 'native');
    rmSync(project, { recursive: true });
    writeFileSync(join(dir, 'settings.json'), '{');
    assert.equal(searchPolicy(spawn(), 'claude', []).mode, 'native', 'unreadable policy never enables a replacement');
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rmSync(dir, { recursive: true }); setting(); }
});

test('MCP-only task overrides preserve native search; actual tool-free launches stay restricted', async () => {
  setting();
  for (const override of ['empty', 'nonempty'] as const) {
    const spec = await buildUnderSeal('claude', { ...spawn(), searchServerOverride: override });
    assert.equal(spec.args[spec.args.indexOf('--disallowedTools') + 1]?.split(',').includes('WebSearch'), false);
    assert.equal(mcp(spec)[PARALLEL_SEARCH_KEY], undefined);
  }
  const spec = await buildUnderSeal('claude', { ...spawn(), readOnlyTools: true, searchServerOverride: 'empty' });
  assert.ok(spec.args.includes('--tools=') && spec.args.includes('--strict-mcp-config'));
  assert.equal(mcp(spec)[PARALLEL_SEARCH_KEY], undefined);
});

test('managed discovery has launch provenance; a same-name user connector stays discoverable and excludable', async () => {
  const { listMcp, refreshToolsCacheFromInit, getMcp, deleteMcp } = await import('./mcp.js');
  const { providerMcpPlan } = await import('./backends/provider-mcp.js');
  const { openLaunchSeal, closeLaunchSeal } = await import('./backends/launch-seal.js');
  const { getBackend } = await import('./backends/index.js');
  setting();
  const s = spawn();
  const seal = openLaunchSeal(s.missionId, 'claude', s, () => 'fixture-token');
  try {
    await getBackend('claude').buildSpawn(s);
    const injectedNames = [...seal.injectedMcpServers];
    assert.deepEqual(injectedNames, [PARALLEL_SEARCH_KEY]);
    for (const key of [PARALLEL_SEARCH_KEY, 'timon_parallel_search']) {
      const init = { subtype: 'init', tools: [`mcp__${key}__web_search`], mcp_servers: [{ name: key, status: 'connected' }] };
      refreshToolsCacheFromInit(JSON.parse(JSON.stringify(markInjectedMcpServers(init, injectedNames))));
      assert.equal(listMcp().some((server) => server.name === key), false, 'persisted boot replay creates no connector');
      refreshToolsCacheFromInit(markInjectedMcpServers({ ...init, timon_injected_mcp_servers: [key] }, []));
      const id = `ext-${key}`;
      assert.ok(listMcp().some((server) => server.id === id));
      assert.deepEqual(getMcp(id)?.tools_cache, ['web_search']);
      const excluded = spawn({ cwd, excluded_mcp_servers: [id] });
      const plan = await providerMcpPlan({ spawn: excluded, seal });
      assert.deepEqual(plan.excludedServers, [key]);
      assert.equal(plan.servers.some((server) => server.role === 'search'), false);
      const spec = await buildUnderSeal('claude', excluded);
      assert.ok(spec.args[spec.args.indexOf('--disallowedTools') + 1]!.includes(`mcp__${key}`));
      deleteMcp(id);
    }
  } finally { closeLaunchSeal(seal); }
});

test('Codex allows unrelated preferences, but search controls cannot be lost in its isolated config', async () => {
  const dir = join(process.env.HOME!, '.codex');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'config.toml');
  const s = spawn({ cwd, allowed_tools: ['WebSearch'], disallowed_tools: ['WebFetch'] });
  try {
    setting();
    writeFileSync(file, `model = "gpt-5" # web_search = "disabled"\n[projects."/fixture"]\ntrust_level = "trusted"\n`); // portability: simulated project
    assert.equal(searchPolicy(s, 'codex', []).mode, 'parallel');
    for (const text of ['web_search = "disabled"', '"web_search" = "cached"', '"\\u0077eb_search" = "disabled"',
      '[features]\nweb_search_request = false', 'features = { web_search_request = false }']) {
      writeFileSync(file, text + '\n');
      for (const mode of [undefined, 'native']) {
        setting(mode);
        assert.equal(searchPolicy(s, 'codex', []).mode, 'off', text);
        const spec = await buildUnderSeal('codex', s);
        assert.ok(spec.args.includes('web_search=disabled'));
        assert.equal(readFileSync(join(spec.env!.CODEX_HOME!, 'config.toml'), 'utf8').includes(PARALLEL_SEARCH_KEY), false);
      }
      setting('parallel');
      assert.throws(() => searchPolicy(s, 'codex', []), /cannot be translated/);
    }
    setting();
    writeFileSync(file, '[mcp_servers.custom]\nurl = "https://example.com/mcp"\n');
    assert.equal(searchPolicy(s, 'codex', []).mode, 'native', 'an MCP-only choice does not disable native search');
  } finally { rmSync(file); setting(); }
});


test('official account profiles inspect their own directory and never substitute the daemon configuration', async () => {
  const { createBackendAccount, accountConfigDir, deleteBackendAccount } = await import('./backends/accounts.js');
  const shared = join(process.env.TIMON_HOME!, 'shared-config');
  mkdirSync(shared, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = shared;
  try {
    for (const provider of ['claude', 'codex']) {
      const account = createBackendAccount({ backend: provider, name: 'Search fixture', ownerUserId: null });
      try {
        const backend = `${provider}@${account.id}`;
        const dir = accountConfigDir(account.id);
        const s = spawn({ cwd, backend, allowed_tools: ['WebSearch'], ...(provider === 'codex' ? { disallowed_tools: ['WebFetch'] } : {}) });
        writeFileSync(join(dir, '.claude.json'), readFileSync(join(process.env.HOME!, '.claude.json')));
        if (provider === 'codex') writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
        const file = join(dir, provider === 'claude' ? 'settings.json' : 'config.toml');
        // The shared directory's choice is not the selected account's policy.
        writeFileSync(join(shared, 'settings.json'), JSON.stringify({ permissions: { deny: ['WebSearch'] } }));
        for (const mode of [undefined, 'parallel']) {
          setting(mode);
          assert.equal(searchPolicy(s, backend, []).mode, 'parallel');
          const spec = await buildUnderSeal(backend, s);
          if (provider === 'claude') {
            assert.equal(spec.env?.CLAUDE_CONFIG_DIR, dir);
            assert.ok(mcp(spec)[PARALLEL_SEARCH_KEY]);
          } else assert.ok(readFileSync(join(spec.env!.CODEX_HOME!, 'config.toml'), 'utf8').includes(PARALLEL_SEARCH_KEY));
        }
        writeFileSync(file, provider === 'claude' ? JSON.stringify({ permissions: { deny: ['WebSearch'] } }) : 'web_search = "disabled"\n');
        setting();
        assert.equal(searchPolicy(s, backend, []).mode, provider === 'claude' ? 'native' : 'off');
        const denied = await buildUnderSeal(backend, s);
        if (provider === 'claude') {
          assert.equal(denied.env?.CLAUDE_CONFIG_DIR, dir);
          assert.equal(mcp(denied)[PARALLEL_SEARCH_KEY], undefined);
        } else assert.ok(denied.args.includes('web_search=disabled'));
        setting('parallel');
        assert.throws(() => searchPolicy(s, backend, []), /cannot be translated/);
      } finally { deleteBackendAccount(account.id); }
    }
  } finally { delete process.env.CLAUDE_CONFIG_DIR; rmSync(shared, { recursive: true }); setting(); }
});
