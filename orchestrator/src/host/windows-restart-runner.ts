/** Launched locally by Electron; no HTTP endpoint exposes this operation. */
import { loadConfig } from '../config/load.js';
import { cooperativeStopOf, withCooperativeStop } from './cooperative-stop.js';
import { daemonOrigin } from './diagnostic-report.js';
import { createGenericHost } from './generic.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { restartWindowsService } from './service-install.js';
import { actOnOwnService } from './service-ownership.js';

const cfg = loadConfig(undefined, { readonly: true });
const host = createGenericHost(cfg);
const opts = serviceOptsFromEnvironment(cfg, () => host);
// The daemon is asked to stop first; the restart's kills are the fallback (`cooperative-stop.ts`).
const ask = cooperativeStopOf(daemonOrigin(cfg), opts.timonHome);
const result = await actOnOwnService(opts, (o) => withCooperativeStop(o, restartWindowsService, ask));
if (!result.ok) {
  console.error(result.reason ?? 'service restart failed');
  process.exitCode = 1;
} else {
  console.log(result.lines.join('\n'));
}
