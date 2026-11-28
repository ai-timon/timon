/**
 * The forge, as the daemon reaches it to open a pull request
 * (`docs/KANBAN-PR-PIPELINE.md` §2.5, §7.2): the account `gh` signs in as, the
 * pull request it creates or reads back, and the three git gestures that talk
 * to the remote (read a remote branch, fetch, push). It also reads, and only
 * reads, the open pull requests of a repository, contributors' ones included:
 * their metadata and their diff as text, never their branch; and the issues
 * of a repository, a list filtered by label and one issue's text.
 *
 * It writes two things on the forge, and only for a publication a person
 * validated (`forge-proposals.ts`), which checks the account before calling
 * it: a comment on an issue or a pull request, and the update of a pull
 * request's branch that GitHub performs on its side (`update-branch`, never a
 * merge on this machine).
 *
 * This is the only place `gh` and the network side of `git` are called for a
 * pull request. Every command goes through a runner the tests replace: nothing
 * in the test suite reaches GitHub or pushes anywhere.
 *
 * Two rules hold here, whatever the caller asks:
 *
 * - **Never a forced push.** The push is built here, from a branch name, as a
 *   plain `refs/heads/<b>:refs/heads/<b>` refspec; `assertNoForce` refuses any
 *   argument that would overwrite, delete or mirror a remote branch, so a
 *   branch already pushed is never rewritten.
 * - **No secret in an answer.** What `gh` or `git` print is shortened and every
 *   token-shaped string masked before it reaches a caller, a log or an error.
 */
import { z } from 'zod';
import { urlAuthority } from '../git-remote-url.js';
import { ghEnv, ghLogin, type GhLoginOutcome, type GhRunner } from './gh.js';
import { getHost } from './index.js';
import type { ExecOpts, ExecResult } from './types.js';

export type GitRunner = (args: string[], opts: ExecOpts) => Promise<ExecResult>;

const hostGh: GhRunner = (args, opts) => getHost().execAsync('gh', args, opts);
const hostGit: GitRunner = (args, opts) => getHost().execAsync('git', args, opts);

export type ForgeRunners = { gh?: GhRunner; git?: GitRunner };

const GH_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 120_000;

/** `text` with every token-shaped string and URL credential masked. */
export function maskedSecrets(text: string): string {
  return text
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[redacted]')
    .replace(/(https?:\/\/)[^\s/@]+@/g, '$1[redacted]@');
}

/** What a command said, short, without anything shaped like a credential. */
export function redactedOutput(text: string): string {
  return maskedSecrets(text).trim().slice(0, 400);
}

/** `owner/name` of a GitHub push URL (ssh, scp-like or https, an ssh host
 *  alias included), or null — null too when git would reach another host
 *  than a URL parser reads (`urlAuthority`): the repository named on GitHub
 *  must be the one the push goes to. */
export function githubRepoFromUrl(url: string): string | null {
  if (url.includes('\\')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url.trim()) && !urlAuthority(url.trim())) return null;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/[^/]+\/|[^\s/:@]+@[^\s/:]+:|[^\s/:]+:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m?.[1] || !m[2] || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return `${m[1]}/${m[2]}`;
}

export type PullRequestRef = { number: number; url: string };

export type CreatePullRequestOutcome =
  | { ok: true; pr: PullRequestRef; existing: boolean }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

export type PullRequestInput = {
  /** `owner/name` on the forge. */
  repo: string;
  /** Branch the pull request targets (`main`). */
  base: string;
  /** Branch it brings (`feat/topic`), already pushed. */
  head: string;
  title: string;
  body: string;
  /** Login that owns the repository `head` was pushed to, when it is a fork
   *  of `repo`: gh then takes `--head=<owner>:<branch>`. Absent for a branch
   *  of `repo` itself. */
  headOwner?: string;
};

/** What the signed-in account may do on a repository (one call to the forge). */
export type RepositoryAccessOutcome =
  | { ok: true; exists: true; canPush: boolean }
  | { ok: true; exists: false }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

export type ForkRepositoryOutcome =
  | { ok: true }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

export interface Forge {
  /** The login the configured credentials answer for: one call to the forge. */
  login(): Promise<GhLoginOutcome>;
  /** Opens the pull request; one already open for the same branches is
   *  reported as such, not as a failure. */
  createPullRequest(input: PullRequestInput): Promise<CreatePullRequestOutcome>;
  /** Whether `repo` exists and whether the signed-in account may push to it. */
  repositoryAccess(repo: string): Promise<RepositoryAccessOutcome>;
  /** Forks `repo` into the signed-in account, without cloning it. Only ever
   *  called after a person confirmed it in the interface. */
  forkRepository(repo: string): Promise<ForkRepositoryOutcome>;
}

export type PullRequestState = 'open' | 'closed' | 'merged';

export type PullRequestStateOutcome =
  | { ok: true; state: PullRequestState; mergeSha: string | null }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

