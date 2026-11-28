/**
 * The preview of a job's pull request: commits and diff of the integration
 * branch against its target, the diff's bounds, the conflict probe, the
 * pre-checks run dry (nothing written, nothing pushed), and the forge's checks
 * read on demand at most once a minute.
 *
 * A real throwaway repository for git; the forge and the network side of git
 * are stand-ins that record every call.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { dbApi } from './db.js';
import {
  parsePullRequestChecks, type Forge, type ForgeChecksReader, type ForgeThreadsReader, type GitTransport,
  type PullRequestChecksOutcome, type ReviewThreadsOutcome,
} from './host/forge.js';
import {
  CHECKS_MIN_INTERVAL_MS, PREVIEW_LIMITS, integrationView, previewIntegration, refreshIntegrationChecks, splitPatch,
  type PreviewDeps,
} from './integration-preview.js';
import { updateProjectIntegration } from './project-integration.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-landing-preview-')));
after(() => rmSync(root, { recursive: true, force: true }));
const REMOTE_URL = 'git@github.com:acme/app.git';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();
}

function write(cwd: string, file: string, content: string): void {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), content);
}

function commitFiles(cwd: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) write(cwd, file, content);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

let counter = 0;

type Fixture = { repo: string; branch: string; id: string; slug: string };

/** `origin/main` at the base commit, `feat/topic` ahead of it, and the rows
 *  the dispatcher would have recorded. `onBranch` builds the branch. */
