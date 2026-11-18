/**
 * timon-fence, the Linux mission launcher (`native/timon-fence/`): where the
 * daemon finds it, how it hands it a policy, and what its exit codes mean.
 *
 * The launcher applies Landlock, no_new_privs and a seccomp filter, then
 * exec()s the mission CLI. On a kernel without Landlock it builds the same
 * view with user, mount and pid namespaces instead (`host/namespace-fence.ts`),
 * when the kernel lets an unprivileged process create them: the CLI then runs
 * two processes below the one the daemon spawned, which forward signals and
 * its exit status. Which paths a mission may reach is decided by the
 * isolation policy; this module only speaks the launcher's wire format, so
 * that the C reader and the TypeScript writer change together.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifiedRelease, type VerifiedRelease } from '../plugins/builtin.js';
import type { HostFenceWitness } from './types.js';

/** Exit codes of the launcher before the command runs (sysexits values). */
export const FENCE_EXIT = Object.freeze({
  usage: 64,
  /** No fence on this kernel: in `auto` the daemon launches unfenced and says so. */
  unavailable: 69,
  /** The kernel refused a step it advertises. */
  osError: 71,
  invalidPolicy: 78,
  execFailed: 127,
});

export const FENCE_POLICY_HEADER = 'timon-fence/1';

export interface FencePolicy {
  /** Read and execute beneath each path. */
  readonly readOnly: readonly string[];
  /** Every right beneath each path (create, write, rename, remove). */
  readonly readWrite: readonly string[];
  /** `deny` refuses socket(AF_UNIX): D-Bus, systemd --user, ssh-agent, Docker. */
  readonly unixSockets: 'deny' | 'allow';
}

/**
 * The policy file (Linux paths, hence `posix`): NUL-terminated strings, so a
 * path is written as the kernel knows it, whatever characters it holds. A
 * path the launcher cannot read
 * back unambiguously (relative, or holding a NUL) is refused here rather than
 * silently granting something else.
 */
export function encodeFencePolicy(policy: FencePolicy): Buffer {
  const fields: string[] = [FENCE_POLICY_HEADER, 'unix-sockets', policy.unixSockets];
  for (const [directive, paths] of [['ro', policy.readOnly], ['rw', policy.readWrite]] as const) {
    for (const path of paths) {
      if (!posix.isAbsolute(path)) throw new Error(`Fence policy paths must be absolute: ${path}`);
      if (path.includes('\0')) throw new Error('Fence policy paths cannot contain a NUL character');
      fields.push(directive, path);
    }
  }
  return Buffer.from(fields.map((field) => `${field}\0`).join(''), 'utf8');
}

/** The orchestrator folder: `src/host/` in a checkout, `dist/host/` once built. */
const ORCHESTRATOR_ROOT = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Where the launcher may sit, best first: inside the daemon release of a
 * package (`resources/orchestrator/native/`, covered by the signed release
 * manifest), then the build folder of a source checkout.
 */
