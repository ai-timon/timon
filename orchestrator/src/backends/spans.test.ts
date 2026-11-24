/**
 * Phase W.1 — span normalisation of the stream-json vocabulary
 * (docs/PRD-WORKFLOWS.md §4.1), against real fixtures.
 *
 * `node --test --import tsx src/backends/spans.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-spans-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
removeHomeOnExit(TMP_HOME);

const { getBackend } = await import('./index.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const { streamJsonSpans, spanPayload, TRUNCATION_MARK } = await import('./stream-json-spans.js');
const { setRedactionSource } = await import('../secrets/redact.js');
type SpanState = import('./types.js').SpanState;
type SpanOp = import('./types.js').SpanOp;
type OpenOp = Extract<SpanOp, { op: 'open' }>;
type CloseOp = Extract<SpanOp, { op: 'close' }>;

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__');

function fixtureLines(name: string): string[] {
  return readFileSync(join(FIXTURES, name), 'utf8').split('\n').filter((l) => l.trim());
}

function freshState(maxBytes = 4096): SpanState {
  return { missionId: 'm-1', traceId: 't-1', turn: null, tools: new Map(), maxBytes };
}

/** Feed a fixture through the real dialect (`parseLine` → `spans`), one
 *  events.id per persisted line, exactly as `processEvent` does. */
function replay(backendName: string, fixture: string, state: SpanState): SpanOp[] {
  const backend = getBackend(backendName);
  assert.ok(backend.spans, `${backendName} exposes spans()`);
  const ops: SpanOp[] = [];
  let eventId = 100;
  for (const line of fixtureLines(fixture)) {
    for (const ev of backend.parseLine(line)) {
      if (ev.type === 'assistant_delta') continue;
      eventId += 1;
      ops.push(...backend.spans(ev, state, eventId));
    }
  }
  return ops;
}

const opens = (ops: SpanOp[]): OpenOp[] => ops.filter((o): o is OpenOp => o.op === 'open');
const closes = (ops: SpanOp[]): CloseOp[] => ops.filter((o): o is CloseOp => o.op === 'close');

test('claude: assistant(tool_use ×2) → user(tool_result ×2) → assistant → result = 1 turn + 2 tools closed', () => {
  const state = freshState();
  const ops = replay('claude', 'claude-tools.jsonl', state);

  const turns = opens(ops).filter((o) => o.kind === 'turn');
  const tools = opens(ops).filter((o) => o.kind === 'tool');
  const thinking = opens(ops).filter((o) => o.kind === 'thinking');
  assert.equal(turns.length, 1, 'one turn: the second assistant does not reopen it');
  assert.equal(tools.length, 2);
  assert.equal(thinking.length, 1);

  const [turn] = turns;
  assert.equal(turn.name, 'turn');
  assert.equal(turn.trace_id, 't-1');
  assert.equal(turn.mission_id, 'm-1');
  assert.equal(turn.seq, 102, 'seq = events.id of the first assistant line');
  assert.equal(turn.status, undefined, 'a turn opens running');

  assert.deepEqual(tools.map((t) => [t.id, t.name, t.parent_span_id]), [
    ['toolu_01ReadA', 'Read', turn.id],
    ['toolu_02Bash', 'Bash', turn.id],
  ]);
  assert.match(tools[0].input ?? '', /src\/a\.ts/);

  // thinking is instantaneous, inside the turn, tokens estimated
  assert.equal(thinking[0].status, 'ok');
  assert.equal(thinking[0].parent_span_id, turn.id);
  assert.deepEqual(JSON.parse(thinking[0].output ?? '{}'), { tokens: 13 });

  const toolCloses = closes(ops).filter((c) => c.id.startsWith('toolu_'));
  assert.deepEqual(toolCloses.map((c) => [c.id, c.status, c.event_id_end]), [
    ['toolu_01ReadA', 'ok', 103],
    ['toolu_02Bash', 'ok', 103],
  ]);
  assert.match(toolCloses[0].output ?? '', /export const a = 1/);
  for (const c of toolCloses) {
    assert.ok(typeof c.ended_at === 'number' && c.ended_at >= tools[0].started_at, 'duration is computable');
  }

  const turnClose = closes(ops).find((c) => c.id === turn.id);
  assert.ok(turnClose, 'the result closes the turn');
  assert.equal(turnClose.status, 'ok');
  assert.equal(turnClose.tokens_in, 5310);
  assert.equal(turnClose.tokens_out, 118);
  assert.equal(turnClose.cost_usd, 0);
  assert.equal(turnClose.event_id_end, 105);
  assert.deepEqual(JSON.parse(turnClose.output ?? '{}'), {
    subtype: 'success', stop_reason: null, num_turns: 3, duration_api_ms: 6120,
  });

  // the state is clean between two turns
  assert.equal(state.turn, null);
  assert.equal(state.tools.size, 0);
});

