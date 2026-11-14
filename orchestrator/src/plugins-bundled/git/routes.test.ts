/**
 * GET /api/git-remote/:slug — the response contract, unchanged by the move to
 * asynchronous git calls, and the refusal of an anonymous caller. Every git
 * route — a 400 from its zod schema on a wrong type or an unknown field.
 * Witness server on 127.0.0.1:0, never :3000; real throwaway git repositories.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-git-remote-routes-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// No fence configured: the temporary folders the test remotes live in are no
// place a mission writes. A fence leaves them writable, and the daemon's git
// then refuses them as remotes (`git-neutral.test.ts`).
writeFileSync(join(process.env.TIMON_HOME, 'timon.config.json'), JSON.stringify({ host: { isolation: { filesystem: 'off' } } }));

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { writeMeta } = await import('../../projects.js');
const { agentConfig, agentDir } = await import('../../paths.js');
const { getHost } = await import('../../host/index.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

// The same routes behind a middleware that lets an anonymous caller through
// (first-run setup, no user yet): what refuses it there is the route itself.
const open = express();
open.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
open.use(express.json());
registerRoutes(open);
const openServer = open.listen(0, '127.0.0.1');
await once(openServer, 'listening');
const openBase = `http://127.0.0.1:${(openServer.address() as AddressInfo).port}`;

const dir = mkdtempSync(join(tmpdir(), 'timon-git-remote-repo-'));
const bare = join(dir, 'remote.git');
const work = join(dir, 'work');
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
execFileSync('git', ['init', '-q', '-b', 'main', work]);
git(work, 'config', 'user.email', 'test@timon.local');
git(work, 'config', 'user.name', 'timon-test');
git(work, 'remote', 'add', 'origin', bare);
writeFileSync(join(work, 'a'), 'a');
git(work, 'add', '.');
git(work, 'commit', '-qm', 'first');
git(work, 'push', '-q', '-u', 'origin', 'main');
writeMeta('gitproj', { cwd: work });

test.after(() => {
  server.close();
  openServer.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

/** The fields the Git widget reads — a key added or lost is a contract break. */
const STATUS_KEYS = [
  'ahead', 'behind', 'branch', 'branch_published', 'branches', 'compare_ref', 'cwd',
  'cwd_code', 'cwd_error', 'cwd_path', 'default_repo_name', 'dirty', 'fetched_at', 'gh_account', 'gh_available',
  'has_commits', 'last_commit_at', 'remote', 'remote_count', 'remote_name',
  'remote_web', 'remotes', 'slug', 'state', 'upstream',
];
const BRANCH_KEYS = ['ahead', 'behind', 'compare_ref', 'name', 'published', 'upstream'];

test('anonymous caller is refused', async () => {
  const r = await fetch(`${base}/api/git-remote/gitproj`);
  assert.equal(r.status, 401);
});

test('status keeps its contract: same fields, same values', async () => {
  const r = await fetch(`${base}/api/git-remote/gitproj`, { headers: auth });
  assert.equal(r.status, 200);
  const { git: s } = await r.json() as { git: Record<string, unknown> & { branches: Record<string, unknown>[] } };
  assert.deepEqual(Object.keys(s).sort(), STATUS_KEYS);
  assert.equal(s.slug, 'gitproj');
  assert.equal(s.cwd, work);
  assert.equal(s.cwd_path, work);
  assert.equal(s.cwd_error, null);
  assert.equal(s.state, 'synced');
  assert.equal(s.branch, 'main');
  assert.equal(s.remote_name, 'origin');
  assert.equal(s.remote_count, 1);
  assert.equal(s.remote, bare);
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.compare_ref, 'origin/main');
  assert.equal(s.branch_published, true);
  assert.equal(s.ahead, 0);
  assert.equal(s.behind, 0);
  assert.equal(s.dirty, 0);
  assert.equal(s.has_commits, true);
  assert.equal(typeof s.last_commit_at, 'number');
  assert.equal(typeof s.gh_available, 'boolean');
  assert.equal(s.default_repo_name, 'work');
  assert.equal(s.branches.length, 1);
  assert.deepEqual(Object.keys(s.branches[0]!).sort(), BRANCH_KEYS);
  assert.deepEqual(s.branches[0], {
    name: 'main', upstream: 'origin/main', compare_ref: 'origin/main', ahead: 0, behind: 0, published: true,
  });
  assert.deepEqual(s.remotes, [{
    name: 'origin', url: bare, web: null, branches: [{ name: 'main', published: true, ahead: 0 }],
  }]);
});

test('concurrent polls share one status', async () => {
  const [a, b] = await Promise.all([
    fetch(`${base}/api/git-remote/gitproj`, { headers: auth }).then((r) => r.json()),
    fetch(`${base}/api/git-remote/gitproj`, { headers: auth }).then((r) => r.json()),
  ]);
  assert.deepEqual(a, b);
});

test('project without a cwd answers no-cwd, an invalid slug a 400', async () => {
  writeMeta('nocwd', {});
  const r = await fetch(`${base}/api/git-remote/nocwd`, { headers: auth });
  assert.equal(r.status, 200);
  assert.equal(((await r.json()) as { git: { state: string } }).git.state, 'no-cwd');
  const bad = await fetch(`${base}/api/git-remote/${encodeURIComponent('../etc')}`, { headers: auth });
  assert.equal(bad.status, 400);
});

const json = { ...auth, 'content-type': 'application/json' };
function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'POST', headers: json, body: JSON.stringify(body) });
}
/** A 400 from the schema, not from git further down: the request never ran. */
async function assertRefused(r: Response, label: string): Promise<void> {
  assert.equal(r.status, 400, label);
  const { error } = await r.json() as { error: string };
  assert.match(error, /^invalid request: /, label);
}

