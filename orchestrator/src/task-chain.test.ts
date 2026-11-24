/**
 * Chaining starts from the CLOSING of the task, not from the death of the process.
 *
 * What these tests protect (incident of 2026-08-21): review `98e28f1a`,
 * closed at 09:47:28 with `changes_requested`, only saw its code iteration born
 * at 09:58: 11 min, the 600,000 ms `TIMON_REAP_IDLE_MS` that separates the
 * closing of a task from the `mission_complete` of its mission. Checked here:
 * the immediate trigger on `task_done`, the silence of the late `mission_complete`,
 * the verification → doc order (otherwise a `code` task receives its doc
 * before its review exists), and the integrity of the "mission dead WITHOUT
 * task closing" path.
 *
 * `node --test --import tsx src/task-chain.test.ts` (or `npm test`).
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const HOME = mkdtempSync(join(tmpdir(), 'timon-task-chain-test-'));
process.env.TIMON_HOME = HOME;
const { dbApi, db, CHAIN_DONE, CHAIN_FAILED, CHAIN_NEVER, CHAIN_RUNNING, CHAIN_STALE_MS } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { bus } = await import('./bus.js');
const { runTaskChain, startTaskChain, reconcileUnchainedTasks, MAX_CHAIN_ATTEMPTS } = await import('./task-chain.js');
const { watchMissionComplete } = await import('./dispatcher.js');
const { evaluateGroupCompleteForTask } = await import('./wake.js');
const { reconcileMissingReviews } = await import('./verification-loop.js');
const { openChainBarrier, hasOpenChainBarrier, awaitChainBarriers } = await import('./chain-barrier.js');

type Type = 'code' | 'review' | 'merge' | 'doc' | 'chore';

function mkTask(type: Type, opts: {
  deps?: string[];
  agent?: string;
  project?: string | null;
  groupId?: string | null;
} = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} — volet`, opts.agent ?? 'p.coder', {
    type,
    deps: opts.deps ?? [],
    project: opts.project ?? null,
    groupId: opts.groupId ?? null,
  });
  return id;
}

/** Minimal verification chain: a root code task + a review on it. */
function mkReviewChain(comment: string): { rootId: string; reviewId: string } {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const reviewId = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(reviewId, 1, rootId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: comment });
  return { rootId, reviewId };
}

/** A real git worktree with one commit ahead of the base: `handleCodeDone` only
 *  creates a review on a non-empty diff (`git diff --stat base...HEAD`). */
function mkGitRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'timon-task-chain-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args], {
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  };
  git('init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  writeFileSync(join(repo, 'a.txt'), 'travail\n');
  git('add', '-A');
  git('commit', '-qm', 'travail');
  return repo;
}

function childrenOf(taskId: string, type: Type): string[] {
  return dbApi.listTasks()
    .filter((t) => t.type === type && (JSON.parse(t.deps) as string[]).includes(taskId))
    .map((t) => t.id);
}

test('review changes_requested → code iteration created at closing, without mission_complete', async () => {
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige X"}');
  await runTaskChain(reviewId);
  const next = childrenOf(reviewId, 'code');
  assert.equal(next.length, 1, 'a code task iter+1 must exist immediately');
  assert.equal(dbApi.getTask(next[0])?.iteration, 2);
});

test('replaying the chain creates no duplicate (chain_ran guard)', async () => {
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige Y"}');
  await runTaskChain(reviewId);
  await runTaskChain(reviewId); // e.g. re-closing, reconcile, late mission_complete
  assert.equal(childrenOf(reviewId, 'code').length, 1);
  assert.equal(dbApi.isTaskChainRan(reviewId), true);
});

test('re-dispatching a task rearms its chaining', () => {
  const id = mkTask('code');
  dbApi.setTaskChainState(id, CHAIN_DONE);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.isTaskChainRan(id), false);
});

test('review pass → merge created immediately', async () => {
  const { reviewId } = mkReviewChain('verdict: pass');
  await runTaskChain(reviewId);
  assert.equal(childrenOf(reviewId, 'merge').length, 1);
});

