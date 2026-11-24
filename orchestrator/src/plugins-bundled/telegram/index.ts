/**
 * Module `telegram` — the two inbound-channel workers, launched as child
 * processes of the daemon rather than by Docker.
 *
 * These are exactly the two Compose services `telegram-poll` and
 * `reply-worker`: the first long-polls the Telegram API and pushes each
 * message to the app's `/api/channels/<name>/inbound`, the second processes
 * the durable inbox, polls finished mission turns and retries replies to the
 * originating channel.
 *
 * **Name mismatch to know about**: the Compose service is called
 * `reply-worker` but runs `app/src/workers/mission-watcher.ts`. No
 * `reply-worker.ts` exists on disk. So we launch `mission-watcher.ts` (the
 * real file, the one Compose already refers to) and rename nothing: the
 * rename isn't part of this step.
 *
 * **Disabled by default** (plan §4.3.2). The workers currently run in
 * Compose; two Telegram pollers on the same bot would steal each other's
 * updates (the API only delivers each update once). An explicit gesture is
 * therefore required: `"@timon/telegram": { "enabled": true }` in
 * `timon.config.json`, after stopping the corresponding Compose services.
 */
import { existsSync, readdirSync } from 'node:fs';
import type { Context } from '@deepseek-ai/cordis';
import type { Host } from '../../host/index.js';
import type { ModuleManifest } from '../../kernel/registry.js';
import type { TimonConfig } from '../../config/schema.js';
import { config } from '../../config/load.js';
import { CHANNELS_DIR, TIMON_HOME } from '../../paths.js';
import { superviseChild, MAX_RESTARTS, RESTART_WINDOW_MS } from '../../kernel/child-supervisor.js';
// The app is in the same place for everyone (`<installDir>/../app`) and its
// entry points launch the same way: reused rather than duplicated.
import { appDirOf, appEntryArgs, appEntryRunnable, nodeRuntime, type NodeRuntime } from '../web-app/index.js';
import { daemonMessage } from '../../daemon-message.js';

export const manifest: ModuleManifest = {
  name: '@timon/telegram',
  tier: 'opt',
  inject: ['host'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** The two workers, in Compose order. */
export const WORKERS = ['telegram-poll', 'mission-watcher'] as const;
export type Worker = (typeof WORKERS)[number];

/**
 * Is the module running? Read from `config.modules["@timon/telegram"]`, NOT from
 * `apply`'s second argument: `toLoaderEntries` only attaches a module's
 * config when it carries options, so `"@timon/telegram": true` would arrive here
 * as an empty object and we'd read the opposite of the intent.
 *
 * Anything that isn't an explicit `true` counts as "disabled" — including
 * `"auto"`, the default for a module absent from the table.
 */
export function isEnabled(cfg: TimonConfig): boolean {
  const setting = cfg.modules[manifest.name];
  if (setting === true) return true;
  if (typeof setting === 'object' && setting !== null) return setting.enabled === true;
  return false;
}

/** A configured channel is a `.json` in `~/.timon/channels/`. With none,
 *  both workers would run idle. */
export function hasChannels(dir = CHANNELS_DIR): boolean {
  if (!existsSync(dir)) return false;
  return readdirSync(dir).some((f) => f.endsWith('.json'));
}

/**
 * A worker's environment.
 *
 * `{ ...process.env, … }` rather than a minimal object like `web-app`: Node
 * REPLACES the child's environment when `env` is passed, and these workers
 * need `PATH`, `HOME` and above all the bot tokens, which live in variables
 * named by the channel config (`bot_token_env`) — they can't be enumerated
 * from here.
 *
 * The URLs, meanwhile, can't be copied from Compose: `app:3100` and
 * `host.docker.internal:3000` only exist inside the Docker network. On the
 * host, it's the loopback.
 */
export function envOf(cfg: TimonConfig, worker: Worker): NodeJS.ProcessEnv {
  return {
    ...process.env,
    NODE_ENV: 'production',
    TIMON_HOME,
    ...(worker === 'telegram-poll'
      ? { APP_URL: `http://127.0.0.1:${cfg.app.listen.port}` }
      : { ORCHESTRATOR_URL: `http://127.0.0.1:${cfg.daemon.listen.port}` }),
  };
}

/**
 * Launches both workers and keeps them alive. Returns the stop function.
 *
 * Same Node as the app server: a packaged daemon hands its own Electron
 * binary (`ELECTRON_RUN_AS_NODE`), because a tester's machine often has no
 * `node` on its PATH — the workers never started there.
 */
export function superviseWorkers(host: Host, cfg: TimonConfig, appDir: string, node: NodeRuntime = nodeRuntime(cfg)): () => void {
  const stops = WORKERS.map((worker) => {
    console.log(`[telegram] worker ${worker} served by the daemon (cwd ${appDir})`);
    return superviseChild(host, {
      label: `telegram/${worker}`,
      command: node.command,
      args: appEntryArgs(appDir, worker),
      spawn: { cwd: appDir, env: { ...envOf(cfg, worker), ...node.env }, stdio: 'inherit' },
      alert: {
        title: `The Telegram worker ${worker} stopped starting`,
        body: (why) => `${MAX_RESTARTS} restarts without staying up ${RESTART_WINDOW_MS / 1000}s (${why}). Telegram messages are no longer picked up; check the bot tokens (\`~/.timon/secrets.env\`) and the daemon logs.`,
        message: (why) => daemonMessage('telegram_worker_stopped', { worker, restarts: MAX_RESTARTS, seconds: RESTART_WINDOW_MS / 1000, why }),
      },
    });
  });
  return () => { for (const stop of stops) stop(); };
}

export function apply(ctx: Context): void {
  const cfg = config();
  if (!isEnabled(cfg)) {
    console.log('[telegram] disabled (default) — workers remain served by docker compose --profile docker');
    return;
  }
  if (!hasChannels()) {
    // No throw: an unconfigured channel is a normal state, not a failure.
    console.log(`[telegram] no channel configured in ${CHANNELS_DIR} — nothing to launch`);
    return;
  }

  const appDir = appDirOf(cfg);
  const missing = WORKERS.find((worker) => !appEntryRunnable(appDir, worker));
  if (missing) {
    console.error(`[telegram] app dependencies missing: cd app && npm install (expected: ${appEntryArgs(appDir, missing)[0]})`);
    return;
  }

  ctx.effect(() => superviseWorkers(ctx.host, cfg, appDir));
}
