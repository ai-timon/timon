/**
 * Tests of the selection by cadence (reconcile.ts).
 *
 * `node --test --import tsx src/reconcile.test.ts` (or `npm test`). The pure
 * function `selectRules` is tested: importing the real registry would pull dispatcher.js
 * and open the SQLite database.
 *
 * What is at stake here is not cosmetic. A rule that NOTIFIES the user
 * (`merge-without-sha`) must stay strictly `boot`: making it periodic
 * would send the same notification every 2 minutes.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectRules, type ReconcileCadence } from './reconcile.js';

function rule(name: string, cadence: ReconcileCadence) {
  return { name, cadence };
}

test('the boot pass plays the boot and both rules, never the interval ones alone', () => {
  const rules = [
    rule('au-boot', 'boot'),
    rule('periodique', 'interval'),
    rule('les-deux', 'both'),
  ];
  assert.deepEqual(
    selectRules(rules, 'boot').map((r) => r.name),
    ['au-boot', 'les-deux'],
  );
});

test('the periodic pass never replays a boot-only rule', () => {
  const rules = [
    rule('au-boot', 'boot'),
    rule('periodique', 'interval'),
    rule('les-deux', 'both'),
  ];
  const selected = selectRules(rules, 'interval').map((r) => r.name);
  assert.deepEqual(selected, ['periodique', 'les-deux']);
  assert.ok(!selected.includes('au-boot'), 'a boot-only rule that notifies would spam the user');
});

test('empty registry: no selection, no error', () => {
  assert.deepEqual(selectRules([], 'boot'), []);
  assert.deepEqual(selectRules([], 'interval'), []);
});

test('a both rule is played in both passes', () => {
  const rules = [rule('les-deux', 'both')];
  assert.equal(selectRules(rules, 'boot').length, 1);
  assert.equal(selectRules(rules, 'interval').length, 1);
});

test('a rule registered by a module joins the list, and its removal takes it out', async () => {
  // The point of the registry: `reconcile.ts` no longer imports grepai nor
  // browser-sessions, so an install without these modules does not have to
  // load them to reconcile itself. The price would be a rule that outlives its
  // module, hence the check of the removal.
  const { registerReconcileRule, listReconcileRules } = await import('./reconcile.js');
  const before = listReconcileRules().length;
  const remove = registerReconcileRule({
    name: 'temoin',
    invariant: 'Rien du tout — règle de test.', // french-ok: free-text sample data
    cadence: 'interval',
    run: () => { /* no-op */ },
  });
  assert.equal(listReconcileRules().length, before + 1);
  assert.ok(listReconcileRules().some((r) => r.name === 'temoin'));
  remove();
  assert.equal(listReconcileRules().length, before);
  assert.ok(!listReconcileRules().some((r) => r.name === 'temoin'));
});
