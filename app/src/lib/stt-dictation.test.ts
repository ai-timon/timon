// french-ok-file: French dictation samples, the language the transcripts were captured in
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DICTATION_GRACE_MS,
  composeDictation,
  shouldRestartDictation,
  isFatalDictationError,
  sessionText,
  webSpeechWithoutEngine,
} from './stt-dictation';

test('a short hesitation restarts listening', () => {
  assert.equal(
    shouldRestartDictation({ stoppedByUser: false, fatalError: false, sinceLastActivity: 1_200 }),
    true,
  );
});

test('silence beyond the window ends the dictation', () => {
  assert.equal(
    shouldRestartDictation({
      stoppedByUser: false,
      fatalError: false,
      sinceLastActivity: DICTATION_GRACE_MS,
    }),
    false,
  );
});

test('a stop asked for by the user never restarts', () => {
  assert.equal(
    shouldRestartDictation({ stoppedByUser: true, fatalError: false, sinceLastActivity: 0 }),
    false,
  );
});

test('a fatal error cuts the restart loop', () => {
  assert.equal(
    shouldRestartDictation({ stoppedByUser: false, fatalError: true, sinceLastActivity: 0 }),
    false,
  );
});

test('the window can be set by the callers that tune it', () => {
  assert.equal(
    shouldRestartDictation({
      stoppedByUser: false,
      fatalError: false,
      sinceLastActivity: 900,
      graceMs: 500,
    }),
    false,
  );
});

test('microphone refused or taken = fatal, ordinary end of turn = not', () => {
  assert.equal(isFatalDictationError('not-allowed'), true);
  assert.equal(isFatalDictationError('audio-capture'), true);
  assert.equal(isFatalDictationError('service-not-allowed'), true);
  assert.equal(isFatalDictationError('no-speech'), false);
  assert.equal(isFatalDictationError('aborted'), false);
});

test('TIM-0061: an unreachable recognition service ends the dictation', () => {
  assert.equal(isFatalDictationError('network'), true);
  assert.equal(
    shouldRestartDictation({ stoppedByUser: false, fatalError: isFatalDictationError('network'), sinceLastActivity: 0 }),
    false,
  );
});

test('TIM-0061: Web Speech has no engine in the desktop app', () => {
  const electronWin =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) timon-desktop/0.1.3 Chrome/130.0.6723.191 Electron/33.2.0 Safari/537.36';
  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(webSpeechWithoutEngine({ userAgent: electronWin, desktopBridge: false }), true);
  assert.equal(webSpeechWithoutEngine({ userAgent: chrome, desktopBridge: true }), true);
  assert.equal(webSpeechWithoutEngine({ userAgent: chrome, desktopBridge: false }), false);
});

test('the fallback keeps the text already dictated and adds a space', () => {
  assert.equal(composeDictation('bonjour', 'tout le monde'), 'bonjour tout le monde');
  assert.equal(composeDictation('bonjour ', 'tout le monde'), 'bonjour tout le monde');
  assert.equal(composeDictation('', 'bonjour'), 'bonjour');
  assert.equal(composeDictation('bonjour', '   '), 'bonjour');
  assert.equal(composeDictation('', ''), '');
});

test('two final segments and an interim give the full sentence', () => {
  assert.equal(
    sessionText([
      { isFinal: true, transcript: 'bonjour' },
      { isFinal: true, transcript: 'tout le monde' },
      { isFinal: false, transcript: 'et bonne' },
    ]),
    'bonjour tout le monde et bonne',
  );
});

test('an advanced resultIndex loses nothing: we always start again from zero', () => {
  // What the engine sends after a pause: segment 0 is frozen, the index
  // points at the new one. The old loop only returned "la suite".
  const results = [
    { isFinal: true, transcript: 'le début de ma phrase' },
    { isFinal: false, transcript: 'la suite' },
  ];
  assert.equal(sessionText(results), 'le début de ma phrase la suite');
});

test('the interim of a turn replaces the one before without duplicating', () => {
  const finalise = { isFinal: true, transcript: 'bonjour' };
  assert.equal(sessionText([finalise, { isFinal: false, transcript: 'tou' }]), 'bonjour tou');
  assert.equal(sessionText([finalise, { isFinal: false, transcript: 'tout le' }]), 'bonjour tout le');
  assert.equal(
    sessionText([finalise, { isFinal: true, transcript: 'tout le monde' }]),
    'bonjour tout le monde',
  );
});

test('an engine that re-emits the whole sentence at each event does not duplicate it', () => {
  // Capture of 10/10: "salut salut comment salut comment ça salut comment ça va". french-ok: the captured transcript
  const copies = ['salut', 'salut comment', 'salut comment ça', 'salut comment ça va'];
  assert.equal(
    sessionText(copies.map((transcript) => ({ isFinal: true, transcript }))),
    'salut comment ça va',
  );
  assert.equal(
    sessionText([
      ...copies.slice(0, 3).map((transcript) => ({ isFinal: true, transcript })),
      { isFinal: false, transcript: 'Salut, comment ça va ?' },
    ]),
    'Salut, comment ça va ?',
  );
});

test('an empty list, or one empty of speech, gives the empty string', () => {
  assert.equal(sessionText([]), '');
  assert.equal(sessionText([{ isFinal: false, transcript: '   ' }]), '');
});

test('dictate A, restart, dictate B: the field holds "A B", once each', () => {
  // The full sequence as `chat-client` lives it: the base is empty,
  // session A is composed, `onend` folds it in, session B starts from a
  // fresh `results`.
  let base = '';
  let session = sessionText([
    { isFinal: true, transcript: 'première' },
    { isFinal: false, transcript: 'phrase' },
  ]);
  assert.equal(composeDictation(base, session), 'première phrase');

  session = sessionText([
    { isFinal: true, transcript: 'première' },
    { isFinal: true, transcript: 'phrase' },
  ]);
  // Fallback of `onend` before the restart.
  base = composeDictation(base, session);
  session = '';
  assert.equal(base, 'première phrase');

  session = sessionText([{ isFinal: false, transcript: 'deuxième phrase' }]);
  assert.equal(composeDictation(base, session), 'première phrase deuxième phrase');
});
