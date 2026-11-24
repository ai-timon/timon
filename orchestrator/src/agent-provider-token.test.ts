/**
 * SECURITY — the mission's token never reaches a provider plugin's code
 * (`docs/PROVIDERS-SDK.md` § 12.6, § 12.8; decision of 18/10/2026).
 *
 * A dialect registered by a plugin gets neither `TIMON_API_TOKEN`, nor the
 * vault slice, nor the daemon's environment: not in its arguments, not in the
 * environment of the process the daemon launches for it. Its session driver is
 * handed a reference instead, and the daemon swaps it for the real token on the
 * way to the pipe — so the Timon MCP servers it declares still authenticate.
 *
 * The REFUSAL is what is proved here: a search for the token's VALUE, not its
 * key, in everything the plugin saw. The positive half checks the bytes on the
 * real pipe carry the MISSION token, on a machine whose `daemon-token` is a
 * different value (the MCP servers fall back to that file when the variable is
 * missing — a fallback must not be what makes a test pass).
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { BuildSpawnOpts, Dialect, SessionDriver, SessionOpenArgs } from './backends/types.js';

await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { installedProgram } = await import('../tests/helpers/witness-cli.js');
// The provider's CLI is installed and authorized: a third party's launch is compared with what was (TODO #531).
installedProgram('provider-witness');
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, missionEnv } = await import('./agent.js');
const { ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { config, setConfig } = await import('./config/load.js');
const { dbApi } = await import('./db.js');
const { seal } = await import('./secrets/box.js');
const { resolveMasterKey } = await import('./secrets/key.js');
const { registerDialect, registerProfile, isProductBackend } = await import('./backends/registry.js');
const { getBackend } = await import('./backends/index.js');
const { sealMissionToken } = await import('./backends/mission-token-seal.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4243;
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

const OWNER = 'provider-token-test';
const PLANTED = 'planted-by-the-plugin';

/** What the plugin's code saw, as strings it could have kept. */
const seen = { spawnOpts: [] as BuildSpawnOpts[], open: [] as SessionOpenArgs[], mcpEnv: [] as Array<Readonly<Record<string, string>> | undefined> };

const sessionDialect: Dialect = {
  defaultCmd: 'provider-witness',
  persistentProcess: true,
  finishMissionOnExit: true,
  sessionResumable: false,
  sessionStore: 'global',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    seen.spawnOpts.push(opts);
    // A plugin naming the credential in its own spec must not get it through.
    return { cmd: profile.cmd, args: [], env: { ...profile.env, TIMON_API_TOKEN: PLANTED }, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* the driver owns the pipe */ },
  parseLine: () => [],
  extractSessionId: () => null,
  openSession(args): SessionDriver {
    seen.open.push(args);
    seen.mcpEnv.push(args.mcpEnv);
    // What a driver does: put the identity in the environment of the MCP
    // servers it declares to the agent.
    args.io.stdin.write(`${JSON.stringify({ method: 'session/new', mcpServers: [{ name: 'timon', env: args.mcpEnv ?? {} }] })}\n`);
    return {
      info: null,
      start: async () => ({ sessionId: 's', capabilities: { image: false, cancel: false, mcp: true }, resumed: false }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      close: () => {},
    } as unknown as SessionDriver;
  },
};
registerDialect(OWNER, 'witness-session', sessionDialect);
registerProfile(OWNER, { id: 'witness-provider', label: 'Witness', vendor: 'Witness', dialect: 'witness-session', models: [], defaultModel: null });

function putGlobalSecret(name: string, value: string): void {
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  dbApi.addSecretGrant(row.id, 'global');
}

/** Spawns `agent` with a recording host, and gives back what the launch did. */
async function launch(agent: string): Promise<{ env: NodeJS.ProcessEnv; written: string; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const children: FakeChild[] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    envs.push((opts?.env ?? {}) as NodeJS.ProcessEnv);
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original;
  }
  assert.equal(envs.length, 1, 'one spawn, via the host');
  const child = children[0]!;
  let written = '';
  child.stdin.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  // `data` listeners attach in flowing mode; what was already buffered flows on the next tick.
  await new Promise((resolve) => setImmediate(resolve));
  return { env: envs[0]!, written, dispose: () => { if (!child.killed) child.kill(); } };
}

// A user exists: missions get their own `api_tokens` row, distinct from the file.
createTestAccount(dbApi, { email: 'witness@example.test', name: 'Witness', passwordHash: 'unused' });
const DAEMON_TOKEN = ensureDaemonToken();

upsertAgent({
  name: 'witness.provider',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'witness-provider', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});
upsertAgent({
  name: 'witness.claude',
  system_prompt: 'witness — does nothing.',
  config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});
putGlobalSecret('VAULT_WITNESS', 'vault-value-witness');

test('trust: a plugin\'s dialect is third-party, the product\'s own is not, a doubt is third-party', () => {
  assert.equal(isProductBackend('claude'), true);
  assert.equal(isProductBackend('witness-provider'), false);
  assert.equal(isProductBackend('no-such-backend'), false, 'fail closed');
});

