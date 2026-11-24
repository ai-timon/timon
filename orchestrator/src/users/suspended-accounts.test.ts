import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTestAccount } from '../../tests/helpers/accounts.js';

const { dbApi } = await import('../db.js');
const { setLicenseState } = await import('../license/runtime.js');
const { paidTestLicense } = await import('../../tests/helpers/paid-license.js');
const { stopServingTestAccounts } = await import('../../tests/helpers/accounts.js');
// The paid test helper serves accounts itself; these tests say who does.
stopServingTestAccounts();
const { setActiveModules } = await import('../kernel/module-state.js');
const { claimAccountProvider, releaseAccountProvider } = await import('./account-provider-state.js');
const { noticeSuspendedAccounts, SUSPENDED_ACCOUNTS_ANCHOR } = await import('./suspended-accounts.js');

const boss = createTestAccount(dbApi, { email: 'boss@example.com', name: 'Boss', passwordHash: 'x', isSuperadmin: true });
const member = createTestAccount(dbApi, { email: 'member@example.com', name: 'Member', passwordHash: 'x' });

const openCards = () => dbApi.listActiveNotificationsByAnchorPrefix(SUSPENDED_ACCOUNTS_ANCHOR, 'action_required');

test('the superadmin is told once that accounts are suspended, and the card closes when they are served again', () => {
  setLicenseState(paidTestLicense());
  // Notifications on: without their module, a card is dropped (`notificationsEnabled`).
  setActiveModules(['@timon/users', '@timon/notifications']);
  assert.equal(noticeSuspendedAccounts(), 1);
  const cards = openCards();
  assert.equal(cards.length, 1);
  assert.equal(cards[0]!.owner_user_id, boss.id);
  assert.match(cards[0]!.body ?? '', /pro licence and the Multi-user plugin/);
  assert.deepEqual(JSON.parse(cards[0]!.message_code ?? 'null'), { code: 'accounts_suspended', params: { count: 1 } });
  assert.equal(dbApi.getUserById(member.id)?.status, 'active', 'the account is suspended, not changed');

  assert.equal(noticeSuspendedAccounts(), 1);
  assert.equal(openCards().length, 1, 'not raised again at the next boot');

  claimAccountProvider('team-plugin');
  assert.equal(noticeSuspendedAccounts(), 0);
  assert.equal(openCards().length, 0, 'closed once the plugin serves the accounts');
  releaseAccountProvider('team-plugin');
});
