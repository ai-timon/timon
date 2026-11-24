/**
 * The task that opens a job's pull request (`landing = 'pr'`) never goes DONE
 * before its pull request is open (`docs/KANBAN-PR-PIPELINE.md` §2.4): closed
 * without `timon pr open`, its integration row stayed at 'branch', the poller
 * never read it and the job never landed. Every close door refuses it with
 * `pr_not_opened`; the failed close stays open.
 *
 * `npm test -- src/pr-close-guard.test.ts`
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi, type TaskRow } from './db.js';
import { agentDir } from './paths.js';
import { bus } from './bus.js';
import { pullRequestCloseRefusal } from './code-gate.js';
import { watchMissionComplete } from './dispatcher.js';
import { registerRoutes } from './plugins-bundled/kanban/routes.js';
import { registerRoutes as registerCodeRoutes } from './plugins-bundled/kanban-code/routes.js';
import { createDaemonAuthMiddleware } from './plugins-bundled/http/auth.js';
await import('../tests/helpers/claude-provider.js');

const app = express();
// One connection per request: synchronous git calls can hold the server long
// enough for a reused keep-alive socket to be dropped (see merge-close-guard).
app.use((_req, res, next) => { res.setHeader('connection', 'close'); next(); });
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'pr-guard-test', required: true }));
registerRoutes(app);
registerCodeRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type ErrorJson = { error?: string; code?: string };

async function call(method: string, path: string, body: unknown): Promise<{ status: number; json: ErrorJson }> {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', Authorization: 'Bearer pr-guard-test' },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as ErrorJson };
}

const AGENT = 'prguard.merger';
const repo = join(process.env.TIMON_HOME!, `repo-${randomUUID()}`);
mkdirSync(repo, { recursive: true });
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim();
git('init', '-q', '-b', 'main');
git('config', 'user.email', 't@example.invalid');
git('config', 'user.name', 'T');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a.txt'), `init ${randomUUID()}\n`);
git('add', 'a.txt');
git('commit', '-q', '-m', 'init');
mkdirSync(agentDir(AGENT), { recursive: true });
writeFileSync(join(agentDir(AGENT), 'config.json'), JSON.stringify({ cwd: repo, role: 'merger' }));
writeFileSync(join(agentDir(AGENT), 'system-prompt.md'), 'Test');

type Job = { task: TaskRow; tip: string; integrationId: string | null };

/** An integration branch one commit ahead of main, and the job's PR task on it. */
function prJob(opts: { record?: boolean; landing?: string | undefined } = {}): Job {
  const branch = `feat/topic-${randomUUID().slice(0, 8)}`;
  git('checkout', '-q', '-b', branch, 'main');
  writeFileSync(join(repo, `${branch.replace('/', '-')}.txt`), 'work\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'the work');
  git('checkout', '-q', 'main');
  const tip = git('rev-parse', branch);
  const id = randomUUID();
  dbApi.createTask(id, 'open the pull request', AGENT, {
    type: 'merge', baseBranch: branch, landing: 'landing' in opts ? opts.landing : 'pr',
    integrationMode: 'pr', baseRef: 'origin/main',
  });
  const row = opts.record === false
    ? null
    : dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode: 'pr' });
  return { task: dbApi.getTask(id)!, tip, integrationId: row?.id ?? null };
}

function open(job: Job): void {
  assert.ok(job.integrationId);
  assert.equal(dbApi.markIntegrationOpen(job.integrationId, { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: job.tip }), true);
}

const closeDone = (job: Job) =>
  call('POST', '/api/tasks/close', { id: job.task.id, outcome: 'done', comment: 'pull request opened', merged_sha: job.tip });

test('closing the PR task DONE before its pull request is open is refused, and nothing is written', async () => {
  const job = prJob();
  const r = await closeDone(job);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'pr_not_opened');
  assert.match(r.json.error ?? '', /timon pr open/);
  const after = dbApi.getTask(job.task.id)!;
  assert.notEqual(after.status, 'DONE');
  assert.equal(after.merged_commit_sha, null);
});

test('the CLI path (sha recorded first, then PUT DONE) is refused at both steps', async () => {
  const job = prJob();
  const sha = await call('POST', `/api/tasks/${job.task.id}/merged-sha`, { sha: job.tip });
  assert.equal(sha.status, 409);
  assert.equal(sha.json.code, 'pr_not_opened');
  assert.equal(dbApi.getTask(job.task.id)!.merged_commit_sha, null);
  const put = await call('PUT', `/api/tasks/${job.task.id}`, { status: 'DONE', done_comment: 'done' });
  assert.equal(put.status, 409);
  assert.equal(put.json.code, 'pr_not_opened');
  assert.notEqual(dbApi.getTask(job.task.id)!.status, 'DONE');
});

test('a PR task whose integration branch Timon never recorded is refused too', async () => {
  const job = prJob({ record: false });
  const r = await closeDone(job);
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'pr_not_opened');
});

test('once the pull request is open, the PR task closes DONE with its tip', async () => {
  const job = prJob();
  open(job);
  const r = await closeDone(job);
  assert.equal(r.status, 200, r.json.error);
  const after = dbApi.getTask(job.task.id)!;
  assert.equal(after.status, 'DONE');
  assert.equal(after.merged_commit_sha, job.tip);
});

test('the CLI path is accepted once the pull request is open', async () => {
  const job = prJob();
  open(job);
  assert.equal((await call('POST', `/api/tasks/${job.task.id}/merged-sha`, { sha: job.tip })).status, 200);
  const put = await call('PUT', `/api/tasks/${job.task.id}`, { status: 'DONE', done_comment: 'done' });
  assert.equal(put.status, 200, put.json.error);
  assert.equal(dbApi.getTask(job.task.id)!.status, 'DONE');
});

test('a pull request already merged, or closed, lets the PR task close DONE', async () => {
  const merged = prJob();
  open(merged);
  assert.equal(dbApi.markIntegrationMerged(merged.integrationId!, null), true);
  const r = await closeDone(merged);
  assert.equal(r.status, 200, r.json.error);
  assert.equal(dbApi.getTask(merged.task.id)!.status, 'DONE');

  const closed = prJob();
  open(closed);
  assert.equal(dbApi.markIntegrationClosed(closed.integrationId!), true);
  assert.equal(pullRequestCloseRefusal(dbApi.getTask(closed.task.id)!), null);
});

test('marking the PR task failed stays possible without a pull request', async () => {
  const job = prJob();
  const r = await call('POST', '/api/tasks/close', { id: job.task.id, outcome: 'failed', reason: 'gh is signed in as the wrong account' });
  assert.equal(r.status, 200, r.json.error);
  const after = dbApi.getTask(job.task.id)!;
  assert.equal(after.status, 'BLOCKED');
  assert.match(after.blocked_reason ?? '', /wrong account/);
});

test('an automatic close of the PR task without a pull request goes BLOCKED, not DONE', () => {
  const job = prJob();
  dbApi.setTaskMergedSha(job.task.id, job.tip);
  const missionId = randomUUID();
  dbApi.createMission(missionId, AGENT, job.task.title);
  dbApi.assignTaskMission(job.task.id, missionId);
  const stop = watchMissionComplete();
  try {
    bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0 });
    const after = dbApi.getTask(job.task.id)!;
    assert.equal(after.status, 'BLOCKED');
    assert.match(after.blocked_reason ?? '', /Pull request guard/);
  } finally { stop(); }
});

test('only the PR task is concerned: an ordinary merge on the same branch is not', () => {
  const job = prJob({ landing: undefined });
  assert.equal(pullRequestCloseRefusal(job.task), null);
});
