import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-settings-test-'));
process.env.TIMON_HOME = HOME;

// The witness key is set in timon.config.json BEFORE the first import:
// the registry reads the config on first access.
writeFileSync(
  join(HOME, 'timon.config.json'),
  JSON.stringify({ settings: { TIMON_MAX_PARALLEL: 3, TIMON_MAX_LIVE_MISSIONS: 7 } }),
);

const { resolve, settingInt, invalidateSettingsCache } = await import('./settings.js');
const { dbApi } = await import('./db.js');

test('config gagne contre la table settings', () => {
  dbApi.setSetting('TIMON_MAX_PARALLEL', '5');
  invalidateSettingsCache();
  const r = resolve('TIMON_MAX_PARALLEL');
  assert.equal(r?.value, 3);
  assert.equal(r?.source, 'config');
  assert.equal(r?.dbValue, '5', 'the database value stays visible to the UI');
});

test('config loses against the environment', () => {
  process.env.TIMON_MAX_LIVE_MISSIONS = '99';
  invalidateSettingsCache();
  const r = resolve('TIMON_MAX_LIVE_MISSIONS');
  assert.equal(r?.value, 99);
  assert.equal(r?.source, 'env');
  delete process.env.TIMON_MAX_LIVE_MISSIONS;
  invalidateSettingsCache();
  assert.equal(settingInt('TIMON_MAX_LIVE_MISSIONS'), 7);
});

test('a key missing from the config keeps its usual source', () => {
  invalidateSettingsCache();
  const r = resolve('TIMON_LOAD_THRESHOLD');
  assert.equal(r?.source, 'default');
});

test('every setting owner is a bundled plugin of the catalog', async () => {
  const { SETTINGS } = await import('./settings.js');
  const { CATALOG } = await import('./kernel/catalog.js');
  const ids = new Set(CATALOG.map((m) => m.id));
  const owners = SETTINGS.flatMap((d) => (d.owner ? [d.owner] : []));
  assert.ok(owners.length > 0);
  for (const owner of owners) assert.ok(ids.has(owner), `unknown owner ${owner}`);
});
