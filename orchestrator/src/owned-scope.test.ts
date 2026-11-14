/**
 * M.3 — ownership lives in dbApi (`scopedDb` binds the viewer).
 * A non-superadmin only sees rows whose owner_user_id is theirs;
 * NULL (system / not yet attributed) is invisible without `:read:all`.
 */
import { createTestAccount, grantTestPermissions } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-owned-scope-'));
await import('../tests/helpers/paid-license.js');

const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { scopedDb } = await import('./users/scoped-db.js');

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
const bob = createTestAccount(dbApi, {
  email: 'bob@example.com',
  name: 'Bob',
  passwordHash: await hashPassword('bob-secret'),
  isSuperadmin: false,
});

const adminViewer = { id: admin.id, isSuperadmin: true };
const adaViewer = { id: ada.id, isSuperadmin: false };
const bobViewer = { id: bob.id, isSuperadmin: false };

grantTestPermissions(dbApi, bob.id, ['tasks:read:all']);
const bobAllViewer = {
  id: bob.id,
  isSuperadmin: false,
  permissions: dbApi.listPermissionsForUser(bob.id),
};

const adaTask = randomUUID();
const adminTask = randomUUID();
const systemTask = randomUUID();
dbApi.createTask(adaTask, 'ada task', 'ada.agent', { ownerUserId: ada.id });
dbApi.createTask(adminTask, 'admin task', 'admin.agent', { ownerUserId: admin.id });
dbApi.createTask(systemTask, 'system task', 'system.agent');

const adaNotif = dbApi.createNotification({
  id: randomUUID(), type: 'report', title: 'ada n', ownerUserId: ada.id,
});
const adminNotif = dbApi.createNotification({
  id: randomUUID(), type: 'report', title: 'admin n', ownerUserId: admin.id,
});
const systemNotif = dbApi.createNotification({
  id: randomUUID(), type: 'alert', title: 'system n',
});

const adaTodo = dbApi.insertProjectTodo({ text: 'ada idea', ownerUserId: ada.id });
const adminTodo = dbApi.insertProjectTodo({ text: 'admin idea', ownerUserId: admin.id });
const systemTodo = dbApi.insertProjectTodo({ text: 'system idea' });

const adaMission = randomUUID();
const adminMission = randomUUID();
const systemMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada', undefined, ada.id);
dbApi.createMission(adminMission, 'admin.agent', 'admin', undefined, admin.id);
dbApi.createMission(systemMission, 'system.agent', 'system');

const adaMsg = dbApi.enqueueMessage({
  id: randomUUID(), fromMission: adaMission, fromAgent: 'a', toAgent: 'b',
  payload: 'ada', ownerUserId: ada.id,
});
const adminMsg = dbApi.enqueueMessage({
  id: randomUUID(), fromMission: adminMission, fromAgent: 'a', toAgent: 'b',
  payload: 'admin', ownerUserId: admin.id,
});
const systemMsg = dbApi.enqueueMessage({
  id: randomUUID(), fromMission: systemMission, fromAgent: 'a', toAgent: 'b',
  payload: 'system',
});

dbApi.upsertBrowserSession({
  project: 'ada-proj', containerName: 'c-ada', cdpPort: 9301, novncPort: 3002,
  status: 'stopped', ownerUserId: ada.id,
});
dbApi.upsertBrowserSession({
  project: 'admin-proj', containerName: 'c-admin', cdpPort: 9302, novncPort: 3003,
  status: 'stopped', ownerUserId: admin.id,
});
dbApi.upsertBrowserSession({
  project: 'sys-proj', containerName: 'c-sys', cdpPort: 9303, novncPort: 3004,
  status: 'stopped',
});

const adaMem = dbApi.insertProposal({ kind: 'pitfall', text: 'ada mem', ownerUserId: ada.id });
const adminMem = dbApi.insertProposal({ kind: 'pitfall', text: 'admin mem', ownerUserId: admin.id });
const systemMem = dbApi.insertProposal({ kind: 'pitfall', text: 'system mem' });

const adaDream = dbApi.insertDreamProposal({
  kind: 'improve', project: 'p', title: 'ada dream', body: 'b', ownerUserId: ada.id,
});
const adminDream = dbApi.insertDreamProposal({
  kind: 'improve', project: 'p', title: 'admin dream', body: 'b', ownerUserId: admin.id,
});
const systemDream = dbApi.insertDreamProposal({
  kind: 'improve', project: 'p', title: 'system dream', body: 'b',
});

