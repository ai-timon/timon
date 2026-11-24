/**
 * `timon doctor` — what this machine can do.
 *
 * The diagnostic answers a precise question, asked on every fresh-machine
 * install: "what will work here, and what will be missing?". It doesn't fix
 * or change anything — it only looks.
 *
 * Capabilities are no longer computed here: since step 2.3 they come from
 * `host.capabilities()` (plan §3.5). The diagnostic keeps the DETAIL (resolved
 * binaries, docker reachable or not, graphical session) — what a human reads
 * to understand WHY a capability is missing — but the list that decides
 * module activation has a single source of truth: the host adapter.
 */
import { inheritEnvEnabled, systemEnv, secretsEnvFor } from './secrets/env.js';
import { mainAgentNameOrSeed, mainSeatState } from './main-agent.js';
import { mainAgentOnboardingPending } from './onboarding-main-agent.js';
import { listAgents } from './agent.js';
import { loadConfig } from './agent-config.js';
import { projectFromCwd } from './task-project.js';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CONFIG_FILE, config } from './config/load.js';
import {
  installCommandFor,
  linuxRelease,
  readOsRelease,
  supervisorFor,
} from './host/machine.js';
import { getHost } from './host/index.js';
import { hasSystemd } from './host/systemd.js';
import { windowsServiceFiles } from './host/service-install.js';
import { resolveIsolation } from './host/isolation.js';
import { fenceLaunchDecision, type FenceStatus } from './host/fence.js';
import type { FenceMechanism } from './host/types.js';
import { hostFenceStatus } from './resources.js';
import type { TimonConfig } from './config/schema.js';
import { TIMON_HOME } from './paths.js';
import { formatBytes, freeBytes, LOW_DISK_BYTES } from './storage-failure.js';
import { CATALOG } from './kernel/catalog.js';
import { degradation } from './kernel/degradation.js';
import { nodelessBackends, nodelessBackendText } from './host/launch-path.js';
import { binaryCandidates, findExecutableBinary, npmPrefixCandidates, pinnedBinaryCandidates, resolvePinnedBinary, type BinarySearchOptions } from './host/binary-path.js';
import { BUILTIN_API_KEY_PROVIDERS, BUILTIN_DECLARATIONS, builtinBinaries, builtinProviderIds } from './backends/builtin-declarations.js';
import { activeProfiles, authStatusNow, installedProfiles } from './backends/registry.js';
import { usableProviders } from './backends/usable.js';
import { isRemoteDialect } from './backends/types.js';
import type { DoctorReport, BinaryReport, BinaryProvider, ProviderAuthReport } from './plugins/contract/system.js';
export type { DoctorReport, BinaryReport, BinaryProvider, ProviderAuthReport } from './plugins/contract/system.js';

/**
 * Binaries TIMON invokes. `required` = the orchestrator can't do anything
 * without it. `git` is not: without it Timon runs and the Kanban runs, only
 * the git modules switch off and the git tasks of a git project are refused
 * (TODO #275) — `modules` says so, a global blocker would contradict it.
 */
export type DoctorBinary = { readonly name: string; readonly required?: true; readonly backend?: true };

/** The AI CLIs of the product's own providers, as they declare them (C1), in the order the product lists them. */
const PROVIDER_BINARIES: readonly DoctorBinary[] = builtinBinaries().map((binary) => ({ name: binary.names[0]!, backend: true as const }));

export const BINARIES: readonly DoctorBinary[] = [
  { name: 'node', required: true },
  { name: 'git' },
  ...PROVIDER_BINARIES,
  { name: 'gh' },
  { name: 'docker' },
  { name: 'grepai' },
  { name: 'uvx' },
  { name: 'tar' },
];

/** The closed list the onboarding route validates against (step 5.7.3): a
 *  prerequisite Timon does not itself invoke is not one Timon installs. */
export const BINARY_NAMES: readonly string[] = BINARIES.map((b) => b.name);

/**
 * Resolves a binary the same way the Host Adapter will: explicit pinning in
 * `config.host.binaries` first, PATH next. We walk PATH ourselves rather than
 * calling `which`, absent on Windows.
 */
