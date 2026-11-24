/**
 * The `script` action (TODO #421): a trigger runs a program on the host, with
 * no agent and no model — a tick costs no token. Meant for a deterministic job
 * on a short cadence (a watcher every five minutes) that wakes an agent only
 * when there is something to do, for instance by running `timon task create`
 * itself.
 *
 * `runActions` is synchronous, so the action only starts the process and
 * answers with a run id; the outcome (exit code, duration, end of output) is a
 * second journal entry, keyed `script:<run id>`, written when the process ends.
 *
 * What protects the host:
 *  - the action needs `scripts:run`, which no mission token holds, and an
 *    agent is refused outright (`plugins-bundled/triggers/routes.ts`);
 *  - argv, no shell, nothing from a payload;
 *  - `cwd` inside a registered project, symlinks resolved, at every run;
 *  - the local files the command runs fingerprinted when a person saves or
 *    re-approves the trigger, and checked again before every run: a project
 *    folder is one missions write in, so a file rewritten since, or a trigger
 *    saved before this check existed, is refused until a person approves it;
 *  - an environment built from the system whitelist plus the vault secrets it
 *    names — never the daemon's own environment (`secrets/env.ts`);
 *  - a time limit that kills the whole process tree, a bounded output tail,
 *    no overlap by default, a global ceiling on concurrent runs, and the
 *    trigger switched off after consecutive failures.
 */
