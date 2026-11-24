/**
 * Recordings of the built-in browser (TODO #461), stored like the browser
 * credentials (`browser-credentials.ts`): metadata in clear in `plugin_kv`,
 * steps sealed with the vault under a `@settings/` key so they follow its
 * key-loss protection and atomic rotation.
 *
 * Every write here masks again what the desktop already masked
 * (`browser-recording-rules.ts`). Reading steps is never offered to a caller
 * by id alone: the routes and the plugin facade check the profile owner, and
 * the conversion mission, before calling `readBrowserRecordingSteps`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, dbApi } from './db.js';
import { bus, type ProjectEventOrigin } from './bus.js';
import type { BrowserProfile } from './browser-profiles.js';
import { isSealed } from './secrets/box.js';
import { openWithVault, pluginKvIdentity, sealWithVault } from './secrets/store.js';
import { NativeBrowserError } from './native-browser-provider.js';
import { apiError, type ApiErrorBody } from './api-error.js';
import {
  isSecretPlaceholder, RECORDING_STEP_TYPES, RECORDING_STOP_REASONS, sanitizeRecording,
  type RecordedStep,
} from './browser-recording-rules.js';
import type { BrowserRecordingMetadata } from './plugins/contract/browser-recordings.js';
export type { BrowserRecordingExternalRef, BrowserRecordingMetadata, BrowserRecordingStatus } from './plugins/contract/browser-recordings.js';

// The store of the browser module, not of `@timon/browser-recording`: a `@settings/` row of any
// other plugin is opened by the redaction pass and its whole value would become a redaction term.
const STORE = '@timon/browser-embedded';
const META_PREFIX = 'browser-recordings/';
const SECRET_PREFIX = '@settings/browser-recordings/';
// Mission id → the recording it converts. Outside META_PREFIX: a listing of recordings never reads it.
const LEARN_MISSION_PREFIX = 'browser-recording-learn-missions/';
const RECORDING_ID = /^br-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_RECORDING_RETENTION_DAYS = 7;

export type BrowserRecordingOrigin = ProjectEventOrigin;
export type BrowserRecordingEventName = 'started' | 'stopped' | 'reviewed' | 'learned' | 'purged';

type SealedSteps = { version: 1; id: string; profileId: string; ownerUserId: string | null; steps: RecordedStep[] };

const ExternalRef = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  ref: z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f]/.test(value)),
  url: z.string().url().max(2_048).refine((value) => /^https?:/i.test(value)).nullable(),
}).strict();
const Metadata = z.object({
  id: z.string().regex(RECORDING_ID),
  profileId: z.string().min(1).max(128),
  ownerUserId: z.string().nullable(),
  title: z.string().max(120),
  startUrl: z.string().max(16_384),
  steps: z.number().int().nonnegative(),
  flagged: z.number().int().nonnegative(),
  truncated: z.boolean(),
  stoppedReason: z.enum(RECORDING_STOP_REASONS),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  status: z.enum(['draft', 'reviewed', 'learned']),
  learnMissionId: z.string().nullable(),
  // Absent from the recordings stored before #466.
  learnedSkillId: z.string().nullable().default(null),
  stepsAvailable: z.boolean(),
  externalRef: ExternalRef.nullable(),
}).strict();

const metaKey = (id: string) => `${META_PREFIX}${id}`;
const secretKey = (id: string) => `${SECRET_PREFIX}${id}`;
const learnMissionKey = (missionId: string) => `${LEARN_MISSION_PREFIX}${missionId}`;
const unavailable = () => new NativeBrowserError(apiError('browser_vault_unavailable', 'The browser recording vault is unavailable or its encrypted data is invalid.'), 503);
const notFound = () => new NativeBrowserError(apiError('browser_recording_not_found', 'Browser recording not found.'), 404);

export function isBrowserRecordingId(id: unknown): id is string {
  return typeof id === 'string' && RECORDING_ID.test(id);
}

function parseMetadata(raw: string): BrowserRecordingMetadata {
  try { return Metadata.parse(JSON.parse(raw)); } catch { throw unavailable(); }
}

export function getBrowserRecording(id: unknown): BrowserRecordingMetadata | undefined {
  if (!isBrowserRecordingId(id)) return undefined;
  const raw = dbApi.pluginKvGet(STORE, metaKey(id));
  if (!raw) return undefined;
  const meta = parseMetadata(raw);
  if (meta.id !== id) throw unavailable();
  return meta;
}

export function listBrowserRecordings(filter: { ownerUserId: string; profileId?: string }): BrowserRecordingMetadata[] {
  return dbApi.pluginKvList(STORE, META_PREFIX).map((row) => parseMetadata(row.value))
    .filter((meta) => meta.ownerUserId === filter.ownerUserId && (!filter.profileId || meta.profileId === filter.profileId))
    .sort((a, b) => b.createdAt - a.createdAt);
}

function allRecordings(): BrowserRecordingMetadata[] {
  return dbApi.pluginKvList(STORE, META_PREFIX).flatMap((row) => {
    try { return [parseMetadata(row.value)]; } catch { return []; }
  });
}

/** The raw steps, `null` once dropped. The caller has authorized the reader. */
export function readBrowserRecordingSteps(meta: BrowserRecordingMetadata): RecordedStep[] | null {
  if (!meta.stepsAvailable) return null;
  const key = secretKey(meta.id);
  try {
    const envelope = dbApi.pluginKvGet(STORE, key);
    if (!envelope || !isSealed(envelope)) throw new Error();
    const value = JSON.parse(openWithVault(envelope, pluginKvIdentity(STORE, key))) as SealedSteps;
    if (value.version !== 1 || value.id !== meta.id || value.profileId !== meta.profileId
      || value.ownerUserId !== meta.ownerUserId || !Array.isArray(value.steps)) throw new Error();
    return value.steps;
  } catch { throw unavailable(); }
}

