/**
 * Command requests: a command an agent cannot run itself (`terminal_propose`:
 * sudo, a password, a rebuild that would kill its own mission), shown as a
 * card in its mission's conversation. The owner answers there:
 *   - `allow` — the agent runs it itself (only for a backend that can ask
 *     mid-turn: a `sandbox` one has its rights fixed at launch);
 *   - `paste` — the owner's browser opens the project's terminal and types the
 *     command WITHOUT Enter; the agent learns the user runs it;
 *   - `deny`.
 *
 * The answer comes back to the agent in its turn when it arrives within a
 * short wait (`waitForDecision`), otherwise as a message once its turn is
 * over (`deliverLate`). An unattended mission does not wait at all
 * (`expectLateAnswer`), yet still gets the answer while it runs. Nothing blocks
 * for long: a codex MCP call dies at 60 s, the MCP server's `fetch` at 300 s,
 * and an unattended mission must not wait for a human who is not there.
 *
 * Unlike a permission card, a request is not tied to its turn nor to its
 * mission: the coder proposes the rebuild, then closes its task, and the owner
 * still has the command to paste. It lives in the `command_requests` table,
 * and its two events (`command_request`, `command_request_resolved`) put it in
 * the conversation, for a page reloaded mid-request.
 */
import { daemonMessage } from '../../daemon-message.js';
import { getAgent, missionPermissionModel } from '../../agent.js';
import type { PermissionModel } from '../../backends/types.js';
import { bus } from '../../bus.js';
import { agentStillListening, deliverLate, LIVE_DELIVERY, type LateDelivery } from '../../late-delivery.js';

export { agentStillListening, deliverLate, type LateDelivery };
import { dbApi, type CardOriginKind, type CommandRequestRow, type CommandRequestStatus, type MissionRow, type UserRow } from '../../db.js';
import { createNotification } from '../../notifications.js';
import { moduleActive } from '../../kernel/module-state.js';
import { taskProjectSlug } from '../../task-project.js';
import { userAllows } from '../../users/permissions.js';
import { TERMINAL_PERMISSION, terminalWebEnabled } from './access.js';

export const MAX_COMMAND_CHARS = 2_000;

/**
 * One line of printable text. A newline would run the command on its own, and
 * any other control character (ESC, backspace, Ctrl+C…) could rewrite what the
 * owner reads: both are refused rather than stripped.
 */
export function isSingleLineCommand(command: string): boolean {
  // eslint-disable-next-line no-control-regex
  return command.trim().length > 0 && !/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/.test(command);
}

/** Who raises a command request when it is a third-party plugin, not the mission's agent. */
export type RequestOrigin = { kind: 'plugin'; id: string };

const MAX_TITLE_CHARS = 120;

/**
 * Where a proposal comes from, so the owner can tell two `*.coder` agents
 * apart: with several projects running at once, an agent name alone does not
 * say which shell the command was meant for (TIM-0072). The prompt
 * (`mission.mission`) is never a label: it may quote a secret. Only a title
 * the user or a task gave is shown, else the start of the mission id.
 */
export function proposalOrigin(mission: MissionRow): { project: string | null; missionTitle: string; taskId: string | null } {
  const task = mission.task_id ? dbApi.getTask(mission.task_id) : undefined;
  let agent: ReturnType<typeof getAgent> = null;
  // A renamed or deleted agent still has missions: the origin degrades, the proposal stays.
  try { agent = getAgent(mission.agent_name); } catch { agent = null; }
  const project = taskProjectSlug({ project: task?.project ?? null }, agent);
  // The browser drops a label with a control character: a tab must not cost the title.
  // eslint-disable-next-line no-control-regex
  const title = (mission.title?.trim() || task?.title?.trim() || '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').trim().slice(0, MAX_TITLE_CHARS);
  return { project, missionTitle: title || mission.id.slice(0, 8), taskId: mission.task_id };
}

/**
 * The command a tool use runs, when it can be pasted into a terminal: a shell
 * call (`Bash` for claude, ACP's `execute` maps to it too) on ONE line. A
 * multi-line command is never offered for pasting: the first newline would run
 * the text before it.
 */
export function shellCommandOf(toolName: string, input: unknown): string | null {
  if (toolName !== 'Bash' || typeof input !== 'object' || input === null) return null;
  const command = (input as { command?: unknown }).command;
  if (typeof command !== 'string' || command.length > MAX_COMMAND_CHARS || !isSingleLineCommand(command)) return null;
  return command;
}

/** Whether the owner of a mission could open the web terminal to paste a command in. */
export function ownerCanPaste(mission: MissionRow | undefined): boolean {
  // The module checked too, not only its setting: a permission card is answered
  // through `missions`, which stays mounted when the terminal module is off.
  if (!moduleActive('@timon/terminal-web')) return false;
  const owner = mission?.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
  if (!owner || owner.status !== 'active' || !terminalWebEnabled()) return false;
  return userAllows(owner, dbApi.listPermissionsForUser(owner.id), TERMINAL_PERMISSION);
}

/**
 * What the agent reads after "Paste into a terminal": a refusal that says who
 * runs the command, so it neither retries it nor reports it as refused.
 */
