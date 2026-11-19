/**
 * The `PluginContext` contract (§10.4 of the plan) — everything a third-party
 * plugin can do through the daemon, and nothing else.
 *
 * This is the product's public surface: frozen at `apiVersion 1` (M.7). It must
 * not change without incrementing `PLUGIN_API_VERSION`. Identity is per-request
 * (`user()`, never a field). Three decisions govern its design, each for a
 * reason beyond aesthetics.
 *
 * ## 1. An object, not a Cordis `Context`
 *
 * The plan describes a context mounted through `ctx.isolate()`. Isolation is
 * present (`isolateForPlugin`), but is not enough: `events` and `logger` are
 * `Context` instance properties, not registry services. Neither can therefore
 * be isolated or replaced — a plugin receiving a real `Context` would retain
 * `ctx.emit`, which could fabricate a fake `timon/task_done` under the
 * dispatcher's nose. The plugin therefore receives an OBJECT whose members are
 * all written here. Anything not written here does not exist for it: no
 * `dbApi`, `bus.publish`, `process.env`, or filesystem access outside
 * `storage.dir` (§6, §10.10).
 *
 * Cordis isolation remains useful as a second line: the fiber under which the
 * loader (P.3) mounts the plugin resolves NO internal services, so even an
 * `inject: ['db']` that escaped the manifest would find nothing.
 *
 * ## 2. Facades are always present; permissions are checked at call time
 *
 * In Cordis 4, `inject` is a HARD dependency: optional injection does not exist.
 * Attaching a facade to a service provided by a disableable module (for example
 * `kanban` in the lite edition) would leave the plugin PENDING and make a valid
 * installation fail at boot — the trap encountered in P1 (step 1.5). Facades
 * are therefore built unconditionally here, and their dependencies are
 * resolved when called.
 *
 * ## 3. Everything goes through `PluginHost`
 *
 * Facades never touch `dbApi`/`spawnAgent`/`bus` directly: they go through the
 * `PluginHost` bindings, whose real implementation is `daemonHost()`. This
 * makes the contract testable without spawning an agent and later allows a
 * plugin to run outside the daemon process without rewriting its surface.
 */
import { createAccountProviderFacade } from './account-provider-facade.js';
import { createPermissionSourceFacade } from './permission-source-facade.js';
import { publishPluginRealtime } from './realtime.js';
import express, { type Router } from 'express';
import { openIntegrationSession, type PluginIntegrationSession } from './integration-session.js';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import { bus } from '../bus.js';
import { dbApi, type DbViewer } from '../db.js';
import { getHost } from '../host/index.js';
import { PLUGIN_TOKEN_KEY_FILE, pluginDataDir } from '../paths.js';
import { openPluginKvValue, readPluginSecret } from '../secrets/plugins.js';
import { systemEnv } from '../secrets/env.js';
import { credentialDirProblem } from '../backends/provider-declarations.js';
import { scopedDb } from '../users/scoped-db.js';
import { TodoLinkError, todosFor, type ScopedTodoApi, type TodoCallerScope } from '../plugins-bundled/kanban/todo-api.js';
import { promoteTodoFor } from '../plugins-bundled/kanban/todo-promote.js';
import {
  collectBackendUsage, collectUsage, registerUsageCollector,
  type UsageCollector, type UsageEntry,
} from '../usage.js';
import {
  registerDialect, registerProfile, type RegisteredProfile,
} from '../backends/registry.js';
import { isRemoteDialect, type Dialect, type RemoteDialect, type UsageProbeOptions } from '../backends/types.js';
import type { ProviderPluginContext } from '../backends/provider-plugin-context.js';
import { providerServicesFor } from './provider-facade.js';
import { thirdPartyPluginVisible } from '../users/surfaces.js';
import { DICTATION_DAEMON_BODY_LIMIT, registerRouteBodyLimit } from './route-body-limit.js';
import {
  currentPluginOwnerUserId,
  pluginCallUnattended,
  currentPluginUser,
  currentPluginViewer,
  identityFromRequest,
  pluginCallerAllows,
  runPluginRequest,
  type PluginUser,
} from './als.js';
import { assertCompositionMutable } from '../license/capabilities.js';
import { licenseState } from '../license/runtime.js';
import { assertExecAllowed, assertFetchAllowed, assertSpawnAllowed, grantedKanbanProjects, PluginPolicyError } from './policy.js';
import { maybeUserConnectionService, userConnectionService } from './user-connections.js';
import {
  isPluginTaskEventKind, PLUGIN_TASK_EVENT_KINDS, subscribePluginTaskEvent, type PluginTaskEventHandler,
  type PluginTaskEventKind,
} from './task-events.js';
import {
  tasksFor, type PluginTask, type PluginTaskDoneInput, type PluginTaskFilter, type PluginTaskInput,
  type PluginTaskLink, type PluginTaskLinkInput, type PluginTaskPatch, type ScopedTasks, type TaskCallerScope,
} from './tasks-facade.js';
import {
  isPluginTodoEventKind, PLUGIN_TODO_EVENT_KINDS, subscribePluginTodoEvent, type PluginTodoEventHandler,
  type PluginTodoEventKind,
} from './todo-events.js';
import {
  isPluginUiDocumentEventKind, PLUGIN_UI_DOCUMENT_EVENT_KINDS, subscribePluginUiDocumentEvent,
  type PluginUiDocumentEventHandler, type PluginUiDocumentEventKind,
} from './ui-document-events.js';
import {
  uiDocumentsFor, type PluginOwnUiDocument, type PluginUiDocument, type PluginUiDocumentInput,
  type ScopedUiDocuments, type UiDocumentCallerScope,
} from './ui-documents-facade.js';
import type { UiDocumentStatus } from '../db.js';
import { layoutFor, type LayoutCallerScope, type ScopedLayout } from './layout-facade.js';
import { chatFor, type ChatCallerScope, type ScopedChat } from './chat-facade.js';
import {
  isPluginQuestionEventKind, PLUGIN_QUESTION_EVENT_KINDS, subscribePluginQuestionEvent,
  type PluginQuestionEventHandler, type PluginQuestionEventKind,
} from './question-events.js';
import {
  questionsFor, type PluginQuestion, type PluginQuestionAnswer, type PluginQuestionListFilter,
  type QuestionCallerScope, type ScopedQuestions,
} from './questions-facade.js';
import {
  isPluginApprovalEventKind, PLUGIN_APPROVAL_EVENT_KINDS, subscribePluginApprovalEvent,
  type PluginApprovalEventHandler, type PluginApprovalEventKind,
} from './approval-events.js';
import {
  approvalsFor, type ApprovalCallerScope, type PluginApproval, type PluginApprovalDecision,
  type PluginApprovalListFilter, type ScopedApprovals,
} from './approvals-facade.js';
import {
  notificationsFor, type NotificationCallerScope, type PluginNotificationListFilter, type ScopedNotifications,
} from './notifications-facade.js';
import {
  createPluginOutbox, type PluginOutboxEntry, type PluginOutboxHost, type PluginOutboxOptions, type PluginOutboxTarget,
} from './outbox.js';
import {
  triggersFor, type PluginOwnTrigger, type PluginTriggerCreated, type PluginTriggerInfo, type PluginTriggerInput,
  type PluginTriggerTestOptions, type PluginTriggerTestResult, type ScopedTriggers, type TriggerCallerScope,
} from './triggers-facade.js';
import {
  automationEventPermissions, isPluginAutomationEventKind, PLUGIN_AUTOMATION_EVENT_KINDS,
  subscribePluginAutomationEvent, type PluginAutomationEventHandler, type PluginAutomationEventKind,
} from './automation-event-hub.js';
import {
  workflowsFor, type ScopedWorkflows, type WorkflowCallerScope,
} from './workflows-facade.js';
import {
  pipelinesFor, type PipelineCallerScope, type PluginOwnPipeline, type PluginPipeline, type PluginPipelineInput,
  type PluginPipelineRun, type PluginPipelineRunStatus, type ScopedPipelines,
} from './pipelines-facade.js';
import {
  routinesFor, type PluginRoutine, type PluginRoutineInput, type PluginRoutinePatch, type RoutineCallerScope,
  type ScopedRoutines,
} from './routines-facade.js';
import {
  agentsFor, type AgentCallerScope, type PluginAgent, type PluginAgentAvatar, type PluginAgentDeleteOptions, type PluginAgentInput, type PluginAgentPatch, type PluginTeam, type PluginTeamInput, type ScopedAgents,
} from './agents-facade.js';
import {
  assertSpawnOverrides, missionControlFor, type MissionControlCallerScope, type PluginMissionForkInput,
  type PluginMissionSearchFilter, type PluginStopScope, type PluginTraceOptions, type ScopedMissionControl,
} from './missions-facade.js';
import {
  isPluginMissionEventKind, isPluginTranscriptEventKind, PLUGIN_MISSION_EVENT_KINDS, subscribePluginMissionEvent,
  type PluginMissionEventHandler, type PluginMissionEventKind,
} from './mission-events.js';
import {
  memoryFor, type MemoryCallerScope, type PluginMemoryRuleFilter, type PluginMemoryRuleInput,
  type PluginMemoryTargetScope, type ScopedMemory,
} from './memory-facade.js';
import {
  isPluginMemoryEventKind, PLUGIN_MEMORY_EVENT_KINDS, subscribePluginMemoryEvent, type PluginMemoryEventHandler,
  type PluginMemoryEventKind,
} from '../memory-rule-events.js';
import {
  projectsFor, type PluginProjectInput, type PluginProjectPatch, type PluginRoleInput, type ProjectCallerScope,
  type ScopedProjects,
} from './projects-facade.js';
import {
  isPluginProjectEventKind, PLUGIN_PROJECT_EVENT_KINDS, subscribePluginProjectEvent, type PluginProjectEventHandler,
  type PluginProjectEventKind,
} from './project-events.js';
import {
  seriesFor, type PluginSeriesFallbackInput, type PluginSeriesRoleInput, type ScopedSeries, type SeriesCallerScope,
} from './series-facade.js';
import {
  worktreesFor, type ScopedWorktrees, type WorktreeCallerScope,
} from './worktrees-facade.js';
import { agentDocsFor, type PluginAgentDoc, type ScopedAgentDocs } from './agent-docs-facade.js';
import { agentExportFor, type PluginAgentExport, type ScopedAgentExport } from './agent-export-facade.js';
import {
  isPluginAgentEventKind, PLUGIN_AGENT_EVENT_KINDS, subscribePluginAgentEvent, type PluginAgentEventHandler,
  type PluginAgentEventKind,
} from './agent-events.js';
import { messagesFor, type MessageCallerScope, type ScopedMessages } from './messages-facade.js';
import { skillsFor, type ScopedSkills, type SkillCallerScope } from './skills-facade.js';
import { mcpServersFor, type McpServerCallerScope, type ScopedMcpServers } from './mcp-servers-facade.js';
import { backendCatalogFor, type CatalogCallerScope, type PluginBackendCatalog, type ScopedBackendCatalog } from './backends-facade.js';
import { agentCommunicationAllowed } from '../users/agent-permissions.js';
import { issueForPlugin, revokeForPlugin } from '../remote-mcp/facade.js';
import { PluginAdminError, type AdminCallerScope } from './admin-support.js';
import {
  accountsFor, type ScopedAccounts,
} from './accounts-facade.js';
import { backupFor, type ScopedBackup } from './backup-facade.js';
import { browserFor, type ScopedBrowser } from './browser-facade.js';
import {
  browserRecordingsFor, type ScopedBrowserRecordings,
} from './browser-recordings-facade.js';
import {
  isPluginBrowserRecordingEventKind, PLUGIN_BROWSER_RECORDING_EVENT_KINDS, subscribePluginBrowserRecordingEvent,
  type PluginBrowserRecordingEventHandler, type PluginBrowserRecordingEventKind,
} from './browser-recording-events.js';
import {
  browserAnnotationsFor, type ScopedBrowserAnnotations,
} from './browser-annotations-facade.js';
import {
  isPluginBrowserAnnotationEventKind, PLUGIN_BROWSER_ANNOTATION_EVENT_KINDS, subscribePluginBrowserAnnotationEvent,
  type PluginBrowserAnnotationEventHandler, type PluginBrowserAnnotationEventKind,
} from './browser-annotation-events.js';
import { docsFor, type ScopedDocs } from './docs-facade.js';
import { licenseFor, type ScopedLicense } from './license-facade.js';
import { modulesFor, type ScopedModules } from './modules-facade.js';
import { pluginsAdminFor, type ScopedPlugins } from './plugins-facade.js';
import {
  secretsAdminFor, type ScopedSecretsAdmin,
} from './secrets-admin-facade.js';
import {
  systemFor, type ScopedSystem,
} from './system-facade.js';
import {
  registerPluginWebhook, runAsPluginWebhookOwner, type PluginWebhookHandler, type PluginWebhookOwnerRun, type PluginWebhookPublisher,
} from './webhooks.js';
import type { WebhookFormatId } from './webhook-format-ids.js';
import {
  isPluginPermission,
  type PluginManifest,
  type PluginPermission,
  type PluginSetting,
} from './manifest.js';
import { PLUGIN_EVENT_KINDS, type PluginEventKind } from './contract/events.js';
import type { PluginPermission as ContractPluginPermission } from './contract/permissions.js';
import type { Equals } from '../type-equality.js';
import type { PluginAsyncEffectHandle, PluginEffect } from './contract/effects.js';
import type { PluginExecResult, PluginSettingValue, PluginSqlDatabase, PluginStorage } from './contract/core.js';
import type { PluginMcpToken, PluginMcpTokenInput, PluginMissionInput } from './contract/missions.js';
import type {
  PluginTodo, PluginTodoAttachment, PluginTodoAttachmentInput, PluginTodoInput, PluginTodoLink, PluginTodoLinkInput,
  PluginTodoListFilter, PluginTodoPatch, PluginTodoPromoteInput,
} from './contract/todos.js';
import type { PluginContext } from './contract/context.js';
import { guardPluginCallback } from '../kernel/rejection-guard.js';
import { apiError } from '../api-error.js';

