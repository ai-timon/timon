/**
 * First-run wizard (step 5.4) — what it writes, and what it refuses to write.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySetup, buildSetupConfig, defaultProfile, isFirstRun, SetupError } from './setup.js';

function file(): string {
  return join(mkdtempSync(join(tmpdir(), 'timon-setup-test-')), 'timon.config.json');
}

test('firstRun is exactly "the file is absent"', () => {
  const f = file();
  assert.equal(isFirstRun(f), true);
  writeFileSync(f, '{}', 'utf8');
  assert.equal(isFirstRun(f), false, 'an empty but present config is not a first run');
});

test('the profile follows the platform', () => {
  assert.equal(defaultProfile('darwin'), 'macos');
  assert.equal(defaultProfile('win32'), 'windows');
  assert.equal(defaultProfile('linux'), 'linux-desktop');
});

test('only the answered keys are written — the rest stays a default', () => {
  const cfg = buildSetupConfig({ edition: 'lite', profile: 'linux-server' });
  assert.deepEqual(cfg, { version: 1, edition: 'lite', profile: 'linux-server' });
  assert.equal('host' in cfg, false);
  assert.equal('daemon' in cfg, false);
});

test('an emptied binary field means "search the PATH", not a pinned empty string', () => {
  const cfg = buildSetupConfig({ binaries: { claude: '/opt/claude', codex: '  ', gh: null } });
  assert.deepEqual(cfg['host'], { binaries: { claude: '/opt/claude' } });
});

test('portable mode and the app child are written when answered', () => {
  const cfg = buildSetupConfig({ supervisor: 'none', appEnabled: true });
  assert.deepEqual(cfg['daemon'], { supervisor: 'none' });
  assert.deepEqual(cfg['app'], { enabled: true });
});

test('a value the schema would refuse never reaches the disk', () => {
  assert.throws(() => buildSetupConfig({ edition: 'ultimate' }), SetupError);
  assert.throws(() => buildSetupConfig({ profile: 'haiku' }), SetupError);
  assert.throws(() => buildSetupConfig({ supervisor: 'sysvinit' }), SetupError);
  const f = file();
  assert.throws(() => applySetup({ edition: 'ultimate' }, f), SetupError);
  assert.equal(isFirstRun(f), true, 'a refused setup leaves no file behind');
});

test('an existing config is never flattened without force', () => {
  const f = file();
  applySetup({ edition: 'expert' }, f);
  assert.throws(() => applySetup({ edition: 'lite' }, f), SetupError);
  assert.match(JSON.parse(readFileSync(f, 'utf8')).edition, /expert/);
  applySetup({ edition: 'lite' }, f, true);
  assert.equal(JSON.parse(readFileSync(f, 'utf8')).edition, 'lite');
});

test('what is written is valid JSON, and reloadable by the config loader', async () => {
  const f = file();
  applySetup({ edition: 'lite', supervisor: 'none', binaries: { claude: '/opt/c' } }, f);
  const { loadConfig } = await import('./config/load.js');
  const cfg = loadConfig(f);
  assert.equal(cfg.edition, 'lite');
  assert.equal(cfg.modules['@timon/video-factory'], false, 'personal video integration is opt-in');
  assert.equal(cfg.daemon.supervisor, 'none');
  assert.equal(cfg.host.binaries['claude'], '/opt/c');
});

/**
 * What the file must INHERIT from the environment (step 5.7.6).
 *
 * At the first launch of a package, there is no config: the shell picks
 * the ports (3010/3110, free of v1 and of the dev home) and passes them through
 * the env. As soon as this file exists, these overrides are no longer injected: the
 * shell hands the decision back to the file. A file that does not carry them therefore brings
 * the install back to the schema defaults: the daemon moves, the client
 * keeps looking where it was, the window opens on nothing.
 */
