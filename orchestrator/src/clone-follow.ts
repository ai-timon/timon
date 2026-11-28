/**
 * Keeps the working copy of the main clone level with a branch the daemon just
 * moved.
 *
 * Missions never write in the main clone's working copy: they work in
 * worktrees. When the base branch they land on is the one checked out in that
 * clone, its ref used to be refused (`advanceBaseByReference`) or left alone
 * (`refreshLocalTarget`), so the clone fell behind. The daemon, outside any
 * mission fence, now moves the ref and the files together, under strict
 * conditions:
 *
 * - the branch is checked out in the main working copy, HEAD on it (a
 *   detached HEAD, or another branch there, is the user's position: untouched);
 * - the working copy is clean: `status --porcelain` is empty, untracked files
 *   that are not ignored included, and no merge, rebase, cherry-pick, revert or
 *   bisect is under way;
 * - the move is a fast-forward from the sha the caller read, so a branch that
 *   moved meanwhile, or that diverged, is left as it is.
 *
 * The move is `git merge --ff-only <sha>` run in the working copy: git updates
 * the ref and the tree under one lock and refuses by itself when a file would
 * be overwritten. Never a reset, a stash or a forced checkout; the result is
 * read back, and a mismatch is reported, not repaired. Hooks are switched off:
 * a repository hook is the user's code, not something the daemon runs.
 *
 * Whatever is not done is said: `console.warn` and an `audit_log` row
 * (`clone.follow.skipped`, actor `daemon`) carrying the reason.
 */
import { existsSync } from 'node:fs';
import { devNull } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { dbApi } from './db.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';

export type FollowOutcome =
  | { status: 'followed'; previous: string; sha: string }
  /** The branch already contains the target sha (or equals it): nothing to do. */
  | { status: 'unchanged'; sha: string }
  /** The branch is not checked out in the main working copy: not ours to touch. */
  | { status: 'not_checked_out' }
  | { status: 'skipped'; reason: string };

export const FOLLOW_AUDIT_ACTION = 'clone.follow.skipped';

const SHA = /^[0-9a-f]{40,64}$/;
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply', 'sequencer'];

async function git(cwd: string, args: string[], timeout = 30_000): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', cwd, ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

// One move at a time per repository: two merges landing together must not
// interleave their checks and their fast-forward.
const chains = new Map<string, Promise<unknown>>();

function serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const run = (chains.get(repo) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  chains.set(repo, tail);
  void tail.then(() => { if (chains.get(repo) === tail) chains.delete(repo); });
  return run;
}

/** The main working copy: the first entry of `worktree list`, and its branch. */
async function mainCheckout(repo: string): Promise<{ path: string; branch: string | null } | null> {
  const r = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  if (r.code !== 0) return null;
  const fields = r.stdout.split('\0');
  if (!fields[0]?.startsWith('worktree ')) return null;
  const path = fields[0].slice('worktree '.length);
  let branch: string | null = null;
  for (const field of fields.slice(1)) {
    if (field === '') break; // end of the first record
    if (field.startsWith('branch refs/heads/')) branch = field.slice('branch refs/heads/'.length);
  }
  return { path, branch };
}

async function refSha(dir: string, ref: string): Promise<string | null> {
  const r = await git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

async function operationInProgress(dir: string): Promise<string | null> {
  for (const name of IN_PROGRESS) {
    const r = await git(dir, ['rev-parse', '--git-path', name]);
    const p = r.stdout.trim();
    if (r.code !== 0 || !p) continue;
    if (existsSync(isAbsolute(p) ? p : join(dir, p))) return name;
  }
  return null;
}

function skip(branch: string, reason: string): FollowOutcome {
  console.warn(`[clone-follow] working copy of ${branch} left as it is: ${reason}`);
  try {
    dbApi.insertAuditLog({ actor: 'daemon', action: FOLLOW_AUDIT_ACTION, target: `${branch}: ${reason}`.slice(0, 500) });
  } catch (err) {
    console.warn(`[clone-follow] cannot journal the skip: ${(err as Error).message}`);
  }
  return { status: 'skipped', reason };
}

/**
 * Brings the main working copy up to `target` (a sha or a ref) when `branch`
 * is checked out there. `expected` is the sha the caller read the branch at:
 * a branch that is elsewhere by now is left alone.
 */
export function followCheckedOutBranch(
  repo: string,
  branch: string,
  target: string,
  expected?: string,
): Promise<FollowOutcome> {
  return serial(repo, async () => {
    const checkout = await mainCheckout(repo);
    if (!checkout || checkout.branch !== branch) return { status: 'not_checked_out' };
    const dir = checkout.path;
    if (!existsSync(dir)) return skip(branch, 'the main working copy no longer exists');
    const head = await git(dir, ['symbolic-ref', '--quiet', 'HEAD']);
    if (head.code !== 0 || head.stdout.trim() !== `refs/heads/${branch}`) {
      return skip(branch, 'HEAD is not on the branch');
    }
    const current = await refSha(dir, `refs/heads/${branch}`);
    const next = await refSha(dir, target);
    if (!current || !next) return skip(branch, 'the branch or the target commit cannot be resolved');
    if (expected && current !== expected) return skip(branch, 'the branch moved since it was read');
    // Already contains the target (the branch is ahead, or level): nothing to
    // follow, and not worth a warning.
    if ((await git(dir, ['merge-base', '--is-ancestor', next, current])).code === 0) {
      return { status: 'unchanged', sha: current };
    }
    if ((await git(dir, ['merge-base', '--is-ancestor', current, next])).code !== 0) {
      return skip(branch, 'the history diverged: the branch is not an ancestor of the target');
    }
    const op = await operationInProgress(dir);
    if (op) return skip(branch, `an operation is under way in the working copy (${op})`);
    const status = await git(dir, ['status', '--porcelain', '--untracked-files=normal']);
    if (status.code !== 0) return skip(branch, 'git could not read the working copy status');
    if (status.stdout.trim() !== '') return skip(branch, 'the working copy has uncommitted changes or untracked files');
    // The sha is passed, not the ref: what was checked above is what moves.
    const ff = await git(dir, ['-c', `core.hooksPath=${devNull}`, 'merge', '--ff-only', '--quiet', next], 120_000);
    const now = await refSha(dir, `refs/heads/${branch}`);
    if (ff.code !== 0 || now !== next) {
      const why = ff.stderr.trim().slice(-200) || `the branch is at ${now ?? 'nothing'}, expected ${next}`;
      return skip(branch, `the fast-forward did not complete: ${why}`);
    }
    return { status: 'followed', previous: current, sha: next };
  });
}