test('without a viewer, list keeps the historical unscoped behaviour', () => {
  const ids = new Set(dbApi.listTasks().map((t) => t.id));
  assert.ok(ids.has(adaTask) && ids.has(adminTask) && ids.has(systemTask));
});

test('a superadmin viewer sees every row, including unowned ones', () => {
  const scope = scopedDb(adminViewer);
  assert.equal(scope.listTasks().length, 3);
  assert.ok(scope.getTask(systemTask));
  assert.ok(scope.listNotifications().some((n) => n.id === systemNotif.id));
  assert.ok(scope.getProjectTodo(systemTodo.id));
  assert.ok(scope.getMessage(systemMsg.id));
  assert.ok(scope.getBrowserSession('sys-proj'));
  assert.ok(scope.getProposal(systemMem));
  assert.ok(scope.getDreamProposal(systemDream));
});

test('a regular viewer sees only their own rows, never NULL', () => {
  const scope = scopedDb(adaViewer);
  assert.deepEqual(scope.listTasks().map((t) => t.id), [adaTask]);
  assert.equal(scope.getTask(adminTask), undefined);
  assert.equal(scope.getTask(systemTask), undefined);
  assert.deepEqual(scope.listNotifications().map((n) => n.id).sort(), [adaNotif.id].sort());
  assert.equal(scope.getNotification(adminNotif.id), undefined);
  assert.equal(scope.getProjectTodo(adminTodo.id), undefined);
  assert.equal(scope.getProjectTodo(systemTodo.id), undefined);
  assert.ok(scope.getProjectTodo(adaTodo.id));
  assert.equal(scope.getMessage(adminMsg.id), undefined);
  assert.ok(scope.getMessage(adaMsg.id));
  assert.equal(scope.getBrowserSession('admin-proj'), undefined);
  assert.equal(scope.getBrowserSession('sys-proj'), undefined);
  assert.ok(scope.getBrowserSession('ada-proj'));
  assert.equal(scope.getProposal(adminMem), undefined);
  assert.ok(scope.getProposal(adaMem));
  assert.equal(scope.getDreamProposal(adminDream), undefined);
  assert.ok(scope.getDreamProposal(adaDream));
});

test('tasks:read:all sees every task including unowned, without being superadmin', () => {
  const scope = scopedDb(bobAllViewer);
  const ids = new Set(scope.listTasks().map((t) => t.id));
  assert.ok(ids.has(adaTask) && ids.has(adminTask) && ids.has(systemTask));
  assert.equal(scope.getNotification(adaNotif.id), undefined, 'other domains stay own-only');
});

test('assignUnownedOwnedTo attributes leftover rows to the superadmin at setup', () => {
  const n = dbApi.assignUnownedOwnedTo(admin.id);
  assert.equal(n.tasks, 1);
  assert.equal(n.notifications, 1);
  assert.equal(n.project_todo, 1);
  assert.equal(n.agent_messages, 1);
  assert.equal(n.browser_sessions, 1);
  assert.equal(n.memory_proposals, 1);
  assert.equal(n.dream_proposals, 1);
  assert.equal(dbApi.getTask(systemTask)?.owner_user_id, admin.id);
  assert.equal(scopedDb(adaViewer).getTask(systemTask), undefined);
  assert.ok(scopedDb(adminViewer).getTask(systemTask));
});

test('createTask inherits owner from the creator mission', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'ada.agent', 'inherit', undefined, ada.id);
  const child = randomUUID();
  dbApi.createTask(child, 'follow-up', 'ada.reviewer', { creatorMissionId: missionId });
  assert.equal(dbApi.getTask(child)?.owner_user_id, ada.id);
});

test('createNotification inherits owner from the linked task', () => {
  const n = dbApi.createNotification({
    id: randomUUID(), type: 'alert', title: 'from task', taskId: adaTask,
  });
  assert.equal(n.owner_user_id, ada.id);
});

test('browserSessionAccess hides another owner as forbidden, not missing', () => {
  assert.equal(dbApi.browserSessionAccess('ada-proj', adaViewer), 'ok');
  assert.equal(dbApi.browserSessionAccess('ada-proj', bobViewer), 'forbidden');
  assert.equal(dbApi.browserSessionAccess('no-such', adaViewer), 'missing');
});
