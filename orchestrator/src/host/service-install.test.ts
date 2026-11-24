/**
 * `timon service install|uninstall|status` (step 5.3).
 *
 * Everything runs against a temporary HOME with an injected `exec`: no test
 * ever writes a real unit, calls a real systemctl, or reads the real
 * `TIMON_HOME`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ExecResult } from './types.js';
import { packagedServiceOptions } from './packaged-service.js';
import {
  installService,
  uninstallService,
  statusService,
  renderPlist,
  renderUnit,
  plistPath,
  unitPath,
  LINUX_UNIT,
  MACOS_LABEL,
  WINDOWS_TASK,
  renderTaskXml,
  taskXmlPath,
  TASK_NEVER_RAN_KEPT,
  TASK_NEVER_RAN_REMOVED,
  TASK_VERIFY_SECONDS,
  TASK_SESSION_FALLBACK,
  TASK_LOGON_UNREADABLE,
  TASK_LOGON_FALLBACK_FAILED,
  WINDOWS_SESSION_FALLBACK_NOTICE,
  logonCheckStep,
  sessionTaskXmlPath,
  verifyTaskStartedStep,
  windowsConsoleTaskTrap,
  WINDOWS_TASK_NEVER_RAN,
  WINDOWS_TASK_REFUSED_REASON,
  windowsTaskUserId,
  windowsTaskAction,
  windowsLauncherPath,
  windowsServiceFiles,
  renderWindowsLauncherConfig,
  windowsScriptedTaskArguments,
  launcherProcessFilter,
  retireBatchLauncher,
  windowsLauncherMarked,
  WINDOWS_SERVICE_FLAG,
  stopLauncherStep,
  stopPortOwnerStep,
  stopInstallationProcessesStep,
  installationProcessNeedles,
  PROCESSES_REMAIN,
  serviceStoppedMarker,
  startService,
  stopService,
  windowsStartSteps,
  windowsStopSteps,
  WINDOWS_SERVICE_REVISION,
  elevatedScriptPath,
  elevatedLogPath,
  renderElevatedScript,
  parseElevatedTranscript,
  readServiceDefinition,
  removeServiceDefinition,
  restoreServiceDefinition,
  restartService,
  restartWindowsService,
  windowsRestartSteps,
  repairSessionWitness,
  readSessionWitnessCommand,
  windowsServiceNotes,
  applySessionMode,
  sessionModeNeedsReinstall,
  windowsTaskOffSession,
  type ServiceOpts,
} from './service-install.js';
import { readServiceSessionMode, serviceS4uRefusedPath, writeServiceSessionMode } from './service-session-mode.js';
import { windowsTaskShape } from './windows-task-shape.js';

/**
 * What the elevated batch leaves behind: one line per step run.
 * A step missing from the object did not run: that is how a guard is
 * proved here, rather than by a call the test would have seen go by.
 */
function transcript(codes: Record<string, number>): string {
  return Object.entries(codes).map(([label, code]) => `TIMON-STEP ${label}=${code}\r\n`).join('');
}

/**
 * On a POSIX host a Windows path has no separator: writing to one creates a
 * single file named `\tmp\…\run\timon-service.vbs` in the working directory,
 * and from `orchestrator/` that is the repository (TODO #706). Read when this
 * file loads, so that a leftover from an older run is not blamed on this one.
 */
const backslashNames = (dir: string) => readdirSync(dir).filter((name) => name.includes('\\'));
const backslashNamesAtStart = new Set(backslashNames(process.cwd()));

/**
 * After writing the unit, the Linux path reads `systemctl show` back and only
 * trusts POSIX paths there (`readEffectiveUnit`). The fixture's supervisor
 * echoes the temporary directories, which are `C:\…` on a Windows runner: the
 * unit is then judged foreign and the install refused. That code runs on Linux
 * only, so the tests that need it to accept the unit are skipped on Windows.
 */
const SYSTEMD_IDENTITY = process.platform === 'win32'
  && 'the systemd unit identity is read as POSIX paths, which a Windows temporary directory is not';

/** The Node a Windows package ships, the runtime of its service since revision 5. */
const PACKAGED_NODE = 'C:\\Program Files\\Timon\\resources\\node\\node.exe';

function fixture(platform: NodeJS.Platform, exec?: (n: string, a: string[]) => ExecResult): ServiceOpts {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-service-test-'));
  const installDir = join(homeDir, 'timon', 'orchestrator');
  mkdirSync(join(installDir, 'scripts'), { recursive: true });
  writeFileSync(
    join(installDir, 'scripts', `${LINUX_UNIT}.service.template`),
    // Same placeholders as the shipped template, `@PORT@`/`@HEAP@` included:
    // a fixture that omitted them would let a renderer stop substituting them
    // without any test noticing.
    '[Service]\nWorkingDirectory=@REPO@/orchestrator\nUser=@USER@\n'
    + 'ExecStart=/usr/bin/env node --max-old-space-size=@HEAP@ dist/index.js\n'
    + 'Environment=PORT=@PORT@\n',
    'utf8',
  );
  return {
    platform,
    homeDir,
    timonHome: join(homeDir, '.timon'),
    installDir,
    userName: 'tester',
    uid: 1000,
    heapMb: 4096,
    port: 3000,
    nodePath: '/usr/bin/node',
    exec: (name, args) => {
      if (name === 'systemctl' && args.includes('show')) {
        const file = unitPath(homeDir);
        const unit = existsSync(file) ? readFileSync(file, 'utf8') : '';
        return { code: 0, stderr: '', stdout: unit
          ? `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${installDir}\nEnvironment=TIMON_HOME=${join(homeDir, '.timon')}`
          : 'LoadState=not-found' };
      }
      return exec ? exec(name, args) : { code: 0, stdout: 'active', stderr: '' };
    },
  };
}

test('linux: the shipped template is rendered, linger is enabled on the user\'s answer, the unit is started', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService({ ...opts, sessionMode: 'always' });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);

  const written = readFileSync(unitPath(opts.homeDir), 'utf8');
  assert.match(written, /WorkingDirectory=.*\/timon\/orchestrator/);
  assert.match(written, /User=tester/);
  assert.ok(!written.includes('@REPO@'), 'no placeholder left behind');

  assert.deepEqual(calls[0], ['loginctl', 'enable-linger', 'tester']);
  assert.deepEqual(calls[1], ['systemctl', '--user', 'daemon-reload']);
  assert.deepEqual(calls[2], ['systemctl', '--user', 'enable', '--now', LINUX_UNIT]);
});

test('linux: without the user\'s answer, lingering is never touched (audit F2)', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: n === 'loginctl' ? 'yes\n' : '', stderr: '' };
  });
  assert.equal(installService({ ...opts, sessionMode: null }).ok, true);
  assert.ok(!calls.some((c) => c[0] === 'loginctl'), JSON.stringify(calls));
  assert.deepEqual(calls[0], ['systemctl', '--user', 'daemon-reload']);
});

/**
 * The onboarding's "only while I'm logged in" on an account whose lingering
 * was already on: left on, the daemon would outlive the logout the user just
 * declined. Turned off, and the result says what else that stops.
 */
test('linux: an explicit "session" turns an existing lingering off and says what else stops (audit F2)', { skip: SYSTEMD_IDENTITY }, () => {
  let linger = 'yes';
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    if (n === 'loginctl' && a[0] === 'disable-linger') linger = 'no';
    return { code: 0, stdout: n === 'loginctl' && a[0] === 'show-user' ? `${linger}\n` : '', stderr: '' };
  });
  assert.equal(statusService(opts).lingering, true, 'the onboarding reads it before the question');
  calls.length = 0;
  const res = installService({ ...opts, sessionMode: 'session' });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.deepEqual(calls.filter((c) => c[0] === 'loginctl'), [
    ['loginctl', 'show-user', 'tester', '--property=Linger', '--value'],
    ['loginctl', 'disable-linger', 'tester'],
  ]);
  assert.match(res.lines.join('\n'), /other user services also stop when you log out/);
  const after = statusService(opts);
  assert.equal(after.offSession, false, 'the machine now stops Timon at logout');
  assert.equal(after.lingering, false);
});

test('linux: an explicit "session" with lingering already off changes nothing', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: n === 'loginctl' ? 'no\n' : '', stderr: '' };
  });
  const res = installService({ ...opts, sessionMode: 'session' });
  assert.equal(res.ok, true);
  assert.ok(!calls.some((c) => c[1] === 'disable-linger' || c[1] === 'enable-linger'), JSON.stringify(calls));
  assert.doesNotMatch(res.lines.join('\n'), /other user services/);
});

test('linux: a "session" only read from the file (a later reinstall) leaves a lingering switched on since', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: n === 'loginctl' ? 'yes\n' : '', stderr: '' };
  });
  writeServiceSessionMode(opts.timonHome, 'session');
  assert.equal(installService(opts).ok, true);
  assert.ok(!calls.some((c) => c[0] === 'loginctl'), JSON.stringify(calls));
});

test('linux: a lingering that will not go off is said, and the install still stands', { skip: SYSTEMD_IDENTITY }, () => {
  const opts = fixture('linux', (n, a) => {
    if (n === 'loginctl' && a[0] === 'disable-linger') return { code: 1, stdout: '', stderr: 'Access denied' };
    return { code: 0, stdout: n === 'loginctl' ? 'yes\n' : '', stderr: '' };
  });
  const res = installService({ ...opts, sessionMode: 'session' });
  assert.equal(res.ok, true);
  assert.match(res.lines.join('\n'), /lingering could not be turned off \(Access denied\): Timon keeps running after you log out/);
});

test('linux: the recorded answer is what an install with no explicit one follows', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  writeServiceSessionMode(opts.timonHome, 'always');
  assert.equal(installService(opts).ok, true);
  assert.deepEqual(calls[0], ['loginctl', 'enable-linger', 'tester']);
});

test('linux: changing the answer switches lingering in place and records it, the unit untouched', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const on = applySessionMode(opts, 'always');
  assert.equal(on.ok, true, on.lines.join('\n'));
  assert.equal(readServiceSessionMode(opts.timonHome), 'always');
  const off = applySessionMode(opts, 'session');
  assert.equal(off.ok, true);
  assert.equal(readServiceSessionMode(opts.timonHome), 'session');
  assert.deepEqual(calls, [['loginctl', 'enable-linger', 'tester'], ['loginctl', 'disable-linger', 'tester']]);
  assert.match(off.lines.join('\n'), /other user services/);
  assert.equal(sessionModeNeedsReinstall('linux'), false);
  assert.equal(existsSync(unitPath(opts.homeDir)), false, 'no unit written by a change of answer');
});

test('linux: a refused loginctl is a failure that says why', () => {
  const opts = fixture('linux', () => ({ code: 1, stdout: '', stderr: 'Access denied' }));
  const res = applySessionMode(opts, 'always');
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'Access denied');
});

test('the answer is refused where it would change nothing (FreeBSD), and nothing is recorded', () => {
  const opts = fixture('freebsd');
  const res = applySessionMode(opts, 'session');
  assert.equal(res.ok, false);
  assert.equal(readServiceSessionMode(opts.timonHome), null);
});

test('windows: changing the answer records it and asks for the task to be registered again', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  const res = applySessionMode(opts, 'always');
  assert.equal(res.ok, true);
  assert.equal(readServiceSessionMode(opts.timonHome), 'always');
  assert.equal(sessionModeNeedsReinstall('win32'), true);
  assert.deepEqual(calls, [], 'nothing runs before the reinstall, which elevates once');
});

test('linux status reads lingering from loginctl: "not logged in or lingering" is a no', { skip: SYSTEMD_IDENTITY }, () => {
  const read = (linger: ExecResult) => {
    const opts = fixture('linux', (n) => (n === 'loginctl' ? linger : { code: 0, stdout: '', stderr: '' }));
    assert.equal(installService({ ...opts, sessionMode: null }).ok, true);
    return statusService(opts);
  };
  const on = read({ code: 0, stdout: 'yes\n', stderr: '' });
  assert.equal(on.offSession, true);
  assert.match(on.lines.join('\n'), /logged out: keeps running/);
  assert.equal(read({ code: 0, stdout: 'no\n', stderr: '' }).offSession, false);
  assert.equal(read({ code: 1, stdout: '', stderr: 'User tester is not logged in or lingering.' }).offSession, false);
  assert.equal(read({ code: 1, stdout: '', stderr: 'Failed to connect to bus' }).offSession, undefined, 'unknown is not a no');
});

test('linux: a refusing systemctl is a failure, not a silent success', () => {
  const opts = fixture('linux', (n, a) => (
    a.includes('enable') ? { code: 1, stdout: '', stderr: 'Failed to enable' } : { code: 0, stdout: '', stderr: '' }
  ));
  const res = installService(opts);
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.ok(res.lines.some((l) => l.includes('Failed to enable')));
});

test('linux: enable returning zero does not validate a malformed unit', () => {
  const opts = fixture('linux');
  opts.exec = (_name, args) => ({ code: 0, stderr: '', stdout: args.includes('show')
    ? `LoadState=${existsSync(unitPath(opts.homeDir)) ? 'bad-setting' : 'not-found'}\nNeedDaemonReload=no`
    : '' });
  const result = installService(opts);
  assert.equal(result.ok, false);
  assert.equal(result.installed, false);
  assert.match(result.reason!, /Cannot verify/);
});

