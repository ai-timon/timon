/**
 * Moving codex out of the core must change nothing for its missions: the official provider is the
 * product's own (`docs/SECURITY.md` § 6.4.1), so a mission on it still gets Timon's MCP servers with
 * its own token, the vault slice it was granted, and the CLI starts WITHOUT the operator having put
 * `codex` on `pluginPolicy.exec.allow` (the default config of every install).
 *
 * Real registry, real launch through `spawnAgent` with a recording host, the plugin mounted the way
 * the loader mounts it (`builtin: true`).
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/unfenced.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// The sign-in the CLI would find: a stand-in, in a folder of the test's own.
const AUTH = mkdtempSync(join(tmpdir(), 'timon-codex-auth-'));
writeFileSync(join(AUTH, 'auth.json'), JSON.stringify({ tokens: { access_token: 'test-only' } }));
process.env.CODEX_AUTH_DIR = AUTH;
process.on('exit', () => rmSync(AUTH, { recursive: true, force: true }));
// The profile exists only when its CLI is found: a stand-in file is enough, nothing here executes it.
const BIN = mkdtempSync(join(tmpdir(), 'timon-codex-bin-'));
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { config } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend, getDialect, registeredBackendOwners } = await import('../backends/registry.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4246;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

function putGlobalSecret(name: string, value: string): void {
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  dbApi.addSecretGrant(row.id, 'global');
}

const VAULT_VALUE = 'vault-value-codex-witness';
putGlobalSecret('VAULT_CODEX_WITNESS', VAULT_VALUE);
createTestAccount(dbApi, { email: 'codex-witness@example.test', name: 'Witness', passwordHash: 'unused' });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');
assert.ok((await mountOfficialProviders()).includes('provider-codex'));

upsertAgent({
  name: 'codex.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'codex', cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
});

async function launch(): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const child = fakeChild();
  const seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } = { cmd: '', args: [], env: {} };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent('codex.witness', 'ping');
  } finally {
    host.spawn = original;
  }
  return { ...seen, dispose: () => { if (!child.killed) child.kill(); } };
}

test('codex is the release\'s own provider: official, by registration', () => {
  assert.ok(getDialect('codex'), 'the dialect is registered by the plugin');
  assert.equal(backendTrust('codex'), 'official');
  assert.equal(isProductBackend('codex'), true);
});

test('a mission on codex starts the CLI with the default policy, its own token and its vault slice, and writes no token to disk', async () => {
  const run = await launch();
  try {
    assert.match(run.cmd, /codex/, 'the CLI started');
    assert.ok(run.env.TIMON_API_TOKEN && !run.env.TIMON_API_TOKEN.startsWith('timon-seal-'), 'the mission\'s own token, in the process environment');
    assert.equal(run.env.VAULT_CODEX_WITNESS, VAULT_VALUE, 'the vault slice the mission was granted');
    const home = run.env.CODEX_HOME!;
    assert.ok(home, 'CODEX_HOME is set');
    const toml = readFileSync(join(home, 'config.toml'), 'utf8');
    // The file names the token's variable, never the token: codex hands it to its MCP servers by name (`env_vars`).
    assert.equal(toml.includes('timon-seal-'), false, 'no reference left in the file');
    assert.equal(toml.includes(run.env.TIMON_API_TOKEN), false, 'the token is not in the file');
    assert.match(toml, /env_vars = \["TIMON_API_TOKEN", "npm_config_cache"/);
    assert.match(toml, /\[mcp_servers\.timon\]/);
    assert.equal(readFileSync(join(home, 'auth.json'), 'utf8'), readFileSync(join(AUTH, 'auth.json'), 'utf8'), 'the sign-in is exposed to the mission');
    assert.equal(run.args.join(' ').includes(run.env.TIMON_API_TOKEN!), false, 'never in argv');
  } finally {
    run.dispose();
  }
});

test('the per-mission folder lives under the daemon\'s provider-runs, not in the old codex-runs', async () => {
  const run = await launch();
  try {
    const home = run.env.CODEX_HOME!;
    assert.match(home.split(/[\\/]/).slice(-3).join('/'), /^provider-runs\/provider-codex\/[^/]+$/);
  } finally {
    run.dispose();
  }
});


test('Codex profile belongs to its plugin and keeps its historical catalogue position', async () => {
  const { installedProfiles, activeProfiles } = await import('../backends/registry.js');
  assert.equal(registeredBackendOwners().profiles['codex'], 'provider-codex');
  // The fence opens that plugin's scratch and caches, an account's instance included.
  const { backendOwnerPlugin } = await import('../backends/registry.js');
  assert.equal(backendOwnerPlugin('codex'), 'provider-codex');
  assert.equal(backendOwnerPlugin('codex@abcdef12'), 'provider-codex');
  assert.equal(backendOwnerPlugin('no-such-backend'), null);
  assert.deepEqual(installedProfiles().slice(0, 2).map((profile) => profile.id), ['claude', 'codex']);
  assert.deepEqual(activeProfiles().slice(0, 2).map(({ profile }) => profile.id), ['claude', 'codex']);
});


test('onboarding and doctor read Codex branding from its plugin profile', async () => {
  const { setupBackends } = await import('../onboarding.js');
  const { diagnose } = await import('../doctor.js');
  assert.equal(setupBackends().find((backend) => backend.name === 'codex')?.brand, 'openai');
  assert.equal(diagnose().binaries.find((binary) => binary.name === 'codex')?.provider?.brand, 'openai');
});
