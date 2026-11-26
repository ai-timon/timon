import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  applyMissionArchiveChange,
  archivedQuery,
  canArchive,
  filterArchived,
  isArchived,
  parseMissionArchiveChange,
} from './mission-archive';

const rows = [
  { id: 'a', running: false, archived_at: null },
  { id: 'b', running: false, archived_at: 10 },
  { id: 'c', running: true },
];

test('a row is archived when the daemon stamped it', () => {
  assert.equal(isArchived(rows[0]!), false);
  assert.equal(isArchived(rows[1]!), true);
  assert.equal(isArchived({}), false);
});

test('only an idle, visible mission can be archived', () => {
  assert.equal(canArchive(rows[0]!), true);
  assert.equal(canArchive(rows[1]!), false);
  assert.equal(canArchive(rows[2]!), false);
});

test('the toggle off hides archived rows, on keeps every row', () => {
  assert.deepEqual(filterArchived(rows, false).map((m) => m.id), ['a', 'c']);
  assert.deepEqual(filterArchived(rows, true).map((m) => m.id), ['a', 'b', 'c']);
});

test('the list request only asks for archived rows when the toggle is on', () => {
  assert.equal(archivedQuery(false), undefined);
  assert.equal(archivedQuery(true), 'include');
});

test('events of the global stream are parsed, anything else is ignored', () => {
  assert.deepEqual(parseMissionArchiveChange('mission_archived', '{"kind":"mission_archived","missionId":"m1","by":"user"}'), { missionId: 'm1', archived: true });
  assert.deepEqual(parseMissionArchiveChange('mission_unarchived', '{"missionId":"m1"}'), { missionId: 'm1', archived: false });
  assert.equal(parseMissionArchiveChange('mission_archived', '{"missionId":""}'), null);
  assert.equal(parseMissionArchiveChange('mission_archived', 'nope'), null);
});

test('a live event flags the row it names and leaves the others alone', () => {
  const archived = applyMissionArchiveChange(rows, { missionId: 'a', archived: true }, 99);
  assert.equal(archived[0]!.archived_at, 99);
  assert.equal(archived[1], rows[1]);
  const back = applyMissionArchiveChange(rows, { missionId: 'b', archived: false }, 99);
  assert.equal(back[1]!.archived_at, null);
  // Already in that state: same object, no needless re-render.
  assert.equal(applyMissionArchiveChange(rows, { missionId: 'b', archived: true }, 99)[1], rows[1]);
  assert.deepEqual(applyMissionArchiveChange(rows, { missionId: 'zz', archived: true }, 99), rows);
});
