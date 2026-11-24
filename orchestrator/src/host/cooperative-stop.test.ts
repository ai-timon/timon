/**
 * Windows: the service's stop and restart ask the daemon to stop before their
 * forced kills, so the next start reads the previous run as `clean`. Proven
 * here with a recorded network and a recorded executor: the order of the
 * gestures (request, wait, kill), what happens when nothing answers, and that
 * Linux and macOS are left exactly as they were.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  askDaemonToStop, cooperativeStopOf, cooperativeStopWaitMs, COOPERATIVE_STOP_ENV, COOPERATIVE_STOP_WAIT_MS,
  daemonTokenOf, withCooperativeStop, type CooperativeStop, type PidState,
} from './cooperative-stop.js';
import { restartWindowsService, stopService, type ExecResult, type ServiceOpts } from './service-install.js';

const ORIGIN = 'http://127.0.0.1:3100';
const TOKEN = 'witness-daemon-token';

type Net = {
  events: string[];
  fetch: typeof fetch;
  /** Health answers until this many probes have been made; `Infinity` = never leaves. */
  healthAnswers: number;
};

/** A daemon that accepts the stop (or answers `status`) and leaves after `healthAnswers` probes. */
function network(opts: { status?: number; healthAnswers?: number; unreachable?: boolean; body?: unknown } = {}): Net {
  const net: Net = { events: [], healthAnswers: opts.healthAnswers ?? 1, fetch: undefined as unknown as typeof fetch };
  let probes = 0;
  net.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const auth = new Headers(init?.headers).get('authorization');
    if (url.pathname === '/api/daemon/shutdown') {
      net.events.push(`POST shutdown ${auth === `Bearer ${TOKEN}` ? 'with the token' : 'WITHOUT the token'}`);
      if (opts.unreachable) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(opts.body ?? { ok: true, state: 'stopping', pid: 4242 }), { status: opts.status ?? 202 });
    }
    if (url.pathname === '/api/health') {
      probes += 1;
      if (probes <= net.healthAnswers) { net.events.push('health: answers'); return new Response('{}'); }
      net.events.push('health: gone');
      throw new TypeError('fetch failed');
    }
    throw new Error(`unexpected request ${url.pathname}`);
  }) as typeof fetch;
  return net;
}

/** A clock that only moves when the stop sleeps. */
function clock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => { at += ms; } };
}

function ask(net: Net, extra: { probePid?: (pid: number) => PidState; waitMs?: number; token?: string | null; origin?: string } = {}) {
  const c = clock();
  return askDaemonToStop({
    origin: extra.origin ?? ORIGIN,
    readToken: () => (extra.token === undefined ? TOKEN : extra.token),
    fetch: net.fetch,
    probePid: extra.probePid ?? (() => 'gone'),
    waitMs: extra.waitMs ?? 2_000,
    pollMs: 250,
    ...c,
  });
}

test('the daemon is asked with its token, then waited on until it no longer answers', async () => {
  const net = network({ healthAnswers: 2 });
  const res = await ask(net);
  assert.equal(res.outcome, 'stopped');
  assert.deepEqual(net.events, ['POST shutdown with the token', 'health: answers', 'health: answers', 'health: gone']);
});

test('a daemon whose port closed is still waited on while its pid lives', async () => {
  const net = network({ healthAnswers: 0 });
  const states: PidState[] = ['alive', 'alive', 'gone'];
  const seen: number[] = [];
  const res = await ask(net, { probePid: (pid) => { seen.push(pid); return states.shift() ?? 'gone'; } });
  assert.equal(res.outcome, 'stopped');
  assert.deepEqual(seen, [4242, 4242, 4242]);
  // A pid the user's session may not open (the service's, in session 0) does not hold the wait.
  assert.equal((await ask(network({ healthAnswers: 0 }), { probePid: () => 'unknown' })).outcome, 'stopped');
});

test('a daemon still there once the wait is over is left to the forced stop', async () => {
  const net = network({ healthAnswers: Infinity });
  const res = await ask(net, { waitMs: 1_000 });
  assert.equal(res.outcome, 'timeout');
  assert.match(res.line, /still running 1s after the stop request/);
  assert.equal(net.events.filter((e) => e === 'health: answers').length, 5, 'polled every 250 ms for one second');
});