export type ForgeReadFailure = { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

/** One open pull request of a repository, as a list shows it. Every text in
 *  it was written by whoever opened the pull request: data, never an order. */
export type PullRequestSummary = {
  number: number;
  title: string;
  /** Login of the author, null for a deleted account. */
  author: string | null;
  url: string;
  isDraft: boolean;
  /** ISO date of the last change GitHub saw. */
  updatedAt: string;
  /** Owner of the repository the branch comes from: another one is a fork. */
  headOwner: string | null;
  /** `owner/name` of the repository the branch comes from, null when the
   *  fork was deleted. */
  headRepository: string | null;
  /** Whether the maintainers may push to the contributor's branch. */
  maintainerCanModify: boolean;
  mergeStateStatus: MergeStateStatus;
  labels: ForgeLabel[];
  /** The issues the forge will close when the pull request is merged: it
   *  reads them from the description, so they are the author's claim. */
  closingIssues: IssueReference[];
};

export type PullRequestListOutcome = { ok: true; pulls: PullRequestSummary[] } | ForgeReadFailure;

export type PullRequestComment = { author: string | null; body: string };

/** What a relecture brief needs of a pull request, as the forge answers it. */
export type PullRequestDetails = PullRequestSummary & {
  body: string;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: PullRequestComment[];
};

export type PullRequestDetailsOutcome = { ok: true; pull: PullRequestDetails } | ForgeReadFailure;

export type PullRequestDiffOutcome = { ok: true; diff: string; truncated: boolean } | ForgeReadFailure;

/**
 * What the forge says of a pull request, read only. The poller decides a merge
 * from git and asks `pullRequest` when git cannot tell; the list, the details
 * and the diff serve the relecture of a contributor's pull request, whose code
 * is never fetched, checked out or run here: the diff is text.
 */
export interface ForgeStateReader {
  pullRequest(repo: string, number: number): Promise<PullRequestStateOutcome>;
}

export interface ForgeReader extends ForgeStateReader, ForgeThreadsReader {
  listOpenPullRequests(repo: string): Promise<PullRequestListOutcome>;
  pullRequestDetails(repo: string, number: number): Promise<PullRequestDetailsOutcome>;
  pullRequestDiff(repo: string, number: number): Promise<PullRequestDiffOutcome>;
}

/** Most pull requests a list asks for: a page, not the whole history. */
export const PULL_LIST_LIMIT = 100;
/** Most bytes of a diff kept: past it the text is cut and said so. */
export const PULL_DIFF_LIMIT = 2 * 1024 * 1024;

/** One check of a pull request, as the forge reports it. */
export type PullRequestCheckStatus = 'pass' | 'fail' | 'pending' | 'skipped';
export type PullRequestCheck = { name: string; status: PullRequestCheckStatus; url: string | null };

/** What a pull request's page says about its readiness. Every string comes
 *  from the forge: bounded, and never read as an instruction. */
export type PullRequestChecks = {
  state: PullRequestState;
  draft: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  mergeStateStatus: MergeStateStatus;
  title: string;
  body: string;
  checks: PullRequestCheck[];
  labels: ForgeLabel[];
  closingIssues: IssueReference[];
};

export type PullRequestChecksOutcome =
  | { ok: true; view: PullRequestChecks }
  | { ok: false; code: 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer'; reason: string };

/** The checks, mergeability and review of an open pull request: read on
 *  demand, while someone looks at the job. */
export interface ForgeChecksReader {
  pullRequestChecks(repo: string, number: number): Promise<PullRequestChecksOutcome>;
}

/** How the forge sees a pull request against its base, beyond a conflict:
 *  `behind` asks for a branch update, `dirty` is a conflict, `blocked` waits
 *  for a review or a required check, `unknown` while GitHub computes it. */
export const MERGE_STATE_STATUSES = ['behind', 'blocked', 'clean', 'dirty', 'draft', 'has_hooks', 'unstable', 'unknown'] as const;
export type MergeStateStatus = (typeof MERGE_STATE_STATUSES)[number];

/** A label as the forge shows it. Its name was chosen by whoever can triage
 *  the repository: data, bounded. */
export type ForgeLabel = { name: string; color: string | null };

/** An issue named by its repository and number. */
export type IssueReference = { repo: string | null; number: number; url: string | null };

/** One unresolved review thread, told by the comment that opened it. */
export type ReviewThread = {
  path: string | null;
  line: number | null;
  /** The lines it was written on have changed since. */
  outdated: boolean;
  author: string | null;
  body: string;
  url: string | null;
  /** Comments in the thread, the first one included. */
  comments: number;
};

export type ReviewThreadsOutcome =
  | { ok: true; threads: ReviewThread[]; unresolved: number; truncated: boolean }
  | ForgeReadFailure;

/** The review threads of a pull request nobody has resolved yet. */
export interface ForgeThreadsReader {
  pullRequestReviewThreads(repo: string, number: number): Promise<ReviewThreadsOutcome>;
}

export const GENERAL_REVIEW_STATES = ['commented', 'changes_requested', 'approved'] as const;

/** A submitted review's own text, the one written above its line comments. */
export type GeneralReview = {
  state: (typeof GENERAL_REVIEW_STATES)[number];
  author: string | null;
  body: string;
  url: string | null;
  submittedAt: string | null;
};

export type GeneralReviewsOutcome =
  | { ok: true; reviews: GeneralReview[]; truncated: boolean }
  | ForgeReadFailure;

/** The text of the reviews submitted on a pull request: a reviewer often
 *  writes what to change there rather than on a line. */
export interface ForgeReviewsReader {
  pullRequestReviews(repo: string, number: number): Promise<GeneralReviewsOutcome>;
}

/** The end of the log of a failed check, as the forge's CI printed it. */
export type FailedCheckLog = {
  /** The last lines, at most `CHECK_LOG_TAIL_LINES` and `CHECK_LOG_TAIL_CHARS`. */
  tail: string;
  /** Lines were dropped before the tail. */
  truncated: boolean;
};

export type FailedCheckLogOutcome =
  | { ok: true; log: FailedCheckLog }
  /** `not_actions`: the check is not a job of the repository's own CI, whose log gh can read. */
  | ForgeReadFailure
  | { ok: false; code: 'not_actions'; reason: string };

/** The failed steps of a CI job, read when someone asks to fix the checks. */
export interface ForgeCheckLogReader {
  failedCheckLog(repo: string, checkUrl: string): Promise<FailedCheckLogOutcome>;
}

export type IssueState = 'open' | 'closed';
export const ISSUE_STATE_REASONS = ['completed', 'not_planned', 'reopened', 'duplicate'] as const;
export type IssueStateReason = (typeof ISSUE_STATE_REASONS)[number];

/** One issue as a list shows it. Every text in it was written by whoever
 *  opened the issue: data, never an order. */
export type IssueSummary = {
  number: number;
  title: string;
  author: string | null;
  url: string;
  state: IssueState;
  labels: ForgeLabel[];
  createdAt: string;
  updatedAt: string;
};

export type IssueDetails = IssueSummary & {
  body: string;
  /** The body was longer than `FORGE_BODY_LIMIT` and was cut. */
  bodyTruncated: boolean;
  stateReason: IssueStateReason | null;
};

export type IssueListOutcome = { ok: true; issues: IssueSummary[] } | ForgeReadFailure;
export type IssueDetailsOutcome = { ok: true; issue: IssueDetails } | ForgeReadFailure;

/** The issues of a repository, read only: the open ones carrying a label,
 *  and the text of one. */
export interface ForgeIssueReader {
  listIssues(repo: string, label: string): Promise<IssueListOutcome>;
  issueDetails(repo: string, number: number): Promise<IssueDetailsOutcome>;
}

/** A comment on an issue or a pull request (GitHub keeps both as issue comments). */
export type IssueCommentRef = { id: number; url: string };
export type IssueCommentOutcome = { ok: true; comment: IssueCommentRef } | ForgeReadFailure;
export type IssueCommentLookup = { ok: true; comment: IssueCommentRef | null } | ForgeReadFailure;

/** Most characters of a comment the daemon posts: GitHub takes 65 536, and a
 *  Windows command line about 32 000. */
export const ISSUE_COMMENT_LIMIT = 8_000;

/**
 * The one write on the forge outside a pull request's opening: a plain
 * comment, never a review, an approval or a label. The caller has checked the
 * account (`login`) and holds a person's validation; nothing here decides to
 * write.
 */
export interface ForgeCommentWriter {
  login(): Promise<GhLoginOutcome>;
  /** The comment `author` left on `number` that holds `marker`, if any: how a
   *  publication interrupted after the forge answered is not posted twice. */
  findIssueComment(repo: string, number: number, author: string, marker: string): Promise<IssueCommentLookup>;
  postIssueComment(repo: string, number: number, body: string): Promise<IssueCommentOutcome>;
}

/**
 * Why an issue is closed without being fixed, as GitHub's REST API spells it.
 * `completed` is left to the `Fixes` line of a merged pull request.
 */
export const ISSUE_CLOSE_REASONS = ['not_planned', 'duplicate'] as const;
export type IssueCloseReason = (typeof ISSUE_CLOSE_REASONS)[number];

/** `reason` is the one GitHub recorded: a server that does not know
 *  `duplicate` closes the issue as `not_planned` instead. */
export type IssueCloseOutcome = { ok: true; url: string; reason: IssueCloseReason } | ForgeReadFailure;

/**
 * Closes an issue, the second write outside a pull request's opening. Like
 * the comment, it runs only for a proposal a signed-in person published.
 */
export interface ForgeIssueCloser extends ForgeIssueReader {
  login(): Promise<GhLoginOutcome>;
  closeIssue(repo: string, number: number, reason: IssueCloseReason): Promise<IssueCloseOutcome>;
}

const ClosedIssue = z.object({ html_url: z.string(), state: z.string() });

/** The issue `gh api …/issues/<n>` answered once closed, or null. */
export function parseClosedIssue(stdout: string): { url: string } | null {
  const parsed = ClosedIssue.safeParse(jsonOf(stdout));
  if (!parsed.success || parsed.data.state.toLowerCase() !== 'closed') return null;
  const url = httpsUrl(parsed.data.html_url);
  return url ? { url } : null;
}

/** Most issues one state read asks for: one GraphQL query, aliased. */
export const ISSUE_STATE_BATCH = 50;

/** What closed an issue, when it was a pull request. */
export type IssueClosedBy = {
  number: number;
  url: string | null;
  merged: boolean;
  /** `owner/name` of the pull request's repository. */
  repo: string | null;
};

/** An issue's state, and the pull request that closed it, if one did. */
export type IssueStateRead = {
  number: number;
  state: IssueState;
  stateReason: IssueStateReason | null;
  closedBy: IssueClosedBy | null;
};

export type IssueStatesOutcome = { ok: true; issues: IssueStateRead[] } | ForgeReadFailure;

/** Reads, in one call, whether issues are closed and by which pull request. */
export interface ForgeIssueStateReader {
  issueStates(repo: string, numbers: readonly number[]): Promise<IssueStatesOutcome>;
}

/** The GraphQL query of `issueStates`: the numbers are checked integers. */
export function issueStatesQuery(numbers: readonly number[]): string {
  const fields = numbers.map((n) => `i${n}: issue(number: ${n}) { number state stateReason `
    + 'timelineItems(itemTypes: [CLOSED_EVENT], last: 1) { nodes { ... on ClosedEvent { closer { __typename '
    + '... on PullRequest { number url merged repository { nameWithOwner } } } } } } }');
  return `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields.join(' ')} } }`;
}

const IssueStateNode = z.object({
  number: z.int().positive(),
  state: z.enum(['OPEN', 'CLOSED']),
  stateReason: z.string().transform((s) => s.toLowerCase()).pipe(z.enum(ISSUE_STATE_REASONS)).nullable().catch(null),
  timelineItems: z.object({ nodes: z.array(z.unknown()) }).catch({ nodes: [] }),
});
const CloserNode = z.object({
  closer: z.object({
    __typename: z.literal('PullRequest'),
    number: z.int().positive(),
    url: z.string().catch(''),
    merged: z.boolean(),
    repository: z.object({ nameWithOwner: z.string() }).nullable().catch(null),
  }),
});

/**
 * The issues a state read answered. An alias the forge could not resolve (a
 * number that is a pull request, or gone) is left out: the others still count.
 */
export function parseIssueStates(stdout: string): IssueStateRead[] | null {
  const answer = z.object({ data: z.object({ repository: z.record(z.string(), z.unknown()) }) }).safeParse(jsonOf(stdout));
  if (!answer.success) return null;
  const out: IssueStateRead[] = [];
  for (const value of Object.values(answer.data.data.repository)) {
    const node = IssueStateNode.safeParse(value);
    if (!node.success) continue;
    const last = CloserNode.safeParse(node.data.timelineItems.nodes.at(-1));
    out.push({
      number: node.data.number,
      state: node.data.state === 'OPEN' ? 'open' : 'closed',
      stateReason: node.data.stateReason,
      closedBy: last.success ? {
        number: last.data.closer.number,
        url: httpsUrl(last.data.closer.url),
        merged: last.data.closer.merged,
        repo: last.data.closer.repository ? repoName(last.data.closer.repository.nameWithOwner) : null,
      } : null,
    });
  }
  return out;
}

/** What a pull request's branch is, read before its update or the resolution
 *  of its conflict. Every name in it was chosen by the pull request's author:
 *  data, checked again before it reaches a refspec. */
export type PullRequestBranch = {
  state: PullRequestState;
  isDraft: boolean;
  baseRef: string;
  headRef: string;
  headSha: string | null;
  /** `owner/name` of the repository the branch lives in, null for a deleted fork. */
  headRepository: string | null;
  /** The branch lives in another repository than the pull request's. */
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  mergeStateStatus: MergeStateStatus;
  url: string;
};

export type PullRequestBranchOutcome = { ok: true; branch: PullRequestBranch } | ForgeReadFailure;

export type RepositorySizeOutcome = { ok: true; kib: number } | ForgeReadFailure;

/** The branch of a pull request, read only. */
export interface ForgeBranchReader {
  pullRequestBranch(repo: string, number: number): Promise<PullRequestBranchOutcome>;
  /** The size GitHub reports for a repository (`size`, in KiB): how a fetch
   *  is refused before it starts rather than measured once it is done. */
  repositorySize(repo: string): Promise<RepositorySizeOutcome>;
}

export type BranchUpdateFailureCode = ForgeReadFailure['code'] | 'head_moved' | 'conflict' | 'forbidden';
export type BranchUpdateOutcome = { ok: true } | { ok: false; code: BranchUpdateFailureCode; reason: string };

export type CommitParentsOutcome = { ok: true; parents: string[] } | ForgeReadFailure;

/**
 * The update of a pull request's branch, done by GitHub on its side: it merges
 * the base into the branch, runs nothing here, and refuses when the branch
 * moved since `expectedHeadSha` or when the merge conflicts. The caller holds a
 * person's validation and checked the account.
 */
export interface ForgeBranchWriter extends ForgeBranchReader {
  login(): Promise<GhLoginOutcome>;
  updatePullRequestBranch(repo: string, number: number, expectedHeadSha: string): Promise<BranchUpdateOutcome>;
  /** The parents of a commit: how a retried update tells its own merge from
   *  a push of the contributor. */
  commitParents(repo: string, sha: string): Promise<CommitParentsOutcome>;
}

/** Most issues a list asks for, the most recent first. */
export const ISSUE_LIST_LIMIT = 50;
/** Most characters kept of a title written on the forge. */
export const FORGE_TITLE_LIMIT = 500;
/** Most characters kept of a description written on the forge. */
export const FORGE_BODY_LIMIT = 8_000;
/** Most unresolved review threads kept, and characters of each one's text. */
export const REVIEW_THREAD_LIMIT = 20;
export const REVIEW_THREAD_BODY_LIMIT = 1_000;
/** Most review threads asked of the forge in one call. */
const REVIEW_THREAD_PAGE = 100;
/** Most reviews with a text kept, the latest; and reviews asked of the forge. */
export const GENERAL_REVIEW_LIMIT = 10;
const GENERAL_REVIEW_PAGE = 50;
const LABEL_LIMIT = 20;
const LABEL_NAME_LIMIT = 100;
const CLOSING_ISSUE_LIMIT = 20;
/** GitHub caps a label name at 50 characters. */
const LABEL_FILTER_LIMIT = 50;

const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const COMMIT_SHA = /^[0-9a-f]{40,64}$/;

/** Lines and characters kept of a failed check's log: its end, where the error is. */
export const CHECK_LOG_TAIL_LINES = 150;
export const CHECK_LOG_TAIL_CHARS = 12_000;
/** Bytes gh may print for one job's failed steps before the read is cut. */
const CHECK_LOG_BUFFER = 16 * 1024 * 1024;

/**
 * The job a check's address names in the repository's own CI
 * (`https://<host>/<owner>/<name>/actions/runs/<run>/job/<job>`), or null: an
 * external status, another repository's run, anything else.
 */
export function actionsJobOf(repo: string, checkUrl: string): string | null {
  let url: URL;
  try { url = new URL(checkUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const m = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/actions\/runs\/\d{1,20}\/job\/(\d{1,20})\/?$/.exec(url.pathname);
  if (!m || `${m[1]}/${m[2]}`.toLowerCase() !== repo.toLowerCase()) return null;
  return m[3] ?? null;
}

/**
 * The end of a CI log, as text a brief can carry: colour codes, control and
 * direction characters removed, credentials masked, then the last lines kept
 * within both bounds.
 */
export function checkLogTail(text: string): FailedCheckLog {
  const clean = maskedSecrets(text)
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+$/, '');
  const lines = clean.split('\n');
  let kept = lines.slice(-CHECK_LOG_TAIL_LINES);
  let tail = kept.join('\n');
  while (tail.length > CHECK_LOG_TAIL_CHARS && kept.length > 1) {
    kept = kept.slice(1);
    tail = kept.join('\n');
  }
  if (tail.length > CHECK_LOG_TAIL_CHARS) tail = tail.slice(-CHECK_LOG_TAIL_CHARS);
  return { tail, truncated: kept.length < lines.length || tail.length < kept.join('\n').length };
}

/** The state and merge commit `gh pr view --json` answers, or null when the
 *  answer is not what gh prints. */
export function parsePullRequestView(stdout: string): { state: PullRequestState; mergeSha: string | null } | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { state, mergeCommit } = parsed as { state?: unknown; mergeCommit?: unknown };
  const states: Record<string, PullRequestState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
  const known = typeof state === 'string' ? states[state] : undefined;
  if (!known) return null;
  const oid = typeof mergeCommit === 'object' && mergeCommit !== null ? (mergeCommit as { oid?: unknown }).oid : null;
  return { state: known, mergeSha: typeof oid === 'string' && COMMIT_SHA.test(oid) ? oid : null };
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function login(value: unknown): string | null {
  const l = typeof value === 'object' && value !== null ? (value as { login?: unknown }).login : null;
  return typeof l === 'string' && l.length > 0 ? l : null;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** One pull request of `gh pr list|view --json`, or null when the entry is
 *  not one: a number and an address are the least it must carry. */
function summaryFrom(entry: unknown): PullRequestSummary | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const e = entry as Record<string, unknown>;
  if (typeof e.number !== 'number' || !Number.isSafeInteger(e.number) || e.number <= 0) return null;
  if (typeof e.url !== 'string' || !/^https:\/\//.test(e.url)) return null;
  return {
    number: e.number,
    title: boundedText(e.title, FORGE_TITLE_LIMIT),
    author: login(e.author),
    url: e.url,
    isDraft: e.isDraft === true,
    updatedAt: text(e.updatedAt),
    headOwner: login(e.headRepositoryOwner),
    headRepository: headRepositoryOf(e.headRepositoryOwner, e.headRepository),
    maintainerCanModify: e.maintainerCanModify === true,
    mergeStateStatus: MergeStateSchema.parse(e.mergeStateStatus),
    labels: itemsOf(e.labels, LabelSchema, LABEL_LIMIT),
    closingIssues: itemsOf(e.closingIssuesReferences, IssueReferenceSchema, CLOSING_ISSUE_LIMIT),
  };
}

/** The open pull requests `gh pr list --json` answers, or null. */
export function parsePullRequestList(stdout: string): PullRequestSummary[] | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (!Array.isArray(parsed)) return null;
  return parsed.map(summaryFrom).filter((p): p is PullRequestSummary => p !== null);
}

/** The details `gh pr view --json` answers, or null. */
export function parsePullRequestDetails(stdout: string): PullRequestDetails | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  const summary = summaryFrom(parsed);
  if (!summary) return null;
  const e = parsed as Record<string, unknown>;
  const comments = Array.isArray(e.comments) ? e.comments : [];
  const oid = text(e.headRefOid);
  return {
    ...summary,
    body: text(e.body),
    baseRef: text(e.baseRefName),
    headRef: text(e.headRefName),
    headSha: COMMIT_SHA.test(oid) ? oid : null,
    additions: count(e.additions),
    deletions: count(e.deletions),
    changedFiles: count(e.changedFiles),
    comments: comments
      .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
      .map((c) => ({ author: login(c.author), body: text(c.body) })),
  };
}

export const MAX_FORGE_CHECKS = 100;
const MAX_TITLE = 256;

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  // Control characters other than line breaks and tabs have no place on a card.
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, max);
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

const RUN_FAILURES = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);

