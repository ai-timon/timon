/**
 * Agent import, folder reader (plugins/agent-import/src/readers/dir.ts): the
 * deny list wins over `wants`, nothing below the root is followed, the
 * ceilings bite on metadata, and the tree comes back as POSIX paths with the
 * bytes untouched.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foldsCase } from '../../tests/helpers/case-folding.js';
// Not through the readers' index: it pulls the zip reader, hence `fflate`, which this file does not need.
import { readDirSource } from '../../../plugins/agent-import/src/readers/dir.js';
import { DEFAULT_READER_LIMITS, resolveLimits } from '../../../plugins/agent-import/src/readers/limits.js';
import {
  compileGlob, globMatches, globMayMatchBelow, isUnportableSegment, ReaderError,
} from '../../../plugins/agent-import/src/readers/policy.js';

function tree(files: Record<string, string | Buffer>): string {
  const root = mkdtempSync(join(tmpdir(), 'agent-import-dir-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, ...rel.split('/'));
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

test('keeps the wanted files as POSIX paths, bytes and CRLF untouched', async () => {
  const root = tree({
    'SOUL.md': 'line one\r\nline two\r\n',
    'skills/review/SKILL.md': '# Review',
    'skills/review/refs/notes.md': 'notes',
    'sessions/2026-11-01.jsonl': '{}',
  });
  try {
    const out = await readDirSource(root, ['SOUL.md', 'skills/**']);
    assert.deepEqual([...out.files.keys()], ['SOUL.md', 'skills/review/SKILL.md', 'skills/review/refs/notes.md']);
    assert.equal(text(out.files.get('SOUL.md')), 'line one\r\nline two\r\n');
    assert.equal(out.totalBytes, 20 + 8 + 5);
    assert.deepEqual(out.notices, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the deny list applies before wants, even to an adapter asking for everything', async () => {
  const root = tree({
    '.env': 'OPENAI_API_KEY=sk-secret',
    'config/.env.local': 'X=1',
    'prod.env': 'X=1',
    'auth.json': '{"token":"secret"}',
    'state.db': 'sqlite',
    'state.db-wal': 'wal',
    'keys/server.pem': 'pem',
    'keys/api.KEY': 'key',
    'id_ed25519': 'ssh',
    'id_mapping.md': 'an ordinary file',
    '.git/config': '[core]',
    'node_modules/x/index.js': 'x',
    'SOUL.md': 'soul',
  });
  try {
    const out = await readDirSource(root, ['**']);
    assert.deepEqual([...out.files.keys()], ['id_mapping.md', 'SOUL.md'].sort());
    const blocked = out.skipped.filter((s) => s.reason === 'blocked').map((s) => s.path).sort();
    assert.deepEqual(blocked, [
      '.env', '.git', 'auth.json', 'config/.env.local', 'id_ed25519', 'keys/api.KEY', 'keys/server.pem',
      'node_modules', 'prod.env', 'state.db', 'state.db-wal',
    ]);
    for (const bytes of out.files.values()) assert.ok(!text(bytes).includes('secret'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('symbolic links are reported and never followed, to a file or to a folder', async () => {
  const outside = tree({ 'secret.md': 'outside the root', 'dir/SKILL.md': 'outside skill' });
  const root = tree({ 'skills/real/SKILL.md': 'real' });
  try {
    symlinkSync(join(outside, 'secret.md'), join(root, 'skills', 'leak.md'));
    symlinkSync(join(outside, 'dir'), join(root, 'skills', 'linked'), 'dir');
    const out = await readDirSource(root, ['skills/**']);
    assert.deepEqual([...out.files.keys()], ['skills/real/SKILL.md']);
    assert.deepEqual(
      out.skipped.filter((s) => s.reason === 'link').map((s) => s.path).sort(),
      ['skills/leak.md', 'skills/linked'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('every name starting with .env is a secret store: .envrc, .env_prod, .ENV.local', async () => {
  const root = tree({
    '.envrc': 'export TOKEN=sk-envrc',
    '.env_prod': 'TOKEN=sk-prod',
    'profiles/x/.ENV.local': 'TOKEN=sk-local',
    'SOUL.md': 'soul',
  });
  try {
    const out = await readDirSource(root, ['**']);
    assert.deepEqual([...out.files.keys()], ['SOUL.md']);
    assert.deepEqual(
      out.skipped.filter((s) => s.reason === 'blocked').map((s) => s.path).sort(),
      ['.env_prod', '.envrc', 'profiles/x/.ENV.local'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file with a second hard link is left out: it may be a secret stored outside the root', async () => {
  const outside = tree({ 'id_secret.txt': 'sk-hard-linked-secret' });
  const root = tree({ 'skills/real/SKILL.md': 'real' });
  try {
    linkSync(join(outside, 'id_secret.txt'), join(root, 'skills', 'real', 'notes.md'));
    const out = await readDirSource(root, ['skills/**']);
    assert.deepEqual([...out.files.keys()], ['skills/real/SKILL.md']);
    assert.deepEqual(out.skipped, [{ path: 'skills/real/notes.md', reason: 'hard-link' }]);
    for (const bytes of out.files.values()) assert.ok(!text(bytes).includes('sk-hard-linked-secret'));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('a nested archive is listed but never opened', async () => {
  const root = tree({ 'skills/a/SKILL.md': 'a', 'skills/a/bundle.zip': 'PK\x03\x04', 'skills/a/old.tar.gz': 'x' });
  try {
    const out = await readDirSource(root, ['skills/**']);
    assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
    assert.deepEqual(
      out.skipped.map((s) => [s.path, s.reason]),
      [['skills/a/bundle.zip', 'nested-archive'], ['skills/a/old.tar.gz', 'nested-archive']],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a file too large is skipped, a skill too large is dropped whole, the rest goes on', async () => {
  const root = tree({
    'big.md': Buffer.alloc(2048, 0x61),
    'skills/fat/SKILL.md': 'fat',
    'skills/fat/a.md': Buffer.alloc(600, 0x61),
    'skills/fat/b.md': Buffer.alloc(600, 0x61),
    'skills/many/SKILL.md': 'many',
    'skills/many/1.md': '1',
    'skills/many/2.md': '2',
    'skills/many/3.md': '3',
    'skills/ok/SKILL.md': 'ok',
  });
  try {
    const out = await readDirSource(root, ['**'], { limits: { maxFileBytes: 1024, maxSkillBytes: 1000, maxSkillFiles: 3 } });
    assert.deepEqual([...out.files.keys()], ['skills/ok/SKILL.md']);
    assert.deepEqual(out.skipped.map((s) => [s.path, s.reason]), [
      ['big.md', 'too-large'],
      ['skills/fat', 'skill-too-large'],
      ['skills/many', 'skill-too-large'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the ceilings of the whole source refuse it before reading any content', async () => {
  const root = tree({ 'a.md': 'aaaa', 'b.md': 'bbbb', 'c.md': 'cccc' });
  try {
    await assert.rejects(readDirSource(root, ['*.md'], { limits: { maxFiles: 2 } }),
      (err: unknown) => err instanceof ReaderError && err.code === 'too-many-files');
    await assert.rejects(readDirSource(root, ['*.md'], { limits: { maxBytes: 10 } }),
      (err: unknown) => err instanceof ReaderError && err.code === 'too-large');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the walk does not descend where no wants pattern can match', async () => {
  const files: Record<string, string> = { 'skills/a/SKILL.md': 'a' };
  for (let i = 0; i < 50; i++) files[`sessions/${i}.jsonl`] = '{}';
  const root = tree(files);
  try {
    const out = await readDirSource(root, ['skills/*/SKILL.md'], { limits: { maxVisited: 10 } });
    assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
    await assert.rejects(readDirSource(root, ['**/SKILL.md'], { limits: { maxVisited: 10 } }),
      (err: unknown) => err instanceof ReaderError && err.code === 'too-many-files');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A volume that folds case cannot hold both names: the zip reader covers the case everywhere.