test('nothing answering, or a refusal, means the forced stop at once, without waiting', async () => {
  const gone = network({ unreachable: true });
  assert.equal((await ask(gone)).outcome, 'unreachable');
  assert.deepEqual(gone.events, ['POST shutdown with the token']);
  for (const status of [401, 403, 404, 503]) {
    const net = network({ status });
    const res = await ask(net);
    assert.equal(res.outcome, 'refused', String(status));
    assert.match(res.line, new RegExp(`HTTP ${status}`));
    assert.deepEqual(net.events, ['POST shutdown with the token'], 'no wait on a daemon that did not accept');
  }
});

test('the token never leaves for anything but a local plain-HTTP listener, and never into a line', async () => {
  for (const origin of ['https://127.0.0.1:3100', 'http://example.com:3100', 'http://user:pw@127.0.0.1:3100', 'not a url']) {
    const net = network();
    const res = await ask(net, { origin });
    assert.equal(res.outcome, 'skipped', origin);
    assert.deepEqual(net.events, [], origin);
  }
  const none = network();
  assert.equal((await ask(none, { token: null })).outcome, 'skipped');
  assert.deepEqual(none.events, []);
  const off = network();
  assert.equal((await ask(off, { waitMs: 0 })).outcome, 'skipped');
  assert.deepEqual(off.events, []);
  for (const res of [await ask(network()), await ask(network({ status: 401 })), await ask(network({ healthAnswers: Infinity }))]) {
    assert.doesNotMatch(res.line, new RegExp(TOKEN));
  }
});

test('an answer without a readable pid falls back on the port alone', async () => {
  const net = network({ body: { ok: true, pid: 'nope' }, healthAnswers: 1 });
  let probed = false;
  const res = await ask(net, { probePid: () => { probed = true; return 'alive'; } });
  assert.equal(res.outcome, 'stopped');
  assert.equal(probed, false);
});

test('the wait is configurable, bounded, and 0 turns the request off', () => {
  assert.equal(cooperativeStopWaitMs({}), COOPERATIVE_STOP_WAIT_MS);
  assert.equal(cooperativeStopWaitMs({ [COOPERATIVE_STOP_ENV]: '3000' }), 3_000);
  assert.equal(cooperativeStopWaitMs({ [COOPERATIVE_STOP_ENV]: '0' }), 0);
  assert.equal(cooperativeStopWaitMs({ [COOPERATIVE_STOP_ENV]: '9999999' }), 120_000);
  for (const junk of ['', '-5', '2s', '1e4']) assert.equal(cooperativeStopWaitMs({ [COOPERATIVE_STOP_ENV]: junk }), COOPERATIVE_STOP_WAIT_MS, junk);
});

test('the token is read from the data directory; a mission never sends it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-cooperative-stop-'));
  assert.equal(daemonTokenOf(home), null);
  writeFileSync(join(home, 'daemon-token'), `${TOKEN}\n`);
  assert.equal(daemonTokenOf(home), TOKEN);
  const res = await cooperativeStopOf(ORIGIN, home, { TIMON_MISSION_ID: 'm-1' })();
  assert.equal(res.outcome, 'skipped');
  assert.match(res.line, /inside a mission/);
});

// --- The gestures of the Windows service, with a recorded executor. ---

function transcript(codes: Record<string, number>): string {
  return Object.entries(codes).map(([label, code]) => `TIMON-STEP ${label}=${code}\r\n`).join('');
}

function serviceFixture(
  platform: NodeJS.Platform,
  events: string[],
  opts: { installed?: boolean; elevation?: number; transcript?: string } = {},
): ServiceOpts {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-cooperative-service-'));
  const timonHome = join(homeDir, '.timon');
  mkdirSync(timonHome, { recursive: true });
  return {
    platform, homeDir, timonHome,
    installDir: join(homeDir, 'timon', 'orchestrator'),
    userName: 'tester', uid: 1000, heapMb: 4096, port: 3100, nodePath: 'C:\\Timon\\node.exe',
    exec: (name: string, args: string[]): ExecResult => {
      if (name === 'schtasks' && args[0] === '/Query') {
        events.push('schtasks /Query');
        return opts.installed === false
          ? { code: 1, stdout: '', stderr: 'ERROR: not found' }
          : { code: 0, stdout: 'Status: Running', stderr: '' };
      }
      if (name === 'powershell' && args.join(' ').includes('RunAs')) {
        events.push('elevated batch (schtasks /End, taskkill /F /T)');
        return { code: opts.elevation ?? 0, stdout: '', stderr: '' };
      }
      events.push(`${name} ${args[0] ?? ''}`.trim());
      return { code: 0, stdout: '', stderr: '' };
    },
    readFile: () => opts.transcript ?? '',
  };
}