test('linux: repair the known packaged template, but refuse foreign units, changed commands and drop-ins', { skip: SYSTEMD_IDENTITY }, () => {
  for (const scenario of ['ours', 'foreign', 'command', 'drop-in', 'unavailable']) {
    const base = fixture('linux');
    const opts = { ...packagedServiceOptions(base, '/package/timon', 3110), pendingHandover: true };
    const file = unitPath(opts.homeDir, opts.unitName);
    mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
    let legacy = opts.legacyUnitContent!.replace(/^Environment="PATH=.*"$/m, 'Environment="PATH=/tmp/old-mount:/usr/bin"');
    if (scenario === 'foreign') legacy = legacy.replaceAll(opts.timonHome, '/another/home');
    if (scenario === 'command') legacy += 'ExecStartPost=/usr/bin/true\n';
    writeFileSync(file, legacy);
    const calls: string[][] = [];
    opts.exec = (name, args) => {
      calls.push([name, ...args]);
      if (!args.includes('show')) return { code: 0, stdout: '', stderr: '' };
      if (scenario === 'unavailable') return { code: 1, stdout: '', stderr: 'No bus' };
      const bad = readFileSync(file, 'utf8').includes('WorkingDirectory="');
      return { code: 0, stderr: '', stdout:
        `LoadState=${bad ? 'bad-setting' : 'loaded'}\nNeedDaemonReload=no\nActiveState=active\nUnitFileState=enabled\n`
        + `WorkingDirectory=${opts.installDir}\nEnvironment="TIMON_HOME=${opts.timonHome}"\n`
        + `FragmentPath=${file}\nDropInPaths=${scenario === 'drop-in' ? '/some/override.conf' : ''}` };
    };
    const result = installService(opts);
    assert.equal(result.ok, scenario === 'ours', scenario);
    if (scenario === 'ours') {
      assert.equal(readFileSync(file, 'utf8'), opts.unitContent);
      assert.equal(statusService(opts).installed, true);
      assert.equal(statusService(opts).ok, false, 'handover still waits for the embedded daemon');
    } else {
      assert.equal(readFileSync(file, 'utf8'), legacy);
      assert.ok(calls.every((call) => call.includes('show')), scenario);
    }
  }
});

test('a missing template refuses instead of inventing a unit', () => {
  const opts = fixture('linux');
  const res = installService({ ...opts, installDir: join(opts.homeDir, 'nowhere') });
  assert.equal(res.ok, false);
  assert.ok(res.lines.some((l) => l.includes('template not found')));
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
});

