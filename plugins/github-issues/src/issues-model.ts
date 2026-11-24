/**
 * What the browser half of `github-issues` decides without drawing anything:
 * the shapes its routes answer, how a typed issue reference reads, the order
 * of the list and the words for a refusal. Kept apart so it is tested alone.
 */

export type IssueLabel = { name: string; color: string | null };

/** The idea an issue became, as the routes answer it. */
export type IssueTodo = {
  id: number;
  status: string;
  progress: string | null;
  pr: { number: number; url: string | null; state: string } | null;
};

/** One labelled issue, as `GET candidates` lists it. Its texts are data. */
export type Candidate = {
  number: number;
  title: string;
  author: string | null;
  url: string;
  labels: IssueLabel[];
  updatedAt: string;
  todo: IssueTodo | null;
};

export type Candidates = {
  project: string;
  repo: string;
  url: string;
  label: string;
  issues: Candidate[];
  hidden: number;
};

/** One issue, as `GET issue` reads it for the Issue window. */
export type IssueDetails = {
  project: string;
  repo: string;
  number: number;
  title: string;
  author: string | null;
  url: string;
  state: 'open' | 'closed';
  labels: IssueLabel[];
  body: string;
  truncated: boolean;
  todo: IssueTodo | null;
};

export type ProjectLabel = { project: string; repo: string; label: string; custom: boolean; hidden: number };

/** Largest issue number the routes accept. */
const MAX_NUMBER = 1_000_000_000;
/** Characters of a label the routes accept. */
export const LABEL_LIMIT = 50;

export type IssueInput = { number: number } | { problem: 'empty' | 'invalid' | 'otherRepo' };

/**
 * A number typed in the "+" field: `212`, `#212`, `owner/name#212` or the
 * issue's address on GitHub. A reference to another repository is refused:
 * the project imports from its own.
 */
export function parseIssueInput(text: string, repo: string | null): IssueInput {
  const value = text.trim();
  if (!value) return { problem: 'empty' };
  let named: string | null = null;
  let digits: string | undefined;
  const url = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(?:issues|pull)\/(\d+)\/?(?:[?#].*)?$/i.exec(value);
  const ref = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)$/.exec(value);
  const bare = /^#?(\d+)$/.exec(value);
  if (url) { named = url[1]!; digits = url[2]; }
  else if (ref) { named = ref[1]!; digits = ref[2]; }
  else if (bare) digits = bare[1];
  if (digits === undefined) return { problem: 'invalid' };
  const number = Number(digits);
  if (!Number.isSafeInteger(number) || number <= 0 || number > MAX_NUMBER) return { problem: 'invalid' };
  if (named && repo && named.toLowerCase() !== repo.toLowerCase()) return { problem: 'otherRepo' };
  return { number };
}

/** Not imported first, the forge's order kept within each group (newest first). */
export function sortCandidates(issues: readonly Candidate[]): Candidate[] {
  return [...issues.filter((i) => !i.todo), ...issues.filter((i) => i.todo)];
}

/** Issues left to import. */
export function toImport(issues: readonly Candidate[]): number {
  return issues.filter((i) => !i.todo).length;
}

/** Why the label typed in the settings would be refused; `null` when it is fine. */
export function labelProblem(label: string): 'empty' | 'tooLong' | 'comma' | null {
  const value = label.trim();
  if (!value) return 'empty';
  if (value.length > LABEL_LIMIT) return 'tooLong';
  // `gh issue list --label` splits on commas.
  if (value.includes(',')) return 'comma';
  return null;
}

/** The message key for a route's refusal code. */
export function errorKey(code: string | null | undefined): string {
  switch (code) {
    case 'not_configured': return 'error.notConfigured';
    case 'forbidden': return 'error.forbidden';
    case 'sign_in_required': return 'error.signIn';
    case 'unavailable': return 'error.unavailable';
    case 'busy': return 'error.busy';
    case 'issue_not_found': return 'error.notFound';
    case 'issue_closed': return 'error.closed';
    case 'invalid_label': return 'error.invalidLabel';
    default: return 'error.generic';
  }
}

/** A web address that may become a link: http(s) only. */
export function safeHref(url: string | null | undefined): string | null {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

/**
 * How old a hidden tab's list may be before it is read again. Kept mounted
 * behind the stack's front tab for its count, the widget would otherwise ask
 * GitHub at every mount for a list nobody sees.
 */
export const HIDDEN_LIST_FRESH_MS = 60_000;

/**
 * Whether the widget reads its list now: always in front; behind another tab
 * only when the list it has (or the one a widget mounted before left) is
 * older than `HIDDEN_LIST_FRESH_MS`, or missing.
 */
export function shouldRead(front: boolean, readAt: number | null, now: number): boolean {
  return front || readAt === null || now - readAt >= HIDDEN_LIST_FRESH_MS;
}
