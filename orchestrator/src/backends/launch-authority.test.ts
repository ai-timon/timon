/**
 * SECURITY — TODO #531, decision 3-B: the program a THIRD-PARTY backend really launches is checked
 * against what was authorized at EVERY launch, by its final path, after the provider's `buildSpawn`.
 *
 * Refusals first: a `buildSpawn` that substitutes another program (same basename elsewhere included),
 * an authorization withdrawn after registration, a link retargeted after it, a resume. Then what must
 * keep working: the authorized file, the program the daemon installed itself (typed provenance), and
 * the official dialect's own program under a third party's profile.
 *
 * Real plugin contexts, the real registry, real files on disk; the spawn is recorded, never run.
 */
import '../test-home.js';
import '../../tests/helpers/unfenced.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { Context } from '@deepseek-ai/cordis';
import type { NativeProviderDefinition } from './engine/definition.js';
import type { BuildSpawnOpts } from './types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { getHost } = await import('../host/index.js');
const { spawnAgent, upsertAgent } = await import('../agent.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { backendTrust } = await import('./registry.js');
const { getBackend } = await import('./index.js');
const { assertSpawnPinned, buildSealedSpawn } = await import('./sealed-spawn.js');
const { clearLaunchCard, launchCardAnchor, launchCardsSettled, raiseLaunchCard, resetLaunchCards } = await import('./launch-card.js');
const { dbApi } = await import('../db.js');
const { registerLaunchProvenance } = await import('./launch-provenance.js');
const { readManifest } = await import('../plugins/manifest.js');
const { createPluginContext, daemonHost } = await import('../plugins/context.js');

const posix = process.platform !== 'win32';

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

/** A program on disk: what the host resolves and what a launch is compared to. */
function program(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, posix ? name : `${name}.cmd`);
  writeFileSync(file, posix ? '#!/bin/sh\nexit 0\n' : '@exit /b 0\r\n');
  if (posix) chmodSync(file, 0o755);
  return file;
}

