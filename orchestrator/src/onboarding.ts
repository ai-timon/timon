/**
 * What the onboarding screen is allowed to EXECUTE on this machine (step 5.7.3).
 *
 * Installing the daemon as a service is mandatory on the three OSes, so the
 * first-run screen needs to do more than print advice: it acts. That turns a
 * wizard into a remote execution surface, which is why everything here is
 * shaped by one rule:
 *
 *   **No command ever comes from the client.** The request names an ACTION —
 *   `install-service`, or `install-binary` with a name validated against the
 *   closed list `doctor.ts` already maintains. The argv is derived here, from
 *   the detected package manager. A string sent by a browser never reaches a
 *   process.
 *
 * Everything that runs a process here is ASYNC. `host.exec` is `spawnSync`:
 * an `npm install -g` behind it would freeze the daemon's event loop — HTTP,
 * SSE, agents, everything — for as long as the install takes. A first-run
 * machine is idle, but "idle" is not a reason to hold the loop for a minute.
 *
 * Second rule, its complement: what we refuse to run, we SHOW. A command
 * needing `sudo` is never executed by a daemon — it would hang on a password
 * prompt nobody sees, or run under whatever a polkit rule happens to allow —
 * so the answer carries the exact line to paste, and the reason we did not run
 * it. A refusal the user cannot act on is a dead end, and this screen blocks
 * the product.
 */
import { serviceOptsFromEnvironment as serviceOptsFor } from './host/service-environment.js';
import { installWithRuntime } from './host/packaged-install.js';
import { statSync, type Stats } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { config } from './config/load.js';
import { BUILTIN_DECLARATIONS } from './backends/builtin-declarations.js';
import { cliVersionInfo, type CliVersionInfo } from './provider-cli-versions.js';
import { authStatusNow, installedProfiles } from './backends/registry.js';
import { refreshProviderSignIn } from './backends/sign-in-state.js';
import { BINARY_NAMES, mainAgentAuthEnv, systemdPresent, whichBin } from './doctor.js';
import { getHost } from './host/index.js';
import {
  installBackendPlanFor,
  installPlanFor,
  linuxRelease,
  readOsRelease,
  supervisorFor,
  type InstallableBackend,
  type Machine,
} from './host/machine.js';
import { isDesktopBuildPath } from './host/binary-path.js';
import { installMacNodeUserLocal } from './host/macos-node-install.js';
import { rememberWindowsNpmBinary } from './host/npm-install.js';
import { applySessionMode, installService, sessionModeNeedsReinstall, statusService, type ServiceOpts } from './host/service-install.js';
import {
  isServiceSessionMode, readServiceSessionMode, sessionModeSupported, writeServiceSessionMode, type ServiceSessionMode,
} from './host/service-session-mode.js';
import { guardServiceGesture } from './host/service-ownership.js';
import { temporaryHomeNotice } from './host/temporary-home.js';
import type { ExecResult } from './host/types.js';

/** Named gestures. Anything else is refused before it reaches a process. */
export type OnboardingAction =
  /** `mode`: the onboarding's answer to "keep running when logged out?", recorded before the install. */
  | { action: 'install-service'; mode?: ServiceSessionMode }
  | { action: 'service-status' }
  | { action: 'install-binary'; name: string }
  | { action: 'check-path'; path: string };

export type OnboardingResult = {
  ok: boolean;
  /** `service-status` / `install-service`: a supervisor is REGISTERED for the
   *  daemon. It may not be running yet — during a packaged first launch the
   *  embedded daemon still holds the port until the user relaunches. */
  installed?: boolean;
  /** What happened, line by line — the same lines `timon service` prints. */
  lines: string[];
  /** The exact command to paste when we could not (or must not) run it. */
  command: string | null;
  /** Why it failed, in the words of the tool that refused. */
  reason: string | null;
  /** `service-status`: the registered service keeps running once the user logs out (`ServiceResult.offSession`). */
  offSession?: boolean | null;
  /** `service-status`, Linux: lingering is on for the account, service or not (`ServiceResult.lingering`). */
  lingering?: boolean | null;
  /** `service-status`: the recorded answer, `null` when the user was never asked. */
  sessionMode?: ServiceSessionMode | null;
  /** `service-status`: the answer changes something on this OS (`sessionModeSupported`). */
  sessionModeSupported?: boolean;
};

