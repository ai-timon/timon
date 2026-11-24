/**
 * Which gestures a pull request shows, and where (`pullRequestActions`): the
 * filled one its state calls for, the frequent ones beside it, the rest in
 * "…"; and the merge state its window's box says (`mergeState`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pullMenuActions, pullRequestActions, type PullActions, type PullRequestItem } from './pull-requests-model';
import { checkCounts, mergeState, type PageCheck } from './pull-request-page-api';

function pull(extra: Partial<PullRequestItem> = {}): PullRequestItem {
  return {
    number: 12, title: 'Add a dark theme', author: 'stranger', url: 'https://github.com/acme/widgets/pull/12',
    isDraft: false, updatedAt: '2026-11-17T10:00:00Z', headOwner: 'stranger', external: true, review: null,
    mergeStateStatus: 'clean',
    gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false, locked: null },
    ...extra,
  };
}

const review = (extra: Partial<NonNullable<PullRequestItem['review']>> = {}): NonNullable<PullRequestItem['review']> => ({
  id: 'r1', number: 12, state: 'done', agent: 'acme.reviewer', verdict: 'mergeable', report: 'VERDICT: MERGEABLE',
  mission_id: 'm1', pr_updated_at: '2026-11-17T10:00:00Z', updated_at: 1, ...extra,
});

/** The layout as ids, a greyed gesture written `id!reason`, one under way `id*`. */
function layout(a: PullActions) {
  const word = (x: PullActions['secondary'][number]) => `${x.id}${x.blocked ? `!${x.blocked}` : ''}${x.busy ? '*' : ''}`;
  return { primary: a.primary ? word(a.primary) : null, secondary: a.secondary.map(word), overflow: a.overflow.map(word) };
}

test('a clean pull request fills no button: the review brief leads the outlined ones, a comment beside it', () => {
  assert.deepEqual(layout(pullRequestActions(pull())), {
    primary: null, secondary: ['review', 'comment'], overflow: ['forge'],
  });
});

test('a conflict this person may resolve puts the resolution first, asking the contributor beside it', () => {
  const p = pull({ mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: true, locked: null } });
  assert.deepEqual(layout(pullRequestActions(p)), {
    primary: 'resolveConflict', secondary: ['askContributor', 'review'], overflow: ['comment', 'forge'],
  });
});

test('a conflict the project leaves to its author fills no button: the brief, then asking the contributor and a comment', () => {
  const p = pull({ mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: null } });
  assert.deepEqual(layout(pullRequestActions(p)), {
    primary: null, secondary: ['review', 'askContributor', 'comment'], overflow: ['forge'],
  });
});

test('a branch behind its base puts its update first', () => {
  const p = pull({ mergeStateStatus: 'behind', gestures: { update_branch: true, ask_contributor: false, resolve_conflict: false, locked: null } });
  assert.deepEqual(layout(pullRequestActions(p)), {
    primary: 'updateBranch', secondary: ['review', 'comment'], overflow: ['forge'],
  });
});

test('a locked branch shows the refused gesture greyed with its reason, never hides it', () => {
  // In conflict, its author does not let the maintainers write it: no resolution here.
  const conflict = pull({ mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: 'not_allowed' } });
  assert.deepEqual(layout(pullRequestActions(conflict)), {
    primary: null, secondary: ['review', 'resolveConflict!not_allowed', 'askContributor'], overflow: ['comment', 'forge'],
  });
  // Behind, its fork deleted: nothing left to update.
  const behind = pull({ mergeStateStatus: 'behind', gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false, locked: 'fork_deleted' } });
  assert.deepEqual(layout(pullRequestActions(behind)), {
    primary: null, secondary: ['review', 'updateBranch!fork_deleted', 'comment'], overflow: ['forge'],
  });
  // Locked but neither behind nor in conflict: nothing is refused, nothing greyed.
  const idle = pull({ gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false, locked: 'not_allowed' } });
  assert.deepEqual(layout(pullRequestActions(idle)).secondary, ['review', 'comment']);
});

