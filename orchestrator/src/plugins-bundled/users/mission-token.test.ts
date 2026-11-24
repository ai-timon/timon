/**
 * secu-3 — a mission API token issued for a superadmin launcher is
 * refused on invitations/users (403) and accepted on kanban/notify of
 * its own mission. Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-token-secu3-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./routes.js');
const { registerRoutes: registerKanban } = await import('../kanban/routes.js');
const { registerRoutes: registerKanbanCode } = await import('../kanban-code/routes.js');
const { registerRoutes: registerNotifs } = await import('../notifications/routes.js');
const { registerRoutes: registerMissions } = await import('../missions/routes.js');
const { registerRoutes: registerProjects } = await import('../projects/routes.js');
const { registerRoutes: registerAgents } = await import('../agents/routes.js');
const { registerRoutes: registerSecrets } = await import('../secrets-vault/routes.js');
const { registerRoutes: registerRoutines } = await import('../routines/routes.js');
const { dbApi } = await import('../../db.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerKanban(app);
registerKanbanCode(app);
registerNotifs(app);
registerMissions(app);
registerProjects(app);
registerAgents(app);
registerSecrets(app);
registerRoutines(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

/** A right-check 403 keeps `error: 'forbidden'` and now carries a stable `code`. */
function assertForbidden(json: unknown): void {
  const body = json as { error?: unknown; code?: unknown };
  assert.equal(body.error, 'forbidden');
  assert.equal(typeof body.code, 'string');
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup.res)!;
assert.ok(adminCookie);

const created = postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = created.json.user!.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);

const adminMission = randomUUID();
dbApi.createMission(adminMission, 'admin.agent', 'admin work', undefined, adminId);
const adminToken = issueMissionApiToken(adminMission);
assert.ok(dbApi.getLiveApiToken(hashApiToken(adminToken)));

const adaMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada work', undefined, adaId);
const adaToken = issueMissionApiToken(adaMission);

const adminTask = randomUUID();
dbApi.createTask(adminTask, 'admin only', 'admin.agent', { ownerUserId: adminId });
const adaTask = randomUUID();
dbApi.createTask(adaTask, 'ada only', 'ada.agent', { ownerUserId: adaId });

test('a superadmin mission token reaches no account route', async () => {
  const listUsers = await call('GET', '/api/users', { bearer: adminToken });
  assert.equal(listUsers.status, 404, 'the account list is the operator recovery: daemon token only');

  const createUser = await call('POST', '/api/users', {
    bearer: adminToken,
    body: { email: 'mallory@example.com', name: 'Mallory', password: 'mallory-secret' },
  });
  assert.equal(createUser.status, 404);
  assert.equal(dbApi.getUserByEmail('mallory@example.com'), undefined);

  const reset = await call('POST', `/api/users/${adaId}/reset-password`, { bearer: adminToken });
  assert.equal(reset.status, 404);

  const firstAdmin = await call('POST', '/api/users/first-admin', {
    bearer: adminToken,
    body: { email: 'mallory@example.com', name: 'Mallory', password: 'mallory-secret' },
  });
  assert.equal(firstAdmin.status, 404, 'the terminal\'s first account is the daemon token\'s only');
  assert.equal(dbApi.getUserByEmail('mallory@example.com'), undefined);
});

test('superadmin mission token is accepted on kanban/notify of its mission', async () => {
  const ownMission = await call('GET', `/api/missions/${adminMission}`, { bearer: adminToken });
  assert.equal(ownMission.status, 200);

  const hiddenMission = await call('GET', `/api/missions/${adaMission}`, { bearer: adminToken });
  assert.equal(hiddenMission.status, 404);

  const list = await call('GET', '/api/tasks', { bearer: adminToken });
  assert.equal(list.status, 200);
  const ids = ((list.json as { tasks: Array<{ id: string }> }).tasks).map((t) => t.id);
  assert.ok(ids.includes(adminTask));
  assert.ok(!ids.includes(adaTask));

  const ownTask = await call('GET', `/api/tasks/${adminTask}`, { bearer: adminToken });
  assert.equal(ownTask.status, 200);

  const hiddenTask = await call('GET', `/api/tasks/${adaTask}`, { bearer: adminToken });
  assert.equal(hiddenTask.status, 404);

  const createdTask = await call('POST', '/api/tasks', {
    bearer: adminToken,
    body: { title: 'from mission', agent_name: 'admin.agent' },
  });
  assert.equal(createdTask.status, 201, JSON.stringify(createdTask.json));
  const newId = (createdTask.json as { task: { id: string; owner_user_id: string } }).task.id;
  assert.equal(
    (createdTask.json as { task: { owner_user_id: string } }).task.owner_user_id,
    adminId,
  );
  const fetched = await call('GET', `/api/tasks/${newId}`, { bearer: adminToken });
  assert.equal(fetched.status, 200);

  const notify = await call('POST', '/api/notifications', {
    bearer: adminToken,
    body: { type: 'report', title: 'mission report', mission_id: adminMission },
  });
  assert.equal(notify.status, 201, JSON.stringify(notify.json));

  const notifs = await call('GET', '/api/notifications', { bearer: adminToken });
  assert.equal(notifs.status, 200);
  const titles = ((notifs.json as { notifications: Array<{ title: string }> }).notifications)
    .map((n) => n.title);
  assert.ok(titles.includes('mission report'));

  const projects = await call('GET', '/api/projects', { bearer: adminToken });
  assert.equal(projects.status, 200);
});

