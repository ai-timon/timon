import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Dialect, NormalizedEvent } from '../backends/types.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-workflow-coordinator-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../../tests/helpers/witness-cli.js');
// Beside the Timon home, not in it: no binary is ever resolved from there.
const WITNESS_CLI = witnessCli(`${process.env.TIMON_HOME}-bin`);
const { dbApi, db } = await import('../db.js');
const { createBrowserProfile, resolveBrowserProfile } = await import('../browser-profiles.js');
const { bus } = await import('../bus.js');
const { patchAgentConfig, loadConfig, getTurnState, killAgent, upsertAgent, getAgent } = await import('../agent.js');
const { registerDialect, registerProfile } = await import('../backends/registry.js');
const { ensureWorkflowCoordinator, flushWorkflowReports, purgeLegacyWorkflowCoordinators, reportToWorkflowCoordinator } = await import('./coordinator.js');
const { startWorkflowRun, completeWorkflowTurn, advance } = await import('./engine.js');

const seen: Array<{ agent: string; mission: string; input: string; browserProfileId?: string | null }> = [];
const dialect: Dialect = {
  defaultCmd: WITNESS_CLI, persistentProcess: false, finishMissionOnExit: false,
  sessionResumable: true, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  async buildSpawn(opts) {
    if (opts.cfg.model === 'reject') throw new Error('witness launch refused');
    seen.push({ agent: opts.agentName, mission: opts.missionId, input: opts.message, browserProfileId: opts.cfg.browser_profile_id });
    const output = [
      { type: 'system', payload: { subtype: 'init', session_id: `witness-${opts.missionId}` } },
      { type: 'result', payload: { subtype: 'success', is_error: opts.message.includes('FAIL_NODE'), result: opts.message.includes('is starting.') ? 'Acknowledged.' : 'Documentation complete.' } },
    ];
    return { cmd: WITNESS_CLI, args: ['-e', `setTimeout(() => { for (const event of ${JSON.stringify(output)}) console.log(JSON.stringify(event)); }, 30);`], cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() {},
  parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
  extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
};
registerDialect('workflow-test', 'workflow-witness', dialect);
registerProfile('workflow-test', { id: 'workflow-witness', dialect: 'workflow-witness', label: 'Witness', vendor: 'Test', custom: true, defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }] });

async function until(check: () => boolean) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail('workflow witness timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function seed(model = 'witness-child', parallel = false, backend = 'workflow-witness') {
  const id = randomUUID();
  const definition = { schemaVersion: 1, nodes: [
    { id: 'start', type: 'trigger.manual', config: {} },
    { id: 'docs', type: 'agent', config: { identity: { instructions: 'Write documentation.', backend, model }, input: 'Document the result.' } },
    { id: 'output', type: 'output', config: { template: '{{nodes.docs.output.text}}' } },
  ], edges: [{ id: 'a', from: 'start', fromPort: 'out', to: 'docs' }, { id: 'b', from: 'docs', fromPort: 'done', to: 'output' }], variables: [], settings: {} };
  if (parallel) {
    definition.nodes.push({ id: 'other', type: 'agent', config: { identity: { instructions: 'Write documentation.', backend, model }, input: 'Document another result.' } });
    definition.edges.push({ id: 'c', from: 'start', fromPort: 'out', to: 'other' });
  }
  // The pilot is an existing agent assigned to the workflow, never one minted for it.
  const agent = `pilot-${id.slice(0, 8)}`;
  upsertAgent({ name: agent, system_prompt: 'You pilot workflows.', config: { backend: 'workflow-witness' as never, model: 'witness', cwd: process.env.TIMON_HOME! } });
  const row = { id, slug: `witness-${id}`, name: 'Documentation workflow', description: null, project: null, owner_user_id: null, draft: JSON.stringify(definition), published_version: null, enabled: 1, created_at: Date.now(), updated_at: Date.now(), agent_name: agent };
  dbApi.insertWorkflow(row);
  assert.equal(ensureWorkflowCoordinator(row), agent);
  return { row, agent };
}