/** The gestures without the read-only task queries, which the status and the stop each make. */
const gestures = (events: readonly string[]) => events.filter((e) => e !== 'schtasks /Query');

/** The request as `cooperativeStopOf` builds it, on the recorded network. */
function asking(net: Net): () => Promise<CooperativeStop> {
  const c = clock();
  return () => askDaemonToStop({ origin: ORIGIN, readToken: () => TOKEN, fetch: net.fetch, probePid: () => 'gone', waitMs: 2_000, ...c });
}

test('windows stop: the request, the wait, then the elevated batch as the fallback', async () => {
  const net = network({ healthAnswers: 1 });
  const opts = serviceFixture('win32', net.events, { transcript: transcript({ disable: 0, end: 0, stop: 0, sweep: 0 }) });
  const res = await withCooperativeStop(opts, stopService, asking(net));
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(net.events[0], 'schtasks /Query', 'the service is known to be installed before anything is asked');
  assert.deepEqual(gestures(net.events), ['POST shutdown with the token', 'health: answers', 'health: gone', 'elevated batch (schtasks /End, taskkill /F /T)']);
  assert.equal(res.lines[0], 'daemon stopped on request');
});

test('windows restart: the request and the wait come before the batch that runs the task again', async () => {
  const net = network({ healthAnswers: 0 });
  const opts = serviceFixture('win32', net.events, { transcript: transcript({ stop: 0, 'stop-port': 0, sweep: 0, run: 0 }) });
  const res = await withCooperativeStop(opts, restartWindowsService, asking(net));
  assert.equal(res.ok, true, res.reason);
  assert.deepEqual(gestures(net.events), ['POST shutdown with the token', 'health: gone', 'elevated batch (schtasks /End, taskkill /F /T)']);
});

test('windows: a daemon that does not answer is killed at once, as before', async () => {
  const net = network({ unreachable: true });
  const opts = serviceFixture('win32', net.events, { transcript: transcript({ disable: 0, end: 0, stop: 0, sweep: 0 }) });
  const res = await withCooperativeStop(opts, stopService, asking(net));
  assert.equal(res.ok, true);
  assert.deepEqual(gestures(net.events), ['POST shutdown with the token', 'elevated batch (schtasks /End, taskkill /F /T)']);
});

test('windows: no service installed, nothing is asked — the embedded daemon is not the service to stop', async () => {
  const net = network();
  const opts = serviceFixture('win32', net.events, { installed: false });
  const res = await withCooperativeStop(opts, stopService, asking(net));
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /no service installed/);
  assert.equal(net.events.some((e) => e.startsWith('POST')), false, net.events.join('\n'));
});

test('windows: a dry run asks nothing', async () => {
  const net = network();
  const opts = { ...serviceFixture('win32', net.events), dryRun: true };
  await withCooperativeStop(opts, stopService, asking(net));
  assert.equal(net.events.some((e) => e.startsWith('POST')), false);
});

test('windows: elevation refused after the daemon left says what is true', async () => {
  const net = network({ healthAnswers: 0 });
  const opts = serviceFixture('win32', net.events, { elevation: 1223 });
  const res = await withCooperativeStop(opts, stopService, asking(net));
  assert.equal(res.ok, false);
  assert.match(res.reason ?? '', /elevation refused: the daemon stopped, but the TimonOrchestrator task was not changed/);
  // Nothing asked, nothing changed: the usual refusal stands.
  const quiet = network({ unreachable: true });
  const kept = await withCooperativeStop(serviceFixture('win32', quiet.events, { elevation: 1223 }), stopService, asking(quiet));
  assert.match(kept.reason ?? '', /elevation refused.*keep running/);
});

test('linux and macOS: nothing is asked, their stop already sends SIGTERM', async () => {
  for (const platform of ['linux', 'darwin'] as const) {
    let asked = false;
    let gestured = false;
    const opts = serviceFixture(platform, []);
    await withCooperativeStop(opts, () => { gestured = true; return { ok: true, code: 0, lines: [] }; }, async () => {
      asked = true;
      return { outcome: 'stopped', line: '' };
    });
    assert.equal(asked, false, platform);
    assert.equal(gestured, true, platform);
  }
});
