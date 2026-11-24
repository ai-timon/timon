/**
 * The page of a pull request as `gh` prints it: fixtures shaped like the
 * answers of `gh pr view --json` and of the review threads' GraphQL query,
 * and the bounds every text written on the forge goes through.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { GhRunner } from './gh.js';
import {
  githubPullPageReader, githubUrl, parsePullRequestPage, parseReviewThreadsPage, PULL_PAGE_FIELDS, VIEW_BODY_LIMIT,
  VIEW_COMMENT_LIMIT, VIEW_FILE_LIMIT, VIEW_THREAD_COMMENTS, VIEW_TIMELINE_LIMIT, viewText,
} from './forge-pull-view.js';

const SHA = 'b'.repeat(40);

const PAGE = {
  number: 42,
  title: 'Add a dark theme',
  url: 'https://github.com/acme/widgets/pull/42',
  state: 'OPEN',
  isDraft: false,
  author: { login: 'stranger', name: 'A Stranger', is_bot: false },
  createdAt: '2026-11-17T10:00:00Z',
  updatedAt: '2026-11-18T09:30:00Z',
  mergedAt: null,
  closedAt: null,
  baseRefName: 'main',
  headRefName: 'dark-theme',
  headRefOid: SHA,
  headRepository: { name: 'widgets' },
  headRepositoryOwner: { login: 'stranger' },
  isCrossRepository: true,
  maintainerCanModify: true,
  mergeable: 'CONFLICTING',
  mergeStateStatus: 'DIRTY',
  reviewDecision: 'CHANGES_REQUESTED',
  additions: 120,
  deletions: 8,
  changedFiles: 2,
  body: '## Why\n\nThe app hurts at night. <script>alert(1)</script>',
  labels: [{ name: 'ui', color: 'A2EEEF' }, { name: 'bad', color: 'url(x)' }],
  milestone: { number: 3, title: '0.2', url: 'https://github.com/acme/widgets/milestone/3' },
  assignees: [{ login: 'maintainer' }],
  reviewRequests: [{ __typename: 'User', login: 'reviewer' }, { __typename: 'Team', name: 'Core', slug: 'core', organization: { login: 'acme' } }],
  closingIssuesReferences: [{ number: 7, url: 'https://github.com/acme/widgets/issues/7', repository: { name: 'widgets', owner: { login: 'acme' } } }],
  comments: [
    { author: { login: 'maintainer' }, body: 'Thanks!', createdAt: '2026-11-17T12:00:00Z', url: 'https://github.com/acme/widgets/pull/42#issuecomment-1' },
    { author: { login: 'spammer' }, body: 'buy now', createdAt: '2026-11-17T13:00:00Z', url: 'https://evil.example/x', isMinimized: true },
  ],
  reviews: [
    { author: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'A few things.', submittedAt: '2026-11-17T11:00:00Z' },
    { author: { login: 'reviewer' }, state: 'COMMENTED', body: '', submittedAt: '2026-11-17T11:00:01Z' },
    { author: { login: 'other' }, state: 'APPROVED', body: '', submittedAt: '2026-11-18T08:00:00Z' },
  ],
  commits: [
    { oid: SHA, messageHeadline: 'feat: dark theme', authoredDate: '2026-11-17T09:00:00Z', authors: [{ login: 'stranger', name: 'A Stranger' }] },
    { oid: 'not-a-sha', messageHeadline: 'dropped' },
  ],
  files: [
    { path: 'src/theme.ts', additions: 100, deletions: 2 },
    { path: 'README.md', additions: 20, deletions: 6 },
  ],
  statusCheckRollup: [
    {
      __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', workflowName: 'CI',
      startedAt: '2026-11-17T09:01:00Z', completedAt: '2026-11-17T09:04:30Z',
      detailsUrl: 'https://github.com/acme/widgets/actions/runs/1/job/2',
    },
    { __typename: 'StatusContext', context: 'deploy/preview', state: 'SUCCESS', targetUrl: 'https://preview.example/42' },
  ],
};

test('the page keeps what GitHub shows, read as data', () => {
  const page = parsePullRequestPage(JSON.stringify(PAGE));
  assert.ok(page);
  assert.equal(page.number, 42);
  assert.equal(page.state, 'open');
  assert.equal(page.author, 'stranger');
  assert.equal(page.headRepository, 'stranger/widgets');
  assert.equal(page.isCrossRepository, true);
  assert.equal(page.mergeable, 'conflicting');
  assert.equal(page.mergeStateStatus, 'dirty');
  assert.equal(page.reviewDecision, 'changes_requested');
  assert.equal(page.headSha, SHA);
  // The text is kept as written: the window renders it without raw HTML.
  assert.match(page.body, /<script>/);
  assert.deepEqual(page.labels, [{ name: 'ui', color: 'a2eeef' }, { name: 'bad', color: null }]);
  assert.deepEqual(page.milestone, { title: '0.2', url: 'https://github.com/acme/widgets/milestone/3' });
  assert.deepEqual(page.assignees, ['maintainer']);
  assert.deepEqual(page.reviewRequests, ['reviewer', 'acme/core']);
  assert.deepEqual(page.closingIssues, [{ repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/issues/7' }]);
  assert.deepEqual(page.files, [
    { path: 'src/theme.ts', additions: 100, deletions: 2 },
    { path: 'README.md', additions: 20, deletions: 6 },
  ]);
  assert.deepEqual(page.commits, [{
    sha: SHA, headline: 'feat: dark theme', author: 'stranger', date: '2026-11-17T09:00:00Z',
    url: `https://github.com/acme/widgets/commit/${SHA}`,
  }]);
});

test('the timeline is oldest first, folds empty comment reviews, and hides a minimized comment', () => {
  const page = parsePullRequestPage(JSON.stringify(PAGE))!;
  assert.deepEqual(page.timeline.map((i) => [i.kind, i.author, i.kind === 'review' ? i.state : null]), [
    ['review', 'reviewer', 'changes_requested'],
    ['comment', 'maintainer', null],
    ['comment', 'spammer', null],
    ['review', 'other', 'approved'],
  ]);
  const spam = page.timeline[2]!;
  assert.equal(spam.kind === 'comment' && spam.hidden, true);
  assert.equal(spam.body, '');
  // Not a GitHub address: no link.
  assert.equal(spam.kind === 'comment' ? spam.url : 'x', null);
  assert.equal(page.timelineMore, 0);
});

test('checks keep their timing, and only a GitHub address as their link', () => {
  const page = parsePullRequestPage(JSON.stringify(PAGE))!;
  assert.deepEqual(page.checks, [
    {
      name: 'test', status: 'fail', url: 'https://github.com/acme/widgets/actions/runs/1/job/2',
      workflow: 'CI', startedAt: '2026-11-17T09:01:00Z', completedAt: '2026-11-17T09:04:30Z',
    },
    { name: 'deploy/preview', status: 'pass', url: null, workflow: null, startedAt: null, completedAt: null },
  ]);
});

test('every list past its bound says how many it left out', () => {
  const many = {
    ...PAGE,
    body: 'x'.repeat(VIEW_BODY_LIMIT + 10),
    comments: Array.from({ length: VIEW_TIMELINE_LIMIT + 5 }, (_, i) => ({
      author: { login: `c${i}` }, body: i === 0 ? 'y'.repeat(VIEW_COMMENT_LIMIT + 1) : `comment ${i}`,
      createdAt: `2026-11-17T10:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
    })),
    reviews: [],
    files: Array.from({ length: VIEW_FILE_LIMIT + 3 }, (_, i) => ({ path: `f${i}`, additions: 1, deletions: 0 })),
  };
  const page = parsePullRequestPage(JSON.stringify(many))!;
  assert.equal(page.body.length, VIEW_BODY_LIMIT);
  assert.equal(page.bodyTruncated, true);
  assert.equal(page.timeline.length, VIEW_TIMELINE_LIMIT);
  assert.equal(page.timelineMore, 5);
  // The latest are kept: the first five comments are the ones left out.
  assert.equal(page.timeline[0]!.author, 'c5');
  assert.equal(page.files.length, VIEW_FILE_LIMIT);
  assert.equal(page.filesMore, 3);
});

test('a text loses its control characters and anything shaped like a token', () => {
  assert.deepEqual(viewText('a\u0007b ghp_abcdefghijklmnopqrstuvwxyz0123 c', 100), { text: 'ab [redacted] c', truncated: false });
  assert.deepEqual(viewText(42, 10), { text: '', truncated: false });
});

test('only an https address on a GitHub host survives', () => {
  assert.equal(githubUrl('https://github.com/acme/widgets'), 'https://github.com/acme/widgets');
  assert.equal(githubUrl('https://avatars.githubusercontent.com/u/1'), 'https://avatars.githubusercontent.com/u/1');
  assert.equal(githubUrl('http://github.com/acme'), null);
  assert.equal(githubUrl('javascript:alert(1)'), null);
  assert.equal(githubUrl('https://github.com.evil.example/x'), null);
  assert.equal(githubUrl('https://evilgithub.com/x'), null);
  assert.equal(githubUrl('https://user:pass@github.com/x'), null);
});

test('an answer that is not a pull request is refused', () => {
  assert.equal(parsePullRequestPage('not json'), null);
  assert.equal(parsePullRequestPage(JSON.stringify({ ...PAGE, url: 'https://evil.example/pull/1' })), null);
  assert.equal(parsePullRequestPage(JSON.stringify({ ...PAGE, state: 'WHATEVER' })), null);
  assert.equal(parsePullRequestPage(JSON.stringify({ ...PAGE, number: -1 })), null);
});

const THREADS = {
  data: { repository: { pullRequest: { reviewThreads: { totalCount: 2, nodes: [
    {
      isResolved: false, isOutdated: false, path: 'src/theme.ts', line: 12, originalLine: 10,
      comments: { totalCount: 2, nodes: [
        { author: { login: 'reviewer' }, body: 'Use a token here.', createdAt: '2026-11-17T11:00:00Z', url: 'https://github.com/acme/widgets/pull/42#discussion_r1' },
        { author: { login: 'stranger' }, body: 'Done.', createdAt: '2026-11-17T12:00:00Z', url: 'https://github.com/acme/widgets/pull/42#discussion_r2' },
      ] },
    },
    {
      isResolved: true, isOutdated: true, path: 'README.md', line: null, originalLine: 3,
      comments: { totalCount: VIEW_THREAD_COMMENTS + 4, nodes: [
        { author: null, body: 'typo', createdAt: '2026-11-17T11:05:00Z', url: 'https://github.com/acme/widgets/pull/42#discussion_r3' },
      ] },
    },
  ] } } } },
};

test('review threads come resolved or not, with their place and their comments', () => {
  const read = parseReviewThreadsPage(JSON.stringify(THREADS));
  assert.ok(read);
  assert.equal(read.threadsMore, 0);
  assert.deepEqual(read.threads.map((t) => [t.path, t.line, t.resolved, t.outdated, t.comments.length, t.commentsMore]), [
    ['src/theme.ts', 12, false, false, 2, 0],
    // An outdated thread keeps the line it was written on.
    ['README.md', 3, true, true, 1, VIEW_THREAD_COMMENTS + 3],
  ]);
  assert.equal(read.threads[1]!.comments[0]!.author, null);
  assert.equal(parseReviewThreadsPage('{"data":{}}'), null);
});

test('the reader runs two reads of gh and nothing else', async () => {
  const calls: string[][] = [];
  const gh: GhRunner = async (args) => {
    calls.push(args);
    if (args[0] === 'pr') return { code: 0, stdout: JSON.stringify(PAGE), stderr: '' };
    return { code: 0, stdout: JSON.stringify(THREADS), stderr: '' };
  };
  const reader = githubPullPageReader(null, { gh });
  const page = await reader.pullRequestPage('acme/widgets', 42);
  assert.equal(page.ok, true);
  const threads = await reader.pullRequestThreadsPage('acme/widgets', 42);
  assert.equal(threads.ok, true);
  assert.deepEqual(calls[0], ['pr', 'view', '42', '--repo=acme/widgets', `--json=${PULL_PAGE_FIELDS}`]);
  assert.equal(calls[1]![0], 'api');
  assert.equal(calls[1]![1], 'graphql');
  assert.ok(!calls[1]!.some((a) => /mutation/i.test(a)));
  // A repository that could climb out of an API path is never asked.
  assert.equal((await reader.pullRequestPage('../x', 1)).ok, false);
  assert.equal(calls.length, 2);
});

test('a failed read says why, without a token', async () => {
  const gh: GhRunner = async () => ({ code: 1, stdout: '', stderr: 'HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123' });
  const out = await githubPullPageReader(null, { gh }).pullRequestPage('acme/widgets', 42);
  assert.equal(out.ok, false);
  assert.doesNotMatch(JSON.stringify(out), /ghp_/);
});
