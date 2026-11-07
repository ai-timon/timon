'use client';

/**
 * The actions under a chat bubble: copy, copy as Markdown, reply, read aloud.
 *
 * They are the product's occupants of a LIST slot, `chat.message.action`: a
 * plugin adds its own button beside them with `ctx.slots.register`, and reads
 * the bubble it is painted under with `useChatMessage()`. The reply that the
 * Reply button arms is read and set with `useComposerReply()`, which is what
 * the composer's "replying to" strip paints — a replacement composer reads the
 * same hook (client API 15).
 *
 * The bubble passes nothing to the slot (a slot host mounts its occupants
 * without props): what an action needs comes through the two contexts.
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, FileCode2, Reply, Square, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import { t as i18n } from '@/lib/i18n';
import { copyToClipboard } from '@/lib/clipboard';
import { regionalTag } from '@/lib/intl';
import { Slot } from '@/lib/plugin-host/render';
import { declareSlot, register, slotKind } from '@/lib/plugin-host/slots';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

/** What an action knows of the bubble it sits under. */
export type ChatMessageView = {
  role: 'agent' | 'user';
  /** The stored event the bubble was drawn from; null while it is unknown
   *  (a bubble no row backs) — nothing can reply to it then. */
  eventId: number | null;
  missionId: string | null;
  /** The text as Markdown: the agent's own source, or what the human typed. */
  markdown: string;
  /** The text as the bubble renders it (trusted, sanitized HTML). */
  html: string;
};

/** The earlier message the next turn answers. */
export type ComposerReply = {
  eventId: number;
  role: 'agent' | 'user';
  /** Its opening words, on one line: what the strip shows. */
  excerpt: string;
};

export type ComposerReplyApi = {
  reply: ComposerReply | null;
  setReply: (reply: ComposerReply | null) => void;
};

const ChatMessageContext = createContext<ChatMessageView | null>(null);
const ComposerReplyContext = createContext<ComposerReplyApi | null>(null);

/** The bubble an occupant of `chat.message.action` is painted under; null elsewhere. */
export function useChatMessage(): ChatMessageView | null {
  return useContext(ChatMessageContext);
}

const NO_REPLY: ComposerReplyApi = { reply: null, setReply: () => {} };

/** The reply the composer is about to send, and its setter. Outside a chat the
 *  setter does nothing. */
export function useComposerReply(): ComposerReplyApi {
  return useContext(ComposerReplyContext) ?? NO_REPLY;
}

/** Mounted by the chat around the thread AND the composer: both read it. */
export function ComposerReplyProvider({ value, children }: { value: ComposerReplyApi; children: ReactNode }) {
  return <ComposerReplyContext.Provider value={value}>{children}</ComposerReplyContext.Provider>;
}

/** Characters of a message the reply strip shows. */
export const REPLY_STRIP_CHARS = 140;

