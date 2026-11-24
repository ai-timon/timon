// french-ok-file: a French voice conversation, the language the bridge was tried in
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_SPOKEN_CHARS, TURN_GAP_MS, VOICE_GAP_MS, appendFragment, closeIdle, emptyTranscript, flushAll, isSpeaking, spokenAnswer,
  startRelay, takeDelegation, turnText, voiceContext, type Step, type VoiceSpeaker, type VoiceTranscript,
} from './bridge';

const plain = (html: string) => html.replace(/<[^>]+>/g, ' ');

/** Replays a script of fragments; returns the final state and every turn
 *  journaled on the way. */
function play(script: Array<[VoiceSpeaker, string, number]>, start: VoiceTranscript = emptyTranscript()): Step {
  let seq = 0;
  let step: Step = { state: start, journal: [] };
  for (const [speaker, delta, at] of script) {
    const next = appendFragment(step.state, speaker, { delta, startMs: at, endMs: at + 100 }, at, () => `t${++seq}`);
    step = { state: next.state, journal: [...step.journal, ...next.journal] };
  }
  return step;
}

test('fragments are concatenated exactly, spaces included, into one open turn', () => {
  const { state, journal } = play([['user', 'Quelle ', 0], ['user', 'heure', 100], ['user', ' est-il ?', 200]]);
  assert.equal(state.open.user?.text, 'Quelle heure est-il ?');
  assert.equal(state.open.user?.startMs, 0);
  assert.equal(state.open.user?.endMs, 300);
  assert.deepEqual(journal, []);
});

test('a user turn answered by GPT-Live itself is journaled with the answer, in order', () => {
  const { state, journal } = play([['user', 'Salut !', 0], ['voice', 'Bonjour', 500], ['voice', ', ça va ?', 600]]);
  assert.deepEqual(journal, []);
  assert.equal(state.held.length, 1);
  const done = closeIdle(state, 600 + VOICE_GAP_MS + 1);
  assert.deepEqual(done.journal.map((t) => [t.speaker, turnText(t)]), [['user', 'Salut !'], ['voice', 'Bonjour, ça va ?']]);
  assert.equal(done.state.held.length, 0);
  assert.equal(done.state.open.voice, null);
});

test('the user speaking again closes the voice turn', () => {
  const { journal, state } = play([['user', 'Un', 0], ['voice', 'Oui ?', 300], ['user', 'Deux', 800]]);
  assert.deepEqual(journal.map((t) => turnText(t)), ['Un', 'Oui ?']);
  assert.equal(state.open.user?.text, 'Deux');
});

test('a silence longer than the gap splits one speaker into two turns', () => {
  const { state } = play([['user', 'Premier', 0], ['user', 'Second', TURN_GAP_MS + 50]]);
  assert.deepEqual(state.held.map(turnText), ['Premier']);
  assert.equal(state.open.user?.text, 'Second');
});

test('a pause in GPT-Live speech longer than the user gap keeps one voice turn', () => {
  const pause = TURN_GAP_MS + 800;
  const heard = play([
    ['voice', 'C’est noté. La task df96c057', 0],
    ['voice', ' est lancée avec relecture et merge.', pause],
    ['voice', ' Je te dis dès que c’est bon.', pause + 200],
  ]);
  assert.deepEqual(heard.journal, []);
  assert.deepEqual(closeIdle(heard.state, pause + 200 + TURN_GAP_MS + 1).journal, []);
  const settled = closeIdle(heard.state, pause + 200 + VOICE_GAP_MS + 1);
  assert.deepEqual(settled.journal.map(turnText), [
    'C’est noté. La task df96c057 est lancée avec relecture et merge. Je te dis dès que c’est bon.',
  ]);
});

test('the user speaking between two voice fragments splits them into two voice turns', () => {
  const { journal, state } = play([['voice', 'Première réponse.', 0], ['user', 'Et ensuite ?', 300], ['voice', 'Seconde.', 900]]);
  assert.deepEqual(journal.map((t) => [t.speaker, turnText(t)]), [['voice', 'Première réponse.']]);
  const settled = closeIdle(state, 900 + VOICE_GAP_MS + 1);
  assert.deepEqual(settled.journal.map((t) => [t.speaker, turnText(t)]), [['user', 'Et ensuite ?'], ['voice', 'Seconde.']]);
});

test('GPT-Live stops speaking with its audio, before its turn closes', () => {
  const { state } = play([['voice', 'Bonjour', 0]]);
  assert.equal(isSpeaking(state, TURN_GAP_MS), true);
  assert.equal(isSpeaking(state, TURN_GAP_MS + 1), false);
  assert.notEqual(state.open.voice, null);
});

