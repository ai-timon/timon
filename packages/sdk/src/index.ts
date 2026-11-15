/**
 * Public host and browser contracts for Timon plugins.
 * @packageDocumentation
 * Declare the minimum API version in the package manifest. Host and client
 * contexts are distinct; import these contracts as types in plugin code.
 */
export {
  PLUGIN_API_VERSION,
  type PluginManifest,
  type PluginSetting,
  type PluginWebhookDecl,
  type PluginDictationDecl,
  type PluginDictationEngineDecl,
  type PluginMascotDecl,
  type PluginSecretDecl,
  type PluginHttpDecl,
  type PluginHttpHostDecl,
} from '../../../orchestrator/src/plugins/contract/manifest.js';
export type { PluginPermission } from '../../../orchestrator/src/plugins/contract/permissions.js';
/** A route error the webview translates: `res.status(404).json(apiError('not_found', 'not found'))` (client API 15). */
export {
  apiError,
  API_ERROR_CODE,
  type ApiErrorBody,
  type ApiErrorParams,
} from '../../../orchestrator/src/plugins/contract/api-error.js';

export type { PluginContext } from '../../../orchestrator/src/plugins/contract/context.js';
export type {
  PluginExecResult,
  PluginLog,
  PluginPolicyError,
  PluginSettingValue,
  PluginSqlDatabase,
  PluginSqlStatement,
  PluginStorage,
} from '../../../orchestrator/src/plugins/contract/core.js';
export type {
  PluginAsyncEffect,
  PluginAsyncEffectHandle,
  PluginDisposer,
  PluginEffect,
  PluginEffectHandle,
  PluginSyncEffect,
} from '../../../orchestrator/src/plugins/contract/effects.js';
export type { PluginEventKind } from '../../../orchestrator/src/plugins/contract/events.js';
export type { PluginMissionInput } from '../../../orchestrator/src/plugins/contract/missions.js';
export type { PluginSecrets } from '../../../orchestrator/src/plugins/contract/secrets.js';
export type {
  PluginTodo,
  PluginTodoErrorCode,
  PluginTodoInput,
  PluginTodoAttachment,
  PluginTodoAttachmentInput,
  PluginTodoLink,
  PluginTodoLinkInput,
  PluginTodoListFilter,
  PluginTodoPatch,
  PluginTodoPromoteInput,
  PluginTodos,
} from '../../../orchestrator/src/plugins/contract/todos.js';
export type {
  PluginTask, PluginTaskDoneInput, PluginTaskErrorCode, PluginTaskFilter, PluginTaskInput,
  PluginTaskLink, PluginTaskLinkInput, PluginTaskPatch,
} from '../../../orchestrator/src/plugins/contract/tasks.js';
export type { PluginUser } from '../../../orchestrator/src/plugins/contract/core.js';
export type { UsageCollector, UsageEntry } from '../../../orchestrator/src/plugins/contract/usage.js';

/**
 * Kanban sync contract, API 10 (`ctx.kanban.get/ensure/done/block/delete/refs`,
 * `ctx.events.on('task_created' | 'task_updated' | 'task_assigned' |
 * 'task_deleted' | 'task_unblocked')`): host half only, each event carrying the
 * `origin` of the write.
 */
export type {
  PluginTaskAssignedEvent, PluginTaskCreatedEvent, PluginTaskDeletedEvent, PluginTaskEvent,
  PluginTaskEventKind, PluginTaskEventMap, PluginTaskOrigin, PluginTaskUnblockedEvent,
  PluginTaskUpdatedEvent,
} from '../../../orchestrator/src/plugins/contract/tasks.js';

/**
 * TO DO connector contract, API 6: lifecycle events (`ctx.events.on`, host
 * half only), their `origin`, and the durable outbox (`ctx.outbox`).
 */
export type { PluginOutbox } from '../../../orchestrator/src/plugins/contract/facades.js';
export type {
  PluginOutboxEntry, PluginOutboxErrorCode, PluginOutboxMethod, PluginOutboxOptions, PluginOutboxTarget,
} from '../../../orchestrator/src/plugins/contract/outbox.js';
export type {
  PluginTodoDeletedEvent, PluginTodoDoneEvent, PluginTodoEvent, PluginTodoEventKind,
  PluginTodoEventLink, PluginTodoEventMap, PluginTodoOrigin, PluginTodoResolvedEvent,
} from '../../../orchestrator/src/plugins/contract/todos.js';

/**
 * Incoming webhooks, API 6 (`ctx.webhooks.on`, permission `webhooks:receive`):
 * the host verifies the signature, window and replays before the handler
 * runs. API 8: `webhooks[].auth` names a shipped format (`github`, `stripe`,
 * `slack`, `discord`…) and the handler may return its reply body.
 */
export type {
  PluginWebhookHandler, PluginWebhookRequest, PluginWebhookOwnerRun, PluginWebhookOwnerSkip,
} from '../../../orchestrator/src/plugins/contract/webhooks.js';

