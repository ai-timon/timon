import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  controlDesktopService, daemonLogHint, desktopServiceRunner, forgetMissingWindowsService, forgetServiceStopped, hasDesktopService,
  MACOS_SERVICE_LABEL, packagedUnit, readSessionWitnessArgs,
  repairSessionWitness, restartDesktopService, sealSessionWitnessArgs, serviceStoppedByUser, serviceStoppedMarkerFile, startDesktopService,
  startStoppedServiceFailureMessage, stopServiceCopy, stopServiceFailureMessage,
  WINDOWS_SERVICE_REVISION, WINDOWS_TASK, windowsLauncher, windowsRepairDeclinedFile, windowsRestartRunner, windowsTaskNeverRan,
  windowsRestartSeams, windowsServiceRevisionFile, windowsSessionWitnessFile, windowsTaskState, windowsTaskRunning, endWindowsLauncher, serviceHeldOutFile, serviceHeldOutSince,
  readWindowsTaskShape, disableWindowsTask,
} from './service.js';
import type { DesktopConfig } from './config.js';

test('first run can reopen onboarding when the registered unit has bad settings', async () => {
  const calls: string[][] = [];
  const result = await startDesktopService('/tmp/desktop-repair-test', true, async (args) => {
    calls.push(args);
    return { stdout: 'bad-setting\n' };
  }, 'linux');
  assert.equal(result, 'needs-repair');
  assert.deepEqual(calls, [['--user', 'show', packagedUnit('/tmp/desktop-repair-test'), '--property=LoadState', '--value']]);
});

test('valid units start normally and completed installations do not return to onboarding', async () => {
  for (const firstRun of [true, false]) {
    const calls: string[][] = [];
    const result = await startDesktopService('/tmp/desktop-repair-test', firstRun, async (args) => {
      calls.push(args);
      return { stdout: 'loaded\n' };
    }, 'linux');
    assert.equal(result, 'started');
    assert.equal(calls.length, firstRun ? 2 : 1);
    assert.deepEqual(calls.at(-1), ['--user', 'start', packagedUnit('/tmp/desktop-repair-test')]);
  }
});

test('an unavailable user manager is not mistaken for a repairable unit', async () => {
  await assert.rejects(startDesktopService('/tmp/desktop-repair-test', true, async () => {
    throw new Error('Cannot connect to bus');
  }, 'linux'), /Cannot connect to bus/);
});

/** The part of a rendered plist the desktop reads; the real renderers are compared in `packaging.test.ts`. */
function plistFor(home: string, launcher?: string): string {
  const program = launcher ? `<key>ProgramArguments</key><array><string>/bin/sh</string><string>${launcher}</string></array>` : '';
  return `<plist><dict>${program}<key>EnvironmentVariables</key>\n<dict>\n  <key>TIMON_HOME</key><string>${home}</string>\n</dict></dict></plist>\n`;
}

function writePlist(dir: string, home: string, launcher?: string): string {
  mkdirSync(dir, { recursive: true });
  const plist = join(dir, `${MACOS_SERVICE_LABEL}.plist`);
  writeFileSync(plist, plistFor(home, launcher));
  return plist;
}

/** A machine whose one launchd label is held by `owner`, with the seams that point at it. */
function macMachine(kind: 'agent' | 'daemon', owner: string, launcher?: string): { userHome: string; daemonsDir: string; plist: string } {
  const userHome = mkdtempSync(join(tmpdir(), 'timon-macos-owner-'));
  const daemonsDir = join(userHome, 'LaunchDaemons');
  return { userHome, daemonsDir, plist: writePlist(kind === 'daemon' ? daemonsDir : join(userHome, 'Library', 'LaunchAgents'), owner, launcher) };
}

/** Symlinks, modes and a launcher path with `/` are what these read; none of it runs on Windows. */
const posixOnly = { skip: process.platform === 'win32' };

