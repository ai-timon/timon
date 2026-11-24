import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  readImportResult, readModelListings, readModelState, readPackOffers, readPackResult, readSpeechEvent, readSpeechState, readStartResult,
  wrapSpeechBridge, type RawSpeechBridge,
} from './desktop-speech';

const model = { modelId: 'parakeet-tdt-0.6b-v3-int8', status: 'absent', receivedBytes: 0, totalBytes: 670_478_772, error: null };

test('a state from the desktop is read as is', () => {
  assert.deepEqual(readSpeechState({ engine: 'available', model, sessionId: null }), { engine: 'available', model, sessionId: null });
});

test('an unknown engine or a malformed model is not a state', () => {
  assert.equal(readSpeechState({ engine: 'quantum', model, sessionId: null }), null);
  assert.equal(readSpeechState({ engine: 'available', model: { ...model, totalBytes: -1 } }), null);
  assert.equal(readSpeechState(null), null);
});

test('a model error this build does not know still reads as an error', () => {
  assert.equal(readModelState({ ...model, status: 'error', error: 'cosmic-ray' })?.error, 'io');
});

test('a start answer without a session is a failure, with a known code', () => {
  assert.deepEqual(readStartResult({ ok: true, sessionId: 'abc' }), { ok: true, sessionId: 'abc' });
  assert.deepEqual(readStartResult({ ok: false, code: 'model-missing', message: 'm' }), { ok: false, code: 'model-missing', message: 'm' });
  assert.deepEqual(readStartResult({ ok: true }), { ok: false, code: 'init-failed', message: '' });
  assert.deepEqual(readStartResult(undefined), { ok: false, code: 'init-failed', message: '' });
});

test('events are checked, unknown ones dropped', () => {
  assert.deepEqual(readSpeechEvent({ type: 'partial', sessionId: 's', text: 'bonjour' }), { type: 'partial', sessionId: 's', text: 'bonjour' });
  assert.deepEqual(readSpeechEvent({ type: 'stopped', sessionId: 's' }), { type: 'stopped', sessionId: 's' });
  assert.equal(readSpeechEvent({ type: 'final', sessionId: 's' }), null);
  assert.equal(readSpeechEvent({ type: 'telemetry', sessionId: 's' }), null);
  assert.deepEqual(readSpeechEvent({ type: 'model-state', state: model }), { type: 'model-state', state: model });
});

test('the wrapped bridge only hands checked events to its listener', () => {
  let forward: ((event: unknown) => void) | null = null;
  const raw = {
    onEvent: (listener: (event: unknown) => void) => { forward = listener; return () => {}; },
  } as unknown as RawSpeechBridge;
  const seen: unknown[] = [];
  wrapSpeechBridge(raw).onEvent((event) => seen.push(event));
  forward!({ type: 'final', sessionId: 's', text: 'ok' });
  forward!({ junk: true });
  assert.deepEqual(seen, [{ type: 'final', sessionId: 's', text: 'ok' }]);
});

test('the live catalog: an entry this build cannot read is left out, a list that is not one is refused', () => {
  const state = { modelId: 'canary', status: 'ready', receivedBytes: 1, totalBytes: 1, error: null };
  const good = { id: 'canary', model: { languages: { codes: ['en', 'fr'], mode: 'forced' } }, origin: { kind: 'builtin' }, state };
  assert.deepEqual(readModelListings([
    good,
    { ...good, id: 'other' },
    { ...good, model: { languages: { codes: ['../x'], mode: 'forced' } } },
    { ...good, model: { languages: { codes: ['fr'], mode: 'sometimes' } } },
    'canary',
  ]), [{
    id: 'canary', label: 'canary', family: null, origin: { kind: 'builtin' }, sizeBytes: 1, ramBytes: null, peakRamBytes: null, tier: null,
    languages: { codes: ['en', 'fr'], mode: 'forced' }, interim: null, license: null, state,
  }]);
  assert.equal(readModelListings({ models: [good] }), null);
  assert.equal(readModelListings(Array.from({ length: 65 }, () => good)), null);
});

