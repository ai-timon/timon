/**
 * A throwaway bare repository where the daemon merges a contributor's branch
 * WITHOUT a working tree (`docs/FORGE-FLOW-PLAN.md` §6.2 method B, §6.3).
 *
 * Nothing of the contributor's code is ever extracted, checked out or run:
 * the merge is `git merge-tree --write-tree`, which reads and writes objects
 * only; a resolution is a blob written with `hash-object --no-filters`; the
 * tree is rebuilt in a private index file (`read-tree`, `update-index
 * --cacheinfo`, `write-tree`), and the commit is `commit-tree`. No command here
 * reads or writes a file of the merged tree on the disk, so no hook, no
 * `.gitattributes` filter or driver, no `core.fsmonitor`, no submodule and no
 * symbolic link of the contributor's branch can act.
 *
 * Every call runs:
 * - through the host's git (`git-neutral.ts`: fixed hooks folder, no fsmonitor,
 *   no `ext::` transport, every command-running key of a writable scope
 *   neutralized, a PATH without a folder a mission writes);
 * - with neither the system nor the user's git configuration
 *   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL` pointing at an empty file of the
 *   scratch folder), nor any `GIT_*` variable of the daemon's environment but
 *   the SSH ones, so nothing set outside this folder changes what git does;
 * - with object checks on every transfer (`transfer.fsckObjects`), no local
 *   transport (`protocol.file.allow=never`), no symbolic link, no line-ending
 *   conversion, no background maintenance and no commit signature.
 *
 * The network side is two gestures: a fetch of the base branch and of the pull
 * request's head (`refs/pull/<n>/head`, served by the base repository, so the
 * fork's own URL is never fetched), and the push of ONE commit to the
 * contributor's branch, built here as `<sha>:refs/heads/<branch>`, never forced
 * (`pushCommitArguments`): git itself refuses what is not a fast-forward.
 * Credentials are those of the project's account: its SSH alias, or `gh` as
 * the credential helper with the project's `GH_CONFIG_DIR` for an https URL.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ghEnv } from './gh.js';
import { getHost } from './index.js';
import { plainBranch, pushCommitArguments, redactedOutput, type GitNetworkOutcome, type GitRunner } from './forge.js';
import type { ExecOpts, ExecResult } from './types.js';

const hostGit: GitRunner = (args, opts) => getHost().execAsync('git', args, opts);

/**
 * Resolves the host an SSH alias connects to, for `user` and `port` when given
 * (the port git passes `ssh -p`, null when the URL names none); null when it
 * cannot tell.
 */
export type SshHostResolver = (alias: string, user?: string, port?: string | null) => Promise<string | null>;

const SSH_ALIAS = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SSH_LOGIN = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const SSH_PORT = /^[1-9][0-9]{0,4}$/;

/** The `hostname` line of `ssh -G` output, lowercased, or null. */
export function parseSshHostName(stdout: string): string | null {
  const m = /^hostname\s+(\S+)\s*$/im.exec(stdout);
  return m ? m[1]!.toLowerCase() : null;
}

/**
 * A resolver reading the host `ssh` connects to for `alias`, as the user's SSH
 * configuration resolves it (`Host` / `HostName`), with `ssh -G`, which prints
 * the configuration without connecting. The push runs the same `ssh` with the
 * same configuration, so the host it names is the one the push reaches. The
 * user and the port the push uses are given too: a `Match user` block, or a
 * `Match exec` testing `%p`, may depend on them. `configFile` replaces the
 * user's configuration (`ssh -F`), for a test.
 */
export function sshHostResolver(configFile?: string): SshHostResolver {
  return async (alias, user, port) => {
    if (!SSH_ALIAS.test(alias) || (user !== undefined && !SSH_LOGIN.test(user))) return null;
    if (port != null && !(SSH_PORT.test(port) && Number(port) <= 65535)) return null;
    const args = [
      '-G',
      ...(configFile !== undefined ? ['-F', configFile] : []),
      ...(user !== undefined ? ['-l', user] : []),
      ...(port != null ? ['-p', port] : []),
      alias,
    ];
    try {
      const r = await getHost().execAsync('ssh', args, { timeout: 10_000, windowsHide: true });
      return r.code === 0 ? parseSshHostName(r.stdout) : null;
    } catch {
      return null;
    }
  };
}

/** The host the user's own SSH configuration sends `alias` to (`sshHostResolver`). */
export const sshHostName: SshHostResolver = sshHostResolver();

