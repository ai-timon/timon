/**
 * Annotations of the built-in browser (TODO #468): the user points at an element, says what is
 * wrong with it, and sends a batch to a mission or an agent, which reads and resolves it.
 *
 * Stored like the recordings (`browser-recordings.ts`): bounded metadata in clear in `plugin_kv`,
 * everything the user typed or the page said (comment, URL, title, element, outerHTML, source)
 * sealed with the vault under a `@settings/` key, the thumbnail sealed on its own key so that a
 * listing never opens it. Every write masks again what the desktop already masked
 * (`browser-annotation-rules.ts`).
 *
 * Nothing here decides who reads: the routes and the plugin facade check the profile owner, and
 * for a mission the batch it was sent, before calling `readBrowserAnnotation`.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { db, dbApi, type MissionRow } from './db.js';
import { bus } from './bus.js';
import { resolveMissionBrowserProfile, type BrowserProfile } from './browser-profiles.js';
import { isSealed } from './secrets/box.js';
import { openWithVault, pluginKvIdentity, sealWithVault } from './secrets/store.js';
import { NativeBrowserError } from './native-browser-provider.js';
import { apiError } from './api-error.js';
import {
  ANNOTATION_COMMENT_MAX, isDevelopmentUrl, missionSourcePath, sanitizeAnnotationCapture, sanitizeAnnotationComment,
  type AnnotationThumbnail, type RawAnnotationSource, type SanitizedAnnotationCapture,
} from './browser-annotation-rules.js';
import type {
  BrowserAnnotationMetadata, BrowserAnnotationStatus, BrowserAnnotationDelivery, BrowserAnnotationOrigin,
  BrowserAnnotationSourceView, PluginBrowserAnnotationDetail,
} from './plugins/contract/browser-annotations.js';
import type { Assert, Equals } from './type-equality.js';
export type { BrowserAnnotationExternalRef, BrowserAnnotationMetadata, BrowserAnnotationStatus, BrowserAnnotationDelivery, BrowserAnnotationOrigin, BrowserAnnotationSourceView } from './plugins/contract/browser-annotations.js';

// The store of the browser module, not of `@timon/browser-annotations`: a `@settings/` row of any
// other plugin is opened by the redaction pass and its whole value would become a redaction term.
const STORE = '@timon/browser-embedded';
const META_PREFIX = 'browser-annotations/';
const SECRET_PREFIX = '@settings/browser-annotations/';
const THUMBNAIL_PREFIX = '@settings/browser-annotation-thumbnails/';
const ANNOTATION_ID = /^ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CAPTURE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BATCH_ID = /^bab-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const DEFAULT_ANNOTATION_RETENTION_DAYS = 7;
export const DEFAULT_RESOLVED_ANNOTATION_RETENTION_DAYS = 1;
/** Annotations one person keeps at once: past it, new picks are refused, never an older one evicted. */
export const MAX_ANNOTATIONS_PER_OWNER = 200;
/** Thumbnails one person keeps at once; past it, a new annotation is kept without its thumbnail. */
export const THUMBNAIL_BUDGET_PER_OWNER = 16 * 1024 * 1024;
/** Annotations one send may carry. */
export const MAX_ANNOTATIONS_PER_BATCH = 50;
export const RESOLUTION_NOTE_MAX = 2_000;

export type BrowserAnnotationEventName = 'created' | 'updated' | 'sent' | 'resolved' | 'dismissed' | 'purged';

type StoredCapture = Omit<SanitizedAnnotationCapture, 'thumbnail'>;
type SealedBody = {
  version: 1; id: string; profileId: string; ownerUserId: string | null;
  comment: string; capture: StoredCapture;
  /** The page's source path checked against the cwd it was sent to (`missionSourcePath`), or null. */
  sourcePath: string | null;
  /** The resolver's summary (resolved) or reason (dismissed). */
  note: string | null;
};
type SealedThumbnail = { version: 1; id: string; thumbnail: AnnotationThumbnail };