import { daemonMessage, type DaemonMessage } from '../daemon-message.js';
import { randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { db, dbApi } from '../db.js';
import { getHost } from '../host/index.js';
import { stopProcessGroup } from '../host/kill-tree.js';
import { createNotification } from '../notifications.js';
import { TIMON_HOME } from '../paths.js';
import { secretsEnvFor, systemEnv } from '../secrets/env.js';
import { redactDeep } from '../secrets/redact.js';
import { scriptPreviews } from '../script-preview.js';
import { projectFromRegisteredCwd } from '../task-project.js';
import { SCRIPT_DEFAULT_TIMEOUT_S, type TriggerAction } from './schema.js';
import { disableTriggerRow, getScriptPins, recordDelivery, type ScriptPin, type Trigger } from './store.js';

export type ScriptAction = Extract<TriggerAction, { type: 'script' }>;

/** Characters of each stream kept for the journal and the alert. */
export const SCRIPT_TAIL_CHARS = 2000;
/** Characters of each stream held in memory while it runs; the rest is dropped. */
const BUFFER_CHARS = 64 * 1024;
/** Runs of every trigger at once: beyond, a tick is skipped. */
export const MAX_CONCURRENT_SCRIPTS = 8;
/** Consecutive failed runs after which the trigger is switched off. */
export const SCRIPT_DISABLE_AFTER = 5;
/** Between the polite stop and the forced one, once the time limit is hit. */
const KILL_GRACE_MS = 5_000;

type Running = { child: ChildProcess; triggerId: string };
const running = new Map<string, Running>();
/** `trigger id#action index` of the runs in progress, for `overlap: skip`. */
const busy = new Set<string>();

export type ScriptPlace = { cwd: string; project: string; root: string };

/**
 * Real path of `cwd`, the project that contains it and that project's real
 * root, or why not. Both sides resolved: a symlink inside a project must not
 * lead out of it, and a project registered through a symlink still matches.
 */
export function scriptCwd(cwd: string): ScriptPlace | { error: string } {
  if (!isAbsolute(cwd)) return { error: 'cwd: an absolute path' };
  let real: string;
  try { real = realpathSync(cwd); } catch { return { error: `cwd not found: ${cwd}` }; }
  const roots = dbApi.listProjectRows().flatMap((row) => {
    if (!row.cwd) return [];
    try { return [{ slug: row.slug, cwd: realpathSync(row.cwd) }]; } catch { return []; }
  });
  const project = projectFromRegisteredCwd(real, roots);
  const root = roots.find((row) => row.slug === project)?.cwd;
  return project && root ? { cwd: real, project, root } : { error: `cwd is not inside a registered project: ${cwd}` };
}

// ── approval ─────────────────────────────────────────────────────────────────

/** What a refused run tells the user to do. */
function reapprove(triggerId: string): string {
  return `a person re-approves it with \`timon trigger approve-script ${triggerId}\`, or by saving it again on the Triggers page`;
}

function quote(word: string): string {
  return `'${word.split("'").join("'\\''")}'`;
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export type ScriptFingerprint = Pick<ScriptPin, 'root' | 'real_cwd' | 'state' | 'files'>;

/** What decides which files run: the program, its argv and the folder, as saved. */
export type ScriptRun = { command: string; args?: readonly string[]; cwd: string };

/**
 * The local files the action runs, read the way a permission card reads a
 * shell command (`script-preview.ts`): the program when it is a path, the file
 * an interpreter or a shell is handed, an npm script, a make target, each with
 * its SHA-256 (or `absent`, so a file that appears later is a change too). The
 * argv is quoted into one line run from `cwd`, with the whole project as the
 * readable folder: a script beside `cwd` is a project file all the same. An
 * installed program outside the project is not read. Something that cannot be
 * fingerprinted (outside the project, behind a link leading out, too large,
 * `$VAR` in a path) is an error: nobody can vouch for it.
 */
export function fingerprintScript(action: Pick<ScriptRun, 'command' | 'args'>, place: ScriptPlace): ScriptFingerprint | { error: string } {
  // A case-folded registration (Windows, macOS) may not contain `cwd` lexically: read from `cwd` alone then.
  const root = inside(place.root, place.cwd) ? place.root : place.cwd;
  const line = `cd ${quote(place.cwd)} && ${[action.command, ...(action.args ?? [])].map(quote).join(' ')}`;
  let read: ReturnType<typeof scriptPreviews>;
  try {
    read = scriptPreviews(line, root);
  } catch (err) {
    return { error: `what it runs cannot be read: ${(err as Error).message}` };
  }
  if (read.state === null) {
    const why = read.previews.filter((p) => !['ok', 'binary', 'missing'].includes(p.status))
      .map((p) => `${p.path} (${p.status.replace('_', ' ')})`);
    return { error: `what it runs cannot be fingerprinted: ${why.length ? why.join(', ') : 'too many files'}` };
  }
  return { root, real_cwd: place.cwd, state: read.state, files: read.checks.map((check) => ({ path: check.path, state: check.state })) };
}

/** Same program, argv and folder: what decides which files run. */
function sameRun(a: ScriptRun, b: ScriptRun): boolean {
  return a.command === b.command && a.cwd === b.cwd && JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? []);
}

/** The approval recorded for this program, argv and folder, if any. */
export function pinFor(pins: readonly ScriptPin[], run: ScriptRun): ScriptPin | undefined {
  return pins.find((pin) => sameRun(pin, run));
}

/** The approval of `run` as its files are now, or why it cannot be given. */
export function pinScript(run: ScriptRun, place: ScriptPlace, now: number = Date.now()): ScriptPin | { error: string } {
  const read = fingerprintScript(run, place);
  if ('error' in read) return read;
  return { command: run.command, args: [...(run.args ?? [])], cwd: run.cwd, ...read, approved_at: now };
}

/**
 * The fingerprint of every script action, taken now: what a person's save or
 * re-approval records. `stored`: what the trigger held before this save. An
 * action left as it was whose files cannot be read today keeps the approval
 * it had, or stays without one (a folder gone must not stop a rename, and its
 * runs are refused either way); a new or changed one that cannot be read is
 * refused.
 */
export function pinScripts(
  actions: readonly TriggerAction[],
  stored: { actions: readonly TriggerAction[]; pins: readonly ScriptPin[] } = { actions: [], pins: [] },
  now: number = Date.now(),
): { pins: ScriptPin[] } | { error: string } {
  const pins: ScriptPin[] = [];
  for (const action of actions) {
    if (action.type !== 'script') continue;
    const place = scriptCwd(action.cwd);
    const read = 'error' in place ? place : pinScript(action, place, now);
    if ('error' in read) {
      if (stored.actions.some((old) => old.type === 'script' && sameRun(old, action))) {
        const old = pinFor(stored.pins, action);
        if (old) pins.push(old);
        continue;
      }
      return { error: `script ${action.command}: ${read.error}` };
    }
    pins.push(read);
  }
  return { pins };
}

/** The files whose state differs between the approval and now. */
function changedFiles(before: ScriptPin['files'], after: ScriptPin['files']): string[] {
  const was = new Map(before.map((file) => [file.path, file.state]));
  const is = new Map(after.map((file) => [file.path, file.state]));
  const paths = new Set([...was.keys(), ...is.keys()]);
  return [...paths].filter((path) => was.get(path) !== is.get(path)).sort();
}

/**
 * Why this run must not start, or null: no approval recorded (a trigger saved
 * before the check existed is not vouched for by what happens to be on disk
 * now), its files changed since, or they can no longer be fingerprinted.
 */
export function scriptApprovalProblem(triggerId: string, action: ScriptAction, place: ScriptPlace): string | null {
  return scriptPinProblem(getScriptPins(triggerId), action, place, reapprove(triggerId));
}

/**
 * The check behind `scriptApprovalProblem`, on approvals kept elsewhere
 * (a workflow's script nodes). `hint`: how a person approves it again.
 */
export function scriptPinProblem(pins: readonly ScriptPin[], run: ScriptRun, place: ScriptPlace, hint: string): string | null {
  const pin = pinFor(pins, run);
  if (!pin) return `script not approved: ${hint}`;
  const now = fingerprintScript(run, place);
  if ('error' in now) return `script cannot be checked since it was approved (${now.error}): ${hint}`;
  if (now.root !== pin.root || now.real_cwd !== pin.real_cwd) return `script folder moved since it was approved: ${hint}`;
  if (now.state !== pin.state) {
    const changed = changedFiles(pin.files, now.files);
    return `script changed since it was approved${changed.length ? ` (${changed.join(', ')})` : ''}: ${hint}`;
  }
  return null;
}

/**
 * Where a trigger's scripts stand, as the Triggers page shows it: `approved`
 * when every script would pass `scriptApprovalProblem` now, `unapproved` when
 * one has no approval recorded, `changed` when one no longer matches it (files
 * rewritten, folder moved or gone, unreadable). Null: no script action.
 */
export type ScriptApprovalState = 'approved' | 'unapproved' | 'changed';

export function scriptApprovalState(
  actions: readonly TriggerAction[], pins: readonly ScriptPin[],
): ScriptApprovalState | null {
  const scripts = actions.filter((action): action is ScriptAction => action.type === 'script');
  if (!scripts.length) return null;
  let changed = false;
  for (const action of scripts) {
    const pin = pinFor(pins, action);
    if (!pin) return 'unapproved';
    if (changed) continue;
    const place = scriptCwd(action.cwd);
    const now = 'error' in place ? place : fingerprintScript(action, place);
    changed = 'error' in now || now.root !== pin.root || now.real_cwd !== pin.real_cwd || now.state !== pin.state;
  }
  return changed ? 'changed' : 'approved';
}

/** The executable as written, a path relative to `cwd` made absolute. */
function executable(command: string, cwd: string): string {
  if (isAbsolute(command)) return command;
  return command.includes('/') || command.includes(sep) ? resolve(cwd, command) : command;
}

/** Literal replacement of every injected value, then the known token shapes. */
export function scrubOutput(text: string, secrets: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(secrets)) {
    if (value.length > 0) out = out.split(value).join(`[secret ${name}]`);
  }
  return redactDeep(out);
}

