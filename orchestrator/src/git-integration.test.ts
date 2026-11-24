/**
 * Integration branches: created from the remote without a checkout, refused
 * (never replaced by the local base) when the remote cannot give them, and a
 * base moved by reference with its sha read back.
 *
 * Real throwaway repositories: what matters is git's exact behaviour.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The bare remotes live under the system temporary folder, which the fence
// lets missions write: the daemon's git refuses such a local remote unless no
// filesystem fence is configured (`host/git-neutral.ts`).
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));
import {
  advanceBaseByReference,
  ensureIntegrationBranch,
  integrationBranchName,
  integrationBranchRefusal,
  splitRemoteRef,
} from './git-integration.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, message: string): string {
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A checkout `work` with a bare `origin` one commit ahead of the local `main`. */
function setup(): { dir: string; work: string; bare: string; remoteMain: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-integration-'));
  const bare = join(dir, 'remote.git');
  const work = join(dir, 'work');
  const other = join(dir, 'other');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  for (const repo of [work]) {
    git(repo, 'config', 'user.email', 'test@timon.local');
    git(repo, 'config', 'user.name', 'timon-test');
  }
  git(work, 'remote', 'add', 'origin', bare);
  commit(work, 'a.txt', 'one');
  git(work, 'push', '-q', 'origin', 'main');
  // Someone else lands a commit on the remote: local main is now behind.
  execFileSync('git', ['clone', '-q', bare, other]);
  git(other, 'config', 'user.email', 'test@timon.local');
  git(other, 'config', 'user.name', 'timon-test');
  const remoteMain = commit(other, 'b.txt', 'two');
  git(other, 'push', '-q', 'origin', 'main');
  return { dir, work, bare, remoteMain, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('integration branch names: derived from the title, without ids', () => {
  assert.equal(integrationBranchName('Kanban → PR : préconditions'), 'feat/kanban-pr-preconditions'); // french-ok: an accented title the branch name folds
  assert.equal(integrationBranchName('Fix token leak', { embargo: true }), 'sec/fix-token-leak');
  assert.equal(
    integrationBranchName('merge 1fc78347-4d3f-4a23-be2d-e1520d82ef8f and 4943a04e'),
    'feat/merge-and',
  );
  // A project's own prefix; an embargo keeps `sec/` whatever the prefix says.
  assert.equal(integrationBranchName('Add the PR task', { prefix: 'feature/' }), 'feature/add-the-pr-task');
  assert.equal(integrationBranchName('Fix token leak', { prefix: 'feature/', embargo: true }), 'sec/fix-token-leak');
  assert.equal(integrationBranchName('—'), null);
  assert.ok(integrationBranchName('a '.repeat(80))!.length <= 'feat/'.length + 48);
  assert.equal(integrationBranchRefusal('feat/kanban-pr'), null);
  assert.match(integrationBranchRefusal('timon/task/x') ?? '', /reserved/);
  assert.match(integrationBranchRefusal('feat/4943a04e') ?? '', /id/);
  assert.match(integrationBranchRefusal('--force') ?? '', /valid/);
});

test('splitRemoteRef: the longest remote name wins', () => {
  assert.deepEqual(splitRemoteRef('origin/main', ['origin']), { remote: 'origin', target: 'main' });
  assert.deepEqual(splitRemoteRef('up/stream/main', ['up', 'up/stream']), { remote: 'up/stream', target: 'main' });
  assert.equal(splitRemoteRef('upstream/main', ['origin']), null);
  assert.equal(splitRemoteRef('origin/', ['origin']), null);
});

test('creates the branch from the remote target, without touching the checkout', async () => {
  const { work, remoteMain, cleanup } = setup();
  try {
    git(work, 'checkout', '-q', '-b', 'mine');
    writeFileSync(join(work, 'dirty.txt'), 'uncommitted\n');
    const statusBefore = git(work, 'status', '--porcelain');
    const headBefore = git(work, 'rev-parse', 'HEAD');

    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/main' });

    assert.deepEqual(out, { ok: true, created: true, sha: remoteMain, remote: 'origin', target: 'main' });
    assert.equal(git(work, 'rev-parse', 'feat/topic'), remoteMain);
    assert.equal(git(work, 'branch', '--show-current'), 'mine');
    assert.equal(git(work, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(git(work, 'status', '--porcelain'), statusBefore);
    // No upstream: a bare `git push` from the branch must never reach main.
    assert.throws(() => git(work, 'rev-parse', '--abbrev-ref', 'feat/topic@{upstream}'));
    // main is not checked out: it was moved up to the remote's, fast-forward.
    assert.equal(git(work, 'rev-parse', 'main'), remoteMain);
  } finally {
    cleanup();
  }
});

test('leaves the local target alone when it is checked out', async () => {
  const { work, remoteMain, cleanup } = setup();
  try {
    const localMain = git(work, 'rev-parse', 'main');
    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/main' });
    assert.equal(out.ok, true);
    assert.equal(git(work, 'rev-parse', 'feat/topic'), remoteMain);
    assert.equal(git(work, 'rev-parse', 'main'), localMain);
  } finally {
    cleanup();
  }
});

test('an existing branch is kept as it is, without a network call', async () => {
  const { work, bare, cleanup } = setup();
  try {
    const local = git(work, 'rev-parse', 'main');
    git(work, 'branch', 'feat/topic', local);
    // The remote is gone: a fetch would fail, and none is needed.
    rmSync(bare, { recursive: true, force: true });
    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/main' });
    assert.deepEqual(out, { ok: true, created: false, sha: local, remote: 'origin', target: 'main' });
  } finally {
    cleanup();
  }
});

test('a target missing on the remote is refused, never cut from the local base', async () => {
  const { work, cleanup } = setup();
  try {
    git(work, 'branch', 'develop'); // exists locally only
    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/develop' });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.code, 'target_missing');
    assert.throws(() => git(work, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/topic'));
  } finally {
    cleanup();
  }
});

test('an unreachable remote is refused', async () => {
  const { work, bare, cleanup } = setup();
  try {
    rmSync(bare, { recursive: true, force: true });
    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/main' });
    assert.equal(out.ok, false);
    assert.equal(!out.ok && out.code, 'remote_unreachable');
    assert.throws(() => git(work, 'rev-parse', '--verify', '--quiet', 'refs/heads/feat/topic'));
  } finally {
    cleanup();
  }
});

test('a repository without a remote is refused', async () => {
  const { work, cleanup } = setup();
  try {
    git(work, 'remote', 'remove', 'origin');
    const out = await ensureIntegrationBranch(work, { branch: 'feat/topic', baseRef: 'origin/main' });
    assert.equal(!out.ok && out.code, 'no_remote');
    const named = await ensureIntegrationBranch(work, { branch: 'feat/x', baseRef: 'main' });
    assert.equal(!named.ok && named.code, 'no_remote');
  } finally {
    cleanup();
  }
});

test('an id in the branch name is refused before anything runs', async () => {
  const { work, cleanup } = setup();
  try {
    const out = await ensureIntegrationBranch(work, { branch: 'feat/4943a04e', baseRef: 'origin/main' });
    assert.equal(!out.ok && out.code, 'invalid_branch');
  } finally {
    cleanup();
  }
});

test('the base moves by reference: a detached HEAD stays where it is, the sha is read back', async () => {
  const { work, cleanup } = setup();
  try {
    git(work, 'branch', 'feat/topic');
    git(work, 'checkout', '-q', '-b', 'timon/merge/x');
    const tip = commit(work, 'c.txt', 'three');
    const previous = git(work, 'rev-parse', 'feat/topic');
    git(work, 'checkout', '-q', '--detach', 'main');
    const head = git(work, 'rev-parse', 'HEAD');

    const out = await advanceBaseByReference(work, 'timon/merge/x', 'feat/topic');

    assert.deepEqual(out, { ok: true, sha: tip, previous });
    assert.equal(git(work, 'rev-parse', 'feat/topic'), tip);
    assert.equal(git(work, 'rev-parse', 'HEAD'), head); // the incident: HEAD used to move
  } finally {
    cleanup();
  }
});

test('the base is not moved when checked out, nor when the move is not a fast-forward', async () => {
  const { work, cleanup } = setup();
  try {
    git(work, 'checkout', '-q', '-b', 'side');
    commit(work, 'c.txt', 'three');
    git(work, 'checkout', '-q', 'main');
    const main = git(work, 'rev-parse', 'main');
    const checkedOut = await advanceBaseByReference(work, 'side', 'main');
    assert.equal(!checkedOut.ok && checkedOut.code, 'checked_out');
    assert.equal(git(work, 'rev-parse', 'main'), main);

    git(work, 'branch', 'feat/topic');
    git(work, 'checkout', '-q', 'feat/topic');
    commit(work, 'd.txt', 'four');
    git(work, 'checkout', '-q', 'main');
    const diverged = await advanceBaseByReference(work, 'side', 'feat/topic');
    assert.equal(!diverged.ok && diverged.code, 'not_fast_forward');

    const unknown = await advanceBaseByReference(work, 'nope', 'feat/topic');
    assert.equal(!unknown.ok && unknown.code, 'unknown_ref');
  } finally {
    cleanup();
  }
});