/** A check run (GitHub Actions…) or a commit status, as one shape. */
function checkOf(item: unknown): PullRequestCheck | null {
  if (typeof item !== 'object' || item === null) return null;
  const o = item as Record<string, unknown>;
  if (typeof o.context === 'string') {
    const state = String(o.state ?? '');
    const status: PullRequestCheckStatus = state === 'SUCCESS' ? 'pass'
      : state === 'FAILURE' || state === 'ERROR' ? 'fail' : 'pending';
    return { name: boundedText(o.context, 120) || 'status', status, url: httpsUrl(o.targetUrl) };
  }
  if (typeof o.name !== 'string') return null;
  const conclusion = String(o.conclusion ?? '');
  let status: PullRequestCheckStatus;
  if (o.status !== 'COMPLETED') status = 'pending';
  else if (conclusion === 'SUCCESS') status = 'pass';
  else if (RUN_FAILURES.has(conclusion)) status = 'fail';
  else status = 'skipped';
  return { name: boundedText(o.name, 120) || 'check', status, url: httpsUrl(o.detailsUrl) };
}

/** The answer of `gh pr view --json state,isDraft,mergeable,reviewDecision,
 *  mergeStateStatus,title,body,statusCheckRollup,labels,
 *  closingIssuesReferences`, or null when it is not what gh prints. */
