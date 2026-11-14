import assert from 'node:assert/strict';
import { test } from 'node:test';
import { secretEquals } from './constant-time';

test('equal secrets match', () => {
  assert.equal(secretEquals('the-master', 'the-master'), true);
});

test('a different secret of the same length, another length, or an empty one does not match', () => {
  assert.equal(secretEquals('the-masteR', 'the-master'), false);
  assert.equal(secretEquals('the-master-plus', 'the-master'), false);
  assert.equal(secretEquals('the', 'the-master'), false);
  assert.equal(secretEquals('', 'the-master'), false);
});
