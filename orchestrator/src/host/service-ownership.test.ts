/**
 * `timon service install` never replaces another installation's service without
 * `--force` (TODO #734). Each OS reads a definition rendered by the real
 * renderer. No test calls a supervisor: `exec` is a recorder, and every path
 * lives under a temporary home.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, win32 as winPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecResult } from './types.js';
import { packagedServiceOptions } from './packaged-service.js';
import { upgradeDesktopService, type UpgradeDeps } from './packaged-upgrade.js';
import {
  LINUX_UNIT, MACOS_LABEL, WINDOWS_SERVICE_REVISION, WINDOWS_TASK, elevatedScriptPath, installService, launchDaemonPath, macosLauncherPath, plistPath,
  readServiceDefinition, removeServiceDefinition, renderLaunchDaemonPlist, renderMacLauncher, renderPlist, renderTaskXml, renderUnit, renderWindowsLauncherConfig,
  restartService, restartWindowsService, restoreServiceDefinition, serviceStoppedMarker, startService, stopService, retireBatchLauncher, taskXmlPath, uninstallService, unitPath, windowsLauncherPath, windowsServiceFiles,
  type ServiceOpts, type ServiceResult,
} from './service-install.js';
import { actOnOwnService, foreignService, guardServiceGesture, readInstalledService, serviceOfAnotherHome, servicesSharingHome } from './service-ownership.js';

type Platform = 'linux' | 'darwin' | 'win32';
type Host = {
  o: ServiceOpts;
  calls: string[][];
  /** Windows: the registered task as XML; the others read their file. */
  task: { xml: string | null; registered: boolean };
  /** Linux: what `systemctl show` answers for a unit, instead of reading its files. */
  systemd: Map<string, () => ExecResult>;
};

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };

/** The commands that only read: anything else recorded by a refusal is a bug. */
const READ_ONLY = (call: string[]): boolean => call[0] === 'systemctl' ? call[2] === 'show' : call[0] === 'schtasks' ? call[1] === '/Query' : call[0] === 'powershell' && call.join(' ').includes('Export-ScheduledTask');

