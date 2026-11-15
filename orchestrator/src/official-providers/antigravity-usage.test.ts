/**
 * The Antigravity quota gauge (`provider-acp/lib/antigravity-usage.js`): a throwaway `agy acp` started
 * through the daemon's REAL `ctx.provider.binary.converse`, its session opened, the HTTP port of its
 * language server read from the log file the probe named, one `RetrieveUserQuotaSummary` request, then
 * the process killed and the log removed — on every path.
 *
 * A stand-in `agy` on the PATH plays the real one: it speaks ACP on its pipes, writes the port line to
 * `--log-file`, and serves a fake Connect server on 127.0.0.1. No network call leaves the machine.
 * Each run records its pid, the paths it was asked for and what it saw of its environment and folder.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const posix = process.platform !== 'win32';
// Never under the probe's own prefix (`timon-agy-usage-`): its sweep would remove the stand-in once a long suite passes a minute.
const BIN = mkdtempSync(join(tmpdir(), 'timon-agyfake-'));
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
const CONFIG = join(BIN, 'fake-agy.json');
const QUOTA_PATH = '/exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';

/* The stand-in, driven by `fake-agy.json` next to it:
   mode     ok | auth | hang | noport | old (the server answers 404 to everything)
            | orphan: the server is a child of agy, and agy exits once the session is open, leaving it
              listening; it answers only after agy is gone, so the probe meets an agy already exited
            | orphan-nopid: the same, but the log never names the server's pid
   answers  what the quota method returns, one per request, the last one repeated
   record   folder where it writes `pid`, `children`, `seen.json` and `requests` */
if (posix) {
  const script = join(BIN, 'agy');
  writeFileSync(script, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs'); const path = require('node:path'); const http = require('node:http');",
    "const cfg = JSON.parse(fs.readFileSync(path.join(path.dirname(process.argv[1]), 'fake-agy.json'), 'utf8'));",
    'const args = process.argv.slice(2);',
    // The orphan's server, started by agy below as `agy --serve <log>`.
    "if (args[0] === '--serve') {",
    "  fs.appendFileSync(path.join(cfg.record, 'children'), process.pid + '\\n');",
    '  const parent = process.ppid; let served = 0;',
    "  const answer = (res) => { const a = cfg.answers[Math.min(served++, cfg.answers.length - 1)]; res.setHeader('content-type', 'application/json'); res.end(typeof a === 'string' ? a : JSON.stringify(a)); };",
    '  const whenOrphaned = (res, tries = 0) => (process.ppid !== parent || tries > 150 ? answer(res) : setTimeout(() => whenOrphaned(res, tries + 1), 20));',
    '  const child = http.createServer((req, res) => {',
    "    fs.appendFileSync(path.join(cfg.record, 'requests'), req.method + ' ' + req.url + '\\n');",
    "    req.resume(); req.on('end', () => whenOrphaned(res));",
    '  });',
    "  child.listen(0, '127.0.0.1', () => {",
    "    if (cfg.mode !== 'orphan-nopid') fs.appendFileSync(args[1], 'Starting language server process with pid ' + process.pid + '\\n');",
    "    fs.appendFileSync(args[1], 'Language server listening on random port at ' + child.address().port + ' for HTTP\\n');",
    '  });',
    '  setInterval(() => {}, 1000);',
    '  return;',
    '}',
    "const log = args[args.indexOf('--log-file') + 1];",
    "if (args.indexOf('--log-file') !== 0 || args[2] !== 'acp') process.exit(3);",
    "fs.appendFileSync(path.join(cfg.record, 'pid'), process.pid + '\\n');",
    "fs.writeFileSync(path.join(cfg.record, 'seen.json'), JSON.stringify({ log, dirMode: fs.statSync(path.dirname(log)).mode & 0o777,",
    "  AGY_ADC_AUTH: process.env.AGY_ADC_AUTH, GEMINI_API_KEY: process.env.GEMINI_API_KEY, keys: Object.keys(process.env) }));",
    "fs.writeFileSync(log, 'I starting agy\\nLanguage server listening on random port at 1 for HTTPS\\n');",
    'setInterval(() => {}, 1000);',
    'let served = 0;',
    'const server = http.createServer((req, res) => {',
    "  fs.appendFileSync(path.join(cfg.record, 'requests'), req.method + ' ' + req.url + '\\n');",
    "  req.resume(); req.on('end', () => {",
    `    if (cfg.mode === 'old' || req.url !== '${QUOTA_PATH}') { res.statusCode = 404; res.end(); return; }`,
    '    const a = cfg.answers[Math.min(served++, cfg.answers.length - 1)];',
    "    res.setHeader('content-type', 'application/json'); res.end(typeof a === 'string' ? a : JSON.stringify(a));",
    '  });',
    '});',
    "const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');",
    "require('node:readline').createInterface({ input: process.stdin }).on('line', (l) => { const m = JSON.parse(l);",
    "  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Google' }] } });",
    // A real agy opens the Google sign-in page in the browser here: the stand-in only records the call.
    "  else if (m.method === 'authenticate') { fs.appendFileSync(path.join(cfg.record, 'authenticate'), m.params.methodId + '\\n'); send({ id: m.id, result: {} }); }",
    "  else if (m.method === 'session/new') {",
    "    if (cfg.mode === 'auth') send({ id: m.id, error: { code: -32000, message: 'Authentication required for someone@example.test' } });",
    "    else if (cfg.mode === 'hang') { /* never answers */ }",
    "    else if (cfg.mode.startsWith('orphan')) {",
    "      require('node:child_process').spawn(process.execPath, [process.argv[1], '--serve', log], { stdio: 'ignore' }).unref();",
    "      const ready = () => (/for HTTP\\n/.test(fs.readFileSync(log, 'utf8')) ? (send({ id: m.id, result: { sessionId: 'probe-session' } }), setTimeout(() => process.exit(0), 50)) : setTimeout(ready, 20));",
    '      ready();',
    '    }',
    "    else server.listen(0, '127.0.0.1', () => {",
    "      if (cfg.mode !== 'noport') fs.appendFileSync(log, 'Language server listening on random port at ' + server.address().port + ' for HTTP\\n');",
    "      send({ id: m.id, result: { sessionId: 'probe-session' } });",
    '    });',
    '  }',
    '});',
  ].join('\n'));
  chmodSync(script, 0o755);
}

