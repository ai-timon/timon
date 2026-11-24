// french-ok-file: French dictation samples, accented text the engine passes through
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { composeDictation, isFatalDictationError, sessionText } from '@/lib/stt-dictation';
import { mergeSegments, readResults } from '@/lib/stt-transcript';
import type { ModelState, SpeechBridge, SpeechEvent, SpeechState } from '@/plugins-client/local-dictation/desktop-speech';
import { createLocalDictationEngine } from '@/plugins-client/local-dictation/engine';
import { LocalEngineStore } from '@/plugins-client/local-dictation/local-engine';

import type { CaptureHandlers, MicrophoneCapture } from './audio-capture';
import { CaptureError } from './audio-capture';
import type { DictationAvailability, DictationEngine, DictationLanguages, DictationStartOptions } from './contract';
import { EngineRecognition, engineLanguage, type RecognitionResultEvent } from './engine-recognition';
import { dictationLang, dictationRoute, routeEngineId } from './recognition';
import { admitEngine, decideEngineConsent } from './consent';
import { recordDictationDeclarations } from './destination';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => { map.clear(); },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => { for (let i = 0; i < 6; i += 1) await tick(); };

type FakeOptions = {
  availability?: DictationAvailability | null;
  /** Events the engine reports during `start`, then it rejects. */
  refuse?: unknown[];
  /** `start` waits for `release()`. */
  slow?: boolean;
  mic?: 'granted' | 'denied';
  captureError?: CaptureError;
  languages?: DictationLanguages;
  feedThrows?: boolean;
};

/** A contract engine that records what the product hands it, and lets the test speak for it. */
function fakeEngine(options: FakeOptions = {}) {
  const fed: number[] = [];
  const calls: string[] = [];
  let started: DictationStartOptions | null = null;
  let release: () => void = () => {};
  let handlers: CaptureHandlers | null = null;
  let captureStopped = false;
  let micOpened = false;
  const session = {
    feed: (pcm: Float32Array) => {
      if (options.feedThrows) throw new Error('engine bug');
      fed.push(pcm.length);
    },
    stop: async () => { calls.push('stop'); },
    cancel: () => { calls.push('cancel'); },
  };
  const engine: DictationEngine = {
    id: 'acme',
    label: 'Acme',
    languages: options.languages ?? { codes: [], mode: 'auto' },
    interim: 'live',
    availability: async () => options.availability ?? { state: 'ready' },
    start: async (startOptions) => {
      started = startOptions;
      calls.push(`start:${startOptions.language}`);
      if (options.refuse) {
        for (const event of options.refuse) startOptions.onEvent(event as never);
        throw new Error('refused');
      }
      if (options.slow) await new Promise<void>((resolve) => { release = resolve; });
      return session;
    },
  };
  const capture = async (h: CaptureHandlers): Promise<MicrophoneCapture> => {
    micOpened = true;
    if (options.captureError) throw options.captureError;
    handlers = h;
    return { stop: () => { captureStopped = true; return new Float32Array(40); } };
  };
  const deps = {
    engine,
    capture,
    microphone: async () => options.mic ?? 'granted',
    availability: async () => options.availability ?? null,
  };
  return {
    deps,
    fed,
    calls,
    emit: (event: unknown) => started?.onEvent(event as never),
    get signal() { return started?.signal ?? null; },
    /** The `onEvent` the product handed the current start. */
    get onEvent() { return started?.onEvent ?? null; },
    release: () => release(),
    chunk: (length = 1600) => handlers?.onChunk(new Float32Array(length)),
    loseDevice: () => handlers?.onDeviceLost(),
    get captureStopped() { return captureStopped; },
    get micOpened() { return micOpened; },
  };
}

function record(rec: EngineRecognition) {
  const results: RecognitionResultEvent[] = [];
  const errors: string[] = [];
  let ended = 0;
  rec.onresult = (event) => results.push(event);
  rec.onerror = (event) => errors.push(event.error);
  rec.onend = () => { ended += 1; };
  return { results, errors, get ended() { return ended; } };
}

async function running(options: FakeOptions = {}) {
  const fake = fakeEngine(options);
  const rec = new EngineRecognition(fake.deps);
  const seen = record(rec);
  rec.start();
  await settle();
  return { fake, rec, seen };
}

