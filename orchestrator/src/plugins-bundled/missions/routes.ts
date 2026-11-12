/**
 * Module `@timon/missions` — mission lifecycle: launch, resume, interruption,
 * backend switching, inter-agent messages, and permission cards. Tier `core`.
 *
 * Registration order is load-bearing: `/api/missions/search` MUST precede
 * `/api/missions/:id`, otherwise `search` is captured as an id. It is preserved
 * exactly as it was in `index.ts`.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import express, { type Request, type Response } from 'express';
import { z } from 'zod';
import { BackendExhaustedError, ContextTooLargeError, TurnInFlightError, clientTurnState, getTurnState, interruptAgent, isRunning, killAgent, listAgents, loadConfig, respawnWithResume, sendToAgent, steerMission, planSwitchContext, setMissionModel, stderrExcerpt, switchMissionBackend, turnPreparing, whileTurnPrepares } from '../../agent.js';
import { sendAgentMessage, CrossTeamError, UnknownAgentError, UnknownMissionError, InvalidReplyError } from '../../agent-messages.js';
import { cooldownReason, fallbackFor } from '../../backend-fallback.js';
import { messageDateTime } from '../../message-dates.js';
import { asBackendName, defaultBackendName } from '../../backends/index.js';
import { config } from '../../config/load.js';
import { db, dbApi, SPAN_CURSOR_PATTERN, type EventRow, type MissionRow } from '../../db.js';
import { handleSpawn } from '../../http-helpers.js';
import { agentCommunicationAllowed, developerAutoAllows } from '../../users/agent-permissions.js';
import { createDelegationHandler } from '../../mission-delegation.js';
import { messageOrigin } from '../../message-origin.js';
import { missionLiveness } from '../../mission-liveness.js';
import { MISSION_VIEWS, parseMissionView } from '../../mission-events-view.js';
import { ServerTiming, sendTimedJson } from '../../server-timing.js';
import { isDeltaQuery, parseHistoryQuery, readHistoryDelta, readHistoryPage, readHistoryPrelude, readLaterResolutions } from '../../mission-history-page.js';
import { MISSION_ORIGIN_FILTERS, isMissionOriginFilter } from '../../mission-origin.js';
import { parseTimeBound } from '../../mission-search.js';
import { APPROVAL_SCOPES } from '../../backends/types.js';
import { DENY_REASONS, expirePendingForMission, listPending as listPendingPermissions, parseDecisionOrigin, requestPermission, resolvePermission, type PermissionAnswer, type PermissionDecision } from '../../permissions.js';
import { decideAccess } from '../terminal-web/access.js';
import { resolve } from '../../settings.js';
import { expandSlashCommand } from '../../slash.js';
import {
  composeChatTurn,
  discardChatAttachments,
  persistChatAttachments,
  skippedAttachmentsField,
  type SkippedAttachment,
} from '../../chat-attachments.js';
import { ATTACHMENTS_UNSUPPORTED, attachmentsRefusal } from '../../backends/capabilities.js';
import { forkMission, summarizeMission } from '../../summary.js';
import { CompactBodySchema, compactOperation, defaultCompactDeps, startCompaction, type CompactDeps } from '../../mission-compact.js';
import { join } from 'node:path';
import { openGeneratedMedia } from '../../chat-media.js';
import { sendMedia } from '../../media-send.js';
import { MediaRequestSchema, addMissionMedia, mediaErrorResponse } from '../../chat-media-block.js';
import { ChatPostRequestSchema, MAX_CHAT_POST_CHARS, postAgentMessage } from '../../chat-post.js';
import { bus } from '../../bus.js';
import { providerMediaRoots } from '../../backends/provider-media.js';
import { viewerFromRequest, type DbViewer, type RequestAuth, isPersonAuth } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { auditRequest, requestActor } from '../../users/audit-actor.js';
import { conversionFormRefusal, conversionMissionOf, conversionToolCardRefusal } from '../../users/conversion-mission.js';
import { backfillTraceSpans, rebuildMissionSpans } from '../../trace-span-backfill.js';
import { recordRequestDelivery } from '../../agent-request-replies.js';
import { stopScope, StopBodySchema, UnknownScopeError } from '../../scope-stop.js';
import { buildTraceView } from '../../trace-view.js';
import { forbidden, rejectUnlessAny, requireAuth } from '../../users/identity.js';
import { RESTRICTED, canonicalPermissionMode, isKnownPermissionMode, overrideAuthority, permissionModeRefusal, rejectOverride } from '../../users/privileged-overrides.js';
import { missionPermissionState, missionPermissionSwitchable } from '../../mission-permission-mode.js';
import type { UserEventOrigin } from '../../user-origin.js';
import type { MissionTitleOrigin } from '../../mission-title-source.js';
import type { PromptPresentation } from '../../prompt-presentation.js';
import { servedIconUrl } from '../../uploads.js';
import { TitleModelBodySchema, effectiveTitleModel, instanceTitleModel, parseTitleModelChoice, serializeTitleModelChoice, titleBackends, titleChoiceRefusal } from '../../mission-title-model.js';
import { apiError } from '../../api-error.js';
import { findReplyTarget, resolveReplyTo } from '../../reply-to.js';

const TitleBodySchema = z.object({ title: z.string().max(200).nullable().optional() });
const PermissionModeBodySchema = z.object({ mode: z.string().trim().min(1).max(40) }).strict();

function extractFromMission(
  req: express.Request,
  body: { from_mission?: string; from_agent?: string },
): { fromMission: string | null; fromAgent: string | null } {
  if (req.auth?.kind === 'api-token' && req.auth.missionId) {
    const source = scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId);
    return { fromMission: source?.id ?? null, fromAgent: source?.agent_name ?? null };
  }
  const hMission = req.header('X-TIMON-Mission');
  const hAgent = req.header('X-TIMON-Agent');
  return {
    fromMission: body.from_mission ?? hMission ?? null,
    fromAgent: body.from_agent ?? hAgent ?? null,
  };
}

/**
 * SECU-USERS U-1: a mutation on `/api/missions/:id` goes through the same
 * viewer as the reads. A non-owner gets the 404 the reads already give
 * (never a 403 — existence is not disclosed), and the check precedes the
 * underlying call so "someone else's" and "absent" are the same answer.
 * `:read:all` and superadmin pass, exactly as for `GET /api/missions/:id`.
 */
function ownedMissionOr404(req: Request, res: Response): { id: string } | null {
  const m = scopedDb(viewerFromRequest(req)).getMission(req.params.id as string);
  if (!m) {
    res.status(404).json(apiError('mission_not_found', 'mission not found'));
    return null;
  }
  return { id: m.id };
}

/** One line of a mission brief, for a card. Collapses whitespace so a
 *  multi-line prompt does not paint as a blank strip. */
