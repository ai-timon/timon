import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'timon-config-test-'));
process.env.TIMON_HOME = HOME;

const { loadConfig, migrateConfig, applyEnvOverrides, ConfigError } = await import('./load.js');
const { TimonConfigSchema } = await import('./schema.js');

function writeConfig(obj: unknown): string {
  const file = join(HOME, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

test('missing file → defaults', () => {
  const cfg = loadConfig(join(HOME, 'absent.json'));
  assert.equal(cfg.version, 1);
  assert.equal(cfg.profile, 'linux-desktop');
  assert.equal(cfg.edition, 'expert');
  assert.equal(cfg.daemon.listen.port, 3000);
  assert.equal(cfg.host.traefik, true);
  assert.deepEqual(cfg.modules, {});
  // Unset, not `false`: the parsed config carries the operator's wish, and
  // `unsignedPluginsAllowed()` turns its absence into a decision against the
  // key registry (`plugins/pubkey.test.ts`).
  assert.equal(cfg.developer.unsignedPlugins, undefined);
});

test('developer.unsignedPlugins is explicit and validated', () => {
  const cfg = loadConfig(writeConfig({ developer: { unsignedPlugins: true } }));
  assert.equal(cfg.developer.unsignedPlugins, true);
});

test('secrets.inheritEnv: false by default, explicit when asked for', () => {
  // The default is the security property: a missing config file must
  // NOT give the agents back the full environment of the daemon.
  assert.equal(loadConfig(join(HOME, 'absent.json')).secrets.inheritEnv, false);
  assert.equal(loadConfig(writeConfig({ secrets: { inheritEnv: true } })).secrets.inheritEnv, true);
});

test('edition "lite" → the preset disables @timon/kanban-code', () => {
  const cfg = loadConfig(writeConfig({ edition: 'lite' }));
  assert.equal(cfg.modules['@timon/kanban-code'], false);
  assert.ok(cfg.ui.hidden.includes('nav.git'));
});

test('the user file wins over the preset', () => {
  const cfg = loadConfig(writeConfig({ edition: 'lite', modules: { '@timon/kanban-code': true } }));
  assert.equal(cfg.modules['@timon/kanban-code'], true);
  assert.equal(cfg.modules['@timon/grepai'], false);
});

/**
 * The `@timon/*` rename (§10.14) must not turn an already written config
 * into dead keys: `"grepai": false` still disables the module, and
 * a user decision carried by a legacy id always wins over the
 * preset, which names the modules by their current id.
 */
test('legacy ids still enable the right modules', () => {
  const cfg = loadConfig(writeConfig({ modules: { grepai: false, 'core-secrets': { enabled: true, keyring: 'off' } } }));
  assert.equal(cfg.modules['@timon/grepai'], false);
  assert.deepEqual(cfg.modules['@timon/secrets-vault'], { enabled: true, keyring: 'off' });
  assert.equal(cfg.modules['grepai'], undefined, 'the legacy key is translated, not kept twice');

  const lite = loadConfig(writeConfig({ edition: 'lite', modules: { 'kanban-code': true } }));
  assert.equal(lite.modules['@timon/kanban-code'], true);
});

test('invalid key → error naming the key, never a silent default', () => {
  assert.throws(
    () => loadConfig(writeConfig({ profile: 'amiga' })),
    (e: unknown) => e instanceof ConfigError && /profile/.test((e as Error).message),
  );
});

test('~ is expanded in workspacesRoot and the binaries', () => {
  const cfg = loadConfig(writeConfig({
    workspacesRoot: '~/ailleurs',
    host: { binaries: { claude: '~/.local/bin/claude', git: null } },
  }));
  assert.equal(cfg.workspacesRoot, join(homedir(), 'ailleurs'));
  assert.equal(cfg.host.binaries['claude'], join(homedir(), '.local/bin/claude'));
  assert.equal(cfg.host.binaries['git'], null);
});

test('a missing workspacesRoot stays missing: no more ~/webdev default', () => {
  const cfg = loadConfig(writeConfig({}));
  assert.equal(cfg.workspacesRoot, undefined);
});

test('non-loopback listening without auth → refused', () => {
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } })),
    /non-loopback/,
  );
  // The same listening with auth goes through.
  const ok = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'required' } }));
  assert.equal(ok.daemon.listen.host, '0.0.0.0');
});

