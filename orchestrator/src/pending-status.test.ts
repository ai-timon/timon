/**
 * Kanban 1/4 — the waiting-for-dispatch status is `PENDING`, and `TODO` is
 * only ever accepted as a deprecated INPUT alias.
 *
 * Two invariants, both irreversible if missed:
 *  1. a database written before the rename must come back up with its rows
 *     migrated — a row left in `TODO` matches no query any more, so it is
 *     invisible to the dispatcher while still looking alive on disk;
 *  2. a mission already in flight that asks for `--status TODO` must get the
 *     pending queue, and must never read `TODO` back in the answer.
 *
 * `node --test --import tsx src/pending-status.test.ts`
 */
import Database from 'better-sqlite3';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-pending-status-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

// A pre-rename database: the original `tasks` shape, two rows waiting in the
// queue under the old name. Written before db.js is imported, so the module's
// migrations run over it exactly as they would on upgrade day.
const LEGACY_A = randomUUID();
const LEGACY_B = randomUUID();
{
  const legacy = new Database(join(home, 'timon.db'));
  legacy.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      agent_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'TODO',
      priority INTEGER NOT NULL DEFAULT 3,
      deps TEXT NOT NULL DEFAULT '[]',
      mission_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      scheduled_at INTEGER,
      blocked_reason TEXT,
      done_comment TEXT,
      extra_skills TEXT,
      extra_mcp_servers TEXT,
      extra_allowed_tools TEXT
    );
    INSERT INTO tasks (id, title, agent_name, status, created_at, updated_at)
      VALUES ('${LEGACY_A}', 'vieille task en file', 'w.coder', 'TODO', 1, 1),
             ('${LEGACY_B}', 'vieille task close', 'w.coder', 'DONE', 1, 1);
  `);
  legacy.close();
}

const { dbApi, normalizeTaskStatusInput } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerKanban } = await import('./plugins-bundled/kanban/routes.js');

test('a database written before the rename brings its rows up as PENDING', () => {
  assert.equal(dbApi.getTask(LEGACY_A)?.status, 'PENDING');
  // The other statuses do not move: the migration only touches TODO.
  assert.equal(dbApi.getTask(LEGACY_B)?.status, 'DONE');
  // And the migrated task is visible to the dispatcher again.
  assert.ok(dbApi.listPendingReady().some((t) => t.id === LEGACY_A));
});

test('TODO as input is an alias of PENDING, never returned as output', () => {
  assert.equal(normalizeTaskStatusInput('TODO'), 'PENDING');
  assert.equal(normalizeTaskStatusInput('PENDING'), 'PENDING');
  // Translation, not validation: an unknown status goes through as is.
  assert.equal(normalizeTaskStatusInput('BLOCKED'), 'BLOCKED');
  assert.equal(normalizeTaskStatusInput(undefined), undefined);
});

const TOKEN = 'pending-status-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerKanban(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness does not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

test('?status=TODO returns the same queue as ?status=PENDING, without ever writing TODO', async () => {
  const fresh = randomUUID();
  dbApi.createTask(fresh, 'task fraîche', 'w.coder'); // french-ok: free-text sample data

  const viaAlias = await fetch(`${base}/api/tasks?status=TODO`, { headers: auth });
  const viaAliasText = await viaAlias.text();
  const viaName = await fetch(`${base}/api/tasks?status=PENDING`, { headers: auth });
  const viaNameText = await viaName.text();

  const ids = (text: string) =>
    (JSON.parse(text) as { tasks: { id: string }[] }).tasks.map((t) => t.id).sort();
  assert.deepEqual(ids(viaAliasText), ids(viaNameText));
  assert.ok(ids(viaAliasText).includes(fresh));
  assert.ok(!viaAliasText.includes('"TODO"'), 'no output returns the old name');
});

test('PUT status=TODO puts the task back in the queue without leaving it in TODO', async () => {
  const id = randomUUID();
  dbApi.createTask(id, 'task à renvoyer en file', 'w.coder'); // french-ok: free-text sample data
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'témoin' }); // french-ok: free-text sample data
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');

  const r = await fetch(`${base}/api/tasks/${id}`, {
    method: 'PUT', headers: auth, body: JSON.stringify({ status: 'TODO' }),
  });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getTask(id)?.status, 'PENDING');
});