test('macos: the plist declares KeepAlive, RunAtLoad and an explicit PATH', () => {
  const opts = fixture('darwin');
  const xml = renderPlist(opts);
  assert.match(xml, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(xml, /<string>\/usr\/bin\/node<\/string>/);
  assert.match(xml, /--max-old-space-size=4096/);
  // Joined with the host separator: only a macOS host writes a plist for real.
  assert.match(xml, /\.local[\\/]bin/, 'PATH must carry ~/.local/bin, where claude lives');
  assert.ok(xml.includes(join(opts.timonHome, 'tmp', 'daemon.log')));
});

test('macos: a packaged Electron daemon is forced into Node mode', () => {
  const opts = fixture('darwin');
  const xml = renderPlist({
    ...opts,
    nodePath: '/Applications/Timon.app/Contents/MacOS/Timon',
    environment: {
      ELECTRON_RUN_AS_NODE: '1',
      TIMON_INSTALL_DIR: opts.installDir,
      TIMON_DESKTOP_SERVICE: '1',
    },
  });
  assert.match(xml, /<key>ELECTRON_RUN_AS_NODE<\/key><string>1<\/string>/);
  assert.match(xml, /<key>TIMON_INSTALL_DIR<\/key>/);
  assert.match(xml, /<key>TIMON_DESKTOP_SERVICE<\/key><string>1<\/string>/);
});

test('macos: bootout precedes bootstrap so a reinstall is not an EEXIST', () => {
  const calls: string[][] = [];
  const opts = fixture('darwin', (n, a) => {
    calls.push([n, ...a]);
    return { code: a[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
  });
  const res = installService(opts);
  assert.equal(res.ok, true);
  assert.deepEqual(calls[0], ['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`]);
  assert.equal(calls[1]?.[1], 'print');
  assert.equal(calls[2]?.[1], 'bootstrap');
  assert.ok(existsSync(plistPath(opts.homeDir)));
});

test('macos: wait for asynchronous bootout completion before loading the replacement', () => {
  let polls = 0;
  let pauses = 0;
  const opts = fixture('darwin', (_name, args) => {
    if (args[0] === 'print') return { code: ++polls >= 4 ? 113 : 0, stdout: '', stderr: '' };
    if (args[0] === 'bootstrap') assert.equal(polls, 4, 'the old job must have disappeared');
    return { code: 0, stdout: '', stderr: '' };
  });
  opts.pause = (ms) => { assert.equal(ms, 100); pauses++; };
  assert.equal(installService(opts).ok, true);
  assert.equal(pauses, 3);
});

test('macos: a stuck removal or failed probe cannot bootstrap a competing instance', () => {
  for (const probeCode of [0, 1]) {
    let polls = 0;
    const opts = fixture('darwin', (_name, args) => {
      assert.notEqual(args[0], 'bootstrap');
      if (args[0] === 'print') { polls++; return { code: probeCode, stdout: '', stderr: 'probe refused' }; }
      return { code: 0, stdout: '', stderr: '' };
    });
    opts.pause = () => {};
    assert.equal(installService(opts).ok, false);
    assert.equal(polls, probeCode === 0 ? 100 : 1);
  }
});

test('macos: first install and a bootstrap refusal do not wait on a nonexistent job', () => {
  for (const bootstrapCode of [0, 5]) {
    const opts = fixture('darwin', (_name, args) => {
      assert.notEqual(args[0], 'print');
      return { code: args[0] === 'bootout' ? 3 : bootstrapCode, stdout: '', stderr: 'bootstrap refused' };
    });
    assert.equal(installService(opts).ok, bootstrapCode === 0);
  }
});

/**
 * Windows (step 5.7.2): installing the service is mandatory there as
 * elsewhere. Amendment to plan §5.3, which declared it "not supported in v1".
 *
 * None of this can be run here: the only possible check
 * is the exact argv, and that is precisely where it breaks silently (an unquoted
 * `C:\Program Files\…` path produces a task that fails at the first
 * logon, without a message).
 */
test('windows: the scheduled task is created from an XML, at boot, in S4U', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService({
    ...opts,
    sessionMode: 'always',
    nodePath: PACKAGED_NODE,
    readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.code, 0);
  assert.match(res.lines.join('\n'), /starts at boot and keeps running after logoff/);

  const files = windowsServiceFiles(opts.timonHome, join);
  assert.equal(readFileSync(files.launcher, 'utf8'), renderWindowsLauncherConfig({ ...opts, nodePath: PACKAGED_NODE }));
  // The revision is what tells the desktop this task needs no migration.
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  if (process.platform !== 'win32') {
    assert.equal(existsSync(windowsLauncherPath(opts.timonHome)), false,
      'Windows separators must not become a literal filename in the working directory');
  }

  // Three calls. First the witness, sealed in the user's OWN session: an
  // elevation may belong to another account, whose DPAPI key would never
  // open under the task's logon. The account SID, for the same reason. Then
  // ONE elevation for every schtasks step.
  assert.equal(calls.length, 3);
  assert.equal(calls[0]![0], 'powershell');
  const seal = calls[0]!.at(-1)!;
  assert.deepEqual(calls[1], ['whoami', '/user', '/fo', 'csv', '/nh']);
  assert.doesNotMatch(seal, /RunAs/);
  assert.match(seal, /ConvertFrom-SecureString/);
  assert.ok(seal.includes(files.sessionWitness), 'the witness is sealed where the launcher reads it');
  assert.equal(calls[2]![0], 'powershell');
  const command = calls[2]!.at(-1)!;
  assert.match(command, /Start-Process/);
  assert.match(command, /-Verb RunAs/);
  assert.ok(command.includes(elevatedScriptPath()), 'the elevated script is the one just written');

  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  // `/Run`: the created task would only start at the next boot, and the
  // first launch screen waits for an answer from the service. And in between, the
  // daemon a reinstall replaces: IgnoreNew would ignore `/Run`.
  // Onboarding: the embedded daemon on the port serves the wizard, never ended.
  assert.doesNotMatch(batch, /Get-NetTCPConnection/);
  const order = ['schtasks /Create /TN TimonOrchestrator /XML', 'taskkill.exe /F /T', 'schtasks /Run /TN TimonOrchestrator']
    .map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
  // The schtasks output is read as is: without this code page, an
  // "Access denied" reaches the UI garbled.
  assert.match(batch, /chcp 65001/);

  const xml = readFileSync(taskXmlPath(), 'utf16le');
  assert.equal(xml.replace(/^\ufeff/, ''), renderTaskXml({ ...opts, nodePath: PACKAGED_NODE, offSession: true }));
  // At boot, without a session: an InteractiveToken task died on logout.
  assert.match(xml, /<BootTrigger><Enabled>true<\/Enabled><\/BootTrigger>/);
  assert.match(xml, /<LogonType>S4U<\/LogonType>/);
  assert.doesNotMatch(xml, /LogonTrigger|InteractiveToken|<Password>/);
  // The supervisor: an endless repetition that IgnoreNew sets aside as long as the
  // launcher holds a live daemon, and that restarts it otherwise; RestartOnFailure
  // only restarts a failed launch, never a daemon that falls.
  assert.match(xml, /<TimeTrigger>[\s\S]*<Interval>PT5M<\/Interval>[\s\S]*<StopAtDurationEnd>false<\/StopAtDurationEnd>[\s\S]*<\/TimeTrigger>/);
  assert.doesNotMatch(xml, /<Duration>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
  assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
  assert.match(xml, /<RestartOnFailure>/);
  // Never admin rights: that is what tells a task from a real service.
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  assert.doesNotMatch(xml, /HighestAvailable/);
});

/**
 * "Only while I'm logged in" on Windows (audit F2): a task started at logon
 * with the user's interactive token, which Windows ends at logoff
 * (SERVICE-HORS-SESSION W3) — never the boot task under S4U.
 */
test('windows: "session" registers a logon task under the interactive token, with no console', () => {
  const calls: string[][] = [];
  const opts = { ...fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; }), nodePath: PACKAGED_NODE };
  const res = installService({ ...opts, sessionMode: 'session', readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.match(res.lines.join('\n'), /starts at logon and stops when you log off/);
  assert.ok(!calls.some((c) => c[0] === 'schtasks'), 'an answer given needs no look at the task in place');
  const xml = readFileSync(taskXmlPath(), 'utf16le');
  assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><UserId>tester<\/UserId><\/LogonTrigger>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.doesNotMatch(xml, /BootTrigger|S4U|<Password>/);
  // Same supervisor as the boot task, and never more rights.
  assert.match(xml, /<TimeTrigger>[\s\S]*<Interval>PT5M<\/Interval>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  // In the user's session a console program would open a window, and closing
  // it would kill Timon: the package's own GUI program starts the launcher.
  assert.match(xml, /<Command>C:\\Program Files\\Timon\\Timon\.exe<\/Command>/);
  assert.ok(xml.includes(`<Arguments>${WINDOWS_SERVICE_FLAG} &quot;${windowsLauncherPath(opts.timonHome)}&quot;</Arguments>`), xml);
  // The configuration stopLauncherStep looks for, as the launcher reads it.
  assert.equal(readFileSync(windowsServiceFiles(opts.timonHome, join).launcher, 'utf8'), renderWindowsLauncherConfig(opts));
});

/**
 * Avast and AVG quarantined `C:\Windows\System32\Tasks\TimonOrchestrator`
 * (`CMD:Heur.BZC.WBO.Boxter`): a batch or a hidden PowerShell started at boot
 * or logon. The heuristic reads the whole file, so the whole XML is checked.
 */
test('windows: the packaged task holds no batch, no PowerShell and no Hidden, in either mode', () => {
  for (const offSession of [true, false]) {
    const xml = renderTaskXml({ userName: 'robin', ...WINDOWS_PATHS, offSession });
    assert.doesNotMatch(xml, /<Hidden>/, `offSession=${offSession}`);
    assert.doesNotMatch(xml, /cmd\.exe|\.cmd\b|powershell|-WindowStyle|-Command|ComSpec|wscript|\.vbs\b/i, xml);
    const command = /<Command>([^<]*)<\/Command>/.exec(xml)?.[1];
    assert.equal(command, offSession ? PACKAGED_NODE : 'C:\\Program Files\\Timon\\Timon.exe');
  }
});

test('windows: a source checkout, which has no Timon.exe, hides the launcher through PowerShell in the session only', () => {
  const checkout = { timonHome: "C:\\Users\\o'neil\\.timon", installDir: 'C:\\src\\timon\\orchestrator', nodePath: 'C:\\Program Files\\nodejs\\node.exe' };
  // Off session, session 0: its Node is started directly, as in a package.
  assert.deepEqual(windowsTaskAction(checkout, true), {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: `"C:\\src\\timon\\orchestrator\\dist\\host\\windows-service-launcher.js" "C:\\Users\\o'neil\\.timon\\run\\timon-service.json"`,
  });
  const session = windowsTaskAction(checkout, false);
  assert.equal(session.command, 'powershell.exe');
  const args = windowsScriptedTaskArguments(checkout);
  assert.equal(session.args, args);
  assert.ok(args.startsWith('-NoProfile -NonInteractive -WindowStyle Hidden -Command "'), args);
  assert.match(args, /CreateNoWindow = \$true/);
  assert.match(args, /WaitForExit\(\)/);
  assert.doesNotMatch(args, /Start-Process|-EncodedCommand|wscript|\.vbs|ELECTRON_RUN_AS_NODE/i);
  // A quote in the home stays inside the PowerShell literal.
  assert.ok(args.includes("'C:\\Users\\o''neil\\.timon\\run\\timon-service.json'"), args);
  // Only the two quotes that open and close the -Command value.
  assert.equal(args.split('"').length - 1, 2, args);
  // Electron run as Node needs its flag, which an action cannot set: PowerShell sets it on the launcher.
  const electron = { ...checkout, nodePath: 'C:\\src\\timon\\desktop\\node_modules\\electron\\dist\\electron.exe' };
  assert.equal(windowsTaskAction(electron, true).command, 'powershell.exe');
  assert.match(windowsScriptedTaskArguments(electron), /EnvironmentVariables\['ELECTRON_RUN_AS_NODE'\] = '1'/);
});

test('windows: with no answer, the task in place is kept as found; a first install stops with the session', () => {
  const task = (logonType: string | null) => (n: string, a: string[]): ExecResult => {
    if (n === 'schtasks' && a[0] === '/Query') {
      return logonType ? { code: 0, stdout: `<Task><Principals><Principal><LogonType>${logonType}</LogonType></Principal></Principals></Task>`, stderr: '' }
        : { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' };
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  const unreadable = (n: string, a: string[]): ExecResult => (n === 'schtasks' && a.includes('/XML')
    ? { code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }
    : { code: 0, stdout: '', stderr: '' });
  for (const [exec, expected, label] of [
    [task('S4U'), 'S4U', 'boot task in place'],
    [task('InteractiveToken'), 'InteractiveToken', 'logon task in place'],
    [task(null), 'InteractiveToken', 'no task'],
    // Every release before the question registered the boot task.
    [unreadable, 'S4U', 'registered, definition unreadable'],
  ] as const) {
    const found = label;
    const opts = fixture('win32', exec);
    const res = installService({ ...opts, sessionMode: null, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
    assert.equal(res.ok, true, res.lines.join('\n'));
    assert.match(readFileSync(taskXmlPath(), 'utf16le'), new RegExp(`<LogonType>${expected}</LogonType>`), String(found));
  }
});

test('#116: with no answer, a task switched by hand to the session is reinstalled off session if it kept its boot trigger', () => {
  const task = (command: string, triggers: string) => (n: string, a: string[]): ExecResult => (n === 'schtasks' && a[0] === '/Query'
    ? { code: 0, stdout: `<Task><Triggers>${triggers}</Triggers><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals><Actions><Exec><Command>${command}</Command></Exec></Actions></Task>`, stderr: '' }
    : { code: 0, stdout: '', stderr: '' });
  const boot = '<BootTrigger /><TimeTrigger />';
  const logon = '<LogonTrigger /><TimeTrigger />';
  for (const [exec, sessionMode, expected, label] of [
    [task('cmd.exe', boot), null, 'S4U', 'console task, boot trigger kept'],
    [task('cmd.exe', logon), null, 'InteractiveToken', 'console task, logon trigger only'],
    [task('cmd.exe', boot), 'session', 'InteractiveToken', 'the recorded answer wins over the trigger'],
    [task('C:\\Timon\\Timon.exe', boot), null, 'InteractiveToken', 'session task with no console: kept as found'],
  ] as const) {
    const opts = fixture('win32', exec);
    const res = installService({ ...opts, sessionMode, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
    assert.equal(res.ok, true, res.lines.join('\n'));
    assert.match(readFileSync(taskXmlPath(), 'utf16le'), new RegExp(`<LogonType>${expected}</LogonType>`), label);
  }
});

test('windows: status reads what the registered task does at logoff from its logon type', () => {
  const read = (stdout: string, code = 0) => windowsTaskOffSession({ exec: () => ({ code, stdout, stderr: '' }) });
  assert.equal(read('<LogonType>S4U</LogonType>'), true);
  assert.equal(read('<LogonType>Password</LogonType>'), true);
  assert.equal(read('<LogonType>InteractiveToken</LogonType>'), false);
  assert.equal(read('', 1), null, 'no task: unknown, never a guess');
  assert.equal(read('<Task/>'), null);
  assert.equal(windowsTaskOffSession({ exec: () => { throw new Error('ENOENT'); } }), null);

  const opts = fixture('win32', (n, a) => {
    if (n === 'schtasks' && a.includes('LIST')) return { code: 0, stdout: 'Status: Running\r\n', stderr: '' };
    if (n === 'schtasks' && a.includes('/XML')) return { code: 0, stdout: '<LogonType>InteractiveToken</LogonType>', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const status = statusService(opts);
  assert.equal(status.offSession, false);
  assert.match(status.lines.join('\n'), /logged out: stops when you log out/);
});

test('#116: status names the logon and the program of the task, and warns of a console in the session', () => {
  const status = (xml: string) => statusService(fixture('win32', (n, a) => {
    if (n === 'schtasks' && a.includes('LIST')) return { code: 0, stdout: 'Status: Running\r\n', stderr: '' };
    if (n === 'schtasks' && a.includes('/XML')) return { code: 0, stdout: xml, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }));
  const task = (logon: string, command: string) => `<Task><Principals><Principal><LogonType>${logon}</LogonType></Principal></Principals><Actions><Exec><Command>${command}</Command></Exec></Actions></Task>`;
  const visible = status(task('InteractiveToken', 'cmd.exe'));
  const text = visible.lines.join('\n');
  assert.match(text, /logon {5}: InteractiveToken/);
  assert.match(text, /action {4}: cmd\.exe/);
  assert.match(text, /console {3}: visible - TimonOrchestrator starts cmd\.exe in your session.*timon service install/);
  assert.equal(visible.taskShape?.consoleVisible, true);
  assert.equal(visible.offSession, false, 'read from the same definition');

  const boot = status(task('S4U', 'C:\\Timon\\resources\\node\\node.exe'));
  assert.match(boot.lines.join('\n'), /action {4}: node\.exe/);
  assert.doesNotMatch(boot.lines.join('\n'), /console/);
  assert.equal(boot.offSession, true);

  const unreadable = status('ERROR: Access is denied.');
  assert.equal(unreadable.taskShape, undefined);
  assert.doesNotMatch(unreadable.lines.join('\n'), /logon {5}:|action {4}:/);
});

test('#116: status and the diagnostic share one rule for a console worth reinstalling over', () => {
  const shape = (program: string, consoleVisible = true) => ({ logon: 'InteractiveToken' as const, program, triggers: ['Logon' as const], consoleVisible });
  assert.equal(windowsConsoleTaskTrap(shape('cmd.exe'), false), true);
  assert.equal(windowsConsoleTaskTrap(shape('cmd.exe'), true), true);
  assert.equal(windowsConsoleTaskTrap(shape('timon.exe', false), true), false);
  // A source checkout's session task is a hidden PowerShell by design; a package never starts one.
  assert.equal(windowsConsoleTaskTrap(shape('powershell.exe'), false), false);
  assert.equal(windowsConsoleTaskTrap(shape('powershell.exe'), true), true);

  // The test runner is a source checkout: status no longer tells it to reinstall its PowerShell task.
  const task = `<Task><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals><Actions><Exec><Command>powershell.exe</Command></Exec></Actions></Task>`;
  const res = statusService(fixture('win32', (n, a) => {
    if (n === 'schtasks' && a.includes('LIST')) return { code: 0, stdout: 'Status: Running\r\n', stderr: '' };
    if (n === 'schtasks' && a.includes('/XML')) return { code: 0, stdout: task, stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  }));
  assert.match(res.lines.join('\n'), /action {4}: powershell\.exe/);
  assert.doesNotMatch(res.lines.join('\n'), /console {3}: visible/);
});

test('windows: without a sealed session witness, nothing is elevated or registered', () => {
  const calls: string[][] = [];
  const res = installService(fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 1, stdout: '', stderr: 'DPAPI unavailable' };
  }));
  assert.equal(res.ok, false);
  assert.equal(res.written, false, 'the task in place was not touched');
  assert.equal(calls.length, 1);
  assert.match(res.lines.join(' '), /could not seal the session witness.*DPAPI unavailable/);
});

const WINDOWS_PATHS = {
  timonHome: 'C:\\Users\\robin\\.timon',
  installDir: 'C:\\Program Files\\Timon\\resources\\orchestrator',
  heapMb: 4096,
  port: 3010,
  nodePath: 'C:\\Program Files\\Timon\\resources\\node\\node.exe',
};

/**
 * The task starts the launcher, which HOLDS the daemon. The `wscript` launcher
 * of revision 1 returned at once: the task no longer followed its daemon, and
 * nothing could restart a fallen daemon. Off session, the launcher runs on the
 * package's Node directly: an S4U task runs in session 0, which nobody sees.
 */
test('windows: the boot task starts the launcher on the package\'s Node, no shell in between', () => {
  assert.equal(windowsLauncherPath(WINDOWS_PATHS.timonHome), 'C:\\Users\\robin\\.timon\\run\\timon-service.json');
  assert.deepEqual(windowsTaskAction(WINDOWS_PATHS, true), {
    command: 'C:\\Program Files\\Timon\\resources\\node\\node.exe',
    args: '"C:\\Program Files\\Timon\\resources\\orchestrator\\dist\\host\\windows-service-launcher.js" "C:\\Users\\robin\\.timon\\run\\timon-service.json"',
  });
  assert.deepEqual(windowsTaskAction(WINDOWS_PATHS, false), {
    command: 'C:\\Program Files\\Timon\\Timon.exe',
    args: '--timon-service "C:\\Users\\robin\\.timon\\run\\timon-service.json"',
  });
  assert.throws(() => windowsTaskAction({ ...WINDOWS_PATHS, timonHome: 'C:\\a"b' }, true), /Invalid service value/);
});

test('windows: the launcher configuration carries what the batch set, for the daemon only', () => {
  const config = JSON.parse(renderWindowsLauncherConfig(WINDOWS_PATHS)) as {
    format: number; node: string; args: string[]; cwd: string; env: Record<string, string>; log: string; rotateBytes: number; witness: { file: string; args: string[] };
  };
  assert.equal(config.node, WINDOWS_PATHS.nodePath);
  assert.deepEqual(config.args, ['--max-old-space-size=4096', 'C:\\Program Files\\Timon\\resources\\orchestrator\\dist\\boot.js']);
  assert.equal(config.cwd, WINDOWS_PATHS.installDir);
  assert.equal(config.env.TIMON_HOME, 'C:\\Users\\robin\\.timon');
  assert.equal(config.env.PORT, '3010');
  // The Node the package ships ignores the flag and would pass it on to every child.
  assert.equal(config.env.ELECTRON_RUN_AS_NODE, undefined);
  // `>>daemon.log 2>&1`, rotated at 10 MiB.
  assert.equal(config.log, 'C:\\Users\\robin\\.timon\\tmp\\daemon.log');
  assert.equal(config.rotateBytes, 10485760);
  // The witness is judged by the command `timon service repair` uses.
  assert.equal(config.witness.file, 'C:\\Users\\robin\\.timon\\run\\session-witness.dpapi');
  assert.deepEqual(config.witness.args, readSessionWitnessCommand(config.witness.file));
  // No batch escaping any more: a % is a %.
  assert.equal((JSON.parse(renderWindowsLauncherConfig({ ...WINDOWS_PATHS, timonHome: 'C:\\Users\\100%\\.timon' })) as typeof config).env.TIMON_HOME, 'C:\\Users\\100%\\.timon');
  assert.throws(() => renderWindowsLauncherConfig({ ...WINDOWS_PATHS, nodePath: 'C:\\a"b.exe' }), /Invalid service value/);
  assert.throws(() => renderWindowsLauncherConfig({ ...WINDOWS_PATHS, environment: { 'A B': '1' } }), /Invalid service environment/);
});

/**
 * TODO #342: `userInfo().username` alone (`guilldu`) named an account that
 * Windows knows as `EUROPE\guilldu` on a machine joined to Entra ID. The
 * principal is the SID read by `whoami` in the user's session; failing
 * that `DOMAIN\user`, then the bare name.
 */
test('windows: the task principal is the account SID, otherwise DOMAIN\\user', () => {
  const sid = 'S-1-12-1-1234567890-123456789-1234567890-123456789';
  const whoami = (stdout: string, code = 0) => (n: string): ExecResult =>
    (n === 'whoami' ? { code, stdout, stderr: '' } : { code: 0, stdout: '', stderr: '' });
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami(`"europe\\guilldu","${sid}"\r\n`) }), sid);
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami('', 1) }), 'EUROPE\\guilldu');
  assert.equal(windowsTaskUserId({ userName: 'guilldu', userDomain: 'EUROPE', exec: whoami('"europe\\guilldu","garbage"') }), 'EUROPE\\guilldu');
  assert.equal(windowsTaskUserId({ userName: 'guilldu', exec: () => { throw new Error('ENOENT'); } }), 'guilldu');

  const opts = fixture('win32', whoami(`"europe\\guilldu","${sid}"\r\n`));
  for (const sessionMode of ['always', 'session'] as const) {
    const res = installService({ ...opts, sessionMode, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
    assert.equal(res.ok, true, res.lines.join('\n'));
    const xml = readFileSync(taskXmlPath(), 'utf16le');
    assert.match(xml, new RegExp(`<UserId>${sid}</UserId>`));
    assert.match(xml, sessionMode === 'always' ? /<LogonType>S4U<\/LogonType>/ : /<LogonType>InteractiveToken<\/LogonType>/);
    // The logon trigger names the account too: without it, any user's logon would start Timon's task.
    if (sessionMode === 'session') assert.match(xml, new RegExp(`<LogonTrigger><Enabled>true</Enabled><UserId>${sid}</UserId></LogonTrigger>`));
  }
});

/**
 * TODO #342: `/Run` answers "SUCCESS: Attempted" even when Windows then
 * refuses the S4U session (machine joined to Entra ID); the task stays Ready,
 * `LastTaskResult` 0x41303, `LastRunTime` in 1999. The elevated batch therefore
 * checks that it REALLY started, and removes it otherwise, same UAC prompt.
 */
test('windows: after /Run, the elevated batch checks the task ran, and removes it otherwise', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  installService({ ...opts, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const run = batch.indexOf('schtasks /Run /TN TimonOrchestrator');
  const verify = batch.indexOf('Get-ScheduledTaskInfo');
  assert.ok(run >= 0 && verify > run, batch);
  // `/Run` refused: nothing to check, the task was not launched by us.
  assert.match(batch.slice(run), /^[^\r\n]*\r\nset RC=%ERRORLEVEL%\r\necho TIMON-STEP run=%RC% [^\r\n]*\r\nif not "%RC%"=="0" goto :done/);
  const step = verifyTaskStartedStep().args.at(-1)!;
  // BOTH signals of "never run", and an unreadable state passes.
  assert.ok(step.includes(`-ne ${WINDOWS_TASK_NEVER_RAN}`), step);
  assert.match(step, /LastRunTime\.Year -ge 2000/);
  assert.match(step, /if \(-not \$i -or /);
  assert.match(step, /if \(\$ran\) \{ exit 0 \}/);
  assert.doesNotMatch(step, /\/XML/, 'no session task staged: nothing to fall back to');
  assert.ok(step.includes(`AddSeconds(${TASK_VERIFY_SECONDS})`));
  assert.match(step, /schtasks\.exe \/Delete \/TN 'TimonOrchestrator' \/F/);
  // Neither `"` nor `%`: the command crosses cmd between quotes.
  assert.doesNotMatch(step, /["%]/);
});

/**
 * Issue #116: a task stored for the session starts its console program on the
 * user's desktop. An off-session install reads the stored logon back before
 * `/Run`, and falls back to the session task within the same elevation.
 */
test('windows: an off-session install stages the session task and reads the logon back before /Run', () => {
  const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const res = installService({ ...opts, sessionMode: 'always', readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(res.sessionFallback, undefined);
  assert.match(res.lines.join('\n'), /starts at boot and keeps running after logoff/);
  assert.match(readFileSync(taskXmlPath(), 'utf16le'), /<LogonType>S4U<\/LogonType>/);
  const session = readFileSync(sessionTaskXmlPath(), 'utf16le');
  assert.match(session, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(session, /<Command>C:\\Program Files\\Timon\\Timon\.exe<\/Command>/);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const create = batch.indexOf('schtasks /Create');
  const logon = batch.indexOf('TIMON-STEP logon=');
  const run = batch.indexOf('schtasks /Run');
  assert.ok(create >= 0 && create < logon && logon < run, batch);
  assert.ok(batch.includes(sessionTaskXmlPath()), 'the verify step falls back to the staged session task');

  // Asked for the session: nothing to read back, nothing to fall back to.
  installService({ ...opts, sessionMode: 'session', readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  const sessionBatch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.doesNotMatch(sessionBatch, /TIMON-STEP logon=/);
  assert.ok(!sessionBatch.includes(sessionTaskXmlPath()));
});

test('windows: S4U kept, downgraded to the session, unreadable: what the install reports', () => {
  const install = (codes: Record<string, number>) => {
    const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
    return { opts, res: installService({ ...opts, sessionMode: 'always', readFile: () => transcript(codes) }) };
  };
  const kept = install({ create: 0, logon: 0, stop: 0, run: 0, verify: 0 });
  assert.equal(kept.res.ok, true);
  assert.doesNotMatch(kept.res.lines.join('\n'), /stops at logout|could not read back/);

  const downgraded = install({ create: 0, logon: TASK_SESSION_FALLBACK, stop: 0, run: 0, verify: 0 });
  assert.equal(downgraded.res.ok, true, downgraded.res.lines.join('\n'));
  assert.equal(downgraded.res.sessionFallback, true);
  assert.ok(downgraded.res.lines.includes(WINDOWS_SESSION_FALLBACK_NOTICE));
  assert.match(downgraded.res.lines.join('\n'), /starts at logon and stops when you log off/);
  const files = windowsServiceFiles(downgraded.opts.timonHome, join);
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.equal(existsSync(files.refused), false, 'a session task that runs is a service, not a refusal');

  const unreadable = install({ create: 0, logon: TASK_LOGON_UNREADABLE, stop: 0, run: 0, verify: 0 });
  assert.equal(unreadable.res.ok, true);
  assert.equal(unreadable.res.sessionFallback, undefined);
  assert.match(unreadable.res.lines.join('\n'), /could not read back the logon type .* kept as registered/);
  assert.match(unreadable.res.lines.join('\n'), /starts at boot/);

  // The session task could not replace the downgraded one, which was removed:
  // its `/Run` fails, and nothing is left for the desktop to wait on.
  const failed = install({ create: 0, logon: TASK_LOGON_FALLBACK_FAILED, stop: 0, run: 1 });
  assert.equal(failed.res.ok, false);
  assert.match(failed.res.reason!, /session only/);
  assert.equal(existsSync(windowsServiceFiles(failed.opts.timonHome, join).revision), false);
});

test('windows: the logon check falls back only from a session logon, and deletes nothing it cannot read', () => {
  const step = logonCheckStep('C:\\Temp\\TimonOrchestrator-session.xml');
  assert.equal(step.label, 'logon');
  const command = step.args.at(-1)!;
  assert.match(command, /schtasks\.exe \/Query \/TN 'TimonOrchestrator' \/XML ONE/);
  assert.match(command, /if \(\$l -eq 'S4U' -or \$l -eq 'Password'\) \{ exit 0 \}/);
  const unreadable = command.indexOf(`exit ${TASK_LOGON_UNREADABLE}`);
  const create = command.indexOf("/Create /TN 'TimonOrchestrator' /XML 'C:\\Temp\\TimonOrchestrator-session.xml' /F");
  const remove = command.indexOf('/Delete');
  assert.ok(unreadable >= 0 && unreadable < create && create < remove, command);
  assert.match(command, /if \(\$l -ne 'InteractiveToken'\) \{ exit 7 \}/);
  assert.ok(command.indexOf(`exit ${TASK_SESSION_FALLBACK}`) < remove, 'a registered session task is never deleted');
  assert.doesNotMatch(command, /["%]/, 'the command crosses cmd between quotes');
});

test('windows: a boot task that never started is replaced by the session task, in the same elevation', () => {
  const step = verifyTaskStartedStep('C:\\Temp\\TimonOrchestrator-session.xml').args.at(-1)!;
  const fallback = step.indexOf("/Create /TN 'TimonOrchestrator' /XML 'C:\\Temp\\TimonOrchestrator-session.xml' /F");
  const remove = step.indexOf('/Delete');
  assert.ok(step.indexOf('if ($ran) { exit 0 }') < fallback && fallback < remove, step);
  // Only a task still off session is replaced, and the replacement must start too.
  assert.ok(step.indexOf("if ($l -eq 'S4U' -or $l -eq 'Password')") < fallback);
  assert.ok(step.indexOf(`if ($ran) { exit ${TASK_SESSION_FALLBACK} }`) > fallback);
  assert.doesNotMatch(step, /["%]/);

  const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const files = windowsServiceFiles(opts.timonHome, join);
  const res = installService({ ...opts, sessionMode: 'always', readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0, verify: TASK_SESSION_FALLBACK }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(res.sessionFallback, true);
  assert.notEqual(res.refused, true);
  assert.equal(existsSync(files.refused), false);
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
});

/**
 * #116 on an Entra account: every rewrite asked for S4U again, waited, fell
 * back to the session task again. The first fallback is remembered; only the
 * user's explicit "always" tries S4U again.
 */
test('windows: a session fallback is remembered, and only an explicit "always" tries S4U again', () => {
  const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const marker = serviceS4uRefusedPath(opts.timonHome);
  assert.equal(marker, join(opts.timonHome, 'run', 'service-s4u-refused'));
  writeServiceSessionMode(opts.timonHome, 'always');

  // Kept off session: nothing to remember.
  installService({ ...opts, readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(existsSync(marker), false);

  // Stored for the session only: the fallback writes the marker, at the logon check or at the verify step.
  for (const codes of [{ create: 0, logon: TASK_SESSION_FALLBACK, stop: 0, run: 0, verify: 0 }, { create: 0, logon: 0, stop: 0, run: 0, verify: TASK_SESSION_FALLBACK }]) {
    rmSync(marker, { force: true });
    const res = installService({ ...opts, readFile: () => transcript(codes) });
    assert.equal(res.sessionFallback, true, res.lines.join('\n'));
    assert.match(readFileSync(marker, 'utf8'), /^\d{4}-\d{2}-\d{2}T/);
  }

  // The next rewrite, with no explicit choice (recorded "always", or the desktop's
  // boot-trigger intent passed by the upgrade runner): the session task directly.
  for (const sessionMode of [undefined, 'always' as const]) {
    const res = installService({ ...opts, ...(sessionMode ? { sessionMode } : {}), readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
    assert.equal(res.ok, true, res.lines.join('\n'));
    assert.equal(res.sessionFallback, undefined, 'nothing fell back: the session task was asked for');
    assert.match(readFileSync(taskXmlPath(), 'utf16le'), /<LogonType>InteractiveToken<\/LogonType>/);
    assert.doesNotMatch(readFileSync(elevatedScriptPath(), 'utf8'), /TIMON-STEP logon=/);
    const text = res.lines.join('\n');
    assert.match(text, /for the session only on this account before \(recorded \d{4}-.*registering the session task directly.*timon service session-mode always/);
    assert.match(text, /starts at logon and stops when you log off/);
  }

  // The explicit gesture (`timon service session-mode always`) forgets it, and the reinstall tries S4U.
  assert.equal(applySessionMode(opts, 'always').ok, true);
  assert.equal(existsSync(marker), false);
  const retried = installService({ ...opts, readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0, verify: 0 }) });
  assert.match(readFileSync(taskXmlPath(), 'utf16le'), /<LogonType>S4U<\/LogonType>/);
  assert.doesNotMatch(retried.lines.join('\n'), /registering the session task directly/);

  // "session" is no request to try S4U: the refusal stays known.
  writeFileSync(marker, 'x\n');
  writeServiceSessionMode(opts.timonHome, 'session');
  assert.equal(existsSync(marker), true);
});

test('#116: an install that succeeds forgets a declined repair, one that is refused keeps it', () => {
  const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const files = windowsServiceFiles(opts.timonHome, join);
  assert.equal(files.rewriteDeclined, join(opts.timonHome, 'run', 'service-rewrite-declined'));
  mkdirSync(dirname(files.rewriteDeclined), { recursive: true });
  writeFileSync(files.rewriteDeclined, '0.1.9\n');
  const refused = installService({ ...opts, sessionMode: 'session', readFile: () => transcript({ create: 1 }) });
  assert.equal(refused.ok, false);
  assert.equal(existsSync(files.rewriteDeclined), true, 'still declined: nothing was rewritten');
  const done = installService({ ...opts, sessionMode: 'session', readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(done.ok, true, done.lines.join('\n'));
  assert.equal(existsSync(files.rewriteDeclined), false);
});

test('windows: a restored S4U task that falls back to the session task is remembered too', () => {
  const win = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const previous = previousTask('S4U', PACKAGED_NODE);
  restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0 }) }, previous);
  assert.equal(existsSync(serviceS4uRefusedPath(win.timonHome)), false);
  const res = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: TASK_SESSION_FALLBACK, stop: 0, run: 0 }) }, previous);
  assert.equal(res.sessionFallback, true);
  assert.equal(existsSync(serviceS4uRefusedPath(win.timonHome)), true);
});

test('windows: a task never launched is an honest refusal, without a revision, with a marker', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  const res = installService({ ...opts, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: TASK_NEVER_RAN_REMOVED }) });
  assert.equal(res.ok, false);
  assert.equal(res.refused, true);
  assert.equal(res.reason, WINDOWS_TASK_REFUSED_REASON);
  assert.match(res.reason!, /Microsoft Entra ID/);
  assert.equal(existsSync(files.revision), false, 'no revision: the desktop must not wait on a removed task');
  assert.equal(existsSync(files.refused), true);

  // Not removable: the task stays, its revision too (the desktop sees it and falls back to embedded).
  const kept = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const keptFiles = windowsServiceFiles(kept.timonHome, join);
  const res2 = installService({ ...kept, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: TASK_NEVER_RAN_KEPT }) });
  assert.equal(res2.refused, true);
  assert.equal(readFileSync(keptFiles.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
  assert.equal(existsSync(keptFiles.refused), true);

  // An install whose task runs clears the finding.
  const ok = installService({ ...kept, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
  assert.equal(ok.ok, true);
  assert.equal(existsSync(keptFiles.refused), false);
});

/**
 * The refused path lasts a UAC prompt + 15 s of checking: at the 30 s cap
 * of the button, the outer PowerShell was killed while the elevated batch
 * went on, and removed the task just announced as installed.
 */
test('windows: the elevated call has its own budget, a batch cut before its check is not a success', () => {
  const timeouts: (number | undefined)[] = [];
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  const res = installService({
    ...opts,
    exec: (_n, a, options) => { if (a.some((arg) => arg.includes('RunAs'))) timeouts.push(options?.timeout); return { code: 0, stdout: '', stderr: '' }; },
    readFile: () => transcript({ create: 0, stop: 0, run: 0 }),
  });
  assert.equal(timeouts.length, 1);
  assert.ok((timeouts[0] ?? 0) >= 120_000, `elevated budget ${timeouts[0]}`);
  assert.equal(res.ok, false);
  assert.notEqual(res.refused, true);
  assert.match(res.reason!, /did not confirm/);
  assert.equal(existsSync(files.revision), false);
  assert.equal(existsSync(files.refused), false);
});

test('windows: the XML escapes what would break the document', () => {
  const xml = renderTaskXml({
    userName: 'a & b',
    timonHome: 'C:\\home',
    installDir: 'C:\\R & D\\resources\\orchestrator',
    nodePath: 'C:\\R & D\\resources\\node\\node.exe',
  });
  assert.match(xml, /<UserId>a &amp; b<\/UserId>/);
  assert.match(xml, /<Command>C:\\R &amp; D\\resources\\node\\node\.exe<\/Command>/);
  assert.match(xml, /&quot;C:\\home\\run\\timon-service\.json&quot;<\/Arguments>/);
});

/**
 * `schtasks /End` kills the launcher's `cmd.exe` and leaves the daemon orphaned
 * (checked on Windows 11, 23/09/2026). Stopping therefore targets the launcher tree
 * of THIS instance, found by its command line.
 */
test('windows: stopping the task stops the launcher tree of this instance', () => {
  const step = stopLauncherStep(WINDOWS_PATHS.timonHome);
  assert.equal(step.program, 'powershell');
  const script = step.args.at(-1)!;
  // Both forms: the batch of revision 5 still runs while the upgrade replaces its task.
  assert.ok(script.includes("'c:\\users\\robin\\.timon\\run\\timon-service.json'"), script);
  assert.ok(script.includes("'c:\\users\\robin\\.timon\\run\\timon-service.cmd'"), script);
  assert.ok(script.includes(launcherProcessFilter(WINDOWS_PATHS.timonHome)));
  for (const program of ['cmd.exe', 'node.exe', 'timon.exe', 'powershell.exe']) assert.ok(script.includes(`'${program}'`), program);
  // Its own command line names the launcher too.
  assert.match(script, /\$_\.ProcessId -ne \$PID/);
  assert.match(script, /taskkill\.exe \/F \/T \/PID/);
  assert.match(script, /exit 0$/, 'nothing to stop is not a failure');
  const batch = renderElevatedScript([stopLauncherStep('C:\\Users\\100%\\.timon')], elevatedLogPath());
  assert.match(batch, /^powershell -NoProfile .*"Get-CimInstance .*100%%.*"/m, 'cmd expands % even between quotes');
});

/**
 * A revision-1 task started its daemon through `wscript`, detached: no
 * launcher holds it, so only the port finds it. Left running, it kept the port
 * and answered the update window with a 401 (0.1.1-rc.7 → 0.1.2-rc.1).
 */
test('windows: install ends the daemon of this installation that holds the port', () => {
  const step = stopPortOwnerStep(WINDOWS_PATHS);
  assert.equal(step.program, 'powershell');
  const script = step.args.at(-1)!;
  assert.match(script, /Get-NetTCPConnection -State Listen -LocalPort 3010 /);
  assert.ok(script.includes("'c:\\program files\\timon\\resources\\orchestrator\\dist\\boot.js'"),
    'only a process running this installation is ended, never a foreign listener');
  assert.match(script, /taskkill\.exe \/F \/T \/PID/);
  assert.match(script, /exit 0$/, 'nothing on the port is not a failure');
  assert.doesNotMatch(script, /"/, 'cmd doubles double quotes inside the quoted argument');

  // Only the upgrade runner asks for it, between the launcher stop and /Run.
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  installService({ ...opts, replacePortOwner: true, readFile: () => transcript({ create: 0, stop: 0, 'stop-port': 0, run: 0, verify: 0 }) });
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['taskkill.exe /F /T /PID $_.ProcessId', 'Get-NetTCPConnection', 'schtasks /Run /TN TimonOrchestrator'].map((n) => batch.indexOf(n));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order);
});

/**
 * The S4U daemon runs in session 0: a non-elevated process cannot
 * kill it, and a `/Run` on a live daemon is ignored (IgnoreNew). The
 * restart requested by the desktop therefore goes through ONE elevated batch.
 */
test('windows: restart ends the launcher tree then runs the task, under one elevation', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  const steps = windowsRestartSteps(opts);
  // The launcher's tree, then what no launcher holds any more: an update that
  // replaced the application under a running daemon left it without one, still
  // on the port with the previous version (0.1.7 to 0.1.8).
  assert.deepEqual(steps.map((s) => s.label), ['stop', 'stop-port', 'sweep', 'run']);
  assert.deepEqual(steps[1], stopPortOwnerStep(opts));
  // The sweep is what `/Run` waits on: a task run over a daemon that outlived it changes nothing.
  assert.deepEqual(steps[2], { ...stopInstallationProcessesStep(opts), stopOnFailure: true });
  assert.equal(steps[3]!.stopOnFailure, undefined);
  const res = restartWindowsService({ ...opts, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: 0, run: 0 }) });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1, 'a single elevated process');
  assert.equal(calls[0]![0], 'powershell');
  assert.match(calls[0]!.join(' '), /-Verb RunAs/);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = [windowsLauncherPath(opts.timonHome).toLowerCase(), `Get-NetTCPConnection -State Listen -LocalPort ${opts.port}`, 'Start-Sleep -Seconds 1', 'schtasks /Run /TN TimonOrchestrator']
    .map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'everything is ended before the task runs again');
  // One guard, between the sweep's exit code and `/Run`: a sweep that did not answer 0 ends the batch there.
  const guard = 'if not "%RC%"=="0" goto :done';
  assert.equal(batch.split(guard).length - 1, 1, batch);
  assert.ok(batch.indexOf('TIMON-STEP sweep=%RC%') < batch.indexOf(guard) && batch.indexOf(guard) < batch.indexOf('schtasks /Run'), batch);
  // Only this installation's daemon on the port, and its own background programs: never the directory alone.
  assert.ok(batch.includes(installationProcessNeedles(opts.installDir)[0]!.toLowerCase()), 'the daemon of this installation');
  assert.doesNotMatch(batch, /\/Create|\/Delete|\/End/, 'the task itself is left as it is');
});

test('windows: restart refuses to run the task over a program of the installation that outlived it', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  // What the batch writes then: the guard ended it before `/Run`.
  const left = restartWindowsService({ ...opts, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: PROCESSES_REMAIN }) });
  assert.equal(left.ok, false);
  assert.equal(left.code, 1);
  assert.match(left.reason ?? '', /still running and could not be ended, so the service was not started again/);
  assert.match(left.reason ?? '', /Task Manager or restart the computer, then open Timon again/, 'the refusal says what to do');
  assert.doesNotMatch(left.lines.join('\n'), /service restarted/);
  // A transcript that claims the task ran anyway is not believed over the sweep.
  const claimed = restartWindowsService({ ...opts, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: PROCESSES_REMAIN, run: 0 }) });
  assert.equal(claimed.ok, false);
  assert.doesNotMatch(claimed.lines.join('\n'), /service restarted/);

  // A sweep that could not look (PowerShell failed, the batch ended early) proves nothing either.
  for (const codes of [{ stop: 0, 'stop-port': 0, sweep: 1, run: 0 }, { stop: 0, 'stop-port': 0, run: 0 }]) {
    const unchecked = restartWindowsService({ ...opts, readFile: () => transcript(codes) });
    assert.equal(unchecked.ok, false, JSON.stringify(codes));
    assert.match(unchecked.reason ?? '', /could not check that its previous daemon had ended \(exit (1|unknown)\), so the service was not started again/);
    assert.doesNotMatch(unchecked.lines.join('\n'), /service restarted/);
  }

  // The same refusal through the gesture the desktop's runner calls.
  const gesture = restartService({ ...opts, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: PROCESSES_REMAIN }) });
  assert.equal(gesture.ok, false);
  assert.match(gesture.reason ?? '', /still running and could not be ended/);
});

test('restartService: Windows restarts the task under one elevation', () => {
  const win = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const restarted = restartService({ ...win, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: 0, run: 0 }) });
  assert.equal(restarted.ok, true);
  assert.match(restarted.lines.join('\n'), /service restarted/);
  assert.deepEqual(readFileSync(elevatedScriptPath(), 'utf8'), renderElevatedScript(windowsRestartSteps(win), elevatedLogPath()));
});

test('restartService: systemd stops then starts its unit, and a failed stop starts nothing', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  assert.equal(installService(opts).ok, true);
  calls.length = 0;
  const res = restartService(opts);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.deepEqual(calls, [['systemctl', '--user', 'stop', LINUX_UNIT], ['systemctl', '--user', 'start', LINUX_UNIT]]);
  assert.match(res.lines.join('\n'), /service stopped[\s\S]*service started/);
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), false, 'a restart is not a stop the user asked for');

  // Nothing is started over a daemon that could not be stopped.
  const refusing: string[][] = [];
  const refused = fixture('linux', (n, a) => { refusing.push([n, ...a]); return { code: a.includes('stop') ? 1 : 0, stdout: '', stderr: a.includes('stop') ? 'denied' : '' }; });
  assert.equal(installService(refused).ok, true);
  refusing.length = 0;
  const failed = restartService(refused);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'denied');
  assert.deepEqual(refusing, [['systemctl', '--user', 'stop', LINUX_UNIT]]);
});

test('windows: restart reports a refused elevation and a task that would not start', () => {
  const opts = fixture('win32', () => ({ code: 1223, stdout: '', stderr: '' }));
  const refused = restartWindowsService({ ...opts, readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.equal(refused.reason, 'elevation refused');
  const ok = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const notStarted = restartWindowsService({ ...ok, readFile: () => transcript({ stop: 0, 'stop-port': 0, sweep: 0, run: 1 }) });
  assert.equal(notStarted.ok, false);
  assert.match(notStarted.reason ?? '', /could not be started|TIMON-STEP/);
  assert.equal(restartWindowsService(fixture('linux')).ok, false);
});

test('windows: uninstall removes the task, stops its daemon, and leaves TIMON_HOME', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  for (const file of [files.launcher, files.batchLauncher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.rewriteDeclined, files.refused]) writeFileSync(file, 'x');
  writeFileSync(join(opts.timonHome, 'timon.db'), 'data', 'utf8');
  const res = uninstallService({ ...opts, readFile: () => transcript({ end: 0, delete: 0, stop: 0 }) });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'powershell');
  // Removed BEFORE stopping its daemon: otherwise the repetition could
  // restart it in between. And `/End` keeps nothing: a stopped task
  // makes `/End` fail and must go anyway.
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/Delete /TN TimonOrchestrator /F') < batch.indexOf('taskkill.exe'));
  assert.match(batch, /schtasks \/End \/TN TimonOrchestrator/);
  assert.doesNotMatch(batch, /goto :done/);
  // The task files go with it, the refusal finding too
  // (TODO #342: otherwise the setup would only offer portable mode); the data stays.
  for (const file of [files.launcher, files.batchLauncher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.rewriteDeclined, files.refused]) {
    assert.equal(existsSync(file), false, file);
  }
  assert.equal(readFileSync(join(opts.timonHome, 'timon.db'), 'utf8'), 'data');
  assert.ok(res.lines.join(' ').includes(`${opts.timonHome} left untouched`));
});

test('windows: every service gesture writes under the home, nothing in the working directory (TODO #706)', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  for (const file of Object.values(files)) {
    const inside = relative(opts.timonHome, file);
    assert.ok(!inside.startsWith('..') && !isAbsolute(inside), `${file} is outside ${opts.timonHome}`);
  }

  const elevated = { ...opts, readFile: () => transcript({ create: 0, end: 0, delete: 0, stop: 0, run: 0, verify: 0 }) };
  const cwd = process.cwd();
  // A path that lost its separators lands in the cwd: an empty one shows it.
  const scratch = mkdtempSync(join(tmpdir(), 'timon-service-cwd-'));
  process.chdir(scratch);
  try {
    assert.equal(installService(elevated).ok, true);
    assert.equal(readFileSync(files.launcher, 'utf8'), renderWindowsLauncherConfig(opts));
    repairSessionWitness(elevated);
    stopService(elevated);
    startService(elevated);
    restartWindowsService(elevated);
    restoreServiceDefinition(elevated, '<Task />');
    removeServiceDefinition(elevated);
    // The revision 1 launcher is the file TODO #706 found: only an uninstall names it.
    writeFileSync(files.legacyLauncher, 'x');
    assert.equal(uninstallService(elevated).ok, true);
    assert.equal(existsSync(files.legacyLauncher), false);
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    process.chdir(cwd);
  }
});

test('windows: an install retires the batch of revision 5, unless an upgrade still needs it', () => {
  for (const keep of [false, true]) {
    const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
    const files = windowsServiceFiles(opts.timonHome, join);
    mkdirSync(dirname(files.batchLauncher), { recursive: true });
    writeFileSync(files.batchLauncher, '@echo off\r\n');
    const res = installService({ ...opts, keepBatchLauncher: keep, readFile: () => transcript({ create: 0, stop: 0, run: 0, verify: 0 }) });
    assert.equal(res.ok, true, res.lines.join('\n'));
    assert.equal(existsSync(files.batchLauncher), keep, `keepBatchLauncher=${keep}`);
    if (keep) {
      retireBatchLauncher(opts);
      assert.equal(existsSync(files.batchLauncher), false);
    }
  }
  // A failed install leaves it: the task in place may still run it.
  const opts = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.batchLauncher), { recursive: true });
  writeFileSync(files.batchLauncher, '@echo off\r\n');
  assert.equal(installService({ ...opts, readFile: () => transcript({ create: 1 }) }).ok, false);
  assert.equal(existsSync(files.batchLauncher), true);
});

test('windows: the packaged marker is read from the configuration, or from the batch before it', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  assert.equal(windowsLauncherMarked(opts.timonHome), null);
  mkdirSync(dirname(files.batchLauncher), { recursive: true });
  writeFileSync(files.batchLauncher, '@echo off\r\nset "TIMON_DESKTOP_SERVICE=1"\r\n');
  assert.equal(windowsLauncherMarked(opts.timonHome), true);
  writeFileSync(files.launcher, renderWindowsLauncherConfig({ ...opts, nodePath: PACKAGED_NODE }));
  assert.equal(windowsLauncherMarked(opts.timonHome), false, 'the configuration wins: TIM-0087 unmarked');
  writeFileSync(files.launcher, renderWindowsLauncherConfig({ ...opts, nodePath: PACKAGED_NODE, environment: { TIMON_DESKTOP_SERVICE: '1' } }));
  assert.equal(windowsLauncherMarked(opts.timonHome), true);
});