export function parsePullRequestChecks(stdout: string): PullRequestChecks | null {
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const states: Record<string, PullRequestState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
  const state = typeof o.state === 'string' ? states[o.state] : undefined;
  if (!state) return null;
  const mergeable = o.mergeable === 'MERGEABLE' ? 'mergeable' : o.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown';
  const reviews: Record<string, PullRequestChecks['review']> = {
    APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required',
  };
  const review = typeof o.reviewDecision === 'string' ? reviews[o.reviewDecision] ?? null : null;
  const rollup = Array.isArray(o.statusCheckRollup) ? o.statusCheckRollup : [];
  const checks = rollup.map(checkOf).filter((c): c is PullRequestCheck => c !== null).slice(0, MAX_FORGE_CHECKS);
  return {
    state,
    draft: o.isDraft === true,
    mergeable,
    review,
    title: boundedText(o.title, MAX_TITLE),
    body: boundedText(o.body, FORGE_BODY_LIMIT),
    checks,
    mergeStateStatus: MergeStateSchema.parse(o.mergeStateStatus),
    labels: itemsOf(o.labels, LabelSchema, LABEL_LIMIT),
    closingIssues: itemsOf(o.closingIssuesReferences, IssueReferenceSchema, CLOSING_ISSUE_LIMIT),
  };
}

/** The answer of `gh pr view --json` for a pull request's branch
 *  (`PULL_BRANCH_FIELDS`), or null when it is not one. */
export function parsePullRequestBranch(stdout: string): PullRequestBranch | null {
  const parsed = jsonOf(stdout);
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const states: Record<string, PullRequestState> = { OPEN: 'open', CLOSED: 'closed', MERGED: 'merged' };
  const state = typeof o.state === 'string' ? states[o.state] : undefined;
  const url = httpsUrl(o.url);
  if (!state || !url) return null;
  const oid = text(o.headRefOid);
  return {
    state,
    isDraft: o.isDraft === true,
    baseRef: boundedText(o.baseRefName, 255),
    headRef: boundedText(o.headRefName, 255),
    headSha: COMMIT_SHA.test(oid) ? oid : null,
    headRepository: headRepositoryOf(o.headRepositoryOwner, o.headRepository),
    isCrossRepository: o.isCrossRepository === true,
    maintainerCanModify: o.maintainerCanModify === true,
    mergeable: o.mergeable === 'MERGEABLE' ? 'mergeable' : o.mergeable === 'CONFLICTING' ? 'conflicting' : 'unknown',
    mergeStateStatus: MergeStateSchema.parse(o.mergeStateStatus),
    url,
  };
}

/** What `gh api` said of a refused branch update, as a code. */
export function branchUpdateFailure(stderr: string): BranchUpdateFailureCode {
  if (/expected[_ ]head[_ ]sha|head ref|did ?n.t match/i.test(stderr)) return 'head_moved';
  if (/conflict/i.test(stderr)) return 'conflict';
  if (/HTTP 40[34]\b/.test(stderr)) return 'forbidden';
  return 'gh_failed';
}

// ─── Answers of the forge, through zod ─────────────────────────────────────
// Unknown fields are dropped and an odd entry of a list costs only itself:
// GitHub adds fields and `gh` reshapes some, the reader keeps what it knows.

const LoginSchema = z.object({ login: z.string().min(1).max(100) }).transform((o) => o.login);

const MergeStateSchema = z.string()
  .transform((s) => s.toLowerCase())
  .pipe(z.enum(MERGE_STATE_STATUSES))
  .catch('unknown');

const LabelSchema = z.object({ name: z.string().min(1), color: z.string().nullish() })
  .transform((l): ForgeLabel => ({
    name: boundedText(l.name, LABEL_NAME_LIMIT),
    color: l.color && /^[0-9a-fA-F]{6}$/.test(l.color) ? l.color.toLowerCase() : null,
  }));

const IssueReferenceSchema = z.object({
  number: z.int().positive(),
  url: z.string().nullish(),
  repository: z.object({ name: z.string(), owner: z.object({ login: z.string() }) }).nullish(),
}).transform((r): IssueReference => {
  const repo = r.repository ? `${r.repository.owner.login}/${r.repository.name}` : null;
  return { repo: repo ? repoName(repo) : null, number: r.number, url: httpsUrl(r.url) };
});

/** `owner/name` when it names a GitHub repository, dot segments refused. */
function repoName(full: string): string | null {
  return GITHUB_REPO.test(full) && !full.split('/').some((part) => part === '.' || part === '..') ? full : null;
}

/** The entries of a list `gh` printed, as an array or a GraphQL connection,
 *  that `schema` accepts, at most `max`. */
