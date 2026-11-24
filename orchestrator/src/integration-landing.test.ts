/**
 * "Integrated" is not "landed" (`docs/KANBAN-PR-PIPELINE.md` §2.7): a chain
 * merged into an integration branch keeps its TO DO idea open (`partial`) and
 * gets no doc task; both come when the branch lands. A local chain is
 * unchanged.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, dbApi, type TaskRow, type TaskType } from './db.js';
import { applyTodoClosure, planTodoClosure } from './todo-closure.js';
import { chainLanding } from './chain-landing.js';
import { landIntegration, reconcileLandedIntegrations } from './integration-landing.js';
import { maybeCreateDocTask } from './doc-task.js';
import { handleTaskDone } from './wake.js';
import { presentInboxDigest } from './wake-digest.js';
import { mainAgentNameOrSeed } from './main-agent.js';
import { agentDir } from './paths.js';
import { writeRoles } from './projects.js';
await import('../tests/helpers/claude-provider.js');

const PROJECT = 'acme';
const SHA = 'a'.repeat(40);
const MERGE_SHA = 'b'.repeat(40);

writeRoles(PROJECT, { doc: { agent: 'acme.librarian', backend: 'claude', model: 'sonnet' } });
mkdirSync(agentDir('acme.librarian'), { recursive: true });
writeFileSync(join(agentDir('acme.librarian'), 'config.json'), JSON.stringify({ role: 'librarian', project: PROJECT }));
writeFileSync(join(agentDir('acme.librarian'), 'system-prompt.md'), 'librarian');

let jobs = 0;
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];

/** An integration branch of the job, recorded as the dispatcher does. */
function job(mode = 'pr'): { branch: string; id: string } {
  const branch = `feat/${WORDS[jobs % WORDS.length]}-${Math.floor(jobs / WORDS.length)}-job`;
  jobs += 1;
  const row = dbApi.recordIntegration({
    repo: '/nowhere/repo', branch, remote: 'origin', target: 'main', mode, project: PROJECT,
  });
  return { branch, id: row.id };
}

function idea(): number {
  return dbApi.insertProjectTodo({ text: `idea ${randomUUID()}`, ownerUserId: 'user-ada' }).id;
}

type On = { branch: string; mode: string } | null;