export function fenceBinaryCandidates(orchestratorRoot = ORCHESTRATOR_ROOT, arch: string = process.arch): string[] {
  return [
    join(orchestratorRoot, 'native', 'timon-fence'),
    join(orchestratorRoot, '..', 'native', 'timon-fence', 'build', `linux-${arch}`, 'timon-fence'),
  ];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The launcher to use, or null: none is shipped off Linux, nor built for this CPU. */
export function findFenceBinary(options: { platform?: NodeJS.Platform; orchestratorRoot?: string; arch?: string } = {}): string | null {
  if ((options.platform ?? process.platform) !== 'linux') return null;
  return fenceBinaryCandidates(options.orchestratorRoot, options.arch).find(isExecutableFile) ?? null;
}

export interface FenceProbe {
  /** True when a mission can be fenced on this kernel. */
  readonly available: boolean;
  /**
   * True when the launcher builds the fence from namespaces: no Landlock
   * (ABI 2 or later) on this kernel, unprivileged user namespaces allowed.
   */
  readonly namespaces?: boolean;
  /** True when the kernel offers neither Landlock nor unprivileged user namespaces. */
  readonly noMechanism?: boolean;
  /**
   * True when the launcher ran and described the kernel. False when it could
   * not run or said nothing a launcher would: then the launcher, not the
   * kernel, is at fault.
   */
  readonly answered: boolean;
  /** Landlock ABI, 0 when absent or disabled. */
  readonly abi: number;
  readonly seccomp: boolean;
  /** Why it is unavailable, in English, for doctor and the logs. */
  readonly reason?: string;
}

/**
 * Parses `timon-fence --probe`: `landlock-abi=N seccomp=yes|no`, then
 * `userns=yes|no|unchecked` from launchers that know the namespace mode (it
 * is only checked when Landlock is missing). A launcher without the field
 * has no namespace mode.
 */
export function parseFenceProbe(stdout: string, status: number | null): FenceProbe {
  const match = /landlock-abi=(\d+) seccomp=(yes|no)(?: userns=(yes|no|unchecked))?/.exec(stdout);
  if (!match) return { available: false, answered: false, abi: 0, seccomp: false, reason: 'the fence launcher did not answer its probe' };
  const abi = Number(match[1]);
  const seccomp = match[2] === 'yes';
  const userns = match[3] === 'yes';
  if (status === 0) {
    return abi >= 2 ? { available: true, answered: true, abi, seccomp } : { available: true, answered: true, abi, seccomp, namespaces: true };
  }
  if (abi >= 2 || (userns && !seccomp)) return { available: false, answered: true, abi, seccomp, reason: 'kernel without seccomp filters' };
  const landlock = abi === 0 ? 'kernel without Landlock' : `kernel with Landlock ABI ${abi}, 2 or later is required`;
  // Said only by a launcher that checked: an older one cannot fall back at all.
  if (match[3] === 'no') {
    return { available: false, answered: true, abi, seccomp, noMechanism: true, reason: `${landlock}, and without unprivileged user namespaces` };
  }
  return { available: false, answered: true, abi, seccomp, reason: landlock };
}

/** Asks the launcher what this kernel supports. */
export function probeFence(binary: string): FenceProbe {
  const result = spawnSync(binary, ['--probe'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error) return { available: false, answered: false, abi: 0, seccomp: false, reason: `the fence launcher cannot run (${result.error.message})` };
  return parseFenceProbe(result.stdout, result.status);
}

/**
 * The payload of a witness run on Linux. Absent (NixOS), the launcher exits
 * 127 after every fence step succeeded, which still proves the fence applies.
 */
export const WITNESS_PAYLOAD = '/bin/true'; // portability: Linux system binary, used with the Linux launcher only

/** The launcher's words fit in this much; a witness payload prints nothing. */
const WITNESS_STDERR_MAX = 4096;

/** A witness that could not be started, with the errno code that says why. */
function spawnFailure(err: unknown): HostFenceWitness {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  return { ran: false, reason: err instanceof Error ? err.message : String(err), timedOut: false, ...(typeof code === 'string' ? { code } : {}) };
}

/**
 * Runs a fence launcher once with a trivial payload, without blocking the
 * daemon: what it exits with and writes on stderr is the launcher's alone.
 */
export function runFenceWitness(file: string, args: readonly string[], timeoutMs = 5_000): Promise<HostFenceWitness> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: HostFenceWitness): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch (err) {
      resolve(spawnFailure(err));
      return;
    }
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < WITNESS_STDERR_MAX) stderr += chunk.toString('utf8');
    });
    child.once('error', (err) => settle(spawnFailure(err)));
    child.once('close', (status) => settle(timedOut
      ? { ran: false, reason: `no answer within ${timeoutMs} ms`, timedOut: true }
      : { ran: true, status, stderr: stderr.slice(0, WITNESS_STDERR_MAX) }));
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   Can this machine fence a mission, and what a launch does about it.

   Two causes leave a mission unfenced, and they must never read alike. An OS
   or a kernel without the mechanism is a property of the machine: `auto`
   launches with a warning. A release that ships the launcher — its signed
   manifest lists `native/timon-fence` — whose launcher is gone, no longer
   executable, replaced or unable to run is a sign the package was altered
   after the boot check: `auto` still launches, by design, but says
   so in those words, and `enforce` refuses. A machine whose release does not
   list the launcher (an older package, another OS, a source checkout) keeps
   the plain "unsupported" outcome.
   ────────────────────────────────────────────────────────────────────────── */

