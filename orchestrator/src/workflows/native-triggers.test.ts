/**
 * Workflows plugged into the native triggers (TODO #216): the `workflow`
 * action, its absence when Workflows is off, ownership, overlap, the event
 * loop guard, and the legacy sources that must keep answering.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { db, dbApi } = await import('../db.js');
const { registerRoutes } = await import('../plugins-bundled/triggers/routes.js');
const { registerTriggerWebhook } = await import('../triggers/webhook.js');
const { createEventDispatcher } = await import('../triggers/events.js');
const { SCHEDULE_PROVIDER_GRACE_MS, tickSchedules } = await import('../triggers/engine.js');
const { signGeneric } = await import('../triggers/signature.js');
const { ACTION_UNAVAILABLE, registerActionProvider } = await import('../triggers/actions.js');
const { insertTrigger, listDeliveries } = await import('../triggers/store.js');
const { createRoutine } = await import('../routines.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { createWorkflowActionProvider } = await import('./native-triggers.js');
const { nativeBindings } = await import('./native-bindings.js');
const { armWorkflowTriggers } = await import('./triggers.js');
const { workflowNodeTriggers } = await import('./native-facade.js');

const admin = createTestAccount(dbApi, { email: 'wf-trig-admin@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'wf-trig-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const bobMission = randomUUID();
dbApi.createMission(bobMission, 'helper', 'test', undefined, bob.id);

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  // Holds every action permission, but only sees its own workflows.
  bob: { kind: 'api-token', user: bob, isSuperadmin: false, permissions: ['triggers:manage', 'kanban:write', 'notify', 'workflows:run'], missionId: bobMission },
};

const app = express();
app.use((req, _res, next) => { req.auth = IDENTITIES[req.header('x-test-as') ?? 'admin']; next(); });
app.use(createBodyParser());
registerTriggerWebhook(app, { listensOnLoopback: () => true });
registerRoutes(app, { listensOnLoopback: () => true });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, as = 'admin') {
  const res = await fetch(`${base}${path}`, {
    method, headers: { 'content-type': 'application/json', 'x-test-as': as }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Json };
}
async function hook(slug: string, secret: string, payload: unknown) {
  const raw = JSON.stringify(payload);
  const res = await fetch(`${base}/api/triggers/hooks/${slug}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...signGeneric(secret, raw, Math.floor(Date.now() / 1000)) }, body: raw,
  });
  return { status: res.status, body: await res.json() as Json };
}

/** A published workflow: entry node `entry` (manual unless told otherwise) → output. */
function seedWorkflow(owner: string | null, opts: { entry?: Json; settings?: Json; published?: boolean } = {}) {
  const id = randomUUID(); const now = Date.now();
  const definition = {
    schemaVersion: 1,
    nodes: [{ id: 'entry', type: 'trigger.manual', config: {}, ...opts.entry }, { id: 'out', type: 'output', config: { template: 'ok' } }],
    edges: [{ id: 'e', from: 'entry', fromPort: 'out', to: 'out', toPort: 'in' }],
    variables: [], settings: opts.settings ?? {},
  };
  const published = opts.published !== false;
  dbApi.insertWorkflow({ id, slug: `nt-${id.slice(0, 8)}`, name: 'native', description: null, project: null, owner_user_id: owner, draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: now, updated_at: now , agent_name: null});
  if (published) dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(definition), published_at: now, published_by: null });
  return id;
}
const runsOf = (id: string) => dbApi.listWorkflowRuns(id);
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('Workflows off: the action is refused at save, reported unavailable at run, everything else runs', async () => {
  const wf = seedWorkflow(admin.id);
  const refused = await api('POST', '/api/triggers', {
    source: 'event', name: 'no workflows', config: { event: 'task_done' }, actions: [{ type: 'workflow', workflow: wf, node: 'entry' }],
  });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, ACTION_UNAVAILABLE);

  // A trigger saved while Workflows ran stays readable and its other actions still fire.
  const row = insertTrigger({
    name: 'mixed', slug: null, source: 'schedule', enabled: true, config: { cron: '* * * * *' }, filter: null,
    actions: [{ type: 'todo', text: 'still here' }, { type: 'workflow', workflow: wf, node: 'entry' }],
    secret: null, ownerUserId: admin.id, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['*'], nextRunAt: 0,
  });
  const listed = await api('GET', '/api/triggers?source=schedule');
  assert.equal(listed.status, 200);
  assert.ok((listed.body.triggers as Json[]).some((t) => t.id === row.id));
  // It first waits for the module to start, then runs what it can once the grace is over.
  const now = Date.now();
  tickSchedules(now);
  assert.equal(listDeliveries(row.id).length, 0);
  tickSchedules(now + SCHEDULE_PROVIDER_GRACE_MS);
  const [delivery] = listDeliveries(row.id);
  assert.equal(delivery?.status, 'error');
  const outcomes = JSON.parse(delivery!.result!) as Array<{ type: string; ok: boolean; error?: string }>;
  assert.deepEqual(outcomes.map((o) => [o.type, o.ok]), [['todo', true], ['workflow', false]]);
  assert.equal(outcomes[1]!.error, ACTION_UNAVAILABLE);
  assert.equal(runsOf(wf).length, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM project_todo WHERE text = 'still here'`).get() as { n: number }).n, 1);

  // Still editable: switched off and renamed as it is, but no new workflow action.
  const off = await api('PATCH', `/api/triggers/${row.id}`, { enabled: false, name: 'mixed, off' });
  assert.equal(off.status, 200);
  assert.equal((off.body.trigger as Json).enabled, false);
  const widened = await api('PATCH', `/api/triggers/${row.id}`, {
    actions: [{ type: 'todo', text: 'still here' }, { type: 'workflow', workflow: wf, node: 'out' }],
  });
  assert.equal(widened.status, 400);
  assert.equal(widened.body.error, ACTION_UNAVAILABLE);

  // Routines are untouched by the absence of Workflows.
  createRoutine({ name: 'nightly', cron_expr: '0 3 * * *', agent_name: 'helper', prompt: 'do it' });
  const routines = await api('GET', '/api/triggers?source=schedule');
  assert.ok((routines.body.triggers as Json[]).some((t) => t.name === 'nightly' && t.created_by === 'routine'));
});

test('Workflows on: a signed webhook starts a run at the named entry node, payload as input', async (t) => {
  t.after(registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false })));
  const wf = seedWorkflow(admin.id);
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'to workflow', slug: 'to-workflow', config: { auth: 'generic' },
    actions: [{ type: 'workflow', workflow: wf, node: 'entry' }],
  });
  assert.equal(created.status, 201);
  const triggerId = String((created.body.trigger as Json).id);
  const res = await hook('to-workflow', String(created.body.secret), { ticket: 42 });
  assert.equal(res.status, 200);
  const runId = String((res.body.results as Json[])[0]!.id);
  await settle();
  const run = dbApi.getWorkflowRun(runId)!;
  assert.equal(run.workflow_id, wf);
  assert.equal(run.status, 'completed');
  assert.deepEqual(JSON.parse(run.input), { ticket: 42 });
  assert.deepEqual(JSON.parse(run.trigger), { kind: 'webhook', node_id: 'entry', trigger_id: triggerId, trigger_name: 'to workflow' });

  // The workflow side sees the binding.
  assert.deepEqual(nativeBindings(wf).map((b) => [b.trigger_id, b.node_id, b.enabled]), [[triggerId, 'entry', true]]);

  // Only entry nodes of a published version.
  for (const action of [
    { type: 'workflow', workflow: wf, node: 'out' },
    { type: 'workflow', workflow: seedWorkflow(admin.id, { published: false }), node: 'entry' },
    { type: 'workflow', workflow: 'no-such-workflow', node: 'entry' },
  ]) {
    const bad = await api('POST', '/api/triggers', { source: 'event', name: 'bad', config: { event: 'task_done' }, actions: [action] });
    assert.equal(bad.status, 400, JSON.stringify(action));
  }
});

test('another account\'s workflow is refused like an unknown one, and never bound', async (t) => {
  t.after(registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false })));
  const adminWf = seedWorkflow(admin.id);
  const refused = await api('POST', '/api/triggers', {
    source: 'event', name: 'steal', config: { event: 'task_done' }, actions: [{ type: 'workflow', workflow: adminWf, node: 'entry' }],
  }, 'bob');
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, `unknown workflow: ${adminWf}`);
  const own = await api('POST', '/api/triggers', {
    source: 'event', name: 'own', config: { event: 'task_done' }, actions: [{ type: 'workflow', workflow: seedWorkflow(bob.id), node: 'entry' }],
  }, 'bob');
  assert.equal(own.status, 201);

  // A row smuggled past the API: refused at run time, ignored by the binding view.
  const row = insertTrigger({
    name: 'smuggled', slug: null, source: 'schedule', enabled: true, config: { cron: '* * * * *' }, filter: null,
    actions: [{ type: 'workflow', workflow: adminWf, node: 'entry' }],
    secret: null, ownerUserId: bob.id, createdBy: 'agent', creatorAgent: 'helper', actingAgent: null, grants: ['workflows:run'], nextRunAt: 0,
  });
  tickSchedules(Date.now());
  assert.equal(listDeliveries(row.id)[0]?.status, 'error');
  assert.equal(runsOf(adminWf).length, 0);
  assert.deepEqual(nativeBindings(adminWf), []);
});

test('a run skipped by the workflow\'s overlap policy is not a failure the sender retries', async (t) => {
  t.after(registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false })));
  const wf = seedWorkflow(admin.id, { settings: { overlap: 'skip' } });
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'busy', slug: 'busy-workflow', config: { auth: 'generic' }, actions: [{ type: 'workflow', workflow: wf, node: 'entry' }],
  });
  const secret = String(created.body.secret);
  const first = await hook('busy-workflow', secret, { n: 1 });
  await settle();
  dbApi.updateWorkflowRun(String((first.body.results as Json[])[0]!.id), { status: 'running' });
  const second = await hook('busy-workflow', secret, { n: 2 });
  assert.equal(second.status, 200);
  assert.deepEqual(second.body, { status: 'received', results: [{ type: 'workflow', id: null }] });
  assert.equal(runsOf(wf).length, 1);
});

test('an event trigger never feeds on the missions of the workflow it started', async (t) => {
  t.after(registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false })));
  // `queue` would pile a run per completed mission if the guard missed it.
  const wf = seedWorkflow(admin.id, { settings: { overlap: 'queue' } });
  const created = await api('POST', '/api/triggers', {
    source: 'event', name: 'loop', config: { event: 'mission_complete' }, actions: [{ type: 'workflow', workflow: wf, node: 'entry' }],
  });
  assert.equal(created.status, 201);
  const dispatch = createEventDispatcher();
  const outside = randomUUID();
  dbApi.createMission(outside, 'helper', 'unrelated', undefined, admin.id);
  dispatch({ kind: 'mission_complete', missionId: outside, status: 'done', exitCode: 0 });
  assert.equal(runsOf(wf).length, 1);
  const runId = runsOf(wf)[0]!.id;
  const inside = randomUUID();
  dbApi.createMission(inside, 'wf.agent', 'node', undefined, admin.id, runId, { runId, nodeId: 'out' });
  dispatch({ kind: 'mission_complete', missionId: inside, status: 'done', exitCode: 0 });
  assert.equal(runsOf(wf).length, 1);
});

test('façade nodes: a schedule node is a native schedule, a webhook node a signed native route, a removed node leaves', async (t) => {
  const unregister = registerActionProvider('workflow', createWorkflowActionProvider({ supervised: false }));
  t.after(unregister);
  // `generic` because the test signer is generic; the default scheme is `standard`.
  const hooked = seedWorkflow(admin.id, { entry: { id: 'entry', type: 'trigger.webhook', config: { auth: 'generic' } } });
  armWorkflowTriggers(hooked);
  const [facade] = workflowNodeTriggers(hooked);
  assert.equal(facade?.source, 'webhook');
  assert.equal(facade?.url, `/api/triggers/hooks/${facade?.slug}`);
  assert.equal(facade?.has_secret, true);
  // The secret is shown once, by the native route, never stored in the workflow.
  const rotated = await api('POST', `/api/triggers/${facade!.trigger_id}/secret`, {});
  assert.equal(rotated.status, 200);
  const delivered = await hook(facade!.slug!, String(rotated.body.secret), { value: 1 });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  await settle();
  assert.equal(runsOf(hooked).length, 1);
  assert.deepEqual(JSON.parse(runsOf(hooked)[0]!.input ?? '{}'), { value: 1 });
  // A trigger made from the Triggers page is listed with the node but is not a façade.
  const bound = await api('POST', '/api/triggers', {
    source: 'event', name: 'bound hook', config: { event: 'task_done' }, actions: [{ type: 'workflow', workflow: hooked, node: 'entry' }],
  });
  assert.equal(bound.status, 201);
  assert.equal(nativeBindings(hooked).length, 2);
  assert.equal(workflowNodeTriggers(hooked).length, 1);

  const cron = seedWorkflow(admin.id, { entry: { id: 'entry', type: 'trigger.schedule', config: { cron: '* * * * *' } } });
  armWorkflowTriggers(cron);
  const [schedule] = workflowNodeTriggers(cron);
  assert.equal(schedule?.source, 'schedule');
  assert.ok((schedule?.next_run_at ?? 0) > 0, 'armed with a next run');
  db.prepare('UPDATE triggers SET next_run_at=0 WHERE id=?').run(schedule!.trigger_id);
  tickSchedules(1);
  await settle();
  assert.equal(runsOf(cron).length, 1);
  assert.ok((workflowNodeTriggers(cron)[0]?.next_run_at ?? 0) > 1, 'the occurrence is claimed');

  // Republished without the node: its native trigger goes with it; the user's own stays.
  const version = JSON.parse(dbApi.getWorkflowVersion(hooked, 1)!.definition) as { nodes: Array<{ id: string; type: string; config: unknown }> };
  version.nodes[0] = { id: 'entry', type: 'trigger.manual', config: {} };
  dbApi.insertWorkflowVersion({ workflow_id: hooked, version: 2, definition: JSON.stringify(version), published_at: Date.now(), published_by: null });
  db.prepare('UPDATE workflows SET published_version=2 WHERE id=?').run(hooked);
  armWorkflowTriggers(hooked);
  assert.equal(workflowNodeTriggers(hooked).length, 0);
  assert.equal(nativeBindings(hooked).length, 1);
  assert.equal(nativeBindings(hooked)[0]?.name, 'bound hook');
});
