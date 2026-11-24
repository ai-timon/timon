/**
 * Resource guard — day/night profile, confinement of the missions, OOM alert.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * On 13/08/2026, an `ffmpeg` launched by a task reached 35.4 GB of RSS. The
 * `timon-orchestrator.service` had no limit, so the OOM was
 * GLOBAL: swap thrashing over the whole machine, unplayable mouse, reboot.
 *
 * A systemd drop-in (`~/.config/systemd/user/timon-orchestrator.service.d/
 * limits.conf`) was set right after: MemoryMax=32G / CPUQuota=1600%
 * (its original MemoryHigh=24G is to be removed, see the pitfall of 19/09
 * below). It protects the machine but it is STATIC and GLOBAL — it
 * tells neither a 30 s compilation from a one-hour video render, nor the day
 * from the night. This module adds the missing notch.
 *
 * HOW
 * ---
 * 1. Each mission is launched in a **transient systemd scope** placed in
 *    a dedicated slice `timon-<id>-missions.slice` (id = 8 hex of the sha256 of
 *    `TIMON_HOME`), with:
 *      - a memory ceiling PER MISSION (the OOM kills the faulty mission, not the
 *        machine nor the orchestrator);
 *      - a `nice` and an `ionice` inherited by ALL the descendants (ffmpeg, TTS,
 *        npm run build…), so the graphical session goes first.
 *    The slice carries the COLLECTIVE ceiling: four missions cannot
 *    add up their individual ceilings until overheating.
 *
 * 2. The slice receives hot (`systemctl --user set-property --runtime`, no
 *    restart, no mission killed) the values of the current profile: discreet during
 *    the day, relaxed at night.
 *
 * 3. The concurrency ceilings (living missions, dispatched tasks) are
 *    lowered during the day too.
 *
 * 4. A monitoring loop reads the cgroups' `memory.events` and alerts
 *    (urgent notification) when the slice hits MemoryMax or a process
 *    is killed, and reads `memory.pressure` to warn BEFORE systemd-oomd
 *    decides. A silent OOM is a task that fails without a readable reason.
 *
 * KNOWN PITFALL — MemoryHigh on the slice → PSI → systemd-oomd kills the session
 * (19/09/2026). The slice carried `MemoryHigh=8G` during the day. A mission at 8.1 GB
 * crossed it: beyond MemoryHigh the kernel kills nothing, it THROTTLES the
 * cgroup and forces memory reclaim, which manufactures pressure
 * (PSI `memory.pressure`, Avg10 ≈ 60%) without any real shortage (15 GB
 * used out of 62). PSI is hierarchical: it goes up to
 * `user@UID.service`. Ubuntu and its derivatives ship `user@.service.d/10-oomd-user-
 * service-defaults.conf` (`ManagedOOMMemoryPressure=kill`, 50% limit, 20 s);
 * systemd-oomd therefore picked a victim among ALL the cgroups of
 * `user@UID.service` — it took `init.scope`, the user manager itself,
 * and the whole graphical session went down (twice, 09:07 and 09:20).
 * Hence:
 *   - no finite MemoryHigh on the slice (nor on the scope, see `host/linux.ts`):
 *     only `MemoryMax` bounds, and beyond it is a kernel OOM CONFINED to the slice
 *     or the scope, not a throttling that spreads pressure;
 *   - `MemoryHigh=infinity` passed explicitly on each `set-property`: without
 *     it, the old runtime drop-in (`/run/…/user.control/`) would keep its
 *     finite value until the next reboot;
 *   - `ManagedOOMMemoryPressure=kill` on the slice: if pressure remains,
 *     oomd kills a MISSION (it picks among the descendants of the watched
 *     unit), at a threshold reached before the parent's.
 * That last point is not enough on its own: the watching of the parent
 * (`user@UID.service`) stays independent and can still pick outside the
 * slice. Protecting the session is a matter of installation — a system
 * drop-in `user@UID.service.d/…conf` with `ManagedOOMMemoryPressure=auto`,
 * which requires root and is therefore not set by Timon (see `orchestrator/README.md`).
 *
 * KNOWN PITFALL — the scope is NOT in the service's cgroup. A `systemctl
 * restart timon-orchestrator` therefore no longer kills the agent processes (they are
 * no longer in the SIGTERMed cgroup). Hence `stopMissionScopes()`, called at boot AND
 * on SIGTERM/SIGINT: without it orphaned `claude` processes would pile up.
 *
 * KNOWN PITFALL — the `io` controller is NOT delegated to the user systemd
 * manager on this machine (`cgroup.controllers` = `cpu memory pids`).
 * `IOWeight=` on a user unit is therefore silently inert: the
 * disk priority goes through `ionice` on the process, not through the cgroup.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, homedir, loadavg } from 'node:os';
import { basename, join } from 'node:path';
import { config } from './config/load.js';
import type { TimonConfig } from './config/schema.js';
import { apiError } from './api-error.js';
import { daemonMessage, type DaemonMessage } from './daemon-message.js';
import { CwdUnusableError } from './cwd-check.js';
import { getHost } from './host/index.js';
import { nodeRuntime } from './host/node-runtime.js';
import { daemonRuntimePaths } from './mission-fence-target.js';
import { FENCE_EXIT, fenceLaunchDecision, type FenceStatus } from './host/fence.js';
import {
  agentPackageCacheDir, fenceConfigWritesCredentialStore, fenceWritesCredentialStore, isFenceAgent, isFenceSegment, missionTmpDir, resolveFence,
  type FenceMode, type FenceTarget, type IsolationTarget,
} from './host/isolation.js';
import type { FenceMechanism, HostFence, HostFenceWitness } from './host/types.js';
import { argsUnderFence, type NestedSandboxDeclaration } from './backends/permission-models.js';
import { hasSystemd, systemctl, systemctlCallCount } from './host/systemd.js';
import {
  instancePrefix,
  isLegacyMissionScope,
  isOwnMissionScope,
  LEGACY_MISSION_SCOPE_PATTERN,
  missionScopePattern,
  missionSlice,
} from './host/units.js';
import { RETIRED_SETTINGS, resolve, retiredSettingsInUse, settingBool, settingNum } from './settings.js';
import {
  diffScopeKills,
  formatKillNotice,
  killNoticeMessage,
  missionPrefixOfScope,
  parseKernelOom,
  readScopeSnapshots,
  type OomKill,
  type ScopeSnapshot,
} from './resources-oom.js';
import type { ResourceHealth, CgroupStats, ProfileLimits, ResourceProfile } from './plugins/contract/system.js';
export type { ResourceHealth, CgroupStats, ProfileLimits, ResourceProfile } from './plugins/contract/system.js';

export { hasSystemd, systemctlCallCount };
export {
  grepaiWatcherUnit,
  instanceId,
  instancePrefix,
  isLegacyMissionScope,
  isOwnMissionScope,
  LEGACY_MISSION_SCOPE_PATTERN,
  missionScopePattern,
  missionSlice,
} from './host/units.js';

/** Slice that contains all the mission scopes of THIS instance.
 *  The dash creates a systemd hierarchy: `timon-<id>-missions.slice` is
 *  nested under `timon-<id>.slice`, not under another home's slice. */
export const MISSION_SLICE = missionSlice();
const SLICE_UNIT_PATH = join(homedir(), '.config', 'systemd', 'user', MISSION_SLICE);
const SERVICE_UNIT = 'timon-orchestrator.service';
const GB = 1024 ** 3;

/* ── Profil courant ──────────────────────────────────────────────────────── */

/** True if `hour` falls in the window [start, end). Handles wrapping around
 *  midnight (start=22, end=6) so that an exotic "day" window stays valid. */
