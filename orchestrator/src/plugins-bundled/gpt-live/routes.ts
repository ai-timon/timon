/**
 * `/api/gpt-live/*` — status of the voice layer, and the WebRTC session
 * exchange with OpenAI.
 *
 * Every route demands a real identity, even on a first-run install where the
 * rest of the API is still open: opening a session spends money on the key
 * held in the vault, and an anonymous caller must never be able to do that.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { bus } from '../../bus.js';
import { dbApi } from '../../db.js';
import { vaultEnabled } from '../../secrets/availability.js';
import { readSecretValue } from '../../secrets/store.js';
import { settingBool } from '../../settings.js';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { apiError } from '../../api-error.js';

/** Vault entry the key is read from. Fixed: the settings UI writes it there. */
export const GPT_LIVE_SECRET = 'OPENAI_GPT_LIVE_API_KEY';
export const GPT_LIVE_SETTING = 'TIMON_GPT_LIVE_ENABLED';
export const GPT_LIVE_MODEL = 'gpt-live-1';
const OPENAI_LIVE_URL = 'https://api.openai.com/v1/live/sessions';
/** Event type of a spoken turn in a mission's history. Its own type, not a
 *  fake `user` event: those feed resumes, backend switches and summaries as
 *  if the agent had been told them, and a voice-only exchange never was. */
export const VOICE_TRANSCRIPT_EVENT = 'voice_transcript';

/** Voice-layer prompt, in the structure OpenAI recommends (live-prompting):
 *  the three delegation labels are kept verbatim because the model is trained
 *  on them. The mission's agent holds the task rules; this prompt only decides
 *  what GPT-Live may answer alone and what it must hand over. */
export const DEFAULT_INSTRUCTIONS = `You are the voice of Timon, a personal assistant. Speak warmly and naturally, clearly and concisely, at an unhurried pace.
The real work is done by a backend agent that runs in the user's current conversation, with the user's files, projects and memory.
Answer in the language the user speaks.

Backchannel policy: Use light backchannels. Acknowledge naturally without competing with the user.

Interruption policy: Stop speaking when the user interrupts. Listen to what they say.

Delegation policy:
Backend tools:
- Files and code: read, search, write and change files and code in the user's projects.
- Commands: run commands, tests and builds on the user's machine.
- Projects and tasks: the state of the user's projects, missions, tasks and agents.
- Memory: the user's notes, past decisions and earlier conversations.
- Web: search the web and read pages for current facts.
- Actions: anything that changes something for the user (create, send, schedule, delete).

Delegate to the backend when:
- The request is about the user's projects, files, code, tasks, notes or memory.
- The user asks to do, change, run, create or check something.
- The answer is a fact you would have to look up or verify, or anything that may have changed recently.
- The user refers to earlier work, a previous result, or "this" project or file.
- A correction changes work already requested.

Do not delegate to the backend when:
- The user greets you, chats casually, or thanks you.
- You can answer from general knowledge that does not depend on the user's data or on recent events.
- You need a brief clarification to understand the request.
- The user asks you to repeat or rephrase a result already given.

Delegate before giving an answer that depends on backend work.
Do not guess the result while waiting.
Never say you are looking, checking or doing something unless you delegate it in the same turn: you cannot see the screen, the chat or the user's files yourself. If the user asks you to look at something, delegate.
While the backend works, say briefly that you are on it; do not fill the silence with speculation.
When its result arrives, say the essentials naturally. Code, lists and long details stay in the chat: say they are there rather than reading them aloud.
The backend also answers requests the user typed in the chat, or that came from elsewhere. Those results can reach you without you asking: say their essentials the same way.`;

/** OpenAI's ceiling for `session.input` is 128 messages and 8,192 tokens.
 *  ~3 characters a token (French) under the token cap keeps a margin. */
const MAX_HISTORY_MESSAGES = 40;
const MAX_HISTORY_CHARS = 20_000;

const HistoryMessage = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().trim().min(1).max(4_000),
});

const SessionBody = z.object({
  sdp: z.string().min(1).max(64_000),
  /** Optional extra context from the chat (agent name, language). */
  instructions: z.string().max(4_000).optional(),
  /** Latest text messages of the chat, oldest first, so the voice picks up
   *  the thread instead of starting blank. */
  history: z.array(HistoryMessage).max(MAX_HISTORY_MESSAGES).optional(),
});

type LiveInputMessage = {
  type: 'message';
  role: 'user' | 'assistant';
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>;
};

/** Newest messages kept whole until the character budget runs out; the ones
 *  that do not fit are dropped from the oldest end, never cut mid-message. */
export function toLiveInput(history: ReadonlyArray<z.infer<typeof HistoryMessage>>): LiveInputMessage[] {
  const kept: LiveInputMessage[] = [];
  let budget = MAX_HISTORY_CHARS;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const { role, text } = history[i]!;
    if (text.length > budget) break;
    budget -= text.length;
    kept.unshift({
      type: 'message',
      role,
      content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }],
    });
  }
  return kept;
}

const TimelineMs = z.number().int().min(0).max(24 * 3_600_000);

const VoiceTranscriptBody = z.object({
  /** `voice` is what GPT-Live actually said aloud (its output transcript). */
  role: z.enum(['user', 'voice']),
  text: z.string().trim().min(1).max(4_000),
  startMs: TimelineMs.optional(),
  endMs: TimelineMs.optional(),
  /** Browser-minted id of the bubble already on screen, so the echo coming
   *  back through the stream does not paint it a second time. */
  clientId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  /** GPT-Live reading out an answer the agent already wrote in the thread:
   *  kept for the record, hidden from the thread so it is not shown twice. */
  relay: z.boolean().optional(),
});