test('terminal task → doc created immediately', async () => {
  // The librarian must exist, otherwise doc-task skips (a deliberate guard).
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  // `chore` and not `merge`: a merge task without `merged_commit_sha` is
  // sent back BLOCKED by the closing guard (merge-sha-guard), so it would
  // never go DONE here.
  const choreId = mkTask('chore');
  dbApi.updateTaskStatus(choreId, 'DONE', { doneComment: 'ops fait' });
  await runTaskChain(choreId);
  assert.equal(childrenOf(choreId, 'doc').length, 1);
});

test('non-terminal task → no doc (the rest already exists)', async () => {
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  const codeId = mkTask('code');
  mkTask('review', { deps: [codeId] });
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);
  assert.equal(childrenOf(codeId, 'doc').length, 0);
});

test('order: the doc of a code task waits for the review to be chained', async () => {
  mkdirSync(join(HOME, 'agents', 'TIMON.librarian'), { recursive: true });
  // Real git worktree: `handleCodeDone` only creates a review on a
  // non-empty diff (git diff --stat base...HEAD), and it is THIS await that, before
  // task-chain.ts, let doc-task win the race and document a code task
  // that was nevertheless going to receive a review (duplicate measured on 2026-08-21).
  const repo = mkGitRepo();

  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, repo, 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);

  assert.equal(childrenOf(codeId, 'review').length, 1, 'the review must be created');
  assert.equal(childrenOf(codeId, 'doc').length, 0, 'no doc on a task that has a review');
});

test('the late mission_complete creates nothing and does not re-emit task_done', async () => {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const reviewId = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(reviewId, 1, rootId);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.reviewer', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(reviewId, missionId); // → IN_PROGRESS, as at dispatch
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'verdict: pass' });
  await runTaskChain(reviewId);
  const before = dbApi.listTasks().length;

  watchMissionComplete();
  startTaskChain();
  let taskDone = 0;
  const spy = (ev: { kind: string }): void => { if (ev.kind === 'task_done') taskDone++; };
  bus.on('event', spy);
  // Ten minutes later: the reaper kills the idle process of the reviewer.
  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0 });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  bus.off('event', spy);

  assert.equal(taskDone, 0, 'a task already DONE does not re-emit task_done');
  assert.equal(dbApi.listTasks().length, before, 'no extra follow-up task');
  assert.equal(dbApi.getTask(reviewId)?.status, 'DONE');
});

test('mission dead WITHOUT task closing: the mission_complete safety net stays intact', () => {
  // The listeners are already wired by the previous test (watchMissionComplete
  // + startTaskChain). Catching up that mission is the ONLY role left to
  // `mission_complete`: without an agent closing, no `task_done` was emitted,
  // so nothing else can get the task out of IN_PROGRESS.
  const id = mkTask('code');
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId); // → IN_PROGRESS

  bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: 'crash' });

  // A crash is a death SUFFERED and requeueable: the task goes back to PENDING with its
  // qualified cause, instead of staying IN_PROGRESS forever.
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.requeue_count, 1);

  // The same path on an already closed task does NOT make it regress.
  const closed = mkTask('code');
  const m2 = randomUUID();
  dbApi.createMission(m2, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(closed, m2);
  dbApi.updateTaskStatus(closed, 'DONE', { doneComment: 'fait' });
  bus.publish({ kind: 'mission_complete', missionId: m2, status: 'failed', exitCode: 1, reason: 'crash' });
  assert.equal(dbApi.getTask(closed)?.status, 'DONE');
});

test('the listener is enough: closing the review chains without any other event', async () => {
  startTaskChain();
  const { reviewId } = mkReviewChain('verdict: changes_requested\n{"suggested_fixes":"corrige Z"}');
  // The chain starts on `setImmediate` (see task-chain.ts: `task_done` is
  // published INSIDE the DB write that sets DONE). One tick is enough,
  // compared with the 600,000 ms of the idle reap.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(childrenOf(reviewId, 'code').length, 1);
});