function publish(event: BrowserRecordingEventName, meta: BrowserRecordingMetadata, origin: BrowserRecordingOrigin, reason?: string): void {
  bus.publish({ kind: 'browser_recording', event, profileId: meta.profileId, recordingId: meta.id,
    ownerUserId: meta.ownerUserId, recording: meta, origin, ...(reason ? { reason } : {}) });
}

/** A recording began on a profile: there is no recording row yet, only the profile. */
export function publishBrowserRecordingStarted(profile: BrowserProfile, origin: BrowserRecordingOrigin): void {
  bus.publish({ kind: 'browser_recording', event: 'started', profileId: profile.id, recordingId: null,
    ownerUserId: profile.owner_user_id, recording: null, origin });
}

const flaggedCount = (steps: readonly RecordedStep[]) => steps.filter((step) => step.flagged).length;

function write(meta: BrowserRecordingMetadata, steps: RecordedStep[] | null): void {
  let envelope: string | null = null;
  if (steps) {
    const key = secretKey(meta.id);
    const plain: SealedSteps = { version: 1, id: meta.id, profileId: meta.profileId, ownerUserId: meta.ownerUserId, steps };
    try { envelope = sealWithVault(JSON.stringify(plain), pluginKvIdentity(STORE, key)); }
    catch { throw unavailable(); }
  }
  db.transaction(() => {
    if (envelope) dbApi.pluginKvSet(STORE, secretKey(meta.id), envelope);
    else if (!meta.stepsAvailable) dbApi.pluginKvDelete(STORE, secretKey(meta.id));
    dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(meta));
  })();
}

function defaultTitle(url: string): string {
  try { return new URL(url).hostname || 'Browser recording'; } catch { return 'Browser recording'; }
}

/** Seals what the desktop returned at stop. Nothing of it goes back to the caller but the metadata. */
export function saveBrowserRecording(profile: BrowserProfile, raw: unknown, origin: BrowserRecordingOrigin, now = Date.now()): BrowserRecordingMetadata {
  const recording = sanitizeRecording(raw, () => now);
  if (!recording) throw new NativeBrowserError(apiError('browser_recording_invalid', 'The browser returned an invalid recording.'), 502);
  const startUrl = recording.url || recording.steps.find((step) => step.url)?.url || '';
  const meta: BrowserRecordingMetadata = {
    id: `br-${randomUUID()}`, profileId: profile.id, ownerUserId: profile.owner_user_id,
    title: defaultTitle(startUrl), startUrl, steps: recording.steps.length, flagged: flaggedCount(recording.steps),
    truncated: recording.truncated, stoppedReason: recording.stoppedReason, createdAt: now, updatedAt: now,
    status: 'draft', learnMissionId: null, learnedSkillId: null, stepsAvailable: true, externalRef: null,
  };
  write(meta, recording.steps);
  publish('stopped', meta, origin);
  return meta;
}

/**
 * Recordings the daemon collected by itself (an agent stopping the browser once the recording
 * ended on its own, `collectFinishedRecording`), by profile. The user's Stop, sent from a pill
 * that still showed the recording, then finds nothing on the desktop: it is answered with this
 * one instead of an error. In memory only: after a daemon restart that Stop gets the desktop's
 * refusal, and the recording is still in the list.
 */
