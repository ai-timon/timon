import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretAnswerError } from './secret-requests';

test('a refused answer is read from the daemon code', () => {
  assert.equal(secretAnswerError({ error: 'this secret request was already answered', code: 'secret_request_decided' }), 'already_decided');
  assert.equal(secretAnswerError({ error: 'this secret request expired', code: 'secret_request_expired' }), 'expired');
  assert.equal(secretAnswerError({ error: 'a secret request is answered from a browser session', code: 'secret_request_session_required' }), 'session_required');
});

test('an older daemon\'s bare name in `error` still reads, anything else names nothing', () => {
  assert.equal(secretAnswerError({ error: 'not_stored' }), 'not_stored');
  assert.equal(secretAnswerError({ error: 'boom', code: 'something_else' }), null);
  assert.equal(secretAnswerError(null), null);
});