/**
 * Retiring the hand-made triggers a plugin supersedes, API 6
 * (`ctx.triggers`, permission `triggers:disable`): list, disable, nothing else.
 * API 10 adds `triggers:read` / `triggers:write` / `triggers:execute`: `get`,
 * `create`, `remove` and `test` on the triggers the plugin owns.
 */
export type {
  PluginOwnTrigger, PluginTriggerCreated, PluginTriggerInfo, PluginTriggerInput,
  PluginTriggerTestOptions, PluginTriggerTestResult,
} from '../../../orchestrator/src/plugins/contract/automation.js';

/**
 * Automations, API 10: routines (`routines:read` / `routines:write`),
 * pipelines (`pipelines:read` / `pipelines:write` / `pipelines:run`), workflow
 * runs (`workflows:read` / `workflows:run`), and the lifecycle events of all
 * four (`ctx.events.on`, with `events:subscribe` + a read permission), each with
 * its `origin`. What a plugin creates is owned by `plugin:<id>`. Errors carry a
 * `PluginAutomationErrorCode`.
 */
export type {
  PluginAutomationErrorCode, PluginAutomationEvent, PluginAutomationEventKind, PluginAutomationEventMap,
  PluginOwnPipeline, PluginPipeline, PluginPipelineEvent, PluginPipelineInput, PluginPipelineRun,
  PluginPipelineRunStartedEvent, PluginPipelineRunStatus, PluginPipelineStep, PluginRoutine,
  PluginRoutineEvent, PluginRoutineInput, PluginRoutinePatch, PluginTriggerEvent, PluginWorkflow,
  PluginWorkflowDetail, PluginWorkflowRun, PluginWorkflowRunEvent, PluginWorkflowRunStatus,
  PluginWorkflowRunSummary,
} from '../../../orchestrator/src/plugins/contract/automation.js';

/**
 * Timon agents, API 7 (`ctx.agents`, permissions `agents:read` /
 * `agents:manage`): identity on read, create without overwrite, update of the
 * agents this plugin created. Input errors carry a `PluginAgentErrorCode`.
 */
export type {
  PluginAgent, PluginAgentErrorCode, PluginAgentInput, PluginAgentPatch,
} from '../../../orchestrator/src/plugins/contract/agents.js';

/**
 * An agent's mascot look (API 15): `PluginAgent.look` on read, `look` on
 * `create` / `update` (`null` clears it). The product's lists, plus the parts
 * the mascot packs installed and enabled declare (`PluginMascotPartId`,
 * `<pluginId>:<part>`); any other value is refused with `invalid`. With it, the head
 * the agent shows (`avatar`: emoji, image or mascot, `null` = not picked).
 */
export type {
  PluginAgentLook, PluginAgentLookAccessory, PluginAgentLookColor, PluginAgentLookCustomColor, PluginAgentLookEyes,
  PluginAgentLookInput, PluginAgentLookShape, PluginAgentAvatarMode, PluginMascotPartId,
} from '../../../orchestrator/src/plugins/contract/agents.js';

/**
 * Agents, messages, skills, MCP servers and the backend catalogue, API 10.
 *
 * `ctx.agents.delete / rename / setAvatar / docs.*` (with `memoryScope` on
 * `update`) reach only the agents the plugin created; the docs need
 * `agents:docs:read` / `agents:docs:write`. `ctx.messages` is the inbox of those
 * agents (`messages:send` / `messages:read`), `ctx.skills` the Timon skills
 * (`skills:read` / `skills:write`, never a product skill), `ctx.mcpServers` the
 * MCP server declarations (`mcp-servers:read` / `mcp-servers:write`, secrets
 * always read back masked), `ctx.backends.list` the LLM catalogue
 * (`backends:read`). `agent_created`, `agent_updated` and `agent_deleted`
 * reach the plugin for the agents it created, with the `origin` of the write
 * (host half only, `events:subscribe` + `agents:read`). Errors carry a `code`.
 * `ctx.agents.export` (API 15, `agents:export`) reads the portable definition
 * of any agent the signed-in account may read, in a request only.
 */
export type {
  PluginMcpServers, PluginMessages, PluginSkills,
} from '../../../orchestrator/src/plugins/contract/facades.js';
export type {
  PluginAgentAvatar, PluginAgentCreatedEvent, PluginAgentDeleteOptions, PluginAgentDeletedEvent, PluginAgentDoc, PluginAgentEvent,
  PluginAgentEventKind, PluginAgentEventMap, PluginAgentOrigin, PluginAgentSnapshot,
  PluginAgentUpdatedEvent, PluginTeam, PluginTeamInput,
  PluginAgentExport, PluginAgentExportRoutine,
} from '../../../orchestrator/src/plugins/contract/agents.js';
export type { PluginBackendCatalog } from '../../../orchestrator/src/plugins/contract/backends.js';
export type {
  PluginMcpServer, PluginMcpServerErrorCode, PluginMcpServerInput, PluginMcpServerSummary,
} from '../../../orchestrator/src/plugins/contract/mcp-servers.js';
export type {
  PluginMessage, PluginMessageErrorCode, PluginMessageInput, PluginMessageRecvOptions,
} from '../../../orchestrator/src/plugins/contract/messages.js';
export type {
  PluginSkill, PluginSkillErrorCode, PluginSkillSummary,
} from '../../../orchestrator/src/plugins/contract/skills.js';

