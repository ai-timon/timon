/**
 * SECURITY — `ctx.provider.mcp()` (S1) and `ctx.provider.env()` (S2) never hand a
 * provider plugin the mission's token, a vault value or a credential of the user's
 * own MCP servers (`docs/SECURITY.md` § 6.4.1, `docs/PROVIDERS-SDK.md` § 8).
 *
 * Written like `agent-provider-token.test.ts`: a REAL plugin context, a REAL
 * registration, a REAL launch through `spawnAgent` with a recording host, and then
 * a search for the VALUES (not the keys) in everything the plugin's code saw. The
 * refusal is what is proved; the positive half proves the references are swapped on
 * the road to the process, so the servers it declares still authenticate.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/unfenced.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import type { BuildSpawnOpts, Dialect, SessionDriver } from '../backends/types.js';

await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { installedProgram } = await import('../../tests/helpers/witness-cli.js');
// The provider's CLI is installed and authorized: a third party's launch is compared with what was (TODO #531).
installedProgram('acme-witness');
const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { ensureDaemonToken } = await import('../plugins-bundled/http/auth.js');
const { config, setConfig } = await import('../config/load.js');
const { dbApi } = await import('../db.js');
const { seal } = await import('../secrets/box.js');
const { resolveMasterKey } = await import('../secrets/key.js');
const { registerDialect, registerProfile } = await import('../backends/registry.js');
const { upsertMcp, setMcpOAuth } = await import('../mcp.js');
const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginPolicyError } = await import('./policy.js');
const { providerEnvPlan } = await import('../backends/provider-env.js');
const { sealFor } = await import('../backends/launch-seal.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4244;
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

function pluginContext(pluginId: string) {
  const res = readManifest({ timon: { id: pluginId, apiVersion: 12, permissions: ['backends:register'] } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
}

const { TIMON_HOME: TIMON_HOME_DIR } = await import('../paths.js');
const OWNER = 'acme-provider';
const ctx = pluginContext(OWNER);
const stranger = pluginContext('other-provider');
const stranger_ctx = stranger;

const USER_ENV_SECRET = 'user-mcp-env-secret-value-1f3a';
const USER_HEADER_SECRET = 'Bearer user-mcp-header-secret-9c2e';
upsertMcp({ id: 'witness-user-stdio', transport: { type: 'stdio', command: 'node', args: ['server.js'], env: { UPSTREAM_KEY: USER_ENV_SECRET, MODE: 'prod' } } });
upsertMcp({ id: 'witness-user-http', transport: { type: 'http', url: 'https://mcp.example.test/sse', headers: { Authorization: USER_HEADER_SECRET } } });

/** What the plugin's code saw, as JSON it could have kept. */
const seen = {
  plans: [] as string[], envs: [] as string[], strangerError: null as unknown, mode: 'stdin' as 'stdin' | 'argv' | 'env' | 'scratch' | 'media',
  scratch: null as null | { path: string; file: string; writeError: unknown; linkError: unknown },
  media: null as null | { adopted: unknown[]; synchronous: unknown[]; strangerSync: unknown; textAsPng: unknown[]; outside: unknown; stranger: unknown; since: number; missionId: string },
};