test('every git route refuses wrong types and unknown fields with a 400', async () => {
  git(work, 'branch', 'side');
  const cases: Array<[string, () => Promise<Response>]> = [
    // `..` itself cannot be sent: the URL parser folds it before the request leaves.
    ['agent git: name too long', () => fetch(`${base}/api/agents/${'a'.repeat(129)}/git`, { headers: auth })],
    ['agent git: name with a semicolon', () => fetch(`${base}/api/agents/${encodeURIComponent('a;b')}/git`, { headers: auth })],
    ['agent git: name with a space', () => fetch(`${base}/api/agents/${encodeURIComponent('a b')}/git`, { headers: auth })],
    ['remote status: slug too long', () => fetch(`${base}/api/git-remote/${'s'.repeat(65)}`, { headers: auth })],
    ['create-remote: private as a string', () => post('/api/git-remote/gitproj/create-remote', { private: 'false' })],
    ['create-remote: name as a number', () => post('/api/git-remote/gitproj/create-remote', { name: 42 })],
    ['create-remote: description too long', () => post('/api/git-remote/gitproj/create-remote', { description: 'x'.repeat(351) })],
    ['create-remote: unknown field', () => post('/api/git-remote/gitproj/create-remote', { private: true, homepage: 'x' })],
    ['create-remote: invalid slug', () => post(`/api/git-remote/${encodeURIComponent('a b')}/create-remote`, {})],
    ['push: branch as a number', () => post('/api/git-remote/gitproj/push', { branch: 1 })],
    ['push: option-looking branch', () => post('/api/git-remote/gitproj/push', { branch: '--force' })],
    ['push: unknown field', () => post('/api/git-remote/gitproj/push', { branch: 'main', force: true })],
    ['push: array body', () => post('/api/git-remote/gitproj/push', ['main'])],
    ['fetch: unknown field', () => post('/api/git-remote/gitproj/fetch', { prune: true })],
    ['fetch: invalid slug', () => post(`/api/git-remote/${encodeURIComponent('a;b')}/fetch`, {})],
    ['status: slug missing', () => fetch(`${base}/api/git/status`, { headers: auth })],
    ['status: slug repeated', () => fetch(`${base}/api/git/status?slug=gitproj&slug=other`, { headers: auth })],
    ['status: unknown query field', () => fetch(`${base}/api/git/status?slug=gitproj&cwd=/`, { headers: auth })],
    ['checkout: branch missing', () => post('/api/git/checkout', { slug: 'gitproj' })],
    ['checkout: branch as a number', () => post('/api/git/checkout', { slug: 'gitproj', branch: 7 })],
    ['checkout: slug traversal', () => post('/api/git/checkout', { slug: '../x', branch: 'side' })],
    ['checkout: slug ..', () => post('/api/git/checkout', { slug: '..', branch: 'side' })],
    ['checkout: unknown field', () => post('/api/git/checkout', { slug: 'gitproj', branch: 'side', cwd: '/' })],
    ['delete-branch: force as a string', () => post('/api/git/delete-branch', { slug: 'gitproj', branch: 'side', force: 'yes' })],
    ['delete-branch: unknown field', () => post('/api/git/delete-branch', { slug: 'gitproj', branch: 'side', remote: true })],
    ['delete-branch: branch with ..', () => post('/api/git/delete-branch', { slug: 'gitproj', branch: 'a..b' })],
    // A query field on a route that takes none: one per route.
    ['agent git: unknown query field', () => fetch(`${base}/api/agents/nobody/git?cwd=/`, { headers: auth })],
    ['agent git: slug traversal', () => fetch(`${base}/api/agents/nobody/git?slug=${encodeURIComponent('../x')}`, { headers: auth })],
    ['agent git: slug repeated', () => fetch(`${base}/api/agents/nobody/git?slug=gitproj&slug=other`, { headers: auth })],
    ['remote status: unknown query field', () => fetch(`${base}/api/git-remote/gitproj?cwd=/`, { headers: auth })],
    ['create-remote: unknown query field', () => post('/api/git-remote/gitproj/create-remote?private=true', {})],
    ['push: unknown query field', () => post('/api/git-remote/gitproj/push?force=1', { branch: 'main' })],
    ['fetch: unknown query field', () => post('/api/git-remote/gitproj/fetch?prune=1', {})],
    ['checkout: unknown query field', () => post('/api/git/checkout?force=1', { slug: 'gitproj', branch: 'side' })],
    ['delete-branch: unknown query field', () => post('/api/git/delete-branch?force=1', { slug: 'gitproj', branch: 'side' })],
    ['worktrees: slug missing', () => fetch(`${base}/api/git/worktrees`, { headers: auth })],
    ['worktrees: slug traversal', () => fetch(`${base}/api/git/worktrees?slug=${encodeURIComponent('../x')}`, { headers: auth })],
    ['worktrees: slug repeated', () => fetch(`${base}/api/git/worktrees?slug=gitproj&slug=other`, { headers: auth })],
    ['worktrees: unknown query field', () => fetch(`${base}/api/git/worktrees?slug=gitproj&cwd=/`, { headers: auth })],
    ['log: slug missing', () => fetch(`${base}/api/git/log?limit=5`, { headers: auth })],
    ['log: invalid slug', () => fetch(`${base}/api/git/log?slug=${encodeURIComponent('a;b')}`, { headers: auth })],
    ['log: limit 0', () => fetch(`${base}/api/git/log?slug=gitproj&limit=0`, { headers: auth })],
    ['log: limit over the cap', () => fetch(`${base}/api/git/log?slug=gitproj&limit=501`, { headers: auth })],
    ['log: limit not a number', () => fetch(`${base}/api/git/log?slug=gitproj&limit=abc`, { headers: auth })],
    ['log: limit negative', () => fetch(`${base}/api/git/log?slug=gitproj&limit=-1`, { headers: auth })],
    ['log: limit in exponent form', () => fetch(`${base}/api/git/log?slug=gitproj&limit=1e2`, { headers: auth })],
    ['log: limit repeated', () => fetch(`${base}/api/git/log?slug=gitproj&limit=1&limit=2`, { headers: auth })],
    ['log: skip negative', () => fetch(`${base}/api/git/log?slug=gitproj&skip=-3`, { headers: auth })],
    ['log: option-looking ref', () => fetch(`${base}/api/git/log?slug=gitproj&ref=--all`, { headers: auth })],
    ['log: unknown query field', () => fetch(`${base}/api/git/log?slug=gitproj&format=%25H`, { headers: auth })],
  ];
  for (const [label, call] of cases) await assertRefused(await call(), label);
  // Nothing ran: still on main, and the side branch survived.
  assert.equal(git(work, 'branch', '--show-current'), 'main');
  assert.equal(git(work, 'branch', '--list', 'side'), 'side');
});

