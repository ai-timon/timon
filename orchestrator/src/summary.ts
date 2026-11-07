/**
 * Cross-provider continuation: summarize a mission's transcript and fork
 * it onto another agent (typically with a different backend).
 *
 * Why: a provider's `session_id`s are opaque to the others — one cannot
 * be passed to another. TIMON therefore rebuilds the conversation from its own
 * events table, asks the *current* backend for a compact summary, then spawns
 * a fresh mission on the target agent, primed with that summary.
 *
 * NOT to be confused with `switchMissionBackend` (agent.ts): switching LLM
 * mid-way no longer goes through here by default. The switch keeps the
 * missionId and resends the FULL transcript as long as it fits under the
 * threshold; this module now only serves the deliberate compaction — a thread too long,
 * or a change of agent (`forkMission`).
 *
 * The summary is cached on the mission row so a fork doesn't re-pay the
 * full-transcript token cost more than once. Callers should run
 * `summarizeMission` proactively (e.g. after each user turn finishes) so
 * a rate-limit fallback can fire instantly with a fresh summary.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dbApi, type EventRow } from './db.js';
import { asBackendName, backendNames, catalogBackend, defaultBackendName, getBackend, type Backend } from './backends/index.js';
import { loadConfig, spawnAgent, stderrExcerpt, type AgentConfig } from './agent.js';
import { getHost } from './host/index.js';
import { agentDir } from './paths.js';
import { settingNum } from './settings.js';
import { systemEnv } from './secrets/env.js';
import { redactText } from './secrets/redact.js';
import { createLineSplitter } from './backends/engine/line-splitter.js';
import { closeLaunchSeal, openLaunchSeal } from './backends/launch-seal.js';
import { disposeProviderScratch } from './backends/provider-scratch.js';
import { backendRunsReadOnlyTools, backendTrust } from './backends/registry.js';
import { assertSpawnPinned, buildSealedSpawn } from './backends/sealed-spawn.js';
import { runSessionOneShot } from './session-one-shot.js';
import type { BuildSpawnOpts, SpawnResult } from './backends/types.js';

const SUMMARY_SYSTEM_PROMPT = `You compress a conversation transcript so \
that another assistant can pick it up. Produce a faithful, terse summary \
that preserves:

- The user's goals, constraints and explicit decisions.
- The key facts established during the conversation (names, paths, IDs, numbers).
- The tools invoked and their material results (files read/written,
  commands run with their relevant output, MCP calls and what they returned).
- The current state of the task in progress and the immediate next step.
- Anything the user explicitly asked the assistant to remember.

Format: markdown with short bulleted sections. Use code spans
for paths and identifiers. Do NOT add meta-commentary, do NOT
speculate, do NOT include content the transcript does not support. The
next assistant will read this verbatim as durable context — be precise.

**Language: write in the language the user speaks in the transcript.**
Keep technical terms as they are
(\`commit\`, \`session_id\`, \`tool_use\`, etc.).`;

/** Render the persisted event log as a plain-text dialogue the model can
 *  read. We collapse tool_use + tool_result into one block per call so
 *  the transcript stays compact. */
export function renderTranscript(events: EventRow[]): string {
  const out: string[] = [];
  for (const row of events) {
    let payload: any;
    try { payload = JSON.parse(row.payload); } catch { continue; }
    if (row.type === 'user') {
      const text = extractText(payload?.message?.content);
      if (text) out.push(`## User\n${text}`);
      const tr = extractToolResults(payload?.message?.content);
      for (const r of tr) {
        out.push(`### Tool result (id=${r.id})${r.error ? ' [ERROR]' : ''}\n${truncate(r.content, 2000)}`);
      }
    } else if (row.type === 'assistant') {
      const text = extractText(payload?.message?.content);
      if (text) out.push(`## Assistant\n${text}`);
      const tu = extractToolUses(payload?.message?.content);
      for (const t of tu) {
        out.push(`### Tool call ${t.name} (id=${t.id})\n\`\`\`json\n${truncate(JSON.stringify(t.input, null, 2), 1500)}\n\`\`\``);
      }
    }
    // Drop system/result events — they're metadata, not conversation.
  }
  return out.join('\n\n');
}

