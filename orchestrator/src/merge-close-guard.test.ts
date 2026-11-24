/**
 * TODO #1012 — the daemon proves a merge before a `merge` task goes DONE (a
 * merger closed on the sha of the base's previous merge while the branch
 * stayed outside it), and a `full` code task whose coder merged the branch
 * already still gets a review of its commits, never an empty diff.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi, type TaskRow } from './db.js';
import { agentDir } from './paths.js';
import { writeRoles } from './projects.js';
import { bus } from './bus.js';
import { reconcileOrphanedTasks, resolveWorktree, watchMissionComplete } from './dispatcher.js';
import { runVerificationChain } from './verification-loop.js';
import { disposeWorktree, type WorktreeInfo } from './worktree.js';
import { registerRoutes } from './plugins-bundled/kanban/routes.js';
import { registerRoutes as registerCodeRoutes } from './plugins-bundled/kanban-code/routes.js';
import { createDaemonAuthMiddleware } from './plugins-bundled/http/auth.js';
await import('../tests/helpers/claude-provider.js');

const app = express();
// One connection per request. The repositories are built with synchronous git
// calls, which hold this process, server included, for seconds on a loaded
// Windows machine: the server then drops an idle keep-alive socket at the very
// moment fetch reuses it, and the request dies with ECONNRESET.
app.use((_req, res, next) => { res.setHeader('connection', 'close'); next(); });
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'guard-test', required: true }));
registerRoutes(app);
registerCodeRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type ErrorJson = { error?: string; code?: string; params?: Record<string, unknown> };

async function call(method: string, path: string, body: unknown): Promise<{ status: number; json: ErrorJson }> {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: 'Bearer guard-test' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as ErrorJson };
}

const closeDone = (id: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/tasks/close', { id, outcome: 'done', comment: 'merged', ...extra });

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
}

function commitFile(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** `main` with one commit, and a `feature` branch one commit ahead of it. */
function makeRepo(): { repo: string; mainHead: string; featureHead: string } {
  const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
  mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.invalid');
  git(repo, 'config', 'user.name', 'T');
  // Unique content: two repositories built in the same second would otherwise
  // share their shas, which the guard rightly takes for one merge proving two tasks.
  const mainHead = commitFile(repo, 'a.txt', `one ${randomUUID()}`);
  git(repo, 'checkout', '-q', '-b', 'feature');
  const featureHead = commitFile(repo, 'feature.txt', 'feature work');
  git(repo, 'checkout', '-q', 'main');
  return { repo, mainHead, featureHead };
}

/** A chained merge: code → review → merge, the review carrying the coder's branch. */
function mergeChain(repo: string): { merge: TaskRow; code: TaskRow } {
  const codeId = randomUUID();
  dbApi.createTask(codeId, 'feature', 'witness', { type: 'code', baseBranch: 'main' });
  dbApi.setTaskWorktree(codeId, repo, 'feature', 'main');
  const reviewId = randomUUID();
  dbApi.createTask(reviewId, 'review feature', 'witness', { type: 'review', deps: [codeId], baseBranch: 'main' });
  dbApi.setTaskWorktree(reviewId, repo, 'feature', 'main');
  dbApi.setTaskVerificationMeta(reviewId, 1, codeId);
  const mergeId = randomUUID();
  dbApi.createTask(mergeId, 'merge feature', 'witness', { type: 'merge', deps: [reviewId], baseBranch: 'main' });
  dbApi.setTaskWorktree(mergeId, repo, `timon/merge/${mergeId}`, 'main');
  return { merge: dbApi.getTask(mergeId)!, code: dbApi.getTask(codeId)! };
}

function mergeFeature(repo: string): string {
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge: integrate the task branch into main', 'feature');
  return git(repo, 'rev-parse', 'HEAD');
}

test('a merge closed while its branch is outside the base is refused, and nothing is written', async () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  const r = await closeDone(merge.id, { merged_sha: mainHead });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  assert.match(r.json.error ?? '', /branch feature .* is not contained in main/);
  const after = dbApi.getTask(merge.id)!;
  assert.notEqual(after.status, 'DONE');
  assert.equal(after.merged_commit_sha, null);
});

test('the CLI path (sha recorded first) is refused the same way', async () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  const r = await call('POST', `/api/tasks/${merge.id}/merged-sha`, { sha: mainHead });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  // The board translates the code with `{detail}`: without it, the template shows its braces.
  assert.deepEqual(r.json.params, { detail: r.json.error });
  assert.equal(dbApi.getTask(merge.id)!.merged_commit_sha, null);
});