/**
 * Timon's MCP tools for an agent on another machine, API 7 (`ctx.mcp`,
 * permission `mcp:issue`): a token bound to one running mission, limited to
 * listed tools, short-lived, sent as `Authorization: Bearer` to `path`.
 */
export type {
  PluginMcpToken, PluginMcpTokenInput,
} from '../../../orchestrator/src/plugins/contract/missions.js';

/**
 * HTML documents in a mission's conversation, API 9 (`ctx.ui.documents`,
 * permissions `ui-documents:read` / `ui-documents:write`), and their events
 * (`ui_document_created`, `ui_document_resolved`, host half only, with
 * `events:subscribe` + `ui-documents:read`). A document read by any plugin is
 * a `PluginUiDocument`, without reply; one this plugin created is a
 * `PluginOwnUiDocument`, with it.
 */
export type { PluginUiDocuments } from '../../../orchestrator/src/plugins/contract/facades.js';
export type {
  PluginOwnUiDocument, PluginUiDocument, PluginUiDocumentActor, PluginUiDocumentCreatedEvent,
  PluginUiDocumentErrorCode, PluginUiDocumentEvent, PluginUiDocumentEventKind, PluginUiDocumentEventMap,
  PluginUiDocumentInput, PluginUiDocumentResolvedEvent,
} from '../../../orchestrator/src/plugins/contract/ui-documents.js';

/**
 * Questions agents wait on and the notification centre, API 10
 * (`ctx.questions`, permissions `questions:read` / `questions:answer`;
 * `ctx.notifications`, permissions `notifications:read` / `notifications:write`),
 * and the question events (`question_pending`, `question_resolved`, host half
 * only, with `events:subscribe` + `questions:read`). Answering is sensitive: it
 * unblocks the agent as if the user had clicked.
 */
export type {
  PluginNotifications, PluginQuestions,
} from '../../../orchestrator/src/plugins/contract/facades.js';
export type {
  PluginNotification, PluginNotificationErrorCode, PluginNotificationListFilter,
} from '../../../orchestrator/src/plugins/contract/notifications.js';
export type {
  PluginQuestion, PluginQuestionActor, PluginQuestionAnswer, PluginQuestionAnswerValue,
  PluginQuestionErrorCode, PluginQuestionEvent, PluginQuestionEventKind, PluginQuestionEventMap,
  PluginQuestionItem, PluginQuestionListFilter, PluginQuestionOption, PluginQuestionOptionActor,
  PluginQuestionPendingEvent, PluginQuestionPlan, PluginQuestionResolution, PluginQuestionResolvedEvent,
} from '../../../orchestrator/src/plugins/contract/questions.js';

/**
 * Mission control and traces, API 10. `ctx.missions` gains `send`, `kill`,
 * `fork`, `stopScope` (permission `missions:control`) and `search`, `summarize`
 * (`missions:transcript`); `spawn` takes `model`, `backend`, `extraSkills`,
 * `extraMcp`, `allow` (`PluginMissionSpawnOverrides`); `ctx.traces.get` reads a
 * causal trace (`missions:read`). `ctx.missions.rename` sets a title by hand
 * (`manual`, `missions:control`). The events `mission_started`, `turn_complete`,
 * `mission_title_changed` (`missions:read`) and the transcript stream `event` / `event_delta`
 * (`missions:transcript`) are filtered by the mission's owner. Errors carry a
 * `PluginMissionErrorCode`.
 */
export type {
  PluginMissionErrorCode, PluginMissionEvent, PluginMissionEventKind, PluginMissionEventMap,
  PluginMissionFork, PluginMissionForkInput, PluginMissionOrigin, PluginMissionSearchFilter,
  PluginMissionSearchResult, PluginMissionSendResult, PluginMissionSpawnOverrides,
  PluginMissionStartedEvent, PluginMissionSummary, PluginMissionTranscriptDeltaEvent,
  PluginMissionTranscriptEvent, PluginMissionTurnCompleteEvent, PluginMissionTitleChangedEvent,
  PluginStopReport, PluginStopScope, PluginTraceOptions,
} from '../../../orchestrator/src/plugins/contract/missions.js';

