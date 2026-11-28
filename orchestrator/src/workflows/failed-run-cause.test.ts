/**
 * A failed run said nothing: `workflow_runs.error` stayed empty, the cause
 * was only on the node row, and every reader had to walk the nodes to learn it.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';

const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { createRun } = await import('./engine.js');
const { pinWorkflowScripts } = await import('./nodes/script.js');

const user = createTestAccount(dbApi, { email: `failed-run-${randomUUID()}@example.test`, name: 'scripter', passwordHash: 'unused', isSuperadmin: false });
grantTestPermissions(dbApi, user.id, ['scripts:run']);

const PILOT = 'failed-run-cause-pilot';
mkdirSync(agentDir(PILOT), { recursive: true });

function seed(source: string) {
  const def = {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', config: {} },
      { id: 'job', type: 'script', position: { x: 0, y: 0 }, config: { bin: process.execPath, args: ['-e', source] } },
    ],
    edges: [{ id: 'e-job', from: 'manual', fromPort: 'out', to: 'job', toPort: 'in' }],
    variables: [], settings: {},
  };
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `failed-run-${id.slice(0, 8)}`, name: 'Failed run witness', description: null, project: null, owner_user_id: user.id, draft: JSON.stringify(def), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(def), published_at: now, published_by: null });
  pinWorkflowScripts(dbApi.getWorkflow(id)!, { loose: def.nodes as never, strict: def.nodes as never });
  return id;
}
const job = (runId: string) => dbApi.listWorkflowRunNodes(runId).find((row) => row.node_id === 'job')!;

async function settled(runId: string) {
  const deadline = performance.now() + 10_000;
  while (['pending', 'running', 'waiting'].includes(dbApi.getWorkflowRun(runId)!.status)) {
    assert.ok(performance.now() < deadline, 'timed out waiting for the run to settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a failed run carries the error of the node that failed it', async () => {
  const run = createRun(seed(`process.stderr.write('disk full'); process.exit(3)`), { trigger: { kind: 'manual' } });
  await settled(run.id);
  const after = dbApi.getWorkflowRun(run.id)!;
  assert.equal(after.status, 'failed');
  assert.match(job(run.id).error ?? '', /script failed \(code 3\): disk full/);
  assert.equal(after.error, `job: ${job(run.id).error}`);
});

test('a completed run carries no error', async () => {
  const run = createRun(seed(`process.stdout.write('{"done":true}')`), { trigger: { kind: 'manual' } });
  await settled(run.id);
  const after = dbApi.getWorkflowRun(run.id)!;
  assert.equal(after.status, 'completed', job(run.id).error ?? '');
  assert.equal(after.error, null);
});
