/**
 * Integration branches of the Kanban → pull request pipeline
 * (`docs/KANBAN-PR-PIPELINE.md` §2.2, step 2 of §8).
 *
 * A job whose chain lands through a pull request merges its volets into an
 * integration branch (`feat/<topic>`, or `sec/<topic>` under embargo) cut from
 * the remote's target (`origin/main`), never from the local `main`, which may
 * be stale or carry the user's unpublished work.
 *
 * A project that merges locally may also give a job a branch of its own (the
 * Kanban planner). That branch is cut from the project's local target, named
 * as `refs/heads/<target>` in the chain's `base_ref`: a choice the planner
 * recorded, never a fallback for a remote that cannot be reached.
 *
 * Two rules hold every function here:
 *
 * - **Fail closed.** No remote, a remote that cannot be reached, a target the
 *   remote does not have: the caller gets a refusal with a reason, never a
 *   branch quietly cut from the local base instead.
 * - **The shared checkout is not touched, but for one case.** The branch is
 *   created with `git branch` (no checkout), the base moves with `git
 *   update-ref` guarded by its old value; the index, the working directory and
 *   the user's HEAD stay as they were, detached or not. The exception is a base
 *   checked out in the main working copy: `clone-follow.ts` fast-forwards it,
 *   files included, only when that copy is clean.
 */
import { execFileHost } from './host/index.js';
import { followCheckedOutBranch } from './clone-follow.js';
import { isPlausibleGitRef } from './task-git.js';

const exec = execFileHost;

/** How a chain lands. `local`: today's pipelines, the base taken as it is.
 *  `branch`: an integration branch cut from the remote, landed by hand (the
 *  embargo case). `pr`: the same branch, landed by a pull request. */
export const INTEGRATION_MODES = ['local', 'branch', 'pr'] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export function isIntegrationMode(value: unknown): value is IntegrationMode {
  return typeof value === 'string' && (INTEGRATION_MODES as readonly string[]).includes(value);
}

/** True when the chain's base is an integration branch the daemon creates. */
export function usesIntegrationBranch(mode: string | null | undefined): boolean {
  return mode === 'branch' || mode === 'pr';
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
/** A run of 7+ hex characters holding a digit: a commit or task id once shortened. */
const HEX_ID = /(?:^|[^0-9a-z])(?=[0-9a-f]*[0-9])[0-9a-f]{7,}(?:$|[^0-9a-z])/i;

/**
 * Why `name` cannot be an integration branch, or null. Once pushed the branch is
 * public, so beyond a plausible ref its name carries no task or commit id, and
 * it stays out of `timon/`, the namespace of the task and merge branches the
 * garbage collector owns.
 */
export function integrationBranchRefusal(name: string): string | null {
  if (!isPlausibleGitRef(name)) return `"${name}" is not a valid branch name`;
  if (name === 'HEAD' || name.startsWith('timon/')) {
    return `"${name}" is reserved for Timon's own task branches`;
  }
  if (UUID.test(name) || HEX_ID.test(name)) {
    return `"${name}" carries an id: an integration branch is public once pushed`;
  }
  return null;
}

/**
 * The default integration branch of a job: `feat/<slug>` from its title (or
 * the project's own `prefix`), or `sec/<slug>` for a fix under embargo, whatever
 * the prefix. Ids and accents are dropped; null when nothing usable is left, in
 * which case the caller names the branch itself.
 */
export function integrationBranchName(
  title: string,
  opts: { embargo?: boolean; prefix?: string } = {},
): string | null {
  const words = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(UUID, ' ')
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !(w.length >= 7 && /^[0-9a-f]+$/.test(w) && /[0-9]/.test(w)));
  let slug = '';
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 48) break;
    slug = next;
  }
  if (!slug) return null;
  const name = `${opts.embargo ? 'sec/' : opts.prefix ?? 'feat/'}${slug}`;
  return integrationBranchRefusal(name) ? null : name;
}

/**
 * A local target, as a chain's `base_ref`: `refs/heads/main`. A project that
 * merges locally may still give a job a branch of its own (the Kanban
 * planner); that branch is cut from the project's local target, which the
 * full ref names without any doubt. A remote's target is always
 * `<remote>/<target>`, never this form, so a remote that is gone is still
 * refused instead of being read as a local branch.
 */
export const LOCAL_BASE_REF_PREFIX = 'refs/heads/';

