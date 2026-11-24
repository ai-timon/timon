/**
 * The landing badge of a TO DO idea: derived from the `integrations` rows of
 * its jobs, read-only, scoped by who reads, filterable in one query.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-todo-landing-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerTodo } = await import('./project-todo-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { todosFor } = await import('./todo-api.js');
const { aggregateTodoLandings, landingStateOf } = await import('../../todo-landing.js');

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerTodo(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

type Job = { state: string; branch: string; prNumber: number | null; prUrl: string | null };
type Landing = (Job & { jobs: Job[] }) | null;
type Item = { id: number; text: string; landing: Landing };
type ListBody = { items: Item[]; counts: { byStatus: Record<string, number> }; code?: string };

async function call(path: string, cookie?: string, init: RequestInit = {}): Promise<{ status: number; body: ListBody & { item?: Item } }> {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {}) },
  });
  return { status: res.status, body: (await res.json()) as ListBody & { item?: Item } };
}

const setup = await fetch(`${base}/api/auth/setup`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
});
assert.equal(setup.status, 201);
const adminId = ((await setup.json()) as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup);

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const adaLogin = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ada@example.com', password: 'ada-secret' }),
});
const adaCookie = sessionCookie(adaLogin);

const PROJECT = 'landing-badge';
let pr = 100;

/** An integration branch in a given state; returns its branch name. */
function integration(state: 'branch' | 'pending' | 'open' | 'merged' | 'closed'): string {
  const branch = `${state === 'branch' ? 'sec' : 'feat'}/job-${randomUUID().slice(0, 4)}-x`;
  const row = dbApi.recordIntegration({
    repo: '/repos/app', branch, remote: 'origin', target: 'main', mode: state === 'branch' ? 'branch' : 'pr', project: PROJECT,
  });
  if (state === 'open' || state === 'merged' || state === 'closed') {
    pr += 1;
    dbApi.markIntegrationOpen(row.id, { number: pr, url: `https://github.com/acme/app/pull/${pr}`, headSha: 'a'.repeat(40) });
  }
  if (state === 'merged') dbApi.markIntegrationMerged(row.id, 'b'.repeat(40));
  if (state === 'closed') dbApi.markIntegrationClosed(row.id);
  return branch;
}

/** A task of the idea `todo` based on `branch`. */
function task(todo: number, branch: string, opts: { mode?: string | null; owner?: string } = {}): void {
  const id = randomUUID();
  dbApi.createTask(id, `work on ${branch}`, 'witness', {
    type: 'code', project: PROJECT, baseBranch: branch,
    integrationMode: opts.mode === undefined ? (branch.startsWith('sec/') ? 'branch' : 'pr') : opts.mode,
    baseRef: 'origin/main', ownerUserId: opts.owner ?? adminId,
  });
  dbApi.setTaskTodoId(id, todo);
}

function idea(text: string, owner = adminId): number {
  return dbApi.insertProjectTodo({ text, project: PROJECT, ownerUserId: owner }).id;
}

const none = idea('no task');
const local = idea('local job');
task(local, 'feat/local-only', { mode: null });
const byState = {
  branch: idea('embargo'),
  pending: idea('pending'),
  open: idea('open'),
  merged: idea('merged'),
  closed: idea('closed'),
};
for (const [state, id] of Object.entries(byState)) {
  const branch = integration(state as keyof typeof byState);
  // Two tasks of one job: the row counts once.
  task(id, branch);
  task(id, branch);
}
const twoJobs = idea('two jobs');
const openBranch = integration('open');
const pendingBranch = integration('pending');
task(twoJobs, openBranch);
task(twoJobs, pendingBranch);

// Ada's idea, whose only job runs under the admin's account.
const adaIdea = idea('ada idea', adaId);
task(adaIdea, integration('open'), { owner: adminId });

function find(items: Item[], id: number): Item {
  const hit = items.find((i) => i.id === id);
  assert.ok(hit, `idea #${id} listed`);
  return hit;
}

test('an anonymous caller is refused, with or without the filter', async () => {
  assert.equal((await call(`/api/project-todo?project=${PROJECT}`)).status, 401);
  assert.equal((await call(`/api/project-todo?project=${PROJECT}&landing=open`)).status, 401);
});