test('superadmin mission token does not inherit * on gated routes', async () => {
  const secrets = await call('POST', '/api/secrets', {
    bearer: adminToken,
    body: { name: 'PWN_TOKEN', value: 'exfiltrate-me' },
  });
  assert.equal(secrets.status, 403);
  assertForbidden(secrets.json);

  const spawn = await call('POST', '/api/missions', {
    bearer: adminToken,
    body: { agent: 'admin.agent', mission: 'pwn' },
  });
  assert.equal(spawn.status, 403);
  assertForbidden(spawn.json);
});

test('the agent of a superadmin does not read the nightly backup: the person does (TODO #627)', async () => {
  for (const [method, path, body] of [['GET', '/api/backup/status'], ['POST', '/api/backup/enable', {}]] as Array<[string, string, unknown?]>) {
    const refused = await call(method, path, { bearer: adminToken, ...(body === undefined ? {} : { body }) });
    assert.equal(refused.status, 403, `${method} ${path}`);
    assertForbidden(refused.json);
    assert.equal((refused.json as { code: string }).code, 'operator_only');
    assert.ok(!JSON.stringify(refused.json).includes(process.env.TIMON_HOME!), 'the refusal does not name the backups folder');
  }
  const person = await call('GET', '/api/backup/status', { cookie: adminCookie });
  assert.equal(person.status, 200);
  assert.equal(typeof (person.json as { dir: unknown }).dir, 'string');
});

test('a mission token cannot open a permission card for a sibling mission', async () => {
  // `body.mission_id` is client-controlled; the token is bound to adminMission.
  // Asking a card for adaMission is refused before the long-poll even starts.
  const sibling = await call('POST', '/api/permissions/request', {
    bearer: adminToken,
    body: { mission_id: adaMission, tool_name: 'Bash', tool_use_id: 'tu-sibling' },
  });
  assert.equal(sibling.status, 403);
  assertForbidden(sibling.json);
  assert.equal((sibling.json as { code: string }).code, 'out_of_scope');
  // The refusal never echoes the sibling mission's id.
  assert.ok(!JSON.stringify(sibling.json).includes(adaMission));
});

test('employee mission token reads its own kanban and closes its own task, but writes no task', async () => {
  const list = await call('GET', '/api/tasks', { bearer: adaToken });
  assert.equal(list.status, 200);
  const ids = ((list.json as { tasks: Array<{ id: string }> }).tasks).map((t) => t.id);
  assert.ok(ids.includes(adaTask));
  assert.ok(!ids.includes(adminTask));

  // The Employee preset holds no `kanban:write` (TODO #752): creating a task
  // is writing the Kanban, whoever owns it.
  const createdTask = await call('POST', '/api/tasks', {
    bearer: adaToken,
    body: { title: 'ada from mission', agent_name: 'ada.agent' },
  });
  assert.equal(createdTask.status, 403, JSON.stringify(createdTask.json));
  assert.equal((createdTask.json as { permission: unknown }).permission, 'kanban:write');

  // The task the mission runs: editing it is refused, closing it is not
  // (`timon task block`), like `POST /api/tasks/close`.
  dbApi.assignTaskMission(adaTask, adaMission);
  const edited = await call('PUT', `/api/tasks/${adaTask}`, {
    bearer: adaToken, body: { status: 'BLOCKED', blocked_reason: 'stuck', permission_mode_override: 'bypassPermissions' },
  });
  assert.equal(edited.status, 403, JSON.stringify(edited.json));
  const blocked = await call('PUT', `/api/tasks/${adaTask}`, {
    bearer: adaToken, body: { status: 'BLOCKED', blocked_reason: 'stuck' },
  });
  assert.equal(blocked.status, 200, JSON.stringify(blocked.json));
  assert.equal(dbApi.getTask(adaTask)?.status, 'BLOCKED');
  // Another task of the same owner is not the one it runs.
  const sibling = randomUUID();
  dbApi.createTask(sibling, 'ada sibling', 'ada.agent', { ownerUserId: adaId });
  const closedSibling = await call('PUT', `/api/tasks/${sibling}`, {
    bearer: adaToken, body: { status: 'BLOCKED', blocked_reason: 'not mine to close' },
  });
  assert.equal(closedSibling.status, 403);
  assert.equal(dbApi.getTask(sibling)?.status, 'PENDING');

  const notify = await call('POST', '/api/notifications', {
    bearer: adaToken,
    body: { type: 'report', title: 'ada report' },
  });
  assert.equal(notify.status, 201, JSON.stringify(notify.json));
});

