import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyEnvOverrides } from '../config/load.js';
import { TimonConfigSchema } from '../config/schema.js';
import { installWithRuntime, uninstallWithRuntime } from './packaged-install.js';
import { agentBinDirs, markPackagedCli, serviceOptsForPlatform } from './service-environment.js';
import { renderMacLauncher, renderWindowsLauncher, type ServiceOpts } from './service-install.js';

const DESKTOP_KEYS = ['TIMON_DESKTOP_EMBEDDED', 'TIMON_DESKTOP_SERVICE', 'TIMON_DESKTOP_VERSION', 'TIMON_DESKTOP_UPGRADE'];

/** `packagedServiceOptions` reads the process environment itself. */
function withProcessEnv<T>(env: NodeJS.ProcessEnv, run: () => T): T {
  const saved = new Map(DESKTOP_KEYS.map((key) => [key, process.env[key]]));
  for (const key of DESKTOP_KEYS) {
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  try {
    return run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** A home whose onboarding wrote `timon.config.json`: no first-launch ports. */
function configuredHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-'));
  writeFileSync(join(home, 'timon.config.json'), '{}');
  return home;
}

const electron: NodeJS.ProcessVersions = { ...process.versions, electron: '38.1.0' };
const node: NodeJS.ProcessVersions = { ...process.versions };
delete node.electron;

const EXECUTABLES: Record<string, string> = {
  darwin: '/Applications/Timon.app/Contents/MacOS/Timon',
  linux: '/opt/Timon/timon',
  win32: 'C:\\Program Files\\Timon\\Timon.exe',
};

function base(platform: NodeJS.Platform): ServiceOpts {
  const win = platform === 'win32';
  return {
    platform,
    homeDir: win ? 'C:\\Users\\sam' : '/Users/sam',
    timonHome: win ? 'C:\\Users\\sam\\.timon' : '/Users/sam/.timon',
    installDir: win ? 'C:\\Program Files\\Timon\\resources\\orchestrator' : '/Applications/Timon.app/Contents/Resources/orchestrator',
    userName: 'sam',
    uid: 501,
    heapMb: 4096,
    port: 3010,
    nodePath: EXECUTABLES[platform]!,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
  };
}

/** What `timon service install` builds, from the packaged CLI launcher. */
function cliOptions(platform: NodeJS.Platform, versions: NodeJS.ProcessVersions): ServiceOpts {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1' };
  markPackagedCli(env, versions, '0.1.3', configuredHome());
  return withProcessEnv(env, () => serviceOptsForPlatform(base(platform), env, EXECUTABLES[platform]!, 3110));
}

/** What the onboarding button builds, inside the desktop's embedded daemon. */
function buttonOptions(platform: NodeJS.Platform): ServiceOpts {
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: '1', TIMON_DESKTOP_EMBEDDED: '1', TIMON_DESKTOP_VERSION: '0.1.3' };
  return withProcessEnv(env, () => serviceOptsForPlatform(base(platform), env, EXECUTABLES[platform]!, 3110));
}

/** `exec` is a closure; `pendingHandover` only concerns the embedded daemon serving the button. */
function comparable(opts: ServiceOpts): Omit<ServiceOpts, 'exec' | 'pendingHandover'> {
  const { exec: _exec, pendingHandover: _handover, ...rest } = opts;
  return rest;
}

test('markPackagedCli: a Node runtime keeps a source checkout\'s environment', () => {
  const env: NodeJS.ProcessEnv = {};
  markPackagedCli(env, node, '0.1.3', mkdtempSync(join(tmpdir(), 'timon-cli-')));
  assert.deepEqual(env, {});
});

test('markPackagedCli: the Electron runtime marks a packaged service, without overriding the desktop', () => {
  const env: NodeJS.ProcessEnv = {};
  markPackagedCli(env, electron, '0.1.3', configuredHome());
  assert.deepEqual(env, { TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_VERSION: '0.1.3' });

  // Run by an agent of the packaged daemon: its own markers stand.
  const embedded: NodeJS.ProcessEnv = { TIMON_DESKTOP_EMBEDDED: '1', TIMON_DESKTOP_VERSION: '0.1.2' };
  markPackagedCli(embedded, electron, '0.1.3', configuredHome());
  assert.deepEqual(embedded, { TIMON_DESKTOP_EMBEDDED: '1', TIMON_DESKTOP_VERSION: '0.1.2' });
});

test('markPackagedCli: before the first config, the service gets the desktop\'s first-launch ports', () => {
  // `daemonEnvOverrides` of a packaged first launch, as the button's daemon receives them.
  const desktop = { PORT: '3010', TIMON_APP_ENABLED: '1', TIMON_APP_PORT: '3110' };
  const fresh = mkdtempSync(join(tmpdir(), 'timon-cli-'));
  const env: NodeJS.ProcessEnv = {};
  markPackagedCli(env, electron, '0.1.3', fresh);
  const cli = applyEnvOverrides(TimonConfigSchema.parse({}), env);
  const button = applyEnvOverrides(TimonConfigSchema.parse({}), desktop);
  assert.equal(cli.daemon.listen.port, button.daemon.listen.port);
  assert.equal(cli.app.listen.port, button.app.listen.port);
  assert.equal(cli.app.enabled, true);

  // Ports the desktop moved because 3010 was taken.
  writeFileSync(join(fresh, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: 3020, appPort: 3120 }));
  const moved: NodeJS.ProcessEnv = {};
  markPackagedCli(moved, electron, '0.1.3', fresh);
  assert.equal(moved.PORT, '3020');
  assert.equal(moved.TIMON_APP_PORT, '3120');

  // Once the config exists, it is read by both sides: nothing to pass.
  const configured: NodeJS.ProcessEnv = {};
  markPackagedCli(configured, electron, '0.1.3', configuredHome());
  assert.equal(configured.PORT, undefined);
});

