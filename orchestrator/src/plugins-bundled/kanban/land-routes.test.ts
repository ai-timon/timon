/**
 * The landing gesture of a job kept on its branch
 * (`POST /api/kanban/landings/:id/land`, `integration-land.ts`), on real
 * temporary repositories: fast-forward, merge commit, target checked out
 * clean and dirty, conflict, a second call, a job that opens its pull request
 * (forge stubbed), and the access rules.
 *
 * `npm test -- src/plugins-bundled/kanban/land-routes.test.ts`
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi, type IntegrationRow } from '../../db.js';
import type { Forge, GitTransport } from '../../host/forge.js';
import { updateProjectIntegration } from '../../project-integration.js';
import { registerLandingRoutes } from './landing-routes.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-land-routes-')));
after(() => rmSync(root, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe', encoding: 'utf8' }).trim();
}

function commit(repo: string, file: string, text: string, message: string): string {
  writeFileSync(join(repo, file), text);
  git(repo, 'add', file);
  git(repo, 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima'];
let n = 0;

type Job = { repo: string; branch: string; row: IntegrationRow; seriesId: string; codeId: string; project: string };

/**
 * A repository with `main` and the job's branch one commit ahead of it, the
 * job's DONE code task and its integration row. `main` stays checked out in
 * the repository unless `detached`.
 */
function job(opts: { pr?: boolean; detached?: boolean; todo?: number } = {}): Job {
  const word = WORDS[n++ % WORDS.length]!;
  const repo = join(root, `repo-${n}`);
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Acme Bot');
  git(repo, 'config', 'user.email', 'bot@acme.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), '/docs\n');
  git(repo, 'add', '.gitignore');
  commit(repo, 'a.txt', 'a\n', 'chore: start');
  const branch = `feat/${word}-${n}`;
  git(repo, 'checkout', '-q', '-b', branch);
  commit(repo, 'b.txt', 'b\n', `feat: add b for ${word}`);
  git(repo, 'checkout', '-q', 'main');
  if (opts.detached) git(repo, 'checkout', '-q', '--detach');
  const project = `land-${word}-${n}`;
  dbApi.upsertProject(project, { cwd: repo });
  if (opts.pr) {
    git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    git(repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    updateProjectIntegration(project, { mode: 'pr', account: 'ai-bot', remote_url: 'git@github.com:acme/app.git' });
  }
  const seriesId = randomUUID();
  const codeId = randomUUID();
  dbApi.createTask(codeId, `Add b ${word}`, 'acme.coder', {
    type: 'code', project, baseBranch: branch, integrationMode: opts.pr ? 'pr' : 'branch',
    baseRef: opts.pr ? 'origin/main' : 'refs/heads/main', seriesId, ownerUserId: 'owner-a', pipeline: 'code-self',
  });
  if (opts.todo) dbApi.setTaskTodoId(codeId, opts.todo);
  dbApi.setTaskMergedSha(codeId, git(repo, 'rev-parse', branch));
  dbApi.updateTaskStatus(codeId, 'DONE', { doneComment: `merged into ${branch}` });
  const row = dbApi.recordIntegration({
    repo, branch, remote: opts.pr ? 'origin' : '', target: 'main', mode: opts.pr ? 'pr' : 'branch', project, seriesId,
  });
  return { repo, branch, row, seriesId, codeId, project };
}

const told: string[] = [];
const forgeCalls = { push: 0, created: 0 };
const forge: Forge = {
  async login() { return { ok: true, login: 'ai-bot' }; },
  async createPullRequest() {
    forgeCalls.created += 1;
    return { ok: true, pr: { number: 31, url: 'https://github.com/acme/app/pull/31' }, existing: false };
  },
};
const transport: GitTransport = {
  async remoteBranchSha() { return { ok: true, sha: null }; },
  async fetchBranch() { return { ok: true }; },
  async pushBranch() { forgeCalls.push += 1; return { ok: true }; },
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
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'owner-a', permissions: ['kanban:read', 'kanban:write'] };
  } else if (who === 'stranger') {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'owner-b', permissions: ['kanban:read', 'projects:manage'] };
  }
  next();
});
registerLandingRoutes(app, {
  forge: () => ({ ...forge, pullRequestChecks: async () => ({ ok: false, code: 'gh_failed', reason: 'stub' }) }) as never,
  transport: () => transport,
  publicTree: async () => ({ ran: true, ok: true, summary: 'Blockers: 0' }),
  notify: (id, outcome) => { told.push(`${id}:${outcome}`); return true; },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Answer = Record<string, unknown> & { code?: string; landing?: { state: string; merge_sha: string | null } };

async function land(id: string, who: Who, body: unknown = {}): Promise<{ status: number; json: Answer }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  const res = await fetch(`${base}/api/kanban/landings/${id}/land`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Answer };
}

const sha = (repo: string, ref: string): string => git(repo, 'rev-parse', ref);

test('anonymous 401, without projects:manage 403, another owner 404: nothing moves', async () => {
  const j = job({ detached: true });
  const before = sha(j.repo, 'main');
  assert.equal((await land(j.row.id, 'anonymous')).status, 401);
  const reader = await land(j.row.id, 'owner-reader');
  assert.equal(reader.status, 403);
  const stranger = await land(j.row.id, 'stranger');
  assert.equal(stranger.status, 404);
  assert.equal(stranger.json.code, 'landing_not_found');
  // Its series, named instead of the job: just as unknown.
  assert.equal((await land(j.seriesId, 'stranger')).status, 404);
  assert.equal(sha(j.repo, 'main'), before);
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
});

test('an unknown field is refused before anything moves', async () => {
  const j = job({ detached: true });
  const out = await land(j.row.id, 'owner', { force: true });
  assert.equal(out.status, 400);
  assert.equal(out.json.code, 'landing_request_invalid');
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
});

test('fast-forward: main moves by reference to the branch, the idea closes, a second call moves nothing', async () => {
  const todo = dbApi.insertProjectTodo({ text: `kept job ${randomUUID()}`, project: 'land-todo', ownerUserId: 'owner-a' });
  const j = job({ detached: true, todo: todo.id });
  const head = sha(j.repo, j.branch);
  const userHead = sha(j.repo, 'HEAD');
  const first = await land(j.row.id, 'owner');
  assert.equal(first.status, 200, JSON.stringify(first.json));
  assert.equal(first.json.outcome, 'merged');
  assert.equal(first.json.move, 'fast_forward');
  assert.equal(first.json.merge_sha, head);
  assert.equal(sha(j.repo, 'main'), head);
  // The user's detached position is untouched.
  assert.equal(sha(j.repo, 'HEAD'), userHead);
  assert.equal(first.json.landing?.state, 'merged');
  const row = dbApi.getIntegrationById(j.row.id)!;
  assert.equal(row.state, 'merged');
  assert.ok(row.landed_at !== null);
  assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'done');
  assert.ok(told.includes(`${j.row.id}:merged`));

  const second = await land(j.row.id, 'owner');
  assert.equal(second.status, 200);
  assert.equal(second.json.already, true);
  assert.equal(second.json.move, 'already');
  assert.equal(sha(j.repo, 'main'), head);
  assert.equal(told.filter((t) => t === `${j.row.id}:merged`).length, 1);
});