function host(platform: Platform): Host {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-ownership-'));
  const installDir = join(homeDir, 'clone', 'orchestrator');
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(installDir, 'scripts', `${LINUX_UNIT}.service.template`),
    '[Service]\nWorkingDirectory=@REPO@/orchestrator\nExecStart=/usr/bin/env node --max-old-space-size=@HEAP@ dist/index.js\nEnvironment=PORT=@PORT@\n',
  );
  const calls: string[][] = [];
  const task = { xml: null as string | null, registered: false };
  const systemd = new Map<string, () => ExecResult>();
  const o: ServiceOpts = {
    platform,
    homeDir,
    timonHome: join(homeDir, 'scratch-home'),
    installDir,
    userName: 'tester',
    uid: 501,
    heapMb: 4096,
    port: 3010,
    nodePath: '/usr/bin/node',
    launchDaemonsDir: join(homeDir, 'LaunchDaemons'),
    elevation: 'osascript',
    pause: () => {},
    offSession: false,
    readFile: () => { throw new Error('no such file'); },
    exec: (name, args) => {
      calls.push([name, ...args]);
      if (name === 'powershell' && args.join(' ').includes('Export-ScheduledTask')) {
        return task.xml === null ? { code: 1, stdout: '', stderr: 'not found' } : { code: 0, stdout: task.xml, stderr: '' };
      }
      if (name === 'schtasks' && args[0] === '/Query') return { code: task.registered || task.xml !== null ? 0 : 1, stdout: '', stderr: '' };
      if (name === 'launchctl' && args[0] === 'print') return { code: 113, stdout: '', stderr: '' };
      if (name === 'systemctl' && args.includes('show')) {
        // The effective unit, as systemd would serialize what is on disk now.
        const unit = args[args.indexOf('show') + 1]!;
        const scripted = systemd.get(unit);
        if (scripted) return scripted();
        const file = unitPath(homeDir, unit);
        if (!existsSync(file)) return { code: 0, stdout: 'LoadState=not-found\n', stderr: '' };
        // The file, then its drop-ins in order: the last assignment wins, and
        // systemd has already resolved its specifiers.
        const dropIns = `${file}.d`;
        const text = [file, ...(existsSync(dropIns) ? readdirSync(dropIns).sort().map((f) => join(dropIns, f)) : [])]
          .map((f) => readFileSync(f, 'utf8')).join('\n').replaceAll('%t', '/run/user/501');
        const environment = [...text.matchAll(/^Environment=("?TIMON_HOME=.*)$/gm)].at(-1)?.[1] ?? '';
        const directory = [...text.matchAll(/^WorkingDirectory=(.*)$/gm)].at(-1)?.[1] ?? '';
        return { code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nUnitFileState=enabled\nWorkingDirectory=${directory}\nEnvironment=${environment}\n`, stderr: '' };
      }
      return OK;
    },
  };
  return { o, calls, task, systemd };
}

/** What the elevated Windows batch reports, step by step, once it is run. */
const WINDOWS_STEPS = 'TIMON-STEP create=0\r\nTIMON-STEP stop=0\r\nTIMON-STEP run=0\r\nTIMON-STEP verify=0\r\n';

function installable(h: Host): ServiceOpts {
  if (h.o.platform !== 'win32') return h.o;
  return { ...h.o, readFile: () => WINDOWS_STEPS };
}

/** Registers the service `owner` would have installed on this machine. */
function register(h: Host, owner: { timonHome: string; installDir: string; nodePath?: string }): void {
  const o = { ...h.o, nodePath: '/opt/other/node', ...owner };
  if (h.o.platform === 'linux') {
    mkdirSync(join(o.installDir, 'scripts'), { recursive: true });
    writeFileSync(join(o.installDir, 'scripts', `${LINUX_UNIT}.service.template`), readFileSync(join(h.o.installDir, 'scripts', `${LINUX_UNIT}.service.template`), 'utf8'));
    const file = unitPath(h.o.homeDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderUnit(o));
  } else if (h.o.platform === 'darwin') {
    const file = plistPath(h.o.homeDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPlist(o));
  } else {
    h.task.xml = renderTaskXml(o);
  }
}

const definitionOf = (h: Host): string | null => {
  if (h.o.platform === 'win32') return h.task.xml;
  return readFileSync(h.o.platform === 'linux' ? unitPath(h.o.homeDir) : plistPath(h.o.homeDir), 'utf8');
};

/**
 * The Linux guard reads the effective unit back from `systemctl show` and only
 * trusts POSIX paths there. The fixtures write units naming the temporary
 * folder, `C:\…` on a Windows runner: the unit is then judged foreign or
 * unproven. That code runs on Linux only, so its cases are skipped on Windows.
 */
const SYSTEMD_IDENTITY = process.platform === 'win32'
  && 'the systemd unit identity is read as POSIX paths, which a Windows temporary folder is not';

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  const name = { linux: LINUX_UNIT, darwin: MACOS_LABEL, win32: WINDOWS_TASK }[platform];

  test(`${platform}: the service of another home is refused, and nothing is touched`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    const realHome = join(h.o.homeDir, 'real-home');
    const realInstall = join(h.o.homeDir, 'packaged', 'orchestrator');
    register(h, { timonHome: realHome, installDir: realInstall });
    const before = definitionOf(h);

    const { refusal, replacing } = guardServiceGesture(h.o, 'install');

    assert.ok(refusal, 'a refusal');
    assert.notEqual(refusal.code, 0);
    assert.equal(refusal.ok, false);
    assert.equal(replacing, null);
    const text = refusal.lines.join('\n');
    assert.ok(text.includes(name), text);
    // On Windows the path went through the task command, in its own separators.
    assert.ok(text.includes(platform === 'win32' ? winPath.dirname(winPath.dirname(windowsLauncherPath(realHome))) : realHome), text);
    assert.ok(text.includes(realInstall), text);
    assert.match(text, /timon service install --force/);
    assert.match(text, /Nothing was changed/);
    assert.doesNotMatch(text, /service installed/);
    assert.equal(definitionOf(h), before);
    assert.ok(h.calls.every(READ_ONLY), JSON.stringify(h.calls));
  });

  test(`${platform}: the same install on another home is refused`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: h.o.installDir });
    assert.equal(foreignService(h.o)?.why, 'home');
    assert.match(guardServiceGesture(h.o, 'install').refusal!.lines[0]!, /belongs to another data directory/);
  });

  test(`${platform}: the same home on another install is refused too`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    register(h, { timonHome: h.o.timonHome, installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
    const foreign = foreignService(h.o);
    assert.equal(foreign?.why, 'install');
    assert.match(guardServiceGesture(h.o, 'install').refusal!.lines[0]!, /runs from another installation/);
  });

  test(`${platform}: reinstalling over one's own service needs no flag`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
    const guard = guardServiceGesture(h.o, 'install');
    assert.deepEqual(guard, { refusal: null, replacing: null, notice: null });
    const res = installService(installable(h));
    assert.equal(res.ok, true, res.lines.join('\n'));
    assert.ok(res.lines.some((l) => l.includes('service installed')), res.lines.join('\n'));
  });

  test(`${platform}: no service at all needs no flag either`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    assert.equal(readInstalledService(h.o), null);
    assert.deepEqual(guardServiceGesture(h.o, 'install'), { refusal: null, replacing: null, notice: null });
  });

  test(`${platform}: another home with --force is replaced, and says so`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    const realHome = join(h.o.homeDir, 'real-home');
    register(h, { timonHome: realHome, installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
    const guard = guardServiceGesture(h.o, 'install', { force: true });
    assert.equal(guard.refusal, null);
    assert.ok(guard.replacing);
    assert.match(guard.notice!, /^replacing the service of another installation \(--force\):/);
    const res = installService({ ...installable(h), replacing: guard.replacing });
    assert.equal(res.ok, true, res.lines.join('\n'));
    if (platform === 'linux') {
      assert.ok(readFileSync(unitPath(h.o.homeDir), 'utf8').includes(`Environment="TIMON_HOME=${h.o.timonHome}"`));
      // `enable --now` would leave the other daemon running.
      assert.ok(h.calls.some((c) => c.join(' ') === `systemctl --user restart ${LINUX_UNIT}`), JSON.stringify(h.calls));
    }
    if (platform === 'darwin') {
      assert.ok(readFileSync(plistPath(h.o.homeDir), 'utf8').includes(h.o.timonHome));
      assert.ok(h.calls.some((c) => c.join(' ') === `launchctl bootout gui/501/${MACOS_LABEL}`));
    }
    if (platform === 'win32') {
      // Without this step, `IgnoreNew` drops the `/Run` while the other daemon lives.
      const batch = readFileSync(elevatedScriptPath(), 'utf8');
      assert.ok(batch.includes(windowsLauncherPath(realHome).toLowerCase()), batch);
      assert.ok(batch.includes(windowsLauncherPath(h.o.timonHome).toLowerCase()), batch);
    }
  });

  test(`${platform}: a dry run reports the refusal, and never claims an install`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
    const dry = { ...h.o, dryRun: true };
    const { refusal } = guardServiceGesture(dry, 'install');
    assert.ok(refusal);
    assert.notEqual(refusal.code, 0);
    assert.match(refusal.lines[0]!, /^\(dry-run\) would refuse: /);

    const forced = guardServiceGesture(dry, 'install', { force: true });
    assert.match(forced.notice!, /^\(dry-run\) would replace the service of another installation/);

    const res = installService({ ...dry, replacing: forced.replacing });
    assert.equal(res.ok, true);
    const text = res.lines.join('\n');
    assert.doesNotMatch(text, /service installed/);
    assert.match(text, /\(dry-run\) would install/);
  });

  test(`${platform}: uninstall, stop and start refuse another home; only uninstall takes --force`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
    const uninstall = guardServiceGesture(h.o, 'uninstall');
    assert.match(uninstall.refusal!.lines.join('\n'), /timon service uninstall --force/);
    assert.ok(guardServiceGesture(h.o, 'uninstall', { force: true }).replacing);
    for (const gesture of ['stop', 'start'] as const) {
      const refused = guardServiceGesture(h.o, gesture, { force: true }).refusal;
      assert.ok(refused, gesture);
      assert.doesNotMatch(refused.lines.join('\n'), /--force/);
      assert.match(refused.lines.join('\n'), /with its TIMON_HOME/);
    }
  });
}

test('linux: the real template and the live hand-written form both read back', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const shipped = resolve('src/host/../../');
  const file = unitPath(h.o.homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderUnit({ ...h.o, installDir: shipped, timonHome: '/srv/timon data' }));
  const rendered = readInstalledService(h.o)!;
  assert.equal(rendered.home, '/srv/timon data');
  assert.equal(rendered.installDir, join(dirname(shipped), 'orchestrator'));
  assert.match(rendered.executable!, /dist\/index\.js/);

  writeFileSync(file, `[Service]\nWorkingDirectory=%h/clone/orchestrator\nEnvironment=TIMON_HOME=%h/scratch-home\nExecStart=/usr/bin/env node dist/index.js\n`);
  assert.equal(foreignService(h.o), null, '%h resolves to the same home and install');

  // No `TIMON_HOME` at all: the daemon runs on the default home.
  writeFileSync(file, '[Service]\nWorkingDirectory=/srv/x\nExecStart=/usr/bin/env node dist/index.js\n');
  assert.equal(readInstalledService(h.o)!.home, join(h.o.homeDir, '.timon'));
  assert.equal(foreignService(h.o)?.why, 'home');

  // A specifier we cannot resolve is not judged on a guess.
  writeFileSync(file, '[Service]\nEnvironment=TIMON_HOME=%t/timon\n');
  assert.equal(foreignService(h.o)?.why, 'unreadable');
  assert.ok(guardServiceGesture(h.o, 'install').refusal);
  assert.equal(guardServiceGesture(h.o, 'stop').refusal, null, 'an unreadable service can still be stopped');
});

test('linux: --force gets past the identity check an installed unit would otherwise answer', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
  const refused = installService(h.o);
  assert.equal(refused.ok, false);
  assert.match(refused.reason!, /belongs to another installation/);
  assert.equal(refused.written, false);

  const removedBlocked = uninstallService(h.o);
  assert.equal(removedBlocked.ok, false);
  assert.ok(existsSync(unitPath(h.o.homeDir)));
  const removed = uninstallService({ ...h.o, replacing: { home: join(h.o.homeDir, 'real-home') } });
  assert.equal(removed.ok, true, removed.lines.join('\n'));
  assert.equal(existsSync(unitPath(h.o.homeDir)), false);
});

