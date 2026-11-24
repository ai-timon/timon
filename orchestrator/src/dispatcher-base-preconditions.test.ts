/**
 * A code or merge task never starts without its base, and never in the shared
 * checkout (`docs/KANBAN-PR-PIPELINE.md` §2.2, §3.4). An integration branch is
 * created from the remote, fail closed, and how the chain lands is frozen on
 * every task of the chain.
 *
 * `npm test -- src/dispatcher-base-preconditions.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The bare remotes live under the system temporary folder: the daemon's git
// accepts such a local remote only when no filesystem fence is configured.
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));

const { dbApi } = await import('./db.js');
type TaskRow = import('./db.js').TaskRow;
const { writeRoles } = await import('./projects.js');
const { agentDir } = await import('./paths.js');
const {
  blockIfBaseUnavailable, blockIfSharedCheckout, inheritedIntegration, pipelineDirective, resolveWorktree,
} = await import('./dispatcher.js');
const { runVerificationChain } = await import('./verification-loop.js');
const { disposeWorktree } = await import('./worktree.js');
const { decodeDaemonMessage } = await import('./daemon-message.js');
await import('../tests/helpers/claude-provider.js');

const PROJECT = 'precond';
writeRoles(PROJECT, {
  review: { agent: 'precond.reviewer', backend: 'claude', model: 'sonnet' },
  merge: { agent: 'precond.merger', backend: 'claude', model: 'sonnet' },
});

function mkAgent(name: string, cwd: string, role: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role, project: PROJECT }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function commit(repo: string, file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** The user's checkout, on `main` with uncommitted work, and a bare `origin`
 *  one commit ahead of it. */
function mkRepo(): { repo: string; bare: string; remoteMain: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-precond-'));
  const repo = join(dir, 'repo');
  const bare = join(dir, 'remote.git');
  const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'remote', 'add', 'origin', bare);
  commit(repo, 'a.txt', 'init');
  git(repo, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.name', 'Test');
  git(other, 'config', 'user.email', 'test@example.invalid');
  const remoteMain = commit(other, 'b.txt', 'landed elsewhere');
  git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(join(repo, 'wip.txt'), 'uncommitted\n');
  return { repo, bare, remoteMain, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function mkTask(
  type: TaskRow['type'],
  agent: string,
  opts: { deps?: string[]; base?: string; mode?: string; baseRef?: string; pipeline?: string } = {},
): TaskRow {
  const id = randomUUID();
  dbApi.createTask(id, `${type} fixture`, agent, {
    type, project: PROJECT, deps: opts.deps ?? [], baseBranch: opts.base,
    integrationMode: opts.mode, baseRef: opts.baseRef, pipeline: opts.pipeline,
  });
  return dbApi.getTask(id)!;
}

function blockedCode(id: string): string | undefined {
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'BLOCKED');
  return decodeDaemonMessage(task.blocked_reason_code)?.code;
}

test('integration branch: created from the remote, recorded, and the worktree starts on it', async () => {
  const { repo, remoteMain, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    const status = git(repo, 'status', '--porcelain');
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr', baseRef: 'origin/main' });

    assert.equal(await blockIfBaseUnavailable(task), false);
    assert.equal(git(repo, 'rev-parse', 'feat/topic'), remoteMain);
    assert.equal(git(repo, 'branch', '--show-current'), 'main');
    assert.equal(git(repo, 'status', '--porcelain'), status);
    const row = dbApi.getIntegration(repo, 'feat/topic');
    assert.ok(row);
    assert.equal(row.remote, 'origin');
    assert.equal(row.target, 'main');
    assert.equal(row.mode, 'pr');
    assert.equal(row.state, 'branch');
    assert.equal(row.base_sha, remoteMain);

    const wt = await resolveWorktree(task);
    assert.ok(wt);
    try {
      assert.equal(git(wt.path, 'rev-parse', 'HEAD'), remoteMain);
      // Dispatched again: the branch is kept, the row is not duplicated.
      assert.equal(await blockIfBaseUnavailable(dbApi.getTask(task.id)!), false);
      assert.equal(dbApi.getIntegration(repo, 'feat/topic')?.id, row.id);
    } finally {
      await disposeWorktree(wt, true);
    }
  } finally {
    cleanup();
  }
});

test('integration branch: an unreachable remote blocks the task, nothing is cut locally', async () => {
  const { repo, bare, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    rmSync(bare, { recursive: true, force: true });
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'branch', baseRef: 'origin/main' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.equal(blockedCode(task.id), 'integration_branch_unavailable');
    assert.match(dbApi.getTask(task.id)!.blocked_reason ?? '', /never cut from the local base/);
    assert.throws(() => git(repo, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/topic'));
  } finally {
    cleanup();
  }
});

test('integration branch: a target missing on the remote blocks the task', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    git(repo, 'branch', 'develop');
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr', baseRef: 'origin/develop' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.equal(blockedCode(task.id), 'integration_branch_unavailable');
    assert.match(dbApi.getTask(task.id)!.blocked_reason ?? '', /has no branch develop/);
  } finally {
    cleanup();
  }
});

test('integration branch: a repository without a remote blocks the task', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    git(repo, 'remote', 'remove', 'origin');
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr', baseRef: 'origin/main' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.equal(blockedCode(task.id), 'integration_branch_unavailable');
    assert.match(dbApi.getTask(task.id)!.blocked_reason ?? '', /no remote/);
  } finally {
    cleanup();
  }
});