const ExternalRef = z.object({
  provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  ref: z.string().min(1).max(256).refine((value) => !/[\u0000-\u001f]/.test(value)),
  url: z.string().url().max(2_048).refine((value) => /^https?:/i.test(value)).nullable(),
}).strict();
const Origin = z.object({ kind: z.enum(['user', 'agent', 'plugin', 'system']), id: z.string().nullable() }).strict();
const Metadata = z.object({
  id: z.string().regex(ANNOTATION_ID),
  profileId: z.string().min(1).max(128),
  ownerUserId: z.string().nullable(),
  status: z.enum(['draft', 'pending', 'resolved', 'dismissed']),
  createdAt: z.number().finite(),
  updatedAt: z.number().finite(),
  capturedAt: z.number().finite(),
  hasThumbnail: z.boolean(),
  thumbnailBytes: z.number().int().nonnegative(),
  sourceDetected: z.boolean(),
  delivery: z.object({
    batchId: z.string().regex(BATCH_ID), missionId: z.string().nullable(), agentName: z.string().nullable(), sentAt: z.number().finite(),
  }).strict().nullable(),
  resolvedAt: z.number().finite().nullable(),
  resolvedBy: Origin.nullable(),
  externalRef: ExternalRef.nullable(),
}).strict();

const metaKey = (id: string) => `${META_PREFIX}${id}`;
const secretKey = (id: string) => `${SECRET_PREFIX}${id}`;
const thumbnailKey = (id: string) => `${THUMBNAIL_PREFIX}${id}`;
const unavailable = () => new NativeBrowserError(apiError('browser_vault_unavailable', 'The browser annotation vault is unavailable or its encrypted data is invalid.'), 503);

export function isBrowserAnnotationId(id: unknown): id is string {
  return typeof id === 'string' && ANNOTATION_ID.test(id);
}

export function isBrowserAnnotationBatchId(id: unknown): id is string {
  return typeof id === 'string' && BATCH_ID.test(id);
}

function parseMetadata(raw: string): BrowserAnnotationMetadata {
  try { return Metadata.parse(JSON.parse(raw)); } catch { throw unavailable(); }
}

export function getBrowserAnnotation(id: unknown): BrowserAnnotationMetadata | undefined {
  if (!isBrowserAnnotationId(id)) return undefined;
  const raw = dbApi.pluginKvGet(STORE, metaKey(id));
  if (!raw) return undefined;
  const meta = parseMetadata(raw);
  if (meta.id !== id) throw unavailable();
  return meta;
}

function allAnnotations(): BrowserAnnotationMetadata[] {
  return dbApi.pluginKvList(STORE, META_PREFIX).flatMap((row) => {
    try { return [parseMetadata(row.value)]; } catch { return []; }
  });
}

export type BrowserAnnotationFilter = { profileId?: string; status?: BrowserAnnotationStatus; batchId?: string };

const matches = (meta: BrowserAnnotationMetadata, filter: BrowserAnnotationFilter) =>
  (!filter.profileId || meta.profileId === filter.profileId) && (!filter.status || meta.status === filter.status)
  && (!filter.batchId || meta.delivery?.batchId === filter.batchId);

export function listBrowserAnnotations(filter: BrowserAnnotationFilter & { ownerUserId: string }): BrowserAnnotationMetadata[] {
  return allAnnotations().filter((meta) => meta.ownerUserId === filter.ownerUserId && matches(meta, filter))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** What the user and the page said. The caller has authorized the reader. */
export function readBrowserAnnotation(meta: BrowserAnnotationMetadata): SealedBody {
  const key = secretKey(meta.id);
  try {
    const envelope = dbApi.pluginKvGet(STORE, key);
    if (!envelope || !isSealed(envelope)) throw new Error();
    const value = JSON.parse(openWithVault(envelope, pluginKvIdentity(STORE, key))) as SealedBody;
    if (value.version !== 1 || value.id !== meta.id || value.profileId !== meta.profileId
      || value.ownerUserId !== meta.ownerUserId || typeof value.comment !== 'string' || !value.capture) throw new Error();
    return value;
  } catch { throw unavailable(); }
}

/** The thumbnail, `null` when it has none. The caller has authorized the reader. */
export function readBrowserAnnotationThumbnail(meta: BrowserAnnotationMetadata): AnnotationThumbnail | null {
  if (!meta.hasThumbnail) return null;
  const key = thumbnailKey(meta.id);
  try {
    const envelope = dbApi.pluginKvGet(STORE, key);
    if (!envelope || !isSealed(envelope)) throw new Error();
    const value = JSON.parse(openWithVault(envelope, pluginKvIdentity(STORE, key))) as SealedThumbnail;
    if (value.version !== 1 || value.id !== meta.id || value.thumbnail?.mimeType !== 'image/jpeg') throw new Error();
    return value.thumbnail;
  } catch { throw unavailable(); }
}

function seal(key: string, value: unknown): string {
  try { return sealWithVault(JSON.stringify(value), pluginKvIdentity(STORE, key)); } catch { throw unavailable(); }
}

function write(meta: BrowserAnnotationMetadata, body: SealedBody | null, thumbnail?: AnnotationThumbnail): void {
  const envelope = body ? seal(secretKey(meta.id), body) : null;
  const image = thumbnail ? seal(thumbnailKey(meta.id), { version: 1, id: meta.id, thumbnail } satisfies SealedThumbnail) : null;
  db.transaction(() => {
    if (envelope) dbApi.pluginKvSet(STORE, secretKey(meta.id), envelope);
    if (image) dbApi.pluginKvSet(STORE, thumbnailKey(meta.id), image);
    dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(meta));
  })();
}

