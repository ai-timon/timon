// french-ok-file: the French phrases speech engines hallucinate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createWorkerHandler, DictationSession, sanitizeSamples, type Recognizer } from './speech-session.js';
import type { WorkerOutput } from './speech-protocol.js';
import { chunks, concatAudio, hush, peak, RATE, tone } from './speech-audio-fixtures.test.js';

/** Reads the loudest tone of the utterance: 0.2 → "ouvre le fichier", 0.4 → the Amara credit. */
function fakeRecognizer(calls: Float32Array[] = []): Recognizer {
  return {
    decode(samples) {
      calls.push(samples);
      const p = peak(samples);
      if (p > 0.35) return "Sous-titres réalisés par la communauté d'Amara.org";
      if (p > 0.15) return 'ouvre le fichier';
      return '';
    },
  };
}

function session(recognizer: Recognizer = fakeRecognizer()) {
  const out: WorkerOutput[] = [];
  const s = new DictationSession({ recognizer, emit: (m) => out.push(m), segmenter: { sampleRate: RATE } });
  return { s, out };
}

test('a spoken utterance gives partials, then its final, then stopped', () => {
  const { s, out } = session();
  const id = randomUUID();
  s.start(id);
  for (const chunk of chunks(concatAudio(tone(2500), hush(1000)))) s.feed(id, chunk);
  s.stop(id);
  const types = out.map((m) => m.type);
  assert.ok(types.includes('partial'));
  assert.deepEqual(types.slice(-2), ['final', 'stopped']);
  assert.ok(out.every((m) => !('sessionId' in m) || m.sessionId === id));
  const final = out.find((m) => m.type === 'final');
  assert.equal(final && 'text' in final ? final.text : '', 'ouvre le fichier');
  // The same partial text is not repeated.
  const partials = out.filter((m) => m.type === 'partial');
  assert.equal(partials.length, 1);
});

test('stop decodes the utterance still in progress', () => {
  const { s, out } = session();
  const id = randomUUID();
  s.start(id);
  for (const chunk of chunks(tone(700))) s.feed(id, chunk);
  s.stop(id);
  assert.deepEqual(out.map((m) => m.type), ['final', 'stopped']);
});

test('cancel drops the pending audio without a final', () => {
  const calls: Float32Array[] = [];
  const { s, out } = session(fakeRecognizer(calls));
  const id = randomUUID();
  s.start(id);
  for (const chunk of chunks(tone(700))) s.feed(id, chunk);
  s.cancel(id);
  assert.deepEqual(out, [{ type: 'stopped', sessionId: id }]);
  assert.equal(calls.length, 0);
});

test('audio of another session is ignored, and a new session closes the old one silently', () => {
  const calls: Float32Array[] = [];
  const { s, out } = session(fakeRecognizer(calls));
  const first = randomUUID();
  const second = randomUUID();
  s.start(first);
  for (const chunk of chunks(tone(700))) s.feed(first, chunk);
  s.start(second);
  for (const chunk of chunks(tone(700))) s.feed(first, chunk);
  s.stop(second);
  assert.deepEqual(out, [{ type: 'stopped', sessionId: first }, { type: 'stopped', sessionId: second }]);
  assert.equal(calls.length, 0);
  // A stop for a session that is already over still answers.
  s.stop(first);
  assert.deepEqual(out.at(-1), { type: 'stopped', sessionId: first });
});

test('invented text is never emitted', () => {
  const { s, out } = session();
  const id = randomUUID();
  s.start(id);
  for (const chunk of chunks(concatAudio(tone(1500, 0.5), hush(1000)))) s.feed(id, chunk);
  s.stop(id);
  assert.deepEqual(out.map((m) => m.type), ['stopped']);
});

