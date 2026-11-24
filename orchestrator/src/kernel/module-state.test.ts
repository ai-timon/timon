/**
 * Module ids hard-coded OUTSIDE the catalogue.
 *
 * `setActiveModules` receives the catalogue ids (`@timon/notifications`). The
 * code living outside the modules queries `moduleActive(<constant>)`: if the
 * constant and the catalogue differ by one character, the answer is "off"
 * forever, without an error, without a log. That is exactly what happened to
 * `NOTIFICATIONS_MODULE_ID`, left at `notifications` after the move to the
 * `@timon/*` scope: the notification centre was dead at every kernel boot.
 *
 * This test locks the three constants onto the catalogue. Any new
 * constant of the same kind is added here.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { CATALOG } = await import('./catalog.js');
const { moduleActive, setActiveModules, resetActiveModules } = await import('./module-state.js');
const { NOTIFICATIONS_MODULE_ID } = await import('../notifications.js');
const { SECRETS_MODULE_ID } = await import('../secrets/availability.js');
const { MEMORY_MODULE_ID } = await import('../agent.js');

const HARDCODED_IDS: Readonly<Record<string, string>> = {
  NOTIFICATIONS_MODULE_ID,
  SECRETS_MODULE_ID,
  MEMORY_MODULE_ID,
};

test('every hard-coded module id exists in the catalogue', () => {
  const known = new Set(CATALOG.map((m) => m.id));
  for (const [name, id] of Object.entries(HARDCODED_IDS)) {
    assert.ok(known.has(id), `${name} = ${id}: missing from the catalogue`);
  }
});

test('the hard-coded ids answer to the vocabulary of setActiveModules', () => {
  // What `setLiveDecisions` does at boot: post the catalogue ids.
  const ids = CATALOG.map((m) => m.id);
  try {
    setActiveModules(ids);
    for (const [name, id] of Object.entries(HARDCODED_IDS)) {
      assert.equal(moduleActive(id), true, `${name} seen off while the whole catalogue is active`);
    }
    setActiveModules(ids.filter((id) => id !== NOTIFICATIONS_MODULE_ID));
    assert.equal(moduleActive(NOTIFICATIONS_MODULE_ID), false);
  } finally {
    resetActiveModules();
  }
});
