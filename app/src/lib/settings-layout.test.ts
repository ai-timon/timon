import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  buildSettingsLayout,
  formatSettingsParam,
  legacyGroupTarget,
  parseSettingsParam,
  placeSetting,
  resolveSettingsTarget,
  SETTINGS_CATEGORY_IDS,
  SETTINGS_NAV_GROUPS,
  STATIC_TABS,
  type SettingsLayoutInput,
  type SettingsRowLike,
} from './settings-layout';

const ROWS: SettingsRowLike[] = [
  { key: 'TIMON_MAX_LIVE_MISSIONS', group: 'Missions', advanced: false },
  { key: 'TIMON_WAKE_SWEEP_MS', group: 'Wake', advanced: false },
  { key: 'TIMON_FALLBACK_ENABLED', group: 'LLM fallback', advanced: false },
  { key: 'TIMON_BREAKER_ENABLED', group: 'LLM fallback', advanced: false },
  { key: 'TIMON_BRAIN_VAULT', group: 'Misc', advanced: false },
  { key: 'TIMON_LOG_SYSTEM_PROMPT', group: 'Misc', advanced: true },
  { key: 'TIMON_DIGEST_HOT_DAYS', group: 'Global digest', advanced: false },
  { key: 'TIMON_BROWSER_IDLE_MINUTES', group: 'Infra', advanced: false, owner: '@timon/browser-embedded' },
  { key: 'VF_DB_PATH', group: 'Infra', advanced: false, owner: '@timon/video-factory' },
  { key: 'TIMON_TTS_URL', group: 'Infra', advanced: false, owner: '@timon/tts' },
];

function input(over: Partial<SettingsLayoutInput> = {}): SettingsLayoutInput {
  return {
    rows: ROWS,
    includeAdvanced: true,
    pluginStates: new Map(),
    pluginLabels: new Map([['@timon/video-factory', 'Video factory']]),
    plugins: [],
    graftedGroups: new Set(),
    desktop: false,
    ...over,
  };
}

function tabIds(layout: ReturnType<typeof buildSettingsLayout>, category: string): string[] {
  return layout.find((c) => c.id === category)?.tabs.map((t) => t.id) ?? [];
}

test('the Obsidian vault lives under Memory, not Misc', () => {
  assert.deepEqual(placeSetting(ROWS[4]!), { category: 'memory', tab: 'obsidian' });
});

test('LLM fallback splits into the quota switch and the breaker', () => {
  assert.deepEqual(placeSetting(ROWS[2]!), { category: 'models', tab: 'fallback' });
  assert.deepEqual(placeSetting(ROWS[3]!), { category: 'models', tab: 'breaker' });
});

test('an owner with a functional home files there, any other owner under Plugins', () => {
  assert.deepEqual(placeSetting(ROWS[7]!), { category: 'network', tab: 'browser' });
  assert.deepEqual(placeSetting(ROWS[8]!), { category: 'plugins', tab: '@timon/video-factory' });
});

test('an unknown group falls back to System › Diagnostics instead of vanishing', () => {
  assert.deepEqual(
    placeSetting({ key: 'X', group: 'Tomorrow', advanced: false }),
    { category: 'system', tab: 'diagnostics' },
  );
});

test('Wake and Missions share one tab; the digest joins memory injection', () => {
  const layout = buildSettingsLayout(input());
  const missions = layout.find((c) => c.id === 'missions')!;
  const execution = missions.tabs.find((t) => t.id === 'execution');
  assert.ok(execution && execution.kind === 'rows');
  assert.deepEqual(execution.keys, ['TIMON_MAX_LIVE_MISSIONS', 'TIMON_WAKE_SWEEP_MS']);
  assert.deepEqual(tabIds(layout, 'memory'), ['injection', 'obsidian']);
});

test('Memory opens on Injection, where its master switch is; the vault comes last', () => {
  const layout = buildSettingsLayout(input());
  assert.equal(resolveSettingsTarget({ category: 'memory', tab: null }, layout)?.tab.id, 'injection');
  assert.equal(STATIC_TABS.memory.at(-1)?.id, 'obsidian');
});

test('every category with tabs sits in exactly one nav group', () => {
  const grouped = SETTINGS_NAV_GROUPS.flatMap((group) => group.categories);
  assert.equal(new Set(grouped).size, grouped.length);
  assert.deepEqual(new Set(grouped), new Set(Object.keys(STATIC_TABS)));
});

