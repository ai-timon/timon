/**
 * When `users.email_unverified` appears (`docs/EMAIL-CODES.md`): a superadmin
 * was confirmed at setup or predates the codes and stays confirmed; any other
 * account came from the account provider, whose addresses never received a
 * code, so it starts unconfirmed and is offered the code from its profile.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const home = mkdtempSync(join(tmpdir(), 'timon-email-unverified-'));
process.env.TIMON_HOME = home;

// A database written before the column: a superadmin and a member.
{
  const legacy = new Database(join(home, 'timon.db'));
  legacy.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      is_superadmin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_login_at INTEGER
    );
  `);
  const insert = legacy.prepare(`INSERT INTO users (id, email, name, password_hash, is_superadmin, created_at) VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run('u-admin', 'admin@example.com', 'Admin', 'x', 1, Date.now());
  insert.run('u-member', 'member@example.com', 'Member', 'x', 0, Date.now());
  legacy.close();
}

await import('../tests/helpers/paid-license.js');
const { dbApi } = await import('./db.js');

test('the superadmin that predates the column stays confirmed, a member does not', () => {
  assert.equal(dbApi.userEmailUnverified('u-admin'), false);
  assert.equal(dbApi.userEmailUnverified('u-member'), true);
});

test('an account created afterwards takes the default, the creator decides', () => {
  const user = createTestAccount(dbApi, { email: 'new@example.com', name: 'New', passwordHash: 'x' });
  assert.equal(dbApi.userEmailUnverified(user.id), false);
});