const collectedByDaemon = new Map<string, string>();

export function noteCollectedBrowserRecording(meta: BrowserRecordingMetadata): void {
  collectedByDaemon.set(meta.profileId, meta.id);
}

/** A new recording starts: an earlier collection is no longer what a Stop refers to. */
export function forgetCollectedBrowserRecording(profileId: string): void {
  collectedByDaemon.delete(profileId);
}

function takeCollectedBrowserRecording(profile: BrowserProfile): BrowserRecordingMetadata | undefined {
  const id = collectedByDaemon.get(profile.id);
  collectedByDaemon.delete(profile.id);
  const meta = id ? getBrowserRecording(id) : undefined;
  return meta && meta.profileId === profile.id && meta.ownerUserId === profile.owner_user_id ? meta : undefined;
}

export type StoppedBrowserRecording = {
  recording: BrowserRecordingMetadata;
  /** The desktop had nothing left: the daemon had already saved this recording. */
  alreadySaved?: true;
};

/**
 * The user's Stop: what the desktop hands back is sealed. When it has nothing (409) or nothing
 * valid (502) because the daemon collected the recording first, the answer names that recording.
 */
export async function stopBrowserRecording(profile: BrowserProfile, stop: () => Promise<unknown>, origin: BrowserRecordingOrigin): Promise<StoppedBrowserRecording> {
  const earlier = (error: unknown): StoppedBrowserRecording => {
    const collected = error instanceof NativeBrowserError && (error.status === 409 || error.status === 502)
      ? takeCollectedBrowserRecording(profile) : undefined;
    if (!collected) throw error;
    return { recording: collected, alreadySaved: true };
  };
  let stopped: { recording?: unknown } | null;
  try { stopped = await stop() as { recording?: unknown } | null; }
  catch (error) { return earlier(error); }
  try {
    const recording = saveBrowserRecording(profile, stopped?.recording, origin);
    collectedByDaemon.delete(profile.id);
    return { recording };
  } catch (error) { return earlier(error); }
}

// ---------------------------------------------------------------------------------------------
// Review: destructive edits. A masked value is overwritten, never kept aside.

const stepNumber = z.number().int().positive().max(100_000);
const label = (max: number) => z.string().max(max).refine((value) => !/[\u0000-\u001f]/.test(value), 'control characters are not allowed');
export const BrowserRecordingOp = z.union([
  z.object({ op: z.literal('mask'), step: stepNumber }).strict(),
  z.object({ op: z.literal('unmask'), step: stepNumber }).strict(),
  z.object({ op: z.literal('param'), step: stepNumber, name: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/) }).strict(),
  z.object({ op: z.literal('drop'), step: stepNumber }).strict(),
  z.object({ op: z.literal('rename'), step: stepNumber, name: label(120) }).strict(),
  z.object({ op: z.literal('rename'), title: label(120).refine((value) => value.trim().length > 0, 'a title is required') }).strict(),
]);
export type BrowserRecordingOp = z.infer<typeof BrowserRecordingOp>;
export const BrowserRecordingPatch = z.object({ ops: z.array(BrowserRecordingOp).max(1_000) }).strict();

const placeholderOf = (step: RecordedStep) =>
  `{SECRET:${(step.name || step.inputType || 'value').replace(/[{}\s]+/g, ' ').trim().slice(0, 64) || 'value'}}`;

function applyOp(steps: RecordedStep[], op: BrowserRecordingOp, meta: { title: string }): RecordedStep[] {
  if (!('step' in op)) { meta.title = op.title.trim(); return steps; }
  const index = steps.findIndex((step) => step.n === op.step);
  if (index < 0) throw new NativeBrowserError(apiError('browser_recording_step_missing', `Step ${op.step} does not exist.`, { step: op.step }), 400);
  const step = { ...steps[index]! };
  switch (op.op) {
    case 'drop': return steps.filter((_, i) => i !== index);
    case 'rename':
      if (op.name.trim()) step.name = op.name.trim(); else delete step.name;
      break;
    case 'mask':
      if (step.value !== undefined && step.value !== '') step.value = placeholderOf(step);
      else if (step.text) step.text = '{SECRET:text}';
      else throw new NativeBrowserError(apiError('browser_recording_step_no_value', `Step ${op.step} has no value to mask.`, { step: op.step }), 400);
      delete step.flagged;
      break;
    case 'unmask':
      if (!step.flagged && (isSecretPlaceholder(step.value) || isSecretPlaceholder(step.text))) {
        throw new NativeBrowserError(apiError('browser_recording_step_masked', `Step ${op.step} was masked; a masked value cannot be restored.`, { step: op.step }), 409);
      }
      delete step.flagged;
      break;
    case 'param':
      if (step.type !== 'input') throw new NativeBrowserError(apiError('browser_recording_step_not_typed', `Step ${op.step} is not a typed value.`, { step: op.step }), 400);
      step.param = op.name;
      // A flagged value is not kept as the parameter's example: it may be the secret itself.
      if (step.flagged) { step.value = `{PARAM:${op.name}}`; delete step.flagged; }
      break;
  }
  return steps.map((current, i) => (i === index ? step : current));
}

