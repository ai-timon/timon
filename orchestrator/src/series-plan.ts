/**
 * Series plan: the TYPED form that replaces the never-ending list of multiple-choice questions.
 * The agent opens it with the MCP tool `kanban_plan` (formerly `ask_series_plan`); the
 * form keeps its `kind: 'series_plan'`, persisted in the events.
 *
 * WHY A TYPED FORM. The "parallel split" (how to run a big
 * job: sequential or Kanban, with which models and which fallbacks) went
 * through four generic questions (`ask_user` at the time) that the agent wrote itself.
 * Two structural defects:
 *   1. the agent LISTED the fallback models from memory — so it offered
 *      non-existent or stale backend/model pairs, which nothing validated;
 *   2. the UI could render nothing better than a pile of radio buttons, because
 *      it only saw free text. Recognising it from the text would have been
 *      worse: the slightest rewording of the preamble would have broken the rendering
 *      silently.
 *
 * Here the agent sends ONLY the job's context (`SeriesPlanForm`). The UI
 * builds the menus from `GET /api/backends/catalog` — a single source, so
 * a model added to a profile appears without a rebuild — and returns a structured
 * `SeriesPlanAnswer`. This module is the shared contract: validation on the
 * way out, validation on the way back, and translation of the plan into CLI commands.
 *
 * The agent APPLIES the plan itself (deliberate choice: the UI collects, it
 * does not run). `seriesPlanCommands()` gives it the exact commands so
 * that this application does not rely on its memory of the flags.
 */

import { PIPELINES, isTaskType, type FallbackScope, type TaskType } from './db.js';
import type {
  SeriesPlanAnswer, SeriesPlanBranch, SeriesPlanFinish, SeriesPlanGroupRole as ContractGroupRole,
  SeriesPlanMode as ContractMode, SeriesPlanRole as ContractRole, SeriesPlanRoleConfig,
} from './plugins/contract/questions.js';
import type { Assert, Equals } from './type-equality.js';
export type {
  SeriesPlanAnswer, SeriesPlanBranch, SeriesPlanFinish, SeriesPlanGroupConfig, SeriesPlanRoleConfig,
} from './plugins/contract/questions.js';

/** An execution mode = a tile of the grid, on the UI side. */
export const SERIES_PLAN_MODES = [
  /** Everything in the current mission. No task, no spawn. */
  'sequential-here',
  /** 1→1 handoff to a new mission (blank context), the current one
   *  staying on standby for the final synthesis. */
  'sequential-new-mission',
  /** N tasks code en worktrees → review → merge. */
  'kanban-full',
  /** N code tasks, each merging its own branch. */
  'kanban-code-self',
  /** N code tasks + a final merge task that consolidates the group. */
  'kanban-code-group',
] as const;
export type SeriesPlanMode = (typeof SERIES_PLAN_MODES)[number];
/** The public contract spells the modes out; compilation fails if they part. */
type _SeriesPlanModesMatchContract = Assert<Equals<SeriesPlanMode, ContractMode>>;

/**
 * Role configurable in the form.
 *
 * `mission` is not a `TaskType`: it is the new mission of the
 * `sequential-new-mission` mode. Its fallback is nevertheless set on the
 * `orchestrator` scope — it drives its own job. The main model of the
 * roles that ARE task types is set for the series (`timon series role
 * set`), never in `roles.json`.
 */
export const SERIES_PLAN_ROLES = ['orchestrator', 'mission', 'code', 'review', 'merge', 'doc'] as const;
export type SeriesPlanRole = (typeof SERIES_PLAN_ROLES)[number];
type _SeriesPlanRolesMatchContract = Assert<Equals<SeriesPlanRole, ContractRole>>;

/** "role: model ▾ | fallback ▾" lines to display, per mode. The UI derives its
 *  rendering from it; the validator uses it to refuse an off-topic role (a
 *  reviewer configured on a pipeline without review = a dead setting). */
