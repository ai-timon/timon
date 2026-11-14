/**
 * The mission fence on Linux: the fence policy (`host/isolation.ts`,
 * `resolveFence`) rendered as the rules timon-fence hands Landlock
 * (`host/fence.ts` for the launcher and its wire format).
 *
 * WHY THE RENDERING ENUMERATES
 * ----------------------------
 * Landlock only adds rights: a rule grants access beneath a folder, and no
 * rule can take part of it back. The fence policy, though, says "the deepest
 * listed ancestor decides": the system is readable, the Timon home inside it
 * is not, a worktree inside that is writable again. A grant that holds a
 * deeper, lower level (a "hole") is therefore never emitted as such: its
 * folder is listed and every entry is granted on its own, except the hole,
 * descending only along the path that leads to one. This is what the proof of
 * concept measured (`policy.py`): `/`, the parent of the home, the home and
 * the Timon home are the levels that get listed in practice.
 *
 * Three consequences, all deliberate:
 * - a folder that holds a hole is crossed but not granted itself: the mission
 *   can neither list it (`ls ~` fails when the Timon home sits in the home)
 *   nor create an entry directly in it, while every entry already there keeps
 *   its level. Landlock has no right on a folder that does not reach beneath
 *   it. A worktree, a scratch folder or a git directory holds no hole, so
 *   this only narrows the home, the system root and the write list;
 * - a symbolic link met while listing is never granted. Landlock follows it
 *   when the rule is added, so a link from the home to `~/.ssh` would reopen
 *   what the policy refuses. Access through a link is decided by where it
 *   points, which is covered (or not) on its own;
 * - every path is rendered in its resolved spelling, the only one the kernel
 *   matches: a refusal written on a link would refuse nothing.
 *
 * Executing is not a boundary under Landlock: the launcher grants it with
 * reading (`ro` = execute, read file, read folder), and a mission could copy a
 * file it reads into a folder it writes and run it from there anyway. The
 * policy's `exec` list matters to Seatbelt, not here.
 *
 * The rendering reads the filesystem (listing, resolving) but never writes;
 * both are injected so the tests can describe a tree without building it.
 */
import { chmodSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { FencePolicy as IsolationFencePolicy } from './isolation.js';
import {
  encodeFencePolicy, fenceStatus, runFenceWitness, WITNESS_PAYLOAD, type FencePolicy as LauncherPolicy, type FenceStatus,
} from './fence.js';
import { canonicalPaths } from './seatbelt.js';
import type { HostFence, HostFenceProbe, HostFenceWitness } from './types.js';

export class LandlockRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LandlockRenderError';
  }
}

export type DirEntryKind = 'dir' | 'link' | 'other';

export type LandlockRenderDeps = {
  /** Resolves an existing path; throws when it does not exist. */
  realpath: (path: string) => string;
  /** The entries of a folder, or null when it cannot be listed (missing, not a folder, refused). */
  list: (dir: string) => ReadonlyArray<{ name: string; kind: DirEntryKind }> | null;
  /**
   * Above this many rules the policy is refused rather than applied: a folder
   * with a hole and hundreds of thousands of entries is a configuration to
   * fix, not something to hand the kernel one rule at a time.
   */
  maxRules?: number;
};

/** The proof of concept applied 19 000 rules in 70 ms; a real mission needs a few hundred. */
export const LANDLOCK_MAX_RULES = 50_000;

type Level = 'none' | 'ro' | 'rw';
const RANK: Readonly<Record<Level, number>> = { none: 0, ro: 1, rw: 2 };

