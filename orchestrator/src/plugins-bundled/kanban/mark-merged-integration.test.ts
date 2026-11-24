/**
 * `mark-merged` on a chain whose base is an integration branch: the sha is the
 * commit of the target that brought the branch in, checked against
 * `<remote>/<target>` rather than the branch, and the whole job lands through
 * the poller's gate. The local mode is covered, unchanged, by
 * `mark-merged.test.ts`.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { chainLanding } from '../../chain-landing.js';
import { db, dbApi } from '../../db.js';
import { notifyIntegrationOutcome } from '../../wake.js';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
await import('../../../tests/helpers/claude-provider.js');

const notices: Array<{ id: string; outcome: string }> = [];

const app = express();
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'land-test', required: true }));
registerRoutes(app, {
  // The real notice, without the wake loop's spawn.
  notifyLanding: (id, outcome, lines) => {
    const sent = notifyIntegrationOutcome(id, outcome, lines, () => {});
    if (sent) notices.push({ id, outcome });
    return sent;
  },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function mark(id: string, body: unknown, authenticated = true) {
  return fetch(`${base}/api/tasks/${id}/mark-merged`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { Authorization: 'Bearer land-test' } : {}) },
    body: JSON.stringify(body),
  });
}

// A repository whose fetched `origin/main` holds the merge of `feat/*`
// branches, as a pull request merged on the forge leaves it.
const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.com');
git('config', 'user.name', 'T');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a'), '1');
git('add', 'a');
git('commit', '-q', '-m', 'one');

let jobs = 0;

type Job = { branch: string; head: string; prMerge: string; integrationId: string; todo: number };

/** `feat/job-<n>` one commit ahead of main, merged into `origin/main` with a
 *  merge commit, and its open pull request recorded. */
function job(mode: 'pr' | 'branch' = 'pr'): Job {
  jobs += 1;
  const branch = `feat/job-${jobs}`;
  git('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, `f${jobs}`), `${jobs}`);
  git('add', `f${jobs}`);
  git('commit', '-q', '-m', `feat: job ${jobs}`);
  const head = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  // The forge's merge commit, written on a throwaway branch then kept only
  // as the remote-tracking ref: the local main never moves.
  git('checkout', '-q', '-b', `forge-${jobs}`, 'main');
  git('merge', '-q', '--no-ff', '-m', 'Merge pull request', branch);
  const prMerge = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'main');
  git('update-ref', 'refs/remotes/origin/main', prMerge);
  const row = dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode, project: 'landing' });
  if (mode === 'pr') dbApi.markIntegrationOpen(row.id, { number: jobs, url: `https://github.com/acme/app/pull/${jobs}`, headSha: head });
  const todo = dbApi.insertProjectTodo({ text: `idea ${randomUUID()}`, ownerUserId: 'user-ada' }).id;
  return { branch, head, prMerge, integrationId: row.id, todo };
}

function task(on: Job, opts: { type?: 'code' | 'merge'; status?: 'DONE' | 'BLOCKED' | 'IN_PROGRESS'; sha?: string | null; mode?: string } = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, `work on ${on.branch}`, 'witness', {
    type: opts.type ?? 'merge', project: 'landing', baseBranch: on.branch,
    integrationMode: opts.mode ?? 'pr', baseRef: 'origin/main', pipeline: opts.type === 'code' ? 'full' : null,
  });
  dbApi.setTaskTodoId(id, on.todo);
  if (opts.sha !== null) dbApi.setTaskMergedSha(id, opts.sha ?? on.head);
  const status = opts.status ?? 'DONE';
  if (status === 'DONE') dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'merged into the branch' });
  else db.prepare('UPDATE tasks SET status = ?, blocked_reason = ? WHERE id = ?').run(status, status === 'BLOCKED' ? 'stuck' : null, id);
  return id;
}

test('anonymous callers are refused and nothing lands', async () => {
  const j = job();
  const id = task(j);
  assert.equal((await mark(id, { sha: j.prMerge }, false)).status, 401);
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'open');
  assert.notEqual(dbApi.getProjectTodo(j.todo)?.status, 'done');
});