function inWindow(hour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** An hour brought back within its setting's bounds. The registry only refuses
 *  on write: a value stored before the bounds existed (end=25, TIM-0124), or set
 *  through the env / `timon.config.json`, arrives here as is and would keep the
 *  profile on "day" forever. */
function boundedHour(key: string): number {
  const value = settingNum(key);
  const def = resolve(key)?.def;
  return Math.min(def?.max ?? value, Math.max(def?.min ?? value, value));
}

export function currentProfile(at: Date = new Date()): ResourceProfile {
  const start = boundedHour('TIMON_DAY_START_HOUR');
  const end = boundedHour('TIMON_DAY_END_HOUR');
  return inWindow(at.getHours(), start, end) ? 'day' : 'night';
}

/** Limits of the current profile. All from the settings registry: nothing
 *  hard-coded, everything editable from the Settings page without redeployment. */
export function profileLimits(at: Date = new Date()): ProfileLimits {
  const profile = currentProfile(at);
  const day = profile === 'day';
  const memMaxGb = settingNum(day ? 'TIMON_DAY_MEM_MAX_GB' : 'TIMON_NIGHT_MEM_MAX_GB');
  const missionMemConfiguredGb = settingNum('TIMON_MISSION_MEM_MAX_GB');
  const cap = missionMemCapMiB(missionMemConfiguredGb, memMaxGb);
  if (cap.clamped) warnClampOnce(profile, missionMemConfiguredGb, memMaxGb, cap.mib);
  return {
    profile,
    cpuQuotaPct: settingNum(day ? 'TIMON_DAY_CPU_QUOTA_PCT' : 'TIMON_NIGHT_CPU_QUOTA_PCT'),
    memMaxGb,
    missionMemMaxGb: cap.mib / 1024,
    missionMemMaxMiB: cap.mib,
    missionMemConfiguredGb,
    nice: settingNum(day ? 'TIMON_DAY_NICE' : 'TIMON_NIGHT_NICE'),
    ioniceClass: settingNum(day ? 'TIMON_DAY_IONICE_CLASS' : 'TIMON_NIGHT_IONICE_CLASS'),
    // The night keeps the historical ceilings; the day lowers them, without ever
    // raising them (a day cap higher than the night cap would be a dangerous
    // typo, it is neutralised here rather than believed).
    maxLive: day
      ? Math.max(1, Math.min(settingNum('TIMON_DAY_MAX_LIVE_MISSIONS'), settingNum('TIMON_MAX_LIVE_MISSIONS')))
      : settingNum('TIMON_MAX_LIVE_MISSIONS'),
    maxParallel: day
      ? Math.max(1, Math.min(settingNum('TIMON_DAY_MAX_PARALLEL'), settingNum('TIMON_MAX_PARALLEL')))
      : settingNum('TIMON_MAX_PARALLEL'),
  };
}

/** Effective memory ceiling of ONE mission, in MiB, under the MemoryMax of the
 *  slice that contains it.
 *
 *  Why: on 19/09/2026, a looping jsdom test climbed to 8.5 GB of RSS
 *  + 1.7 GB of swap for 16 min. The scope had MemoryMax=12G, the slice
 *  MemoryHigh=8G (day profile): the individual ceiling was NEVER reached,
 *  it is the slice's collective limit that fired in its place.
 *  The slice has had no MemoryHigh since (pitfall at the head of the module), but the
 *  rule holds for its remaining limit: a mission ceiling above the
 *  MemoryMax of its slice turns "this mission is killed" into "the whole slice
 *  hits the wall, and the kernel kills the biggest process of any
 *  mission". It must therefore stay below, with a margin that leaves the other
 *  missions room to breathe.
 *
 *  Margin: 10% of the slice ceiling, at least 1 GiB (or half for a
 *  tiny slice). Floor 256 MiB: a null ceiling would kill everything at spawn.
 *  `TIMON_MISSION_MEM_MAX_GB` stays a maximum: it is never raised. */
export function missionMemCapMiB(configuredGb: number, sliceMaxGb: number): { mib: number; clamped: boolean } {
  const configured = Math.max(256, Math.round(configuredGb * 1024));
  if (!(sliceMaxGb > 0)) return { mib: configured, clamped: false };
  const max = Math.round(sliceMaxGb * 1024);
  const margin = Math.max(Math.round(max * 0.1), Math.min(1024, Math.round(max / 2)));
  const ceiling = Math.max(256, max - margin);
  return configured > ceiling ? { mib: ceiling, clamped: true } : { mib: configured, clamped: false };
}

const warnedClamps = new Set<string>();

/** One warning per combination, not per call: `profileLimits()` is read
 *  at each spawn and at each tick. */
function warnClampOnce(profile: ResourceProfile, configuredGb: number, maxGb: number, mib: number): void {
  const key = `${profile}:${configuredGb}:${maxGb}`;
  if (warnedClamps.has(key)) return;
  warnedClamps.add(key);
  console.warn(
    `[resources] TIMON_MISSION_MEM_MAX_GB=${configuredGb} is not below the ${profile} slice MemoryMax `
    + `(${maxGb} GB): per-mission ceiling lowered to ${(mib / 1024).toFixed(1)} GB, otherwise a runaway `
    + 'mission fills the whole slice instead of being killed alone',
  );
}

/** Pressure (PSI) threshold beyond which systemd-oomd kills a mission of the
 *  slice. BELOW the 50% of the `user@UID.service` parent shipped by Ubuntu, not
 *  above: a parent's PSI is always at least that of its children,
 *  so when the pressure comes from the missions both curves go up
 *  together, and only a lower threshold guarantees that the slice crosses
 *  first — victim: a mission. Duration: oomd's default (20 s). */
export const SLICE_OOMD_PRESSURE_LIMIT = '40%';

/** Memory properties common to the persistent unit and to the runtime
 *  `set-property`. `MemoryHigh=infinity` is EXPLICIT: a `set-property` that omits it
 *  leaves in place the finite value of an earlier runtime drop-in. */
function sliceMemoryProps(memMaxGb: number): string[] {
  return [
    'MemoryHigh=infinity',
    `MemoryMax=${memMaxGb}G`,
    'ManagedOOMMemoryPressure=kill',
    `ManagedOOMMemoryPressureLimit=${SLICE_OOMD_PRESSURE_LIMIT}`,
  ];
}

export function guardEnabled(): boolean {
  return settingBool('TIMON_RESOURCE_GUARD_ENABLED');
}

/* ── The missions' slice ─────────────────────────────────────────────────── */

/** Reference content of the unit. The static values are those of the NIGHT
 *  profile (the most permissive): the current profile is then applied on top
 *  as a runtime drop-in, so a day profile never "leaks" into a persistent
 *  file one would forget to clean. */
function sliceUnitContent(): string {
  const night = profileLimits(new Date(2000, 0, 1, 3)); // 3 am → night profile
  return `# Generated by TIMON (orchestrator/src/resources.ts) — do not edit by hand.
#
# Slice holding EVERY mission scope. Each mission runs in its own scope, itself
# placed here: the ceiling below is therefore COLLECTIVE (N missions cannot
# add up their individual ceilings).
#
# These are the NIGHT profile values. The current profile (day/night) is
# applied live on top, as a runtime drop-in (/run), by applyProfile().
[Unit]
Description=TIMON missions (agents and their heavy processes)

[Slice]
# No finite MemoryHigh, on purpose: throttling builds pressure (PSI), which
# propagates to user@UID.service, and systemd-oomd killed the whole graphical
# session there on 19/09/2026. Above MemoryMax, the kernel OOM stays confined
# here. If pressure remains, oomd kills a mission, not the session.
${sliceMemoryProps(night.memMaxGb).join('\n')}
# Swap is what makes the machine unusable long before the OOM: it is capped.
MemorySwapMax=2G
CPUQuota=${night.cpuQuotaPct}%
# Low weight: under contention, the graphical session goes first.
CPUWeight=20
`;
}

/** Materialises the slice unit if missing or obsolete. Idempotent: only calls
 *  `daemon-reload` if the file really changed. */
export function ensureMissionSlice(): void {
  if (!hasSystemd()) return;
  const wanted = sliceUnitContent();
  const current = existsSync(SLICE_UNIT_PATH) ? readFileSync(SLICE_UNIT_PATH, 'utf8') : null;
  if (current === wanted) return;
  mkdirSync(join(homedir(), '.config', 'systemd', 'user'), { recursive: true });
  writeFileSync(SLICE_UNIT_PATH, wanted);
  const r = systemctl(['daemon-reload']);
  if (!r.ok) console.warn(`[resources] daemon-reload failed: ${r.out}`);
  else console.log(`[resources] ${MISSION_SLICE} materialised`);
}

let appliedProfile: ResourceProfile | null = null;
/** Per-mission ceiling pushed the last time to the living scopes (MiB). */
let appliedMissionCapMiB: number | null = null;
/** Full property list last pushed to the slice. Compared as a whole, so any
 *  property that changes (CPU quota included) triggers a re-application —
 *  comparing field by field let a CPU quota change wait for the next
 *  day/night switch. It holds the WANTED list, not the ManagedOOM-less
 *  fallback, so an old systemd is not retried on every tick. */
let appliedSliceProps: string | null = null;

/** Living scopes of THIS instance only: the legacy ones adopted read-only
 *  (`listMissionScopes`) are never modified from here. */
function ownLiveScopes(): string[] {
  return parseScopeUnits(
    systemctl(['list-units', '--plain', '--no-legend', '--no-pager', missionScopePattern()]).out,
  ).filter((u) => isOwnMissionScope(u));
}

/** Pushes the memory ceiling again to the scopes ALREADY launched.
 *
 *  A scope's MemoryMax is frozen at its spawn. A mission launched at night
 *  keeps its ceiling when switching to day, where the slice may fall below it:
 *  the inversion that froze every mission on 19/09/2026. `set-property --runtime` rewrites the limit hot.
 *  A scope already above the new ceiling is killed by the kernel's OOM —
 *  intended: it alone pays, no longer the whole slice.
 *  Returns the number of scopes updated. */
export function reapplyMissionCap(mib: number): number {
  let n = 0;
  for (const unit of ownLiveScopes()) {
    const r = systemctl(['set-property', '--runtime', unit, `MemoryMax=${mib}M`]);
    if (r.ok) n += 1;
    else console.warn(`[resources] could not lower MemoryMax on ${unit}: ${r.out}`);
  }
  if (n > 0) console.log(`[resources] per-mission ceiling ${(mib / 1024).toFixed(1)} GB re-applied to ${n} live scope(s)`);
  return n;
}

/** Applies the current profile to the slice, HOT. `set-property --runtime`
 *  writes a drop-in in /run and notifies the manager: no restart, no
 *  mission killed — which is crucial, a restart of the orchestrator would take away
 *  its missions in flight.
 *
 *  The per-mission ceiling follows: if it changed (profile switch or setting
 *  modified), it is pushed again to the living scopes. When it goes down, the scopes
 *  go BEFORE the slice, so that no instant has a mission ceiling
 *  above the collective MemoryMax.
 *
 *  Returns the applied profile, or null if nothing to do / systemd unavailable. */
export function applyProfile(force = false): ResourceProfile | null {
  if (!hasSystemd() || !guardEnabled()) return null;
  const lim = profileLimits();
  const base = ['set-property', '--runtime', MISSION_SLICE, `CPUQuota=${lim.cpuQuotaPct}%`, 'CPUWeight=20'];
  const sliceProps = [...base, ...sliceMemoryProps(lim.memMaxGb)];
  const sliceKey = sliceProps.join(' ');
  const profileChanged = force || appliedProfile !== lim.profile || appliedSliceProps !== sliceKey;
  const capChanged = appliedMissionCapMiB !== lim.missionMemMaxMiB;
  if (!profileChanged && !capChanged) return null;
  const pushCap = () => {
    reapplyMissionCap(lim.missionMemMaxMiB);
    appliedMissionCapMiB = lim.missionMemMaxMiB;
  };
  if (capChanged && appliedMissionCapMiB !== null && lim.missionMemMaxMiB < appliedMissionCapMiB) pushCap();
  if (profileChanged) {
    ensureMissionSlice();
    let r = systemctl(sliceProps);
    if (!r.ok) {
      // `set-property` is all-or-nothing: a systemd too old for the
      // ManagedOOM* properties would otherwise leave the CPU and memory
      // ceilings unapplied too. The ceilings matter more than oomd scoping.
      const oomdLess = sliceMemoryProps(lim.memMaxGb).filter((p) => !p.startsWith('ManagedOOM'));
      const retry = systemctl([...base, ...oomdLess]);
      if (retry.ok) console.warn(`[resources] ManagedOOM* rejected on ${MISSION_SLICE}, applied without it: ${r.out}`);
      r = retry;
    }
    if (!r.ok) {
      console.warn(`[resources] applying profile ${lim.profile} failed: ${r.out}`);
      return null;
    }
    appliedProfile = lim.profile;
    appliedSliceProps = sliceKey;
  }
  if (appliedMissionCapMiB !== lim.missionMemMaxMiB) pushCap();
  if (!profileChanged) return null;
  console.log(
    `[resources] profile ${lim.profile} applied — CPU ${lim.cpuQuotaPct}% (${(lim.cpuQuotaPct / 100).toFixed(0)} cores), `
    + `memory max ${lim.memMaxGb} GB, per mission ${lim.missionMemMaxGb.toFixed(1)} GB, `
    + `nice ${lim.nice}, missions ≤ ${lim.maxLive}`,
  );
  return lim.profile;
}

/** Test-only: forgets the applied state, to replay a switch. */
export function resetAppliedProfileForTest(): void {
  appliedProfile = null;
  appliedMissionCapMiB = null;
  appliedSliceProps = null;
}

/** null = not probed yet, false = the wrapper does not work here (fall
 *  back on a bare spawn). See `probeWrapper()`. */
let wrapUsable: boolean | null = null;

let scopeSeq = 0;

/** Name of the scope carrying ONE TURN of a mission. A long mission chains
 *  several backend processes (one per turn): reusing the same unit name
 *  would make `systemd-run` fail ("unit already exists") as soon as two turns
 *  overlap, so a counter is appended. The uuid truncated to 8 characters
 *  keeps the unit readable in `systemctl --user status` and traceable to its
 *  mission. */
export function missionScopeUnit(missionId: string, home?: string): string {
  scopeSeq = (scopeSeq + 1) % 1_000_000;
  return `${instancePrefix(home)}-mission-${missionId.slice(0, 8)}-${scopeSeq.toString(36)}`;
}

/* ── The mission fence (GHSA-f58g) ───────────────────────────────────────── */

/**
 * What a launch learnt about the fence. `null` on a launch that carries no
 * mission target (the wrapper's own probe): there is nothing to fence.
 */
export type MissionFenceOutcome =
  | {
    readonly state: 'fenced';
    readonly mechanism: FenceMechanism;
    readonly policyFile: string;
    /** The mission's own temporary folder, to hand the CLI as `TMPDIR`; null when it could not be made. */
    readonly tmpDir: string | null;
    /** `ro` when the fence applies a read-only level in place of the CLI's own sandbox. */
    readonly workspace: 'rw' | 'ro';
    /** The agent's package cache (`agentPackageCacheDir`), for the package managers; null without one. */
    readonly packageCacheDir: string | null;
    /** A `writable` grant reaches the macOS login keychain (`fenceWritesCredentialStore`): the CLI can renew its sign-in there. */
    readonly credentialStoreWritable: boolean;
  }
  /** `warning` is null only when the configuration turned the fence off. */
  | { readonly state: 'unfenced'; readonly warning: string | null; readonly tampered: boolean };

export type MissionLaunch = { cmd: string; args: string[]; fence: MissionFenceOutcome | null };

/** `host.isolation.filesystem` is `enforce` and this mission cannot be fenced. */
export class MissionFenceRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MissionFenceRefusedError';
  }
}

