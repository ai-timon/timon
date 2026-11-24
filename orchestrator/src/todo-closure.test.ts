/**
 * A TO DO idea closes itself when the chain of the task that implements it
 * lands — at the merge, never at the `code` closure a review can still refuse.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbApi, type TaskRow, type TaskType } from './db.js';
import { applyTodoClosure, needsMultiOsTest, planTodoClosure } from './todo-closure.js';
import { runTaskChain } from './task-chain.js';
import { handleTaskDone } from './wake.js';
import { presentInboxDigest } from './wake-digest.js';
import { mainAgentNameOrSeed } from './main-agent.js';

// french-ok-file: the French portability line agents write, which the closure reads

const SHA = 'a'.repeat(40);

function idea(): number {
  return dbApi.insertProjectTodo({ text: `idée ${randomUUID()}`, ownerUserId: 'user-ada' }).id;
}

function task(type: TaskType, opts: {
  todoId?: number; deps?: string[]; root?: string; iteration?: number; pipeline?: string;
  group?: string; done?: string | false; sha?: boolean;
} = {}): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} ${id.slice(0, 6)}`, 'acme.coder', {
    type, deps: opts.deps, pipeline: opts.pipeline ?? null, groupId: opts.group ?? null,
  });
  if (opts.todoId) dbApi.setTaskTodoId(id, opts.todoId);
  if (opts.root) dbApi.setTaskVerificationMeta(id, opts.iteration ?? 1, opts.root);
  if (opts.sha) dbApi.setTaskMergedSha(id, SHA);
  if (opts.done !== false) dbApi.updateTaskStatus(id, 'DONE', { doneComment: opts.done ?? 'fait' });
  return dbApi.getTask(id)!;
}

/** code → review → merge of the `full` pipeline, as the verification loop builds
 *  it: the review is tagged with the root, the merge only hangs off the review. */
function fullChain(todoId: number, codeComment = 'fait\nportabilité : n/a') {
  const code = task('code', { todoId, pipeline: 'full', done: codeComment });
  const review = task('review', { deps: [code.id], root: code.id, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], sha: true, done: `merged ${SHA}` });
  return { code, review, merge };
}

test('full: the idea closes at the merge, not at the code closure', () => {
  const id = idea();
  const { code, review, merge } = fullChain(id);
  assert.deepEqual(applyTodoClosure(code), [], 'a review can still refuse the code');
  assert.deepEqual(applyTodoClosure(review), []);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'open');
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
  const row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
  assert.ok(row.done_at);
});