test('windows: a task that could not be removed keeps its launcher', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  writeFileSync(files.launcher, 'x');
  writeFileSync(files.refused, 'x');
  uninstallService({ ...opts, readFile: () => transcript({ end: 1, delete: 1, stop: 0 }) });
  assert.equal(existsSync(files.launcher), true);
  assert.equal(existsSync(files.refused), true, 'the task is still there: so is the verdict on it');
});

test('windows: status reads the task, and a missing task is not "running"', () => {
  const running = statusService(fixture('win32', () => ({
    code: 0, stdout: 'TaskName: \\TimonOrchestrator\nStatus: Running\n', stderr: '',
  })));
  assert.equal(running.ok, true);
  assert.equal(running.code, 0);

  const absent = statusService(fixture('win32', () => ({
    code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.',
  })));
  assert.equal(absent.ok, false);
  assert.equal(absent.code, 3);
  assert.ok(absent.lines.join(' ').includes('registered: no'));
});

/**
 * The blocking first-run screen waits for `service-status` to answer.
 *
 * A BootTrigger alone only fires at the NEXT boot, so a task that is merely
 * created leaves a Windows user in front of a wizard waiting for a daemon that
 * will not come up until they restart — while Linux and macOS
 * start theirs on the spot (`systemctl --user enable --now`, `launchctl
 * bootstrap gui/<uid>`). Hence `/Run`, and hence a start failure counted as an
 * install failure: announcing success over a daemon that never came up is what
 * this whole step exists to prevent.
 */
