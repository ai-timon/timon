/**
 * A GitHub stand-in made of local repositories, for the conflict resolution
 * of a contributor's pull request: a base repository (`acme/widgets`) whose
 * `main` moved, a fork (`contrib/widgets`) whose branch conflicts with it,
 * and the base's `refs/pull/<n>/head` pointing at the fork's head, as GitHub
 * serves it.
 *
 * `fixtureGit` runs the real git with the URLs of the forge mapped to these
 * folders and the local transport the scratch repository refuses allowed
 * again: everything else (merge-tree, the index, the push) is git itself.
 */
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GitRunner } from '../../src/host/forge.js';

/** The URLs the daemon writes for the two repositories (`forgeNetworkUrl`). */
export const BASE_URL = 'ssh://git@github.com/acme/widgets.git';
export const FORK_URL = 'ssh://git@github.com/contrib/widgets.git';

export type ForgeFixture = {
  root: string;
  base: string;
  fork: string;
  /** Runs git in `dir` (a work tree of the fixture), returns stdout. */
  git(dir: string, ...args: string[]): string;
  /** Commits `files` on the current branch of `dir`. */
  commit(dir: string, message: string, files: Record<string, string>): string;
  head(bare: string, ref: string): string;
  /** Points the base's `refs/pull/<n>/head` at the fork's `branch`. */
  publishPull(number: number, branch: string): string;
  runner: GitRunner;
  /** Every argument list the runner was given. */
  calls: string[][];
};

const IDENTITY = ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgSign=false', '-c', 'init.defaultBranch=main'];

export function forgeFixture(files: Record<string, string>): ForgeFixture {
  const root = mkdtempSync(join(tmpdir(), 'timon-forge-fixture-'));
  const work = join(root, 'work');
  const base = join(root, 'acme-widgets.git');
  const fork = join(root, 'contrib-widgets.git');
  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', [...IDENTITY, ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = (dir: string, message: string, content: Record<string, string>): string => {
    for (const [path, text] of Object.entries(content)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  mkdirSync(work);
  git(work, 'init', '-q');
  // A fixture of its own: two fixtures made in the same second must not share a commit.
  commit(work, 'base', { ...files, '.fixture': `${root}\n` });
  git(root, 'init', '-q', '--bare', base);
  git(root, 'init', '-q', '--bare', fork);
  git(work, 'push', '-q', base, 'HEAD:refs/heads/main');
  git(work, 'push', '-q', fork, 'HEAD:refs/heads/main');
  const urls = new Map([[BASE_URL, base], [FORK_URL, fork]]);
  const calls: string[][] = [];
  const runner: GitRunner = (args, opts) => new Promise((resolve) => {
    calls.push([...args]);
    const mapped = args.map((a) => (a === 'protocol.file.allow=never' ? 'protocol.file.allow=always' : urls.get(a) ?? a));
    execFile('git', mapped, { ...opts, encoding: 'utf8' }, (err, stdout, stderr) => resolve({
      code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
      stdout: String(stdout),
      stderr: String(stderr),
      ...(err && (err as { killed?: boolean }).killed ? { timedOut: true } : {}),
    }));
  });
  return {
    root, base, fork, git, commit, runner, calls,
    head: (bare, ref) => git(root, `--git-dir=${bare}`, 'rev-parse', ref),
    publishPull(number, branch) {
      const sha = git(root, `--git-dir=${fork}`, 'rev-parse', `refs/heads/${branch}`);
      git(work, 'fetch', '-q', fork, `refs/heads/${branch}`);
      git(work, 'push', '-q', base, `${sha}:refs/pull/${number}/head`);
      return sha;
    },
  };
}

/** A work tree of `bare` at `branch`, to move a branch of the fixture. */
export function checkout(f: ForgeFixture, bare: string, branch: string, from = 'main'): string {
  const dir = mkdtempSync(join(f.root, 'clone-'));
  f.git(f.root, 'clone', '-q', bare, dir);
  if (branch === from) f.git(dir, 'checkout', '-q', branch);
  else f.git(dir, 'checkout', '-q', '-b', branch, `origin/${from}`);
  return dir;
}
