/**
 * The landing routes of the Kanban island: an anonymous caller is refused on
 * each of them, a caller who cannot see the job finds nothing, its owner reads
 * it, and the dry pre-checks need `projects:manage`.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import type { PreviewDeps } from '../../integration-preview.js';
import { updateProjectIntegration } from '../../project-integration.js';
import { registerLandingRoutes } from './landing-routes.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-landing-routes-')));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

// A repository with `feat/topic` one commit ahead of `origin/main`.
const repo = join(root, 'repo');
execFileSync('git', ['init', '-q', '-b', 'main', repo]);
git(repo, 'config', 'user.name', 'Acme Bot');
git(repo, 'config', 'user.email', 'bot@acme.test');
git(repo, 'config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'a.txt'), 'a\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'chore: start');
git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
git(repo, 'checkout', '-q', '-b', 'feat/topic');
writeFileSync(join(repo, 'b.txt'), 'b\n');
git(repo, 'add', '-A');
git(repo, 'commit', '-q', '-m', 'feat: add b');
git(repo, 'checkout', '-q', 'main');

const SLUG = 'landing-routes';
dbApi.upsertProject(SLUG, { cwd: repo });
updateProjectIntegration(SLUG, { mode: 'pr', account: 'ai-bot', remote_url: 'git@github.com:acme/app.git' });
const SERIES = randomUUID();
dbApi.createTask(randomUUID(), 'Add b', 'acme.coder', {
  type: 'code', project: SLUG, baseBranch: 'feat/topic', integrationMode: 'pr', baseRef: 'origin/main',
  seriesId: SERIES, ownerUserId: 'owner-a',
});
const ROW = dbApi.recordIntegration({
  repo, branch: 'feat/topic', remote: 'origin', target: 'main', mode: 'pr', project: SLUG, seriesId: SERIES,
});
// The idea the job carries, linked to an issue.
const TODO = dbApi.insertProjectTodo({ text: 'Add b', project: SLUG, ownerUserId: 'owner-a' }).id;
dbApi.putTodoExternalRef({ todoId: TODO, provider: 'github', ref: 'acme/app#7', url: null, label: null, pluginId: null });
dbApi.setTaskTodoId(dbApi.listTasksByBaseBranch('feat/topic')[0]!.id, TODO);

let forgeCalls = 0;
const deps: PreviewDeps = {
  forge: () => ({
    async login() { forgeCalls += 1; return { ok: true, login: 'ai-bot' }; },
    async repositoryAccess() { return { ok: true, exists: true, canPush: true }; },
    async forkRepository() { return { ok: true, fullName: 'bot/app' }; },
    async createPullRequest() { forgeCalls += 1; return { ok: false, code: 'gh_failed', reason: 'stub' }; },
    async pullRequestChecks() { forgeCalls += 1; return { ok: false, code: 'gh_failed', reason: 'stub' }; },
  }),
  transport: () => ({
    async remoteBranchSha() { forgeCalls += 1; return { ok: true, sha: null }; },
    async fetchBranch() { forgeCalls += 1; return { ok: true }; },
    async pushBranch() { forgeCalls += 1; return { ok: true }; },
  }),
};

type Who = 'anonymous' | 'owner' | 'owner-reader' | 'stranger' | 'daemon';

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware.
app.use((req, _res, next) => {
  const who = req.header('x-test-who') as Who | undefined;
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'owner') {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'owner-a', permissions: ['kanban:read', 'projects:manage'] };
  } else if (who === 'owner-reader') {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'owner-a', permissions: ['kanban:read'] };
  } else if (who === 'stranger') {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'owner-b', permissions: ['kanban:read', 'projects:manage'] };
  }
  next();
});
registerLandingRoutes(app, deps);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: 'GET' | 'POST', path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

const ROUTES: Array<['GET' | 'POST', string]> = [
  ['GET', '/api/kanban/landings'],
  ['GET', `/api/kanban/landings?todo=${TODO}`],
  ['GET', `/api/kanban/landings/${ROW.id}`],
  ['POST', `/api/kanban/landings/${ROW.id}/checks`],
  ['POST', `/api/kanban/landings/${ROW.id}/preview`],
];

test('an anonymous request is refused on every route, before anything is read', async () => {
  for (const [method, path] of ROUTES) {
    const res = await call(method, path, 'anonymous', method === 'POST' ? {} : undefined);
    assert.equal(res.status, 401, `${method} ${path}`);
  }
  assert.equal(forgeCalls, 0);
});

test('a caller who cannot see the job finds nothing', async () => {
  for (const [method, path] of ROUTES.slice(2)) {
    const res = await call(method, path, 'stranger', method === 'POST' ? {} : undefined);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(((await res.json()) as { code: string }).code, 'landing_not_found');
  }
  for (const path of ROUTES.slice(0, 2).map(([, p]) => p)) {
    const list = await (await call('GET', path, 'stranger')).json() as { landings: unknown[] };
    assert.deepEqual(list.landings, [], path);
  }
  assert.equal(forgeCalls, 0);
});

test('the owner lists and reads the job, without the repository path', async () => {
  const list = await (await call('GET', `/api/kanban/landings?project=${SLUG}`, 'owner')).json() as { landings: Array<Record<string, unknown>> };
  assert.equal(list.landings.length, 1);
  assert.equal(list.landings[0]!.branch, 'feat/topic');
  assert.equal(list.landings[0]!.state, 'branch');
  assert.ok(!('repo' in list.landings[0]!));
  const bySeries = await (await call('GET', `/api/kanban/landings?series=${SERIES}`, 'owner')).json() as { landings: unknown[] };
  assert.equal(bySeries.landings.length, 1);
  const one = await call('GET', `/api/kanban/landings/${ROW.id}`, 'owner');
  assert.equal(one.status, 200);
  const daemon = await call('GET', `/api/kanban/landings/${ROW.id}`, 'daemon');
  assert.equal(daemon.status, 200);
});

test('a malformed query, id or body is refused', async () => {
  assert.equal((await call('GET', '/api/kanban/landings?project=../x', 'owner')).status, 400);
  assert.equal((await call('GET', '/api/kanban/landings?other=1', 'owner')).status, 400);
  assert.equal((await call('GET', '/api/kanban/landings/a.b', 'owner')).status, 400);
  const extra = await call('POST', `/api/kanban/landings/${ROW.id}/preview`, 'owner', { title: 'x', force: true });
  assert.equal(extra.status, 400);
  assert.equal(((await extra.json()) as { code: string }).code, 'landing_request_invalid');
  assert.equal((await call('POST', `/api/kanban/landings/${ROW.id}/checks`, 'owner', { now: 1 })).status, 400);
  assert.equal(forgeCalls, 0);
});

test('the preview runs the dry pre-checks for a project manager only', async () => {
  const reader = await (await call('POST', `/api/kanban/landings/${ROW.id}/preview`, 'owner-reader', {})).json() as {
    commit_count: number; prechecks: { ran: boolean };
  };
  assert.equal(reader.commit_count, 1);
  assert.equal(reader.prechecks.ran, false);
  assert.equal(forgeCalls, 0);

  const manager = await (await call('POST', `/api/kanban/landings/${ROW.id}/preview`, 'owner', { title: 'Add b' })).json() as {
    prechecks: { ran: boolean; checks: Array<{ name: string }> };
  };
  assert.equal(manager.prechecks.ran, true);
  assert.ok(manager.prechecks.checks.some((c) => c.name === 'account'));
});

test('the checks of a job without a pull request are refused as not applicable', async () => {
  const res = await call('POST', `/api/kanban/landings/${ROW.id}/checks`, 'owner', {});
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'landing_checks_unavailable');
});

test('every job comes with its links: its idea, the issue, the series', async () => {
  const callsBefore = forgeCalls;
  type Links = { todos: Array<{ id: number; text: string }>; issues: Array<{ repo: string; number: number; todo_id: number | null; closes: boolean }>; series_id: string | null; pilot_mission_id: string | null };
  const byTodo = await (await call('GET', `/api/kanban/landings?todo=${TODO}`, 'owner')).json() as { landings: Array<{ id: string; links: Links }> };
  assert.deepEqual(byTodo.landings.map((l) => l.id), [ROW.id]);
  const links = byTodo.landings[0]!.links;
  assert.deepEqual(links.todos.map((t) => [t.id, t.text]), [[TODO, 'Add b']]);
  assert.deepEqual(links.issues, [{ repo: 'acme/app', number: 7, url: null, todo_id: TODO, closes: false }]);
  assert.equal(links.series_id, SERIES);
  // No mission was ever recorded for this series: nothing to open.
  assert.equal(links.pilot_mission_id, null);

  const one = await (await call('GET', `/api/kanban/landings/${ROW.id}`, 'owner')).json() as { landing: { links: Links } };
  assert.deepEqual(one.landing.links, links);
  assert.equal((await call('GET', '/api/kanban/landings?todo=0', 'owner')).status, 400);
  assert.equal((await call('GET', '/api/kanban/landings?todo=abc', 'owner')).status, 400);
  assert.equal(forgeCalls, callsBefore, 'links never reach the forge');
});
