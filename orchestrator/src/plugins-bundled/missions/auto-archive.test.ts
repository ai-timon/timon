/**
 * Scheduled auto-archive: threshold, 0 = off, exclusions, idempotence and the
 * bounded batch, all with an injected clock.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-auto-archive-'));
delete process.env.TIMON_MISSIONS_AUTO_ARCHIVE_DAYS;

const { dbApi } = await import('../../db.js');
const { bus } = await import('../../bus.js');
const { autoArchiveOnce } = await import('./auto-archive.js');
const { resolve } = await import('../../settings.js');

const DAY = 86_400_000;
const NOW = Date.now();
// The clock is injected: missions end "now", the sweep runs this far ahead.
const at = (days: number) => NOW + days * DAY;

function finished(status: 'completed' | 'failed' = 'completed', owner?: string): string {
  const id = randomUUID();
  dbApi.createMission(id, 'arch.agent', 'work', undefined, owner);
  dbApi.finishMission(id, status, status === 'completed' ? 0 : 1);
  return id;
}

test('the setting defaults to 0 (disabled) and is exposed', () => {
  const r = resolve('TIMON_MISSIONS_AUTO_ARCHIVE_DAYS');
  assert.equal(r?.value, 0);
  assert.equal(r?.source, 'default');
});

test('0 days archives nothing', () => {
  const id = finished();
  assert.equal(autoArchiveOnce({ now: at(400), days: 0 }), 0);
  assert.equal(dbApi.getMission(id)?.archived_at, null);
});

test('threshold: idle for fewer than N days stays, older goes, tagged auto', () => {
  const id = finished();
  assert.equal(autoArchiveOnce({ now: at(6), days: 7 }), 0);
  assert.equal(dbApi.getMission(id)?.archived_at, null);
  const seen: string[] = [];
  const listen = (e: { kind: string; missionId?: string; by?: string }): void => {
    if (e.kind === 'mission_archived') seen.push(`${e.missionId}:${e.by}`);
  };
  bus.on('event', listen);
  assert.ok(autoArchiveOnce({ now: at(8), days: 7 }) >= 1);
  bus.off('event', listen);
  const row = dbApi.getMission(id);
  assert.ok(row?.archived_at);
  assert.equal(row?.archived_by, 'auto');
  assert.ok(seen.includes(`${id}:auto`));
});

test('idempotent: a second pass finds nothing', () => {
  finished();
  assert.ok(autoArchiveOnce({ now: at(30), days: 7 }) >= 1);
  assert.equal(autoArchiveOnce({ now: at(30), days: 7 }), 0);
});

test('running, failed and manually archived missions are left alone', () => {
  const live = randomUUID();
  dbApi.createMission(live, 'arch.agent', 'running');
  const failed = finished('failed');
  const manual = finished();
  assert.equal(dbApi.archiveMission(manual, 'user'), 'archived');
  autoArchiveOnce({ now: at(400), days: 7 });
  assert.equal(dbApi.getMission(live)?.archived_at, null);
  assert.equal(dbApi.getMission(failed)?.archived_at, null);
  assert.equal(dbApi.getMission(manual)?.archived_by, 'user');
});

test('a mission with a pending command request is skipped', () => {
  const owner = randomUUID();
  const id = finished('completed', owner);
  const requestId = randomUUID();
  dbApi.insertCommandRequest({
    id: requestId, mission_id: id, owner_user_id: owner, agent: 'arch.agent', command: 'ls', note: null,
    session_id: null, project: null, mission_title: 't', task_id: null, choices: '[]', origin_kind: 'agent', origin_id: null,
  });
  autoArchiveOnce({ now: at(400), days: 7 });
  assert.equal(dbApi.getMission(id)?.archived_at, null);
  dbApi.settleCommandRequest(requestId, 'dismissed');
  autoArchiveOnce({ now: at(400), days: 7 });
  assert.ok(dbApi.getMission(id)?.archived_at);
});

test('a lowered value never unarchives, and the batch is bounded', () => {
  const ids = [finished(), finished(), finished()];
  assert.equal(autoArchiveOnce({ now: at(400), days: 7, batch: 2 }) <= 2, true);
  autoArchiveOnce({ now: at(400), days: 7, batch: 1000 });
  for (const id of ids) assert.equal(dbApi.getMission(id)?.archived_by, 'auto');
  autoArchiveOnce({ now: at(0), days: 3650 });
  for (const id of ids) assert.equal(dbApi.getMission(id)?.archived_by, 'auto');
});
