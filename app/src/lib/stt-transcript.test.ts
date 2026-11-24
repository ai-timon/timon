// french-ok-file: French dictation samples, the language the engine was captured in
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { mergeSegments, readResults } from './stt-transcript';

const res = (segments: Array<[string, boolean]>) =>
  segments.map(([transcript, isFinal]) => ({ 0: { transcript }, isFinal }));

test('disjoint segments: plain concatenation', () => {
  assert.equal(mergeSegments(['ok je fais', 'un test de voix']), 'ok je fais un test de voix');
});

test('engine that rewrites the whole sentence: a single copy', () => {
  const steps = ['ok', 'ok je', 'ok je fais', 'ok je fais un nouveau test de voix'];
  assert.equal(mergeSegments(steps), 'ok je fais un nouveau test de voix');
});

test('punctuation and case do not break the rewrite detection', () => {
  assert.equal(mergeSegments(['ok je', 'OK, je fais.']), 'OK, je fais.');
});

test('an identical redelivery is ignored', () => {
  assert.equal(mergeSegments(['bonjour Alice', 'bonjour Alice']), 'bonjour Alice');
});

test('a segment already contained at the end of the text is ignored', () => {
  assert.equal(mergeSegments(['ok je fais un test', 'un test']), 'ok je fais un test');
});

test('partial overlap: only the new tail is glued', () => {
  assert.equal(
    mergeSegments(['ok je fais un test', 'un test de voix']),
    'ok je fais un test de voix',
  );
});

test('empty entries ignored', () => {
  assert.equal(mergeSegments(['', null, '  ', 'ok', undefined]), 'ok');
});

test('readResults separates final and interim, without duplicates', () => {
  const r = readResults(
    res([
      ['ok', true],
      ['ok je fais', true],
      ['ok je fais un', false],
    ]),
  );
  assert.equal(r.final, 'ok je fais');
  assert.equal(r.interim, 'ok je fais un');
});

test('readResults reads all the results, not only the last ones', () => {
  const r = readResults(
    res([
      ['bonjour', true],
      ['comment ça va', false],
    ]),
  );
  assert.equal(r.final, 'bonjour');
  assert.equal(r.interim, 'comment ça va');
});

test('the text sent to the agent repeats no word', () => {
  const settled = 'ok je fais';
  const session = 'ok je fais un nouveau test de voix pour voir comment ça marche';
  const sent = mergeSegments([settled, session]);
  assert.equal(sent, session);
});