test('end of batch: the consolidated recap leaves at the closing of the last task', async () => {
  const gid = randomUUID();
  const a = mkTask('chore', { groupId: gid });
  const b = mkTask('chore', { groupId: gid });
  // Without `parent_agent` on the mission, the recap goes to the singleton manager
  // (see orchestratorForTask / managerAgent).
  const pilot = '_main';
  const recaps = (): number => dbApi
    .listInbox(pilot, { status: 'pending', limit: 20 })
    .filter((m) => m.payload.includes('Group complete')).length;

  dbApi.updateTaskStatus(a, 'DONE', { doneComment: 'volet A' });
  await runTaskChain(a);
  assert.equal(dbApi.isGroupNotified(gid), false, 'the batch still has an active task');

  dbApi.updateTaskStatus(b, 'DONE', { doneComment: 'volet B' });
  await runTaskChain(b);
  assert.equal(dbApi.isGroupNotified(gid), true, 'consolidated recap sent without waiting for the reap');
  assert.equal(recaps(), 1);

  // The late `mission_complete` falls back on the same path: no-op.
  evaluateGroupCompleteForTask(b);
  assert.equal(recaps(), 1);
});

test('end of batch: the review and the merge stay in the batch, the recap waits for the merge (TODO #521)', async () => {
  const gid = randomUUID();
  const pilot = '_main';
  const recap = (): string | undefined => dbApi
    .listInbox(pilot, { status: 'pending', limit: 50 })
    .map((m) => m.payload)
    .find((p) => p.includes(gid));
  const codeId = randomUUID();
  dbApi.createTask(codeId, 'code — dernier volet', 'p.coder', { type: 'code', project: 'demo', groupId: gid, pipeline: 'full' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  await runTaskChain(codeId);

  // Before the fix: the review was born outside the batch, the batch looked finished and
  // the recap left here, before any review.
  const [reviewId] = childrenOf(codeId, 'review');
  assert.equal(dbApi.getTask(reviewId)?.group_id, gid, 'the review inherits the batch');
  assert.equal(dbApi.isGroupNotified(gid), false, 'the batch waits for its review');

  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'verdict: pass' });
  await runTaskChain(reviewId);
  const [mergeId] = childrenOf(reviewId, 'merge');
  assert.equal(dbApi.getTask(mergeId)?.group_id, gid, 'the merge inherits the batch');
  assert.equal(dbApi.isGroupNotified(gid), false, 'the batch waits for its merge');
  assert.equal(recap(), undefined);

  dbApi.setTaskMergedSha(mergeId, 'b'.repeat(40));
  dbApi.updateTaskStatus(mergeId, 'DONE', { doneComment: 'merged' });
  await runTaskChain(mergeId);
  assert.equal(dbApi.isGroupNotified(gid), true, 'the recap leaves at the merge');
  assert.match(recap() ?? '', /3 done \/ 0 blocked of 3 tasks/);
});

test('reconcile: a lost chain (restart mid-flight) is replayed', async () => {
  // Task closed while no listener was listening: `task_done` got lost,
  // `chain_ran` stayed at 0. The zombie sweep at boot no longer catches it
  // (the dispatcher exits early on a task already DONE, hence no task_done).
  const { reviewId } = mkReviewChain('verdict: pass');
  assert.equal(dbApi.isTaskChainRan(reviewId), false);

  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1);

  // Replay on a healthy system: the second-curtain guards absorb everything.
  dbApi.setTaskChainState(reviewId, CHAIN_NEVER);
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1, 'still exactly one merge');
});

test('reconcile: tasks closed outside the window are not chained again', async () => {
  // All the tasks closed BEFORE the `chain_ran` migration have the flag at 0:
  // without an age bound, the first boot after deployment would chain again the whole
  // history.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 7 * 60 * 60 * 1000, reviewId);
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 0);
});