export function whichBin(
  name: string,
  pins: Record<string, string | null> = {},
  options: BinarySearchOptions = {},
): { path: string | null; pinned: boolean } {
  const pinned = pins[name];
  if (typeof pinned === 'string' && pinned) {
    return { path: resolvePinnedBinary(name, pinned, options), pinned: true };
  }
  return { path: findExecutableBinary(name, options), pinned: false };
}

/**
 * What `docker info --format {{.ServerVersion}}` says of the daemon. The exit
 * code alone is not enough: Docker 26 exits 0 when the daemon is unreachable,
 * printing the error on stderr and an empty version, and the doctor then
 * called a stopped daemon usable. A daemon that answers always has a version.
 */
export function dockerInfoVerdict(r: { code: number | null; stdout: string; stderr: string }): { usable: boolean; detail: string } {
  const version = r.stdout.trim();
  if (r.code === 0 && version) return { usable: true, detail: `server ${version}` };
  return { usable: false, detail: r.stderr.trim().split('\n')[0] || 'daemon unreachable' };
}

function dockerUsable(bin: string | null): { present: boolean; usable: boolean; detail: string } {
  if (!bin) return { present: false, usable: false, detail: 'binary absent' };
  // `docker info`, not `docker --version`: a client installed without a
  // reachable daemon (common on macOS) answers the version query just fine.
  const r = getHost().exec(bin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 10_000 });
  return { present: true, ...dockerInfoVerdict(r) };
}

/** The host adapter's probe (`host/systemd.ts`), the one place that runs `systemctl`. */
export function systemdPresent(): boolean {
  return hasSystemd();
}

/** The environment the main agent's first mission will see its credentials in. */
export function mainAgentAuthEnv(): NodeJS.ProcessEnv {
  // Setup checks the identity that will receive the first user message.
  // Only the raw config: `getAgent` would resolve the agent's default backend,
  // which asks the sign-in state, which calls this function (TIM-0119).
  const agentName = mainAgentNameOrSeed();
  const agent = loadConfig(agentName);
  return inheritEnvEnabled()
    ? process.env
    : { ...systemEnv(), ...secretsEnvFor({ agent: agentName, project: agent.project ?? projectFromCwd(agent.cwd ?? undefined) ?? null }) };
}

/** C4 for the providers that answer synchronously, which is what a diagnostic can wait for. */
/** The provider whose canonical binary is `name`, for the first-run cards. */
function providerOf(name: string): BinaryProvider | undefined {
  const entry = Object.entries(BUILTIN_DECLARATIONS).find(([, declared]) => declared.binary?.names[0] === name);
  if (!entry) return undefined;
  const [id, declared] = entry;
  return {
    id,
    label: declared.setupCard?.label ?? installedProfiles().find((profile) => profile.id === id)?.label ?? id,
    brand: installedProfiles().find((profile) => profile.id === id)?.brand ?? null,
    order: declared.setupCard?.order ?? Number.MAX_SAFE_INTEGER,
    suggested: declared.setupCard?.suggested === true,
    seedsMainAgent: declared.seedsMainAgent === true,
  };
}

function providerAuth(env: NodeJS.ProcessEnv): ProviderAuthReport[] {
  return builtinProviderIds().flatMap((provider) => {
    const binary = BUILTIN_DECLARATIONS[provider]?.binary?.names[0];
    const status = binary ? authStatusNow(provider, env as Readonly<Record<string, string>>) : null;
    if (!binary || !status) return [];
    return [{ provider, binary, ok: status.ok, detail: status.detail, signInCommand: status.signInCommand, path: status.path ?? null, source: status.source ?? null }];
  });
}

/** The seat as `DoctorReport.mainSeat` describes it. Read-only: electing is the daemon's job (`main-seat.ts`). */
export function doctorMainSeat(): DoctorReport['mainSeat'] {
  try {
    if (mainAgentOnboardingPending() || listAgents().length === 0) return null;
    return mainSeatState();
  } catch {
    // A diagnostic that cannot read the agents still reports the rest.
    return null;
  }
}

