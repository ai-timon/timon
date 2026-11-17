/**
 * Facade shapes named by `PluginContext` (`ctx.outbox`, `ctx.messages`, `ctx.notifications`…).
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */
import type { ScopedMcpServers } from './mcp-servers.js';
import type { ScopedMessages } from './messages.js';
import type { PluginNotification, PluginNotificationListFilter } from './notifications.js';
import type { PluginOutboxEntry, PluginOutboxOptions, PluginOutboxTarget } from './outbox.js';
import type {
  PluginApproval, PluginApprovalDecision, PluginApprovalListFilter, PluginApprovalResolution,
} from './approvals.js';
import type {
  PluginQuestion, PluginQuestionAnswer, PluginQuestionListFilter, PluginQuestionResolution,
} from './questions.js';
import type { ScopedSkills } from './skills.js';
import type {
  PluginOwnUiDocument, PluginUiDocument, PluginUiDocumentInput, UiDocumentStatus,
} from './ui-documents.js';

/**
 * `ctx.outbox`, permission `http:outbound` (and `secrets:read` to name a vault
 * entry in `target`, `sign` or `auth`). See `plugins/outbox.ts`.
 */
export type PluginOutbox = {
  /** Queues one call and returns its id (also its `webhook-id`). The body is
   *  sent as JSON; `undefined` sends none. */
  post(target: PluginOutboxTarget, body?: unknown, opts?: PluginOutboxOptions): Promise<{ id: string }>;
  /** A call of this plugin, `undefined` when unknown or purged (7 days after it finished). */
  get(id: string): Promise<PluginOutboxEntry | undefined>;
};

/** `ctx.messages`, `ctx.skills`, `ctx.mcpServers`: the facades as a plugin calls them. */
export type PluginMessages = ScopedMessages;
export type PluginSkills = ScopedSkills;
export type PluginMcpServers = ScopedMcpServers;

/** `ctx.notifications` (see `PluginContext`). */
export type PluginNotifications = {
  list(filter?: PluginNotificationListFilter): Promise<PluginNotification[]>;
  /** `true` when a notification of the caller's view was open and is now closed. */
  dismiss(id: string): Promise<boolean>;
};

/** `ctx.questions` (see `PluginContext`). */
export type PluginQuestions = {
  list(filter?: PluginQuestionListFilter): Promise<PluginQuestion[]>;
  get(id: string): Promise<PluginQuestion | undefined>;
  /** Answers (or cancels) a question as the caller; throws `not_found` once it is answered or expired. */
  resolve(id: string, answer: PluginQuestionAnswer): Promise<PluginQuestionResolution>;
};

/** `ctx.approvals` (see `PluginContext`). */
export type PluginApprovals = {
  list(filter?: PluginApprovalListFilter): Promise<PluginApproval[]>;
  get(id: string): Promise<PluginApproval | undefined>;
  /**
   * Allows or denies a tool-use card as a click would. `status` reflects what
   * the agent actually received, which can be `denied` after an allow when
   * Timon refuses that allow on its own. Throws `not_found` once the card is
   * resolved or expired.
   */
  resolve(id: string, decision: PluginApprovalDecision): Promise<PluginApprovalResolution>;
};

/** `ctx.ui.documents` (see `PluginContext`). */
export type PluginUiDocuments = {
  create(input: PluginUiDocumentInput): Promise<PluginOwnUiDocument>;
  get(id: string): Promise<PluginUiDocument | PluginOwnUiDocument | undefined>;
  list(filter?: { missionId?: string; status?: UiDocumentStatus; limit?: number }): Promise<Array<PluginUiDocument | PluginOwnUiDocument>>;
  /** The document of THIS plugin tied to an external reference. */
  findByRef(provider: string, ref: string): Promise<PluginOwnUiDocument | undefined>;
  /** Removes a document this plugin created; `undefined` for any other. */
  dismiss(id: string): Promise<PluginOwnUiDocument | undefined>;
};
