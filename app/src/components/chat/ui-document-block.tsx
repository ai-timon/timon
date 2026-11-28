'use client';

/**
 * An HTML document in the chat thread (MCPUI, docs/ADR-MCPUI.md): a page an
 * agent, the owner or a plugin showed through `ui_render`, rendered in an
 * iframe sandboxed WITHOUT `allow-same-origin` — an opaque origin that reaches
 * neither the app, nor its cookies, nor the daemon's API.
 *
 * The thread paints the SLOT `chat.document`, not this card: the product
 * occupies it by default (`fallback`, client half of `@timon/ui-documents`)
 * and a plugin that declares the slot takes its place. The slot is declared
 * at boot (`slots.ts`), not by the cards: a replacement registers when the
 * plugins load, before any document is on screen, and must outlive every
 * card. The occupant reads the block from context (`useUiDocument`).
 * A replacement changes the dressing and keeps the security by rendering
 * `UiDocumentFrame`, which owns the iframe, the MCP Apps bridge, the height
 * and the focus rule (D4.1).
 *
 * The document is only ever loaded from `uiDocumentUrl(id)`, the Timon
 * origin; the title is a text node. Before the iframe mounts, the card reads
 * the document's view: an opaque origin hides the status of what it loads,
 * so a purged document would otherwise paint the daemon's raw 404.
 *
 * Interactivity (D5, D6, D11): the document's answer (`submit`) leaves only
 * from a focus that entered it legitimately, under a recent user activation;
 * a message it proposes waits for the owner's click on a banner; a link opens
 * `https:` only; the full screen keeps the iframe mounted and gives way as
 * soon as the agent waits for the user. The card sends, never the document:
 * its origin is opaque and reaches neither the app's routes nor its cookies.
 */

import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FileCode2, Maximize2, Minimize2 } from 'lucide-react';
import { SlotSingle } from '@/lib/plugin-host/render';
import { CHAT_DOCUMENT_SLOT } from '@/lib/plugin-host/slots';
import { isModuleOn, useCapabilities } from '@/lib/capabilities';
import { desktopBridge } from '@/lib/desktop';
import { createFrameFocusTracker, type FrameFocusState, type FrameFocusTracker } from '@/lib/frame-focus';
import { getLocale, t } from '@/lib/i18n';
import { systemTimeZone } from '@/lib/intl';
import {
  createMcpAppHost,
  themeVariables,
  type DisplayMode,
  type McpAppHost,
  type McpAppHostContext,
  type SubmitOutcome,
} from '@/lib/mcp-app-host';
import {
  dismissUiDocumentRequest,
  documentMessageText,
  fetchUiDocument,
  MAX_DOCUMENT_HEIGHT,
  MAX_REPLY_BYTES,
  replyBytes,
  sendUiDocumentReply,
  uiDocumentUrl,
  UI_DOCUMENTS_MODULE,
  type UiDocumentBlock,
  type UiDocumentBridge,
  type UiDocumentLookup,
} from '@/lib/ui-documents';
import { useBlockResize } from './block-resize';

export const CHAT_UI_DOCUMENT_SLOT = CHAT_DOCUMENT_SLOT;

/** The sandbox of every document iframe. Never `allow-same-origin`,
 *  `allow-popups`, `allow-top-navigation*`, `allow-modals`, `allow-downloads`. */
export const UI_DOCUMENT_SANDBOX = 'allow-scripts allow-forms';

const DEFAULT_HEIGHT = 160;
const HEADER_TOUCH_MS = 2000;

export type UiDocumentValue = {
  document: UiDocumentBlock;
  missionId: string;
  /** Where the HTML is served: the Timon origin, nothing else. */
  src: string;
  bridge: UiDocumentBridge;
};

const UiDocumentContext = createContext<UiDocumentValue | null>(null);

/**
 * What the conversation lends its documents: whether the agent waits for the
 * user right now (a permission card, a question, a command, a proposal — the
 * full screen gives way to it), and the owner's own way of sending a message
 * (the composer's route and queue). Absent outside a chat: a document there
 * neither sends messages nor goes full screen.
 */