export type { PluginUser } from './als.js';
export type {
  PluginTodoDeletedEvent, PluginTodoDoneEvent, PluginTodoEvent, PluginTodoEventKind, PluginTodoEventLink,
  PluginTodoEventMap, PluginTodoOrigin, PluginTodoResolvedEvent,
} from './todo-events.js';
export { PLUGIN_TODO_EVENT_KINDS } from './todo-events.js';
export type {
  PluginUiDocumentActor, PluginUiDocumentCreatedEvent, PluginUiDocumentEvent, PluginUiDocumentEventKind,
  PluginUiDocumentEventMap, PluginUiDocumentResolvedEvent,
} from './ui-document-events.js';
export { PLUGIN_UI_DOCUMENT_EVENT_KINDS } from './ui-document-events.js';
export type {
  PluginOwnUiDocument, PluginUiDocument, PluginUiDocumentErrorCode, PluginUiDocumentInput,
} from './ui-documents-facade.js';
export { PluginUiDocumentError } from './ui-documents-facade.js';
export type {
  PluginQuestionActor, PluginQuestionEvent, PluginQuestionEventKind, PluginQuestionEventMap,
  PluginQuestionPendingEvent, PluginQuestionResolvedEvent,
} from './question-events.js';
export { PLUGIN_QUESTION_EVENT_KINDS } from './question-events.js';
export type {
  PluginQuestion, PluginQuestionAnswer, PluginQuestionAnswerValue, PluginQuestionErrorCode, PluginQuestionItem, PluginQuestionListFilter,
  PluginQuestionOption, PluginQuestionOptionActor, PluginQuestionPlan, PluginQuestionResolution,
} from './questions-facade.js';
export { PluginQuestionError } from './questions-facade.js';
export type {
  PluginApprovalActor, PluginApprovalEvent, PluginApprovalEventKind, PluginApprovalEventMap,
  PluginApprovalPendingEvent, PluginApprovalResolvedEvent,
} from './approval-events.js';
export { PLUGIN_APPROVAL_EVENT_KINDS } from './approval-events.js';
export type {
  PluginApproval, PluginApprovalDecision, PluginApprovalErrorCode, PluginApprovalListFilter, PluginApprovalResolution,
} from './approvals-facade.js';
export { PluginApprovalError } from './approvals-facade.js';
export type {
  PluginNotification, PluginNotificationErrorCode, PluginNotificationListFilter,
} from './notifications-facade.js';
export { PluginNotificationError } from './notifications-facade.js';
export type {
  PluginMemoryActor, PluginMemoryEvent, PluginMemoryEventKind, PluginMemoryEventMap,
  PluginMemoryRuleAddedEvent, PluginMemoryRuleRemovedEvent, PluginMemoryRuleSnapshot,
} from '../memory-rule-events.js';
export { PLUGIN_MEMORY_EVENT_KINDS } from '../memory-rule-events.js';
export type {
  PluginMemoryErrorCode, PluginMemoryFile, PluginMemoryFileInfo, PluginMemoryOverview, PluginMemoryRule,
  PluginMemoryRuleFilter, PluginMemoryRuleInput, PluginMemorySearchResult, PluginMemoryTargetScope,
} from './memory-facade.js';
export { PluginMemoryError } from './memory-facade.js';
export type {
  PluginIslandsProposalInput, PluginLayoutErrorCode, PluginLayoutProposal, PluginLayoutProposalInput,
  PluginLayoutProposalKind, PluginLayoutReceipt, PluginLayoutSnapshot, PluginLayoutTarget, PluginNavProposalInput,
  PluginNavigateInput, PluginPresetInput, PluginWidgetsProposalInput,
} from './layout-facade.js';
export { PluginLayoutError } from './layout-facade.js';
export type {
  PluginCommandInput, PluginCommandReceipt, PluginCommandRequest, PluginMediaInput, PluginMediaShown,
} from './chat-facade.js';
export type {
  PluginOutboxEntry, PluginOutboxErrorCode, PluginOutboxMethod, PluginOutboxOptions, PluginOutboxTarget,
} from './outbox.js';
export { PluginOutboxError } from './outbox.js';
export type {
  PluginOwnTrigger, PluginTriggerCreated, PluginTriggerInfo, PluginTriggerInput, PluginTriggerTestOptions,
  PluginTriggerTestResult,
} from './triggers-facade.js';
export type { PluginRoutine, PluginRoutineInput, PluginRoutinePatch } from './routines-facade.js';
export { PLUGIN_AUTOMATION_EVENT_KINDS } from './automation-event-hub.js';
export type {
  PluginAutomationEvent, PluginAutomationEventKind, PluginAutomationEventMap, PluginPipelineEvent,
  PluginPipelineRunStartedEvent, PluginRoutineEvent, PluginTriggerEvent, PluginWorkflowRunEvent,
} from './automation-event-hub.js';
export type {
  PluginWorkflow, PluginWorkflowDetail, PluginWorkflowRun, PluginWorkflowRunStatus, PluginWorkflowRunSummary,
} from './workflows-facade.js';
export type {
  PluginOwnPipeline, PluginPipeline, PluginPipelineInput, PluginPipelineRun, PluginPipelineRunStatus, PluginPipelineStep,
} from './pipelines-facade.js';
export { PluginAutomationError } from './automation-scope.js';
export type { PluginAutomationErrorCode } from './automation-scope.js';
export type { PluginAgent, PluginAgentAvatar, PluginAgentErrorCode, PluginAgentInput, PluginAgentPatch } from './agents-facade.js';
export { PluginAgentError } from './agents-facade.js';
export type {
  PluginMissionErrorCode, PluginMissionFork, PluginMissionForkInput, PluginMissionSearchFilter,
  PluginMissionSearchResult, PluginMissionSendResult, PluginMissionSpawnOverrides, PluginMissionSummary,
  PluginStopReport, PluginStopScope, PluginTraceOptions,
} from './missions-facade.js';
export { PluginMissionError } from './missions-facade.js';
export type {
  PluginMissionEvent, PluginMissionEventKind, PluginMissionEventMap, PluginMissionOrigin,
  PluginMissionStartedEvent, PluginMissionTranscriptDeltaEvent, PluginMissionTranscriptEvent,
  PluginMissionTurnCompleteEvent,
  PluginMissionTitleChangedEvent,
} from './mission-events.js';
export { PLUGIN_MISSION_EVENT_KINDS } from './mission-events.js';
export type {
  PluginProject, PluginProjectErrorCode, PluginProjectInput, PluginProjectPatch, PluginProjectRoles,
  PluginProjectWarning, PluginProjectWrite, PluginRoleInput, PluginRoleSpec, PluginWorkspace,
} from './projects-facade.js';
export { PluginProjectError } from './projects-facade.js';
export type {
  PluginProjectCreatedEvent, PluginProjectEvent, PluginProjectEventKind, PluginProjectEventMap, PluginProjectOrigin,
  PluginProjectUpdatedEvent,
} from './project-events.js';
export { PLUGIN_PROJECT_EVENT_KINDS } from './project-events.js';
export type {
  PluginSeriesErrorCode, PluginSeriesFallbackInput, PluginSeriesFallbackResult, PluginSeriesRoleInput, PluginSeriesRule,
} from './series-facade.js';
export { PluginSeriesError } from './series-facade.js';
export type { PluginWorktree, PluginWorktreeErrorCode } from './worktrees-facade.js';
export { PluginWorktreeError } from './worktrees-facade.js';
export type { PluginAgentDoc } from './agent-docs-facade.js';
export type {
  PluginAgentCreatedEvent, PluginAgentDeletedEvent, PluginAgentEvent, PluginAgentEventKind, PluginAgentEventMap,
  PluginAgentOrigin, PluginAgentSnapshot, PluginAgentUpdatedEvent,
} from './agent-events.js';
export { PLUGIN_AGENT_EVENT_KINDS } from './agent-events.js';
export type {
  PluginMessage, PluginMessageErrorCode, PluginMessageInput, PluginMessageRecvOptions,
} from './messages-facade.js';
export { PluginMessageError } from './messages-facade.js';
export type {
  PluginSkill, PluginSkillErrorCode, PluginSkillSummary,
} from './skills-facade.js';
export { PluginSkillError } from './skills-facade.js';
export type {
  PluginMcpServer, PluginMcpServerErrorCode, PluginMcpServerInput, PluginMcpServerSummary,
} from './mcp-servers-facade.js';
export { PluginMcpServerError } from './mcp-servers-facade.js';
export type { PluginBackendCatalog } from './backends-facade.js';
export { PluginAdminError } from './admin-support.js';
export type { PluginAdminErrorCode } from './admin-support.js';
export type { PluginAccountUser, PluginBackendAccount } from './accounts-facade.js';
export type { PluginBackupArchive, PluginBackupStatus } from './backup-facade.js';
export type { PluginBrowserSession } from './browser-facade.js';
export type {
  PluginBrowserRecording, PluginBrowserRecordingDetail, PluginBrowserRecordingOp, PluginBrowserRecordingRef,
  PluginBrowserRecordingStep,
} from './browser-recordings-facade.js';
export type {
  PluginBrowserRecordingEvent, PluginBrowserRecordingEventKind, PluginBrowserRecordingEventMap,
} from './browser-recording-events.js';
export type {
  PluginBrowserAnnotation, PluginBrowserAnnotationDetail, PluginBrowserAnnotationFilter, PluginBrowserAnnotationRef,
  PluginBrowserAnnotationResolution,
} from './browser-annotations-facade.js';
export type {
  PluginBrowserAnnotationEvent, PluginBrowserAnnotationEventKind, PluginBrowserAnnotationEventMap,
} from './browser-annotation-events.js';
export type { PluginDocHit } from './docs-facade.js';
export type { PluginEdition } from './license-facade.js';
export type { PluginModuleInfo } from './modules-facade.js';
export type { PluginInfo } from './plugins-facade.js';
export type { PluginHttpCallInput, PluginHttpCallResult, PluginSecretInfo, PluginSecretInput } from './secrets-admin-facade.js';
export type { PluginDoctorReport, PluginLogKind, PluginLogsOptions, PluginSystemHealth } from './system-facade.js';
export type { PluginWebhookHandler, PluginWebhookOwnerRun, PluginWebhookOwnerSkip, PluginWebhookRequest } from './webhooks.js';
/** Re-exported so the SDK has one import site for the whole contract. */
export type { UsageCollector, UsageEntry } from '../usage.js';
export type { RegisteredProfile } from '../backends/registry.js';
export type { Dialect, RemoteDialect } from '../backends/types.js';

/** Mount prefix for plugin routes: `/api/plugins/<id>/…`. */
export const PLUGIN_ROUTE_PREFIX = '/api/plugins';

/**
 * Reserved prefix in `plugin_kv`. Manifest-declared settings share the table
 * with the plugin's free storage; this marker separates them, and the
 * `storage.kv` facade rejects keys carrying it. Otherwise a plugin could
 * rewrite its own settings — the ones users believe they control from
 * `/settings`.
 */
const SETTINGS_PREFIX = '@settings/';
const CONNECTION_SECRETS_PREFIX = '@connections/';

/** Thrown when a facade is called without the corresponding permission (§10.4). */
export class PluginPermissionError extends Error {
  constructor(readonly pluginId: string, readonly permission: PluginPermission) {
    super(
      `plugin \`${pluginId}\`: permission \`${permission}\` is missing from its manifest — `
      + `add it to \`permissions\` and reinstall the plugin.`,
    );
    this.name = 'PluginPermissionError';
  }
}

/** Thrown by `assertPermission` when the current caller is not allowed. */
export class PluginCallerError extends Error {
  constructor(readonly pluginId: string, readonly permission: string) {
    super(`plugin \`${pluginId}\`: caller is missing permission \`${permission}\``);
    this.name = 'PluginCallerError';
  }
}

// ── Liaisons vers le daemon ───────────────────────────────────────────────────

export type {
  PluginTask, PluginTaskDoneInput, PluginTaskErrorCode, PluginTaskFilter, PluginTaskInput, PluginTaskLink,
  PluginTaskLinkInput, PluginTaskPatch, TaskCallerScope, ScopedTasks,
} from './tasks-facade.js';
export { PluginTaskError } from './tasks-facade.js';
export type {
  PluginTaskAssignedEvent, PluginTaskCreatedEvent, PluginTaskDeletedEvent, PluginTaskEvent, PluginTaskEventKind,
  PluginTaskEventMap, PluginTaskOrigin, PluginTaskUnblockedEvent, PluginTaskUpdatedEvent,
} from './task-events.js';
export { PLUGIN_TASK_EVENT_KINDS } from './task-events.js';

export type PluginAdminHost = {
  system(scope: AdminCallerScope): ScopedSystem;
  modules(scope: AdminCallerScope): ScopedModules;
  license(scope: AdminCallerScope): ScopedLicense;
  docs(scope: AdminCallerScope): ScopedDocs;
  backup(scope: AdminCallerScope): ScopedBackup;
  browser(scope: AdminCallerScope): ScopedBrowser;
  browserRecordings(scope: AdminCallerScope): ScopedBrowserRecordings;
  browserAnnotations(scope: AdminCallerScope): ScopedBrowserAnnotations;
  plugins(scope: AdminCallerScope): ScopedPlugins;
  secrets(scope: AdminCallerScope): ScopedSecretsAdmin;
  accounts(scope: AdminCallerScope): ScopedAccounts;
};

/**
 * Bindings to the daemon. There is one real implementation (`daemonHost()`);
 * tests provide doubles.
 */
