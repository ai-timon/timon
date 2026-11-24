/**
 * Tests of the git publication status (gitremote.ts).
 *
 * `node --test --import tsx src/gitremote.test.ts` (or `npm test`).
 *
 * The three cases covered here are those the widget showed wrong, and
 * that no "normal" repository reproduces:
 *   - detached HEAD (permanent state of an agent worktree during a task):
 *     counted the WHOLE history as "to push";
 *   - branch never pushed: showed "0 to push", a false negative that
 *     reassures while no commit is published;
 *   - `<remote>/HEAD` not configured: `rev-parse --abbrev-ref` returns the
 *     literal string `origin/HEAD` without failing, taken for a valid ref.
 *
 * Real throwaway repositories are set up: the value of the test lies precisely in the
 * exact behaviour of git, which a mock would reproduce wrongly.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { statusForCwd } from './gitremote.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Local repository + bare remote, with `n` commits on `main` already pushed. */
function makeRepo(commits = 3): { dir: string; work: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-'));
  const bare = join(dir, 'remote.git');
  const work = join(dir, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  execFileSync('git', ['init', '-q', '-b', 'main', work]);
  git(work, 'config', 'user.email', 'test@timon.local');
  git(work, 'config', 'user.name', 'timon-test');
  git(work, 'remote', 'add', 'origin', bare);
  for (let i = 0; i < commits; i++) {
    writeFileSync(join(work, `f${i}`), String(i));
    git(work, 'add', '.');
    git(work, 'commit', '-qm', `c${i}`);
  }
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { dir, work, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('current branch aligned with its upstream', async () => {
  const { work, cleanup } = makeRepo();
  try {
    const s = await statusForCwd(work);
    assert.equal(s.state, 'synced');
    assert.equal(s.branch, 'main');
    assert.equal(s.branch_published, true);
    assert.equal(s.ahead, 0);
  } finally { cleanup(); }
});

test('detached HEAD: compares to the default branch, not to the whole history', async () => {
  const { work, cleanup } = makeRepo(3);
  try {
    git(work, 'checkout', '-q', '--detach', 'HEAD~1');
    const s = await statusForCwd(work);
    assert.equal(s.branch, null);
    // The "whole history" fallback must ONLY serve without a remote.
    assert.notEqual(s.ahead, 3);
    assert.equal(s.ahead, 0);
    assert.equal(s.behind, 1);
    assert.equal(s.compare_ref, 'origin/main');
    assert.equal(s.branch_published, false);
  } finally { cleanup(); }
});

test('branch never pushed: not published, gap counted against the default branch', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/jamais-poussee');
    writeFileSync(join(work, 'nouveau'), 'x');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'travail local');

    const s = await statusForCwd(work);
    assert.equal(s.branch, 'feat/jamais-poussee');
    assert.equal(s.branch_published, false, 'no commit of this branch is published');
    assert.equal(s.ahead, 1);

    const b = s.branches.find((x) => x.name === 'feat/jamais-poussee');
    assert.ok(b);
    assert.equal(b!.upstream, null);
    assert.equal(b!.published, false);
    // The bug: `null` here, shown as "0 to push" by the UI.
    assert.equal(b!.ahead, 1);
    assert.equal(b!.compare_ref, 'origin/main');
  } finally { cleanup(); }
});

test('branch published without tracking configured: counted against its remote namesake', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/poussee-sans-tracking');
    writeFileSync(join(work, 'a'), 'a');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'a');
    // Push WITHOUT `-u`: the branch exists on the remote, without a local upstream.
    git(work, 'push', '-q', 'origin', 'feat/poussee-sans-tracking');
    writeFileSync(join(work, 'b'), 'b');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'b');

    const s = await statusForCwd(work);
    assert.equal(s.branch_published, true);
    assert.equal(s.compare_ref, 'origin/feat/poussee-sans-tracking');
    assert.equal(s.ahead, 1);
  } finally { cleanup(); }
});