test('darwin: the LaunchDaemon is identified through the launcher of the home it names', () => {
  const h = host('darwin');
  const realHome = join(h.o.homeDir, "real o'home");
  const realInstall = join(h.o.homeDir, "pack'aged", 'orchestrator');
  const file = launchDaemonPath(h.o.launchDaemonsDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderLaunchDaemonPlist({ ...h.o, timonHome: realHome }));
  const launcher = macosLauncherPath(realHome);
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, renderMacLauncher({ ...h.o, timonHome: realHome, installDir: realInstall, nodePath: '/opt/timon/node' }));

  const service = readInstalledService(h.o)!;
  assert.equal(service.definition, file);
  assert.equal(service.home, realHome);
  assert.equal(service.installDir, realInstall);
  assert.equal(service.executable, '/opt/timon/node');
  assert.equal(foreignService(h.o)?.why, 'home');

  // Its own: the launcher says which install.
  const mine = host('darwin');
  const mineFile = launchDaemonPath(mine.o.launchDaemonsDir);
  mkdirSync(dirname(mineFile), { recursive: true });
  writeFileSync(mineFile, renderLaunchDaemonPlist(mine.o));
  const mineLauncher = macosLauncherPath(mine.o.timonHome);
  mkdirSync(dirname(mineLauncher), { recursive: true });
  writeFileSync(mineLauncher, renderMacLauncher(mine.o));
  assert.equal(foreignService(mine.o), null);
  writeFileSync(mineLauncher, renderMacLauncher({ ...mine.o, installDir: join(mine.o.homeDir, 'other', 'orchestrator') }));
  assert.equal(foreignService(mine.o)?.why, 'install');
});

test('darwin, linux: a packaged CLI owns every release of its home, a source checkout does not', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const h = host(platform);
    const packaged = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
    const older = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.1.9');
    const file = platform === 'darwin' ? plistPath(h.o.homeDir) : unitPath(h.o.homeDir, packaged.unitName);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, platform === 'darwin' ? renderPlist(older) : older.unitContent!);
    assert.notEqual(older.installDir, packaged.installDir);
    assert.equal(foreignService(packaged), null, `${platform}: an update`);
    if (platform === 'darwin') {
      assert.equal(foreignService(h.o)?.why, 'install', 'a clone on the same home is another installation');
    }
  }
});

test('darwin: a service an old CLI wrote around the package itself stays its own', () => {
  const h = host('darwin');
  const app = join(h.o.homeDir, 'Timon.app', 'Contents', 'Resources', 'orchestrator');
  register(h, { timonHome: h.o.timonHome, installDir: app });
  const packaged = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
  assert.equal(foreignService(packaged)?.why, 'install', 'without the running package to compare with');
  assert.equal(foreignService(packaged, app), null);
  assert.equal(guardServiceGesture(packaged, 'install', { sourceInstallDir: app }).refusal, null);
});

test('win32: compared without case and with the separators of a real task', () => {
  const h = host('win32');
  const o: ServiceOpts = { ...h.o, timonHome: 'C:\\Users\\Robin\\.timon', installDir: 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\resources\\orchestrator' };
  h.task.xml = renderTaskXml({ ...o, timonHome: 'c:\\users\\robin\\.TIMON', installDir: o.installDir.toUpperCase() });
  assert.equal(foreignService(o), null);
  h.task.xml = renderTaskXml({ ...o, timonHome: 'C:\\Users\\Robin\\AppData\\Local\\Temp\\rc-test' });
  const foreign = foreignService(o);
  assert.equal(foreign?.why, 'home');
  assert.equal(foreign?.home, 'C:\\Users\\Robin\\AppData\\Local\\Temp\\rc-test');
});

test('win32: the daemon it runs comes from the launcher of that home', () => {
  const h = host('win32');
  const realHome = 'C:\\Users\\Robin\\.timon';
  const realInstall = 'C:\\Program Files\\Timon\\resources\\orchestrator';
  h.task.xml = renderTaskXml({ ...h.o, timonHome: realHome, installDir: realInstall });
  const node = 'C:\\Program Files\\Timon\\resources\\node\\node.exe';
  const launcher = renderWindowsLauncherConfig({ ...h.o, timonHome: realHome, installDir: realInstall, nodePath: node });
  const read: string[] = [];
  const service = readInstalledService({ ...h.o, readFile: (f) => {
    read.push(f);
    if (!f.endsWith('timon-service.json')) throw new Error('ENOENT');
    return launcher;
  } })!;
  assert.ok(read.every((f) => f.startsWith(realHome)), read.join(', '));
  assert.equal(service.executable, node);
  assert.equal(service.installDir, realInstall);
  // Revision 5, before the upgrade rewrote it: the batch names the daemon.
  const batch = `@echo off\r\nset "TIMON_HOME=${realHome}"\r\n"C:\\Program Files\\Timon\\resources\\node\\node.exe" --max-old-space-size=4096 "${realInstall}\\dist\\boot.js" >>"%TIMON_SERVICE_LOG%" 2>&1\r\n`;
  const older = readInstalledService({ ...h.o, readFile: (f) => {
    if (!f.endsWith('timon-service.cmd')) throw new Error('ENOENT');
    return batch;
  } })!;
  assert.equal(older.executable, node);
});

test('win32: the logon task of the first releases still names its home', () => {
  const h = host('win32');
  h.task.xml = `<Task><Actions><Exec><Command>cmd.exe</Command><Arguments>/c set TIMON_HOME=C:\\Users\\Robin\\.timon&amp;&amp; node boot.js</Arguments></Exec></Actions></Task>`;
  assert.equal(readInstalledService(h.o)!.home, 'C:\\Users\\Robin\\.timon');
});

test('win32: that task, as those releases wrote it, still says which installation it runs from', () => {
  const h = host('win32');
  const o: ServiceOpts = { ...h.o, timonHome: 'C:\\Users\\Robin\\.timon', installDir: 'C:\\Users\\Robin\\src\\timon\\orchestrator' };
  const task = (directory: string) => `<Task><Actions><Exec><Command>cmd.exe</Command><Arguments>/c set TIMON_HOME=C:\\Users\\Robin\\.timon&amp;&amp; node boot.js</Arguments><WorkingDirectory>${directory}</WorkingDirectory></Exec></Actions></Task>`;
  h.task.xml = task(o.installDir);
  assert.equal(foreignService(o), null);
  h.task.xml = task('C:\\Program Files\\Timon\\resources\\orchestrator');
  assert.equal(foreignService(o)?.why, 'install');
});

/**
 * A service on the caller's own home, whose definition names no installation.
 * Each entry leaves out what `readInstalledService` reads the installation from.
 */
const UNPROVEN: Record<Platform, (h: Host) => void> = {
  linux: (h) => {
    const file = unitPath(h.o.homeDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `[Service]\nEnvironment="TIMON_HOME=${h.o.timonHome}"\nExecStart=/opt/other/node /opt/other/dist/index.js\n`);
  },
  darwin: (h) => {
    const file = plistPath(h.o.homeDir);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderPlist(h.o).replace(/<key>WorkingDirectory<\/key><string>[^<]*<\/string>\n?/, ''));
  },
  win32: (h) => {
    h.task.xml = `<Task><Actions><Exec><Command>cmd.exe</Command><Arguments>/c set TIMON_HOME=${h.o.timonHome}&amp;&amp; node boot.js</Arguments></Exec></Actions></Task>`;
  },
};

