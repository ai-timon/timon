/**
 * One daemon per data directory.
 *
 * A second daemon started on a `TIMON_HOME` another one already serves used to boot in full before
 * failing to listen: on the way it marked the first daemon's live missions failed, armed a reaper
 * and touched the licence, then exited on `EADDRINUSE` and was relaunched by its supervisor, which
 * did it all over again. The first-run assistant died of exactly that: the service installed from
 * `/setup` killed the setup mission of the embedded daemon every ten seconds, and its MCP tools
 * answered 401.
 *
 * The lock is SQLite's own exclusive lock on `<home>/daemon.lock` — `LockFileEx` on Windows,
 * `fcntl` elsewhere, the mechanism `data-open-lock.ts` already relies on. The OS drops it when its
 * process ends, however it ends: a crash never leaves a lock to clear, and a recycled pid cannot
 * pass for the holder, because nothing here asks whether a pid is alive. `daemon.lock.json` only
 * tells the refused daemon whom to name; it is never read to decide.
 */
import Database from 'better-sqlite3';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const homeLockFile = (home: string): string => join(home, 'daemon.lock');
export const homeLockHolderFile = (home: string): string => join(home, 'daemon.lock.json');
/**
 * Left by a service daemon refused the home, read by the desktop (copy in `desktop/src/service.ts`).
 * After a handover that fell back on the embedded daemon, it proves the service is up and only
 * waits for the home: the desktop then hands the home over again, without a quit and reopen.
 */
export const serviceHeldOutFile = (home: string): string => join(home, 'run', 'service-held-out');

/** Distinct from `RESTORE_EXIT_CODE` (75): a supervisor or a log reader can tell the two apart. */
export const HOME_HELD_EXIT_CODE = 76;

/** Long enough for a daemon being restarted or upgraded to finish exiting, short enough to retry. */
export const HOME_LOCK_WAIT_MS = 5_000;

export type HomeLockHolder = { pid: number; startedAt: number; port?: number };

export class HomeHeldError extends Error {
  constructor(readonly home: string, readonly holder: HomeLockHolder | null) {
    const who = holder
      ? `pid ${holder.pid}${holder.port ? `, port ${holder.port}` : ', port not open yet'}, since ${new Date(holder.startedAt).toISOString()}`
      : 'its pid is not known yet';
    super(`another Timon daemon already serves ${home} (${who}): this one stops without touching the data`);
    this.name = 'HomeHeldError';
  }
}

const held = new Map<string, { lock: Database.Database; holder: HomeLockHolder }>();

const isBusy = (error: unknown): boolean => /^SQLITE_(BUSY|LOCKED)/.test(String((error as { code?: unknown }).code ?? ''));

export function readHomeLockHolder(home: string): HomeLockHolder | null {
  try {
    const parsed = JSON.parse(readFileSync(homeLockHolderFile(home), 'utf8')) as Partial<HomeLockHolder>;
    if (!Number.isSafeInteger(parsed.pid) || !Number.isFinite(parsed.startedAt)) return null;
    return {
      pid: parsed.pid as number,
      startedAt: parsed.startedAt as number,
      ...(Number.isSafeInteger(parsed.port) ? { port: parsed.port as number } : {}),
    };
  } catch {
    return null;
  }
}

function writeHolder(home: string, holder: HomeLockHolder): void {
  try { writeFileSync(homeLockHolderFile(home), `${JSON.stringify(holder)}\n`, { mode: 0o600 }); }
  catch { /* Only the refusal message of another daemon reads it. */ }
}

/**
 * Takes the lock or throws `HomeHeldError` once `waitMs` has passed with another process holding
 * it. Holding it already, in this process: returns at once — tests boot several times per process.
 *
 * A lock that cannot be taken for another reason (a filesystem without locks) only warns: refusing
 * would keep Timon from starting at all on such a disk.
 */
export function holdHomeLock(
  home: string,
  opts: { waitMs?: number; warn?: (message: string) => void; pid?: number; now?: () => number } = {},
): void {
  if (held.has(home)) return;
  const warn = opts.warn ?? ((message: string) => console.warn(message));
  let lock: Database.Database | undefined;
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    lock = new Database(homeLockFile(home), { timeout: 0 });
    try {
      lock.exec('BEGIN EXCLUSIVE');
    } catch (error) {
      if (!isBusy(error)) throw error;
      lock.pragma(`busy_timeout = ${Math.max(0, Math.floor(opts.waitMs ?? HOME_LOCK_WAIT_MS))}`);
      try {
        lock.exec('BEGIN EXCLUSIVE');
      } catch (waited) {
        if (isBusy(waited)) throw new HomeHeldError(home, readHomeLockHolder(home));
        throw waited;
      }
    }
    const holder: HomeLockHolder = { pid: opts.pid ?? process.pid, startedAt: (opts.now ?? Date.now)() };
    held.set(home, { lock, holder });
    writeHolder(home, holder);
  } catch (error) {
    try { lock?.close(); } catch { /* Closing an unusable handle cannot make things worse. */ }
    if (error instanceof HomeHeldError) throw error;
    warn(`[timon] could not lock ${home} against a second daemon (${(error as Error).message}); continuing without the lock`);
  }
}

/**
 * Records that the installed service was refused the home. Only a service daemon writes it
 * (`TIMON_DESKTOP_SERVICE=1`, never the desktop's embedded child): a refused embedded start says
 * nothing about the service. Never throws, the refusal goes on to exit either way.
 */
export function recordServiceHeldOut(
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { pid?: number; now?: () => number } = {},
): boolean {
  if (env.TIMON_DESKTOP_SERVICE !== '1' || env.TIMON_DESKTOP_EMBEDDED === '1') return false;
  try {
    const file = serviceHeldOutFile(home);
    mkdirSync(join(home, 'run'), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify({ at: (opts.now ?? Date.now)(), pid: opts.pid ?? process.pid })}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** Once listening: the port a refused daemon names. Not holding the lock: does nothing. */
export function recordHomeLockPort(home: string, port: number): void {
  const entry = held.get(home);
  if (!entry) return;
  entry.holder = { ...entry.holder, port };
  writeHolder(home, entry.holder);
}

/** Lets the next daemon in. Not holding it: does nothing. */
export function releaseHomeLock(home: string): void {
  const entry = held.get(home);
  if (!entry) return;
  held.delete(home);
  // Only our own description: a daemon that took the lock in between has written its own.
  if (readHomeLockHolder(home)?.pid === entry.holder.pid) rmSync(homeLockHolderFile(home), { force: true });
  try { entry.lock.exec('ROLLBACK'); } catch { /* Closing below releases it anyway. */ }
  entry.lock.close();
}