/**
 * Timon's memory, API 10 (`ctx.memory`, permissions `memory:read` /
 * `memory:write`): rules (`rules.add` / `list` / `rm`), search, overview and
 * the memory files of an agent or a project. A rule this plugin writes carries
 * `source: 'plugin:<id>'` and is removable by this plugin only. Its events
 * (`memory_rule_added`, `memory_rule_removed`, host half only, with
 * `events:subscribe` + `memory:read`) concern the rules it wrote and name
 * who acted in `origin`. Errors carry a `PluginMemoryErrorCode`.
 */
export type {
  PluginMemoryActor, PluginMemoryErrorCode, PluginMemoryEvent, PluginMemoryEventKind,
  PluginMemoryEventMap, PluginMemoryFile, PluginMemoryFileInfo, PluginMemoryOverview, PluginMemoryRule,
  PluginMemoryRuleAddedEvent, PluginMemoryRuleFilter, PluginMemoryRuleInput,
  PluginMemoryRuleRemovedEvent, PluginMemoryRuleSnapshot, PluginMemorySearchResult,
  PluginMemoryTargetScope,
} from '../../../orchestrator/src/plugins/contract/memory.js';

/**
 * Projects, series and task worktrees, API 10. `ctx.projects` (permissions
 * `projects:read` / `projects:manage`): list, register and edit projects, their
 * poles and role pins, with `project_created` / `project_updated` events (host
 * half only, `events:subscribe` + `projects:read`) that carry the writer's
 * `origin`. `ctx.series` (`series:read` / `series:manage`): the fallback plan and
 * per-role LLM choices of a task series. `ctx.worktrees` (`worktrees:read` /
 * `worktrees:manage`): where a task's worktree is, force-create it, dispose it
 * once merged. The `:manage` permissions are sensitive. Errors carry a `code`.
 */
export type {
  PluginProject, PluginProjectCreatedEvent, PluginProjectErrorCode, PluginProjectEvent,
  PluginProjectEventKind, PluginProjectEventMap, PluginProjectInput, PluginProjectOrigin,
  PluginProjectPatch, PluginProjectRoles, PluginProjectUpdatedEvent, PluginProjectWarning,
  PluginProjectWrite, PluginRoleInput, PluginRoleSpec, PluginWorkspace,
} from '../../../orchestrator/src/plugins/contract/projects.js';
export type {
  PluginSeriesErrorCode, PluginSeriesFallbackInput, PluginSeriesFallbackResult, PluginSeriesRoleInput,
  PluginSeriesRule,
} from '../../../orchestrator/src/plugins/contract/series.js';
export type {
  PluginWorktree, PluginWorktreeErrorCode,
} from '../../../orchestrator/src/plugins/contract/worktrees.js';

/**
 * The screen and the conversation, API 10 — host half. `ctx.layout`
 * (`layout:read`, `layout:propose`, `layout:presets`) reads the arrangement of
 * the account of the request and asks its owner to change it; `ctx.ui.navigate`
 * (`layout:propose`) asks them to go to a page; `ctx.onboarding.profile()`
 * (`onboarding:read`) reads the profile they picked. Every change is a card in
 * one of that account's own missions that only they can apply, shown as coming
 * from `plugin:<id>`; the answer is read back with `layout.proposals`. `ctx.chat`
 * (`chat:media`, `chat:command`) shows a media and proposes a command the owner
 * may paste into their terminal. A job has no account: every call throws
 * `no_owner`. Errors are `PluginLayoutError`, with a `PluginLayoutErrorCode`.
 */
export type {
  PluginCommandInput, PluginCommandReceipt, PluginCommandRequest, PluginIslandsProposalInput,
  PluginLayoutErrorCode, PluginLayoutProposal, PluginLayoutProposalInput, PluginLayoutProposalKind,
  PluginLayoutReceipt, PluginLayoutSnapshot, PluginLayoutTarget, PluginMediaInput, PluginMediaShown,
  PluginNavProposalInput, PluginNavigateInput, PluginPresetInput, PluginWidgetsProposalInput,
} from '../../../orchestrator/src/plugins/contract/layout.js';

/**
 * Administration and system, API 10 — every permission is sensitive:
 * `ctx.secrets` (`secrets:list` / `secrets:manage` / `secrets:broker`),
 * `ctx.users`, `backendAccounts` (`accounts:*`, a superadmin's
 * request), `ctx.plugins` and `ctx.modules` (`plugins:*`), `ctx.system`
 * (`system:read` / `system:logs`), `ctx.backup`, `ctx.browser`,
 * `ctx.docs`, `ctx.license` (edition only). Refusals carry a
 * `PluginAdminErrorCode`.
 */
