/**
 * Recurring routines. A routine = (cron expression, agent, prompt,
 * task type) which, on each due tick, creates a standard **Kanban task**.
 *
 * Deliberately minimal: the routine does not spawn the agent itself;
 * it just injects the task into the Kanban and lets the dispatcher
 * do its job. Advantage: each run keeps a persistent trace
 * in the Kanban (audit, retry possible if BLOCKED, link
 * to the mission, etc.) — exactly what the user asked for:
 * "on each launch the routine creates the task in the Kanban before
 * running it so that we keep a trace".
 *
 * Exception: the built-in routine `timon-backup-nightly` (step 4.6).
 * It calls `exportTimon` in-process — spawning an LLM every night
 * to run `tar` would burn quota and miss the slot. The
 * trace is the archive under `$TIMON_HOME/backups/`.
 *
 * Tick interval: 30s by default. A due routine runs only
 * once per tick: next_run_at is computed before creating the task,
 * so two coinciding ticks do not recreate the same task.
 */
import { daemonMessage, type DaemonMessage } from './daemon-message.js';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CronExpressionParser } from 'cron-parser';
import { db, dbApi, type RoutineExtras, type RoutineRow, type TaskType } from './db.js';
import { exportTimon, type ExportResult } from './export.js';
import { bus } from './bus.js';
import { closePushForAnchor, createNotification } from './notifications.js';
import { TIMON_HOME } from './paths.js';
import { settingInt } from './settings.js';
import { formatBytes, freeBytes } from './storage-failure.js';
import { scheduleCadenceProblem } from './triggers/schema.js';
import { recordDelivery } from './triggers/store.js';
import { assertSpawnAllowed } from './plugins/policy.js';
import { PLUGIN_OWNER_PREFIX } from './users/api-tokens.js';
import type { BackupArchive } from './plugins/contract/backup.js';
export type { BackupArchive } from './plugins/contract/backup.js';

const TICK_INTERVAL_MS = 30_000;

export type CreateRoutineInput = {
  name: string;
  agent_name: string;
  prompt: string;
  task_type?: TaskType;
  cron_expr: string;
  enabled?: boolean;
  project?: string | null;
  /** The account creating it; its tasks and missions run on its behalf. */
  ownerUserId?: string | null;
} & RoutineExtras;