export function diagnose(): DoctorReport {
  const cfg = config();
  const pins = cfg.host.binaries;
  const authEnv = mainAgentAuthEnv();
  const auth = providerAuth(authEnv);

  const linux = process.platform === 'linux' ? linuxRelease(readOsRelease()) : null;
  const machine = { platform: process.platform, packageManager: linux?.packageManager ?? null };

  const binaries: BinaryReport[] = BINARIES.map((b) => {
    const { path, pinned } = whichBin(b.name, pins);
    const pin = pins[b.name];
    const provider = providerOf(b.name);
    return {
      name: b.name,
      ...(provider ? { provider } : {}),
      path,
      ok: path !== null,
      pinned,
      attemptedPaths: pin ? pinnedBinaryCandidates(b.name, pin)
        : [...binaryCandidates(b.name), ...(path ? [] : npmPrefixCandidates(b.name))],
      ...(pinned && !path ? { error: `host.binaries.${b.name} does not point to an executable file: ${pins[b.name]}` } : {}),
      installCommand: installCommandFor(b.name, machine),
    };
  });
  const found = (n: string) => binaries.find((b) => b.name === n)?.path ?? null;
  for (const nodeless of nodelessBackends(PROVIDER_BINARIES.map((b) => b.name), { platform: process.platform, resolve: found })) {
    const report = binaries.find((b) => b.name === nodeless.name);
    if (report) report.warning = nodelessBackendText(nodeless);
  }

  const systemd = systemdPresent();
  const docker = dockerUsable(found('docker'));
  const display = process.env.DISPLAY || process.env.WAYLAND_DISPLAY || null;

  const capabilities: string[] = getHost().capabilities();
  const modules = moduleNotes(capabilities);

  const { report: missionIsolation, blocker: isolationBlocker } = missionIsolationNow(cfg);

  const free = freeBytes(TIMON_HOME);
  const storage = { path: TIMON_HOME, freeBytes: free, low: free !== null && free < LOW_DISK_BYTES };

  const backends = BINARIES.filter((b) => 'backend' in b && b.backend).map((b) => b.name);
  const blockers: string[] = [];
  for (const b of BINARIES) {
    if ('required' in b && b.required && !found(b.name)) blockers.push(`${b.name} not found`);
  }
  // An agent reached over the network needs no CLI on this machine.
  const remoteBackend = activeProfiles().some(({ dialect }) => isRemoteDialect(dialect));
  // A provider plugin's own CLI counts too: its name is in no fixed list.
  if (!remoteBackend && !backends.some((n) => found(n)) && usableProviders().length === 0) {
    blockers.push(`no LLM backend installed (${backends.join(', ')})`);
  }
  // `enforce` refuses every mission it cannot fence: nothing works until fixed.
  // In `auto` it is a warning, never a blocker.
  if (isolationBlocker) blockers.push(isolationBlocker);
  if (cfg.host.docker === 'required' && !docker.usable) {
    blockers.push(`host.docker is "required" but Docker is unusable (${docker.detail})`);
  }

  return {
    platform: process.platform,
    home: homedir(),
    profile: cfg.profile,
    edition: cfg.edition,
    timonHome: TIMON_HOME,
    configFile: { path: CONFIG_FILE, present: existsSync(CONFIG_FILE) },
    binaries,
    auth,
    apiKeyProviders: BUILTIN_API_KEY_PROVIDERS.map((entry) => {
      const via = BUILTIN_DECLARATIONS[entry.via]?.binary?.names[0] ?? entry.via;
      return { ...entry, via, viaLabel: via.charAt(0).toUpperCase() + via.slice(1) };
    }),
    systemd,
    supervisor: supervisorFor(process.platform, {
      systemd,
      windowsTaskRefused: process.platform === 'win32' && existsSync(windowsServiceFiles(TIMON_HOME, join).refused),
    }),
    linux,
    docker,
    display,
    missionIsolation,
    storage,
    mainSeat: doctorMainSeat(),
    capabilities,
    modules,
    blockers,
    ok: blockers.length === 0,
  };
}

