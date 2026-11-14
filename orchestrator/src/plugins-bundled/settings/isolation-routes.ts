/**
 * Mission isolation, the Settings › System › Security card:
 *
 *   GET /api/admin/isolation   → `IsolationSettingsState`
 *   PUT /api/admin/isolation   { filesystem?, unixSockets?, exceptions? } → `IsolationSettingsState`
 *
 * The state is the doctor's `missionIsolation` (what a mission launched now
 * gets) next to the settings it comes from (`host.isolation.filesystem`,
 * `unixSockets`, `exceptions`). A write lands in `timon.config.json` and in
 * the live configuration: the next mission launch reads it, no restart.
 *
 * Authentication: a superadmin SIGNED IN TO THE APP, on both verbs. Never the
 * daemon token, never a mission token, even one whose launcher is a
 * superadmin: these settings are the fence of the missions themselves, and a
 * mission must not be able to read how to widen it, let alone widen it.
 * Anonymous is 401, first run included.
 */
import type { Request, Response, Router } from 'express';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CONFIG_FILE, config, setConfig } from '../../config/load.js';
import { FenceExceptionSchema, FencePathSchema, type TimonConfig } from '../../config/schema.js';
import { missionIsolationNow } from '../../doctor.js';
import { isFenceSegment } from '../../host/isolation.js';
import type { DoctorReport } from '../../plugins/contract/system.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, isPersonAuth } from '../../users/identity.js';

export const ISOLATION_SETTINGS_PATH = '/api/admin/isolation';

type Isolation = TimonConfig['host']['isolation'];

export type IsolationSettingsState = {
  status: DoctorReport['missionIsolation'];
  settings: Pick<Isolation, 'filesystem' | 'unixSockets' | 'exceptions'>;
};

/** Bounds of a body: an editor sends a handful of entries, never thousands. */
const MAX_EXCEPTIONS = 256;
const MAX_PATHS = 64;
const MAX_PATH_LENGTH = 4096;

// A control character cannot be spelt in a Seatbelt profile, and a NUL ends a
// Landlock policy entry: refused here rather than dropped at launch.
const CONTROL = /[\u0000-\u001f\u007f]/;
const PathBody = FencePathSchema.refine((path) => path.length <= MAX_PATH_LENGTH && !CONTROL.test(path), {
  message: 'must be at most 4096 characters, without control characters',
});
const ExceptionBody = FenceExceptionSchema.extend({ writable: z.array(PathBody).max(MAX_PATHS).default([]) });
/** The names the fence would act on (`resolveFence` ignores any other). */
const NameKey = z.string().refine(isFenceSegment, { message: 'must be a plain agent name or project slug' });
const ExceptionMap = z.record(NameKey, ExceptionBody).refine((map) => Object.keys(map).length <= MAX_EXCEPTIONS, {
  message: `at most ${MAX_EXCEPTIONS} entries`,
});

const BodySchema = z.object({
  filesystem: z.enum(['auto', 'enforce', 'off']).optional(),
  unixSockets: z.enum(['deny', 'allow']).optional(),
  exceptions: z.object({ agents: ExceptionMap, projects: ExceptionMap }).strict().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, { message: 'nothing to change' });

type IsolationPatch = z.infer<typeof BodySchema>;

/** A superadmin person at a screen; anything else is answered and false. */
function requireAppSuperadmin(req: Request, res: Response): boolean {
  if (!req.auth) {
    res.status(401).json({ error: 'unauthorized' });
    return false;
  }
  if (!isPersonAuth(req.auth) || !req.auth.isSuperadmin) {
    forbidden(req, res, {
      kind: 'operator',
      reason: 'only a superadmin signed in to the app may read or change the mission isolation',
      hint: 'edit host.isolation in timon.config.json from a terminal',
    });
    return false;
  }
  return true;
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class IsolationConfigError extends Error {}

function readUserFile(file: string): { json: Json; raw: string | null } {
  if (!existsSync(file)) return { json: {}, raw: null };
  const raw = readFileSync(file, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IsolationConfigError('timon.config.json is not valid JSON: fix it before changing the isolation');
  }
  if (!isPlainObject(parsed)) throw new IsolationConfigError('timon.config.json must hold a JSON object');
  return { json: parsed, raw };
}

/** Same folder, then rename: neither the config watcher nor a crash ever sees half a file. */
function writeAtomically(file: string, content: string): void {
  const tmp = join(dirname(file), `.timon.config.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
}

/**
 * Writes the given keys of `host.isolation` into the user's file, every other
 * key of the file untouched, then into the live configuration. The live
 * values are the file's as written: `resolveFence` expands `~/` itself.
 */
export function writeIsolationSettings(patch: IsolationPatch, file: string = CONFIG_FILE): void {
  const { json, raw } = readUserFile(file);
  const host = isPlainObject(json.host) ? { ...json.host } : {};
  const isolation = isPlainObject(host.isolation) ? { ...host.isolation } : {};
  if (patch.filesystem !== undefined) isolation.filesystem = patch.filesystem;
  if (patch.unixSockets !== undefined) isolation.unixSockets = patch.unixSockets;
  if (patch.exceptions !== undefined) isolation.exceptions = patch.exceptions;
  host.isolation = isolation;
  const indent = raw ? (/^[{[][^\S\n]*\r?\n([ \t]+)\S/.exec(raw)?.[1] ?? 2) : 2;
  writeAtomically(file, `${JSON.stringify({ ...json, host }, null, indent)}\n`);
  if (file === CONFIG_FILE) {
    const live = config();
    setConfig({ ...live, host: { ...live.host, isolation: { ...live.host.isolation, ...patch } } });
  }
}

export function isolationSettingsState(cfg: TimonConfig = config()): IsolationSettingsState {
  const { filesystem, unixSockets, exceptions } = cfg.host.isolation;
  return { status: missionIsolationNow(cfg).report, settings: { filesystem, unixSockets, exceptions } };
}

export function registerIsolationRoutes(router: Router): void {
  router.get(ISOLATION_SETTINGS_PATH, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    res.setHeader('Cache-Control', 'no-store');
    res.json(isolationSettingsState());
  });

  router.put(ISOLATION_SETTINGS_PATH, (req, res) => {
    if (!requireAppSuperadmin(req, res)) return;
    const body = BodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      const issue = body.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
      res.status(400).json({ error: 'invalid-body', message: `${where}${issue?.message ?? 'invalid body'}` });
      return;
    }
    try {
      writeIsolationSettings(body.data);
    } catch (err) {
      if (err instanceof IsolationConfigError) {
        res.status(409).json({ error: 'config-unreadable', message: err.message });
        return;
      }
      throw err;
    }
    auditRequest(req, 'settings.isolation.update', Object.keys(body.data).sort().join(','));
    res.setHeader('Cache-Control', 'no-store');
    res.json(isolationSettingsState());
  });
}
