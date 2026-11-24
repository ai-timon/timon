/** Public plugin types, extracted from the host implementations (TODO #512). */

// Spelled out from the constants of `series-plan.ts`, which proves at compilation that both agree (TODO #512, volet 3).
export type SeriesPlanMode =
  | 'sequential-here'
  | 'sequential-new-mission'
  | 'kanban-full'
  | 'kanban-code-self'
  | 'kanban-code-group';
export type SeriesPlanRole = 'orchestrator' | 'mission' | 'code' | 'review' | 'merge' | 'doc';
export type SeriesPlanGroupRole = 'code' | 'review' | 'merge' | 'doc';

// Moved from `series-plan.ts`, which re-exports it (TODO #512, volet 3).
/** What the UI sends back once the form is submitted. */
export type SeriesPlanAnswer = {
  mode: SeriesPlanMode;
  roles: Partial<Record<SeriesPlanRole, SeriesPlanRoleConfig>>;
  /** Settings per group of volets, keyed by the group names of the form sent.
   *  Resolution (volet 2): task override > group > series role > project role. */
  groups?: Record<string, SeriesPlanGroupConfig>;
  /** Free text typed below the form. It may qualify or contradict the
   *  choices: the agent must read it. */
  note?: string;
  /** The job's branch. `{ kind: 'new', name }` cuts a new branch (from the
   *  remote's target in a project that lands through pull requests, from the
   *  project's local target otherwise); `{ kind: 'existing', name }` starts the
   *  job from a branch the repository already has. A bare string is the
   *  earlier form: a new branch, read only in a project that lands through pull
   *  requests. The daemon checks it again and may number a new one (`-2`).
   *  Absent: the job lands as it did before the field existed. */
  branch?: string | SeriesPlanBranch;
  /** What happens once the job's work is in its branch: `merge` (default)
   *  merges it into the target, through the pull request in a project that
   *  lands through one; `keep` leaves it on the branch, its ideas partial
   *  until the branch lands. */
  finish?: SeriesPlanFinish;
  /** For a project that lands through pull requests: the job resolves its
   *  ideas' issues entirely, so its pull request closes them (`Fixes`) even
   *  when an idea is carried by several jobs. Absent = not said. */
  resolves_issues?: boolean;
};

/** The branch a planned job works on (`SeriesPlanAnswer.branch`). */
export type SeriesPlanBranch = { kind: 'new' | 'existing'; name: string };
/** Where a planned job's branch ends up (`SeriesPlanAnswer.finish`). */
export type SeriesPlanFinish = 'merge' | 'keep';

/** Settings of a group of volets: per role, the same fields as a global row.
 *  Absent = the role's global setting (then the project role) applies. */
export type SeriesPlanGroupConfig = Partial<Record<SeriesPlanGroupRole, SeriesPlanRoleConfig>>;

/** Setting of one row. Every field is optional: absent = inherit
 *  (project role for the model, Timon's global fallback for the fallback).
 *  Present = valid for THIS series only. */
export type SeriesPlanRoleConfig = {
  backend?: string;
  model?: string;
  fallbackBackend?: string;
  fallbackModel?: string;
};

/** Who carries an option out when it is an action: the agent that asks, or the user. */
export type PluginQuestionOptionActor = 'agent' | 'user';

export type PluginQuestionOption = Readonly<{
  label: string;
  description: string | null;
  /** `null` when the option is not an action, or the agent did not say. */
  actor: PluginQuestionOptionActor | null;
}>;

export type PluginQuestionItem = Readonly<{
  /** The text of the question. It is also the key of its answer. */
  question: string;
  header: string | null;
  /** Empty for a free-text question. Every question also takes free text (cf. `PluginQuestionAnswerValue`). */
  options: readonly PluginQuestionOption[];
  multiSelect: boolean;
  placeholder: string | null;
}>;

/** The Kanban planner an agent opens with `kanban_plan`. `group` is the volet's
 *  group name when the agent proposed one (model settings per group), else `null`. */
export type PluginQuestionPlan = Readonly<{
  title: string;
  volets: ReadonlyArray<Readonly<{ title: string; description: string | null; group: string | null }>>;
}>;

export type PluginQuestion = Readonly<{
  id: string;
  missionId: string;
  agent: string;
  kind: 'question' | 'series_plan';
  /** The form's questions; empty for a `series_plan`. */
  questions: readonly PluginQuestionItem[];
  /** The planner's context; `null` for a plain `question`. */
  plan: PluginQuestionPlan | null;
  createdAt: number;
  /** When an unattended mission refuses the card by itself; `null` = it waits. */
  expiresAt: number | null;
}>;

/**
 * The answer to one question: a label (or any text), the labels of a
 * multi-select, or the pick and the free text typed beside it — `{ text }`
 * alone when nothing is ticked, `choices` on a multi-select.
 */
export type PluginQuestionAnswerValue =
  | string
  | readonly string[]
  | Readonly<{ choice?: string; choices?: readonly string[]; text: string }>;

/** What a plugin answers. `answers` is keyed by the text of each question. */
export type PluginQuestionAnswer =
  | Readonly<{
    answers: Readonly<Record<string, PluginQuestionAnswerValue>>;
    /** @deprecated The form has no global note any more: put the text in the answer of its question. Still relayed to the agent. */
    note?: string;
  }>
  | Readonly<{ plan: SeriesPlanAnswer }>
  | Readonly<{ cancel: true }>;

export type PluginQuestionResolution = Readonly<{ id: string; status: 'answered' | 'cancelled' }>;

export type PluginQuestionListFilter = {
  kinds?: ReadonlyArray<'question' | 'series_plan'>;
  /** Project slug of the agent that asks. */
  project?: string;
  limit?: number;
};

export type PluginQuestionErrorCode = 'invalid' | 'not_found';

export type PluginQuestionEventKind = 'question_pending' | 'question_resolved';

/** Who: `agent` (name), `user` (account id when known), `plugin` (plugin id), `system`, `unknown`. */
export type PluginQuestionActor = Readonly<{ kind: string; id: string | null }>;

export type PluginQuestionPendingEvent = Readonly<{
  kind: 'question_pending';
  questionId: string;
  question: PluginQuestion;
  /** Who caused the event: the agent that asked. */
  origin: PluginQuestionActor;
}>;

export type PluginQuestionResolvedEvent = Readonly<{
  kind: 'question_resolved';
  questionId: string;
  /** `answered`, `cancelled` (denied or closed) or `expired` (no answer in time, mission over, nobody waits any more). */
  status: 'answered' | 'cancelled' | 'expired';
  question: PluginQuestion;
  /** Who caused the event: the user or plugin that answered, or `system` for an expiry. */
  origin: PluginQuestionActor;
  /** The action behind the decision (`ui_form_submit`, `plugin`, `auto_timeout`, `mission_end`…). */
  decisionOrigin: string;
}>;

export type PluginQuestionEvent = PluginQuestionPendingEvent | PluginQuestionResolvedEvent;

export type PluginQuestionEventMap = {
  question_pending: PluginQuestionPendingEvent;
  question_resolved: PluginQuestionResolvedEvent;
};

export type PluginQuestionEventHandler = (ev: PluginQuestionEvent) => void | Promise<void>;
