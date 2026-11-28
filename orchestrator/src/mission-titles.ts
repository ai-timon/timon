/**
 * Automatic mission titles (TODO #358): a short, readable name for every
 * conversation the user opens by hand, shown by the missions list instead of
 * the truncated first message.
 *
 * Rank of the sources — see `mission-title-source.ts` —: manual > preset >
 * native > generated. This module owns the lowest one: a one-shot asked at the
 * end of the FIRST turn (`turn_complete`), on `oneShotPrompt` (`summary.ts`),
 * never a parallel mission. It is asynchronous, off the turn's path, bounded by
 * a short timeout and silent on failure (a log line, never a user error).
 *
 * What never generates: a mission the machine started — a Kanban task, a
 * routine or trigger, an agent delegating or waking up, a workflow node, the
 * daemon's own housekeeping. The exclusion is by ORIGIN (`getMissionOrigin`,
 * the list's own SQL: lineage columns and spawn channel), never by matching the
 * text of the brief, which the next prefix would break.
 *
 * First turn only: a mission whose events already hold more than one user
 * message is past it — an old conversation resumed, a mission that predates
 * the feature — and is skipped before anything is claimed. The migration also
 * marks every mission that predates the column as claimed: no backfill, by
 * decision (quota), and no one-shot on the next message to a 6 000-row history.
 *
 * Idempotence: `claimMissionTitleGeneration` is a conditional UPDATE taken
 * before the one-shot — a replayed turn, a second `turn_complete`, two daemons
 * racing on the same row: one generation at most. And the write of the result
 * goes through `setMissionTitleIfUnclaimed`, whose WHERE re-checks the rank:
 * a rename that lands while the one-shot runs wins the race whatever the order.
 */
