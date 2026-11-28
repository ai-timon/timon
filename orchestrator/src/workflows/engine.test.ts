import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-workflows-test-'));
const { db, dbApi } = await import('../db.js');
const { advance, cancelRun, completeWorkflowNode, completeWorkflowTurn, createRun, failWorkflowMission, reconcile } = await import('./engine.js');
const { evaluateExpr } = await import('./expr.js');
const { interpolateTemplate } = await import('./template.js');
const { parseWorkflowDefinition, parseWorkflowDraft } = await import('./schema.js');
const { parseAgentOutput } = await import('./nodes/agent.js');

const definition = { schemaVersion: 1 as const, nodes: [
  { id: 'start', type: 'trigger.manual', config: {} }, { id: 'when', type: 'condition', config: { expr: 'input.ok == true' } },
  { id: 'fan', type: 'parallel', config: {} }, { id: 'notice', type: 'notify', config: { title: 'done', body: '{{input.name}}' } },
  { id: 'join', type: 'join', config: { mode: 'all' } }, { id: 'result', type: 'output', config: { template: '{{input.name}}' } },
], edges: [
  { id: 'a', from: 'start', fromPort: 'out', to: 'when', toPort: 'in' }, { id: 'b', from: 'when', fromPort: 'true', to: 'fan', toPort: 'in' },
  { id: 'c', from: 'fan', fromPort: 'out', to: 'notice', toPort: 'in' }, { id: 'd', from: 'fan', fromPort: 'out', to: 'join', toPort: 'in' },
  { id: 'e', from: 'notice', fromPort: 'out', to: 'join', toPort: 'in' }, { id: 'f', from: 'join', fromPort: 'out', to: 'result', toPort: 'in' },
], variables: [], settings: { maxParallel: 3, onError: 'fail' as const } };

function seed(def: object = definition) { const id = randomUUID(); const now = Date.now(); dbApi.insertWorkflow({ id, slug: `wf-${id.slice(0, 8)}`, name: 'Witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(def), published_version: null, enabled: 1, created_at: now, updated_at: now , agent_name: null}); dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(def), published_at: now, published_by: null }); return id; }

test('template and expression use only the documented pointed paths and grammar', () => {
  const context = { input: { name: 'Ada', n: 2 }, vars: { enabled: true }, nodes: {} };
  assert.equal(interpolateTemplate('Hi {{input.name}}', context), 'Hi Ada');
  assert.equal(evaluateExpr('input.n >= 2 and vars.enabled', context), true);
  assert.throws(() => evaluateExpr('input.n + 1', context));
});

test('definition rejects cycles and undeclared ports', () => {
  const base = { schemaVersion: 1 as const, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'output', config: { template: 'x' } }], variables: [], settings: {} };
  assert.throws(() => parseWorkflowDefinition({ ...base, edges: [{ id: 'bad', from: 'a', fromPort: 'missing', to: 'b', toPort: 'in' }] }));
  assert.throws(() => parseWorkflowDefinition({ ...base, edges: [{ id: 'one', from: 'a', fromPort: 'out', to: 'b', toPort: 'in' }, { id: 'two', from: 'b', fromPort: 'out', to: 'a', toPort: 'in' }] }));
});

test('a draft accepts the empty configs of freshly dropped nodes, publish still refuses them', () => {
  // What the builder writes when a `skill` node is dropped on the canvas.
  const draft = { schemaVersion: 1 as const, nodes: [
    { id: 'skill-1', type: 'skill', config: { skillId: '', input: '', completion: 'turn', retries: 0 } },
    { id: 'agent-1', type: 'agent', config: { input: '', completion: 'turn', retries: 0 } },
  ], edges: [], variables: [], settings: {} };
  assert.equal(parseWorkflowDraft(draft).nodes.length, 2);
  assert.throws(() => parseWorkflowDefinition(draft));
  // A draft still refuses what cannot be repaired later: unknown types,
  // duplicate ids, and edges hanging off nothing.
  assert.throws(() => parseWorkflowDraft({ ...draft, nodes: [{ id: 'x', type: 'nope', config: {} }] }));
  assert.throws(() => parseWorkflowDraft({ ...draft, edges: [{ id: 'e', from: 'skill-1', fromPort: 'done', to: 'ghost', toPort: 'in' }] }));
  // A lone trigger-less canvas is a legitimate work in progress.
  assert.equal(parseWorkflowDraft({ schemaVersion: 1, nodes: [], edges: [], variables: [], settings: {} }).nodes.length, 0);
});

test('an invalid config names the field that is wrong, not just the node', () => {
  const bad = { schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'skill-1', type: 'skill', config: { skillId: '' } }], edges: [], variables: [], settings: {} };
  assert.throws(() => parseWorkflowDefinition(bad), /invalid config for skill-1: .+/);
});