test('a draft, not ready for a review, puts a comment to its author first', () => {
  assert.deepEqual(layout(pullRequestActions(pull({ isDraft: true, mergeStateStatus: 'draft' }))), {
    primary: 'comment', secondary: ['review'], overflow: ['forge'],
  });
});

test('a review concluded and still current shows its report first; once the code changed, no filled button and the brief first', () => {
  assert.deepEqual(layout(pullRequestActions(pull({ review: review() }))), {
    primary: 'report', secondary: ['comment'], overflow: ['review', 'forge'],
  });
  const outdated = pull({ updatedAt: '2026-11-18T08:00:00Z', review: review() });
  assert.deepEqual(layout(pullRequestActions(outdated)), {
    primary: null, secondary: ['review', 'comment'], overflow: ['report', 'forge'],
  });
});

test('without any branch gesture (an older daemon), the brief and a comment remain, none filled', () => {
  const p = pull({ mergeStateStatus: 'dirty', gestures: undefined });
  assert.deepEqual(layout(pullRequestActions(p)), { primary: null, secondary: ['review', 'comment'], overflow: ['forge'] });
});

test('a gesture under way spins, the other branch gestures grey; a running review greys its button', () => {
  const p = pull({ mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: true, locked: null } });
  assert.deepEqual(layout(pullRequestActions(p, { branch: 'askContributor' })), {
    primary: 'resolveConflict!branch_busy', secondary: ['askContributor*', 'review'], overflow: ['comment', 'forge'],
  });
  assert.equal(layout(pullRequestActions(pull(), { preparing: true })).secondary[0], 'review*');
  assert.equal(layout(pullRequestActions(pull({ review: review({ state: 'running', verdict: null }) }))).secondary[0], 'review!review_running');
});

test('the row\'s menu lists every gesture once, in the window\'s order', () => {
  const p = pull({ mergeStateStatus: 'dirty', review: review(), gestures: { update_branch: false, ask_contributor: true, resolve_conflict: true, locked: null } });
  const ids = pullMenuActions(pullRequestActions(p)).map((a) => a.id);
  assert.deepEqual(ids, ['resolveConflict', 'askContributor', 'report', 'review', 'comment', 'forge']);
  assert.equal(new Set(ids).size, ids.length);
  // Without a filled button, the menu starts with the brief.
  assert.deepEqual(pullMenuActions(pullRequestActions(pull())).map((a) => a.id), ['review', 'comment', 'forge']);
});

const page = (extra: Partial<Parameters<typeof mergeState>[0]> = {}) => ({
  state: 'open' as const, isDraft: false, mergeable: 'mergeable' as const, mergeStateStatus: 'clean', ...extra,
});

test('the box reads GitHub\'s merge state for a person', () => {
  assert.equal(mergeState(page()), 'ready');
  assert.equal(mergeState(page({ mergeStateStatus: 'unstable' })), 'ready');
  assert.equal(mergeState(page({ mergeable: 'conflicting', mergeStateStatus: 'unknown' })), 'conflict');
  assert.equal(mergeState(page({ mergeStateStatus: 'dirty' })), 'conflict');
  assert.equal(mergeState(page({ mergeStateStatus: 'behind' })), 'behind');
  assert.equal(mergeState(page({ mergeStateStatus: 'blocked' })), 'blocked');
  assert.equal(mergeState(page({ isDraft: true, mergeStateStatus: 'draft' })), 'draft');
  assert.equal(mergeState(page({ mergeable: 'unknown', mergeStateStatus: 'unknown' })), 'unknown');
  assert.equal(mergeState(page({ state: 'merged' })), 'merged');
  assert.equal(mergeState(page({ state: 'closed', isDraft: true })), 'closed');
});

test('the checks are counted per state', () => {
  const check = (status: PageCheck['status']): PageCheck => ({ name: status, status, url: null, workflow: null, startedAt: null, completedAt: null });
  assert.deepEqual(checkCounts([check('fail'), check('pass'), check('pass'), check('pending')]), { fail: 1, pending: 1, pass: 2, skipped: 0 });
});