export const ROLES_BY_MODE: Readonly<Record<SeriesPlanMode, readonly SeriesPlanRole[]>> = Object.freeze({
  'sequential-here': ['orchestrator'],
  'sequential-new-mission': ['orchestrator', 'mission'],
  'kanban-full': ['orchestrator', 'code', 'review', 'merge', 'doc'],
  'kanban-code-self': ['orchestrator', 'code', 'doc'],
  // The grouped merge keeps a final `merge` task: the line must stay.
  'kanban-code-group': ['orchestrator', 'code', 'merge', 'doc'],
});

/** Matching `tasks.pipeline` value, or `null` for the sequential modes
 *  (no task created). */
export const PIPELINE_BY_MODE: Readonly<Record<SeriesPlanMode, string | null>> = Object.freeze({
  'sequential-here': null,
  'sequential-new-mission': null,
  'kanban-full': 'full',
  'kanban-code-self': 'code-self',
  'kanban-code-group': 'code-group',
});

/** Roles a GROUP of slices can set: those that are task types.
 *  `orchestrator` and `mission` drive the whole series — a model per group makes
 *  no sense for them, they stay global. */
export const SERIES_PLAN_GROUP_ROLES = ['code', 'review', 'merge', 'doc'] as const;
export type SeriesPlanGroupRole = (typeof SERIES_PLAN_GROUP_ROLES)[number];
type _SeriesPlanGroupRolesMatchContract = Assert<Equals<SeriesPlanGroupRole, ContractGroupRole>>;

/** What the agent sends: the job's context, nothing more. */
export type SeriesPlanVolet = {
  title: string;
  description?: string;
  /** Short name of the group of slices ("simple", "complexe"…), proposed by
   *  the agent when the slices differ in difficulty: the form then offers
   *  model settings PER GROUP, the general settings per role
   *  staying the default. Without a group, nothing changes. */
  group?: string;
};
export type SeriesPlanForm = {
  kind: 'series_plan';
  /** Title of the job, shown at the head of the form. */
  chantier: string;
  /** Proposed split. One Kanban task per slice in the Kanban modes. */
  volets: SeriesPlanVolet[];
  /** The job's integration branch the agent proposes (`feat/topic` or
   *  `topic`), for a project that lands through pull requests. Ignored by any
   *  other project; the person answering may change it. */
  branch?: string;
};

/** A proposed branch name is a ref, not a paragraph (`plan-landing.ts`). */
export const MAX_PLAN_BRANCH_FIELD_CHARS = 200;

/** Defect of a branch field (form or answer), or null. Whether the name is a
 *  usable branch depends on the project, so it is checked where it is read. */
function branchFieldDefect(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') return 'field `branch` is not a string';
  if (value.length > MAX_PLAN_BRANCH_FIELD_CHARS) {
    return `field \`branch\` of ${value.length} characters (maximum ${MAX_PLAN_BRANCH_FIELD_CHARS})`;
  }
  if (GROUP_NAME_CONTROL_CHARS.test(value)) return 'field `branch` holds a control character';
  return null;
}

export const SERIES_PLAN_BRANCH_KINDS = ['new', 'existing'] as const;
export const SERIES_PLAN_FINISHES = ['merge', 'keep'] as const;
type _SeriesPlanBranchKindsMatchContract = Assert<Equals<(typeof SERIES_PLAN_BRANCH_KINDS)[number], SeriesPlanBranch['kind']>>;
type _SeriesPlanFinishesMatchContract = Assert<Equals<(typeof SERIES_PLAN_FINISHES)[number], SeriesPlanFinish>>;

/** Defect of the answer's `branch`: the earlier string, or `{ kind, name }`. */
function answerBranchDefect(value: unknown): string | null {
  if (value === undefined || typeof value === 'string') return branchFieldDefect(value);
  if (!isRecord(value)) return 'field `branch` is neither a string nor an object';
  if (!(SERIES_PLAN_BRANCH_KINDS as readonly unknown[]).includes(value.kind)) {
    return `field \`branch.kind\` must be one of ${SERIES_PLAN_BRANCH_KINDS.join(', ')}`;
  }
  for (const key of Object.keys(value)) {
    if (key !== 'kind' && key !== 'name') return `field \`branch.${key}\` is unknown`;
  }
  if (typeof value.name !== 'string' || value.name.trim() === '') return 'field `branch.name` missing or empty';
  return branchFieldDefect(value.name)?.replace('`branch`', '`branch.name`') ?? null;
}

