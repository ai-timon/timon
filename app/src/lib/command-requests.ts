/**
 * A command an agent asks the user to decide (`terminal_propose`), shown as a
 * card in the mission's conversation. Mirrors `CommandRequestView`
 * (orchestrator/src/plugins-bundled/terminal-web/command-requests.ts): the app
 * and the daemon are separate packages, no import possible.
 *
 * The daemon persists both the request (`command_request`) and its outcome
 * (`command_request_resolved`) as conversation events: a reload replays them,
 * and the card comes back in the state it was left in.
 */

import { openTerminalWindow, scopeOfView, type TerminalOpenRequest, type TerminalScope } from '@/lib/terminal-web';

export const COMMAND_REQUEST_EVENT = 'command_request';
export const COMMAND_REQUEST_RESOLVED_EVENT = 'command_request_resolved';

export const COMMAND_DECISIONS = ['allow', 'paste', 'deny'] as const;
export type CommandDecision = (typeof COMMAND_DECISIONS)[number];
export type CommandRequestStatus = 'pending' | CommandDecision;

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
  /** The buttons, in this order. */
  choices: CommandDecision[];
  status: CommandRequestStatus;
  createdAt: number;
  resolvedAt: number | null;
  /** After Allow: how the daemon's run of the command ended; null while it runs. */
  run: CommandRun | null;
  /** Allow was clicked and the daemon's run has not ended. */
  running: boolean;
};

/** Mirrors `RunReport` of the daemon. */
export type CommandRun = {
  /** Null when the command was stopped (time limit) or never started. */
  exitCode: number | null;
  timedOut: boolean;
  /** Masked, the end of stdout and stderr. */
  output: string;
  durationMs: number;
  /** The daemon refused or could not start it: `output` says why. */
  notRun: boolean;
};

export function parseCommandRun(raw: unknown): CommandRun | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const timedOut = p.timedOut === true;
  const exitCode = typeof p.exitCode === 'number' ? p.exitCode : null;
  return {
    exitCode,
    timedOut,
    output: typeof p.output === 'string' ? p.output : '',
    durationMs: typeof p.durationMs === 'number' ? p.durationMs : 0,
    notRun: p.notRun === true || (exitCode === null && !timedOut),
  };
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/;

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function isDecision(value: unknown): value is CommandDecision {
  return typeof value === 'string' && (COMMAND_DECISIONS as readonly string[]).includes(value);
}

function isStatus(value: unknown): value is CommandRequestStatus {
  return value === 'pending' || isDecision(value);
}

/**
 * The payload of a `command_request` event (or a row of the list route), or
 * null when it is not one. A command holding a control character is refused
 * here too: the daemon filters them, but this text ends up at a shell prompt,
 * where a line break would run it.
 */
export function parseCommandRequest(raw: unknown): CommandRequestView | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  const missionId = str(p.missionId);
  const agent = str(p.agent);
  const command = str(p.command);
  if (!id || !missionId || !agent || !command || CONTROL_CHARS.test(command)) return null;
  const choices = Array.isArray(p.choices) ? COMMAND_DECISIONS.filter((d) => (p.choices as unknown[]).includes(d)) : [];
  return {
    id,
    missionId,
    agent,
    command,
    note: str(p.note),
    sessionId: str(p.sessionId),
    project: str(p.project),
    missionTitle: str(p.missionTitle) ?? '',
    taskId: str(p.taskId),
    choices,
    status: isStatus(p.status) ? p.status : 'pending',
    createdAt: typeof p.createdAt === 'number' ? p.createdAt : 0,
    resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null,
    run: parseCommandRun(p.run),
    running: p.running === true,
  };
}

/**
 * The paste part of a permission card's payload (`shell_command` + `choices`),
 * or null when the card offers only Allow / Deny. Same control-character rule
 * as a request: the command is typed at a prompt.
 */
export function shellCardOf(raw: { shell_command?: unknown; choices?: unknown }): { shell_command: string; choices: CommandDecision[] } | null {
  const command = str(raw.shell_command);
  if (!command || CONTROL_CHARS.test(command) || !Array.isArray(raw.choices)) return null;
  const choices = COMMAND_DECISIONS.filter((d) => (raw.choices as unknown[]).includes(d));
  return choices.includes('paste') ? { shell_command: command, choices } : null;
}

export type CommandResolution = {
  id: string;
  status: CommandDecision;
  resolvedAt: number | null;
  run: CommandRun | null;
  running: boolean;
};

/** The payload of a `command_request_resolved` event, or null. */
export function parseCommandResolution(raw: unknown): CommandResolution | null {
  if (!raw || typeof raw !== 'object') return null;
  const p = raw as Record<string, unknown>;
  const id = str(p.id);
  if (!id || !isDecision(p.status)) return null;
  return {
    id, status: p.status, resolvedAt: typeof p.resolvedAt === 'number' ? p.resolvedAt : null,
    run: parseCommandRun(p.run), running: p.running === true,
  };
}

/**
 * A decision is final: a late or replayed event never sends a card back to
 * pending. The one thing that follows it is the daemon's run after Allow,
 * which arrives in a second event of the same decision.
 */
