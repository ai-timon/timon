/**
 * The `PluginContext` type — everything a plugin can do through the daemon.
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */
import type { PluginAccountUser, PluginBackendAccount } from './accounts.js';
import type {
  PluginAgentDoc, PluginAgentEventKind, PluginAgentEventMap, PluginAgent, PluginAgentAvatar, PluginAgentDeleteOptions,
  PluginAgentExport, PluginTeam, PluginTeamInput,
  PluginAgentInput, PluginAgentPatch,
} from './agents.js';
import type {
  PluginAutomationEventKind, PluginAutomationEventMap, PluginOwnPipeline, PluginPipeline,
  PluginPipelineInput, PluginPipelineRun, PluginPipelineRunStatus, PluginRoutine, PluginRoutineInput,
  PluginRoutinePatch, PluginOwnTrigger, PluginTriggerCreated, PluginTriggerInfo, PluginTriggerInput,
  PluginTriggerTestOptions, PluginTriggerTestResult, PluginWorkflow, PluginWorkflowDetail,
  PluginWorkflowRun, PluginWorkflowRunStatus,
} from './automation.js';
import type { PluginBackendCatalog } from './backends.js';
import type { PluginBackupStatus } from './backup.js';
import type {
  PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEventMap, PluginBrowserAnnotation,
  PluginBrowserAnnotationDetail, PluginBrowserAnnotationFilter, PluginBrowserAnnotationRef,
  PluginBrowserAnnotationResolution,
} from './browser-annotations.js';
import type {
  PluginBrowserRecordingEventKind, PluginBrowserRecordingEventMap, PluginBrowserRecording,
  PluginBrowserRecordingDetail, PluginBrowserRecordingOp, PluginBrowserRecordingRef,
} from './browser-recordings.js';
import type { PluginBrowserSession } from './browser.js';
import type { PluginUser, PluginExecResult, PluginLog, PluginSettingValue, PluginSqlDatabase, PluginStorage } from './core.js';
import type { PluginAccountProvider, PluginPermissionSource } from './accounts.js';
import type { PluginDocHit } from './docs.js';
import type { PluginEdition } from './edition.js';
import type {
  PluginAsyncEffectHandle, PluginEffect, PluginEffectHandle, PluginSyncEffect,
} from './effects.js';
import type { PluginEventKind } from './events.js';
import type {
  PluginForgeChecks, PluginForgeIssue, PluginForgeIssueDetails, PluginForgeProposal, PluginForgeProposalInput,
  PluginForgeProposeResult, PluginForgePull, PluginForgePullDetails, PluginForgeRepository,
} from './forge.js';
import type { Router } from './http.js';
import type { ScopedChat, ScopedLayout } from './layout.js';
import type {
  PluginMcpServers, PluginMessages, PluginNotifications, PluginOutbox, PluginQuestions, PluginSkills,
  PluginUiDocuments,
} from './facades.js';
import type {
  PluginBusinessEvents, PluginConnections, PluginTransports, PluginWorkflows,
} from './integration.js';
import type {
  PluginMemoryEventKind, PluginMemoryEventMap, PluginMemoryFile, PluginMemoryFileInfo,
  PluginMemoryOverview, PluginMemoryRule, PluginMemoryRuleFilter, PluginMemoryRuleInput,
  PluginMemorySearchResult, PluginMemoryTargetScope,
} from './memory.js';
import type {
  PluginMissionEventKind, PluginMissionEventMap, PluginMissionFork, PluginMissionForkInput,
  PluginMissionSearchFilter, PluginMissionSearchResult, PluginMissionSendResult, PluginMissionSummary,
  PluginStopReport, PluginStopScope, PluginTraceOptions, PluginMcpToken, PluginMcpTokenInput,
  PluginMissionInput,
} from './missions.js';
import type { PluginModuleInfo } from './modules.js';
import type { PluginPermission } from './permissions.js';
import type { PluginInfo } from './plugins.js';
import type { Dialect, ProviderServices, RegisteredProfile, RemoteDialect, UsageProbeOptions } from './provider-kit.js';
import type {
  PluginProjectEventKind, PluginProjectEventMap, PluginProject, PluginProjectInput, PluginProjectPatch,
  PluginProjectRoles, PluginProjectWrite, PluginRoleInput, PluginWorkspace,
} from './projects.js';
import type { PluginQuestionEventKind, PluginQuestionEventMap } from './questions.js';
import type { PluginRealtime } from './realtime.js';
import type { PluginSecrets } from './secrets.js';
import type {
  PluginSeriesFallbackInput, PluginSeriesFallbackResult, PluginSeriesRoleInput, PluginSeriesRule,
} from './series.js';
import type { PluginDoctorReport, PluginLogsOptions, PluginSystemHealth } from './system.js';
import type {
  PluginTaskEventKind, PluginTaskEventMap, PluginTask, PluginTaskDoneInput, PluginTaskFilter,
  PluginTaskInput, PluginTaskLink, PluginTaskLinkInput, PluginTaskPatch,
} from './tasks.js';
import type { PluginTodoEventKind, PluginTodoEventMap, PluginTodos } from './todos.js';
import type { PluginUiDocumentEventKind, PluginUiDocumentEventMap } from './ui-documents.js';
import type { UsageCollector, UsageEntry } from './usage.js';
import type { PluginWebhookHandler, PluginWebhookOwnerRun } from './webhooks.js';
import type { PluginWorktree } from './worktrees.js';