for (const kind of ['agent', 'daemon'] as const) {
  test(`TODO #735: macOS, the ${kind} of another home is no service of this one, and is left alone`, async () => {
    const { userHome, daemonsDir } = macMachine(kind, '/Users/me/.timon');
    const scratch = '/tmp/timon-scratch-home';
    assert.equal(hasDesktopService(scratch, 'darwin', userHome, daemonsDir), false);
    assert.equal(hasDesktopService('/Users/me/.timon', 'darwin', userHome, daemonsDir), true, 'its own home still sees it');

    const calls: string[][] = [];
    const exec = async (args: string[]) => { calls.push(args); return { stdout: 'pid = 812' }; };
    const seams = { daemonsDir, userHome, kill: () => assert.fail('another home\'s daemon is never signalled') };
    assert.equal(await startDesktopService(scratch, false, exec, 'darwin', 501, seams), 'needs-repair', 'the embedded daemon serves');
    await assert.rejects(restartDesktopService(scratch, exec, 'darwin', 501, seams), /runs for \/Users\/me\/\.timon.*left in place/);
    assert.deepEqual(calls, [], 'launchd was not asked anything');
  });
}

test('TODO #735: macOS, a home is the same home however it is spelled', posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-macos-spelling-'));
  const real = join(root, 'Real Home & co');
  mkdirSync(real);
  const link = join(root, 'link');
  symlinkSync(real, link);
  // launchd reads the plist as XML: a home with an ampersand is escaped in it.
  const { userHome, daemonsDir } = macMachine('agent', real.replaceAll('&', '&amp;'));
  for (const spelling of [real, link, `${real}/`, real.toUpperCase()]) {
    assert.equal(hasDesktopService(spelling, 'darwin', userHome, daemonsDir), true, spelling);
  }
  assert.equal(hasDesktopService(`${real}-other`, 'darwin', userHome, daemonsDir), false);
});

test('TODO #735: macOS, the LaunchDaemon must name this home in its plist and in its launcher', posixOnly, () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-macos-launcher-'));
  const home = join(root, "it's mine");
  const launcher = join(home, 'run', 'timon-service.sh');
  mkdirSync(dirname(launcher), { recursive: true });
  const { userHome, daemonsDir } = macMachine('daemon', home, launcher);
  const write = (named: string) => writeFileSync(launcher, `#!/bin/sh\nexport PORT='3010'\nexport TIMON_HOME='${named.replaceAll("'", "'\\''")}'\nexec node\n`);

  assert.equal(hasDesktopService(home, 'darwin', userHome, daemonsDir), true, 'no launcher yet: the plist decides');
  write(home);
  assert.equal(hasDesktopService(home, 'darwin', userHome, daemonsDir), true, 'a quote in the path is read back');
  write(join(root, 'elsewhere'));
  assert.equal(hasDesktopService(home, 'darwin', userHome, daemonsDir), false, 'the launcher runs for another home');
});

test('TODO #735: macOS, a plist without a home runs on the default one, as the daemon reads it', () => {
  const userHome = mkdtempSync(join(tmpdir(), 'timon-macos-default-'));
  const agents = join(userHome, 'Library', 'LaunchAgents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, `${MACOS_SERVICE_LABEL}.plist`), '<plist/>');
  const daemonsDir = join(userHome, 'no-daemons');
  assert.equal(hasDesktopService(join(userHome, '.timon'), 'darwin', userHome, daemonsDir), true);
  assert.equal(hasDesktopService(join(userHome, 'scratch'), 'darwin', userHome, daemonsDir), false);
});

test('TODO #735: macOS, a plist that cannot be read proves nothing against this home', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
  const { userHome, daemonsDir, plist } = macMachine('agent', '/Users/me/.timon');
  chmodSync(plist, 0o000);
  assert.equal(hasDesktopService('/tmp/timon-scratch-home', 'darwin', userHome, daemonsDir), true);
  chmodSync(plist, 0o600);
});

