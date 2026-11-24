import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHistoryPurgedDays, purgeNotice } from './mission-history-purge';

test('the marker is read defensively: only a positive whole number of days counts', () => {
  assert.equal(parseHistoryPurgedDays({ history_purged_days: 180 }), 180);
  assert.equal(parseHistoryPurgedDays({ history_purged_days: null }), null);
  assert.equal(parseHistoryPurgedDays({}), null, 'an older daemon sends nothing');
  assert.equal(parseHistoryPurgedDays({ history_purged_days: '30' }), null);
  assert.equal(parseHistoryPurgedDays({ history_purged_days: 0 }), null);
  assert.equal(parseHistoryPurgedDays({ history_purged_days: 1.5 }), null);
});

test('a purged mission with no message left says why, a mission never purged says nothing', () => {
  assert.deepEqual(purgeNotice(30, 0, false), { key: 'chatSurface.historyPurged', days: 30 });
  assert.equal(purgeNotice(null, 0, false), null, 'the usual empty mission keeps its own text');
  assert.equal(purgeNotice(null, 4, false), null);
});

test('a purged conversation resumed later says its start is gone, once its start is on screen', () => {
  assert.deepEqual(purgeNotice(30, 3, false), { key: 'chatSurface.historyPurgedEarlier', days: 30 });
  assert.equal(purgeNotice(30, 3, true), null, 'older pages to load are not the purged part yet');
});