function publish(event: BrowserAnnotationEventName, meta: BrowserAnnotationMetadata, origin: BrowserAnnotationOrigin, reason?: string): void {
  bus.publish({ kind: 'browser_annotation', event, profileId: meta.profileId, annotationId: meta.id,
    ownerUserId: meta.ownerUserId, annotation: meta, origin, ...(reason ? { reason } : {}) });
}

export type SavedBrowserAnnotations = {
  annotations: BrowserAnnotationMetadata[];
  /** Picks dropped: invalid, or past `MAX_ANNOTATIONS_PER_OWNER`. */
  refused: number;
  /** Kept without their thumbnail, past `THUMBNAIL_BUDGET_PER_OWNER`. */
  thumbnailsDropped: number;
};

/**
 * The id the desktop gave its capture, as the store names it: the desktop's comment bubble edits and
 * removes what it queued by that name, whoever collected it (TODO #481). Null when it gave none.
 */
function desktopAnnotationId(raw: unknown): string | null {
  const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined;
  return typeof id === 'string' && CAPTURE_ID.test(id) ? `ba-${id}` : null;
}

/** The comment typed in the desktop's bubble (Timon's own view, never the page), or ''. */
function desktopComment(raw: unknown): string {
  const comment = raw && typeof raw === 'object' ? (raw as { comment?: unknown }).comment : undefined;
  return typeof comment === 'string' ? sanitizeAnnotationComment(comment.slice(0, ANNOTATION_COMMENT_MAX * 2)) : '';
}

/**
 * Seals the picks the desktop handed back, as drafts: without a comment from the drawer's path,
 * with the one typed in the bubble from the desktop's. A capture already stored is not stored twice.
 */
export function saveBrowserAnnotations(profile: BrowserProfile, picks: readonly unknown[], origin: BrowserAnnotationOrigin, now = Date.now()): SavedBrowserAnnotations {
  const owned = allAnnotations().filter((meta) => meta.ownerUserId === profile.owner_user_id);
  let count = owned.length;
  let thumbnailBytes = owned.reduce((sum, meta) => sum + meta.thumbnailBytes, 0);
  const saved: BrowserAnnotationMetadata[] = [];
  let refused = 0;
  let thumbnailsDropped = 0;
  for (const raw of picks) {
    const capture = sanitizeAnnotationCapture(raw, () => now);
    const named = desktopAnnotationId(raw);
    if (!capture || count >= MAX_ANNOTATIONS_PER_OWNER
      || (named && (saved.some((meta) => meta.id === named) || dbApi.pluginKvGet(STORE, metaKey(named))))) { refused++; continue; }
    const { thumbnail: image, ...stored } = capture;
    const bytes = image ? Buffer.byteLength(image.data, 'base64') : 0;
    const thumbnail = image && thumbnailBytes + bytes <= THUMBNAIL_BUDGET_PER_OWNER ? image : undefined;
    if (image && !thumbnail) thumbnailsDropped++;
    // One millisecond apart: picks collected together keep the order the user made them in.
    const createdAt = now + saved.length;
    const meta: BrowserAnnotationMetadata = {
      id: named ?? `ba-${randomUUID()}`, profileId: profile.id, ownerUserId: profile.owner_user_id, status: 'draft',
      createdAt, updatedAt: createdAt, capturedAt: capture.capturedAt, hasThumbnail: !!thumbnail, thumbnailBytes: thumbnail ? bytes : 0,
      sourceDetected: capture.source.detected, delivery: null, resolvedAt: null, resolvedBy: null, externalRef: null,
    };
    write(meta, { version: 1, id: meta.id, profileId: meta.profileId, ownerUserId: meta.ownerUserId, comment: desktopComment(raw), capture: stored, sourcePath: null, note: null }, thumbnail);
    count++;
    thumbnailBytes += meta.thumbnailBytes;
    saved.push(meta);
    publish('created', meta, origin);
  }
  return { annotations: saved, refused, thumbnailsDropped };
}