export type {
  PluginAccountChange,
  PluginAccountProvider,
  PluginAccountUser,
  PluginAuditEntry,
  PluginBackendAccount,
  PluginLegacyAccountTable,
  PluginPermissionAction,
  PluginPermissionCatalog,
  PluginPermissionChoice,
  PluginPermissionSource,
  PluginPermissionSourceHandle,
  PluginProviderAccount,
  PluginProviderAccountPatch,
  PluginProvisionInput,
  PluginProvisionedAccount,
  PluginSessionRequest,
  PluginSessionResponse,
} from '../../../orchestrator/src/plugins/contract/accounts.js';
export type { PluginAdminErrorCode } from '../../../orchestrator/src/plugins/contract/admin.js';
export type {
  PluginBackupArchive, PluginBackupStatus,
} from '../../../orchestrator/src/plugins/contract/backup.js';
export type { PluginBrowserSession } from '../../../orchestrator/src/plugins/contract/browser.js';
export type { PluginDocHit } from '../../../orchestrator/src/plugins/contract/docs.js';
export type {
  PluginDoctorReport, PluginLogKind, PluginLogsOptions, PluginSystemHealth,
} from '../../../orchestrator/src/plugins/contract/system.js';
export type { PluginEdition } from '../../../orchestrator/src/plugins/contract/edition.js';
export type {
  PluginHttpCallInput, PluginHttpCallResult, PluginSecretInfo, PluginSecretInput,
} from '../../../orchestrator/src/plugins/contract/secrets.js';
export type { PluginInfo } from '../../../orchestrator/src/plugins/contract/plugins.js';
export type { PluginModuleInfo } from '../../../orchestrator/src/plugins/contract/modules.js';

/**
 * Recordings of the built-in browser, API 13 (`browser:recordings:read` /
 * `browser:recordings:write`, both sensitive): `ctx.browserRecordings`, inside
 * the owner's request only, and the `browser_recording_*` events.
 */
export type {
  PluginBrowserRecording, PluginBrowserRecordingDetail, PluginBrowserRecordingEvent,
  PluginBrowserRecordingEventKind, PluginBrowserRecordingEventMap, PluginBrowserRecordingOp,
  PluginBrowserRecordingRef, PluginBrowserRecordingStep,
} from '../../../orchestrator/src/plugins/contract/browser-recordings.js';

/**
 * Annotations of the built-in browser, API 13 (`browser:annotations:read` /
 * `browser:annotations:write`, both sensitive): `ctx.browserAnnotations`, inside
 * the owner's request only, and the `browser_annotation_*` events.
 */
export type {
  PluginBrowserAnnotation, PluginBrowserAnnotationDetail, PluginBrowserAnnotationEvent,
  PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEventMap, PluginBrowserAnnotationFilter,
  PluginBrowserAnnotationRef, PluginBrowserAnnotationResolution,
} from '../../../orchestrator/src/plugins/contract/browser-annotations.js';

/** Integration contracts and facades, available from apiVersion 3. */
export type {
  PluginBusinessEvents, PluginWorkflows, PluginTransports, PluginConnections, PluginBusinessEvent,
  PluginBusinessEventDefinition, PluginBusinessEventInput, PluginConnection, PluginConnectionInput,
  PluginConnectionPatch, PluginInboundMessage, PluginIntegrationCallContext,
  PluginIntegrationDefinition, PluginIntegrationDisposer, PluginIntegrationIdentity,
  PluginIntegrationSchema, PluginJsonObject, PluginJsonValue, PluginMessagingConnection,
  PluginTransportContext, PluginTransportDefinition, PluginTransportDelivery, PluginTransportReply,
  PluginTransportRequest, PluginWorkflowExecutorContext, PluginWorkflowExecutorDefinition,
  PluginWorkflowExecutorResult, PluginWorkflowTriggerContext, PluginWorkflowTriggerDefinition,
} from '../../../orchestrator/src/plugins/contract/integration.js';

/** Per-user connections of a plugin-declared type, available from apiVersion 7. */
export type {
  PluginConnectionApproval, PluginConnectionField, PluginConnectionSecretField,
  PluginConnectionTestContext, PluginConnectionTestResult, PluginConnectionTypeDefinition,
  PluginUserConnection,
} from '../../../orchestrator/src/plugins/contract/integration.js';

/** Read-only follow-up of a messaging connection's receipts (`ctx.connections.receipts`), available from apiVersion 14. */
export type {
  PluginConnectionReceipts, PluginConnectionReceiptsOptions, PluginIntegrationReceipt,
  PluginIntegrationReceiptCounts, PluginIntegrationReceiptStatus,
} from '../../../orchestrator/src/plugins/contract/integration.js';

/** Quota shapes carried by `ctx.usage` / `clientCtx.usage`. */
export type { AccountUsage, UsageProbeOptions, UsageWindow } from '../../../orchestrator/src/plugins/contract/provider-kit.js';

import type { PluginEventKind } from '../../../orchestrator/src/plugins/contract/events.js';
import type { UsageEntry } from '../../../orchestrator/src/plugins/contract/usage.js';
import type { UsageProbeOptions } from '../../../orchestrator/src/plugins/contract/provider-kit.js';

