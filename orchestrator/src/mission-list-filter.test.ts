/**
 * `listMissions` must honour its status filter.
 *
 * What is protected: on the night of 2026-08-22, `/api/missions?status=running`
 * silently ignored the parameter and returned the last 100 missions of all
 * statuses. The agent diagnosing the saturation of the global cap
 * read "100 missions running" where there were 11, and concluded to an army of
 * non-existent zombies; the real bug (chat processes never reaped) stayed
 * invisible for hours. An ignored filter lies better than an error.
 *
 * `node --test --import tsx src/mission-list-filter.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-filter-test-'));

const { dbApi } = await import('./db.js');

/** Creates a mission, and finalises it if a terminal status is asked for. */
function mission(agent: string, status: 'running' | 'completed' | 'failed'): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, `mission ${status}`);
  if (status !== 'running') dbApi.finishMission(id, status, status === 'failed' ? 1 : 0);
  return id;
}

const aliveA = mission('alpha.main', 'running');
const aliveB = mission('beta.main', 'running');
mission('alpha.main', 'completed');
mission('alpha.main', 'failed');
mission('beta.main', 'completed');

test('status=running only returns the running missions', () => {
  const rows = dbApi.listMissions(100, undefined, 'running');
  assert.deepEqual(new Set(rows.map((m) => m.id)), new Set([aliveA, aliveB]));
});

test('without a filter, every status comes up: the historical behaviour is kept', () => {
  assert.equal(dbApi.listMissions(100).length, 5);
});

test('the status filter combines with the agent filter, without overriding either', () => {
  const rows = dbApi.listMissions(100, ['alpha.main'], 'running');
  assert.deepEqual(rows.map((m) => m.id), [aliveA]);
});

test('a status without any mission returns an empty list, not the whole list', () => {
  assert.deepEqual(dbApi.listMissions(100, undefined, 'terminated'), []);
});