/** A realistic sherpa session: partials re-decoded while speaking, then a final per utterance. */
const SEQUENCE = [
  { type: 'partial', text: 'Il faut' },
  { type: 'partial', text: 'Il faut tester' },
  { type: 'final', text: 'Il faut tester.' },
  { type: 'partial', text: 'Il faut' },
  { type: 'partial', text: 'Il faut tester encore' },
  { type: 'final', text: 'Il faut tester encore.' },
  { type: 'partial', text: 'Merci' },
  { type: 'final', text: 'Merci.' },
  { type: 'final', text: 'Merci.' },
  { type: 'stopped' },
];
const SPOKEN = 'Il faut tester. Il faut tester encore. Merci. Merci.';

// --- Refusals first: what an engine cannot push into a draft. ---

test('an event out of the contract\'s schema is ignored, whatever it carries', async () => {
  const { fake, seen } = await running();
  for (const event of [
    null,
    'final',
    { type: 'final' },
    { type: 'final', text: 42 },
    { type: 'final', text: 'x'.repeat(20_001) },
    { type: 'transcript', text: 'hello' },
    { type: 'error', code: 'exploded', message: 'x', fatal: true },
    { type: 'error', code: 'crashed', message: 'x' },
  ]) fake.emit(event);
  await settle();
  assert.equal(seen.results.length, 0);
  assert.deepEqual(seen.errors, []);
  assert.equal(seen.ended, 0);
  fake.emit({ type: 'final', text: 'Bonjour.' });
  assert.equal(readResults(seen.results.at(-1)!.results).final, 'Bonjour.');
});

test('a partial or a final after `stopped` is ignored, and the end is reported once', async () => {
  const { fake, seen } = await running();
  fake.emit({ type: 'final', text: 'Avant.' });
  fake.emit({ type: 'stopped' });
  fake.emit({ type: 'partial', text: 'après' });
  fake.emit({ type: 'final', text: 'Après.' });
  fake.emit({ type: 'stopped' });
  await settle();
  assert.equal(seen.results.length, 1);
  assert.equal(readResults(seen.results[0]!.results).final, 'Avant.');
  assert.equal(seen.ended, 1);
});

test('an engine whose feed throws loses the chunk, not the dictation', async () => {
  const { fake, seen } = await running({ feedThrows: true });
  fake.chunk();
  fake.emit({ type: 'final', text: 'Toujours là.' });
  assert.equal(readResults(seen.results.at(-1)!.results).final, 'Toujours là.');
  assert.deepEqual(seen.errors, []);
});

test('an engine that says it is unavailable is never started, nor the microphone opened', async () => {
  const { fake, seen } = await running({ availability: { state: 'unavailable' } });
  assert.deepEqual(fake.calls, []);
  assert.equal(fake.micOpened, false);
  assert.deepEqual(seen.errors, ['engine-unavailable']);
  assert.equal(seen.ended, 1);
});

// --- The draft and the session. ---

test('a realistic partial/final sequence lands whole in the chat draft (sessionText)', async () => {
  const { fake, rec, seen } = await running();
  let draft = '';
  rec.onresult = (event) => {
    const text = sessionText(Array.from(event.results as ArrayLike<{ 0: { transcript: string }; isFinal: boolean }>, (r) => ({ isFinal: r.isFinal, transcript: r[0].transcript })));
    draft = composeDictation('Brouillon :', text);
  };
  for (const event of SEQUENCE) fake.emit(event);
  await settle();
  assert.equal(draft, `Brouillon : ${SPOKEN}`);
  assert.equal(seen.ended, 1);
});

test('the same sequence through the voice mode reading (readResults)', async () => {
  const { fake, rec } = await running();
  let final = '';
  const interims: string[] = [];
  rec.onresult = (event) => {
    const read = readResults(event.results);
    final = read.final;
    interims.push(read.interim);
  };
  for (const event of SEQUENCE) fake.emit(event);
  assert.equal(final, SPOKEN);
  // The live partial is offered as interim, then cleared by its final.
  assert.deepEqual(interims.slice(0, 3), ['Il faut', 'Il faut tester', '']);
});