/** Readable alias for the current API contract version. */
export { PLUGIN_API_VERSION as apiVersion } from '../../../orchestrator/src/plugins/contract/manifest.js';

/** Composition strategy of a declared UI extension point. */
export type SlotKind = 'single' | 'list' | 'keyed';
/** Child extension points owned and rendered by a registered component. */
export type SlotChildren = Record<string, SlotKind>;

/** Slot body, or a custom widget frame receiving host layout controls. */
export type ClientComponent = (props: Record<string, never> | WidgetChromeProps) => unknown;

/** Props supplied when a widget declares a custom frame. */
export type WidgetChromeProps = {
  /** True while the user rests on the widget's title or a layout gesture is under way; hide optional configuration controls otherwise. */
  editing?: boolean;
  /** Render these host controls in the custom widget header. */
  poignee: unknown;
  /** Forward host layout classes to the widget root. */
  className?: string;
  /**
   * Direction of the zone holding the widget: `horizontal`, one line of the
   * top bar, 36px tall; `vertical`, a column. Only a widget registered with
   * `bar: true` is ever given `horizontal`.
   */
  orientation?: 'vertical' | 'horizontal';
  /**
   * Paint the compact form, not the card: icons and badges only, side by side
   * when `orientation` is `horizontal`, stacked otherwise, the detail opening
   * on click (`AnchoredPopover` from `@timon/ui`). True on the top bar's line
   * and in the product's two sidebars, and only for a widget registered with
   * `bar: true` that is not in a stack of tabs. Wide zones (cockpit, chat
   * columns) keep the card.
   */
  compact?: boolean;
};

/** Initial widget appearance; saved user placement takes precedence. */
export type WidgetOptions = {
  /** Card title; defaults to the registration key or plugin ID. */
  title?: string;
  /** Preferred first placement zone; absent zones remain pending. */
  zone?: string;
  /** Initial fixed height in pixels before user resizing. */
  height?: number;
  /** Fill the remaining zone height by default; users can choose a fixed size. */
  heightMode?: 'fixed' | 'fill';
  /** Minimum resize height in pixels. */
  minHeight?: number;
  /** Use tile for host framing or none to render your own frame. */
  frame?: 'tile' | 'none';
  /**
   * The widget also has a compact form: admitted on the top bar's line
   * (`topbar.widget`), and painted compact there and in the sidebars
   * (`WidgetChromeProps.compact`).
   */
  bar?: boolean;
  /**
   * Placed in `zone` on every view that has neither placed nor removed it yet,
   * instead of waiting in the palette. For a surface that was already on screen
   * before it became a widget.
   */
  placedByDefault?: boolean;
  /**
   * Keys this widget was registered under before; `''` names a keyless
   * registration. A place saved under one of them is handed down to the widget.
   */
  formerKeys?: readonly string[];
  /**
   * One sentence on what the widget does, shown under its name in the widget
   * window: what it shows or lets you do, not how it is built.
   */
  description?: string;
  /**
   * What the widget window calls it when `title` is the user's own (one chat
   * card per agent): "Agent chat" rather than the agent's name.
   */
  catalogTitle?: string;
  /**
   * Picto on the widget's card in the widget window: SVG markup (`<svg …>`)
   * or the URL of an SVG. Painted as a mask in the theme's text colour, so
   * only its shape counts — a 24×24 line drawing reads best.
   */
  icon?: string;
};

/** Params of an island content: flat, at most 1 KiB once serialised. */
export type IslandParams = Record<string, string | number | boolean | null>;

/**
 * One param of an island content type, as an agent reads it (`islands_get`)
 * and the daemon checks a proposal against it. Declarative only, no regular
 * expression: `parseParams` stays the last word in the browser.
 */
export type IslandParamSpec = {
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  nullable?: boolean;
  /** What the param means, for an agent composing a layout. */
  description?: string;
  enum?: readonly string[];
  maxLength?: number;
  min?: number;
  max?: number;
};

/**
 * What a content of the island workspace (`island.content`, client API 8)
 * says about itself. Its type id is `<pluginId>:<key>`, computed by the host.
 */
