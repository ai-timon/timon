import { escapeHtml, mdToSafeHtml } from './markdown';
import { t } from './i18n';
import { daemonMessageText, parseDaemonMessage, type StoredDaemonMessage } from './api-error';
import { readReplyAttachment, REPLY_PART_LABEL } from './reply-attachment';

export { readAnnotationAttachment, type AnnotationAttachment, type AnnotationCardItem } from './annotation-attachment';
export { readReplyAttachment, REPLY_PART_LABEL, type ReplyAttachment } from './reply-attachment';

export type PromptPart = {
  kind: 'text' | 'instruction';
  text: string;
  label?: string;
  /** Fills the `{placeholders}` of the label's key — a skill block is titled
   *  by its id, which no fixed key could carry. */
  labelVars?: Record<string, string>;
  /** Index of the digest message this part belongs to (`segments`). */
  segment?: number;
};

/** A work return as data, authored by the daemon (`ReturnCard` in
 *  orchestrator/src/prompt-presentation.ts — keep the two in step). */
export type ReturnCard = {
  task_id: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  mission_status?: string;
  verdict?: 'pass' | 'changes_requested' | 'unknown';
  merged_sha?: string;
  todo_closed?: number[];
  /** `landed`/`total`: sibling chains of the idea still open (TODO #462). */
  todo_progress?: { id: number; progress: string; landed?: number; total?: number }[];
  summary?: string;
  blocked_reason?: string;
  /** The code of `blocked_reason` when the daemon wrote it: read in the reader's language. */
  blocked_reason_code?: StoredDaemonMessage;
  findings?: string;
  report?: string;
};

/** One message of a digest, ready to be drawn as its own bubble. */
export type PromptSegmentView = {
  from: string;
  /** Epoch ms. */
  at: number;
  missionId: string | null;
  html: string;
};

/** The authored label names the block's nature as a short i18n key. Older
 *  messages stored a free-text header instead: unknown keys are shown as-is
 *  rather than replaced, so history stays readable. */
function labelText(label: string | undefined, vars?: Record<string, string>): string {
  if (!label) return t('chatPage.automatedInstruction');
  const key = `chatPage.instructionLabels.${label}`;
  const translated = t(key, vars);
  return translated === key ? label : translated;
}

// Lucide Bot geometry, serialized for the HTML renderer with the tool icon styling.
const botIconHtml = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"'
  + ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
  + ' class="lucide lucide-bot size-3.5 shrink-0" aria-hidden="true" focusable="false">'
  + '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/>'
  + '<path d="M2 14h2"/><path d="M20 14h2"/><path d="M15 13v2"/><path d="M9 13v2"/></svg>';

/** A malformed var bag is dropped like a malformed label: the key then shows
 *  its own placeholders rather than hiding the block. */
function isVarBag(value: unknown): value is Record<string, string> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((v) => typeof v === 'string');
}