test('diverged: a merge commit with main as first parent, written without a working tree', async () => {
  const j = job({ detached: true });
  git(j.repo, 'checkout', '-q', 'main');
  const mainTip = commit(j.repo, 'c.txt', 'c\n', 'chore: add c');
  git(j.repo, 'checkout', '-q', '--detach');
  const head = sha(j.repo, j.branch);
  const worktreesBefore = git(j.repo, 'worktree', 'list', '--porcelain');
  const out = await land(j.row.id, 'daemon');
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.move, 'merge_commit');
  const merged = sha(j.repo, 'main');
  assert.equal(out.json.merge_sha, merged);
  assert.equal(git(j.repo, 'rev-parse', `${merged}^1`), mainTip);
  assert.equal(git(j.repo, 'rev-parse', `${merged}^2`), head);
  assert.equal(git(j.repo, 'log', '-1', '--format=%s', merged), `merge: integrate ${j.branch} into main`);
  assert.equal(git(j.repo, 'log', '-1', '--format=%an <%ae>', merged), 'Acme Bot <bot@acme.test>');
  assert.equal(git(j.repo, 'show', `${merged}:b.txt`), 'b');
  assert.equal(git(j.repo, 'worktree', 'list', '--porcelain'), worktreesBefore);
  assert.equal(dbApi.getIntegrationById(j.row.id)?.merge_sha, merged);
});

