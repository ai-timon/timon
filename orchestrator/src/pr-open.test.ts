/**
 * `timon pr open`: every pre-check refuses on its own, nothing is pushed while
 * one fails, a branch under embargo is never pushed, and an accepted request
 * pushes without force then records the pull request.
 *
 * A real throwaway repository for what git answers locally; the forge (gh)
 * and the network side of git are stand-ins: nothing here reaches GitHub, and
 * nothing is pushed anywhere.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { dbApi } from './db.js';
import type { Forge, GitTransport } from './host/forge.js';
import type { GhLoginOutcome } from './host/gh.js';
import { leakProblems, openPullRequest, type PrOpenDeps, type PublicTreeOutcome } from './pr-open.js';
import { withoutClosingKeywords } from './issue-closing.js';
import { updateProjectIntegration } from './project-integration.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-pr-open-')));
after(() => rmSync(root, { recursive: true, force: true }));
const REMOTE_URL = 'git@github.com:acme/app.git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function commit(cwd: string, file: string, message: string, opts: { force?: boolean } = {}): string {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), `${message}\n`);
  git(cwd, 'add', ...(opts.force ? ['-f'] : []), file);
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

type Fixture = { repo: string; branch: string; taskId: string; seriesId: string; slug: string; integrationId: string };

let counter = 0;

/** A repository whose `origin/main` is the base and `feat/topic` one commit
 *  ahead of it, a project in `pr` mode and the task and integration row the
 *  dispatcher would have recorded. */
function fixture(opts: { branch?: string; mode?: 'pr' | 'branch' | 'local' } = {}): Fixture {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'Acme Bot');
  git(repo, 'config', 'user.email', 'bot@acme.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, '.gitignore'), '/docs\n');
  git(repo, 'add', '.gitignore');
  git(repo, 'commit', '-q', '-m', 'chore: start');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'remote', 'add', 'origin', REMOTE_URL);
  const branch = opts.branch ?? 'feat/topic';
  git(repo, 'checkout', '-q', '-b', branch);
  commit(repo, 'src/x.ts', 'feat(x): add x');
  git(repo, 'checkout', '-q', 'main');

  const slug = `acme-${counter}`;
  dbApi.upsertProject(slug, { cwd: repo });
  updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', remote_url: REMOTE_URL });
  const taskId = randomUUID();
  const seriesId = randomUUID();
  const mode = opts.mode ?? 'pr';
  dbApi.createTask(taskId, 'Add x', 'acme.coder', {
    type: 'code', project: slug, baseBranch: branch, integrationMode: mode, baseRef: 'origin/main', seriesId,
  });
  const row = dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode, project: slug, seriesId });
  return { repo, branch, taskId, seriesId, slug, integrationId: row.id };
}

type Calls = { login: number; push: string[]; created: Array<{ base: string; head: string; title: string; body: string; repo: string }>; fetched: string[] };

let login: GhLoginOutcome;
let remoteSha: string | null;
let publicTree: PublicTreeOutcome;
let calls: Calls;

beforeEach(() => {
  login = { ok: true, login: 'AI-Bot' };
  remoteSha = null;
  publicTree = { ran: true, ok: true, summary: 'Blockers: 0' };
  calls = { login: 0, push: [], created: [], fetched: [] };
});

function deps(repo: string): PrOpenDeps {
  const forge: Forge = {
    async login() { calls.login += 1; return login; },
    async createPullRequest(input) {
      calls.created.push(input);
      return { ok: true, pr: { number: 12, url: 'https://github.com/acme/app/pull/12' }, existing: false };
    },
  };
  const transport: GitTransport = {
    async remoteBranchSha() { return { ok: true, sha: remoteSha }; },
    async fetchBranch(_url, branch) { calls.fetched.push(branch); return { ok: true }; },
    async pushBranch(url, branch) { calls.push.push(`${url} ${branch}`); return { ok: true }; },
  };
  return {
    forge: () => forge,
    transport: () => transport,
    publicTree: async () => publicTree,
    agentCwd: () => repo,
  };
}

const REQUEST = { title: 'Add x to the app', body: 'Adds x, because y needed it.' };

function failedChecks(out: Awaited<ReturnType<typeof openPullRequest>>): string[] {
  assert.equal(out.ok, false);
  return out.ok ? [] : (out.checks ?? []).filter((c) => !c.ok).map((c) => c.name);
}

