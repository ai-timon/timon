import '../../test-home.js';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { TIMON_HOME } from '../../paths.js';
import type { GhLoginOutcome } from '../../host/gh.js';
import { registerIntegrationRoutes } from './integration-routes.js';

const home = realpathSync(mkdtempSync(join(tmpdir(), 'timon-integration-routes-')));
const ghDir = join(home, '.config', 'gh-work');
mkdirSync(ghDir, { recursive: true });
const repo = join(home, 'code', 'acme');
mkdirSync(repo, { recursive: true });
dbApi.upsertProject('acme', { cwd: repo });

let ghAnswer: GhLoginOutcome = { ok: true, login: 'ai-bot' };
const ghCalls: Array<string | null> = [];

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware: no header = anonymous, else an
// api-token holding the grants the header names.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  else if (who === 'reader') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:read', 'kanban:write'] };
  else if (who === 'viewer') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:read'] };
  next();
});
registerIntegrationRoutes(app, {
  home,
  ghLogin: async (dir) => { ghCalls.push(dir); return ghAnswer; },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, who: 'anonymous' | 'viewer' | 'reader' | 'manager', body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const URL_ = '/api/projects/acme/integration';

test('an anonymous caller is refused on every verb, and nothing is written', async () => {
  assert.equal((await call('GET', URL_, 'anonymous')).status, 401);
  assert.equal((await call('PUT', URL_, 'anonymous', { mode: 'pr', account: 'ai-bot' })).status, 401);
  assert.equal((await call('DELETE', URL_, 'anonymous')).status, 401);
  assert.equal((await call('POST', `${URL_}/check`, 'anonymous')).status, 401);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
  assert.deepEqual(ghCalls, []);
});

test('a caller without projects:manage is refused, reads included', async () => {
  assert.equal((await call('GET', URL_, 'reader')).status, 403);
  assert.equal((await call('PUT', URL_, 'reader', { mode: 'pr', account: 'ai-bot' })).status, 403);
  assert.equal((await call('DELETE', URL_, 'reader')).status, 403);
  assert.equal((await call('POST', `${URL_}/check`, 'reader')).status, 403);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
  assert.deepEqual(ghCalls, []);
});

test('a manager reads the default, sets, reads back and resets the setting', async () => {
  const first = await (await call('GET', URL_, 'manager')).json() as { configured: boolean; integration: { mode: string } };
  assert.equal(first.configured, false);
  assert.equal(first.integration.mode, 'local');
  const put = await call('PUT', URL_, 'manager', { mode: 'pr', account: 'ai-bot', gh_config_dir: ghDir, branch_prefix: 'sec/' });
  assert.equal(put.status, 200);
  const read = await (await call('GET', URL_, 'manager')).json() as { configured: boolean; integration: Record<string, unknown> };
  assert.equal(read.configured, true);
  assert.deepEqual(read.integration, {
    mode: 'pr', remote: 'origin', target: 'main', forge: 'github', account: 'ai-bot', gh_config_dir: ghDir, branch_prefix: 'sec/',
    remote_url: null, contributor_conflicts: 'ask',
  });
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'project.integration_set' && row.target === 'acme:pr'));
  const cleared = await (await call('DELETE', URL_, 'manager')).json() as { configured: boolean };
  assert.equal(cleared.configured, false);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
});

