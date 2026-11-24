/**
 * Formatting and prioritising of the returns delivered to the orchestrator.
 *
 * Module WITHOUT runtime imports (only `review-verdict.ts`, itself pure):
 * it is consumed by the wake-loop but must stay testable without opening the
 * SQLite database or the bus.
 *
 * Why it exists (incident of 2026-08-21, series `e6893b9e`) — the old
 * formatter only read `payload.title` and `payload.body`, two fields a
 * mission return does NOT have. Out of 10 returns observed between 09:14 and 09:29,
 * the orchestrator therefore received, in full, only:
 *
 *     ── Message 1 (de `TIMON.librarian`) — mission_complete ──
 *
 * while the payload in the database already carried task_id, task_title, task_status and
 * the complete `done_comment` (hence the review verdict). Two measured
 * consequences: a SQLite query after EACH return to find an info
 * it had in hand, and above all two empty returns for two different tasks
 * literally indistinguishable — that is what the "perceived
 * duplicates" were. Hence a formatter PER `kind`.
 */
import { parseReviewVerdict } from './review-verdict.js';
import { composePrompt, type PromptPart, type PromptSegment, type ReturnCard } from './prompt-presentation.js';

/** What the digest needs from an inbox message. A deliberate subset of
 *  `AgentMessageRow` so that this module stays independent of `db.ts`. */
export type DigestMessage = {
  from_agent: string;
  payload: string;
  created_at: number;
  from_mission?: string | null;
};

/** Display options of a digest. `displayName` renames a daemon pseudo-sender
 *  (`orchestrator-wake`) into a real agent; it lives with the caller, which
 *  can read the install, so this module keeps no runtime import. */
export type DigestOptions = { displayName?: (sender: string) => string };

/** Payload of a work return. `mission_complete` is emitted at the death of the
 *  process (agent.ts), `task_closed` at the task's closing (wake.ts): same
 *  content, same rendering — only the moment of emission differs. */
export type ReturnPayload = {
  kind: 'mission_complete' | 'task_closed';
  mission_id?: string | null;
  agent?: string | null;
  status?: string | null;
  task_id?: string | null;
  task_title?: string | null;
  task_status?: string | null;
  task_type?: string | null;
  pipeline?: string | null;
  done_comment?: string | null;
  /** Human summary the agent gave at close (`tasks.done_summary`). */
  summary?: string | null;
  blocked_reason?: string | null;
  /** The code of `blocked_reason` when the daemon wrote it (`DaemonMessage`). */
  blocked_reason_code?: { code: string; params: Record<string, string | number> } | null;
  merged_commit_sha?: string | null;
  group_id?: string | null;
  /** TO DO ideas this closure marks done (todo-closure.ts) — the pilot no
   *  longer ticks them itself. */
  todo_closed?: number[];
  /** Ideas it moves without closing (`analyzed`; `partial` with the count of
   *  root chains landed while sibling tasks of the idea are still open). */
  /** `integrating`: the integration branch the idea waits in (it closes when
   *  that branch lands). */
  todo_progress?: { id: number; progress: string; landed?: number; total?: number; integrating?: string }[];
  /** Landed ideas whose coder reported an OS test still owed (A-TESTER-MULTI-OS.md). */
  todo_os_test?: number[];
  /** Final report of a mission WITHOUT a task (`mission_spawn` delegation):
   *  the last text written by the agent, already shortened by the producer. A
   *  task does not carry one — its `done_comment` says the same thing. */
  final_text?: string | null;
};

const RETURN_KINDS = new Set(['mission_complete', 'task_closed']);

/** Returns the work-return payload carried by this message, or null if
 *  it is another one (wake recap, agent→agent message, free text). */
