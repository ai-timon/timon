/**
 * Moving Ollama Cloud out of the core into a plugin of its own must change nothing for its missions: the official provider is the
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
const { backendTrust, isProductBackend, registeredBackendOwners } = await import('../backends/registry.js');
const { resolveIsolation } = await import('../host/isolation.js');
const { TimonConfigSchema } = await import('../config/schema.js');

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
// The key a user puts in the vault for Ollama Cloud, granted `global` as the form does.
putGlobalSecret('OLLAMA_API_KEY', 'ollama-vault-key-witness');
createTestAccount(dbApi, { email: 'codex-witness@example.test', name: 'Witness', passwordHash: 'unused' });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');
const mounted = await mountOfficialProviders();
assert.ok(mounted.includes('provider-codex') && mounted.includes('provider-ollama-cloud'));

upsertAgent({
  name: 'ollama.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'ollama-cloud', cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
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
    await spawnAgent('ollama.witness', 'ping');
  } finally {
    host.spawn = original;
  }
  return { ...seen, dispose: () => { if (!child.killed) child.kill(); } };
}

test('ollama-cloud is the release\'s own profile, registered by its plugin on the codex dialect: official, by registration', () => {
  const { profiles, dialects } = registeredBackendOwners();
  assert.equal(profiles['ollama-cloud'], 'provider-ollama-cloud');
  assert.equal(dialects['codex'], 'provider-codex');
  assert.equal(backendTrust('ollama-cloud'), 'official');
  assert.equal(isProductBackend('ollama-cloud'), true);
});

test('a mission on ollama-cloud starts the CLI with the default policy, its key under its own name, its own token, a provider block and no token on disk', async () => {
  const run = await launch();
  try {
    assert.match(run.cmd, /codex/, 'the CLI started');
    assert.ok(run.env.TIMON_API_TOKEN && !run.env.TIMON_API_TOKEN.startsWith('timon-seal-'), 'the mission\'s own token, in the process environment');
    assert.equal(run.env.OLLAMA_API_KEY, 'ollama-vault-key-witness', 'the key from the vault, under the name the provider block reads');
    assert.equal(run.env.VAULT_CODEX_WITNESS, VAULT_VALUE, 'the vault slice the mission was granted');
    const toml = readFileSync(join(run.env.CODEX_HOME!, 'config.toml'), 'utf8');
    assert.match(toml, /^model_provider = "ollama-cloud"$/m);
    assert.match(toml, /\[model_providers\.ollama-cloud\]\nname = "Ollama Cloud"\nbase_url = "https:\/\/ollama\.com\/v1"\nenv_key = "OLLAMA_API_KEY"\nwire_api = "responses"/);
    assert.equal(toml.includes(run.env.TIMON_API_TOKEN), false, 'the token is not in the file');
    assert.equal(toml.includes('ollama-vault-key-witness'), false, 'nor the key');
    assert.equal(run.args.join(' ').includes('ollama-vault-key-witness'), false, 'nor in argv');
  } finally {
    run.dispose();
  }
});

test('the sign-in folder of ollama-cloud is its own: `.ollama` is kept for its missions and masked from the others, `.codex` the other way round', () => {
  const cfg = TimonConfigSchema.parse({});
  const home = join(tmpdir(), 'ollama-home');
  const denied = (backend: string): string[] => resolveIsolation(cfg, { home, backend }).deny;
  assert.ok(!denied('ollama-cloud').includes(join(home, '.ollama')), 'ollama-cloud keeps its own');
  assert.ok(denied('ollama-cloud').includes(join(home, '.codex')), 'but not the ChatGPT sign-in of codex');
  assert.ok(denied('codex').includes(join(home, '.ollama')), 'a codex mission does not see the Ollama sign-in');
  assert.ok(denied('claude').includes(join(home, '.ollama')));
});
