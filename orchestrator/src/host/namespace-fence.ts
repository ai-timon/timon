/**
 * The mission fence on a Linux kernel without Landlock: the fence policy
 * (`host/isolation.ts`, `resolveFence`) rendered as the steps timon-fence
 * takes in its namespace mode (`native/timon-fence/timon-fence.c`, NAMESPACE
 * MODE).
 *
 * WHY A SEQUENCE OF STEPS
 * -----------------------
 * Landlock grants, and refuses whatever it did not grant. A mount namespace
 * works the other way: the launcher starts from the whole file system made
 * read-only, and each step changes what one path shows, on top of what the
 * steps before it left:
 *   - `hide`: the path is covered by an empty read-only folder (a file by
 *     `/dev/null`): the Timon home, `~/.ssh`, the other backends' state;
 *   - `ro`: the real path is bound back, read-only, over whatever covers it:
 *     the mission's own folders inside the Timon home;
 *   - `rw`: the real path is bound back writable: the worktree, the mission's
 *     scratch folders, `/tmp`.
 * Steps are listed shallow first, so a deeper one always lands on top of its
 * parent, and the deepest listed ancestor decides — the semantics of
 * `fenceAccess`. A step that changes nothing (a read-only path under the
 * read-only root, a refusal inside a hidden folder) is left out.
 *
 * Every path is written in its resolved spelling, as for Landlock: the
 * kernel follows links when it mounts, so a step written on a link would land
 * where the link points, possibly over a step already taken there.
 *
 * What this mode does not reproduce, and why it does not matter here: a
 * refused folder still shows, empty, where Landlock leaves it unreadable; and
 * a write refused under Landlock with EACCES fails here with EROFS.
 */
import { posix } from 'node:path';
import { FENCE_POLICY_HEADER } from './fence.js';
import type { FencePolicy as IsolationFencePolicy } from './isolation.js';
import { canonicalPaths } from './seatbelt.js';

export type NamespaceStep = { readonly kind: 'hide' | 'ro' | 'rw'; readonly path: string };

export type NamespacePolicy = {
  readonly steps: readonly NamespaceStep[];
  readonly unixSockets: 'deny' | 'allow';
};

export class NamespaceRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NamespaceRenderError';
  }
}

type Level = 'none' | 'ro' | 'rw';
const RANK: Readonly<Record<Level, number>> = { none: 0, ro: 1, rw: 2 };
const STEP: Readonly<Record<Level, NamespaceStep['kind']>> = { none: 'hide', ro: 'ro', rw: 'rw' };

/** `parent` strictly contains `child`. Linux paths, hence `posix`. */
function strictlyWithin(parent: string, child: string): boolean {
  const rel = posix.relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith('../') && !posix.isAbsolute(rel);
}

/**
 * The steps of one fence policy. `realpath` resolves an existing path and
 * throws when it does not exist; a path that does not resolve is written as
 * given, and the launcher skips it at launch if it is still missing.
 */
export function renderNamespacePolicy(policy: IsolationFencePolicy, realpath: (path: string) => string): NamespacePolicy {
  if (!policy.enabled) throw new NamespaceRenderError('the fence is off: there is nothing to render');
  // On the very same path the most restrictive level wins (`fenceAccess`).
  const levels = new Map<string, Level>();
  const list = (paths: readonly string[], level: Level) => {
    for (const raw of paths) {
      if (!posix.isAbsolute(raw)) throw new NamespaceRenderError(`a fence path is not absolute: ${raw}`);
      if (raw.includes('\0')) throw new NamespaceRenderError('a fence path cannot contain a NUL character');
      const spellings = canonicalPaths(posix.resolve(raw), realpath);
      const path = spellings[spellings.length - 1] ?? raw;
      const known = levels.get(path);
      if (known === undefined || RANK[level] < RANK[known]) levels.set(path, level);
    }
  };
  list([...policy.deny, ...policy.denyUnderTimonHome], 'none');
  list(policy.ro, 'ro');
  list(policy.rw, 'rw');

  // The launcher starts from a read-only root: a refusal of the root itself
  // would hide the whole system, and opening it writable would undo the fence.
  const root = levels.get('/');
  if (root === 'none' || root === 'rw') throw new NamespaceRenderError(`the root cannot be ${root === 'none' ? 'refused' : 'writable'} in a namespace fence`);

  const ordered = [...levels.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const steps: NamespaceStep[] = [];
  for (const [path, level] of ordered) {
    if (path === '/') continue;
    // What the path shows before this step: the level of its deepest listed ancestor.
    let enclosing: Level = 'ro';
    let depth = -1;
    for (const [other, otherLevel] of ordered) {
      if (other.length > depth && (other === '/' || strictlyWithin(other, path))) {
        depth = other.length;
        enclosing = otherLevel;
      }
    }
    if (enclosing !== level) steps.push({ kind: STEP[level], path });
  }
  return { steps, unixSockets: policy.unixSockets };
}

/** The launcher's policy file for a namespace fence: same header and framing as a Landlock one. */
export function encodeNamespacePolicy(policy: NamespacePolicy): Buffer {
  const fields: string[] = [FENCE_POLICY_HEADER, 'mechanism', 'namespaces', 'unix-sockets', policy.unixSockets];
  for (const { kind, path } of policy.steps) {
    if (!posix.isAbsolute(path)) throw new Error(`Fence policy paths must be absolute: ${path}`);
    if (path.includes('\0')) throw new Error('Fence policy paths cannot contain a NUL character');
    fields.push(kind, path);
  }
  return Buffer.from(fields.map((field) => `${field}\0`).join(''), 'utf8');
}
