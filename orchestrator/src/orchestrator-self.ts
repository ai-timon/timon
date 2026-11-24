/**
 * Self-supervision: status / restart / rebuild of the `timon-orchestrator`
 * service itself, for the TIMON mini-widget of the chat's right rail (not to be confused
 * with `docker.ts`, which supervises the containers of the OTHER projects).
 *
 * Host mode, not Docker: the orchestrator runs as a node process under systemd
 * --user (see the project's CLAUDE.md). A rebuild = `npm run build` (tsc) followed
 * by a `systemctl --user restart`, never the other way round — a restart on a broken
 * build would replace a running orchestrator with a half-compiled `dist/`,
 * possibly failing to start.
 *
 * GUARD: this module never triggers itself. Restart and rebuild are
 * exclusively human actions from the UI (see deploy-hook.ts, which
 * NOTIFIES instead of acting for `orchestrator/`) — a restart kills every
 * mission in flight.
 *
 * The restart kills the current process: `restartOrchestrator()` must only be
 * called AFTER the HTTP response has had time to leave (see the delay
 * in the function, and the fact that the routes answer before calling this).
 */
import { config } from './config/load.js';
import { getHost } from './host/index.js';
import { systemctl } from './host/systemd.js';
import { ownLinuxUnit } from './host/packaged-service.js';
import { TIMON_HOME } from './paths.js';

/** A package runs under its own unit, `timon-desktop-<id>`: the rail would read an absent one. */
function ownService(): string {
  return `${ownLinuxUnit('timon-orchestrator', TIMON_HOME)}.service`;
}
/** Folder of the daemon to rebuild. It used to live here hard-coded (the checkout of
 *  the development workstation): the only thing in all of TIMON that required that
 *  exact path on that exact machine. It now comes from
 *  `timon.config.json` (`daemon.installDir`), read on EACH call. */
function orchDir(): string { return config().daemon.installDir; }
/** Gives the HTTP response of the triggering POST time to leave on the
 *  socket before the restart's SIGTERM stops the process writing it. */
const RESTART_DELAY_MS = 300;

export type OrchestratorStatus = {
  /** `active` | `inactive` | `failed` | `activating` | `unknown` (no systemd --user) */
  active: string;
  /** `running` | `dead` | ... — systemd sub-state, informative */
  sub: string | null;
  /** epoch ms of the last start, null if unavailable */
  since: number | null;
  memoryCurrentBytes: number | null;
  /** `npm run build` en vol */
  building: boolean;
  /** last build error, cleared after a few polls (see docker.ts, same logic) */
  buildError: string | null;
};

let building = false;
let buildError: string | null = null;
let buildErrorClearTimer: ReturnType<typeof setTimeout> | null = null;
const BUILD_ERROR_TTL_MS = 30_000;

function setBuildError(message: string | null): void {
  if (buildErrorClearTimer) clearTimeout(buildErrorClearTimer);
  buildError = message;
  if (message) buildErrorClearTimer = setTimeout(() => { buildError = null; }, BUILD_ERROR_TTL_MS);
}

export function getOrchestratorStatus(): OrchestratorStatus {
  const host = getHost();
  const self = host.services.self();

  // `sub` and `MemoryCurrent` are not in the `Host.services.self()` contract
  // — they are systemd properties, with no equivalent elsewhere. They are read
  // on top when the capability exists; on a host without systemd the widget
  // simply shows less, rather than nothing.
  const props = new Map<string, string>();
  if (host.capabilities().includes('systemd')) {
    // The one door to `systemctl` (`host/systemd.ts`); off Linux the capability is absent.
    const show = systemctl(['show', ownService(), '-p', 'SubState', '-p', 'MemoryCurrent'], { timeoutMs: 5000 });
    for (const line of show.out.split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) props.set(line.slice(0, i), line.slice(i + 1));
    }
  }
  const mem = Number(props.get('MemoryCurrent'));
  return {
    active: self.status || 'unknown',
    sub: props.get('SubState') ?? null,
    since: self.since ?? null,
    memoryCurrentBytes: Number.isFinite(mem) ? mem : null,
    building,
    buildError,
  };
}

/**
 * Restarts the orchestrator — kills this process. Do NOT call from a route
 * before having answered the client: the SIGTERM may arrive before the
 * HTTP response has finished leaving.
 */
export function restartOrchestrator(): void {
  setTimeout(() => {
    getHost().services.selfRestart();
  }, RESTART_DELAY_MS);
}

/**
 * `npm run build` in the background (async spawn, never spawnSync — a tsc
 * build takes 10-30 s and would block the whole event loop, hence every
 * running mission, if it were awaited synchronously). Restart only
 * if the build succeeds; otherwise `buildError` carries the reason and the orchestrator
 * keeps running as is.
 */
export function rebuildOrchestrator(): void {
  if (building) throw new Error('a rebuild is already running');
  building = true;
  setBuildError(null);
  const child = getHost().spawn('npm', ['run', 'build'], { cwd: orchDir(), stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
    if (stderr.length > 6000) stderr = stderr.slice(-6000);
  });
  child.on('exit', (code) => {
    building = false;
    if (code === 0) {
      restartOrchestrator();
    } else {
      setBuildError(stderr.trim().split('\n').slice(-20).join('\n') || `npm run build exited with code ${code}`);
    }
  });
  child.on('error', (err) => {
    building = false;
    setBuildError(err.message);
  });
}
