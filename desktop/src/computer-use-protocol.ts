/** Commands of the computer-native service: validation of what the daemon sends, and the shared error type. */

import { A11Y_ACTIONS, A11Y_DEFAULT_MAX_DEPTH, A11Y_DEFAULT_MAX_NODES, A11Y_MAX_DEPTH, A11Y_MAX_NODES, A11Y_MAX_QUERY, A11Y_MAX_VALUE, parseElementId, type A11yAction } from './computer-use-a11y.js';

export const COMPUTER_MAX_TEXT = 2000;
export const COMPUTER_MAX_WAIT_MS = 10_000;
/**
 * 1024 px: the cost of an image to the model grows with its pixels, and 1024 is a whole number of
 * the 512 px tiles some models bill by. Wide enough to read ordinary text; an agent asks for more when needed.
 */
export const COMPUTER_DEFAULT_MAX_WIDTH = 1024;

export type ComputerActor = 'agent' | 'human';
export type ComputerUnavailableReason =
  'wayland' | 'no-input-tool' | 'permission-accessibility' | 'permission-screen' | 'no-desktop';
export type MouseButton = 'left' | 'right' | 'middle';

export class ComputerCommandError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'invalid_command') {
    super(message);
  }
}

export type ComputerCommand =
  | { command: 'status' }
  | { command: 'screenshot'; maxWidth: number }
  | { command: 'cursor_position' }
  | { command: 'move'; x: number; y: number }
  | { command: 'click'; x: number; y: number; button: MouseButton }
  | { command: 'double_click'; x: number; y: number }
  | { command: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { command: 'type'; text: string }
  | { command: 'key'; keys: string }
  | { command: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { command: 'list_windows' }
  | { command: 'focus_window'; id: string }
  | { command: 'a11y_tree'; windowId?: string; maxDepth: number; maxNodes: number; query?: string }
  | { command: 'a11y_action'; id: string; action: A11yAction; value?: string }
  | { command: 'a11y_probe_app'; windowId: string }
  | { command: 'wait'; ms: number }
  | { command: 'stop' }
  | { command: 'resume' }
  | { command: 'request_permissions' }
  | { command: 'restart_app' };

const NAMES = new Set(['status', 'screenshot', 'cursor_position', 'move', 'click', 'double_click', 'drag',
  'type', 'key', 'scroll', 'list_windows', 'focus_window', 'a11y_tree', 'a11y_action', 'a11y_probe_app', 'wait', 'stop', 'resume', 'request_permissions', 'restart_app']);

function coordinate(args: Record<string, unknown>, name: string): number {
  const value = args[name];
  // Bounded: a coordinate far outside any screen is a bug upstream, never an intent.
  if (typeof value !== 'number' || !Number.isFinite(value) || value < -100_000 || value > 100_000) {
    throw new ComputerCommandError(`"${name}" must be a finite number.`);
  }
  return value;
}

function optionalDelta(args: Record<string, unknown>, name: string): number {
  if (args[name] === undefined) return 0;
  const value = coordinate(args, name);
  return Math.max(-10_000, Math.min(10_000, value));
}

export type ComputerUseMode = 'foreground' | 'background';

/** An allowed application with the mode it is driven in. */
export interface AllowedApp { app: string; mode: ComputerUseMode }

/**
 * The applications an agent may act in, as the daemon sends them with each agent command: `{ app, mode }`
 * objects. A bare string is accepted and takes `fallback` (the agent's default mode).
 */
export function parseAllowedApps(value: unknown, fallback: ComputerUseMode = 'foreground'): AllowedApp[] {
  if (value === undefined || value === null) return [];
  const bad = () => new ComputerCommandError('"allowedApps" must be an array of at most 100 short names or { app, mode } objects.');
  if (!Array.isArray(value) || value.length > 100) throw bad();
  return value.map((entry): AllowedApp => {
    if (typeof entry === 'string' && entry.length <= 200) return { app: entry, mode: fallback };
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const { app, mode } = entry as { app?: unknown; mode?: unknown };
      if (typeof app === 'string' && app.length <= 200 && (mode === 'foreground' || mode === 'background')) return { app, mode };
    }
    throw bad();
  });
}

export const COMPUTER_EXCLUDED_APPS_MAX = 200;

/** "All applications": every application but `excluded`, the unlisted ones in `mode`. */
export interface AllAppsScope { mode: ComputerUseMode; excluded: string[] }

/**
 * "All applications" as the daemon sends it with an agent command: `allApps: true` with the list of
 * excluded names. Absent or false is off. On without a list is refused: the exclusions are what makes
 * the switch safe, so the desktop never assumes there are none.
 */
export function parseAllAppsScope(allApps: unknown, excludedApps: unknown, mode: ComputerUseMode): AllAppsScope | null {
  if (allApps === undefined || allApps === null || allApps === false) return null;
  if (allApps !== true) throw new ComputerCommandError('"allApps" must be a boolean.');
  const bad = () => new ComputerCommandError(`"excludedApps" must be an array of at most ${COMPUTER_EXCLUDED_APPS_MAX} short names when "allApps" is on.`);
  if (!Array.isArray(excludedApps) || excludedApps.length > COMPUTER_EXCLUDED_APPS_MAX) throw bad();
  if (excludedApps.some((entry) => typeof entry !== 'string' || entry.length > 200)) throw bad();
  return { mode, excluded: excludedApps as string[] };
}

/** The agent's default mode as the daemon sends it with each agent command; absent means the foreground. */
export function parseComputerMode(value: unknown): ComputerUseMode {
  if (value === undefined || value === null || value === 'foreground') return 'foreground';
  if (value === 'background') return 'background';
  throw new ComputerCommandError('"mode" must be "foreground" or "background".');
}

export function parseComputerActor(value: unknown): ComputerActor {
  if (value === 'agent' || value === 'human') return value;
  throw new ComputerCommandError('"actor" must be "agent" or "human".');
}

export function parseComputerCommand(name: unknown, rawArgs: unknown): ComputerCommand {
  if (typeof name !== 'string' || !NAMES.has(name)) throw new ComputerCommandError('Unknown computer command.', 404, 'unknown_command');
  if (rawArgs !== undefined && (typeof rawArgs !== 'object' || rawArgs === null || Array.isArray(rawArgs))) {
    throw new ComputerCommandError('"args" must be an object.');
  }
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  switch (name) {
    case 'screenshot': {
      if (args.maxWidth === undefined) return { command: 'screenshot', maxWidth: COMPUTER_DEFAULT_MAX_WIDTH };
      const maxWidth = coordinate(args, 'maxWidth');
      if (!Number.isInteger(maxWidth) || maxWidth < 64 || maxWidth > 8192) throw new ComputerCommandError('"maxWidth" must be an integer between 64 and 8192.');
      return { command: 'screenshot', maxWidth };
    }
    case 'move': return { command: 'move', x: coordinate(args, 'x'), y: coordinate(args, 'y') };
    case 'click': {
      const button = args.button ?? 'left';
      if (button !== 'left' && button !== 'right' && button !== 'middle') throw new ComputerCommandError('"button" must be left, right or middle.');
      return { command: 'click', x: coordinate(args, 'x'), y: coordinate(args, 'y'), button };
    }
    case 'double_click': return { command: 'double_click', x: coordinate(args, 'x'), y: coordinate(args, 'y') };
    case 'drag':
      return { command: 'drag', fromX: coordinate(args, 'fromX'), fromY: coordinate(args, 'fromY'), toX: coordinate(args, 'toX'), toY: coordinate(args, 'toY') };
    case 'type': {
      if (typeof args.text !== 'string' || args.text.length === 0 || args.text.length > COMPUTER_MAX_TEXT) {
        throw new ComputerCommandError(`"text" must be a string of 1 to ${COMPUTER_MAX_TEXT} characters.`);
      }
      return { command: 'type', text: args.text };
    }
    case 'key': {
      if (typeof args.keys !== 'string' || args.keys.length === 0 || args.keys.length > 100) throw new ComputerCommandError('"keys" must be a short string such as "cmd+c".');
      return { command: 'key', keys: args.keys };
    }
    case 'scroll':
      return { command: 'scroll', x: coordinate(args, 'x'), y: coordinate(args, 'y'), deltaX: optionalDelta(args, 'deltaX'), deltaY: optionalDelta(args, 'deltaY') };
    case 'focus_window': {
      // An opaque id from list_windows (a window number, `pid:index`).
      if (typeof args.id !== 'string' || !/^[A-Za-z0-9:_.-]{1,64}$/.test(args.id)) throw new ComputerCommandError('"id" must be a window id returned by list_windows.');
      return { command: 'focus_window', id: args.id };
    }
    case 'a11y_tree': {
      const bounded = (name: string, fallback: number, max: number): number => {
        if (args[name] === undefined) return fallback;
        const value = args[name];
        if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max) throw new ComputerCommandError(`"${name}" must be an integer between 1 and ${max}.`);
        return value;
      };
      const out: Extract<ComputerCommand, { command: 'a11y_tree' }> = {
        command: 'a11y_tree', maxDepth: bounded('maxDepth', A11Y_DEFAULT_MAX_DEPTH, A11Y_MAX_DEPTH), maxNodes: bounded('maxNodes', A11Y_DEFAULT_MAX_NODES, A11Y_MAX_NODES),
      };
      if (args.windowId !== undefined) {
        if (typeof args.windowId !== 'string' || !/^[A-Za-z0-9:_.-]{1,64}$/.test(args.windowId)) throw new ComputerCommandError('"windowId" must be a window id returned by list_windows.');
        out.windowId = args.windowId;
      }
      if (args.query !== undefined) {
        if (typeof args.query !== 'string' || args.query.length > A11Y_MAX_QUERY) throw new ComputerCommandError(`"query" must be a string of at most ${A11Y_MAX_QUERY} characters.`);
        if (args.query.trim()) out.query = args.query;
      }
      return out;
    }
    case 'a11y_probe_app': {
      if (typeof args.windowId !== 'string' || !/^[A-Za-z0-9:_.-]{1,64}$/.test(args.windowId)) throw new ComputerCommandError('"windowId" must be a window id returned by list_windows.');
      return { command: 'a11y_probe_app', windowId: args.windowId };
    }
    case 'a11y_action': {
      if (typeof args.id !== 'string' || !parseElementId(args.id)) throw new ComputerCommandError('"id" must be an element id returned by a11y_tree.');
      if (typeof args.action !== 'string' || !(A11Y_ACTIONS as readonly string[]).includes(args.action)) throw new ComputerCommandError(`"action" must be one of ${A11Y_ACTIONS.join(', ')}.`);
      const action = args.action as A11yAction;
      if (action !== 'set_value') {
        if (args.value !== undefined) throw new ComputerCommandError('"value" is only for set_value.');
        return { command: 'a11y_action', id: args.id, action };
      }
      if (typeof args.value !== 'string' || args.value.length > A11Y_MAX_VALUE) throw new ComputerCommandError(`set_value needs a "value" string of at most ${A11Y_MAX_VALUE} characters.`);
      return { command: 'a11y_action', id: args.id, action, value: args.value };
    }
    case 'wait': {
      const ms = coordinate(args, 'ms');
      if (ms < 0 || ms > COMPUTER_MAX_WAIT_MS) throw new ComputerCommandError(`"ms" must be between 0 and ${COMPUTER_MAX_WAIT_MS}.`);
      return { command: 'wait', ms };
    }
    default: return { command: name } as ComputerCommand;
  }
}
