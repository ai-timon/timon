/**
 * A pull request's whole page, read only, as GitHub shows it: the header, the
 * conversation (comments, reviews and the review threads grouped by line),
 * the commits, the checks and the files. The detail window of the Pull
 * requests widget paints it (`pull-request-view.ts`).
 *
 * Two calls to `gh`, both reads: `gh pr view --json` for the page, and one
 * GraphQL query for the review threads (`gh pr view` does not give their
 * resolution). Nothing touches git: the contributor's branch never reaches
 * this machine.
 *
 * Every text here was written by someone on the forge: it is bounded, its
 * control characters dropped, and a list cut past its bound says how many it
 * left out (`…More`) rather than ending silently. Every address kept is an
 * https one on a GitHub host; anything else becomes null.
 */
import { z } from 'zod';
import {
  boundedText, checkOf, CLOSING_ISSUE_LIMIT, COMMIT_SHA, GITHUB_REPO, headRepositoryOf, httpsUrl, IssueReferenceSchema,
  itemsOf, jsonOf, LABEL_LIMIT, LabelSchema, LoginSchema, MergeStateSchema, maskedSecrets, redactedOutput,
  type ForgeLabel, type ForgeReadFailure, type IssueReference, type MergeStateStatus, type PullRequestCheck,
  type PullRequestState,
} from './forge.js';
import { ghEnv, type GhRunner } from './gh.js';
import { getHost } from './index.js';
import type { ExecResult } from './types.js';

/** Most characters of the description, of one comment, of one thread comment. */
export const VIEW_BODY_LIMIT = 20_000;
export const VIEW_COMMENT_LIMIT = 8_000;
export const VIEW_THREAD_COMMENT_LIMIT = 4_000;
/** Most entries kept of each list. */
export const VIEW_TIMELINE_LIMIT = 100;
export const VIEW_THREAD_LIMIT = 50;
export const VIEW_THREAD_COMMENTS = 20;
export const VIEW_COMMIT_LIMIT = 250;
export const VIEW_FILE_LIMIT = 300;
export const VIEW_CHECK_LIMIT = 100;
export const VIEW_PEOPLE_LIMIT = 20;
/** Bytes `gh` may print for one page or the threads: a page of 300 files and
 *  250 commits stays far below. */
const VIEW_BUFFER = 8 * 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;
/** Review threads asked of the forge in one call. */
const THREAD_PAGE = 100;

export type ViewText = { text: string; truncated: boolean };

export type ViewComment = {
  kind: 'comment';
  author: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
  url: string | null;
  /** Hidden by a maintainer on the forge (spam, off topic): its text is not kept. */
  hidden: boolean;
};

export const REVIEW_STATES = ['approved', 'changes_requested', 'commented', 'dismissed', 'pending'] as const;
export type ViewReviewState = (typeof REVIEW_STATES)[number];

export type ViewReview = {
  kind: 'review';
  author: string | null;
  state: ViewReviewState;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
};

export type ViewTimelineItem = ViewComment | ViewReview;

export type ViewThreadComment = {
  author: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
  url: string | null;
};

export type ViewThread = {
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: ViewThreadComment[];
  commentsMore: number;
};

export type ViewCommit = {
  sha: string;
  headline: string;
  author: string | null;
  date: string;
  url: string | null;
};

export type ViewFile = { path: string; additions: number; deletions: number };

export type ViewCheck = PullRequestCheck & {
  workflow: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type ViewMilestone = { title: string; url: string | null };

export type PullRequestPage = {
  number: number;
  title: string;
  url: string;
  state: PullRequestState;
  isDraft: boolean;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  closedAt: string | null;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  headOwner: string | null;
  /** `owner/name` of the branch's repository, null for a deleted fork. */
  headRepository: string | null;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  mergeStateStatus: MergeStateStatus;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string;
  bodyTruncated: boolean;
  labels: ForgeLabel[];
  milestone: ViewMilestone | null;
  assignees: string[];
  assigneesMore: number;
  /** Logins, and `org/team` for a team. */
  reviewRequests: string[];
  reviewRequestsMore: number;
  closingIssues: IssueReference[];
  timeline: ViewTimelineItem[];
  /** The earliest entries left out: the latest ones are kept. */
  timelineMore: number;
  commits: ViewCommit[];
  commitsMore: number;
  files: ViewFile[];
  filesMore: number;
  checks: ViewCheck[];
  checksMore: number;
};

export type ReviewThreadsPage = { threads: ViewThread[]; threadsMore: number };

export type PullRequestPageOutcome = { ok: true; page: PullRequestPage } | ForgeReadFailure;
export type ReviewThreadsPageOutcome = { ok: true; value: ReviewThreadsPage } | ForgeReadFailure;

/** A pull request's page and its review threads, read only. */
export interface ForgePullPageReader {
  pullRequestPage(repo: string, number: number): Promise<PullRequestPageOutcome>;
  pullRequestThreadsPage(repo: string, number: number): Promise<ReviewThreadsPageOutcome>;
}

/** What `gh pr view --json` is asked for the page. */
export const PULL_PAGE_FIELDS = [
  'number', 'title', 'url', 'state', 'isDraft', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'closedAt',
  'baseRefName', 'headRefName', 'headRefOid', 'headRepository', 'headRepositoryOwner', 'isCrossRepository',
  'maintainerCanModify', 'mergeable', 'mergeStateStatus', 'reviewDecision', 'additions', 'deletions', 'changedFiles',
  'body', 'labels', 'milestone', 'assignees', 'reviewRequests', 'closingIssuesReferences', 'comments', 'reviews',
  'commits', 'files', 'statusCheckRollup',
].join(',');

const GITHUB_HOST = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com)$/i;