function missionExcerpt(mission: string | null): string {
  const flat = (mission ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > 160 ? `${flat.slice(0, 159)}\u2026` : flat;
}

/** Characters of the brief the LIST carries. The chat rail refetches the list
 *  every 10 s and only paints a title, yet full briefs made up 1.25 MB of a
 *  1.4 MB response (2026-09-26). Every list consumer shows at most 200
 *  characters, after a `TASK_ID: <uuid>` line; the full text stays on
 *  `GET /api/missions/:id`. Newlines are kept: clients pick the first line. */
export const MISSION_LIST_PREVIEW_CHARS = 300;

/** The chat's default pick: the first running candidate (they come most
 *  recent first), else the most recent one. */
export function pickLatestMission<T extends { id: string }>(
  candidates: readonly T[],
  running: (id: string) => boolean,
): T | undefined {
  return candidates.find((m) => running(m.id)) ?? candidates[0];
}

export function missionPreview(mission: string | null): string {
  const text = mission ?? '';
  if (text.length <= MISSION_LIST_PREVIEW_CHARS) return text;
  let end = MISSION_LIST_PREVIEW_CHARS - 1;
  // Never split a surrogate pair: half an emoji serialises as U+FFFD.
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}\u2026`;
}

/**
 * Who may put a media in a mission's chat (SUG-0008). Seeing a mission is not
 * enough: `missions:read` is a read grant, and every token of the launcher
 * carries it. A token must be the one issued to THIS mission; a token bound
 * to no mission writes only as a superadmin. A session writes into the
 * missions its user owns.
 */
function mayShowMedia(auth: RequestAuth | undefined, mission: Pick<MissionRow, 'id' | 'owner_user_id'>): boolean {
  if (!auth) return false;
  if (auth.kind === 'api-token') {
    if (auth.missionId) return auth.missionId === mission.id;
    return auth.isSuperadmin;
  }
  if (auth.isSuperadmin) return true;
  return isPersonAuth(auth) && auth.user !== null && mission.owner_user_id === auth.user.id;
}

function communicationAllowed(req: Request, res: Response): boolean {
  const user = req.auth?.user;
  const permission = req.method === 'GET' ? 'messages:read' : 'messages:send';
  if (user && !agentCommunicationAllowed(user, dbApi.listPermissionsForUser(user.id), permission)) {
    forbidden(req, res, { kind: 'denied', permission: ['agents:communicate', permission] });
    return false;
  }
  return true;
}

const SPAN_CURSOR = z.string().regex(SPAN_CURSOR_PATTERN);
const SpansQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(200),
  kind: z.string().min(1).max(32).optional(),
  before: SPAN_CURSOR.optional(),
  from: SPAN_CURSOR.optional(),
  // Comma-separated span ids; supersedes the window parameters.
  ids: z.string().max(6_500).transform((value) => value.split(',').filter(Boolean))
    .pipe(z.array(z.string().max(128)).max(50)).optional(),
}).refine((query) => !(query.before && query.from), { message: 'before and from are exclusive' });
const TraceQuerySchema = z.object({
  span_limit: z.coerce.number().int().min(1).max(2000).default(500),
  payload: z.enum(['0', '1']).default('1').transform((value) => value === '1'),
});

/**
 * Who may stop a scope. Whoever may launch missions may stop their own; a
 * stop only ever narrows (it blocks, settles, switches off), never grants, so
 * it does not ask for `kanban:write` or `triggers:manage` on top.
 */
const STOP_PERMISSIONS = ['missions:stop', 'missions:spawn'] as const;

function stopActor(auth: RequestAuth, viewer: DbViewer): string {
  if (auth.kind === 'daemon-token') return 'daemon';
  if (auth.kind === 'api-token' && auth.missionId) {
    return `agent ${scopedDb(viewer).getMission(auth.missionId)?.agent_name ?? auth.missionId.slice(0, 8)}`;
  }
  return auth.user?.email ?? auth.actorId ?? 'api-token';
}

/**
 * Shows a media in a mission's chat: a typed request, checked, fetched or
 * copied, kept, then announced as a typed `media` event. The address never
 * reaches the browser. Who may ask is the caller's to decide (`mayShowMedia`
 * for a request, the owner check of the plugin facade).
 */
export async function showMissionMedia(mission: MissionRow, rawBody: unknown): Promise<{ status: number; body: unknown }> {
  const parsed = MediaRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid_request', message: 'expected { src: string, caption?: string }' } };
  }
  let cwd: string | undefined;
  try { cwd = loadConfig(mission.agent_name).cwd; } catch { cwd = undefined; }
  const roots = [
    mission.cwd_override ?? cwd,
    // Folders a provider plugin opened to the agent (`ctx.provider.media.allowShow`).
    ...providerMediaRoots(mission.id),
  ].filter((root): root is string => typeof root === 'string' && root.length > 0);
  try {
    const block = await addMissionMedia(mission.id, parsed.data, { roots });
    const row = dbApi.insertEvent(mission.id, 'media', block);
    bus.publish({ kind: 'event', missionId: mission.id, type: 'media', timestamp: row.timestamp, payload: block });
    return { status: 201, body: { block } };
  } catch (err) {
    const refusal = mediaErrorResponse(err);
    if (refusal) return { status: refusal.status, body: refusal.body };
    // The message may quote the address; only the class is logged.
    console.warn(`[chat-media] unexpected failure (${(err as Error)?.name ?? 'unknown'})`);
    return { status: 500, body: { error: 'internal', message: 'the media could not be kept' } };
  }
}

/**
 * Who wrote a follow-up: a mission token is another agent (`mission_send`),
 * whose text must not pass for the human's — in the thread, and for the
 * notifications that close on the human's reply (SUG-0048). A session or the
 * daemon token is the human, as before: no origin.
 */
export function agentCallerOrigin(req: Request): UserEventOrigin | null {
  const auth = req.auth;
  if (auth?.kind !== 'api-token' || !auth.missionId) return null;
  const caller = scopedDb(viewerFromRequest(req)).getMission(auth.missionId);
  return caller ? { kind: 'agent', from: caller.agent_name, mission_id: caller.id } : null;
}

/** A person typed this turn: a session or a paired device, or the open API of a
 *  first run. Never a mission token, nor the daemon-token (CLI, scripts, plugins). */
export function personWrote(req: Pick<Request, 'auth'>, origin: UserEventOrigin | null): boolean {
  return origin === null && (!req.auth || isPersonAuth(req.auth));
}

/** What `POST /api/missions/:id/steer` takes: an instruction, and the images
 *  pasted with it (the same shape as a follow-up's). */
const SteerBodySchema = z.object({
  input: z.string().max(20_000).refine((text) => text.trim() !== ''),
  images: z.array(z.object({ media_type: z.string().max(100), data: z.string() })).max(20).optional(),
  /** The earlier message this instruction answers (`reply-to.ts`). */
  reply_to: z.unknown().optional(),
});

/** A follow-up turn as the composer sends it (`POST /api/agents/:id/send`). */
export type MissionTurnBody = {
  input: string;
  images?: Array<{ media_type: string; data: string }>;
  /** Anything that is not an image: persisted on disk, announced by
   *  its path (chat-attachments.ts). */
  attachments?: unknown;
  /** Long clipboard pastes the composer pulled out of the input. */
  pasted?: unknown;
  /** Recent spoken exchanges, when GPT-Live delegated this turn. */
  voiceContext?: unknown;
  /** `{ event_id }` of the earlier message of this mission the turn answers
   *  (`reply-to.ts`). */
  reply_to?: unknown;
};

/**
 * A turn whose agent part is not what the human wrote (a posted batch of
 * browser annotations, TODO #481): the thread keeps `text` and draws
 * `presentation`; `input` goes to the agent as it is, never expanded.
 */
export type ShownTurn = { text: string; presentation: PromptPresentation };

/**
 * Delivers a follow-up turn to a mission the caller may write to: the live
 * process, a one-shot respawn, a resume in place, or the quota fallback. The
 * one path of a chat message; who may send is the caller's to decide.
 */
export function sendMissionTurn(
  m: MissionRow,
  body: MissionTurnBody,
  inputOrigin: UserEventOrigin | null,
  shown?: ShownTurn,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // From the request on: the sender's indicator is up, and expanding a command
  // or re-testing a quota comes before anything the turn state can show.
  return whileTurnPrepares(m.id, () => deliverMissionTurn(m, body, inputOrigin, shown));
}

async function deliverMissionTurn(
  m: MissionRow,
  body: MissionTurnBody,
  inputOrigin: UserEventOrigin | null,
  shown?: ShownTurn,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Resolved first, before a backend is even chosen: a reply to a message this
  // mission does not hold is refused, never sent without its quote.
  const reply = shown ? { ok: true as const, target: null } : resolveReplyTo(m.id, body.reply_to);
  if (!reply.ok) return { status: reply.status, body: { error: reply.error, code: reply.code } };
  const { images } = body;
  const sendBackend = m.backend_override
    ?? (() => { try { return loadConfig(m.agent_name).backend; } catch { return undefined; } })()
    ?? defaultBackendName();
  const attachmentRefusal = attachmentsRefusal(sendBackend, body.attachments);
  if (attachmentRefusal) {
    return { status: 400, body: { error: attachmentRefusal, code: ATTACHMENTS_UNSUPPORTED } };
  }
  const sendCwd = m.cwd_override
    ?? (() => { try { return loadConfig(m.agent_name).cwd; } catch { return undefined; } })()
    ?? undefined;
  const slash = shown ? null : await expandSlashCommand(body.input, { cwd: sendCwd });
  if (slash?.skill) console.log(`[slash] send mission ${m.id.slice(0, 8)} with skill /${slash.skill}`);
  const skipped: SkippedAttachment[] = [];
  const persisted = shown ? [] : persistChatAttachments(m.id, body.attachments, skipped);
  const turn = slash ? composeChatTurn(slash, persisted, body.pasted, body.voiceContext, reply.target)
    : { text: body.input, presentation: shown!.presentation };
  const logMessage = shown?.text;
  // A message written in the thread continues it, session or not. A posted batch keeps its
  // own rule: a conversation without a session restarts fresh (browser-annotations/routes.ts).
  const resumeTurn = { replayContext: !shown };
  // The files stay only when the turn reached the agent: any other exit
  // (turn in flight, refused fallback, no usable backend…) leaves them with
  // no owner, announced to nobody.
  let delivered = false;
  try {
    const outcome = await sendToAgent(m.id, turn.text, images, inputOrigin, turn.presentation, logMessage, resumeTurn);
    if (outcome === 'turn_in_flight') {
      // The agent is SPEAKING. A one-shot backend has no input channel before
      // the turn ends. 409 (not 404) means "retry shortly", not a dead
      // conversation — the UI used to infer a lost mission and start a new
      // one, falling back to the agent config and losing context.
      return {
        status: 409,
        body: {
          error: 'a turn is in progress — wait for it to finish (or stop it) before sending',
          code: 'turn_in_progress',
        },
      };
    }
    if (outcome === 'no_live_process') {
      // The persistent agent process died (crash, OOM, orchestrator restart),
      // but the mission survives. Resume it IN PLACE — same missionId, its
      // session or, without one, its recorded thread — to keep history,
      // context, and stream coherent instead of letting the UI spawn a blank
      // mission that fragments the conversation.
      const resumed = await respawnWithResume(m.id, turn.text, images, inputOrigin, turn.presentation, logMessage, resumeTurn);
      if (!resumed) {
        return { status: 404, body: { error: 'no running agent for that mission' } };
      }
      delivered = true;
      return { status: 200, body: { ok: true, resumed: true, ...skippedAttachmentsField(skipped) } };
    }
    delivered = true;
    return { status: 200, body: { ok: true, ...skippedAttachmentsField(skipped) } };
  } catch (err) {
    // Quota exhausted. Do NOT wait: switch the conversation to its fallback
    // backend and send the message there. `switchMissionBackend` keeps the
    // same missionId and forwards the transcript — same thread, another CLI.
    // This keeps work moving at 1 a.m. instead of waiting for the user.
    if (err instanceof BackendExhaustedError) {
      // The row the caller already read through its own viewer.
      const fromModel = m.model_override
        ?? (() => { try { return loadConfig(m.agent_name).model ?? null; } catch { return null; } })();
      const target = fallbackFor(err.backend, {
        seriesId: dbApi.seriesIdForMission(m.id) ?? m.id,
        scope: 'orchestrator',
        fromModel,
        missionOwnerUserId: m.owner_user_id ?? null,
      });
      // The turn's files were announced by their path on this disk: a
      // fallback that cannot open them would answer as if it had read them.
      const fallbackRefusal = target ? attachmentsRefusal(target.backend, body.attachments) : null;
      let fallbackFailure: { fallback: string; reason: string } | null = null;
      if (target && fallbackRefusal) {
        const cooldown = dbApi.getBackendCooldown(err.backend);
        return {
          status: 400,
          body: {
            error: `Backend ${err.backend} is ${cooldownReason(err.backend)}, and its fallback ${target.backend} does not accept attached files: `
              + `remove the files to continue on ${target.backend}, or send again once ${err.backend} is back.`,
            code: ATTACHMENTS_UNSUPPORTED,
            backend: err.backend,
            fallback: target.backend,
            resetsAt: cooldown?.until ?? null,
          },
        };
      }
      if (target) {
        try {
          await switchMissionBackend(m.id, {
            backend: target.backend,
            model: target.model,
            message: turn.text,
            logMessage,
            inputOrigin,
            inputPresentation: turn.presentation,
            cause: 'fallback',
            causeDetail: `${err.backend} ${cooldownReason(err.backend)}`,
          });
          console.warn(
            `[send] mission ${m.id.slice(0, 8)} switched to ${target.backend} ` +
            `(${err.backend} ${cooldownReason(err.backend)}) — message delivered through fallback`,
          );
          delivered = true;
          return {
            status: 200,
            body: {
              ok: true,
              switched: { from: err.backend, backend: target.backend, model: target.model },
              // Images do not survive the switch: the resume prompt is text.
              // Say so rather than losing them silently.
              imagesDropped: Array.isArray(images) && images.length > 0,
              ...skippedAttachmentsField(skipped),
            },
          };
        } catch (switchErr) {
          // The reason leaves the daemon: same treatment as the thread's notice.
          const reason = stderrExcerpt((switchErr as Error).message);
          console.error(`[send] switch from ${m.id.slice(0, 8)} to ${target.backend} failed: ${reason}`);
          fallbackFailure = { fallback: target.backend, reason };
        }
      }
      // No usable fallback (refused, unconfigured, or also out of quota), or
      // one that would not start: only then ask the user to wait, and say until when.
      const cooldown = dbApi.getBackendCooldown(err.backend);
      const outOfService = `backend ${err.backend} is ${cooldownReason(err.backend)}`;
      return {
        status: 429,
        body: {
          error: fallbackFailure
            ? `${outOfService} and its fallback ${fallbackFailure.fallback} did not start: ${fallbackFailure.reason}`
            : `${outOfService} and no fallback is available`,
          code: 'backend_exhausted',
          backend: err.backend,
          ...(fallbackFailure ? { fallback: fallbackFailure.fallback } : {}),
          resetsAt: cooldown?.until ?? null,
        },
      };
    }
    return { status: 500, body: { error: (err as Error).message } };
  } finally {
    if (!delivered) discardChatAttachments(persisted);
  }
}

export function registerRoutes(
  app: express.IRouter,
  delegate = createDelegationHandler(),
  compactDeps: CompactDeps = defaultCompactDeps(),
): void {
  /**
   * Technical stop of one agent or one project (`scope-stop.ts`). Explicit
   * authentication: an anonymous caller is refused even on the first-run open
   * API. A non-superadmin acts on its own rows only.
   */
  app.post('/api/stop', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    if (rejectUnlessAny(req, res, STOP_PERMISSIONS)) return;
    const body = StopBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      res.status(400).json({ error: 'expected { "agent": NAME } or { "project": SLUG }' });
      return;
    }
    const viewer = viewerFromRequest(req);
    if (!viewer) { res.status(401).json({ error: 'unauthorized' }); return; }
    try {
      const report = stopScope(body.data, { owner: viewer.isSuperadmin ? undefined : viewer.id, by: stopActor(auth, viewer) });
      res.json({ ok: true, ...report });
    } catch (err) {
      if (err instanceof UnknownScopeError) { res.status(404).json({ error: err.message }); return; }
      res.status(500).json({ error: (err as Error).message });
    }
  });


  /**
   * The model that names the caller's conversations (TODO #358, part C):
   * their own choice, the instance setting and the backends that can title
   * (`eligible: false` + reason for one served remotely). Read by the Settings
   * pane. Explicit authentication: a browser session or a token; the identity
   * is `req.auth.user`, never a query parameter — nobody reads another
   * account's choice. A daemon-token with no account reads the instance view.
   */
  app.get('/api/mission-titles/model', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const userId = auth.user?.id ?? null;
    const own = dbApi.userMissionTitleModelGet(userId);
    const instance = instanceTitleModel();
    res.json({
      value: own === null ? null : parseTitleModelChoice(own),
      instance: instance.choice,
      instance_source: instance.source,
      effective: effectiveTitleModel(userId).choice,
      backends: titleBackends(),
    });
  });

  /**
   * Writes the caller's own choice: `auto`, `off`, `{ backend, model }` from
   * the eligible list, or `null` to follow the instance setting again. An
   * account is required (403 otherwise, like `/api/prefs`); the body is zod;
   * a backend that cannot title or a model it does not serve is 400.
   */
  app.put('/api/mission-titles/model', (req, res) => {
    const auth = requireAuth(req, res);
    if (!auth) return;
    const userId = auth.user?.id;
    if (!userId) {
      forbidden(req, res, { kind: 'account_required' });
      return;
    }
    const parsed = TitleModelBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'value must be "auto", "off", { backend, model } or null' });
      return;
    }
    const value = parsed.data.value;
    if (value !== null) {
      const refusal = titleChoiceRefusal(value);
      if (refusal) {
        res.status(400).json({ error: refusal.reason, code: refusal.code });
        return;
      }
    }
    dbApi.userMissionTitleModelSet(userId, value === null ? null : serializeTitleModelChoice(value));
    res.json({ value: value === null ? null : parseTitleModelChoice(serializeTitleModelChoice(value)), effective: effectiveTitleModel(userId).choice });
  });

  app.post('/api/missions', handleSpawn);
  app.post('/api/missions/delegate', delegate);

  app.get('/api/missions', (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
    const agentFilter = typeof req.query.agent === 'string' ? req.query.agent : null;
    // Statuses actually represented by the `missions.status` column. REJECT an
    // unknown value instead of filtering it silently: an empty list is
    // indistinguishable from an idle system, while a 400 explains the problem.
    const STATUSES = ['running', 'completed', 'failed', 'terminated'] as const;
    const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
    if (statusFilter && !STATUSES.includes(statusFilter as (typeof STATUSES)[number])) {
      res.status(400).json({ error: `unknown status: ${statusFilter} (expected: ${STATUSES.join(', ')})` });
      return;
    }
    // Same rule for the origin (TODO #284): `?origin=user` on a typo would
    // otherwise show every automated mission as the user's own.
    const originParam = req.query.origin;
    if (originParam !== undefined && !isMissionOriginFilter(originParam)) {
      res.status(400).json({ error: `unknown origin: ${String(originParam)} (expected: ${MISSION_ORIGIN_FILTERS.join(', ')})` });
      return;
    }
    const originFilter = originParam;
    const timing = new ServerTiming();
    const scope = scopedDb(viewerFromRequest(req));
    let rows: ReturnType<typeof scope.listMissions>;
    if (agentFilter) {
      // Exact agent filter — single agent name, highest precision.
      rows = scope.listMissions(limit, [agentFilter], statusFilter ?? undefined, originFilter);
    } else if (projectFilter) {
      const projectAgentNames = listAgents()
        .filter((a) => a.project === projectFilter)
        .map((a) => a.name);
      rows = scope.listMissions(limit, projectAgentNames, statusFilter ?? undefined, originFilter);
    } else {
      rows = scope.listMissions(limit, undefined, statusFilter ?? undefined, originFilter);
    }
    timing.mark('db');
    // Group pending permission requests by mission so each card can flag
    // "action required" and deep-link to the earliest unresolved request.
    const pendingByMission = new Map<string, { id: string; created_at: number }>();
    for (const p of listPendingPermissions()) {
      const cur = pendingByMission.get(p.mission_id);
      if (!cur || p.created_at < cur.created_at) {
        pendingByMission.set(p.mission_id, { id: p.id, created_at: p.created_at });
      }
    }
      // Cache loadConfig per request: several missions often share the same
      // agent, avoiding N reads of the same config.json from disk.
    const cfgCache = new Map<string, ReturnType<typeof loadConfig>>();
    const cfgFor = (name: string) => {
      let c = cfgCache.get(name);
      if (!c) { try { c = loadConfig(name); } catch { c = {}; } cfgCache.set(name, c); }
      return c;
    };
    const missions = rows.map((m) => {
      const pa = pendingByMission.get(m.id) ?? null;
      const cfg = cfgFor(m.agent_name);
      // Read off the row (mission_stats): per-row lookups here were most of
      // the cost of a 300-row page. Same predicate as `missionTurnEnded`.
      const resultModel = m.stats_ready === 1 ? m.last_result_model : dbApi.getLastResultModel(m.id);
      const alive = isRunning(m.id);
      // A replay Timon still owes keeps the turn open (TODO #666).
      const { turnActive, turnComplete } = clientTurnState(
        m.id, m.last_result_id !== null && m.last_result_id > (m.last_user_id ?? -1),
      );
      const fine = missionLiveness({
        status: m.status, process_alive: alive, turn_active: turnActive,
        turn_complete: turnComplete, interrupted_reason: m.interrupted_reason,
      });
      return {
        id: m.id,
        agent_name: m.agent_name,
        mission: missionPreview(m.mission),
        status: m.status,
        started_at: m.started_at,
        ended_at: m.ended_at,
        exit_code: m.exit_code,
        source_channel: m.source_channel,
        origin: m.origin,
        // TIM-0118: who the mission belongs to, joined on the already scoped
        // rows — a viewer only learns the owner of a mission it already sees.
        owner: m.owner_user_id && m.owner_name !== null
          ? { id: m.owner_user_id, name: m.owner_name, avatar_url: m.owner_avatar_url }
          : null,
        total_cost_usd: m.total_cost_usd,
        tokens_in: m.tokens_in,
        tokens_out: m.tokens_out,
        span_tools: m.span_tools,
        span_errors: m.span_errors,
        duration_ms: m.duration_ms,
        running: alive,
        // `running` = process alive; on a persistent backend it remains so
        // between turns. "Is it thinking NOW?" lives in memory, in the turn
        // state — without this field, the chat rail could animate only the open
        // mission (its own SSE stream), showing just one of two active missions.
        turn_active: turnActive,
        turn_complete: turnComplete,
        // The four facts above, folded into one label (mission-liveness.ts).
        liveness: fine.liveness,
        interrupted_reason: fine.interrupted_reason,
        ...dbApi.missionPendingWork(m.id, m.agent_name, m.status),
        event_count: m.event_count,
        pending_action_at: pa?.created_at ?? null,
        pending_action_id: pa?.id ?? null,
        task_id: m.task_id,
        task_title: m.task_title,
        title: m.title ?? null,
        title_source: m.title_source ?? null,
        // The backend CLI's own session (claude session, codex thread…), for
        // diagnosis. Same scoped rows as the rest of the list: a viewer only
        // ever reads the session of a mission it already sees.
        session_id: m.session_id ?? null,
        // The mission that launched this one (mission_spawn, or the series
        // orchestrator for a Kanban task): the chat rail groups by it.
        parent_mission_id: m.parent_mission_id ?? null,
        task_type: m.task_type,
        last_event_at: m.last_event_at,
        agent_emoji: cfg.emoji ?? null,
        agent_color: cfg.color ?? null,
        agent_icon_url: servedIconUrl(cfg.icon_url),
        agent_role: cfg.role ?? null,
        agent_role_emoji: null,
        model: resultModel ?? m.model_override ?? cfg.model ?? null,
      };
    });
    // Per-row reads (liveness, pending work, event count, agent config).
    timing.mark('enrich');
    sendTimedJson(res, timing, { missions });
  });

  /**
   * The mission a chat binds when its URL names none (`?agent=` required):
   * the agent's running mission with the most recent activity, else its most
   * recent one, setup conversations excluded — the pick the chat made from the
   * 300-row list, which it no longer has to wait for. Same window and owner
   * scope as `GET /api/missions?agent=`. Explicit authentication: an anonymous
   * caller is refused. `{ mission: null }` when the agent has none.
   *
   * Registered before `/api/missions/:id`, which would otherwise take `latest`
   * for an id.
   */
  app.get('/api/missions/latest', (req, res) => {
    if (!requireAuth(req, res)) return;
    const agent = typeof req.query.agent === 'string' ? req.query.agent.trim() : '';
    if (!agent) {
      res.status(400).json({ error: 'expected ?agent=NAME' });
      return;
    }
    const pick = pickLatestMission(scopedDb(viewerFromRequest(req)).listLatestMissionCandidates(agent), isRunning);
    res.json({
      mission: pick
        ? {
            id: pick.id,
            agent_name: pick.agent_name,
            status: pick.status,
            started_at: pick.started_at,
            last_event_at: pick.last_event_at,
            running: isRunning(pick.id),
          }
        : null,
    });
  });

  /**
   * Delegations of a mission still awaiting their return.
   *
   * `return_notified = 0` IS the state — `mission-return.ts` sets the marker
   * the moment the return is enqueued to the pilot — so a line leaves this
   * list because the work came back, not because of a heuristic.
   *
   * Three segments: the `search` before `:id` ordering above does not apply,
   * Express never matches `/api/missions/:id` against this path.
   */
  app.get('/api/missions/:id/delegations', (req, res) => {
    const scope = scopedDb(viewerFromRequest(req));
    const parent = scope.getMission(req.params.id);
    if (!parent) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const delegations = scope
      .listChildMissions(parent.id)
      .filter((c) => c.status === 'running' && c.return_notified === 0)
      .map((c) => ({ child: c, task: c.task_id ? scope.getTask(c.task_id) : null }))
      // A child running a task reports through the TASK path
      // (`wake.ts handleTaskDone`), and `enqueueMissionReturn` then returns
      // early WITHOUT setting the mission marker — so `return_notified = 0`
      // alone would keep a finished task on screen until the idle reap, ten
      // minutes later. The predicate that matters is the one the return itself
      // applies: would it still fire for this child?
      .filter(({ task }) => !task || !dbApi.isTaskReturnNotified(task.id))
      .map(({ child: c, task }) => ({
        id: c.id,
        agent_name: c.agent_name,
        started_at: c.started_at,
        running: isRunning(c.id),
        // Same distinction as GET /api/missions: the process being alive does
        // not say the agent is thinking right now.
        turn_active: clientTurnState(c.id, false).turnActive,
        task_id: c.task_id,
        task_title: task?.title ?? null,
        // A card, not a page: the brief is truncated here so no client has to
        // download a 100 000-character mission to show one line of it.
        excerpt: missionExcerpt(c.mission),
      }));
    res.json({ delegations });
  });

  app.get('/api/missions/search', (req, res) => {
    try {
      const q = String((req.query.q as string) ?? '').trim();
      if (!q) { res.json({ q: '', count: 0, hits: [], progress: dbApi.missionSearchProgress() }); return; }
      const limit = Math.min(Number(req.query.limit ?? 30), 200);
      const agentFilter = typeof req.query.agent === 'string' ? req.query.agent : null;
      const projectFilter = typeof req.query.project === 'string' ? req.query.project : null;
      let agents: string[] | undefined;
      if (agentFilter) agents = [agentFilter];
      else if (projectFilter) {
        agents = listAgents().filter((a) => a.project === projectFilter).map((a) => a.name);
      }
      const since = parseTimeBound(req.query.since as string | undefined);
      const until = parseTimeBound(req.query.until as string | undefined);
      const hits = scopedDb(viewerFromRequest(req)).searchMissions({
        q, agents, since: since ?? undefined, until: until ?? undefined, limit,
      });
      // `progress` travels with results: until backfill finishes, zero hits do
      // not mean "it does not exist", and callers must be able to distinguish it.
      res.json({ q, count: hits.length, hits, progress: dbApi.missionSearchProgress() });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/trace/:traceId', (req, res) => {
    const query = TraceQuerySchema.safeParse(req.query);
    const view = buildTraceView(scopedDb(viewerFromRequest(req)), req.params.traceId, {
      spanLimit: query.success ? query.data.span_limit : 500,
      payload: query.success ? query.data.payload : true,
    });
    if (!view) {
      res.status(404).json({ error: 'trace not found' });
      return;
    }
    if (!query.success) {
      res.status(400).json({ error: 'invalid query', issues: query.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) });
      return;
    }
    res.json(view);
  });

  app.post('/api/trace/backfill', (req, res) => {
    const body = (req.body ?? {}) as { days?: unknown; limit?: unknown };
    const days = body.days === undefined ? undefined : Number(body.days);
    const limit = body.limit === undefined ? undefined : Number(body.limit);
    if ((days !== undefined && (!Number.isFinite(days) || days < 0))
      || (limit !== undefined && (!Number.isFinite(limit) || limit < 1))) {
      res.status(400).json({ error: 'days and limit must be positive numbers' });
      return;
    }
    res.json(backfillTraceSpans({ days, limit }));
  });

  app.post('/api/missions/search/reindex', (req, res) => {
    try {
      const batch = Number((req.body as { batch?: number } | undefined)?.batch ?? 500);
      res.json(dbApi.reindexMissionSearch(batch));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  /**
   * `?view=` picks what `events` carries (mission-events-view.ts):
   * - `chat` (default): the journal minus the per-token rows
   *   (`thinking_tokens`, `tool_progress`, `system/status`) and minus every
   *   `init` / `rate_limit_event` but the last. Every reader of this route —
   *   the chat, the missions page, `timon status|wait`, `mission_wait`, the
   *   channels — only reads `assistant` / `user` / `result` and the cards;
   *   one long mission went from 108 623 rows (28.8 MB) to 359.
   * - `raw`: every stored row, for diagnosis.
   * - `status`: everything below EXCEPT `events`. `timon wait` polls it every
   *   1.5 s for two booleans.
   * Same handler, so the same `getMission`: the access control cannot drift
   * between the views. An unknown view is a 400, not a silent default.
   *
   * `?tail=N[&before=<eventId>]` pages the `chat` view from its end
   * (mission-history-page.ts, docs/MISSION-HISTORY-PAGES.md): `has_more`,
   * `oldest_event_id`, plus the `prelude` of the tail page or the later
   * `resolutions` of an older one.
   */
  app.get('/api/missions/:id', (req, res) => {
    const view = parseMissionView(req.query.view);
    if (!view) {
      res.status(400).json({ error: `unknown view (expected: ${MISSION_VIEWS.join(', ')})` });
      return;
    }
    const history = parseHistoryQuery({ tail: req.query.tail, before: req.query.before, after: req.query.after });
    if (!history.ok) {
      res.status(400).json({ error: 'invalid query', issues: history.issues });
      return;
    }
    const query = history.value;
    if (query && view !== 'chat') {
      res.status(400).json({ error: 'tail, before and after only page the chat view' });
      return;
    }
    const timing = new ServerTiming();
    const m = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!m) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const lightView = view === 'status';
    const delta = query && isDeltaQuery(query) ? readHistoryDelta(m.id, query.after) : null;
    const paging = query && !isDeltaQuery(query) ? query : null;
    const page = paging ? readHistoryPage(m.id, paging) : null;
    const rows = delta ? delta.rows : page ? page.rows : lightView ? [] : view === 'raw' ? dbApi.listEvents(m.id) : dbApi.listChatEvents(m.id);
    timing.mark('db');
    let pageFields: Record<string, unknown> = {};
    if (delta) pageFields = { reset: delta.reset, newest_event_id: delta.newest_event_id };
    if (page && paging) {
      const asEvent = (e: EventRow) => ({ id: e.id, type: e.type, timestamp: e.timestamp, payload: JSON.parse(e.payload) as unknown });
      pageFields = { has_more: page.has_more, oldest_event_id: page.oldest_event_id };
      if (paging.before === null) {
        if (page.has_more && page.oldest_event_id !== null) {
          const prelude = readHistoryPrelude(m.id, page.oldest_event_id, { backend: m.backend_override, model: m.model_override });
          pageFields.prelude = { ...prelude, events: prelude.events.map(asEvent) };
        }
      } else {
        pageFields.resolutions = readLaterResolutions(m.id, page.rows).map(asEvent);
      }
      timing.mark('history');
    }
    const events = rows.map((e) => ({
      id: e.id,
      type: e.type,
      timestamp: e.timestamp,
      payload: JSON.parse(e.payload),
    }));
    timing.mark('parse');
    // turn_active reflects "is the agent currently working on this turn"
    // (between user-input and result). Persistent-backend missions can be
    // running=true (process alive) but turn_active=false (waiting for next
    // user message). The UI relies on this to restore the 'thinking'
    // bubble when the user navigates away mid-turn and comes back.
    const turn = getTurnState(m.id);
    // A replay Timon still owes keeps the turn open: the failed `result` it
    // replays is not the answer `mission_wait` / `timon wait` stop on (TODO #666).
    const { turnActive, turnComplete } = clientTurnState(m.id, dbApi.missionTurnEnded(m.id));
    const fine = missionLiveness({
      status: m.status, process_alive: isRunning(m.id), turn_active: turnActive,
      turn_complete: turnComplete, interrupted_reason: m.interrupted_reason,
    });
    const pendingForMission = listPendingPermissions(m.id);
    const pa = pendingForMission.length
      ? pendingForMission.reduce((a, b) => (a.created_at < b.created_at ? a : b))
      : null;
    const children = scopedDb(viewerFromRequest(req)).listChildMissions(m.id).map((c) => ({
      id: c.id,
      agent_name: c.agent_name,
      status: c.status,
      started_at: c.started_at,
    }));
    const body = {
      id: m.id,
      agent_name: m.agent_name,
      mission: m.mission,
      status: m.status,
      started_at: m.started_at,
      ended_at: m.ended_at,
      exit_code: m.exit_code,
      source_channel: m.source_channel,
      source_meta: m.source_meta ? JSON.parse(m.source_meta) : null,
      parent_mission_id: m.parent_mission_id,
      parent_agent: m.parent_agent,
      task_id: m.task_id,
      routine_id: m.routine_id,
      origin: dbApi.getMissionOrigin(m.id),
      owner: dbApi.missionOwner(m.owner_user_id),
      title: m.title ?? null,
      title_source: m.title_source ?? null,
      // Actual directory where the mission runs when it differs from the
      // agent's cwd (a task worktree). The UI needs it to open the terminal in
      // the right place; otherwise it would offer the main repository.
      cwd_override: m.cwd_override,
      children,
      total_cost_usd: m.total_cost_usd,
      tokens_in: m.tokens_in,
      tokens_out: m.tokens_out,
      backend_override: m.backend_override,
      model_override: m.model_override,
      reasoning_effort: m.reasoning_effort,
      running: isRunning(m.id),
      turn_active: turnActive,
      turn_preparing: turnPreparing(m.id),
      turn_since: turn?.turnSince ?? null,
      pending_action_at: pa?.created_at ?? null,
      pending_action_id: pa?.id ?? null,
      // Persisted end-of-turn marker: `status` alone says nothing once the
      // backend keeps its process alive between turns. cf. mission-turn-end.test.ts
      turn_complete: turnComplete,
      liveness: fine.liveness,
      interrupted_reason: fine.interrupted_reason,
      ...dbApi.missionPendingWork(m.id, m.agent_name, m.status),
      ...(lightView ? {} : { events }),
      ...pageFields,
    };
    timing.mark('state');
    sendTimedJson(res, timing, body);
  });

  // Paginated: a mission can hold hundreds of thousands of spans (2f20744c) and
  // the timeline used to receive all of them, payloads included, on every
  // refresh. No cursor = the most recent page, and rows never carry the wide
  // input/output/error columns: the span opened in the UI comes from the
  // detail route below.
  // One message of a conversation, whole: what the agent reads back when a
  // reply names an earlier message that left its context (`reply-to.ts`).
  // Same scope as reading the mission; another mission's row is a 404.
  app.get('/api/missions/:id/messages/:eventId', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const eventId = z.coerce.number().int().positive().safeParse(req.params.eventId);
    if (!eventId.success) {
      res.status(400).json(apiError('invalid_event_id', 'eventId must be a positive integer'));
      return;
    }
    const target = findReplyTarget(mission.id, eventId.data);
    if (!target) {
      res.status(404).json(apiError('message_not_found', 'no message with that id in this conversation'));
      return;
    }
    res.json({ mission_id: mission.id, ...target });
  });

  app.get('/api/missions/:id/spans', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const query = SpansQuerySchema.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'invalid query', issues: query.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`) });
      return;
    }
    const { limit, kind, before, from, ids } = query.data;
    if (ids) {
      const spans = dbApi.listSpansByIds(mission.id, ids);
      res.json({ mission_id: mission.id, spans, total: spans.length, has_more: false });
      return;
    }
    const page = dbApi.listSpansPage(mission.id, { limit, kind, before, from });
    res.json({ mission_id: mission.id, ...page, pruned: dbApi.prunedSpanCount(mission.id) });
  });

  // Retention removed this timeline and someone wants it back: same viewer as
  // the read above, and only a derived index is written. A mission that still
  // has spans is refused rather than replayed over them.
  app.post('/api/missions/:id/spans/rebuild', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    if (dbApi.prunedSpanCount(mission.id) === 0 || dbApi.listSpansPage(mission.id, { limit: 1 }).total > 0) {
      res.status(409).json({ error: 'this mission has no removed timeline to rebuild' });
      return;
    }
    res.json(rebuildMissionSpans(mission));
  });

  app.get('/api/missions/:id/spans/:spanId', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    const span = mission ? dbApi.getSpan(mission.id, req.params.spanId) : undefined;
    if (!mission || !span) {
      res.status(404).json({ error: 'span not found' });
      return;
    }
    res.json({ mission_id: mission.id, span });
  });

  // Media the chat shows (SUG-0008). Ownership first, through the same viewer
  // as every read: someone else's mission and an absent one are both a 404.
  // Only files this daemon kept are served, by the name it minted.
  app.get('/api/missions/:id/media/:file', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    sendMedia(req, res, () => openGeneratedMedia(mission.id, req.params.file), true);
  });

  // An agent shows a media in its chat: a typed request, checked, fetched or
  // copied, kept, then announced as a typed `media` event. The address never
  // reaches the browser.
  app.post('/api/missions/:id/media', async (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    if (!mayShowMedia(req.auth, mission)) {
      forbidden(req, res, { kind: 'scope', reason: 'only this mission\'s agent or its owner can show media in it' });
      return;
    }
    const reply = await showMissionMedia(mission, req.body);
    res.status(reply.status).json(reply.body);
  });

  // An agent posts a message in its own chat (`chat_post_message`): an ordinary
  // agent bubble, written by the daemon (`chat-post.ts`). Only the token
  // issued to THIS mission writes it: these are the agent's words, which no
  // session, other mission or daemon-token may put in its mouth.
  app.post('/api/missions/:id/messages', (req, res) => {
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!mission) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    if (req.auth?.kind !== 'api-token' || req.auth.missionId !== mission.id) {
      forbidden(req, res, { kind: 'scope', reason: 'only this mission\'s agent can post a message in its chat' });
      return;
    }
    const parsed = ChatPostRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(apiError('invalid_request', `expected { text: string } with 1 to ${MAX_CHAT_POST_CHARS} characters`));
      return;
    }
    const row = postAgentMessage(mission.id, parsed.data.text, 'chat_post_message');
    res.status(201).json({ posted: true, event_id: row.id });
  });

  app.post('/api/agents/:id/send', async (req, res) => {
    const body = req.body as MissionTurnBody;
    if (typeof body?.input !== 'string') {
      res.status(400).json({ error: 'input (string) required' });
      return;
    }
    // Slash chat command (see handleSpawn) — rewrites the follow-up turn. cwd =
    // mission override (worktree), otherwise the agent cwd.
    const m = scopedDb(viewerFromRequest(req)).getMission(req.params.id);
    if (!m) {
      res.status(404).json(apiError('mission_not_running', 'no running agent for that mission'));
      return;
    }
    const origin = agentCallerOrigin(req);
    const outcome = await sendMissionTurn(m, body, origin);
    if (outcome.status < 300 && personWrote(req, origin)) dbApi.markMissionUserEngaged(m.id);
    res.status(outcome.status).json(outcome.body);
  });

  // Redirect the turn that is running (TODO #488). A follow-up message (`/send`)
  // waits for the turn's end; this does not — whatever the backend, see
  // `steerMission` for how each one takes it.
  app.post('/api/missions/:id/steer', async (req, res) => {
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    // Its own turn holds the tool call asking for this: stopping it would cut the
    // call, and a one-process-per-turn CLI would die with the answer on its way.
    if (req.auth?.kind === 'api-token' && req.auth.missionId === owned.id) {
      res.status(400).json(apiError('steer_self', 'a mission cannot redirect its own turn: act on the instruction instead'));
      return;
    }
    const parsed = SteerBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'input (non-empty string, 20000 characters at most) required' });
      return;
    }
    const reply = resolveReplyTo(owned.id, parsed.data.reply_to);
    if (!reply.ok) {
      res.status(reply.status).json(reply.code === 'invalid_reply_to'
        ? apiError('invalid_reply_to', reply.error)
        : apiError('reply_target_not_found', reply.error));
      return;
    }
    const turn = reply.target
      ? composeChatTurn({ expanded: parsed.data.input }, [], undefined, undefined, reply.target)
      : { text: parsed.data.input, presentation: undefined };
    try {
      const origin = agentCallerOrigin(req);
      const { outcome, method } = await steerMission(owned.id, turn.text, origin, parsed.data.images, turn.presentation);
      if (outcome === 'steered') {
        if (personWrote(req, origin)) dbApi.markMissionUserEngaged(owned.id);
        res.json({ ok: true, method });
        return;
      }
      if (outcome === 'unsupported') {
        res.status(400).json(apiError('steer_unsupported', 'this agent cannot be redirected right now: queue the message instead'));
        return;
      }
      if (outcome === 'no_turn') {
        res.status(409).json(apiError('no_turn_to_steer', 'no turn is running: send a normal message instead'));
        return;
      }
      res.status(404).json(apiError('mission_not_running', 'no running agent for that mission'));
    } catch (err) {
      if (err instanceof BackendExhaustedError) {
        res.status(400).json({ error: err.message, code: 'steer_unsupported' });
        return;
      }
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/missions/:id/interrupt', (req, res) => {
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    // BEFORE SIGTERM: an open Allow/Deny card would survive the interruption,
    // and the conversation would resume with a phantom request that the user
    // could resolve pointlessly (the tool use it governed died with the
    // process). Exit does publish `mission_complete`, which expires cards — but
    // only while the mission is still `running`; do not rely on that here.
    expirePendingForMission(owned.id);
    const outcome = interruptAgent(owned.id);
    if (outcome.status === 'not_found') {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    res.json({ ok: true, ...outcome });
  });

  app.delete('/api/missions/:id', (req, res) => {
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const outcome = killAgent(owned.id, { source: 'DELETE /api/missions/:id', actor: requestActor(req) });
    if (outcome !== 'not_found') auditRequest(req, 'mission.kill', owned.id);
    if (outcome === 'not_found') {
      res.status(404).json(apiError('mission_not_running', 'no running agent for that mission'));
      return;
    }
    // `closed`: no process to kill, but the database row was still `running` —
    // finalize it. The caller deserves to know which of the two it was.
    res.json({ ok: true, outcome });
  });

  app.post('/api/missions/:id/summarize', async (req, res) => {
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const { force } = (req.body ?? {}) as { force?: boolean };
    try {
      const out = await summarizeMission(owned.id, { force: !!force });
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/missions/:id/fork', async (req, res) => {
    const body = (req.body ?? {}) as {
      agent?: string;
      message?: string;
      backend?: string;
      model?: string;
      reasoning_effort?: string | null;
    };
    if (!body.agent) {
      res.status(400).json({ error: 'agent (target name) required' });
      return;
    }
    // The fork copies the source transcript into a mission of the caller:
    // the source must be visible to them, or the read scope is bypassed.
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    try {
      const out = await forkMission({
        sourceMissionId: owned.id,
        targetAgent: body.agent,
        continuation: body.message,
        backendOverride: body.backend ?? null,
        modelOverride: body.model ?? null,
        reasoningEffort: body.reasoning_effort ?? null,
      });
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /**
   * Compact a conversation (docs/MISSION-COMPACT.md): natively in the same
   * mission when its backend can and the caller keeps its LLM, otherwise a
   * forced summary then a fork. Answers 202 at once; the phases follow as
   * `compact_progress` on the mission's stream. Explicit authentication, then
   * the same ownership rule as `/summarize` and `/fork` (404 for someone
   * else's mission).
   */
  app.post('/api/missions/:id/compact', (req, res) => {
    if (!requireAuth(req, res)) return;
    const parsed = CompactBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json(apiError('invalid_body', 'expected { backend?, model?, reasoning_effort?, message? } (strings)'));
      return;
    }
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    try {
      const out = startCompaction(owned.id, parsed.data, compactDeps);
      res.status(out.status).json(out.body);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  /** The compaction under way, or the one that ended in the last 15 minutes
   *  (`null` otherwise): what a client that reloads reads to resume its bar. */
  app.get('/api/missions/:id/compact', (req, res) => {
    if (!requireAuth(req, res)) return;
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    res.json({ operation: compactOperation(owned.id) });
  });

  /**
   * Rename by hand: the title becomes `manual`, which no automatic source
   * (generated, native) ever overwrites. An empty or null title clears it AND
   * its source, so the list falls back to the first message; it does not
   * re-arm the one-shot generation, which belongs to the first turn
   * (docs/MISSION-TITLES.md). The writer is the account behind the request,
   * or the mission the token names.
   */
  app.post('/api/missions/:id/title', (req, res) => {
    const parsed = TitleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'title must be a string of at most 200 characters, or null' });
      return;
    }
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const title = typeof parsed.data.title === 'string' ? parsed.data.title.replace(/\s+/g, ' ').trim().slice(0, 200) : '';
    const origin: MissionTitleOrigin = req.auth?.kind === 'api-token' && req.auth.missionId
      ? { kind: 'agent', id: req.auth.missionId }
      : { kind: 'user', id: req.auth?.user?.id ?? null };
    dbApi.setMissionTitle(owned.id, title || null, origin);
    // What the write left: a name is `manual`, an empty one clears both.
    res.json({ ok: true, title: title || null, title_source: title ? 'manual' : null });
  });

  app.post('/api/missions/:id/model', async (req, res) => {
    const raw = (req.body ?? {}) as { model?: unknown };
    const model = typeof raw.model === 'string' ? raw.model.trim() : '';
    if (!model) {
      res.status(400).json({ error: 'model required' });
      return;
    }
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    try {
      const out = await setMissionModel(owned.id, model);
      if (!out) {
        res.status(404).json(apiError('mission_not_found', 'mission not found'));
        return;
      }
      res.json({ ok: true, ...out });
    } catch (err) {
      // Only throw path: the model/backend mismatch guard.
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/missions/:id/reasoning-effort', async (req, res) => {
    const raw = (req.body ?? {}) as { effort?: unknown };
    const effort = typeof raw.effort === 'string' ? raw.effort.trim() : null;
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    try {
      dbApi.setMissionReasoningEffort(owned.id, effort);
      res.json({ ok: true });
    } catch (err) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
    }
  });

  /*
   * Permission mode of a running mission (TODO #430). Authentication is the
   * daemon middleware's (session cookie, mission token or the CLI's daemon
   * token — an anonymous request never reaches here); `ownedMissionOr404`
   * then scopes it to the owner, and the level itself takes the spawn grid
   * (`privileged-overrides.ts`): the safe modes for everyone, the others only
   * with `agents:privileged-config`, and never above the caller's own level.
   */
  app.get('/api/missions/:id/permission-mode', (req, res) => {
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const state = missionPermissionState(owned.id, overrideAuthority(req));
    if (!state) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    res.json({ ok: true, ...state });
  });

  app.post('/api/missions/:id/permission-mode', (req, res) => {
    const parsed = PermissionModeBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'mode must be a permission mode name' });
      return;
    }
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const wanted = parsed.data.mode;
    // Fail closed: a typo must not read as "no ceiling".
    if (!isKnownPermissionMode(wanted)) {
      res.status(400).json({ error: `unknown permission mode: ${wanted}` });
      return;
    }
    const mode = canonicalPermissionMode(wanted);
    const refusal = permissionModeRefusal(mode, overrideAuthority(req));
    if (refusal) {
      rejectOverride(req, res, 'mission.permission_mode_denied', `mission:${owned.id}`, refusal);
      return;
    }
    if (!missionPermissionSwitchable(owned.id)) {
      res.status(409).json({ error: 'this backend cannot change its permission mode during a mission' });
      return;
    }
    const previous = missionPermissionState(owned.id, RESTRICTED)?.mode ?? null;
    dbApi.setMissionPermissionModeOverride(owned.id, mode);
    // Takes effect from the next message: a one-shot CLI reads it at its next
    // spawn, a persistent one is relaunched on its session by `sendToAgent`.
    res.json({ ok: true, mode, previous });
  });

  /** What a switch onto `backend` would do to the context, without doing it.
   *  The UI asks before showing its confirmation: the user is entitled to
   *  know whether their thread crosses whole, and how big it is, BEFORE
   *  choosing — not to discover it in a notice afterwards. */
  app.get('/api/missions/:id/switch-preview', async (req, res) => {
    const backend = typeof req.query.backend === 'string' ? req.query.backend.trim() : '';
    const target = asBackendName(backend);
    if (!target) {
      res.status(400).json({ error: `unknown backend "${backend}"` });
      return;
    }
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    const choice = req.query.context_mode === 'transcript' || req.query.context_mode === 'summary'
      ? req.query.context_mode
      : 'auto';
    const plan = await planSwitchContext(owned.id, target, choice);
    res.json({
      ok: true,
      mode: plan.mode,
      transcriptTokens: plan.transcriptTokens,
      transcriptBytes: plan.transcriptBytes,
      thresholdTokens: plan.thresholdTokens,
      // `Infinity` has no JSON form: null says "no ceiling" without lying
      // with a number.
      limitBytes: Number.isFinite(plan.hardBytes) ? plan.hardBytes : null,
      fitsWhole: plan.fitsWhole,
      ...(plan.reason ? { reason: plan.reason } : {}),
    });
  });

  app.post('/api/missions/:id/backend', async (req, res) => {
    const raw = (req.body ?? {}) as {
      backend?: unknown; model?: unknown; message?: unknown; context_mode?: unknown;
    };
    const backend = typeof raw.backend === 'string' ? raw.backend.trim() : '';
    if (!backend) {
      res.status(400).json({ error: 'backend required' });
      return;
    }
    // Anything unrecognised falls back to `auto`: an automated caller (quota
    // fallback, workflow) doesn't state a preference and must keep the
    // historical arbitration.
    const contextMode = raw.context_mode === 'transcript' || raw.context_mode === 'summary'
      ? raw.context_mode
      : 'auto';
    const owned = ownedMissionOr404(req, res);
    if (!owned) return;
    try {
      const out = await switchMissionBackend(owned.id, {
        backend,
        model: typeof raw.model === 'string' ? raw.model : null,
        message: typeof raw.message === 'string' ? raw.message : null,
        contextMode,
      });
      if (!out) {
        res.status(404).json(apiError('mission_not_found', 'mission not found'));
        return;
      }
      res.json({ ok: true, ...out });
    } catch (err) {
      // 429 = the target is dry: nothing moved, and the toast says until when.
      if (err instanceof BackendExhaustedError) {
        const until = dbApi.getBackendCooldown(err.backend)?.until ?? null;
        res.status(429).json({
          error: `backend ${err.backend} is ${cooldownReason(err.backend)}${until ? ` until ${messageDateTime(until)}` : ''}: the conversation stays where it is`,
          code: 'backend_exhausted',
          backend: err.backend,
          resetsAt: until,
        });
        return;
      }
      // 409 = turn in progress, safe to retry as-is. 413 = the whole
      // transcript was demanded and physically doesn't fit — the caller
      // must choose the summary itself, we don't decide for it. 400 =
      // backend/model refused.
      const status = err instanceof TurnInFlightError ? 409
        : err instanceof ContextTooLargeError ? 413
          : 400;
      res.status(status).json({ error: (err as Error).message });
    }
  });

  app.post('/api/messages', async (req, res) => {
    if (!communicationAllowed(req, res)) return;
    const body = req.body as {
      to_agent?: string;
      to_mission?: string | null;
      payload?: unknown;
      kind?: 'msg' | 'request' | 'response';
      in_reply_to?: string;
      from_mission?: string;
      from_agent?: string;
      trace_id?: string;
    };
    const toAgent = body.to_agent;
    const payload = body.payload;
    if (typeof toAgent !== 'string' || payload === undefined) {
      res.status(400).json({ error: 'to_agent and payload required' });
      return;
    }
    const { fromMission, fromAgent } = extractFromMission(req, body);
    if (!fromMission || !fromAgent) {
      res.status(400).json({ error: 'from_mission/from_agent required (header X-TIMON-Mission or body)' });
      return;
    }
    if (body.to_mission && !scopedDb(viewerFromRequest(req)).getMission(body.to_mission)) {
      res.status(404).json({ error: 'recipient mission not found' });
      return;
    }
    const { randomUUID } = await import('node:crypto');
    const id = randomUUID();
    const message = {
      id,
      fromMission,
      fromAgent,
      toAgent,
      toMission: body.to_mission ?? null,
      kind: body.kind ?? 'msg',
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      inReplyTo: body.in_reply_to ?? null,
      traceId: body.trace_id ?? null,
    };
    let row;
    try {
      row = sendAgentMessage(message, scopedDb(viewerFromRequest(req)).enqueueMessage);
    } catch (err) {
      // Both names come from the caller. Unvalidated, an agent addressing a
      // name that only exists in the other home got a raw SQLite constraint
      // back, which killed the SENDING mission (03/09/2026).
      if (err instanceof UnknownAgentError) {
        res.status(404).json({ error: err.message });
        return;
      }
      // A cross-team refusal is a rule, not a failure: 403 and the two names,
      // so the sending agent reads why and stops retrying.
      if (err instanceof CrossTeamError) {
        forbidden(req, res, {
          kind: 'scope', reason: err.message,
          hint: 'Message an agent of your own team, or ask the operator to put both agents in the same team.',
        });
        return;
      }
      if (err instanceof UnknownMissionError || err instanceof InvalidReplyError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
    // `agent_message` is now published centrally by enqueueMessage (db.ts).
    res.status(201).json({ message_id: row.id, created_at: row.created_at });
  });

  app.get('/api/messages', (req, res) => {
    if (!communicationAllowed(req, res)) return;
    const to = String(req.query.to ?? '');
    if (!to) {
      res.status(400).json({ error: 'to (agent name) required' });
      return;
    }
    const status = req.query.status
      ? (String(req.query.status) as 'pending' | 'picked' | 'expired' | 'held')
      : undefined;
    const fromAgent = req.query.from ? String(req.query.from) : undefined;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const scope = scopedDb(viewerFromRequest(req));
    // `to=*` → inbox of ALL agents at once (cross-agent pending view).
    const rows =
      to === '*'
        ? scope.listAllInbox({ status, limit })
        : scope.listInbox(to, { status, fromAgent, limit });
    // The inbox UI badges each message by origin; the sender mission tells a
    // routine-driven message apart from a hand-written one. Missions are
    // resolved once per distinct id, not once per row.
    const senders = new Map<string, ReturnType<typeof scope.getMission>>();
    const messages = rows.map((row) => {
      if (!senders.has(row.from_mission)) senders.set(row.from_mission, scope.getMission(row.from_mission));
      return { ...row, origin: messageOrigin(row, senders.get(row.from_mission)) };
    });
    res.json({ messages });
  });

  app.post('/api/messages/:id/pick', (req, res) => {
    if (!communicationAllowed(req, res)) return;
    const row = scopedDb(viewerFromRequest(req)).pickMessage(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'message not found or already picked' });
      return;
    }
    const { fromMission } = extractFromMission(req, {});
    const mission = fromMission ? scopedDb(viewerFromRequest(req)).getMission(fromMission) : null;
    if (mission && row.kind === 'request' && row.to_agent === mission.agent_name
        && row.owner_user_id === mission.owner_user_id) {
      const event = dbApi.insertEvent(mission.id, 'inbox_request_delivery', { message_id: row.id });
      recordRequestDelivery(mission.id, event.id, [row.id]);
    }
    res.json({ message: row });
  });

  app.get('/api/messages/:id', (req, res) => {
    if (!communicationAllowed(req, res)) return;
    const row = scopedDb(viewerFromRequest(req)).getMessage(req.params.id);
    if (!row) {
      res.status(404).json({ error: 'message not found' });
      return;
    }
    res.json({ message: row });
  });

  app.post('/api/permissions/request', async (req, res) => {
    // Called by bin/permission-mcp.mjs (running as a stdio MCP subprocess
    // of claude). Long-polls until the user resolves it in the UI.
    const body = req.body as {
      mission_id?: string; agent?: string;
      tool_name?: string; input?: unknown; tool_use_id?: string;
    };
    if (!body.mission_id || !body.tool_name || !body.tool_use_id) {
      res.status(400).json({ error: 'mission_id, tool_name and tool_use_id are required' });
      return;
    }
    // audit CLI/MCP P3-17: `body.mission_id` is client-controlled (the shim forwards it). A
    // mission-bound token may only ask for ITS OWN mission — anything else would
    // let a token for mission A inject a permission card for a sibling mission B
    // it does not own. The token's `missionId` is written by the daemon, so it is
    // the value to trust; the request body is not.
    if (req.auth?.kind === 'api-token' && req.auth.missionId
        && req.auth.missionId !== body.mission_id) {
      forbidden(req, res, { kind: 'scope', reason: 'mission_id differs from the mission this token belongs to', hint: 'Ask for permission on your own mission only.' });
      return;
    }
    const conversion = conversionMissionOf(req);
    const formRefusal = conversion ? conversionFormRefusal(body.input) : null;
    if (formRefusal) {
      forbidden(req, res, { kind: 'scope', reason: formRefusal, hint: 'Ask with the question tool.' });
      return;
    }
    // Its shell, write or fetch never becomes a card a person could allow (TODO #469): denied
    // here, before any card, the auto-allow and the remembered approvals.
    const toolRefusal = conversion ? conversionToolCardRefusal(body.tool_name) : null;
    if (toolRefusal) {
      dbApi.insertEvent(body.mission_id, 'permission_conversion_denied', { tool_name: body.tool_name, tool_use_id: body.tool_use_id });
      res.json({ behavior: 'deny', message: toolRefusal });
      return;
    }
    // Disable HTTP timeouts on this socket — the MCP shim relies on us holding
    // the response open until the user clicks. Node's default reqTimeout is
    // already 0 for express, but proxies in front might add one.
    req.setTimeout(0);
    res.setTimeout(0);
      // Definitive 410: if the mission is finished and no decision has been
      // persisted for this tool_use_id, blocking or recreating a phantom card
      // is pointless — tell the shim to stop retrying. (A still-`running`
      // mission, or an already-persisted recoverable decision, goes through.)
    const m = scopedDb(viewerFromRequest(req)).getMission(body.mission_id);
    if (m && m.status !== 'running'
        && !dbApi.findResolvedPermission(body.mission_id, body.tool_use_id)) {
      res.status(410).json({ error: 'mission finished — permission expired' });
      return;
    }
    if (!conversion && req.auth?.kind === 'api-token' && req.auth.missionId === body.mission_id
        && m && m.owner_user_id === req.auth.user?.id && developerAutoAllows(req.auth.user, body.tool_name)) {
      dbApi.insertEvent(m.id, 'permission_dev_allowed', {
        tool_name: body.tool_name, tool_use_id: body.tool_use_id,
        auth_kind: req.auth.kind, user_id: req.auth.user!.id,
      });
      res.json({ behavior: 'allow', updatedInput: body.input ?? {} });
      return;
    }
    // The shim closes this socket when its client cancels the call (or when it
    // dies): the card must not stay pending for nobody (TIM-0098). `res`, not
    // `req`: the request's own `close` fires as soon as its body is read.
    const waiting = new AbortController();
    res.on('close', () => { if (!res.writableEnded) waiting.abort(); });
    try {
      const decision = await requestPermission({
        mission_id: body.mission_id,
        agent: body.agent ?? '',
        tool_name: body.tool_name,
        input: body.input ?? {},
        tool_use_id: body.tool_use_id,
        // The claude CLI answers allow or deny, once: Timon keeps the wider ones.
        timonScopes: true,
        signal: waiting.signal,
      });
      if (waiting.signal.aborted) return;
      // The claude CLI validates this answer: a scope is Timon's to keep,
      // never a key the CLI was told about.
      if (decision.behavior === 'allow' && decision.scope) {
        const { scope: _scope, ...plain } = decision;
        res.json(plain);
        return;
      }
      res.json(decision);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/permissions', (req, res) => {
    const missionId = typeof req.query.mission_id === 'string' ? req.query.mission_id : undefined;
    // Cards belong to the mission they govern: only the missions the caller
    // can read are listed (SECU-USERS U-1, same family as the mutations).
    const scope = scopedDb(viewerFromRequest(req));
    const pending = listPendingPermissions(missionId).filter((p) => !!scope.getMission(p.mission_id));
    res.json({ pending });
  });

  app.post('/api/permissions/:id/resolve', (req, res) => {
    const body = req.body as { behavior?: unknown } & Partial<Omit<PermissionDecision, 'behavior'>> & {
      updatedInput?: unknown;
      message?: string;
      /** Action that originated the decision — see DECISION_ORIGINS (permissions.ts). */
      origin?: unknown;
      /** A wider Allow than "this once", only one the card listed (`scopes`). */
      scope?: unknown;
    };
    const scope = APPROVAL_SCOPES.find((candidate) => candidate === body.scope);
    if (body.scope !== undefined && !scope) {
      res.status(400).json({ error: 'scope must be "session" or "always"' });
      return;
    }
    if (scope && body.behavior !== 'allow') {
      res.status(400).json({ error: 'a scope goes with "allow" only' });
      return;
    }
    let decision: PermissionAnswer;
    if (body.behavior === 'paste') {
      decision = { behavior: 'paste' };
    } else if (body.behavior === 'allow') {
      decision = { behavior: 'allow', updatedInput: body.updatedInput, ...(scope ? { scope } : {}) };
    } else if (body.behavior === 'deny') {
      // Deliberately NEUTRAL default: the old "denied by user" attributed a
      // Refusing attribution to the human on every deny path, including paths
      // where they saw nothing (incident 2026-08-21). A client that knows the
      // cause sends its own `message` — this is the chat card's case.
      decision = {
        behavior: 'deny',
        message: typeof body.message === 'string' && body.message.trim() !== ''
          ? body.message
          : DENY_REASONS.noMessage,
      };
    } else {
      res.status(400).json({ error: 'behavior must be "allow", "deny" or "paste"' });
      return;
    }
    // Resolving someone else's Allow/Deny card would approve a tool use in a
    // mission the caller cannot even read: unknown card and foreign card
    // answer the same 404.
    const pending = listPendingPermissions().find((p) => p.id === req.params.id);
    const governed = pending ? scopedDb(viewerFromRequest(req)).getMission(pending.mission_id) : undefined;
    if (!pending || !governed) {
      res.status(404).json(apiError('permission_request_gone', 'permission request not found (already resolved or expired)'));
      return;
    }
    // Only what the card offered: a scope the agent never listed is not a thing
    // it understands, and granting it would be a decision nobody was asked.
    if (scope && !pending.scopes?.includes(scope)) {
      res.status(400).json({ error: `this request does not offer the scope "${scope}"` });
      return;
    }
    // A wider Allow is a standing grant over the owner's missions: given by the
    // owner, from their browser. Not by an agent's own token (it would approve
    // itself for good), nor the daemon token, nor an admin reading the mission.
    if (scope) {
      const owner = governed.owner_user_id;
      const viewer = isPersonAuth(req.auth) ? req.auth.user : null;
      if (!viewer || (owner && viewer.id !== owner)) {
        res.status(req.auth ? 403 : 401).json({ error: 'forbidden', message: "only the mission owner's browser can widen an approval" });
        return;
      }
    }
    if (decision.behavior === 'paste') {
      if (!pending.choices?.includes('paste')) {
        res.status(400).json({ error: 'this request offers no "paste"' });
        return;
      }
      // Pasting opens the owner's own terminal: the web terminal's rule holds
      // (a human browser session, `terminal:open`), and only for the mission's
      // owner. Neither the daemon token nor an admin reading the mission.
      const access = decideAccess(req.auth);
      const owner = governed.owner_user_id;
      if ('denied' in access || !owner || access.user.id !== owner) {
        res.status(req.auth ? 403 : 401).json({ error: 'forbidden', message: "only the mission owner's browser can paste a command" });
        return;
      }
    }
    const answeredBy = viewerFromRequest(req)?.id;
    const ok = resolvePermission(
      req.params.id, decision, parseDecisionOrigin(body.origin),
      answeredBy ? { kind: 'user', id: answeredBy } : undefined,
    );
    if (!ok) {
      res.status(404).json(apiError('permission_request_gone', 'permission request not found (already resolved or expired)'));
      return;
    }
    res.json({ ok: true });
  });
}