/**
 * The body a route answers for a launch that failed. A fence refusal keeps a
 * code the interface translates, so the person reads why Timon refused, in
 * their language, rather than a launch error like any other; anything else
 * keeps its message, as before.
 */
/**
 * 503 for a fence refusal: this machine cannot serve the launch until its
 * kernel or its setting changes. Never 409, which the chat reads as "the
 * agent is still talking" and answers by queueing the message.
 */
export function launchErrorStatus(err: unknown, otherwise: number): number {
  if (err instanceof MissionFenceRefusedError) return 503;
  // The agent's folder is gone or closed: the request is fine, the setup is not (TIM-0148).
  if (err instanceof CwdUnusableError) return 409;
  return otherwise;
}

export function missionLaunchErrorBody(err: unknown): { error: string; code?: string } {
  if (err instanceof MissionFenceRefusedError) return { ...apiError('mission_fence_refused', err.message) };
  if (err instanceof CwdUnusableError) return { ...apiError('cwd_unusable', err.message, { path: err.path }) };
  return { error: err instanceof Error ? err.message : String(err) };
}

/**
 * Set when the launcher, run again as a witness after a launch that looked
 * like it failed, could not apply the fence either (no fence on this kernel
 * after all, a step the kernel refused, a profile this OS rejects). Never set
 * from what a mission's process printed alone (`watchFencedLaunch`). Until
 * the daemon restarts, missions are not handed to a launcher that cannot
 * apply the fence, and the cause is reported instead of every turn failing
 * the same way.
 */