const dialect: Dialect = {
  defaultCmd: 'acme-witness',
  persistentProcess: false,
  finishMissionOnExit: false,
  sessionResumable: false,
  sessionStore: 'per-mission',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    const plan = await ctx.provider.mcp(opts);
    const base = await ctx.provider.env(opts);
    seen.plans.push(JSON.stringify(plan));
    seen.envs.push(JSON.stringify(base));
    // A stranger asking about THIS mission, while its launch is open.
    try { await stranger.provider.mcp(opts); } catch (error) { seen.strangerError = error; }
    const { mcp } = ctx.provider.runtime;
    const config = mcp.serializeMcpJson(plan.servers) ?? '';
    if (seen.mode === 'media') {
      const dir = await ctx.provider.scratch.mission(opts);
      const since = Date.now();
      dir.writeFile('out/picture.png', Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
      dir.writeFile('out/not-a-picture.png', 'this is text wearing a picture\'s name');
      const adopted = await ctx.provider.media.adopt(opts.missionId, dir.resolve('out'), since - 5);
      const again = await ctx.provider.media.adopt(opts.missionId, dir.resolve('out'), since - 5);
      // The hook that puts a turn's pictures into its `result` cannot await: the same adoption, answered at once.
      dir.writeFile('out/second.png', Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));
      const synchronous = ctx.provider.media.adoptSync(opts.missionId, dir.resolve('out'), since - 5);
      let strangerSync: unknown = null;
      try { stranger_ctx.provider.media.adoptSync(opts.missionId, dir.resolve('out'), since); } catch (error) { strangerSync = error; }
      let outside: unknown = null;
      try { await ctx.provider.media.adopt(opts.missionId, '/etc', since); } catch (error) { outside = error; }
      let stranger: unknown = null;
      try { await stranger_ctx.provider.media.adopt(opts.missionId, dir.resolve('out'), since); } catch (error) { stranger = error; }
      ctx.provider.media.allowShow(opts.missionId, dir.resolve('out'));
      seen.media = { adopted, synchronous, strangerSync, textAsPng: again, outside, stranger, since, missionId: opts.missionId };
      return { cmd: profile.cmd, args: [], env: { ...profile.env }, cwd: opts.cfg.cwd, initialStdin: null };
    }
    if (seen.mode === 'scratch') {
      // What a provider does with S1 + S3: the MCP configuration goes into a file, never onto the command line.
      const dir = await ctx.provider.scratch.mission(opts);
      const file = dir.writeFile('mcp.json', config);
      let writeError: unknown = null;
      let linkError: unknown = null;
      try { dir.writeFile('../../outside.txt', 'x'); } catch (error) { writeError = error; }
      try { dir.link('/etc/hostname', 'hostname'); } catch (error) { linkError = error; }
      seen.scratch = { path: dir.path, file, writeError, linkError };
      return { cmd: profile.cmd, args: ['--mcp-config', file], env: { ...profile.env }, cwd: opts.cfg.cwd, initialStdin: null };
    }
    return {
      cmd: profile.cmd,
      args: seen.mode === 'argv' ? ['--mcp-config', config] : [],
      // The configuration goes to the process's stdin; only the refusal test puts it where it must not be.
      env: { ...profile.env, ...(seen.mode === 'env' ? { ACME_MCP_CONFIG: config, TIMON_API_TOKEN: plan.identityEnv.TIMON_API_TOKEN ?? '' } : {}) },
      cwd: opts.cfg.cwd,
      initialStdin: `${config}\n`,
    };
  },
  writeUserInput() { /* the driver owns the pipe */ },
  parseLine: () => [],
  extractSessionId: () => null,
};
registerDialect(OWNER, 'acme-lines', dialect);
registerProfile(OWNER, { id: 'acme-provider-profile', label: 'Acme', vendor: 'Acme', dialect: 'acme-lines', models: [], defaultModel: null });