export function patchBrowserRecording(meta: BrowserRecordingMetadata, ops: readonly BrowserRecordingOp[], origin: BrowserRecordingOrigin, now = Date.now()): { recording: BrowserRecordingMetadata; steps: RecordedStep[] } {
  if (meta.status === 'learned') throw new NativeBrowserError(apiError('browser_recording_learned', 'This recording was already learned; record it again to change it.'), 409);
  let steps = readBrowserRecordingSteps(meta);
  if (!steps) throw new NativeBrowserError(apiError('browser_recording_steps_gone', 'The steps of this recording are no longer available.'), 409);
  const draft = { title: meta.title };
  for (const op of ops) steps = applyOp(steps, op, draft);
  const flagged = flaggedCount(steps);
  const next: BrowserRecordingMetadata = { ...meta, title: draft.title, steps: steps.length, flagged,
    status: flagged ? 'draft' : 'reviewed', updatedAt: now };
  write(next, steps);
  if (meta.status !== 'reviewed' && next.status === 'reviewed') publish('reviewed', next, origin);
  return { recording: next, steps };
}

export function deleteBrowserRecording(meta: BrowserRecordingMetadata, origin: BrowserRecordingOrigin, reason: 'deleted' | 'retention' = 'deleted'): void {
  db.transaction(() => {
    dbApi.pluginKvDelete(STORE, secretKey(meta.id));
    dbApi.pluginKvDelete(STORE, metaKey(meta.id));
    if (meta.learnMissionId) dbApi.pluginKvDelete(STORE, learnMissionKey(meta.learnMissionId));
  })();
  publish('purged', meta, origin, reason);
}

export function setBrowserRecordingExternalRef(meta: BrowserRecordingMetadata, ref: unknown, now = Date.now()): BrowserRecordingMetadata {
  const parsed = ref === null ? null : ExternalRef.safeParse(ref);
  if (parsed && !parsed.success) throw new NativeBrowserError(apiError('browser_external_ref_invalid', 'The external reference is invalid.'), 400);
  const externalRef = parsed ? parsed.data : null;
  if (externalRef) {
    const taken = allRecordings().find((row) => row.id !== meta.id && row.externalRef?.provider === externalRef.provider && row.externalRef.ref === externalRef.ref);
    if (taken) throw new NativeBrowserError(apiError('browser_external_ref_taken', 'This external reference is already linked to another recording.'), 409);
  }
  const next = { ...meta, externalRef, updatedAt: now };
  dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(next));
  return next;
}

export function findBrowserRecordingByRef(provider: string, ref: string): BrowserRecordingMetadata | undefined {
  return allRecordings().find((row) => row.externalRef?.provider === provider && row.externalRef.ref === ref);
}

// ---------------------------------------------------------------------------------------------
// Learning: one conversion mission, named before it starts, so that it alone may read the steps.

/** Why this recording cannot be learned now, or null. */
export function learnRefusal(meta: BrowserRecordingMetadata): ApiErrorBody | null {
  if (meta.status === 'learned') return apiError('browser_recording_learned', 'This recording was already learned.');
  if (!meta.stepsAvailable) return apiError('browser_recording_steps_gone', 'The steps of this recording are no longer available.');
  if (meta.flagged > 0) return apiError('browser_recording_flagged', 'Review the flagged steps (mask, keep or drop them) before learning.');
  if (meta.steps === 0) return apiError('browser_recording_empty', 'This recording has no step to learn.');
  return null;
}

export function markBrowserRecordingLearning(meta: BrowserRecordingMetadata, missionId: string, now = Date.now()): BrowserRecordingMetadata {
  const refusal = learnRefusal(meta);
  if (refusal) throw new NativeBrowserError(refusal, 409);
  const next: BrowserRecordingMetadata = { ...meta, status: 'learned', learnMissionId: missionId, updatedAt: now };
  db.transaction(() => {
    dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(next));
    dbApi.pluginKvSet(STORE, learnMissionKey(missionId), meta.id);
  })();
  return next;
}