export class OnboardingError extends Error {}

/**
 * Installs through the same host adapter as the CLI. Do not suggest a bare
 * CLI command on failure: packaged users may not have it, and retrying it
 * cannot resolve a service identity conflict.
 */
export function runInstallService(
  opts: ServiceOpts,
  install: (o: ServiceOpts) => { ok: boolean; lines: string[] } = installService,
): OnboardingResult {
  let result: { ok: boolean; lines: string[] };
  try {
    result = install(opts);
  } catch (e) {
    return {
      ok: false,
      lines: [],
      command: null,
      reason: (e as Error).message,
    };
  }
  if (result.ok) return { ok: true, installed: true, lines: result.lines, command: null, reason: null };
  return {
    ok: false,
    lines: result.lines,
    command: null,
    // The last line is the tool's own refusal (`systemctl refused: …`), which
    // says more than any sentence we could write around it.
    reason: result.lines[result.lines.length - 1] ?? 'the service installer refused',
  };
}

/**
 * Installs one prerequisite. `name` is validated against the binaries Timon
 * actually invokes — not against a pattern: a name that passes a regex is
 * still a name we never meant to install.
 */
export async function runInstallBinary(
  name: string,
  machine: Machine,
  exec: (command: string, args: string[]) => Promise<ExecResult>,
  installMacNode: typeof installMacNodeUserLocal = installMacNodeUserLocal,
): Promise<OnboardingResult> {
  if (!BINARY_NAMES.includes(name)) {
    throw new OnboardingError(`unknown prerequisite: ${name}`);
  }
  const plan = installPlanFor(name, machine);
  if (!plan) {
    return {
      ok: false,
      lines: [],
      command: null,
      reason: `no install command known for ${name} on this machine`,
    };
  }
  if (plan.elevated) {
    return {
      ok: false,
      lines: [],
      command: plan.display,
      reason: 'this command needs administrator rights — Timon will not ask for them on your behalf',
    };
  }

  if (plan.installer === 'macos-node') {
    try {
      const lines = await installMacNode({ exec });
      return { ok: true, lines, command: null, reason: null };
    } catch (error) {
      return { ok: false, lines: [], command: null, reason: (error as Error).message };
    }
  }

  const [command, ...args] = plan.argv as [string, ...string[]];
  let res: ExecResult;
  try {
    res = await exec(command, args);
  } catch (e) {
    // The host adapter throws when the binary itself is absent (`npm` on a
    // machine without Node): that is a refusal to report, not a crash.
    return { ok: false, lines: [], command: plan.display, reason: (e as Error).message };
  }
  const ok = res.code === 0;
  if (ok && machine.platform === 'win32' && command === 'npm') {
    try {
      const binary = await rememberWindowsNpmBinary(name, exec);
      return { ok: true, lines: [`${plan.display} → 0`, `Detected ${name}: ${binary}`], command: null, reason: null };
    } catch (error) {
      return { ok: false, lines: [`${plan.display} → 0`], command: null, reason: (error as Error).message };
    }
  }
  return {
    ok,
    lines: [`${plan.display} → ${res.code}`],
    command: ok ? null : plan.display,
    reason: ok ? null : failureReason(res),
  };
}

/** One AI CLI as THIS machine sees it, and the lines to act on it: the cards of the onboarding's
 *  "Your AIs" step and of Settings › AI models › Providers. */