function itemsOf<T>(value: unknown, schema: z.ZodType<T>, max: number): T[] {
  const nodes = typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as { nodes?: unknown }).nodes
    : value;
  if (!Array.isArray(nodes)) return [];
  const out: T[] = [];
  for (const node of nodes) {
    if (out.length >= max) break;
    const parsed = schema.safeParse(node);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** `owner/name` of the repository a pull request's branch comes from. */
function headRepositoryOf(owner: unknown, repository: unknown): string | null {
  const login = LoginSchema.safeParse(owner);
  const name = z.object({ name: z.string().min(1) }).safeParse(repository);
  if (!login.success || !name.success) return null;
  return repoName(`${login.data}/${name.data.name}`);
}

function jsonOf(stdout: string): unknown {
  try { return JSON.parse(stdout); } catch { return undefined; }
}

const IssueSchema = z.object({
  number: z.int().positive(),
  url: z.string().refine((u) => httpsUrl(u) !== null),
  state: z.enum(['OPEN', 'CLOSED']),
  title: z.string().catch(''),
  author: LoginSchema.nullable().catch(null),
  labels: z.unknown(),
  createdAt: z.string().catch(''),
  updatedAt: z.string().catch(''),
});

function issueSummaryOf(i: z.infer<typeof IssueSchema>): IssueSummary {
  return {
    number: i.number,
    title: boundedText(i.title, FORGE_TITLE_LIMIT),
    author: i.author,
    url: i.url,
    state: i.state === 'OPEN' ? 'open' : 'closed',
    labels: itemsOf(i.labels, LabelSchema, LABEL_LIMIT),
    createdAt: boundedText(i.createdAt, 40),
    updatedAt: boundedText(i.updatedAt, 40),
  };
}

/** The issues `gh issue list --json` answers, or null when it printed no
 *  list. */
export function parseIssueList(stdout: string): IssueSummary[] | null {
  const parsed = jsonOf(stdout);
  if (!Array.isArray(parsed)) return null;
  return itemsOf(parsed, IssueSchema, ISSUE_LIST_LIMIT).map(issueSummaryOf);
}

const IssueDetailsSchema = IssueSchema.extend({
  body: z.string().catch(''),
  stateReason: z.string()
    .transform((s) => s.toLowerCase())
    .pipe(z.enum(ISSUE_STATE_REASONS))
    .nullable()
    .catch(null),
});

/** The issue `gh issue view --json` answers, or null. */
export function parseIssueDetails(stdout: string): IssueDetails | null {
  const parsed = IssueDetailsSchema.safeParse(jsonOf(stdout));
  if (!parsed.success) return null;
  const clean = boundedText(parsed.data.body, Number.POSITIVE_INFINITY);
  return {
    ...issueSummaryOf(parsed.data),
    body: clean.slice(0, FORGE_BODY_LIMIT),
    bodyTruncated: clean.length > FORGE_BODY_LIMIT,
    stateReason: parsed.data.stateReason,
  };
}

const ThreadCommentSchema = z.object({
  author: LoginSchema.nullable().catch(null),
  body: z.string().catch(''),
  url: z.string().catch(''),
});

const ThreadSchema = z.object({
  isResolved: z.boolean(),
  isOutdated: z.boolean().catch(false),
  path: z.string().nullable().catch(null),
  line: z.int().positive().nullable().catch(null),
  comments: z.object({
    totalCount: z.int().nonnegative().catch(0),
    nodes: z.array(z.unknown()).catch([]),
  }).catch({ totalCount: 0, nodes: [] }),
});

const ThreadsAnswerSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({ totalCount: z.int().nonnegative(), nodes: z.array(z.unknown()) }),
      }),
    }),
  }),
});

/** The unresolved review threads a GraphQL answer holds, or null when the
 *  answer is not one. `unresolved` counts the threads read, `truncated` says
 *  the forge holds more than were read or kept. */
export function parseReviewThreads(stdout: string): { threads: ReviewThread[]; unresolved: number; truncated: boolean } | null {
  const parsed = ThreadsAnswerSchema.safeParse(jsonOf(stdout));
  if (!parsed.success) return null;
  const connection = parsed.data.data.repository.pullRequest.reviewThreads;
  const open = itemsOf(connection.nodes, ThreadSchema, connection.nodes.length).filter((t) => !t.isResolved);
  const threads = open.slice(0, REVIEW_THREAD_LIMIT).map((t): ReviewThread => {
    const first = ThreadCommentSchema.safeParse(t.comments.nodes[0]);
    return {
      path: t.path === null ? null : boundedText(t.path, 300) || null,
      line: t.line,
      outdated: t.isOutdated,
      author: first.success ? first.data.author : null,
      body: first.success ? boundedText(first.data.body, REVIEW_THREAD_BODY_LIMIT) : '',
      url: first.success ? httpsUrl(first.data.url) : null,
      comments: t.comments.totalCount,
    };
  });
  return {
    threads,
    unresolved: open.length,
    truncated: connection.totalCount > connection.nodes.length || open.length > threads.length,
  };
}

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: ${REVIEW_THREAD_PAGE}) {
        totalCount
        nodes { isResolved isOutdated path line comments(first: 1) { totalCount nodes { author { login } body url } } }
      }
    }
  }
}`;

const GeneralReviewSchema = z.object({
  state: z.string().transform((v) => v.toLowerCase()).pipe(z.enum(GENERAL_REVIEW_STATES)),
  author: LoginSchema.nullable().catch(null),
  body: z.string().catch(''),
  url: z.string().catch(''),
  submittedAt: z.string().nullable().catch(null),
});

const ReviewsAnswerSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviews: z.object({ totalCount: z.int().nonnegative(), nodes: z.array(z.unknown()) }),
      }),
    }),
  }),
});

/** The submitted reviews of a GraphQL answer that hold a text, oldest first,
 *  the latest `GENERAL_REVIEW_LIMIT`; null when the answer is not one. A
 *  pending or dismissed review is not one a reviewer stands by. */
export function parseGeneralReviews(stdout: string): { reviews: GeneralReview[]; truncated: boolean } | null {
  const parsed = ReviewsAnswerSchema.safeParse(jsonOf(stdout));
  if (!parsed.success) return null;
  const connection = parsed.data.data.repository.pullRequest.reviews;
  const worded = itemsOf(connection.nodes, GeneralReviewSchema, connection.nodes.length)
    .map((r): GeneralReview => ({
      state: r.state,
      author: r.author,
      body: boundedText(r.body, REVIEW_THREAD_BODY_LIMIT),
      url: httpsUrl(r.url),
      submittedAt: r.submittedAt && !Number.isNaN(Date.parse(r.submittedAt)) ? new Date(r.submittedAt).toISOString() : null,
    }))
    .filter((r) => r.body.trim().length > 0);
  const reviews = worded.slice(-GENERAL_REVIEW_LIMIT);
  return { reviews, truncated: connection.totalCount > connection.nodes.length || worded.length > reviews.length };
}

const GENERAL_REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: ${GENERAL_REVIEW_PAGE}, states: [COMMENTED, CHANGES_REQUESTED, APPROVED]) {
        totalCount
        nodes { state body url submittedAt author { login } }
      }
    }
  }
}`;

/** What `gh api` answers when it creates an issue comment. */
const CreatedComment = z.object({ id: z.number().int().positive(), html_url: z.string() });

/** The comment `gh api …/comments` created, or null when the answer is not one. */
export function parseCreatedComment(stdout: string): IssueCommentRef | null {
  const parsed = CreatedComment.safeParse(jsonOf(stdout));
  if (!parsed.success) return null;
  const url = httpsUrl(parsed.data.html_url);
  return url ? { id: parsed.data.id, url } : null;
}

/** The first `<id> <url>` line the comment lookup printed, or null. */
function foundComment(stdout: string): IssueCommentRef | null {
  for (const line of stdout.split('\n')) {
    const m = /^(\d{1,20}) (\S+)$/.exec(line.trim());
    const url = m?.[2] ? httpsUrl(m[2]) : null;
    if (m?.[1] && url) return { id: Number(m[1]), url };
  }
  return null;
}

/** A marker a lookup may quote in its jq filter: a fixed shape, no quote. */
const COMMENT_MARKER = /^<!-- timon-proposal:[0-9a-f-]{36} -->$/;
const COMMENT_AUTHOR = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;

/** A repository path segment GitHub accepts and an API path cannot climb out of. */
function plainRepo(repo: string): boolean {
  return GITHUB_REPO.test(repo) && repo.split('/').every((part) => part !== '.' && part !== '..');
}

/** A label `gh issue list --label` takes as one label: `gh` splits on commas. */
function plainLabel(label: string): boolean {
  return label.length > 0 && label.length <= LABEL_FILTER_LIMIT && label === label.trim()
    // eslint-disable-next-line no-control-regex
    && !/[,\u0000-\u001f\u007f]/.test(label);
}

/** What `gh pr list|view --json` is asked for a pull request's summary. */
const PULL_SUMMARY_FIELDS = 'number,title,author,url,isDraft,updatedAt,headRepositoryOwner,headRepository,'
  + 'maintainerCanModify,mergeStateStatus,labels,closingIssuesReferences';

/** What `gh pr view --json` is asked for a pull request's branch. */
const PULL_BRANCH_FIELDS = 'state,isDraft,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner,'
  + 'isCrossRepository,maintainerCanModify,mergeable,mergeStateStatus,url';

const PULL_URL = /https:\/\/[^\s/]+\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;

