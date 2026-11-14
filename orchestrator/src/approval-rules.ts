/**
 * Approvals Timon remembers itself (TODO #288).
 *
 * An agent that understands a wider Allow lists it on its request (Hermes,
 * `PermissionRequest.scopes`) and keeps it on its side. The claude CLI does
 * not: its permission tool only answers allow or deny, once. On its cards
 * (`RequestInput.timonScopes`, set by the shim's route) the card offers
 * `session` and `always` anyway, and Timon keeps the answer: the next request
 * with the same motif is allowed without a card. Not on ACP cards: their tool
 * names come from a kind or a title, and a shell call named otherwise would be
 * remembered as "any command".
 *
 * What this never widens:
 *  - the classifier: an op it refuses never reaches the permission tool, so no
 *    rule can see it. A rule only stands in for the human click that would
 *    have followed a deferral;
 *  - the agent's red list: a tool the agent's config denies is never
 *    auto-allowed, whatever was remembered;
 *  - the people: a rule is keyed by the mission's owner and agent as the
 *    mission row records them, never by what the caller says. One user's
 *    "always" does not open another user's missions on the same agent.
 *
 * The motif is the tool name AND what the call reaches: the exact command of a
 * shell tool, the file of a file tool, the domain of a web fetch, the exact
 * input of any other tool (an MCP tool's included). An approval on the tool name
 * alone (until 30/10/2026, TODO #534) let one click cover every file and every
 * address: an "always" on the shell tool itself would be bypassPermissions by
 * another name, and so would an "always" on Write.
 *
 * A shell command that runs local files (`./run_tests.sh`, `npm test`) is
 * bound to their state as well (`content_state`, `script-preview.ts`): the
 * rule answers only while each file has the fingerprint it was approved with,
 * or is still absent. A rewritten script brings the card back, with what it
 * now holds.
 */
import { createHash, randomUUID } from 'node:crypto';
import { loadConfig } from './agent-config.js';
import { APPROVAL_SCOPES, type ApprovalScope } from './backends/types.js';
import { dbApi, type ApprovalRuleRow } from './db.js';

export type ApprovalMotif = {
  readonly tool_name: string;
  /** What the call reaches, written as claude writes its own rules: the exact
   *  command of a shell tool, the path of a file tool, `domain:<host>` of a web
   *  fetch, the exact input (keys sorted) of any other tool. Stored in the
   *  `command` column, matched on its hash. */
  readonly command: string;
};

/** Tool names that run a shell command, across the CLIs whose cards reach
 *  `requestPermission` (claude's `Bash`, the ACP `execute` kind…). */
const SHELL_TOOLS = new Set(['Bash', 'execute', 'shell', 'exec', 'run_shell_command', 'local_shell']);
/** claude's tools that read or write ONE file, and the field naming it. */
const FILE_TOOLS = new Map([
  ['Edit', 'file_path'], ['MultiEdit', 'file_path'], ['Write', 'file_path'], ['Read', 'file_path'],
  ['NotebookEdit', 'notebook_path'],
]);
const URL_TOOLS = new Set(['WebFetch']);
const MAX_COMMAND_CHARS = 4000;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function shellCommand(input: unknown): string | null {
  if (!isRecord(input)) return null;
  const raw = input.command ?? input.cmd;
  const text = typeof raw === 'string'
    ? raw
    : Array.isArray(raw) && raw.every((part) => typeof part === 'string') ? raw.join(' ') : null;
  const command = text?.trim() ?? '';
  return command && command.length <= MAX_COMMAND_CHARS ? command : null;
}

/** The command a shell tool would run, or null for any other tool. */
export function shellCommandOfTool(toolName: string, input: unknown): string | null {
  return SHELL_TOOLS.has(toolName.trim()) ? shellCommand(input) : null;
}

function filePath(input: unknown, field: string): string | null {
  if (!isRecord(input)) return null;
  const raw = input[field];
  const path = typeof raw === 'string' ? raw.trim() : '';
  return path && path.length <= MAX_COMMAND_CHARS ? path : null;
}

/** `domain:<host>` of an http(s) address; the path and the query are left out,
 *  as in claude's own `WebFetch(domain:…)` rules. */
