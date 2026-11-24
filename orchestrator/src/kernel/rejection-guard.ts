/**
 * Unhandled promise rejections no longer take the daemon down (TODO #614).
 *
 * TODO #580 covered `async` route handlers. What it could not reach: a promise
 * started without `await` in a handler, a `setTimeout(async …)`, a bus
 * listener — any of it in a third-party plugin's code. Node 15+ turns such a
 * rejection into an uncaught exception and exits with code 1: the service and
 * every live mission with it, because a plugin forgot a `.catch()`.
 *
 * Decision: the daemon logs the rejection, says who caused it, and keeps
 * running. A rejection is a failed async chain nobody observed; the code after
 * its `await` simply did not run, which is the state a caught error leaves.
 * A synchronous `throw` that reaches the top of the stack is another matter —
 * it may stop a mutation half-way — so `uncaughtException` keeps Node's fatal
 * default. The ESM entry's own failure (`boot.ts`, top-level await) is
 * reported by the loader as an uncaught exception, not a rejection: a daemon
 * that cannot boot still exits.
 *
 * Attribution reads the reason's stack: the first frame inside a mounted
 * plugin's directory names that plugin (it started the chain, even when the
 * frame that threw is a facade of the core), else a bundled module's folder
 * names the module, else it is the core's. A plugin's rejections also reach
 * the notification center — once an hour per plugin, without the error text,
 * which may carry a path or a token.
 */
import { daemonMessage } from '../daemon-message.js';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export type RejectionOwner =
  | { kind: 'plugin'; id: string }
  | { kind: 'module'; id: string }
  | { kind: 'core' };

/** Plugin id → its package directory (resolved, plus the real path behind a link). */
const pluginSources = new Map<string, string[]>();

const caseFold = process.platform === 'win32' || process.platform === 'darwin';
function comparable(path: string): string {
  return caseFold ? path.toLowerCase() : path;
}

/** Recorded by the plugin loader while the plugin is mounted. */
export function setPluginSource(id: string, dir: string): void {
  const dirs = new Set([resolve(dir)]);
  try { dirs.add(realpathSync(dir)); } catch { /* not on disk: its frames cannot exist either */ }
  pluginSources.set(id, [...dirs].map((d) => comparable(d.endsWith(sep) ? d : d + sep)));
}

export function clearPluginSource(id: string): void {
  pluginSources.delete(id);
}

