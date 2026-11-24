/**
 * The Copilot provider's two questions to its CLI — which models this seat may use (`copilot --acp`) and
 * how many premium requests are left (`copilot --headless --stdio`) — through the daemon's REAL
 * `ctx.provider.binary.converse`: a declared program, the system whitelist plus the profile's own
 * variables, a deadline, stopped with its tree. A stand-in `copilot` on the PATH answers both protocols.
 *
 * The reading of `account.getQuota` and the byte framing are pure and tested without a process.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const posix = process.platform !== 'win32';
const BIN = mkdtempSync(join(tmpdir(), 'timon-copilot-probes-'));
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;

/* One stand-in, two protocols, driven by the environment the probe passes it:
   --acp           newline-delimited JSON-RPC: `initialize`, then `session/new` (answer in FAKE_SESSION_NEW);
   --headless      Content-Length frames: `connect`, `auth.getStatus` (FAKE_AUTH), `account.getQuota` (FAKE_QUOTA).
   Each start is counted in FAKE_COUNT_FILE. */
if (posix) {
  const script = join(BIN, 'copilot');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "if (process.env.FAKE_COUNT_FILE) fs.appendFileSync(process.env.FAKE_COUNT_FILE, 'x');",
    "if (process.env.FAKE_ENV_FILE) fs.writeFileSync(process.env.FAKE_ENV_FILE, JSON.stringify(Object.keys(process.env)));",
    "const file = require('node:path').join(require('node:path').dirname(process.argv[1]), 'fake-answers.json');",
    "const fromFile = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};",
    "const answer = (name) => JSON.parse(process.env[name] || fromFile[name] || '{}');",
    "if (process.argv.includes('--acp')) {",
    "  const rl = require('node:readline').createInterface({ input: process.stdin });",
    "  rl.on('line', (l) => { const m = JSON.parse(l);",
    "    if (m.method === 'initialize') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: 1 } }) + '\\n');",
    "    if (m.method === 'session/new') process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...answer('FAKE_SESSION_NEW') }) + '\\n');",
    '  });',
    "} else if (process.argv.includes('--headless') && process.argv.includes('--stdio')) {",
    '  let buf = Buffer.alloc(0);',
    "  const send = (m) => { const b = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...m })); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };",
    "  process.stdin.on('data', (c) => { buf = Buffer.concat([buf, c]); for (;;) {",
    "    const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return;",
    '    const n = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, h).toString())[1]);',
    '    if (buf.length < h + 4 + n) return;',
    '    const m = JSON.parse(buf.subarray(h + 4, h + 4 + n).toString()); buf = buf.subarray(h + 4 + n);',
    "    if (m.method === 'connect') send({ id: m.id, result: { ok: true, protocolVersion: 3 } });",
    "    else if (m.method === 'auth.getStatus') send({ id: m.id, ...answer('FAKE_AUTH') });",
    "    else if (m.method === 'account.getQuota') send({ id: m.id, ...answer('FAKE_QUOTA') });",
    "    else send({ id: m.id, error: { code: -32601, message: 'Unhandled method ' + m.method } });",
    '  } });',
    '} else { process.exit(2); }',
  ].join('\n'));
  chmodSync(script, 0o755);
}

const { officialContext } = await import('../../tests/helpers/official-providers.js');
const { ctx } = await officialContext('provider-copilot');
const usageModule = await import('../../official-providers/provider-copilot/lib/usage.js') as {
  encodeFrame(message: unknown): Buffer;
  FrameReader: new () => { push(chunk: Buffer): unknown[] };
  parseCopilotQuota(result: unknown, now?: number): { windows: { monthly?: { utilization: number; resets_at: string } | null }; extra: unknown } | null;
  createCopilotUsage(services: typeof ctx.provider): { getCopilotUsage(env?: Record<string, string>, opts?: { force?: boolean; now?: number }): Promise<{ windows: { monthly?: { utilization: number } | null } }> };
};
const modelsModule = await import('../../official-providers/provider-copilot/lib/models.js') as {
  createCopilotModels(services: typeof ctx.provider): { discover(profile: { env?: Record<string, string> }, now?: number): Promise<Array<string | { id: string }>> };
};
const { isUsageNotSignedInError } = await import('../backends/usage-error.js');

