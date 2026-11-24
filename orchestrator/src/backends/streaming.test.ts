/**
 * Streaming of the partial text of an agent answer.
 *
 * Two invariants, in this order of importance:
 *
 *  1. NOTHING SUPERFLUOUS COMES OUT OF parseLine. `--include-partial-messages`
 *     adds to the claude stream one `stream_event` line per fragment AND per
 *     block transition. Since `processEvent` persists everything that is not
 *     a delta, letting even the `message_start` through would
 *     write thousands of rows per turn into the `events` table.
 *  2. The only type that comes out is `assistant_delta`, with the `mode` that
 *     matches the way the CLI emits (claude: increments → append).
 *
 * The JSON shapes tested here are those really observed on claude-code
 * 2.1.228 and codex-cli 0.147.0, not assumed shapes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { removeHomeOnExit } from '../../tests/helpers/test-home.js';

/* Throwaway TIMON_HOME, set before importing the registry (paths.js reads the env on
   load) → dynamic import required. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-streaming-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.CODEX_AUTH_DIR = join(TMP_HOME, 'codex-auth');
removeHomeOnExit(TMP_HOME);

const { getBackend, ASSISTANT_DELTA } = await import('./index.js');
const { mountOfficialProviders, buildUnderSeal } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
type AgentConfig = import('../agent.js').AgentConfig;
type AssistantDeltaPayload = import('./types.js').AssistantDeltaPayload;

const claude = getBackend('claude');
const codex = getBackend('codex');

function spawnOpts(model: string) {
  const cfg: AgentConfig = { cwd: TMP_HOME, model, permission_mode: 'auto' };
  return {
    agentName: 'TIMON.streaming',
    systemPrompt: 'sp',
    message: 'salut',
    resumeSession: null,
    cfg,
    missionId: 'mission-streaming-0001',
  };
}

/** `stream_event` envelope as the CLI writes it (plumbing fields
 *  left out: parseLine does not look at them). */
function streamEvent(event: unknown): string {
  return JSON.stringify({
    type: 'stream_event',
    event,
    session_id: 'sess-1',
    parent_tool_use_id: null,
    uuid: 'u-1',
  });
}

/* ── claude ─────────────────────────────────────────────────────────────── */

test('[claude] buildSpawn active --include-partial-messages', async () => {
  const sp = await buildUnderSeal('claude', spawnOpts('opus'));
  assert.ok(
    sp.args.includes('--include-partial-messages'),
    'without this flag the CLI emits no partial text: no streaming at all',
  );
  // The flag only has an effect in stream-json: if it disappeared, the flag would
  // be silently inoperative rather than in error.
  const i = sp.args.indexOf('--output-format');
  assert.equal(sp.args[i + 1], 'stream-json');
});

test('[claude] un text_delta devient un assistant_delta en mode append', () => {
  const evs = claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'onjour ! 👋' },
  }));
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, ASSISTANT_DELTA);
  // The CLI emits INCREMENTS ("B" then "onjour ! …"): concatenate, do not
  // replace, otherwise the bubble would only show the last fragment.
  assert.deepEqual(evs[0]!.payload as AssistantDeltaPayload, {
    text: 'onjour ! 👋',
    mode: 'append',
  });
});

test('[claude] thinking_delta and input_json_delta are ignored', () => {
  // We do not stream the reasoning, and the arguments of a half-serialised
  // tool_use mean nothing in a chat bubble.
  assert.deepEqual(claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'thinking_delta', thinking: 'hmm' },
  })), []);
  assert.deepEqual(claude.parseLine(streamEvent({
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"comm' },
  })), []);
});

test('[claude] the stream_event plumbing produces no event', () => {
  // These lines did not exist before the flag. If one of them came out,
  // processEvent would write it to the database one by one.
  const noise: unknown[] = [
    { type: 'message_start', message: { id: 'msg_1', role: 'assistant', content: [] } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    { type: 'message_stop' },
  ];
  for (const event of noise) {
    assert.deepEqual(claude.parseLine(streamEvent(event)), [], JSON.stringify(event));
  }
});

test('[claude] a malformed stream_event does not bring the parsing down', () => {
  for (const event of [null, 'texte', 42, {}, { type: 'content_block_delta' },
    { type: 'content_block_delta', delta: null },
    { type: 'content_block_delta', delta: { type: 'text_delta' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 123 } },
    // An empty fragment would say nothing to the UI and trigger a render for nothing.
    { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } }]) {
    assert.deepEqual(claude.parseLine(streamEvent(event)), [], JSON.stringify(event));
  }
  assert.deepEqual(claude.parseLine('{"type":"stream_event"}'), []);
});

test('[claude] the full assistant message still goes through', () => {
  // It is the only persisted source: streaming must not short-circuit it.
  const line = JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'text', text: 'Bonjour !' }] },
  });
  const evs = claude.parseLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, 'assistant');
});

/* ── codex ──────────────────────────────────────────────────────────────── */

test('[codex] no partials: item.started/item.updated stay dropped', () => {
  // Empirical finding on codex-cli 0.147.0: `codex exec --json` produces
  // NO item.started/item.updated; the stream goes from turn.started to
  // item.completed in one block. This test locks the absence of streaming on the
  // codex side (documented, not suffered); it will fall the day these
  // events are mapped, which will force rechecking whether `text` is cumulative or incremental.
  const started = JSON.stringify({
    type: 'item.started',
    item: { id: 'item_0', type: 'agent_message', text: 'Bon' },
  });
  const updated = JSON.stringify({
    type: 'item.updated',
    item: { id: 'item_0', type: 'agent_message', text: 'Bonjour' },
  });
  assert.deepEqual(codex.parseLine(started), []);
  assert.deepEqual(codex.parseLine(updated), []);
});

test('[codex] item.completed still produces the full assistant message', () => {
  const line = JSON.stringify({
    type: 'item.completed',
    item: { id: 'item_0', type: 'agent_message', text: 'Bonjour !' },
  });
  const evs = codex.parseLine(line);
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.type, 'assistant');
});

/* ── contrat de non-persistance ─────────────────────────────────────────── */

test('an assistant_delta looks like no persisted type', () => {
  // `processEvent` (agent.ts) short-circuits EXACTLY this type before
  // insertEvent/appendAgentLog. The test cannot run it without mounting a
  // full RunningAgent (process, DB, mission); it at least locks the
  // name of the type, which is the only link between the dialect and the branch.
  assert.equal(ASSISTANT_DELTA, 'assistant_delta');
  for (const persisted of ['assistant', 'user', 'system', 'result']) {
    assert.notEqual(ASSISTANT_DELTA, persisted);
  }
});
