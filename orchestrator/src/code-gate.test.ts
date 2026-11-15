import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getHost } from './host/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCodeDone, inspectGitBranch } from './code-gate.js';
import type { GitInspection } from './code-gate.js';
import type { TaskRow } from './db.js';

type CodeTask = Pick<TaskRow, 'type' | 'branch_name' | 'worktree_path' | 'base_branch' | 'pipeline' | 'merged_commit_sha'>;

function codeTask(overrides: Partial<CodeTask> = {}): CodeTask {
  return {
    type: 'code',
    pipeline: 'full',
    merged_commit_sha: null,
    branch_name: 'timon/task/test',
    worktree_path: join(tmpdir(), 'worktree'),
    base_branch: 'main',
    ...overrides,
  };
}

function gitInspection(overrides: Partial<GitInspection> = {}): GitInspection {
  return {
    commitCount: 0,
    uncommittedFiles: [],
    ...overrides,
  };
}

test('branche avec commits : aucune annotation', () => {
  const annotation = evaluateCodeDone(codeTask(), gitInspection({ commitCount: 3 }));
  assert.equal(annotation, null);
});

test('branche vide sans diff : annotation sans mention de fichiers', () => {
  const annotation = evaluateCodeDone(codeTask(), gitInspection({ commitCount: 0, uncommittedFiles: [] }));
  assert(annotation !== null);
  assert.match(annotation!, /NO commits/);
  assert.doesNotMatch(annotation!, /Uncommitted/);
});

test('branche vide avec diff non committé : annotation mentionnant les fichiers', () => {
  const annotation = evaluateCodeDone(
    codeTask(),
    gitInspection({ commitCount: 0, uncommittedFiles: [' M src/index.ts', '?? newfile.ts'] }),
  );
  assert(annotation !== null);
  assert.match(annotation!, /NO commits/);
  assert.match(annotation!, /Uncommitted/);
  assert.match(annotation!, /src\/index\.ts/);
  assert.match(annotation!, /newfile\.ts/);
  // Recovery needs the worktree path to locate uncommitted work.
  assert.ok(annotation.includes(`To recover the work: cd ${codeTask().worktree_path}`));
});

test('task non-code : aucun effet', () => {
  for (const type of ['merge', 'review', 'chore', 'doc'] as const) {
    const annotation = evaluateCodeDone(
      codeTask({ type }),
      gitInspection({ commitCount: 0 }),
    );
    assert.equal(annotation, null, `type=${type}`);
  }
});

test('branch_name null : aucun effet, pas de crash', () => {
  const annotation = evaluateCodeDone(
    codeTask({ branch_name: null }),
    gitInspection({ commitCount: 0 }),
  );
  assert.equal(annotation, null);
});

// Failed inspections must not claim that work was lost.
test('inspection ratée (commitCount null) : aucune annotation, même avec un worktree sale', () => {
  const annotation = evaluateCodeDone(
    codeTask(),
    gitInspection({ commitCount: null, uncommittedFiles: [' M src/index.ts'] }),
  );
  assert.equal(annotation, null);
});

