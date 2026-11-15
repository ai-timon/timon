/**
 * Pull-request worktrees start from `origin/<base>` after a fetch. Local mode
 * stays on the local ref and does not fetch. A failed fetch falls back to the
 * local base and warns, instead of failing the task.
 *
 * A detached pull-request branch is refreshed from that same ref when the task
 * is requeued. A refresh that fails without a conflict tells the agent to
 * retry `origin/<base>` in pull-request mode, and the local base in local mode.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { agentDir } from './paths.js';
import { writeMeta } from './projects.js';
import { resolveWorktree, worktreeDirective } from './dispatcher.js';
import {
  createWorktree, disposeWorktree, refreshWorktreeBase, releaseWorktreeFolder, type WorktreeInfo,
} from './worktree.js';

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

function mkAgent(name: string, cwd: string): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd, role: 'coder' }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), 'Test');
}

function codeTask(agent: string, slug: string): string {
  const id = randomUUID();
  dbApi.createTask(id, 'remote base', agent, { type: 'code', project: slug, baseBranch: 'main' });
  return id;
}

/** Push one new file to `origin/main` without moving the local `main` branch. */
function pushFile(origin: string, name: string, body: string): string {
  const scratch = mkdtempSync(join(tmpdir(), 'timon-wt-push-'));
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

const LOCAL_RECOVERY = 'git merge --no-edit -m "merge: bring main into the task branch" main';
const REMOTE_RECOVERY = 'git merge --no-edit -m "merge: bring main into the task branch" origin/main';

test('a detached pull-request branch picks up a later origin commit when the task is requeued', async () => {
  const { origin, local, localSha, remoteSha } = forgeAhead();
  const slug = `reattach-${randomUUID().slice(0, 8)}`;
  writeMeta(slug, { integration: 'pull-request' });
  const agent = `reattach.coder.${randomUUID().slice(0, 8)}`;
  mkAgent(agent, local);
  const id = codeTask(agent, slug);
  let info: WorktreeInfo | null = null;
  try {
    info = await resolveWorktree(dbApi.getTask(id)!);
    assert.ok(info);
    assert.equal(git(info.path, 'rev-parse', 'HEAD'), remoteSha);
    writeFileSync(join(info.path, 'task.txt'), 'kept\n');
    git(info.path, 'add', 'task.txt');
    git(info.path, 'commit', '-qm', 'task work');

    await releaseWorktreeFolder(info.path);
    dbApi.detachTaskWorktree(id);
    const detached = dbApi.getTask(id)!;
    assert.equal(detached.worktree_path, null);
    assert.equal(detached.branch_name, info.branch);

    const laterSha = pushFile(origin, 'later.txt', 'after detach\n');
    assert.notEqual(laterSha, remoteSha);
    assert.equal(git(local, 'rev-parse', 'main'), localSha);

    const again = await resolveWorktree(detached);
    assert.ok(again);
    info = again;
    assert.equal(existsSync(join(again.path, 'later.txt')), true);
    assert.equal(existsSync(join(again.path, 'task.txt')), true);
    assert.equal(git(again.path, 'merge-base', '--is-ancestor', laterSha, 'HEAD'), '');
    assert.equal(git(local, 'rev-parse', 'main'), localSha);
  } finally {
    if (info) await disposeWorktree(info, true);
    rmSync(join(local, '..'), { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
});

/** A base and a worktree on the same commit, then a file the refresh cannot take. */
async function refusedRefresh(mode: 'local' | 'pull-request'): Promise<string> {
  const origin = mkdtempSync(join(homedir(), 'timon-origin-'));
  const root = mkdtempSync(join(tmpdir(), 'timon-wt-directive-'));
  const seed = join(root, 'seed');
  const local = join(root, 'local');
  const slug = `directive-${mode}-${randomUUID().slice(0, 8)}`;
  let info: WorktreeInfo | null = null;
  try {
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

    writeMeta(slug, { integration: mode === 'pull-request' ? 'pull-request' : 'local' });
    const agent = `directive.coder.${randomUUID().slice(0, 8)}`;
    mkAgent(agent, local);
    const id = codeTask(agent, slug);
    info = await resolveWorktree(dbApi.getTask(id)!);
    assert.ok(info);

    if (mode === 'pull-request') {
      pushFile(origin, 'blocked.txt', 'from the forge\n');
      assert.equal(git(local, 'rev-parse', 'main'), localSha);
    } else {
      writeFileSync(join(local, 'blocked.txt'), 'from local main\n');
      git(local, 'add', 'blocked.txt');
      git(local, 'commit', '-qm', 'local moved');
    }
    writeFileSync(join(info.path, 'blocked.txt'), 'untracked\n');
    const again = await resolveWorktree(dbApi.getTask(id)!);
    assert.ok(again);
    return worktreeDirective(dbApi.getTask(id)!, again);
  } finally {
    if (info) await disposeWorktree(info, true);
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  }
}

test('a failed refresh tells pull-request mode to retry origin/<base>, and local mode to retry the local base', async () => {
  const localBrief = await refusedRefresh('local');
  assert.match(localBrief, /NOT brought up to date/);
  assert.match(localBrief, /with `main` failed/);
  assert.ok(localBrief.includes(LOCAL_RECOVERY), localBrief);
  assert.equal(localBrief.includes(REMOTE_RECOVERY), false);
  assert.equal(localBrief.includes('origin/main'), false);

  const remoteBrief = await refusedRefresh('pull-request');
  assert.match(remoteBrief, /NOT brought up to date/);
  assert.match(remoteBrief, /with `origin\/main` failed/);
  assert.ok(remoteBrief.includes(REMOTE_RECOVERY), remoteBrief);
  assert.equal(remoteBrief.includes(LOCAL_RECOVERY), false);
});
