/**
 * The publications proposed on a project's forge, as the daemon answers them
 * (`orchestrator/src/forge-proposals.ts`, routes
 * `/api/projects/:slug/forge-proposals`): the types, the calls, and which
 * proposal waits on which row.
 *
 * A write needs a signed-in person: the daemon refuses it from anyone else
 * (`person_required`), so nothing here ever publishes on its own.
 */
import { apiErrorMessage, parseApiError } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import type { Answer } from './landing-api';
import type { Landing } from './landing-api';

export type ForgeProposalState = 'draft' | 'publishing' | 'published' | 'failed' | 'discarded';
export type ForgeProposalTrigger = 'person' | 'landing' | 'todo_resolved' | 'plugin';
export type ForgeTargetType = 'issue' | 'pull';
/** A comment; GitHub merging the base into a pull request's branch; our
 *  resolution of a contributor's conflict pushed to their branch, then a comment. */
export type ForgeProposalKind = 'comment' | 'update_branch' | 'conflict_push';

export type ForgeProposal = {
  id: string;
  project: string;
  repo: string;
  kind: ForgeProposalKind;
  target: { type: ForgeTargetType; number: number; url: string };
  /** The comment; for `update_branch`, the daemon's own summary, never edited. */
  body: string;
  state: ForgeProposalState;
  trigger: ForgeProposalTrigger;
  /** The plugin that proposed it (`trigger: 'plugin'`, daemon API 19); absent from an older daemon. */
  plugin?: string | null;
  key: string;
  source_ref: string | null;
  /** What a branch update or a conflict push runs with, written by the
   *  daemon (`BranchUpdateDetails`, `ConflictPushDetails`); absent from an older daemon. */
  details?: Record<string, unknown> | null;
  /** Whether the text may change before publishing; absent from an older daemon (a comment). */
  editable?: boolean;
  /** The account it was published as, once published. */
  account: string | null;
  /** The comment on the forge, once published. */
  url: string | null;
  error: { code: string; reason: string | null } | null;
  created_at: number;
  updated_at: number;
  published_at: number | null;
};

/** Mirror of the daemon's `FORGE_PROPOSAL_BODY_LIMIT` (`ISSUE_COMMENT_LIMIT`). */
export const PROPOSAL_BODY_LIMIT = 8000;

/** What the daemon refuses in a text, checked before it is sent; null when it is fine. */
export function bodyProblem(body: string): 'empty' | 'tooLong' | 'control' | 'marker' | null {
  if (body.trim().length === 0) return 'empty';
  if (body.length > PROPOSAL_BODY_LIMIT) return 'tooLong';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body)) return 'control';
  if (body.includes('<!-- timon-proposal:')) return 'marker';
  return null;
}

/** Whether a person may change the proposal's text. */
export function isEditable(p: ForgeProposal): boolean {
  return p.editable ?? p.kind === 'comment';
}

export type BranchUpdateDetails = { expected_head_sha: string; base_ref: string; head_ref: string; head_repository: string | null };
export type ConflictPushDetails = {
  commit_sha: string; expected_head_sha: string; head_repository: string; head_ref: string; base_ref: string; files: string[];
  /** Where the commit is pushed, pinned when it was proposed; null from an older daemon. */
  push_host: string | null; push_repository: string | null; push_url: string | null;
};

const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/** The details of a branch update, or null when the daemon wrote none. */
export function branchUpdateDetails(p: ForgeProposal): BranchUpdateDetails | null {
  const d = p.kind === 'update_branch' ? p.details : null;
  if (!d || !text(d.expected_head_sha) || !text(d.base_ref) || !text(d.head_ref)) return null;
  return {
    expected_head_sha: d.expected_head_sha, base_ref: d.base_ref, head_ref: d.head_ref,
    head_repository: text(d.head_repository) ? d.head_repository : null,
  };
}

/** The details of a conflict push, or null when the daemon wrote none. */
export function conflictPushDetails(p: ForgeProposal): ConflictPushDetails | null {
  const d = p.kind === 'conflict_push' ? p.details : null;
  if (!d || !text(d.commit_sha) || !text(d.expected_head_sha) || !text(d.head_repository) || !text(d.head_ref) || !text(d.base_ref)) return null;
  const files = Array.isArray(d.files) ? d.files.filter(text) : [];
  return {
    commit_sha: d.commit_sha, expected_head_sha: d.expected_head_sha, head_repository: d.head_repository,
    head_ref: d.head_ref, base_ref: d.base_ref, files,
    push_host: text(d.push_host) ? d.push_host : null,
    push_repository: text(d.push_repository) ? d.push_repository : null,
    push_url: text(d.push_url) ? d.push_url : null,
  };
}

