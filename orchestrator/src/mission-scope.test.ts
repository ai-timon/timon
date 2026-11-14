/**
 * M.1c — mission ownership lives in dbApi, not in the route.
 * A non-superadmin only sees rows whose owner_user_id is theirs;
 * NULL (system / not yet attributed) is invisible to them.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-scope-'));
await import('../tests/helpers/paid-license.js');

const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');

const admin = createTestAccount(dbApi, {
  email: 'admin@example.com',
  name: 'Admin',
  passwordHash: await hashPassword('admin-secret'),
  isSuperadmin: true,
});
const ada = createTestAccount(dbApi, {
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: await hashPassword('ada-secret'),
  isSuperadmin: false,
});

const adminViewer = { id: admin.id, isSuperadmin: true };
const adaViewer = { id: ada.id, isSuperadmin: false };

const ownedByAdmin = randomUUID();
const ownedByAda = randomUUID();
const unowned = randomUUID();
dbApi.createMission(ownedByAdmin, 'admin.agent', 'admin mission', undefined, admin.id);
dbApi.createMission(ownedByAda, 'ada.agent', 'ada mission', undefined, ada.id);
dbApi.createMission(unowned, 'system.agent', 'system mission');

test('without a viewer, listMissions keeps the historical unscoped behaviour', () => {
  const ids = new Set(dbApi.listMissions(100).map((m) => m.id));
  assert.ok(ids.has(ownedByAdmin));
  assert.ok(ids.has(ownedByAda));
  assert.ok(ids.has(unowned));
});

test('a superadmin viewer sees every mission, including unowned ones', () => {
  const ids = new Set(dbApi.listMissions(100, undefined, undefined, adminViewer).map((m) => m.id));
  assert.deepEqual(ids, new Set([ownedByAdmin, ownedByAda, unowned]));
});

test('a regular viewer sees only their own missions', () => {
  const rows = dbApi.listMissions(100, undefined, undefined, adaViewer);
  assert.deepEqual(rows.map((m) => m.id), [ownedByAda]);
  assert.equal(dbApi.getMission(ownedByAda, adaViewer)?.id, ownedByAda);
  assert.equal(dbApi.getMission(ownedByAdmin, adaViewer), undefined);
  assert.equal(dbApi.getMission(unowned, adaViewer), undefined);
});

test('assignUnownedMissionsTo attributes leftover rows to the superadmin at setup', () => {
  const n = dbApi.assignUnownedMissionsTo(admin.id);
  assert.equal(n, 1);
  assert.equal(dbApi.getMission(unowned)?.owner_user_id, admin.id);
  assert.equal(dbApi.listMissions(100, undefined, undefined, adaViewer).length, 1);
  assert.ok(dbApi.listMissions(100, undefined, undefined, adminViewer).some((m) => m.id === unowned));
});

test('the owner filter combines with the status filter', () => {
  dbApi.finishMission(ownedByAda, 'completed', 0);
  assert.deepEqual(dbApi.listMissions(100, undefined, 'running', adaViewer).map((m) => m.id), []);
  assert.deepEqual(dbApi.listMissions(100, undefined, 'completed', adaViewer).map((m) => m.id), [ownedByAda]);
  assert.ok(dbApi.listMissions(100, undefined, 'running', adminViewer).some((m) => m.id === ownedByAdmin));
});