/** `parent` strictly contains `child`. Linux paths, hence `posix`. */
function strictlyWithin(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

function resolvedSpelling(path: string, realpath: (path: string) => string): string {
  const spellings = canonicalPaths(posix.resolve(path), realpath);
  return spellings[spellings.length - 1] ?? path;
}

/**
 * The launcher rules of one fence policy. Throws `LandlockRenderError` when
 * the policy cannot be rendered faithfully (a path the wire format cannot
 * carry, too many rules): the caller then treats the mission as unfenceable.
 */
export function renderLandlockPolicy(policy: IsolationFencePolicy, deps: LandlockRenderDeps): LauncherPolicy {
  if (!policy.enabled) throw new LandlockRenderError('the fence is off: there is nothing to render');
  const maxRules = deps.maxRules ?? LANDLOCK_MAX_RULES;

  // On the very same path the most restrictive level wins (`fenceAccess`).
  const levels = new Map<string, Level>();
  const list = (paths: readonly string[], level: Level) => {
    for (const raw of paths) {
      if (!posix.isAbsolute(raw)) throw new LandlockRenderError(`a fence path is not absolute: ${raw}`);
      const path = resolvedSpelling(raw, deps.realpath);
      const known = levels.get(path);
      if (known === undefined || RANK[level] < RANK[known]) levels.set(path, level);
    }
  };
  list([...policy.deny, ...policy.denyUnderTimonHome], 'none');
  list(policy.ro, 'ro');
  list(policy.rw, 'rw');

  const rules: Record<'ro' | 'rw', Set<string>> = { ro: new Set(), rw: new Set() };
  let count = 0;
  const push = (level: 'ro' | 'rw', path: string) => {
    if (rules[level].has(path)) return;
    rules[level].add(path);
    count += 1;
    if (count > maxRules) {
      throw new LandlockRenderError(`the fence needs more than ${maxRules} rules; a granted folder holding a refused one is too large to list`);
    }
  };

  const emit = (dir: string, level: 'ro' | 'rw', holes: readonly string[]) => {
    if (holes.length === 0) {
      push(level, dir);
      return;
    }
    // Missing or unreadable: it grants nothing, which is the safe side.
    const entries = deps.list(dir);
    if (!entries) return;
    for (const { name, kind } of entries) {
      const child = posix.join(dir, name);
      if (holes.includes(child)) continue;
      if (kind === 'link') continue;
      const deeper = holes.filter((hole) => strictlyWithin(child, hole));
      if (deeper.length === 0) push(level, child);
      else if (kind === 'dir') emit(child, level, deeper);
    }
  };

  const ordered = [...levels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [path, level] of ordered) {
    if (level === 'none') continue;
    const holes = ordered
      .filter(([other, otherLevel]) => RANK[otherLevel] < RANK[level] && strictlyWithin(path, other))
      .map(([other]) => other);
    emit(path, level, holes);
  }

  return { readOnly: [...rules.ro], readWrite: [...rules.rw], unixSockets: policy.unixSockets };
}

/** The real filesystem, as the rendering reads it. */
export const LANDLOCK_FS: LandlockRenderDeps = Object.freeze({
  realpath: (path: string) => realpathSync.native(path),
  list: (dir: string) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).map((entry) => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? 'link' as const : entry.isDirectory() ? 'dir' as const : 'other' as const,
      }));
    } catch {
      return null;
    }
  },
});

/** Owner-only, like every file the daemon keeps under its home; rewritten whole at each launch. */
function writePolicyFile(file: string, data: Buffer): void {
  mkdirSync(posix.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, data, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export type LandlockFenceDeps = {
  /** Whether the launcher can fence now; `fenceStatus()` by default, asked at every probe. */
  status?: () => FenceStatus;
  fs?: LandlockRenderDeps;
  writePolicy?: (file: string, data: Buffer) => void;
  /** Runs the witness; `runFenceWitness` by default. */
  runWitness?: (file: string, args: readonly string[]) => Promise<HostFenceWitness>;
};

/** A launcher status as the host contract reports it. */
export function landlockProbe(status: FenceStatus): HostFenceProbe {
  if (status.state === 'ready') return { available: true, abi: status.abi };
  return { available: false, reason: status.reason, abi: status.abi, ...(status.state === 'tampered' ? { tampered: true } : {}) };
}

/**
 * The Linux fence. Not cached: a launcher altered or removed after boot must
 * show at the next launch (`fenceStatus`), and its probe is one short exec.
 * `wrap` uses the launcher the last probe found, so a launch never runs a
 * binary that was not checked.
 */
export function createLandlockFence(deps: LandlockFenceDeps = {}): HostFence {
  const status = deps.status ?? (() => fenceStatus());
  const fs = deps.fs ?? LANDLOCK_FS;
  const writePolicy = deps.writePolicy ?? writePolicyFile;
  const runWitness = deps.runWitness ?? ((file: string, args: readonly string[]) => runFenceWitness(file, args));
  let launcher: string | null = null;
  return {
    mechanism: 'landlock',
    probe() {
      const current = status();
      launcher = current.state === 'ready' ? current.binary : null;
      return landlockProbe(current);
    },
    wrap(policy, cmd, args, policyFile) {
      if (!launcher) throw new LandlockRenderError('no checked fence launcher: probe the fence before wrapping a launch');
      if (!posix.isAbsolute(policyFile)) throw new LandlockRenderError(`the policy file must be an absolute path: ${policyFile}`);
      writePolicy(policyFile, encodeFencePolicy(renderLandlockPolicy(policy, fs)));
      return { cmd: launcher, args: ['--policy', policyFile, '--', cmd, ...args] };
    },
    witness(policyFile) {
      // The launcher the last probe checked, as for a launch: never one found anew.
      if (!launcher) return Promise.resolve({ ran: false, reason: 'no checked fence launcher', timedOut: false });
      return runWitness(launcher, ['--policy', policyFile, '--', WITNESS_PAYLOAD]);
    },
  };
}
