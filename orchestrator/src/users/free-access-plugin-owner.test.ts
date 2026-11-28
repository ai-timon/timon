/**
 * A plugin job's missions (owner `plugin:<id>`) run on a free install when the operator approved that plugin's
 * spawns (`pluginPolicy.spawn.approved`); any other non-superadmin owner stays refused.
 */
import '../test-home.js';
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createTestAccount } from '../../tests/helpers/accounts.js';

const { dbApi } = await import('../db.js');
const { setLicenseState } = await import('../license/runtime.js');
const { unlicensed } = await import('../license/license.js');
const { paidTestLicense } = await import('../../tests/helpers/paid-license.js');
const { config, setConfig } = await import('../config/load.js');
const { freeAccountAllowed } = await import('./free-access.js');

const boss = createTestAccount(dbApi, { email: 'boss2@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
const member = createTestAccount(dbApi, { email: 'member2@example.com', name: 'Member', passwordHash: 'x' });
const original = config();

function approve(ids: string[]): void {
  const cfg = config();
  setConfig({ ...cfg, pluginPolicy: { ...cfg.pluginPolicy, spawn: { ...cfg.pluginPolicy.spawn, approved: ids } } });
}

afterEach(() => {
  setConfig(original);
  setLicenseState(paidTestLicense());
});

test('free install: an approved plugin owner may run missions, an unapproved one may not', () => {
  setLicenseState(unlicensed('missing'));
  approve(['telegram']);
  assert.equal(freeAccountAllowed('plugin:telegram'), true);
  assert.equal(freeAccountAllowed('plugin:other'), false);
  assert.equal(freeAccountAllowed(boss.id), true);
  assert.equal(freeAccountAllowed(member.id), false, 'a second person still needs a licence and the Multi-user plugin');
});

test('withdrawing the approval stops the plugin owner again', () => {
  setLicenseState(unlicensed('missing'));
  approve([]);
  assert.equal(freeAccountAllowed('plugin:telegram'), false);
});