function fixture(onBranch: (repo: string) => void, opts: { state?: 'open' } = {}): Fixture {
  counter += 1;
  const repo = join(root, `repo-${counter}`);
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  git(repo, 'config', 'user.name', 'Acme Bot');
  git(repo, 'config', 'user.email', 'bot@acme.test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commitFiles(repo, { '.gitignore': '/docs\n', 'src/app.ts': 'line one\nline two\nline three\n' }, 'chore: start');
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(repo, 'remote', 'add', 'origin', REMOTE_URL);
  const branch = 'feat/topic';
  git(repo, 'checkout', '-q', '-b', branch);
  onBranch(repo);
  git(repo, 'checkout', '-q', 'main');

  const slug = `landing-${counter}`;
  dbApi.upsertProject(slug, { cwd: repo });
  updateProjectIntegration(slug, { mode: 'pr', account: 'ai-bot', remote_url: REMOTE_URL });
  const seriesId = randomUUID();
  dbApi.createTask(randomUUID(), 'Add x', 'acme.coder', {
    type: 'code', project: slug, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main', seriesId,
  });
  const row = dbApi.recordIntegration({ repo, branch, remote: 'origin', target: 'main', mode: 'pr', project: slug, seriesId });
  if (opts.state === 'open') {
    dbApi.markIntegrationOpen(row.id, { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: git(repo, 'rev-parse', branch) });
  }
  return { repo, branch, id: row.id, slug };
}

type Calls = { login: number; fetch: number; push: number; create: number; remote: number; checks: number; threads: number };
let calls: Calls;
let checksAnswer: PullRequestChecksOutcome;
let threadsAnswer: ReviewThreadsOutcome;
let now: number;

beforeEach(() => {
  calls = { login: 0, fetch: 0, push: 0, create: 0, remote: 0, checks: 0, threads: 0 };
  threadsAnswer = { ok: true, threads: [], unresolved: 3, truncated: false };
  checksAnswer = {
    ok: true,
    view: {
      state: 'open', draft: false, mergeable: 'mergeable', review: null, title: 'Add x', body: 'Why x.',
      mergeStateStatus: 'behind', labels: [{ name: 'accepted', color: '0e8a16' }],
      closingIssues: [{ repo: 'acme/app', number: 212, url: 'https://github.com/acme/app/issues/212' }],
      checks: [
        { name: 'build', status: 'pass', url: 'https://github.com/acme/app/actions/runs/1' },
        { name: 'tests', status: 'pending', url: null },
      ],
    },
  };
  now = 1_000_000;
});

function deps(): PreviewDeps {
  const forge: Forge & ForgeChecksReader & ForgeThreadsReader = {
    async login() { calls.login += 1; return { ok: true, login: 'ai-bot' }; },
    async repositoryAccess() { return { ok: true, exists: true, canPush: true }; },
    async forkRepository() { return { ok: true, fullName: 'bot/app' }; },
    async createPullRequest() { calls.create += 1; return { ok: false, code: 'gh_failed', reason: 'stub' }; },
    async pullRequestChecks() { calls.checks += 1; return checksAnswer; },
    async pullRequestReviewThreads() { calls.threads += 1; return threadsAnswer; },
  };
  const transport: GitTransport = {
    async remoteBranchSha() { calls.remote += 1; return { ok: true, sha: null }; },
    async fetchBranch() { calls.fetch += 1; return { ok: true }; },
    async pushBranch() { calls.push += 1; return { ok: true }; },
  };
  return { forge: () => forge, transport: () => transport, now: () => now };
}

test('the preview lists the commits and the diff of the branch against its target', async () => {
  const f = fixture((repo) => {
    commitFiles(repo, { 'src/app.ts': 'line one\nline 2\nline three\n' }, 'fix(app): name the second line');
    commitFiles(repo, { 'src/new.ts': 'export const x = 1;\n' }, 'feat(app): add x');
  });
  const out = await previewIntegration(dbApi.getIntegrationById(f.id)!, { prechecks: false }, deps());
  assert.equal(out.problem, null);
  assert.equal(out.commit_count, 2);
  assert.deepEqual(out.commits.map((c) => c.subject), ['feat(app): add x', 'fix(app): name the second line']);
  assert.equal(out.commits[0]!.author, 'Acme Bot');
  assert.match(out.commits[0]!.short, /^[0-9a-f]{7,}$/);
  assert.deepEqual(out.files.map((x) => [x.path, x.additions, x.deletions]), [['src/app.ts', 1, 1], ['src/new.ts', 1, 0]]);
  assert.deepEqual(out.totals, { files: 2, additions: 2, deletions: 1 });
  assert.match(out.files[0]!.patch ?? '', /^diff --git a\/src\/app\.ts/);
  assert.match(out.files[0]!.patch ?? '', /\n-line two\n\+line 2/);
  assert.match(out.files[1]!.patch ?? '', /\+export const x = 1;/);
  assert.equal(out.patch_truncated, false);
  assert.equal(out.files_truncated, false);
  assert.deepEqual(out.conflict, { state: 'clean', files: [] });
  assert.equal(out.prechecks.ran, false);
  assert.equal(out.integration.branch, 'feat/topic');
  assert.ok(!('repo' in out.integration), 'the repository path stays on the daemon');
  // Nothing reached the forge or the remote.
  assert.deepEqual(calls, { login: 0, fetch: 0, push: 0, create: 0, remote: 0, checks: 0, threads: 0 });
});

test('a branch that conflicts with its target is reported, with the file', async () => {
  const f = fixture((repo) => {
    commitFiles(repo, { 'src/app.ts': 'line one\nbranch side\nline three\n' }, 'feat(app): change the line');
  });
  // The target moves the same line.
  git(f.repo, 'checkout', '-q', '--detach', 'origin/main');
  const moved = commitFiles(f.repo, { 'src/app.ts': 'line one\ntarget side\nline three\n' }, 'feat(app): another change');
  git(f.repo, 'update-ref', 'refs/remotes/origin/main', moved);
  git(f.repo, 'checkout', '-q', 'main');
  const out = await previewIntegration(dbApi.getIntegrationById(f.id)!, { prechecks: false }, deps());
  assert.equal(out.conflict.state, 'conflicting');
  assert.deepEqual(out.conflict.files, ['src/app.ts']);
});

test('a large diff is cut, and says so', async () => {
  const big = `${Array.from({ length: 6_000 }, (_, i) => `const line${i} = ${i};`).join('\n')}\n`;
  const many: Record<string, string> = { 'src/big.ts': big };
  for (let i = 0; i < PREVIEW_LIMITS.files + 5; i += 1) many[`src/many/f${String(i).padStart(3, '0')}.ts`] = `${i}\n`;
  const f = fixture((repo) => { commitFiles(repo, many, 'feat(app): many files'); });
  const out = await previewIntegration(dbApi.getIntegrationById(f.id)!, { prechecks: false }, deps());
  assert.equal(out.totals.files, PREVIEW_LIMITS.files + 6);
  assert.equal(out.files.length, PREVIEW_LIMITS.files);
  assert.equal(out.files_truncated, true);
  assert.equal(out.patch_truncated, true);
  const bigFile = out.files.find((x) => x.path === 'src/big.ts')!;
  assert.equal(bigFile.patch_truncated, true);
  assert.ok((bigFile.patch ?? '').length <= PREVIEW_LIMITS.filePatch);
  // Cut at a line break: never half a line.
  assert.match(bigFile.patch ?? '', /\+const line\d+ = \d+;$/);
  const total = out.files.reduce((n, x) => n + (x.patch?.length ?? 0), 0);
  assert.ok(total <= PREVIEW_LIMITS.totalPatch);
});

test('the dry pre-checks write nothing and push nothing', async () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'export const x = 1;\n' }, 'feat(app): add x'); });
  const before = dbApi.getIntegrationById(f.id)!;
  const refsBefore = git(f.repo, 'for-each-ref');
  const out = await previewIntegration(before, { prechecks: true, title: 'Add x to the app', body: 'Because y.' }, deps());
  assert.equal(out.prechecks.ran, true);
  assert.ok(out.prechecks.ran);
  const byName = new Map(out.prechecks.checks.map((c) => [c.name, c]));
  assert.equal(out.prechecks.ready, true, JSON.stringify(out.prechecks.checks));
  assert.equal(byName.get('target')?.ok, true);
  assert.match(byName.get('target')?.detail ?? '', /last fetched/);
  assert.equal(byName.get('public_tree')?.skipped, true);
  assert.equal(byName.get('pr_text')?.ok, true);
  assert.equal(byName.get('commits')?.ok, true);
  // Read-only gestures only: the account and the remote branch.
  assert.deepEqual(calls, { login: 1, fetch: 0, push: 0, create: 0, remote: 1, checks: 0, threads: 0 });
  assert.deepEqual(dbApi.getIntegrationById(f.id), before);
  assert.equal(git(f.repo, 'for-each-ref'), refsBefore);
  assert.deepEqual(out.pull_request, { title: 'Add x to the app', body: 'Because y.' });
});