test('the categories read workspace, agents, this computer, plugins', () => {
  assert.deepEqual([...SETTINGS_CATEGORY_IDS], [
    'interface',
    'models', 'instructions', 'memory', 'missions', 'resources',
    'network', 'secrets', 'system',
    'plugins',
  ]);
});

test('the Misc and Infra strays with a home leave Diagnostics', () => {
  assert.deepEqual(placeSetting({ key: 'TIMON_CHROME_PATH', group: 'Misc', advanced: true }), { category: 'network', tab: 'browser' });
  assert.deepEqual(placeSetting({ key: 'DISPATCHER_INTERVAL_MS', group: 'Infra', advanced: true }), { category: 'missions', tab: 'execution' });
  assert.deepEqual(placeSetting({ key: 'TIMON_LOG_MAX_MB', group: 'Infra', advanced: false }), { category: 'system', tab: 'diagnostics' });
});

test('the built-in terminal switch sits in Interface › Terminal, where "terminal unavailable" points', () => {
  const row: SettingsRowLike = { key: 'TIMON_TERMINAL_WEB_ENABLED', group: 'Terminal', advanced: false, owner: '@timon/terminal-web' };
  assert.deepEqual(placeSetting(row), { category: 'interface', tab: 'terminal' });
  assert.ok(!tabIds(buildSettingsLayout(input({ rows: [...ROWS, row] })), 'plugins').includes('@timon/terminal-web'));
});

test('advanced rows are always listed, except under a preset that hides the zone', () => {
  assert.deepEqual(tabIds(buildSettingsLayout(input()), 'system'), ['diagnostics']);
  assert.deepEqual(tabIds(buildSettingsLayout(input({ includeAdvanced: false })), 'system'), []);
});

test('the settings of a disabled owner plugin are hidden', () => {
  const layout = buildSettingsLayout(input({
    pluginStates: new Map([['@timon/video-factory', 'disabled'], ['@timon/tts', 'active']]),
  }));
  assert.deepEqual(tabIds(layout, 'plugins'), ['@timon/tts']);
});

test('owner tabs under Plugins carry the plugin label', () => {
  const plugins = buildSettingsLayout(input()).find((c) => c.id === 'plugins')!;
  const vf = plugins.tabs.find((t) => t.id === '@timon/video-factory');
  assert.ok(vf && vf.kind === 'rows');
  assert.equal(vf.ownerLabel, 'Video factory');
});

test('a mapped plugin pane lands in its category, a third-party one under Plugins', () => {
  const layout = buildSettingsLayout(input({
    rows: [],
    plugins: [
      { id: '@timon/backends', origin: 'occupant', label: 'Backends' },
      { id: 'quota-monitor', origin: 'manifest', label: 'Quotas' },
      { id: '@acme/job', origin: 'manifest', label: 'Job' },
    ],
  }));
  // The fallback tab is a native pane now (it hosts its own model picker),
  // so it is always present, not dropped when no fallback rows exist.
  assert.deepEqual(tabIds(layout, 'models'), ['backends', 'fallback', 'quotas']);
  assert.deepEqual(tabIds(layout, 'plugins'), ['@acme/job']);
});

test('the subscription accounts are on the provider pages for everyone: no tab of their own', () => {
  for (const superadmin of [true, false]) {
    const layout = buildSettingsLayout(input({
      rows: [],
      plugins: [{ id: '@timon/backends', origin: 'occupant', label: 'Backends' }],
      superadmin,
    }));
    assert.deepEqual(tabIds(layout, 'models'), ['backends', 'fallback']);
  }
  // An old link to the former tab lands on the providers.
  assert.deepEqual(legacyGroupTarget('accounts'), { category: 'models', tab: 'backends' });
});

test('the Providers tab follows the level: shown at full and own accounts, gone when hidden, never under Plugins', () => {
  const plugins = [{ id: '@timon/backends', origin: 'occupant' as const, label: 'Backends' }, { id: '@acme/job', origin: 'manifest' as const, label: 'Job' }];
  for (const providers of ['full', 'accounts'] as const) {
    assert.ok(tabIds(buildSettingsLayout(input({ rows: [], plugins, providers })), 'models').includes('backends'), providers);
  }
  const hidden = buildSettingsLayout(input({ rows: [], plugins, providers: 'none' }));
  assert.deepEqual(tabIds(hidden, 'models'), ['fallback']);
  assert.deepEqual(tabIds(hidden, 'plugins'), ['@acme/job']);
});