/**
 * The branch the answer chose, in one shape. The earlier bare string is a new
 * branch; `legacy` says so, since that form only ever applied to a project
 * that lands through pull requests.
 */
export function planBranchChoice(
  branch: SeriesPlanAnswer['branch'],
): (SeriesPlanBranch & { legacy: boolean }) | null {
  if (branch === undefined) return null;
  if (typeof branch === 'string') return branch.trim() ? { kind: 'new', name: branch, legacy: true } : null;
  return { kind: branch.kind, name: branch.name, legacy: false };
}

const MAX_VOLETS = 12;
/** A group name is a tab label and a command flag: short. */
export const MAX_GROUP_NAME_CHARS = 60;
/** Beyond this, the form becomes a list of dropdowns: as many groups
 *  as slices is no longer a grouping. */
export const MAX_GROUPS = 6;
/** A group name ends up between single quotes in a shell command
 *  (`seriesPlanCommands`): `shellQuote` neutralises the single quote, not a
 *  line break nor a NUL. No control character, anywhere. */
export const GROUP_NAME_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isSeriesPlanMode(v: unknown): v is SeriesPlanMode {
  return typeof v === 'string' && (SERIES_PLAN_MODES as readonly string[]).includes(v);
}

/**
 * Validates the form SENT BY THE AGENT. Same contract as
 * `validateAskUserPayload`: `null` if renderable, otherwise the named defect, meant
 * to be read again by the faulty agent.
 */
export function validateSeriesPlanForm(form: unknown): string | null {
  if (!isRecord(form)) return 'the form is not an object';
  if (form.kind !== 'series_plan') return 'field `kind` missing or other than `series_plan`';
  if (typeof form.chantier !== 'string' || form.chantier.trim() === '') {
    return 'field `chantier` missing or empty';
  }
  const { volets } = form;
  if (!Array.isArray(volets)) return 'field `volets` missing or not an array';
  if (volets.length === 0) return 'array `volets` is empty — describe at least one part';
  if (volets.length > MAX_VOLETS) return `${volets.length} parts (maximum ${MAX_VOLETS})`;
  for (let i = 0; i < volets.length; i++) {
    const v = volets[i];
    if (!isRecord(v)) return `part ${i + 1}: not an object`;
    if (typeof v.title !== 'string' || v.title.trim() === '') {
      return `part ${i + 1}: field \`title\` missing or empty`;
    }
    if (v.description !== undefined && typeof v.description !== 'string') {
      return `part ${i + 1}: field \`description\` is not a string`;
    }
    if (v.group !== undefined) {
      if (typeof v.group !== 'string' || v.group.trim() === '') {
        return `part ${i + 1}: field \`group\` is empty or not a string`;
      }
      if (v.group.length > MAX_GROUP_NAME_CHARS) {
        return `part ${i + 1}: group name of ${v.group.length} characters (maximum ${MAX_GROUP_NAME_CHARS})`;
      }
      if (GROUP_NAME_CONTROL_CHARS.test(v.group)) {
        return `part ${i + 1}: group name with a control character (line break, tab, NUL…)`;
      }
    }
  }
  const groups = planGroupNames(volets as SeriesPlanVolet[]);
  if (groups.length > MAX_GROUPS) return `${groups.length} part groups (maximum ${MAX_GROUPS})`;
  return branchFieldDefect(form.branch);
}

/** Distinct group names, in the order of first appearance of the slices.
 *  A slice without a group (or whose `group` is not a string) does not count. */
export function planGroupNames(volets: ReadonlyArray<{ group?: string | null }>): string[] {
  const names: string[] = [];
  for (const v of volets) {
    if (typeof v.group === 'string' && v.group.trim() !== '' && !names.includes(v.group)) names.push(v.group);
  }
  return names;
}

/** Defect of a line setting (`SeriesPlanRoleConfig`), or `null`. `label`
 *  names the line in the refusal: "role `code`", "group `simple`, role `code`". */
