/**
 * M.1a — user accounts: scrypt hashing, unique emails, the last-superadmin
 * invariant. Isolated TIMON_HOME: `db.ts` migrates at import time.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-m1a-'));
await import('../tests/helpers/paid-license.js');

const { hashPassword, verifyPassword, PasswordError } = await import('./users/password.js');
const { dbApi, DuplicateEmailError, LastSuperadminError } = await import('./db.js');

test('hashPassword then verifyPassword round-trips, a wrong password does not', async () => {
  const hash = await hashPassword('correct-horse-battery');
  assert.match(hash, /^scrypt\$131072\$8\$1\$/);
  assert.equal(await verifyPassword('correct-horse-battery', hash), true);
  assert.equal(await verifyPassword('wrong-password', hash), false);
  assert.equal(await verifyPassword('correct-horse-battery', 'not-a-hash'), false);
  assert.equal(await verifyPassword('correct-horse-battery', 'scrypt$1$1$1$$'), false);
});

test('the same password hashes to two different strings (fresh salt)', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('an empty password is refused', async () => {
  await assert.rejects(hashPassword(''), (err: unknown) => err instanceof PasswordError);
});

test('createUser stores a row and getUserByEmail finds it, case-insensitive', async () => {
  const user = createTestAccount(dbApi, {
    email: 'Robin@Example.com',
    name: 'Robin',
    passwordHash: await hashPassword('secret-secret'),
    isSuperadmin: true,
  });
  assert.equal(user.email, 'robin@example.com');
  assert.equal(user.name, 'Robin');
  assert.equal(user.status, 'active');
  assert.equal(user.is_superadmin, true);
  assert.equal(user.last_login_at, null);
  assert.equal(dbApi.getUserByEmail('ROBIN@example.com')?.id, user.id);
  assert.equal(dbApi.countActiveSuperadmins(), 1);
});

test('a second user with the same email is refused', async () => {
  const passwordHash = await hashPassword('other-secret');
  assert.throws(
    () => createTestAccount(dbApi, {
      email: 'robin@example.com',
      name: 'Clone',
      passwordHash,
    }),
    (err: unknown) => err instanceof DuplicateEmailError,
  );
});

test('the last active superadmin cannot be disabled or demoted', () => {
  const only = dbApi.getUserByEmail('robin@example.com');
  assert.ok(only);
  assert.throws(
    () => dbApi.setUserStatus(only.id, 'disabled'),
    (err: unknown) => err instanceof LastSuperadminError,
  );
  assert.throws(
    () => dbApi.setUserSuperadmin(only.id, false),
    (err: unknown) => err instanceof LastSuperadminError,
  );
  assert.equal(dbApi.getUserById(only.id)?.is_superadmin, true);
  assert.equal(dbApi.getUserById(only.id)?.status, 'active');
});

test('a second superadmin lets the first be demoted, then the last one is locked again', async () => {
  const first = dbApi.getUserByEmail('robin@example.com')!;
  const second = createTestAccount(dbApi, {
    email: 'other@example.com',
    name: 'Other',
    passwordHash: await hashPassword('secret-secret-2'),
    isSuperadmin: true,
  });
  assert.equal(dbApi.countActiveSuperadmins(), 2);
  const demoted = dbApi.setUserSuperadmin(first.id, false);
  assert.equal(demoted.is_superadmin, false);
  assert.equal(dbApi.countActiveSuperadmins(), 1);
  assert.throws(
    () => dbApi.setUserStatus(second.id, 'disabled'),
    (err: unknown) => err instanceof LastSuperadminError,
  );
  // A regular user can be disabled without touching the invariant.
  dbApi.setUserStatus(first.id, 'disabled');
  assert.equal(dbApi.getUserById(first.id)?.status, 'disabled');
});

test('sessions round-trip and expire', () => {
  const user = dbApi.getUserByEmail('other@example.com')!;
  const now = Date.now();
  const live = dbApi.createSession({
    tokenHash: 'hash-live',
    userId: user.id,
    expiresAt: now + 60_000,
    userAgent: 'test',
  });
  assert.equal(live.user_id, user.id);
  assert.equal(dbApi.getLiveSession('hash-live', now)?.user.id, user.id);
  dbApi.createSession({
    tokenHash: 'hash-dead',
    userId: user.id,
    expiresAt: now - 1,
  });
  assert.equal(dbApi.getLiveSession('hash-dead', now), undefined);
  assert.equal(dbApi.deleteExpiredSessions(now), 1);
  assert.equal(dbApi.getSessionByTokenHash('hash-dead'), undefined);
  assert.ok(dbApi.getSessionByTokenHash('hash-live'));
});