const { encodeFrame, FrameReader, parseCopilotQuota } = usageModule;
const NOW = Date.parse('2026-10-11T12:00:00Z');

function premium(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    quotaSnapshots: {
      chat: { isUnlimitedEntitlement: true, entitlementRequests: -1, usedRequests: 0, remainingPercentage: 100 },
      premium_interactions: {
        isUnlimitedEntitlement: false,
        entitlementRequests: 300,
        usedRequests: 75,
        remainingPercentage: 75,
        overage: 0,
        usageAllowedWithExhaustedQuota: false,
        overageAllowedWithExhaustedQuota: false,
        resetDate: '2026-11-01T00:00:00Z',
        ...over,
      },
    },
  };
}

let unique = 0;
/** A probe environment of its own (the caches are keyed by it) that counts the CLI's starts. */
function probeEnv(answers: Record<string, unknown>): { env: Record<string, string>; starts(): number } {
  const countFile = join(BIN, `starts-${++unique}`);
  writeFileSync(countFile, '');
  const env: Record<string, string> = { FAKE_COUNT_FILE: countFile };
  for (const [key, value] of Object.entries(answers)) env[key] = JSON.stringify(value);
  return { env, starts: () => (existsSync(countFile) ? readFileSync(countFile, 'utf8').length : 0) };
}

/* ── Pure ─────────────────────────────────────────────────────────────────── */

test('the premium quota becomes a monthly window', () => {
  assert.deepEqual(parseCopilotQuota(premium(), NOW), {
    windows: { monthly: { utilization: 25, resets_at: '2026-11-01T00:00:00.000Z' } },
    extra: null,
  });
});

test('the remaining percentage is used when the counts are missing, and the reset defaults to next month', () => {
  assert.deepEqual(
    parseCopilotQuota(premium({ entitlementRequests: undefined, usedRequests: undefined, remainingPercentage: 40, resetDate: undefined }), NOW),
    { windows: { monthly: { utilization: 60, resets_at: '2026-11-01T00:00:00.000Z' } }, extra: null },
  );
});

test('overage past the allowance is clamped to 100 %, never reported as money', () => {
  const usage = parseCopilotQuota(premium({ usedRequests: 450, overage: 150 }), NOW);
  assert.equal(usage?.windows.monthly?.utilization, 100);
  assert.equal(usage?.extra, null);
});

test('an unlimited seat shows no gauge rather than 0 %', () => {
  assert.deepEqual(parseCopilotQuota(premium({ isUnlimitedEntitlement: true, entitlementRequests: -1 }), NOW), {
    windows: { monthly: null },
    extra: null,
  });
});

test('an answer without a readable premium quota is not a zero', () => {
  assert.equal(parseCopilotQuota({ quotaSnapshots: {} }, NOW), null);
  assert.equal(parseCopilotQuota({ quotaSnapshots: { premium_interactions: { usedRequests: 'x' } } }, NOW), null);
  assert.equal(parseCopilotQuota(null, NOW), null);
});

test('frames are cut on bytes, across chunks, past stray lines', () => {
  const reader = new FrameReader();
  const frame = encodeFrame({ id: 1, result: { note: 'quota épuisé — 日本' } }); // french-ok: a multi-byte sample
  const stream = Buffer.concat([Buffer.from('warming up\r\n\r\n'), frame, encodeFrame({ id: 2 })]);
  const got: unknown[] = [];
  // One byte at a time: every multi-byte character is split at least once.
  for (const byte of stream) got.push(...reader.push(Buffer.from([byte])));
  assert.deepEqual(got, [{ id: 1, result: { note: 'quota épuisé — 日本' } }, { id: 2 }]); // french-ok: a multi-byte sample
});

