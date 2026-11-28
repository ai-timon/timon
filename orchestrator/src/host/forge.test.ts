import '../test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  actionsJobOf, assertNoForce, CHECK_LOG_TAIL_CHARS, deleteBranchArguments, CHECK_LOG_TAIL_LINES, checkLogTail, FORGE_BODY_LIMIT, FORGE_TITLE_LIMIT, githubForge, githubRepoFromUrl, gitTransport, ISSUE_COMMENT_LIMIT, ISSUE_LIST_LIMIT,
  parseGeneralReviews, parsePullRequestBranch, parsePullRequestChecks, GENERAL_REVIEW_LIMIT, pushArguments, pushCommitArguments, redactedOutput, REVIEW_THREAD_BODY_LIMIT, REVIEW_THREAD_LIMIT, type GitRunner,
} from './forge.js';
import type { GhRunner } from './gh.js';
import type { ExecOpts } from './types.js';

type Answer = { code?: number; stdout?: string; stderr?: string; timedOut?: boolean } | 'missing';

function recorder(answer: Answer) {
  const calls: Array<{ args: string[]; opts: ExecOpts }> = [];
  const run: GhRunner & GitRunner = async (args, opts) => {
    calls.push({ args, opts });
    if (answer === 'missing') throw new Error('binary not found');
    return { code: answer.code ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '', timedOut: answer.timedOut };
  };
  return { run, calls };
}

test('the repository of a GitHub push URL, ssh alias included', () => {
  assert.equal(githubRepoFromUrl('git@github.com:acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('git@github-work:acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('ssh://git@github.com/acme/app.git'), 'acme/app');
  assert.equal(githubRepoFromUrl('https://github.com/acme/app'), 'acme/app');
  assert.equal(githubRepoFromUrl('https://github.com/acme/app.git/'), 'acme/app');
  assert.equal(githubRepoFromUrl('/srv/git/app.git'), null);
  assert.equal(githubRepoFromUrl('https://github.com/acme'), null);
  assert.equal(githubRepoFromUrl('git@github.com:../app.git'), null);
  // A token stored outside Timon still names its repository.
  assert.equal(githubRepoFromUrl('https://x-access-token:ghp_0123456789abcdef0123@github.com/acme/app.git'), 'acme/app');
});

test('the repository of a URL git would push to another host than it shows is unknown', () => {
  for (const url of [
    'https://github.com\\@evil.example/acme/app.git',
    'https://github.com\\\\@evil.example/acme/app.git',
    'HTTPS://GITHUB.COM\\@EVIL.EXAMPLE/acme/app.git',
    'ssh://evil.example%2F@github.com/acme/app.git',
    'ssh://git@evil.example@github.com/acme/app.git',
    'https://github%2Ecom/acme/app.git',
    'https://evil.example#@github.com/acme/app.git',
    'https://127.1/acme/app.git',
    'github.com\\@evil.example:acme/app.git',
  ]) {
    assert.equal(githubRepoFromUrl(url), null, url);
  }
});

test('a push is never forced, whatever arguments are tried', () => {
  for (const bad of [['--force'], ['-f'], ['--force-with-lease'], ['--force-with-lease=main'], ['--mirror'], ['--delete'], ['-d'], ['--tags']]) {
    assert.throws(() => assertNoForce(bad), /forced push/, JSON.stringify(bad));
  }
  assert.throws(() => assertNoForce(['--', 'url', '+refs/heads/a:refs/heads/a']), /forced push/);
  assert.throws(() => assertNoForce(['--', 'url', ':refs/heads/a']), /forced push/);
  assert.deepEqual(pushArguments('git@github.com:acme/app.git', 'feat/x'), ['--', 'git@github.com:acme/app.git', 'refs/heads/feat/x:refs/heads/feat/x']);
  for (const branch of ['+feat/x', '-f', 'a:b', 'feat/x y', 'a..b']) {
    assert.throws(() => pushArguments('u', branch), /unusual name/, branch);
  }
});

test('the push runs plain git push, without a prompt, and reports a rejection as such', async () => {
  const ok = recorder({});
  assert.deepEqual(await gitTransport('/repo', { git: ok.run }).pushBranch('git@github.com:acme/app.git', 'feat/x'), { ok: true });
  assert.deepEqual(ok.calls[0]?.args, ['-C', '/repo', 'push', '--', 'git@github.com:acme/app.git', 'refs/heads/feat/x:refs/heads/feat/x']);
  assert.equal(ok.calls[0]?.opts.env?.GIT_TERMINAL_PROMPT, '0');
  assert.ok(!ok.calls[0]?.args.some((a) => /force|^\+/.test(a)));

  const rejected = recorder({ code: 1, stderr: ' ! [rejected]        feat/x -> feat/x (non-fast-forward)' });
  const out = await gitTransport('/repo', { git: rejected.run }).pushBranch('u', 'feat/x');
  assert.equal(out.ok, false);
  assert.equal(out.ok ? '' : out.code, 'rejected');

  const unusual = recorder({});
  assert.equal((await gitTransport('/repo', { git: unusual.run }).pushBranch('u', '+feat/x')).ok, false);
  assert.equal(unusual.calls.length, 0, 'an unusual name never reaches git');
});

test('the remote branch is read with ls-remote; absent is null, a failure is not "absent"', async () => {
  const sha = 'a'.repeat(40);
  const there = recorder({ stdout: `${sha}\trefs/heads/feat/x\n` });
  assert.deepEqual(await gitTransport('/repo', { git: there.run }).remoteBranchSha('u', 'feat/x'), { ok: true, sha });
  assert.deepEqual(there.calls[0]?.args, ['-C', '/repo', 'ls-remote', '--heads', '--', 'u', 'refs/heads/feat/x']);
  const absent = recorder({ stdout: '' });
  assert.deepEqual(await gitTransport('/repo', { git: absent.run }).remoteBranchSha('u', 'feat/x'), { ok: true, sha: null });
  const down = recorder({ code: 128, stderr: 'fatal: Could not read from remote repository.' });
  assert.equal((await gitTransport('/repo', { git: down.run }).remoteBranchSha('u', 'feat/x')).ok, false);
});

test('a fetch never forces the local ref', async () => {
  const run = recorder({});
  await gitTransport('/repo', { git: run.run }).fetchBranch('u', 'main', 'refs/remotes/origin/main');
  assert.deepEqual(run.calls[0]?.args, ['-C', '/repo', 'fetch', '--no-tags', '--', 'u', 'refs/heads/main:refs/remotes/origin/main']);
});

test('gh pr create gets the branches, title and body, with the project folder and no token', async () => {
  const run = recorder({ stdout: 'https://github.com/acme/app/pull/42\n' });
  const forge = githubForge('/home/u/.config/gh-work', { gh: run.run });
  const out = await forge.createPullRequest({ repo: 'acme/app', base: 'main', head: 'feat/x', title: 'Add x', body: 'Why x.' });
  assert.deepEqual(out, { ok: true, pr: { number: 42, url: 'https://github.com/acme/app/pull/42' }, existing: false });
  assert.deepEqual(run.calls[0]?.args, [
    'pr', 'create', '--repo=acme/app', '--base=main', '--head=feat/x', '--title=Add x', '--body=Why x.',
  ]);
  const dashed = recorder({ stdout: 'https://github.com/acme/app/pull/43\n' });
  await githubForge(null, { gh: dashed.run }).createPullRequest({ repo: 'acme/app', base: 'main', head: 'feat/x', title: '--admin', body: '-f' });
  assert.ok(dashed.calls[0]?.args.includes('--title=--admin') && !dashed.calls[0]?.args.includes('--admin'), 'a value never becomes a flag');
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.ok(!run.calls[0]?.args.includes('--admin'));
});

test('a pull request already open for the branch is returned, other failures are refusals', async () => {
  const exists = recorder({ code: 1, stderr: 'a pull request for branch "feat/x" into branch "main" already exists:\nhttps://github.com/acme/app/pull/7\n' });
  assert.deepEqual(
    await githubForge(null, { gh: exists.run }).createPullRequest({ repo: 'a/b', base: 'main', head: 'feat/x', title: 't', body: '' }),
    { ok: true, pr: { number: 7, url: 'https://github.com/acme/app/pull/7' }, existing: true },
  );
  const input = { repo: 'a/b', base: 'main', head: 'feat/x', title: 't', body: '' };
  assert.equal((await githubForge(null, { gh: recorder('missing').run }).createPullRequest(input)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ timedOut: true, code: 1 }).run }).createPullRequest(input)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'done' }).run }).createPullRequest(input)).ok, false);
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `bad credentials ghp_${'x'.repeat(36)}` }).run }).createPullRequest(input);
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'), 'a token never comes back');
});

