import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-system-info-'));

const { daemonLog, daemonMode, importCommands, serviceAction, stdoutIsJournal, windowsTaskStale } = await import('./system-info.js');
const { WINDOWS_SERVICE_REVISION } = await import('./host/service-install.js');

test('daemonMode: the desktop markers first, then the supervisor traces', () => {
  assert.equal(daemonMode({ TIMON_DESKTOP_EMBEDDED: '1', TIMON_DESKTOP_SERVICE: '0' }, 'win32', false), 'embedded');
  assert.equal(daemonMode({ TIMON_DESKTOP_SERVICE: '1' }, 'darwin', false), 'service');
  // TIM-0087: a Windows task written without the marker still sets its log.
  assert.equal(daemonMode({ TIMON_SERVICE_LOG: 'C:\\t\\daemon.log' }, 'win32', false), 'service');
  assert.equal(daemonMode({}, 'linux', true), 'service');
  assert.equal(daemonMode({ INVOCATION_ID: 'abc' }, 'linux', false), 'process');
  assert.equal(daemonMode({ XPC_SERVICE_NAME: 'com.timon.daemon' }, 'darwin', false), 'service');
  assert.equal(daemonMode({ XPC_SERVICE_NAME: 'com.apple.Terminal' }, 'darwin', false), 'process');
  assert.equal(daemonMode({}, 'linux', false), 'process');
});

test('stdoutIsJournal: the variable must name the very stream stdout is', () => {
  const stat = () => ({ dev: 8, ino: 1234 });
  assert.equal(stdoutIsJournal({ JOURNAL_STREAM: '8:1234' }, stat), true);
  // Inherited by a shell whose stdout is a terminal: not the journal.
  assert.equal(stdoutIsJournal({ JOURNAL_STREAM: '8:99' }, stat), false);
  assert.equal(stdoutIsJournal({}, stat), false);
  assert.equal(stdoutIsJournal({ JOURNAL_STREAM: '8:1234' }, () => { throw new Error('EBADF'); }), false);
});

test('daemonLog: the file each supervisor writes, the journal under systemd, nothing invented otherwise', () => {
  const home = join('h', '.timon');
  assert.deepEqual(daemonLog({ mode: 'embedded', platform: 'win32', env: {}, journal: false, home, unit: 'u' }), { kind: 'console' });
  assert.deepEqual(daemonLog({ mode: 'process', platform: 'linux', env: {}, journal: true, home, unit: 'u' }), { kind: 'console' });
  assert.deepEqual(
    daemonLog({ mode: 'service', platform: 'win32', env: { TIMON_SERVICE_LOG: 'C:\\x\\daemon.log' }, journal: false, home, unit: 'u' }),
    { kind: 'file', path: 'C:\\x\\daemon.log' },
  );
  assert.deepEqual(
    daemonLog({ mode: 'service', platform: 'linux', env: {}, journal: true, home, unit: 'timon-orchestrator' }),
    { kind: 'journal', command: 'journalctl --user -u timon-orchestrator' },
  );
  assert.deepEqual(
    daemonLog({ mode: 'service', platform: 'darwin', env: {}, journal: false, home, unit: 'u' }),
    { kind: 'file', path: join(home, 'tmp', 'daemon.log') },
  );
});

test('windowsTaskStale: the current revision marked is current; unmarked or older is stale', () => {
  const current = WINDOWS_SERVICE_REVISION;
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: true, packagedRuntime: true }), false);
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: false, packagedRuntime: true }), true);
  // A source checkout never carries the marker: not a defect there.
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: false, packagedRuntime: false }), false);
  assert.equal(windowsTaskStale({ revision: '2', launcherMarked: true, packagedRuntime: true }), true);
  // A task installed before the SID (TODO #564), and one put back by a rollback.
  assert.equal(windowsTaskStale({ revision: '3', launcherMarked: true, packagedRuntime: true }), true);
  assert.equal(windowsTaskStale({ revision: 'restored', launcherMarked: true, packagedRuntime: true }), true);
  assert.equal(windowsTaskStale({ revision: null, launcherMarked: null, packagedRuntime: true }), true);
});

test('windowsTaskStale (#116): a current task switched to a console is stale; the shapes Timon writes are not', () => {
  const current = WINDOWS_SERVICE_REVISION;
  const consoleTask = { logon: 'InteractiveToken' as const, program: 'cmd.exe', triggers: ['Logon' as const], consoleVisible: true };
  // Revision and marker look right: only the definition shows the console.
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: true, packagedRuntime: true, shape: consoleTask }), true);
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: null, packagedRuntime: false, shape: consoleTask }), true);
  // The off-session task: node.exe under S4U shows no window.
  const s4u = { logon: 'S4U' as const, program: 'node.exe', triggers: ['Boot' as const, 'Time' as const], consoleVisible: false };
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: true, packagedRuntime: true, shape: s4u }), false);
  // A source checkout's session task is a hidden PowerShell by design: reinstalling writes the same.
  const checkout = { logon: 'InteractiveToken' as const, program: 'powershell.exe', triggers: ['Logon' as const], consoleVisible: true };
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: null, packagedRuntime: false, shape: checkout }), false);
  // Unreadable definition: nothing claimed beyond revision and marker.
  assert.equal(windowsTaskStale({ revision: current, launcherMarked: true, packagedRuntime: true, shape: null }), false);
});

test('serviceAction: offered from the UI only when this daemon is not the service', () => {
  assert.deepEqual(serviceAction({ supervisor: null, installed: false, stale: false, mode: 'process', refused: false }), { action: null, actionHere: false });
  assert.deepEqual(serviceAction({ supervisor: 'windows', installed: false, stale: false, mode: 'embedded', refused: false }), { action: 'install', actionHere: true });
  // A unit of another installation: shown, never installed over.
  assert.deepEqual(serviceAction({ supervisor: 'systemd-user', installed: false, stale: false, mode: 'process', refused: true }), { action: null, actionHere: false });
  assert.deepEqual(serviceAction({ supervisor: 'windows', installed: true, stale: false, mode: 'service', refused: false }), { action: null, actionHere: false });
  assert.deepEqual(serviceAction({ supervisor: 'windows', installed: true, stale: true, mode: 'service', refused: false }), { action: 'repair', actionHere: false });
  assert.deepEqual(serviceAction({ supervisor: 'launchd', installed: true, stale: true, mode: 'embedded', refused: false }), { action: 'repair', actionHere: true });
});

test('importCommands: the home is named explicitly and quoted for the shell of the OS', () => {
  assert.deepEqual(importCommands('linux', "/home/o'neil/.timon", true), [
    'timon service uninstall',
    "timon import ARCHIVE.tar.gz --to '/home/o'\\''neil/.timon' --force",
    'timon service install',
  ]);
  assert.deepEqual(importCommands('win32', 'C:\\Users\\Zoé\\.timon', false), [ // french-ok: an accented user folder
    'timon import ARCHIVE.tar.gz --to "C:\\Users\\Zoé\\.timon" --force', // french-ok: an accented user folder
  ]);
});