export function localBaseRef(target: string): string {
  return `${LOCAL_BASE_REF_PREFIX}${target}`;
}

/** The local target a `base_ref` names, or null for a remote's. */
export function localTargetOf(baseRef: string | null | undefined): string | null {
  return baseRef?.startsWith(LOCAL_BASE_REF_PREFIX) ? baseRef.slice(LOCAL_BASE_REF_PREFIX.length) || null : null;
}

/** `origin/main`, or `main` for a local target: how a person reads the base. */
export function baseRefLabel(baseRef: string): string {
  return localTargetOf(baseRef) ?? baseRef;
}

/** Where an integration row lands, as a person reads it: `origin/main`, or
 *  `main` for a job of a project that merges locally (no remote). */
export function integrationTargetLabel(row: { remote: string; target: string }): string {
  return row.remote ? `${row.remote}/${row.target}` : row.target;
}

/** Why an integration branch could not be made ready. */
export type IntegrationRefusalCode =
  | 'invalid_branch'
  | 'invalid_base_ref'
  | 'no_remote'
  | 'remote_unreachable'
  | 'target_missing'
  | 'branch_missing'
  | 'create_failed';

export type EnsureIntegrationOutcome =
  | { ok: true; created: boolean; sha: string; remote: string; target: string }
  | { ok: false; code: IntegrationRefusalCode; reason: string };

async function git(repo: string, args: string[], timeout = 15_000): Promise<string> {
  const r = await exec('git', ['-C', repo, ...args], { timeout });
  return r.stdout.trim();
}

async function gitOk(repo: string, args: string[], timeout = 15_000): Promise<boolean> {
  try {
    await exec('git', ['-C', repo, ...args], { timeout });
    return true;
  } catch {
    return false;
  }
}