test('reconcile: a chain KILLED MID-FLIGHT (flag set, never finished) is replayed', async () => {
  // The case the boolean version of the flag condemned for good: the flag
  // was set before the first await and only lowered by a JS `catch`.
  // A SIGTERM, an OOM (V8 heap cap at 4 GB, chronic here) or a restart between
  // setting and finishing left `chain_ran = 1` on a chain that had produced
  // nothing, and the reconcile only picked up the `0`s.
  // The STATE left by such a death is simulated, not the death itself.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_ran = ?, chain_started_at = ? WHERE id = ?')
    .run(CHAIN_RUNNING, Date.now() - CHAIN_STALE_MS - 1_000, reviewId);

  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 1, 'the lost merge must be caught up');
  assert.equal(dbApi.isTaskChainRan(reviewId), true, 'the replayed chain goes all the way');
});

test('reconcile: a chain REALLY in progress is not doubled', async () => {
  // A recent `CHAIN_RUNNING` is a live chain: picking it up would create the
  // follow-up task twice. Only its age disqualifies it.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_ran = ?, chain_started_at = ? WHERE id = ?')
    .run(CHAIN_RUNNING, Date.now(), reviewId);

  assert.equal(
    dbApi.listTasksNeedingChain(0, Date.now() - CHAIN_STALE_MS).some((t) => t.id === reviewId),
    false,
    'a chain started a second ago is not a dead chain',
  );
  await reconcileUnchainedTasks();
  assert.equal(childrenOf(reviewId, 'merge').length, 0);
});

test('listTasksNeedingChain filters IN SQL: neither finished chains nor outside the window', () => {
  // Measure of 2026-08-21: 1290 DONE tasks in the database, 1262 at chain_ran = 0 and
  // ZERO in the 6 h window. The JS filter materialised all 1290 every
  // 120 s to keep none of them: pure heap churn on a process that has a
  // chronic OOM.
  const fini = mkTask('chore');
  dbApi.updateTaskStatus(fini, 'DONE', { doneComment: 'ok' });
  dbApi.setTaskChainState(fini, CHAIN_DONE);

  const vieux = mkTask('chore');
  dbApi.updateTaskStatus(vieux, 'DONE', { doneComment: 'ok' });
  db.prepare('UPDATE tasks SET updated_at = ? WHERE id = ?')
    .run(Date.now() - 7 * 60 * 60 * 1000, vieux);

  const frais = mkTask('chore');
  dbApi.updateTaskStatus(frais, 'DONE', { doneComment: 'ok' });

  const ids = dbApi
    .listTasksNeedingChain(Date.now() - 6 * 60 * 60 * 1000, Date.now() - CHAIN_STALE_MS)
    .map((t) => t.id);
  assert.ok(ids.includes(frais), 'a closed and unchained task must come out');
  assert.ok(!ids.includes(fini), 'a finished chain never comes back');
  assert.ok(!ids.includes(vieux), 'outside the catch-up window');
});

test('reconcile code-without-review: the missing review is created, only once', async () => {
  // The invariant that was missing: nothing watched the UPSTREAM of the chain. A
  // closed code task whose review never left went off the radar without
  // any signal (the wake-loop assumed "full pipeline ⇒ the review follows").
  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  // Chain deemed played: only the reconcile invariant can still catch up.
  dbApi.setTaskChainState(codeId, CHAIN_DONE);
  assert.equal(childrenOf(codeId, 'review').length, 0);

  await reconcileMissingReviews();
  assert.equal(childrenOf(codeId, 'review').length, 1, 'the missing review must be created');

  // Idempotence: on a healthy system, the rule does NOTHING.
  await reconcileMissingReviews();
  assert.equal(childrenOf(codeId, 'review').length, 1, 'still exactly one review');
});

test('reconcile code-without-review: silent on a code-only pipeline and without a diff', async () => {
  // `code-self` / `code-group`: the user explicitly asked for neither review nor verification
  // loop. The rule must not bring it back through the back door.
  const codeOnly = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeOnly, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeOnly, 'DONE', { doneComment: 'volet' });
  db.prepare("UPDATE tasks SET pipeline = 'code-self' WHERE id = ?").run(codeOnly);

  // Empty diff: nothing to review, so nothing to create (same guard as live).
  const sansDiff = mkTask('code', { project: 'demo' });
  dbApi.updateTaskStatus(sansDiff, 'DONE', { doneComment: 'rien à committer' }); // french-ok: free-text sample data

  await reconcileMissingReviews();
  assert.equal(childrenOf(codeOnly, 'review').length, 0);
  assert.equal(childrenOf(sansDiff, 'review').length, 0);
});

