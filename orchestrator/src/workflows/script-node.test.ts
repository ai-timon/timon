/**
 * TODO #685: a workflow `script` node runs a program on the host, so it is
 * held to the rule of a trigger's script action — the owner's `scripts:run`,
 * at publish and at every run, and never an agent's authorship.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { createRun, reconcile } = await import('./engine.js');
const { describeWorkflowError } = await import('./schema.js');
const { proposeWorkflow } = await import('./proposals.js');
const { assertScriptNodesAllowed, changedScriptNodes, pinWorkflowScripts, scriptNodeDenied } = await import('./nodes/script.js');
const { registerRoutes } = await import('../plugins-bundled/workflows/routes.js');

function account(name: string, permissions: string[], superadmin = false) {
  const user = createTestAccount(dbApi, { email: `${name}-${randomUUID()}@example.test`, name, passwordHash: 'unused', isSuperadmin: superadmin });
  grantTestPermissions(dbApi, user.id, permissions);
  return dbApi.getUserById(user.id)!;
}
const plain = account('plain', ['missions:read']);
const scripter = account('scripter', ['scripts:run']);
const admin = account('admin', [], true);

const PILOT = 'script-node-pilot';
mkdirSync(agentDir(PILOT), { recursive: true });
const markers = mkdtempSync(join(tmpdir(), 'timon-script-node-'));

/** A script node whose only effect is to leave a file behind: proof a process ran. */
function scriptNode(id: string, marker: string) {
  return { id, type: 'script', position: { x: 0, y: 0 }, config: { bin: process.execPath, args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`] } };
}
function definition(nodes: Array<Record<string, unknown>>) {
  return {
    schemaVersion: 1,
    nodes: [{ id: 'manual', type: 'trigger.manual', config: {} }, ...nodes],
    edges: nodes.map((node) => ({ id: `e-${String(node.id)}`, from: 'manual', fromPort: 'out', to: String(node.id), toPort: 'in' })),
    variables: [], settings: {},
  };
}
function seed(owner: string | null, draft: unknown, published?: unknown) {
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `script-${id.slice(0, 8)}`, name: 'Script witness', description: null, project: null, owner_user_id: owner, draft: JSON.stringify(draft), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  if (published) dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(published), published_at: now, published_by: null });
  // As a person's save and publish do: what its script nodes run is approved.
  const nodesOf = (def: unknown) => (def as { nodes: Array<{ id: string; type: string; config: Record<string, unknown> }> }).nodes;
  pinWorkflowScripts(dbApi.getWorkflow(id)!, { loose: nodesOf(draft), strict: published ? nodesOf(published) : [] });
  return id;
}

async function settle(runId: string) {
  const deadline = performance.now() + 10_000;
  for (;;) {
    const row = dbApi.getWorkflowRun(runId)!;
    if (!['pending', 'running', 'waiting'].includes(row.status)) {
      return { run: row, node: dbApi.listWorkflowRunNodes(runId).find((item) => item.node_id === 'job')! };
    }
    assert.ok(performance.now() < deadline, `run did not settle (status: ${row.status})`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const missionOf = (user: typeof plain) => { const id = randomUUID(); dbApi.createMission(id, PILOT, 'script node witness', undefined, user.id); return id; };
const adminMission = missionOf(admin);
const IDENTITIES: Record<string, RequestAuth> = {
  plain: { kind: 'session', user: plain, isSuperadmin: false },
  scripter: { kind: 'session', user: scripter, isSuperadmin: false },
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  // A developer-owner mission carries every permission: the refusal must not rest on grants.
  agent: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: adminMission },
};
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.auth = IDENTITIES[req.header('x-test-as') ?? 'admin']; next(); });
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, as: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'x-test-as': as, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { error?: string; issues?: Array<{ nodeId?: string }>; version?: number } };
}

test('the owner must hold scripts:run; the operator and an open install pass, a plugin or a stranger does not', () => {
  assert.match(scriptNodeDenied(plain.id) ?? '', /needs scripts:run/);
  assert.equal(scriptNodeDenied(scripter.id), null);
  assert.equal(scriptNodeDenied(admin.id), null);
  assert.equal(scriptNodeDenied(null), null);
  assert.equal(scriptNodeDenied('daemon-token'), null);
  assert.match(scriptNodeDenied('plugin:acme') ?? '', /plugin cannot own/);
  assert.match(scriptNodeDenied('system') ?? '', /not an active account/);
  assert.match(scriptNodeDenied(randomUUID()) ?? '', /not an active account/);

  const nodes = [scriptNode('job', join(markers, 'unused'))];
  let refusal: unknown;
  try { assertScriptNodesAllowed(nodes, plain.id); } catch (error) { refusal = error; }
  const described = describeWorkflowError(refusal);
  assert.equal(described.issues?.[0]?.nodeId, 'job');
  assert.match(described.error, /needs scripts:run/);
  assert.doesNotThrow(() => assertScriptNodesAllowed(nodes, scripter.id));
  assert.doesNotThrow(() => assertScriptNodesAllowed([], plain.id), 'no script node, nothing to hold');
});

test('a changed script node is told apart from one kept as it was, key order aside', () => {
  const kept = { id: 'job', type: 'script', config: { bin: 'a', args: ['x'] } };
  assert.deepEqual(changedScriptNodes([kept], [{ id: 'job', type: 'script', config: { args: ['x'], bin: 'a' } }]), []);
  assert.deepEqual(changedScriptNodes([kept], [{ ...kept, config: { bin: 'b', args: ['x'] } }]), ['job']);
  assert.deepEqual(changedScriptNodes([kept], null), ['job']);
  assert.deepEqual(changedScriptNodes([{ id: 'n', type: 'notify', config: {} }], []), []);
});

test('a run of an owner without scripts:run fails the node and starts no process', async () => {
  const refusedMarker = join(markers, 'refused');
  const def = definition([scriptNode('job', refusedMarker)]);
  const refused = await settle(createRun(seed(plain.id, def, def), { trigger: { kind: 'manual' } }).id);
  assert.equal(refused.run.status, 'failed');
  assert.match(refused.node.error ?? '', /needs scripts:run/);
  assert.equal(existsSync(refusedMarker), false, 'the program never ran');

  // A grant revoked after publish stops the next run as well.
  const revoked = account('revoked', ['scripts:run']);
  const revokedMarker = join(markers, 'revoked');
  const revokedDef = definition([scriptNode('job', revokedMarker)]);
  const workflow = seed(revoked.id, revokedDef, revokedDef);
  grantTestPermissions(dbApi, revoked.id, []);
  const afterRevoke = await settle(createRun(workflow, { trigger: { kind: 'manual' } }).id);
  assert.equal(afterRevoke.run.status, 'failed');
  assert.equal(existsSync(revokedMarker), false);

  // The witness: the same node runs for an owner who holds the right.
  const allowedMarker = join(markers, 'allowed');
  const allowedDef = definition([scriptNode('job', allowedMarker)]);
  const allowed = await settle(createRun(seed(scripter.id, allowedDef, allowedDef), { trigger: { kind: 'manual' } }).id);
  assert.equal(allowed.run.status, 'completed', allowed.node.error ?? '');
  assert.equal(existsSync(allowedMarker), true);
});

test('publish and an API run are refused to an owner without scripts:run, naming the node', async () => {
  const marker = join(markers, 'route-refused');
  const def = definition([scriptNode('job', marker)]);
  const workflow = seed(plain.id, def);
  const published = await call('POST', `/api/workflows/${workflow}/publish`, 'plain');
  assert.equal(published.status, 400);
  assert.match(published.body.error ?? '', /needs scripts:run/);
  assert.equal(published.body.issues?.[0]?.nodeId, 'job');
  assert.equal(dbApi.getWorkflow(workflow)!.published_version, null, 'no version was frozen');

  const draftRun = await call('POST', `/api/workflows/${workflow}/run`, 'plain', { draft: true });
  assert.equal(draftRun.status, 400);
  assert.match(draftRun.body.error ?? '', /needs scripts:run/);
  assert.equal(dbApi.listWorkflowRuns(workflow).length, 0, 'no run was created');
  assert.equal(existsSync(marker), false);

  // An owner who holds the right publishes the same definition.
  const mine = seed(scripter.id, def);
  const ok = await call('POST', `/api/workflows/${mine}/publish`, 'scripter');
  assert.equal(ok.status, 200, ok.body.error);
  assert.equal(ok.body.version, 1);
});

test('an agent cannot add, change, publish or run an unpublished script node, whatever its token holds', async () => {
  const marker = join(markers, 'agent');
  const withScript = definition([scriptNode('job', marker)]);
  const without = definition([{ id: 'note', type: 'notify', position: { x: 0, y: 0 }, config: { title: 't' } }]);

  const created = await call('POST', '/api/workflows', 'agent', { slug: `agent-${randomUUID().slice(0, 8)}`, name: 'agent', agent_name: PILOT, draft: withScript });
  assert.equal(created.status, 403);
  assert.match(created.body.error ?? '', /an agent cannot add, change.*\(job\)/);

  const workflow = seed(admin.id, without);
  const put = await call('PUT', `/api/workflows/${workflow}`, 'agent', { draft: withScript });
  assert.equal(put.status, 403);
  assert.match(put.body.error ?? '', /workflow_propose/);
  assert.doesNotMatch(dbApi.getWorkflow(workflow)!.draft, /"script"/, 'the draft was not written');

  // A person writes it; the agent can neither publish nor run that draft.
  dbApi.updateWorkflow(workflow, { draft: JSON.stringify(withScript) });
  assert.equal((await call('POST', `/api/workflows/${workflow}/publish`, 'agent')).status, 403);
  assert.equal(dbApi.getWorkflow(workflow)!.published_version, null);
  assert.equal((await call('POST', `/api/workflows/${workflow}/run`, 'agent', { draft: true })).status, 403);
  assert.equal(dbApi.listWorkflowRuns(workflow).length, 0);
  assert.equal(existsSync(marker), false);

  // Once a person published it, the agent may edit the rest and publish, the script untouched.
  assert.equal((await call('POST', `/api/workflows/${workflow}/publish`, 'admin')).status, 200);
  const edited = { ...withScript, nodes: withScript.nodes.map((node) => node.id === 'job' ? { ...node, position: { x: 400, y: 120 }, label: 'Moved' } : node) };
  const keep = await call('PUT', `/api/workflows/${workflow}`, 'agent', { draft: edited });
  assert.equal(keep.status, 200, keep.body.error);
  assert.equal((await call('POST', `/api/workflows/${workflow}/publish`, 'agent')).status, 200);
  const changed = { ...edited, nodes: edited.nodes.map((node) => node.id === 'job' ? { ...node, config: { bin: 'sh', args: ['-c', 'id'] } } : node) };
  assert.equal((await call('PUT', `/api/workflows/${workflow}`, 'agent', { draft: changed })).status, 403);

  // A pipeline imports as a script node: refused before the pipeline is even looked up.
  const imported = await call('POST', '/api/workflows/import/pipeline/any', 'agent', { agent_name: PILOT });
  assert.equal(imported.status, 403);
  assert.match(imported.body.error ?? '', /pipeline imports as a script node/);
});

test('an agent may propose a script node; only a person accepts it', async () => {
  const workflow = seed(admin.id, definition([{ id: 'note', type: 'notify', position: { x: 0, y: 0 }, config: { title: 't' } }]));
  const proposal = proposeWorkflow(workflow, adminMission, definition([scriptNode('job', join(markers, 'proposal'))]), 'add a script');
  const byAgent = await call('POST', `/api/workflows/${workflow}/proposals/${proposal.id}/accept`, 'agent');
  assert.equal(byAgent.status, 403);
  assert.doesNotMatch(dbApi.getWorkflow(workflow)!.draft, /"script"/);
  const byPerson = await call('POST', `/api/workflows/${workflow}/proposals/${proposal.id}/accept`, 'admin');
  assert.equal(byPerson.status, 200, byPerson.body.error);
  assert.match(dbApi.getWorkflow(workflow)!.draft, /"script"/);
});

test('reconciliation waits for a running script and records its result once', async () => {
  const dir = mkdtempSync(join(markers, 'running-'));
  const ready = join(dir, 'starts');
  const release = join(dir, 'release');
  const job = scriptNode('job', ready);
  const program = [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.argv[1], 'started\\n');",
    "const timer = setInterval(() => {",
    "  if (fs.existsSync(process.argv[2])) { clearInterval(timer); console.log(JSON.stringify({ ok: true })); }",
    "}, 20);",
  ].join('\n');
  job.config.args = ['-e', program, ready, release];
  const def = definition([job]);
  const id = createRun(seed(scripter.id, def, def), { trigger: { kind: 'manual' } }).id;
  try {
    const deadline = performance.now() + 8_000;
    while (!existsSync(ready)) {
      assert.ok(performance.now() < deadline, 'script did not start');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await reconcile();
    await reconcile();
    const rows = dbApi.listWorkflowRunNodes(id).filter((row) => row.node_id === 'job');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.status, 'running');
  } finally {
    writeFileSync(release, 'done');
  }
  const { run, node } = await settle(id);
  assert.equal(run.status, 'completed');
  assert.deepEqual(JSON.parse(node.output!), { ok: true });
  assert.equal(readFileSync(ready, 'utf8'), 'started\n');
});
