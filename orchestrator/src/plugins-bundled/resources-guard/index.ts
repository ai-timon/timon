/**
 * Module `resources-guard` — confining missions to their own systemd scope
 * and load monitoring.
 *
 * Tier `std`, requires `systemd`. No routes: the module is pure boot.
 *
 * Order is load-bearing: sweeping surviving scopes must precede sweeping
 * zombie missions (done by `boot.ts` after the audit), which is exactly
 * what marks their missions as dead. Without this we'd leave orphaned CLIs
 * writing into the void. This is guaranteed here by construction: `apply()`
 * runs during tree composition, the sweep after.
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import {
  setMissionNoticeSink,
  setResourceAlertSink,
  startResourceGuard,
  stopMissionScopes,
} from '../../resources.js';
import { notifyMissionResourceKill } from '../../agent.js';
import { createNotification } from '../../notifications.js';
import { onDaemonShutdown } from '../../daemon-shutdown.js';

export const manifest: ModuleManifest = {
  name: '@timon/resources-guard',
  tier: 'std',
  requires: ['systemd'],
  inject: ['db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  try {
    stopMissionScopes();
  } catch (err) {
    console.warn('[resources] boot-time scope sweep failed:', (err as Error).message);
  }
  // Resource alerts go through the notification center (hence Web Push): a
  // silent OOM is a task failing with no readable reason.
  setResourceAlertSink(({ title, body, urgent, message }) => {
    createNotification({ type: 'alert', urgent, title, body, message });
  });
  // The agent must learn WHY its process died, or it reruns it identically.
  setMissionNoticeSink((missionPrefix, text) => {
    void notifyMissionResourceKill(missionPrefix, text);
  });
  ctx.effect(() => startResourceGuard());

  // Clean shutdown: the scopes are no longer in the service's cgroup,
  // systemd won't take them down. A `systemctl stop` without this leaves
  // agents running with no orchestrator to read them. A step of the daemon's
  // common stop (`daemon-shutdown.ts`), which runs it before releasing the
  // modules and exits whether this module is there or not.
  ctx.effect(() => onDaemonShutdown(() => {
    try { stopMissionScopes(); } catch { /* best-effort, the stop goes on */ }
  }));
}
