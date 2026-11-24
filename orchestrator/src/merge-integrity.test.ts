/**
 * Control of destructive merges.
 *
 * The scenario reproduced here is the one of 2026-08-20: while a branch
 * works, ANOTHER one integrates code on the base; the merge of the first
 * ends up erasing that code without anybody asking. The difficulty
 * is not spotting deletions: it is telling those the
 * branch legitimately asks for from those it takes along on the way.
 *
 * The git tests run in a temporary repository, not on a real one.
 *
 * `node --test --import tsx src/merge-integrity.test.ts`
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { unjustifiedDeletions, inspectMerge } from './merge-integrity.js';

test('a deletion the branch asks for is legitimate, another is not', () => {
  assert.deepEqual(
    unjustifiedDeletions(['a.ts', 'b.ts', 'c.ts'], ['b.ts']),
    ['a.ts', 'c.ts'],
  );
  // The nominal case: the branch deletes exactly what it had announced.
  assert.deepEqual(unjustifiedDeletions(['b.ts'], ['b.ts']), []);
  assert.deepEqual(unjustifiedDeletions([], ['b.ts']), []);
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

/** A throwaway repository with `main`, a work branch, and what it takes to replay a
 *  concurrent integration. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-merge-integrity-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@timon');
  git(dir, 'config', 'user.name', 'test');
  writeFileSync(join(dir, 'socle.ts'), 'export const socle = 1;\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'socle');
  return dir;
}

test('a merge that takes away the work integrated in the meantime is reported', async () => {
  const dir = makeRepo();
  try {
    // A branch leaves to work…
    git(dir, 'checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'feat.ts'), 'export const feat = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'feat');

    // … while ANOTHER task integrates `analytics.ts` on main.
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'analytics.ts'), 'export const analytics = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'analytics (autre task)');

    // The merger integrates `feat` with a resolution that erases analytics.ts,
    // exactly what a `git add -A` from a stale state produces.
    git(dir, 'merge', '--no-commit', '--no-ff', 'feat');
    rmSync(join(dir, 'analytics.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'merge: feat');
    const sha = git(dir, 'rev-parse', 'HEAD');

    const report = await inspectMerge(dir, sha);
    assert.equal(report.status, 'broken');
    assert.deepEqual(report.status === 'broken' ? report.deleted : [], ['analytics.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a deletion the branch wants triggers nothing', async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'cleanup');
    // The branch deletes `socle.ts`: that is ITS work, not an accident.
    rmSync(join(dir, 'socle.ts'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'retire le socle obsolète'); // french-ok: a sample commit message

    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--no-ff', '--no-edit', '-q', 'cleanup');
    const sha = git(dir, 'rev-parse', 'HEAD');

    const report = await inspectMerge(dir, sha);
    assert.equal(report.status, 'clean', 'a deliberate clean-up must not restart the agent');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a fast-forward is clean by construction', async () => {
  const dir = makeRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'ff');
    writeFileSync(join(dir, 'ajout.ts'), 'export const a = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'ajout');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '--ff-only', '-q', 'ff');
    const sha = git(dir, 'rev-parse', 'HEAD');

    // A single parent: the base could lose nothing that does not come from the branch.
    assert.equal((await inspectMerge(dir, sha)).status, 'clean');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an impossible inspection concludes NOTHING', async () => {
  const dir = makeRepo();
  try {
    // Accusing a merge on the strength of a failed inspection would restart an agent
    // for a problem that does not exist.
    const report = await inspectMerge(dir, 'ffffffffffffffffffffffffffffffffffffffff');
    assert.equal(report.status, 'unknown');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ── Bringing a worktree up to date on its base ──────────────────────────── */

test('a stale worktree is brought up to date, an up-to-date worktree is left as is', async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const dir = makeRepo();
  const wt = join(dir, '..', `wt-${Date.now()}`);
  try {
    git(dir, 'worktree', 'add', '-q', '-b', 'travail', wt);
    // The base moves on while the branch sleeps: the case of an `[iter:3]` task.
    writeFileSync(join(dir, 'autre.ts'), 'export const autre = 1;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'une autre task a intégré du code'); // french-ok: a sample commit message

    const first = await refreshWorktreeBase(wt, 'main');
    assert.equal(first.status, 'merged');
    // The file of the other task is now visible from the branch: it
    // will therefore not erase it at its final merge.
    assert.match(git(wt, 'log', '--oneline', '-5'), /autre task/);

    // Immediate recall: nothing to do, and above all no empty merge commit.
    assert.equal((await refreshWorktreeBase(wt, 'main')).status, 'up-to-date');
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an update conflict is reported, not swallowed', async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const dir = makeRepo();
  const wt = join(dir, '..', `wt-conflict-${Date.now()}`);
  try {
    git(dir, 'worktree', 'add', '-q', '-b', 'divergente', wt);
    writeFileSync(join(wt, 'socle.ts'), 'export const socle = 2;\n');
    git(wt, 'add', '-A');
    git(wt, 'commit', '-qm', 'version branche');

    writeFileSync(join(dir, 'socle.ts'), 'export const socle = 3;\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'version base');

    const out = await refreshWorktreeBase(wt, 'main');
    assert.equal(out.status, 'conflict');
    // The agent must know WHERE to look: a conflict announced without its list
    // sends it groping, and groping on a merge means overwriting.
    assert.deepEqual(out.status === 'conflict' ? out.files : [], ['socle.ts']);
  } finally {
    rmSync(wt, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing worktree does not make the spawn fail', async () => {
  const { refreshWorktreeBase } = await import('./worktree.js');
  const out = await refreshWorktreeBase('/tmp/timon-worktree-qui-nexiste-pas', 'main');
  assert.equal(out.status, 'failed');
});