test('grok: same vocabulary, same spans (stream_event deltas never reach spans())', () => {
  const state = freshState();
  const ops = replay('grok', 'grok.jsonl', state);
  const turn = opens(ops).find((o) => o.kind === 'turn');
  assert.ok(turn);
  const tools = opens(ops).filter((o) => o.kind === 'tool');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'read_file');
  assert.equal(tools[0].id, 'call-ccdab9dc-0');
  const toolClose = closes(ops).find((c) => c.id === 'call-ccdab9dc-0');
  assert.equal(toolClose?.status, 'ok');
  const turnClose = closes(ops).find((c) => c.id === turn.id);
  assert.ok(turnClose);
  assert.equal(typeof turnClose.tokens_in, 'number');
  assert.equal(state.turn, null);
});

test('codex: completed command, MCP and function items become closed tool spans', () => {
  const state = freshState();
  const ops = replay('codex', 'codex.jsonl', state);
  const tools = opens(ops).filter((o) => o.kind === 'tool');
  const toolCloses = closes(ops).filter((o) => tools.some((tool) => tool.id === o.id));
  assert.ok(tools.length > 0, 'the fixture contains completed Codex tool items');
  assert.equal(toolCloses.length, tools.length, 'every completed item closes in the same tick');
  assert.ok(toolCloses.every((o) => o.status === 'ok' || o.status === 'error'));
  const turn = opens(ops).find((o) => o.kind === 'turn');
  assert.ok(turn, 'a Codex turn opens from the first normalized assistant item');
  const close = closes(ops).find((o) => o.id === turn.id);
  assert.equal(close?.status, 'ok');
  assert.equal(typeof close?.tokens_in, 'number');
  assert.equal(typeof close?.tokens_out, 'number');
  assert.equal(state.turn, null);
});

test('tool_result with is_error closes the tool span in error, with the message', () => {
  const state = freshState();
  const t0 = state;
  streamJsonSpans({ type: 'assistant', payload: { message: { content: [
    { type: 'tool_use', id: 'toolu_err', name: 'Bash', input: { command: 'false' } },
  ] } } }, t0, 1);
  const ops = streamJsonSpans({ type: 'user', payload: { message: { content: [
    { type: 'tool_result', tool_use_id: 'toolu_err', content: 'exit 1', is_error: true },
  ] } } }, t0, 2);
  assert.deepEqual(ops.map((o) => o.op), ['close']);
  const c = ops[0] as CloseOp;
  assert.equal(c.status, 'error');
  assert.equal(c.error, 'exit 1');
  assert.equal(state.tools.size, 0);
});

