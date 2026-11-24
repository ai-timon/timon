import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRetryLoad, giveUpMessage, RELOAD_BUDGET_MS } from './window-load.js';

const base = { errorCode: -102, isMainFrame: true, elapsedMs: 0 };

test('a refused connection on the main frame is retried', () => {
  // The exact case of the first packaged launch: the daemon is up, Next is not.
  assert.equal(shouldRetryLoad(base), true);
});

test('a sub-resource failure never reloads the window', () => {
  // A missing icon must not restart the whole page under the user.
  assert.equal(shouldRetryLoad({ ...base, isMainFrame: false }), false);
});

test('an aborted navigation is left alone', () => {
  // -3 is what the app replacing its own location looks like.
  assert.equal(shouldRetryLoad({ ...base, errorCode: -3 }), false);
});

test('a real HTTP-level failure is not a "not yet"', () => {
  assert.equal(shouldRetryLoad({ ...base, errorCode: -300 }), false);
});

test('retries stop at the budget instead of looping forever', () => {
  assert.equal(shouldRetryLoad({ ...base, elapsedMs: RELOAD_BUDGET_MS - 1 }), true);
  assert.equal(shouldRetryLoad({ ...base, elapsedMs: RELOAD_BUDGET_MS }), false);
});

test('giving up names the address and the delay', () => {
  assert.equal(giveUpMessage('http://127.0.0.1:3110', 'en'), 'http://127.0.0.1:3110 did not answer within 120s.');
  assert.equal(giveUpMessage('http://127.0.0.1:3110', 'fr-FR'), 'http://127.0.0.1:3110 n’a pas répondu en 120 s.'); // french-ok: the French locale under test
});
