/**
 * `stop`, `start` or `restart` of the installed service, launched locally by
 * Electron ("Quit and stop the background service", the launch that follows
 * it, and the update that finds the previous version's daemon still running).
 * No HTTP endpoint exposes this operation. Like the other desktop runners it
 * loads neither the database nor the onboarding (`packaged-upgrade-runner.test.ts`).
 */
import { loadConfig } from '../config/load.js';
import { cooperativeStopOf, withCooperativeStop } from './cooperative-stop.js';
import { daemonOrigin } from './diagnostic-report.js';
import { createGenericHost } from './generic.js';
import { endMissionsOfStoppedDaemon } from './mission-processes.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { restartService, startService, stopService, type ServiceResult } from './service-install.js';
import { actOnOwnService } from './service-ownership.js';

const GESTURES = { stop: stopService, start: startService, restart: restartService } as const;

const action = process.argv[2];
if (action !== 'stop' && action !== 'start' && action !== 'restart') {
  console.error('usage: desktop-service-runner.js stop|start|restart');
  process.exitCode = 64;
} else {
  const cfg = loadConfig(undefined, { readonly: true });
  const host = createGenericHost(cfg);
  const opts = serviceOptsFromEnvironment(cfg, () => host);
  // Windows has no stop signal to send: the daemon is asked first, then the
  // gesture's kills end what did not leave (`cooperative-stop.ts`).
  const ask = cooperativeStopOf(daemonOrigin(cfg), opts.timonHome);
  const result = await actOnOwnService(opts, async (o): Promise<ServiceResult> => (
    action === 'start' ? GESTURES.start(o) : withCooperativeStop(o, GESTURES[action], ask)));
  if (result.ok && action === 'stop') {
    const ended = await endMissionsOfStoppedDaemon(opts.timonHome, host);
    if (ended) result.lines.push(ended);
  }
  if (!result.ok) {
    console.error(result.reason ?? result.lines.join('\n') ?? `service ${action} failed`);
    process.exitCode = 1;
  } else {
    console.log(result.lines.join('\n'));
  }
}