export type ChatDocumentHost = {
  awaitingUser: boolean;
  /** `queued`: the agent was mid-turn, the message goes out at its end, like a typed one. */
  sendAsOwner(missionId: string, text: string): Promise<'sent' | 'queued' | 'failed'>;
};

const ChatDocumentHostContext = createContext<ChatDocumentHost | null>(null);
export const ChatDocumentHostProvider = ChatDocumentHostContext.Provider;

/** The one document in full screen, by id: a second one is refused (D6). */
let fullscreenHolder: string | null = null;

type ActivationProbe = () => boolean;
const browserActivation: ActivationProbe = () => {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  // No API (an older WebKit): no proof of a gesture, so no answer leaves (A-TESTER-MULTI-OS).
  return activation?.isActive === true;
};
let userActivation: ActivationProbe = browserActivation;

/** jsdom has no `navigator.userActivation`: tests say whether a gesture is current. */
export function setUserActivationProbe(probe: ActivationProbe | null): void {
  userActivation = probe ?? browserActivation;
}

/** Readable by a plugin that takes the slot: the document, its mission, its URL. */
export function useUiDocument(): UiDocumentValue | null {
  return useContext(UiDocumentContext);
}

export function ChatUiDocumentSlot({ document, missionId }: { document: UiDocumentBlock; missionId: string }) {
  const caps = useCapabilities();
  const on = isModuleOn(caps, UI_DOCUMENTS_MODULE);
  // Module switched off: its routes are gone, so no occupant could load anything.
  if (!on) return <UiDocumentNote title={document.title} note={t('uiDocument.unavailable')} />;
  return (
    <UiDocumentContext.Provider value={{ document, missionId, src: uiDocumentUrl(document.id), bridge: document.bridge }}>
      <SlotSingle name={CHAT_UI_DOCUMENT_SLOT} />
    </UiDocumentContext.Provider>
  );
}

function UiDocumentNote({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5 rounded-xl bg-card px-3.5 py-2.5 text-[12.5px] shadow-elev-1 dark:bg-surface-2" role="note">
      <span className="truncate font-medium text-foreground">{title}</span>
      <span className="text-muted-foreground">{note}</span>
    </div>
  );
}

/** The product's card: title, state, and the document itself. Its state
 *  comes from the mission's events, `ui_document_resolved` included: both are
 *  persisted, so a replay already ends on the last one. */
export function UiDocumentCard() {
  const value = useUiDocument();
  if (!value) return null;
  const shown = value.document;
  const titleId = `ui-doc-title-${shown.id}`;
  if (shown.status === 'dismissed') return <UiDocumentNote title={shown.title} note={t('uiDocument.dismissed')} />;

  return (
    <section
      role="group"
      aria-labelledby={titleId}
      data-ui-document={shown.status}
      className="flex w-full min-w-0 flex-col gap-2 rounded-xl bg-card px-3 py-2.5 shadow-elev-1 dark:bg-surface-2"
    >
      <header className="flex min-w-0 items-center gap-2 text-[11.5px] text-muted-foreground">
        <FileCode2 aria-hidden="true" className="h-3.5 w-3.5 shrink-0" />
        <span id={titleId} className="min-w-0 truncate font-medium text-foreground">{shown.title}</span>
        {shown.status === 'answered' && (
          <span className="shrink-0 rounded bg-[hsl(var(--success)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--success))]">
            {t('uiDocument.answered')}
          </span>
        )}
        {shown.status === 'pending' && (
          <span className="shrink-0 rounded bg-[hsl(var(--info)/0.12)] px-1.5 py-0.5 text-[10px] text-[hsl(var(--info))]">
            {t('uiDocument.pending')}
          </span>
        )}
      </header>
      <UiDocumentFrame />
    </section>
  );
}

const hoverNone = (): boolean => typeof window.matchMedia === 'function' && window.matchMedia('(hover: none)').matches;

