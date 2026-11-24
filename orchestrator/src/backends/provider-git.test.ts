/**
 * `gitWritableRoots`: the git directories declared writable in the
 * per-mission config.toml of a codex agent.
 *
 * At stake: the codex `workspace-write` sandbox mounts the git directory as a
 * READ-ONLY bind, even when `.git` is in the cwd. Without these roots, any
 * agent going through the codex dialect (GPT, but also DeepSeek/Kimi via
 * Ollama Cloud) fails on `git commit` with "Unable to create
 * <repo>/.git/index.lock: Read-only file system". The three topologies
 * covered here are those a TIMON mission really meets.
 */

// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { gitWritableRoots } from './provider-git.js';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

/** Throwaway repository with a first commit: a worktree cannot be created
 *  from a repository without HEAD. `realpathSync.native` because git answers
 *  with resolved long paths, while the temporary folder may be a symlink
 *  (`/var` on macOS) or an 8.3 short name (`RUNNER~1` on Windows). */
function makeRepo(): { root: string; dispose: () => void } {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-gitroots-')));
  git(root, 'init', '-q', '.');
  git(root, 'config', 'user.email', 'test@timon.local');
  git(root, 'config', 'user.name', 'timon-test');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, 'add', 'a.txt');
  git(root, 'commit', '-qm', 'init');
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

test('normal repository: the .git of the cwd is declared writable', () => {
  const { root, dispose } = makeRepo();
  try {
    assert.deepEqual(gitWritableRoots(root), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('cwd in a subdirectory: goes up to the .git of the repository', () => {
  const { root, dispose } = makeRepo();
  try {
    const sub = join(root, 'orchestrator', 'src');
    mkdirSync(sub, { recursive: true });
    assert.deepEqual(gitWritableRoots(sub), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('linked worktree: gitdir, common dir, then the main working tree', () => {
  const { root, dispose } = makeRepo();
  const wt = join(root, '..', `wt-${process.pid}`);
  try {
    git(root, 'worktree', 'add', '-q', wt, '-b', 'feat/test');
    const roots = gitWritableRoots(realpathSync.native(wt));
    // The first two carry the worktree's index + HEAD on one side, objects/ +
    // refs/ on the other: a commit writes into both. The third is the working
    // tree of the main repository, which the fast-forward of a `merge` task
    // rewrites; without it, the ff fails with "Read-only file system".
    assert.deepEqual(roots, [
      join(root, '.git', 'worktrees', `wt-${process.pid}`),
      join(root, '.git'),
      root,
    ]);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    dispose();
  }
});

test('normal repository: the main repository is NOT added, it is already the cwd', () => {
  const { root, dispose } = makeRepo();
  try {
    const sub = join(root, 'orchestrator');
    mkdirSync(sub, { recursive: true });
    // A cwd in a subdirectory does not widen the scope to the whole repository:
    // only the linked worktree needs it.
    assert.deepEqual(gitWritableRoots(sub), [join(root, '.git')]);
  } finally {
    dispose();
  }
});

test('cwd outside a git repository: no root, no crash', () => {
  const outside = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-nogit-')));
  try {
    // An isolated /tmp/xxx is not in a repository, unless TMPDIR is itself
    // under a repository, in which case git would go up to it: then nothing is tested.
    assert.deepEqual(gitWritableRoots(outside), []);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test('missing cwd: returns an empty list rather than throwing', () => {
  assert.deepEqual(gitWritableRoots(join(tmpdir(), 'timon-absent-cwd-xyz')), []);
});
