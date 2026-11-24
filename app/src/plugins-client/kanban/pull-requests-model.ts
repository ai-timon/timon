/**
 * What the "Open pull requests" widget reads from the daemon
 * (`GET /api/projects/:slug/pull-requests`), and the little logic it keeps
 * out of the component: the author filter and the verdict a row shows.
 */

export type ReviewVerdict = 'mergeable' | 'changes_requested' | 'reject' | 'product_decision';
export type ReviewState = 'draft' | 'running' | 'done' | 'failed';

export type PullReview = {
  id: string;
  number: number;
  state: ReviewState;
  agent: string;
  verdict: ReviewVerdict | null;
  report: string | null;
  mission_id: string | null;
  pr_updated_at: string | null;
  updated_at: number;
};

import type { JobLinks } from './landing-api';
import type { BranchGestures, BranchLock } from './forge-branch-api';

/** The way back from a pull request (`forge-links.ts`): our job behind it, when the reader sees it. */
export type PullRequestLinks = JobLinks & { job_id: string | null };

export type PullRequestItem = {
  number: number;
  title: string;
  author: string | null;
  url: string;
  isDraft: boolean;
  updatedAt: string;
  headOwner: string | null;
  external: boolean;
  review: PullReview | null;
  /** Absent from an older daemon. */
  links?: PullRequestLinks;
  /** How GitHub sees the branch against its base (`dirty`: in conflict, `behind`); absent from an older daemon. */
  mergeStateStatus?: string;
  /** What the person may do about the branch (`forge-branch-update.ts`); absent from an older daemon. */
  gestures?: BranchGestures;
};

export type PullRequestList = { repo: string; pulls: PullRequestItem[] };

/** The authors of the list, each once, sorted; a deleted account is left out. */
export function pullAuthors(pulls: readonly PullRequestItem[]): string[] {
  return [...new Set(pulls.map((p) => p.author).filter((a): a is string => !!a))]
    .sort((a, b) => a.localeCompare(b));
}

/** The pull requests of `author`, all of them when it is null. */
export function filterByAuthor(pulls: readonly PullRequestItem[], author: string | null): PullRequestItem[] {
  return author === null ? [...pulls] : pulls.filter((p) => p.author === author);
}

/** What the row says of its review: nothing for a draft never sent. */
export type ReviewBadge =
  | { kind: 'running' }
  | { kind: 'failed' }
  | { kind: 'verdict'; verdict: ReviewVerdict | null; outdated: boolean };

export function reviewBadge(pull: PullRequestItem): ReviewBadge | null {
  const review = pull.review;
  if (!review || review.state === 'draft') return null;
  if (review.state === 'running') return { kind: 'running' };
  if (review.state === 'failed') return { kind: 'failed' };
  // ISO dates compare as text: a later change of the pull request makes the
  // verdict one about code that is no longer there.
  const outdated = !!review.pr_updated_at && !!pull.updatedAt && pull.updatedAt > review.pr_updated_at;
  return { kind: 'verdict', verdict: review.verdict, outdated };
}

/** True while a review runs: the widget then asks again for its verdict. */
export function anyReviewRunning(pulls: readonly PullRequestItem[]): boolean {
  return pulls.some((p) => p.review?.state === 'running');
}

/** What the row says of its branch: only a state that calls for a gesture. */
export function branchChip(pull: PullRequestItem): 'conflict' | 'behind' | null {
  if (pull.mergeStateStatus === 'dirty') return 'conflict';
  if (pull.mergeStateStatus === 'behind' && pull.gestures?.update_branch) return 'behind';
  return null;
}

/**
 * Why the branch cannot be written from here, said on the row: without it,
 * a missing "Update the branch" or "Resolve the conflict…" has no reason.
 */
export function branchLock(pull: PullRequestItem): BranchLock | null {
  return pull.gestures?.locked ?? null;
}

/**
 * How old a hidden tab's list may be before it is read again. The PR tab of
 * the Git stack stays mounted behind the front tab for its count; reading
 * the list at every mount would start `gh` for a list nobody sees.
 */
export const HIDDEN_PULLS_FRESH_MS = 60_000;

/**
 * Whether the widget reads its list now: always in front; behind another tab
 * only when no list was read for the project on this page, or the last one
 * is older than `HIDDEN_PULLS_FRESH_MS`.
 */
export function shouldReadPulls(front: boolean, readAt: number | null, now: number): boolean {
  return front || readAt === null || now - readAt >= HIDDEN_PULLS_FRESH_MS;
}

/** The last list read per project, shared by every PR widget of the page. */
const lastRead = new Map<string, { list: PullRequestList; at: number }>();

export function lastPullList(slug: string): { list: PullRequestList; at: number } | undefined {
  return lastRead.get(slug);
}

export function keepPullList(slug: string, list: PullRequestList, at = Date.now()): void {
  lastRead.set(slug, { list, at });
}

/** For tests: a page that starts with nothing read. */
export function forgetPullListsForTests(): void {
  lastRead.clear();
}

/** A gesture on a pull request, from its row's menu or from its window. */
export type PullActionId = 'resolveConflict' | 'updateBranch' | 'review' | 'report' | 'askContributor' | 'comment' | 'forge';

/** A branch gesture that runs a moment before its dialog opens. */
export type PullBranchWork = 'updateBranch' | 'askContributor';