test('REFUSAL: a plugin dialect sees the mission token neither in its arguments nor in its process env', async () => {
  const before = seen.open.length;
  const { env, written, dispose } = await launch('witness.provider');
  try {
    assert.equal(seen.open.length, before + 1);
    // The real token is whatever reached the pipe; recover it from there.
    const real = /"TIMON_API_TOKEN":"([^"]+)"/.exec(written)?.[1];
    assert.ok(real, 'the identity reached the real pipe');
    assert.notEqual(real, DAEMON_TOKEN, 'the mission token, not the daemon-token');

    const plugin = JSON.stringify({ open: seen.open.at(-1), spawn: seen.spawnOpts.at(-1), mcpEnv: seen.mcpEnv.at(-1) });
    assert.equal(plugin.includes(real), false, 'not in what the dialect was handed');
    assert.equal(plugin.includes(DAEMON_TOKEN), false);
    assert.match(seen.mcpEnv.at(-1)?.TIMON_API_TOKEN ?? '', /^timon-seal-/, 'a reference, worthless on its own');

    const procEnv = JSON.stringify(env);
    assert.equal(procEnv.includes(real), false, 'not in the process env');
    assert.equal(procEnv.includes(PLANTED), false, 'a spec cannot name the credential');
    assert.equal(Object.keys(env).some((k) => k.toUpperCase() === 'TIMON_API_TOKEN'), false);
    assert.equal(env.TIMON_MISSION_ID !== undefined && env.TIMON_API !== undefined, true, 'identity pointers stay');
  } finally {
    dispose();
  }
});

test('REFUSAL: the vault slice stays out of a plugin dialect\'s process, the product\'s still gets it', async () => {
  const third = await launch('witness.provider');
  const product = await launch('witness.claude');
  try {
    assert.equal(third.env.VAULT_WITNESS, undefined);
    assert.equal(product.env.VAULT_WITNESS, 'vault-value-witness');
    assert.ok(product.env.TIMON_API_TOKEN, 'a product dialect keeps the token in its env (codex, copilot rely on it)');
  } finally {
    third.dispose();
    product.dispose();
  }
});

test('REFUSAL: secrets.inheritEnv does not hand the daemon environment to a plugin dialect', async () => {
  const previous = config();
  process.env.DAEMON_ONLY_WITNESS = 'daemon-env-witness';
  try {
    setConfig({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } });
    const { env, dispose } = await launch('witness.provider');
    try {
      assert.equal(env.DAEMON_ONLY_WITNESS, undefined);
      assert.equal(env.TIMON_API_TOKEN, undefined);
    } finally {
      dispose();
    }
  } finally {
    setConfig(previous);
    delete process.env.DAEMON_ONLY_WITNESS;
  }
});

test('the Timon MCP servers still authenticate: the real pipe carries the mission token', async () => {
  const { written, dispose } = await launch('witness.provider');
  try {
    const line = JSON.parse(written.trim().split('\n')[0]!) as { mcpServers: Array<{ name: string; env: Record<string, string> }> };
    const token = line.mcpServers[0]!.env.TIMON_API_TOKEN!;
    assert.ok(token && !token.startsWith('timon-seal-'), 'the reference was swapped for the token');
    assert.notEqual(token, DAEMON_TOKEN);
    // A valid row: its hash is what authenticates the call.
    const { hashApiToken } = await import('./users/api-tokens.js');
    assert.ok(dbApi.getApiTokenByHash(hashApiToken(token)), 'it is a live mission token');
  } finally {
    dispose();
  }
});

test('missionEnv untrusted: the spec cannot name the credential, whatever its case', () => {
  const env = missionEnv({
    missionId: 'm', agentName: 'a', cwd: tmpdir(), untrusted: true,
    specEnv: { timon_api_token: PLANTED, OWN_SETTING: 'kept' },
  });
  assert.equal(JSON.stringify(env).includes(PLANTED), false);
  assert.equal(env.OWN_SETTING, 'kept', 'the provider\'s own settings pass');
});

test('backend binding: a plugin dialect gets a sealed pipe, and a remote one still gets no mcpEnv', () => {
  const stdin = new PassThrough();
  const opened = seen.open.length;
  const backend = getBackend('witness-provider');
  assert.ok(backend.openSession);
  backend.openSession({
    io: { stdin, stdout: new PassThrough() },
    spawn: { agentName: 'a', systemPrompt: '', message: '', resumeSession: null, cfg: { cwd: tmpdir() }, missionId: 'm' } as unknown as BuildSpawnOpts,
    host: {} as SessionOpenArgs['host'],
    mcpEnv: { TIMON_API_TOKEN: 'real-token-value' },
  });
  assert.equal(JSON.stringify(seen.open.at(-1)).includes('real-token-value'), false);
  assert.equal(seen.open.length, opened + 1);
});

test('seal: a reference cut across two writes is still swapped, other bytes pass untouched', async () => {
  const real = new PassThrough();
  const sealed = sealMissionToken({ stdin: real, stdout: new PassThrough() }, { TIMON_API_TOKEN: 'tok"en', OTHER: 'x' });
  const ref = sealed.mcpEnv.TIMON_API_TOKEN!;
  assert.equal(sealed.mcpEnv.OTHER, 'x');
  let out = '';
  real.on('data', (c: Buffer) => { out += c.toString('utf8'); });
  const line = `{"a":"${ref}","b":"é${ref}"}\n`; // french-ok: a two-byte letter in the stream
  const cut = 14;
  await new Promise<void>((resolve) => sealed.io.stdin.write(line.slice(0, cut), () => resolve()));
  await new Promise<void>((resolve) => sealed.io.stdin.write(line.slice(cut), () => resolve()));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(out, '{"a":"tok\\"en","b":"étok\\"en"}\n'); // french-ok: a two-byte letter in the stream
  assert.equal(out.includes('timon-seal-'), false);
});

test('seal: without a token there is nothing to seal', () => {
  const io = { stdin: new PassThrough(), stdout: new PassThrough() };
  const sealed = sealMissionToken(io, { TIMON_ORCH_URL: 'x' });
  assert.equal(sealed.io, io);
});
