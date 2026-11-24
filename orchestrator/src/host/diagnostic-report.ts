/**
 * The diagnostic report a tester pastes in one go (TODO #343): versions, how
 * the daemon runs, its service and ports, named findings, and the newest log
 * lines. Built the same way from the desktop's error boxes (through
 * `diagnostic-report-runner.ts`, daemon down or not), from Settings › System
 * and from `timon doctor --report`.
 *
 * Never imports the database: the desktop runs it while the daemon cannot
 * start, or waits for an update approval that `db.ts` would refuse (I7 of the
 * packaged-OS audit). Everything secret is masked before the text leaves —
 * file values, known token shapes, the daemon's vault when it runs there.
 * Licence: its state only, never how it is checked.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { arch, release, userInfo, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../config/load.js';
import type { TimonConfig } from '../config/schema.js';
import { compareVersions, readDataVersion, readSnapshotFailure, timonVersion } from '../data-version.js';
import { localTimestamp, logDir, parseDatedLog, readRecentLines, servicePauseLogFile, supervisorLogFile, tailLines } from '../log-file.js';
import { redactText } from '../secrets/redact.js';
import { createGenericHost } from './generic.js';
import { builtinBinaries } from '../backends/builtin-declarations.js';
import { packagedRuntime } from './bundled-node.js';
import { findExecutableBinary, resolvePinnedBinary } from './binary-path.js';
import { nodelessBackends, nodelessBackendText, type NodelessBackend } from './launch-path.js';
import { inspectListenPort, type ListenPortState } from './listen-port.js';
import { linuxRelease, readOsRelease, windowsJoin, type WindowsJoin } from './machine.js';
import { orphanServices, orphanServiceText, type OrphanService } from './orphan-services.js';
import { instanceId } from './packaged-service.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import {
  LINUX_UNIT, MACOS_LABEL, readServiceDefinition, serviceDiagnostics, statusService, WINDOWS_SERVICE_REVISION, WINDOWS_TASK,
  WINDOWS_TASK_NEVER_RAN, windowsConsoleTaskAdvice, windowsConsoleTaskTrap, windowsServiceFiles, type ServiceDiagnostics, type ServiceOpts,
} from './service-install.js';
import type { Host } from './types.js';

/** Lines of each log in the report, newest first. */
export const REPORT_LOG_LINES = 100;
const MAX_LINE = 400;

export type DiagnosticSource = 'desktop' | 'daemon' | 'cli';

export type Health =
  | { kind: 'ours' }
  | { kind: 'other-timon' }
  | { kind: 'foreign'; status: number }
  | { kind: 'none'; error: string };

export type Finding = { id: string; text: string };

export type DiagnosticFacts = {
  source: DiagnosticSource;
  generatedAt: string;
  platform: NodeJS.Platform;
  /** Version of the app that asked (desktop), `null` from the CLI or the daemon. */
  appVersion: string | null;
  daemonVersion: string;
  dataVersion: string | null;
  packagedRuntime: boolean;
  home: string;
  service: { installed: boolean; running: boolean; lines: string[]; details: ServiceDiagnostics | null };
  windows: WindowsJoin | null;
  daemonPort: { origin: string; health: Health; port: ListenPortState | null };
  snapshotFailure: string | null;
  /** Windows: when the host recorded that it registered the task but never started it (#342). */
  serviceRefused?: string | null;
  /** Daemon only: it runs as the service on the app's runtime without the marker. */
  runningUnmarked?: boolean;
  /** AI CLIs found here that run on Node while no node is reachable for their missions. */
  nodelessBackends?: NodelessBackend[];
  /** Timon services of this account whose data directory is gone (#464). */
  orphanServices?: OrphanService[];
};