export type SetupBackend = {
  /** The CLI's canonical binary name: what the install route is told. */
  name: string;
  /** The CLI's name on its card, and the key of its logo. */
  label: string;
  brand: string | null;
  /** Where the daemon finds it, `null` when it does not. */
  path: string | null;
  /** The build a desktop app ships (Claude, ChatGPT, Codex): Install stays
   *  offered, since the standalone CLI then takes precedence in resolution. */
  bundled: boolean;
  /** `false` only when the daemon KNOWS there are no credentials (Codex); `null`: it cannot tell. */
  signedIn: boolean | null;
  /** The vendor gives an installer for this OS, which the daemon can run. */
  installable: boolean;
  /** The vendor's official installer, to paste when the button cannot run it; `null` without one here. */
  installCommand: string | null;
  /** The vendor's installation page: the way forward when there is no installer to run. */
  installDocs: string | null;
  /** What signs in. Built on the resolved path once installed: a terminal opened
   *  before the install does not have the new PATH, and a bare `claude` fails there. */
  signInCommand: string;
  /** What to type once that command runs, when the CLI does not sign in by itself (`/login`). */
  signInThen: string | null;
  /** A fresh install can seed its main agent on it: the providers the onboarding's chat can start on. */
  seedsMainAgent: boolean;
} & CliVersionInfo;

type ProviderCli = {
  provider: string;
  name: string;
  label: string;
  signInCommand: string | undefined;
  signInThen: string | undefined;
  installDocs: string | undefined;
  installer: boolean;
  seedsMainAgent: boolean;
};

/**
 * The product's providers that run a CLI of their own and have a card on the
 * first-run screen, in the order of the table. A provider a plugin brings is
 * never here: what the install route may run is the product's decision.
 */
export function providerClis(): ProviderCli[] {
  return Object.entries(BUILTIN_DECLARATIONS).flatMap(([provider, declared]) => {
    const binary = declared.binary;
    if (!binary || !declared.setupCard) return [];
    return [{
      provider,
      name: binary.names[0]!,
      label: binary.standaloneInstaller?.label ?? declared.setupCard.label,
      signInCommand: declared.signInCommand,
      signInThen: declared.signInThen,
      installDocs: declared.installDocs,
      installer: binary.standaloneInstaller !== undefined,
      seedsMainAgent: declared.seedsMainAgent === true,
    }];
  });
}

/** The names a route accepts: anything else is refused before it reaches a lookup. */
export const PROVIDER_CLI_NAMES: readonly string[] = Object.freeze(providerClis().map((cli) => cli.name));

function invocation(path: string | null, fallback: string, platform: NodeJS.Platform): string {
  if (!path) return fallback;
  if (!/\s/.test(path)) return path;
  // PowerShell prints a quoted string instead of running it without the call operator.
  return platform === 'win32' ? `& "${path}"` : `"${path}"`;
}

/** A CLI found inside a desktop application rather than installed on its own. */
export function desktopBundled(name: string, path: string, platform: NodeJS.Platform): boolean {
  // The macOS apps ship their CLI inside the bundle; any other layout is a build the provider declared.
  if (platform === 'darwin' && path.includes('.app/Contents/')) return true;
  return isDesktopBuildPath(name, path, { platform });
}

export function setupBackends(
  platform: NodeJS.Platform = process.platform,
  locate: (name: string) => string | null = (name) => whichBin(name, config().host.binaries).path,
  signedIn: (provider: string) => boolean | null = (provider) => authStatusNow(provider, mainAgentAuthEnv() as Readonly<Record<string, string>>)?.ok ?? null,
  versions: (name: string, path: string | null) => CliVersionInfo = (name, path) => cliVersionInfo(name, path),
): SetupBackend[] {
  return providerClis().map((cli) => {
    const { name } = cli;
    const path = locate(name);
    const signIn = cli.signInCommand ?? name;
    // The vendor's line starts with the program: it is replaced by the path the daemon resolved.
    const [program = name, ...rest] = signIn.split(' ');
    const version = versions(name, path);
    // A generation the provider does not support: its installer would replace it, so none is offered.
    const plan = cli.installer && !version.unsupportedVersion ? installBackendPlanFor(name, platform) : null;
    return {
      name,
      label: cli.label,
      brand: installedProfiles().find((profile) => profile.id === cli.provider)?.brand ?? null,
      path,
      bundled: path ? desktopBundled(name, path, platform) : false,
      // Only a provider that can tell (C4) has an answer; for the others the daemon cannot know.
      signedIn: path ? signedIn(cli.provider) : null,
      installable: plan !== null,
      installCommand: plan?.display ?? null,
      installDocs: cli.installDocs ?? null,
      signInCommand: [invocation(path, program, platform), ...rest].join(' '),
      signInThen: cli.signInThen ?? null,
      seedsMainAgent: cli.seedsMainAgent,
      ...version,
    };
  });
}

