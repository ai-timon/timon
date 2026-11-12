/**
 * A message an agent posts in its own chat through a tool call: the
 * `chat_post_message` tool, or the `message` field of `question` and
 * `kanban_plan`.
 *
 * Why a tool and not the turn's text: a long text a reasoning model writes
 * right before a tool call can land INSIDE its thinking block, which the CLI
 * only forwards summarised. The raw transcript then holds `thinking` and
 * `tool_use`, no `text`, and the user opens the form without the report it was
 * meant to read first (07/11/2026, mission 00ce007e). A tool's arguments are
 * always transmitted whole.
 *
 * The message is stored as an ordinary `assistant` event: the chat draws it
 * as the agent's prose (same markdown, tables included), the search indexes
 * it, a reply can quote it, and a replay shows it where it was. It is the
 * daemon that writes it, whatever the backend, and only into the mission the
 * caller's token belongs to.
 */
import { z } from 'zod';
import { bus } from './bus.js';
import { dbApi, type EventRow } from './db.js';

/**
 * Same ceiling as a follow-up the user types (`SteerBodySchema`): room for a
 * report with a comparison table, while one call can never push an unbounded
 * payload through the events table and every open stream.
 */
export const MAX_CHAT_POST_CHARS = 20_000;

/** What a posted message may be: markdown text, non-blank, bounded. */
export const ChatPostTextSchema = z.string().trim().min(1).max(MAX_CHAT_POST_CHARS);

/** `POST /api/missions/:id/messages`. */
export const ChatPostRequestSchema = z.object({ text: ChatPostTextSchema }).strict();

/** Which tool call brought the message, kept on the event for the trace. */
export type ChatPostVia = 'chat_post_message' | 'question' | 'kanban_plan';

/** The persisted payload: the normalised shape every backend's prose has. */
export type ChatPostPayload = {
  type: 'assistant';
  message: { role: 'assistant'; content: Array<{ type: 'text'; text: string }> };
  timon_posted: ChatPostVia;
};

export function chatPostPayload(text: string, via: ChatPostVia): ChatPostPayload {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    timon_posted: via,
  };
}

/**
 * Writes the message in the mission's thread and announces it on the bus,
 * with its row id: a reply to it anchors on that id like on any prose.
 * `text` must already have passed `ChatPostTextSchema`.
 */
export function postAgentMessage(missionId: string, text: string, via: ChatPostVia): EventRow {
  const payload = chatPostPayload(text, via);
  const row = dbApi.insertEvent(missionId, 'assistant', payload);
  bus.publish({ kind: 'event', missionId, type: 'assistant', timestamp: row.timestamp, payload, id: row.id });
  return row;
}

/**
 * The `message` field of a form payload (`question`, `kanban_plan`): `null`
 * when the field is absent or blank — a blank message is no reason to refuse
 * the question — else the text to post, or a named defect.
 */
export function formMessageOf(input: unknown): { text: string } | { defect: string } | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const raw = (input as { message?: unknown }).message;
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') return { defect: 'field `message` is not a string' };
  if (raw.trim() === '') return null;
  const parsed = ChatPostTextSchema.safeParse(raw);
  if (!parsed.success) return { defect: `field \`message\` is longer than ${MAX_CHAT_POST_CHARS} characters` };
  return { text: parsed.data };
}

/** The form payload without its `message`: the card shows the questions only. */
export function withoutFormMessage(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input) || !('message' in input)) return input;
  const { message: _message, ...rest } = input as Record<string, unknown>;
  return rest;
}