test('credentials are masked in what a command printed', () => {
  assert.equal(redactedOutput('fatal: https://user:tok@github.com/a/b'), 'fatal: https://[redacted]@github.com/a/b');
});

test('gh pr view reads the state and merge commit, with the project folder and no token', async () => {
  const oid = 'c'.repeat(40);
  const merged = recorder({ stdout: JSON.stringify({ state: 'MERGED', mergeCommit: { oid } }) });
  const before = process.env.GH_TOKEN;
  process.env.GH_TOKEN = 'ghp_should_not_pass';
  try {
    const out = await githubForge('/home/u/.config/gh-work', { gh: merged.run }).pullRequest('acme/app', 42);
    assert.deepEqual(out, { ok: true, state: 'merged', mergeSha: oid });
  } finally {
    if (before === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = before;
  }
  assert.deepEqual(merged.calls[0]?.args, ['pr', 'view', '42', '--repo=acme/app', '--json=state,mergeCommit']);
  assert.equal(merged.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal(merged.calls[0]?.opts.env?.GH_TOKEN, undefined);

  const closed = recorder({ stdout: JSON.stringify({ state: 'CLOSED', mergeCommit: null }) });
  assert.deepEqual(await githubForge(null, { gh: closed.run }).pullRequest('acme/app', 7), { ok: true, state: 'closed', mergeSha: null });
});

test('gh pr view: a failure, a timeout or an odd answer is never a state', async () => {
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `HTTP 401 ghp_${'x'.repeat(36)}` }).run }).pullRequest('a/b', 1);
  assert.equal(leaked.ok, false);
  assert.doesNotMatch(leaked.ok ? '' : leaked.reason, /ghp_/);
  assert.equal((await githubForge(null, { gh: recorder('missing').run }).pullRequest('a/b', 1)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ timedOut: true, code: 1 }).run }).pullRequest('a/b', 1)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: '{"state":"DRAFT"}' }).run }).pullRequest('a/b', 1)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'not json' }).run }).pullRequest('a/b', 1)).ok, false);
  const odd = recorder({ stdout: '{}' });
  assert.equal((await githubForge(null, { gh: odd.run }).pullRequest('--repo=x', 1)).ok, false);
  assert.equal((await githubForge(null, { gh: odd.run }).pullRequest('a/b', -1)).ok, false);
  assert.equal(odd.calls.length, 0, 'an odd repository or number never reaches gh');
});

test('gh pr list reads the open pull requests with the project folder, and drops what is not one', async () => {
  const { run, calls } = recorder({ stdout: JSON.stringify([
    { number: 4, title: 'x', author: { login: 'stranger' }, url: 'https://github.com/acme/app/pull/4', isDraft: true, updatedAt: 'd', headRepositoryOwner: { login: 'stranger' } },
    { number: 'five', url: 'https://github.com/acme/app/pull/5' },
    { number: 6, title: 'no url' },
  ]) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run }).listOpenPullRequests('acme/app');
  assert.deepEqual(out, { ok: true, pulls: [
    {
      number: 4, title: 'x', author: 'stranger', url: 'https://github.com/acme/app/pull/4', isDraft: true, updatedAt: 'd', headOwner: 'stranger',
      headRepository: null, maintainerCanModify: false, mergeStateStatus: 'unknown', labels: [], closingIssues: [],
    },
  ] });
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['pr', 'list']);
  assert.ok(calls[0]!.args.includes('--state=open'));
  assert.equal(calls[0]!.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal((await githubForge(null, { gh: run }).listOpenPullRequests('not a repo')).ok, false);
});

