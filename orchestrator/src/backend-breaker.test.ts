/**
 * Circuit breaker: three sterile turns in a row sideline a backend WITHOUT
 * anyone reading its error message.
 *
 * The reference payload is the one from the night of 2026-09-01 (grok out of
 * credit), stripped of its `errors[]`: what is verified here is precisely that
 * the sentence is not needed. Same shape, same verdict, whatever the provider
 * writes — that is what makes this net catch the `Not signed in` incident too.
 *
 * `node --test --import tsx src/backend-breaker.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-breaker-test-'));
process.env.TIMON_BREAKER_ENABLED = '1';
process.env.TIMON_BREAKER_THRESHOLD = '3';
process.env.TIMON_BREAKER_WINDOW_MS = '600000';
process.env.TIMON_BREAKER_STERILE_MS = '2000';

const {
  sterileResultSignature, sterileExitSignature, noteSterileTurn,
  noteProductiveTurn, breakerFailures, resetBreakers, isAuthFailureEvent,
} = await import('./backend-breaker.js');

/** The incident's `result`, WITHOUT its error message: the breaker must not
 *  need it. Only the shape is left. */
const bounce = (over: Record<string, unknown> = {}) => ({
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 295,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  ...over,
});

test('a sterile result is recognised without reading any error message', () => {
  assert.equal(sterileResultSignature('result', bounce()), '0 turn / 0 token / 295 ms');
});

test('three consecutive sterile results trip the circuit breaker, not two', () => {
  resetBreakers();
  const sig = sterileResultSignature('result', bounce())!;
  assert.equal(noteSterileTurn('grok', sig, 1_000), null);
  assert.equal(noteSterileTurn('grok', sig, 2_000), null);
  const trip = noteSterileTurn('grok', sig, 3_000);
  assert.ok(trip, 'the threshold of 3 must trip');
  assert.equal(trip.backend, 'grok');
  assert.equal(trip.failures, 3);
  assert.equal(trip.threshold, 3);
  assert.equal(trip.spanMs, 2_000);
  assert.equal(trip.signature, '0 turn / 0 token / 295 ms');
  // Beyond the threshold, each new bounce trips again: the 4th mission that
  // dies deserves the same qualification as the 3rd.
  assert.ok(noteSterileTurn('grok', sig, 4_000));
});

test('the counters are per backend: grok running dry does not set claude aside', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 1_000);
  noteSterileTurn('grok', sig, 2_000);
  assert.equal(noteSterileTurn('claude', sig, 3_000), null);
  assert.equal(breakerFailures('claude', 3_000), 1);
  assert.ok(noteSterileTurn('grok', sig, 3_000));
});

test('a turn that succeeds resets the counter to zero', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 1_000);
  noteSterileTurn('grok', sig, 2_000);
  noteProductiveTurn('grok');
  assert.equal(breakerFailures('grok', 2_500), 0);
  assert.equal(noteSterileTurn('grok', sig, 3_000), null);
});

test('the window slides: two failures from an hour ago no longer count', () => {
  resetBreakers();
  const sig = '0 turn / 0 token / 295 ms';
  noteSterileTurn('grok', sig, 0);
  noteSterileTurn('grok', sig, 1_000);
  // An hour later, the 10 min window has forgotten everything.
  assert.equal(noteSterileTurn('grok', sig, 3_600_000), null);
  assert.equal(breakerFailures('grok', 3_600_000), 1);
});

test('a productive turn is never sterile, however fast it ends', () => {
  // A produced token proves the provider worked.
  assert.equal(sterileResultSignature('result', bounce({ usage: { input_tokens: 12, output_tokens: 0 } })), null);
  // A cost too.
  assert.equal(sterileResultSignature('result', bounce({ total_cost_usd: 0.004 })), null);
  // A real one-turn answer: tokens produced, so the turn counts as work.
  assert.equal(sterileResultSignature('result', bounce({
    num_turns: 1, usage: { input_tokens: 5_000, output_tokens: 180 }, total_cost_usd: 0.02,
  })), null);
  // More than one turn means the CLI went round the loop: not a bounce.
  assert.equal(sterileResultSignature('result', bounce({ num_turns: 2 })), null);
  // Too long to be a bounce.
  assert.equal(sterileResultSignature('result', bounce({ duration_ms: 240_000 })), null);
  // A sterile success says nothing about the health of the backend.
  assert.equal(sterileResultSignature('result', bounce({ is_error: false })), null);
});

/** The claude CLI's `result` on an expired OAuth session (mission 49c90448,
 *  2026-09-17), fields kept as recorded. */
const AUTH_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  num_turns: 1,
  duration_ms: 45,
  duration_api_ms: 0,
  total_cost_usd: 0,
  terminal_reason: 'api_error',
  usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
};

test('a bounce at num_turns: 1 without a token is sterile (expired OAuth, claude)', () => {
  assert.equal(sterileResultSignature('result', AUTH_RESULT), '1 turn / 0 token / 45 ms');
  // With no usage block, the zero tokens would be assumed rather than observed.
  const { usage, ...noUsage } = AUTH_RESULT;
  assert.equal(sterileResultSignature('result', noUsage), null);
});

test('an auth failure is read on the structured field, never on the text', () => {
  const synthetic = {
    type: 'assistant',
    error: 'authentication_failed',
    message: { model: '<synthetic>', content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }] },
  };
  assert.equal(isAuthFailureEvent('assistant', synthetic), true);
  // The same sentence without the code proves nothing: a model may well write it.
  const { error, ...textOnly } = synthetic;
  assert.equal(isAuthFailureEvent('assistant', textOnly), false);
  assert.equal(isAuthFailureEvent('assistant', { ...synthetic, error: 'server_error' }), false);
  assert.equal(isAuthFailureEvent('result', synthetic), false);
});

test('an auth failure trips at the first bounce, a mute bounce does not', () => {
  resetBreakers();
  const sig = sterileResultSignature('result', AUTH_RESULT)!;
  assert.equal(noteSterileTurn('claude', sig, 1_000), null, 'a shapeless bounce still needs the threshold');
  resetBreakers();
  const trip = noteSterileTurn('claude', sig, 1_000, 'auth');
  assert.ok(trip, 'an authentication failure does not heal: one is enough');
  assert.equal(trip.cause, 'auth');
  assert.equal(trip.threshold, 1);
});

test('a dialect mute on num_turns or duration_ms is never read as a bounce', () => {
  // A missing field ≠ zero: without this rule, any backend that does not report
  // these counters would be set aside after three perfectly healthy turns.
  const { num_turns, ...noTurns } = bounce();
  assert.equal(sterileResultSignature('result', noTurns), null);
  const { duration_ms, ...noDuration } = bounce();
  assert.equal(sterileResultSignature('result', noDuration), null);
  assert.equal(sterileResultSignature('assistant', bounce()), null);
  assert.equal(sterileResultSignature('result', null), null);
});

test('a process dead before its first result counts as a bounce too', () => {
  assert.equal(sterileExitSignature(300), 'no result / 300 ms');
  assert.equal(sterileExitSignature(240_000), null);
});
