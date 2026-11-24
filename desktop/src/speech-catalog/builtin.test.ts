// french-ok-file: the French credit line speech engines hallucinate
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  BUILTIN_SPEECH_MODELS, CANARY_180M_FLASH_INT8, COHERE_TRANSCRIBE_INT8, DEFAULT_SPEECH_MODEL_ID, PARAKEET_TDT_V3_INT8,
  primaryLanguage, resolveModel, speechModel,
} from './builtin.js';
import { modelFileUrl, modelSize, speechModelSchema, type SpeechModel } from './schema.js';
import { cleanTranscript } from '../speech-hallucinations.js';
import { workerInit } from '../speech-ipc.js';
import { DictationSession, type Recognizer } from '../speech-session.js';
import type { WorkerOutput } from '../speech-protocol.js';
import { chunks, concatAudio, hush, RATE, tone } from '../speech-audio-fixtures.test.js';

test('an unknown id resolves to no model, never to a path', () => {
  assert.equal(speechModel('../parakeet-tdt-0.6b-v3-int8'), null);
  assert.equal(speechModel('custom-anything'), null);
  assert.equal(speechModel(''), null);
});

test('every built-in entry passes the schema, is downloadable and redistributable', () => {
  for (const model of BUILTIN_SPEECH_MODELS) {
    assert.deepEqual(speechModelSchema.parse(model), model);
    assert.equal(model.source.kind, 'huggingface');
    assert.equal(model.license.redistribution, 'ok');
    // A built-in path stays a bare name: the v1 marker and the worker know nothing else.
    assert.ok(model.files.every((file) => !file.path.includes('/')), model.id);
  }
});

test('the pinned values do not drift (read at the source, 27/10/2026)', () => {
  // Parakeet keeps its id, folder and revision: installs from #443 stay ready.
  assert.equal(PARAKEET_TDT_V3_INT8.id, 'parakeet-tdt-0.6b-v3-int8');
  assert.deepEqual(PARAKEET_TDT_V3_INT8.source, {
    kind: 'huggingface', repository: 'csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8', revision: '2bda32ec70b097a55adaa07d9a7173915b43cc78',
  });
  assert.equal(modelSize(PARAKEET_TDT_V3_INT8), 670_478_772);
  assert.deepEqual(CANARY_180M_FLASH_INT8.source, {
    kind: 'huggingface', repository: 'csukuangfj/sherpa-onnx-nemo-canary-180m-flash-en-es-de-fr-int8', revision: '9077164e0d3dd1d5353743e89ceaa1d3a770838c',
  });
  assert.deepEqual(CANARY_180M_FLASH_INT8.files.map((file) => [file.role, file.path, file.sizeBytes, file.sha256]), [
    ['encoder', 'encoder.int8.onnx', 132_678_643, '7a75b4e2a5857a6dcc0819503bbe3fad66943db4a3ccf21d3f27c633667d303f'],
    ['decoder', 'decoder.int8.onnx', 74_437_848, 'e41a2ab9c0c2fe81a1e8ade5a45fb02a74bc4db7d1f91b89a54a25e2cf79cba2'],
    ['tokens', 'tokens.txt', 53_555, '2dae6fc7815f9640645e0c765522b278ee0cef49b482d91f6913e334628d3e77'],
  ]);
  assert.equal(PARAKEET_TDT_V3_INT8.languages.codes.length, 25);
  assert.equal(DEFAULT_SPEECH_MODEL_ID, PARAKEET_TDT_V3_INT8.id);
});

test('primaryLanguage keeps the primary subtag and treats anything else as Auto', () => {
  assert.equal(primaryLanguage('fr-FR'), 'fr');
  assert.equal(primaryLanguage('FR'), 'fr');
  assert.equal(primaryLanguage('pt_BR'), 'pt');
  assert.equal(primaryLanguage('auto'), null);
  assert.equal(primaryLanguage(''), null);
  assert.equal(primaryLanguage(undefined), null);
  assert.equal(primaryLanguage('../fr'), null);
});