// `.native` also unfolds a Windows 8.3 name (`RUNNER~1`), as the launch check does.
const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-launch-authority-')));
const bin = join(root, 'bin');
const agentFile = program(bin, 'acme-auth');
const elsewhere = program(join(root, 'elsewhere'), 'acme-auth');
const officialFile = program(bin, 'acme-official-cli');
const downloaded = program(join(root, 'acp', 'agent', '1.0.0'), 'acme-downloaded');
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ''}`;

function allowExec(...entries: string[]): void {
  const previous = config();
  setConfig(TimonConfigSchema.parse({ ...previous, pluginPolicy: { ...previous.pluginPolicy, exec: { allow: entries } } }));
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

/** What the provider's `launch` returns INSTEAD of its profile's command. */
const forced: { cmd: string | null } = { cmd: null };

function definition(id: string, binary: string): NativeProviderDefinition {
  return {
    id,
    transport: { kind: 'process-per-turn' },
    codec: { kind: 'lines', parseLine: () => [], extractSessionId: () => null, writeUserInput: () => { /* a launch carries the turn */ } },
    launch: async (spawn, profile) => ({ cmd: forced.cmd ?? profile.cmd, args: [], env: { ...profile.env }, cwd: spawn.cfg.cwd, initialStdin: null }),
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

allowExec('acme-auth');
const third = pluginContext('fx-auth-third-plugin', 'acme-auth', false);
third.provider.registerProvider(definition('fx-auth-third', 'acme-auth'));
third.backends.registerProfile(profileOf('fx-auth-third-profile', 'fx-auth-third'));
const official = pluginContext('fx-auth-official-plugin', 'acme-official-cli', true);
official.provider.registerProvider(definition('fx-auth-official', 'acme-official-cli'));
official.backends.registerProfile(profileOf('fx-auth-official-profile', 'fx-auth-official'));
// A third party's profile on the official dialect, with no command of its own: it runs the dialect's program.
const intruder = pluginContext('fx-auth-intruder-plugin', 'acme-auth', false);
intruder.backends.registerProfile(profileOf('fx-auth-intruder-profile', 'fx-auth-official'));

for (const [name, backend] of [
  ['fx.auth-third', 'fx-auth-third-profile'], ['fx.auth-official', 'fx-auth-official-profile'], ['fx.auth-intruder', 'fx-auth-intruder-profile'],
] as const) {
  upsertAgent({ name, system_prompt: 'witness — does nothing.', config: { backend, cwd: tmpdir(), skills: [], memory_scope: 'NONE' } });
}

/** Launches `agent` through `spawnAgent` with a recording host: the commands that were started. */
async function launches(agent: string): Promise<{ started: string[]; error: unknown }> {
  const host = getHost();
  const original = host.spawn;
  const started: string[] = [];
  host.spawn = ((cmd: string) => { started.push(cmd); const child = fakeChild(); setImmediate(() => child.kill()); return child; }) as typeof host.spawn;
  let error: unknown = null;
  try { await spawnAgent(agent, 'ping'); } catch (err) { error = err; } finally { host.spawn = original; }
  return { started, error };
}

test.after(() => {
  forced.cmd = null;
  rmSync(root, { recursive: true, force: true });
});

/* ── Refusals first ──────────────────────────────────────────────────────── */

test('REFUSAL: a buildSpawn that substitutes another program starts nothing — same basename elsewhere included', async () => {
  allowExec('acme-auth');
  assert.equal(backendTrust('fx-auth-third-profile'), 'third-party');
  for (const cmd of [elsewhere, officialFile, 'acme-official-cli']) {
    forced.cmd = cmd;
    const { started, error } = await launches('fx.auth-third');
    forced.cmd = null;
    assert.deepEqual(started, [], `${cmd} was not started`);
    assert.match(String(error), /does not authorize/);
  }
});

test('REFUSAL: an authorization withdrawn after registration holds from the next launch', async () => {
  allowExec('acme-auth');
  const before = await launches('fx.auth-third');
  assert.equal(before.error, null);
  assert.deepEqual(before.started, [agentFile], 'the checked path is the one started');
  allowExec();
  const after = await launches('fx.auth-third');
  assert.deepEqual(after.started, []);
  assert.match(String(after.error), /authorization was withdrawn/);
  allowExec('acme-auth');
});

test('REFUSAL: a link retargeted after the authorization needs a new one', { skip: !posix }, async () => {
  const v1 = program(join(root, 'versions', 'v1'), 'acme-linked');
  const v2 = program(join(root, 'versions', 'v2'), 'acme-linked');
  const link = join(bin, 'acme-linked');
  symlinkSync(v1, link);
  try {
    // What an authorization writes: the file the link led to.
    allowExec(v1);
    forced.cmd = 'acme-linked';
    const ok = await launches('fx.auth-third');
    assert.equal(ok.error, null);
    assert.deepEqual(ok.started, [link]);
    rmSync(link);
    symlinkSync(v2, link);
    const refused = await launches('fx.auth-third');
    assert.deepEqual(refused.started, []);
    assert.match(String(refused.error), new RegExp(`launches \`${v2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\``));
    // An entry that is itself a link names no program: the file it leads to is what is compared.
    allowExec(link);
    assert.deepEqual((await launches('fx.auth-third')).started, []);
  } finally {
    forced.cmd = null;
    rmSync(link, { force: true });
    allowExec('acme-auth');
  }
});

test('REFUSAL: a resume rebuilds the command and is checked again', async () => {
  allowExec('acme-auth');
  const backend = getBackend('fx-auth-third-profile');
  const opts: BuildSpawnOpts = {
    agentName: 'fx.auth-third', systemPrompt: '', message: 'again', resumeSession: 'session-1',
    cfg: { backend: 'fx-auth-third-profile', cwd: tmpdir(), skills: [], memory_scope: 'NONE' } as BuildSpawnOpts['cfg'],
    missionId: 'mission-resume-531',
  };
  assert.equal((await buildSealedSpawn(backend, opts, null)).cmd, agentFile);
  allowExec();
  await assert.rejects(buildSealedSpawn(backend, opts, null), /does not authorize/);
  allowExec('acme-auth');
});

test('REFUSAL: a program that resolves to nothing is not launched by name', async () => {
  forced.cmd = 'acme-not-installed-anywhere';
  allowExec('acme-auth', 'acme-not-installed-anywhere');
  const { started, error } = await launches('fx.auth-third');
  forced.cmd = null;
  allowExec('acme-auth');
  assert.deepEqual(started, []);
  assert.match(String(error), /no program on this host/);
});

/* ── The card a refusal raises (TODO #598) ───────────────────────────────── */

