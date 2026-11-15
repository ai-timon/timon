/**
 * The integration mode and the base ref are frozen on the task.
 *
 * The local base is behind `origin/<base>`, and the project setting is changed
 * after the tasks exist. Every consumer must keep the frozen values: a row
 * from before the pin stays local and does not read the project again.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi, type TaskRow } from './db.js';
import { agentDir } from './paths.js';
import { writeMeta, writeRoles } from './projects.js';
import { pipelineDirective, resolveWorktree, worktreeDirective } from './dispatcher.js';
import { runVerificationChain } from './verification-loop.js';
import { inspectGitBranch } from './code-gate.js';
import { closeTask } from './plugins-bundled/kanban/routes.js';
import {
  createWorktree, disposeWorktree, refreshWorktreeBase, releaseWorktreeFolder, type WorktreeInfo,
} from './worktree.js';
await import('../tests/helpers/claude-provider.js');
{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A local clone whose `main` lacks a commit that is already on `origin/main`. */
function forgeAhead(): { origin: string; local: string; localSha: string; remoteSha: string } {
  const origin = mkdtempSync(join(homedir(), 'timon-origin-'));
  const root = mkdtempSync(join(tmpdir(), 'timon-pin-'));
  const seed = join(root, 'seed');
  const local = join(root, 'local');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin]);
  execFileSync('git', ['init', '-q', '-b', 'main', seed]);
  git(seed, 'config', 'user.email', 'test@example.invalid');
  git(seed, 'config', 'user.name', 'Test');
  writeFileSync(join(seed, 'local.txt'), 'local\n');
  git(seed, 'add', 'local.txt');
  git(seed, 'commit', '-qm', 'local base');
  git(seed, 'remote', 'add', 'origin', origin);
  git(seed, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', origin, local]);
  git(local, 'config', 'user.email', 'test@example.invalid');
  git(local, 'config', 'user.name', 'Test');
  const localSha = git(local, 'rev-parse', 'main');
  writeFileSync(join(seed, 'from-origin.txt'), 'from the forge\n');
  git(seed, 'add', 'from-origin.txt');
  git(seed, 'commit', '-qm', 'merged on the forge');
  git(seed, 'push', '-q', 'origin', 'main');
  return { origin, local, localSha, remoteSha: git(origin, 'rev-parse', 'main') };
}