test('gh pr diff is text, cut past the limit and said so', async () => {
  const big = recorder({ code: 1, stdout: 'diff --git a/x b/x\n', stderr: 'stdout maxBuffer length exceeded' });
  const cut = await githubForge(null, { gh: big.run }).pullRequestDiff('acme/app', 4);
  assert.deepEqual(cut, { ok: true, diff: 'diff --git a/x b/x\n', truncated: true });
  assert.deepEqual(big.calls[0]!.args.slice(0, 3), ['pr', 'diff', '4']);
  const failed = recorder({ code: 1, stderr: 'no pull requests found' });
  assert.equal((await githubForge(null, { gh: failed.run }).pullRequestDiff('acme/app', 4)).ok, false);
  assert.equal((await githubForge(null, { gh: failed.run }).pullRequestDiff('acme/app', 0)).ok, false);
});

const TOKEN = `ghp_${'x'.repeat(36)}`;

test('a pull request summary carries its merge state, fork, labels and the issues it closes; unknown fields are dropped', async () => {
  const { run, calls } = recorder({ stdout: JSON.stringify([{
    number: 51, title: 'Fix the parser', author: { login: 'stranger' }, url: 'https://github.com/acme/app/pull/51',
    isDraft: false, updatedAt: '2026-11-19T10:00:00Z',
    headRepositoryOwner: { id: 'U_1', login: 'stranger' }, headRepository: { id: 'R_1', name: 'app-fork' },
    maintainerCanModify: true, mergeStateStatus: 'BEHIND',
    labels: [{ id: 'L1', name: 'bug', color: 'D73A4A', description: 'x' }, { name: '' }, 'odd', { name: 'ui', color: 'not a colour' }],
    closingIssuesReferences: [
      { id: 'I1', number: 212, url: 'https://github.com/acme/app/issues/212', repository: { id: 'R', name: 'app', owner: { id: 'O', login: 'acme' } } },
      { number: -1, url: 'https://github.com/acme/app/issues/0' },
      { number: 7, url: 'javascript:alert(1)', repository: { name: '..', owner: { login: 'x' } } },
    ],
    somethingNew: { nested: true },
  }]) });
  const out = await githubForge(null, { gh: run }).listOpenPullRequests('acme/app');
  assert.ok(out.ok);
  const pull = out.pulls[0]!;
  assert.equal(pull.headRepository, 'stranger/app-fork');
  assert.equal(pull.maintainerCanModify, true);
  assert.equal(pull.mergeStateStatus, 'behind');
  assert.deepEqual(pull.labels, [{ name: 'bug', color: 'd73a4a' }, { name: 'ui', color: null }]);
  assert.deepEqual(pull.closingIssues, [
    { repo: 'acme/app', number: 212, url: 'https://github.com/acme/app/issues/212' },
    { repo: null, number: 7, url: null },
  ]);
  assert.ok(!('somethingNew' in pull), 'an unknown field never reaches a caller');
  const json = calls[0]!.args.find((a) => a.startsWith('--json='))!;
  for (const field of ['mergeStateStatus', 'maintainerCanModify', 'headRepository', 'labels', 'closingIssuesReferences']) {
    assert.ok(json.split(/[=,]/).includes(field), field);
  }
});

test('a merge state the reader does not know is "unknown", a title is bounded', async () => {
  const { run } = recorder({ stdout: JSON.stringify([
    { number: 1, url: 'https://github.com/a/b/pull/1', mergeStateStatus: 'SOMETHING_NEW', title: 't'.repeat(FORGE_TITLE_LIMIT + 50) },
    { number: 2, url: 'https://github.com/a/b/pull/2', mergeStateStatus: 42, closingIssuesReferences: { nodes: [{ number: 3 }] } },
  ]) });
  const out = await githubForge(null, { gh: run }).listOpenPullRequests('a/b');
  assert.ok(out.ok);
  assert.deepEqual(out.pulls.map((p) => p.mergeStateStatus), ['unknown', 'unknown']);
  assert.equal(out.pulls[0]!.title.length, FORGE_TITLE_LIMIT);
  assert.deepEqual(out.pulls[1]!.closingIssues, [{ repo: null, number: 3, url: null }], 'a GraphQL connection is read too');
});

test('the checks of our pull request carry its merge state, labels and closing issues', async () => {
  const view = parsePullRequestChecks(JSON.stringify({
    state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'DIRTY',
    title: 't', body: 'b', statusCheckRollup: [], labels: [{ name: 'accepted', color: '0e8a16' }],
    closingIssuesReferences: [{ number: 9, url: 'https://github.com/a/b/issues/9', repository: { name: 'b', owner: { login: 'a' } } }],
  }));
  assert.equal(view?.mergeStateStatus, 'dirty');
  assert.deepEqual(view?.labels, [{ name: 'accepted', color: '0e8a16' }]);
  assert.deepEqual(view?.closingIssues, [{ repo: 'a/b', number: 9, url: 'https://github.com/a/b/issues/9' }]);
  const { run, calls } = recorder({ stdout: JSON.stringify({ state: 'OPEN' }) });
  const out = await githubForge(null, { gh: run }).pullRequestChecks('a/b', 9);
  assert.ok(out.ok);
  assert.equal(out.view.mergeStateStatus, 'unknown');
  assert.match(calls[0]!.args.join(' '), /--json=.*mergeStateStatus.*closingIssuesReferences/);
});

function threadsAnswer(nodes: unknown[], totalCount = nodes.length): string {
  return JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { totalCount, nodes } } } } });
}

function thread(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isResolved: false, isOutdated: false, path: `src/f${i}.ts`, line: i + 1,
    comments: { totalCount: 2, nodes: [{ author: { login: `rev${i}` }, body: `comment ${i}`, url: `https://github.com/a/b/pull/1#discussion_r${i}` }] },
    ...extra,
  };
}

