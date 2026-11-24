/**
 * A workflow script node runs files from a folder missions write in: it runs
 * only the files a person approved by saving, publishing or re-approving the
 * workflow, the check a trigger's script action makes (`triggers/script-run.ts`).
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { db, dbApi } = await import('../db.js');
const { agentDir, TIMON_HOME } = await import('../paths.js');
const { createRun } = await import('./engine.js');
const { getWorkflowScriptPins } = await import('./nodes/script.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { registerRoutes } = await import('../plugins-bundled/workflows/routes.js');

const admin = createTestAccount(dbApi, { email: `pins-admin-${randomUUID()}@example.test`, name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: `pins-bob-${randomUUID()}@example.test`, name: 'Bob', passwordHash: 'x', isSuperadmin: false });
grantTestPermissions(dbApi, bob.id, ['missions:read']);
const PILOT = 'script-pins-pilot';
mkdirSync(agentDir(PILOT), { recursive: true });
const mission = randomUUID();
dbApi.createMission(mission, PILOT, 'script pins witness', undefined, admin.id);

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: dbApi.getUserById(admin.id)!, isSuperadmin: true },
  bob: { kind: 'session', user: dbApi.getUserById(bob.id)!, isSuperadmin: false },
  // Holds every permission: the refusal must not rest on grants.
  agent: { kind: 'api-token', user: dbApi.getUserById(admin.id)!, isSuperadmin: true, missionId: mission },
  'agent-scoped': { kind: 'api-token', user: dbApi.getUserById(admin.id)!, isSuperadmin: false, permissions: ['scripts:run', 'workflows:manage'], missionId: mission },
};
const DAEMON_TOKEN = 'daemon-test-token';
const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  // Anyone else meets the daemon's own check: the CLI's token passes, nothing else.
  createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: true })(req, res, next);
});
app.use(createBodyParser());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, as: string | null = 'admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON_TOKEN}`;
  else if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Json };
}

/** A workflow with no project runs in its own folder under the Timon home. */
const folderOf = (slug: string) => { const dir = join(TIMON_HOME, 'workflows', slug); mkdirSync(dir, { recursive: true }); return dir; };
/** A script that appends its version to `out.txt`: proof of which content ran. */
const job = (version: string) => `require('node:fs').appendFileSync('out.txt', ${JSON.stringify(`${version}\n`)})`;
function definition(args: string[] = ['job.js']) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} },
      { id: 'job', type: 'script', position: { x: 200, y: 0 }, config: { bin: process.execPath, args, timeoutMs: 10_000 } },
    ],
    edges: [{ id: 'e', from: 'manual', fromPort: 'out', to: 'job', toPort: 'in' }],
    variables: [], settings: {},
  };
}

async function settle(runId: string) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const run = dbApi.getWorkflowRun(runId)!;
    if (!['pending', 'running', 'waiting'].includes(run.status)) {
      return { run, node: dbApi.listWorkflowRunNodes(runId).find((row) => row.node_id === 'job')! };
    }
    assert.ok(performance.now() < deadline, `run did not settle (status: ${run.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const runOnce = (id: string) => settle(createRun(id, { trigger: { kind: 'manual' } }).id);
const alerts = (slug: string) => db.prepare(`SELECT type, title, body FROM notifications WHERE source = ? ORDER BY created_at`)
  .all(`workflow:${slug}`) as Array<{ type: string; title: string; body: string | null }>;
const ran = (slug: string) => { const file = join(folderOf(slug), 'out.txt'); return existsSync(file) ? readFileSync(file, 'utf8') : ''; };

/** Created and published by a person, through the routes. */
async function published(slug: string, content: string) {
  writeFileSync(join(folderOf(slug), 'job.js'), content);
  const created = await api('POST', '/api/workflows', { slug, name: slug, agent_name: PILOT, draft: definition() });
  assert.equal(created.status, 201, String(created.body.error));
  const id = String((created.body.workflow as Json).id);
  const publish = await api('POST', `/api/workflows/${id}/publish`);
  assert.equal(publish.status, 200, String(publish.body.error));
  return id;
}

test('a workflow saved before the check runs no script until a person approves it', async () => {
  const slug = `legacy-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(folderOf(slug), 'job.js'), job('legacy'));
  const id = randomUUID(); const now = Date.now(); const def = JSON.stringify(definition());
  dbApi.insertWorkflow({ id, slug, name: 'Legacy', description: null, project: null, owner_user_id: admin.id, draft: def, published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: def, published_at: now, published_by: null });

  const refused = await runOnce(id);
  assert.equal(refused.run.status, 'failed');
  assert.match(refused.node.error ?? '', new RegExp(`^script not approved: .*timon workflow approve-script ${slug}`));
  assert.equal(ran(slug), '', 'the program never ran');
  const [alert] = alerts(slug);
  assert.equal(alert?.type, 'alert');
  assert.match(alert?.title ?? '', /Script not run/);

  const approved = await api('POST', `/api/workflows/${id}/approve-script`);
  assert.equal(approved.status, 200, String(approved.body.error));
  assert.deepEqual((approved.body.approved as Json[])[0]!.files, ['job.js']);
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'legacy\n');
});