test('a tool still open at result is closed as interrupted, and the turn closes in error on is_error', () => {
  const state = freshState();
  streamJsonSpans({ type: 'assistant', payload: { message: { content: [
    { type: 'tool_use', id: 'toolu_lost', name: 'Edit', input: {} },
  ] } } }, state, 1);
  const ops = streamJsonSpans({ type: 'result', payload: {
    subtype: 'error_during_execution', is_error: true, result: 'boom', usage: { input_tokens: 1, output_tokens: 2 },
  } }, state, 2);
  const byId = new Map(closes(ops).map((c) => [c.id, c]));
  assert.equal(byId.get('toolu_lost')?.status, 'interrupted');
  const turn = [...byId.values()].find((c) => c.id !== 'toolu_lost');
  assert.equal(turn?.status, 'error');
  assert.equal(turn?.error, 'boom');
  assert.equal(state.turn, null);
  assert.equal(state.tools.size, 0);
});

test('system/thinking_tokens yields an instantaneous thinking span with the reported count', () => {
  const state = freshState();
  const ops = streamJsonSpans({ type: 'system', payload: { subtype: 'thinking_tokens', thinking_tokens: 42 } }, state, 7);
  assert.equal(ops.length, 1);
  const o = ops[0] as OpenOp;
  assert.equal(o.kind, 'thinking');
  assert.equal(o.status, 'ok');
  assert.equal(o.parent_span_id, null, 'no turn open → no parent');
  assert.deepEqual(JSON.parse(o.output ?? ''), { tokens: 42 });
});

test('secrets from the vault are masked in input and output before storage', () => {
  const previous = setRedactionSource(() => ['sk-live-0123456789abcdef']);
  try {
    const state = freshState();
    const ops = replay('claude', 'claude-tools.jsonl', state);
    const bash = opens(ops).find((o) => o.id === 'toolu_02Bash');
    const bashResult = closes(ops).find((c) => c.id === 'toolu_02Bash');
    assert.ok(bash && bashResult);
    assert.ok(!(bashResult.output ?? '').includes('sk-live-'), 'tool output is redacted');
    assert.match(bashResult.output ?? '', /\*\*\*/);
    // the same value passed as an argument is masked too
    const st2 = freshState();
    const [open] = streamJsonSpans({ type: 'assistant', payload: { message: { content: [
      { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: { command: 'echo sk-live-0123456789abcdef' } },
    ] } } }, st2, 1).filter((o) => o.op === 'open' && (o as OpenOp).kind === 'tool') as OpenOp[];
    assert.equal(open.input, '{"command":"echo ***"}');
  } finally {
    setRedactionSource(previous);
  }
});

test('input / output are cut to state.maxBytes and flagged as truncated', () => {
  const big = 'x'.repeat(10_000);
  const out = spanPayload({ text: big }, 64);
  assert.ok(out && out.endsWith(TRUNCATION_MARK));
  assert.ok(Buffer.byteLength(out.slice(0, -TRUNCATION_MARK.length), 'utf8') <= 64);
  // multi-byte text respects the BYTE budget, not the character count
  const accented = 'é'.repeat(100); // french-ok: a two-byte letter
  const cut = spanPayload(accented, 50);
  assert.ok(cut && Buffer.byteLength(cut.slice(0, -TRUNCATION_MARK.length), 'utf8') <= 50);
  assert.equal(spanPayload(null, 10), null);
});

test('unexpected payloads yield no ops and never throw', () => {
  const state = freshState();
  assert.deepEqual(streamJsonSpans({ type: 'assistant', payload: null }, state, 1), []);
  assert.deepEqual(streamJsonSpans({ type: 'assistant', payload: { message: { content: 'plain' } } }, state, 2).length, 1, 'a text-only assistant still opens the turn');
  assert.deepEqual(streamJsonSpans({ type: 'user', payload: { message: { content: 'human turn' } } }, state, 3), []);
  assert.deepEqual(streamJsonSpans({ type: 'rate_limit_event', payload: { foo: 1 } }, state, 4), []);
  assert.deepEqual(streamJsonSpans({ type: 'system', payload: { subtype: 'init' } }, state, 5), []);
});
