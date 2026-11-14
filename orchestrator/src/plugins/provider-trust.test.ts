/**
 * SECURITY — who answers for a provider plugin's CLI (`docs/SECURITY.md` § 6.4.1).
 *
 * A provider shipped in the release and vouched for by it ("official") is treated as
 * the product's own: it gets the mission's token in the process environment and the
 * vault slice, with ONE token per launch. Anything else — an installed copy, a
 * "built-in" the release does not vouch for, a profile a third party puts on an
 * official dialect — gets neither. The refusals come first on purpose: the trust is
 * decided by the loader from where the files live, never by an id or by the plugin.
 *
 * Real plugin contexts, the real registry, the real loader and a real launch through
 * `spawnAgent` with a recording host.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/unfenced.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import type { NativeProviderDefinition } from '../backends/engine/definition.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { ensureDaemonToken } = await import('../plugins-bundled/http/auth.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { backendTrust, isProductBackend } = await import('../backends/registry.js');
const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginLoader } = await import('./loader.js');
const { createHttpPlugin } = await import('../kernel/http-service.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4245;
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

function allowExec(...names: string[]): () => void {
  const previous = config();
  setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: names } } }));
  return () => setConfig(previous);
}

function pluginContext(pluginId: string, binary: string, builtin: boolean) {
  const res = readManifest({ timon: {
    id: pluginId, apiVersion: 12, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: binary }] },
  } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0', ...(builtin ? { builtin: true } : {}) }, daemonHost());
}

/** What the provider's code saw during its last launch. */
type Seen = { plan: string; env: string };

/** A program the provider's `launch` returns INSTEAD of its profile's, to prove the launch itself is held to the policy. */
const forced: { cmd: string | null } = { cmd: null };

function definition(ctx: ReturnType<typeof pluginContext>, id: string, binary: string, seen: Seen): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null, writeUserInput: () => { /* a launch carries the turn */ } },
    launch: async (spawn, profile) => {
      const plan = await ctx.provider.mcp(spawn);
      const base = await ctx.provider.env(spawn);
      seen.plan = JSON.stringify(plan);
      seen.env = JSON.stringify(base);
      const configText = ctx.provider.runtime.mcp.serializeMcpJson(plan.servers) ?? '';
      return { cmd: forced.cmd ?? profile.cmd, args: [], env: { ...profile.env }, cwd: spawn.cfg.cwd, initialStdin: `${configText}\n` };
    },
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { timon: true },
    declares: { binary: { names: [binary] } },
  };
}

function profileOf(id: string, dialect: string, cmd?: string) {
  return { id, label: id, vendor: 'Acme', dialect, models: [], defaultModel: null, ...(cmd ? { cmd } : {}) };
}

function putGlobalSecret(name: string, value: string): void {
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  dbApi.addSecretGrant(row.id, 'global');
}

