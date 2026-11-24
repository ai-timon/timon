/**
 * The daemon's one way out when it is asked to stop.
 *
 * A stop signal (`host/stop-signals.ts`) runs the registered shutdown steps,
 * then releases the module tree (each module's disposers: timers, listeners,
 * the telemetry queue flushed), then `process.exit(0)`. Exiting is the point:
 * a signal left to its default ends the process without an `exit` event, and
 * what records how the last run ended (`telemetry/runtime.ts`) then reads it
 * as `unknown` at the next start.
 *
 * Before this module, only `resources-guard` caught the signals, and only
 * where systemd runs: macOS and Windows stopped by the default action. The
 * guard now registers its scope sweep as a step here instead.
 *
 * Everything is bounded: a disposer that never settles must not keep a stopped
 * service alive, so after `graceMs` the daemon exits anyway. A second signal
 * while stopping exits at once.
 *
 * Windows delivers none of these signals to a daemon run by its scheduled task
 * or by the desktop: what ends them there is `taskkill /F` or TerminateProcess,
 * which runs no handler. So the same stop can also be asked for in-process
 * (`requestDaemonShutdown`, behind `POST /api/daemon/shutdown`), and the
 * Windows stop paths ask for it before they fall back to the forced kill.
 */

/** A step run before the module tree is released, in registration order. */
export type ShutdownStep = () => void | Promise<void>;

/** What the daemon listens on: `process` in production, a fake in tests. */
export type SignalSource = {
  on(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
  off(signal: NodeJS.Signals, listener: (signal: NodeJS.Signals) => void): unknown;
};

export type DaemonShutdownOptions = {
  signals: readonly NodeJS.Signals[];
  /** Releases the module tree (the root fiber's `dispose`). */
  release: () => void | Promise<void>;
  proc?: SignalSource;
  exit?: (code: number) => void;
  graceMs?: number;
  log?: (line: string) => void;
  /** Tests: the steps to run; the registered ones by default. */
  steps?: () => readonly ShutdownStep[];
};

export const SHUTDOWN_GRACE_MS = 5_000;

const steps = new Set<ShutdownStep>();

/** Runs `step` when the daemon stops; the returned function takes it back. */
export function onDaemonShutdown(step: ShutdownStep): () => void {
  steps.add(step);
  return () => { steps.delete(step); };
}

const installed = new WeakSet<SignalSource>();

/** What asking for the stop found: a stop started, one already under way, or nothing listening. */
export type ShutdownRequest = 'stopping' | 'already-stopping' | 'unavailable';

/** The stop of the last `installDaemonShutdown`, as a request rather than a signal. */
type Requestable = { request: (why: string) => ShutdownRequest; stopping: () => boolean };
let current: Requestable | null = null;

/**
 * Runs the same stop a signal runs, for a caller that cannot send one (the
 * Windows stop paths, through the HTTP route). Unlike a second signal, asking
 * again while stopping never hurries the exit: a client that repeats its
 * request is not a person pressing Ctrl+C twice.
 */
export function requestDaemonShutdown(why: string): ShutdownRequest {
  return current ? current.request(why) : 'unavailable';
}

/** What a request would answer now, without starting anything. */
export function daemonShutdownState(): ShutdownRequest {
  if (!current) return 'unavailable';
  return current.stopping() ? 'already-stopping' : 'stopping';
}

/**
 * Listens for the stop signals on `proc`. Once per source: a second call is
 * ignored, so two stops can never race on one process. Returns what removes
 * the listeners.
 */
export function installDaemonShutdown(opts: DaemonShutdownOptions): () => void {
  const proc = opts.proc ?? process;
  if (installed.has(proc)) return () => {};
  installed.add(proc);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const log = opts.log ?? ((line: string) => console.log(line));
  const graceMs = opts.graceMs ?? SHUTDOWN_GRACE_MS;
  const stepsToRun = opts.steps ?? (() => [...steps]);

  let stopping = false;
  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    exit(0);
  };
  const failed = (what: string, err: unknown): void => {
    log(`[timon] shutdown: ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  };

  const stop = (): void => {
    stopping = true;
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<void>((resolve) => { timer = setTimeout(resolve, graceMs); });
    const work = (async () => {
      for (const step of stepsToRun()) {
        try { await step(); } catch (err) { failed('a step', err); }
      }
      try { await opts.release(); } catch (err) { failed('module release', err); }
    })();
    void Promise.race([work, deadline]).then(() => {
      clearTimeout(timer);
      leave();
    });
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) {
      log(`[timon] ${signal} received again: exiting now`);
      leave();
      return;
    }
    log(`[timon] ${signal} received: stopping`);
    stop();
  };

  const onRequest = (why: string): ShutdownRequest => {
    if (stopping) return 'already-stopping';
    log(`[timon] stop requested (${why}): stopping`);
    stop();
    return 'stopping';
  };

  for (const signal of opts.signals) proc.on(signal, onSignal);
  const requestable: Requestable = { request: onRequest, stopping: () => stopping };
  current = requestable;
  return () => {
    for (const signal of opts.signals) proc.off(signal, onSignal);
    installed.delete(proc);
    if (current === requestable) current = null;
  };
}
