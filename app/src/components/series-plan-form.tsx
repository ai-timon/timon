'use client';

/**
 * Series planner: the form that replaces the four stacked multiple-choice
 * questions an orchestrator used to ask before launching a big piece of work.
 * The agent opens it with the MCP tool `kanban_plan` (formerly
 * `ask_series_plan`).
 *
 * WHY A DEDICATED COMPONENT. The generic rendering of a question (tool
 * `question`, formerly `ask_user`) can show option questions, not a matrix
 * "one role per row, two menus per role". The result spread over three
 * screens of radio buttons, and above all the agent had to LIST the fallback
 * models itself: it made them up from memory, so it offered some that no
 * longer exist.
 *
 * Here the agent only sends the work and its parts (`form.kind ===
 * 'series_plan'`, see `orchestrator/src/series-plan.ts`). The menus come from
 * the runtime catalogue: a model added to a profile shows up without a
 * rebuild, and nothing stale can be offered.
 *
 * The UI COLLECTS, it does not execute: the answer goes back to the agent,
 * which applies the plan through `timon series fallback set` /
 * `timon task create`. The orchestrator attaches the exact commands so it has
 * nothing to rebuild.
 */

import { useEffect, useId, useMemo, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, CircleCheck, GitBranch, GitMerge, Lock, ShieldCheck, Sparkles, Zap } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ModelPickerPopover, type ModelPick } from '@/components/model-picker';
import { BrandMark } from '@/components/brand-mark';
import { PlanPresetBar, PresetSaveButton, type PresetColumn } from '@/components/series-plan-presets';
import { cn } from '@/lib/utils';
import {
  backendLabel, backendLimits, modelLabel, useBackendCatalog, vendorLabel,
  type BackendCatalog,
} from '@/lib/backends';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';
import { sessionDraftStorage } from '@/lib/ask-user-draft';
import {
  clearSeriesPlanDraft, DEFAULT_SERIES_PLAN_MODE, loadSeriesPlanDraft, saveSeriesPlanDraft,
} from '@/lib/series-plan-draft';

/* ── Contract shared with the orchestrator ───────────────────────────────────
 * Mirror of `orchestrator/src/series-plan.ts`. The two packages are separate
 * (no import possible); the duplication is deliberate and must stay aligned:
 * the server validator refuses anything that deviates.
 * ─────────────────────────────────────────────────────────────────────────── */

export type SeriesPlanMode =
  | 'sequential-here'
  | 'sequential-new-mission'
  | 'kanban-full'
  | 'kanban-code-self'
  | 'kanban-code-group';

export type SeriesPlanRole = 'orchestrator' | 'mission' | 'code' | 'review' | 'merge' | 'doc';

/** `group`: a short name the agent offers when the parts differ in
 *  difficulty. The form then offers model settings PER GROUP, the general
 *  settings remaining the default. Without a group, nothing changes. */
export type SeriesPlanVolet = { title: string; description?: string; group?: string };

/** The roles a GROUP can set: those that are task types. `orchestrator` and
 *  `mission` pilot the whole series, they stay global. */
export type SeriesPlanGroupRole = 'code' | 'review' | 'merge' | 'doc';
const GROUP_ROLES: readonly SeriesPlanGroupRole[] = ['code', 'review', 'merge', 'doc'];
function isGroupRole(role: SeriesPlanRole): role is SeriesPlanGroupRole {
  return (GROUP_ROLES as readonly string[]).includes(role);
}

/** What applies TODAY, resolved by the orchestrator when the form opens (see
 *  `series-plan-defaults.ts`). Purely informative: do not send it back in the
 *  answer, or "change nothing" would rewrite the config. */
export type SeriesPlanDefaults = Partial<
  Record<SeriesPlanRole, { model?: string; fallback?: string }>
>;

/** The job's branch, attached by the orchestrator for the project the job is
 *  for (`plan-landing.ts`). Absent when the job has no project. Every project
 *  gets the field: a new branch or one the repository has, merged into its
 *  target at the end (through the pull request in a `pr` project) or kept. */
export type SeriesPlanLanding = {
  /** The project whose check route judges a typed name. */
  project: string;
  /** `pr`: the project lands through pull requests; `local`: it merges locally. */
  mode?: 'pr' | 'local';
  /** `feat/`: shown before the field, never typed. */
  prefix: string;
  /** The name the job would get today, already numbered (`-2`). */
  branch: string;
  base_ref: string;
  /** The series already started from this branch: it no longer changes. */
  locked: boolean;
  /** Why the agent's proposal cannot be used. */
  refusal?: string;
  /** `new` unless the locked job started from a branch it did not cut. */
  kind?: SeriesPlanBranch['kind'];
  /** Where the branch ends up: merged into `target`, or kept. */
  finish?: SeriesPlanFinish;
  target?: string;
  /** The repository's branches a job may start from, newest first. */
  branches?: Array<{ name: string; committed_at: number }>;
};

export type SeriesPlanFormPayload = {
  kind: 'series_plan';
  chantier: string;
  volets: SeriesPlanVolet[];
  /** The branch the agent proposed, as it sent it. */
  branch?: string;
  defaults?: SeriesPlanDefaults;
  landing?: SeriesPlanLanding;
};

export type SeriesPlanRoleConfig = {
  backend?: string;
  model?: string;
  fallbackBackend?: string;
  fallbackModel?: string;
};

export type SeriesPlanGroupConfig = Partial<Record<SeriesPlanGroupRole, SeriesPlanRoleConfig>>;

export type SeriesPlanAnswer = {
  mode: SeriesPlanMode;
  roles: Partial<Record<SeriesPlanRole, SeriesPlanRoleConfig>>;
  /** Settings per group of parts, keys = group names of the received form.
   *  Absent when no group has a setting: touching nothing stays a no-op. */
  groups?: Record<string, SeriesPlanGroupConfig>;
  note?: string;
  /** The job's branch, only with a `landing`: a new one (full name, prefix
   *  included) or one the repository has. The daemon checks it again. */
  branch?: SeriesPlanBranch;
  /** Where the branch ends up; sent with `branch`. */
  finish?: SeriesPlanFinish;
  /** The job resolves its ideas' issues entirely: its pull request closes
   *  them (`Fixes`) even when other jobs carry the same idea. Sent when ticked. */
  resolves_issues?: boolean;
};

/** The branch a planned job works on (`SeriesPlanAnswer.branch`). */
export type SeriesPlanBranch = { kind: 'new' | 'existing'; name: string };
/** `merge`: into the target (through the pull request in a `pr` project);
 *  `keep`: the work stays on the branch until it lands from the Jobs widget. */
export type SeriesPlanFinish = 'merge' | 'keep';

/** Distinct group names, in the order the parts first show them. */
export function planGroupNames(volets: ReadonlyArray<{ group?: string | null }>): string[] {
  const names: string[] = [];
  for (const v of volets) {
    if (typeof v.group === 'string' && v.group.trim() !== '' && !names.includes(v.group)) names.push(v.group);
  }
  return names;
}

/** A tile of the mode grid.
 *
 * TWO lines, not one. A single word ("In line", "Grouped") says nothing to
 * someone without the pipeline in mind: they have to click to understand what
 * they pick, so explore all five tiles before they can decide. `head` gives
 * the family, `sub` what sets it apart from its neighbour: the comparison
 * then happens by reading, without a click. `detail` stays for the
 * explanation line. */
type ModeTile = {
  mode: SeriesPlanMode;
  Icon: LucideIcon;
  headKey: string;
  subKey: string;
  titleKey: string;
  detailKey: string;
};

