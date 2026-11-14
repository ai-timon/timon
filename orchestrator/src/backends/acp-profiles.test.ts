/**
 * The `opencode` and `hermes` profiles (and `pi`, which left the ACP table for its own
 * plugin): what the product declares, when they exist (the binary decides), what the catalogue says of them — notably
 * `selfManagedPermissions`, which the UI reads and only the daemon can supply —
 * and the live model list end to end (profile → catalogue → probe), against
 * stub executables on a throwaway PATH.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-acp-profiles-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.PORT = '3010';
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const REAL_PATH = process.env.PATH;
const REAL_HOME = process.env.HOME;
const POSIX = process.platform !== 'win32';

const { activeProfiles, inactiveProfiles, installedProfiles, registerProfile } = await import('./registry.js');
const { backendCatalog, catalogBackend, primeModelDiscovery } = await import('./catalog.js');
const { discoveredModels, discoveryError } = await import('./model-discovery.js');
const { providerRuntime } = await import('./provider-runtime.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const forgetAcpModels = providerRuntime.acp.forgetModels;
// The three agents are the release's own plugin: mounted the way the daemon loads it.
await mountOfficialProviders();
const { installCommandFor } = await import('../host/machine.js');

const profile = (id: string) => installedProfiles().find((p) => p.id === id);

/** The registry keeps its verdict until something moves; a PATH that changed is
 *  not something it sees, so the test moves it. */
function recompute(): void {
  registerProfile('acp-profiles-test', { id: 'acp-profiles-test', dialect: 'hermes', label: 'x', models: [], defaultModel: null })();
}

/** A machine with exactly these executables: the search also looks in
 *  `~/.local/bin`, where a developer's own Hermes may live. */
function machineWith(scripts: Record<string, string>): void {
  process.env.PATH = stubDir(scripts);
  process.env.HOME = mkdtempSync(join(TMP_HOME, 'home-'));
}

function restoreMachine(): void {
  process.env.PATH = REAL_PATH;
  if (REAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = REAL_HOME;
}

async function until(done: () => boolean): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!done() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
}

function stubDir(scripts: Record<string, string>): string {
  // Beside the Timon home, not in it: no binary is ever resolved from there.
  const dir = mkdtempSync(`${TMP_HOME}-bin-`);
  for (const [name, body] of Object.entries(scripts)) {
    const file = join(dir, name);
    writeFileSync(file, `#!${process.execPath}\n${body}\n`);
    chmodSync(file, 0o755);
  }
  return dir;
}