/* ── The quota, through the daemon's conversation service ─────────────────── */

const QUOTA = { result: premium() };

test('the probe reads the quota through the headless server', { skip: !posix }, async () => {
  const { env } = probeEnv({ FAKE_AUTH: { result: { isAuthenticated: true, login: 'octocat' } }, FAKE_QUOTA: QUOTA });
  const { getCopilotUsage } = usageModule.createCopilotUsage(ctx.provider);
  assert.equal((await getCopilotUsage(env, { now: NOW })).windows.monthly?.utilization, 25);
});

test('a reading is reused instead of starting the CLI on every poll', { skip: !posix }, async () => {
  const probe = probeEnv({ FAKE_AUTH: { result: { isAuthenticated: true } }, FAKE_QUOTA: QUOTA });
  const { getCopilotUsage } = usageModule.createCopilotUsage(ctx.provider);
  const first = await getCopilotUsage(probe.env, { now: NOW });
  assert.equal(probe.starts(), 1);
  assert.deepEqual(await getCopilotUsage(probe.env, { now: NOW + 60_000 }), first);
  assert.equal(probe.starts(), 1, 'a minute later: the cached reading');
  await getCopilotUsage(probe.env, { now: NOW + 3 * 60_000 });
  assert.equal(probe.starts(), 2, 'past the TTL: a new reading');
});

test('no CLI login is "not signed in", and is cached too', { skip: !posix }, async () => {
  const probe = probeEnv({ FAKE_AUTH: { result: { isAuthenticated: false } }, FAKE_QUOTA: QUOTA });
  const { getCopilotUsage } = usageModule.createCopilotUsage(ctx.provider);
  await assert.rejects(getCopilotUsage(probe.env, { now: NOW }), (err: unknown) => isUsageNotSignedInError(err));
  await assert.rejects(getCopilotUsage(probe.env, { now: NOW + 30_000 }), (err: unknown) => isUsageNotSignedInError(err));
  assert.equal(probe.starts(), 1);
});

test('a refused quota is unavailable, without the provider text', { skip: !posix }, async () => {
  const { env } = probeEnv({
    FAKE_AUTH: { result: { isAuthenticated: true } },
    FAKE_QUOTA: { error: { code: -32603, message: '502 upstream, request id XYZ' } },
  });
  const { getCopilotUsage } = usageModule.createCopilotUsage(ctx.provider);
  await assert.rejects(getCopilotUsage(env, { now: NOW }), (err: Error) => !isUsageNotSignedInError(err) && !err.message.includes('XYZ'));
});

test('an older CLI without the method says so', { skip: !posix }, async () => {
  const { env } = probeEnv({
    FAKE_AUTH: { result: { isAuthenticated: true } },
    FAKE_QUOTA: { error: { code: -32601, message: 'Unhandled method account.getQuota' } },
  });
  const { getCopilotUsage } = usageModule.createCopilotUsage(ctx.provider);
  await assert.rejects(getCopilotUsage(env, { now: NOW }), /does not report its quota/);
});

/* ── The models ───────────────────────────────────────────────────────────── */

test('the ACP probe returns the models the account may use', { skip: !posix }, async () => {
  const { env } = probeEnv({ FAKE_SESSION_NEW: { result: { sessionId: 's', models: { availableModels: [{ modelId: 'auto' }, { modelId: 'gemini-3.7-flash' }] } } } });
  assert.deepEqual(await modelsModule.createCopilotModels(ctx.provider).discover({ env }), ['auto', 'gemini-3.7-flash']);
});

test('a successful answer is reused instead of opening a session every refresh', { skip: !posix }, async () => {
  const probe = probeEnv({ FAKE_SESSION_NEW: { result: { sessionId: 's', models: { availableModels: [{ modelId: 'auto' }] } } } });
  const { discover } = modelsModule.createCopilotModels(ctx.provider);
  const first = await discover({ env: probe.env }, 1_000);
  assert.deepEqual(await discover({ env: probe.env }, 1_000 + 60 * 60 * 1000), first);
  assert.equal(probe.starts(), 1, 'one session in the user\'s history, not one per refresh');
  await discover({ env: probe.env }, 1_000 + 7 * 60 * 60 * 1000);
  assert.equal(probe.starts(), 2, 'after six hours the policy is asked again');
});