const MODE_TILES: ModeTile[] = [
  {
    mode: 'sequential-here',
    Icon: Zap,
    headKey: 'taskForm.seriesPlan.modes.sequential.head',
    subKey: 'taskForm.seriesPlan.modes.sequentialHere.sub',
    titleKey: 'taskForm.seriesPlan.modes.sequentialHere.title',
    detailKey: 'taskForm.seriesPlan.modes.sequentialHere.detail',
  },
  {
    mode: 'sequential-new-mission',
    Icon: Sparkles,
    headKey: 'taskForm.seriesPlan.modes.sequential.head',
    subKey: 'taskForm.seriesPlan.modes.sequentialNewMission.sub',
    titleKey: 'taskForm.seriesPlan.modes.sequentialNewMission.title',
    detailKey: 'taskForm.seriesPlan.modes.sequentialNewMission.detail',
  },
  {
    mode: 'kanban-full',
    Icon: ShieldCheck,
    headKey: 'taskForm.seriesPlan.modes.full.head',
    subKey: 'taskForm.seriesPlan.modes.full.sub',
    titleKey: 'taskForm.seriesPlan.modes.full.title',
    detailKey: 'taskForm.seriesPlan.modes.full.detail',
  },
  {
    mode: 'kanban-code-self',
    Icon: GitBranch,
    headKey: 'taskForm.seriesPlan.modes.codeSelf.head',
    subKey: 'taskForm.seriesPlan.modes.codeSelf.sub',
    titleKey: 'taskForm.seriesPlan.modes.codeSelf.title',
    detailKey: 'taskForm.seriesPlan.modes.codeSelf.detail',
  },
  {
    mode: 'kanban-code-group',
    Icon: GitMerge,
    headKey: 'taskForm.seriesPlan.modes.codeGroup.head',
    subKey: 'taskForm.seriesPlan.modes.codeGroup.sub',
    titleKey: 'taskForm.seriesPlan.modes.codeGroup.title',
    detailKey: 'taskForm.seriesPlan.modes.codeGroup.detail',
  },
];

const ROLES_BY_MODE: Record<SeriesPlanMode, SeriesPlanRole[]> = {
  'sequential-here': ['orchestrator'],
  'sequential-new-mission': ['orchestrator', 'mission'],
  'kanban-full': ['orchestrator', 'code', 'review', 'merge', 'doc'],
  'kanban-code-self': ['orchestrator', 'code', 'doc'],
  'kanban-code-group': ['orchestrator', 'code', 'merge', 'doc'],
};

const ROLE_LABEL: Record<SeriesPlanRole, string> = {
  orchestrator: 'taskForm.seriesPlan.roles.orchestrator',
  mission: 'taskForm.seriesPlan.roles.mission',
  code: 'taskForm.seriesPlan.roles.code',
  review: 'taskForm.seriesPlan.roles.review',
  merge: 'taskForm.seriesPlan.roles.merge',
  doc: 'taskForm.seriesPlan.roles.doc',
};

/** The roles whose MAIN MODEL can be changed here. The orchestrator is left
 *  out: it is the mission already running, changing its model midway makes no
 *  sense; only its fallback can be set. */
const MAIN_EDITABLE: Record<SeriesPlanRole, boolean> = {
  orchestrator: false,
  mission: true,
  code: true,
  review: true,
  merge: true,
  doc: true,
};

/** Flat, borderless (the maintainer's request): the hierarchy goes through the surface
 *  veil and the focus ring, like `chat/ask-user-form.tsx`. */
const VEIL = 'bg-foreground/[0.04] dark:bg-foreground/[0.07]';
const VEIL_HOVER = 'hover:bg-foreground/[0.07] dark:hover:bg-foreground/[0.12]';
const FOCUS_RING = 'outline-none focus-visible:ring-2 focus-visible:ring-primary/50';
/** Active selection: solid in light mode (a 12% veil on light grey does not
 *  show), tinted in dark mode where it already showed. */
const ACTIVE = 'bg-primary text-primary-foreground dark:bg-primary/20 dark:text-foreground';
/** The surface of a menu placed INSIDE an already greyed panel: the page
 *  background, so the value stays readable instead of melting into the
 *  panel's grey. */
const INSET = 'bg-background dark:bg-foreground/[0.10]';

/** A chosen pair. Absent from the selections table = inherit: one choice per
 *  column (rather than separate backend + model), the pair being inseparable
 *  in the dispatcher anyway. */
type Pair = ModelPick;
/** A matrix's selections, keyed `${role}:main` / `${role}:fallback`. */
type Picks = Record<string, Pair>;

/** `backend / model`, the format of the resolved defaults
 *  (`series-plan-defaults.ts`): a group's inherit entry names the chosen
 *  general setting this way. */
function pairLabel(pair: Pair | undefined): string | undefined {
  return pair ? `${pair.backend} / ${pair.model}` : undefined;
}

/** The pair of a `backend / model` label (defaults resolved by the daemon). */
function parsePair(label: string | undefined): Pair | undefined {
  if (!label) return undefined;
  const [backend, ...rest] = label.split(' / ');
  const model = rest.join(' / ').trim();
  return backend && model ? { backend: backend.trim(), model } : undefined;
}

/** `Label · Remote` for a backend outside Timon's folder, `· Limited` for
 *  any other declared gap, the bare label otherwise. */
function limitsLabel(catalog: BackendCatalog, id: string, label: string): string {
  const limits = backendLimits(catalog, id);
  if (limits.length === 0) return label;
  return `${label} · ${t(limits.includes('worktree') ? 'llm.remote' : 'llm.limited')}`;
}

/** A model's logo, never its provider's name: "Claude / Codex" spelled out
 *  overflowed a narrow menu, especially on mobile. */
function ModelMark({ catalog, pair, className }: { catalog: BackendCatalog; pair: Pair; className?: string }) {
  const backend = catalog.backends.find((b) => b.id === pair.backend);
  const model = backend?.models.find((m) => m.slug === pair.model);
  return (
    <BrandMark
      brand={model?.brand}
      slug={pair.model}
      fallbackBrand={backend?.brand}
      fallbackIcon={backend?.icon}
      className={cn('size-3.5', className)}
    />
  );
}

/** A pair's text: the model alone. The provider reads from the logo, and in
 *  full in the tooltip, account included, since two accounts can serve the
 *  same model. */
function pairText(catalog: BackendCatalog, pair: Pair): string {
  return modelLabel(catalog, pair.backend, pair.model);
}
function pairTitle(catalog: BackendCatalog, pair: Pair): string {
  const backend = catalog.backends.find((b) => b.id === pair.backend);
  const provider = backend ? vendorLabel(backend) : backendLabel(catalog, pair.backend);
  return limitsLabel(catalog, pair.backend, `${provider} / ${pairText(catalog, pair)}`);
}

/** A pair shown read-only: logo + model, and the sub-account as a badge when
 *  it is one, so two accounts serving the same model read apart without
 *  opening the tooltip (same badge as the ModelPicker's favourites). */
function PairView({ catalog, pair, muted }: { catalog: BackendCatalog; pair: Pair; muted?: boolean }) {
  const account = catalog.backends.find((b) => b.id === pair.backend)?.account?.name;
  return (
    <span className={cn('flex min-w-0 items-center gap-1.5', muted && 'text-muted-foreground')} title={pairTitle(catalog, pair)}>
      <ModelMark catalog={catalog} pair={pair} />
      <span className="truncate">{pairText(catalog, pair)}</span>
      {account && (
        <span className="max-w-[50%] flex-none truncate rounded bg-muted px-1 py-px text-[9px] font-medium leading-tight text-muted-foreground">
          {account}
        </span>
      )}
    </span>
  );
}

