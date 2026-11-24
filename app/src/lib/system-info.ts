/**
 * `GET /api/admin/system` as the Settings › System › Installation pane reads
 * it. Copied from `orchestrator/src/system-info.ts`: the two packages are
 * independent.
 */
export type DaemonMode = 'embedded' | 'service' | 'process';

export type DaemonLog =
  | { kind: 'file'; path: string }
  | { kind: 'journal'; command: string }
  | { kind: 'console' };

export type SupervisorKind = 'systemd-user' | 'launchd' | 'windows' | null;

export type ServiceReport = {
  supervisor: SupervisorKind;
  name: string | null;
  installed: boolean;
  running: boolean;
  reason: string | null;
  /** `opensConsole`: the task opens a console window a reinstall removes (#116). Absent from an older daemon. */
  windows: { revision: string | null; expected: string; launcherMarked: boolean | null; opensConsole?: boolean } | null;
  stale: boolean;
  action: 'install' | 'repair' | null;
  actionHere: boolean;
  command: string;
  /** Keeps running once the user logs out, read from the machine; `null` when unknown. Absent from an older daemon. */
  offSession?: boolean | null;
  /** The recorded answer to "keep running when logged out?", `null` when never asked. */
  sessionMode?: ServiceSessionMode | null;
  /** The answer can be changed on this OS (Linux, macOS, Windows). */
  sessionModeSupported?: boolean;
};

export type ServiceSessionMode = 'session' | 'always';

export type SystemInfo = {
  version: string;
  dataVersion: string | null;
  dataVersionOrder: number | null;
  os: { platform: string; name: string | null; release: string; arch: string };
  runtime: { node: string; electron: string | null };
  daemon: {
    mode: DaemonMode;
    packaged: boolean;
    packagedRuntime: boolean;
    pid: number;
    listen: { address: string | null; port: number };
    app: { servedByDaemon: boolean; host: string; port: number };
  };
  /** `logs`: the folder of the dated logs (daemon, desktop) and of saved reports. */
  paths: { installDir: string; home: string; configFile: string; log: DaemonLog; logs?: string };
  service: ServiceReport;
  license: { edition: string; plan: string | null; status: string; channel: string };
  importCommands: string[];
};

export type ServiceState = 'unsupported' | 'absent' | 'console' | 'stale' | 'stopped' | 'running';

export function serviceState(service: ServiceReport): ServiceState {
  if (service.supervisor === null) return 'unsupported';
  if (!service.installed) return 'absent';
  // Its revision reads current: the status line says why it needs a repair.
  if (service.stale && service.windows?.opensConsole === true) return 'console';
  if (service.stale) return 'stale';
  return service.running ? 'running' : 'stopped';
}

/** The app and its daemon come from two different releases. */
export function versionGap(daemon: string, desktop: string | null): boolean {
  return desktop !== null && desktop !== daemon;
}

/** `::` and `0.0.0.0` mean every interface; a bracketed IPv6 keeps its port readable. */
export function listenLabel(address: string | null, port: number): { address: string; everywhere: boolean } {
  if (address === null) return { address: `:${port}`, everywhere: false };
  const everywhere = address === '::' || address === '0.0.0.0';
  return { address: address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`, everywhere };
}

/** `GET /api/admin/system/diagnostic`: the support report, secrets already masked by the daemon. */
export type DiagnosticReport = { text: string; findings: { id: string; text: string }[] };

/** Same name as the desktop's saved reports: `timon-diagnostic-20261013-190611.txt`. */
export function diagnosticFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `timon-diagnostic-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.txt`;
}

/**
 * What the "When you log out" row of Settings › System shows.
 * `choice`: the user can flip it, `keeps` read from the machine first and
 * from the recorded answer when the machine could not tell; `pending` when
 * the two disagree (macOS or Windows waiting for their reinstall, a Linux
 * whose lingering was switched by hand). `hidden`: nothing registered, a
 * system with no choice, or an older daemon.
 */
export type SessionModeView =
  | { kind: 'hidden' }
  | { kind: 'choice'; keeps: boolean; pending: boolean; next: ServiceSessionMode };

export function sessionModeView(service: Pick<ServiceReport, 'installed' | 'supervisor' | 'offSession' | 'sessionMode' | 'sessionModeSupported'>): SessionModeView {
  if (!service.installed || service.sessionModeSupported === undefined) return { kind: 'hidden' };
  if (!service.sessionModeSupported) return { kind: 'hidden' };
  const machine = service.offSession ?? null;
  const chosen = service.sessionMode ?? null;
  const keeps = machine ?? chosen === 'always';
  const pending = machine !== null && chosen !== null && machine !== (chosen === 'always');
  return { kind: 'choice', keeps, pending, next: keeps ? 'session' : 'always' };
}
