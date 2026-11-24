/**
 * What the detail window of a pull request reads from the daemon
 * (`GET /api/projects/:slug/pull-requests/:number`, `pull-request-page.ts`),
 * and the little logic it keeps out of the component: the diff cut by file,
 * the addresses it may link to, the duration of a check, and the markdown of
 * a text written on the forge.
 *
 * Every text of the page was written by someone on GitHub: React escapes it,
 * and the markdown is rendered without raw HTML.
 */

import { Marked, type Tokens } from 'marked';
import { apiErrorMessage } from '@/lib/api-error';
import { escapeHtml, sanitizeMarkdownHtml } from '@/lib/markdown';

export type ForgeLabel = { name: string; color: string | null };
export type IssueReference = { repo: string | null; number: number; url: string | null };

export type PullState = 'open' | 'closed' | 'merged';
export type ReviewState = 'approved' | 'changes_requested' | 'commented' | 'dismissed' | 'pending';
export type CheckStatus = 'pass' | 'fail' | 'pending' | 'skipped';

export type PageComment = {
  kind: 'comment';
  author: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
  url: string | null;
  hidden: boolean;
};

export type PageReview = {
  kind: 'review';
  author: string | null;
  state: ReviewState;
  body: string;
  bodyTruncated: boolean;
  createdAt: string;
};

export type PageTimelineItem = PageComment | PageReview;

export type PageThreadComment = { author: string | null; body: string; bodyTruncated: boolean; createdAt: string; url: string | null };

export type PageThread = {
  path: string | null;
  line: number | null;
  resolved: boolean;
  outdated: boolean;
  comments: PageThreadComment[];
  commentsMore: number;
};

export type PageCommit = { sha: string; headline: string; author: string | null; date: string; url: string | null };
export type PageFile = { path: string; additions: number; deletions: number };
export type PageCheck = {
  name: string;
  status: CheckStatus;
  url: string | null;
  workflow: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

export type PullRequestPage = {
  number: number;
  title: string;
  url: string;
  state: PullState;
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
  headRepository: string | null;
  isCrossRepository: boolean;
  maintainerCanModify: boolean;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  mergeStateStatus: string;
  reviewDecision: 'approved' | 'changes_requested' | 'review_required' | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: string;
  bodyTruncated: boolean;
  labels: ForgeLabel[];
  milestone: { title: string; url: string | null } | null;
  assignees: string[];
  assigneesMore: number;
  reviewRequests: string[];
  reviewRequestsMore: number;
  closingIssues: IssueReference[];
  timeline: PageTimelineItem[];
  timelineMore: number;
  commits: PageCommit[];
  commitsMore: number;
  files: PageFile[];
  filesMore: number;
  checks: PageCheck[];
  checksMore: number;
  threads: PageThread[];
  threadsMore: number;
  threadsError: string | null;
};

export type Read<T> = { ok: true; value: T } | { ok: false; message: string };

const pagePath = (slug: string, number: number) =>
  `/api/ui/projects/${encodeURIComponent(slug)}/pull-requests/${number}`;

async function readJson<T>(url: string, pick: (json: Record<string, unknown>) => T | null): Promise<Read<T>> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    const value = res.ok ? pick(json) : null;
    return value === null ? { ok: false, message: apiErrorMessage(json, { status: res.status }) } : { ok: true, value };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

/** The page; `updated` is the pull request's last change as the list shows
 *  it, so a page cached before it is read again. */
export function getPullRequestPage(
  slug: string, number: number, opts: { fresh?: boolean; updated?: string } = {},
): Promise<Read<PullRequestPage>> {
  const query = new URLSearchParams();
  if (opts.fresh) query.set('fresh', '1');
  if (opts.updated) query.set('updated', opts.updated);
  const suffix = query.toString() ? `?${query}` : '';
  return readJson(`${pagePath(slug, number)}${suffix}`, (json) => (json.pull && typeof json.pull === 'object' ? json.pull as PullRequestPage : null));
}

export type CheckLog = { tail: string; truncated: boolean };

export function getCheckLog(slug: string, number: number, checkUrl: string): Promise<Read<CheckLog>> {
  return readJson(
    `${pagePath(slug, number)}/check-log?${new URLSearchParams({ url: checkUrl })}`,
    (json) => (json.log && typeof json.log === 'object' ? json.log as CheckLog : null),
  );
}

export function getPullRequestDiff(slug: string, number: number): Promise<Read<{ diff: string; truncated: boolean }>> {
  return readJson(`${pagePath(slug, number)}/diff`, (json) => (
    typeof json.diff === 'string' ? { diff: json.diff, truncated: json.truncated === true } : null
  ));
}

const GITHUB_HOST = /^(?:[a-z0-9-]+\.)*(?:github\.com|githubusercontent\.com)$/i;

/** `url` when it is an https address on a GitHub host; null otherwise. The
 *  daemon filters them already: the window does not take it on trust. */
export function forgeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && GITHUB_HOST.test(parsed.hostname) ? url : null;
  } catch {
    return null;
  }
}