/** The launcher's name in a release manifest (`desktop/scripts/release-integrity.mjs`). */
export const FENCE_RELEASE_FILE = 'native/timon-fence';

export type FenceStatus =
  | {
    readonly state: 'ready'; readonly binary: string; readonly abi: number; readonly seccomp: boolean;
    /** Set when the fence is built from namespaces: the kernel has no Landlock. */
    readonly fallback?: 'namespaces';
  }
  /**
   * This OS, this kernel or this checkout cannot fence: nothing was altered.
   * `noMechanism` says the launcher ran and the kernel offers neither
   * Landlock nor unprivileged user namespaces: a launch is refused even in
   * `auto` (`fenceLaunchDecision`).
   */
  | { readonly state: 'unsupported'; readonly reason: string; readonly abi: number; readonly noMechanism?: boolean }
  /** The release ships a launcher that is no longer usable: a sign of alteration. */
  | { readonly state: 'tampered'; readonly reason: string; readonly abi: number };

/**
 * Whether the release under `root` ships the launcher, and the digest it was
 * signed with. The inventory `dist/boot.js` verified comes first; failing
 * that, the manifest file itself is read, unverified: it can only make the
 * outcome stricter, never hand a launcher trust.
 */
export function fenceDeclaredByRelease(
  root: string = ORCHESTRATOR_ROOT,
  release: VerifiedRelease | null = verifiedRelease(),
): { declared: boolean; digest: string | null } {
  const signed = release?.files[FENCE_RELEASE_FILE];
  if (signed !== undefined) return { declared: true, digest: signed };
  if (release) return { declared: false, digest: null };
  const manifest = join(root, 'release-manifest.json');
  if (!existsSync(manifest)) return { declared: false, digest: null };
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifest, 'utf8'));
    const files = typeof parsed === 'object' && parsed !== null ? (parsed as { files?: unknown }).files : undefined;
    const declared = typeof files === 'object' && files !== null && Object.hasOwn(files, FENCE_RELEASE_FILE);
    return { declared, digest: null };
  } catch {
    // An unreadable manifest in a packaged tree is itself an alteration; the
    // boot check refuses it, and this status has nothing to add.
    return { declared: false, digest: null };
  }
}

/** What is wrong with the shipped launcher file, or null. */
function shippedLauncherProblem(binary: string, digest: string | null): string | null {
  let isFile: boolean;
  try {
    isFile = statSync(binary).isFile();
  } catch {
    return 'missing';
  }
  if (!isFile) return 'not a regular file';
  if (!isExecutableFile(binary)) return 'not executable';
  if (digest !== null) {
    let actual: string;
    try {
      actual = createHash('sha256').update(readFileSync(binary)).digest('hex');
    } catch {
      return 'unreadable';
    }
    if (actual !== digest) return 'no longer the file the release signed';
  }
  return null;
}

export interface FenceStatusOptions {
  platform?: NodeJS.Platform;
  orchestratorRoot?: string;
  arch?: string;
  /** The verified inventory; defaults to the one handed over at boot. */
  release?: VerifiedRelease | null;
  probe?: (binary: string) => FenceProbe;
}

/**
 * Can a mission be fenced right now. Not cached: a launcher altered after boot
 * must show at the next launch, and a probe is one short exec.
 */
