import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resultErrorText, isRateLimitMessage } from './result-error.js';

/* Payloads copied from the TIMON database, not made up. */
const GROK_QUOTA = 'You’ve reached your free Grok Build usage limit for now. '
  + 'Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok';
const CLAUDE_SESSION = 'You\'ve hit your session limit · resets 9:10pm (Europe/Paris)';

test('grok: the message lives in an `errors` array', () => {
  assert.equal(
    resultErrorText({ type: 'result', is_error: true, errors: [GROK_QUOTA] }),
    GROK_QUOTA,
  );
  assert.ok(isRateLimitMessage(GROK_QUOTA));
});

test('claude: a string on `error`, or a short `result`', () => {
  assert.equal(resultErrorText({ is_error: true, error: 'overloaded' }), 'overloaded');
  assert.equal(resultErrorText({ is_error: true, result: CLAUDE_SESSION }), CLAUDE_SESSION);
  assert.ok(isRateLimitMessage(CLAUDE_SESSION));
});

test('a complete answer is not taken for an error', () => {
  // `result` carries the final text of the turn: spitting it back would double the bubble
  // that just showed it.
  assert.equal(resultErrorText({ is_error: true, result: 'x'.repeat(400) }), null);
  // But if the CLI named the error, we keep it whatever its length.
  assert.equal(
    resultErrorText({ is_error: true, error: 'y'.repeat(400), result: 'x'.repeat(400) }),
    'y'.repeat(400),
  );
});

test('a successful turn produces no message', () => {
  assert.equal(resultErrorText({ is_error: false, errors: [GROK_QUOTA] }), null);
  assert.equal(resultErrorText({ type: 'result' }), null);
  assert.equal(resultErrorText(null), null);
  assert.equal(resultErrorText('boom'), null);
});

test('degraded shapes do not break the read', () => {
  assert.equal(resultErrorText({ is_error: true, errors: 'pas un tableau' }), null);
  assert.equal(resultErrorText({ is_error: true, errors: [null, 42, '  '] }), null);
  assert.equal(resultErrorText({ is_error: true, errors: ['  ', 'vrai souci'] }), 'vrai souci');
  // Several errors on the same turn: all shown, not only the first.
  assert.equal(resultErrorText({ is_error: true, errors: ['a', 'b'] }), 'a · b');
});

test('outage ≠ quota: only the second changes the label shown', () => {
  assert.equal(isRateLimitMessage('ENOENT: no such file or directory'), false);
  assert.equal(isRateLimitMessage('permission denied'), false);
  assert.ok(isRateLimitMessage('429 Too Many Requests'));
});
