/**
 * `todo_later` → `project_todo`: the switch of a database that already exists.
 *
 * This test is not about the rename of the code (tsc sees its misses) but about
 * the only miss that would be SILENT: the rename guard placed after the schema
 * block. `CREATE TABLE IF NOT EXISTS project_todo` would then already have created
 * an empty table, the guard would have seen it present, would have skipped, and the ideas
 * would have stayed in `todo_later`, invisible, without an error anywhere.
 *
 * This file sets ITS own home (it does not import `test-home.js`): it must write the
 * database BEFORE `db.ts` opens it, and ESM imports are hoisted.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'timon-project-todo-mig-'));
process.env.TIMON_HOME = home;

// "Before" database: the old table, populated, with its index and a permission
// already granted on the old domain name.
{
  const { default: Database } = await import('better-sqlite3');
  const old = new Database(join(home, 'timon.db'));
  old.exec(`
    CREATE TABLE todo_later (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      project TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at INTEGER
    );
    CREATE INDEX idx_todo_later_status ON todo_later(status, created_at);
    CREATE TABLE roles (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE role_permissions (role_id TEXT NOT NULL, permission TEXT NOT NULL, PRIMARY KEY (role_id, permission));
    INSERT INTO roles (id, name, created_at) VALUES ('r1', 'lecteur', 0);
    INSERT INTO role_permissions (role_id, permission) VALUES ('r1', 'todo_later:read:all');
  `);
  old.prepare(
    `INSERT INTO todo_later (text, project, created_at, updated_at) VALUES (?, ?, ?, ?)`,
  ).run('idée d\'avant le renommage', 'timon', 1, 1); // french-ok: free-text sample data
  old.close();
}

const { db, dbApi } = await import('./db.js');

test('an idea noted before the rename survives under the new name', () => {
  const items = dbApi.listProjectTodo();
  assert.equal(items.length, 1, 'the renamed table keeps its rows');
  assert.equal(items[0]!.text, 'idée d\'avant le renommage'); // french-ok: free-text sample data
  assert.equal(items[0]!.project, 'timon');
});

test('the old table is gone: not two notebooks side by side', () => {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name);
  assert.ok(names.includes('project_todo'));
  assert.equal(names.includes('todo_later'), false);
});

test('the granted permission leaves with the account tables, for the account plugin to migrate (TODO #906)', () => {
  const names = (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[])
    .map((t) => t.name);
  assert.equal(names.includes('role_permissions'), false);
  assert.deepEqual(dbApi.readLegacyAccountTable('role_permissions'), [{ role_id: 'r1', permission: 'todo_later:read:all' }]);
});

test('the owner_user_id column was indeed set on the renamed table', () => {
  // The guard must hold BEFORE the `OWNED_TABLES` loop, which interpolates the name of
  // the table into SQL: a rename coming too late would make it fail on the missing one.
  const cols = (db.prepare(`PRAGMA table_info(project_todo)`).all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols.includes('owner_user_id'));
  assert.ok(cols.includes('author'));
});
