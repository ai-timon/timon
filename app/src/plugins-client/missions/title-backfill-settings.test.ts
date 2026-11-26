/**
 * The catch-up section's summary line: what a finished run says, and why it
 * stopped early when it did.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { backfillSummary } from './title-backfill-settings';

const run = { dryRun: false, targeted: 5, calls: 5, limit: 50, ceiling: 200 };

test('a complete run reports what was written', () => {
  assert.equal(backfillSummary({ ...run, written: 5, stopped: null }), 'Conversations titled: 5 of 5.');
});

test('a run stopped by quota or by the off switch says so', () => {
  assert.match(backfillSummary({ ...run, written: 2, stopped: 'quota' }), /^Conversations titled: 2 of 5\. Stopped early: the title model is out of quota\.$/);
  assert.match(backfillSummary({ ...run, written: 0, stopped: 'off' }), /turned off\.$/);
});
