import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { t } from '@/lib/i18n';
import { ACTION_CLASS, actionLabel, missingTextKey } from './audit-labels';

test('every curation action, deletion included, has a label', () => {
  for (const action of Object.keys(ACTION_CLASS)) {
    assert.notEqual(actionLabel(action), action, action);
  }
  assert.equal(actionLabel('manual_delete'), '− deleted');
  assert.equal(actionLabel('a_newer_action'), 'a_newer_action');
});

test('a text deleted with its rule says so, instead of pointing at a rule that is gone', () => {
  assert.equal(t(missingTextKey({ rule_deleted: 1 })), 'Text deleted with the rule');
  assert.equal(missingTextKey({ rule_deleted: 0 }), 'memoryPage.noCandidateText');
  assert.equal(missingTextKey({}), 'memoryPage.noCandidateText');
});
