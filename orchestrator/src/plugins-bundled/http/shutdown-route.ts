/**
 * `POST /api/daemon/shutdown` — the daemon's common stop (`daemon-shutdown.ts`),
 * asked for over the loopback by whoever would otherwise have to kill it.
 *
 * Windows has no SIGTERM to send: `timon service stop`, the service restart
 * and the desktop's embedded daemon ended it with `taskkill /F` or
 * TerminateProcess, which run no handler, so the next start read the previous
 * run as `unknown`. They call this first, wait for the exit, and only then
 * fall back to the forced kill (`host/cooperative-stop.ts`).
 *
 * Operator only: the daemon token, as the CLI and the desktop shell send it.
 * Never a browser session, never a mission token, and never the daemon token
 * a mission's CLI presents with `X-TIMON-Mission`: an agent must not stop the
 * daemon it runs under. The answer (202) is sent before the stop starts, so
 * the caller always reads it; the body carries the pid to wait on.
 */
import type { Request, Response, Router } from 'express';
import { forbidden, rejectIfNotDaemonToken } from '../../users/identity.js';
import { daemonShutdownState, requestDaemonShutdown, type ShutdownRequest } from '../../daemon-shutdown.js';

export const DAEMON_SHUTDOWN_PATH = '/api/daemon/shutdown';

export type ShutdownControl = {
  state: () => ShutdownRequest;
  request: (why: string) => ShutdownRequest;
  pid: number;
};

const LIVE: ShutdownControl = { state: daemonShutdownState, request: requestDaemonShutdown, pid: process.pid };

function refuseMission(req: Request, res: Response): boolean {
  return !!req.header('X-TIMON-Mission') && forbidden(req, res, { kind: 'operator' });
}

export function registerShutdownRoute(app: Router, control: ShutdownControl = LIVE): void {
  app.post(DAEMON_SHUTDOWN_PATH, (req, res) => {
    if (rejectIfNotDaemonToken(req, res)) return;
    if (refuseMission(req, res)) return;
    const state = control.state();
    if (state === 'unavailable') {
      res.status(503).json({ ok: false, error: 'shutdown_unavailable', message: 'This daemon cannot stop itself on request; end its process.' });
      return;
    }
    res.status(202).json({ ok: true, state, pid: control.pid });
    // After the answer has left: the stop releases the HTTP server too.
    if (state === 'stopping') res.once('close', () => { control.request('operator request'); });
  });
}