/** One line per known trap, in the tester's words; empty when none applies. */
export function diagnosticFindings(facts: DiagnosticFacts): Finding[] {
  const findings: Finding[] = [];
  const details = facts.service.details;
  if (facts.runningUnmarked || (facts.packagedRuntime && facts.service.installed && details?.marked === false)) {
    findings.push({
      id: 'unmarked-service',
      text: 'The Timon service was installed without the app\'s marker (TIM-0087): it skips the update approval and the data copy. '
        + 'Reopen Timon to let it rewrite the service, or run `timon service install` from the app\'s terminal.',
    });
  }
  if (facts.platform === 'win32' && facts.service.installed && details?.lastTaskResult === WINDOWS_TASK_NEVER_RAN) {
    const entra = facts.windows?.azureAdJoined === true;
    findings.push({
      id: 'windows-task-never-ran',
      text: `The ${WINDOWS_TASK} scheduled task has never run (last result 0x41303).`
        + (entra
          ? ' This PC is joined to Microsoft Entra ID: Windows may refuse to start the task for this account (#342). '
            + 'Workaround: run `timon service uninstall`, then reopen Timon, which then runs its own daemon.'
          : ' Check that it is enabled in Task Scheduler, or reinstall it with `timon service install`.'),
    });
  } else if (facts.platform === 'win32' && facts.serviceRefused) {
    // The install removes a task that never starts, so 0x41303 is gone with
    // it: only the marker still says why Timon runs its built-in daemon.
    findings.push({
      id: 'windows-service-refused',
      text: `Windows has refused to start the ${WINDOWS_TASK} scheduled task for this account (recorded ${facts.serviceRefused}, #342): `
        + 'Timon runs its built-in daemon, which stops when the app closes or the session ends.'
        + (facts.windows?.azureAdJoined === true ? ' This PC is joined to Microsoft Entra ID, which explains it.' : '')
        + (facts.service.installed ? ' Remove the task that will not run with `timon service uninstall`.' : ''),
    });
  }
  const shape = details?.shape;
  if (facts.platform === 'win32' && facts.service.installed && shape && windowsConsoleTaskTrap(shape, facts.packagedRuntime)) {
    findings.push({ id: 'windows-task-console', text: `A console window opens on this PC (#116): the task ${windowsConsoleTaskAdvice(shape)}` });
  }
  const expected = facts.appVersion ?? facts.daemonVersion;
  if (facts.dataVersion && compareVersions(facts.dataVersion, expected) === -1) {
    findings.push({
      id: 'data-version-behind',
      text: `The data were last opened by Timon ${facts.dataVersion}, this is ${expected}: `
        + `no daemon of ${expected} has opened them yet (an update waiting for approval, or a service still running an older release).`,
    });
  }
  const { health, port, origin } = facts.daemonPort;
  if (health.kind === 'other-timon') {
    findings.push({ id: 'port-other-timon', text: `${origin} is answered by Timon of another data directory, not by ${facts.home}.` });
  } else if (health.kind === 'foreign') {
    findings.push({ id: 'port-foreign', text: `${origin} is held by another program (HTTP ${health.status}), not Timon${port && !port.available ? ` — ${port.detail}` : ''}.` });
  } else if (health.kind === 'none' && port && !port.available) {
    // A Timon (or Node) process that holds the port without replying is a
    // daemon still booting or stuck in a long synchronous task, not an
    // intruder: say so, or the reader kills it and starts over (21/10/2026).
    findings.push(/\[(timon(\.exe)?|node|electron)\]/i.test(port.detail)
      ? { id: 'port-held', text: `Nothing answers on ${origin}, yet a Timon process holds its port (${port.detail}): `
        + 'the daemon is still starting, or busy with a long task. Wait a few minutes and run this diagnostic again; '
        + 'if it persists, the end of the daemon log says what it was doing.' }
      : { id: 'port-held', text: `Nothing answers on ${origin}, yet its port is taken — ${port.detail}.` });
  } else if (health.kind === 'none') {
    findings.push({ id: 'daemon-down', text: `Nothing answers on ${origin}: the daemon is not running.` });
  }
  for (const backend of facts.nodelessBackends ?? []) {
    findings.push({ id: `node-missing-${backend.name}`, text: nodelessBackendText(backend) });
  }
  for (const orphan of facts.orphanServices ?? []) {
    findings.push({ id: `orphan-service-${orphan.name}`, text: orphanServiceText(orphan) });
  }
  if (facts.snapshotFailure) {
    findings.push({ id: 'snapshot-failure', text: `The last data copy before an update failed: ${facts.snapshotFailure}` });
  }
  return findings;
}

