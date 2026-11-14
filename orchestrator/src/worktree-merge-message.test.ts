/**
 * The merge that brings a task branch up to date with its base must pass a
 * public repository's `commit-msg` hook: git's default message names the task
 * branch (`… into timon/task/<uuid>`), which such a hook refuses, and the merge
 * then stayed pending while the refresh reported nothing useful.
 */
// Isolates TIMON_HOME before any module that touches Timon state.
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshWorktreeBase } from './worktree.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

/** A repository whose `commit-msg` hook runs `rule` (a shell condition on the
 *  message file `$1`), a task worktree on `timon/task/<uuid>`, and a base that
 *  moved after the branch started. */
function setup(rule: string): { repo: string; wt: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'timon-merge-msg-'));
  const repo = join(root, 'repo');
  const wt = join(root, 'wt');
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'initial');
  git(repo, 'worktree', 'add', '-q', '-b', `timon/task/${randomUUID()}`, wt);
  writeFileSync(join(wt, 'task.ts'), 'export const task = 1;\n');
  git(wt, 'add', '-A');
  git(wt, 'commit', '-qm', 'task work');
  writeFileSync(join(repo, 'other.ts'), 'export const other = 1;\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'another task landed');
  // Installed after the setup commits, so only the refresh meets it. Worktrees
  // share the repository's hooks.
  const hook = join(repo, '.git', 'hooks', 'commit-msg');
  writeFileSync(hook, `#!/bin/sh\nif ${rule}; then echo "commit refused: test hook" >&2; exit 1; fi\nexit 0\n`);
  chmodSync(hook, 0o755);
  return { repo, wt, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('the refresh merge passes a hook that refuses task ids, and its message carries none', async () => {
  const { wt, cleanup } = setup(`grep -Eq 'timon/task/|[0-9a-f]{8}-[0-9a-f]{4}-' "$1"`);
  try {
    const out = await refreshWorktreeBase(wt, 'main');
    assert.equal(out.status, 'merged', JSON.stringify(out));
    const message = git(wt, 'log', '-1', '--format=%B');
    assert.equal(message, 'merge: bring main into the task branch');
    assert.doesNotMatch(message, UUID_RE);
    assert.doesNotMatch(message, /timon\/task\//);
    // A real merge commit: the other task's file is now on the branch.
    assert.ok(existsSync(join(wt, 'other.ts')));
    assert.equal(git(wt, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3);
  } finally {
    cleanup();
  }
});

test('a merge refused without conflict is reported with its reason and leaves no pending merge', async () => {
  const { wt, cleanup } = setup('true');
  try {
    const before = git(wt, 'rev-parse', 'HEAD');
    const out = await refreshWorktreeBase(wt, 'main');
    assert.equal(out.status, 'failed');
    assert.match(out.status === 'failed' ? out.reason : '', /commit refused: test hook/);
    // The agent must not start inside an unfinished merge: its first commit
    // would silently become that merge.
    assert.throws(() => git(wt, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'));
    assert.equal(git(wt, 'rev-parse', 'HEAD'), before);
    assert.equal(git(wt, 'status', '--porcelain'), '');
  } finally {
    cleanup();
  }
});
