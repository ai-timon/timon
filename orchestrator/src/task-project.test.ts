/**
 * Tests of the resolution of a task's project slug (task-project.ts).
 *
 * `node --test --import tsx src/task-project.test.ts` (or `npm test`). The tested
 * module is pure: no import opens the SQLite database or reads the disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectFromCwd, taskProjectSlug } from './task-project.js';

const HORS_PROJET = { project: null, cwd: '/home/user/scratch' };
const AGENT_TIMON = { project: 'timon', cwd: '/home/user/webdev/projects/timon' };

test("the task's explicit slug wins over the agent's", () => {
  assert.equal(taskProjectSlug({ project: 'globex' }, AGENT_TIMON), 'globex');
});

test('the explicit slug also wins over the one derived from the cwd', () => {
  assert.equal(
    taskProjectSlug({ project: 'globex' }, { project: null, cwd: '/workspace/projects/timon' }),
    'globex',
  );
});

test('an agent outside a project still receives the explicit slug', () => {
  // The production case that motivates the flag: without an explicit project → null, hence
  // no review/merge role resolved and a mute auto-chaining.
  assert.equal(taskProjectSlug({ project: null }, HORS_PROJET), null);
  assert.equal(taskProjectSlug({ project: 'timon' }, HORS_PROJET), 'timon');
});

test('without an explicit slug, the historical behaviour is unchanged', () => {
  assert.equal(taskProjectSlug({ project: null }, AGENT_TIMON), 'timon');
  assert.equal(
    taskProjectSlug({}, { project: null, cwd: '/home/user/webdev/projects/markets' }),
    'markets',
  );
  assert.equal(taskProjectSlug({ project: null }, null), null);
});

test('an empty explicit slug does not hide the derivation', () => {
  assert.equal(taskProjectSlug({ project: '' }, AGENT_TIMON), 'timon');
});

test('projectFromCwd conserve ses trois motifs', () => {
  assert.equal(projectFromCwd('/workspace/projects/timon/src'), 'timon');
  assert.equal(projectFromCwd('/home/user/webdev/projects/timon'), 'timon');
  assert.equal(projectFromCwd('/workspace/timon'), 'timon');
  assert.equal(projectFromCwd('/workspace'), null);
  assert.equal(projectFromCwd(null), null);
});