test('a refused ACP session rejects, without the provider text', { skip: !posix }, async () => {
  const { env } = probeEnv({ FAKE_SESSION_NEW: { error: { code: -32603, message: '403 unauthorized, request id XYZ' } } });
  await assert.rejects(modelsModule.createCopilotModels(ctx.provider).discover({ env }), (err: Error) => !err.message.includes('XYZ'));
});

test('the probes run with the system whitelist and the profile\'s own variables, never the daemon\'s environment', { skip: !posix }, async () => {
  process.env.DAEMON_SECRET_WITNESS = 'daemon-only-secret-value';
  process.env.NODE_DEBUG = 'net';
  try {
    const envFile = join(BIN, 'env-keys');
    const conversation = await ctx.provider.binary.converse('copilot', ['--acp'], { env: { COPILOT_HOME: '/somewhere', FAKE_ENV_FILE: envFile } });
    for (let i = 0; i < 100 && !existsSync(envFile); i++) await new Promise((resolve) => setTimeout(resolve, 30));
    await conversation.stop();
    const keys = JSON.parse(readFileSync(envFile, 'utf8')) as string[];
    assert.ok(keys.includes('COPILOT_HOME') && keys.includes('PATH'), 'the profile\'s variables and the system whitelist');
    assert.equal(keys.includes('DAEMON_SECRET_WITNESS'), false, 'the daemon\'s environment stays home');
    assert.equal(keys.includes('NODE_DEBUG'), false, 'NODE_DEBUG would write onto the stdout that carries the frames');
  } finally {
    delete process.env.DAEMON_SECRET_WITNESS;
    delete process.env.NODE_DEBUG;
  }
});

test('a CLI that is not installed rejects instead of throwing', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'timon-no-copilot-'));
  const saved = process.env.PATH;
  process.env.PATH = empty;
  try {
    // Another plugin context, so the host's binary cache cannot answer for the stand-in.
    const { ctx: fresh } = await officialContext('provider-copilot');
    await assert.rejects(modelsModule.createCopilotModels(fresh.provider).discover({ env: { UNIQUE_NO_CLI: '1' } }));
  } finally {
    process.env.PATH = saved;
  }
});

/* ── The daemon's own path: the registry's backend and dialect, not the factories ─────────────── */

test('the account gauge and the catalogue\'s model discovery reach the plugin through the registry', { skip: !posix }, async () => {
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
  const { getBackend } = await import('../backends/index.js');
  const { getDialect, activeProfiles } = await import('../backends/registry.js');
  writeFileSync(join(BIN, 'fake-answers.json'), JSON.stringify({
    FAKE_AUTH: JSON.stringify({ result: { isAuthenticated: true } }),
    FAKE_QUOTA: JSON.stringify(QUOTA),
    FAKE_SESSION_NEW: JSON.stringify({ result: { sessionId: 's', models: { availableModels: [{ modelId: 'auto' }, { modelId: 'gpt-5.4' }] } } }),
  }));
  // The gauge: Backend.accountUsage → dialect.accountUsage → usage.probe(profile) → account.of(profile) → converse.
  const usage = await getBackend('copilot').accountUsage!();
  assert.equal(usage?.windows.monthly?.utilization, 25);
  // The catalogue: dialect.discoverModels(profile) → models.discover → converse.
  const entry = activeProfiles().find((candidate) => candidate.profile.id === 'copilot')!;
  const resolved = await entry.runtimeFor();
  const found = await getDialect('copilot')!.discoverModels!(resolved.runtime);
  assert.deepEqual(found.map((model) => (typeof model === 'string' ? model : model.id)), ['auto', 'gpt-5.4']);
});
