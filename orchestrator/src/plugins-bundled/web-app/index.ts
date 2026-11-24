/**
 * Module `web-app` — the Next.js app (UI, inbound channels, `/api/ui` proxy)
 * launched as a child process of the daemon, without Docker.
 *
 * Tier `std`, no host capability required: it's plain Node, exactly the
 * same `src/server.ts` that the `timon-app` container runs today.
 *
 * **`config.app.enabled` defaults to `false`** — a deliberate deviation from
 * plan §4.3.1, which pictured it as `true`. On the maintainer's machine, the app runs
 * in Compose and the orchestrator in systemd: a `true` default would spawn
 * a second Next on :3100 on the next daemon restart, with no human gesture
 * having asked for it. The project's rule is "absent config file = current
 * behavior"; the switch (stop the `app` compose service, set
 * `app.enabled: true`, rebuild app, restart daemon) is documented in
 * `docs/REBUILD.md` and remains a gesture for the user.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import type { TimonConfig } from '../../config/schema.js';
import { config } from '../../config/load.js';
import { TIMON_HOME } from '../../paths.js';
import { settingBool } from '../../settings.js';
import { superviseChild } from '../../kernel/child-supervisor.js';
import { APP_PID_FILE as PID_FILE, APP_BUILD_MARKER, appDirOf as resolveAppDir, appIsBuilt } from './control.js';
import { ensureDaemonToken } from '../http/auth.js';
import { nodeRuntime } from '../../host/node-runtime.js';
// A constant, not a service: `inject` is a HARD dependency in Cordis 4,
// and the app must know this URL even when the module carrying it is
// disabled — the compose container publishes exactly the same endpoint.
import { composeStackAvailable, resolveTts } from '../tts/index.js';
import { daemonMessage } from '../../daemon-message.js';

export const manifest: ModuleManifest = {
  name: '@timon/web-app',
  tier: 'std',
  inject: ['host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

// `appDirOf` moved to `control.ts` (step 3.7): the CLI needs it without
// loading Cordis or the database. Re-exported here, where `telegram` fetches it.
export { appDirOf, APP_PID_FILE } from './control.js';
export { nodeRuntime, type NodeRuntime } from '../../host/node-runtime.js';

/** The app's `tsx`, as the JavaScript file itself — it is passed as an
 *  ARGUMENT to `node`, so it must be something Node can parse.
 *
 *  `node_modules/.bin/tsx` is not: on Unix it is a shebang script, and on
 *  Windows npm writes a POSIX `sh` script there (next to `tsx.cmd` and
 *  `tsx.ps1`, which are shells of their own). Handing either to `node` ends
 *  on `SyntaxError: missing ) after argument list` — the app never came up
 *  in a Windows package and the window stayed black (observed 12/09/2026).
 *  `dist/cli.mjs` is exactly what that bin entry points to, on every OS. */