/** A cell's picker: the shared `ModelPickerPopover`, behind a trigger sized
 *  for the matrix. The picker's "inherit" entry returns `null`, i.e. no
 *  setting; that is also what expresses "no fallback" when nothing is
 *  inherited. */
function ModelSelect({
  catalog,
  value,
  onChange,
  inheritLabel,
  inheritPair,
  surface,
  disabled,
  title,
}: {
  catalog: BackendCatalog;
  value: Pair | undefined;
  onChange: (v: Pair | undefined) => void;
  inheritLabel: string;
  /** The pair that will apply if nothing is chosen, when known. */
  inheritPair?: Pair;
  surface?: 'card' | 'inset';
  disabled?: boolean;
  title: string;
}) {
  return (
    <ModelPickerPopover
      value={value ?? null}
      onChange={(pick) => onChange(pick ?? undefined)}
      inherit={{ label: inheritLabel }}
      disabled={disabled}
      label={title}
      renderTrigger={(trigger) => (
        <button
          type="button"
          {...trigger}
          title={title}
          className={cn(
            'flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-2 text-left text-[11.5px] transition-colors disabled:cursor-default disabled:opacity-60',
            surface === 'inset' ? INSET : VEIL,
            FOCUS_RING,
          )}
        >
          <span className="flex min-w-0 flex-1">
            {value ? (
              <PairView catalog={catalog} pair={value} />
            ) : inheritPair ? (
              <PairView catalog={catalog} pair={inheritPair} muted />
            ) : (
              <span className="truncate text-muted-foreground">{inheritLabel}</span>
            )}
          </span>
          <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      )}
    />
  );
}

/** A "role: model ▾ | fallback ▾" row. Shared by the general settings and a
 *  group's: only the inherit labels differ. */
function RoleRow({
  role,
  catalog,
  main,
  fallback,
  onMain,
  onFallback,
  inheritMain,
  inheritFallback,
  inheritMainPair,
  inheritFallbackPair,
  runningModel,
  surface,
  readOnly,
  disabled,
}: {
  role: SeriesPlanRole;
  catalog: BackendCatalog;
  main: Pair | undefined;
  fallback: Pair | undefined;
  onMain: (v: Pair | undefined) => void;
  onFallback: (v: Pair | undefined) => void;
  inheritMain: string;
  inheritFallback: string;
  inheritMainPair?: Pair;
  inheritFallbackPair?: Pair;
  /** The model shown instead of the menu when the role cannot be changed. */
  runningModel?: string;
  surface?: 'card' | 'inset';
  /** Read values, not menus: a group that follows the general settings. */
  readOnly?: boolean;
  disabled: boolean;
}) {
  const running = parsePair(runningModel);
  const staticCell = (pair: Pair | undefined, fallbackText: string, title: string) => (
    <span className={cn('flex h-8 min-w-0 flex-1 items-center rounded px-2 text-[11.5px]', surface === 'inset' ? INSET : VEIL)} title={title}>
      {pair ? <PairView catalog={catalog} pair={pair} muted /> : <span className="truncate text-muted-foreground">{fallbackText}</span>}
    </span>
  );
  return (
    <div className="flex items-center gap-2">
      <span className="w-[76px] shrink-0 text-[12px] font-medium sm:w-[92px]">{t(ROLE_LABEL[role])}</span>
      {readOnly ? (
        staticCell(main ?? inheritMainPair, inheritMain, t('taskForm.seriesPlan.mainModel'))
      ) : MAIN_EDITABLE[role] ? (
        <ModelSelect
          catalog={catalog}
          value={main}
          onChange={onMain}
          inheritLabel={inheritMain}
          inheritPair={inheritMainPair}
          surface={surface}
          disabled={disabled}
          title={t('taskForm.seriesPlan.mainModel')}
        />
      ) : (
        <span
          className={cn('flex h-8 min-w-0 flex-1 items-center truncate rounded px-2 text-[11.5px] text-muted-foreground', VEIL)}
          title={t('taskForm.seriesPlan.runningModel')}
        >
          {/* The daemon hands `backend / model`: drawn like any pair, never the raw account id. */}
          {running
            ? <PairView catalog={catalog} pair={running} muted />
            : runningModel ?? t('taskForm.seriesPlan.runningMission')}
        </span>
      )}
      {readOnly ? (
        staticCell(fallback ?? inheritFallbackPair, inheritFallback, t('taskForm.seriesPlan.fallbackTitle'))
      ) : (
        <ModelSelect
          catalog={catalog}
          value={fallback}
          onChange={onFallback}
          inheritLabel={inheritFallback}
          inheritPair={inheritFallbackPair}
          surface={surface}
          disabled={disabled}
          title={t('taskForm.seriesPlan.fallbackTitle')}
        />
      )}
    </div>
  );
}

/** What each cell SHOWS: the pick, else the pair it inherits. A preset saves
 *  that, not the picks alone — a column showing the defaults is not empty. */
function shownPicks(
  roles: readonly SeriesPlanRole[],
  picks: Picks,
  inherited: (role: SeriesPlanRole, column: PresetColumn) => Pair | undefined,
): Picks {
  const shown: Picks = {};
  for (const role of roles) {
    for (const column of ['main', 'fallback'] as const) {
      const key = `${role}:${column}`;
      const pair = picks[key] ?? inherited(role, column);
      if (pair) shown[key] = pair;
    }
  }
  return shown;
}

/** The matrix's column titles; `save` paints the floppy that stores a column as a preset, beside its title. */
function RowsHeader({ save }: { save?: (column: PresetColumn) => ReactNode }) {
  return (
    <div className="flex items-center gap-2 px-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
      <span className="w-[76px] shrink-0 sm:w-[92px]">{t('taskForm.seriesPlan.role')}</span>
      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">{t('taskForm.seriesPlan.model')}{save?.('main')}</span>
      <span className="flex min-w-0 flex-1 items-center justify-between gap-1">{t('taskForm.seriesPlan.fallback')}{save?.('fallback')}</span>
    </div>
  );
}

function VoletList({ volets, numbers }: { volets: ReadonlyArray<{ volet: SeriesPlanVolet; index: number }>; numbers?: boolean }) {
  return (
    <ol className="flex flex-col gap-2">
      {volets.map(({ volet: v, index: i }) => (
        <li key={`${i}-${v.title}`} className="text-[12px] leading-relaxed">
          {numbers !== false && (
            <>
              <span className="text-[10.5px] tabular-nums text-muted-foreground">{i + 1}.</span>{' '}
            </>
          )}
          <span className="font-medium">{v.title}</span>
          {v.description && <span className="text-muted-foreground"> — {v.description}</span>}
        </li>
      ))}
    </ol>
  );
}

/** Two buttons, not a switch: "follow the general settings" and "set this
 *  group" are two states we want to READ, named. */
function GroupModeToggle({
  custom,
  disabled,
  onOverride,
  onSync,
}: {
  custom: boolean;
  disabled: boolean;
  onOverride: () => void;
  onSync: () => void;
}) {
  const cell = (active: boolean) =>
    cn(
      'flex-1 rounded px-2.5 py-1.5 text-[11.5px] font-medium transition-colors',
      FOCUS_RING,
      active ? ACTIVE : cn('text-foreground/70', VEIL, VEIL_HOVER),
      disabled && 'cursor-default opacity-60',
    );
  return (
    <div className="flex gap-1.5" role="group" aria-label={t('taskForm.seriesPlan.groups.modeLabel')}>
      <button type="button" aria-pressed={!custom} disabled={disabled} onClick={onSync} className={cell(!custom)} data-group-mode="sync">
        {t('taskForm.seriesPlan.groups.sync')}
      </button>
      <button type="button" aria-pressed={custom} disabled={disabled} onClick={onOverride} className={cell(custom)} data-group-mode="override">
        {t('taskForm.seriesPlan.groups.override')}
      </button>
    </div>
  );
}