test('review threads: one read-only GraphQL call, unresolved ones only, values kept as strings', async () => {
  const { run, calls } = recorder({ stdout: threadsAnswer([
    thread(0),
    thread(1, { isResolved: true }),
    thread(2, { isOutdated: true, line: null, comments: { totalCount: 1, nodes: [{ author: null, body: 'x\u0000y'.repeat(REVIEW_THREAD_BODY_LIMIT), url: 'http://plain' }] } }),
    { isResolved: 'no' },
  ]) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run }).pullRequestReviewThreads('acme/app', 51);
  assert.ok(out.ok);
  assert.equal(out.unresolved, 2);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.threads[0], {
    path: 'src/f0.ts', line: 1, outdated: false, author: 'rev0', body: 'comment 0',
    url: 'https://github.com/a/b/pull/1#discussion_r0', comments: 2,
  });
  const second = out.threads[1]!;
  assert.equal(second.author, null);
  assert.equal(second.line, null);
  assert.equal(second.outdated, true);
  assert.equal(second.url, null, 'only an https address is kept');
  assert.equal(second.body.length, REVIEW_THREAD_BODY_LIMIT);
  assert.ok(!second.body.includes('\u0000'));

  const args = calls[0]!.args;
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.ok(args.includes('--raw-field=owner=acme') && args.includes('--raw-field=name=app') && args.includes('--field=number=51'));
  assert.ok(!args.some((a) => /mutation/i.test(a)), 'a query, never a mutation');
  assert.equal(calls[0]!.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
});

test('general reviews: one read-only GraphQL query, the submitted ones with a text, the latest kept, oldest first', async () => {
  const node = (i: number, extra: Record<string, unknown> = {}) => ({
    state: 'CHANGES_REQUESTED', body: `rename ${i}`, url: `https://github.com/a/b/pull/1#pullrequestreview-${i}`,
    submittedAt: '2026-11-20T10:00:00Z', author: { login: `rev${i}` }, ...extra,
  });
  const answer = (nodes: unknown[], totalCount = nodes.length) => JSON.stringify({ data: { repository: { pullRequest: { reviews: { totalCount, nodes } } } } });
  const { run, calls } = recorder({ stdout: answer([
    node(0, { state: 'COMMENTED', body: 'x\u0000y'.repeat(GENERAL_REVIEW_LIMIT * 200), url: 'http://plain', author: null }),
    node(1, { body: '   ' }),
    node(2, { state: 'DISMISSED' }),
    node(3, { state: 'APPROVED', submittedAt: 'not a date' }),
  ]) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run }).pullRequestReviews('acme/app', 51);
  assert.ok(out.ok);
  assert.equal(out.truncated, false);
  assert.deepEqual(out.reviews.map((r) => r.state), ['commented', 'approved'], 'no empty text, no dismissed review');
  assert.equal(out.reviews[0]!.author, null);
  assert.equal(out.reviews[0]!.url, null);
  assert.ok(!out.reviews[0]!.body.includes('\u0000'));
  assert.equal(out.reviews[0]!.body.length, REVIEW_THREAD_BODY_LIMIT);
  assert.deepEqual(out.reviews[1], { state: 'approved', author: 'rev3', body: 'rename 3', url: 'https://github.com/a/b/pull/1#pullrequestreview-3', submittedAt: null });
  const args = calls[0]!.args;
  assert.deepEqual(args.slice(0, 2), ['api', 'graphql']);
  assert.ok(!args.some((a) => /mutation/i.test(a)), 'a query, never a mutation');
  assert.equal(calls[0]!.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');

  const many = Array.from({ length: GENERAL_REVIEW_LIMIT + 3 }, (_, i) => node(i));
  const bounded = await githubForge(null, { gh: recorder({ stdout: answer(many, 80) }).run }).pullRequestReviews('a/b', 1);
  assert.ok(bounded.ok);
  assert.equal(bounded.reviews.length, GENERAL_REVIEW_LIMIT);
  assert.equal(bounded.reviews[0]!.body, 'rename 3');
  assert.equal(bounded.truncated, true);
  assert.equal(parseGeneralReviews('{"data":{"repository":null}}'), null);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: '{}' }).run }).pullRequestReviews('@etc/passwd', 1)).ok, false);
});

test('review threads are bounded, and say when the forge holds more', async () => {
  const many = Array.from({ length: REVIEW_THREAD_LIMIT + 5 }, (_, i) => thread(i));
  const out = await githubForge(null, { gh: recorder({ stdout: threadsAnswer(many, 140) }).run }).pullRequestReviewThreads('a/b', 1);
  assert.ok(out.ok);
  assert.equal(out.threads.length, REVIEW_THREAD_LIMIT);
  assert.equal(out.unresolved, REVIEW_THREAD_LIMIT + 5);
  assert.equal(out.truncated, true);
});

test('review threads: a failure, an odd answer or an odd target is never a list', async () => {
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `HTTP 401 ${TOKEN}` }).run }).pullRequestReviewThreads('a/b', 1);
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'));
  const missing = await githubForge(null, { gh: recorder({ stdout: '{"data":{"repository":null}}' }).run }).pullRequestReviewThreads('a/b', 1);
  assert.equal(missing.ok ? '' : missing.code, 'unexpected_answer');
  const odd = recorder({ stdout: '{}' });
  assert.equal((await githubForge(null, { gh: odd.run }).pullRequestReviewThreads('@etc/passwd', 1)).ok, false);
  assert.equal((await githubForge(null, { gh: odd.run }).pullRequestReviewThreads('a/b', 0)).ok, false);
  assert.equal(odd.calls.length, 0, 'an odd repository or number never reaches gh');
});

const ISSUE = {
  number: 212, title: 'Parser crash', author: { login: 'reporter' }, url: 'https://github.com/acme/app/issues/212',
  state: 'OPEN', labels: [{ name: 'accepted', color: '0E8A16' }], createdAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-19T09:00:00Z',
};