/** `value` when it is an https address on a GitHub host, without
 *  credentials; null otherwise. */
export function githubUrl(value: unknown): string | null {
  const https = httpsUrl(value);
  if (!https) return null;
  let url: URL;
  try { url = new URL(https); } catch { return null; }
  if (url.username || url.password || url.port || !GITHUB_HOST.test(url.hostname)) return null;
  return https;
}

/** A forge text, its control characters dropped, cut at `max` and said so. */
export function viewText(value: unknown, max: number): ViewText {
  const clean = boundedText(maskedSecrets(typeof value === 'string' ? value : ''), Number.POSITIVE_INFINITY);
  return clean.length > max ? { text: clean.slice(0, max), truncated: true } : { text: clean, truncated: false };
}

function isoDate(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?$/.test(value) ? value : '';
}

function optionalDate(value: unknown): string | null {
  return isoDate(value) || null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** The entries of `value` `parse` accepts, the first `max` of them, and how
 *  many valid ones were left out. */
function bounded<T>(value: unknown, parse: (entry: unknown) => T | null, max: number): { items: T[]; more: number } {
  const nodes = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { nodes?: unknown }).nodes
    : value;
  if (!Array.isArray(nodes)) return { items: [], more: 0 };
  const all = nodes.map(parse).filter((x): x is T => x !== null);
  return { items: all.slice(0, max), more: Math.max(0, all.length - max) };
}

const loginOf = (value: unknown): string | null => {
  const parsed = LoginSchema.safeParse(value);
  return parsed.success ? boundedText(parsed.data, 100) : null;
};

function commentOf(entry: unknown): ViewComment | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const hidden = o.isMinimized === true;
  const body = hidden ? { text: '', truncated: false } : viewText(o.body, VIEW_COMMENT_LIMIT);
  return {
    kind: 'comment', author: loginOf(o.author), body: body.text, bodyTruncated: body.truncated,
    createdAt: isoDate(o.createdAt), url: githubUrl(o.url), hidden,
  };
}

const ReviewStateSchema = z.string().transform((s) => s.toLowerCase()).pipe(z.enum(REVIEW_STATES));

function reviewOf(entry: unknown): ViewReview | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const state = ReviewStateSchema.safeParse(o.state);
  if (!state.success) return null;
  const body = viewText(o.body, VIEW_COMMENT_LIMIT);
  // A "commented" review with no text only carries line comments, which the
  // threads show: GitHub folds it the same way.
  if ((state.data === 'commented' || state.data === 'pending') && body.text.trim() === '') return null;
  return {
    kind: 'review', author: loginOf(o.author), state: state.data, body: body.text, bodyTruncated: body.truncated,
    createdAt: isoDate(o.submittedAt) || isoDate(o.createdAt),
  };
}

function commitOf(prUrl: string) {
  // The commit's page sits beside the pull request's: `…/owner/name/commit/<sha>`.
  const repoUrl = prUrl.replace(/\/pull\/\d+\/?$/, '');
  return (entry: unknown): ViewCommit | null => {
    if (typeof entry !== 'object' || entry === null) return null;
    const o = entry as Record<string, unknown>;
    const sha = typeof o.oid === 'string' && COMMIT_SHA.test(o.oid) ? o.oid : null;
    if (!sha) return null;
    const authors = Array.isArray(o.authors) ? o.authors : [];
    const first = authors[0] as Record<string, unknown> | undefined;
    const author = first
      ? (typeof first.login === 'string' && first.login ? first.login : typeof first.name === 'string' ? first.name : '')
      : '';
    return {
      sha,
      headline: boundedText(o.messageHeadline, 300),
      author: boundedText(author, 100) || null,
      date: isoDate(o.authoredDate) || isoDate(o.committedDate),
      url: githubUrl(`${repoUrl}/commit/${sha}`),
    };
  };
}