test('bodies and paths that do not validate are refused before the database', async () => {
  for (const body of [
    { mode: 'pr' },
    { mode: 'local-merge' },
    { forge: 'gitlab' },
    { account: 'not a login' },
    { branch_prefix: 'timon/' },
    { unknown: 1 },
    { gh_config_dir: 'relative/gh' },
    { gh_config_dir: join(tmpdir(), 'outside-home') },
    { gh_config_dir: home },
    { gh_config_dir: join(TIMON_HOME, 'gh') },
    { gh_config_dir: join(repo, '.gh') },
    // git pushes these to evil.example, a URL parser reads github.com.
    { remote_url: 'https://github.com\\@evil.example/acme/app.git' },
    { remote_url: 'https://github.com%5C@evil.example/acme/app.git' },
    { remote_url: 'https://github.com\\\\@evil.example/acme/app.git' },
    { remote_url: 'https://a@b@evil.example/acme/app.git' },
    { remote_url: 'https://@evil.example/acme/app.git' },
    { remote_url: 'https://GitHub.com:443\\@evil.example/acme/app.git' },
    { remote_url: 'https://[::1]\\@evil.example/acme/app.git' },
    { remote_url: 'ssh://evil.example%2F@github.com/acme/app.git' },
    { remote_url: 'ssh://git@evil.example@github.com/acme/app.git' },
    // git's host_end() takes a bracket in the user for the host: ssh reaches evil.example.
    { remote_url: 'ssh://[evil.example]@github.com/acme/app.git' },
    { remote_url: 'git+ssh://[evil.example]@github.com/acme/app.git' },
    { remote_url: 'ssh+git://[evil.example]@github.com:22/acme/app.git' },
    { remote_url: 'ssh://[x]@github.com/acme/app.git' },
    { remote_url: '[evil.example]@github.com:acme/app.git' },
  ]) {
    const res = await call('PUT', URL_, 'manager', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    const text = await res.text();
    if (typeof body.gh_config_dir === 'string') assert.ok(!text.includes(body.gh_config_dir), 'the refusal does not echo the folder');
  }
  assert.equal(dbApi.getProjectRow('acme')?.integration, null);
});

test('an unknown project is 404, an invalid slug 400', async () => {
  assert.equal((await call('GET', '/api/projects/ghost/integration', 'manager')).status, 404);
  assert.equal((await call('PUT', '/api/projects/ghost/integration', 'manager', { mode: 'local' })).status, 404);
  assert.equal((await call('GET', '/api/projects/..%2Fetc/integration', 'manager')).status, 400);
  assert.equal(dbApi.getProjectRow('ghost'), undefined);
});

test('the check asks gh with the configured folder and compares the login, case aside', async () => {
  await call('PUT', URL_, 'manager', { mode: 'pr', account: 'AI-Bot', gh_config_dir: ghDir });
  ghCalls.length = 0;
  ghAnswer = { ok: true, login: 'ai-bot' };
  const good = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; matches: boolean; login: string };
  assert.deepEqual([good.ok, good.matches, good.login], [true, true, 'ai-bot']);
  assert.deepEqual(ghCalls, [ghDir]);
  ghAnswer = { ok: true, login: 'someone-else' };
  const wrong = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; matches: boolean };
  assert.deepEqual([wrong.ok, wrong.matches], [false, false]);
  ghAnswer = { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
  const missing = await (await call('POST', `${URL_}/check`, 'manager')).json() as { ok: boolean; code: string };
  assert.deepEqual([missing.ok, missing.code], [false, 'gh_missing']);
  await call('DELETE', URL_, 'manager');
});

test('the check takes a draft account and folder, writes nothing, and holds them to the write rules', async () => {
  ghCalls.length = 0;
  ghAnswer = { ok: true, login: 'ai-bot' };
  const res = await call('POST', `${URL_}/check`, 'manager', { account: 'AI-Bot', gh_config_dir: ghDir });
  const body = await res.json() as { ok: boolean; matches: boolean; login: string; expected: string };
  assert.deepEqual([res.status, body.ok, body.matches, body.login, body.expected], [200, true, true, 'ai-bot', 'AI-Bot']);
  assert.deepEqual(ghCalls, [ghDir]);
  assert.equal(dbApi.getProjectRow('acme')?.integration, null, 'a draft is never stored');

  // Without its account, the draft still says which login gh answers.
  const loginOnly = await (await call('POST', `${URL_}/check`, 'manager', { gh_config_dir: ghDir })).json() as { login: string; expected: null; matches: boolean };
  assert.deepEqual([loginOnly.login, loginOnly.expected, loginOnly.matches], ['ai-bot', null, false]);

  ghCalls.length = 0;
  const outside = await call('POST', `${URL_}/check`, 'manager', { gh_config_dir: join(TIMON_HOME, 'gh') });
  assert.equal(outside.status, 400);
  assert.equal((await outside.json() as { code: string }).code, 'integration_invalid');
  assert.equal((await call('POST', `${URL_}/check`, 'manager', { account: 'not a login' })).status, 400);
  assert.equal((await call('POST', `${URL_}/check`, 'manager', { remote: 'upstream' })).status, 400, 'only the account and the folder are a draft');
  assert.equal((await call('POST', `${URL_}/check`, 'reader', { account: 'ai-bot' })).status, 403);
  assert.deepEqual(ghCalls, [], 'a refused draft never reaches gh');
});

/* The Kanban planner's branch field: the daemon is the only judge of the name. */
const planRepo = join(home, 'code', 'plan');
mkdirSync(planRepo, { recursive: true });
dbApi.upsertProject('plan-pr', { cwd: planRepo });
dbApi.upsertProject('plan-release', { cwd: planRepo });
dbApi.upsertProject('plan-local', { cwd: planRepo });
const { updateProjectIntegration } = await import('../../project-integration.js');
updateProjectIntegration('plan-pr', { mode: 'pr', account: 'ai-bot' }, { home });
updateProjectIntegration('plan-release', { mode: 'pr', account: 'ai-bot', target: 'release/main', branch_prefix: 'release/' }, { home });
const BRANCH = '/api/projects/plan-pr/integration/branch';