/** Why a gesture shows greyed rather than not at all: a person must read why it is refused. */
export type PullActionBlock = BranchLock | 'branch_busy' | 'review_running';

export type PullAction = {
  id: PullActionId;
  /** Greyed, with this reason; null when it can be done. */
  blocked: PullActionBlock | null;
  /** This very gesture is under way: its button shows a spinner. */
  busy: boolean;
};

/**
 * One button filled when the state calls for one, a few outlined beside it,
 * the rest in "…". A pull request with nothing to unblock has no filled
 * button: the review brief is a help, not the next step.
 */
export type PullActions = { primary: PullAction | null; secondary: PullAction[]; overflow: PullAction[] };

/** What is under way on the pull request, as the widget knows it. */
export type PullWork = { branch?: PullBranchWork | null; preparing?: boolean };

const BRANCH_GESTURES: ReadonlySet<PullActionId> = new Set(['updateBranch', 'resolveConflict', 'askContributor']);
/** The order of the "…" menu, from the row and from the window. */
const OVERFLOW_ORDER: readonly PullActionId[] = ['review', 'report', 'updateBranch', 'resolveConflict', 'askContributor', 'comment', 'forge'];
const MAX_SECONDARY = 2;
/** Without a filled button, the card keeps the same number of buttons. */
const MAX_SECONDARY_ALONE = 3;

/**
 * Which gestures a pull request shows, and where: the one its state calls for
 * as the filled button, the frequent others beside it, the rare ones and the
 * duplicates in "…". The row's menu lists them in this same order.
 *
 * The primary is, in turn: resolving a conflict this person may resolve,
 * updating a branch that is behind, talking to the author of a draft (not yet
 * ready for a review), reading a review that still matches the code, and
 * otherwise none. The review brief only writes a brief to copy, nothing is
 * sent to an agent: it is never the primary, and comes first of the outlined
 * buttons when there is none. A branch gesture refused by a lock stays,
 * greyed beside it, so the person sees why it is missing.
 */
export function pullRequestActions(pull: PullRequestItem, work: PullWork = {}): PullActions {
  const gestures = pull.gestures;
  const lock = gestures?.locked ?? null;
  const badge = reviewBadge(pull);
  const conflict = pull.mergeStateStatus === 'dirty';
  const behind = pull.mergeStateStatus === 'behind';
  const hasReport = !!pull.review?.report;
  const freshReport = hasReport && badge?.kind === 'verdict' && !badge.outdated;

  const action = (id: PullActionId, refused: PullActionBlock | null = null): PullAction => {
    const branchBusy = BRANCH_GESTURES.has(id) && !!work.branch;
    const busy = (id === 'review' && !!work.preparing) || (BRANCH_GESTURES.has(id) && work.branch === id);
    const blocked = refused
      ?? (id === 'review' && badge?.kind === 'running' ? 'review_running' : null)
      ?? (branchBusy && !busy ? 'branch_busy' : null);
    return { id, blocked, busy };
  };

  const allowed: Record<PullActionId, boolean> = {
    review: true,
    report: hasReport,
    updateBranch: !!gestures?.update_branch,
    resolveConflict: !!gestures?.resolve_conflict,
    askContributor: !!gestures?.ask_contributor,
    comment: true,
    forge: true,
  };

  const primaryId: PullActionId | null = conflict && allowed.resolveConflict ? 'resolveConflict'
    : behind && allowed.updateBranch ? 'updateBranch'
      : pull.isDraft ? 'comment'
        : freshReport ? 'report'
          : null;

  // A branch gesture the state calls for but a lock refuses: greyed, with its reason.
  const refused: PullAction[] = [];
  if (lock && conflict && !allowed.resolveConflict) refused.push(action('resolveConflict', lock));
  if (lock && behind && !allowed.updateBranch) refused.push(action('updateBranch', lock));

  const reading: PullActionId = freshReport ? 'report' : 'review';
  const candidates: PullActionId[] = [];
  if (allowed.askContributor) candidates.push('askContributor');
  if (primaryId !== null && (BRANCH_GESTURES.has(primaryId) || primaryId === 'comment')) candidates.push(reading);
  candidates.push('comment');

  const max = primaryId === null ? MAX_SECONDARY_ALONE : MAX_SECONDARY;
  const taken = new Set<PullActionId>(primaryId === null ? ['review'] : [primaryId]);
  const secondary: PullAction[] = primaryId === null ? [action('review')] : [];
  for (const a of refused) {
    if (secondary.length < max && !taken.has(a.id)) { secondary.push(a); taken.add(a.id); }
  }
  for (const id of candidates) {
    if (secondary.length < max && !taken.has(id)) { secondary.push(action(id)); taken.add(id); }
  }
  const overflow = [
    ...refused.filter((a) => !taken.has(a.id)),
    ...OVERFLOW_ORDER.filter((id) => allowed[id] && !taken.has(id)).map((id) => action(id)),
  ];
  return { primary: primaryId === null ? null : action(primaryId), secondary, overflow };
}

/** Everything the "…" menu of a pull request's row lists, in the window's order. */
export function pullMenuActions(actions: PullActions): PullAction[] {
  return [...(actions.primary ? [actions.primary] : []), ...actions.secondary, ...actions.overflow];
}
