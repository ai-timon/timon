/**
 * Cold archive of events: the contract that matters: nothing disappears.
 *
 * The risk of this feature is not archiving badly, it is that an
 * archived mission shows empty in the UI because the read only looked
 * at the hot table. Hence the final assertion on `listEvents`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A TIMON_HOME of OUR own, not the one of `test-home.ts`: the whole suite
// shares one temporary folder, hence one `timon.db`. This test counts
// rows in `events` and attaches a database: two global gestures another
// test file would skew (and the other way round).
// (no `import './test-home.js'`: ESM imports are hoisted, it would set
// its folder before this line; here we want ours, and nothing else.)
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-events-archive-'));
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_EVENTS_HOT_DAYS = '7';
process.env.TIMON_TRACE_SPANS_RETENTION_DAYS = '7';

const { db, dbApi } = await import('./db.js');
const { archiveOldEvents, drainOldTraceSpans, pruneOldTraceSpans, EVENTS_ARCHIVE_PATH } = await import('./events-archive.js');
const { backfillTraceSpans, rebuildMissionSpans } = await import('./trace-span-backfill.js');

const MISSION = 'e7f1b0c2-0000-4000-8000-000000000001';
const DAY = 86_400_000;

test('events older than the hot window go to the archive, without losing reads', () => {
  dbApi.createMission(MISSION, 'agent-temoin', 'mission témoin de l\'archivage'); // french-ok: free-text sample data
  const ids: number[] = [];
  for (let i = 0; i < 10; i++) ids.push(dbApi.insertEvent(MISSION, 'assistant', { i }).id);

  // The first 5 date from 30 days ago: `insertEvent` sets `Date.now()`, we
  // backdate by hand (no API allows it, and that is fine).
  const old = Date.now() - 30 * DAY;
  const backdate = db.prepare('UPDATE events SET timestamp = ? WHERE id = ?');
  for (const id of ids.slice(0, 5)) backdate.run(old, id);

  const moved = archiveOldEvents();
  assert.equal(moved, 5);

  const hot = db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number };
  assert.equal(hot.n, 5, 'the hot table only keeps the recent window');
  const cold = db.prepare('SELECT COUNT(*) AS n FROM archive.events').get() as { n: number };
  assert.equal(cold.n, 5, 'the 5 old ones are in the attached database');
  assert.ok(EVENTS_ARCHIVE_PATH.endsWith(join('archive', 'events.db')));

  const all = dbApi.listEvents(MISSION);
  assert.equal(all.length, 10, 'listEvents must stitch hot + archive together');
  assert.deepEqual(all.map((e) => e.id), ids, 'and return the events in chronological order');
});

test('a second pass moves nothing more', () => {
  assert.equal(archiveOldEvents(), 0);
  assert.equal(dbApi.listEvents(MISSION).length, 10);
});

test('a hot window at 0 disables the feature completely', async () => {
  const { invalidateSettingsCache } = await import('./settings.js');
  process.env.TIMON_EVENTS_HOT_DAYS = '0';
  invalidateSettingsCache();
  // Backdate everything: without the guard, these 5 rows would go to the archive.
  db.prepare('UPDATE events SET timestamp = ?').run(Date.now() - 365 * DAY);
  assert.equal(archiveOldEvents(), 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n, 5);
  process.env.TIMON_EVENTS_HOT_DAYS = '7';
  invalidateSettingsCache();
});

test("TODO #547: the spans of missions finished outside the window go, never those of a live mission or an open run", () => {
  const now = Date.now();
  const old = now - 30 * DAY;
  const span = (id: string, mission: string, at: number, run: string | null = null) => ({
    op: 'open' as const, id, trace_id: mission, mission_id: mission, workflow_run_id: run, seq: at,
    kind: 'tool' as const, name: 'Read', started_at: at, status: 'ok' as const, ended_at: at + 10,
  });
  const done = 'e7f1b0c2-0000-4000-8000-0000000000a1';
  const live = 'e7f1b0c2-0000-4000-8000-0000000000a2';
  const system = 'e7f1b0c2-0000-4000-8000-0000000000a3';
  for (const id of [done, live, system]) dbApi.createMission(id, 'agent-temoin', 'témoin de la rétention des spans'); // french-ok: free-text sample data
  dbApi.finishMission(done, 'completed', 0);
  dbApi.finishMission(system, 'completed', 0);
  const finish = db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?');
  finish.run(old, done);
  finish.run(old, system);
  for (const [id, status] of [['run-open', 'waiting'], ['run-over', 'completed']] as const) {
    dbApi.insertWorkflowRun({ id, workflow_id: 'wf', version: 1, status, trigger: '{}', input: null, context: '{}', error: null,
      started_at: old, ended_at: null, owner_user_id: null, tokens_in: null, tokens_out: null, cost_usd: null });
  }
  dbApi.upsertSpans([
    span('old-done', done, old), span('recent-done', done, now),
    span('old-live', live, old),
    span('old-run-open', system, old, 'run-open'), span('old-run-over', system, old, 'run-over'),
  ]);
  assert.equal(pruneOldTraceSpans(now), 1);
  const left = (db.prepare('SELECT id FROM trace_spans WHERE id IN (?,?,?,?,?) ORDER BY id')
    .all('old-done', 'recent-done', 'old-live', 'old-run-open', 'old-run-over') as { id: string }[]).map((r) => r.id);
  // A run's spans come from the engine, not from events: nothing could rebuild them.
  assert.deepEqual(left, ['old-live', 'old-run-open', 'old-run-over', 'recent-done']);
  assert.equal(pruneOldTraceSpans(now), 0);
});

async function spanSetting<T>(value: string | undefined, work: () => T | Promise<T>): Promise<T> {
  const { invalidateSettingsCache } = await import('./settings.js');
  if (value === undefined) delete process.env.TIMON_TRACE_SPANS_RETENTION_DAYS;
  else process.env.TIMON_TRACE_SPANS_RETENTION_DAYS = value;
  invalidateSettingsCache();
  try {
    return await work();
  } finally {
    process.env.TIMON_TRACE_SPANS_RETENTION_DAYS = '7';
    invalidateSettingsCache();
  }
}

function finishedMission(endedAt: number): string {
  const id = randomUUID();
  dbApi.createMission(id, 'agent-temoin', 'témoin de la rétention des spans'); // french-ok: free-text sample data
  dbApi.finishMission(id, 'completed', 0);
  db.prepare('UPDATE missions SET ended_at = ? WHERE id = ?').run(endedAt, id);
  return id;
}

function toolSpan(mission: string, id: string, at: number, status: 'ok' | 'error' = 'ok') {
  return {
    op: 'open' as const, id, trace_id: mission, mission_id: mission, workflow_run_id: null, seq: at,
    kind: 'tool' as const, name: 'Read', started_at: at, status, ended_at: at + 10, duration_ms: 10,
  };
}

const listed = (id: string) => {
  const row = dbApi.listMissions(1_000).find((mission) => mission.id === id);
  assert.ok(row);
  return { tools: row.span_tools, errors: row.span_errors, duration: row.duration_ms };
};

test('TODO #631: TIMON_TRACE_SPANS_RETENTION_DAYS is 90 days by default, independently of the events', async () => {
  const old = Date.now() - 100 * DAY;
  const beyond = finishedMission(old);
  const within = finishedMission(Date.now() - 80 * DAY);
  dbApi.upsertSpans([toolSpan(beyond, `beyond-${beyond}`, old), toolSpan(within, `within-${within}`, Date.now() - 80 * DAY)]);
  const { settingInt } = await import('./settings.js');
  await spanSetting(undefined, () => {
    assert.equal(settingInt('TIMON_TRACE_SPANS_RETENTION_DAYS'), 90);
    assert.equal(pruneOldTraceSpans(), 1);
  });
  assert.equal(dbApi.listSpans(beyond).length, 0);
  assert.equal(dbApi.listSpans(within).length, 1);
});

test("TODO #631: the setting at 0 purges no span, whatever the events horizon", async () => {
  const old = Date.now() - 100 * DAY;
  const mission = finishedMission(old);
  dbApi.upsertSpans([toolSpan(mission, `kept-${mission}`, old)]);
  await spanSetting('0', () => assert.equal(pruneOldTraceSpans(), 0));
  assert.equal(dbApi.listSpans(mission).length, 1);
  assert.equal(dbApi.prunedSpanCount(mission), 0);
});

test('TODO #631: the mission list keeps tools, errors and duration after the purge', () => {
  pruneOldTraceSpans(); // what the previous tests left behind
  const old = Date.now() - 30 * DAY;
  const mission = finishedMission(old);
  dbApi.upsertSpans([
    toolSpan(mission, `a-${mission}`, old), toolSpan(mission, `b-${mission}`, old + 1, 'error'), toolSpan(mission, `c-${mission}`, old + 2),
  ]);
  const before = listed(mission);
  assert.deepEqual(before, { tools: 3, errors: 1, duration: 30 });
  assert.equal(pruneOldTraceSpans(), 3);
  assert.equal(dbApi.listSpans(mission).length, 0);
  assert.equal(dbApi.prunedSpanCount(mission), 3);
  assert.deepEqual(listed(mission), before);
  // A second pass has nothing left to count.
  assert.equal(pruneOldTraceSpans(), 0);
  assert.deepEqual(listed(mission), before);
});

test('TODO #631: a partial purge adds up the live and the frozen', () => {
  pruneOldTraceSpans(); // what the previous tests left behind
  const now = Date.now();
  const mission = finishedMission(now - 30 * DAY);
  dbApi.upsertSpans([toolSpan(mission, `old-${mission}`, now - 30 * DAY), toolSpan(mission, `late-${mission}`, now)]);
  assert.equal(pruneOldTraceSpans(now), 1);
  assert.equal(dbApi.listSpans(mission).length, 1);
  assert.deepEqual(listed(mission), { tools: 2, errors: 0, duration: 20 });
});

test('TODO #631: the rebuild returns the timeline without counting twice', () => {
  pruneOldTraceSpans(); // what the previous tests left behind
  const old = Date.now() - 30 * DAY;
  const mission = finishedMission(old);
  const toolUse = { type: 'tool_use', id: `t-${mission}`, name: 'Read', input: {} };
  dbApi.insertEvent(mission, 'assistant', { message: { content: [toolUse] } });
  dbApi.insertEvent(mission, 'user', { message: { content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: 'ok' }] } });
  dbApi.upsertSpans([toolSpan(mission, `orig-${mission}`, old)]);
  assert.equal(pruneOldTraceSpans(), 1);
  assert.equal(listed(mission).tools, 1);

  const report = rebuildMissionSpans(dbApi.getMission(mission)!);
  assert.ok(report.spans > 0);
  assert.ok(dbApi.listSpans(mission).length > 0);
  assert.equal(dbApi.prunedSpanCount(mission), 0);
  assert.equal(listed(mission).tools, 1);
});

test('TODO #631: a mission whose events give no span keeps its totals', () => {
  pruneOldTraceSpans(); // what the previous tests left behind
  const old = Date.now() - 30 * DAY;
  const mission = finishedMission(old);
  dbApi.upsertSpans([toolSpan(mission, `orig-${mission}`, old)]);
  pruneOldTraceSpans();
  const report = rebuildMissionSpans(dbApi.getMission(mission)!);
  assert.equal(report.spans, 0);
  assert.equal(dbApi.prunedSpanCount(mission), 1);
  assert.equal(listed(mission).tools, 1);
});

test("TODO #631: trace_backfill without a window revives nothing beyond the horizon", () => {
  const beyond = finishedMission(Date.now() - 30 * DAY);
  db.prepare('UPDATE missions SET started_at = ? WHERE id = ?').run(Date.now() - 30 * DAY, beyond);
  dbApi.insertEvent(beyond, 'assistant', { message: { content: [{ type: 'tool_use', id: `t-${beyond}`, name: 'Read', input: {} }] } });
  backfillTraceSpans({ limit: 1_000 });
  assert.equal(dbApi.listSpans(beyond).length, 0);
  backfillTraceSpans({ days: 60, limit: 1_000 });
  assert.ok(dbApi.listSpans(beyond).length > 0, 'an explicit window stays respected');
});

test('TODO #631: the purge returns in slices and stops when asked to', async () => {
  dbApi.pruneTraceSpans(Date.now()); // what the previous tests left behind
  const old = Date.now() - 30 * DAY;
  const mission = finishedMission(old);
  dbApi.upsertSpans(Array.from({ length: 7 }, (_, i) => toolSpan(mission, `slice-${i}-${mission}`, old + i)));
  assert.equal(dbApi.pruneTraceSpans(old + 100, 2, 3), 4, 'the slice stops at the first batch that exceeds the cap');
  let yielded = 0;
  const timer = setInterval(() => { yielded += 1; }, 0);
  try {
    assert.equal(await drainOldTraceSpans({ sliceRows: 1, pauseMs: 1, stopped: () => yielded > 1_000_000 }), 3);
  } finally { clearInterval(timer); }
  assert.ok(yielded > 0, 'the timers ran between two slices');
  assert.equal(dbApi.listSpans(mission).length, 0);
  assert.equal(dbApi.prunedSpanCount(mission), 7);

  const other = finishedMission(old);
  dbApi.upsertSpans([toolSpan(other, `stop-${other}`, old)]);
  assert.equal(await drainOldTraceSpans({ stopped: () => true }), 0);
  assert.equal(dbApi.listSpans(other).length, 1);
  pruneOldTraceSpans();
});
