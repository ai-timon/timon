// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapCodexEvent } from '../../official-providers/provider-codex/lib/events.js';

test('hides only the model metadata warning of third-party models', () => {
  const events = mapCodexEvent({
    type: 'item.completed',
    item: {
      id: 'warning-1',
      type: 'error',
      message: 'Model metadata for `deepseek-v4-pro` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.',
    },
  });

  assert.deepEqual(events, []);
});

test('keeps the real CLI errors', () => {
  const events = mapCodexEvent({
    type: 'item.completed',
    item: {
      id: 'error-1',
      type: 'error',
      message: 'connection reset by peer',
    },
  });

  assert.equal(events.length, 1);
  assert.match(JSON.stringify(events), /connection reset by peer/);
});

test('a codex reconnect attempt is a provider retry, never a turn end', () => {
  const events = mapCodexEvent({
    type: 'error',
    message: 'Reconnecting... 2/5 (stream disconnected before completion: websocket closed by server before response.completed)',
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'provider_retry');
  assert.deepEqual(events[0].payload, {
    type: 'provider_retry', attempt: 2, max: 5, delay_ms: null, kind: 'transport',
    cause: 'stream disconnected before completion: websocket closed by server before response.completed',
  });
  assert.ok(!events.some((e) => e.type === 'result'));
});

test('codex waiting for the network is a retry with no count', () => {
  const [event] = mapCodexEvent({ type: 'error', message: 'Reconnecting... waiting for network' });
  assert.equal(event.type, 'provider_retry');
  assert.equal(event.payload.attempt, null);
  assert.equal(event.payload.max, null);
  assert.equal(event.payload.cause, 'waiting for network');
});

test('a codex error after its retries still fails the turn', () => {
  const retries = mapCodexEvent({ type: 'error', message: 'Reconnecting... 5/5 (stream disconnected before completion)' });
  assert.equal(retries[0].type, 'provider_retry');
  const failed = mapCodexEvent({ type: 'turn.failed', error: { message: 'stream disconnected before completion' } });
  assert.equal(failed[0].type, 'result');
  assert.equal(failed[0].payload.is_error, true);
  const fatal = mapCodexEvent({ type: 'error', message: 'unexpected status 401 Unauthorized' });
  assert.equal(fatal[0].type, 'result');
});