export type PluginHost = {
  realtime?: { publish: typeof publishPluginRealtime };
  /** Optional on legacy/test hosts; capabilities fail explicitly when unavailable. */
  integrations?: { open(pluginId: string, permissions: readonly PluginPermission[]): PluginIntegrationSession };
  /**
   * Mounts a router and returns a disposer (the kernel `http` service).
   * `owner` names the plugin in the log when one of its routes fails.
   */
  mountRouter(prefix: string, router: Router, owner?: string): () => void;
  kv: {
    get(pluginId: string, key: string): string | undefined;
    set(pluginId: string, key: string, value: string): void;
    del(pluginId: string, key: string): void;
    list(pluginId: string, prefix: string): { key: string; value: string }[];
  };
  missions: {
    spawn(input: PluginMissionInput & { channel: string; ownerUserId?: string | null }): Promise<string>;
    get(id: string, viewer: DbViewer | null): unknown;
    list(opts: { limit?: number; agents?: string[]; status?: string }, viewer: DbViewer | null): unknown[];
  };
  kanban: {
    create(input: PluginTaskInput, scope: TaskCallerScope): unknown;
    update(id: string, patch: PluginTaskPatch, scope: TaskCallerScope): unknown;
    list(status: string | undefined, scope: TaskCallerScope): unknown[];
  };
  /** The Kanban bounded by a caller (`tasks-facade.ts`). Optional on test hosts: the facade then fails explicitly. */
  tasks?: { open(scope: TaskCallerScope): ScopedTasks };
  /** Task lifecycle events filtered and projected for a plugin (`task-events.ts`). Optional on test hosts. */
  taskEvents?: {
    subscribe(pluginId: string, kind: PluginTaskEventKind, handler: PluginTaskEventHandler, readsProjects: boolean): () => void;
  };
  /** The TO DO notebook bounded by a caller. Optional on test hosts: the
   *  facade then fails explicitly. */
  todos?: { open(scope: TodoCallerScope): ScopedTodoApi };
  /** Triggers a plugin may retire (`triggers-facade.ts`). Optional on test hosts. */
  triggers?: { open(scope: TriggerCallerScope): ScopedTriggers };
  /** Routines a plugin may own (`routines-facade.ts`). Optional on test hosts. */
  routines?: { open(scope: RoutineCallerScope): ScopedRoutines };
  /** Pipelines a plugin may define and run (`pipelines-facade.ts`). Optional on test hosts. */
  pipelines?: { open(scope: PipelineCallerScope): ScopedPipelines };
  /** Automation lifecycle events filtered and projected for a plugin (`automation-event-hub.ts`). Optional on test hosts. */
  automationEvents?: {
    subscribe(pluginId: string, kind: PluginAutomationEventKind, handler: PluginAutomationEventHandler): () => void;
  };
  /** Workflows a plugin may run (`workflows-facade.ts`). Optional on test hosts. */
  workflowRuns?: { open(scope: WorkflowCallerScope): ScopedWorkflows };
  /** Agents a plugin may list, create and update (`agents-facade.ts`). Optional on test hosts. */
  agents?: { open(scope: AgentCallerScope): ScopedAgents };
  /** Control of existing missions and traces bounded by a caller (`missions-facade.ts`). Optional on test hosts. */
  missionControl?: { open(scope: MissionControlCallerScope): ScopedMissionControl };
  /** Mission lifecycle and transcript events filtered for a plugin (`mission-events.ts`). Optional on test hosts. */
  missionEvents?: {
    subscribe(pluginId: string, kind: PluginMissionEventKind, handler: PluginMissionEventHandler): () => void;
  };
  /** Projects, their poles and role pins (`projects-facade.ts`). Optional on test hosts. */
  projects?: { open(scope: ProjectCallerScope): ScopedProjects };
  /** Fallback plan and per-role LLM choices of a series (`series-facade.ts`). Optional on test hosts. */
  series?: { open(scope: SeriesCallerScope): ScopedSeries };
  /** Task worktrees (`worktrees-facade.ts`). Optional on test hosts. */
  worktrees?: { open(scope: WorktreeCallerScope): ScopedWorktrees };
  /** Browser recording events for a plugin (`browser-recording-events.ts`). Optional on test hosts. */
  browserRecordingEvents?: {
    subscribe(pluginId: string, kind: PluginBrowserRecordingEventKind, handler: PluginBrowserRecordingEventHandler): () => void;
  };
  /** Browser annotation events for a plugin (`browser-annotation-events.ts`). Optional on test hosts. */
  browserAnnotationEvents?: {
    subscribe(pluginId: string, kind: PluginBrowserAnnotationEventKind, handler: PluginBrowserAnnotationEventHandler): () => void;
  };
  /** Project events for a plugin (`project-events.ts`). Optional on test hosts. */
  projectEvents?: {
    subscribe(pluginId: string, kind: PluginProjectEventKind, handler: PluginProjectEventHandler): () => void;
  };
  /** Identity docs of the agents a plugin created (`agent-docs-facade.ts`). Optional on test hosts. */
  agentDocs?: { open(scope: AgentCallerScope): ScopedAgentDocs };
  /** Portable definition of any agent the account reads (`agent-export-facade.ts`). Optional on test hosts. */
  agentExport?: { open(scope: AgentCallerScope): ScopedAgentExport };
  /** Agent events filtered for a plugin (`agent-events.ts`). Optional on test hosts. */
  agentEvents?: {
    subscribe(pluginId: string, kind: PluginAgentEventKind, handler: PluginAgentEventHandler): () => void;
  };
  /** The inbox of the agents a plugin created (`messages-facade.ts`). Optional on test hosts. */
  messages?: { open(scope: MessageCallerScope): ScopedMessages };
  /** Timon skills (`skills-facade.ts`). Optional on test hosts. */
  skills?: { open(scope: SkillCallerScope): ScopedSkills };
  /** MCP server declarations (`mcp-servers-facade.ts`). Optional on test hosts. */
  mcpServers?: { open(scope: McpServerCallerScope): ScopedMcpServers };
  /** The LLM catalogue (`backends-facade.ts`). Optional on test hosts. */
  backendCatalog?: { open(scope: CatalogCallerScope): ScopedBackendCatalog };
  /**
   * Administration and system facades (API 10): one opener per entity, each
   * given who acts. Optional on test hosts.
   */
  admin?: PluginAdminHost;
  /** Remote MCP tokens (`remote-mcp/facade.ts`). Optional on test hosts. */
  mcp?: {
    issue(pluginId: string, input: PluginMcpTokenInput, viewer: DbViewer | null): Promise<PluginMcpToken>;
    revoke(pluginId: string, tokenId: string): boolean;
  };
  /** TO DO events filtered for a plugin (`todo-events.ts`). Optional on test hosts. */
  todoEvents?: {
    subscribe(pluginId: string, kind: PluginTodoEventKind, handler: PluginTodoEventHandler): () => void;
  };
  /** Screen arrangement, navigation and onboarding profile of an account (`layout-facade.ts`). Optional on test hosts. */
  layout?: { open(scope: LayoutCallerScope): ScopedLayout };
  /** Media and commands a plugin puts in a conversation (`chat-facade.ts`). Optional on test hosts. */
  chat?: { open(scope: ChatCallerScope): ScopedChat };
  /** HTML documents of a conversation bounded by a caller (`ui-documents-facade.ts`). Optional on test hosts. */
  uiDocuments?: { open(scope: UiDocumentCallerScope): ScopedUiDocuments };
  /** Document events filtered and projected for a plugin (`ui-document-events.ts`). Optional on test hosts. */
  uiDocumentEvents?: {
    subscribe(pluginId: string, kind: PluginUiDocumentEventKind, handler: PluginUiDocumentEventHandler): () => void;
  };
  /** Questions agents ask the human, bounded by a caller (`questions-facade.ts`). Optional on test hosts. */
  questions?: { open(scope: QuestionCallerScope): ScopedQuestions };
  /** Question events filtered and projected for a plugin (`question-events.ts`). Optional on test hosts. */
  questionEvents?: {
    subscribe(pluginId: string, kind: PluginQuestionEventKind, handler: PluginQuestionEventHandler): () => void;
  };
  /** Tool-use approvals waiting on a person, bounded by a caller (`approvals-facade.ts`). Optional on test hosts. */
  approvals?: { open(scope: ApprovalCallerScope): ScopedApprovals };
  /** Approval events filtered and projected for a plugin (`approval-events.ts`). Optional on test hosts. */
  approvalEvents?: {
    subscribe(pluginId: string, kind: PluginApprovalEventKind, handler: PluginApprovalEventHandler): () => void;
  };
  /** The notification centre, bounded by a caller (`notifications-facade.ts`). Optional on test hosts. */
  notifications?: { open(scope: NotificationCallerScope): ScopedNotifications };
  /** Memory rules and files bounded by a caller (`memory-facade.ts`). Optional on test hosts. */
  memory?: { open(scope: MemoryCallerScope): ScopedMemory };
  /** Rule events filtered for a plugin (`memory-rule-events.ts`). Optional on test hosts. */
  memoryEvents?: {
    subscribe(pluginId: string, kind: PluginMemoryEventKind, handler: PluginMemoryEventHandler): () => void;
  };
  /** Durable outgoing calls (`outbox.ts`). Optional on test hosts. */
  outbox?: PluginOutboxHost;
  /** Incoming webhooks verified by the host (`webhooks.ts`). Optional on test hosts. */
  webhooks?: {
    /**
     * `auth`: the manifest's signature format for this name (`standard` when
     * absent). `publisher`: the package loaded under the id, which a stored
     * secret must have been set for.
     */
    register(pluginId: string, name: string, handler: PluginWebhookHandler, auth?: WebhookFormatId, publisher?: PluginWebhookPublisher | null): () => void;
    /** Runs `fn` as a delivery of `name` would (`runAsPluginWebhookOwner`). */
    asOwner?<T>(pluginId: string, name: string, fn: () => T | Promise<T>): Promise<PluginWebhookOwnerRun<T>>;
  };
  notify(input: {
    type: 'report' | 'alert';
    title: string;
    body?: string | null;
    urgent?: boolean;
    source: string;
    ownerUserId?: string | null;
  }): void;
  /** Read-only bus subscription. Returns the disposer. */
  subscribe(kind: PluginEventKind, handler: (ev: unknown) => void): () => void;
  exec(bin: string, args: readonly string[], opts: { cwd?: string }): Promise<PluginExecResult>;
  fetch: typeof globalThis.fetch;
  /**
   * Destinations opened by an approved user connection (apiVersion 7). Absent
   * on test hosts: `ctx.fetch` then only knows the operator's allowlist.
   */
  destinations?: {
    approved(pluginId: string, url: URL): boolean;
    fetch(pluginId: string, input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response>;
  };
  /** Plugin working directory, created on demand. */
  dataDir(pluginId: string): string;
  /** HMAC key for UI tokens. */
  tokenKey(): Buffer;
  secrets: {
    /** A vault entry granted to this plugin, decrypted, or `undefined`. */
    get(pluginId: string, name: string): string | undefined;
  };
  usage: {
    /** `viewer` decides which subscription accounts are listed (none without one). */
    list(viewer: DbViewer | null, options?: UsageProbeOptions): Promise<UsageEntry[]>;
    get(backend: string, viewer: DbViewer | null, options?: UsageProbeOptions): Promise<UsageEntry | null>;
    /** Registers a plugin probe for a backend that has none. Returns the
     *  disposer; the facade wires it to the plugin's lifecycle. */
    registerCollector(pluginId: string, backend: string, collect: UsageCollector): () => void;
  };
  backends: {
    registerProfile(pluginId: string, profile: RegisteredProfile, trusted: boolean): () => void;
    registerDialect(pluginId: string, id: string, dialect: Dialect | RemoteDialect, options?: { strict?: boolean }): () => void;
  };
};

// ── The contract ──────────────────────────────────────────────────────────────

// Declared in `contract/` (leaf modules the SDK points at), re-exported so the
// daemon keeps one import site for the whole contract.
export { PLUGIN_EVENT_KINDS } from './contract/events.js';
export type { PluginEventKind } from './contract/events.js';
export type {
  PluginAsyncEffect, PluginAsyncEffectHandle, PluginDisposer, PluginEffect, PluginEffectHandle, PluginSyncEffect,
} from './contract/effects.js';
export type { PluginExecResult, PluginLog, PluginSettingValue, PluginSqlDatabase, PluginSqlStatement, PluginStorage } from './contract/core.js';
export type { PluginSecrets } from './contract/secrets.js';
export type {
  PluginTodo, PluginTodoAttachment, PluginTodoAttachmentInput, PluginTodoErrorCode, PluginTodoInput, PluginTodoLink,
  PluginTodoLinkInput, PluginTodoListFilter, PluginTodoPatch, PluginTodoPromoteInput, PluginTodos,
} from './contract/todos.js';
export type { PluginMcpToken, PluginMcpTokenInput, PluginMissionInput } from './contract/missions.js';
export type {
  PluginMcpServers, PluginMessages, PluginNotifications, PluginOutbox, PluginQuestions, PluginSkills, PluginUiDocuments,
} from './contract/facades.js';
export type { PluginContext } from './contract/context.js';

export type PluginSpec = {
  manifest: PluginManifest;
  /** Npm package version, used in logs and `/api/capabilities`. */
  version: string;
  config?: Record<string, unknown>;
  /** Shipped with the product (`builtin.ts`): a fixed licence composition does not revoke it. */
  builtin?: boolean;
  /** The package loaded under this id (`webhookPublisherOf`); its webhook secrets are bound to it. */
  publisher?: PluginWebhookPublisher;
  /** The plugin's own database, opened and migrated by the loader before `apply` (API 15). */
  sqlDb?: PluginSqlDatabase;
};

// ── Construction ──────────────────────────────────────────────────────────────

/**
 * Cordis context under which the loader (P.3) mounts a third-party plugin: all
 * registry services are isolated and therefore unavailable. Only context
 * instance properties (events, logger, registry) remain; they carry the fiber
 * lifecycle, and the plugin cannot see them because this is not the context it
 * receives.
 */
export function isolateForPlugin(root: Context): Context {
  const props = (root as unknown as { reflect: { props: Record<string, { type: string }> } }).reflect.props;
  let ctx = root;
  for (const [name, prop] of Object.entries(props)) {
    if (prop.type === 'service') ctx = ctx.isolate(name);
  }
  return ctx;
}

function settingDecl(manifest: PluginManifest, key: string): PluginSetting | undefined {
  return manifest.settings.find((s) => s.key === key);
}

/**
 * Builds a plugin contract. `ctx` is the Cordis fiber that carries it: it is
 * used only for lifecycle management (effects, routes), never for resolving a
 * service — the plugin does not receive it.
 */
export function createPluginContext(
  ctx: Context,
  spec: PluginSpec,
  host: PluginHost,
): PluginContext {
  const id = spec.manifest.id;
  const granted = new Set<PluginPermission>(spec.manifest.permissions);
  const prefix = `[plugin:${id}]`;

  const can = (p: PluginPermission) => granted.has(p);
  const composition = () => { if (!spec.builtin) assertCompositionMutable(licenseState()); };
  const assert = (p: PluginPermission) => {
    composition();
    if (!granted.has(p)) throw new PluginPermissionError(id, p);
  };
  const assertPermission = (permission: string) => {
    composition();
    if (isPluginPermission(permission) && !granted.has(permission)) {
      throw new PluginPermissionError(id, permission);
    }
    if (!pluginCallerAllows(currentPluginViewer(id), permission)) {
      throw new PluginCallerError(id, permission);
    }
  };

  // Caller, owner and plugin come from here, never from the arguments: the
  // scoped API is reopened per call because the caller changes per request.
  const todoScope = (permission: PluginPermission): TodoCallerScope => {
    assert(permission);
    return { viewer: currentPluginViewer(id), ownerUserId: currentPluginOwnerUserId(id), pluginId: id };
  };
  const todos = (permission: PluginPermission): ScopedTodoApi => {
    const scope = todoScope(permission);
    if (!host.todos) throw new Error('TO DO host unavailable');
    return host.todos.open(scope);
  };

  // Who acts, from the context only. A job reads beyond its own tasks only the
  // projects the operator granted it, and only if the manifest asks for it.
  const taskScope = (): TaskCallerScope => {
    const owner = currentPluginOwnerUserId(id);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    return {
      pluginId: id, viewer, ownerUserId: owner, job,
      unattended: job || pluginCallUnattended(),
      superadmin: !job && viewer?.isSuperadmin === true,
      projects: job && can('kanban:read:project') ? grantedKanbanProjects(id) : [],
    };
  };
  const tasks = (permission: PluginPermission): ScopedTasks => {
    assert(permission);
    if (!host.tasks) throw new Error('Task host unavailable');
    return host.tasks.open(taskScope());
  };

  const uiDocuments = (permission: PluginPermission): ScopedUiDocuments => {
    assert(permission);
    if (!host.uiDocuments) throw new Error('UI documents host unavailable');
    return host.uiDocuments.open({ pluginId: id, viewer: currentPluginViewer(id) });
  };

  const callerAccount = (): string | null => currentPluginUser()?.id ?? null;
  const questions = (permission: PluginPermission): ScopedQuestions => {
    assert(permission);
    if (!host.questions) throw new Error('Questions host unavailable');
    return host.questions.open({ pluginId: id, viewer: currentPluginViewer(id), decidedByUserId: callerAccount() });
  };
  const approvals = (permission: PluginPermission): ScopedApprovals => {
    assert(permission);
    if (!host.approvals) throw new Error('Approvals host unavailable');
    return host.approvals.open({ pluginId: id, viewer: currentPluginViewer(id), decidedByUserId: callerAccount() });
  };

  const notifications = (permission: PluginPermission): ScopedNotifications => {
    assert(permission);
    if (!host.notifications) throw new Error('Notifications host unavailable');
    return host.notifications.open({ pluginId: id, viewer: currentPluginViewer(id) });
  };

  const missionControl = (permission: PluginPermission): ScopedMissionControl => {
    assert(permission);
    if (!host.missionControl) throw new Error('Mission control host unavailable');
    return host.missionControl.open({ pluginId: id, viewer: currentPluginViewer(id), transcript: can('missions:transcript') });
  };

  // The account of the REQUEST, reopened per call like the other facades: a job has none.
  const layout = (permission: PluginPermission): ScopedLayout => {
    assert(permission);
    if (!host.layout) throw new Error('Layout host unavailable');
    return host.layout.open({ pluginId: id, viewer: currentPluginViewer(id), ownerUserId: currentPluginOwnerUserId(id) });
  };
  const chat = (permission: PluginPermission): ScopedChat => {
    assert(permission);
    if (!host.chat) throw new Error('Chat host unavailable');
    return host.chat.open({ pluginId: id, viewer: currentPluginViewer(id), ownerUserId: currentPluginOwnerUserId(id) });
  };

  // `triggers:disable` is the API 6 door and keeps its rules; the others (API 10)
  // are the account's `triggers:manage` in a request, like the triggers routes.
  const triggers = (anyOf: readonly PluginPermission[], account: boolean): ScopedTriggers => {
    composition();
    const held = anyOf.find((p) => can(p));
    if (!held) throw new PluginPermissionError(id, anyOf[0]!);
    const owner = currentPluginOwnerUserId(id);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (account) {
      if (!owner) throw new PluginCallerError(id, held);
      if (!job && !pluginCallerAllows(viewer, 'triggers:manage')) throw new PluginCallerError(id, 'triggers:manage');
    }
    if (!host.triggers) throw new Error('Trigger host unavailable');
    return host.triggers.open({
      viewer, pluginId: id, job, superadmin: !job && viewer?.isSuperadmin === true, declared: [...granted],
    });
  };
  const TRIGGER_READ: readonly PluginPermission[] = ['triggers:read', 'triggers:write', 'triggers:execute'];

  // Routines open Kanban tasks: writing one also takes `kanban:write`, declared
  // and — in a request — held by the caller.
  const routines = (write: boolean, opensTasks: boolean): ScopedRoutines => {
    composition();
    const wanted: PluginPermission = write ? 'routines:write' : 'routines:read';
    if (!can('routines:write') && (write || !can('routines:read'))) throw new PluginPermissionError(id, wanted);
    if (opensTasks && !can('kanban:write')) throw new PluginPermissionError(id, 'kanban:write');
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (opensTasks && !job && !pluginCallerAllows(viewer, 'kanban:write')) throw new PluginCallerError(id, 'kanban:write');
    if (!host.routines) throw new Error('Routine host unavailable');
    return host.routines.open({
      pluginId: id, viewer, job, superadmin: !job && viewer?.isSuperadmin === true, declared: [...granted],
    });
  };

  // Pipelines: `write` (a definition) opens no task; `run` does, hence `kanban:write`.
  const pipelines = (level: 'read' | 'write' | 'run'): ScopedPipelines => {
    composition();
    const wanted: PluginPermission = `pipelines:${level}`;
    const ok = level === 'read' ? can('pipelines:read') || can('pipelines:write') || can('pipelines:run') : can(wanted);
    if (!ok) throw new PluginPermissionError(id, wanted);
    if (level === 'run' && !can('kanban:write')) throw new PluginPermissionError(id, 'kanban:write');
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (level === 'run' && !job && !pluginCallerAllows(viewer, 'kanban:write')) throw new PluginCallerError(id, 'kanban:write');
    if (!host.pipelines) throw new Error('Pipeline host unavailable');
    return host.pipelines.open({
      pluginId: id, viewer, job, unattended: job || pluginCallUnattended(),
      superadmin: !job && viewer?.isSuperadmin === true, declared: [...granted],
    });
  };

  // Workflows: reading is `workflows:read`; starting or cancelling is
  // `workflows:run`, which an account must hold as well in a request.
  const workflowRuns = (level: 'read' | 'run'): ScopedWorkflows => {
    composition();
    const wanted: PluginPermission = `workflows:${level}`;
    const ok = level === 'read' ? can('workflows:read') || can('workflows:run') : can('workflows:run');
    if (!ok) throw new PluginPermissionError(id, wanted);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const viewer = currentPluginViewer(id);
    if (level === 'run' && owner !== `plugin:${id}` && !pluginCallerAllows(viewer, 'workflows:run')) {
      throw new PluginCallerError(id, 'workflows:run');
    }
    if (!host.workflowRuns) throw new Error('Workflow host unavailable');
    return host.workflowRuns.open({ pluginId: id, viewer, unattended: pluginCallUnattended() });
  };

  // `agents:manage` covers reading too, as it does for an account.
  const agents = (write: boolean): ScopedAgents => {
    composition();
    const wanted: PluginPermission = write ? 'agents:manage' : 'agents:read';
    if (!can('agents:manage') && (write || !can('agents:read'))) throw new PluginPermissionError(id, wanted);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    // A job, or a webhook/integration callback acting as the plugin itself.
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (!job) {
      const rights = write ? ['agents:manage'] : ['agents:read', 'agents:manage'];
      if (!rights.some((r) => pluginCallerAllows(viewer, r))) throw new PluginCallerError(id, wanted);
    }
    if (!host.agents) throw new Error('Agent host unavailable');
    return host.agents.open({ pluginId: id, job, superadmin: !job && viewer?.isSuperadmin === true, viewer: job ? null : viewer });
  };

  // `agents:manage` covers reading too (an account that manages may read).
  const memory = (write: boolean): ScopedMemory => {
    composition();
    const wanted: PluginPermission = write ? 'memory:write' : 'memory:read';
    assert(wanted);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (!job) {
      const rights = write ? ['agents:manage'] : ['agents:read', 'agents:manage'];
      if (!rights.some((r) => pluginCallerAllows(viewer, r))) throw new PluginCallerError(id, wanted);
    }
    if (!host.memory) throw new Error('Memory host unavailable');
    return host.memory.open({ pluginId: id, job, superadmin: !job && viewer?.isSuperadmin === true, viewer });
  };

  // `projects:manage` covers reading too. A request needs the same right on its
  // account to write; reading the project list needs only an authenticated caller.
  const projects = (write: boolean): ScopedProjects => {
    composition();
    const wanted: PluginPermission = write ? 'projects:manage' : 'projects:read';
    if (!can('projects:manage') && (write || !can('projects:read'))) throw new PluginPermissionError(id, wanted);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    const mayManage = can('projects:manage') && (job || pluginCallerAllows(viewer, 'projects:manage'));
    if (write && !mayManage) throw new PluginCallerError(id, wanted);
    if (!host.projects) throw new Error('Project host unavailable');
    return host.projects.open({ pluginId: id, job, superadmin: !job && viewer?.isSuperadmin === true, manage: mayManage });
  };

  // An anonymous first-run request has a null viewer, which the scoped reads treat as "unscoped": refused here.
  const ownedCaller = (permission: PluginPermission): DbViewer | null => {
    if (!currentPluginOwnerUserId(id)) throw new PluginCallerError(id, permission);
    return currentPluginViewer(id);
  };

  const series = (write: boolean): ScopedSeries => {
    composition();
    const wanted: PluginPermission = write ? 'series:manage' : 'series:read';
    if (!can('series:manage') && (write || !can('series:read'))) throw new PluginPermissionError(id, wanted);
    const viewer = ownedCaller(wanted);
    if (!host.series) throw new Error('Series host unavailable');
    return host.series.open({ pluginId: id, viewer });
  };

  const worktrees = (write: boolean): ScopedWorktrees => {
    composition();
    const wanted: PluginPermission = write ? 'worktrees:manage' : 'worktrees:read';
    if (!can('worktrees:manage') && (write || !can('worktrees:read'))) throw new PluginPermissionError(id, wanted);
    const viewer = ownedCaller(wanted);
    if (!host.worktrees) throw new Error('Worktree host unavailable');
    return host.worktrees.open({ pluginId: id, viewer });
  };
  /**
   * Who acts, for the facades of API 10: the permission is declared, an
   * anonymous request is refused, and the account of a request holds one of
   * `rights` (none = any signed-in account). A job acts as the plugin itself.
   */
  const caller = (permission: PluginPermission, rights: readonly string[] = []) => {
    assert(permission);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, permission);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (!job && rights.length > 0 && !rights.some((right) => pluginCallerAllows(viewer, right))) {
      throw new PluginCallerError(id, permission);
    }
    return { pluginId: id, job, superadmin: !job && viewer?.isSuperadmin === true, viewer: job ? null : viewer };
  };
  /** The inbox rule of the route: communication is opt-out, per action. */
  const mayCommunicate = (permission: PluginPermission, action: 'messages:send' | 'messages:read') => {
    const who = caller(permission);
    const viewer = who.viewer;
    if (viewer && !agentCommunicationAllowed({ is_superadmin: viewer.isSuperadmin }, viewer.permissions ?? [], action)) {
      throw new PluginCallerError(id, permission);
    }
    return who;
  };
  const agentDocs = (write: boolean): ScopedAgentDocs => {
    const permission: PluginPermission = write ? 'agents:docs:write' : 'agents:docs:read';
    const who = caller(permission, write ? ['agents:manage'] : ['agents:read', 'agents:manage']);
    if (!host.agentDocs) throw new Error('Agent docs host unavailable');
    return host.agentDocs.open(who);
  };
  // A request only: an export always has an account behind it, which must
  // be allowed to read agents. A job has none, so it is refused.
  const agentExport = (): ScopedAgentExport => {
    composition();
    const who = caller('agents:export', ['agents:read', 'agents:manage']);
    if (who.job) throw new PluginCallerError(id, 'agents:export');
    if (!host.agentExport) throw new Error('Agent export host unavailable');
    return host.agentExport.open(who);
  };
  const messages = (write: boolean): ScopedMessages => {
    const who = write ? mayCommunicate('messages:send', 'messages:send') : mayCommunicate('messages:read', 'messages:read');
    if (!host.messages) throw new Error('Messages host unavailable');
    return host.messages.open(who);
  };
  const skills = (write: boolean): ScopedSkills => {
    const who = write ? caller('skills:write', ['skills:manage']) : caller('skills:read');
    if (!host.skills) throw new Error('Skills host unavailable');
    return host.skills.open(who);
  };
  const mcpServers = (write: boolean): ScopedMcpServers => {
    const who = write ? caller('mcp-servers:write', ['mcp:manage']) : caller('mcp-servers:read');
    if (!host.mcpServers) throw new Error('MCP servers host unavailable');
    return host.mcpServers.open(who);
  };
  const backendCatalog = (): ScopedBackendCatalog => {
    const who = caller('backends:read');
    if (!host.backendCatalog) throw new Error('Backend catalogue host unavailable');
    return host.backendCatalog.open({ viewer: who.viewer });
  };
  // Administration and system (API 10). Same order of refusals as `agents`:
  // manifest, anonymous, then what the caller's account must hold. `manifest`
  // lists the permissions any of which opens the call (a `:manage` covers its
  // `:read`); `account` the rights a request's caller must hold one of;
  // `superadmin` and `job: false` close the call to a non-superadmin request
  // and to the plugin acting alone.
  const adminScope = (rule: {
    manifest: readonly PluginPermission[];
    account?: readonly string[];
    superadmin?: boolean;
    job?: boolean;
  }): AdminCallerScope => {
    composition();
    const wanted = rule.manifest[0]!;
    if (!rule.manifest.some(can)) throw new PluginPermissionError(id, wanted);
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new PluginCallerError(id, wanted);
    const job = owner === `plugin:${id}`;
    const viewer = currentPluginViewer(id);
    if (job) {
      // The plugin acting alone has no human behind it.
      if (rule.job === false) throw new PluginCallerError(id, wanted);
      return { pluginId: id, job: true, viewer, userId: null, superadmin: false };
    }
    if (!viewer) throw new PluginCallerError(id, wanted);
    if (rule.superadmin && viewer.isSuperadmin !== true) throw new PluginCallerError(id, 'superadmin');
    if (rule.account && !rule.account.some((r) => pluginCallerAllows(viewer, r))) throw new PluginCallerError(id, rule.account[0]!);
    return { pluginId: id, job: false, viewer, userId: owner, superadmin: viewer.isSuperadmin === true };
  };
  const admin = (): PluginAdminHost => {
    if (!host.admin) throw new Error('Administration host unavailable');
    return host.admin;
  };
  // Accounts, roles, groups and subscription accounts are one family: a
  // superadmin's request, never the plugin acting alone.
  const accountsScope = (level: 'read' | 'write'): AdminCallerScope =>
    adminScope({
      manifest: level === 'read' ? ['accounts:read', 'accounts:manage'] : ['accounts:manage'],
      superadmin: true,
      job: false,
    });

  let integrationSession: PluginIntegrationSession | undefined;
  let integrationClosed = false;
  ctx.effect(() => () => { integrationClosed = true; integrationSession?.dispose(); });
  const integration = (permission: PluginPermission): PluginIntegrationSession => {
    assert(permission);
    if (integrationClosed) throw new Error('Plugin integration session was unloaded');
    // Jobs act as this plugin. Requests and callbacks retain their own user.
    if (currentPluginOwnerUserId(id) !== `plugin:${id}`) assertPermission(permission);
    if (!host.integrations) throw new Error('Integration host unavailable');
    return integrationSession ??= host.integrations.open(id, [...granted]);
  };
  // A plugin reads one account's connections. Inside a request that account
  // must be the caller: the owner is never picked on behalf of someone else.
  const connectionOwner = (ownerUserId: string): string => {
    const caller = currentPluginOwnerUserId(id);
    if (typeof ownerUserId !== 'string' || !ownerUserId) throw new Error('An owner user id is required');
    if (caller && caller !== `plugin:${id}` && caller !== ownerUserId) throw new PluginCallerError(id, 'connections:users:read');
    return ownerUserId;
  };
  const userConnections = (permission: PluginPermission): PluginIntegrationSession => {
    assert(permission);
    if (integrationClosed) throw new Error('Plugin integration session was unloaded');
    if (!host.integrations) throw new Error('Integration host unavailable');
    return integrationSession ??= host.integrations.open(id, [...granted]);
  };
  const integrationOwner = (): string => {
    const owner = currentPluginOwnerUserId(id);
    if (!owner) throw new Error('Integration requires an authenticated owner');
    return owner;
  };

  const kvKey = (key: string): string => {
    if (typeof key !== 'string' || key === '') throw new Error(`plugin \`${id}\`: storage key is empty`);
    // Free storage and settings share a table; without this refusal, a plugin
    // could rewrite settings that users believe they control.
    if (key.startsWith(SETTINGS_PREFIX)) {
      throw new Error(`plugin \`${id}\`: prefix \`${SETTINGS_PREFIX}\` is reserved for manifest settings`);
    }
    // Same table again: user connection secrets are read through their facade only.
    if (key.startsWith(CONNECTION_SECRETS_PREFIX)) throw new Error(`plugin \`${id}\`: prefix \`${CONNECTION_SECRETS_PREFIX}\` is reserved`);
    return key;
  };

  const storage: PluginStorage = {
    kv: {
      async get<T = unknown>(key: string): Promise<T | undefined> {
        assert('storage');
        const raw = host.kv.get(id, kvKey(key));
        return raw === undefined ? undefined : (JSON.parse(raw) as T);
      },
      async set(key: string, value: unknown): Promise<void> {
        assert('storage');
        host.kv.set(id, kvKey(key), JSON.stringify(value ?? null));
      },
      async del(key: string): Promise<void> {
        assert('storage');
        host.kv.del(id, kvKey(key));
      },
      async list(p = ''): Promise<{ key: string; value: unknown }[]> {
        assert('storage');
        return host.kv
          .list(id, p)
          .filter((r) => !r.key.startsWith(SETTINGS_PREFIX) && !r.key.startsWith(CONNECTION_SECRETS_PREFIX))
          .map((r) => ({ key: r.key, value: JSON.parse(r.value) as unknown }));
      },
    },
    get dir(): string {
      assert('storage');
      return host.dataDir(id);
    },
  };

  const pluginContext: PluginContext = {
    businessEvents: {
      register(definition) { return integration('events:register').registerEvent(definition); },
      async publish(type, input, options = {}) {
        return integration('events:publish').publishEvent(integrationOwner(), type, input, options.connectionId);
      },
    },
    workflows: {
      registerTrigger(definition) { return integration('workflows:triggers:register').registerTrigger(definition); },
      registerExecutor(definition) { return integration('workflows:executors:register').registerExecutor(definition); },
      async list() { return workflowRuns('read').list(); },
      async get(workflowId: string) { return workflowRuns('read').get(workflowId); },
      async run(workflowId: string, input?: unknown) { return workflowRuns('run').run(workflowId, input); },
      async status(runId: string) { return workflowRuns('read').status(runId); },
      async cancel(runId: string) { return workflowRuns('run').cancel(runId); },
    },
    transports: {
      register(definition) { return integration('transports:register').registerTransport(definition); },
    },
    connections: {
      async create(input) { return integration('connections:write').createConnection(integrationOwner(), input); },
      async get(connectionId) { return integration('connections:read').getConnection(integrationOwner(), connectionId); },
      async list() { return integration('connections:read').listConnections(integrationOwner()); },
      async receipts(connectionId, options) { return integration('connections:read').connectionReceipts(integrationOwner(), connectionId, options); },
      async update(connectionId, patch) { return integration('connections:write').updateConnection(integrationOwner(), connectionId, patch); },
      async inboundPath(connectionId) {
        const connection = integration('connections:read').getConnection(integrationOwner(), connectionId);
        if (!connection) throw new Error('Connection not found');
        return `/api/integrations/${connection.id}/inbound`;
      },
      // A type is a declaration, not data: no caller grant, like a transport.
      registerType(definition) { return userConnections('connections:register').registerConnectionType(definition); },
      async forUser(ownerUserId) { return userConnections('connections:users:read').listUserConnections(connectionOwner(ownerUserId)); },
      async userSecret(ownerUserId, connectionId, name) {
        return userConnections('connections:users:read').userConnectionSecret(connectionOwner(ownerUserId), connectionId, name);
      },
    },
    id,
    version: spec.version,
    permissions: [...granted],
    config: spec.config ?? {},
    log: {
      info: (...a: unknown[]) => console.log(prefix, ...a),
      warn: (...a: unknown[]) => console.warn(prefix, ...a),
      error: (...a: unknown[]) => console.error(prefix, ...a),
    },
    can,
    assert,
    assertPermission,
    user: () => currentPluginUser(),
    router(prefix = `${PLUGIN_ROUTE_PREFIX}/${id}`): Router {
      if (prefix !== `${PLUGIN_ROUTE_PREFIX}/${id}` && (!spec.builtin || !/^\/api\/backends\/[a-z][a-z0-9-]*$/.test(prefix))) {
        throw new PluginPolicyError(id, 'route-prefix', 'Only a plugin shipped in the release can preserve a legacy backend endpoint');
      }
      const router = express.Router();
      router.use((req, res, next) => {
        try { composition(); }
        catch { res.status(403).json({ error: 'plugin_composition_fixed' }); return; }
        const identity = identityFromRequest(req);
        runPluginRequest(identity, () => {
          // Same curtain as gallery / client.js (M.4): a hidden plugin
          // does not confirm its API exists. 404, not 403.
          if (!(spec.builtin && prefix !== `${PLUGIN_ROUTE_PREFIX}/${id}`) && !thirdPartyPluginVisible(identity.viewer, id)) {
            res.status(404).json(apiError('plugin_unknown', 'unknown plugin'));
            return;
          }
          next();
        });
      });
      const remove = host.mountRouter(prefix, router, `plugin:${id}`);
      ctx.effect(() => remove);
      // Audio blocks of a daemon dictation engine: the parser must refuse an
      // oversized one before reading it, the plugin can only check it after.
      // A caller who may not see the plugin keeps the general limit, so a 413
      // does not confirm a hidden plugin exists (the router answers 404).
      if (prefix === `${PLUGIN_ROUTE_PREFIX}/${id}` && spec.manifest.dictation?.engines.some((engine) => engine.runtime === 'daemon')) {
        const unregister = registerRouteBodyLimit(id, (req) => (
          thirdPartyPluginVisible(identityFromRequest(req).viewer, id) ? DICTATION_DAEMON_BODY_LIMIT : undefined
        ));
        ctx.effect(() => unregister);
      }
      return router;
    },
    effect(fn: () => PluginEffect | void): PluginAsyncEffectHandle {
      // Cordis requires an effect body; a plugin returning nothing is valid
      // (an effect with no resource to release), so fill it rather than refuse.
      // The body then passes VERBATIM to the kernel: promise, iterable, and
      // async disposer retain the exact `ctx.effect` semantics.
      return ctx.effect(() => fn() ?? (() => { /* nothing to release */ })) as PluginAsyncEffectHandle;
    },
    storage,
    accountProvider: createAccountProviderFacade({
      pluginId: id,
      assertPermission: () => assert('accounts:provision'),
      trusted: spec.builtin === true || spec.publisher?.trust === 'signed' || spec.publisher?.trust === 'builtin',
      onUnload: (fn) => { ctx.effect(() => fn); },
      declared: granted.has('accounts:provision'),
      callerUserId: () => {
        const owner = currentPluginOwnerUserId(id);
        return owner && owner !== `plugin:${id}` ? owner : null;
      },
    }),
    permissionSource: createPermissionSourceFacade({
      pluginId: id,
      assertPermission: () => assert('accounts:permissions-source'),
      trusted: spec.builtin === true || spec.publisher?.trust === 'signed' || spec.publisher?.trust === 'builtin',
      onUnload: (fn) => { ctx.effect(() => fn); },
    }),
    sql: {
      // Checked at the call, like `storage.kv`: the facade itself is always there.
      prepare(sql: string) {
        assert('storage:sql');
        if (!spec.sqlDb) throw new Error(`plugin \`${id}\`: its database is not open`);
        return spec.sqlDb.prepare(sql);
      },
      transaction<T>(fn: () => T): T {
        assert('storage:sql');
        if (!spec.sqlDb) throw new Error(`plugin \`${id}\`: its database is not open`);
        return spec.sqlDb.transaction(fn);
      },
    },
    settings: {
      get(key: string): PluginSettingValue {
        assert('settings');
        const decl = settingDecl(spec.manifest, key);
        // An undeclared setting is a plugin error, not a missing value: without
        // this check it would read `undefined` without knowing the key can never
        // appear in `/settings`.
        if (!decl) throw new Error(`plugin \`${id}\`: setting \`${key}\` is not declared in the manifest`);
        const kvKey = `${SETTINGS_PREFIX}${key}`;
        const raw = host.kv.get(id, kvKey);
        if (raw === undefined) return decl.default;
        if (decl.type === 'secret') {
          const json = openPluginKvValue(id, kvKey, raw, (sealed) => host.kv.set(id, kvKey, sealed));
          return JSON.parse(json) as PluginSettingValue;
        }
        return JSON.parse(raw) as PluginSettingValue;
      },
    },
    secrets: {
      async get(name: string): Promise<string | undefined> {
        assert('secrets:read');
        // The scope is imposed by the daemon, never named by the caller: a
        // plugin asks for a name and the grants decide whether it exists.
        return host.secrets.get(id, name);
      },
      async list() {
        return admin().secrets(adminScope({ manifest: ['secrets:list', 'secrets:manage'], account: ['secrets:manage'] })).list();
      },
      async set(input) {
        return admin().secrets(adminScope({ manifest: ['secrets:manage'], account: ['secrets:manage'] })).set(input);
      },
      async grant(name, scope) {
        return admin().secrets(adminScope({ manifest: ['secrets:manage'], superadmin: true, job: false })).grant(name, scope);
      },
      async revoke(name, scope) {
        return admin().secrets(adminScope({ manifest: ['secrets:manage'], superadmin: true, job: false })).revoke(name, scope);
      },
      async httpCall(request) {
        const who = adminScope({ manifest: ['secrets:broker'], account: ['secrets:broker', 'secrets:manage'] });
        // The broker reaches the network for the plugin: it answers to the same
        // permission as `ctx.fetch` (TODO #531, 4-B).
        assert('http:outbound');
        return admin().secrets(who).httpCall(request);
      },
    },
    users: {
      async list() { return admin().accounts(accountsScope('read')).users.list(); },
      async get(userId) { return admin().accounts(accountsScope('read')).users.get(userId); },
      async setStatus(userId, status) { return admin().accounts(accountsScope('write')).users.setStatus(userId, status); },
    },
    backendAccounts: {
      async list() { return admin().accounts(accountsScope('read')).backendAccounts.list(); },
      async grant(accountId, userIds) { return admin().accounts(accountsScope('write')).backendAccounts.grant(accountId, userIds); },
      async revoke(accountId, userIds) { return admin().accounts(accountsScope('write')).backendAccounts.revoke(accountId, userIds); },
    },
    plugins: {
      async list() { return admin().plugins(adminScope({ manifest: ['plugins:read', 'plugins:manage'] })).list(); },
      async setEnabled(pluginId, enabled) {
        return admin().plugins(adminScope({ manifest: ['plugins:manage'], job: false })).setEnabled(pluginId, enabled);
      },
    },
    modules: {
      async list() { return admin().modules(adminScope({ manifest: ['plugins:read', 'plugins:manage'] })).list(); },
    },
    system: {
      async health() { return admin().system(adminScope({ manifest: ['system:read'] })).health(); },
      async doctor() { return admin().system(adminScope({ manifest: ['system:read'], superadmin: true })).doctor(); },
      async logs(options) {
        return admin().system(adminScope({ manifest: ['system:logs'], superadmin: true, job: false })).logs(options);
      },
    },
    backup: {
      async status() { return admin().backup(adminScope({ manifest: ['backup:read', 'backup:manage'], superadmin: true })).status(); },
      async enable() { return admin().backup(adminScope({ manifest: ['backup:manage'], superadmin: true })).enable(); },
    },
    browser: {
      async list() { return admin().browser(adminScope({ manifest: ['browser:read', 'browser:manage'] })).list(); },
      async status(project) { return admin().browser(adminScope({ manifest: ['browser:read', 'browser:manage'] })).status(project); },
      async start(project) { return admin().browser(adminScope({ manifest: ['browser:manage'] })).start(project); },
      async stop(project) { return admin().browser(adminScope({ manifest: ['browser:manage'] })).stop(project); },
    },
    // A recording is a person's: never the plugin acting alone.
    browserRecordings: {
      async list(filter) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:read', 'browser:recordings:write'], job: false })).list(filter); },
      async get(recordingId) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:read', 'browser:recordings:write'], job: false })).get(recordingId); },
      async patch(recordingId, ops) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:write'], job: false })).patch(recordingId, ops); },
      async delete(recordingId) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:write'], job: false })).delete(recordingId); },
      async setRef(recordingId, ref) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:write'], job: false })).setRef(recordingId, ref); },
      async findByRef(provider, ref) { return admin().browserRecordings(adminScope({ manifest: ['browser:recordings:read', 'browser:recordings:write'], job: false })).findByRef(provider, ref); },
    },
    // An annotation is a person's: never the plugin acting alone.
    browserAnnotations: {
      async list(filter) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:read', 'browser:annotations:write'], job: false })).list(filter); },
      async get(annotationId) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:read', 'browser:annotations:write'], job: false })).get(annotationId); },
      async resolve(annotationId, resolution) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:write'], job: false })).resolve(annotationId, resolution); },
      async delete(annotationId) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:write'], job: false })).delete(annotationId); },
      async setRef(annotationId, ref) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:write'], job: false })).setRef(annotationId, ref); },
      async findByRef(provider, ref) { return admin().browserAnnotations(adminScope({ manifest: ['browser:annotations:read', 'browser:annotations:write'], job: false })).findByRef(provider, ref); },
    },
    docs: {
      async search(query, options) { return admin().docs(adminScope({ manifest: ['docs:read'] })).search(query, options); },
      async read(route, heading) { return admin().docs(adminScope({ manifest: ['docs:read'] })).read(route, heading); },
    },
    license: {
      async edition() { return admin().license(adminScope({ manifest: ['license:read'] })).edition(); },
    },
    missions: {
      async spawn(input: PluginMissionInput): Promise<string> {
        assert('missions:spawn');
        // Declaring `missions:spawn` says the plugin MAY spawn; the policy
        // says how often, and whether the operator ever agreed (audit #5). A
        // spawn burns the machine's AI subscription, so it is the one façade
        // where an unbounded loop costs real money.
        assertSpawnOverrides(input.agent, input, currentPluginViewer(id));
        assertSpawnAllowed(id);
        // `channel` is ENFORCED and never taken from the caller: this makes a
        // mission triggered by a plugin traceable back to it. Owner follows
        // the request caller, or `plugin:<id>` for a job (M.5 / M.7).
        return host.missions.spawn({
          ...input,
          channel: `plugin:${id}`,
          ownerUserId: currentPluginOwnerUserId(id),
        });
      },
      async get(missionId: string): Promise<unknown> {
        assert('missions:read');
        return host.missions.get(missionId, currentPluginViewer(id));
      },
      async list(opts = {}): Promise<unknown[]> {
        assert('missions:read');
        return host.missions.list(opts, currentPluginViewer(id));
      },
      async send(missionId: string, text: string) { return missionControl('missions:control').send(missionId, text); },
      async kill(missionId: string) { return missionControl('missions:control').kill(missionId); },
      async summarize(missionId: string, opts?: { force?: boolean }) { return missionControl('missions:transcript').summarize(missionId, opts); },
      async fork(missionId: string, input: PluginMissionForkInput) { return missionControl('missions:control').fork(missionId, input); },
      async search(q: string, filter?: PluginMissionSearchFilter) { return missionControl('missions:transcript').search(q, filter); },
      async stopScope(scope: PluginStopScope) { return missionControl('missions:control').stopScope(scope); },
      async rename(missionId: string, title: string | null) { return missionControl('missions:control').rename(missionId, title); },
    },
    traces: {
      async get(traceId: string, opts?: PluginTraceOptions) { return missionControl('missions:read').traces.get(traceId, opts); },
    },
    kanban: {
      async add(task: PluginTaskInput): Promise<PluginTask> {
        assert('kanban:write');
        return host.kanban.create(task, taskScope()) as PluginTask;
      },
      async update(taskId: string, patch: PluginTaskPatch): Promise<PluginTask> {
        assert('kanban:write');
        return host.kanban.update(taskId, patch, taskScope()) as PluginTask;
      },
      async list(filter: PluginTaskFilter = {}): Promise<PluginTask[]> {
        assert('kanban:read');
        if (filter.project !== undefined || filter.mirror !== undefined || filter.limit !== undefined) {
          return tasks('kanban:read').list(filter);
        }
        return host.kanban.list(filter.status, taskScope()) as PluginTask[];
      },
      async get(taskId: string): Promise<PluginTask | undefined> { return tasks('kanban:read').get(taskId); },
      async ensure(task: PluginTaskInput, links: readonly PluginTaskLinkInput[]) {
        return tasks('kanban:write').ensure(task, links);
      },
      async done(taskId: string, input: PluginTaskDoneInput): Promise<PluginTask> { return tasks('kanban:write').done(taskId, input); },
      async block(taskId: string, reason: string): Promise<PluginTask> { return tasks('kanban:write').block(taskId, reason); },
      async delete(taskId: string, opts?: { chain?: boolean }) { return tasks('kanban:delete').delete(taskId, opts); },
      refs: {
        async list(taskId: string): Promise<PluginTaskLink[]> { return tasks('kanban:read').refs.list(taskId); },
        async set(taskId: string, link: PluginTaskLinkInput): Promise<PluginTaskLink> {
          return tasks('kanban:write').refs.set(taskId, link);
        },
        async remove(taskId: string, provider: string, ref: string): Promise<boolean> {
          return tasks('kanban:write').refs.remove(taskId, provider, ref);
        },
        async findByRef(provider: string, ref: string): Promise<PluginTask | undefined> {
          return tasks('kanban:read').refs.findByRef(provider, ref);
        },
      },
      todos: {
        async get(todoId: number): Promise<PluginTodo | undefined> {
          return todos('todos:read').get(todoId);
        },
        async list(filter: PluginTodoListFilter = {}): Promise<PluginTodo[]> {
          return todos('todos:read').list(filter);
        },
        async create(input: PluginTodoInput, links: readonly PluginTodoLinkInput[] = []) {
          return todos('todos:write').create(input, links);
        },
        links: {
          async list(todoId: number): Promise<PluginTodoLink[]> {
            return todos('todos:read').links.list(todoId);
          },
          async set(todoId: number, link: PluginTodoLinkInput): Promise<PluginTodoLink> {
            return todos('todos:write').links.set(todoId, link);
          },
          async remove(todoId: number, provider: string, ref: string): Promise<boolean> {
            return todos('todos:write').links.remove(todoId, provider, ref);
          },
          async findByRef(provider: string, ref: string): Promise<PluginTodo | undefined> {
            return todos('todos:read').links.findByRef(provider, ref);
          },
        },
        async update(todoId: number, patch: PluginTodoPatch): Promise<PluginTodo> {
          return todos('todos:write').update(todoId, patch);
        },
        async close(todoId: number): Promise<PluginTodo> {
          return todos('todos:write').close(todoId);
        },
        async promote(todoId: number, input: PluginTodoPromoteInput) {
          // Both rights, checked before anything about the idea is judged: a
          // promotion is a task, and a task is `kanban:write`.
          const scope = todoScope('todos:write');
          assert('kanban:write');
          // The promoted task runs: with nobody in front, it is a spawn (TODO #562).
          const gate = pluginCallUnattended() ? () => {
            try { assertSpawnAllowed(id, Date.now(), 'ctx.kanban.todos.promote'); } catch (err) {
              if (err instanceof PluginPolicyError) throw new TodoLinkError(err.message, 'forbidden', 'spawn_policy');
              throw err;
            }
          } : undefined;
          return promoteTodoFor(scope, todoId, input, gate);
        },
        async delete(todoId: number): Promise<void> {
          return todos('todos:write').delete(todoId);
        },
        attachments: {
          async list(todoId: number): Promise<PluginTodoAttachment[]> {
            return todos('todos:read').attachments.list(todoId);
          },
          async add(todoId: number, file: PluginTodoAttachmentInput): Promise<PluginTodoAttachment> {
            return todos('todos:write').attachments.add(todoId, file);
          },
          async remove(todoId: number, attachmentId: string): Promise<boolean> {
            return todos('todos:write').attachments.remove(todoId, attachmentId);
          },
          async read(todoId: number, attachmentId: string): Promise<Uint8Array> {
            return todos('todos:read').attachments.read(todoId, attachmentId);
          },
        },
      },
    },
    triggers: {
      // The API 6 door first: a plugin that only declares `triggers:disable` is unchanged.
      async list(): Promise<PluginTriggerInfo[]> {
        return can('triggers:disable') ? triggers(['triggers:disable'], false).list() : triggers(TRIGGER_READ, true).list();
      },
      async disable(triggerId: string): Promise<boolean> { return triggers(['triggers:disable'], false).disable(triggerId); },
      async get(triggerId: string): Promise<PluginTriggerInfo | PluginOwnTrigger | undefined> {
        return triggers(TRIGGER_READ, true).get(triggerId);
      },
      async create(input: PluginTriggerInput): Promise<PluginTriggerCreated> {
        return triggers(['triggers:write'], true).create(input);
      },
      async remove(triggerId: string): Promise<boolean> { return triggers(['triggers:write'], true).remove(triggerId); },
      async test(triggerId: string, options?: PluginTriggerTestOptions): Promise<PluginTriggerTestResult> {
        const execute = options?.execute === true;
        return triggers(execute ? ['triggers:execute'] : TRIGGER_READ, true).test(triggerId, options, execute);
      },
    },
    routines: {
      async list(): Promise<PluginRoutine[]> { return routines(false, false).list(); },
      async create(input: PluginRoutineInput): Promise<PluginRoutine> { return routines(true, true).create(input); },
      async update(routineId: string, patch: PluginRoutinePatch): Promise<PluginRoutine> {
        return routines(true, true).update(routineId, patch);
      },
      async delete(routineId: string): Promise<boolean> { return routines(true, false).delete(routineId); },
    },
    pipelines: {
      async list(): Promise<Array<PluginPipeline | PluginOwnPipeline>> { return pipelines('read').list(); },
      async get(pipelineId: string): Promise<PluginPipeline | PluginOwnPipeline | undefined> { return pipelines('read').get(pipelineId); },
      async create(input: PluginPipelineInput): Promise<PluginOwnPipeline> { return pipelines('write').create(input); },
      async delete(pipelineId: string): Promise<boolean> { return pipelines('write').delete(pipelineId); },
      async run(pipelineId: string, input?: Record<string, unknown>): Promise<PluginPipelineRun> {
        return pipelines('run').run(pipelineId, input);
      },
      async runStatus(runId: string): Promise<PluginPipelineRunStatus | undefined> { return pipelines('read').runStatus(runId); },
    },
    agents: {
      async list(): Promise<PluginAgent[]> { return agents(false).list(); },
      async create(input: PluginAgentInput): Promise<PluginAgent> { return agents(true).create(input); },
      async update(name: string, patch: PluginAgentPatch): Promise<PluginAgent> { return agents(true).update(name, patch); },
      // A default, not `?`: the recorded arity of `agents.delete` stays 1 (SDK-COMPAT § 4).
      async delete(name: string, options: PluginAgentDeleteOptions = {}): Promise<boolean> { return agents(true).delete(name, options); },
      async rename(name: string, newName: string): Promise<PluginAgent> { return agents(true).rename(name, newName); },
      async setAvatar(name: string, avatar: PluginAgentAvatar): Promise<string | null> { return agents(true).setAvatar(name, avatar); },
      async export(name: string): Promise<PluginAgentExport> { return agentExport().export(name); },
      teams: {
        async list(): Promise<PluginTeam[]> { return agents(false).listTeams(); },
        async create(input: PluginTeamInput): Promise<PluginTeam> { return agents(true).createTeam(input); },
        async delete(teamId: string): Promise<boolean> { return agents(true).deleteTeam(teamId); },
      },
      docs: {
        async list(agent: string): Promise<PluginAgentDoc[]> { return agentDocs(false).list(agent); },
        async get(agent: string, file: string): Promise<string | null> { return agentDocs(false).get(agent, file); },
        async put(agent: string, file: string, content: string): Promise<PluginAgentDoc> { return agentDocs(true).put(agent, file, content); },
        async rm(agent: string, file: string): Promise<boolean> { return agentDocs(true).rm(agent, file); },
      },
    },
    messages: {
      send: async (input) => messages(true).send(input),
      recv: async (agent, opts) => messages(false).recv(agent, opts),
      pick: async (messageId) => messages(false).pick(messageId),
      reply: async (messageId, payload) => messages(true).reply(messageId, payload),
    },
    skills: {
      list: async () => skills(false).list(),
      get: async (skillId) => skills(false).get(skillId),
      put: async (skillId, content) => skills(true).put(skillId, content),
      rm: async (skillId) => skills(true).rm(skillId),
    },
    mcpServers: {
      list: async () => mcpServers(false).list(),
      get: async (serverId) => mcpServers(false).get(serverId),
      put: async (serverId, input) => mcpServers(true).put(serverId, input),
      rm: async (serverId) => mcpServers(true).rm(serverId),
    },
    memory: {
      rules: {
        async add(input: PluginMemoryRuleInput) { return memory(true).rules.add(input); },
        async list(filter?: PluginMemoryRuleFilter) { return memory(false).rules.list(filter); },
        async rm(ruleId: number) { return memory(true).rules.rm(ruleId); },
      },
      async search(query: string) { return memory(false).search(query); },
      async overview() { return memory(false).overview(); },
      // Async, so a refusal rejects like the other methods instead of throwing at the call.
      async show(scope: PluginMemoryTargetScope, target: string, file?: string): Promise<never> {
        return (file === undefined ? memory(false).show(scope, target) : memory(false).show(scope, target, file)) as Promise<never>;
      },
    },
    projects: {
      async list() { return projects(false).list(); },
      async get(slug: string) { return projects(false).get(slug); },
      async create(input: PluginProjectInput) { return projects(true).create(input); },
      async update(slug: string, patch: PluginProjectPatch) { return projects(true).update(slug, patch); },
      async workspaces() { return projects(false).workspaces(); },
      async roles(slug: string) { return projects(false).roles(slug); },
      async setRole(slug: string, role: string, spec: PluginRoleInput | null) { return projects(true).setRole(slug, role, spec); },
    },
    series: {
      fallback: {
        async list(seriesId: string) { return series(false).fallback.list(seriesId); },
        async set(seriesId: string, rule: PluginSeriesFallbackInput) { return series(true).fallback.set(seriesId, rule); },
        // A default rather than `?`: the snapshot freezes the arity at 2 (docs/SDK-COMPAT.md § 1).
        async clear(seriesId: string, scope: string, group: string | null = null) { return series(true).fallback.clear(seriesId, scope, group); },
      },
      role: {
        async list(seriesId: string) { return series(false).role.list(seriesId); },
        async set(seriesId: string, choice: PluginSeriesRoleInput) { return series(true).role.set(seriesId, choice); },
        async clear(seriesId: string, scope: string, group: string | null = null) { return series(true).role.clear(seriesId, scope, group); },
      },
    },
    worktrees: {
      async info(taskId: string) { return worktrees(false).info(taskId); },
      async create(taskId: string, opts?: { base?: string }) { return worktrees(true).create(taskId, opts); },
      async dispose(taskId: string, opts?: { force?: boolean }) { return worktrees(true).dispose(taskId, opts); },
    },
    mcp: {
      async issueToken(input: PluginMcpTokenInput): Promise<PluginMcpToken> {
        assert('mcp:issue');
        if (!host.mcp) throw new Error('Remote MCP host unavailable');
        return host.mcp.issue(id, input, currentPluginViewer(id));
      },
      async revokeToken(tokenId: string): Promise<boolean> {
        assert('mcp:issue');
        if (!host.mcp) throw new Error('Remote MCP host unavailable');
        return host.mcp.revoke(id, tokenId);
      },
    },
    notify: {
      report(title: string, body?: string): void {
        assert('notify');
        host.notify({
          type: 'report',
          title,
          body: body ?? null,
          source: `plugin:${id}`,
          ownerUserId: currentPluginOwnerUserId(id),
        });
      },
      alert(title: string, body?: string, opts: { urgent?: boolean } = {}): void {
        assert('notify');
        host.notify({
          type: 'alert',
          title,
          body: body ?? null,
          urgent: opts.urgent ?? true,
          source: `plugin:${id}`,
          ownerUserId: currentPluginOwnerUserId(id),
        });
      },
    },
    notifications: {
      async list(filter?: PluginNotificationListFilter) {
        return notifications('notifications:read').list(filter);
      },
      async dismiss(notificationId: string) {
        return notifications('notifications:write').dismiss(notificationId);
      },
    },
    questions: {
      async list(filter?: PluginQuestionListFilter) {
        return questions('questions:read').list(filter);
      },
      async get(questionId: string) {
        return questions('questions:read').get(questionId);
      },
      async resolve(questionId: string, answer: PluginQuestionAnswer) {
        return questions('questions:answer').resolve(questionId, answer);
      },
    },
    approvals: {
      async list(filter?: PluginApprovalListFilter) {
        return approvals('approvals:read').list(filter);
      },
      async get(approvalId: string) {
        return approvals('approvals:read').get(approvalId);
      },
      async resolve(approvalId: string, decision: PluginApprovalDecision) {
        return approvals('approvals:resolve').resolve(approvalId, decision);
      },
    },
    realtime: {
      publish(topic, payload, options) {
        assert('realtime:publish');
        if (!host.realtime) throw new Error('Realtime host unavailable');
        host.realtime.publish(id, topic, payload, options);
      },
    },
    events: {
      on(kind: PluginEventKind | PluginTaskEventKind | PluginTodoEventKind | PluginUiDocumentEventKind | PluginQuestionEventKind | PluginApprovalEventKind | PluginMissionEventKind | PluginMemoryEventKind | PluginProjectEventKind | PluginAgentEventKind | PluginAutomationEventKind | PluginBrowserRecordingEventKind | PluginBrowserAnnotationEventKind, handler: (ev: never) => void | Promise<void>): () => void {
        assert('events:subscribe');
        if (isPluginBrowserAnnotationEventKind(kind)) {
          // The event carries the annotation's metadata: receiving it is reading annotations.
          if (!can('browser:annotations:write')) assert('browser:annotations:read');
          const browserAnnotationEvents = host.browserAnnotationEvents;
          if (!browserAnnotationEvents) throw new Error('Browser annotation events host unavailable');
          return ctx.effect(() => browserAnnotationEvents.subscribe(id, kind, handler as PluginBrowserAnnotationEventHandler));
        }
        if (isPluginBrowserRecordingEventKind(kind)) {
          // The event carries the recording's metadata: receiving it is reading recordings.
          if (!can('browser:recordings:write')) assert('browser:recordings:read');
          const browserRecordingEvents = host.browserRecordingEvents;
          if (!browserRecordingEvents) throw new Error('Browser recording events host unavailable');
          return ctx.effect(() => browserRecordingEvents.subscribe(id, kind, handler as PluginBrowserRecordingEventHandler));
        }
        if (isPluginQuestionEventKind(kind)) {
          // The event carries the question: receiving it is reading questions.
          assert('questions:read');
          const questionEvents = host.questionEvents;
          if (!questionEvents) throw new Error('Question events host unavailable');
          return ctx.effect(() => questionEvents.subscribe(id, kind, handler as PluginQuestionEventHandler));
        }
        if (isPluginApprovalEventKind(kind)) {
          // The event carries the approval: receiving it is reading approvals.
          assert('approvals:read');
          const approvalEvents = host.approvalEvents;
          if (!approvalEvents) throw new Error('Approval events host unavailable');
          return ctx.effect(() => approvalEvents.subscribe(id, kind, handler as PluginApprovalEventHandler));
        }
        if (isPluginMissionEventKind(kind)) {
          // The event names a mission: receiving it is reading missions; the
          // transcript kinds carry what was said, which is a power of its own.
          assert(isPluginTranscriptEventKind(kind) ? 'missions:transcript' : 'missions:read');
          const missionEvents = host.missionEvents;
          if (!missionEvents) throw new Error('Mission events host unavailable');
          return ctx.effect(() => missionEvents.subscribe(id, kind, handler as PluginMissionEventHandler));
        }
        if (isPluginMemoryEventKind(kind)) {
          // The event carries a rule: receiving it is reading the memory.
          assert('memory:read');
          const memoryEvents = host.memoryEvents;
          if (!memoryEvents) throw new Error('Memory events host unavailable');
          return ctx.effect(() => memoryEvents.subscribe(id, kind, handler as PluginMemoryEventHandler));
        }
        if (isPluginTaskEventKind(kind)) {
          // The event carries the task: receiving it is reading the Kanban.
          assert('kanban:read');
          const taskEvents = host.taskEvents;
          if (!taskEvents) throw new Error('Task events host unavailable');
          const readsProjects = can('kanban:read:project');
          return ctx.effect(() => taskEvents.subscribe(id, kind, handler as PluginTaskEventHandler, readsProjects));
        }
        if (isPluginUiDocumentEventKind(kind)) {
          // The event carries the document: receiving it is reading documents.
          assert('ui-documents:read');
          const uiDocumentEvents = host.uiDocumentEvents;
          if (!uiDocumentEvents) throw new Error('UI document events host unavailable');
          return ctx.effect(() => uiDocumentEvents.subscribe(id, kind, handler as PluginUiDocumentEventHandler));
        }
        if (isPluginProjectEventKind(kind)) {
          // The event carries the project: receiving it is reading the project list.
          if (!can('projects:manage')) assert('projects:read');
          const projectEvents = host.projectEvents;
          if (!projectEvents) throw new Error('Project events host unavailable');
          return ctx.effect(() => projectEvents.subscribe(id, kind, handler as PluginProjectEventHandler));
        }
        if (isPluginAgentEventKind(kind)) {
          // The event carries the agent: receiving it is reading agents.
          assert('agents:read');
          const agentEvents = host.agentEvents;
          if (!agentEvents) throw new Error('Agent events host unavailable');
          return ctx.effect(() => agentEvents.subscribe(id, kind, handler as PluginAgentEventHandler));
        }
        if (isPluginAutomationEventKind(kind)) {
          // The event carries the object: receiving it is reading it.
          const needed = automationEventPermissions(kind);
          if (!needed.some((p) => can(p))) throw new PluginPermissionError(id, needed[0]!);
          const automationEvents = host.automationEvents;
          if (!automationEvents) throw new Error('Automation events host unavailable');
          return ctx.effect(() => automationEvents.subscribe(id, kind, handler as PluginAutomationEventHandler));
        }
        if (isPluginTodoEventKind(kind)) {
          // The event carries the idea: receiving it is reading the notebook.
          assert('todos:read');
          const todoEvents = host.todoEvents;
          if (!todoEvents) throw new Error('TO DO events host unavailable');
          return ctx.effect(() => todoEvents.subscribe(id, kind, handler as PluginTodoEventHandler));
        }
        if (!(PLUGIN_EVENT_KINDS as readonly string[]).includes(kind)) {
          throw new Error(
            `plugin \`${id}\`: event \`${kind}\` is not exposed to plugins `
            + `(allowed: ${[...PLUGIN_EVENT_KINDS, ...PLUGIN_TASK_EVENT_KINDS, ...PLUGIN_TODO_EVENT_KINDS, ...PLUGIN_UI_DOCUMENT_EVENT_KINDS, ...PLUGIN_QUESTION_EVENT_KINDS, ...PLUGIN_APPROVAL_EVENT_KINDS, ...PLUGIN_MISSION_EVENT_KINDS, ...PLUGIN_MEMORY_EVENT_KINDS, ...PLUGIN_PROJECT_EVENT_KINDS, ...PLUGIN_AGENT_EVENT_KINDS, ...PLUGIN_AUTOMATION_EVENT_KINDS, ...PLUGIN_BROWSER_RECORDING_EVENT_KINDS, ...PLUGIN_BROWSER_ANNOTATION_EVENT_KINDS].join(', ')})`,
          );
        }
        // Use `effect` rather than returning a bare `off`: a plugin that forgets
        // to unsubscribe must not leave a listener behind.
        // Delivered inside the bus emission: guarded, so the plugin's throw or
        // rejection is its own failure, not the publishing write's or the daemon's.
        return ctx.effect(() => host.subscribe(kind, guardPluginCallback(id, `event ${kind}`, handler as (ev: unknown) => unknown)));
      },
    },
    outbox: {
      async post(target: PluginOutboxTarget, body?: unknown, opts: PluginOutboxOptions = {}): Promise<{ id: string }> {
        assert('http:outbound');
        // Naming a vault entry is using it, as `secrets.get` would.
        if (typeof target !== 'string' || opts?.sign || opts?.auth) assert('secrets:read');
        if (!host.outbox) throw new Error('Outbox host unavailable');
        return { id: host.outbox.enqueue(id, target, body, opts) };
      },
      async get(entryId: string): Promise<PluginOutboxEntry | undefined> {
        assert('http:outbound');
        if (!host.outbox) throw new Error('Outbox host unavailable');
        return host.outbox.get(id, entryId);
      },
    },
    webhooks: {
      on(name: string, handler: PluginWebhookHandler): () => void {
        assert('webhooks:receive');
        const declared = (spec.manifest.webhooks ?? []).find((w) => w.name === name);
        if (!declared) {
          throw new Error(`plugin \`${id}\`: webhook \`${name}\` is not declared in the manifest (\`webhooks\`)`);
        }
        if (typeof handler !== 'function') throw new TypeError(`plugin \`${id}\`: webhook \`${name}\` needs a handler function`);
        const webhooks = host.webhooks;
        if (!webhooks) throw new Error('Webhook host unavailable');
        // Through `effect`: an unloaded plugin must answer like an unknown one.
        return ctx.effect(() => webhooks.register(id, name, handler, declared.auth, spec.publisher ?? null));
      },
      asOwner<T>(name: string, fn: () => T | Promise<T>): Promise<PluginWebhookOwnerRun<T>> {
        assert('webhooks:receive');
        if (!(spec.manifest.webhooks ?? []).some((w) => w.name === name)) {
          throw new Error(`plugin \`${id}\`: webhook \`${name}\` is not declared in the manifest (\`webhooks\`)`);
        }
        if (typeof fn !== 'function') throw new TypeError(`plugin \`${id}\`: webhooks.asOwner needs a function`);
        const run = host.webhooks?.asOwner;
        if (!run) throw new Error('Webhook host unavailable');
        return run(id, name, fn);
      },
    },
    host: {
      async exec(bin: string, args: readonly string[] = [], opts = {}): Promise<PluginExecResult> {
        assert('host:exec');
        // Deny-by-default allowlist: `host:exec` was the shortest path from a
        // declared permission to `claude`/`codex` on the operator's account.
        // The policy hands back the binary to launch: the path the operator
        // authorized when the grant is an absolute one.
        return host.exec(assertExecAllowed(id, bin), args, opts);
      },
    },
    usage: {
      // Default parameters, not `options?`: the snapshot freezes each
      // function's arity, and an optional argument must leave it unchanged.
      async list(options: UsageProbeOptions = {}): Promise<UsageEntry[]> {
        assert('usage:read');
        // The caller of THIS request: their own accounts and the ones granted
        // to them, never another user's. A job sees no account.
        return host.usage.list(currentPluginViewer(id), options);
      },
      async get(backend: string, options: UsageProbeOptions = {}): Promise<UsageEntry | null> {
        assert('usage:read');
        return host.usage.get(backend, currentPluginViewer(id), options);
      },
      registerCollector(backend: string, collect: UsageCollector): () => void {
        assert('usage:collect');
        // Through `effect`, like `events.on`: a plugin that forgets to remove
        // its probe must not keep answering for a backend after unloading.
        return ctx.effect(() => host.usage.registerCollector(id, backend, collect));
      },
    },
    backends: {
      registerProfile(profile: RegisteredProfile): () => void {
        assert('backends:register');
        // A binary the PLUGIN picked is subject to the operator's allowlist,
        // exactly like `host.exec`. A profile that reuses the dialect's own
        // command is the product's binary, already spawned by the daemon for
        // its own profiles — asking the operator to allowlist `codex` there
        // would be asking them to open the very thing the denylist protects.
        if (profile.cmd) assertExecAllowed(id, profile.cmd);
        // The folders the operator saw on the install sheet, like a dialect's (`provider.credentialDirs`).
        const authorized = spec.manifest.provider?.credentialDirs ?? [];
        for (const dir of profile.credentialDirs ?? []) {
          // The product's rules first (a message that names the real reason), then the manifest's list.
          const problem = credentialDirProblem(dir, spec.builtin === true ? profile.id : []);
          if (problem) throw new Error(`profile \`${profile.id}\`: ${problem}`);
          if (!authorized.includes(dir)) {
            throw new PluginPolicyError(id, 'provider-credential-dirs',
              `\`${dir}\` is not a folder this plugin's manifest declares (\`provider.credentialDirs\`): the operator authorizes what the manifest lists`);
          }
        }
        return ctx.effect(() => host.backends.registerProfile(id, profile, spec.builtin === true));
      },
      registerDialect(dialectId: string, dialect: Dialect | RemoteDialect): () => void {
        assert('backends:register');
        if (!isRemoteDialect(dialect)) assertExecAllowed(id, dialect.defaultCmd);
        // Legacy JavaScript plugins omitted id; keep registration compatible.
        if (dialect.id === undefined) {
          console.warn(prefix, 'Registering a dialect without dialect.id is deprecated; set it to the registerDialect identifier.');
        } else if (dialect.id !== dialectId) {
          console.warn(prefix, 'dialect.id differs from the registerDialect identifier; registration uses the latter. Set both identifiers to the same value.');
        }
        return ctx.effect(() => host.backends.registerDialect(id, dialectId, dialect, { strict: spec.manifest.apiVersion >= 11 }));
      },
      async list(): Promise<PluginBackendCatalog> { return backendCatalog().list(); },
    },
    provider: providerServicesFor({
      pluginId: id,
      apiVersion: spec.manifest.apiVersion,
      assertPermission: () => assert('backends:register'),
      trusted: spec.builtin === true,
      authorizedBinaries: (spec.manifest.provider?.binaries ?? []).flatMap((b) => [b.name, ...b.aliases]),
      authorizedCredentialDirs: spec.manifest.provider?.credentialDirs ?? [],
      osCredentials: spec.manifest.provider?.osCredentials ?? [],
      effect: (register) => ctx.effect(register),
    }),
    ui: {
      /** JWT HS256, 10 min, `aud: plugin:<id>` — the browser half uses it to
       *  call `/api/plugins/<id>/*` and nothing else. */
      token(): string {
        const now = Math.floor(Date.now() / 1000);
        return signToken({ sub: id, aud: `plugin:${id}`, iat: now, exp: now + 600 }, host.tokenKey());
      },
      documents: {
        async create(input: PluginUiDocumentInput) {
          return uiDocuments('ui-documents:write').create(input);
        },
        async get(documentId: string) {
          return uiDocuments('ui-documents:read').get(documentId);
        },
        async list(filter?: { missionId?: string; status?: UiDocumentStatus; limit?: number }) {
          return uiDocuments('ui-documents:read').list(filter);
        },
        async findByRef(provider: string, ref: string) {
          return uiDocuments('ui-documents:read').findByRef(provider, ref);
        },
        async dismiss(documentId: string) {
          return uiDocuments('ui-documents:write').dismiss(documentId);
        },
      },
      navigate: async (input) => layout('layout:propose').navigate(input),
    },
    layout: {
      widgets: {
        get: async (target) => layout('layout:read').widgets.get(target),
        propose: async (input) => layout('layout:propose').widgets.propose(input),
        presetSave: async (input) => layout('layout:presets').widgets.presetSave(input),
      },
      islands: {
        get: async (target) => layout('layout:read').islands.get(target),
        propose: async (input) => layout('layout:propose').islands.propose(input),
        presetSave: async (input) => layout('layout:presets').islands.presetSave(input),
      },
      nav: {
        get: async () => layout('layout:read').nav.get(),
        propose: async (input) => layout('layout:propose').nav.propose(input),
      },
      proposals: {
        get: async (proposalId) => layout('layout:propose').proposals.get(proposalId),
        list: async (filter) => layout('layout:propose').proposals.list(filter),
      },
    },
    chat: {
      showMedia: async (input) => {
        const media = chat('chat:media');
        // An https source makes the daemon fetch for the plugin: that is `ctx.fetch`, under the
        // same two ceilings (the declared `http:outbound`, then the operator's `pluginPolicy.http`).
        const src = typeof input === 'object' && input !== null && typeof input.src === 'string' ? input.src.trim() : '';
        if (/^https:/i.test(src)) {
          assert('http:outbound');
          assertFetchAllowed(id, src);
        }
        return media.showMedia(input);
      },
      proposeCommand: async (input) => chat('chat:command').proposeCommand(input),
      commandRequests: {
        get: async (requestId) => chat('chat:command').commandRequests.get(requestId),
      },
    },
    onboarding: {
      profile: async () => layout('onboarding:read').onboardingProfile(),
    },
  };

  // A loaded plugin's queued calls may leave; unloaded, they wait for it.
  if (can('http:outbound') && host.outbox) {
    const outbox = host.outbox;
    ctx.effect(() => outbox.attach(id));
  }

  // `fetch` is ABSENT without the permission, rather than throwing: the plan
  // specifies this (§10.4), so a plugin can test for it and adapt.
  if (can('http:outbound')) {
    Object.defineProperty(pluginContext, 'fetch', {
      // `async` so a refusal REJECTS instead of throwing synchronously: the
      // contract is `fetch`, and a caller awaiting it must not have to guard
      // the call site with a try/catch the real `fetch` never needs.
      value: async (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]) => {
        // Refusal is a rejected promise, not a missing member: the absence of
        // `fetch` means "no permission", and a host outside the allowlist is a
        // different fact the plugin must be able to tell apart.
        try {
          assertFetchAllowed(id, input);
        } catch (refusal) {
          // Outside the operator's allowlist, a destination a user registered
          // and someone approved — reached only through the SSRF guard.
          const url = refusal instanceof PluginPolicyError ? fetchTarget(input) : undefined;
          if (url && host.destinations?.approved(id, url)) return host.destinations.fetch(id, input, init);
          throw refusal;
        }
        return host.fetch(input, init);
      },
      enumerable: true,
    });
  }

  return pluginContext;
}

