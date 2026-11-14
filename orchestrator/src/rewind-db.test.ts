/**
 * Rewind, database side (docs/specs/rewind.md § 9-10): a rewind hides the rows
 * it cuts from every thread reader, never deletes them, takes them out of the
 * search index, and leaves the money spent and the mission stats alone.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-rewind-db-'));
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { db, dbApi } = await import('./db.js');
const { renderTranscript } = await import('./summary.js');

const user = (text: string) => ({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text: string) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } });

function seed(): { mission: string; ids: number[] } {
  const mission = randomUUID();
  dbApi.createMission(mission, 'agent-rewind', 'rewind fixture');
  const ids = [
    dbApi.insertEvent(mission, 'user', user('first question alpha')).id,
    dbApi.insertEvent(mission, 'assistant', assistant('first answer bravo')).id,
    dbApi.insertEvent(mission, 'user', user('second question charlie')).id,
    dbApi.insertEvent(mission, 'assistant', assistant('second answer delta')).id,
  ];
  return { mission, ids };
}

const hits = (q: string, mission: string) => dbApi.searchMissions({ q }).filter((h) => h.mission_id === mission).length;
const statsCount = (mission: string) =>
  (db.prepare('SELECT event_count FROM mission_stats WHERE mission_id = ?').get(mission) as { event_count: number }).event_count;

test('rewound rows leave every thread reader, stay stored, and leave search', () => {
  const { mission, ids } = seed();
  dbApi.updateMissionUsage(mission, 1.25, 100, 50);
  assert.equal(hits('charlie', mission), 1);
  const countBefore = statsCount(mission);

  const rewindId = dbApi.rewindMission(mission, ids[2]!);

  const visible = [ids[0], ids[1], rewindId];
  assert.deepEqual(dbApi.listEvents(mission).map((e) => e.id), visible);
  assert.deepEqual(dbApi.listChatEvents(mission).map((e) => e.id), visible);
  assert.deepEqual(dbApi.listEventsTail(mission, 10).map((e) => e.id), visible);
  const scanned = dbApi.scanMissionEvents(mission, { where: '1=1', order: 'ASC' }) as { id: number }[];
  assert.deepEqual(scanned.map((e) => e.id), visible);
  assert.equal(dbApi.listEvents(mission).at(-1)!.type, 'rewind');

  const transcript = renderTranscript(dbApi.listEvents(mission));
  assert.match(transcript, /alpha/);
  assert.doesNotMatch(transcript, /charlie|delta/);

  assert.equal(hits('charlie', mission), 0);
  assert.equal(hits('delta', mission), 0);
  assert.equal(hits('alpha', mission), 1);

  const stored = db.prepare('SELECT id, rewound_by FROM events WHERE mission_id = ? ORDER BY id').all(mission) as { id: number; rewound_by: number | null }[];
  assert.deepEqual(stored.map((r) => r.rewound_by), [null, null, rewindId, rewindId, null], 'hidden, never deleted');

  assert.equal(dbApi.getMission(mission)!.total_cost_usd, 1.25, 'money spent stays');
  assert.equal(statsCount(mission), countBefore + 1, 'only the rewind event is counted');

  // The search catch-up must not bring the cut rows back.
  db.prepare(`UPDATE mission_search_state SET v = 0 WHERE k = 'event_cursor'`).run();
  while (!dbApi.reindexMissionSearch(5000).done) { /* drain */ }
  assert.equal(hits('charlie', mission), 0);
});

test('rewinding further back moves the pointer and hides the earlier rewind', () => {
  const { mission, ids } = seed();
  const first = dbApi.rewindMission(mission, ids[2]!);
  const second = dbApi.rewindMission(mission, ids[0]!);
  assert.deepEqual(dbApi.listEvents(mission).map((e) => e.id), [second]);
  const stored = db.prepare('SELECT id, rewound_by FROM events WHERE mission_id = ? ORDER BY id').all(mission) as { id: number; rewound_by: number | null }[];
  assert.deepEqual(stored.map((r) => r.rewound_by), [second, second, first, first, second, null]);
  assert.equal(hits('alpha', mission), 0);
});

test('trace listing drops the spans of a rewound turn, its cost stays in the aggregates', () => {
  const { mission, ids } = seed();
  const span = (id: string, eventId: number) => ({
    op: 'open' as const, id, trace_id: mission, mission_id: mission, workflow_run_id: null, seq: eventId,
    kind: 'tool' as const, name: 'Read', started_at: eventId, status: 'ok' as const, ended_at: eventId + 1, duration_ms: 1,
    cost_usd: 0.5, event_id_start: eventId,
  });
  dbApi.upsertSpans([span(`kept-${mission}`, ids[1]!), span(`cut-${mission}`, ids[3]!)]);
  dbApi.rewindMission(mission, ids[2]!);
  const view = dbApi.summarizeTraceSpans(mission, [mission], { limit: 50, payload: false });
  assert.deepEqual(view.spans.map((s) => s.id), [`kept-${mission}`]);
  assert.equal(view.aggregates.cost_usd, 1);
});

test('an archived thread is cut too', async () => {
  const { attachEventsArchive } = await import('./db.js');
  attachEventsArchive(join(process.env.TIMON_HOME!, 'archive-events.db'));
  const { mission, ids } = seed();
  const move = db.transaction(() => {
    db.exec(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload, rewound_by)
             SELECT id, mission_id, type, timestamp, payload, rewound_by FROM events WHERE id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`);
    db.exec(`DELETE FROM events WHERE id IN (${ids[0]}, ${ids[1]}, ${ids[2]})`);
  });
  move();
  const rewindId = dbApi.rewindMission(mission, ids[1]!);
  assert.deepEqual(dbApi.listEvents(mission).map((e) => e.id), [ids[0], rewindId]);
  assert.deepEqual(dbApi.listChatEvents(mission).map((e) => e.id), [ids[0], rewindId]);
});
