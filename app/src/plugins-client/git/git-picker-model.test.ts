// french-ok-file: an accented worktree path, the non-ASCII folder under test
/**
 * The composer's branch picker: which rows can be switched to, and why not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folderOf, holderOf, pickerModel } from './git-picker-model';
import type { AgentGitInfo, GitDashboard, GitDashboardBranch, GitWorktreeList } from '@/lib/git-store';

const branch = (name: string, over: Partial<GitDashboardBranch> = {}): GitDashboardBranch => ({
  name, current: false, merged: false, ahead: 0, behind: 0, lastCommitTs: 0,
  lastCommitSubject: '', worktree: false, ...over,
});

const dash: GitDashboard = {
  ok: true, repo: '/r/proj', base: 'main', currentBranch: 'main',
  branches: [
    branch('main', { current: true }),
    branch('feat/a', { ahead: 2 }),
    branch('timon/task/42', { worktree: true }),
  ],
  staged: ['a.ts'], unstaged: [], untracked: ['b.ts'],
};

const list: GitWorktreeList = {
  ok: true, repo: '/r/proj',
  worktrees: [
    { path: '/r/proj', head: 'aaa', branch: 'main', main: true, current: true, bare: false, detached: false, locked: null, prunable: null },
    { path: '/home/u/.timon/worktrees/42', head: 'bbb', branch: 'timon/task/42', main: false, current: false, bare: false, detached: false, locked: '', prunable: null },
    { path: 'C:\\Users\\u\\wt\\probe', head: 'ccc', branch: null, main: false, current: false, bare: false, detached: true, locked: null, prunable: 'gone' },
  ],
};

const onMain: AgentGitInfo = { branch: 'main', dirty: true, worktree: null, added: 3, removed: 1 };

test('the current branch and a branch held by a worktree cannot be switched to', () => {
  const m = pickerModel(dash, list, onMain, '/r/proj');
  assert.deepEqual(m.branches?.map((b) => [b.name, b.blocked]), [
    ['main', 'current'], ['feat/a', null], ['timon/task/42', 'worktree'],
  ]);
  assert.equal(m.inWorktree, null);
  assert.equal(m.changes, 2);
  assert.deepEqual(m.branches?.map((b) => b.here), [true, false, false]);
});

test('an agent working in a linked worktree switches nothing from here', () => {
  const agent: AgentGitInfo = { branch: 'timon/task/42', dirty: false, worktree: '42' };
  const m = pickerModel(dash, list, agent, '/home/u/.timon/worktrees/42/app');
  assert.equal(m.inWorktree, '42');
  assert.deepEqual(m.branches?.map((b) => b.blocked), ['current', 'elsewhere', 'worktree']);
  // Its own branch is the one marked as the conversation's, not the checkout's.
  assert.deepEqual(m.branches?.map((b) => b.here), [false, false, true]);
  assert.deepEqual(m.worktrees?.map((w) => w.here), [false, true, false]);
});

test('an agent working in another repository switches nothing, and no row is its own', () => {
  // On `main` too, but that repository's `main`, not the project's.
  const agent: AgentGitInfo = { branch: 'main', dirty: false, worktree: null, foreignRepo: true };
  const m = pickerModel(dash, list, agent, '/home/u/code/other-app');
  assert.equal(m.inOtherRepo, 'other-app');
  assert.equal(m.inWorktree, null);
  assert.deepEqual(m.branches?.map((b) => b.blocked), ['current', 'elsewhere', 'worktree']);
  assert.ok(m.branches?.every((b) => !b.here));
  assert.ok(m.worktrees?.every((w) => !w.here));
  // A linked worktree of that other repository is still another repository.
  const linked = pickerModel(dash, list, { ...agent, worktree: 'wt' }, 'D:\\code\\other\\wt');
  assert.equal(linked.inOtherRepo, 'wt');
  assert.equal(linked.inWorktree, null);
  assert.ok(linked.branches?.every((b) => b.blocked !== null));
  // Without a cwd to name, the phrase has no folder.
  assert.equal(pickerModel(dash, list, agent, null).inOtherRepo, '');
});

test('the project\'s own repository, or a daemon that does not say, leaves the rows switchable', () => {
  for (const agent of [{ ...onMain, foreignRepo: false }, onMain]) {
    const m = pickerModel(dash, list, agent, '/r/proj');
    assert.equal(m.inOtherRepo, null);
    assert.deepEqual(m.branches?.map((b) => b.blocked), ['current', null, 'worktree']);
  }
});

test('worktrees read their name from either separator and say locked or missing', () => {
  const m = pickerModel(dash, list, onMain, '/r/proj');
  assert.deepEqual(m.worktrees?.map((w) => w.name), ['proj', '42', 'probe']);
  assert.deepEqual(m.worktrees?.map((w) => w.here), [true, false, false]);
  assert.equal(m.worktrees?.[1]?.locked, true);
  assert.equal(m.worktrees?.[2]?.prunable, true);
  assert.equal(m.worktrees?.[2]?.detached, true);
});

test('a resource not read yet, or failed, is null rather than empty', () => {
  const m = pickerModel(null, null, onMain, '/r/proj');
  assert.equal(m.branches, null);
  assert.equal(m.worktrees, null);
  assert.equal(m.changes, 0);
  const failed = pickerModel({ ...dash, ok: false, branches: [] }, { ok: false, repo: null, worktrees: [] }, null, null);
  assert.equal(failed.branches, null);
  assert.equal(failed.worktrees, null);
});

test('git renames a worktree folder: the row and the bar follow the path, not that name', () => {
  // `git worktree add "../wt é"` and a second `…/b/dup` are admin dirs
  // `wt-é` and `dup1` (git 2.43).
  const dup: GitWorktreeList = {
    ok: true, repo: '/r/proj',
    worktrees: [
      list.worktrees[0]!,
      { ...list.worktrees[1]!, path: '/r/a/dup', branch: 'd1' },
      { ...list.worktrees[1]!, path: '/r/b/dup', branch: 'd2' },
      { ...list.worktrees[1]!, path: '/r/wt é', branch: 'essai' },
    ],
  };
  const inDup = pickerModel(dash, dup, { branch: 'd2', dirty: false, worktree: 'dup1' }, '/r/b/dup');
  assert.deepEqual(inDup.worktrees?.map((w) => w.here), [false, false, true, false]);
  assert.equal(inDup.inWorktree, 'dup');
  const inSpace = pickerModel(dash, dup, { branch: 'essai', dirty: false, worktree: 'wt-é' }, '/r/wt é');
  assert.deepEqual(inSpace.worktrees?.map((w) => w.here), [false, false, false, true]);
  assert.equal(inSpace.inWorktree, 'wt é');
});

test('the holder of a cwd is the deepest worktree, compared across separators and drive case', () => {
  const paths = ['C:\\Repo', 'C:\\Repo\\.worktrees\\t1', '/srv/a'];
  assert.equal(holderOf(paths, 'c:/repo/.worktrees/t1/src'), 'C:\\Repo\\.worktrees\\t1');
  assert.equal(holderOf(paths, 'C:\\Repo\\docs\\'), 'C:\\Repo');
  assert.equal(holderOf(paths, 'C:\\Repository'), null);
  assert.equal(holderOf(paths, '/srv/a'), '/srv/a');
});

test('the bar names the tail of the cwd, else git\'s worktree name', () => {
  assert.equal(folderOf({ branch: 'x', dirty: false, worktree: 'wt-é' }, '/r/wt é'), 'wt é');
  assert.equal(folderOf({ branch: 'x', dirty: false, worktree: '42' }, null), '42');
  assert.equal(folderOf(onMain, '/home/u/webdev/projects/timon/'), 'timon');
  assert.equal(folderOf(onMain, 'D:\\code\\timon'), 'timon');
  assert.equal(folderOf(onMain, null), null);
});
