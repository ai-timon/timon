/**
 * Timon services whose data directory is gone (TODO #464).
 *
 * A service installed for a throwaway `TIMON_HOME` (a release-candidate test,
 * a home deleted by hand) keeps its supervisor definition after the folder
 * disappears: systemd restarts it on failure at every session, launchd keeps
 * it alive, the scheduled task runs every five minutes. Nothing in the daemon
 * of the REAL home ever sees them, so `timon doctor` looks for them on disk.
 *
 * Read-only: it lists, and says how to remove each one. Removing goes by the
 * supervisor directly, never by `timon service uninstall` with the dead home —
 * a CLI from a source checkout would then address `timon-orchestrator`, the
 * unit of the real home.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchDaemonPath, MACOS_LABEL, plistPath, unitPath, WINDOWS_TASK } from './service-install.js';

export type OrphanService = {
  /** Unit, label or task name. */
  name: string;
  /** The file that defines it, or the task path. */
  definition: string;
  /** The `TIMON_HOME` it runs for, which no longer exists. */
  home: string;
  /** The commands that remove it, for the reader to run. */
  removal: string;
};

export type OrphanScanOptions = {
  platform: NodeJS.Platform;
  /** The user's home: where the systemd units and LaunchAgents live. */
  homeDir: string;
  /** macOS: for the `gui/<uid>` launchd domain. */
  uid?: number;
  /** macOS: where LaunchDaemons live. Tests point it at a temporary directory. */
  launchDaemonsDir?: string;
  /** Windows: the registered task as XML (`readServiceDefinition`), `null` when absent. */
  readWindowsTask?: () => string | null;
  exists?: (path: string) => boolean;
};

function readIfPresent(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

export function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => (
    { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' } as Record<string, string>)[entity]!);
}

/**
 * `TIMON_HOME` of a systemd unit, as `renderUnit` and `packagedServiceOptions`
 * write it, or as a hand-written unit does (`%h/.timon`). `%h` is the only
 * specifier resolved; a unit using another one is not judged (`null`).
 */
export function homeOfUnit(text: string, homeDir: string): string | null {
  const match = /^Environment=(?:"TIMON_HOME=((?:[^"\\]|\\.)*)"|TIMON_HOME=(\S+))\s*$/m.exec(text);
  if (!match) return null;
  const raw = match[2] ?? match[1]!.replace(/\\(.)/g, '$1');
  let unresolved = false;
  const home = raw.replace(/%(.)/g, (_, specifier: string) => {
    if (specifier === '%') return '%';
    if (specifier === 'h') return homeDir;
    unresolved = true;
    return '';
  });
  return unresolved ? null : home;
}

/** `TIMON_HOME` of a LaunchAgent or LaunchDaemon plist (`renderPlist`, `renderLaunchDaemonPlist`). */
export function homeOfPlist(text: string): string | null {
  const match = /<key>TIMON_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return match ? unescapeXml(match[1]!) : null;
}

/**
 * The home of the scheduled task: its launcher is `<home>\run\timon-service.cmd`,
 * between double quotes for cmd (`windowsTaskCommand`, the boot task) or in a
 * PowerShell literal, its quotes doubled (`windowsSessionTaskArguments`, the
 * logon task).
 */
export function homeOfTask(xml: string): string | null {
  const args = unescapeXml(xml);
  const quoted = /"([^"]+?)[\\/]run[\\/]timon-service\.(?:cmd|vbs)"/i.exec(args);
  if (quoted) return quoted[1]!;
  const literal = /'((?:[^']|'')+?)[\\/]run[\\/]timon-service\.cmd'/i.exec(args);
  return literal ? literal[1]!.replace(/''/g, "'") : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The Timon units this account defines, sorted. No readable directory: none. */
export function linuxTimonUnits(homeDir: string): string[] {
  let names: string[];
  try { names = readdirSync(join(homeDir, '.config', 'systemd', 'user')); } catch { return []; }
  // `timon-orchestrator`, `timon-dev-orchestrator`, `timon-desktop-<hash>`;
  // the mission slices end in `.slice` and carry no home.
  return names.sort().flatMap((file) => /^(timon-[A-Za-z0-9_.-]+)\.service$/.exec(file)?.[1] ?? []);
}

function linuxOrphans(opts: OrphanScanOptions, exists: (path: string) => boolean): OrphanService[] {
  const found: OrphanService[] = [];
  for (const unit of linuxTimonUnits(opts.homeDir)) {
    const definition = unitPath(opts.homeDir, unit);
    const text = readIfPresent(definition);
    const home = text === null ? null : homeOfUnit(text, opts.homeDir);
    if (!home || exists(home)) continue;
    found.push({
      name: unit,
      definition,
      home,
      removal: `systemctl --user disable --now ${unit} && rm ${shellQuote(definition)} && systemctl --user daemon-reload`,
    });
  }
  return found;
}

function darwinOrphans(opts: OrphanScanOptions, exists: (path: string) => boolean): OrphanService[] {
  const found: OrphanService[] = [];
  const daemon = launchDaemonPath(opts.launchDaemonsDir);
  const agent = plistPath(opts.homeDir);
  for (const [definition, removal] of [
    [daemon, `sudo launchctl bootout system/${MACOS_LABEL}; sudo rm ${shellQuote(daemon)}`],
    [agent, `launchctl bootout gui/${opts.uid ?? '$(id -u)'}/${MACOS_LABEL}; rm ${shellQuote(agent)}`],
  ] as const) {
    const text = readIfPresent(definition);
    const home = text === null ? null : homeOfPlist(text);
    if (!home || exists(home)) continue;
    found.push({ name: MACOS_LABEL, definition, home, removal });
  }
  return found;
}

function windowsOrphans(opts: OrphanScanOptions, exists: (path: string) => boolean): OrphanService[] {
  let xml: string | null = null;
  try { xml = opts.readWindowsTask?.() ?? null; } catch { return []; }
  const home = xml === null ? null : homeOfTask(xml);
  if (!home || exists(home)) return [];
  return [{
    name: WINDOWS_TASK,
    definition: `Task Scheduler \\${WINDOWS_TASK}`,
    home,
    removal: `schtasks /Delete /TN ${WINDOWS_TASK} /F (from a terminal opened as administrator)`,
  }];
}

/** Every Timon service of this account whose `TIMON_HOME` no longer exists. Never throws. */
export function orphanServices(opts: OrphanScanOptions): OrphanService[] {
  const exists = opts.exists ?? existsSync;
  try {
    if (opts.platform === 'linux') return linuxOrphans(opts, exists);
    if (opts.platform === 'darwin') return darwinOrphans(opts, exists);
    if (opts.platform === 'win32') return windowsOrphans(opts, exists);
  } catch { /* A diagnostic never fails on what it could not read. */ }
  return [];
}

/** The finding's words, one per orphan. */
export function orphanServiceText(orphan: OrphanService): string {
  return `The Timon service ${orphan.name} (${orphan.definition}) runs for ${orphan.home}, which no longer exists: `
    + `it keeps restarting for nothing. Remove it: ${orphan.removal}`;
}