/**
 * The isolation report of this daemon, now. Read off the host adapter, never
 * off `host/linux.ts`: `doctor` runs on every platform, and a host that
 * declares no fence fences nothing.
 */
export function missionIsolationNow(cfg: TimonConfig = config()): ReturnType<typeof missionIsolationReport> {
  const host = getHost();
  const configured = cfg.host.isolation.filesystem;
  return missionIsolationReport({
    configured,
    status: configured === 'off' ? null : hostFenceStatus(host.fence),
    mechanism: host.fence?.mechanism ?? null,
    platform: process.platform,
    isolation: cfg.host.isolation,
    launcher: host.isolation?.launcher ?? null,
    maskedPaths: configured === 'off' ? 0 : resolveIsolation(cfg, { timonHome: TIMON_HOME }).deny.length,
  });
}

/** What the missing capabilities cost, module by module (see `DoctorReport.modules`). */
export function moduleNotes(capabilities: readonly string[]): string[] {
  const have = new Set(capabilities);
  return CATALOG.flatMap((m) => {
    const missing = (m.requires ?? []).filter((c) => !have.has(c));
    if (missing.length) return [`${m.id} off: host capability unavailable: ${missing.join(', ')}`];
    const warning = degradation(m, have);
    return warning ? [`${m.id} reduced: ${warning}`] : [];
  });
}

function mainSeatLine(seat: NonNullable<DoctorReport['mainSeat']>): string {
  if (seat.holder) return seat.holder;
  const who = seat.candidates.length > 0
    ? `eligible: ${seat.candidates.join(', ')}; run "timon agent set-main <name>", or choose "Set as main orchestrator" on one in Agents`
    : 'no project-less orchestrator exists; create one in Agents';
  return `NONE — recaps and notifications have no recipient (${who})`;
}

export type MissionIsolationInput = {
  configured: 'auto' | 'enforce' | 'off';
  /** What `hostFenceStatus` says of the host's fence; null when the configuration turned it off. */
  status: FenceStatus | null;
  /** The host's fence mechanism; null on an OS without one. */
  mechanism: FenceMechanism | null;
  platform: NodeJS.Platform;
  isolation: Pick<TimonConfig['host']['isolation'], 'unixSockets' | 'writable' | 'exceptions'>;
  launcher: string | null;
  maskedPaths: number;
};

/** What every unfenced mission can reach, said the same way wherever it applies. */
const UNFENCED_CONSEQUENCE = "A mission can read Timon's private files, including the operator token and the vault key: "
  + 'on a multi-account install, account permissions do not hold against a mission.';

/** Landlock confines signals from ABI 6: before it, a mission may signal any process of the user. */
const LANDLOCK_SIGNAL_SCOPE_ABI = 6;

/** Why a mission is not fenced on this OS when the host has no fence at all. */
function noFenceReason(platform: NodeJS.Platform, status: FenceStatus): string {
  return platform === 'win32' ? 'no mission fence on Windows yet' : status.state === 'ready' ? 'no mission fence on this OS' : status.reason;
}

/**
 * What the fence leaves open, one line each. Only meaningful while missions
 * are fenced: an unfenced mission reaches everything and the warning says so.
 */
function fenceGaps(input: MissionIsolationInput, mechanism: 'landlock' | 'seatbelt', abi: number): string[] {
  const gaps: string[] = [];
  if (mechanism === 'landlock' && abi === 2) gaps.push('partial: kernel ABI 2 — a mission can truncate files it cannot read.');
  if (mechanism === 'landlock' && abi < LANDLOCK_SIGNAL_SCOPE_ABI) {
    gaps.push(`partial: kernel ABI ${abi} — a mission can send signals to processes outside its fence (ABI ${LANDLOCK_SIGNAL_SCOPE_ABI} confines them).`);
  }
  const iso = input.isolation;
  if (iso.unixSockets === 'allow') {
    gaps.push('unix sockets allowed for every mission (host.isolation.unixSockets): a mission reaches Docker, ssh-agent and the session bus, which act outside the fence.');
  }
  if (iso.writable.length > 0) {
    gaps.push(`${iso.writable.length} extra writable path(s) in the home for every mission (host.isolation.writable).`);
  }
  for (const [kind, entries] of [['agent', iso.exceptions.agents], ['project', iso.exceptions.projects]] as const) {
    for (const name of Object.keys(entries).sort()) {
      const entry = entries[name]!;
      const opened: string[] = [];
      if (entry.unixSockets === 'allow' && iso.unixSockets !== 'allow') opened.push('unix sockets allowed');
      if (entry.writable.length > 0) opened.push(`${entry.writable.length} extra writable path(s)`);
      if (opened.length > 0) gaps.push(`exception for ${kind} "${name}": ${opened.join(', ')}.`);
    }
  }
  return gaps;
}