function extractText(blocks: unknown): string {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
    .map((b: any) => b.text as string)
    .join('\n');
}

function extractToolUses(blocks: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b: any) => b?.type === 'tool_use')
    .map((b: any) => ({ id: String(b.id ?? ''), name: String(b.name ?? ''), input: b.input ?? {} }));
}

function extractToolResults(blocks: unknown): Array<{ id: string; content: string; error: boolean }> {
  if (!Array.isArray(blocks)) return [];
  return blocks
    .filter((b: any) => b?.type === 'tool_result')
    .map((b: any) => ({
      id: String(b.tool_use_id ?? ''),
      content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
      error: !!b.is_error,
    }));
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [${s.length - max} more chars]`;
}

/** Rough estimate of the token cost of a text (~4 characters per token).
 *  Enough for the only decision drawn from it — full transcript or
 *  summary — and without a dependency: an exact tokenizer would cost a
 *  provider round trip to decide between two orders of magnitude. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Kickoff of a turn on a fresh session WITHIN the same mission: a backend switch,
 * or a native session that was lost.
 *
 * Differs from `buildForkKickoff` on two points that matter: the thread does not
 * change (same missionId, same agent, the user sees no break) and the context is
 * not necessarily a summary. The model is TOLD which memory it really received:
 * that changes what it can assert without asking again.
 */
export function buildBackendSwitchKickoff(opts: {
  context: string;
  mode: 'transcript' | 'summary' | 'tail' | 'none';
  missionId: string;
  previousBackend: string;
  continuation?: string | null;
}): string {
  const nature = {
    transcript: 'This is the recorded conversation transcript. Tool outputs may be truncated.',
    summary: 'This is a summary: details may be missing. Do not invent them.',
    tail: 'Only the END of the recorded conversation survived. Earlier context is missing; this is not a summary.',
    none: 'No prior conversation history is available. The previous context is LOST. Do not claim to remember it.',
  }[opts.mode];
  return `# Conversation recovery

Mission \`${opts.missionId}\` previously ran on \`${opts.previousBackend}\`.
The conversation continues in the same user-visible thread, in a fresh provider session.
You inherit no native session memory. The context below is ALL the prior memory supplied.
Recovery mode: ${opts.mode}. ${nature}
If a necessary detail is missing, say so instead of assuming it.

## Context

${opts.context || '(No prior history available.)'}

## Continuation

${opts.continuation?.trim()
  || "Acknowledge in one line — without summarising the context — then wait for the user's next message."}`;
}

/**
 * The backend a one-shot runs on, and its model. A one-shot reads a local
 * process's stdout; a remote backend (`openRemoteSession`) has none, so a
 * summary or a dreaming pass of an agent served remotely moves to a local
 * backend — the default one first — with THAT backend's default model (a slug
 * belongs to its provider). Throws a readable error when no local backend is
 * active, instead of the remote backend's "runs no local process".
 */
export function oneShotTarget(
  backend: string | null | undefined,
  model: string | null | undefined,
): { backend: Backend; model: string | undefined; movedFrom: string | null } {
  const requested = getBackend(backend);
  if (!requested.openRemoteSession) return { backend: requested, model: model ?? undefined, movedFrom: null };
  let preferred: string | null = null;
  try { preferred = defaultBackendName(); } catch { preferred = null; }
  const local = [...new Set([preferred, ...backendNames()])]
    .filter((name): name is string => !!name)
    .map((name) => getBackend(name))
    .find((candidate) => candidate.name !== requested.name && !candidate.openRemoteSession);
  if (!local) {
    throw new Error(`backend ${requested.name} is remote and no local backend is active to run this one-shot prompt`);
  }
  return { backend: local, model: catalogBackend(local.name)?.defaultModel ?? undefined, movedFrom: requested.name };
}

