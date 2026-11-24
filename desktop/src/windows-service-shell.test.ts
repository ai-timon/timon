import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launcherCommand, runWindowsServiceShell, serviceShellConfig, shellLog, WINDOWS_SERVICE_FLAG, type ServiceShellApp } from './windows-service-shell.js';

function fakeApp(): { app: ServiceShellApp; exited: Promise<number>; calls: string[] } {
  const calls: string[] = [];
  let exit!: (code: number) => void;
  const exited = new Promise<number>((done) => { exit = done; });
  return {
    calls,
    exited,
    app: {
      setPath: (name, path) => { calls.push(`setPath ${name} ${path}`); },
      getPath: () => join(tmpdir(), 'shell-temp'),
      disableHardwareAcceleration: () => { calls.push('disableHardwareAcceleration'); },
      whenReady: async () => { calls.push('ready'); },
      exit: (code) => { calls.push(`exit ${code}`); exit(code); },
    },
  };
}

test('the service flag names the configuration that follows it, and nothing else', () => {
  assert.equal(serviceShellConfig(['C:\\T\\Timon.exe', WINDOWS_SERVICE_FLAG, 'C:\\Users\\sam\\.timon\\run\\timon-service.json']), 'C:\\Users\\sam\\.timon\\run\\timon-service.json');
  assert.equal(serviceShellConfig(['C:\\T\\Timon.exe']), null);
  assert.equal(serviceShellConfig(['C:\\T\\Timon.exe', WINDOWS_SERVICE_FLAG]), null);
  assert.equal(serviceShellConfig(['C:\\T\\Timon.exe', WINDOWS_SERVICE_FLAG, '--other']), null);
});

test('the shell starts the installation\'s launcher script on the configuration\'s Node', () => {
  const launch = launcherCommand('C:\\h\\run\\timon-service.json', JSON.stringify({ node: 'C:\\T\\resources\\node\\node.exe', cwd: 'C:\\T\\resources\\orchestrator' }));
  assert.equal(launch.command, 'C:\\T\\resources\\node\\node.exe');
  assert.equal(launch.cwd, 'C:\\T\\resources\\orchestrator');
  assert.deepEqual(launch.args, [join('C:\\T\\resources\\orchestrator', 'dist', 'host', 'windows-service-launcher.js'), 'C:\\h\\run\\timon-service.json']);
  assert.throws(() => launcherCommand('cfg.json', '{}'), /cfg\.json names no Node.*timon service install/);
  assert.equal(shellLog(join('h', 'run', 'timon-service.json')), join('h', 'tmp', 'daemon.log'));
});

test('the shell holds the launcher, exits with its code, and never hands it Electron\'s Node flag', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-service-shell-'));
  try {
    const install = join(home, 'install');
    mkdirSync(join(install, 'dist', 'host'), { recursive: true });
    // Exits 7 without the flag, 9 with it, and checks it was given the configuration.
    writeFileSync(join(install, 'dist', 'host', 'windows-service-launcher.js'),
      'process.exit(process.argv[2].endsWith("timon-service.json") ? (process.env.ELECTRON_RUN_AS_NODE ? 9 : 7) : 3);\n');
    mkdirSync(join(home, 'run'), { recursive: true });
    const config = join(home, 'run', 'timon-service.json');
    writeFileSync(config, JSON.stringify({ node: process.execPath, cwd: install }));
    const fake = fakeApp();
    const previous = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try {
      await runWindowsServiceShell(fake.app, ['Timon.exe', WINDOWS_SERVICE_FLAG, config]);
      assert.equal(await fake.exited, 7);
    } finally {
      if (previous === undefined) delete process.env.ELECTRON_RUN_AS_NODE; else process.env.ELECTRON_RUN_AS_NODE = previous;
    }
    // Nothing of the application: its own profile, no drawing.
    assert.ok(fake.calls.includes('disableHardwareAcceleration'));
    assert.ok(fake.calls.some((call) => call.startsWith('setPath userData ') && call.endsWith('timon-service-shell')));
    assert.ok(fake.calls.indexOf('disableHardwareAcceleration') < fake.calls.indexOf('ready'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('a configuration the shell cannot read is said in daemon.log, and the task ends', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-service-shell-'));
  try {
    const config = join(home, 'run', 'timon-service.json');
    const fake = fakeApp();
    await runWindowsServiceShell(fake.app, ['Timon.exe', WINDOWS_SERVICE_FLAG, config]);
    assert.equal(await fake.exited, 1);
    assert.match(readFileSync(join(home, 'tmp', 'daemon.log'), 'utf8'), /^\[timon-service\] \S+ the service shell cannot start: .*ENOENT/m);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
