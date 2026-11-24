// french-ok-file: the French phrases speech engines hallucinate, and real sentences close to them
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanTranscript, collapseRepeats, normalizeTranscript } from './speech-hallucinations.js';

const voiced = { voicedMs: 3000, totalMs: 4000 };
const weak = { voicedMs: 300, totalMs: 1200 };

test('normalization drops case, accents and punctuation', () => {
  assert.equal(normalizeTranscript("  Sous-titres réalisés par la communauté d'Amara.org  "), 'sous titres realises par la communaute d amara org');
});

test('subtitle credits and sign-offs are dropped whatever the audio', () => {
  for (const phantom of [
    "Sous-titres réalisés par la communauté d'Amara.org",
    'Sous-titrage ST 501',
    'Sous-titres par Jean Dupont',
    'Thanks for watching!',
    "Merci d'avoir regardé cette vidéo.",
    'Like and subscribe.',
    "N'oubliez pas de vous abonner à la chaîne",
  ]) {
    assert.equal(cleanTranscript(phantom, voiced), null, phantom);
  }
});

test('real sentences that merely start like a credit are kept', () => {
  assert.equal(cleanTranscript('Sous-titre de la section deux', voiced), 'Sous-titre de la section deux');
  assert.equal(cleanTranscript('Subscribe the handler to the event bus', voiced), 'Subscribe the handler to the event bus');
  assert.equal(cleanTranscript('Thanks for watching the logs yesterday', voiced), 'Thanks for watching the logs yesterday');
});

test('a courtesy word is dropped on a weak segment and kept when clearly spoken', () => {
  assert.equal(cleanTranscript('Merci.', weak), null);
  assert.equal(cleanTranscript('Thank you.', weak), null);
  assert.equal(cleanTranscript('Merci.', voiced), 'Merci.');
  assert.equal(cleanTranscript('Merci pour la revue', weak), 'Merci pour la revue');
});

test('non-speech tags are removed', () => {
  assert.equal(cleanTranscript('[Music] ouvre le fichier', voiced), 'ouvre le fichier');
  assert.equal(cleanTranscript('(musique)', voiced), null);
  assert.equal(cleanTranscript('♪ music ♪', voiced), null);
  assert.equal(cleanTranscript('   ', voiced), null);
});

test('decoding loops are collapsed, deliberate repetition survives', () => {
  assert.deepEqual(collapseRepeats('je je je je pense'.split(' ')), ['je', 'pense']);
  assert.deepEqual(collapseRepeats('very very very good'.split(' ')), ['very', 'very', 'very', 'good']);
  assert.equal(cleanTranscript('The end. The end. The end. The end.', voiced), 'The end.');
  assert.equal(cleanTranscript('ok so ok so ok so', voiced), 'ok so');
  assert.equal(cleanTranscript('lance les tests', voiced), 'lance les tests');
});

test('a Cohere credit is dropped by its prefix, even cut or followed by more', () => {
  for (const phantom of [
    'Sous-titrage Société Radio-Canada',
    'Sous-titrage Société Radio-',
    'Sous-titrage',
    'Sous-titr',
    "Merci d'avoir regardé !",
    "Merci d'avoir",
    "Merci d'avoir regardé, à la semaine prochaine",
    'Thanks for watching, see you',
  ]) {
    assert.equal(cleanTranscript(phantom, voiced, 'cohere'), null, phantom);
    assert.equal(cleanTranscript(phantom, voiced, 'whisper-like'), null, phantom);
  }
});

test('the Cohere prefixes spare real sentences and short words', () => {
  for (const kept of ["Merci d'avoir répondu si vite", 'Sous-titre de la section deux', 'Merci pour la revue', 'Sous le capot']) {
    assert.equal(cleanTranscript(kept, voiced, 'cohere'), kept);
  }
  // Too short to tell a cut credit from a word: the weak-segment rule decides.
  assert.equal(cleanTranscript('Merci.', voiced, 'cohere'), 'Merci.');
  assert.equal(cleanTranscript('Merci.', weak, 'cohere'), null);
});

test('a dictable phrase that starts a credit is not cut by the Cohere prefix', () => {
  const spoken = { voicedMs: 2000, totalMs: 2500 };
  assert.equal(cleanTranscript('Thank you.', spoken, 'cohere'), 'Thank you.');
  assert.equal(cleanTranscript('Sous-titres', spoken, 'cohere'), 'Sous-titres');
  assert.equal(cleanTranscript('Thank you.', weak, 'cohere'), null);
  assert.equal(cleanTranscript('Sous-titrage Société Radio-', spoken, 'cohere'), null);
});

test('the nemo profile keeps exact matching: a dictated "sous-titrage" survives', () => {
  assert.equal(cleanTranscript('Sous-titrage de la vidéo à revoir', voiced, 'nemo'), 'Sous-titrage de la vidéo à revoir');
  assert.equal(cleanTranscript('Sous-titrage de la vidéo à revoir', voiced), 'Sous-titrage de la vidéo à revoir');
  assert.equal(cleanTranscript('Sous-titrage de la vidéo à revoir', voiced, 'cohere'), null);
  // The credits every profile drops still go.
  assert.equal(cleanTranscript("Sous-titres réalisés par la communauté d'Amara.org", voiced, 'nemo'), null);
});
