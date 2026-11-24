import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MODEL_FILES, modelFileUrl, modelPathProblem, parseSpeechModel, speechCatalogSchema, speechModelSchema, type SpeechModelInput } from './schema.js';

const SHA = 'a'.repeat(64);
const REV = '9077164e0d3dd1d5353743e89ceaa1d3a770838c';

function entry(patch: Partial<SpeechModelInput> = {}): SpeechModelInput {
  return {
    schema: 1,
    id: 'tiny-canary',
    label: 'Tiny Canary',
    family: 'nemo-canary',
    source: { kind: 'huggingface', repository: 'org/tiny', revision: REV },
    files: [
      { role: 'encoder', path: 'encoder.int8.onnx', sizeBytes: 10, sha256: SHA },
      { role: 'decoder', path: 'decoder.int8.onnx', sizeBytes: 10, sha256: SHA },
      { role: 'tokens', path: 'tokens.txt', sizeBytes: 10, sha256: SHA },
    ],
    memory: { ramBytes: 1, peakRamBytes: 2 },
    languages: { codes: ['fr', 'en'], mode: 'forced' },
    interim: { mode: 'live' },
    filter: 'nemo',
    options: { usePnc: true },
    license: { spdx: 'CC-BY-4.0', attribution: 'Someone', url: 'https://example.com/model', redistribution: 'ok' },
    ...patch,
  };
}

function withFile(path: string, extra: Partial<{ role: string; sha256: string; sizeBytes: number }> = {}): SpeechModelInput {
  const base = entry();
  const files = base.files.map((file) => (file.role === 'tokens' ? { ...file, path, ...extra } : file));
  return { ...base, files } as SpeechModelInput;
}

function refused(input: unknown, pattern: RegExp): void {
  const parsed = parseSpeechModel(input);
  assert.equal(parsed.ok, false, 'expected a refusal');
  if (!parsed.ok) assert.match(parsed.issues.join('\n'), pattern);
}

// Refusals first: a catalog entry decides which files the engine opens.

test('a ".." path is refused, alone or as a segment', () => {
  refused(withFile('..'), /invalid file path/);
  refused(withFile('../tokens.txt'), /invalid file path/);
  refused(withFile('tok/../tokens.txt'), /invalid file path/);
  refused(withFile('./tokens.txt'), /invalid file path/);
});

test('an absolute path is refused, Unix or Windows', () => {
  refused(withFile('/etc/passwd.txt'), /invalid file path/);
  refused(withFile('C:\\models\\tokens.txt'), /invalid file path/);
  refused(withFile('C:/tokens.txt'), /invalid file path/);
  refused(withFile('\\\\server\\share\\tokens.txt'), /invalid file path/);
});

test('two folder levels are refused, one is allowed', () => {
  refused(withFile('a/b/tokens.txt'), /more than one folder level/);
  assert.equal(parseSpeechModel(withFile('tokenizer/tokens.txt')).ok, true);
});