test('main checked out and clean: the fast-forward goes through its working directory', async () => {
  const j = job();
  // A diverged main too: the merge commit is fast-forwarded there.
  const mainTip = commit(j.repo, 'c.txt', 'c\n', 'chore: add c');
  const out = await land(j.row.id, 'owner');
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(git(j.repo, 'branch', '--show-current'), 'main');
  assert.equal(sha(j.repo, 'HEAD'), sha(j.repo, 'main'));
  assert.equal(git(j.repo, 'rev-parse', 'main^1'), mainTip);
  assert.equal(readFileSync(join(j.repo, 'b.txt'), 'utf8'), 'b\n');
  assert.equal(git(j.repo, 'status', '--porcelain'), '');
});

test('main checked out with changes: refused, nothing moves, the changes stay', async () => {
  const j = job();
  writeFileSync(join(j.repo, 'a.txt'), 'edited by the user\n');
  const before = sha(j.repo, 'main');
  const out = await land(j.row.id, 'owner');
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'landing_target_dirty');
  assert.doesNotMatch(String(out.json.error), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(sha(j.repo, 'main'), before);
  assert.equal(readFileSync(join(j.repo, 'a.txt'), 'utf8'), 'edited by the user\n');
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
  // An untracked file is a change too.
  git(j.repo, 'checkout', '-q', '--', 'a.txt');
  writeFileSync(join(j.repo, 'notes.txt'), 'mine\n');
  assert.equal((await land(j.row.id, 'owner')).json.code, 'landing_target_dirty');
  assert.equal(sha(j.repo, 'main'), before);
});

test('a conflict is refused with its files, never resolved', async () => {
  const j = job({ detached: true });
  git(j.repo, 'checkout', '-q', j.branch);
  commit(j.repo, 'a.txt', 'from the branch\n', 'feat: change a');
  git(j.repo, 'checkout', '-q', 'main');
  commit(j.repo, 'a.txt', 'from main\n', 'chore: change a');
  git(j.repo, 'checkout', '-q', '--detach');
  const before = sha(j.repo, 'main');
  const out = await land(j.row.id, 'owner');
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'landing_conflict');
  assert.deepEqual(out.json.files, ['a.txt']);
  assert.match(String(out.json.error), /a\.txt/);
  assert.equal(sha(j.repo, 'main'), before);
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
});

test('a branch main already holds lands without moving anything', async () => {
  const j = job({ detached: true });
  git(j.repo, 'branch', '-f', 'main', j.branch);
  const out = await land(j.row.id, 'owner');
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.move, 'none');
  assert.equal(out.json.merge_sha, sha(j.repo, j.branch));
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'merged');
});

test('a job with a task still waiting is refused', async () => {
  const j = job({ detached: true });
  dbApi.createTask(randomUUID(), 'Another part', 'acme.coder', {
    type: 'code', project: j.project, seriesId: j.seriesId, ownerUserId: 'owner-a',
  });
  const out = await land(j.row.id, 'owner');
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'landing_job_running');
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
});

test('the series names its only job', async () => {
  const j = job({ detached: true });
  const out = await land(j.seriesId, 'owner');
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(sha(j.repo, 'main'), sha(j.repo, j.branch));
});

test('a job of a pull request project: its pull request opens, nothing merges here', async () => {
  const j = job({ pr: true, detached: true });
  const before = sha(j.repo, 'main');
  const untitled = await land(j.row.id, 'owner');
  assert.equal(untitled.status, 400);
  assert.equal(untitled.json.code, 'landing_refused');
  assert.equal(forgeCalls.push, 0);

  const out = await land(j.row.id, 'owner', { title: 'Add b to the app', body: 'Adds b, because c needed it.' });
  assert.equal(out.status, 200, JSON.stringify(out.json));
  assert.equal(out.json.outcome, 'pull_request');
  assert.equal(out.json.pr_url, 'https://github.com/acme/app/pull/31');
  assert.equal(forgeCalls.push, 1);
  assert.equal(forgeCalls.created, 1);
  assert.equal(sha(j.repo, 'main'), before);
  const row = dbApi.getIntegrationById(j.row.id)!;
  assert.equal(row.state, 'open');
  assert.equal(row.landed_at, null);

  // Again: the pull request is already open, nothing is pushed twice.
  const again = await land(j.row.id, 'owner', { title: 'Add b to the app' });
  assert.equal(again.status, 200);
  assert.equal(again.json.already, true);
  assert.equal(forgeCalls.push, 1);
});