test('the dry pre-checks still refuse what the opening would refuse', async () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x for TODO #12'); });
  const out = await previewIntegration(dbApi.getIntegrationById(f.id)!, { prechecks: true }, deps());
  assert.ok(out.prechecks.ran);
  assert.equal(out.prechecks.ready, false);
  const failed = out.prechecks.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.deepEqual(failed, ['commit_messages']);
  // No title yet: not a failure of the preview.
  assert.equal(out.prechecks.checks.find((c) => c.name === 'pr_text')?.skipped, true);
  assert.equal(calls.push + calls.create + calls.fetch, 0);
});

test('a pull request already open is not checked again before a push', async () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); }, { state: 'open' });
  const out = await previewIntegration(dbApi.getIntegrationById(f.id)!, { prechecks: true }, deps());
  assert.deepEqual(out.prechecks, { ran: false, reason: 'the pull request is already open' });
  assert.equal(calls.login, 0);
});

test('the checks of an open pull request are read at most once a minute', async () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); }, { state: 'open' });
  const first = await refreshIntegrationChecks(dbApi.getIntegrationById(f.id)!, deps());
  assert.ok(first.ok);
  assert.equal(first.fresh, true);
  assert.deepEqual(first.integration.checks?.counts, { pass: 1, fail: 0, pending: 1, skipped: 0 });
  assert.equal(first.integration.checks_running, true);
  assert.equal(first.integration.conflict, false);
  assert.equal(first.integration.pr_title, 'Add x');
  assert.equal(first.integration.checks?.merge_state, 'behind');
  assert.deepEqual(first.integration.checks?.labels, [{ name: 'accepted', color: '0e8a16' }]);
  assert.deepEqual(first.integration.checks?.closing_issues, [{ repo: 'acme/app', number: 212, url: 'https://github.com/acme/app/issues/212' }]);
  assert.equal(first.integration.checks?.unresolved_threads, 3);
  assert.equal(calls.checks, 1);
  assert.equal(calls.threads, 1);

  now += CHECKS_MIN_INTERVAL_MS - 1;
  const cached = await refreshIntegrationChecks(dbApi.getIntegrationById(f.id)!, deps());
  assert.ok(cached.ok);
  assert.equal(cached.fresh, false);
  assert.equal(calls.checks, 1);

  now += 2;
  checksAnswer = { ok: true, view: { ...(checksAnswer as { ok: true; view: never }).view, mergeable: 'conflicting', checks: [] } };
  // The threads failing leaves the checks readable, the count unknown.
  threadsAnswer = { ok: false, code: 'gh_failed', reason: 'HTTP 502' };
  const again = await refreshIntegrationChecks(dbApi.getIntegrationById(f.id)!, deps());
  assert.ok(again.ok);
  assert.equal(calls.checks, 2);
  assert.equal(again.integration.checks?.unresolved_threads, null);
  assert.equal(again.integration.conflict, true);
  assert.equal(again.integration.checks_running, false);
  // The poller alone concludes: the state did not move.
  assert.equal(dbApi.getIntegrationById(f.id)?.state, 'open');
});