/** Reject stale or malformed metadata rather than hide any part of a message. */
export function promptParts(text: string, origin?: unknown): PromptPart[] {
  const plain: PromptPart[] = [{ kind: 'text', text }];
  if (!origin || typeof origin !== 'object') return plain;
  const o = origin as { kind?: unknown; presentation?: unknown };
  if (o.presentation !== undefined) {
    if (!o.presentation || typeof o.presentation !== 'object') return plain;
    const p = o.presentation as { version?: unknown; parts?: unknown };
    if (p.version !== 1 || !Array.isArray(p.parts)) return plain;
    const parts: PromptPart[] = [];
    for (const part of p.parts) {
      if (!part || typeof part !== 'object' ||
          (part.kind !== 'text' && part.kind !== 'instruction') || typeof part.text !== 'string') return plain;
      // An absent label is normal (most instructions have none); a malformed
      // one is dropped rather than rendered — never a reason to hide the text.
      parts.push({ kind: part.kind, text: part.text,
        ...(typeof part.label === 'string' && part.label.trim() ? { label: part.label } : {}),
        ...(isVarBag(part.labelVars) ? { labelVars: part.labelVars } : {}),
        ...(Number.isInteger(part.segment) && part.segment >= 0 ? { segment: part.segment } : {}) });
    }
    return parts.map((part) => part.text).join('') === text ? parts : plain;
  }

  // Historic runtime messages have provenance but no authored sections.
  // Only exact, anchored runtime templates qualify; human text stays visible.
  if (o.kind === 'dispatcher') {
    const prefix = /^TASK_ID: [0-9a-f-]{8,}\r?\n\r?\n/i.exec(text)?.[0];
    if (!prefix) return plain;
    const body = text.slice(prefix.length);
    // The dispatcher writes these directives in English since #628; briefs
    // stored before keep their French wording.
    // french-ok: matches the French headings of briefs stored before #628
    const suffix = /\n\n(?:---\nPIPELINE ?: `code-(?:self|group)`\.|## (?:Conflits à résoudre AVANT toute autre chose|Conflicts to resolve BEFORE anything else|Où tu intègres — règle dure|Where you merge — hard rule)|_Note : ta branche a été automatiquement remise à niveau|_Note: your branch was automatically brought up to date)/.exec(body);
    return [
      { kind: 'instruction', text: prefix },
      { kind: 'text', text: suffix ? body.slice(0, suffix.index) : body },
      ...(suffix ? [{ kind: 'instruction' as const, text: body.slice(suffix.index) }] : []),
    ];
  }
  if (['agent', 'wake', 'mission_return', 'task_return', 'system_alert'].includes(String(o.kind))) {
    const prefix = /^(?:Mission return — delivered INTO THIS mission because it is the one that\nstarted the work\. Process each return, then continue the rest of your plan\nor close the project\.|You have \d+ message\(s\) waiting in your inbox\. Their content\nis reproduced below \(already handled on the inbox side — no need to\npick them again\)\. Process each request, then continue the rest of the plan or close the\nproject\.)\n\n/.exec(text)?.[0];
    if (prefix) return [{ kind: 'instruction', text: prefix }, { kind: 'text', text: text.slice(prefix.length) }];
  }
  return plain;
}

const chevronHtml = '<svg class="tool-summary-chevron size-3 shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function foldHtml(title: string, bodyHtml: string, extraClass = ''): string {
  return `<details class="automatic-instruction tool-block${extraClass ? ` ${extraClass}` : ''}">`
    + '<summary class="tool-summary">' + chevronHtml
    + botIconHtml + '<span class="tool-summary-name">' + escapeHtml(title) + '</span></summary>'
    + '<div class="tool-block-body">' + bodyHtml + '</div></details>';
}

/** Adjacent instruction parts read as one automated block, not a stack of
 *  grey lines: they share one fold, titled by the first part that names itself. */
function mergeInstructions(parts: PromptPart[]): PromptPart[] {
  const merged: PromptPart[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (part.kind === 'instruction' && last?.kind === 'instruction') {
      merged[merged.length - 1] = {
        ...last,
        text: last.text + part.text,
        ...(last.label ? {} : part.label ? { label: part.label, ...(part.labelVars ? { labelVars: part.labelVars } : {}) } : {}),
      };
    } else merged.push(part);
  }
  return merged;
}

function renderParts(parts: PromptPart[], copyLinks: boolean): string {
  return mergeInstructions(parts).map((part) => {
    const html = mdToSafeHtml(part.text, { copyLinks });
    if (part.kind === 'text') return html;
    return foldHtml(labelText(part.label, part.labelVars), html);
  }).join('');
}

export function renderPromptText(text: string, origin?: unknown): string {
  return renderParts(shownParts(text, origin), !!origin);
}

/** The parts a bubble draws: a reply's header goes, its quote replaces it. */
function shownParts(text: string, origin?: unknown): PromptPart[] {
  const parts = promptParts(text, origin);
  return readReplyAttachment(origin) ? parts.filter((part) => part.label !== REPLY_PART_LABEL) : parts;
}

/** What the human wrote, without the instructions around it: what copying
 *  their bubble gives back. */
