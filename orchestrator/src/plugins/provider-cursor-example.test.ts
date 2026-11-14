/**
 * SECURITY — the Cursor template (`examples/plugin-provider-cursor`) is THIRD-PARTY code (`docs/SECURITY.md` § 6.4.1,
 * `docs/PROVIDERS-SDK.md` § 12.6): not bundled, not shipped in the release. Loaded from its own package.json and its own
 * `apply`, through the real plugin context, the real registration and the real launch (`spawnAgent`), the scripted ACP
 * agent standing in for `cursor-agent` behind `host.spawn`:
 *
 *  - until the superadmin authorizes the RESOLVED path of `cursor-agent`, the plugin does not register;
 *  - once it does, the provider is third-party: no mission token, no vault slice and no daemon environment reach its
 *    process, even with `secrets.inheritEnv`; Timon's MCP servers reach the agent through the session, carrying the
 *    mission's own token swapped on the pipe (never a reference, never the daemon's token);
 *  - with both on the PATH, `cursor-agent` is what the manifest authorizes, never `agent` (grok's binary on many machines,
 *    Cursor's alias); an `agent` alone is accepted if it satisfies the identity (`tests/provider-binary-identity.test.ts`);
 *  - a program at the authorized path that does not describe itself as Cursor's (`declares.binary.identity`) is
 *    refused at launch, saying what it printed; what the plugin never saw work reaches the catalogue (`unverified`).
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import { withoutFence } from '../../tests/helpers/unfenced.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Context } from '@deepseek-ai/cordis';
import type { SpawnOpts } from '../host/index.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const posix = process.platform !== 'win32';
const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, '..', 'backends', 'acp', '__fixtures__', 'fake-acp-agent.mjs');
const EXAMPLE = resolve(HERE, '..', '..', '..', 'examples', 'plugin-provider-cursor');

// `cursor-agent` and a stranger's `agent` on the PATH: stubs that only say who they are (`--version`, the identity the
// plugin declares); a session never runs them (the host's spawn is replaced).
const bin = realpathSync(mkdtempSync(join(tmpdir(), 'timon-cursor-bin-')));
const CURSOR_STUB = '#!/bin/sh\necho "2026.10.16-0a1b2c3"\n';
const GROK_STUB = '#!/bin/sh\necho "grok-cli 0.9.1"\n';
if (posix) {
  for (const [name, body] of [['cursor-agent', CURSOR_STUB], ['agent', GROK_STUB]] as const) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
}
const previousPath = process.env.PATH;
process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
mkdirSync(bin, { recursive: true });
process.env.DAEMON_ONLY_CURSOR_WITNESS = 'daemon-env-witness';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { providerBinaryRequests, grantProviderBinaries, ExecGrantError } = await import('./exec-grants.js');
const { PluginPolicyError, resetPluginPolicyState } = await import('./policy.js');
const { config, setConfig } = await import('../config/load.js');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent, killAgent } = await import('../agent.js');
const { ensureDaemonToken } = await import('../plugins-bundled/http/auth.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend, getDialect, registeredBackendOwners } = await import('../backends/registry.js');
const { backendNames } = await import('../backends/index.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();

const json = JSON.parse(readFileSync(join(EXAMPLE, 'package.json'), 'utf8')) as Record<string, unknown>;
const parsed = readManifest(json);
if (!parsed.ok) throw new Error(parsed.message);
const { manifest } = parsed;
const entry = await import(pathToFileURL(join(EXAMPLE, 'lib', 'index.js')).href) as { apply(ctx: unknown): void | Promise<void> };
/** A context like the one the loader gives an ordinary plugin: NOT `builtin`. */
const context = () => createPluginContext(new Context(), { manifest, version: '0.1.0' }, daemonHost());

const PLANTED_VAULT = 'vault-value-cursor-witness';
createTestAccount(dbApi, { email: 'cursor-witness@example.test', name: 'Witness', passwordHash: 'unused' });
const DAEMON_TOKEN = ensureDaemonToken();
{
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name: 'VAULT_CURSOR_WITNESS', value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(PLANTED_VAULT, key, { secretId: row.id, name: 'VAULT_CURSOR_WITNESS' }) });
  dbApi.addSecretGrant(row.id, 'global');
}
test.after(() => { process.env.PATH = previousPath; delete process.env.DAEMON_ONLY_CURSOR_WITNESS; resetPluginPolicyState(); });