/** `merge-tree --write-tree` with its `-z` listing of conflicts. */
export const MIN_GIT_VERSION: readonly [number, number] = [2, 38];
/** Most bytes the scratch repository may hold once fetched. */
export const SCRATCH_SIZE_LIMIT = 512 * 1024 * 1024;
const NETWORK_TIMEOUT_MS = 5 * 60_000;
const LOCAL_TIMEOUT_MS = 60_000;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/;
const FILE_MODE = /^(?:100644|100755|120000|160000|040000)$/;

/** SSH settings the daemon may have been given: they choose a key, never a command a mission wrote. */
const KEPT_GIT_VARIABLES: ReadonlySet<string> = new Set(['GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_SSH_VARIANT']);

export type MergeTreeEntry = { mode: string; oid: string; stage: 1 | 2 | 3; path: string };
export type MergeTreeMessage = { paths: string[]; type: string; text: string };
export type MergeTreeResult = {
  /** The merged tree: files in conflict hold their conflict markers. */
  tree: string;
  clean: boolean;
  /** The index stages of every path in conflict. */
  entries: MergeTreeEntry[];
  /** What git says of each path: `Auto-merging`, `CONFLICT (contents)`… */
  messages: MergeTreeMessage[];
};

/**
 * What `git merge-tree --write-tree -z` printed: the tree, then one
 * `<mode> <oid> <stage>\t<path>` per stage of a conflicted path, an empty
 * field, then `<count>\0<path>…\0<type>\0<message>` per message. Null when it
 * is not that shape.
 */
export function parseMergeTree(stdout: string, clean: boolean): MergeTreeResult | null {
  const fields = stdout.split('\0');
  const tree = fields[0]?.trim() ?? '';
  if (!COMMIT_SHA.test(tree)) return null;
  if (clean) return { tree, clean: true, entries: [], messages: [] };
  const entries: MergeTreeEntry[] = [];
  let i = 1;
  for (; i < fields.length; i++) {
    const field = fields[i]!;
    if (field === '') { i++; break; }
    const m = /^(\d{6}) ([0-9a-f]{40,64}) ([123])\t(.+)$/s.exec(field);
    if (!m) return null;
    entries.push({ mode: m[1]!, oid: m[2]!, stage: Number(m[3]) as 1 | 2 | 3, path: m[4]! });
  }
  const messages: MergeTreeMessage[] = [];
  while (i < fields.length) {
    const head = fields[i]!;
    if (head === '' && i === fields.length - 1) break;
    const count = Number(head);
    if (!Number.isSafeInteger(count) || count < 0 || i + count + 2 >= fields.length) return null;
    const paths = fields.slice(i + 1, i + 1 + count);
    const type = fields[i + 1 + count]!;
    const text = fields[i + 2 + count]!.trim();
    messages.push({ paths, type, text });
    i += count + 3;
  }
  return { tree, clean: false, entries, messages };
}