test('each state is derived from the integration row', async () => {
  const { status, body } = await call(`/api/project-todo?status=all&project=${PROJECT}`, adminCookie);
  assert.equal(status, 200);
  assert.equal(find(body.items, none).landing, null, 'no task: no landing');
  assert.equal(find(body.items, local).landing, null, 'local mode: no landing');
  for (const [state, id] of Object.entries(byState)) {
    const landing = find(body.items, id).landing;
    assert.ok(landing, `${state} has a landing`);
    assert.equal(landing.state, state);
    assert.equal(landing.jobs.length, 1, `${state}: one job, however many tasks`);
    const withPr = state === 'open' || state === 'merged' || state === 'closed';
    assert.equal(landing.prNumber !== null, withPr, `${state}: pull request number`);
    if (withPr) assert.match(landing.prUrl ?? '', /^https:\/\/github\.com\/acme\/app\/pull\/\d+$/);
  }
  assert.ok(find(body.items, byState.branch).landing?.branch.startsWith('sec/'));
});

test('the worst job wins, the detail stays readable', async () => {
  const { body } = await call(`/api/project-todo?status=all&project=${PROJECT}`, adminCookie);
  const landing = find(body.items, twoJobs).landing;
  assert.equal(landing?.state, 'pending');
  assert.equal(landing?.branch, pendingBranch);
  assert.deepEqual(landing?.jobs.map((j) => j.state).sort(), ['open', 'pending']);
});

test('the filter keeps the ideas whose badge is that state, counts included', async () => {
  const open = await call(`/api/project-todo?status=all&project=${PROJECT}&landing=open`, adminCookie);
  assert.equal(open.status, 200);
  // The two-job idea shows `pending`: the filter follows the badge.
  assert.deepEqual(open.body.items.map((i) => i.id).sort((a, b) => a - b), [byState.open, adaIdea].sort((a, b) => a - b));
  assert.equal(open.body.counts.byStatus.open, 2);

  const pending = await call(`/api/project-todo?status=all&project=${PROJECT}&landing=pending`, adminCookie);
  assert.deepEqual(pending.body.items.map((i) => i.id).sort((a, b) => a - b), [byState.pending, twoJobs].sort((a, b) => a - b));

  const bad = await call(`/api/project-todo?project=${PROJECT}&landing=draft`, adminCookie);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 'todo_landing_filter_invalid');
});

test('another account sees neither the ideas nor a job it does not own', async () => {
  const all = await call(`/api/project-todo?status=all&project=${PROJECT}`, adaCookie);
  assert.equal(all.status, 200);
  assert.deepEqual(all.body.items.map((i) => i.id), [adaIdea]);
  assert.equal(all.body.items[0]?.landing, null, 'the job runs under another account');
  const open = await call(`/api/project-todo?status=all&project=${PROJECT}&landing=open`, adaCookie);
  assert.deepEqual(open.body.items, []);

  const facade = todosFor({ viewer: { id: adaId, isSuperadmin: false }, ownerUserId: adaId, pluginId: 'witness-plugin' });
  assert.deepEqual(facade.list({ landing: 'open' }), []);
  assert.equal(facade.get(adaIdea)?.landing, null);
  assert.equal(facade.get(byState.open), undefined);
});

test('the detail and a PATCH answer carry the landing too', async () => {
  const patched = await call(`/api/project-todo/${byState.merged}`, adminCookie, {
    method: 'PATCH', body: JSON.stringify({ notes: 'touched' }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.item?.landing?.state, 'merged');
  const facade = todosFor({ viewer: { id: adminId, isSuperadmin: true }, ownerUserId: adminId, pluginId: 'witness-plugin' });
  assert.equal(facade.get(byState.closed)?.landing?.state, 'closed');
  assert.deepEqual(facade.list({ landing: 'branch', project: PROJECT }).map((i) => i.id), [byState.branch]);
});

test('aggregation: a state the version does not know never reads as landed', () => {
  assert.equal(landingStateOf({ mode: 'pr', state: 'draft' }), 'pending');
  assert.equal(landingStateOf({ mode: 'branch', state: 'branch' }), 'branch');
  const rows = [
    { todo_id: 1, id: 'a', mode: 'pr', state: 'merged', branch: 'feat/a', pr_number: 1, pr_url: 'u', created_at: 1 },
    { todo_id: 1, id: 'b', mode: 'pr', state: 'closed', branch: 'feat/b', pr_number: 2, pr_url: 'v', created_at: 2 },
    { todo_id: 1, id: 'b', mode: 'pr', state: 'closed', branch: 'feat/b', pr_number: 2, pr_url: 'v', created_at: 2 },
  ];
  const out = aggregateTodoLandings(rows).get(1);
  assert.equal(out?.state, 'closed');
  assert.equal(out?.jobs.length, 2);
  assert.equal(out?.jobs[0]?.branch, 'feat/a', 'oldest first');
  assert.deepEqual(out?.jobs.map((j) => j.jobId), ['a', 'b'], 'each job names its row');
  assert.equal(out?.jobId, 'b');
});
