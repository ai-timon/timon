/**
 * Locks the last untested link of text streaming: the sorting of the
 * `event_delta` frames on the browser side. The rest of the chain is already covered
 * on the orchestrator side (dialect parsing + SSE routing); a full diagnostic
 * of 13/08 confirmed that the server, the Next proxy and the deployed bundle
 * do deliver the deltas — this test prevents a silent regression of the
 * last sort, the one that decides to paint or to drop.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyStreamDelta,
  endsStreamingBubble,
  routeStreamDelta,
} from './stream-delta.js';

const MISSION = 'mission-0001';

/** Shortcut: keeps only the accepted actions, otherwise throws. */
function push(frame: unknown, active: string | null = MISSION) {
  const a = routeStreamDelta(frame, active);
  assert.equal(a.kind, 'push', 'frame rejected while it should have passed');
  return a as Extract<typeof a, { kind: 'push' }>;
}

test('a delta of the shown mission is accepted as an append', () => {
  const a = push({
    type: 'assistant_delta',
    missionId: MISSION,
    payload: { text: 'Bonjour', mode: 'append' },
  });
  assert.equal(a.text, 'Bonjour');
  assert.equal(a.mode, 'append');
});

test('a missing or unknown mode falls back to append', () => {
  assert.equal(push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'a' } }).mode, 'append');
  assert.equal(
    push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'a', mode: 'wat' } }).mode,
    'append',
  );
});

test('the replace mode is kept', () => {
  const a = push({
    type: 'assistant_delta',
    missionId: MISSION,
    payload: { text: 'texte complet', mode: 'replace' },
  });
  assert.equal(a.mode, 'replace');
});

test('a delta of another mission is dropped', () => {
  // Visible regression: the text of one conversation showing up in
  // another after a mission change (EventSource replaced, frame in flight).
  const a = routeStreamDelta(
    { type: 'assistant_delta', missionId: 'autre-mission', payload: { text: 'fuite' } },
    MISSION,
  );
  assert.equal(a.kind, 'ignore');
});

test('with no active mission, no delta gets through', () => {
  // The trap the guard must cover: `missionId` missing from the frame AND
  // `activeMissionId` null would compare equal (undefined !== null saves us
  // here, but we anchor it explicitly).
  assert.equal(routeStreamDelta({ type: 'assistant_delta', payload: { text: 'x' } }, null).kind, 'ignore');
  assert.equal(
    routeStreamDelta({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'x' } }, null).kind,
    'ignore',
  );
});

test('only assistant_delta is routed', () => {
  for (const type of ['assistant', 'result', 'user', 'stream_event', undefined]) {
    const a = routeStreamDelta({ type, missionId: MISSION, payload: { text: 'x' } }, MISSION);
    assert.equal(a.kind, 'ignore', `type ${String(type)} must not paint`);
  }
});

test('a payload without usable text is dropped', () => {
  const bad = [
    { text: '' },
    { text: 42 },
    { text: null },
    {},
    null,
    undefined,
  ];
  for (const payload of bad) {
    const a = routeStreamDelta({ type: 'assistant_delta', missionId: MISSION, payload }, MISSION);
    assert.equal(a.kind, 'ignore', `payload ${JSON.stringify(payload)} must not paint`);
  }
});

test('a non-object frame does not crash the sort', () => {
  for (const frame of [null, undefined, 'texte', 42]) {
    assert.equal(routeStreamDelta(frame, MISSION).kind, 'ignore');
  }
});

test('the successive fragments are concatenated in order', () => {
  let buf = '';
  for (const text of ['Bon', 'jour', ' Robin']) {
    buf = applyStreamDelta(buf, push({ type: 'assistant_delta', missionId: MISSION, payload: { text } }));
  }
  assert.equal(buf, 'Bonjour Robin');
});

test('a replace fragment overwrites the buffer instead of being appended', () => {
  const buf = applyStreamDelta(
    'partiel',
    push({ type: 'assistant_delta', missionId: MISSION, payload: { text: 'complet', mode: 'replace' } }),
  );
  assert.equal(buf, 'complet');
});

test('the persisted events that close the provisional bubble', () => {
  // Without this reset, the full text of the `assistant` message would show
  // twice (final bubble + fragment left on screen).
  for (const t of ['assistant', 'result', 'user']) {
    assert.equal(endsStreamingBubble(t), true, `${t} must empty the buffer`);
  }
  // These must NOT empty it: they arrive in the middle of a turn and the
  // current buffer must survive.
  for (const t of ['system', 'tool_use', 'permission_request', undefined, null]) {
    assert.equal(endsStreamingBubble(t), false, `${String(t)} must not empty the buffer`);
  }
});