test('well-formed requests still reach git', async () => {
  assert.equal((await post('/api/git-remote/gitproj/fetch', {})).status, 200);
  assert.equal((await fetch(`${base}/api/git-remote/gitproj/fetch`, { method: 'POST', headers: auth })).status, 200);
  assert.equal((await post('/api/git-remote/gitproj/push', { branch: '' })).status, 200);
  assert.equal((await post('/api/git-remote/gitproj/push', { branch: 'main' })).status, 200);
  assert.equal((await fetch(`${base}/api/git/status?slug=gitproj`, { headers: auth })).status, 200);
  const agent = await fetch(`${base}/api/agents/nobody/git`, { headers: auth });
  assert.equal(agent.status, 200);
  assert.deepEqual(await agent.json(), { branch: null, dirty: false, worktree: null, added: 0, removed: 0 });
  // With its project, the answer says whether the agent's folder is that repository.
  mkdirSync(agentDir('gitagent'), { recursive: true });
  writeFileSync(agentConfig('gitagent'), JSON.stringify({ name: 'gitagent', cwd: work }));
  const own = await fetch(`${base}/api/agents/gitagent/git?slug=gitproj`, { headers: auth });
  assert.equal(own.status, 200);
  assert.equal((await own.json() as { foreignRepo?: boolean }).foreignRepo, false);
  writeMeta('elsewhere', { cwd: bare });
  const foreign = await fetch(`${base}/api/agents/gitagent/git?slug=elsewhere`, { headers: auth });
  assert.equal((await foreign.json() as { foreignRepo?: boolean }).foreignRepo, true);
  if (!git(work, 'branch', '--list', 'gone')) git(work, 'branch', 'gone');
  assert.equal((await post('/api/git/checkout', { slug: 'gitproj', branch: 'gone' })).status, 200);
  assert.equal(git(work, 'branch', '--show-current'), 'gone');
  assert.equal((await post('/api/git/checkout', { slug: 'gitproj', branch: 'main' })).status, 200);
  assert.equal((await post('/api/git/delete-branch', { slug: 'gitproj', branch: 'gone', force: false })).status, 200);
  assert.equal(git(work, 'branch', '--list', 'gone'), '');
});

// The client keeps its last known state on a failed read, and reads a 200 as a
// fact: a git that did not answer must not look like a repository that is not one.
test('an agent read git did not answer is a 503, never an empty 200', async (t) => {
  mkdirSync(agentDir('silentagent'), { recursive: true });
  writeFileSync(agentConfig('silentagent'), JSON.stringify({ name: 'silentagent', cwd: work }));
  t.mock.method(getHost(), 'execAsync', async () => ({ code: 1, stdout: '', stderr: '', timedOut: true }));
  const res = await fetch(`${base}/api/agents/silentagent/git?slug=gitproj`, { headers: auth });
  assert.equal(res.status, 503);
  assert.match((await res.json() as { error: string }).error, /did not answer/);
  const anonymous = await fetch(`${openBase}/api/agents/silentagent/git?slug=gitproj`);
  assert.equal(anonymous.status, 401);
});

test('the graph routes refuse an anonymous caller, even when the middleware lets it through', async () => {
  for (const path of ['/api/git/worktrees?slug=gitproj', '/api/git/log?slug=gitproj']) {
    assert.equal((await fetch(`${base}${path}`)).status, 401, `${path} behind the required middleware`);
    const r = await fetch(`${openBase}${path}`);
    assert.equal(r.status, 401, `${path} on its own`);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
});

test('worktrees lists the main checkout and a linked worktree', async () => {
  const linked = join(dir, 'linked wt');
  git(work, 'worktree', 'add', '-q', '-b', 'graph-wt', linked);
  try {
    const r = await fetch(`${base}/api/git/worktrees?slug=gitproj`, { headers: auth });
    assert.equal(r.status, 200);
    const body = await r.json() as { ok: boolean; worktrees: Array<Record<string, unknown>> };
    assert.equal(body.ok, true);
    assert.equal(body.worktrees.length, 2);
    const [main, wt] = body.worktrees as [Record<string, unknown>, Record<string, unknown>];
    assert.equal(realpathSync(main.path as string), realpathSync(work));
    assert.equal(main.main, true);
    assert.equal(main.current, true);
    assert.equal(main.branch, 'main');
    assert.equal(main.head, git(work, 'rev-parse', 'HEAD'));
    assert.equal(realpathSync(wt.path as string), realpathSync(linked));
    assert.deepEqual({ ...wt, path: null }, {
      path: null, head: git(linked, 'rev-parse', 'HEAD'), branch: 'graph-wt', main: false, current: false,
      bare: false, detached: false, locked: null, prunable: null,
    });
  } finally {
    git(work, 'worktree', 'remove', '--force', linked);
    git(work, 'branch', '-D', 'graph-wt');
  }
});

test('worktrees of a project whose cwd is not a repository answers ok: false', async () => {
  const plain = mkdtempSync(join(tmpdir(), 'timon-git-plain-'));
  writeMeta('plainproj', { cwd: plain });
  try {
    const r = await fetch(`${base}/api/git/worktrees?slug=plainproj`, { headers: auth });
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: false, repo: plain, worktrees: [], error: 'not a git repository' });
    assert.equal((await fetch(`${base}/api/git/worktrees?slug=nocwd`, { headers: auth })).status, 400);
  } finally {
    rmSync(plain, { recursive: true, force: true });
  }
});

type LogBody = {
  ok: boolean; head: string | null; currentBranch: string | null; truncated: boolean; error?: string;
  commits: Array<{
    hash: string; short: string; parents: string[]; author: string; ts: number; subject: string;
    refs: Array<{ kind: string; name: string }>;
  }>;
};
async function log(query: string): Promise<LogBody> {
  const r = await fetch(`${base}/api/git/log?${query}`, { headers: auth });
  assert.equal(r.status, 200, query);
  return await r.json() as LogBody;
}

