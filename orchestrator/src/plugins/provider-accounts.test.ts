/**
 * S7 — a provider that takes subscription accounts: it DESCRIBES how its CLI signs
 * in (`declares.accounts.login`), the daemon plays it; and a launch learns which
 * account it runs on through `ctx.provider.account`, not through a field only the
 * product's own dialects could read.
 *
 * The CLI is a fake child driven by the test, like `account-login-routes.test.ts`.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathKeyOf } from '../host/launch-path.js';
import type { ChildProcess } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import type { NativeProviderDefinition } from '../backends/engine/definition.js';
import type { ProviderLoginDriver } from '../backends/provider-declarations.js';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginPolicyError } = await import('./policy.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const registry = await import('../backends/registry.js');
const { providerRuntime } = await import('../backends/provider-runtime.js');
const accounts = await import('../backends/accounts.js');
const { startAccountLogin, setLoginOptions, resetAccountLogins, getAccountLogin } = await import('../backends/account-login.js');

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { forgetMissionFence, prepareMissionLaunch, recordMissionFence, recordOneShotProcess, resetMissionFenceState } = await import('../mission-fence-state.js');
await mountOfficialProviders();

class FakeCli extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  constructor(readonly args: string[], readonly env: NodeJS.ProcessEnv) { super(); }
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode === null && this.signalCode === null) { this.signalCode = signal; this.emit('exit', null, signal); }
    return true;
  }
  exit(code: number): void { this.exitCode = code; this.emit('exit', code, null); }
}

let lastCli: FakeCli | null = null;
const spawned: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }> = [];
const ran: Array<{ cmd: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
let nextWho = 'ada@perso.example';

setLoginOptions({
  // Windows keeps the system whitelist without case (`Path`): forced to 'linux'
  // there, the login's environment would lose the host's PATH.
  platform: process.platform === 'win32' ? 'win32' : 'linux',
  promptTimeoutMs: 5_000,
  retainMs: 60_000,
  spawn: (cmd, args, opts) => {
    const cli = new FakeCli(args, opts.env);
    lastCli = cli;
    spawned.push({ cmd, args, env: opts.env, cwd: opts.cwd });
    setImmediate(() => cli.stdout.write('open https://acme.example/device and type the code ACME-12345\n'));
    return cli as unknown as ChildProcess;
  },
  run: async (cmd, args, env) => { ran.push({ cmd, args, env }); return { code: 0, stdout: '' }; },
});

/** The driver an Acme CLI author would write: device-code flow, a credential file, an identity read from it. */
const loginDriver: ProviderLoginDriver = {
  promptKind: 'device-code',
  args: (expected) => ['login', '--device', ...(expected ? ['--as', expected] : [])],
  env: (dir, base) => ({ ...base, ACME_HOME: dir }),
  parse(output) {
    const url = /https:\/\/\S+\/device/.exec(output)?.[0];
    const code = /\b[A-Z]{4}-\d{5}\b/.exec(output)?.[0];
    return url && code ? { kind: 'device-code', url, code } : null;
  },
  async identity(dir) {
    const file = join(dir, 'credentials.json');
    if (!existsSync(file)) return null;
    const who = (JSON.parse(readFileSync(file, 'utf8')) as { who: string }).who;
    return { key: `acme:${who}`, label: who };
  },
  install(staging, dest) {
    renameSync(join(staging, 'credentials.json'), join(dest, 'credentials.json'));
  },
  async signOut() { /* the credential is a file, removed with the account */ },
};

function definition(id: string, accountsDeclaration: boolean): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: {
      kind: 'lines', parseLine: () => [], extractSessionId: providerRuntime.events.extractInitSessionId, writeUserInput: () => {},
    },
    launch: async (spawn, profile) => ({ cmd: profile.cmd, args: [], cwd: spawn.cfg.cwd, initialStdin: null }),
    session: { store: 'per-mission', resumable: false },
    permission: { model: 'sandbox' },
    limits: { reporting: 'none' },
    mcp: { timon: true },
    declares: { binary: { names: ['acme-acct'] }, ...(accountsDeclaration ? { accounts: { login: loginDriver } } : {}) },
  };
}

function pluginContext(pluginId: string) {
  const res = readManifest({ timon: { id: pluginId, apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { binaries: [{ name: 'acme-acct' }] } } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
}

const previous = config();
setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: ['acme-acct'] } } }));
test.after(() => { resetAccountLogins(); setConfig(previous); });