function task(type: TaskType, on: On, opts: {
  todoId?: number; deps?: string[]; root?: string; pipeline?: string; done?: string | false; sha?: boolean;
} = {}): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} ${id.slice(0, 6)}`, 'acme.coder', {
    type, deps: opts.deps, pipeline: opts.pipeline ?? null, project: PROJECT,
    baseBranch: on?.branch ?? null, integrationMode: on?.mode ?? null, baseRef: on ? 'origin/main' : null,
  });
  if (opts.todoId) dbApi.setTaskTodoId(id, opts.todoId);
  if (opts.root) dbApi.setTaskVerificationMeta(id, 1, opts.root);
  if (opts.sha) dbApi.setTaskMergedSha(id, SHA);
  if (opts.done !== false) dbApi.updateTaskStatus(id, 'DONE', { doneComment: opts.done ?? 'done\nportability: n/a' });
  return dbApi.getTask(id)!;
}

/** code → review → merge of the `full` pipeline on `on`. */
function fullChain(todoId: number, on: On, mergeDone = true) {
  const code = task('code', on, { todoId, pipeline: 'full' });
  const review = task('review', on, { deps: [code.id], root: code.id, done: 'verdict: pass' });
  const merge = task('merge', on, { deps: [review.id], sha: true, done: mergeDone ? `merged ${SHA}` : false });
  return { code, review, merge };
}

const docsOf = (taskId: string) => dbApi.listTasks().filter((t) => t.type === 'doc' && t.deps.includes(taskId));

test('pr mode: the merge into the integration branch leaves the idea partial; it closes when the branch lands', async () => {
  const id = idea();
  const feat = job();
  const { merge } = fullChain(id, { branch: feat.branch, mode: 'pr' });

  assert.equal(chainLanding(merge), 'integrated');
  assert.deepEqual(applyTodoClosure(merge), [
    { todoId: id, progress: 'partial', landed: 0, total: 1, integrating: feat.branch },
  ]);
  const open = dbApi.getProjectTodo(id)!;
  assert.equal(open.status, 'open');
  assert.equal(open.progress, 'partial');

  const out = await landIntegration(feat.id, MERGE_SHA);
  assert.equal(out.replayed, true);
  assert.deepEqual(out.closures, [{ todoId: id, progress: 'done' }]);
  assert.equal(chainLanding(merge), 'landed');
  const row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
  assert.equal(dbApi.getIntegrationById(feat.id)?.merge_sha, MERGE_SHA);

  const again = await landIntegration(feat.id, MERGE_SHA);
  assert.equal(again.replayed, false, 'the landing is replayed once');
});

test('local mode is unchanged: the merge closes the idea, explicit "local" or no mode at all', () => {
  for (const on of [null, { branch: 'main', mode: 'local' }]) {
    const id = idea();
    const { code, merge } = fullChain(id, on);
    assert.equal(chainLanding(merge), 'local');
    assert.deepEqual(applyTodoClosure(code), []);
    assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
    assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
  }
});

test('branch mode (embargo) waits for its landing like pr mode', async () => {
  const id = idea();
  const sec = job('branch');
  const { merge } = fullChain(id, { branch: sec.branch, mode: 'branch' });
  assert.equal(applyTodoClosure(merge)[0]?.progress, 'partial');
  await landIntegration(sec.id);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('code-self in pr mode: the coder\'s merge sha integrates, the landing closes', async () => {
  const id = idea();
  const feat = job();
  const code = task('code', { branch: feat.branch, mode: 'pr' }, { todoId: id, pipeline: 'code-self', sha: true });
  assert.equal(planTodoClosure(code)[0]?.progress, 'partial');
  applyTodoClosure(code);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open');
  await landIntegration(feat.id);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('one idea over two jobs: partial after the first landing, done after the second', async () => {
  const id = idea();
  const a = job();
  const b = job();
  const first = fullChain(id, { branch: a.branch, mode: 'pr' });
  const second = fullChain(id, { branch: b.branch, mode: 'pr' }, false);

  applyTodoClosure(first.merge);
  assert.equal(dbApi.getProjectTodo(id)?.progress, 'partial');

  const landedA = await landIntegration(a.id);
  assert.deepEqual(landedA.closures, [], 'already partial: nothing moves');
  assert.deepEqual(planTodoClosure(first.merge), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open');

  dbApi.updateTaskStatus(second.merge.id, 'DONE', { doneComment: `merged ${SHA}` });
  const integratedB = planTodoClosure(dbApi.getTask(second.merge.id)!);
  assert.deepEqual(integratedB, [{ todoId: id, progress: 'partial', landed: 1, total: 2, integrating: b.branch }]);

  await landIntegration(b.id);
  const row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
});

test('a local chain and a pr chain on one idea: the idea waits for the pr landing', async () => {
  const id = idea();
  const feat = job();
  const local = fullChain(id, null);
  const pr = fullChain(id, { branch: feat.branch, mode: 'pr' });
  assert.deepEqual(applyTodoClosure(local.merge), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  assert.equal(applyTodoClosure(pr.merge).length, 0, 'already partial');
  await landIntegration(feat.id);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('a pull request closed without a merge closes nothing', async () => {
  const id = idea();
  const feat = job();
  const { merge } = fullChain(id, { branch: feat.branch, mode: 'pr' });
  db.prepare(`UPDATE integrations SET state = 'closed' WHERE id = ?`).run(feat.id);
  assert.equal(chainLanding(merge), 'closed');
  applyTodoClosure(merge);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open');
  await maybeCreateDocTask(merge);
  assert.equal(docsOf(merge.id).length, 0);
  await reconcileLandedIntegrations();
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open', 'closed is not merged: no replay');
});

test('an integration branch with no recorded row: fail closed, nothing lands', () => {
  const id = idea();
  const { merge } = fullChain(id, { branch: 'feat/never-recorded', mode: 'pr' });
  assert.equal(chainLanding(merge), 'integrated');
  applyTodoClosure(merge);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open');
});

test('the doc task is created at the landing, not at the integration, and once', async () => {
  const feat = job();
  const { merge } = fullChain(idea(), { branch: feat.branch, mode: 'pr' });
  await maybeCreateDocTask(merge);
  assert.equal(docsOf(merge.id).length, 0, 'no doc for an integration only');

  const out = await landIntegration(feat.id);
  assert.equal(out.docs, 1);
  const docs = docsOf(merge.id);
  assert.equal(docs.length, 1);
  assert.equal(docs[0]!.base_branch, feat.branch);
  assert.equal(docs[0]!.integration_mode, 'pr');

  await maybeCreateDocTask(dbApi.getTask(merge.id)!);
  assert.equal(docsOf(merge.id).length, 1, 'idempotent');
});

test('a local chain still gets its doc at its own closure', async () => {
  const { merge } = fullChain(idea(), null);
  await maybeCreateDocTask(merge);
  assert.equal(docsOf(merge.id).length, 1);
});

test('reconciliation replays a merged integration whose landing never ran, then stays silent', async () => {
  const id = idea();
  const feat = job();
  const { merge } = fullChain(id, { branch: feat.branch, mode: 'pr' });
  applyTodoClosure(merge);
  // The poller wrote 'merged', then the daemon stopped before the replay.
  assert.equal(dbApi.markIntegrationMerged(feat.id, MERGE_SHA), true);
  assert.equal(dbApi.getIntegrationById(feat.id)?.landed_at, null);

  await reconcileLandedIntegrations();
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
  assert.ok(dbApi.getIntegrationById(feat.id)?.landed_at);
  assert.equal(docsOf(merge.id).length, 1);

  await reconcileLandedIntegrations();
  assert.equal(docsOf(merge.id).length, 1, 'no second replay');
  assert.equal(dbApi.markIntegrationMerged(feat.id, MERGE_SHA), false, 'merged is final');
});

test('the work return says the idea waits for the landing; the landing sends no second return', async () => {
  const id = idea();
  const feat = job();
  const { merge } = fullChain(id, { branch: feat.branch, mode: 'pr' }, false);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.merger', 'merge');
  dbApi.assignTaskMission(merge.id, missionId);
  dbApi.updateTaskStatus(merge.id, 'DONE', { doneComment: `merged ${SHA}` });
  handleTaskDone(merge.id);

  const returnsOf = () => dbApi.listInbox(mainAgentNameOrSeed(), { limit: 200 })
    .filter((m) => (JSON.parse(m.payload) as { task_id?: string }).task_id === merge.id);
  const [msg] = returnsOf();
  assert.ok(msg, 'return enqueued');
  const payload = JSON.parse(msg.payload) as { todo_closed?: number[]; todo_progress?: unknown };
  assert.equal(payload.todo_closed, undefined, 'never announced closed at the integration');
  assert.deepEqual(payload.todo_progress, [
    { id, progress: 'partial', landed: 0, total: 1, integrating: feat.branch },
  ]);
  assert.match(JSON.stringify(presentInboxDigest([msg])), /closes when that branch lands/);
  assert.equal(dbApi.isTaskReturnNotified(merge.id), true);

  await landIntegration(feat.id);
  handleTaskDone(merge.id);
  assert.equal(returnsOf().length, 1, 'one return per task, the landing does not re-arm it');
  assert.equal(dbApi.isTaskReturnNotified(merge.id), true);
});
