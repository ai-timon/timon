import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { apiError, type ApiErrorBody } from './api-error.js';

/**
 * A refusal the computer-use routes answer with. A bare string is text with no
 * code of its own (the desktop's answer) and travels as the `detail` of
 * `computer_command_failed`.
 */
export class NativeComputerError extends Error {
  readonly body: ApiErrorBody;
  constructor(cause: string | ApiErrorBody, readonly status = 400) {
    const body = typeof cause === 'string' ? apiError('computer_command_failed', cause, { detail: cause }) : cause;
    super(body.error);
    this.body = body;
  }
}

/** The body a computer route answers an unexpected failure with. */
export function computerErrorBody(error: unknown): ApiErrorBody {
  if (error instanceof NativeComputerError) return error.body;
  const message = (error as Error).message;
  return apiError('computer_command_failed', message, { detail: message });
}

export type ComputerProvider = { version: 1; origin: string; token: string; pid: number };
export type ComputerActor = 'agent' | 'human';

/** This credential is local IPC, never returned through a browser-facing API. */
export function readComputerProvider(home = TIMON_HOME): ComputerProvider | null {
  try {
    const path = join(home, 'computer-native', 'provider.json');
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 4096) return null;
    const value = JSON.parse(readFileSync(path, 'utf8')) as ComputerProvider;
    const url = new URL(value.origin);
    if (value.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
      || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || typeof value.token !== 'string' || value.token.length < 32 || value.token.length > 256
      || !Number.isInteger(value.pid) || value.pid <= 0) return null;
    return { ...value, origin: url.origin };
  } catch { return null; }
}

const MAC_PRIVACY = 'System Settings › Privacy & Security';

/**
 * What an agent should ask the user for, by reason. Text for the agent only: it names a setting
 * or a package, never a path, a window title or anything typed.
 */
const UNAVAILABLE_HINTS: Readonly<Record<string, string>> = {
  'permission-screen': `Ask the user to allow Timon under ${MAC_PRIVACY} › Screen Recording, then to restart Timon.`,
  'permission-accessibility': `Ask the user to allow Timon under ${MAC_PRIVACY} › Accessibility.`,
  'no-input-tool': 'Ask the user to install xdotool (sudo apt install xdotool, sudo dnf install xdotool or sudo pacman -S xdotool).',
  'wayland': 'Ask the user to log in to an X11 session: computer use does not work under Wayland.',
  'no-desktop': 'Ask the user to open Timon on a machine with a desktop session: the Timon desktop app must be running.',
};

const A11Y_HINT = 'Ask the user to open the Computer use setup card in this agent\'s settings: the accessibility line says what is missing '
  + '(on macOS the Accessibility grant, on Linux accessibility turned on in the desktop session).';

/** The instruction for an agent whose action was refused because the machine is not ready. */
export function computerUnavailableHint(reason: string | null): string {
  return (reason && Object.hasOwn(UNAVAILABLE_HINTS, reason) ? UNAVAILABLE_HINTS[reason] : undefined)
    ?? 'Ask the user to open the Computer use setup card in this agent\'s settings.';
}

