/**
 * Child process supervisor — the relaunch mechanics shared by the
 * modules that launch a long-running binary (`web-app`, `telegram`).
 *
 * Extracted verbatim from `plugins-bundled/web-app/index.ts` (step 3.1) on
 * the occasion of step 3.2, which needs the same thing for two more
 * children. The behaviour is identical word for word: the `web-app` tests
 * pass without modification, which is what proves the extraction.
 *
 * What the supervisor does NOT do, on purpose:
 *  - it builds no environment. `spawn.env` REPLACES the child's
 *    environment (Node does not merge): each caller decides whether it wants
 *    a minimal environment (web-app, which only calls absolute paths)
 *    or `{ ...process.env, … }` (telegram and uvx, which need PATH, HOME
 *    and the secrets already exported);
 *  - it does not decide whether the module must run. That is `apply`'s business.
 */
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Host, SpawnOpts } from '../host/index.js';
import { createNotification } from '../notifications.js';
import type { DaemonMessage } from '../daemon-message.js';

/** First relaunch delay, then doubling up to the ceiling. */
export const FIRST_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 30_000;
/**
 * Beyond this number of consecutive QUICK relaunches, give up and
 * alert: a process that dies in a loop is a build defect or a missing
 * binary, not a hazard one more relaunch would fix.
 *
 * A `beforeStart` that refuses (port still held) is NOT a fall: nothing
 * was launched, and the cause clears by itself — the old process ends up
 * dying. These waits have their own ladder (same backoff), alert
 * once at the same threshold, then keep probing every `MAX_DELAY_MS`
 * without end. Giving up there left the interface dead until the daemon
 * restarted while the port had been freed (macOS report of 26/10/2026).
 *
 * "Quick" = the child fell before having held `RESTART_WINDOW_MS`. A
 * count over a sliding window of 60 s of wall clock — the literal reading
 * of "5 relaunches / 60 s" — would never trigger: the backoff itself
 * (2+4+8+16+30) already takes 60 s, so the fifth relaunch would always fall
 * outside the window. A child that held a minute resets counter and backoff to
 * zero: it is an isolated incident, not a loop.
 */
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 60_000;
/** Uptime after which a clean exit starts the `cleanExitRetries` count over. */
export const CLEAN_EXIT_RESET_MS = 3_600_000;

export type SuperviseOpts = {
  /** Log prefix, without brackets (`web-app`, `telegram/telegram-poll`…). */
  label: string;
  /** Return a reason to wait instead of spawning; checked before every attempt. */
  beforeStart?: () => string | undefined | Promise<string | undefined>;
  /** Long-running services may explicitly stop on an unsignalled successful exit. */
  cleanExit?: 'stop' | 'restart';
  /** Retries before cleanExit: 'stop' (a child that held `CLEAN_EXIT_RESET_MS`
   *  starts the count over). */
  cleanExitRetries?: number;
  command: string;
  args: string[];
  /** Options passed as is to `host.spawn` (cwd, env, stdio). */
  spawn: SpawnOpts;
  /**
   * Alert raised when giving up. `null` = log only. `message` is the code of
   * `title` and `body`, for the webview to show them in the reader's language;
   * `why` stays the technical English cause, a param of that message.
   */
  alert?: { title: string; body: (why: string) => string; message?: (why: string) => DaemonMessage } | null;
  /**
   * Path where to publish the pid of the current child. Absent = nothing is written.
   *
   * It is the only hold a local CLI command has on a child of the daemon:
   * `timon app restart` reads this file and signals the pid, the supervisor relaunches
   * behind. The file is rewritten on each relaunch and erased on stop, so
   * that a dead pid never passes itself off as a living child.
   */
  pidFile?: string;
  /**
   * Keep the last N stderr lines and join them to a failed exit's message.
   * Next exits with `code 1` and its reason on stderr: written straight to
   * the daemon's descriptor, it reached no log line and no alert (TODO #343).
   * The output is piped and re-emitted through the daemon's own streams, so
   * it is stamped and lands in the dated log like the rest.
   */
  outputTail?: number;
};

/**
 * What `wakeSupervisor` did:
 *  - `unknown`: no live supervisor under this label (module off, app not
 *    built at boot, or never started in this daemon);
 *  - `running`: a child is up, nothing to do (`timon app restart` signals it);
 *  - `starting`: a start check or a spawn is already in flight;
 *  - `woken`: a pending retry or port check was brought forward to now;
 *  - `rearmed`: the supervisor had given up; it starts again from zero.
 */
export type WakeResult = 'unknown' | 'running' | 'starting' | 'woken' | 'rearmed';

/**
 * Live supervisors by label. A supervisor that gave up (`MAX_RESTARTS` rapid
 * falls, or `cleanExit: 'stop'`) used to stay down until the daemon restarted,
 * and restarting the daemon kills every live mission (TODO #485). The registry
 * is the handle an authenticated route uses to start it again.
 */