test('TODO #206: the packaged CLI builds the onboarding button\'s service options', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as NodeJS.Platform[]) {
    assert.deepEqual(comparable(cliOptions(platform, electron)), comparable(buttonOptions(platform)), platform);
  }
});

test('TODO #206: the macOS launcher of `timon service install` runs Electron as Node', () => {
  const launcher = renderMacLauncher(cliOptions('darwin', electron));
  assert.match(launcher, /^export ELECTRON_RUN_AS_NODE='1'$/m);
  assert.match(launcher, /^export TIMON_DESKTOP_SERVICE='1'$/m);
  // The staged copy of this release, not the app bundle the user may replace.
  assert.match(launcher, /desktop-runtime\/releases\/0\.1\.3-[0-9a-f]{12}\/Timon\.app\/Contents\/MacOS\/Timon/);
  // Unmarked, as before the fix: the Timon binary started as an application.
  assert.doesNotMatch(renderMacLauncher(cliOptions('darwin', node)), /ELECTRON_RUN_AS_NODE/);
});

test('TODO #206: the Linux unit and the Windows task of the packaged CLI are marked too', () => {
  const unit = cliOptions('linux', electron).unitContent ?? '';
  assert.match(unit, /Environment="ELECTRON_RUN_AS_NODE=1"/);
  assert.match(unit, /Environment="TIMON_DESKTOP_SERVICE=1"/);
  const launcher = renderWindowsLauncher(cliOptions('win32', electron));
  assert.match(launcher, /set "ELECTRON_RUN_AS_NODE=1"/);
  assert.match(launcher, /set "TIMON_DESKTOP_SERVICE=1"/);
});

test('installWithRuntime: a source checkout installs without staging anything', async () => {
  const opts = base('linux');
  const calls: ServiceOpts[] = [];
  const result = await withProcessEnv({}, () => installWithRuntime(opts, opts.installDir, (o) => {
    calls.push(o);
    return { ok: true, code: 0, lines: ['service installed'] };
  }));
  assert.deepEqual(calls, [opts]);
  assert.deepEqual(result.lines, ['service installed']);
});

test('uninstallWithRuntime: removing the packaged unit removes the marker the Linux desktop waits on', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-cli-'));
  const marker = join(home, 'desktop-runtime', 'installed');
  mkdirSync(join(home, 'desktop-runtime'));
  const opts = { ...base('linux'), timonHome: home, unitName: 'timon-desktop-abc' };
  writeFileSync(marker, opts.unitName);
  await uninstallWithRuntime(opts, () => ({ ok: false, code: 1, lines: ['systemctl refused'] }));
  assert.equal(existsSync(marker), true);
  await uninstallWithRuntime({ ...opts, dryRun: true }, () => ({ ok: true, code: 0, lines: [] }));
  assert.equal(existsSync(marker), true);
  await uninstallWithRuntime(opts, () => ({ ok: true, code: 0, lines: [] }));
  assert.equal(existsSync(marker), false);
});

test('markPackagedCli: the Node the package ships marks a packaged service too', () => {
  const env: NodeJS.ProcessEnv = {};
  markPackagedCli(env, node, '0.1.3', configuredHome(), '/opt/Timon/resources/node/node'); // portability: simulated path
  assert.equal(env.TIMON_DESKTOP_SERVICE, '1');
  assert.equal(env.TIMON_DESKTOP_VERSION, '0.1.3');
});

test('agentBinDirs: one entry per directory holding a detected agent CLI', () => {
  const dirs = agentBinDirs((name) => (name === 'codex' ? '/home/u/.npm-global/bin/codex' : name === 'claude' ? '/home/u/.local/bin/claude' : null));
  assert.deepEqual(dirs.sort(), ['/home/u/.local/bin', '/home/u/.npm-global/bin']);
  assert.deepEqual(agentBinDirs(() => null), []);
});