function pushFile(origin: string, name: string, body: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'timon-pin-push-'));
  try {
    execFileSync('git', ['clone', '-q', origin, scratch]);
    git(scratch, 'config', 'user.email', 'test@example.invalid');
    git(scratch, 'config', 'user.name', 'Test');
    writeFileSync(join(scratch, name), body);
    git(scratch, 'add', name);
    git(scratch, 'commit', '-qm', `add ${name}`);
    git(scratch, 'push', '-q', 'origin', 'main');
    return git(origin, 'rev-parse', 'main');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function mkAgent(name: string, cwd: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role: 'coder' }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function task(id: string): TaskRow {
  const row = dbApi.getTask(id);
  assert.ok(row);
  return row;
}

test('consumers keep the mode and the base ref frozen on the task', { timeout: 60_000 }, async () => {
  const { origin, local, localSha, remoteSha } = forgeAhead();
  const slug = `pin-${randomUUID().slice(0, 8)}`;
  const coder = `pin.coder.${randomUUID().slice(0, 8)}`;
  const reviewer = `pin.reviewer.${randomUUID().slice(0, 8)}`;
  const merger = `pin.merger.${randomUUID().slice(0, 8)}`;
  const made: WorktreeInfo[] = [];
  writeMeta(slug, { integration: 'pull-request', merge_strategy: 'squash' });
  mkAgent(coder, local);
  mkAgent(reviewer, local);
  mkAgent(merger, local);
  writeRoles(slug, {
    review: { agent: reviewer, backend: 'claude', model: 'sonnet' },
    merge: { agent: merger, backend: 'claude', model: 'sonnet' },
  });
  const bare = randomUUID();
  const withCommit = randomUUID();
  const self = randomUUID();
  dbApi.createTask(bare, 'no own commits', coder, { type: 'code', project: slug, baseBranch: 'main' });
  dbApi.createTask(withCommit, 'own commit', coder, { type: 'code', project: slug, baseBranch: 'main' });
  dbApi.createTask(self, 'integrates itself', coder, {
    type: 'code', project: slug, baseBranch: 'main', pipeline: 'code-self',
  });
  try {
    assert.notEqual(remoteSha, localSha);
    const bareInfo = await resolveWorktree(task(bare));
    const commitInfo = await resolveWorktree(task(withCommit));
    assert.ok(bareInfo && commitInfo);
    made.push(bareInfo, commitInfo);
    assert.equal(task(bare).integration_mode, 'pull-request');
    assert.equal(task(bare).integration_strategy, 'squash');
    assert.equal(task(bare).base_ref, 'origin/main');
    assert.equal(task(withCommit).base_ref, 'origin/main');
    assert.equal(git(bareInfo.path, 'rev-parse', 'HEAD'), remoteSha);
    assert.notEqual(git(bareInfo.path, 'diff', '--stat', 'main...HEAD'), '');
    assert.equal(git(bareInfo.path, 'diff', '--stat', 'origin/main...HEAD'), '');
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    writeFileSync(join(commitInfo.path, 'task.txt'), 'ours\n');
    git(commitInfo.path, 'add', 'task.txt');
    git(commitInfo.path, 'commit', '-qm', 'task work');

    // A caller that still passes the live mode must merge the ref stored on the task.
    const behind = await createWorktree(randomUUID(), local, 'main');
    made.push(behind);
    assert.equal(existsSync(join(behind.path, 'from-origin.txt')), false);
    const brought = await refreshWorktreeBase(behind.path, 'main', 'local', 'origin/main');
    assert.equal(brought.status, 'merged');
    assert.equal(existsSync(join(behind.path, 'from-origin.txt')), true);
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    writeMeta(slug, { integration: 'local' });
    const bareRow = task(bare);
    const selfRow = task(self);
    assert.match(worktreeDirective(bareRow, bareInfo), /gh pr create/);
    assert.match(pipelineDirective(selfRow), /gh pr merge/);
    assert.equal(selfRow.integration_mode, 'pull-request');

    writeMeta(slug, { integration: 'pull-request' });
    const legacy = { ...bareRow, integration_mode: null, integration_strategy: null, base_ref: null };
    assert.doesNotMatch(worktreeDirective(legacy, bareInfo), /gh pr/);
    assert.doesNotMatch(pipelineDirective({ ...selfRow, integration_mode: null, integration_strategy: null, base_ref: null }), /gh pr/);
    writeMeta(slug, { integration: 'local' });
    assert.match(worktreeDirective(task(bare), bareInfo), /gh pr create/);

    const liveSha = pushFile(origin, 'live.txt', 'while the folder is attached\n');
    const live = await resolveWorktree(task(bare));
    assert.ok(live);
    assert.equal(existsSync(join(live.path, 'live.txt')), true);
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    await releaseWorktreeFolder(live.path);
    dbApi.detachTaskWorktree(bare);
    const detached = task(bare);
    assert.equal(detached.worktree_path, null);
    assert.equal(detached.branch_name, bareInfo.branch);
    assert.equal(detached.base_ref, 'origin/main');
    const laterSha = pushFile(origin, 'later.txt', 'after detach\n');
    assert.notEqual(laterSha, liveSha);
    const again = await resolveWorktree(detached);
    assert.ok(again);
    made[0] = again;
    assert.equal(existsSync(join(again.path, 'later.txt')), true);
    assert.equal(existsSync(join(again.path, 'from-origin.txt')), true);
    assert.equal(git(again.path, 'diff', '--stat', 'origin/main...HEAD'), '');
    assert.notEqual(git(again.path, 'diff', '--stat', 'main...HEAD'), '');
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    closeTask(bare, task(bare), 'DONE', { doneComment: 'closed' });
    const closedBare = task(bare);
    assert.match(closedBare.done_comment ?? '', /NO commits/);
    await runVerificationChain(closedBare);
    assert.equal(dbApi.listTasks().some((t) => t.type === 'review' && t.deps.includes(bare)), false);

    dbApi.updateTaskStatus(withCommit, 'DONE', { doneComment: 'implemented' });
    await runVerificationChain(task(withCommit));
    const review = dbApi.listTasks().find((t) => t.type === 'review' && t.deps.includes(withCommit));
    assert.ok(review);
    assert.equal(review.integration_mode, 'pull-request');
    assert.equal(review.integration_strategy, 'squash');
    assert.equal(review.base_ref, 'origin/main');
    dbApi.updateTaskStatus(review.id, 'DONE', { doneComment: 'verdict: changes_requested\n\nRename the helper.' });
    await runVerificationChain(task(review.id));
    const iteration = dbApi.listTasks().find((t) => t.type === 'code' && t.id !== withCommit && t.verification_root_id === withCommit);
    assert.ok(iteration);
    assert.equal(iteration.integration_mode, 'pull-request');
    assert.equal(iteration.base_ref, 'origin/main');
    assert.match(worktreeDirective(iteration, {
      taskId: iteration.id, path: commitInfo.path, branch: iteration.branch_name ?? commitInfo.branch, base: 'main', sourceRepo: local,
    }), /gh pr create/);

    const passId = randomUUID();
    dbApi.createTask(passId, 'manual pass', reviewer, { type: 'review', project: slug, baseBranch: 'main' });
    assert.equal(task(passId).integration_mode, 'local');
    dbApi.setTaskVerificationMeta(passId, 1, withCommit);
    dbApi.updateTaskStatus(passId, 'DONE', { doneComment: 'verdict: pass' });
    await runVerificationChain(task(passId));
    const merge = dbApi.listTasks().find((t) => t.type === 'merge' && t.deps.includes(passId));
    assert.ok(merge);
    assert.match(merge.description ?? '', /gh pr merge/);
    assert.doesNotMatch(merge.description ?? '', /merge --ff-only/);
    assert.equal(merge.integration_mode, 'pull-request');
    assert.equal(merge.base_ref, 'origin/main');
    assert.match(worktreeDirective(merge, {
      taskId: merge.id, path: `/wt/${merge.id}`, branch: `timon/merge/${merge.id}`, base: 'main', sourceRepo: local,
    }), /gh pr merge/);

    const asLocal = inspectGitBranch(local, 'main', 'main', 'code-self', remoteSha, 'local');
    assert.equal(asLocal.mergedIntoBase, false);
    dbApi.setTaskMergedSha(self, remoteSha);
    dbApi.setTaskWorktree(self, local, 'timon/task/self', 'main');
    closeTask(self, task(self), 'DONE', { doneComment: 'closed' });
    const closedSelf = task(self);
    assert.equal(closedSelf.status, 'DONE');
    assert.doesNotMatch(closedSelf.done_comment ?? '', /not contained/);
    assert.equal(inspectGitBranch(
      closedSelf.worktree_path, closedSelf.branch_name, closedSelf.base_branch, closedSelf.pipeline,
      closedSelf.merged_commit_sha, closedSelf.integration_mode === 'pull-request' ? 'pull-request' : 'local',
      closedSelf.base_ref,
    ).mergedIntoBase, true);
  } finally {
    for (const info of made) {
      try { await disposeWorktree(info, true); } catch { /* already released */ }
    }
    rmSync(join(local, '..'), { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});