/** `[major, minor]` of `git version 2.43.0` (`.windows.1` and the like ignored). */
export function parseGitVersion(text: string): [number, number] | null {
  const m = /git version (\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

export function gitVersionAtLeast(version: readonly [number, number], min: readonly [number, number] = MIN_GIT_VERSION): boolean {
  return version[0] > min[0] || (version[0] === min[0] && version[1] >= min[1]);
}

/** Total bytes `git count-objects -v` reports (loose objects and packs). */
export function parseObjectsSize(stdout: string): number | null {
  let kib = 0;
  let seen = false;
  for (const line of stdout.split('\n')) {
    const m = /^(size|size-pack|size-garbage): (\d+)$/.exec(line.trim());
    if (m) { kib += Number(m[2]); seen = true; }
  }
  return seen ? kib * 1024 : null;
}

export type Identity = { name: string; email: string };

export type ScratchFailure = { ok: false; reason: string; timedOut?: boolean };

export interface ScratchRepo {
  /** The folder holding the bare repository, its empty configuration and its index. */
  readonly dir: string;
  version(): Promise<[number, number] | null>;
  /** Fetches `refspecs` (no `+`: nothing local is ever forced either) from `url`. */
  fetch(url: string, refspecs: readonly string[]): Promise<{ ok: true } | ScratchFailure>;
  /** Bytes the repository holds, or null when git did not say. */
  size(): Promise<number | null>;
  commitOf(ref: string): Promise<string | null>;
  treeOf(commit: string): Promise<string | null>;
  mergeTree(ours: string, theirs: string): Promise<{ ok: true; result: MergeTreeResult } | ScratchFailure>;
  blobSize(oid: string): Promise<number | null>;
  /** The blob at `path` in `tree` and its mode, or null. */
  blobAt(tree: string, path: string): Promise<{ oid: string; mode: string } | null>;
  /** A blob as UTF-8 text; null when it is missing or longer than `maxBytes`. */
  readBlob(oid: string, maxBytes: number): Promise<string | null>;
  /** Stores `text` as a blob, unfiltered; its id, or null. */
  writeBlob(text: string): Promise<string | null>;
  /** `tree` with the given paths pointing at other blobs: a new tree id, or null. */
  replaceInTree(tree: string, entries: ReadonlyArray<{ path: string; mode: string; oid: string }>): Promise<string | null>;
  /** The paths whose entry differs between two trees, or null. */
  changedPaths(from: string, to: string): Promise<string[] | null>;
  /** The textual diff between two trees, cut at `maxBytes`. */
  diff(from: string, to: string, maxBytes: number): Promise<{ text: string; truncated: boolean } | null>;
  /** A commit of `tree` with `parents`, by `identity`, dated `time` (seconds):
   *  the same inputs give the same commit id, so a rebuild can be checked. */
  commitTree(tree: string, parents: readonly string[], message: string, identity: Identity, time: number): Promise<string | null>;
  /** The sha of `branch` at `url`, null when it has none. */
  remoteHead(url: string, branch: string): Promise<{ ok: true; sha: string | null } | ScratchFailure>;
  /** Pushes `sha` to `branch` at `url`: a fast-forward or a refusal. */
  push(url: string, sha: string, branch: string): Promise<GitNetworkOutcome>;
  dispose(): void;
}

export type ScratchOptions = {
  /** The folder scratch repositories are created in. */
  root: string;
  /** The project's `gh` folder: the credential helper of an https URL. */
  ghConfigDir: string | null;
  /** Stands in for git in tests. */
  git?: GitRunner;
};

/** The daemon's environment without the git variables that would point it elsewhere. */
export function scratchEnv(emptyConfig: string, ghConfigDir: string | null, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = ghEnv(ghConfigDir, base);
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('GIT_') && !KEPT_GIT_VARIABLES.has(upper)) delete env[key];
  }
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    // A contributor's path handed to `ls-tree -- <path>` is a name, never a
    // pathspec magic (`:(glob)*`).
    GIT_LITERAL_PATHSPECS: '1',
    // A `refs/replace/*` planted in a reopened scratch folder would make an
    // object read as another one in the preview.
    GIT_NO_REPLACE_OBJECTS: '1',
    // Messages and conflict types are read: never a translation of them.
    LC_ALL: 'C',
    LANGUAGE: 'C',
  };
}

/** `-c` pairs of every scratch call, on top of the host's own (`fixedGitConfig`). */
export function scratchConfig(emptyFile: string): string[] {
  return [
    'transfer.fsckObjects=true',
    'fetch.fsckObjects=true',
    'protocol.file.allow=never',
    'core.symlinks=false',
    'core.autocrlf=false',
    'core.safecrlf=false',
    `core.attributesFile=${emptyFile}`,
    'core.quotePath=false',
    // `git init` turns these on for a case-insensitive or decomposing file
    // system (macOS, Windows): the paths of a tree are bytes, never folded.
    'core.ignorecase=false',
    'core.precomposeunicode=false',
    'gc.auto=0',
    'maintenance.auto=false',
    'fetch.writeCommitGraph=false',
    'merge.conflictStyle=merge',
    'commit.gpgSign=false',
    // Reset, then the project's account through gh for an https remote.
    'credential.helper=',
    'credential.helper=!gh auth git-credential',
  ];
}

/** Opens a new scratch repository under `root`, or says why it could not. */
export async function openScratchRepo(options: ScratchOptions): Promise<ScratchRepo | ScratchFailure> {
  const git = options.git ?? hostGit;
  mkdirSync(options.root, { recursive: true });
  const dir = mkdtempSync(join(options.root, 'merge-'));
  const emptyConfig = join(dir, 'empty.gitconfig');
  writeFileSync(emptyConfig, '');
  mkdirSync(join(dir, 'incoming'));
  // Without `--git-dir`: the repository does not exist yet, and the host
  // reads the configuration of the one a call names before running it.
  // `--template=`: none of git's sample hooks, which nothing would run anyway.
  let init: ExecResult;
  try {
    init = await git([...scratchConfig(emptyConfig).flatMap((pair) => ['-c', pair]), 'init', '--quiet', '--bare', '--template=', join(dir, 'repo.git')], {
      cwd: dir, env: scratchEnv(emptyConfig, options.ghConfigDir), timeout: LOCAL_TIMEOUT_MS, windowsHide: true,
    });
  } catch (err) {
    init = { code: 1, stdout: '', stderr: (err as Error).message };
  }
  if (init.code !== 0) {
    rmSync(dir, { recursive: true, force: true });
    return { ok: false, reason: redactedOutput(init.stderr || init.stdout) || `git init failed (code ${init.code})` };
  }
  return scratchAt(dir, options);
}