function pullRequestFrom(text: string): PullRequestRef | null {
  const m = PULL_URL.exec(text);
  if (!m?.[1]) return null;
  return { number: Number(m[1]), url: m[0] };
}

/** GitHub through `gh`, signed in with the project's config folder. */
export function githubForge(
  configDir: string | null, runners: ForgeRunners = {},
): Forge & ForgeReader & ForgeChecksReader & ForgeCheckLogReader & ForgeIssueReader & ForgeCommentWriter & ForgeBranchWriter
  & ForgeReviewsReader
  & ForgeIssueCloser & ForgeIssueStateReader {
  const gh = runners.gh ?? hostGh;
  // Read-only `gh` calls: one shape for every failure, nothing secret in it.
  const read = async (args: string[], maxBuffer?: number): Promise<{ ok: true; result: ExecResult } | ForgeReadFailure> => {
    let result: ExecResult;
    try {
      result = await gh(args, { env: ghEnv(configDir), timeout: GH_TIMEOUT_MS, windowsHide: true, ...(maxBuffer ? { maxBuffer } : {}) });
    } catch {
      return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
    }
    if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
    return { ok: true, result };
  };
  const failed = (result: ExecResult): ForgeReadFailure => ({
    ok: false, code: 'gh_failed', reason: redactedOutput(result.stderr || result.stdout) || `gh exited with code ${result.code}`,
  });
  const badTarget = (repo: string, number?: number): ForgeReadFailure | null =>
    !GITHUB_REPO.test(repo) || (number !== undefined && (!Number.isSafeInteger(number) || number <= 0))
      ? { ok: false, code: 'unexpected_answer', reason: 'not a pull request of a GitHub repository' }
      : null;
  return {
    login: () => ghLogin(configDir, gh),
    async listOpenPullRequests(repo) {
      const bad = badTarget(repo);
      if (bad) return bad;
      const out = await read([
        'pr', 'list', `--repo=${repo}`, '--state=open', `--limit=${PULL_LIST_LIMIT}`,
        `--json=${PULL_SUMMARY_FIELDS}`,
      ]);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const pulls = parsePullRequestList(out.result.stdout);
      return pulls
        ? { ok: true, pulls }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer a list of pull requests' };
    },
    async pullRequestDetails(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const out = await read([
        'pr', 'view', String(number), `--repo=${repo}`,
        `--json=${PULL_SUMMARY_FIELDS},body,baseRefName,headRefName,headRefOid,additions,deletions,changedFiles,comments`,
      ]);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const pull = parsePullRequestDetails(out.result.stdout);
      return pull
        ? { ok: true, pull }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the details of a pull request' };
    },
    async pullRequestDiff(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      // Text from the forge's API: the contributor's branch never reaches this
      // machine's git, so nothing of it can run here.
      const out = await read(['pr', 'diff', String(number), `--repo=${repo}`, '--color=never'], PULL_DIFF_LIMIT + 1024);
      if (!out.ok) return out;
      const { result } = out;
      // Past the buffer the command is stopped with what it printed so far.
      const overran = result.code !== 0 && /maxBuffer/i.test(result.stderr) && result.stdout.length > 0;
      if (result.code !== 0 && !overran) return failed(result);
      const truncated = overran || result.stdout.length > PULL_DIFF_LIMIT;
      return { ok: true, diff: truncated ? result.stdout.slice(0, PULL_DIFF_LIMIT) : result.stdout, truncated };
    },
    async pullRequestReviewThreads(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const [owner = '', name = ''] = repo.split('/');
      // `--raw-field` keeps each value a string: `-F` would read a value
      // starting with "@" as a file. The repository was checked above.
      const out = await read([
        'api', 'graphql',
        `--raw-field=query=${REVIEW_THREADS_QUERY}`,
        `--raw-field=owner=${owner}`,
        `--raw-field=name=${name}`,
        `--field=number=${number}`,
      ], 8 * 1024 * 1024);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const answer = parseReviewThreads(out.result.stdout);
      return answer
        ? { ok: true, ...answer }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the review threads of a pull request' };
    },
    async pullRequestReviews(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const [owner = '', name = ''] = repo.split('/');
      const out = await read([
        'api', 'graphql',
        `--raw-field=query=${GENERAL_REVIEWS_QUERY}`,
        `--raw-field=owner=${owner}`,
        `--raw-field=name=${name}`,
        `--field=number=${number}`,
      ], 8 * 1024 * 1024);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const answer = parseGeneralReviews(out.result.stdout);
      return answer
        ? { ok: true, ...answer }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the reviews of a pull request' };
    },
    async listIssues(repo, label) {
      const bad = badTarget(repo);
      if (bad) return bad;
      if (!plainLabel(label)) return { ok: false, code: 'unexpected_answer', reason: 'not a label of a GitHub repository' };
      const out = await read([
        'issue', 'list', `--repo=${repo}`, '--state=open', `--label=${label}`, `--limit=${ISSUE_LIST_LIMIT}`,
        '--json=number,title,author,labels,state,url,createdAt,updatedAt',
      ]);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const issues = parseIssueList(out.result.stdout);
      return issues
        ? { ok: true, issues }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer a list of issues' };
    },
    async issueDetails(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return { ...bad, reason: 'not an issue of a GitHub repository' };
      const out = await read([
        'issue', 'view', String(number), `--repo=${repo}`,
        '--json=number,title,body,author,labels,state,stateReason,url,createdAt,updatedAt',
      ], 4 * 1024 * 1024);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const issue = parseIssueDetails(out.result.stdout);
      return issue
        ? { ok: true, issue }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the details of an issue' };
    },
    async pullRequestChecks(repo, number) {
      if (!GITHUB_REPO.test(repo) || !Number.isSafeInteger(number) || number <= 0) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a pull request of a GitHub repository' };
      }
      let result: ExecResult;
      try {
        result = await gh(
          ['pr', 'view', String(number), `--repo=${repo}`, '--json=state,isDraft,mergeable,reviewDecision,mergeStateStatus,title,body,statusCheckRollup,labels,closingIssuesReferences'],
          { env: ghEnv(configDir), timeout: GH_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
        );
      } catch {
        return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
      }
      if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
      if (result.code !== 0) {
        return { ok: false, code: 'gh_failed', reason: redactedOutput(result.stderr || result.stdout) || `gh exited with code ${result.code}` };
      }
      const view = parsePullRequestChecks(result.stdout);
      return view
        ? { ok: true, view }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the checks of a pull request' };
    },
    async failedCheckLog(repo, checkUrl) {
      const bad = badTarget(repo);
      if (bad) return bad;
      const job = actionsJobOf(repo, checkUrl);
      if (!job) return { ok: false, code: 'not_actions', reason: 'the check is not a job of the repository\'s own CI' };
      const out = await read(['run', 'view', `--repo=${repo}`, `--job=${job}`, '--log-failed'], CHECK_LOG_BUFFER);
      if (!out.ok) return out;
      const { result } = out;
      // Past the buffer the command is stopped with what it printed so far:
      // the start of the log, so its end is unknown and said to be cut.
      const overran = result.code !== 0 && /maxBuffer/i.test(result.stderr) && result.stdout.length > 0;
      if (result.code !== 0 && !overran) return failed(result);
      const log = checkLogTail(result.stdout);
      return { ok: true, log: overran ? { ...log, truncated: true } : log };
    },
    async pullRequest(repo, number) {
      if (!GITHUB_REPO.test(repo) || !Number.isSafeInteger(number) || number <= 0) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a pull request of a GitHub repository' };
      }
      let result: ExecResult;
      try {
        result = await gh(
          ['pr', 'view', String(number), `--repo=${repo}`, '--json=state,mergeCommit'],
          { env: ghEnv(configDir), timeout: GH_TIMEOUT_MS, windowsHide: true },
        );
      } catch {
        return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
      }
      if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
      if (result.code !== 0) {
        return { ok: false, code: 'gh_failed', reason: redactedOutput(result.stderr || result.stdout) || `gh exited with code ${result.code}` };
      }
      const view = parsePullRequestView(result.stdout);
      return view
        ? { ok: true, ...view }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the state of a pull request' };
    },
    async findIssueComment(repo, number, author, marker) {
      if (!plainRepo(repo) || !Number.isSafeInteger(number) || number <= 0
        || !COMMENT_AUTHOR.test(author) || !COMMENT_MARKER.test(marker)) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a comment lookup on a GitHub repository' };
      }
      // Both values were checked above: neither can close the jq string.
      const filter = `.[] | select((.user.login | ascii_downcase) == "${author.toLowerCase()}" and (.body | contains("${marker}"))) | "\\(.id) \\(.html_url)"`;
      const out = await read(['api', '--paginate', `repos/${repo}/issues/${number}/comments?per_page=100`, `--jq=${filter}`], 16 * 1024 * 1024);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      return { ok: true, comment: foundComment(out.result.stdout) };
    },
    async postIssueComment(repo, number, body) {
      if (!plainRepo(repo) || !Number.isSafeInteger(number) || number <= 0) {
        return { ok: false, code: 'unexpected_answer', reason: 'not an issue or a pull request of a GitHub repository' };
      }
      if (body.trim().length === 0 || body.length > ISSUE_COMMENT_LIMIT + 200) {
        return { ok: false, code: 'unexpected_answer', reason: 'the comment is empty or too long' };
      }
      // `--raw-field` keeps the body a string: `-F` would read "@file" as a
      // file of this machine. The comment endpoint serves pull requests too.
      const out = await read([
        'api', '--method=POST', `repos/${repo}/issues/${number}/comments`, `--raw-field=body=${body}`,
      ]);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const comment = parseCreatedComment(out.result.stdout);
      return comment
        ? { ok: true, comment }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the address of a comment' };
    },
    async issueStates(repo, numbers) {
      const bad = badTarget(repo);
      if (bad) return { ...bad, reason: 'not a GitHub repository' };
      const asked = [...new Set(numbers)].filter((n) => Number.isSafeInteger(n) && n > 0).slice(0, ISSUE_STATE_BATCH);
      if (asked.length === 0) return { ok: true, issues: [] };
      const [owner = '', name = ''] = repo.split('/');
      const out = await read([
        'api', 'graphql',
        `--raw-field=query=${issueStatesQuery(asked)}`,
        `--raw-field=owner=${owner}`,
        `--raw-field=name=${name}`,
      ], 4 * 1024 * 1024);
      if (!out.ok) return out;
      // A number the forge cannot resolve makes gh exit non-zero beside the
      // data of the others: the answer is read whenever it holds data.
      const issues = parseIssueStates(out.result.stdout);
      if (issues) return { ok: true, issues };
      if (out.result.code !== 0) return failed(out.result);
      return { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the state of issues' };
    },
    async closeIssue(repo, number, reason) {
      if (!plainRepo(repo) || !Number.isSafeInteger(number) || number <= 0 || !ISSUE_CLOSE_REASONS.includes(reason)) {
        return { ok: false, code: 'unexpected_answer', reason: 'not an issue of a GitHub repository' };
      }
      const close = (why: IssueCloseReason) => read([
        'api', '--method=PATCH', `repos/${repo}/issues/${number}`, '--raw-field=state=closed', `--raw-field=state_reason=${why}`,
      ]);
      let used: IssueCloseReason = reason;
      let out = await close(used);
      // A GitHub Enterprise server older than the `duplicate` reason refuses
      // it: the issue is closed as not planned rather than left open.
      if (out.ok && out.result.code !== 0 && used === 'duplicate' && /state_reason|422|Validation Failed/i.test(out.result.stderr)) {
        used = 'not_planned';
        out = await close(used);
      }
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const closed = parseClosedIssue(out.result.stdout);
      return closed
        ? { ok: true, url: closed.url, reason: used }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer a closed issue' };
    },
    async pullRequestBranch(repo, number) {
      const bad = badTarget(repo, number);
      if (bad) return bad;
      const out = await read(['pr', 'view', String(number), `--repo=${repo}`, `--json=${PULL_BRANCH_FIELDS}`]);
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const branch = parsePullRequestBranch(out.result.stdout);
      return branch
        ? { ok: true, branch }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the branch of a pull request' };
    },
    async updatePullRequestBranch(repo, number, expectedHeadSha) {
      if (!plainRepo(repo) || !Number.isSafeInteger(number) || number <= 0 || !COMMIT_SHA.test(expectedHeadSha)) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a pull request branch of a GitHub repository' };
      }
      // GitHub merges the base into the branch on its side; the expected head
      // makes it refuse when the contributor pushed since the person looked.
      const out = await read([
        'api', '--method=PUT', `repos/${repo}/pulls/${number}/update-branch`, `--raw-field=expected_head_sha=${expectedHeadSha}`,
      ]);
      if (!out.ok) return out;
      if (out.result.code !== 0) {
        const said = out.result.stderr || out.result.stdout;
        return { ok: false, code: branchUpdateFailure(said), reason: redactedOutput(said) || `gh exited with code ${out.result.code}` };
      }
      return { ok: true };
    },
    async repositorySize(repo) {
      if (!plainRepo(repo)) return { ok: false, code: 'unexpected_answer', reason: 'not a GitHub repository' };
      const out = await read(['api', `repos/${repo}`, '--jq=.size']); // portability: a GitHub API path and a jq filter, no file
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const raw = out.result.stdout.trim();
      const kib = /^\d{1,15}$/.test(raw) ? Number(raw) : Number.NaN;
      return Number.isSafeInteger(kib)
        ? { ok: true, kib }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the size of a repository' };
    },
    async commitParents(repo, sha) {
      if (!plainRepo(repo) || !COMMIT_SHA.test(sha)) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a commit of a GitHub repository' };
      }
      const out = await read(['api', `repos/${repo}/commits/${sha}`, '--jq=[.parents[].sha] | join(" ")']); // portability: a GitHub API path and a jq filter, no file
      if (!out.ok) return out;
      if (out.result.code !== 0) return failed(out.result);
      const parents = out.result.stdout.trim().split(/\s+/).filter((p) => p.length > 0);
      return parents.every((p) => COMMIT_SHA.test(p))
        ? { ok: true, parents }
        : { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the parents of a commit' };
    },
    async repositoryAccess(repo) {
      if (!plainRepo(repo)) return { ok: false, code: 'unexpected_answer', reason: 'not a GitHub repository (owner/name)' };
      const out = await read(['api', `repos/${repo}`, '--jq=.permissions.push']); // portability: a GitHub API path and a jq filter, no file
      if (!out.ok) return out;
      if (out.result.code !== 0) {
        // gh words a missing repository "HTTP 404": a repository the account
        // cannot see is reported the same way by the forge.
        if (/\b404\b|not found/i.test(out.result.stderr)) return { ok: true, exists: false };
        return failed(out.result);
      }
      const answer = out.result.stdout.trim();
      if (answer !== 'true' && answer !== 'false') {
        return { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the permissions on a repository' };
      }
      return { ok: true, exists: true, canPush: answer === 'true' };
    },
    async forkRepository(repo) {
      if (!plainRepo(repo)) return { ok: false, code: 'unexpected_answer', reason: 'not a GitHub repository (owner/name)' };
      // `--clone=false`: nothing is written on this machine, only on the forge.
      const out = await read(['repo', 'fork', repo, '--clone=false', '--remote=false']);
      if (!out.ok) return out;
      // An existing fork is not a failure: gh reports it and exits cleanly.
      return out.result.code === 0 ? { ok: true } : failed(out.result);
    },
    async createPullRequest(input) {
      if (input.headOwner !== undefined && !COMMENT_AUTHOR.test(input.headOwner)) {
        return { ok: false, code: 'unexpected_answer', reason: 'not a GitHub login' };
      }
      // `--flag=value`: a title or a body starting with "-" stays a value.
      const args = [
        'pr', 'create',
        `--repo=${input.repo}`,
        `--base=${input.base}`,
        `--head=${input.headOwner ? `${input.headOwner}:${input.head}` : input.head}`,
        `--title=${input.title}`,
        `--body=${input.body}`,
      ];
      let result: ExecResult;
      try {
        result = await gh(args, { env: ghEnv(configDir), timeout: GH_TIMEOUT_MS, windowsHide: true });
      } catch {
        return { ok: false, code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' };
      }
      if (result.timedOut) return { ok: false, code: 'timed_out', reason: 'gh did not answer in time' };
      if (result.code !== 0) {
        // gh names the pull request that already joins these two branches:
        // opening it again would be the same pull request.
        const existing = /already exists/i.test(result.stderr) ? pullRequestFrom(result.stderr) : null;
        if (existing) return { ok: true, pr: existing, existing: true };
        return {
          ok: false,
          code: 'gh_failed',
          reason: redactedOutput(result.stderr || result.stdout) || `gh exited with code ${result.code}`,
        };
      }
      const pr = pullRequestFrom(result.stdout);
      if (!pr) return { ok: false, code: 'unexpected_answer', reason: 'gh did not answer the address of a pull request' };
      return { ok: true, pr, existing: false };
    },
  };
}