/** A stored extras list, read as none when it is missing or malformed. */
function storedList(raw: string | null): string[] {
  try {
    const value: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What a routine copies onto each task it opens. A task starts with zero MCP
 * server by default (only its role's and its own extras): the routine carries
 * the extras its agent needs at every run, rather than a person adding them to
 * each task by hand. The agent's own config is never inherited silently.
 */
export function routineTaskExtras(r: Pick<RoutineRow, keyof RoutineExtras>): {
  extraSkills: string[]; extraMcpServers: string[]; extraAllowedTools: string[];
} {
  return {
    extraSkills: storedList(r.extra_skills),
    extraMcpServers: storedList(r.extra_mcp_servers),
    extraAllowedTools: storedList(r.extra_allowed_tools),
  };
}

/** Computes the next tick of a cron expression. Throws if invalid. */
export function nextRunFromCron(expr: string, from: Date = new Date()): number {
  const it = CronExpressionParser.parse(expr, { currentDate: from });
  return it.next().getTime();
}

export function validateCron(expr: string): void {
  // Run and discard — if invalid, parse throws a readable error.
  CronExpressionParser.parse(expr);
  // Called on writes only (a routine re-read is never re-checked), hence the floor here.
  const tooOften = scheduleCadenceProblem(expr);
  if (tooOften) throw new Error(tooOften);
}

export function createRoutine(input: CreateRoutineInput): RoutineRow {
  validateCron(input.cron_expr);
  const id = randomUUID();
  const enabled = input.enabled ?? true;
  const nextAt = enabled ? nextRunFromCron(input.cron_expr) : null;
  dbApi.createRoutine({
    id,
    name: input.name,
    agent_name: input.agent_name,
    prompt: input.prompt,
    task_type: input.task_type ?? 'chore',
    cron_expr: input.cron_expr,
    enabled: enabled ? 1 : 0,
    project: input.project ?? null,
    owner_user_id: input.ownerUserId ?? null,
    extra_skills: input.extra_skills ?? null,
    extra_mcp_servers: input.extra_mcp_servers ?? null,
    extra_allowed_tools: input.extra_allowed_tools ?? null,
    last_run_at: null,
    next_run_at: nextAt,
  });
  const row = dbApi.getRoutine(id);
  if (!row) throw new Error('routine vanished post-insert');
  return row;
}

export function updateRoutine(
  id: string,
  fields: Partial<Omit<CreateRoutineInput, 'cron_expr'>> & { cron_expr?: string },
): RoutineRow {
  const row = dbApi.getRoutine(id);
  if (!row) throw new Error(`routine not found: ${id}`);
  // If the cron or enabled is touched, recompute next_run_at.
  let nextAt: number | null | undefined;
  const willBeEnabled = fields.enabled === undefined ? row.enabled === 1 : fields.enabled;
  const willBeCron = fields.cron_expr ?? row.cron_expr;
  // A cron kept as it was is not re-checked: a routine saved before the floor
  // must stay renamable and switchable off — not back on.
  const switchedOn = row.enabled !== 1 && willBeEnabled;
  if ((fields.cron_expr && fields.cron_expr !== row.cron_expr) || switchedOn) validateCron(willBeCron);
  if (fields.cron_expr !== undefined || fields.enabled !== undefined) {
    nextAt = willBeEnabled ? nextRunFromCron(willBeCron) : null;
  }
  dbApi.updateRoutine(id, {
    name: fields.name,
    agent_name: fields.agent_name,
    prompt: fields.prompt,
    task_type: fields.task_type,
    cron_expr: fields.cron_expr,
    enabled: fields.enabled,
    project: fields.project,
    extra_skills: fields.extra_skills,
    extra_mcp_servers: fields.extra_mcp_servers,
    extra_allowed_tools: fields.extra_allowed_tools,
    next_run_at: nextAt,
  });
  return dbApi.getRoutine(id)!;
}

/** Stable id: `timon backup enable` is idempotent, not a new UUID. */
export const BACKUP_ROUTINE_ID = 'timon-backup-nightly';
export const BACKUP_CRON = '30 3 * * *';
/** Default of `TIMON_BACKUP_KEEP`; the setting decides (`backupRetention`). */
export const BACKUP_KEEP = 7;
export const BACKUP_NAME = 'Backup nocturne';
/** Schema sentinel — never dispatched, the tick runs the export itself. */
export const BACKUP_AGENT = 'timon';
const BACKUP_PROMPT =
  'timon export --out ~/.timon/backups/timon-<date>.tar.gz every night at 03:30, '
  + 'then prune by TIMON_BACKUP_KEEP and TIMON_BACKUP_MAX_AGE_DAYS.';
const BACKUP_ARCHIVE_RE = /^timon-(\d{4})-(\d{2})-(\d{2})\.tar\.gz$/;
/**
 * An export is written under this suffix and renamed once complete: a `tar`
 * cut short by a full disk must never carry the archive's name, or it would
 * count as the newest backup and push valid ones out of the kept window.
 */
export const BACKUP_PARTIAL_SUFFIX = '.partial';
/** Database snapshots taken by hand before a rebuild (`VACUUM INTO`), several GB each. */
const PRE_REBUILD_RE = /^pre-rebuild-(\d{4})-(\d{2})-(\d{2})\.db$/;
/** Free space asked before an export, as a multiple of the newest archive. */
export const BACKUP_SPACE_FACTOR = 1.5;
/** Consecutive failed nights before the user is alerted. */
export const BACKUP_ALERT_AFTER_FAILURES = 3;
export const BACKUP_FAILURES_KEY = 'backup.consecutive_failures';
/** One card at a time for the backup, whatever the cause. */
export const BACKUP_ALERT_ANCHOR = 'backup:nightly';
const DAY_MS = 86_400_000;

export function backupsDir(home: string = TIMON_HOME): string {
  return join(home, 'backups');
}

/** `timon-YYYY-MM-DD.tar.gz` in local date — so is the 03:30 cron. */
export function backupArchiveName(when: Date = new Date()): string {
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const d = String(when.getDate()).padStart(2, '0');
  return `timon-${y}-${m}-${d}.tar.gz`;
}

export function listBackupArchives(dir: string = backupsDir()): BackupArchive[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => BACKUP_ARCHIVE_RE.test(name))
    .sort()
    .reverse()
    .map((name) => ({ name, bytes: statSync(join(dir, name)).size }));
}

/** How many archives to keep, and past what age (0 = none) to drop them. */
export type BackupRetention = { keep: number; maxAgeDays: number };

/**
 * Read at each prune, not at boot: a value changed in Settings applies to the
 * next backup without a restart. Bounds are enforced on write; a value forced
 * out of range through the environment falls back rather than deleting every
 * archive (`keep` 0) or none.
 */
export function backupRetention(): BackupRetention {
  const keep = settingInt('TIMON_BACKUP_KEEP');
  const maxAgeDays = settingInt('TIMON_BACKUP_MAX_AGE_DAYS');
  return {
    keep: Number.isInteger(keep) && keep >= 1 ? keep : BACKUP_KEEP,
    maxAgeDays: Number.isInteger(maxAgeDays) && maxAgeDays > 0 ? maxAgeDays : 0,
  };
}

/** Local midnight of the day a file name carries (the cron is local too). */
function archiveDay(name: string, re: RegExp = BACKUP_ARCHIVE_RE): number | null {
  const m = re.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

/**
 * Keeps the `keep` newest archives (name order = date order) and drops those
 * older than `maxAgeDays`. The newest archive survives both rules: a clock set
 * wrong, or a max age shorter than the gap since the last backup, must never
 * leave the folder empty. Only complete archives count: an export in progress
 * or cut short carries `.partial` and is never one of the `keep`.
 *
 * A `pre-rebuild-<date>.db` snapshot follows the archives: it goes once `keep`
 * archives are newer than it, or once it is past `maxAgeDays` with at least
 * one newer archive. Nightly failures therefore never remove it.
 * Returns the names removed.
 */
export function pruneBackupArchives(
  dir: string = backupsDir(),
  retention: number | BackupRetention = backupRetention(),
  now: Date = new Date(),
): string[] {
  const { keep, maxAgeDays } = typeof retention === 'number' ? { keep: retention, maxAgeDays: 0 } : retention;
  const cutoff = maxAgeDays > 0 ? now.getTime() - maxAgeDays * DAY_MS : null;
  const dropped: string[] = [];
  const keptDays: number[] = [];
  listBackupArchives(dir).forEach((file, index) => {
    const day = archiveDay(file.name);
    const tooMany = index >= Math.max(1, keep);
    const tooOld = cutoff !== null && day !== null && day < cutoff;
    if (index === 0 || (!tooMany && !tooOld)) {
      if (day !== null) keptDays.push(day);
      return;
    }
    rmSync(join(dir, file.name));
    dropped.push(file.name);
  });
  const snapshots = existsSync(dir) ? readdirSync(dir).filter((n) => PRE_REBUILD_RE.test(n)) : [];
  for (const name of snapshots) {
    const day = archiveDay(name, PRE_REBUILD_RE);
    if (day === null) continue;
    const newer = keptDays.filter((d) => d > day).length;
    const outOfWindow = newer >= Math.max(1, keep);
    const tooOld = cutoff !== null && day < cutoff && newer >= 1;
    if (!outOfWindow && !tooOld) continue;
    rmSync(join(dir, name), { force: true });
    dropped.push(name);
  }
  return dropped;
}

/** Leftovers of an export the daemon did not finish (killed, power cut). */
function removePartialArchives(dir: string): string[] {
  const partials = readdirSync(dir).filter((n) =>
    n.endsWith(BACKUP_PARTIAL_SUFFIX) && BACKUP_ARCHIVE_RE.test(n.slice(0, -BACKUP_PARTIAL_SUFFIX.length)));
  for (const name of partials) rmSync(join(dir, name), { force: true });
  return partials;
}

/** Thrown before the export when the disk cannot hold the next archive. */
export class BackupSpaceError extends Error {
  constructor(readonly needed: number, readonly free: number, readonly dir: string) {
    super(`not enough free space for the nightly backup in ${dir}: ${formatBytes(free)} free, about ${formatBytes(needed)} needed`);
    this.name = 'BackupSpaceError';
  }
}

/**
 * The next archive is about the size of the newest one; half again on top
 * leaves room for growth. No archive yet, or a filesystem that cannot tell its
 * free space: nothing to compare, the export is tried.
 */
function assertBackupSpace(dir: string, free: (dir: string) => number | null): void {
  const newest = listBackupArchives(dir)[0];
  if (!newest) return;
  const available = free(dir);
  if (available === null) return;
  const needed = Math.ceil(newest.bytes * BACKUP_SPACE_FACTOR);
  if (available < needed) throw new BackupSpaceError(needed, available, dir);
}

function backupFailureCount(): number {
  const raw = Number(dbApi.getAllSettings()[BACKUP_FAILURES_KEY] ?? 0);
  return Number.isInteger(raw) && raw > 0 ? raw : 0;
}

function hasOpenBackupAlert(): boolean {
  return dbApi.listActiveNotificationsByAnchorPrefix(BACKUP_ALERT_ANCHOR, 'alert')
    .some((n) => n.anchor === BACKUP_ALERT_ANCHOR);
}

function raiseBackupAlert(title: string, body: string, message: DaemonMessage): void {
  // A card the user has not dismissed yet is enough; a dismissed one comes back
  // the next failed night.
  if (hasOpenBackupAlert()) return;
  createNotification({ type: 'alert', title, body, source: 'backup', anchor: BACKUP_ALERT_ANCHOR, message });
}

/**
 * Every failed night counts, persisted so a restart does not reset it. A disk
 * too full is alerted at once: it will not heal by itself. Any other cause is
 * alerted from the third night in a row, so one bad night stays quiet.
 * Never throws: the caller is already handling the backup's own error.
 */
function noteBackupFailure(err: unknown): void {
  try {
    const failures = backupFailureCount() + 1;
    dbApi.setSetting(BACKUP_FAILURES_KEY, String(failures));
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof BackupSpaceError) {
      raiseBackupAlert(
        'Nightly backup skipped: disk almost full',
        `${message}. Free some space on this disk; older backups can be deleted from the backups folder.`,
        daemonMessage('backup_disk_full', { error: message }),
      );
    } else if (failures >= BACKUP_ALERT_AFTER_FAILURES) {
      raiseBackupAlert(
        `Nightly backup failed ${failures} nights in a row`,
        `Last error: ${message}. No new backup has been written since the first of these failures.`,
        daemonMessage('backup_failed_nights', { nights: failures, error: message }),
      );
    }
  } catch (noteErr) {
    console.error(`[routines] backup failure not recorded: ${(noteErr as Error).message}`);
  }
}

function noteBackupSuccess(): void {
  try {
    if (backupFailureCount() > 0) dbApi.deleteSetting(BACKUP_FAILURES_KEY);
    if (dbApi.dismissNotificationsByAnchor(BACKUP_ALERT_ANCHOR, 'alert') > 0) {
      closePushForAnchor(BACKUP_ALERT_ANCHOR);
      bus.publish({ kind: 'notifications_changed', ownerUserId: null });
    }
  } catch (err) {
    console.error(`[routines] backup success not recorded: ${(err as Error).message}`);
  }
}

export type BackupStatus = {
  enabled: boolean;
  cron: string;
  keep: number;
  /** 0 = no age limit. */
  max_age_days: number;
  dir: string;
  last_run_at: number | null;
  next_run_at: number | null;
  archives: BackupArchive[];
  routine: RoutineRow | null;
};

export function backupStatus(): BackupStatus {
  const row = dbApi.getRoutine(BACKUP_ROUTINE_ID) ?? null;
  const retention = backupRetention();
  return {
    enabled: row?.enabled === 1,
    cron: row?.cron_expr ?? BACKUP_CRON,
    keep: retention.keep,
    max_age_days: retention.maxAgeDays,
    dir: backupsDir(),
    last_run_at: row?.last_run_at ?? null,
    next_run_at: row?.next_run_at ?? null,
    archives: listBackupArchives(),
    routine: row,
  };
}

/** Idempotent: creates or re-enables the canonical 03:30 routine. */
export function enableBackupRoutine(): BackupStatus {
  const existing = dbApi.getRoutine(BACKUP_ROUTINE_ID);
  if (existing) {
    updateRoutine(BACKUP_ROUTINE_ID, {
      name: BACKUP_NAME,
      agent_name: BACKUP_AGENT,
      prompt: BACKUP_PROMPT,
      task_type: 'chore',
      cron_expr: BACKUP_CRON,
      enabled: true,
      project: null,
    });
  } else {
    validateCron(BACKUP_CRON);
    dbApi.createRoutine({
      id: BACKUP_ROUTINE_ID,
      name: BACKUP_NAME,
      agent_name: BACKUP_AGENT,
      prompt: BACKUP_PROMPT,
      task_type: 'chore',
      cron_expr: BACKUP_CRON,
      enabled: 1,
      project: null,
      last_run_at: null,
      next_run_at: nextRunFromCron(BACKUP_CRON),
    });
    if (!dbApi.getRoutine(BACKUP_ROUTINE_ID)) {
      throw new Error('backup routine vanished post-insert');
    }
  }
  mkdirSync(backupsDir(), { recursive: true });
  return backupStatus();
}

/**
 * Marker of the one-time default (TODO #476): once set, the boot never touches
 * the backup routine again. That is what tells "never configured" from "the
 * user turned it off": a routine row disabled, or deleted, after the marker
 * stays as the user left it.
 */
export const BACKUP_DEFAULT_KEY = 'backup.default_on.applied_at';

/**
 * The backup is on by default, on new installs as on existing ones. Runs at
 * every boot of the routines module and acts once: no routine row yet → it is
 * created enabled; a row already there (enabled or disabled by someone) is
 * left alone. A failure leaves the marker unset, so the next boot retries.
 */
export function applyBackupDefault(): 'created' | 'kept' | 'already' {
  if (dbApi.getAllSettings()[BACKUP_DEFAULT_KEY]) return 'already';
  const outcome = dbApi.getRoutine(BACKUP_ROUTINE_ID) ? 'kept' : 'created';
  if (outcome === 'created') enableBackupRoutine();
  dbApi.setSetting(BACKUP_DEFAULT_KEY, String(Date.now()));
  return outcome;
}

/**
 * Archive under `$TIMON_HOME/backups/` (never a test's real `~/.timon`:
 * `TIMON_HOME` is the process's). Secrets excluded, like `timon export`.
 */
export function runNightlyBackup(
  when: Date = new Date(),
  deps: { freeBytes?: (dir: string) => number | null; exportArchive?: typeof exportTimon } = {},
): ExportResult {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true });
  // `when` is the clock of this backup: the age limit counts from it.
  const prune = (): void => {
    const pruned = pruneBackupArchives(dir, backupRetention(), when);
    if (pruned.length) console.log(`[routines] backup prune: ${pruned.join(', ')}`);
  };
  const out = join(dir, backupArchiveName(when));
  const partial = `${out}${BACKUP_PARTIAL_SUFFIX}`;
  try {
    const stale = removePartialArchives(dir);
    if (stale.length) console.log(`[routines] backup: removed unfinished ${stale.join(', ')}`);
    // Before the export as well: once the disk is full no export succeeds, and a
    // prune that only followed a success would never free it again.
    prune();
    assertBackupSpace(dir, deps.freeBytes ?? freeBytes);
    let result: ExportResult;
    try {
      result = (deps.exportArchive ?? exportTimon)({
        out: partial,
        home: TIMON_HOME,
        vacuumInto: (dest) => {
          db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
        },
      });
      renameSync(partial, out);
    } catch (err) {
      rmSync(partial, { force: true });
      throw err;
    }
    noteBackupSuccess();
    prune();
    return { ...result, out };
  } catch (err) {
    noteBackupFailure(err);
    throw err;
  }
}