test('issues: the open ones carrying a label, the most recent first, bounded', async () => {
  const { run, calls } = recorder({ stdout: JSON.stringify([
    ISSUE,
    { ...ISSUE, number: 213, title: 'x'.repeat(FORGE_TITLE_LIMIT + 1), author: null, extra: 'dropped' },
    { number: 'nope', url: 'https://github.com/acme/app/issues/1', state: 'OPEN' },
    { ...ISSUE, number: 214, url: 'http://github.com/acme/app/issues/214' },
    { ...ISSUE, number: 215, state: 'DRAFT' },
  ]) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run }).listIssues('acme/app', 'accepted');
  assert.ok(out.ok);
  assert.deepEqual(out.issues[0], {
    number: 212, title: 'Parser crash', author: 'reporter', url: 'https://github.com/acme/app/issues/212', state: 'open',
    labels: [{ name: 'accepted', color: '0e8a16' }], createdAt: '2026-11-18T09:00:00Z', updatedAt: '2026-11-19T09:00:00Z',
  });
  assert.deepEqual(out.issues.map((i) => i.number), [212, 213]);
  assert.equal(out.issues[1]!.title.length, FORGE_TITLE_LIMIT);
  assert.equal(out.issues[1]!.author, null);
  assert.ok(!('extra' in out.issues[1]!));
  assert.deepEqual(calls[0]!.args.slice(0, 2), ['issue', 'list']);
  for (const arg of ['--repo=acme/app', '--state=open', '--label=accepted', `--limit=${ISSUE_LIST_LIMIT}`]) {
    assert.ok(calls[0]!.args.includes(arg), arg);
  }
  assert.equal(calls[0]!.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
});

test('issues: a label gh would split or read as a flag never reaches it', async () => {
  const odd = recorder({ stdout: '[]' });
  const forge = githubForge(null, { gh: odd.run });
  for (const label of ['', 'a,b', ' accepted', 'x'.repeat(51), 'line\nbreak']) {
    assert.equal((await forge.listIssues('a/b', label)).ok, false, JSON.stringify(label));
  }
  assert.equal((await forge.listIssues('not a repo', 'accepted')).ok, false);
  assert.equal(odd.calls.length, 0);
  const dashed = recorder({ stdout: '[]' });
  await githubForge(null, { gh: dashed.run }).listIssues('a/b', '--web');
  assert.ok(dashed.calls[0]!.args.includes('--label=--web') && !dashed.calls[0]!.args.includes('--web'), 'a label stays a value');
});

test('issues: a failure or an odd answer is never a list, and carries no token', async () => {
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `HTTP 401 ${TOKEN}` }).run }).listIssues('a/b', 'accepted');
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'));
  assert.equal((await githubForge(null, { gh: recorder({ stdout: '{}' }).run }).listIssues('a/b', 'accepted')).ok, false);
  assert.equal((await githubForge(null, { gh: recorder('missing').run }).listIssues('a/b', 'accepted')).ok, false);
});

test('one issue: its text bounded and stripped of control characters, its state and reason', async () => {
  const body = `Steps\u0007 to reproduce\n${'y'.repeat(FORGE_BODY_LIMIT)}`;
  const { run, calls } = recorder({ stdout: JSON.stringify({ ...ISSUE, state: 'CLOSED', stateReason: 'NOT_PLANNED', body, comments: [{ body: 'dropped' }] }) });
  const out = await githubForge(null, { gh: run }).issueDetails('acme/app', 212);
  assert.ok(out.ok);
  assert.equal(out.issue.state, 'closed');
  assert.equal(out.issue.stateReason, 'not_planned');
  assert.equal(out.issue.body.length, FORGE_BODY_LIMIT);
  assert.equal(out.issue.bodyTruncated, true);
  assert.ok(out.issue.body.startsWith('Steps to reproduce\n'));
  assert.ok(!('comments' in out.issue));
  assert.deepEqual(calls[0]!.args.slice(0, 4), ['issue', 'view', '212', '--repo=acme/app']);

  const open = await githubForge(null, { gh: recorder({ stdout: JSON.stringify({ ...ISSUE, body: 'short', stateReason: '' }) }).run }).issueDetails('acme/app', 212);
  assert.ok(open.ok);
  assert.equal(open.issue.bodyTruncated, false);
  assert.equal(open.issue.stateReason, null);
});

test('one issue: an odd number, a failure or an odd answer is never an issue', async () => {
  const odd = recorder({ stdout: '{}' });
  assert.equal((await githubForge(null, { gh: odd.run }).issueDetails('a/b', -3)).ok, false);
  assert.equal(odd.calls.length, 0);
  assert.equal((await githubForge(null, { gh: odd.run }).issueDetails('a/b', 3)).ok, false);
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `could not resolve ${TOKEN}` }).run }).issueDetails('a/b', 3);
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'));
});

const MARKER = '<!-- timon-proposal:0b6f3a7e-1c2d-4e5f-8a9b-0c1d2e3f4a5b -->';

test('a comment is one POST to the issue comments endpoint, its body a raw string, with the project folder', async () => {
  const run = recorder({ stdout: JSON.stringify({ id: 99, html_url: 'https://github.com/acme/app/issues/5#issuecomment-99', body: 'x' }) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run.run }).postIssueComment('acme/app', 5, '@secrets.txt\nFixed in #51.');
  assert.deepEqual(out, { ok: true, comment: { id: 99, url: 'https://github.com/acme/app/issues/5#issuecomment-99' } });
  assert.deepEqual(run.calls[0]?.args, [
    'api', '--method=POST', 'repos/acme/app/issues/5/comments', '--raw-field=body=@secrets.txt\nFixed in #51.',
  ]);
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal(run.calls[0]?.opts.env?.GH_TOKEN, undefined);
});

test('a comment never reaches gh for an odd target or an empty or oversized body', async () => {
  const run = recorder({ stdout: '{}' });
  const forge = githubForge(null, { gh: run.run });
  for (const [repo, n, body] of [
    ['../x', 1, 'hi'], ['acme/..', 1, 'hi'], ['acme/app', 0, 'hi'], ['acme/app', 1.5, 'hi'],
    ['acme/app', 1, '   '], ['acme/app', 1, 'x'.repeat(ISSUE_COMMENT_LIMIT + 201)],
  ] as const) {
    assert.equal((await forge.postIssueComment(repo, n, body)).ok, false, `${repo} ${n}`);
  }
  assert.equal(run.calls.length, 0);
});

test('a comment that failed or came back odd is a refusal without a token', async () => {
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `HTTP 401 ${TOKEN}` }).run }).postIssueComment('a/b', 1, 'hi');
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'));
  assert.equal((await githubForge(null, { gh: recorder({ stdout: '{"id":1,"html_url":"http://x"}' }).run }).postIssueComment('a/b', 1, 'hi')).ok, false);
  assert.equal((await githubForge(null, { gh: recorder('missing').run }).postIssueComment('a/b', 1, 'hi')).ok, false);
  const slow = await githubForge(null, { gh: recorder({ code: 1, timedOut: true }).run }).postIssueComment('a/b', 1, 'hi');
  assert.ok(!slow.ok && slow.code === 'timed_out');
});

