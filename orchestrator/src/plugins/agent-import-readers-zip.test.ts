/**
 * Agent import, zip reader and upload staging
 * (plugins/agent-import/src/readers/zip.ts, upload.ts). The archives are
 * forged byte by byte (plugins/agent-import/test/zip-writer.ts) to be exactly
 * what a hostile tool or the Windows Explorer writes. "Refused before
 * decompression" is proven with payloads that are NOT valid deflate: had the
 * reader inflated them, it would have failed with `corrupt` instead.
 */
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { forgeZip, unicodePathExtra, type ForgedEntry } from '../../../plugins/agent-import/test/zip-writer.js';
import { ReaderError, type ReaderErrorCode } from '../../../plugins/agent-import/src/readers/policy.js';
import { stageUpload } from '../../../plugins/agent-import/src/readers/upload.js';
import type { ZipReadOptions } from '../../../plugins/agent-import/src/readers/zip.js';
import type { SourceTree } from '../../../plugins/agent-import/src/readers/policy.js';

// `fflate` is a dependency of the plugin package: until `npm install` has run
// in plugins/agent-import, the zip reader cannot load, and its tests say so.
type ZipModule = typeof import('../../../plugins/agent-import/src/readers/zip.js');
const zipModule: ZipModule | null = await import('../../../plugins/agent-import/src/readers/zip.js').catch(() => null);
const skip = zipModule ? false : 'fflate is not installed in plugins/agent-import (run npm install there)';

const dir = mkdtempSync(join(tmpdir(), 'agent-import-zip-'));
let counter = 0;

async function read(entries: readonly ForgedEntry[] | Uint8Array, wants: readonly string[] = ['**'], options?: ZipReadOptions): Promise<SourceTree> {
  if (!zipModule) throw new Error('unreachable');
  const file = join(dir, `${++counter}.zip`);
  writeFileSync(file, entries instanceof Uint8Array ? entries : forgeZip(entries));
  return zipModule.readZipFile(file, wants, options);
}

async function refused(code: ReaderErrorCode, entries: readonly ForgedEntry[] | Uint8Array, wants: readonly string[] = ['**'], options?: ZipReadOptions): Promise<void> {
  await assert.rejects(read(entries, wants, options), (err: unknown) => {
    assert.ok(err instanceof ReaderError, String(err));
    assert.equal(err.code, code, err.message);
    return true;
  });
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);
const NOT_DEFLATE = new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

test('reads deflated and stored entries, CRLF untouched, in path order', { skip }, async () => {
  const out = await read([
    { name: 'skills/b/SKILL.md', data: 'b' },
    { name: 'SOUL.md', data: 'one\r\ntwo\r\n'.repeat(50) },
    { name: 'skills/', data: '', method: 0 },
    { name: 'config.yaml', data: 'model: x\n', method: 0 },
  ], ['SOUL.md', 'config.yaml', 'skills/**']);
  assert.deepEqual([...out.files.keys()], ['SOUL.md', 'config.yaml', 'skills/b/SKILL.md']);
  assert.equal(text(out.files.get('SOUL.md')), 'one\r\ntwo\r\n'.repeat(50));
  assert.equal(text(out.files.get('config.yaml')), 'model: x\n');
  assert.deepEqual(out.skipped, []);
  assert.deepEqual(out.notices, []);
});

test('Zip-Slip: any entry escaping the archive refuses it whole', { skip }, async () => {
  for (const name of ['../evil.md', 'skills/../../evil.md', '/etc/cron.d/x', 'C:\\Users\\x.md', 'c:x.md', '..\\..\\evil.md', '\\\\server\\share\\x', 'a\0b.md']) {
    await refused('unsafe-path', [{ name: 'SOUL.md', data: 'ok' }, { name, data: 'evil' }]);
  }
});

test('a zip from the Windows Explorer: backslashes, OEM names, DOS folders', { skip }, async () => {
  // french-ok-file: the accented names test the zip name decoding
  // "Café" in code page 850 (é = 0x82), no UTF-8 flag, host MS-DOS. french-ok: a quoted name
  const cafe = new Uint8Array([...Buffer.from('skills\\Caf'), 0x82, ...Buffer.from('\\SKILL.md')]);
  const out = await read([
    { name: 'skills\\', utf8Flag: false, dosAttr: 0x10, method: 0 },
    { name: new Uint8Array([...Buffer.from('skills\\Caf'), 0x82, 0x5c]), utf8Flag: false, dosAttr: 0x10, method: 0 },
    { name: cafe, utf8Flag: false, dosAttr: 0x20, data: '# Café\r\n' },
    { name: 'SOUL.md', utf8Flag: false, dosAttr: 0x20, data: 'soul\r\n' },
  ], ['SOUL.md', 'skills/**']);
  assert.deepEqual([...out.files.keys()], ['SOUL.md', 'skills/Café/SKILL.md'].sort());
  assert.equal(text(out.files.get('skills/Café/SKILL.md')), '# Café\r\n');
  assert.deepEqual(out.notices, [{ path: 'skills/Café/SKILL.md', code: 'name-not-utf8' }]);
});