/**
 * `setupBackends` with each installed provider asked afresh: the person clicks "Try again"
 * right after signing in, and only some providers answer synchronously (Claude's sign-in
 * sits in the macOS keychain). A CLI that is not there has nothing to ask.
 */
export async function setupBackendsNow(): Promise<SetupBackend[]> {
  const present = providerClis().filter((cli) => whichBin(cli.name, config().host.binaries).path !== null);
  const fresh = new Map(await Promise.all(present.map(async (cli) => [cli.provider, await refreshProviderSignIn(cli.provider, true)] as const)));
  return setupBackends(process.platform, undefined, (provider) =>
    fresh.get(provider) ?? authStatusNow(provider, mainAgentAuthEnv() as Readonly<Record<string, string>>)?.ok ?? null);
}

/**
 * Runs the vendor's installer for one AI CLI, then checks the daemon can now
 * find it. An installer that exits 0 into a directory the daemon never looks
 * in would leave "Try again" failing behind a reported success.
 */
export async function runInstallBackend(
  name: InstallableBackend,
  platform: NodeJS.Platform,
  exec: (command: string, args: string[]) => Promise<ExecResult>,
  locate: (name: string) => string | null,
): Promise<OnboardingResult> {
  const plan = installBackendPlanFor(name, platform);
  if (!plan) return { ok: false, lines: [], command: null, reason: `${name} has no official installer on this operating system` };
  const [command, ...args] = plan.argv as [string, ...string[]];
  const res = await exec(command, args);
  if (res.code !== 0) {
    return { ok: false, lines: [`${plan.display} → ${res.code}`], command: plan.display, reason: failureReason(res) };
  }
  const path = locate(name);
  if (!path) {
    return {
      ok: false,
      lines: [`${plan.display} → 0`],
      command: plan.display,
      // `curl … | bash` exits 0 when curl is missing: the tool's own words say why.
      reason: `the installer finished, but Timon cannot find ${name} where it looks for it`
        + (res.stderr.trim() || res.stdout.trim() ? ` — ${failureReason(res)}` : ''),
    };
  }
  return { ok: true, lines: [`${plan.display} → 0`, `Detected ${name}: ${path}`], command: null, reason: null };
}

/** The line that says why an install failed. winget prints its errors on
 *  stdout, so a stderr-only reading left the screen with a bare "exit 1". */
export function failureReason(res: ExecResult): string {
  for (const stream of [res.stderr, res.stdout]) {
    const line = stream.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[A-Za-z]/.test(l)).pop();
    if (line) return `${line} (exit ${res.code})`;
  }
  return `exit ${res.code}`;
}

/**
 * `exec` that reports instead of throwing — the host adapter throws when it
 * cannot resolve a binary, and "npm is not installed either" is an answer the
 * screen must display, not a 500.
 */