test('the lookup of a posted comment filters on the author and the marker, and reads the first match', async () => {
  const run = recorder({ stdout: '123 https://github.com/acme/app/pull/7#issuecomment-123\n' });
  const out = await githubForge(null, { gh: run.run }).findIssueComment('acme/app', 7, 'AI-Bot', MARKER);
  assert.deepEqual(out, { ok: true, comment: { id: 123, url: 'https://github.com/acme/app/pull/7#issuecomment-123' } });
  const args = run.calls[0]?.args ?? [];
  assert.deepEqual(args.slice(0, 3), ['api', '--paginate', 'repos/acme/app/issues/7/comments?per_page=100']);
  assert.ok(args[3]?.includes('== "ai-bot"') && args[3]?.includes(MARKER));
  assert.deepEqual(await githubForge(null, { gh: recorder({ stdout: '' }).run }).findIssueComment('acme/app', 7, 'ai-bot', MARKER),
    { ok: true, comment: null });
  const odd = recorder({ stdout: '' });
  for (const [author, marker] of [['ai"bot', MARKER], ['ai-bot', '<!-- timon-proposal:" or true -->']] as const) {
    assert.equal((await githubForge(null, { gh: odd.run }).findIssueComment('acme/app', 7, author, marker)).ok, false);
  }
  assert.equal(odd.calls.length, 0, 'a value that could close the jq string never reaches gh');
});

const HEAD = 'a'.repeat(40);
const BRANCH_ANSWER = {
  state: 'OPEN', isDraft: false, baseRefName: 'main', headRefName: 'fix/typo', headRefOid: HEAD,
  headRepository: { name: 'app' }, headRepositoryOwner: { login: 'contrib' }, isCrossRepository: true,
  maintainerCanModify: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', url: 'https://github.com/acme/app/pull/7',
  extra: 'dropped',
};

test('the branch of a pull request: one read-only gh pr view, with the fork, its permission and merge state', async () => {
  const run = recorder({ stdout: JSON.stringify(BRANCH_ANSWER) });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run.run }).pullRequestBranch('acme/app', 7);
  assert.deepEqual(out, { ok: true, branch: {
    state: 'open', isDraft: false, baseRef: 'main', headRef: 'fix/typo', headSha: HEAD, headRepository: 'contrib/app',
    isCrossRepository: true, maintainerCanModify: true, mergeable: 'conflicting', mergeStateStatus: 'dirty',
    url: 'https://github.com/acme/app/pull/7',
  } });
  assert.deepEqual(run.calls[0]?.args.slice(0, 4), ['pr', 'view', '7', '--repo=acme/app']);
  assert.match(run.calls[0]?.args[4] ?? '', /^--json=.*maintainerCanModify.*mergeStateStatus/);
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.equal(parsePullRequestBranch(JSON.stringify({ ...BRANCH_ANSWER, headRefOid: 'zz', headRepository: null }))?.headSha, null);
  assert.equal(parsePullRequestBranch(JSON.stringify({ ...BRANCH_ANSWER, url: 'http://x' })), null);
  assert.equal(parsePullRequestBranch('[]'), null);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: '{}' }).run }).pullRequestBranch('../x', 7)).ok, false);
});

test('the size of a repository: one read-only gh api call, a whole number of KiB or a failure', async () => {
  const run = recorder({ stdout: '524288\n' });
  assert.deepEqual(await githubForge('/home/u/.config/gh-work', { gh: run.run }).repositorySize('acme/app'), { ok: true, kib: 524288 });
  assert.deepEqual(run.calls[0]?.args, ['api', 'repos/acme/app', '--jq=.size']);
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  for (const stdout of ['', 'null', '-1', '1.5', '12 MB']) {
    assert.equal((await githubForge(null, { gh: recorder({ stdout }).run }).repositorySize('acme/app')).ok, false, stdout);
  }
  assert.equal((await githubForge(null, { gh: recorder({ code: 1, stderr: 'HTTP 404' }).run }).repositorySize('acme/app')).ok, false);
  const odd = recorder({ stdout: '1' });
  assert.equal((await githubForge(null, { gh: odd.run }).repositorySize('../x')).ok, false);
  assert.equal(odd.calls.length, 0);
});

test('a branch update is one PUT to update-branch with the expected head, a raw string, and nothing else', async () => {
  const run = recorder({ stdout: '{"message":"Updating pull request branch.","url":"https://github.com/acme/app/pull/7"}' });
  const forge = githubForge('/home/u/.config/gh-work', { gh: run.run });
  assert.deepEqual(await forge.updatePullRequestBranch('acme/app', 7, HEAD), { ok: true });
  assert.deepEqual(run.calls[0]?.args, [
    'api', '--method=PUT', 'repos/acme/app/pulls/7/update-branch', `--raw-field=expected_head_sha=${HEAD}`,
  ]);
  assert.equal(run.calls[0]?.opts.env?.GH_TOKEN, undefined);
  for (const [repo, n, sha] of [['acme/..', 7, HEAD], ['acme/app', 0, HEAD], ['acme/app', 7, 'main'], ['acme/app', 7, `${HEAD} --x`]] as const) {
    assert.equal((await forge.updatePullRequestBranch(repo, n, sha)).ok, false, `${repo} ${n} ${sha}`);
  }
  assert.equal(run.calls.length, 1, 'an odd target never reaches gh');
});

test('a refused branch update says why: the head moved, a conflict, no right, without a token', async () => {
  const cases: Array<[string, string]> = [
    ['gh: expected head sha didn\'t match current head ref. (HTTP 422)', 'head_moved'],
    ['gh: merge conflict between base and head (HTTP 422)', 'conflict'],
    [`gh: Resource not accessible by integration (HTTP 403) ${TOKEN}`, 'forbidden'],
    ['gh: Server Error (HTTP 500)', 'gh_failed'],
  ];
  for (const [stderr, code] of cases) {
    const out = await githubForge(null, { gh: recorder({ code: 1, stderr }).run }).updatePullRequestBranch('acme/app', 7, HEAD);
    assert.ok(!out.ok && out.code === code, stderr);
    assert.ok(!out.ok && !out.reason.includes('ghp_'));
  }
});