test('log of a repository without commits is empty, not an error', async () => {
  const fresh = mkdtempSync(join(tmpdir(), 'timon-git-fresh-'));
  execFileSync('git', ['init', '-q', '-b', 'main', fresh]);
  writeMeta('freshproj', { cwd: fresh });
  try {
    assert.deepEqual(await log('slug=freshproj'), {
      ok: true, repo: fresh, head: null, currentBranch: 'main', truncated: false, commits: [],
    } as unknown as LogBody);
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('log returns a bounded graph: parents, refs, author, date, short hash', async () => {
  git(work, 'checkout', '-q', '-b', 'graph-feat');
  writeFileSync(join(work, 'feat'), 'feat');
  git(work, 'add', '.');
  git(work, 'commit', '-qm', 'feature work');
  git(work, 'checkout', '-q', 'main');
  git(work, 'merge', '-q', '--no-ff', '-m', 'merge graph-feat', 'graph-feat');
  git(work, 'tag', 'v-graph');
  const headSha = git(work, 'rev-parse', 'HEAD');

  const body = await log('slug=gitproj');
  assert.equal(body.ok, true);
  assert.equal(body.head, headSha);
  assert.equal(body.currentBranch, 'main');
  assert.equal(body.truncated, false);
  const [merge, ...rest] = body.commits;
  assert.ok(merge);
  assert.equal(merge.hash, headSha);
  assert.ok(merge.hash.startsWith(merge.short) && merge.short.length < merge.hash.length);
  assert.equal(merge.parents.length, 2);
  assert.equal(merge.parents[0], git(work, 'rev-parse', 'HEAD^1'));
  assert.equal(merge.subject, 'merge graph-feat');
  assert.equal(merge.author, 'timon-test');
  assert.equal(merge.ts, Number(git(work, 'log', '-1', '--format=%at')) * 1000);
  assert.deepEqual(merge.refs, [
    { kind: 'head', name: 'HEAD' }, { kind: 'branch', name: 'main' }, { kind: 'tag', name: 'v-graph' },
  ]);
  const feat = rest.find((c) => c.subject === 'feature work');
  assert.deepEqual(feat?.refs, [{ kind: 'branch', name: 'graph-feat' }]);
  // The pushed first commit carries the remote branch, its symbolic HEAD dropped.
  const first = rest.find((c) => c.subject === 'first');
  assert.ok(first?.refs.some((r) => r.kind === 'remote' && r.name === 'origin/main'));
  assert.deepEqual(first?.parents, []);
  // Children always come before their parents.
  const index = new Map(body.commits.map((c, i) => [c.hash, i]));
  for (const [i, c] of body.commits.entries()) {
    for (const p of c.parents) assert.ok((index.get(p) ?? Infinity) > i, `${c.short} before its parent`);
  }

  const page = await log('slug=gitproj&limit=1');
  assert.equal(page.commits.length, 1);
  assert.equal(page.truncated, true);
  assert.equal(page.commits[0]?.hash, headSha);
  const next = await log('slug=gitproj&limit=1&skip=1');
  assert.equal(next.commits.length, 1);
  assert.notEqual(next.commits[0]?.hash, headSha);
  assert.equal((await log(`slug=gitproj&limit=${body.commits.length}`)).truncated, false);
});

/** The routes behind a caller that holds exactly `permissions`, nothing more. */
async function witness(permissions: string[]): Promise<string> {
  const holder = express();
  holder.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions };
    next();
  });
  holder.use(express.json());
  registerRoutes(holder);
  const holderServer = holder.listen(0, '127.0.0.1');
  await once(holderServer, 'listening');
  test.after(() => { holderServer.close(); });
  return `http://127.0.0.1:${(holderServer.address() as AddressInfo).port}`;
}

// A session that is signed in but holds no right on the repository.
const readerBase = await witness(['projects:read', 'page:/chat']);
// The Git card of the chat, and nothing else (TODO #689).
const cardBase = await witness(['widget:git']);
const pluginBase = await witness(['plugin:@timon/git']);
// The project cards of `/agents` show the publication state, nothing more.
const agentsPageBase = await witness(['page:/agents']);