test('migrateConfig: v(n) → v(n+1), chained up to the current version', () => {
  const migrated = migrateConfig({ profile: 'macos' }, 0);
  assert.equal(migrated.version, 1);
  assert.equal(migrated.profile, 'macos');
});

test('migrateConfig: already up to date → no-op on the content', () => {
  const migrated = migrateConfig({ version: 1, profile: 'macos' }, 1);
  assert.deepEqual(migrated, { version: 1, profile: 'macos' });
});

test('loadConfig: file without a version (pre-Phase 6) → migrated to the current version and rewritten', () => {
  const file = writeConfig({ profile: 'macos' });
  const cfg = loadConfig(file);
  assert.equal(cfg.version, 1);
  assert.equal(cfg.profile, 'macos');

  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.version, 1);
  assert.equal(onDisk.profile, 'macos');
});

test('loadConfig: file already at the current version → no rewrite', () => {
  const file = writeConfig({ version: 1, profile: 'macos' });
  const before = readFileSync(file, 'utf8');
  const cfg = loadConfig(file);
  assert.equal(cfg.version, 1);
  const after = readFileSync(file, 'utf8');
  assert.equal(after, before);
});

test('loadConfig: future version (above the binary) → explicit refusal, no silent degradation', () => {
  const file = writeConfig({ version: 99, profile: 'macos' });
  assert.throws(
    () => loadConfig(file),
    (e: unknown) => e instanceof ConfigError && /version 99/.test((e as Error).message),
  );
});

/**
 * Env layer (plan §2, `env > config > défaut`) — the mechanism that makes a
 * PACKAGED daemon able to find its own files.
 *
 * A package cannot write `daemon.installDir` to `timon.config.json`: inside an
 * AppImage the resources are mounted on a fresh `/tmp/.mount_XXXX` at every
 * launch, so the value would be stale the next morning. The Electron shell
 * passes it at spawn instead, and it must win over the file — which, on a
 * first launch, does not even exist.
 */
test('TIMON_INSTALL_DIR wins over the file, for a packaged daemon', () => {
  const file = writeConfig({ daemon: { installDir: '/opt/from-file/orchestrator' } });
  assert.equal(loadConfig(file).daemon.installDir, '/opt/from-file/orchestrator');

  const cfg = TimonConfigSchema.parse({ daemon: { installDir: '/opt/from-file/orchestrator' } });
  applyEnvOverrides(cfg, { TIMON_INSTALL_DIR: '/tmp/.mount_abc/resources/orchestrator' });
  assert.equal(cfg.daemon.installDir, '/tmp/.mount_abc/resources/orchestrator');
});

test('PORT also moves the config port, not only the socket', () => {
  // `web-app` builds the `ORCHESTRATOR_URL` of the Next app from
  // `daemon.listen.port`: a daemon moved by `PORT` alone gave the UI
  // the address of a missing daemon.
  const cfg = TimonConfigSchema.parse({});
  applyEnvOverrides(cfg, { PORT: '3010' });
  assert.equal(cfg.daemon.listen.port, 3010);
});

test('an empty or unreadable value lets the config decide', () => {
  const cfg = TimonConfigSchema.parse({ daemon: { installDir: '/opt/keep' } });
  applyEnvOverrides(cfg, { TIMON_INSTALL_DIR: '', PORT: 'tcp' });
  assert.equal(cfg.daemon.installDir, '/opt/keep');
  assert.equal(cfg.daemon.listen.port, 3000);
});

/**
 * A package has no Compose beside it: its daemon must serve the UI itself, and
 * on ports that answer for Timon rather than for the v1 living on :3000/:3100.
 * The shell decides that on a first launch and says so through the environment
 * (`desktop/src/config.ts`, `daemonEnvOverrides`).
 */
test('the packaged shell can turn the app on and move it', () => {
  const cfg = TimonConfigSchema.parse({});
  assert.equal(cfg.app.enabled, false, 'schema default: the app stays served by Compose');
  applyEnvOverrides(cfg, { TIMON_APP_ENABLED: '1', TIMON_APP_PORT: '3110', PORT: '3010' });
  assert.equal(cfg.app.enabled, true);
  assert.equal(cfg.app.listen.port, 3110);
  assert.equal(cfg.daemon.listen.port, 3010);
});