let fenceBrokenAtLaunch: string | null = null;

export function noteFenceLaunchFailure(reason: string): void {
  if (fenceBrokenAtLaunch === null) console.error(`[resources] mission fence disabled until the daemon restarts: ${reason}`);
  fenceBrokenAtLaunch = reason;
}

/** Test-only. */
export function resetFenceLaunchFailureForTest(): void {
  fenceBrokenAtLaunch = null;
}

/** The host's fence as the launch decision reads it (`host/fence.ts`). */
export function hostFenceStatus(fence: HostFence | undefined): FenceStatus {
  if (!fence) return { state: 'unsupported', reason: 'no mission fence on this OS', abi: 0 };
  const probe = fence.probe();
  if (fenceBrokenAtLaunch) {
    // The namespace fence was this kernel's last mechanism: without Landlock,
    // a launcher that cannot apply it leaves nothing to fall back on.
    return { state: 'unsupported', reason: fenceBrokenAtLaunch, abi: 0, ...(probe.fallback === 'namespaces' ? { noMechanism: true } : {}) };
  }
  const abi = probe.abi ?? 0;
  if (probe.available) {
    return { state: 'ready', binary: fence.mechanism, abi, seccomp: true, ...(probe.fallback ? { fallback: probe.fallback } : {}) };
  }
  const reason = probe.reason ?? `the ${fence.mechanism} fence is unavailable`;
  if (probe.tampered) return { state: 'tampered', reason, abi };
  return { state: 'unsupported', reason, abi, ...(probe.noMechanism ? { noMechanism: true } : {}) };
}

/** Where the launcher reads the policy: under `run/`, which no mission ever reaches (`MISSION_TIMON_ZONES.refused`). */
export function fencePolicyFile(timonHome: string, unit: string): string {
  return join(timonHome, 'run', 'fence', `${unit}.policy`);
}

/**
 * The launcher reads its policy once, before it executes the CLI: a policy
 * left by an earlier daemon is never read again. Swept once per Timon home and
 * daemon life, before this life writes its first one.
 */
const sweptFencePolicies = new Set<string>();