export type IslandContentOptions = {
  /** What the tab and its menus show until the content sets its own title. */
  title: string;
  /** SVG markup, same rules as `WidgetOptions.icon`. */
  icon?: string;
  /**
   * Validates and cleans params read from storage, from a drag or from an
   * agent's proposal. `null` refuses them. Mandatory: a stored value is opaque.
   */
  parseParams: (raw: unknown) => IslandParams | null;
  /** The params `parseParams` accepts, described for an agent. */
  params?: Readonly<Record<string, IslandParamSpec>>;
  /** Params that are a day's state, dropped from a named preset. */
  volatileParams?: readonly string[];
  /** At most one live tab per value of this param, or per combination of these params (the first one set; a later one absent on both sides counts as equal). */
  singletonBy?: string | readonly string[];
  /** Stays mounted, hidden, while its tab is not the visible one. Default: unmounted. */
  keepMounted?: boolean;
  /** Group of contents of which only one instance is primary at a time (`useIslandContent().primary`). */
  exclusive?: string;
  /** px, default 280. */
  minWidth?: number;
  /** px, default 160. */
  minHeight?: number;
  /** Reopens this content in its own window ("Detach"). Absent = no Detach. */
  detach?: (params: IslandParams) => void;
  /**
   * A param naming what tabs of this type belong to (a terminal's scope):
   * opening one lands in the island that already holds a tab of the type with
   * the same value, rather than in a new one.
   */
  groupBy?: string;
  /** The "+" of the island's tab bar: makes the params of one more tab, or `null` to refuse. Absent = no "+". */
  newTab?: (params: IslandParams) => Promise<IslandParams | null>;
  /**
   * The user asks to close the tab (its ×, middle click, Delete, menu, or its
   * island's close): `false` keeps it open — unsaved changes the user chose to
   * keep. A promise may ask first; one that throws or rejects keeps the tab
   * too. Agreeing is not closing: an island asks each of its tabs in turn and
   * any later one may still keep them all, so drop state in `onClose`, never
   * here. Not called when the tab moves, nor when the content or the host
   * closes it itself. An arrangement replacing the tab (a recall, a preset
   * applied to every project, an agent's card) asks too, and a refusal cancels
   * the whole arrangement — also on a page not on screen, where the tab is not
   * mounted: keep what this reads outside the component.
   */
  beforeClose?: (params: IslandParams, tabId: string) => boolean | Promise<boolean>;
  /**
   * The tab closed, whoever closed it: end what it held (kill a shell, drop a
   * draft). Not called when the tab moves. May run while the tab is not
   * mounted (an arrangement written over a page not on screen).
   */
  onClose?: (params: IslandParams, tabId: string) => void;
};

import type { DictationEngine } from './dictation.js';
import type { MascotPart } from '../../../orchestrator/src/plugins/contract/mascot.js';

export type { MascotPart, MascotPartLabel, MascotPoint } from '../../../orchestrator/src/plugins/contract/mascot.js';

export type {
  DictationAvailability, DictationEngine, DictationErrorCode, DictationEvent, DictationInterim, DictationLanguages,
  DictationSession, DictationStartOptions,
} from './dictation.js';

/** A body `ctx.api` relays as bytes rather than JSON (client API 15). */
export type PluginApiBinaryBody = Blob | ArrayBuffer | ArrayBufferView;

/** Browser capabilities bound to the installed plugin identity. */
export type ClientContext = {
  /** Manifest identity of this plugin. */
  readonly id: string;
  slots: {
    /**
     * Registers a component in `options.slot`. Admission compares slot
     * NATURES, not just names: a manifest declaring any `*.widget` slot may
     * fill every widget host (`cockpit.widget`, `sidebar.left.widget`, a
     * third-party layout's own widget zone). Any other slot stays an exact
     * match — a widget never gets `root`, `page`, `settings.section` or
     * `settings.missions`. Settings graft slots (`settings.missions`, …)
     * are exact too: declaring one native group does not open the others.
     * Throws when the slot is refused or undeclared. `dictation` (API 14) is
     * read for `dictation.engine` only, and throws without `dictation:engine`.
     * `mascotPart` (API 15) is read for `mascot.parts` only, with `key` = the
     * part's slug, which the manifest must declare (`timon.mascot`); the
     * component is not painted there and may be left out.
     *
     * In `nav.item`, `key` is the entry's route (`'/growth'`: lowercase, from
     * `/`). It is what the person's menu refers to: with it, the entry moves,
     * hides, and goes to the bottom of the menu like the product's, and comes
     * back to its place when the plugin is switched off and on again. Without
     * it, the entry shows at the end of the main list and cannot be moved or
     * hidden. The host owns the editing row (grip, eye) and makes the entry's
     * own content inert meanwhile: paint a plain link, nothing more.
     */
    register(
      options: {
        slot: string; key?: string; widget?: WidgetOptions; island?: IslandContentOptions; dictation?: DictationEngine;
        mascotPart?: MascotPart; children?: SlotChildren;
      },
      Component?: ClientComponent,
    ): () => void;
  };
  /**
   * Fetch a path beneath this plugin's own API namespace. A JSON body is
   * relayed as JSON. An archive ({@link PluginApiBinaryBody}: a `File`, a
   * `Blob`, an `ArrayBuffer`) is streamed to the host half as bytes when its
   * type is `application/zip`, `application/x-zip-compressed` or
   * `application/octet-stream` — an untyped `Blob` or buffer is sent as
   * `application/octet-stream` — up to 50 MiB (413 past that, before a byte
   * is read). Any other type keeps the JSON path.
   */
  api(path: string, init?: RequestInit): Promise<Response>;
  settings: {
    /** Read browser-safe settings; secret plaintext is never returned. */
    get(): Promise<Record<string, unknown>>;
    /** Persist a declared setting through the authenticated platform endpoint. */
    set(key: string, value: unknown): Promise<Response>;
  };
  /**
   * Subscribe to platform events and retain the returned cleanup function.
   * Same allowlist as the host `ctx.events.on` ({@link PluginEventKind}).
   * Any other kind, mission transcripts included, throws at runtime. The TO DO
   * kinds ({@link PluginTodoEventKind}) and the task kinds
   * ({@link PluginTaskEventKind}) are host-only: they are filtered by account
   * and carry the writer's origin, which the browser stream does not.
   */
  events: { subscribe(kind: PluginEventKind, handler: (event: unknown) => void): () => void };
  /**
   * API 4: subscribe to this plugin's own topics. Only the owner account
   * receives a signal, never another account (including superadmins).
   * Topics must match ^[a-z0-9][a-z0-9._-]{0,63}$ or subscribe throws.
   * The handler receives the payload, not the transport envelope.
   * Cleanup is automatic on plugin disposal; the returned function can
   * unsubscribe earlier. Host publishing requires `realtime:publish`.
   */
  realtime: { subscribe(topic: string, handler: (payload: unknown) => void): () => void };
  theme: { current(): 'light' | 'dark' };
  /** Quotas of the LLM accounts. Needs `usage:read` in the manifest — the
   *  daemon answers 403 otherwise, so a plugin never reads a fabricated zero.
   *  Lists the signed-in user's subscription accounts too, never another
   *  user's. `{ force: true }` is for a person's explicit refresh only (a ↻
   *  button): the probes skip their cache. Never pass it from a polling loop —
   *  the daemon honours it at most once every few seconds per account. */
  usage: { list(options?: UsageProbeOptions): Promise<UsageEntry[]> };
  /** Navigate through the host application. */
  navigate(href: string): void;
  /** Own a synchronous setup and its cleanup for the plugin lifetime. */
  effect(setup: () => void | (() => void)): void;
};