test('the pilot is the assigned agent, untouched; an unassigned or unknown agent is refused', () => {
  const { row, agent } = seed();
  assert.equal(ensureWorkflowCoordinator(row), agent);
  assert.equal(loadConfig(agent).model, 'witness');
  assert.equal(getAgent(agent)?.system_prompt, 'You pilot workflows.');
  assert.throws(() => ensureWorkflowCoordinator({ ...row, agent_name: null }), /no assigned agent/);
  assert.throws(() => ensureWorkflowCoordinator({ ...row, agent_name: 'nobody-here' }), /not found/);
  db.prepare('UPDATE workflows SET agent_name=NULL WHERE id=?').run(row.id);
  assert.throws(() => startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true }), /no assigned agent/);
  assert.equal(dbApi.listWorkflowRuns(row.id).length, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM workflow_versions WHERE workflow_id=?').get(row.id) as { n: number }).n, 0, 'no draft version is frozen for a refused run');
});

test('legacy per-workflow agents are purged at boot, assigned agents are kept', () => {
  const legacy = `workflow.${randomUUID()}`;
  upsertAgent({ name: legacy, system_prompt: 'legacy pilot', config: { backend: 'workflow-witness' as never, cwd: process.env.TIMON_HOME! } });
  const { agent } = seed();
  assert.ok(getAgent(legacy));
  assert.equal(purgeLegacyWorkflowCoordinators(), 1);
  assert.equal(getAgent(legacy), null);
  assert.ok(getAgent(agent));
  assert.equal(purgeLegacyWorkflowCoordinators(), 0);
});

registerProfile('workflow-test', { id: 'workflow-witness-other', dialect: 'workflow-witness', label: 'Other witness', vendor: 'Test', custom: true, defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }] });

