import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';
import { HOME_HELD_EXIT_CODE as DAEMON_HOME_HELD_EXIT_CODE, homeLockHolderFile } from '../home-lock.js';
import {
  daemonEnv, fallbackLog, GAVE_UP_EXIT_CODE, HOME_HELD_EXIT_CODE, HOME_HELD_FIRST_WAIT_MS, HOME_HELD_MAX_WAIT_MS, HOME_LOCK_HOLDER_FILE, HOME_POLL_MS,
  launcherHome, parseLauncherConfig, RAPID_FAILURE_LIMIT, RAPID_FAILURE_WINDOW_MS, readHolderState, RESTART_FIRST_WAIT_MS, RESTART_MAX_WAIT_MS, runLauncher,
  WINDOWS_LAUNCHER_FORMAT, WITNESS_RETRY_SECONDS, windowsPowershell, type HolderState, type WindowsLauncherConfig,
} from './windows-service-launcher.js';

function config(dir: string, over: Partial<WindowsLauncherConfig> = {}): WindowsLauncherConfig {
  return {
    format: WINDOWS_LAUNCHER_FORMAT,
    node: process.execPath,
    args: ['-e', 'console.log("from stdout " + process.env.TIMON_PROBE); console.error("from stderr"); process.exit(0)'],
    cwd: dir,
    env: { TIMON_PROBE: 'set-by-the-config' },
    log: join(dir, 'tmp', 'daemon.log'),
    rotateBytes: 1024,
    witness: { file: join(dir, 'run', 'session-witness.dpapi'), args: ['-NoProfile', '-Command', 'exit 0'] },
    ...over,
  };
}

test('the launcher starts the daemon on daemon.log, output and errors appended, once the witness opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const c = config(dir);
  const code = await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }) });
  assert.equal(code, 0, 'a daemon that exited 0 was stopped on purpose: the launcher ends with it');
  const log = readFileSync(c.log, 'utf8');
  // What `>>daemon.log 2>&1` did, with the configuration's environment.
  assert.match(log, /from stdout set-by-the-config/);
  assert.match(log, /from stderr/);
  const lines = log.split('\n');
  const start = lines.findIndex((line) => /^\[timon-service\] \S+ starting the daemon$/.test(line));
  const exit = lines.findIndex((line) => /^\[timon-service\] \S+ daemon exited with code 0$/.test(line));
  assert.ok(start >= 0 && exit > start, log);
});

test('a witness that does not open yet is waited on, said once, then the daemon starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const answers = [1, 1, 1, 0];
  const slept: number[] = [];
  let started = 0;
  const code = await runLauncher(config(dir), {
    checkWitness: () => ({ code: answers.shift() ?? 0, stderr: 'CryptographicException: Key not\r\n valid for use in specified state.' }),
    sleep: async (ms) => { slept.push(ms); },
    runDaemon: async () => { started += 1; return 0; },
  });
  assert.equal(code, 0);
  assert.equal(started, 1);
  assert.deepEqual(slept, [WITNESS_RETRY_SECONDS * 1000, WITNESS_RETRY_SECONDS * 1000, WITNESS_RETRY_SECONDS * 1000]);
  const log = readFileSync(config(dir).log, 'utf8');
  assert.equal(log.match(/session witness unreadable: CryptographicException: Key not valid for use in specified state\./g)?.length, 1, log);
  assert.equal(log.match(/waiting for the first logon since boot/g)?.length, 1, log);
});

test('a missing witness is refused, never skipped: no daemon, exit 2', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  let started = false;
  const code = await runLauncher(config(dir), {
    checkWitness: () => ({ code: 2, stderr: '' }),
    runDaemon: async () => { started = true; return 0; },
  });
  assert.equal(code, 2);
  assert.equal(started, false);
  assert.match(readFileSync(config(dir).log, 'utf8'), /session witness missing, reinstall the service/);
});

test('a check that cannot run keeps the daemon waiting, and says why', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const answers: Array<{ code: number | null; stderr: string; error?: Error }> = [
    { code: null, stderr: '', error: new Error('spawn powershell.exe ENOENT') }, { code: 0, stderr: '' }];
  await runLauncher(config(dir), { checkWitness: () => answers.shift()!, sleep: async () => {}, runDaemon: async () => 0 });
  assert.match(readFileSync(config(dir).log, 'utf8'), /session witness unreadable: the check could not run: spawn powershell\.exe ENOENT/);
});

test('a log past its limit is moved aside at start, once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const c = config(dir);
  await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }), runDaemon: async () => 0 });
  writeFileSync(c.log, 'x'.repeat(2048));
  await runLauncher(c, { checkWitness: () => ({ code: 0, stderr: '' }), runDaemon: async () => 0 });
  assert.equal(readFileSync(`${c.log}.1`, 'utf8'), 'x'.repeat(2048));
  assert.doesNotMatch(readFileSync(c.log, 'utf8'), /x{10}/);
});