test('TODO #735: macOS, this home\'s agent beside another home\'s LaunchDaemon is kickstarted, the LaunchDaemon left alone', async () => {
  const { userHome, daemonsDir } = macMachine('daemon', '/Users/me/.timon');
  writePlist(join(userHome, 'Library', 'LaunchAgents'), '/tmp/timon-scratch-home');
  assert.equal(hasDesktopService('/tmp/timon-scratch-home', 'darwin', userHome, daemonsDir), true);

  const calls: string[][] = [];
  const exec = async (args: string[]) => { calls.push(args); return { stdout: '' }; };
  const seams = { daemonsDir, userHome, kill: () => assert.fail('the LaunchDaemon is another home\'s') };
  assert.equal(await startDesktopService('/tmp/timon-scratch-home', false, exec, 'darwin', 501, seams), 'started');
  await restartDesktopService('/tmp/timon-scratch-home', exec, 'darwin', 501, seams);
  assert.deepEqual(calls, [
    ['kickstart', '-k', `gui/501/${MACOS_SERVICE_LABEL}`],
    ['kickstart', '-k', `gui/501/${MACOS_SERVICE_LABEL}`],
  ]);
});

test('macOS detects and kickstarts the per-user LaunchAgent', async () => {
  const userHome = mkdtempSync(join(tmpdir(), 'timon-macos-service-'));
  writePlist(join(userHome, 'Library', 'LaunchAgents'), '/tmp/timon-home');
  assert.equal(hasDesktopService('/tmp/timon-home', 'darwin', userHome, join(userHome, 'no-daemons')), true);

  const calls: string[][] = [];
  assert.equal(await startDesktopService('/tmp/timon-home', false, async (args) => {
    calls.push(args);
    return { stdout: '' };
  }, 'darwin', 502, { daemonsDir: join(userHome, 'no-daemons'), userHome }), 'started');
  assert.deepEqual(calls, [['kickstart', '-k', `gui/502/${MACOS_SERVICE_LABEL}`]]);
});

test('macOS: a LaunchDaemon is the service; it is waited on, and restarted by signal without root', async () => {
  const userHome = mkdtempSync(join(tmpdir(), 'timon-macos-daemon-'));
  const daemonsDir = join(userHome, 'LaunchDaemons');
  assert.equal(hasDesktopService('/tmp/timon-home', 'darwin', userHome, daemonsDir), false);
  writePlist(daemonsDir, '/tmp/timon-home');
  assert.equal(hasDesktopService('/tmp/timon-home', 'darwin', userHome, daemonsDir), true);

  const calls: string[][] = [];
  const killed: number[] = [];
  const exec = async (args: string[]) => { calls.push(args); return { stdout: 'system/com.timon.daemon = {\n\tpid = 812\n}' }; };
  assert.equal(await startDesktopService('/tmp/timon-home', false, exec, 'darwin', 501, { daemonsDir, userHome }), 'started');
  assert.deepEqual(calls, [], 'kickstart of the system domain would need root');
  await restartDesktopService('/tmp/timon-home', exec, 'darwin', 501, { daemonsDir, userHome, kill: (pid) => { killed.push(pid); } });
  assert.deepEqual(calls, [['print', `system/${MACOS_SERVICE_LABEL}`]]);
  assert.deepEqual(killed, [812]);
  await assert.rejects(restartDesktopService('/tmp/timon-home', async () => ({ stdout: 'state = waiting' }), 'darwin', 501,
    { daemonsDir, userHome, kill: () => assert.fail('no pid, no signal') }), /not running/);
});

test('the setup restart replaces the running service on macOS and Linux', async () => {
  const seen: string[][] = [];
  const exec = async (args: string[]) => { seen.push(args); return { stdout: '' }; };
  const userHome = mkdtempSync(join(tmpdir(), 'timon-no-service-'));
  await restartDesktopService('/tmp/timon-home', exec, 'darwin', 501, { daemonsDir: join(userHome, 'no-daemons'), userHome });
  await restartDesktopService('/tmp/timon-home', exec, 'linux');
  assert.deepEqual(seen, [
    ['kickstart', '-k', `gui/501/${MACOS_SERVICE_LABEL}`],
    ['--user', 'restart', packagedUnit('/tmp/timon-home')],
  ]);
  await assert.rejects(restartDesktopService('/tmp/timon-home', exec, 'freebsd'), /No desktop service/);
});

/**
 * Windows: the boot task is the service once it recorded its revision. The
 * desktop then waits on it instead of starting a second daemon on the same
 * port — the task may be holding its daemon until the user's first logon.
 */
