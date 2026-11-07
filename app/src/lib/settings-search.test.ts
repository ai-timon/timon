import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';
import {
  buildSettingsLayout,
  isRowListed,
  STATIC_TABS,
  type SettingsLayoutInput,
  type SettingsTab,
} from './settings-layout';
import { normalizeSearchText, searchSettings, type SearchableRow } from './settings-search';

const ROWS: (SearchableRow & { owner?: string | null })[] = [
  { key: 'TIMON_MAX_LIVE_MISSIONS', group: 'Missions', advanced: false, label: 'Max live missions', description: 'How many missions run at once.' },
  { key: 'TIMON_FALLBACK_COOLDOWN_MS', group: 'LLM fallback', advanced: true, label: 'Fallback cooldown', description: 'Wait before retrying the main backend.' },
  { key: 'TIMON_BREAKER_THRESHOLD', group: 'LLM fallback', advanced: false, label: 'Breaker threshold', description: null },
  { key: 'TIMON_LOG_SYSTEM_PROMPT', group: 'Misc', advanced: true, label: 'Log the system prompt', description: 'Verbose, for debugging.' },
  { key: 'VF_DB_PATH', group: 'Infra', advanced: false, label: 'Video database', description: null, owner: '@timon/video-factory' },
];

const LABELS = new Map<string, string>([
  ['models', 'AI models'], ['missions', 'Missions'], ['system', 'System'], ['interface', 'Interface'], ['plugins', 'Plugins'],
  ['models/fallback', 'Auto switch'], ['models/breaker', 'Circuit breaker'], ['missions/execution', 'Execution'],
  ['system/diagnostics', 'Diagnostics'], ['interface/appearance', 'Thème'],
]);

function layoutInput(over: Partial<SettingsLayoutInput> = {}): SettingsLayoutInput {
  return {
    rows: ROWS,
    includeAdvanced: true,
    pluginStates: new Map(),
    pluginLabels: new Map([['@timon/video-factory', 'Video factory']]),
    plugins: [{ id: '@timon/ui-theme', origin: 'occupant', label: 'Theme plugin' }],
    graftedGroups: new Set(),
    desktop: false,
    ...over,
  };
}

function run(query: string, over: Partial<SettingsLayoutInput> = {}, keywords: Record<string, string> = {}, rowCopy?: (row: SearchableRow) => Pick<SearchableRow, 'label' | 'description'>) {
  const input = layoutInput(over);
  return searchSettings({
    query,
    layout: buildSettingsLayout(input),
    rows: ROWS.filter((row) => isRowListed(row, input)),
    categoryLabel: (id) => LABELS.get(id) ?? id,
    tabLabel: (category, tab: SettingsTab) => (tab.kind === 'rows' && tab.ownerLabel) || LABELS.get(`${category}/${tab.id}`) || tab.id,
    rowCopy,
    rowKeywords: (key) => (keywords[key] ? [keywords[key]!] : []),
    tabKeywords: (category, tab) => (keywords[`${category}/${tab.id}`] ? [keywords[`${category}/${tab.id}`]!] : []),
  });
}

const rowKeys = (query: string, over: Partial<SettingsLayoutInput> = {}, kw: Record<string, string> = {}) =>
  run(query, over, kw).rows.map((hit) => hit.key);
const tabIds = (query: string, over: Partial<SettingsLayoutInput> = {}, kw: Record<string, string> = {}) =>
  run(query, over, kw).tabs.map((hit) => `${hit.category}/${hit.tab.id}`);

test('an empty or blank query finds nothing', () => {
  assert.deepEqual(run(''), { tabs: [], rows: [] });
  assert.deepEqual(run('   '), { tabs: [], rows: [] });
});

test('matches label, description and key, ignoring case and accents', () => {
  assert.deepEqual(rowKeys('LIVE'), ['TIMON_MAX_LIVE_MISSIONS']);
  assert.deepEqual(rowKeys('at once'), ['TIMON_MAX_LIVE_MISSIONS']);
  assert.deepEqual(rowKeys('timon_breaker'), ['TIMON_BREAKER_THRESHOLD']);
  assert.equal(normalizeSearchText('Thème'), 'theme');
  assert.ok(tabIds('theme').includes('interface/appearance'));
});