/** The spawn failed: the recording goes back to what it was. */
export function revertBrowserRecordingLearning(previous: BrowserRecordingMetadata): void {
  const current = getBrowserRecordingQuietly(previous.id);
  db.transaction(() => {
    if (current?.learnMissionId && current.learnMissionId !== previous.learnMissionId) {
      dbApi.pluginKvDelete(STORE, learnMissionKey(current.learnMissionId));
    }
    dbApi.pluginKvSet(STORE, metaKey(previous.id), JSON.stringify(previous));
  })();
}

export function publishBrowserRecordingLearned(meta: BrowserRecordingMetadata, origin: BrowserRecordingOrigin): void {
  publish('learned', meta, origin);
}

/** A recording by id, `undefined` when absent or unreadable: for a lookup that must not throw. */
function getBrowserRecordingQuietly(id: unknown): BrowserRecordingMetadata | undefined {
  try { return getBrowserRecording(id); } catch { return undefined; }
}

/**
 * The recording whose conversion mission is `missionId`: what that mission's token may do is
 * bounded by it. Looked up on every request of a mission token, so two key reads and no scan:
 * the index `markBrowserRecordingLearning` writes, then `recordingId` (the one the mission's
 * source names, for a recording learned before the index). Either must name this mission back.
 */
export function findBrowserRecordingByLearnMission(missionId: string, recordingId?: string | null): BrowserRecordingMetadata | undefined {
  for (const id of [dbApi.pluginKvGet(STORE, learnMissionKey(missionId)), recordingId]) {
    const meta = id ? getBrowserRecordingQuietly(id) : undefined;
    if (meta?.learnMissionId === missionId) return meta;
  }
  return undefined;
}

/**
 * The conversion mission created its skill: kept on the recording (the Attach card proposes
 * exactly this one) and announced by a second `learned` event, which carries it.
 */
export function recordBrowserRecordingSkill(
  missionId: string, skillId: string, origin: BrowserRecordingOrigin,
  opts: { now?: number; recordingId?: string | null } = {},
): BrowserRecordingMetadata | undefined {
  const now = opts.now ?? Date.now();
  const meta = findBrowserRecordingByLearnMission(missionId, opts.recordingId);
  if (!meta) return undefined;
  const next: BrowserRecordingMetadata = { ...meta, learnedSkillId: skillId, updatedAt: now };
  dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(next));
  publish('learned', next, origin);
  return next;
}

/** Only the metadata stays: the skill the mission wrote is what remains of the flow. */
export function dropBrowserRecordingSteps(meta: BrowserRecordingMetadata, now = Date.now()): BrowserRecordingMetadata {
  if (!meta.stepsAvailable) return meta;
  const next = { ...meta, stepsAvailable: false, updatedAt: now };
  write(next, null);
  return next;
}

/** After its conversion mission ended, a recording keeps no step. */
export function dropStepsOfLearnMission(missionId: string): void {
  for (const meta of allRecordings()) {
    if (meta.learnMissionId === missionId && meta.stepsAvailable) dropBrowserRecordingSteps(meta);
  }
}

const FINISHED_MISSION = new Set(['completed', 'failed', 'terminated']);

/**
 * Drafts (reviewed or not) older than the retention go; a learned recording loses
 * its steps once its mission is over, or at the latest after the retention.
 * A retention of 0 or less keeps drafts until they are deleted by hand.
 */
export function purgeBrowserRecordings(retentionDays: number, now = Date.now()): { deleted: number; dropped: number } {
  const expiry = retentionDays > 0 ? retentionDays * 86_400_000 : Number.POSITIVE_INFINITY;
  let deleted = 0;
  let dropped = 0;
  for (const meta of allRecordings()) {
    const expired = now - meta.createdAt >= expiry;
    if (meta.status !== 'learned') {
      if (expired) { deleteBrowserRecording(meta, { kind: 'system', id: null }, 'retention'); deleted++; }
      continue;
    }
    if (!meta.stepsAvailable) continue;
    const mission = meta.learnMissionId ? dbApi.getMission(meta.learnMissionId) : undefined;
    // The mission row is written just after the recording names it: give the spawn time to land.
    const gone = !mission && now - meta.updatedAt > 10 * 60_000;
    if (expired || gone || (mission && FINISHED_MISSION.has(mission.status))) { dropBrowserRecordingSteps(meta, now); dropped++; }
  }
  return { deleted, dropped };
}

export { RECORDING_STEP_TYPES, type RecordedStep };
