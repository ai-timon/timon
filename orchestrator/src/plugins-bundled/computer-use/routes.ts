import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { loadConfig, storedComputerUseAllApps, storedComputerUseApps, storedComputerUseExcludedApps, storedComputerUseMode, type ComputerUseApp, type ComputerUseMode } from '../../agent-config.js';
import { apiError } from '../../api-error.js';
import { dbApi } from '../../db.js';
import { scopedDb } from '../../users/scoped-db.js';
import { isPersonAuth, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { proposeComputerUse, registerComputerUseProposalKind } from './proposals.js';
import { callNativeComputer, computerErrorBody, NativeComputerError, type ComputerActor } from '../../native-computer-provider.js';

// Logical points of the screenshot's frame: bounded so a bad value never reaches the desktop's input driver.
const coord = z.number().finite().min(-100_000).max(100_000);
const empty = z.object({}).strict();
const point = z.object({ x: coord, y: coord }).strict();

/** The closed list of commands, each with the only arguments it accepts. */
const SCHEMAS = {
  status: empty,
  // `windowId`: an id from list_windows, or "front" for the window in front; only its rectangle is captured.
  screenshot: z.object({ maxWidth: z.number().int().min(64).max(4096).optional(), windowId: z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/).optional() }).strict(),
  cursor_position: empty,
  move: point,
  click: z.object({ x: coord, y: coord, button: z.enum(['left', 'right', 'middle']).optional() }).strict(),
  double_click: point,
  drag: z.object({ fromX: coord, fromY: coord, toX: coord, toY: coord }).strict(),
  type: z.object({ text: z.string().min(1).max(2000) }).strict(),
  key: z.object({ keys: z.string().min(1).max(100) }).strict(),
  scroll: z.object({ x: coord, y: coord, deltaX: coord.optional(), deltaY: coord }).strict(),
  list_windows: empty,
  // An opaque id read from list_windows (a window number, `pid:index`): never a path or a title.
  focus_window: z.object({ id: z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/) }).strict(),
  // Read a window as elements; `windowId` is an id from list_windows, absent = the window in front.
  a11y_tree: z.object({
    windowId: z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/).optional(),
    maxDepth: z.number().int().min(1).max(15).optional(),
    maxNodes: z.number().int().min(1).max(1500).optional(),
    query: z.string().max(200).optional(),
  }).strict(),
  // An element id read from a11y_tree: the window id, `#`, then the index path. `value` is for set_value only.
  a11y_action: z.object({
    id: z.string().regex(/^[A-Za-z0-9:_.-]{1,64}#\d{1,4}(\.\d{1,4}){0,14}$/),
    action: z.enum(['press', 'focus', 'set_value', 'select', 'expand', 'collapse', 'show_menu', 'scroll_into_view']),
    value: z.string().max(2000).optional(),
  }).strict().refine((args) => (args.action === 'set_value') === (args.value !== undefined), { message: 'value is required by set_value and refused by every other action' }),
  // A person's question when adding an application: is its tree rich enough for the background mode?
  a11y_probe_app: z.object({ windowId: z.string().regex(/^[A-Za-z0-9:_.-]{1,64}$/) }).strict(),
  wait: z.object({ ms: z.number().int().min(0).max(10_000) }).strict(),
  stop: empty,
  resume: empty,
  request_permissions: empty,
  restart_app: empty,
} as const;
type ComputerCommand = keyof typeof SCHEMAS;

const isCommand = (value: string): value is ComputerCommand => Object.hasOwn(SCHEMAS, value);
// A person's session may read the state, list the open windows (to fill the allowed applications) and use the stop switch; nothing else.
const personCommands = new Set<ComputerCommand>(['status', 'list_windows', 'a11y_probe_app', 'stop', 'resume', 'request_permissions', 'restart_app']);
// The user's switch: an agent never stops or resumes itself.
// Setting up the machine (system prompts, restart) is the person's too.
const humanOnly = new Set<ComputerCommand>(['stop', 'resume', 'request_permissions', 'restart_app', 'a11y_probe_app']);

export const COMPUTER_COMMANDS: readonly string[] = Object.freeze(Object.keys(SCHEMAS));

// The caller builds the error with a literal code: the catalogue test reads the codes from the call sites.
function refuse(error: ReturnType<typeof apiError>, status: number): never {
  throw new NativeComputerError(error, status);
}

/** Who the desktop sees behind a command: the daemon's reading of the authentication, never the caller's. */
type AgentScope = { allowedApps: ComputerUseApp[]; mode: ComputerUseMode; allApps?: true; excludedApps?: string[] };