/** The scratch repository `openScratchRepo` made in `dir` earlier, or null when it is gone. */
export function reopenScratchRepo(dir: string, options: ScratchOptions): ScratchRepo | null {
  if (!existsSync(join(dir, 'repo.git')) || !existsSync(join(dir, 'empty.gitconfig'))) return null;
  mkdirSync(join(dir, 'incoming'), { recursive: true });
  return scratchAt(dir, options);
}

function scratchAt(dir: string, options: ScratchOptions): ScratchRepo {
  const git = options.git ?? hostGit;
  const repo = join(dir, 'repo.git');
  const emptyConfig = join(dir, 'empty.gitconfig');
  const incoming = join(dir, 'incoming');
  const index = join(dir, 'index');
  const env = scratchEnv(emptyConfig, options.ghConfigDir);
  const prefix = [`--git-dir=${repo}`, ...scratchConfig(emptyConfig).flatMap((pair) => ['-c', pair])];

  const run = async (args: readonly string[], extra: Partial<ExecOpts> = {}, timeout = LOCAL_TIMEOUT_MS): Promise<ExecResult> => {
    try {
      return await git([...prefix, ...args], {
        cwd: dir, env: { ...env, ...(extra.env ?? {}) }, timeout, windowsHide: true, maxBuffer: extra.maxBuffer ?? 16 * 1024 * 1024,
      });
    } catch (err) {
      return { code: 1, stdout: '', stderr: (err as Error).message };
    }
  };
  const said = (r: ExecResult, what: string): ScratchFailure => ({
    ok: false, timedOut: r.timedOut === true, reason: redactedOutput(r.stderr || r.stdout) || `${what} failed (code ${r.code})`,
  });
  const sha = (r: ExecResult): string | null => {
    const out = r.stdout.trim();
    return r.code === 0 && COMMIT_SHA.test(out) ? out : null;
  };

  return {
    dir,
    async version() {
      const r = await run(['version']);
      return r.code === 0 ? parseGitVersion(r.stdout) : null;
    },
    async fetch(url, refspecs) {
      if (refspecs.some((r) => r.startsWith('+') || r.startsWith('-') || !r.includes(':'))) {
        return { ok: false, reason: 'refusing an unusual refspec' };
      }
      const r = await run(['fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--', url, ...refspecs], {}, NETWORK_TIMEOUT_MS);
      return r.code === 0 ? { ok: true } : said(r, 'the fetch');
    },
    async size() {
      const r = await run(['count-objects', '-v']);
      return r.code === 0 ? parseObjectsSize(r.stdout) : null;
    },
    async commitOf(ref) {
      return sha(await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]));
    },
    async treeOf(commit) {
      if (!COMMIT_SHA.test(commit)) return null;
      return sha(await run(['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]));
    },
    async mergeTree(ours, theirs) {
      if (!COMMIT_SHA.test(ours) || !COMMIT_SHA.test(theirs)) return { ok: false, reason: 'not two commits' };
      const r = await run(['merge-tree', '--write-tree', '-z', ours, theirs], { maxBuffer: 64 * 1024 * 1024 });
      // 0: merged cleanly, 1: merged with conflicts; anything else is a failure.
      if (r.code !== 0 && r.code !== 1) return said(r, 'git merge-tree');
      const result = parseMergeTree(r.stdout, r.code === 0);
      return result ? { ok: true, result } : { ok: false, reason: 'git merge-tree printed something unexpected' };
    },
    async blobSize(oid) {
      if (!COMMIT_SHA.test(oid)) return null;
      const r = await run(['cat-file', '-s', oid]);
      const n = Number(r.stdout.trim());
      return r.code === 0 && Number.isSafeInteger(n) ? n : null;
    },
    async blobAt(tree, path) {
      if (!COMMIT_SHA.test(tree) || path.length === 0) return null;
      const r = await run(['ls-tree', '-z', '--full-tree', tree, '--', path]);
      if (r.code !== 0) return null;
      for (const field of r.stdout.split('\0')) {
        const m = /^(\d{6}) blob ([0-9a-f]{40,64})\t(.+)$/s.exec(field);
        if (m && m[3] === path) return { oid: m[2]!, mode: m[1]! };
      }
      return null;
    },
    async readBlob(oid, maxBytes) {
      if (!COMMIT_SHA.test(oid)) return null;
      const r = await run(['cat-file', 'blob', oid], { maxBuffer: maxBytes + 1024 });
      return r.code === 0 && Buffer.byteLength(r.stdout, 'utf8') <= maxBytes ? r.stdout : null;
    },
    async writeBlob(text) {
      // A name of its own: each request reopens the folder, and two texts
      // written at once must never share a file.
      const file = join(incoming, randomUUID());
      writeFileSync(file, text, 'utf8');
      try {
        return sha(await run(['hash-object', '-w', '--no-filters', '--', file]));
      } finally {
        rmSync(file, { force: true });
      }
    },
    async replaceInTree(tree, entries) {
      if (!COMMIT_SHA.test(tree)) return null;
      if (entries.some((e) => !COMMIT_SHA.test(e.oid) || !FILE_MODE.test(e.mode) || e.path.includes(','))) return null;
      const opts = { env: { GIT_INDEX_FILE: index } };
      try {
        if ((await run(['read-tree', tree], opts)).code !== 0) return null;
        if (entries.length > 0) {
          const pairs = entries.flatMap((e) => ['--cacheinfo', `${e.mode},${e.oid},${e.path}`]);
          if ((await run(['update-index', '--add', ...pairs], opts)).code !== 0) return null;
        }
        return sha(await run(['write-tree'], opts));
      } finally {
        rmSync(index, { force: true });
      }
    },
    async changedPaths(from, to) {
      if (!COMMIT_SHA.test(from) || !COMMIT_SHA.test(to)) return null;
      const r = await run(['diff-tree', '-r', '-z', '--no-renames', '--name-only', from, to]);
      return r.code === 0 ? r.stdout.split('\0').filter((p) => p.length > 0) : null;
    },
    async diff(from, to, maxBytes) {
      if (!COMMIT_SHA.test(from) || !COMMIT_SHA.test(to)) return null;
      const r = await run(['diff', '--no-color', '--no-renames', from, to], { maxBuffer: maxBytes + 64 * 1024 });
      const overran = r.code !== 0 && /maxBuffer/i.test(r.stderr) && r.stdout.length > 0;
      if (r.code !== 0 && !overran) return null;
      const truncated = overran || r.stdout.length > maxBytes;
      return { text: truncated ? r.stdout.slice(0, maxBytes) : r.stdout, truncated };
    },
    async commitTree(tree, parents, message, identity, time) {
      if (!COMMIT_SHA.test(tree) || parents.some((p) => !COMMIT_SHA.test(p)) || !Number.isSafeInteger(time)) return null;
      const date = `@${time} +0000`;
      const r = await run(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', message], {
        env: {
          GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email, GIT_COMMITTER_DATE: date,
        },
      });
      return sha(r);
    },
    async remoteHead(url, branch) {
      if (!plainBranch(branch)) return { ok: false, reason: 'unusual branch name' };
      const r = await run(['ls-remote', '--heads', '--', url, `refs/heads/${branch}`], {}, NETWORK_TIMEOUT_MS);
      if (r.code !== 0) return said(r, 'reading the remote');
      // The exact ref: `ls-remote` also lists a branch `x/refs/heads/<branch>` of the fork.
      const line = r.stdout.split('\n').map((l) => l.trim().split('\t')).find((f) => f.length === 2 && f[1] === `refs/heads/${branch}`);
      const head = line?.[0] ?? null;
      if (head !== null && !COMMIT_SHA.test(head)) return { ok: false, reason: 'the remote answered something that is not a commit' };
      return { ok: true, sha: head };
    },
    async push(url, commit, branch) {
      let args: string[];
      try { args = pushCommitArguments(url, commit, branch); } catch (err) {
        return { ok: false, code: 'failed', reason: (err as Error).message };
      }
      const r = await run(['push', '--quiet', '--no-verify', ...args], {}, NETWORK_TIMEOUT_MS);
      if (r.code === 0) return { ok: true };
      if (r.timedOut) return { ok: false, code: 'timed_out', reason: 'the push timed out' };
      const rejected = /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(r.stderr);
      return { ok: false, code: rejected ? 'rejected' : 'failed', reason: redactedOutput(r.stderr || r.stdout) || `the push failed (code ${r.code})` };
    },
    dispose() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