test('agent output selects a declared route and keeps its structured payload', () => {
  assert.deepEqual(parseAgentOutput({ result: 'plain result' }), { port: 'done', output: { text: 'plain result' } });
  assert.deepEqual(parseAgentOutput({ result: '```json timon:output\n{"route":"escalate","summary":"needs approval"}\n```' }), { port: 'escalate', output: { summary: 'needs approval' } });
});

test('agent outputSchema is intentionally refused until the restricted JSON-schema dialect is specified', () => {
  assert.throws(() => parseWorkflowDefinition({ schemaVersion: 1, nodes: [{ id: 'a', type: 'trigger.manual', config: {} }, { id: 'b', type: 'agent', config: { ref: 'witness', outputSchema: { type: 'object' } } }], edges: [], variables: [], settings: {} }));
});

test('advance is idempotent and completes an in-process graph', async () => {
  const run = createRun(seed(), { trigger: { kind: 'manual' }, input: { ok: true, name: 'Ada' } });
  await advance(run.id); await advance(run.id);
  const saved = dbApi.getWorkflowRun(run.id)!;
  assert.equal(saved.status, 'completed');
  assert.equal(dbApi.listWorkflowRunNodes(run.id).filter((node) => node.node_id === 'notice').length, 1);
  assert.equal(JSON.parse(saved.context).output, 'Ada');
});

test('a run reads the output of a node whose builder id carries a dash', async () => {
  // `newNodeId` names nodes `condition-1`, `output-1`: templates and edge conditions must reach them.
  const def = { schemaVersion: 1 as const, nodes: [
    { id: 'manual-1', type: 'trigger.manual', config: {} }, { id: 'condition-1', type: 'condition', config: { expr: 'input.ok == true' } },
    { id: 'output-1', type: 'output', config: { template: 'port={{nodes.condition-1.taken_port}}' } },
  ], edges: [
    { id: 'a', from: 'manual-1', fromPort: 'out', to: 'condition-1', toPort: 'in' },
    { id: 'b', from: 'condition-1', fromPort: 'true', to: 'output-1', toPort: 'in', condition: "nodes.condition-1.status == 'ok'" },
  ], variables: [], settings: { maxParallel: 3, onError: 'fail' as const } };
  const run = createRun(seed(def), { trigger: { kind: 'manual' }, input: { ok: true } });
  await advance(run.id);
  const saved = dbApi.getWorkflowRun(run.id)!;
  assert.equal(saved.status, 'completed');
  assert.equal(JSON.parse(saved.context).output, 'port=true');
});

test('reconcile terminates a stranded running node explicitly', async () => {
  const run = createRun(seed(), { trigger: { kind: 'manual' }, input: { ok: true, name: 'Ada' } });
  dbApi.updateWorkflowRunNode(run.id, 'start', { status: 'running', started_at: Date.now() });
  await reconcile();
  assert.notEqual(dbApi.getWorkflowRun(run.id)?.status, 'running');
});