test('a full sha written only in the comment does not bypass the guard', async () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  const r = await call('PUT', `/api/tasks/${merge.id}`, { status: 'DONE', done_comment: `fast-forward already applied (${mainHead})` });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  assert.notEqual(dbApi.getTask(merge.id)!.status, 'DONE');
});

test('a sha already carried by another task is refused, abbreviated or not', async () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const merged = mergeFeature(repo);
  const other = randomUUID();
  dbApi.createTask(other, 'an earlier merge', 'witness', { type: 'merge' });
  dbApi.setTaskMergedSha(other, merged.slice(0, 10));
  const r = await closeDone(merge.id, { merged_sha: merged });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  assert.match(r.json.error ?? '', new RegExp(`already the merge of task ${other}`));
  assert.notEqual(dbApi.getTask(merge.id)!.status, 'DONE');
});

test('the task of another user that carries the sha is not named', async () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const merged = mergeFeature(repo);
  const other = randomUUID();
  dbApi.createTask(other, 'a secret title', 'witness', { type: 'merge', ownerUserId: randomUUID() });
  dbApi.setTaskMergedSha(other, merged);
  const r = await closeDone(merge.id, { merged_sha: merged });
  assert.equal(r.status, 409);
  assert.match(r.json.error ?? '', /already the merge of another task/);
  assert.doesNotMatch(r.json.error ?? '', new RegExp(`${other}|a secret title`));
});

test('a sha in the base that does not contain the branch is refused', async () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  mergeFeature(repo);
  const r = await closeDone(merge.id, { merged_sha: mainHead });
  assert.equal(r.status, 409);
  assert.match(r.json.error ?? '', /does not contain branch feature/);
});

test('a real merge is accepted with its sha', async () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const merged = mergeFeature(repo);
  const r = await closeDone(merge.id, { merged_sha: merged });
  assert.equal(r.status, 200, r.json.error);
  const after = dbApi.getTask(merge.id)!;
  assert.equal(after.status, 'DONE');
  assert.equal(after.merged_commit_sha, merged);
});

test('a branch already in the base closes on the sha of its head', async () => {
  const { repo, featureHead } = makeRepo();
  const { merge } = mergeChain(repo);
  git(repo, 'merge', '-q', '--ff-only', 'feature');
  const r = await closeDone(merge.id, { merged_sha: featureHead });
  assert.equal(r.status, 200, r.json.error);
  assert.equal(dbApi.getTask(merge.id)!.status, 'DONE');
});

test('what git cannot decide keeps the former behaviour: a deleted source branch is let through', async () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  git(repo, 'branch', '-D', 'feature');
  const r = await closeDone(merge.id, { merged_sha: mainHead });
  assert.equal(r.status, 200, r.json.error);
  assert.equal(dbApi.getTask(merge.id)!.status, 'DONE');
});

// ── code-group: several source branches already in the base (TODO #1053) ──

/**
 * A `code-group` merge hanging off two code tasks, whose branches `group-a` and
 * `group-b` both start from `main`. `merged` lists the ones merged into `main`
 * before the merge task closes; the base's head is then the merge of another task.
 */
function groupMerge(merged: readonly ('group-a' | 'group-b')[]): { merge: TaskRow; baseHead: string; other: string } {
  const { repo } = makeRepo();
  const codeIds: string[] = [];
  for (const branch of ['group-a', 'group-b'] as const) {
    git(repo, 'checkout', '-q', '-b', branch, 'main');
    commitFile(repo, `${branch}.txt`, `${branch} work`);
    git(repo, 'checkout', '-q', 'main');
    const id = randomUUID();
    dbApi.createTask(id, `${branch} work`, 'witness', { type: 'code', baseBranch: 'main', pipeline: 'code-group' });
    dbApi.setTaskWorktree(id, repo, branch, 'main');
    codeIds.push(id);
  }
  for (const branch of merged) git(repo, 'merge', '-q', '--no-ff', '-m', `merge: ${branch}`, branch);
  const baseHead = git(repo, 'rev-parse', 'main');
  const other = randomUUID();
  dbApi.createTask(other, 'the merge that moved main', 'witness', { type: 'merge' });
  dbApi.setTaskMergedSha(other, baseHead);
  const mergeId = randomUUID();
  dbApi.createTask(mergeId, 'merge the group', 'witness', { type: 'merge', deps: codeIds, baseBranch: 'main' });
  dbApi.setTaskWorktree(mergeId, repo, `timon/merge/${mergeId}`, 'main');
  return { merge: dbApi.getTask(mergeId)!, baseHead, other };
}

