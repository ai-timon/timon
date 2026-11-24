/**
 * Attachments of a chat turn — everything that is not an image.
 *
 * An image goes inline in the turn (protocol `image` block): the model
 * sees it. A PDF, a .pptx, a .csv have no equivalent — the CLIs that
 * Timon drives read FILES. So the bytes are persisted under
 * `$TIMON_HOME/uploads/chat/<uuid>/` and their absolute paths are announced to
 * the agent, which opens them with its own tools.
 *
 * The folder carries the MISSION'S ID, one subfolder per turn. That is what
 * makes a cleanup possible: the lifetime of an attachment is that of its
 * mission, not an age in days. A blind purge, on the date alone, can
 * always take away the file of a mission still alive — and a "finished"
 * mission is not finished for good, `respawnWithResume` reopens it
 * (`reopenMission` sets `status='running'`, `ended_at=NULL` again). See
 * `purgeChatAttachments`.
 *
 * Two deliberate differences with `uploads.ts`, and that is why this module
 * is separate:
 *  - No type allowlist. The request is "any type without
 *    exception"; the guard therefore moves to the NAME (basename, no
 *    separator, no `..`, bounded length), not to the content.
 *  - No serving route. These bytes are never served again over HTTP:
 *    the agent reads them on disk, the bubble only shows the name. Nothing to
 *    sniff, nothing to render inline.
 */

import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { TIMON_HOME } from './paths.js';
import { composePrompt, type PromptPart, type PromptPresentation } from './prompt-presentation.js';
import { replyAttachment, replyPart, type ReplyTarget } from './reply-to.js';

/** For a whole turn, aligned on what actually fits: the JSON body is capped
 *  at 25 MB (`kernel/body-parser.ts`) and base64 inflates by 4/3, so 18 MB of
 *  files is 24 MB on the wire, leaving 1 MB for the text (TIM-0125). The
 *  former 100 MB was a promise the parser refused with a bare 413. The
 *  composer applies the same budget to images + files
 *  (`app/src/lib/attachments.ts`). */
export const MAX_TURN_BYTES = 18 * 1024 * 1024;
/** Per file: a single file can use the whole turn, no more. */
export const MAX_ATTACHMENT_BYTES = MAX_TURN_BYTES;

/** A file the daemon dropped from the turn, reported back to the composer
 *  instead of a log line nobody reads. */
export type SkippedAttachment = { name: string; reason: 'empty' | 'too_large' | 'turn_limit' };

/** Field added to a successful spawn / send reply when files were dropped. */
export function skippedAttachmentsField(skipped: readonly SkippedAttachment[]): { skipped_attachments?: SkippedAttachment[] } {
  return skipped.length > 0 ? { skipped_attachments: [...skipped] } : {};
}

export type ChatAttachmentInput = {
  name?: unknown;
  /** base64 without a `data:` prefix. */
  data?: unknown;
  mime?: unknown;
};

export type PersistedAttachment = {
  name: string;
  path: string;
  size: number;
  mime: string;
};

/** Reduces a name provided by the client to a harmless basename. Anything that
 *  is neither a letter, nor a digit, nor `. - _ ( ) space` becomes `_`: the
 *  separators and `..` disappear by construction. */
export function safeAttachmentName(raw: unknown): string {
  const base = typeof raw === 'string' ? raw.split(/[\\/]/).pop() ?? '' : '';
  const cleaned = base.replace(/[^\w.() -]+/g, '_').replace(/^\.+/, '').trim();
  return (cleaned || 'file').slice(0, 120);
}

/**
 * Writes the attachments of a turn and returns their absolute paths. A
 * refused file (too big, empty payload) is ignored: the message leaves
 * anyway, minus that attachment, rather than failing the whole turn. It
 * is added to `skipped`, which the route returns to the composer.
 */
