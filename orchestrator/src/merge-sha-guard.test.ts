/**
 * Merge guard: a `merge` task only goes DONE with a full merge sha.
 *
 * What is at stake is the error message, not only the refusal: when an agent
 * REALLY merged but reported an abbreviated sha, a mute refusal sends it looking for
 * a merge that already exists. Three agents took turns on one series on
 * 2026-08-20 without ever understanding what was missing.
 *
 * `node --test --import tsx src/merge-sha-guard.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-merge-guard-test-'));
const { dbApi } = await import('./db.js');

function mergeTask(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'merge — un volet', 'p.merger', { type: 'merge' });
  return id;
}

test('a full sha in the comment is enough to close, even without --merged-sha', () => {
  const id = mergeTask();
  const sha = 'fe2dd843d282d2a8238ce465417a973652aed9c3';
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: `Merge effectué sur main (${sha}).` }); // french-ok: a free-text comment
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.merged_commit_sha, sha);
});

test('an abbreviated sha is refused, but the reason says what to do', () => {
  const id = mergeTask();
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'Merge effectué manuellement (fe2dd84).' }); // french-ok: a free-text comment
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  // Without these two elements, the agent rereads "the sha is missing" while it just
  // gave one: that is the incomprehensible refusal that made the task loop.
  assert.match(t?.blocked_reason ?? '', /ABBREVIATED SHA/);
  assert.match(t?.blocked_reason ?? '', /git rev-parse fe2dd84/);
});

test('without any sha, the reason recalls the base command', () => {
  const id = mergeTask();
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'Tout est intégré, rien à signaler.' }); // french-ok: a free-text comment
  const t = dbApi.getTask(id);
  assert.equal(t?.status, 'BLOCKED');
  assert.match(t?.blocked_reason ?? '', /git rev-parse HEAD/);
});
