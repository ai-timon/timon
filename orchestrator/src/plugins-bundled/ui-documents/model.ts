/**
 * HTML documents shown in a mission's conversation (MCPUI, docs/ADR-MCPUI.md).
 *
 * Everything that leaves this module toward a reader goes through ONE
 * function, `projectUiDocument(row, reader)` (D8): it drops the HTML always,
 * and the `reply` key unless the reader may read it. A route, a facade call or
 * an event that built its own view would be the place a reply leaks; there is
 * none.
 */
import { daemonMessage } from '../../daemon-message.js';
import { z } from 'zod';
import { bus } from '../../bus.js';
import { createNotification } from '../../notifications.js';
import { dbApi, type MissionRow, type UiDocumentBridge, type UiDocumentOriginKind, type UiDocumentRow } from '../../db.js';
import { proposalOrigin } from '../terminal-web/command-requests.js';
import { UI_DOCUMENT_BOOTSTRAP } from './bootstrap.js';
import type { UiDocumentView, UiDocumentActor } from '../../plugins/contract/ui-documents.js';
export type { UiDocumentView, UiDocumentActor } from '../../plugins/contract/ui-documents.js';

export const MAX_HTML_BYTES = 512 * 1024;
export const MAX_TITLE_CHARS = 120;
export const MAX_DOCUMENTS_PER_MISSION = 50;
export const MAX_PENDING_PER_MISSION = 5;
export const MIN_HEIGHT = 80;
export const MAX_HEIGHT = 2000;
const MAX_REF_CHARS = 200;
/** A reply is a JSON object (D7): bounded in bytes and in nesting, the latter measured before zod. */
export const MAX_REPLY_BYTES = 16 * 1024;
export const MAX_REPLY_DEPTH = 16;

export const UI_DOCUMENT_EVENT = 'ui_document';
export const UI_DOCUMENT_RESOLVED_EVENT = 'ui_document_resolved';

/** A title is shown as text: one line, no control character. */
// eslint-disable-next-line no-control-regex
const TITLE = z.string().trim().min(1).max(MAX_TITLE_CHARS).refine((t) => !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(t), 'one line of text');
const HEIGHT = z.number().int().min(MIN_HEIGHT).max(MAX_HEIGHT);
const MISSION_ID = z.string().regex(/^[A-Za-z0-9-]{1,64}$/);
// The byte cap is checked apart (413, not 400): z.string().max() counts UTF-16 units.
const HTML = z.string().min(1);

/** `POST /api/ui-documents`: an agent for its own mission, or the owner's session. */
export const CreateBody = z.object({
  mission_id: MISSION_ID.optional(),
  title: TITLE,
  html: HTML.optional(),
  path: z.string().min(1).max(4096).optional(),
  reply: z.boolean().optional(),
  height: HEIGHT.optional(),
}).strict().refine((b) => (b.html === undefined) !== (b.path === undefined), 'exactly one of html and path');

/** `POST /api/ui-documents/:id/reply`: what the document's `submit` sent, an object. */
export const ReplyBody = z.object({
  reply: z.record(z.string(), z.unknown()),
}).strict();

export const ListQuery = z.object({
  mission_id: MISSION_ID,
  limit: z.coerce.number().int().min(1).max(MAX_DOCUMENTS_PER_MISSION).optional(),
}).strict();

export const DocumentId = z.string().regex(/^[0-9a-f-]{36}$/i);

/** What a plugin passes to `ctx.ui.documents.create` (camelCase, the SDK's shape). */
export const PluginCreateInput = z.object({
  missionId: MISSION_ID,
  title: TITLE,
  html: HTML,
  height: HEIGHT.optional(),
  expectsReply: z.boolean().optional(),
  bridge: z.enum(['timon', 'raw']).optional(),
  ref: z.object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/),
    ref: z.string().min(1).max(MAX_REF_CHARS),
  }).strict().optional(),
}).strict();

export function htmlBytes(html: string): number {
  return Buffer.byteLength(html, 'utf8');
}