export function promptTypedText(text: string, origin?: unknown): string {
  return shownParts(text, origin).filter((part) => part.kind === 'text').map((part) => part.text).join('').trim();
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const optStr = (v: unknown): string | undefined => (isStr(v) && v.trim() ? v : undefined);

/** Keeps only well-typed fields: a malformed card loses a badge, never the
 *  bubble — the full text is still behind "Details". */
function readCard(raw: unknown): ReturnCard | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const c = raw as Record<string, unknown>;
  const card: ReturnCard = {
    task_id: optStr(c.task_id) ?? null,
    title: optStr(c.title) ?? null,
    type: optStr(c.type) ?? null,
    status: optStr(c.status) ?? null,
  };
  const missionStatus = optStr(c.mission_status);
  if (missionStatus) card.mission_status = missionStatus;
  if (c.verdict === 'pass' || c.verdict === 'changes_requested' || c.verdict === 'unknown') card.verdict = c.verdict;
  const sha = optStr(c.merged_sha);
  if (sha) card.merged_sha = sha;
  if (Array.isArray(c.todo_closed)) {
    const ids = c.todo_closed.filter((id): id is number => Number.isInteger(id));
    if (ids.length) card.todo_closed = ids;
  }
  if (Array.isArray(c.todo_progress)) {
    const moves = c.todo_progress.flatMap((m) => {
      if (!m || typeof m !== 'object') return [];
      const { id, progress, landed, total } = m as { id?: unknown; progress?: unknown; landed?: unknown; total?: unknown };
      if (!Number.isInteger(id) || !isStr(progress)) return [];
      const count = Number.isInteger(landed) && Number.isInteger(total) && (total as number) > 0
        ? { landed: landed as number, total: total as number } : {};
      return [{ id: id as number, progress, ...count }];
    });
    if (moves.length) card.todo_progress = moves;
  }
  for (const key of ['summary', 'findings', 'report'] as const) {
    const value = optStr(c[key]);
    if (value) card[key] = value;
  }
  // An empty reason still marks the block: the card then says it is unknown.
  if (isStr(c.blocked_reason)) card.blocked_reason = c.blocked_reason;
  const reasonCode = parseDaemonMessage(c.blocked_reason_code);
  if (reasonCode && card.blocked_reason) card.blocked_reason_code = reasonCode;
  return card;
}

function badge(tone: string, label: string, title?: string): string {
  return `<span class="return-card-badge is-${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>${escapeHtml(label)}</span>`;
}

function statusBadge(card: ReturnCard): string {
  if (card.status === 'DONE') return badge('success', t('chatPage.returnCard.done'));
  if (card.status === 'BLOCKED') return badge('danger', t('chatPage.returnCard.blocked'));
  if (card.status) return badge('muted', t('chatPage.returnCard.inProgress'), card.status);
  if (card.mission_status === 'failed') return badge('danger', t('chatPage.returnCard.missionFailed'));
  if (card.mission_status) return badge('success', t('chatPage.returnCard.missionEnded'), card.mission_status);
  return '';
}

function verdictBadge(card: ReturnCard): string {
  if (card.verdict === 'pass') return badge('success', t('chatPage.returnCard.verdictPass'));
  if (card.verdict === 'changes_requested') return badge('warning', t('chatPage.returnCard.verdictChanges'));
  if (card.verdict === 'unknown') return badge('warning', t('chatPage.returnCard.verdictUnknown'));
  return '';
}

/** What a human reads without unfolding anything: the task, its outcome,
 *  the agent's own summary, and only what calls a decision. */
