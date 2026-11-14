/**
 * The codex cut of a chat rewind (docs/specs/rewind.md, "Provider session cut"): through the daemon's
 * `nativeRewindStrategy('codex')`, an ephemeral `codex app-server` is asked for the thread's turns and
 * forks it at the last kept one. The app-server is a recorded stand-in answering the JSON-RPC lines
 * codex-cli 0.169.0 answers; every failure must throw (the daemon then goes to summary mode) and the
 * process must be stopped whatever happens.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// The profile exists only when its CLI is found: a stand-in file is enough, nothing here executes it.
const BIN = mkdtempSync(join(tmpdir(), 'timon-codex-bin-'));
writeFileSync(join(BIN, 'codex'), '', { mode: 0o755 });
process.env.PATH = `${BIN}${delimiter}${process.env.PATH ?? ''}`;
process.on('exit', () => rmSync(BIN, { recursive: true, force: true }));

const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
const { getHost } = await import('../host/index.js');
const { nativeRewindStrategy } = await import('../backends/index.js');
const { missionScratchPath } = await import('../backends/provider-scratch.js');

assert.ok((await mountOfficialProviders()).includes('provider-codex'));

const THREAD = '01a1c252-372a-7560-aabb-e988f22f9b1f';
const FORK = '01a1c260-0000-7000-8000-000000000001';

type Request = { id?: number; method: string; params?: Record<string, unknown> };
type Answer = (req: Request) => Record<string, unknown> | null;

/** A `codex app-server` stand-in: each request line gets what `answer` returns (null = no reply). */
function fakeAppServer(answer: Answer) {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams & { stopped: boolean };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stopped = false;
  child.kill = (() => {
    if (child.stopped) return true;
    child.stopped = true;
    setImmediate(() => child.emit('exit', null, 'SIGTERM'));
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  const requests: Request[] = [];
  let buffer = '';
  child.stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const req = JSON.parse(buffer.slice(0, at)) as Request;
      buffer = buffer.slice(at + 1);
      requests.push(req);
      const reply = answer(req);
      if (reply) child.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  });
  return { child, requests };
}

/** Runs `run` with a host whose spawns are answered by a fake app-server. */
async function withAppServer<T>(answer: Answer, run: () => Promise<T>) {
  const host = getHost();
  const original = host.spawn;
  const fake = fakeAppServer(answer);
  const spawns: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  host.spawn = ((_cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    spawns.push({ args, env: opts?.env ?? {} });
    return fake.child;
  }) as typeof host.spawn;
  try {
    const outcome = await run().then((value) => ({ value }), (error: Error) => ({ error }));
    return { ...outcome, ...fake, spawns };
  } finally {
    host.spawn = original;
  }
}

const turn = (id: string, text: string) => ({
  id, status: 'completed', itemsView: 'full',
  items: [{ type: 'userMessage', id: `${id}-u`, content: [{ type: 'text', text, text_elements: [] }] }, { type: 'agentMessage', id: `${id}-a`, text: 'ok' }],
});

/** What codex-cli 0.169.0 answers, page size 1 so the cursor is followed. */
function recorded(overrides: Partial<Record<string, Answer>> = {}): Answer {
  const turns = [turn('t1', '# Instructions\nBe brief.\n\n# Task\nhello'), turn('t2', 'second'), turn('t3', 'third')];
  return (req) => {
    const own = overrides[req.method];
    if (own) return own(req);
    if (req.id === undefined) return null;
    switch (req.method) {
      case 'initialize':
        return { id: req.id, result: { userAgent: 'timon/0.169.0', codexHome: '<home>', platformFamily: 'unix', platformOs: 'macos' } };
      case 'thread/turns/list': {
        const from = req.params?.cursor ? Number(req.params.cursor) : 0;
        return { id: req.id, result: { data: turns.slice(from, from + 1), nextCursor: from + 1 < turns.length ? String(from + 1) : null, backwardsCursor: null } };
      }
      case 'thread/fork':
        return { id: req.id, result: { thread: { id: FORK, turns: [] } } };
      default:
        return { error: { code: -32600, message: `Invalid request: unknown variant \`${req.method}\`` } };
    }
  };
}

let seq = 0;
function mission(): { missionId: string; home: string } {
  const missionId = `rewind-codex-${++seq}`;
  const home = missionScratchPath('provider-codex', missionId);
  mkdirSync(home, { recursive: true });
  return { missionId, home };
}