function roleConfigDefect(label: string, cfg: unknown): string | null {
  if (!isRecord(cfg)) return `${label}: the configuration is not an object`;
  for (const field of ['backend', 'model', 'fallbackBackend', 'fallbackModel']) {
    const value = cfg[field];
    if (value !== undefined && typeof value !== 'string') {
      return `${label}: field \`${field}\` is not a string`;
    }
  }
  // A half-filled fallback translates into no command: setting it
  // would give the illusion of a net that does not exist.
  const hasBackend = typeof cfg.fallbackBackend === 'string' && cfg.fallbackBackend !== '';
  const hasModel = typeof cfg.fallbackModel === 'string' && cfg.fallbackModel !== '';
  if (hasModel && !hasBackend) return `${label}: \`fallbackModel\` without \`fallbackBackend\``;
  return null;
}

/**
 * Validates the answer SENT UP BY THE UI, before it reaches the agent.
 *
 * This guard is not symmetrical paranoia: an unknown `mode` or an
 * off-mode role would make the agent apply a configuration that matches
 * nothing the user saw on screen — exactly the class of bug this
 * form is meant to remove. Refuse rather than let it through.
 */
export function validateSeriesPlanAnswer(answer: unknown, knownGroups: Iterable<string> = []): string | null {
  if (!isRecord(answer)) return 'the answer is not an object';
  if (!isSeriesPlanMode(answer.mode)) return `unknown mode: ${String(answer.mode)}`;
  const allowed = ROLES_BY_MODE[answer.mode];
  const roles = answer.roles ?? {};
  if (!isRecord(roles)) return 'field `roles` is not an object';
  for (const [role, cfg] of Object.entries(roles)) {
    if (!(SERIES_PLAN_ROLES as readonly string[]).includes(role)) return `unknown role: ${role}`;
    if (!allowed.includes(role as SeriesPlanRole)) {
      return `role \`${role}\` is outside mode \`${answer.mode}\``;
    }
    const defect = roleConfigDefect(`role \`${role}\``, cfg);
    if (defect) return defect;
  }
  // A group the form did not emit is a setting that matches
  // no slice: it would never be applied, refuse it.
  if (answer.groups !== undefined) {
    if (!isRecord(answer.groups)) return 'field `groups` is not an object';
    const known = new Set(knownGroups);
    for (const [group, cfgs] of Object.entries(answer.groups)) {
      if (!known.has(group)) return `unknown group: ${group}`;
      if (!isRecord(cfgs)) return `group \`${group}\`: the configuration is not an object`;
      for (const [role, cfg] of Object.entries(cfgs)) {
        if (!(SERIES_PLAN_GROUP_ROLES as readonly string[]).includes(role)) {
          return (SERIES_PLAN_ROLES as readonly string[]).includes(role)
            ? `group \`${group}\`: role \`${role}\` is not set per group`
            : `group \`${group}\`: unknown role: ${role}`;
        }
        if (!allowed.includes(role as SeriesPlanRole)) {
          return `group \`${group}\`: role \`${role}\` is outside mode \`${answer.mode}\``;
        }
        const defect = roleConfigDefect(`group \`${group}\`, role \`${role}\``, cfg);
        if (defect) return defect;
      }
    }
  }
  if (answer.note !== undefined && typeof answer.note !== 'string') {
    return 'field `note` is not a string';
  }
  if (answer.resolves_issues !== undefined && typeof answer.resolves_issues !== 'boolean') {
    return 'field `resolves_issues` is not a boolean';
  }
  if (answer.finish !== undefined && !(SERIES_PLAN_FINISHES as readonly unknown[]).includes(answer.finish)) {
    return `field \`finish\` must be one of ${SERIES_PLAN_FINISHES.join(', ')}`;
  }
  return answerBranchDefect(answer.branch);
}

/** Roles of the form whose main model is set for the series: those that
 *  are task types. `orchestrator` and `mission` are missions, not
 *  tasks — their model does not go through the dispatcher. */
export function seriesRoleScope(role: SeriesPlanRole): TaskType | null {
  return isTaskType(role) ? role : null;
}

/** `series_fallbacks` scope targeted by a role of the form. */
export function fallbackScopeForRole(role: SeriesPlanRole): FallbackScope {
  // The new mission drives its own job: it is an orchestrator.
  if (role === 'mission' || role === 'orchestrator') return 'orchestrator';
  return isTaskType(role) ? role : '*';
}