test('the branch check refuses an anonymous caller (401) and one without kanban:write (403)', async () => {
  assert.equal((await call('POST', BRANCH, 'anonymous', { branch: 'topic' })).status, 401);
  assert.equal((await call('POST', BRANCH, 'viewer', { branch: 'topic' })).status, 403);
});

test('the branch check accepts a topic, adds the prefix once, and numbers a taken name', async () => {
  const plain = await call('POST', BRANCH, 'reader', { branch: 'kanban-branch-field' });
  assert.equal(plain.status, 200);
  assert.deepEqual(await plain.json(), { ok: true, branch: 'feat/kanban-branch-field' });
  const prefixed = await (await call('POST', BRANCH, 'reader', { branch: 'feat/kanban-branch-field' })).json();
  assert.deepEqual(prefixed, { ok: true, branch: 'feat/kanban-branch-field' });
  dbApi.recordIntegration({ repo: planRepo, branch: 'feat/taken', remote: 'origin', target: 'main', mode: 'pr', project: 'plan-pr' });
  assert.deepEqual(await (await call('POST', BRANCH, 'reader', { branch: 'taken' })).json(), { ok: true, branch: 'feat/taken-2' });
});

test('the branch check refuses an id, timon/, the target and an invalid ref with a reason', async () => {
  const refused = async (slug: string, branch: string, reason: RegExp) => {
    const res = await call('POST', `/api/projects/${slug}/integration/branch`, 'reader', { branch });
    assert.equal(res.status, 400, branch);
    const body = await res.json() as { ok: boolean; refusal: string; code: string };
    assert.equal(body.ok, false);
    assert.equal(body.code, 'plan_branch_refused');
    assert.match(body.refusal, reason, branch);
  };
  await refused('plan-pr', 'fix-bfd1c111de16', /carries an id/);
  await refused('plan-pr', 'timon/task/x', /reserved/);
  await refused('plan-pr', 'two..dots', /not a valid branch name/);
  await refused('plan-pr', '  ', /topic/);
  await refused('plan-release', 'main', /targets release\/main/);
});

test('the branch check of a project that merges locally: a new branch or one the repository has', async () => {
  const { execFileSync } = await import('node:child_process');
  const gitRepo = join(home, 'code', 'plan-git');
  mkdirSync(gitRepo, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', gitRepo, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('branch', 'feat/ongoing');
  dbApi.upsertProject('plan-git', { cwd: gitRepo });
  const url = '/api/projects/plan-git/integration/branch';
  assert.deepEqual(await (await call('POST', url, 'reader', { branch: 'topic' })).json(), { ok: true, branch: 'feat/topic' });
  // A new branch skips a name the repository has; an existing one is taken as named.
  assert.deepEqual(await (await call('POST', url, 'reader', { branch: 'ongoing' })).json(), { ok: true, branch: 'feat/ongoing-2' });
  assert.deepEqual(await (await call('POST', url, 'reader', { branch: 'feat/ongoing', kind: 'existing' })).json(), { ok: true, branch: 'feat/ongoing' });
  const missing = await call('POST', url, 'reader', { branch: 'feat/missing', kind: 'existing' });
  assert.equal(missing.status, 400);
  assert.match((await missing.json() as { refusal: string }).refusal, /does not exist in the repository/);
  const target = await call('POST', url, 'reader', { branch: 'main', kind: 'existing' });
  assert.match((await target.json() as { refusal: string }).refusal, /the job merges into main/);
  // A folder git cannot read refuses an existing branch rather than guess.
  const unread = await call('POST', '/api/projects/plan-local/integration/branch', 'reader', { branch: 'feat/x', kind: 'existing' });
  assert.match((await unread.json() as { refusal: string }).refusal, /cannot be read/);
  assert.equal((await call('POST', url, 'anonymous', { branch: 'topic' })).status, 401);
  assert.equal((await call('POST', url, 'viewer', { branch: 'topic' })).status, 403);
});

test('the branch check of a project whose setting no longer validates is 409', async () => {
  dbApi.upsertProject('plan-broken', { cwd: planRepo });
  dbApi.setProjectIntegration('plan-broken', JSON.stringify({ mode: 'pr', remote: 'origin' }));
  const res = await call('POST', '/api/projects/plan-broken/integration/branch', 'reader', { branch: 'topic' });
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { code: string }).code, 'plan_branch_unavailable');
});

test('the branch check takes a strict body', async () => {
  assert.equal((await call('POST', BRANCH, 'reader', { branch: 'topic', extra: 1 })).status, 400);
  assert.equal((await call('POST', BRANCH, 'reader', {})).status, 400);
  assert.equal((await call('POST', BRANCH, 'reader', { branch: 'topic', kind: 'old' })).status, 400);
});