function sweepFencePolicies(timonHome: string): void {
  if (sweptFencePolicies.has(timonHome)) return;
  sweptFencePolicies.add(timonHome);
  try {
    rmSync(join(timonHome, 'run', 'fence'), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[resources] stale fence policies left in place: ${(err as Error).message}`);
  }
}

/** Removes the policy of a launch whose process is over. */
export function releaseFencePolicy(outcome: MissionFenceOutcome | null): void {
  if (outcome?.state !== 'fenced') return;
  try {
    rmSync(outcome.policyFile, { force: true });
  } catch { /* swept at the next daemon start */ }
}

/** Last fence state told to the log: a working fence is said once, not at every turn. */
let reportedFence: string | null = null;

/** Causes of an unfenced launch already told to the log in this daemon life. */
const warnedUnfenced = new Set<string>();
/** Agents already named in the log as running in the whole `workspace` folder: once per agent. */
const notedSharedWorkspace = new Set<string>();

function reportFenceReady(mechanism: FenceMechanism, abi: number, fallback: 'namespaces' | undefined): void {
  const key = `${mechanism}:${abi}:${fallback ?? ''}`;
  if (reportedFence === key) return;
  reportedFence = key;
  console.log(fallback
    ? '[resources] missions run inside the namespace fence (no Landlock on this kernel)'
    : `[resources] missions run inside the ${mechanism} fence${abi ? ` (ABI ${abi})` : ''}`);
}

/**
 * The folders the fence grants a mission from its identity, made before the
 * policy is resolved: a grant on a folder that does not exist is dropped, and
 * the CLI would then find neither its temporary folder nor its agent's memory.
 * Created owner-only, like the rest of the Timon home.
 */
function prepareFencedFolders(target: FenceTarget): { tmpDir: string | null; packageCacheDir: string | null } {
  const make = (dir: string): boolean => {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      return true;
    } catch (err) {
      console.warn(`[resources] cannot create ${dir} for a fenced mission: ${(err as Error).message}`);
      return false;
    }
  };
  let tmpDir: string | null = null;
  if (target.missionId && isFenceSegment(target.missionId)) {
    const dir = missionTmpDir(target.timonHome, target.missionId);
    if (make(dir)) tmpDir = dir;
  }
  // Only for an agent folder that exists: a name alone never creates an agent.
  let packageCacheDir: string | null = null;
  if (target.agent && isFenceAgent(target.agent)) {
    const agentDir = join(target.timonHome, 'agents', target.agent);
    if (existsSync(agentDir)) {
      make(join(agentDir, 'memory'));
      const cache = agentPackageCacheDir(target.timonHome, target.agent);
      if (make(cache)) packageCacheDir = cache;
    }
  }
  return { tmpDir, packageCacheDir };
}

/**
 * A missing folder grants nothing, which is the safe side and the common
 * case (a provider without a scratch folder, an agent without per-mission
 * memory): not worth a line at every turn. The other reasons are.
 */
const UNRESOLVED_GRANT = 'the path does not resolve to an existing file or folder';

export type FenceMissionOptions = {
  mode?: FenceMode;
  fence?: HostFence | undefined;
  /**
   * How the CLI's own sandbox turns off (`PermissionStrategy.nestedSandbox`):
   * applied to a fenced launch only. An unfenced one keeps the arguments the
   * provider built, its own sandbox included.
   */
  nestedSandbox?: NestedSandboxDeclaration | undefined;
  /** Where the decision and the dropped grants are reported. */
  warn?: (line: string) => void;
};

/**
 * Whether the next launch of a mission of `target` will run inside a fence that
 * keeps the OS credential store read-only, asked before the provider builds its
 * command: `fenceMissionCommand` then decides for real, on the same configuration
 * and the same probe. Read by the move of an account's keychain entry
 * (`mission-fence-state.ts`), which only such a launch needs: outside the fence,
 * or with a `writable` exception reaching the keychain, the CLI updates the entry
 * itself. A wrong guess costs a needless move or none, never a lost sign-in:
 * that launch's CLI is not running yet, and once it runs, it is recorded as what it is.
 */
export function missionFenceExpected(
  target: { agent?: string; project?: string } = {},
  on: { cfg?: TimonConfig; fence?: HostFence | undefined; platform?: NodeJS.Platform; home?: string } = {},
): boolean {
  const cfg = on.cfg ?? config();
  const fence = 'fence' in on ? on.fence : getHost().fence;
  if (cfg.host.isolation.filesystem === 'off' || hostFenceStatus(fence).state !== 'ready') return false;
  return !fenceConfigWritesCredentialStore(cfg, target, on.platform ?? getHost().platform, on.home ?? homedir());
}

/**
 * The fence layer of a mission launch: the command wrapped by the host's
 * fence, or left as is with a warning, or refused. Never silent: outside
 * `off`, a mission that runs unfenced says why, and an altered package is
 * worded apart from a machine that lacks the mechanism.
 */
export function fenceMissionCommand(
  cmd: string,
  args: string[],
  unit: string,
  target: FenceTarget,
  options: FenceMissionOptions = {},
): MissionLaunch {
  const cfg = config();
  const mode = options.mode ?? cfg.host.isolation.filesystem;
  const warn = options.warn ?? ((line: string) => console.warn(line));
  const label = `[resources] mission ${target.missionId?.slice(0, 8) ?? unit}:`;
  const fence = 'fence' in options ? options.fence : getHost().fence;

  const unfenced = (status: FenceStatus): MissionLaunch => {
    const decision = fenceLaunchDecision(mode, status);
    if (decision.action === 'refuse') throw new MissionFenceRefusedError(decision.error);
    if (decision.action === 'fence') throw new Error('a fence that cannot be applied was reported ready');
    // Once per cause in the log (a machine without the mechanism would say it
    // at every turn of every mission); an altered package, at every launch.
    if (decision.warning && (options.warn || decision.tampered || !warnedUnfenced.has(decision.warning))) {
      warnedUnfenced.add(decision.warning);
      warn(`${label} ${decision.warning}`);
    }
    return { cmd, args, fence: { state: 'unfenced', warning: decision.warning, tampered: decision.tampered } };
  };

  if (mode === 'off') return unfenced({ state: 'unsupported', reason: 'off', abi: 0 });
  const status = hostFenceStatus(fence);
  if (status.state !== 'ready' || !fence) {
    reportedFence = null;
    return unfenced(status);
  }

  sweepFencePolicies(target.timonHome);
  const { tmpDir, packageCacheDir } = prepareFencedFolders(target);
  // The CLI's own sandbox cannot run inside the fence: it is turned off, and
  // the fence takes over the level it would have applied. Only here, once the
  // fence is known to apply: an unfenced launch keeps the CLI's sandbox.
  const nested = argsUnderFence(args, options.nestedSandbox);
  if (nested.levelMissing) {
    warn(`${label} the CLI's sandbox level option (${options.nestedSandbox?.level?.flag ?? ''}) is not in its launch: its own sandbox may fail inside the fence`);
  }
  const workspace = nested.readOnly || target.workspace === 'ro' ? 'ro' : 'rw';
  // The daemon's own release is what the mission's Timon MCP servers run from.
  const runtime = target.runtime ?? daemonRuntimePaths(nodeRuntime(cfg));
  const policy = resolveFence(
    { ...cfg, host: { ...cfg.host, isolation: { ...cfg.host.isolation, filesystem: mode } } },
    { ...target, workspace, runtime },
  );
  for (const { path, reason } of policy.ignored) {
    if (reason !== UNRESOLVED_GRANT) warn(`${label} fence grant on ${path} dropped: ${reason}`);
  }
  const sharedKey = target.agent ?? '';
  if (policy.sharedWorkspace && !notedSharedWorkspace.has(sharedKey)) {
    notedSharedWorkspace.add(sharedKey);
    warn(`${label} agent "${target.agent ?? '?'}" works in ${policy.sharedWorkspace} itself, which the fence grants whole for compatibility: `
      + 'its missions also reach the other folders in it. Give the agent a project folder (a folder inside it) for a stricter fence.');
  }
  const policyFile = fencePolicyFile(target.timonHome, unit);
  const credentialStoreWritable = fenceWritesCredentialStore(policy, target.platform ?? process.platform, target.home ?? homedir());
  try {
    const wrapped = fence.wrap(policy, cmd, nested.args, policyFile);
    reportFenceReady(fence.mechanism, status.abi, status.state === 'ready' ? status.fallback : undefined);
    return { ...wrapped, fence: { state: 'fenced', mechanism: fence.mechanism, policyFile, tmpDir, workspace, packageCacheDir, credentialStoreWritable } };
  } catch (err) {
    return unfenced({ state: 'unsupported', reason: `the fence policy cannot be applied (${(err as Error).message})`, abi: status.abi });
  }
}

/**
 * Whether a fenced launch's end LOOKS like the launcher gave up because this
 * machine cannot apply the fence: the launcher's words on stderr, with a code
 * it uses for "cannot fence here". Never proof on its own: the CLI writes on
 * the same stderr and picks its own exit code, so a mission can print these
 * words. It only decides whether the launcher is asked again
 * (`confirmFenceLaunchFailure`).
 */
export function fenceLaunchFailure(mechanism: FenceMechanism, code: number | null, stderr: string): string | null {
  const prefix = mechanism === 'landlock' ? 'timon-fence: ' : 'sandbox-exec: ';
  const line = stderr.split('\n').find((l) => l.startsWith(prefix));
  if (!line) return null;
  if (mechanism === 'landlock' && code !== FENCE_EXIT.unavailable && code !== FENCE_EXIT.osError) return null;
  if (mechanism === 'seatbelt' && (code === 0 || code === null)) return null;
  return line.trim();
}

/** The launcher's own line, kept short: it ends up in the log and in refusals. */
function launcherLine(stderr: string, prefix: string): string | null {
  const line = stderr.split('\n').find((l) => l.startsWith(prefix))?.trim();
  return line ? line.slice(0, 300) : null;
}

/**
 * The spawn errors that say the launcher itself cannot run: missing, not
 * executable, not a binary this machine runs, or refused by the OS. Any other
 * (EAGAIN, EMFILE, ENFILE, ENOMEM…) is the machine short of resources for a
 * moment, which says nothing about the fence and must not turn it off.
 */
const LAUNCHER_SPAWN_FAILURES: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ENOEXEC', 'EPERM']);

/**
 * What a witness run of the launcher (`HostFence.witness`) proves: the reason
 * the fence cannot be applied on this machine, or null when it proves nothing
 * of the kind — the launcher applied it, or gave no conclusive answer (no
 * answer in time, a spawn error that is not the launcher's, an end by a
 * signal). The payload prints nothing and exits 0, so a failure here is the
 * launcher's. Under Landlock, 127 means every fence step succeeded and only
 * the payload could not run; 78 and 64 are the daemon's bugs, not the
 * machine's (as for a launch). Under Seatbelt, only a numeric non-zero exit
 * is a failure: `sandbox-exec` reports a refused profile that way, while a
 * signal comes from outside it (the OS, an out-of-memory kill).
 */
export function fenceWitnessFailure(mechanism: FenceMechanism, witness: HostFenceWitness): string | null {
  if (!witness.ran) {
    if (witness.timedOut || witness.code === undefined || !LAUNCHER_SPAWN_FAILURES.has(witness.code)) return null;
    return `the fence launcher cannot run (${witness.reason})`;
  }
  if (mechanism === 'landlock') {
    if (witness.status !== FENCE_EXIT.unavailable && witness.status !== FENCE_EXIT.osError) return null;
    return launcherLine(witness.stderr, 'timon-fence: ') ?? `timon-fence exited with ${witness.status}`;
  }
  if (witness.status === 0 || witness.status === null) return null;
  return launcherLine(witness.stderr, 'sandbox-exec: ') ?? `sandbox-exec exited with ${witness.status}`;
}

/**
 * Asks the launcher itself whether the fence still applies, after a launch
 * that looked like it did not. Only the launcher's answer can turn the fence
 * off for the next launches; what the mission printed never can.
 */
async function confirmFenceLaunchFailure(fence: HostFence | undefined, outcome: Extract<MissionFenceOutcome, { state: 'fenced' }>): Promise<void> {
  const unit = basename(outcome.policyFile);
  try {
    if (!fence || fence.mechanism !== outcome.mechanism) return;
    // A launcher gone or unusable since the launch: the next launch reads the
    // probe itself, and a launcher put back is trusted again.
    if (!fence.probe().available) return;
    const witness = await fence.witness(outcome.policyFile);
    const failure = fenceWitnessFailure(outcome.mechanism, witness);
    if (failure) {
      noteFenceLaunchFailure(failure);
      return;
    }
    if (!witness.ran) {
      console.warn(`[resources] the fence launcher gave no answer to its witness run (${witness.reason}) after ${unit}: the fence stays on`);
      return;
    }
    if (witness.status === null) {
      console.warn(`[resources] the fence launcher's witness run was ended by a signal after ${unit}: the fence stays on`);
      return;
    }
    // The mission's text is not repeated: it is the mission's, not the launcher's.
    console.warn(`[resources] ${unit}: a fenced launch ended like a fence launcher failure, but the launcher applies the fence: the fence stays on`);
  } catch (err) {
    console.warn(`[resources] the fence launcher could not be checked after ${unit}: ${(err as Error).message}; the fence stays on`);
  }
}

/** The witness run under way: one at a time, the others would only repeat it. */
let fenceWitnessInFlight: Promise<void> | null = null;

/** The first bytes of stderr are enough: the launcher speaks before anything else does. */
const FENCE_STDERR_PEEK = 4096;

/**
 * Watches a fenced launch for a launcher that could not apply the fence. When
 * its end looks like one, the launcher is run again as a witness on the same
 * policy (`HostFence.witness`); only if that fails too is the fence turned off
 * for the next launches (`noteFenceLaunchFailure`), so that `auto` launches
 * with a warning and `enforce` refuses, instead of every turn dying the same
 * way. Removes the launch's policy once all is done; the promise settles then.
 */
export function watchFencedLaunch(
  proc: { stderr: NodeJS.ReadableStream | null; once(event: 'close', listener: (code: number | null) => void): unknown },
  outcome: MissionFenceOutcome | null,
  options: { fence?: HostFence | undefined } = {},
): Promise<void> {
  if (outcome?.state !== 'fenced') return Promise.resolve();
  const stderr = proc.stderr;
  let head = '';
  const peek = (chunk: Buffer | string): void => {
    head += chunk.toString();
    if (head.length >= FENCE_STDERR_PEEK) stderr?.removeListener('data', peek);
  };
  // Read alongside the mission's own reader, never before it: a `data`
  // listener switches the stream to flowing, and what is emitted before the
  // backend attaches its reader (after an await) would be lost to it.
  const arm = (event: string | symbol): void => {
    if (event !== 'data') return;
    stderr?.removeListener('newListener', arm);
    stderr?.on('data', peek);
  };
  stderr?.on('newListener', arm);
  return new Promise((resolve) => {
    proc.once('close', (code) => {
      stderr?.removeListener('newListener', arm);
      stderr?.removeListener('data', peek);
      const done = (): void => {
        releaseFencePolicy(outcome);
        resolve();
      };
      const suspected = fenceLaunchFailure(outcome.mechanism, code, head.slice(0, FENCE_STDERR_PEEK)) !== null;
      if (!suspected || fenceBrokenAtLaunch !== null || fenceWitnessInFlight) {
        done();
        return;
      }
      const fence = 'fence' in options ? options.fence : getHost().fence;
      const witness = confirmFenceLaunchFailure(fence, outcome);
      fenceWitnessInFlight = witness;
      void witness.finally(() => {
        if (fenceWitnessInFlight === witness) fenceWitnessInFlight = null;
        done();
      });
    });
  });
}

/** A launch target: what the resource scope reads, and what the fence needs once `timonHome` is known. */
export type MissionLaunchTarget = IsolationTarget & Partial<FenceTarget> & {
  /** Cf. `FenceMissionOptions.nestedSandbox`. */
  nestedSandbox?: NestedSandboxDeclaration | undefined;
};

/** Wraps a spawn command in a confined systemd scope + nice +
 *  ionice, around the mission fence. The fence is applied whenever the
 *  target names the Timon home; the scope only when the guard is enabled
 *  and systemd present — the spawn must NEVER fail because of the latter.
 *
 *  Every layer `exec()`s the next one: `systemd-run --scope`, `nice`,
 *  `ionice`, then the fence launcher (`timon-fence`, `sandbox-exec`), which
 *  is the innermost so that the scope and the priorities cover it and it
 *  covers only the CLI. The pid node sees stays that of the backend CLI,
 *  so `proc.kill()` and process tracking are unchanged (checked
 *  empirically, and by `resources-fence.test.ts`).
 *
 *  The confinement covers ALL the descendants: that is what catches the
 *  `ffmpeg` an agent launches three levels further down.
 *
 *  Throws `MissionFenceRefusedError` when `host.isolation.filesystem` is
 *  `enforce` and the mission cannot be fenced. */
export function wrapMissionLaunch(
  cmd: string,
  args: string[],
  missionId: string,
  target?: MissionLaunchTarget,
): MissionLaunch {
  const unit = missionScopeUnit(missionId);
  const fenced: MissionLaunch = target?.timonHome
    ? fenceMissionCommand(cmd, args, unit, { ...target, timonHome: target.timonHome, missionId: target.missionId ?? missionId }, {
      ...(target.nestedSandbox ? { nestedSandbox: target.nestedSandbox } : {}),
    })
    : { cmd, args, fence: null };
  if (!guardEnabled() || !hasSystemd() || wrapUsable === false) return fenced;
  return { ...getHost().confine(fenced.cmd, fenced.args, unit, target), fence: fenced.fence };
}

/** Probes the wrapper at start by launching `true` through it.
 *
 *  Reason for being: an argument error of `systemd-run` (one malformed property is
 *  enough — `-p=K=V` instead of `--property=K=V`) does not break the
 *  guard, it breaks the SPAWN OF EVERY MISSION, with a cryptic
 *  message. This bug was caught in a load test, not in a typecheck: nothing
 *  in TypeScript validates a command line. Better a disabled and loud guard
 *  than a silent orchestrator that no longer launches anything. */
export function probeWrapper(): boolean {
  if (!guardEnabled() || !hasSystemd()) return false;
  wrapUsable = null; // forces the complete construction of the wrapper
  const probe = wrapMissionLaunch('true', [], 'probe000');
  let r;
  try {
    r = getHost().exec(probe.cmd, probe.args, { timeout: 15_000 });
  } catch (err) {
    r = { code: 1, stdout: '', stderr: (err as Error).message };
  }
  wrapUsable = r.code === 0;
  if (!wrapUsable) {
    console.error(
      '[resources] systemd wrapper UNUSABLE — missions run without confinement: '
      + `${(r.stderr || r.stdout).trim() || `code ${r.code}`}`,
    );
  }
  return wrapUsable;
}

function parseScopeUnits(out: string): string[] {
  return out
    .split('\n')
    .map((l) => l.trim().split(/\s+/)[0] ?? '')
    .filter((u) => u.endsWith('.scope'));
}

let loggedLegacyAdoption = false;

/** Scopes of THIS instance, plus — read-only — the legacy `timon-mission-*.scope`
 *  still alive (production from before 2.2.1). The adoption is logged
 *  once; it does not stop them. */
export function listMissionScopes(home?: string): string[] {
  if (!hasSystemd()) return [];
  const own = parseScopeUnits(
    systemctl(['list-units', '--plain', '--no-legend', '--no-pager', missionScopePattern(home)]).out,
  ).filter((u) => isOwnMissionScope(u, home));
  const legacy = parseScopeUnits(
    systemctl(['list-units', '--plain', '--no-legend', '--no-pager', LEGACY_MISSION_SCOPE_PATTERN]).out,
  ).filter(isLegacyMissionScope);
  if (legacy.length > 0 && !loggedLegacyAdoption) {
    loggedLegacyAdoption = true;
    console.log(
      `[resources] adopting legacy scopes read-only (not stopped): ${legacy.join(', ')}`,
    );
  }
  return [...own, ...legacy];
}

/** Stops the remaining mission scopes. Called at boot (scopes may have
 *  survived a restart of the orchestrator, since they are no longer in its
 *  cgroup) and at shutdown (so as not to leave orphaned agents).
 *  Returns the number of scopes stopped.
 *
 *  Sees and stops ONLY the prefix of THIS `TIMON_HOME`. The scopes of another
 *  home, and the legacy `timon-mission-*.scope` without a prefix, are invisible
 *  here — the adoption (see `listMissionScopes`) is strictly read-only. */
export function stopMissionScopes(home?: string): number {
  // Guard disabled = this module does not drive systemd, so it has nothing to
  // stop. Tested BEFORE `hasSystemd()`, which already runs `systemctl`. Without
  // this exit, a witness orchestrator launched by an agent (test script,
  // local try) stopped ALL the `timon-mission-*.scope` of the machine —
  // including the scope of the agent that had launched it (exit 137 then 143) and
  // those of the production missions. Two missions killed that way on 29/08/2026.
  if (!guardEnabled()) return 0;
  if (!hasSystemd()) return 0;
  const units = parseScopeUnits(
    systemctl(['list-units', '--plain', '--no-legend', '--no-pager', missionScopePattern(home)]).out,
  ).filter((u) => isOwnMissionScope(u, home));
  if (!units.length) return 0;
  const host = getHost();
  for (const unit of units) host.services.stop(unit);
  console.log(`[resources] ${units.length} mission scope(s) stopped: ${units.join(', ')}`);
  return units.length;
}

/* ── Reading the cgroups ─────────────────────────────────────────────────── */

function showProps(unit: string, props: string[]): Record<string, string> {
  const r = systemctl(['show', unit, ...props.flatMap((p) => ['-p', p])]);
  const out: Record<string, string> = {};
  for (const line of r.out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1).trim();
  }
  return out;
}