test('a file changed since the approval is refused, told once, and only a person approves it again', async () => {
  const slug = `changed-${randomUUID().slice(0, 8)}`;
  const id = await published(slug, job('v1'));
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'v1\n');

  writeFileSync(join(folderOf(slug), 'job.js'), job('v2'));
  const refused = await runOnce(id);
  assert.equal(refused.run.status, 'failed');
  assert.match(refused.node.error ?? '', /^script changed since it was approved \(job\.js\): /);
  assert.equal(ran(slug), 'v1\n', 'the rewritten file never ran');
  assert.equal(alerts(slug).length, 1);
  // The same refusal again: failed, not told twice.
  assert.equal((await runOnce(id)).run.status, 'failed');
  assert.equal(alerts(slug).length, 1);

  // A mission cannot vouch for it, whatever its token holds; nor an account without scripts:run, nor nobody.
  for (const as of ['agent', 'agent-scoped']) {
    const byAgent = await api('POST', `/api/workflows/${id}/approve-script`, undefined, as);
    assert.equal(byAgent.status, 403, as);
    assert.match(String(byAgent.body.error), /an agent cannot approve a script/);
  }
  assert.equal((await api('POST', `/api/workflows/${randomUUID()}/approve-script`, undefined, 'agent')).status, 403, 'refused before the lookup');
  assert.equal((await api('POST', `/api/workflows/${id}/approve-script`, undefined, 'bob')).status, 404, 'not visible to a stranger');
  assert.equal((await api('POST', `/api/workflows/${id}/approve-script`, undefined, null)).status, 401);
  // An agent may publish a workflow whose script it left untouched: that approves nothing.
  assert.equal((await api('POST', `/api/workflows/${id}/publish`, undefined, 'agent')).status, 200);
  assert.equal((await runOnce(id)).run.status, 'failed');
  assert.equal(ran(slug), 'v1\n');

  // The terminal (daemon token) approves the files as they are now.
  const approved = await api('POST', `/api/workflows/${id}/approve-script`, undefined, 'daemon');
  assert.equal(approved.status, 200, String(approved.body.error));
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'v1\nv2\n');
});

test('saving approves only a script node a person added or changed; publishing approves them all', async () => {
  const slug = `saved-${randomUUID().slice(0, 8)}`;
  const id = await published(slug, job('a'));
  writeFileSync(join(folderOf(slug), 'job.js'), job('b'));
  const withNodes = (edit: (node: ReturnType<typeof definition>['nodes'][number]) => object) => ({ ...definition(), nodes: definition().nodes.map(edit) });
  // A label next to the script, or the script moved: saved by an agent or a person, it approves nothing.
  const labelled = withNodes((node) => node.id === 'manual' ? { ...node, label: 'Start' } : node);
  const moved = withNodes((node) => node.id === 'job' ? { ...node, position: { x: 400, y: 80 } } : node);
  assert.equal((await api('PUT', `/api/workflows/${id}`, { draft: labelled }, 'agent')).status, 200);
  assert.match((await runOnce(id)).node.error ?? '', /changed since it was approved/);
  for (const draft of [labelled, moved]) {
    assert.equal((await api('PUT', `/api/workflows/${id}`, { draft })).status, 200);
    assert.match((await runOnce(id)).node.error ?? '', /changed since it was approved/);
  }
  assert.equal(ran(slug), '', 'the rewritten file never ran');

  // A person who changes the script node's own config approves its files as they are now.
  const slower = withNodes((node) => node.id === 'job' ? { ...node, config: { ...node.config, timeoutMs: 20_000 } } : node);
  assert.equal((await api('PUT', `/api/workflows/${id}`, { draft: slower })).status, 200);
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'b\n');

  // Publishing approves every script node of the draft.
  writeFileSync(join(folderOf(slug), 'job.js'), job('c'));
  const relabelled = withNodes((node) => node.id === 'job' ? { ...node, config: { ...node.config, timeoutMs: 20_000 } } : { ...node, label: 'Again' });
  assert.equal((await api('PUT', `/api/workflows/${id}`, { draft: relabelled })).status, 200);
  assert.equal((await runOnce(id)).run.status, 'failed');
  assert.equal((await api('POST', `/api/workflows/${id}/publish`)).status, 200);
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'b\nc\n');
});