test('integration branch: an existing one is kept, even with the remote gone', async () => {
  const { repo, bare, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    git(repo, 'branch', 'feat/topic');
    const tip = git(repo, 'rev-parse', 'feat/topic');
    rmSync(bare, { recursive: true, force: true });
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr', baseRef: 'origin/main' });
    assert.equal(await blockIfBaseUnavailable(task), false);
    assert.equal(git(repo, 'rev-parse', 'feat/topic'), tip);
    assert.equal(dbApi.getIntegration(repo, 'feat/topic')?.base_sha, null);
  } finally {
    cleanup();
  }
});

test('integration mode without its remote ref blocks the task', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    const task = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.equal(blockedCode(task.id), 'integration_branch_unset');
  } finally {
    cleanup();
  }
});

test('local mode: a base missing from the repository blocks the task', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    const task = mkTask('code', 'precond.coder', { base: 'feat/never-created' });
    assert.equal(await blockIfBaseUnavailable(task), true);
    assert.equal(blockedCode(task.id), 'task_base_missing');

    const fine = mkTask('code', 'precond.coder', { base: 'main' });
    assert.equal(await blockIfBaseUnavailable(fine), false);
    assert.equal(await blockIfBaseUnavailable(mkTask('code', 'precond.coder')), false);
  } finally {
    cleanup();
  }
});

test('shared checkout: a code task of a git repository without a worktree is refused', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    // The worktree cannot be created (the base does not exist): before, the
    // mission was spawned with no cwd override, in `repo` itself.
    const task = mkTask('code', 'precond.coder', { base: 'feat/never-created' });
    const wt = await resolveWorktree(task);
    assert.equal(wt, null);
    assert.equal(await blockIfSharedCheckout(task, wt, 'precond.coder'), true);
    assert.equal(blockedCode(task.id), 'task_worktree_unavailable');
    assert.match(dbApi.getTask(task.id)!.blocked_reason ?? '', /checkout every agent shares/);

    const merge = mkTask('merge', 'precond.coder');
    assert.equal(await blockIfSharedCheckout(merge, null, 'precond.coder'), true);
    // A review reads; a chore has no worktree at all.
    assert.equal(await blockIfSharedCheckout(mkTask('review', 'precond.coder'), null, 'precond.coder'), false);
    assert.equal(await blockIfSharedCheckout(mkTask('chore', 'precond.coder'), null, 'precond.coder'), false);
  } finally {
    cleanup();
  }
});

