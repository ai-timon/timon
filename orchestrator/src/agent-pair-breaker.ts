/**
 * Circuit breaker on repetitive agent↔agent exchanges.
 *
 * Requests and correlated responses wake their recipient (wake.ts), and nothing
 * bounded what two agents could say to each other without a human in between. Tester
 * incident of 07/10/2026: two agents kept messaging and waking each other,
 * each turn costing a full LLM call, and textual "STOP" requests did not end
 * it — any reply is itself a message that wakes the other side.
 *
 * Rule: per UNORDERED pair of agents (A→B and B→A are the same loop), at most
 * TIMON_WAKE_PAIR_MAX_MESSAGES agent-written messages within a sliding window
 * of TIMON_WAKE_PAIR_WINDOW_MS. The message that crosses the ceiling trips the
 * pair: it and every later message between the two are moved to `held` (out of
 * `pending`, hence out of every delivery path), and the user is alerted once.
 *
 * The trip is LATCHED until a human input reaches one of the two agents (a
 * chat message, or an idea pushed from the TO DO). A purely sliding window
 * would let the loop restart at the ceiling rate every window, re-alerting
 * each time. Held messages are not released on reset: they are the loop's
 * output, and delivering them would restart it at once — they stay readable
 * in the inbox.
 *
 * Only messages agents write to each other count. Task and mission returns,
 * wake recaps, system alerts, TO DO pushes and workflow reports are exempt:
 * they are how the daemon reports work, not a conversation.
 *
 * State is in memory: a daemon restart clears the counters and latches (held
 * messages stay held, their status is durable).
 */
import { dbApi } from './db.js';
import { messageOrigin } from './message-origin.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { settingNum } from './settings.js';

const PAIR_MAX_MESSAGES = (): number => settingNum('TIMON_WAKE_PAIR_MAX_MESSAGES');
const PAIR_WINDOW_MS = (): number => settingNum('TIMON_WAKE_PAIR_WINDOW_MS');

type PairState = {
  agents: [string, string];
  /** Timestamps of the counted messages still inside the window. */
  sentAt: number[];
  tripped: boolean;
};
const pairs = new Map<string, PairState>();

export type PairMessage = {
  id: string;
  from_agent: string;
  to_agent: string;
  from_mission?: string | null;
  payload: string;
};

/** `wake`: deliver as usual. `held`: stopped by the breaker, do not wake. */
export type PairAdmission = 'wake' | 'held';

function norm(agent: string): string {
  return agent.toLowerCase();
}

function pairKey(a: string, b: string): string {
  return [norm(a), norm(b)].sort().join('\u0000');
}

/**
 * Count `msg` against its pair and decide whether it may wake its recipient.
 * Must run synchronously on the `agent_message` bus event, before any flush
 * can read the inbox.
 */
export function admitAgentMessage(msg: PairMessage, now: number = Date.now()): PairAdmission {
  const origin = messageOrigin(msg);
  // An idea pushed from the TO DO is the user speaking to that agent.
  if (origin === 'cockpit') {
    resetAgentPairs(msg.to_agent);
    return 'wake';
  }
  if (origin !== 'agent' || msg.id.startsWith('workflow-report:')) return 'wake';
  if (norm(msg.from_agent) === norm(msg.to_agent)) return 'wake';

  const key = pairKey(msg.from_agent, msg.to_agent);
  let st = pairs.get(key);
  if (!st) {
    st = { agents: [msg.from_agent, msg.to_agent], sentAt: [], tripped: false };
    pairs.set(key, st);
  }
  if (st.tripped) {
    dbApi.holdMessage(msg.id);
    return 'held';
  }
  const windowMs = PAIR_WINDOW_MS();
  st.sentAt = st.sentAt.filter((t) => now - t < windowMs);
  st.sentAt.push(now);
  const max = PAIR_MAX_MESSAGES();
  if (st.sentAt.length <= max) return 'wake';

  st.tripped = true;
  dbApi.holdMessage(msg.id);
  const [a, b] = st.agents;
  console.warn(`[wake] agent pair ${a} ↔ ${b}: ${st.sentAt.length} messages in the window — held`);
  notifyUser(
    `Agent loop stopped: ${a} ↔ ${b}`,
    [
      `\`${a}\` and \`${b}\` exchanged ${st.sentAt.length} messages within`,
      `${Math.round(windowMs / 60_000)} min with no human input. Their messages are now held`,
      `in the inbox (status "held") and neither agent wakes the other any more.`,
      ``,
      `Write to either agent in the chat to resume them. Held messages are not`,
      `redelivered. Ceiling: TIMON_WAKE_PAIR_MAX_MESSAGES (${max}),`,
      `window: TIMON_WAKE_PAIR_WINDOW_MS.`,
    ].join('\n'),
    {
      fromMission: msg.from_mission ?? null,
      message: daemonMessage('agent_pair_loop_stopped', {
        a, b, count: st.sentAt.length, minutes: Math.round(windowMs / 60_000), max,
      }),
    },
  );
  return 'held';
}

/** A human spoke to `agent`: every pair it belongs to starts from zero. */
export function resetAgentPairs(agent: string): void {
  const a = norm(agent);
  for (const [key, st] of pairs) {
    if (norm(st.agents[0]) !== a && norm(st.agents[1]) !== a) continue;
    if (st.tripped) console.log(`[wake] agent pair ${st.agents[0]} ↔ ${st.agents[1]} resumed by a human input`);
    pairs.delete(key);
  }
}

const INPUT_KEYS = new Set(['type', 'message', 'origin']);

/**
 * Was this `user` chat event typed by a human?
 *
 * Two kinds of `user` events reach the bus. Inputs pushed into an agent's
 * stdin, written by the daemon with exactly `{ type, message, origin? }`; and
 * events the CLIs stream back — tool results every turn (an agent sending a
 * message is a tool call), sub-agent prompts — which carry extra keys
 * (`session_id`, `parent_tool_use_id`) or `tool_result` blocks. Mistaking the
 * latter for a human would reset the pair on every turn of the very loop the
 * breaker is meant to stop.
 *
 * Among inputs, the daemon stamps an `origin` with a sender on every text it
 * injects itself (wake digest, mission return, dispatcher brief); its absence
 * is what the chat reads as the human's own bubble. A presentation alone (the
 * human typed a slash command) is still the human.
 */
export function isHumanInput(payload: unknown): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  if (p.type !== 'user' || Object.keys(p).some((k) => !INPUT_KEYS.has(k))) return false;
  const content = (p.message as { content?: unknown } | undefined)?.content;
  const typed = typeof content === 'string'
    || (Array.isArray(content) && content.length > 0 && content.every((b) => {
      const t = (b as { type?: unknown } | null)?.type;
      return t === 'text' || t === 'image';
    }));
  if (!typed) return false;
  const origin = p.origin;
  if (!origin || typeof origin !== 'object') return true;
  const o = origin as { kind?: unknown; from?: unknown };
  return !(typeof o.kind === 'string' && o.kind && typeof o.from === 'string' && o.from);
}

/** Forget every pair (wake loop stop, tests). */
export function clearAgentPairs(): void {
  pairs.clear();
}