test('windows: a task that cannot be started is not a successful installation', () => {
  // Creation succeeds, starting does not — the elevated batch says so.
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `ERROR: The system cannot find the path specified.\n${transcript({ create: 0, stop: 0, run: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  const text = res.lines.join(' ');
  assert.match(text, /could not be started/);
  assert.match(text, /cannot find the path specified/);
  // And above all: never the success message.
  assert.doesNotMatch(text, /installed and started/);
});

test('windows: the task is not started if its creation failed', () => {
  // The guard lives in the elevated batch: a failing creation skips the rest,
  // and the absence of a `run=` line is what proves it.
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `Access is denied.\n${transcript({ create: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.doesNotMatch(res.lines.join(' '), /could not be started/);
  const batch = renderElevatedScript(
    [
      { label: 'create', args: ['/Create'], stopOnFailure: true },
      { label: 'run', args: ['/Run'] },
    ],
    elevatedLogPath(),
  );
  assert.match(batch, /if not "%RC%"=="0" goto :done/);
});

/**
 * Refusing the UAC prompt is not the same as a failing schtasks:
 * the user must read that they refused, not a Windows error code.
 */
test('windows: a refused elevation says so, and does not claim to have installed', () => {
  const res = installService({
    // The witness is sealed without elevation; only the elevation is refused.
    ...fixture('win32', (_n, a) => ({ code: a.some((arg) => arg.includes('RunAs')) ? 1223 : 0, stdout: '', stderr: '' })),
    readFile: () => { throw new Error('ENOENT'); },
  });
  assert.equal(res.ok, false);
  assert.match(res.lines.join(' '), /elevation refused/);
  assert.doesNotMatch(res.lines.join(' '), /installed and started/);
});

test('windows: a schtasks that refuses reports the refusal, not a success', () => {
  const res = installService({
    ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })),
    readFile: () => `Access is denied.\n${transcript({ create: 1 })}`,
  });
  assert.equal(res.ok, false);
  assert.equal(res.code, 1);
  assert.ok(res.lines.join(' ').includes('Access is denied.'));
});

