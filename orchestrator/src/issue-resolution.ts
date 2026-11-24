/**
 * Once a job's pull request is merged, the comment that tells an issue's
 * author it is fixed (`docs/FORGE-FLOW-PLAN.md` §2 (a) step 10, decision n° 5).
 *
 * The daemon only PROPOSES it (`forge-proposals.ts`, trigger `landing`): a
 * signed-in person reads it, edits it and publishes it in the "Publish on
 * GitHub" window, or discards it. Nothing reaches GitHub here.
 *
 * One proposal per idea and issue the pull request fixed (`Fixes`, same rule as
 * `issue-closing.ts`), in the project's own repository: an issue the job only
 * mentions (`Refs`) is not resolved yet. The text is a template, never written
 * from the issue's text: "fixed by #51, merged into main", then the idea's
 * public note (`@timon/todo-outcomes`) when it has one, its mentions defused so
 * publishing it notifies nobody by surprise. The issue's author follows the
 * issue and hears of the comment anyway.
 *
 * Idempotent: the key `todo:<id>:issue:<n>:comment` gives one proposal however
 * many times the merge is concluded, and a discarded one is not made again.
 */
import { db, dbApi, type IntegrationRow } from './db.js';
import { projectRepository } from './external-pr-review.js';
import { proposeForgeWrite, type ForgeProposalDeps } from './forge-proposals.js';
import { jobIssueClosings } from './issue-closing.js';

/** Characters of an idea's public note carried into the comment. */
export const PUBLIC_NOTE_LIMIT = 2_000;

/** The proposal's key for an idea and one of its issues. */
export function resolutionKey(todoId: number, issue: number): string {
  return `todo:${todoId}:issue:${issue}:comment`;
}

/** `@name` → `` `@name` ``: shown, never a notification. */
export function defuseMentions(text: string): string {
  return text.replace(/(^|[^\w`/])@([A-Za-z0-9][A-Za-z0-9-]{0,38}(?:\/[A-Za-z0-9_.-]+)?)/g, '$1`@$2`');
}

/** The public note of an idea, when `@timon/todo-outcomes` stored one. */
function publicNote(todoId: number): string | null {
  try {
    const row = db.prepare(`SELECT public_note FROM todo_outcome WHERE todo_id = ?`).get(todoId) as { public_note: string | null } | undefined;
    const note = row?.public_note?.trim();
    return note ? note : null;
  } catch {
    // The table belongs to an optional module: absent, there is no note.
    return null;
  }
}

/** The comment's text: a template, plus the ideas' public notes. */
export function resolutionComment(input: { prNumber: number | null; target: string; notes: readonly string[] }): string {
  const head = input.prNumber
    ? `This is fixed by #${input.prNumber}, now merged into \`${input.target}\`.`
    : `This is fixed, now merged into \`${input.target}\`.`;
  const notes = input.notes
    .map((n) => defuseMentions(n.length > PUBLIC_NOTE_LIMIT ? `${n.slice(0, PUBLIC_NOTE_LIMIT - 1)}…` : n))
    .filter((n) => n.length > 0);
  return [head, ...notes].join('\n\n');
}

export type ResolutionOutcome = { proposed: number; existing: number };

/**
 * Proposes the resolution comment of every issue the merged job `row` fixed.
 * Never throws for a project that does not open pull requests: it has none.
 */
export function proposeResolutionComments(row: IntegrationRow, deps: ForgeProposalDeps = {}): ResolutionOutcome {
  const out: ResolutionOutcome = { proposed: 0, existing: 0 };
  if (!row.project || row.state !== 'merged') return out;
  const where = projectRepository(row.project);
  if (!where.ok) return out;
  const repo = where.value.repo.toLowerCase();
  for (const issue of jobIssueClosings(row)) {
    if (issue.keyword !== 'Fixes' || issue.repo.toLowerCase() !== repo) continue;
    const todoId = Math.min(...issue.todoIds);
    const notes = [...new Set(issue.todoIds.map(publicNote).filter((n): n is string => n !== null))];
    const made = proposeForgeWrite({
      project: row.project,
      kind: 'comment',
      target: { type: 'issue', number: issue.number },
      body: resolutionComment({ prNumber: row.pr_number, target: row.target, notes }),
      trigger: 'landing',
      key: resolutionKey(todoId, issue.number),
      sourceRef: `integration:${row.id}`,
      createdBy: null,
    }, deps);
    if (!made.ok) {
      console.warn(`[landing] resolution comment of issue #${issue.number} not proposed: ${made.code}`);
      continue;
    }
    if (made.created) out.proposed += 1;
    else out.existing += 1;
  }
  return out;
}

/** Same, from the integration's id: what the merge's conclusion calls. */
export function proposeResolutionCommentsOf(integrationId: string, deps: ForgeProposalDeps = {}): ResolutionOutcome {
  const row = dbApi.getIntegrationById(integrationId);
  return row ? proposeResolutionComments(row, deps) : { proposed: 0, existing: 0 };
}