test('names: UTF-8 without the flag, the Unicode Path field, and a lying UTF-8 flag', { skip }, async () => {
  const nfd = 'skills/cafe\u0301/SKILL.md';
  const noFlag = await read([{ name: Buffer.from(nfd, 'utf8'), utf8Flag: false, data: 'x' }]);
  assert.deepEqual([...noFlag.files.keys()], ['skills/café/SKILL.md'], 'UTF-8 accepted and NFC-normalised');
  assert.deepEqual(noFlag.notices, []);

  const raw = new Uint8Array([...Buffer.from('notes/r'), 0xe9, ...Buffer.from('sum')]);
  const field = await read([{ name: raw, utf8Flag: false, data: 'x', extra: unicodePathExtra(raw, 'notes/résumé') }]);
  assert.deepEqual([...field.files.keys()], ['notes/résumé']);
  assert.deepEqual(field.notices, []);

  await refused('corrupt', [{ name: raw, utf8Flag: true, data: 'x' }]);
});

test('symbolic links and special files inside the archive are reported, never read', { skip }, async () => {
  const out = await read([
    { name: 'skills/a/SKILL.md', data: 'a', unixMode: 0o100644 },
    { name: 'skills/a/leak.md', data: '/home/user/.ssh/id_rsa', unixMode: 0o120777, method: 0 },
    { name: 'skills/a/pipe', data: '', unixMode: 0o010644, method: 0 },
  ], ['skills/**']);
  assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
  assert.deepEqual(out.skipped, [{ path: 'skills/a/leak.md', reason: 'link' }, { path: 'skills/a/pipe', reason: 'special' }]);
});

test('the deny list wins over wants, one notice per denied folder', { skip }, async () => {
  const out = await read([
    { name: '.env', data: 'KEY=secret' },
    { name: 'auth.json', data: '{"token":"secret"}' },
    { name: 'state.db', data: 'sqlite' },
    { name: 'keys/id_rsa', data: 'ssh' },
    { name: 'tls/server.key', data: 'key' },
    { name: 'node_modules/a/index.js', data: 'a' },
    { name: 'node_modules/b/index.js', data: 'b' },
    { name: '.git/HEAD', data: 'ref' },
    { name: '__MACOSX/._SOUL.md', data: 'appledouble' },
    { name: '.DS_Store', data: 'finder' },
    { name: 'SOUL.md', data: 'soul' },
  ]);
  assert.deepEqual([...out.files.keys()], ['SOUL.md']);
  assert.deepEqual(out.skipped.map((s) => s.path), ['.DS_Store', '.env', '.git', '__MACOSX', 'auth.json', 'keys/id_rsa', 'node_modules', 'state.db', 'tls/server.key']);
  assert.ok(out.skipped.every((s) => s.reason === 'blocked'));
});

test('a nested archive is never opened', { skip }, async () => {
  const inner = forgeZip([{ name: 'SOUL.md', data: 'inner' }]);
  const out = await read([{ name: 'skills/a/SKILL.md', data: 'a' }, { name: 'skills/a/more.zip', data: inner, method: 0 }], ['skills/**']);
  assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
  assert.deepEqual(out.skipped, [{ path: 'skills/a/more.zip', reason: 'nested-archive' }]);
});

test('ceilings of the whole archive refuse it before anything is inflated', { skip }, async () => {
  const garbage = (name: string, declaredSize: number): ForgedEntry => ({ name, payload: NOT_DEFLATE, declaredSize });
  await refused('too-many-files', [garbage('a.md', 1), garbage('b.md', 1), garbage('c.md', 1)], ['**'], { limits: { maxFiles: 2 } });
  await refused('too-large', [garbage('a.md', 600), garbage('b.md', 600)], ['**'], { limits: { maxBytes: 1000 } });
  // The ratio applies to entries nobody asked for too: a bomb is refused, not merely skipped.
  await refused('bomb', [garbage('bomb.bin', 2 * 1024 * 1024), { name: 'SOUL.md', data: 'ok' }], ['SOUL.md']);
  const archive = forgeZip([{ name: 'SOUL.md', data: 'x'.repeat(1000) }]);
  await refused('too-large', archive, ['**'], { maxArchiveBytes: archive.length - 1 });
});