/** The desktop's answer to `annotateStop` / `annotateCollect` / `annotatePick`: its picks, sealed. */
export function picksOf(result: unknown): unknown[] {
  if (!result || typeof result !== 'object') return [];
  const annotation = (result as { annotation?: unknown }).annotation;
  if (!annotation || typeof annotation !== 'object') return [];
  const picks = (annotation as { picks?: unknown }).picks;
  if (Array.isArray(picks)) return picks.slice(0, 100);
  // `annotatePick` answers with the one capture it made.
  return (annotation as { version?: unknown }).version === 1 ? [annotation] : [];
}

/** The annotate state the desktop reported, without the picks it handed over. */
export function annotationStateOf(result: unknown): Record<string, unknown> {
  const annotation = result && typeof result === 'object' ? (result as { annotation?: unknown }).annotation : null;
  if (!annotation || typeof annotation !== 'object' || (annotation as { version?: unknown }).version === 1) return {};
  const { picks: _picks, ...state } = annotation as Record<string, unknown>;
  return state;
}

export function setBrowserAnnotationComment(meta: BrowserAnnotationMetadata, comment: string, origin: BrowserAnnotationOrigin, now = Date.now()): BrowserAnnotationMetadata {
  // Once sent, the agent may already have read it: what it acts on must not change under it.
  if (meta.status !== 'draft') throw new NativeBrowserError(apiError('browser_annotation_sent', 'This annotation was already sent; its comment can no longer change.'), 409);
  const body = readBrowserAnnotation(meta);
  const next = { ...meta, updatedAt: now };
  write(next, { ...body, comment: sanitizeAnnotationComment(comment) });
  publish('updated', next, origin);
  return next;
}

export function deleteBrowserAnnotation(meta: BrowserAnnotationMetadata, origin: BrowserAnnotationOrigin, reason: 'deleted' | 'retention' = 'deleted'): void {
  db.transaction(() => {
    dbApi.pluginKvDelete(STORE, secretKey(meta.id));
    dbApi.pluginKvDelete(STORE, thumbnailKey(meta.id));
    dbApi.pluginKvDelete(STORE, metaKey(meta.id));
  })();
  publish('purged', meta, origin, reason);
}

export type BrowserAnnotationTarget = { missionId: string | null; agentName: string | null; cwd: string | null };

/**
 * Sends drafts as one batch to a mission or to an agent's next conversation. The page's source
 * path is checked here against the cwd it goes to; the reader's own cwd checks it again.
 */
export function sendBrowserAnnotations(metas: readonly BrowserAnnotationMetadata[], target: BrowserAnnotationTarget, origin: BrowserAnnotationOrigin, now = Date.now()): { batchId: string; annotations: BrowserAnnotationMetadata[] } {
  if (!metas.length || metas.length > MAX_ANNOTATIONS_PER_BATCH) throw new NativeBrowserError(apiError('browser_annotation_batch_size', `Send between 1 and ${MAX_ANNOTATIONS_PER_BATCH} annotations.`, { max: MAX_ANNOTATIONS_PER_BATCH }), 400);
  if (!target.missionId && !target.agentName) throw new NativeBrowserError(apiError('browser_annotation_target_required', 'Name the mission or the agent the annotations go to.'), 400);
  const sent = metas.find((meta) => meta.status !== 'draft');
  if (sent) throw new NativeBrowserError(apiError('browser_annotation_already_sent', `Annotation ${sent.id} was already sent.`, { id: sent.id }), 409);
  const bodies = metas.map(readBrowserAnnotation);
  const batchId = `bab-${randomUUID()}`;
  const delivery: BrowserAnnotationDelivery = { batchId, missionId: target.missionId, agentName: target.agentName, sentAt: now };
  const next = metas.map((meta) => ({ ...meta, status: 'pending' as const, delivery, updatedAt: now }));
  next.forEach((meta, index) => {
    const body = bodies[index]!;
    const source = body.capture.source;
    write(meta, { ...body, sourcePath: source.detected ? missionSourcePath(source.file, target.cwd) : null });
  });
  for (const meta of next) publish('sent', meta, origin);
  return { batchId, annotations: next };
}

