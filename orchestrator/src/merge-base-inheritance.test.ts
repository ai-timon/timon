/**
 * A `merge` inherits the base of its code task and advances THAT branch, never
 * the repo's active one (series SDK API 10, 18/10/2026: the merges had
 * `base_branch = NULL`, the shared repo sat on a feature branch, and four merges
 * were about to land there instead of on `main`).
 *
 * `npm test -- src/merge-base-inheritance.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dbApi, type TaskRow } from './db.js';
import { writeRoles } from './projects.js';
import { agentDir } from './paths.js';
import { inheritedBase, resolveWorktree, worktreeDirective } from './dispatcher.js';
import { runTaskChain } from './task-chain.js';
import { maybeCreateDocTask } from './doc-task.js';
import { disposeWorktree, type WorktreeInfo } from './worktree.js';
await import('../tests/helpers/claude-provider.js');


const PROJECT = 'basey';
writeRoles(PROJECT, {
  review: { agent: 'basey.reviewer', backend: 'claude', model: 'sonnet' },
  merge: { agent: 'basey.merger', backend: 'claude', model: 'sonnet' },
  doc: { agent: 'basey.librarian', backend: 'claude', model: 'sonnet' },
});

function mkAgent(name: string, cwd: string, role: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role, project: PROJECT }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** Repo on `feat/active`, with `main` behind it — the 18/10/2026 setup. */
function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-merge-base-'));
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'init');
  git(repo, 'checkout', '-b', 'feat/active');
  writeFileSync(join(repo, 'wip.txt'), 'wip\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'wip on the feature branch');
  return repo;
}

function mkTask(type: TaskRow['type'], agent: string, deps: string[] = [], base?: string): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, agent, { type, deps, project: PROJECT, baseBranch: base });
  return id;
}

function child(type: TaskRow['type'], parentId: string): TaskRow | undefined {
  return dbApi.listTasks().find((t) => t.type === type && t.deps.includes(parentId));
}

test('createTask records the base given by the orchestrator', () => {
  const id = mkTask('chore', 'basey.coder', [], 'main');
  assert.equal(dbApi.getTask(id)?.base_branch, 'main');
  assert.equal(dbApi.getTask(mkTask('chore', 'basey.coder'))?.base_branch, null);
});

test('review of a code task inherits its base; the merge then inherits the root base', async () => {
  const repo = mkRepo();
  const worktrees: WorktreeInfo[] = [];
  try {
    mkAgent('basey.coder', repo, 'coder');
    mkAgent('basey.reviewer', repo, 'reviewer');
    mkAgent('basey.merger', repo, 'merger');
    const codeId = mkTask('code', 'basey.coder', [], 'main');
    const wt = await resolveWorktree(dbApi.getTask(codeId)!);
    assert.ok(wt);
    worktrees.push(wt);
    assert.equal(wt.base, 'main');
    writeFileSync(join(wt.path, 'feature.txt'), 'feature\n');
    git(wt.path, 'add', '.');
    git(wt.path, '-c', 'user.name=T', '-c', 'user.email=t@x.invalid', 'commit', '-m', 'feature');
    dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: 'done' });
    await runTaskChain(codeId);

    const review = child('review', codeId);
    assert.ok(review, 'the code task gets its review');
    assert.equal(review.base_branch, 'main');

    dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
    await runTaskChain(review.id);
    const merge = child('merge', review.id);
    assert.ok(merge, 'a passing review gets its merge');
    assert.equal(merge.base_branch, 'main');
  } finally {
    for (const wt of worktrees) await disposeWorktree(wt, true);
    rmSync(join(repo, '..'), { recursive: true, force: true });
  }
});

test('the doc task keeps the base of the task it documents', async () => {
  mkAgent('basey.librarian', tmpdir(), 'librarian');
  const id = mkTask('chore', 'basey.coder', [], 'main');
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'done' });
  await maybeCreateDocTask(dbApi.getTask(id)!);
  assert.equal(child('doc', id)?.base_branch, 'main');
});