function shellQuote(value: string): string {
  return /^[a-zA-Z0-9._/@:-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isGroupRole(role: SeriesPlanRole): role is SeriesPlanGroupRole {
  return (SERIES_PLAN_GROUP_ROLES as readonly string[]).includes(role);
}

/** `--group '<name>'` only appears for a group setting: the global
 *  command keeps exactly its previous shape. */
function groupFlag(group: string | undefined): string {
  return group === undefined ? '' : ` --group ${shellQuote(group)}`;
}

function fallbackSetCommand(scope: FallbackScope, cfg: SeriesPlanRoleConfig, group?: string): string {
  const model = cfg.fallbackModel ? ` --model ${shellQuote(cfg.fallbackModel)}` : '';
  return `timon series fallback set --scope ${shellQuote(scope)}${groupFlag(group)} `
    + `--backend ${shellQuote(cfg.fallbackBackend!)}${model}`;
}

function roleSetCommand(scope: TaskType, cfg: SeriesPlanRoleConfig, group?: string): string {
  return `timon series role set --scope ${scope}${groupFlag(group)}`
    + (cfg.backend ? ` --backend ${shellQuote(cfg.backend)}` : '')
    + (cfg.model ? ` --model ${shellQuote(cfg.model)}` : '');
}

/**
 * A job whose project lands through a pull request (`plan-landing.ts`): every
 * task of the plan starts from `branch`, and a last task opens the pull request.
 */
export type SeriesPlanLanding = {
  /** The job's integration branch, `feat/<topic>`. */
  branch: string;
  /** Title of the job, for the pull request task's title. */
  chantier: string;
  /** The job's project, given to every task (`--project`) when the agent
   *  creating them is not in it. */
  taskProject?: string | null;
  /** The job's last task: `pr` (absent) opens the pull request, `local`
   *  merges the branch into `target` on this machine, `none` leaves the work
   *  on the branch. */
  last?: 'pr' | 'local' | 'none';
  /** The local branch a `local` last task merges into. */
  target?: string;
};

/** The task that ends the job, or null when the work stays on its branch. */
function lastTaskCommand(landing: SeriesPlanLanding, flags: string, deps: string | null): string | null {
  const last = landing.last ?? 'pr';
  if (last === 'none') return null;
  const after = deps ? ` --deps ${deps}` : '';
  if (last === 'local') {
    const into = landing.target ?? '<target>';
    return `timon task create --type merge --landing local${flags}${after} `
      + `--title ${shellQuote(`Merge into ${into} — ${landing.chantier}`)} --description '<what the job carries>'`;
  }
  return `timon task create --type merge --landing pr${flags}${after} `
    + `--title ${shellQuote(`Pull request — ${landing.chantier}`)} --description '<what the pull request carries>'`;
}

/**
 * Translates the plan into `timon` commands ready to run, in order.
 *
 * The model choices per role become `timon series role set`, set
 * BEFORE the tasks like the fallbacks: it is the only form that also reaches the
 * review, merge, doc and code iterations the orchestrator creates on its own,
 * without writing into `roles.json` (which would change the default of the following
 * jobs). The coder's choice is therefore no longer copied onto each code task.
 *
 * Returned to the agent with its answer: that is what keeps it from rebuilding the
 * flags from memory (`--scope`, `--pipeline`, `--group-id`) and getting one
 * notch wrong. The task creation commands stay TEMPLATES — the agent fills in
 * the titles and briefs of the slices, which only it knows.
 *
 * The PER-GROUP settings follow the global ones, in the same form with
 * `--group '<name>'` (`series role set`, `series fallback set`); the code task
 * of a grouped slice carries `--plan-group '<name>'`, which review, merge, doc and
 * iterations inherit. Without a group, the output is the previous one, to the byte.
 *
 * With `landing` (the project lands through a pull request), every task created
 * carries `--base <branch>` (and `--project <slug>` when the planning agent is
 * not in that project), and a last `merge` task with `--landing pr`, which
 * depends on the code tasks (or on the grouped merge), opens the pull request.
 * A sequential mode creates no task but that last one: its pilot first asks
 * the daemon for the branch and a worktree on it (`timon pr branch`), codes
 * there, and creates the pull request task, with no deps, once the work is in
 * the branch. Without `landing`, the output is the previous one, to the byte.
 *
 * `landing.last` changes only that last task: `local` merges the branch into
 * the project's local target (`--landing local`), `none` creates none and the
 * work stays on the branch.
 */
export function seriesPlanCommands(
  answer: SeriesPlanAnswer,
  volets: SeriesPlanVolet[] = [],
  landing: SeriesPlanLanding | null = null,
): string[] {
  const cmds: string[] = [];
  for (const role of ROLES_BY_MODE[answer.mode]) {
    const cfg = answer.roles[role];
    if (!cfg?.fallbackBackend) continue;
    cmds.push(fallbackSetCommand(fallbackScopeForRole(role), cfg));
  }

  for (const role of ROLES_BY_MODE[answer.mode]) {
    const cfg = answer.roles[role];
    const scope = seriesRoleScope(role);
    if (!scope || (!cfg?.backend && !cfg?.model)) continue;
    cmds.push(roleSetCommand(scope, cfg));
  }

  // In the order of the slices, not that of the answer's keys: it is the order
  // the agent wrote and the UI displayed.
  const groupRoles = ROLES_BY_MODE[answer.mode].filter(isGroupRole);
  for (const name of planGroupNames(volets)) {
    const cfgs = answer.groups?.[name];
    if (!cfgs) continue;
    for (const role of groupRoles) {
      const cfg = cfgs[role];
      if (cfg?.fallbackBackend) cmds.push(fallbackSetCommand(fallbackScopeForRole(role), cfg, name));
    }
    for (const role of groupRoles) {
      const cfg = cfgs[role];
      if (cfg?.backend || cfg?.model) cmds.push(roleSetCommand(role, cfg, name));
    }
  }

  const pipeline = PIPELINE_BY_MODE[answer.mode];
  if (!pipeline && landing) {
    const project = landing.taskProject ? ` --project ${shellQuote(landing.taskProject)}` : '';
    cmds.push(`timon pr branch ${shellQuote(landing.branch)}`);
    const last = lastTaskCommand(landing, ` --base ${shellQuote(landing.branch)}${project}`, null);
    if (last) cmds.push(last);
  }
  if (pipeline) {
    const group = answer.mode === 'kanban-code-group' ? ' --group-id <GROUP>' : '';
    const base = (landing ? ` --base ${shellQuote(landing.branch)}` : '')
      + (landing?.taskProject ? ` --project ${shellQuote(landing.taskProject)}` : '');
    const count = volets.length || 1;
    for (let i = 0; i < count; i++) {
      const title = volets[i]?.title ?? '<part title>';
      const planGroup = volets[i]?.group ? ` --plan-group ${shellQuote(volets[i]!.group!)}` : '';
      cmds.push(
        `timon task create --type code --pipeline ${pipeline}${group}${planGroup}${base} `
        + `--title ${shellQuote(title)} --description '<part brief>'`,
      );
    }
    if (answer.mode === 'kanban-code-group') {
      cmds.push(
        `timon task create --type merge --group-id <GROUP>${base} --deps <IDS of the code tasks> `
        + `--title ${shellQuote(`Grouped merge — <chantier>`)} --description '<consolidation>'`,
      );
    }
    if (landing) {
      const deps = answer.mode === 'kanban-code-group' ? '<ID of the grouped merge>' : '<IDS of the code tasks>';
      const last = lastTaskCommand(landing, `${group}${base}`, deps);
      if (last) cmds.push(last);
    }
  }
  return cmds;
}

/** Checks that `PIPELINE_BY_MODE` does not drift from the authoritative list of
 *  pipelines (`db.ts`). A mode wired to a non-existent pipeline would create
 *  tasks refused at insertion, long after the user's choice. */
export function seriesPlanPipelineDrift(): string | null {
  for (const [mode, pipeline] of Object.entries(PIPELINE_BY_MODE)) {
    if (pipeline && !(PIPELINES as readonly string[]).includes(pipeline)) {
      return `mode ${mode} → unknown pipeline ${pipeline}`;
    }
  }
  return null;
}
