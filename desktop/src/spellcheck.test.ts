import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepDictionariesLocal, NO_DICTIONARY_URL, type SpellCheckSession } from './spellcheck.js';

function witness(): SpellCheckSession & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    setSpellCheckerEnabled: (enable) => { calls.push(`enabled=${enable}`); },
    setSpellCheckerDictionaryDownloadURL: (url) => { calls.push(`url=${url}`); },
  };
}

test('Linux: no dictionary download, and the checker that needs it is off', () => {
  const session = witness();
  keepDictionariesLocal(session, 'linux');
  assert.deepEqual(session.calls, [`url=${NO_DICTIONARY_URL}`, 'enabled=false']);
});

test('Windows: the native checker stays on, the fallback download stays on the machine', () => {
  const session = witness();
  keepDictionariesLocal(session, 'win32');
  assert.deepEqual(session.calls, [`url=${NO_DICTIONARY_URL}`]);
});

test('macOS: the system checker is left alone', () => {
  const session = witness();
  keepDictionariesLocal(session, 'darwin');
  assert.deepEqual(session.calls, []);
});

test('the download URL is the loopback, never a remote host', () => {
  assert.equal(new URL(NO_DICTIONARY_URL).hostname, '127.0.0.1');
});
