/**
 * Landing guard of the dependency gate (`docs/KANBAN-PR-PIPELINE.md` §2.7): a
 * dependency integrated into an integration branch frees a dependent of
 * another base only once that branch landed. Pure: lookups injected.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TaskType } from './db.js';
import { evaluateDeps, type DepLanding } from './merge-gate.js';

const SHA = 'a'.repeat(40);

type Fake = { id: string; type: TaskType; status: string; done_comment: string | null; deps: string;
  base_branch: string | null; integration_mode: string | null; merged_commit_sha?: string | null };

function gate(dependentBase: string | null, landing: DepLanding) {
  const dep: Fake = {
    id: 'dep', type: 'merge', status: 'DONE', done_comment: 'merged', deps: '[]',
    base_branch: 'feat/topic', integration_mode: 'pr', merged_commit_sha: SHA,
  };
  return evaluateDeps(
    { type: 'code', deps: '["dep"]', base_branch: dependentBase },
    (id) => (id === 'dep' ? dep : undefined),
    () => [],
    () => [],
    () => landing,
  );
}

test('merge gate: a dependent of another base waits for the landing of its dependency', () => {
  const waiting = gate('main', 'integrated');
  assert.equal(waiting.ok, false);
  assert.ok(!waiting.ok && waiting.blockedReason === null, 'a wait, never BLOCKED');
  assert.match(!waiting.ok ? waiting.waitingFor ?? '' : '', /integrated into feat\/topic/);
  const closed = gate('main', 'closed');
  assert.match(!closed.ok ? closed.waitingFor ?? '' : '', /closed without a merge/);
  assert.equal(gate('main', 'landed').ok, true);
});

test('merge gate: the same job, or a dependent inheriting its base, does not wait', () => {
  assert.equal(gate('feat/topic', 'integrated').ok, true);
  assert.equal(gate(null, 'integrated').ok, true);
  assert.equal(gate('main', 'local').ok, true);
});