test('every word must match, in any order', () => {
  assert.deepEqual(rowKeys('missions live'), ['TIMON_MAX_LIVE_MISSIONS']);
  assert.deepEqual(rowKeys('live banana'), []);
});

test('rows that used to hide behind "Show advanced" are found', () => {
  assert.deepEqual(rowKeys('debugging'), ['TIMON_LOG_SYSTEM_PROMPT']);
});

test('a preset that hides the advanced zone keeps those rows out of the search too', () => {
  assert.deepEqual(rowKeys('debugging', { includeAdvanced: false }), []);
});

test('the rows of a disabled plugin are not searchable', () => {
  assert.deepEqual(rowKeys('video'), ['VF_DB_PATH']);
  assert.deepEqual(rowKeys('video', { pluginStates: new Map([['@timon/video-factory', 'disabled']]) }), []);
});

test('hidden keywords make a row and a tab answer to words they do not show', () => {
  assert.deepEqual(rowKeys('concurrency'), []);
  assert.deepEqual(rowKeys('concurrency', {}, { TIMON_MAX_LIVE_MISSIONS: 'concurrency parallel' }), ['TIMON_MAX_LIVE_MISSIONS']);
  assert.ok(!tabIds('shell').includes('missions/execution'));
  assert.ok(tabIds('shell', {}, { 'missions/execution': 'shell' }).includes('missions/execution'));
});

test('a pane without rows is found by its name, and by its category', () => {
  assert.ok(tabIds('circuit').includes('models/breaker'));
  const memory = tabIds('ai models');
  assert.ok(memory.includes('models/fallback') && memory.includes('models/breaker'));
});

test('a row painted by a native pane leads to the pane, not to a row of its own', () => {
  const found = run('cooldown');
  assert.deepEqual(found.rows, []);
  assert.deepEqual(found.tabs.map((hit) => [`${hit.category}/${hit.tab.id}`, hit.via]), [['models/fallback', ['Fallback cooldown']]]);
});

test('translated rows match localized copy without losing the daemon label or setting key', () => {
  const rowCopy = (row: SearchableRow) => row.key === 'TIMON_MAX_LIVE_MISSIONS'
    ? { label: '任务会话上限', description: '同时运行的会话数。' }
    : row;
  for (const query of ['会话上限', '同时运行', 'live missions', 'TIMON_MAX_LIVE_MISSIONS']) {
    assert.deepEqual(run(query, {}, {}, rowCopy).rows.map((hit) => hit.key), ['TIMON_MAX_LIVE_MISSIONS']);
  }
});

test('plugin settings still match the stable plugin ID after the tab label is translated', () => {
  const over = { pluginLabels: new Map([['@timon/video-factory', '视频工厂']]) };
  for (const query of ['视频工厂', '@timon/video-factory']) {
    assert.deepEqual(tabIds(query, over), ['plugins/@timon/video-factory']);
  }
});

test('every locale carries the same hidden keywords and they point at real tabs', () => {
  const known = new Set(Object.entries(STATIC_TABS).flatMap(([category, tabs]) => tabs.map((tab) => `${category}.${tab.id}`)));
  for (const [name, dict] of [['en', en], ['fr', fr]] as const) {
    for (const [category, tabs] of Object.entries(dict.settingsSearch.tabKeywords)) {
      for (const id of Object.keys(tabs)) assert.ok(known.has(`${category}.${id}`), `${name}: unknown tab ${category}.${id}`);
    }
  }
  const keysOf = (dict: typeof en) => ({
    tabs: Object.entries(dict.settingsSearch.tabKeywords).flatMap(([c, t]) => Object.keys(t).map((i) => `${c}.${i}`)).sort(),
    rows: Object.keys(dict.settingsSearch.rowKeywords).sort(),
  });
  assert.deepEqual(keysOf(fr), keysOf(en));
});