test('Plugins disappears when nothing lives there', () => {
  const layout = buildSettingsLayout(input({ rows: ROWS.slice(0, 5) }));
  assert.equal(layout.some((c) => c.id === 'plugins'), false);
});

test('a graft alone keeps a native tab visible', () => {
  const layout = buildSettingsLayout(input({ rows: [], graftedGroups: new Set(['Resources']) }));
  assert.deepEqual(tabIds(layout, 'resources'), ['confinement']);
});

test('the Voice pane paints the grafts of settings.voice', () => {
  const layout = buildSettingsLayout(input({ graftedGroups: new Set(['Voice']) }));
  const voice = layout.find((c) => c.id === 'interface')?.tabs.find((tab) => tab.id === 'voice');
  assert.ok(voice && voice.kind === 'native');
  assert.deepEqual(voice.grafts, ['Voice']);
});

test('backup retention and the agent trash share System › Backups & trash, not Plugins', () => {
  const rows: SettingsRowLike[] = [
    { key: 'TIMON_BACKUP_KEEP', group: 'Backup', advanced: false, owner: '@timon/routines' },
    { key: 'TIMON_BACKUP_MAX_AGE_DAYS', group: 'Backup', advanced: false, owner: '@timon/routines' },
    { key: 'TIMON_AGENT_TRASH_ENABLED', group: 'Agent trash', advanced: false, owner: '@timon/agents' },
    { key: 'TIMON_AGENT_TRASH_RETENTION_DAYS', group: 'Agent trash', advanced: false, owner: '@timon/agents' },
  ];
  for (const row of rows) assert.deepEqual(placeSetting(row), { category: 'system', tab: 'backup' }, row.key);
  const layout = buildSettingsLayout(input({ rows, graftedGroups: new Set(['Agent trash']) }));
  const tab = layout.find((c) => c.id === 'system')?.tabs.find((t) => t.id === 'backup');
  assert.ok(tab && tab.kind === 'rows');
  assert.deepEqual(tab.keys, rows.map((r) => r.key));
  assert.deepEqual(tab.grafts, ['Backup', 'Agent trash']);
  assert.equal(layout.some((c) => c.id === 'plugins'), false);
  // Routines off: the backup rows go with it, the trash stays.
  const off = buildSettingsLayout(input({ rows, pluginStates: new Map([['@timon/routines', 'disabled']]) }));
  const offTab = off.find((c) => c.id === 'system')?.tabs.find((t) => t.id === 'backup');
  assert.ok(offTab && offTab.kind === 'rows');
  assert.deepEqual(offTab.keys, ['TIMON_AGENT_TRASH_ENABLED', 'TIMON_AGENT_TRASH_RETENTION_DAYS']);
});

test('desktop tab only in the desktop client', () => {
  assert.equal(tabIds(buildSettingsLayout(input({ desktop: true })), 'system').includes('desktop'), true);
  assert.equal(tabIds(buildSettingsLayout(input()), 'system').includes('desktop'), false);
});

test('developer mode tab only for the superadmin, first under Plugins', () => {
  const plugins = [{ id: '@acme/job', origin: 'occupant' as const, label: 'Job' }];
  assert.deepEqual(tabIds(buildSettingsLayout(input({ superadmin: true, rows: [], plugins })), 'plugins'), ['developer', '@acme/job']);
  assert.deepEqual(tabIds(buildSettingsLayout(input({ rows: [], plugins })), 'plugins'), ['@acme/job']);
  // A superadmin with no plugin settings still reaches the switch.
  const bare = buildSettingsLayout(input({ superadmin: true, rows: [], plugins: [] }));
  assert.deepEqual(tabIds(bare, 'plugins'), ['developer']);
  assert.equal(buildSettingsLayout(input({ rows: [], plugins: [] })).some((c) => c.id === 'plugins'), false);
});