test('a desktop without listModels answers null, and the start passes language and model on', async () => {
  const seen: unknown[][] = [];
  const raw = {
    getState: async () => null, downloadModel: async () => null, cancelDownload: async () => true, deleteModel: async () => null,
    startDictation: async (...args: unknown[]) => { seen.push(args); return { ok: true, sessionId: 's1' }; },
    feed: () => {}, stopDictation: async () => {}, cancelDictation: async () => {},
    microphone: async () => ({ status: 'granted' }), onEvent: () => () => {},
  } as RawSpeechBridge;
  const bridge = wrapSpeechBridge(raw);
  assert.equal(await bridge.listModels(), null);
  await bridge.startDictation({ language: 'fr' });
  await bridge.startDictation();
  assert.deepEqual(seen, [[undefined, 'fr', undefined], [undefined, undefined, undefined]]);
});

test('a catalog entry: an unknown origin, a malformed plugin id or model id is left out; texts lose their direction overrides', () => {
  const state = { modelId: 'acme.fr', status: 'absent', receivedBytes: 0, totalBytes: 0, error: null };
  const model = {
    label: 'Acme \u202eFR\u202c\nlarge', family: 'nemo-canary',
    files: [{ sizeBytes: 100 }, { sizeBytes: 107 }],
    memory: { ramBytes: 340_000_000 },
    languages: { codes: ['fr'], mode: 'forced' },
    interim: { mode: 'live' },
    license: { spdx: 'CC-BY-4.0', attribution: 'NVIDIA', url: 'javascript:alert(1)' },
  };
  const listing = { id: 'acme.fr', model, origin: { kind: 'pack', pluginId: 'acme' }, state };
  assert.deepEqual(readModelListings([
    { ...listing, origin: { kind: 'trusted' } },
    { ...listing, origin: { kind: 'pack', pluginId: '../acme' } },
    { ...listing, id: 'Acme FR', state: { ...state, modelId: 'Acme FR' } },
    listing,
  ]), [{
    id: 'acme.fr', label: 'Acme FRlarge', family: 'nemo-canary', origin: { kind: 'pack', pluginId: 'acme' },
    sizeBytes: 207, ramBytes: 340_000_000, peakRamBytes: null, tier: null, languages: { codes: ['fr'], mode: 'forced' }, interim: 'live',
    license: { spdx: 'CC-BY-4.0', attribution: 'NVIDIA', url: null }, state,
  }]);
});

test('a tier this build does not know, or a peak below the steady memory, reads as none; the precise tier and its peak read', () => {
  const state = { modelId: 'cohere', status: 'absent', receivedBytes: 0, totalBytes: 0, error: null };
  const model = {
    label: 'Cohere', languages: { codes: ['fr'], mode: 'required' },
    memory: { ramBytes: 2_060_000_000, peakRamBytes: 3_600_000_000 }, tier: 'precise',
  };
  const listing = { id: 'cohere', model, origin: { kind: 'builtin' }, state };
  const read = (patch: Record<string, unknown>) => readModelListings([{ ...listing, model: { ...model, ...patch } }])?.[0];
  assert.equal(read({ tier: 'fastest' })?.tier, null);
  assert.equal(read({ tier: 'Précis, 2,9 Go' })?.tier, null); // french-ok: a French tier label, the shape under test
  assert.equal(read({ tier: ['precise'] })?.tier, null);
  assert.equal(read({ memory: { ramBytes: 2_060_000_000, peakRamBytes: 1 } })?.peakRamBytes, null);
  assert.equal(read({ memory: { ramBytes: 2_060_000_000, peakRamBytes: -5 } })?.peakRamBytes, null);
  assert.equal(read({ memory: { ramBytes: 2_060_000_000, peakRamBytes: '3.6 GB' } })?.peakRamBytes, null);
  const good = read({});
  assert.equal(good?.tier, 'precise');
  assert.equal(good?.peakRamBytes, 3_600_000_000);
  assert.equal(good?.ramBytes, 2_060_000_000);
});

