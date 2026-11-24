/**
 * Windows: ask the daemon to stop before ending it by force.
 *
 * POSIX stops send SIGTERM, which runs the daemon's common stop
 * (`daemon-shutdown.ts`). Windows has no such signal to send: `timon service
 * stop` and the service restart end the scheduled task's daemon with
 * `schtasks /End` and `taskkill /F /T`, which run no handler, so the next start
 * read the previous run as `unknown`. So on Windows they first call
 * `POST /api/daemon/shutdown` with the daemon token, wait for the daemon to
 * go, and only then run their usual elevated batch, whose kills are now the
 * fallback for a daemon that did not leave. A daemon that does not answer, or
 * refuses, gets the batch at once, as before.
 *
 * The token is the operator's credential: it is only ever sent to a loopback
 * address over plain HTTP, never anywhere else, and never written to a line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { statusService, WINDOWS_TASK, type ServiceOpts, type ServiceResult } from './service-install.js';

/** How long the caller waits for the daemon to leave: past its own grace (`SHUTDOWN_GRACE_MS`). */
export const COOPERATIVE_STOP_WAIT_MS = 10_000;
/** Overrides that wait, in milliseconds; `0` skips the request and kills at once, as before. */
export const COOPERATIVE_STOP_ENV = 'TIMON_COOPERATIVE_STOP_MS';
const MAX_WAIT_MS = 120_000;
const POLL_MS = 250;

export type CooperativeStopOutcome =
  /** The daemon accepted and is gone. */
  | 'stopped'
  /** Nothing was asked: no token, no local address, or the wait is set to 0. */
  | 'skipped'
  /** Nothing answered: there was no daemon to ask. */
  | 'unreachable'
  /** A daemon answered, but not with a stop (another home's, an older version). */
  | 'refused'
  /** It accepted but still answers once the wait is over. */
  | 'timeout';

export type CooperativeStop = { outcome: CooperativeStopOutcome; line: string };

/** What a pid test can tell from here: a daemon of another session may not let itself be opened. */
export type PidState = 'alive' | 'gone' | 'unknown';

export type CooperativeStopDeps = {
  origin: string;
  readToken: () => string | null;
  waitMs?: number;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
  probePid?: (pid: number) => PidState;
  pollMs?: number;
};

/** `EPERM` proves nothing here: a session-0 daemon refuses a test from the user's session. */
export function probePid(pid: number): PidState {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';
  }
}

/** The wait the environment asks for; anything unreadable keeps the default. */
export function cooperativeStopWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[COOPERATIVE_STOP_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return COOPERATIVE_STOP_WAIT_MS;
  return Math.min(Number(raw), MAX_WAIT_MS);
}

/** Reads the daemon token of `timonHome`, `null` when there is none to send. */
export function daemonTokenOf(timonHome: string): string | null {
  try {
    const token = readFileSync(join(timonHome, 'daemon-token'), 'utf8').trim();
    return token || null;
  } catch {
    return null;
  }
}

function localOrigin(origin: string): URL | null {
  try {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || url.username || url.password) return null;
    return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) ? url : null;
  } catch {
    return null;
  }
}

const Accepted = z.object({ pid: z.number().int().positive().optional() });

/**
 * Asks the daemon at `origin` to stop and waits until it no longer answers
 * and, when its pid can be tested, until it has exited. Never throws: the
 * outcome says whether the forced stop still has something to end.
 */
export async function askDaemonToStop(deps: CooperativeStopDeps): Promise<CooperativeStop> {
  const waitMs = deps.waitMs ?? COOPERATIVE_STOP_WAIT_MS;
  if (waitMs <= 0) return { outcome: 'skipped', line: `daemon not asked to stop (${COOPERATIVE_STOP_ENV}=0)` };
  const url = localOrigin(deps.origin);
  if (!url) return { outcome: 'skipped', line: 'daemon not asked to stop: not a local address' };
  const token = deps.readToken();
  if (!token) return { outcome: 'skipped', line: 'daemon not asked to stop: no daemon token' };
  const fetcher = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const probe = deps.probePid ?? probePid;

  let pid: number | undefined;
  try {
    const res = await fetcher(new URL('/api/daemon/shutdown', url), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    if (res.status !== 202) return { outcome: 'refused', line: `daemon did not accept to stop (HTTP ${res.status}): ending it` };
    const body = Accepted.safeParse(await res.json().catch(() => ({})));
    pid = body.success ? body.data.pid : undefined;
  } catch {
    return { outcome: 'unreachable', line: 'no daemon answered the stop request' };
  }

  const answers = async (): Promise<boolean> => {
    try {
      await fetcher(new URL('/api/health', url), { redirect: 'manual', signal: AbortSignal.timeout(1_000) });
      return true;
    } catch {
      return false;
    }
  };
  const deadline = now() + waitMs;
  for (;;) {
    if (!(await answers()) && (pid === undefined || probe(pid) !== 'alive')) {
      return { outcome: 'stopped', line: 'daemon stopped on request' };
    }
    if (now() >= deadline) break;
    await sleep(deps.pollMs ?? POLL_MS);
  }
  return { outcome: 'timeout', line: `daemon still running ${Math.round(waitMs / 1000)}s after the stop request: ending it` };
}

/**
 * Runs a Windows `stop` or `restart` of the service after asking its daemon to
 * stop. Only where that gesture would end it anyway: a Windows service that
 * is installed, outside a dry run. Otherwise the gesture runs alone, with its
 * own refusal, and the embedded daemon of a desktop without a service is not
 * stopped by a `timon service stop` that does nothing else.
 */
export async function withCooperativeStop(
  opts: ServiceOpts,
  gesture: (opts: ServiceOpts) => ServiceResult,
  ask: () => Promise<CooperativeStop>,
): Promise<ServiceResult> {
  if (opts.platform !== 'win32' || opts.dryRun || !statusService(opts).installed) return gesture(opts);
  const asked = await ask();
  const result = gesture(opts);
  const lines = [asked.line, ...result.lines];
  // The batch never ran, but the daemon already left: say what is true now.
  if (!result.ok && asked.outcome === 'stopped' && result.reason?.startsWith('elevation refused')) {
    return { ...result, lines, reason: `elevation refused: the daemon stopped, but the ${WINDOWS_TASK} task was not changed and starts it again within minutes` };
  }
  return { ...result, lines };
}

/**
 * The request for this installation: its daemon token, sent to its own
 * loopback listener. Never from inside a mission, as the CLI never falls back
 * to that token there: the gesture then kills, as it always did.
 */
export function cooperativeStopOf(origin: string, timonHome: string, env: NodeJS.ProcessEnv = process.env): () => Promise<CooperativeStop> {
  if (env.TIMON_MISSION_ID) return async () => ({ outcome: 'skipped', line: 'daemon not asked to stop from inside a mission' });
  return () => askDaemonToStop({ origin, readToken: () => daemonTokenOf(timonHome), waitMs: cooperativeStopWaitMs(env) });
}
