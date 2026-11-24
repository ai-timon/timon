/**
 * Whose service is this? (TODO #734)
 *
 * launchd and the scheduled task have one fixed name per account, and so has
 * the systemd unit of a source checkout: the name says nothing about who owns
 * what is registered under it. On 31/10/2026 a clone on a throwaway home
 * announced it would stop and replace the packaged Timon of that Mac.
 *
 * So every CLI gesture on the service first reads the definition in place and
 * compares its data directory and its installation with its own. Reinstalling
 * over one's own service stays free: that is the normal update and repair.
 *
 * The comparison is on the installation, not on the binary that runs it: a Node
 * upgraded under a source checkout is still that checkout. A definition that
 * names this home but no installation proves nothing about who wrote it, so it
 * counts as unproven, not as ours.
 *
 * Linux adds a second way to end up with two daemons on one database: its unit
 * is named after the installation, so a clone and a package never write the
 * same file (TODO #736). `servicesSharingHome` reads the others.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 as winPath } from 'node:path';
import { homeOfPlist, homeOfTask, homeOfUnit, linuxTimonUnits, unescapeXml } from './orphan-services.js';
import {
  LINUX_UNIT, MACOS_LABEL, WINDOWS_TASK, launchDaemonPath, macosLauncherPath, plistPath, readEffectiveUnit, readServiceDefinition, unitPath, windowsLauncherRuntime,
  type ServiceOpts, type ServiceResult,
} from './service-install.js';

export type InstalledService = {
  /** Unit, label or task name. */
  name: string;
  /** The file that defines it, or the task path. */
  definition: string;
  /** `TIMON_HOME` it runs for; `null` when the definition could not be read. */
  home: string | null;
  /** The orchestrator it runs from; `null` when the definition does not say. */
  installDir: string | null;
  executable: string | null;
};

export type ForeignService = InstalledService & {
  why: 'home' | 'install' | 'unreadable' | 'unproven' | 'shared' | 'unverified';
};

/** Gestures that act on the registered service, and so need it to be ours. */
export type ServiceGesture = 'install' | 'uninstall' | 'stop' | 'start';

/** What a forced gesture must also take down: `replacing` of `ServiceOpts`. */
export type ServiceGuard = {
  refusal: ServiceResult | null;
  replacing: NonNullable<ServiceOpts['replacing']> | null;
  notice: string | null;
};

export const FORCE_FLAG = '--force';

function realOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** Windows and macOS compare paths without case by default, as `temporary-home.ts` does. */
function normalized(path: string, platform: NodeJS.Platform): string {
  const absolute = platform === 'win32' ? winPath.resolve(path) : resolve(path);
  return platform === 'linux' ? absolute : absolute.toLowerCase();
}

function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const forms = (path: string) => [path, realOrNull(path)].filter((p): p is string => Boolean(p)).map((p) => normalized(p, platform));
  const others = forms(b);
  return forms(a).some((form) => others.includes(form));
}

function insidePath(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const rel = relative(normalized(parent, platform), normalized(child, platform));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function readIfPresent(file: string, read: (file: string) => string = (f) => readFileSync(f, 'utf8')): string | null {
  try { return read(file); } catch { return null; }
}

function linuxService(opts: ServiceOpts): InstalledService | null {
  const name = opts.unitName ?? LINUX_UNIT;
  const definition = unitPath(opts.homeDir, opts.unitName);
  const text = readIfPresent(definition);
  if (text === null) return null;
  // No `TIMON_HOME` at all is a unit that runs on the default home: the daemon
  // reads it that way, and so does `linuxService` in `service-install.ts`.
  const specifier = /^Environment="?TIMON_HOME=.*%[^%h]/m.test(text);
  const home = homeOfUnit(text, opts.homeDir) ?? (specifier ? null : join(opts.homeDir, '.timon'));
  const directory = /^WorkingDirectory=(.+)$/m.exec(text)?.[1]?.trim().replace(/^"(.*)"$/, '$1');
  return {
    name,
    definition,
    home,
    installDir: directory ? directory.replace(/%(.)/g, (whole, s: string) => (s === 'h' ? opts.homeDir : s === '%' ? '%' : whole)) : null,
    executable: /^ExecStart=(.+)$/m.exec(text)?.[1]?.trim() ?? null,
  };
}

/** The value `shQuote` wrote, single quotes put back. */
function unquoteShell(value: string): string {
  return value.replace(/'\\''/g, '\'');
}

function darwinService(opts: ServiceOpts): InstalledService | null {
  const daemonFile = launchDaemonPath(opts.launchDaemonsDir);
  const daemon = readIfPresent(daemonFile);
  if (daemon !== null) {
    const home = homeOfPlist(daemon) ?? join(opts.homeDir, '.timon');
    // The plist only runs a launcher, which holds the release paths.
    const launcher = readIfPresent(macosLauncherPath(home)) ?? '';
    const installDir = /^cd '((?:[^']|'\\'')*)'/m.exec(launcher)?.[1];
    const executable = /^exec '((?:[^']|'\\'')*)' --max-old-space-size/m.exec(launcher)?.[1];
    return {
      name: MACOS_LABEL,
      definition: daemonFile,
      home,
      installDir: installDir === undefined ? null : unquoteShell(installDir),
      executable: executable === undefined ? null : unquoteShell(executable),
    };
  }
  const agentFile = plistPath(opts.homeDir);
  const agent = readIfPresent(agentFile);
  if (agent === null) return null;
  const directory = /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/.exec(agent)?.[1];
  const program = /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>/.exec(agent)?.[1];
  return {
    name: MACOS_LABEL,
    definition: agentFile,
    home: homeOfPlist(agent) ?? join(opts.homeDir, '.timon'),
    installDir: directory === undefined ? null : unescapeXml(directory),
    executable: program === undefined ? null : unescapeXml(program),
  };
}

