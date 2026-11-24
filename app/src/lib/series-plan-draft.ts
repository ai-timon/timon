/**
 * What the user had already chosen and typed in a `kanban_plan` form (the
 * series planner), kept for the length of the browser session. The planner is
 * the form an autonomous mission shows: its card can expire and come back as
 * a NEW card, and a page reload rebuilds the component from scratch — either
 * way the mode, the model matrix and a long note were lost (TODO #515). A card
 * that plans the same job with the same workstreams, in the same mission,
 * starts from that draft. Same mechanism as `ask-user-draft.ts`.
 */
import type {
  SeriesPlanFinish, SeriesPlanFormPayload, SeriesPlanGroupRole, SeriesPlanMode, SeriesPlanRole,
} from '@/components/series-plan-form';
import type { ModelPick } from '@/components/model-picker';

/** Selections of a matrix, keyed `${role}:main` / `${role}:fallback`. */
export type SeriesPlanPicks = Record<string, ModelPick>;
export type SeriesPlanDraft = {
  mode: SeriesPlanMode;
  picks: SeriesPlanPicks;
  groupPicks: Record<string, SeriesPlanPicks>;
  groupCustom: Record<string, boolean>;
  note: string;
  /** The branch topic typed in place of the proposed one; absent when untouched. */
  branch?: string;
  /** "Existing" was chosen over a new branch; absent for a new one. */
  branchKind?: 'existing';
  /** The existing branch picked in the list; absent when none. */
  existing?: string;
  /** The destination chosen against the form's default; absent when untouched. */
  finish?: SeriesPlanFinish;
  /** "Resolves its issues entirely" was ticked; absent when not. */
  resolvesIssues?: true;
};
type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** The mode a fresh form opens on. */
export const DEFAULT_SERIES_PLAN_MODE: SeriesPlanMode = 'kanban-full';

// Records rather than arrays: adding a mode or a role to the union without
// listing it here is a type error, not a draft silently dropped.
const MODES: Record<SeriesPlanMode, true> = {
  'sequential-here': true,
  'sequential-new-mission': true,
  'kanban-full': true,
  'kanban-code-self': true,
  'kanban-code-group': true,
};
const ROLES: Record<SeriesPlanRole, true> = { orchestrator: true, mission: true, code: true, review: true, merge: true, doc: true };
const GROUP_ROLES: Record<SeriesPlanGroupRole, true> = { code: true, review: true, merge: true, doc: true };

/** Same mission, same job, same workstreams in the same order: the same draft. */
export function seriesPlanDraftKey(missionId: string, form: SeriesPlanFormPayload): string {
  const volets = form.volets.map((v) => [v.title, v.group ?? '']);
  return `timon.seriesPlanDraft:${missionId}:${JSON.stringify([form.chantier, volets])}`;
}

function groupNames(form: SeriesPlanFormPayload): Set<string> {
  return new Set(form.volets.flatMap((v) => (typeof v.group === 'string' && v.group.trim() !== '' ? [v.group] : [])));
}

/** A draft holds something worth restoring: anything the user changed. */
function hasContent(draft: SeriesPlanDraft): boolean {
  return draft.mode !== DEFAULT_SERIES_PLAN_MODE
    || Object.keys(draft.picks).length > 0
    || Object.values(draft.groupPicks).some((p) => Object.keys(p).length > 0)
    || Object.values(draft.groupCustom).some(Boolean)
    || draft.note.trim() !== ''
    || draft.branch !== undefined
    || draft.branchKind !== undefined
    || draft.existing !== undefined
    || draft.finish !== undefined
    || draft.resolvesIssues === true;
}

/** Keeps the cells that still name a role of `roles` and hold a well-formed pair. */
function cleanPicks(raw: unknown, roles: Record<string, true>): SeriesPlanPicks {
  const out: SeriesPlanPicks = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const [role, column, ...rest] = key.split(':');
    if (rest.length > 0 || role === undefined || !Object.hasOwn(roles, role) || (column !== 'main' && column !== 'fallback')) continue;
    if (!value || typeof value !== 'object') continue;
    const { backend, model } = value as Record<string, unknown>;
    if (typeof backend === 'string' && backend !== '' && typeof model === 'string' && model !== '') {
      out[key] = { backend, model };
    }
  }
  return out;
}

/**
 * The draft of this form, reduced to what still fits it: a group the new card
 * no longer has is dropped, not sent back to the agent. A model is kept as
 * long as it is well formed — the catalog it was picked from lives in the
 * same browser session, and the daemon validates the plan on its way back.
 */
export function loadSeriesPlanDraft(
  storage: DraftStorage | null,
  missionId: string | null,
  form: SeriesPlanFormPayload,
): SeriesPlanDraft | null {
  if (!storage || !missionId) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(storage.getItem(seriesPlanDraftKey(missionId, form)) ?? 'null');
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as Record<string, unknown>;
  const groups = groupNames(form);
  const draft: SeriesPlanDraft = {
    mode: typeof stored.mode === 'string' && Object.hasOwn(MODES, stored.mode) ? stored.mode as SeriesPlanMode : DEFAULT_SERIES_PLAN_MODE,
    picks: cleanPicks(stored.picks, ROLES),
    groupPicks: {},
    groupCustom: {},
    note: typeof stored.note === 'string' ? stored.note : '',
    ...(typeof stored.branch === 'string' ? { branch: stored.branch } : {}),
    ...(stored.branchKind === 'existing' ? { branchKind: 'existing' as const } : {}),
    ...(typeof stored.existing === 'string' && stored.existing !== '' ? { existing: stored.existing } : {}),
    ...(stored.finish === 'merge' || stored.finish === 'keep' ? { finish: stored.finish } : {}),
    ...(stored.resolvesIssues === true ? { resolvesIssues: true as const } : {}),
  };
  if (stored.groupPicks && typeof stored.groupPicks === 'object') {
    for (const [name, picks] of Object.entries(stored.groupPicks as Record<string, unknown>)) {
      if (!groups.has(name)) continue;
      const clean = cleanPicks(picks, GROUP_ROLES);
      if (Object.keys(clean).length > 0) draft.groupPicks[name] = clean;
    }
  }
  if (stored.groupCustom && typeof stored.groupCustom === 'object') {
    for (const [name, custom] of Object.entries(stored.groupCustom as Record<string, unknown>)) {
      if (groups.has(name) && custom === true) draft.groupCustom[name] = true;
    }
  }
  return hasContent(draft) ? draft : null;
}

export function saveSeriesPlanDraft(
  storage: DraftStorage | null,
  missionId: string | null,
  form: SeriesPlanFormPayload,
  draft: SeriesPlanDraft,
): void {
  if (!storage || !missionId) return;
  const key = seriesPlanDraftKey(missionId, form);
  try {
    if (hasContent(draft)) storage.setItem(key, JSON.stringify(draft));
    else storage.removeItem(key);
  } catch {
    // A full or blocked storage costs the draft, never the form.
  }
}

export function clearSeriesPlanDraft(storage: DraftStorage | null, missionId: string | null, form: SeriesPlanFormPayload): void {
  if (!storage || !missionId) return;
  try { storage.removeItem(seriesPlanDraftKey(missionId, form)); } catch { /* same as above */ }
}