test('barrier: opened SYNCHRONOUSLY on receiving task_done', async () => {
  // The heart of the fix of the bet on git latency: between `task_done` and the end
  // of the chain, the wake-loop must have something to WAIT for. If the barrier
  // were only opened inside the `setImmediate`, the window we
  // claim to close would open again.
  startTaskChain();
  const codeId = mkTask('code', { project: 'demo' });
  dbApi.setTaskWorktree(codeId, mkGitRepo(), 'feat', 'main');
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'code fait' });
  // No tick has been yielded yet: the chain has not even started.
  assert.equal(hasOpenChainBarrier(codeId), true, 'the barrier must be set as soon as the event arrives');
  assert.equal(childrenOf(codeId, 'review').length, 0, 'the chain, for its part, has not run yet');

  // …and waiting for it is enough to see the review, without betting on any delay.
  assert.equal(await awaitChainBarriers([codeId], 15_000), true);
  assert.equal(hasOpenChainBarrier(codeId), false);
  assert.equal(childrenOf(codeId, 'review').length, 1);
});

test('barrier: capped, never blocking, and without effect on unknown ids', async () => {
  // Controlled degradation: if a chain does not lift, the wake-loop decides
  // with the current state of the Kanban; it never freezes.
  // The cap is an `unref()` timer: alone, it lets the event loop
  // drain and node cancels the rest of the file ("Promise resolution is still
  // pending"). This handle holds the loop for the length of the test.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    const bloquee = randomUUID();
    const settle = openChainBarrier(bloquee);
    assert.equal(await awaitChainBarriers([bloquee], 20), false, 'the cap must return');
    settle();
    assert.equal(await awaitChainBarriers([bloquee], 20), true, 'barrier lifted → no more waiting');
    // An id without a barrier waits for nothing (chain already finished, or never started).
    assert.equal(await awaitChainBarriers([randomUUID()], 20), true);
  } finally {
    clearInterval(keepAlive);
  }
});

test('migration: a `chain_ran = 1` inherited from the boolean is NOT replayed', () => {
  // `chain_ran` changed SEMANTICS, not only type: 1 meant
  // "chain finished" under the boolean, it means "started and never finished"
  // under the tri-state. 36 tasks carried this legacy in the database on 2026-08-21;
  // without a migration they would all have been replayed at the first boot,
  // announcing "chain started at 1970-01-01" on healthy chains.
  // Exact discriminant: the old 1 never has a `chain_started_at`, the
  // column not existing when it was written.
  const legacy = mkTask('review');
  dbApi.updateTaskStatus(legacy, 'DONE', { doneComment: 'verdict: pass' });
  db.prepare('UPDATE tasks SET chain_ran = 1, chain_started_at = NULL WHERE id = ?').run(legacy);

  db.exec('UPDATE tasks SET chain_ran = 2 WHERE chain_ran = 1 AND chain_started_at IS NULL');

  const row = dbApi.getTask(legacy);
  assert.equal(row?.chain_ran, CHAIN_DONE, 'l\'ancien 1 devient CHAIN_DONE');
  const candidates = dbApi.listTasksNeedingChain(0, Date.now());
  assert.equal(candidates.some((t) => t.id === legacy), false, 'no longer a replay candidate');
});

test('cap: a chain that fails in a loop is abandoned explicitly, not replayed endlessly', async () => {
  // Without a cap, a DETERMINISTIC failure restarted every 120 s for the
  // 6 h of the catch-up window (~180 mute attempts). The whole rest of the
  // system is bounded at 3; chaining was the only unlimited replay.
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_attempts = ? WHERE id = ?').run(MAX_CHAIN_ATTEMPTS, reviewId);

  await runTaskChain(reviewId);

  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_FAILED, 'abandon explicite');
  assert.equal(childrenOf(reviewId, 'merge').length, 0, 'the chain did not retry');
  const candidates = dbApi.listTasksNeedingChain(0, Date.now());
  assert.equal(candidates.some((t) => t.id === reviewId), false, 'CHAIN_FAILED sort du rejeu');
});