/** Waiting for a person: a draft, or a failed attempt to try again. */
export function isPending(p: ForgeProposal): boolean {
  return p.state === 'draft' || p.state === 'failed';
}

const base = (project: string) => `/api/ui/projects/${encodeURIComponent(project)}/forge-proposals`;

/** A refusal worded for the gesture that met it, or null to keep the dictionary's. */
type Wording = (code: string | null) => string | null;

async function call<T>(
  url: string, init: RequestInit | undefined, pick: (body: unknown) => T | undefined, fetchImpl: typeof fetch, wording?: Wording,
): Promise<Answer<T>> {
  try {
    const res = await fetchImpl(url, init ?? { cache: 'no-store' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: wording?.(parseApiError(body)?.code ?? null) ?? apiErrorMessage(body, { status: res.status }) };
    const value = pick(body);
    return value === undefined || value === null ? { ok: false, message: apiErrorMessage(null) } : { ok: true, value };
  } catch {
    return { ok: false, message: apiErrorMessage(null) };
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
const proposalOf = (b: unknown) => (b as { proposal?: ForgeProposal } | null)?.proposal;

export function listProposals(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal[]>> {
  return call(base(project), undefined, (b) => (b as { proposals?: ForgeProposal[] } | null)?.proposals ?? [], fetchImpl);
}

export function getProposal(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}`, undefined, proposalOf, fetchImpl);
}

/** A person proposes a comment; a second one on the same target opens the draft already waiting. */
export function createProposal(
  project: string, target: { type: ForgeTargetType; number: number }, body: string, fetchImpl: typeof fetch = fetch,
): Promise<Answer<ForgeProposal>> {
  return call(base(project), json('POST', { kind: 'comment', target, body }), proposalOf, fetchImpl);
}

export function editProposal(project: string, id: string, body: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}`, json('PATCH', { body }), proposalOf, fetchImpl);
}

/**
 * Why a publication was refused, in the person's words. The daemon's
 * `forge_conflict_changed` names an internal check (the branch, the target or
 * the push URL moved); what the person needs is that nothing left and what to do.
 */
export function publishRefusal(code: string | null): string | null {
  return code === 'forge_conflict_changed' ? t('forgePublish.conflictChanged') : null;
}

/** Publishes `body`, the text the person read. */
export function publishProposal(project: string, id: string, body: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}/publish`, json('POST', { body }), proposalOf, fetchImpl, publishRefusal);
}

export function discardProposal(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${base(project)}/${encodeURIComponent(id)}/discard`, json('POST', {}), proposalOf, fetchImpl);
}

/** The GitHub account the project publishes as, or null when none is set. */
export async function projectAccount(project: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const out = await call(
    `/api/ui/projects/${encodeURIComponent(project)}/integration`, undefined,
    (b) => ({ account: (b as { integration?: { account?: string | null } } | null)?.integration?.account ?? null }), fetchImpl,
  );
  return out.ok ? out.value.account : null;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const PR_REPO = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/\d+$/;

/** The proposals waiting on a job's row: on its pull request, or on an issue it is linked to. */
export function proposalsForLanding(proposals: readonly ForgeProposal[], landing: Landing): ForgeProposal[] {
  const repo = landing.pr_url ? PR_REPO.exec(landing.pr_url)?.[1] ?? null : null;
  const issues = landing.links?.issues ?? [];
  return proposals.filter((p) => isPending(p) && p.project === landing.project && (
    p.target.type === 'pull'
      ? landing.pr_number === p.target.number && repo !== null && same(repo, p.repo)
      : issues.some((i) => i.number === p.target.number && same(i.repo, p.repo))
  ));
}

/** The proposals waiting on a pull request's row: on it, or on an issue it is linked to. */
export function proposalsForPull(
  proposals: readonly ForgeProposal[], repo: string, pull: { number: number; links?: { issues: ReadonlyArray<{ repo: string; number: number }> } },
): ForgeProposal[] {
  const issues = pull.links?.issues ?? [];
  return proposals.filter((p) => isPending(p) && same(p.repo, repo) && (
    p.target.type === 'pull'
      ? p.target.number === pull.number
      : issues.some((i) => i.number === p.target.number && same(i.repo, p.repo))
  ));
}

/** How many distinct proposals wait across rows: one on a pull request and on its issue counts once. */
export function waitingCount(rows: ReadonlyArray<readonly ForgeProposal[]>): number {
  return new Set(rows.flatMap((row) => row.map((p) => p.id))).size;
}
