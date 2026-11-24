/**
 * TIM-0113 — "Detach the worktree": the folder goes, the branch and its
 * commits stay, and the next worktree of the task reattaches to them. Refused
 * to an anonymous caller, on a running task, and on a dirty worktree.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, after } from 'node:test';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { createWorktree } from '../../worktree.js';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'detach-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function detach(id: string, authenticated = true) {
  return fetch(`${base}/api/tasks/${id}/worktree/detach`, {
    method: 'POST',
    headers: authenticated ? { Authorization: 'Bearer detach-test' } : {},
  });
}

const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
git(repo, 'init', '-q', '-b', 'main');
git(repo, 'config', 'user.email', 't@example.com');
git(repo, 'config', 'user.name', 'T');
writeFileSync(join(repo, 'a'), '1');
git(repo, 'add', 'a');
git(repo, 'commit', '-q', '-m', 'one');

/** A blocked code task with a worktree holding one unmerged commit. */
async function taskWithWorktree(): Promise<{ id: string; path: string; branch: string; commit: string }> {
  const id = randomUUID();
  // An agent that does not exist: the gesture must not need its cwd (TIM-0113).
  dbApi.createTask(id, 'feature', 'no-such-agent', { type: 'code' });
  const info = await createWorktree(id, repo, 'main');
  dbApi.setTaskWorktree(id, info.path, info.branch, info.base);
  writeFileSync(join(info.path, 'b'), '2');
  git(info.path, 'add', 'b');
  git(info.path, 'commit', '-q', '-m', 'unmerged work');
  db.prepare("UPDATE tasks SET status = 'BLOCKED' WHERE id = ?").run(id);
  return { id, path: info.path, branch: info.branch, commit: git(info.path, 'rev-parse', 'HEAD') };
}

test('an anonymous caller is refused and the worktree stays', async () => {
  const t = await taskWithWorktree();
  assert.equal((await detach(t.id, false)).status, 401);
  assert.ok(existsSync(t.path));
  assert.equal(dbApi.getTask(t.id)?.worktree_path, t.path);
});

test('a running task is refused: its agent works in that folder', async () => {
  const t = await taskWithWorktree();
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(t.id);
  const response = await detach(t.id);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'worktree_busy');
  assert.ok(existsSync(t.path));
});

test('a worktree with uncommitted changes is refused by git, nothing lost', async () => {
  const t = await taskWithWorktree();
  writeFileSync(join(t.path, 'dirty'), 'not committed');
  const response = await detach(t.id);
  assert.equal(response.status, 500);
  assert.ok(existsSync(join(t.path, 'dirty')));
  assert.equal(dbApi.getTask(t.id)?.worktree_path, t.path);
});

test('the folder goes, the branch and its commit stay, and a new worktree reattaches to them', async () => {
  const t = await taskWithWorktree();
  const response = await detach(t.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, detached: true });
  assert.equal(existsSync(t.path), false);
  const task = dbApi.getTask(t.id)!;
  assert.equal(task.worktree_path, null);
  assert.equal(task.branch_name, t.branch, 'the branch stays recorded');
  assert.equal(git(repo, 'rev-parse', t.branch), t.commit, 'the unmerged commit is kept');

  const again = await createWorktree(t.id, repo, 'main');
  assert.equal(git(again.path, 'rev-parse', 'HEAD'), t.commit);

  assert.equal((await detach(randomUUID())).status, 404);
});

test('a malformed body on the worktree and sha routes carries the detail the board translates', async () => {
  const id = randomUUID();
  for (const path of [`/api/tasks/${id}/worktree`, `/api/tasks/${id}/worktree/detach`, `/api/tasks/${id}/merged-sha`]) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: 'Bearer detach-test', 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: 1 }),
    });
    assert.equal(res.status, 400, path);
    const body = await res.json() as { error?: string; code?: string; params?: Record<string, unknown> };
    assert.equal(body.code, 'task_body_invalid', path);
    assert.ok(body.error, path);
    assert.deepEqual(body.params, { detail: body.error }, path);
  }
});