export function persistChatAttachments(
  missionId: string,
  inputs: unknown,
  skipped: SkippedAttachment[] = [],
): PersistedAttachment[] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  // <missionId>/<turn>/: the mission so the purge knows whose it is, the
  // turn so that two `rapport.pdf` of two turns do not overwrite each other — and so that
  // the name announced to the agent stays the one the human attached.
  const dir = join(chatAttachmentsRoot(), safeAttachmentName(missionId), randomUUID());
  const saved: PersistedAttachment[] = [];
  let total = 0;
  for (const raw of inputs as ChatAttachmentInput[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.data !== 'string') continue;
    const name = safeAttachmentName(raw.name);
    const bytes = Buffer.from(raw.data, 'base64');
    if (bytes.length === 0) {
      console.warn(`[attachments] ${name} skipped — empty payload`);
      skipped.push({ name, reason: 'empty' });
      continue;
    }
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      console.warn(`[attachments] ${name} skipped — ${bytes.length} bytes > ${MAX_ATTACHMENT_BYTES}`);
      skipped.push({ name, reason: 'too_large' });
      continue;
    }
    if (total + bytes.length > MAX_TURN_BYTES) {
      console.warn(`[attachments] ${name} skipped — the turn exceeds ${MAX_TURN_BYTES} bytes`);
      skipped.push({ name, reason: 'turn_limit' });
      continue;
    }
    if (saved.length === 0) mkdirSync(dir, { recursive: true, mode: 0o700 });
    // The name stays readable for the agent; the folder's uuid is enough to avoid
    // any collision between two turns.
    const full = join(dir, name);
    writeFileSync(full, bytes);
    total += bytes.length;
    saved.push({
      name,
      path: full,
      size: bytes.length,
      mime: typeof raw.mime === 'string' && raw.mime ? raw.mime : 'application/octet-stream',
    });
  }
  return saved;
}

/**
 * Removes from disk the files of ONE turn that was finally not handed to the
 * agent (refused fallback, turn in flight, dead process…): nobody owns them any
 * more, and the purge would only see them when the mission ends.
 *
 * Bounded to `chatAttachmentsRoot()`: a path outside that folder is never
 * deleted, whatever it is given.
 */
export function discardChatAttachments(saved: readonly PersistedAttachment[]): void {
  const root = resolve(chatAttachmentsRoot());
  const turns = new Set(saved.map((file) => dirname(resolve(file.path))));
  for (const turn of turns) {
    // `<root>/<mission>/<turn>`: exactly two levels under the root.
    const rel = relative(root, turn);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).length !== 2) continue;
    try { rmSync(turn, { recursive: true, force: true }); } catch { /* best-effort: the purge will catch it */ }
  }
}

/**
 * Creates the folder the attachments of `missionId` are saved to, empty, and
 * returns it. The fence opens it to the mission at launch, and a persistent
 * CLI keeps the rules it was launched with: a folder the first attachment
 * created afterwards stayed closed to it until the process was restarted.
 * An empty one costs nothing: the purge takes it with the mission's.
 */