test('the ports decided by the environment are written into the file', () => {
  const cfg = buildSetupConfig({
    edition: 'expert',
    envDecisions: { daemonPort: 3010, appPort: 3110, appEnabled: true },
  }) as { daemon?: { listen?: { port?: number } }; app?: { enabled?: boolean; listen?: { port?: number } } };
  assert.equal(cfg.daemon?.listen?.port, 3010);
  assert.equal(cfg.app?.listen?.port, 3110);
  assert.equal(cfg.app?.enabled, true);
});

test("an explicit answer of the user wins over the inheritance", () => {
  const cfg = buildSetupConfig({
    appEnabled: false,
    supervisor: 'systemd-user',
    envDecisions: { daemonPort: 3010, appEnabled: true },
  }) as { daemon?: { supervisor?: string; listen?: { port?: number } }; app?: { enabled?: boolean } };
  assert.equal(cfg.app?.enabled, false, 'the unticked box is an answer, not an absence');
  // The answered supervisor and the inherited port live side by side in the same section.
  assert.equal(cfg.daemon?.supervisor, 'systemd-user');
  assert.equal(cfg.daemon?.listen?.port, 3010);
});

test('without an environment decision, nothing more is written', () => {
  const cfg = buildSetupConfig({ edition: 'lite', envDecisions: {} });
  assert.deepEqual(Object.keys(cfg).sort(), ['edition', 'profile', 'version']);
});

/**
 * `daemon.installDir` is NEVER inherited: in an AppImage it is a
 * `/tmp/.mount_XXXX` path that changes at each launch, writing it would be wrong from
 * the next day.
 */
test('the install folder is never frozen in the file', () => {
  const cfg = buildSetupConfig({
    envDecisions: { daemonPort: 3010 },
  }) as { daemon?: Record<string, unknown> };
  assert.equal(cfg.daemon?.['installDir'], undefined);
});

/**
 * Step 5.9.4: the wizard also asks where the vault lives, in the key the
 * code really reads. The projects folder, for its part, is no longer written: without
 * `workspacesRoot`, the onboarding agents work in
 * `<TIMON_HOME>/workspace`, and an old tab still sending the key
 * writes nothing.
 */
test('the paths go into the keys the code really reads', () => {
  const cfg = buildSetupConfig({
    workspacesRoot: '~/projets',
    vaultPath: '/home/user/brain/vault',
    envDecisions: {},
  } as Parameters<typeof buildSetupConfig>[0]) as { workspacesRoot?: string; settings?: Record<string, string> };
  assert.equal(cfg.workspacesRoot, undefined);
  // `TIMON_BRAIN_VAULT` (settings registry) and NOT `modules['@timon/vault'].path`:
  // the latter is expanded by the loader and read by nobody; it would have
  // looked configured without configuring anything.
  assert.equal(cfg.settings?.TIMON_BRAIN_VAULT, '/home/user/brain/vault');
});

test('a path left empty creates no key', () => {
  const cfg = buildSetupConfig({ vaultPath: '', envDecisions: {} });
  assert.deepEqual(Object.keys(cfg).sort(), ['edition', 'profile', 'version']);
});

test('packaged setup keeps its UI and chosen ports through the real config writer', () => {
  const previous = process.env.TIMON_DESKTOP_EMBEDDED;
  process.env.TIMON_DESKTOP_EMBEDDED = '1';
  try {
    const target = file();
    applySetup({ appEnabled: false, supervisor: 'systemd-user', envDecisions: {
      daemonPort: 43010, appPort: 43110, appEnabled: true,
    } }, target);
    const cfg = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(cfg.app.enabled, true);
    assert.equal(cfg.app.listen.port, 43110);
    assert.equal(cfg.daemon.listen.port, 43010);
    assert.equal(cfg.daemon.supervisor, 'systemd-user');
  } finally {
    if (previous === undefined) delete process.env.TIMON_DESKTOP_EMBEDDED;
    else process.env.TIMON_DESKTOP_EMBEDDED = previous;
  }
});