test('full: the latest repair iteration owes an OS test → closed all the same, flagged osTest', () => {
  const id = idea();
  const root = task('code', { todoId: id, pipeline: 'full', done: 'v1\nportabilité : n/a' });
  const iter2 = task('code', { root: root.id, iteration: 2, pipeline: 'full', done: 'v2\nportabilité : à tester Win/Mac' });
  const review = task('review', { deps: [iter2.id], root: root.id, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done', osTest: true }]);
  const row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
});

test('the portability template copied verbatim is not a verdict', () => {
  assert.equal(needsMultiOsTest('portabilité : n/a | vérifiée | à tester Win/Mac'), false);
  assert.equal(needsMultiOsTest('[code-gate] …\n\nfait\nportabilité : à tester Win/Mac'), true);
  assert.equal(needsMultiOsTest('portabilité : vérifiée'), false);
  assert.equal(needsMultiOsTest('la règle 9 laisse ouverte une idée « à tester Win/Mac »\nportabilité : n/a'), false,
    'prose quoting the rule is not the verdict line');
  assert.equal(needsMultiOsTest('- **Portabilité** : à tester Win/Mac (service macOS)'), true);
  const id = idea();
  assert.deepEqual(applyTodoClosure(fullChain(id, 'portabilité : n/a | vérifiée | à tester Win/Mac').merge),
    [{ todoId: id, progress: 'done' }]);
});

test('a merge never walks past its code task: an earlier feature keeps its idea', () => {
  const earlier = idea();
  const mine = idea();
  const before = task('code', { todoId: earlier, pipeline: 'full' });
  const code = task('code', { todoId: mine, pipeline: 'full', deps: [before.id] });
  const review = task('review', { deps: [code.id], root: code.id, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: mine, progress: 'done' }]);
  assert.equal(dbApi.getProjectTodo(earlier)?.status, 'open');
});

test('code-self: the code task closes its idea once it carries its merge sha', () => {
  const id = idea();
  const code = task('code', { todoId: id, pipeline: 'code-self', sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(code), [{ todoId: id, progress: 'done' }]);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('full: a code task marked merged by hand closes its idea (TIM-0109)', () => {
  const id = idea();
  const code = task('code', { todoId: id, pipeline: 'full', sha: true, done: `Marked as merged outside Timon: ${SHA}` });
  assert.deepEqual(applyTodoClosure(code), [{ todoId: id, progress: 'done' }]);
});

test('code-group: the final merge closes every landed slice of the batch', () => {
  const group = randomUUID();
  const [a, b, blocked] = [idea(), idea(), idea()];
  const sliceA = task('code', { todoId: a, pipeline: 'code-group', group });
  const sliceB = task('code', { todoId: b, pipeline: 'code-group', group, done: 'fait\nportabilité : à tester Win/Mac' });
  const stuck = task('code', { todoId: blocked, pipeline: 'code-group', group, done: false });
  dbApi.updateTaskStatus(stuck.id, 'BLOCKED', { blockedReason: 'conflit' });
  assert.deepEqual(applyTodoClosure(sliceA), [], 'a slice alone is not merged yet');
  const merge = task('merge', { deps: [sliceA.id, sliceB.id], group, sha: true, done: `merged ${SHA}` });
  const applied = applyTodoClosure(merge).sort((x, y) => x.todoId - y.todoId);
  assert.deepEqual(applied, [{ todoId: a, progress: 'done' }, { todoId: b, progress: 'done', osTest: true }]);
  assert.equal(dbApi.getProjectTodo(a)?.status, 'done');
  assert.equal(dbApi.getProjectTodo(b)?.status, 'done');
  assert.equal(dbApi.getProjectTodo(blocked)?.status, 'open', 'a BLOCKED slice did not land');
});

test('mixed batch: a full chain merge in the batch never closes the code-group slices (TODO #521)', () => {
  const group = randomUUID();
  const [mine, slice] = [idea(), idea()];
  const code = task('code', { todoId: mine, pipeline: 'full', group });
  const pending = task('code', { todoId: slice, pipeline: 'code-group', group });
  const review = task('review', { deps: [code.id], root: code.id, group, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], group, sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: mine, progress: 'done' }]);
  assert.equal(dbApi.getProjectTodo(slice)?.status, 'open', 'the code-group slice awaits its final merge');
  const final = task('merge', { deps: [pending.id], group, sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(final), [{ todoId: slice, progress: 'done' }]);
});

test('research only moves the idea to analyzed, and only from todo', () => {
  const fresh = idea();
  assert.deepEqual(applyTodoClosure(task('research', { todoId: fresh })), [{ todoId: fresh, progress: 'analyzed' }]);
  const row = dbApi.getProjectTodo(fresh)!;
  assert.equal(row.status, 'open');
  assert.equal(row.progress, 'analyzed');
  const partial = idea();
  dbApi.updateProjectTodo(partial, { progress: 'partial' });
  assert.deepEqual(applyTodoClosure(task('research', { todoId: partial })), []);
  assert.equal(dbApi.getProjectTodo(partial)?.progress, 'partial');
});

test('chore and doc close their own idea', () => {
  const [c, d] = [idea(), idea()];
  applyTodoClosure(task('chore', { todoId: c }));
  applyTodoClosure(task('doc', { todoId: d }));
  assert.equal(dbApi.getProjectTodo(c)?.status, 'done');
  assert.equal(dbApi.getProjectTodo(d)?.status, 'done');
});

test('idempotent and one-way: a done idea is never touched, a promoted one closes', () => {
  const done = idea();
  dbApi.updateProjectTodo(done, { status: 'done' });
  const doneAt = dbApi.getProjectTodo(done)!.done_at;
  const { merge } = fullChain(done, 'portabilité : à tester Win/Mac');
  assert.deepEqual(applyTodoClosure(merge), [], 'never touched again');
  assert.equal(dbApi.getProjectTodo(done)?.done_at, doneAt);
  assert.equal(dbApi.getProjectTodo(done)?.status, 'done');

  const promoted = idea();
  dbApi.markProjectTodoPromoted(promoted, randomUUID());
  const chore = task('chore', { todoId: promoted });
  assert.deepEqual(applyTodoClosure(chore), [{ todoId: promoted, progress: 'done' }]);
  assert.deepEqual(applyTodoClosure(chore), [], 'a second pass changes nothing');
  const row = dbApi.getProjectTodo(promoted)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
});

test('an idea deleted since is skipped silently', () => {
  const gone = idea();
  const chore = task('chore', { todoId: gone });
  dbApi.deleteProjectTodo(gone);
  assert.deepEqual(planTodoClosure(chore), []);
  assert.deepEqual(applyTodoClosure(chore), []);
});

test('the post-closure chain applies the closure', async () => {
  const id = idea();
  const chore = task('chore', { todoId: id });
  await runTaskChain(chore.id);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('the work return names the closed idea, and the digest shows it', () => {
  const closed = idea();
  const osOwed = idea();
  const group = randomUUID();
  const a = task('code', { todoId: closed, pipeline: 'code-group', group });
  const b = task('code', { todoId: osOwed, pipeline: 'code-group', group, done: 'portabilité : à tester Win/Mac' });
  const merge = task('merge', { deps: [a.id, b.id], group, sha: true, done: false });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.merger', 'merge');
  dbApi.assignTaskMission(merge.id, missionId);
  dbApi.updateTaskStatus(merge.id, 'DONE', { doneComment: `merged ${SHA}` });
  handleTaskDone(merge.id);
  const msg = dbApi.listInbox(mainAgentNameOrSeed(), { limit: 50 })
    .find((m) => (JSON.parse(m.payload) as { task_id?: string }).task_id === merge.id);
  assert.ok(msg, 'return enqueued');
  const payload = JSON.parse(msg.payload) as { todo_closed?: number[]; todo_progress?: unknown; todo_os_test?: number[] };
  assert.deepEqual(payload.todo_closed, [closed, osOwed]);
  assert.equal(payload.todo_progress, undefined);
  assert.deepEqual(payload.todo_os_test, [osOwed]);
  const digest = JSON.stringify(presentInboxDigest([msg]));
  assert.match(digest, new RegExp(`#${closed}`));
  assert.match(digest, new RegExp(`Win/Mac test to run[^#]*#${osOwed}`));
});

// TODO #462 — one idea split into several root chains closes with the LAST one.

test('two root chains on one idea: the first merge moves it to partial, the second closes it', () => {
  const id = idea();
  const first = fullChain(id);
  const second = task('code', { todoId: id, pipeline: 'full', done: false });
  assert.deepEqual(planTodoClosure(first.merge), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  assert.deepEqual(applyTodoClosure(first.merge), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  let row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'open');
  assert.equal(row.progress, 'partial');
  assert.deepEqual(applyTodoClosure(first.merge), [], 'a second pass changes nothing');

  dbApi.updateTaskStatus(second.id, 'DONE', { doneComment: 'fait\nportabilité : n/a' });
  assert.deepEqual(applyTodoClosure(dbApi.getTask(second.id)!), [], 'the code closure is not a landing');
  const review = task('review', { deps: [second.id], root: second.id, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
  row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
});

test('a BLOCKED sibling holds the idea open, a deleted one no longer exists', () => {
  const id = idea();
  const stuck = task('code', { todoId: id, pipeline: 'full', done: false });
  dbApi.updateTaskStatus(stuck.id, 'BLOCKED', { blockedReason: 'conflit' });
  const { merge } = fullChain(id);
  assert.deepEqual(planTodoClosure(merge), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  dbApi.deleteTask(stuck.id);
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
});

test('sibling chains already landed count, a chore sibling lands at its closure', () => {
  const id = idea();
  const selfMerged = task('code', { todoId: id, pipeline: 'code-self', sha: true, done: `merged ${SHA}` });
  const chore = task('chore', { todoId: id, done: false });
  assert.deepEqual(planTodoClosure(selfMerged), [{ todoId: id, progress: 'partial', landed: 1, total: 2 }]);
  dbApi.updateTaskStatus(chore.id, 'DONE', { doneComment: 'fait' });
  assert.deepEqual(applyTodoClosure(dbApi.getTask(chore.id)!), [{ todoId: id, progress: 'done' }]);
});

test('a research sibling and the chain followers never hold the idea open', () => {
  const id = idea();
  task('research', { todoId: id, done: false });
  task('doc', { todoId: id, done: false });
  const { merge } = fullChain(id);
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
});

test('code-group: the final merge of N slices on one idea closes it at once', () => {
  const id = idea();
  const group = randomUUID();
  const slices = [0, 1, 2].map(() => task('code', { todoId: id, pipeline: 'code-group', group }));
  assert.deepEqual(applyTodoClosure(slices[0]), []);
  const merge = task('merge', { deps: slices.map((s) => s.id), group, sha: true, done: `merged ${SHA}` });
  assert.deepEqual(applyTodoClosure(merge), [{ todoId: id, progress: 'done' }]);
  assert.equal(dbApi.getProjectTodo(id)?.status, 'done');
});

test('an idea already done is never touched, even with open siblings', () => {
  const id = idea();
  dbApi.updateProjectTodo(id, { status: 'done' });
  const doneAt = dbApi.getProjectTodo(id)!.done_at;
  task('code', { todoId: id, pipeline: 'full', done: false });
  const { merge } = fullChain(id);
  assert.deepEqual(applyTodoClosure(merge), []);
  const row = dbApi.getProjectTodo(id)!;
  assert.equal(row.status, 'done');
  assert.equal(row.progress, 'done');
  assert.equal(row.done_at, doneAt);
});

test('partial never moves an idea back from to_test', () => {
  const id = idea();
  dbApi.updateProjectTodo(id, { progress: 'to_test' });
  task('code', { todoId: id, pipeline: 'full', done: false });
  assert.deepEqual(applyTodoClosure(fullChain(id).merge), []);
  assert.equal(dbApi.getProjectTodo(id)?.progress, 'to_test');
});

test('the work return counts the landed chains of a partial idea', () => {
  const id = idea();
  task('code', { todoId: id, pipeline: 'full', done: false });
  const code = task('code', { todoId: id, pipeline: 'full', done: 'fait\nportabilité : n/a' });
  const review = task('review', { deps: [code.id], root: code.id, done: 'verdict: pass' });
  const merge = task('merge', { deps: [review.id], sha: true, done: false });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.merger', 'merge');
  dbApi.assignTaskMission(merge.id, missionId);
  dbApi.updateTaskStatus(merge.id, 'DONE', { doneComment: `merged ${SHA}` });
  handleTaskDone(merge.id);
  const msg = dbApi.listInbox(mainAgentNameOrSeed(), { limit: 50 })
    .find((m) => (JSON.parse(m.payload) as { task_id?: string }).task_id === merge.id);
  assert.ok(msg, 'return enqueued');
  const payload = JSON.parse(msg.payload) as { todo_closed?: number[]; todo_progress?: unknown };
  assert.equal(payload.todo_closed, undefined);
  assert.deepEqual(payload.todo_progress, [{ id, progress: 'partial', landed: 1, total: 2 }]);
  assert.match(JSON.stringify(presentInboxDigest([msg])), new RegExp(`TO DO #${id}: 1/2 chains landed`));
});
