import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backendFailureNotice } from './backend-failure-notice';
import { setLocale } from './i18n';
import './i18n-test-locales';

test('names the backend, the exit code and what it wrote', () => {
  setLocale('en');
  const notice = backendFailureNotice({ backend: 'copilot', exitCode: 1, stderr: 'Access denied\nby policy settings' });
  assert.match(notice, /copilot/);
  assert.match(notice, /exit code 1/);
  assert.match(notice, /Access denied by policy settings/, 'newlines collapse into one line');
  assert.doesNotMatch(notice, /chatPage\./, 'unresolved i18n key');
});

test('silent death or damaged payload: a readable sentence, never "undefined"', () => {
  setLocale('en');
  for (const payload of [{}, { backend: 'codex', stderr: '' }, { exitCode: null, stderr: 42 }]) {
    const notice = backendFailureNotice(payload);
    assert.doesNotMatch(notice, /undefined|null|chatPage\./);
    assert.match(notice, /stopped without answering/);
  }
});

test('a long stderr keeps its end and stays bounded; French is translated', () => {
  setLocale('en');
  const notice = backendFailureNotice({ backend: 'copilot', exitCode: 2, stderr: `${'a'.repeat(2000)} the real cause` });
  assert.ok(notice.length < 700);
  assert.match(notice, /the real cause$/);
  setLocale('fr');
  assert.match(backendFailureNotice({ backend: 'copilot', exitCode: 1 }), /s'est arrêté sans répondre/); // french-ok: the French locale under test
  setLocale('en');
});

test('the notice gives the mission id, and the session id once the backend announced one', () => {
  setLocale('en');
  try {
    const both = backendFailureNotice({ backend: 'copilot', exitCode: 1, missionId: 'm-1', sessionId: 's-9' });
    assert.match(both, /\nMission m-1 · session s-9$/);
    const missionOnly = backendFailureNotice({ backend: 'copilot', exitCode: 1, missionId: 'm-1', sessionId: null });
    assert.match(missionOnly, /\nMission m-1$/);
    assert.doesNotMatch(backendFailureNotice({ backend: 'copilot', exitCode: 1 }), /Mission/);
  } finally {
    setLocale('en');
  }
});