for (const platform of ['linux', 'darwin', 'win32'] as const) {
  test(`${platform}: its own home without a named installation is not proof it is ours`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    const h = host(platform);
    UNPROVEN[platform](h);
    const before = definitionOf(h);
    const service = readInstalledService(h.o)!;
    assert.equal(service.installDir, null);
    assert.equal(foreignService(h.o)?.why, 'unproven');

    const { refusal, replacing } = guardServiceGesture(h.o, 'install');
    assert.ok(refusal);
    assert.notEqual(refusal.code, 0);
    assert.equal(replacing, null);
    const text = refusal.lines.join('\n');
    assert.match(text, /does not say which installation/);
    assert.match(text, /install: {4}unknown/);
    assert.match(text, /timon service install --force/);
    assert.ok(guardServiceGesture(h.o, 'uninstall').refusal);
    assert.equal(definitionOf(h), before);
    assert.ok(h.calls.every(READ_ONLY), JSON.stringify(h.calls));

    const dry = guardServiceGesture({ ...h.o, dryRun: true }, 'install');
    assert.match(dry.refusal!.lines[0]!, /^\(dry-run\) would refuse: /);

    // No home to doubt: it can still be stopped, and the right one hears of it.
    for (const gesture of ['stop', 'start'] as const) assert.equal(guardServiceGesture(h.o, gesture).refusal, null, gesture);
    assert.equal(serviceOfAnotherHome(h.o), null, 'the upgrade path only ever judges the home');

    const forced = guardServiceGesture(h.o, 'install', { force: true });
    assert.equal(forced.refusal, null);
    assert.equal(forced.replacing?.home, h.o.timonHome);
    const res = installService({ ...installable(h), replacing: forced.replacing });
    assert.equal(res.ok, true, res.lines.join('\n'));
  });
}

test('darwin: a LaunchDaemon on its own home whose launcher is missing or unknown is unproven', () => {
  const h = host('darwin');
  const file = launchDaemonPath(h.o.launchDaemonsDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderLaunchDaemonPlist(h.o));
  assert.equal(foreignService(h.o)?.why, 'unproven', 'no launcher');
  const launcher = macosLauncherPath(h.o.timonHome);
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, '#!/bin/sh\nexec /opt/other/node /opt/other/dist/index.js\n');
  assert.equal(foreignService(h.o)?.why, 'unproven', 'a launcher that names no directory');
  assert.ok(guardServiceGesture(h.o, 'install').refusal);
});

test('a packaged upgrade moves a service that names its home and no installation: home-only, on purpose', async () => {
  for (const platform of ['linux', 'darwin', 'win32'] as const) {
    if (platform === 'linux' && SYSTEMD_IDENTITY) continue; // see SYSTEMD_IDENTITY
    const h = host(platform);
    UNPROVEN[platform](h);
    const steps: string[] = [];
    const moved = await upgradeDesktopService({
      platform,
      stage: async () => {},
      options: () => h.o,
      foreign: serviceOfAnotherHome,
      install: () => { steps.push('install'); return { ok: true, code: 0, lines: [] }; },
      read: () => 'definition',
      restore: () => ({ ok: true, code: 0, lines: [] }),
      remove: () => ({ ok: true, code: 0, lines: [] }),
      healthy: async () => true,
      mark: async () => {},
      prune: async () => {},
    });
    assert.equal(moved.ok, true, platform);
    assert.deepEqual(steps, ['install'], platform);
  }
});

test('win32: a task registered but unreadable is refused, a missing one is not', () => {
  const h = host('win32');
  h.task.registered = true;
  const foreign = foreignService(h.o);
  assert.equal(foreign?.why, 'unreadable');
  const { refusal } = guardServiceGesture(h.o, 'install');
  assert.match(refusal!.lines[0]!, /could not be read/);
  assert.match(refusal!.lines.join('\n'), /timon service install --force/);
  assert.ok(guardServiceGesture(h.o, 'install', { force: true }).replacing);

  h.task.registered = false;
  assert.equal(foreignService(h.o), null);
});

test('the same installation reached through a link is the same installation', () => {
  const h = host('linux');
  register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
  const repo = dirname(h.o.installDir);
  const link = join(h.o.homeDir, 'linked-repo');
  // A junction: the one directory link Windows grants without a privilege.
  symlinkSync(repo, link, 'junction');
  assert.equal(foreignService({ ...h.o, installDir: join(link, 'orchestrator') }), null);
  assert.equal(foreignService({ ...h.o, installDir: `${h.o.installDir}-other` })?.why, 'install');
});

/**
 * TODO #564: the update of a Windows install rewrites a task older than the SID.
 * Revision 3 as it was registered: this home, this installation, a bare account
 * name. `exec` answers `whoami` as Windows does; the transcript stands for the
 * elevated batch, which is the UAC prompt on a real machine.
 */
function revision3Task(): { h: Host; o: ServiceOpts; revision: string; sid: string } {
  const h = host('win32');
  const sid = 'S-1-5-21-1111111111-2222222222-3333333333-1001';
  const o: ServiceOpts = {
    ...installable(h),
    exec: (name, args) => (name === 'whoami' ? { code: 0, stdout: `"pc\\tester","${sid}"\r\n`, stderr: '' } : h.o.exec(name, args)),
  };
  register(h, { timonHome: o.timonHome, installDir: o.installDir });
  assert.match(h.task.xml!, /<UserId>tester<\/UserId>/);
  const revision = windowsServiceFiles(o.timonHome, join).revision;
  mkdirSync(dirname(revision), { recursive: true });
  writeFileSync(revision, '3\n');
  return { h, o, revision, sid };
}

const upgradeDeps = (o: ServiceOpts, healthy: boolean): UpgradeDeps => ({
  platform: 'win32',
  stage: async () => { throw new Error('Windows has no release to stage'); },
  options: () => o,
  foreign: serviceOfAnotherHome,
  install: installService,
  read: readServiceDefinition,
  restore: restoreServiceDefinition,
  remove: removeServiceDefinition,
  healthy: async () => healthy,
  mark: async () => { throw new Error('Windows has no release to mark'); },
  prune: async () => { throw new Error('Windows has no release to prune'); },
});