import { dbApi, type MissionRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent-config.js';
import { bus, type BusEvent } from './bus.js';
import { settingNum } from './settings.js';
import { resolveMissionTitleLlm } from './mission-title-model.js';

/** Upper bound of a generated title, in characters: a list row, not a summary. */
export const MISSION_TITLE_MAX_CHARS = 80;
/** How much of the first message the title model reads. Enough for the ask, never a whole brief. */
const PROMPT_EXCERPT_CHARS = 2_000;

export const TITLE_SYSTEM_PROMPT = `You name conversations for a list of past conversations.
Read the user's first message and answer with a title of 4 to 6 words that says what they asked for.
Write the title in the language of the message. Output the title alone: no quotes, no trailing period,
no explanation, no markdown, one line.`;

/** What the one-shot needs to know of the mission to run on its own LLM. */
export type TitleOneShot = (agentName: string, cfg: AgentConfig, userMessage: string, systemPrompt: string, timeoutMs: number) => Promise<string>;

export type MissionTitleDeps = {
  /** The one-shot runner; injected by the tests, `oneShotPrompt` otherwise. */
  oneShot?: TitleOneShot;
  /** Decides backend and model for a mission; `resolveMissionTitleLlm` (account choice > instance setting > auto) by default. */
  resolveLlm?: (mission: MissionRow) => { backend: string; model: string | null } | 'off';
};

/**
 * Makes one line of a model's answer: first non-empty line, surrounding quotes
 * and a trailing period dropped, whitespace collapsed, cut at the bound. Empty
 * when the model answered nothing usable (a refusal paragraph is still kept:
 * a long title is better than none, the cut bounds it).
 */
export function sanitizeTitle(raw: string): string {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  let t = line.replace(/^\s*(?:title\s*:\s*)?/i, '').replace(/\s+/g, ' ').trim();
  // french-ok: French guillemets are among the quotes a model wraps a title in
  t = t.replace(/^["'“”‘’«»`]+/, '').replace(/["'“”‘’«»`]+$/, '').trim();
  t = t.replace(/[.。]+$/, '').trim();
  if (t.length > MISSION_TITLE_MAX_CHARS) t = `${t.slice(0, MISSION_TITLE_MAX_CHARS - 1).trimEnd()}…`;
  return t;
}

/** The mission the user opened by hand — the only kind that gets a generated title. */
export function missionTitleEligible(mission: MissionRow): boolean {
  if (mission.task_id || mission.routine_id || mission.workflow_run_id || mission.parent_mission_id) return false;
  return dbApi.getMissionOrigin(mission.id) === 'user';
}

/** The excerpt of the first message the model reads. */
export function titlePromptExcerpt(firstMessage: string): string {
  const flat = firstMessage.replace(/\s+/g, ' ').trim();
  return flat.length > PROMPT_EXCERPT_CHARS ? `${flat.slice(0, PROMPT_EXCERPT_CHARS)}…` : flat;
}

async function defaultOneShot(agentName: string, cfg: AgentConfig, userMessage: string, systemPrompt: string, timeoutMs: number): Promise<string> {
  const { oneShotPrompt } = await import('./summary.js');
  return oneShotPrompt(agentName, cfg, userMessage, systemPrompt, undefined, timeoutMs);
}

/** Whether the turn that just ended was the mission's first: the kickoff is its only user message so far. */
export function missionOnFirstTurn(missionId: string): boolean {
  return dbApi.countUserTurns(missionId) <= 1;
}

/**
 * Generates and stores the title of ONE mission, once. Returns what happened:
 * `skipped` (already claimed, already titled, past its first turn, automated,
 * or generation off), `written`, `kept` (the one-shot ran but a higher-ranked
 * title had landed meanwhile, or the answer was empty) or `failed` (the
 * one-shot threw; logged).
 */
export async function generateMissionTitle(
  missionId: string,
  deps: MissionTitleDeps = {},
): Promise<'skipped' | 'written' | 'kept' | 'failed'> {
  const mission = dbApi.getMission(missionId);
  if (!mission || mission.title || mission.title_generation) return 'skipped';
  // Past the first turn: nothing is claimed either — the count only grows, so
  // the mission stays out, and a later rule (#383 / #384) may still name it.
  if (!missionOnFirstTurn(missionId)) return 'skipped';
  if (!missionTitleEligible(mission)) return 'skipped';
  const llm = (deps.resolveLlm ?? resolveMissionTitleLlm)(mission);
  if (llm === 'off') return 'skipped';
  // The claim comes AFTER the cheap checks (an automated mission never claims,
  // so a later rule may still title it) and BEFORE the one-shot.
  if (!dbApi.claimMissionTitleGeneration(missionId)) return 'skipped';
  const excerpt = titlePromptExcerpt(mission.mission);
  if (!excerpt) return 'kept';
  let cfg: AgentConfig;
  try { cfg = loadConfig(mission.agent_name); } catch { cfg = {}; }
  cfg = { ...cfg, backend: llm.backend as AgentConfig['backend'], model: llm.model ?? undefined, reasoningEffort: undefined };
  const timeoutMs = settingNum('TIMON_MISSION_TITLE_TIMEOUT_MS');
  try {
    const raw = await (deps.oneShot ?? defaultOneShot)(mission.agent_name, cfg, excerpt, TITLE_SYSTEM_PROMPT, timeoutMs);
    const title = sanitizeTitle(raw);
    if (!title) return 'kept';
    return dbApi.setMissionTitleIfUnclaimed(missionId, title, 'generated') ? 'written' : 'kept';
  } catch (err) {
    console.warn(`[mission-titles] ${missionId}: title generation failed: ${(err as Error).message}`);
    return 'failed';
  }
}

/**
 * Listens for the end of a turn and titles the mission if it is its first one.
 * Fire-and-forget: the turn's own handlers never wait for the model. Returns
 * the disposer; the pending generations are tracked so a test can await them.
 */
export function startMissionTitles(deps: MissionTitleDeps = {}): { stop: () => void; idle: () => Promise<void> } {
  const pending = new Set<Promise<unknown>>();
  const onBus = (ev: BusEvent): void => {
    if (ev.kind !== 'turn_complete' || ev.outcome === 'failed' || ev.outcome === 'cancelled') return;
    const run = generateMissionTitle(ev.missionId, deps)
      .catch((err) => { console.warn(`[mission-titles] ${ev.missionId}: ${(err as Error).message}`); })
      .finally(() => { pending.delete(run); });
    pending.add(run);
  };
  bus.on('event', onBus);
  return {
    stop: () => { bus.off('event', onBus); },
    idle: async () => { while (pending.size) await Promise.all([...pending]); },
  };
}

/** What the re-title prompt reads: the current title, then the opening and the latest exchanges. */
const REGEN_MESSAGE_CHARS = 600;
const REGEN_EDGE_MESSAGES = 3;

export const REGENERATE_SYSTEM_PROMPT = `You name conversations for a list of past conversations.
You get the current title (it may be poor) and the first and the latest messages of the conversation.
Answer with a title of 4 to 6 words that says what the conversation is about now.
Write the title in the language of the messages. Output the title alone: no quotes, no trailing period,
no explanation, no markdown, one line.`;

/** Plain text of a user or assistant event; tool results and nested sub-agent turns give none. */
function eventText(type: string, payloadJson: string): string {
  let payload: { parent_tool_use_id?: unknown; message?: { content?: unknown } } | null;
  try { payload = JSON.parse(payloadJson) as typeof payload; } catch { return ''; }
  if (!payload || payload.parent_tool_use_id) return '';
  const content = payload.message?.content;
  let text = '';
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) {
    text = content
      .filter((b): b is { type: 'text'; text: string } => !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text' && typeof (b as { text?: unknown }).text === 'string')
      .map((b) => b.text).join('\n');
  }
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  const cut = flat.length > REGEN_MESSAGE_CHARS ? `${flat.slice(0, REGEN_MESSAGE_CHARS)}…` : flat;
  return `${type === 'user' ? 'User' : 'Assistant'}: ${cut}`;
}

/** Bounded prompt of a re-title: current title, first and last messages (never the middle of a long run). */
export function regeneratePromptInput(mission: MissionRow): string {
  const lines: string[] = [];
  for (const ev of dbApi.listChatEvents(mission.id)) {
    if (ev.type !== 'user' && ev.type !== 'assistant') continue;
    const line = eventText(ev.type, ev.payload);
    if (line) lines.push(line);
  }
  if (!lines.length) lines.push(`User: ${titlePromptExcerpt(mission.mission)}`);
  const picked = lines.length <= REGEN_EDGE_MESSAGES * 2
    ? lines
    : [...lines.slice(0, REGEN_EDGE_MESSAGES), '[…]', ...lines.slice(-REGEN_EDGE_MESSAGES)];
  const head = mission.title ? `Current title: ${mission.title}\n\n` : '';
  return `${head}${picked.join('\n')}`;
}

export type RegenerateOutcome =
  | { status: 'written'; title: string }
  | { status: 'kept'; title: string | null }
  | { status: 'protected'; source: 'manual' | 'preset' }
  | { status: 'off' }
  | { status: 'failed'; reason: 'quota' | 'unavailable' };

/**
 * The user asks for a new title. Same pipeline and model setting as the
 * first-turn one-shot, but explicit: it does not claim or re-arm the one-shot,
 * and it works on any mission the user may see. A `manual` or `preset` title
 * is protected unless `force` is set. Errors are classified, never echoed: a
 * provider message may carry a secret.
 */
export async function regenerateMissionTitle(
  missionId: string,
  opts: { force?: boolean } = {},
  deps: MissionTitleDeps = {},
): Promise<RegenerateOutcome | null> {
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  const force = opts.force === true;
  if (!force && (mission.title_source === 'manual' || mission.title_source === 'preset')) {
    return { status: 'protected', source: mission.title_source };
  }
  const llm = (deps.resolveLlm ?? resolveMissionTitleLlm)(mission);
  if (llm === 'off') return { status: 'off' };
  let cfg: AgentConfig;
  try { cfg = loadConfig(mission.agent_name); } catch { cfg = {}; }
  cfg = { ...cfg, backend: llm.backend as AgentConfig['backend'], model: llm.model ?? undefined, reasoningEffort: undefined };
  const timeoutMs = settingNum('TIMON_MISSION_TITLE_TIMEOUT_MS');
  try {
    const raw = await (deps.oneShot ?? defaultOneShot)(mission.agent_name, cfg, regeneratePromptInput(mission), REGENERATE_SYSTEM_PROMPT, timeoutMs);
    const title = sanitizeTitle(raw);
    if (!title) return { status: 'failed', reason: 'unavailable' };
    if (dbApi.setMissionTitleRegenerated(missionId, title, force)) return { status: 'written', title };
    // Not written: a rename landed meanwhile, or the model found the same title.
    const now = dbApi.getMission(missionId);
    if (!force && (now?.title_source === 'manual' || now?.title_source === 'preset')) return { status: 'protected', source: now.title_source };
    return { status: 'kept', title: now?.title ?? null };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    console.warn(`[mission-titles] ${missionId}: title regeneration failed: ${msg.slice(0, 200)}`);
    return { status: 'failed', reason: /quota|rate.?limit|exhaust|credit|429/i.test(msg) ? 'quota' : 'unavailable' };
  }
}