export function ensureChatAttachmentsDir(missionId: string): string {
  const dir = join(chatAttachmentsRoot(), safeAttachmentName(missionId));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Root of everything this module writes. Exported: the cleanup reads it again. */
export function chatAttachmentsRoot(): string {
  return join(TIMON_HOME, 'uploads', 'chat');
}

/** What the purge needs to know about a mission to decide. */
export type MissionLifetime = {
  /** Living or resumed mission: nothing is touched, whatever the age. */
  live: boolean;
  /** End of the mission. `null` when it never finished. */
  endedAt: number | null;
};

export type PurgeOutcome = { removed: string[]; keptLive: number; keptRecent: number };

/**
 * Erases the attachments whose mission has been finished for more than `ttlMs`.
 *
 * The `lifetimeOf` is provided by the caller (the database): it is WHAT makes
 * this cleanup not blind. Three cases, and only one erases:
 *  - living mission (or reopened by a resume) → untouchable;
 *  - recently finished mission → kept, for the time it takes to read the
 *    conversation again;
 *  - mission unknown to the database → orphan (aborted spawn, reset database):
 *    fall back on the folder's date, for lack of anything better.
 */
export function purgeChatAttachments(
  lifetimeOf: (missionId: string) => MissionLifetime | null,
  ttlMs: number,
  now: number = Date.now(),
): PurgeOutcome {
  const root = chatAttachmentsRoot();
  const out: PurgeOutcome = { removed: [], keptLive: 0, keptRecent: 0 };
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return out; // nothing was ever attached
  }
  for (const entry of entries) {
    const dir = join(root, entry);
    const life = lifetimeOf(entry);
    if (life?.live) { out.keptLive += 1; continue; }
    // A mission finished without a readable `ended_at`, or an orphan: the folder's
    // date is the only clock available.
    let since = life?.endedAt ?? null;
    if (since === null) {
      try { since = statSync(dir).mtimeMs; } catch { continue; }
    }
    if (now - since < ttlMs) { out.keptRecent += 1; continue; }
    try {
      rmSync(dir, { recursive: true, force: true });
      out.removed.push(entry);
    } catch (err) {
      console.warn(`[attachments] could not purge ${entry}: ${(err as Error).message}`);
    }
  }
  return out;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The block announced to the agent. Collapsed in the bubble: the human knows what they
 *  attached, they do not need to read the paths again. */
export function attachmentParts(files: PersistedAttachment[]): PromptPart[] {
  if (files.length === 0) return [];
  const lines = files.map((f) => `- \`${f.path}\` (${f.name}, ${fmtBytes(f.size)}, ${f.mime})`);
  return [{
    kind: 'instruction',
    label: 'attachments',
    labelVars: { count: String(files.length) },
    text: [
      ``,
      ``,
      `<attachments>`,
      ...lines,
      `</attachments>`,
      `These files are attached to my message, on the host's disk. Open them with your reading tools if the request concerns them.`,
    ].join('\n'),
  }];
}

export type PastedBlock = { name?: unknown; text?: unknown };

/** Bounds of a paste: beyond them, it is a file, not a clipboard. */
export const MAX_PASTED_CHARS = 500_000;

/**
 * The long pastes the composer moved out of the input. They count as
 * the human's text — so they go IN the message, not onto the disk:
 * a file the agent would not think of opening would lose what the human
 * believed they had said. Only their PRESENTATION is collapsed.
 */
export function pastedParts(inputs: unknown): PromptPart[] {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const blocks: string[] = [];
  const names: string[] = [];
  for (const raw of inputs as PastedBlock[]) {
    if (!raw || typeof raw !== 'object' || typeof raw.text !== 'string' || !raw.text) continue;
    const name = safeAttachmentName(raw.name ?? 'Pasted');
    names.push(name);
    blocks.push(`<pasted name="${name}">\n${raw.text.slice(0, MAX_PASTED_CHARS)}\n</pasted>`);
  }
  if (blocks.length === 0) return [];
  // A single collapse, even with several pastes: `composePrompt` would merge
  // two neighbouring instructions anyway, and the title could then no longer
  // be that of the first one alone.
  return [{
    kind: 'instruction',
    label: names.length === 1 ? 'pastedText' : 'pastedTexts',
    labelVars: { name: names[0]!, count: String(names.length) },
    text: `\n\n${blocks.join('\n\n')}`,
  }];
}

/** A voice context is a recap of a few spoken turns, not a document. */
export const MAX_VOICE_CONTEXT_CHARS = 6_000;

/**
 * Context of a turn delegated by the GPT-Live voice layer: the recent spoken
 * exchanges the agent never received (GPT-Live answered them itself), and the
 * fact that its answer will be read aloud. Written by the browser, which alone
 * holds the transcript; folded in the bubble like a paste.
 */
export function voiceContextParts(context: unknown): PromptPart[] {
  if (typeof context !== 'string') return [];
  const text = context.trim().slice(0, MAX_VOICE_CONTEXT_CHARS);
  if (!text) return [];
  return [{
    kind: 'instruction',
    label: 'voiceContext',
    text: [
      ``,
      ``,
      `<voice_conversation>`,
      text,
      `</voice_conversation>`,
      `The user is talking to you by voice through a voice assistant, which reads your answer aloud in short form. Lead with the essential answer in a few plain sentences; code, lists and details stay in the chat.`,
    ].join('\n'),
  }];
}

/**
 * Assembles the turn sent: the slash expansion (already split) then the
 * attachments and the pastes. Returns `presentation: undefined` when nothing was
 * rewritten — a
 * message typed as is has no section to collapse.
 *
 * A reply (`reply-to.ts`) heads the turn with its own part, kept apart from
 * the rest: merged with a skill's instruction behind it, the label the thread
 * hides it by would hide the skill too.
 */
export function composeChatTurn(
  slash: { expanded: string; presentation?: PromptPresentation },
  files: PersistedAttachment[],
  pasted?: unknown,
  voiceContext?: unknown,
  reply?: ReplyTarget | null,
): { text: string; presentation?: PromptPresentation } {
  const extra = [...pastedParts(pasted), ...attachmentParts(files), ...voiceContextParts(voiceContext)];
  if (!slash.presentation && extra.length === 0 && !reply) return { text: slash.expanded };
  const base: PromptPart[] = slash.presentation?.parts
    ?? [{ kind: 'text', text: slash.expanded }];
  const composed = composePrompt([...base, ...extra]);
  if (!reply) return { text: composed.text, presentation: composed.presentation };
  const header = replyPart(reply);
  return {
    text: header.text + composed.text,
    presentation: {
      ...composed.presentation,
      parts: [header, ...composed.presentation.parts],
      attachments: [...(composed.presentation.attachments ?? []), replyAttachment(reply)],
    },
  };
}
