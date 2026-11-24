import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../i18n-test-locales';
import { getLocale, setLocale } from '../i18n';
import { sessionError } from './use-gpt-live';

function inLocale<T>(tag: string, run: () => T): T {
  const before = getLocale();
  setLocale(tag);
  try { return run(); } finally { setLocale(before); }
}

test('the settings cases keep their own sentence, from the new codes and the old ones', () => {
  inLocale('en', () => {
    for (const code of ['gpt_live_disabled', 'disabled']) assert.match(sessionError({ code }, 409), /GPT-Live is disabled in /);
    for (const code of ['gpt_live_no_key', 'no-key']) assert.match(sessionError({ code, params: { secret: 'K' } }, 409), /No GPT-Live API key/);
    assert.equal(sessionError({ code: 'gpt_live_bad_key' }, 502), sessionError({ code: 'bad-key' }, 502));
  });
});

test('another refusal reads its translated route error, params filled, no brace left', () => {
  const body = { error: 'OpenAI refused the session (HTTP 500)', code: 'gpt_live_refused', params: { status: 500 } };
  const english = inLocale('en', () => sessionError(body, 502));
  assert.equal(english, 'The voice conversation could not start: OpenAI refused the voice session (HTTP 500).');
  const french = inLocale('fr', () => sessionError(body, 502));
  assert.match(french, /HTTP 500/);
  assert.doesNotMatch(french, /[{}]/);
  assert.equal(inLocale('en', () => sessionError({}, 502)), 'The voice conversation could not start: HTTP 502');
});