/** A session-driven provider: the driver declares the servers in its `session/new`, over the daemon's pipe. */
const sessionSeen = { plan: '', mcpEnv: '' };
const sessionDialect: Dialect = {
  defaultCmd: 'acme-witness',
  persistentProcess: true,
  finishMissionOnExit: true,
  sessionResumable: false,
  sessionStore: 'per-mission',
  permissionModel: 'none',
  rateLimitReporting: 'none',
  hostedConnectors: false,
  async buildSpawn(opts, profile) {
    return { cmd: profile.cmd, args: [], env: { ...profile.env }, cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput() { /* the driver owns the pipe */ },
  parseLine: () => [],
  extractSessionId: () => null,
  openSession(args): SessionDriver {
    sessionSeen.mcpEnv = JSON.stringify(args.mcpEnv ?? {});
    // The driver asks the daemon for the plan like buildSpawn does, and serializes it for ACP.
    void ctx.provider.mcp(args.spawn).then((plan) => {
      sessionSeen.plan = JSON.stringify(plan);
      const { servers } = ctx.provider.runtime.mcp.serializeAcpMcpServers(plan.servers);
      args.io.stdin.write(`${JSON.stringify({ method: 'session/new', mcpServers: servers, viaEnv: args.mcpEnv })}\n`);
    });
    return {
      info: null,
      start: async () => ({ sessionId: 's', capabilities: { image: false, cancel: false, mcp: true }, resumed: false }),
      prompt: async () => ({ stopReason: 'end_turn' }),
      cancel: async () => {},
      close: () => {},
    } as unknown as SessionDriver;
  },
};
registerDialect(OWNER, 'acme-session', sessionDialect);
registerProfile(OWNER, { id: 'acme-session-profile', label: 'Acme session', vendor: 'Acme', dialect: 'acme-session', models: [], defaultModel: null });

function putGlobalSecret(name: string, value: string): void {
  const key = resolveMasterKey({ keyring: null });
  const row = dbApi.createSecret({ name, value_enc: 'placeholder', mode: 'inject' });
  dbApi.updateSecret(row.id, { value_enc: seal(value, key, { secretId: row.id, name }) });
  dbApi.addSecretGrant(row.id, 'global');
}

async function launch(agent: string): Promise<{ env: NodeJS.ProcessEnv; args: string[]; written: string; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const children: FakeChild[] = [];
  const spawned: Array<{ env: NodeJS.ProcessEnv; args: string[] }> = [];
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    spawned.push({ env: (opts?.env ?? {}) as NodeJS.ProcessEnv, args });
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
  return { ...spawned[0]!, written, dispose: () => { if (!child.killed) child.kill(); } };
}

createTestAccount(dbApi, { email: 'acme-witness@example.test', name: 'Witness', passwordHash: 'unused' });
const DAEMON_TOKEN = ensureDaemonToken();
const VAULT_VALUE = 'vault-value-acme-witness';
putGlobalSecret('VAULT_ACME_WITNESS', VAULT_VALUE);

upsertAgent({
  name: 'acme.agent',
  system_prompt: 'witness — does nothing.',
  config: {
    backend: 'acme-provider-profile', cwd: tmpdir(), skills: [], memory_scope: 'NONE',
    mcp_servers: ['witness-user-stdio', 'witness-user-http'],
  },
});

test('REFUSAL: nothing the plugin saw holds the mission token, a vault value or a credential of the user\'s servers', async () => {
  seen.mode = 'stdin';
  const before = seen.plans.length;
  const { env, written, dispose } = await launch('acme.agent');
  try {
    assert.equal(seen.plans.length, before + 1);
    // The real token is what reached the process: recover it from there.
    const real = /"TIMON_API_TOKEN":"([^"]+)"/.exec(written)?.[1];
    assert.ok(real && !real.startsWith('timon-seal-'), 'the references were swapped on the road to the process');
    assert.notEqual(real, DAEMON_TOKEN, 'the mission token, not the daemon-token');

    const plugin = [seen.plans.at(-1), seen.envs.at(-1)].join('\n');
    for (const secret of [real, DAEMON_TOKEN, VAULT_VALUE, USER_ENV_SECRET, USER_HEADER_SECRET, 'user-mcp-header-secret-9c2e']) {
      assert.equal(plugin.includes(secret), false, `the plugin must not see ${secret.slice(0, 12)}…`);
    }
    // What it saw instead: references, and the non-secret shape.
    const plan = JSON.parse(seen.plans.at(-1)!) as {
      identityEnv: Record<string, string>;
      servers: Array<{ role: string; name: string; env?: Record<string, string>; headers?: Record<string, string> }>;
    };
    assert.match(plan.identityEnv.TIMON_API_TOKEN ?? '', /^timon-seal-[0-9a-f]{32}$/);
    const roles = plan.servers.map((s) => s.role);
    assert.deepEqual(roles, ['timon', 'forms', 'browser', 'user', 'user'], "the project's browser rides along");
    const stdio = plan.servers.find((s) => s.name === 'witness-user-stdio')!;
    assert.match(stdio.env!.UPSTREAM_KEY!, /^timon-seal-/);
    assert.match(stdio.env!.MODE!, /^timon-seal-/, 'every value of a user server is protected, not just the ones that look secret');
    assert.match(plan.servers.find((s) => s.name === 'witness-user-http')!.headers!.Authorization!, /^timon-seal-/);

    // The positive half: the stdin payload the daemon wrote carries the real values...
    assert.ok(written.includes(USER_ENV_SECRET) && written.includes(USER_HEADER_SECRET), 'the stdin payload holds the real values');
    // ...and the environment, which every child of the CLI inherits, holds none of them.
    assert.equal(JSON.stringify(env).includes(real), false, 'the token is not in the process environment');
    assert.equal(JSON.stringify(env).includes(USER_ENV_SECRET), false);
    assert.equal(Object.keys(env).some((key) => key.toUpperCase() === 'TIMON_API_TOKEN'), false);
    // Not the vault, not the daemon environment.
    assert.equal(env.VAULT_ACME_WITNESS, undefined);
  } finally {
    dispose();
  }
});