function renderCard(card: ReturnCard, detailsHtml: string): string {
  const title = card.title
    ?? (card.task_id ? `${t('chatPage.returnCard.task')} ${card.task_id.slice(0, 8)}` : t('chatPage.returnCard.mission'));
  const chips: string[] = [];
  if (card.merged_sha) {
    chips.push(`<span class="return-card-chip" title="${escapeHtml(card.merged_sha)}">${escapeHtml(t('chatPage.returnCard.merged', { sha: card.merged_sha.slice(0, 7) }))}</span>`);
  }
  for (const id of card.todo_closed ?? []) {
    chips.push(`<span class="return-card-chip">${escapeHtml(t('chatPage.returnCard.todoClosed', { id }))}</span>`);
  }
  for (const move of card.todo_progress ?? []) {
    const label = move.total
      ? t('chatPage.returnCard.todoPartial', { id: move.id, landed: move.landed ?? 0, total: move.total })
      : t('chatPage.returnCard.todoProgress', { id: move.id, progress: move.progress });
    chips.push(`<span class="return-card-chip">${escapeHtml(label)}</span>`);
  }
  const block = (cls: string, label: string | null, body: string) =>
    `<div class="return-card-${cls}">${label ? `<div class="return-card-label">${escapeHtml(label)}</div>` : ''}${mdToSafeHtml(body, { copyLinks: true })}</div>`;
  return '<div class="return-card">'
    + '<div class="return-card-head">'
    + (card.type ? `<span class="return-card-type">${escapeHtml(card.type)}</span>` : '')
    + `<span class="return-card-title">${escapeHtml(title)}</span>`
    + statusBadge(card) + verdictBadge(card)
    + '</div>'
    + (chips.length ? `<div class="return-card-chips">${chips.join('')}</div>` : '')
    + (card.summary ? block('summary', null, card.summary) : '')
    + (card.blocked_reason !== undefined
      ? block('alert', t('chatPage.returnCard.blockedReason'),
        daemonMessageText(card.blocked_reason_code, card.blocked_reason).trim() || t('chatPage.returnCard.noReason'))
      : '')
    + (card.findings ? block('findings', t('chatPage.returnCard.findings'), card.findings) : '')
    + (card.report ? block('report', null, card.report) : '')
    + foldHtml(t('chatPage.returnCard.details'), detailsHtml, 'return-card-details')
    + '</div>';
}

/**
 * Splits a digest into one bubble per message, each under its real sender.
 *
 * `null` means "render as one message, as before": no segments (history,
 * a client older than the daemon or the reverse), or metadata that does not
 * hold together. Nothing is ever hidden that `renderPromptText` would show.
 */
export function renderPromptSegments(text: string, origin?: unknown): PromptSegmentView[] | null {
  if (!origin || typeof origin !== 'object') return null;
  const presentation = (origin as { presentation?: unknown }).presentation;
  if (!presentation || typeof presentation !== 'object') return null;
  const rawSegments = (presentation as { segments?: unknown }).segments;
  if (!Array.isArray(rawSegments) || rawSegments.length === 0) return null;
  const segments: { from: string; at: number; missionId: string | null; card?: ReturnCard }[] = [];
  for (const raw of rawSegments) {
    if (!raw || typeof raw !== 'object') return null;
    const s = raw as Record<string, unknown>;
    if (!optStr(s.from) || typeof s.at !== 'number' || !Number.isFinite(s.at)) return null;
    segments.push({ from: s.from as string, at: s.at, missionId: optStr(s.mission_id) ?? null, card: readCard(s.card) });
  }
  const parts = promptParts(text, origin);
  if (!parts.some((part) => part.segment !== undefined)) return null;
  if (parts.some((part) => part.segment !== undefined && part.segment >= segments.length)) return null;

  // Parts that belong to no message (the runtime preamble) go with the next
  // message, the trailing ones with the last: folded, never dropped.
  const owned: PromptPart[][] = segments.map(() => []);
  let pending: PromptPart[] = [];
  for (const part of parts) {
    if (part.segment === undefined) { pending.push(part); continue; }
    owned[part.segment]!.push(...pending, part);
    pending = [];
  }
  owned[owned.length - 1]!.push(...pending);

  return segments.map((segment, index) => {
    const mine = owned[index]!;
    const loose = mine.map((part) => (part.segment === undefined ? { ...part, kind: 'instruction' as const } : part));
    const html = segment.card
      ? renderCard(segment.card, mdToSafeHtml(mine.map((part) => part.text).join(''), { copyLinks: true }))
      : renderParts(loose, true);
    return { from: segment.from, at: segment.at, missionId: segment.missionId, html };
  });
}