async function launch(agent: string): Promise<{ env: NodeJS.ProcessEnv; written: string; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const children: FakeChild[] = [];
  const spawned: Array<{ env: NodeJS.ProcessEnv }> = [];
  host.spawn = ((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    spawned.push({ env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
    return child;
  }) as typeof host.spawn;
  try {
    await spawnAgent(agent, 'ping');
  } finally {
    host.spawn = original;
  }
  assert.equal(spawned.length, 1, 'one spawn, via the host');
  const child = children[0]!;
  let written = '';
  child.stdin.on('data', (chunk: Buffer) => { written += chunk.toString('utf8'); });
  await new Promise((resolve) => setImmediate(resolve));
  return { env: spawned[0]!.env, written, dispose: () => { if (!child.killed) child.kill(); } };
}

createTestAccount(dbApi, { email: 'trust-witness@example.test', name: 'Witness', passwordHash: 'unused' });
const DAEMON_TOKEN = ensureDaemonToken();
const VAULT_VALUE = 'vault-value-trust-witness';
putGlobalSecret('VAULT_TRUST_WITNESS', VAULT_VALUE);

const seenOfficial: Seen = { plan: '', env: '' };
const seenThird: Seen = { plan: '', env: '' };

// The release's own provider (a free id: `claude` / `codex` stay the core's until they migrate), the
// installed one, and a stranger that puts a profile on the official dialect.
const official = pluginContext('fx-official-plugin', 'claude', true);
const third = pluginContext('fx-third-plugin', 'acme-third', false);
const intruder = pluginContext('fx-intruder-plugin', 'acme-intruder', false);
// The third parties' programs exist on this host: a third party's launch is compared, file to file, with
// what the operator authorized (TODO #531), and a program that resolves to nothing is refused.
const fixtureBin = mkdtempSync(join(tmpdir(), 'timon-trust-bin-'));
for (const name of ['acme-third', 'acme-intruder']) {
  const file = join(fixtureBin, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
  if (process.platform !== 'win32') chmodSync(file, 0o755);
}
process.env.PATH = `${fixtureBin}${delimiter}${process.env.PATH ?? ''}`;
const restoreExec = allowExec('acme-third', 'acme-intruder');
official.provider.registerProvider(definition(official, 'fx-official', 'claude', seenOfficial));
official.backends.registerProfile(profileOf('fx-official-profile', 'fx-official'));
third.provider.registerProvider(definition(third, 'fx-third', 'acme-third', seenThird));
third.backends.registerProfile(profileOf('fx-third-profile', 'fx-third'));
// A third party's profile on the official dialect: the code that talks to the CLI is the release's own.
intruder.backends.registerProfile(profileOf('fx-intruder-profile', 'fx-official', 'acme-intruder'));
// ...and one that would simply run the official dialect's own program (`claude`).
intruder.backends.registerProfile(profileOf('fx-intruder-claude-profile', 'fx-official'));

for (const [name, backend] of [['fx.official', 'fx-official-profile'], ['fx.third', 'fx-third-profile'], ['fx.intruder', 'fx-intruder-profile'], ['fx.intruder-claude', 'fx-intruder-claude-profile']] as const) {
  upsertAgent({
    name,
    system_prompt: 'witness — does nothing.',
    config: { backend, cwd: tmpdir(), skills: [], memory_scope: 'NONE' },
  });
}

/* ── Refusals first ──────────────────────────────────────────────────────── */

test('REFUSAL: a plugin installed by the user is third-party, whatever it calls itself', async () => {
  assert.equal(backendTrust('fx-third-profile'), 'third-party');
  assert.equal(isProductBackend('fx-third-profile'), false);
  const { env, written, dispose } = await launch('fx.third');
  try {
    assert.equal(env.TIMON_API_TOKEN, undefined, 'no token in the process environment');
    assert.equal(env.VAULT_TRUST_WITNESS, undefined, 'no vault slice');
    assert.equal(JSON.stringify(env).includes(DAEMON_TOKEN), false);
    assert.equal(seenThird.env.includes(VAULT_VALUE), false, 'the plugin does not see the vault either');
    assert.match(seenThird.plan, /timon-seal-/, 'it got references, which the daemon swaps on the road to the process');
    const real = /"TIMON_API_TOKEN":"([^"]+)"/.exec(written)?.[1];
    assert.ok(real && !real.startsWith('timon-seal-'), 'the mcp config on stdin carries the real token');
  } finally {
    dispose();
  }
});

test('REFUSAL: a third party\'s profile on an official dialect is not the product\'s', async () => {
  assert.equal(backendTrust('fx-official-profile'), 'official');
  assert.equal(backendTrust('fx-intruder-profile'), 'third-party', 'the dialect is official, the profile is not vouched for');
  const { env, dispose } = await launch('fx.intruder');
  try {
    assert.equal(env.TIMON_API_TOKEN, undefined);
    assert.equal(env.VAULT_TRUST_WITNESS, undefined);
    // The official plugin's code runs for the stranger's profile: it must not be handed the vault for it.
    assert.equal(seenOfficial.env.includes(VAULT_VALUE), false, 'the official code was not given the vault for a third party\'s mission');
  } finally {
    dispose();
  }
});

test('REFUSAL: a third party\'s profile cannot run the official dialect\'s subscription CLI', async () => {
  const host = getHost();
  const original = host.spawn;
  const started: string[] = [];
  host.spawn = ((cmd: string) => { started.push(cmd); return fakeChild(); }) as typeof host.spawn;
  try {
    await assert.rejects(spawnAgent('fx.intruder-claude', 'ping'), /never executable by a plugin/);
  } finally {
    host.spawn = original;
  }
  assert.deepEqual(started, [], 'nothing started');
});

test('REFUSAL: an unresolvable backend is third-party (a doubt withholds the credentials)', () => {
  assert.equal(backendTrust('no-such-backend'), 'third-party');
  assert.equal(isProductBackend('no-such-backend'), false);
});

test('REFUSAL: a third party\'s launch cannot start claude or codex, even when its buildSpawn returns them', async () => {
  const host = getHost();
  const original = host.spawn;
  const started: string[] = [];
  host.spawn = ((cmd: string) => { started.push(cmd); return fakeChild(); }) as typeof host.spawn;
  try {
    for (const cmd of ['claude', 'codex', 'sh', 'timon']) {
      forced.cmd = cmd;
      await spawnAgent('fx.third', 'ping').catch(() => undefined);
    }
    // The program it declared still starts.
    forced.cmd = null;
    await spawnAgent('fx.third', 'ping');
  } finally {
    forced.cmd = null;
    host.spawn = original;
  }
  assert.equal(started.length, 1, `only the declared program started, got: ${started.join(', ')}`);
  assert.match(started[0]!, /acme-third/);
});

test('REFUSAL: an official provider launches the subscription CLI it declares, and nothing else', async () => {
  const host = getHost();
  const original = host.spawn;
  const started: string[] = [];
  host.spawn = ((cmd: string) => { started.push(cmd); return fakeChild(); }) as typeof host.spawn;
  try {
    for (const cmd of ['codex', 'sh', 'node', 'timon']) {
      forced.cmd = cmd;
      await spawnAgent('fx.official', 'ping').catch(() => undefined);
    }
    assert.deepEqual(started, [], 'codex was not declared by this provider: refused with the launchers');
    forced.cmd = 'claude';
    await spawnAgent('fx.official', 'ping');
  } finally {
    forced.cmd = null;
    host.spawn = original;
  }
  assert.equal(started.length, 1);
  assert.match(started[0]!, /claude/);
});

/* ── The official provider ───────────────────────────────────────────────── */

test('an official provider receives the token and the vault slice, with ONE token for the launch', async () => {
  const { env, written, dispose } = await launch('fx.official');
  try {
    const real = env.TIMON_API_TOKEN;
    assert.ok(real && !real.startsWith('timon-seal-'), 'the token is in the process environment, as for a core dialect');
    assert.notEqual(real, DAEMON_TOKEN, 'the mission\'s own token, not the daemon-token');
    assert.equal(env.VAULT_TRUST_WITNESS, VAULT_VALUE, 'the vault slice the mission was granted');
    // The reference the provider wrote swaps to the very token the process got: nothing was revoked by a second issue.
    const inPayload = /"TIMON_API_TOKEN":"([^"]+)"/.exec(written)?.[1];
    assert.equal(inPayload, real, 'one token per launch, shared by the environment and the references');
    assert.match(JSON.parse(seenOfficial.plan).identityEnv.TIMON_API_TOKEN as string, /^timon-seal-[0-9a-f]{32}$/, 'the plugin\'s code still holds a reference');
    assert.equal(seenOfficial.plan.includes(real), false);
    // `ctx.provider.env()` is the product's slice for it now: the seal made its `trusted` real.
    assert.equal(seenOfficial.env.includes(VAULT_VALUE), true);
    assert.equal(seenOfficial.env.includes(real), false, 'never the token');
  } finally {
    dispose();
  }
});