test('why the engine does not go through mergeSegments: disjoint utterances would lose speech', () => {
  const finals = ['Il faut tester.', 'Il faut tester encore.', 'Merci.', 'Merci.'];
  assert.notEqual(mergeSegments(finals), SPOKEN);
  assert.equal(finals.reduce(composeDictation, ''), SPOKEN);
});

test('audio captured while the engine loads is fed once the session exists', async () => {
  const fake = fakeEngine({ slow: true });
  const rec = new EngineRecognition(fake.deps);
  record(rec);
  let started = 0;
  rec.onstart = () => { started += 1; };
  rec.start();
  await settle();
  fake.chunk();
  fake.chunk();
  assert.deepEqual(fake.fed, []);
  fake.release();
  await settle();
  assert.equal(started, 1);
  assert.deepEqual(fake.fed, [1600, 1600]);
  fake.chunk();
  assert.equal(fake.fed.length, 3);
});

test('an abort while the engine loads closes the microphone, aborts the signal and cancels the late session', async () => {
  const fake = fakeEngine({ slow: true });
  const rec = new EngineRecognition(fake.deps);
  const seen = record(rec);
  let started = 0;
  rec.onstart = () => { started += 1; };
  rec.start();
  await settle();
  fake.chunk();
  rec.abort();
  assert.equal(fake.signal?.aborted, true);
  fake.release();
  await settle();
  fake.chunk();
  assert.deepEqual(fake.fed, []);
  assert.deepEqual(fake.calls, ['start:null', 'cancel']);
  assert.ok(fake.captureStopped);
  assert.equal(started, 0);
  assert.equal(seen.ended, 1);
});

test('an abort before the microphone opened never opens it', async () => {
  const fake = fakeEngine();
  const rec = new EngineRecognition(fake.deps);
  const seen = record(rec);
  rec.start();
  rec.abort();
  await settle();
  assert.equal(fake.micOpened, false);
  assert.equal(seen.ended, 1);
});

test('stop flushes the last audio, asks the engine to stop, ends once', async () => {
  const { fake, rec, seen } = await running();
  rec.stop();
  await settle();
  assert.ok(fake.captureStopped);
  assert.equal(fake.fed.at(-1), 40);
  assert.deepEqual(fake.calls, ['start:null', 'stop']);
  fake.emit({ type: 'stopped' });
  await settle();
  assert.equal(seen.ended, 1);
  assert.deepEqual(seen.errors, []);
});

test('a stop requested while the engine loads is honoured once it has started', async () => {
  const fake = fakeEngine();
  const rec = new EngineRecognition(fake.deps);
  const seen = record(rec);
  rec.start();
  rec.stop();
  await settle();
  assert.deepEqual(fake.calls, ['start:null', 'stop']);
  assert.equal(seen.ended, 1);
});

test('abort cancels without results, and late events of the session are ignored', async () => {
  const { fake, rec, seen } = await running();
  rec.abort();
  fake.emit({ type: 'final', text: 'trop tard' });
  await settle();
  assert.deepEqual(fake.calls, ['start:null', 'cancel']);
  assert.equal(seen.results.length, 0);
  assert.deepEqual(seen.errors, ['aborted']);
  assert.equal(seen.ended, 1);
});

test('an event of a previous run never reaches the next one', async () => {
  const fake = fakeEngine();
  const rec = new EngineRecognition(fake.deps);
  const seen = record(rec);
  rec.start();
  await settle();
  const stale = fake.onEvent!;
  rec.abort();
  await settle();
  rec.start();
  await settle();
  seen.results.length = 0;
  stale({ type: 'final', text: 'ancienne session' });
  assert.equal(seen.results.length, 0);
  fake.emit({ type: 'final', text: 'nouvelle session' });
  assert.equal(seen.results.length, 1);
});

test('the surface\'s language reaches the engine when the engine knows it', async () => {
  const { fake } = await running();
  assert.deepEqual(fake.calls, ['start:null']);
  const fr = fakeEngine();
  const rec = new EngineRecognition(fr.deps);
  rec.lang = 'fr-FR';
  rec.start();
  await settle();
  assert.deepEqual(fr.calls, ['start:fr']);
  assert.equal(engineLanguage('fr-FR', { languages: { codes: ['en'], mode: 'forced' } }), null);
  assert.equal(engineLanguage('en-US', { languages: { codes: ['en'], mode: 'forced' } }), 'en');
  assert.equal(engineLanguage('', { languages: { codes: [], mode: 'auto' } }), null);
});