test('inheritedBase walks the deps upward, group merge included', () => {
  const a = mkTask('code', 'basey.coder', [], 'release/1.x');
  const b = mkTask('code', 'basey.coder');
  const review = mkTask('review', 'basey.reviewer', [b]);
  const groupMerge = mkTask('merge', 'basey.merger', [b, a]);
  assert.equal(inheritedBase(dbApi.getTask(groupMerge)!), 'release/1.x');
  assert.equal(inheritedBase(dbApi.getTask(review)!), null);
  assert.equal(inheritedBase(dbApi.getTask(mkTask('merge', 'basey.merger'))!), null);
});

test('a merge without its own base takes its code task base, not the active branch', async () => {
  const repo = mkRepo();
  const worktrees: WorktreeInfo[] = [];
  try {
    mkAgent('basey.merger', repo, 'merger');
    const code = mkTask('code', 'basey.coder', [], 'main');
    const review = mkTask('review', 'basey.reviewer', [code]);
    const merge = mkTask('merge', 'basey.merger', [review]);
    assert.equal(dbApi.getTask(merge)?.base_branch, null);
    const wt = await resolveWorktree(dbApi.getTask(merge)!);
    assert.ok(wt);
    worktrees.push(wt);
    assert.equal(wt.base, 'main');
    assert.equal(dbApi.getTask(merge)?.base_branch, 'main');
    // Started from `main`: the feature branch's commit is not in it.
    assert.equal(git(wt.path, 'log', '--format=%s', '-1'), 'init');
  } finally {
    for (const wt of worktrees) await disposeWorktree(wt, true);
    rmSync(join(repo, '..'), { recursive: true, force: true });
  }
});

test('no base known anywhere: the merge still falls back on the active branch', async () => {
  const repo = mkRepo();
  const worktrees: WorktreeInfo[] = [];
  try {
    mkAgent('basey.merger', repo, 'merger');
    const merge = mkTask('merge', 'basey.merger');
    const wt = await resolveWorktree(dbApi.getTask(merge)!);
    assert.ok(wt);
    worktrees.push(wt);
    assert.equal(wt.base, 'feat/active');
  } finally {
    for (const wt of worktrees) await disposeWorktree(wt, true);
    rmSync(join(repo, '..'), { recursive: true, force: true });
  }
});

const fakeWt = (base: string): WorktreeInfo => ({
  taskId: 't', path: '/wt/t', branch: 'timon/merge/t', base, sourceRepo: '/repo',
});

test('brief: base ≠ active branch advances the base by reference, never ff-only on the active one', () => {
  const task = dbApi.getTask(mkTask('merge', 'basey.merger'))!;
  const brief = worktreeDirective(task, fakeWt('main'), 'feat/setup-polish');
  assert.match(brief, /git -C \/repo push \. timon\/merge\/t:main/);
  assert.doesNotMatch(brief, /merge --ff-only/);
  assert.match(brief, /feat\/setup-polish/);
  assert.match(brief, /rev-parse main/);
});

test('brief: base = active branch keeps the ff-only, then reads the sha back', () => {
  const task = dbApi.getTask(mkTask('merge', 'basey.merger'))!;
  const brief = worktreeDirective(task, fakeWt('main'), 'main');
  assert.match(brief, /git -C \/repo merge --ff-only timon\/merge\/t/);
  assert.doesNotMatch(brief, /push \./);
  assert.match(brief, /git -C \/repo rev-parse main\ngit rev-parse timon\/merge\/t/);
});

// A detached HEAD in the main repo used to take the ff-only: it moved the
// user's HEAD and left the base where it was.
test('brief: a detached or unreadable HEAD moves the base by reference, never ff-only', () => {
  const task = dbApi.getTask(mkTask('merge', 'basey.merger'))!;
  for (const active of [null, undefined]) {
    const brief = worktreeDirective(task, fakeWt('main'), active);
    assert.match(brief, /git -C \/repo push \. timon\/merge\/t:main/, `active=${active}`);
    assert.doesNotMatch(brief, /merge --ff-only/, `active=${active}`);
    assert.match(brief, /detached HEAD/, `active=${active}`);
  }
});