/** One line of plain text from the bubble's HTML, cut at a word. */
export function replyExcerpt(text: string, max = REPLY_STRIP_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The bubble's text without its markup, as a reader sees it. */
export function plainTextOf(html: string): string {
  if (typeof document === 'undefined') return html.replace(/<[^>]+>/g, ' ').trim();
  const source = document.createElement('div');
  source.innerHTML = html;
  return (source.innerText || source.textContent || '').trim();
}

export const CHAT_MESSAGE_ACTION_SLOT = 'chat.message.action';

/**
 * Same bookkeeping as the composer's slots (`monterComposerSlot`): the
 * registry is global, the chat is not — the multichat mounts several. The first
 * chat declares and registers, the last one to leave undoes it.
 */
let chatsMounted = 0;
let undo: Array<() => void> = [];

export function mountMessageActionSlot(): () => void {
  if (chatsMounted++ === 0) {
    if (slotKind(CHAT_MESSAGE_ACTION_SLOT) === null) {
      undo.push(declareSlot(CHAT_MESSAGE_ACTION_SLOT, 'list', 'chat-message'));
    }
    // Low orders: a plugin's button, which says nothing, lands after them.
    for (const [order, Component] of [[10, CopyAction], [20, CopyMarkdownAction], [30, ReplyAction], [40, ReadAloudAction]] as const) {
      undo.push(register({ slot: CHAT_MESSAGE_ACTION_SLOT, pluginId: '@timon/missions', order }, Component));
    }
  }
  return () => {
    if (--chatsMounted === 0) {
      for (const step of undo.reverse()) step();
      undo = [];
    }
  };
}

/**
 * The row under a bubble, shown on hover like the big chat apps. The icons sit
 * on the message's column, not their 24px hit areas: the margin cancels the
 * 4px around a glyph (14px column on desktop, see `FLAT_BUBBLE_BOX`). A human
 * bubble is aligned right, so is its row.
 */
export function MessageActionBar({ message }: { message: ChatMessageView }) {
  return (
    <ChatMessageContext.Provider value={message}>
      <TooltipProvider delayDuration={300} skipDelayDuration={300}>
        <div className={cn(
          '-mt-1.5 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-45',
          message.role === 'user' ? 'justify-end' : '-ml-1 sm:ml-2.5',
        )}>
          <Slot name={CHAT_MESSAGE_ACTION_SLOT} />
        </div>
      </TooltipProvider>
    </ChatMessageContext.Provider>
  );
}

const ACTION_BUTTON = 'grid size-6 place-items-center rounded-md text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60';

/** An icon button with its tooltip. Exported for the plugins' own actions
 *  through `@timon/ui`, so theirs look like ours. */
export function MessageActionButton({
  label,
  onClick,
  pressed,
  active = false,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  /** Tinted with the accent, for an action in progress. */
  active?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          aria-label={label}
          aria-pressed={pressed}
          className={cn(ACTION_BUTTON, active && 'text-primary')}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** A copy that says it worked for a moment, then goes back to its label. */
function useCopied(): [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => { if (timer.current !== null) window.clearTimeout(timer.current); }, []);
  const copy = useCallback((text: string) => {
    void copyToClipboard(text).then((ok) => {
      if (!ok) {
        toast.error(i18n('chatPage.copyFailed'));
        return;
      }
      setCopied(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, []);
  return [copied, copy];
}

/** The text as read, without Markdown markers. */
function CopyAction() {
  const message = useChatMessage();
  const [copied, copy] = useCopied();
  if (!message || !message.html) return null;
  return (
    <MessageActionButton
      label={copied ? i18n('chatPage.copied') : i18n('chatPage.copy')}
      onClick={() => copy(plainTextOf(message.html))}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
    </MessageActionButton>
  );
}

/** The agent's own Markdown source. A human bubble has nothing more to give
 *  than its text, so the button is the agent's only. */
function CopyMarkdownAction() {
  const message = useChatMessage();
  const [copied, copy] = useCopied();
  if (!message || message.role !== 'agent' || !message.markdown.trim()) return null;
  return (
    <MessageActionButton
      label={copied ? i18n('chatPage.copied') : i18n('chatPage.copyMarkdown')}
      onClick={() => copy(message.markdown)}
    >
      {copied ? <Check className="size-4" /> : <FileCode2 className="size-4" />}
    </MessageActionButton>
  );
}

/** Arms a reply to this bubble: the composer shows it, the next send carries it. */
function ReplyAction() {
  const message = useChatMessage();
  const { reply, setReply } = useComposerReply();
  if (!message || message.eventId === null) return null;
  const eventId = message.eventId;
  const armed = reply?.eventId === eventId;
  return (
    <MessageActionButton
      label={i18n('chatPage.reply')}
      active={armed}
      pressed={armed}
      onClick={() => setReply(armed ? null : {
        eventId,
        role: message.role,
        excerpt: replyExcerpt(plainTextOf(message.html) || message.markdown),
      })}
    >
      <Reply className="size-4" />
    </MessageActionButton>
  );
}

/** The browser's own voice, in the interface's language. */
function ReadAloudAction() {
  const message = useChatMessage();
  const [speaking, setSpeaking] = useState(false);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  useEffect(() => () => {
    if (utterance.current) window.speechSynthesis?.cancel();
  }, []);
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
  if (!message || message.role !== 'agent' || !message.html || !canSpeak) return null;
  const toggle = () => {
    const synth = window.speechSynthesis;
    if (speaking) {
      synth.cancel();
      return;
    }
    const text = plainTextOf(message.html).replace(/\s+/g, ' ');
    if (!text) return;
    const next = new SpeechSynthesisUtterance(text);
    // A voice is picked by language and region: `fr` alone may get any French voice.
    next.lang = regionalTag();
    const done = () => {
      if (utterance.current === next) utterance.current = null;
      setSpeaking(false);
    };
    next.onend = done;
    next.onerror = done;
    synth.cancel();
    utterance.current = next;
    setSpeaking(true);
    synth.speak(next);
  };
  return (
    <MessageActionButton
      label={speaking ? i18n('chatPage.stopReading') : i18n('chatPage.readAloud')}
      onClick={toggle}
      pressed={speaking}
      active={speaking}
    >
      {speaking ? <Square className="size-3.5 fill-current" /> : <Volume2 className="size-4" />}
    </MessageActionButton>
  );
}