test('a DONE chain lands its job with the merge commit of the pull request', async () => {
  const j = job();
  const id = task(j);
  const response = await mark(id, { sha: j.prMerge.toUpperCase(), comment: 'PR merged on the forge' });
  assert.equal(response.status, 200);
  const body = await response.json() as { verified: boolean; integration: { state: string; merge_sha: string } };
  assert.equal(body.verified, true);
  assert.equal(body.integration.state, 'merged');
  const row = dbApi.getIntegrationById(j.integrationId)!;
  assert.equal(row.state, 'merged');
  assert.equal(row.merge_sha, j.prMerge);
  assert.ok(row.landed_at, 'the landing gate ran');
  assert.equal(dbApi.getProjectTodo(j.todo)?.status, 'done');
  const t = dbApi.getTask(id)!;
  assert.equal(t.merged_commit_sha, j.head, 'the task keeps its merge into the branch');
  assert.match(t.done_comment ?? '', /landed as .*found in origin\/main[\s\S]*PR merged on the forge/);
  assert.deepEqual(notices.filter((n) => n.id === j.integrationId), [{ id: j.integrationId, outcome: 'merged' }]);

  // Replayed: refused, nothing told twice.
  const again = await mark(id, { sha: j.prMerge });
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { code: string }).code, 'integration_already_landed');
  assert.equal(notices.filter((n) => n.id === j.integrationId).length, 1);
});

test('the sha is checked against the target, not the integration branch', async () => {
  const j = job();
  const id = task(j);
  // The head of the branch is in the branch, and so in the merged target:
  // a sha only on the local main is not.
  writeFileSync(join(repo, 'local-only'), 'x');
  git('add', 'local-only');
  git('commit', '-q', '-m', 'local only');
  const localOnly = git('rev-parse', 'HEAD');
  const response = await mark(id, { sha: localOnly });
  assert.equal(response.status, 409);
  const body = await response.json() as { code: string; params: { base: string } };
  assert.equal(body.code, 'sha_not_in_base');
  assert.equal(body.params.base, 'origin/main');
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'open');
  assert.notEqual(dbApi.getProjectTodo(j.todo)?.status, 'done');
});

test('a sha this clone has not fetched lands, flagged as not verified', async () => {
  const j = job();
  const id = task(j);
  const response = await mark(id, { sha: 'abcdef1234567' });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { verified: boolean }).verified, false);
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'merged');
  assert.match(dbApi.getTask(id)?.done_comment ?? '', /not verified/);
});

test('a BLOCKED task of the job closes DONE with the sha, and the job lands', async () => {
  const j = job();
  const id = task(j, { type: 'code', status: 'BLOCKED', sha: null });
  const response = await mark(id, { sha: j.prMerge });
  assert.equal(response.status, 200);
  const t = dbApi.getTask(id)!;
  assert.equal(t.status, 'DONE');
  assert.equal(t.merged_commit_sha, j.prMerge);
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'merged');
  // Its own closure (TO DO idea, doc task) follows from `task_done`, as for
  // a local chain; what it will read is a landed chain.
  assert.equal(chainLanding(t), 'landed');
});

test('a branch under embargo lands by hand the same way', async () => {
  const j = job('branch');
  const id = task(j, { mode: 'branch' });
  assert.equal((await mark(id, { sha: j.prMerge })).status, 200);
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'merged');
  assert.equal(dbApi.getProjectTodo(j.todo)?.status, 'done');
});

test('a running task, or a job Timon never recorded, is refused', async () => {
  const j = job();
  const running = task(j, { status: 'IN_PROGRESS', sha: null });
  const busy = await mark(running, { sha: j.prMerge });
  assert.equal(busy.status, 409);
  assert.equal((await busy.json() as { code: string }).code, 'task_still_running');

  const orphan = randomUUID();
  dbApi.createTask(orphan, 'lost', 'witness', {
    type: 'merge', project: 'landing', baseBranch: 'feat/never-recorded', integrationMode: 'pr', baseRef: 'origin/main',
  });
  dbApi.setTaskMergedSha(orphan, j.head);
  dbApi.updateTaskStatus(orphan, 'DONE', { doneComment: 'merged' });
  const lost = await mark(orphan, { sha: j.prMerge });
  assert.equal(lost.status, 409);
  assert.equal((await lost.json() as { code: string }).code, 'integration_not_found');
  assert.equal(dbApi.getIntegrationById(j.integrationId)?.state, 'open');
});