test('shared checkout: a project that is no git repository keeps running without a worktree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-precond-plain-'));
  try {
    mkAgent('precond.plain', dir, 'coder');
    const task = mkTask('code', 'precond.plain', { base: 'main' });
    assert.equal(await blockIfBaseUnavailable(task), false);
    assert.equal(await blockIfSharedCheckout(task, null, 'precond.plain'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the chain inherits how it lands: review, merge and a code-group merge', async () => {
  const { repo, cleanup } = mkRepo();
  try {
    mkAgent('precond.coder', repo, 'coder');
    mkAgent('precond.merger', repo, 'merger');
    const root = mkTask('code', 'precond.coder', { base: 'feat/topic', mode: 'pr', baseRef: 'origin/main' });
    dbApi.setTaskWorktree(root.id, '/wt/x', `timon/task/${root.id}`, 'feat/topic');
    const review = mkTask('review', 'precond.reviewer', { deps: [root.id] });
    dbApi.setTaskVerificationMeta(review.id, 1, root.id);
    dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: pass' });
    await runVerificationChain(dbApi.getTask(review.id)!);
    const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(review.id));
    assert.ok(merge, 'merge task created');
    assert.equal(merge.integration_mode, 'pr');
    assert.equal(merge.base_ref, 'origin/main');

    // A final merge posed by hand on a group of volets carries nothing itself:
    // it reads the chain at dispatch and freezes it on its row.
    const groupMerge = mkTask('merge', 'precond.merger', { deps: [root.id] });
    assert.deepEqual(inheritedIntegration(groupMerge), { mode: 'pr', baseRef: 'origin/main' });
    assert.equal(await blockIfBaseUnavailable(groupMerge), false);
    const frozen = dbApi.getTask(groupMerge.id)!;
    assert.equal(frozen.integration_mode, 'pr');
    assert.equal(frozen.base_ref, 'origin/main');
    assert.equal(frozen.base_branch, 'feat/topic');
  } finally {
    cleanup();
  }
});

test('code-self brief: integrates on a detached base and moves it by reference', () => {
  const task = mkTask('code', 'precond.coder', { base: 'feat/x', pipeline: 'code-self' });
  for (const activeBranch of [null, 'main']) {
    const brief = pipelineDirective(task, { sourceRepo: '/repo', activeBranch });
    assert.match(brief, /git checkout --detach feat\/x/);
    assert.match(brief, /git merge --no-ff -m "merge: integrate the task branch into feat\/x"/);
    assert.match(brief, /git -C \/repo push \. \$\(git rev-parse HEAD\):refs\/heads\/feat\/x/);
    assert.doesNotMatch(brief, /--ff-only/);
    assert.match(brief, /git -C \/repo rev-parse feat\/x\ngit rev-parse HEAD/);
  }
  const onBase = pipelineDirective(task, { sourceRepo: '/repo', activeBranch: 'feat/x' });
  assert.match(onBase, /git -C \/repo merge --ff-only \$\(git rev-parse HEAD\)/);
});

test('code-self brief: its commands land the branch without moving the user\'s HEAD', () => {
  const { repo, cleanup } = mkRepo();
  const wtPath = join(mkdtempSync(join(tmpdir(), 'timon-precond-wt-')), 'wt');
  try {
    git(repo, 'branch', 'feat/x');
    git(repo, 'checkout', '-q', '--detach', 'main');
    const head = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-q', '-b', 'timon/task/t', wtPath, 'feat/x');
    commit(wtPath, 'c.txt', 'the work');
    // The brief's steps, in the coder's worktree.
    git(wtPath, 'checkout', '-q', '--detach', 'feat/x');
    git(wtPath, 'merge', '--no-ff', '-q', '-m', 'merge: integrate the task branch into feat/x', 'timon/task/t');
    const sha = git(wtPath, 'rev-parse', 'HEAD');
    git(repo, 'push', '-q', '.', `${sha}:refs/heads/feat/x`);
    assert.equal(git(repo, 'rev-parse', 'feat/x'), sha);
    assert.equal(git(repo, 'rev-parse', 'HEAD'), head);
    assert.equal(git(repo, 'rev-parse', 'feat/x^1'), git(repo, 'rev-parse', 'main'));
    git(wtPath, 'checkout', '-q', 'timon/task/t');
  } finally {
    try { git(repo, 'worktree', 'remove', '--force', wtPath); } catch { /* already gone */ }
    cleanup();
  }
});