/**
 * TODO #342: on a PC joined to Microsoft Entra ID, `/Run` answered "SUCCESS:
 * Attempted" and Windows never started the task (`LastTaskResult` 0x41303,
 * `LastRunTime` 30/11/1999). The desktop waited 30 s, then "does not answer"
 * with no log to read. It now reads the task state and says so.
 */
test('windows: a task Windows never starts is reported as never-ran, not waited on', async () => {
  const never = 'LastTaskResult=267011\r\nLastRunTime=1999-11-30T00:00:00\r\n';
  assert.equal(windowsTaskNeverRan(never), true);
  assert.equal(windowsTaskNeverRan('LastTaskResult=267011\r\nLastRunTime=\r\n'), true);
  assert.equal(windowsTaskNeverRan('LastTaskResult=267011\r\nLastRunTime=2026-10-14T09:12:00\r\n'), false, 'both signals are required');
  assert.equal(windowsTaskNeverRan('LastTaskResult=267009\r\nLastRunTime=1999-11-30T00:00:00\r\n'), false);
  // 0x800710e0: Task Scheduler refused a second instance while one ran (TIM-0158). Started, not failed.
  assert.equal(windowsTaskNeverRan('LastTaskResult=2147946720\r\nLastRunTime=2026-11-18T19:05:05\r\n'), false);
  assert.equal(windowsTaskNeverRan(''), false, 'unreadable is not "never"');
  assert.equal(windowsTaskNeverRan('LastTaskResult=\r\n'), false);

  const run = async () => ({ stdout: '' });
  const pauses: number[] = [];
  const queries: string[][] = [];
  const result = await startDesktopService('/tmp/timon-home', false, run, 'win32', 0, {}, {
    query: async (args) => { queries.push(args); return { stdout: never }; },
    pause: async (ms) => { pauses.push(ms); },
    budgetMs: 0,
  });
  assert.equal(result, 'never-ran');
  assert.equal(queries.length, 1);
  assert.match(queries[0]!.at(-1)!, new RegExp(`Get-ScheduledTaskInfo -TaskName '${WINDOWS_TASK}'`));

  // Started a moment after `/Run`: the first read said never, the second did not.
  let reads = 0;
  assert.equal(await startDesktopService('/tmp/timon-home', false, run, 'win32', 0, {}, {
    query: async () => ({ stdout: reads++ === 0 ? never : 'LastTaskResult=267009\r\nLastRunTime=2026-10-14T09:12:00\r\n' }),
    pause: async () => undefined,
  }), 'started');
  assert.equal(reads, 2);

  // No PowerShell, no ScheduledTasks module: nothing proves "never".
  assert.equal(await startDesktopService('/tmp/timon-home', false, run, 'win32', 0, {}, {
    query: async () => { throw new Error('powershell not found'); },
  }), 'started');
});

test('windows: a /Run refused because an instance already runs (0x800710e0) is a started service (TIM-0158)', async () => {
  const run = async () => ({ stdout: '' });
  assert.equal(await startDesktopService('/tmp/timon-home', false, run, 'win32', 0, {}, {
    query: async () => ({ stdout: 'LastTaskResult=2147946720\r\nLastRunTime=2026-11-18T19:05:05\r\n' }),
    pause: async () => undefined,
  }), 'started');
});

test('windows: the handover reads whether the task still runs, and unreadable is not running', async () => {
  const asked: string[][] = [];
  assert.equal(await windowsTaskRunning(async (args) => { asked.push(args); return { stdout: 'State=Running\r\n' }; }), true);
  assert.match(asked[0]!.at(-1)!, new RegExp(`Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\\\'`));
  assert.equal(await windowsTaskRunning(async () => ({ stdout: 'State=Ready\r\n' })), false);
  assert.equal(await windowsTaskRunning(async () => ({ stdout: 'State=Queued\r\n' })), false);
  assert.equal(await windowsTaskRunning(async () => { throw new Error('no ScheduledTasks module'); }), false);
});

