import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceFile } from './replace-file.js';

function locked(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: operation not permitted, rename`), { code });
}

test('replaces the destination with the source file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'timon-replace-file-'));
  try {
    const from = join(dir, 'provider.json.tmp');
    const to = join(dir, 'provider.json');
    await writeFile(to, 'old');
    await writeFile(from, 'new');
    await replaceFile(from, to);
    assert.equal(await readFile(to, 'utf8'), 'new');
    await assert.rejects(readFile(from, 'utf8'), { code: 'ENOENT' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('on Windows, retries a locked rename until it succeeds', async () => {
  let calls = 0;
  const waits: number[] = [];
  await replaceFile('a.tmp', 'a', {
    platform: 'win32',
    rename: async () => { calls++; if (calls <= 2) throw locked('EPERM'); },
    wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(calls, 3);
  assert.deepEqual(waits, [25, 50]);
});

test('on Windows, rethrows the last error once every attempt is spent', async () => {
  let calls = 0;
  const waits: number[] = [];
  const last = locked('EBUSY');
  await assert.rejects(
    replaceFile('a.tmp', 'a', {
      platform: 'win32',
      rename: async () => { calls++; throw calls === 10 ? last : locked('EACCES'); },
      wait: async (ms) => { waits.push(ms); },
    }),
    (error) => error === last,
  );
  assert.equal(calls, 10);
  assert.equal(waits.length, 9);
  // The whole wait stays bounded: the descriptor is published at startup.
  assert.ok(waits.reduce((sum, ms) => sum + ms, 0) <= 2000);
});

test('on Windows, does not retry an error that is not a lock', async () => {
  let calls = 0;
  await assert.rejects(
    replaceFile('a.tmp', 'a', {
      platform: 'win32',
      rename: async () => { calls++; throw locked('ENOENT'); },
      wait: async () => { assert.fail('must not wait'); },
    }),
    { code: 'ENOENT' },
  );
  assert.equal(calls, 1);
});

for (const platform of ['linux', 'darwin'] as const) {
  test(`on ${platform}, a refused rename fails at once`, async () => {
    let calls = 0;
    await assert.rejects(
      replaceFile('a.tmp', 'a', {
        platform,
        rename: async () => { calls++; throw locked('EPERM'); },
        wait: async () => { assert.fail('must not wait'); },
      }),
      { code: 'EPERM' },
    );
    assert.equal(calls, 1);
  });
}