function fileOf(entry: unknown): ViewFile | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const path = boundedText(o.path, 500);
  if (!path) return null;
  return { path, additions: count(o.additions), deletions: count(o.deletions) };
}

function viewCheckOf(entry: unknown): ViewCheck | null {
  const check = checkOf(entry);
  if (!check) return null;
  const o = entry as Record<string, unknown>;
  return {
    ...check,
    url: githubUrl(check.url),
    workflow: boundedText(o.workflowName, 120) || null,
    startedAt: optionalDate(o.startedAt),
    completedAt: optionalDate(o.completedAt),
  };
}

function personOf(entry: unknown): string | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  if (typeof o.login === 'string' && o.login) return boundedText(o.login, 100);
  // A team asked for a review: `org/slug` when gh gives the organisation.
  const team = typeof o.slug === 'string' && o.slug ? o.slug : typeof o.name === 'string' ? o.name : '';
  if (!team) return null;
  const org = typeof o.organization === 'object' && o.organization !== null
    ? (o.organization as { login?: unknown }).login
    : null;
  return boundedText(typeof org === 'string' && org ? `${org}/${team}` : team, 140);
}

function milestoneOf(value: unknown): ViewMilestone | null {
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  const title = boundedText(o.title, 200);
  return title ? { title, url: githubUrl(o.url) } : null;
}

/** The page `gh pr view --json <PULL_PAGE_FIELDS>` answers, or null when it
 *  is not one: a number, a state and an https address are the least. */
export function parsePullRequestPage(stdout: string): PullRequestPage | null {
  const parsed = jsonOf(stdout);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.number !== 'number' || !Number.isSafeInteger(o.number) || o.number <= 0) return null;
  const url = githubUrl(o.url);
  const states: Record<string, PullRequestState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
  const state = typeof o.state === 'string' ? states[o.state] : undefined;
  if (!url || !state) return null;
  const reviews: Record<string, PullRequestPage['reviewDecision']> = {
    APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required',
  };
  const oid = typeof o.headRefOid === 'string' ? o.headRefOid : '';
  const body = viewText(o.body, VIEW_BODY_LIMIT);
  const comments = bounded(o.comments, commentOf, Number.MAX_SAFE_INTEGER).items;
  const reviewItems = bounded(o.reviews, reviewOf, Number.MAX_SAFE_INTEGER).items;
  // Oldest first, as the forge shows them; past the bound, the latest are kept.
  const timeline = [...comments, ...reviewItems].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const keptTimeline = timeline.slice(-VIEW_TIMELINE_LIMIT);
  const assignees = bounded(o.assignees, personOf, VIEW_PEOPLE_LIMIT);
  const requests = bounded(o.reviewRequests, personOf, VIEW_PEOPLE_LIMIT);
  const commits = bounded(o.commits, commitOf(url), VIEW_COMMIT_LIMIT);
  const files = bounded(o.files, fileOf, VIEW_FILE_LIMIT);
  const checks = bounded(o.statusCheckRollup, viewCheckOf, VIEW_CHECK_LIMIT);
  return {
    number: o.number,
    title: boundedText(o.title, 500),
    url,
    state,
    isDraft: o.isDraft === true,
    author: loginOf(o.author),
    createdAt: isoDate(o.createdAt),
    updatedAt: isoDate(o.updatedAt),
    mergedAt: optionalDate(o.mergedAt),
    closedAt: optionalDate(o.closedAt),
    baseRef: boundedText(o.baseRefName, 255),
    headRef: boundedText(o.headRefName, 255),
    headSha: COMMIT_SHA.test(oid) ? oid : null,
    headOwner: loginOf(o.headRepositoryOwner),
    headRepository: headRepositoryOf(o.headRepositoryOwner, o.headRepository),
    isCrossRepository: o.isCrossRepository === true,
    maintainerCanModify: o.maintainerCanModify === true,
    mergeable: o.mergeable === 'MERGEABLE' ? 'mergeable' : o.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    mergeStateStatus: MergeStateSchema.parse(o.mergeStateStatus),
    reviewDecision: typeof o.reviewDecision === 'string' ? reviews[o.reviewDecision] ?? null : null,
    additions: count(o.additions),
    deletions: count(o.deletions),
    changedFiles: count(o.changedFiles),
    body: body.text,
    bodyTruncated: body.truncated,
    labels: itemsOf(o.labels, LabelSchema, LABEL_LIMIT),
    milestone: milestoneOf(o.milestone),
    assignees: assignees.items,
    assigneesMore: assignees.more,
    reviewRequests: requests.items,
    reviewRequestsMore: requests.more,
    closingIssues: itemsOf(o.closingIssuesReferences, IssueReferenceSchema, CLOSING_ISSUE_LIMIT),
    timeline: keptTimeline,
    timelineMore: timeline.length - keptTimeline.length,
    commits: commits.items,
    commitsMore: commits.more,
    files: files.items,
    filesMore: files.more,
    checks: checks.items,
    checksMore: checks.more,
  };
}

const ThreadsAnswerSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({ totalCount: z.int().nonnegative(), nodes: z.array(z.unknown()) }),
      }),
    }),
  }),
});

function threadCommentOf(entry: unknown): ViewThreadComment | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  const body = viewText(o.body, VIEW_THREAD_COMMENT_LIMIT);
  return { author: loginOf(o.author), body: body.text, bodyTruncated: body.truncated, createdAt: isoDate(o.createdAt), url: githubUrl(o.url) };
}

function threadOf(entry: unknown): ViewThread | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const o = entry as Record<string, unknown>;
  if (typeof o.isResolved !== 'boolean') return null;
  const connection = typeof o.comments === 'object' && o.comments !== null ? o.comments as Record<string, unknown> : {};
  const comments = bounded(connection.nodes, threadCommentOf, VIEW_THREAD_COMMENTS);
  const line = [o.line, o.originalLine].find((l): l is number => typeof l === 'number' && Number.isSafeInteger(l) && l > 0) ?? null;
  return {
    path: boundedText(o.path, 500) || null,
    line,
    resolved: o.isResolved,
    outdated: o.isOutdated === true,
    comments: comments.items,
    commentsMore: Math.max(comments.more, count(connection.totalCount) - comments.items.length),
  };
}

/** Every review thread a GraphQL answer holds, resolved or not, or null when
 *  the answer is not one. */
export function parseReviewThreadsPage(stdout: string): ReviewThreadsPage | null {
  const parsed = ThreadsAnswerSchema.safeParse(jsonOf(stdout));
  if (!parsed.success) return null;
  const connection = parsed.data.data.repository.pullRequest.reviewThreads;
  const read = bounded(connection.nodes, threadOf, VIEW_THREAD_LIMIT);
  return {
    threads: read.items,
    threadsMore: Math.max(read.more, connection.totalCount - read.items.length),
  };
}

const REVIEW_THREADS_PAGE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${THREAD_PAGE}) {
        totalCount
        nodes {
          isResolved isOutdated path line originalLine
          comments(first: ${VIEW_THREAD_COMMENTS}) { totalCount nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}`;

const hostGh: GhRunner = (args, opts) => getHost().execAsync('gh', args, opts);

/** GitHub's page of a pull request through `gh`, signed in with the
 *  project's config folder. */
export function githubPullPageReader(configDir: string | null, runners: { gh?: GhRunner } = {}): ForgePullPageReader {
  const gh = runners.gh ?? hostGh;
  const read = async (args: string[]): Promise<{ ok: true; result: ExecResult } | ForgeReadFailure> => {
    let result: ExecResult;
    try {
      result = await gh(args, { env: ghEnv(configDir), timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: VIEW_BUFFER });
    } catch {
      return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
    }
    if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
    if (result.code !== 0) {
      return { ok: false, code: 'gh_failed', reason: redactedOutput(result.stderr || result.stdout) || `gh exited with code ${result.code}` };
    }
    return { ok: true, result };
  };
  const badTarget = (repo: string, number: number): ForgeReadFailure | null =>
    !GITHUB_REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..') || !Number.isSafeInteger(number) || number <= 0
      ? { ok: false, code: 'unexpected_answer', reason: 'not a pull request of a GitHub repository' }
      : null;
  return {
    async pullRequestPage(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const out = await read(['pr', 'view', String(number), `--repo=${repo}`, `--json=${PULL_PAGE_FIELDS}`]);
      if (!out.ok) return out;
      const page = parsePullRequestPage(out.result.stdout);
      return page
        ? { ok: true, page }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the page of a pull request' };
    },
    async pullRequestThreadsPage(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const [owner = '', name = ''] = repo.split('/');
      // `--raw-field` keeps each value a string: `-F` would read a value
      // starting with "@" as a file. The repository was checked above.
      const out = await read([
        'api', 'graphql',
        `--raw-field=query=${REVIEW_THREADS_PAGE_QUERY}`,
        `--raw-field=owner=${owner}`,
        `--raw-field=name=${name}`,
        `--field=number=${number}`,
      ]);
      if (!out.ok) return out;
      const value = parseReviewThreadsPage(out.result.stdout);
      return value
        ? { ok: true, value }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the review threads of a pull request' };
    },
  };
}