const { officialContext } = await import('../../tests/helpers/official-providers.js');
const { ctx } = await officialContext('provider-acp');
const usageModule = await import('../../official-providers/provider-acp/lib/antigravity-usage.js') as {
  QUOTA_METHOD_PATH: string;
  parseQuotaSummary(payload: unknown): { state: 'ok'; usage: { windows: Record<string, { utilization: number; resets_at: string } | null>; extra: null } } | { state: 'pending' } | { state: 'invalid'; reason: string };
  portFromLog(file: string): number | null;
  readCapped(response: Response, max: number): Promise<string | null>;
  createAntigravityUsage(opts: {
    services: typeof ctx.provider; names: readonly string[]; env: Record<string, string>;
    signIn: string; timeoutMs?: number;
  }): {
    getUsage(profile?: { cmd?: string; env?: Record<string, string> }, options?: { force?: boolean; now?: number }): Promise<{ windows: Record<string, { utilization: number; resets_at: string } | null>; extra: null }>;
    forget(): void;
  };
};
const { isUsageNotSignedInError } = await import('../backends/usage-error.js');
const { parseQuotaSummary, portFromLog, readCapped, createAntigravityUsage, QUOTA_METHOD_PATH } = usageModule;

/** The answer captured from agy 1.5.9 on a Pro account (research of 14/11/2026), descriptions trimmed. */
const SUMMARY = {
  response: {
    groups: [
      {
        displayName: 'Gemini Models',
        description: 'Models within this group: Gemini 3.8 Flash',
        buckets: [{ bucketId: 'gemini-weekly', displayName: 'Weekly Limit Remaining', window: 'weekly', remainingFraction: 0.9705752, resetTime: '2026-11-21T09:11:45Z' }],
      },
      {
        displayName: 'Claude and GPT models',
        description: 'Models within this group: Claude Sonnet 4.6, Claude Opus 4.6, GPT-OSS 120B',
        buckets: [{ bucketId: '3p-weekly', window: 'weekly', remainingFraction: 1, resetTime: '2026-11-21T14:19:20Z' }],
      },
    ],
    description: 'Within each group, models share a weekly limit.',
  },
};
const EXPECTED = {
  'Gemini Models': { utilization: 2.9, resets_at: '2026-11-21T09:11:45.000Z' },
  'Claude and GPT models': { utilization: 0, resets_at: '2026-11-21T14:19:20.000Z' },
};
const SIGN_IN = 'run `agy acp --login` in a terminal on this machine, then retry';
const SWITCHES = { AGY_ADC_AUTH: '', GEMINI_API_KEY: '' };

