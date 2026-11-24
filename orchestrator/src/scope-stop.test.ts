/**
 * `POST /api/stop`: the technical stop of an agent or a project. Security
 * cases first — anonymous refused, no permission refused, another owner's
 * scope left untouched — then what a stop neutralises, one path each.
 */
import { createTestAccount, grantTestPermissions } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from './users/identity.js';

const { db, dbApi } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { AGENTS_DIR } = await import('./paths.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { insertTrigger, getTriggerRow } = await import('./triggers/store.js');
const { completeRequestReplies } = await import('./agent-request-replies.js');

const alice = createTestAccount(dbApi, { email: 'stop-alice@example.com', name: 'Alice', passwordHash: 'x', isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'stop-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const admin = createTestAccount(dbApi, { email: 'stop-admin@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });

for (const [name, project] of [['worker', 'acme'], ['pilot', null], ['peer', 'acme'], ['other', 'elsewhere']] as const) {
  mkdirSync(join(AGENTS_DIR, name), { recursive: true });
  writeFileSync(join(AGENTS_DIR, name, 'config.json'), JSON.stringify(project ? { project } : {}));
}

/** Identities a real login would produce; the route logic is what is under test. */
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  alice: { kind: 'session', user: alice, isSuperadmin: false },
  bob: { kind: 'session', user: bob, isSuperadmin: false },
  'bob-reader': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: ['missions:read'] },
};
// Plain sessions read their grants from the permission source: give both users
// the Employee grants (`missions:stop` included).
for (const user of [alice, bob]) {
  grantTestPermissions(dbApi, user.id, ['missions:spawn', 'missions:read', 'missions:stop']);
}

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: 'daemon-test-token', required: true })(req, res, next);
});
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function stop(body: unknown, as: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}/api/stop`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Json };
}

const missionStatus = (id: string) => dbApi.getMission(id)?.status;
const messageStatus = (id: string) => (db.prepare('SELECT status FROM agent_messages WHERE id = ?').get(id) as { status: string }).status;
const taskRow = (id: string) => db.prepare('SELECT status, blocked_reason FROM tasks WHERE id = ?').get(id) as { status: string; blocked_reason: string | null };
const settledAt = (id: string) => (db.prepare('SELECT settled_at FROM agent_request_deliveries WHERE request_id = ?').get(id) as { settled_at: number | null }).settled_at;

/** One owner's full footprint on `worker`: a running child mission with a
 *  parent, a pending inbox message, an open request, a scheduled task, a
 *  schedule trigger. */
function footprint(owner: string) {
  const pilotMission = randomUUID();
  dbApi.createMission(pilotMission, 'pilot', 'pilot', undefined, owner);
  const mission = randomUUID();
  dbApi.createMission(mission, 'worker', 'work', undefined, owner);
  dbApi.setMissionLineage(mission, { parentMissionId: pilotMission, parentAgent: 'pilot' });
  const inbox = randomUUID();
  dbApi.enqueueMessage({ id: inbox, fromMission: pilotMission, fromAgent: 'pilot', toAgent: 'worker', payload: 'go on', ownerUserId: owner });
  const request = randomUUID();
  dbApi.enqueueMessage({ id: request, fromMission: pilotMission, fromAgent: 'pilot', toAgent: 'worker', kind: 'request', payload: 'answer me', ownerUserId: owner });
  db.prepare(`UPDATE agent_messages SET status = 'picked' WHERE id = ?`).run(request);
  const event = dbApi.insertEvent(mission, 'user', { message: { content: 'answer me' } });
  db.prepare('INSERT INTO agent_request_deliveries (request_id, mission_id, event_id) VALUES (?, ?, ?)').run(request, mission, event.id);
  const task = randomUUID();
  dbApi.createTask(task, 'nightly job', 'worker', { scheduledAt: Date.now() + 3_600_000, ownerUserId: owner });
  const trigger = insertTrigger({
    name: `every hour (${owner.slice(0, 4)})`, slug: null, source: 'schedule', enabled: true, config: { cron: '0 * * * *' },
    filter: null, actions: [{ type: 'task', agent: 'worker', prompt: 'run' }], secret: null, ownerUserId: owner,
    createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['kanban:write'], nextRunAt: Date.now() + 60_000,
  });
  return { pilotMission, mission, inbox, request, task, trigger: trigger.id };
}

test('anonymous is refused, a caller without the permission too, a bad body is 400', async () => {
  assert.equal((await stop({ agent: 'worker' }, null)).status, 401);
  assert.equal((await stop({ agent: 'worker' }, 'bob-reader')).status, 403);
  assert.equal((await stop({ agent: 'worker', project: 'acme' }, 'bob')).status, 400);
  assert.equal((await stop({ agent: '../etc' }, 'bob')).status, 400);
  assert.equal((await stop({ agent: 'nobody' }, 'bob')).status, 404);
});

test('a user stopping an agent leaves another owner\'s footprint on it untouched', async () => {
  const a = footprint(alice.id);
  const b = footprint(bob.id);
  const res = await stop({ agent: 'worker' }, 'bob');
  assert.equal(res.status, 200);

  // Bob's side: everything neutralised and listed.
  assert.equal(missionStatus(b.mission), 'terminated');
  assert.equal(messageStatus(b.inbox), 'picked');
  assert.ok(settledAt(b.request));
  assert.equal(taskRow(b.task).status, 'BLOCKED');
  assert.match(String(taskRow(b.task).blocked_reason), /Stopped by stop-bob@example\.com/);
  const code = db.prepare('SELECT blocked_reason_code FROM tasks WHERE id = ?').get(b.task) as { blocked_reason_code: string | null };
  assert.deepEqual(JSON.parse(code.blocked_reason_code ?? 'null'), {
    code: 'task_stopped_by_scope', params: { by: 'stop-bob@example.com', kind: 'agent', name: 'worker' },
  });
  assert.equal(getTriggerRow(b.trigger)?.enabled, 0);
  const ids = (key: string, field = 'id') => (res.body[key] as Json[]).map((row) => row[field]);
  assert.deepEqual(ids('missions'), [b.mission]);
  assert.deepEqual(ids('messages'), [b.inbox]);
  assert.deepEqual(ids('deliveries', 'request_id'), [b.request]);
  assert.deepEqual(ids('tasks'), [b.task]);
  assert.deepEqual(ids('triggers'), [b.trigger]);

  // Alice's side: not a single row moved.
  assert.equal(missionStatus(a.mission), 'running');
  assert.equal(messageStatus(a.inbox), 'pending');
  assert.equal(settledAt(a.request), null);
  assert.equal(taskRow(a.task).status, 'PENDING');
  assert.equal(getTriggerRow(a.trigger)?.enabled, 1);

  // The stop leaves nothing behind that would wake anyone: no request reply,
  // no `mission_complete` return to the pilot.
  completeRequestReplies(b.mission, 'terminated');
  const woken = db.prepare(`SELECT id FROM agent_messages WHERE status = 'pending' AND owner_user_id = ?`).all(bob.id);
  assert.deepEqual(woken, []);

  // Clean up Alice for the next test: the superadmin stop reaches every owner.
  const all = await stop({ agent: 'worker' }, 'admin');
  assert.equal(all.status, 200);
  assert.equal(missionStatus(a.mission), 'terminated');
  assert.equal(getTriggerRow(a.trigger)?.enabled, 0);
});

test('a project stop reaches every agent of the project and its tasks on other agents', async () => {
  const peerMission = randomUUID();
  dbApi.createMission(peerMission, 'peer', 'peer work', undefined, alice.id);
  const foreignTask = randomUUID();
  dbApi.createTask(foreignTask, 'acme chore on another agent', 'other', { project: 'acme', ownerUserId: alice.id });
  const untouched = randomUUID();
  dbApi.createTask(untouched, 'elsewhere', 'other', { ownerUserId: alice.id });
  const otherMission = randomUUID();
  dbApi.createMission(otherMission, 'other', 'unrelated', undefined, alice.id);

  const res = await stop({ project: 'acme' }, 'alice');
  assert.equal(res.status, 200);
  assert.deepEqual([...(res.body.agents as string[])].sort(), ['peer', 'worker']);
  assert.equal(missionStatus(peerMission), 'terminated');
  assert.equal(taskRow(foreignTask).status, 'BLOCKED');
  assert.equal(taskRow(untouched).status, 'PENDING');
  assert.equal(missionStatus(otherMission), 'running');
  assert.equal((await stop({ project: 'no-such-project' }, 'alice')).status, 404);
});

const { failWorkflowMission } = await import('./workflows/engine.js');
const { bus } = await import('./bus.js');

/** The workflows plugin's exit handler (`plugins-bundled/workflows/index.ts`):
 *  a killed node mission fails its node — the path that retried it. */
const onMissionEnd = (event: { kind: string; missionId?: string; status?: string }) => {
  if (event.kind === 'mission_complete' && event.missionId && event.status === 'terminated') {
    failWorkflowMission(event.missionId, `mission ${event.status}`);
  }
};
bus.on('event', onMissionEnd);
test.after(() => { bus.off('event', onMissionEnd); });

/** A run of a workflow piloted by `pilot` (default `pilot`): node `a` on `ref`
 *  is running (with one retry left), node `b` on `later` has not started. */
function workflowRun(owner: string, opts: { ref: string; later: string; pilot?: string; project?: string | null }) {
  const pilot = opts.pilot ?? 'pilot';
  const id = randomUUID(); const runId = randomUUID(); const now = Date.now();
  const definition = { schemaVersion: 1, nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'a', type: 'agent', config: { ref: opts.ref, retries: 1 } },
    { id: 'b', type: 'agent', config: { ref: opts.later } },
    { id: 'done', type: 'output', config: { template: 'ok' } },
  ], edges: [
    { id: 'e1', from: 'start', fromPort: 'out', to: 'a', toPort: 'in' },
    { id: 'e2', from: 'a', fromPort: 'done', to: 'b', toPort: 'in' },
    { id: 'e3', from: 'b', fromPort: 'done', to: 'done', toPort: 'in' },
  ], variables: [], settings: { maxParallel: 1, onError: 'fail' } };
  const slug = `wf-${id.slice(0, 8)}`;
  dbApi.insertWorkflow({ id, slug, name: 'Stop witness', description: null, project: opts.project ?? null, owner_user_id: owner, draft: JSON.stringify(definition), published_version: 1, enabled: 1, created_at: now, updated_at: now, agent_name: pilot });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  const pilotMission = randomUUID(); const nodeMission = randomUUID();
  dbApi.insertWorkflowRun({ id: runId, workflow_id: id, version: 1, status: 'running', trigger: '{}', input: '{}', context: JSON.stringify({ supervised: true, coordinatorMissionId: pilotMission, input: {}, vars: {}, trigger: {}, nodes: {}, run: { id: runId, started_at: now } }), error: null, started_at: now, ended_at: null, owner_user_id: owner, tokens_in: null, tokens_out: null, cost_usd: null });
  for (const node of definition.nodes) {
    const status = node.id === 'start' ? 'ok' : node.id === 'a' ? 'running' : 'pending';
    dbApi.insertWorkflowRunNode({ run_id: runId, node_id: node.id, attempt: 1, status, mission_id: node.id === 'a' ? nodeMission : null, input: null, output: null, error: null, taken_port: node.id === 'start' ? 'out' : null, started_at: status === 'pending' ? null : now, ended_at: null, tokens_in: null, tokens_out: null });
  }
  dbApi.createMission(pilotMission, pilot, 'pilot the run', { channel: 'workflow' }, owner, runId, { runId, nodeId: null });
  dbApi.createMission(nodeMission, opts.ref, 'node a', { channel: 'workflow' }, owner, runId, { runId, nodeId: 'a' });
  dbApi.setMissionLineage(nodeMission, { parentMissionId: pilotMission, parentAgent: pilot });
  return { runId, pilotMission, nodeMission };
}

const runStatus = (id: string) => dbApi.getWorkflowRun(id)?.status;
const attempts = (runId: string, nodeId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM workflow_run_nodes WHERE run_id = ? AND node_id = ?').get(runId, nodeId) as { n: number }).n;
const runMissions = (runId: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM missions WHERE workflow_run_id = ?').get(runId) as { n: number }).n;

test('stopping an agent cancels the workflow run it works for, without a retry nor a word to the pilot', async () => {
  const a = workflowRun(alice.id, { ref: 'worker', later: 'other' });
  const b = workflowRun(bob.id, { ref: 'worker', later: 'other' });
  const res = await stop({ agent: 'worker' }, 'bob');
  assert.equal(res.status, 200);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runStatus(b.runId), 'cancelled');
  assert.equal(attempts(b.runId, 'a'), 1, 'the killed node must not be retried on the stopped agent');
  assert.equal(runMissions(b.runId), 2, 'no mission started after the stop');
  assert.equal(missionStatus(b.nodeMission), 'terminated');
  assert.equal(missionStatus(b.pilotMission), 'terminated');
  const pending = db.prepare(`SELECT id FROM agent_messages WHERE status = 'pending' AND owner_user_id = ?`).all(bob.id);
  assert.deepEqual(pending, [], 'the cancellation report would respawn the pilot');
  assert.deepEqual((res.body.workflow_runs as Json[]).map((r) => r.id), [b.runId]);
  assert.deepEqual((res.body.missions as Json[]).map((m) => m.id).sort(), [b.nodeMission, b.pilotMission].sort());
  assert.ok((res.body.messages as Json[]).some((m) => String(m.id).startsWith(`workflow-report:${b.runId}:`)));

  // Another owner's run on the same agent goes on.
  assert.equal(runStatus(a.runId), 'running');
  assert.equal(missionStatus(a.nodeMission), 'running');
  assert.equal((await stop({ agent: 'worker' }, 'admin')).status, 200);
  assert.equal(runStatus(a.runId), 'cancelled');
});

test('a run is in the scope through a node still to come, its pilot, or its project', async () => {
  // `other` runs node a; `peer` (acme) only appears at node b.
  const upcoming = workflowRun(alice.id, { ref: 'other', later: 'peer', pilot: 'other' });
  const piloted = workflowRun(alice.id, { ref: 'other', later: 'other' });
  const filed = workflowRun(alice.id, { ref: 'other', later: 'other', pilot: 'other', project: 'acme' });
  const unrelated = workflowRun(alice.id, { ref: 'other', later: 'other', pilot: 'other', project: 'elsewhere' });
  const byPilot = await stop({ agent: 'pilot' }, 'alice');
  assert.deepEqual((byPilot.body.workflow_runs as Json[]).map((r) => r.id), [piloted.runId]);
  assert.equal(runStatus(piloted.runId), 'cancelled');
  assert.equal(missionStatus(piloted.nodeMission), 'terminated');
  assert.equal(runStatus(upcoming.runId), 'running');

  const byProject = await stop({ project: 'acme' }, 'alice');
  assert.equal(byProject.status, 200);
  assert.deepEqual((byProject.body.workflow_runs as Json[]).map((r) => r.id).sort(), [upcoming.runId, filed.runId].sort());
  assert.equal(runStatus(upcoming.runId), 'cancelled');
  assert.equal(missionStatus(upcoming.nodeMission), 'terminated', 'a cancelled run stops all of its missions');
  assert.equal(runStatus(filed.runId), 'cancelled');
  assert.equal(runStatus(unrelated.runId), 'running');
  assert.equal(missionStatus(unrelated.nodeMission), 'running');
});

const { armWorkflowTriggers, migrateLegacyWorkflowTriggers } = await import('./workflows/triggers.js');
const { workflowNodeTriggers } = await import('./workflows/native-facade.js');
const { createWorkflowActionProvider } = await import('./workflows/native-triggers.js');
const { getTrigger } = await import('./triggers/store.js');

/** A published, switched-on workflow with automatic entries — a schedule
 *  (native façade) and a plugin business event (`workflow_triggers`) — and a
 *  node on `ref`; armed as publishing would. */
function scheduledWorkflow(owner: string, opts: { ref: string; pilot: string; project?: string | null; published?: boolean }) {
  const id = randomUUID(); const now = Date.now();
  const definition = { schemaVersion: 1, nodes: [
    { id: 'cron', type: 'trigger.schedule', config: { cron: '* * * * *' } },
    { id: 'biz', type: 'trigger.business', config: { event: 'acme.order' } },
    { id: 'a', type: 'agent', config: { ref: opts.ref } },
    { id: 'done', type: 'output', config: { template: 'ok' } },
  ], edges: [
    { id: 'e1', from: 'cron', fromPort: 'out', to: 'a', toPort: 'in' },
    { id: 'e2', from: 'biz', fromPort: 'out', to: 'a', toPort: 'in' },
    { id: 'e3', from: 'a', fromPort: 'done', to: 'done', toPort: 'in' },
  ], variables: [], settings: { maxParallel: 1, onError: 'fail' } };
  const published = opts.published ?? true;
  const slug = `wf-${id.slice(0, 8)}`;
  dbApi.insertWorkflow({ id, slug, name: 'Scheduled witness', description: null, project: opts.project ?? null, owner_user_id: owner, draft: JSON.stringify(definition), published_version: published ? 1 : null, enabled: 1, created_at: now, updated_at: now, agent_name: opts.pilot });
  if (published) {
    dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
    armWorkflowTriggers(id);
  }
  return { id, slug };
}

const workflowEnabled = (id: string) => dbApi.getWorkflow(id)?.enabled;
const facades = (id: string) => workflowNodeTriggers(id);
const pluginEntries = (id: string) =>
  (db.prepare('SELECT COUNT(*) AS n FROM workflow_triggers WHERE workflow_id = ?').get(id) as { n: number }).n;

test('a stop switches off the workflows that would put the scope back to work, and the boot does not switch them on again', async () => {
  const mine = scheduledWorkflow(bob.id, { ref: 'worker', pilot: 'other' });
  const theirs = scheduledWorkflow(alice.id, { ref: 'worker', pilot: 'other' });
  const unrelated = scheduledWorkflow(bob.id, { ref: 'other', pilot: 'other' });
  const draft = scheduledWorkflow(bob.id, { ref: 'worker', pilot: 'other', published: false });
  // A trigger Bob made himself on the Triggers page, starting the same workflow.
  const own = insertTrigger({
    name: 'nightly order sweep', slug: null, source: 'schedule', enabled: true, config: { cron: '0 3 * * *' },
    filter: null, actions: [{ type: 'workflow', workflow: mine.id, node: 'cron' }], secret: null, ownerUserId: bob.id,
    createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['workflows:run'], nextRunAt: Date.now() + 60_000,
  });
  assert.equal(facades(mine.id).length, 1);
  assert.equal(facades(mine.id)[0]!.enabled, true);
  assert.equal(pluginEntries(mine.id), 1);

  // A refused stop changes nothing.
  assert.equal((await stop({ agent: 'worker' }, null)).status, 401);
  assert.equal((await stop({ agent: 'worker' }, 'bob-reader')).status, 403);
  assert.equal(workflowEnabled(mine.id), 1);
  assert.equal(facades(mine.id)[0]!.enabled, true);

  const res = await stop({ agent: 'worker' }, 'bob');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.workflows, [{ id: mine.id, workflow: mine.slug }]);
  assert.equal(workflowEnabled(mine.id), 0);
  const [facade] = facades(mine.id);
  assert.equal(facade!.enabled, false, 'the schedule façade stands down');
  assert.equal(facade!.next_run_at, null);
  assert.equal(pluginEntries(mine.id), 0, 'the plugin entry is disarmed');
  assert.equal(getTriggerRow(own.id)?.enabled, 0, 'a user trigger starting the workflow is switched off too');
  assert.ok((res.body.triggers as Json[]).some((t) => t.id === own.id));

  // Even a trigger left on cannot start a run: the action refuses a switched-off workflow.
  const provider = createWorkflowActionProvider({ supervised: false });
  assert.throws(() => provider.run(getTrigger(facade!.trigger_id)!, { type: 'workflow', workflow: mine.id, node: 'cron' }, { body: {} } as never), /disabled/);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_runs WHERE workflow_id = ?').get(mine.id) as { n: number }).n, 0);

  // Boot re-syncs every published workflow on its switch: the stop holds.
  migrateLegacyWorkflowTriggers();
  assert.equal(facades(mine.id)[0]!.enabled, false);
  assert.equal(pluginEntries(mine.id), 0);

  // Another owner's workflow, an unrelated one and a draft are left alone.
  assert.equal(workflowEnabled(theirs.id), 1);
  assert.equal(facades(theirs.id)[0]!.enabled, true);
  assert.equal(pluginEntries(theirs.id), 1);
  assert.equal(workflowEnabled(unrelated.id), 1);
  assert.equal(workflowEnabled(draft.id), 1);

  // The superadmin's stop reaches Alice's.
  const all = await stop({ agent: 'worker' }, 'admin');
  assert.deepEqual((all.body.workflows as Json[]).map((w) => w.id), [theirs.id]);
  assert.equal(facades(theirs.id)[0]!.enabled, false);
});

test('a workflow is in the scope through its pilot or its project', async () => {
  const piloted = scheduledWorkflow(alice.id, { ref: 'other', pilot: 'pilot' });
  const filed = scheduledWorkflow(alice.id, { ref: 'other', pilot: 'other', project: 'acme' });
  const elsewhere = scheduledWorkflow(alice.id, { ref: 'other', pilot: 'other', project: 'elsewhere' });
  const byPilot = await stop({ agent: 'pilot' }, 'alice');
  assert.deepEqual((byPilot.body.workflows as Json[]).map((w) => w.id), [piloted.id]);
  const byProject = await stop({ project: 'acme' }, 'alice');
  assert.deepEqual((byProject.body.workflows as Json[]).map((w) => w.id), [filed.id]);
  assert.equal(workflowEnabled(filed.id), 0);
  assert.equal(workflowEnabled(elsewhere.id), 1);
});