test('the parents of a commit: one read, every answer a commit', async () => {
  const P = 'b'.repeat(40);
  const run = recorder({ stdout: `${HEAD} ${P}\n` });
  assert.deepEqual(await githubForge(null, { gh: run.run }).commitParents('acme/app', P), { ok: true, parents: [HEAD, P] });
  assert.deepEqual(run.calls[0]?.args.slice(0, 2), ['api', `repos/acme/app/commits/${P}`]);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'main' }).run }).commitParents('acme/app', P)).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({}).run }).commitParents('acme/app', 'HEAD')).ok, false);
});

test('a commit pushed to another repository is a plain refspec, never forced', () => {
  assert.deepEqual(pushCommitArguments('git@github.com:contrib/app.git', HEAD, 'fix/typo'),
    ['--', 'git@github.com:contrib/app.git', `${HEAD}:refs/heads/fix/typo`]);
  for (const [sha, branch] of [[HEAD, '+fix'], [HEAD, 'a:b'], [HEAD, '-f'], ['+' + HEAD, 'fix'], ['main', 'fix'], [HEAD, 'a..b']] as const) {
    assert.throws(() => pushCommitArguments('u', sha, branch), /refusing/, `${sha} ${branch}`);
  }
});

test('the job of a failed check: only a job of the repository\'s own CI, by its https address', () => {
  assert.equal(actionsJobOf('acme/app', 'https://github.com/acme/app/actions/runs/123/job/456'), '456');
  assert.equal(actionsJobOf('acme/app', 'https://github.com/Acme/App/actions/runs/123/job/456/'), '456');
  assert.equal(actionsJobOf('acme/app', 'https://github.com/other/app/actions/runs/123/job/456'), null);
  assert.equal(actionsJobOf('acme/app', 'http://github.com/acme/app/actions/runs/123/job/456'), null);
  assert.equal(actionsJobOf('acme/app', 'https://user:pw@github.com/acme/app/actions/runs/1/job/2'), null);
  assert.equal(actionsJobOf('acme/app', 'https://ci.example.test/acme/app/build/9'), null);
  assert.equal(actionsJobOf('acme/app', 'https://github.com/acme/app/actions/runs/1/job/2;rm -rf'), null);
  assert.equal(actionsJobOf('acme/app', 'not a url'), null);
});

