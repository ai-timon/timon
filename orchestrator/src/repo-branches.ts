/**
 * The local branches of a project's repository, read where the Kanban planner
 * builds and checks its form (`plan-landing.ts`).
 *
 * Synchronous on purpose, like the merge guard's reads (`code-gate.ts`): the
 * planner's card is built and answered in one tick, and a `for-each-ref` or a
 * `show-ref` takes milliseconds. Bounded by a short timeout; a git that cannot
 * answer gives null, never a guess.
 */
import { getHost } from './host/index.js';
import { isPlausibleGitRef } from './task-git.js';

/** A local branch, newest commit first. */
export type RepoBranch = { name: string; committed_at: number };

/** Enough for a picker: the branches worked on lately come first. */
export const MAX_REPO_BRANCHES = 100;

function git(repo: string, args: string[]): { code: number; stdout: string } {
  return getHost().exec('git', ['-C', repo, ...args], { timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * The repository's local branches a job may start from, by date of their last
 * commit, newest first. Timon's own task and merge branches (`timon/…`) are
 * left out: a job never starts from one. Null when git cannot read them.
 */
export function listRepoBranches(repo: string, limit = MAX_REPO_BRANCHES): RepoBranch[] | null {
  try {
    const r = git(repo, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%09%(committerdate:unix)', 'refs/heads/']);
    if (r.code !== 0) return null;
    const out: RepoBranch[] = [];
    for (const line of r.stdout.split('\n')) {
      const [ref, date] = line.trim().split('\t');
      if (!ref?.startsWith('refs/heads/')) continue;
      const name = ref.slice('refs/heads/'.length);
      if (!name || name.startsWith('timon/')) continue;
      out.push({ name, committed_at: Number(date) * 1000 || 0 });
      if (out.length >= limit) break;
    }
    return out;
  } catch {
    return null;
  }
}

/** Whether `name` is a local branch of `repo`; null when git cannot tell. */
export function repoBranchExists(repo: string, name: string): boolean | null {
  if (!isPlausibleGitRef(name)) return false;
  try {
    const r = git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]);
    return r.code === 0 ? true : r.code === 1 ? false : null;
  } catch {
    return null;
  }
}