/** The daemon's public probe, read as the desktop reads it (`desktop/src/health.ts`). */
export async function probeDaemon(origin: string, home: string, timeoutMs = 1500): Promise<Health> {
  try {
    const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
    const body = await res.json().catch(() => null) as { service?: unknown; instance?: unknown } | null;
    if (!res.ok || body?.service !== 'timon') return { kind: 'foreign', status: res.status };
    return body.instance === instanceId(home) ? { kind: 'ours' } : { kind: 'other-timon' };
  } catch (error) {
    return { kind: 'none', error: probeFailureReason(error) };
  }
}

/**
 * Why the probe got nothing. `fetch` hides the cause in `cause.code` behind a
 * uniform "fetch failed"; the report must tell "nothing listens" from "a
 * daemon holds the port and does not reply". Same wording as
 * `desktop/src/health.ts` (two packages, no shared module).
 */
export function probeFailureReason(e: unknown): string {
  const error = e as { name?: string; message?: string; cause?: { code?: string; message?: string; errors?: { code?: string }[] } } | null;
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
    return 'connected, but no reply in time: the daemon is still starting, or busy';
  }
  // `localhost` resolves to two addresses: undici then wraps both failures in
  // an AggregateError whose own `code` is empty.
  const cause = error?.cause;
  const code = cause?.code ?? cause?.errors?.find((inner) => inner?.code)?.code
    ?? /\b(E[A-Z]{3,})\b/.exec(cause?.message ?? '')?.[1];
  if (code === 'ECONNREFUSED') return 'connection refused: nothing listens on the port';
  if (code === 'ECONNRESET') return 'connection reset: the daemon closed it without replying';
  if (code) return `${code}: ${error?.message ?? ''}`.trim();
  return error?.message ?? 'unknown';
}

/** Secret files of a home: their values are masked wherever they show up. */
const SECRET_FILES = [
  'daemon-token', 'plugin-token-key', 'secret-key', 'secret-key.next', 'license.jwt', 'license.key',
  'license.enrollment-secret', 'device-id', 'install-id', 'update-token',
];