export function returnPayloadOf(msg: DigestMessage): ReturnPayload | null {
  let parsed: unknown;
  try { parsed = JSON.parse(msg.payload); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  if (typeof p.kind !== 'string' || !RETURN_KINDS.has(p.kind)) return null;
  return p as ReturnPayload;
}

/** Length beyond which a `done_comment` is shortened in the digest.
 *  Wide enough for a review verdict and its findings to go through whole;
 *  the truncation only serves to keep a 20 kB report from drowning the other
 *  returns of the same batch. */
const COMMENT_MAX = 900;

/**
 * Shortens a comment WITHOUT EVER cutting its first line.
 *
 * Contract of the `timon-task` skill: a review's verdict is on the 1st line
 * (`verdict: pass`), precisely to survive every upstream
 * truncation. The digest would be the last place to lose it.
 */
export function truncateComment(comment: string): string {
  const t = comment.trim();
  if (t.length <= COMMENT_MAX) return t;
  const firstLine = t.split('\n', 1)[0] ?? '';
  const cut = Math.max(COMMENT_MAX, firstLine.length);
  return `${t.slice(0, cut).trimEnd()}\n… (truncated — ${t.length} chars in total, full comment on the task)`;
}

/** Cap of the FINAL REPORT of a mission without a task.
 *
 *  Four times `COMMENT_MAX`, and the reason for the gap fits in one sentence: a
 *  `done_comment` sums up a work the task carries in full, whereas this
 *  report IS the deliverable — nobody else holds it. 4,000 chars
 *  ≈ 1,000 tokens, re-paid at each turn of the recipient: enough for a
 *  complete account with its shas and figures, too little for a
 *  chatty agent to weigh down the rest of the pilot's conversation. */
const FINAL_REPORT_MAX = 4_000;

/**
 * Shortens the final report of a mission WITHOUT a task.
 *
 * Distinct from `truncateComment` by its pointer, and that is the whole point: a
 * mission delegated by `mission_spawn` has no task, so "full comment
 * on the task" sent the reader to an object that does not exist. The full
 * text lives in the mission's transcript, and a single command opens it.
 */
export function truncateFinalReport(report: string, missionId: string): string {
  const t = report.trim();
  if (t.length <= FINAL_REPORT_MAX) return t;
  return `${t.slice(0, FINAL_REPORT_MAX).trimEnd()}
… (truncated — ${t.length} chars in total, full report: timon status ${missionId})`;
}

/**
 * GLOBAL cap of the reports of one digest (`done_comment` and final
 * report together). The per-entry caps did not bound the batch: six
 * `mission_spawn` delegations coming back together carried ~24k chars, that is
 * ~6,000 tokens re-paid at each following turn of the pilot. 8,000 chars ≈ 2,000
 * tokens: two complete reports go through, beyond that each gives up its share.
 */
export const DIGEST_REPORTS_MAX = 8_000;

/** Minimal share of a report shortened for the batch: the first line (the
 *  verdict) and the gist remain, even in a digest of thirty returns. */
const DIGEST_REPORT_FLOOR = 400;

/**
 * Maximum length granted to each report so that their sum fits in
 * `budget` ("water level" sharing): short reports go through
 * whole, only the long ones give way, all at the same level. `Infinity` when the
 * batch already fits. With many returns, the floor wins over the
 * budget: each keeps its head rather than disappearing.
 */
export function reportShare(lengths: readonly number[], budget = DIGEST_REPORTS_MAX): number {
  const total = lengths.reduce((sum, n) => sum + n, 0);
  if (total <= budget) return Infinity;
  const sorted = [...lengths].sort((a, b) => a - b);
  let left = budget;
  for (let i = 0; i < sorted.length; i++) {
    const share = left / (sorted.length - i);
    if (sorted[i]! > share) return Math.max(DIGEST_REPORT_FLOOR, Math.floor(share));
    left -= sorted[i]!;
  }
  return Infinity;
}

/** Shortens a report to its share of the batch, first line never cut (same
 *  contract as `truncateComment`), with the command that returns the whole text. */
function squeeze(text: string, share: number, fullText: string): string {
  if (text.length <= share) return text;
  const firstLine = text.split('\n', 1)[0] ?? '';
  const cut = Math.max(share, firstLine.length);
  return `${text.slice(0, cut).trimEnd()}\n… (shortened to fit this digest — ${fullText})`;
}

/** The reports of a return as the digest would print them without a global cap. */
function reportsOf(p: ReturnPayload): { comment: string | null; report: string | null } {
  return {
    comment: p.done_comment?.trim() ? truncateComment(p.done_comment) : null,
    report: !p.task_id && p.status && p.final_text?.trim() ? p.final_text.trim() : null,
  };
}

function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '?';
}