function actorOf(req: Request, command: ComputerCommand): { actor: ComputerActor; scope?: AgentScope; agent?: string } {
  if (isPersonAuth(req.auth)) {
    if (!personCommands.has(command)) refuse(apiError('computer_mission_token_required', 'A mission-bound token is required to control the computer.'), 403);
    return { actor: 'human' };
  }
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) {
    refuse(apiError('computer_mission_token_required', 'A mission-bound token is required to control the computer.'), 403);
  }
  if (humanOnly.has(command)) refuse(apiError('computer_command_user_only', 'Stopping, resuming and setting up computer control is reserved for the user.'), 403);
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  let enabled = false;
  let scope: AgentScope = { allowedApps: [], mode: 'foreground' };
  try {
    const config = mission ? loadConfig(mission.agent_name) : null;
    enabled = config?.computer_use === true;
    if (config) {
      scope = { allowedApps: storedComputerUseApps(config), mode: storedComputerUseMode(config) };
      // The exclusions always travel with the switch: the desktop refuses "All applications" without them.
      if (storedComputerUseAllApps(config)) Object.assign(scope, { allApps: true, excludedApps: storedComputerUseExcludedApps(config) });
    }
  } catch { /* an unreadable config grants nothing */ }
  if (!enabled) refuse(apiError('computer_use_disabled', 'Computer use is turned off for this agent.'), 403);
  // Read here, from the agent's own config, and handed to the desktop with every command: the desktop refuses what is not listed.
  // The mode travels the same way: the desktop enforces it, the caller cannot choose it.
  // The agent's name only labels the pointer the desktop draws over the screen: it grants nothing.
  return { actor: 'agent', scope, ...(mission ? { agent: mission.agent_name } : {}) };
}

/** The agent and mission behind an agent's command, for the journal; null for a person or an unbound token. */
function journalContext(req: Request): { agent: string; missionId: string } | null {
  if (req.auth?.kind !== 'api-token' || !req.auth.missionId) return null;
  const mission = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
  return mission ? { agent: mission.agent_name, missionId: req.auth.missionId } : null;
}

/** What the journal keeps of the arguments: coordinates and keys yes, typed text and a set value never (only their length). */
function journalArgs(command: ComputerCommand, body: unknown): Record<string, unknown> {
  const parsed = SCHEMAS[command].safeParse(body ?? {});
  if (!parsed.success) return { invalid: true };
  const args = parsed.data as Record<string, unknown>;
  if (command === 'type') return { length: (args.text as string).length };
  // The value written into a field can be a password: only its length is kept.
  if (command === 'a11y_action' && typeof args.value === 'string') return { id: args.id, action: args.action, valueLength: args.value.length };
  return args;
}

function record(ctx: { agent: string; missionId: string } | null, command: ComputerCommand, body: unknown, started: number, result: string): void {
  if (!ctx) return;
  // A failing journal never blocks the command it describes.
  try {
    dbApi.recordComputerJournal({ agent: ctx.agent, mission_id: ctx.missionId, command, args: journalArgs(command, body), result, duration_ms: Date.now() - started });
  } catch { /* nothing to do: the journal is best effort */ }
}

/** `call` is injected in HTTP tests; production never accepts a caller-selected endpoint. */
export function registerComputerRoutes(app: Router, deps: { call?: typeof callNativeComputer } = {}): void {
  const call = deps.call ?? callNativeComputer;
  registerComputerUseProposalKind();
  // Before `/:command`, which would read "proposals" as an unknown command.
  app.post('/api/computer/proposals', (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const out = proposeComputerUse(req, req.body);
    res.status(out.status).json(out.body);
  });
  // Read by people only (session or device): an agent's or a mission's token never reads its own journal.
  app.get('/api/computer/journal', (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    if (!isPersonAuth(req.auth)) {
      res.status(403).json(apiError('computer_journal_people_only', 'The computer-use journal is reserved to people.'));
      return;
    }
    const agent = typeof req.query.agent === 'string' ? req.query.agent : '';
    if (!agent || agent.length > 200) {
      res.status(400).json(apiError('computer_args_invalid', 'An agent name is required.'));
      return;
    }
    const limit = Number(req.query.limit ?? 50);
    res.json({ ok: true, entries: dbApi.listComputerJournal(agent, Number.isFinite(limit) ? limit : 50) });
  });
  app.post('/api/computer/:command', async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    const started = Date.now();
    let ctx: ReturnType<typeof journalContext> = null;
    let known: ComputerCommand | null = null;
    let result = 'ok';
    try {
      const command = String(req.params.command);
      if (!isCommand(command)) refuse(apiError('computer_command_unknown', 'Unknown computer command.'), 400);
      known = command;
      ctx = journalContext(req);
      const { actor, scope, agent } = actorOf(req, command);
      // `actor` and every other key a caller adds are refused: the schema is strict, the body is only the arguments.
      const parsed = SCHEMAS[command].safeParse(req.body ?? {});
      if (!parsed.success) refuse(apiError('computer_args_invalid', 'Invalid arguments for this computer command.'), 400);
      const args = parsed.data as Record<string, unknown>;
      if (command === 'wait') {
        await new Promise((resolve) => setTimeout(resolve, args.ms as number));
        res.json({ ok: true, result: { waited: args.ms } });
        return;
      }
      res.json({ ok: true, result: await call(command, args, actor, scope ? { ...scope, ...(agent ? { agent } : {}) } : {}) });
    } catch (error) {
      result = computerErrorBody(error).code;
      res.status(error instanceof NativeComputerError ? error.status : 400).json(computerErrorBody(error));
    } finally {
      if (known) record(ctx, known, req.body, started, result);
    }
  });
}