/**
 * The isolation part of the report, and the blocker it raises. Never reads
 * as protection when there is none: a mission launched unfenced is a NOT
 * enforced line with its cause and what it exposes; `enforce` without a
 * fence is a blocker, `auto` a warning; an altered launcher is said apart.
 */
export function missionIsolationReport(input: MissionIsolationInput): {
  report: DoctorReport['missionIsolation'];
  blocker: string | null;
} {
  const { configured, status } = input;
  const exceptions = {
    agents: Object.keys(input.isolation.exceptions.agents).sort(),
    projects: Object.keys(input.isolation.exceptions.projects).sort(),
  };
  const base = {
    configured,
    unixSockets: input.isolation.unixSockets,
    exceptions,
    launcher: input.launcher,
    maskedPaths: input.maskedPaths,
  };
  if (configured === 'off' || status === null) {
    return {
      report: {
        ...base, mechanism: 'none', abi: 0, enforced: false, state: 'off', launch: 'unfenced', gaps: [],
        reason: 'turned off by host.isolation.filesystem',
        message: `NOT enforced — turned off (host.isolation.filesystem: "off"). ${UNFENCED_CONSEQUENCE} Set host.isolation.filesystem to "auto" to fence missions where this machine can.`,
      },
      blocker: null,
    };
  }
  if (status.state === 'ready' && input.mechanism) {
    const mechanism = input.mechanism;
    const how = mechanism === 'landlock'
      ? `landlock ABI ${status.abi}${input.isolation.unixSockets === 'deny' ? ' + unix-socket filter' : ''}`
      : 'seatbelt';
    return {
      report: {
        ...base, mechanism, abi: mechanism === 'landlock' ? status.abi : 0, enforced: true, state: 'ready', launch: 'fenced',
        reason: null,
        message: `enforced (${how}): missions cannot read Timon's private files.`,
        gaps: fenceGaps(input, mechanism, status.abi),
      },
      blocker: null,
    };
  }
  // `hostFenceStatus` never says ready without a fence; read such a case as none.
  const unready: Exclude<FenceStatus, { state: 'ready' }> = status.state === 'ready'
    ? { state: 'unsupported', reason: noFenceReason(input.platform, status), abi: 0 }
    : input.mechanism === null ? { ...status, reason: noFenceReason(input.platform, status) } : status;
  const { reason } = unready;
  const tampered = unready.state === 'tampered';
  const decision = fenceLaunchDecision(configured, unready);
  const cause = tampered ? `ALTERED: ${reason}. The Timon package may have been altered: reinstall it.` : `${reason}.`;
  const refused = decision.action === 'refuse';
  const message = refused
    ? `NOT enforced — ${cause} host.isolation.filesystem is "enforce": every mission is refused until this is fixed.`
    : `NOT enforced — ${cause} ${UNFENCED_CONSEQUENCE} Set host.isolation.filesystem to "enforce" to refuse launching unconfined missions.`;
  return {
    report: {
      ...base, mechanism: 'none', abi: unready.abi, enforced: false, state: tampered ? 'tampered' : 'unsupported',
      launch: refused ? 'refused' : 'unfenced', reason, message, gaps: [],
    },
    blocker: refused ? decision.error : null,
  };
}