assert.deepEqual(config().pluginPolicy.exec.allow, [], 'the witness runs under the default policy: nothing on the operator\'s allowlist');

test('with both on the PATH, the daemon resolves the canonical `cursor-agent`, not the `agent` alias', { skip: !posix }, () => {
  const requests = providerBinaryRequests(manifest);
  assert.deepEqual(requests, [{ name: 'cursor-agent', found: 'cursor-agent', resolved: join(bin, 'cursor-agent'), allowed: false, refused: null }]);
});

test('REFUSAL: under the default policy the plugin does not register — its program is not authorized', { skip: !posix }, async () => {
  const ctx = context();
  await assert.rejects(async () => entry.apply(ctx), (err: Error) => err instanceof PluginPolicyError && /pluginPolicy\.exec\.allow/.test(err.message));
  assert.equal(getDialect('cursor'), undefined, 'no dialect registered');
  assert.equal(backendNames().includes('cursor'), false, 'no backend dispatchable');
});

test('REFUSAL: accepting another program\'s path (grok\'s `agent`) authorizes nothing', { skip: !posix }, async () => {
  await assert.rejects(grantProviderBinaries(manifest, [join(bin, 'agent')]), (err: Error) => err instanceof ExecGrantError && err.status === 409);
  assert.deepEqual(config().pluginPolicy.exec.allow, []);
});

test('the superadmin accepts the resolved path: the plugin registers, as a provider the product does NOT answer for', { skip: !posix }, async () => {
  const granted = await grantProviderBinaries(manifest, [join(bin, 'cursor-agent')]);
  assert.deepEqual(granted.added, [join(bin, 'cursor-agent')]);
  await entry.apply(context());
  assert.ok(getDialect('cursor'), 'the dialect exists');
  assert.ok(backendNames().includes('cursor'), 'dispatchable');
  assert.equal(registeredBackendOwners().dialects.cursor, 'provider-cursor');
  assert.equal(isProductBackend('cursor'), false, 'third-party by registration: fails closed on every credential');
  assert.equal(backendTrust('cursor'), 'third-party');
});