/**
 * Puts a batch whose turn never reached the agent back in the queue, as drafts: nothing of it was
 * read, so the user keeps the annotations, their comments and their thumbnails, and sends again.
 */
export function withdrawBrowserAnnotations(sent: readonly BrowserAnnotationMetadata[], origin: BrowserAnnotationOrigin, now = Date.now()): BrowserAnnotationMetadata[] {
  return sent.flatMap((meta) => {
    const current = getBrowserAnnotation(meta.id);
    // Resolved meanwhile, deleted, or sent again: not this batch's to take back.
    if (!current || current.status !== 'pending' || current.delivery?.batchId !== meta.delivery?.batchId) return [];
    const body = readBrowserAnnotation(current);
    const next: BrowserAnnotationMetadata = { ...current, status: 'draft', delivery: null, updatedAt: now };
    write(next, { ...body, sourcePath: null });
    publish('updated', next, origin);
    return [next];
  });
}

export type BrowserAnnotationResolution = { status: 'resolved' | 'dismissed'; note: string };

export function resolveBrowserAnnotation(meta: BrowserAnnotationMetadata, resolution: BrowserAnnotationResolution, origin: BrowserAnnotationOrigin, now = Date.now()): BrowserAnnotationMetadata {
  if (meta.status === 'resolved') throw new NativeBrowserError(apiError('browser_annotation_resolved', 'This annotation is already resolved.'), 409);
  if (meta.status === 'dismissed') throw new NativeBrowserError(apiError('browser_annotation_dismissed', 'This annotation is already dismissed.'), 409);
  const body = readBrowserAnnotation(meta);
  const note = sanitizeAnnotationComment(resolution.note).slice(0, RESOLUTION_NOTE_MAX);
  const next: BrowserAnnotationMetadata = { ...meta, status: resolution.status, resolvedAt: now, resolvedBy: origin, updatedAt: now };
  write(next, { ...body, note: note || null });
  publish(resolution.status, next, origin);
  return next;
}

export function setBrowserAnnotationExternalRef(meta: BrowserAnnotationMetadata, ref: unknown, origin: BrowserAnnotationOrigin, now = Date.now()): BrowserAnnotationMetadata {
  const parsed = ref === null ? null : ExternalRef.safeParse(ref);
  if (parsed && !parsed.success) throw new NativeBrowserError(apiError('browser_external_ref_invalid', 'The external reference is invalid.'), 400);
  const externalRef = parsed ? parsed.data : null;
  if (externalRef) {
    const taken = allAnnotations().find((row) => row.id !== meta.id && row.externalRef?.provider === externalRef.provider && row.externalRef.ref === externalRef.ref);
    if (taken) throw new NativeBrowserError(apiError('browser_external_ref_taken', 'This external reference is already linked to another annotation.'), 409);
  }
  const next = { ...meta, externalRef, updatedAt: now };
  dbApi.pluginKvSet(STORE, metaKey(meta.id), JSON.stringify(next));
  publish('updated', next, origin);
  return next;
}

export function findBrowserAnnotationByRef(provider: string, ref: string): BrowserAnnotationMetadata | undefined {
  return allAnnotations().find((row) => row.externalRef?.provider === provider && row.externalRef.ref === ref);
}

// ---------------------------------------------------------------------------------------------
// Missions: an annotation reaches a mission only through the batch it was sent.

/** The browser profile a mission reads annotations with: the one it would drive, or none. */
export function missionAnnotationProfile(mission: MissionRow): BrowserProfile | null {
  try { return resolveMissionBrowserProfile(mission); } catch { return null; }
}

/**
 * Whether `mission` may read and resolve `meta`: sent to that mission, or to its agent's next
 * conversation; same owner; and that mission's own browser profile is the annotated one.
 */
export function missionMayReachAnnotation(meta: BrowserAnnotationMetadata, mission: MissionRow, profile: BrowserProfile | null): boolean {
  const delivery = meta.delivery;
  if (!delivery || meta.status === 'draft' || !meta.ownerUserId) return false;
  const addressed = delivery.missionId ? delivery.missionId === mission.id : delivery.agentName === mission.agent_name;
  return addressed && mission.owner_user_id === meta.ownerUserId
    && !!profile && profile.id === meta.profileId && profile.owner_user_id === meta.ownerUserId;
}

