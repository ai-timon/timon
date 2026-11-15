import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { forgetMissionFence, missionFenced, recordMissionFence } from './mission-fence-state.js';

test('a mission reads as fenced only while the process launched in the fence is its current one', () => {
  const first = {};
  const second = {};
  assert.equal(missionFenced('m-1'), false, 'unknown: not fenced');
  recordMissionFence('m-1', first, true);
  assert.equal(missionFenced('m-1'), true);
  assert.equal(missionFenced('m-2'), false, 'another mission is not concerned');

  // A new turn's process replaces the record; the previous one's exit does not erase it.
  recordMissionFence('m-1', second, false);
  forgetMissionFence('m-1', first);
  assert.equal(missionFenced('m-1'), false);
  recordMissionFence('m-1', second, true);
  forgetMissionFence('m-1', first);
  assert.equal(missionFenced('m-1'), true);
  forgetMissionFence('m-1', second);
  assert.equal(missionFenced('m-1'), false);
});