export function tsxOf(appDir: string): string {
  return join(appDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
}

/** The app's hand-written entry points: the HTTP server and the two channel
 *  workers. Mirrored by `ENTRIES` in `app/scripts/build-server.mjs`. */
export const APP_ENTRIES = {
  server: { source: 'src/server.ts', compiled: 'server.cjs' },
  'telegram-poll': { source: join('src', 'workers', 'telegram-poll.ts'), compiled: join('workers', 'telegram-poll.cjs') },
  'mission-watcher': { source: join('src', 'workers', 'mission-watcher.ts'), compiled: join('workers', 'mission-watcher.cjs') },
} as const;
export type AppEntry = keyof typeof APP_ENTRIES;

/**
 * The arguments that start an app entry point under `node`.
 *
 * A checkout has the TypeScript sources and runs them through `tsx`, as it
 * always has. A desktop package ships no sources: it runs the JavaScript
 * `npm run build` compiled to `.next/timon/*.cjs` (`app/scripts/build-server.mjs`).
 *
 * Still through `tsx` when it is there, which the package carries on purpose.
 * Electron 33's Node (20.18) cannot `require()` an ES module, and jsdom
 * (behind isomorphic-dompurify) does: `tsx`'s hooks transpile it on the fly.
 * `--experimental-require-module` is no substitute, it overflows the stack on
 * jsdom's module graph in that Node.
 */
export function appEntryArgs(appDir: string, entry: AppEntry): string[] {
  const { source, compiled } = APP_ENTRIES[entry];
  const tsx = tsxOf(appDir);
  const built = join(appDir, '.next', 'timon', compiled);
  if (existsSync(join(appDir, source)) || !existsSync(built)) return [tsx, source];
  return existsSync(tsx) ? [tsx, built] : [built];
}

/** Can `appEntryArgs` start anything at all? The compiled file or `tsx`. */
export function appEntryRunnable(appDir: string, entry: AppEntry): boolean {
  const args = appEntryArgs(appDir, entry);
  return existsSync(args[0]!);
}

export function envOf(cfg: TimonConfig, ttsUrl: string | null = null): Record<string, string> {
  return {
    NODE_ENV: 'production',
    PORT: String(cfg.app.listen.port),
    HOSTNAME_BIND: cfg.app.listen.host,
    ORCHESTRATOR_URL: `http://127.0.0.1:${cfg.daemon.listen.port}`,
    TIMON_HOME,
    // The app's compiled default for the voice is
    // `http://tts:5000`, a Docker network name. `null` = no voice
    // available, in which case we set NO key rather than a dead URL.
    ...(ttsUrl ? { TTS_URL: ttsUrl } : {}),
    // Server-side Next callers that are not the browser proxy (channels,
    // remote API, workers) may send this as Bearer. The `/api/ui` proxy
    // itself never does — a browser is identified by its session cookie.
    TIMON_DAEMON_TOKEN: ensureDaemonToken(),
    // Read by the app's remote API (`requireHttps`), which only sees its own
    // `process.env`: the registry value set from Settings must be copied in,
    // and a value off in the registry must not be left on by the inheritance.
    TIMON_ALLOW_HTTP: settingBool('TIMON_ALLOW_HTTP') ? '1' : '0',
  };
}

/**
 * Launches the app and keeps it alive. Rendered separately from `apply` to
 * be testable with a fake host, without a Cordis tree or an open port.
 *
 * The restart mechanics (backoff, ceiling, alert, `kill` on a defined pid)
 * live in `kernel/child-supervisor.ts` since step 3.2: `telegram` needs the
 * exact same thing.
 */
export function superviseApp(host: Host, cfg: TimonConfig, appDir: string): () => void {
  console.log(`[web-app] Supervising Next app on ${cfg.app.listen.host}:${cfg.app.listen.port} (cwd ${appDir})`);
  const node = nodeRuntime(cfg);
  // The port may stay held for hours (an orphaned Next): the check runs every
  // 30 s meanwhile, and only a change of state deserves a log line.
  let lastPortDetail: string | undefined;
  return superviseChild(host, {
    label: 'web-app',
    cleanExit: 'stop',
    cleanExitRetries: 2,
    beforeStart: host.inspectPort ? () => {
      const describe = (state: { available: boolean; detail: string }): string | undefined => {
        const detail = `${cfg.app.listen.host}:${cfg.app.listen.port}: ${state.detail}`;
        if (detail !== lastPortDetail) console.log(`[web-app] startup: ${detail}`);
        lastPortDetail = detail;
        return state.available ? undefined : `${detail}; waiting for the port to be released`;
      };
      const state = host.inspectPort!(cfg.app.listen.host, cfg.app.listen.port);
      return state instanceof Promise ? state.then(describe) : describe(state);
    } : undefined,
    command: node.command,
    args: appEntryArgs(appDir, 'server'),
    // This service deliberately inherits the daemon environment; envOf overrides
    // its listener and authentication settings before launching Next.
    spawn: {
      cwd: appDir,
      env: { ...process.env, ...envOf(cfg, resolveTts(Boolean(host.containers), composeStackAvailable(cfg)).url), ...node.env },
      stdio: 'inherit',
    },
    // Publishes the pid: this is how `timon app restart|status` reaches the
    // child, never going through systemd (see `control.ts`).
    pidFile: PID_FILE,
    outputTail: 20,
    alert: {
      title: 'The web app stopped starting',
      body: (why) => {
        const advice = why.includes('port occupied')
          ? 'Another listener is using the web app port. Timon keeps checking and starts the web app as soon as the port is free; '
            + 'close the previous Timon instance or change app.listen.port. No process was killed.'
          : why.includes('clean exit')
            ? 'The web app exited successfully but is no longer supervised. Check the daemon logs.'
            : 'The web app could not stay running. Check the daemon logs for the startup error, exit code and signal.';
        // Rearming goes through the daemon token (TODO #485): no daemon restart, missions keep running.
        const rearm = why.includes('port occupied') ? '' : ' Once fixed, `timon app restart` or reopening the desktop app starts it again.';
        return `${why}. ${advice}${rearm}`;
      },
      message: (why) => why.includes('port occupied') ? daemonMessage('web_app_port_occupied', { why })
        : why.includes('clean exit') ? daemonMessage('web_app_clean_exit', { why })
          : daemonMessage('web_app_stopped', { why }),
    },
  });
}

export function apply(ctx: Context): void {
  const cfg = config();
  if (!cfg.app.enabled) {
    console.log('[web-app] disabled (app.enabled = false) — the app remains served by docker compose --profile docker');
    return;
  }

  const appDir = resolveAppDir(cfg);
  const built = join(appDir, '.next', APP_BUILD_MARKER);
  if (!appIsBuilt(appDir)) {
    // No throw: a missing UI shouldn't take the daemon down, which still
    // serves the CLI, the agents and the API. `.next/` without the
    // prerender manifest is an incomplete build — Next in production
    // crash-loops on it, so we must not supervise.
    console.error(`[web-app] app not built: cd app && npm run build (expected: ${built})`);
    return;
  }

  ctx.effect(() => superviseApp(ctx.host, cfg, appDir));
}