/**
 * Tick: for each due routine, creates a Kanban task and moves
 * next_run_at to the next occurrence of the cron. Non-fatal on an individual
 * error: log and carry on with the others.
 *
 * The backup routine opens NO task: the export runs here.
 */
export async function tickRoutines(): Promise<void> {
  const due = dbApi.listDueRoutines();
  for (const r of due) {
    const now = Date.now();
    try {
      if (r.id === BACKUP_ROUTINE_ID) {
        const result = runNightlyBackup();
        console.log(`[routines] backup ${result.out} (${result.bytes} octets)`);
        recordDelivery({ triggerId: r.id, status: 'received', reason: `backup ${result.bytes} bytes` });
      } else {
        // A plugin's routine ticks with nobody in front: each task it opens is
        // a spawn of that plugin, held to its approval and quota (TODO #591).
        // A refusal skips this tick (the catch below logs it and moves on).
        if (r.owner_user_id?.startsWith(PLUGIN_OWNER_PREFIX)) {
          assertSpawnAllowed(r.owner_user_id.slice(PLUGIN_OWNER_PREFIX.length), now, 'ctx.routines');
        }
        const taskId = randomUUID();
        dbApi.createTask(taskId, r.name, r.agent_name, {
          description: r.prompt,
          type: r.task_type,
          priority: 3,
          // The routine's creator: the task, and the mission it starts, run on
          // that account's behalf.
          ownerUserId: r.owner_user_id,
          ...routineTaskExtras(r),
        });
        dbApi.setTaskRoutine(taskId, r.id);
        console.log(`[routines] ${r.id} (${r.name}) → task ${taskId}`);
        recordDelivery({ triggerId: r.id, status: 'received', result: [{ type: 'task', ok: true, id: taskId }] });
      }
      // Moves next_run_at forward — based on "now" so that a routine
      // whose orchestrator was down does not catch up in bursts.
      let nextAt: number;
      try { nextAt = nextRunFromCron(r.cron_expr); }
      catch { nextAt = now + 60_000; /* fallback: retry in 1 min */ }
      dbApi.markRoutineRun(r.id, now, nextAt);
    } catch (err) {
      console.error(`[routines] tick failed for ${r.id}:`, (err as Error).message);
      recordDelivery({ triggerId: r.id, status: 'error', reason: (err as Error).message });
      // Move next_run_at forward anyway so as not to loop on the same
      // broken routine on every tick (30s).
      try {
        const nextAt = nextRunFromCron(r.cron_expr);
        dbApi.markRoutineRun(r.id, now, nextAt);
      } catch { /* */ }
    }
  }
}

export function startRoutines(): () => void {
  try {
    if (applyBackupDefault() === 'created') console.log('[routines] nightly backup enabled by default (03:30)');
  } catch (err) {
    console.warn(`[routines] default backup not enabled: ${(err as Error).message}`);
  }
  // Catches up NULL next_run_at from a migration from an old version,
  // or routines created without next_run_at (odd cases).
  for (const r of dbApi.listRoutines()) {
    if (r.enabled === 1 && r.next_run_at === null) {
      try {
        const nextAt = nextRunFromCron(r.cron_expr);
        dbApi.markRoutineRun(r.id, r.last_run_at ?? Date.now(), nextAt);
      } catch (err) {
        console.warn(`[routines] invalid cron for ${r.id}: ${(err as Error).message}`);
      }
    }
  }
  // First tick immediately, then the interval.
  tickRoutines().catch((err) => console.error('[routines] initial tick error:', err));
  const timer = setInterval(() => {
    tickRoutines().catch((err) => console.error('[routines] tick error:', err));
  }, TICK_INTERVAL_MS);
  console.log(`[routines] started (interval=${TICK_INTERVAL_MS}ms)`);
  return () => clearInterval(timer);
}