/** Arguments that would let a push overwrite, delete or mirror a remote ref. */
const FORCING = /^(?:--force(?:-with-lease|-if-includes)?(?:=.*)?|-[a-zA-Z]*f[a-zA-Z]*|--mirror|--delete|-d|--prune|--all|--tags)$/;

/**
 * Throws when `args` (the words after `git push`) could rewrite a branch that
 * is already on the remote: a force flag, a deletion, a mirror, or a refspec
 * with a leading `+` or an empty source.
 */
export function assertNoForce(args: readonly string[]): void {
  let afterSeparator = false;
  for (const arg of args) {
    if (arg === '--') { afterSeparator = true; continue; }
    if (!afterSeparator && FORCING.test(arg)) throw new Error(`refusing a forced push (${arg})`);
    if (arg.startsWith('+') || arg.startsWith(':')) throw new Error('refusing a forced push (refspec)');
  }
}

/** A branch name safe to put in a refspec: no option, no forcing prefix, no
 *  refspec separator. */
export function plainBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(branch) && !branch.startsWith('-') && !branch.includes('..');
}

/** The words after `git push` for one branch, always the same shape. */
export function pushArguments(url: string, branch: string): string[] {
  if (!plainBranch(branch)) throw new Error('refusing to push a branch with an unusual name');
  const args = ['--', url, `refs/heads/${branch}:refs/heads/${branch}`];
  assertNoForce(args);
  return args;
}