test('a delegation takes the held and open user turns; they are never journaled', () => {
  const heard = play([
    ['user', 'On parle du build', 0], ['voice', 'D’accord.', 400],
    ['user', 'Lance ', 2000], ['user', 'les tests', 2100],
  ]);
  assert.deepEqual(heard.journal.map(turnText), ['On parle du build', 'D’accord.']);
  const delegation = takeDelegation(heard.state);
  assert.equal(delegation.request, 'Lance les tests');
  assert.equal(delegation.context, 'User: On parle du build\nVoice assistant: D’accord.');
  assert.deepEqual(delegation.consumed.map((t) => t.id), ['t3']);
  assert.equal(delegation.state.open.user, null);
  assert.deepEqual(delegation.state.recent, []);

  // GPT-Live acknowledges; the consumed request does not reappear.
  const after = play([['voice', 'Je lance ça.', 2600]], delegation.state);
  const settled = closeIdle(after.state, 2600 + VOICE_GAP_MS + 1);
  assert.deepEqual(settled.journal.map(turnText), ['Je lance ça.']);
});

test('a second delegation with nothing new heard reuses the last request', () => {
  const first = takeDelegation(play([['user', 'Lance les tests', 0]]).state);
  const second = takeDelegation(first.state);
  assert.equal(second.request, 'Lance les tests');
  assert.deepEqual(second.consumed, []);
  assert.equal(takeDelegation(emptyTranscript()).request, '');
});

test('the end of the session flushes everything still pending, in spoken order', () => {
  const { state } = play([['user', 'Merci', 0], ['voice', 'Avec plaisir', 300]]);
  const flushed = flushAll(state);
  assert.deepEqual(flushed.journal.map(turnText), ['Merci', 'Avec plaisir']);
  assert.deepEqual(flushed.state, emptyTranscript());
});

test('a whitespace-only turn is dropped', () => {
  const { state } = play([['user', '  ', 0], ['voice', 'Oui', 100]]);
  assert.deepEqual(state.held, []);
});

test('the voice context keeps the newest turns under its budget', () => {
  const turns = Array.from({ length: 30 }, (_, i) => ({
    id: String(i), speaker: 'user' as const, text: `${i} ${'x'.repeat(300)}`, startMs: i, endMs: i, lastAt: i,
  }));
  const context = voiceContext(turns);
  assert.ok(context.length <= 4000);
  assert.ok(context.endsWith(`29 ${'x'.repeat(300)}`));
});

test('the spoken answer drops code blocks and HTML', () => {
  const text = spokenAnswer('<p>Voilà :</p><pre><code>npm test</code></pre><p>Tout passe.</p>', plain);
  assert.equal(text, 'Voilà : (code shown in the chat) Tout passe.');
});

test('a long answer is cut on a sentence, under the append limit', () => {
  const long = `<p>${'Une phrase assez longue pour remplir. '.repeat(80)}</p>`;
  const text = spokenAnswer(long, plain);
  assert.ok(text.length <= MAX_SPOKEN_CHARS + 40);
  assert.match(text, /\. … \(the rest is in the chat\)$|\.… \(the rest is in the chat\)$/);
});

test('what GPT-Live says after an agent answer is handed to it is a relay, until the user speaks', () => {
  const before = play([['user', 'Lance le build', 0], ['voice', 'Je regarde.', 500]]);
  const handed = startRelay(before.state);
  // The words said before the answer arrived close as an ordinary turn.
  assert.deepEqual(handed.journal.map((t) => [t.speaker, turnText(t), t.relay]), [['user', 'Lance le build', undefined], ['voice', 'Je regarde.', undefined]]);
  assert.equal(handed.state.open.voice, null);

  const reading = play([['voice', 'Le build est vert.', 5000], ['voice', ' Deux avertissements.', 5000 + VOICE_GAP_MS + 1]], handed.state);
  assert.deepEqual(reading.journal.map((t) => [turnText(t), t.relay]), [['Le build est vert.', true]]);
  assert.equal(reading.state.open.voice?.relay, true);

  const after = play([['user', 'Merci', 20_000], ['voice', 'Avec plaisir', 21_000]], reading.state);
  assert.deepEqual(after.journal.map((t) => [turnText(t), t.relay]), [['Deux avertissements.', true]]);
  assert.equal(after.state.relaying, false);
  assert.equal(after.state.open.voice?.relay, undefined);
});

test('the user cutting in keeps the interrupted reading marked, and frees what follows', () => {
  const handed = startRelay(emptyTranscript());
  const cut = play([['voice', 'Le résultat est', 0], ['user', 'Stop, autre chose', 300], ['voice', 'Oui ?', 1000]], handed.state);
  assert.deepEqual(cut.journal.map((t) => [t.speaker, turnText(t), t.relay]), [['voice', 'Le résultat est', true]]);
  assert.equal(cut.state.open.voice?.relay, undefined);
});