/** Who reads a document: a browser session that already passed the mission's read check, a mission's own token, or a plugin. */
export type UiDocumentReader =
  | { kind: 'session' }
  | { kind: 'mission'; missionId: string }
  | { kind: 'plugin'; id: string };

/** Whether `reader` may read the reply of `row` (D6). */
export function readerSeesReply(row: Pick<UiDocumentRow, 'mission_id' | 'origin_kind' | 'origin_id'>, reader: UiDocumentReader): boolean {
  switch (reader.kind) {
    case 'session':
      return true;
    case 'mission':
      return row.origin_kind === 'agent' && row.mission_id === reader.missionId;
    case 'plugin':
      return row.origin_kind === 'plugin' && row.origin_id === reader.id;
  }
}

function parseReply(raw: string | null): unknown {
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return null; }
}

/** The ONLY way out of this module for a document (D8). */
export function projectUiDocument(row: Omit<UiDocumentRow, 'html'> & { html?: string }, reader: UiDocumentReader): UiDocumentView {
  const view: UiDocumentView = {
    id: row.id,
    missionId: row.mission_id,
    title: row.title,
    origin: { kind: row.origin_kind, id: row.origin_id },
    bridge: row.bridge,
    height: row.height,
    expectsReply: row.expects_reply === 1,
    status: row.status,
    resolvedBy: row.resolved_by_kind ? { kind: row.resolved_by_kind, id: row.resolved_by_id } : null,
    resolvedAt: row.resolved_at,
    project: row.project,
    missionTitle: row.mission_title,
    taskId: row.task_id,
    createdAt: row.created_at,
  };
  const ownPlugin = reader.kind === 'plugin' && row.origin_kind === 'plugin' && row.origin_id === reader.id;
  if (row.ref_provider && row.ref && (reader.kind === 'session' || ownPlugin)) {
    view.ref = { provider: row.ref_provider, ref: row.ref };
  }
  if (readerSeesReply(row, reader)) view.reply = parseReply(row.reply);
  return view;
}

/** Headers of the document route (D4). The host sets them; the document cannot loosen them. */
export const DOCUMENT_CSP = [
  'sandbox allow-scripts allow-forms',
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'self'",
].join('; ');

export function documentHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': DOCUMENT_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), clipboard-read=(), clipboard-write=(), payment=(), usb=()',
    'cache-control': 'private, no-store',
  };
}

const DOCTYPE = /^(﻿?\s*<!doctype[^>]*>)/i;

/**
 * The bridge's bootstrap, right after the doctype (BOM and blanks allowed
 * before it), else first: before any script of the document either way.
 */
export function injectBootstrap(html: string, bootstrap: string = UI_DOCUMENT_BOOTSTRAP): string {
  const tag = `<script>${bootstrap}</script>`;
  const doctype = DOCTYPE.exec(html);
  if (!doctype) return `${tag}${html}`;
  return `${doctype[1]}${tag}${html.slice(doctype[1]!.length)}`;
}

/** What the mission's conversation keeps: no HTML, no reply (D7). The card reads the rest through the session route. */
function eventPayload(row: UiDocumentRow): Record<string, unknown> {
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    origin: { kind: row.origin_kind, id: row.origin_id },
    bridge: row.bridge,
    height: row.height,
    expectsReply: row.expects_reply === 1,
    createdAt: row.created_at,
  };
}

function publish(missionId: string, type: string, payload: Record<string, unknown>): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  bus.publish({ kind: 'event', missionId, type, timestamp: row.timestamp, payload });
}

export type CreateRefusal =
  | { ok: false; status: 409; error: 'no_owner' }
  | { ok: false; status: 413; error: 'document_too_large' }
  | { ok: false; status: 429; error: 'too_many_documents' }
  | { ok: false; status: 409; error: 'ref_taken' };

export type CreateInput = {
  mission: MissionRow;
  origin: { kind: UiDocumentOriginKind; id: string | null };
  title: string;
  html: string;
  bridge?: UiDocumentBridge;
  height?: number | null;
  expectsReply?: boolean;
  ref?: { provider: string; ref: string } | null;
  id: string;
};