test('every check passes: the branch is pushed without force, the pull request opened and recorded', async () => {
  const f = fixture();
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.ok(out.ok);
  assert.equal(out.pr.number, 12);
  assert.equal(out.repository, 'acme/app');
  assert.deepEqual(calls.push, [`${REMOTE_URL} ${f.branch}`]);
  assert.deepEqual(calls.created, [{ repo: 'acme/app', base: 'main', head: f.branch, ...REQUEST }]);
  const row = dbApi.getIntegration(f.repo, f.branch);
  assert.equal(row?.state, 'open');
  assert.equal(row?.pr_number, 12);
  assert.equal(row?.pr_url, 'https://github.com/acme/app/pull/12');
  assert.equal(row?.head_sha, git(f.repo, 'rev-parse', f.branch));
  // A second call does not open another one.
  const again = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.equal(again.ok, false);
  assert.equal(calls.push.length, 1);
});

test('the series id finds the same branch', async () => {
  const f = fixture();
  const out = await openPullRequest({ target: 'series', id: f.seriesId, ...REQUEST }, deps(f.repo));
  assert.equal(out.ok, true, JSON.stringify(out));
});

test('gh signed in as another account: refused, nothing pushed', async () => {
  const f = fixture();
  login = { ok: true, login: 'someone-else' };
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.deepEqual(failedChecks(out), ['account']);
  assert.equal(out.ok ? '' : out.code, 'pr_precheck_failed');
  assert.deepEqual(calls.push, []);
  assert.deepEqual(calls.created, []);
  assert.equal(dbApi.getIntegration(f.repo, f.branch)?.state, 'branch');
});

test('gh that cannot answer is a refusal too', async () => {
  const f = fixture();
  login = { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['account']);
  assert.deepEqual(calls.push, []);
});

test('a remote pushing elsewhere than the expected URL: refused', async () => {
  const f = fixture();
  git(f.repo, 'remote', 'set-url', '--push', 'origin', 'git@github.com:someone/fork.git');
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['remote_url']);
  assert.deepEqual(calls.push, []);
});

test('a commit by another identity than the repository\'s: refused, never rewritten', async () => {
  const f = fixture();
  git(f.repo, 'checkout', '-q', f.branch);
  execFileSync('git', ['-c', 'user.name=Someone', '-c', 'user.email=someone@else.test', 'commit', '-q', '--allow-empty', '-m', 'fix(x): tidy'], { cwd: f.repo });
  const tip = git(f.repo, 'rev-parse', 'HEAD');
  git(f.repo, 'checkout', '-q', 'main');
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['commit_identity']);
  assert.equal(git(f.repo, 'rev-parse', f.branch), tip, 'the branch is left as it was');
  assert.deepEqual(calls.push, []);
});

test('a repository with no identity configured: refused', async () => {
  const f = fixture();
  git(f.repo, 'config', '--unset', 'user.email');
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.ok(failedChecks(out).includes('commit_identity'));
  assert.deepEqual(calls.push, []);
});

test('a task id or a TODO number in a commit message: refused', async () => {
  for (const message of [`fix(x): close ${randomUUID()}`, 'fix(x): close TODO #976']) {
    const f = fixture();
    git(f.repo, 'checkout', '-q', f.branch);
    commit(f.repo, 'src/y.ts', message);
    git(f.repo, 'checkout', '-q', 'main');
    assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['commit_messages'], message);
  }
  assert.deepEqual(calls.push, []);
});

test('the short form of a task id of the job in a message: refused', async () => {
  const f = fixture();
  git(f.repo, 'checkout', '-q', f.branch);
  commit(f.repo, 'src/y.ts', `fix(x): follow up on ${f.taskId.slice(0, 8)}`);
  git(f.repo, 'checkout', '-q', 'main');
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['commit_messages']);
});

test('an id, a TODO number or an attribution in the title or the description: refused', async () => {
  const f = fixture();
  for (const request of [
    { title: 'Close TODO #12', body: '' },
    { title: 'Add x', body: `Task ${randomUUID()}` },
    { title: 'Add x', body: 'Done.\n\nCo-Authored-By: A Tool <tool@example.com>' },
    { title: 'Add x', body: 'Generated with a tool' },
  ]) {
    assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...request }, deps(f.repo))), ['pr_text'], JSON.stringify(request));
  }
  assert.deepEqual(calls.push, []);
});

test('a file of docs/ in the diff (ignored by the repository, force-added): refused', async () => {
  const f = fixture();
  git(f.repo, 'checkout', '-q', f.branch);
  commit(f.repo, 'docs/notes.md', 'docs(x): add notes', { force: true });
  git(f.repo, 'checkout', '-q', 'main');
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.deepEqual(failedChecks(out), ['private_paths']);
  assert.ok(!out.ok && /docs\//.test(out.reason));
  assert.deepEqual(calls.push, []);
});

test('the public tree check finds a blocker: refused', async () => {
  const f = fixture();
  publicTree = { ran: true, ok: false, summary: 'Blockers: 2' };
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['public_tree']);
  assert.deepEqual(calls.push, []);
});

