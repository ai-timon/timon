/**
 * Final report of a mission WITHOUT a task (`mission_spawn` delegation).
 *
 * Observed 11/09/2026: two delegations returned nothing but
 * `Mission terminée (terminated)` to their parent while the report — several hundred words,
 * `stop_reason: end_turn` — sat in the events table. The report is the newest
 * assistant event holding text: the very last event is a `result`, and the
 * assistant events in between often carry only a `tool_use` block.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-final-text-test-'));

const { dbApi } = await import('./db.js');

function assistant(text: string | null) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: text === null
        ? [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: {} }]
        : [{ type: 'text', text }],
    },
  };
}

function mission(): string {
  const id = randomUUID();
  dbApi.createMission(id, '_main', 'spawn');
  return id;
}

test('the report is the last assistant event carrying text', () => {
  const id = mission();
  dbApi.insertEvent(id, 'assistant', assistant('premier tour'));
  dbApi.insertEvent(id, 'assistant', assistant('Commit `c1f16158` — rapport final'));
  dbApi.insertEvent(id, 'assistant', assistant(null)); // tool_use only
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'success', result: 'ok' });
  assert.equal(dbApi.getMissionFinalText(id), 'Commit `c1f16158` — rapport final');
});

test('a mission killed mid-turn has no report', () => {
  const id = mission();
  dbApi.insertEvent(id, 'assistant', assistant(null));
  dbApi.insertEvent(id, 'assistant', assistant('   '));
  assert.equal(dbApi.getMissionFinalText(id), null);
  assert.equal(dbApi.getMissionFinalText(mission()), null);
});

test('several text blocks of the same turn are joined', () => {
  const id = mission();
  dbApi.insertEvent(id, 'assistant', {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: 'a' }, { type: 'tool_use' }, { type: 'text', text: 'b' }] },
  });
  assert.equal(dbApi.getMissionFinalText(id), 'a\n\nb');
});

test('the scan is bounded: an older report beyond the window is not fetched', () => {
  const id = mission();
  dbApi.insertEvent(id, 'assistant', assistant('trop vieux'));
  for (let i = 0; i < 5; i++) dbApi.insertEvent(id, 'assistant', assistant(null));
  assert.equal(dbApi.getMissionFinalText(id, 3), null);
  assert.equal(dbApi.getMissionFinalText(id, 10), 'trop vieux');
});