/** The desktop answers with a code (`computer_stopped`) or with prose; both end as a coded refusal. */
function desktopRefusal(body: { error?: unknown; code?: unknown }, status: number, secrets: readonly string[]): NativeComputerError {
  const message = typeof body.error === 'string' ? body.error : undefined;
  const code = typeof body.code === 'string' ? body.code : '';
  if (code === 'computer_stopped') {
    return new NativeComputerError(apiError('computer_stopped', 'Computer use was stopped by the user. They must resume it first.'), 409);
  }
  if (code === 'computer_unavailable') {
    // The reason is the only thing read from the desktop's text: a closed list, never echoed as is.
    const reason = (message ? /unavailable: ([a-z-]+)/.exec(message)?.[1] : undefined) ?? null;
    return new NativeComputerError(apiError('computer_unavailable', `Computer use is unavailable on this machine. ${computerUnavailableHint(reason)}`), 503);
  }
  if (code === 'computer_app_not_allowed') {
    // The desktop's text names the foreground application so the agent understands what to ask for.
    const found = message ?? 'The foreground application is not in the agent\'s allowed list.';
    return new NativeComputerError(apiError('computer_app_not_allowed', `${found} Ask the user to add the application to the allowed applications in this agent's settings, or to bring an allowed one to the front.`, { detail: found }), 403);
  }
  if (code === 'computer_background_only') {
    return new NativeComputerError(apiError('computer_background_only', 'This agent works in the background: use a11y_tree and a11y_action. Screenshots, the mouse, the keyboard and focusing a window are refused, so the user keeps their screen.'), 403);
  }
  if (code === 'a11y_element_stale') {
    return new NativeComputerError(apiError('a11y_element_stale', 'That element no longer exists: the window changed. Call computer_a11y_tree again and use the new ids.'), 409);
  }
  if (code === 'a11y_action_unsupported') {
    // The desktop's text lists the actions the element does accept: the agent picks one of them.
    const found = message ?? 'That element cannot do this.';
    return new NativeComputerError(apiError('a11y_action_unsupported', found, { detail: found }), 422);
  }
  if (code === 'a11y_unavailable') {
    return new NativeComputerError(apiError('a11y_unavailable', `The accessibility tree is not available on this machine. ${A11Y_HINT} Work from screenshots meanwhile.`), 503);
  }
  if (code === 'window_not_found') {
    return new NativeComputerError(apiError('computer_window_not_found', 'That window no longer exists. Call list_windows again.'), 404);
  }
  let detail = message ?? `HTTP ${status}`;
  // What the agent typed never travels back in an error text, which ends in logs.
  for (const secret of secrets) if (secret) detail = detail.split(secret).join('[redacted]');
  return new NativeComputerError(apiError('computer_command_failed', `Computer command failed: ${detail}`, { detail }), 502);
}

/** What the desktop needs to judge an agent's command: its applications, its default mode and, when on, "All applications". */
function agentScope(options: Parameters<typeof callNativeComputer>[3]): Record<string, unknown> {
  const scope: Record<string, unknown> = { allowedApps: options?.allowedApps ?? [], mode: options?.mode ?? 'foreground' };
  if (options?.allApps === true) Object.assign(scope, { allApps: true, excludedApps: options.excludedApps ?? [] });
  return scope;
}

/**
 * Sends one command to the desktop's computer-use server. `actor` is the
 * daemon's, derived from the authentication, never the caller's.
 */
export async function callNativeComputer(
  command: string,
  args: Record<string, unknown>,
  actor: ComputerActor,
  options: {
    home?: string;
    timeoutMs?: number;
    allowedApps?: readonly { app: string; mode: 'foreground' | 'background' }[];
    mode?: 'foreground' | 'background';
    /** Every application but `excludedApps`, the unlisted ones in `mode`. Sent only when on: a desktop that predates it then reads the list alone. */
    allApps?: boolean;
    excludedApps?: readonly string[];
  } = {},
): Promise<unknown> {
  const provider = readComputerProvider(options.home);
  if (!provider) throw new NativeComputerError(apiError('computer_unavailable', 'Computer use is unavailable: the Timon desktop app must be running on the host machine. Ask the user to open it.'), 503);
  const typed = typeof args.text === 'string' ? [args.text] : [];
  let response: Response;
  try {
    response = await fetch(`${provider.origin}/command`, {
      method: 'POST', headers: { authorization: `Bearer ${provider.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ command, args, actor, ...(actor === 'agent' ? agentScope(options) : {}) }), signal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
      redirect: 'error',
    });
  } catch {
    throw new NativeComputerError(apiError('computer_unavailable', 'Computer use is unavailable: the Timon desktop app must be running on the host machine. Ask the user to reopen it.'), 503);
  }
  let body: { ok?: unknown; result?: unknown; error?: unknown; code?: unknown };
  try { body = await response.json() as typeof body; } catch { body = {}; }
  if (!response.ok || body.ok === false) throw desktopRefusal(body, response.status, typed);
  return body.result;
}
