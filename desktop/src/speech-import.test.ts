// french-ok-file: accented model names and the French locale of the prompts under test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PARAKEET_TDT_V3_INT8 } from './speech-catalog/builtin.js';
import type { SpeechModel } from './speech-catalog/schema.js';
import type { EnginePort } from './speech-engine-host.js';
import {
  copyScannedFile, importModelFolder, ImportRefused, importSlug, packConfirmDialog, probeModel, scanModelFolder,
  type ImportDeps, type ImportErrorCode, type ImportRequest,
} from './speech-import.js';
import { SpeechModelManager, type VetResult } from './speech-model-manager.js';
import { inspectModelGraphs } from './speech-onnx-inspect.js';
import { DATA_NAME, externalDataModel, graph, model as onnxModel, PASSWD_ESCAPE, patchBytes, tensor } from './speech-onnx.fixture.js';
import type { WorkerInit, WorkerInput } from './speech-protocol.js';

const sha = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const cleanGraph = onnxModel(graph({ initializers: [tensor({ name: 'w', rawBytes: 2048 })] }));
const smallGraph = onnxModel(graph());
const tokens = Buffer.from('a 0\nb 1\n');
const linksWork = process.platform !== 'win32';

/** A sherpa transducer export as a Hugging Face clone leaves it. */
function transducerFolder(name = 'My Parakeet FR', extra: Record<string, Buffer | string> = {}): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'import-src-')), name);
  mkdirSync(dir);
  const files: Record<string, Buffer | string> = {
    'encoder.int8.onnx': cleanGraph, 'decoder.int8.onnx': smallGraph, 'joiner.int8.onnx': smallGraph, 'tokens.txt': tokens, ...extra,
  };
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
  return dir;
}

function setup(options: { probe?: (model: SpeechModel, dir: string) => Promise<VetResult>; runnable?: boolean } = {}) {
  const modelsDir = mkdtempSync(join(tmpdir(), 'import-models-'));
  const manager = new SpeechModelManager({
    modelsDir,
    catalog: [PARAKEET_TDT_V3_INT8],
    fetch: async () => { throw new Error('no request expected'); },
    vetting: {
      inspect: async (model, dir) => { const r = await inspectModelGraphs(model, dir); return r.ok ? { ok: true } : r; },
      probe: async () => ({ ok: true }),
    },
    log: () => undefined,
  });
  const probes: string[] = [];
  const deps: ImportDeps = {
    manager,
    modelsDir: async () => modelsDir,
    runnable: () => options.runnable ?? true,
    probe: async (model, dir) => { probes.push(model.id); return options.probe ? options.probe(model, dir) : { ok: true }; },
    freeBytes: async () => null,
  };
  const run = (source: string, request: ImportRequest = {}) => importModelFolder(source, request, deps);
  return { modelsDir, manager, deps, probes, run };
}