type Remote = { name: string; url: string | null; push_url: string | null };
type RemoteChangeBody = {
  git: { remote: string | null; remote_name: string | null; remote_count: number };
  remotes: Remote[];
  check: { ok: true } | { ok: false; error: string } | null;
};
function send(method: string, path: string, body?: unknown, b = base): Promise<Response> {
  return fetch(`${b}${path}`, {
    method,
    headers: body === undefined ? auth : json,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('the remote routes refuse an anonymous caller, even when the middleware lets it through', async () => {
  const calls: Array<[string, string, unknown]> = [
    ['GET', '/api/git-remote/gitproj/remotes', undefined],
    ['POST', '/api/git-remote/gitproj/remotes', { name: 'anon', url: bare }],
    ['PATCH', '/api/git-remote/gitproj/remotes/origin', { url: bare }],
    ['DELETE', '/api/git-remote/gitproj/remotes/origin', undefined],
  ];
  for (const [method, path, body] of calls) {
    const init = { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) };
    assert.equal((await fetch(`${base}${path}`, init)).status, 401, `${method} ${path} behind the required middleware`);
    const r = await fetch(`${openBase}${path}`, init);
    assert.equal(r.status, 401, `${method} ${path} on its own`);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
  assert.deepEqual(git(work, 'remote').split('\n'), ['origin']);
});

test('changing a remote needs projects:manage; reading them needs the Git card', async () => {
  assert.equal((await send('GET', '/api/git-remote/gitproj/remotes', undefined, readerBase)).status, 403);
  assert.equal((await send('GET', '/api/git-remote/gitproj/remotes', undefined, cardBase)).status, 200);
  const writes: Array<[string, string, unknown]> = [
    ['POST', '/api/git-remote/gitproj/remotes', { name: 'nope', url: bare }],
    ['PATCH', '/api/git-remote/gitproj/remotes/origin', { url: 'git@example.com:o/r.git' }],
    ['DELETE', '/api/git-remote/gitproj/remotes/origin', undefined],
  ];
  for (const [method, path, body] of writes) {
    for (const b of [readerBase, cardBase]) {
      const r = await send(method, path, body, b);
      assert.equal(r.status, 403, `${method} ${path}`);
    }
  }
  assert.deepEqual(git(work, 'remote').split('\n'), ['origin']);
  assert.equal(git(work, 'remote', 'get-url', 'origin'), bare);
});

// A token that holds the edit right and nothing else: what the routes ask.
const manager = express();
manager.use((req, _res, next) => {
  req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  next();
});
manager.use(express.json());
registerRoutes(manager);
const managerServer = manager.listen(0, '127.0.0.1');
await once(managerServer, 'listening');
const managerBase = `http://127.0.0.1:${(managerServer.address() as AddressInfo).port}`;
test.after(() => { managerServer.close(); });

/** Every route of the module, with a body that would pass its schema. */
const EVERY_ROUTE: Array<[string, string, unknown]> = [
  ['GET', '/api/agents/gitagent/git', undefined],
  ['GET', '/api/git-remote/gitproj', undefined],
  ['POST', '/api/git-remote/gitproj/create-remote', {}],
  ['POST', '/api/git-remote/gitproj/push', { branch: 'main' }],
  ['POST', '/api/git-remote/gitproj/fetch', {}],
  ['GET', '/api/git/status?slug=gitproj', undefined],
  ['GET', '/api/git/worktrees?slug=gitproj', undefined],
  ['GET', '/api/git/log?slug=gitproj', undefined],
  ['GET', '/api/git/repos?slug=gitproj', undefined],
  ['POST', '/api/git/checkout', { slug: 'gitproj', branch: 'main' }],
  ['POST', '/api/git/delete-branch', { slug: 'gitproj', branch: 'main' }],
];

test('every git route refuses an anonymous caller, even when the middleware lets it through', async () => {
  for (const [method, path, body] of EVERY_ROUTE) {
    const init = { method, headers: { 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) };
    assert.equal((await fetch(`${base}${path}`, init)).status, 401, `${method} ${path} behind the required middleware`);
    const r = await fetch(`${openBase}${path}`, init);
    assert.equal(r.status, 401, `${method} ${path} on its own`);
    assert.deepEqual(await r.json(), { error: 'unauthorized' });
  }
});

test('push, fetch, create-remote, checkout and delete-branch need projects:manage', async () => {
  git(work, 'branch', 'keep-me');
  git(work, 'branch', 'unpublished');
  const head = git(work, 'rev-parse', 'HEAD');
  const remoteRefs = git(bare, 'for-each-ref', '--format=%(refname) %(objectname)');
  const localRefs = git(work, 'for-each-ref', '--format=%(refname) %(objectname)');
  const writes: Array<[string, unknown]> = [
    ['/api/git-remote/gitproj/create-remote', { name: 'leak' }],
    ['/api/git-remote/gitproj/push', { branch: 'unpublished' }],
    ['/api/git-remote/gitproj/fetch', {}],
    ['/api/git/checkout', { slug: 'gitproj', branch: 'keep-me' }],
    ['/api/git/delete-branch', { slug: 'gitproj', branch: 'keep-me', force: true }],
  ];
  for (const [path, body] of writes) {
    const r = await send('POST', path, body, readerBase);
    assert.equal(r.status, 403, `POST ${path}`);
    const refusal = await r.json() as { error: string; permission: string };
    assert.equal(refusal.error, 'forbidden');
    assert.equal(refusal.permission, 'projects:manage');
  }
  // Nothing moved: the remote, the local refs, the checked-out branch.
  assert.equal(git(bare, 'for-each-ref', '--format=%(refname) %(objectname)'), remoteRefs);
  assert.equal(git(work, 'for-each-ref', '--format=%(refname) %(objectname)'), localRefs);
  assert.equal(git(work, 'branch', '--show-current'), 'main');
  assert.equal(git(work, 'rev-parse', 'HEAD'), head);

  // The permission alone is what opens them.
  let r = await send('POST', '/api/git-remote/gitproj/push', { branch: 'unpublished' }, managerBase);
  assert.equal(r.status, 200);
  assert.equal(git(bare, 'rev-parse', 'refs/heads/unpublished'), head);
  r = await send('POST', '/api/git/delete-branch', { slug: 'gitproj', branch: 'keep-me' }, managerBase);
  assert.equal(r.status, 200);
  assert.equal(git(work, 'branch', '--list', 'keep-me'), '');
  git(bare, 'branch', '-D', 'unpublished');
  git(work, 'branch', '-D', 'unpublished');
});

/** Every read of the repository; the first one is also the project cards' read. */
const READS = [
  '/api/git-remote/gitproj',
  '/api/git-remote/gitproj/remotes',
  '/api/agents/gitagent/git?slug=gitproj',
  '/api/git/status?slug=gitproj',
  '/api/git/worktrees?slug=gitproj',
  '/api/git/log?slug=gitproj',
  '/api/git/repos?slug=gitproj',
];

test('a signed-in account without the Git card reads nothing of the repository (TODO #689)', async () => {
  mkdirSync(agentDir('gitagent'), { recursive: true });
  writeFileSync(agentConfig('gitagent'), JSON.stringify({ name: 'gitagent', cwd: work }));
  const branch = git(work, 'branch', '--show-current');
  const head = git(work, 'rev-parse', 'HEAD');
  for (const path of READS) {
    const r = await send('GET', path, undefined, readerBase);
    assert.equal(r.status, 403, `GET ${path}`);
    const text = await r.text();
    const refusal = JSON.parse(text) as { error: string; permission: string[] };
    assert.equal(refusal.error, 'forbidden');
    assert.deepEqual(refusal.permission.slice(0, 3), ['projects:manage', 'widget:git', 'plugin:@timon/git'], path);
    // The refusal carries none of what the read would have shown.
    assert.ok(!text.includes(head) && !text.includes(work) && !text.includes(`"${branch}"`), `GET ${path} leaks the repository`);
  }
});

test('the Git card, its plugin and projects:manage each open every read', async () => {
  for (const b of [cardBase, pluginBase, managerBase]) {
    for (const path of READS) assert.equal((await send('GET', path, undefined, b)).status, 200, `GET ${path} on ${b}`);
  }
});

test('the /agents page reads the publication state of its project cards, nothing else', async () => {
  const [remote, ...rest] = READS;
  assert.equal((await send('GET', remote!, undefined, agentsPageBase)).status, 200);
  for (const path of rest) assert.equal((await send('GET', path, undefined, agentsPageBase)).status, 403, `GET ${path}`);
});

test('the remote routes refuse a bad name, a bad url or an unknown field with a 400', async () => {
  const cases: Array<[string, () => Promise<Response>]> = [
    ['add: name missing', () => send('POST', '/api/git-remote/gitproj/remotes', { url: bare })],
    ['add: url missing', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x' })],
    ['add: option-looking name', () => send('POST', '/api/git-remote/gitproj/remotes', { name: '-x', url: bare })],
    ['add: name with a space', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'a b', url: bare })],
    ['add: name with ..', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'a..b', url: bare })],
    ['add: name with a slash', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'a/b', url: bare })],
    ['add: ext transport', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x', url: 'ext::sh -c touch% pwned' })],
    ['add: option-looking url', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x', url: '--upload-pack=touch pwned' })],
    ['add: relative path', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x', url: 'some/where' })],
    ['add: check as a string', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x', url: bare, check: 'no' })],
    ['add: unknown field', () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'x', url: bare, push_url: bare })],
    ['add: unknown query field', () => send('POST', '/api/git-remote/gitproj/remotes?force=1', { name: 'x', url: bare })],
    ['add: invalid slug', () => send('POST', `/api/git-remote/${encodeURIComponent('a b')}/remotes`, { name: 'x', url: bare })],
    ['set-url: url missing', () => send('PATCH', '/api/git-remote/gitproj/remotes/origin', {})],
    ['set-url: name field in the body', () => send('PATCH', '/api/git-remote/gitproj/remotes/origin', { url: bare, name: 'other' })],
    ['set-url: invalid name', () => send('PATCH', `/api/git-remote/gitproj/remotes/${encodeURIComponent('a;b')}`, { url: bare })],
    ['remove: unknown body field', () => send('DELETE', '/api/git-remote/gitproj/remotes/origin', { force: true })],
    ['remove: unknown query field', () => send('DELETE', '/api/git-remote/gitproj/remotes/origin?force=1')],
    ['list: unknown query field', () => send('GET', '/api/git-remote/gitproj/remotes?all=1')],
  ];
  for (const [label, call] of cases) await assertRefused(await call(), label);
  assert.deepEqual(git(work, 'remote').split('\n'), ['origin']);
});

