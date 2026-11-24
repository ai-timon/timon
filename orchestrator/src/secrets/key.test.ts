/**
 * Master key (`docs/SECRETS-VAULT.md` §4.4). The invariant under test is a
 * negative one: no failure path ever writes a new key over an existing one.
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SECRET_KEY_FILE } from '../paths.js';
import { MASTER_KEY_BYTES, open, seal } from './box.js';
import { SecretKeyError, readMasterKey, requireMasterKey, resetMasterKeyCache, resolveMasterKey } from './key.js';

/**
 * No keyring in these cases: S.2 made the host the default source, and the
 * machine running the suite may well have an unlocked one — the file behaviour
 * under test would then depend on the developer's desktop. The keyring paths
 * have their own cases in `keyring-key.test.ts`.
 */
const NO_KEYRING = { keyring: null } as const;

/** Each case starts from a blank home and a cold cache. */
function clean(): void {
  resetMasterKeyCache();
  rmSync(SECRET_KEY_FILE, { recursive: true, force: true });
}

function expectKeyError(fn: () => unknown, code: string): SecretKeyError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof SecretKeyError, `expected a SecretKeyError, got ${String(e)}`);
    assert.equal(e.code, code);
    return e;
  }
  throw new Error(`expected a SecretKeyError \`${code}\`, nothing was thrown`);
}

test('first use: the key is created, 32 bytes, base64, mode 0600', () => {
  clean();
  const key = resolveMasterKey(NO_KEYRING);
  assert.equal(key.length, MASTER_KEY_BYTES);
  const onDisk = readFileSync(SECRET_KEY_FILE, 'utf8');
  assert.deepEqual(Buffer.from(onDisk.trim(), 'base64'), key);
  if (process.platform !== 'win32') {
    assert.equal(statSync(SECRET_KEY_FILE).mode & 0o777, 0o600);
  }
});

test('a second call re-reads the same key, it does not draw a new one', () => {
  clean();
  const first = resolveMasterKey(NO_KEYRING);
  resetMasterKeyCache();
  assert.deepEqual(resolveMasterKey(NO_KEYRING), first);
  // And the key really is the one that opens what it sealed.
  const id = { secretId: 'sec_a', name: 'GITHUB_TOKEN' };
  assert.equal(open(seal('v', first, id), resolveMasterKey(NO_KEYRING), id), 'v');
});

test('no key + existing encrypted secrets → refusal, nothing written', () => {
  clean();
  const err = expectKeyError(() => resolveMasterKey({ ...NO_KEYRING, hasEncryptedSecrets: () => true }), 'would-orphan');
  assert.match(err.message, /undecipherable/);
  assert.equal(existsSync(SECRET_KEY_FILE), false);
});

test('an unreadable key file raises a typed error and is NOT rewritten', () => {
  clean();
  // A directory in place of the file: `readFileSync` fails with EISDIR on every
  // platform, without depending on the uid running the tests.
  mkdirSync(SECRET_KEY_FILE, { recursive: true });
  const sentinel = `${SECRET_KEY_FILE}/sentinel`;
  writeFileSync(sentinel, 'untouched');
  try {
    const err = expectKeyError(() => resolveMasterKey(NO_KEYRING), 'unreadable');
    assert.match(err.message, /NEVER regenerated/);
    expectKeyError(() => readMasterKey(), 'unreadable');
    expectKeyError(() => requireMasterKey(NO_KEYRING), 'unreadable');
    // Nothing was overwritten: still a directory, still holding its sentinel.
    assert.ok(lstatSync(SECRET_KEY_FILE).isDirectory());
    assert.equal(readFileSync(sentinel, 'utf8'), 'untouched');
  } finally {
    rmSync(SECRET_KEY_FILE, { recursive: true, force: true });
  }
});

// Windows has no read bit: chmod 0 only sets the read-only attribute, and the file stays readable.
test('a key file without read permission raises `unreadable`, not a new key', { skip: process.platform === 'win32' ? 'no POSIX read bit' : process.getuid?.() === 0 ? 'root reads everything' : false }, () => {
  clean();
  const original = randomBytes(MASTER_KEY_BYTES).toString('base64');
  writeFileSync(SECRET_KEY_FILE, original, { mode: 0o600 });
  chmodSync(SECRET_KEY_FILE, 0o000);
  try {
    expectKeyError(() => resolveMasterKey(NO_KEYRING), 'unreadable');
    chmodSync(SECRET_KEY_FILE, 0o600);
    assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), original);
  } finally {
    chmodSync(SECRET_KEY_FILE, 0o600);
  }
});

test('a malformed key file is refused, and left as it is', () => {
  for (const bad of ['not base64!!', '', Buffer.alloc(16).toString('base64'), Buffer.alloc(64).toString('base64')]) {
    clean();
    writeFileSync(SECRET_KEY_FILE, bad, { mode: 0o600 });
    expectKeyError(() => resolveMasterKey(NO_KEYRING), 'malformed');
    assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), bad, `\`${bad}\` was rewritten`);
  }
});

test('a trailing newline is tolerated (an editor, a `echo >` shell)', () => {
  clean();
  const b64 = randomBytes(MASTER_KEY_BYTES).toString('base64');
  writeFileSync(SECRET_KEY_FILE, `${b64}\n`, { mode: 0o600 });
  assert.deepEqual(resolveMasterKey(NO_KEYRING), Buffer.from(b64, 'base64'));
});

test('`requireMasterKey` never creates anything', () => {
  clean();
  expectKeyError(() => requireMasterKey(NO_KEYRING), 'absent');
  assert.equal(existsSync(SECRET_KEY_FILE), false);
  assert.equal(readMasterKey(), null);
});

test('a key file more permissive than 0600 is refused, not repaired', {
  skip: process.platform === 'win32' ? 'Windows has no POSIX mode bits' : false,
}, () => {
  clean();
  const original = randomBytes(MASTER_KEY_BYTES).toString('base64');
  writeFileSync(SECRET_KEY_FILE, original, { mode: 0o600 });
  assert.deepEqual(readMasterKey(), Buffer.from(original, 'base64'));

  chmodSync(SECRET_KEY_FILE, 0o644);
  resetMasterKeyCache();
  const err = expectKeyError(() => readMasterKey(), 'insecure-mode');
  assert.match(err.message, /readable beyond its owner/);
  expectKeyError(() => resolveMasterKey(NO_KEYRING), 'insecure-mode');
  assert.equal(statSync(SECRET_KEY_FILE).mode & 0o777, 0o644, 'the mode was silently repaired');
  assert.equal(readFileSync(SECRET_KEY_FILE, 'utf8'), original, 'the file was rewritten');
});