function tail(text: string, max: number = SCRIPT_TAIL_CHARS): string {
  return text.length > max ? `…${text.slice(text.length - max)}` : text;
}

/** What the dry run shows: the command, never a secret value. */
export function scriptPreview(action: ScriptAction): Record<string, unknown> {
  return {
    type: 'script', command: action.command, args: action.args ?? [], cwd: action.cwd, env: action.env ?? [],
    timeout_s: action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S, overlap: action.overlap ?? 'skip',
    notify_on_failure: action.notify_on_failure ?? true,
  };
}

export type ScriptResult = {
  run_id: string;
  code: number | null;
  signal: string | null;
  timed_out: boolean;
  duration_ms: number;
  stdout_tail: string;
  stderr_tail: string;
};

/** True when the last `SCRIPT_DISABLE_AFTER` finished runs of the trigger all failed. */
function failingStreak(triggerId: string): boolean {
  const rows = db.prepare(
    `SELECT status FROM trigger_deliveries WHERE trigger_id = ? AND delivery_key LIKE 'script:%' ORDER BY id DESC LIMIT ?`,
  ).all(triggerId, SCRIPT_DISABLE_AFTER) as { status: string }[];
  return rows.length >= SCRIPT_DISABLE_AFTER && rows.every((row) => row.status === 'error');
}