test('two names equal but for case are both left out', { skip: foldsCase(tmpdir()) && 'this volume folds case' }, async () => {
  const root = tree({ 'skills/a/SKILL.md': 'a', 'skills/a/README.md': 'upper', 'skills/a/readme.md': 'lower' });
  try {
    const out = await readDirSource(root, ['skills/**']);
    assert.deepEqual([...out.files.keys()], ['skills/a/SKILL.md']);
    assert.deepEqual(out.skipped.map((s) => [s.path, s.reason]), [
      ['skills/a/README.md', 'case-collision'],
      ['skills/a/readme.md', 'case-collision'],
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// On Windows `a:b.md` is file `a` with an NTFS stream `b.md`: the name cannot be laid out there.
test('a name Windows cannot hold is left out', { skip: process.platform === 'win32' ? 'NTFS reads the colon as a stream' : false }, async () => {
  const root = tree({ 'notes/a:b.md': 'x', 'notes/ok.md': 'ok' });
  try {
    const out = await readDirSource(root, ['notes/*']);
    assert.deepEqual([...out.files.keys()], ['notes/ok.md']);
    assert.deepEqual(out.skipped, [{ path: 'notes/a:b.md', reason: 'unportable-name' }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing root or a file root is refused', async () => {
  const root = tree({ 'file.md': 'x' });
  try {
    await assert.rejects(readDirSource(join(root, 'missing'), ['**']),
      (err: unknown) => err instanceof ReaderError && err.code === 'not-a-directory');
    await assert.rejects(readDirSource(join(root, 'file.md'), ['**']),
      (err: unknown) => err instanceof ReaderError && err.code === 'not-a-directory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('globs: segments, double star, pruning, and no pattern escaping the root', () => {
  const g = compileGlob('skills/**/SKILL.md');
  assert.ok(globMatches(g, ['skills', 'SKILL.md']));
  assert.ok(globMatches(g, ['skills', 'a', 'b', 'SKILL.md']));
  assert.ok(!globMatches(g, ['other', 'SKILL.md']));
  assert.ok(!globMatches(compileGlob('*.md'), ['a', 'b.md']));
  assert.ok(globMatches(compileGlob('cron/job?.json'), ['cron', 'job1.json']));
  assert.ok(globMayMatchBelow(compileGlob('skills/*/SKILL.md'), ['skills', 'x']));
  assert.ok(!globMayMatchBelow(compileGlob('skills/*/SKILL.md'), ['skills', 'x', 'y']));
  assert.ok(!globMayMatchBelow(compileGlob('skills/*/SKILL.md'), ['sessions']));
  for (const bad of ['../x', '/etc/passwd', 'a\\b', '']) {
    assert.throws(() => compileGlob(bad), (err: unknown) => err instanceof ReaderError && err.code === 'unsafe-path');
  }
});

test('names Windows refuses are recognised', () => {
  for (const bad of ['CON', 'nul.txt', 'COM1', 'a:b', 'what?', 'trailing.', 'trailing ', 'tab\there']) {
    assert.ok(isUnportableSegment(bad), bad);
  }
  for (const ok of ['SKILL.md', 'café.md', 'console.md', '.hidden']) assert.ok(!isUnportableSegment(ok), ok); // french-ok: an accented file name the reader must keep
});

test('limits can be tightened, never loosened', () => {
  const limits = resolveLimits({ maxFiles: 10, maxBytes: Number.MAX_SAFE_INTEGER });
  assert.equal(limits.maxFiles, 10);
  assert.equal(limits.maxBytes, DEFAULT_READER_LIMITS.maxBytes);
});