test('a session driver gets the same reference from the plan and from mcpEnv, and the real pipe carries the values', async () => {
  upsertAgent({
    name: 'acme.session',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'acme-session-profile', cwd: tmpdir(), skills: [], memory_scope: 'NONE', mcp_servers: ['witness-user-stdio'] },
  });
  const { written, dispose } = await launch('acme.session');
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const line = JSON.parse(written.trim().split('\n')[0]!) as { mcpServers: Array<{ name: string; env: Array<{ name: string; value: string }> }>; viaEnv: Record<string, string> };
    const timon = line.mcpServers.find((s) => s.name === 'timon')!;
    const real = timon.env.find((e) => e.name === 'TIMON_API_TOKEN')!.value;
    assert.ok(real && !real.startsWith('timon-seal-'));
    assert.notEqual(real, DAEMON_TOKEN);
    assert.equal(line.viaEnv.TIMON_API_TOKEN, real, 'mcpEnv and the plan stood for the same token');
    const user = line.mcpServers.find((s) => s.name === 'witness-user-stdio')!;
    assert.equal(user.env.find((e) => e.name === 'UPSTREAM_KEY')!.value, USER_ENV_SECRET);
    // The plugin's side of the same exchange held references only.
    const plugin = `${sessionSeen.plan}\n${sessionSeen.mcpEnv}`;
    for (const secret of [real, USER_ENV_SECRET, DAEMON_TOKEN]) assert.equal(plugin.includes(secret), false);
  } finally {
    dispose();
  }
});

test('REFUSAL: a reference in the process environment fails the launch — every child of the CLI would inherit it', async () => {
  seen.mode = 'env';
  try {
    await assert.rejects(launch('acme.agent'), (error: unknown) =>
      error instanceof Error && error.name === 'SealedEnvError' && /environment/.test(error.message) && /scratch/.test(error.message));
    assert.equal(sealFor(dbMissionOf('acme.agent')), undefined, 'the seal of a failed launch is closed');
  } finally {
    seen.mode = 'stdin';
  }
});

test('REFUSAL: a reference in the command line fails the launch, the process list is not a place for a secret', async () => {
  seen.mode = 'argv';
  try {
    await assert.rejects(launch('acme.agent'), /command line/);
    assert.equal(sealFor(dbMissionOf('acme.agent')), undefined, 'the seal of a failed launch is closed');
  } finally {
    seen.mode = 'stdin';
  }
});

function dbMissionOf(agent: string): string {
  const row = dbApi.listMissions().find((m) => m.agent_name === agent);
  return row?.id ?? '';
}

test('REFUSAL: another plugin cannot ask about a mission that is not on its backend', async () => {
  seen.strangerError = null;
  const { dispose } = await launch('acme.agent');
  try {
    assert.ok(seen.strangerError instanceof PluginPolicyError, 'the stranger was refused, not answered with an empty plan');
    assert.match((seen.strangerError as Error).message, /not running on a backend this plugin registered/);
  } finally {
    dispose();
  }
});

test('outside a launch: no identity token, none of the user\'s servers, and no effect', async () => {
  const spawn = { agentName: 'acme.agent', systemPrompt: '', message: '', resumeSession: null, missionId: 'no-such-mission',
    cfg: { cwd: tmpdir(), mcp_servers: ['witness-user-stdio'] } } as unknown as BuildSpawnOpts;
  const plan = await ctx.provider.mcp(spawn);
  assert.equal(plan.identityEnv.TIMON_API_TOKEN, undefined);
  assert.deepEqual(plan.servers.map((s) => s.role), ['timon', 'forms'], 'a caller cannot name a user server outside the mission it belongs to');
  assert.equal(JSON.stringify(plan).includes(USER_ENV_SECRET), false);
});