test('an unknown family is refused and reported as needing a newer Timon', () => {
  const parsed = parseSpeechModel(entry({ family: 'qwen3-asr' as SpeechModelInput['family'] }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.reason, 'unknown-family');
  const broken = parseSpeechModel({ ...entry(), files: [] });
  assert.equal(broken.ok, false);
  if (!broken.ok) assert.equal(broken.reason, 'invalid');
});

test('an invalid sha256 is refused: short, uppercase, missing, not hex', () => {
  refused(withFile('tokens.txt', { sha256: 'abc' }), /sha256/);
  refused(withFile('tokens.txt', { sha256: 'A'.repeat(64) }), /sha256/);
  refused(withFile('tokens.txt', { sha256: 'g'.repeat(64) }), /sha256/);
  const base = entry();
  const noHash = { ...base, files: base.files.map(({ sha256: _sha, ...file }) => file) };
  refused(noHash, /sha256/);
});

test('other file names the engine must never open are refused', () => {
  refused(withFile('tokens.sh'), /extension/);
  refused(withFile('tokens'), /extension/);
  refused(withFile('nul.txt'), /Windows/);
  refused(withFile('tokens.txt.'), /Windows|extension/);
  refused(withFile('tok ens.txt'), /invalid file path/);
  refused(withFile(''), /invalid file path/);
  refused(withFile(`${'a'.repeat(101)}.txt`), /invalid file path/);
  refused(withFile('tokens.txt', { sizeBytes: 0 }), /sizeBytes|too small|>/i);
});

test('the file list must match the family: roles, duplicates, size', () => {
  const base = entry();
  refused({ ...base, files: base.files.filter((file) => file.role !== 'decoder') }, /needs a "decoder"/);
  refused({ ...base, files: [...base.files, { role: 'joiner', path: 'joiner.onnx', sizeBytes: 1, sha256: SHA }] }, /role "joiner" is not used/);
  refused({ ...base, files: [...base.files, { role: 'tokens', path: 'other.txt', sizeBytes: 1, sha256: SHA }] }, /more than one "tokens"/);
  refused({ ...base, files: [...base.files, { role: 'data', path: 'Encoder.int8.onnx', sizeBytes: 1, sha256: SHA }] }, /share this path|not used/);
  const many = Array.from({ length: MAX_MODEL_FILES + 1 }, (_, i) => ({ role: 'data', path: `w${i}.data`, sizeBytes: 1, sha256: SHA }));
  refused({ ...entry({ family: 'cohere-transcribe', languages: { codes: ['fr'], mode: 'required' }, options: {} }), files: [...base.files, ...many] }, /files/);
  const huge = base.files.map((file) => ({ ...file, sizeBytes: 3 * 1024 ** 3 }));
  refused({ ...base, files: huge }, /8 GB/);
});

test('language mode and options are checked against the family', () => {
  refused(entry({ languages: { codes: ['fr'], mode: 'auto' } }), /cannot run in "auto"/);
  refused(entry({ languages: { codes: ['fr', 'fr'], mode: 'forced' } }), /listed twice/);
  refused(entry({ languages: { codes: ['french'], mode: 'forced' } }), /language code/);
  refused(entry({ languages: { codes: [], mode: 'forced' } }), /codes/);
  // A forced language goes into an addon parameter: only what the family's code knows.
  refused(entry({ languages: { codes: ['fr', 'it'], mode: 'forced' } }), /cannot impose "it"/);
  refused(entry({ family: 'cohere-transcribe', languages: { codes: ['tr'], mode: 'required' }, options: {} }), /cannot impose "tr"/);
  refused(entry({ options: { modelType: 'anything' } as unknown as Record<string, boolean> }), /options/);
  refused(entry({ options: { numThreads: 32 } }), /not allowed/);
  refused(entry({ options: { usePnc: 1 } }), /must be a boolean/);
});

test('source, id, license and unknown keys are checked', () => {
  refused(entry({ source: { kind: 'huggingface', repository: 'org/tiny', revision: 'main' } }), /commit sha/);
  refused(entry({ source: { kind: 'huggingface', repository: '../org', revision: REV } }), /owner\/name/);
  refused(entry({ source: { kind: 'huggingface', repository: 'org/tiny/extra', revision: REV } }), /owner\/name/);
  refused(entry({ source: { kind: 'ftp' } as unknown as SpeechModelInput['source'] }), /source/);
  refused(entry({ id: '../parakeet' }), /lowercase id/);
  refused(entry({ id: 'custom-mine' }), /custom-/);
  refused(entry({ source: { kind: 'local' } }), /custom-/);
  refused(entry({ license: { spdx: 'MIT', attribution: 'x', url: 'http://example.com', redistribution: 'ok' } }), /https/);
  refused({ ...entry(), configKey: 'transducer' }, /configKey|Unrecognized/i);
  refused({ ...entry(), schema: 2 }, /schema/);
  refused(entry({ memory: { ramBytes: 10, peakRamBytes: 5 } }), /peak/);
});

test('a tier is a product word from a closed list, never free text', () => {
  refused({ ...entry(), tier: 'fastest' }, /tier/);
  refused({ ...entry(), tier: 'Précis, 2,9 Go' }, /tier/); // french-ok: a French tier label, the shape under test
  refused({ ...entry(), tier: '' }, /tier/);
});

test('a catalog refuses two entries with the same id', () => {
  const model = speechModelSchema.parse(entry());
  assert.throws(() => speechCatalogSchema.parse([entry(), { ...entry(), label: 'Again' }]), /duplicate model id/);
  assert.equal(speechCatalogSchema.parse([entry()]).length, 1);
  assert.equal(model.id, 'tiny-canary');
});

// Then what passes.

test('a valid entry parses, with options defaulting to none', () => {
  const { options: _options, ...rest } = entry({ family: 'nemo-transducer', languages: { codes: ['fr'], mode: 'auto' } });
  const files = [...rest.files, { role: 'joiner' as const, path: 'joiner.int8.onnx', sizeBytes: 10, sha256: SHA }];
  const parsed = parseSpeechModel({ ...rest, files });
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.model.options, {});
  const local = parseSpeechModel(entry({ id: 'custom-mine', source: { kind: 'local' } }));
  assert.equal(local.ok, true);
  const precise = parseSpeechModel(entry({ tier: 'precise' }));
  assert.equal(precise.ok && precise.model.tier, 'precise');
});

test('an external data file may repeat for the family that uses it', () => {
  const base = entry({ family: 'cohere-transcribe', languages: { codes: ['fr'], mode: 'required' }, options: { usePunct: true } });
  const files = [...base.files, { role: 'data' as const, path: 'encoder.int8.onnx.data', sizeBytes: 5, sha256: SHA }];
  assert.equal(parseSpeechModel({ ...base, files }).ok, true);
});

test('modelPathProblem names nothing wrong for plain names', () => {
  assert.equal(modelPathProblem('encoder.int8.onnx'), null);
  assert.equal(modelPathProblem('tokenizer/vocab.json'), null);
  assert.equal(modelPathProblem('bpe.model'), null);
});

test('the download URL pins the revision and encodes each segment', () => {
  const model = speechModelSchema.parse(withFile('tokenizer/tokens.txt'));
  const tokens = model.files.find((file) => file.role === 'tokens');
  assert.ok(tokens);
  assert.equal(modelFileUrl(model, tokens), `https://huggingface.co/org/tiny/resolve/${REV}/tokenizer/tokens.txt`);
  const local = speechModelSchema.parse(entry({ id: 'custom-x', source: { kind: 'local' } }));
  assert.equal(modelFileUrl(local, local.files[0]!), null);
});