function agentRun(definition: typeof definition, activeNode: string) {
  const workflowId = seed();
  const now = Date.now();
  dbApi.insertWorkflowVersion({ workflow_id: workflowId, version: 2, definition: JSON.stringify(definition), published_at: now, published_by: null });
  const runId = randomUUID(); const missionId = randomUUID();
  dbApi.insertWorkflowRun({ id: runId, workflow_id: workflowId, version: 2, status: 'running', trigger: '{}', input: '{}', context: JSON.stringify({ input: {}, vars: {}, trigger: {}, nodes: {}, run: { id: runId, started_at: now } }), error: null, started_at: now, ended_at: null, owner_user_id: null, tokens_in: null, tokens_out: null, cost_usd: null });
  for (const node of definition.nodes) dbApi.insertWorkflowRunNode({ run_id: runId, node_id: node.id, attempt: 1, status: node.id === activeNode ? 'running' : 'pending', mission_id: node.id === activeNode ? missionId : null, input: null, output: null, error: null, taken_port: null, started_at: node.id === activeNode ? now : null, ended_at: null, tokens_in: null, tokens_out: null });
  dbApi.createMission(missionId, 'workflow.witness', 'workflow turn', { channel: 'workflow' }, null, runId, { runId, nodeId: activeNode });
  return { runId, missionId };
}

test('only the current workflow attempt can report a result before or after its mission is bound', async () => {
  const graph = { schemaVersion: 1 as const, nodes: [
    { id: 'a', type: 'agent', config: { ref: 'witness' } },
    { id: 'out', type: 'output', config: { template: '{{nodes.a.output.text}}' } },
  ], edges: [{ id: 'edge', from: 'a', fromPort: 'done', to: 'out', toPort: 'in' }],
  variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };
  const { runId, missionId: previous } = agentRun(graph, 'a');
  dbApi.updateWorkflowRunNode(runId, 'a', { status: 'ok', ended_at: Date.now() });
  const first = dbApi.listWorkflowRunNodes(runId).find((row) => row.node_id === 'a')!;
  dbApi.insertWorkflowRunNode({ ...first, attempt: 2, status: 'running', mission_id: null, ended_at: null });
  const current = randomUUID();
  dbApi.createMission(current, 'workflow.witness', 'current turn', { channel: 'workflow', meta: {
    workflow_run_id: runId, workflow_node_id: 'a', workflow_node_attempt: 2,
  } }, null, runId, { runId, nodeId: 'a' });

  failWorkflowMission(previous, 'late exit');
  completeWorkflowTurn(previous, { result: 'late result' });
  const second = () => dbApi.listWorkflowRunNodes(runId).find((row) => row.node_id === 'a' && row.attempt === 2)!;
  assert.equal(second().status, 'running');
  assert.equal(second().mission_id, null);

  completeWorkflowTurn(current, { result: 'current result' });
  failWorkflowMission(previous, 'late exit after binding');
  await advance(runId);
  assert.equal(second().mission_id, current);
  assert.equal(second().status, 'ok');
  assert.deepEqual(JSON.parse(second().output!), { text: 'current result' });
  assert.equal(dbApi.getWorkflowRun(runId)?.status, 'completed');
});

test('a turn result routes structured output to the selected branch', async () => {
  const routed = { schemaVersion: 1 as const, nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'a', type: 'agent', config: { ref: 'witness', routes: ['escalate'] } },
    { id: 'done', type: 'output', config: { template: 'wrong' } },
    { id: 'escalated', type: 'output', config: { template: '{{nodes.a.output.summary}}' } },
  ], edges: [
    { id: 'done-edge', from: 'a', fromPort: 'done', to: 'done', toPort: 'in' },
    { id: 'escalate-edge', from: 'a', fromPort: 'escalate', to: 'escalated', toPort: 'in' },
  ], variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };
  const { runId, missionId } = agentRun(routed, 'a');
  completeWorkflowTurn(missionId, { result: '```json timon:output\n{"route":"escalate","summary":"review required"}\n```' });
  await advance(runId);
  const nodes = dbApi.listWorkflowRunNodes(runId);
  // The branch the agent did not take is skipped, so the run completes.
  assert.equal(nodes.find((node) => node.node_id === 'done')?.status, 'skipped');
  assert.equal(nodes.find((node) => node.node_id === 'escalated')?.output, JSON.stringify('review required'));
  assert.equal(dbApi.getWorkflowRun(runId)?.status, 'completed');
});