function fetchDomain(input: unknown): string | null {
  if (!isRecord(input) || typeof input.url !== 'string') return null;
  try {
    const url = new URL(input.url.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.hostname ? `domain:${url.hostname.toLowerCase()}` : null;
  } catch {
    return null;
  }
}

/** The same input always reads the same: keys sorted at every level. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function exactInput(input: unknown): string | null {
  const text = canonicalJson(input ?? {});
  return text.length <= MAX_COMMAND_CHARS ? text : null;
}

/**
 * What a remembered approval of this request would cover, or null when none
 * can be offered: a form (`ask_user`) is answered, not approved, and a call
 * whose command, file or address cannot be read would be remembered as "any".
 */
export function approvalMotif(toolName: string, input: unknown): ApprovalMotif | null {
  const tool = toolName.trim();
  if (!tool || tool === 'ask_user') return null;
  const field = FILE_TOOLS.get(tool);
  const command = SHELL_TOOLS.has(tool) ? shellCommand(input)
    : field ? filePath(input, field)
    : URL_TOOLS.has(tool) ? fetchDomain(input)
    : exactInput(input);
  return command ? { tool_name: tool, command } : null;
}

/** How a motif reads on the card and in the agent's permissions. */
export function motifLabel(motif: ApprovalMotif): string {
  return `${motif.tool_name}(${motif.command})`;
}

function commandHash(command: string): string {
  return createHash('sha256').update(command).digest('hex');
}

/** Owner and agent of a mission, from its row. No owner = nobody to remember for. */
function missionKey(missionId: string): { owner: string; agent: string } | null {
  const m = dbApi.getMission(missionId);
  return m?.owner_user_id ? { owner: m.owner_user_id, agent: m.agent_name } : null;
}

/** Whether the agent's red list names this tool, alone or with a pattern.
 *  An unreadable config counts as a refusal: fail closed. */
function deniedByAgent(agent: string, toolName: string): boolean {
  try {
    const denied = loadConfig(agent).disallowed_tools ?? [];
    return denied.some((entry) => entry === toolName || entry.startsWith(`${toolName}(`));
  } catch {
    return true;
  }
}

/** The scopes Timon can offer on this card, empty when it cannot remember it. */
export function rememberableScopes(missionId: string, toolName: string, input: unknown): readonly ApprovalScope[] {
  const motif = approvalMotif(toolName, input);
  const key = missionKey(missionId);
  if (!motif || !key || deniedByAgent(key.agent, motif.tool_name)) return [];
  return APPROVAL_SCOPES;
}

/**
 * The remembered approval that answers this request, if any. `contentState`
 * is the state of the local files the command runs (`ScriptPreviews.state`),
 * null when it runs none: a rule answers only for the same one.
 */
export function findApproval(
  missionId: string, toolName: string, input: unknown, contentState: string | null = null,
): ApprovalRuleRow | null {
  const motif = approvalMotif(toolName, input);
  const key = missionKey(missionId);
  if (!motif || !key || deniedByAgent(key.agent, motif.tool_name)) return null;
  return dbApi.findApprovalRule({
    missionId, ownerUserId: key.owner, agent: key.agent,
    toolName: motif.tool_name, commandHash: commandHash(motif.command), contentState,
  }) ?? null;
}

/** Keeps a wider Allow the human just gave; null when it cannot be kept. */
export function rememberApproval(
  missionId: string,
  toolName: string,
  input: unknown,
  scope: ApprovalScope,
  contentState: string | null = null,
): ApprovalRuleRow | null {
  const motif = approvalMotif(toolName, input);
  const key = missionKey(missionId);
  if (!motif || !key) return null;
  const where = {
    missionId, ownerUserId: key.owner, agent: key.agent,
    toolName: motif.tool_name, commandHash: commandHash(motif.command),
  };
  const existing = dbApi.findApprovalRule({ ...where, contentState });
  // Already covered at least as widely: a second row would only be a duplicate
  // to revoke.
  if (existing && (existing.scope === 'always' || scope === 'session')) return existing;
  // The same command approved for files that have changed since (or by a rule
  // older than the binding): the click moves that rule to what it saw now.
  if (contentState !== null) {
    const stale = dbApi.findApprovalRuleAtScope({ ...where, scope });
    if (stale) return dbApi.setApprovalRuleContentState(stale.id, contentState) ?? null;
  }
  return dbApi.insertApprovalRule({
    id: randomUUID(),
    scope,
    owner_user_id: key.owner,
    agent: key.agent,
    mission_id: scope === 'session' ? missionId : null,
    tool_name: motif.tool_name,
    command: motif.command,
    command_hash: commandHash(motif.command),
    content_state: contentState,
  });
}

export type AlwaysApproval = {
  id: string;
  tool_name: string;
  command: string | null;
  owner_user_id: string;
  created_at: number;
};

/** The `always` approvals of an agent, as the permissions tab shows them. */
export function listAlwaysApprovals(agent: string, ownerUserId: string | null): AlwaysApproval[] {
  return dbApi.listAlwaysApprovalRules(agent, ownerUserId).map((r) => ({
    id: r.id, tool_name: r.tool_name, command: r.command, owner_user_id: r.owner_user_id, created_at: r.created_at,
  }));
}

export function revokeApproval(id: string, agent: string, ownerUserId: string | null): boolean {
  return dbApi.deleteApprovalRule(id, agent, ownerUserId);
}