test('an https url with credentials is refused and never echoed', async () => {
  for (const url of ['https://user:hunter2-secret@example.com/o/r.git', 'https://ghp_hunter2secret@github.com/o/r.git']) {
    for (const call of [
      () => send('POST', '/api/git-remote/gitproj/remotes', { name: 'leak', url }),
      () => send('PATCH', '/api/git-remote/gitproj/remotes/origin', { url }),
    ]) {
      const r = await call();
      assert.equal(r.status, 400);
      const text = await r.text();
      assert.doesNotMatch(text, /hunter2/);
      assert.match(text, /credentials/);
    }
  }
  assert.deepEqual(git(work, 'remote').split('\n'), ['origin']);
  assert.equal(git(work, 'remote', 'get-url', 'origin'), bare);
});

test('add, change and remove a remote; the reach check relays git as it is', async () => {
  const list = await send('GET', '/api/git-remote/gitproj/remotes');
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), { remotes: [{ name: 'origin', url: bare, push_url: null }] });

  // An ssh remote is saved without being contacted when the check is off.
  const ssh = 'git@gitea.example.invalid:team/app.git';
  let r = await send('POST', '/api/git-remote/gitproj/remotes', { name: 'gitea', url: ssh, check: false });
  assert.equal(r.status, 200);
  let body = await r.json() as RemoteChangeBody;
  assert.equal(body.check, null);
  assert.deepEqual(body.remotes.map((x) => [x.name, x.url]), [['gitea', ssh], ['origin', bare]]);
  assert.equal(body.git.remote_count, 2);
  // The publication remote stays the one main tracks.
  assert.equal(body.git.remote_name, 'origin');

  // A second add under the same name is git's own refusal, quoted.
  r = await send('POST', '/api/git-remote/gitproj/remotes', { name: 'gitea', url: ssh, check: false });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /^git remote add failed: .*gitea/);

  // set-url to a path that holds no repository: saved, and the check says why.
  const missing = join(dir, 'nowhere.git');
  r = await send('PATCH', '/api/git-remote/gitproj/remotes/gitea', { url: missing });
  assert.equal(r.status, 200);
  body = await r.json() as RemoteChangeBody;
  assert.equal(git(work, 'remote', 'get-url', 'gitea'), missing);
  assert.equal(body.check?.ok, false);
  assert.match((body.check as { error: string }).error, /nowhere\.git/);

  // set-url to a reachable one: the check passes.
  r = await send('PATCH', '/api/git-remote/gitproj/remotes/gitea', { url: bare });
  body = await r.json() as RemoteChangeBody;
  assert.deepEqual(body.check, { ok: true });

  // An unknown remote is a 400, for both set-url and remove.
  assert.equal((await send('PATCH', '/api/git-remote/gitproj/remotes/ghost', { url: bare })).status, 400);
  assert.equal((await send('DELETE', '/api/git-remote/gitproj/remotes/ghost')).status, 400);

  r = await send('DELETE', '/api/git-remote/gitproj/remotes/gitea');
  assert.equal(r.status, 200);
  body = await r.json() as RemoteChangeBody;
  assert.deepEqual(body.remotes.map((x) => x.name), ['origin']);
  assert.deepEqual(git(work, 'remote').split('\n'), ['origin']);
});

test('a remote configured with credentials outside Timon is shown masked', async () => {
  const other = mkdtempSync(join(tmpdir(), 'timon-git-creds-'));
  execFileSync('git', ['init', '-q', '-b', 'main', other]);
  git(other, 'config', 'user.email', 'test@timon.local');
  git(other, 'config', 'user.name', 'timon-test');
  writeFileSync(join(other, 'a'), 'a');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'first');
  git(other, 'remote', 'add', 'origin', 'https://bob:hunter2-secret@example.invalid/o/r.git');
  writeMeta('credsproj', { cwd: other });
  try {
    const status = await send('GET', '/api/git-remote/credsproj');
    const text = await status.text();
    assert.doesNotMatch(text, /hunter2/);
    assert.equal((JSON.parse(text) as { git: { remote: string } }).git.remote, 'https://***@example.invalid/o/r.git');
    const remotes = await send('GET', '/api/git-remote/credsproj/remotes');
    assert.deepEqual(await remotes.json(), { remotes: [{ name: 'origin', url: 'https://***@example.invalid/o/r.git', push_url: null }] });
    // git quotes the url it failed on: the error relayed is git's, masked.
    const fetched = await send('POST', '/api/git-remote/credsproj/fetch', {});
    assert.equal(fetched.status, 400);
    const error = ((await fetched.json()) as { error: string }).error;
    assert.match(error, /^git fetch failed: /);
    assert.doesNotMatch(error, /hunter2/);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});

