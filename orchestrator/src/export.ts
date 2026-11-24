/**
 * `timon export` / `timon import` — moving a TIMON installation.
 *
 * What leaves: the `config` and `state` zones (`timon.db`, `integrations.db`)
 * of `~/.timon` (see `paths.ts`),
 * absolute paths rewritten as `~`. What NEVER leaves: the `secrets` zone
 * (Google tokens, remote key, `secrets.env`) and the `cache` zone (worktrees,
 * codex runs, browser profiles — 10 GB that can be rebuilt). The events archive
 * only leaves on explicit request: it is the bulk of the database.
 *
 * The database is copied by `VACUUM INTO` and not by `cp`: a SQLite file
 * copied hot without its `-wal` is a truncated database that opens without an error
 * and returns yesterday's data.
 *
 * The archive is made with the system's `tar` (present on Linux, macOS and
 * Windows 10+), so as not to add a compression dependency.
 */
import { createRequire } from 'node:module';
import {
  cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { config } from './config/load.js';
import { packagedCli, readDataVersion, timonVersion, writeDataVersion } from './data-version.js';
import { createGenericHost } from './host/generic.js';
import { tightenToOwner } from './host/owner-only.js';
import { copyTree } from './tree-copy.js';
import { TIMON_HOME, ZONES, AGENT_ARCHIVE_FILES, expandPath } from './paths.js';
import { rewriteAbsolutePaths } from './portability.js';

export const EXPORT_MANIFEST_VERSION = 1;

export type ExportManifest = {
  version: number;
  exportedAt: number;
  hostname: string;
  timonVersion: string;
  profile: string;
  withArchive: boolean;
};

export type ExportResult = {
  out: string;
  bytes: number;
  manifest: ExportManifest;
  /** Number of absolute paths rewritten as `~`. */
  rewritten: number;
};

function tar(args: string[]): void {
  let r;
  try {
    // The generic adapter, not `getHost()`: `host/index` pulls in `db.ts`, which
    // opens timon.db when it loads and never closes it. Windows then refuses to
    // replace the file for as long as this very process lives (TIM-0133). `exec`
    // is the generic one on every OS, with the same binary pins.
    r = createGenericHost(config(), {}, () => config().host.binaries).exec('tar', args);
  } catch (err) {
    throw new Error(`tar not found: ${(err as Error).message}`);
  }
  if (r.code !== 0) throw new Error(`tar failed (${r.code}): ${r.stderr.trim()}`);
}

/** Copies an entry of the config zone, leaving out the agents' logs. */
function copyConfigEntry(entry: string, from: string, to: string, withArchive: boolean): void {
  const src = join(from, entry);
  if (!existsSync(src)) return;
  const dst = join(to, entry);
  if (!statSync(src).isDirectory()) {
    cpSync(src, dst);
    return;
  }
  // copyTree, not cpSync: a plugin installed from a folder is a link
  // (junction); Windows refuses to recreate a folder link without Developer
  // Mode (EPERM) and the whole export aborted (SUG-0063).
  copyTree(src, dst, (s) => {
    if (withArchive) return true;
    // agents/<name>/memory/log.jsonl: archive disguised as config
    // (1.3 GB on the maintainer's install). The rest of memory/ leaves normally.
    return !(AGENT_ARCHIVE_FILES as readonly string[]).includes(basename(s));
  });
}

/**
 * Builds the archive. `db` is the daemon's open SQLite handle when it
 * runs; without it, the database is opened for the duration of the VACUUM.
 */
export function exportTimon(opts: {
  out: string;
  withArchive?: boolean;
  home?: string;
  profile?: string;
  vacuumInto?: (dest: string) => void;
}): ExportResult {
  const home = opts.home ?? TIMON_HOME;
  const withArchive = opts.withArchive ?? false;
  const tmp = mkdtempSync(join(tmpdir(), 'timon-export-'));
  try {
    for (const entry of ZONES.config) copyConfigEntry(entry, home, tmp, withArchive);

    // `integrations.db` first, `timon.db` last: a mission created between the
    // two copies is then in the restored `timon.db`, where `findChannelMission`
    // finds it from its receipt id, rather than a receipt pointing at a mission
    // the archive does not hold.
    for (const entry of [...ZONES.state].reverse()) {
      const dbSrc = join(home, entry);
      if (!existsSync(dbSrc)) continue;
      const dest = join(tmp, entry);
      // `vacuumInto` is the daemon's own handle on timon.db; any other base is
      // opened read-only for the time of its copy.
      if (entry === 'timon.db' && opts.vacuumInto) opts.vacuumInto(dest);
      else defaultVacuum(dbSrc, dest);
    }

    if (withArchive) {
      for (const entry of ZONES.archive) copyConfigEntry(entry, home, tmp, true);
    }

    const report = rewriteAbsolutePaths(tmp, 'export', { write: true });

    const manifest: ExportManifest = {
      version: EXPORT_MANIFEST_VERSION,
      exportedAt: Date.now(),
      hostname: hostname(),
      timonVersion: timonVersion(),
      profile: opts.profile ?? 'linux-desktop',
      withArchive,
    };
    writeFileSync(join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    tar(['-czf', opts.out, '-C', tmp, '.']);
    // The archive carries the whole database: tar wrote it with the umask (TODO #864).
    tightenToOwner(opts.out);
    return {
      out: opts.out,
      bytes: statSync(opts.out).size,
      manifest,
      rewritten: report.changes.length,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function defaultVacuum(src: string, dest: string): void {
  // Lazy import: `export.ts` is loaded by the CLI, which must not
  // open the database when it only does an import (TIM-0133: neither directly, nor
  // through one of its imports — `export.test.ts` checks it in a fresh process).
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  const handle = new Database(src, { readonly: true });
  try {
    handle.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  } finally {
    handle.close();
  }
}

const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs a filesystem operation, retrying on the transient lock errors Windows
 * raises when an antivirus, an indexer or a dying daemon still holds a handle
 * on the file (TIM-0041). Any other error is not transient and goes up.
 */
function retryBusy<T>(op: () => T, attempts = 8): T {
  for (let i = 0; ; i++) {
    try {
      return op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!BUSY_CODES.has(code) || i >= attempts - 1) throw err;
      sleepSync(100 * 2 ** i);
    }
  }
}

export type ReplaceOps = {
  remove: (path: string) => void;
  moveAside: (path: string, to: string) => void;
};

const defaultReplaceOps: ReplaceOps = {
  remove: (path) => retryBusy(() => rmSync(path, { recursive: true, force: true })),
  moveAside: (path, to) => renameSync(path, to),
};

function errDetail(err: unknown): string {
  const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
  const message = err instanceof Error ? err.message : String(err);
  return `${code}: ${message}`;
}

/**
 * EBUSY is a real lock (daemon, antivirus). EPERM/EACCES are access refusals —
 * ACLs or owner inherited from another Windows account, read-only attribute —
 * which "locked by another process" misdiagnosed (TIM-0110).
 */
function replaceFailure(path: string, removeErr: unknown, renameErr: unknown): Error {
  const removeCode = (removeErr as NodeJS.ErrnoException).code ?? '';
  const renameCode = (renameErr as NodeJS.ErrnoException).code ?? '';
  const locked = removeCode === 'EBUSY' || renameCode === 'EBUSY';
  const hint = locked
    ? 'Another process still holds it (Timon itself, an antivirus or a sync tool): quit Timon from the tray or menu bar, run `timon service uninstall`, retry the import, then `timon service install`.'
    : `Access to it is refused, which is a permissions problem rather than a lock: check the owner and ACL of the Timon data folder (Windows: \`icacls <folder>\`, \`takeown /f <folder> /r /d y\`), or import into a new folder with \`--to\`.`;
  return new Error(
    `cannot replace ${path} (remove ${errDetail(removeErr)}; rename ${errDetail(renameErr)}). ${hint}`,
    { cause: renameErr },
  );
}

/** Removes `path`; when it stays busy, moves it aside so the restore can proceed. */
export function removeOrMoveAside(path: string, ops: ReplaceOps = defaultReplaceOps): void {
  if (!existsSync(path)) return;
  try {
    ops.remove(path);
  } catch (err) {
    if (!BUSY_CODES.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
    try {
      ops.moveAside(path, `${path}.replaced-${Date.now()}`);
    } catch (renameErr) {
      throw replaceFailure(path, err, renameErr);
    }
  }
}

/** SQLite side files of the databases being replaced: kept, they would be
 *  replayed over the restored database and corrupt it. */
const isStateEntry = (entry: string): boolean => (ZONES.state as readonly string[]).includes(entry);
const dbSideFiles = (entry: string): string[] =>
  isStateEntry(entry) ? [`${entry}-wal`, `${entry}-shm`, `${entry}-journal`] : [];

export type ImportResult = {
  to: string;
  manifest: ExportManifest;
  restored: number;
  /** What the target machine must redo by hand. */
  todo: string[];
  /** Projects of the archive left out by `skipProjects` (rows of the table). */
  skippedProjects: number;
  /** Restored projects whose `cwd` folder does not exist on this machine. */
  missingProjects: { slug: string; cwd: string }[];
};

const IMPORT_TODO = [
  'sign the backend CLIs in again (`claude`, `codex`): their tokens are not exported',
  'put `~/.timon/secrets.env` back (API keys): never included in an archive',
  'copy the secrets vault key from the old machine (`~/.timon/secret-key`, or its OS keyring entry) or enter the vault values again (API keys, headers of remote MCP servers): the archive carries them sealed, never the key that opens them',
  'check `timon.config.json`: `daemon.installDir` and `workspacesRoot` may point elsewhere on this machine',
];

type ProjectRow = { slug: string; cwd: string | null };

/**
 * Runs `op` on the staged copy of the database. Returns null when the staged
 * file is absent, is not a SQLite database, or has no `projects` table (an
 * archive older than the table): there is then nothing to read or purge.
 */
function withStagedDb<T>(
  file: string,
  op: (db: { prepare(sql: string): { all(): unknown[]; run(): { changes: number } } }) => T,
): T | null {
  if (!existsSync(file)) return null;
  const require = createRequire(import.meta.url);
  const Database = require('better-sqlite3');
  let handle;
  try {
    handle = new Database(file);
  } catch (err) {
    if ((err as { code?: string }).code === 'SQLITE_NOTADB') return null;
    throw err;
  }
  try {
    return op(handle);
  } catch (err) {
    if (/no such table/i.test((err as Error).message)) return null;
    if ((err as { code?: string }).code === 'SQLITE_NOTADB') return null;
    throw err;
  } finally {
    handle.close();
  }
}

/**
 * Restores an archive into `to`. Refuses a non-empty folder without `--force`:
 * overwriting an inhabited `~/.timon` is irreversible.
 */
export function importTimon(opts: {
  file: string;
  to?: string;
  force?: boolean;
  /** Do not restore the projects: drop `projects/` and the projects table. */
  skipProjects?: boolean;
  replaceOps?: ReplaceOps;
}): ImportResult {
  const to = opts.to ?? TIMON_HOME;
  if (!existsSync(opts.file)) throw new Error(`archive not found: ${opts.file}`);

  if (existsSync(to)) {
    const existing = readdirSync(to);
    if (existing.length && !opts.force) {
      throw new Error(
        `${to} is not empty (${existing.length} entries) — run again with --force to overwrite`,
      );
    }
  } else {
    mkdirSync(to, { recursive: true });
  }

  // Extract elsewhere first: an unknown manifest must not have
  // written anything into the destination.
  const staging = mkdtempSync(join(tmpdir(), 'timon-import-'));
  try {
    tar(['-xzf', opts.file, '-C', staging]);

    const manifestFile = join(staging, 'manifest.json');
    if (!existsSync(manifestFile)) throw new Error('invalid archive: manifest.json missing');
    const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as ExportManifest;
    if (manifest.version !== EXPORT_MANIFEST_VERSION) {
      throw new Error(
        `unsupported archive version: ${manifest.version} (expected ${EXPORT_MANIFEST_VERSION})`,
      );
    }

    rewriteAbsolutePaths(staging, 'import', { write: true });

    const stagedDb = join(staging, 'timon.db');
    let skippedProjects = 0;
    let missingProjects: { slug: string; cwd: string }[] = [];
    if (opts.skipProjects) {
      // Purged on the staging copy so a failure leaves the destination untouched.
      rmSync(join(staging, 'projects'), { recursive: true, force: true });
      skippedProjects = withStagedDb(stagedDb, (db) => db.prepare('DELETE FROM projects').run().changes) ?? 0;
    } else {
      const rows = (withStagedDb(stagedDb, (db) => db.prepare('SELECT slug, cwd FROM projects').all()) ?? []) as ProjectRow[];
      missingProjects = rows
        .filter((r): r is { slug: string; cwd: string } => !!r.cwd && !existsSync(expandPath(r.cwd)))
        .map((r) => ({ slug: r.slug, cwd: r.cwd }));
    }

    let restored = 0;
    // The databases go first: they are what a running Timon holds, and a refusal
    // must come before the rest of the destination has been replaced.
    const entries = readdirSync(staging).sort((a, b) => Number(isStateEntry(b)) - Number(isStateEntry(a)));
    for (const entry of entries) {
      if (entry === 'manifest.json') continue;
      const dst = join(to, entry);
      // Replace, never merge: a merge keeps the new install's own `_main`
      // next to the imported orchestrator, which then turns into a secondary
      // agent (TIM-0040).
      removeOrMoveAside(dst, opts.replaceOps);
      for (const side of dbSideFiles(entry)) removeOrMoveAside(join(to, side), opts.replaceOps);
      retryBusy(() => copyTree(join(staging, entry), dst));
      restored++;
    }
    // Skipping the projects replaces the destination's own like everything else.
    if (opts.skipProjects) removeOrMoveAside(join(to, 'projects'), opts.replaceOps);

    // Without a recorded version, an existing database reads as the legacy 0.1.0
    // install and the next start would ask to approve an update nobody made.
    if (packagedCli() && readDataVersion(to) === null) writeDataVersion(to, timonVersion());

    return { to, manifest, restored, todo: IMPORT_TODO, skippedProjects, missingProjects };
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