export function pasteReply(command: string): string {
  return `The user runs \`${command}\` themselves, in their own terminal: you do not run it and you get no output back. `
    + 'Do not run or propose it again. If you need its result, ask the user for it.';
}

export const COMMAND_REQUEST_EVENT = 'command_request';
export const COMMAND_REQUEST_RESOLVED_EVENT = 'command_request_resolved';
export const COMMAND_DECISIONS = ['allow', 'paste', 'deny'] as const;
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];

/**
 * Buttons of a request. `allow` needs a backend that takes a decision mid-turn;
 * a `sandbox` one (codex, grok, copilot), or a mission no process serves right
 * now, cannot act on it.
 */
export function commandChoices(model: PermissionModel | null): CommandDecision[] {
  return model === 'mcp-bridge' || model === 'protocol' ? ['allow', 'paste', 'deny'] : ['paste', 'deny'];
}

/** The request as the UI and the agent see it, in the events and the routes alike. */
export type CommandRequestView = {
  id: string;
  missionId: string;
  agent: string;
  command: string;
  note: string | null;
  sessionId: string | null;
  project: string | null;
  missionTitle: string;
  taskId: string | null;
  /** `agent` unless a plugin raised it. */
  origin: { kind: CardOriginKind; id: string | null };
  choices: CommandDecision[];
  status: CommandRequestStatus;
  createdAt: number;
  resolvedAt: number | null;
};

function parseChoices(raw: string): CommandDecision[] {
  try {
    const list = JSON.parse(raw) as unknown;
    return Array.isArray(list) ? COMMAND_DECISIONS.filter((d) => list.includes(d)) : [];
  } catch {
    return [];
  }
}