/** A group of parts: a collapsible whose header says whether it FOLLOWS the
 *  general settings or has its own, and which holds its parts then one row per
 *  role that can be set in this mode.
 *
 *  Two states, readable without opening: "General settings" (the group
 *  follows what is chosen below, and will follow it if it changes) or "Own
 *  models" (at least one setting made, or the group was opened for settings).
 *  Going back to "General settings" clears the group's settings.
 *
 *  Collapsed by default; one group is open at a time. */
function GroupSection({
  name,
  volets,
  roles,
  catalog,
  picks,
  generalPicks,
  defaults,
  open,
  custom,
  onToggle,
  onPick,
  onOverride,
  onSync,
  onApplyPreset,
  disabled,
}: {
  name: string;
  volets: ReadonlyArray<{ volet: SeriesPlanVolet; index: number }>;
  roles: readonly SeriesPlanGroupRole[];
  catalog: BackendCatalog;
  picks: Picks;
  generalPicks: Picks;
  defaults: SeriesPlanDefaults | undefined;
  open: boolean;
  /** The group has its own models (a setting made, or opened for settings). */
  custom: boolean;
  onToggle: () => void;
  onPick: (key: string, value: Pair | undefined) => void;
  onOverride: () => void;
  onSync: () => void;
  /** A preset applied to one of the group's columns: the group switches to its own models. */
  onApplyPreset: (column: PresetColumn, pairs: Partial<Record<SeriesPlanRole, Pair>>) => void;
  disabled: boolean;
}) {
  const panelId = useId();
  // The header summary only names what will apply: a setting on a role absent
  // from the chosen mode is ignored on send, it does not count.
  const summary = roles.flatMap((role) => {
    const main = picks[`${role}:main`];
    const fb = picks[`${role}:fallback`];
    if (!main && !fb) return [];
    const parts = [main ? pairText(catalog, main) : undefined, fb ? t('taskForm.seriesPlan.groups.fallbackSummary', { value: pairText(catalog, fb) }) : undefined].filter(Boolean);
    return [`${t(ROLE_LABEL[role])} · ${parts.join(', ')}`];
  });
  const status = custom ? t('taskForm.seriesPlan.groups.statusCustom') : t('taskForm.seriesPlan.groups.statusSync');
  return (
    // Open: the background fades and a thin primary outline takes over (the maintainer's
    // request, a deliberate exception to "borderless", limited to the open
    // group). `ring-inset`: the outline stays inside the box, nothing clips it.
    <section
      className={cn('rounded-md transition-shadow', open ? 'ring-1 ring-inset ring-primary' : VEIL)}
      data-group-state={custom ? 'custom' : 'sync'}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-group-header
        onClick={onToggle}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-md px-3 py-2.5 text-left transition-colors',
          VEIL_HOVER,
          FOCUS_RING,
        )}
      >
        <ChevronRight
          aria-hidden
          className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')}
        />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate text-[12.5px] font-medium">{name}</span>
            <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
              {t('taskForm.seriesPlan.groups.count', { count: volets.length })}
            </span>
          </span>
          <span
            data-testid="group-summary"
            className={cn('mt-0.5 block truncate text-[10.5px]', summary.length > 0 ? 'text-foreground/75' : 'text-muted-foreground')}
          >
            {summary.length > 0 ? summary.join(' — ') : custom ? t('taskForm.seriesPlan.groups.customEmpty') : t('taskForm.seriesPlan.groups.inherits')}
          </span>
        </span>
        <span
          data-testid="group-status"
          className={cn(
            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
            custom ? 'bg-primary/15 text-primary dark:bg-primary/25' : 'bg-foreground/[0.06] text-muted-foreground dark:bg-foreground/10',
          )}
        >
          {status}
        </span>
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-4 px-3 pb-3.5 pt-1">
          <div className={cn('rounded-md px-3 py-2.5', VEIL)} data-testid="group-volets">
            <VoletList volets={volets} />
          </div>
          {roles.length > 0 ? (
            <>
              <GroupModeToggle custom={custom} disabled={disabled} onOverride={onOverride} onSync={onSync} />
              <div className="flex flex-col gap-2.5">
                <PlanPresetBar
                  catalog={catalog}
                  roles={{ main: roles, fallback: roles }}
                  onApply={onApplyPreset}
                  disabled={disabled}
                />
                <RowsHeader
                  save={(column) => (
                    <PresetSaveButton
                      catalog={catalog}
                      column={column}
                      roles={roles}
                      picks={shownPicks(roles, picks, (role, col) =>
                        generalPicks[`${role}:${col}`] ?? parsePair(col === 'main' ? defaults?.[role]?.model : defaults?.[role]?.fallback))}
                      disabled={disabled}
                    />
                  )}
                />
                {roles.map((role) => {
                  // The inherit option says what will REALLY apply to this
                  // group: the general setting chosen below if there is one,
                  // otherwise the default resolved by the orchestrator.
                  const def = defaults?.[role];
                  const generalMain = pairLabel(generalPicks[`${role}:main`]);
                  const generalFb = pairLabel(generalPicks[`${role}:fallback`]);
                  return (
                    <RoleRow
                      key={role}
                      role={role}
                      catalog={catalog}
                      main={picks[`${role}:main`]}
                      fallback={picks[`${role}:fallback`]}
                      onMain={(v) => onPick(`${role}:main`, v)}
                      onFallback={(v) => onPick(`${role}:fallback`, v)}
                      inheritMain={
                        generalMain
                          ? t('taskForm.seriesPlan.groups.inheritGeneral', { value: generalMain })
                          : def?.model
                            ? t('taskForm.seriesPlan.current', { value: def.model })
                            : t('taskForm.seriesPlan.inheritRole')
                      }
                      inheritFallback={
                        generalFb
                          ? t('taskForm.seriesPlan.groups.inheritGeneral', { value: generalFb })
                          : def?.fallback
                            ? t('taskForm.seriesPlan.current', { value: def.fallback })
                            : t('taskForm.seriesPlan.noFallback')
                      }
                      inheritMainPair={generalPicks[`${role}:main`] ?? parsePair(def?.model)}
                      inheritFallbackPair={generalPicks[`${role}:fallback`] ?? parsePair(def?.fallback)}
                      readOnly={!custom}
                      disabled={disabled}
                    />
                  );
                })}
              </div>
            </>
          ) : (
            <div className="text-[11px] text-muted-foreground">{t('taskForm.seriesPlan.groups.noRolesInMode')}</div>
          )}
        </div>
      )}
    </section>
  );
}

/** Sets or removes (inherit) a selection, without mutating the table. */
function withPick(picks: Picks, key: string, value: Pair | undefined): Picks {
  const next = { ...picks };
  if (value) next[key] = value;
  else delete next[key];
  return next;
}

/** Lays a preset's pairs on a column; a role the preset does not set keeps
 *  its selection. */
function withPairs(picks: Picks, column: PresetColumn, pairs: Partial<Record<SeriesPlanRole, Pair>>): Picks {
  const next = { ...picks };
  for (const [role, pair] of Object.entries(pairs)) {
    if (pair) next[`${role}:${column}`] = pair;
  }
  return next;
}