/** The patch of each file of a unified diff, keyed by its path (the new one
 *  for a rename, the old one for a deletion). */
export function splitDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  let path: string | null = null;
  let lines: string[] = [];
  const flush = () => { if (path !== null) files.set(path, lines.join('\n')); };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const m = / b\/(.+)$/.exec(line);
      path = m?.[1] ?? null;
      lines = [line];
      continue;
    }
    // `+++ b/<path>` names the file when the header's path is ambiguous
    // (a space in a name); `/dev/null` is a deletion, which keeps the header's.
    if (line.startsWith('+++ b/')) path = line.slice('+++ b/'.length);
    lines.push(line);
  }
  flush();
  return files;
}

/** How long a finished check ran, in seconds, or null. */
export function checkSeconds(check: PageCheck): number | null {
  if (!check.startedAt || !check.completedAt) return null;
  const ms = Date.parse(check.completedAt) - Date.parse(check.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms / 1000) : null;
}

/** What is left of a piece of raw HTML: its text, without a tag or a comment. */
export function htmlText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, '');
}

// A markdown engine of its own: a text from the forge keeps no raw HTML (its
// tags and comments are dropped, their text kept, escaped: GitHub's bots
// write `<sub>` and `<br/>`), and only an http(s) link stays a link, opened
// apart from the app.
const forgeMarked = new Marked({ gfm: true, breaks: false });
forgeMarked.use({
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(htmlText(text));
    },
    link(this: { parser: { parseInline: (tokens: Tokens.Link['tokens']) => string } }, token: Tokens.Link): string {
      const label = this.parser.parseInline(token.tokens);
      if (!/^https?:\/\//i.test(token.href)) return label;
      return `<a href="${escapeHtml(token.href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
  },
});

/** A text written on the forge, as safe HTML. */
export function forgeMarkdownHtml(md: string): string {
  if (!md.trim()) return '';
  const raw = forgeMarked.parse(md, { async: false }) as string;
  const html = sanitizeMarkdownHtml(raw);
  // The sanitizer may drop `target`: every kept link is set apart again.
  return html.replace(/<a (?![^>]*target=)/g, '<a target="_blank" rel="noopener noreferrer" ');
}

/**
 * Where each review thread of a file sits in its patch: under the line whose
 * number in the new file is the thread's line. A thread on lines that changed
 * since (`outdated`), on a line the patch does not show, or without a line is
 * left `unplaced`: the window lists it under the file.
 */
export function placeThreads(
  lines: readonly string[], threads: readonly PageThread[],
): { at: Map<number, PageThread[]>; unplaced: PageThread[] } {
  const byLine = new Map<number, number>();
  let next: number | null = null;
  lines.forEach((line, i) => {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) { next = Number(hunk[1]); return; }
    if (next === null || line.startsWith('-') || line.startsWith('\\')) return;
    byLine.set(next, i);
    next += 1;
  });
  const at = new Map<number, PageThread[]>();
  const unplaced: PageThread[] = [];
  for (const thread of threads) {
    const index = !thread.outdated && thread.line !== null ? byLine.get(thread.line) : undefined;
    if (index === undefined) { unplaced.push(thread); continue; }
    at.set(index, [...(at.get(index) ?? []), thread]);
  }
  return { at, unplaced };
}

/** How many checks of a pull request stand in each state. */
export function checkCounts(checks: readonly PageCheck[]): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { fail: 0, pending: 0, pass: 0, skipped: 0 };
  for (const c of checks) counts[c.status] += 1;
  return counts;
}

/** Where a pull request stands against its base, as the box under its conversation says it. */
export type MergeState = 'merged' | 'closed' | 'draft' | 'conflict' | 'behind' | 'blocked' | 'ready' | 'unknown';

/**
 * GitHub's merge state, read for a person: a conflict wins over everything
 * open, `unstable` (a check that is not required failed) still merges, and
 * `unknown` is GitHub still computing.
 */
export function mergeState(page: Pick<PullRequestPage, 'state' | 'isDraft' | 'mergeable' | 'mergeStateStatus'>): MergeState {
  if (page.state !== 'open') return page.state;
  if (page.isDraft) return 'draft';
  if (page.mergeable === 'conflicting' || page.mergeStateStatus === 'dirty') return 'conflict';
  if (page.mergeStateStatus === 'behind') return 'behind';
  if (page.mergeStateStatus === 'blocked') return 'blocked';
  if (['clean', 'has_hooks', 'unstable'].includes(page.mergeStateStatus)) return 'ready';
  return 'unknown';
}
