/**
 * The notice of a cut turn is all the thread says about why the answer
 * stopped. A turn cut by a daemon restart (boot sweep, TIM-0119) must say so,
 * not read like the user's own stop.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnInterruptedNotice } from './turn-interrupted-notice';
import { loadLocale, setLocale } from './i18n';
import './i18n-test-locales';

test('a turn the daemon restart cut names the restart and says the chat can resume', () => {
  setLocale('en');
  const notice = turnInterruptedNotice({ resumable: true, turn_active: true, reason: 'daemon_restarted' });
  assert.match(notice, /restarted/);
  assert.match(notice, /resumable/);
  assert.doesNotMatch(notice, /chatPage\./, 'unresolved i18n key');
});

test('a user interruption keeps its wording', () => {
  setLocale('en');
  assert.equal(
    turnInterruptedNotice({ resumable: false, turn_active: true }),
    "turn interrupted — HARD STOP: this backend can't resume its session, the next message will start from scratch",
  );
  assert.match(turnInterruptedNotice({ resumable: true, turn_active: false }), /^process stopped/);
});

test('a steered turn says the agent goes on with the instruction, never that it stopped', () => {
  setLocale('en');
  const notice = turnInterruptedNotice({ resumable: true, turn_active: true, reason: 'steered' });
  assert.match(notice, /redirected/);
  assert.doesNotMatch(notice, /interrupted|HARD STOP/);
});

test('the restart notice follows the locale', async () => {
  await loadLocale('fr');
  try {
    assert.match(turnInterruptedNotice({ resumable: true, reason: 'daemon_restarted' }), /redémarré/); // french-ok: the French locale under test
  } finally {
    setLocale('en');
  }
});