function currentContext(width: number, mode: DisplayMode, canFullscreen: boolean): McpAppHostContext {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const noHover = hoverNone();
  const timeZone = systemTimeZone();
  return {
    theme: root.classList.contains('dark') ? 'dark' : 'light',
    styles: { variables: themeVariables((token) => style.getPropertyValue(token)) },
    displayMode: mode,
    availableDisplayModes: canFullscreen ? ['inline', 'fullscreen'] : ['inline'],
    containerDimensions: { width: Math.round(width), maxHeight: MAX_DOCUMENT_HEIGHT },
    platform: desktopBridge() ? 'desktop' : 'web',
    locale: getLocale(),
    timeZone,
    deviceCapabilities: { touch: noHover || (navigator.maxTouchPoints ?? 0) > 0, hover: !noHover },
  };
}

type Lookup = { kind: 'loading' } | UiDocumentLookup;

/**
 * The document itself: its view read first, then the iframe, its bridge, its
 * height and its focus rule. Reads the document from `useUiDocument()`; a
 * slot replacement renders it inside its own card and inherits all of it.
 *
 * The iframe mounts on a view found, and only then: an opaque origin hides
 * the status of what it loads, so a purged document (404) or a refused read
 * (401, 5xx) would otherwise paint the daemon's raw JSON inside the card.
 */
export function UiDocumentFrame() {
  const value = useUiDocument();
  const [lookup, setLookup] = useState<Lookup>({ kind: 'loading' });
  const id = value?.document.id;

  useEffect(() => {
    if (!id) return;
    setLookup({ kind: 'loading' });
    const ctrl = new AbortController();
    void fetchUiDocument(id, ctrl.signal).then((found) => {
      if (!ctrl.signal.aborted) setLookup(found);
    });
    return () => ctrl.abort();
  }, [id]);

  if (!value) return null;
  if (lookup.kind === 'loading') {
    return <div aria-hidden="true" className="w-full animate-pulse rounded-lg bg-muted/60" style={{ height: value.document.height ?? DEFAULT_HEIGHT }} />;
  }
  if (lookup.kind !== 'found') {
    return (
      <div role="note" className="rounded-lg bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
        {t(lookup.kind === 'expired' ? 'uiDocument.expired' : 'uiDocument.loadFailed')}
      </div>
    );
  }
  return <LoadedDocumentFrame initialReply={lookup.reply} deliverable={lookup.deliverable} />;
}

type Answer = { reply: unknown; delivered: boolean | null };
type MessageAsk = { text: string; settle: (sent: boolean) => void };

function replyText(reply: unknown): string {
  try { return JSON.stringify(reply, null, 2) ?? ''; } catch { return ''; }
}