/** `choices`: what the card offers now (`offeredChoices`), when it may have narrowed since it was raised. */
export function commandRequestView(row: CommandRequestRow, choices?: CommandDecision[]): CommandRequestView {
  return {
    id: row.id,
    missionId: row.mission_id,
    agent: row.agent,
    command: row.command,
    note: row.note,
    sessionId: row.session_id,
    project: row.project,
    missionTitle: row.mission_title,
    taskId: row.task_id,
    origin: { kind: row.origin_kind, id: row.origin_id },
    choices: choices ?? parseChoices(row.choices),
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/** What the agent reads once the owner decided. */
export function commandReply(status: CommandRequestStatus, command: string): string {
  switch (status) {
    case 'allow':
      return `The user allowed \`${command}\`: run it yourself now with your shell tool `
        + '(it may still raise its own permission card).';
    case 'paste':
      return pasteReply(command);
    case 'deny':
      // "Dismiss" only closes the card: the user may have run the command already, so it is no refusal.
      return `The user dismissed the card for \`${command}\` without deciding: they may have run it themselves. `
        + 'Do not run it. Do not propose it again for now: carry on, and ask the user if you need its result.';
    default:
      return PENDING_REPLY;
  }
}

/** The agent waited and nobody answered yet: it must not wait on, nor retry. */
export const PENDING_REPLY =
  'The command is shown as a card in this conversation and the user has not answered yet. '
  + 'Do not propose it again: their decision will come back to you as a message. Carry on, or end your turn.';

/** Nobody watches an unattended mission: the card waits for the owner, the agent does not. */
export const UNATTENDED_REPLY =
  'The command is shown as a card in this mission\'s conversation, for the user to decide later. '
  + 'This mission runs unattended: do not wait for an answer and do not propose it again. If the user '
  + 'decides while this mission still runs, their decision comes back to you as a message. Also write '
  + 'the command in your final report (or your task\'s done comment) so it is not missed.';

function publish(missionId: string, type: string, payload: object): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  bus.publish({ kind: 'event', missionId, type, timestamp: row.timestamp, payload });
}

function shortCommand(command: string): string {
  return command.length > 80 ? `${command.slice(0, 79)}…` : command;
}

/**
 * Records the request, puts its card in the conversation and notifies the
 * owner: the notification leads to the mission, whichever project is on screen.
 */
export function createCommandRequest(input: {
  id: string;
  mission: MissionRow;
  owner: UserRow;
  command: string;
  note?: string | null;
  sessionId?: string | null;
  /** Of the backend serving the mission: decides whether `allow` is offered. */
  model: PermissionModel | null;
  /** Absent: the mission's agent raised it. A plugin's card offers paste and dismiss only. */
  origin?: RequestOrigin;
}): CommandRequestRow {
  const { mission, owner } = input;
  const origin = proposalOrigin(mission);
  const row = dbApi.insertCommandRequest({
    id: input.id,
    mission_id: mission.id,
    owner_user_id: owner.id,
    agent: input.origin ? `plugin:${input.origin.id}` : mission.agent_name,
    command: input.command,
    note: input.note ?? null,
    session_id: input.sessionId ?? null,
    project: origin.project,
    mission_title: origin.missionTitle,
    task_id: origin.taskId,
    // No agent runs a plugin's command: `allow` has nobody to ask.
    choices: JSON.stringify(commandChoices(input.origin ? null : input.model)),
    origin_kind: input.origin ? 'plugin' : 'agent',
    origin_id: input.origin?.id ?? null,
  });
  publish(mission.id, COMMAND_REQUEST_EVENT, commandRequestView(row));
  createNotification({
    type: 'action_required',
    urgent: true,
    title: `Command to decide: ${row.agent}`,
    message: daemonMessage('command_to_decide', { agent: row.agent }),
    body: `${row.mission_title}${row.project ? ` (${row.project})` : ''} — \`${shortCommand(row.command)}\``
      + (row.note ? `. ${row.note}` : ''),
    missionId: mission.id,
    taskId: row.task_id,
    // The card's id: the notification is dismissed with it, and deep-links to it.
    anchor: row.id,
    ownerUserId: owner.id,
  });
  return row;
}

const WAITERS = new Map<string, (row: CommandRequestRow) => void>();
/** Requests whose agent was told the answer would come back as a message. */
const LATE = new Set<string>();

/**
 * The agent was answered without waiting (unattended mission): its answer
 * will go out as a message, like one that came after `waitForDecision` gave up.
 */
export function expectLateAnswer(id: string): void {
  LATE.add(id);
}

type ModelOf = (missionId: string) => PermissionModel | null;

/**
 * The buttons a request offers NOW. `allow` asks the agent to run the command:
 * it stays only while an agent will hear it — one still waiting in its call,
 * or one promised a late answer whose mission runs on a backend that can act
 * on it. Once nobody can run it (mission over, daemon restarted, task closed)
 * the card keeps paste and deny only.
 */
export function offeredChoices(row: CommandRequestRow, modelOf: ModelOf = missionPermissionModel): CommandDecision[] {
  const stored = parseChoices(row.choices);
  if (row.status !== 'pending' || !stored.includes('allow') || WAITERS.has(row.id)) return stored;
  const reachable = LATE.has(row.id) && agentStillListening(row.mission_id)
    && commandChoices(modelOf(row.mission_id)).includes('allow');
  return reachable ? stored : stored.filter((d) => d !== 'allow');
}

/**
 * Waits up to `ms` for the owner's answer. Null when it did not come (time out,
 * or `signal` — the agent's HTTP call went away): the answer will then be
 * delivered as a message (`deliverLate`).
 */
export function waitForDecision(id: string, ms: number, signal?: AbortSignal): Promise<CommandRequestRow | null> {
  const now = dbApi.getCommandRequest(id);
  if (!now || now.status !== 'pending') return Promise.resolve(now ?? null);
  return new Promise((done) => {
    let settled = false;
    const finish = (row: CommandRequestRow | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (WAITERS.get(id) === waiter) WAITERS.delete(id);
      if (!row) LATE.add(id);
      done(row);
    };
    const waiter = (row: CommandRequestRow): void => finish(row);
    const onAbort = (): void => finish(null);
    const timer = setTimeout(() => finish(null), Math.max(0, ms));
    timer.unref?.();
    WAITERS.set(id, waiter);
    if (signal?.aborted) finish(null);
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export type ResolveOutcome =
  | { ok: true; row: CommandRequestRow }
  | { ok: false; error: 'not_found' | 'already_decided' | 'not_offered' };

export type ResolveOptions = {
  /** Where a late answer goes; tests stand in for the agent. */
  deliver?: (missionId: string, text: string) => void;
  /** The backend serving the mission now; tests stand in for a live one. */
  permissionModel?: ModelOf;
};

/** Settles a pending request and hands the answer to the agent. Who may call it: the route. */
export function resolveCommandRequest(
  id: string,
  decision: CommandDecision,
  origin: string,
  opts: ResolveOptions = {},
): ResolveOutcome {
  const deliver = opts.deliver ?? deliverLate;
  const before = dbApi.getCommandRequest(id);
  if (!before) return { ok: false, error: 'not_found' };
  if (!offeredChoices(before, opts.permissionModel).includes(decision)) return { ok: false, error: 'not_offered' };
  if (!dbApi.settleCommandRequest(id, decision)) return { ok: false, error: 'already_decided' };
  const row = dbApi.getCommandRequest(id)!;
  publish(row.mission_id, COMMAND_REQUEST_RESOLVED_EVENT, {
    id, status: row.status, origin, resolvedAt: row.resolved_at,
  });
  const waiter = WAITERS.get(id);
  const wasLate = LATE.delete(id);
  if (waiter) {
    waiter(row);
  } else if (wasLate && decision !== 'deny' && agentStillListening(row.mission_id)) {
    // A dismissal says nothing the agent needs: a message would wake it for a
    // turn to read "never mind" (the card is closed, the notification gone).
    deliver(row.mission_id, `[command request] ${commandReply(row.status, row.command)}`);
  }
  return { ok: true, row };
}

/**
 * After "Paste into a terminal" on the permission card of an agent that only
 * heard "rejected" (ACP): who runs the command, once its turn is over. The
 * command stays refused; the turn is not interrupted to say so.
 */
export function relayPasteReply(missionId: string, command: string, via: LateDelivery = LIVE_DELIVERY): void {
  deliverLate(missionId, `[permission] ${pasteReply(command)}`, via);
}