// TODO #923: a project folder holding more than one repository.
const multi = mkdtempSync(join(tmpdir(), 'timon-git-multi-'));
const outside = mkdtempSync(join(tmpdir(), 'timon-git-outside-'));
test.after(() => {
  rmSync(multi, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
function initRepo(path: string): void {
  execFileSync('git', ['init', '-q', '-b', 'main', path]);
  git(path, 'config', 'user.email', 'test@timon.local');
  git(path, 'config', 'user.name', 'timon-test');
  writeFileSync(join(path, 'f'), path);
  git(path, 'add', '.');
  git(path, 'commit', '-qm', 'first');
}
initRepo(multi);
// `notes`: ignored by the root. `links/private`: declared in .worktreelinks.
// `tracked`: a repository the root does NOT ignore (left out). `plain`: no repo.
writeFileSync(join(multi, '.gitignore'), 'notes\nlinks/\ntracked-ignored-not\n');
writeFileSync(join(multi, '.worktreelinks'), '# notes repositories\nlinks/private\n../escape\n');
initRepo(join(multi, 'notes'));
mkdirSync(join(multi, 'links'));
initRepo(join(multi, 'links', 'private'));
initRepo(join(multi, 'tracked'));
mkdirSync(join(multi, 'plain'));
git(join(multi, 'notes'), 'checkout', '-q', '-b', 'notes-only');
initRepo(outside);
writeMeta('multiproj', { cwd: multi });

test('repos lists the root, the .worktreelinks repositories and the ignored nested ones', async () => {
  const r = await fetch(`${base}/api/git/repos?slug=multiproj`, { headers: auth });
  assert.equal(r.status, 200);
  const { repos } = await r.json() as { repos: Array<{ path: string; name: string }> };
  assert.deepEqual(repos.map((x) => x.path), ['', 'links/private', 'notes']);
  assert.equal(repos[0]!.name, realpathSync(multi).split(/[\\/]/).pop());
  // A project of a single repository answers the root alone.
  const single = await fetch(`${base}/api/git/repos?slug=gitproj`, { headers: auth });
  assert.deepEqual(((await single.json()) as { repos: Array<{ path: string }> }).repos.map((x) => x.path), ['']);
});

test('every read and gesture takes the repo; without it, the root as before', async () => {
  const dash = async (q: string) => (await (await fetch(`${base}/api/git/status?slug=multiproj${q}`, { headers: auth })).json()) as { currentBranch: string };
  assert.equal((await dash('')).currentBranch, 'main');
  assert.equal((await dash('&repo=notes')).currentBranch, 'notes-only');
  const remote = await fetch(`${base}/api/git-remote/multiproj?repo=notes`, { headers: auth });
  assert.equal(((await remote.json()) as { git: { branch: string } }).git.branch, 'notes-only');
  const rootRemote = await fetch(`${base}/api/git-remote/multiproj`, { headers: auth });
  assert.equal(((await rootRemote.json()) as { git: { branch: string } }).git.branch, 'main');
  const log = await fetch(`${base}/api/git/log?slug=multiproj&repo=${encodeURIComponent('links/private')}`, { headers: auth });
  assert.equal(((await log.json()) as { commits: unknown[] }).commits.length, 1);
  git(join(multi, 'notes'), 'branch', 'side');
  const co = await post('/api/git/checkout', { slug: 'multiproj', branch: 'side', repo: 'notes' });
  assert.equal(co.status, 200);
  assert.equal(git(join(multi, 'notes'), 'branch', '--show-current'), 'side');
  assert.equal(git(multi, 'branch', '--show-current'), 'main', 'the root checkout did not move');
  const remotes = await fetch(`${base}/api/git-remote/multiproj/remotes?repo=notes`, { headers: auth });
  assert.equal(remotes.status, 200);
});

test('a repo outside the project is refused: .., absolute path, symbolic link out', async () => {
  symlinkSync(outside, join(multi, 'out-link'), 'dir');
  const bad = ['../x', '..', 'notes/../..', join(outside), '/etc', 'C:\\Windows', '\\\\server\\share', ''];
  for (const repo of bad) {
    const q = `slug=multiproj&repo=${encodeURIComponent(repo)}`;
    for (const path of [`/api/git/status?${q}`, `/api/git/log?${q}`, `/api/git/worktrees?${q}`]) {
      const r = await fetch(`${base}${path}`, { headers: auth });
      assert.equal(r.status, 400, `${path}`);
    }
    const remote = await fetch(`${base}/api/git-remote/multiproj?repo=${encodeURIComponent(repo)}`, { headers: auth });
    assert.equal(remote.status, 400, `remote ${repo}`);
    const co = await post('/api/git/checkout', { slug: 'multiproj', branch: 'main', repo });
    assert.equal(co.status, 400, `checkout ${repo}`);
  }
  // Clean as text, but leaves the project on disk: refused, and never read.
  for (const path of [
    '/api/git/status?slug=multiproj&repo=out-link',
    '/api/git-remote/multiproj?repo=out-link',
    '/api/git-remote/multiproj/remotes?repo=out-link',
    '/api/agents/gitagent/git?slug=multiproj&repo=out-link',
  ]) {
    const r = await fetch(`${base}${path}`, { headers: auth });
    assert.equal(r.status, 400, path);
    assert.ok(!(await r.text()).includes(outside), `${path} echoes the outside path`);
  }
  const push = await post('/api/git-remote/multiproj/push?repo=out-link', {});
  assert.equal(push.status, 400);
  // A folder that does not exist is no repository of the project either.
  assert.equal((await fetch(`${base}/api/git/status?slug=multiproj&repo=missing`, { headers: auth })).status, 400);
  // The link is not offered by the discovery.
  const { repos } = await (await fetch(`${base}/api/git/repos?slug=multiproj`, { headers: auth })).json() as { repos: Array<{ path: string }> };
  assert.ok(!repos.some((x) => x.path === 'out-link'));
});

test('a repo without its project, on the agent read, is a 400', async () => {
  const r = await fetch(`${base}/api/agents/gitagent/git?repo=notes`, { headers: auth });
  assert.equal(r.status, 400);
});

test('the repos route refuses an anonymous caller, even when the middleware lets it through', async () => {
  assert.equal((await fetch(`${base}/api/git/repos?slug=multiproj`)).status, 401);
  const r = await fetch(`${openBase}/api/git/repos?slug=multiproj`);
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'unauthorized' });
});

// A repository with two remotes: `origin`, which `main` tracks, and an empty
// `mirror`. The push can target either; only `origin` stays the upstream.
const two = mkdtempSync(join(tmpdir(), 'timon-git-two-remotes-'));
const twoOrigin = join(two, 'origin.git');
const twoMirror = join(two, 'mirror.git');
const twoWork = join(two, 'work');
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', twoOrigin]);
execFileSync('git', ['init', '-q', '--bare', '-b', 'main', twoMirror]);
initRepo(twoWork);
git(twoWork, 'remote', 'add', 'origin', twoOrigin);
git(twoWork, 'push', '-q', '-u', 'origin', 'main');
git(twoWork, 'remote', 'add', 'mirror', twoMirror);
writeFileSync(join(twoWork, 'g'), 'second');
git(twoWork, 'add', '.');
git(twoWork, 'commit', '-qm', 'second');
writeMeta('twoproj', { cwd: twoWork });
test.after(() => { rmSync(two, { recursive: true, force: true }); });

type Target = { name: string; url: string | null; branches: Array<{ name: string; published: boolean; ahead: number | null }> };
type TwoStatus = { git: { ahead: number; upstream: string; remote_name: string; remotes: Target[] } };

test('the status counts what each remote lacks; a branch absent from one says so', async () => {
  const r = await fetch(`${base}/api/git-remote/twoproj`, { headers: auth });
  assert.equal(r.status, 200);
  const { git: s } = await r.json() as TwoStatus;
  assert.equal(s.remote_name, 'origin');
  assert.deepEqual(s.remotes, [
    { name: 'mirror', url: twoMirror, web: null, branches: [{ name: 'main', published: false, ahead: null }] },
    { name: 'origin', url: twoOrigin, web: null, branches: [{ name: 'main', published: true, ahead: 1 }] },
  ]);
});

test('push to a second remote publishes there and leaves the upstream alone', async () => {
  const originHead = git(twoOrigin, 'rev-parse', 'refs/heads/main');
  const r = await post('/api/git-remote/twoproj/push', { branch: 'main', remote: 'mirror' });
  assert.equal(r.status, 200);
  const { git: s } = await r.json() as TwoStatus;
  assert.equal(git(twoMirror, 'rev-parse', 'refs/heads/main'), git(twoWork, 'rev-parse', 'HEAD'));
  assert.equal(git(twoOrigin, 'rev-parse', 'refs/heads/main'), originHead, 'origin did not move');
  assert.equal(git(twoWork, 'rev-parse', '--abbrev-ref', 'main@{upstream}'), 'origin/main');
  assert.equal(s.upstream, 'origin/main');
  assert.equal(s.ahead, 1, 'still one commit to push to the upstream');
  assert.deepEqual(s.remotes.map((t) => [t.name, t.branches[0]]), [
    ['mirror', { name: 'main', published: true, ahead: 0 }],
    ['origin', { name: 'main', published: true, ahead: 1 }],
  ]);
  // Naming the upstream itself is the historical push.
  const up = await post('/api/git-remote/twoproj/push', { remote: 'origin' });
  assert.equal(up.status, 200);
  assert.equal(git(twoOrigin, 'rev-parse', 'refs/heads/main'), git(twoWork, 'rev-parse', 'HEAD'));
});

test('push refuses a remote the repository does not declare, or a malformed one', async () => {
  const before = git(twoMirror, 'for-each-ref', '--format=%(refname) %(objectname)');
  const unknown = await post('/api/git-remote/twoproj/push', { branch: 'main', remote: 'elsewhere' });
  assert.equal(unknown.status, 400);
  assert.match((await unknown.json() as { error: string }).error, /remote "elsewhere" not found/);
  for (const remote of ['--force', '-u', '../x', '', 'a b', 7]) {
    const r = await post('/api/git-remote/twoproj/push', { branch: 'main', remote });
    assert.equal(r.status, 400, `remote ${JSON.stringify(remote)}`);
  }
  assert.equal(git(twoMirror, 'for-each-ref', '--format=%(refname) %(objectname)'), before);
});

test('push to a named remote refuses an anonymous caller and an account without projects:manage', async () => {
  writeFileSync(join(twoWork, 'h'), 'third');
  git(twoWork, 'add', '.');
  git(twoWork, 'commit', '-qm', 'third');
  const before = git(twoMirror, 'rev-parse', 'refs/heads/main');
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ remote: 'mirror' }) };
  assert.equal((await fetch(`${base}/api/git-remote/twoproj/push`, init)).status, 401);
  const anon = await fetch(`${openBase}/api/git-remote/twoproj/push`, init);
  assert.equal(anon.status, 401);
  assert.deepEqual(await anon.json(), { error: 'unauthorized' });
  assert.equal((await send('POST', '/api/git-remote/twoproj/push', { remote: 'mirror' }, readerBase)).status, 403);
  assert.equal(git(twoMirror, 'rev-parse', 'refs/heads/main'), before, 'nothing went out');
});

test('a named remote works on a nested repository too', async () => {
  const notes = join(multi, 'notes');
  const a = join(two, 'notes-a.git');
  const b = join(two, 'notes-b.git');
  execFileSync('git', ['init', '-q', '--bare', a]);
  execFileSync('git', ['init', '-q', '--bare', b]);
  git(notes, 'remote', 'add', 'a', a);
  git(notes, 'remote', 'add', 'b', b);
  const branch = git(notes, 'branch', '--show-current');
  const r = await post('/api/git-remote/multiproj/push?repo=notes', { remote: 'b' });
  assert.equal(r.status, 200);
  assert.equal(git(b, 'rev-parse', `refs/heads/${branch}`), git(notes, 'rev-parse', 'HEAD'));
  assert.equal(git(a, 'for-each-ref'), '', 'the first remote received nothing');
  assert.equal(git(notes, 'config', '--default', '', '--get', `branch.${branch}.remote`), '', 'no upstream was set');
  // The root repository has no such remote.
  assert.equal((await post('/api/git-remote/multiproj/push', { remote: 'b' })).status, 400);
});