test('code-self: inspect actual merge ancestry, not commits ahead of base', (t) => {
  const pipeline = 'code-self';
  const repo = mkdtempSync(join(tmpdir(), 'timon-code-gate-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = getHost().exec('git', args, { cwd: repo, timeout: 5_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  git('checkout', '-b', 'task');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'work');
  const sha = git('rev-parse', 'HEAD');
  const task = codeTask({ pipeline, worktree_path: repo, branch_name: 'task', merged_commit_sha: sha });
  const inspect = (mergedSha: string | null = sha, base = 'main') =>
    inspectGitBranch(repo, 'task', base, pipeline, mergedSha);

  assert.equal(inspect().mergedIntoBase, false);
  assert.match(evaluateCodeDone(task, inspect())!, /not contained in base main/);
  assert.equal(inspect('f'.repeat(40)).mergedIntoBase, false);
  assert.match(evaluateCodeDone({ ...task, merged_commit_sha: null }, inspect(null))!, /No merged_sha declared/);
  assert.equal(inspect(sha, 'missing-base').mergedIntoBase, null);
  assert.equal(inspectGitBranch(join(repo, 'missing'), 'task', 'main', pipeline, sha).mergedIntoBase, null);
  assert.equal(evaluateCodeDone(task, { commitCount: null, uncommittedFiles: [], mergedIntoBase: null }), null);

  for (const pendingPipeline of ['full', 'code-group', null] as const) {
    const pendingTask = { ...task, pipeline: pendingPipeline, merged_commit_sha: null };
    const inspection = inspectGitBranch(repo, 'task', 'main', pendingPipeline);
    assert.equal(inspection.commitCount, 1);
    assert.equal(evaluateCodeDone(pendingTask, inspection), null);
  }
  git('checkout', 'main');
  git('merge', '--ff-only', 'task');
  git('checkout', 'task');
  assert.equal(inspectGitBranch(repo, 'task', 'main', 'full').commitCount, 0);
  assert.equal(inspect().mergedIntoBase, true);
  assert.equal(inspect(sha.slice(0, 8)).mergedIntoBase, true);
  assert.equal(evaluateCodeDone(task, inspect()), null);
  for (const pendingPipeline of ['full', 'code-group', null] as const) {
    const pendingTask = { ...task, pipeline: pendingPipeline, merged_commit_sha: null };
    assert.match(evaluateCodeDone(pendingTask, inspectGitBranch(repo, 'task', 'main', pendingPipeline))!, /NO commits/);
  }
});

test('pull-request code-self: a forge merge stays done while the worktree is still there', (t) => {
  const pipeline = 'code-self';
  const repo = mkdtempSync(join(tmpdir(), 'timon-code-gate-pr-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = getHost().exec('git', args, { cwd: repo, timeout: 5_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  git('checkout', '-b', 'forge-main');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'forge merge');
  const forgeSha = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', forgeSha);
  git('checkout', '-b', 'side');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'not on the forge');
  const side = git('rev-parse', 'HEAD');
  git('checkout', 'main');

  const task = codeTask({ pipeline, worktree_path: repo, branch_name: 'task', merged_commit_sha: forgeSha });
  const onForge = inspectGitBranch(repo, 'task', 'main', pipeline, forgeSha, 'pull-request');
  assert.equal(onForge.mergedIntoBase, true);
  assert.equal(evaluateCodeDone(task, onForge), null);
  // Local main never received that commit. The old gate blocked on it.
  assert.equal(inspectGitBranch(repo, 'task', 'main', pipeline, forgeSha).mergedIntoBase, false);

  const absent = 'a'.repeat(40);
  // No remote: an unknown sha is not on the forge. It must not close the task.
  const unknown = inspectGitBranch(repo, 'task', 'main', pipeline, absent, 'pull-request');
  assert.equal(unknown.mergedIntoBase, false);
  assert.match(evaluateCodeDone({ ...task, merged_commit_sha: absent }, unknown)!, /not contained in base main/);
  assert.equal(inspectGitBranch(repo, 'task', 'main', pipeline, absent).mergedIntoBase, false);

  // A remote we cannot fetch leaves the sha unknown: the merge may exist only on the forge.
  git('remote', 'add', 'origin', 'http://127.0.0.1:9/timon-code-gate-missing.git');
  const unfetched = inspectGitBranch(repo, 'task', 'main', pipeline, absent, 'pull-request');
  assert.equal(unfetched.mergedIntoBase, null);
  assert.equal(evaluateCodeDone({ ...task, merged_commit_sha: absent }, unfetched), null);
  assert.equal(inspectGitBranch(repo, 'task', 'main', pipeline, forgeSha, 'pull-request').mergedIntoBase, true);

  const outside = inspectGitBranch(repo, 'task', 'main', pipeline, side, 'pull-request');
  assert.equal(outside.mergedIntoBase, false);
  assert.match(evaluateCodeDone({ ...task, merged_commit_sha: side }, outside)!, /not contained in base main/);
});

test('pull-request code-self: a stacked pull request is on its destination, not on the task base', (t) => {
  const pipeline = 'code-self';
  const repo = mkdtempSync(join(tmpdir(), 'timon-code-gate-stack-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = getHost().exec('git', args, { cwd: repo, timeout: 5_000 });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  git('-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  git('checkout', '-b', 'pr-head');
  writeFileSync(join(repo, 'feature.txt'), 'feature\n');
  git('add', 'feature.txt');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'feature');
  const feature = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/pr-head', feature);
  git('checkout', 'main');
  // Squash: the merge commit is new. It is not an ancestor of the pull-request head.
  git('merge', '--squash', 'pr-head');
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'squash onto destination');
  const squash = git('rev-parse', 'HEAD');
  git('update-ref', 'refs/remotes/origin/main', squash);

  const task = codeTask({
    pipeline,
    worktree_path: repo,
    branch_name: 'task',
    base_branch: 'pr-head',
    merged_commit_sha: squash,
  });
  // The task base is the existing pull request's head. The squash landed on main.
  const onTaskBase = inspectGitBranch(repo, 'task', 'pr-head', pipeline, squash, 'pull-request');
  assert.equal(onTaskBase.mergedIntoBase, false);
  assert.equal(onTaskBase.checkedBase, 'pr-head');
  assert.match(evaluateCodeDone(task, onTaskBase)!, /not contained in base pr-head/);

  const onDestination = inspectGitBranch(repo, 'task', 'pr-head', pipeline, squash, 'pull-request', null, 'main');
  assert.equal(onDestination.mergedIntoBase, true);
  assert.equal(onDestination.checkedBase, 'main');
  assert.equal(evaluateCodeDone(task, onDestination), null);
  // `origin/main` is the same destination. It must not be fetched as `origin/origin/main`.
  const qualified = inspectGitBranch(repo, 'task', 'pr-head', pipeline, squash, 'pull-request', null, 'origin/main');
  assert.equal(qualified.mergedIntoBase, true);
  assert.equal(qualified.checkedBase, 'main');

  // The feature commit sits on the pull-request head. It is not the merge onto main.
  const featureOnDestination = inspectGitBranch(repo, 'task', 'pr-head', pipeline, feature, 'pull-request', null, 'main');
  assert.equal(featureOnDestination.mergedIntoBase, false);
  assert.match(
    evaluateCodeDone({ ...task, merged_commit_sha: feature }, featureOnDestination)!,
    /not contained in base main/,
  );
});