export type PluginContext = {
  realtime: PluginRealtime;
  /** Versioned business events; the internal event bus remains read-only. */
  businessEvents: PluginBusinessEvents;
  /**
   * Workflows. `registerTrigger` / `registerExecutor` (API 3) extend the nodes
   * a workflow can use. From API 10: `workflows:read` lists and reads the
   * workflows and runs the caller can see (`list`, `get`, `status`);
   * `workflows:run` starts a published workflow and cancels a run (`run`,
   * `cancel`), and in a request the caller's account must hold `workflows:run`
   * too. A plugin never creates, edits or publishes a workflow. Bounded like
   * `missions.list`: a job sees the workflows owned by `plugin:<id>` (none
   * today). A run with nobody in front (an event handler, a webhook delivery)
   * takes the operator's `pluginPolicy.spawn` approval and quota, shared with
   * `missions.spawn`; refused, `code: 'forbidden'` and nothing runs. Errors
   * carry a `code` (`PluginAutomationErrorCode`).
   */
  workflows: PluginWorkflows & {
    list(): Promise<PluginWorkflow[]>;
    get(workflowId: string): Promise<PluginWorkflowDetail | undefined>;
    /** Runs the PUBLISHED version; the run belongs to the caller. */
    run(workflowId: string, input?: unknown): Promise<PluginWorkflowRun>;
    status(runId: string): Promise<PluginWorkflowRunStatus | undefined>;
    /** `true` when the run was live and is now cancelled. */
    cancel(runId: string): Promise<boolean>;
  };
  transports: PluginTransports;
  connections: PluginConnections;
  readonly id: string;
  readonly version: string;
  readonly log: PluginLog;
  /** Permissions declared and validated by the manifest. */
  readonly permissions: readonly PluginPermission[];
  /** Plugin options from `timon.config.json → plugins[<id>]`. */
  readonly config: Record<string, unknown>;
  /** Throws `PluginPermissionError` if the permission is not declared. */
  assert(permission: PluginPermission): void;
  /**
   * Protect a plugin-owned action. A `PluginPermission` must be in the
   * manifesto (same throw as `assert`). The current caller must then be
   * allowed that string by the M.2 evaluator (`page:/acme`, `plugin:<id>`,
   * `users:read`, …). No request (job) is the system identity: empty grants,
   * deny by default. First-run anonymous requests stay unrestricted.
   */
  assertPermission(permission: string): void;
  /** True when the permission is declared, for adaptive plugins. */
  can(permission: PluginPermission): boolean;
  /**
   * Caller of the current `ctx.router()` request. `undefined` outside a
   * request (plugin job, `ctx.effect`) — there is no user account to name.
   */
  user(): PluginUser | undefined;
  /** Router mounted on `/api/plugins/<id>/`, removed on unload. */
  router(prefix?: string): Router;
  /** Cordis effect, with the same forms as the kernel: returned functions are
   *  called during unload in reverse registration order and awaited when
   *  async. A body returning nothing is valid. */
  effect(fn: () => PluginSyncEffect | void): PluginEffectHandle;
  effect(fn: () => PluginEffect | void): PluginAsyncEffectHandle;
  storage: PluginStorage;
  /** API 15 — adds accounts and opens their sessions. Requires the sensitive `accounts:provision`; signed plugins only. */
  accountProvider: PluginAccountProvider;
  /** API 15 — answers which rights an account holds. Requires the sensitive `accounts:permissions-source`; signed plugins only. */
  permissionSource: PluginPermissionSource;
  /**
   * The plugin's own SQLite database (API 15). Requires `storage:sql`. Named
   * `sql`, never `db`: no member of the surface may read as the daemon's database.
   */
  sql: PluginSqlDatabase;
  settings: { get(key: string): PluginSettingValue };
  /** Vault entries granted to this plugin (§9.4). Requires `secrets:read`. */
  secrets: PluginSecrets;
  /**
   * Missions. `spawn` / `get` / `list` since API 1 (`missions:spawn` /
   * `missions:read`). API 10 adds control of an existing mission,
   * `missions:control`: `send`, `kill`, `fork`, `stopScope`; and reading what
   * was said, `missions:transcript`: `search`, `summarize`. Everything is
   * bounded by the caller like `list`: in a request, the missions of that
   * account (and the right on that account); in a job, the missions owned by
   * `plugin:<id>`. A mission outside that view answers `not_found`. `send`,
   * `fork` and `summarize` consume the machine's AI subscription and so go
   * through `pluginPolicy.spawn` (approval, quota) like `spawn`. Errors carry a
   * `code` (`PluginMissionErrorCode`).
   *
   * `spawn` also takes `model`, `backend`, `extraSkills`, `extraMcp`, `allow`
   * (API 10): without `agents:privileged-config` on the calling account (a job
   * never has it) they may only restate what the agent already declares.
   */
  missions: {
    spawn(input: PluginMissionInput): Promise<string>;
    get(id: string): Promise<unknown>;
    list(opts?: { limit?: number; agents?: string[]; status?: string }): Promise<unknown[]>;
    /** Follow-up turn on a mission, as `plugin:<id>` (the chat shows who spoke). A dead process is resumed in place. */
    send(missionId: string, text: string): Promise<PluginMissionSendResult>;
    /** Terminates a running mission. */
    kill(missionId: string): Promise<{ outcome: 'killed' | 'closed' }>;
    /** Compressed transcript, `missions:transcript`. */
    summarize(missionId: string, opts?: { force?: boolean }): Promise<PluginMissionSummary>;
    /** Continuation on another agent, seeded with the summary. The summary comes back with `missions:transcript` only. */
    fork(missionId: string, input: PluginMissionForkInput): Promise<PluginMissionFork>;
    /** Renames a mission by hand (`manual`, which no automatic title overwrites); `null` clears it. `missions:control`. */
    rename(missionId: string, title: string | null): Promise<{ title: string | null }>;
    /** Full-text search over the caller's mission history, `missions:transcript`. */
    search(q: string, filter?: PluginMissionSearchFilter): Promise<PluginMissionSearchResult>;
    /** Technical stop of ONE agent or ONE project: kills its running missions, settles its requests, blocks its open tasks, switches off its triggers. A non-superadmin stops its own rows only. */
    stopScope(scope: PluginStopScope): Promise<PluginStopReport>;
  };
  /**
   * Causal traces (API 10), `missions:read`. `get` takes a trace id or a mission
   * id and returns the missions, tasks, messages, spans and sums the caller may
   * see, or `undefined`. Span payloads (tool inputs and outputs) need
   * `missions:transcript` and `payload: true`.
   */
  traces: {
    get(id: string, opts?: PluginTraceOptions): Promise<unknown | undefined>;
  };
  /**
   * The board's tasks, `kanban:read` / `kanban:write` (`kanban:delete` for
   * `delete`, `kanban:read:project` for a job's granted projects — see
   * `docs/PLUGINS.md`). Bounded by the caller like `missions.list`: in a
   * request, what that user sees and writes; in a job, the tasks this plugin
   * created, plus — read only — the projects the operator granted it in
   * `pluginPolicy.kanban.projects`. A task outside that view answers as one that
   * does not exist. Errors of the input carry a `code` (`PluginTaskErrorCode`).
   *
   * A task with `mirror: true` is the inert image of a ticket in another system:
   * never dispatched, its closure starts nothing. Every write carries
   * `origin: { kind: 'plugin', id }` on the events it causes
   * (`task_created`, `task_updated`, `task_assigned`, `task_deleted`,
   * `task_unblocked` via `ctx.events.on`), so a sync drops its own echo.
   */
  kanban: {
    add(task: PluginTaskInput): Promise<PluginTask>;
    update(id: string, patch: PluginTaskPatch): Promise<PluginTask>;
    list(filter?: PluginTaskFilter): Promise<PluginTask[]>;
    /** One task; `undefined` when unknown or outside the caller's view. */
    get(id: string): Promise<PluginTask | undefined>;
    /** Creates the task unless one of `links` is already tied to a task the
     *  caller sees: that one is returned with `created: false`. Tied to a task
     *  it cannot see, `conflict`. The task and its links land in one transaction. */
    ensure(task: PluginTaskInput, links: readonly PluginTaskLinkInput[]): Promise<{ task: PluginTask; created: boolean }>;
    /** Closes the task as done. `comment` is required. */
    done(id: string, input: PluginTaskDoneInput): Promise<PluginTask>;
    /** Closes the task as blocked. `reason` is required. */
    block(id: string, reason: string): Promise<PluginTask>;
    /** `kanban:delete`. Refused (`conflict`, `reason: 'task_state'` | `'task_dependents'` | …)
     *  while the task runs, has dependents, a worktree or a pipeline step.
     *  `chain` deletes the verification chain it heads; returns every id deleted. */
    delete(id: string, opts?: { chain?: boolean }): Promise<{ deleted: string[] }>;
    /** Where a task lives outside Timon; one `(provider, ref)` points at one task. */
    refs: {
      list(taskId: string): Promise<PluginTaskLink[]>;
      /** Ties the task to a ticket, or refreshes url/label of that tie. */
      set(taskId: string, link: PluginTaskLinkInput): Promise<PluginTaskLink>;
      remove(taskId: string, provider: string, ref: string): Promise<boolean>;
      /** The task a ticket points at, `undefined` when none or not visible. */
      findByRef(provider: string, ref: string): Promise<PluginTask | undefined>;
    };
    /**
     * The TO DO notebook, `todos:read` / `todos:write` — separate from the
     * task permissions, because a task spawns an agent and an idea does not.
     * Bounded by the caller like `missions.list`: in a request, what that user
     * sees; in a job, the ideas this plugin created. An idea outside that view
     * answers as one that does not exist. Errors carry a `code`
     * (`PluginTodoErrorCode`).
     */
    todos: PluginTodos;
  };
  /**
   * Retire the hand-made triggers this plugin supersedes, `triggers:disable`.
   * Lists what the caller may see (no secret, no action body) and switches a
   * trigger OFF — never edits, deletes or re-enables. A trigger the caller
   * cannot see answers like one that does not exist; a job sees none.
   */
  triggers: {
    list(): Promise<PluginTriggerInfo[]>;
    /** `true` when the trigger was enabled and is now disabled. */
    disable(triggerId: string): Promise<boolean>;
    /** `triggers:read` (API 10). A trigger this plugin owns comes with its definition, never a secret. */
    get(triggerId: string): Promise<PluginTriggerInfo | PluginOwnTrigger | undefined>;
    /**
     * `triggers:write` (API 10). The trigger belongs to this plugin (owner
     * `plugin:<id>`); its actions are capped by the manifest, a `webhook`
     * action by `pluginPolicy.http`, and an unauthenticated webhook is refused.
     * An enabled trigger with a `task` action is refused until the plugin is
     * approved to spawn (signed and declaring `missions:spawn`, or listed in
     * `pluginPolicy.spawn.approved`), and each task it opens takes the spawn
     * quota shared with `missions.spawn`.
     * The secrets are in this reply only. Errors carry a `code`
     * (`PluginAutomationErrorCode`).
     */
    create(input: PluginTriggerInput): Promise<PluginTriggerCreated>;
    /** `triggers:write`: deletes a trigger this plugin owns; `false` for one it cannot see. */
    remove(triggerId: string): Promise<boolean>;
    /** `triggers:read` for a dry run (the default), `triggers:execute` with `execute: true`. Own triggers only. */
    test(triggerId: string, options?: PluginTriggerTestOptions): Promise<PluginTriggerTestResult>;
  };
  /**
   * Recurring work, `routines:read` / `routines:write` (API 10): a cron
   * expression, an agent, a prompt — one Kanban task per tick. The routine
   * belongs to this plugin (owner `plugin:<id>`) and so do its tasks; `update`
   * and `delete` reach only the routines this plugin created. `create` and
   * `update` also need `kanban:write` (the manifest, and the caller's account
   * in a request), never run more often than every five minutes, and fail with
   * a `PluginAutomationError` carrying a `code`. A routine ticks with nobody in
   * front: creating or enabling one is `forbidden` until the plugin is approved
   * to spawn (signed and declaring `missions:spawn`, or listed in
   * `pluginPolicy.spawn.approved`), and each tick takes the spawn quota shared
   * with `missions.spawn` (over it, the tick is skipped).
   */
  routines: {
    list(): Promise<PluginRoutine[]>;
    create(input: PluginRoutineInput): Promise<PluginRoutine>;
    update(routineId: string, patch: PluginRoutinePatch): Promise<PluginRoutine>;
    /** `false` for a routine the plugin cannot see. */
    delete(routineId: string): Promise<boolean>;
  };
  /**
   * Multi-agent templates, `pipelines:read` / `pipelines:write` / `pipelines:run`
   * (API 10): steps wired by `deps_on`; a run opens one Kanban task per step.
   * A pipeline belongs to this plugin (owner `plugin:<id>`): `delete` reaches
   * only its own, and of another's `get` shows a summary without prompts. A
   * step cannot carry skills, MCP servers, tools or a model/permission
   * override. `run` also needs `kanban:write` (the manifest, and the caller's
   * account in a request); its tasks belong to the caller, or to `plugin:<id>`
   * in a job, and `runStatus` reads only those runs. A run with nobody in front
   * (a job, an event handler, a webhook delivery) takes the operator's
   * `pluginPolicy.spawn` approval and one unit of quota per step, all or nothing:
   * refused, `code: 'forbidden'` and no step opens. Errors carry a `code`
   * (`PluginAutomationErrorCode`).
   */
  pipelines: {
    list(): Promise<Array<PluginPipeline | PluginOwnPipeline>>;
    get(pipelineId: string): Promise<PluginPipeline | PluginOwnPipeline | undefined>;
    create(input: PluginPipelineInput): Promise<PluginOwnPipeline>;
    /** `false` for a pipeline the plugin cannot see. */
    delete(pipelineId: string): Promise<boolean>;
    run(pipelineId: string, input?: Record<string, unknown>): Promise<PluginPipelineRun>;
    /** `undefined` for a run the caller could not have started. */
    runStatus(runId: string): Promise<PluginPipelineRunStatus | undefined>;
  };
  /**
   * Timon agents, `agents:read` (list) / `agents:manage` (list, create,
   * update). In a request the caller needs the same right on his account; an
   * anonymous request is refused. A job acts as `plugin:<id>`: it lists and
   * updates only the agents this plugin created. `list` gives identity only
   * (no directory, prompt, tools or MCP servers); `update` reaches only the
   * agents this plugin created, unless the caller is a superadmin. Errors of
   * the input carry a `code` (`PluginAgentErrorCode`).
   */
  agents: {
    list(): Promise<PluginAgent[]>;
    create(input: PluginAgentInput): Promise<PluginAgent>;
    update(name: string, patch: PluginAgentPatch): Promise<PluginAgent>;
    /**
     * API 10, `agents:manage`, and like `update` only the agents this plugin
     * created (superadmin caller aside). The main orchestrator is never removed
     * (`conflict`); a name taken is a `conflict` on `rename`, whose new name
     * follows the rules of `create`. `memoryScope` is a field of `update`.
     * The agent goes to the agent trash when it is on; `{ purge: true }`
     * (API 15) removes it for good, and only an agent this plugin created
     * (`forbidden` otherwise, a superadmin caller included).
     */
    delete(name: string, options?: PluginAgentDeleteOptions): Promise<boolean>;
    rename(name: string, newName: string): Promise<PluginAgent>;
    /** The picture's URL, or `null` once removed. */
    setAvatar(name: string, avatar: PluginAgentAvatar): Promise<string | null>;
    /**
     * The portable definition of an agent (API 15, `agents:export` —
     * sensitive): its prompt, identity documents, settings, skills, MCP
     * servers, team, picture and routines, to recreate it on another Timon.
     * Any agent the caller's account may read (`agents:read` or
     * `agents:manage`), not only this plugin's; a job is refused, so an
     * export always has an account behind it. Never a secret, token, log,
     * transcript or memory file. `not_found` for an unknown or ephemeral agent.
     */
    export(name: string): Promise<PluginAgentExport>;
    /**
     * Teams of bots (API 15): `list` with `agents:read`, `create` and
     * `delete` with `agents:manage`. A request sees the teams of the caller's
     * account (all for a superadmin); a job only the teams no account owns. An
     * agent joins one through the `team` field of `create` / `update`.
     * `delete` answers `false` for a team the caller does not see; its members
     * are put back outside any team, and a team holding an agent this plugin
     * did not create is `forbidden` (superadmin caller aside).
     */
    teams: {
      list(): Promise<PluginTeam[]>;
      create(input: PluginTeamInput): Promise<PluginTeam>;
      delete(teamId: string): Promise<boolean>;
    };
    /**
     * Identity documents (`SOUL.md`, any `*.md` at the agent's root), API 10,
     * `agents:docs:read` / `agents:docs:write` — sensitive: they are the
     * agent's instructions. Only the agents this plugin created, even for a
     * request (superadmin caller aside).
     */
    docs: {
      list(agent: string): Promise<PluginAgentDoc[]>;
      get(agent: string, file: string): Promise<string | null>;
      put(agent: string, file: string, content: string): Promise<PluginAgentDoc>;
      rm(agent: string, file: string): Promise<boolean>;
    };
  };
  /**
   * Timon's memory (API 10), `memory:read` (search, overview, list, show) /
   * `memory:write` (add, rm). In a request the caller needs the matching right
   * on his account — `agents:read` or `agents:manage` to read, `agents:manage`
   * to write; an anonymous request is refused. A job acts as `plugin:<id>` and
   * sees only what this plugin wrote: its rules, and the memory files of the
   * agents it created. A rule written here carries `source: 'plugin:<id>'`;
   * `rules.rm` removes only such rules, unless the caller is a superadmin.
   * `scope: 'global'` and `tier: 'core'` need a superadmin caller. Errors carry
   * a `code` (`PluginMemoryErrorCode`).
   */
  memory: {
    rules: {
      add(input: PluginMemoryRuleInput): Promise<PluginMemoryRule>;
      list(filter?: PluginMemoryRuleFilter): Promise<PluginMemoryRule[]>;
      rm(id: number): Promise<PluginMemoryRule>;
    };
    search(query: string): Promise<PluginMemorySearchResult>;
    overview(): Promise<PluginMemoryOverview>;
    /** The memory files of an agent or a project; with `file`, its content. */
    show(scope: PluginMemoryTargetScope, id: string): Promise<PluginMemoryFileInfo[]>;
    show(scope: PluginMemoryTargetScope, id: string, file: string): Promise<PluginMemoryFile>;
  };
  /**
   * Projects and their poles, `projects:read` (list, get, workspaces, roles) /
   * `projects:manage` (create, update, setRole; sensitive) — API 10. Reading is
   * open to every authenticated caller, as the project list is; the working
   * directory is shown only with `projects:manage`. A plugin edits (metadata,
   * role pins) only the projects it registered, unless the caller is a
   * superadmin; a path the daemon cannot use is refused for anyone else. A
   * pole named in a write must exist unless `createWorkspace` is passed.
   * Errors carry a `code` (`PluginProjectErrorCode`). Writes emit
   * `project_created` / `project_updated`.
   */
  projects: {
    list(): Promise<PluginProject[]>;
    get(slug: string): Promise<PluginProject | undefined>;
    create(input: PluginProjectInput): Promise<PluginProjectWrite>;
    update(slug: string, patch: PluginProjectPatch): Promise<PluginProjectWrite>;
    workspaces(): Promise<PluginWorkspace[]>;
    /** Which agent holds each task role on a project. */
    roles(slug: string): Promise<PluginProjectRoles>;
    /** Pins the agent (and optional backend / model / permission mode) of a role; `null` clears the pin. */
    setRole(slug: string, role: string, spec: PluginRoleInput | null): Promise<PluginProjectRoles>;
  };
  /**
   * The fallback plan and the per-role LLM choices of a task series,
   * `series:read` / `series:manage` (sensitive) — API 10. A series is named by
   * its id or its pilot mission's; `current` does not exist for a plugin. It is
   * bounded like `ctx.kanban`: a request sees the series of the tasks and
   * missions its account sees, a job those of `plugin:<id>`; any other answers
   * `not_found`. A fallback rule is applied at once to the pending tasks unless
   * `apply: false`. Errors carry a `code` (`PluginSeriesErrorCode`).
   */
  series: {
    fallback: {
      list(seriesId: string): Promise<PluginSeriesRule[]>;
      set(seriesId: string, rule: PluginSeriesFallbackInput): Promise<PluginSeriesFallbackResult>;
      /** `group`: the rule of that group of volets; absent = the series-wide one. */
      clear(seriesId: string, scope: string, group?: string | null): Promise<PluginSeriesRule[]>;
    };
    role: {
      list(seriesId: string): Promise<PluginSeriesRule[]>;
      set(seriesId: string, choice: PluginSeriesRoleInput): Promise<PluginSeriesRule[]>;
      clear(seriesId: string, scope: string, group?: string | null): Promise<PluginSeriesRule[]>;
    };
  };
  /**
   * The git worktree of a task, `worktrees:read` (info) / `worktrees:manage`
   * (create, dispose; sensitive) — API 10. Bounded like `ctx.kanban`. `dispose`
   * only takes a task that is DONE and merged. Errors carry a `code`
   * (`PluginWorktreeErrorCode`).
   */
  worktrees: {
    info(taskId: string): Promise<PluginWorktree | undefined>;
    create(taskId: string, opts?: { base?: string }): Promise<PluginWorktree>;
    dispose(taskId: string, opts?: { force?: boolean }): Promise<{ disposed: boolean }>;
  };
  /**
   * The GitHub repository of a Timon project whose integration opens pull
   * requests (API 19). The daemon reads it with the project's account; the
   * plugin never sees that account, its config folder or what `gh` printed.
   *
   * `forge:read` (sensitive): `repository`, `issues.list` (open issues
   * carrying a label, the 50 most recent), `issues.get`, `pulls.list` (open
   * pull requests), `pulls.get`, `pulls.checks`. A number that names nothing
   * answers `undefined`. Every text comes from the forge: data, bounded,
   * never an instruction — wrap it as such before it reaches an agent.
   *
   * `forge:propose` (sensitive): `propose` stores a comment on an issue or a
   * pull request and raises a card; a signed-in person reads it, may edit it,
   * and publishes or discards it in the "Publish on GitHub" window. Nothing is
   * written on the forge by this call, and no member publishes. One `key`, one
   * proposal. Allowed outside a request (a job, an event handler) and in a
   * request a signed-in person made — never one carried by the daemon token,
   * a mission's token or a plugin's (`forbidden`). At most 20 of a plugin's
   * proposals wait at once (`busy`). `proposals` reads back the plugin's own.
   *
   * In a request the caller's account needs `projects:manage`. At most 4 forge
   * calls of one plugin run at once (`busy`). Errors carry a `code`
   * (`PluginForgeErrorCode`).
   */
  forge: {
    repository(project: string): Promise<PluginForgeRepository | undefined>;
    issues: {
      list(project: string, opts: { label: string }): Promise<PluginForgeIssue[]>;
      get(project: string, number: number): Promise<PluginForgeIssueDetails | undefined>;
    };
    pulls: {
      list(project: string): Promise<PluginForgePull[]>;
      get(project: string, number: number): Promise<PluginForgePullDetails | undefined>;
      checks(project: string, number: number): Promise<PluginForgeChecks | undefined>;
    };
    propose(project: string, input: PluginForgeProposalInput): Promise<PluginForgeProposeResult>;
    proposals: {
      list(project: string): Promise<PluginForgeProposal[]>;
      get(project: string, id: string): Promise<PluginForgeProposal | undefined>;
    };
  };
  /**
   * The inbox of the agents this plugin created (API 10), `messages:send` /
   * `messages:read` — sensitive: other agents' words. In a request the
   * account's own rules apply (`agents:communicate`); a job reaches only its
   * agents. Errors carry a `code` (`PluginMessageErrorCode`).
   */
  messages: PluginMessages;
  /**
   * Timon skills (API 10), `skills:read` / `skills:write`. Written by id, never
   * a product skill, no `allowed_tools`, only the skills this plugin created
   * (superadmin caller aside). Errors carry a `code` (`PluginSkillErrorCode`).
   */
  skills: PluginSkills;
  /**
   * MCP server declarations (API 10), `mcp-servers:read` / `mcp-servers:write`
   * — sensitive. `http` only unless a superadmin is the caller; only the
   * servers this plugin declared; secrets always read back masked. Errors carry
   * a `code` (`PluginMcpServerErrorCode`).
   */
  mcpServers: PluginMcpServers;
  /**
   * The screen of an account (API 10): read it with `layout:read`, ask its
   * owner to change it with `layout:propose`, save a preset with
   * `layout:presets`. Same guards and same cards as the `widgets_*`,
   * `islands_*` and `nav_*` MCP tools: nothing is applied without the owner's
   * click on a card in a mission's conversation. The account is the one of
   * the REQUEST — a job has none and every call throws `no_owner` — and a
   * proposal names one of that account's own missions. The card shows
   * `plugin:<id>` as its author and the answer never goes to the mission's
   * agent: read it back with `proposals.get` / `proposals.list` (this plugin's
   * cards only). Errors carry a `code` (`PluginLayoutErrorCode`).
   */
  layout: Omit<ScopedLayout, 'navigate' | 'onboardingProfile'>;
  /**
   * What a plugin puts in a mission's conversation besides documents
   * (API 10): `showMedia` (`chat:media`) and `proposeCommand`
   * (`chat:command`, sensitive: the owner may paste it into their terminal).
   * Same identity rules as `layout`. Errors carry a `PluginLayoutErrorCode`.
   */
  chat: ScopedChat;
  /** The profile the account picked in the onboarding, `onboarding:read` (API 10). */
  onboarding: { profile: ScopedLayout['onboardingProfile'] };
  /**
   * Administration and system (API 10). Every permission below is SENSITIVE:
   * `timon plugin add` names them apart before the operator confirms. Errors
   * carry a `code` (`PluginAdminErrorCode`); a refused caller gets a
   * `PluginCallerError`, a missing permission a `PluginPermissionError`.
   *
   * `accounts:read` / `accounts:manage`: a superadmin's request only, a job is
   * refused. No credential ever comes back, no account is created or promoted.
   * Roles and groups are not the core's: the plugin that serves the accounts
   * (`ctx.accountProvider`, `ctx.permissionSource`) keeps them.
   */
  users: {
    list(): Promise<PluginAccountUser[]>;
    get(userId: string): Promise<PluginAccountUser | undefined>;
    setStatus(userId: string, status: 'active' | 'disabled'): Promise<PluginAccountUser>;
  };
  /** Who may use which subscription account (`timon backend-account`). */
  backendAccounts: {
    list(): Promise<PluginBackendAccount[]>;
    grant(accountId: string, userIds: string[]): Promise<PluginBackendAccount>;
    revoke(accountId: string, userIds: string[]): Promise<PluginBackendAccount>;
  };
  /**
   * `plugins:read` lists what is installed (a request sees what its account
   * may see, a job everything); `plugins:manage` switches. A bundled module
   * needs the `plugins:manage` right on the account, a third-party plugin a
   * superadmin; never a job, never the plugin itself. Install and removal stay
   * with the operator.
   */
  plugins: {
    list(): Promise<PluginInfo[]>;
    setEnabled(pluginId: string, enabled: boolean): Promise<boolean>;
  };
  /** `plugins:read`. The bundled modules and what the kernel does with each. */
  modules: { list(): Promise<PluginModuleInfo[]> };
  /**
   * `system:read` (health, doctor), `system:logs` (logs). Doctor and logs need
   * a superadmin's request; a job reads health and doctor, never the logs.
   * Logs are the daemon's or the desktop shell's (never the prompts log), with
   * vault values masked, newest first.
   */
  system: {
    health(): Promise<PluginSystemHealth>;
    doctor(): Promise<PluginDoctorReport>;
    logs(options?: PluginLogsOptions): Promise<string[]>;
  };
  /** `backup:read` / `backup:manage`. `status` and `enable` are a superadmin's request, or a job; there is no `disable`. */
  backup: {
    status(): Promise<PluginBackupStatus>;
    enable(): Promise<PluginBackupStatus>;
  };
  /**
   * `browser:read` / `browser:manage`. Bounded by the caller: a request sees
   * its account's sessions, a job the ones it started; another's answers like
   * a missing one. No debugging endpoint is ever returned.
   */
  browser: {
    list(): Promise<PluginBrowserSession[]>;
    status(project: string): Promise<PluginBrowserSession | undefined>;
    start(project: string): Promise<PluginBrowserSession>;
    stop(project: string): Promise<PluginBrowserSession | undefined>;
  };
  /**
   * `browser:recordings:read` / `browser:recordings:write` (API 13, both sensitive): the
   * recordings of the built-in browser (TODO #461). Inside the owner's request only — a job
   * reads nothing, another account's recording answers like a missing one. `patch` applies
   * review edits, destructive for masked values; `setRef` links one outside object.
   */
  browserRecordings: {
    list(filter?: { profileId?: string }): Promise<PluginBrowserRecording[]>;
    get(id: string): Promise<PluginBrowserRecordingDetail | undefined>;
    patch(id: string, ops: readonly PluginBrowserRecordingOp[]): Promise<PluginBrowserRecordingDetail>;
    delete(id: string): Promise<boolean>;
    setRef(id: string, ref: PluginBrowserRecordingRef | null): Promise<PluginBrowserRecording>;
    findByRef(provider: string, ref: string): Promise<PluginBrowserRecording | undefined>;
  };
  /**
   * `browser:annotations:read` / `browser:annotations:write` (API 13, both sensitive): the
   * annotations of the built-in browser (TODO #468). Inside the owner's request only — a job
   * reads nothing, another account's annotation answers like a missing one. `get` returns the
   * comment (the user's) and what the page said (untrusted); `resolve` closes one with a summary
   * or a reason; `setRef` links one outside object. Sending a batch to an agent stays the user's.
   */
  browserAnnotations: {
    list(filter?: PluginBrowserAnnotationFilter): Promise<PluginBrowserAnnotation[]>;
    get(id: string): Promise<PluginBrowserAnnotationDetail | undefined>;
    resolve(id: string, resolution: PluginBrowserAnnotationResolution): Promise<PluginBrowserAnnotation>;
    delete(id: string): Promise<boolean>;
    setRef(id: string, ref: PluginBrowserAnnotationRef | null): Promise<PluginBrowserAnnotation>;
    findByRef(provider: string, ref: string): Promise<PluginBrowserAnnotation | undefined>;
  };
  /** `docs:read`. The user documentation of this installed version, offline. */
  docs: {
    search(query: string, options?: { limit?: number }): Promise<PluginDocHit[]>;
    read(route: string, heading?: string): Promise<string>;
  };
  /** `license:read`. The edition and nothing else: licences are managed elsewhere. */
  license: { edition(): Promise<PluginEdition> };
  /**
   * Timon's MCP tools for an agent that runs elsewhere, `mcp:issue` (API 7).
   * A token is bound to ONE running mission and its agent, limited to the
   * listed tools, short-lived, revoked when the mission ends, and refused by
   * the REST API. The mission must be visible to the caller, or run on a
   * backend this plugin registered.
   */
  mcp: {
    issueToken(input: PluginMcpTokenInput): Promise<PluginMcpToken>;
    /** `true` when a token this plugin issued was live and is now revoked. */
    revokeToken(tokenId: string): Promise<boolean>;
  };
  notify: {
    report(title: string, body?: string): void;
    alert(title: string, body?: string, opts?: { urgent?: boolean }): void;
  };
  /**
   * The notification centre, `notifications:read` / `notifications:write`
   * (API 10). In a request, the caller's notifications (`notifications:read:all`
   * widens it for an account that holds it); in a job, the ones owned by
   * `plugin:<id>`. One outside that view answers as one that does not exist.
   * Raising a notification stays `ctx.notify`. Errors carry a `code`
   * (`PluginNotificationErrorCode`).
   */
  notifications: PluginNotifications;
  /**
   * The questions agents ask the human (`question`, `kanban_plan`) that wait for
   * an answer, across every project, `questions:read` / `questions:answer`
   * (API 10). Bounded by the missions the caller can read, like the
   * conversation: a card outside that view answers as one that does not exist.
   * `answer` is sensitive: it unblocks the agent on the user's behalf, and
   * answering a Kanban plan has the agent apply it. Tool-use approvals are not
   * questions and are not listed. Errors carry a `code` (`PluginQuestionErrorCode`);
   * the events are `question_pending` / `question_resolved` (`events:subscribe`
   * + `questions:read`).
   */
  questions: PluginQuestions;
  /**
   * Read-only events, `events:subscribe`. The task kinds (`task_created`,
   * `task_updated`, `task_assigned`, `task_deleted`, `task_unblocked`) also need
   * `kanban:read`: they carry the task, filtered by account like a read, with
   * the `origin` of the write; `task_updated` says what `changed` and what it
   * `previous`ly was, a status move included. `task_done` / `task_blocked` keep
   * their raw `{ taskId }` shape. The TO DO kinds (`todo_done`,
   * `todo_resolved`, `todo_deleted`) also need `todos:read`: they carry the
   * idea, filtered by account like a read, with the `origin` of the write.
   * The mission kinds (API 10) are filtered by the mission's owner the same
   * way: `mission_started` (with its `origin`), `turn_complete` and
   * `mission_title_changed` (title, its `source` rank, the `origin` of the
   * write) need `missions:read`; the transcript stream `event` (a complete row) and
   * `event_delta` (a live fragment) need `missions:transcript`.
   * Their handlers run one at a time per plugin, awaited, in event order.
   * `memory_rule_added` / `memory_rule_removed` (API 10) also need
   * `memory:read` and concern the rules THIS plugin wrote, whoever removes
   * them (`origin`); they run as the plugin itself.
   */
  events: {
    on<K extends PluginTaskEventKind>(kind: K, handler: (ev: PluginTaskEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginTodoEventKind>(kind: K, handler: (ev: PluginTodoEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginUiDocumentEventKind>(kind: K, handler: (ev: PluginUiDocumentEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginQuestionEventKind>(kind: K, handler: (ev: PluginQuestionEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginMissionEventKind>(kind: K, handler: (ev: PluginMissionEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginMemoryEventKind>(kind: K, handler: (ev: PluginMemoryEventMap[K]) => void | Promise<void>): () => void;
    on<K extends PluginProjectEventKind>(kind: K, handler: (ev: PluginProjectEventMap[K]) => void | Promise<void>): () => void;
    /** API 10: `agent_created`, `agent_updated`, `agent_deleted` also need `agents:read`; only the agents this plugin created. */
    on<K extends PluginAgentEventKind>(kind: K, handler: (ev: PluginAgentEventMap[K]) => void | Promise<void>): () => void;
    /**
     * Lifecycle of routines, triggers, pipelines and workflow runs (API 10),
     * each with its `origin` (`user`, `agent`, `plugin` or `system`): a write
     * this plugin made carries `{ kind: 'plugin', id: ctx.id }`. Needs
     * `events:subscribe` and a read permission of the entity (`routines:read`,
     * `triggers:read`, `pipelines:read`, `workflows:read`; the write/run ones
     * count). The final status of a workflow run is the `workflow_run` event.
     */
    on<K extends PluginAutomationEventKind>(kind: K, handler: (ev: PluginAutomationEventMap[K]) => void | Promise<void>): () => void;
    /**
     * API 13: `browser_recording_started|stopped|reviewed|learned|purged` also need
     * `browser:recordings:read`. Metadata only, never a step, with the `origin` of the write;
     * delivered inside the recording owner's identity.
     */
    on<K extends PluginBrowserRecordingEventKind>(kind: K, handler: (ev: PluginBrowserRecordingEventMap[K]) => void | Promise<void>): () => void;
    /**
     * API 13: `browser_annotation_created|updated|sent|resolved|dismissed|purged` also need
     * `browser:annotations:read`. Metadata only, never the comment nor the page, with the
     * `origin` of the write; delivered inside the annotation owner's identity.
     */
    on<K extends PluginBrowserAnnotationEventKind>(kind: K, handler: (ev: PluginBrowserAnnotationEventMap[K]) => void | Promise<void>): () => void;
    on(kind: PluginEventKind, handler: (ev: unknown) => void): () => void;
  };
  /** Durable, ordered, optionally signed outgoing calls. */
  outbox: PluginOutbox;
  /**
   * Incoming webhooks, `webhooks:receive`. `name` must be declared in the
   * manifest (`webhooks: [{ name, auth }]`, `auth` = a shipped signature
   * format: `standard`, `github`, `stripe`…); the host serves
   * `POST /api/plugins/hooks/<id>/<name>` and checks signature, time window,
   * replays and rate before the handler runs. A value the handler returns
   * becomes the JSON body of the 200 (API 8). The handler acts as the
   * account that generated the webhook's secret (`ctx.user()`), or as this
   * plugin's job; its TO DO writes carry `origin: { kind: 'plugin', id }`.
   * Resolving answers 2xx, throwing answers 5xx (the sender retries).
   */
  webhooks: {
    on(name: string, handler: PluginWebhookHandler): () => void;
    /**
     * API 15. Runs `fn` in the scope a delivery of `name` has (the account
     * that generated its secret, unattended, TO DO writes stamped with this
     * plugin's origin), without waiting for the service to call: a
     * connector's start-up migration reaches the ideas its deliveries made.
     * It sees nothing a delivery would not. Call it after `on(name)`, from
     * `apply`, a job or a timer; inside a request or a delivery it throws (a
     * user's route must not act as the webhook's owner). Nothing runs, and
     * `{ ran: false, reason }` comes back, while no secret is set or its
     * owner can no longer use the plugin.
     */
    asOwner<T>(name: string, fn: () => T | Promise<T>): Promise<PluginWebhookOwnerRun<T>>;
  };
  /** Present ONLY with `http:outbound` (§10.4): absence is the refusal. */
  readonly fetch?: typeof globalThis.fetch;
  host: { exec(bin: string, args?: readonly string[], opts?: { cwd?: string }): Promise<PluginExecResult> };
  /**
   * Quota of the LLM accounts this machine uses (§10.15). Inside a request,
   * the caller's subscription accounts are listed too, never another user's;
   * outside one (a job), none. `list`/`get` need
   * `usage:read`; supplying a probe needs `usage:collect`, a separate
   * permission because reporting numbers a user acts on is a different power
   * from reading them.
   *
   * `{ force: true }` is a person's explicit refresh (a ↻ button), never a
   * polling loop: the probes skip their cache, a cached failure included. The
   * daemon honours it at most once every few seconds per backend; past that
   * it serves the cache, as without the option.
   */
  usage: {
    list(options?: UsageProbeOptions): Promise<UsageEntry[]>;
    get(backend: string, options?: UsageProbeOptions): Promise<UsageEntry | null>;
    /** Probe for a backend the product cannot measure itself. Removed when the
     *  plugin unloads; refused when another plugin already covers it. */
    registerCollector(backend: string, collect: UsageCollector): () => void;
  };
  /**
   * LLM providers (§10.15), permission `backends:register`.
   *
   * `registerProfile` is the common case: another endpoint served by a CLI the
   * product already speaks (a profile, zero parsing). `registerDialect` is for
   * a genuinely different protocol. Either way the daemon keeps what makes it
   * the daemon: it spawns the process itself, the binary a plugin CHOOSES goes
   * through the `host:exec` allowlist, and everything is withdrawn when the
   * plugin unloads — a task aimed at a departed backend is then refused by
   * `isBackendName`, not dispatched into the void.
   *
   * Credentials: a plugin resolves them itself (`ctx.secrets`, `ctx.settings`)
   * inside a FUNCTION given as `env`, called at each mission launch — nothing
   * is captured at registration, so a rotated key or a short-lived token is
   * seen by the next mission. A plain record is for fixed non-secret values.
   * The daemon also calls that function OUTSIDE a launch, dropping the result,
   * to decide whether the profile is offered: while it throws, the backend is
   * inactive. Register unconditionally and throw when the key is missing.
   * `envFrom` / `requiredEnv` / vault references, which read the daemon's own
   * state, are not part of what a plugin may declare.
   *
   * A `RemoteDialect` (`transport: 'remote'`, API 7) spawns nothing: no binary,
   * so no allowlist to pass. Its driver reaches the agent with `ctx.fetch`,
   * under `http:outbound` and `pluginPolicy.http`, like any other plugin call.
   */
  backends: {
    registerProfile(profile: RegisteredProfile): () => void;
    registerDialect(id: string, dialect: Dialect | RemoteDialect): () => void;
    /**
     * The backends and models available right now (API 10, `backends:read`),
     * as `GET /api/backends/catalog` answers the caller: a request sees the
     * subscription accounts on its access list, a job none.
     */
    list(): Promise<PluginBackendCatalog>;
  };
  /**
   * What the daemon provides to a provider plugin so that it does not rebuild
   * it (API 12, `backends:register`): the runtime a provider is written with
   * (`ctx.provider.runtime`), and the services that need a privilege only the
   * daemon holds. A member throws for a plugin that declared an older
   * `apiVersion`. Cf. `docs/PROVIDERS-SDK.md` § 6 and `docs/SDK-COMPAT.md` § 34.
   */
  provider: ProviderServices;
  ui: {
    token(): string;
    /**
     * HTML documents in a mission's conversation (API 9), `ui-documents:read` /
     * `ui-documents:write`. Bounded like `missions.list`: in a request, that
     * account's missions; in a job, the missions owned by `plugin:<id>`. A
     * document outside that view answers as one that does not exist. What this
     * plugin creates carries `origin: { kind: 'plugin', id }`; the reply is
     * readable on this plugin's own documents only. Errors carry a `code`
     * (`PluginUiDocumentErrorCode`).
     */
    documents: PluginUiDocuments;
    /**
     * Asks the account of the request to go to a page (API 10), `layout:propose`:
     * a card in the named mission's conversation they follow, never a direct
     * move — a plugin's browser half keeps its own `navigate`.
     */
    navigate: ScopedLayout['navigate'];
  };
};