/**
 * The older systemd masking, shown only while no fence applies: there it is
 * the one thing configured, and it must read INERT when the launcher emits
 * nothing. Where the fence applies the line goes away, the fence covers it.
 */
function maskingLine(iso: DoctorReport['missionIsolation']): string | null {
  if (iso.enforced || iso.configured === 'off') return null;
  const where = iso.launcher ? `${iso.launcher} launcher` : 'no launcher isolation on this host';
  return `INERT — ${iso.maskedPaths} path(s) in the policy, NONE masked today (${where}; docs/SECURITY.md §9.1)`;
}

/** Text rendering of the diagnostic — the output of `timon doctor` without `--json`. */
export function formatDoctor(r: DoctorReport): string {
  const width = Math.max(...r.binaries.map((b) => b.name.length));
  const lines = [
    `Timon doctor — ${r.platform}, profile ${r.profile}, edition ${r.edition}`,
    `TIMON_HOME        ${r.timonHome}`,
    `timon.config.json ${r.configFile.present ? r.configFile.path : `absent (${r.configFile.path}) — defaults applied`}`,
    '',
    'binary'.padEnd(width) + '  ok  path',
  ];
  for (const b of r.binaries) {
    lines.push(
      b.name.padEnd(width)
      + `  ${b.ok ? ' ✓' : ' ✗'}  ${b.path ?? '—'}${b.pinned ? '  (pinned in timon.config.json)' : ''}`,
    );
    if (b.error) lines.push(`  ${b.error}`);
    if (b.warning) lines.push(`  ${b.warning}`);
  }
  lines.push('');
  for (const auth of r.auth) {
    const name = auth.binary.charAt(0).toUpperCase() + auth.binary.slice(1);
    lines.push(`${name} credentials ${auth.ok ? 'available' : 'MISSING'}${auth.path ? ` — ${auth.path}` : ''}`, auth.detail);
  }
  lines.push(
    `systemd (user)   ${r.systemd ? 'present' : 'absent'}`,
    `supervisor       ${r.supervisor ?? 'none available — portable mode only'}`,
    `distribution     ${r.linux ? `${r.linux.prettyName ?? r.linux.id ?? 'unknown'} (${r.linux.packageManager ?? 'no known package manager'})` : 'n/a'}`,
    `docker           ${r.docker.usable ? `usable — ${r.docker.detail}` : `unusable — ${r.docker.detail}`}`,
    `graphical session ${r.display ?? 'none (DISPLAY/WAYLAND_DISPLAY empty)'}`,
    `mission isolation ${r.missionIsolation.message}`,
    ...r.missionIsolation.gaps.map((gap) => `  ${gap}`),
  );
  const masking = maskingLine(r.missionIsolation);
  if (masking) lines.push(`mission FS masking ${masking}`);
  lines.push(
    `free disk space  ${r.storage.freeBytes === null ? 'unknown' : formatBytes(r.storage.freeBytes)}${r.storage.low ? ' — LOW: the database may fail to write' : ''}`,
    '',
    `capabilities     ${r.capabilities.join(', ') || 'none'}`,
  );
  if (r.mainSeat) lines.push(`main orchestrator ${mainSeatLine(r.mainSeat)}`);
  if (r.modules.length) {
    lines.push('', 'modules limited by this machine:');
    for (const note of r.modules) lines.push(`  - ${note}`);
  }
  // Not a blocker in `auto` or `off`, but never a line lost in the middle.
  if (!r.missionIsolation.enforced && r.missionIsolation.launch !== 'refused') {
    lines.push('', 'WARNING:', `  - mission isolation ${r.missionIsolation.message}`);
  }
  if (r.blockers.length) {
    lines.push('', 'BLOCKING:');
    for (const b of r.blockers) {
      const missing = r.binaries.find((x) => !x.ok && b.startsWith(`${x.name} `));
      lines.push(`  - ${b}${missing?.installCommand ? `  →  ${missing.installCommand}` : ''}`);
    }
  } else {
    lines.push('', 'Nothing missing at the essential level (node, git, an LLM backend).');
  }
  return lines.join('\n') + '\n';
}