const ctx = pluginContext('acme-accounts');
ctx.provider.registerProvider(definition('acme-acct', true));
ctx.provider.registerProvider(definition('acme-noacct', false));
registry.registerProfile('acme-accounts', { id: 'acme-acct-profile', dialect: 'acme-acct', label: 'Acme', models: [], defaultModel: null });
registry.registerProfile('acme-accounts', { id: 'acme-noacct-profile', dialect: 'acme-noacct', label: 'NoAcct', models: [], defaultModel: null });
registry.registerProfile('acme-accounts', { id: 'acme-custom-profile', dialect: 'acme-acct', label: 'Custom', custom: true, models: [], defaultModel: null });

const initiator = { userId: 'user-1', binding: 'session-1' };
async function settled(id: string): Promise<NonNullable<ReturnType<typeof getAccountLogin>>> {
  for (let i = 0; i < 200; i++) {
    const view = getAccountLogin(id, initiator);
    if (view && (view.state === 'connected' || view.state === 'failed')) return view;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the flow never settled');
}

test('a provider that declared how its CLI signs in takes accounts; one that did not, or a custom profile, does not', () => {
  assert.equal(registry.backendTakesAccounts('acme-acct-profile'), true);
  assert.equal(registry.backendTakesAccounts('acme-noacct-profile'), false);
  assert.equal(registry.backendTakesAccounts('acme-custom-profile'), false, 'a custom endpoint is not a subscription');
  assert.equal(registry.backendTakesAccounts('claude'), true, 'the product\'s own are unchanged');
});

test('the daemon plays the driver: prompt, staging, identity, install, and the account joins the registry', async () => {
  const row = accounts.createBackendAccount({ backend: 'acme-acct-profile', name: 'Pro', ownerUserId: null });
  const view = startAccountLogin(row, initiator);
  assert.equal(view.state, 'starting');
  const call = spawned.at(-1)!;
  assert.deepEqual(call.args, ['login', '--device']);
  assert.equal(call.cmd, 'acme-acct');
  const staging = accounts.accountLoginStagingDir(row.id);
  assert.equal(call.cwd, staging);
  assert.equal(call.env.ACME_HOME, staging, 'the CLI signs in in the staging folder');
  // Windows keeps the spelling it read (`Path`): look the key up as the product does.
  assert.ok(call.env[pathKeyOf(call.env, process.platform)], 'on the system whitelist');
  assert.equal(call.env.DAEMON_SECRET_WITNESS, undefined);

  for (let i = 0; i < 100 && getAccountLogin(row.id, initiator)?.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(getAccountLogin(row.id, initiator)?.prompt, { kind: 'device-code', url: 'https://acme.example/device', code: 'ACME-12345' });

  // The person approved on the page: the CLI writes its credential and leaves.
  writeFileSync(join(lastCli!.env.ACME_HOME!, 'credentials.json'), JSON.stringify({ who: nextWho }));
  lastCli!.exit(0);
  const done = await settled(row.id);
  assert.equal(done.state, 'connected');
  assert.equal(done.identity, 'ada@perso.example');

  const installed = join(accounts.accountConfigDir(row.id), 'credentials.json');
  assert.ok(existsSync(installed), 'moved into the account\'s folder');
  assert.equal(existsSync(staging), false, 'no copy survives the flow');
  assert.equal(accounts.getBackendAccount(row.id)?.identity_label, 'ada@perso.example');
  if (process.platform !== 'win32') assert.equal(statSync(accounts.accountConfigDir(row.id)).mode & 0o777, 0o700);

  // The account is an instance of the provider's profile.
  const instance = registry.activeProfiles().find((entry) => entry.profile.id === `acme-acct-profile@${row.id}`);
  assert.ok(instance, 'acme-acct-profile@<id> is in the registry');
  assert.equal(instance!.account?.name, 'Pro');
});

test('the same sign-in under a second account is refused, as for the product\'s own CLIs', async () => {
  const second = accounts.createBackendAccount({ backend: 'acme-acct-profile', name: 'Second', ownerUserId: null });
  startAccountLogin(second, initiator);
  for (let i = 0; i < 100 && getAccountLogin(second.id, initiator)?.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 10));
  writeFileSync(join(lastCli!.env.ACME_HOME!, 'credentials.json'), JSON.stringify({ who: nextWho }));
  lastCli!.exit(0);
  const done = await settled(second.id);
  assert.equal(done.state, 'failed');
  assert.equal(done.failure, 'duplicate');
  assert.equal(existsSync(join(accounts.accountConfigDir(second.id), 'credentials.json')), false);
});

test('the identity probe a driver runs gets the CLI of its profile and the system environment, not the daemon\'s', async () => {
  const row = accounts.createBackendAccount({ backend: 'acme-acct-profile', name: 'Probe', ownerUserId: null });
  const probing: ProviderLoginDriver = {
    ...loginDriver,
    async identity(dir, run) {
      const answer = await run(['whoami'], { ACME_HOME: dir });
      return answer.code === 0 ? { key: 'acme:probe', label: 'probe' } : null;
    },
  };
  ctxReplace(probing);
  try {
    process.env.DAEMON_SECRET_WITNESS = 'daemon-only-secret-value';
    startAccountLogin(row, initiator);
    for (let i = 0; i < 100 && getAccountLogin(row.id, initiator)?.state === 'starting'; i++) await new Promise((r) => setTimeout(r, 10));
    writeFileSync(join(lastCli!.env.ACME_HOME!, 'credentials.json'), JSON.stringify({ who: 'probe' }));
    lastCli!.exit(0);
    await settled(row.id);
    const call = ran.at(-1)!;
    assert.deepEqual([call.cmd, ...call.args], ['acme-acct', 'whoami']);
    assert.equal(call.env.ACME_HOME, join(accounts.LOGIN_STAGING_DIR, row.id));
    assert.equal(JSON.stringify(call.env).includes('daemon-only-secret-value'), false);
  } finally {
    delete process.env.DAEMON_SECRET_WITNESS;
    ctxReplace(loginDriver);
  }
});

function ctxReplace(driver: ProviderLoginDriver): void {
  const next = definition('acme-acct', true);
  (next.declares as { accounts: { login: ProviderLoginDriver } }).accounts = { login: driver };
  ctx.provider.replaceProvider(next);
}

test('S7: a launch learns its account from ctx.provider.account, with the folder private', async () => {
  const row = accounts.listBackendAccounts('acme-acct-profile')[0]!;
  const entry = registry.activeProfiles().find((candidate) => candidate.profile.id === `acme-acct-profile@${row.id}`)!;
  const { runtime } = await entry.runtimeFor();
  const account = ctx.provider.account.of(runtime);
  assert.deepEqual({ id: account!.id, name: account!.name }, { id: row.id, name: row.name });
  assert.equal(account!.configDir, accounts.accountConfigDir(row.id));
  if (process.platform !== 'win32') assert.equal(statSync(account!.configDir).mode & 0o777, 0o700);
  // The host's own sign-in has no account.
  const host = registry.activeProfiles().find((candidate) => candidate.profile.id === 'acme-acct-profile')!;
  assert.equal(ctx.provider.account.of((await host.runtimeFor()).runtime), undefined);
});

test('REFUSAL: another plugin cannot read the account of a backend it did not register', async () => {
  const stranger = pluginContext('other-accounts');
  const row = accounts.listBackendAccounts('acme-acct-profile')[0]!;
  const entry = registry.activeProfiles().find((candidate) => candidate.profile.id === `acme-acct-profile@${row.id}`)!;
  const { runtime } = await entry.runtimeFor();
  assert.throws(() => stranger.provider.account.of(runtime), (error: unknown) =>
    error instanceof PluginPolicyError && /not a backend this plugin registered/.test(error.message));
});

test('API 18: an account\'s own keychain entry is a declared service plus the folder\'s suffix, never the host\'s entry', async () => {
  const res = readManifest({ timon: {
    id: 'acme-accounts', apiVersion: 18, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: 'acme-acct' }], osCredentials: [{ service: 'Acme-credentials' }] },
  } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  const current = createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
  const row = accounts.listBackendAccounts('acme-acct-profile')[0]!;
  const entry = registry.activeProfiles().find((candidate) => candidate.profile.id === `acme-acct-profile@${row.id}`)!;
  const { runtime } = await entry.runtimeFor();
  const { accountEntrySuffix } = await import('./provider-facade.js');
  const service = `Acme-credentials${accountEntrySuffix(accounts.accountConfigDir(row.id))}`;
  assert.throws(() => current.provider.account.osCredential(runtime, service, ''), (error: unknown) =>
    error instanceof PluginPolicyError && /id of the launch being built/.test(error.message));
  const own = current.provider.account.osCredential(runtime, service, 'mission-acct');
  assert.ok(own, 'a launch on an account gets its entry');
  assert.equal(own.held(), 'unfenced', 'no fenced launch of that mission is being prepared');
  const prepared = prepareMissionLaunch('mission-acct', { account: row.id, fenced: true });
  assert.equal(own.held(), null);
  if (process.platform !== 'darwin') {
    // Off macOS there is no keychain: nothing is read, nothing is left to remove.
    assert.equal(await own.read(), null);
    assert.equal(await own.remove('copied'), 'removed');
  }
  await assert.rejects(own.remove(''), (error: unknown) => error instanceof PluginPolicyError && /value that was read/.test(error.message));

  // A sign-in on the account: its CLI may rewrite the entry, so nothing is deleted until the
  // flow finished AND the CLI exited — checked before the platform, the same on every OS.
  startAccountLogin(row, initiator);
  const cli = lastCli!;
  assert.equal(own.held(), 'signing-in');
  assert.equal(await own.remove('copied'), 'signing-in');
  writeFileSync(join(cli.env.ACME_HOME!, 'credentials.json'), JSON.stringify({ who: row.identity_label ?? nextWho }));
  cli.exit(0);
  await settled(row.id);
  assert.equal(own.held(), null, 'released once the flow is over and its CLI gone');
  prepared();
  const host = registry.activeProfiles().find((candidate) => candidate.profile.id === 'acme-acct-profile')!;
  assert.equal(current.provider.account.osCredential((await host.runtimeFor()).runtime, service, 'mission-acct'), undefined,
    'the host\'s own sign-in runs on no account');
  const refused = (error: unknown) => error instanceof PluginPolicyError && /suffix of this account's folder/.test(error.message);
  assert.throws(() => current.provider.account.osCredential(runtime, 'Acme-credentials', 'mission-acct'), refused, 'the declared name alone is the host\'s sign-in');
  assert.throws(() => current.provider.account.osCredential(runtime, service.replace('Acme', 'Other'), 'mission-acct'), refused, 'only a declared service');
  assert.throws(() => current.provider.account.osCredential(runtime, 'Acme-credentials-0123abcd', 'mission-acct'), refused, 'another account\'s entry');
  assert.throws(() => current.provider.account.osCredential(runtime, service.toUpperCase(), 'mission-acct'), refused);
  // Another plugin, on the same contract and with the same declared entry, does not own the backend.
  const res2 = readManifest({ timon: {
    id: 'other-accounts', apiVersion: 18, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: 'acme-acct' }], osCredentials: [{ service: 'Acme-credentials' }] },
  } });
  if (!res2.ok) throw new Error(res2.message);
  const stranger = createPluginContext(new Context(), { manifest: res2.manifest, version: '1.0.0' }, daemonHost());
  assert.throws(() => stranger.provider.account.osCredential(runtime, service, 'mission-acct'), (error: unknown) =>
    error instanceof PluginPolicyError && /not a backend this plugin registered/.test(error.message));
  // A plugin that declared an older contract is not promised the member.
  assert.throws(() => ctx.provider.account.osCredential(runtime, service, 'mission-acct'), /apiVersion 18/);
});

