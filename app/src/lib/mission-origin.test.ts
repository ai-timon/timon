import test from 'node:test';
import assert from 'node:assert/strict';

import { isMissionOrigin, onlyUserMissions } from './mission-origin';
import { DEFAULT_MISSION_RAIL_DISPLAY, missionRailDisplayChanged, readMissionRailDisplay, writeMissionRailDisplay } from './mission-rail-display';

const rows = [
  { id: 'chat', origin: 'user' },
  { id: 'task', origin: 'task' },
  { id: 'wake', origin: 'agent' },
  { id: 'old', origin: undefined },
  { id: 'odd', origin: 'something-new' },
];

test('only the user origin is kept, plus rows the client cannot classify', () => {
  assert.deepEqual(onlyUserMissions(rows, null).map((m) => m.id), ['chat', 'old', 'odd']);
});

test('the open mission stays listed whatever its origin', () => {
  assert.deepEqual(onlyUserMissions(rows, 'task').map((m) => m.id), ['chat', 'task', 'old', 'odd']);
});

test('the origin vocabulary is closed', () => {
  assert.equal(isMissionOrigin('routine'), true);
  assert.equal(isMissionOrigin('automated'), false);
  assert.equal(isMissionOrigin(null), false);
});

test('"only mine" is stored with the rail display, off by default', () => {
  assert.deepEqual(readMissionRailDisplay(undefined), { showAvatar: true, mineOnly: false, groupByOrchestrator: false, expandSubagents: false, includeArchived: false });
  // A row written before grouping existed keeps its settings and gets the new defaults.
  assert.deepEqual(readMissionRailDisplay({ v: 1, showAvatar: false, mineOnly: true }), { showAvatar: false, mineOnly: true, groupByOrchestrator: false, expandSubagents: false, includeArchived: false });
  const stored = writeMissionRailDisplay({ showAvatar: false, mineOnly: true, groupByOrchestrator: true, expandSubagents: true, includeArchived: false });
  assert.deepEqual(readMissionRailDisplay(stored), { showAvatar: false, mineOnly: true, groupByOrchestrator: true, expandSubagents: true, includeArchived: false });
});

test('the filter button flags any setting that differs from the default', () => {
  assert.equal(missionRailDisplayChanged(DEFAULT_MISSION_RAIL_DISPLAY), false);
  assert.equal(missionRailDisplayChanged({ ...DEFAULT_MISSION_RAIL_DISPLAY, showAvatar: false }), true);
  assert.equal(missionRailDisplayChanged({ ...DEFAULT_MISSION_RAIL_DISPLAY, mineOnly: true }), true);
  assert.equal(missionRailDisplayChanged({ ...DEFAULT_MISSION_RAIL_DISPLAY, groupByOrchestrator: true }), true);
  assert.equal(missionRailDisplayChanged({ ...DEFAULT_MISSION_RAIL_DISPLAY, expandSubagents: true, includeArchived: false }), true);
});