/** Title of a return: enough to tell two returns apart at first glance
 *  (exactly what was missing on 2026-08-21). Same template as the header
 *  of an agent→agent message, so that the digest stays homogeneous. */
function returnHeader(p: ReturnPayload): string {
  const type = p.task_type ? `[${p.task_type}] ` : '';
  const state = p.task_status ?? (p.status ? `mission ${p.status}` : 'unknown status');
  const title = p.task_title ?? `mission ${shortId(p.mission_id)}`;
  return `${type}${state}: ${title}`;
}

/** Label of the collapse: a SHORT i18n key, never the header itself.
 *  The collapse titles the nature of the block; its content (agent, task, status) stays
 *  readable when opening it. A full header as a title overflowed onto
 *  two lines and blended with the message. */
function returnLabelKey(p: ReturnPayload): string {
  if (!p.task_id) return 'missionReturn';
  if (p.task_status === 'BLOCKED') return 'taskBlocked';
  if (p.task_status === 'DONE') return 'taskDone';
  return 'taskReturn';
}

function returnBody(p: ReturnPayload, share = Infinity, missionId: string | null = p.mission_id ?? null): PromptPart[] {
  const lines: PromptPart[] = [];
  const text = (text: string) => lines.push({ kind: 'text', text });
  const instruction = (text: string) => lines.push({ kind: 'instruction', text });
  // Identifiers first, AS A BLOCK: they merge with the return's header into
  // a single collapse. Inserting a human line between two of them
  // (the verdict was one) cuts the collapse in two and sandwiches that line.
  if (p.task_id) instruction(`Task \`${p.task_id}\``);
  if (p.merged_commit_sha) instruction(`Merge: \`${p.merged_commit_sha}\``);
  if (p.group_id) instruction(`Group: \`${p.group_id}\``);
  if (p.todo_closed?.length) {
    instruction(`TO DO closed automatically: ${p.todo_closed.map((id) => `#${id}`).join(', ')}`);
  }
  for (const t of p.todo_progress ?? []) {
    const counted = t.total
      ? `TO DO #${t.id}: ${t.landed ?? 0}/${t.total} chains landed (stays open, ${t.progress})`
      : `TO DO #${t.id} → ${t.progress} (stays open)`;
    instruction(t.integrating
      ? `${counted}; integrated into ${t.integrating}, it closes when that branch lands`
      : counted);
  }
  if (p.todo_os_test?.length) {
    instruction(`Win/Mac test to run (docs/A-TESTER-MULTI-OS.md): ${p.todo_os_test.map((id) => `#${id}`).join(', ')}`);
  }
  // The verdict on its own line: even if the comment is shortened further
  // down, the orchestrator never has to re-parse it (nor query the database).
  if (p.task_type === 'review') {
    text(`Verdict: ${parseReviewVerdict(p.done_comment ?? null).verdict}`);
  }
  if (p.task_status === 'BLOCKED') {
    text(`Blocked reason: ${p.blocked_reason ?? '(not given)'}`);
  }
  // Only when present: a return without one keeps its historic text.
  if (p.summary?.trim()) text(`Summary: ${p.summary.trim()}`);
  const { comment, report } = reportsOf(p);
  if (comment) {
    text('Closing comment:');
    text(squeeze(comment, share, p.task_id ? `full text: timon task get ${p.task_id}` : 'full text on the task'));
  }
  // Mission without a task: the status carries real information (the process was
  // freed, or it failed), but it does not replace the report. When the
  // report is missing — mission killed mid-turn — the status line alone
  // stays the right fallback.
  if (!p.task_id && p.status) {
    text(`Mission ended (${p.status}).`);
    if (report) {
      text('Final report:');
      text(squeeze(report, share, missionId ? `full report: timon status ${missionId}` : 'full report in the mission transcript'));
    }
  }
  return lines;
}

/** Findings shown on a card are capped: `parseReviewVerdict` falls back to
 *  the whole comment when it finds no JSON, and the card must not re-show
 *  what the fold is there to hide. */
const FINDINGS_MAX = 1_200;

function capped(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/** The return as data, for the chat card. Same sources as `returnBody`. */
export function returnCardOf(p: ReturnPayload): ReturnCard {
  const card: ReturnCard = {
    task_id: p.task_id ?? null,
    title: p.task_title ?? null,
    type: p.task_type ?? null,
    status: p.task_status ?? null,
  };
  if (!p.task_id && p.status) card.mission_status = p.status;
  if (p.task_type === 'review') {
    const review = parseReviewVerdict(p.done_comment ?? null);
    card.verdict = review.verdict;
    if (review.verdict !== 'pass' && review.feedback?.trim()) card.findings = capped(review.feedback, FINDINGS_MAX);
  }
  if (p.merged_commit_sha) card.merged_sha = p.merged_commit_sha;
  if (p.todo_closed?.length) card.todo_closed = p.todo_closed;
  if (p.todo_progress?.length) card.todo_progress = p.todo_progress;
  if (p.summary?.trim()) card.summary = p.summary.trim();
  if (p.task_status === 'BLOCKED') {
    card.blocked_reason = p.blocked_reason?.trim() || '';
    if (card.blocked_reason && p.blocked_reason_code) card.blocked_reason_code = p.blocked_reason_code;
  }
  if (!p.task_id && p.final_text?.trim()) card.report = p.final_text.trim();
  return card;
}

/** Reproduces the CONTENT of the messages directly in the wake prompt. The
 *  wake-loop owns the delivery: injecting the content (durable in the
 *  transcript) guarantees the agent received it, regardless of whether it
 *  calls `agent_recv_messages`/`agent_pick_message` itself. */
export function formatInboxDigest(messages: DigestMessage[]): string {
  return presentInboxDigest(messages).text;
}

/** Mark generated identifiers where they are authored, never by scanning a reply. */
export function presentInboxDigest(messages: DigestMessage[], options: DigestOptions = {}) {
  const ordered = [...messages].sort((a, b) => a.created_at - b.created_at);
  const parts: PromptPart[] = [];
  const segments: PromptSegment[] = [];
  const shown = (sender: string) => options.displayName?.(sender) ?? sender;
  // Every part pushed belongs to the message being written: `segment` is the
  // index of that message's entry, so the chat can split the digest per sender.
  const text = (text: string) => parts.push({ kind: 'text', text, segment: segments.length - 1 });
  // The header is written by the runtime, not by the agent: it belongs to the
  // collapse. The `label` only says its NATURE (i18n key translated on the
  // client side) — "Task completed" rather than the whole header.
  const header = (text: string, label: string) =>
    parts.push({ kind: 'instruction', text, label, segment: segments.length - 1 });
  // Only work returns share the budget. A message from one agent to another
  // is the request itself, written for this reader: cut, nothing would bring
  // its end back.
  const lengths = ordered.flatMap((m) => {
    const ret = returnPayloadOf(m);
    if (!ret) return [];
    const { comment, report } = reportsOf(ret);
    return [comment?.length ?? 0, report?.length ?? 0].filter((n) => n > 0);
  });
  const share = reportShare(lengths);
  let i = 1;
  for (const m of ordered) {
    const ret = returnPayloadOf(m);
    if (ret) {
      const from = ret.agent ?? m.from_agent;
      segments.push({
        from: shown(from),
        at: m.created_at,
        mission_id: ret.mission_id ?? m.from_mission ?? null,
        card: returnCardOf(ret),
      });
      header(`── Message ${i++} (from \`${from}\`) — ${returnHeader(ret)} ──`, returnLabelKey(ret));
      parts.push(...returnBody(ret, share, ret.mission_id ?? m.from_mission ?? null).map((part) => ({ ...part, segment: segments.length - 1 })));
      text('');
      continue;
    }
    segments.push({ from: shown(m.from_agent), at: m.created_at, mission_id: m.from_mission ?? null });
    // Historical path, UNCHANGED: agent→agent messages `{title, body}` and
    // non-JSON payload (free text). Both cases already worked.
    let title = '';
    let body = '';
    try {
      const p = JSON.parse(m.payload) as { kind?: string; title?: string; body?: string };
      title = p.title ?? p.kind ?? '';
      body = p.body ?? '';
    } catch {
      body = m.payload;
    }
    header(`── Message ${i++} (from \`${m.from_agent}\`)${title ? ` — ${title}` : ''} ──`, 'agentMessage');
    if (body) text(body);
    text('');
  }
  // Match the historic digest byte for byte, including blank lines.
  while (parts.length && !parts.at(-1)!.text.trim()) parts.pop();
  if (parts.length) parts[parts.length - 1]!.text = parts.at(-1)!.text.trimEnd();
  return composePrompt(
    parts.map((part, index) => ({ ...part, text: part.text + (index < parts.length - 1 ? '\n' : '') })),
    segments,
  );

}

/**
 * Does this return justify a wake ON ITS OWN?
 *
 * A single `code` task produces up to four returns (code, review, merge,
 * doc): waking on each is four orchestrator turns for ONE
 * unit of work, three of which call for no decision — the chain
 * chains along on its own. The non-urgent returns are not lost: they
 * stay in the inbox and are merged into the next digest (and delivered
 * by force beyond the retention cap, see wake.ts).
 *
 * When in doubt: wake. A signal carrying a
 * decision (BLOCKED, `changes_requested`, merge without sha) is NEVER removed.
 *
 * @param followUpExists a follow-up task (non-doc) depending on this one
 *   already exists — so the chain has already resumed without the pilot.
 */
export function isUrgentReturn(p: ReturnPayload, followUpExists: boolean): boolean {
  // Mission without a task = free sub-mission (`timon spawn`): the pilot is explicitly
  // waiting for its result, nobody else will chain it.
  if (!p.task_id) return true;
  // BLOCKED first, whatever the type: a blocked doc task calls for a
  // human intervention, and it is the pilot that carries it.
  if (p.task_status === 'BLOCKED') return true;
  // A non-blocked doc calls for no decision: produced after the fact, with no
  // follow-up. A wake for it is pure noise.
  if (p.task_type === 'doc') return false;
  // Task not closed (PENDING/IN_PROGRESS): the mission is dead but the work
  // goes on or was automatically queued again — nothing to decide. It is the
  // same rule as "no task_blocked on a system requeue".
  if (p.task_status !== 'DONE') return false;

  const chainContinues = followUpExists || !isCodeOnly(p.pipeline);
  switch (p.task_type) {
    case 'review': {
      // Only a verdict that is NOT `pass` calls for an arbitration: on `pass`
      // the merge task is created automatically.
      if (parseReviewVerdict(p.done_comment ?? null).verdict !== 'pass') return true;
      return !chainContinues;
    }
    case 'code':
      // The review is required to REALLY be present, never the pipeline alone.
      // Before: `!isCodeOnly(pipeline)` was enough to conclude "the chain
      // goes on", so in the `full` pipeline the return was always classified as non
      // urgent — even when no review had been created. Combined with
      // the absence, at the time, of a "code DONE without review" invariant, a
      // chain broken between the closing and the creation of the review disappeared
      // from the radar: pilot never woken, Kanban simply empty. It is the
      // last rampart before silence, it must presume nothing.
      return !followUpExists;
    case 'merge': {
      // A merge without a sha is a merge of which we have NO proof: integration
      // not proven → decision required, unconditionally.
      if (!p.merged_commit_sha) return true;
      // Proven merge: end of the chain, but not necessarily a decision. On a
      // batch of N slices, waking on each merge makes N orchestrator turns
      // for a batch whose consolidated recap will leave at the end anyway
      // (evaluateGroupCompleteForTask). Same if a follow-up already exists.
      // Outside a batch and without a follow-up, however, the pilot must take the plan back.
      if (p.group_id) return false;
      return !followUpExists;
    }
    default:
      // chore / research / unknown type: terminal by default, unless a
      // follow-up has already been created.
      return !followUpExists;
  }
}

function isCodeOnly(pipeline: string | null | undefined): boolean {
  return pipeline === 'code-self' || pipeline === 'code-group';
}