function LoadedDocumentFrame({ initialReply, deliverable }: { initialReply?: unknown; deliverable?: boolean }) {
  const value = useUiDocument();
  const chat = useContext(ChatDocumentHostContext);
  const resize = useBlockResize();
  const rootRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const entryRef = useRef<HTMLButtonElement>(null);
  const exitRef = useRef<HTMLButtonElement>(null);
  const hostRef = useRef<McpAppHost | null>(null);
  const trackerRef = useRef<FrameFocusTracker | null>(null);
  const loads = useRef(0);
  const headerTouchedAt = useRef(0);
  const pendingResize = useRef<{ delta: number; before: number | null } | null>(null);
  const frameRequest = useRef<number | null>(null);
  const [height, setHeight] = useState(() => value?.document.height ?? DEFAULT_HEIGHT);
  const heightRef = useRef(height);
  const [left, setLeft] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [focus, setFocus] = useState<FrameFocusState>({ overlay: false, neutralized: false, thefts: 0, announcements: 0 });
  const [mode, setMode] = useState<DisplayMode>('inline');
  const modeRef = useRef<DisplayMode>('inline');
  const [answer, setAnswer] = useState<Answer | null>(() =>
    initialReply !== undefined && initialReply !== null ? { reply: initialReply, delivered: null } : null);
  const answerRef = useRef(answer);
  const submitting = useRef(false);
  const [ask, setAsk] = useState<MessageAsk | null>(null);
  const askRef = useRef<MessageAsk | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const src = value?.src;
  const bridge = value?.bridge;
  const doc = value?.document;
  const id = doc?.id;
  const missionId = value?.missionId;
  const canFullscreen = chat !== null;
  const awaitingUser = chat?.awaitingUser ?? false;
  // Read by the bridge's callbacks, which live as long as the iframe: never a stale value.
  const live = useRef({ doc, chat, missionId });
  live.current = { doc, chat, missionId };
  answerRef.current = answer;

  const interacting = useCallback((): boolean =>
    (trackerRef.current?.engaged() ?? false) || Date.now() - headerTouchedAt.current < HEADER_TOUCH_MS, []);

  // At most one height per frame; 1 px of jitter is not a change.
  const onSizeChanged = useCallback((next: number) => {
    if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
    frameRequest.current = requestAnimationFrame(() => {
      frameRequest.current = null;
      const delta = next - heightRef.current;
      if (Math.abs(delta) <= 1) return;
      pendingResize.current = { delta, before: resize?.snapshot() ?? null };
      heightRef.current = next;
      setHeight(next);
    });
  }, [resize]);

  useLayoutEffect(() => {
    const pending = pendingResize.current;
    const root = rootRef.current;
    if (!pending || !root) return;
    pendingResize.current = null;
    // In full screen the box is out of the thread: its placeholder keeps the inline height.
    resize?.resized(root, pending.delta, interacting(), pending.before);
  }, [height, resize, interacting]);

  const pushContext = useCallback(() => {
    hostRef.current?.updateContext(currentContext(rootRef.current?.clientWidth ?? 0, modeRef.current, canFullscreen));
  }, [canFullscreen]);

  const setDisplayMode = useCallback((next: DisplayMode, opts: { returnFocus: boolean }) => {
    if (modeRef.current === next) return;
    modeRef.current = next;
    if (next === 'fullscreen') fullscreenHolder = id ?? null;
    else if (fullscreenHolder === id) fullscreenHolder = null;
    setMode(next);
    pushContext();
    if (next === 'inline' && opts.returnFocus) requestAnimationFrame(() => entryRef.current?.focus());
  }, [id, pushContext]);

  /** The card's own checks before an answer leaves (D6): the daemon checks the rest. */
  const onSubmit = useCallback(async (reply: Record<string, unknown>): Promise<SubmitOutcome> => {
    const current = live.current.doc;
    if (!current?.expectsReply) return { ok: false, reason: 'This document does not take an answer.' };
    if (answerRef.current || current.status !== 'pending') return { ok: false, reason: 'This document was already answered or closed.' };
    if (!trackerRef.current?.legitimatelyInside() || !userActivation()) {
      return { ok: false, reason: 'An answer is sent by a click or a key press in the document.' };
    }
    const bytes = replyBytes(reply);
    if (bytes === null || bytes > MAX_REPLY_BYTES) return { ok: false, reason: `The answer must be JSON of at most ${MAX_REPLY_BYTES} bytes.` };
    if (submitting.current) return { ok: false, reason: 'An answer is already being sent.' };
    submitting.current = true;
    try {
      const outcome = await sendUiDocumentReply(current.id, reply);
      if (outcome.kind === 'refused') {
        setNotice(t('uiDocument.replyFailed'));
        return { ok: false, reason: `The answer was refused (${outcome.error}).` };
      }
      const sent = { reply: outcome.reply, delivered: outcome.delivered };
      answerRef.current = sent;
      setAnswer(sent);
      setNotice(null);
      return { ok: true };
    } finally {
      submitting.current = false;
    }
  }, []);

  // A message in the owner's name: never without their click on the banner (D6).
  const onMessage = useCallback((text: string): Promise<boolean> => {
    const { chat: host, missionId: mission, doc: current } = live.current;
    if (!host || !mission || !current || askRef.current) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const entry: MessageAsk = {
        text,
        settle: (send) => {
          if (askRef.current !== entry) return;
          askRef.current = null;
          setAsk(null);
          if (!send) { resolve(false); return; }
          void host.sendAsOwner(mission, documentMessageText(current.title, text)).then((outcome) => {
            if (outcome === 'failed') setNotice(t('uiDocument.messageFailed'));
            resolve(outcome !== 'failed');
          });
        },
      };
      askRef.current = entry;
      setAsk(entry);
    });
  }, []);

  const onOpenLink = useCallback(async (url: string): Promise<boolean> => {
    if (!trackerRef.current?.legitimatelyInside() || !userActivation()) return false;
    window.open(url, '_blank', 'noopener,noreferrer');
    return true;
  }, []);

  const onDisplayMode = useCallback(async (requested: DisplayMode | 'pip'): Promise<DisplayMode> => {
    if (requested === 'inline') { setDisplayMode('inline', { returnFocus: true }); return 'inline'; }
    if (requested !== 'fullscreen') return modeRef.current;
    const { chat: host } = live.current;
    // A document cannot cover the app on its own: a gesture in it, nobody waiting, no other one up.
    const allowed = host !== null && !host.awaitingUser
      && (fullscreenHolder === null || fullscreenHolder === id)
      && (trackerRef.current?.legitimatelyInside() ?? false) && userActivation();
    if (allowed) setDisplayMode('fullscreen', { returnFocus: false });
    return modeRef.current;
  }, [id, setDisplayMode]);

  // The bridge: messages from THIS iframe's window, from an opaque origin, only.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !bridge) return;
    const host = createMcpAppHost({
      post: (message) => frame.contentWindow?.postMessage(message, '*'),
      context: () => currentContext(rootRef.current?.clientWidth ?? 0, modeRef.current, canFullscreen),
      onSizeChanged,
      onSubmit,
      onMessage,
      onOpenLink,
      onDisplayMode,
      onRequestTeardown: () => setCollapsed(true),
    });
    hostRef.current = host;
    const onWindowMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow || event.origin !== 'null') return;
      host.receive(event.data);
    };
    window.addEventListener('message', onWindowMessage);
    // Theme and width reach the document as host-context-changed, never as a reload.
    let scheduled: number | null = null;
    const refresh = () => {
      if (scheduled !== null) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = null;
        host.updateContext(currentContext(rootRef.current?.clientWidth ?? 0, modeRef.current, canFullscreen));
      });
    };
    const themeWatch = new MutationObserver(refresh);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
    const widthWatch = typeof ResizeObserver === 'function' ? new ResizeObserver(refresh) : null;
    if (rootRef.current) widthWatch?.observe(rootRef.current);
    return () => {
      host.close();
      hostRef.current = null;
      window.removeEventListener('message', onWindowMessage);
      themeWatch.disconnect();
      widthWatch?.disconnect();
      if (scheduled !== null) cancelAnimationFrame(scheduled);
    };
  }, [bridge, onSizeChanged, onSubmit, onMessage, onOpenLink, onDisplayMode, canFullscreen, collapsed]);

  useEffect(() => () => {
    if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
    askRef.current?.settle(false);
    if (fullscreenHolder === id) fullscreenHolder = null;
  }, [id]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const tracker = createFrameFocusTracker({
      doc: document,
      iframe: frame,
      entry: () => entryRef.current,
      touch: hoverNone,
      onChange: setFocus,
      onReturn: () => entryRef.current?.focus(),
    });
    trackerRef.current = tracker;
    setFocus(tracker.state);
    // The card's header counts as interacting (D10): a click there must not
    // be followed by the thread jumping away.
    const card = rootRef.current?.closest('[role="group"]') ?? rootRef.current;
    const onPointerDown = () => { headerTouchedAt.current = Date.now(); };
    card?.addEventListener('pointerdown', onPointerDown);
    return () => {
      tracker.dispose();
      trackerRef.current = null;
      card?.removeEventListener('pointerdown', onPointerDown);
    };
  }, [left, collapsed]);

  // The full screen gives way as soon as the agent waits for the user (D11).
  useEffect(() => {
    if (awaitingUser && modeRef.current === 'fullscreen') setDisplayMode('inline', { returnFocus: true });
  }, [awaitingUser, setDisplayMode]);

  // Full screen: the same box in the top layer, the iframe never re-parented (its state survives).
  useLayoutEffect(() => {
    const box = boxRef.current as (HTMLDivElement & { showPopover?: () => void; hidePopover?: () => void }) | null;
    if (!box || mode !== 'fullscreen') return;
    if (typeof box.showPopover === 'function') {
      box.setAttribute('popover', 'manual');
      try { box.showPopover(); } catch { /* the fixed position below still covers the page */ }
    }
    // Escape with the focus on the host, or the focus taken elsewhere, leaves the full screen.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      setDisplayMode('inline', { returnFocus: true });
    };
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (target instanceof Node && !box.contains(target)) setDisplayMode('inline', { returnFocus: false });
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('focusin', onFocusIn, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('focusin', onFocusIn, true);
      if (box.hasAttribute('popover')) {
        try { box.hidePopover?.(); } catch { /* already hidden */ }
        box.removeAttribute('popover');
      }
    };
  }, [mode, setDisplayMode]);

  // Answered elsewhere (another tab): what was sent, read again without touching the iframe.
  const status = doc?.status;
  useEffect(() => {
    if (status !== 'answered' || answerRef.current || !id) return;
    const ctrl = new AbortController();
    void fetchUiDocument(id, ctrl.signal).then((found) => {
      if (ctrl.signal.aborted || found.kind !== 'found' || found.reply === undefined || found.reply === null) return;
      setAnswer({ reply: found.reply, delivered: null });
    });
    return () => ctrl.abort();
  }, [status, id]);

  // A second `load` is the document leaving the page Timon served: whatever
  // loaded now is not Timon's to show, nor to speak for the document.
  const onLoad = useCallback(() => {
    loads.current += 1;
    if (loads.current < 2) return;
    hostRef.current?.close();
    setDisplayMode('inline', { returnFocus: false });
    setLeft(true);
  }, [setDisplayMode]);

  const enter = useCallback(() => {
    trackerRef.current?.arm();
    frameRef.current?.focus();
  }, []);

  const reactivate = useCallback(() => {
    trackerRef.current?.reactivate();
    entryRef.current?.focus();
  }, []);

  const show = useCallback(() => {
    loads.current = 0;
    setCollapsed(false);
  }, []);

  const closeWithoutAnswer = useCallback(async () => {
    if (!id || closing) return;
    setClosing(true);
    setDisplayMode('inline', { returnFocus: false });
    await hostRef.current?.teardown();
    const ok = await dismissUiDocumentRequest(id);
    setClosing(false);
    if (!ok) setNotice(t('uiDocument.dismissFailed'));
  }, [id, closing, setDisplayMode]);

  if (!value || !src || !doc) return null;
  const title = doc.title;
  const fullscreen = mode === 'fullscreen';
  const waiting = doc.expectsReply && doc.status === 'pending' && !answer;
  const kept = doc.origin.kind === 'agent' && doc.expectsReply
    && ((answer !== null && answer.delivered === false) || (waiting && deliverable === false));

  if (left) {
    return (
      <div ref={rootRef} role="note" className="rounded-lg bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
        {t('uiDocument.left')}
      </div>
    );
  }

  const quietButton = 'rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <div ref={rootRef} className="flex min-w-0 flex-col gap-1.5" data-ui-document-frame="" data-display-mode={mode}>
      <div className="flex flex-wrap items-center gap-1">
        <button ref={entryRef} type="button" onClick={enter} disabled={collapsed} className={quietButton}>
          {t('uiDocument.enter')}
        </button>
        {canFullscreen && !collapsed && (
          <button
            type="button"
            onClick={() => {
              if (awaitingUser || (fullscreenHolder !== null && fullscreenHolder !== id)) return;
              setDisplayMode('fullscreen', { returnFocus: false });
              // The button that opened it is now covered: the focus goes to the way out.
              requestAnimationFrame(() => exitRef.current?.focus());
            }}
            disabled={awaitingUser}
            className={`${quietButton} inline-flex items-center gap-1 disabled:opacity-50`}
          >
            <Maximize2 aria-hidden="true" className="h-3 w-3" />
            {t('uiDocument.fullscreen')}
          </button>
        )}
      </div>
      {collapsed ? (
        <div role="note" className="flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 px-3 py-2 text-[12px] text-muted-foreground">
          <span className="min-w-0 flex-1">{t('uiDocument.closedByDocument')}</span>
          <button type="button" onClick={show} className={quietButton}>{t('uiDocument.show')}</button>
        </div>
      ) : (
        // Holds the thread's place while the box is in the top layer.
        <div style={fullscreen ? { height } : undefined}>
          <div
            ref={boxRef}
            data-ui-document-box=""
            className={fullscreen
              ? 'timon-below-window-band timon-window-layer fixed inset-0 z-[70] m-0 flex h-full max-h-none w-full max-w-none flex-col gap-2 bg-background p-3'
              : 'relative flex w-full min-w-0 flex-col gap-1.5'}
          >
            {fullscreen && (
              <div className="flex min-w-0 items-center gap-2 rounded-lg bg-card px-3 py-1.5 shadow-elev-1 dark:bg-surface-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">{title}</span>
                <button
                  ref={exitRef}
                  type="button"
                  onClick={() => setDisplayMode('inline', { returnFocus: true })}
                  className={`${quietButton} inline-flex items-center gap-1`}
                >
                  <Minimize2 aria-hidden="true" className="h-3 w-3" />
                  {t('uiDocument.exitFullscreen')}
                </button>
              </div>
            )}
            <div className={fullscreen ? 'relative min-h-0 flex-1 overflow-hidden rounded-lg bg-background' : 'relative w-full min-w-0 shrink-0 overflow-hidden rounded-lg bg-background'}>
              <iframe
                ref={frameRef}
                src={src}
                title={title}
                sandbox={UI_DOCUMENT_SANDBOX}
                referrerPolicy="no-referrer"
                onLoad={onLoad}
                className="block w-full"
                style={{ height: fullscreen ? '100%' : height, border: 0 }}
              />
              {focus.overlay && !focus.neutralized && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={enter}
                  aria-label={t('uiDocument.arm')}
                  className="absolute inset-0 cursor-pointer bg-transparent"
                  data-ui-document-layer=""
                />
              )}
            </div>
            {/* Inside the box: in full screen, what asks the owner rises with the document. */}
            {ask && (
              <div className="flex flex-col gap-2 rounded-lg bg-[hsl(var(--info)/0.1)] px-3 py-2 text-[12px] text-foreground" role="alertdialog" aria-label={t('uiDocument.messageAsk')}>
                <span>{t('uiDocument.messageAsk')}</span>
                <p className="whitespace-pre-wrap break-words rounded-md bg-background px-2.5 py-1.5 text-[12.5px]">{ask.text}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => ask.settle(true)}
                    className="rounded-md bg-primary px-2.5 py-1 text-[11.5px] font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t('uiDocument.messageSend')}
                  </button>
                  <button type="button" onClick={() => ask.settle(false)} className={quietButton}>{t('uiDocument.messageCancel')}</button>
                </div>
              </div>
            )}
            {focus.neutralized && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg bg-[hsl(var(--warning)/0.1)] px-3 py-2 text-[12px] text-foreground" role="status">
                <span className="min-w-0 flex-1">{t('uiDocument.neutralized')}</span>
                <button
                  type="button"
                  onClick={reactivate}
                  className="rounded-md bg-background px-2 py-0.5 text-[11.5px] font-medium shadow-elev-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('uiDocument.reactivate')}
                </button>
              </div>
            )}
            {answer && (
              <div className="flex flex-col gap-1 rounded-lg bg-muted/40 px-3 py-2" data-ui-document-answer="">
                <span className="text-[11px] text-muted-foreground">{t('uiDocument.sent')}</span>
                {/* code-font: the JSON the document sent, shown as data */}
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11.5px] text-foreground">{replyText(answer.reply)}</pre>
              </div>
            )}
            {kept && <p role="note" className="text-[11.5px] text-muted-foreground">{t('uiDocument.kept')}</p>}
            {notice && <p role="alert" className="text-[11.5px] text-[hsl(var(--destructive))]">{notice}</p>}
            {waiting && (
              <div className="flex">
                <button type="button" onClick={() => void closeWithoutAnswer()} disabled={closing} className={quietButton}>
                  {t('uiDocument.dismissPending')}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
      <span className="sr-only" aria-live="polite">
        {focus.announcements > 0 && <span key={focus.announcements}>{t('uiDocument.focusTaken')}</span>}
      </span>
    </div>
  );
}