test('windows: the handover ends only the launcher of this home, and its tree', async () => {
  const commands: string[] = [];
  await endWindowsLauncher("C:\\Users\\O'Neil\\.timon", async (args) => { commands.push(args.at(-1)!); return { stdout: '' }; });
  assert.equal(commands.length, 1);
  assert.ok(commands[0]!.includes("c:\\users\\o''neil\\.timon"), commands[0]);
  // Revision 6 names its configuration; a revision-5 task still runs the batch until it is rewritten.
  assert.ok(commands[0]!.includes('timon-service.json'), commands[0]);
  assert.ok(commands[0]!.includes('timon-service.cmd'), commands[0]);
  for (const program of ['cmd.exe', 'node.exe', 'timon.exe']) assert.ok(commands[0]!.includes(`'${program}'`), program);
  assert.match(commands[0]!, /\$_\.ProcessId -ne \$PID/);
  assert.match(commands[0]!, /taskkill\.exe \/F \/T \/PID/);
});

test('the service refused the home is read from its marker, only from the time asked', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-held-out-'));
  assert.equal(serviceHeldOutSince(home, 0), false, 'no marker');
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(serviceHeldOutFile(home), '{"at":1000,"pid":7}\n');
  assert.equal(serviceHeldOutSince(home, 1000), true);
  assert.equal(serviceHeldOutSince(home, 999), true);
  assert.equal(serviceHeldOutSince(home, 1001), false, 'a refusal before the fallback says nothing');
  writeFileSync(serviceHeldOutFile(home), 'not json');
  assert.equal(serviceHeldOutSince(home, 0), false);
  writeFileSync(serviceHeldOutFile(home), '{"at":"1000"}');
  assert.equal(serviceHeldOutSince(home, 0), false);
});

test('windows: the boot task is detected by its revision, started, and restarted by its launcher tree', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-windows-service-'));
  assert.equal(hasDesktopService(home, 'win32'), false);
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(join(home, 'run', 'timon-service.vbs'), "' revision 1");
  assert.equal(hasDesktopService(home, 'win32'), false, 'the logon task of revision 1 never supervised its daemon');
  writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
  assert.equal(hasDesktopService(home, 'win32'), true);

  const calls: string[][] = [];
  const ran = { query: async () => ({ stdout: 'LastTaskResult=267009\r\nLastRunTime=2026-10-14T09:12:00\r\n' }) };
  assert.equal(await startDesktopService(home, true, async (args) => {
    calls.push(args);
    if (args[0] === '/Run') throw new Error('Access is denied.');
    return { stdout: '' };
  }, 'win32', 0, {}, ran), 'started', 'the triggers start it anyway: a refused /Run is not a failure');
  assert.deepEqual(calls, [['/Query', '/TN', WINDOWS_TASK], ['/Run', '/TN', WINDOWS_TASK]]);
  // An uninstall deleted the task but left its revision: nothing would start
  // a daemon, so the embedded one serves (0.1.2-rc.5 reinstall).
  const absent: string[][] = [];
  assert.equal(await startDesktopService(home, false, async (args) => {
    absent.push(args);
    throw new Error('ERROR: The system cannot find the file specified.');
  }, 'win32'), 'needs-repair');
  assert.deepEqual(absent, [['/Query', '/TN', WINDOWS_TASK]], 'no /Run on a task that does not exist');

  // The restart goes through the host adapter's elevated runner: no Windows
  // command is spelled out here.
  const seams = windowsRestartSeams(
    { home, daemon: { listen: { host: '127.0.0.1', port: 3001 } }, app: { enabled: true, listen: { host: '127.0.0.1', port: 3101 } } } as DesktopConfig,
    { execPath: 'C:\\Timon\\Timon.exe', resourcesPath: 'C:\\Timon\\resources', version: '1.2.3' }, {});
  assert.equal(seams.env.ELECTRON_RUN_AS_NODE, '1');
  assert.equal(seams.env.TIMON_HOME, home);
  assert.equal(seams.env.PORT, '3001');
  const restarts: string[][] = [];
  await restartDesktopService(home, async (args) => { restarts.push(args); return { stdout: '' }; }, 'win32', 0, {}, seams);
  assert.deepEqual(restarts, [[windowsRestartRunner(seams.resourcesPath)]]);
  assert.ok(restarts[0]![0]!.endsWith(join('dist', 'host', 'windows-restart-runner.js')));
  await assert.rejects(restartDesktopService(home, async () => ({ stdout: '' }), 'win32'), /packaged service runner/);
  await assert.rejects(restartDesktopService(home, async () => { throw new Error('elevation refused'); }, 'win32', 0, {}, seams),
    /elevation refused/, 'a refused elevation is reported, not swallowed');
});