const supervisors = new Map<string, { wake: () => WakeResult }>();

/** Brings the supervisor named `label` back to work, now. Never throws. */
export function wakeSupervisor(label: string): WakeResult {
  return supervisors.get(label)?.wake() ?? 'unknown';
}

/** The last `max` non-empty lines written to `push`, oldest first. */
export function lineTail(max: number): { push: (chunk: string) => void; lines: () => string[] } {
  const kept: string[] = [];
  let partial = '';
  return {
    push(chunk) {
      const parts = (partial + chunk).split(/\r?\n/);
      partial = parts.pop() ?? '';
      for (const line of parts) {
        if (!line.trim()) continue;
        kept.push(line.length > 500 ? `${line.slice(0, 500)}…` : line);
        if (kept.length > max) kept.shift();
      }
    },
    lines: () => (partial.trim() ? [...kept, partial].slice(-max) : [...kept]),
  };
}

/**
 * Launches the child and keeps it alive. Returns the stop function, to hand to
 * `ctx.effect`: it cuts the relaunch and kills the child.
 */
export function superviseChild(host: Host, opts: SuperviseOpts): () => void {
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // `stopped` alone cannot tell a supervisor that gave up (wake may rearm it)
  // from one its owner disposed of (it must stay down).
  let disposed = false;
  let starting = false;
  let delay = FIRST_DELAY_MS;
  let rapidFalls = 0;
  let cleanExits = 0;
  let waits = 0;
  let waitDelay = FIRST_DELAY_MS;
  let waitAlerted = false;
  let startedAt = 0;
  let publishedPid: number | undefined;

  const abandon = (why: string): void => {
    stopped = true;
    console.error(`[${opts.label}] ${why}`);
    alert(why);
  };

  const scheduleRestart = (why: string): void => {
    if (stopped) return;
    if (Date.now() - startedAt >= RESTART_WINDOW_MS) {
      // The child held a minute: isolated incident, start again from the first delay.
      rapidFalls = 0;
      delay = FIRST_DELAY_MS;
    }
    rapidFalls += 1;
    if (rapidFalls > MAX_RESTARTS) {
      abandon(`${MAX_RESTARTS} retries without staying up ${RESTART_WINDOW_MS / 1000}s: ${why}`);
      return;
    }
    console.warn(`[${opts.label}] ${why} — retry in ${delay / 1000}s`);
    timer = setTimeout(() => { timer = undefined; start(); }, delay);
    // The supervisor must not hold the event loop on its own.
    timer.unref?.();
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  };

  const alert = (why: string): void => {
    if (opts.alert) createNotification({ type: 'alert', urgent: true, title: opts.alert.title, body: opts.alert.body(why), message: opts.alert.message?.(why) ?? null });
  };

  /** `beforeStart` refused: nothing ran, so this never feeds `rapidFalls`. */
  const scheduleWait = (why: string): void => {
    if (stopped) return;
    waits += 1;
    if (waits <= MAX_RESTARTS) {
      console.warn(`[${opts.label}] ${why} — retry in ${waitDelay / 1000}s`);
    } else if (!waitAlerted) {
      // One alert, one log line: the poll below may last hours, and a line or
      // a notification every 30 s would bury everything else.
      waitAlerted = true;
      console.error(`[${opts.label}] ${MAX_RESTARTS} checks without starting: ${why}; checking again every ${MAX_DELAY_MS / 1000}s`);
      alert(why);
    }
    timer = setTimeout(() => { timer = undefined; start(); }, waitDelay);
    timer.unref?.();
    waitDelay = Math.min(waitDelay * 2, MAX_DELAY_MS);
  };

  const writePid = (pid: number | undefined): void => {
    if (!opts.pidFile || pid === undefined) return;
    // A pidfile that cannot be written must not take the child down:
    // only `timon app restart` depends on it, and it can say "no known child".
    try {
      mkdirSync(dirname(opts.pidFile), { recursive: true });
      writeFileSync(opts.pidFile, `${pid}\n`);
      publishedPid = pid;
    } catch (err) {
      console.warn(`[${opts.label}] pidfile not written (${(err as Error).message})`);
    }
  };

  const clearPid = (): void => {
    if (!opts.pidFile || publishedPid === undefined) return;
    // A competing supervisor may have published its own PID while we stopped.
    try {
      if (readFileSync(opts.pidFile, 'utf8').trim() === String(publishedPid)) {
        rmSync(opts.pidFile, { force: true });
      }
    } catch { /* Already removed or inaccessible. */ }
    publishedPid = undefined;
  };

  function start(): void {
    if (stopped) return;
    starting = true;
    const ready = (why: string | undefined): void => {
      starting = false;
      if (stopped) return;
      if (why) { scheduleWait(why); return; }
      if (waitAlerted) console.log(`[${opts.label}] startup check passed after ${waits} checks; starting`);
      waits = 0;
      waitDelay = FIRST_DELAY_MS;
      waitAlerted = false;
      launch();
    };
    try {
      const check = opts.beforeStart?.();
      if (check instanceof Promise) void check.then(ready, () => ready('startup check failed'));
      else ready(check);
    } catch { ready('startup check failed'); }
  }

  function launch(): void {
    // Set before the spawn: a synchronous spawn failure must still count as a
    // rapid fall, not as a child that held a minute since the last attempt.
    startedAt = Date.now();
    let spawned: ChildProcess;
    const capture = Boolean(opts.outputTail) && opts.spawn.stdio === 'inherit';
    const tail = lineTail(opts.outputTail ?? 0);
    try {
      spawned = host.spawn(opts.command, opts.args, capture ? { ...opts.spawn, stdio: ['inherit', 'pipe', 'pipe'] } : opts.spawn);
    } catch { scheduleRestart('spawn failed; check executable configuration'); return; }
    if (capture) {
      spawned.stdout?.on('data', (chunk: Buffer) => process.stdout.write(chunk));
      spawned.stderr?.on('data', (chunk: Buffer) => {
        process.stderr.write(chunk);
        tail.push(chunk.toString('utf8'));
      });
    }
    child = spawned;
    startedAt = Date.now();
    writePid(spawned.pid);
    // The same exit only counts once: on an ENOENT, node emits `error`
    // AND `exit`, and two scheduled relaunches would step on each other.
    let down = false;
    const fell = (why: string, clean = false) => {
      if (down || child !== spawned) return;
      down = true;
      child = undefined;
      clearPid();
      if (stopped) return;
      console.warn(`[${opts.label}] ${why}; uptime ${Date.now() - startedAt}ms`);
      // A child that held an hour was an isolated exit: counted over the
      // supervisor's life, three clean exits days apart took the web app down
      // for good. An hour, not `RESTART_WINDOW_MS`: an app that exits 0 every
      // couple of minutes must still stop (TIM-0011), at worst it now costs
      // one restart an hour.
      if (clean && Date.now() - startedAt >= CLEAN_EXIT_RESET_MS) cleanExits = 0;
      if (clean && opts.cleanExit === 'stop' && ++cleanExits > (opts.cleanExitRetries ?? 0)) abandon(why);
      else scheduleRestart(why);
    };
    spawned.on('error', (err: Error) => fell(`spawn failed: ${err.message}`));
    spawned.on('exit', (code, signal) => {
      const clean = code === 0 && !signal;
      const report = (): void => {
        const stderr = clean ? [] : tail.lines();
        fell(`${clean ? 'clean exit' : 'process exit'} (code ${code ?? 'null'}, signal ${signal ?? 'null'})`
          + (stderr.length ? `; last stderr: ${stderr.join(' | ')}` : ''), clean);
      };
      // `exit` can precede the last chunks of the pipe; a grandchild holding it
      // open must not hold the restart, hence the short bound.
      const stream = capture ? spawned.stderr : null;
      if (!stream || stream.readableEnded || stream.destroyed) { report(); return; }
      const bound = setTimeout(report, 250);
      bound.unref?.();
      stream.once('close', () => { clearTimeout(bound); report(); });
    });
  }

  const wake = (): WakeResult => {
    if (disposed) return 'unknown';
    if (child) return 'running';
    if (starting) return 'starting';
    if (timer) {
      // The backoff and the loop guard keep their counts: an operator asking
      // "now" is not proof the cause is gone.
      clearTimeout(timer);
      timer = undefined;
      console.log(`[${opts.label}] woken up: retrying now`);
      start();
      return 'woken';
    }
    if (!stopped) return 'starting';
    // Gave up. Rearming is a human gesture after a fix (a rebuild, a freed
    // port): every counter starts over, as at the daemon's boot.
    stopped = false;
    delay = FIRST_DELAY_MS;
    rapidFalls = 0;
    cleanExits = 0;
    waits = 0;
    waitDelay = FIRST_DELAY_MS;
    waitAlerted = false;
    console.log(`[${opts.label}] rearmed: starting again from zero`);
    start();
    return 'rearmed';
  };
  const entry = { wake };
  supervisors.set(opts.label, entry);

  start();

  return () => {
    disposed = true;
    stopped = true;
    // A newer supervisor under the same label (module re-applied) keeps its entry.
    if (supervisors.get(opts.label) === entry) supervisors.delete(opts.label);
    if (timer) { clearTimeout(timer); timer = undefined; }
    // `kill 0` (missing pid) would signal the whole process group, hence the
    // daemon itself. ONLY this child is killed, and only if it has one.
    if (child?.pid !== undefined) child.kill();
    child = undefined;
    clearPid();
  };
}
