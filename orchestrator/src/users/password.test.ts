import { randomBytes, scryptSync } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, hashPasswordSync, needsRehash, passwordTiming, verifyAccountPassword, verifyPassword } from './password.js';

/** A hash as the daemon wrote it before the cost was raised (N=2^14). */
function legacyHash(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

test('new hashes use the OWASP cost (N=2^17, r=8, p=1) and verify', async () => {
  const encoded = await hashPassword('correct horse');
  assert.match(encoded, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', encoded), true);
  assert.equal(await verifyPassword('wrong horse', encoded), false);
  assert.equal(needsRehash(encoded), false);
});

test('the synchronous hash writes the same format and verifies asynchronously', async () => {
  const encoded = hashPasswordSync('correct horse');
  assert.match(encoded, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword('correct horse', encoded), true);
  assert.equal(await verifyPassword('wrong horse', encoded), false);
});

test('a hash written with the old cost still verifies and asks for a rehash', async () => {
  const old = legacyHash('correct horse');
  assert.equal(await verifyPassword('correct horse', old), true);
  assert.equal(await verifyPassword('wrong horse', old), false);
  assert.equal(needsRehash(old), true);
});

test('a malformed hash never verifies and asks for a rehash', async () => {
  assert.equal(await verifyPassword('x', 'bcrypt$whatever'), false);
  assert.equal(needsRehash('bcrypt$whatever'), true);
});

test('a stored cost above the memory cap is refused, not allocated', async () => {
  const salt = randomBytes(16).toString('base64url');
  const key = randomBytes(32).toString('base64url');
  assert.equal(await verifyPassword('x', `scrypt$1048576$8$1$${salt}$${key}`), false);
});

test('the event loop keeps turning while a password is checked', async () => {
  const encoded = await hashPassword('correct horse');
  const order: string[] = [];
  setImmediate(() => order.push('immediate'));
  // A synchronous scrypt would settle before the check phase ever runs.
  const ok = await verifyPassword('correct horse', encoded);
  order.push('verified');
  assert.equal(ok, true);
  assert.deepEqual(order, ['immediate', 'verified']);
});

test('an account that cannot sign in is checked against the dummy hash, a usable one is not', async (t) => {
  const dummy = t.mock.method(passwordTiming, 'verifyDummy');
  const hash = await hashPassword('correct horse');

  assert.equal(await verifyAccountPassword('correct horse', undefined), false, 'unknown e-mail');
  assert.equal(await verifyAccountPassword('correct horse', { status: 'disabled', password_hash: hash }), false, 'disabled');
  assert.equal(await verifyAccountPassword('correct horse', { status: 'active', password_hash: '' }), false, 'no password');
  assert.equal(dummy.mock.callCount(), 3);
  assert.deepEqual(dummy.mock.calls.map((call) => call.arguments), [['correct horse'], ['correct horse'], ['correct horse']]);

  assert.equal(await verifyAccountPassword('correct horse', { status: 'active', password_hash: hash }), true);
  assert.equal(await verifyAccountPassword('wrong horse', { status: 'active', password_hash: hash }), false);
  assert.equal(dummy.mock.callCount(), 3, 'a usable account pays its own hash, not the dummy');
});

test('the dummy check always refuses, whatever the password', async () => {
  for (const password of ['', 'correct horse', randomBytes(12).toString('base64url')]) {
    assert.equal(await passwordTiming.verifyDummy(password), false);
  }
});

test('parallel checks all settle with the right answer past the concurrency cap', async () => {
  const encoded = legacyHash('correct horse');
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) => verifyPassword(i % 2 === 0 ? 'correct horse' : 'wrong horse', encoded)),
  );
  assert.deepEqual(results, [true, false, true, false, true, false]);
});