test('the end of a CI log: colours, control and direction marks removed, tokens masked, bounded', () => {
  const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`);
  lines.push('\u001b[31merror\u001b[0m: token ghp_abcdefghijklmnopqrstuvwxyz0123 leaked \u202eevil\u0007');
  const { tail, truncated } = checkLogTail(lines.join('\n'));
  assert.equal(truncated, true);
  const kept = tail.split('\n');
  assert.equal(kept.length, CHECK_LOG_TAIL_LINES);
  assert.equal(kept.at(-1), 'error: token [redacted] leaked evil');
  assert.equal(kept[0], `line ${400 - CHECK_LOG_TAIL_LINES + 1}`);
  const wide = checkLogTail(Array.from({ length: 20 }, () => 'x'.repeat(2_000)).join('\n'));
  assert.ok(wide.tail.length <= CHECK_LOG_TAIL_CHARS);
  assert.equal(wide.truncated, true);
  assert.deepEqual(checkLogTail('short\nlog\n'), { tail: 'short\nlog', truncated: false });
});

test('the failed log of a check: one read-only gh run view of its job, nothing for another repository', async () => {
  const { run, calls } = recorder({ stdout: 'build\tstep\tboom\n' });
  const forge = githubForge('/cfg/gh', { gh: run });
  const out = await forge.failedCheckLog('acme/app', 'https://github.com/acme/app/actions/runs/7/job/99');
  assert.deepEqual(out, { ok: true, log: { tail: 'build\tstep\tboom', truncated: false } });
  assert.deepEqual(calls[0]?.args, ['run', 'view', '--repo=acme/app', '--job=99', '--log-failed']);
  assert.equal(calls[0]?.opts.env?.GH_CONFIG_DIR, '/cfg/gh');
  const other = await forge.failedCheckLog('acme/app', 'https://github.com/evil/app/actions/runs/7/job/99');
  assert.equal(other.ok, false);
  assert.equal(!other.ok && other.code, 'not_actions');
  assert.equal(calls.length, 1, 'no gh call for a check of another repository');
});

test('a failed log larger than the buffer is kept as cut; a failure says why without a token', async () => {
  const cut = recorder({ code: 1, stdout: 'a\nb', stderr: 'stdout maxBuffer length exceeded' });
  const out = await githubForge(null, { gh: cut.run }).failedCheckLog('acme/app', 'https://github.com/acme/app/actions/runs/7/job/9');
  assert.deepEqual(out, { ok: true, log: { tail: 'a\nb', truncated: true } });
  const refused = recorder({ code: 1, stderr: 'HTTP 404 with ghp_abcdefghijklmnopqrstuvwxyz0123' });
  const no = await githubForge(null, { gh: refused.run }).failedCheckLog('acme/app', 'https://github.com/acme/app/actions/runs/7/job/9');
  assert.equal(no.ok, false);
  assert.ok(!no.ok && !no.reason.includes('ghp_'));
});

test('closing an issue is one PATCH with its reason, and a server without `duplicate` closes it as not planned', async () => {
  const closed = JSON.stringify({ html_url: 'https://github.com/acme/app/issues/5', state: 'closed', state_reason: 'not_planned' });
  const run = recorder({ stdout: closed });
  const out = await githubForge('/home/u/.config/gh-work', { gh: run.run }).closeIssue('acme/app', 5, 'not_planned');
  assert.deepEqual(out, { ok: true, url: 'https://github.com/acme/app/issues/5', reason: 'not_planned' });
  assert.deepEqual(run.calls[0]?.args, [
    'api', '--method=PATCH', 'repos/acme/app/issues/5', '--raw-field=state=closed', '--raw-field=state_reason=not_planned',
  ]);
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');

  const calls: string[][] = [];
  const older: GhRunner = async (args) => {
    calls.push(args);
    return args.includes('--raw-field=state_reason=duplicate')
      ? { code: 1, stdout: '', stderr: 'gh: Validation Failed (HTTP 422) state_reason' }
      : { code: 0, stdout: closed, stderr: '' };
  };
  const fallback = await githubForge(null, { gh: older }).closeIssue('acme/app', 6, 'duplicate');
  assert.deepEqual(fallback, { ok: true, url: 'https://github.com/acme/app/issues/5', reason: 'not_planned' });
  assert.equal(calls.length, 2);
});

test('closing never reaches gh for an odd target, and a failure is a refusal without a token', async () => {
  const run = recorder({ stdout: '{}' });
  const forge = githubForge(null, { gh: run.run });
  for (const [repo, n] of [['../x', 1], ['acme/..', 1], ['acme/app', 0], ['acme/app', 1.5]] as const) {
    assert.equal((await forge.closeIssue(repo, n, 'not_planned')).ok, false, `${repo} ${n}`);
  }
  assert.equal((await forge.closeIssue('acme/app', 1, 'completed' as never)).ok, false, 'completed is the pull request\'s');
  assert.equal(run.calls.length, 0);
  const leaked = await githubForge(null, { gh: recorder({ code: 1, stderr: `HTTP 401 ${TOKEN}` }).run }).closeIssue('a/b', 1, 'not_planned');
  assert.ok(!leaked.ok && !leaked.reason.includes('ghp_'));
  const open = JSON.stringify({ html_url: 'https://github.com/a/b/issues/1', state: 'open' });
  assert.equal((await githubForge(null, { gh: recorder({ stdout: open }).run }).closeIssue('a/b', 1, 'not_planned')).ok, false);
});

test('deleting a remote branch is leased on the commit it must end on, and names nothing else', () => {
  assert.deepEqual(deleteBranchArguments('git@github.com:acme/app.git', 'feat/x', HEAD),
    [`--force-with-lease=refs/heads/feat/x:${HEAD}`, '--', 'git@github.com:acme/app.git', ':refs/heads/feat/x']);
  assert.throws(() => deleteBranchArguments('git@github.com:acme/app.git', '-x', HEAD), /unusual name/);
  assert.throws(() => deleteBranchArguments('git@github.com:acme/app.git', 'a:b', HEAD), /unusual name/);
  assert.throws(() => deleteBranchArguments('git@github.com:acme/app.git', 'feat/x', 'HEAD'), /commit it must end on/);
});

test('a pull request from a fork names its head as owner:branch', async () => {
  const run = recorder({ stdout: 'https://github.com/acme/app/pull/44\n' });
  const forge = githubForge('/home/u/.config/gh-work', { gh: run.run });
  const out = await forge.createPullRequest({ repo: 'acme/app', base: 'main', head: 'feat/x', title: 't', body: 'b', headOwner: 'bot-fork' });
  assert.equal(out.ok, true);
  assert.ok(run.calls[0]?.args.includes('--head=bot-fork:feat/x'));
  assert.ok(run.calls[0]?.args.includes('--repo=acme/app'), 'the pull request lives on the target');
  const bad = recorder({});
  const refused = await githubForge(null, { gh: bad.run }).createPullRequest({ repo: 'acme/app', base: 'main', head: 'x', title: 't', body: '', headOwner: '--evil' });
  assert.equal(refused.ok, false);
  assert.equal(bad.calls.length, 0, 'a bad owner never reaches gh');
});

test('the rights on a repository: push allowed, push refused, repository missing, unreadable', async () => {
  const yes = recorder({ stdout: 'true\n' });
  assert.deepEqual(await githubForge('/home/u/.config/gh-work', { gh: yes.run }).repositoryAccess('acme/app'), { ok: true, exists: true, canPush: true });
  assert.equal(yes.calls[0]?.args[0], 'api');
  assert.equal(yes.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.deepEqual(await githubForge(null, { gh: recorder({ stdout: 'false\n' }).run }).repositoryAccess('acme/app'), { ok: true, exists: true, canPush: false });
  assert.deepEqual(
    await githubForge(null, { gh: recorder({ code: 1, stderr: 'gh: Not Found (HTTP 404)' }).run }).repositoryAccess('bot/app'),
    { ok: true, exists: false },
  );
  assert.equal((await githubForge(null, { gh: recorder({ code: 1, stderr: 'boom' }).run }).repositoryAccess('acme/app')).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'null' }).run }).repositoryAccess('acme/app')).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({}).run }).repositoryAccess('not a repo')).ok, false);
});

test('forking asks the forge to create the fork and reads the name it answers', async () => {
  const run = recorder({ stdout: 'bot/app-1\n' });
  assert.deepEqual(
    await githubForge('/home/u/.config/gh-work', { gh: run.run }).forkRepository('acme/app'),
    { ok: true, fullName: 'bot/app-1' },
  );
  assert.deepEqual(run.calls[0]?.args, ['api', '-X', 'POST', 'repos/acme/app/forks', '--jq', '.full_name']);
  assert.equal((await githubForge(null, { gh: recorder({ code: 1, stderr: 'denied' }).run }).forkRepository('acme/app')).ok, false);
  assert.equal((await githubForge(null, { gh: recorder({ stdout: 'null' }).run }).forkRepository('acme/app')).ok, false);
});

test('git network calls use the project gh account as credential helper, and only then', async () => {
  const run = recorder({});
  await gitTransport('/repo', { git: run.run }, '/home/u/.config/gh-work').pushBranch('https://github.com/bot/app.git', 'feat/x');
  const args = run.calls[0]!.args;
  assert.deepEqual(args.slice(0, 5), ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', '-C']);
  assert.equal(run.calls[0]?.opts.env?.GH_CONFIG_DIR, '/home/u/.config/gh-work');
  assert.ok(!JSON.stringify(args).includes('ghp_'));
  const plain = recorder({});
  await gitTransport('/repo', { git: plain.run }).fetchBranch('u', 'main', 'refs/remotes/origin/main');
  assert.ok(!plain.calls[0]?.args.includes('credential.helper='), 'no project account: git keeps its own helpers');
});
