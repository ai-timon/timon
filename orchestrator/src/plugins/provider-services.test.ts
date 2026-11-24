/**
 * S4 `ctx.provider.binary` and S8 `ctx.provider.osCredentials`: the programs a
 * provider declared, run the way the daemon would, and one entry of the OS
 * credential store — nothing wider.
 *
 * Real processes (a fake CLI on the PATH), the real facade, the real allowlist.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createFakeCli } from '../../../packages/sdk/src/testing/fake-cli.js';

const { readManifest } = await import('./manifest.js');
const { createPluginContext, daemonHost } = await import('./context.js');
const { PluginPolicyError } = await import('./policy.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { getHost } = await import('../host/index.js');
const { readOsCredential, resetOsCredentialMisses } = await import('../host/os-credentials.js');
const { ProviderBinaryError } = await import('../backends/provider-binary.js');
const { TIMON_HOME } = await import('../paths.js');
const { pluginPatternAlertsSettled } = await import('../bounded-regex.js');
const { dbApi } = await import('../db.js');

const posix = process.platform !== 'win32';
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const dir = mkdtempSync(join(tmpdir(), 'timon-provider-binary-'));
process.env.PATH = `${dir}${delimiter}${process.env.PATH ?? ''}`;

createFakeCli({ dir, name: 'acme-agent', lines: ['acme-agent 3.4.5 (build 9)'], stderr: 'warming up\n' });
createFakeCli({ dir, name: 'acme-failing', lines: ['nope'], exitCode: 3 });
createFakeCli({ dir, name: 'claude', lines: ['claude 9.9.9'] });
createFakeCli({ dir, name: 'not-declared', lines: ['x'] });
if (posix) {
  // Prints the environment it was given, and a ready line that carries a port, then stays up.
  writeFileSync(join(dir, 'acme-serve.mjs'), [
    "process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort() }) + '\\n');",
    "setTimeout(() => process.stdout.write('listening on http://127.0.0.1:4096\\n'), 50);",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeFileSync(join(dir, 'acme-serve'), '#!/bin/sh\nexec node "$(dirname "$0")/acme-serve.mjs"\n');
  chmodSync(join(dir, 'acme-serve'), 0o755);
  // Answers every line of stdin with `echo:<line>`, tells where it runs and what it was given, and complains on stderr.
  writeFileSync(join(dir, 'acme-talk.mjs'), [
    "import { createInterface } from 'node:readline';",
    "process.stderr.write('talk ready with ' + process.env.DAEMON_SECRET_WITNESS + '\\n');",
    "process.stdout.write(JSON.stringify({ cwd: process.cwd(), env: Object.keys(process.env).sort() }) + '\\n');",
    "createInterface({ input: process.stdin }).on('line', (line) => process.stdout.write('echo:' + line + '\\n'));",
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  writeFileSync(join(dir, 'acme-talk'), '#!/bin/sh\nexec node "$(dirname "$0")/acme-talk.mjs"\n');
  chmodSync(join(dir, 'acme-talk'), 0o755);
  // Prints exactly what it is given, no line break, then stays up: the ready line a test chooses.
  writeFileSync(join(dir, 'acme-say.mjs'), "process.stdout.write(process.env.ACME_SAY ?? ''); setInterval(() => {}, 1000);");
  writeFileSync(join(dir, 'acme-say'), '#!/bin/sh\nexec node "$(dirname "$0")/acme-say.mjs"\n');
  chmodSync(join(dir, 'acme-say'), 0o755);
  writeFileSync(join(dir, 'acme-env'), '#!/bin/sh\nenv\n');
  chmodSync(join(dir, 'acme-env'), 0o755);
}

function pluginContext(pluginId: string, binaries: string[], extra: Record<string, unknown> = {}, builtin = false) {
  const res = readManifest({ timon: {
    id: pluginId, apiVersion: 12, kind: 'provider', permissions: ['backends:register'],
    provider: { binaries: binaries.map((name) => ({ name })), ...extra },
  } });
  assert.equal(res.ok, true, res.ok ? '' : res.message);
  if (!res.ok) throw new Error('unreachable');
  return createPluginContext(new Context(), { manifest: res.manifest, version: '1.0.0', ...(builtin ? { builtin: true } : {}) }, daemonHost());
}

function allowExec(...names: string[]): () => void {
  const previous = config();
  setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: names } } }));
  return () => setConfig(previous);
}

/* ── S4 ──────────────────────────────────────────────────────────────────── */

