/**
 * Detection of a usage limit in the stream of a backend.
 *
 * What is checked here has a real cost when it breaks: an unrecognised
 * limit makes the mission classed "crash", hence dead and not resumable,
 * while it is just waiting for a quota.
 *
 * `node --test --import tsx src/rate-limit.test.ts`
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bestRateLimit, rateLimitFromEvent, isRateLimitText, isExhaustedText } from './rate-limit.js';

const QUOTA_MSG =
  'You’ve reached your free Grok Build usage limit for now. '
  + 'Get SuperGrok for much higher limits, or try again later: https://grok.com/supergrok';

test('the quota message is recognised whatever field carries it', () => {
  // claude/codex shape: a string on `error`.
  assert.ok(rateLimitFromEvent('result', { is_error: true, error: QUOTA_MSG }));
  // grok shape: an `errors` ARRAY. Without this branch, a mission
  // simply out of quota was classed "crash".
  assert.ok(rateLimitFromEvent('result', { is_error: true, errors: [QUOTA_MSG] }));
  // The array can mix noise and the real message.
  assert.ok(rateLimitFromEvent('result', {
    is_error: true,
    errors: ['tool failed', QUOTA_MSG],
  }));
});

test('the source is indeed "text": neither a window nor a reopening time', () => {
  const hit = rateLimitFromEvent('result', { is_error: true, errors: [QUOTA_MSG] });
  assert.equal(hit?.source, 'text');
  assert.equal(hit?.window, null);
  // A `textual` dialect never says WHEN: inventing a resume time
  // would reschedule a mission on a wrong value.
  assert.equal(hit?.resetsAt, null);
  assert.equal(hit?.pending, false);
});

test('a quota and an exhausted balance are two distinct families', () => {
  // Full window: it will reopen on its own.
  assert.equal(rateLimitFromEvent('result', { is_error: true, error: QUOTA_MSG })?.kind, 'rate_limit');
  assert.equal(
    rateLimitFromEvent('result', { is_error: true, api_error_status: 429 })?.kind,
    'rate_limit',
  );
  // Exhausted balance: nothing reopens without a top-up. The structured
  // status is the reference detection: an integer survives a
  // rewording by the provider, a regex does not.
  const dry = rateLimitFromEvent('result', { is_error: true, api_error_status: 402 });
  assert.equal(dry?.kind, 'exhausted');
  assert.equal(dry?.source, 'status');
  assert.equal(dry?.resetsAt, null);
});

test('an ordinary error does not pass itself off as a quota', () => {
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: ['ENOENT: no such file'] }), null);
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: [] }), null);
  // An `errors` that is not an array must not bring the probe down.
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: 'boom' }), null);
  assert.equal(rateLimitFromEvent('result', { is_error: true, errors: [null, 42] }), null);
  // A result WITHOUT an error is not inspected.
  assert.equal(rateLimitFromEvent('result', { is_error: false, errors: [QUOTA_MSG] }), null);
});

test('the usual wordings of the three CLIs are covered', () => {
  for (const msg of [
    'You’ve reached your free Grok Build usage limit for now',
    'Claude usage limit reached, try again later',
    '429 Too Many Requests',
    'rate limit exceeded',
    'quota exceeded for this org',
  ]) {
    assert.ok(isRateLimitText(msg), `not recognised: ${msg}`);
  }
  assert.equal(isRateLimitText('permission denied'), false);
  assert.equal(isRateLimitText(undefined), false);
});

test('the exact payload of the 2026-09-01 incident is recognised as an exhausted balance', () => {
  // Reproduces to the byte the `result` event received that night. The 402 is
  // neither a field nor a known sentence: it is buried in a STRING of
  // `errors[]`. Five missions died in 295 ms without any cooldown being
  // set; `backend_cooldowns` stayed empty all night.
  const payload = {
    type: 'result', subtype: 'error_during_execution', is_error: true,
    num_turns: 0, duration_ms: 295, total_cost_usd: 0,
    usage: { input_tokens: 0, output_tokens: 0 },
    errors: ['Internal error: {\n  "message": "API error (status 402 Payment Required): '
      + 'Grok Build usage balance exhausted",\n  "http_status": 402\n}'],
  };
  const hit = rateLimitFromEvent('result', payload);
  assert.notEqual(hit, null);
  assert.equal(hit?.kind, 'exhausted');
  // The textual net knows nothing more: neither a window nor a reopening.
  assert.equal(hit?.source, 'text');
  assert.equal(hit?.resetsAt, null);
});

test('the vocabulary of the exhausted balance is covered, without swallowing neighbouring errors', () => {
  for (const msg of [
    'API error (status 402 Payment Required)',
    'Payment Required',
    'insufficient credit on this account',
    'insufficient_quota',
    'Grok Build usage balance exhausted',
    'you are out of credits',
  ]) {
    assert.ok(isExhaustedText(msg), `not recognised: ${msg}`);
  }
  // `billing` alone is not enough: unlike a full window, an
  // `exhausted` sets the backend aside for the whole account and for 24 h; a task
  // coding a billing feature must not trigger that.
  assert.equal(isExhaustedText('TypeError in billing.ts'), false);
  // Same reason for the bare number: `:` is a word boundary, so `\b402\b`
  // would match the line number of any stack trace set in
  // `errors[]`. The 402 is only kept next to its label.
  assert.equal(isExhaustedText('Internal error: crash at /src/agent.ts:402:15'), false);
  assert.ok(isExhaustedText('{"http_status": 402}'));
  assert.equal(isExhaustedText('permission denied'), false);
  assert.ok(isExhaustedText('billing issue: card declined'));

  // An exhausted balance sentence that ALSO holds the word "limit" stays an
  // exhausted balance: reclassing it as a quota would schedule an impossible resume.
  const mixed = rateLimitFromEvent('result', {
    is_error: true,
    errors: ['usage limit reached', 'payment required: balance exhausted'],
  });
  assert.equal(mixed?.kind, 'exhausted');
});

test('a model at capacity is recognised, and is not read as a quota', async () => {
  const { isOverloadedEvent } = await import('./rate-limit.js');
  // Codex, as persisted on 05/10/2026 for three dead reviews.
  const codex = {
    is_error: true,
    error: 'Selected model is at capacity. Please try a different model.',
  };
  assert.equal(isOverloadedEvent('result', codex), true);
  assert.equal(rateLimitFromEvent('result', codex), null, 'a full model is not a usage limit');
  // Anthropic: the structured status, then the error type in text.
  assert.equal(isOverloadedEvent('result', { is_error: true, api_error_status: 529 }), true);
  assert.equal(isOverloadedEvent('result', { is_error: true, errors: ['x', 'overloaded_error: Overloaded'] }), true);
  // Only an error result counts: an assistant talking about overloading does not.
  assert.equal(isOverloadedEvent('result', { is_error: false, error: 'at capacity' }), false);
  assert.equal(isOverloadedEvent('assistant', { is_error: true, error: 'at capacity' }), false);
  assert.equal(isOverloadedEvent('result', { is_error: true, error: 'TypeError: x is undefined' }), false);
});

/** A turn that ended without an error flag, as a codec with no status to
 *  translate emits it. */
