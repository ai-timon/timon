/**
 * The main clone's working copy follows a branch the daemon moves: only when
 * it is clean, only by fast-forward, and never by a reset, a stash or a
 * forced checkout. Real throwaway repositories.
 *
 * `npm test -- src/clone-follow.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A local bare remote lives under the system temporary folder: allowed unless a fence is configured.
writeFileSync(join(process.env.TIMON_HOME!, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));
const { dbApi } = await import('./db.js');
const { followCheckedOutBranch, FOLLOW_AUDIT_ACTION } = await import('./clone-follow.js');
const { advanceBaseByReference, ensureIntegrationBranch } = await import('./git-integration.js');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), `${text}\n`);
  git(cwd, 'add', file);
  git(cwd, 'commit', '-q', '-m', text);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** `main` checked out in `work`, and `timon/merge/x` one commit ahead of it. */
function setup(): { dir: string; work: string; ahead: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-follow-'));
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'test@timon.local');
  git(work, 'config', 'user.name', 'timon-test');
  commit(work, 'a.txt', 'one');
  git(work, 'checkout', '-q', '-b', 'timon/merge/x');
  const ahead = commit(work, 'b.txt', 'two');
  git(work, 'checkout', '-q', 'main');
  return { dir, work, ahead, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function skips(): string[] {
  return dbApi.listAuditLog(1000).filter((r) => r.action === FOLLOW_AUDIT_ACTION).map((r) => r.target ?? '');
}

/** No reset, no stash: the reflog of HEAD records neither, and the stash is empty. */
function assertNoResetNorStash(work: string): void {
  assert.equal(git(work, 'stash', 'list'), '');
  assert.doesNotMatch(git(work, 'reflog', '--format=%gs', 'HEAD'), /reset|stash/);
}

async function untouchedWithWarning(work: string, ahead: string, reason: RegExp): Promise<void> {
  const before = skips().length;
  const head = git(work, 'rev-parse', 'HEAD');
  const status = git(work, 'status', '--porcelain');
  const out = await followCheckedOutBranch(work, 'main', ahead);
  assert.equal(out.status, 'skipped');
  assert.match(out.status === 'skipped' ? out.reason : '', reason);
  assert.equal(git(work, 'rev-parse', 'main'), head);
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);
  assert.equal(git(work, 'status', '--porcelain'), status);
  assert.equal(skips().length, before + 1, 'the skip is journalled');
  assert.match(skips()[0] ?? '', reason);
  assertNoResetNorStash(work);
}

test('a clean working copy follows by fast-forward: ref and files together', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    const previous = git(work, 'rev-parse', 'main');
    const out = await followCheckedOutBranch(work, 'main', ahead, previous);
    assert.deepEqual(out, { status: 'followed', previous, sha: ahead });
    assert.equal(git(work, 'rev-parse', 'main'), ahead);
    assert.equal(git(work, 'rev-parse', 'HEAD'), ahead);
    assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'two\n');
    assert.equal(git(work, 'status', '--porcelain'), '');
    assertNoResetNorStash(work);
    // Again: already there, nothing to do and nothing to say.
    const before = skips().length;
    assert.deepEqual(await followCheckedOutBranch(work, 'main', ahead), { status: 'unchanged', sha: ahead });
    assert.equal(skips().length, before);
  } finally {
    cleanup();
  }
});

test('a modified tracked file: nothing is touched, the skip is warned and journalled', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    writeFileSync(join(work, 'a.txt'), 'edited\n');
    await untouchedWithWarning(work, ahead, /uncommitted changes/);
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'edited\n');
  } finally {
    cleanup();
  }
});

test('an untracked file that is not ignored counts as dirty; an ignored one does not', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    writeFileSync(join(work, 'scratch.txt'), 'mine\n');
    await untouchedWithWarning(work, ahead, /untracked files/);
    assert.equal(existsSync(join(work, 'b.txt')), false);
    rmSync(join(work, 'scratch.txt'));
    writeFileSync(join(work, '.git', 'info', 'exclude'), 'ignored.log\n');
    writeFileSync(join(work, 'ignored.log'), 'x\n');
    assert.equal((await followCheckedOutBranch(work, 'main', ahead)).status, 'followed');
  } finally {
    cleanup();
  }
});

test('a diverged history is not followed', async () => {
  const { work, cleanup } = setup();
  try {
    git(work, 'checkout', '-q', '-b', 'other');
    const other = commit(work, 'c.txt', 'three');
    git(work, 'checkout', '-q', 'main');
    commit(work, 'd.txt', 'four');
    await untouchedWithWarning(work, other, /diverged/);
  } finally {
    cleanup();
  }
});

test('a detached HEAD or another branch checked out: no write, and nothing to say for a branch that is not checked out', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    const before = skips().length;
    git(work, 'checkout', '-q', '--detach');
    const head = git(work, 'rev-parse', 'HEAD');
    assert.deepEqual(await followCheckedOutBranch(work, 'main', ahead), { status: 'not_checked_out' });
    git(work, 'checkout', '-q', 'timon/merge/x');
    assert.deepEqual(await followCheckedOutBranch(work, 'main', ahead), { status: 'not_checked_out' });
    assert.equal(git(work, 'rev-parse', 'main'), head);
    assert.equal(skips().length, before);
    assertNoResetNorStash(work);
  } finally {
    cleanup();
  }
});