async function localBranchSha(repo: string, branch: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`])) || null;
  } catch {
    return null;
  }
}

/** `origin/main` → remote `origin`, target `main`, against the repository's
 *  remotes (a remote's name may itself hold a slash: the longest match wins). */
export function splitRemoteRef(
  ref: string,
  remotes: readonly string[],
): { remote: string; target: string } | null {
  const match = [...remotes]
    .filter((r) => r && ref.startsWith(`${r}/`) && ref.length > r.length + 1)  // portability: a git remote ref (origin/main), not a path
    .sort((a, b) => b.length - a.length)[0];
  return match ? { remote: match, target: ref.slice(match.length + 1) } : null;
}

// No terminal behind the daemon: git must fail rather than wait for a
// username or a passphrase nobody will type.
const NETWORK_ENV = (): NodeJS.ProcessEnv => ({ ...process.env, GIT_TERMINAL_PROMPT: '0' });
const NETWORK_TIMEOUT_MS = 60_000;

function tail(err: unknown): string {
  const e = err as Error & { stderr?: string; timedOut?: boolean };
  if (e.timedOut) return 'timed out';
  return ((e.stderr ?? '').trim() || e.message || 'git failed').slice(-300);
}

/**
 * Makes `branch` exist in `repo`, cut from `baseRef` (`origin/main`).
 *
 * A branch already there is kept as it is, without a network call: it is a job
 * being resumed, and its volets may already be merged into it. Otherwise the
 * target is fetched into its remote-tracking ref and the branch created from
 * it, without a checkout and without an upstream (a bare `git push` from the
 * branch must never reach the target).
 *
 * When the target is not checked out anywhere, its local branch is then moved
 * up to the remote's (fast-forward only, best effort): `git fetch` refuses on
 * its own a branch checked out in a worktree or one that diverged, so the
 * user's local work is never rewritten.
 */
export async function ensureIntegrationBranch(
  repo: string,
  opts: {
    branch: string;
    baseRef: string;
    /** The job was planned on a branch the repository already has: never cut it. */
    mustExist?: boolean;
  },
): Promise<EnsureIntegrationOutcome> {
  const refusal = integrationBranchRefusal(opts.branch);
  if (refusal) return { ok: false, code: 'invalid_branch', reason: refusal };
  if (!isPlausibleGitRef(opts.baseRef)) {
    return { ok: false, code: 'invalid_base_ref', reason: `"${opts.baseRef}" is not a valid remote ref` };
  }
  const localTarget = localTargetOf(opts.baseRef);
  if (localTarget !== null) return ensureLocalBranch(repo, opts.branch, localTarget, opts.mustExist === true);
  if (opts.mustExist && !(await localBranchSha(repo, opts.branch))) {
    return { ok: false, code: 'branch_missing', reason: `${opts.branch} does not exist in the repository` };
  }
  let remotes: string[];
  try {
    remotes = (await git(repo, ['remote'])).split('\n').map((r) => r.trim()).filter(Boolean);
  } catch (err) {
    return { ok: false, code: 'no_remote', reason: `cannot list the remotes of the repository: ${tail(err)}` };
  }
  if (remotes.length === 0) {
    return {
      ok: false,
      code: 'no_remote',
      reason: `the repository has no remote, so ${opts.baseRef} cannot be fetched to cut ${opts.branch} from it`,
    };
  }
  const split = splitRemoteRef(opts.baseRef, remotes);
  if (!split) {
    return {
      ok: false,
      code: 'no_remote',
      reason: `${opts.baseRef} names no remote of the repository (remotes: ${remotes.join(', ')})`,
    };
  }
  const { remote, target } = split;

  const existing = await localBranchSha(repo, opts.branch);
  if (existing) return { ok: true, created: false, sha: existing, remote, target };

  const tracking = `refs/remotes/${remote}/${target}`;
  try {
    await exec('git', ['-C', repo, 'fetch', '--no-tags', '--', remote, `+refs/heads/${target}:${tracking}`], {
      timeout: NETWORK_TIMEOUT_MS,
      env: NETWORK_ENV(),
    });
  } catch (err) {
    // Tell "the remote answered, without that branch" from "no answer": the
    // fix differs (a name to correct, or a network or a key to restore).
    // `ls-remote --exit-code` exits 2 when the remote answers with no match,
    // a signal git's localised messages would not give reliably.
    let missing = false;
    try {
      await exec('git', ['-C', repo, 'ls-remote', '--exit-code', '--heads', '--', remote, `refs/heads/${target}`], {
        timeout: NETWORK_TIMEOUT_MS,
        env: NETWORK_ENV(),
      });
    } catch (probe) {
      missing = (probe as { code?: number }).code === 2;
    }
    return missing
      ? { ok: false, code: 'target_missing', reason: `remote ${remote} has no branch ${target}` }
      : { ok: false, code: 'remote_unreachable', reason: `cannot fetch ${target} from remote ${remote}: ${tail(err)}` };
  }
  const base = await refSha(repo, tracking);
  if (!base) {
    return { ok: false, code: 'target_missing', reason: `${opts.baseRef} is still missing after the fetch` };
  }
  try {
    await git(repo, ['branch', '--no-track', '--', opts.branch, base]);
  } catch (err) {
    // A concurrent dispatch may have created it a moment ago: same outcome.
    const raced = await localBranchSha(repo, opts.branch);
    if (raced) return { ok: true, created: false, sha: raced, remote, target };
    return { ok: false, code: 'create_failed', reason: `cannot create ${opts.branch}: ${tail(err)}` };
  }
  await refreshLocalTarget(repo, remote, target);
  return { ok: true, created: true, sha: base, remote, target };
}

/**
 * The branch of a job in a project that merges locally: cut from the local
 * `target`, without a checkout and without a network call. A branch already
 * there is kept as it is (a job resumed, or one planned on an existing branch).
 */
async function ensureLocalBranch(
  repo: string,
  branch: string,
  target: string,
  mustExist: boolean,
): Promise<EnsureIntegrationOutcome> {
  if (!isPlausibleGitRef(target)) {
    return { ok: false, code: 'invalid_base_ref', reason: `"${target}" is not a valid branch name` };
  }
  const existing = await localBranchSha(repo, branch);
  if (existing) return { ok: true, created: false, sha: existing, remote: '', target };
  if (mustExist) return { ok: false, code: 'branch_missing', reason: `${branch} does not exist in the repository` };
  const base = await localBranchSha(repo, target);
  if (!base) return { ok: false, code: 'target_missing', reason: `the repository has no branch ${target} to cut ${branch} from` };
  try {
    await git(repo, ['branch', '--no-track', '--', branch, base]);
  } catch (err) {
    const raced = await localBranchSha(repo, branch);
    if (raced) return { ok: true, created: false, sha: raced, remote: '', target };
    return { ok: false, code: 'create_failed', reason: `cannot create ${branch}: ${tail(err)}` };
  }
  return { ok: true, created: true, sha: base, remote: '', target };
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  try {
    return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])) || null;
  } catch {
    return null;
  }
}

/** Branches checked out in any worktree of `repo`, the main checkout included. */
export async function checkedOutBranches(repo: string): Promise<Set<string>> {
  const out = await git(repo, ['worktree', 'list', '--porcelain']);
  const branches = new Set<string>();
  for (const line of out.split('\n')) {
    const m = /^branch refs\/heads\/(.+)$/.exec(line.trim());
    if (m?.[1]) branches.add(m[1]);
  }
  return branches;
}

async function refreshLocalTarget(repo: string, remote: string, target: string): Promise<void> {
  try {
    if ((await checkedOutBranches(repo)).has(target)) {
      // Checked out: `git fetch` refuses to move it, and the user's own pull is
      // not ours. The daemon only follows the remote-tracking ref the caller
      // just fetched, and only when the working copy is clean (clone-follow).
      const tracking = await refSha(repo, `refs/remotes/${remote}/${target}`);
      if (tracking) await followCheckedOutBranch(repo, target, tracking);
      return;
    }
    if (!(await localBranchSha(repo, target))) return;
    await exec('git', ['-C', repo, 'fetch', '--no-tags', '--', remote, `refs/heads/${target}:refs/heads/${target}`], {
      timeout: NETWORK_TIMEOUT_MS,
      env: NETWORK_ENV(),
    });
  } catch (err) {
    console.warn(`[integration] local ${target} left as it is: ${tail(err)}`);
  }
}

export type AdvanceBaseOutcome =
  | { ok: true; sha: string; previous: string }
  | {
      ok: false;
      code: 'unknown_ref' | 'checked_out' | 'not_fast_forward' | 'moved' | 'sha_mismatch';
      reason: string;
    };

/**
 * Moves `base` to the commit `source` names, by reference only.
 *
 * Never `git merge --ff-only` in the main checkout: it moves whatever HEAD
 * stands on, which, detached, is not the base at all but the user's own
 * position. `update-ref` touches the base's ref and nothing else; it is given
 * the old value, so a base another merger moved in between is refused instead
 * of overwritten, and the result is read back before it is reported.
 */
export async function advanceBaseByReference(
  repo: string,
  source: string,
  base: string,
): Promise<AdvanceBaseOutcome> {
  const next = await refSha(repo, source);
  const previous = await localBranchSha(repo, base);
  if (!next || !previous) {
    return { ok: false, code: 'unknown_ref', reason: `${next ? base : source} does not exist in the repository` };
  }
  if ((await checkedOutBranches(repo)).has(base)) {
    // The main working copy has it checked out: the ref and the files move
    // together (clone-follow), or nothing moves. Another worktree having it
    // keeps the refusal: its directory would be left behind the ref.
    if (!(await gitOk(repo, ['merge-base', '--is-ancestor', previous, next]))) {
      return { ok: false, code: 'not_fast_forward', reason: `${source} does not contain ${base}: bring ${base} into it first` };
    }
    const followed = await followCheckedOutBranch(repo, base, next, previous);
    if (followed.status === 'followed') return { ok: true, sha: next, previous };
    if (followed.status === 'unchanged') return { ok: true, sha: followed.sha, previous };
    return {
      ok: false,
      code: 'checked_out',
      reason:
        followed.status === 'skipped'
          ? `${base} is checked out and its working copy was not moved: ${followed.reason}`
          : `${base} is checked out in a worktree: moving its ref would leave that working directory behind it`,
    };
  }
  if (!(await gitOk(repo, ['merge-base', '--is-ancestor', previous, next]))) {
    return { ok: false, code: 'not_fast_forward', reason: `${source} does not contain ${base}: bring ${base} into it first` };
  }
  try {
    await git(repo, ['update-ref', '-m', `timon: advance ${base}`, `refs/heads/${base}`, next, previous]);
  } catch (err) {
    return { ok: false, code: 'moved', reason: `${base} moved while advancing it: ${tail(err)}` };
  }
  const now = await localBranchSha(repo, base);
  if (now !== next) {
    return { ok: false, code: 'sha_mismatch', reason: `${base} is at ${now ?? 'nothing'}, expected ${next}` };
  }
  return { ok: true, sha: next, previous };
}