test('no public tree script: the check is skipped and says so', async () => {
  const f = fixture();
  publicTree = { ran: false };
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.ok(out.ok);
  const check = out.checks.find((c) => c.name === 'public_tree');
  assert.equal(check?.skipped, true);
  assert.match(check?.detail ?? '', /check-public-tree\.mjs is absent.*skipped/);
});

test('the repository\'s own public tree script runs on the branch and its blockers refuse', async () => {
  const f = fixture();
  mkdirSync(join(f.repo, 'docs', 'oss'), { recursive: true });
  writeFileSync(join(f.repo, 'docs', 'oss', 'check-public-tree.mjs'),
    "const ref = process.argv[process.argv.indexOf('--ref') + 1];\n" +
    "console.log(`${ref}: 2 tracked files`);\nconsole.log('\\nBlockers: 1');\nprocess.exit(1);\n");
  const { publicTree: _stub, ...real } = deps(f.repo);
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, real)), ['public_tree']);
  writeFileSync(join(f.repo, 'docs', 'oss', 'check-public-tree.mjs'), "console.log('Blockers: 0');\n");
  const ok = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, real);
  assert.equal(ok.ok, true, JSON.stringify(ok));
});

test('a remote branch that moved on its own is never overwritten', async () => {
  const f = fixture();
  // A commit the local branch does not contain stands for the remote's tip.
  git(f.repo, 'checkout', '-q', '-b', 'elsewhere', 'main');
  remoteSha = commit(f.repo, 'z.txt', 'chore: elsewhere');
  git(f.repo, 'checkout', '-q', 'main');
  assert.deepEqual(failedChecks(await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))), ['remote_branch']);
  assert.deepEqual(calls.push, []);
});

test('a remote branch the local one contains is pushed forward', async () => {
  const f = fixture();
  remoteSha = git(f.repo, 'rev-parse', f.branch);
  git(f.repo, 'checkout', '-q', f.branch);
  commit(f.repo, 'src/y.ts', 'feat(x): more');
  git(f.repo, 'checkout', '-q', 'main');
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.equal(out.ok, true, JSON.stringify(out));
});

test('a branch under embargo (sec/) is never pushed, before any network call', async () => {
  const f = fixture({ branch: 'sec/fix-auth' });
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.code, 'pr_refused');
  assert.match(out.ok ? '' : out.reason, /embargo/);
  assert.equal(calls.login, 0);
  assert.deepEqual(calls.fetched, []);
  assert.deepEqual(calls.push, []);
});

test('a job that lands locally or by hand is refused', async () => {
  for (const mode of ['local', 'branch'] as const) {
    const f = fixture({ mode });
    const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
    assert.equal(out.ok ? '' : out.code, 'pr_refused', mode);
  }
  assert.deepEqual(calls.push, []);
});

test('a project without a push URL or in local mode is refused before any check', async () => {
  const f = fixture();
  updateProjectIntegration(f.slug, { remote_url: null });
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.match(out.ok ? '' : out.reason, /remote_url/);
  updateProjectIntegration(f.slug, { remote_url: REMOTE_URL, mode: 'local' });
  assert.equal((await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo))).ok, false);
  assert.equal(calls.login, 0);
  assert.deepEqual(calls.push, []);
});

test('an unknown id is not found, as a task or as a series', async () => {
  for (const target of ['task', 'series'] as const) {
    const out = await openPullRequest({ target, id: randomUUID(), ...REQUEST }, deps(root));
    assert.equal(out.ok ? 0 : out.status, 404, target);
    assert.equal(out.ok ? '' : out.code, 'pr_target_not_found');
  }
});

test('a task id is not looked up as a series, nor a series id as a task', async () => {
  const f = fixture();
  assert.equal((await openPullRequest({ target: 'series', id: f.taskId, ...REQUEST }, deps(f.repo))).ok, false);
  assert.equal((await openPullRequest({ target: 'task', id: f.seriesId, ...REQUEST }, deps(f.repo))).ok, false);
  assert.deepEqual(calls.push, []);
});

test('a push the remote rejects is reported and nothing is recorded', async () => {
  const f = fixture();
  const d = deps(f.repo);
  const base = d.transport!(f.repo);
  d.transport = () => ({ ...base, pushBranch: async () => ({ ok: false, code: 'rejected', reason: 'non-fast-forward' }) });
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, d);
  assert.equal(out.ok ? '' : out.code, 'pr_push_failed');
  assert.deepEqual(calls.created, []);
  assert.equal(dbApi.getIntegration(f.repo, f.branch)?.state, 'branch');
});