async function safeExec(command: string, args: string[]): Promise<ExecResult> {
  try {
    return await getHost().execAsync(command, args, { timeout: 300_000 });
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
}

/** This machine, as the install plans need it. */
export function machineFromEnvironment(): Machine {
  const linux = process.platform === 'linux' ? linuxRelease(readOsRelease()) : null;
  return { platform: process.platform, packageManager: linux?.packageManager ?? null };
}

/**
 * Does a path the onboarding screen offers actually exist (step 5.9.4)?
 *
 * A `stat`, and nothing else: no listing, no creation, no command. The screen
 * asks it about the projects root and the Obsidian vault so the user finds out
 * now rather than when an agent fails to spawn weeks later. Reachable on first
 * run only, by an authenticated operator who is the owner of the machine.
 */
export function checkPath(
  raw: string,
  stat: (path: string) => Stats = statSync,
  platform: NodeJS.Platform = process.platform,
): OnboardingResult {
  const path = raw.trim();
  if (!path) return { ok: false, lines: [], command: null, reason: 'empty path' };
  const expanded = path === '~' ? homedir()
    : path.startsWith('~/') ? join(homedir(), path.slice(2))
    : path;
  if (!isAbsolute(expanded)) {
    return { ok: false, lines: [expanded], command: null, reason: 'the path must be absolute' };
  }
  const refuse = (reason: string): OnboardingResult => ({ ok: false, lines: [expanded], command: null, reason });
  let info: Stats;
  try {
    info = stat(expanded);
  } catch (error) {
    // `existsSync` folded every failure into "absent", which hid the real errno.
    // The code is shown to the user and written to daemon.log so it can be read
    // on a machine we cannot reach.
    const code = (error as NodeJS.ErrnoException).code ?? 'unknown error';
    console.warn(`[onboarding] check-path ${expanded} → ${code}`);
    return refuse(describeStatFailure(code, platform));
  }
  if (!info.isDirectory()) return refuse('this path is not a directory');
  return { ok: true, lines: [expanded], command: null, reason: null };
}

/** The message for a failed `stat`: always quotes the errno it received. */
function describeStatFailure(code: string, platform: NodeJS.Platform): string {
  if (code === 'EPERM' || code === 'EACCES') {
    const lead = platform === 'darwin'
      ? ' On macOS, the permissions under System Settings → Privacy & Security are one place to check.'
      : '';
    return `Timon was refused access to this folder (${code}).${lead}`;
  }
  if (code === 'ENOENT') return `this path does not exist yet (${code})`;
  if (code === 'ENOTDIR') return `a part of this path is not a directory (${code})`;
  return `this path cannot be read (${code})`;
}

/**
 * The onboarding and Settings buttons, when the service in place belongs to
 * another installation. No `--force` from a button: replacing it stays a typed
 * gesture, which the reason names (TODO #734).
 */
export function foreignServiceRefusal(opts: ServiceOpts, sourceInstallDir: string): OnboardingResult | null {
  const { refusal } = guardServiceGesture(opts, 'install', { sourceInstallDir });
  if (!refusal) return null;
  return { ok: false, installed: false, lines: refusal.lines, command: null, reason: refusal.reason ?? null };
}

let installInFlight: Promise<OnboardingResult> | undefined;
async function installOnboardingService(mode?: ServiceSessionMode): Promise<OnboardingResult> {
  try {
    const opts = serviceOptsFromEnvironment();
    // Recorded first: the desktop's upgrade runner reads it again at every
    // update. Also passed with the install: an answer given now is applied
    // even where it undoes what the machine had (Linux lingering already on).
    if (mode && sessionModeSupported(opts.platform)) writeServiceSessionMode(opts.timonHome, mode);
    const install: ServiceOpts = mode && sessionModeSupported(opts.platform) ? { ...opts, sessionMode: mode } : opts;
    // Not refused here: a release-candidate test on a throwaway home has to get
    // through onboarding. Its script removes the service at the end (#464).
    const temporary = temporaryHomeNotice(opts.timonHome, true);
    if (temporary) console.warn(`[onboarding] ${temporary.lines.join(' ')}`);
    const refused = foreignServiceRefusal(install, config().daemon.installDir);
    if (refused) return refused;
    return await installWithRuntime(install, config().daemon.installDir, (o) => runInstallService(o));
  } catch (error) {
    return { ok: false, installed: false, lines: [], command: null, reason: (error as Error).message };
  }
}

/** Runs a named action. The only entry point a route is allowed to call. */
export async function runOnboardingAction(action: OnboardingAction): Promise<OnboardingResult> {
  if (action.action === 'install-service') {
    if (!installInFlight) installInFlight = installOnboardingService(action.mode).finally(() => { installInFlight = undefined; });
    return installInFlight;
  }
  if (action.action === 'service-status') {
    // Read-only, and the reason the screen can block: it must know what the
    // MACHINE says, not whether a button was clicked once.
    const opts = serviceOptsFromEnvironment();
    const res = statusService(opts);
    return {
      ok: res.ok,
      installed: res.installed ?? false,
      lines: res.lines,
      command: null,
      reason: res.reason ?? null,
      offSession: res.offSession ?? null,
      lingering: res.lingering ?? null,
      sessionMode: readServiceSessionMode(opts.timonHome),
      // A Linux without systemd runs portable: no service, nothing to choose.
      sessionModeSupported: sessionModeSupported(opts.platform)
        && supervisorFor(opts.platform, { systemd: opts.platform === 'linux' && systemdPresent() }) !== null,
    };
  }
  if (action.action === 'check-path') return checkPath(action.path);
  return await runInstallBinary(action.name, machineFromEnvironment(), safeExec);
}

/**
 * Settings › System: the answer to "keep running when logged out?" changed
 * after the onboarding. Linux applies it in place (lingering). macOS and
 * Windows change the supervisor itself: the service is reinstalled through the
 * onboarding's install path, except from the service's own daemon, which that
 * reinstall would stop mid-request (and which, in Windows session 0, could
 * not even show the elevation prompt): the answer is recorded and the command
 * shown.
 */
export async function changeServiceSessionMode(
  mode: ServiceSessionMode,
  daemonIsService: boolean,
): Promise<OnboardingResult> {
  try {
    const opts = serviceOptsFromEnvironment();
    const applied = applySessionMode(opts, mode);
    const answer: OnboardingResult = {
      ok: applied.ok, lines: applied.lines, command: null, reason: applied.reason ?? null,
    };
    if (!applied.ok || !sessionModeNeedsReinstall(opts.platform)) return answer;
    if (!statusService(opts).installed) return answer;
    if (daemonIsService) return { ...answer, command: 'timon service install' };
    const installed = await installOnboardingService();
    return { ...installed, lines: [...applied.lines, ...installed.lines] };
  } catch (error) {
    return { ok: false, lines: [], command: null, reason: (error as Error).message };
  }
}

/** Parses the request body into an action, or refuses it. */
export function parseOnboardingAction(body: unknown): OnboardingAction {
  const raw = (body ?? {}) as { action?: unknown; name?: unknown; path?: unknown };
  if (raw.action === 'install-service') {
    const { mode } = raw as { mode?: unknown };
    if (mode === undefined) return { action: 'install-service' };
    if (!isServiceSessionMode(mode)) throw new OnboardingError('install-service: mode must be "session" or "always"');
    return { action: 'install-service', mode };
  }
  if (raw.action === 'service-status') return { action: 'service-status' };
  if (raw.action === 'install-binary') {
    if (typeof raw.name !== 'string') throw new OnboardingError('install-binary requires a binary name');
    return { action: 'install-binary', name: raw.name };
  }
  if (raw.action === 'check-path') {
    if (typeof raw.path !== 'string') throw new OnboardingError('check-path requires a path');
    return { action: 'check-path', path: raw.path };
  }
  throw new OnboardingError(`unknown onboarding action: ${String(raw.action)}`);
}

export { serviceOptsForPlatform, stagesPackagedRuntime } from './host/service-environment.js';

/** The daemon's own options: its config and host adapter, both already loaded here. */
export function serviceOptsFromEnvironment(): ServiceOpts {
  return serviceOptsFor(config(), getHost);
}
