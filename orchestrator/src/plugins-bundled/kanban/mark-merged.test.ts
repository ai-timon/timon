/**
 * TIM-0109 volet 5 — a task whose PR was merged on GitHub stayed BLOCKED, and
 * its dependents waited forever. Marking it merged closes it with the sha.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test, after } from 'node:test';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { evaluateDeps } from '../../merge-gate.js';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
await import('../../../tests/helpers/claude-provider.js');

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'merge-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function mark(id: string, body: unknown, authenticated = true) {
  return fetch(`${base}/api/tasks/${id}/mark-merged`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { Authorization: 'Bearer merge-test' } : {}) },
    body: JSON.stringify(body),
  });
}

// A repository with `main` and a side commit that never reached it.
const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
writeFileSync(join(repo, 'a'), '1');
git('add', 'a');
git('commit', '-q', '-m', 'one');
const onMain = git('rev-parse', 'HEAD');
git('checkout', '-q', '-b', 'side');
writeFileSync(join(repo, 'b'), '2');
git('add', 'b');
git('commit', '-q', '-m', 'side');
const offMain = git('rev-parse', 'HEAD');
git('checkout', '-q', 'main');

function blockedCode(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', 'witness', { type: 'code' });
  dbApi.setTaskWorktree(id, repo, `timon/task/${id}`, 'main');
  db.prepare("UPDATE tasks SET status = 'BLOCKED', blocked_reason = 'review escalated' WHERE id = ?").run(id);
  return id;
}

test('anonymous callers are refused and the task is unchanged', async () => {
  const id = blockedCode();
  assert.equal((await mark(id, { sha: onMain }, false)).status, 401);
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

test('a sha contained in the base closes the task DONE and releases its dependent', async () => {
  const id = blockedCode();
  const dependent = randomUUID();
  dbApi.createTask(dependent, 'next', 'witness', { type: 'code', deps: [id] });
  const listChain = (root: string) => dbApi.listVerificationChain(root);
  assert.equal(evaluateDeps(dbApi.getTask(dependent)!, (t) => dbApi.getTask(t), listChain, listChain).ok, false);

  const response = await mark(id, { sha: onMain.toUpperCase(), comment: 'PR #66' });
  assert.equal(response.status, 200);
  const body = await response.json() as { verified: boolean };
  assert.equal(body.verified, true);
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'DONE');
  assert.equal(task.merged_commit_sha, onMain);
  assert.match(task.done_comment ?? '', /Marked as merged outside Timon.*found in main[\s\S]*PR #66/);
  assert.doesNotMatch(task.done_comment ?? '', /code-gate/);
  assert.equal(evaluateDeps(dbApi.getTask(dependent)!, (t) => dbApi.getTask(t), listChain, listChain).ok, true);

  const again = await mark(id, { sha: onMain });
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, 'task_already_merged');
});

test('a commit git places outside the base is refused', async () => {
  const id = blockedCode();
  const response = await mark(id, { sha: offMain });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'sha_not_in_base');
  assert.equal(dbApi.getTask(id)?.merged_commit_sha, null);
});

test('a commit this clone has not fetched is accepted, flagged as not verified', async () => {
  const id = blockedCode();
  const response = await mark(id, { sha: 'abcdef1234567' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { verified: boolean }).verified, false);
  assert.match(dbApi.getTask(id)?.done_comment ?? '', /not verified/);
});

test('invalid input, running and non-code tasks are refused', async () => {
  const id = blockedCode();
  assert.equal((await mark(id, { sha: 'not-a-sha' })).status, 400);
  assert.equal((await mark('bad!', { sha: onMain })).status, 400);
  assert.equal((await mark(randomUUID(), { sha: onMain })).status, 404);
  db.prepare("UPDATE tasks SET status = 'IN_PROGRESS' WHERE id = ?").run(id);
  assert.equal((await mark(id, { sha: onMain })).status, 409);
  const chore = randomUUID();
  dbApi.createTask(chore, 'ops', 'witness', { type: 'chore' });
  assert.equal((await mark(chore, { sha: onMain })).status, 400);
});

test('a DONE code task without a sha is marked merged without being closed again', async () => {
  // A `full` code task closed by its coder: its review or merge never came,
  // and its PR was merged on GitHub.
  const id = randomUUID();
  dbApi.createTask(id, 'feature merged on GitHub', 'witness', { type: 'code', pipeline: 'full' });
  dbApi.setTaskWorktree(id, repo, `timon/task/${id}`, 'main');
  const idea = dbApi.insertProjectTodo({ text: `idea ${randomUUID()}`, ownerUserId: 'user-ada' }).id;
  dbApi.setTaskTodoId(id, idea);
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'implemented\nportabilité : n/a' }); // french-ok: the portability line agents write
  const closedAt = dbApi.getTask(id)!.updated_at;
  const dependent = randomUUID();
  dbApi.createTask(dependent, 'next', 'witness', { type: 'code', deps: [id] });
  const listChain = (root: string) => dbApi.listVerificationChain(root);
  const gate = () => evaluateDeps(dbApi.getTask(dependent)!, (t) => dbApi.getTask(t), listChain, listChain).ok;
  assert.equal(gate(), false, 'a full code task without its merge holds its dependent');

  // Anonymous first: refused, nothing written.
  assert.equal((await mark(id, { sha: onMain }, false)).status, 401);
  assert.equal(dbApi.getTask(id)?.merged_commit_sha, null);

  const response = await mark(id, { sha: onMain, comment: 'PR #71' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { verified: boolean }).verified, true);
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'DONE');
  assert.equal(task.merged_commit_sha, onMain);
  assert.ok(task.updated_at >= closedAt);
  assert.match(task.done_comment ?? '', /^implemented\nportabilité : n\/a\n\nMarked as merged outside Timon.*found in main[\s\S]*PR #71$/); // french-ok: the portability line agents write
  assert.equal(gate(), true, 'the dependent is released');
  assert.equal(dbApi.getProjectTodo(idea)?.status, 'done', 'the TO DO idea lands with the sha');

  const again = await mark(id, { sha: onMain });
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, 'task_already_merged');
});

test('a DONE task is still refused a sha git places outside the base', async () => {
  const id = randomUUID();
  dbApi.createTask(id, 'feature', 'witness', { type: 'code', pipeline: 'full' });
  dbApi.setTaskWorktree(id, repo, `timon/task/${id}`, 'main');
  dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'implemented' });
  const response = await mark(id, { sha: offMain });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { code: string }).code, 'sha_not_in_base');
  assert.equal(dbApi.getTask(id)?.merged_commit_sha, null);
  assert.equal(dbApi.getTask(id)?.done_comment, 'implemented');
});