const user = (id: number, text: string) => ({ id, type: 'user', payload: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } }) });
const init = (id: number, sessionId: string) => ({ id, type: 'system', payload: JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId }) });
const toolResult = (id: number) => ({ id, type: 'user', payload: JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'out' }] } }) });
const result = (id: number) => ({ id, type: 'result', payload: '{"type":"result"}' });
/** The thread after a rewind to "third": two kept turns, the codex thread opened by the first. */
const KEPT = [user(1, 'hello'), init(2, THREAD), toolResult(3), result(4), user(5, 'second'), init(6, THREAD), result(7)];

test('codex forks its thread at the last kept turn, with the mission CODEX_HOME, and stops the app-server', async () => {
  const rewind = nativeRewindStrategy('codex');
  assert.ok(rewind, 'codex declares a native rewind');
  const { missionId, home } = mission();
  const run = await withAppServer(recorded(), () => rewind({ missionId, sessionId: THREAD, events: KEPT }));
  assert.ok(!('error' in run), `no failure: ${'error' in run ? run.error.message : ''}`);
  assert.deepEqual(run.value, { resume: FORK }, 'the next turn resumes the fork');
  assert.deepEqual(run.spawns.map((s) => s.args), [['app-server']]);
  assert.equal(run.spawns[0]!.env.CODEX_HOME, home, 'the per-mission store');
  assert.deepEqual(run.requests.map((r) => r.method), ['initialize', 'initialized', 'thread/turns/list', 'thread/turns/list', 'thread/fork']);
  assert.deepEqual(run.requests[2]!.params, { threadId: THREAD, sortDirection: 'asc', itemsView: 'full', limit: 100, cursor: null });
  assert.equal(run.requests[3]!.params?.cursor, '1', 'the cursor is followed');
  assert.deepEqual(run.requests[4]!.params, { threadId: THREAD, lastTurnId: 't2' }, 'persisted fork through the kept turn, not a revert');
  assert.equal(run.child.stopped, true, 'the app-server is stopped');
});

test('a turn whose text is not the last kept message throws (summary mode), no fork', async () => {
  const rewind = nativeRewindStrategy('codex')!;
  const { missionId } = mission();
  const events = [...KEPT.slice(0, 4), user(5, 'something else'), result(6)];
  const run = await withAppServer(recorded(), () => rewind({ missionId, sessionId: THREAD, events }));
  assert.ok('error' in run);
  assert.match(run.error.message, /does not hold the last kept message/);
  assert.ok(!run.requests.some((r) => r.method === 'thread/fork'));
  assert.equal(run.child.stopped, true);
});

test('a missing method (an unknown variant answered without id) throws, and the app-server is stopped', async () => {
  const rewind = nativeRewindStrategy('codex')!;
  const { missionId } = mission();
  const missing: Answer = (req) => ({ error: { code: -32600, message: `Invalid request: unknown variant \`${req.method}\`` } });
  const run = await withAppServer(recorded({ 'thread/fork': missing }), () => rewind({ missionId, sessionId: THREAD, events: KEPT }));
  assert.ok('error' in run);
  assert.match(run.error.message, /unknown variant `thread\/fork`/);
  assert.equal(run.child.stopped, true);
});

test('fewer turns in the thread than kept messages throws', async () => {
  const rewind = nativeRewindStrategy('codex')!;
  const { missionId } = mission();
  const events = [...KEPT, user(8, 'third'), result(9), user(10, 'fourth'), result(11)];
  const run = await withAppServer(recorded(), () => rewind({ missionId, sessionId: THREAD, events }));
  assert.ok('error' in run);
  assert.match(run.error.message, /the thread has 3 turns, the chat kept 4 messages/);
});

test('a rewind to the first message starts a fresh thread, without any process', async () => {
  const rewind = nativeRewindStrategy('codex')!;
  const { missionId } = mission();
  const run = await withAppServer(recorded(), () => rewind({ missionId, sessionId: THREAD, events: [] }));
  assert.deepEqual('value' in run && run.value, { resume: null });
  assert.equal(run.spawns.length, 0);
});

test('a thread opened in the cut part, or a mission without its folder, throws before any process', async () => {
  const rewind = nativeRewindStrategy('codex')!;
  const { missionId } = mission();
  const other = await withAppServer(recorded(), () => rewind({ missionId, sessionId: 'another-thread', events: KEPT }));
  assert.ok('error' in other);
  assert.match(other.error.message, /started after the cut/);
  const homeless = await withAppServer(recorded(), () => rewind({ missionId: 'rewind-codex-nohome', sessionId: THREAD, events: KEPT }));
  assert.ok('error' in homeless);
  assert.match(homeless.error.message, /no CODEX_HOME/);
  assert.equal(other.spawns.length + homeless.spawns.length, 0);
});
