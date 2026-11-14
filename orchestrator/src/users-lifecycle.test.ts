/**
 * M.6 — account lifecycle at the dbApi layer: password reset, immediate
 * session drop on disable, audit_log, last-superadmin.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-m6-'));
await import('../tests/helpers/paid-license.js');

const { hashPassword, generateTemporaryPassword, verifyPassword } = await import('./users/password.js');
const { hashSessionToken } = await import('./users/session.js');
const { dbApi, LastSuperadminError } = await import('./db.js');

const rom = createTestAccount(dbApi, {
  email: 'robin@example.com',
  name: 'Robin',
  passwordHash: await hashPassword('super-secret'),
  isSuperadmin: true,
});
const ada = createTestAccount(dbApi, {
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: await hashPassword('employee-secret'),
});

test('generateTemporaryPassword is unique and long enough', () => {
  const a = generateTemporaryPassword();
  const b = generateTemporaryPassword();
  assert.notEqual(a, b);
  assert.ok(a.length >= 16);
});

test('setUserPassword replaces the hash; the old password no longer verifies', async () => {
  const next = generateTemporaryPassword();
  dbApi.setUserPassword(ada.id, await hashPassword(next));
  const row = dbApi.getUserById(ada.id)!;
  assert.equal(await verifyPassword(next, row.password_hash), true);
  assert.equal(await verifyPassword('employee-secret', row.password_hash), false);
});

test('disabling a user makes getLiveSession miss even if the row is still there', () => {
  const hash = hashSessionToken('ada-session');
  dbApi.createSession({
    tokenHash: hash,
    userId: ada.id,
    expiresAt: Date.now() + 60_000,
  });
  assert.equal(dbApi.getLiveSession(hash)?.user.id, ada.id);
  dbApi.setUserStatus(ada.id, 'disabled');
  assert.equal(dbApi.getLiveSession(hash), undefined);
  assert.ok(dbApi.getSessionByTokenHash(hash), 'the row is still there until revokeUserAccess');
  const dropped = dbApi.revokeUserAccess(ada.id);
  assert.equal(dropped.sessions, 1);
  assert.equal(dbApi.getSessionByTokenHash(hash), undefined);
  dbApi.setUserStatus(ada.id, 'active');
});

test('the last active superadmin still cannot be disabled', () => {
  assert.throws(
    () => dbApi.setUserStatus(rom.id, 'disabled'),
    (err: unknown) => err instanceof LastSuperadminError,
  );
});

test('audit_log records actor, action and target', () => {
  const row = dbApi.insertAuditLog({
    userId: rom.id,
    action: 'user.reset_password',
    target: `user:${ada.id}`,
    ip: '127.0.0.1',
  });
  assert.equal(row.user_id, rom.id);
  assert.equal(row.action, 'user.reset_password');
  assert.equal(row.target, `user:${ada.id}`);
  assert.equal(row.ip, '127.0.0.1');
  const listed = dbApi.listAuditLog(10);
  assert.ok(listed.some((entry) => entry.id === row.id));
});