function alert(trigger: Trigger, title: string, body: string, message: DaemonMessage): void {
  try {
    // `trigger:<id>` as source: an event trigger never fires on its own alerts.
    createNotification({ type: 'alert', title, body, ownerUserId: trigger.ownerUserId, source: `trigger:${trigger.id}`, message });
  } catch (err) {
    console.warn(`[triggers] script alert for ${trigger.id} not sent: ${(err as Error).message}`);
  }
}

/** The reason journaled by the last finished run of the trigger. */
function lastScriptReason(triggerId: string): string | null {
  const row = db.prepare(
    `SELECT reason FROM trigger_deliveries WHERE trigger_id = ? AND delivery_key LIKE 'script:%' ORDER BY id DESC LIMIT 1`,
  ).get(triggerId) as { reason: string | null } | undefined;
  return row?.reason ?? null;
}

/**
 * `unapproved`: the run was refused before it started, because its files are
 * not the ones a person approved. The user is told even when failure alerts
 * are off — only they can approve — but once, not at every tick.
 */
function finish(trigger: Trigger, action: ScriptAction, result: ScriptResult, error: string | null, unapproved = false): void {
  const reason = error ? (unapproved ? error : `script: ${error}`) : `script: exit code 0 in ${result.duration_ms} ms`;
  const repeated = unapproved && lastScriptReason(trigger.id) === reason;
  recordDelivery({
    triggerId: trigger.id, status: error ? 'error' : 'received', deliveryKey: `script:${result.run_id}`,
    reason,
    result: { type: 'script', ...result },
  });
  if (!error) return;
  if (unapproved) {
    if (!repeated) alert(trigger, `Script not run: ${trigger.name}`, error, daemonMessage('trigger_script_not_run', { name: trigger.name, error }));
  } else if (action.notify_on_failure !== false) {
    const output = [result.stderr_tail, result.stdout_tail].filter(Boolean).join('\n\n');
    alert(trigger, `Script failed: ${trigger.name}`, `${error}${output ? `\n\n${tail(output, SCRIPT_TAIL_CHARS)}` : ''}`,
      daemonMessage('trigger_script_failed', { name: trigger.name, error, output: output ? tail(output, SCRIPT_TAIL_CHARS) : 'none' }));
  }
  if (failingStreak(trigger.id) && disableTriggerRow(trigger.id)) {
    alert(trigger, `Trigger switched off: ${trigger.name}`,
      `Its script failed ${SCRIPT_DISABLE_AFTER} times in a row. Fix it, then switch the trigger back on.`,
      daemonMessage('trigger_switched_off', { name: trigger.name, times: SCRIPT_DISABLE_AFTER }));
  }
}

/**
 * Starts one run and returns its id, or `null` when it is skipped (previous run
 * still going, or the concurrency ceiling reached). Never throws for a run that
 * cannot start: that failure is journaled like any other, so it counts toward
 * the switch-off and raises the same alert.
 */