type LiveAnswer = { session?: { id?: unknown }; transport?: { sdp?: unknown } };

/** The key, or null when absent. A global row wins over scoped duplicates,
 *  which the daemon has no agent or project to pick between. */
export function readGptLiveKey(): string | null {
  if (!vaultEnabled()) return null;
  const rows = dbApi.getSecretsByName(GPT_LIVE_SECRET);
  if (rows.length === 0) return null;
  const row = rows.find((r) => r.grants.some((g) => g.scope_kind === 'global')) ?? rows[0]!;
  try {
    const value = readSecretValue(row.id).trim();
    return value || null;
  } catch {
    return null;
  }
}

function status(): { enabled: boolean; hasKey: boolean; secretName: string; model: string } {
  return {
    enabled: settingBool(GPT_LIVE_SETTING),
    hasKey: readGptLiveKey() !== null,
    secretName: GPT_LIVE_SECRET,
    model: GPT_LIVE_MODEL,
  };
}

export type LiveFetch = (url: string, init: RequestInit) => Promise<globalThis.Response>;

export function registerRoutes(router: Router, deps: { fetch?: LiveFetch } = {}): void {
  const doFetch: LiveFetch = deps.fetch ?? ((url, init) => fetch(url, init));

  router.get('/api/gpt-live/status', (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    res.json(status());
  });

  router.post('/api/gpt-live/session', async (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    // Talking to a mission is sending it messages: same gate as spawning one.
    if (rejectIfDenied(req, res, 'missions:spawn')) return;
    const parsed = SessionBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(apiError('gpt_live_session_invalid', 'an SDP offer is required, with at most 40 history messages')); return; }
    if (!settingBool(GPT_LIVE_SETTING)) { res.status(409).json(apiError('gpt_live_disabled', 'GPT-Live is disabled')); return; }
    const key = readGptLiveKey();
    if (!key) { res.status(409).json(apiError('gpt_live_no_key', `no ${GPT_LIVE_SECRET} in the secrets vault`, { secret: GPT_LIVE_SECRET })); return; }

    const instructions = parsed.data.instructions
      ? `${DEFAULT_INSTRUCTIONS}\n\n${parsed.data.instructions}`
      : DEFAULT_INSTRUCTIONS;
    const history = toLiveInput(parsed.data.history ?? []);
    let upstream: globalThis.Response;
    try {
      upstream = await doFetch(OPENAI_LIVE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          session: {
            model: GPT_LIVE_MODEL,
            instructions,
            delegation: { type: 'client' },
            ...(history.length > 0 ? { input: history } : {}),
          },
          transport: { type: 'webrtc', sdp: parsed.data.sdp },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      res.status(502).json(apiError('gpt_live_unreachable', 'OpenAI is unreachable'));
      return;
    }
    if (!upstream.ok) {
      // Status only: an upstream error body may echo request details, and the
      // key must never ride back in a message.
      console.warn(`[gpt-live] session creation failed: HTTP ${upstream.status}`);
      const message = `OpenAI refused the session (HTTP ${upstream.status})`;
      const refusal = upstream.status === 401 ? apiError('gpt_live_bad_key', message)
        : upstream.status === 429 ? apiError('gpt_live_rate_limited', message)
          : apiError('gpt_live_refused', message, { status: upstream.status });
      res.status(502).json({ ...refusal, upstreamStatus: upstream.status });
      return;
    }
    const answer = (await upstream.json().catch(() => ({}))) as LiveAnswer;
    const sdp = typeof answer.transport?.sdp === 'string' ? answer.transport.sdp : null;
    if (!sdp) { res.status(502).json(apiError('gpt_live_no_answer', 'OpenAI returned no SDP answer')); return; }
    const sessionId = typeof answer.session?.id === 'string' ? answer.session.id : null;
    res.status(201).json({ sessionId, sdp });
  });

  // The spoken exchange is written into the mission's history, never sent to
  // its agent: GPT-Live answered those turns itself, and the ones it delegated
  // reach the agent as ordinary messages through `/api/agents/:id/send`.
  router.post('/api/missions/:id/voice-transcript', (req: Request, res: Response) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'missions:spawn')) return;
    const mission = scopedDb(viewerFromRequest(req)).getMission(req.params.id as string);
    // Someone else's mission and a missing one get the same answer.
    if (!mission) { res.status(404).json(apiError('mission_not_found', 'mission not found')); return; }
    const parsed = VoiceTranscriptBody.safeParse(req.body ?? {});
    if (!parsed.success) { res.status(400).json(apiError('gpt_live_transcript_invalid', 'a role and a non-empty text (4000 characters max) are required')); return; }
    if (!settingBool(GPT_LIVE_SETTING)) { res.status(409).json(apiError('gpt_live_disabled', 'GPT-Live is disabled')); return; }
    const { role, text, startMs, endMs, clientId, relay } = parsed.data;
    const payload = {
      type: VOICE_TRANSCRIPT_EVENT,
      role,
      text,
      start_ms: startMs ?? null,
      end_ms: endMs ?? null,
      client_id: clientId ?? null,
      ...(relay && role === 'voice' ? { relay: true } : {}),
    };
    const row = dbApi.insertEvent(mission.id, VOICE_TRANSCRIPT_EVENT, payload);
    bus.publish({ kind: 'event', missionId: mission.id, type: VOICE_TRANSCRIPT_EVENT, timestamp: row.timestamp, payload });
    res.status(201).json({ id: row.id, timestamp: row.timestamp });
  });
}