test('a decoding failure is reported and the session goes on', () => {
  let fail = true;
  const { s, out } = session({ decode: () => { if (fail) { fail = false; throw new Error('ORT failure'); } return 'bonjour'; } });
  const id = randomUUID();
  s.start(id);
  for (const chunk of chunks(concatAudio(tone(1200), hush(1000), tone(800)))) s.feed(id, chunk);
  s.stop(id);
  const error = out.find((m) => m.type === 'error');
  assert.ok(error && error.type === 'error' && error.code === 'decode-failed');
  // The failure hit the first partial; both utterances still reach their final.
  assert.deepEqual(out.filter((m) => m.type === 'final').map((m) => ('text' in m ? m.text : '')), ['bonjour', 'bonjour']);
  assert.equal(out.at(-1)?.type, 'stopped');
});

test('non-finite and out-of-range samples never reach the recognizer', () => {
  const dirty = Float32Array.from([0.1, Number.NaN, 2, -3, Number.POSITIVE_INFINITY]);
  assert.deepEqual([...sanitizeSamples(dirty)], [Math.fround(0.1), 0, 1, -1, 0]);
  const clean = Float32Array.from([0.1, -0.2]);
  assert.equal(sanitizeSamples(clean), clean, 'clean audio is not copied');
});

test('the worker loop parses every message before acting', () => {
  const out: WorkerOutput[] = [];
  let built = 0;
  const handle = createWorkerHandler({ makeRecognizer: () => { built += 1; return fakeRecognizer(); }, send: (m) => out.push(m) });
  const id = randomUUID();
  const init = {
    type: 'init', addonDir: '/addon', modelDir: '/models/parakeet', sampleRate: RATE, numThreads: 2,
    family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
    files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  };
  handle({ type: 'stop', sessionId: id });
  assert.deepEqual(out.splice(0), [{ type: 'stopped', sessionId: id }], 'stop before init still answers');
  handle({ ...init, files: { ...init.files, encoder: '../../etc/passwd' } });
  handle({ ...init, sampleRate: 44_100 });
  handle('garbage');
  assert.equal(built, 0);
  handle(init);
  handle(init);
  assert.equal(built, 1, 'a second init is ignored');
  assert.deepEqual(out.splice(0), [{ type: 'ready' }]);
  handle({ type: 'start', sessionId: 'not-a-uuid' });
  handle({ type: 'start', sessionId: id });
  handle({ type: 'feed', sessionId: id, samples: new Float32Array(RATE * 3) });
  handle({ type: 'feed', sessionId: id, samples: [0.1, 0.2] });
  for (const chunk of chunks(tone(700))) handle({ type: 'feed', sessionId: id, samples: chunk });
  handle({ type: 'stop', sessionId: id });
  assert.deepEqual(out.map((m) => m.type), ['final', 'stopped']);
});

test('a recognizer that cannot load is reported as init-failed', () => {
  const out: WorkerOutput[] = [];
  const handle = createWorkerHandler({ makeRecognizer: () => { throw new Error('cannot open encoder.int8.onnx'); }, send: (m) => out.push(m) });
  handle({
    type: 'init', addonDir: '/addon', modelDir: '/m', sampleRate: RATE, numThreads: 1,
    family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
    files: { encoder: 'e.onnx', decoder: 'd.onnx', joiner: 'j.onnx', tokens: 't.txt' },
  });
  assert.deepEqual(out, [{ type: 'init-failed', message: 'cannot open encoder.int8.onnx' }]);
});

const CANARY_INIT = {
  type: 'init', addonDir: '/addon', modelDir: '/models/canary', sampleRate: RATE, numThreads: 2,
  family: 'nemo-canary', language: 'fr', options: { usePnc: true }, filter: 'nemo',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' },
} as const;