/** An idea of the fixture's project tied to `ref`, carried by the task `taskId`. */
function ideaFor(f: Fixture, ref: string, taskId = f.taskId): number {
  const id = dbApi.insertProjectTodo({ text: `idea for ${ref}`, project: f.slug }).id;
  dbApi.putTodoExternalRef({
    todoId: id, provider: 'github', ref, url: `https://github.com/${ref.replace('#', '/issues/')}`, label: null, pluginId: 'github-issues',
  });
  dbApi.setTaskTodoId(taskId, id);
  return id;
}

test('the description gets Fixes for an idea of this job alone, Refs for one several jobs carry, and loses the agent\'s own', async () => {
  const f = fixture();
  ideaFor(f, 'acme/app#212');
  // A second task of the job on another idea, which an earlier job carried too.
  const second = randomUUID();
  dbApi.createTask(second, 'Part two', 'acme.coder', {
    type: 'code', project: f.slug, baseBranch: f.branch, integrationMode: 'pr', baseRef: 'origin/main', seriesId: f.seriesId,
  });
  const shared = ideaFor(f, 'acme/app#300', second);
  const earlier = randomUUID();
  dbApi.createTask(earlier, 'Earlier part', 'acme.coder', {
    type: 'code', project: f.slug, baseBranch: 'feat/earlier', integrationMode: 'pr', baseRef: 'origin/main',
  });
  dbApi.setTaskTodoId(earlier, shared);
  dbApi.recordIntegration({ repo: f.repo, branch: 'feat/earlier', remote: 'origin', target: 'main', mode: 'pr', project: f.slug });

  const body = 'Adds x.\n\nCloses #999 and fixes: acme/other#4, see also https://github.com/acme/app/issues/7.\nResolved https://github.com/acme/app/issues/8';
  const out = await openPullRequest({ target: 'task', id: f.taskId, title: 'Add x', body }, deps(f.repo));
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.issues, ['Fixes acme/app#212', 'Refs acme/app#300']);
  assert.equal(calls.created[0]!.body, [
    'Adds x.',
    '',
    'Refs #999 and Refs: acme/other#4, see also https://github.com/acme/app/issues/7.',
    'Refs https://github.com/acme/app/issues/8',
    '',
    'Fixes acme/app#212',
    'Refs acme/app#300',
  ].join('\n'));
});

test('a job the planner said resolves its issues entirely fixes them all', async () => {
  const f = fixture();
  const shared = ideaFor(f, 'acme/app#301');
  const earlier = randomUUID();
  dbApi.createTask(earlier, 'Earlier part', 'acme.coder', {
    type: 'code', project: f.slug, baseBranch: 'feat/earlier', integrationMode: 'pr', baseRef: 'origin/main',
  });
  dbApi.setTaskTodoId(earlier, shared);
  dbApi.recordIntegration({ repo: f.repo, branch: 'feat/earlier', remote: 'origin', target: 'main', mode: 'pr', project: f.slug });
  dbApi.setSeriesResolvesIssues(f.seriesId, true);
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.ok(out.ok, JSON.stringify(out));
  assert.deepEqual(out.issues, ['Fixes acme/app#301']);
  assert.equal(calls.created[0]!.body, `${REQUEST.body}\n\nFixes acme/app#301`);
});

test('a job without ideas tied to an issue keeps its description', async () => {
  const f = fixture();
  dbApi.setTaskTodoId(f.taskId, dbApi.insertProjectTodo({ text: 'plain idea', project: f.slug }).id);
  const out = await openPullRequest({ target: 'task', id: f.taskId, ...REQUEST }, deps(f.repo));
  assert.ok(out.ok);
  assert.deepEqual(out.issues, []);
  assert.equal(calls.created[0]!.body, REQUEST.body);
  assert.equal(withoutClosingKeywords('Prefix #3 and a fix for #4'), 'Prefix #3 and a fix for #4');
});

test('leak rules: ids, TODO numbers and attribution lines', () => {
  assert.deepEqual(leakProblems('feat(x): add y', []), []);
  assert.deepEqual(leakProblems('feat(x): see #12 upstream', []), []);
  assert.deepEqual(leakProblems('TODO #4', []), ['an internal TODO number']);
  assert.deepEqual(leakProblems('fix: abcdef12 regression', ['abcdef12-0000-4000-8000-000000000000']), ['a task id']);
  assert.deepEqual(leakProblems('Co-Authored-By: x', [], { attribution: true }), ['an attribution line']);
  assert.deepEqual(leakProblems('Co-Authored-By: x', []), []);
});