/** Browser entry point; return cleanup for registrations and subscriptions. */
export type ClientPlugin = {
  apply(context: ClientContext): void | (() => void) | Promise<void | (() => void)>;
};

/** Owner-only realtime transport, available from apiVersion 4. */
export type {
  PluginRealtime, PluginRealtimeOptions,
} from '../../../orchestrator/src/plugins/contract/realtime.js';

/** Provider authoring contracts; exported by the SDK in API 4. */
export type { RegisteredProfile } from '../../../orchestrator/src/plugins/contract/provider-kit.js';
export type {
  BackendProfile, Dialect, EnvResolver, SecretRef, BuildSpawnOpts, SpawnResult,
  ProfileRuntime, ProviderConfig, NormalizedEvent, PermissionModel,
  RateLimitReporting, SessionStore, ImageAttachment, LocalEnvPolicy, DiscoveredModel,
} from '../../../orchestrator/src/plugins/contract/provider-kit.js';
/** Backends with no local process (`transport: 'remote'`); exported in API 7. */
export type {
  RemoteDialect, RemoteSessionOpenArgs, RemoteSessionHost, SessionEnd, SessionDriver, SessionHost,
  SessionInfo, SessionCapabilities, TurnOutcome, PermissionRequest, PermissionDecision, PermissionWait, ApprovalScope,
  RemoteResumeState, RemoteSessionResume,
} from '../../../orchestrator/src/plugins/contract/provider-kit.js';
/** An agent's own blocking question, as a card (`SessionHost.ask`), API 14. */
export type {
  SessionAnswer, SessionAskOutcome, SessionAskRequest, SessionQuestion, SessionQuestionOption,
} from '../../../orchestrator/src/plugins/contract/provider-kit.js';

/** For whom a backend's resolver and session are called (`EnvResolver`, `RemoteSessionOpenArgs.launch`), API 7. */
export type { BackendLaunchContext } from '../../../orchestrator/src/plugins/contract/provider-kit.js';
/** Declared backend capabilities (`Dialect.capabilities`, `BackendProfile.capabilities`), API 7. */
export type { BackendCapabilities, BackendCapability } from '../../../orchestrator/src/plugins/contract/provider-kit.js';
export type { CatalogModel } from '../../../orchestrator/src/plugins/contract/provider-kit.js';
export type {
  DeclaredReasoningControl, ModelReasoning, ReasoningControl,
} from '../../../orchestrator/src/plugins/contract/provider-kit.js';
export type { LocalBackendFile } from '../../../orchestrator/src/plugins/contract/local-backends.js';

/** A declarative pack reference to its own declared secret setting. */
export type SettingRef = Extract<
  NonNullable<import('../../../orchestrator/src/plugins/contract/local-backends.js').LocalBackendFile['env']>[string],
  { setting: string }
>;