test('the worker refuses an init the family cannot run, before any recognizer is built', () => {
  const out: WorkerOutput[] = [];
  let built = 0;
  const handle = createWorkerHandler({ makeRecognizer: () => { built += 1; return fakeRecognizer(); }, send: (m) => out.push(m) });
  const files = CANARY_INIT.files;
  for (const bad of [
    // Paths: never out of the model folder, absolute, or two levels deep.
    { ...CANARY_INIT, files: { ...files, encoder: '../encoder.int8.onnx' } },
    { ...CANARY_INIT, files: { ...files, tokens: '/etc/passwd' } },
    { ...CANARY_INIT, files: { ...files, tokens: 'C:\\models\\tokens.txt' } },
    { ...CANARY_INIT, files: { ...files, tokens: 'a/b/tokens.txt' } },
    // Roles: what the family needs, nothing it does not use, no external data.
    { ...CANARY_INIT, files: { encoder: files.encoder, tokens: files.tokens } },
    { ...CANARY_INIT, files: { ...files, joiner: 'joiner.int8.onnx' } },
    { ...CANARY_INIT, files: { ...files, data: 'encoder.int8.onnx.data' } },
    // Language: a closed list, one the family knows, mandatory where it has no Auto.
    { ...CANARY_INIT, language: null },
    { ...CANARY_INIT, language: 'it' },
    { ...CANARY_INIT, language: 'xx' },
    { ...CANARY_INIT, language: 'fr; rm -rf /' },
    { ...CANARY_INIT, family: 'nemo-transducer', files: { ...files, joiner: 'joiner.int8.onnx' } },
    // Options: only the family's, typed; no addon key smuggled in.
    { ...CANARY_INIT, options: { modelType: 'whisper' } },
    { ...CANARY_INIT, options: { usePnc: 'yes' } },
    { ...CANARY_INIT, options: { encoder: '/etc/passwd' } },
    // Family and profile: closed lists; no unknown key at the top level.
    { ...CANARY_INIT, family: 'qwen3-asr' },
    { ...CANARY_INIT, filter: 'custom' },
    { ...CANARY_INIT, modelConfig: { canary: {} } },
  ]) handle(bad);
  assert.equal(built, 0);
  assert.deepEqual(out, []);
  handle(CANARY_INIT);
  assert.equal(built, 1);
  assert.deepEqual(out, [{ type: 'ready' }]);
});

test('a Cohere init carries its language and the cohere profile reaches the session', () => {
  const out: WorkerOutput[] = [];
  const inits: unknown[] = [];
  const credit: Recognizer = { decode: (samples) => (peak(samples) > 0.15 ? 'Sous-titrage Société Radio-' : '') };
  const handle = createWorkerHandler({ makeRecognizer: (init) => { inits.push(init); return credit; }, send: (m) => out.push(m) });
  const cohere = {
    ...CANARY_INIT, family: 'cohere-transcribe', options: { usePunct: true, useItn: false }, filter: 'cohere',
  };
  handle({ ...cohere, language: null });
  assert.deepEqual(inits, [], 'Cohere has no Auto');
  handle(cohere);
  assert.equal(inits.length, 1);
  const id = randomUUID();
  handle({ type: 'start', sessionId: id });
  for (const chunk of chunks(concatAudio(tone(1500), hush(1000)))) handle({ type: 'feed', sessionId: id, samples: chunk });
  handle({ type: 'stop', sessionId: id });
  assert.deepEqual(out.map((m) => m.type), ['ready', 'stopped'], 'the cut credit never reaches the draft');
});

test('the nemo profile keeps a text the cohere profile drops', () => {
  const credit: Recognizer = { decode: (samples) => (peak(samples) > 0.15 ? 'Sous-titrage de la vidéo' : '') };
  const run = (filter: 'nemo' | 'cohere'): string[] => {
    const out: WorkerOutput[] = [];
    const s = new DictationSession({ recognizer: credit, emit: (m) => out.push(m), segmenter: { sampleRate: RATE }, filter });
    const id = randomUUID();
    s.start(id);
    for (const chunk of chunks(concatAudio(tone(1500), hush(1000)))) s.feed(id, chunk);
    s.stop(id);
    return out.flatMap((m) => (m.type === 'final' ? [m.text] : []));
  };
  assert.deepEqual(run('nemo'), ['Sous-titrage de la vidéo']);
  assert.deepEqual(run('cohere'), []);
});