test('S4: a declared, allowed program resolves, answers its version and a short question', async () => {
  const restore = allowExec('acme-agent', 'acme-failing');
  const ctx = pluginContext('acme-bin-a', ['acme-agent', 'acme-failing']);
  try {
    const resolved = await ctx.provider.binary.resolve('acme-agent');
    assert.ok(resolved && resolved.startsWith(dir), `resolved through the host adapter: ${resolved}`);
    assert.equal(await ctx.provider.binary.version('acme-agent'), '3.4.5');
    const answer = await ctx.provider.binary.probe('acme-agent', ['status']);
    assert.equal(answer.code, 0);
    assert.match(answer.stdout, /acme-agent 3\.4\.5/);
    assert.match(answer.stderr, /warming up/);
    assert.equal(answer.timedOut, false);
    assert.equal((await ctx.provider.binary.probe('acme-failing', [])).code, 3);
  } finally {
    restore();
  }
});

test('REFUSAL: only a program the manifest declares, and only an allowed one', async () => {
  const restore = allowExec('acme-agent', 'not-declared');
  const ctx = pluginContext('acme-bin-b', ['acme-agent']);
  try {
    await assert.rejects(ctx.provider.binary.probe('not-declared', []), (error: unknown) =>
      error instanceof ProviderBinaryError && /not one of the programs this plugin's manifest declares/.test(error.message));
    await assert.rejects(ctx.provider.binary.resolve('git'), ProviderBinaryError);
    await assert.rejects(ctx.provider.binary.serve('sh', []), ProviderBinaryError);
  } finally {
    restore();
  }
  // Declared, but the operator authorized nothing.
  const none = allowExec();
  try {
    await assert.rejects(ctx.provider.binary.probe('acme-agent', []), PluginPolicyError);
  } finally {
    none();
  }
});

test('REFUSAL: a plugin cannot reach claude or codex; one shipped in the release can, for what it declares', async () => {
  const restore = allowExec('claude');
  try {
    const third = pluginContext('acme-bin-c', ['claude']);
    await assert.rejects(third.provider.binary.probe('claude', ['--version']), (error: unknown) =>
      error instanceof PluginPolicyError && /never executable by a plugin/.test(error.message));
    const official = pluginContext('acme-bin-d', ['claude'], {}, true);
    assert.equal(await official.provider.binary.version('claude'), '9.9.9');
    // Not even the release's own plugin gets a launcher, and none gets what it did not declare.
    // `node`, a launcher on the list that every machine running this test has (`sh` is not on Windows).
    const launcher = pluginContext('acme-bin-e', ['node'], {}, true);
    await assert.rejects(launcher.provider.binary.probe('node', ['-e', '0']), PluginPolicyError);
    await assert.rejects(official.provider.binary.probe('codex', []), ProviderBinaryError);
  } finally {
    restore();
  }
});

test('S4: a program that is not installed answers null, not an exception', async () => {
  const restore = allowExec('acme-missing');
  const ctx = pluginContext('acme-bin-f', ['acme-missing']);
  try {
    assert.equal(await ctx.provider.binary.resolve('acme-missing'), null);
    assert.equal(await ctx.provider.binary.version('acme-missing'), null);
    await assert.rejects(ctx.provider.binary.probe('acme-missing', []), /not installed/);
  } finally {
    restore();
  }
});

test('REFUSAL: a probe runs with the system whitelist, not the daemon\'s environment, the vault or the token', { skip: !posix }, async () => {
  const restore = allowExec('acme-env');
  const ctx = pluginContext('acme-bin-g', ['acme-env']);
  process.env.DAEMON_SECRET_WITNESS = 'daemon-only-secret-value';
  try {
    const answer = await ctx.provider.binary.probe('acme-env', [], {
      env: { ACME_OWN_SETTING: 'kept', TIMON_API_TOKEN: 'planted-token-value' },
    });
    assert.equal(answer.stdout.includes('daemon-only-secret-value'), false, 'the daemon\'s environment stays home');
    assert.equal(answer.stdout.includes('planted-token-value'), false, 'a plugin cannot name the credential');
    assert.match(answer.stdout, /ACME_OWN_SETTING=kept/);
    assert.match(answer.stdout, /^PATH=/m, 'the system whitelist is there');
  } finally {
    delete process.env.DAEMON_SECRET_WITNESS;
    restore();
  }
});

test('S4: a headless server is watched until it is ready, handed back, and stopped with its tree', { skip: !posix }, async () => {
  const restore = allowExec('acme-serve');
  const ctx = pluginContext('acme-bin-h', ['acme-serve']);
  try {
    const server = await ctx.provider.binary.serve('acme-serve', [], { ready: 'listening on (http://[^\\s]+)' });
    assert.equal(server.match, 'http://127.0.0.1:4096');
    assert.ok(server.pid && server.pid > 0);
    assert.match(server.output(), /listening on/);
    assert.equal(server.output().includes('daemon'), false);
    assert.equal(alive(server.pid!), true);
    await server.stop();
    await server.stop(); // twice is fine
    await server.exited;
    assert.equal(alive(server.pid!), false, 'the process is gone');
    // Its environment held no secret of the daemon.
    assert.equal(server.output().includes('DAEMON_SECRET'), false);
  } finally {
    restore();
  }
});

test('S4: a server that never says it is ready, or exits first, is an error that names the output', { skip: !posix }, async () => {
  const restore = allowExec('acme-serve', 'acme-failing');
  const ctx = pluginContext('acme-bin-i', ['acme-serve', 'acme-failing']);
  try {
    await assert.rejects(ctx.provider.binary.serve('acme-serve', [], { ready: 'never printed', readyTimeoutMs: 300 }), /was not ready after 300 ms/);
    await assert.rejects(ctx.provider.binary.serve('acme-failing', [], { ready: 'never printed' }), /exited before it was ready: nope/);
    await assert.rejects(ctx.provider.binary.serve('acme-serve', [], { ready: 'x'.repeat(300) }), /over 200 characters/);
  } finally {
    restore();
  }
});

const patternAlerts = (pluginId: string) => dbApi.listActiveNotifications('alert').filter((n) => n.source === `plugin:${pluginId}`);

test('S4: a ready pattern that backtracks out of control is skipped: the server is handed back, one alert, not run again (TODO #1003)', { skip: !posix }, async () => {
  const restore = allowExec('acme-serve', 'acme-say');
  const ctx = pluginContext('acme-bin-slow', ['acme-serve', 'acme-say']);
  const started: Array<{ stop(): Promise<void> }> = [];
  try {
    // Backtracks for minutes on the server's output: the wait ends, the server is kept as if no `ready` was declared.
    for (let i = 0; i < 2; i++) {
      const server = await ctx.provider.binary.serve('acme-serve', [], { ready: '(.*.*)*!$' });
      started.push(server);
      assert.equal(server.match, null);
      assert.equal(alive(server.pid!), true, 'handed back running');
    }
    // Proof the pattern is not run again: `aaaa` matches `^(a+)+$` at once, yet the second server gets no match.
    const timedOut = await ctx.provider.binary.serve('acme-say', [], { ready: '^(a+)+$', env: { ACME_SAY: 'a'.repeat(40) + '!' } });
    started.push(timedOut);
    assert.equal(timedOut.match, null);
    const skipped = await ctx.provider.binary.serve('acme-say', [], { ready: '^(a+)+$', env: { ACME_SAY: 'aaaa' }, readyTimeoutMs: 300 });
    started.push(skipped);
    assert.equal(skipped.match, null, 'off for this plugin: not evaluated on the new output');
    await pluginPatternAlertsSettled();
    const alerts = patternAlerts('acme-bin-slow');
    assert.equal(alerts.length, 2, 'one alert per pattern, not per server');
    assert.ok(alerts.every((n) => n.urgent === 0));
    assert.ok(alerts.some((n) => /ready pattern for `acme-serve`/.test(n.title) && /ran past 250 ms/.test(n.body ?? '')));
    // Another plugin with the same pattern still runs it.
    const fresh = pluginContext('acme-bin-fresh', ['acme-say']);
    const matched = await fresh.provider.binary.serve('acme-say', [], { ready: '^(a+)+$', env: { ACME_SAY: 'aaaa' } });
    started.push(matched);
    assert.equal(matched.match, 'aaaa');
  } finally {
    await Promise.all(started.map((server) => server.stop()));
    restore();
  }
});

test('S4: a ready pattern that is not a regular expression is skipped and alerted once', { skip: !posix }, async () => {
  const restore = allowExec('acme-serve');
  const ctx = pluginContext('acme-bin-broken', ['acme-serve']);
  try {
    for (let i = 0; i < 2; i++) {
      const server = await ctx.provider.binary.serve('acme-serve', [], { ready: '(' });
      assert.equal(server.match, null);
      await server.stop();
    }
    await pluginPatternAlertsSettled();
    const alerts = patternAlerts('acme-bin-broken');
    assert.equal(alerts.length, 1);
    assert.match(alerts[0]?.body ?? '', /not a valid regular expression/);
  } finally {
    restore();
  }
});

test('S4: a plugin that unloads takes its servers with it', { skip: !posix }, async () => {
  const restore = allowExec('acme-serve');
  const root = new Context();
  let inner!: Context;
  const fiber = await root.plugin({ name: 'holder', apply(c: Context) { inner = c; } });
  const res = readManifest({ timon: { id: 'acme-bin-j', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { binaries: [{ name: 'acme-serve' }] } } });
  if (!res.ok) throw new Error(res.message);
  const ctx = createPluginContext(inner, { manifest: res.manifest, version: '1.0.0' }, daemonHost());
  let started: Awaited<ReturnType<typeof ctx.provider.binary.serve>> | null = null;
  try {
    started = await ctx.provider.binary.serve('acme-serve', [], { ready: 'listening' });
    const pid = started.pid!;
    await fiber.dispose();
    await started.exited;
    assert.throws(() => process.kill(pid, 0), 'the server died with the plugin');
  } finally {
    // Whatever happened above, a server must not outlive the test (it would hold the process open).
    await started?.stop();
    restore();
  }
});

test('S4: a conversation over the pipes — bytes in, bytes out, the daemon\'s home as the folder, then stopped with its tree', { skip: !posix }, async () => {
  const restore = allowExec('acme-talk');
  const ctx = pluginContext('acme-bin-k', ['acme-talk']);
  process.env.DAEMON_SECRET_WITNESS = 'daemon-only-secret-value';
  try {
    const talk = await ctx.provider.binary.converse('acme-talk', [], { env: { ACME_OWN_SETTING: 'kept' } });
    let heard = '';
    const stop = talk.onData((chunk) => { assert.ok(chunk instanceof Uint8Array); heard += Buffer.from(chunk).toString('utf8'); });
    const until = async (pattern: RegExp): Promise<void> => {
      for (let i = 0; i < 100 && !pattern.test(heard); i++) await new Promise((resolve) => setTimeout(resolve, 30));
      assert.match(heard, pattern);
    };
    await until(/"cwd"/);
    const hello = JSON.parse(heard.split('\n')[0]!) as { cwd: string; env: string[] };
    assert.equal(realpathSync(hello.cwd), realpathSync(talk.cwd), 'it runs in the folder the conversation reports');
    assert.equal(talk.cwd, TIMON_HOME);
    assert.ok(hello.env.includes('ACME_OWN_SETTING') && hello.env.includes('PATH'));
    assert.equal(hello.env.includes('DAEMON_SECRET_WITNESS'), false, 'the daemon\'s environment stays home');
    assert.equal(hello.env.includes('NODE_DEBUG'), false, 'NODE_DEBUG would write onto the protocol\'s stdout');
    talk.write('ping\n');
    talk.write(Buffer.from('bytes\n'));
    await until(/echo:ping\necho:bytes\n/);
    assert.match(talk.stderr(), /talk ready/);
    assert.equal(talk.stderr().includes('daemon-only-secret-value'), false, 'what it printed is masked');
    stop();
    talk.write('after\n');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(heard.includes('echo:after'), false, 'a listener that stopped hears nothing');
    assert.equal(alive(talk.pid!), true);
    await talk.stop();
    await talk.stop(); // twice is fine
    await talk.exited;
    assert.equal(alive(talk.pid!), false, 'the process is gone');
  } finally {
    delete process.env.DAEMON_SECRET_WITNESS;
    restore();
  }
});

test('REFUSAL: a conversation ends at its deadline, and only a declared program can hold one', { skip: !posix }, async () => {
  const restore = allowExec('acme-talk');
  const ctx = pluginContext('acme-bin-l', ['acme-talk']);
  try {
    const slow = await ctx.provider.binary.converse('acme-talk', [], { timeoutMs: 250 });
    const result = await Promise.race([slow.exited.then(() => 'gone'), new Promise((resolve) => setTimeout(() => resolve('alive'), 3_000))]);
    assert.equal(result, 'gone', 'the daemon stopped it when the time was up');
    await assert.rejects(ctx.provider.binary.converse('sh', []), ProviderBinaryError);
    await assert.rejects(ctx.provider.binary.converse('not-declared', []), ProviderBinaryError);
  } finally {
    restore();
  }
});

test('S4: a plugin may hold four servers and conversations together, and the fifth is refused', { skip: !posix }, async () => {
  const restore = allowExec('acme-talk', 'acme-serve');
  const ctx = pluginContext('acme-bin-m', ['acme-talk', 'acme-serve']);
  const held: Array<{ stop(): Promise<void> }> = [];
  try {
    held.push(await ctx.provider.binary.serve('acme-serve', []));
    for (let i = 0; i < 3; i++) held.push(await ctx.provider.binary.converse('acme-talk', []));
    await assert.rejects(ctx.provider.binary.converse('acme-talk', []), /already runs 4/);
    await assert.rejects(ctx.provider.binary.serve('acme-serve', []), /already runs 4/);
  } finally {
    await Promise.all(held.map((entry) => entry.stop()));
    restore();
  }
});

/* ── S8 ──────────────────────────────────────────────────────────────────── */

test('S8: only an entry the manifest declared can be read, and only on macOS', async () => {
  const ctx = pluginContext('acme-os-a', [], { osCredentials: [{ service: 'Acme CLI-credentials' }, { service: 'Acme CLI', account: 'work' }] });
  const host = getHost();
  const original = host.exec;
  const asked: string[][] = [];
  host.exec = ((name: string, args: string[]) => { asked.push([name, ...args]); return { code: 0, stdout: 'the-stored-secret\n', stderr: '' }; }) as typeof host.exec;
  const platform = host.platform;
  try {
    resetOsCredentialMisses();
    (host as { platform: string }).platform = 'darwin';
    assert.equal(await ctx.provider.osCredentials.read('Acme CLI-credentials'), 'the-stored-secret');
    assert.deepEqual(asked.at(-1), ['security', 'find-generic-password', '-s', 'Acme CLI-credentials', '-w']);
    assert.equal(await ctx.provider.osCredentials.read('Acme CLI', 'work'), 'the-stored-secret');
    assert.deepEqual(asked.at(-1), ['security', 'find-generic-password', '-s', 'Acme CLI', '-a', 'work', '-w']);
    // Not declared: another service, another account, the account the manifest did not name.
    for (const [service, account] of [['Claude Code-credentials', undefined], ['Acme CLI', 'personal'], ['Acme CLI-credentials', 'x'], ['Acme CLI', undefined]] as const) {
      assert.throws(() => ctx.provider.osCredentials.invalidate(service, account), PluginPolicyError);
      await assert.rejects(ctx.provider.osCredentials.read(service, account), (error: unknown) =>
        error instanceof PluginPolicyError && /is not an entry this plugin's manifest declares/.test(error.message), `${service}/${account}`);
    }
    const before = asked.length;
    (host as { platform: string }).platform = 'linux';
    assert.equal(await ctx.provider.osCredentials.read('Acme CLI-credentials'), null);
    assert.equal(asked.length, before, 'nothing is asked of the OS where there is no such store');
  } finally {
    host.exec = original;
    (host as { platform: string }).platform = platform;
  }
});

test('S8: a miss is remembered for a minute, so a gauge that polls does not stack prompts', () => {
  resetOsCredentialMisses();
  let calls = 0;
  const host = { platform: 'darwin' as const, exec: () => { calls += 1; return { code: 44, stdout: '', stderr: 'not found' }; } };
  assert.equal(readOsCredential(host, { service: 's' }, 1_000), null);
  assert.equal(readOsCredential(host, { service: 's' }, 30_000), null);
  assert.equal(calls, 1);
  assert.equal(readOsCredential(host, { service: 's' }, 70_000), null);
  assert.equal(calls, 2);
  assert.equal(readOsCredential(host, { service: 'other' }, 70_000), null, 'another entry has its own memory');
  assert.equal(calls, 3);
  const throwing = { platform: 'darwin' as const, exec: () => { throw new Error('spawn failed'); } };
  assert.equal(readOsCredential(throwing, { service: 'x' }), null, 'never throws');
});

test('S8: the manifest refuses an entry that is not a printable name', () => {
  const bad = readManifest({ timon: { id: 'acme-os-b', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { osCredentials: [{ service: 'a\nb' }] } } });
  assert.equal(bad.ok, false);
  const many = readManifest({ timon: { id: 'acme-os-c', apiVersion: 12, kind: 'provider', permissions: ['backends:register'], provider: { osCredentials: Array.from({ length: 5 }, (_, i) => ({ service: `s${i}` })) } } });
  assert.equal(many.ok, false);
});

/* ── S3 bis ──────────────────────────────────────────────────────────────── */

test('S3 bis: ctx.provider.git.writableRoots answers for a repository, and for nothing else', async () => {
  const { execFileSync } = await import('node:child_process');
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-provider-git-')));
  execFileSync('git', ['init', '-q'], { cwd: repo, stdio: 'ignore' });
  const ctx = pluginContext('acme-git', []);
  assert.deepEqual(ctx.provider.git.writableRoots(repo), [join(repo, '.git')]);
  assert.deepEqual(ctx.provider.git.writableRoots(join(repo, 'missing')), [], 'a folder that does not exist');
  assert.deepEqual(ctx.provider.git.writableRoots('relative/path'), [], 'a relative path is not a working directory');
  assert.deepEqual(ctx.provider.git.writableRoots(realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-provider-nogit-')))), [], 'outside a repository');
});

test('registerProductProfile: a plugin shipped in the release registers a profile that names a vault entry, inactive until its dialect is there; anyone else is refused', async () => {
  const { activeProfiles, inactiveProfiles } = await import('../backends/registry.js');
  const profile = {
    id: 'acme-product', dialect: 'acme-not-here-yet', label: 'Acme', custom: true,
    env: { ACME_API_KEY: { secret: 'ACME_API_KEY' } }, envFrom: { ACME_API_KEY: 'ACME_API_KEY' },
    defaultModel: 'm', models: [{ slug: 'm', label: 'm' }], credentialDirs: ['.acme-product'],
  } as unknown as Parameters<ReturnType<typeof pluginContext>['provider']['registerProductProfile']>[0];
  const stranger = pluginContext('acme-profile-stranger', []);
  assert.throws(() => stranger.provider.registerProductProfile(profile), PluginPolicyError);
  const release = pluginContext('acme-profile-release', [], { credentialDirs: ['.acme-product'] }, true);
  const off = release.provider.registerProductProfile(profile);
  try {
    assert.equal(activeProfiles().some((entry) => entry.profile.id === 'acme-product'), false, 'no dialect, no profile in service');
    assert.match(inactiveProfiles().find((row) => row.id === 'acme-product')?.reason ?? '', /acme-not-here-yet/);
  } finally {
    off();
  }
  assert.equal(inactiveProfiles().some((row) => row.id === 'acme-product'), false, 'removed with the plugin');
});