test('win32: a task of this installation older than the SID is rewritten with it, without --force', async () => {
  const { o, revision, sid } = revision3Task();
  // The buttons and `timon service install` ask this; the desktop upgrade asks the home only.
  assert.deepEqual(guardServiceGesture(o, 'install'), { refusal: null, replacing: null, notice: null });
  assert.equal(serviceOfAnotherHome(o), null);

  const upgraded = await upgradeDesktopService(upgradeDeps(o, true));
  assert.equal(upgraded.ok, true, upgraded.reason ?? '');
  const xml = readFileSync(taskXmlPath(), 'utf16le');
  assert.ok(xml.includes(`<UserId>${sid}</UserId>`), xml);
  assert.ok(!xml.includes('<UserId>tester</UserId>'), xml);
  assert.match(xml, /<LogonType>S4U<\/LogonType>/);
  assert.equal(readFileSync(revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.notEqual(WINDOWS_SERVICE_REVISION, '3');
});

test('win32: the same rewrite through `timon service install` needs no --force either', () => {
  const { o, revision, sid } = revision3Task();
  const guard = guardServiceGesture(o, 'install', { force: false, sourceInstallDir: o.installDir });
  assert.equal(guard.refusal, null);
  assert.equal(guard.replacing, null, 'nothing of another installation to take down');
  const installed = installService(o);
  assert.equal(installed.ok, true, installed.lines.join('\n'));
  assert.ok(readFileSync(taskXmlPath(), 'utf16le').includes(`<UserId>${sid}</UserId>`));
  assert.equal(readFileSync(revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.ok(!readFileSync(elevatedScriptPath(), 'utf8').includes('stop-replaced'), 'its own launcher only');
});

test('win32: a rewrite that does not answer puts the task back and stays due', async () => {
  const { h, o, revision, sid } = revision3Task();
  const previous = h.task.xml!;
  const failed = await upgradeDesktopService(upgradeDeps(o, false));
  assert.equal(failed.ok, false);
  assert.equal(failed.fallback, false, 'the previous service serves: no built-in daemon');
  assert.match(failed.reason!, /previous service was restored/);
  assert.equal(readFileSync(taskXmlPath(), 'utf16le').replace(/^﻿/, ''), previous);
  assert.notEqual(readFileSync(revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION, 'the next launch tries again');

  const retried = await upgradeDesktopService(upgradeDeps(o, true));
  assert.equal(retried.ok, true, retried.reason ?? '');
  assert.ok(readFileSync(taskXmlPath(), 'utf16le').includes(`<UserId>${sid}</UserId>`));
  assert.equal(readFileSync(revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
});

/**
 * Revision 6 drops the batch Avast quarantined. A failed upgrade restores the
 * task of revision 5, which runs that batch: it must still be there, and the
 * next launch must try again.
 */
test('win32: the batch of revision 5 stays until the rewritten task answers, then goes', async () => {
  const { o, revision } = revision3Task();
  const batch = windowsServiceFiles(o.timonHome, join).batchLauncher;
  writeFileSync(batch, '@echo off\r\n');
  const deps = (healthy: boolean): UpgradeDeps => ({
    ...upgradeDeps({ ...o, keepBatchLauncher: true }, healthy),
    retire: (opts) => retireBatchLauncher(opts),
  });
  const failed = await upgradeDesktopService(deps(false));
  assert.equal(failed.ok, false);
  assert.equal(existsSync(batch), true, 'the restored task runs it');
  assert.equal(readFileSync(revision, 'utf8').trim(), 'restored', 'due again, and still a task to the desktop');

  const upgraded = await upgradeDesktopService(deps(true));
  assert.equal(upgraded.ok, true, upgraded.reason ?? '');
  assert.equal(existsSync(batch), false);
  assert.equal(readFileSync(revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.ok(existsSync(windowsServiceFiles(o.timonHome, join).launcher), 'the configuration the new task names');
});

test('win32: a task of another home is not rewritten by the update, whatever its revision', async () => {
  const { h, o, revision } = revision3Task();
  register(h, { timonHome: join(o.homeDir, 'real-home'), installDir: o.installDir });
  const refused = await upgradeDesktopService(upgradeDeps(o, true));
  assert.equal(refused.ok, false);
  assert.equal(refused.fallback, true);
  assert.match(refused.reason!, /left in place/);
  assert.equal(readFileSync(revision, 'utf8').trim(), '3');
});

test('the desktop upgrade and `update apply` leave another home alone, their own release moves', async () => {
  const h = host('darwin');
  register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
  assert.match(serviceOfAnotherHome(h.o)!, /left in place/);

  const steps: string[] = [];
  const ok = (): ServiceResult => ({ ok: true, code: 0, lines: [] });
  const deps: UpgradeDeps = {
    platform: 'darwin',
    stage: async () => { steps.push('stage'); },
    options: () => h.o,
    foreign: serviceOfAnotherHome,
    install: () => { steps.push('install'); return ok(); },
    read: () => 'definition',
    restore: () => { steps.push('restore'); return ok(); },
    remove: () => { steps.push('remove'); return ok(); },
    healthy: async () => true,
    mark: async () => {},
    prune: async () => {},
  };
  const refused = await upgradeDesktopService(deps);
  assert.equal(refused.ok, false);
  // Exit 2 of the runner: the desktop runs its built-in daemon.
  assert.equal(refused.fallback, true);
  assert.match(refused.reason!, /left in place/);
  assert.deepEqual(steps.filter((s) => s !== 'stage'), []);

  // Another install or release on its own home is what an upgrade is for.
  const own = host('darwin');
  register(own, { timonHome: own.o.timonHome, installDir: join(own.o.homeDir, 'older', 'orchestrator') });
  assert.equal(foreignService(own.o)?.why, 'install');
  assert.equal(serviceOfAnotherHome(own.o), null);
  const moved = await upgradeDesktopService({ ...deps, options: () => own.o });
  assert.equal(moved.ok, true);
  assert.ok(steps.includes('install'));
});

test('the CLI checks ownership before the temporary-home check, the preflight and any staging', () => {
  const cli = readFileSync(resolve('bin/timon'), 'utf8');
  const start = cli.indexOf('async function cmdService');
  const body = cli.slice(start, cli.indexOf('async function replacesRunningRelease', start));
  const guard = body.indexOf('guardServiceGesture(opts, sub');
  assert.ok(guard > 0);
  for (const later of ['temporaryHomeNotice(', 'mod.installPreflight(opts)', 'installWithRuntime(opts', 'uninstallWithRuntime(opts', 'withCooperativeStop(opts, mod.stopService', 'mod.startService(opts)']) {
    assert.ok(guard < body.indexOf(later), later);
  }
  assert.match(body, /let res = guard\.refusal;\n\s+if \(!res\) switch \(sub\)/);
  // A forced replacement is no release upgrade: the runner would refuse it.
  assert.match(body, /!guard\.replacing && await replacesRunningRelease/);
  assert.match(cli, /timon service install \[--dry-run\] \[--allow-temp-home\] \[--force\]/);
  // `status` shows the double too: it is how a machine already in it finds out.
  assert.match(body, /servicesSharingHome\(opts\)/);
});

/**
 * Linux names a unit after its installation: `timon-orchestrator` for a clone,
 * `timon-desktop-<hash of the home>` for a package. Each gesture only reads its
 * own, so neither saw the other on the same data (TODO #736).
 */
function registerPackaged(h: Host, timonHome = h.o.timonHome, version = '0.2.0'): ServiceOpts {
  const packaged = packagedServiceOptions({ ...h.o, timonHome }, join(h.o.homeDir, 'Timon'), 3110, version);
  const file = unitPath(h.o.homeDir, packaged.unitName);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, packaged.unitContent!);
  return packaged;
}

test('linux: a clone on the home of a packaged service is refused, and nothing is touched', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  const before = readFileSync(unitPath(h.o.homeDir, packaged.unitName), 'utf8');

  const { refusal, replacing } = guardServiceGesture(h.o, 'install');

  assert.ok(refusal, 'a refusal');
  assert.notEqual(refusal.code, 0);
  assert.equal(refusal.written, false);
  assert.equal(replacing, null);
  const text = refusal.lines.join('\n');
  assert.match(refusal.lines[0]!, new RegExp(`^refused: the service ${packaged.unitName} already runs on this data directory`));
  assert.ok(text.includes(`data:       ${h.o.timonHome}`), text);
  assert.ok(text.includes(packaged.installDir), text);
  assert.ok(text.includes(`this command: data ${h.o.timonHome}, install ${h.o.installDir}`), text);
  assert.match(text, /Nothing was changed\. To replace it anyway: timon service install --force/);
  assert.equal(existsSync(unitPath(h.o.homeDir)), false, 'no second unit');
  assert.equal(readFileSync(unitPath(h.o.homeDir, packaged.unitName), 'utf8'), before);
  assert.ok(h.calls.every(READ_ONLY), JSON.stringify(h.calls));

  const dry = guardServiceGesture({ ...h.o, dryRun: true }, 'install');
  assert.match(dry.refusal!.lines[0]!, /^\(dry-run\) would refuse: /);
  assert.notEqual(dry.refusal!.code, 0);
});

test('linux: a package on the home of a clone service is refused the same way', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
  const packaged = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');

  const { refusal } = guardServiceGesture(packaged, 'install');

  assert.ok(refusal);
  assert.match(refusal.lines[0]!, new RegExp(`^refused: the service ${LINUX_UNIT} already runs on this data directory`));
  assert.ok(refusal.lines.join('\n').includes(h.o.installDir));
  assert.equal(existsSync(unitPath(h.o.homeDir, packaged.unitName)), false);
});

test('linux: the same data reached through a link is the same data', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  mkdirSync(h.o.timonHome, { recursive: true });
  const link = join(h.o.homeDir, 'linked-home');
  symlinkSync(h.o.timonHome, link, 'junction');
  registerPackaged(h);
  assert.ok(guardServiceGesture({ ...h.o, timonHome: link }, 'install').refusal, 'another hash, the same database');
});

test('linux: units on another home are none of this gesture\'s business', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const otherHome = join(h.o.homeDir, 'other-home');
  registerPackaged(h, otherHome);
  assert.deepEqual(guardServiceGesture(h.o, 'install'), { refusal: null, replacing: null, notice: null }, 'a clone beside a package on its own home');

  // A release candidate on a throwaway home, beside the clone service of the real one.
  const beside = host('linux');
  register(beside, { timonHome: join(beside.o.homeDir, 'real-home'), installDir: beside.o.installDir });
  const rc = packagedServiceOptions(beside.o, join(beside.o.homeDir, 'Timon'), 3110, '0.2.0');
  assert.deepEqual(guardServiceGesture(rc, 'install'), { refusal: null, replacing: null, notice: null });
});

test('linux: a package updating over its own unit, with no other on the home, needs no flag', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  registerPackaged(h, h.o.timonHome, '0.1.9');
  const update = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
  assert.deepEqual(guardServiceGesture(update, 'install'), { refusal: null, replacing: null, notice: null });
  assert.deepEqual(guardServiceGesture(update, 'uninstall'), { refusal: null, replacing: null, notice: null });
});

test('linux: only a unit proven to run on this home counts', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const dir = dirname(unitPath(h.o.homeDir));
  mkdirSync(dir, { recursive: true });
  // No data directory at all: a helper of the same family, not a daemon.
  writeFileSync(join(dir, 'timon-helper.service'), '[Service]\nExecStart=/usr/bin/true\n');
  // Systemd answers with its specifiers resolved: this one is simply another home.
  writeFileSync(join(dir, 'timon-odd.service'), '[Service]\nEnvironment=TIMON_HOME=%t/timon\nWorkingDirectory=/srv/x\n');
  writeFileSync(join(dir, 'timon-gone.service.bak'), `[Service]\nEnvironment="TIMON_HOME=${h.o.timonHome}"\n`);
  mkdirSync(join(dir, 'timon-drop.service.d'));
  assert.deepEqual(servicesSharingHome(h.o), []);
  assert.deepEqual(guardServiceGesture(h.o, 'install'), { refusal: null, replacing: null, notice: null });
  // The default home is where a unit naming none would be read as running.
  assert.deepEqual(servicesSharingHome({ ...h.o, timonHome: join(h.o.homeDir, '.timon') }), []);
});

test('linux: a no-TIMON_HOME clone unit runs on the default home, so it shares that one', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const defaultHome = join(h.o.homeDir, '.timon');
  const file = unitPath(h.o.homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, '[Service]\nWorkingDirectory=/srv/x\nExecStart=/usr/bin/env node dist/index.js\n');
  const packaged = packagedServiceOptions({ ...h.o, timonHome: defaultHome }, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
  assert.ok(guardServiceGesture(packaged, 'install').refusal);
  assert.equal(guardServiceGesture(packaged, 'install').refusal!.lines.some((l) => l.includes(LINUX_UNIT)), true);
});

/** A drop-in, as `systemctl edit` writes it. */
function dropIn(h: Host, unit: string, content: string): void {
  const dir = `${unitPath(h.o.homeDir, unit)}.d`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'override.conf'), content);
}