test('API 18, macOS: the entry is deleted for a fenced launch only, and never while a process on the account runs outside the fence', async () => {
  const res = readManifest({ timon: {
    id: 'acme-accounts', apiVersion: 18, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: [{ name: 'acme-acct' }], osCredentials: [{ service: 'Acme-credentials' }] },
  } });
  if (!res.ok) throw new Error(res.message);
  const current = createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0' }, daemonHost());
  const row = accounts.listBackendAccounts('acme-acct-profile')[0]!;
  const entry = registry.activeProfiles().find((candidate) => candidate.profile.id === `acme-acct-profile@${row.id}`)!;
  const { runtime } = await entry.runtimeFor();
  const { accountEntrySuffix } = await import('./provider-facade.js');
  const service = `Acme-credentials${accountEntrySuffix(accounts.accountConfigDir(row.id))}`;
  const SECRET = 'acme-oauth-pair-stored-in-the-keychain';

  // The keychain, played by `security`: what was run, and what is left.
  const host = getHost();
  const original = { exec: host.exec, platform: host.platform };
  const keychain = new Map<string, string>([[service, SECRET]]);
  const commands: string[][] = [];
  host.exec = ((name: string, args: string[]) => {
    commands.push([name, ...args]);
    const value = keychain.get(args[2] ?? '');
    if (args[0] === 'find-generic-password') return value === undefined ? { code: 44, stdout: '', stderr: '' } : { code: 0, stdout: `${value}\n`, stderr: '' };
    if (args[0] === 'delete-generic-password') return keychain.delete(args[2] ?? '') ? { code: 0, stdout: '', stderr: '' } : { code: 44, stdout: '', stderr: '' };
    return { code: 1, stdout: '', stderr: '' };
  }) as typeof host.exec;
  (host as { platform: string }).platform = 'darwin';
  const deletes = () => commands.filter((command) => command[1] === 'delete-generic-password').length;
  try {
    // A launch outside the fence: its CLI writes the keychain itself, nothing is deleted.
    const unfencedLaunch = prepareMissionLaunch('mission-unfenced', { account: row.id, fenced: false });
    const outside = current.provider.account.osCredential(runtime, service, 'mission-unfenced')!;
    assert.equal(outside.held(), 'unfenced');
    assert.equal(await outside.remove(SECRET), 'unfenced');
    assert.equal(deletes(), 0);
    unfencedLaunch();

    // A fenced launch, while another mission runs on the account outside the fence: kept.
    const fencedLaunch = prepareMissionLaunch('mission-fenced', { account: row.id, fenced: true });
    const own = current.provider.account.osCredential(runtime, service, 'mission-fenced')!;
    const live = new EventEmitter();
    recordMissionFence('mission-live', live, false, { account: row.id });
    assert.equal(own.held(), 'in-use');
    assert.equal(await own.read(), SECRET, 'reading stays harmless');
    assert.equal(await own.remove(SECRET), 'in-use');
    assert.equal(deletes(), 0, '`security delete-generic-password` never ran');
    assert.equal(keychain.get(service), SECRET, 'the pair is still in the keychain');

    // A process that starts outside the fence between the provider's read and its delete is
    // recorded in the tick of its spawn: the delete that follows sees it and renounces.
    forgetMissionFence('mission-live', live);
    assert.equal(await own.read(), SECRET);
    const oneShot = new EventEmitter();
    recordOneShotProcess('summary-0a1b2c3d', `acme-acct-profile@${row.id}`, oneShot);
    assert.equal(await own.remove(SECRET), 'in-use');
    assert.equal(deletes(), 0);
    oneShot.emit('close');

    // Nothing left that may write it: the delete goes through, with names alone on the command line.
    recordMissionFence('mission-fenced-other', {}, true, { account: row.id });
    assert.equal(own.held(), null);
    assert.equal(await own.remove(SECRET), 'removed');
    assert.equal(deletes(), 1);
    assert.equal(keychain.has(service), false);
    assert.ok(!JSON.stringify(commands).includes(SECRET), 'the secret never reaches the command line');
    fencedLaunch();
    assert.equal(own.held(), 'unfenced', 'the launch is over: nothing more to move for it');
  } finally {
    host.exec = original.exec;
    (host as { platform: string }).platform = original.platform;
    resetMissionFenceState();
  }
});

test('a login driver that is not five functions and a kind of prompt is refused at registration', () => {
  const bad = definition('acme-bad', true) as unknown as { declares: { accounts: { login: Record<string, unknown> } } };
  bad.declares.accounts = { login: { promptKind: 'qr-code', args: () => [] } };
  const problems = providerRuntime.check.definitionProblems(bad);
  assert.ok(problems.some((p) => /promptKind/.test(p)));
  for (const key of ['env', 'parse', 'identity', 'install', 'signOut']) assert.ok(problems.some((p) => p.includes(`login.${key}`)), key);
  const remote = { ...definition('acme-remote-acct', true), transport: { kind: 'remote' }, codec: { kind: 'driver', openSession: () => ({}) } };
  assert.ok(providerRuntime.check.definitionProblems(remote).some((p) => /remote.*no CLI/.test(p)));
  const slow = definition('acme-slow', true) as unknown as { declares: { accounts: { login: Record<string, unknown> } } };
  slow.declares.accounts = { login: { ...loginDriver, ttlMs: 5 } };
  assert.ok(providerRuntime.check.definitionProblems(slow).some((p) => /ttlMs/.test(p)));
});