test('cap: the counter goes back to zero on re-dispatch and on a successful chain', async () => {
  const { reviewId } = mkReviewChain('verdict: pass');
  db.prepare('UPDATE tasks SET chain_attempts = 2 WHERE id = ?').run(reviewId);

  // Under the cap: the chain runs, succeeds, and clears the counter.
  await runTaskChain(reviewId);
  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_DONE);
  assert.equal(dbApi.taskChainAttempts(reviewId), 0, 'a successful chain does not drag its failures along');

  // Re-dispatch: chaining rearmed, even after a definitive abandon.
  dbApi.setTaskChainState(reviewId, CHAIN_FAILED);
  db.prepare('UPDATE tasks SET chain_attempts = ? WHERE id = ?').run(MAX_CHAIN_ATTEMPTS, reviewId);
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.reviewer', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(reviewId, missionId);
  assert.equal(dbApi.getTask(reviewId)?.chain_ran, CHAIN_NEVER);
  assert.equal(dbApi.taskChainAttempts(reviewId), 0);
});

test('code iteration: takes over the LLM of the reviewed iteration (backend, model, fallback, permissions)', async () => {
  const rootId = randomUUID();
  dbApi.createTask(rootId, 'code — volet', 'p.coder', {
    type: 'code',
    backendOverride: 'codex',
    modelOverride: 'gpt-5.6-sol',
    fallbackBackendOverride: 'claude',
    fallbackModelOverride: 'opus',
    permissionModeOverride: 'auto',
  });
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const review1 = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(review1, 1, rootId);
  dbApi.updateTaskStatus(review1, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review1);

  const [iter2Id] = childrenOf(review1, 'code');
  const iter2 = dbApi.getTask(iter2Id);
  assert.equal(iter2?.backend_override, 'codex');
  assert.equal(iter2?.model_override, 'gpt-5.6-sol');
  assert.equal(iter2?.fallback_backend_override, 'claude');
  assert.equal(iter2?.fallback_model_override, 'opus');
  assert.equal(iter2?.permission_mode_override, 'auto');

  // The pilot reroutes iter:2 by hand: iter:3 keeps that choice, not the root one.
  dbApi.updateTask(iter2Id, { backendOverride: 'claude', modelOverride: 'sonnet' });
  dbApi.updateTaskStatus(iter2Id, 'DONE', { doneComment: 'code fait' });
  const review2 = mkTask('review', { deps: [iter2Id] });
  dbApi.setTaskVerificationMeta(review2, 2, rootId);
  dbApi.updateTaskStatus(review2, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review2);

  const iter3 = dbApi.getTask(childrenOf(review2, 'code')[0]);
  assert.equal(iter3?.iteration, 3);
  assert.equal(iter3?.backend_override, 'claude');
  assert.equal(iter3?.model_override, 'sonnet');
  // The review and the merge copy nothing: they resolve on their role.
  assert.equal(dbApi.getTask(review1)?.backend_override, null);
});

test('code iteration: stays in the batch and keeps the pipeline of the root', async () => {
  const groupId = randomUUID();
  const rootId = randomUUID();
  dbApi.createTask(rootId, 'code — volet groupé', 'p.coder', { type: 'code', groupId, pipeline: 'full' }); // french-ok: free-text sample data
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code fait' });
  const review = mkTask('review', { deps: [rootId] });
  dbApi.setTaskVerificationMeta(review, 1, rootId);
  dbApi.updateTaskStatus(review, 'DONE', { doneComment: 'verdict: changes_requested' });
  await runTaskChain(review);

  const iter2 = dbApi.getTask(childrenOf(review, 'code')[0]);
  assert.equal(iter2?.group_id, groupId, 'outside the batch, the end of batch would leave without it');
  assert.equal(iter2?.pipeline, 'full');
  assert.equal(dbApi.groupHasActiveTasks(groupId), true, 'the batch waits for the iteration');
});
