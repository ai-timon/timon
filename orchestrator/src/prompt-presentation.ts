/** Presentation accompanies the original prompt; it never replaces agent input.
 *  `label` names the NATURE of the collapsed block as a short i18n key
 *  (`taskDone`, `missionReturn`…), translated by the client. Authored here,
 *  never guessed from the text downstream, and never the header itself.
 *  `labelVars` fills the `{placeholders}` of that key — a skill block is
 *  titled by its id, which no fixed key could carry.
 *  `segment` indexes `PromptPresentation.segments`: the part belongs to that
 *  message of a digest. Parts without one (runtime preamble) belong to none. */
export type PromptPart = {
  kind: 'text' | 'instruction';
  text: string;
  label?: string;
  labelVars?: Record<string, string>;
  segment?: number;
};

/** What a work return says, as data: the chat draws it as a card instead of
 *  showing the text written for the pilot. Only what a human needs to read
 *  without unfolding anything; the full text stays in the segment's parts. */
export type ReturnCard = {
  task_id: string | null;
  title: string | null;
  type: string | null;
  status: string | null;
  /** Mission status, for a mission that ran without a task. */
  mission_status?: string;
  verdict?: 'pass' | 'changes_requested' | 'unknown';
  merged_sha?: string;
  todo_closed?: number[];
  todo_progress?: { id: number; progress: string; landed?: number; total?: number }[];
  summary?: string;
  blocked_reason?: string;
  /** The code of `blocked_reason`, for the screen to read it in the reader's language. */
  blocked_reason_code?: { code: string; params: Record<string, string | number> };
  /** Review findings, only when the verdict is not `pass`: they call a decision. */
  findings?: string;
  /** Final report of a mission without a task: it IS the deliverable. */
  report?: string;
};

/** One message of a digest, shown as its own bubble under its real sender. */
export type PromptSegment = {
  from: string;
  /** Epoch ms the message was posted. */
  at: number;
  mission_id?: string | null;
  card?: ReturnCard;
};

/** One annotation of a posted batch, as the thread shows it (TODO #481). */
export type AnnotationCardItem = {
  id: string;
  /** The user's own words about the element. */
  comment: string;
  url: string;
  /** Empty for a page that is not the user's own development: its words stay out. */
  title: string;
  selector: string | null;
  /** Index of its thumbnail among the images of the same `user` event, or null. */
  image: number | null;
};

/** A batch of browser annotations the user posted to the agent: the thread
 *  draws it as a card. The block the agent read is never stored with it. */
export type AnnotationAttachment = {
  type: 'annotation';
  batch_id: string;
  profile_id: string;
  items: AnnotationCardItem[];
};

/** The earlier message of the same conversation a turn answers
 *  (`reply-to.ts`): the thread draws a quote, and a click goes back to it. */
export type ReplyAttachment = {
  type: 'reply';
  /** The `events` row of the bubble replied to. */
  event_id: number;
  role: 'agent' | 'user';
  /** Its opening words, on one line. */
  excerpt: string;
};

export type PresentationAttachment = AnnotationAttachment | ReplyAttachment;

/** `segments` and `attachments` are optional and additive: a client that does
 *  not know them keeps rendering `parts`, which still cover the whole text. */
export type PromptPresentation = {
  version: 1;
  parts: PromptPart[];
  segments?: PromptSegment[];
  attachments?: PresentationAttachment[];
};

export function composePrompt(
  parts: PromptPart[],
  segments?: PromptSegment[],
): { text: string; presentation: PromptPresentation } {
  const compact: PromptPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const previous = compact.at(-1);
    // Never across two messages: each segment must keep parts of its own.
    if (previous?.kind === part.kind && previous.segment === part.segment) {
      previous.text += part.text;
      // First authored label wins: a runtime preamble carries none, the
      // return header that follows it does, and the merged block is that return.
      if (!previous.label && part.label) {
        previous.label = part.label;
        if (part.labelVars) previous.labelVars = part.labelVars;
      }
    } else compact.push({ ...part });
  }
  const presentation: PromptPresentation = { version: 1, parts: compact };
  if (segments?.length) presentation.segments = segments;
  return { text: compact.map((part) => part.text).join(''), presentation };
}
