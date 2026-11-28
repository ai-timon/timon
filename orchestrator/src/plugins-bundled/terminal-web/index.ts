/**
 * Module `terminal-web` — a real terminal emulator in the UI (desktop, web,
 * phone PWA), backed by a pseudo-terminal on the host. Tier `opt`, no host
 * capability required: unlike `terminal-native`, it needs no graphical
 * session, so it works on a headless server reached from a phone.
 *
 * Access rules: `access.ts`. Sessions survive their clients
 * (`terminal-host/sessions.ts`) and, through the terminal host, a daemon
 * restart (`hosted.ts`).
 */
import { homedir } from 'node:os';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import { daemonShutdownState } from '../../daemon-shutdown.js';
import { timonVersion } from '../../data-version.js';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import { TIMON_HOME } from '../../paths.js';
import { settingInt } from '../../settings.js';
import { hostFiles, type HostFiles } from '../../terminal-host/protocol.js';
import { nodePtySpawner } from '../../terminal-host/pty.js';
import { TerminalSessions } from '../../terminal-host/sessions.js';
import { interruptStaleRuns } from './command-requests.js';
import { HostedSessions } from './hosted.js';
import { createUpgradeHandler, registerRoutes } from './routes.js';
import { localStore, type SessionStore } from './store.js';

export const manifest: ModuleManifest = {
  name: '@timon/terminal-web',
  tier: 'opt',
  inject: ['http', 'db', 'host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** The host entry of this build: `.js` once compiled, `.ts` under tsx. */
export function hostEntry(): string {
  const ext = extname(fileURLToPath(import.meta.url));
  return fileURLToPath(new URL(`../../terminal-host/main${ext}`, import.meta.url));
}

/**
 * The host runs on the daemon's own runtime — never a `node` from PATH, whose
 * ABI may not match node-pty's binary. Its environment is the daemon's minus
 * every `TIMON_*` key (the daemon token among them), plus the home it serves.
 */
export function hostEnv(source: NodeJS.ProcessEnv = process.env, electron: string | undefined = process.versions.electron): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && !key.startsWith('TIMON_')) env[key] = value;
  }
  env.TIMON_HOME = TIMON_HOME;
  if (electron) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

async function launchHost(host: Host, files: HostFiles): Promise<{ via: string }> {
  const entry = hostEntry();
  const started = await host.spawnDetached!({
    name: 'timon-terminal-host',
    cmd: process.execPath,
    // Under tsx (development) the loader flags come along; a build has none to pass.
    args: [...(entry.endsWith('.ts') ? process.execArgv : []), entry],
    env: hostEnv(),
    cwd: homedir(),
    logFile: files.log,
  });
  console.log(`[terminal-web] terminal host started (${started.via}, pid ${started.pid ?? 'unknown'})`);
  return { via: started.via };
}

export function apply(ctx: Context): void {
  const idleMs = (): number => Math.max(1, settingInt('TIMON_TERMINAL_WEB_IDLE_MIN')) * 60_000;
  const local = (): TerminalSessions => new TerminalSessions({ spawn: nodePtySpawner, idleMs });
  const host = ctx.host as Host;
  let sessions: SessionStore;
  if (host.spawnDetached) {
    const files = hostFiles(TIMON_HOME);
    const hosted = new HostedSessions({
      endpoint: files.endpoint,
      tokenFile: files.token,
      build: timonVersion(),
      idleMs,
      local,
      launch: () => launchHost(host, files),
    });
    // Shells a previous daemon left in the host come back with it.
    void hosted.reconnect().then((found) => { if (found) console.log('[terminal-web] reconnected to the running terminal host'); });
    sessions = hosted;
  } else {
    sessions = localStore(local());
  }
  // An allowed command a previous daemon was running never recorded its end.
  try {
    const n = interruptStaleRuns();
    if (n > 0) console.log(`[terminal-web] ${n} allowed command run(s) interrupted by the last stop were marked as such`);
  } catch (err) { console.warn(`[terminal-web] could not close interrupted runs: ${(err as Error).message}`); }
  registerRoutes(ctx.http.router(), sessions);
  const upgrade = createUpgradeHandler(sessions);
  ctx.http.upgrade(upgrade);
  ctx.effect(() => () => {
    upgrade.close();
    void releaseSessions(sessions);
  });
}

/**
 * What the module leaves behind when its fiber goes. A daemon stop disposes
 * the whole module tree too (`daemon-shutdown.ts`), and the terminal host
 * exists so that its shells outlive the daemon: then the store only lets go,
 * and the next daemon reconnects. Anything else (the module disabled, the
 * plugin removed) kills every shell, which nobody could reach any more.
 */
export function releaseSessions(sessions: SessionStore, daemonStopping: () => boolean = () => daemonShutdownState() === 'already-stopping'): Promise<void> {
  if (daemonStopping()) {
    sessions.disconnect();
    return Promise.resolve();
  }
  return sessions.dispose();
}