/* ── Pure ─────────────────────────────────────────────────────────────────── */

test('the summary becomes one weekly window per model group, named as agy names it', () => {
  assert.equal(QUOTA_METHOD_PATH, QUOTA_PATH);
  assert.deepEqual(parseQuotaSummary(SUMMARY), { state: 'ok', usage: { windows: EXPECTED, extra: null } });
});

test('an answer given before the account is loaded is asked again, not read as empty', () => {
  for (const early of [{}, { response: {} }, { response: { groups: [] } }, { response: { groups: [{ displayName: 'Gemini Models' }] } }, { response: { groups: [{ displayName: 'G', buckets: [] }] } }]) {
    assert.deepEqual(parseQuotaSummary(early), { state: 'pending' }, JSON.stringify(early));
  }
});

test('a field of the wrong type is a changed shape: the probe fails rather than guess', () => {
  const bucket = (over: Record<string, unknown>) => ({ response: { groups: [{ displayName: 'G', buckets: [{ resetTime: '2026-11-21T09:11:45Z', ...over }] }] } });
  for (const changed of [
    null, [], 'text', { response: [] }, { response: { groups: {} } }, { response: { groups: ['x'] } },
    { response: { groups: [{ displayName: 3, buckets: [] }] } }, { response: { groups: [{ buckets: {} }] } },
    bucket({ remainingFraction: '0.5' }), bucket({ remainingFraction: 1.5 }), bucket({ remainingFraction: -0.1 }),
    bucket({ remainingFraction: Number.NaN }), bucket({ resetTime: 12 }),
  ]) {
    assert.equal(parseQuotaSummary(changed).state, 'invalid', JSON.stringify(changed));
  }
});

test('an exhausted bucket (proto3 leaves the zero out) is full; a bucket without a reset time is unavailable, never zero', () => {
  const reading = parseQuotaSummary({ response: { groups: [
    { displayName: 'Gemini Models', buckets: [{ window: 'weekly', resetTime: '2026-11-21T09:11:45Z' }] },
    { displayName: 'Claude and GPT models', buckets: [{ window: 'weekly', remainingFraction: 0.5 }] },
  ] } });
  assert.deepEqual(reading, { state: 'ok', usage: { windows: {
    'Gemini Models': { utilization: 100, resets_at: '2026-11-21T09:11:45.000Z' },
    'Claude and GPT models': null,
  }, extra: null } });
});

test('labels are cleaned and bounded, several buckets of a group are told apart, and twins never overwrite each other', () => {
  const reset = '2026-11-21T09:11:45Z';
  const reading = parseQuotaSummary({ response: { groups: [
    { displayName: 'Gemini\u0000 Models\n', buckets: [{ window: 'weekly', remainingFraction: 0.5, resetTime: reset }, { window: 'daily', remainingFraction: 0.25, resetTime: reset }] },
    { displayName: 'Same', buckets: [{ remainingFraction: 1, resetTime: reset }] },
    { displayName: 'Same', buckets: [{ remainingFraction: 1, resetTime: reset }] },
    { buckets: [{ remainingFraction: 1, resetTime: reset }] },
    { displayName: 'x'.repeat(500), buckets: [{ remainingFraction: 1, resetTime: reset }] },
  ] } });
  assert.equal(reading.state, 'ok');
  if (reading.state !== 'ok') return;
  assert.deepEqual(Object.keys(reading.usage.windows), ['Gemini Models (weekly)', 'Gemini Models (daily)', 'Same', 'Same 2', 'Model group 4', 'x'.repeat(60)]);
  assert.equal(reading.usage.windows['Gemini Models (daily)']?.utilization, 75);
});

