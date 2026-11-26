/**
 * The catch-up section's pure parts: the progress percentage and the final
 * line of a job, with the reason it ended early when it did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillPercent, backfillSummary, type BackfillJob } from './title-backfill-settings';

const job: BackfillJob = { jobId: 'j', status: 'done', targeted: 5, processed: 5, written: 5, skipped: 0, errored: 0, cancelRequested: false, lastError: null };

test('a finished job reports what was written', () => {
  assert.equal(backfillSummary(job), 'Conversations titled: 5 of 5.');
});

test('a job stopped by quota, the off switch, a cancel or a failure says so', () => {
  assert.match(backfillSummary({ ...job, status: 'stopped_quota', written: 2 }), /^Conversations titled: 2 of 5\. Stopped early: the title model is out of quota\.$/);
  assert.match(backfillSummary({ ...job, status: 'stopped_off', written: 0 }), /turned off\.$/);
  assert.match(backfillSummary({ ...job, status: 'cancelled', written: 3 }), /Cancelled\.$/);
  assert.match(backfillSummary({ ...job, status: 'failed' }), /The run failed\.$/);
});

test('the percentage is bounded and an empty run reads as complete', () => {
  assert.equal(backfillPercent({ targeted: 4, processed: 1 }), 25);
  assert.equal(backfillPercent({ targeted: 4, processed: 9 }), 100);
  assert.equal(backfillPercent({ targeted: 0, processed: 0 }), 100);
});