test('a code-group merge whose branches were all in the base closes on the sha of the base', async () => {
  const { merge, baseHead } = groupMerge(['group-a', 'group-b']);
  const r = await closeDone(merge.id, { merged_sha: baseHead });
  assert.equal(r.status, 200, r.json.error);
  const after = dbApi.getTask(merge.id)!;
  assert.equal(after.status, 'DONE');
  assert.equal(after.merged_commit_sha, baseHead);
});

test('a code-group merge with one branch outside the base still cannot borrow another task\'s sha', async () => {
  const { merge, baseHead, other } = groupMerge(['group-a']);
  const r = await closeDone(merge.id, { merged_sha: baseHead });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  assert.match(r.json.error ?? '', new RegExp(`already the merge of task ${other}`));
  assert.notEqual(dbApi.getTask(merge.id)!.status, 'DONE');
});

test('a code-group merge cannot borrow a sha that misses one of its branches', async () => {
  const { merge } = groupMerge(['group-a', 'group-b']);
  // The head of `group-a` is in the base, carried by another task, and lacks `group-b`.
  const groupAHead = git(dbApi.getTask(merge.id)!.worktree_path!, 'rev-parse', 'group-a');
  const holder = randomUUID();
  dbApi.createTask(holder, 'an earlier merge', 'witness', { type: 'merge' });
  dbApi.setTaskMergedSha(holder, groupAHead);
  const r = await closeDone(merge.id, { merged_sha: groupAHead });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'merge_not_proven');
  assert.notEqual(dbApi.getTask(merge.id)!.status, 'DONE');
});

// ── Full pipeline: the coder merged the branch already ─────────────────────

const PROJECT = 'guard';

function mkAgent(name: string, cwd: string, role: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role, project: PROJECT }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

/**
 * A `full` code task on a real worktree: another task lands on `main`, the
 * branch is refreshed with it, the coder commits, then fast-forwards `main`
 * onto the branch itself.
 */
async function selfMergedCode(): Promise<{ task: TaskRow; wt: WorktreeInfo; repo: string }> {
  const { repo } = makeRepo();
  const coder = `guard.coder-${randomUUID().slice(0, 8)}`;
  mkAgent(coder, repo, 'coder');
  const id = randomUUID();
  dbApi.createTask(id, 'self merged feature', coder, { type: 'code', project: PROJECT, baseBranch: 'main' });
  const wt = await resolveWorktree(dbApi.getTask(id)!);
  assert.ok(wt);
  commitFile(repo, 'other-task.txt', 'another task');
  git(wt.path, 'merge', '-q', '--no-edit', '-m', 'merge: bring main into the task branch', 'main');
  commitFile(wt.path, 'coder-one.txt', 'coder one');
  commitFile(wt.path, 'coder-two.txt', 'coder two');
  git(repo, 'merge', '-q', '--ff-only', wt.branch);
  return { task: dbApi.getTask(id)!, wt, repo };
}

test('a full code task already merged by its coder gets a review of its own commits', async () => {
  writeRoles(PROJECT, { review: { agent: 'guard.reviewer', backend: 'claude', model: 'sonnet' } });
  const { task, wt, repo } = await selfMergedCode();
  mkAgent('guard.reviewer', repo, 'reviewer');
  try {
    const r = await closeDone(task.id);
    assert.equal(r.status, 200, r.json.error);
    const closed = dbApi.getTask(task.id)!;
    assert.match(closed.done_comment ?? '', /already contained in main: its 2 own commit/);
    await runVerificationChain(closed);
    const review = dbApi.listTasks().find((t) => t.type === 'review' && t.deps.includes(task.id));
    assert.ok(review, 'review created despite an empty base...HEAD');
    const brief = review.description ?? '';
    assert.match(brief, /Branch already merged into `main`/);
    assert.match(brief, /git log -p --first-parent --no-merges [0-9a-f]{40}\.\.[0-9a-f]{40}/);
    assert.match(brief, /coder-one\.txt/);
    assert.match(brief, /coder-two\.txt/);
    // The base's work came in through the refresh merge: not this coder's.
    assert.doesNotMatch(brief, /other-task\.txt/);
  } finally {
    await disposeWorktree(wt, true);
  }
});