export function applyResolution(request: CommandRequestView, resolution: CommandResolution): CommandRequestView {
  if (request.id !== resolution.id) return request;
  if (request.status === 'pending') {
    return { ...request, status: resolution.status, resolvedAt: resolution.resolvedAt, run: resolution.run, running: resolution.running };
  }
  if (request.status === 'allow' && resolution.status === 'allow' && resolution.run && !request.run) {
    return { ...request, run: resolution.run, running: false };
  }
  return request;
}

/**
 * The freshest of two copies of the same card: a decided one wins over a
 * pending one, and among two pending ones the server's list, read later,
 * carries the buttons offered now.
 */
export function freshest(event: CommandRequestView, listed: CommandRequestView | null | undefined): CommandRequestView {
  if (!listed || listed.id !== event.id) return event;
  if (event.status !== 'pending') {
    // The run's end can be in the list before it reaches the event stream.
    return event.status === 'allow' && !event.run && listed.run ? listed : event;
  }
  return listed;
}

export type ResolveError = 'not_offered' | 'already_decided' | 'forbidden' | 'not_found' | 'failed';
export type ResolveOutcome = { ok: true; request: CommandRequestView | null } | { ok: false; error: ResolveError };

/** Same names as the daemon's `origin` vocabulary for these cards. */
export type CommandOrigin = 'ui_card_allow' | 'ui_card_paste' | 'ui_card_deny';

export const ORIGIN_OF: Record<CommandDecision, CommandOrigin> = {
  allow: 'ui_card_allow',
  paste: 'ui_card_paste',
  deny: 'ui_card_deny',
};

export async function resolveCommandRequest(id: string, decision: CommandDecision): Promise<ResolveOutcome> {
  let r: Response;
  try {
    r = await fetch(`/api/ui/terminal/web/proposals/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision, origin: ORIGIN_OF[decision] }),
    });
  } catch {
    return { ok: false, error: 'failed' };
  }
  if (r.ok) {
    const j = await r.json().catch(() => ({})) as { request?: unknown };
    return { ok: true, request: parseCommandRequest(j.request) };
  }
  if (r.status === 409) return { ok: false, error: 'already_decided' };
  if (r.status === 400) return { ok: false, error: 'not_offered' };
  if (r.status === 401 || r.status === 403) return { ok: false, error: 'forbidden' };
  if (r.status === 404) return { ok: false, error: 'not_found' };
  return { ok: false, error: 'failed' };
}

/** The mission's requests as the daemon has them now (decided ones included). */
export async function fetchCommandRequests(missionId: string, signal?: AbortSignal): Promise<CommandRequestView[]> {
  const qs = new URLSearchParams({ mission_id: missionId, limit: '500' });
  const r = await fetch(`/api/ui/terminal/web/proposals?${qs.toString()}`, { cache: 'no-store', signal });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as { requests?: unknown[] };
  return (j.requests ?? []).map(parseCommandRequest).filter((x): x is CommandRequestView => x !== null);
}

export type PendingByProject = { total: number; projects: { project: string | null; pending: number }[] };

export async function fetchPendingCommandRequests(signal?: AbortSignal): Promise<PendingByProject> {
  const r = await fetch('/api/ui/terminal/web/proposals/pending', { cache: 'no-store', signal });
  // An older daemon, or the terminal module off: nothing waits.
  if (r.status === 404) return { total: 0, projects: [] };
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json() as Partial<PendingByProject>;
  const projects = Array.isArray(j.projects)
    ? j.projects.filter((p) => p && typeof p.pending === 'number' && (p.project === null || typeof p.project === 'string'))
    : [];
  return { total: typeof j.total === 'number' ? j.total : 0, projects };
}

/** Pending requests of one project, slugs compared without case. */
export function pendingFor(pending: PendingByProject, slug: string): number {
  const key = slug.toLowerCase();
  return pending.projects.reduce((n, p) => (p.project?.toLowerCase() === key ? n + p.pending : n), 0);
}

/** The terminal a request goes to: its mission's project, else its agent's own. */
export function commandScope(request: Pick<CommandRequestView, 'project' | 'agent'>): TerminalScope | null {
  return scopeOfView(request.project, request.agent);
}

export type PasteOutcome =
  /** Decided, and the command waits at the prompt of the scope's terminal. */
  | { kind: 'pasted' }
  /** Decided, but the window of that scope is not on screen: the user pastes it by hand. */
  | { kind: 'window_refused' }
  /** Not decided: nothing was opened. */
  | { kind: 'not_resolved' };

/**
 * "Paste into a terminal": records the decision first, then types the
 * command — without Enter — in the terminal of the scope it belongs to. The
 * view takes it when that scope is the one on screen, or when the view has no
 * project of its own (a multichat cell, the cockpit); a conversation shown
 * over another project's view gets `window_refused`.
 */
export async function pasteIntoTerminal(opts: {
  resolve: () => Promise<boolean>;
  scope: TerminalScope | null;
  command: string;
  sessionId?: string | null;
  open?: (request: TerminalOpenRequest) => boolean;
}): Promise<PasteOutcome> {
  if (!(await opts.resolve())) return { kind: 'not_resolved' };
  const open = opts.open ?? openTerminalWindow;
  const taken = open({
    scope: opts.scope,
    insert: opts.command,
    ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
  });
  return taken ? { kind: 'pasted' } : { kind: 'window_refused' };
}
