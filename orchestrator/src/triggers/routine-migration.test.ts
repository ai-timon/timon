/**
 * Routines → schedule triggers (TODO #216): a database written by the previous
 * version opens with its routines intact, same ids, same fields, and the
 * migration runs once per row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

// Own home, seeded BEFORE db.ts opens it: the migration runs at import.
const home = mkdtempSync(join(tmpdir(), 'timon-test-home-'));
process.env.TIMON_HOME = home;
{
  const legacy = new Database(join(home, 'timon.db'));
  legacy.exec(`CREATE TABLE routines (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, agent_name TEXT NOT NULL, prompt TEXT NOT NULL,
    task_type TEXT NOT NULL DEFAULT 'chore', cron_expr TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    project TEXT, last_run_at INTEGER, next_run_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  legacy.prepare(`INSERT INTO routines VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('r-1', 'Daily digest', 'scout', 'Summarise {yesterday} as JSON {"a":1}', 'research', '0 8 * * *', 1, 'acme', 100, 200, 10, 20);
  legacy.prepare(`INSERT INTO routines VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run('r-2', 'Off', 'scout', 'noop', 'chore', '*/5 * * * *', 0, null, null, null, 30, 40);
  legacy.close();
}

const { db, dbApi } = await import('../db.js');

test('legacy routines become schedule triggers with the same ids and fields', () => {
  const r1 = dbApi.getRoutine('r-1');
  assert.deepEqual(r1, {
    id: 'r-1', name: 'Daily digest', agent_name: 'scout', prompt: 'Summarise {yesterday} as JSON {"a":1}',
    task_type: 'research', cron_expr: '0 8 * * *', enabled: 1, project: 'acme',
    owner_user_id: null, extra_skills: null, extra_mcp_servers: null, extra_allowed_tools: null,
    last_run_at: 100, next_run_at: 200, created_at: 10, updated_at: 20,
  });
  assert.equal(dbApi.getRoutine('r-2')?.enabled, 0);
  assert.equal(dbApi.getRoutine('r-2')?.project, null);
  const row = db.prepare(`SELECT source, created_by, actions FROM triggers WHERE id = 'r-1'`).get() as { source: string; created_by: string; actions: string };
  assert.equal(row.source, 'schedule');
  assert.equal(row.created_by, 'routine');
  // The prompt stays out of the template engine.
  assert.equal((JSON.parse(row.actions) as Array<{ raw: boolean }>)[0]!.raw, true);
});

test('a routine deleted as a trigger does not come back, a new legacy row still moves', async () => {
  dbApi.deleteRoutine('r-2');
  db.prepare(`INSERT INTO routines (id, name, agent_name, prompt, cron_expr, created_at, updated_at) VALUES ('r-3','Late','scout','x','0 1 * * *',1,1)`).run();
  // Re-run the boot migration by re-evaluating db.ts in a fresh module instance.
  await import(`../db.js?again=${Date.now()}`);
  assert.equal(dbApi.getRoutine('r-2'), undefined);
  assert.equal(dbApi.getRoutine('r-3')?.name, 'Late');
});

test('update keeps the historical COALESCE semantics', () => {
  dbApi.updateRoutine('r-1', { prompt: 'new', project: null, enabled: false });
  const r1 = dbApi.getRoutine('r-1')!;
  assert.equal(r1.prompt, 'new');
  assert.equal(r1.project, 'acme', 'a null project keeps the old one, as before');
  assert.equal(r1.enabled, 0);
  assert.equal(r1.agent_name, 'scout');
  dbApi.markRoutineRun('r-1', 500, 600);
  assert.equal(dbApi.getRoutine('r-1')?.next_run_at, 600);
  assert.deepEqual(dbApi.listDueRoutines(10_000).map((r) => r.id), [], 'disabled routines are not due');
});