test('accepting a proposal approves only the script nodes it adds or changes', async () => {
  const slug = `proposed-${randomUUID().slice(0, 8)}`;
  const id = await published(slug, job('p1'));
  writeFileSync(join(folderOf(slug), 'job.js'), job('p2'));
  const labelled = { ...definition(), nodes: definition().nodes.map((node) => node.id === 'manual' ? { ...node, label: 'Start' } : node) };
  const propose = async (draft: object) => {
    const proposed = await api('POST', `/api/workflows/${id}/proposals`, { definition: draft, rationale: 'edit' }, 'agent');
    assert.equal(proposed.status, 201, String(proposed.body.error));
    const pid = String((proposed.body.proposal as Json).id);
    assert.equal((await api('POST', `/api/workflows/${id}/proposals/${pid}/accept`)).status, 200);
  };
  await propose(labelled);
  assert.match((await runOnce(id)).node.error ?? '', /changed since it was approved/);
  await propose({ ...labelled, nodes: labelled.nodes.map((node) => node.id === 'job' ? { ...node, config: { ...node.config, timeoutMs: 20_000 } } : node) });
  assert.equal((await runOnce(id)).run.status, 'completed');
  assert.equal(ran(slug), 'p2\n');
});

test('a file that appears where none was approved, or a folder gone, is refused too', async () => {
  const slug = `absent-${randomUUID().slice(0, 8)}`;
  const id = await published(slug, job('x'));
  rmSync(join(folderOf(slug), 'job.js'));
  const gone = await runOnce(id);
  assert.match(gone.node.error ?? '', /changed since it was approved \(job\.js[,)]/);
  rmSync(folderOf(slug), { recursive: true, force: true });
  // The engine re-creates the workflow's own folder, empty: still not the approved files.
  assert.equal((await runOnce(id)).run.status, 'failed');
});

test('what cannot be fingerprinted cannot be published, naming the node; a workflow without a script has nothing to approve', async () => {
  const slug = `outside-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(TIMON_HOME, 'workflows', 'outside.js'), job('out'));
  folderOf(slug);
  const created = await api('POST', '/api/workflows', { slug, name: slug, agent_name: PILOT, draft: definition(['../outside.js']) });
  assert.equal(created.status, 201, 'a draft is work in progress: saved, left unapproved');
  const id = String((created.body.workflow as Json).id);
  const publish = await api('POST', `/api/workflows/${id}/publish`);
  assert.equal(publish.status, 400);
  assert.match(String(publish.body.error), /cannot be fingerprinted: \.\.\/outside\.js/);
  assert.equal((publish.body.issues as Array<{ nodeId?: string }>)[0]?.nodeId, 'job');
  assert.equal(dbApi.getWorkflow(id)!.published_version, null);
  assert.equal((await api('POST', `/api/workflows/${id}/approve-script`)).status, 400);
  assert.deepEqual(getWorkflowScriptPins(id), []);

  const plain = await api('POST', '/api/workflows', {
    slug: `plain-${randomUUID().slice(0, 8)}`, name: 'plain', agent_name: PILOT,
    draft: { schemaVersion: 1, nodes: [{ id: 'manual', type: 'trigger.manual', position: { x: 0, y: 0 }, config: {} }], edges: [], variables: [], settings: {} },
  });
  const plainId = String((plain.body.workflow as Json).id);
  const none = await api('POST', `/api/workflows/${plainId}/approve-script`);
  assert.equal(none.status, 400);
  assert.match(String(none.body.error), /runs no script/);
});

test('deleting a workflow drops its approvals', async () => {
  const slug = `deleted-${randomUUID().slice(0, 8)}`;
  const id = await published(slug, job('d'));
  assert.equal(getWorkflowScriptPins(id).length, 1);
  assert.equal((await api('DELETE', `/api/workflows/${id}`)).status, 200);
  assert.deepEqual(getWorkflowScriptPins(id), []);
});

test('approving is vouching that it may run: an owner without scripts:run cannot', async () => {
  const slug = `bob-${randomUUID().slice(0, 8)}`;
  writeFileSync(join(folderOf(slug), 'job.js'), job('bob'));
  const id = randomUUID(); const now = Date.now(); const def = JSON.stringify(definition());
  dbApi.insertWorkflow({ id, slug, name: 'Bob', description: null, project: null, owner_user_id: bob.id, draft: def, published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: def, published_at: now, published_by: null });
  const refused = await api('POST', `/api/workflows/${id}/approve-script`, undefined, 'bob');
  assert.equal(refused.status, 403);
  assert.match(String(refused.body.error), /needs scripts:run/);
  // The webview words it from the code and quotes the reason.
  assert.equal(refused.body.code, 'workflow_script_denied');
  assert.deepEqual(refused.body.params, { detail: refused.body.error });
  assert.deepEqual(getWorkflowScriptPins(id), []);
});