const CARD = launchCardAnchor('fx-auth-third-plugin');

/** The open cards once every write asked so far has landed, those of the earlier tests' refusals included. */
async function openCards() {
  await launchCardsSettled();
  return dbApi.listNotifications({ limit: 500 }).filter((n) => n.anchor === CARD);
}

test('a refused launch raises ONE action-required card leading to the provider; a launch that goes through closes it', async () => {
  resetLaunchCards();
  allowExec();
  try {
    for (let i = 0; i < 3; i++) assert.deepEqual((await launches('fx.auth-third')).started, []);
    const cards = await openCards();
    assert.equal(cards.length, 1, 'one card however many turns are refused');
    assert.equal(cards[0]!.type, 'action_required');
    assert.equal(cards[0]!.mission_id, null, 'not anchored to the chat: the fix lives in Settings');
    assert.match(cards[0]!.title, /fx-auth-third-profile/);
    assert.ok((cards[0]!.body ?? '').includes(agentFile), 'the card names the file that was refused');
    // Nothing was authorized on the operator's behalf.
    assert.deepEqual(config().pluginPolicy.exec.allow, []);
  } finally {
    allowExec('acme-auth');
  }
  assert.equal((await launches('fx.auth-third')).error, null);
  assert.deepEqual(await openCards(), [], 'the launch went through: the card is answered');
});

test('cards land in the order they were asked: the last refusal is what the card says, a close answers what came before it', async () => {
  const plugin = 'fx-auth-third-plugin';
  resetLaunchCards();
  raiseLaunchCard(plugin, 'fx-auth-third-profile', 'First reason.');
  clearLaunchCard(plugin);
  raiseLaunchCard(plugin, 'fx-auth-third-profile', 'Second reason.');
  const cards = await openCards();
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.body ?? '', /^Second reason\./);
  clearLaunchCard(plugin);
  assert.deepEqual(await openCards(), []);
});

test('a card that cannot be written blocks neither the refusal nor the next card', async () => {
  const plugin = 'fx-auth-third-plugin';
  const original = dbApi.createNotification;
  resetLaunchCards();
  dbApi.createNotification = () => { throw new Error('notification store unavailable'); };
  try {
    raiseLaunchCard(plugin, 'fx-auth-third-profile', 'Lost.');
    assert.deepEqual(await openCards(), []);
  } finally {
    dbApi.createNotification = original;
  }
  resetLaunchCards();
  raiseLaunchCard(plugin, 'fx-auth-third-profile', 'Written.');
  const cards = await openCards();
  assert.equal(cards.length, 1);
  assert.match(cards[0]!.body ?? '', /^Written\./);
  clearLaunchCard(plugin, { force: true });
  assert.deepEqual(await openCards(), []);
});

test('an official backend\'s launch raises no card', async () => {
  resetLaunchCards();
  allowExec();
  try {
    await launches('fx.auth-official');
    await launchCardsSettled();
    assert.equal(dbApi.listNotifications({ limit: 500 }).filter((n) => n.anchor === launchCardAnchor('fx-auth-official-plugin')).length, 0);
  } finally {
    allowExec('acme-auth');
  }
});

/* ── The file is pinned between the check and the spawn (TODO #598) ──────── */

const checkOpts = (): BuildSpawnOpts => ({
  agentName: 'fx.auth-third', systemPrompt: '', message: 'pin', resumeSession: null,
  cfg: { backend: 'fx-auth-third-profile', cwd: tmpdir(), skills: [], memory_scope: 'NONE' } as BuildSpawnOpts['cfg'],
  missionId: 'mission-pin-598',
});

test('REFUSAL: a file renamed over the checked one before the spawn is not started', async () => {
  allowExec('acme-auth');
  const spec = await buildSealedSpawn(getBackend('fx-auth-third-profile'), checkOpts(), null);
  assert.equal(spec.cmd, agentFile);
  assert.doesNotThrow(() => assertSpawnPinned(spec), 'untouched, the checked file passes');
  // Same path, same name, another file: what an attacker with write access to the folder swaps in.
  const swap = join(bin, posix ? '.acme-auth.swap' : '.acme-auth.swap.cmd');
  copyFileSync(agentFile, swap);
  renameSync(swap, agentFile);
  assert.throws(() => assertSpawnPinned(spec), /no longer is the file checked for this launch/);
  // The next launch checks the file as it is now, by path: still authorized (no content hash, 3-B).
  const again = await buildSealedSpawn(getBackend('fx-auth-third-profile'), checkOpts(), null);
  assert.doesNotThrow(() => assertSpawnPinned(again));
});