test('an availability that throws or is out of contract counts as unknown: the dictation goes ahead', async () => {
  const fake = fakeEngine();
  const rec = new EngineRecognition({ ...fake.deps, availability: async () => { throw new Error('boom'); } });
  const seen = record(rec);
  rec.start();
  await settle();
  assert.ok(fake.micOpened);
  assert.deepEqual(fake.calls, ['start:null']);
  assert.deepEqual(seen.errors, []);
});

// --- Failures. ---

test('needs-setup: the engine answers the start before any microphone; an empty message is silent', async () => {
  const consent = await running({
    availability: { state: 'needs-setup' },
    refuse: [{ type: 'error', code: 'needs-setup', message: '', fatal: true }, { type: 'stopped' }],
  });
  assert.equal(consent.fake.micOpened, false);
  assert.deepEqual(consent.seen.errors, ['model-consent']);
  assert.equal(consent.seen.ended, 1);

  const missing = await running({
    availability: { state: 'needs-setup' },
    refuse: [{ type: 'error', code: 'needs-setup', message: 'Set up Acme first.', fatal: true }],
  });
  assert.deepEqual(missing.seen.errors, ['model-missing']);
});

test('every terminal failure carries a code no surface relaunches into', async () => {
  const cases: Array<[FakeOptions, string]> = [
    [{ mic: 'denied' }, 'microphone-denied'],
    [{ captureError: new CaptureError('not-allowed', 'x') }, 'not-allowed'],
    [{ captureError: new CaptureError('audio-capture', 'x') }, 'audio-capture'],
    [{ refuse: [] }, 'init-failed'],
    [{ refuse: [{ type: 'error', code: 'unavailable', message: '', fatal: true }] }, 'engine-unavailable'],
    [{ refuse: [{ type: 'error', code: 'crashed', message: '', fatal: true }] }, 'init-failed'],
    [{ refuse: [{ type: 'error', code: 'busy', message: '', fatal: true }] }, 'busy'],
    [{ refuse: [{ type: 'error', code: 'denied', message: '', fatal: true }] }, 'engine-unavailable'],
  ];
  for (const [options, code] of cases) {
    const { fake, seen } = await running(options);
    assert.deepEqual(seen.errors, [code], code);
    assert.equal(seen.ended, 1);
    assert.ok(isFatalDictationError(code), code);
    if (fake.micOpened && !options.captureError) assert.ok(fake.captureStopped, `${code}: microphone closed`);
  }
});

test('a crash mid-session is fatal and cancels the session; a non-fatal error is not', async () => {
  const { fake, seen } = await running();
  fake.emit({ type: 'error', code: 'decode-failed', message: '', fatal: false });
  assert.deepEqual(seen.errors, []);
  fake.emit({ type: 'error', code: 'crashed', message: '', fatal: true });
  fake.emit({ type: 'stopped' });
  await settle();
  assert.deepEqual(seen.errors, ['engine-crashed']);
  assert.deepEqual(fake.calls, ['start:null', 'cancel']);
  assert.ok(fake.captureStopped);
  assert.equal(seen.ended, 1);
});

test('an unplugged microphone stops cleanly: what was said still lands, then a message', async () => {
  const { fake, seen } = await running();
  fake.loseDevice();
  fake.emit({ type: 'final', text: 'dernière phrase' });
  fake.emit({ type: 'stopped' });
  await settle();
  assert.deepEqual(seen.errors, ['microphone-lost']);
  assert.deepEqual(fake.calls, ['start:null', 'stop']);
  assert.equal(readResults(seen.results.at(-1)!.results).final, 'dernière phrase');
  assert.equal(seen.ended, 1);
});

test('an engine that ends on its own without an error ends the recognizer quietly, like Web Speech', async () => {
  const { fake, seen } = await running();
  fake.emit({ type: 'stopped' });
  await settle();
  assert.deepEqual(seen.errors, []);
  assert.equal(seen.ended, 1);
});