/** The words after `git push` for one commit sent to a branch of another
 *  repository: a fast-forward of that branch or a refusal, never a rewrite. */
export function pushCommitArguments(url: string, sha: string, branch: string): string[] {
  if (!plainBranch(branch)) throw new Error('refusing to push a branch with an unusual name');
  if (!COMMIT_SHA.test(sha)) throw new Error('refusing to push something that is not a commit');
  const args = ['--', url, `${sha}:refs/heads/${branch}`];
  assertNoForce(args);
  return args;
}

// No terminal behind the daemon: git must fail rather than wait for a
// username or a passphrase nobody will type.
function networkEnv(configDir: string | null = null): NodeJS.ProcessEnv {
  return { ...ghEnv(configDir), GIT_TERMINAL_PROMPT: '0' };
}

/** `-c` pairs that make git ask the project's own `gh` account for an https
 *  password, as the scratch repositories do: the global helper (a vault, the
 *  keychain) may hold another account or none. Reset first, so only gh answers. */
export function ghCredentialConfig(configDir: string | null): string[] {
  return configDir ? ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'] : [];
}

export type RemoteBranchOutcome =
  | { ok: true; sha: string | null }
  | { ok: false; reason: string };

export type GitNetworkOutcome =
  | { ok: true }
  | { ok: false; code: 'rejected' | 'failed' | 'timed_out'; reason: string };

export interface GitTransport {
  /** The sha of `branch` on the remote at `url`, or null when it has none. */
  remoteBranchSha(url: string, branch: string): Promise<RemoteBranchOutcome>;
  /** Fetches `refs/heads/<branch>` of `url` into the local ref `into`. */
  fetchBranch(url: string, branch: string, into: string): Promise<GitNetworkOutcome>;
  /** Pushes the local `branch` to the same name at `url`, never forced. */
  pushBranch(url: string, branch: string): Promise<GitNetworkOutcome>;
}

function failure(result: ExecResult, what: string): Extract<GitNetworkOutcome, { ok: false }> {
  if (result.timedOut) return { ok: false, code: 'timed_out', reason: `${what} timed out` };
  const said = redactedOutput(result.stderr || result.stdout);
  // `! [rejected]` is how git words a push the remote refused as not a
  // fast-forward: the remote branch moved, and it is never overwritten.
  const rejected = /\[rejected\]|non-fast-forward|fetch first/i.test(result.stderr);
  return { ok: false, code: rejected ? 'rejected' : 'failed', reason: said || `${what} failed (code ${result.code})` };
}

/** The remote side of git for the repository at `repo`. */
export function gitTransport(repo: string, runners: ForgeRunners = {}, ghConfigDir: string | null = null): GitTransport {
  const git = runners.git ?? hostGit;
  const run = async (args: string[]): Promise<ExecResult> => {
    try {
      return await git([...ghCredentialConfig(ghConfigDir), '-C', repo, ...args], { env: networkEnv(ghConfigDir), timeout: NETWORK_TIMEOUT_MS, windowsHide: true });
    } catch (err) {
      return { code: 1, stdout: '', stderr: (err as Error).message };
    }
  };
  return {
    async remoteBranchSha(url, branch) {
      if (!plainBranch(branch)) return { ok: false, reason: 'unusual branch name' };
      const result = await run(['ls-remote', '--heads', '--', url, `refs/heads/${branch}`]);
      if (result.code !== 0) return { ok: false, reason: failure(result, 'reading the remote').reason };
      const line = result.stdout.split('\n').map((l) => l.trim()).find((l) => l.endsWith(`\trefs/heads/${branch}`));
      const sha = line?.split('\t')[0] ?? null;
      if (sha !== null && !/^[0-9a-f]{40,64}$/.test(sha)) return { ok: false, reason: 'the remote answered something that is not a commit' };
      return { ok: true, sha };
    },
    async fetchBranch(url, branch, into) {
      if (!plainBranch(branch) || !plainBranch(into)) return { ok: false, code: 'failed', reason: 'unusual branch name' };
      // No leading `+`: the local ref only moves forward, like the remote one.
      const result = await run(['fetch', '--no-tags', '--', url, `refs/heads/${branch}:${into}`]);
      return result.code === 0 ? { ok: true } : failure(result, 'the fetch');
    },
    async pushBranch(url, branch) {
      let args: string[];
      try { args = pushArguments(url, branch); } catch (err) {
        return { ok: false, code: 'failed', reason: (err as Error).message };
      }
      const result = await run(['push', ...args]);
      return result.code === 0 ? { ok: true } : failure(result, 'the push');
    },
  };
}

/**
 * The words after `git push` that delete `branch` on the remote at `url`, and
 * only while it still ends on `sha`: the one deletion this module builds, for
 * the branch of a landed job a person approved (`landing-branch-delete.ts`).
 * The lease names the exact commit, so a branch someone pushed to since is
 * refused, never deleted; no other ref is touched.
 */
export function deleteBranchArguments(url: string, branch: string, sha: string): string[] {
  if (!plainBranch(branch)) throw new Error('refusing to delete a branch with an unusual name');
  if (!COMMIT_SHA.test(sha)) throw new Error('refusing to delete a branch without the commit it must end on');
  return [`--force-with-lease=refs/heads/${branch}:${sha}`, '--', url, `:refs/heads/${branch}`];
}

/** Deletes `branch` on the remote at `url` while it still ends on `sha`. */
export async function deleteRemoteBranch(
  repo: string, url: string, branch: string, sha: string, runners: ForgeRunners = {}, ghConfigDir: string | null = null,
): Promise<GitNetworkOutcome> {
  let args: string[];
  try { args = deleteBranchArguments(url, branch, sha); } catch (err) {
    return { ok: false, code: 'failed', reason: (err as Error).message };
  }
  const git = runners.git ?? hostGit;
  let result: ExecResult;
  try {
    result = await git([...ghCredentialConfig(ghConfigDir), '-C', repo, 'push', ...args], { env: networkEnv(ghConfigDir), timeout: NETWORK_TIMEOUT_MS, windowsHide: true });
  } catch (err) {
    result = { code: 1, stdout: '', stderr: (err as Error).message };
  }
  return result.code === 0 ? { ok: true } : failure(result, 'the deletion of the remote branch');
}

// Shared with the reader of a pull request's whole page (`forge-pull-view.ts`),
// so both read the forge's answers with the same bounds.
export {
  boundedText, checkOf, CLOSING_ISSUE_LIMIT, COMMIT_SHA, GITHUB_REPO, headRepositoryOf, httpsUrl, IssueReferenceSchema,
  itemsOf, jsonOf, LABEL_LIMIT, LabelSchema, LoginSchema, MergeStateSchema,
};