test('a start answer says what runs only when every field reads; an older desktop\'s answer still starts', () => {
  assert.deepEqual(readStartResult({ ok: true, sessionId: 's', modelId: 'canary-180m-flash-int8', language: 'fr', interim: 'delayed' }), {
    ok: true, sessionId: 's', session: { modelId: 'canary-180m-flash-int8', language: 'fr', interim: 'delayed' },
  });
  assert.deepEqual(readStartResult({ ok: true, sessionId: 's', modelId: 'parakeet', language: null, interim: 'live' }).ok, true);
  assert.deepEqual(readStartResult({ ok: true, sessionId: 's', modelId: 'parakeet', language: null, interim: 'live' }), {
    ok: true, sessionId: 's', session: { modelId: 'parakeet', language: null, interim: 'live' },
  });
  assert.deepEqual(readStartResult({ ok: true, sessionId: 's', modelId: 'parakeet', language: 'fr', interim: 'instant' }), { ok: true, sessionId: 's' });
  assert.deepEqual(readStartResult({ ok: true, sessionId: 's', modelId: '../x', language: 'fr', interim: 'live' }), { ok: true, sessionId: 's' });
});

test('an import answer: a refusal keeps a known code and the families to choose from, never anything else', () => {
  assert.deepEqual(readImportResult({ ok: false, code: 'family-needed', message: 'Choose', candidates: ['whisper', '../x', 3], file: '/home/me' }), {
    ok: false, code: 'family-needed', message: 'Choose', candidates: ['whisper'],
  });
  assert.deepEqual(readImportResult({ ok: false, code: 'telepathy' }), { ok: false, code: 'io', message: '', candidates: [] });
  assert.deepEqual(readImportResult({ ok: true, model: { id: 'other' }, state: { modelId: 'custom-x', status: 'ready', receivedBytes: 1, totalBytes: 1, error: null } }).ok, false);
  const state = { modelId: 'custom-x', status: 'ready', receivedBytes: 1, totalBytes: 1, error: null };
  assert.deepEqual(readImportResult({ ok: true, model: { id: 'custom-x' }, state }), { ok: true, modelId: 'custom-x', state });
});

test('the bridge names the model of each operation, and an import sends only family and languages', async () => {
  const seen: unknown[] = [];
  const raw = {
    getState: async (id?: string) => { seen.push(['state', id]); return null; },
    downloadModel: async (id?: string) => { seen.push(['download', id]); return null; },
    cancelDownload: async (id?: string) => { seen.push(['cancel', id]); return true; },
    deleteModel: async (id?: string) => { seen.push(['delete', id]); return null; },
    importModel: async (request?: unknown) => { seen.push(['import', request]); return { ok: false, code: 'cancelled' }; },
    startDictation: async () => ({ ok: true, sessionId: 's1' }),
    feed: () => {}, stopDictation: async () => {}, cancelDictation: async () => {},
    microphone: async () => ({ status: 'granted' }), onEvent: () => () => {},
  } as RawSpeechBridge;
  const bridge = wrapSpeechBridge(raw);
  await bridge.getState('canary');
  await bridge.downloadModel('canary');
  await bridge.cancelDownload('canary');
  await bridge.deleteModel('canary');
  await bridge.importModel();
  await bridge.importModel({ family: 'whisper', languages: ['fr'], path: '/etc' } as never);
  assert.deepEqual(seen, [
    ['state', 'canary'], ['download', 'canary'], ['cancel', 'canary'], ['delete', 'canary'],
    ['import', undefined], ['import', { family: 'whisper', languages: ['fr'] }],
  ]);
  const { importModel: _absent, ...older } = raw;
  assert.equal(await wrapSpeechBridge(older as RawSpeechBridge).importModel(), null);
});

