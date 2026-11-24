/**
 * What a person may do about a contributor's branch, as the daemon answers it
 * (`orchestrator/src/forge-branch-update.ts`, `forge-conflicts.ts`, routes
 * `plugins-bundled/kanban/forge-branch-routes.ts`): update it, ask its author
 * to resolve its conflict, or resolve the conflict here without a working
 * tree. Every write needs a signed-in person; each one ends as a proposal
 * published from "Publish on GitHub", never directly.
 */
import { apiErrorMessage, parseApiError } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import type { Answer } from './landing-api';
import type { ForgeProposal } from './forge-proposals-api';

/** Why no one here may write a contributor's branch (`branchGestures`). */
export type BranchLock = 'not_allowed' | 'fork_deleted';

/** What the pull request list says may be done about a branch (`branchGestures`). */
export type BranchGestures = {
  update_branch: boolean;
  ask_contributor: boolean;
  resolve_conflict: boolean;
  /** Absent from an older daemon. */
  locked?: BranchLock | null;
};

export type ConflictChoice = 'contributor' | 'target' | 'text';
export type ConflictState = 'open' | 'proposed' | 'published' | 'discarded';

export type ConflictFile = {
  path: string;
  mode: string;
  /** A path a reviewer should read twice (workflows, install scripts…). */
  sensitive: boolean;
  /** Each version as text, null when it cannot be read (gone, too large). */
  base: string | null;
  contributor: string | null;
  target: string | null;
  /** The merged text, with its conflict markers. */
  merged: string | null;
  resolution: { choice: ConflictChoice; text: string | null } | null;
};

export type ConflictView = {
  id: string;
  project: string;
  repo: string;
  number: number;
  url: string;
  head: { repository: string; ref: string; sha: string };
  base: { ref: string; sha: string };
  state: ConflictState;
  proposal_id: string | null;
  commit_sha: string | null;
  files: ConflictFile[];
  created_at: number;
  updated_at: number;
};

export type ResolutionDiff = { text: string; truncated: boolean };

const pulls = (project: string) => `/api/ui/projects/${encodeURIComponent(project)}/pull-requests`;
const conflicts = (project: string) => `/api/ui/projects/${encodeURIComponent(project)}/forge-conflicts`;

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
const conflictOf = (b: unknown) => (b as { conflict?: ConflictView } | null)?.conflict;

/** Prepares "update the branch": GitHub merges the base into it once published. */
export function proposeBranchUpdate(project: string, number: number, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${pulls(project)}/${number}/update-branch`, json('POST', {}), proposalOf, fetchImpl);
}

/** Prepares the comment that asks the contributor to resolve their conflict. */
export function proposeAskContributor(project: string, number: number, fetchImpl: typeof fetch = fetch): Promise<Answer<ForgeProposal>> {
  return call(`${pulls(project)}/${number}/conflict/ask`, json('POST', {}), proposalOf, fetchImpl);
}

/** Merges the pull request here, objects only; the resolution already prepared for its head comes back as is. */
export function prepareConflict(project: string, number: number, fetchImpl: typeof fetch = fetch): Promise<Answer<ConflictView>> {
  return call(`${pulls(project)}/${number}/conflict`, json('POST', {}), conflictOf, fetchImpl);
}

/** A resolution and, once proposed, the diff of what it changes. */
export function getConflict(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<{ conflict: ConflictView; diff: ResolutionDiff | null }>> {
  return call(`${conflicts(project)}/${encodeURIComponent(id)}`, undefined, (b) => {
    const body = b as { conflict?: ConflictView; diff?: ResolutionDiff | null } | null;
    return body?.conflict ? { conflict: body.conflict, diff: body.diff ?? null } : undefined;
  }, fetchImpl);
}

export type FileResolution = { choice: 'contributor' } | { choice: 'target' } | { choice: 'text'; text: string };

export function resolveFile(project: string, id: string, path: string, resolution: FileResolution, fetchImpl: typeof fetch = fetch): Promise<Answer<ConflictView>> {
  return call(`${conflicts(project)}/${encodeURIComponent(id)}/files`, json('PUT', { path, ...resolution }), conflictOf, fetchImpl);
}

/** A suggestion of an agent with no tool: shown, never applied by the daemon. */
export function suggestResolution(project: string, id: string, path: string, fetchImpl: typeof fetch = fetch): Promise<Answer<string>> {
  return call(`${conflicts(project)}/${encodeURIComponent(id)}/suggest`, json('POST', { path }), (b) => {
    const text = (b as { text?: unknown } | null)?.text;
    return typeof text === 'string' ? text : undefined;
  }, fetchImpl);
}

/** Commits the resolution and prepares its publication; nothing is pushed yet. */
export function proposeResolution(
  project: string, id: string, fetchImpl: typeof fetch = fetch,
): Promise<Answer<{ conflict: ConflictView; proposal: ForgeProposal; diff: ResolutionDiff }>> {
  return call(`${conflicts(project)}/${encodeURIComponent(id)}/propose`, json('POST', {}), (b) => {
    const body = b as { conflict?: ConflictView; proposal?: ForgeProposal; diff?: ResolutionDiff } | null;
    return body?.conflict && body.proposal && body.diff ? { conflict: body.conflict, proposal: body.proposal, diff: body.diff } : undefined;
  }, fetchImpl);
}

export function discardConflict(project: string, id: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ConflictState>> {
  return call(`${conflicts(project)}/${encodeURIComponent(id)}/discard`, json('POST', {}), (b) => (b as { state?: ConflictState } | null)?.state, fetchImpl);
}

export type ContributorConflicts = 'ask' | 'resolve';

/** The project's setting, or null when it does not open pull requests on GitHub (no row then). */
export async function readContributorConflicts(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<ContributorConflicts | null>> {
  const out = await call(`/api/ui/projects/${encodeURIComponent(project)}/integration`, undefined, (b) => {
    const i = (b as { integration?: { mode?: unknown; forge?: unknown; contributor_conflicts?: unknown } } | null)?.integration;
    if (!i) return undefined;
    if (i.mode !== 'pr' || (i.forge !== undefined && i.forge !== 'github')) return { value: null };
    return { value: i.contributor_conflicts === 'resolve' ? 'resolve' as const : 'ask' as const };
  }, fetchImpl);
  return out.ok ? { ok: true, value: out.value.value } : out;
}

/** The daemon's generic `person_required` says who, not what: here it is turning resolution on. */
export function contributorConflictsRefusal(code: string | null): string | null {
  return code === 'person_required' ? t('contributorConflicts.personRequired') : null;
}

export async function writeContributorConflicts(project: string, mode: ContributorConflicts, fetchImpl: typeof fetch = fetch): Promise<Answer<ContributorConflicts>> {
  return call(`/api/ui/projects/${encodeURIComponent(project)}/integration`, json('PUT', { contributor_conflicts: mode }), (b) => {
    const v = (b as { integration?: { contributor_conflicts?: unknown } } | null)?.integration?.contributor_conflicts;
    return v === 'resolve' || v === 'ask' ? v : undefined;
  }, fetchImpl, contributorConflictsRefusal);
}