/* ── Through the loader: the trust comes from where the files live ───────── */

const PLUGIN_ID = 'fx-loaded-plugin';
const PROVIDER_ID = 'fx-loaded';
const PROFILE_ID = 'fx-loaded-profile';

/** A provider plugin on disk: its host half registers a provider and a profile. */
function writeProviderPlugin(dir: string, binary: string): void {
  mkdirSync(join(dir, 'lib'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: '@fixtures/provider-loaded', version: '1.0.0', private: true, type: 'module', main: 'lib/index.js',
    timon: {
      id: PLUGIN_ID, apiVersion: 12, kind: ['provider'], label: 'Loaded provider', permissions: ['backends:register'],
      provider: { binaries: [{ name: binary }] },
    },
  }));
  writeFileSync(join(dir, 'lib', 'index.js'), `export const name = '${PLUGIN_ID}';
export function apply(ctx) {
  ctx.provider.registerProvider({
    id: '${PROVIDER_ID}',
    transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null, writeUserInput: () => {} },
    launch: async (spawn, profile) => ({ cmd: profile.cmd, args: [], cwd: spawn.cfg.cwd, initialStdin: null }),
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'textual' },
    mcp: { timon: true },
    declares: { binary: { names: ['${binary}'] } },
  });
  ctx.backends.registerProfile({ id: '${PROFILE_ID}', label: 'Loaded', vendor: 'Acme', dialect: '${PROVIDER_ID}', models: [], defaultModel: null });
}
`);
}

