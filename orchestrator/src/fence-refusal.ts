/**
 * A refusal of the mission fence, said in words a person can act on.
 *
 * WHY. Before this module a path the fence refused surfaced as the CLI's own
 * `Operation not permitted (os error 1)` or `Permission denied`, three sterile
 * turns, then the circuit breaker sidelining the backend (TIM-0159). Nothing
 * named the fence, the path, or the setting. Two moments can do better:
 *
 * - at launch, before the CLI runs: every path under the Timon home that the
 *   launch names (arguments, environment, working directory) is checked
 *   against the policy the fence is about to apply (`fenceAccess`). A path the
 *   CLI is told to use and cannot reach refuses the launch at once, naming it;
 * - when a turn bounces: an absolute path in the CLI's error output is checked
 *   the same way, and only believed when the policy refuses it while the
 *   daemon itself, outside the fence, could do it. A `Permission denied` the
 *   OS would give anyway is not the fence's.
 *
 * The refusal is structured (`FenceRefusal`), not a sentence: the thread's
 * notice, the task's block reason and a later "allow this folder" card all read
 * the same object. It never offers to open the Timon home or a credential
 * folder (`grantable`): those stay closed whatever a person clicks.
 */
import { accessSync, constants, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fenceAccess, type FencePolicy } from './host/isolation.js';
import type { FenceMechanism } from './host/types.js';
import type { FenceGrantOffer } from './fence-grant.js';

export type FenceAccessKind = 'read' | 'write';

/** A path a launch hands its CLI, and what the CLI does with it. */
export type FenceNeed = { path: string; access: FenceAccessKind; why: string };

/** Where a person changes the fence: Settings › System › Security (`MISSION_ISOLATION_TARGET` of the app). */
export const FENCE_SETTING = Object.freeze({ category: 'system', tab: 'security' } as const);

/**
 * The contract of a refusal, persisted as the payload of a mission event
 * `fence_refused` and carried by `MissionFenceBlockedError`. Additive only:
 * readers (the thread's notice, the Kanban, an access card) ignore what they
 * do not know.
 */
export type FenceRefusal = {
  /** Absolute path the fence refused, as the launch or the CLI named it. */
  path: string;
  /** The same path with the user's home folded to `~`, for display. */
  display: string;
  access: FenceAccessKind;
  mechanism: FenceMechanism;
  /** `launch`: refused before the CLI ran. `run`: read from a turn that bounced. */
  stage: 'launch' | 'run';
  missionId: string;
  agent: string | null;
  backend: string;
  /** The path lies in the Timon home: a defect of Timon, which no exception opens. */
  timonHome: boolean;
  /** Whether an exception may open it: never in the Timon home nor a credential folder. */
  grantable: boolean;
  /** Why the fence dropped its own grant on this path (a folder not made before the launch), when it did. */
  dropped: string | null;
  setting: typeof FENCE_SETTING;
  /** Set when the thread records it (`withFenceGrantOffer`): what a person's answer names. */
  id?: string;
  /** The folder "Allow for this agent" would add, or null when no card may be offered (`fence-grant.ts`). */
  grant?: FenceGrantOffer | null;
};