test('a false condition skips its true branch and everything only it feeds, and the run completes', async () => {
  const run = createRun(seed(), { trigger: { kind: 'manual' }, input: { ok: false, name: 'Ada' } });
  await advance(run.id);
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
  const status = Object.fromEntries(dbApi.listWorkflowRunNodes(run.id).map((node) => [node.node_id, node.status]));
  assert.deepEqual(status, { start: 'ok', when: 'ok', fan: 'skipped', notice: 'skipped', join: 'skipped', result: 'skipped' });
});

test('a join in any mode still runs when one of its branches is skipped', async () => {
  const any = { schemaVersion: 1 as const, nodes: [
    { id: 'start', type: 'trigger.manual', config: {} }, { id: 'when', type: 'condition', config: { expr: 'input.ok == true' } },
    { id: 'yes', type: 'parallel', config: {} }, { id: 'no', type: 'parallel', config: {} },
    { id: 'join', type: 'join', config: { mode: 'any' } }, { id: 'result', type: 'output', config: { template: 'joined' } },
  ], edges: [
    { id: 'a', from: 'start', fromPort: 'out', to: 'when', toPort: 'in' },
    { id: 'b', from: 'when', fromPort: 'true', to: 'yes', toPort: 'in' }, { id: 'c', from: 'when', fromPort: 'false', to: 'no', toPort: 'in' },
    { id: 'd', from: 'yes', fromPort: 'out', to: 'join', toPort: 'in' }, { id: 'e', from: 'no', fromPort: 'out', to: 'join', toPort: 'in' },
    { id: 'f', from: 'join', fromPort: 'out', to: 'result', toPort: 'in' },
  ], variables: [], settings: { maxParallel: 3, onError: 'fail' as const } };
  const id = seed();
  dbApi.updateWorkflow(id, { draft: JSON.stringify(any) });
  const run = createRun(id, { trigger: { kind: 'manual' }, input: { ok: false }, draft: true });
  for (let i = 0; i < 5 && dbApi.getWorkflowRun(run.id)?.status === 'running'; i += 1) await advance(run.id);
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
  const status = Object.fromEntries(dbApi.listWorkflowRunNodes(run.id).map((node) => [node.node_id, node.status]));
  assert.equal(status.yes, 'skipped');
  assert.equal(status.join, 'ok');
  assert.equal(status.result, 'ok');
});

test('explicit completion and timeout both take their documented terminal ports', async () => {
  const explicit = { schemaVersion: 1 as const, nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'a', type: 'agent', config: { ref: 'witness', completion: 'explicit' } }, { id: 'out', type: 'output', config: { template: '{{nodes.a.output.text}}' } }], edges: [{ id: 'edge', from: 'a', fromPort: 'done', to: 'out', toPort: 'in' }], variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };
  const first = agentRun(explicit, 'a');
  assert.equal(completeWorkflowNode(first.runId, 'a', { text: 'closed explicitly' }), true);
  await advance(first.runId);
  assert.equal(dbApi.listWorkflowRunNodes(first.runId).find((node) => node.node_id === 'out')?.output, JSON.stringify('closed explicitly'));

  const timeout = { schemaVersion: 1 as const, nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'a', type: 'agent', config: { ref: 'witness', timeoutMs: 1 } }, { id: 'failed', type: 'output', config: { template: 'failed branch' } }], edges: [{ id: 'edge', from: 'a', fromPort: 'failed', to: 'failed', toPort: 'in' }], variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };
  const second = agentRun(timeout, 'a');
  dbApi.updateWorkflowRunNode(second.runId, 'a', { started_at: Date.now() - 10 });
  await reconcile();
  await advance(second.runId);
  assert.equal(dbApi.listWorkflowRunNodes(second.runId).find((node) => node.node_id === 'failed')?.status, 'ok');
});

