/**
 * `dbApi.listVerificationChain` — what the code-dependency guard (merge-gate.ts)
 * reads to know whether a `code` task's chain has reached its merge.
 *
 * The root code task has no `verification_root_id` and the verification-loop
 * never tags a `merge`: the lookup must still return both.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-chain-lookup-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { evaluateDeps } = await import('./merge-gate.js');

test('listVerificationChain: root, reviews, iterations and merges (unlabelled)', () => {
  dbApi.createTask('c1', 'feat', 'a', { type: 'code' });
  dbApi.createTask('r1', 'review 1', 'a', { type: 'review', deps: ['c1'] });
  dbApi.setTaskVerificationMeta('r1', 1, 'c1');
  dbApi.createTask('c2', 'feat [iter:2]', 'a', { type: 'code', deps: ['r1'] });
  dbApi.setTaskVerificationMeta('c2', 2, 'c1');
  dbApi.createTask('r2', 'review 2', 'a', { type: 'review', deps: ['c2'] });
  dbApi.setTaskVerificationMeta('r2', 2, 'c1');
  dbApi.createTask('m2', 'merge', 'a', { type: 'merge', deps: ['r2'] });
  // noise: another chain and an unrelated task
  dbApi.createTask('c9', 'autre', 'a', { type: 'code' });
  dbApi.createTask('r9', 'review autre', 'a', { type: 'review', deps: ['c9'] });
  dbApi.setTaskVerificationMeta('r9', 1, 'c9');

  const ids = dbApi.listVerificationChain('c1').map((t) => t.id).sort();
  assert.deepEqual(ids, ['c1', 'c2', 'm2', 'r1', 'r2']);
});

test('listVerificationChain: a review created by hand (unlabelled) attached through deps', () => {
  dbApi.createTask('h1', 'feat', 'a', { type: 'code' });
  dbApi.createTask('hr', 'review', 'a', { type: 'review', deps: ['h1'] });
  const ids = dbApi.listVerificationChain('h1').map((t) => t.id).sort();
  assert.deepEqual(ids, ['h1', 'hr']);
});

test('evaluateDeps on real rows: the dependent waits for the merge, then starts', () => {
  dbApi.createTask('g1', 'feat', 'a', { type: 'code', pipeline: 'full' });
  dbApi.updateTaskStatus('g1', 'DONE');
  dbApi.setTaskWorktree('g1', '/wt/g1', 'timon/task/g1', 'main');
  dbApi.createTask('gr', 'review', 'a', { type: 'review', deps: ['g1'] });
  dbApi.setTaskVerificationMeta('gr', 1, 'g1');
  dbApi.updateTaskStatus('gr', 'DONE', { doneComment: 'verdict: pass' });
  dbApi.createTask('gm', 'merge', 'a', { type: 'merge', deps: ['gr'] });
  dbApi.createTask('next', 'suite', 'a', { type: 'code', deps: ['g1'] });

  const gate = () => {
    const next = dbApi.getTask('next');
    assert.ok(next);
    return evaluateDeps(next, (id) => dbApi.getTask(id), (root) => dbApi.listTasksByVerificationRoot(root), (root) => dbApi.listVerificationChain(root));
  };
  assert.equal(gate().ok, false);
  // A merge only reaches DONE with a full sha (guardMergeDone).
  dbApi.updateTaskStatus('gm', 'DONE', { doneComment: `merged ${'a'.repeat(40)}` });
  assert.deepEqual(gate(), { ok: true });
});
