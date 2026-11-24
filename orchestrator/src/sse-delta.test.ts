/**
 * SSE routing of text deltas.
 *
 * `sseHandler` did not need changing for streaming: the dedup
 * (`seen` / `replayHighWater`) is guarded by `ev.kind === 'event'`, so an
 * `event_delta` falls straight on `writeEvent`. This test locks this
 * edge behaviour: if someone widened the guard to all kinds,
 * the deltas would enter `seen` (unbounded growth: a 3 min turn
 * produces thousands of them) and would be deduplicated against each other, since they
 * have no timestamp.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';

const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-sse-delta-'));
process.env.TIMON_HOME = TMP_HOME;
removeHomeOnExit(TMP_HOME);

const { sseHandler } = await import('./sse.js');
const { bus } = await import('./bus.js');

const MISSION = 'mission-sse-delta-0001';

/** A fake req/res pair: only what goes on the wire is kept. */
function fakeStream(missionId: string): { chunks: string[]; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId } });
  sseHandler(req, res);
  return { chunks, close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

test('an event_delta is written on the SSE wire of its mission', () => {
  const s = fakeStream(MISSION);
  bus.publish({
    kind: 'event_delta',
    missionId: MISSION,
    type: 'assistant_delta',
    payload: { text: 'Bon', mode: 'append' },
  });
  const wire = s.chunks.join('');
  assert.ok(wire.includes('event: event_delta\n'), 'kind absent du fil');
  assert.ok(wire.includes('"text":"Bon"'), 'payload absent du fil');
  s.close();
});

test('two identical deltas both go through (no dedup)', () => {
  // Without a timestamp, two identical fragments ("le", "le") would have the same
  // dedup key: swallowing them would eat text of the answer.
  const s = fakeStream(MISSION);
  const before = s.chunks.length;
  for (let i = 0; i < 2; i++) {
    bus.publish({
      kind: 'event_delta',
      missionId: MISSION,
      type: 'assistant_delta',
      payload: { text: 'le ', mode: 'append' },
    });
  }
  const written = s.chunks.slice(before).join('');
  assert.equal(written.split('event: event_delta').length - 1, 2);
  s.close();
});

test('the global stream receives no delta', () => {
  // `/api/stream` feeds the events page and the notifications column:
  // none of them shows partial text, but all would pay for the throughput.
  const globalStream = fakeStream('');
  const before = globalStream.chunks.length;
  bus.publish({
    kind: 'event_delta',
    missionId: MISSION,
    type: 'assistant_delta',
    payload: { text: 'nope', mode: 'append' },
  });
  assert.equal(globalStream.chunks.slice(before).join(''), '');
  globalStream.close();
});

test('a delta from another mission does not cross the filter', () => {
  const s = fakeStream(MISSION);
  const before = s.chunks.length;
  bus.publish({
    kind: 'event_delta',
    missionId: 'une-autre-mission',
    type: 'assistant_delta',
    payload: { text: 'nope', mode: 'append' },
  });
  assert.equal(s.chunks.slice(before).join(''), '');
  s.close();
});
