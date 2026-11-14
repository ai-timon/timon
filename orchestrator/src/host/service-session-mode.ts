/**
 * Does the background service keep running once the user logs out?
 *
 * - `session`: only while a session of the user is open. Linux: no lingering,
 *   so systemd stops the user manager, and the daemon with it, at logout.
 *   macOS: the LaunchAgent, which lives in the login session. Windows: a task
 *   started at logon with the user's interactive token, which Windows ends
 *   with the session.
 * - `always`: also with no session open (routines, night tasks, webhooks).
 *   Linux: `loginctl enable-linger`. macOS: the LaunchDaemon. Windows: the
 *   task started at boot under an S4U logon.
 *
 * The choice is the user's, asked by the onboarding and changed in Settings ›
 * System. It lives in a file under `run/`, like the claude token marker: the
 * supervisor code runs in the CLI and in the desktop's runners, which never
 * open the database (I7 of the packaging audit). No file means nobody chose:
 * an install made before the choice existed. Its supervisor is left as it was
 * rather than changed behind the user's back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const SERVICE_SESSION_MODES = ['session', 'always'] as const;
export type ServiceSessionMode = typeof SERVICE_SESSION_MODES[number];

export function isServiceSessionMode(value: unknown): value is ServiceSessionMode {
  return typeof value === 'string' && (SERVICE_SESSION_MODES as readonly string[]).includes(value);
}

export function serviceSessionModePath(timonHome: string): string {
  return join(timonHome, 'run', 'service-session-mode');
}

/** The recorded choice, `null` when none was ever made (or the file is unreadable). */
export function readServiceSessionMode(timonHome: string): ServiceSessionMode | null {
  const file = serviceSessionModePath(timonHome);
  if (!existsSync(file)) return null;
  try {
    const value = readFileSync(file, 'utf8').trim();
    return isServiceSessionMode(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeServiceSessionMode(timonHome: string, mode: ServiceSessionMode): void {
  const file = serviceSessionModePath(timonHome);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${mode}\n`, 'utf8');
}

/** Where the choice changes what the supervisor does. */
export function sessionModeSupported(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin' || platform === 'win32';
}