test('uninstall removes the unit and never touches TIMON_HOME', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  installService(opts);
  mkdirSync(opts.timonHome, { recursive: true });
  writeFileSync(join(opts.timonHome, 'timon.db'), 'data', 'utf8');

  const res = uninstallService(opts);
  assert.equal(res.ok, true);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
  assert.equal(readFileSync(join(opts.timonHome, 'timon.db'), 'utf8'), 'data');
  assert.ok(res.lines.some((l) => l.includes('left untouched')));
  assert.ok(calls.some((c) => c.join(' ') === `systemctl --user disable --now ${LINUX_UNIT}`));
});

test('status reports the unit state and exits 3 when it is not running', () => {
  const opts = fixture('linux', () => ({ code: 3, stdout: 'inactive\n', stderr: '' }));
  const res = statusService(opts);
  assert.equal(res.ok, false);
  assert.equal(res.code, 3);
  assert.ok(res.lines.some((l) => l.includes('state     : inactive')));
  assert.ok(res.lines.some((l) => l.includes('not installed')));
});

test('dry-run writes nothing and calls nothing', () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: '', stderr: '' };
  });
  const res = installService({ ...opts, dryRun: true });
  assert.equal(res.ok, true);
  assert.equal(calls.length, 0);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
  assert.ok(res.lines.every((l) => l.startsWith('(dry-run)')), res.lines.join('\n'));
  assert.ok(res.lines.at(-1)!.includes(`would install the service (${LINUX_UNIT})`));
});

/**
 * The service port must be the one the config asks for (step 5.7.6).
 *
 * The template froze `PORT=3000`. A package starts on 3010 so as to hit
 * neither v1 nor the dev home: the service would have listened elsewhere than where the
 * desktop client looks for its daemon: a white window, without a message.
 */
test('linux: the unit carries the port and heap of the config, not constants', () => {
  const opts = fixture('linux');
  const unit = renderUnit({ ...opts, port: 3010, heapMb: 2048 });
  assert.match(unit, /Environment=PORT=3010/);
  assert.match(unit, /--max-old-space-size=2048/);
  assert.doesNotMatch(unit, /@PORT@|@HEAP@/, 'no template left in place');
  assert.doesNotMatch(unit, /Environment=PORT=3000/);
});

test('linux: the unit PATH starts with the agent CLI directories the shell found', () => {
  const opts = fixture('linux');
  writeFileSync(
    join(opts.installDir, 'scripts', `${LINUX_UNIT}.service.template`),
    '[Service]\nEnvironment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin\n',
    'utf8',
  );
  const unit = renderUnit({
    ...opts,
    agentBinDirs: ['/home/tester/.npm-global/bin', '/usr/bin', join(opts.homeDir, '.local', 'bin'), 'relative/bin', '/odd:dir', '/home/tester/.npm-global/bin'],
  });
  assert.match(unit, /^Environment=PATH=\/home\/tester\/\.npm-global\/bin:%h\/\.local\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.equal(renderUnit({ ...opts }).match(/^Environment=PATH=.*$/m)?.[0], 'Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin');
});

test('status: "registered" and "running" are two distinct answers', { skip: SYSTEMD_IDENTITY }, () => {
  // Unit written, but systemd says it is inactive: installed, not started. That is
  // the exact state of a first packaged launch, where the embedded daemon still
  // holds the port.
  const opts = fixture('linux', () => ({ code: 0, stdout: '', stderr: '' }));
  installService(opts);
  const stopped = statusService({ ...opts, exec: () => ({ code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nActiveState=inactive\nWorkingDirectory=${opts.installDir}\nEnvironment=TIMON_HOME=${opts.timonHome}`, stderr: '' }) });
  assert.equal(stopped.installed, true);
  assert.equal(stopped.ok, false);

  const running = statusService({ ...opts, exec: () => ({ code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${opts.installDir}\nEnvironment=TIMON_HOME=${opts.timonHome}`, stderr: '' }) });
  assert.equal(running.installed, true);
  assert.equal(running.ok, true);
});

function supervised(opts: ServiceOpts, home: string, directory = opts.installDir, extra = ''): string {
  return `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nWorkingDirectory=${directory}\nEnvironment="TIMON_HOME=${home}"\n${extra}`;
}

test('linux: a development service is neither adopted, overwritten nor stopped', () => {
  const opts = fixture('linux');
  const file = unitPath(opts.homeDir);
  mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
  const development = '[Service]\nEnvironment=TIMON_HOME=%h/.timon-dev\n';
  writeFileSync(file, development);
  const calls: string[][] = [];
  opts.exec = (name, args) => {
    calls.push([name, ...args]);
    return { code: 0, stderr: '', stdout: supervised(opts, '%h/.timon-dev') };
  };
  for (const action of [statusService, installService, uninstallService]) {
    const result = action(opts);
    assert.equal(result.ok, false);
    assert.equal(result.installed, false);
    assert.match(result.reason!, /another installation or data directory/);
    assert.equal(readFileSync(file, 'utf8'), development);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every(([name, ...args]) => name === 'systemctl' && args.includes('show')));
});

test('linux: the same home with another installation is a conflict too', () => {
  const opts = fixture('linux');
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome, '/other/orchestrator') });
  assert.equal(statusService(opts).installed, false);
  assert.equal(installService(opts).ok, false);
  assert.equal(existsSync(unitPath(opts.homeDir)), false);
});

test('linux: stale definitions and unavailable supervisors fail closed', () => {
  const opts = fixture('linux');
  for (const result of [
    { code: 1, stdout: '', stderr: 'No bus' },
    { code: 0, stdout: supervised(opts, opts.timonHome, opts.installDir, 'NeedDaemonReload=yes'), stderr: '' },
  ]) {
    const calls: string[][] = [];
    opts.exec = (name, args) => { calls.push([name, ...args]); return result; };
    assert.equal(installService(opts).ok, false);
    assert.equal(uninstallService(opts).ok, false);
    assert.ok(calls.every((call) => call.includes('show')));
    assert.equal(existsSync(unitPath(opts.homeDir)), false);
  }
});

test('linux: quoted paths, home specifiers and the legacy default are recognized', { skip: SYSTEMD_IDENTITY }, () => {
  const opts = fixture('linux');
  for (const home of [opts.timonHome, '%h/.timon']) {
    opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, home) });
    assert.equal(statusService(opts).ok, true);
  }
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome).replace(/Environment=.*\n/, 'Environment=NODE_ENV=production\n') });
  assert.equal(statusService(opts).ok, true);
  opts.timonHome = join(opts.homeDir, 'data with spaces');
  opts.exec = () => ({ code: 0, stderr: '', stdout: supervised(opts, opts.timonHome) });
  assert.equal(statusService(opts).ok, true);
});

test('linux: rendering persists the selected home in the real shipped template', () => {
  const opts = fixture('linux');
  opts.installDir = resolve('src/host/../../');
  opts.timonHome = '/tmp/a home % "quoted"';
  const unit = renderUnit(opts);
  assert.match(unit, /\[Service\]\nEnvironment="TIMON_HOME=\/tmp\/a home %% \\"quoted\\""/);
  // The template names `[Service]` in a comment too: only the section counts.
  const section = unit.slice(unit.search(/^\[Service\]$/m));
  assert.match(section, /^\[Service\]\nEnvironment="TIMON_HOME=\/tmp\/a home %% \\"quoted\\""$/m);
  assert.doesNotMatch(unit.slice(0, unit.search(/^\[Service\]$/m)), /TIMON_HOME=/);
  assert.throws(() => renderUnit({ ...opts, timonHome: '/tmp/home\nExecStart=bad' }));
});

/** A packaged unit left by the previous release, and the systemctl that reports it. */
function previousRelease(runningFrom: (opts: ServiceOpts) => string) {
  const base = fixture('linux');
  const opts: ServiceOpts = { ...packagedServiceOptions(base, '/package/timon', 3110, '0.2.0'), restart: true };
  const file = unitPath(opts.homeDir, opts.unitName);
  mkdirSync(join(opts.homeDir, '.config/systemd/user'), { recursive: true });
  const old = packagedServiceOptions(base, '/package/timon', 3110, '0.1.0').unitContent!;
  writeFileSync(file, old);
  const calls: string[][] = [];
  opts.exec = (name, args) => {
    calls.push([name, ...args]);
    if (!args.includes('show')) return { code: 0, stdout: '', stderr: '' };
    return { code: 0, stderr: '', stdout: supervised(opts, opts.timonHome, runningFrom(opts), 'UnitFileState=enabled\n') };
  };
  return { opts, file, old, calls };
}

test('linux upgrade: the unit of a previous release is ours, rewritten, and its daemon restarted', { skip: SYSTEMD_IDENTITY }, () => {
  const { opts, file, calls } = previousRelease((o) => join(o.releasesRoot!, 'old-release', 'resources', 'orchestrator'));
  const result = installService(opts);
  assert.equal(result.ok, true, result.lines.join('\n'));
  assert.equal(readFileSync(file, 'utf8'), opts.unitContent);
  const acts = calls.filter((call) => !call.includes('show')).map((call) => call.join(' '));
  const enable = acts.indexOf(`systemctl --user enable --now ${opts.unitName}`);
  assert.ok(enable >= 0);
  // `enable --now` leaves the running previous release alone; only restart replaces it.
  assert.equal(acts[enable + 1], `systemctl --user restart ${opts.unitName}`);
});

test('linux upgrade: a first install does not restart, and nothing outside our releases is adopted', { skip: SYSTEMD_IDENTITY }, () => {
  const first = previousRelease((o) => o.installDir);
  first.opts.restart = false;
  assert.equal(installService(first.opts).ok, true);
  assert.ok(!first.calls.some((call) => call.includes('restart')));

  for (const foreign of [
    (o: ServiceOpts) => join(o.releasesRoot!, 'old', 'resources', 'orchestrator', 'nested'),
    (o: ServiceOpts) => join(o.releasesRoot!, 'old', 'orchestrator'),
    (o: ServiceOpts) => join(o.releasesRoot!, '..', 'elsewhere', 'resources', 'orchestrator'),
    () => '/opt/other/resources/orchestrator',
  ]) {
    const { opts, file, old, calls } = previousRelease(foreign);
    const result = installService(opts);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /another installation/);
    // The upgrade trusts this promise to leave the running service alone.
    assert.equal(result.written, false);
    assert.equal(readFileSync(file, 'utf8'), old);
    assert.ok(calls.every((call) => call.includes('show')));
  }
  // An unpackaged unit never gains the releases exemption.
  const cli = fixture('linux');
  cli.releasesRoot = join(cli.timonHome, 'desktop-runtime', 'releases');
  cli.exec = () => ({ code: 0, stderr: '', stdout: supervised(cli, cli.timonHome, join(cli.releasesRoot!, 'r', 'resources', 'orchestrator')) });
  assert.equal(statusService(cli).installed, false);
});