test('cancelling a run terminates its active workflow mission', () => {
  const active = { schemaVersion: 1 as const, nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'a', type: 'agent', config: { ref: 'witness' } }], edges: [], variables: [], settings: { maxParallel: 1, onError: 'fail' as const } };
  const { runId, missionId } = agentRun(active, 'a');
  assert.equal(cancelRun(runId), true);
  assert.equal(dbApi.getWorkflowRun(runId)?.status, 'cancelled');
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
});

function notifyWorkflow(ownerUserId: string | null, config: Record<string, unknown>) {
  const id = randomUUID(); const now = Date.now();
  const graph = { schemaVersion: 1 as const, nodes: [{ id: 'start', type: 'trigger.manual', config: {} }, { id: 'ping', type: 'notify', config }], edges: [{ id: 'a', from: 'start', fromPort: 'out', to: 'ping', toPort: 'in' }], variables: [], settings: {} };
  const slug = `notify-${id.slice(0, 8)}`;
  dbApi.insertWorkflow({ id, slug, name: 'Notify witness', description: null, project: null, owner_user_id: ownerUserId, draft: JSON.stringify(graph), published_version: 1, enabled: 1, created_at: now, updated_at: now, agent_name: null });
  dbApi.insertWorkflowVersion({ workflow_id: id, version: 1, definition: JSON.stringify(graph), published_at: now, published_by: null });
  return { id, slug };
}

test('a notify node writes a notification its run owner sees, with the configured level', async () => {
  // Raw rows: the licence guard of createUser is not what this test is about.
  const account = (name: string) => { const userId = randomUUID(); db.prepare('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(userId, `${userId}@example.test`, name, 'x', Date.now()); return { id: userId }; };
  const owner = account('Owner'); const other = account('Other');
  const { id, slug } = notifyWorkflow(owner.id, { type: 'alert', title: 'Hello {{input.name}}', body: 'it works' });
  const run = createRun(id, { trigger: { kind: 'manual' }, input: { name: 'Ada' } });
  await advance(run.id);
  const node = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'ping')!;
  assert.equal(node.status, 'ok');
  const { notification_id: notificationId } = JSON.parse(node.output!) as { notification_id: string };
  const card = dbApi.getNotification(notificationId, { id: owner.id, isSuperadmin: false })!;
  assert.equal(card.type, 'alert');
  assert.equal(card.title, 'Hello Ada');
  assert.equal(card.owner_user_id, owner.id);
  assert.equal(card.source, `workflow:${slug}`);
  assert.equal(card.anchor, `/workflows/${slug}/runs/${run.id}`);
  assert.equal(dbApi.getNotification(notificationId, { id: other.id, isSuperadmin: false }), undefined, 'another account does not see it');
});

test('a notify node fails when no notification could be written', async () => {
  const { setActiveModules, resetActiveModules } = await import('../kernel/module-state.js');
  setActiveModules([]);
  try {
    const { id } = notifyWorkflow(null, { title: 'unreachable' });
    const run = createRun(id, { trigger: { kind: 'manual' } });
    await advance(run.id);
    const node = dbApi.listWorkflowRunNodes(run.id).find((row) => row.node_id === 'ping')!;
    assert.equal(node.status, 'error');
    assert.match(node.error ?? '', /notifications are disabled/);
    assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'failed');
  } finally { resetActiveModules(); }
});