/** Longest failure reason a one-shot reports: it lands in a UI notice and a
 *  log line, never in a prompt. */
const ONE_SHOT_ERROR_MAX = 300;

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > ONE_SHOT_ERROR_MAX ? `${flat.slice(0, ONE_SHOT_ERROR_MAX)}…` : flat;
}

/**
 * Why a failed `result` failed, as a short line. Each CLI puts the reason in a
 * different place: codex and copilot fill `error`, grok an `errors` array, the
 * Claude CLI the `result` text (a quota) or only a preceding assistant message
 * (a sign-in that expired) — reading `error` alone turned every Claude failure
 * into "unknown error", hiding the cause of a failed backend switch (TIM-0064).
 */
export function resultErrorText(payload: unknown, assistantText = ''): string {
  const p = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
  const errors = Array.isArray(p.errors)
    ? p.errors.filter((e): e is string => typeof e === 'string' && e.trim() !== '')
    : [];
  const subtype = text(p.subtype);
  const message = text(p.error)
    ?? (errors.length ? errors.join('; ') : null)
    ?? text(p.result)
    ?? text(assistantText)
    ?? text(p.terminal_reason)
    ?? (subtype && subtype !== 'success' ? subtype : null)
    ?? 'unknown error';
  const status = typeof p.api_error_status === 'number' ? ` (HTTP ${p.api_error_status})` : '';
  // Masked before being cut: a secret split by the cut would no longer match.
  return oneLine(redactText(message)) + status;
}

/** The end of a one-shot's stderr as one line, for a process that died before
 *  its `result`: redacted like any stderr shown to a user (`stderrExcerpt`). */
export function stderrReason(stderr: string): string {
  const flat = stderrExcerpt(stderr).replace(/\s+/g, ' ').trim();
  return flat.length > ONE_SHOT_ERROR_MAX ? `…${flat.slice(-ONE_SHOT_ERROR_MAX)}` : flat;
}

/**
 * One-shot CLI invocation that returns the assistant's text response.
 * Bypasses the regular mission machinery — no TIMON missionId is created,
 * no events are persisted, no bus traffic. Used by summarizeMission to
 * call the same provider with a transcript-compression prompt.
 *
 * Uses a stripped-down config (only backend/model/cwd/permission_mode):
 * no skills, no MCP servers, no allow/deny lists. The summarizer doesn't
 * need tools. The launch is still sealed like a mission's (`runOneShot`): a
 * provider plugin's `buildSpawn` needs it for `ctx.provider.scratch` / `mcp`.
 */
