/**
 * `node --test --import tsx src/worktree-gc-guards.test.ts` (or `npm test`).
 *
 * The isolated guards are tested, not `worktree-gc.ts`: the latter imports
 * `db.js` and would open SQLite on load.
 *
 * The case that motivated these tests is the first one below: a worktree
 * deleted during the spawn of its own agent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyOrphan, isWithinGrace } from './worktree-gc-guards.js';

const GRACE = 30 * 60_000;
const NOW = 1_786_630_767_000;

test('a live task protects its worktree even without worktree_path in the database', () => {
  // The real race: the dispatcher created the folder, `known` was frozen
  // before the column was written. Deleting here kills the mission at spawn.
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: true, withinGrace: false }),
    'skip',
  );
});

test('the path claimed by a task stays protected', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: true, taskExists: false, withinGrace: false }),
    'skip',
  );
});

test('a young folder is kept, not deleted: the next pass will judge again', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: false, withinGrace: true }),
    'grace',
  );
});

test('without a task or grace, the folder becomes a candidate', () => {
  assert.equal(
    classifyOrphan({ isKnownPath: false, taskExists: false, withinGrace: false }),
    'candidate',
  );
});

test('isWithinGrace: a folder created just now is within the grace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gc-'));
  try {
    assert.equal(isWithinGrace(dir, GRACE, Date.now()), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isWithinGrace: a folder older than the grace leaves it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-gc-'));
  try {
    const old = (Date.now() - 2 * GRACE) / 1000;
    utimesSync(dir, old, old);
    assert.equal(isWithinGrace(dir, GRACE, Date.now()), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isWithinGrace: an unreadable path is deemed young, we abstain', () => {
  assert.equal(isWithinGrace(join(tmpdir(), 'timon-gc-absent-xyz'), GRACE, NOW), true);
});