test('employee mission token closes only the task it runs, and none of the other Kanban writes (TODO #787)', async () => {
  // One mission runs one task: a fresh mission per closing gesture.
  const running = () => {
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'ada.agent', 'ada task', undefined, adaId);
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'ada running', 'ada.agent', { ownerUserId: adaId, type: 'merge' });
    dbApi.assignTaskMission(taskId, missionId);
    return { missionId, taskId, token: issueMissionApiToken(missionId) };
  };
  const sibling = randomUUID();
  dbApi.createTask(sibling, 'ada other task', 'ada.agent', { ownerUserId: adaId, type: 'code' });
  const refusedForWrite = (r: { status: number; json: unknown }) => {
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal((r.json as { permission: unknown }).permission, 'kanban:write');
  };

  // `timon task mark-as-done`: no id, the CLI sends its own mission header.
  const a = running();
  const byMission = await call('POST', '/api/tasks/close', {
    bearer: a.token, headers: { 'X-TIMON-Mission': a.missionId }, body: { outcome: 'done', comment: 'done', merged_sha: 'abcdef1234567' },
  });
  assert.equal(byMission.status, 200, JSON.stringify(byMission.json));
  assert.equal(dbApi.getTask(a.taskId)?.status, 'DONE');

  // `kanban_mark_as_done` with the task's own id.
  const b = running();
  const byOwnId = await call('POST', '/api/tasks/close', { bearer: b.token, body: { outcome: 'failed', id: b.taskId, reason: 'stuck' } });
  assert.equal(byOwnId.status, 200, JSON.stringify(byOwnId.json));
  assert.equal(dbApi.getTask(b.taskId)?.status, 'BLOCKED');

  // Another task, by id, by a claimed mission, by a spoofed header: refused
  // before any resolution, so the refusal names no mission and no task.
  const c = running();
  refusedForWrite(await call('POST', '/api/tasks/close', { bearer: c.token, body: { outcome: 'failed', id: sibling, reason: 'not mine' } }));
  refusedForWrite(await call('POST', '/api/tasks/close', { bearer: c.token, body: { outcome: 'failed', mission_id: b.missionId, reason: 'not mine' } }));
  const spoofed = await call('POST', '/api/tasks/close', {
    bearer: c.token, headers: { 'X-TIMON-Mission': randomUUID() }, body: { outcome: 'failed', reason: 'not mine' },
  });
  refusedForWrite(spoofed);
  assert.ok(!JSON.stringify(spoofed.json).includes('no task attached'));
  assert.equal(dbApi.getTask(sibling)?.status, 'PENDING');
  assert.equal(dbApi.getTask(c.taskId)?.status, 'IN_PROGRESS');

  // `timon task done --merged-sha`: the sha first, then the closing PUT.
  // Another sha than the first closing's: a merge sha proves one task only.
  const sha = await call('POST', `/api/tasks/${c.taskId}/merged-sha`, { bearer: c.token, body: { sha: 'abcdef7654321' } });
  assert.equal(sha.status, 200, JSON.stringify(sha.json));
  const done = await call('PUT', `/api/tasks/${c.taskId}`, { bearer: c.token, body: { status: 'DONE', done_comment: 'merged' } });
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.equal(dbApi.getTask(c.taskId)?.status, 'DONE');
  assert.equal(dbApi.getTask(c.taskId)?.merged_commit_sha, 'abcdef7654321');
  refusedForWrite(await call('POST', `/api/tasks/${sibling}/merged-sha`, { bearer: c.token, body: { sha: 'abcdef1234567' } }));
  assert.equal(dbApi.getTask(sibling)?.merged_commit_sha, null);
  // The merger's cleanup (`timon worktree dispose`) on its own task: nothing to dispose is fine.
  const disposed = await call('DELETE', `/api/tasks/${c.taskId}/worktree`, { bearer: c.token });
  assert.equal(disposed.status, 200, JSON.stringify(disposed.json));

  // Human gestures of the board, worktrees of other tasks, pipelines: no exception.
  const d = running();
  refusedForWrite(await call('POST', `/api/tasks/${d.taskId}/mark-merged`, { bearer: d.token, body: { sha: 'abcdef1234567' } }));
  refusedForWrite(await call('POST', `/api/tasks/${d.taskId}/worktree`, { bearer: d.token, body: {} }));
  refusedForWrite(await call('DELETE', `/api/tasks/${sibling}/worktree`, { bearer: d.token }));
  refusedForWrite(await call('POST', `/api/tasks/${d.taskId}/worktree/detach`, { bearer: d.token, body: {} }));
  refusedForWrite(await call('POST', '/api/pipelines', {
    bearer: d.token, body: { name: 'p', definition: { steps: [{ id: 's', agent: 'ada.agent', prompt: 'x' }] } },
  }));
  assert.equal(dbApi.getTask(d.taskId)?.status, 'IN_PROGRESS');
});