test('REFUSAL: a link retargeted between the check and the spawn is not started', { skip: !posix }, async () => {
  const v1 = program(join(root, 'pinned', 'v1'), 'acme-pinned');
  const v2 = program(join(root, 'pinned', 'v2'), 'acme-pinned');
  const link = join(bin, 'acme-pinned');
  symlinkSync(v1, link);
  allowExec(v1, v2);
  forced.cmd = 'acme-pinned';
  try {
    const spec = await buildSealedSpawn(getBackend('fx-auth-third-profile'), checkOpts(), null);
    assert.equal(spec.cmd, link);
    rmSync(link);
    symlinkSync(v2, link);
    // Both files are authorized: what is refused is starting one that was not the one checked.
    assert.throws(() => assertSpawnPinned(spec), /no longer is the file checked for this launch/);
  } finally {
    forced.cmd = null;
    rmSync(link, { force: true });
    allowExec('acme-auth');
  }
});

test('REFUSAL: a mission whose program is swapped after the check starts nothing', async () => {
  allowExec('acme-auth');
  const host = getHost();
  const originalBin = host.bin;
  // `host.bin` runs between the check and the spawn (`resolveBackendBin`): the swap lands in that window.
  host.bin = ((name: string) => {
    const swap = join(bin, posix ? '.acme-auth.window' : '.acme-auth.window.cmd');
    copyFileSync(agentFile, swap);
    renameSync(swap, agentFile);
    return originalBin.call(host, name);
  }) as typeof host.bin;
  try {
    const { started, error } = await launches('fx.auth-third');
    assert.deepEqual(started, []);
    assert.match(String(error), /no longer is the file checked for this launch/);
  } finally {
    host.bin = originalBin;
  }
  assert.equal((await launches('fx.auth-third')).error, null, 'the next launch checks the file as it is now');
});

/* ── Typed provenance: what the daemon installed ─────────────────────────── */

test('a program the daemon installed launches as itself, and only it — withdrawn with its registration', async () => {
  allowExec('acme-auth');
  const off = registerLaunchProvenance('fx-auth-third-profile', { source: 'acp-registry', path: downloaded, version: '1.0.0' });
  try {
    forced.cmd = downloaded;
    const ok = await launches('fx.auth-third');
    assert.equal(ok.error, null, String(ok.error));
    assert.deepEqual(ok.started, [downloaded], 'on no PATH and in no list: its provenance authorizes it');
    // The provenance is the whole authorization: an allowlisted program is not this agent's.
    forced.cmd = 'acme-auth';
    const other = await launches('fx.auth-third');
    assert.deepEqual(other.started, []);
    assert.match(String(other.error), /not the program the daemon installed for it \(acp-registry 1\.0\.0/);
    off();
    forced.cmd = downloaded;
    const gone = await launches('fx.auth-third');
    assert.deepEqual(gone.started, [], 'once withdrawn, nothing authorizes the downloaded file');
  } finally {
    off();
    forced.cmd = null;
  }
});

/* ── Official exemptions unchanged ───────────────────────────────────────── */

test('an official provider launches its declared program without any allowlist entry', async () => {
  allowExec();
  try {
    assert.equal(backendTrust('fx-auth-official-profile'), 'official');
    const { started, error } = await launches('fx.auth-official');
    assert.equal(error, null, String(error));
    assert.equal(started.length, 1);
    assert.match(started[0]!, /acme-official-cli/);
  } finally {
    allowExec('acme-auth');
  }
});

test('a third party\'s profile without a command runs the official dialect\'s program, and nothing else', async () => {
  allowExec();
  try {
    assert.equal(backendTrust('fx-auth-intruder-profile'), 'third-party');
    const ok = await launches('fx.auth-intruder');
    assert.equal(ok.error, null, String(ok.error));
    assert.deepEqual(ok.started, [officialFile]);
    forced.cmd = elsewhere;
    const refused = await launches('fx.auth-intruder');
    assert.deepEqual(refused.started, []);
  } finally {
    forced.cmd = null;
    allowExec('acme-auth');
  }
});