function windowsService(opts: ServiceOpts): InstalledService | null {
  const definition = `Task Scheduler \\${WINDOWS_TASK}`;
  const xml = readServiceDefinition(opts);
  if (xml === null) {
    // `Export-ScheduledTask` also fails on a task it may not read: registered
    // but unread is not the same as absent.
    const registered = opts.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK]).code === 0;
    return registered ? { name: WINDOWS_TASK, definition, home: null, installDir: null, executable: null } : null;
  }
  // `set TIMON_HOME=…&&`: the logon task of the first releases.
  const home = homeOfTask(xml) ?? /set TIMON_HOME=([^&"]+)&&/.exec(unescapeXml(xml))?.[1]?.trim() ?? null;
  const directory = /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/.exec(xml)?.[1];
  return {
    name: WINDOWS_TASK,
    definition,
    home,
    installDir: directory === undefined ? null : unescapeXml(directory),
    executable: home === null ? null : windowsLauncherRuntime(home, opts.readFile),
  };
}

/** The service registered under this installation's name, whoever it belongs to. `null`: none. */
export function readInstalledService(opts: ServiceOpts): InstalledService | null {
  if (opts.platform === 'win32') return windowsService(opts);
  if (opts.platform === 'darwin') return darwinService(opts);
  if (opts.platform === 'linux') return linuxService(opts);
  return null;
}

/**
 * The service in place when it is not this installation's. `sourceInstallDir`
 * is the orchestrator of the running package, which is not `opts.installDir`
 * once a release is staged: a macOS CLI of 0.1.3 and earlier wrote the service
 * around it (`markPackagedCli`). Any release of this home is ours too, but only
 * for a packaged caller: a source checkout on the same home is another install.
 */
export function foreignService(opts: ServiceOpts, sourceInstallDir?: string): ForeignService | null {
  const service = readInstalledService(opts);
  if (!service) return null;
  if (service.home === null) return { ...service, why: 'unreadable' };
  if (!samePath(service.home, opts.timonHome, opts.platform)) return { ...service, why: 'home' };
  if (service.installDir === null) return { ...service, why: 'unproven' };
  const own = [opts.installDir, ...(sourceInstallDir ? [sourceInstallDir] : [])]
    .some((dir) => samePath(service.installDir!, dir, opts.platform))
    || (opts.releasesRoot !== undefined && insidePath(opts.releasesRoot, service.installDir, opts.platform));
  return own ? null : { ...service, why: 'install' };
}

/**
 * The other Linux units that may run on this home, whichever installation wrote
 * them. Scanned rather than derived from the name: `packagedUnit` hashes the
 * path as spelled, so a home reached through a link gets another unit name for
 * the same database.
 *
 * Judged on what systemd runs, not on the file: a drop-in can move a unit onto
 * this home, which would start a second daemon, or off it, which `--force` would
 * then remove for nothing. `shared` is proven, and `--force` may take it down.
 * `unverified` is a unit systemd cannot vouch for: it may run here, so it blocks
 * a second daemon, and nothing proves it is this home's, so it is never removed.
 * A unit of this family that names no home is a helper, not a daemon; only
 * `timon-orchestrator` runs on the default home that way.
 *
 * Not read: an `EnvironmentFile=` or an `ExecStart=` that sets `TIMON_HOME`
 * itself. The shipped units load `secrets.env` that way, and neither that file
 * nor a command line is a place Timon writes the home.
 */
export function servicesSharingHome(opts: ServiceOpts): ForeignService[] {
  if (opts.platform !== 'linux') return [];
  const own = opts.unitName ?? LINUX_UNIT;
  return linuxTimonUnits(opts.homeDir).filter((unit) => unit !== own).flatMap((unit): ForeignService[] => {
    const effective = readEffectiveUnit(opts, unit);
    if (effective.kind === 'absent') return [];
    const service = {
      name: unit,
      definition: unitPath(opts.homeDir, unit),
      executable: linuxService({ ...opts, unitName: unit })?.executable ?? null,
    };
    if (effective.kind === 'unverified' || effective.home === null) {
      return [{ ...service, home: null, installDir: null, why: 'unverified' }];
    }
    if (!samePath(effective.home, opts.timonHome, opts.platform)) return [];
    if (unit !== LINUX_UNIT && !effective.namesHome) return [];
    return [{ ...service, home: effective.home, installDir: effective.directory, why: 'shared' }];
  });
}

/**
 * What a desktop upgrade and `timon update apply` must not take over: a service
 * that names another data directory, the only thing they can prove. Moving to
 * another release or install directory is their very job, and an unreadable
 * definition keeps the behaviour it always had.
 */
export function serviceOfAnotherHome(opts: ServiceOpts): string | null {
  const service = readInstalledService(opts);
  if (!service || service.home === null || samePath(service.home, opts.timonHome, opts.platform)) return null;
  return `The service ${service.name} runs for ${service.home}, not for ${opts.timonHome}: it was left in place.`;
}

/**
 * A gesture of the desktop's runners on the registered service. Its name is
 * fixed per account on macOS and Windows, so a Timon opened on a throwaway home
 * would stop or restart the real home's daemon (TODO #735). They have no
 * `--force`, and judge the home only: an update or a repair moves the install.
 */
export function actOnOwnService<R extends ServiceResult | Promise<ServiceResult>>(
  opts: ServiceOpts,
  gesture: (opts: ServiceOpts) => R,
): R | ServiceResult {
  const refusal = serviceOfAnotherHome(opts);
  return refusal ? { ok: false, code: 1, lines: [], reason: refusal, written: false } : gesture(opts);
}

/** Who it belongs to, in the words the refusal, the notice and `status` share. */
export function ownerLines(service: InstalledService): string[] {
  return [
    `  service:    ${service.name} (${service.definition})`,
    `  data:       ${service.home ?? 'unknown, its definition could not be read'}`,
    `  install:    ${service.installDir ?? 'unknown, its definition does not say'}`,
    ...(service.executable ? [`  executable: ${service.executable}`] : []),
  ];
}

const REASONS: Record<ForeignService['why'], string> = {
  home: 'belongs to another data directory',
  install: 'runs from another installation',
  unreadable: 'could not be read, so it may belong to another installation',
  unproven: 'does not say which installation it runs from, so it may be another one',
  shared: 'already runs on this data directory, and two services must not share it',
  unverified: 'could not be checked, so it may already run on this data directory',
};

/**
 * Decides one CLI gesture. Without `force`, the refusal says what exists and how
 * to go on; nothing has been written, stopped or prompted for at that point.
 * `stop` and `start` change nothing durable: they have no `--force`, and only
 * refuse a service proven to be someone else's, so that an unreadable task can
 * still be stopped. `install` and `uninstall` need the proof the other way round.
 * A unit sharing the home stops the two gestures that would start a second
 * daemon. `stop` and `uninstall` act on this installation's own unit only, and
 * are how a machine already in that state gets out of it. A unit that could not
 * be checked stops them even with `--force`, which only removes what is proven.
 */
export function guardServiceGesture(
  opts: ServiceOpts,
  gesture: ServiceGesture,
  { force = false, sourceInstallDir }: { force?: boolean; sourceInstallDir?: string } = {},
): ServiceGuard {
  const passes: ServiceGuard = { refusal: null, replacing: null, notice: null };
  const replaceable = gesture === 'install' || gesture === 'uninstall';
  const inPlace = foreignService(opts, sourceInstallDir);
  const foreign = !replaceable && (inPlace?.why === 'unreadable' || inPlace?.why === 'unproven') ? null : inPlace;
  const others = gesture === 'install' || gesture === 'start' ? servicesSharingHome(opts) : [];
  const unverified = others.filter((service) => service.why === 'unverified');
  const found = [...(foreign ? [foreign] : []), ...others];
  const first = unverified[0] ?? found[0];
  if (!first) return passes;
  if (replaceable && force && unverified.length === 0) {
    const verb = gesture === 'install' ? 'replace' : 'remove';
    const done = opts.dryRun ? `(dry-run) would ${verb}` : gesture === 'install' ? 'replacing' : 'removing';
    return {
      refusal: null,
      replacing: { home: first.home, ...(others.length ? { units: others.map((service) => service.name) } : {}) },
      notice: [`${done} the service of another installation (${FORCE_FLAG}):`, ...found.flatMap(ownerLines)].join('\n'),
    };
  }
  const reason = `the service ${first.name} ${REASONS[first.why]}.`;
  const way = unverified.length > 0
    ? `${FORCE_FLAG} would not help, it only removes a service proven to run here. Make sure systemd answers (systemctl --user daemon-reload), or repair or remove that unit, then run this command again.`
    : replaceable
      ? `To ${gesture === 'install' ? 'replace it' : 'remove it'} anyway: timon service ${gesture} ${FORCE_FLAG}`
      : 'Run this command from that installation, or with its TIMON_HOME.';
  const lines = [
    `${opts.dryRun ? '(dry-run) would refuse' : 'refused'}: ${reason}`,
    ...found.flatMap(ownerLines),
    `  this command: data ${opts.timonHome}, install ${opts.installDir}`,
    `Nothing was changed. ${way}`,
  ];
  return {
    ...passes,
    refusal: { ok: false, code: 1, lines, reason: lines.join('\n'), written: false },
  };
}