// A scheduled start, a five-minute pause, and a manual start beside it, both into a join in any mode.
const twoStarts = { schemaVersion: 1 as const, nodes: [
  { id: 'schedule', type: 'trigger.schedule', config: { cron: '0 9 * * *' } }, { id: 'pause', type: 'wait', config: { ms: 300_000 } },
  { id: 'manual', type: 'trigger.manual', config: {} },
  { id: 'join', type: 'join', config: { mode: 'any' } }, { id: 'result', type: 'output', config: { template: 'joined' } },
], edges: [
  { id: 'a', from: 'schedule', fromPort: 'out', to: 'pause', toPort: 'in' }, { id: 'b', from: 'pause', fromPort: 'out', to: 'join', toPort: 'in' },
  { id: 'c', from: 'manual', fromPort: 'out', to: 'join', toPort: 'in' }, { id: 'd', from: 'join', fromPort: 'out', to: 'result', toPort: 'in' },
], variables: [], settings: { maxParallel: 3, onError: 'fail' as const } };

const nodeStatus = (runId: string) => Object.fromEntries(dbApi.listWorkflowRunNodes(runId).map((node) => [node.node_id, node.status]));
async function settle(runId: string) { for (let i = 0; i < 8 && dbApi.getWorkflowRun(runId)?.status === 'running'; i += 1) await advance(runId); }

test('a scheduled run leaves the manual trigger out and waits for its pause', async () => {
  const run = createRun(seed(twoStarts), { trigger: { kind: 'schedule', node_id: 'schedule' } });
  await settle(run.id);
  let status = nodeStatus(run.id);
  assert.equal(status.manual, 'skipped');
  assert.equal(status.schedule, 'ok');
  assert.equal(status.pause, 'waiting');
  assert.equal(status.join, 'pending');
  assert.notEqual(dbApi.getWorkflowRun(run.id)?.status, 'completed');
  // The pause is over: the join leaves only now.
  dbApi.updateWorkflowRunNode(run.id, 'pause', { output: JSON.stringify({ next_run_at: Date.now() - 1 }) });
  await advance(run.id); await settle(run.id);
  status = nodeStatus(run.id);
  assert.equal(status.pause, 'ok');
  assert.equal(status.join, 'ok');
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
});

test('a manual run leaves the scheduled trigger and its pause out and joins at once', async () => {
  // The shape the Run button and a draft test send: no node named.
  for (const draft of [false, true]) {
    const id = seed(twoStarts);
    if (draft) dbApi.updateWorkflow(id, { draft: JSON.stringify(twoStarts) });
    const run = createRun(id, { trigger: { kind: 'api' }, draft });
    await settle(run.id);
    const status = nodeStatus(run.id);
    assert.equal(status.manual, 'ok');
    assert.equal(status.schedule, 'skipped');
    assert.equal(status.pause, 'skipped');
    assert.equal(status.join, 'ok');
    assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
  }
});

test('a native trigger started from the manual node runs it alone', async () => {
  const run = createRun(seed(twoStarts), { trigger: { kind: 'cron', node_id: 'manual' } });
  await settle(run.id);
  const status = nodeStatus(run.id);
  assert.equal(status.manual, 'ok');
  assert.equal(status.schedule, 'skipped');
  assert.equal(status.join, 'ok');
  assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
});

test('a node fed by two triggers runs from whichever one started the run', async () => {
  const shared = { schemaVersion: 1 as const, nodes: [
    { id: 'schedule', type: 'trigger.schedule', config: { cron: '0 9 * * *' } }, { id: 'manual', type: 'trigger.manual', config: {} },
    { id: 'result', type: 'output', config: { template: 'ran' } },
  ], edges: [
    { id: 'a', from: 'schedule', fromPort: 'out', to: 'result', toPort: 'in' }, { id: 'b', from: 'manual', fromPort: 'out', to: 'result', toPort: 'in' },
  ], variables: [], settings: { maxParallel: 3, onError: 'fail' as const } };
  for (const trigger of [{ kind: 'schedule', node_id: 'schedule' }, { kind: 'api' }]) {
    const run = createRun(seed(shared), { trigger });
    await settle(run.id);
    assert.equal(nodeStatus(run.id).result, 'ok', JSON.stringify(trigger));
    assert.equal(dbApi.getWorkflowRun(run.id)?.status, 'completed');
  }
});