/** The URL a `fetch` call targets, or `undefined` when unreadable. */
function fetchTarget(input: Parameters<typeof globalThis.fetch>[0]): URL | undefined {
  try { return new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); }
  catch { return undefined; }
}

// ── Jetons UI ─────────────────────────────────────────────────────────────────

const b64url = (b: Buffer) => b.toString('base64url');

/** Minimal HS256 JWT — native `crypto`, no dependency (see §10.7 for licenses,
 *  which follows the same rule). */
export function signToken(claims: Record<string, unknown>, key: Buffer): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(claims)));
  const sig = b64url(createHmac('sha256', key).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
}

/** Verifies signature AND expiration. Returns claims or `null` — never throws:
 *  an invalid token is a 401, not an outage. */
export function verifyToken(token: string, key: Buffer): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const expected = Buffer.from(createHmac('sha256', key).update(`${head}.${body}`).digest().toString('base64url'));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// ── Real binding implementation ──────────────────────────────────────────────

let cachedTokenKey: Buffer | null = null;

function readOrCreateTokenKey(): Buffer {
  if (cachedTokenKey) return cachedTokenKey;
  try {
    cachedTokenKey = Buffer.from(readFileSync(PLUGIN_TOKEN_KEY_FILE, 'utf8').trim(), 'base64');
    if (cachedTokenKey.length >= 32) return cachedTokenKey;
  } catch { /* first use, or unreadable file: regenerate */ }
  const key = randomBytes(32);
  writeFileSync(PLUGIN_TOKEN_KEY_FILE, key.toString('base64'), { mode: 0o600 });
  try { chmodSync(PLUGIN_TOKEN_KEY_FILE, 0o600); } catch { /* best-effort (filesystem without permissions) */ }
  cachedTokenKey = key;
  return key;
}