test('installation and security tabs only for the superadmin, first under System', () => {
  assert.deepEqual(tabIds(buildSettingsLayout(input({ superadmin: true })), 'system'), ['installation', 'security', 'diagnostics']);
  for (const tab of ['installation', 'security']) {
    assert.equal(tabIds(buildSettingsLayout(input()), 'system').includes(tab), false, tab);
    assert.equal(tabIds(buildSettingsLayout(input({ superadmin: false })), 'system').includes(tab), false, tab);
  }
});

test('the deep-link param keeps a scoped plugin id whole', () => {
  const target = parseSettingsParam('plugins/@acme/job');
  assert.deepEqual(target, { category: 'plugins', tab: '@acme/job' });
  assert.equal(formatSettingsParam(target!), 'plugins/@acme/job');
  assert.deepEqual(parseSettingsParam('memory'), { category: 'memory', tab: null });
  assert.equal(parseSettingsParam(null), null);
});

test('an unknown target falls back to the first visible category and tab', () => {
  const layout = buildSettingsLayout(input());
  const resolved = resolveSettingsTarget({ category: 'resources', tab: 'nope' }, layout);
  assert.equal(resolved?.category.id, layout[0]!.id);
  assert.equal(resolved?.tab.id, layout[0]!.tabs[0]!.id);
});

test('legacy ?group= slugs map to their new home', () => {
  assert.deepEqual(legacyGroupTarget('misc'), { category: 'memory', tab: 'obsidian' });
  assert.deepEqual(legacyGroupTarget('@timon/ui-theme'), { category: 'interface', tab: 'appearance' });
  assert.deepEqual(legacyGroupTarget('@acme/job'), { category: 'plugins', tab: '@acme/job' });
});

test('the GPT-Live switch lives in the Voice pane, not in a tab of its own under Plugins', () => {
  const row: SettingsRowLike = { key: 'TIMON_GPT_LIVE_ENABLED', group: 'Voice', advanced: false, owner: '@timon/gpt-live' };
  assert.deepEqual(placeSetting(row), { category: 'interface', tab: 'voice' });
  const layout = buildSettingsLayout(input({ rows: [...ROWS, row] }));
  assert.ok(!tabIds(layout, 'plugins').includes('@timon/gpt-live'));
  const voice = layout.find((c) => c.id === 'interface')?.tabs.find((t) => t.id === 'voice');
  assert.equal(voice?.kind, 'native');
});

test('the instructions have a category of their own, third in the list', () => {
  const layout = buildSettingsLayout(input());
  assert.equal(layout[2]!.id, 'instructions');
  assert.deepEqual(layout[2]!.tabs.map((t) => [t.id, t.kind]), [['global', 'native'], ['preamble', 'native']]);
  assert.equal(resolveSettingsTarget({ category: 'instructions', tab: null }, layout)?.tab.id, 'global');
  assert.equal(parseSettingsParam('instructions')?.category, 'instructions');
});

test('the Updates pane sits under System, after Installation, for every account', () => {
  const plugins = [{ id: '@timon/updates', origin: 'occupant' as const, label: 'Timon updates' }];
  const row: SettingsRowLike = { key: 'TIMON_UPDATES_CHECK', group: 'Misc', advanced: false, owner: '@timon/updates' };
  const notices: SettingsRowLike = { key: 'TIMON_NOTICES_CHECK', group: 'Misc', advanced: false, owner: '@timon/updates' };
  assert.deepEqual(placeSetting(row), { category: 'system', tab: 'updates' });
  assert.deepEqual(placeSetting(notices), { category: 'system', tab: 'updates' });
  const admin = buildSettingsLayout(input({ superadmin: true, rows: [row, notices], plugins }));
  assert.deepEqual(tabIds(admin, 'system'), ['installation', 'updates', 'security']);
  const member = buildSettingsLayout(input({ rows: [row, notices], plugins }));
  assert.deepEqual(tabIds(member, 'system'), ['updates']);
  // Both switches are in the pane's menu: no tab of their own under Plugins.
  assert.equal(member.some((c) => c.id === 'plugins'), false);
  // The module off: its pane goes, and its rows with it.
  const off = buildSettingsLayout(input({ rows: [row, notices], plugins: [], pluginStates: new Map([['@timon/updates', 'disabled']]) }));
  assert.equal(off.some((c) => c.id === 'system'), false);
});
