/**
 * Pull-request worktrees start from `origin/<base>` after a fetch. Local mode
 * stays on the local ref and does not fetch. A failed fetch falls back to the
 * local base and warns, instead of failing the task.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorktree, disposeWorktree, refreshWorktreeBase, type WorktreeInfo } from './worktree.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A local clone whose `main` lacks a commit that is already on `origin/main`.
 *  The bare remote sits outside the temporary directories a mission can write,
 *  so the daemon's git is allowed to fetch it. */
function forgeAhead(): { origin: string; local: string; localSha: string; remoteSha: string } {
  const origin = mkdtempSync(join(homedir(), 'timon-origin-'));
  const root = mkdtempSync(join(tmpdir(), 'timon-wt-remote-'));
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

test('local mode ignores a commit that exists only on origin, and pull-request mode checks it out', async () => {
  const { origin, local, localSha, remoteSha } = forgeAhead();
  const made: WorktreeInfo[] = [];
  try {
    assert.notEqual(remoteSha, localSha);
    assert.equal(git(local, 'rev-parse', 'refs/remotes/origin/main'), localSha);

    const localTree = await createWorktree(randomUUID(), local, 'main');
    made.push(localTree);
    assert.equal(existsSync(join(localTree.path, 'from-origin.txt')), false);
    assert.equal(git(local, 'rev-parse', 'refs/remotes/origin/main'), localSha);
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    const localRefresh = await refreshWorktreeBase(localTree.path, 'main', 'local');
    assert.equal(localRefresh.status, 'up-to-date');
    assert.equal(existsSync(join(localTree.path, 'from-origin.txt')), false);
    assert.equal(git(local, 'rev-parse', 'refs/remotes/origin/main'), localSha);

    const remoteTree = await createWorktree(randomUUID(), local, 'main', undefined, 'pull-request');
    made.push(remoteTree);
    assert.equal(existsSync(join(remoteTree.path, 'from-origin.txt')), true);
    assert.equal(git(remoteTree.path, 'rev-parse', 'HEAD'), remoteSha);
    assert.equal(remoteTree.base, 'main');
    // The local branch the user has checked out does not move.
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    const refreshed = await refreshWorktreeBase(localTree.path, 'main', 'pull-request');
    assert.equal(refreshed.status, 'merged');
    assert.equal(existsSync(join(localTree.path, 'from-origin.txt')), true);
    assert.equal(git(localTree.path, 'merge-base', '--is-ancestor', remoteSha, 'HEAD'), '');
    assert.equal(git(local, 'rev-parse', 'main'), localSha);
  } finally {
    for (const info of made) await disposeWorktree(info, true);
    rmSync(join(local, '..'), { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

test('a failed fetch in pull-request mode keeps the local base and warns', async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, 'warn', (message?: unknown) => { warnings.push(String(message)); });
  const repo = mkdtempSync(join(tmpdir(), 'timon-wt-fetch-fail-'));
  let info: WorktreeInfo | undefined;
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 'test@example.invalid');
    git(repo, 'config', 'user.name', 'Test');
    writeFileSync(join(repo, 'local.txt'), 'local\n');
    git(repo, 'add', 'local.txt');
    git(repo, 'commit', '-qm', 'local');
    git(repo, 'remote', 'add', 'origin', 'http://127.0.0.1:9/timon-missing.git');
    const localSha = git(repo, 'rev-parse', 'HEAD');
    info = await createWorktree(randomUUID(), repo, 'main', undefined, 'pull-request');
    assert.equal(existsSync(join(info.path, 'local.txt')), true);
    assert.equal(git(info.path, 'rev-parse', 'HEAD'), localSha);
    assert.ok(warnings.some((message) => message.includes('could not fetch origin main')));
    const refreshed = await refreshWorktreeBase(info.path, 'main', 'pull-request');
    assert.equal(refreshed.status, 'up-to-date');
    assert.equal(git(info.path, 'rev-parse', 'HEAD'), localSha);
  } finally {
    if (info) await disposeWorktree(info, true);
    rmSync(repo, { recursive: true, force: true });
  }
});