test('a failed upgrade puts the previous definition back and restarts it', () => {
  const { opts, file, old, calls } = previousRelease((o) => o.installDir);
  assert.equal(readServiceDefinition(opts), old);
  writeFileSync(file, opts.unitContent!);
  const restored = restoreServiceDefinition(opts, old);
  assert.equal(restored.ok, true);
  assert.equal(readFileSync(file, 'utf8'), old);
  assert.deepEqual(calls.map((call) => call.join(' ')), [
    'systemctl --user daemon-reload',
    `systemctl --user restart ${opts.unitName}`,
  ]);

  const mac = fixture('darwin');
  const macCalls: string[][] = [];
  mac.exec = (name, args) => {
    macCalls.push([name, ...args]);
    return { code: args[0] === 'print' ? 113 : 0, stdout: '', stderr: '' };
  };
  assert.equal(readServiceDefinition(mac), null);
  assert.equal(restoreServiceDefinition(mac, '<plist/>').ok, true);
  assert.equal(readFileSync(plistPath(mac.homeDir), 'utf8'), '<plist/>');
  assert.deepEqual(macCalls.map(([, verb]) => verb), ['bootout', 'print', 'bootstrap']);

  // Windows: the previous definition is the registered task, read as UTF-8
  // (schtasks would lose an accented path), and put back under one elevation.
  const winCalls: string[][] = [];
  const win = fixture('win32', (n, a) => {
    winCalls.push([n, ...a]);
    return { code: 0, stdout: '<?xml version="1.0"?><Task>é</Task>', stderr: '' }; // french-ok: a non-ASCII byte the UTF-8 read keeps
  });
  assert.equal(readServiceDefinition(win), '<?xml version="1.0"?><Task>é</Task>'); // french-ok: a non-ASCII byte the UTF-8 read keeps
  assert.match(winCalls[0]!.at(-1)!, /OutputEncoding = \[Text\.Encoding\]::UTF8; Export-ScheduledTask -TaskName 'TimonOrchestrator'/);
  assert.equal(readServiceDefinition(fixture('win32', () => ({ code: 1, stdout: '', stderr: 'not found' }))), null);

  const files = windowsServiceFiles(win.timonHome, join);
  mkdirSync(dirname(files.revision), { recursive: true });
  writeFileSync(files.revision, `${WINDOWS_SERVICE_REVISION}\n`);
  const legacy = '<Task><Command>wscript.exe</Command></Task>';
  const winRestored = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, stop: 0, run: 0 }) }, legacy);
  assert.equal(winRestored.ok, true, winRestored.lines.join('\n'));
  assert.equal(readFileSync(taskXmlPath(), 'utf16le').replace(/^\ufeff/, ''), legacy);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/Create') < batch.indexOf('taskkill.exe') && batch.indexOf('taskkill.exe') < batch.indexOf('/Run'));
  // Back on revision 1: the desktop must try the migration again next launch,
  // and still sees a task (no revision file reads as none).
  assert.equal(readFileSync(files.revision, 'utf8').trim(), 'restored');
  const refused = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 1 }) }, legacy);
  assert.equal(refused.ok, false);

  // Back on an older definition of the same launcher: the file stays, or the
  // desktop would see no task at all, but it no longer says the current revision.
  writeFileSync(files.revision, `${WINDOWS_SERVICE_REVISION}\n`);
  const sameLauncher = renderTaskXml(win);
  assert.equal(restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 1 }) }, sameLauncher).ok, false);
  assert.equal(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION, 'not put back: the new definition is still there');
  assert.equal(restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, stop: 0, run: 0 }) }, sameLauncher).ok, true);
  assert.notEqual(readFileSync(files.revision, 'utf8').trim(), WINDOWS_SERVICE_REVISION);
});

/** A previous task as `Export-ScheduledTask` gives it back to a rollback. */
function previousTask(logon: string, command: string): string {
  return '<?xml version="1.0" encoding="UTF-16"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">'
    + '<Triggers><BootTrigger><Enabled>true</Enabled></BootTrigger></Triggers>'
    + `<Principals><Principal id="Author"><UserId>S-1-5-21-1-2-3-1001</UserId><LogonType>${logon}</LogonType></Principal></Principals>`
    + `<Actions Context="Author"><Exec><Command>${command}</Command><Arguments>/d /s /c x</Arguments></Exec></Actions></Task>`;
}

test('#116: a rollback never puts back a task that opens a console in the session', () => {
  const win = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const ok = () => transcript({ create: 0, stop: 0, run: 0 });
  const registered = () => readFileSync(taskXmlPath(), 'utf16le').replace(/^\ufeff/, '');

  const res = restoreServiceDefinition({ ...win, readFile: ok }, previousTask('InteractiveToken', 'cmd.exe'));
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.match(res.lines.join('\n'), /started cmd\.exe in the session, which opens a console window/);
  assert.match(registered(), /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(registered(), /<Command>C:\\Program Files\\Timon\\Timon\.exe<\/Command>/);
  assert.doesNotMatch(readFileSync(elevatedScriptPath(), 'utf8'), /TIMON-STEP logon=/, 'nothing off session to read back');

  // node.exe of revision 6, switched to the session: the same window.
  const node = previousTask('InteractiveToken', 'C:\\Program Files\\Timon\\resources\\node\\node.exe');
  restoreServiceDefinition({ ...win, readFile: ok }, node);
  assert.match(registered(), /Timon\.exe/);

  // A session task with no console is put back as it was.
  const gui = previousTask('InteractiveToken', 'C:\\Program Files\\Timon\\Timon.exe');
  assert.equal(restoreServiceDefinition({ ...win, readFile: ok }, gui).ok, true);
  assert.equal(registered(), gui);
});

test('#116: a rollback judges the console with the shared rule: a source checkout keeps its hidden PowerShell', () => {
  const ok = () => transcript({ create: 0, stop: 0, run: 0 });
  const registered = () => readFileSync(taskXmlPath(), 'utf16le').replace(/^\ufeff/, '');

  // A source checkout has no Timon.exe: its session task is a hidden
  // PowerShell by design, and replacing it would register the same one.
  const source = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: 'C:\\Users\\tester\\node\\node.exe' };
  const hidden = renderTaskXml({ ...source, userId: 'S-1-5-21-1-2-3-1001', offSession: false });
  assert.equal(windowsTaskShape(hidden)?.program, 'powershell.exe');
  assert.equal(windowsTaskShape(hidden)?.consoleVisible, true, 'the raw shape alone would call it a console');
  const kept = restoreServiceDefinition({ ...source, readFile: ok }, hidden);
  assert.equal(kept.ok, true, kept.lines.join('\n'));
  assert.doesNotMatch(kept.lines.join('\n'), /opens a console window/);
  assert.equal(registered(), hidden);

  // A package: a session task that starts cmd.exe is the trap, replaced by the session task.
  const packaged = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const replaced = restoreServiceDefinition({ ...packaged, readFile: ok }, previousTask('InteractiveToken', 'cmd.exe'));
  assert.equal(replaced.ok, true, replaced.lines.join('\n'));
  assert.match(replaced.lines.join('\n'), /started cmd\.exe in the session, which opens a console window/);
  assert.match(registered(), /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(registered(), /<Command>C:\\Program Files\\Timon\\Timon\.exe<\/Command>/);
});

test('#116: a restored S4U task is read back, falls back to the session task, and an unreadable one deletes nothing', () => {
  const win = { ...fixture('win32', () => ({ code: 0, stdout: '', stderr: '' })), nodePath: PACKAGED_NODE };
  const files = windowsServiceFiles(win.timonHome, join);
  const s4u = previousTask('S4U', 'cmd.exe');
  const registered = () => readFileSync(taskXmlPath(), 'utf16le').replace(/^\ufeff/, '');

  const kept = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: 0, stop: 0, run: 0 }) }, s4u);
  assert.equal(kept.ok, true, kept.lines.join('\n'));
  assert.equal(kept.sessionFallback, undefined);
  assert.equal(registered(), s4u);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('TIMON-STEP create=') < batch.indexOf('TIMON-STEP logon=') && batch.indexOf('TIMON-STEP logon=') < batch.indexOf('/Run'), batch);
  assert.match(readFileSync(sessionTaskXmlPath(), 'utf16le'), /<Command>C:\\Program Files\\Timon\\Timon\.exe<\/Command>/);

  const downgraded = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: TASK_SESSION_FALLBACK, stop: 0, run: 0 }) }, s4u);
  assert.equal(downgraded.ok, true);
  assert.equal(downgraded.sessionFallback, true);
  assert.ok(downgraded.lines.includes(WINDOWS_SESSION_FALLBACK_NOTICE));
  assert.equal(readFileSync(files.revision, 'utf8').trim(), 'restored');

  const unreadableLogon = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: TASK_LOGON_UNREADABLE, stop: 0, run: 0 }) }, s4u);
  assert.equal(unreadableLogon.ok, true);
  assert.match(unreadableLogon.lines.join('\n'), /could not read back the logon type/);

  const failed = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, logon: TASK_LOGON_FALLBACK_FAILED, stop: 0, run: 1 }) }, s4u);
  assert.equal(failed.ok, false);
  assert.equal(existsSync(files.revision), false, 'the task is gone: no revision for the desktop to wait on');

  // A definition whose logon cannot be read goes back verbatim, unchecked.
  const odd = '<Task><Actions><Exec><Command>wscript.exe</Command></Exec></Actions></Task>';
  const verbatim = restoreServiceDefinition({ ...win, readFile: () => transcript({ create: 0, stop: 0, run: 0 }) }, odd);
  assert.equal(verbatim.ok, true);
  assert.equal(registered(), odd);
  assert.match(verbatim.lines.join('\n'), /could not read the logon of the previous TimonOrchestrator task: it is put back as it was/);
  assert.doesNotMatch(readFileSync(elevatedScriptPath(), 'utf8'), /TIMON-STEP logon=|\/Delete/);
});

test('a definition written with nothing to restore is stopped and removed', () => {
  const { opts, file, calls } = previousRelease((o) => o.installDir);
  writeFileSync(file, opts.unitContent!);
  const removed = removeServiceDefinition(opts);
  assert.equal(removed.ok, true, removed.lines.join('\n'));
  assert.equal(existsSync(file), false);
  assert.deepEqual(calls.map((call) => call.join(' ')), [
    `systemctl --user disable --now ${opts.unitName}`,
    'systemctl --user daemon-reload',
  ]);

  // A daemon that would not stop is reported, even though the file is gone.
  const stuck = previousRelease((o) => o.installDir);
  stuck.opts.exec = () => ({ code: 1, stdout: '', stderr: 'Failed to connect to bus' });
  const failed = removeServiceDefinition(stuck.opts);
  assert.equal(failed.ok, false);
  assert.equal(failed.reason, 'Failed to connect to bus');

  const mac = fixture('darwin');
  mkdirSync(dirname(plistPath(mac.homeDir)), { recursive: true });
  writeFileSync(plistPath(mac.homeDir), '<plist/>');
  mac.exec = () => ({ code: 113, stdout: '', stderr: '' });
  assert.equal(removeServiceDefinition(mac).ok, true);
  assert.equal(existsSync(plistPath(mac.homeDir)), false);

  const win = fixture('win32', () => ({ code: 0, stdout: '', stderr: '' }));
  const revision = windowsServiceFiles(win.timonHome, join).revision;
  mkdirSync(dirname(revision), { recursive: true });
  writeFileSync(revision, WINDOWS_SERVICE_REVISION);
  assert.equal(removeServiceDefinition({ ...win, readFile: () => transcript({ end: 0, delete: 0, stop: 0 }) }).ok, true);
  assert.equal(existsSync(revision), false);
  assert.match(readFileSync(elevatedScriptPath(), 'utf8'), /taskkill\.exe/);
  assert.equal(removeServiceDefinition({ ...win, readFile: () => transcript({ end: 1, delete: 1 }) }).ok, false);
});

test('TIM-0107: `timon service repair` seals the witness again only when it cannot be opened', () => {
  const calls: string[][] = [];
  const run = (readCode: number, sealCode = 0, launcher = true) => {
    const opts = fixture('win32', (n, a) => {
      calls.push([n, ...a]);
      return { code: a.at(-1)!.includes('ConvertFrom-SecureString') ? sealCode : readCode, stdout: '', stderr: sealCode ? 'DPAPI unavailable' : '' };
    });
    const files = windowsServiceFiles(opts.timonHome, join);
    if (launcher) { mkdirSync(dirname(files.launcher), { recursive: true }); writeFileSync(files.launcher, 'x'); }
    return { res: repairSessionWitness(opts), files };
  };

  let out = run(0);
  assert.equal(out.res.ok, true);
  assert.match(out.res.lines.join('\n'), /nothing to repair/);
  assert.equal(calls.filter((c) => c.at(-1)!.includes('ConvertFrom-SecureString')).length, 0, 'a witness that opens is left alone');

  calls.length = 0;
  for (const readCode of [1, 2]) {
    out = run(readCode);
    assert.equal(out.res.ok, true, `exit ${readCode}`);
    assert.ok(calls.at(-1)!.at(-1)!.includes(out.files.sessionWitness), 'sealed where the launcher reads it');
    assert.ok(calls.at(-1)!.includes('-NonInteractive') && !calls.some((c) => c.join(' ').includes('RunAs')), 'in the user session, no elevation');
  }

  out = run(1, 1);
  assert.equal(out.res.ok, false);
  assert.match(out.res.lines.join('\n'), /could not seal the session witness.*DPAPI unavailable/);

  assert.equal(run(1, 0, false).res.ok, false, 'no launcher: nothing installed to repair');
  const linux = repairSessionWitness({ ...fixture('linux'), exec: () => { throw new Error('never called'); } });
  assert.equal(linux.ok, true);
});

test('TIM-0107: the read command and the launcher judge the witness the same way', () => {
  const file = 'C:\\Users\\robin\\.timon\\run\\session-witness.dpapi';
  const command = readSessionWitnessCommand(file).at(-1)!;
  const launcher = JSON.parse(renderWindowsLauncherConfig({ timonHome: 'C:\\Users\\robin\\.timon', installDir: 'C:\\T', heapMb: 4096, port: 3010, nodePath: 'C:\\T\\resources\\node\\node.exe' })) as { witness: { args: string[] } };
  assert.deepEqual(launcher.witness.args, readSessionWitnessCommand(file), 'the very command repair runs');
  assert.ok(command.startsWith(`$f = '${file}'`));
});

test('TODO #550: an unreadable witness leaves its cause on stderr, never its content', () => {
  const payload = readSessionWitnessCommand('C:\\w.dpapi').at(-1)!;
  // The catch keeps the cause instead of swallowing it, from the exception alone.
  const handler = /catch \{ (\$why = [^}]*) \}/.exec(payload)?.[1];
  assert.ok(handler, 'the decrypt failure is recorded, not swallowed');
  assert.match(handler, /\$_\.Exception\.Message/);
  assert.doesNotMatch(handler, /\$s\b|\$b\b|Get-Content|PtrToStringBSTR/, 'neither the blob nor what it decrypted to');
  assert.doesNotMatch(payload, /catch \{\s*\}/, 'no catch left empty');
  // On stderr, where the launcher (once, `windows-service-launcher.test.ts`), status and repair read it.
  assert.match(payload, /\[Console\]::Error\.WriteLine\(\$why\); exit 1$/);
});