/**
 * Checks the caps, records the document and puts it in the conversation.
 * Who may call it is the caller's business (route, facade); what it accepts
 * is decided here, once.
 */
export function createUiDocument(input: CreateInput): { ok: true; row: UiDocumentRow } | CreateRefusal {
  const { mission } = input;
  if (!mission.owner_user_id) return { ok: false, status: 409, error: 'no_owner' };
  if (htmlBytes(input.html) > MAX_HTML_BYTES) return { ok: false, status: 413, error: 'document_too_large' };
  const counts = dbApi.countUiDocuments(mission.id);
  if (counts.total >= MAX_DOCUMENTS_PER_MISSION) return { ok: false, status: 429, error: 'too_many_documents' };
  if (input.expectsReply && counts.pending >= MAX_PENDING_PER_MISSION) return { ok: false, status: 429, error: 'too_many_documents' };
  if (input.ref && input.origin.id && dbApi.findUiDocumentByRef(input.origin.id, input.ref.provider, input.ref.ref)) {
    return { ok: false, status: 409, error: 'ref_taken' };
  }
  const where = proposalOrigin(mission);
  const row = dbApi.insertUiDocument({
    id: input.id,
    mission_id: mission.id,
    owner_user_id: mission.owner_user_id,
    origin_kind: input.origin.kind,
    origin_id: input.origin.id,
    title: input.title,
    html: input.html,
    bridge: input.bridge ?? 'timon',
    height: input.height ?? null,
    expects_reply: input.expectsReply ? 1 : 0,
    ref_provider: input.ref?.provider ?? null,
    ref: input.ref?.ref ?? null,
    project: where.project,
    mission_title: where.missionTitle,
    task_id: where.taskId,
  });
  publish(mission.id, UI_DOCUMENT_EVENT, eventPayload(row));
  if (row.status === 'pending') {
    // The card's id anchors it: answered or closed, the notification goes with it.
    createNotification({
      type: 'action_required',
      urgent: false,
      title: `Document to answer: ${row.origin_id ?? row.origin_kind}`,
      message: daemonMessage('ui_document_to_answer', { origin: row.origin_id ?? row.origin_kind }),
      body: `${row.mission_title}${row.project ? ` (${row.project})` : ''} — ${row.title}`,
      missionId: mission.id,
      taskId: row.task_id,
      anchor: row.id,
      ownerUserId: row.owner_user_id,
    });
  }
  return { ok: true, row };
}

/** The resolution as the conversation keeps it: who and when, never the reply (D7). */
function publishResolved(row: UiDocumentRow, by: UiDocumentActor): void {
  publish(row.mission_id, UI_DOCUMENT_RESOLVED_EVENT, {
    id: row.id,
    status: row.status,
    title: row.title,
    origin: { kind: row.origin_kind, id: row.origin_id },
    resolvedBy: { kind: by.kind, id: by.id },
    resolvedAt: row.resolved_at,
  });
}

/**
 * Settles a pending document with the owner's reply (JSON text, already
 * bounded by the caller). Null when it was not pending or does not exist.
 */
export function answerUiDocument(id: string, reply: string, by: UiDocumentActor): UiDocumentRow | null {
  if (!dbApi.settleUiDocument(id, { status: 'answered', reply, resolvedByKind: by.kind, resolvedById: by.id })) return null;
  const row = dbApi.getUiDocument(id)!;
  publishResolved(row, by);
  return row;
}

/**
 * Settles a document as dismissed (removed by its creator, or closed by the
 * owner). Null when it was already settled or does not exist. Who hears of
 * it — a waiting agent — is `requests.ts`'s business.
 */
export function dismissUiDocument(id: string, by: UiDocumentActor): UiDocumentRow | null {
  if (!dbApi.settleUiDocument(id, { status: 'dismissed', resolvedByKind: by.kind, resolvedById: by.id })) return null;
  const row = dbApi.getUiDocument(id)!;
  publishResolved(row, by);
  return row;
}