test('opencode: the product declares its command, its default model and its config paths', () => {
  const p = profile('opencode');
  assert.ok(p);
  assert.equal(p.dialect, 'opencode', 'one provider per agent: the dialect is the profile\'s own id');
  assert.equal(p.requiredBinary, 'opencode');
  assert.equal(p.cmd, undefined, 'the provider brings `opencode`, and `acp` as its argument');
  assert.equal(p.defaultModel, 'opencode/muse-spark-1.3-contributor-free');
  assert.ok(p.models.some((m) => m.slug === p.defaultModel), 'the free default is in the fallback list');
  assert.deepEqual(Object.keys(p.envFrom ?? {}).sort(), ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR']);
});

test('hermes: `hermes-acp` is the binary, and no model is invented', () => {
  const p = profile('hermes');
  assert.ok(p);
  assert.equal(p.dialect, 'hermes');
  assert.equal(p.cmd, 'hermes-acp');
  assert.equal(p.requiredBinary, 'hermes-acp');
  assert.deepEqual(p.models, []);
  assert.equal(p.defaultModel, null);
  assert.deepEqual(Object.keys(p.envFrom ?? {}), ['HERMES_HOME']);
});

test('pi: its plugin runs `pi` itself and invents no model', () => {
  const p = profile('pi');
  assert.ok(p);
  assert.equal(p.dialect, 'pi');
  assert.equal(p.cmd, 'pi');
  assert.equal(p.requiredBinary, 'pi');
  assert.deepEqual(p.models, []);
  assert.equal(p.defaultModel, null);
  // The drawing for this key lives in app/src/components/brand-mark.tsx (guarded by app/src/lib/brand-mark.test.ts).
  assert.equal(p.brand, 'pi');
  assert.equal(p.custom, undefined, 'a product profile, not a user-added one');
});

test('no profile forwards a credential from the daemon', () => {
  for (const id of ['opencode', 'hermes', 'pi']) {
    const p = profile(id)!;
    for (const name of [...Object.keys(p.envFrom ?? {}), ...Object.values(p.envFrom ?? {})]) {
      assert.doesNotMatch(name, /KEY|TOKEN|SECRET|PASSWORD|AUTH/i, `${id}: ${name}`);
    }
    assert.equal(p.env, undefined);
    assert.equal(p.requiredEnv, undefined);
  }
});

test('binaries absent: the ACP profiles are inactive, and the reason names the binary', { skip: !POSIX }, () => {
  machineWith({});
  try {
    recompute();
    const reasons = new Map(inactiveProfiles().map((row) => [row.id, row.reason]));
    assert.match(reasons.get('opencode') ?? '', /binary opencode not found in PATH/);
    assert.match(reasons.get('hermes') ?? '', /binary hermes-acp not found in PATH/);
    assert.match(reasons.get('pi') ?? '', /binary pi not found in PATH/);
    const ids = activeProfiles().map(({ profile: p }) => p.id);
    assert.ok(!ids.includes('opencode') && !ids.includes('hermes') && !ids.includes('pi'));
    assert.equal(catalogBackend('pi'), undefined);
    assert.equal(catalogBackend('opencode'), undefined);
  } finally {
    restoreMachine();
  }
});

test('no install command is invented for Hermes; opencode and Pi have their npm package', () => {
  assert.equal(installCommandFor('hermes-acp', { platform: 'linux', packageManager: 'apt' }), null);
  assert.equal(installCommandFor('pi', { platform: 'linux', packageManager: 'apt' }), 'npm install -g @earendil-works/pi-coding-agent');
  assert.equal(installCommandFor('pi', { platform: 'win32', packageManager: 'winget' }), 'npm install -g @earendil-works/pi-coding-agent');
  assert.equal(installCommandFor('hermes-acp', { platform: 'darwin', packageManager: null }), null);
  assert.equal(installCommandFor('opencode', { platform: 'linux', packageManager: 'apt' }), 'npm install -g opencode-ai');
});

/* An `opencode` that answers `session/new` with the models it "has", one of
   which carries the config dir it was started with; and a `hermes-acp` that is
   just a model list. */
const OPENCODE_STUB = `
import { createInterface } from 'node:readline';
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, authMethods: [] } });
  if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 's', configOptions: [{ id: 'model', category: 'model', currentValue: 'opencode/muse-spark-1.3-contributor-free', options: [
    { value: 'opencode/muse-spark-1.3-contributor-free' }, { value: 'argv/' + process.argv.slice(2).join('+') }, { value: 'config/' + (process.env.OPENCODE_CONFIG_DIR ?? 'unset') }, { value: 'leak/' + (process.env.ACP_PROFILES_DAEMON_SECRET ?? 'none') },
  ] }] } });
});`;

/** A `pi` that prints its model table (`pi --list-models`) and exits. */
const PI_STUB = `process.stdout.write('provider  model   context  max-out  thinking  images\\nstub      argv-' + process.argv.slice(2).join('+') + '  100K     4.1K     yes       no\\n');`;

test('binaries present: the catalogue carries selfManagedPermissions for opencode only, derived from what the provider declared', { skip: !POSIX }, async () => {
  machineWith({ opencode: OPENCODE_STUB, 'hermes-acp': OPENCODE_STUB, pi: PI_STUB });
  try {
    recompute();
    const ids = activeProfiles().map(({ profile: p }) => p.id);
    assert.ok(ids.includes('opencode') && ids.includes('hermes') && ids.includes('pi'));

    // What the route sends: the catalogue, serialised.
    const wire = JSON.parse(JSON.stringify({ backends: backendCatalog() })) as { backends: Array<Record<string, unknown>> };
    const opencode = wire.backends.find((b) => b.id === 'opencode');
    const hermes = wire.backends.find((b) => b.id === 'hermes');
    const pi = wire.backends.find((b) => b.id === 'pi');
    assert.ok(opencode && hermes && pi);
    assert.equal(opencode.selfManagedPermissions, true);
    assert.equal('selfManagedPermissions' in pi, false, 'Timon\'s gate inside Pi applies the permission mode: no badge');
    assert.equal(pi.permissionModeApplied, true, 'the editor says the mode holds for Pi');
    assert.equal('permissionModeApplied' in hermes, false, 'Hermes asks, but its own rules decide what it asks about');
    assert.equal('permissionModeApplied' in opencode, false);
    assert.equal('selfManagedPermissions' in hermes, false, 'Hermes asks: the badge must not show');
    assert.equal(opencode.permissionModel, 'protocol');
    assert.equal(hermes.permissionModel, 'protocol');
    assert.equal(pi.permissionModel, 'protocol');
    assert.equal(pi.defaultModel, null);
    assert.equal(opencode.defaultModel, 'opencode/muse-spark-1.3-contributor-free');
    assert.equal(hermes.defaultModel, null);
    // No other backend claims it.
    for (const b of wire.backends.filter((x) => x.id !== 'opencode')) assert.equal('selfManagedPermissions' in b, false, String(b.id));
    // Reading the catalogue started a probe; let it end before the next test sets its own.
    await until(() => discoveredModels('opencode') !== null && discoveredModels('hermes') !== null && discoveredModels('pi') !== null);
  } finally {
    restoreMachine();
  }
});

test('the live list: profile → catalogue → probe, with the profile\'s environment and nothing of the daemon\'s', { skip: !POSIX }, async () => {
  forgetAcpModels();
  process.env.OPENCODE_CONFIG_DIR = '/user/opencode';
  process.env.ACP_PROFILES_DAEMON_SECRET = 'must-not-reach-the-agent';
  machineWith({ opencode: OPENCODE_STUB, 'hermes-acp': OPENCODE_STUB, pi: PI_STUB });
  try {
    recompute();
    primeModelDiscovery();
    await until(() => catalogBackend('opencode')!.models.some((m) => m.slug.startsWith('config/') && m.slug !== 'config/unset'));
    assert.equal(discoveryError('opencode'), null);
    const slugs = catalogBackend('opencode')!.models.map((m) => m.slug);
    // The profile's own entry first, then what the agent added, sorted.
    assert.deepEqual(slugs, [
      'opencode/muse-spark-1.3-contributor-free',
      'argv/acp',
      'config//user/opencode',
      'leak/none',
    ]);
    assert.equal(catalogBackend('opencode')!.models[0]!.presetLabel, 'Muse Spark 1.3', 'the product\'s metadata is kept on what the agent lists');
    // Hermes was started as launched (no argument).
    assert.ok(catalogBackend('hermes')!.models.some((m) => m.slug === 'argv/'));
    // Pi's list is its own `--list-models` table: the profile names no model.
    await until(() => catalogBackend('pi')!.models.some((m) => m.slug === 'stub/argv---list-models'));
    assert.ok(catalogBackend('pi')!.models.some((m) => m.slug === 'stub/argv---list-models'));
  } finally {
    restoreMachine();
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.ACP_PROFILES_DAEMON_SECRET;
  }
});
