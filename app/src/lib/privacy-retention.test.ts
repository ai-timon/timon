import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { retentionRowView, retentionStatus } from './privacy-retention';

const row = (over: Partial<Parameters<typeof retentionRowView>[0]> = {}) => ({
  key: 'TIMON_EVENTS_RETENTION_DAYS', value: 180, default: 180, source: 'default' as const, overridden: false, ...over,
});

test('the default reads as a duration, with nothing to reset', () => {
  const view = retentionRowView(row());
  assert.deepEqual(view, { days: 180, defaultDays: 180, lockedBy: null, canKeepAll: true, canReset: false });
  assert.deepEqual(retentionStatus('history', view), { key: 'privacySettings.history.after', values: { days: 180 }, lock: null });
});

test('0 keeps everything: no "keep everything" item, a way back to the default', () => {
  const view = retentionRowView(row({ value: 0, source: 'db', overridden: true }));
  assert.equal(view.canKeepAll, false);
  assert.equal(view.canReset, true);
  assert.deepEqual(retentionStatus('history', view), { key: 'privacySettings.history.forever', lock: null });
});

test('a value set by the environment or the config file is shown, not offered', () => {
  for (const source of ['env', 'config'] as const) {
    const view = retentionRowView(row({ value: 30, source, overridden: true }));
    assert.equal(view.lockedBy, source);
    assert.equal(view.canKeepAll, false);
    assert.equal(view.canReset, false);
    assert.equal(retentionStatus('learnings', view).lock, source === 'env' ? 'privacySettings.lockedEnv' : 'privacySettings.lockedConfig');
  }
});

test('the raw facts are kept by default', () => {
  const view = retentionRowView(row({ key: 'TIMON_LEARNINGS_RETENTION_DAYS', value: 0, default: 0 }));
  assert.deepEqual(retentionStatus('learnings', view), { key: 'privacySettings.learnings.forever', lock: null });
  assert.equal(view.defaultDays, 0);
});
