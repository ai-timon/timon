import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { DAEMON_LICENCE_REASONS, DAEMON_OFF_REASONS, moduleOffCause } from './module-off-reason';

/** The daemon's own sentences: a reworded one there must fail here, not in a tester's gallery. */
const REGISTRY = readFileSync(new URL('../../../orchestrator/src/kernel/registry.ts', import.meta.url), 'utf8');

test('the licence refusals of planEntries read as licence', () => {
  for (const reason of DAEMON_LICENCE_REASONS) {
    assert.ok(REGISTRY.includes(`'${reason}'`), `registry.ts no longer says "${reason}"`);
    assert.equal(moduleOffCause(reason), 'licence');
  }
  assert.equal(moduleOffCause('non couvert par la licence'), 'licence', 'a daemon from before TODO #628');
});

test('off by default or turned off in the config reads as off', () => {
  for (const reason of DAEMON_OFF_REASONS) {
    assert.ok(REGISTRY.includes(`'${reason}'`), `registry.ts no longer says "${reason}"`);
    assert.equal(moduleOffCause(reason), 'off');
  }
  assert.equal(moduleOffCause('désactivé dans timon.config.json'), 'off', 'a daemon from before TODO #628'); // french-ok: the reason an older daemon wrote
  assert.equal(moduleOffCause(null), 'off');
});

test('a dependency or a host capability is never mistaken for a choice of the user', () => {
  assert.equal(moduleOffCause('depends on @timon/secrets-vault, which is disabled'), 'other');
  assert.equal(moduleOffCause('capacité hôte absente : git'), 'other'); // french-ok: the reason an older daemon wrote
  assert.equal(moduleOffCause('host capability unavailable: docker'), 'other');
});
