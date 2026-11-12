/** Service options without onboarding or database imports. */
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { TIMON_HOME } from '../paths.js';
import { packagedRuntime } from './bundled-node.js';
import { packagedServiceOptions } from './packaged-service.js';
import type { ServiceOpts } from './service-install.js';
import type { ExecResult, Host } from './types.js';

/** Synchronous variant, for `service-install` only: writing a unit and calling
 *  `systemctl` takes milliseconds, and `ServiceOpts.exec` is synchronous by
 *  design (the CLI calls the same code with no event loop to protect). */
function safeExecSync(command: string, args: string[], host: () => Pick<Host, 'exec'>, timeout = 30_000): ExecResult {
  try {
    return host().exec(command, args, { timeout });
  } catch (e) {
    return { code: 127, stdout: '', stderr: (e as Error).message };
  }
}

/**
 * The same options `timon service install` builds (`bin/timon`, `cmdService`).
 * Written once here so the button and the command cannot drift apart.
 * `host` has no default: `./index.js` reaches `db.ts`, whose load refuses an
 * unapproved update — exactly what the packaged upgrade runner runs before.
 */
export function serviceOptsFromEnvironment(
  cfg: TimonConfig,
  host: () => Pick<Host, 'exec'>,
): ServiceOpts {
  const base: ServiceOpts = {
    platform: process.platform,
    homeDir: homedir(),
    timonHome: TIMON_HOME,
    installDir: cfg.daemon.installDir,
    userName: userInfo().username,
    ...(process.platform === 'win32' && process.env.USERDOMAIN ? { userDomain: process.env.USERDOMAIN } : {}),
    uid: process.getuid ? process.getuid() : 0,
    heapMb: cfg.daemon.heapMb,
    port: cfg.daemon.listen.port,
    nodePath: process.execPath,
    exec: (command, args, options) => safeExecSync(command, args, host, options?.timeout),
  };
  return serviceOptsForPlatform(base, process.env, process.execPath, cfg.app.listen.port);
}

/** `PACKAGED_DEFAULTS` of `desktop/src/config.ts`: the ports shipped to testers. */
export const PACKAGED_PORTS = { daemon: 3010, app: 3110 };

/**
 * Before `timon.config.json` exists, the desktop hands its daemon the ports of
 * a first launch through the environment (`daemonEnvOverrides`): its packaged
 * defaults, or those it recorded in `desktop-bootstrap.json`. A terminal gets
 * neither, and the service would listen on the schema's 3000 while the
 * desktop waits elsewhere. Same reading as `loadDesktopConfig`.
 */
function firstLaunchPorts(home: string): Record<string, string> {
  if (existsSync(join(home, 'timon.config.json'))) return {};
  let { daemon, app } = PACKAGED_PORTS;
  try {
    const ports = JSON.parse(readFileSync(join(home, 'desktop-bootstrap.json'), 'utf8')) as { daemonPort?: unknown; appPort?: unknown };
    const valid = (port: unknown): port is number => Number.isInteger(port) && Number(port) > 1024 && Number(port) < 65536;
    if (valid(ports.daemonPort) && valid(ports.appPort) && ports.daemonPort !== ports.appPort) {
      daemon = ports.daemonPort;
      app = ports.appPort;
    }
  } catch { /* No previous desktop bootstrap: the packaged defaults. */ }
  return { PORT: String(daemon), TIMON_APP_ENABLED: '1', TIMON_APP_PORT: String(app) };
}

/**
 * `timon service` run by the packaged CLI launcher (`cli/timon`): the app's
 * Electron runtime as Node, without what the desktop sets on its own daemon.
 * Unmarked, the CLI built a source checkout's service around the Timon
 * binary: launchd started it as an application, nothing listened on the port
 * and it was restarted in a loop (macOS 0.1.3, TODO #206). The version names
 * the staged release exactly as the desktop's `app.getVersion()` does;
 * `current` would stage a second copy and prune the real one.
 * Call it before the config is read: the first-launch ports go through it.
 */
export function markPackagedCli(
  env: NodeJS.ProcessEnv,
  versions: NodeJS.ProcessVersions,
  version: string,
  home: string,
  execPath: string = process.execPath,
): void {
  if (!packagedRuntime({ versions, execPath, platform: process.platform })) return;
  if (env.TIMON_DESKTOP_EMBEDDED !== '1' && env.TIMON_DESKTOP_SERVICE !== '1') {
    env.TIMON_DESKTOP_SERVICE = '1';
  }
  env.TIMON_DESKTOP_VERSION ??= version;
  for (const [key, value] of Object.entries(firstLaunchPorts(home))) env[key] ??= value;
}

/**
 * Does the service run from a copy under `desktop-runtime/releases`? Only a
 * packaged macOS or Linux install does; Windows runs the installation
 * directory itself. The desktop upgrade (`desktop/src/upgrade.ts`) migrates
 * exactly these platforms, so the two must change together.
 */
export function stagesPackagedRuntime(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): boolean {
  const packaged = env.TIMON_DESKTOP_EMBEDDED === '1' || env.TIMON_DESKTOP_SERVICE === '1';
  return (platform === 'linux' || platform === 'darwin') && packaged;
}

export function serviceOptsForPlatform(
  base: ServiceOpts,
  env: NodeJS.ProcessEnv,
  executable: string,
  appPort: number,
): ServiceOpts {
  if (stagesPackagedRuntime(base.platform, env)) {
    return packagedServiceOptions(base, executable, appPort);
  }
  // Windows runs the installation directory itself, but its daemon is just as
  // packaged: without the marker it skipped the update approval and its
  // routes, opened (and migrated) the database unasked, and the desktop's
  // update window got a 401 (0.1.2-rc.4, 27/09/2026).
  if (base.platform === 'win32' && (env.TIMON_DESKTOP_EMBEDDED === '1' || env.TIMON_DESKTOP_SERVICE === '1')) {
    return { ...base, environment: { ...base.environment, TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '0' } };
  }
  return base;
}