export function fenceStatus(options: FenceStatusOptions = {}): FenceStatus {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux') return { state: 'unsupported', reason: 'no fence launcher for this OS', abi: 0 };
  const root = options.orchestratorRoot ?? ORCHESTRATOR_ROOT;
  const probe = options.probe ?? probeFence;
  const release = options.release === undefined ? verifiedRelease() : options.release;
  const shipped = fenceDeclaredByRelease(root, release);

  if (shipped.declared) {
    // In a release, only the signed copy counts: never a build folder nearby.
    const binary = fenceBinaryCandidates(root, options.arch)[0] ?? join(root, 'native', 'timon-fence');
    const problem = shippedLauncherProblem(binary, shipped.digest);
    if (problem) return { state: 'tampered', reason: `the fence launcher this release ships (${binary}) is ${problem}`, abi: 0 };
    const result = probe(binary);
    if (!result.available && !result.answered) {
      return { state: 'tampered', reason: `the fence launcher this release ships (${binary}) does not run: ${result.reason ?? 'no answer'}`, abi: 0 };
    }
    return statusOfProbe(binary, result);
  }

  const binary = findFenceBinary({ platform, orchestratorRoot: root, ...(options.arch ? { arch: options.arch } : {}) });
  if (!binary) return { state: 'unsupported', reason: 'no fence launcher built for this machine', abi: 0 };
  return statusOfProbe(binary, probe(binary));
}

function statusOfProbe(binary: string, result: FenceProbe): FenceStatus {
  if (result.available) {
    return { state: 'ready', binary, abi: result.abi, seccomp: result.seccomp, ...(result.namespaces ? { fallback: 'namespaces' as const } : {}) };
  }
  return {
    state: 'unsupported', reason: result.reason ?? 'no fence on this kernel', abi: result.abi, ...(result.noMechanism ? { noMechanism: true } : {}),
  };
}

export type FenceLaunch =
  | { readonly action: 'fence'; readonly binary: string }
  /** `warning` is null only when the configuration turned the fence off. */
  | { readonly action: 'unfenced'; readonly warning: string | null; readonly tampered: boolean }
  | { readonly action: 'refuse'; readonly error: string; readonly tampered: boolean };

const ALTERED = 'The Timon package may have been altered: reinstall it.';

/** How to accept unconfined missions on a kernel that offers no mechanism: the one setting that does it. */
export const NO_MECHANISM_REMEDY = 'Run a kernel with Landlock (5.19 or later) or allow unprivileged user namespaces, '
  + 'or set host.isolation.filesystem to "off" to accept missions that can read Timon\'s private files.';

/**
 * What a mission launch does under `host.isolation.filesystem`. Never a silent
 * fallback: `auto` launches unfenced with a warning naming the cause, and the
 * cause of an altered release is worded apart from a machine that lacks the
 * mechanism. A Linux kernel the launcher found without Landlock AND without
 * unprivileged user namespaces is refused in `auto` too: there the launcher
 * ran and no fence can hold, and only `off`, written on purpose, accepts it.
 */
export function fenceLaunchDecision(mode: 'auto' | 'enforce' | 'off', status: FenceStatus): FenceLaunch {
  if (mode === 'off') return { action: 'unfenced', warning: null, tampered: false };
  if (status.state === 'ready') return { action: 'fence', binary: status.binary };
  const tampered = status.state === 'tampered';
  const cause = tampered ? `${status.reason}. ${ALTERED}` : `${status.reason}.`;
  if (mode === 'enforce') {
    return { action: 'refuse', tampered, error: `Mission refused: host.isolation.filesystem is "enforce" and it cannot be fenced: ${cause}` };
  }
  if (status.state === 'unsupported' && status.noMechanism) {
    return { action: 'refuse', tampered: false, error: `Mission refused: it cannot be kept away from Timon's private files: ${cause} ${NO_MECHANISM_REMEDY}` };
  }
  return {
    action: 'unfenced',
    tampered,
    warning: tampered ? `Mission launched UNFENCED: ${cause}` : `Mission launched unfenced: ${cause}`,
  };
}