/** `parent` is `child` or contains it. Pure path arithmetic. */
function contains(parent: string, child: string): boolean {
  if (parent === child) return true;
  const rel = relative(parent, child);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Where `path` leads, links followed; for a path not made yet, where its nearest existing parent leads. */
export function realPathOf(path: string, realpath: (p: string) => string = (p) => realpathSync.native(p)): string {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpath(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Environment variables that name a folder the CLI keeps its state in, hence writes. */
const WRITTEN_ENV = /(?:^|_)HOME$|^TMPDIR$/;

/**
 * Every path under the Timon home a launch hands its CLI: in its arguments
 * (whole or inside a value, a JSON configuration included), its environment,
 * its program and its working directory. A state folder named by the
 * environment (`CODEX_HOME`, `TMPDIR`) and a writable working directory are
 * written to; anything else is read. The Timon home itself is never a need:
 * it stays refused, only folders inside it are reopened.
 */
export function launchFenceNeeds(launch: {
  cmd?: string | null;
  args: readonly string[];
  env?: Readonly<Record<string, string | undefined>> | undefined;
  cwd?: string | null | undefined;
  workspace: 'rw' | 'ro';
}, timonHome: string): FenceNeed[] {
  const home = resolve(timonHome);
  const pattern = new RegExp(`${escapeRegExp(home)}(?:[\\\\/][^\\s"',;:=\`)\\]}]*)?`, 'g');
  const needs: FenceNeed[] = [];
  const add = (raw: string, access: FenceAccessKind, why: string): void => {
    const path = resolve(raw.replace(/[\\/]+$/, '') || raw);
    if (path === home || !contains(home, path)) return;
    const same = needs.find((need) => need.path === path);
    if (!same) needs.push({ path, access, why });
    else if (access === 'write' && same.access === 'read') Object.assign(same, { access, why });
  };
  const scan = (text: string, access: FenceAccessKind, why: string): void => {
    for (const match of text.matchAll(pattern)) add(match[0], access, why);
  };
  if (launch.cmd) scan(launch.cmd, 'read', 'the program of the CLI');
  launch.args.forEach((arg, i) => scan(arg, 'read', `argument ${i + 1} of the CLI`));
  for (const [key, value] of Object.entries(launch.env ?? {})) {
    if (typeof value !== 'string') continue;
    for (const part of value.split(delimiter)) scan(part, WRITTEN_ENV.test(key) ? 'write' : 'read', `the ${key} variable of the CLI`);
  }
  if (launch.cwd) scan(launch.cwd, launch.workspace === 'rw' ? 'write' : 'read', 'the working directory of the mission');
  return needs;
}

/** What the fence gives a path, read where its links lead: the kernel follows them, and grants are resolved too. */
function accessOf(policy: FencePolicy, path: string, realpath?: (p: string) => string): { read: boolean; write: boolean } {
  return fenceAccess(policy, realPathOf(path, realpath));
}

/**
 * The first need the policy refuses, with the reason the fence dropped its own
 * grant on it when it did, or null when every need is met.
 */
export function fencePreflight(
  policy: FencePolicy,
  needs: readonly FenceNeed[],
  realpath?: (p: string) => string,
): (FenceNeed & { dropped: string | null }) | null {
  if (!policy.enabled) return null;
  for (const need of needs) {
    const access = accessOf(policy, need.path, realpath);
    const met = need.access === 'read' ? access.read : access.write;
    if (met) continue;
    const dropped = policy.ignored.find((entry) => contains(resolve(entry.path), need.path))?.reason ?? null;
    return { ...need, dropped };
  }
  return null;
}

/** Words a CLI or its runtime prints on a refused file operation. */
const REFUSAL_WORDS = /operation not permitted|permission denied|\bEPERM\b|\bEACCES\b|os error (?:1|13)\b/i;
/** An absolute POSIX path in a line of output: the fence exists on Linux and macOS only. */
const POSIX_PATH = /(?:^|[\s'"`(=:,[{<])(\/[^\s'"`,;)\]}>]+)/g;

/** Whether the daemon, outside the fence, may do this: then a refusal is the fence's, not the OS's. */
function osAllows(path: string, access: FenceAccessKind): boolean {
  let current = path;
  for (;;) {
    try {
      accessSync(current, access === 'read' ? constants.R_OK : constants.W_OK);
      return true;
    } catch (err) {
      // A file not made yet: a write needs its folder, a read was never possible.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || access === 'read') return false;
      const parent = dirname(current);
      if (parent === current) return false;
      current = parent;
    }
  }
}

/**
 * The path a refused file operation names in `output`, when the fence is what
 * refused it: the policy denies the access, and the daemon outside the fence is
 * allowed it. A line with no path (`Operation not permitted (os error 1)` alone)
 * names nothing, and nothing is guessed from it.
 */
export function fenceRefusalInOutput(
  output: string,
  policy: FencePolicy,
  options: { osAllows?: (path: string, access: FenceAccessKind) => boolean; realpath?: (p: string) => string } = {},
): { path: string; access: FenceAccessKind } | null {
  if (!policy.enabled || !output) return null;
  const allowed = options.osAllows ?? osAllows;
  for (const line of output.split('\n')) {
    if (!REFUSAL_WORDS.test(line)) continue;
    for (const match of line.matchAll(POSIX_PATH)) {
      const path = (match[1] ?? '').replace(/[.:]+$/, '');
      if (!path || !isAbsolute(path)) continue;
      const access = accessOf(policy, path, options.realpath);
      if (!access.read && allowed(path, 'read')) return { path: resolve(path), access: 'read' };
      if (access.read && !access.write && allowed(path, 'write')) return { path: resolve(path), access: 'write' };
    }
  }
  return null;
}

/** Beyond this much of one tool's output, a refusal is not looked for: a huge listing is read in part. */
const TOOL_OUTPUT_SCAN_CHARS = 200_000;

/**
 * The text each tool result of a normalised `user` event carries (`content` as a
 * string, or as text blocks), cut to `TOOL_OUTPUT_SCAN_CHARS`. Every process
 * dialect reports its tool outputs this way (`stream-json-spans.ts`), codex's
 * command runs included.
 */
export function toolResultTexts(payload: unknown): string[] {
  const content = (payload as { message?: { content?: unknown } } | null)?.message?.content;
  if (!Array.isArray(content)) return [];
  const texts: string[] = [];
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue;
    const { type, content: inner } = block as { type?: unknown; content?: unknown };
    if (type !== 'tool_result') continue;
    const text = typeof inner === 'string'
      ? inner
      : Array.isArray(inner)
        ? inner.flatMap((part) => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string' ? [(part as { text: string }).text] : [])).join('\n')
        : '';
    if (text) texts.push(text.slice(0, TOOL_OUTPUT_SCAN_CHARS));
  }
  return texts;
}

/** A refusal with no path: `Operation not permitted (os error 1)` is how a Rust CLI (codex) words one. */
const PATHLESS_REFUSAL = /operation not permitted|\bEPERM\b|os error 1\b/i;
const ANY_POSIX_PATH = /(?:^|[\s'"`(=:,[{<])\/[^\s'"`,;)\]}>]/;

/**
 * The first line of `output` that says a file operation was not permitted
 * without naming any path, trimmed for display; null when there is none. Such a
 * line cannot be checked against the policy: it is a suspicion, never a refusal.
 */
export function pathlessRefusalIn(output: string): string | null {
  if (!output) return null;
  for (const line of output.split('\n')) {
    if (!PATHLESS_REFUSAL.test(line) || ANY_POSIX_PATH.test(line)) continue;
    const said = line.trim().replace(/\s+/g, ' ');
    return said.length > 200 ? `${said.slice(0, 199)}…` : said;
  }
  return null;
}

/**
 * A turn that bounced on a refusal naming no path, inside the fence: persisted as
 * the payload of a mission event `fence_suspected`. Nothing proves the fence
 * refused it, so nothing is offered to open; the notice names the fence and where
 * it is set, which is all a person needs to try.
 */
export type FenceSuspicion = {
  missionId: string;
  agent: string | null;
  backend: string;
  mechanism: FenceMechanism;
  stage: 'run';
  /** The CLI's own line, trimmed. */
  said: string;
  setting: typeof FENCE_SETTING;
};

/** The suspicion in one English paragraph, for the daemon's log. The thread renders its own, translated. */
export function fenceSuspicionMessage(suspicion: FenceSuspicion): string {
  return `The ${suspicion.backend} CLI stopped on "${suspicion.said}" without naming a path. `
    + `This mission runs in the mission fence (${fenceMechanismName(suspicion.mechanism)}), which may be what refused it: `
    + 'add the folder the agent needs to its extra folders, or see Mission isolation in Settings › System › Security.';
}

/** The structured refusal, from what the launch knows. */
export function fenceRefusal(input: {
  path: string;
  access: FenceAccessKind;
  stage: FenceRefusal['stage'];
  policy: FencePolicy;
  mechanism: FenceMechanism;
  missionId: string;
  agent: string | null;
  backend: string;
  timonHome: string;
  dropped?: string | null;
  home?: string;
}): FenceRefusal {
  const path = resolve(input.path);
  const real = realPathOf(path);
  const timonHomes = [resolve(input.timonHome), realPathOf(input.timonHome)];
  const inTimonHome = timonHomes.some((home) => contains(home, path) || contains(home, real));
  const credential = input.policy.deny.some((denied) => contains(denied, path) || contains(denied, real));
  const userHome = resolve(input.home ?? homedir());
  const display = contains(userHome, path) ? join('~', relative(userHome, path)) : path;
  return {
    path,
    display,
    access: input.access,
    mechanism: input.mechanism,
    stage: input.stage,
    missionId: input.missionId,
    agent: input.agent,
    backend: input.backend,
    timonHome: inTimonHome,
    grantable: !inTimonHome && !credential,
    dropped: input.dropped ?? null,
    setting: FENCE_SETTING,
  };
}

const MECHANISM_NAMES: Readonly<Record<string, string>> = Object.freeze({
  landlock: 'Landlock',
  seatbelt: 'the macOS sandbox (Seatbelt)',
});

/** The fence's name, as a person reads it. */
export function fenceMechanismName(mechanism: string): string {
  return MECHANISM_NAMES[mechanism] ?? mechanism;
}

/**
 * The refusal in one English paragraph, for the daemon's log, a launch error and
 * a task's block reason. The thread renders its own, translated, from the fields.
 */
export function fenceRefusalMessage(refusal: FenceRefusal): string {
  const verb = refusal.access === 'read' ? 'read' : 'write to';
  const when = refusal.stage === 'launch' ? 'Mission not started: the' : 'The';
  const head = `${when} mission fence (${fenceMechanismName(refusal.mechanism)}) does not let this mission ${verb} ${refusal.display}, which its ${refusal.backend} CLI needs`;
  const dropped = refusal.dropped ? ` (${refusal.dropped} when the fence was computed)` : '';
  if (refusal.timonHome) {
    return `${head}${dropped}. This path is inside the Timon home, which extra folders cannot open, so this is a defect of Timon: please report it. `
      + 'A lead or merge mission of a project already reaches its project\'s task worktrees and repository git directory, '
      + 'listed when the mission starts: start the mission again if the folder was made after it. '
      + 'Last resort only: Settings › System › Security, set Mission isolation to Off.';
  }
  if (!refusal.grantable) {
    return `${head}${dropped}. The fence always keeps this folder from missions (credentials, or a path `
      + 'listed in host.isolation.deny); see Settings › System › Security.';
  }
  return `${head}${dropped}. To allow it, add the folder to this agent's writable exceptions in `
    + 'Settings › System › Security; it applies from the next mission.';
}