export function listMissionAnnotations(mission: MissionRow, filter: Omit<BrowserAnnotationFilter, 'profileId'>): BrowserAnnotationMetadata[] {
  const profile = missionAnnotationProfile(mission);
  if (!profile) return [];
  return allAnnotations().filter((meta) => matches(meta, filter) && missionMayReachAnnotation(meta, mission, profile))
    .sort((a, b) => a.createdAt - b.createdAt);
}

// ---------------------------------------------------------------------------------------------
// Views: what the owner and a mission read.

function sourceView(source: RawAnnotationSource, file: string | null): BrowserAnnotationSourceView {
  if (!source.detected) return { detected: false };
  return {
    detected: true, framework: source.framework, via: source.via,
    ...(source.component ? { component: source.component } : {}), ...(source.approximate ? { approximate: true as const } : {}),
    file, ...(file && source.line !== undefined ? { line: source.line } : {}), ...(file && source.column !== undefined ? { column: source.column } : {}),
  };
}

export type BrowserAnnotationPageView = StoredCapture & {
  /** Text, accessible name, title and markup left out: the page is not the user's own development. */
  textWithheld: boolean;
};

const resolutionView = (meta: BrowserAnnotationMetadata, note: string | null) =>
  meta.status === 'resolved' ? { status: meta.status, summary: note } : meta.status === 'dismissed' ? { status: meta.status, reason: note } : null;

/** The owner's read: everything, the path being the one checked at send time. */
export function ownerAnnotationView(meta: BrowserAnnotationMetadata, body = readBrowserAnnotation(meta)) {
  const { source, ...capture } = body.capture;
  return {
    annotation: meta, comment: body.comment, page: { ...capture, textWithheld: false } satisfies Omit<BrowserAnnotationPageView, 'source'>,
    source: sourceView(source, body.sourcePath), resolution: resolutionView(meta, body.note),
  };
}

/** The plugin contract spells this view out (`PluginBrowserAnnotationDetail`); compilation fails if they part. */
type OwnerView = ReturnType<typeof ownerAnnotationView>;
type _OwnerPageMatchesContract = Assert<Equals<OwnerView['page'], PluginBrowserAnnotationDetail['page']>>;
type _OwnerSourceMatchesContract = Assert<Equals<OwnerView['source'], PluginBrowserAnnotationDetail['source']>>;
type _OwnerResolutionMatchesContract = Assert<Equals<OwnerView['resolution'], PluginBrowserAnnotationDetail['resolution']>>;

/**
 * A mission's read. The comment is the user's instruction; everything under `page` and `source`
 * is page data. An outside site keeps its selector and geometry but not its words, and the source
 * path is checked again against this mission's cwd.
 */
export function missionAnnotationView(meta: BrowserAnnotationMetadata, cwd: string | null, body = readBrowserAnnotation(meta)) {
  const { source, ...capture } = body.capture;
  const local = isDevelopmentUrl(capture.url);
  const target = local ? capture.target : {
    ...capture.target, name: '', text: '',
    locators: capture.target.locators.filter((locator) => locator.kind === 'css' || locator.kind === 'xpath'),
  };
  if (!local) delete target.flagged;
  return {
    id: meta.id, status: meta.status, batchId: meta.delivery?.batchId ?? null, capturedAt: meta.capturedAt, hasThumbnail: meta.hasThumbnail,
    comment: body.comment,
    page: {
      ...capture, target, title: local ? capture.title : '', outerHtml: local ? capture.outerHtml : '',
      outerHtmlTruncated: local && capture.outerHtmlTruncated, textWithheld: !local,
    },
    source: sourceView(source, source.detected ? missionSourcePath(source.file, cwd) : null),
    resolution: resolutionView(meta, body.note),
  };
}

// ---------------------------------------------------------------------------------------------
// Retention.

/**
 * Drafts and sent annotations go after `openDays` from their creation; resolved and dismissed
 * ones after `resolvedDays` from their resolution. A retention of 0 or less keeps them.
 */
export function purgeBrowserAnnotations(openDays: number, resolvedDays: number, now = Date.now()): { deleted: number } {
  const span = (days: number) => (days > 0 ? days * 86_400_000 : Number.POSITIVE_INFINITY);
  let deleted = 0;
  for (const meta of allAnnotations()) {
    const done = meta.status === 'resolved' || meta.status === 'dismissed';
    const since = done ? meta.resolvedAt ?? meta.updatedAt : meta.createdAt;
    if (now - since < span(done ? resolvedDays : openDays)) continue;
    deleteBrowserAnnotation(meta, { kind: 'system', id: null }, 'retention');
    deleted++;
  }
  return { deleted };
}