const packEntry = (id: string) => ({
  id, label: `Model ${id}`, family: 'nemo-canary', files: [{ sizeBytes: 100 }, { sizeBytes: 50 }],
  languages: { codes: ['fr'], mode: 'forced' }, license: { spdx: 'MIT', attribution: 'Acme' },
});

test('a plugin\'s pack reads as offers under its own id only, absent until the desktop adds them', () => {
  const offers = readPackOffers('acme', { pluginId: 'acme', version: '1.0.0', models: [packEntry('acme.fr'), packEntry('beta.fr'), packEntry('acme'), { id: 'acme.x' }, 'x'] });
  assert.deepEqual(offers.map((offer) => [offer.id, offer.origin, offer.sizeBytes, offer.state.status, offer.state.totalBytes]), [
    ['acme.fr', { kind: 'pack', pluginId: 'acme' }, 150, 'absent', 150],
  ]);
  // Another plugin's answer, an id that is not a plugin id, no list.
  assert.deepEqual(readPackOffers('acme', { pluginId: 'beta', models: [packEntry('acme.fr')] }), []);
  assert.deepEqual(readPackOffers('../x', { pluginId: '../x', models: [packEntry('../x.fr')] }), []);
  assert.deepEqual(readPackOffers('acme', { pluginId: 'acme' }), []);
  assert.deepEqual(readPackOffers('acme', null), []);
});

test('a pack answer keeps a known code; anything else, an older desktop\'s refusal included, reads as unavailable', () => {
  const state = { modelId: 'acme.fr', status: 'absent', receivedBytes: 0, totalBytes: 150, error: null };
  assert.deepEqual(readPackResult({ ok: true, modelId: 'acme.fr', state }), { ok: true, modelId: 'acme.fr', state });
  assert.deepEqual(readPackResult({ ok: true, modelId: 'acme.other', state }), { ok: false, code: 'unavailable', message: '' });
  assert.deepEqual(readPackResult({ ok: false, code: 'not-found', message: 'm' }), { ok: false, code: 'not-found', message: 'm' });
  assert.deepEqual(readPackResult({ ok: false, code: 'cosmic', message: 'm' }), { ok: false, code: 'unavailable', message: 'm' });
  assert.deepEqual(readPackResult(null), { ok: false, code: 'unavailable', message: '' });
});

test('proposing a pack sends the two names only; an older desktop answers null or unavailable', async () => {
  const seen: unknown[] = [];
  const base = {
    getState: async () => null, downloadModel: async () => null, cancelDownload: async () => true, deleteModel: async () => null,
    startDictation: async () => ({ ok: true, sessionId: 's1' }),
    feed: () => {}, stopDictation: async () => {}, cancelDictation: async () => {},
    microphone: async () => ({ status: 'granted' }), onEvent: () => () => {},
  };
  const bridge = wrapSpeechBridge({
    ...base,
    proposePack: async (request: unknown) => { seen.push(request); return { ok: false, code: 'declined', message: '' }; },
  } as RawSpeechBridge);
  const forged = { pluginId: 'acme', modelId: 'acme.fr', model: packEntry('acme.fr') };
  assert.deepEqual(await bridge.proposePack(forged), { ok: false, code: 'declined', message: '' });
  assert.deepEqual(seen, [{ pluginId: 'acme', modelId: 'acme.fr' }]);
  assert.equal(await wrapSpeechBridge(base as RawSpeechBridge).proposePack({ pluginId: 'acme', modelId: 'acme.fr' }), null);
  const throwing = wrapSpeechBridge({ ...base, proposePack: async () => { throw new Error('Error invoking remote method'); } } as RawSpeechBridge);
  assert.equal((await throwing.proposePack({ pluginId: 'acme', modelId: 'acme.fr' }))?.ok, false);
});
