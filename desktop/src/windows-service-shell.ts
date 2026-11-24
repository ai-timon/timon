/**
 * `Timon.exe --timon-service <home>\run\timon-service.json`: what the
 * Windows logon task runs since revision 6 of the task (`windowsTaskAction`,
 * orchestrator `host/service-install.ts`).
 *
 * The task runs in the user's session there. A console program — the Node
 * the package ships, `cmd.exe` — would open a console window on their desktop,
 * and closing it would kill Timon; the hidden PowerShell that avoided it is
 * what Avast and AVG quarantined the task for. `Timon.exe` is a GUI program:
 * started by the task, it opens nothing, and it starts the launcher script
 * with no console either (`windowsHide`). It then waits for the launcher, so
 * the task still runs exactly as long as its daemon and `IgnoreNew` keeps
 * acting as the supervisor.
 *
 * Nothing else of the application runs here: no window, no tray, no
 * single-instance lock (the user's own Timon must still open), no desktop log
 * and no daemon of its own. Its Chromium profile is a folder of its own, never
 * the application's.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { withRuntimeEnv } from './daemon-runtime.js';

/** Copy of `WINDOWS_SERVICE_FLAG` (orchestrator `host/service-install.ts`), held by `packaging.test.ts`. */
export const WINDOWS_SERVICE_FLAG = '--timon-service';

/** The configuration named after the flag, `null` when this is no service launch. */
export function serviceShellConfig(argv: readonly string[]): string | null {
  const at = argv.indexOf(WINDOWS_SERVICE_FLAG);
  if (at < 0) return null;
  const file = argv[at + 1];
  return file && !file.startsWith('--') ? file : null;
}

/** What the shell starts: the launcher script of the installation, on the Node the configuration names. */
export function launcherCommand(configFile: string, text: string): { command: string; args: string[]; cwd: string } {
  const raw: unknown = JSON.parse(text);
  const config = raw as { node?: unknown; cwd?: unknown };
  if (typeof config.node !== 'string' || !config.node || typeof config.cwd !== 'string' || !config.cwd) {
    throw new Error(`${configFile} names no Node or no installation: run \`timon service install\``);
  }
  return {
    command: config.node,
    args: [join(config.cwd, 'dist', 'host', 'windows-service-launcher.js'), configFile],
    cwd: config.cwd,
  };
}

/** The log the launcher writes (`<home>\tmp\daemon.log`): where the shell says why it could not start it. */
export function shellLog(configFile: string): string {
  return join(dirname(dirname(configFile)), 'tmp', 'daemon.log');
}

export type ServiceShellApp = {
  setPath: (name: 'userData', path: string) => void;
  getPath: (name: 'temp') => string;
  disableHardwareAcceleration: () => void;
  whenReady: () => Promise<unknown>;
  exit: (code: number) => void;
};

/** Holds the launcher until it exits, then exits with its code. */
export async function runWindowsServiceShell(app: ServiceShellApp, argv: readonly string[]): Promise<void> {
  const configFile = serviceShellConfig(argv);
  const say = (text: string) => {
    if (!configFile) return;
    try {
      mkdirSync(dirname(shellLog(configFile)), { recursive: true });
      appendFileSync(shellLog(configFile), `[timon-service] ${new Date().toISOString()} ${text}\n`);
    } catch { /* nowhere left to say it */ }
  };
  // Before ready, as Electron requires: nothing of this process draws.
  app.disableHardwareAcceleration();
  app.setPath('userData', join(app.getPath('temp'), 'timon-service-shell'));
  await app.whenReady();
  if (!configFile) { app.exit(1); return; }
  let launch: ReturnType<typeof launcherCommand>;
  try {
    launch = launcherCommand(configFile, readFileSync(configFile, 'utf8'));
  } catch (error) {
    say(`the service shell cannot start: ${(error as Error).message}`);
    app.exit(1);
    return;
  }
  // The Node the package ships ignores the flag and would pass it on to every child.
  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: withRuntimeEnv(process.env, { execPath: launch.command, env: {} }),
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => {
    say(`the service shell could not start the launcher: ${error.message}`);
    app.exit(1);
  });
  child.once('exit', (code) => app.exit(code ?? 1));
}
