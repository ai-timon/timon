/** Public plugin types for tool-use approvals (`ctx.approvals`). */

/** Who: `agent` (name), `user` (account id), `plugin` (plugin id), `system`, `unknown`. */
export type PluginApprovalActor = Readonly<{ kind: string; id: string | null }>;

/**
 * A pending Allow / Deny card as a plugin reads it. `input` is a bounded and
 * redacted view of what the agent wants to run, never the raw payload and
 * never the files the card previewed.
 */
export type PluginApproval = Readonly<{
  id: string;
  missionId: string;
  agent: string;
  /** The tool the agent asked to use (`Bash`, an MCP tool, …). */
  tool: string;
  input: unknown;
  createdAt: number;
  /** When an unattended mission refuses the card by itself; `null` = it waits. */
  expiresAt: number | null;
}>;

/**
 * Allow or deny, as a click would. `message` is the reason the agent reads on
 * a deny; absent, Timon uses the same text as the Deny button. `relayedVia`
 * names the channel that carried the person's decision.
 */
export type PluginApprovalDecision = Readonly<{
  behavior: 'allow' | 'deny';
  message?: string;
  relayedVia?: string;
}>;

export type PluginApprovalResolution = Readonly<{ id: string; status: 'allowed' | 'denied' }>;

export type PluginApprovalListFilter = {
  /** Tool name, matched exactly. */
  tool?: string;
  /** Project slug of the agent that asks. */
  project?: string;
  limit?: number;
};

export type PluginApprovalErrorCode = 'invalid' | 'not_found';

export type PluginApprovalEventKind = 'approval_pending' | 'approval_resolved';

export type PluginApprovalPendingEvent = Readonly<{
  kind: 'approval_pending';
  approvalId: string;
  approval: PluginApproval;
  /** Who caused the event: the agent that asked. */
  origin: PluginApprovalActor;
}>;

export type PluginApprovalResolvedEvent = Readonly<{
  kind: 'approval_resolved';
  approvalId: string;
  /** `allowed`, `denied` (Deny, or a paste the agent receives as a deny) or `expired`. */
  status: 'allowed' | 'denied' | 'expired';
  approval: PluginApproval;
  /** Who closed it: the user or plugin, or `system` for an expiry. */
  origin: PluginApprovalActor;
  /** The action behind the decision (`ui_card_allow`, `plugin`, `auto_timeout`, `mission_end`…). */
  decisionOrigin: string;
  /** The account of the request, when a plugin relayed a person's decision. `null` otherwise. */
  decidedBy: PluginApprovalActor | null;
  /** The channel label the caller gave. `null` when it gave none. */
  relayedVia: string | null;
}>;

export type PluginApprovalEvent = PluginApprovalPendingEvent | PluginApprovalResolvedEvent;

export type PluginApprovalEventMap = {
  approval_pending: PluginApprovalPendingEvent;
  approval_resolved: PluginApprovalResolvedEvent;
};

export type PluginApprovalEventHandler = (ev: PluginApprovalEvent) => void | Promise<void>;