test('TODO #550: status and repair show why the witness cannot be opened', () => {
  const cause = 'CryptographicException: Key not valid for use in specified state.';
  const notes = windowsServiceNotes(fixture('win32', (_n, a) => (
    a.at(-1)!.includes('Get-ScheduledTask') ? { code: 0, stdout: 'present\r\n', stderr: '' } : { code: 1, stdout: '', stderr: `${cause}\r\n` })));
  assert.ok(notes.some((line) => line.includes('timon service repair') && line.endsWith(`(cause: ${cause})`)), notes.join('\n'));
  const silent = windowsServiceNotes(fixture('win32', () => ({ code: 1, stdout: '', stderr: '' })));
  assert.ok(silent.some((line) => line.endsWith('run `timon service repair`')), 'no cause, no empty suffix');

  const opts = fixture('win32', (_n, a) => ({ code: a.at(-1)!.includes('ConvertFrom-SecureString') ? 0 : 1, stdout: '', stderr: a.at(-1)!.includes('ConvertFrom-SecureString') ? '' : cause }));
  const files = windowsServiceFiles(opts.timonHome, join);
  mkdirSync(dirname(files.launcher), { recursive: true });
  writeFileSync(files.launcher, 'x');
  assert.ok(repairSessionWitness(opts).lines.includes(`the session witness cannot be opened (cause: ${cause})`));
});

test('TIM-0107 / TIM-0108: the status notes say whether the witness opens and whether the module sees the task', () => {
  const notes = (witness: number, lookup: string) => windowsServiceNotes(fixture('win32', (_n, a) => (
    a.at(-1)!.includes('Get-ScheduledTask -TaskName')
      ? { code: 0, stdout: `${lookup}\r\n`, stderr: '' }
      : { code: witness, stdout: '', stderr: '' }))).join('\n');
  assert.match(notes(0, 'present'), /session witness: opens[\s\S]*task present/);
  assert.match(notes(1, 'present'), /cannot be opened.*timon service repair/);
  assert.match(notes(2, 'present'), /missing.*timon service install/);
  assert.match(notes(0, 'absent'), /ScheduledTasks module: task absent/);
  assert.deepEqual(windowsServiceNotes(fixture('linux')), []);
});

test('TIM-0115: the sweep targets this installation\'s daemon and terminal host, never the directory they share with the desktop', () => {
  const step = stopInstallationProcessesStep({ installDir: 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\resources\\orchestrator', nodePath: 'C:\\Users\\Robin\\AppData\\Local\\Programs\\Timon\\Timon.exe' });
  const script = step.args.at(-1)!;
  assert.equal(step.label, 'sweep');
  // Only the runtime of this installation, never a foreign program whose command
  // line names one of its files, nor an Electron helper of the window.
  assert.match(script, /@\('Timon\.exe', 'node\.exe'\) -contains \$_\.Name -and/, 'bounded to the Timon runtimes: Electron, and the Node the package ships');
  assert.match(script, /-not \$_\.CommandLine\.Contains\('--type='\)/, 'Electron helpers are the window\'s');
  assert.match(stopInstallationProcessesStep({ installDir: 'C:\\svc\\orchestrator', nodePath: 'C:\\Program Files\\nodejs\\node.exe' }).args.at(-1)!, /@\('node\.exe', 'Timon\.exe'\) -contains \$_\.Name/, 'a CLI-installed service runs on node');
  assert.ok(script.includes("'c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\orchestrator\\dist\\boot.js'"));
  assert.ok(script.includes("\\dist\\terminal-host\\main.js'"));
  // After Quit, the web server and a mission's browser helper outlived the
  // daemon too (tester report, 22/10/2026): found by the sibling app directory
  // and the helper's entry, never by Electron's own `resources\app.asar`.
  assert.ok(script.includes("\\resources\\orchestrator\\bin\\browser-mcp.mjs'"));
  assert.ok(script.includes("'c:\\users\\robin\\appdata\\local\\programs\\timon\\resources\\app\\'"));
  assert.equal(installationProcessNeedles('C:\\T\\resources\\orchestrator').some((n) => 'c:\\t\\resources\\app.asar'.includes(n.toLowerCase())), false);
  assert.doesNotMatch(script, /orchestrator'\)/, 'the bare install directory is also where the CLI that runs this uninstall lives');
  assert.match(script, /\$_\.ProcessId -ne \$PID/, 'never this PowerShell, whose command line holds the needles');
  assert.match(script, new RegExp(`exit ${PROCESSES_REMAIN}`));
  assert.doesNotMatch(script, /"/, 'it travels inside a quoted batch line');
});

test('TIM-0115: uninstall sweeps after deleting the task, fails visibly when the elevation is refused, and says when programs remain', () => {
  const run = (codes: Record<string, number> | null) => {
    const opts = fixture('win32', () => ({ code: codes ? 0 : 1223, stdout: '', stderr: '' }));
    const files = windowsServiceFiles(opts.timonHome, join);
    mkdirSync(dirname(files.launcher), { recursive: true });
    writeFileSync(files.launcher, 'x');
    return { res: uninstallService({ ...opts, readFile: () => (codes ? transcript(codes) : '') }), files, opts };
  };
  const done = run({ end: 0, delete: 0, stop: 0, sweep: 0 });
  assert.equal(done.res.ok, true);
  assert.equal(existsSync(done.files.launcher), false);
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['/End', '/Delete', 'taskkill.exe /F /T /PID $_.ProcessId', 'terminal-host'].map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'task deleted before the daemon is stopped, the sweep last');

  const left = run({ end: 0, delete: 0, stop: 0, sweep: PROCESSES_REMAIN });
  assert.equal(left.res.ok, true, 'the task is gone: the uninstall stands');
  assert.match(left.res.lines.join('\n'), /still running after the stop/);

  const refused = run(null);
  assert.equal(refused.res.ok, false, 'a refused elevation is not a success');
  assert.match(refused.res.reason ?? '', /elevation refused.*still there/);
  assert.equal(existsSync(refused.files.launcher), true, 'the launcher stays with the task');
});

/**
 * "Quit and stop the background service" (decision of 22/10/2026): the task
 * is disabled before anything is ended — ended alone, its repeating trigger
 * started the daemon again within five minutes — and stays registered. The
 * marker is what the desktop reads at its next launch to start it again.
 */
test('windows: stop disables the task, ends the daemon and the orphans under one elevation, and leaves the marker', () => {
  const calls: string[][] = [];
  const opts = fixture('win32', (n, a) => {
    calls.push([n, ...a]);
    return { code: 0, stdout: n === 'schtasks' ? 'Status: Running' : '', stderr: '' };
  });
  assert.deepEqual(windowsStopSteps(opts).map((s) => s.label), ['disable', 'end', 'stop', 'sweep']);
  const res = stopService({ ...opts, readFile: () => transcript({ disable: 0, end: 0, stop: 0, sweep: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(calls.filter((c) => c[0] === 'powershell').length, 1, 'a single elevated process');
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  const order = ['/Change /TN TimonOrchestrator /DISABLE', '/End /TN TimonOrchestrator', 'taskkill.exe /F /T /PID $_.ProcessId', 'browser-mcp']
    .map((needle) => batch.indexOf(needle));
  assert.ok(order.every((at) => at >= 0), batch);
  assert.deepEqual([...order].sort((x, y) => x - y), order, 'disabled first, the daemon next, the sweep last');
  assert.doesNotMatch(batch, /\/Delete/, 'the task stays registered');
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), true);
  assert.match(res.lines.join('\n'), /starts again when you open Timon/);

  const left = stopService({ ...opts, readFile: () => transcript({ disable: 0, end: 0, stop: 0, sweep: PROCESSES_REMAIN }) });
  assert.equal(left.ok, true);
  assert.match(left.lines.join('\n'), /still running after the stop/);
});

test('windows: stop says when elevation is refused or the task is absent, and leaves no marker', () => {
  const refusedOpts = fixture('win32', (n) => ({ code: n === 'powershell' ? 1223 : 0, stdout: n === 'schtasks' ? 'Status: Ready' : '', stderr: '' }));
  const refused = stopService({ ...refusedOpts, readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /elevation refused.*keep running/);
  assert.equal(existsSync(serviceStoppedMarker(refusedOpts.timonHome)), false);

  const calls: string[][] = [];
  const absentOpts = fixture('win32', (n, a) => { calls.push([n, ...a]); return { code: n === 'schtasks' ? 1 : 0, stdout: '', stderr: 'ERROR: not found' }; });
  const absent = stopService({ ...absentOpts, readFile: () => '' });
  assert.equal(absent.ok, false);
  assert.match(absent.reason ?? '', /no service installed/);
  assert.equal(calls.some((c) => c[0] === 'powershell'), false, 'no prompt for a task that does not exist');

  const failed = stopService({ ...fixture('win32', () => ({ code: 0, stdout: 'Status: Ready', stderr: '' })), readFile: () => transcript({ disable: 1 }) });
  assert.equal(failed.ok, false);
  assert.match(failed.reason ?? '', /could not be disabled/);
});

test('windows: start enables the task, runs it, and clears the marker', () => {
  const opts = fixture('win32', () => ({ code: 0, stdout: 'Status: Disabled', stderr: '' }));
  const marker = serviceStoppedMarker(opts.timonHome);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, 'x');
  assert.deepEqual(windowsStartSteps().map((s) => s.label), ['enable', 'run']);
  const res = startService({ ...opts, readFile: () => transcript({ enable: 0, run: 0 }) });
  assert.equal(res.ok, true, res.lines.join('\n'));
  const batch = readFileSync(elevatedScriptPath(), 'utf8');
  assert.ok(batch.indexOf('/ENABLE') < batch.indexOf('/Run'));
  assert.equal(existsSync(marker), false);

  writeFileSync(marker, 'x');
  const refused = startService({ ...fixture('win32', (n) => ({ code: n === 'powershell' ? 1223 : 0, stdout: 'Status: Disabled', stderr: '' })), readFile: () => '' });
  assert.equal(refused.ok, false);
  assert.match(refused.reason ?? '', /stays disabled/);
  const notRun = startService({ ...opts, readFile: () => transcript({ enable: 0, run: 1 }) });
  assert.equal(notRun.ok, false);
  assert.equal(existsSync(marker), true, 'a service that did not start is still stopped');
});

test('linux: stop and start go through systemctl, the unit stays enabled, the marker follows', { skip: SYSTEMD_IDENTITY }, () => {
  const calls: string[][] = [];
  const opts = fixture('linux', (n, a) => { calls.push([n, ...a]); return { code: 0, stdout: '', stderr: '' }; });
  assert.equal(installService(opts).ok, true);
  calls.length = 0;
  const stopped = stopService(opts);
  assert.equal(stopped.ok, true, stopped.lines.join('\n'));
  assert.deepEqual(calls, [['systemctl', '--user', 'stop', LINUX_UNIT]]);
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), true);
  assert.match(statusService(opts).lines.join('\n'), /stopped\s+: by the user/);
  calls.length = 0;
  const started = startService(opts);
  assert.equal(started.ok, true);
  assert.deepEqual(calls, [['systemctl', '--user', 'start', LINUX_UNIT]]);
  assert.equal(existsSync(serviceStoppedMarker(opts.timonHome)), false);

  const bare = fixture('linux');
  const none = stopService(bare);
  assert.equal(none.ok, false, 'no unit: nothing to stop');
  assert.equal(existsSync(serviceStoppedMarker(bare.timonHome)), false);
});

test('macos: stop boots the agent out and start loads it again; a LaunchDaemon goes through the administrator prompt', () => {
  const calls: string[][] = [];
  const base = fixture('darwin', (n, a) => {
    calls.push([n, ...a]);
    if (n === 'launchctl' && a[0] === 'print') return { code: 113, stdout: '', stderr: '' };
    if (n === 'osascript') return { code: 0, stdout: transcript({ bootout: 0, bootstrap: 0 }), stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  });
  const agent = { ...base, launchDaemonsDir: mkdtempSync(join(tmpdir(), 'timon-ld-')), elevation: 'osascript' as const };
  const plist = plistPath(agent.homeDir);
  mkdirSync(dirname(plist), { recursive: true });
  writeFileSync(plist, 'agent');
  const stopped = stopService(agent);
  assert.equal(stopped.ok, true, stopped.lines.join('\n'));
  assert.deepEqual(calls, [['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`]]);
  assert.equal(existsSync(serviceStoppedMarker(agent.timonHome)), true);
  calls.length = 0;
  const started = startService(agent);
  assert.equal(started.ok, true, started.lines.join('\n'));
  assert.deepEqual(calls.filter((c) => c[1] !== 'print'), [
    ['launchctl', 'bootout', `gui/1000/${MACOS_LABEL}`],
    ['launchctl', 'bootstrap', 'gui/1000', plist],
  ]);
  assert.equal(existsSync(serviceStoppedMarker(agent.timonHome)), false);

  calls.length = 0;
  writeFileSync(join(agent.launchDaemonsDir, `${MACOS_LABEL}.plist`), 'daemon');
  const daemonStopped = stopService(agent);
  assert.equal(daemonStopped.ok, true, daemonStopped.lines.join('\n'));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'osascript');
  assert.match(calls[0]!.join(' '), new RegExp(`launchctl bootout system/${MACOS_LABEL}`));
  assert.doesNotMatch(calls[0]!.join(' '), /rm |unload/, 'booted out, not removed: the next boot loads it again');
  calls.length = 0;
  const daemonStarted = startService(agent);
  assert.equal(daemonStarted.ok, true, daemonStarted.lines.join('\n'));
  assert.match(calls[0]!.join(' '), /launchctl bootstrap system /);
});

// Stays the last test of this file: it answers for all the ones above.
test('no test of this file left a Windows path as a file name in the working directory (TODO #706)', () => {
  assert.deepEqual(backslashNames(process.cwd()).filter((name) => !backslashNamesAtStart.has(name)), []);
});