async function refused(promise: Promise<unknown>, code: ImportErrorCode): Promise<ImportRefused> {
  let caught: unknown = null;
  await promise.catch((error: unknown) => { caught = error; });
  assert.ok(caught instanceof ImportRefused, `expected ImportRefused(${code}), got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  return caught;
}

/** A utility process stand-in: answers `init` the way `answer` says. */
function fakeWorker(answer: 'ready' | 'init-failed' | 'abort' | 'silent') {
  const sent: WorkerInput[] = [];
  let killed = 0;
  let onMessage: (message: unknown) => void = () => undefined;
  let onExit: (code: number) => void = () => undefined;
  const port: EnginePort = {
    postMessage(message) {
      sent.push(message);
      queueMicrotask(() => {
        // `terminate called after throwing an instance of 'Ort::Exception'`: SIGABRT, no message first.
        if (answer === 'abort') onExit(134);
        else if (answer === 'ready') onMessage({ type: 'ready' });
        else if (answer === 'init-failed') onMessage({ type: 'init-failed', message: 'bad model' });
      });
    },
    on(event: 'message' | 'exit', listener: ((message: unknown) => void) | ((code: number) => void)) {
      if (event === 'message') onMessage = listener as (message: unknown) => void;
      else onExit = listener as (code: number) => void;
      return port;
    },
    kill() { killed += 1; return true; },
  };
  return { port, sent, killed: () => killed };
}

const INIT: WorkerInit = {
  type: 'init', addonDir: '/addon', modelDir: '/models/custom-x.partial',
  files: { encoder: 'encoder.int8.onnx', decoder: 'decoder.int8.onnx', joiner: 'joiner.int8.onnx', tokens: 'tokens.txt' },
  sampleRate: 16_000, numThreads: 1,
};

// Refusals first (AGENTS.md rule 8).

test('a symbolic link is refused: a model file, a link under an ignored name, or the folder itself', { skip: !linksWork }, async () => {
  const outside = join(mkdtempSync(join(tmpdir(), 'outside-')), 'secret.txt');
  writeFileSync(outside, 'secret');
  const { run, modelsDir } = setup();
  const linkedTokens = transducerFolder('linked');
  const tokensPath = join(linkedTokens, 'tokens.txt');
  rmSync(tokensPath);
  symlinkSync(outside, tokensPath);
  assert.equal((await refused(run(linkedTokens), 'symlink')).detail.file, 'tokens.txt');

  const linkedReadme = transducerFolder('readme');
  symlinkSync(outside, join(linkedReadme, 'README.md'));
  await refused(run(linkedReadme), 'symlink');

  const real = transducerFolder('real');
  const alias = join(mkdtempSync(join(tmpdir(), 'alias-')), 'alias');
  symlinkSync(real, alias);
  await refused(run(alias), 'symlink');
  assert.deepEqual(readdirSync(modelsDir), []);
});

test('a file with an extension outside the list, or a name no OS can hold, is refused', async () => {
  const { run } = setup();
  for (const name of ['libsherpa.so', 'encoder.onnx.exe', 'tokens.bin', 'model.dylib']) {
    const err = await refused(run(transducerFolder(`ext-${name}`, { [name]: 'x' })), 'extension');
    assert.equal(err.detail.file, name);
  }
  await refused(run(transducerFolder('space', { 'my tokens.txt': 'x' })), 'file-name');
  await refused(run(transducerFolder('accent', { 'modèle.onnx': 'x' })), 'file-name');
});

test('17 model files are refused, a nested folder too', async () => {
  const { run } = setup();
  const many: Record<string, string> = {};
  for (let i = 0; i < 13; i += 1) many[`extra-${i}.json`] = '{}';
  await refused(run(transducerFolder('many', many)), 'too-many-files');
  const nested = transducerFolder('nested');
  mkdirSync(join(nested, 'tokenizer'));
  await refused(run(nested), 'nested-folder');
});

test('a graph patched to read ../../../../etc/passwd is refused at the import, and nothing is installed', async () => {
  const { run, modelsDir, probes } = setup();
  const patched = patchBytes(externalDataModel(), DATA_NAME, PASSWD_ESCAPE);
  const source = transducerFolder('escape', { 'encoder.int8.onnx': patched, [DATA_NAME]: Buffer.alloc(16) });
  const err = await refused(run(source), 'unsafe-graph');
  assert.match(err.message, /outside the model folder/);
  assert.deepEqual(probes, []);
  assert.deepEqual(readdirSync(modelsDir), []);
});

test('a graph reading a file the folder does not hold is refused', async () => {
  const { run } = setup();
  // The graph names DATA_NAME; the folder has no such file.
  await refused(run(transducerFolder('missing-data', { 'encoder.int8.onnx': externalDataModel() })), 'unsafe-graph');
});

test('a model that aborts its process is refused as an invalid model, not as a crashed engine', async () => {
  const worker = fakeWorker('abort');
  assert.deepEqual(await probeModel(() => worker.port, INIT, 5_000), { ok: false, message: 'The engine stopped while loading the model.' });
  assert.equal(worker.sent[0]?.type, 'init');

  const { run, modelsDir, manager } = setup({
    probe: () => probeModel(() => fakeWorker('abort').port, INIT, 5_000),
  });
  const err = await refused(run(transducerFolder('aborts')), 'load-failed');
  assert.match(err.message, /not a valid nemo-transducer model/);
  assert.deepEqual(readdirSync(modelsDir), []);
  assert.deepEqual((await manager.list()).map((entry) => entry.model.id), [PARAKEET_TDT_V3_INT8.id]);
});

test('a probe that reports a load failure or never answers is refused, and its process is ended', async () => {
  const failing = fakeWorker('init-failed');
  assert.equal((await probeModel(() => failing.port, INIT, 5_000)).ok, false);
  assert.equal(failing.killed(), 1);
  const silent = fakeWorker('silent');
  assert.deepEqual(await probeModel(() => silent.port, INIT, 20), { ok: false, message: 'Loading the model took too long.' });
  assert.equal(silent.killed(), 1);
  assert.equal((await probeModel(() => { throw new Error('spawn failed'); }, INIT, 5_000)).ok, false);
});

test('a family that cannot be told apart, two candidates for a role, or a missing language list is refused', async () => {
  const { run, modelsDir } = setup();
  const noJoiner = transducerFolder('canary-like');
  rmSync(join(noJoiner, 'joiner.int8.onnx'));
  const err = await refused(run(noJoiner), 'family-needed');
  assert.deepEqual(err.detail.candidates, ['nemo-canary', 'whisper', 'cohere-transcribe']);
  await refused(run(noJoiner, { family: 'nemo-canary' }), 'languages-needed');
  await refused(run(noJoiner, { family: 'nemo-transducer' }), 'roles');
  await refused(run(transducerFolder('two', { 'encoder.onnx': cleanGraph })), 'roles');
  await refused(run(join(modelsDir, 'no-such-folder')), 'not-a-folder');
  assert.deepEqual(readdirSync(modelsDir), []);
});

test('a family this desktop cannot run is refused before anything is copied', async () => {
  const { run, modelsDir } = setup({ runnable: false });
  await refused(run(transducerFolder('later')), 'unsupported-family');
  assert.deepEqual(readdirSync(modelsDir), []);
});

test('a file that changes between the scan and the copy is refused', async () => {
  const source = transducerFolder('changing');
  const [encoder] = (await scanModelFolder(source)).filter((file) => file.name === 'encoder.int8.onnx');
  assert.ok(encoder);
  writeFileSync(join(source, 'encoder.int8.onnx'), Buffer.concat([cleanGraph, Buffer.from('more')]));
  const target = join(mkdtempSync(join(tmpdir(), 'copy-')), 'encoder.int8.onnx');
  await refused(copyScannedFile(source, encoder, target), 'changed');
});

// Then what passes.

test('a transducer folder imports: copied, hashed, loaded once, ready, and found again after a restart', async () => {
  const source = transducerFolder('Mon modèle Parakeet (FR)', {
    'README.md': '# model', '.gitattributes': '*.onnx filter=lfs', 'export-onnx.py': 'print(1)',
  });
  mkdirSync(join(source, 'test_wavs'));
  writeFileSync(join(source, 'test_wavs', '0.wav'), 'RIFF');
  const { run, modelsDir, probes, manager } = setup();
  const { model, state } = await run(source);
  assert.equal(model.id, 'custom-mon-modele-parakeet-fr');
  assert.equal(model.label, 'Mon modèle Parakeet (FR)');
  assert.equal(model.family, 'nemo-transducer');
  assert.deepEqual(model.languages, { codes: ['und'], mode: 'auto' });
  assert.equal(state.status, 'ready');
  assert.deepEqual(probes, [model.id]);
  const encoder = model.files.find((file) => file.role === 'encoder');
  assert.equal(encoder?.sha256, sha(cleanGraph));
  assert.deepEqual(readdirSync(join(modelsDir, model.id)).sort(), ['decoder.int8.onnx', 'encoder.int8.onnx', 'joiner.int8.onnx', 'model.json', 'tokens.txt']);
  const marker = JSON.parse(readFileSync(join(modelsDir, model.id, 'model.json'), 'utf8')) as Record<string, unknown>;
  assert.equal(marker.verified, false);
  assert.deepEqual(marker.origin, { kind: 'local' });
  assert.ok(await manager.ready(model.id));

  const again = new SpeechModelManager({
    modelsDir, catalog: [PARAKEET_TDT_V3_INT8], fetch: async () => { throw new Error('none'); },
    vetting: { inspect: async () => ({ ok: true }), probe: async () => ({ ok: true }) }, log: () => undefined,
  });
  assert.deepEqual((await again.list()).map((entry) => [entry.model.id, entry.origin.kind]), [
    [PARAKEET_TDT_V3_INT8.id, 'builtin'], [model.id, 'local'],
  ]);
  assert.equal((await again.state(model.id)).status, 'ready');

  // The same folder again: a second model, its own id.
  assert.equal((await run(source)).model.id, 'custom-mon-modele-parakeet-fr-2');
  // Removing an import takes it out of the catalog.
  assert.equal((await manager.remove(model.id)).status, 'absent');
  assert.equal(await manager.has(model.id), false);
  assert.ok(!existsSync(join(modelsDir, model.id)));
});

test('a graph with external data in the folder imports with that file as a data role, languages as given', async () => {
  const source = transducerFolder('cohere-like', { 'encoder.int8.onnx': externalDataModel(), [DATA_NAME]: Buffer.alloc(16, 1), 'unused.data': 'x' });
  rmSync(join(source, 'joiner.int8.onnx'));
  const { run, modelsDir } = setup();
  const { model } = await run(source, { family: 'cohere-transcribe', languages: ['fr', 'de', 'fr'] });
  assert.deepEqual(model.languages, { codes: ['fr', 'de'], mode: 'required' });
  assert.deepEqual(model.files.map((file) => `${file.role}:${file.path}`).sort(), [
    `data:${DATA_NAME}`, 'decoder:decoder.int8.onnx', 'encoder:encoder.int8.onnx', 'tokens:tokens.txt',
  ]);
  assert.equal(model.interim.mode, 'final-only');
  // A file the graphs do not read is left behind.
  assert.ok(!existsSync(join(modelsDir, model.id, 'unused.data')));
});

test('a probe that loads the model succeeds and ends its process', async () => {
  const worker = fakeWorker('ready');
  assert.deepEqual(await probeModel(() => worker.port, INIT, 5_000), { ok: true });
  assert.equal(worker.killed(), 1);
});

test('the id of an import is a slug of its folder name', () => {
  assert.equal(importSlug('Mon modèle (FR)'), 'mon-modele-fr');
  assert.equal(importSlug('..hidden..name..'), 'hidden.name');
  assert.equal(importSlug('日本語'), 'model');
  assert.equal(importSlug('x'.repeat(80)).length, 48);
});

test('the pack confirmation is computed from the entry, cancels by default and strips direction overrides', () => {
  const model = { ...PARAKEET_TDT_V3_INT8, id: 'acme.fr', label: 'Acme ‮FR‬ model' } as SpeechModel;
  const fr = packConfirmDialog(model, 'acme', 'fr-FR');
  assert.deepEqual([fr.defaultId, fr.cancelId, fr.buttons[0]], [0, 0, 'Annuler']);
  assert.equal(fr.message, 'Télécharger « Acme FR model » ?');
  assert.match(fr.detail, /Fourni par le plugin installé : acme/);
  assert.doesNotMatch(fr.detail, /Proposé/);
  assert.match(fr.detail, /huggingface\.co\/csukuangfj\/sherpa-onnx-nemo-parakeet-tdt-0\.6b-v3-int8/);
  assert.match(fr.detail, /670 Mo/);
  const en = packConfirmDialog(model, 'acme', 'en-US');
  assert.deepEqual(en.buttons, ['Cancel', 'Download']);
  assert.match(en.detail, /Licence: CC-BY-4\.0 — NVIDIA/);
  assert.match(en.detail, /From the installed plugin: acme/);
});
