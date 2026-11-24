/**
 * Retention of the mission history and of the raw memory facts: off by
 * default, and once on, it deletes what is past the horizon and nothing else —
 * never a running mission's history.
 */
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

// A home of its own: the test counts rows in `events` and attaches a database,
// which another file sharing the suite's home would skew.
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-data-retention-'));
import { randomUUID } from 'node:crypto';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

delete process.env.TIMON_EVENTS_RETENTION_DAYS;
delete process.env.TIMON_LEARNINGS_RETENTION_DAYS;

const { db, dbApi, attachEventsArchive } = await import('./db.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { pruneOldEvents, pruneOldLearnings, runDataRetention } = await import('./data-retention.js');
const { agentMemoryFile, agentMemoryDir } = await import('./paths.js');

const DAY = 86_400_000;
const NOW = Date.now();
const OLD = NOW - 40 * DAY;

const setDays = (events: number | null, learnings: number | null) => {
  if (events === null) delete process.env.TIMON_EVENTS_RETENTION_DAYS;
  else process.env.TIMON_EVENTS_RETENTION_DAYS = String(events);
  if (learnings === null) delete process.env.TIMON_LEARNINGS_RETENTION_DAYS;
  else process.env.TIMON_LEARNINGS_RETENTION_DAYS = String(learnings);
  invalidateSettingsCache();
};

beforeEach(() => {
  db.exec('DELETE FROM mission_search; DELETE FROM events; DELETE FROM learnings;');
  setDays(null, null);
});

const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...args) as { n: number }).n;
const eventsOf = (id: string) => count('SELECT COUNT(*) n FROM events WHERE mission_id = ?', id);
const prune = (now = NOW) => pruneOldEvents({ now, pauseMs: 0 });

/**
 * A mission with one event `ageDays` old and one `lastDays` old, each indexed
 * by the history search; over unless `running`, ended at its last event.
 */
function missionWithHistory(opts: { running?: boolean; ageDays?: number; lastDays?: number } = {}): { id: string; oldEvent: number; newEvent: number } {
  const { running = false, ageDays = 40, lastDays = 40 } = opts;
  const id = randomUUID();
  dbApi.createMission(id, 'retention-witness', 'retention witness mission');
  const oldEvent = dbApi.insertEvent(id, 'assistant', { text: 'old' }).id;
  const newEvent = dbApi.insertEvent(id, 'assistant', { text: 'new' }).id;
  const first = NOW - ageDays * DAY;
  const last = NOW - lastDays * DAY;
  db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(first, oldEvent);
  db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(last, newEvent);
  db.prepare('UPDATE mission_stats SET last_event_at = ? WHERE mission_id = ?').run(last, id);
  const index = db.prepare(`INSERT INTO mission_search (mission_id, event_id, seq, role, ts, text) VALUES (?, ?, 0, 'assistant', ?, ?)`);
  index.run(id, oldEvent, first, `old text ${id}`);
  index.run(id, newEvent, last, `new text ${id}`);
  if (running) {
    db.prepare('UPDATE missions SET started_at = ? WHERE id = ?').run(first, id);
  } else {
    dbApi.finishMission(id, 'completed', 0);
    db.prepare('UPDATE missions SET started_at = ?, ended_at = ? WHERE id = ?').run(first, last, id);
  }
  return { id, oldEvent, newEvent };
}

test('by default, history idle for 180 days goes and raw facts stay', async () => {
  const stale = missionWithHistory({ ageDays: 400, lastDays: 200 });
  const recent = missionWithHistory({ ageDays: 400, lastDays: 100 });
  dbApi.insertLearning({ agent: 'retention-witness', kind: 'pitfall', text: 'very old fact', ts: NOW - 900 * DAY });

  const outcome = await runDataRetention({ now: NOW, pauseMs: 0 });

  assert.deepEqual(outcome, { events: 2, learnings: 0, learningLines: 0 });
  assert.equal(eventsOf(stale.id), 0);
  assert.equal(eventsOf(recent.id), 2);
  assert.equal(count('SELECT COUNT(*) n FROM learnings'), 1);
});