/** The message types a worker sends for `audio` in one session started with `start`. */
function workerRun(init: Record<string, unknown>, start: Record<string, unknown>, audio: Float32Array): WorkerOutput['type'][] {
  const out: WorkerOutput[] = [];
  const handle = createWorkerHandler({ makeRecognizer: () => fakeRecognizer(), send: (m) => out.push(m) });
  handle(init);
  const id = randomUUID();
  handle({ type: 'start', sessionId: id, ...start });
  for (const chunk of chunks(audio)) handle({ type: 'feed', sessionId: id, samples: chunk });
  handle({ type: 'stop', sessionId: id });
  return out.map((m) => m.type);
}

const PARAKEET_INIT = {
  type: 'init', addonDir: '/addon', modelDir: '/models/parakeet', sampleRate: RATE, numThreads: 2,
  family: 'nemo-transducer', language: null, options: {}, filter: 'nemo',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
} as const;

test('the worker refuses a start whose interim policy it cannot read', () => {
  const audio = concatAudio(tone(2500), hush(1000));
  for (const interim of [
    { mode: 'turbo', minUtteranceMs: 0 },
    { mode: 'live', minUtteranceMs: -1 },
    { mode: 'live', minUtteranceMs: 60_000 },
    { mode: 'live', minUtteranceMs: 1.5 },
    { mode: 'live' },
    { mode: 'live', minUtteranceMs: 0, partialEveryMs: 1 },
  ]) {
    // No session opens: the audio is dropped, and stop answers for a session already over.
    assert.deepEqual(workerRun(CANARY_INIT, { interim }, audio), ['ready', 'stopped'], JSON.stringify(interim));
  }
});

test('a detected language shows no partial under 2 s of speech, even when the caller asks for live', () => {
  const short = concatAudio(hush(400), tone(1600), hush(1000));
  const live = { interim: { mode: 'live', minUtteranceMs: 0 } };
  assert.deepEqual(workerRun(PARAKEET_INIT, live, short), ['ready', 'final', 'stopped']);
  assert.deepEqual(workerRun(PARAKEET_INIT, {}, short), ['ready', 'final', 'stopped']);
  // An imposed language keeps its early partial; a long utterance gets one either way.
  assert.deepEqual(workerRun(CANARY_INIT, live, short), ['ready', 'partial', 'final', 'stopped']);
  assert.deepEqual(workerRun(PARAKEET_INIT, live, concatAudio(tone(2600), hush(1000))), ['ready', 'partial', 'final', 'stopped']);
});

test('final-only and delayed sessions hold provisional text back', () => {
  const finalOnly = { interim: { mode: 'final-only', minUtteranceMs: 0 } };
  assert.deepEqual(workerRun(CANARY_INIT, finalOnly, concatAudio(tone(6000), hush(1000))), ['ready', 'final', 'stopped']);
  const delayed = { interim: { mode: 'delayed', minUtteranceMs: 3000 } };
  assert.deepEqual(workerRun(CANARY_INIT, delayed, concatAudio(tone(2500), hush(1000))), ['ready', 'final', 'stopped']);
  assert.deepEqual(workerRun(CANARY_INIT, delayed, concatAudio(tone(3500), hush(1000))), ['ready', 'partial', 'final', 'stopped']);
});

test('each session sets its own interim policy on the same engine', () => {
  const out: WorkerOutput[] = [];
  const s = new DictationSession({ recognizer: fakeRecognizer(), emit: (m) => out.push(m), segmenter: { sampleRate: RATE } });
  const audio = concatAudio(tone(2500), hush(1000));
  const run = (interim?: { mode: 'live' | 'delayed' | 'final-only'; minUtteranceMs: number }): string[] => {
    const id = randomUUID();
    s.start(id, interim);
    for (const chunk of chunks(audio)) s.feed(id, chunk);
    s.stop(id);
    return out.splice(0).map((m) => m.type);
  };
  assert.deepEqual(run({ mode: 'final-only', minUtteranceMs: 0 }), ['final', 'stopped']);
  assert.deepEqual(run(), ['partial', 'final', 'stopped'], 'a start without a policy is live again');
});
