/**
 * Who may open a web terminal.
 *
 * A web terminal is a shell as the daemon's Unix user: whoever holds it holds
 * the machine. Three locks, all required:
 *  — a person: a browser session (`kind: 'session'`) or a paired device
 *    relaying one (`kind: 'device'`). Never the daemon-token nor a mission
 *    api-token: agents already have their own tools, and a token that leaked
 *    must not turn into an interactive shell;
 *  — the `terminal:open` permission (superadmin carries it implicitly);
 *  — the `TIMON_TERMINAL_WEB_ENABLED` setting.
 * The first-run hole of `rejectIfDenied` (no account yet → open API) does
 * NOT apply here: no identity, no shell.
 */
import { dbApi, type UserRow } from '../../db.js';
import { settingBool } from '../../settings.js';
import { isPersonAuth, type RequestAuth } from '../../users/identity.js';
import { userAllows } from '../../users/permissions.js';
import { apiError, type ApiErrorBody } from '../../api-error.js';
export { isSameOriginUpgrade, upgradeAuth } from '../../users/upgrade-auth.js';

export const TERMINAL_PERMISSION = 'terminal:open';

export type TerminalDenial = 'unauthorized' | 'session_required' | 'forbidden' | 'disabled';

export function terminalWebEnabled(): boolean {
  return settingBool('TIMON_TERMINAL_WEB_ENABLED');
}

/** The decision for an already-resolved request identity. */
export function decideAccess(auth: RequestAuth | undefined): { user: UserRow } | { denied: TerminalDenial } {
  if (!auth) return { denied: 'unauthorized' };
  if (!isPersonAuth(auth) || !auth.user) return { denied: 'session_required' };
  if (!userAllows(auth.user, dbApi.listPermissionsForUser(auth.user.id), TERMINAL_PERMISSION)) {
    return { denied: 'forbidden' };
  }
  if (!terminalWebEnabled()) return { denied: 'disabled' };
  return { user: auth.user };
}

export function denialStatus(denied: TerminalDenial): number {
  return denied === 'unauthorized' ? 401 : 403;
}

/** The body of a refusal: a 401 stays bare, the proxy sends the browser to sign in. */
export function denialBody(denied: TerminalDenial): ApiErrorBody | { error: 'unauthorized' } {
  switch (denied) {
    case 'unauthorized': return { error: 'unauthorized' };
    case 'session_required': return apiError('terminal_session_required', 'the terminal opens from a signed-in browser');
    case 'forbidden': return apiError('terminal_forbidden', 'this account may not open a terminal');
    default: return apiError('terminal_disabled', 'the web terminal is turned off');
  }
}
