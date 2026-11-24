/**
 * Sealed envelope (`docs/SECRETS-VAULT.md` §4.1). No `TIMON_HOME` needed:
 * `box.ts` touches neither the filesystem nor the database.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ENVELOPE_PREFIX, MASTER_KEY_BYTES, SecretBoxError, isSealed, open, seal } from './box.js';

const KEY = randomBytes(MASTER_KEY_BYTES);
const ID = { secretId: 'sec_a', name: 'GITHUB_TOKEN' };

test('seal → open round-trips the original value', () => {
  for (const value of ['ghp_0123456789', '', 'accentué — 🔐', 'x'.repeat(4096)]) { // french-ok: a multi-byte sample
    assert.equal(open(seal(value, KEY, ID), KEY, ID), value);
  }
});

test('the envelope carries the `enc:1:` discriminator and three fields', () => {
  const envelope = seal('value', KEY, ID);
  assert.ok(envelope.startsWith(ENVELOPE_PREFIX));
  assert.ok(isSealed(envelope));
  assert.equal(envelope.slice(ENVELOPE_PREFIX.length).split(':').length, 3);
  assert.equal(isSealed('plaintext-legacy'), false);
});

test('the plaintext never appears in the envelope', () => {
  assert.equal(seal('SUPER-SECRET-VALUE', KEY, ID).includes('SUPER-SECRET'), false);
});

test('two seals of the same value differ (fresh IV on every write)', () => {
  const seen = new Set<string>();
  for (let i = 0; i < 32; i += 1) seen.add(seal('same-value', KEY, ID));
  assert.equal(seen.size, 32);
});

test('an envelope with one altered byte is rejected (GCM tag)', () => {
  const envelope = seal('ghp_0123456789', KEY, ID);
  const [iv, tag, data] = envelope.slice(ENVELOPE_PREFIX.length).split(':') as [string, string, string];
  const flipped = Buffer.from(data, 'base64');
  flipped[0] ^= 0x01;
  const tampered = `${ENVELOPE_PREFIX}${iv}:${tag}:${flipped.toString('base64')}`;
  assert.throws(() => open(tampered, KEY, ID), (e: unknown) => {
    assert.ok(e instanceof SecretBoxError);
    assert.equal(e.code, 'auth-failed');
    return true;
  });
});

test('an envelope sealed for one secretId does not open for another (AAD)', () => {
  const envelope = seal('ghp_0123456789', KEY, { secretId: 'sec_a', name: 'GITHUB_TOKEN' });
  assert.throws(
    () => open(envelope, KEY, { secretId: 'sec_b', name: 'GITHUB_TOKEN' }),
    (e: unknown) => e instanceof SecretBoxError && e.code === 'auth-failed',
  );
  // Same row id, different name: the name is bound too.
  assert.throws(
    () => open(envelope, KEY, { secretId: 'sec_a', name: 'GITLAB_TOKEN' }),
    (e: unknown) => e instanceof SecretBoxError && e.code === 'auth-failed',
  );
});

test('the `\\0` separator makes the AAD unambiguous', () => {
  // Without the separator, `secretId + name` would collide between these two.
  const envelope = seal('v', KEY, { secretId: 'ab', name: 'C' });
  assert.throws(
    () => open(envelope, KEY, { secretId: 'a', name: 'bC' }),
    (e: unknown) => e instanceof SecretBoxError && e.code === 'auth-failed',
  );
});

test('another key does not open the envelope', () => {
  const envelope = seal('ghp_0123456789', KEY, ID);
  assert.throws(
    () => open(envelope, randomBytes(MASTER_KEY_BYTES), ID),
    (e: unknown) => e instanceof SecretBoxError && e.code === 'auth-failed',
  );
});

test('a key of the wrong size is refused before any crypto work', () => {
  for (const bad of [randomBytes(16), randomBytes(31), randomBytes(33)]) {
    assert.throws(() => seal('v', bad, ID), (e: unknown) => e instanceof SecretBoxError && e.code === 'bad-key');
    assert.throws(() => open(seal('v', KEY, ID), bad, ID), (e: unknown) => e instanceof SecretBoxError && e.code === 'bad-key');
  }
});

test('a malformed envelope is refused as `bad-envelope`, not as an auth failure', () => {
  const good = seal('v', KEY, ID);
  const [iv, tag, data] = good.slice(ENVELOPE_PREFIX.length).split(':') as [string, string, string];
  const cases = [
    'plaintext-legacy',
    'enc:2:a:b:c',
    `${ENVELOPE_PREFIX}${iv}:${tag}`,
    `${ENVELOPE_PREFIX}${Buffer.alloc(8).toString('base64')}:${tag}:${data}`,
    `${ENVELOPE_PREFIX}${iv}:${Buffer.alloc(8).toString('base64')}:${data}`,
  ];
  for (const bad of cases) {
    assert.throws(() => open(bad, KEY, ID), (e: unknown) => {
      assert.ok(e instanceof SecretBoxError, `not a SecretBoxError for \`${bad}\``);
      assert.equal(e.code, 'bad-envelope', `unexpected code for \`${bad}\``);
      return true;
    });
  }
});