async function loaded(options: {
  /** Where the release's own copy lives, and whether the release vouches for it. */
  builtin?: { dir: string; ok: boolean };
  /** A copy under `~/.timon/plugins/node_modules`. */
  installed?: { binary: string } | null;
  allowUnsigned?: boolean;
  binary: string;
}): Promise<{ trust: ReturnType<typeof backendTrust>; states: Array<{ state: string; reason: string | null }>; dispose: () => Promise<void> }> {
  const ctx = new Context();
  await ctx.plugin(createHttpPlugin((await import('express')).default()));
  const plugins = mkdtempSync(join(tmpdir(), 'timon-trust-plugins-'));
  if (options.installed) {
    const installed = join(plugins, 'node_modules', '@fixtures', 'provider-loaded');
    writeProviderPlugin(installed, options.installed.binary);
    writeFileSync(join(plugins, 'package.json'), JSON.stringify({ dependencies: { '@fixtures/provider-loaded': 'file:fixture' } }));
  }
  const restore = allowExec(options.binary);
  const loader = new PluginLoader(ctx, {
    dir: plugins,
    host: daemonHost(ctx),
    publicKeys: [],
    allowUnsigned: () => options.allowUnsigned === true,
    builtins: () => options.builtin
      ? [{ pkg: '@fixtures/provider-loaded', dir: options.builtin.dir, trust: options.builtin.ok ? { ok: true } : { ok: false, message: 'lib/index.js does not match the release manifest' } }]
      : [],
  });
  const records = await loader.update();
  return {
    trust: backendTrust(PROFILE_ID),
    states: records.map((r) => ({ state: r.state, reason: r.reason })),
    dispose: async () => {
      await loader.dispose();
      await ctx.fiber.dispose();
      restore();
      rmSync(plugins, { recursive: true, force: true });
    },
  };
}

test('trusted by the loader: the release\'s own copy is official', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-trust-builtin-'));
  writeProviderPlugin(dir, 'claude');
  const run = await loaded({ builtin: { dir, ok: true }, binary: 'acme-none' });
  try {
    assert.equal(run.states[0]?.state, 'active');
    assert.equal(run.trust, 'official');
  } finally {
    await run.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSAL: a built-in whose files the release does not vouch for is never official', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-trust-builtin-'));
  writeProviderPlugin(dir, 'acme-loaded');
  // Not signed, not vouched for: only a developer who allowed unsigned plugins gets it mounted, and then as a third party.
  const refused = await loaded({ builtin: { dir, ok: false }, binary: 'acme-loaded' });
  try {
    assert.equal(refused.states[0]?.reason, 'skipped:unsigned', 'judged like any package: no signature, no mount');
    assert.equal(refused.trust, 'third-party');
  } finally {
    await refused.dispose();
  }
  const developer = await loaded({ builtin: { dir, ok: false }, binary: 'acme-loaded', allowUnsigned: true });
  try {
    assert.equal(developer.states[0]?.state, 'active');
    assert.equal(developer.trust, 'third-party', 'mounted, but not as the release\'s own');
  } finally {
    await developer.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSAL: an installed copy of the same plugin id is third-party when the built-in is absent, and refused when it is present', async () => {
  // The built-in is missing from this installation: its copy under the plugins folder is just a package.
  const missing = join(tmpdir(), 'timon-trust-builtin-missing');
  const absent = await loaded({ builtin: { dir: missing, ok: true }, installed: { binary: 'acme-loaded' }, allowUnsigned: true, binary: 'acme-loaded' });
  try {
    assert.equal(absent.trust, 'third-party', 'an id is not an identity');
  } finally {
    await absent.dispose();
  }
  // The built-in is there: it wins the id, the copy is refused as a duplicate and never registers.
  const dir = mkdtempSync(join(tmpdir(), 'timon-trust-builtin-'));
  writeProviderPlugin(dir, 'claude');
  const both = await loaded({ builtin: { dir, ok: true }, installed: { binary: 'acme-loaded' }, allowUnsigned: true, binary: 'acme-loaded' });
  try {
    assert.deepEqual(both.states.map((s) => s.reason), [null, 'skipped:duplicate-id']);
    assert.equal(both.trust, 'official', 'the release\'s own copy answers; the installed one never mounted');
  } finally {
    await both.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('REFUSAL: a third party that declares claude as its program cannot register', async () => {
  const run = await loaded({ installed: { binary: 'claude' }, allowUnsigned: true, binary: 'claude' });
  try {
    assert.equal(run.states[0]?.state, 'failed', 'registerProvider refused the program');
    assert.equal(run.trust, 'third-party');
  } finally {
    await run.dispose();
  }
});

test.after(() => { restoreExec(); });