/** Reads the settings of a selections table for the given roles; a row with
 *  nothing set does not appear. */
function collectRoles<R extends SeriesPlanRole>(
  picks: Picks,
  roles: readonly R[],
): Partial<Record<R, SeriesPlanRoleConfig>> {
  const out: Partial<Record<R, SeriesPlanRoleConfig>> = {};
  for (const role of roles) {
    const cfg: SeriesPlanRoleConfig = {};
    if (MAIN_EDITABLE[role]) {
      const main = picks[`${role}:main`];
      if (main) {
        cfg.backend = main.backend;
        cfg.model = main.model;
      }
    }
    const fb = picks[`${role}:fallback`];
    if (fb) {
      cfg.fallbackBackend = fb.backend;
      cfg.fallbackModel = fb.model;
    }
    if (Object.keys(cfg).length > 0) out[role] = cfg;
  }
  return out;
}

/** The placeholder the daemon writes when the title gives no usable name. */
const UNNAMED_TOPIC = '<topic>';

/** What the field holds: the name without the prefix the project imposes. */
export function branchTopic(landing: SeriesPlanLanding): string {
  if (landing.branch.endsWith(UNNAMED_TOPIC)) return '';
  return landing.branch.startsWith(landing.prefix) ? landing.branch.slice(landing.prefix.length) : landing.branch;
}

/** The full name a typed topic stands for, written the daemon's way. */
export function branchFullName(topic: string, prefix: string): string {
  const name = topic.trim();
  return name.startsWith(prefix) ? name : `${prefix}${name}`;
}

/** The branch the job ends up in, for a payload older than `target`. */
export function landingTarget(landing: SeriesPlanLanding): string {
  if (landing.target) return landing.target;
  const slash = landing.base_ref.indexOf('/');
  return landing.mode !== 'local' && slash > 0 ? landing.base_ref.slice(slash + 1) : landing.base_ref;
}

/** A project without `mode` is one the field already knew: pull requests. */
export function landsThroughPr(landing: SeriesPlanLanding): boolean {
  return landing.mode !== 'local';
}

/** The repository's branches a job may start from: never its target, which
 *  the daemon refuses. */
export function startableBranches(landing: SeriesPlanLanding): string[] {
  const target = landingTarget(landing);
  return (landing.branches ?? []).map((b) => b.name).filter((name) => name !== target);
}

/** Beyond this many branches, the list gets a search field. */
const BRANCH_SEARCH_FROM = 8;

/** The daemon's verdict on the name in the field. */
export type BranchCheck =
  | { state: 'ok'; branch: string }
  | { state: 'refused'; message: string }
  /** Typed, not judged yet; or the check could not answer (the daemon judges at launch). */
  | { state: 'pending' };

function initialBranchCheck(landing: SeriesPlanLanding, kind: SeriesPlanBranch['kind'], topic: string, picked: string): BranchCheck {
  if (landing.locked) return { state: 'ok', branch: landing.branch };
  if (kind === 'existing') {
    return picked === '' ? { state: 'refused', message: t('taskForm.seriesPlan.branch.pickExisting') } : { state: 'pending' };
  }
  if (landing.refusal) return { state: 'refused', message: t('apiErrors.plan_branch_refused', { detail: landing.refusal }) };
  if (topic === '') return { state: 'refused', message: t('taskForm.seriesPlan.branch.empty') };
  if (topic !== branchTopic(landing)) return { state: 'pending' };
  return { state: 'ok', branch: landing.branch };
}