/** The file of a stack frame, without its `:line:col` and the hot-reload `?rev=` query. */
function frameFile(line: string): string | null {
  const at = line.trim();
  if (!at.startsWith('at ')) return null;
  const inner = at.endsWith(')') && at.includes('(') ? at.slice(at.lastIndexOf('(') + 1, -1) : at.slice(3).replace(/^async /, '');
  const location = inner.replace(/:\d+(:\d+)?$/, '');
  if (location.startsWith('file://')) {
    try { return fileURLToPath(location.replace(/[?#].*$/, '')); } catch { return null; }
  }
  return location.startsWith('node:') || location === 'native' || location === '<anonymous>' ? null : location;
}

const BUNDLED_MODULE = /[\\/]plugins-bundled[\\/]([^\\/]+)[\\/]/;

export function rejectionOwner(reason: unknown): RejectionOwner {
  const stack = reason instanceof Error && typeof reason.stack === 'string' ? reason.stack : '';
  const files = stack.split('\n').map(frameFile).filter((f): f is string => f !== null);
  for (const file of files) {
    const path = comparable(file);
    for (const [id, dirs] of pluginSources) {
      if (dirs.some((dir) => path.startsWith(dir))) return { kind: 'plugin', id };
    }
  }
  for (const file of files) {
    const module = BUNDLED_MODULE.exec(file)?.[1];
    if (module) return { kind: 'module', id: module };
  }
  return { kind: 'core' };
}

export function ownerLabel(owner: RejectionOwner): string {
  return owner.kind === 'core' ? 'the daemon' : owner.kind === 'plugin' ? `plugin \`${owner.id}\`` : `module \`${owner.id}\``;
}

function describe(reason: unknown): string {
  if (reason instanceof Error) return reason.stack ?? `${reason.name}: ${reason.message}`;
  return `non-error value: ${typeof reason === 'string' ? reason : String(reason)}`;
}

/** Same owner, same first line: one failure repeating (a timer), not a new one. */
function signature(owner: RejectionOwner, reason: unknown): string {
  const first = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
  return `${ownerLabel(owner)}|${first.split('\n')[0]}`;
}

export const REPEAT_WINDOW_MS = 60_000;
export const NOTIFY_WINDOW_MS = 60 * 60_000;

export type RejectionGuardOptions = {
  log?: (line: string) => void;
  /** Tells the human a plugin misbehaves. Never given the error text. */
  notify?: (pluginId: string) => void;
  now?: () => number;
};

function notifyCenter(pluginId: string): void {
  void import('../notifications.js').then(({ createNotification }) => {
    createNotification({
      type: 'alert',
      urgent: false,
      title: `Plugin ${pluginId}: an asynchronous operation failed`,
      body: 'Timon kept running. The plugin left an error unhandled; the daemon log has the details. Update or disable the plugin if it repeats.',
      message: daemonMessage('plugin_async_failure', { pluginId }),
      source: `plugin:${pluginId}`,
    });
  }).catch(() => { /* notification center unavailable: the log already has it */ });
}

/**
 * The reporter behind both the process-wide listener and `guardPluginCallback`.
 * Repeats of one failure inside `REPEAT_WINDOW_MS` are counted, not printed:
 * a plugin's interval rejecting every 100 ms must not fill the disk.
 */
export function createRejectionReporter(opts: RejectionGuardOptions = {}): (reason: unknown, context?: { owner?: RejectionOwner; label?: string }) => void {
  const log = opts.log ?? ((line: string) => console.error(line));
  const notify = opts.notify ?? notifyCenter;
  const now = opts.now ?? Date.now;
  const seen = new Map<string, { at: number; suppressed: number }>();
  const notified = new Map<string, number>();
  return (reason, context = {}) => {
    const owner = context.owner ?? rejectionOwner(reason);
    const at = now();
    const key = signature(owner, reason);
    const last = seen.get(key);
    if (last && at - last.at < REPEAT_WINDOW_MS) {
      last.suppressed += 1;
    } else {
      if (seen.size > 500) {
        for (const [k, v] of seen) if (at - v.at >= REPEAT_WINDOW_MS) seen.delete(k);
      }
      const repeats = last?.suppressed ? ` (${last.suppressed} identical failure(s) not shown since the last one)` : '';
      const where = context.label ? ` in ${context.label}` : '';
      log(`[unhandled-rejection] ${ownerLabel(owner)}${where}: an error was left unhandled; the daemon keeps running${repeats}\n${describe(reason)}`);
      seen.set(key, { at, suppressed: 0 });
    }
    if (owner.kind === 'plugin') {
      const lastNotice = notified.get(owner.id);
      if (lastNotice === undefined || at - lastNotice >= NOTIFY_WINDOW_MS) {
        notified.set(owner.id, at);
        try { notify(owner.id); } catch { /* the log line is the record */ }
      }
    }
  };
}

/** Outside the daemon (tests, a host without the guard): log, never notify. */
const fallbackReport = createRejectionReporter({ notify: () => {} });
let report: ReturnType<typeof createRejectionReporter> | null = null;

/**
 * Installs the process-wide listener. Its mere presence is what stops Node
 * from exiting: with a listener, `--unhandled-rejections=throw` (the default)
 * only emits the event. Daemon-only — the CLI keeps failing loudly.
 */
export function installRejectionGuard(opts: RejectionGuardOptions = {}): () => void {
  const reporter = createRejectionReporter(opts);
  const listener = (reason: unknown): void => {
    try { reporter(reason); } catch { /* reporting must never be what crashes */ }
  };
  report = reporter;
  process.on('unhandledRejection', listener);
  return () => {
    process.off('unhandledRejection', listener);
    if (report === reporter) report = null;
  };
}

/**
 * Wraps a callback the daemon calls on a plugin's behalf from a place that
 * cannot await it (a synchronous bus emission): a `throw` stays out of the
 * emitter — the core's write that published the event, and the listeners
 * after this one — and a rejected promise is reported, attributed to the
 * plugin even when its stack names no file of it.
 */
export function guardPluginCallback<A extends unknown[]>(pluginId: string, label: string, fn: (...args: A) => unknown): (...args: A) => void {
  return guardCallback({ kind: 'plugin', id: pluginId }, label, fn);
}

/**
 * Same isolation for any owner: a bundled module's raw Cordis listener, fed by
 * the bus bridge, is delivered from inside the publisher's `bus.publish` just
 * like a plugin's (TODO #630).
 */
export function guardCallback<A extends unknown[]>(owner: RejectionOwner, label: string, fn: (...args: A) => unknown): (...args: A) => void {
  const fail = (err: unknown): void => {
    try { (report ?? fallbackReport)(err, { owner, label }); } catch { /* idem */ }
  };
  return (...args: A) => {
    try {
      const result = fn(...args);
      if (typeof result === 'object' && result !== null && typeof (result as { then?: unknown }).then === 'function') {
        (result as PromiseLike<unknown>).then(undefined, fail);
      }
    } catch (err) {
      fail(err);
    }
  };
}