test('the port is the HTTP one of the log, and nothing else', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-agy-port-'));
  try {
    const log = join(dir, 'agy.log');
    assert.equal(portFromLog(log), null, 'no log yet');
    writeFileSync(log, 'Language server listening on random port at 41234 for HTTPS\n');
    assert.equal(portFromLog(log), null, 'the gRPC port is not the one');
    writeFileSync(log, 'Language server listening on random port at 41234 for HTTPS\nLanguage server listening on random port at 41235 for HTTP\n');
    assert.equal(portFromLog(log), 41235);
    writeFileSync(log, 'Language server listening on random port at 70000 for HTTP\n');
    assert.equal(portFromLog(log), null, 'not a port');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an answer is read in a stream and abandoned past its ceiling, never held whole', async () => {
  assert.equal(await readCapped(new Response('{"a":1}'), 16), '{"a":1}');
  assert.equal(await readCapped(new Response(null), 16), '');
  assert.equal(await readCapped(new Response('x'.repeat(17)), 16), null, 'the declared length is enough to refuse');
  // No length declared, and an endless source: the read stops at the first chunk past the ceiling.
  let pulled = 0;
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) { pulled += 1; controller.enqueue(new Uint8Array(10)); },
    cancel() { cancelled = true; },
  });
  assert.equal(await readCapped(new Response(endless), 25), null);
  assert.equal(pulled <= 4, true, `pulled ${pulled} chunks`);
  assert.equal(cancelled, true, 'the rest of the body is cancelled');
});

/* ── Through the daemon's process: a stand-in agy ─────────────────────────── */

let unique = 0;
type Run = { record: string; pids(): number[]; children(): number[]; requests(): string[]; authenticated(): string[]; seen(): { log: string; dirMode: number; AGY_ADC_AUTH?: string; GEMINI_API_KEY?: string; keys: string[] } };