function num(raw: string | undefined): number | null {
  if (!raw || raw === 'infinity' || raw === '[not set]') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** Reads the `memory.events` of the unit's cgroup. Goes through the FS rather than
 *  systemd: these counters are exposed by no unit property, and they
 *  are the ones that say "there was an OOM" AFTER the fact, when the faulty process
 *  has disappeared and the journal is the only other trace. */
function readEvents(controlGroup: string | undefined): CgroupStats['events'] {
  if (!controlGroup) return null;
  try {
    // portability: cgroup v2 pseudo-fs, Linux-only by construction (controlGroup comes from systemd)
    const raw = readFileSync(`/sys/fs/cgroup${controlGroup}/memory.events`, 'utf8');
    const map = new Map(raw.split('\n').filter(Boolean).map((l) => {
      const [k, v] = l.split(' ');
      return [k, Number(v) || 0] as const;
    }));
    return {
      high: map.get('high') ?? 0,
      max: map.get('max') ?? 0,
      oom: map.get('oom') ?? 0,
      oomKill: map.get('oom_kill') ?? 0,
    };
  } catch {
    return null; // inactive unit: the cgroup does not exist, it is not an error
  }
}

/** `some avg10=X` of `memory.pressure`. Exported for the tests. */
export function parsePressureSomeAvg10(raw: string): number | null {
  const m = /^some\b.*\bavg10=([\d.]+)/m.exec(raw);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function readPressure(controlGroup: string | undefined): number | null {
  if (!controlGroup) return null;
  try {
    // portability: cgroup v2 pseudo-fs, Linux-only by construction (controlGroup comes from systemd)
    return parsePressureSomeAvg10(readFileSync(`/sys/fs/cgroup${controlGroup}/memory.pressure`, 'utf8'));
  } catch {
    return null;
  }
}

export function cgroupStats(unit: string): CgroupStats {
  if (!hasSystemd()) {
    return { unit, memoryCurrent: null, memoryHigh: null, memoryMax: null, cpuQuotaPct: null, cpuWeight: null, controlGroup: null, events: null, pressureSomeAvg10: null };
  }
  const p = showProps(unit, [
    'MemoryCurrent', 'MemoryHigh', 'MemoryMax', 'CPUQuotaPerSecUSec', 'CPUWeight', 'ControlGroup',
  ]);
  const quotaUsec = num(p.CPUQuotaPerSecUSec) ?? (p.CPUQuotaPerSecUSec?.endsWith('s')
    ? Number(p.CPUQuotaPerSecUSec.replace('s', '')) * 1_000_000
    : null);
  return {
    unit,
    memoryCurrent: num(p.MemoryCurrent),
    memoryHigh: num(p.MemoryHigh),
    memoryMax: num(p.MemoryMax),
    // CPUQuotaPerSecUSec is CPU time per wall-clock second: 16 s/s = 1600 %.
    cpuQuotaPct: quotaUsec === null ? null : Math.round((quotaUsec / 1_000_000) * 100),
    cpuWeight: num(p.CPUWeight),
    controlGroup: p.ControlGroup || null,
    events: readEvents(p.ControlGroup),
    pressureSomeAvg10: readPressure(p.ControlGroup),
  };
}

export function resourceHealth(): ResourceHealth {
  const list = listMissionScopes();
  return {
    guardEnabled: guardEnabled(),
    systemd: hasSystemd(),
    profile: currentProfile(),
    limits: profileLimits(),
    appliedProfile,
    service: cgroupStats(SERVICE_UNIT),
    missions: cgroupStats(MISSION_SLICE),
    scopes: list,
    loadavg: loadavg() as [number, number, number],
    cpuCount: cpus().length,
  };
}

/* ── Surveillance & alerte ───────────────────────────────────────────────── */

type Watched = { high: number; max: number; oomKill: number };
const lastEvents = new Map<string, Watched>();
let watchTimer: NodeJS.Timeout | null = null;

/** Injected by index.ts to avoid an import cycle with notifications.ts. */
type AlertFn = (opts: { title: string; body: string; urgent: boolean; message?: DaemonMessage }) => void;
let alertSink: AlertFn = ({ title, body }) => console.warn(`[resources] ALERTE ${title} — ${body}`);

export function setResourceAlertSink(fn: AlertFn): void {
  alertSink = fn;
}

function fmtGb(bytes: number | null): string {
  return bytes === null ? '—' : `${(bytes / GB).toFixed(1)} GB`;
}

/** Compares the `memory.events` counters with the previous round and alerts on
 *  crossing. The alert is on the DIFFERENCE, not on the absolute value:
 *  these counters are cumulative since the cgroup's creation, alerting on "> 0"
 *  would spam at each tick until the next restart. */
function checkUnit(
  unit: string,
  label: string,
  st: CgroupStats = cgroupStats(unit),
  onOom?: (n: number, st: CgroupStats) => void,
): void {
  if (!st.events) { lastEvents.delete(unit); return; }
  const prev = lastEvents.get(unit);
  lastEvents.set(unit, { high: st.events.high, max: st.events.max, oomKill: st.events.oomKill });
  if (!prev) return; // first round: take the snapshot, do not alert on it

  if (st.events.oomKill > prev.oomKill) {
    const n = st.events.oomKill - prev.oomKill;
    if (onOom) onOom(n, st);
    else genericOomAlert(n, unit, label, st);
    return; // the OOM already covers the crossing of high/max, a single alert is enough
  }
  if (st.events.max > prev.max) {
    alertSink({
      title: `Memory ceiling reached (${label})`,
      body: `Cgroup ${unit} hit MemoryMax (${fmtGb(st.memoryMax)}) ${st.events.max - prev.max} time(s).`
        + ` No OOM kill so far, but there is no headroom left.`,
      urgent: true,
      message: daemonMessage('resource_memory_max', {
        label, unit, max: fmtGb(st.memoryMax), times: st.events.max - prev.max,
      }),
    });
    return;
  }
  // A cgroup without a finite MemoryHigh (the missions' slice) has no threshold to
  // cross: its `high` counters say nothing actionable.
  if (st.memoryHigh !== null && st.events.high > prev.high) {
    alertSink({
      title: `Memory pressure (${label})`,
      body: `Cgroup ${unit} went over MemoryHigh (${fmtGb(st.memoryHigh)}) — usage ${fmtGb(st.memoryCurrent)}.`
        + ` The kernel throttles and reclaims memory; nothing is killed, but the load is abnormal.`,
      urgent: false,
      message: daemonMessage('resource_memory_high', {
        label, unit, high: fmtGb(st.memoryHigh), usage: fmtGb(st.memoryCurrent),
      }),
    });
  }
}

function genericOomAlert(n: number, unit: string, label: string, st: CgroupStats): void {
  alertSink({
    title: `OOM: ${n} process(es) killed in ${label}`,
    body: `The kernel killed ${n} process(es) of cgroup ${unit} (memory ${fmtGb(st.memoryCurrent)} / max ${fmtGb(st.memoryMax)}).`
      + ` A task may have failed without a readable message — check \`journalctl -k -g "Out of memory"\`.`,
    urgent: true,
    message: daemonMessage('resource_oom_killed', {
      count: n, label, unit, usage: fmtGb(st.memoryCurrent), max: fmtGb(st.memoryMax),
    }),
  });
}

/** Injected by the plugin: delivers the notice to the mission still alive
 *  (import cycle otherwise, agent.ts depends on this module). */
type MissionNoticeFn = (missionPrefix: string, text: string) => void;
let missionNoticeSink: MissionNoticeFn = () => { /* no plugin: the alert is enough */ };

export function setMissionNoticeSink(fn: MissionNoticeFn): void {
  missionNoticeSink = fn;
}

let scopeSnapshots = new Map<string, ScopeSnapshot>();
/** Kills already reported (`scope:pid`): the kernel journal read again at the next tick
 *  would report them twice. Bounded, it only serves to deduplicate the recent ones. */
const reportedKills = new Set<string>();
let lastMissionsCheck = Date.now();

async function kernelOomLines(sinceSec: number): Promise<ReturnType<typeof parseKernelOom>> {
  try {
    const r = await getHost().execAsync(
      'journalctl', ['-k', '--no-pager', '-o', 'cat', `--since=-${sinceSec}s`],
      { timeout: 5_000 },
    );
    return r.code === 0 ? parseKernelOom(r.stdout) : [];
  } catch {
    return []; // journal unreadable for this user: the cgroup side is enough
  }
}

/** Attributes the slice's OOMs to the missions: which scope, which process,
 *  which ceiling — then warns the mission AND the notification centre.
 *  Falls back on the generic alert if nothing could be attributed. */
async function attributeMissionOoms(
  n: number,
  st: CgroupStats,
  prev: Map<string, ScopeSnapshot>,
  next: Map<string, ScopeSnapshot>,
  sinceSec: number,
): Promise<void> {
  const fromCgroups = diffScopeKills(prev, next);
  const kernel = (await kernelOomLines(sinceSec))
    .filter((k) => k.taskScope !== null && isOwnMissionScope(k.taskScope));
  const kills: OomKill[] = kernel.map((k) => {
    const scope = k.taskScope as string;
    const snap = prev.get(scope) ?? next.get(scope);
    const known = snap?.procs.find((p) => p.pid === k.pid);
    return {
      scope,
      pid: k.pid,
      cmd: known?.cmd ?? k.task,
      rssBytes: k.rssBytes ?? known?.rssBytes ?? null,
      ceilingBytes: k.scopeCeiling
        ? snap?.maxBytes ?? profileLimits().missionMemMaxMiB * 1024 * 1024
        : st.memoryMax,
      sliceWide: !k.scopeCeiling,
    };
  });
  // The journal is authoritative when readable; the cgroup diff fills the rest
  // (same scope without a matching kernel line).
  for (const k of fromCgroups) {
    if (!kills.some((x) => x.scope === k.scope)) kills.push(k);
  }
  let attributed = 0;
  for (const kill of kills) {
    const key = `${kill.scope}:${kill.pid ?? '?'}`;
    if (kill.pid !== null && reportedKills.has(key)) continue;
    reportedKills.add(key);
    if (reportedKills.size > 500) reportedKills.delete(reportedKills.values().next().value as string);
    attributed += 1;
    const text = formatKillNotice(kill);
    const prefix = missionPrefixOfScope(kill.scope);
    if (prefix) {
      try { missionNoticeSink(prefix, text); } catch (err) {
        console.warn('[resources] mission OOM notice failed:', (err as Error).message);
      }
    }
    alertSink({
      title: `OOM: mission ${prefix ?? kill.scope} — process killed`,
      body: text,
      urgent: true,
      message: killNoticeMessage(kill, prefix ?? kill.scope),
    });
  }
  if (attributed === 0) genericOomAlert(n, MISSION_SLICE, 'missions', st);
}

/** Thresholds of the pressure alert, in % of `some avg10`. The alert leaves below
 *  oomd's threshold (`SLICE_OOMD_PRESSURE_LIMIT`), to warn BEFORE it
 *  decides; it only re-arms once the pressure has clearly dropped,
 *  so as not to alert at each tick of the same episode. */
export const PRESSURE_ALERT_PCT = 25;
export const PRESSURE_REARM_PCT = 10;
let pressureAlerted = false;

/** Exported for the tests: decides alone, the caller provides the measurement. */
export function checkSlicePressure(avg10: number | null, st: Pick<CgroupStats, 'memoryCurrent' | 'memoryMax'>): void {
  if (avg10 === null) return;
  if (pressureAlerted) {
    if (avg10 < PRESSURE_REARM_PCT) pressureAlerted = false;
    return;
  }
  if (avg10 < PRESSURE_ALERT_PCT) return;
  pressureAlerted = true;
  alertSink({
    title: 'High memory pressure (missions)',
    body: `Missions spend ${avg10.toFixed(0)} % of their time stalled waiting for memory `
      + `(usage ${fmtGb(st.memoryCurrent)} / max ${fmtGb(st.memoryMax)}). Above `
      + `${SLICE_OOMD_PRESSURE_LIMIT} for 20 s, systemd-oomd will kill a mission.`,
    urgent: true,
    message: daemonMessage('resource_pressure_high', {
      pressure: avg10.toFixed(0), usage: fmtGb(st.memoryCurrent), max: fmtGb(st.memoryMax), limit: SLICE_OOMD_PRESSURE_LIMIT,
    }),
  });
}

/** Test-only. */
export function resetPressureAlertForTest(): void {
  pressureAlerted = false;
}

function checkMissions(): void {
  const st = cgroupStats(MISSION_SLICE);
  checkSlicePressure(st.pressureSomeAvg10, st);
  const prev = scopeSnapshots;
  scopeSnapshots = st.controlGroup
    ? readScopeSnapshots(st.controlGroup, (scope) => isOwnMissionScope(scope))
    : new Map();
  const now = Date.now();
  // Journal window: since the previous tick, with a margin for
  // journald's write delay.
  const sinceSec = Math.max(120, Math.ceil((now - lastMissionsCheck) / 1000) + 60);
  lastMissionsCheck = now;
  const next = scopeSnapshots;
  checkUnit(MISSION_SLICE, 'missions', st, (n) => {
    void attributeMissionOoms(n, st, prev, next, sinceSec).catch((err) => {
      console.warn('[resources] OOM attribution failed:', (err as Error).message);
      genericOomAlert(n, MISSION_SLICE, 'missions', st);
    });
  });
}

/** Starts the guard: materialises the slice, applies the current profile,
 *  then watches profile and OOM at a regular interval. */
export function startResourceGuard(): () => void {
  const noop = () => { /* nothing was started */ };
  if (!hasSystemd()) return noop;
  if (!guardEnabled()) {
    console.log('[resources] guard disabled (TIMON_RESOURCE_GUARD_ENABLED=0)');
    return noop;
  }
  for (const { key, source } of retiredSettingsInUse()) {
    console.warn(`[resources] ${key} is set (${source}) but ignored: ${RETIRED_SETTINGS[key]}`);
  }
  ensureMissionSlice();
  applyProfile(true);
  probeWrapper();
  const tick = () => {
    try {
      applyProfile(); // no-op as long as the profile does not change
      checkUnit(SERVICE_UNIT, 'orchestrateur');
      checkMissions();
    } catch (err) {
      console.warn('[resources] tick failed:', (err as Error).message);
    }
  };
  tick();
  watchTimer = setInterval(tick, Math.max(5_000, settingNum('TIMON_RESOURCE_WATCH_MS')));
  watchTimer.unref?.();
  return () => {
    if (watchTimer) clearInterval(watchTimer);
    watchTimer = null;
  };
}

export function stopResourceGuard(): void {
  if (watchTimer) clearInterval(watchTimer);
  watchTimer = null;
}