let sharedOutbox: PluginOutboxHost | null = null;

/** One queue per process: two runs over the same rows would send twice. */
function daemonOutbox(): PluginOutboxHost {
  return sharedOutbox ??= createPluginOutbox({
    fetch: (input, init) => globalThis.fetch(input, init),
    secret: (pluginId, name) => readPluginSecret(pluginId, name),
    allow: (pluginId, url) => assertFetchAllowed(pluginId, url),
    schedule: true,
  });
}

/**
 * Real bindings. Heavy modules (`agent.js`, `notifications.js`) are imported
 * on demand: a plugin that never spawns a mission should not pull the
 * dispatcher's import graph into its own.
 */
export function daemonHost(ctx: Context): PluginHost {
  return {
    integrations: { open: openIntegrationSession },
    realtime: { publish: publishPluginRealtime },
    mountRouter(prefix, router, owner) {
      const http = ctx.get('http') as { mount(p: string, r: Router, owner?: string): () => void } | undefined;
      if (!http) throw new Error('service `http` unavailable: the kernel is not mounted');
      return http.mount(prefix, router, owner);
    },
    kv: {
      get: (pluginId, key) => dbApi.pluginKvGet(pluginId, key),
      set: (pluginId, key, value) => dbApi.pluginKvSet(pluginId, key, value),
      del: (pluginId, key) => dbApi.pluginKvDelete(pluginId, key),
      list: (pluginId, prefix) => dbApi.pluginKvList(pluginId, prefix),
    },
    missions: {
      async spawn(input) {
        const { spawnAgent } = await import('../agent.js');
        return spawnAgent(input.agent, input.mission, { channel: input.channel, meta: input.meta }, {
          ownerUserId: input.ownerUserId,
          modelOverride: input.model ?? null,
          backendOverride: input.backend ?? null,
          extraSkills: input.extraSkills,
          extraMcpServers: input.extraMcp,
          extraAllowedTools: input.allow,
          traceId: typeof (input.meta as { trace_id?: unknown } | null)?.trace_id === 'string'
            ? (input.meta as { trace_id: string }).trace_id
            : null,
          title: typeof input.title === 'string' ? input.title.slice(0, 200) : null,
        });
      },
      get: (missionId, viewer) => scopedDb(viewer).getMission(missionId),
      list: (opts, viewer) => scopedDb(viewer).listMissions(opts.limit ?? 50, opts.agents, opts.status),
    },
    kanban: {
      create: (input, scope) => tasksFor(scope).create(input),
      update: (id, patch, scope) => tasksFor(scope).update(id, patch),
      list: (status, scope) => tasksFor(scope).list(status === undefined ? {} : { status }),
    },
    tasks: { open: tasksFor },
    taskEvents: { subscribe: subscribePluginTaskEvent },
    todos: { open: todosFor },
    triggers: { open: triggersFor },
    routines: { open: routinesFor },
    pipelines: { open: pipelinesFor },
    workflowRuns: { open: workflowsFor },
    automationEvents: { subscribe: subscribePluginAutomationEvent },
    agents: { open: agentsFor },
    missionControl: { open: missionControlFor },
    missionEvents: { subscribe: subscribePluginMissionEvent },
    memory: { open: memoryFor },
    memoryEvents: { subscribe: subscribePluginMemoryEvent },
    projects: { open: projectsFor },
    series: { open: seriesFor },
    worktrees: { open: worktreesFor },
    projectEvents: { subscribe: subscribePluginProjectEvent },
    browserRecordingEvents: { subscribe: subscribePluginBrowserRecordingEvent },
    browserAnnotationEvents: { subscribe: subscribePluginBrowserAnnotationEvent },
    agentDocs: { open: agentDocsFor },
    agentExport: { open: agentExportFor },
    agentEvents: { subscribe: subscribePluginAgentEvent },
    messages: { open: messagesFor },
    skills: { open: skillsFor },
    mcpServers: { open: mcpServersFor },
    backendCatalog: { open: backendCatalogFor },
    admin: {
      system: systemFor,
      modules: modulesFor,
      license: licenseFor,
      docs: docsFor,
      backup: backupFor,
      browser: browserFor,
      browserRecordings: browserRecordingsFor,
      browserAnnotations: browserAnnotationsFor,
      // The loader and the reconciler hang off the HTTP app, which mounts after this host exists.
      plugins: (scope) => pluginsAdminFor(scope, { app: () => (ctx.get('http') as { app?: { get(k: string): unknown; set(k: string, v: unknown): unknown } } | undefined)?.app ?? null }),
      secrets: secretsAdminFor,
      accounts: accountsFor,
    },
    mcp: { issue: issueForPlugin, revoke: revokeForPlugin },
    todoEvents: { subscribe: subscribePluginTodoEvent },
    layout: { open: layoutFor },
    chat: { open: chatFor },
    uiDocuments: { open: uiDocumentsFor },
    uiDocumentEvents: { subscribe: subscribePluginUiDocumentEvent },
    questions: { open: questionsFor },
    questionEvents: { subscribe: subscribePluginQuestionEvent },
    approvals: { open: approvalsFor },
    approvalEvents: { subscribe: subscribePluginApprovalEvent },
    notifications: { open: notificationsFor },
    outbox: daemonOutbox(),
    webhooks: { register: registerPluginWebhook, asOwner: runAsPluginWebhookOwner },
    notify(input) {
      void import('../notifications.js').then(({ createNotification }) => {
        createNotification({
          type: input.type,
          urgent: input.urgent ?? false,
          title: input.title,
          body: input.body ?? null,
          source: input.source,
          ownerUserId: input.ownerUserId,
        });
      });
    },
    subscribe(kind, handler) {
      // The bus is connected READ-only: listen to its single channel and
      // filter it. No facade exposes `bus.publish` (§6).
      const onEvent = (ev: { kind: string }) => { if (ev.kind === kind) handler(ev); };
      bus.on('event', onEvent);
      return () => void bus.off('event', onEvent);
    },
    async exec(bin, args, opts) {
      // Go through the host adapter: it applies `config.host.binaries` pins. A
      // plugin must not resolve its binary differently from the daemon.
      try {
        // The system whitelist, never the daemon's environment: that is where the vault
        // secrets and the daemon's own credentials live, and the same line a
        // third-party mission is held to (`secrets.inheritEnv` does not open it).
        return await getHost().execAsync(bin, [...args], { cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024, env: systemEnv() });
      } catch (err) {
        // Missing binary: the facade returns a result, never throws — this is
        // the contract plugins compile against.
        return { code: 1, stdout: '', stderr: (err as Error).message };
      }
    },
    fetch: (input, init) => globalThis.fetch(input, init),
    destinations: {
      approved: (pluginId, url) => maybeUserConnectionService()?.destination(pluginId, url) !== undefined,
      fetch: (pluginId, input, init) => userConnectionService().fetch(pluginId, input, init),
    },
    dataDir(pluginId) {
      const dir = pluginDataDir(pluginId);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
    tokenKey: readOrCreateTokenKey,
    secrets: { get: (pluginId, name) => readPluginSecret(pluginId, name) },
    usage: {
      list: (viewer, options) => collectUsage(viewer, options),
      get: (backend, viewer, options) => collectBackendUsage(backend, viewer, options),
      registerCollector: (pluginId, backend, collect) => registerUsageCollector(pluginId, backend, collect),
    },
    backends: {
      registerProfile: (pluginId, profile, trusted) => registerProfile(pluginId, profile, { trusted }),
      registerDialect: (pluginId, dialectId, dialect, options) => registerDialect(pluginId, dialectId, dialect, options),
    },
  };
}

/* ── Compile-time guard of the effect contract ─────────────────────────────
   §10.4 promises an effect identical to the kernel. These aliases emit no
   runtime code: they fail at COMPILATION (and therefore `npm run build`) if
   `effect` is narrowed one day, which a tsx test would never catch because it
   does not type-check. They preserve all four Cordis 4.0.1 `Effect` forms and
   the async disposer. */
type EffectBodyAccepted<F extends Parameters<PluginContext['effect']>[0]> = F;
type _EffectAcceptsSyncDisposer = EffectBodyAccepted<() => () => void>;
type _EffectAcceptsAsyncDisposer = EffectBodyAccepted<() => () => Promise<void>>;
type _EffectAcceptsPromise = EffectBodyAccepted<() => Promise<() => Promise<void>>>;
type _EffectAcceptsIterable = EffectBodyAccepted<() => Generator<() => void, void, void>>;
type _EffectAcceptsAsyncIterable = EffectBodyAccepted<() => AsyncGenerator<() => Promise<void>, void, void>>;
type _EffectAcceptsVoid = EffectBodyAccepted<() => void>;
type Assert<T extends true> = T;
/** The returned handle remains awaitable: a plugin must be able to know WHEN
 *  its effect has actually been removed. */
type _EffectHandleIsAwaitable = Assert<PluginAsyncEffectHandle extends PromiseLike<() => Promise<void>> ? true : false>;
/** M.7 freeze: identity is a function, never a field — a plugin is loaded once. */
type _UserIsFn = Assert<PluginContext['user'] extends () => PluginUser | undefined ? true : false>;
/** What the daemon returns is what the SDK promises: a field dropped from the
 *  row or the link breaks compilation here, not a plugin in the field. */
type _TodoRowIsPublic = Assert<ReturnType<ScopedTodoApi['get']> extends PluginTodo | undefined ? true : false>;
type _TodoLinkIsPublic = Assert<ReturnType<ScopedTodoApi['links']['set']> extends PluginTodoLink ? true : false>;
type _TodoUpdateIsPublic = Assert<ReturnType<ScopedTodoApi['update']> extends PluginTodo ? true : false>;
/** A document this plugin may read the reply of comes back with it; any other without it (D8). */
type _UiDocumentCreateIsOwn = Assert<ReturnType<ScopedUiDocuments['create']> extends PluginOwnUiDocument ? true : false>;
type _UiDocumentHasNoReply = Assert<'reply' extends keyof PluginUiDocument ? false : true>;
/** A question reaches a plugin as a projection, never the agent's raw payload. */
type _QuestionIsPublic = Assert<ReturnType<ScopedQuestions['get']> extends PluginQuestion | undefined ? true : false>;
/** An approval reaches a plugin as a projection, never the raw tool payload. */
type _ApprovalIsPublic = Assert<ReturnType<ScopedApprovals['get']> extends PluginApproval | undefined ? true : false>;
type _AssertPermissionIsFn = Assert<PluginContext['assertPermission'] extends (p: string) => void ? true : false>;
/** The structural slice the provider kit publishes (`@timon-ai/sdk/provider`) cannot drift from the real context. */
type _ProviderContextIsASlice = Assert<PluginContext extends ProviderPluginContext ? true : false>;
/** The contract spells out the permissions the manifest schema validates (`PLUGIN_PERMISSIONS`). */
type _PermissionsMatchContract = Assert<Equals<PluginPermission, ContractPluginPermission>>;