test('linux: a drop-in that brings another unit onto this home is refused, and --force takes it down', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h, join(h.o.homeDir, 'other-home'));
  dropIn(h, packaged.unitName, `[Service]\nEnvironment="TIMON_HOME=${h.o.timonHome}"\n`);

  for (const gesture of ['install', 'start'] as const) {
    const { refusal } = guardServiceGesture(h.o, gesture);
    assert.ok(refusal, gesture);
    assert.match(refusal.lines[0]!, new RegExp(`the service ${packaged.unitName} already runs on this data directory`));
    assert.ok(refusal.lines.join('\n').includes(`data:       ${h.o.timonHome}`), refusal.lines.join('\n'));
  }
  assert.deepEqual(guardServiceGesture(h.o, 'install', { force: true }).replacing?.units, [packaged.unitName]);
});

test('linux: a drop-in that takes another unit off this home leaves it alone, even with --force', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  dropIn(h, packaged.unitName, `[Service]\nEnvironment="TIMON_HOME=${join(h.o.homeDir, 'other-home')}"\n`);
  const passes = { refusal: null, replacing: null, notice: null };

  assert.deepEqual(servicesSharingHome(h.o), []);
  assert.deepEqual(guardServiceGesture(h.o, 'install'), passes);
  assert.deepEqual(guardServiceGesture(h.o, 'start'), passes);
  assert.deepEqual(guardServiceGesture(h.o, 'install', { force: true }), passes, 'nothing to take down');

  const res = installService(h.o);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.ok(existsSync(unitPath(h.o.homeDir, packaged.unitName)), 'another home keeps its unit');
  assert.ok(!h.calls.some((c) => c.includes('disable')), JSON.stringify(h.calls));
});