test('an entry that inflates past its declared size is cut off', { skip }, async () => {
  await refused('bomb', [{ name: 'SOUL.md', data: 'a'.repeat(100_000), declaredSize: 100 }]);
});

test('two names equal but for case are both left out', { skip }, async () => {
  const out = await read([
    { name: 'skills/a/SKILL.md', data: 'a' },
    { name: 'skills/a/README.md', data: 'upper' },
    { name: 'skills/a/readme.md', data: 'lower' },
  ]);
  assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
  assert.deepEqual(out.skipped.map((s) => [s.path, s.reason]), [
    ['skills/a/README.md', 'case-collision'],
    ['skills/a/readme.md', 'case-collision'],
  ]);
});

test('a skill too large is dropped whole, before inflating it', { skip }, async () => {
  const out = await read([
    { name: 'skills/fat/SKILL.md', data: 'fat' },
    { name: 'skills/fat/data.md', payload: NOT_DEFLATE, declaredSize: 5000 },
    { name: 'skills/ok/SKILL.md', data: 'ok' },
  ], ['skills/**'], { limits: { maxSkillBytes: 4096 } });
  assert.deepEqual([...out.files.keys()], ['skills/ok/SKILL.md']);
  assert.deepEqual(out.skipped, [{ path: 'skills/fat', reason: 'skill-too-large' }]);
});

test('malformed archives are refused cleanly', { skip }, async () => {
  const good = forgeZip([{ name: 'SOUL.md', data: 'soul' }, { name: 'skills/a/SKILL.md', data: 'a' }]);
  await refused('corrupt', new Uint8Array(0));
  await refused('corrupt', Buffer.from('this is not a zip archive at all, only text'));
  await refused('corrupt', good.subarray(0, good.length - 10), ['**']);
  await refused('corrupt', good.subarray(20), ['**']);
  await refused('corrupt', [{ name: 'SOUL.md', data: 'soul', crc: 1234 }]);
  await refused('corrupt', [{ name: 'SOUL.md', payload: NOT_DEFLATE, declaredSize: 4 }]);
  await refused('corrupt', [{ name: 'SOUL.md', data: 'a' }, { name: 'SOUL.md', data: 'b' }]);
  await refused('corrupt', [{ name: 'a.md', data: 'aaaa', method: 0 }, { name: 'b.md', data: 'aaaa', method: 0, localOffset: 0 }]);
  await refused('unsupported', [{ name: 'SOUL.md', data: 'soul', encrypted: true }]);
});

test('an encrypted entry nobody wants does not block the import', { skip }, async () => {
  const out = await read([{ name: 'SOUL.md', data: 'soul' }, { name: 'private/vault.md', data: 'x', encrypted: true }], ['SOUL.md']);
  assert.deepEqual([...out.files.keys()], ['SOUL.md']);
});

test('an archive comment holding a fake end record does not fool the reader', { skip }, async () => {
  const fake = Buffer.alloc(22);
  fake.writeUInt32LE(0x06054b50, 0);
  const archive = forgeZip([{ name: 'SOUL.md', data: 'soul' }], `before${fake.toString('latin1')}after`);
  const out = await read(archive);
  assert.deepEqual([...out.files.keys()], ['SOUL.md']);
});

test('upload staging: streamed to a private temporary file, cut at the ceiling', async () => {
  const base = mkdtempSync(join(tmpdir(), 'agent-import-stage-'));
  try {
    const staged = await stageUpload(Readable.from([Buffer.from('PK'), Buffer.from('rest')]), { dir: base });
    assert.equal(staged.size, 6);
    assert.ok(existsSync(staged.path));
    await staged.dispose();
    assert.deepEqual(readdirSync(base), []);

    let pulled = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        pulled++;
        yield new Uint8Array(1024);
      }
    }
    await assert.rejects(stageUpload(endless(), { dir: base, maxBytes: 4096 }),
      (err: unknown) => err instanceof ReaderError && err.code === 'too-large');
    assert.equal(pulled, 5, 'the stream stops right after the ceiling');
    assert.deepEqual(readdirSync(base), [], 'nothing left behind');

    await assert.rejects(stageUpload(endless(), { dir: base, declaredBytes: 1024 ** 3 }),
      (err: unknown) => err instanceof ReaderError && err.code === 'too-large');
    assert.equal(pulled, 5, 'a too large Content-Length is refused before reading');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

after(() => rmSync(dir, { recursive: true, force: true }));