/** Asks the daemon what the name would become; `pending` when it cannot say. */
async function checkBranch(project: string, branch: string, kind: SeriesPlanBranch['kind']): Promise<BranchCheck> {
  try {
    const res = await fetch(`/api/ui/projects/${encodeURIComponent(project)}/integration/branch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ branch, kind }),
    });
    const body: unknown = await res.json().catch(() => null);
    if (res.ok && body && typeof (body as { branch?: unknown }).branch === 'string') {
      return { state: 'ok', branch: (body as { branch: string }).branch };
    }
    if (res.status === 400) return { state: 'refused', message: apiErrorMessage(body, { status: res.status }) };
  } catch { /* offline: the daemon checks the name again at launch */ }
  return { state: 'pending' };
}

/**
 * The branch the answer names. A locked one is sent as it is, named
 * `existing` so the daemon takes it without a prefix: it keeps the kind it
 * recorded, and a project that merges locally needs the branch named to keep
 * its job on it.
 */
export function answerBranch(
  landing: SeriesPlanLanding, kind: SeriesPlanBranch['kind'], topic: string, picked: string,
): SeriesPlanBranch {
  if (landing.locked) return { kind: 'existing', name: landing.branch };
  return kind === 'existing' ? { kind, name: picked } : { kind, name: branchFullName(topic, landing.prefix) };
}

/** Two or three exclusive choices side by side, the chosen one filled. */
function Segmented<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
  testId,
}: {
  label: string;
  value: V;
  options: ReadonlyArray<{ value: V; label: string; title?: string }>;
  onChange: (value: V) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('flex min-w-0 flex-1 flex-wrap gap-1 rounded p-0.5', INSET)} data-testid={testId}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          disabled={disabled}
          title={o.title}
          onClick={() => onChange(o.value)}
          data-value={o.value}
          className={cn(
            'min-w-0 flex-1 truncate rounded px-2 py-1 text-[11.5px] transition-colors',
            FOCUS_RING,
            o.value === value ? ACTIVE : VEIL_HOVER,
            disabled && 'cursor-default opacity-70',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** The repository's branches, newest first, filtered by a search field when long. */
function ExistingBranchList({
  branches,
  picked,
  onPick,
  disabled,
  invalid,
}: {
  branches: string[];
  picked: string;
  onPick: (name: string) => void;
  disabled: boolean;
  invalid: boolean;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const shown = needle === '' ? branches : branches.filter((name) => name.toLowerCase().includes(needle));
  if (branches.length === 0) {
    return <span className="text-[11.5px] text-muted-foreground" data-testid="plan-branch-none">{t('taskForm.seriesPlan.branch.noBranches')}</span>;
  }
  return (
    <div className={cn('flex min-w-0 flex-1 flex-col gap-1 rounded p-1', INSET, invalid && 'ring-1 ring-inset ring-destructive/60')}>
      {branches.length > BRANCH_SEARCH_FROM && (
        <input
          type="search"
          value={query}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={t('taskForm.seriesPlan.branch.search')}
          aria-label={t('taskForm.seriesPlan.branch.search')}
          onChange={(e) => setQuery(e.target.value)}
          className={cn('h-7 w-full rounded px-2 text-[12px] outline-none placeholder:text-muted-foreground/60', VEIL)}
          data-testid="plan-branch-search"
        />
      )}
      <div role="listbox" aria-label={t('taskForm.seriesPlan.branch.existingList')} className="flex max-h-40 flex-col overflow-y-auto" data-testid="plan-branch-list">
        {shown.map((name) => (
          <button
            key={name}
            type="button"
            role="option"
            aria-selected={name === picked}
            disabled={disabled}
            onClick={() => onPick(name)}
            className={cn(
              'flex min-w-0 items-center gap-1.5 rounded px-2 py-1 text-left text-[12px] transition-colors',
              FOCUS_RING,
              name === picked ? ACTIVE : VEIL_HOVER,
            )}
          >
            <GitBranch aria-hidden className="size-3 shrink-0" />
            <span className="truncate">{name}</span>
          </button>
        ))}
        {shown.length === 0 && (
          <span className="px-2 py-1 text-[11.5px] text-muted-foreground">{t('taskForm.seriesPlan.branch.noMatch')}</span>
        )}
      </div>
    </div>
  );
}

/** The folded summary's destination: "merged into main", "PR to main", "kept on the branch". */
export function finishSummary(landing: SeriesPlanLanding, finish: SeriesPlanFinish): string {
  if (finish === 'keep') return t('taskForm.seriesPlan.branch.summaryKeep');
  const target = landingTarget(landing);
  return landsThroughPr(landing)
    ? t('taskForm.seriesPlan.branch.summaryPr', { target })
    : t('taskForm.seriesPlan.branch.summaryMerge', { target });
}

/**
 * The job's branch and where it ends up, folded under "Advanced": most plans
 * keep the new branch the agent proposed, merged into the target. A new name
 * takes the project's prefix, which is not typed; an existing branch is picked
 * from the repository's list. The daemon judges every name
 * (`POST …/integration/branch`), so the field never accepts one the plan's
 * answer would refuse.
 */
function BranchField({
  landing,
  kind,
  onKind,
  topic,
  onTopic,
  picked,
  onPicked,
  finish,
  onFinish,
  check,
  resolvesIssues,
  onResolvesIssues,
  disabled,
}: {
  landing: SeriesPlanLanding;
  kind: SeriesPlanBranch['kind'];
  onKind: (kind: SeriesPlanBranch['kind']) => void;
  topic: string;
  onTopic: (topic: string) => void;
  picked: string;
  onPicked: (name: string) => void;
  finish: SeriesPlanFinish;
  onFinish: (finish: SeriesPlanFinish) => void;
  check: BranchCheck;
  resolvesIssues: boolean;
  onResolvesIssues: (value: boolean) => void;
  disabled: boolean;
}) {
  const panelId = useId();
  const resolvesId = useId();
  // A name to fix opens the field: folded, the error would stay unseen.
  const [open, setOpen] = useState(() => check.state === 'refused');
  useEffect(() => { if (check.state === 'refused') setOpen(true); }, [check.state]);
  const pr = landsThroughPr(landing);
  const target = landingTarget(landing);
  const typed = branchFullName(topic, landing.prefix);
  const named = kind === 'existing' ? picked : typed;
  const shown = landing.locked ? landing.branch : check.state === 'ok' ? check.branch : named;
  const refused = check.state === 'refused' && !landing.locked;
  // The box only means something with a pull request that closes issues.
  const offersResolves = pr && finish === 'merge';
  const labelClass = 'w-[76px] shrink-0 text-[12px] font-medium sm:w-[92px]';
  const hintClass = 'text-[10.5px] sm:pl-[100px]';
  return (
    <section className={cn('rounded-md', VEIL)} data-testid="plan-branch">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
        className={cn('flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors', VEIL_HOVER, FOCUS_RING)}
      >
        <ChevronRight aria-hidden className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 text-[12px] font-medium">{t('taskForm.seriesPlan.branch.advanced')}</span>
        <span className="flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate" data-testid="plan-branch-summary">{shown || t('taskForm.seriesPlan.branch.unpicked')}</span>
          {landing.locked && <Lock aria-hidden className="size-3 shrink-0" />}
          <span className="shrink-0" data-testid="plan-finish-summary">· {finishSummary(landing, finish)}</span>
          {/* Folded, the ticked box would go unseen: the summary says it. */}
          {offersResolves && resolvesIssues && (
            <span className="ml-1 inline-flex shrink-0 items-center gap-1 text-foreground/75" data-testid="plan-resolves-summary" title={t('taskForm.seriesPlan.branch.resolvesIssues')}>
              <CircleCheck aria-hidden className="size-3" />{t('taskForm.seriesPlan.branch.resolvesIssuesSummary')}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div id={panelId} className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          <div className="flex items-center gap-2">
            <span className={labelClass}>{t('taskForm.seriesPlan.branch.label')}</span>
            <Segmented
              label={t('taskForm.seriesPlan.branch.kindLabel')}
              value={landing.locked ? landing.kind ?? 'new' : kind}
              options={[
                { value: 'new', label: t('taskForm.seriesPlan.branch.kindNew') },
                { value: 'existing', label: t('taskForm.seriesPlan.branch.kindExisting') },
              ]}
              onChange={onKind}
              disabled={disabled || landing.locked}
              testId="plan-branch-kind"
            />
          </div>
          <div className="flex items-start gap-2 sm:pl-[100px]">
            {!landing.locked && kind === 'existing' ? (
              <ExistingBranchList
                branches={startableBranches(landing)}
                picked={picked}
                onPick={onPicked}
                disabled={disabled}
                invalid={refused}
              />
            ) : (
              <div
                className={cn(
                  'flex h-8 min-w-0 flex-1 items-center rounded px-2 text-[12px]',
                  INSET,
                  refused && 'ring-1 ring-inset ring-destructive/60',
                )}
              >
                <span className="shrink-0 text-muted-foreground" data-testid="plan-branch-prefix">{landing.locked ? '' : landing.prefix}</span>
                <input
                  aria-label={t('taskForm.seriesPlan.branch.label')}
                  value={landing.locked ? landing.branch : topic}
                  readOnly={landing.locked}
                  disabled={disabled}
                  spellCheck={false}
                  autoComplete="off"
                  aria-invalid={refused}
                  title={landing.locked ? t('taskForm.seriesPlan.branch.locked') : undefined}
                  onChange={(e) => onTopic(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent outline-none read-only:text-muted-foreground disabled:opacity-70"
                  data-testid="plan-branch-input"
                />
              </div>
            )}
          </div>
          {landing.locked ? (
            <span className={cn(hintClass, 'text-muted-foreground')}>{t('taskForm.seriesPlan.branch.locked')}</span>
          ) : refused ? (
            <span role="alert" className={cn(hintClass, 'text-destructive')} data-testid="plan-branch-error">{check.message}</span>
          ) : kind === 'new' && check.state === 'ok' && check.branch !== typed ? (
            <span className={cn(hintClass, 'text-muted-foreground')}>
              {t('taskForm.seriesPlan.branch.createdAs', { branch: check.branch })}
            </span>
          ) : null}
          <div className="flex items-center gap-2 pt-1">
            <span className={labelClass}>{t('taskForm.seriesPlan.branch.finishLabel')}</span>
            <Segmented
              label={t('taskForm.seriesPlan.branch.finishLabel')}
              value={finish}
              options={[
                {
                  value: 'merge',
                  label: pr ? t('taskForm.seriesPlan.branch.finishPr', { target }) : t('taskForm.seriesPlan.branch.finishMerge', { target }),
                },
                { value: 'keep', label: t('taskForm.seriesPlan.branch.finishKeep'), title: t('taskForm.seriesPlan.branch.finishKeepHint') },
              ]}
              onChange={onFinish}
              disabled={disabled}
              testId="plan-finish"
            />
          </div>
          {offersResolves && (
            <div className="flex items-center gap-2 pt-1 sm:pl-[100px]" title={t('taskForm.seriesPlan.branch.resolvesIssuesHint')}>
              <input
                id={resolvesId}
                type="checkbox"
                checked={resolvesIssues}
                disabled={disabled}
                onChange={(e) => onResolvesIssues(e.target.checked)}
                className="size-3.5 shrink-0 accent-primary"
                data-testid="plan-resolves-issues"
              />
              <label htmlFor={resolvesId} className="text-[12px]">{t('taskForm.seriesPlan.branch.resolvesIssues')}</label>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function SeriesPlanForm({
  form,
  pending,
  busy,
  onSubmit,
  onCancel,
  missionId = null,
}: {
  form: SeriesPlanFormPayload;
  pending: boolean;
  busy: boolean;
  /** `false` when the answer did not reach the daemon: the draft is kept. */
  onSubmit: (answer: SeriesPlanAnswer) => void | boolean | Promise<boolean>;
  onCancel: () => void;
  /** Scope of the session draft (`lib/series-plan-draft.ts`); none without it. */
  missionId?: string | null;
}) {
  const catalog = useBackendCatalog();
  // A reload, or a card that expired and came back, starts from what the user
  // had already chosen. An answered card never reads it: it would show choices
  // that were not the ones sent.
  const [draft] = useState(() => (pending ? loadSeriesPlanDraft(sessionDraftStorage(), missionId, form) : null));
  const [mode, setMode] = useState<SeriesPlanMode>(() => draft?.mode ?? DEFAULT_SERIES_PLAN_MODE);
  /** Raw selections, keyed `${role}:main` / `${role}:fallback`. Kept flat and
   *  NEVER purged on a mode change: going back to a mode already visited must
   *  find its settings again. Filtering by mode happens on send, where only
   *  the roles of the chosen mode are read. */
  const [picks, setPicks] = useState<Picks>(() => draft?.picks ?? {});
  /** The same table, per group of parts. Same rules. */
  const [groupPicks, setGroupPicks] = useState<Record<string, Picks>>(() => draft?.groupPicks ?? {});
  /** One group open at a time: the UI stays compact (the maintainer's request). The
   *  header's summary and badge already say what each group carries. */
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  /** Groups opened for settings with nothing set yet: "Own models" shows from
   *  the click, not only at the first changed menu. */
  const [groupCustom, setGroupCustom] = useState<Record<string, boolean>>(() => draft?.groupCustom ?? {});
  const [note, setNote] = useState(() => draft?.note ?? '');
  const landing = form.landing;
  // A branch the series already started from is fixed, kind included.
  const [branchKind, setBranchKind] = useState<SeriesPlanBranch['kind']>(() =>
    (landing && !landing.locked && draft?.branchKind === 'existing' ? 'existing' : 'new'));
  /** The new branch's topic, without the project's prefix. */
  const [topic, setTopic] = useState(() => (landing && !landing.locked && draft?.branch !== undefined ? draft.branch : landing ? branchTopic(landing) : ''));
  /** The existing branch picked in the repository's list. */
  const [picked, setPicked] = useState(() => (landing && !landing.locked ? draft?.existing ?? '' : ''));
  const [finish, setFinish] = useState<SeriesPlanFinish>(() => (landing ? draft?.finish ?? landing.finish ?? 'merge' : 'merge'));
  const [branchCheck, setBranchCheck] = useState<BranchCheck>(() =>
    (landing ? initialBranchCheck(landing, branchKind, topic, picked) : { state: 'pending' }));
  const [resolvesIssues, setResolvesIssues] = useState(() => draft?.resolvesIssues === true);
  useEffect(() => {
    if (!landing || landing.locked || !pending) return;
    let name: string;
    if (branchKind === 'existing') {
      if (picked === '') { setBranchCheck({ state: 'refused', message: t('taskForm.seriesPlan.branch.pickExisting') }); return; }
      name = picked;
    } else {
      if (topic.trim() === '') { setBranchCheck({ state: 'refused', message: t('taskForm.seriesPlan.branch.empty') }); return; }
      // The opening already judged the proposal: no request until the name changes.
      if (topic === branchTopic(landing) && !landing.refusal) { setBranchCheck({ state: 'ok', branch: landing.branch }); return; }
      if (topic === branchTopic(landing) && landing.refusal) {
        setBranchCheck({ state: 'refused', message: t('apiErrors.plan_branch_refused', { detail: landing.refusal }) });
        return;
      }
      name = branchFullName(topic, landing.prefix);
    }
    setBranchCheck({ state: 'pending' });
    let live = true;
    // A pick is one click: no need to wait for the typing to settle.
    const timer = setTimeout(() => {
      void checkBranch(landing.project, name, branchKind).then((out) => { if (live) setBranchCheck(out); });
    }, branchKind === 'existing' ? 0 : 350);
    return () => { live = false; clearTimeout(timer); };
    // `landing` comes with `form`, a new object on every render of the card.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branchKind, topic, picked, pending]);
  useEffect(() => {
    if (!pending) return;
    const open = landing && !landing.locked;
    const branch = open && topic !== branchTopic(landing) ? { branch: topic } : {};
    const kind = open && branchKind === 'existing' ? { branchKind: 'existing' as const } : {};
    const existing = open && picked !== '' ? { existing: picked } : {};
    const changedFinish = landing && finish !== (landing.finish ?? 'merge') ? { finish } : {};
    const resolves = resolvesIssues ? { resolvesIssues: true as const } : {};
    saveSeriesPlanDraft(sessionDraftStorage(), missionId, form, {
      mode, picks, groupPicks, groupCustom, note, ...branch, ...kind, ...existing, ...changedFinish, ...resolves,
    });
    // `form` is a new object on every render of the card; the draft follows what the user changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, picks, groupPicks, groupCustom, note, topic, branchKind, picked, finish, resolvesIssues]);

  const roles = ROLES_BY_MODE[mode];
  const presetRoles: Record<PresetColumn, readonly SeriesPlanRole[]> = { main: roles.filter((role) => MAIN_EDITABLE[role]), fallback: roles };
  const groupRoles = roles.filter(isGroupRole);
  const tile = useMemo(() => MODE_TILES.find((t) => t.mode === mode)!, [mode]);
  const disabled = !pending || busy;
  // Every mode and every project: a sequential job lands the same way.
  const showsBranch = landing !== undefined;
  const branchRefused = showsBranch && !landing.locked && branchCheck.state === 'refused';

  const groupNames = useMemo(() => planGroupNames(form.volets), [form.volets]);
  const indexed = form.volets.map((volet, index) => ({ volet, index }));
  const ungrouped = indexed.filter(({ volet }) => typeof volet.group !== 'string' || volet.group.trim() === '');

  function set(key: string, value: Pair | undefined) {
    setPicks((prev) => withPick(prev, key, value));
  }
  function setGroup(name: string, key: string, value: Pair | undefined) {
    setGroupPicks((prev) => ({ ...prev, [name]: withPick(prev[name] ?? {}, key, value) }));
  }
  function groupHasSettings(name: string): boolean {
    return Object.keys(collectRoles(groupPicks[name] ?? {}, groupRoles)).length > 0;
  }
  const groupIsCustom = (name: string) => groupCustom[name] === true || groupHasSettings(name);
  /** Going back to the general settings clears the group's: "follow" only
   *  makes sense if nothing contradicts it. */
  function syncGroup(name: string) {
    setGroupPicks((prev) => ({ ...prev, [name]: {} }));
    setGroupCustom((prev) => ({ ...prev, [name]: false }));
  }

  async function submit() {
    const out = collectRoles(picks, roles);
    const groups: Record<string, SeriesPlanGroupConfig> = {};
    for (const name of groupNames) {
      const cfg = collectRoles(groupPicks[name] ?? {}, groupRoles);
      if (Object.keys(cfg).length > 0) groups[name] = cfg;
    }
    const trimmed = note.trim();
    const sent = await onSubmit({
      mode,
      roles: out,
      ...(Object.keys(groups).length > 0 ? { groups } : {}),
      note: trimmed || undefined,
      ...(showsBranch ? { branch: answerBranch(landing, branchKind, topic, picked), finish } : {}),
      ...(showsBranch && landsThroughPr(landing) && finish === 'merge' && resolvesIssues ? { resolves_issues: true } : {}),
    });
    if (sent !== false) clearSeriesPlanDraft(sessionDraftStorage(), missionId, form);
  }

  return (
    <div className="flex flex-col gap-3">
      <div>
        <div className="text-[12.5px] text-muted-foreground">
          {t('taskForm.seriesPlan.heading')}
        </div>
        <div className="mt-0.5 text-[13.5px] font-medium leading-snug">{form.chantier}</div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
        {MODE_TILES.map(({ mode: m, Icon, headKey, subKey, titleKey }) => {
          const active = m === mode;
          return (
            <button
              key={m}
              type="button"
              title={t(titleKey)}
              aria-pressed={active}
              disabled={disabled}
              onClick={() => setMode(m)}
              className={cn(
                'flex items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                FOCUS_RING,
                active ? ACTIVE : cn(VEIL, VEIL_HOVER),
                disabled && 'cursor-default opacity-60',
              )}
            >
              <Icon
                className={cn(
                  'mt-0.5 h-4 w-4 shrink-0',
                  active ? 'text-primary-foreground dark:text-[hsl(var(--primary))]' : 'text-muted-foreground',
                )}
              />
              <span className="min-w-0 leading-tight">
                <span
                  className={cn(
                    'block truncate text-[12px] font-medium',
                    active ? 'text-primary-foreground dark:text-foreground' : 'text-foreground/80',
                  )}
                >
                  {t(headKey)}
                </span>
                <span className={cn('block text-[10.5px]', active ? 'text-primary-foreground/80 dark:text-muted-foreground' : 'text-muted-foreground')}>{t(subKey)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/* The explanation line of the selected mode. Tinted with the primary
          colour: without a visual mark, it read as a caption of the grid
          rather than as the consequence of the click just made. */}
      <div className="rounded-md bg-primary/[0.08] px-2.5 py-2 text-[11.5px] leading-snug text-foreground/75 dark:bg-primary/[0.14]">
        <span className="font-medium text-foreground">{t(tile.titleKey)}</span> — {t(tile.detailKey)}
      </div>

      {/* The parts as the agent split them: their size is what justifies (or
          not) going to the Kanban. Hiding them would force scrolling back up
          the conversation to decide. Grouped by the agent, they become
          collapsibles with settings; without a group, the plain list. */}
      {groupNames.length === 0 ? (
        form.volets.length > 0 && (
          <div className={cn('rounded-md px-2.5 py-2', VEIL)}>
            <VoletList volets={indexed} />
          </div>
        )
      ) : (
        <div className="flex flex-col gap-2" data-testid="plan-groups">
          {groupNames.map((name) => (
            <GroupSection
              key={name}
              name={name}
              volets={indexed.filter(({ volet }) => volet.group === name)}
              roles={groupRoles}
              catalog={catalog}
              picks={groupPicks[name] ?? {}}
              generalPicks={picks}
              defaults={form.defaults}
              open={openGroup === name}
              custom={groupIsCustom(name)}
              onToggle={() => setOpenGroup((prev) => (prev === name ? null : name))}
              onPick={(key, value) => setGroup(name, key, value)}
              onOverride={() => setGroupCustom((prev) => ({ ...prev, [name]: true }))}
              onSync={() => syncGroup(name)}
              onApplyPreset={(column, pairs) => {
                setGroupPicks((prev) => ({ ...prev, [name]: withPairs(prev[name] ?? {}, column, pairs) }));
                setGroupCustom((prev) => ({ ...prev, [name]: true }));
              }}
              disabled={disabled}
            />
          ))}
          {ungrouped.length > 0 && (
            <div className={cn('rounded-md px-2.5 py-2', VEIL)} data-testid="plan-ungrouped">
              <div className="mb-1 flex items-baseline gap-1.5">
                <span className="text-[12px] font-medium">{t('taskForm.seriesPlan.groups.other')}</span>
                <span className="text-[10.5px] text-muted-foreground">{t('taskForm.seriesPlan.groups.inherits')}</span>
              </div>
              <VoletList volets={ungrouped} />
            </div>
          )}
        </div>
      )}

      {/* General settings: they apply to any group that sets nothing, and lay
          the same model everywhere in one gesture. */}
      <div className="flex flex-col gap-2.5">
        {groupNames.length > 0 && (
          <div className="text-[12px] font-medium">{t('taskForm.seriesPlan.groups.general')}</div>
        )}
        <PlanPresetBar
          catalog={catalog}
          roles={presetRoles}
          onApply={(column, pairs) => setPicks((prev) => withPairs(prev, column, pairs))}
          disabled={disabled}
        />
        <RowsHeader
          save={(column) => presetRoles[column].length > 0 && (
            <PresetSaveButton
              catalog={catalog}
              column={column}
              roles={presetRoles[column]}
              picks={shownPicks(roles, picks, (role, col) =>
                parsePair(col === 'main' ? form.defaults?.[role]?.model : form.defaults?.[role]?.fallback))}
              disabled={disabled}
            />
          )}
        />
        {roles.map((role) => {
          // What applies today, named rather than implied: "TIMON global
          // fallback" does not help decide if you do not remember what it is.
          // The inherit option therefore carries the real pair, and falls
          // back on the generic label when nothing can be resolved.
          const def = form.defaults?.[role];
          return (
            <RoleRow
              key={role}
              role={role}
              catalog={catalog}
              main={picks[`${role}:main`]}
              fallback={picks[`${role}:fallback`]}
              onMain={(v) => set(`${role}:main`, v)}
              onFallback={(v) => set(`${role}:fallback`, v)}
              inheritMain={def?.model ? t('taskForm.seriesPlan.current', { value: def.model }) : t('taskForm.seriesPlan.inheritRole')}
              inheritFallback={def?.fallback ? t('taskForm.seriesPlan.current', { value: def.fallback }) : t('taskForm.seriesPlan.noFallback')}
              inheritMainPair={parsePair(def?.model)}
              inheritFallbackPair={parsePair(def?.fallback)}
              runningModel={def?.model}
              disabled={disabled}
            />
          );
        })}
      </div>

      {showsBranch && (
        <BranchField
          landing={landing}
          kind={branchKind}
          onKind={setBranchKind}
          topic={topic}
          onTopic={setTopic}
          picked={picked}
          onPicked={setPicked}
          finish={finish}
          onFinish={setFinish}
          check={branchCheck}
          resolvesIssues={resolvesIssues}
          onResolvesIssues={setResolvesIssues}
          disabled={disabled}
        />
      )}

      <textarea
        value={note}
        disabled={disabled}
        onChange={(e) => setNote(e.target.value)}
        placeholder={t('taskForm.seriesPlan.notePlaceholder')}
        className={cn(
          'min-h-[52px] w-full resize-y rounded-md px-2.5 py-1.5 text-[12.5px] leading-snug transition-colors',
          'placeholder:text-muted-foreground/60 focus-visible:bg-foreground/[0.06] dark:focus-visible:bg-foreground/[0.10] disabled:opacity-70',
          VEIL,
          FOCUS_RING,
        )}
      />

      {pending ? (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={busy || branchRefused} onClick={() => void submit()} className="h-7 gap-1.5">
            {t('taskForm.seriesPlan.launch')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
            className={cn('h-7 gap-1.5', VEIL, VEIL_HOVER)}
          >
            {t('taskForm.cancel')}
          </Button>
        </div>
      ) : (
        <span className={cn('w-fit rounded px-2 py-0.5 text-[10.5px] text-muted-foreground', VEIL)}>
          {t('taskForm.seriesPlan.answered')}
        </span>
      )}
    </div>
  );
}