test('linux: the working directory shown is the one systemd runs too', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  dropIn(h, packaged.unitName, '[Service]\nWorkingDirectory=/srv/moved/orchestrator\n');
  assert.equal(servicesSharingHome(h.o)[0]?.installDir, '/srv/moved/orchestrator');
});

test('linux: the home is read out of the whole environment, as systemctl serializes it', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h, join(h.o.homeDir, 'other-home'));
  h.systemd.set(packaged.unitName, () => ({
    code: 0,
    stderr: '',
    stdout: `LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=/srv/x\nEnvironment=PATH=/usr/bin "TIMON_HOME=${h.o.timonHome}" PORT=3010\n`,
  }));
  assert.equal(servicesSharingHome(h.o)[0]?.why, 'shared');
});

/** What systemd cannot vouch for: the unit may run here, and nothing proves it does. */
const UNVERIFIED: Record<string, () => ExecResult> = {
  'changed on disk, not reloaded': () => ({ code: 0, stderr: '', stdout: 'LoadState=loaded\nNeedDaemonReload=yes\nWorkingDirectory=/srv/x\nEnvironment=\n' }),
  'a setting systemd refuses': () => ({ code: 0, stderr: '', stdout: 'LoadState=bad-setting\nNeedDaemonReload=no\n' }),
  'the file is there, systemd does not see it': () => ({ code: 0, stderr: '', stdout: 'LoadState=not-found\nNeedDaemonReload=no\n' }),
  'systemd does not answer': () => ({ code: 1, stderr: 'Failed to connect to bus', stdout: '' }),
  'systemctl cannot run': () => { throw new Error('ENOENT'); },
  'a home that is not a path': () => ({ code: 0, stderr: '', stdout: 'LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=/srv/x\nEnvironment=TIMON_HOME=relative/home\n' }),
  'a home written in a form not understood': () => ({ code: 0, stderr: '', stdout: `LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=/srv/x\nEnvironment="TIMON_HOME=/a"b\n` }),
};

for (const [why, answer] of Object.entries(UNVERIFIED)) {
  test(`linux: ${why}: refused, --force does not get past it, and the unit stays`, { skip: SYSTEMD_IDENTITY }, () => {
    const h = host('linux');
    const packaged = registerPackaged(h);
    const file = unitPath(h.o.homeDir, packaged.unitName);
    const before = readFileSync(file, 'utf8');
    h.systemd.set(packaged.unitName, answer);

    assert.equal(servicesSharingHome(h.o)[0]?.why, 'unverified');
    for (const gesture of ['install', 'start'] as const) {
      for (const force of [false, true]) {
        const { refusal, replacing } = guardServiceGesture(h.o, gesture, { force });
        assert.ok(refusal, `${gesture}, force ${force}`);
        assert.equal(replacing, null);
        assert.notEqual(refusal.code, 0);
        const text = refusal.lines.join('\n');
        assert.match(refusal.lines[0]!, new RegExp(`the service ${packaged.unitName} could not be checked`));
        assert.ok(text.includes(file), text);
        assert.doesNotMatch(text, /(?:install|uninstall) --force/);
        assert.match(text, /systemctl --user daemon-reload/);
      }
    }
    assert.ok(h.calls.every(READ_ONLY), JSON.stringify(h.calls));
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(existsSync(unitPath(h.o.homeDir)), false);

    // The way out of a machine in that state asks nothing of that unit.
    assert.equal(guardServiceGesture(h.o, 'stop').refusal, null);
    assert.equal(guardServiceGesture(h.o, 'uninstall').refusal, null);
  });
}

test('linux: one unit proven and one that cannot be checked: --force touches neither', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  const dir = dirname(unitPath(h.o.homeDir));
  writeFileSync(join(dir, 'timon-stale.service'), '[Service]\nExecStart=/usr/bin/true\n');
  h.systemd.set('timon-stale', UNVERIFIED['changed on disk, not reloaded']!);

  const { refusal, replacing } = guardServiceGesture(h.o, 'install', { force: true });

  assert.ok(refusal);
  assert.equal(replacing, null);
  assert.match(refusal.lines[0]!, /the service timon-stale could not be checked/);
  const text = refusal.lines.join('\n');
  assert.ok(text.includes(packaged.unitName), 'the proven one is named too');
  assert.doesNotMatch(text, /install --force/);
});

test('linux: a foreign service in place and an unchecked unit: the reason is the one --force cannot answer', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  register(h, { timonHome: join(h.o.homeDir, 'real-home'), installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });
  const packaged = registerPackaged(h);
  h.systemd.set(packaged.unitName, UNVERIFIED['systemd does not answer']!);

  const { refusal } = guardServiceGesture(h.o, 'install');

  assert.ok(refusal);
  assert.match(refusal.lines[0]!, new RegExp(`the service ${packaged.unitName} could not be checked`));
  assert.ok(refusal.lines.join('\n').includes(LINUX_UNIT));
  assert.doesNotMatch(refusal.lines.join('\n'), /install --force/);
});

test('linux: no other unit means no call to systemd at all', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  assert.deepEqual(guardServiceGesture(h.o, 'install'), { refusal: null, replacing: null, notice: null });
  assert.deepEqual(h.calls, []);
});

test('linux: start refuses to bring up a second daemon, stop and uninstall still clear the double', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
  const packaged = registerPackaged(h);

  const start = guardServiceGesture(h.o, 'start', { force: true }).refusal;
  assert.ok(start);
  assert.ok(start.lines.join('\n').includes(packaged.unitName));
  assert.doesNotMatch(start.lines.join('\n'), /--force/);
  assert.equal(guardServiceGesture(h.o, 'stop').refusal, null);
  assert.equal(guardServiceGesture(h.o, 'uninstall').refusal, null, 'the way out of the double');
  assert.equal(guardServiceGesture(h.o, 'uninstall', { force: true }).replacing, null, 'its own unit only');

  const removed = uninstallService(h.o);
  assert.equal(removed.ok, true, removed.lines.join('\n'));
  assert.equal(existsSync(unitPath(h.o.homeDir)), false);
  assert.ok(existsSync(unitPath(h.o.homeDir, packaged.unitName)), 'the package keeps its unit');
});

test('linux: --force takes the other unit down before starting its own', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  const marker = join(h.o.timonHome, 'desktop-runtime', 'installed');
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, packaged.unitName);

  const guard = guardServiceGesture(h.o, 'install', { force: true });
  assert.equal(guard.refusal, null);
  assert.deepEqual(guard.replacing?.units, [packaged.unitName]);
  assert.match(guard.notice!, /^replacing the service of another installation \(--force\):/);
  assert.ok(guard.notice!.includes(packaged.unitName));

  const res = installService({ ...h.o, replacing: guard.replacing });

  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(existsSync(unitPath(h.o.homeDir, packaged.unitName)), false);
  assert.ok(readFileSync(unitPath(h.o.homeDir), 'utf8').includes(`Environment="TIMON_HOME=${h.o.timonHome}"`));
  const steps = h.calls.map((c) => c.join(' '));
  const down = steps.indexOf(`systemctl --user disable --now ${packaged.unitName}`);
  assert.ok(down >= 0, JSON.stringify(steps));
  assert.ok(down < steps.indexOf(`systemctl --user enable --now ${LINUX_UNIT}`), JSON.stringify(steps));
  // The desktop reads it to wait for its own service, which is gone.
  assert.equal(existsSync(marker), false);
  assert.equal(guardServiceGesture(h.o, 'install').refusal, null, 'one service left, this one');
});