test('a superadmin mission token creates agents and projects, within existing host directories (TIM-0013)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'timon-tim0013-'));
  // Project first: an agent's cwd must lie inside a registered project
  // (`cwdRefusal`), so the order the tester tried (agent, then project) is
  // the one the tool descriptions now spell out.
  const project = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'walid-project', name: 'Walid', cwd },
  });
  assert.equal(project.status, 200, JSON.stringify(project.json));

  const agent = await call('POST', '/api/agents', {
    bearer: adminToken,
    body: { name: 'walid.main', system_prompt: '# walid', config: { cwd, project: 'walid-project' } },
  });
  assert.equal(agent.status, 200, JSON.stringify(agent.json));

  // The bound: a cwd that does not exist on the host is refused to a mission
  // token, where a superadmin session could still register it.
  const ghost = await call('POST', '/api/projects', {
    bearer: adminToken,
    body: { slug: 'walid-ghost', cwd: join(cwd, 'does-not-exist') },
  });
  assert.equal(ghost.status, 403, JSON.stringify(ghost.json));
});

test('an employee mission token without agents:manage / projects:manage stays 403', async () => {
  const agent = await call('POST', '/api/agents', {
    bearer: adaToken,
    body: { name: 'ada.helper', system_prompt: '# ada' },
  });
  assert.equal(agent.status, 403);
  const project = await call('POST', '/api/projects', {
    bearer: adaToken,
    body: { slug: 'ada-project' },
  });
  assert.equal(project.status, 403);
});

test('steer: an anonymous caller is 401 and another account\'s mission a 404, nothing reaches it', async () => {
  const before = dbApi.listEvents(adminMission).length;
  const path = `/api/missions/${adminMission}/steer`;
  const body = { input: 'drop everything' };
  assert.equal((await call('POST', path, { body })).status, 401);
  assert.equal((await call('POST', path, { body, bearer: 'not-a-token' })).status, 401);
  assert.equal((await call('POST', path, { body, bearer: adaToken })).status, 404);
  const adaLogin = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'ada-secret' } });
  assert.equal((await call('POST', path, { body, cookie: sessionCookie(adaLogin.res)! })).status, 404);
  // The other way round too: a superadmin's mission token sees only its account's.
  assert.equal((await call('POST', `/api/missions/${adaMission}/steer`, { body, bearer: adminToken })).status, 404);
  assert.equal(dbApi.listEvents(adminMission).length, before, 'nothing was written to the conversation');
});

test('steer: a mission token reaches another mission of its account, never its own turn', async () => {
  const sibling = randomUUID();
  dbApi.createMission(sibling, 'admin.agent', 'admin sibling', undefined, adminId);
  const body = { input: 'go left' };
  // Past the guards: the route's own answer, a mission with no turn running.
  const other = await call('POST', `/api/missions/${sibling}/steer`, { body, bearer: adminToken });
  assert.equal(other.status, 409, JSON.stringify(other.json));
  assert.equal((other.json as { code: string }).code, 'no_turn_to_steer');

  const own = await call('POST', `/api/missions/${adminMission}/steer`, { body, bearer: adminToken });
  assert.equal(own.status, 400, JSON.stringify(own.json));
  assert.equal((own.json as { code: string }).code, 'steer_self');

  // Neither guard concerns the operator's CLI, which has no mission of its own.
  const daemon = await call('POST', `/api/missions/${adminMission}/steer`, { body, bearer: TOKEN });
  assert.equal(daemon.status, 409, JSON.stringify(daemon.json));
});