export function knownSecretValues(home: string): string[] {
  const values: string[] = [];
  for (const name of SECRET_FILES) {
    try { values.push(readFileSync(join(home, name), 'utf8').trim()); } catch { /* absent */ }
  }
  try {
    for (const line of readFileSync(join(home, 'secrets.env'), 'utf8').split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
      if (match) values.push(match[1]!.trim().replace(/^(['"])(.*)\1$/, '$2'));
    }
  } catch { /* absent */ }
  return values.filter((value) => value.length >= 8);
}

const TOKEN_SHAPES: readonly [RegExp, string][] = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
  [/\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, '***'],
  [/\b(?:sk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abpr]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{16,})/g, '***'],
  [/((?:token|secret|password|passwd|api[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"'&,;]{6,}/gi, '$1***'],
  [/([?&](?:token|key|secret|password|code|sig|signature|access_token)=)[^&\s"']+/gi, '$1***'],
  [/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)\b/g, '***@$1'],
];

/** Masks known values, then known token shapes, then the daemon's vault values. */
export function redactReport(text: string, values: readonly string[]): string {
  let out = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) out = out.split(value).join('***');
  for (const [pattern, replacement] of TOKEN_SHAPES) out = out.replace(pattern, replacement);
  return redactText(out);
}

function osLine(platform: NodeJS.Platform): string {
  let name: string | null = null;
  try {
    name = platform === 'linux' ? linuxRelease(readOsRelease())?.prettyName ?? null : osVersion() || null;
  } catch { /* unknown */ }
  return [name, release(), arch()].filter(Boolean).join(' · ');
}

function logFiles(dir: string): string {
  try {
    const files = readdirSync(dir).filter((name) => parseDatedLog(name) || name.startsWith('daemon.log'));
    const total = files.reduce((sum, name) => {
      try { return sum + statSync(join(dir, name)).size; } catch { return sum; }
    }, 0);
    return `${files.length} file(s), ${(total / 1024 / 1024).toFixed(1)} MB`;
  } catch {
    return 'folder absent';
  }
}

function clip(line: string): string {
  return line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…` : line;
}

function healthLine(health: Health): string {
  switch (health.kind) {
    case 'ours': return 'Timon, this data directory';
    case 'other-timon': return 'Timon of ANOTHER data directory';
    case 'foreign': return `another program (HTTP ${health.status})`;
    case 'none': return `no answer (${health.error})`;
  }
}

/** Where a local client reaches the daemon: a wildcard bind is reached on the loopback. */
export function daemonOrigin(cfg: Pick<TimonConfig, 'daemon'>): string {
  const host = cfg.daemon.listen.host === '0.0.0.0' || cfg.daemon.listen.host === '::' ? '127.0.0.1' : cfg.daemon.listen.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${cfg.daemon.listen.port}`;
}

export type CollectOptions = {
  source: DiagnosticSource;
  home: string;
  cfg: TimonConfig;
  host: Pick<Host, 'platform' | 'execAsync'>;
  /** Built by `serviceOptsFromEnvironment`: the service as the CLI would install it. */
  serviceOpts: ServiceOpts;
  appVersion: string | null;
  daemonVersion: string;
  /** What the daemon side knows that a file cannot say (mode, licence state). */
  sections?: { title: string; lines: string[] }[];
  /** Lines of `timon doctor`, or `null` when it could not run. */
  doctor?: () => Promise<string[] | null>;
  runningUnmarked?: boolean;
  /** Text shown to the user just before (the desktop's error box). */
  error?: string;
  now?: Date;
};

/** Gathers the facts and renders the redacted report. Never throws on a missing tool or file. */
export async function buildDiagnosticReport(opts: CollectOptions): Promise<{ text: string; findings: Finding[] }> {
  const platform = opts.serviceOpts.platform;
  const now = opts.now ?? new Date();
  const listen = opts.cfg.daemon.listen;
  const origin = daemonOrigin(opts.cfg);

  let status: { installed: boolean; running: boolean; lines: string[] } = { installed: false, running: false, lines: [] };
  let details: ServiceDiagnostics | null = null;
  try {
    const result = statusService(opts.serviceOpts);
    status = { installed: result.installed === true, running: result.ok, lines: result.reason && !result.lines.includes(result.reason) ? [...result.lines, result.reason] : result.lines };
    if (status.installed) details = serviceDiagnostics(opts.serviceOpts);
  } catch (error) {
    status.lines = [`status unavailable: ${(error as Error).message}`];
  }
  const windows = platform === 'win32' ? windowsJoin(opts.serviceOpts.exec) : null;
  const health = await probeDaemon(origin, opts.home);
  const inspect = async (address: string, port: number): Promise<ListenPortState | null> => {
    try { return await inspectListenPort(opts.host, address, port); } catch { return null; }
  };
  const daemonPort = health.kind === 'ours' ? null : await inspect(listen.host, listen.port);
  const appPort = opts.cfg.app.enabled ? await inspect(opts.cfg.app.listen.host, opts.cfg.app.listen.port) : null;
  const snapshot = readSnapshotFailure(opts.home);
  const refused = platform === 'win32' ? readServiceRefused(opts.home) : null;
  const nodeless = platform === process.platform ? nodelessHere(opts.cfg) : [];
  const orphans = platform === process.platform ? orphanServices({
    platform,
    homeDir: opts.serviceOpts.homeDir,
    uid: opts.serviceOpts.uid,
    launchDaemonsDir: opts.serviceOpts.launchDaemonsDir,
    readWindowsTask: () => readServiceDefinition(opts.serviceOpts),
  }) : [];

  const facts: DiagnosticFacts = {
    source: opts.source,
    generatedAt: localTimestamp(now),
    platform,
    appVersion: opts.appVersion,
    daemonVersion: opts.daemonVersion,
    dataVersion: readDataVersion(opts.home),
    packagedRuntime: packagedRuntime(),
    home: opts.home,
    service: { ...status, details },
    windows,
    daemonPort: { origin, health, port: daemonPort },
    snapshotFailure: snapshot ? `${snapshot.version}: ${snapshot.message}` : null,
    serviceRefused: refused,
    runningUnmarked: opts.runningUnmarked,
    nodelessBackends: nodeless,
    orphanServices: orphans,
  };
  const findings = diagnosticFindings(facts);
  const doctor = opts.doctor ? await opts.doctor().catch((error: unknown) => [`doctor failed: ${(error as Error).message}`]) : null;

  let account = '';
  try { account = userInfo().username; } catch { /* unknown */ }
  const dir = logDir(opts.home);
  const out: string[] = [];
  const section = (title: string, lines: string[]): void => {
    out.push('', `== ${title} ==`, ...(lines.length ? lines : ['(nothing)']));
  };
  out.push(`Timon diagnostic report — ${facts.generatedAt} (from the ${opts.source === 'desktop' ? 'desktop app' : opts.source === 'cli' ? 'terminal' : 'daemon'})`);
  out.push('Paste it whole: tokens and secrets are masked. Logs are newest first.');
  if (opts.error) section('Error shown', opts.error.split(/\r?\n/).filter(Boolean));
  section('Findings', findings.length ? findings.map((finding) => `- ${finding.text}`) : ['- none detected']);
  section('Versions', [
    ...(opts.appVersion ? [`app       ${opts.appVersion}`] : []),
    `daemon    ${opts.daemonVersion}`,
    `data      ${facts.dataVersion ?? 'none recorded'}`,
    `runtime   Node ${process.versions.node}${process.versions.electron ? `, Electron ${process.versions.electron}` : ''}`,
  ]);
  section('System', [
    `os        ${platform} · ${osLine(platform)}`,
    `user      ${account}${windows?.account ? ` (${windows.account})` : ''}`,
    ...(windows ? [`joined    Entra ID: ${yesNo(windows.azureAdJoined)}, domain: ${yesNo(windows.domainJoined)}, workplace: ${yesNo(windows.workplaceJoined)}`] : []),
    `home      ${opts.home}`,
    `install   ${opts.cfg.daemon.installDir}`,
    // Only the daemon's own markers mean something; a runner's are set by its caller.
    ...(opts.source === 'daemon' ? [`markers   TIMON_DESKTOP_EMBEDDED=${process.env.TIMON_DESKTOP_EMBEDDED ?? '-'} TIMON_DESKTOP_SERVICE=${process.env.TIMON_DESKTOP_SERVICE ?? '-'}`] : []),
    `logs      ${dir} — ${logFiles(dir)}`,
  ]);
  section('Daemon', [
    `expected  ${origin} (supervisor in config: ${opts.cfg.daemon.supervisor})`,
    `answer    ${healthLine(health)}`,
    ...(daemonPort ? [`port      ${daemonPort.detail}`] : []),
    ...(opts.cfg.app.enabled ? [`web app   ${opts.cfg.app.listen.host}:${opts.cfg.app.listen.port}${appPort ? ` — ${appPort.detail}` : ''}`] : ['web app   not served by the daemon']),
  ]);
  for (const extra of opts.sections ?? []) section(extra.title, extra.lines);
  section('Service', [
    `name      ${platform === 'win32' ? WINDOWS_TASK : platform === 'darwin' ? MACOS_LABEL : opts.serviceOpts.unitName ?? LINUX_UNIT}`,
    `installed ${status.installed ? 'yes' : 'no'}, running ${status.running ? 'yes' : 'no'}`,
    ...(details ? [`marker    ${details.marked === null ? 'definition not found' : details.marked ? 'TIMON_DESKTOP_SERVICE=1' : 'ABSENT'}`] : []),
    ...(platform === 'win32' && status.installed ? [`revision  ${readRevision(opts.home) ?? '—'} (expected ${WINDOWS_SERVICE_REVISION})`] : []),
    ...(refused ? [`refused   Windows never started the task for this account (recorded ${refused})`] : []),
    ...status.lines.map((line) => `  ${line}`),
    ...(details?.lines ?? []).map((line) => `  ${line}`),
  ]);
  section('Data', [facts.snapshotFailure ? `last copy failed: ${facts.snapshotFailure}` : 'no failed copy recorded']);
  if (doctor) section('Doctor', doctor);
  const tail = (lines: string[]): string[] => lines.map(clip);
  section(`Daemon log (${dir}, newest first)`, tail(readRecentLines(dir, 'daemon', REPORT_LOG_LINES)));
  section('Supervisor output daemon.log (newest first)', tail(tailLines(supervisorLogFile(opts.home), REPORT_LOG_LINES).reverse()));
  section('Desktop log (newest first)', tail(readRecentLines(dir, 'desktop', REPORT_LOG_LINES)));
  // What the last installers found running and ended: an update that left the
  // previous daemon alive is read here, not guessed from the daemon's own log.
  if (platform === 'win32') {
    section('Installer service pause timon-service-pause.log (newest first)', tail(tailLines(servicePauseLogFile(opts.home), REPORT_LOG_LINES).reverse()));
  }

  const text = redactReport(out.join('\n') + '\n', knownSecretValues(opts.home));
  return { text, findings };
}

/** Resolution as the host adapter does it: the pin of `host.binaries`, then the search. */
function nodelessHere(cfg: TimonConfig): NodelessBackend[] {
  const pins = cfg.host.binaries;
  try {
    return nodelessBackends(builtinBinaries().map((binary) => binary.names[0]!), {
      platform: process.platform,
      resolve: (name) => {
        const pin = pins[name];
        return pin ? resolvePinnedBinary(name, pin) : findExecutableBinary(name);
      },
    });
  } catch { return []; }
}

function yesNo(value: boolean | null): string {
  return value === null ? 'unknown' : value ? 'yes' : 'no';
}

function readRevision(home: string): string | null {
  try { return readFileSync(windowsServiceFiles(home, join).revision, 'utf8').trim() || null; } catch { return null; }
}

/** The date the marker holds; an empty or unreadable one still means refused. */
function readServiceRefused(home: string): string | null {
  try { return readFileSync(windowsServiceFiles(home, join).refused, 'utf8').trim() || 'date unknown'; } catch { return null; }
}

/** `timon doctor`'s essentials in a few lines, from its JSON (local or `/api/doctor`). */
export function doctorSummary(report: {
  ok?: unknown; blockers?: unknown; binaries?: unknown; supervisor?: unknown; docker?: { detail?: unknown; usable?: unknown };
}): string[] {
  const lines = [`ok        ${report.ok === true ? 'yes' : 'no'}`];
  if (Array.isArray(report.binaries)) {
    const binaries = report.binaries as { name?: unknown; ok?: unknown; path?: unknown }[];
    lines.push(`binaries  ${binaries.map((binary) => `${String(binary.name)} ${binary.ok ? '✓' : '✗'}`).join(', ')}`);
  }
  lines.push(`supervisor ${report.supervisor === null ? 'none' : String(report.supervisor ?? 'unknown')}`);
  if (report.docker) lines.push(`docker    ${report.docker.usable ? 'usable' : 'unusable'} — ${String(report.docker.detail ?? '')}`);
  if (Array.isArray(report.blockers)) for (const blocker of report.blockers) lines.push(`BLOCKING  ${String(blocker)}`);
  return lines;
}

/** The daemon's own doctor, asked over the loopback with the daemon token; never the database. */
export async function daemonDoctor(cfg: Pick<TimonConfig, 'daemon'>, home: string): Promise<string[]> {
  let token = '';
  try { token = readFileSync(join(home, 'daemon-token'), 'utf8').trim(); } catch { return ['daemon token absent: doctor skipped']; }
  try {
    const res = await fetch(`${daemonOrigin(cfg)}/api/doctor`, {
      headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return [`the daemon's doctor answered HTTP ${res.status}`];
    return doctorSummary(await res.json() as Parameters<typeof doctorSummary>[0]);
  } catch (e) {
    return [`the daemon's doctor did not answer (${(e as Error).message})`];
  }
}

/**
 * The report as a process outside the daemon builds it — the desktop's runner
 * and `timon doctor --report`: config read without writing (a broken file is
 * reported, not fatal), the generic host, the service as `timon service
 * install` would see it, the doctor of a daemon that answers.
 */
export async function reportFromEnvironment(opts: {
  source: 'desktop' | 'cli';
  home: string;
  appVersion: string | null;
  error?: string;
}): Promise<{ text: string; findings: Finding[] }> {
  let configError: string | null = null;
  let cfg: TimonConfig;
  try {
    cfg = loadConfig(undefined, { readonly: true });
  } catch (e) {
    configError = (e as Error).message;
    cfg = loadConfig(join(opts.home, 'timon.config.unreadable.json'), { readonly: true });
  }
  const host = createGenericHost(cfg);
  return buildDiagnosticReport({
    source: opts.source,
    home: opts.home,
    cfg,
    host,
    serviceOpts: serviceOptsFromEnvironment(cfg, () => host),
    appVersion: opts.appVersion,
    daemonVersion: timonVersion(),
    error: opts.error,
    sections: configError ? [{ title: 'Configuration', lines: [`timon.config.json is invalid: ${configError}`] }] : [],
    doctor: () => daemonDoctor(cfg, opts.home),
  });
}