test('a first-run kickstart refused by launchd loads the agent then starts it, and never throws', async () => {
  const userHome = join(tmpdir(), 'timon-no-user-home');
  const daemonsDir = join(tmpdir(), 'timon-no-launch-daemons');
  const calls: string[][] = [];
  const exec = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'kickstart' && args[1] === '-k') throw new Error('Could not find service');
    return { stdout: '' };
  };
  assert.equal(await startDesktopService('/tmp/timon-home', false, exec, 'darwin', 501, { daemonsDir, userHome }), 'started');
  assert.deepEqual(calls, [
    ['kickstart', '-k', `gui/501/${MACOS_SERVICE_LABEL}`],
    ['bootstrap', 'gui/501', join(userHome, 'Library', 'LaunchAgents', `${MACOS_SERVICE_LABEL}.plist`)],
    ['kickstart', `gui/501/${MACOS_SERVICE_LABEL}`],
  ]);
  // launchd refusing everything must not become a startup dialog: the health wait decides.
  const refuse = async () => { throw new Error('launchctl failed'); };
  assert.equal(await startDesktopService('/tmp/timon-home', false, refuse, 'darwin', 501, { daemonsDir, userHome }), 'started');
  assert.equal(await startDesktopService('/tmp/timon-home', false, refuse, 'linux'), 'started');
});

test('the daemon log is named only when it exists', () => {
  const home = join('C:', 'Users', 'rom', '.timon');
  const log = join(home, 'tmp', 'daemon.log');
  for (const platform of ['win32', 'darwin'] as const) {
    assert.ok(daemonLogHint('en', home, true, platform, () => true).includes(`Inspect its log in ${log}`));
    const missing = daemonLogHint('en', home, true, platform, () => false);
    assert.ok(missing.includes('has not written a log yet'), missing);
    assert.ok(!missing.includes('Inspect its log in'), missing);
    assert.ok(!missing.includes('daemon.log'), missing);
    assert.ok(!missing.includes(log), missing);
  }
  assert.ok(daemonLogHint('en', home, true, 'win32', () => false).includes(WINDOWS_TASK));
  assert.ok(daemonLogHint('en', home, true, 'linux', () => false).includes('journalctl'));
  assert.ok(daemonLogHint('en', home, false, 'win32', () => false).includes('supervisor'));
  assert.equal(daemonLogHint('fr', home, true, 'win32', () => true), `Consultez son journal dans ${log}.`);
});

function windowsHome(withLauncher = true): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-witness-'));
  mkdirSync(join(home, 'run'), { recursive: true });
  if (withLauncher) writeFileSync(windowsLauncher(home), '@echo off\r\n');
  return home;
}
const exitCode = (code: number | string) => Object.assign(new Error(`exit ${code}`), { code });