test('the configuration is validated, and its refusal names the file and the command', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const good = config(dir);
  assert.deepEqual(parseLauncherConfig(JSON.stringify(good), 'cfg.json'), good);
  assert.throws(() => parseLauncherConfig('{', 'cfg.json'), /cfg\.json is not valid JSON/);
  assert.throws(() => parseLauncherConfig(JSON.stringify({ ...good, format: 2 }), 'cfg.json'), /cfg\.json is not a Timon service configuration \(format\).*timon service install/);
  assert.throws(() => parseLauncherConfig(JSON.stringify({ ...good, env: { 'A B': '1' } }), 'cfg.json'), /env/);
  assert.equal(existsSync(good.log), false, 'parsing writes nothing');
});

test('PowerShell is named by its full path, the task\'s PATH being whatever it was at start', () => {
  assert.equal(windowsPowershell({ SystemRoot: 'C:\\Windows' }).replace(/\//g, '\\'), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.equal(windowsPowershell({}), 'powershell.exe');
  assert.equal(fallbackLog(join('h', 'run', 'timon-service.json')), join('h', 'tmp', 'daemon.log'));
});

test('the daemon never inherits Electron\'s Node flag; only the configuration sets it', () => {
  assert.deepEqual(daemonEnv({ PATH: 'p', electron_run_as_node: '1' }, { TIMON_HOME: 'h' }), { PATH: 'p', TIMON_HOME: 'h' });
  assert.equal(daemonEnv({ ELECTRON_RUN_AS_NODE: '1' }, { ELECTRON_RUN_AS_NODE: '1' }).ELECTRON_RUN_AS_NODE, '1');
});

/** A clock the launcher's waits move forward, so the tests never really wait. */
function fakeTime() {
  let at = 1_800_000_000_000;
  const slept: number[] = [];
  return {
    slept,
    advance: (ms: number) => { at += ms; },
    elapsed: () => at - 1_800_000_000_000,
    seams: {
      checkWitness: () => ({ code: 0, stderr: '' }),
      now: () => new Date(at),
      sleep: async (ms: number) => { slept.push(ms); at += ms; },
    },
  };
}

test('a home held by another daemon is waited on, then the daemon starts again once the holder lets it go', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  const exits = [HOME_HELD_EXIT_CODE, 0];
  const states: HolderState[] = ['alive', 'alive', 'alive', 'absent'];
  const asked: string[] = [];
  let started = 0;
  const code = await runLauncher(config(dir), {
    ...time.seams,
    runDaemon: async () => { started += 1; return exits.shift() ?? 0; },
    holder: (file) => { asked.push(file); return states.shift() ?? 'absent'; },
  });
  assert.equal(code, 0);
  assert.equal(started, 2, 'started again once, as soon as the holder file was gone');
  assert.ok(time.slept.every((ms) => ms <= HOME_POLL_MS), String(time.slept));
  assert.ok(time.elapsed() < HOME_HELD_FIRST_WAIT_MS, `released after ${time.elapsed()} ms, before the backoff`);
  assert.deepEqual([...new Set(asked)], [join(dir, HOME_LOCK_HOLDER_FILE)]);
  const log = readFileSync(config(dir).log, 'utf8');
  assert.equal(log.match(/home held by another daemon, waiting/g)?.length, 1, log);
  assert.match(log, /home released/);
});

test('a home that stays held is tried again with a backoff from 10 s to 60 s, said once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  const exits = [HOME_HELD_EXIT_CODE, HOME_HELD_EXIT_CODE, HOME_HELD_EXIT_CODE, HOME_HELD_EXIT_CODE, HOME_HELD_EXIT_CODE, HOME_HELD_EXIT_CODE, 0];
  const starts: number[] = [];
  const code = await runLauncher(config(dir), {
    ...time.seams,
    runDaemon: async () => { starts.push(time.elapsed()); return exits.shift() ?? 0; },
    holder: () => 'alive',
  });
  assert.equal(code, 0, 'never given up: the embedded daemon may hold the home all day');
  const gaps = starts.slice(1).map((at, i) => at - starts[i]!);
  assert.deepEqual(gaps, [10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  assert.equal(readFileSync(config(dir).log, 'utf8').match(/home held by another daemon, waiting/g)?.length, 1);
});

test('a holder killed before it removed its file releases the home; a file never seen waits the whole delay', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const killed = fakeTime();
  const killedStates: HolderState[] = ['alive', 'gone'];
  const exits = [HOME_HELD_EXIT_CODE, 0];
  await runLauncher(config(dir), { ...killed.seams, runDaemon: async () => exits.shift() ?? 0, holder: () => killedStates.shift() ?? 'gone' });
  assert.equal(killed.elapsed(), HOME_POLL_MS);

  const never = fakeTime();
  const again = [HOME_HELD_EXIT_CODE, 0];
  await runLauncher(config(dir), { ...never.seams, runDaemon: async () => again.shift() ?? 0, holder: () => 'absent' });
  assert.equal(never.elapsed(), HOME_HELD_FIRST_WAIT_MS, 'a holder that could not write its file is not tried every two seconds');
});

test('a daemon that exited 0 was stopped: the launcher ends without starting it again', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  let started = 0;
  const code = await runLauncher(config(dir), { ...time.seams, runDaemon: async () => { started += 1; return 0; }, holder: () => 'alive' });
  assert.equal(code, 0);
  assert.equal(started, 1);
  assert.deepEqual(time.slept, []);
});