// --- The local engine through the contract: today's dictation, unchanged. ---

function desktop(model: ModelState['status']) {
  const calls: string[] = [];
  let emit: (event: SpeechEvent) => void = () => {};
  const state: SpeechState = { engine: 'available', sessionId: null, model: { modelId: 'parakeet', status: model, receivedBytes: 0, totalBytes: 1, error: null } };
  const bridge = {
    getState: async () => state,
    listModels: async () => null,
    startDictation: async () => { calls.push('start'); return { ok: true, sessionId: 's1' }; },
    feed: () => {},
    stopDictation: async () => { calls.push('stop'); },
    cancelDictation: async () => { calls.push('cancel'); },
    onEvent: (listener: (event: SpeechEvent) => void) => { emit = listener; return () => {}; },
  } as unknown as SpeechBridge;
  const store = new LocalEngineStore(bridge);
  store.presentConsentWith(() => { calls.push('consent'); });
  return { engine: createLocalDictationEngine(store), calls, emit: (event: SpeechEvent) => emit(event) };
}

test('local engine: a missing model opens the consent card, silently, without the microphone', async () => {
  const local = desktop('absent');
  let opened = false;
  const rec = new EngineRecognition({
    engine: local.engine,
    capture: async () => { opened = true; return { stop: () => null }; },
    microphone: async () => 'granted',
    availability: (engine) => engine.availability(),
  });
  const seen = record(rec);
  rec.start();
  await settle();
  assert.equal(opened, false);
  assert.deepEqual(local.calls, ['consent']);
  assert.deepEqual(seen.errors, ['model-consent']);
  assert.equal(seen.ended, 1);
});

test('local engine: another surface taking the engine is reported busy, so the chat does not take it back', async () => {
  const local = desktop('ready');
  const rec = new EngineRecognition({
    engine: local.engine,
    capture: async () => ({ stop: () => null }),
    microphone: async () => 'granted',
    availability: (engine) => engine.availability(),
  });
  const seen = record(rec);
  rec.start();
  await settle();
  local.emit({ type: 'final', sessionId: 's1', text: 'Bonjour.' });
  local.emit({ type: 'stopped', sessionId: 's1' });
  await settle();
  assert.equal(readResults(seen.results.at(-1)!.results).final, 'Bonjour.');
  assert.deepEqual(seen.errors, ['busy']);
  assert.equal(seen.ended, 1);
});

// --- The route. ---

test('route: the desktop gets a registered engine unless none can run', () => {
  const desktopEnv = { userAgent: 'Electron/33', desktopBridge: true, webSpeech: true };
  assert.equal(dictationRoute({ ...desktopEnv, engines: [{ id: 'local', availability: 'ready' }] }), 'engine:local');
  assert.equal(dictationRoute({ ...desktopEnv, engines: [{ id: 'local', availability: null }] }), 'engine:local');
  assert.equal(dictationRoute({ ...desktopEnv, engines: [{ id: 'local', availability: 'needs-setup' }] }), 'engine:local');
  assert.equal(dictationRoute({ ...desktopEnv, engines: [{ id: 'local', availability: 'unavailable' }] }), 'unavailable-desktop');
  assert.equal(dictationRoute({ ...desktopEnv, engines: [{ id: 'local', availability: 'unavailable' }, { id: 'acme', availability: null }] }), 'engine:acme');
  assert.equal(dictationRoute({ ...desktopEnv, engines: [] }), 'unavailable-desktop');
  const browser = { userAgent: 'Chrome/130', desktopBridge: false };
  assert.equal(dictationRoute({ ...browser, webSpeech: true, engines: [{ id: 'acme', availability: 'ready' }] }), 'web-speech');
  assert.equal(dictationRoute({ ...browser, webSpeech: false, engines: [{ id: 'acme', availability: 'ready' }] }), 'engine:acme');
  assert.equal(dictationRoute({ ...browser, webSpeech: false, engines: [] }), 'unavailable-browser');
  assert.equal(routeEngineId('engine:local'), 'local');
  assert.equal(routeEngineId('web-speech'), null);
});