for (const backend of ['workflow-witness', 'workflow-witness-other']) test(`an agent node runs as a sub-agent of the pilot and reports to it (${backend})`, async () => {
  const { row, agent } = seed(backend === 'workflow-witness' ? 'witness-child' : 'witness', false, backend);
  const listener = (event: { kind: string; type?: string; missionId: string; payload?: unknown }) => {
    if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
  };
  bus.on('event', listener);
  let runId = '';
  try {
    const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
    runId = run.id;
    await Promise.all([advance(run.id), advance(run.id)]);
    await until(() => dbApi.getWorkflowRun(run.id)?.status === 'completed');
    const saved = dbApi.getWorkflowRun(run.id)!;
    const context = JSON.parse(saved.context) as { coordinatorMissionId: string; output: string };
    const parent = dbApi.getMission(context.coordinatorMissionId)!;
    assert.equal(parent.agent_name, agent);
    assert.equal(parent.workflow_run_id, run.id);
    assert.equal(parent.workflow_node_id, null);
    const child = dbApi.listChildMissions(parent.id)[0]!;
    assert.ok(child);
    assert.equal(dbApi.listChildMissions(parent.id).length, 1);
    assert.equal(child.workflow_node_id, 'docs');
    assert.equal(child.backend_override, backend);
    assert.equal(child.model_override, backend === 'workflow-witness' ? 'witness-child' : 'witness');
    assert.equal(child.owner_user_id, parent.owner_user_id);
    assert.equal(child.trace_id, parent.trace_id);
    assert.equal(context.output, 'Documentation complete.');
    const report = dbApi.getMessage(`workflow-report:${run.id}:node:docs:1`)!;
    assert.equal(report.to_mission, parent.id);
    assert.equal(report.from_mission, child.id);
    assert.match(report.payload, /Documentation complete/);
    const final = dbApi.getMessage(`workflow-report:${run.id}:terminal`)!;
    assert.equal(final.to_mission, parent.id);
    await advance(run.id);
    reportToWorkflowCoordinator(run.id, 'terminal', { status: 'completed' });
    assert.equal(dbApi.getMessage(final.id)?.created_at, final.created_at);
    await until(() => !getTurnState(parent.id)?.turnActive);
    const deadline = Date.now() + 5000;
    while (dbApi.getMessage(report.id)?.status === 'pending' && Date.now() < deadline) {
      await flushWorkflowReports();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(seen.some((entry) => entry.mission === parent.id && entry.input.includes(report.payload)));
    assert.equal(dbApi.getMessage(report.id)?.status, 'picked');
  } finally {
    bus.off('event', listener);
    for (const mission of dbApi.listMissionsByTrace(runId)) killAgent(mission.id, { source: 'test' });
  }
});

test('a pilot launch failure fails the run without dispatching any sub-agent', async () => {
  const { row, agent } = seed();
  patchAgentConfig(agent, { model: 'reject' });
  const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
  await until(() => dbApi.getWorkflowRun(run.id)?.status === 'failed');
  assert.match(dbApi.getWorkflowRun(run.id)?.error ?? '', /witness launch refused/);
  assert.ok(dbApi.listWorkflowRunNodes(run.id).every((node) => node.status === 'skipped' && node.mission_id === null));
  assert.equal(dbApi.listMissionsByTrace(run.id).length, 1);
});

for (const parallel of [false, true]) test(`same backend/model still runs as a sub-agent reporting to the pilot (parallel=${parallel})`, async () => {
  const { row, agent } = seed('witness', parallel);
  const listener = (event: { kind: string; type?: string; missionId: string; payload?: unknown }) => {
    if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
  };
  bus.on('event', listener);
  let runId = '';
  try {
    const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
    runId = run.id;
    await until(() => dbApi.getWorkflowRun(run.id)?.status === 'completed');
    const context = JSON.parse(dbApi.getWorkflowRun(run.id)!.context);
    assert.equal(context.output, 'Documentation complete.');
    const nodes = dbApi.listWorkflowRunNodes(run.id).filter((node) => ['docs', 'other'].includes(node.node_id));
    assert.equal(nodes.length, parallel ? 2 : 1);
    assert.equal(dbApi.listMissionsByTrace(run.id).length, 1 + nodes.length);
    const children = dbApi.listChildMissions(context.coordinatorMissionId);
    assert.equal(children.length, nodes.length);
    for (const node of nodes) {
      assert.equal(node.status, 'ok');
      assert.notEqual(node.mission_id, context.coordinatorMissionId);
      assert.ok(children.some((child) => child.id === node.mission_id && child.workflow_node_id === node.node_id));
      assert.ok(dbApi.getMessage(`workflow-report:${run.id}:node:${node.node_id}:1`), 'each sub-agent result reports to the pilot');
    }
    assert.ok(seen.every((entry) => entry.mission !== context.coordinatorMissionId || entry.input.includes('is starting.')), 'the pilot only receives the run brief, never a node to execute');
    assert.ok(dbApi.getMessage(`workflow-report:${run.id}:terminal`));
    dbApi.updateMissionUsage(context.coordinatorMissionId, 0.25, 11, 7);
    completeWorkflowTurn(context.coordinatorMissionId, { result: 'Summary.' });
    assert.equal(dbApi.getWorkflowRun(run.id)?.tokens_in, 11);
    assert.equal(dbApi.getWorkflowRun(run.id)?.cost_usd, 0.25);
  } finally {
    bus.off('event', listener);
    for (const mission of dbApi.listMissionsByTrace(runId)) killAgent(mission.id, { source: 'test' });
  }
});

test('unset inline runtime inherits the pilot, including mission overrides and profile defaults', async () => {
  const { workflowNodeRuntime } = await import('./nodes/agent.js');
  const { agent } = seed();
  const mission = { id: randomUUID() };
  dbApi.createMission(mission.id, agent, 'runtime comparison');
  dbApi.setMissionBrowserProfile(mission.id, resolveBrowserProfile({ ownerUserId: null, agentName: agent })!.id);
  db.prepare('UPDATE missions SET backend_override=?, model_override=? WHERE id=?').run('workflow-witness', 'overridden', mission.id);
  const node = { id: 'inline', type: 'agent' as const, config: { identity: { instructions: 'Work' } } };
  assert.deepEqual([workflowNodeRuntime(mission.id, node).backend, workflowNodeRuntime(mission.id, node).model], ['workflow-witness', 'overridden']);
  assert.equal(workflowNodeRuntime(mission.id, { ...node, config: { ...node.config, model: 'witness' } }).model, 'witness');
  patchAgentConfig(agent, { model: null });
  db.prepare('UPDATE missions SET model_override=NULL WHERE id=?').run(mission.id);
  assert.equal(workflowNodeRuntime(mission.id, node).model, 'witness', 'the profile default model');
});

test('a workflow node with another browser profile runs separately and receives only its assigned profile', async () => {
  const { row } = seed('witness');
  const parentProfile = createBrowserProfile({ name: 'Coordinator session' });
  const childProfile = createBrowserProfile({ name: 'Only CMS', grants: { workflow_slugs: [row.slug] } });
  const definition = JSON.parse(row.draft);
  definition.settings.browserProfileId = parentProfile.id;
  definition.nodes.find((node: { id: string }) => node.id === 'docs').config.browserProfileId = childProfile.id;
  dbApi.updateWorkflow(row.id, { draft: JSON.stringify(definition) });
  const listener = (event: { kind: string; type?: string; missionId: string; payload?: unknown }) => {
    if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
  };
  bus.on('event', listener);
  let runId = '';
  try {
    const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
    runId = run.id;
    await until(() => dbApi.getWorkflowRun(run.id)?.status === 'completed');
    const context = JSON.parse(dbApi.getWorkflowRun(run.id)!.context);
    const parent = dbApi.getMission(context.coordinatorMissionId)!;
    const children = dbApi.listChildMissions(parent.id);
    assert.equal(parent.browser_profile_id, parentProfile.id);
    assert.equal(children.length, 1);
    assert.equal(children[0]!.browser_profile_resolved, 1);
    assert.equal(children[0]!.browser_profile_id, childProfile.id);
    assert.ok(seen.some((entry) => entry.mission === children[0]!.id && entry.browserProfileId === childProfile.id));
    assert.ok(seen.filter((entry) => entry.mission === parent.id).every((entry) => entry.browserProfileId === parentProfile.id));
  } finally {
    bus.off('event', listener);
    for (const mission of dbApi.listMissionsByTrace(runId)) killAgent(mission.id, { source: 'test' });
  }
});

test('a failed sub-agent turn fails its node without mistaking the pilot acknowledgement for its result', async () => {
  const { row } = seed('witness');
  const definition = JSON.parse(row.draft);
  definition.nodes[1].config.input = 'FAIL_NODE';
  db.prepare('UPDATE workflows SET draft=? WHERE id=?').run(JSON.stringify(definition), row.id);
  const listener = (event: { kind: string; type?: string; missionId: string; payload?: unknown }) => {
    if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
  };
  bus.on('event', listener);
  let runId = '';
  try {
    const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
    runId = run.id;
    await until(() => dbApi.getWorkflowRun(run.id)?.status === 'failed');
    assert.equal(dbApi.listWorkflowRunNodes(run.id).find((node) => node.node_id === 'docs')?.status, 'error');
    assert.equal(dbApi.listMissionsByTrace(run.id).length, 2);
  } finally {
    bus.off('event', listener);
    for (const mission of dbApi.listMissionsByTrace(runId)) killAgent(mission.id, { source: 'test' });
  }
});

test('an inline agent with an id that is not a skill id still runs: the id is dropped and logged', async () => {
  const { ownAgentSkills } = await import('../skill-attachments.js');
  const { workflowAgentName } = await import('./nodes/agent.js');
  const { parseWorkflowDefinition } = await import('./schema.js');
  const { row } = seed('witness');
  const definition = JSON.parse(row.draft);
  // Published before ids were checked: the schema takes any string.
  definition.nodes[1].config.identity.skills = ['Bad Skill', ' witness-skill '];
  assert.doesNotThrow(() => parseWorkflowDefinition(definition));
  db.prepare('UPDATE workflows SET draft=? WHERE id=?').run(JSON.stringify(definition), row.id);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  const listener = (event: { kind: string; type?: string; missionId: string; payload?: unknown }) => {
    if (event.kind === 'event' && event.type === 'result') completeWorkflowTurn(event.missionId, event.payload);
  };
  bus.on('event', listener);
  let runId = '';
  try {
    const run = startWorkflowRun(row.id, { trigger: { kind: 'api' }, draft: true });
    runId = run.id;
    await until(() => dbApi.getWorkflowRun(run.id)?.status === 'completed');
    assert.deepEqual(ownAgentSkills(workflowAgentName(row.slug, 'docs')), ['witness-skill']);
    assert.ok(warnings.some((line) => line.includes('ignored skill "Bad Skill"')), warnings.join('\n'));
  } finally {
    console.warn = warn;
    bus.off('event', listener);
    for (const mission of dbApi.listMissionsByTrace(runId)) killAgent(mission.id, { source: 'test' });
  }
});
