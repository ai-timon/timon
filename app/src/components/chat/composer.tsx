'use client';

/**
 * The chat composer: the input div, and the satellites that have no other
 * caller.
 *
 * Moved verbatim from `chat-client.tsx` (§10.12, U.7). What leaves with it is
 * what nobody else mounted: the model bar, the slash autocomplete popup, the
 * Terminal button and the caps banner. What the page still uses (the state
 * types, the context window) moved out to `chat-types.ts` / `chat-format.ts`:
 * importing them back from the page would make a cycle.
 *
 * The composer receives NO props: it occupies a slot (`chat.composer`), and a
 * slot host mounts its occupant without passing it anything. Everything the
 * page gave it thus goes through a context, exactly like the rail cards in
 * U.4/U.5. Outside the chat, the context is empty and the composer paints
 * nothing: it has no conversation to write in.
 */

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import {
  ArrowUp,
  AudioLines,
  Folder,
  Loader2,
  Mic,
  MicOff,
  ClipboardType,
  Paperclip,
  Square,
  SquarePen,
  SquareTerminal,
  X,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';

import { cn } from '@/lib/utils';
import {
  fileIconFor,
  fmtAttachmentSize,
  type PendingFile,
} from '@/lib/attachments';
import { t as i18n } from '@/lib/i18n';
import type { GptLiveState } from '@/lib/gpt-live/use-gpt-live';
import { BRAND } from '@/lib/brand';
import { BrandMark } from '@/components/brand-mark';
import { LlmMenu, type SwitchContextChoice } from '@/components/chat/llm-menu';
import { ChatAppearanceButton, useChatAppearance } from './chat-appearance-menu';
import { SetupComposer } from './setup-composer';
import { PendingImageStack } from './pending-image-stack';
import { PendingAttachmentRow } from './pending-attachment-row';
import { usePendingAttachments } from '@/lib/pending-attachments';
import { workingSendMode, type WorkingEnterMode } from './chat-appearance';
import { detectTerminalPlatform } from '@/lib/terminal-keys';
import { ContextGaugeMenu, fmtTokens } from './context-gauge-menu';
import { compactStore, isRunning, useMissionCompaction } from '@/lib/mission-compact';
import { openChat } from '@/lib/chat-navigation';
import { chatHref } from '@/lib/chat-island-params';
import { ContextRing } from './context-ring';
import { PermissionModeMenu } from './permission-mode-menu';
import { ThinkingLevelMenu } from './thinking-level-menu';
import { useComposerReply } from './message-actions';
import { ReplyStrip } from './reply-quote';
import { NewMissionMenu, type NewMissionOptions } from './new-mission-menu';
import { isModuleOn, isWidgetSurfaceAllowed, isZoneVisible, useCapabilities, type Capabilities } from '@/lib/capabilities';
import { fetchTerminalStatus, openConversationTerminal } from '@/lib/terminal-web';
import { backendLabel, capabilitiesFor, isAccountInstance, nativeCompactFor, useBackendCatalog, type BackendName } from '@/lib/backends';
import { AccountStateBadge } from '@/components/account-state-badge';
import { thinkingBarFor, thinkingLabel } from '@/lib/thinking-bar';
import { Slot, SlotSingle } from '@/lib/plugin-host/render';
import { declareSlot, register, slotKind } from '@/lib/plugin-host/slots';
import { contextLimitFor, nextStandardLimit } from './chat-format';
import { AccountUsageStatus } from '@/components/account-usage-status';
import { useAfterConversation } from '@/lib/load-priority';
import { agentGitId, useGit } from '@/lib/git-store';
import { projectSlugOf } from '@/lib/project-slug';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { GitBranchPicker } from '@/plugins-client/git/git-branch-picker';
import { COMPOSER_MAX_HEIGHT, observeTextareaWidth } from '@/lib/textarea-autosize';
import { canRecallPrompt, isTextareaWrapped, usePromptHistory } from '@/lib/prompt-history';
import type { ComposerDraftSetter } from '@/lib/composer-draft';
import type {
  Agent,
  LiveStats,
  PendingImage,
  RateLimitInfo,
  SkillItem,
  SkillSource,
} from './chat-types';
import { apiErrorMessage } from '@/lib/api-error';

/**
 * What the page used to pass to the composer as props.
 *
 * A single object, mounted at the level where the state lives (the page): the
 * composer re-renders at every keystroke anyway, since `input` is page state;
 * splitting it into several contexts would save no render.
 */
export type ChatComposerValue = {
  agent: Agent;
  liveStats: LiveStats;
  currentMissionId: string | null;
  pendingModelOverride: string | null;
  pendingBackendOverride: string | null;
  /** Backend + model of the next turn, derived once by the page. */
  effBackend: BackendName;
  effModel: string;
  modelSwitching: boolean;
  /** Opens the LLM modal, which the page owns (it outlives the composer).
   *  It now only serves compaction: the model is picked in the bar's
   *  dropdown menu. */
  setLlmOpen: (open: boolean) => void;
  /** Applies a backend+model pair: hot switch during the mission, override
   *  before it. The page decides which of the two. `contextMode` says how the
   *  context crosses over when it is an engine handover. */
  applyLlm: (backend: BackendName, model: string, contextMode: SwitchContextChoice) => Promise<void>;
  pendingReasoningEffort: string | null;
  missionReasoningEffort: string | null;
  applyReasoningEffort: (effort: string | null) => Promise<void>;
  /** Density and width, decided by the page (multichat, sidepanel). */
  dense: boolean;
  narrow: boolean;
  input: string;
  /** `store: false`: shown, not kept as the draft (a recalled prompt). */
  setInput: ComposerDraftSetter;
  placeholder: string;
  /** Sends the draft. `mode` only counts while a turn runs (TODO #488):
   *  `steer` redirects it now, `queue` waits for its end. Absent = the
   *  user's preference. */
  send: (mode?: WorkingEnterMode) => void;
  taRef: RefObject<HTMLTextAreaElement>;
  fileRef: RefObject<HTMLInputElement>;
  pendingImages: PendingImage[];
  setPendingImages: Dispatch<SetStateAction<PendingImage[]>>;
  addImageFiles: (files: File[]) => Promise<void>;
  pendingFiles: PendingFile[];
  setPendingFiles: Dispatch<SetStateAction<PendingFile[]>>;
  /** Images and everything else in one call — a drop or a file picker does
   *  not pre-sort what the user grabbed. */
  addAnyFiles: (files: File[]) => Promise<void>;
  /** The conversation's box of attachments deposited from outside the chat
   *  (`lib/pending-attachments`): its draft key. `send` empties it. */
  attachmentBox?: string;
  /** Pulls a long paste out of the input into a "Pasted" chip. Returns true
   *  when it took it, and the browser's own paste must not run. */
  capturePastedText: (text: string) => boolean;
  /** Reports the caret so the slash popup can open mid-sentence. */
  setCaret: Dispatch<SetStateAction<number>>;
  slashOpen: boolean;
  slashSuggestions: SkillItem[];
  slashSel: number;
  setSlashSel: Dispatch<SetStateAction<number>>;
  setSlashDismissed: Dispatch<SetStateAction<boolean>>;
  acceptSlash: (id: string) => void;
  recording: boolean;
  toggleDictation: () => void;
  /** Web Speech has no recognition service here (desktop app, TIM-0061). */
  dictationUnavailable: boolean;
  audioLevels: number[];
  visualiseurActif: boolean;
  missionCwd: string | null;
  /** GPT-Live conversation: null while the feature is off or has no key. */
  gptLive: { state: GptLiveState; toggle: () => void } | null;
  thinking: boolean;
  stopping: boolean;
  turnResumable: boolean;
  stopTurn: () => Promise<void>;
  /** Starts a blank conversation with the same agent, wherever the chat is mounted. */
  onNewConversation: () => void;
  /** The project's agents the New button offers instead (TODO #344). */
  newMission?: NewMissionOptions | null;
};

const ChatComposerContext = createContext<ChatComposerValue | null>(null);

/** The input: only one per chat, hence a `single` slot. */
export const CHAT_COMPOSER_SLOT = 'chat.composer';

/** The satellite buttons, next to send. They survive the composer being
 *  replaced: a plugin that takes the slot also takes over its actions, or
 *  ignores them. */
export const CHAT_COMPOSER_ACTION_SLOT = 'chat.composer.action';

/**
 * Number of chats mounted right now, and what the last one will have to undo.
 *
 * The slot registry is global, the composer is not: the multichat mounts
 * several `ChatClient` side by side, and each paints ITS input. What the
 * registry holds is thus the composer's DESCRIPTION (a registration), not an
 * instance: each chat renders the slot occupant in its own context. Hence the
 * counter: the first cell declares and registers, the last one to leave undoes.
 * Without it, the second cell would be refused the registration (`single`
 * already filled), and closing the first would take away the input of all the
 * others.
 */
let chatsMontes = 0;
let aDefaire: Array<() => void> = [];

/**
 * Declares the composer slot and registers the default occupant in it.
 *
 * The chat is outside the `ui-layout` tree (it is not under `(main)`), so
 * nobody else declares its slots, like the two columns in U.4. The `slotKind`
 * guard covers the day a third-party layout mounts the chat in its tree: we
 * then make do with the slot already declared.
 */
export function monterComposerSlot(): () => void {
  if (chatsMontes++ === 0) {
    for (const [nom, nature] of [
      [CHAT_COMPOSER_SLOT, 'single'],
      [CHAT_COMPOSER_ACTION_SLOT, 'list'],
    ] as const) {
      if (slotKind(nom) === null) aDefaire.push(declareSlot(nom, nature, 'chat-composer'));
    }
    // `fallback`: the product occupies the slot WITHOUT closing it. A plugin that
    // declares `chat.composer` registers in it anyway and takes the place; the
    // product's composer comes back as soon as it is removed.
    aDefaire.push(register(
      { slot: CHAT_COMPOSER_SLOT, pluginId: '@timon/missions', fallback: true },
      ChatComposer,
    ));
  }
  return () => {
    if (--chatsMontes === 0) {
      for (const defaire of aDefaire.reverse()) defaire();
      aDefaire = [];
    }
  };
}

/**
 * The place of the input in the page: what occupies `chat.composer`.
 *
 * The page no longer mounts the composer, it mounts its SLOT, and provides
 * alongside what the component reads. Replacing the input thus needs no
 * change here.
 */
export function ChatComposerSlot({ value, variant }: { value: ChatComposerValue; variant?: 'setup' }) {
  useEffect(() => monterComposerSlot(), []);
  // The first-run conversation: nothing but the model, the voice and send. A
  // variant of THIS slot's host rather than a second occupant — the occupant
  // is the product's, and a plugin may still replace it everywhere else.
  if (variant === 'setup') return <SetupComposer value={value} />;
  return (
    <ChatComposerContext.Provider value={value}>
      <SlotSingle name={CHAT_COMPOSER_SLOT} />
    </ChatComposerContext.Provider>
  );
}

/** The chat input. Without a context (outside the chat) it paints nothing. */
function ChatComposer() {
  const c = useContext(ChatComposerContext);
  const appearance = useChatAppearance();
  /** Drop overlay. Declared before the early return: a hook cannot sit
   *  behind a conditional. */
  const [dragging, setDragging] = useState(false);
  const catalog = useBackendCatalog();
  const promptHistory = usePromptHistory(c?.agent.name || null);
  const taRef = c?.taRef;
  const attachmentBox = c?.attachmentBox ?? null;
  const boxed = usePendingAttachments(attachmentBox);
  const { reply, setReply } = useComposerReply();
  // Reply under a bubble: the next words go here, without a click in the field.
  const replyId = reply?.eventId ?? null;
  useEffect(() => {
    if (replyId !== null) taRef?.current?.focus();
  }, [replyId, taRef]);
  // The keystroke fit only runs when the text changes: a field that first
  // laid out narrow (an island before its measure) kept that height until
  // something was typed then erased.
  useEffect(() => {
    const el = taRef?.current;
    if (!el) return;
    return observeTextareaWidth(el, COMPOSER_MAX_HEIGHT);
  }, [taRef]);
  if (!c) return null;
  const {
    agent, liveStats, currentMissionId, pendingModelOverride, pendingBackendOverride,
    effBackend, effModel, modelSwitching, setLlmOpen, applyLlm, pendingReasoningEffort,
    missionReasoningEffort, applyReasoningEffort, dense, narrow, input, setInput,
    placeholder, send, fileRef, pendingImages, setPendingImages, addImageFiles,
    pendingFiles, setPendingFiles, addAnyFiles, capturePastedText, setCaret,
    slashOpen, slashSuggestions, slashSel, setSlashSel, setSlashDismissed, acceptSlash,
    recording, toggleDictation, dictationUnavailable, audioLevels, visualiseurActif, missionCwd,
    gptLive, thinking, stopping, turnResumable, stopTurn, onNewConversation, newMission,
  } = c;
  // Declared by the backend: a remote agent cannot open a file announced by
  // its path on this disk. Images still go inline (paste, drop).
  const acceptsFiles = capabilitiesFor(catalog, effBackend).attachments;
  // `send` empties the field: the prompt is taken before it goes.
  // `alternate` = Ctrl/Cmd+Enter: while the agent works, the other of steer
  // and queue than Enter does.
  const submit = (alternate = false) => {
    promptHistory.record(input);
    send(workingSendMode(appearance.enterWhileWorking, alternate));
  };
  const workingPlaceholder = thinking
    ? i18n(appearance.enterWhileWorking === 'steer' ? 'chatPage.workingHintSteer' : 'chatPage.workingHintQueue', {
      mod: detectTerminalPlatform() === 'mac' ? '⌘' : 'Ctrl',
    })
    : placeholder;
  const liveOn = gptLive !== null && gptLive.state !== 'idle';
  // The sphere over the input no longer says what the session is doing: this
  // button, which ends it, is the one place that names its state.
  const gptLiveLabel = !gptLive || gptLive.state === 'idle'
    ? i18n('gptLive.start')
    : gptLive.state === 'connecting'
      ? i18n('gptLive.connecting')
      : gptLive.state === 'closing'
        ? i18n('gptLive.closing')
        : `${i18n('gptLive.live')} · ${i18n('gptLive.stop')}`;

  return (
    <div data-composer-dock="" className={cn(
      // shrink-0: without this, a height-constrained flex-col (short
      // viewport) clipped the composer — and with it the small
      // decorative strip, pushed out of view below the fold. Only
      // scrollRef (flex-1) should give up room, never the input.
      "relative z-10 shrink-0 bg-transparent",
      // No padding-top: a transparent space above the composer let
      // you glimpse bubbles scrolling "underneath" before the white
      // pill covered them. padding-bottom alone is enough to breathe
      // before the screen edge.
      // On mobile, every millimeter taken by the gutter is one less
      // millimeter for the conversation: the composer sits almost
      // flush with the edge, breathing room returns from `md`
      // onward. The side gutter is the chat column's `--chat-pad`,
      // which follows the island's width rather than the window's.
      // The dense composer (a Multichat cell, the only one) keeps a mini
      // margin on its sides and below: flush, its pills and send button
      // touched the cell's coloured outline.
      dense ? "px-1.5 pb-1.5" : "px-[var(--chat-pad,0.375rem)] pb-1.5 md:pb-3 lg:pb-4",
    )}>
      <ComposerHeader
        agent={agent}
        cwd={missionCwd ?? agent.cwd ?? null}
        compact={dense}
        narrow={narrow}
        onNewConversation={onNewConversation}
        newMission={newMission}
      />
      <div
        onDragOver={(e) => {
          // Only a file drag arms the overlay: dragging selected text inside
          // the textarea must keep its native move-the-text behaviour.
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDragging(true);
        }}
        onDragLeave={(e) => {
          // relatedTarget inside the pill = crossing a child, not leaving.
          if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
          setDragging(false);
        }}
        onDrop={async (e) => {
          if (!Array.from(e.dataTransfer.types).includes('Files')) return;
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) await addAnyFiles(files);
        }}
        className={cn(
        "relative z-10 transition-colors",
        dense
          ? "bg-transparent"
          : cn(
              "rounded-2xl bg-card p-1.5 pl-2 md:p-2 md:pl-3",
              // On a phone the card stood flush with the screen edges, its
              // rounded corners and border cut off: a small inset frames it.
              "max-sm:mx-2 max-sm:mb-[max(8px,env(safe-area-inset-bottom))]",
              // As wide as the thread's scroller (column + its 24px gutters):
              // its scrollbar then sits INSIDE the composer's edges, not out in
              // the margin beside it.
              !narrow && "mx-auto max-w-[calc(var(--chat-col,780px)+48px)]",
              // Borderless keeps a TRANSPARENT border rather than none:
              // dropping the 1px would move the whole input by one pixel
              // the moment the option is ticked.
              appearance.showInputBorder
                ? "border border-border focus-within:border-primary/50"
                : "border border-transparent",
            ),
      )}>
    {dragging && (
      <div className="pointer-events-none absolute inset-0 z-30 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-primary/5">
        <span className="text-xs font-medium text-primary">{i18n('chatPage.dropToAttach')}</span>
      </div>
    )}
    {reply && <ReplyStrip reply={reply} onCancel={() => setReply(null)} compact={dense} />}
    <PendingImageStack
      images={pendingImages}
      onRemove={(im) => {
        URL.revokeObjectURL(im.previewUrl);
        setPendingImages((s) => s.filter((x) => x.id !== im.id));
      }}
    />
    {attachmentBox && <PendingAttachmentRow box={attachmentBox} items={boxed} />}
    {pendingFiles.length > 0 && (
      <div className="mx-1.5 mb-1.5 flex flex-wrap gap-1.5">
        {pendingFiles.map((f) => {
          const { icon: Icon, tone } = fileIconFor(f.name);
          const pasted = f.kind === 'pasted';
          return (
            <div
              key={f.id}
              className="group relative flex max-w-[220px] items-center gap-2 rounded-md border border-border bg-muted/30 py-1.5 pl-2 pr-7"
              title={pasted ? `${f.size} characters` : `${f.mediaType} · ${fmtAttachmentSize(f.size)}`}
            >
              {pasted
                ? <ClipboardType className="size-4 shrink-0 text-muted-foreground" />
                : <Icon className={cn('size-4 shrink-0', tone)} />}
              <div className="min-w-0">
                <div className="truncate text-[11.5px] leading-tight text-foreground">{f.name}</div>
                <div className="text-[10px] leading-tight text-muted-foreground">
                  {pasted
                    ? i18n('chatPage.pastedLines', { count: String(f.text?.split('\n').length ?? 0) })
                    : fmtAttachmentSize(f.size)}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPendingFiles((s) => s.filter((x) => x.id !== f.id))}
                className="absolute right-1 top-1/2 grid size-5 -translate-y-1/2 place-items-center rounded-full text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
                aria-label={i18n('chatPage.removeAttachment')}
              >
                <X className="size-3" />
              </button>
            </div>
          );
        })}
      </div>
    )}
    <div className="relative flex items-end gap-2">
      {slashOpen && (
        <SlashPopup
          items={slashSuggestions}
          selected={slashSel}
          onHover={setSlashSel}
          onPick={acceptSlash}
        />
      )}
      <textarea
        ref={taRef}
        value={input}
        onChange={(e) => {
          // Editing a recalled prompt makes it the new draft.
          promptHistory.reset();
          setInput(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          // Slash autocomplete popup open: keyboard navigation takes
          // priority (and never triggers send).
          if (slashOpen) {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSlashSel((i) => (i + 1) % slashSuggestions.length);
              return;
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSlashSel((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
              return;
            }
            if (e.key === 'Enter' || e.key === 'Tab') {
              e.preventDefault();
              acceptSlash(slashSuggestions[slashSel]!.id);
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              setSlashDismissed(true);
              return;
            }
          }
          // Escape drops the armed reply; the slash popup, open, had it first.
          if (e.key === 'Escape' && reply) {
            e.preventDefault();
            setReply(null);
            return;
          }
          // Mobile (virtual keyboard): Enter = newline, send only via
          // the Send button. Detection without user-agent sniffing:
          //   - pointer: coarse → touch screen (iPhone PWA, Android Brave…)
          //   - e.nativeEvent.isComposing / keyCode 229 → active IME
          //     (Gboard / Android predictive keyboard sends 229 on Enter)
          const ne = e.nativeEvent as KeyboardEvent;
          const isComposing = e.key === 'Process' || ne.isComposing || ne.keyCode === 229;
          const isTouch = typeof window !== 'undefined'
            && window.matchMedia?.('(pointer: coarse)').matches;
          // Prompt history (SUG-0021). Any modifier keeps its native meaning
          // (Shift selects, Alt/Cmd jump to the start or the end).
          if ((e.key === 'ArrowUp' || e.key === 'ArrowDown')
            && !isComposing && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
            const ta = e.currentTarget;
            const direction = e.key === 'ArrowUp' ? 'older' : 'newer';
            if (canRecallPrompt(direction, ta.value, ta.selectionStart, ta.selectionEnd, isTextareaWrapped(ta))) {
              const text = promptHistory.step(direction, ta.value);
              if (text !== null) {
                e.preventDefault();
                // The stored draft stays the one being written: leaving the
                // page on a recalled entry must not replace it. Editing the
                // entry makes it the draft (`onChange` stores).
                setInput(text, { store: false });
                // A recalled `/skill` must not reopen the menu: the next ↑
                // would browse the menu instead of the history.
                setSlashDismissed(true);
                // A multi-line entry recalled by ↑ keeps its caret on top, so
                // the next ↑ goes on browsing.
                const at = direction === 'older' && text.includes('\n') ? 0 : text.length;
                setCaret(at);
                requestAnimationFrame(() => {
                  const el = taRef?.current;
                  if (el) el.setSelectionRange(at, at);
                });
              }
              return;
            }
          }
          if (e.key === 'Enter' && !e.shiftKey && !isComposing && !isTouch) {
            e.preventDefault();
            submit(e.ctrlKey || e.metaKey);
          }
        }}
        onPaste={async (e) => {
          // Files first — a screenshot + caption in one chord still works,
          // and a .pptx dropped on the clipboard is a file like any other.
          const files = Array.from(e.clipboardData?.items ?? [])
            .filter((it) => it.kind === 'file')
            .map((it) => it.getAsFile())
            .filter((f): f is File => !!f);
          if (files.length > 0) {
            e.preventDefault();
            await addAnyFiles(files);
            return;
          }
          // A long paste becomes a chip instead of a thousand lines in the
          // input. preventDefault ONLY on that branch: an ordinary paste must
          // keep the browser's own behaviour, caret and undo stack included.
          const text = e.clipboardData?.getData('text/plain') ?? '';
          if (capturePastedText(text)) e.preventDefault();
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        placeholder={workingPlaceholder}
        rows={1}
        className="w-full resize-none overscroll-contain border-0 bg-transparent px-1 py-2 text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
        style={{ minHeight: 24, maxHeight: COMPOSER_MAX_HEIGHT }}
      />
    </div>
    {/* Toolbar BELOW the textarea, full width: avoids any overlap on
      * mobile since the input field no longer has to share its line
      * with the buttons. Left: how the next turn runs (model, reasoning,
      * permissions) as pills. Right: what acts on the message, gathered
      * around the send button. */}
    <div className="flex items-center justify-between gap-2 pt-1">
      <ComposerSettingsPills
        agent={agent}
        liveStats={liveStats}
        currentMissionId={currentMissionId}
        pendingModelOverride={pendingModelOverride}
        pendingBackendOverride={pendingBackendOverride}
        effBackend={effBackend}
        effModel={effModel}
        modelSwitching={modelSwitching}
        applyLlm={applyLlm}
        compact={dense}
        thinking={thinking}
        reasoningEffort={pendingReasoningEffort ?? missionReasoningEffort}
        onReasoningEffort={applyReasoningEffort}
      />
      <div className="flex shrink-0 items-center gap-0.5">
        {recording && (
          <div
            className="mr-1 flex h-8 items-center gap-2 rounded-full bg-destructive/10 px-2.5 text-xs font-medium text-destructive"
            role="status"
            aria-live="polite"
          >
            <span className="flex h-5 items-center gap-px" aria-hidden="true">
              {audioLevels.map((level, index) => (
                <span
                  key={index}
                  className={cn(
                    'h-5 w-0.5 origin-center rounded-full bg-current',
                    visualiseurActif
                      ? 'transition-transform duration-75 ease-out motion-reduce:transform-none'
                      : 'animate-egaliseur',
                  )}
                  style={
                    visualiseurActif
                      ? { transform: `scaleY(${Math.max(0.12, level)})` }
                      : // Wave-like offset, folded in the middle of the
                        // bar so both ends beat in phase.
                        { animationDelay: `${Math.abs(7.5 - index) * -70}ms` }
                  }
                />
              ))}
            </span>
            <span className="hidden sm:inline">{i18n('chatPage.listening')}</span>
          </div>
        )}
        {/* STOP — visible only during an active turn. It DOUBLES the
          * send instead of replacing it: the composer already
          * accepts stacking a turn while the agent talks (cf.
          * flushQueuedTurn), and hiding Send would remove that
          * option for nothing. */}
        {thinking && (
          <button
            type="button"
            onClick={() => void stopTurn()}
            disabled={stopping}
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-full transition-colors',
              'text-muted-foreground hover:bg-destructive/10 hover:text-destructive',
              stopping && 'opacity-50',
            )}
            title={turnResumable
              ? i18n('chatPage.interruptTurnResumable')
              : i18n('chatPage.interruptTurnFinal')}
            aria-label={i18n('chatPage.interruptTurn')}
          >
            <Square className="size-3.5 fill-current" />
          </button>
        )}
        {appearance.showContext && currentMissionId && (
          <ComposerContextGauge
            agent={agent}
            liveStats={liveStats}
            currentMissionId={currentMissionId}
            effBackend={effBackend}
            effModel={effModel}
            onOpenLlm={() => setLlmOpen(true)}
            thinking={thinking}
            compact={dense}
          />
        )}
        {/* The explanation sits on a wrapper: a disabled button gets no hover
          * in every browser, so its own title may never show. */}
        <span title={acceptsFiles ? undefined : i18n('chatPage.attachImagesOnly')}>
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={!acceptsFiles}
            className={cn(ICON_BUTTON, 'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground')}
            title={acceptsFiles ? i18n('chatPage.attachFile') : i18n('chatPage.attachImagesOnly')}
            aria-label={acceptsFiles ? i18n('chatPage.attachFile') : i18n('chatPage.attachImagesOnly')}
          >
            <Paperclip className="size-4" />
          </button>
        </span>
        <button
          type="button"
          onClick={toggleDictation}
          className={cn(
            'relative grid size-8 place-items-center rounded-full transition-colors',
            recording
              ? 'bg-destructive/15 text-destructive'
              : dictationUnavailable
                ? 'cursor-not-allowed text-muted-foreground opacity-40'
                : 'text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
          )}
          title={
            recording
              ? i18n('chatPage.stopDictation')
              : dictationUnavailable
                ? i18n('chatPage.voiceDictationDesktopUnavailable')
                : i18n('chatPage.dictateMessage')
          }
          aria-label={recording ? i18n('chatPage.stopDictation') : i18n('chatPage.dictateMessage')}
          aria-pressed={recording}
          aria-disabled={dictationUnavailable && !recording}
        >
          {recording ? <MicOff className="size-4" /> : <Mic className="size-4" />}
        </button>
        {gptLive && (
          <button
            type="button"
            onClick={gptLive.toggle}
            disabled={gptLive.state === 'closing'}
            className={cn(
              'relative grid size-8 place-items-center rounded-full transition-colors disabled:opacity-60',
              liveOn
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-foreground/[0.07] hover:text-foreground',
            )}
            title={gptLiveLabel}
            aria-label={gptLiveLabel}
            aria-pressed={liveOn}
          >
            {gptLive.state === 'connecting' || gptLive.state === 'closing'
              ? <Loader2 className="size-4 animate-spin" />
              : <AudioLines className={cn('size-4', gptLive.state === 'live' && 'motion-safe:animate-pulse')} />}
          </button>
        )}
        <Slot name="chat.composer.action" />
        <SendButton
          onClick={() => submit()}
          disabled={!input.trim() && pendingImages.length === 0 && pendingFiles.length === 0 && boxed.length === 0}
          label={i18n('chatPage.send')}
        />
      </div>
    </div>
    <input
      ref={fileRef}
      type="file"
      multiple
      className="hidden"
      onChange={async (e) => {
        const files = Array.from(e.target.files ?? []);
        e.target.value = '';
        if (files.length === 0) return;
        await addAnyFiles(files);
      }}
    />
      </div>
      {/* Usage ceilings — slid behind the composer's bottom edge
        * (negative margin, z-index under the pill): reads as a
        * double bottom rather than a full-width StatusLine. Fades
        * away on its own as long as no rate-limit is known. */}
      {!dense && appearance.showUsage && <UsageStrip liveStats={liveStats} wide={narrow} />}
    </div>
  );
}

// No "not in missions" mark on `claude-user` / `plugin` rows, unlike the
// Skills page: a `/id` at the head of a message is inlined by the daemon,
// which reads `~/.claude`, so picking one here does load it
// (`orchestrator/src/slash-claude-sources.test.ts`). Only attaching needs an import.
const SLASH_BADGE: Record<SkillSource, { label: string; cls: string }> = {
  timon: { label: BRAND.displayName, cls: 'bg-primary/15 text-primary' },
  'claude-user': { label: 'global', cls: 'bg-sky-500/15 text-sky-500' },
  project: { label: 'project', cls: 'bg-emerald-500/15 text-emerald-500' },
  plugin: { label: 'plugin', cls: 'bg-amber-500/15 text-amber-500' },
};

/** Autocomplete popup anchored above the composer, full width. Typing aid —
 *  selecting simply inserts `/id `; nothing executes. Each row spans 2
 *  lines: full name (1 line), then type badge + description. */
function SlashPopup({
  items, selected, onHover, onPick,
}: {
  items: SkillItem[];
  selected: number;
  onHover: (i: number) => void;
  onPick: (id: string) => void;
}) {
  return (
    <div className="absolute bottom-full left-0 right-0 z-50 mb-2 overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
      <div className="px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">
        {i18n('chatPage.slashPopupHelp')}
      </div>
      <ul className="max-h-[300px] overflow-auto py-1">
        {items.map((s, i) => {
          const badge = SLASH_BADGE[s.source];
          return (
            <li key={s.source + ':' + s.id}>
              <button
                type="button"
                onMouseEnter={() => onHover(i)}
                onMouseDown={(e) => { e.preventDefault(); onPick(s.id); }}
                className={cn(
                  'flex w-full flex-col gap-1 px-3 py-2 text-left',
                  i === selected ? 'bg-primary/10' : 'hover:bg-muted/50',
                )}
              >
                {/* code-font: the slash command as it is typed */}
                <span className="block truncate whitespace-nowrap font-mono text-[12.5px] font-semibold text-foreground">
                  /{s.id}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cn(
                    'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide',
                    badge.cls,
                  )}>
                    {badge.label}
                  </span>
                  {s.format === 'claude-cmd' && (
                    <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
                      cmd
                    </span>
                  )}
                  {s.format === 'claude-cmd' && s.argument_hint && (
                    // code-font: the command's argument syntax
                    <span className="shrink-0 font-mono text-[10.5px] text-muted-foreground/60">{s.argument_hint}</span>
                  )}
                  <span className="truncate text-[11.5px] text-muted-foreground/85">
                    {s.description || s.title || ''}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── "Terminal" button ───────────────────────────────────────────────────
 * Two terminals can sit behind it, both on the MACHINE hosting the
 * orchestrator, never the browser's:
 *  — the built-in terminal (`@timon/terminal-web`), first choice: it opens
 *    inside Timon, so it works from a phone too;
 *  — otherwise the native one (GET /api/terminal `enabled`, false when the
 *    host has no gui or the setting is off). Hidden under `sm`: from a phone
 *    the click would open a window nobody sees.
 * Both flags almost never change → one request per tab, module-cached like
 * the backend catalog. */
let terminalEnabledCache: boolean | null = null;
let builtInTerminalCache: boolean | null = null;

export function resetTerminalEnabledCacheForTests(): void {
  terminalEnabledCache = null;
  builtInTerminalCache = null;
}

/**
 * "Terminal" button: opens a terminal on the TIMON machine in the mission's
 * (or agent's) cwd, under the conversation's scope. It lives in the header
 * strip above the composer, beside the branch — see `ComposerHeader`.
 */
export function TerminalButton({ cwd, agent, small = false }: {
  cwd: string | null;
  agent: Pick<Agent, 'name' | 'project'>;
  /** The composer header's size, smaller than a toolbar button. */
  small?: boolean;
}) {
  const caps = useCapabilities();
  const builtIn = useBuiltInTerminal(isModuleOn(caps, '@timon/terminal-web'));
  const terminalEnabled = useTerminalEnabled();
  // Double condition, two directions: `terminalEnabled` says the machine
  // has a graphical session, the zone says the user wants the button. A
  // `ui.hidden` containing `chat.terminal` removes it even on a capable
  // machine.
  const terminalZone = isZoneVisible(caps, 'chat.terminal');
  const zoneHidden = Boolean(caps?.ui.hidden.includes('chat.terminal'));
  const [busy, setBusy] = useState(false);

  async function openTerminal() {
    if (!cwd || busy) return;
    setBusy(true);
    try {
      const r = await fetch('/api/ui/terminal/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cwd }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        toast.error(i18n('chatPage.terminalError', { error: apiErrorMessage(j, { status: r.status }) }));
        return;
      }
      // The terminal being single-instance, the launched process returns
      // control right away: we confirm the order, not the window's
      // appearance.
      toast.success(i18n('chatPage.terminalRequested'), { description: cwd });
    } catch (e) {
      toast.error(i18n('chatPage.terminalUnreachable', { error: String((e as Error).message || e) }));
    } finally {
      setBusy(false);
    }
  }

  if (!cwd) return null;

  if (builtIn && !zoneHidden) {
    return (
      <button
        type="button"
        onClick={() => openConversationTerminal(cwd, agent)}
        className={small ? HEADER_BUTTON : "grid size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"}
        title={i18n('chatPage.openTerminalOn', { brand: BRAND.displayName, cwd })}
        aria-label={i18n('chatPage.openTerminal')}
      >
        <SquareTerminal className={small ? 'size-3.5' : 'size-4'} />
      </button>
    );
  }

  if (!terminalEnabled || !terminalZone) return null;

  return (
    // `hidden sm:inline-flex`: the window opens on the TIMON machine, not
    // on the phone clicking — no point offering the gesture where its
    // result is invisible.
    <button
      type="button"
      onClick={openTerminal}
      disabled={busy}
      className={cn(
        'hidden shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 sm:grid',
        small ? 'size-6 rounded-md hover:bg-foreground/[0.08]' : 'size-9 rounded-lg hover:bg-muted',
      )}
      title={i18n('chatPage.openTerminalOn', { brand: BRAND.displayName, cwd })}
      aria-label={i18n('chatPage.openTerminal')}
    >
      <SquareTerminal className={small ? 'size-3.5' : 'size-4'} />
    </button>
  );
}

/** Can this user open the built-in terminal? Asked only when its module runs. */
function useBuiltInTerminal(moduleOn: boolean): boolean {
  const [enabled, setEnabled] = useState(builtInTerminalCache ?? false);
  const later = useAfterConversation();
  useEffect(() => {
    if (!moduleOn || builtInTerminalCache !== null || !later) return;
    let alive = true;
    void fetchTerminalStatus()
      .then((status) => {
        builtInTerminalCache = status.enabled;
        if (alive) setEnabled(status.enabled);
      })
      .catch(() => { /* silent orchestrator: fall back to the native button */ });
    return () => { alive = false; };
  }, [moduleOn, later]);
  return moduleOn && enabled;
}

function useTerminalEnabled(): boolean {
  const [enabled, setEnabled] = useState(terminalEnabledCache ?? false);
  // A button that appears a beat later costs nothing; its read taking a
  // connection from the conversation does (`lib/load-priority.ts`).
  const later = useAfterConversation();
  useEffect(() => {
    if (terminalEnabledCache !== null || !later) return;
    let alive = true;
    void fetch('/api/ui/terminal', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        terminalEnabledCache = Boolean(j?.enabled);
        if (alive) setEnabled(terminalEnabledCache);
      })
      .catch(() => {
        /* silent orchestrator: no button, no error shown */
      });
    return () => { alive = false; };
  }, [later]);
  return enabled;
}

/** An icon button of the composer's toolbar, round like the send beside it. */
const ICON_BUTTON = 'grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground';

/** An icon button of the header above the card: smaller, it sits in a strip. */
const HEADER_BUTTON = 'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.08] hover:text-foreground';

/**
 * A setting pill at the foot of the composer. The tint is the foreground at a
 * low alpha rather than a palette colour: lighter than the card on a dark
 * theme, darker on a light one, with no rule per theme.
 */
export function composerPillClass(compact: boolean): string {
  return cn(
    'flex min-w-0 items-center gap-1.5 rounded-full bg-foreground/[0.06] text-foreground transition-colors hover:bg-foreground/[0.1] disabled:opacity-50 data-[state=open]:bg-foreground/[0.12]',
    compact ? 'h-6 px-2 text-[10.5px]' : 'h-7 px-2.5 text-[11.5px]',
  );
}

/** The round send button, its arrow pointing up. */
export function SendButton({ onClick, disabled, label }: { onClick: () => void; disabled: boolean; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="ml-1 grid size-8 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground shadow-[0_6px_18px_-8px_hsl(var(--primary)/0.7)] transition-[background-color,opacity] hover:bg-primary/90 disabled:pointer-events-none disabled:bg-foreground/[0.12] disabled:text-muted-foreground disabled:shadow-none"
    >
      <ArrowUp className="size-4" strokeWidth={2.5} />
    </button>
  );
}

/**
 * The composer's branch bar is part of the Git card: a role without the card is
 * refused the read (TODO #689), so it shows no bar rather than a broken one.
 */
export function composerGitAllowed(caps: Capabilities | null): boolean {
  return isModuleOn(caps, '@timon/git') && isWidgetSurfaceAllowed(caps, '@timon/git', 'repository');
}

/**
 * The strip tucked behind the top of the composer: where the conversation
 * runs, and the gestures about that place rather than about the message.
 * — Left: the project, behind a folder icon, when the agent belongs to one.
 * — Right: the cwd's Git branch, then the terminal and the new conversation —
 *   moved out of the toolbar so that the toolbar keeps the message's own
 *   actions beside the send.
 * Like the usage strip below, it slides under the card (negative margin, lower
 * z-index): it reads as a tab of the input, not as a bar of its own.
 */
function ComposerHeader({
  agent,
  cwd,
  compact,
  narrow,
  onNewConversation,
  newMission,
}: {
  agent: Agent;
  cwd: string | null;
  compact: boolean;
  narrow: boolean;
  onNewConversation: () => void;
  newMission?: NewMissionOptions | null;
}) {
  const appearance = useChatAppearance();
  const projects = useProjectMeta();
  // The cwd's branch comes from the shared Git store: a checkout in the Git
  // panel, a push or the end of a turn refreshes it with the panels. Nothing
  // is asked while `@timon/git` is off (step 5.9.5: the route belongs to that
  // module) or before the conversation has loaded (`lib/load-priority.ts`).
  const gitOn = composerGitAllowed(useCapabilities());
  const later = useAfterConversation();
  // Same derivation as the chat's Git widget: the picker reads its keys.
  const gitSlug = projectSlugOf(agent.project, agent.name);
  // Read with the project: the picker must know whether the agent's folder
  // is that project's repository before it offers to switch its branches.
  const g = useGit('agent', gitOn && later ? agentGitId(agent.name, gitSlug) : null).data;
  // Only a project the agent declares: the name prefix guess is good enough
  // for a Git key, not for a title shown to the user.
  const project = agent.project ?? null;
  const projectName = project ? projects.get(project)?.name || project : null;

  return (
    <div className={cn(!compact && !narrow && 'mx-auto max-w-[calc(var(--chat-col,780px)+48px)]')}>
      <div className={cn(
        'group/composer-bar relative z-0 flex items-center justify-between gap-2 tabular-nums text-muted-foreground',
        compact
          ? 'px-1 pb-1 pt-0.5 text-[9.5px]'
          : cn(
              'mx-3 -mb-3 rounded-t-xl bg-foreground/[0.05] px-3 pb-[1.125rem] pt-1.5 text-[11.5px]',
              // Outlined with the card, a shade softer than its edge. Its foot
              // hides under the card, so the two outlines never double.
              appearance.showInputBorder ? 'border border-border/60' : 'border border-transparent',
            ),
      )}>
        <div className="flex min-w-0 items-center gap-1.5">
          {projectName && (
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={i18n('chatPage.composerProject', { name: projectName })}
            >
              <Folder className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate text-foreground">{projectName}</span>
            </span>
          )}
        </div>
        <div className="flex min-w-0 shrink items-center gap-1">
          {/* Shown under the pointer, and always while the layout is being
            * edited. The same switches stay in the topbar's Customize
            * interface menu. */}
          <ChatAppearanceButton compact={compact} />
          {appearance.showBranch && g && (
            <GitBranchPicker slug={gitSlug} info={g} cwd={agent.cwd} compact={compact} />
          )}
          <TerminalButton cwd={cwd} agent={agent} small />
          <NewMissionMenu current={agent.name} options={newMission} onNew={onNewConversation}>
            <button
              type="button"
              className={HEADER_BUTTON}
              title={i18n('agentChat.newConversation')}
              aria-label={i18n('agentChat.newConversation')}
            >
              <SquarePen className="size-3.5" />
            </button>
          </NewMissionMenu>
        </div>
      </div>
    </div>
  );
}

/**
 * How the next turn runs, as pills at the foot of the composer: the model,
 * its reasoning level, the mission's permission mode.
 * — The model pill opens the model picker. Before the 1st send it sets the
 *   override for the mission about to be born; during the mission it switches
 *   the thread.
 * — The reasoning pill opens a list of the model's levels on its own: the
 *   picker's slider stays for whoever changes both at once.
 */
function ComposerSettingsPills({
  agent,
  liveStats,
  currentMissionId,
  pendingModelOverride,
  pendingBackendOverride,
  effBackend,
  effModel,
  modelSwitching,
  applyLlm,
  compact = false,
  thinking = false,
  reasoningEffort,
  onReasoningEffort,
}: {
  agent: Agent;
  liveStats: LiveStats;
  currentMissionId: string | null;
  pendingModelOverride: string | null;
  pendingBackendOverride: string | null;
  /** Backend + model of the NEXT turn, derived once upstream. */
  effBackend: BackendName;
  effModel: string;
  /** An LLM switch is in flight: the pill freezes for the round trip. */
  modelSwitching: boolean;
  /** Applies the pair chosen in the drop-up, with the context mode the user
   *  picked on the confirmation panel. */
  applyLlm: (backend: BackendName, model: string, contextMode: SwitchContextChoice) => Promise<void>;
  compact?: boolean;
  /** A turn is running: the menu says the model is queued. */
  thinking?: boolean;
  /** EFFECTIVE level for the next turn (pending override included), or
   *  null for "model default". */
  reasoningEffort?: string | null;
  /** Applies a level to the next turn. */
  onReasoningEffort: (effort: string | null) => Promise<void>;
}) {
  // Runtime catalog (empty on first paint): presets, per-backend models
  // and context windows are derived from it, nothing is hard-coded here.
  const catalog = useBackendCatalog();
  const appearance = useChatAppearance();
  const [effortBusy, setEffortBusy] = useState(false);
  const modelShort = effModel.replace(/^claude-/, '').replace(/-\d{8}$/, '');

  // The current pair may not be cataloged (versioned slug, custom
  // provider with no list): we then display `backend · model` rather than
  // just the model name, which would be ambiguous.
  const catalogued = catalog.backends.some(
    (b) => b.id === effBackend && b.models.some((m) => m.slug === effModel),
  );
  // A subscription account shares its models with its backend: without its
  // name, `opus` on the Perso account and on the Pro one read the same. An
  // account the catalogue no longer lists reads as unavailable, not as its id.
  const effEntry = catalog.backends.find((b) => b.id === effBackend);
  const llmLabel = !catalogued && effBackend
    ? `${isAccountInstance(effBackend) ? backendLabel(catalog, effBackend) : effBackend} · ${modelShort}`
    : effEntry?.account
      ? `${modelShort} · ${effEntry.account.name}`
      : modelShort;
  const hasOverride =
    !!pendingBackendOverride
    || (!!pendingModelOverride && pendingModelOverride !== agent.model);
  // A model outside the catalog (versioned slug, provider with no list)
  // announces no level: the pill disappears rather than offering values
  // the CLI would refuse.
  const thinkingBar = thinkingBarFor(catalog, effBackend, effModel);
  const showEffort = appearance.showEffort && thinkingBar !== null;
  const pill = composerPillClass(compact);

  async function setEffort(level: string | null): Promise<void> {
    if (effortBusy || level === (reasoningEffort ?? null)) return;
    setEffortBusy(true);
    try {
      await onReasoningEffort(level);
    } catch (e) {
      toast.error(String((e as Error).message || e));
    } finally {
      setEffortBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      {appearance.showModel && (
        <LlmMenu
          backend={effBackend}
          model={effModel}
          reasoningEffort={reasoningEffort ?? null}
          onReasoningEffort={setEffort}
          onPick={applyLlm}
          missionId={currentMissionId}
          busy={modelSwitching}
          thinking={thinking}
          target={{ project: agent.project, agent: agent.name }}
        >
          <button
            type="button"
            disabled={modelSwitching}
            className={cn(pill, 'shrink')}
            title={[
              currentMissionId
                ? i18n('chatPage.changeLlm')
                : i18n('chatPage.backendModelOfConv'),
              // The selected alias (`opus`) doesn't say which version is
              // actually running: the CLI's `system:init` does.
              liveStats.model && liveStats.model !== effModel
                ? i18n('chatPage.currentlyRunning', { model: liveStats.model })
                : null,
              !currentMissionId && hasOverride ? i18n('chatPage.perMissionOverride') : null,
            ].filter(Boolean).join('\n')}
          >
            {/* The model's logo says which vendor is answering. */}
            <BrandMark slug={effModel} className={cn('shrink-0', compact ? 'size-3' : 'size-3.5')} />
            <span className="block min-w-0 truncate">{llmLabel}</span>
            <AccountStateBadge backend={effEntry} />
            {!currentMissionId && hasOverride && (
              <span className="size-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
            )}
          </button>
        </LlmMenu>
      )}
      {showEffort && (
        <ThinkingLevelMenu
          bar={thinkingBar}
          value={reasoningEffort ?? null}
          busy={effortBusy}
          onPick={(level) => void setEffort(level)}
          className={cn(pill, 'shrink-0')}
          compact={compact}
        />
      )}
      {/* A mission only — before the first send there is no row to carry
        * the mode yet. */}
      {appearance.showPermission && currentMissionId && (
        <PermissionModeMenu missionId={currentMissionId} compact={compact} className={cn(pill, 'shrink-0')} />
      )}
    </div>
  );
}

/**
 * The context-window ring, beside the send. It opens its panel UPWARD: the
 * window in detail, the LLM, the mission's tokens, and compaction in one click.
 */
function ComposerContextGauge({
  agent,
  liveStats,
  currentMissionId,
  effBackend,
  effModel,
  onOpenLlm,
  thinking,
  compact,
}: {
  agent: Agent;
  liveStats: LiveStats;
  currentMissionId: string;
  effBackend: BackendName;
  effModel: string;
  /** Opens the LLM modal, where compaction into a new thread lives. */
  onOpenLlm: () => void;
  thinking: boolean;
  compact: boolean;
}) {
  const catalog = useBackendCatalog();
  const router = useRouter();
  const compaction = useMissionCompaction(currentMissionId);
  const compacting = compaction.starting || isRunning(compaction.operation);
  const modelShort = effModel.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const ctxUsed = liveStats.lastContextTokens;
  // Follows the SELECTED model (that of the next turn), not just the one
  // observed in the last system:init — otherwise the gauge stays stuck on
  // the old window until the next turn.
  const configured = contextLimitFor(
    catalog, effBackend, effModel, liveStats.model, liveStats.contextWindows,
  );
  // `null` = unknown window (silent backend + model outside the
  // catalog). We then display the tokens consumed WITHOUT a denominator
  // or percentage: an honestly degraded gauge beats a made-up "/ 200k".
  const ctxLimit = configured
    ? (ctxUsed > configured ? nextStandardLimit(ctxUsed) : configured)
    : null;
  const ctxPct = ctxLimit ? Math.min(100, Math.round((ctxUsed / ctxLimit) * 100)) : 0;
  const ctxTitle = ctxLimit
    ? i18n('chatPage.contextWindowUsed', { used: fmtTokens(ctxUsed), limit: fmtTokens(ctxLimit), pct: ctxPct })
    : i18n('chatPage.contextWindowUsedUnknown', { used: fmtTokens(ctxUsed) });

  return (
    <ContextGaugeMenu
      info={{
        used: ctxUsed,
        limit: ctxLimit,
        model: liveStats.model && liveStats.model !== effModel ? `${modelShort} (${liveStats.model})` : modelShort,
        backend: backendLabel(catalog, effBackend),
        totalIn: liveStats.totalIn,
        totalOut: liveStats.totalOut,
      }}
      compaction={compaction}
      nativeCompact={nativeCompactFor(catalog, effBackend)}
      thinking={thinking}
      onCompact={() => {
        void compactStore.start(currentMissionId).then((r) => {
          if (!r.ok) toast.error(r.failure);
        });
      }}
      onCompactElsewhere={onOpenLlm}
      onOpenTarget={(missionId) => openChat(chatHref(agent.name, missionId), router)}
      trigger={
        <button
          type="button"
          title={compacting ? i18n('compact.running') : ctxTitle}
          aria-label={ctxTitle}
          className="grid size-8 shrink-0 place-items-center rounded-full transition-colors hover:bg-foreground/[0.07]"
        >
          {/* The ring replaces the `used / limit (pct%)` text (TODO #431):
            * the maximum sits in its centre, the exact usage in the panel.
            * It turns while a compaction runs. */}
          <ContextRing used={ctxUsed} limit={ctxLimit} label={ctxTitle} size={compact ? 20 : 22} busy={compacting} />
        </button>
      }
    />
  );
}

/** `now` / `43m` / `4h 12m` / `2d 3h` — time before reset, stable width. */
function fmtUntil(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return 'now';
  const h = Math.floor(d / 3_600_000);
  const m = Math.floor((d % 3_600_000) / 60_000);
  if (h >= 24) return Math.floor(h / 24) + 'd' + (h % 24 ? ' ' + (h % 24) + 'h' : '');
  if (h > 0) return h + 'h' + (m ? ' ' + m + 'm' : '');
  return m + 'm';
}

/** Map anthropic's raw status enum to a friendly label.
 *  `allowed`           → "ok"        (green)
 *  `allowed_warning`   → "near limit" (warning — close to limit)
 *  `warned` (codex?)   → "near limit"
 *  `blocked` / fallback → "blocked"   (destructive). */
function friendlyStatus(raw: string): { label: string; cls: string } {
  if (raw === 'allowed') return { label: 'ok', cls: 'text-[hsl(var(--success))]' };
  if (raw === 'allowed_warning' || raw === 'warned') {
    return { label: 'near limit', cls: 'text-[hsl(var(--warning))]' };
  }
  if (raw === 'blocked') return { label: 'blocked', cls: 'text-destructive' };
  return { label: raw, cls: 'text-destructive' };
}

type CapKey = 'five_hour' | 'seven_day' | 'monthly';

const CAP_LABELS: Record<CapKey, { label: string; title: string }> = {
  five_hour: { label: '5h cap', title: 'rolling 5-hour subscription limit' },
  seven_day: { label: '7d cap', title: 'rolling 7-day subscription limit' },
  monthly: { label: 'month cap', title: 'monthly premium request allowance' },
};

/**
 * Usage ceilings (rolling 5h, rolling 7d, monthly) + overage quota, in the mini
 * strip stuck below the composer. Deliberately WITHOUT the mission's
 * in/out tokens (already visible in ComposerTopBar) — here it's the
 * global subscription limit, not the cost of the current conversation.
 */
const UsageStrip = memo(function UsageStrip({
  liveStats,
  wide = false,
}: {
  liveStats: LiveStats;
  /** Follows the composer: full width when the column is shrunk. */
  wide?: boolean;
}) {
  const accountUsage = liveStats.accountUsage;
  const catalog = useBackendCatalog();
  if (accountUsage?.kind === 'disconnected' || accountUsage?.kind === 'error') {
    return (
      <div className={cn(
        'relative z-0 -mt-2 shrink-0 overflow-x-auto rounded-b-xl bg-card px-3 pb-1 pt-2.5 text-[10px] tabular-nums shadow-md scrollbar-none',
        !wide && 'mx-auto max-w-[calc(var(--chat-col,780px)+48px)]',
      )}>
        <AccountUsageStatus
          view={accountUsage}
          provider={accountUsage.kind === 'disconnected' ? catalog.backends.find((b) => b.id === accountUsage.backend) : undefined}
        />
      </div>
    );
  }
  const caps = (['five_hour', 'seven_day', 'monthly'] as const)
    .map((k) => ({ k, rl: liveStats.rateLimits[k] }))
    .filter((x): x is { k: CapKey; rl: RateLimitInfo } => !!x.rl);
  const eu = liveStats.extraUsage?.isEnabled ? liveStats.extraUsage : null;
  if (caps.length === 0 && !eu) return null;

  const fmtMoney = (cents: number) => {
    const v = cents / 100;
    return v % 1 === 0 ? v.toFixed(0) : v.toFixed(2);
  };

  return (
    <div className={cn(
      'relative z-0 -mt-2 flex shrink-0 items-center justify-center gap-x-4 gap-y-1 overflow-x-auto whitespace-nowrap rounded-b-xl bg-card px-3 pb-1 pt-2.5 text-[10px] tabular-nums text-muted-foreground shadow-md scrollbar-none',
      !wide && 'mx-auto max-w-[calc(var(--chat-col,780px)+48px)]',
    )}>
      {caps.map(({ k, rl }) => {
        const { label, title } = CAP_LABELS[k];
        const pct = typeof rl.utilization === 'number' ? Math.round(rl.utilization) : null;
        const pctCls = pct === null ? '' :
          pct >= 90 ? 'text-destructive' :
          pct >= 70 ? 'text-[hsl(var(--warning))]' :
          'text-foreground';
        const fs = friendlyStatus(rl.status);
        return (
          <span key={k} title={title} className="shrink-0">
            {label}:{' '}
            {pct !== null ? <span className={pctCls}>{pct}%</span> : <span className={fs.cls}>{fs.label}</span>}
            {rl.resetsAt > 0 && (
              <span className="text-muted-foreground/70"> · reset {fmtUntil(rl.resetsAt * 1000)}</span>
            )}
          </span>
        );
      })}
      {eu && (() => {
        const pct = Math.round(eu.utilization);
        const pctCls = pct >= 90 ? 'text-destructive' : pct >= 70 ? 'text-[hsl(var(--warning))]' : 'text-foreground';
        return (
          <span title={`overage credits used this month: ${fmtMoney(eu.usedCredits)} of ${fmtMoney(eu.monthlyLimit)} ${eu.currency}`} className="shrink-0">
            overage: <span className={pctCls}>{pct}%</span>
            <span className="ml-1 text-muted-foreground/70">
              ({fmtMoney(eu.usedCredits)} / {fmtMoney(eu.monthlyLimit)} {eu.currency})
            </span>
          </span>
        );
      })()}
    </div>
  );
});