test('a value set in the settings table wins over the default, 0 included', async () => {
  const stale = missionWithHistory({ ageDays: 400, lastDays: 200 });
  try {
    dbApi.setSetting('TIMON_EVENTS_RETENTION_DAYS', '0');
    invalidateSettingsCache();
    assert.equal(await prune(), 0);
    assert.equal(eventsOf(stale.id), 2);

    dbApi.setSetting('TIMON_EVENTS_RETENTION_DAYS', '365');
    invalidateSettingsCache();
    assert.equal(await prune(), 0, 'idle 200 days is within a year');

    // The environment wins over the table.
    setDays(30, null);
    assert.equal(await prune(), 2);
  } finally {
    dbApi.deleteSetting('TIMON_EVENTS_RETENTION_DAYS');
    invalidateSettingsCache();
  }
});

test('both retentions are off when set to 0: nothing is deleted', async () => {
  const done = missionWithHistory();
  dbApi.insertLearning({ agent: 'retention-witness', kind: 'pitfall', text: 'old fact', ts: OLD });
  setDays(0, 0);

  const outcome = await runDataRetention({ now: NOW, pauseMs: 0 });

  assert.deepEqual(outcome, { events: 0, learnings: 0, learningLines: 0 });
  assert.equal(eventsOf(done.id), 2);
  assert.equal(count('SELECT COUNT(*) n FROM learnings'), 1);
});

