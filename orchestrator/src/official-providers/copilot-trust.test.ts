/**
 * Moving Copilot out of the core must change nothing for its missions: the official provider is the
 * product's own (`docs/SECURITY.md` § 6.4.1), so a mission on it starts the CLI under the default policy
 * (nothing on `pluginPolicy.exec.allow`), with its own token and the vault slice it was granted — and the
 * MCP file names the token's variable, never the token.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/unfenced.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const BIN = mkdtempSync(join(tmpdir(), 'timon-copilot-bin-'));
writeFileSync(join(BIN, 'copilot'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { config } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend, getDialect } = await import('../backends/registry.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4247;
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

const VAULT_VALUE = 'vault-value-copilot-witness';
putGlobalSecret('VAULT_COPILOT_WITNESS', VAULT_VALUE);
createTestAccount(dbApi, { email: 'copilot-witness@example.test', name: 'Witness', passwordHash: 'unused' });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');
assert.ok((await mountOfficialProviders()).includes('provider-copilot'));

upsertAgent({
  name: 'copilot.witness',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'copilot', cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
});

async function launch(): Promise<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; stdin: () => string; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const child = fakeChild();
  let written = '';
  child.stdin.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  const seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } = { cmd: '', args: [], env: {} };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen.cmd = cmd; seen.args = args; seen.env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent('copilot.witness', 'ping');
  } finally {
    host.spawn = original;
  }
  await new Promise((resolve) => setImmediate(resolve));
  return { ...seen, stdin: () => written, dispose: () => { if (!child.killed) child.kill(); } };
}

test('copilot is the release\'s own provider: official, by registration', () => {
  assert.ok(getDialect('copilot'), 'the dialect is registered by the plugin');
  assert.equal(backendTrust('copilot'), 'official');
  assert.equal(isProductBackend('copilot'), true);
});

test('a mission on copilot starts the CLI with the default policy, its own token and its vault slice, and the message on stdin', async () => {
  const run = await launch();
  try {
    assert.match(run.cmd, /copilot/, 'the CLI started');
    assert.ok(run.env.TIMON_API_TOKEN && !run.env.TIMON_API_TOKEN.startsWith('timon-seal-'), 'the mission\'s own token, in the process environment');
    assert.equal(run.env.VAULT_COPILOT_WITNESS, VAULT_VALUE, 'the vault slice the mission was granted');
    assert.equal(run.args.join(' ').includes(run.env.TIMON_API_TOKEN!), false, 'never in argv');
    assert.match(run.stdin(), /ping/, 'the message went through stdin');
    const dir = run.env.COPILOT_CUSTOM_INSTRUCTIONS_DIRS!;
    assert.ok(dir, 'the instructions folder is set');
    assert.match(dir.split(/[\\/]/).slice(-3).join('/'), /^provider-runs\/provider-copilot\/[^/]+$/);
    const file = readFileSync(join(dir, 'mcp-config.json'), 'utf8');
    assert.equal(file.includes('timon-seal-'), false, 'no reference left in the file');
    assert.equal(file.includes(run.env.TIMON_API_TOKEN!), false, 'the file names the token\'s variable, never the token');
    const config = JSON.parse(file) as { mcpServers: Record<string, { env?: Record<string, string> }> };
    assert.equal(config.mcpServers.timon?.env?.TIMON_API_TOKEN, '${TIMON_API_TOKEN}');
    assert.ok(readdirSync(join(dir, 'instructions')).includes('timon.instructions.md'));
  } finally {
    run.dispose();
  }
});