test('linux: --force over a clone unit leaves the marker of another unit alone', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
  const packaged = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
  const marker = join(h.o.timonHome, 'desktop-runtime', 'installed');
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, packaged.unitName);

  const guard = guardServiceGesture(packaged, 'install', { force: true });
  assert.deepEqual(guard.replacing?.units, [LINUX_UNIT]);
  const res = installService({ ...packaged, replacing: guard.replacing });

  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(existsSync(unitPath(h.o.homeDir)), false);
  assert.ok(existsSync(unitPath(h.o.homeDir, packaged.unitName)));
  assert.equal(readFileSync(marker, 'utf8'), packaged.unitName);
});

test('linux: --force writes nothing when the other unit will not stop', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  const guard = guardServiceGesture(h.o, 'install', { force: true });
  const res = installService({
    ...h.o,
    replacing: guard.replacing,
    exec: (name, args) => {
      if (args.includes('disable')) return { code: 1, stdout: '', stderr: 'access denied' };
      return h.o.exec(name, args);
    },
  });
  assert.equal(res.ok, false);
  assert.notEqual(res.code, 0);
  assert.equal(res.written, false);
  assert.match(res.reason!, new RegExp(`${packaged.unitName} could not be stopped: access denied`));
  assert.equal(existsSync(unitPath(h.o.homeDir)), false, 'two daemons otherwise');
  assert.ok(existsSync(unitPath(h.o.homeDir, packaged.unitName)));
});

test('linux: a dry run with --force says what it would take down, and does it not', { skip: SYSTEMD_IDENTITY }, () => {
  const h = host('linux');
  const packaged = registerPackaged(h);
  const dry = { ...h.o, dryRun: true };
  const guard = guardServiceGesture(dry, 'install', { force: true });
  assert.match(guard.notice!, /^\(dry-run\) would replace the service of another installation/);
  const res = installService({ ...dry, replacing: guard.replacing });
  assert.equal(res.ok, true);
  const text = res.lines.join('\n');
  assert.ok(text.includes(`(dry-run) would remove ${unitPath(h.o.homeDir, packaged.unitName)}`), text);
  assert.ok(existsSync(unitPath(h.o.homeDir, packaged.unitName)));
  assert.equal(existsSync(unitPath(h.o.homeDir)), false);
});

test('linux: an update of the package is not judged on a clone unit beside it', { skip: SYSTEMD_IDENTITY }, async () => {
  const h = host('linux');
  register(h, { timonHome: h.o.timonHome, installDir: h.o.installDir });
  registerPackaged(h, h.o.timonHome, '0.1.9');
  const update = packagedServiceOptions(h.o, join(h.o.homeDir, 'Timon'), 3110, '0.2.0');
  assert.equal(serviceOfAnotherHome(update), null);
  const steps: string[] = [];
  const moved = await upgradeDesktopService({
    platform: 'linux',
    stage: async () => {},
    options: () => update,
    foreign: serviceOfAnotherHome,
    install: () => { steps.push('install'); return { ok: true, code: 0, lines: [] }; },
    read: () => 'definition',
    restore: () => ({ ok: true, code: 0, lines: [] }),
    remove: () => ({ ok: true, code: 0, lines: [] }),
    healthy: async () => true,
    mark: async () => {},
    prune: async () => {},
  });
  assert.equal(moved.ok, true);
  assert.deepEqual(steps, ['install']);
});

test('macOS and Windows have one service name per account: nothing else to read', () => {
  for (const platform of ['darwin', 'win32'] as const) {
    const h = host(platform);
    const dir = dirname(unitPath(h.o.homeDir));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'timon-desktop-x.service'), `[Service]\nEnvironment="TIMON_HOME=${h.o.timonHome}"\n`);
    assert.deepEqual(servicesSharingHome(h.o), [], platform);
  }
});

/** TODO #735: the desktop's runners act on a name fixed per account, whoever registered it. */
for (const platform of ['darwin', 'win32'] as const) {
  const gestures = platform === 'win32' ? [stopService, startService, restartService, restartWindowsService] : [stopService, startService, restartService];

  test(`${platform}: the desktop's service gestures leave the service of another home running`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    for (const gesture of gestures) {
      const h = host(platform);
      const realHome = join(h.o.homeDir, 'real-home');
      register(h, { timonHome: realHome, installDir: join(h.o.homeDir, 'packaged', 'orchestrator') });

      const refused = actOnOwnService(h.o, gesture);

      assert.equal(refused.ok, false, gesture.name);
      assert.equal(refused.code, 1);
      assert.match(refused.reason!, /left in place/);
      assert.deepEqual(h.calls.filter((call) => !READ_ONLY(call)), [], gesture.name);
      assert.equal(existsSync(serviceStoppedMarker(h.o.timonHome)), false, 'and no marker says it was stopped');
    }
  });

  test(`${platform}: the desktop's service gestures act on this home's own service`, { skip: platform === 'linux' && SYSTEMD_IDENTITY }, () => {
    for (const gesture of gestures) {
      const h = host(platform);
      // Another release of this home: an update moves it, the gesture still applies.
      register(h, { timonHome: h.o.timonHome, installDir: join(h.o.homeDir, 'older', 'orchestrator') });
      actOnOwnService(h.o, gesture);
      assert.ok(h.calls.some((call) => !READ_ONLY(call)), gesture.name);
    }
  });
}

test('darwin: a LaunchDaemon of another home is not booted out by the desktop', () => {
  const h = host('darwin');
  const realHome = join(h.o.homeDir, 'real-home');
  const file = launchDaemonPath(h.o.launchDaemonsDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderLaunchDaemonPlist({ ...h.o, timonHome: realHome }));

  assert.match(actOnOwnService(h.o, stopService).reason!, /left in place/);
  assert.deepEqual(h.calls.filter((call) => !READ_ONLY(call)), []);
});

test('the runners the desktop launches go through that check', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const runner = readFileSync(join(here, 'desktop-service-runner.ts'), 'utf8');
  assert.match(runner, /const GESTURES = \{ stop: stopService, start: startService, restart: restartService \} as const;/);
  // Ownership first; inside it, the Windows stop and restart ask the daemon before their kills.
  assert.match(runner, /await actOnOwnService\(opts, async \(o\)[^]*?withCooperativeStop\(o, GESTURES\[action\], ask\)/);
  assert.match(readFileSync(join(here, 'windows-restart-runner.ts'), 'utf8'), /await actOnOwnService\(opts, \(o\) => withCooperativeStop\(o, restartWindowsService, ask\)\)/);
});