test('resolveModel: Canary for en, fr, de, es with the language imposed', () => {
  for (const lang of ['en', 'fr', 'de', 'es', 'fr-CA']) {
    const resolved = resolveModel(lang);
    assert.equal(resolved?.model.id, CANARY_180M_FLASH_INT8.id, lang);
    assert.equal(resolved?.language, primaryLanguage(lang));
  }
});

test('resolveModel: Parakeet for Auto and the other languages, detecting', () => {
  for (const lang of ['auto', 'it', 'pl', 'uk', undefined, 'xx', 'ja']) {
    const resolved = resolveModel(lang);
    assert.equal(resolved?.model.id, PARAKEET_TDT_V3_INT8.id, String(lang));
    assert.equal(resolved?.language, null);
  }
});

test('resolveModel: a model that is not usable (not installed) gives way', () => {
  const installed = new Set([PARAKEET_TDT_V3_INT8.id]);
  const resolved = resolveModel('fr', { usable: (model) => installed.has(model.id) });
  assert.equal(resolved?.model.id, PARAKEET_TDT_V3_INT8.id);
  assert.equal(resolved?.language, null);
  assert.equal(resolveModel('fr', { usable: () => false }), null);
});

test('resolveModel: a model with a required language is never a default', () => {
  const required: SpeechModel = speechModelSchema.parse({
    ...CANARY_180M_FLASH_INT8,
    id: 'precise-fr',
    family: 'cohere-transcribe',
    languages: { codes: ['fr'], mode: 'required' },
    options: {},
  });
  const catalog = [required, ...BUILTIN_SPEECH_MODELS];
  assert.equal(resolveModel('fr', { catalog })?.model.id, CANARY_180M_FLASH_INT8.id);
  assert.equal(resolveModel('auto', { catalog })?.model.id, PARAKEET_TDT_V3_INT8.id);
  assert.equal(resolveModel('fr', { catalog: [required] }), null);
});

test('Cohere Transcribe: the pinned values do not drift (read at the source, 27/10/2026)', () => {
  assert.equal(COHERE_TRANSCRIBE_INT8.id, 'cohere-transcribe-03-2026-int8');
  assert.deepEqual(COHERE_TRANSCRIBE_INT8.source, {
    kind: 'huggingface', repository: 'csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01', revision: '156a470cf08eefe706a0004f3c52d9ee567ca7a0',
  });
  assert.deepEqual(COHERE_TRANSCRIBE_INT8.files.map((file) => [file.role, file.path, file.sizeBytes, file.sha256]), [
    ['encoder', 'encoder.int8.onnx', 3_090_822, 'cf704f8cfa90e3f0a76f9ffc05998bdf00ba9ae983192c14a85a3a5eb008b367'],
    ['data', 'encoder.int8.onnx.data', 2_731_503_072, 'bcf1b7148c8518ae52df1ad2d2fc2b4e89261ea23e6c874eef1d9f55bcbaa4a3'],
    ['decoder', 'decoder.int8.onnx', 153_250_705, '8372ca6c8ff4db8b916ca3592f5c757a715e691b9edec751ba19b29fc854baf9'],
    // Not in LFS: git blob 35dd2895… checked against the tree, sha256 of the file itself.
    ['tokens', 'tokens.txt', 207_437, '013ede043ae2480e3a9205cc34550d9686100cc682bacc90f702facdfbb93035'],
  ]);
  assert.equal(modelSize(COHERE_TRANSCRIBE_INT8), 2_888_052_036);
  assert.deepEqual(COHERE_TRANSCRIBE_INT8.memory, { ramBytes: 2_060_000_000, peakRamBytes: 3_600_000_000 });
  assert.equal(COHERE_TRANSCRIBE_INT8.tier, 'precise');
  assert.deepEqual(COHERE_TRANSCRIBE_INT8.languages, {
    codes: ['ar', 'de', 'el', 'en', 'es', 'fr', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'vi', 'zh'], mode: 'required',
  });
  assert.deepEqual(COHERE_TRANSCRIBE_INT8.interim, { mode: 'final-only' });
  assert.equal(COHERE_TRANSCRIBE_INT8.filter, 'cohere');
  assert.equal(COHERE_TRANSCRIBE_INT8.license.spdx, 'Apache-2.0');
  assert.match(COHERE_TRANSCRIBE_INT8.license.attribution, /^Cohere Labs/);
});