test('the pull request\'s own pre-checks still refuse: an id in the title', async () => {
  const j = job({ pr: true, detached: true });
  const out = await land(j.row.id, 'owner', { title: `Add b ${j.codeId}` });
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'pr_precheck_failed');
  assert.equal(dbApi.getIntegrationById(j.row.id)?.state, 'branch');
});

test('an embargoed branch of a pull request project is refused', async () => {
  const j = job({ detached: true });
  const sec = dbApi.recordIntegration({
    repo: j.repo, branch: 'sec/fix-for-land', remote: 'origin', target: 'main', mode: 'branch', project: j.project, seriesId: j.seriesId,
  });
  const out = await land(sec.id, 'owner');
  assert.equal(out.status, 409);
  assert.equal(out.json.code, 'landing_refused');
});

test('a job of a project that merges locally is listed, and previewed against its local target', async () => {
  const j = job({ detached: true });
  const headers = { 'content-type': 'application/json', 'x-test-who': 'owner' };
  const list = await (await fetch(`${base}/api/kanban/landings?project=${j.project}`, { headers })).json() as {
    landings: Array<{ id: string; remote: string; state: string; mode: string }>;
  };
  assert.deepEqual(list.landings.map((l) => [l.id, l.remote, l.mode, l.state]), [[j.row.id, '', 'branch', 'branch']]);
  const preview = await (await fetch(`${base}/api/kanban/landings/${j.row.id}/preview`, { method: 'POST', headers, body: '{}' })).json() as {
    problem: string | null; commit_count: number; target_sha: string | null; conflict: { state: string };
  };
  assert.equal(preview.problem, null);
  assert.equal(preview.target_sha, sha(j.repo, 'main'));
  assert.equal(preview.commit_count, 1);
  assert.equal(preview.conflict.state, 'clean');
});

test('a job the planner kept on its branch says so, with what still runs and its last merge', async () => {
  const j = job({ detached: true });
  const headers = { 'content-type': 'application/json', 'x-test-who': 'owner' };
  type Kept = { kept: boolean; finish: string | null; under_way: number; last_merge: { sha: string; at: number } | null };
  const read = async (): Promise<Kept> => (await (await fetch(`${base}/api/kanban/landings/${j.row.id}`, { headers })).json() as { landing: Kept }).landing;

  // No choice recorded: not kept, the gesture is not offered.
  const plain = await read();
  assert.deepEqual([plain.kept, plain.finish, plain.under_way, plain.last_merge], [false, null, 0, null]);

  dbApi.setSeriesPlanLanding(j.seriesId, {
    project: j.project, repo: j.repo, branch: j.branch, branch_kind: 'new', mode: 'branch', base_ref: 'refs/heads/main', finish: 'keep',
  });
  const kept = await read();
  assert.equal(kept.kept, true);
  assert.equal(kept.finish, 'keep');
  assert.equal(kept.under_way, 0);
  assert.equal(kept.last_merge?.sha, sha(j.repo, j.branch));
  assert.equal(typeof kept.last_merge?.at, 'number');

  dbApi.createTask(randomUUID(), 'Another part', 'acme.coder', {
    type: 'code', project: j.project, seriesId: j.seriesId, ownerUserId: 'owner-a',
  });
  assert.equal((await read()).under_way, 1);

  // The list carries the same fields.
  const list = await (await fetch(`${base}/api/kanban/landings?project=${j.project}`, { headers })).json() as { landings: Kept[] };
  assert.equal(list.landings[0]?.kept, true);
  assert.equal(list.landings[0]?.under_way, 1);
});

test('a job that merges at its end is not kept', async () => {
  const j = job({ detached: true });
  dbApi.setSeriesPlanLanding(j.seriesId, {
    project: j.project, repo: j.repo, branch: j.branch, branch_kind: 'new', mode: 'branch', base_ref: 'refs/heads/main', finish: 'merge',
  });
  const headers = { 'x-test-who': 'owner' };
  const view = (await (await fetch(`${base}/api/kanban/landings/${j.row.id}`, { headers })).json() as { landing: { kept: boolean; finish: string } }).landing;
  assert.equal(view.kept, false);
  assert.equal(view.finish, 'merge');
});