test('TIM-0107: a session witness DPAPI cannot open is sealed again from the interactive session', async () => {
  const home = windowsHome();
  const calls: string[] = [];
  const result = await repairSessionWitness(home, async (args) => {
    const script = args[args.length - 1]!;
    calls.push(script.includes('ConvertFrom-SecureString') ? 'seal' : 'read');
    if (!script.includes('ConvertFrom-SecureString')) throw exitCode(1);
    assert.ok(script.includes(windowsSessionWitnessFile(home).replace(/'/g, "''")), 'sealed where the launcher reads it');
    return {};
  }, 'win32');
  assert.equal(result, 'resealed');
  assert.deepEqual(calls, ['read', 'seal']);
});

test('TIM-0107: a readable witness, a missing launcher, another OS or a check that could not run change nothing', async () => {
  const sealed: string[] = [];
  const exec = (failure?: unknown) => async (args: string[]) => {
    if (args[args.length - 1]!.includes('ConvertFrom-SecureString')) sealed.push('seal');
    else if (failure !== undefined) throw failure;
    return {};
  };
  assert.equal(await repairSessionWitness(windowsHome(), exec(), 'win32'), 'ok');
  assert.equal(await repairSessionWitness(windowsHome(false), exec(exitCode(1)), 'win32'), 'skipped', 'no launcher, no task to wait on the witness');
  assert.equal(await repairSessionWitness(windowsHome(), exec(exitCode(1)), 'linux'), 'skipped');
  assert.equal(await repairSessionWitness(windowsHome(), exec(exitCode('ENOENT')), 'win32'), 'skipped', 'no PowerShell: not a verdict on the witness');
  assert.equal(await repairSessionWitness(windowsHome(), exec(Object.assign(new Error('timeout'), { killed: true, code: null })), 'win32'), 'skipped');
  assert.deepEqual(sealed, []);
});

test('TIM-0107: a missing witness is sealed again, a seal that fails is reported', async () => {
  const home = windowsHome();
  assert.equal(await repairSessionWitness(home, async (args) => {
    if (!args[args.length - 1]!.includes('ConvertFrom-SecureString')) throw exitCode(2);
    return {};
  }, 'win32'), 'resealed');
  assert.equal(await repairSessionWitness(home, async (args) => {
    throw exitCode(args[args.length - 1]!.includes('ConvertFrom-SecureString') ? 1 : 2);
  }, 'win32'), 'failed');
});

test('the witness commands run without profile, prompt or execution policy surprises', () => {
  for (const args of [readSessionWitnessArgs("C:\\Users\\o'brien\\.timon\\run\\w"), sealSessionWitnessArgs("C:\\Users\\o'brien\\.timon\\run\\w")]) {
    assert.deepEqual(args.slice(0, 5), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command']);
    assert.match(args[5]!, /o''brien/, 'a quote in the path is doubled');
  }
});

test('TIM-0108: the boot task is confirmed gone only when both lookups agree, and a failed lookup is never "gone"', async () => {
  const fail = async () => { throw new Error('boom'); };
  const says = (word: string) => async () => ({ stdout: `${word}\r\n` });
  assert.deepEqual(await windowsTaskState(says(''), says('absent')), { schtasks: true, lookup: 'absent', exists: true, confirmedAbsent: false });
  assert.deepEqual(await windowsTaskState(fail, says('absent')), { schtasks: false, lookup: 'absent', exists: false, confirmedAbsent: true });
  assert.equal((await windowsTaskState(fail, says('present'))).exists, true, 'schtasks failing on its own does not condemn a task the module sees');
  const unknown = await windowsTaskState(fail, fail);
  assert.deepEqual([unknown.exists, unknown.confirmedAbsent], [false, false], 'nothing to wait on, but nothing deleted either');
  assert.equal((await windowsTaskState(fail, says('garbage'))).lookup, 'unknown');
});

test('TIM-0108: forgetting a deleted task drops its revision and the "not now", and only when a revision was there', () => {
  const home = windowsHome(false);
  writeFileSync(windowsRepairDeclinedFile(home), '0.1.5\n');
  assert.deepEqual(forgetMissingWindowsService(home), [], 'no revision: the task was already gone, the answer stands');
  assert.ok(existsSync(windowsRepairDeclinedFile(home)));
  writeFileSync(windowsServiceRevisionFile(home), `${WINDOWS_SERVICE_REVISION}\n`);
  assert.equal(forgetMissingWindowsService(home).length, 2);
  assert.equal(hasDesktopService(home, 'win32'), false, 'the desktop no longer believes in a service');
  assert.equal(existsSync(windowsRepairDeclinedFile(home)), false);
});

// "Quit and stop the background service" (decision of 22/10/2026): plain Quit
// leaves the service's daemon on purpose; this one ends it through the host
// adapter, and the marker it leaves is what the next launch reads to start it.
test('quit and stop: stop and start go through the host adapter runner, and the marker follows', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-stop-service-'));
  const seams = windowsRestartSeams(
    { home, daemon: { listen: { host: '127.0.0.1', port: 3001 } }, app: { enabled: true, listen: { host: '127.0.0.1', port: 3101 } } } as DesktopConfig,
    { execPath: 'C:\\Timon\\Timon.exe', resourcesPath: 'C:\\Timon\\resources', version: '1.2.3' }, {});
  const calls: string[][] = [];
  assert.equal(await controlDesktopService('stop', seams, async (args) => { calls.push(args); return { stdout: 'service stopped\n' }; }), 'service stopped');
  await controlDesktopService('start', seams, async (args) => { calls.push(args); return { stdout: '' }; });
  assert.deepEqual(calls, [[desktopServiceRunner(seams.resourcesPath), 'stop'], [desktopServiceRunner(seams.resourcesPath), 'start']]);
  assert.ok(calls[0]![0]!.endsWith(join('dist', 'host', 'desktop-service-runner.js')), 'no Windows command is spelled out here');
  await assert.rejects(controlDesktopService('stop', seams, async () => { throw new Error('elevation refused'); }), /elevation refused/);
  // The update that finds the previous version's daemon still running asks the same runner to replace it.
  calls.length = 0;
  assert.equal(await controlDesktopService('restart', seams, async (args) => { calls.push(args); return { stdout: 'service restarted (scheduled task TimonOrchestrator)\r\n' }; }),
    'service restarted (scheduled task TimonOrchestrator)');
  assert.deepEqual(calls, [[desktopServiceRunner(seams.resourcesPath), 'restart']]);

  assert.equal(serviceStoppedByUser(home), false);
  mkdirSync(join(home, 'run'), { recursive: true });
  writeFileSync(serviceStoppedMarkerFile(home), '2026-10-22T10:00:00.000Z\n');
  assert.equal(serviceStoppedByUser(home), true);
  forgetServiceStopped(home);
  assert.equal(serviceStoppedByUser(home), false);
  assert.equal(serviceStoppedMarkerFile(home), join(home, 'run', 'service-stopped'), 'the host adapter\'s own marker');
});

test('quit and stop: the prompt names the permission step of the OS, in the user\'s language', () => {
  const win = stopServiceCopy('fr-FR', 'win32');
  assert.match(win.trayItem, /Quitter et arrêter/); // french-ok: the French locale under test
  assert.match(win.detail, /Windows demande une autorisation/);
  assert.equal(win.buttons.length, 2);
  const mac = stopServiceCopy('en-US', 'darwin');
  assert.equal(mac.trayItem, 'Quit and stop the background service');
  assert.match(mac.detail, /administrator password/);
  assert.doesNotMatch(stopServiceCopy('en', 'linux').detail, /permission|password/, 'systemd asks nothing');
  assert.match(stopServiceFailureMessage(new Error('boom'), 'en').detail, /keeps running[\s\S]*boom/);
  assert.match(startStoppedServiceFailureMessage(new Error('refused'), '/h', 'fr').detail, /timon service start[\s\S]*\/h[\s\S]*refused/);
});

test('windows #116: the task\'s shape is read with schtasks /XML, and an unreadable one is null', async () => {
  const calls: string[][] = [];
  const xml = '<Task><Triggers><BootTrigger/></Triggers><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals>'
    + '<Actions><Exec><Command>cmd.exe</Command></Exec></Actions></Task>';
  const shape = await readWindowsTaskShape(async (args) => { calls.push(args); return { stdout: xml }; });
  assert.deepEqual(calls, [['/Query', '/TN', WINDOWS_TASK, '/XML', 'ONE']]);
  assert.equal(shape?.consoleVisible, true);
  assert.deepEqual(shape?.triggers, ['Boot']);
  assert.equal(await readWindowsTaskShape(async () => { throw new Error('ERROR: The system cannot find the file specified.'); }), null);
  assert.equal(await readWindowsTaskShape(async () => ({ stdout: '' })), null);
});

test('windows #116: a task Windows never starts is disabled with schtasks, and a refusal is reported', async () => {
  const calls: string[][] = [];
  await disableWindowsTask(async (args) => { calls.push(args); return { stdout: 'SUCCESS' }; });
  assert.deepEqual(calls, [['/Change', '/TN', WINDOWS_TASK, '/DISABLE']]);
  await assert.rejects(disableWindowsTask(async () => { throw new Error('ERROR: Access is denied.'); }), /Access is denied/);
});
