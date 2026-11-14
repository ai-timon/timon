/**
 * M.5 — `api_tokens` rows: issue, live lookup, revoke with the mission,
 * plugin/system identity never carries `:all`.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-api-tokens-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const {
  hashApiToken, issueApiTokenSecret, issueMissionApiToken, ownerForSpawn,
  PLUGIN_OWNER_PREFIX, SYSTEM_ACTOR_ID, MISSION_TOKEN_SCOPE, MISSION_TOKEN_PERMISSIONS,
} = await import('./users/api-tokens.js');
const { viewerSeesAll } = await import('./users/owned.js');
const { intersectMissionTokenPermissions, grantsAllow } = await import('./users/permissions.js');
const { rejectIfDenied } = await import('./users/identity.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');

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

test('ownerForSpawn: explicit owner wins; plugin channel stamps plugin:<id>', () => {
  assert.equal(ownerForSpawn({ ownerUserId: ada.id, sourceChannel: `${PLUGIN_OWNER_PREFIX}acme` }), ada.id);
  assert.equal(ownerForSpawn({ ownerUserId: null, sourceChannel: `${PLUGIN_OWNER_PREFIX}acme` }), null);
  assert.equal(ownerForSpawn({ sourceChannel: `${PLUGIN_OWNER_PREFIX}acme` }), `${PLUGIN_OWNER_PREFIX}acme`);
  assert.equal(ownerForSpawn({ sourceChannel: 'dispatcher' }), null);
  assert.equal(ownerForSpawn({}), null);
});

test('issueMissionApiToken binds a user-owned mission to that user, not the daemon', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'ada.agent', 'ada work', undefined, ada.id);
  const raw = issueMissionApiToken(missionId);
  assert.match(raw, /^[A-Za-z0-9_-]+$/);
  const live = dbApi.getLiveApiToken(hashApiToken(raw));
  assert.ok(live);
  assert.equal(live.user?.id, ada.id);
  assert.equal(live.isSuperadmin, false);
  assert.equal(live.actorId, ada.id);
  assert.equal(live.token.mission_id, missionId);
  assert.equal(live.token.scope, MISSION_TOKEN_SCOPE);
  assert.deepEqual(live.permissions, []);
});

test('a superadmin-launched mission token is never superadmin and is capped', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'admin.agent', 'admin work', undefined, admin.id);
  const raw = issueMissionApiToken(missionId);
  const live = dbApi.getLiveApiToken(hashApiToken(raw));
  assert.ok(live);
  assert.equal(live.user?.id, admin.id);
  assert.equal(live.user?.is_superadmin, true);
  assert.equal(live.isSuperadmin, false);
  assert.equal(live.token.scope, MISSION_TOKEN_SCOPE);
  assert.deepEqual(live.permissions, [...MISSION_TOKEN_PERMISSIONS]);
  assert.equal(grantsAllow(live.permissions ?? [], 'users:manage'), false);
  assert.equal(grantsAllow(live.permissions ?? [], 'secrets:manage'), false);
  assert.equal(grantsAllow(live.permissions ?? [], 'missions:spawn'), false);
  assert.equal(grantsAllow(live.permissions ?? [], 'kanban:write'), true);
  assert.equal(grantsAllow(live.permissions ?? [], 'notify'), true);
  assert.equal(grantsAllow(live.permissions ?? [], 'missions:read'), true);
  assert.equal(
    viewerSeesAll({ id: live.actorId, isSuperadmin: live.isSuperadmin, permissions: live.permissions }, 'tasks'),
    false,
  );
});

test('mission token grants are the cap intersected with the launcher, never wider', () => {
  assert.deepEqual(
    intersectMissionTokenPermissions({ is_superadmin: true }, []),
    [...MISSION_TOKEN_PERMISSIONS],
  );
  assert.deepEqual(
    intersectMissionTokenPermissions({ is_superadmin: false }, ['missions:read', 'missions:spawn', 'page:/']),
    ['missions:read'],
  );
  assert.deepEqual(
    intersectMissionTokenPermissions({ is_superadmin: false }, ['*', '-users:manage']),
    [...MISSION_TOKEN_PERMISSIONS],
  );
  assert.deepEqual(
    intersectMissionTokenPermissions({ is_superadmin: false }, ['kanban:write', '-notify']),
    ['kanban:write'],
  );
  assert.deepEqual(intersectMissionTokenPermissions(null, ['*']), []);
});

test('re-issuing for the same mission revokes the previous secret', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'ada.agent', 'again', undefined, ada.id);
  const first = issueMissionApiToken(missionId);
  const second = issueMissionApiToken(missionId);
  assert.notEqual(first, second);
  assert.equal(dbApi.getLiveApiToken(hashApiToken(first)), undefined);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(second)));
});

test('finishMission revokes the mission token', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'ada.agent', 'done', undefined, ada.id);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(dbApi.getLiveApiToken(hashApiToken(raw)), undefined);
});

test('an expired or disabled-user token is not live', async () => {
  const raw = issueApiTokenSecret();
  dbApi.createApiToken({
    tokenHash: hashApiToken(raw),
    userId: ada.id,
    label: 'expired',
    scope: 'user',
    expiresAt: Date.now() - 1000,
  });
  assert.equal(dbApi.getLiveApiToken(hashApiToken(raw)), undefined);

  const disabled = createTestAccount(dbApi, {
    email: 'eve@example.com',
    name: 'Eve',
    passwordHash: await hashPassword('eve-secret'),
    isSuperadmin: false,
  });
  dbApi.setUserStatus(disabled.id, 'disabled');
  const raw2 = issueApiTokenSecret();
  dbApi.createApiToken({
    tokenHash: hashApiToken(raw2),
    userId: disabled.id,
    label: 'disabled-user',
    scope: 'user',
  });
  assert.equal(dbApi.getLiveApiToken(hashApiToken(raw2)), undefined);
});

test('plugin and system tokens are never superadmin and never see :all', () => {
  const pluginMission = randomUUID();
  dbApi.createMission(pluginMission, 'job.agent', 'cron', { channel: 'plugin:acme' }, 'plugin:acme');
  const pluginRaw = issueMissionApiToken(pluginMission);
  const pluginLive = dbApi.getLiveApiToken(hashApiToken(pluginRaw));
  assert.ok(pluginLive);
  assert.equal(pluginLive.user, null);
  assert.equal(pluginLive.isSuperadmin, false);
  assert.equal(pluginLive.actorId, 'plugin:acme');
  assert.equal(
    viewerSeesAll({ id: pluginLive.actorId, isSuperadmin: false, permissions: [] }, 'missions'),
    false,
  );

  const sysMission = randomUUID();
  dbApi.createMission(sysMission, 'sys.agent', 'job');
  const sysRaw = issueMissionApiToken(sysMission);
  const sysLive = dbApi.getLiveApiToken(hashApiToken(sysRaw));
  assert.ok(sysLive);
  assert.equal(sysLive.user, null);
  assert.equal(sysLive.isSuperadmin, false);
  assert.equal(sysLive.actorId, SYSTEM_ACTOR_ID);
  assert.equal(
    viewerSeesAll({ id: sysLive.actorId, isSuperadmin: false, permissions: [] }, 'missions'),
    false,
  );

  const adminMission = randomUUID();
  dbApi.createMission(adminMission, 'admin.agent', 'admin', undefined, admin.id);
  assert.equal(dbApi.getMission(adminMission, {
    id: pluginLive.actorId,
    isSuperadmin: false,
    permissions: [],
  }), undefined);
  assert.ok(dbApi.getMission(adminMission, {
    id: admin.id,
    isSuperadmin: true,
    permissions: [],
  }));
});

test('a system token resolves the owner by lineage (fork of an owned mission)', () => {
  const parentMission = randomUUID();
  dbApi.createMission(parentMission, 'admin.agent', 'parent', undefined, admin.id);
  const childMission = randomUUID();
  // No owner at issuance → the token is minted as the `system` actor.
  dbApi.createMission(childMission, 'admin.agent', 'child');
  dbApi.setForkedFrom(childMission, parentMission);

  const raw = issueMissionApiToken(childMission);
  const live = dbApi.getLiveApiToken(hashApiToken(raw));
  assert.ok(live);
  assert.equal(live.token.scope, SYSTEM_ACTOR_ID);
  // The fork's owner is recovered by lineage, so the token acts as that account.
  assert.equal(live.user?.id, admin.id);
  assert.equal(live.actorId, admin.id);
  assert.equal(live.isSuperadmin, false); // paid licence, not a developer account
  assert.deepEqual(live.permissions, [...MISSION_TOKEN_PERMISSIONS]);
});

test('owner resolution walks the parent mission and the task of a spawn', () => {
  const parent = randomUUID();
  dbApi.createMission(parent, 'admin.agent', 'parent', undefined, ada.id);
  const child = randomUUID();
  dbApi.createMission(child, 'admin.agent', 'child');
  dbApi.setMissionLineage(child, { parentMissionId: parent });
  assert.equal(dbApi.getLiveApiToken(hashApiToken(issueMissionApiToken(child)))?.user?.id, ada.id);

  const taskId = randomUUID();
  dbApi.createTask(taskId, 'task', 'admin.agent', { ownerUserId: ada.id });
  const spawned = randomUUID();
  dbApi.createMission(spawned, 'admin.agent', 'from a task');
  dbApi.setMissionLineage(spawned, { taskId });
  assert.equal(dbApi.getLiveApiToken(hashApiToken(issueMissionApiToken(spawned)))?.user?.id, ada.id);
});

test('a mission without an owning account is refused with a named reason, where the cap could pass', async () => {
  const orphan = randomUUID();
  dbApi.createMission(orphan, 'admin.agent', 'orphan');
  const owned = randomUUID();
  dbApi.createMission(owned, 'admin.agent', 'owned', undefined, ada.id);
  const orphanToken = issueMissionApiToken(orphan);
  const ownedToken = issueMissionApiToken(owned);

  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'daemon-token-for-test', required: false }));
  app.get('/in-cap', (req, res) => { if (!rejectIfDenied(req, res, 'agents:manage')) res.json({ ok: true }); });
  app.get('/outside-cap', (req, res) => { if (!rejectIfDenied(req, res, 'secrets:manage')) res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (path: string, token: string) => {
    const r = await fetch(base + path, { headers: { authorization: `Bearer ${token}` } });
    return { status: r.status, body: await r.json() };
  };
  try {
    const named = await call('/in-cap', orphanToken);
    assert.equal(named.status, 403);
    assert.equal(named.body.error, 'forbidden');
    assert.equal(named.body.code, 'mission_without_owner');
    assert.equal(named.body.reason, 'this mission has no owning account');
    assert.equal(named.body.hint, 'relaunch it from your account');
    // Outside the cap a relaunch would not pass either: no misleading hint.
    const outside = (await call('/outside-cap', orphanToken)).body;
    assert.equal(outside.code, 'not_in_mission_cap');
    assert.doesNotMatch(String(outside.hint), /relaunch/);
    // An owned mission lacking the grant gets the account refusal, not the owner one.
    const owned403 = (await call('/in-cap', ownedToken)).body;
    assert.equal(owned403.code, 'account_lacks_permission');
    assert.doesNotMatch(String(owned403.reason), /no owning account/);
  } finally {
    server.close();
  }
});