test('Web Speech follows the UI locale', () => {
  assert.equal(dictationLang('fr'), 'fr-FR');
  assert.equal(dictationLang('en'), 'en-US');
});

// ── Consent (TODO #484 C3): an engine without it never hears anything ──

/** The real gate over a third-party engine, its card stood in for by `present`. */
function gated(egress: unknown, present: () => boolean = () => true) {
  recordDictationDeclarations([
    { id: 'acme-dictation', dictation: { engines: [{ id: 'acme', runtime: 'page', egress }], models: null } },
  ]);
  const fake = fakeEngine();
  let availabilityAsked = 0;
  const shown: string[] = [];
  const rec = new EngineRecognition({
    ...fake.deps,
    availability: async () => { availabilityAsked += 1; return null; },
    admit: () => admitEngine({ pluginId: 'acme-dictation', engineId: 'acme', engineLabel: 'Acme' }, (r) => { shown.push(r.engineId); return present(); }),
  });
  return { fake, rec, shown, get availabilityAsked() { return availabilityAsked; } };
}

test('consent: an engine never consented to gets no microphone, no start, and the card is asked for', async () => {
  const g = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = { localStorage: memoryStorage() };
    const { fake, rec, shown, availabilityAsked } = gated(['api.acme.com']);
    const seen = record(rec);
    rec.start();
    await settle();
    assert.equal(fake.micOpened, false, 'no capture without consent');
    assert.deepEqual(fake.calls, [], 'the engine is not started');
    assert.equal(availabilityAsked, 0);
    assert.deepEqual(shown, ['acme']);
    assert.deepEqual(seen.errors, ['engine-consent']);
    assert.equal(isFatalDictationError('engine-consent'), true, 'terminal: no surface relaunches into the card');
    assert.equal(seen.ended, 1);

    // Nothing could show the card: refused the same way, with a message.
    const blind = gated(['api.acme.com'], () => false);
    const blindSeen = record(blind.rec);
    blind.rec.start();
    await settle();
    assert.equal(blind.fake.micOpened, false);
    assert.deepEqual(blindSeen.errors, ['engine-not-allowed']);
  } finally {
    (globalThis as { window?: unknown }).window = g;
  }
});

test('consent: refused, the engine stays off; undeclared, it is never used', async () => {
  const g = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = { localStorage: memoryStorage() };
    const refused = gated('daemon');
    decideEngineConsent('acme-dictation', 'acme', 'refused');
    const refusedSeen = record(refused.rec);
    refused.rec.start();
    await settle();
    assert.equal(refused.fake.micOpened, false);
    assert.deepEqual(refused.shown, [], 'a refusal does not reopen the card');
    assert.deepEqual(refusedSeen.errors, ['engine-not-allowed']);

    const undeclared = gated('anywhere');
    const undeclaredSeen = record(undeclared.rec);
    undeclared.rec.start();
    await settle();
    assert.equal(undeclared.fake.micOpened, false);
    assert.deepEqual(undeclaredSeen.errors, ['engine-undeclared']);
  } finally {
    (globalThis as { window?: unknown }).window = g;
  }
});

test('consent: an egress changed by a plugin update asks again before the next capture', async () => {
  const g = (globalThis as { window?: unknown }).window;
  try {
    (globalThis as { window?: unknown }).window = { localStorage: memoryStorage() };
    const first = gated(['api.acme.com']);
    decideEngineConsent('acme-dictation', 'acme', 'granted');
    const firstSeen = record(first.rec);
    first.rec.start();
    await settle();
    assert.equal(first.fake.micOpened, true, 'consented: the microphone opens');
    assert.deepEqual(firstSeen.errors, []);
    first.rec.abort();
    await settle();

    // The update now sends the voice to a second host.
    const updated = gated(['api.acme.com', 'eu.acme.com']);
    const updatedSeen = record(updated.rec);
    updated.rec.start();
    await settle();
    assert.equal(updated.fake.micOpened, false, 'no capture before the new destination is consented to');
    assert.deepEqual(updated.fake.calls, []);
    assert.deepEqual(updated.shown, ['acme']);
    assert.deepEqual(updatedSeen.errors, ['engine-consent']);
  } finally {
    (globalThis as { window?: unknown }).window = g;
  }
});