test('REFUSAL: no mission token, no vault slice, no daemon env reaches the Cursor process; the session carries the mission\'s own token', { skip: !posix }, async () => {
  upsertAgent({
    name: 'cursor.witness',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'cursor', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const previous = config();
  setConfig(withoutFence({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } }));
  const host = getHost();
  const original = host.spawn;
  let child: ReturnType<typeof nodeSpawn> | null = null;
  let piped = '';
  let seen: { cmd: string; args: string[]; env: NodeJS.ProcessEnv } = { cmd: '', args: [], env: {} };
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    seen = { cmd, args, env: (opts?.env ?? {}) as NodeJS.ProcessEnv };
    child = nodeSpawn(process.execPath, [FAKE], { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr!.resume();
    const write = child.stdin!.write.bind(child.stdin!) as (chunk: unknown, ...rest: unknown[]) => boolean;
    child.stdin!.write = ((chunk: unknown, ...rest: unknown[]) => {
      piped += typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      return write(chunk, ...rest);
    }) as typeof child.stdin.write;
    return child as never;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent('cursor.witness', 'ping');
    const deadline = Date.now() + 5000;
    while (!piped.includes('"session/new"') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  } finally {
    host.spawn = original;
    setConfig(previous);
  }
  try {
    assert.match(seen.cmd, /cursor-agent$/, 'the program the manifest declared');
    assert.deepEqual(seen.args, ['acp'], 'in ACP mode');
    assert.equal(Object.keys(seen.env).some((k) => k.toUpperCase() === 'TIMON_API_TOKEN'), false, 'no token variable');
    assert.equal(seen.env.VAULT_CURSOR_WITNESS, undefined, 'no vault slice');
    assert.equal(seen.env.DAEMON_ONLY_CURSOR_WITNESS, undefined, 'inheritEnv hands nothing to a third party');
    const envText = JSON.stringify(seen.env);
    assert.equal(envText.includes(DAEMON_TOKEN), false);
    assert.equal(envText.includes(PLANTED_VAULT), false);
    assert.equal(seen.args.join(' ').includes('timon-seal-'), false, 'no reference on the command line');
    assert.equal(seen.env.TIMON_MISSION_ID !== undefined && seen.env.TIMON_API !== undefined, true, 'identity pointers stay');

    const request = piped.split('\n').filter(Boolean)
      .map((line) => JSON.parse(line) as { method?: string; params?: { mcpServers?: Array<{ name: string; env: Array<{ name: string; value: string }> }> } })
      .find((message) => message.method === 'session/new');
    assert.ok(request, 'the session was opened');
    for (const name of ['timon', 'timon_ask']) {
      const token = request.params?.mcpServers?.find((server) => server.name === name)?.env.find((e) => e.name === 'TIMON_API_TOKEN')?.value;
      assert.ok(token && !token.startsWith('timon-seal-'), `${name}: the daemon swapped the reference for the mission's own token on the pipe`);
      assert.notEqual(token, DAEMON_TOKEN, 'never the daemon\'s token');
    }
    assert.equal(piped.includes('timon-seal-'), false, 'no reference reached the agent');
    assert.equal(piped.includes(DAEMON_TOKEN), false);
    assert.equal(piped.includes(PLANTED_VAULT), false, 'the vault slice is not part of the session');
  } finally {
    if (missionId) killAgent(missionId, { source: 'test' });
    (child as { kill(signal: string): void } | null)?.kill('SIGKILL');
  }
});

test('REFUSAL: another CLI written over the authorized path is refused at launch, saying what it printed', { skip: !posix }, async () => {
  upsertAgent({
    name: 'cursor.namesake',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'cursor', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const host = getHost();
  const original = host.spawn;
  let spawned = false;
  // The identity check itself runs the program, with `--version` and nothing else: only the mission's CLI counts.
  host.spawn = ((name: string, args: string[], opts: SpawnOpts) => {
    if (args.length === 1 && args[0] === '--version') return original(name, args, opts);
    spawned = true;
    throw new Error('never reached');
  }) as typeof host.spawn;
  // grok's installer writes its own `agent` over the file the operator authorized: same path, another program.
  writeFileSync(join(bin, 'cursor-agent'), `${GROK_STUB}# a different size, so the cached answer is not reused\n`);
  try {
    await assert.rejects(() => spawnAgent('cursor.namesake', 'ping'), (error: Error) =>
      /is not the program backend `cursor` runs \(Cursor's agent CLI[^)]*\): `--version` printed "grok-cli 0\.9\.1"/.test(error.message));
    assert.equal(spawned, false, 'nothing was started');
  } finally {
    host.spawn = original;
    writeFileSync(join(bin, 'cursor-agent'), CURSOR_STUB);
  }
});

test('the catalogue says what the Cursor plugin never saw work, in its own words', { skip: !posix }, async () => {
  const { catalogBackend } = await import('../backends/catalog.js');
  const entry = catalogBackend('cursor');
  assert.deepEqual(entry?.unverified?.map((claim) => claim.subject), ['session', 'mcp', 'extension-requests', 'credential-dirs', 'binary-identity']);
  assert.match(entry?.unverified?.[1]?.note ?? '', /\.cursor\/mcp\.json/);
});

test('contrast: a product backend launched the same way DOES get the token and the vault slice', { skip: !posix }, async () => {
  // Guards the refusals above against passing for the wrong reason (no grant, no token at all).
  upsertAgent({
    name: 'cursor.claude',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  const host = getHost();
  const original = host.spawn;
  let env: NodeJS.ProcessEnv = {};
  const stub = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(stub, { pid: 4245, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), killed: false });
  stub.kill = (() => { stub.emit('exit', 0, null); stub.emit('close', 0, null); return true; }) as ChildProcessWithoutNullStreams['kill'];
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    env = (opts?.env ?? {}) as NodeJS.ProcessEnv;
    return stub;
  }) as typeof host.spawn;
  let missionId = '';
  try {
    missionId = await spawnAgent('cursor.claude', 'ping');
  } finally {
    host.spawn = original;
  }
  try {
    assert.ok(env.TIMON_API_TOKEN, 'the product dialect keeps the mission token in its env');
    assert.equal(env.VAULT_CURSOR_WITNESS, PLANTED_VAULT);
  } finally {
    killAgent(missionId, { source: 'test' });
  }
});