test('a branch without a pull request has no checks to read; a forge failure leaves the row alone', async () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); });
  const none = await refreshIntegrationChecks(dbApi.getIntegrationById(f.id)!, deps());
  assert.deepEqual(none.ok ? null : none.code, 'checks_not_applicable');
  assert.equal(calls.checks, 0);

  const g = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); }, { state: 'open' });
  const token = `ghp_${'a'.repeat(36)}`;
  // The real forge, with a gh that fails and prints a credential.
  const out = await refreshIntegrationChecks(dbApi.getIntegrationById(g.id)!, {
    runners: { gh: async () => ({ code: 1, stdout: '', stderr: `HTTP 401: bad credentials ${token}` }) },
  });
  assert.equal(out.ok, false);
  assert.ok(!out.ok);
  assert.equal(out.code, 'checks_unavailable');
  assert.ok(!out.reason.includes(token));
  assert.match(out.reason, /\[redacted\]/);
  assert.equal(dbApi.getIntegrationById(g.id)?.checks, null);
});

test('gh check answers are mapped and bounded', () => {
  const view = parsePullRequestChecks(JSON.stringify({
    state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', reviewDecision: 'CHANGES_REQUESTED',
    title: `T${'x'.repeat(400)}`, body: 'b\u0007ody',
    statusCheckRollup: [
      { __typename: 'CheckRun', name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://ci/1' },
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'javascript:alert(1)' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'cla', state: 'PENDING', targetUrl: 'https://cla/1' },
      { __typename: 'StatusContext', context: 'deploy', state: 'ERROR' },
      'nonsense',
    ],
  }));
  assert.ok(view);
  assert.equal(view.draft, true);
  assert.equal(view.mergeable, 'conflicting');
  assert.equal(view.review, 'changes_requested');
  assert.equal(view.title.length, 256);
  assert.equal(view.body, 'body');
  assert.deepEqual(view.checks.map((c) => [c.name, c.status, c.url]), [
    ['build', 'pass', 'https://ci/1'],
    ['lint', 'fail', null],
    ['e2e', 'pending', null],
    ['docs', 'skipped', null],
    ['cla', 'pending', 'https://cla/1'],
    ['deploy', 'fail', null],
  ]);
  assert.equal(parsePullRequestChecks('{"state":"WEIRD"}'), null);
  assert.equal(parsePullRequestChecks('not json'), null);
});

test('a patch is cut per file, in order', () => {
  const parts = splitPatch('diff --git a/x b/x\n-a\n+b\ndiff --git a/y b/y\n+c\n');
  assert.deepEqual(parts, ['diff --git a/x b/x\n-a\n+b', 'diff --git a/y b/y\n+c']);
  assert.deepEqual(splitPatch(''), []);
});

test('a stored copy read before the merge state and threads existed still reads', () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); });
  dbApi.setIntegrationChecks(f.id, JSON.stringify({
    read_at: 1, state: 'open', draft: false, mergeable: 'unknown', review: null, title: 't', body: '', items: [],
  }));
  const view = integrationView(dbApi.getIntegrationById(f.id)!);
  assert.equal(view.checks?.merge_state, 'unknown');
  assert.deepEqual(view.checks?.labels, []);
  assert.deepEqual(view.checks?.closing_issues, []);
  assert.equal(view.checks?.unresolved_threads, null);
});

test('the view of a row carries no stored checks it cannot read', () => {
  const f = fixture((repo) => { commitFiles(repo, { 'src/new.ts': 'x\n' }, 'feat(app): add x'); });
  dbApi.setIntegrationChecks(f.id, '{"not":"ours"}');
  const view = integrationView(dbApi.getIntegrationById(f.id)!);
  assert.equal(view.checks, null);
  assert.equal(view.conflict, null);
});