test('the forms server lists `request` only for a CLI that routes permission prompts to it', async () => {
  const spawn = { agentName: 'a', systemPrompt: '', message: '', resumeSession: null, missionId: 'm',
    cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
  const formsOnly = await ctx.provider.mcp(spawn);
  const prompting = await ctx.provider.mcp(spawn, { permissionPrompt: true });
  const forms = (plan: typeof formsOnly) => plan.servers.find((s) => s.role === 'forms') as { env: Record<string, string> };
  assert.equal(forms(formsOnly).env.TIMON_ASK_FORMS_ONLY, '1');
  assert.equal(forms(prompting).env.TIMON_ASK_FORMS_ONLY, undefined);
  assert.equal(formsOnly.permissionTool, null);
  assert.equal(prompting.permissionTool, 'mcp__timon_ask__request');
  assert.ok(prompting.preApprovedTools.includes('mcp__timon__kanban_add'));
  assert.ok(prompting.commandPolicy.denyPrograms.includes('sudo'));
});

test('a backend that declares timonMcp: false is not handed Timon\'s own servers', async () => {
  const spawn = { agentName: 'a', systemPrompt: '', message: '', resumeSession: null, missionId: 'm', timonMcp: false,
    cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
  assert.deepEqual((await ctx.provider.mcp(spawn)).servers, []);
});

test('S2: the base environment of a third-party provider has no vault value, no daemon variable, no token', async () => {
  const previous = config();
  process.env.DAEMON_ONLY_ACME_WITNESS = 'daemon-env-acme-witness';
  try {
    setConfig({ ...previous, secrets: { ...previous.secrets, inheritEnv: true } });
    const spawn = { agentName: 'acme.agent', systemPrompt: '', message: '', resumeSession: null, missionId: 'm-env',
      cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
    const plan = await ctx.provider.env(spawn);
    const flat = JSON.stringify(plan);
    assert.equal(flat.includes(VAULT_VALUE), false);
    assert.equal(flat.includes('daemon-env-acme-witness'), false, 'not even under secrets.inheritEnv');
    assert.equal(Object.keys(plan.env).some((key) => key.toUpperCase() === 'TIMON_API_TOKEN'), false);
    assert.equal(plan.env.TIMON_MISSION_ID, 'm-env');
    assert.equal(plan.env.TIMON_AGENT, 'acme.agent');
    assert.ok(plan.env.PATH, 'the system whitelist stays');
  } finally {
    setConfig(previous);
    delete process.env.DAEMON_ONLY_ACME_WITNESS;
  }
});

test('S2: the vault slice is the product\'s own launches\': a trusted provider gets it, the token never', async () => {
  const spawn = { agentName: 'acme.agent', systemPrompt: '', message: '', resumeSession: null, missionId: 'm-trusted',
    cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
  const trusted = await providerEnvPlan({ spawn, trusted: true });
  assert.equal(trusted.env.VAULT_ACME_WITNESS, VAULT_VALUE);
  assert.equal(Object.keys(trusted.env).some((key) => key.toUpperCase() === 'TIMON_API_TOKEN'), false);
  const third = await providerEnvPlan({ spawn, trusted: false });
  assert.equal(third.env.VAULT_ACME_WITNESS, undefined);
});

test('S2: the variables a provider declared passthrough are copied, and only those', async () => {
  process.env.ACME_HOME_WITNESS = '/somewhere/acme';
  process.env.ACME_UNDECLARED_WITNESS = 'nope';
  try {
    const spawn = { agentName: 'a', systemPrompt: '', message: '', resumeSession: null, missionId: 'm-pass',
      cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
    const plan = await providerEnvPlan({ spawn, trusted: false, passthrough: ['ACME_HOME_WITNESS', 'ACME_ABSENT_WITNESS'] });
    assert.equal(plan.env.ACME_HOME_WITNESS, '/somewhere/acme');
    assert.equal(plan.env.ACME_UNDECLARED_WITNESS, undefined);
    assert.equal('ACME_ABSENT_WITNESS' in plan.env, false);
  } finally {
    delete process.env.ACME_HOME_WITNESS;
    delete process.env.ACME_UNDECLARED_WITNESS;
  }
});

test('a plugin that declared an older contract, or without the permission, cannot call S1 or S2', async () => {
  const res = readManifest({ timon: { id: 'old-provider', apiVersion: 11, permissions: ['backends:register'] } });
  assert.equal(res.ok, true);
  if (!res.ok) throw new Error('unreachable');
  const old = createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
  const spawn = { agentName: 'a', missionId: 'm', cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
  await assert.rejects(old.provider.mcp(spawn), /needs apiVersion 12/);
  await assert.rejects(old.provider.env(spawn), /needs apiVersion 12/);
});

test('S3: the MCP configuration written to a scratch file holds the real values, the plugin only saw references', async () => {
  seen.mode = 'scratch';
  seen.scratch = null;
  const before = seen.plans.length;
  const { args, dispose } = await launch('acme.agent');
  try {
    assert.equal(seen.plans.length, before + 1);
    const info = seen.scratch!;
    assert.ok(info, 'the plugin got a folder');
    assert.equal(args[1], info.file, 'the path is on the command line, the secrets are not');
    assert.ok(info.path.startsWith(join(TIMON_HOME_DIR, 'provider-runs', OWNER)), `inside the plugin's namespace: ${info.path}`);
    const onDisk = readFileSync(info.file, 'utf8');
    const config = JSON.parse(onDisk) as { mcpServers: Record<string, { env: Record<string, string>; headers?: Record<string, string> }> };
    const real = config.mcpServers.timon!.env.TIMON_API_TOKEN!;
    assert.ok(real && !real.startsWith('timon-seal-'), 'swapped on write');
    assert.notEqual(real, DAEMON_TOKEN);
    assert.equal(config.mcpServers['witness-user-stdio']!.env.UPSTREAM_KEY, USER_ENV_SECRET);
    assert.equal(config.mcpServers['witness-user-http']!.headers!.Authorization, USER_HEADER_SECRET);
    if (process.platform !== 'win32') assert.equal(statSync(info.file).mode & 0o777, 0o600);
    // What the plugin's own code could have kept.
    const plugin = [seen.plans.at(-1), seen.envs.at(-1), JSON.stringify(args)].join('\n');
    assert.equal(plugin.includes(real) || plugin.includes(USER_ENV_SECRET), false);
    assert.ok(info.writeError instanceof Error && /leaves the mission's folder|goes up/.test((info.writeError as Error).message), 'the folder is a jail');
    assert.ok(info.linkError instanceof Error && /not under a credential folder/.test((info.linkError as Error).message), 'link refuses a source nobody declared');
  } finally {
    dispose();
    seen.mode = 'stdin';
  }
});

test('S3: an OAuth server reaches the file as the daemon\'s relay — its bearer and stored headers stay in the daemon', async () => {
  const OAUTH_ACCESS = 'oauth-access-token-witness-7d1b';
  const OAUTH_REFRESH = 'oauth-refresh-token-witness-2c9e';
  const STORED_HEADER = 'stored-header-secret-witness-5a0f';
  upsertMcp({ id: 'witness-user-oauth', transport: { type: 'http', url: 'https://oauth.example.test/mcp', headers: { 'X-Api-Key': STORED_HEADER } } });
  setMcpOAuth('witness-user-oauth', {
    metadata: { authorization_endpoint: 'https://oauth.example.test/authorize', token_endpoint: 'https://oauth.example.test/token' },
    client: { client_id: 'witness' },
    redirect_uri: 'http://localhost/cb',
    tokens: { access_token: OAUTH_ACCESS, token_type: 'Bearer', refresh_token: OAUTH_REFRESH, expires_at: Date.now() + 3_600_000 },
  } as never);
  upsertAgent({
    name: 'acme.oauth',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'acme-provider-profile', cwd: tmpdir(), skills: [], memory_scope: 'NONE', mcp_servers: ['witness-user-oauth'] },
  });
  seen.mode = 'scratch';
  seen.scratch = null;
  const { args, written, dispose } = await launch('acme.oauth');
  try {
    const onDisk = readFileSync(seen.scratch!.file, 'utf8');
    const entry = (JSON.parse(onDisk) as { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> }).mcpServers['witness-user-oauth']!;
    assert.match(entry.url ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp-relay\/[A-Za-z0-9_-]{22}\/acme\.oauth$/);
    assert.deepEqual(Object.keys(entry.headers ?? {}), ['x-timon-mcp-relay']);
    assert.ok(!(entry.headers!['x-timon-mcp-relay'] ?? '').startsWith('timon-seal-'), 'the relay token is swapped in like any header');
    for (const secret of [OAUTH_ACCESS, OAUTH_REFRESH, STORED_HEADER, 'oauth.example.test']) {
      for (const where of [onDisk, written, JSON.stringify(args), seen.plans.at(-1) ?? '']) {
        assert.equal(where.includes(secret), false, `${secret.slice(0, 18)}… must not reach the CLI or the plugin`);
      }
    }
  } finally {
    dispose();
    seen.mode = 'stdin';
  }
});

test('S3: the folder goes with the mission, every plugin\'s copy of it', async () => {
  seen.mode = 'scratch';
  const { dispose } = await launch('acme.agent');
  try {
    const dir = seen.scratch!.path;
    assert.ok(existsSync(dir));
    const { disposeProviderScratch } = await import('../backends/provider-scratch.js');
    const missionId = dir.split(/[\\/]/).pop()!;
    mkdirSync(join(dirname(dirname(dir)), 'other-plugin', missionId), { recursive: true });
    disposeProviderScratch(missionId);
    assert.equal(existsSync(dir), false);
    assert.equal(existsSync(join(dirname(dirname(dir)), 'other-plugin', missionId)), false);
    assert.doesNotThrow(() => disposeProviderScratch('../../etc'), 'an unsafe id is ignored, never joined into a path');
  } finally {
    dispose();
    seen.mode = 'stdin';
  }
});

test('S3: no launch, no folder — a probe has no mission to keep one for', async () => {
  const { ScratchWithoutLaunchError } = await import('../backends/provider-scratch.js');
  const spawn = { agentName: 'a', systemPrompt: '', message: '', resumeSession: null, missionId: 'probe-mission', cfg: { cwd: tmpdir() } } as unknown as BuildSpawnOpts;
  await assert.rejects(ctx.provider.scratch.mission(spawn), ScratchWithoutLaunchError);
  assert.equal(existsSync(join(TIMON_HOME_DIR, 'provider-runs', OWNER, 'probe-mission')), false);
});

test('S3: another plugin cannot open the folder of a mission that is not on its backend', async () => {
  seen.mode = 'stdin';
  let refusal: unknown = null;
  const original = dialect.buildSpawn;
  (dialect as { buildSpawn: Dialect['buildSpawn'] }).buildSpawn = async (opts, profile) => {
    try { await stranger.provider.scratch.mission(opts); } catch (error) { refusal = error; }
    return original.call(dialect, opts, profile);
  };
  try {
    const { dispose } = await launch('acme.agent');
    dispose();
    assert.ok(refusal instanceof PluginPolicyError);
  } finally {
    (dialect as { buildSpawn: Dialect['buildSpawn'] }).buildSpawn = original;
  }
});

test('S5: the daemon\'s redaction masks a vault value in what the provider emits', () => {
  const masked = ctx.provider.redact.text(`the key is ${VAULT_VALUE}, keep it`);
  assert.equal(masked.includes(VAULT_VALUE), false);
  assert.match(masked, /\*\*\*/);
  const deep = ctx.provider.redact.deep({ a: [`x ${VAULT_VALUE}`], b: { c: VAULT_VALUE }, n: 3 });
  assert.equal(JSON.stringify(deep).includes(VAULT_VALUE), false);
  assert.equal(deep.n, 3);
  // Short values are left alone: redacting them would turn prose into a field of `***`.
  assert.equal(ctx.provider.redact.text('short'), 'short');
});

test('S6: the pictures the CLI wrote are adopted into the chat, once, and only real pictures', async () => {
  seen.mode = 'media';
  seen.media = null;
  const { dispose } = await launch('acme.agent');
  try {
    const info = seen.media!;
    assert.ok(info, 'the plugin adopted');
    assert.equal(info.adopted.length, 1, 'the PNG, not the text that wears a PNG\'s name');
    const [picture] = info.adopted as Array<{ file: string; kind: string; mime: string }>;
    assert.equal(picture!.kind, 'image');
    assert.equal(picture!.mime, 'image/png');
    assert.match(picture!.file, /^[0-9a-f-]{36}\.png$/);
    assert.equal(info.textAsPng.length, 0, 'a second ask does not show the same picture twice');
    assert.equal(info.synchronous.length, 1, 'adoptSync adopts what appeared since, without awaiting, and not the picture already kept');
    assert.ok(info.strangerSync instanceof PluginPolicyError, 'adoptSync is as closed to another plugin as adopt');
    assert.ok(info.outside instanceof Error && /neither in this mission's scratch folder nor in its working directory/.test((info.outside as Error).message),
      'a directory outside the mission is refused, not read');
    assert.ok(info.stranger instanceof PluginPolicyError, 'another plugin cannot adopt into this mission');
    const { providerMediaRoots } = await import('../backends/provider-media.js');
    assert.ok(providerMediaRoots(info.missionId).some((root) => root.endsWith(join('out'))), 'the agent may show from the folder the provider opened');
  } finally {
    dispose();
    seen.mode = 'stdin';
  }
});
