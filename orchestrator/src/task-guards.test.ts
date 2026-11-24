/**
 * Tests of the input guards (task-guards.ts).
 *
 * `node --test --import tsx src/task-guards.test.ts` (or `npm test`). The tested
 * module is pure: no import opens the SQLite database or reads the disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateScheduledAt,
  checkScheduledAtPlausibility,
  checkRoleAgentCwd,
  normalizeCwd,
} from './task-guards.js';

const H = 3_600_000;
/** 2026-08-05 22:45 local time: the exact creation time of the incident's tasks. */
const INCIDENT_NOW = Date.UTC(2026, 7, 5, 20, 45);

const T_2026 = new Date('2026-01-01T02:00:00Z').getTime();

test('plausibility: null/undefined and a near past trigger nothing', () => {
  assert.equal(checkScheduledAtPlausibility(null, INCIDENT_NOW), null);
  assert.equal(checkScheduledAtPlausibility(undefined, INCIDENT_NOW), null);
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW - H, INCIDENT_NOW), null);
});

test('plausibility: the coming night passes without a warning', () => {
  // 22h45 → 00h30 le lendemain = 1h45. Le cas nominal.
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW + 1.75 * H, INCIDENT_NOW), null);
  // Creating at 06:00 for 00:00 the next night = exactly 18 h: legitimate upper bound.
  assert.equal(checkScheduledAtPlausibility(INCIDENT_NOW + 18 * H, INCIDENT_NOW), null);
});

test("plausibility: the incident's 24 h shift is reported", () => {
  // The 5 tasks aimed at 00:30 on the night of the 6th to the 7th: 25.75 h after their creation.
  const warning = checkScheduledAtPlausibility(INCIDENT_NOW + 25.75 * H, INCIDENT_NOW);
  assert.ok(warning, 'a 25.75 h shift must be reported');
  assert.match(warning, /26 h in the future/);
  assert.match(warning, /24 h shift/);
});

test('plausibility: it is a warning, never a rejection', () => {
  // A legitimate task in a week stays accepted: we report, we do not decide.
  const warning = checkScheduledAtPlausibility(INCIDENT_NOW + 7 * 24 * H, INCIDENT_NOW);
  assert.ok(warning);
  assert.match(warning, /created anyway/);
  assert.equal(validateScheduledAt(INCIDENT_NOW + 7 * 24 * H).ok, true);
});

test('scheduled_at missing or null: accepted, no value', () => {
  assert.deepEqual(validateScheduledAt(undefined), { ok: true, value: undefined });
  assert.deepEqual(validateScheduledAt(null), { ok: true, value: null });
});

test('scheduled_at in ms: accepted as is', () => {
  assert.deepEqual(validateScheduledAt(T_2026), { ok: true, value: T_2026 });
});

test('scheduled_at as an ISO string: rejected (the case of the 2026-08-06 incident)', () => {
  const r = validateScheduledAt('2026-01-01');
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /milliseconds/);
  assert.equal(validateScheduledAt('2026-01-01T02:00:00Z').ok, false);
});

test('scheduled_at not finite or not numeric: rejected', () => {
  for (const bad of [NaN, Infinity, -Infinity, true, {}, [], '']) {
    assert.equal(validateScheduledAt(bad).ok, false, `expected a rejection for ${JSON.stringify(bad)}`);
  }
});

test('scheduled_at in seconds: rejected (otherwise a silent immediate dispatch)', () => {
  const r = validateScheduledAt(Math.floor(T_2026 / 1000));
  assert.equal(r.ok, false);
  assert.match((r as { error: string }).error, /seconds/);
});

test('normalizeCwd: trailing slash and empty', () => {
  assert.equal(normalizeCwd('/home/user/p/'), '/home/user/p');
  assert.equal(normalizeCwd('/home/user/p'), '/home/user/p');
  assert.equal(normalizeCwd('  '), null);
  assert.equal(normalizeCwd(null), null);
  assert.equal(normalizeCwd(undefined), null);
});

const BASE = {
  slug: 'mail-watch',
  role: 'code',
  agent: 'TIMON.coder',
  agentExists: true,
  agentCwd: '/home/user/webdev/projects/legacy-os',
  projectCwd: '/home/user/webdev/projects/mail-watch',
};

test('an agent of another repository assigned to a role: rejected', () => {
  const err = checkRoleAgentCwd(BASE);
  assert.ok(err);
  assert.match(err!, /TIMON\.coder/);
  assert.match(err!, /mail-watch/);
});

test('identical cwds (up to the trailing slash): accepted', () => {
  assert.equal(
    checkRoleAgentCwd({ ...BASE, agentCwd: '/home/user/webdev/projects/mail-watch/' }),
    null,
  );
});

test('force: true passe outre le mismatch', () => {
  assert.equal(checkRoleAgentCwd({ ...BASE, force: true }), null);
});

test('missing agent, or cwd missing on one side: nothing to check', () => {
  assert.equal(checkRoleAgentCwd({ ...BASE, agentExists: false }), null);
  assert.equal(checkRoleAgentCwd({ ...BASE, agentCwd: null }), null);
  assert.equal(checkRoleAgentCwd({ ...BASE, projectCwd: null }), null);
});