test('a branch checked out only in another worktree is not ours to move', async () => {
  const { dir, work, ahead, cleanup } = setup();
  try {
    git(work, 'checkout', '-q', '--detach');
    git(work, 'worktree', 'add', '-q', join(dir, 'wt'), 'main');
    const main = git(work, 'rev-parse', 'main');
    assert.deepEqual(await followCheckedOutBranch(work, 'main', ahead), { status: 'not_checked_out' });
    assert.equal(git(work, 'rev-parse', 'main'), main);
  } finally {
    cleanup();
  }
});

test('a merge, cherry-pick or bisect under way: nothing moves', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    git(work, 'bisect', 'start');
    await untouchedWithWarning(work, ahead, /BISECT_LOG/);
    git(work, 'bisect', 'reset');
    writeFileSync(join(work, '.git', 'MERGE_HEAD'), `${ahead}\n`);
    await untouchedWithWarning(work, ahead, /MERGE_HEAD/);
  } finally {
    cleanup();
  }
});

test('a branch that moved since the caller read it is left alone', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    const out = await followCheckedOutBranch(work, 'main', ahead, ahead);
    assert.equal(out.status, 'skipped');
    assert.equal(git(work, 'rev-parse', 'main'), git(work, 'rev-parse', 'main~0'));
    assert.notEqual(git(work, 'rev-parse', 'main'), ahead);
  } finally {
    cleanup();
  }
});

test('advanceBaseByReference: a clean checked-out base follows, a dirty one refuses and moves nothing', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    writeFileSync(join(work, 'a.txt'), 'edited\n');
    const main = git(work, 'rev-parse', 'main');
    const refused = await advanceBaseByReference(work, 'timon/merge/x', 'main');
    assert.equal(!refused.ok && refused.code, 'checked_out');
    assert.match(!refused.ok ? refused.reason : '', /uncommitted/);
    assert.equal(git(work, 'rev-parse', 'main'), main);
    git(work, 'checkout', '-q', '--', 'a.txt');

    const moved = await advanceBaseByReference(work, 'timon/merge/x', 'main');
    assert.deepEqual(moved, { ok: true, sha: ahead, previous: main });
    assert.equal(git(work, 'rev-parse', 'HEAD'), ahead);
    assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'two\n');
    assertNoResetNorStash(work);
  } finally {
    cleanup();
  }
});

test('a branch that is not checked out keeps the existing by-reference move', async () => {
  const { work, ahead, cleanup } = setup();
  try {
    git(work, 'branch', 'feat/topic', 'main');
    const out = await advanceBaseByReference(work, 'timon/merge/x', 'feat/topic');
    assert.equal(out.ok && out.sha, ahead);
    assert.equal(git(work, 'rev-parse', 'feat/topic'), ahead);
    assert.equal(git(work, 'rev-parse', 'main'), git(work, 'rev-parse', 'main~0'));
    assert.equal(existsSync(join(work, 'b.txt')), false, 'the working copy is on main, untouched');
  } finally {
    cleanup();
  }
});

test('after a fetch of the target: a clean checked-out local target follows the remote, a dirty one does not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-follow-fetch-'));
  try {
    const bare = join(dir, 'remote.git');
    const work = join(dir, 'work');
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    for (const r of [work]) { git(r, 'config', 'user.email', 't@timon.local'); git(r, 'config', 'user.name', 't'); }
    git(work, 'remote', 'add', 'origin', bare);
    commit(work, 'a.txt', 'one');
    git(work, 'push', '-q', 'origin', 'main');
    execFileSync('git', ['clone', '-q', bare, other]);
    git(other, 'config', 'user.email', 't@timon.local');
    git(other, 'config', 'user.name', 't');
    const remoteMain = commit(other, 'b.txt', 'two');
    git(other, 'push', '-q', 'origin', 'main');

    // Dirty: the branch is cut, the checked-out main stays where it was.
    writeFileSync(join(work, 'a.txt'), 'edited\n');
    const first = await ensureIntegrationBranch(work, { branch: 'feat/one', baseRef: 'origin/main' });
    assert.equal(first.ok, true);
    assert.notEqual(git(work, 'rev-parse', 'main'), remoteMain);
    assert.equal(readFileSync(join(work, 'a.txt'), 'utf8'), 'edited\n');
    assert.ok(skips().some((s) => /main: .*uncommitted/.test(s)));

    // Clean: the next fetch brings main and its files up.
    git(work, 'checkout', '-q', '--', 'a.txt');
    const second = await ensureIntegrationBranch(work, { branch: 'feat/two', baseRef: 'origin/main' });
    assert.equal(second.ok, true);
    assert.equal(git(work, 'rev-parse', 'main'), remoteMain);
    assert.equal(git(work, 'rev-parse', 'HEAD'), remoteMain);
    assert.equal(readFileSync(join(work, 'b.txt'), 'utf8'), 'two\n');
    assertNoResetNorStash(work);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