test('a full code task already merged whose start cannot be found is refused DONE', async () => {
  const { task, wt, repo } = await selfMergedCode();
  try {
    git(repo, 'reflog', 'expire', '--expire=all', '--all');
    const r = await closeDone(task.id);
    assert.equal(r.status, 409);
    assert.equal(r.json.code, 'branch_unreviewable');
    assert.notEqual(dbApi.getTask(task.id)!.status, 'DONE');
  } finally {
    await disposeWorktree(wt, true);
  }
});

// ── Automatic close: the mission ended without the agent closing (TODO #1053) ──

/** Gives the task a dispatched mission (IN_PROGRESS), as the dispatcher would. */
function dispatch(task: TaskRow): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, task.agent_name, task.title);
  dbApi.assignTaskMission(task.id, missionId);
  return missionId;
}

function missionCompletes(missionId: string): void {
  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0 });
}

test('an automatic close of a merge whose branch is outside the base goes BLOCKED, not DONE', () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const stop = watchMissionComplete();
  try {
    missionCompletes(dispatch(merge));
    const after = dbApi.getTask(merge.id)!;
    assert.equal(after.status, 'BLOCKED');
    assert.match(after.blocked_reason ?? '', /automatic close was refused/);
    assert.match(after.blocked_reason ?? '', /branch feature .* is not contained in main/);
    const code = JSON.parse(after.blocked_reason_code ?? 'null') as { code: string; params: { refusal: string } };
    assert.equal(code.code, 'task_auto_close_refused');
    assert.match(code.params.refusal, /branch feature .* is not contained in main/);
  } finally { stop(); }
});

test('an automatic close of a merge on a borrowed sha goes BLOCKED', () => {
  const { repo, mainHead } = makeRepo();
  const { merge } = mergeChain(repo);
  mergeFeature(repo);
  // The agent wrote a sha in its comment but never closed: the guard reads it there.
  dbApi.updateTaskStatus(merge.id, 'IN_PROGRESS', { doneComment: `merged at ${mainHead}` });
  const stop = watchMissionComplete();
  try {
    missionCompletes(dispatch(dbApi.getTask(merge.id)!));
    const after = dbApi.getTask(merge.id)!;
    assert.equal(after.status, 'BLOCKED');
    assert.match(after.blocked_reason ?? '', /does not contain branch feature/);
    assert.equal(after.done_comment, `merged at ${mainHead}`, 'the agent\'s comment is kept');
  } finally { stop(); }
});

test('an automatic close of a proven merge still goes DONE', () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const merged = mergeFeature(repo);
  dbApi.updateTaskStatus(merge.id, 'IN_PROGRESS', { doneComment: `merged at ${merged}` });
  const stop = watchMissionComplete();
  try {
    missionCompletes(dispatch(dbApi.getTask(merge.id)!));
    const after = dbApi.getTask(merge.id)!;
    assert.equal(after.status, 'DONE', after.blocked_reason ?? '');
    assert.equal(after.merged_commit_sha, merged);
  } finally { stop(); }
});

test('an automatic close of a full code task already merged with no known start goes BLOCKED', async () => {
  const { task, wt, repo } = await selfMergedCode();
  const stop = watchMissionComplete();
  try {
    git(repo, 'reflog', 'expire', '--expire=all', '--all');
    missionCompletes(dispatch(task));
    const after = dbApi.getTask(task.id)!;
    assert.equal(after.status, 'BLOCKED');
    assert.match(after.blocked_reason ?? '', /Code guard: branch .* is already contained in main/);
  } finally {
    stop();
    await disposeWorktree(wt, true);
  }
});

test('an automatic close of a full code task already merged whose start is known goes DONE', async () => {
  const { task, wt } = await selfMergedCode();
  const stop = watchMissionComplete();
  try {
    missionCompletes(dispatch(task));
    assert.equal(dbApi.getTask(task.id)!.status, 'DONE');
  } finally {
    stop();
    await disposeWorktree(wt, true);
  }
});

test('an orphan merge reconciled at boot is checked like a live automatic close', async () => {
  const { repo } = makeRepo();
  const { merge } = mergeChain(repo);
  const missionId = dispatch(merge);
  dbApi.finishMission(missionId, 'completed', 0);
  await reconcileOrphanedTasks();
  const after = dbApi.getTask(merge.id)!;
  assert.equal(after.status, 'BLOCKED');
  assert.match(after.blocked_reason ?? '', /branch feature .* is not contained in main/);
});