export function startScript(trigger: Trigger, action: ScriptAction, index: number): string | null {
  const key = `${trigger.id}#${index}`;
  if ((action.overlap ?? 'skip') === 'skip' && busy.has(key)) return null;
  if (running.size >= MAX_CONCURRENT_SCRIPTS) return null;
  const runId = randomUUID();
  const startedAt = Date.now();
  const empty = (error: string, unapproved = false): void => {
    setImmediate(() => finish(trigger, action, {
      run_id: runId, code: null, signal: null, timed_out: false, duration_ms: 0, stdout_tail: '', stderr_tail: '',
    }, error, unapproved));
  };
  const place = scriptCwd(action.cwd);
  if ('error' in place) { empty(place.error); return runId; }
  // Checked right before the spawn, in the same tick: what runs is what was read.
  const unapproved = scriptApprovalProblem(trigger.id, action, place);
  if (unapproved) { empty(unapproved, true); return runId; }
  const granted = secretsEnvFor({ project: place.project });
  const missing = (action.env ?? []).filter((name) => !Object.hasOwn(granted, name));
  if (missing.length) { empty(`secret not granted to project ${place.project}: ${missing.join(', ')}`); return runId; }
  const secrets = Object.fromEntries((action.env ?? []).map((name) => [name, granted[name]!]));
  const env: NodeJS.ProcessEnv = { ...systemEnv(), TIMON_HOME, ...secrets };

  let child: ChildProcess;
  try {
    child = getHost().spawn(executable(action.command, place.cwd), action.args ?? [], {
      cwd: place.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      // Its own process group off Windows, so the time limit reaches what it started.
      detached: process.platform !== 'win32',
    });
  } catch (err) {
    empty(`could not start: ${(err as Error).message}`);
    return runId;
  }
  busy.add(key);
  running.set(runId, { child, triggerId: trigger.id });
  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout = (stdout + chunk).slice(-BUFFER_CHARS); });
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-BUFFER_CHARS); });

  let timedOut = false;
  let forced: NodeJS.Timeout | null = null;
  const timeoutMs = (action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S) * 1000;
  const timer = setTimeout(() => {
    timedOut = true;
    stopProcessGroup(child, 'SIGTERM');
    forced = setTimeout(() => {
      stopProcessGroup(child, 'SIGKILL');
      // A detached grandchild may hold the pipes open, and `close` never comes:
      // the run ends here anyway, or every later tick would be skipped.
      child.stdout?.destroy();
      child.stderr?.destroy();
      settle(null, 'SIGKILL', null);
    }, KILL_GRACE_MS);
    forced.unref();
  }, timeoutMs);
  timer.unref();

  let settled = false;
  const settle = (code: number | null, signal: string | null, startError: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forced) clearTimeout(forced);
    busy.delete(key);
    running.delete(runId);
    const result: ScriptResult = {
      run_id: runId, code, signal, timed_out: timedOut, duration_ms: Date.now() - startedAt,
      // Scrubbed on the whole buffer, then cut: a value is never split by the cut.
      stdout_tail: tail(scrubOutput(stdout, secrets)),
      stderr_tail: tail(scrubOutput(stderr, secrets)),
    };
    const error = startError
      ?? (timedOut ? `timed out after ${action.timeout_s ?? SCRIPT_DEFAULT_TIMEOUT_S} s`
        : code !== 0 ? (signal ? `killed by ${signal}` : `exit code ${code}`) : null);
    try {
      finish(trigger, action, result, error);
    } catch (err) {
      console.error(`[triggers] script journal of ${trigger.id} failed:`, (err as Error).message);
    }
  };
  child.on('error', (err) => settle(null, null, `could not start: ${scrubOutput(err.message, secrets)}`));
  child.on('close', (code, signal) => settle(code, signal, null));
  return runId;
}

/** Plugin dispose: what still runs is stopped, and journaled by its own `close`. */
export function stopScripts(): void {
  for (const { child } of running.values()) stopProcessGroup(child, 'SIGTERM');
}

/** Tests: runs in progress. */
export function runningScripts(): number {
  return running.size;
}