const answered = (result: string): Record<string, unknown> => ({
  type: 'result', subtype: 'success', is_error: false, result, stop_reason: 'end_turn', total_cost_usd: 0,
});

test('a quota notice printed as the answer of a turn that did not fail is a hit', () => {
  const at = Date.UTC(2026, 10, 21, 12, 0, 0);
  // Antigravity, as persisted on 2026-11-21: 31 turns closed as successes.
  const notices: Array<[string, number]> = [
    ['\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 29m12s.\n', (29 * 60 + 12) * 1000],
    ['\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 1h18m49s.\n', (3600 + 18 * 60 + 49) * 1000],
    ['\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 36m0s.\n', 36 * 60 * 1000],
  ];
  for (const [text, delay] of notices) {
    const hit = rateLimitFromEvent('result', answered(text), at);
    assert.equal(hit?.kind, 'rate_limit', text);
    assert.equal(hit?.source, 'text');
    assert.equal(hit?.pending, false);
    // The duration is counted from the event, which is what makes the retry exact.
    assert.equal(hit?.resetsAt, at + delay);
  }
  // Other wordings of the same notice, with or without a reopening time.
  for (const text of [
    'Error: rate limit exceeded. Try again later.',
    'Usage limit reached.',
    'Warning - quota exhausted, resets at 3pm',
    "You've hit your usage limit. Upgrade your plan to continue.",
    'Request refused by the provider: too many requests, try again in 30s.',
  ]) {
    assert.equal(rateLimitFromEvent('result', answered(text), at)?.kind, 'rate_limit', text);
  }
  // No duration named: the reopening stays unknown, never guessed.
  assert.equal(rateLimitFromEvent('result', answered('Usage limit reached.'), at)?.resetsAt, null);
  assert.equal(rateLimitFromEvent('result', answered('Quota reached. Resets in 2d 3h.'), at)?.resetsAt, at + 51 * 3600 * 1000);
  // A dry account announced the same way is not downgraded to a window.
  assert.equal(
    rateLimitFromEvent('result', answered('Quota exceeded: insufficient credits. Upgrade your plan.'), at)?.kind,
    'exhausted',
  );
});

test('an answer that merely talks about a quota is not a hit', () => {
  const report = [
    '## Summary',
    'I traced the stalled tasks to the provider notice. The log shows',
    '"⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 29m12s."',
    'thirty-one times that day, each closing its turn as a success.',
    'The detector now reads that text, and the fallback backend takes over.',
    'x'.repeat(200),
  ].join('\n');
  for (const text of [
    report,
    'Added rate limiting middleware to the API.',
    'Done. The quota check now runs before each request.',
    'Quota exceeded means that the account has used up its allowance for the period.',
    'The rate limit is reached after 100 requests per minute, as configured in limits.ts.',
    'I fixed the handler that returned "too many requests" for every call.',
    '',
  ]) {
    assert.equal(rateLimitFromEvent('result', answered(text)), null, text.slice(0, 60));
  }
  // Only the closing `result` is read: the assistant message carrying the same
  // text is the model's voice as far as this module knows.
  assert.equal(rateLimitFromEvent('assistant', answered('⚠ Individual quota reached. Resets in 29m12s.')), null);
  // No text at all (a codec that does not copy the answer): nothing to read.
  assert.equal(rateLimitFromEvent('result', { type: 'result', subtype: 'success', is_error: false }), null);
});

test('a persisted notice counts its reopening from the date of the event', () => {
  const at = Date.UTC(2026, 10, 21, 12, 0, 0);
  // The autopsy runs when the reaper finalises the mission, minutes later.
  const hit = bestRateLimit([
    { type: 'result', payload: answered('⚠ Individual quota reached. Resets in 29m12s.'), timestamp: at },
  ]);
  assert.equal(hit?.resetsAt, at + (29 * 60 + 12) * 1000);
});