test('Cohere Transcribe: the external data file keeps the name the graph writes, and never reaches the addon', () => {
  const data = COHERE_TRANSCRIBE_INT8.files.find((file) => file.role === 'data');
  assert.equal(
    data && modelFileUrl(COHERE_TRANSCRIBE_INT8, data),
    'https://huggingface.co/csukuangfj2/sherpa-onnx-cohere-transcribe-14-lang-int8-2026-04-01/resolve/156a470cf08eefe706a0004f3c52d9ee567ca7a0/encoder.int8.onnx.data',
  );
  const init = workerInit(COHERE_TRANSCRIBE_INT8, { addonDir: 'addon', modelDir: 'model', language: 'fr', numThreads: 2 });
  assert.deepEqual(init.files, { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', tokens: 'tokens.txt' });
  assert.equal(init.family, 'cohere-transcribe');
  assert.equal(init.filter, 'cohere');
});

test('resolveModel never picks Cohere by itself, in any of its languages', () => {
  for (const lang of COHERE_TRANSCRIBE_INT8.languages.codes) {
    assert.notEqual(resolveModel(lang)?.model.id, COHERE_TRANSCRIBE_INT8.id, lang);
    // Even when it is the only model installed beside Parakeet.
    const usable = (model: SpeechModel): boolean => model.id !== CANARY_180M_FLASH_INT8.id;
    assert.equal(resolveModel(lang, { usable })?.model.id, PARAKEET_TDT_V3_INT8.id, lang);
  }
  assert.equal(resolveModel('fr', { usable: (model) => model.id === COHERE_TRANSCRIBE_INT8.id }), null);
});

test('on silence and noise, the filter of the Cohere entry drops "Sous-titrage Société Radio-Canada"', () => {
  const credit = 'Sous-titrage Société Radio-Canada';
  // What Cohere wrote on 2 s of silence, of white noise and of a pure tone (TODO #484).
  assert.equal(cleanTranscript(credit, { voicedMs: 0, totalMs: 2000 }, COHERE_TRANSCRIBE_INT8.filter), null);
  assert.equal(cleanTranscript(credit, { voicedMs: 2000, totalMs: 2000 }, COHERE_TRANSCRIBE_INT8.filter), null);
  assert.equal(cleanTranscript('Sous-titrage Société Radio-', { voicedMs: 2000, totalMs: 2000 }, COHERE_TRANSCRIBE_INT8.filter), null);

  // Through a session: a recognizer that invents the credit on anything it hears.
  const inventing: Recognizer = { decode: () => credit };
  const texts = (audio: Float32Array, filter: SpeechModel['filter']): string[] => {
    const out: WorkerOutput[] = [];
    const session = new DictationSession({ recognizer: inventing, emit: (m) => out.push(m), segmenter: { sampleRate: RATE }, filter });
    const id = randomUUID();
    session.start(id);
    for (const chunk of chunks(audio)) session.feed(id, chunk);
    session.stop(id);
    return out.flatMap((m) => (m.type === 'final' || m.type === 'partial' ? [m.text] : []));
  };
  const noise = concatAudio(tone(2000), hush(1000));
  for (const audio of [hush(2000), concatAudio(tone(2000, 0.05), hush(1000)), noise]) {
    assert.deepEqual(texts(audio, COHERE_TRANSCRIBE_INT8.filter), []);
  }
  // The session did decode it: the profile of a model that never invents it lets it through.
  assert.ok(texts(noise, 'nemo').includes(credit));
});

test('every built-in model is named, with its licence, in THIRD-PARTY-MODELS.md', () => {
  const notices = readFileSync(fileURLToPath(new URL('../../THIRD-PARTY-MODELS.md', import.meta.url)), 'utf8');
  for (const model of BUILTIN_SPEECH_MODELS) {
    assert.ok(model.source.kind === 'huggingface' && notices.includes(model.source.repository), `${model.id}: repository`);
    assert.ok(notices.includes(`(${model.license.spdx})`), `${model.id}: licence`);
    assert.ok(model.license.url && notices.includes(model.license.url), `${model.id}: upstream link`);
  }
  assert.match(notices, /Cohere Labs/);
});