function scenario(mode: string, answers: unknown[] = [SUMMARY]): Run {
  // One record folder per scenario, the stand-in writes into it.
  const dir = mkdtempSync(join(BIN, `run-${++unique}-`));
  writeFileSync(CONFIG, JSON.stringify({ mode, answers, record: dir }));
  const read = (name: string) => (existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8') : '');
  return {
    record: dir,
    pids: () => read('pid').split('\n').filter(Boolean).map(Number),
    children: () => read('children').split('\n').filter(Boolean).map(Number),
    requests: () => read('requests').split('\n').filter(Boolean),
    authenticated: () => read('authenticate').split('\n').filter(Boolean),
    seen: () => JSON.parse(read('seen.json')) as ReturnType<Run['seen']>,
  };
}

function probe(timeoutMs?: number) {
  return createAntigravityUsage({
    services: ctx.provider, names: ['agy'], env: SWITCHES, signIn: SIGN_IN,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** A process left by agy is reparented and reaped by whoever adopts it: `kill(pid, 0)` sees the zombie until then. */
async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  return !alive(pid);
}

/** Whatever a scenario left, so a failed assertion does not leave a listening server behind the suite. */
function killChildren(run: Run): void {
  for (const pid of run.children()) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}

/** The process is gone and its log folder with it: the server lived for the probe only. */
function assertCleanedUp(run: Run): void {
  const pids = run.pids();
  assert.ok(pids.length > 0, 'the stand-in ran');
  for (const pid of pids) assert.equal(alive(pid), false, `agy ${pid} was killed`);
  const { log } = run.seen();
  assert.equal(existsSync(join(log, '..')), false, 'the private log folder is removed');
}

test('the stand-in is the agy the daemon resolves: no real agy, no network', { skip: !posix }, async () => {
  assert.equal(await ctx.provider.binary.resolve('agy'), join(BIN, 'agy'));
});

test('nominal: the quota of each group, from a throwaway agy that is gone afterwards', { skip: !posix }, async () => {
  const run = scenario('ok');
  const usage = await probe().getUsage({ cmd: 'agy', env: { GEMINI_API_KEY: 'AIza-vault-witness', AGY_ADC_AUTH: '1', SOME_PATH: '/x' } });
  assert.deepEqual(usage, { windows: EXPECTED, extra: null });
  assertCleanedUp(run);
  const seen = run.seen();
  assert.equal(seen.AGY_ADC_AUTH, '', 'never the Application Default Credentials');
  assert.equal(seen.GEMINI_API_KEY, '', 'never the billed API key');
  assert.ok(seen.keys.includes('SOME_PATH'), 'the profile\'s own variables, as for a mission');
  assert.equal(seen.keys.includes('TIMON_API_TOKEN'), false);
  assert.equal(seen.dirMode, 0o700, 'the log lives in a folder only the daemon\'s account reads');
  assert.deepEqual(run.requests(), [`POST ${QUOTA_PATH}`], 'one method, never GetUserStatus');
});

test('an answer given while the account loads is asked again', { skip: !posix }, async () => {
  const run = scenario('ok', [{ response: {} }, { response: { groups: [] } }, SUMMARY]);
  assert.deepEqual((await probe().getUsage()).windows, EXPECTED);
  assert.equal(run.requests().length, 3);
  assertCleanedUp(run);
});

test('auth_required at session/new is "not signed in", with the sign-in step and nothing agy wrote', { skip: !posix }, async () => {
  const run = scenario('auth');
  await assert.rejects(probe().getUsage(), (err: Error) => {
    assert.ok(isUsageNotSignedInError(err));
    assert.match(err.message, /agy acp --login/);
    assert.doesNotMatch(err.message, /someone@example/);
    return true;
  });
  assert.deepEqual(run.authenticated(), [], 'never `authenticate`: agy would open a sign-in page in the browser');
  assert.deepEqual(run.requests(), [], 'no server, no request');
  assertCleanedUp(run);
});

test('an agy that never answers is an error at the deadline, and is killed', { skip: !posix }, async () => {
  const run = scenario('hang');
  const started = Date.now();
  await assert.rejects(probe(1_500).getUsage(), (err: Error) => !isUsageNotSignedInError(err) && /in time/.test(err.message));
  assert.ok(Date.now() - started < 8_000, 'the probe\'s own deadline, not the daemon\'s backstop');
  assertCleanedUp(run);
});

test('a log without the HTTP port is an error, never a port guessed elsewhere', { skip: !posix }, async () => {
  const run = scenario('noport');
  await assert.rejects(probe(1_500).getUsage(), /port/);
  assert.deepEqual(run.requests(), []);
  assertCleanedUp(run);
});

test('a changed answer is an error without the answer in it', { skip: !posix }, async () => {
  const secret = { response: { groups: [{ displayName: 'someone@example.test', buckets: [{ remainingFraction: 'lots', resetTime: '2026-11-21T09:11:45Z' }] }] } };
  const run = scenario('ok', [secret]);
  await assert.rejects(probe().getUsage(), (err: Error) => {
    assert.match(err.message, /does not recognise/);
    assert.doesNotMatch(err.message, /someone@example|lots/);
    return true;
  });
  assertCleanedUp(run);
  const run2 = scenario('ok', ['not json at all']);
  await assert.rejects(probe().getUsage(), /not JSON/);
  assertCleanedUp(run2);
});

test('an oversized answer is an error, and agy is still gone', { skip: !posix }, async () => {
  const run = scenario('ok', ['x'.repeat(300 * 1024)]);
  await assert.rejects(probe().getUsage(), /unexpected size/);
  assertCleanedUp(run);
});

test('a server agy leaves behind when it exits first is killed by the pid its log gives', { skip: !posix }, async () => {
  const run = scenario('orphan');
  try {
    const usage = probe();
    assert.deepEqual((await usage.getUsage()).windows, EXPECTED, 'answered once agy had exited');
    const [server] = run.children();
    assert.ok(server, 'agy left a child listening');
    assert.equal(await gone(server), true, `the server ${server} agy left is killed`);
    assertCleanedUp(run);
    assert.deepEqual(run.requests(), [`POST ${QUOTA_PATH}`], 'the check of the port sends no request');
  } finally {
    killChildren(run);
  }
});

test('a server that cannot be killed fails the reading and holds it until a person retries', { skip: !posix }, async () => {
  const run = scenario('orphan-nopid');
  try {
    const usage = probe();
    await assert.rejects(usage.getUsage(), (err: Error) => {
      assert.equal(err.name, 'LeftoverServerError');
      assert.match(err.message, /left its local language server running/);
      assert.doesNotMatch(err.message, /\d{4,5}/, 'no port in the message');
      return true;
    });
    const [server] = run.children();
    assert.ok(server && alive(server), 'without its pid, the server is not guessed: it is reported');
    await assert.rejects(usage.getUsage(undefined, { now: Date.now() + 10 * 60_000 }), /left its local language server/);
    assert.equal(run.pids().length, 1, 'no automatic reading starts agy again while a server is left');
    killChildren(run);
    assert.equal(await gone(server), true);
    const next = scenario('ok');
    assert.deepEqual((await usage.getUsage(undefined, { force: true })).windows, EXPECTED, 'the ↻ reads again');
    assertCleanedUp(next);
  } finally {
    killChildren(run);
  }
});

test('an agy without the method says to update it', { skip: !posix }, async () => {
  const run = scenario('old');
  await assert.rejects(probe().getUsage(), /update agy/);
  assertCleanedUp(run);
});

test('a reading is reused for 5 minutes; ↻ asks again; two callers share one process', { skip: !posix }, async () => {
  const run = scenario('ok');
  const usage = probe();
  const [a, b] = await Promise.all([usage.getUsage(), usage.getUsage()]);
  assert.deepEqual(a, b);
  assert.equal(run.pids().length, 1, 'one process for two simultaneous callers');
  await usage.getUsage(undefined, { now: Date.now() + 4 * 60_000 });
  assert.equal(run.pids().length, 1, 'the cache answers within 5 minutes');
  await usage.getUsage(undefined, { force: true });
  assert.equal(run.pids().length, 2, 'the ↻ skips the cache');
  await usage.getUsage(undefined, { now: Date.now() + 6 * 60_000 });
  assert.equal(run.pids().length, 3, 'a stale reading is asked again');
  assertCleanedUp(run);
});

test('a failure is cached too, so polling does not start agy every 30 s', { skip: !posix }, async () => {
  const run = scenario('auth');
  const usage = probe();
  const now = Date.now();
  await assert.rejects(usage.getUsage(undefined, { now }), (err: Error) => isUsageNotSignedInError(err));
  await assert.rejects(usage.getUsage(undefined, { now }), (err: Error) => isUsageNotSignedInError(err));
  // Not signed in is kept like a reading (5 min), not like a passing failure (1 min).
  await assert.rejects(usage.getUsage(undefined, { now: now + 2 * 60_000 }), (err: Error) => isUsageNotSignedInError(err));
  assert.equal(run.pids().length, 1);
  await assert.rejects(usage.getUsage(undefined, { force: true }));
  assert.equal(run.pids().length, 2);
});

/* ── The daemon's own path ─────────────────────────────────────────────────── */

test('the gauge reaches the probe through the registry, for Antigravity only', { skip: !posix }, async () => {
  const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
  const { getBackend } = await import('../backends/index.js');
  const { getDialect } = await import('../backends/registry.js');
  assert.equal(typeof getDialect('antigravity')?.accountUsage, 'function');
  assert.equal(getDialect('opencode')?.accountUsage, undefined);
  assert.equal(getDialect('hermes')?.accountUsage, undefined);
  const run = scenario('ok');
  const usage = await getBackend('antigravity').accountUsage!();
  assert.deepEqual(usage, { windows: EXPECTED, extra: null });
  const seen = run.seen();
  assert.equal(seen.AGY_ADC_AUTH, '');
  assert.equal(seen.GEMINI_API_KEY, '');
  assertCleanedUp(run);
});