test('`<remote>/HEAD` not configured: the literal string is not taken for a ref', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    // A manual `remote add` does not set the `<remote>/HEAD` symref; only a
    // clone does. It is deleted to reproduce the case.
    try { git(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); } catch { /* absente */ }
    git(work, 'checkout', '-qb', 'feat/sans-remote-head');
    writeFileSync(join(work, 'z'), 'z');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'z');

    const s = await statusForCwd(work);
    // main/master fallback: without it, compare_ref was `origin/HEAD`, the
    // `rev-list` failed and the gap fell back to 0.
    assert.equal(s.compare_ref, 'origin/main');
    assert.equal(s.ahead, 1);
    assert.equal(s.branch_published, false);
  } finally { cleanup(); }
});

test('TODO #278: a branch whose remote branch was deleted is not "published, 0 to push"', async () => {
  const { work, cleanup } = makeRepo(2);
  try {
    git(work, 'checkout', '-qb', 'feat/gone');
    writeFileSync(join(work, 'g'), 'g');
    git(work, 'add', '.');
    git(work, 'commit', '-qm', 'g');
    git(work, 'push', '-q', '-u', 'origin', 'feat/gone');
    git(work, 'checkout', '-q', 'main');
    git(work, 'push', '-q', 'origin', '--delete', 'feat/gone');
    git(work, 'fetch', '-q', '--prune');

    const s = await statusForCwd(work);
    const b = s.branches.find((x) => x.name === 'feat/gone');
    assert.ok(b);
    // `%(upstream:track)` says `[gone]` with no count: read as "ahead 0".
    assert.equal(b!.upstream, null);
    assert.equal(b!.published, false);
    assert.equal(b!.compare_ref, 'origin/main');
    assert.equal(b!.ahead, 1);
  } finally { cleanup(); }
});

test('TODO #278: a detached HEAD with no default remote branch has an unknown count, not the whole history', async () => {
  const { work, cleanup } = makeRepo(3);
  try {
    // The remote only carries a branch that is neither `main` nor `master`,
    // and no `HEAD` symref: nothing to measure a detached HEAD against.
    // Rewritten on the local tracking refs: a bare remote refuses to delete
    // its own current branch.
    git(work, 'update-ref', 'refs/remotes/origin/trunk', 'refs/remotes/origin/main');
    git(work, 'update-ref', '-d', 'refs/remotes/origin/main');
    try { git(work, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD'); } catch { /* absent */ }
    git(work, 'checkout', '-q', '--detach', 'HEAD');

    const s = await statusForCwd(work);
    assert.equal(s.branch, null);
    assert.equal(s.compare_ref, null);
    assert.notEqual(s.ahead, 3);
    assert.equal(s.ahead, null);
  } finally { cleanup(); }
});

test('repository without a remote: the whole history is waiting to be published', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-'));
  try {
    const work = join(dir, 'solo');
    execFileSync('git', ['init', '-q', '-b', 'main', work]);
    git(work, 'config', 'user.email', 'test@timon.local');
    git(work, 'config', 'user.name', 'timon-test');
    for (let i = 0; i < 4; i++) {
      writeFileSync(join(work, `f${i}`), String(i));
      git(work, 'add', '.');
      git(work, 'commit', '-qm', `c${i}`);
    }
    const s = await statusForCwd(work);
    assert.equal(s.state, 'no-remote');
    assert.equal(s.compare_ref, null);
    assert.equal(s.ahead, 4);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('TIM-0083: a folder the daemon cannot use says why instead of "no working directory"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gitremote-cwd-'));
  try {
    const hole = join(dir, 'not-mounted');
    const missing = await statusForCwd(hole);
    assert.equal(missing.state, 'no-cwd');
    assert.equal(missing.cwd, null);
    assert.equal(missing.cwd_path, hole);
    assert.equal(missing.cwd_error, 'missing');
    assert.equal(missing.cwd_code, 'ENOENT');

    const file = join(dir, 'a-file');
    writeFileSync(file, 'x');
    const onFile = await statusForCwd(file);
    assert.equal(onFile.state, 'no-cwd');
    assert.equal(onFile.cwd_error, 'not-a-directory');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
