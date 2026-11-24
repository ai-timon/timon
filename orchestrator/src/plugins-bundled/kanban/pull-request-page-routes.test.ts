/**
 * The page of one pull request and the end of a failed check's log: who may
 * read them, what reaches the forge (reads only, never git), and the short
 * cache that keeps a window opened twice from starting gh twice.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import express from 'express';
import { bus } from '../../bus.js';
import { dbApi } from '../../db.js';
import { getHost } from '../../host/index.js';
import type { ExecOpts, ExecResult } from '../../host/types.js';
import { forgetPullRequestPages, PAGE_CACHE_MS, watchPullRequestPages } from '../../pull-request-page.js';
import { registerExternalPrRoutes } from './external-pr-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-pr-page-')));
mkdirSync(join(home, 'code', 'acme'), { recursive: true });
dbApi.upsertProject('acme', { cwd: join(home, 'code', 'acme') });
dbApi.upsertProject('solo', { cwd: join(home, 'code', 'solo') });
dbApi.setProjectIntegration('acme', JSON.stringify({
  mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot',
  gh_config_dir: null, branch_prefix: 'feat/', remote_url: 'git@github.com:acme/widgets.git',
}));

const PAGE = {
  number: 12, title: 'Add a dark theme', url: 'https://github.com/acme/widgets/pull/12', state: 'OPEN', isDraft: false,
  author: { login: 'stranger' }, createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-18T09:30:00Z',
  baseRefName: 'main', headRefName: 'dark-theme', headRefOid: 'a'.repeat(40),
  headRepository: { name: 'widgets' }, headRepositoryOwner: { login: 'stranger' }, isCrossRepository: true,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null,
  body: 'Hello ghp_abcdefghijklmnopqrstuvwxyz0123', comments: [], reviews: [], commits: [], files: [],
  statusCheckRollup: [],
};
const THREADS = { data: { repository: { pullRequest: { reviewThreads: { totalCount: 0, nodes: [] } } } } };

type Call = { name: string; args: string[] };
const calls: Call[] = [];
let threadsFail = false;
let updatedAt = PAGE.updatedAt;

mock.method(getHost(), 'execAsync', async (name: string, args: string[], _opts: ExecOpts = {}): Promise<ExecResult> => {
  calls.push({ name, args });
  if (name !== 'gh') return { code: 1, stdout: '', stderr: 'no process in this test' };
  if (args[0] === 'pr' && args[1] === 'view') return { code: 0, stdout: JSON.stringify({ ...PAGE, updatedAt }), stderr: '' };
  if (args[0] === 'api' && args[1] === 'graphql') {
    return threadsFail ? { code: 1, stdout: '', stderr: 'HTTP 502' } : { code: 0, stdout: JSON.stringify(THREADS), stderr: '' };
  }
  if (args[0] === 'run' && args[1] === 'view') return { code: 0, stdout: 'step\nError: boom\n', stderr: '' };
  return { code: 1, stdout: '', stderr: 'unexpected gh call' };
});

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware: no header = anonymous.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  else if (who === 'reader') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:read'] };
  next();
});
let clock = 1_000_000;
registerExternalPrRoutes(app, { now: () => clock });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const stopWatching = watchPullRequestPages();
after(() => { stopWatching(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function get(path: string, who: 'anonymous' | 'reader' | 'manager') {
  return fetch(`${base}${path}`, { headers: who === 'anonymous' ? {} : { 'x-test-who': who } });
}

const PAGE_URL = '/api/projects/acme/pull-requests/12';
const LOG_URL = `${PAGE_URL}/check-log?url=${encodeURIComponent('https://github.com/acme/widgets/actions/runs/1/job/2')}`;

beforeEach(() => {
  calls.length = 0;
  forgetPullRequestPages();
  threadsFail = false;
  updatedAt = PAGE.updatedAt;
});

test('an anonymous caller is refused, and gh never runs', async () => {
  assert.equal((await get(PAGE_URL, 'anonymous')).status, 401);
  assert.equal((await get(LOG_URL, 'anonymous')).status, 401);
  assert.deepEqual(calls, []);
});

test('a caller without projects:manage is refused', async () => {
  assert.equal((await get(PAGE_URL, 'reader')).status, 403);
  assert.equal((await get(LOG_URL, 'reader')).status, 403);
  assert.deepEqual(calls, []);
});

test('a project that lands locally is refused clearly, without reaching the forge', async () => {
  const res = await get('/api/projects/solo/pull-requests/12', 'manager');
  assert.equal(res.status, 409);
  assert.equal(((await res.json()) as { code: string }).code, 'integration_not_pr');
  assert.equal((await get('/api/projects/ghost/pull-requests/12', 'manager')).status, 404);
  assert.deepEqual(calls, []);
});

test('bad parameters are refused before the forge', async () => {
  assert.equal((await get('/api/projects/acme/pull-requests/abc', 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}?updated=yesterday`, 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}/check-log?url=${encodeURIComponent('http://github.com/x')}`, 'manager')).status, 400);
  assert.equal((await get(`${PAGE_URL}/check-log`, 'manager')).status, 400);
  assert.deepEqual(calls, []);
});

test('the page is read from gh, reads only, without a token in it', async () => {
  const res = await get(PAGE_URL, 'manager');
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.doesNotMatch(text, /ghp_/);
  const body = JSON.parse(text) as { pull: { number: number; headRepository: string; threads: unknown[]; threadsError: string | null }; cached: boolean };
  assert.equal(body.pull.number, 12);
  assert.equal(body.pull.headRepository, 'stranger/widgets');
  assert.deepEqual(body.pull.threads, []);
  assert.equal(body.pull.threadsError, null);
  assert.equal(body.cached, false);
  assert.deepEqual(calls.map((c) => [c.name, c.args[0], c.args[1]]).sort(), [['gh', 'api', 'graphql'], ['gh', 'pr', 'view']]);
});

test('the threads failing leaves the rest of the page', async () => {
  threadsFail = true;
  const body = await (await get(PAGE_URL, 'manager')).json() as { pull: { title: string; threadsError: string | null } };
  assert.equal(body.pull.title, 'Add a dark theme');
  assert.ok(body.pull.threadsError);
});

test('a page read a moment ago is shown again without gh, until it ages or the pull request changed', async () => {
  await get(PAGE_URL, 'manager');
  assert.equal(calls.length, 2);
  const again = await (await get(PAGE_URL, 'manager')).json() as { cached: boolean };
  assert.equal(again.cached, true);
  assert.equal(calls.length, 2);
  // The list says the pull request changed since: read again.
  updatedAt = '2026-11-19T00:00:00Z';
  const changed = await (await get(`${PAGE_URL}?updated=${encodeURIComponent(updatedAt)}`, 'manager')).json() as { cached: boolean };
  assert.equal(changed.cached, false);
  assert.equal(calls.length, 4);
  // A fresh read asked for.
  await get(`${PAGE_URL}?fresh=1`, 'manager');
  assert.equal(calls.length, 6);
  // Aged out.
  clock += PAGE_CACHE_MS;
  await get(PAGE_URL, 'manager');
  assert.equal(calls.length, 8);
});

test('a job of the project that moves drops its pages', async () => {
  await get(PAGE_URL, 'manager');
  bus.publish({ kind: 'integration_changed', integrationId: 'x', project: 'acme', seriesId: null, state: 'open', changed: ['checks'] });
  const body = await (await get(PAGE_URL, 'manager')).json() as { cached: boolean };
  assert.equal(body.cached, false);
});

test('the end of a failed check\'s log comes from the repository\'s own CI only', async () => {
  const res = await get(LOG_URL, 'manager');
  assert.equal(res.status, 200);
  const body = await res.json() as { log: { tail: string } };
  assert.match(body.log.tail, /Error: boom/);
  assert.deepEqual(calls.at(-1)!.args.slice(0, 2), ['run', 'view']);
  const other = await get(`${PAGE_URL}/check-log?url=${encodeURIComponent('https://github.com/other/repo/actions/runs/1/job/2')}`, 'manager');
  assert.equal(other.status, 422);
  assert.equal(calls.length, 1);
});