test('a restore exit (75) is restarted at once, not left to the 5-minute trigger', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  const exits = [75, 0];
  let started = 0;
  const code = await runLauncher(config(dir), { ...time.seams, runDaemon: async () => { started += 1; return exits.shift() ?? 0; }, holder: () => 'absent' });
  assert.equal(code, 0);
  assert.equal(started, 2);
  assert.deepEqual(time.slept, [RESTART_FIRST_WAIT_MS]);
  assert.match(readFileSync(config(dir).log, 'utf8'), /daemon exited with code 75\n.*restarting the daemon in 2 s/);
});

test('a daemon that keeps failing fast is handed back to the task after the limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  let started = 0;
  const code = await runLauncher(config(dir), { ...time.seams, runDaemon: async () => { started += 1; return started % 2 ? 1 : null; }, holder: () => 'absent' });
  assert.equal(code, GAVE_UP_EXIT_CODE);
  assert.equal(started, RAPID_FAILURE_LIMIT);
  assert.deepEqual(time.slept, [2_000, 4_000, 8_000, 16_000]);
  assert.ok(time.elapsed() < RAPID_FAILURE_WINDOW_MS);
  assert.match(readFileSync(config(dir).log, 'utf8'), /daemon failed 5 times in 2 minutes, leaving it to the task's next start/);
});

test('failures far apart are each restarted, never given up on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  let started = 0;
  const code = await runLauncher(config(dir), {
    ...time.seams,
    // Each daemon runs three minutes before it fails: none counts as a fast failure of the one before.
    runDaemon: async () => { started += 1; time.advance(180_000); return started > 8 ? 0 : 1; },
    holder: () => 'absent',
  });
  assert.equal(code, 0);
  assert.equal(started, 9);
  assert.ok(time.slept.every((ms) => ms === RESTART_FIRST_WAIT_MS), String(time.slept));
});

test('the log is rotated between two daemons, as at start', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const time = fakeTime();
  const c = config(dir);
  const exits = [75, 0];
  await runLauncher(c, {
    ...time.seams,
    runDaemon: async (_config, fd) => { writeSync(fd, 'x'.repeat(2048)); return exits.shift() ?? 0; },
    holder: () => 'absent',
  });
  assert.match(readFileSync(`${c.log}.1`, 'utf8'), /x{2048}/);
  const log = readFileSync(c.log, 'utf8');
  assert.match(log, /^\[timon-service\] \S+ starting the daemon\n/, 'the new log starts with the next daemon');
});

test('the copied constants match the daemon, and every wait stays under the desktop\'s handover budget', () => {
  assert.equal(HOME_HELD_EXIT_CODE, DAEMON_HOME_HELD_EXIT_CODE);
  assert.equal(HOME_LOCK_HOLDER_FILE, basename(homeLockHolderFile('h')));
  const main = readFileSync(new URL('../../../desktop/src/main.ts', import.meta.url), 'utf8');
  const budget = Number(/const HANDOVER_BUDGET_MS = ([\d_]+);/.exec(main)?.[1]?.replaceAll('_', ''));
  assert.ok(Number.isFinite(budget) && budget > 0, 'HANDOVER_BUDGET_MS found in desktop/src/main.ts');
  assert.ok(HOME_HELD_MAX_WAIT_MS < budget, 'a released home is tried again within the handover');
  assert.ok(RESTART_MAX_WAIT_MS < budget);
});

test('the holder file is read for its pid: absent, alive, gone or unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-launcher-'));
  const file = join(dir, HOME_LOCK_HOLDER_FILE);
  assert.equal(readHolderState(file), 'absent');
  writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: 1 }));
  assert.equal(readHolderState(file), 'alive');
  const ended = spawnSync(process.execPath, ['-e', '']).pid;
  writeFileSync(file, JSON.stringify({ pid: ended, startedAt: 1 }));
  assert.equal(readHolderState(file), 'gone');
  writeFileSync(file, '{');
  assert.equal(readHolderState(file), 'unknown');
  writeFileSync(file, JSON.stringify({ pid: 'x' }));
  assert.equal(readHolderState(file), 'unknown');
  assert.equal(launcherHome(config(dir, { env: { TIMON_HOME: join(dir, 'home') } })), join(dir, 'home'));
  assert.equal(launcherHome(config(dir, { env: {} })), dir);
});
