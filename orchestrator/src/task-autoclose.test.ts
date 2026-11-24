/**
 * Automatic closing: a mission that ends without the agent having closed anything.
 *
 * `watchMissionComplete` then sets DONE through `setTaskStatusOnly`, chosen
 * precisely because `updateTaskStatus` would overwrite the fields of an agent that
 * closed just before dying. The defect: the `done_comment` stayed empty
 * and the pilot received a mute `task_closed`, impossible to tell from an
 * agent that had nothing to say. So the automatic closing is qualified,
 * without ever touching a comment already set.
 *
 * `node --test --import tsx src/task-autoclose.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// french-ok-file: French sample comments and reasons the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-autoclose-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { parseReviewVerdict } = await import('./review-verdict.js');
const { upsertAgent } = await import('./agent.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');

function dispatched(type: 'code' | 'review' | 'chore' = 'chore') {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, `volet ${type}`, 'p.coder', { type });
  dbApi.createMission(missionId, 'p.coder', `volet ${type}`);
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

function completes(missionId: string): void {
  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0 });
}

test('an automatic closing names itself, instead of leaving an empty return', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
  } finally { stop(); }
});

test('the comment of an agent that closed just before dying is not overwritten', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    // The agent wrote its return but the task stayed IN_PROGRESS (partial
    // closing): that is exactly the case `setTaskStatusOnly` protects.
    dbApi.updateTaskStatus(taskId, 'IN_PROGRESS', { doneComment: 'refonte livrée, 3 fichiers' });
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.equal(task?.done_comment, 'refonte livrée, 3 fichiers');
  } finally { stop(); }
});

test('the automatic closing sentence cannot pass for a review verdict', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched('review');
    completes(missionId);
    // `unknown` makes the chain escalate. A `pass` made up here would merge
    // code nobody reviewed.
    assert.equal(parseReviewVerdict(dbApi.getTask(taskId)?.done_comment ?? null).verdict, 'unknown');
  } finally { stop(); }
});

test('a dead mission inherits no return: the sentence only applies to a DONE', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatched();
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1 });
    const task = dbApi.getTask(taskId);
    // System death: the task is requeued, it does not go DONE, and above all
    // it does not receive a closing comment for work that did not
    // happen.
    assert.notEqual(task?.status, 'DONE');
    assert.equal(task?.done_comment, null);
  } finally { stop(); }
});

// A backend that declares `timonMcp: false` gives its agent no tool to close the
// task: the last reply is the only report there will ever be.
registerDialect('autoclose-test', 'autoclose-no-tools', {
  defaultCmd: 'echo',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: true,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  capabilities: { worktree: false, timonMcp: false, attachments: false },
  async buildSpawn(_opts, profile) { return { cmd: profile.cmd, args: [], initialStdin: null }; },
  writeUserInput() { /* one-shot */ },
  parseLine() { return []; },
  extractSessionId() { return null; },
});
registerProfile('autoclose-test', {
  id: 'autoclose-no-tools', dialect: 'autoclose-no-tools', label: 'No tools', custom: true, defaultModel: null, models: [],
});

function dispatchedOnNoToolsBackend(type: 'code' | 'review', reply: string | null) {
  const agent = `autoclose-remote-${randomUUID().slice(0, 6)}`;
  upsertAgent({ name: agent, system_prompt: 'W.', config: { backend: 'autoclose-no-tools', skills: [], mcp_servers: [] } });
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'remote work', agent, { type });
  dbApi.createMission(missionId, agent, 'remote work');
  dbApi.assignTaskMission(taskId, missionId);
  if (reply) {
    dbApi.insertEvent(missionId, 'assistant', {
      type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: reply }] },
    } as never);
  }
  return { taskId, missionId };
}

test('an agent without Timon tools closes its task with its last reply', () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = dispatchedOnNoToolsBackend('code', 'Refactor shipped: 3 files, tests green.');
    completes(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /Refactor shipped: 3 files, tests green\./);
    assert.match(task?.done_comment ?? '', /no Timon tools/);
  } finally { stop(); }
});

test('without a reply, or on a review, the generic sentence stays', () => {
  const stop = watchMissionComplete();
  try {
    const silent = dispatchedOnNoToolsBackend('code', null);
    completes(silent.missionId);
    assert.match(dbApi.getTask(silent.taskId)?.done_comment ?? '', /auto-closed by the orchestrator/);

    const review = dispatchedOnNoToolsBackend('review', 'Verdict: pass. Ship it.');
    completes(review.missionId);
    assert.match(dbApi.getTask(review.taskId)?.done_comment ?? '', /auto-closed by the orchestrator/);
    assert.equal(parseReviewVerdict(dbApi.getTask(review.taskId)?.done_comment ?? null).verdict, 'unknown');
  } finally { stop(); }
});

// Boot reconciliation is the other door to the same closure: the daemon died
// before `mission_complete` reached the watcher, and the orphan is caught up
// from the mission row. It used to land DONE with no comment at all (TODO #522).
test('an orphan reconciled at boot gets the same qualified closure', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
});

test('reconciliation keeps the comment of an agent that closed partially', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.updateTaskStatus(taskId, 'IN_PROGRESS', { doneComment: 'migration livrée' });
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.equal(task?.done_comment, 'migration livrée');
});

test('reconciliation never fabricates a review verdict', async () => {
  const { taskId, missionId } = dispatched('review');
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  assert.equal(parseReviewVerdict(dbApi.getTask(taskId)?.done_comment ?? null).verdict, 'unknown');
});

test('a reconciled agent without Timon tools closes with its last reply', async () => {
  const { taskId, missionId } = dispatchedOnNoToolsBackend('code', 'Index rebuilt, 2 files.');
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  assert.match(dbApi.getTask(taskId)?.done_comment ?? '', /Index rebuilt, 2 files\./);
});

// Quota deaths exit 0: the mission is `completed` but carries its cause. The
// live path blocks such a task; reconciliation must not close it DONE instead.
test('a completed mission with a qualified death cause is not reconciled DONE', async () => {
  const { taskId, missionId } = dispatched();
  dbApi.finishMission(missionId, 'completed', 0);
  dbApi.setMissionInterrupted(missionId, 'rate_limit');
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.notEqual(task?.status, 'DONE');
  assert.equal(task?.done_comment, null);
});