test('a mission idle past the retention loses its whole history, search text included', async () => {
  const done = missionWithHistory();
  setDays(30, null);

  assert.equal(await prune(), 2);

  assert.equal(eventsOf(done.id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM mission_search WHERE mission_id = ? AND event_id IS NOT NULL', done.id), 0);
  assert.equal(count('SELECT COUNT(*) n FROM mission_search_fts WHERE mission_search_fts MATCH ?', `"old text ${done.id}"`), 0);
  assert.ok(dbApi.getMission(done.id), 'the mission itself stays in the list');
});

const statsOf = (id: string) => db.prepare('SELECT event_count, ready, last_event_at FROM mission_stats WHERE mission_id = ?')
  .get(id) as { event_count: number; ready: number; last_event_at: number | null };
const listed = (id: string) => dbApi.listMissions(500).find((m) => m.id === id);

test('a purged mission is marked and the mission list counts no event left', async () => {
  const done = missionWithHistory();
  const kept = missionWithHistory({ lastDays: 5 });
  assert.equal(listed(done.id)?.event_count, 2);
  setDays(30, null);

  assert.equal(await prune(), 2);

  assert.equal(statsOf(done.id).event_count, 0);
  assert.equal(listed(done.id)?.event_count, 0, 'the list reads the stats row, now zero');
  assert.ok(statsOf(done.id).last_event_at, 'the last activity date stays: it is still true');
  assert.equal(dbApi.getMission(done.id)?.history_purged_days, 30, 'marked with the retention that applied');
  assert.equal(dbApi.getMission(kept.id)?.history_purged_days, null, 'a mission kept whole is not marked');
  assert.equal(statsOf(kept.id).event_count, 2);
});

test('the mission detail says the history was purged, and a mission never purged says nothing', async () => {
  const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
  const done = missionWithHistory();
  const empty = randomUUID();
  dbApi.createMission(empty, 'retention-witness', 'never had a message');
  dbApi.finishMission(empty, 'completed', 0);
  setDays(30, null);
  await prune();

  const app = express();
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  const detail = async (id: string) =>
    (await fetch(`http://127.0.0.1:${port}/api/missions/${id}?tail=50`)).json() as Promise<{ history_purged_days: number | null; events: unknown[] }>;
  try {
    const purged = await detail(done.id);
    assert.equal(purged.history_purged_days, 30);
    assert.deepEqual(purged.events, []);
    const never = await detail(empty);
    assert.equal(never.history_purged_days, null);
    assert.deepEqual(never.events, []);
  } finally {
    server.close();
  }
});

test('a purge in slices takes each slice out of the count, and the last one leaves zero', () => {
  const done = missionWithHistory();
  dbApi.insertEvent(done.id, 'assistant', { text: 'third' });
  db.prepare('UPDATE events SET timestamp = ? WHERE mission_id = ?').run(OLD, done.id);
  db.prepare('UPDATE mission_stats SET last_event_at = ? WHERE mission_id = ?').run(OLD, done.id);
  assert.equal(statsOf(done.id).event_count, 3);
  const cutoff = NOW - 30 * DAY;

  assert.equal(dbApi.pruneMissionEventsBatch('events', done.id, cutoff, false, 2, 30), 2);
  assert.equal(statsOf(done.id).event_count, 1);
  assert.equal(dbApi.getMission(done.id)?.history_purged_days, 30, 'marked from the first slice on');

  // A count that drifted above the rows (a row the stats counted twice) still ends at zero.
  db.prepare('UPDATE mission_stats SET event_count = 9 WHERE mission_id = ?').run(done.id);
  assert.equal(dbApi.pruneMissionEventsBatch('events', done.id, cutoff, false, 2, 30), 1);
  assert.equal(statsOf(done.id).event_count, 0);
});

test('a purged mission whose stats await their backfill is left ready at zero', () => {
  const done = missionWithHistory();
  db.prepare('UPDATE mission_stats SET ready = 0, event_count = 0, backfill_cursor = 0, backfill_upto = ? WHERE mission_id = ?')
    .run(done.newEvent, done.id);

  assert.equal(dbApi.pruneMissionEventsBatch('events', done.id, NOW - 30 * DAY, false, 100, 30), 2);

  const stats = statsOf(done.id);
  assert.equal(stats.ready, 1, 'nothing left to fold in');
  assert.equal(stats.event_count, 0);
});

test('a conversation active within the retention keeps its oldest messages too', async () => {
  // Resumed after months: cutting by event date would leave it without its start.
  const resumed = missionWithHistory({ ageDays: 200, lastDays: 5 });
  setDays(30, null);

  assert.equal(await prune(), 0);
  assert.equal(eventsOf(resumed.id), 2);
});

test('a running mission keeps everything, however old', async () => {
  const live = missionWithHistory({ running: true });
  setDays(30, null);

  assert.equal(await prune(), 0);
  assert.equal(eventsOf(live.id), 2);
  assert.equal(dbApi.pruneMissionEventsBatch('events', live.id, NOW, false, 100, 30), 0, 'checked again at deletion');
});

test('a mission an open task still needs keeps its history until the task is done', async () => {
  const blocked = missionWithHistory();
  const taskId = randomUUID();
  db.prepare(`INSERT INTO tasks (id, title, status, agent_name, mission_id, created_at, updated_at)
              VALUES (?, 'retention witness task', 'BLOCKED', 'retention-witness', ?, ?, ?)`)
    .run(taskId, blocked.id, OLD, OLD);
  setDays(30, null);

  assert.equal(await prune(), 0);
  assert.equal(eventsOf(blocked.id), 2);

  db.prepare(`UPDATE tasks SET status = 'DONE' WHERE id = ?`).run(taskId);
  assert.equal(await prune(), 2);
  assert.equal(eventsOf(blocked.id), 0);
});

test('archived events of an idle mission are deleted too; a recent hot event protects the archived ones', async () => {
  mkdirSync(join(process.env.TIMON_HOME!, 'archive'), { recursive: true });
  attachEventsArchive(join(process.env.TIMON_HOME!, 'archive', 'events.db'));
  db.exec('DELETE FROM archive.events');
  const archived = (lastDays: number) => {
    const id = randomUUID();
    dbApi.createMission(id, 'retention-witness', 'archived mission');
    dbApi.finishMission(id, 'completed', 0);
    db.prepare('UPDATE missions SET started_at = ?, ended_at = ? WHERE id = ?').run(OLD, NOW - lastDays * DAY, id);
    db.prepare(`INSERT INTO archive.events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', ?, '{}')`).run(id, OLD);
    return id;
  };
  const idle = archived(40);
  const resumed = archived(2);
  const hot = dbApi.insertEvent(resumed, 'assistant', { text: 'back' }).id;
  setDays(30, null);

  assert.equal(await prune(), 1);
  assert.equal(count('SELECT COUNT(*) n FROM archive.events WHERE mission_id = ?', idle), 0);
  assert.equal(count('SELECT COUNT(*) n FROM archive.events WHERE mission_id = ?', resumed), 1);
  assert.equal(count('SELECT COUNT(*) n FROM events WHERE id = ?', hot), 1);
});

test('a large backlog goes in slices, handing the event loop back between two', async () => {
  // A generated history: 120 idle missions of 250 events, and one big one.
  const insert = db.prepare(`INSERT INTO events (mission_id, type, timestamp, payload) VALUES (?, 'assistant', ?, ?)`);
  const payload = JSON.stringify({ text: 'x'.repeat(400) });
  const ids: string[] = [];
  db.transaction(() => {
    for (let m = 0; m < 121; m++) {
      const id = randomUUID();
      dbApi.createMission(id, 'retention-witness', 'generated mission');
      dbApi.finishMission(id, 'completed', 0);
      db.prepare('UPDATE missions SET started_at = ?, ended_at = ? WHERE id = ?').run(OLD, OLD, id);
      for (let e = 0; e < (m === 0 ? 20_000 : 250); e++) insert.run(id, OLD, payload);
      ids.push(id);
    }
  })();
  db.prepare('UPDATE mission_stats SET last_event_at = ?').run(OLD);
  const total = 20_000 + 120 * 250;
  setDays(30, null);

  let turns = 0;
  const ticker = setInterval(() => { turns++; }, 0);
  let longest = 0;
  let last = performance.now();
  const watch = setInterval(() => {
    const at = performance.now();
    longest = Math.max(longest, at - last);
    last = at;
  }, 0);
  try {
    const outcome = await runDataRetention({ now: NOW, sliceRows: 1_000, pauseMs: 1 });
    assert.equal(outcome.events, total);
  } finally {
    clearInterval(ticker);
    clearInterval(watch);
  }

  assert.equal(count('SELECT COUNT(*) n FROM events'), 0);
  assert.ok(turns >= total / 1_000 - 1, `the event loop ran between slices (${turns} turns for ${total / 1_000} slices)`);
  assert.ok(longest < 2_000, `no slice held the daemon for long (${Math.round(longest)} ms)`);
});

test('a pass asked to stop leaves the rest for the next one', async () => {
  missionWithHistory();
  missionWithHistory();
  setDays(30, null);

  assert.equal(await pruneOldEvents({ now: NOW, pauseMs: 0, stopped: () => true }), 0);
  assert.equal(await prune(), 4);
});

test('raw facts past the retention go, from the database and from the agents\' files', () => {
  const agent = 'retention-agent';
  mkdirSync(agentMemoryDir(agent), { recursive: true });
  dbApi.insertLearning({ agent, kind: 'pitfall', text: 'old fact', ts: OLD });
  dbApi.insertLearning({ agent, kind: 'pitfall', text: 'new fact', ts: NOW });

  const recent = agentMemoryFile(agent, 'learnings.jsonl');
  writeFileSync(recent, [
    JSON.stringify({ kind: 'pitfall', text: 'old dated', ts: new Date(OLD).toISOString() }),
    JSON.stringify({ kind: 'pitfall', text: 'new dated', ts: new Date(NOW).toISOString() }),
    JSON.stringify({ kind: 'pitfall', text: 'undated in a recent file' }),
  ].join('\n') + '\n');
  // An undated line is as old as the file's last write at most.
  const stale = agentMemoryFile(agent, 'learnings.archive.jsonl');
  writeFileSync(stale, JSON.stringify({ kind: 'decision', text: 'undated in an old file' }) + '\n');
  utimesSync(stale, new Date(OLD), new Date(OLD));
  setDays(null, 30);

  assert.deepEqual(pruneOldLearnings(NOW), { rows: 1, lines: 2 });

  assert.deepEqual((db.prepare('SELECT text FROM learnings').all() as { text: string }[]).map((r) => r.text), ['new fact']);
  const kept = readFileSync(recent, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { text: string }).text);
  assert.deepEqual(kept, ['new dated', 'undated in a recent file']);
  assert.equal(readFileSync(stale, 'utf8'), '');
});

test('a zero setting keeps everything', async () => {
  dbApi.insertLearning({ agent: 'retention-witness', kind: 'pitfall', text: 'old fact', ts: OLD });
  setDays(0, 0);
  assert.equal(await pruneOldEvents({ now: NOW, pauseMs: 0 }), 0);
  assert.deepEqual(pruneOldLearnings(NOW), { rows: 0, lines: 0 });
  assert.equal(count('SELECT COUNT(*) n FROM learnings'), 1);
});