export async function oneShotPrompt(
  agentName: string,
  agentCfg: AgentConfig,
  userMessage: string,
  systemPrompt: string = SUMMARY_SYSTEM_PROMPT,
  extraAllowedTools?: string[],
  timeoutMs?: number,
): Promise<string> {
  if (extraAllowedTools?.includes('WebSearch') && agentCfg.allowed_tools?.some((tool) => /^WebSearch\(/.test(tool))) {
    throw new Error('One-shot web search is unavailable: the original agent has a scoped search grant');
  }
  const target = oneShotTarget(agentCfg.backend, agentCfg.model);
  if (target.movedFrom) {
    console.warn(`[summary] ${agentName}: ${target.movedFrom} is remote, one-shot prompt runs on ${target.backend.name}`);
  }
  try {
    return await runOneShot(agentName, agentCfg, target.backend, target.model, userMessage, systemPrompt, extraAllowedTools, timeoutMs);
  } catch (err) {
    // A model slug the CLI does not know (a copilot-style `claude-haiku-4.5`
    // handed to claude, a setting typed by hand) failed every memory capture
    // of a tester with HTTP 404 (21/10/2026). One more try on the provider's
    // own default: the job is a summary, the exact model is not the point.
    const fallback = unknownModelFallback(target.backend.name, target.model, (err as Error).message);
    if (!fallback.retry) throw err;
    console.warn(`[summary] ${agentName}: ${target.backend.name} does not know model ${target.model}; retrying with ${fallback.model ?? 'its default model'}`);
    return await runOneShot(agentName, agentCfg, target.backend, fallback.model, userMessage, systemPrompt, extraAllowedTools, timeoutMs);
  }
}

/** What the CLIs say of a model slug that is not theirs: Claude Code's
 *  `unrecognized_model` (HTTP 404), codex's "model not found/available". */
const UNKNOWN_MODEL = /unrecognized_model|not_found_error|unknown model|model.{0,80}?(not (found|available|supported|exist)|may not exist|does not exist)/i;

/** Whether, and on which model, a one-shot that failed with `error` deserves a
 *  second run: the provider's catalogue default, when the failed one differs. */
export function unknownModelFallback(backend: string, model: string | undefined, error: string): { retry: false } | { retry: true; model: string | undefined } {
  if (!model || !UNKNOWN_MODEL.test(error)) return { retry: false };
  const fallback = catalogBackend(backend)?.defaultModel ?? undefined;
  return fallback === model ? { retry: false } : { retry: true, model: fallback };
}

async function runOneShot(
  agentName: string,
  agentCfg: AgentConfig,
  backend: Backend,
  model: string | undefined,
  userMessage: string,
  systemPrompt: string,
  extraAllowedTools: string[] | undefined,
  timeoutMs: number | undefined,
): Promise<string> {
  const minimalCfg: AgentConfig = {
    backend: backend.name as AgentConfig['backend'],
    model,
    cwd: agentCfg.cwd,
    // The agent's project, so the vault answers this launch as it answers the
    // agent's missions: a backend key granted to one project stays there.
    ...(agentCfg.project ? { project: agentCfg.project } : {}),
    // Force the most restrictive sandbox we can — the summarizer mustn't
    // touch the workspace.
    permission_mode: 'plan',
    // Read-only tools the caller wants to allow explicitly (e.g.
    // WebSearch/WebFetch for Dreaming). Without it, an unlisted tool is
    // deferred to a permission card nobody validates at night.
    // plan mode stays active → no workspace write possible.
    ...(extraAllowedTools && extraAllowedTools.length ? { allowed_tools: extraAllowedTools } : {}),
    disallowed_tools: agentCfg.disallowed_tools,
    excluded_mcp_servers: agentCfg.excluded_mcp_servers,
  };
  const missionId = 'summary-' + randomUUID().slice(0, 8);
  const spawnOpts: BuildSpawnOpts = {
    agentName,
    systemPrompt,
    message: userMessage,
    resumeSession: null,
    cfg: minimalCfg,
    missionId,
    // A one-shot is no mission: it holds no token of its own, and the `timon`
    // server falls back to the daemon-token without one. None of its prompts
    // needs Timon's tools, so its CLI is handed none.
    timonMcp: false,
    // The transcript it summarises may carry a prompt injection: an agent that decides its tool
    // uses alone is confined by its provider (`AcpAgentSpec.oneShotEnv`), never asked.
    oneShot: true,
    searchConfiguredConnectors: !!agentCfg.mcp_servers?.length,
    // Nothing to run, read or write when the whole input is in the prompt: on a
    // dialect that can honour it, no built-in tool at all. A caller that asked
    // for a tool (the Dreaming's WebSearch) keeps the restricted plan mode.
    ...(!extraAllowedTools?.length && backendRunsReadOnlyTools(backend.name) ? { readOnlyTools: true } : {}),
  };
  // A provider plugin keeps per-launch state (`ctx.provider.scratch`) and asks for
  // Timon's MCP plan from its `buildSpawn`: both need the launch to be sealed, as a
  // mission's is (`agent.ts`). The seal issues no token — there is no mission to
  // issue one for; a reference to it that reached the process would read empty.
  const seal = backendTrust(backend.name) === 'core' ? null : openLaunchSeal(missionId, backend.name, spawnOpts, () => '');
  // The launch is throwaway: its references and its folder go with it, whatever ends it.
  const release = (): void => {
    if (seal) closeLaunchSeal(seal);
    disposeProviderScratch(missionId);
  };
  let spec: SpawnResult;
  try {
    spec = await buildSealedSpawn(backend, spawnOpts, seal);
  } catch (err) {
    release();
    throw err;
  }
  // A session-driven agent (ACP) answers nothing until a client writes the handshake: read as lines, it
  // waited for one until the timeout (TIM-0129). Its own driver runs the one-shot instead.
  if (backend.openSession) {
    return runSessionOneShot({
      backend, spawnOpts, spec, release, timeoutMs,
      env: { ...systemEnv(), ...(spec.env ?? {}) },
      openTimeoutMs: settingNum('TIMON_SESSION_ONE_SHOT_OPEN_MS'),
    });
  }

  return new Promise<string>((resolve, reject) => {
    // Same binary resolution as `spawnAgent`: `config.host.binaries`
    // then PATH. `stdio: ['pipe','pipe','pipe']` guarantees the three streams, which
    // the adapter's generic type does not express.
    let proc: ChildProcessWithoutNullStreams;
    try {
      assertSpawnPinned(spec);
      proc = getHost().spawn(spec.cmd, spec.args, {
        cwd: spec.cwd ?? minimalCfg.cwd ?? process.cwd(),
        // Same reason as for `missionEnv` (SECRETS-VAULT.md §6.1): the summariser is
        // an agent like any other, and `...process.env` handed it back every
        // secret loaded at boot. No vault injection here — this launch
        // is not a registered mission. Only what the official provider
        // received from `ctx.provider.env` (the agent's share of the vault) arrives through `spec.env`.
        env: { ...systemEnv(), ...(spec.env ?? {}) },
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as ChildProcessWithoutNullStreams;
    } catch (err) {
      release();
      throw err;
    }

    let text = '';
    let resultSeen = false;
    let resultError: string | null = null;
    // A CLI that dies before its `result` (a sign-in refused, a bad flag)
    // says why on stderr only: keep its end for the rejection.
    let stderrTail = '';
    let settled = false;

    // Anti-hang guard: an unsupervised web agent (at night) that blocks
    // (slow fetch, model spinning, deferred permission prompt) would otherwise
    // block the WHOLE pass forever — it is not a tracked mission, the
    // reaper does not kill it. It is SIGKILLed after timeoutMs and rejected.
    const killTimer = timeoutMs && timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          try { proc.kill('SIGKILL'); } catch {}
          settled = true;
          release();
          reject(new Error(`oneShot timeout after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs)
      : null;
    const done = (fn: () => void) => { if (settled) return; settled = true; if (killTimer) clearTimeout(killTimer); release(); fn(); };
    // Again once the streams are closed: a CLI killed at the timeout may still
    // have been writing in its folder when `done` removed it.
    proc.once('close', release);

    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', createLineSplitter((line) => {
      for (const ev of backend.parseLine(line)) {
        if (ev.type === 'assistant') {
          const blocks = (ev.payload as any)?.message?.content;
          const t = extractText(blocks);
          if (t) text += (text ? '\n' : '') + t;
        } else if (ev.type === 'result') {
          resultSeen = true;
          const p = ev.payload as { is_error?: boolean };
          if (p.is_error) resultError = resultErrorText(p, text);
          // Claude stays alive after result — kill it to release the slot.
          if (backend.persistentProcess) {
            try { proc.kill('SIGTERM'); } catch {}
          }
        }
      }
    }));

    proc.stderr.on('data', (d) => {
      process.stderr.write(`[summary] ${d}`);
      stderrTail = (stderrTail + String(d)).slice(-2000);
    });

    proc.on('exit', () => {
      done(() => {
        if (resultError) reject(new Error(`summary failed: ${resultError}`));
        else if (!resultSeen) {
          const why = stderrReason(stderrTail);
          reject(new Error(`summary process exited without result event${why ? `: ${why}` : ''}`));
        }
        else if (!text.trim()) reject(new Error('summary returned empty text'));
        else resolve(text.trim());
      });
    });

    proc.on('error', (err) => done(() => reject(err)));

    if (spec.initialStdin != null) proc.stdin.write(spec.initialStdin);
    if (!backend.persistentProcess) proc.stdin.end();
  });
}

/**
 * The agent's config, with the mission's own LLM overrides applied.
 *
 * `loadConfig` only knows the agent as configured on disk; a mission carries
 * its own backend/model (a switch, a fallback after a quota ran out, a task
 * that pinned its engine). Anything that speaks on a mission's behalf — the
 * summariser first of all — has to speak as that mission, not as the agent.
 */
export function missionLlmConfig(mission: { agent_name: string; backend_override?: string | null; model_override?: string | null; reasoning_effort?: string | null }): AgentConfig {
  const cfg = loadConfig(mission.agent_name);
  if (mission.backend_override) cfg.backend = mission.backend_override as AgentConfig['backend'];
  if (mission.model_override) cfg.model = mission.model_override;
  if (mission.reasoning_effort) cfg.reasoningEffort = mission.reasoning_effort;
  return cfg;
}

/**
 * Produce (or refresh) the cached summary for a mission and return it.
 * If the existing summary is already current (covers every event), the
 * cached copy is returned without a fresh provider round-trip.
 */
export async function summarizeMission(
  missionId: string,
  /** `llm`: run the summary on this backend/model instead of the mission's. */
  opts: { force?: boolean; llm?: { backend: string; model: string | null } } = {},
): Promise<{ summary: string; cached: boolean; eventId: number }> {
  const mission = dbApi.getMission(missionId);
  if (!mission) throw new Error(`mission ${missionId} not found`);
  const lastEventId = dbApi.getLastEventId(missionId);

  if (!opts.force && mission.summary && mission.summary_event_id === lastEventId) {
    return { summary: mission.summary, cached: true, eventId: lastEventId };
  }

  const events = dbApi.listEvents(missionId);
  const transcript = renderTranscript(events);
  if (!transcript.trim()) {
    throw new Error('mission has no conversational events to summarize');
  }

  // The summariser must run on the LLM the MISSION is actually using, not on
  // the agent's configured default. Without this, a mission moved onto codex
  // had its transcript summarised by claude — the wrong context window, the
  // wrong quota, and a wait nobody could explain from the UI.
  const cfg = missionLlmConfig(mission);
  if (opts.llm) {
    cfg.backend = opts.llm.backend as AgentConfig['backend'];
    cfg.model = opts.llm.model ?? undefined;
    // An effort level belongs to the provider it was set for.
    cfg.reasoningEffort = undefined;
  }
  const summary = await oneShotPrompt(
    mission.agent_name,
    cfg,
    `# Transcript to summarize\n\n${transcript}`,
    undefined,
    undefined,
    // Unbounded, this one-shot can hang forever: it is not a tracked mission,
    // so no reaper kills it, and every caller waiting on a summary (a backend
    // switch above all) waits with it.
    settingNum('TIMON_SUMMARY_TIMEOUT_MS'),
  );
  dbApi.setMissionSummary(missionId, summary, lastEventId);
  return { summary, cached: false, eventId: lastEventId };
}

/** A one-shot runs a local process, lines or session (`runSessionOneShot`): a
 *  remote backend would be moved back to a local one — most likely the one that
 *  just failed. */
function runsOneShot(backend: string): boolean {
  try {
    return !getBackend(backend).openRemoteSession;
  } catch {
    return false;
  }
}

/**
 * The summary a backend switch carries. The backend being LEFT is asked first
 * (the conversation is its own). When it is what failed — out of quota, signed
 * out — the switch is precisely when the summary is needed, so the arriving
 * backend gets one try before only the transcript tail crosses (TIM-0064).
 * Both failures, if any, are in the thrown message.
 */
export async function summarizeForSwitch(
  missionId: string,
  target: { backend: string; model: string | null },
  summarize: typeof summarizeMission = summarizeMission,
): Promise<{ summary: string; summarizedBy: 'source' | 'target'; sourceError: string | null }> {
  try {
    return { summary: (await summarize(missionId)).summary, summarizedBy: 'source', sourceError: null };
  } catch (err) {
    const sourceError = (err as Error).message;
    console.warn(`[summary] ${missionId.slice(0, 8)}: ${sourceError}`);
    if (!runsOneShot(target.backend)) throw err;
    try {
      const out = await summarize(missionId, { llm: target });
      return { summary: out.summary, summarizedBy: 'target', sourceError };
    } catch (retryErr) {
      const retryError = (retryErr as Error).message;
      console.warn(`[summary] ${missionId.slice(0, 8)} on ${target.backend}: ${retryError}`);
      throw new Error(`${sourceError}; on ${target.backend}: ${retryError}`);
    }
  }
}

/**
 * Build the kickoff prompt for a fork. The new mission's initial user
 * message embeds the summary as durable context so the target backend
 * starts with semantic continuity even though it has no session of its
 * own.
 */
export function buildForkKickoff(opts: {
  summary: string;
  sourceMissionId: string;
  sourceAgent: string;
  continuation: string;
}): string {
  return `# Continued from a previous session

The user was previously talking to agent \`${opts.sourceAgent}\` in mission \
\`${opts.sourceMissionId}\`. That conversation is being continued here on a \
different assistant. Use the summary below as durable context — it's the \
only memory you have of what happened before.

## Summary of prior conversation

${opts.summary}

## Continuation

${opts.continuation}`;
}

/**
 * Fork a mission onto another agent (typically with a different backend).
 * Ensures a fresh summary exists, then spawns a new TIMON mission seeded
 * with summary + continuation prompt. The new mission row is tagged with
 * `forked_from` for UI lineage.
 *
 * The target agent must exist and is run with its own config (backend,
 * model, skills, MCP). The fork is intentionally a *new* TIMON mission —
 * different `mission_id`, different provider session — so cancellation
 * and bookkeeping stay isolated from the source.
 */
export async function forkMission(opts: {
  sourceMissionId: string;
  targetAgent: string;
  continuation?: string;
  /** Per-mission overrides applied to the fork. Use to keep the same
   *  agent (skills, prompt, cwd) but switch backend/model — e.g. claude
   *  → codex when the Claude quota is exhausted. */
  backendOverride?: string | null;
  modelOverride?: string | null;
  reasoningEffort?: string | null;
}): Promise<{ missionId: string; summary: string; cached: boolean }> {
  const src = dbApi.getMission(opts.sourceMissionId);
  if (!src) throw new Error(`mission ${opts.sourceMissionId} not found`);
  if (!existsSync(agentDir(opts.targetAgent))) {
    throw new Error(`target agent "${opts.targetAgent}" not found`);
  }
  const { summary, cached } = await summarizeMission(opts.sourceMissionId);
  const kickoff = buildForkKickoff({
    summary,
    sourceMissionId: opts.sourceMissionId,
    sourceAgent: src.agent_name,
    continuation: opts.continuation?.trim() ||
      'Acknowledge the context above in one line, then wait for the next user message.',
  });
  // explicitResume:null — we want a fresh provider session, not a resume
  // of whatever the target agent last touched. The summary IS the context.
  const newMissionId = await spawnAgent(
    opts.targetAgent,
    kickoff,
    { channel: 'fork', meta: { from: opts.sourceMissionId, source_agent: src.agent_name } },
    {
      explicitResume: null,
      backendOverride: asBackendName(opts.backendOverride),
      modelOverride: opts.modelOverride ?? null,
      reasoningEffort: opts.reasoningEffort ?? null,
      ownerUserId: src.owner_user_id ?? null,
    },
  );
  dbApi.setForkedFrom(newMissionId, opts.sourceMissionId);
  return { missionId: newMissionId, summary, cached };
}
