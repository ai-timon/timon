'use client';

import dynamic from 'next/dynamic';
import { ChatIslandHost, ChatIslandUnderlay } from '@/components/chat/chat-island-host';
import { useChatChrome, WithoutChatChrome } from './chat-chrome';
import { IslandRoutePrimary, useIslandRouteFocused } from '@/components/islands/island-workspace';
import { chatPin, fetchAgentDetails, missionOwnerAgent, requestedChatMission } from '@/lib/chat-entry';
import { missionDetailUrl, takePreloadedChatMission } from '@/lib/chat-mission-preload';
import {
  chatCacheEpoch, forgetChatMission, getCachedChatMission, historyDeltaUrl, newestEventId, parseHistoryDelta, putCachedChatMission,
} from '@/lib/chat-mission-cache';
import { openChat } from '@/lib/chat-navigation';
import { sharedGet } from '@/lib/shared-read';
import { markConversationShown, useAfterConversation } from '@/lib/load-priority';
import { useGlassBubble } from '@/components/chat/glass-bubbles';
import { renderToolJson, tryRenderToolJson } from '@/lib/tool-json';
import Link from 'next/link';
import { Fragment, createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { EGRESS_DEEP_LINK_PARAM } from '@/lib/egress';
import { useEgressDeepLink } from '@/lib/egress-deep-link';
import {
  BookOpen,
  ChevronDown,
  ChevronRight,
  Code2,
  Container,
  Cpu,
  FilePlus,
  FileText,
  FolderSearch,
  GitBranch,
  Globe,
  ListChecks,
  Check,
  Copy,
  Menu,
  MessageSquare,
  Mic,
  Package,
  PanelLeftOpen,
  PanelRightOpen,
  Pencil,
  Plug,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  Tag,
  Trash2,
  Volume2,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { invalidateGit } from '@/lib/git-store';
import { LlmSwitchProgressBar, type LlmSwitchProgress } from '@/components/chat/llm-switch-progress';
import type { SwitchContextChoice } from '@/components/chat/llm-menu';
import type { SeriesPlanFormPayload } from '@/components/series-plan-form';
import { Button } from '@/components/ui/button';
import { AskUserForm } from '@/components/chat/ask-user-form';
import { PermissionCountdown } from '@/components/chat/permission-countdown';
import { clearAskDraft, loadAskDraft, saveAskDraft, sessionDraftStorage } from '@/lib/ask-user-draft';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { accentVars } from '@/lib/accent-color';
import { useWidgetHost } from '@/components/widget-host/widget-host';
import { BROWSER_ANNOTATIONS_POSTED, BROWSER_PANEL_CONTEXT, BROWSER_PANEL_CONTEXT_QUERY, useBrowserPanelOpen, type BrowserAnnotationsPosted } from '@/lib/browser-panel-bus';
import { resultErrorText, isRateLimitMessage } from '@/lib/result-error';
import { streamIsClosed, watchdogAction } from '@/lib/stream-watchdog';
import { agentRoleKey, resolveRole } from '@/lib/roles';
import {
  useBackendCatalog,
  defaultModelFor,
  asBackend,
  capabilitiesFor,
  hasAccountUsage,
  isSessionResumable,
  backendLabel,
} from '@/lib/backends';
import { interpretUsageResponse, usageShouldKeepPolling } from '@/lib/account-usage';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { copyButtonHtml, currentHighlighterVersion, highlightCode } from '@/lib/markdown';
import { agentTextHtml, createObjectHtmlCache, useAgentTextHtml, useHighlighterVersion } from '@/components/chat/bubble-html';
import { hljsLanguageFor } from '@/lib/file-icons';
import { humanizeTool } from '@/lib/humanize-tool';
import { toolDisplayTitle, toolLabel } from '@/lib/tool-label';
import { approvalScopesOf, type ApprovalScope } from '@/lib/approval-scopes';
import {
  applyResolution,
  COMMAND_REQUEST_EVENT,
  COMMAND_REQUEST_RESOLVED_EVENT,
  parseCommandRequest,
  parseCommandResolution,
  pasteIntoTerminal,
  shellCardOf,
  type CommandDecision,
  type CommandRequestView,
} from '@/lib/command-requests';
import { scopeOfView, type TerminalScope } from '@/lib/terminal-web';
import { CommandRequestCard } from '@/components/chat/command-request-card';
import { ChatSecretRequestSlot } from '@/components/chat/secret-request-card';
import {
  applySecretRequestResolution,
  parseSecretRequest,
  parseSecretRequestResolution,
  SECRET_REQUEST_EVENT,
  SECRET_REQUEST_RESOLVED_EVENT,
  type SecretRequestView,
} from '@/lib/secret-requests';
import {
  applyProposalResolution,
  LAYOUT_PROPOSAL_EVENT,
  LAYOUT_PROPOSAL_RESOLVED_EVENT,
  parseLayoutProposal,
  parseProposalResolution,
  type LayoutProposalView,
} from '@/lib/layout-proposals';
import { promptTypedText, readAnnotationAttachment, readReplyAttachment, renderPromptSegments, renderPromptText, type ReplyAttachment } from '@/lib/prompt-presentation';
import { annotationCardView, applyAnnotationStatus, readAnnotationStatus, userEventImages, type AnnotationCardView } from '@/lib/annotation-card';
import { AnnotationCard } from '@/components/chat/annotation-card';
import { compressForChat } from '@/lib/chat-image';
import { MAX_IMAGE_UPLOAD_BYTES } from '@/lib/image-upload';
import { applySlash, slashSpanAt } from '@/lib/slash-caret';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_TURN_BYTES,
  PASTE_AS_FILE_CHARS,
  admitWithinTurnBudget,
  fmtAttachmentSize,
  turnAttachmentBytes,
  type PendingFile,
} from '@/lib/attachments';
import { ToolCall, ToolCallStack, ThinkingDots, fmtElapsedShort, type RunningTool } from '@/components/chat/tool-call';
import { ThinkingBlock } from '@/components/chat/thinking-block';
import { mergeThinking, readThinking } from '@/lib/thinking';
import { useChatAppearance } from '@/components/chat/chat-appearance-menu';
import type { WorkingEnterMode } from '@/components/chat/chat-appearance';
import { endsStreamingBubble, routeStreamDelta } from '@/lib/stream-delta';
import { spawnFailureNotice, type SpawnFailedPayload } from '@/lib/spawn-failure-notice';
import { turnInterruptedNotice, type TurnInterruptedPayload } from '@/lib/turn-interrupted-notice';
import { chatTroubleSignal, type SetupChatSignal } from '@/app/setup/agent/setup-trouble';
import {
  lineOnAbandoned, lineOnOutput, lineOnProviderRetry, lineOnReplayStarted, lineOnResult, retryLineOpen, type RetryLine,
} from '@/lib/provider-retry-line';
import { ProviderRetryNotice } from '@/components/chat/provider-retry-notice';
import { backendFailureNotice, type BackendFailedPayload } from '@/lib/backend-failure-notice';
import { backendSwitchFailureNotice, type BackendSwitchFailedPayload } from '@/lib/backend-switch-failure-notice';
import { sessionlessTurnNotice, type SessionlessTurnPayload } from '@/lib/sessionless-turn-notice';
import { createStreamPresentation } from '@/lib/stream-presentation';
import { StreamingMarkdown } from '@/components/chat/streaming-markdown';
import { parseGeneratedMedia, parseMediaBlock, type ChatMediaBlock } from '@/lib/chat-media';
import { chipInput } from '@/lib/chat-post';
import { ChatMediaSlot } from '@/components/chat/media-block';
import { BlockResizeContext, type BlockResizeHandler } from '@/components/chat/block-resize';
import { ChatDocumentHostProvider, ChatUiDocumentSlot, type ChatDocumentHost } from '@/components/chat/ui-document-block';
import {
  applyUiDocumentResolution,
  parseUiDocument,
  parseUiDocumentResolved,
  UI_DOCUMENT_EVENT,
  UI_DOCUMENT_RESOLVED_EVENT,
  type UiDocumentBlock,
} from '@/lib/ui-documents';
import { scrollOnBlockResize } from '@/lib/chat-scroll-anchor';
import { TopBar } from '@/components/topbar';
import { estConflitMicro, interdireVisualiseur, visualiseurInterdit } from '@/lib/stt-mic-exclusif';
import {
  abonnerPushToTalk,
  chargerPushToTalk,
  estDeclencheurPushToTalk,
  PUSH_TO_TALK_DEFAUT,
} from '@/lib/push-to-talk';
import {
  DICTEE_GRACE_MS,
  DICTEE_RESTART_DELAY_MS,
  composerDictee,
  doitRelancerDictee,
  erreurDicteeFatale,
  texteSession,
} from '@/lib/stt-dictee';
import { choiceFailure, createRecognition, dictationLang, useDictationRoute } from '@/lib/dictation/recognition';
import { presentEngineConsent } from '@/components/dictation/engine-consent-card';
import { openSettingsFromAnywhere } from '@/lib/settings-navigation';
import type { RecognitionLike } from '@/lib/dictation/engine-recognition';
import { isLocalDictationError, localDictationErrorMessage } from '@/lib/dictation/errors';
import {
  beginDictationDraft,
  cancelDictationDraft,
  writeDictationDraft,
  type DictationDraft,
} from '@/lib/dictation/draft-contract';
import { t as i18n } from '@/lib/i18n';
import { regionalTag } from '@/lib/intl';
import { BRAND } from '@/lib/brand';
import { formatMsgTime } from '@/lib/message-time';
import { draftKey, useComposerDraft } from '@/lib/composer-draft';
import {
  attachmentPreviewUrl,
  attachmentsForTurn,
  listPendingAttachments,
  removePendingAttachments,
} from '@/lib/pending-attachments';
import { anchorRevealing, anchorToPin, olderAnchor, THREAD_WINDOW_STEP, threadWindowStart } from '@/lib/thread-window';
import {
  belowHistoryFloor, contextWindowsWithShortKeys, cursorAfterPage, historyPageUrl, mergeOlderMessages, NO_HISTORY,
  OLDER_PAGES_MAX, parseHistoryEvents, parseHistoryPrelude, type HistoryCursor, type HistoryEvent,
} from '@/lib/chat-history-page';
import { spokenAnswer, turnText, type VoiceSpeaker, type VoiceTurn } from '@/lib/gpt-live/bridge';
import { answerSince, relayStep, type UndelegatedWatch } from '@/lib/gpt-live/relay';
import { useGptLiveStatus } from '@/lib/gpt-live/status';
import { useGptLive, type LiveHistoryMessage } from '@/lib/gpt-live/use-gpt-live';
import { GptLiveStage } from '@/components/chat/gpt-live-stage';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { HumanFace, humanSpeaker, parseMissionOwner } from '@/components/chat/human-speaker';
import type { MissionOwner } from '@/components/chat/chat-types';
import { useMe } from '@/hooks/use-me';
import { actingUser } from '@/lib/auth';
import { AgentAvatar, agentIdentity, useAgentIdentities, type AgentIdentity } from '@/components/agent-avatar';
import { LiveAgentMascot } from '@/components/mascot/live-agent-mascot';
import { useAgentLiveState } from '@/components/mascot/agent-live-state';
import { activityState } from '@/components/mascot/agent-activity';
import type { MascotState } from '@/components/mascot/mascot-states';
import { bubbleState, isPendingCard, liveBubbleOf, STREAM_BUBBLE_ID } from './bubble-face';
import type { AgentLook } from '@/components/mascot/agent-look';
import type { NewMissionOptions } from '@/components/chat/new-mission-menu';
import { newMissionAgents, newMissionHref } from '@/lib/new-mission-agents';
import {
  LlmHandoverCard,
  recoveryLabel,
  switchEffectLabel,
  type HandoverContextMode,
  type LlmHandover,
  type ModelSwitchStatus,
} from '@/components/llm-handover-card';
import { ExternalFileDialog } from '@/components/chat/external-file-dialog';
import { resolveFileLink } from '@/lib/file-links';
import { openAgentFile } from '@/lib/open-agent-file';
import {
  ChatMissionsList,
  useChatMissionsAllowed,
  ChatRailProvider,
  ChatRailWidgets,
  ChatWidgetRail,
  MISSIONS_WIDGET_ID,
  PanneauTiroir,
  useChatColumns,
  useChatRailsLayout,
  PoigneesFil,
  type ChatRailValue,
} from '@/components/chat/chat-rails';
import { estMasquee } from '@/components/chat/chat-columns';
import {
  contextLimitFor,
  fmtRelativeShort,
  fmtSize,
  nextStandardLimit,
  paletteFor,
  shortModelSlug,
  stripTaskIdPreamble,
} from '@/components/chat/chat-format';
import { ChatComposerSlot } from '@/components/chat/composer';
import { ComposerReplyProvider, MessageActionBar, mountMessageActionSlot, type ComposerReply } from '@/components/chat/message-actions';
import { ReplyQuote } from '@/components/chat/reply-quote';
import type { SetupAvatarRequest } from '@/components/chat/setup-avatar-card';
import type { AgentActivity } from '@/components/mascot/agent-activity';
import { DelegationsBar } from '@/components/chat/delegations-bar';
import { ComposerTrays, composerTrayClass } from '@/components/chat/composer-trays';
import { useDelegations } from '@/hooks/use-delegations';
import { COMPOSER_MAX_HEIGHT, fitTextarea } from '@/lib/textarea-autosize';
import { copyToClipboard } from '@/lib/clipboard';
import { sseOn, streamClientQuery } from '@/lib/sse-stream';
import { RAIL_FALLBACK_POLL_MS, RAIL_FRAMES, RAIL_REFRESH_DEBOUNCE_MS, railFrameMatters } from '@/lib/mission-rail-refresh';
import { fetchLatestMission } from '@/lib/latest-mission';
import { applyMissionTitleChange, parseMissionTitleChange } from '@/lib/mission-title';
import { nextHeaderScrollState } from '@/lib/header-scroll';
import { projectSlugOf } from '@/lib/project-slug';
import {
  buildAskAnswers,
  type AskUserQuestion,
} from '@/lib/ask-user-answers';
import type {
  Agent,
  AgentTodo,
  AgentTodoStatus,
  LiveStats,
  McpItem,
  MissionSummary,
  PendingImage,
  RateLimitInfo,
  SkillItem,
  SkillSource,
} from '@/components/chat/chat-types';
import { machineScopedStorage } from '@/lib/machines/machine-storage';
import { startChatBind } from '@/lib/chat-bind-timing';
import { compactStore, useCompactSettled, type CompactSettled } from '@/lib/mission-compact';
import {
  boundaryTracePatch,
  foldTrace,
  isCliSynthetic,
  isOpenTrace,
  readCompactBoundary,
  readCompactOutcome,
  readCompactionUser,
  userTracePatch,
  type CompactionTraceView,
} from '@/lib/compaction-trace';
import { CompactionTrace } from '@/components/chat/compaction-trace';
import { chatHref } from '@/lib/chat-island-params';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';
import { apiErrorMessage } from '@/lib/api-error';

// Cards a few messages only carry, and the model dialog: fetched when one is
// drawn, not with every chat (docs/BUNDLE-SIZE.md).
const LlmDialog = dynamic(() => import('@/components/llm-dialog').then((m) => m.LlmDialog), { ssr: false });
const LayoutProposalCard = dynamic(() => import('@/components/chat/layout-proposal-card').then((m) => m.LayoutProposalCard), { ssr: false });
const SeriesPlanForm = dynamic(() => import('@/components/series-plan-form').then((m) => m.SeriesPlanForm), { ssr: false });
const SetupAvatarCard = dynamic(() => import('@/components/chat/setup-avatar-card').then((m) => m.SetupAvatarCard), { ssr: false });




/**
 * Pill of a collapsed column. Position aside, it takes its column's anchor;
 * the class is the same on both sides.
 */
/** The shell already reserves the room of the pinned browser. */
const ANCRE_DROITE = 'right-4';

const PASTILLE_COLONNE =
  'chat-column-toggle pointer-events-auto fixed top-[calc(var(--timon-topbar-h)+16px)] z-20 hidden size-8 place-items-center rounded-lg border border-border bg-card text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground lg:grid';

/** `pasted`: a shell command card answered "Paste into a terminal" — refused
 *  to the agent, typed (without Enter) in the user's terminal instead. */
type PermissionState = 'pending' | 'allowed' | 'denied' | 'expired' | 'pasted';


/** Tool invocation rendered inside an assistant bubble. We keep the raw id
 *  (to match the corresponding tool_result later) and the call's input; the
 *  HTML (renderToolUse, renderToolResult) is built when the bubble is drawn
 *  (`toolView`), so a replayed call above the mounted window costs nothing.
 *  The result is attached when its tool_result block arrives on a
 *  subsequent user event. */
type ToolUse = {
  id: string;
  /** `tool_use.input` as the agent sent it — absent stays absent, which
   *  renderToolUse tells apart from `{}`. */
  input?: Record<string, unknown>;
  /** Tool name (Read, Edit, Bash, Grep, etc.) — captured to pick the
   *  downstream tool_result's syntax highlighting. */
  name?: string;
  title?: string;
  /** Path passed as input (file_path / pattern) if applicable — used to
   *  guess the language via hljsLanguageFor. */
  filePath?: string;
  /** Raw argument (bash command, path, pattern) — feeds the "tool
   *  running" bar. `headHtml` is already formatted, so unusable for that. */
  detail?: string;
  /** Wall clock time the tool_use was received. Feeds the "tool running"
   *  bar's timer: without it we can't say how long a `make test` has been
   *  running, which is exactly the useful info. */
  startedAt?: number;
  /** `input.description` — the sentence the AGENT itself writes to say what
   *  it's doing. Claude Code's Bash tool requires it, so it's present on
   *  100% of measured Bash calls, and it's contextual where a heuristic
   *  can only be generic ("Trace callers of createShipment" vs "search
   *  text in files"). */
  intent?: string;
  result?: {
    /** Text of the tool_result, trimmed by `toolResultText`. */
    text: string;
    isError: boolean;
  };
};

/** Who pushed a `user` event when it was not the human — daemon field
 *  `payload.origin` (orchestrator/src/user-origin.ts). Absent = typed in
 *  the composer. */
type MsgOrigin = {
  kind: string;
  from: string;
  missionId?: string | null;
};

/** The bubble says something in words: HTML, or the agent's markdown. */
function hasProse(m: Msg): boolean {
  return m.content.trim() !== '' || !!m.text?.length;
}

const ORIGIN_KIND_KEYS: Record<string, string> = {
  agent: 'chatPage.originAgent',
  routine: 'chatPage.originRoutine',
  cockpit: 'chatPage.originCockpit',
  wake: 'chatPage.originWake',
  system_alert: 'chatPage.originSystemAlert',
  task_return: 'chatPage.originTaskReturn',
  mission_return: 'chatPage.originMissionReturn',
  dispatcher: 'chatPage.originDispatcher',
  fork: 'chatPage.originFork',
  system: 'chatPage.originSystem',
};

function originLabel(kind: string): string {
  const key = ORIGIN_KIND_KEYS[kind];
  return key ? i18n(key) : kind;
}

/** Tolerant reader: an event written by an older daemon has no `origin`,
 *  and a malformed one must not break the bubble. */
function readOrigin(raw: unknown): MsgOrigin | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  if (typeof o.kind !== 'string' || typeof o.from !== 'string' || !o.from) return undefined;
  return {
    kind: o.kind,
    from: o.from,
    missionId: typeof o.mission_id === 'string' ? o.mission_id : null,
  };
}

/** What a chat leaves in the cache of recent conversations when it moves on
 *  (`lib/chat-mission-cache.ts`): every state `bindMission` and `ingest` build,
 *  as last committed, so that coming back paints it before any request. */
type ChatCacheState = {
  messages: Msg[];
  stats: { tok: number; cost: number };
  liveStats: LiveStats;
  agentTodos: AgentTodo[];
  missionBackend: string | null;
  missionModel: string | null;
  missionCwd: string | null;
  missionReasoningEffort: string | null;
  missionOwner: { missionId: string; owner: MissionOwner | null } | null;
  missionAgent: string | null;
  currentSessionId: string | null;
  historyCursor: HistoryCursor;
  turnSeq: number;
  retryLine: { id: string; line: RetryLine } | null;
  lastHumanText: string | null;
  /** `ingest`'s dedup keys, so the delta and the stream skip what is shown. */
  seen: string[];
};

/** The part of {@link ChatCacheState} that lives in React state. */
type CommittedChat = {
  /** The mission bound when the commit happened; `null` while binding. */
  missionId: string | null;
  /** Dedup keys added up to this commit: one added later belongs to an
   *  update not committed yet, and must not hide its row from the delta. */
  seenSize: number;
  state: Omit<ChatCacheState, 'historyCursor' | 'turnSeq' | 'retryLine' | 'lastHumanText' | 'seen'>;
};

type Msg = {
  id: string;
  role: 'user' | 'agent' | 'permission' | 'command' | 'proposal' | 'notice' | 'avatar' | 'ui' | 'secret';
  tag?: 'mission' | 'routine';
  /** Set when the `user` turn was injected by an agent or the daemon: the
   *  bubble then shows that sender, on the agent side, not "you". */
  origin?: MsgOrigin;
  t: string;
  /** trusted HTML (we sanitize when we build it): a human turn, a voice
   *  bubble. The agent's prose is NOT here but in `text`. */
  content: string;
  /** The agent's text blocks, as markdown. Converted when the bubble is
   *  drawn (`agentTextHtml`), never at replay: a long mission held the main
   *  thread converting hundreds of bubbles nobody had scrolled to. Tool_use
   *  citations live in `tools` so they can be merged across the whole turn
   *  and paired with their tool_result. */
  text?: string[];
  /** The agent's reasoning for this bubble, every piece of the step folded
   *  into one plain-text block and shown collapsed. */
  thinking?: string;
  /** Grouped tool_use calls for this bubble (agent only). Every tool_use of
   *  the same assistant turn folds into one bubble (see ingest()). */
  tools?: ToolUse[];
  /** Media the agent showed (SUG-0008): typed blocks, rendered through the
   *  `chat.media` slot — never HTML. */
  media?: ChatMediaBlock[];
  /** A batch of browser annotations the user posted (TODO #481): drawn as a
   *  card from typed data, never from the block the agent read. */
  annotations?: AnnotationCardView;
  /** The stored event the bubble answers to (`reply-to.ts`): for an agent
   *  bubble, the first event that brought it text. A reply targets it. */
  eventId?: number;
  /** The earlier message this human turn replies to, drawn as a quote. */
  reply?: ReplyAttachment;
  /** What the human typed, as written: copied from their bubble. */
  typed?: string;
  /** Turn this bubble belongs to. A turn opens on a `user` payload and
   *  closes on `result`. The bucket used to be the wall-clock minute, which
   *  split a bubble in two whenever a turn crossed 11:42 → 11:43 — a
   *  boundary the conversation knows nothing about. A turn no longer maps to
   *  ONE bubble: see `step`. */
  turn?: number;
  /** Rank of this bubble inside its turn, 1-based. A long turn (a whole
   *  feature coded in one go) used to pile its 150 tool calls into a single
   *  bubble, with the narration that separates the steps buried underneath.
   *  The agent's own prose is the boundary: text arriving after tool calls
   *  opens the next step. Shown in the header from 2 on, so the reader keeps
   *  a chronology inside the turn. */
  step?: number;
  /** When true, render the bubble with a hard destructive border so the
   *  user can spot it at a glance and kill the mission. Currently set on
   *  any assistant message that invokes the native Task/Agent
   *  sub-agent dispatcher (token-burner — see TIMON preamble). */
  danger?: boolean;
  /** Permission-card payload (role === 'permission'). */
  perm?: {
    request_id: string;
    tool_name: string;
    input: unknown;
    state: PermissionState;
    /** Wider answers than "this once" the agent behind the card understands. */
    scopes?: ApprovalScope[];
    /** What a wider Allow covers when Timon keeps it (`Bash(npm test)`). */
    motif?: string;
    /** A one-line shell command the card can paste into a terminal instead
     *  (`choices` then holds `paste`). */
    shell_command?: string;
    choices?: CommandDecision[];
    /** When an autonomous mission's card is auto-resolved (ms epoch); absent = never. */
    expires_at?: number;
  };
  /** A command the agent asks the user to decide (role === 'command'). */
  cmd?: CommandRequestView;
  /** A screen arrangement the agent proposes (role === 'proposal'). */
  proposal?: LayoutProposalView;
  /** An HTML document shown in the conversation (role === 'ui', MCPUI). */
  uiDocument?: UiDocumentBlock;
  /** A secret the agent asks the user for (role === 'secret'). Never a value. */
  secretRequest?: SecretRequestView;
  /** The picture the main agent asks for in its setup conversation (role === 'avatar'). */
  avatarRequest?: SetupAvatarRequest;
  /** Out-of-conversation info line (role === 'notice'): a model change
   *  mid-mission, etc. Rendered as a centered rule, not a bubble. */
  notice?: string;
  /** LLM handover (role === 'notice'): rendered as a card showing both
   *  models side by side instead of the one-line `notice`, which stays
   *  filled as the plain-text form of the same fact. */
  handover?: LlmHandover;
  /** `alert` = the turn stopped on an error or a usage limit. Rendered in
   *  red and across multiple lines: an exhausted quota must be visible,
   *  and its message is too long for an ordinary notice's single line.
   *  `plain` = the bare sentence, for a line that stays in the thread. */
  noticeTone?: 'info' | 'alert';
  /** A provider retrying, or Timon replaying the turn (role === 'notice'):
   *  one line per series, rewritten at every attempt (TODO #459). */
  retryLine?: RetryLine;
  /** A compaction of the conversation (role === 'notice', TODO #504): its
   *  command, the CLI's rows and the daemon's outcome fold into one line. */
  compaction?: CompactionTraceView;
  /** A turn of a GPT-Live voice conversation: `user` = the user's words as
   *  transcribed (role `user`), `voice` = what GPT-Live said (role `agent`).
   *  Never merged with the agent's own bubbles. */
  voice?: VoiceSpeaker;
};

/** GPT-Live bubbles in the chat, most recent last, for the session's
 *  startup context. */
const LIVE_HISTORY_MESSAGES = 20;
const LIVE_HISTORY_CHARS = 1500;

function voiceBubbleHtml(text: string): string {
  return `<p>${escapeHtml(text.replace(/\s+/g, ' ').trim())}</p>`;
}


// Role / task-type pictos + colours now live in the single source of truth
// `@/lib/roles` (consumed via <RoleBadge> and resolveRole) so the visual is
// identical here, in the kanban, the agents canvas and the edit dropdown.

function isHttpUrl(s: string | null | undefined): s is string {
  // http(s) OR a relative path served by TIMON (uploaded icon `/api/uploads/...`).
  return !!s && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'));
}

/** Beyond this many tool calls, a bubble is cut even without narration to
 *  mark the seam — a silent stack past this point is unreadable and scrolls
 *  the conversation out of reach. */
const TOOLS_PER_BUBBLE_MAX = 24;

/** The `reply_to` field of a turn's body, when it answers an earlier message. */
function replyField(reply: ComposerReply | null | undefined): Record<string, unknown> {
  return reply ? { reply_to: { event_id: reply.eventId } } : {};
}

/** The daemon refused the reply itself (`reply-to.ts`), not the mission. */
function isReplyRefusal(body: unknown): boolean {
  const code = (body as { code?: unknown } | null)?.code;
  return code === 'reply_target_not_found' || code === 'invalid_reply_to';
}

/** The stored row an event comes from, when the daemon sent it (live stream,
 *  replay, history page); absent from an older daemon. */
function eventIdOf(ev: { id?: unknown }): number | undefined {
  return typeof ev.id === 'number' && Number.isInteger(ev.id) && ev.id > 0 ? ev.id : undefined;
}

/**
 * The chat's own agent's mascot, for its bubbles: `agentIdentity` resolves the
 * picked head once per chat, and the bubbles of that agent read it here rather
 * than through a prop threaded across every bubble kind.
 */
type BubbleFace = {
  agent: string;
  look: AgentLook | null;
  /** The one bubble whose mascot is live (`liveBubbleOf`), and what it shows. */
  live: string | null;
  state: MascotState;
};
const BubbleFaceContext = createContext<BubbleFace | null>(null);
/** The message a bubble's avatar belongs to (`STREAM_BUBBLE_ID` for the bubble being written). */
const BubbleMessageContext = createContext<string | null>(null);

/** Round avatar shared by all agent bubbles: colored round disc, project/
 *  agent logo image if available, else the agent's mascot when its head is
 *  one, else initial/emoji, + role badge. Hidden on mobile (hidden sm:block)
 *  to free up width. */
function BubbleAvatar({ color, iconUrl, fallback, roleKey, agent }: {
  color: string; iconUrl?: string | null; fallback: string; roleKey?: string | null;
  /** The agent this avatar stands for: when set, the avatar opens its editor. */
  agent?: string;
}) {
  // Tiny role sub-badge bottom-right. Skip `main` (orchestrator) — the
  // avatar disc already carries project identity; a Network glyph here is noise.
  const roleVisual = roleKey && roleKey !== 'main' ? resolveRole(roleKey) : null;
  const RoleIcon = roleVisual?.icon ?? null;
  const face = useContext(BubbleFaceContext);
  const at = useContext(BubbleMessageContext);
  const look = face && agent && face.agent === agent && !isHttpUrl(iconUrl) ? face.look : null;
  // One live mascot per conversation (TODO #902): the others keep the look, still.
  const liveHere = face !== null && at !== null && at === face.live;
  const disc = look ? (
    <div className="grid size-[34px] place-items-center" data-agent-mascot data-mascot-live={liveHere || undefined}>
      <LiveAgentMascot name={agent!} look={look} size={34} live={liveHere} state={liveHere ? face.state : undefined} />
    </div>
  ) : (
    <div
      className="grid size-[34px] place-items-center overflow-hidden rounded-[var(--avatar-radius)] border bg-[var(--accent-soft)] border-[var(--accent-border)] tabular-nums text-[13px] font-semibold text-[var(--accent)] dark:bg-[var(--accent-soft-dark)] dark:border-[var(--accent-border-dark)] dark:text-[var(--accent-dark)]"
      style={accentVars(color)}
    >
      {isHttpUrl(iconUrl) ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={iconUrl} alt="" className="size-full object-cover" />
      ) : (
        <span>{fallback}</span>
      )}
    </div>
  );
  const editable = Boolean(agent);
  const badgeColor = roleVisual?.color ?? 'hsl(var(--muted-foreground))';
  return (
    <div className="relative row-start-1 col-start-1 hidden size-[34px] sm:block">
      {/* Soft project-tinted disc, same rules as `AgentAvatar`: two colour
          variants published as CSS variables so the theme picks the readable
          one, and the logo filling the disc since it is framed at upload. */}
      {editable ? (
        <button
          type="button"
          onClick={() => openAgentEditor({ agent: agent! })}
          aria-label={i18n('chatPage.editAgent', { name: agent! })}
          title={i18n('chatPage.editAgent', { name: agent! })}
          className="group block rounded-[var(--avatar-radius)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          {disc}
          {/* The role picto turns into a pencil on hover, inside a ring that turns. */}
          <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center overflow-hidden rounded-full">
            <span
              aria-hidden
              className="absolute -inset-2 animate-spin opacity-0 transition-opacity [animation-duration:2.4s] group-hover:opacity-100 group-focus-visible:opacity-100"
              style={{ background: 'conic-gradient(from 0deg, transparent 0 55%, hsl(var(--primary)) 100%)' }}
            />
            <span
              className="absolute inset-[1.5px] grid place-items-center rounded-full ring-2 ring-background transition-colors group-hover:!bg-background group-focus-visible:!bg-background"
              style={{ background: RoleIcon ? badgeColor : 'transparent' }}
            >
              {RoleIcon && <RoleIcon className="size-2.5 text-white transition-opacity group-hover:opacity-0 group-focus-visible:opacity-0" />}
              <Pencil className="absolute size-2.5 text-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
            </span>
          </span>
        </button>
      ) : (
        <>
          {disc}
          {RoleIcon && roleVisual && (
            <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full ring-2 ring-background" style={{ background: roleVisual.color }}>
              <RoleIcon className="size-2.5 text-white" />
            </span>
          )}
        </>
      )}
    </div>
  );
}



function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** Truncate a single-line representation of any value to N chars. */
function trunc(s: string, n: number) {
  const clean = s.replace(/\s+/g, ' ').trim();
  return clean.length > n ? clean.slice(0, n - 1) + '…' : clean;
}

/**
 * How far from the end the thread still counts as "being followed".
 *
 * Wide on purpose: a turn that just landed added a few lines, and the reader
 * who is watching it arrive has not decided to leave.
 */
const FOLLOW_SLACK = 160;

/**
 * Render a tool_use block from a claude assistant message into something
 * legible — tool name + the argument that matters for that tool (the bash
 * command, the file path, the search pattern…). Falls back to JSON-trunc for
 * unknown tools so nothing is silently swallowed.
 */
function renderToolUse(b: { name: string; input?: Record<string, unknown> }) {
  const name = escapeHtml(b.name);
  const detail = toolDetail(b);
  if (b.input || b.name.startsWith('mcp__')) {
    // `tool-cite-name` marks a citation that carries NOTHING but the tool's
    // name: the stacked mode prints that name itself, above the panel, and
    // needs to be able to drop this one rather than say it twice.
    return `<p class="cite tool-cite-name">${name}</p>${renderToolJson(b.input ?? {})}`;
  }

  // Task / Agent are the native Claude Code sub-agent dispatchers — banned
  // at the CLI level because their stream pollutes the parent's context
  // and burns tokens exponentially. If one still slips through (old
  // process, prompt drift, whatever), flag the citation hard so the user
  // sees it instantly and can kill the mission. The 'subagent-call' class
  // is styled red in the chat-bubble inline CSS block.
  const isNativeSubagent = b.name === 'Task' || b.name === 'Agent';
  const head = isNativeSubagent
    ? `<span class="subagent-bad">⚠ ${name}</span>`
    : `<span style="color:hsl(var(--primary));font-weight:500">${name}</span>`;
  const cls = isNativeSubagent ? 'cite subagent-call' : 'cite';
  if (!detail) return `<p class="${cls}">↳ ${head}</p>`;
  // The citation is truncated to 200 chars to stay readable: the button
  // therefore carries the FULL command in data-copy (impossible to read it
  // back from the DOM). This is use case #1 — copying a suggested `Bash`.
  return `<p class="${cls}">↳ ${head} · <code>${escapeHtml(trunc(detail, 200))}</code>${copyButtonHtml('cite-copy', detail)}</p>`;
}

/**
 * The argument that matters for a given tool, as plain text (the bash
 * command, the file path, the search pattern…). Extracted from
 * `renderToolUse` to be reusable: the "tool running" bar needs the bare
 * text, not the pre-rendered HTML, and re-parsing `headHtml` would be
 * absurd.
 */
function toolDetail(b: { name: string; input?: Record<string, unknown> }): string {
  const inp = chipInput(b.name, (b.input || {}) as Record<string, unknown>);
  const pick = (k: string) => (typeof inp[k] === 'string' ? (inp[k] as string) : '');

  let detail = '';
  switch (b.name) {
    case 'Bash':
      detail = pick('command');
      break;
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      detail = pick('file_path');
      break;
    case 'Grep':
      detail = pick('pattern') + (pick('path') ? ' in ' + pick('path') : '');
      break;
    case 'Glob':
      detail = pick('pattern') + (pick('path') ? ' under ' + pick('path') : '');
      break;
    case 'WebFetch':
    case 'WebSearch':
      detail = pick('url') || pick('query');
      break;
    case 'Task':
    case 'Agent':
      detail = pick('description') || pick('prompt');
      break;
    case 'TodoWrite': {
      // Compact list of statuses — useful to see the plan at a glance.
      const todos = (inp.todos as Array<{ subject?: string; status?: string }>) || [];
      detail = todos
        .map((t) => `[${t.status || '?'}] ${t.subject || ''}`)
        .join(' · ');
      break;
    }
    default:
      // Generic: show whatever non-trivial JSON is in the input.
      try {
        const json = JSON.stringify(inp);
        if (json && json !== '{}') detail = json;
      } catch {}
  }
  return detail;
}

/** Guesses the icon for an `mcp__server__action` call from the action
 *  name (search / read / write / delete) rather than a generic plug. */
function mcpIconFor(name: string): LucideIcon {
  const parts = name.split('__');
  const action = parts[parts.length - 1] || '';
  if (action.includes('search')) return Search;
  if (/^(delete|remove)/.test(action)) return Trash2;
  if (/^(write|append|create|add|update|set|send)/.test(action)) return Pencil;
  if (/^(read|get|list|fetch)/.test(action)) return BookOpen;
  return Plug;
}

/** Guesses the icon for a Bash call from the invoked binary (first
 *  token, `sudo` skipped) — a `git log` and a `rm -rf` don't carry the
 *  same impact and shouldn't share the same generic terminal picto. */
function bashIconFor(command: string | undefined): LucideIcon {
  const tokens = (command || '').trim().split(/\s+/);
  let i = 0;
  if (tokens[i] === 'sudo') i++;
  const bin = (tokens[i] || '').split('/').pop() || '';
  switch (bin) {
    case 'git':
      return GitBranch;
    case 'docker':
    case 'docker-compose':
      return Container;
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'pip':
    case 'pip3':
    case 'cargo':
    case 'go':
    case 'apt':
    case 'apt-get':
    case 'brew':
      return Package;
    case 'curl':
    case 'wget':
      return Globe;
    case 'rm':
      return Trash2;
    case 'ls':
    case 'find':
      return FolderSearch;
    case 'grep':
    case 'rg':
    case 'ag':
      return Search;
    case 'cat':
    case 'head':
    case 'tail':
    case 'less':
    case 'bat':
      return FileText;
    case 'kill':
    case 'pkill':
    case 'ps':
    case 'top':
    case 'htop':
      return Cpu;
    case 'systemctl':
    case 'service':
      return Settings;
    default:
      return SquareTerminal;
  }
}

/** Per-tool icon, for the citation line's fallback in the dropdown.
 *  Covers the most frequent native Claude Code tools, Bash differentiated
 *  by invoked binary, and MCP `mcp__server__action` tools differentiated
 *  by verb (search/read/write) rather than a generic wrench. */
function toolIconFor(name: string | undefined, detail?: string): LucideIcon {
  if (!name) return Wrench;
  if (name.startsWith('mcp__')) return mcpIconFor(name);
  switch (name) {
    case 'Bash':
      return bashIconFor(detail);
    case 'Read':
      return FileText;
    case 'Edit':
    case 'NotebookEdit':
      return Pencil;
    case 'Write':
      return FilePlus;
    case 'Grep':
    case 'ToolSearch':
      return Search;
    case 'Glob':
      return FolderSearch;
    case 'WebFetch':
    case 'WebSearch':
      return Globe;
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
      return ListChecks;
    case 'Task':
    case 'Agent':
      return Cpu;
    default:
      return Wrench;
  }
}

/**
 * The grok CLI (≤1.0.5) sometimes serializes `run_terminal_command` output
 * (and other internal tools like `read_file`) as raw JSON whose content
 * field is an array of code units instead of a decoded string — e.g.
 * `{"type":"Bash","output":[91,10,32,123,...]}`. This isn't a standard
 * Anthropic content block (no `{type:'text',text}`), so `renderToolResult`
 * displayed it as-is: a wall of numbers. We detect this exact pattern and
 * decode the array as UTF-8 for display — without touching the persisted
 * `events` stream, which keeps the CLI's raw form.
 */
function decodeGrokRawToolOutput(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return text;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return text;
  const obj = parsed as Record<string, unknown>;
  for (const key of ['output', 'content', 'stdout', 'text']) {
    const val = obj[key];
    if (Array.isArray(val) && val.length > 0 && val.every((n) => typeof n === 'number')) {
      try {
        return new TextDecoder('utf-8').decode(Uint8Array.from(val as number[]));
      } catch {
        return text;
      }
    }
  }
  return text;
}

/** Characters of a plain-text tool result shown in its bubble. */
const TOOL_RESULT_MAX = 1200;

/**
 * The text a tool_result block shows, read at replay — cheap string work
 * only; `renderToolResult` turns it into HTML when the bubble is drawn.
 * Plain text is cut one character past what is shown, which is all the
 * renderer needs to know it was cut: a 200 kB `Read` is not kept in the
 * thread's state for 1 200 characters on screen. Anything that may parse as
 * JSON is kept whole, the table is built from all of it.
 */
function toolResultText(content: unknown): string {
  let text = '';
  if (typeof content === 'string') {
    text = decodeGrokRawToolOutput(content);
  } else if (Array.isArray(content) && content.length > 0 && content.every((b) => b && typeof b === 'object' && typeof b.type === 'string')) {
    for (const b of content as Array<{ type?: string; text?: string }>) {
      if (b?.type === 'text' && typeof b.text === 'string') text += decodeGrokRawToolOutput(b.text);
    }
  } else if (content !== null && typeof content === 'object') {
    text = JSON.stringify(content);
  }
  // A long JSON scalar (a 1 200-digit number) would parse and is not worth
  // keeping a `Read` whole for: only a container or a string counts.
  if (text.length <= TOOL_RESULT_MAX + 1 || /^\s*[[{"]/.test(text)) return text;
  return text.slice(0, TOOL_RESULT_MAX + 1);
}

/**
 * Renders a tool_result's text (`toolResultText`). If the parent tool_use
 * exposes a `name` (Read/Edit/Bash/...) and ideally a `filePath`, we guess
 * the language via hljsLanguageFor and colorize via highlightCode. Otherwise
 * we leave it as plain text (base color, no bold). is_error → red badge +
 * border.
 */
function renderToolResult(
  text: string,
  isError: boolean,
  hint?: { name?: string; filePath?: string },
): string {
  const jsonHtml = tryRenderToolJson(text);
  if (jsonHtml !== null) {
    return `<div class="tool-result${isError ? ' tool-result-error' : ''}">${isError ? '<span class="tool-result-badge">error</span>' : ''}${jsonHtml}</div>`;
  }
  const MAX = TOOL_RESULT_MAX;
  const truncated = text.length > MAX;
  const display = truncated ? text.slice(0, MAX) + '\n…' : text;
  const cls = 'tool-result' + (isError ? ' tool-result-error' : '');
  const badge = isError
    ? '<span class="tool-result-badge">error</span>'
    : '';
  if (!display) {
    return `<div class="${cls}">${badge}<pre><span class="tool-result-empty">(empty)</span></pre></div>`;
  }
  // Guesses the language. Read/Edit/Write carry a file_path → reliable.
  // Bash → 'bash'. The rest stays plain text (highlight useless, often
  // free text like "no matches found" that would render ugly).
  let lang: string | undefined;
  if (hint?.filePath) {
    lang = hljsLanguageFor(hint.filePath.split('/').pop() ?? '') ?? undefined;
  } else if (hint?.name === 'Bash') {
    lang = 'bash';
  }
  if (lang) {
    // Read prefixes each line with "N→" (line numbers) — we strip them
    // for clean coloring, otherwise hljs sees noise at line start.
    const cleaned = hint?.name === 'Read'
      ? display.replace(/^ *\d+→/gm, '')
      : display;
    const html = highlightCode(cleaned, lang);
    return `<div class="${cls}">${badge}<pre data-lang="${escapeHtml(lang)}"><code class="hljs language-${escapeHtml(lang)}">${html}</code></pre></div>`;
  }
  return `<div class="${cls}">${badge}<pre>${escapeHtml(display)}</pre></div>`;
}

/** What ToolCall draws: the call and its HTML, built once per call object
 *  and highlighter version — never for a call outside the mounted window. */
const toolView = createObjectHtmlCache((tool: ToolUse) => ({
  ...tool,
  headHtml: renderToolUse({ name: tool.name ?? '', input: tool.input }),
  result: tool.result && {
    html: renderToolResult(tool.result.text, tool.result.isError, { name: tool.name, filePath: tool.filePath }),
    isError: tool.result.isError,
  },
}));

function nowTime() {
  return new Date().toTimeString().slice(0, 5);
}

/** Backend-switch notice: the /send route swaps the mission when its
 *  backend runs out of quota, and the message goes out on the fallback.
 *  Same thread, same missionId, different CLI. */
function noteBackendSwitch(
  payload: Record<string, unknown>,
  push: (fn: (m: Msg[]) => Msg[]) => void,
): void {
  const sw = payload.switched as { from?: string; backend?: string; model?: string | null };
  const model = sw.model ? `/${sw.model}` : '';
  const lost = payload.imagesDropped
    ? ' ' + i18n('chatPage.imagesLostOnSwitch')
    : '';
  push((m) => [
    ...m,
    {
      id: crypto.randomUUID(),
      role: 'notice',
      t: nowTime(),
      content: '',
      notice: i18n('chatPage.backendSwitched', {
        from: sw.from ?? i18n('chatPage.theBackend'),
        backend: `${sw.backend}${model}`,
        lost,
      }),
    },
  ]);
}

/** Message shown when the orchestrator refuses a turn for lack of quota.
 *  Says WHEN it resumes: without the time, we don't know whether to wait
 *  two minutes or five hours, and we retry blindly. */
function quotaNotice(payload: Record<string, unknown>): string {
  const backend = typeof payload.backend === 'string' ? payload.backend : i18n('chatPage.theBackend');
  const resetsAt = typeof payload.resetsAt === 'number' ? payload.resetsAt : null;
  const when = resetsAt
    ? ' — ' + i18n('chatPage.reopensAt', { time: new Date(resetsAt).toTimeString().slice(0, 5) })
    : '';
  return i18n('chatPage.quotaExhausted', { backend, when });
}

/** Agent todo — painted by the `Agent todos` card to surface the agent's
 *  internal progress (TodoWrite / TaskCreate / TaskUpdate). */
function normalizeTodoStatus(s: unknown): AgentTodoStatus {
  const v = typeof s === 'string' ? s.toLowerCase() : '';
  if (v === 'completed' || v === 'done') return 'completed';
  if (v === 'in_progress' || v === 'doing' || v === 'active') return 'in_progress';
  if (v === 'cancelled' || v === 'canceled' || v === 'skipped') return 'cancelled';
  return 'pending';
}

/** Applies a tool_use related to the agent's todo list to the existing
 *  state. Returns null if the tool isn't a todo mutation (the caller then
 *  leaves the state unchanged). */
function applyTodoToolUse(
  prev: AgentTodo[],
  name: string,
  input: Record<string, unknown>,
  toolUseId: string,
): AgentTodo[] | null {
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return todos.map((t, i) => {
      const o = (t || {}) as Record<string, unknown>;
      return {
        id: typeof o.id === 'string' ? o.id : `tw-${toolUseId}-${i}`,
        subject: typeof o.subject === 'string'
          ? o.subject
          : (typeof o.content === 'string' ? o.content : i18n('chatPage.untitled')),
        description: typeof o.description === 'string' ? o.description : undefined,
        status: normalizeTodoStatus(o.status),
      };
    });
  }
  if (name === 'TaskCreate') {
    const subject = typeof input.subject === 'string'
      ? input.subject
      : (typeof input.title === 'string' ? input.title : i18n('chatPage.untitled'));
    const description = typeof input.description === 'string' ? input.description : undefined;
    return [
      ...prev,
      { id: `tc-${toolUseId}`, subject, description, status: 'pending' },
    ];
  }
  if (name === 'TaskUpdate') {
    const id = typeof input.id === 'string' ? input.id
      : (typeof input.task_id === 'string' ? input.task_id : null);
    // No matchable id: we try to update the latest non-finished entry.
    // This is best-effort — the SDK keeps the id on the tool_result side,
    // which we don't finely correlate here.
    const next = prev.map((t) => ({ ...t }));
    const targetIdx = id
      ? next.findIndex((t) => t.id === id || t.id.endsWith(id))
      : next.findIndex((t) => t.status === 'in_progress' || t.status === 'pending');
    if (targetIdx === -1) return prev;
    if (typeof input.status !== 'undefined') {
      next[targetIdx]!.status = normalizeTodoStatus(input.status);
    }
    if (typeof input.subject === 'string') next[targetIdx]!.subject = input.subject;
    if (typeof input.description === 'string') next[targetIdx]!.description = input.description;
    return next;
  }
  if (name === 'TaskStop') {
    const id = typeof input.id === 'string' ? input.id : null;
    if (!id) return prev;
    return prev.map((t) =>
      t.id === id || t.id.endsWith(id) ? { ...t, status: 'cancelled' } : t,
    );
  }
  return null;
}

/** Hands the chat page whether its island has the focus, for what is decided
 *  above the node it gives the workspace (push-to-talk). */
function SignalerFocus({ onChange }: { onChange: (focused: boolean) => void }) {
  const focused = useIslandRouteFocused();
  useEffect(() => { onChange(focused); }, [focused, onChange]);
  return null;
}

export function ChatClient({
  forcedAgent,
  forcedMission,
  initialFresh = false,
  compact = false,
  chromeComplet = false,
  setup = false,
  inIsland = false,
  primary = true,
  focused = true,
  contextPrefix,
  onMissionChange,
  onConversationShown,
  keepInView,
  onAgentSpoke,
  onSetupTrouble,
  onAgentActivity,
  routeParams,
}: {
  /** Override URL ?agent= param. Used by /multichat to pin a slot to a
   *  specific agent without depending on the page URL. */
  forcedAgent?: string;
  /** Override URL ?mission= param. Same purpose as forcedAgent. */
  forcedMission?: string;
  /** When true and no forcedMission/mission param, skip auto-binding the
   *  latest mission on mount and arm freshStart instead. Used by multichat
   *  when the user explicitly clicks "New conversation". */
  initialFresh?: boolean;
  /** When true, hide global TopBar, both widget columns and compact
   *  paddings so the component fits inside a grid cell. */
  compact?: boolean;
  /** Keeps the full chat chrome despite `compact`: the composer pill and
   *  the usage-ceiling strip. The cockpit uses it — it's a control panel,
   *  the same chat as everywhere else is expected there. A multichat cell,
   *  on the other hand, already carries its own frame and has no room for
   *  the strip. */
  chromeComplet?: boolean;
  /** The first-run conversation (`/setup/agent`): the bootstrap turn stays out of the
   *  transcript, the composer is the setup variant, and a picture request is a card. */
  setup?: boolean;
  /** A chat that IS a content of the island workspace (`@timon/missions:chat`,
   *  ISLAND-WORKSPACE.md §7). Distinct from `compact`: no TopBar, no
   *  underlay, no workspace of its own (no recursion), but the columns stay,
   *  with their drawer mode measured on the island. */
  inIsland?: boolean;
  /** Whether this chat holds the chat's widget zones (Q10). Only the primary
   *  chat of the view mounts them; another one shows its panels' triggers,
   *  and clicking one activates its island first. Read by an island chat from
   *  `useIslandContent()`; the chat page reads it from its workspace. */
  primary?: boolean;
  /** An island chat's island has the focus (`useIslandContent().focused`).
   *  A key held for push-to-talk opens the mic of the focused chat only. */
  focused?: boolean;
  /** Block of context joined to the FIRST turn this chat sends, then never
   *  again. A host that embeds the chat in a screen of its own — the workflow
   *  builder — uses it to say what is on that screen (which workflow, its id,
   *  the skill to read) without the user having to type it, and without a
   *  second chat being written next to this one. */
  contextPrefix?: string;
  /** Notifies the host of the mission currently displayed. The cockpit
   *  uses it to wire the voice mode onto the SAME thread: it listens to
   *  its SSE stream and posts its turns there, so everything said aloud
   *  lands in the written conversation without duplicating any state. */
  onMissionChange?: (missionId: string | null) => void;
  /** A conversation is on screen, bound or just started, with the agent it
   *  belongs to: a mission picked from the rail may be another agent's
   *  (TODO #460). An island keeps both in its params (TIM-0140). */
  onConversationShown?: (missionId: string, agent: string) => void;
  /** The page's chat in a split view (`PageChat`): keeps a conversation of
   *  another agent in the page's panel, `true` when it did. The view then
   *  keeps its agent and the URL only names the mission (TIM-0140). */
  keepInView?: (missionId: string, owner: string) => boolean;
  /** Called once the agent's first words are on screen (the setup wizard lifts its loader). */
  onAgentSpoke?: () => void;
  /** `setup` only: the conversation hit something the agent will not get past
   *  alone (a refused tool, a cut turn, the mission ending) — the wizard then
   *  puts its "Skip" forward. */
  onSetupTrouble?: (signal: SetupChatSignal) => void;
  /** What the agent is doing, at every change: a face that shows it (the
   *  onboarding chat's mascot, `components/mascot/agent-activity.ts`). */
  onAgentActivity?: (activity: AgentActivity) => void;
  /** The address this conversation was keyed on, from `ChatRoute`: the live
   *  one moves first, while the previous conversation is still on screen. */
  routeParams?: URLSearchParams;
} = {}) {
  const liveParams = useSearchParams();
  const params = routeParams ?? liveParams;
  const router = useRouter();
  const agentParam = params.get('agent');
  /** The agent the chat was opened on (URL or host): it scopes the initial
   *  binding. The view itself follows `agentId` below. */
  const hostAgentId = forcedAgent || agentParam || '';
  /** Agent of the mission on screen, from its detail. The rail lists the whole
   *  project, so a mission picked there may belong to another agent than the
   *  one the chat was opened on: name, avatar, settings and the next spawn are
   *  that agent's, not the host's (TODO #460). */
  const [missionAgent, setMissionAgent] = useState<string | null>(null);
  const agentId = missionAgent || hostAgentId;
  // Optional ?mission=<id> param lets the user pin a specific conversation
  // (e.g. opening from /missions or /agents side panel). Read once at mount,
  // then the active mission becomes state we mutate locally.
  const missionParam = requestedChatMission(forcedAgent, forcedMission, params.get('mission'));
  // A new-host alert's link opens the mission's Network view beside the page's chat.
  useEgressDeepLink(missionParam, !compact && !inIsland && params.get(EGRESS_DEEP_LINK_PARAM) === '1');

  const [agent, setAgent] = useState<Agent>({ name: agentId, model: 'sonnet', kind: 'live', status: 'idle' });
  /** True once the `/api/ui/agents/:id` fetch has settled (success or
   *  failure). While false, `agent.project` is still `undefined` — a state
   *  that must never be confused with "no project" (`null`, a legitimate
   *  cross-cutting agent). refreshMissions relies on this to avoid
   *  fetching-then-filtering on a project we haven't resolved yet: without
   *  this guard, the 3 effects that call it on mount (bind, refetch, poll)
   *  all ran with `project=null`, showing the client-filtered global list
   *  for this single agent (a "5 missions" flash instead of the project's
   *  full rail), before the real fetch corrected the display once
   *  resolved. */
  const agentReadyRef = useRef(false);
  /** Same moment as `agentReadyRef`, for the reads that need the agent's
   *  `cwd`: firing them before it lands costs a second request. */
  const [agentSettled, setAgentSettled] = useState(false);
  /** Backend catalog: carries the CAPABILITIES (account usage, permission
   *  model) the display depends on. Single request, module-cached. */
  const backendCatalog = useBackendCatalog();
  const [messages, setMessages] = useState<Msg[]>([]);
  /** First mounted message of the thread (`lib/thread-window.ts`): a long
   *  mission only mounts its tail. `null` = the tail, not yet pinned. */
  const [threadAnchor, setThreadAnchor] = useState<string | null>(null);
  const threadStart = threadWindowStart(messages, threadAnchor);
  // The setup conversation opens on the bootstrap turn (the skill, sent by the daemon): the
  // person must meet an agent that speaks first, not an instruction they never wrote.
  const firstUserId = setup ? messages.find((m) => m.role === 'user')?.id ?? null : null;
  const spokeRef = useRef(false);
  useEffect(() => {
    if (spokeRef.current || !onAgentSpoke) return;
    // Words, or the form it opens first (the setup skill starts on a `question` card).
    if (!messages.some((m) => (m.role === 'agent' && hasProse(m)) || m.role === 'permission')) return;
    spokeRef.current = true;
    onAgentSpoke();
  }, [messages, onAgentSpoke]);
  const setupTroubleRef = useRef(onSetupTrouble);
  setupTroubleRef.current = setup ? onSetupTrouble : undefined;
  useEffect(() => {
    if (!setup || !onSetupTrouble) return;
    const signal = chatTroubleSignal(messages);
    if (signal) onSetupTrouble(signal);
  }, [messages, setup, onSetupTrouble]);
  useEffect(() => {
    const pin = anchorToPin(messages, threadAnchor, threadStart);
    if (pin) setThreadAnchor(pin);
  }, [messages, threadAnchor, threadStart]);
  /** Distance from the bottom captured before older messages are mounted,
   *  restored right after so the line being read stays put. */
  const olderRestore = useRef<number | null>(null);
  /** How far back the journal is loaded: a chat opens on its last page
   *  (`lib/chat-history-page.ts`), older pages come on request. */
  const historyCursor = useRef<HistoryCursor>(NO_HISTORY);
  const [hasOlderHistory, setHasOlderHistory] = useState(false);
  /** Newest journal row read (page or delta): the `after` of the next delta
   *  once this conversation is cached. Live rows carry no id; the delta
   *  brings them again and the dedup keys drop them. */
  const lastEventId = useRef<number | null>(null);
  /** Journal characters behind the conversation, its weight in the cache. */
  const cacheBytes = useRef(0);
  /** Account epoch the conversation on screen was built under
   *  (`chatCacheEpoch()`): once a logout purged the cache, nothing built
   *  before it goes back in, not even on the unmount that follows. */
  const cacheEpoch = useRef(chatCacheEpoch());
  /** Bumped by every bind: an overtaken one stops writing. */
  const bindGeneration = useRef(0);
  const committedChat = useRef<CommittedChat | null>(null);
  const [loadingOlderHistory, setLoadingOlderHistory] = useState(false);
  const loadingOlder = useRef(false);
  const [thinking, setThinkingState] = useState(false);
  /** What `thinking` was last set to, readable at once: the stream can deliver
   *  a `result` and the next `assistant` before React renders the first. */
  const thinkingNow = useRef(false);
  const setThinking = useCallback((on: boolean) => {
    thinkingNow.current = on;
    // Raising it is news the watchdog must not answer with an older word of the
    // daemon: a message just left, and the daemon may not have it yet.
    if (on) lastStreamAt.current = Date.now();
    setThinkingState(on);
  }, []);
  /** Interrupt request in flight — avoids a double click, which would
   *  send a second SIGTERM to a process already dying. */
  const [stopping, setStopping] = useState(false);
  /** Latest activity hint to show inside the Thinking indicator
   *  (last tool name, or null for the generic "thinking" state). Cleared
   *  on every turn boundary (user send, result, mission_complete). */
  const [thinkingHint, setThinkingHint] = useState<string | null>(null);
  /** Which assistant turn the incoming events belong to. Bumped on every
   *  turn boundary (a `user` payload opens one, `result` closes one); the
   *  assistant handler folds everything sharing the value into one bubble.
   *  A ref, not state: ingest() reads it synchronously inside setMessages,
   *  where a state read would be one render late. */
  const turnSeq = useRef(0);
  /** The retry line of the current series (TODO #459), and the backend name it
   *  shows. Refs: ingest() is called from stream handlers set up renders ago. */
  const retryLineRef = useRef<{ id: string; line: RetryLine } | null>(null);
  const providerNameRef = useRef('');
  /** The last text the human typed, and the one Retry asks `send` to replay. */
  const lastHumanText = useRef<string | null>(null);
  const replayTurnText = useRef<string | null>(null);
  const [currentMissionId, setCurrentMissionId] = useState<string | null>(null);
  // A draft belongs to the conversation on screen: the bound mission, or the
  // pinned one while binding, else the agent's not-yet-started conversation.
  const draftOwner = draftKey(agentId, currentMissionId ?? forcedMission);
  const [input, setInput] = useComposerDraft(draftOwner);
  const [recording, setRecording] = useState(false);
  /** Which recognizer dictates (lib/dictation/recognition): Web Speech in a
   *  browser, the desktop's local engine in the app. Greyed out only where
   *  neither exists — the desktop without a local engine keeps TIM-0061's
   *  message. Read after hydration only — the server cannot know the shell. */
  const dictationRoute = useDictationRoute();
  const dictationUnavailable = dictationRoute === 'unavailable-desktop';
  /** The draft's owner and revision, captured when a dictation starts
   *  (lib/dictation/draft-contract): a late transcript never overwrites an
   *  edit, nor lands in another conversation. The two live refs are what the
   *  recognizer's callbacks compare against — state would be a render late. */
  const dictationDraftRef = useRef<DictationDraft | null>(null);
  const draftOwnerRef = useRef(draftOwner);
  draftOwnerRef.current = draftOwner;
  const liveInputRef = useRef(input);
  liveInputRef.current = input;
  const [audioLevels, setAudioLevels] = useState<number[]>(() => Array.from({ length: 16 }, () => 0.08));
  /** False when the audio level isn't measurable — on mobile, the mic
   *  belongs to the recognition engine. Frozen bars read as a dead
   *  dictation: we make them breathe instead. */
  const [visualiseurActif, setVisualiseurActif] = useState(false);
  const recognitionRef = useRef<RecognitionLike | null>(null);
  const dictationBaseRef = useRef('');
  /** A stop requested by the user produces a legitimate `aborted` error:
   *  it's the ONLY case we silence. The previous filter hid `aborted` in
   *  all circumstances — including when the system engine lost the mic. */
  const manualStopRef = useRef(false);
  /** At least one word transcribed in the current dictation session: as
   *  long as it's false, an `aborted` is suspicious rather than routine. */
  const sttOkRef = useRef(false);
  /** Mic conflict detected: relaunch dictation once the visualizer is
   *  cut, so the user doesn't have to re-click on an invisible failure. */
  const relanceApresConflitRef = useRef(false);
  /** The visualizer was requested (`getUserMedia` may still be in
   *  flight): enough to attribute a mic steal to it. */
  const visualiseurDemandeRef = useRef(false);
  /** Timestamp of the last recognized speech (or of the start when nothing has
   *  been said yet): the grace window is measured from it. */
  const derniereActiviteRef = useRef(0);
  /** Text of the CURRENT recognition session. Folded into `dictationBaseRef`
   *  before every relaunch — a new session restarts from an empty
   *  `event.results` and would otherwise overwrite what precedes it. */
  const texteSessionRef = useRef('');
  /** A relaunch-proof error was received (mic refused or stolen): closes the
   *  dictation instead of retrying every 250 ms until the window expires. */
  const dicteeFataleRef = useRef(false);
  /** Inactivity timer that ends the dictation, and the relaunch timer. Both
   *  cleared on stop and on unmount: an orphan timer would reopen the mic on a
   *  page the user has left. */
  const silenceTimerRef = useRef<number | null>(null);
  const restartTimerRef = useRef<number | null>(null);
  const clearDictationTimers = useCallback(() => {
    if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
    if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
    silenceTimerRef.current = null;
    restartTimerRef.current = null;
  }, []);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioFrameRef = useRef<number | null>(null);
  const audioSessionRef = useRef(0);
  /** Words of a GPT-Live turn, read once by `send` instead of the draft. */
  const voiceTurnText = useRef<string | null>(null);
  /** Spoken exchanges the agent never heard, sent along with that turn. */
  const voiceTurnContext = useRef<string>('');
  /** The thread a GPT-Live session writes into. `id` is null while the thread
   *  has no mission yet (it gets one at the first delegation). Replaced on
   *  every start and dropped when the user leaves the thread, so late turns
   *  of a closing session never land in another conversation. */
  const liveThread = useRef<{ id: string | null } | null>(null);
  const journalQueue = useRef<Array<{ turn: VoiceTurn; thread: { id: string | null } }>>([]);
  const gptLiveStopRef = useRef<() => void>(() => {});
  const stopAudioVisualiser = useCallback(() => {
    visualiseurDemandeRef.current = false;
    setVisualiseurActif(false);
    audioSessionRef.current += 1;
    if (audioFrameRef.current !== null) {
      window.cancelAnimationFrame(audioFrameRef.current);
      audioFrameRef.current = null;
    }
    audioStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioStreamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== 'closed') void context.close();
    setAudioLevels(Array.from({ length: 16 }, () => 0.08));
  }, []);
  const startAudioVisualiser = useCallback(async () => {
    // A mic-exclusivity conflict has already been observed on this
    // device: the visualizer costs it the entire dictation there (cf.
    // lib/stt-mic-exclusif).
    if (visualiseurInterdit()) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext) return;
    visualiseurDemandeRef.current = true;
    const session = audioSessionRef.current + 1;
    audioSessionRef.current = session;
    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (audioSessionRef.current !== session) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      const context = new AudioContext();
      await context.resume();
      const analyser = context.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.78;
      context.createMediaStreamSource(stream).connect(analyser);
      audioStreamRef.current = stream;
      audioContextRef.current = context;
      setVisualiseurActif(true);
      const bins = new Uint8Array(analyser.frequencyBinCount);
      let lastPaint = 0;
      const paint = (now: number) => {
        analyser.getByteFrequencyData(bins);
        if (now - lastPaint >= 48) {
          lastPaint = now;
          setAudioLevels(Array.from({ length: 16 }, (_, index) => {
            const bin = bins[Math.min(bins.length - 1, index + 1)] ?? 0;
            return Math.max(0.08, bin / 255);
          }));
        }
        audioFrameRef.current = window.requestAnimationFrame(paint);
      };
      audioFrameRef.current = window.requestAnimationFrame(paint);
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      // Dictation stays usable when the audio analyser is not available.
    }
  }, []);
  useEffect(() => () => {
    // Unmount = deliberate stop: don't toast the `aborted` that follows.
    manualStopRef.current = true;
    clearDictationTimers();
    recognitionRef.current?.stop();
    stopAudioVisualiser();
    window.speechSynthesis?.cancel();
  }, [clearDictationTimers, stopAudioVisualiser]);
  /** Persistent per-agent model override. Null = uses agent.model
   *  (config). Only visible when no mission is running. Sticky via
   *  localStorage to survive auto-respawns (dead mission → fallback in
   *  onSubmit) and reloads — otherwise the override was silently lost and
   *  the respawn fell back to the agent config (typically sonnet), giving
   *  the illusion of a downgrade on resume. */
  const modelOverrideKey = `timon:model-override:${agentId}`;
  const [pendingModelOverride, setPendingModelOverrideState] = useState<string | null>(null);
  const setPendingModelOverride = useCallback((m: string | null) => {
    setPendingModelOverrideState(m);
    if (typeof window === 'undefined') return;
    if (m) machineScopedStorage(window.localStorage).setItem(modelOverrideKey, m);
    else machineScopedStorage(window.localStorage).removeItem(modelOverrideKey);
  }, [modelOverrideKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // Null too: the view switching to another agent must not carry the
    // previous agent's override into its next spawn.
    setPendingModelOverrideState(machineScopedStorage(window.localStorage).getItem(modelOverrideKey));
  }, [modelOverrideKey]);
  /** Per-mission backend override (twin of pendingModelOverride): lets the
   *  next mission launch on an OTHER backend (e.g. GPT-5.5) than the one
   *  configured on the agent, without touching its config — hence running
   *  Opus and GPT-5.5 in parallel on the same agent (one multichat slot
   *  each). */
  const backendOverrideKey = `timon:backend-override:${agentId}`;
  const [pendingBackendOverride, setPendingBackendOverrideState] = useState<string | null>(null);
  const [pendingReasoningEffort, setPendingReasoningEffort] = useState<string | null>(null);
  const setPendingBackendOverride = useCallback((b: string | null) => {
    setPendingBackendOverrideState(b);
    if (typeof window === 'undefined') return;
    if (b) machineScopedStorage(window.localStorage).setItem(backendOverrideKey, b);
    else machineScopedStorage(window.localStorage).removeItem(backendOverrideKey);
  }, [backendOverrideKey]);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setPendingBackendOverrideState(machineScopedStorage(window.localStorage).getItem(backendOverrideKey));
  }, [backendOverrideKey]);
  /**
   * LLM of the CURRENTLY open mission — the two overrides as they are in
   * the DB (`null` = the mission follows the agent's config).
   *
   * Distinct from `liveStats.model`, which carries the full id OBSERVED in
   * the CLI's `system:init` (`claude-opus-4-8`): here we keep the ALIAS,
   * i.e. the value that will go back into the next turn's `--model`. This
   * is therefore what the composer's selector pre-selects, and what must
   * move as soon as the switch happens — a turn later `system:init` will
   * confirm the full id.
   *
   * `pendingBackendOverride`/`pendingModelOverride` are the twins from
   * BEFORE the 1st send (mission not yet created); these apply to an
   * existing mission.
   */
  const [missionBackend, setMissionBackend] = useState<string | null>(null);
  const [missionModel, setMissionModel] = useState<string | null>(null);
  const [missionReasoningEffort, setMissionReasoningEffort] = useState<string | null>(null);
  // Keyed by mission: a fresh conversation, or one whose detail is still in
  // flight, must not wear the previous mission's owner.
  const [missionOwner, setMissionOwner] = useState<{ missionId: string; owner: MissionOwner | null } | null>(null);
  const shownOwner = missionOwner && missionOwner.missionId === currentMissionId ? missionOwner.owner : null;
  /** A POST /model is in flight: we freeze the selector to avoid stacking
   *  two contradictory requests on the same turn. */
  const [modelSwitching, setModelSwitching] = useState(false);
  /** The island panel open on a narrow chat: a column, or the missions list
   *  when no column holds it. Picking a mission or starting a new one closes
   *  it, otherwise it stays over the composer that was just emptied. */
  const [panneauOuvert, setPanneauOuvert] = useState<'left' | 'right' | 'missions' | null>(null);
  const fermerPanneau = useCallback(() => setPanneauOuvert(null), []);
  /** Images pasted from the clipboard (or attached via the paperclip).
   *  Stored as base64 + media type so they can be POSTed inline with the
   *  next user turn. `previewUrl` is a transient blob:// for the
   *  composer thumbnail row — revoked when the image is removed. */
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  /** Read by the add callbacks to know what the message already carries,
   *  without recreating them at every change. */
  const pendingImagesRef = useRef<PendingImage[]>([]);
  pendingImagesRef.current = pendingImages;
  /** Converts a list of File (images) into pendingImages entries. Used
   *  by both the desktop paste-from-clipboard and the mobile paperclip's
   *  file picker — without this, mobile had no way to attach an image,
   *  the file picker only triggered setAttached which sent nothing to the
   *  backend. Returns the bytes it added: the state is not re-rendered yet
   *  when `addAnyFiles` budgets the files that follow. */
  const addImages = useCallback(async (files: File[]): Promise<number> => {
    const imgs = files.filter((f) => f.type.startsWith('image/'));
    if (imgs.length === 0) return 0;
    const additions: PendingImage[] = [];
    const before = turnAttachmentBytes(pendingImagesRef.current, pendingFilesRef.current);
    let used = before;
    let overBudget = 0;
    for (const file of imgs) {
      try {
        // Compressed first: the caps apply to what is sent, and a 12 MB
        // phone photo comes out at a few hundred KB (TIM-0125).
        const { blob, mediaType } = await compressForChat(file);
        if (blob.size > MAX_IMAGE_UPLOAD_BYTES) {
          toast.error(`image too large (${fmtBytes(blob.size)}, max 8 MB)`);
          continue;
        }
        if (used + blob.size > MAX_TURN_BYTES) {
          overBudget += 1;
          continue;
        }
        used += blob.size;
        const base64 = await fileToBase64(blob);
        additions.push({
          id: crypto.randomUUID(),
          mediaType,
          base64,
          previewUrl: URL.createObjectURL(blob),
          size: blob.size,
        });
      } catch (err) {
        toast.error('attach failed: ' + (err as Error).message);
      }
    }
    if (overBudget) toastOverBudget(overBudget);
    if (additions.length) setPendingImages((s) => [...s, ...additions]);
    return additions.reduce((sum, image) => sum + image.size, 0);
  }, []);
  const addImageFiles = useCallback(async (files: File[]) => { await addImages(files); }, [addImages]);
  /** Everything that is NOT an image: the model has no inline block for a
   *  PDF or a .pptx, so those travel as bytes the daemon writes to disk and
   *  the agent opens with its own tools. Same row also holds the long
   *  clipboard pastes pulled out of the input. */
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const pendingFilesRef = useRef<PendingFile[]>([]);
  pendingFilesRef.current = pendingFiles;
  /** Does the backend of the next turn take files other than images? Kept in a
   *  ref, refreshed once the backend is known below: a drop or a paste reaches
   *  `addAnyFiles` without passing the composer's disabled button. */
  const acceptsFilesRef = useRef(true);
  /** Splits a drop / a file picker between the two paths. No type is ever
   *  refused here — an unknown MIME is exactly the `application/octet-stream`
   *  a .pptx arrives as. */
  const addAnyFiles = useCallback(async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    const others = files.filter((f) => !f.type.startsWith('image/'));
    const imageBytes = images.length ? await addImages(images) : 0;
    if (others.length && !acceptsFilesRef.current) {
      toast.error(i18n('chatPage.attachImagesOnly'));
      return;
    }
    const sized = others.filter((file) => {
      if (file.size <= MAX_ATTACHMENT_BYTES) return true;
      toast.error(`${file.name} — file too large (${fmtAttachmentSize(file.size)}, max ${fmtAttachmentSize(MAX_ATTACHMENT_BYTES)})`);
      return false;
    });
    const used = turnAttachmentBytes(pendingImagesRef.current, pendingFilesRef.current) + imageBytes;
    const { admitted, refused } = admitWithinTurnBudget(used, sized);
    if (refused.length) toastOverBudget(refused.length);
    const additions: PendingFile[] = [];
    for (const file of admitted) {
      try {
        additions.push({
          id: crypto.randomUUID(),
          kind: 'file',
          name: file.name,
          mediaType: file.type || 'application/octet-stream',
          base64: await fileToBase64(file),
          size: file.size,
        });
      } catch (err) {
        toast.error('attach failed: ' + (err as Error).message);
      }
    }
    if (additions.length) setPendingFiles((s) => [...s, ...additions]);
  }, [addImages]);
  /** A long paste leaves the input and becomes a "Pasted" chip — a thousand
   *  lines in the textarea hide the message the user is actually writing.
   *  Returns false when the paste is short enough to stay inline, and the
   *  browser's own paste must run. */
  const capturePastedText = useCallback((text: string): boolean => {
    if (text.length < PASTE_AS_FILE_CHARS) return false;
    setPendingFiles((s) => [...s, {
      id: crypto.randomUUID(),
      kind: 'pasted',
      name: 'Pasted',
      mediaType: 'text/plain',
      text,
      size: text.length,
    }]);
    return true;
  }, []);
  const [stats, setStats] = useState({ tok: 0, cost: 0 });
  // Status-line data, derived from system:init + result + rate_limit_event
  // payloads on the SSE stream. Kept in a separate state object so the
  // existing { tok, cost } header pill keeps its tight render path.
  const [liveStats, setLiveStats] = useState<LiveStats>({
    model: null,
    lastContextTokens: 0,
    contextWindows: {},
    totalIn: 0,
    totalOut: 0,
    rateLimits: {},
    extraUsage: null,
  });
  // Missions list for this agent — drives the left rail.
  const [missions, setMissions] = useState<MissionSummary[]>([]);
  // A title the daemon writes (generated at the end of a first turn, renamed
  // from another tab) lands in the rail at once, without waiting for the poll.
  useEffect(() => sseOn('mission_title_changed', (ev) => {
    const change = parseMissionTitleChange(String(ev.data));
    if (change) setMissions((prev) => applyMissionTitleChange(prev, change) as MissionSummary[]);
  }), []);
  useEffect(() => {
    if (forcedAgent || compact) return;
    const publish = () => window.dispatchEvent(new CustomEvent(BROWSER_PANEL_CONTEXT, { detail: { agent: agentId, missionId: currentMissionId } }));
    publish();
    window.addEventListener(BROWSER_PANEL_CONTEXT_QUERY, publish);
    return () => {
      window.removeEventListener(BROWSER_PANEL_CONTEXT_QUERY, publish);
      // The browser follows this chat's conversation (TODO #481): leaving it says so.
      window.dispatchEvent(new CustomEvent(BROWSER_PANEL_CONTEXT, { detail: null }));
    };
  }, [agentId, currentMissionId, forcedAgent, compact]);

  // The callback is read from a ref: a host that redefines it on every
  // render (an inline lambda, the common case) must not restart the
  // effect.
  const onMissionChangeRef = useRef(onMissionChange);
  onMissionChangeRef.current = onMissionChange;
  const onConversationShownRef = useRef(onConversationShown);
  onConversationShownRef.current = onConversationShown;
  const keepInViewRef = useRef(keepInView);
  keepInViewRef.current = keepInView;
  useEffect(() => {
    onMissionChangeRef.current?.(currentMissionId);
  }, [currentMissionId]);

  /**
   * Applies a reasoning level, mission running or not.
   *
   * Two doors lead here — the composer bar's menu and the LLM modal — and
   * they must write to the same place: during a mission it's a server-side
   * switch (the next turn will read it), before the first send it's just
   * an override kept for the upcoming spawn.
   */
  const applyReasoningEffort = useCallback(async (effort: string | null): Promise<void> => {
    if (!currentMissionId) {
      setPendingReasoningEffort(effort);
      return;
    }
    if (effort === missionReasoningEffort) return;
    const response = await fetch(
      `/api/ui/missions/${encodeURIComponent(currentMissionId)}/reasoning-effort`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ effort }),
      },
    );
    if (!response.ok) throw new Error('Could not change the reasoning level');
    setMissionReasoningEffort(effort);
  }, [currentMissionId, missionReasoningEffort]);
  /** Actual folder of the open mission when it differs from the agent's
   *  cwd (a task's worktree). Null = the mission runs in the agent's cwd.
   *  Used by the "terminal" button: on a task mission it's the worktree we
   *  want to open, not the main repo. */
  const [missionCwd, setMissionCwd] = useState<string | null>(null);
  // The agent's internal todo list (the same one Claude shows in its
  // terminal via TodoWrite / TaskCreate / TaskUpdate). Reconstructed from
  // the stream's tool_use and shown in the right panel so the user sees the
  // checked-off progress in real time.
  const [agentTodos, setAgentTodos] = useState<AgentTodo[]>([]);
  // Cached session_id of the current mission. Sent on POST /api/ui/missions
  // so a fresh spawn (after the previous claude died) resumes the right
  // session — not necessarily the agent's "latest" globally.
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  /** null = next send POSTs a brand-new mission with resume_session_id explicitly null */
  const freshStart = useRef(false);
  /** `contextPrefix` already joined to a turn: it belongs to the thread, not
   *  to each message. */
  const contextSent = useRef(false);

  /** request_id of a permission card we should scroll into view + highlight
   *  once the conversation is bound and rendered. Set when the user clicks
   *  a mission card flagged "action requise"; consumed (and cleared) by the
   *  effect that watches `messages` length below. */
  // A notification's link (`&highlight=<card id>`) is a deep-link too.
  const pendingDeepLinkPermId = useRef<string | null>(params.get('highlight'));
  const [highlightedPermId, setHighlightedPermId] = useState<string | null>(null);
  /** Bumped to re-run the deep-link effect on the mission already open. */
  const [deepLinkPoke, setDeepLinkPoke] = useState(0);

  const scrollRef = useRef<HTMLDivElement>(null);
  // Timestamp (perf.now()) until which the direction handler treats any
  // scroll event as programmatic and ignores it. Bumped every time we
  // assign scrollRef.current.scrollTop (initial load autoscroll, streamed
  // chunks during an agent reply, etc.).
  //
  // We previously used a single boolean flag, but rapid autoscrolls during
  // streaming sometimes outpaced the browser's scroll events: the flag was
  // cleared by the first event while a second 'real' scroll event from a
  // later assignment was still pending — that second event got treated as
  // a user gesture and flipped the header. A time window covers any number
  // of cascading scroll events from a burst of autoscrolls.
  const programmaticUntil = useRef(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const activeMissionId = useRef<string | null>(null);
  const activeStream = useRef<EventSource | null>(null);
  /** Last sign of life from the stream (open, event, delta): the watchdog
   *  measures the silence from here. */
  const lastStreamAt = useRef(0);
  /** Turns written while a one-shot backend (codex) was talking: it has
   *  no input channel before its turn ends. We keep them here and send
   *  them as soon as `turn_complete` / `mission_complete` fires, in the
   *  SAME mission — instead of losing them, or worse, opening a parallel
   *  thread. */
  const queuedTurns = useRef<Array<{ txt: string; imgs: PendingImage[]; files: PendingFile[]; reply?: ComposerReply | null }>>([]);
  /** The earlier message the next turn answers (Reply under a bubble). A ref
   *  beside the state: `send` and the queue read it without re-creating. */
  const [reply, setReplyState] = useState<ComposerReply | null>(null);
  const replyRef = useRef<ComposerReply | null>(null);
  const setReply = useCallback((next: ComposerReply | null) => {
    replyRef.current = next;
    setReplyState(next);
  }, []);
  const replyApi = useMemo(() => ({ reply, setReply }), [reply, setReply]);
  // The actions under the bubbles are occupants of a slot this chat declares.
  useEffect(() => mountMessageActionSlot(), []);
  // A reply belongs to the conversation it was armed in.
  useEffect(() => { setReply(null); }, [currentMissionId, setReply]);
  // dedup set for events we've already rendered (by `<type>@<timestamp>`).
  // Both replay (mount + SSE-on-connect) and live messages funnel through
  // ingest(), so we need a single source of truth to avoid double-render.
  const seenEvents = useRef<Set<string>>(new Set());

  /* ── Text currently being generated (SSE `event_delta`) ─────────────────
     Ephemeral fragments: never persisted on the orchestrator side, so
     never replayed. They ONLY feed the provisional bubble at the bottom of
     the thread, and are discarded as soon as the full `assistant` message
     arrives — that one is authoritative and enters `messages`. An
     un-flushed buffer would show the same text twice, which is worse than
     no streaming at all. */
  const [streamText, setStreamText] = useState('');
  const streamPresentation = useMemo(() => {
    let motionQuery: MediaQueryList | undefined;
    return createStreamPresentation(setStreamText, {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (id) => cancelAnimationFrame(id),
      now: () => performance.now(),
      reducedMotion: () => (motionQuery ??= window.matchMedia('(prefers-reduced-motion: reduce)')).matches,
    });
  }, []);
  const resetStream = useCallback(() => streamPresentation.reset(), [streamPresentation]);
  const pushStreamDelta = useCallback((text: string, mode: 'append' | 'replace') => {
    streamPresentation.push(text, mode);
  }, [streamPresentation]);
  useEffect(() => () => streamPresentation.dispose(), [streamPresentation]);

  // "Copy" buttons for code blocks and tool_use citations. These
  // buttons are born from a `dangerouslySetInnerHTML`: React doesn't
  // manage these nodes, so an onClick set on them would never fire. A
  // single native listener on the thread's container is enough — it
  // survives the markdown's re-render and costs nothing per block.
  // A link to a file outside the agent's folder waits for the user's yes.
  const [externalLink, setExternalLink] = useState<string | null>(null);
  const agentCwdRef = useRef<string | undefined>(undefined);
  agentCwdRef.current = agent.cwd;
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const onClick = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      const btn = target?.closest?.('.copy-btn') as HTMLElement | null;
      if (!btn) {
        // A link to a file the agent made points at the machine it runs on and
        // never works from a browser: open it in the Files viewer instead.
        const link = target?.closest?.('a[href]') as HTMLAnchorElement | null;
        const cwd = agentCwdRef.current;
        if (!link || !cwd || ev.button !== 0) return;
        const resolved = resolveFileLink(link.getAttribute('href') ?? '', [cwd]);
        if (!resolved) return;
        ev.preventDefault();
        if (resolved.kind === 'outside') setExternalLink(resolved.path);
        else void openAgentFile(agentId, resolved.path);
        return;
      }
      ev.preventDefault();
      // data-copy = text the DOM doesn't carry in plain form (truncated
      // citation). Otherwise we read the block's <code>: textContent gives
      // the exact code, stripped of hljs markup.
      const text =
        btn.dataset.copy ??
        btn.parentElement?.querySelector('pre > code')?.textContent ??
        '';
      if (!text) return;
      void copyToClipboard(text).then((ok) => {
        if (!ok) {
          toast.error(i18n('chatPage.copyFailed'));
          return;
        }
        btn.classList.add('copied');
        btn.setAttribute('title', i18n('chatPage.copied'));
        btn.setAttribute('aria-label', i18n('chatPage.copied'));
        if (btn.classList.contains('url-copy')) toast.success(i18n('chatPage.copied'));
        window.setTimeout(() => {
          btn.classList.remove('copied');
          const label = btn.dataset.copyLabel ?? i18n('chatPage.copy');
          btn.setAttribute('title', label);
          btn.setAttribute('aria-label', label);
        }, 1500);
      });
    };
    root.addEventListener('click', onClick);
    return () => root.removeEventListener('click', onClick);
  }, [agentId]);

  // load agent details
  useEffect(() => {
    let cancelled = false;
    // Switching to the agent of an opened mission: its bubbles must not wear
    // the previous agent's face while its details load. The project and cwd
    // stay, the rail and the file links keep working meanwhile.
    setAgent((prev) => (prev.name === agentId ? prev : {
      ...prev, name: agentId, role: null, emoji: null, color: null, icon_url: null, look: null, avatar: null,
    }));
    (async () => {
      try {
        const r = await fetchAgentDetails(agentId);
        if (r.ok && !cancelled) {
          const a = await r.json();
          if (cancelled) return;
          setAgent({
            name: a.name || agentId,
            backend: a.backend,
            model: a.model,
            role: a.role ?? null,
            kind: a.kind || 'live',
            status: a.status || 'idle',
            project: a.project ?? null,
            cwd: a.cwd ?? undefined,
            skills: a.skills ?? [],
            mcp_servers: a.mcp_servers ?? [],
            excluded_mcp_servers: a.excluded_mcp_servers ?? [],
            emoji: a.emoji ?? null,
            color: a.color ?? null,
            icon_url: a.icon_url ?? null,
            look: a.look ?? null,
            avatar: a.avatar ?? null,
          });
        }
      } catch {
        /* fallback to defaults */
      } finally {
        agentReadyRef.current = true;
        setAgentSettled(true);
      }
    })();
    return () => { cancelled = true; };
  }, [agentId]);

  // Status line and gauges wait for the conversation (`lib/load-priority.ts`).
  // The composer's branch no longer lives here: it reads the shared Git store
  // (`lib/git-store.ts`), the same one as the Git panels (TODO #278).
  const afterConversation = useAfterConversation();

  // Exact ACCOUNT quota consumption (the orchestrator caches the upstream
  // call for 60s, so a 30s poll here costs nothing). Merged into the
  // rateLimits map so the status line shows a real percentage rather than
  // `rate_limit_event`'s coarse status.
  //
  // Queried FOR THE CURRENT BACKEND, and only if it knows how to report
  // usage: without this, we'd show the Anthropic account's consumption
  // even on a mission served by another backend — a wrong figure,
  // indistinguishable from a real one. A backend with no probe → no
  // gauge, not a zeroed gauge. Same exclusivity as `effBackend` below
  // (mission open → its override, otherwise the pending choice):
  // otherwise the gauge would query the quota of a backend this thread
  // doesn't use.
  const usageBackend = asBackend(
    currentMissionId
      ? (missionBackend ?? agent.backend)
      : (pendingBackendOverride ?? agent.backend),
  );
  const usageSupported = hasAccountUsage(backendCatalog, usageBackend);
  useEffect(() => {
    // A backend switch must never leave the previous account's gauges
    // visible during the first poll (or indefinitely if unsupported).
    setLiveStats((s) => ({ ...s, rateLimits: {}, extraUsage: null, accountUsage: undefined }));
    if (!usageSupported || !afterConversation) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    let poll = true;
    async function refresh() {
      try {
        const r = await fetch(
          `/api/ui/usage?backend=${encodeURIComponent(usageBackend)}`,
          { cache: 'no-store' },
        );
        const body: unknown = await r.json().catch(() => null);
        if (cancelled) return;
        const view = interpretUsageResponse(r.status, body);
        if (!usageShouldKeepPolling(view)) {
          poll = false;
          if (timer) { clearInterval(timer); timer = null; }
          setLiveStats((s) => ({ ...s, accountUsage: view }));
          return;
        }
        if (view.kind === 'error') {
          setLiveStats((s) => ({ ...s, accountUsage: view }));
          return;
        }
        if (view.kind !== 'ok') return;
        const rec = body as {
          windows?: Record<string, { utilization: number; resets_at: string } | null>;
          extra?: {
            is_enabled: boolean;
            utilization: number;
            used_credits: number;
            monthly_limit: number;
            currency?: string;
          } | null;
        };
        const j = {
          five_hour: rec.windows?.five_hour ?? null,
          seven_day: rec.windows?.seven_day ?? null,
          monthly: rec.windows?.monthly ?? null,
          extra_usage: rec.extra ?? null,
        };
        setLiveStats((s) => {
          const merge = (
            cur: RateLimitInfo | undefined,
            src: { utilization: number; resets_at: string } | null,
          ): RateLimitInfo | undefined => {
            if (!src) return cur;
            // Existing rateLimits.resetsAt is encoded in seconds (the
            // status line multiplies by 1000 before formatting). The
            // OAuth endpoint returns ISO-8601 — convert to seconds.
            const ms = Date.parse(src.resets_at);
            const resetsAt = Number.isFinite(ms)
              ? Math.floor(ms / 1000)
              : cur?.resetsAt ?? 0;
            return {
              status: cur?.status ?? 'allowed',
              resetsAt,
              isUsingOverage: cur?.isUsingOverage,
              utilization: src.utilization,
            };
          };
          return {
            ...s,
            accountUsage: undefined,
            rateLimits: {
              ...s.rateLimits,
              five_hour: merge(s.rateLimits.five_hour, j.five_hour),
              seven_day: merge(s.rateLimits.seven_day, j.seven_day),
              monthly: merge(s.rateLimits.monthly, j.monthly),
            },
            extraUsage: j.extra_usage
              ? {
                  isEnabled: j.extra_usage.is_enabled,
                  utilization: j.extra_usage.utilization,
                  usedCredits: j.extra_usage.used_credits,
                  monthlyLimit: j.extra_usage.monthly_limit,
                  currency: j.extra_usage.currency ?? 'USD',
                }
              : null,
          };
        });
      } catch {
        if (!cancelled) {
          setLiveStats((s) => ({
            ...s,
            accountUsage: { kind: 'error', message: i18n('cockpit.accountUsage.error') },
          }));
        }
      }
    }
    void refresh().then(() => {
      if (cancelled || !poll) return;
      timer = setInterval(() => { void refresh(); }, 30_000);
    });
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [usageBackend, usageSupported, afterConversation]);

  // Available skills + MCP servers for the side-panel pickers.
  const [allSkills, setAllSkills] = useState<SkillItem[]>([]);
  const [allMcp, setAllMcp] = useState<McpItem[]>([]);

  // ── Composer slash autocomplete ─────────────────────────────────────
  // Purely visual aid while typing: ZERO execution here. The popup opens
  // as long as the message is a "bare" slash (`/partial`, no space). The
  // actual expansion/execution happens on the orchestrator side ON SEND.
  const [slashSel, setSlashSel] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  /** Caret position, reported by the composer on every input and selection
   *  change. The popup used to key off the whole input matching `^/xxx$`,
   *  which is why it never opened mid-sentence. */
  const [caret, setCaret] = useState(0);
  /** The `/token` the caret sits in, wherever it is in the message: opening
   *  the menu is a typing aid, so it only needs a slash that starts a word.
   *  `start` is that slash's index — `acceptSlash` splices over exactly that
   *  span instead of replacing the whole sentence. */
  const slashHere = useMemo(() => slashSpanAt(input, caret), [input, caret]);
  const slashQuery = slashHere?.query ?? null;
  const slashSuggestions = useMemo(() => {
    if (slashQuery === null) return [] as SkillItem[];
    // The project's own skills come first: they are what one reaches for
    // inside a project, and the shared ones are the fallback.
    const rank: Record<SkillSource, number> = { project: 0, timon: 1, 'claude-user': 2, plugin: 3 };
    return allSkills
      .filter((s) => !s.shadowed
        && (s.id.toLowerCase().includes(slashQuery)
          || (s.title || '').toLowerCase().includes(slashQuery)))
      .sort((a, b) => (rank[a.source] - rank[b.source]) || a.id.localeCompare(b.id))
      .slice(0, 8);
  }, [slashQuery, allSkills]);
  const slashOpen = slashQuery !== null && !slashDismissed && slashSuggestions.length > 0;
  // Resets the selection when the list changes; re-arms the popup when
  // leaving the bare-slash state (send, space, deletion).
  useEffect(() => { setSlashSel(0); }, [slashQuery]);
  useEffect(() => { if (slashQuery === null) setSlashDismissed(false); }, [slashQuery]);
  const acceptSlash = useCallback((id: string) => {
    const here = slashHere;
    if (!here) return;
    const { text: next, caret: at } = applySlash(input, caret, here, id);
    setInput(next);
    setCaret(at);
    setSlashDismissed(true);
    // The caret goes back where the insertion ended, not at the end of the
    // message: picking a skill mid-sentence must leave the rest of it alone.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (ta) { ta.focus(); ta.setSelectionRange(at, at); }
    });
  }, [slashHere, caret, input]);
  // Robust Escape: a CAPTURE-phase listener intercepts Escape before any
  // parent (drawer/Radix which would otherwise close instead of the
  // popup) and stops its propagation. The textarea's onKeyDown handler
  // isn't enough when an ancestor captures the key upstream.
  useEffect(() => {
    if (!slashOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setSlashDismissed(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [slashOpen]);
  // Compact-and-fork dialog. Opened from the status line "Compact"
  // button once the context window crosses 40 %.
  /** LLM picker modal. A single state for both uses: choosing the LLM of
   *  a conversation that hasn't started, or changing that of an ongoing
   *  thread — the modal adapts its actions based on `currentMissionId`. */
  const [llmOpen, setLlmOpen] = useState(false);
  // A compaction started from this page ends: a fork goes on in its new
  // conversation, a native one says it is done, a failure is said — the bar
  // never just stops.
  useCompactSettled(currentMissionId, ({ operation, local }: CompactSettled) => {
    if (!local) return;
    if (operation.phase === 'error') {
      toast.error(i18n('compact.failed', { error: operation.error || i18n('compact.unknownError') }));
    } else if (operation.mode === 'fork' && operation.targetMissionId) {
      toast.success(operation.model
        ? i18n('compact.forkedOn', { model: operation.model })
        : i18n('compact.doneFork'));
      openChat(chatHref(agentId, operation.targetMissionId), router);
    } else {
      toast.success(i18n('compact.doneNative'));
    }
  });
  /** Live handover, from the click to a couple of seconds after the daemon
   *  answers. Held here rather than in the menu: the drop-up closes on
   *  confirmation, and what the user must watch outlives it. */
  const [llmProgress, setLlmProgress] = useState<LlmSwitchProgress | null>(null);
  const llmProgressTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (llmProgressTimer.current) window.clearTimeout(llmProgressTimer.current);
  }, []);
  // "New mission" modal: backend+model picker + option to continue from
  // the previous mission with a fallback summary for the new LLM.
  // Triggered by the dedicated button in the topbar.
  // One-shot nudge when the context window crosses 80 %. We track the
  // last percentage we acted on so the toast doesn't re-fire on every
  // tick once we're above the threshold — only on the actual transition
  // 79 → 80. Reset back below 70 % so a follow-up turn after compaction
  // can trigger again on its own crossing.
  const lastCtxNudgePct = useRef<number>(0);
  // Mobile-only header collapse: once the user scrolls the message list
  // past ~24px we hide the global TopBar so only the agent identity bar
  // (rendered inside the central column) stays in view. Reclaims roughly
  // two rows of vertical real estate on a phone. Desktop ignores this
  // flag (see TopBar.collapsed handling).
  const [headerCollapsed, setHeaderCollapsed] = useState(false);
  // The page's chrome (top bar, islands) when `ChatRoute` hosts it outside this
  // conversation's key: it then outlives a switch, and this one paints its body only.
  const pageChrome = useChatChrome();
  const chrome = compact || inIsland ? null : pageChrome;
  useLayoutEffect(() => {
    if (!chrome) return;
    chrome.setCollapsed(headerCollapsed);
  }, [chrome, headerCollapsed]);
  const browserPanelOpen = useBrowserPanelOpen();
  const { dragging: widgetDragging, editing: layoutEditing, widgetsOf } = useWidgetHost();
  const appearance = useChatAppearance();
  // Physical order and collapse of the two columns. Collapsing a column is the
  // most useful gesture with the browser side panel open: with three columns
  // the chat no longer has the width of a real thread. Persisted by the daemon
  // (`ui_layout`, a scope of its own) rather than in this browser: a collapse
  // that undoes itself on reload, or does not follow from one machine to the
  // next, is useless.
  const {
    colonnes,
    inverser: inverserColonnes,
    basculer: basculerColonne,
    ajouterOnglet: ajouterOngletColonne,
    choisirOnglet: choisirOngletColonne,
    fermerOnglet: fermerOngletColonne,
    poserLargeur: poserLargeurColonne,
    poserLargeurs: poserLargeursColonnes,
    poserFil,
    ajouterSeconde: ajouterSecondeColonne,
    retirerSeconde: retirerSecondeColonne,
  } = useChatColumns();
  // Lock during the header's CSS transition (max-h + opacity). Without
  // this lock, the reflow triggered by the collapse generates its own
  // 'scroll' events on the container (iOS Safari especially) that flip
  // the state the other way → a feedback loop visible as a flicker, no
  // matter the threshold. As long as we haven't passed this window, we
  // ignore the events. Same pattern as `programmaticUntil` for
  // autoscrolls.
  const headerTransitionUntil = useRef(0);
  /** Last position read and distance scrolled up in a row since the last
   *  direction reversal — cf. `REVEAL_TRAVEL` in the effect below. */
  const lastScrollTop = useRef(0);
  const upTravel = useRef(0);
  /**
   * Whether the thread should follow new turns.
   *
   * Measured while the user scrolls, not when a message arrives: by the time
   * the effect below runs, the DOM already holds the new turn, so the distance
   * to the bottom is the height of what just came in — a long answer would
   * look like "the user went away" and a short one like "the user is here".
   * The answer has to be taken BEFORE the thread grows.
   *
   * Starts true: a freshly opened conversation opens at its end.
   */
  const stickToBottom = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Geographic hysteresis TO HIDE, directional TO REVEAL. Position
    // alone wasn't enough: scrolling up in the middle of a long thread
    // only brought the header back once reaching the very top, while the
    // scroll-up gesture IS the request to see it again. So we reveal it
    // as soon as `REVEAL_TRAVEL` px have been scrolled up cumulatively in
    // the same direction.
    //
    // The cumulative value is what replaces the last delta's direction,
    // too noisy on mobile (rubber-banding, late reflow after collapse): a
    // few-pixel jitter alternates sign and resets on every reversal, it
    // never reaches the threshold. The transition lock below remains the
    // second belt.
    const COLLAPSE_AT = 120; // dropped below this limit, the header comes back
    const EXPAND_AT = 24;    // back above this, we reveal it
    const REVEAL_TRAVEL = 28; // px scrolled up in a row to recall the header
    const TRANSITION_LOCK_MS = 280; // > duration-200 + safety margin
    const onScroll = () => {
      const top = el.scrollTop;
      const now = performance.now();
      // A measurement, not a decision: it is taken even during the windows
      // the header logic below ignores. A programmatic autoscroll lands at
      // the bottom, which is exactly what this must then record.
      stickToBottom.current = el.scrollHeight - top - el.clientHeight <= FOLLOW_SLACK;
      // Programmatic autoscroll window: we touch nothing (the agent just
      // scrolled, it's not the user).
      if (now < programmaticUntil.current) return;
      // CSS transition window: we let the DOM settle before listening
      // again. This is the fix that removes the flicker for good.
      if (now < headerTransitionUntil.current) return;
      const delta = top - lastScrollTop.current;
      lastScrollTop.current = top;
      // Cumulative per direction: any reversal starts back from zero.
      upTravel.current = delta < 0 ? upTravel.current - delta : 0;
      const pulledUp = upTravel.current >= REVEAL_TRAVEL;
      setHeaderCollapsed((prev) => {
        if (prev && (top <= EXPAND_AT || pulledUp)) {
          headerTransitionUntil.current = now + TRANSITION_LOCK_MS;
          upTravel.current = 0;
          return false;
        }
        if (!prev && top >= COLLAPSE_AT && delta > 0) {
          headerTransitionUntil.current = now + TRANSITION_LOCK_MS;
          return true;
        }
        return prev;
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
    return () => el.removeEventListener('scroll', onScroll);
  }, []);
  // The thread is not the only thing that scrolls on this page: the other
  // islands of the workspace (a terminal, files, a second chat) and the rails
  // scroll too. Taking over the header (`collapsed`) switched off the TopBar's
  // own catch-all listener, so without this a phone scrolling any of them kept
  // the menu bar in view. Same state and same lock as the thread, so the two
  // inputs never fight over the header.
  const headerCollapsedRef = useRef(false);
  headerCollapsedRef.current = headerCollapsed;
  useEffect(() => {
    if (compact || inIsland) return;
    const mq = window.matchMedia('(max-width: 767px)');
    const perEl = new WeakMap<HTMLElement, { lastY: number; upTravel: number }>();
    const onScroll = (e: Event) => {
      if (!mq.matches) return;
      const target = e.target;
      // The thread has its own handler above (autoscroll window included).
      if (!(target instanceof HTMLElement) || target === scrollRef.current) return;
      // A drawer, a dialog or a menu scrolls on its own: that says nothing about the page.
      if (target.closest('[data-header-scroll="ignore"], [role="dialog"], [role="menu"], [role="listbox"]')) return;
      const mine = perEl.get(target) ?? { lastY: target.scrollTop, upTravel: 0 };
      const next = nextHeaderScrollState(
        { hidden: headerCollapsedRef.current, lockUntil: headerTransitionUntil.current, ...mine },
        { y: target.scrollTop, range: target.scrollHeight - target.clientHeight, now: performance.now() },
      );
      perEl.set(target, { lastY: next.lastY, upTravel: next.upTravel });
      headerTransitionUntil.current = next.lockUntil;
      if (next.hidden !== headerCollapsedRef.current) {
        // The thread's reveal travel restarts after any flip, from whichever input.
        upTravel.current = 0;
        setHeaderCollapsed(next.hidden);
      }
    };
    document.addEventListener('scroll', onScroll, true);
    return () => document.removeEventListener('scroll', onScroll, true);
  }, [compact, inIsland]);
  /**
   * EFFECTIVE backend + model for the next turn.
   *
   * A single derivation for all consumers (composer button, context
   * gauge, 80% nudge): this guarantees that a model switch moves them ALL
   * TOGETHER. The trap already experienced was a consumer recomputing its
   * limit on its own and staying stuck on the old model.
   *
   * The two sources are EXCLUSIVE, never chained:
   *   - mission open → its override, otherwise the agent's config;
   *   - no mission yet → the pending choice, otherwise the config.
   *
   * Chaining them was a bug: `pending*` is persisted in localStorage PER
   * AGENT, so an LLM chosen in one conversation leaked into every other
   * conversation of the same agent as soon as they had no override of
   * their own. We'd read "kimi-k2.7-code" on a thread that was actually
   * running on Opus — the most dangerous display possible, since you
   * think you know who you're talking to.
   */
  const effBackend = asBackend(
    currentMissionId
      ? (missionBackend ?? agent.backend)
      : (pendingBackendOverride ?? agent.backend),
  );
  const acceptsFiles = capabilitiesFor(backendCatalog, effBackend).attachments;
  acceptsFilesRef.current = acceptsFiles;
  providerNameRef.current = backendLabel(backendCatalog, effBackend);
  const effModel =
    (currentMissionId ? missionModel : pendingModelOverride)
    ?? agent.model
    ?? defaultModelFor(backendCatalog, effBackend);

  /** Switches the LLM of the current mission. The returned status says
   *  when the change takes effect — immediate on a persistent process,
   *  next turn on a one-shot backend. */
  const switchMissionModel = useCallback(async (model: string) => {
    const mid = currentMissionId;
    if (!mid || !model) return;
    setModelSwitching(true);
    // Optimistic: the selector and gauge follow immediately. The
    // `model_switch` event arriving via SSE rewrites the same value
    // (no-op), and an HTTP failure rewinds it below.
    const previous = missionModel;
    setMissionModel(model);
    try {
      const r = await fetch(`/api/ui/missions/${encodeURIComponent(mid)}/model`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMissionModel(previous);
        toast.error(i18n('chatPage.modelChangeDenied'), {
          description: apiErrorMessage(j, { status: r.status }),
        });
        return;
      }
      toast.success(i18n('chatPage.modelLabel', { model }), {
        description: switchEffectLabel(j?.status as ModelSwitchStatus, j?.reason),
      });
    } catch {
      setMissionModel(previous);
      toast.error(i18n('chatPage.modelChangeFailed'), {
        description: i18n('chatPage.orchestratorNoResponse'),
      });
    } finally {
      setModelSwitching(false);
    }
  }, [currentMissionId, missionModel]);

  /**
   * Switches the mission to ANOTHER backend, without a fork or a new
   * mission.
   *
   * The thread doesn't move: same missionId, same agent. The orchestrator
   * kills the current CLI and relaunches another, seeded with the
   * conversation's context — full transcript below the threshold, a
   * summary above it. The one case where the user MUST be warned is
   * exactly that one (`compacted`): it's the only one where information
   * may have been lost.
   */
  const switchMissionBackend = useCallback(async (
    backend: string,
    model: string,
    // How the context crosses. The user chose it on the confirmation panel;
    // `auto` leaves the daemon's configured threshold to arbitrate, which is
    // what every non-interactive caller wants.
    contextMode: SwitchContextChoice = 'auto',
  ) => {
    const mid = currentMissionId;
    if (!mid || !backend) return;
    setModelSwitching(true);
    const prevBackend = missionBackend;
    const prevModel = missionModel;
    // Optimistic, like for the model: the selector and gauge follow
    // immediately, the SSE `backend_switch` event rewrites the same
    // values.
    setMissionBackend(backend);
    if (model) setMissionModel(model);
    // The banner opens BEFORE the request: the round trip is where the
    // whole cost of a handover sits (rendering the transcript, and possibly
    // a summary produced by a CLI we have to wait for).
    if (llmProgressTimer.current) window.clearTimeout(llmProgressTimer.current);
    setLlmProgress({
      from: { backend: prevBackend ?? '', model: prevModel },
      to: { backend, model: model || null },
      state: 'running',
      requested: contextMode,
    });
    try {
      const r = await fetch(`/api/ui/missions/${encodeURIComponent(mid)}/backend`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ backend, model: model || undefined, context_mode: contextMode }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        setMissionBackend(prevBackend);
        setMissionModel(prevModel);
        setLlmProgress(null);
        toast.error(
          r.status === 409
            ? i18n('chatPage.turnInProgress')
            // 413 = the whole thread was demanded and the target CLI cannot
            // swallow it. The daemon refuses rather than compacting behind
            // our back, so the user still has the choice — say which one.
            : r.status === 413
              ? i18n('llm.confirmTooLarge')
              : i18n('chatPage.backendChangeDenied'),
          { description: apiErrorMessage(j, { status: r.status }) },
        );
        return;
      }
      // Answered: the banner stops sweeping and says how the context
      // actually crossed — the one thing the user was waiting to learn.
      setLlmProgress({
        from: { backend: prevBackend ?? '', model: prevModel },
        to: { backend, model: model || null },
        state: 'done',
        contextMode: j?.contextMode === 'transcript' || j?.contextMode === 'summary'
          || j?.contextMode === 'tail'
          ? j.contextMode
          : 'none',
      });
      llmProgressTimer.current = window.setTimeout(() => setLlmProgress(null), 6000);
      toast.success(`${backend}${model ? ' · ' + model : ''}`, {
        description: j?.compacted
          ? i18n('chatPage.contextCompacted')
          : j?.contextMode === 'transcript'
            ? i18n('chatPage.fullTranscriptResent')
            : i18n('chatPage.newSessionContinues'),
      });
    } catch {
      setMissionBackend(prevBackend);
      setMissionModel(prevModel);
      setLlmProgress(null);
      toast.error(i18n('chatPage.backendChangeFailed'), {
        description: i18n('chatPage.orchestratorNoResponse'),
      });
    } finally {
      setModelSwitching(false);
    }
  }, [currentMissionId, missionBackend, missionModel]);

  /**
   * Applies a backend+model pair chosen in the composer's drop-up. One
   * gesture, two consequences depending on where we are: during a mission
   * the live thread switches, before it the pair is only remembered as a
   * per-mission override (the agent's own config is never touched).
   */
  const applyLlm = useCallback(async (
    backend: string,
    model: string,
    contextMode: SwitchContextChoice = 'auto',
  ): Promise<void> => {
    if (currentMissionId) {
      if (backend === effBackend) await switchMissionModel(model);
      else await switchMissionBackend(backend, model, contextMode);
      return;
    }
    // Override reset to null when the choice falls back to the agent's
    // default: no unnecessary per-mission pollution.
    const agentBackend = asBackend(agent.backend);
    setPendingBackendOverride(backend === agentBackend ? null : backend);
    setPendingModelOverride(model && model !== agent.model ? model : null);
  }, [currentMissionId, effBackend, switchMissionModel, switchMissionBackend, agent.backend, agent.model]);

  // Context-usage nudge: once the live mission crosses 80 % of the model's
  // window, fire a one-shot toast that opens the compact dialog. The 40 %
  // chip is always there, but the user told us they miss it; this is the
  // assertive nudge. Re-armed once usage drops back under 70 % (after a
  // compaction or a short follow-up that doesn't re-bloat).
  useEffect(() => {
    if (!currentMissionId) return;
    const ctxUsed = liveStats.lastContextTokens;
    if (!ctxUsed) return;
    const configured = contextLimitFor(
      backendCatalog, effBackend, effModel, liveStats.model, liveStats.contextWindows,
    );
    // Unknown window → no percentage makes sense: we don't nudge rather
    // than cry wolf over a made-up denominator.
    if (!configured) return;
    const ctxLimit = ctxUsed > configured ? nextStandardLimit(ctxUsed) : configured;
    const ctxPct = Math.min(100, (ctxUsed / ctxLimit) * 100);
    if (ctxPct >= 80 && lastCtxNudgePct.current < 80) {
      lastCtxNudgePct.current = ctxPct;
      const missionId = currentMissionId;
      toast.warning(i18n('compact.nudgeTitle', { pct: Math.round(ctxPct) }), {
        description: i18n('compact.nudgeBody'),
        duration: 12000,
        // The same one click as the gauge: same LLM, progress on the ring.
        action: {
          label: i18n('compact.nudgeAction'),
          onClick: () => {
            void compactStore.start(missionId).then((r) => {
              if (!r.ok) toast.error(r.failure);
            });
          },
        },
      });
    } else if (ctxPct < 70) {
      lastCtxNudgePct.current = ctxPct;
    }
  }, [liveStats.lastContextTokens, liveStats.model, liveStats.contextWindows, backendCatalog, effBackend, effModel, currentMissionId]);
  useEffect(() => {
    // Waits for the agent: its cwd changes the answer, and reading once
    // without it then once with it doubled both requests on every opening.
    if (!agentSettled) return;
    // agent's cwd → the API adds its project's skills/commands.
    const qs = agent.cwd ? `?cwd=${encodeURIComponent(agent.cwd)}` : '';
    (async () => {
      try {
        const [sr, mr] = await Promise.all([
          sharedGet(`/api/ui/skills${qs}`).then((r) =>
            r.ok ? r.json() : { skills: [] },
          ),
          sharedGet('/api/ui/mcp').then((r) =>
            r.ok ? r.json() : { servers: [] },
          ),
        ]);
        setAllSkills(sr.skills || []);
        setAllMcp(mr.servers || []);
      } catch { /* empty */ }
    })();
  }, [agent.cwd, agentSettled]);

  async function patchAgentConfig(patch: {
    skills?: string[];
    mcp_servers?: string[];
    excluded_mcp_servers?: string[];
  }) {
    // Optimistic update so the chip flips immediately; rollback on failure.
    const prev = agent;
    setAgent((a) => ({ ...a, ...patch }));
    try {
      const r = await fetch(`/api/ui/agents/${encodeURIComponent(agentId)}/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error('save failed: ' + (apiErrorMessage(j, r.statusText)));
        setAgent(prev);
      } else {
        const j = await r.json().catch(() => ({}));
        if (j._killed > 0) {
          toast.success('config saved · agent will respawn at next message');
        }
      }
    } catch (e) {
      toast.error('save failed: ' + String((e as Error).message || e));
      setAgent(prev);
    }
  }

  const toggleSkill = useCallback((id: string) => {
    // Only TIMON skills are attachable: config.json:skills is only
    // resolved from within ~/.timon at spawn time. Project skills are
    // loaded natively by Claude Code only (Codex never reads .claude/skills),
    // and nothing can attach them; ~/.claude ones never reach a mission (its
    // Claude config dir is the account's) and must be imported first.
    const entry = allSkills.find((s) => s.id === id);
    if (entry && entry.source !== 'timon') {
      toast.info(entry.source === 'project'
        ? i18n('chatPage.skillAlreadyNative')
        : i18n('skillMission.notAttachable', { brand: BRAND.displayName }));
      return;
    }
    const cur = new Set(agent.skills || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    patchAgentConfig({ skills: [...cur] });
    // patchAgentConfig is local to the component (closes over setAgent
    // etc.) — pulling it into useCallback would just chain the same
    // dependency problem, so we accept the stale-closure risk and
    // explicitly re-create when agent.skills changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.skills, allSkills]);
  const toggleMcp = useCallback((id: string) => {
    const item = allMcp.find((m) => m.id === id);
    const isExternal = item?.source === 'claude_ai' || item?.transport_type === 'external';
    if (isExternal) {
      const ex = new Set(agent.excluded_mcp_servers || []);
      if (ex.has(id)) ex.delete(id); else ex.add(id);
      patchAgentConfig({ excluded_mcp_servers: [...ex] });
    } else {
      const cur = new Set(agent.mcp_servers || []);
      if (cur.has(id)) cur.delete(id); else cur.add(id);
      patchAgentConfig({ mcp_servers: [...cur] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.mcp_servers, agent.excluded_mcp_servers, allMcp]);

  useEffect(() => {
    return () => {
      activeStream.current?.close();
    };
  }, []);

  /** Pulls missions for the current project (all agents) or falls back to
   *  the current agent only when the agent has no project configured. */
  /** Sequence number of the rail's fetches. Three effects (bind, refetch
   *  on project change, 10s poll) fire concurrent requests with different
   *  scopes (`agent=` while the project is unknown, then `project=`).
   *  Without a guard, the agent-only response sent BEFORE the project
   *  resolves can come back AFTER the project response and overwrite it:
   *  the rail then stayed on the sole missions of the open business
   *  agent until the next poll tick, 5 to 10s away. So we only apply the
   *  response of the LATEST request sent. */
  const missionsReqSeq = useRef(0);
  /** True once a project-wide response has been applied: a later
   *  agent-only response must never shrink the rail. */
  const missionsProjectScoped = useRef(false);

  const refreshMissions = useCallback(async (): Promise<MissionSummary[]> => {
    // A config loaded with `project: null` designates a cross-cutting
    // agent. Never infer a fake project from its name: `alice.doc` would
    // become "alice", hiding its missions as soon as we return from the
    // editor. Before the config loads, listing the agent alone is also the
    // safest fallback: it allows rebinding its latest mission right away.
    const projectSlug = agent.project ?? null;
    const seq = ++missionsReqSeq.current;
    try {
      // 300 and not 100: an active project quickly exceeds a hundred
      // missions (globex has 337), and the recency sort then made the
      // missions of high-volume roles vanish from the rail —
      // coder/merger/reviewer drowned the older ones. This wasn't a
      // per-role filter, it was a truncation.
      // With no project, filter server-side via `agent` (not a global
      // fetch + client filter): a global fetch pulls the 300 most recent
      // missions across ALL AGENTS, and a chatty project (e.g. nimbus with
      // its coder/merger/reviewer) fills the whole window — the missions
      // of a lightly-active cross-cutting agent (e.g. alice.main) don't
      // even show up to be filtered anymore, they disappear from the
      // rail.
      const qs = new URLSearchParams({ limit: '300' });
      if (projectSlug) qs.set('project', projectSlug);
      else qs.set('agent', agentId);
      // Shared while in flight: the bind, the poll and the project switch
      // all ask at the same instant on mount.
      const r = await sharedGet('/api/ui/missions?' + qs);
      if (!r.ok) return [];
      const j = await r.json();
      const list: MissionSummary[] = j.missions || [];
      // Pure recency sort: the mission whose last message (any event) is the
      // most recent floats to the top, regardless of agent, role or whether
      // it's a Kanban task or a direct chat. No pinning.
      list.sort((a, b) => {
        const ta = a.last_event_at ?? a.started_at;
        const tb = b.last_event_at ?? b.started_at;
        return tb - ta;
      });
      // The visible rail should only show this agent-only list if it's
      // the best info we'll have: while the config fetch is in flight, the
      // real project arrives shortly and will replace this list with the
      // full rail — showing it in the meantime just flashes (small
      // project-only rail → large project rail) with no benefit. The bind
      // fallback (below, on the return value) stays immediate though:
      // rebinding this agent's latest mission doesn't depend on knowing
      // its project.
      const fresh = seq === missionsReqSeq.current;
      const shrinks = !projectSlug && missionsProjectScoped.current;
      if ((projectSlug || agentReadyRef.current) && fresh && !shrinks) {
        if (projectSlug) missionsProjectScoped.current = true;
        setMissions(list);
      }
      return list;
    } catch {
      return [];
    }
  }, [agentId, agent.project]);

  const refreshMissionsRef = useRef(refreshMissions);
  refreshMissionsRef.current = refreshMissions;
  /** True while `bindMission` replays a mission's history through `ingest`. */
  const replaying = useRef(false);

  // Switching agent resets the rail: the new agent may be cross-cutting
  // (no project), in which case the project scope inherited from the
  // previous agent must not block its list from displaying.
  useEffect(() => {
    missionsProjectScoped.current = false;
  }, [agentId]);

  const killMission = useCallback(async (id: string) => {
    const r = await fetch('/api/ui/missions/' + encodeURIComponent(id), { method: 'DELETE' });
    if (!r.ok) { toast.error('Kill failed: ' + r.status); return; }
    await refreshMissions();
    // If we killed the current mission, clear the view.
    if (activeMissionId.current === id) newConversation();
    forgetChatMission(id);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshMissions]);

  /** Writes the conversation on screen into the URL (`?agent=&mission=`), so a
   *  reload lands on it instead of on the agent's latest one, under the agent
   *  that owns it. Only the page-level chat owns the address bar: embedded
   *  chats (forced agent/mission, compact) leave it alone. Called once the
   *  mission is bound, never before, so the `missionParam` effect sees an
   *  already-active mission and does not rebind. A mission of another agent
   *  also tells the router (`pinnedChatHistoryState`): `ChatRoute` then
   *  re-keys on that agent, as a link to the mission would have. In a split
   *  view, the page's panel keeps it instead (`keepInView`, TIM-0140). */
  function pinMissionInUrl(id: string, owner: string | null) {
    onConversationShownRef.current?.(id, owner || hostAgentId);
    if (forcedAgent || forcedMission || compact) return;
    const kept = !!owner && keepInViewRef.current?.(id, owner) === true;
    const pin = chatPin(new URL(window.location.href), id, owner, kept, window.history.state);
    if (pin) window.history.replaceState(pin.state, '', pin.href);
  }

  /** The state of every commit, for the cache of recent conversations. */
  useLayoutEffect(() => {
    committedChat.current = {
      missionId: activeMissionId.current,
      seenSize: seenEvents.current.size,
      state: {
        messages, stats, liveStats, agentTodos, missionBackend, missionModel, missionCwd,
        missionReasoningEffort, missionOwner, missionAgent, currentSessionId,
      },
    };
  });

  /** Leaves the conversation on screen in the cache of recent ones
   *  (`lib/chat-mission-cache.ts`), as last committed. Called before the view
   *  moves to another conversation, and on unmount. */
  function cacheShownMission() {
    const shown = committedChat.current;
    const id = activeMissionId.current;
    if (!shown || !id || shown.missionId !== id || lastEventId.current === null) return;
    putCachedChatMission<ChatCacheState>(id, {
      lastEventId: lastEventId.current,
      bytes: cacheBytes.current,
      state: {
        ...shown.state,
        historyCursor: historyCursor.current,
        turnSeq: turnSeq.current,
        retryLine: retryLineRef.current,
        lastHumanText: lastHumanText.current,
        seen: [...seenEvents.current].slice(0, shown.seenSize),
      },
    }, { epoch: cacheEpoch.current });
  }
  useEffect(() => () => cacheShownMission(),
  // Refs only: the first render's function reads the latest values.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  []);

  /** The mission's own settings the detail carries, current on every read
   *  (the backend and model are not: they replay from the journal). */
  function applyMissionDetail(missionId: string, detail: Record<string, unknown>): string | null {
    const owner = missionOwnerAgent(detail);
    setMissionAgent(owner);
    setMissionCwd(typeof detail.cwd_override === 'string' && detail.cwd_override ? detail.cwd_override : null);
    setMissionReasoningEffort(typeof detail.reasoning_effort === 'string' ? detail.reasoning_effort : null);
    setMissionOwner({ missionId, owner: parseMissionOwner(detail.owner) });
    return owner;
  }

  /** Replays journal rows as history: no rail refresh per row, the last
   *  `init` gives the session `--resume` will aim at. */
  function replayHistory(events: readonly HistoryEvent[]) {
    replaying.current = true;
    try {
      for (const ev of events) {
        // Track the session_id (last init event wins) so subsequent spawns
        // resume THIS mission's session rather than the agent's global latest.
        const init = ev.payload as { subtype?: unknown; session_id?: unknown } | null;
        if (ev.type === 'system' && init?.subtype === 'init' && typeof init.session_id === 'string' && init.session_id) {
          setCurrentSessionId(init.session_id);
        }
        ingest(ev.payload, { type: ev.type, timestamp: ev.timestamp, id: eventIdOf(ev) });
      }
    } finally {
      replaying.current = false;
    }
  }

  /** Paints a cached conversation as it was left, before any request. */
  function restoreCachedMission(state: ChatCacheState) {
    setMessages(state.messages);
    setStats(state.stats);
    setLiveStats((s) => ({ ...state.liveStats, accountUsage: s.accountUsage }));
    setAgentTodos(state.agentTodos);
    setMissionBackend(state.missionBackend);
    setMissionModel(state.missionModel);
    setMissionCwd(state.missionCwd);
    setMissionReasoningEffort(state.missionReasoningEffort);
    setMissionOwner(state.missionOwner);
    setMissionAgent(state.missionAgent);
    setCurrentSessionId(state.currentSessionId);
    historyCursor.current = state.historyCursor;
    setHasOlderHistory(state.historyCursor.hasMore);
    turnSeq.current = state.turnSeq;
    retryLineRef.current = state.retryLine;
    lastHumanText.current = state.lastHumanText;
    seenEvents.current = new Set(state.seen);
  }

  /**
   * Reset the conversation view and bind to a specific mission. A mission in
   * the cache of recent conversations (`lib/chat-mission-cache.ts`) is painted
   * from it at once, then catches up with the rows added since
   * (`?after=`, docs/CHAT-MISSION-CACHE.md). Otherwise: fetch the last page of
   * its log with the prelude that stands in for the rows before it
   * (docs/MISSION-HISTORY-PAGES.md), replay both through ingest() (so dedup
   * keys are populated). Either way, then attach the live SSE stream if the
   * mission is still running. Used both on mount and when the user clicks a
   * different mission in the rail.
   */
  const bindMission = useCallback(
    async (missionId: string): Promise<boolean> => {
      cacheShownMission();
      cacheEpoch.current = chatCacheEpoch();
      const mine = ++bindGeneration.current;
      const clearView = () => {
        activeStream.current?.close();
        activeStream.current = null;
        activeMissionId.current = null;
        queuedTurns.current = [];
        liveThread.current = null;
        gptLiveStopRef.current();
        seenEvents.current = new Set();
        turnSeq.current = 0;
        setMessages([]);
        setThreadAnchor(null);
        historyCursor.current = NO_HISTORY;
        lastEventId.current = null;
        cacheBytes.current = 0;
        setHasOlderHistory(false);
        setAgentTodos([]);
        // Another conversation opens at its end, whatever was being read in the
        // one being left.
        stickToBottom.current = true;
        setStats({ tok: 0, cost: 0 });
        setLiveStats({ model: null, lastContextTokens: 0, contextWindows: {}, totalIn: 0, totalOut: 0, rateLimits: {}, extraUsage: null });
        setThinking(false);
        setMissionBackend(null);
        setMissionModel(null);
        setMissionCwd(null);
        setMissionReasoningEffort(null);
        setCurrentMissionId(missionId);
      };
      clearView();
      const timer = startChatBind(missionId);
      /** Ends a bind: what is shown is this mission, live if it runs. */
      const settle = (detail: Record<string, unknown>, owner: string | null) => {
        // Restore the 'thinking' bubble if the mission is mid-turn, or about to
        // be. Without this, navigating away then back made the agent look
        // stopped even though it was still working, and a message sent then met
        // a 409. Both come from the orchestrator's in-memory turn state —
        // authoritative.
        const preparing = detail.turn_preparing === true;
        setThinking(Boolean(detail.turn_active) || preparing);
        activeMissionId.current = missionId;
        pinMissionInUrl(missionId, owner);
        freshStart.current = false;
        // A summary runs with no process registered yet: `running` is still
        // false, and the turn it leads to only reaches a stream already open.
        if (detail.running || preparing) openStream(missionId);
      };
      const cached = getCachedChatMission<ChatCacheState>(missionId);
      if (cached) {
        restoreCachedMission(cached.state);
        lastEventId.current = cached.lastEventId;
        cacheBytes.current = cached.bytes;
        timer.phase('cache');
        timer.painted(() => bindGeneration.current === mine);
        try {
          const r = await fetch(historyDeltaUrl(missionId, cached.lastEventId), { cache: 'no-store' });
          if (bindGeneration.current !== mine) return false;
          if (r.status === 404) {
            // Deleted, or no longer visible to this account.
            forgetChatMission(missionId);
            clearView();
            return false;
          }
          if (r.ok) {
            const body = await r.text();
            if (bindGeneration.current !== mine) return false;
            const detail = JSON.parse(body) as Record<string, unknown>;
            const delta = parseHistoryDelta(detail);
            if (!delta.reset) {
              const owner = applyMissionDetail(missionId, detail);
              replayHistory(parseHistoryEvents(detail.events));
              lastEventId.current = delta.newestId ?? cached.lastEventId;
              cacheBytes.current += body.length;
              timer.delta();
              settle(detail, owner);
              return true;
            }
          }
        } catch {
          if (bindGeneration.current !== mine) return false;
        }
        // Too much happened since, or the daemon cannot say: the tail page,
        // the cached conversation staying on screen until it is in.
        forgetChatMission(missionId);
      }
      try {
        // A chat switch read it already, while the previous conversation
        // was still on screen (`chat-mission-preload.ts`).
        const r = await (
          takePreloadedChatMission(missionId)
          ?? fetch(missionDetailUrl(missionId), { cache: 'no-store' })
        );
        timer.phase('request');
        if (bindGeneration.current !== mine) return false;
        if (!r.ok) {
          if (cached) clearView();
          return false;
        }
        const body = await r.text();
        const detail = JSON.parse(body);
        timer.phase('json');
        if (bindGeneration.current !== mine) return false;
        if (cached) clearView();
        cacheBytes.current += body.length;
        const owner = applyMissionDetail(missionId, detail);
        // LLM overrides of THIS mission, before replaying the events: the
        // replay contains past `model_switch` events, which must be able
        // to overwrite this initial value in chronological order.
        setMissionBackend(
          typeof detail.backend_override === 'string' ? detail.backend_override : null,
        );
        setMissionModel(
          typeof detail.model_override === 'string' ? detail.model_override : null,
        );
        // The state the rows before the page would have built, set before
        // the page replays on top of it, as the full replay would have.
        const prelude = parseHistoryPrelude(detail.prelude);
        if (prelude) {
          setMissionBackend(prelude.backend);
          setMissionModel(prelude.model);
          if (prelude.sessionId) setCurrentSessionId(prelude.sessionId);
          if (prelude.lastHumanText) lastHumanText.current = prelude.lastHumanText;
          setStats(prelude.stats);
          setLiveStats((s) => ({
            ...s,
            model: prelude.observedModel,
            lastContextTokens: prelude.lastContextTokens,
            contextWindows: contextWindowsWithShortKeys(prelude.contextWindows, shortModelSlug),
            totalIn: prelude.totals.in,
            totalOut: prelude.totals.out,
          }));
          setAgentTodos(prelude.todoToolUses.reduce<AgentTodo[]>(
            (list, use) => applyTodoToolUse(list, use.name, use.input, use.id) ?? list, [],
          ));
        }
        const pageEvents = parseHistoryEvents(detail.events);
        historyCursor.current = cursorAfterPage(detail, pageEvents);
        lastEventId.current = newestEventId(pageEvents);
        setHasOlderHistory(historyCursor.current.hasMore);
        replayHistory([...(prelude?.events ?? []), ...pageEvents]);
        timer.phase('replay');
        settle(detail, owner);
        timer.painted(() => activeMissionId.current === missionId);
        return true;
      } catch {
        /* best-effort */
        if (cached && bindGeneration.current === mine) clearView();
        return false;
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  /**
   * Clear everything and arm "fresh start": the next user message POSTs to
   * /api/ui/missions with resume_session_id: null so the orchestrator skips
   * --resume and claude spawns a virgin session.
   */
  // useCallback so the rail context keeps a stable reference and the cards
  // that read it skip re-renders on every keystroke.
  const newConversation = useCallback(() => {
    cacheShownMission();
    cacheEpoch.current = chatCacheEpoch();
    // A bind still in flight would otherwise land over the blank conversation.
    bindGeneration.current += 1;
    activeStream.current?.close();
    activeStream.current = null;
    activeMissionId.current = null;
    // Pending turns belonged to the conversation we're leaving: keeping
    // them would send them into the next mission, out of their context.
    queuedTurns.current = [];
    liveThread.current = null;
    gptLiveStopRef.current();
    seenEvents.current = new Set();
    turnSeq.current = 0;
    resetStream();
    setMessages([]);
    setThreadAnchor(null);
    historyCursor.current = NO_HISTORY;
    lastEventId.current = null;
    cacheBytes.current = 0;
    setHasOlderHistory(false);
    setAgentTodos([]);
    setStats({ tok: 0, cost: 0 });
    setLiveStats({ model: null, lastContextTokens: 0, contextWindows: {}, totalIn: 0, totalOut: 0, rateLimits: {}, extraUsage: null });
    setThinking(false);
    setThinkingHint(null);
    setMissionBackend(null);
    setMissionModel(null);
    setMissionCwd(null);
    setCurrentMissionId(null);
    setMissionAgent(null);
    setCurrentSessionId(null);
    freshStart.current = true;
    taRef.current?.focus();
  }, [resetStream]);

  // On mount (and whenever the agent or pinned mission changes), load the
  // mission list and bind either the URL-pinned mission or the most recent /
  // running one. Exception: when initialFresh is true and there is no explicit
  // mission param, skip auto-bind and arm freshStart so the next send spawns a
  // new mission.
  // missionParam is in deps so that clicking a topbar chip for the *same*
  // agent but a *different* mission (URL: ?agent=X&mission=Y → ?agent=X&mission=Z)
  // still triggers a rebind — previously agentId didn't change so the effect
  // was skipped and the view stayed on the old conversation.
  useEffect(() => {
    if (initialFresh && !missionParam) {
      setMissionAgent(null);
      freshStart.current = true;
      markConversationShown();
      void refreshMissions(); // populate the sidebar list without binding
      return;
    }
    // Already showing the requested mission — just refresh the sidebar list,
    // no need to rebind and re-replay the full event log.
    if (missionParam && activeMissionId.current === missionParam) {
      void refreshMissions();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await bindInitialMission();
      } finally {
        // Bound, empty or failed: the side panels may start either way.
        markConversationShown();
      }
    })();
    async function bindInitialMission() {
      // The URL already names the conversation: ask for it now, in parallel
      // with the rail, instead of after the list (it is the one thing the
      // page is opened for). The list only matters if that id is unknown.
      if (missionParam) {
        void refreshMissions();
        if (await bindMission(missionParam)) return;
        if (cancelled) return;
      }
      // No mission named: the daemon picks the agent's latest one in a light
      // lookup, so the conversation no longer waits for the 300-row rail,
      // which fills beside it. The URL's id, when unknown, still goes through
      // the list below.
      if (!missionParam && hostAgentId) {
        const latest = await fetchLatestMission(hostAgentId);
        if (cancelled) return;
        if (latest !== undefined) {
          void refreshMissions();
          if (latest) await bindMission(latest.id);
          else {
            setMissionAgent(null);
            freshStart.current = true;
          }
          return;
        }
      }
      const list = await refreshMissions();
      if (cancelled) return;
      if (!list.length) return;
      const requested = missionParam && list.find((m) => m.id === missionParam);
      // The setup conversation is over once the wizard ends: the cockpit card
      // and the chat page start fresh instead of reopening it.
      const candidates = list.filter((m) => m.source_channel !== 'setup');
      const fallback = candidates.find((m) => m.running) ?? candidates[0];
      const target = requested ?? fallback;
      if (target) await bindMission(target.id);
      else {
        setMissionAgent(null);
        freshStart.current = true;
      }
    }
    return () => {
      cancelled = true;
    };
    // The host agent, not the view's: the view switching to the agent of the
    // mission it just bound must not bind again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostAgentId, missionParam]);

  // Deep-link consumer: once a permission card matching the pending target
  // is in the DOM, scroll it into view and pulse it briefly so the user can
  // spot the form without scanning the conversation manually. Watches both
  // messages (replay finished → card mounted) and currentMissionId (mission
  // switch may rebind a different target).
  useEffect(() => {
    const target = pendingDeepLinkPermId.current;
    if (!target) return;
    // A card older than the mounted window has no node to scroll to yet:
    // widen the window first, this effect runs again once it is mounted.
    const index = messages.findIndex((m) => m.perm?.request_id === target || m.cmd?.id === target || m.proposal?.id === target || m.secretRequest?.id === target);
    // Older than the loaded history: read back until it is in, page by page
    // (each page lands in `messages`, which runs this effect again).
    if (index < 0 && hasOlderHistory) {
      void loadOlderHistory();
      return;
    }
    const reveal = anchorRevealing(messages, threadStart, index);
    if (reveal) { setThreadAnchor(reveal); return; }
    // Two RAFs: first lets React commit the new <PermissionCard>, the second
    // ensures layout is stable before measuring scroll position.
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        const el = document.querySelector(
          `[data-perm-id="${CSS.escape(target)}"]`,
        ) as HTMLElement | null;
        if (!el) return;
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setHighlightedPermId(target);
        pendingDeepLinkPermId.current = null;
        window.setTimeout(() => setHighlightedPermId(null), 1500);
      });
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // `loadOlderHistory` is stable (no deps) and declared further down.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, currentMissionId, threadStart, deepLinkPoke, hasOlderHistory]);

  // Keep the rail current from the global stream (a mission started, a turn
  // began or ended — `railFrameMatters`), with a slow poll behind it; the
  // 10 s poll it replaces ran in every mounted chat, each read holding the
  // daemon's thread. Also call immediately whenever the resolver changes —
  // crucially when agent.project arrives: the mount effect ran with the agent
  // alone, and without this re-run the rail stayed scoped to the opened agent
  // instead of becoming project-wide. List-only: no rebind.
  const railRowsRef = useRef(missions);
  railRowsRef.current = missions;
  useEffect(() => {
    void refreshMissions();
    let pending: ReturnType<typeof setTimeout> | null = null;
    const soon = () => {
      if (pending !== null) return;
      pending = setTimeout(() => {
        pending = null;
        void refreshMissions();
      }, RAIL_REFRESH_DEBOUNCE_MS);
    };
    const offs = RAIL_FRAMES.map((kind) => sseOn(kind, (ev) => {
      if (railFrameMatters(kind, String(ev.data), railRowsRef.current)) soon();
    }));
    const id = setInterval(refreshMissions, RAIL_FALLBACK_POLL_MS);
    return () => {
      for (const off of offs) off();
      clearInterval(id);
      if (pending !== null) clearTimeout(pending);
    };
  }, [refreshMissions]);

  // autoscroll
  useEffect(() => {
    queueMicrotask(() => {
      // Reading back up the thread is a decision, and an arriving turn must
      // not overrule it. Unconditional until now: going up to re-read an
      // answer threw you back down the moment the agent said anything, which
      // during a long turn is every few seconds.
      if (!stickToBottom.current) return;
      if (scrollRef.current) {
        // Push the 'ignore scroll events' window 250 ms into the future.
        // Streaming an agent reply triggers this effect on every chunk;
        // a window is more robust than a one-shot flag because the
        // browser may coalesce or delay scroll events relative to the
        // scrollTop assignments that produced them.
        programmaticUntil.current = performance.now() + 250;
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });
  }, [messages, thinking]);

  // A block that changes height on its own (a document resizing itself) does
  // not go through the autoscroll above: ADR-MCPUI D10, `chat-scroll-anchor.ts`.
  const blockResize = useMemo<BlockResizeHandler>(() => ({
    snapshot: () => scrollRef.current?.scrollTop ?? null,
    resized: (block, delta, interacting, before) => {
      const root = scrollRef.current;
      if (!root) return;
      const adjustment = scrollOnBlockResize({
        interacting,
        stickToBottom: stickToBottom.current,
        blockTop: block.getBoundingClientRect().top,
        viewportTop: root.getBoundingClientRect().top,
        delta,
        nativeShift: before === null ? 0 : root.scrollTop - before,
      });
      if (adjustment.kind === 'none') return;
      programmaticUntil.current = performance.now() + 250;
      if (adjustment.kind === 'bottom') root.scrollTop = root.scrollHeight;
      else root.scrollTop += adjustment.by;
    },
  }), []);

  // What the conversation lends its documents (ADR-MCPUI D6, D11): whether a
  // card waits for the user — the full screen gives way to it — and the
  // owner's own route to send a message a document proposed, with the
  // composer's queue when the agent is mid-turn. Documents themselves are not
  // counted: a pending one is precisely what may be shown in full screen.
  const awaitingUser = useMemo(() => messages.some(isPendingCard), [messages]);
  const activityRef = useRef(onAgentActivity);
  activityRef.current = onAgentActivity;
  useEffect(() => {
    activityRef.current?.({ busy: thinking, tool: thinking ? thinkingHint : null, awaitingUser });
  }, [thinking, thinkingHint, awaitingUser]);
  // The latest `openStream`: the callback below lives across renders.
  const openStreamLatest = useRef(openStream);
  openStreamLatest.current = openStream;
  const sendAsOwner = useCallback(async (missionId: string, text: string): Promise<'sent' | 'queued' | 'failed'> => {
    const mid = activeMissionId.current;
    if (!mid || mid !== missionId) return 'failed';
    const queue = (notice: string): 'queued' => {
      queuedTurns.current = [...queuedTurns.current, { txt: text, imgs: [], files: [] }];
      setMessages((m) => [...m, { id: crypto.randomUUID(), role: 'notice', t: nowTime(), content: '', notice }]);
      return 'queued';
    };
    try {
      const res = await fetch('/api/ui/missions/' + mid + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text + '\n' }),
      });
      // The agent is still talking: out at the end of its turn, like a typed message.
      if (res.status === 409) return queue(i18n('chatPage.messageQueuedInline'));
      if (res.status === 429) return queue(quotaNotice(await res.json().catch(() => ({}) as Record<string, unknown>)));
      if (!res.ok) return 'failed';
      stickToBottom.current = true;
      if (streamIsClosed(activeStream.current)) openStreamLatest.current(mid);
      return 'sent';
    } catch {
      return 'failed';
    }
  }, []);
  const documentHost = useMemo<ChatDocumentHost>(() => ({ awaitingUser, sendAsOwner }), [awaitingUser, sendAsOwner]);

  // Older messages mount ABOVE what is being read: without this, the reader
  // keeps the same scrollTop and lands on the newly mounted page instead.
  // Layout effect, so the correction happens before the browser paints.
  useLayoutEffect(() => {
    const fromBottom = olderRestore.current;
    const el = scrollRef.current;
    if (fromBottom === null || !el) return;
    olderRestore.current = null;
    programmaticUntil.current = performance.now() + 250;
    el.scrollTop = el.scrollHeight - fromBottom;
    // `messages` too: an older page may land above a window that already
    // starts at its first message, leaving `threadStart` at 0.
  }, [threadStart, messages]);

  /**
   * Reads the pages before the loaded history (`before=`), builds their
   * messages apart from the conversation on screen, and puts them above it.
   * Several pages when the first ones hold too little to show (tool results
   * only), up to `OLDER_PAGES_MAX`. False when nothing was added.
   */
  const loadOlderHistory = useCallback(async (): Promise<boolean> => {
    const missionId = activeMissionId.current;
    const start = historyCursor.current;
    if (!missionId || loadingOlder.current || !start.hasMore || start.oldestId === null) return false;
    loadingOlder.current = true;
    setLoadingOlderHistory(true);
    try {
      let cursor = start;
      const events: HistoryEvent[] = [];
      const resolutions: HistoryEvent[] = [];
      let older: Msg[] = [];
      let seen = new Set<string>();
      for (let page = 0; page < OLDER_PAGES_MAX && cursor.hasMore && cursor.oldestId !== null; page++) {
        const r = await fetch(historyPageUrl(missionId, cursor.oldestId), { cache: 'no-store' });
        if (!r.ok) break;
        const text = await r.text();
        const body: unknown = JSON.parse(text);
        if (activeMissionId.current !== missionId) return false;
        cacheBytes.current += text.length;
        const pageEvents = parseHistoryEvents((body as { events?: unknown } | null)?.events);
        events.unshift(...pageEvents);
        resolutions.push(...parseHistoryEvents((body as { resolutions?: unknown } | null)?.resolutions));
        cursor = cursorAfterPage(body, pageEvents, cursor);
        ({ messages: older, seen } = buildOlderMessages([...events, ...resolutions]));
        if (older.length >= THREAD_WINDOW_STEP) break;
      }
      if (cursor === start) return false;
      for (const key of seen) seenEvents.current.add(key);
      historyCursor.current = cursor;
      setHasOlderHistory(cursor.hasMore);
      if (!older.length) return false;
      const el = scrollRef.current;
      if (el) olderRestore.current = el.scrollHeight - el.scrollTop;
      setMessages((current) => mergeOlderMessages(older, current));
      setThreadAnchor(older[Math.max(0, older.length - THREAD_WINDOW_STEP)]!.id);
      return true;
    } catch {
      return false;
    } finally {
      loadingOlder.current = false;
      setLoadingOlderHistory(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const showOlderMessages = useCallback(() => {
    // The mounted window is the whole loaded thread: the next page is on the daemon.
    if (threadStart === 0) {
      void loadOlderHistory();
      return;
    }
    const el = scrollRef.current;
    if (el) olderRestore.current = el.scrollHeight - el.scrollTop;
    const anchor = olderAnchor(messages, threadStart);
    if (anchor) setThreadAnchor(anchor);
  }, [messages, threadStart, loadOlderHistory]);

  // Autoscroll for the text currently being generated. CONDITIONAL,
  // unlike the messages one: the bubble grows every frame for several
  // minutes, so sticking the thread to the bottom unconditionally would
  // make reading back impossible — we only follow if the user is already
  // there.
  useEffect(() => {
    if (!streamText) return;
    const el = scrollRef.current;
    if (!el) return;
    const distanceToBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    // Wide margin: a streaming frame just added a few lines, we still
    // consider the user "at the bottom".
    if (distanceToBottom > FOLLOW_SLACK) return;
    programmaticUntil.current = performance.now() + 250;
    el.scrollTop = el.scrollHeight;
  }, [streamText]);

  const lastInputLen = useRef(0);
  function autoresize() {
    const t = taRef.current;
    if (!t) return;
    fitTextarea(t, COMPOSER_MAX_HEIGHT, input.length < lastInputLen.current);
    lastInputLen.current = input.length;
  }
  useEffect(autoresize, [input]);

  function fmtTimeAt(ms?: number) {
    if (!ms) return nowTime();
    return formatMsgTime(ms);
  }

  /**
   * Ingest one event payload. `meta.timestamp` and `meta.type` come from the
   * envelope and let us dedup replay vs. live frames. Tag-bearing user
   * messages can be marked via meta.tag so re-loaded missions keep their
   * mission/routine badge.
   */
  /** A live permission event moves the rail's badge; the same event replayed
   *  from history does not — a long mission replays dozens of them, and each
   *  used to send a list request as the conversation appeared. Through a ref:
   *  `bindMission` holds the first `ingest`, whose `refreshMissions` still
   *  lists the agent alone. */
  function refreshRailLive() {
    if (!replaying.current) void refreshMissionsRef.current();
  }

  /** Where `ingest` writes: the conversation's own state, or — while an older
   *  page is built (`buildOlderMessages`) — a detached copy of it. Every state
   *  `ingest` writes is listed here (docs/MISSION-HISTORY-PAGES.md § 1). */
  const liveIngest = {
    setMessages, setThinking, setThinkingHint, setLiveStats, setStats,
    setMissionModel, setMissionBackend, setAgentTodos,
    turnSeq, retryLineRef, lastHumanText, seenEvents,
  };
  type IngestTarget = typeof liveIngest;
  const ingestTarget = useRef<IngestTarget | null>(null);

  /** Messages of older journal rows, built the way a replay builds them but
   *  away from the conversation on screen: their own list, turn counter,
   *  retry line and dedup set. Nothing the newer page settled moves (stats,
   *  model, todos, thinking, the text Retry replays). */
  function buildOlderMessages(rows: readonly HistoryEvent[]): { messages: Msg[]; seen: Set<string> } {
    let built: Msg[] = [];
    const ignore = (): void => {};
    const detached: IngestTarget = {
      setMessages: (update) => { built = typeof update === 'function' ? update(built) : update; },
      setThinking: ignore, setThinkingHint: ignore, setLiveStats: ignore, setStats: ignore,
      setMissionModel: ignore, setMissionBackend: ignore, setAgentTodos: ignore,
      turnSeq: { current: 0 },
      retryLineRef: { current: null },
      lastHumanText: { current: null },
      seenEvents: { current: new Set<string>() },
    };
    const wasReplaying = replaying.current;
    replaying.current = true;
    ingestTarget.current = detached;
    try {
      for (const ev of rows) ingest(ev.payload, { type: ev.type, timestamp: ev.timestamp, id: eventIdOf(ev) });
    } finally {
      ingestTarget.current = null;
      replaying.current = wasReplaying;
    }
    return { messages: built, seen: detached.seenEvents.current };
  }

  function ingest(
    payload: any,
    meta: { type: string; timestamp: number; tag?: Msg['tag']; id?: number } = {
      type: '',
      timestamp: 0,
    },
  ) {
    if (!payload || typeof payload !== 'object') return;
    const {
      setMessages, setThinking, setThinkingHint, setLiveStats, setStats,
      setMissionModel, setMissionBackend, setAgentTodos,
      turnSeq, retryLineRef, lastHumanText, seenEvents,
    } = ingestTarget.current ?? liveIngest;
    /** Writes the line of the current retry series, or opens one. */
    function showRetryLine(line: RetryLine, timestamp: number) {
      const current = retryLineRef.current;
      const id = current && retryLineOpen(current.line) ? current.id : crypto.randomUUID();
      retryLineRef.current = { id, line };
      setMessages((m) => (m.some((msg) => msg.id === id)
        ? m.map((msg) => (msg.id === id ? { ...msg, retryLine: line } : msg))
        : [...m, { id, role: 'notice', t: fmtTimeAt(timestamp), content: '', retryLine: line }]));
    }
    /** The thread's last trace when it is still open, else null. */
    function openTraceOf(m: Msg[]): CompactionTraceView | null {
      const last = m[m.length - 1];
      return last && last.role === 'notice' && isOpenTrace(last.compaction) ? last.compaction : null;
    }
    /** `m` with a compaction row folded into the trace it belongs to, or a new one. */
    function foldCompactionInto(m: Msg[], patch: Partial<CompactionTraceView>, timestamp: number): Msg[] {
      const last = m[m.length - 1];
      const open = openTraceOf(m);
      if (last && open) return [...m.slice(0, -1), { ...last, compaction: foldTrace(open, patch) }];
      return [...m, { id: crypto.randomUUID(), role: 'notice', t: fmtTimeAt(timestamp), content: '', compaction: foldTrace(null, patch) }];
    }
    /** Folds a compaction row into the trace it belongs to, or opens one. */
    function foldCompaction(patch: Partial<CompactionTraceView>, timestamp: number) {
      setMessages((m) => foldCompactionInto(m, patch, timestamp));
    }
    const seenKey = meta.type && meta.timestamp ? `${meta.type}@${meta.timestamp}` : '';
    if (seenKey && seenEvents.current.has(seenKey)) return;
    if (seenKey) seenEvents.current.add(seenKey);

    // The daemon's outcome of a compaction (docs/MISSION-COMPACT.md): it
    // closes the trace the command opened, or stands alone after a fork.
    if (meta.type === 'compact' || payload.type === 'compact') {
      const patch = readCompactOutcome(payload);
      if (patch) {
        foldCompaction(patch, meta.timestamp);
        if (typeof patch.postTokens === 'number' && patch.postTokens > 0) {
          const post = patch.postTokens;
          setLiveStats((s) => ({ ...s, lastContextTokens: post }));
        }
      }
      return;
    }

    // Turn interrupted manually (STOP button → POST
    // /api/missions/:id/interrupt). The notice is essential: without it
    // the stream just stops dead, and a response truncated mid-sentence
    // becomes indistinguishable from a crash — even on replay, days
    // later.
    // A spoken GPT-Live turn, written by the journal route. Not a `user`
    // event: it opens no agent turn and raises no "thinking" indicator. The
    // live bubble already on screen carries the same id — keep it.
    if (meta.type === 'voice_transcript') {
      const p = payload as { role?: unknown; text?: unknown; client_id?: unknown; relay?: unknown };
      if ((p.role !== 'user' && p.role !== 'voice') || typeof p.text !== 'string' || !p.text.trim()) return;
      // GPT-Live reading out an agent answer the thread already shows.
      if (p.relay === true) return;
      const speaker: VoiceSpeaker = p.role;
      const id = typeof p.client_id === 'string' && p.client_id ? p.client_id : crypto.randomUUID();
      const content = voiceBubbleHtml(p.text);
      setMessages((m) => {
        if (m.some((msg) => msg.id === id)) return m.map((msg) => (msg.id === id ? { ...msg, content } : msg));
        return [...m, {
          id,
          role: speaker === 'user' ? 'user' : 'agent',
          voice: speaker,
          t: fmtTimeAt(meta.timestamp),
          content,
        }];
      });
      return;
    }
    // The provider retries on its own (TODO #459): the turn goes on, one line
    // says which attempt is in flight.
    if (meta.type === 'provider_retry' || payload.type === 'provider_retry') {
      showRetryLine(lineOnProviderRetry(retryLineRef.current?.line ?? null, payload, providerNameRef.current), meta.timestamp);
      setThinking(true);
      return;
    }
    // Timon's replay never ran: the turn ends on its failure.
    if (meta.type === 'turn_retry_abandoned' || payload.type === 'turn_retry_abandoned') {
      showRetryLine(lineOnAbandoned(retryLineRef.current?.line ?? null, payload, providerNameRef.current), meta.timestamp);
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      return;
    }
    if (meta.type === 'turn_interrupted') {
      const notice = turnInterruptedNotice(payload as TurnInterruptedPayload);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice,
        },
      ]);
      // A turn that ends here closes its bubble just like `result` does:
      // without the bump, the next one would keep writing into it.
      turnSeq.current += 1;
      // A steered turn is cut to go on at once: the agent is still at work.
      if ((payload as TurnInterruptedPayload).reason === 'steered') return;
      setThinking(false);
      setThinkingHint(null);
      return;
    }
    // The backend CLI never started (binary missing or not executable). This
    // is the ONLY event the mission will ever carry: without the notice the
    // thread stays empty, and the user has nothing at all to read.
    if (meta.type === 'spawn_failed') {
      const notice = spawnFailureNotice(payload as SpawnFailedPayload);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice,
        },
      ]);
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      return;
    }
    // The backend started, then ended its turn without a word (TIM-0049): say so, with what it wrote.
    if (meta.type === 'backend_failed') {
      const notice = backendFailureNotice(payload as BackendFailedPayload);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice,
        },
      ]);
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      return;
    }
    // A backend switch whose turn never started: the conversation stayed where
    // it was, and the thread says so instead of announcing a handover.
    if (meta.type === 'backend_switch_failed') {
      const notice = backendSwitchFailureNotice(payload as BackendSwitchFailedPayload);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice,
        },
      ]);
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      return;
    }
    // Model change mid-mission (POST /api/missions/:id/model). Persisted
    // trace: the thread must say from where the responses change model,
    // otherwise a shift in tone or quality becomes inexplicable on
    // replay.
    if (meta.type === 'model_switch') {
      const p = payload as {
        model?: string;
        previous_model?: string | null;
        status?: ModelSwitchStatus;
        reason?: string;
        backend?: string;
        cause?: 'fallback';
        cause_detail?: string;
      };
      if (!p.model) return;
      const from = p.previous_model ? `${p.previous_model} → ` : '';
      const label = i18n('chatPage.modelNotice', { from, model: p.model, effect: switchEffectLabel(p.status, p.reason) });
      // Rows persisted before the event named its backend leave it null:
      // the card then resolves the model by slug against the catalog, and
      // degrades to the raw slug rather than guessing a logo.
      const backend = p.backend ?? null;
      // Narrowed copy: the guard above does not survive the state closure.
      const model = p.model;
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice: label,
          handover: {
            kind: 'model',
            from: { backend, model: p.previous_model ?? null },
            to: { backend, model },
            status: p.status,
            reason: p.reason,
            ...(p.cause === 'fallback' ? { cause: 'fallback' as const, causeDetail: p.cause_detail } : {}),
          },
        },
      ]);
      // Whatever the status, it's now the alias that will go back into
      // `--model`: the selector and context gauge must reflect it right
      // away. History replay plays back these events in order, so the
      // last switch wins — consistent with model_override in the DB.
      setMissionModel(p.model);
      if (p.status === 'applied') {
        setLiveStats((s) => (s.model === p.model ? s : { ...s, model: p.model! }));
      }
      return;
    }
    // Backend switch mid-mission (POST /api/missions/:id/backend). Same
    // thread, same missionId: the notice is the ONLY visible trace that
    // the following responses come from another engine, restarted from a
    // fresh session. It also says how the context was transmitted — full
    // or compacted — because that determines whether something may have
    // been lost along the way.
    if (meta.type === 'backend_switch') {
      const p = payload as {
        backend?: string;
        previous_backend?: string;
        model?: string | null;
        previous_model?: string | null;
        context_mode?: HandoverContextMode;
        context_tokens?: number;
        reason?: string;
        cause?: 'fallback';
        cause_detail?: string;
      };
      if (!p.backend) return;
      // Narrowed copy: the guard above does not survive the state closure.
      const toBackend = p.backend;
      const from = p.previous_backend ? `${p.previous_backend} → ` : '';
      const target = p.model ? `${p.backend} · ${p.model}` : p.backend;
      const ctx =
        p.context_mode === 'transcript'
          ? i18n('chatPage.fullContextTransmitted', { tokens: Math.round((p.context_tokens ?? 0) / 1000) })
          : p.context_mode === 'summary'
            ? i18n('chatPage.contextCompactedSummary', { reason: p.reason ? ` — ${p.reason}` : '' })
            : p.context_mode === 'tail'
              ? i18n('chatPage.contextTailOnly', { reason: p.reason ? ` — ${p.reason}` : '' })
            : p.context_mode === 'pending'
              ? i18n('chatPage.handover.contextPending')
            : i18n('chatPage.noPriorContext');
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice: i18n('chatPage.backendNotice', { from, target, ctx }),
          handover: {
            kind: 'backend',
            from: { backend: p.previous_backend ?? null, model: p.previous_model ?? null },
            to: { backend: toBackend, model: p.model ?? null },
            reason: p.reason,
            context: { mode: p.context_mode ?? 'none', tokens: p.context_tokens ?? 0 },
            ...(p.cause === 'fallback' ? { cause: 'fallback' as const, causeDetail: p.cause_detail } : {}),
          },
        },
      ]);
      // Replay plays back these events in order: the last one wins,
      // consistent with backend_override/model_override in the DB.
      setMissionBackend(p.backend);
      if (p.model) setMissionModel(p.model);
      // The observed model belonged to the old engine: leaving it would
      // display a model that's no longer running, until the next
      // `system:init`.
      setLiveStats((s) => ({ ...s, model: p.model ?? null }));
      return;
    }
    // The native session was gone: the turn restarted on a fresh one, from what
    // the daemon recorded. What the agent now remembers depends on this mode,
    // and only this card says so.
    if (meta.type === 'context_recovery') {
      const p = payload as {
        backend?: string;
        model?: string | null;
        context_mode?: HandoverContextMode;
        context_tokens?: number;
      };
      const context = { mode: p.context_mode ?? 'none', tokens: p.context_tokens ?? 0 };
      const side = { backend: p.backend ?? null, model: p.model ?? null };
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice: recoveryLabel(context),
          handover: { kind: 'recovery', from: side, to: side, context },
        },
      ]);
      return;
    }
    // A backend that keeps no session: the agent got the next message alone, and
    // this line is all that tells why it forgot the turn before.
    if (meta.type === 'sessionless_turn') {
      const notice = sessionlessTurnNotice(payload as SessionlessTurnPayload);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice,
        },
      ]);
      return;
    }
    // Permission prompt: orchestrator emits these out-of-band when claude's
    // permission-prompt-tool MCP is invoked. We render a card with Allow/Deny.
    if (meta.type === 'permission_request') {
      const p = payload as { id?: string; tool_name?: string; input?: unknown; scopes?: unknown; approval_motif?: unknown; shell_command?: unknown; choices?: unknown; expires_at?: unknown };
      if (!p.id || !p.tool_name) return;
      const scopes = approvalScopesOf(p.scopes);
      const motif = scopes.length && typeof p.approval_motif === 'string' ? p.approval_motif : null;
      const shell = shellCardOf(p);
      setMessages((m) => {
        // Replay-safe: don't duplicate if we already have this card.
        if (m.some((x) => x.perm?.request_id === p.id)) return m;
        return [
          ...m,
          {
            id: 'perm:' + p.id,
            role: 'permission',
            t: fmtTimeAt(meta.timestamp),
            content: '',
            perm: {
              request_id: p.id!, tool_name: p.tool_name!, input: p.input, state: 'pending',
              ...(scopes.length ? { scopes } : {}),
              ...(motif ? { motif } : {}),
              ...(shell ?? {}),
              ...(typeof p.expires_at === 'number' ? { expires_at: p.expires_at } : {}),
            },
          },
        ];
      });
      // Sidebar badge reacts to pending_action_at exposed by the missions
      // listing. Trigger an extra refresh now so the badge appears within
      // the SSE round-trip instead of waiting up to 10s for the next poll.
      refreshRailLive();
      return;
    }
    if (meta.type === 'permission_resolved') {
      // A paste keeps `behavior: 'deny'` for older readers; `choice` says what was clicked.
      const p = payload as { id?: string; behavior?: 'allow' | 'deny'; choice?: string };
      if (!p.id) return;
      setMessages((m) =>
        m.map((x) => {
          if (!x.perm || x.perm.request_id !== p.id) return x;
          const state: PermissionState = p.choice === 'paste' ? 'pasted' : p.behavior === 'allow' ? 'allowed' : 'denied';
          return { ...x, perm: { ...x.perm, state } };
        }),
      );
      // Clear the "action requise" badge in the sidebar as soon as the
      // resolution lands (typically within a second of the user click).
      refreshRailLive();
      return;
    }
    // A command the agent asks the user to decide (`terminal_propose`). Persisted
    // with its outcome: a replay rebuilds the card in its final state.
    if (meta.type === COMMAND_REQUEST_EVENT) {
      const request = parseCommandRequest(payload);
      if (!request) return;
      setMessages((m) => {
        if (m.some((x) => x.cmd?.id === request.id)) return m;
        return [...m, { id: 'cmd:' + request.id, role: 'command', t: fmtTimeAt(meta.timestamp), content: '', cmd: request }];
      });
      refreshRailLive();
      return;
    }
    // A secret the agent asks the user for (`secret_request`). The events carry
    // the request and its outcome, never a value: a replay rebuilds the card.
    if (meta.type === SECRET_REQUEST_EVENT) {
      const request = parseSecretRequest(payload);
      if (!request) return;
      setMessages((m) => {
        if (m.some((x) => x.secretRequest?.id === request.id)) return m;
        return [...m, { id: 'secret:' + request.id, role: 'secret', t: fmtTimeAt(meta.timestamp), content: '', secretRequest: request }];
      });
      refreshRailLive();
      return;
    }
    if (meta.type === SECRET_REQUEST_RESOLVED_EVENT) {
      const resolution = parseSecretRequestResolution(payload);
      if (!resolution) return;
      setMessages((m) => m.map((x) => (x.secretRequest?.id === resolution.id ? { ...x, secretRequest: applySecretRequestResolution(x.secretRequest, resolution) } : x)));
      refreshRailLive();
      return;
    }
    // A screen arrangement the agent proposes (`widgets_propose`). Persisted with
    // its outcome, like a command request: a replay rebuilds the final card.
    // The main agent asks for its picture (`setup_request_avatar`): a card, answered once.
    if (meta.type === 'setup_avatar_request') {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') return;
      setMessages((m) => {
        if (m.some((x) => x.avatarRequest?.id === id)) return m;
        return [...m, { id: 'avatar:' + id, role: 'avatar', t: fmtTimeAt(meta.timestamp), content: '', avatarRequest: { id, state: 'pending' } }];
      });
      return;
    }
    if (meta.type === 'setup_avatar_answered') {
      const p = payload as { id?: unknown; status?: unknown } | null;
      if (typeof p?.id !== 'string') return;
      const state: SetupAvatarRequest['state'] = p.status === 'set' ? 'set' : 'skipped';
      setMessages((m) => m.map((x) => (x.avatarRequest?.id === p.id ? { ...x, avatarRequest: { id: p.id as string, state } } : x)));
      return;
    }
    // An HTML document shown in the conversation (`ui_render`). Its payload has
    // no `type`: matched on the envelope, before the `payload.type` branches.
    // Persisted with its outcome, so a replay rebuilds the card as it was left.
    if (meta.type === UI_DOCUMENT_EVENT) {
      const document = parseUiDocument(payload);
      if (!document) return;
      setMessages((m) => {
        if (m.some((x) => x.uiDocument?.id === document.id)) return m;
        return [...m, { id: 'uidoc:' + document.id, role: 'ui', t: fmtTimeAt(meta.timestamp), content: '', uiDocument: document }];
      });
      return;
    }
    // The agent resolved or dismissed an annotation of a posted batch: its card moves.
    if (meta.type === 'annotation_status') {
      const change = readAnnotationStatus(payload);
      if (!change) return;
      setMessages((m) => {
        let moved = false;
        const next = m.map((x) => {
          if (!x.annotations) return x;
          const card = applyAnnotationStatus(x.annotations, change);
          if (card === x.annotations) return x;
          moved = true;
          return { ...x, annotations: card };
        });
        return moved ? next : m;
      });
      return;
    }
    if (meta.type === UI_DOCUMENT_RESOLVED_EVENT) {
      const resolution = parseUiDocumentResolved(payload);
      if (!resolution) return;
      setMessages((m) => m.map((x) => (x.uiDocument?.id === resolution.id ? { ...x, uiDocument: applyUiDocumentResolution(x.uiDocument, resolution) } : x)));
      return;
    }
    if (meta.type === LAYOUT_PROPOSAL_EVENT) {
      const proposal = parseLayoutProposal(payload);
      if (!proposal) return;
      setMessages((m) => {
        if (m.some((x) => x.proposal?.id === proposal.id)) return m;
        return [...m, { id: 'layout:' + proposal.id, role: 'proposal', t: fmtTimeAt(meta.timestamp), content: '', proposal }];
      });
      return;
    }
    if (meta.type === LAYOUT_PROPOSAL_RESOLVED_EVENT) {
      const resolution = parseProposalResolution(payload);
      if (!resolution) return;
      setMessages((m) => m.map((x) => (x.proposal?.id === resolution.id ? { ...x, proposal: applyProposalResolution(x.proposal, resolution) } : x)));
      return;
    }
    if (meta.type === COMMAND_REQUEST_RESOLVED_EVENT) {
      const resolution = parseCommandResolution(payload);
      if (!resolution) return;
      setMessages((m) => m.map((x) => (x.cmd?.id === resolution.id ? { ...x, cmd: applyResolution(x.cmd, resolution) } : x)));
      refreshRailLive();
      return;
    }
    // A form (`question`, `kanban_plan`) refused AT ENTRY by the orchestrator: unrenderable
    // payload, no card was created. Without this line, the user would see
    // NOTHING — no form, no trace — while his agent just had a question
    // refused. This is exactly the blind spot of incident 2026-08-21.
    if (meta.type === 'permission_rejected') {
      const p = payload as { defect?: string };
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'notice',
          t: fmtTimeAt(meta.timestamp),
          content: '',
          notice: i18n('chatPage.askUserUnrenderable', { defect: p.defect ?? i18n('chatPage.invalidPayload') }),
          noticeTone: 'alert',
        },
      ]);
      return;
    }
    // A Web Push reached a phone: the card's deadline moved further out.
    if (meta.type === 'permission_timeout_adapted') {
      const p = payload as { id?: string; expires_at?: unknown };
      const expiresAt = p.expires_at;
      if (!p.id || typeof expiresAt !== 'number') return;
      setMessages((m) =>
        m.map((x) => (x.perm && x.perm.request_id === p.id ? { ...x, perm: { ...x.perm, expires_at: expiresAt } } : x)),
      );
      return;
    }
    // Server-authoritative expiry: the mission ended while a card was
    // still pending → the agent can no longer act on it. We flip the
    // card to `expired` so the user doesn't click a ghost.
    if (meta.type === 'permission_expired') {
      const p = payload as { id?: string };
      if (!p.id) return;
      setMessages((m) =>
        m.map((x) =>
          x.perm && x.perm.request_id === p.id
            ? { ...x, perm: { ...x.perm, state: 'expired' } }
            : x,
        ),
      );
      refreshRailLive();
      return;
    }

    // The agent speaks with no turn open: the CLI went back to work by itself
    // (TODO #714), which the daemon reads the same way, a sub-agent's words
    // included. A replay moves nothing: the bind takes this from the daemon's turn
    // state, an older page keeps it as it is.
    if (payload.type === 'assistant' && !replaying.current && !thinkingNow.current) setThinking(true);

    // Sub-agent internal traffic: when the parent invokes the Task / Agent
    // tool, Claude Code emits the sub-agent's full event stream into the
    // parent stream, each event tagged with parent_tool_use_id. These
    // events are correctly persisted (the orchestrator still needs them
    // for the transcript / summary), but rendering them in the chat
    // doubles the visual noise AND, more annoyingly, the sub-agent's
    // kickoff prompt comes through as a user-role event — which used to
    // render as a giant 'you' bubble carrying the agent's prompt as if
    // the user had typed it. Hide all sub-agent events from the chat;
    // only the parent's tool_use ('↳ Agent') and final tool_result are
    // shown via the normal flow.
    if ((payload.type === 'user' || payload.type === 'assistant') && payload.parent_tool_use_id) {
      return;
    }

    // A media the agent showed (SUG-0008). Consecutive ones of a turn share
    // a bubble; anything the stream carries that is not exactly a block is
    // dropped, not rendered.
    if (payload.type === 'media') {
      const block = parseMediaBlock(payload);
      if (!block) return;
      const turn = turnSeq.current;
      setMessages((m) => {
        const last = m[m.length - 1];
        if (last && last.role === 'agent' && last.turn === turn && last.media && !hasProse(last) && !last.tools?.length) {
          return [...m.slice(0, -1), { ...last, media: [...last.media, block] }];
        }
        return [
          ...m,
          { id: crypto.randomUUID(), role: 'agent', t: fmtTimeAt(meta.timestamp), content: '', media: [block], turn, step: 1 },
        ];
      });
      return;
    }

    if (payload.type === 'user') {
      // A compaction's rows — Timon's command, the CLI's summary and its
      // "Compacted" — are not the human speaking: one trace line, the
      // summary folded under it.
      const compactionRow = readCompactionUser(payload);
      if (compactionRow) {
        foldCompaction(userTracePatch(compactionRow), meta.timestamp);
        if (compactionRow.kind === 'command') {
          turnSeq.current += 1;
          setThinking(true);
        }
        return;
      }
      // Any other row the CLI wrote itself (an image note, a skill body) is
      // plumbing, never a bubble of the human's. Only a trace still waiting
      // for its summary may take it as that summary.
      if (isCliSynthetic(payload)) {
        setMessages((m) => {
          const row = readCompactionUser(payload, openTraceOf(m));
          return row ? foldCompactionInto(m, userTracePatch(row), meta.timestamp) : m;
        });
        return;
      }
      // Content may be a plain string (pre-multimodal path) or an array
      // of content blocks (text + image + tool_result) — tool_results
      // are siphoned out and attached to the matching tool_use in the
      // previous assistant bubble instead of producing their own.
      const raw = payload.message?.content;
      // Timon replaying a dropped turn (TODO #459): the same turn going on,
      // not a message — the retry line says it, the prompt stays out of sight.
      const replay = payload.origin?.turn_retry;
      if (typeof replay === 'number') {
        showRetryLine(lineOnReplayStarted(retryLineRef.current?.line ?? null, replay, providerNameRef.current), meta.timestamp);
        turnSeq.current += 1;
        setThinking(true);
        return;
      }
      // What Retry replays: the human's own last words.
      if (!payload.origin) {
        const typed = typeof raw === 'string' ? raw
          : Array.isArray(raw) ? raw.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n')
            : '';
        if (typed.trim()) lastHumanText.current = typed;
      }
      // A digest of work returns: one bubble per return, each under the agent
      // that rendered it, at the time it did. The pilot still got one prompt.
      const segments = typeof raw === 'string' && raw ? renderPromptSegments(raw, payload.origin) : null;
      if (segments) {
        const kind = readOrigin(payload.origin)?.kind ?? 'task_return';
        turnSeq.current += 1;
        setMessages((m) => [
          ...m,
          ...segments.map((segment) => ({
            id: crypto.randomUUID(),
            role: 'user' as const,
            t: fmtTimeAt(segment.at),
            tag: meta.tag,
            origin: { kind, from: segment.from, missionId: segment.missionId },
            content: segment.html,
          })),
        ]);
        setThinking(true);
        return;
      }
      let html = '';
      const toolResults: Array<{ id: string; content: unknown; isError: boolean }> = [];
      // Browser annotations posted from the bubble: their thumbnails belong to the card.
      const attachment = readAnnotationAttachment(payload.origin);
      const annotations = attachment ? annotationCardView(attachment, userEventImages(raw)) : undefined;
      const reply = readReplyAttachment(payload.origin) ?? undefined;
      const typedText = typeof raw === 'string' ? raw
        : Array.isArray(raw) ? raw.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n') : '';
      const typed = promptTypedText(typedText, payload.origin);
      if (typeof raw === 'string') {
        if (raw) html = renderPromptText(raw, payload.origin);
      } else if (Array.isArray(raw)) {
        for (const b of raw) {
          if (b?.type === 'text' && typeof b.text === 'string' && b.text) {
            html += renderPromptText(b.text, payload.origin);
          } else if (b?.type === 'image' && b.source?.type === 'base64' && b.source.data && !annotations) {
            // Whitelist the MIME type — anything else falls back to png.
            const rawMt = String(b.source.media_type || 'image/png');
            const mt = /^image\/(png|jpeg|jpg|gif|webp|svg\+xml)$/.test(rawMt)
              ? rawMt : 'image/png';
            // base64 alphabet doesn't include HTML-significant chars, so
            // direct interpolation is safe.
            const data = String(b.source.data).replace(/[^A-Za-z0-9+/=]/g, '');
            const src = `data:${mt};base64,${data}`;
            html += `<a href="${src}" target="_blank" rel="noopener noreferrer">`
              + `<img src="${src}" alt="user image" style="max-width:280px;max-height:280px;border-radius:8px;border:1px solid hsl(var(--border));margin:.2em 0;display:inline-block;" />`
              + `</a>`;
          } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            toolResults.push({
              id: b.tool_use_id,
              content: b.content,
              isError: b.is_error === true,
            });
          }
        }
      }
      if (toolResults.length) {
        setMessages((m) =>
          m.map((msg) => {
            if (msg.role !== 'agent' || !msg.tools) return msg;
            let touched = false;
            const tools = msg.tools.map((t) => {
              const tr = toolResults.find((x) => x.id === t.id);
              if (!tr || t.result) return t;
              touched = true;
              return {
                ...t,
                result: { text: toolResultText(tr.content), isError: tr.isError },
              };
            });
            return touched ? { ...msg, tools } : msg;
          }),
        );
      }
      if (!html && !annotations) return;
      // A human (or a peer agent) speaking opens a new turn: whatever the
      // agent says next must not land in the bubble it wrote before.
      turnSeq.current += 1;
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'user',
          t: fmtTimeAt(meta.timestamp),
          tag: meta.tag,
          origin: readOrigin(payload.origin),
          content: html,
          ...(annotations ? { annotations } : {}),
          ...(reply ? { reply } : {}),
          ...(meta.id !== undefined ? { eventId: meta.id } : {}),
          ...(typed ? { typed } : {}),
        },
      ]);
      // The user just spoke: claude is about to think. Show the indicator
      // unless we already have an assistant reply queued (rare for replay).
      setThinking(true);
    } else if (payload.type === 'assistant') {
      // The agent speaks again: the retry series it was waiting on is over.
      const recovered = lineOnOutput(retryLineRef.current?.line ?? null);
      if (recovered) showRetryLine(recovered, meta.timestamp);
      const blocks = payload.message?.content || [];
      // Markdown sources: the bubble converts them when it is drawn.
      const textBlocks: string[] = [];
      const newTools: ToolUse[] = [];
      const newThinking = readThinking(blocks);
      let lastTool: string | null = null;
      let hasText = false;
      let hasSubagentCall = false;
      for (const b of blocks) {
        if (b.type === 'text' && b.text) {
          // Whitespace alone converted to nothing: it must not open a step.
          if (b.text.trim()) textBlocks.push(b.text);
          hasText = true;
        } else if (b.type === 'tool_use' && b.name) {
          const input = (b.input ?? {}) as Record<string, unknown>;
          const fp =
            typeof input.file_path === 'string' ? input.file_path :
            typeof input.path === 'string' ? input.path :
            typeof input.notebook_path === 'string' ? input.notebook_path :
            undefined;
          newTools.push({
            id: String(b.id || crypto.randomUUID()),
            input: b.input,
            name: String(b.name),
            title: toolDisplayTitle(b),
            filePath: fp,
            detail: toolDetail(b),
            startedAt: meta.timestamp || Date.now(),
            intent: typeof input.description === 'string' ? input.description : undefined,
          });
          lastTool = b.name;
          if (b.name === 'Task' || b.name === 'Agent') {
            hasSubagentCall = true;
          }
          // Captures mutations of the agent's internal todo list
          // (TodoWrite + Task*) to display them as checkable in the
          // right panel.
          const todoInput = (b.input || {}) as Record<string, unknown>;
          setAgentTodos((prev) => {
            const next = applyTodoToolUse(prev, b.name as string, todoInput, String(b.id || ''));
            return next ?? prev;
          });
        }
      }
      if (textBlocks.length || newTools.length || newThinking) {
        const turn = turnSeq.current;
        setMessages((m) => {
          const last = m[m.length - 1];
          // Same-turn merge: the previous bubble was the same assistant turn
          // (role agent, no intervening user/permission) and no `result` has
          // closed it since. Tag-bearing bubbles shouldn't merge because the
          // tag belongs to a single payload.
          const sameTurn =
            !!last &&
            last.role === 'agent' &&
            !last.tag &&
            !last.voice &&
            // A media bubble stays one: text after it would render above it.
            !last.media &&
            last.turn === turn;
          const priorTools = last?.tools?.length ?? 0;
          // The agent's prose is the seam between two steps: once a bubble
          // holds tool calls, the next sentence is "now I do X", not a
          // comment on what precedes. It therefore opens the NEXT bubble
          // instead of being appended under the stack, where nobody read it.
          const opensStep = sameTurn && priorTools > 0 && textBlocks.length > 0;
          // Safety net for a step that never narrates (a debug loop firing
          // fifty calls in a row): past this many tools the stack is cut
          // anyway, so no bubble grows unbounded.
          const overflows = sameTurn && priorTools >= TOOLS_PER_BUBBLE_MAX && newTools.length > 0;
          if (sameTurn && !opensStep && !overflows) {
            const merged: Msg = {
              ...last,
              text: textBlocks.length ? [...(last.text ?? []), ...textBlocks] : last.text,
              // Reasoning never opens a step by itself (only prose does): an
              // agent that thinks between every tool call keeps one bubble.
              thinking: mergeThinking(last.thinking, newThinking),
              tools: [...(last.tools ?? []), ...newTools],
              danger: last.danger || hasSubagentCall || undefined,
              // The first event that brought text anchors a reply: its
              // opening words are the bubble's.
              eventId: last.eventId ?? (textBlocks.length ? meta.id : undefined),
            };
            return [...m.slice(0, -1), merged];
          }
          return [
            ...m,
            {
              id: crypto.randomUUID(),
              role: 'agent',
              t: fmtTimeAt(meta.timestamp),
              content: '',
              text: textBlocks.length ? textBlocks : undefined,
              thinking: newThinking || undefined,
              tools: newTools.length ? newTools : undefined,
              turn,
              step: sameTurn ? (last!.step ?? 1) + 1 : 1,
              danger: hasSubagentCall || undefined,
              eventId: textBlocks.length ? meta.id : undefined,
            },
          ];
        });
        // The "thinking" indicator stays visible between tool calls so the
        // chat doesn't look frozen while claude is mid-turn. Only the
        // `result` event (turn fully complete) clears it. Surface the
        // current activity (tool name) so the user sees forward motion.
        if (lastTool) {
          setThinkingHint(lastTool);
        } else if (hasText) {
          // Plain text reply: result is about to follow, leave hint blank.
          setThinkingHint(null);
        }
      }
      // Per-call usage (one Anthropic API request). This is the right
      // snapshot for "context window currently filled" — adding the
      // result.usage values across a turn double-counts cache_read on
      // every internal tool-use round-trip (10+ calls × 200k cached
      // tokens → multi-million bogus numbers in the status line).
      const mu = payload.message?.usage as
        | {
            input_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
          }
        | undefined;
      if (mu) {
        const snapshot =
          (mu.input_tokens ?? 0) +
          (mu.cache_read_input_tokens ?? 0) +
          (mu.cache_creation_input_tokens ?? 0);
        if (snapshot > 0) {
          setLiveStats((s) => ({ ...s, lastContextTokens: snapshot }));
        }
      }
    } else if (payload.type === 'result') {
      // A dropped turn (TODO #459) ends its retry line instead of a red
      // "turn interrupted": recovered, exhausted, or replayed by Timon.
      const retryLine = lineOnResult(retryLineRef.current?.line ?? null, payload, providerNameRef.current);
      if (retryLine) showRetryLine(retryLine, meta.timestamp);
      const replaying = retryLine?.state === 'replaying';
      // The turn is over: it closes the bubble it was filling.
      turnSeq.current += 1;
      // A turn Timon replays is not over: the agent will speak again.
      setThinking(replaying);
      setThinkingHint(null);
      const errText = payload.transient_failure ? null : resultErrorText(payload);
      if (errText) {
        setMessages((m) => {
          // claude already says the same thing in an `assistant` message
          // right before: without this guard, the user would read twice
          // that they're out of quota. We compare against the last
          // displayed text, HTML tags stripped.
          const last = m[m.length - 1];
          const shown = last?.role === 'agent'
            ? [last.content.replace(/<[^>]*>/g, ' '), ...(last.text ?? [])].join(' ')
            : '';
          if (shown.includes(errText)) return m;
          const quota = isRateLimitMessage(errText);
          return [
            ...m,
            {
              id: crypto.randomUUID(),
              role: 'notice',
              t: fmtTimeAt(meta.timestamp),
              content: '',
              notice: quota ? i18n('chatPage.usageLimitReached', { errText }) : i18n('chatPage.turnInterruptedWith', { errText }),
              noticeTone: 'alert',
            },
          ];
        });
      }
      // Images codex's `image_gen` wrote during the turn: the CLI never
      // mentions them, the daemon found and kept them (chat-media.ts).
      const generated = parseGeneratedMedia(payload.generated_media);
      if (generated.length) {
        const turn = turnSeq.current;
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: 'agent', t: fmtTimeAt(meta.timestamp), content: '', media: generated, turn, step: 1 },
        ]);
      }
      const cost = typeof payload.total_cost_usd === 'number' ? payload.total_cost_usd : 0;
      const tok =
        (payload.usage?.input_tokens || 0) + (payload.usage?.output_tokens || 0);
      if (cost || tok)
        setStats((s) => ({ tok: s.tok + tok, cost: s.cost + cost }));
      // result.usage is the SUMMED counters across every internal API
      // call of this turn — fine for cumulative totals (tokens in/out
      // billed), but useless for "context window filled right now"
      // because cache_read gets re-counted on every tool round-trip.
      // The per-call snapshot lives on the assistant event above; here
      // we only bump cumulative totals.
      const u = payload.usage ?? {};
      const inT = u.input_tokens ?? 0;
      const outT = u.output_tokens ?? 0;
      // `modelUsage`: the context window REPORTED BY THE RUNTIME, per
      // model actually used. This is the gauge's authoritative source — it
      // stays correct for a model released after this build, where any
      // hand-written table is stale by design.
      //
      // The map is CUMULATIVE across the mission: when several models
      // appear (hot switch), we don't choose here — we index everything,
      // and `contextLimitFor` retains the current model's window. We index
      // under the versioned id, its short form, and the canonical one,
      // because the slug we'll query with (the `system:init`'s or the
      // selected alias) isn't necessarily the key's.
      const mu = payload.modelUsage as
        | Record<string, { contextWindow?: number; canonicalModel?: string }>
        | undefined;
      if (mu && typeof mu === 'object') {
        const found: Record<string, number> = {};
        for (const [key, v] of Object.entries(mu)) {
          const w = v?.contextWindow;
          if (typeof w !== 'number' || w <= 0) continue;
          for (const k of [key, v?.canonicalModel]) {
            if (!k) continue;
            found[k] = w;
            found[shortModelSlug(k)] = w;
          }
        }
        if (Object.keys(found).length) {
          setLiveStats((s) => ({ ...s, contextWindows: { ...s.contextWindows, ...found } }));
        }
      }
      // Backends whose assistant events carry no per-call usage (codex) get
      // the snapshot from the daemon on the result instead.
      const ctxTokens = payload.context_tokens;
      setLiveStats((s) => ({
        ...s,
        totalIn: s.totalIn + inT,
        totalOut: s.totalOut + outT,
        ...(typeof ctxTokens === 'number' && ctxTokens > 0 ? { lastContextTokens: ctxTokens } : {}),
      }));
    } else if (payload.type === 'system' && payload.subtype === 'compact_boundary') {
      // A native compaction happened: the gauge drops to what is left now,
      // without waiting for the next turn's usage.
      const boundary = readCompactBoundary(payload);
      if (boundary) {
        foldCompaction(boundaryTracePatch(boundary), meta.timestamp);
        const post = boundary.postTokens;
        if (post !== null && post > 0) setLiveStats((s) => ({ ...s, lastContextTokens: post }));
      }
    } else if (payload.type === 'system' && payload.subtype === 'init') {
      // Capture the actual model the CLI is running on (more reliable
      // than agent.model, which may carry an alias like "sonnet").
      const m = payload.model;
      if (typeof m === 'string' && m.length) {
        setLiveStats((s) => (s.model === m ? s : { ...s, model: m }));
      }
    } else if (payload.type === 'rate_limit_event') {
      const info = payload.rate_limit_info ?? {};
      const t: 'five_hour' | 'seven_day' | undefined =
        info.rateLimitType === 'five_hour' || info.rateLimitType === 'seven_day'
          ? info.rateLimitType
          : undefined;
      if (t) {
        setLiveStats((s) => {
          // Preserve `utilization` coming from the OAuth poll — the SSE
          // rate_limit_event doesn't carry it. Without this merge, every
          // event overwrote the object and the status line fell back to
          // the "ok"/"imminent" label until the next poll (30s), creating
          // a visible flicker.
          const prev = s.rateLimits[t];
          return {
            ...s,
            rateLimits: {
              ...s.rateLimits,
              [t]: {
                status: info.status ?? 'unknown',
                resetsAt: Number(info.resetsAt) || prev?.resetsAt || 0,
                isUsingOverage: !!info.isUsingOverage,
                utilization: prev?.utilization,
              },
            },
          };
        });
      }
    }
  }

  /** The two attachment fields of a turn body, absent when there is nothing
   *  to attach. Shared by the spawn, the send and the queue flush — a builder
   *  missing here means a queued turn silently drops its files. */
  function attachmentFields(files: PendingFile[]): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const blobs = files.filter((f) => f.kind === 'file');
    const pasted = files.filter((f) => f.kind === 'pasted');
    if (blobs.length) {
      body.attachments = blobs.map((f) => ({ name: f.name, mime: f.mediaType, data: f.base64 }));
    }
    if (pasted.length) {
      body.pasted = pasted.map((f) => ({ name: f.name, text: f.text }));
    }
    return body;
  }

  /**
   * Sends the oldest queued turn, if the previous turn is finished. Only
   * one at a time: the message immediately relaunches a turn, the
   * following ones go out at the next `turn_complete`. A 409 (race: the
   * turn wasn't quite finished) puts it back at the head of the queue
   * rather than losing it.
   */
  async function flushQueuedTurn(): Promise<void> {
    const mid = activeMissionId.current;
    const next = queuedTurns.current[0];
    if (!mid || !next) return;
    queuedTurns.current = queuedTurns.current.slice(1);
    try {
      const body: Record<string, unknown> = {
        input: next.txt + '\n',
        ...attachmentFields(next.files),
        ...replyField(next.reply),
      };
      if (next.imgs.length) {
        body.images = next.imgs.map((i) => ({ media_type: i.mediaType, data: i.base64 }));
      }
      const r = await fetch('/api/ui/missions/' + mid + '/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 409) {
        queuedTurns.current = [next, ...queuedTurns.current];
        return;
      }
      // Quota exhausted: the turn stays queued, but we SAY it. The
      // generic toast below promised "it will go out at the next turn",
      // while no turn will go out until the window reopens.
      if (r.status === 429) {
        const j = await r.json().catch(() => ({}) as Record<string, unknown>);
        queuedTurns.current = [next, ...queuedTurns.current];
        toast.error(i18n('chatPage.quotaExhaustedTitle'), { description: quotaNotice(j) });
        return;
      }
      if (!r.ok) {
        queuedTurns.current = [next, ...queuedTurns.current];
        toast.error(i18n('chatPage.queuedMessageNotDelivered'), {
          description: i18n('chatPage.queuedMessageRetry', { status: r.status }),
        });
        return;
      }
      setThinking(true);
      if (streamIsClosed(activeStream.current)) openStream(mid);
      const sw = await r.json().catch(() => ({}) as Record<string, unknown>);
      if (sw.switched) noteBackendSwitch(sw, setMessages);
    } catch {
      queuedTurns.current = [next, ...queuedTurns.current];
    }
  }

  function openStream(missionId: string) {
    activeStream.current?.close();
    resetStream();
    const es = new EventSource('/api/ui/missions/' + missionId + '/stream' + streamClientQuery('c'));
    activeStream.current = es;
    lastStreamAt.current = Date.now();
    es.addEventListener('event', (e: MessageEvent) => {
      lastStreamAt.current = Date.now();
      if (typeof e.data === 'string') cacheBytes.current += e.data.length;
      try {
        const ev = JSON.parse(e.data);
        // The replay of an opening stream reaches further back than the page
        // loaded: that row comes with its own page, in its place.
        if (typeof ev.timestamp === 'number' && belowHistoryFloor(ev.timestamp, historyCursor.current)) return;
        // A persisted event closes the current fragment (cf. endsStreamingBubble).
        if (endsStreamingBubble(ev.type)) resetStream();
        // Capture session_id from system:init so a future spawn-fallback
        // (after claude dies mid-conversation) can resume the right session.
        if (
          ev.type === 'system' &&
          ev.payload?.subtype === 'init' &&
          ev.payload?.session_id
        ) {
          setCurrentSessionId(ev.payload.session_id);
        }
        ingest(ev.payload, { type: ev.type, timestamp: ev.timestamp, id: eventIdOf(ev) });
      } catch {}
    });
    es.addEventListener('event_delta', (e: MessageEvent) => {
      lastStreamAt.current = Date.now();
      try {
        const action = routeStreamDelta(JSON.parse(e.data), activeMissionId.current);
        if (action.kind !== 'push') return;
        pushStreamDelta(action.text, action.mode);
      } catch {}
    });
    // End of turn for a one-shot backend: the process died without
    // necessarily emitting a usable `result` — we don't leave a
    // provisional bubble orphaned at the bottom of the thread.
    es.addEventListener('turn_complete', () => {
      resetStream();
      // The agent may have committed, switched branch or merged: every Git
      // read on screen catches up now, not at the next stray event.
      invalidateGit();
      // The one-shot's input channel just reopened: whatever was typed
      // during the turn goes out now.
      void flushQueuedTurn();
    });
    es.addEventListener('mission_complete', () => {
      es.close();
      activeStream.current = null;
      setupTroubleRef.current?.('ended');
      resetStream();
      invalidateGit();
      // We keep activeMissionId: the persistent process may be dead
      // (crash / orchestrator restart), but the mission + its session
      // survive. The next send therefore resumes on THIS missionId — the
      // /send route resumes it in place via respawnWithResume — instead
      // of spawning a fresh mission. To truly start over, the user
      // explicitly clicks "new conversation" (newConversation resets the
      // ref).
      // A turn that ends here closes its bubble just like `result` does:
      // without the bump, the next one would keep writing into it.
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      // Mission closed but still resumable in place (/send → respawn with
      // --resume): a queued turn must not die with the process.
      void flushQueuedTurn();
    });
    es.onerror = () => {
      /* browser auto-reconnect */
    };
  }

  // A turn whose end never reached the stream leaves "thinking" up forever
  // while the reply is already stored (#145). While a turn runs, a quiet
  // stream is checked against the daemon; reopening replays the mission, and
  // the dedup of `ingest` keeps only what was missed.
  useEffect(() => {
    if (!thinking || !currentMissionId) return;
    const missionId = currentMissionId;
    let cancelled = false;
    /** Reopened since the daemon last called a turn active or on its way: whatever
     *  the stream had lost has been replayed. */
    let reopened = false;
    const tick = async () => {
      const state = {
        thinking: true,
        quietMs: Date.now() - lastStreamAt.current,
        streamClosed: streamIsClosed(activeStream.current),
      };
      const streamAt = lastStreamAt.current;
      let action = watchdogAction(state);
      if (action === 'probe') {
        // The daemon may be restarting: a dead stream is still reopened, an open
        // one waits for the next round.
        const noAnswer = state.streamClosed ? 'reopen' : 'idle';
        try {
          const r = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}?view=status`, { cache: 'no-store' });
          if (r.status === 404) {
            action = watchdogAction({ ...state, missionGone: true });
          } else if (!r.ok) {
            action = noAnswer;
          } else {
            const detail = await r.json() as { turn_active?: unknown; turn_preparing?: unknown };
            const turnActive = detail.turn_active === true;
            const turnPreparing = detail.turn_preparing === true;
            action = watchdogAction({ ...state, missionGone: false, turnActive, turnPreparing, caughtUp: reopened && detail.turn_preparing === false });
            if (turnActive || turnPreparing) reopened = false;
          }
        } catch {
          action = noAnswer;
        }
        // The stream spoke or a message left during the question: the answer may
        // already be old.
        if (lastStreamAt.current !== streamAt) return;
      }
      if (cancelled || activeMissionId.current !== missionId) return;
      if (action === 'abandon') {
        activeStream.current?.close();
        activeStream.current = null;
      }
      if (action === 'settle' || action === 'abandon') {
        // Same end as `mission_complete`: the bubble closes, a message queued
        // behind this indicator must not wait for a `turn_complete` to come. On a
        // mission gone it fails and says so, and the next send starts a new one.
        turnSeq.current += 1;
        setThinking(false);
        setThinkingHint(null);
        void flushQueuedTurn();
      } else if (action === 'reopen') {
        reopened = true;
        openStream(missionId);
      }
    };
    const timer = window.setInterval(() => { void tick(); }, 5_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  // openStream and flushQueuedTurn are plain functions of this component: they
  // only read refs.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [thinking, currentMissionId]);

  /** Will the current turn survive an interruption? Decided by the
   *  effective backend's CAPABILITY (catalog), never by its name: a
   *  third-party profile may reuse the same CLI. False → STOP warns that
   *  the stop is final before cutting anything. */
  const turnResumable = isSessionResumable(backendCatalog, effBackend);

  /**
   * Cuts the current turn WITHOUT closing the conversation. The opposite
   * of the mission delete button: no dispose on the orchestrator side, so
   * the next message resumes with the context (`--resume`).
   */
  const stopTurn = useCallback(async () => {
    const mid = activeMissionId.current;
    if (!mid || stopping) return;
    // Non-resumable backend (session dies with its process): cutting
    // here isn't "I take back control", it's "I lose the thread". We say
    // it BEFORE, not in an after-the-fact notice.
    if (!turnResumable && !(await confirmAction({ title: i18n('chatPage.stopTurnConfirm'), confirmLabel: i18n('confirmDialog.cut'), destructive: true }))) return;
    setStopping(true);
    try {
      const r = await fetch(`/api/ui/missions/${encodeURIComponent(mid)}/interrupt`, {
        method: 'POST',
      });
      // 404 = mission unknown to the orchestrator (restart, purge):
      // nothing left to cut, but the UI must stop pretending a turn is in
      // flight.
      if (!r.ok) {
        // A turn that ends here closes its bubble just like `result` does:
        // without the bump, the next one would keep writing into it.
        turnSeq.current += 1;
        setThinking(false);
        setThinkingHint(null);
      }
      // Success touches nothing: the SSE's `turn_interrupted` event lays
      // down the notice and turns off the indicator — same path as a
      // history reload, so only one render path to maintain.
    } catch {
      // A turn that ends here closes its bubble just like `result` does:
      // without the bump, the next one would keep writing into it.
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
    } finally {
      setStopping(false);
    }
  }, [stopping, turnResumable]);

  const send = useCallback(async (mode?: WorkingEnterMode) => {
    // A GPT-Live turn arrives here with its own words: it must leave the
    // draft and its attachments exactly where the user left them.
    // Retry after the provider gave up (TODO #459): the same words again, with
    // the draft and its attachments left where the user left them.
    const replay = replayTurnText.current;
    replayTurnText.current = null;
    const spoken = replay === null ? voiceTurnText.current : null;
    voiceTurnText.current = null;
    const voiceContext = spoken === null ? '' : voiceTurnContext.current;
    voiceTurnContext.current = '';
    // A delegated turn always says it came by voice: the agent then answers
    // in a form that can be read aloud.
    const voiceFields: Record<string, unknown> = spoken === null
      ? {}
      : { voiceContext: voiceContext || 'No earlier spoken exchange in this session.' };
    const keepDraft = spoken !== null || replay !== null;
    // What another surface deposited for this conversation goes with the
    // draft (TODO #468): its text after the user's words, its images with
    // theirs.
    const boxed = keepDraft ? [] : listPendingAttachments(draftOwner);
    const fromBox = attachmentsForTurn((replay ?? spoken ?? input).trim(), boxed);
    const txt = fromBox.text;
    const imgs: PendingImage[] = keepDraft ? [] : [
      ...pendingImages,
      ...fromBox.images.map((image) => ({
        id: image.id,
        mediaType: image.mediaType,
        base64: image.base64,
        previewUrl: attachmentPreviewUrl(image),
        size: image.size,
      })),
    ];
    const files = keepDraft ? [] : pendingFiles;
    // A spoken or replayed turn is not the one the user armed the reply for.
    const replyTo = keepDraft ? null : replyRef.current;
    // Allow attachment-only turns (empty txt but at least one image or file).
    if (!txt && imgs.length === 0 && files.length === 0) return;
    // Last guard before the daemon's 25 MB body cap: a long paste is not
    // budgeted when it is captured (TIM-0125).
    if (turnAttachmentBytes(imgs, files) + fromBox.textBytes > MAX_TURN_BYTES) {
      toast.error(messageOverBudget());
      return;
    }
    // The backend may have changed while files were waiting: say so before
    // sending rather than let the daemon refuse the whole turn.
    if (!acceptsFiles && files.some((f) => f.kind === 'file')) {
      toast.error(i18n('chatPage.attachmentsUnsupported', { backend: effBackend }));
      return;
    }

    // Speaking is asking to come back to the end, wherever one was reading.
    stickToBottom.current = true;

    if (!keepDraft) {
      setInput('');
      // Revoke the preview URLs we minted on paste — the base64 lives in
      // the request body, the blob: URLs are no longer needed.
      for (const im of imgs) URL.revokeObjectURL(im.previewUrl);
      setPendingImages([]);
      setPendingFiles([]);
      // Only what this turn carries: a deposit made meanwhile waits.
      removePendingAttachments(draftOwner, boxed.map((item) => item.id));
      setReply(null);
    }

    // The agent is working (TODO #488): the message either redirects the turn
    // now or waits for its end, as the user chose — never a parallel turn.
    const workingMid = activeMissionId.current;
    if (mode && thinking && workingMid && replay === null && spoken === null) {
      const queueIt = (notice: string): void => {
        queuedTurns.current = [...queuedTurns.current, { txt, imgs, files, reply: replyTo }];
        setMessages((m) => [
          ...m,
          { id: crypto.randomUUID(), role: 'notice', t: nowTime(), content: '', notice },
        ]);
      };
      // A file is announced by its path through `/send`, which a steer skips.
      if (mode === 'queue' || files.length > 0) {
        queueIt(i18n('chatPage.messageQueuedInline'));
        return;
      }
      try {
        const res = await fetch(`/api/ui/missions/${encodeURIComponent(workingMid)}/steer`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: txt,
            ...(imgs.length ? { images: imgs.map((i) => ({ media_type: i.mediaType, data: i.base64 })) } : {}),
            ...replyField(replyTo),
          }),
        });
        if (res.ok) return;
        const j = await res.json().catch(() => ({}) as Record<string, unknown>);
        if (isReplyRefusal(j)) {
          toast.error(i18n('chatPage.replyRefused'));
          return;
        }
        // The turn ended meanwhile: an ordinary message does it, below.
        if (j.code !== 'no_turn_to_steer') {
          queueIt(i18n('chatPage.steerUnavailableQueued'));
          return;
        }
      } catch {
        queueIt(i18n('chatPage.steerUnavailableQueued'));
        return;
      }
    }
    setThinking(true);
    setThinkingHint(null);
    // No optimistic append: the orchestrator logs each user input as a `user`
    // event on the bus, and the SSE delivers it back to us → ingest() renders
    // the bubble. That keeps reload-from-history and live in lockstep.

    // The host's context, once per thread: repeating it on every turn would
    // re-read the same block into the window at each message.
    const outbound = contextPrefix && !contextSent.current ? `${contextPrefix}\n\n${txt}` : txt;

    const spawnModelOverride = pendingModelOverride ?? missionModel;
    const spawnBackendOverride = pendingBackendOverride ?? missionBackend;
    const spawnEffortOverride = pendingReasoningEffort ?? missionReasoningEffort;

    /** Build the spawn body with the right resume policy + image attachments. */
    // The daemon says WHY a spawn failed (binary missing, CLI too old, no
    // credentials…); a bare status hid that from the tester (TIM-0009).
    const spawnFailure = async (res: Response): Promise<string> => {
      if (res.status === 413) return messageOverBudget();
      let detail = '';
      try {
        const text = await res.text();
        try { detail = String((JSON.parse(text) as { error?: unknown }).error ?? text); } catch { detail = text; }
      } catch { /* no body */ }
      return `spawn failed: ${res.status}${detail ? ` — ${detail.slice(0, 400)}` : ''}`;
    };
    const spawnBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        agent: agentId, input: outbound, ...attachmentFields(files), ...voiceFields,
      };
      if (imgs.length) {
        body.images = imgs.map((i) => ({ media_type: i.mediaType, data: i.base64 }));
      }
      // Per-mission LLM override. Two sources, in this order:
      //   1. the before-1st-send picker (pendingModelOverride, sticky
      //      localStorage);
      //   2. failing that, the LLM of the mission we're leaving
      //      (missionModel/missionBackend).
      //
      // (2) is essential when this spawn is a FALLBACK from a failed
      // /send: without it, a conversation hot-switched to codex/gpt-5.6
      // would restart on the agent's config (typically claude/opus)
      // without a word, all while keeping the codex thread's
      // resume_session_id — hence a silent downgrade AND an impossible
      // resume.
      if (spawnModelOverride) {
        body.model_override = spawnModelOverride;
      }
      if (spawnBackendOverride) {
        body.backend_override = spawnBackendOverride;
      }
      if (spawnEffortOverride) {
        body.reasoning_effort = spawnEffortOverride;
      }
      if (freshStart.current) {
        // explicit null → orchestrator skips --resume entirely
        body.resume_session_id = null;
      } else if (currentSessionId) {
        // pinpoint the session we want to continue (could be older than the
        // agent's globally-latest if user navigated to a specific mission)
        body.resume_session_id = currentSessionId;
      }
      // else: omit → orchestrator falls back to agent's most-recent session
      return body;
    };

    const sendBody = (): Record<string, unknown> => {
      const body: Record<string, unknown> = {
        input: outbound + '\n', ...attachmentFields(files), ...voiceFields, ...replyField(replyTo),
      };
      if (imgs.length) {
        body.images = imgs.map((i) => ({ media_type: i.mediaType, data: i.base64 }));
      }
      return body;
    };

    try {
      if (!activeMissionId.current) {
        const res = await fetch('/api/ui/missions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(spawnBody()),
        });
        if (!res.ok) throw new Error(await spawnFailure(res));
        const j = await res.json();
        noteSkippedAttachments(j);
        activeMissionId.current = j.mission_id;
        pinMissionInUrl(j.mission_id, agentId);
        contextSent.current = true;
        // The LLM chosen at spawn becomes the mission's: the composer's
        // selector takes over on these same values.
        setMissionBackend(spawnBackendOverride);
        setMissionModel(spawnModelOverride);
        setMissionReasoningEffort(spawnEffortOverride);
        setCurrentMissionId(j.mission_id);
        freshStart.current = false;
        openStream(j.mission_id);
        refreshMissions();
      } else {
        const mid = activeMissionId.current;
        const res = await fetch(
          '/api/ui/missions/' + mid + '/send',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(sendBody()),
          },
        );
        if (res.ok) {
          contextSent.current = true;
          // The mission may have died (restart / crash) and was just
          // resumed IN PLACE by the /send route (respawnWithResume, same
          // missionId). If the SSE stream isn't open anymore, we reopen it
          // to display the resumed turn live. On a still-alive mission,
          // activeStream is already wired → no-op.
          if (streamIsClosed(activeStream.current)) {
            openStream(mid);
            refreshMissions();
          }
          // The backend was out of quota: the conversation changed CLI
          // without changing thread. We say so — the response style will
          // change, and that's information, not an incident.
          const sw = await res.json().catch(() => ({}) as Record<string, unknown>);
          if (sw.switched) noteBackendSwitch(sw, setMessages);
          noteSkippedAttachments(sw);
          refreshMissions();
        }
        // 409: the agent is STILL TALKING. On a one-shot backend (codex)
        // there's no input channel before the turn ends. Absolutely no
        // fallback spawn here: that would open a parallel thread on
        // another LLM while the real conversation continued elsewhere.
        // The turn is queued and will go out on its own at
        // `turn_complete`, in this same mission.
        if (res.status === 409) {
          queuedTurns.current = [...queuedTurns.current, { txt, imgs, files, reply: replyTo }];
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              role: 'notice',
              t: nowTime(),
              content: '',
              notice: i18n('chatPage.messageQueuedInline'),
            },
          ]);
          return;
        }
        // 429: the backend is out of quota. Absolutely NO fallback spawn
        // — a fresh mission would restart on the same dried-up backend and
        // die immediately, in cascade (night of 2026-08-22). The
        // conversation itself is intact: it will resume as-is once
        // reopened.
        if (res.status === 429) {
          const j = await res.json().catch(() => ({}) as Record<string, unknown>);
          queuedTurns.current = [...queuedTurns.current, { txt, imgs, files, reply: replyTo }];
          setMessages((m) => [
            ...m,
            {
              id: crypto.randomUUID(),
              role: 'notice',
              t: nowTime(),
              content: '',
              notice: quotaNotice(j),
            },
          ]);
          return;
        }
        // Too big for the daemon: a fresh spawn would carry the same body.
        if (res.status === 413) throw new Error(messageOverBudget());
        // The message replied to is not this conversation's: the mission is
        // alive, a fresh spawn would lose it. Nothing was sent.
        if (res.status === 400 || res.status === 422) {
          const j = await res.clone().json().catch(() => ({}) as Record<string, unknown>);
          if (isReplyRefusal(j)) throw new Error(i18n('chatPage.replyRefused'));
        }
        // Resume impossible (mission not found). We fall back to a fresh
        // spawn — keeping the session_id so the CLI resumes where the
        // previous process left off.
        if (!res.ok) {
          activeStream.current?.close();
          activeStream.current = null;
          activeMissionId.current = null;
          const fresh = await fetch('/api/ui/missions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(spawnBody()),
          });
          if (!fresh.ok) throw new Error(await spawnFailure(fresh));
          const j = await fresh.json();
          noteSkippedAttachments(j);
          activeMissionId.current = j.mission_id;
          pinMissionInUrl(j.mission_id, agentId);
          contextSent.current = true;
          setCurrentMissionId(j.mission_id);
          freshStart.current = false;
          openStream(j.mission_id);
          refreshMissions();
        }
      }
    } catch (err) {
      // A turn that ends here closes its bubble just like `result` does:
      // without the bump, the next one would keep writing into it.
      turnSeq.current += 1;
      setThinking(false);
      setThinkingHint(null);
      setMessages((m) => [
        ...m,
        {
          id: crypto.randomUUID(),
          role: 'agent',
          t: nowTime(),
          content:
            '<p style="color:hsl(var(--destructive))">⚠ ' +
            escapeHtml(String((err as Error).message || err)) +
            '</p>',
        },
      ]);
    }
    // The LLM overrides (pending* from the picker, mission* of the
    // current thread) are read from the closure: without them in the
    // deps, a fallback spawn would restart on a stale value — exactly the
    // downgrade we're trying to prevent.
  }, [
    input, pendingImages, pendingFiles, draftOwner, agentId, currentSessionId, refreshMissions,
    pendingModelOverride, pendingBackendOverride, pendingReasoningEffort,
    missionModel, missionBackend, missionReasoningEffort, contextPrefix, acceptsFiles, effBackend, thinking,
  ]);

  // Browser annotations posted from the bubble or the address bar reached a conversation of this
  // agent (TODO #481): on "New conversation" it is the one just started, shown as after a first message.
  // The address bar says it at once and the stream again: one bind per conversation.
  const adoptingPosted = useRef<string | null>(null);
  useEffect(() => {
    if (forcedAgent || compact) return;
    const onPosted = (event: Event) => {
      const posted = (event as CustomEvent<BrowserAnnotationsPosted>).detail;
      if (!posted || posted.agent !== agentId || posted.missionId === activeMissionId.current || posted.missionId === adoptingPosted.current) return;
      adoptingPosted.current = posted.missionId;
      void bindMission(posted.missionId).then(() => refreshMissions()).finally(() => { adoptingPosted.current = null; });
    };
    window.addEventListener(BROWSER_ANNOTATIONS_POSTED, onPosted);
    return () => window.removeEventListener(BROWSER_ANNOTATIONS_POSTED, onPosted);
  }, [agentId, forcedAgent, compact, bindMission, refreshMissions]);

  /** User clicked a mission card in the rail. If the card was flagged
   *  "action requise", `permId` points at the unresolved permission to
   *  scroll to once the conversation is rebound. Pre-existing same-mission
   *  clicks bypass bindMission (which would wipe the messages) and just
   *  fire the scroll effect via a forced ref reset. */
  const pickMission = useCallback(
    (id: string, permId?: string | null) => {
      if (permId) pendingDeepLinkPermId.current = permId;
      if (id === activeMissionId.current && permId) {
        // Already on this mission: re-run the deep-link effect, which also
        // mounts the card when it sits above the thread window.
        setDeepLinkPoke((n) => n + 1);
        return;
      }
      void bindMission(id);
    },
    [bindMission],
  );

  const placeholder = useMemo(() => i18n('chatPage.messagePlaceholder', { name: agent.name }), [agent.name]);

  const toggleDictation = useCallback(() => {
    if (recording) {
      manualStopRef.current = true;
      clearDictationTimers();
      recognitionRef.current?.stop();
      stopAudioVisualiser();
      return;
    }
    if (dictationUnavailable) {
      toast.error(i18n('chatPage.voiceDictationDesktopUnavailable'));
      return;
    }
    if (dictationRoute === 'unavailable-choice') {
      // The engine the user chose cannot run: said, never replaced by another
      // one that would send the voice elsewhere (TODO #492).
      const failure = choiceFailure();
      toast.error(failure.message, {
        action: { label: i18n('dictation.choice.openSettings'), onClick: () => { openSettingsFromAnywhere({ category: 'interface', tab: 'voice' }); } },
      });
      return;
    }
    const recognition = createRecognition(dictationRoute, presentEngineConsent);
    if (!recognition) {
      toast.error(i18n('chatPage.voiceDictationUnavailable'));
      return;
    }
    /** The mic-steal heuristics below belong to Web Speech on Android: on the
     *  desktop's engine an `audio-capture` is a real capture failure. */
    const webSpeech = dictationRoute === 'web-speech';
    manualStopRef.current = false;
    dictationBaseRef.current = input;
    dictationDraftRef.current = beginDictationDraft(draftOwner, input);
    texteSessionRef.current = '';
    dicteeFataleRef.current = false;
    sttOkRef.current = false;
    derniereActiviteRef.current = Date.now();
    recognition.lang = dictationLang();
    // Continuous listening: a pause no longer ends the turn at all, so most
    // hesitations cost neither a relaunch, nor a text fold, nor a blink of the
    // mic button. The relaunch below stays for the engines that end the turn
    // anyway (Android) and for the ~60 s cut-off Chrome applies to a continuous
    // stream. The end of the dictation is ours to decide: the silence timer.
    recognition.continuous = true;
    recognition.interimResults = true;
    /** Ends the dictation on its own once the speaker has gone quiet for the
     *  whole grace window. Marked as a deliberate stop: the `aborted` that
     *  follows `stop()` is ours, and no relaunch must contest it. */
    const armSilenceTimer = () => {
      if (silenceTimerRef.current !== null) window.clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = window.setTimeout(() => {
        silenceTimerRef.current = null;
        manualStopRef.current = true;
        recognition.stop();
      }, DICTEE_GRACE_MS);
    };
    armSilenceTimer();
    // The silence window counts from when the engine listens: the desktop's
    // local engine loads its model for ~2 s on a first start, and a timer
    // armed at the click would end the dictation before its first words.
    recognition.onstart = () => {
      derniereActiviteRef.current = Date.now();
      armSilenceTimer();
      // Local engine: the visualizer's microphone opens once the engine
      // listens, never for a start that ends on a missing model.
      if (!webSpeech) void startAudioVisualiser();
    };
    recognition.onresult = (event) => {
      // The whole `results` array, never from `event.resultIndex`: in
      // continuous listening the index points at the only segment that just
      // changed, and composing from it would drop everything said before the
      // pause (cf. lib/stt-dictee).
      const text = texteSession(
        Array.from({ length: event.results.length }, (_, i) => ({
          isFinal: event.results[i]!.isFinal,
          transcript: event.results[i]![0].transcript,
        })),
      );
      const next = composerDictee(dictationBaseRef.current, text);
      const draft = dictationDraftRef.current;
      const written = draft
        ? writeDictationDraft(draft, { owner: draftOwnerRef.current, text: liveInputRef.current }, next)
        : null;
      if (!written) {
        // The user typed in the field, or left for another conversation: the
        // field is theirs now. This dictation stops writing and stops.
        if (recognitionRef.current === recognition) {
          manualStopRef.current = true;
          clearDictationTimers();
          recognition.abort();
        }
        return;
      }
      dictationDraftRef.current = written;
      liveInputRef.current = next;
      sttOkRef.current = true;
      derniereActiviteRef.current = Date.now();
      armSilenceTimer();
      texteSessionRef.current = text;
      setInput(next);
    };
    recognition.onerror = (event) => {
      if (manualStopRef.current) return;
      if (isLocalDictationError(event.error)) {
        dicteeFataleRef.current = true;
        const message = localDictationErrorMessage(event.error);
        if (message) toast.error(message);
        return;
      }
      // Capture error while nothing has ever been transcribed and the
      // visualizer holds a second mic stream: it's the one stealing the
      // mic from the system engine. We sacrifice it for good and relaunch
      // dictation.
      if (webSpeech && estConflitMicro(event.error) && !sttOkRef.current && visualiseurDemandeRef.current) {
        interdireVisualiseur();
        stopAudioVisualiser();
        relanceApresConflitRef.current = true;
        return;
      }
      if (erreurDicteeFatale(event.error)) {
        dicteeFataleRef.current = true;
        toast.error(i18n('chatPage.dictationUnavailable', { error: event.error }));
        return;
      }
      // Ordinary end of turn of a listening that just crossed a pause: the
      // grace window relaunches it, silently. `aborted` only stays silent once
      // something has been transcribed — with nothing transcribed it remains
      // the signature of the mic steal by the Android system engine, which
      // filtering on the code alone used to hide.
      if (event.error === 'no-speech') return;
      if (event.error === 'aborted' && sttOkRef.current) return;
      toast.error(i18n('chatPage.dictationUnavailable', { error: event.error }));
    };
    recognition.onend = () => {
      if (recognitionRef.current !== recognition) return;
      if (
        !relanceApresConflitRef.current &&
        doitRelancerDictee({
          arretManuel: manualStopRef.current,
          erreurFatale: dicteeFataleRef.current,
          depuisDerniereActivite: Date.now() - derniereActiviteRef.current,
        })
      ) {
        // Still within the grace window: the speaker is looking for their
        // words. The session text is folded into the base BEFORE relaunching —
        // the new session starts from an empty `event.results` and its first
        // `onresult` would otherwise wipe everything said so far. `recording`
        // stays true, the button doesn't blink.
        dictationBaseRef.current = composerDictee(dictationBaseRef.current, texteSessionRef.current);
        texteSessionRef.current = '';
        if (restartTimerRef.current !== null) window.clearTimeout(restartTimerRef.current);
        restartTimerRef.current = window.setTimeout(() => {
          restartTimerRef.current = null;
          if (manualStopRef.current || recognitionRef.current !== recognition) return;
          try {
            recognition.start();
            armSilenceTimer();
          } catch {
            // The engine still holds the previous instance: its own `onend`
            // will come back through here.
          }
        }, DICTEE_RESTART_DELAY_MS);
        return;
      }
      manualStopRef.current = false;
      clearDictationTimers();
      recognitionRef.current = null;
      setRecording(false);
      stopAudioVisualiser();
      if (relanceApresConflitRef.current) {
        relanceApresConflitRef.current = false;
        // Let the system engine reclaim the mic before requesting it again.
        window.setTimeout(() => toggleDictationRef.current?.(), 300);
      }
    };
    recognitionRef.current = recognition;
    setRecording(true);
    recognition.start();
    // The visualizer opens a second mic stream, dismissed where the
    // recognition engine requires exclusive access to the mic (cf.
    // lib/stt-mic-exclusif). The local engine opens it from `onstart`.
    if (webSpeech) void startAudioVisualiser();
  }, [clearDictationTimers, dictationRoute, dictationUnavailable, draftOwner, input, recording, startAudioVisualiser, stopAudioVisualiser]);
  /** The post-conflict relaunch originates from a recognition callback,
   *  which can't capture a fresh `toggleDictation` closure. */
  const toggleDictationRef = useRef(toggleDictation);
  toggleDictationRef.current = toggleDictation;

  /** Push-to-talk: dictation is open while the configured key is held down.
   *  Read from the device (cf. lib/push-to-talk), re-read on every change so a
   *  binding edited in /settings applies without a reload. */
  const pushToTalk = useSyncExternalStore(
    abonnerPushToTalk,
    chargerPushToTalk,
    () => PUSH_TO_TALK_DEFAUT,
  );
  /** The key handlers must not be rebound on every keystroke of the composer:
   *  they read the recording state through a ref, not through the closure. */
  const recordingRef = useRef(recording);
  recordingRef.current = recording;
  /** One key held must open ONE mic: the focused chat's. The page learns it
   *  from its workspace, an island chat from its prop. Not `primary`: a chat
   *  outside the group (the cockpit's card) would listen along. */
  const [pageFocused, setPageFocused] = useState(true);
  const chatFocused = inIsland ? focused : pageFocused;

  useEffect(() => {
    if (!pushToTalk.actif || !chatFocused) return;
    const relacher = () => {
      if (!recordingRef.current) return;
      toggleDictationRef.current?.();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!estDeclencheurPushToTalk(event, pushToTalk)) return;
      event.preventDefault();
      if (recordingRef.current) return;
      toggleDictationRef.current?.();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== pushToTalk.code) return;
      event.preventDefault();
      relacher();
    };
    // Leaving the window while holding the key never delivers the `keyup`:
    // without this, the mic would stay open behind another application.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', relacher);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', relacher);
    };
  }, [pushToTalk, chatFocused]);

  /** Escape while dictating cancels the dictation and puts the draft back as
   *  it was before the recording (lib/dictation/draft-contract). A handler
   *  that already used the key — the slash menu — keeps it. */
  useEffect(() => {
    if (!recording || !chatFocused) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      const recognition = recognitionRef.current;
      if (!recognition) return;
      event.preventDefault();
      manualStopRef.current = true;
      clearDictationTimers();
      recognition.abort();
      stopAudioVisualiser();
      const draft = dictationDraftRef.current;
      dictationDraftRef.current = null;
      const restored = draft ? cancelDictationDraft(draft, { owner: draftOwnerRef.current, text: liveInputRef.current }) : null;
      if (restored !== null) setInput(restored);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [recording, chatFocused, clearDictationTimers, stopAudioVisualiser, setInput]);

  // ── GPT-Live: the voice carries the conversation, the mission does the work.
  // Each delegation becomes an ordinary turn of this mission; its answer goes
  // back to GPT-Live once the turn ends. Oldest delegation answered first.
  const { status: gptLiveStatus } = useGptLiveStatus();
  const liveDelegations = useRef<{ id: string; before: Set<string>; started: boolean }[]>([]);
  // A turn nobody delegated (typed message, ask_user answer, wake) whose
  // answer GPT-Live must still hear.
  const undelegatedTurn = useRef<UndelegatedWatch>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const sendRef = useRef(send);
  sendRef.current = send;
  /** Retry button of an exhausted retry line: the last human message again,
   *  in the same session (`/send` resumes a one-shot CLI on its thread). */
  const retryTurn = useCallback(() => {
    const text = lastHumanText.current;
    if (!text) { toast.error(i18n('chatPage.retryTurnUnavailable')); return; }
    replayTurnText.current = text;
    void sendRef.current();
  }, []);
  // Only the newest retry line, and only until someone spoke after it.
  let retryableLineId: string | null = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === 'user') break;
    if (msg.retryLine) { retryableLineId = msg.retryLine.state === 'exhausted' ? msg.id : null; break; }
  }
  // Spoken turns wait in `journalQueue` until their thread has a mission to
  // write into: a conversation opened by voice has none before its first
  // delegation.
  const journalBusy = useRef(false);
  const flushJournal = useCallback(async () => {
    if (journalBusy.current) return;
    journalBusy.current = true;
    try {
      while (journalQueue.current.length > 0) {
        const { turn, thread } = journalQueue.current[0]!;
        if (!thread.id && thread === liveThread.current) thread.id = activeMissionId.current;
        const missionId = thread.id;
        if (!missionId) {
          // Still waiting for its mission, or its thread was left unsaved.
          if (thread === liveThread.current) return;
          journalQueue.current.shift();
          continue;
        }
        try {
          await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}/voice-transcript`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              role: turn.speaker,
              text: turnText(turn).slice(0, 4000),
              clientId: turn.id,
              ...(turn.relay ? { relay: true } : {}),
              ...(turn.startMs !== null ? { startMs: turn.startMs } : {}),
              ...(turn.endMs !== null ? { endMs: turn.endMs } : {}),
            }),
          });
        } catch { /* the bubble stays on screen; losing one journal line beats blocking the rest */ }
        journalQueue.current.shift();
      }
    } finally {
      journalBusy.current = false;
    }
  }, []);
  useEffect(() => { if (currentMissionId) void flushJournal(); }, [currentMissionId, flushJournal]);

  const liveHistory = useCallback((): LiveHistoryMessage[] => {
    const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
    const out: LiveHistoryMessage[] = [];
    const thread = messagesRef.current;
    // From the end: only the last messages are sent, and the agent's ones
    // are converted from markdown here — not the whole thread for twenty.
    for (let i = thread.length - 1; i >= 0 && out.length < LIVE_HISTORY_MESSAGES; i--) {
      const message = thread[i]!;
      if (message.role !== 'user' && message.role !== 'agent') continue;
      // A peer agent's injected turn is not the user speaking.
      if (message.role === 'user' && message.origin) continue;
      const html = message.content + (message.text ? agentTextHtml(message.text, currentHighlighterVersion()) : '');
      const text = plain(html).replace(/\s+/g, ' ').trim().slice(0, LIVE_HISTORY_CHARS);
      if (text) out.push({ role: message.role === 'user' ? 'user' : 'assistant', text });
    }
    return out.reverse();
  }, []);

  const gptLive = useGptLive({
    onDelegation: ({ id, request, context, consumed }) => {
      // The request becomes the mission's user message: its live bubbles go,
      // or the thread would show the same words twice.
      const gone = new Set(consumed.map((turn) => turn.id));
      if (gone.size > 0) setMessages((m) => m.filter((message) => !gone.has(message.id)));
      undelegatedTurn.current = null;
      liveDelegations.current.push({
        id,
        before: new Set(messagesRef.current.map((message) => message.id)),
        started: false,
      });
      voiceTurnText.current = request;
      voiceTurnContext.current = context;
      void sendRef.current();
    },
    onJournal: (turns) => {
      const thread = liveThread.current;
      if (!thread) return;
      journalQueue.current.push(...turns.map((turn) => ({ turn, thread })));
      void flushJournal();
    },
    history: liveHistory,
  });
  const { reply: gptLiveReply, inform: gptLiveInform, state: gptLiveState, start: gptLiveStart, stop: gptLiveStop, turns: gptLiveTurns } = gptLive;
  gptLiveStopRef.current = gptLiveStop;

  // Live bubbles: every turn still open or held is drawn in the thread as it
  // is heard, at the place it began; the journal echo lands on the same id.
  useEffect(() => {
    if (gptLiveTurns.visible.length === 0) return;
    setMessages((m) => {
      let next = m;
      for (const turn of gptLiveTurns.visible) {
        // Read-aloud agent answer: the written bubble above already says it.
        if (turn.relay) continue;
        const content = voiceBubbleHtml(turn.text);
        if (!turnText(turn)) continue;
        const at = next.findIndex((message) => message.id === turn.id);
        if (at >= 0) {
          if (next[at]!.content === content) continue;
          next = next.map((message, i) => (i === at ? { ...message, content } : message));
        } else {
          next = [...next, {
            id: turn.id,
            role: turn.speaker === 'user' ? 'user' : 'agent',
            voice: turn.speaker,
            t: fmtTimeAt(Date.now()),
            content,
          }];
        }
      }
      return next;
    });
  }, [gptLiveTurns]);

  useEffect(() => {
    const head = liveDelegations.current[0];
    if (!head) return;
    if (thinking) { head.started = true; return; }
    if (!head.started) return;
    liveDelegations.current.shift();
    undelegatedTurn.current = null;
    const text = spokenAnswer(answerSince(messages, head.before), (fragment) => new DOMParser().parseFromString(fragment, 'text/html').body.textContent ?? '');
    gptLiveReply(head.id, text || 'The agent finished without a written answer.', !!text);
  }, [thinking, messages, gptLiveReply]);

  useEffect(() => {
    const step = relayStep(undelegatedTurn.current, {
      live: gptLiveState === 'live',
      thinking,
      delegationPending: liveDelegations.current.length > 0,
      messages,
    }, (fragment) => new DOMParser().parseFromString(fragment, 'text/html').body.textContent ?? '');
    undelegatedTurn.current = step.watch;
    if (step.relay) gptLiveInform(step.relay);
  }, [thinking, messages, gptLiveState, gptLiveInform]);

  useEffect(() => {
    if (gptLive.error) toast.error(gptLive.error);
  }, [gptLive.error]);

  const toggleGptLive = useCallback(() => {
    if (gptLiveState !== 'idle') { gptLiveStop(); return; }
    liveDelegations.current = [];
    undelegatedTurn.current = null;
    liveThread.current = { id: activeMissionId.current };
    void gptLiveStart();
  }, [gptLiveState, gptLiveStop, gptLiveStart]);

  const composerGptLive = gptLiveStatus?.enabled && gptLiveStatus.hasKey
    ? { state: gptLiveState, toggle: toggleGptLive }
    : null;

  /** In-flight tools = tool_use whose tool_result hasn't arrived yet, in
   *  the last agent bubble.
   *
   *  Guarded by `thinking` (= the orchestrator's `turn_active`, its
   *  authoritative in-memory turn state). Without this guard, opening a
   *  mission whose last turn was killed mid-Bash (interruption,
   *  rate-limit, kill) would display a tool_use forever without a result
   *  — and since `startedAt` is the event's original time, the bar would
   *  announce "Bash · 14h23m" on a mission that ended yesterday. An
   *  inactive turn can't have anything in flight. */
  const runningTools = useMemo(() => {
    if (!thinking) return [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== 'agent') continue;
      if (!m.tools?.length) return [];
      return m.tools.filter((t) => !t.result);
    }
    return [];
  }, [messages, thinking]);

  /** The bubble the turn is currently filling, when it has a call in flight.
   *
   *  Strictly the LAST message: the inline indicator is drawn inside a bubble,
   *  so a bubble with something below it (a permission card, a peer's message)
   *  is no longer where the eye expects the live state.
   */
  const liveBubbleId = useMemo(() => {
    if (!thinking) return null;
    const last = messages[messages.length - 1];
    // A bubble with tools, not a bubble with a call IN FLIGHT: between a
    // tool_result and the model's next token nothing is running, and the
    // stricter test would hand the wait back to the "thinking" bubble for
    // those seconds — the extra bubble, blinking once per round-trip.
    return last?.role === 'agent' && (last.tools?.length ?? 0) > 0 ? last.id : null;
  }, [messages, thinking]);

  /** Stacked shows the running call INSIDE the bubble, with its own timer.
   *  The two surfaces that said the same thing from outside — the "thinking"
   *  bubble and the amber bar above the composer — stand down for as long as
   *  it does. They come back untouched for the other two modes, and for a
   *  turn whose in-flight calls aren't in the last bubble. */
  const inlineRunning = !setup && appearance.toolCalls === 'stacked' && liveBubbleId !== null;

  // The mission rail shows the SAME full project list whatever mission is open.
  // Project of the tooling panels. Same derivation as in the mission sheet,
  // where each block redid it for itself: the agent's project, otherwise the
  // prefix of a `<project>.<role>` name.
  const railSlug = useMemo(
    () => projectSlugOf(agent.project, agentId),
    [agent.project, agentId],
  );

  // Recency order only (see refreshMissions): the open mission keeps its place.
  const railMissions = missions;

  /** The terminal a permission card pastes into: the same scope the floating
   *  window computes for this view (its project, else the agent). */
  const terminalScope = useMemo(() => scopeOfView(agent.project ?? null, agentId || null), [agent.project, agentId]);

  // Same rule as the missions rail (cf. `agentRoleKey` in lib/roles):
  // explicit role from the config, falls back to the name's suffix.
  // `agent.kind` was never a role ('live'/'ephemeral') — it's not used
  // here anymore.
  const agentRole = useMemo(
    () => agentRoleKey(agent.role),
    [agent.name, agent.role],
  );
  const projectMeta = useProjectMeta();
  // Identity of the OTHER agents whose messages land in this thread
  // (wake, mission return): same face as in the inbox.
  const { identityOf, agents: knownAgents } = useAgentIdentities({ daemonAsMain: true });
  const project = agent.project ? projectMeta.get(agent.project) ?? null : null;
  const projectIcon = project?.icon ?? null;
  const projectColor = project?.color ?? null;
  // Accent used by bubble avatars / permission cards. Prefer an explicit
  // agent colour, then the PROJECT colour (so an agent inherits its
  // project's identity, e.g. contoso's blue), and only then a hashed
  // palette fallback. Without the project step the avatar showed a random
  // green instead of the project hue.
  // Open browser sidepanel: it eats into the chat's usable width (it
  // covers when floating, it pushes when pinned). Either way the
  // three-column desktop layout no longer holds — we fall back to the
  // mobile one: the right rail is brought back as a tab of the left
  // sidebar, bubbles full width. A media query can't see this: the
  // viewport itself hasn't moved.
  const narrow = !compact && !inIsland && browserPanelOpen;
  // `compact` does two distinct things: hide the chrome (top bar, rails,
  // mission panel) AND densify the thread. The cockpit wants the first
  // without the second — it has no chrome of its own, but it has all the
  // room of a real chat. `dense` therefore isolates the density, `compact`
  // keeps the chrome.
  const dense = compact && !chromeComplet;

  // Missions delegated by THIS conversation whose return has not come back.
  // Read here and only here: the rail card and the thread banner share the
  // list (`ChatRailValue`), with no second network call.
  const delegations = useDelegations(currentMissionId);

  // From a panel, picking or starting a conversation also closes it: on a
  // narrow chat it covers the thread the user is going to.
  const choisirMission = useCallback((id: string, permId?: string | null) => {
    pickMission(id, permId);
    setPanneauOuvert(null);
  }, [pickMission]);
  const nouvelleConversation = useCallback(() => {
    newConversation();
    setPanneauOuvert(null);
  }, [newConversation]);
  // The New buttons' agent picker (TODO #344): the agents of the project, the
  // page's chat only — an embedded chat does not own the address bar.
  const newMission = useMemo<NewMissionOptions | null>(() => {
    if (forcedAgent || forcedMission || compact) return null;
    const choices = newMissionAgents(knownAgents, agent.project, agentId);
    if (choices.length < 2) return null;
    return {
      choices,
      identityOf,
      onPick: (name: string) => {
        setPanneauOuvert(null);
        openChat(newMissionHref(name), router);
      },
    };
  }, [forcedAgent, forcedMission, compact, knownAgents, agent.project, agentId, identityOf, router]);
  // What the three rail panels used to receive as props. A widget is mounted by
  // the host without props: state therefore goes through a context, and
  // memoisation avoids re-rendering the three cards on every keystroke.
  const railValue = useMemo<ChatRailValue>(
    () => ({
      agentId,
      agent,
      slug: railSlug,
      agentRole,
      projectColor,
      projectIcon,
      missions: railMissions,
      delegations,
      currentMissionId,
      thinking,
      onPick: choisirMission,
      onNew: nouvelleConversation,
      newMission,
      onKill: killMission,
    }),
    [agentId, agent, railSlug, agentRole, projectColor, projectIcon, railMissions, delegations, currentMissionId, thinking, choisirMission, nouvelleConversation, newMission, killMission],
  );

  // What only the mission sheet reads: a separate memo so the cost and tokens,
  // which move on every stream event, do not re-render the mission list.
  const railInfo = useMemo(
    () => ({
      currentSessionId,
      stats,
      agentTodos,
      allSkills,
      onToggleSkill: toggleSkill,
      allMcp,
      onToggleMcp: toggleMcp,
    }),
    [currentSessionId, stats, agentTodos, allSkills, toggleSkill, allMcp, toggleMcp],
  );
  useLayoutEffect(() => {
    if (!chrome) return;
    chrome.setRail({ value: railValue, info: railInfo });
  }, [chrome, railValue, railInfo]);
  useLayoutEffect(() => {
    if (!chrome) return;
    return () => chrome.setRail(null);
  }, [chrome]);

  // Which zone sits on which side: a property of the layout, not of this file.
  // The chrome (position, gutter, icon) follows the SIDE; what it holds
  // follows the ZONE. Swapping the two columns therefore swaps the cards
  // without touching the rest.
  //
  // A column only exists if it holds something: the thread's gutter follows,
  // otherwise a rail emptied of its cards would leave a 300 px blank.
  // Across all tabs: an empty shown tab does not take the column away. Widths
  // come from the layout, then from the room the chat has (`planifierRails`).
  const rails = useChatRailsLayout(colonnes, { compact });
  const zoneGauche = rails.gauche.colonne;
  const zoneDroite = rails.droite.colonne;
  const colonneGaucheOccupee = rails.gauche.occupee;
  const colonneDroiteOccupee = rails.droite.occupee;
  // Focus mode sits ON TOP of the collapse, it does not write it: leaving it
  // gives the screen back exactly as it was on entry, collapsed column
  // included. It gives way to layout editing and to a drag in progress — cards
  // are not filed into a column that was moved off screen.
  const focus = appearance.focusMode && widgetDragging === null && !layoutEditing;
  // A narrow chat shows its columns as panels of the island, one open at a
  // time; widening the chat closes whatever was open.
  useEffect(() => { if (!rails.tiroir) setPanneauOuvert(null); }, [rails.tiroir]);
  const missionsAutorisees = useChatMissionsAllowed();
  // The missions list keeps a way in when the user took its card out of both
  // columns (moved it elsewhere, or removed it). Not when the role has no right
  // to the card: that is why it is in no column.
  const missionsEnColonne = [rails.gauche, rails.droite].some((c) =>
    c.visible && c.rails.some((r) => r.onglets.some((z) => widgetsOf(z).some((w) => w.id === MISSIONS_WIDGET_ID))));
  /**
   * What the columns look like, given whether this chat holds the zones (Q10).
   * Computed where the page's own flag is read synchronously: a chat that
   * mounted its zones for one commit after losing them would put every card
   * twice under the same dnd-kit id.
   */
  const disposition = (holdsZones: boolean) => {
    // Not the primary chat: its columns are triggers only, as on a narrow chat.
    const passif = !compact && !holdsZones;
    const tiroir = rails.tiroir || passif;
    return {
      passif,
      tiroir,
      railGaucheVisible: rails.gauche.visible && !tiroir,
      railDroitVisible: rails.droite.visible && !tiroir,
      panneau: tiroir && !compact && !passif ? panneauOuvert : null,
      accesMissions: tiroir && !compact && !missionsEnColonne && missionsAutorisees,
    };
  };
  // A trigger of a passive chat: the click already focused its island, which
  // makes it primary. The panel opens only if that chat is narrow; wide, its
  // columns simply come back beside the thread.
  const ouvrirPanneau = (cible: 'left' | 'right' | 'missions') => {
    if (!rails.tiroir) return;
    setPanneauOuvert((p) => (p === cible ? null : cible));
  };

  // The agent's head follows its picked mode (`config.avatar`), like every
  // view that goes through `AgentAvatar` (docs/AGENT-AVATAR.md).
  const face = useMemo(() => agentIdentity(agent, project), [agent, project]);
  const accentColor = face.accent;
  const avatarIconUrl = face.iconUrl;
  const avatarFallback = face.fallback;
  const storedFace = useAgentLiveState(face.look ? agent.name : null);
  // The bubble being written, or the "thinking" bubble that stands for it; an
  // inline turn writes into its last message instead.
  const writing = Boolean(streamText) || (thinking && !inlineRunning);
  const liveBubble = useMemo(() => liveBubbleOf(messages, writing), [messages, writing]);
  const faceState = bubbleState(activityState({ busy: thinking, tool: thinking ? thinkingHint : null, awaitingUser }), storedFace);
  const bubbleFace = useMemo<BubbleFace>(
    () => ({ agent: agent.name, look: face.look ?? null, live: liveBubble, state: faceState }),
    [agent.name, face.look, liveBubble, faceState],
  );

  const body = (<ComposerReplyProvider value={replyApi}>
      {/* The Working agents widget reads this chat's agent from the address
          and keeps its tab on screen. Hidden in compact mode (multichat grid
          cell), and painted by the page's chrome when there is one. */}
      {!compact && !inIsland && !chrome && (
        <TopBar collapsed={headerCollapsed} />
      )}

      {/* Single column on mobile (chat only); the left/right rails float
          `fixed` over the central column from lg onward (like on
          /agents), the central column just reserves their width as
          padding. Narrower, each one is a panel of the island (`PanneauTiroir`).
          In compact mode, only the central column is rendered. */}
      <ChatRailProvider value={railValue} info={railInfo}>
      <ChatIslandHost embedded={compact || inIsland || !!chrome}>
      <IslandRoutePrimary>{(routePrimary) => {
      const holdsZones = inIsland ? primary : routePrimary;
      const { passif, tiroir, railGaucheVisible, railDroitVisible, panneau, accesMissions } = disposition(holdsZones);
      // The thread's width: the reading column (centred, capped) unless the
      // columns are out of the way or the room beside them is slim, then the
      // whole of it. Measured from the island, not the viewport: a chat in a
      // half-screen island is as tight as a phone.
      const largeurFil = rails.disponible
        - (railGaucheVisible ? rails.gauche.gouttiere : 0)
        - (railDroitVisible ? rails.droite.gouttiere : 0);
      // The setup conversation has no columns: its text keeps the setup composer's width.
      // A reading width chosen by the user keeps the thread centred and capped
      // whatever the columns do; only a phone-narrow chat still takes it all.
      const filChoisi = setup || dense ? undefined : colonnes.fil;
      const larg = !setup && (narrow || (!dense && filChoisi === undefined && rails.disponible > 0
        && ((!railGaucheVisible && !railDroitVisible) || largeurFil < LARGEUR_FIL_PLEINE)));
      // A thread as slim as a phone, whatever the window: the `md:`/`lg:`
      // gutters and the avatar grid read the viewport, so a narrow island on
      // a wide screen kept 24px margins and 150px bubbles. Unmeasured (0)
      // means not narrow, or every first paint would flicker compact. The
      // island's width, not `largeurFil`: floating columns keep the thread at
      // 480px minimum, and a laptop with both open must stay a desktop chat.
      const etroit = !dense && rails.disponible > 0 && rails.disponible < FIL_ETROIT;
      // The side margin follows the same measure. Once the columns fold into
      // panels for want of room (`rails.tiroir`), the thread and the composer
      // take the island's whole width: no margin left, the scrollbar on the
      // island's edge, the composer's card edge to edge. With the columns
      // floating, 12px while the thread is slimmer than LARGEUR_FIL_PLEINE
      // (a 24px gutter there only eats text), the viewport's steps beyond.
      // Unmeasured (0), the viewport decides alone. 24px from
      // LARGEUR_FIL_PLEINE exactly: the capped thread's `+48px` below assumes it.
      const margeChat = dense || rails.disponible === 0 ? MARGE_VIEWPORT
        : rails.tiroir ? MARGE_NULLE
          : largeurFil < LARGEUR_FIL_PLEINE ? MARGE_MOYENNE
            : MARGE_VIEWPORT;
      // Room to spare: the column grows with the thread, keeping a margin
      // each side, rather than sit at 780px in the middle of wide margins.
      const colonneMax = setup
        ? SETUP_COLONNE
        : filChoisi ?? Math.min(COLONNE_GRANDE, Math.max(COLONNE_STANDARD, Math.round(largeurFil - MARGES_FIL)));
      // The reading column's edges can be dragged wherever the thread floats
      // between columns: not in a panel layout, a grid cell or the setup.
      const filRedimensionnable = !compact && !dense && !setup && !narrow && !tiroir;
      return (<>
      {!inIsland && <SignalerFocus onChange={setPageFocused} />}
      {/* The three panels register while the chat is on screen: outside this
          page, the chat zones do not exist. Only the
          primary chat of the view registers them (Q10). */}
      {!compact && !passif && <ChatRailWidgets />}
      <div ref={rails.mesurer} className="relative min-h-0 flex-1 overflow-hidden">
        {!compact && !inIsland && <ChatIslandUnderlay />}
        {/* The columns on each side, from the edge towards the thread. The
            right one takes the place of the mission sheet, whose blocks it now
            carries — one per card. Emptied of everything, a column paints
            nothing and the thread gets the width back. */}
        {!passif && ([rails.gauche, rails.droite] as const).map((cote) => cote.visible && cote.rails.map((rail) => {
          const colonne = i18n(cote.cote === 'left' ? 'chatPage.leftRail' : 'chatPage.rightRail');
          const label = rail.seconde ? i18n('chatPage.secondColumn', { column: colonne }) : colonne;
          if (tiroir) {
            // A panel: the column's real tabs and cards, none of the wide
            // screen's chrome (collapse, width, second column).
            return (
              <ChatWidgetRail
                key={rail.zone}
                zone={rail.zone}
                slot={rail.slot}
                onglets={rail.onglets}
                actif={rail.actif}
                noms={rail.noms}
                cote={cote.cote}
                label={label}
                onSwap={inverserColonnes}
                onSelectTab={(z: string) => choisirOngletColonne(cote.colonne, z)}
                onAddTab={() => ajouterOngletColonne(cote.colonne)}
                onCloseTab={(z: string) => fermerOngletColonne(cote.colonne, z)}
                tiroir={{
                  id: `chat-panel-${cote.cote}`,
                  ouvert: panneau === cote.cote,
                  onFermer: fermerPanneau,
                  largeur: rail.largeur,
                }}
              />
            );
          }
          // A second column is one zone and nothing else: its tabs, its
          // collapse and the swap belong to the column it sits beside.
          return (
            <ChatWidgetRail
              key={rail.zone}
              zone={rail.zone}
              slot={rail.slot}
              onglets={rail.onglets}
              actif={rail.actif}
              noms={rail.noms}
              cote={cote.cote}
              label={label}
              {...(rail.seconde ? {
                onRemoveColumn: () => retirerSecondeColonne(cote.colonne),
              } : {
                onCollapse: () => basculerColonne(cote.colonne),
                onSwap: inverserColonnes,
                onSelectTab: (z: string) => choisirOngletColonne(cote.colonne, z),
                onAddTab: () => ajouterOngletColonne(cote.colonne),
                onCloseTab: (z: string) => fermerOngletColonne(cote.colonne, z),
                onAddColumn: cote.aSeconde ? undefined : () => ajouterSecondeColonne(cote.colonne),
              })}
              ecartee={focus}
              decalage={rail.decalage}
              redimension={(() => {
                // The same rank on the other side — a column mirrors a column,
                // a second column a second column — so the screen stays
                // symmetrical. Ctrl resizes this one alone (`PoigneeLargeur`).
                const autre = cote.cote === 'left' ? rails.droite : rails.gauche;
                const jumelle = autre.visible ? autre.rails.find((r) => r.seconde === rail.seconde) : undefined;
                return {
                  largeur: rail.largeur,
                  max: rail.max,
                  ...(jumelle ? { jumelle: { largeur: jumelle.largeur, max: jumelle.max } } : {}),
                  onChange: (largeur: number, persist: boolean, miroir: number | null) => poserLargeursColonnes(
                    jumelle && miroir !== null ? [[rail.zone, largeur], [jumelle.zone, miroir]] : [[rail.zone, largeur]],
                    persist,
                  ),
                  onReset: () => poserLargeurColonne(rail.zone, null),
                };
              })()}
              className="top-[calc(var(--timon-topbar-h)+16px)] bottom-4"
              // The pinned browser already shrinks the containing shell.
              style={cote.cote === 'left'
                ? { left: `calc(var(--timon-nav-w) + ${16 + rail.decalage}px)`, width: rail.largeur }
                : { right: 16 + rail.decalage, width: rail.largeur }}
            />
          );
        }))}

        {/* Collapsed column: the only trace left on screen, a floating pill at
            its column's anchor. One per side — otherwise collapsing the right
            one was a gesture with no way back. It only shows if the column
            had something to show: expanding an empty column would render
            nothing. Desktop only — on mobile the rail already lives in a
            drawer, there is nothing to collapse. */}
        {!compact && !tiroir && !focus && estMasquee(colonnes, zoneGauche) && colonneGaucheOccupee && (
          <button
            type="button"
            onClick={() => basculerColonne(zoneGauche)}
            aria-label={i18n('chatPage.showRail')}
            title={i18n('chatPage.showRail')}
            // z-20 and not z-[6] like the rail: the pill falls INSIDE the
            // thread's scroll zone (`relative z-10`), which covered it and
            // swallowed the click. The rail itself lives in the thread's
            // left padding and never crosses this layer.
            className={cn(PASTILLE_COLONNE, 'left-[calc(var(--timon-nav-w)+16px)]')}
          >
            <PanelLeftOpen className="size-4" />
          </button>
        )}

        {!compact && !tiroir && !focus && estMasquee(colonnes, zoneDroite) && colonneDroiteOccupee && (
          <button
            type="button"
            onClick={() => basculerColonne(zoneDroite)}
            aria-label={i18n('chatPage.showRail')}
            title={i18n('chatPage.showRail')}
            className={cn(PASTILLE_COLONNE, ANCRE_DROITE)}
          >
            <PanelRightOpen className="size-4" />
          </button>
        )}

        {accesMissions && (
          <PanneauTiroir
            id="chat-panel-missions"
            cote="left"
            label={i18n('chatPage.missionsPanel')}
            ouvert={panneau === 'missions'}
            onFermer={fermerPanneau}
            largeur={340}
          >
            <ChatMissionsList />
          </PanneauTiroir>
        )}

        {/* Under an open panel, the rest of the island: a tap there closes it.
            Inside the island only — the topbar and the nav stay usable. */}
        {panneau !== null && (
          <div
            aria-hidden
            onClick={fermerPanneau}
            className="absolute inset-y-0 left-[var(--timon-nav-w)] right-0 z-[25] bg-black/25 md:bottom-[var(--timon-island-gap)] md:right-[var(--timon-island-gap)] md:rounded-[var(--timon-island-radius)]"
          />
        )}

        <div className={cn(
          "relative flex h-full min-h-0 flex-col",
          !compact && "chat-thread-layout",
          // Unconditional pl: the vertical nav (VerticalNav) is a fixed
          // rail always visible, even on mobile — cf. `lg:pl-[calc(...)]`
          // which takes over as soon as the left column also floats on top.
          // Formula derived from `--timon-nav-w` (not a constant): when
          // the nav is pinned expanded, its width goes from 56px to 224px
          // and the padding must follow, otherwise the widened nav
          // overlaps the missions sidebar instead of resizing the whole
          // layout.
          !compact && "pl-[var(--timon-nav-w)]",
          // Collapsed rail: nothing left to reserve on the left, the
          // thread recovers the whole column (that's the entire point of
          // the gesture with the browser deployed). The vertical nav
          // itself remains always reserved.
          // The gutter shrinks at the same pace as the column slides: two
          // different durations would show as a lag.
          !compact && "transition-[padding] duration-200 ease-out motion-reduce:transition-none",
          // The horizontal margin shared by the thread, the bars above the
          // input and the composer: one variable, so they can't drift apart.
          margeChat,
          railGaucheVisible && !focus && "lg:pl-[calc(var(--timon-nav-w)+var(--chat-gutter-left))]",
          // The right-hand columns only reserve their width when they hold a
          // card.
          railDroitVisible && !focus && "lg:pr-[var(--chat-gutter-right)]",
        )}
        style={{
          '--chat-gutter-left': `${rails.gauche.gouttiere}px`,
          '--chat-gutter-right': `${rails.droite.gouttiere}px`,
          '--chat-col': `${colonneMax}px`,
        } as CSSProperties}
        // Read by the widget card's CSS (globals.css): a chat in a widget
        // takes its margins from the card, bordered or not.
        data-chat-shell="">
          {/* Glass, widgets scope: the reading column is one frosted card,
              the thread's own box at every width (globals.css). */}
          {!compact && !dense && (
            <div aria-hidden className="timon-glass-chat-card">
              <div className={cn('mx-auto w-[calc(100%-var(--chat-pad)*2)]', !larg && 'max-w-[calc(var(--chat-col,780px)+48px)]')} />
            </div>
          )}
          {filRedimensionnable && (
            // Over the thread, under nothing: the edges sit just outside the
            // scroll box, clear of its scrollbar. The box follows the padding
            // of this column, which is what centres the thread.
            <div className="pointer-events-none absolute inset-y-0 z-20 hidden lg:block"
              style={{
                left: `calc(var(--timon-nav-w, 0px) + ${railGaucheVisible && !focus ? 'var(--chat-gutter-left)' : '0px'})`,
                right: railDroitVisible && !focus ? 'var(--chat-gutter-right)' : '0px',
              }}>
              <PoigneesFil onChange={(largeur, persist) => poserFil(largeur, persist)} onReset={() => poserFil(null)} />
            </div>
          )}
          <div ref={scrollRef} className={cn(
            // The bar appears under the pointer and nowhere else. Hidden
            // outright, it read cleanly but left no way to jump to a precise
            // point of a long thread — the wheel only ever moves relative to
            // where one already is. On touch, where there is no hover, the
            // system's own overlay bar takes over (cf. `scrollbar-hover`).
            "relative z-10 min-w-0 flex-1 overflow-auto overscroll-contain scrollbar-hover",
            // A scrollbar always sits on the edge of the element that
            // scrolls. Scrolling the full-width zone put it against the right
            // rail, far from the text and barely noticeable; capping this box
            // at the reading column's width brings it alongside the thread.
            // 780px of text + the 24px gutters it already had on each side.
            // `w-full` too: auto margins on a flex-column item cancel its
            // stretch, and a thread of short messages then shrank to its
            // content instead of matching the composer below.
            // Same horizontal margin as the composer's container (`--chat-pad`,
            // set on the column), so the scrollbar, which sits on this box's
            // edge, stays inside the composer's edges at every width — not
            // only once the column is capped.
            !dense && "mx-auto w-[calc(100%-var(--chat-pad)*2)]",
            !dense && !larg && "max-w-[calc(var(--chat-col,780px)+48px)]",
            // The bar lives in the PADDING box, never in the border: a
            // transparent top border is what pushes it clear of the topbar.
            // `margin` on ::-webkit-scrollbar-track is ignored, this is not.
            !dense && "border-t-[10px] border-t-transparent",
            // Never under 6px for the text itself: with no margin left, the
            // bubbles would touch the scrollbar and the island's edge.
            dense ? "px-0" : "px-[max(6px,var(--chat-pad))]",
            // pb-12: past the 40px bottom fade, so the last message (and its
            // copy / read-aloud row) can be scrolled up out of the gradient.
            dense ? "pt-2 pb-2" : "pt-3 pb-12 md:pt-6",
            // The fade is a mask, and a mask hides the scrollbar with the rest:
            // `chat-thread-fade` keeps a solid strip over the scrollbar column
            // (globals.css), so the bar stays fully visible under the gradients.
            compact ? "chat-thread-fade-top" : "chat-thread-fade",
          )}>
            {!dense && <DayDivider label="Today" />}
            <BlockResizeContext.Provider value={blockResize}>
            <ChatDocumentHostProvider value={documentHost}>
            <div className={cn(
              "flex w-full min-w-0 flex-col gap-4",
              dense ? "px-1" : !larg && "mx-auto max-w-[var(--chat-col,780px)]",
            )}>
              {messages.length === 0 && !thinking && (
                <p className="my-12 text-center text-[12.5px] text-muted-foreground/70">
                  {freshStart.current
                    ? 'New conversation. Type a message to start.'
                    : `No messages in this mission — start the conversation with ${agent.name}.`}
                </p>
              )}
              {(threadStart > 0 || hasOlderHistory) && (
                <button
                  type="button"
                  onClick={showOlderMessages}
                  disabled={threadStart === 0 && loadingOlderHistory}
                  className="mx-auto rounded-full border border-border bg-background/80 px-3 py-1 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/40 hover:text-foreground disabled:opacity-60"
                >
                  {threadStart > 0
                    ? i18n('chatPage.showOlderMessages', { count: threadStart })
                    : loadingOlderHistory ? i18n('chatPage.loadingOlderMessages') : i18n('chatPage.loadOlderMessages')}
                </button>
              )}
              {messages.slice(threadStart).filter((m) => !(setup && m.id === firstUserId)).map((m) => (
                <Message
                  key={m.id}
                  msg={m}
                  missionId={currentMissionId}
                  agentName={agent.name}
                  accent={accentColor}
                  highlighted={Boolean(
                    highlightedPermId && (m.perm?.request_id ?? m.cmd?.id ?? m.proposal?.id ?? m.secretRequest?.id) === highlightedPermId,
                  )}
                  terminalScope={terminalScope}
                  iconUrl={avatarIconUrl}
                  iconFallback={avatarFallback}
                  roleKey={agentRole}
                  identityOf={identityOf}
                  compact={dense || etroit}
                  wide={larg}
                  live={inlineRunning && m.id === liveBubbleId}
                  hideToolNoise={setup}
                  owner={shownOwner}
                  onRetryTurn={m.id === retryableLineId ? retryTurn : undefined}
                />
              ))}
              {streamText && (
                <StreamingBubble
                  agentName={agent.name}
                  accent={accentColor}
                  text={streamText}
                  iconUrl={avatarIconUrl}
                  iconFallback={avatarFallback}
                  roleKey={agentRole}
                  compact={dense || etroit}
                  wide={larg}
                />
              )}
              {/* The in-flight bubble IS the proof of life: keeping
                  "thinking" below it would make two indicators for one
                  turn. */}
              {/* Setup: the bare "thinking" is its one sign of life, and none
                  at all while a card waits for the person — the card is the
                  agent's turn. */}
              {thinking && !streamText && !inlineRunning && !(setup && awaitingUser) && (
                <Thinking
                  agentName={agent.name}
                  accent={accentColor}
                  hint={setup ? null : thinkingHint}
                  iconUrl={avatarIconUrl}
                  iconFallback={avatarFallback}
                  roleKey={agentRole}
                  compact={dense || etroit}
                  wide={larg}
                />
              )}
            </div>
            </ChatDocumentHostProvider>
            </BlockResizeContext.Provider>
          </div>

          {/* Narrow chat: one trigger per column that holds something, on its
              own side, plus the missions list when no column holds it. Sat
              right under the thread, above the running-tool and delegation
              bars so it never covers them, out of the thread's way: the zero-height
              row costs no layout, and the thread's bottom padding keeps its
              last line clear of them. */}
          {tiroir && !compact && (
            <div className="relative z-20 h-0">
              {(rails.gauche.visible || accesMissions) && (
                // This strip sits in the column's flow, past its nav padding:
                // adding `--timon-nav-w` again pushed the buttons 56px in on desktop.
                <div className="absolute bottom-1 left-1.5 flex gap-1">
                  {rails.gauche.visible && (
                    <DeclencheurPanneau
                      cible="chat-panel-left"
                      label={i18n('chatPage.openLeftColumn')}
                      ouvert={panneau === 'left'}
                      onClick={() => ouvrirPanneau('left')}
                    >
                      <PanelLeftOpen className="size-4" />
                    </DeclencheurPanneau>
                  )}
                  {accesMissions && (
                    <DeclencheurPanneau
                      cible="chat-panel-missions"
                      label={i18n('chatPage.openMissions')}
                      ouvert={panneau === 'missions'}
                      onClick={() => ouvrirPanneau('missions')}
                    >
                      <Menu className="size-4" />
                    </DeclencheurPanneau>
                  )}
                </div>
              )}
              {rails.droite.visible && (
                <div className="absolute bottom-1 right-1.5 md:right-[calc(var(--timon-island-gap)+6px)]">
                  <DeclencheurPanneau
                    cible="chat-panel-right"
                    label={i18n('chatPage.openRightColumn')}
                    ouvert={panneau === 'right'}
                    onClick={() => ouvrirPanneau('right')}
                  >
                    <PanelRightOpen className="size-4" />
                  </DeclencheurPanneau>
                </div>
              )}
            </div>
          )}

          {llmProgress && <LlmSwitchProgressBar progress={llmProgress} compact={dense} />}

          {/* What is running, docked on the composer's tab: the tool in
              flight, then what the pilot still waits for (the same hook as
              the rail's card). */}
          <ComposerTrays compact={dense} wide={larg}>
            <RunningToolBar tools={inlineRunning || setup ? [] : runningTools} compact={dense} />
            <DelegationsBar delegations={delegations} compact={dense} />
          </ComposerTrays>



          {gptLiveState !== 'idle' && (
            <GptLiveStage
              turns={gptLiveTurns}
              streams={gptLive.streams}
              waiting={thinking && liveDelegations.current.length > 0}
              compact={dense}
            />
          )}

          {/* The input, its satellites and the limits banner now live in
              `components/chat/composer.tsx`. What the page used to pass it
              comes down through a context: the composer receives no props,
              like the rail cards. */}
          {/* The composer is the occupant of the `chat.composer` slot: the
              page mounts the slot, not the input. */}
          <ChatComposerSlot
            variant={setup ? 'setup' : undefined}
            value={{
              agent,
              liveStats,
              currentMissionId,
              pendingModelOverride,
              pendingBackendOverride,
              effBackend,
              effModel,
              modelSwitching,
              setLlmOpen,
              applyLlm,
              pendingReasoningEffort,
              missionReasoningEffort,
              applyReasoningEffort,
              dense,
              narrow: larg,
              input,
              setInput,
              placeholder,
              send,
              taRef,
              fileRef,
              pendingImages,
              setPendingImages,
              addImageFiles,
              pendingFiles,
              setPendingFiles,
              addAnyFiles,
              attachmentBox: draftOwner,
              capturePastedText,
              setCaret,
              slashOpen,
              slashSuggestions,
              slashSel,
              setSlashSel,
              setSlashDismissed,
              acceptSlash,
              recording,
              toggleDictation,
              dictationUnavailable,
              audioLevels,
              visualiseurActif,
              missionCwd,
              gptLive: composerGptLive,
              thinking,
              stopping,
              turnResumable,
              stopTurn,
              onNewConversation: newConversation,
              newMission,
            }}
          />
        </div>

      </div>
      </>);
      }}</IslandRoutePrimary>
      </ChatIslandHost>
      </ChatRailProvider>

      <LlmDialog
        open={llmOpen}
        onOpenChange={setLlmOpen}
        missionId={currentMissionId}
        // The EFFECTIVE pair for the next turn (mission override
        // included), not the agent's config: it's this one the modal
        // must badge "current" and pre-select.
        currentBackend={effBackend}
        currentModel={effModel}
        // EFFECTIVE value: a level set from the composer bar before the
        // first send must not be overwritten by a pass through the modal.
        currentReasoningEffort={pendingReasoningEffort ?? missionReasoningEffort}
        // The modal is no longer the usual door: the drop-up in the composer
        // bar handles the everyday switch. It keeps `onSwitch` because it is
        // the only surface carrying the hand-typed slug — switching to
        // `claude-opus-4-6` mid-thread must not force a lossy compaction.
        onSwitch={async (backend, model, reasoningEffort) => {
          await applyReasoningEffort(reasoningEffort);
          if (backend === effBackend) await switchMissionModel(model);
          else await switchMissionBackend(backend, model);
        }}
        onPick={(backend, model, reasoningEffort) => {
          // Override reset to null when the choice falls back to the
          // agent's default: no unnecessary per-mission pollution.
          const agentBackend = asBackend(agent.backend);
          setPendingBackendOverride(backend === agentBackend ? null : backend);
          setPendingModelOverride(model && model !== agent.model ? model : null);
          setPendingReasoningEffort(reasoningEffort);
        }}
        switching={modelSwitching}
        thinking={thinking}
        target={{ project: agent.project, agent: agent.name }}
      />




      <style>{`
        /* Allow long URLs/paths/identifiers to wrap inside the bubble
           rather than push the bubble wider than its max-w. The bubble
           itself also has min-w-0 + overflow-hidden as a safety net. */
        .chat-bubble { overflow-wrap: anywhere; word-break: break-word; }
        /* Native Claude Code sub-agent dispatcher call — token disaster.
           Render the citation in destructive colour so the user can
           kill the mission before it cascades. */
        .chat-bubble .subagent-bad {
          color: hsl(var(--destructive));
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .chat-bubble .subagent-call {
          color: hsl(var(--destructive));
        }
        .chat-bubble .subagent-call code {
          color: hsl(var(--destructive)) !important;
        }
        .chat-bubble p { margin: 0 0 8px; }
        .chat-bubble p:last-child { margin: 0; }
        .chat-bubble ul, .chat-bubble ol { margin: 6px 0 6px 18px; padding: 0; }
        .chat-bubble li { margin: 2px 0; }
        .chat-bubble strong { font-weight: 600; color: hsl(var(--foreground)); }
        .chat-bubble em { color: hsl(var(--muted-foreground)); }
        .chat-bubble code {
          /* code-font: inline code */
          font-family: var(--font-mono), monospace; font-size: 12px;
          background: hsl(var(--muted) / 0.6); border: 1px solid hsl(var(--border));
          padding: 1px 5px; border-radius: calc(var(--radius) * 0.4);
        }
        .chat-bubble pre {
          margin: 8px 0 4px; background: hsl(var(--muted) / 0.5);
          border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) * 0.8);
          padding: 10px 12px; overflow: auto;
          /* code-font: code block */
          font: 500 12px var(--font-mono), monospace; line-height: 1.5;
        }
        .chat-bubble a { color: hsl(var(--primary)); }
        /* Code block + copy button. The button is anchored to the WRAPPER
           and not the <pre>: on a horizontally scrollable block, a button
           positioned inside the <pre> would scroll away with the content.
           The margin is carried by the wrapper (the <pre> loses it) so its
           box coincides exactly with the block's, without margin-collapse. */
        .chat-bubble .code-wrap { position: relative; margin: 8px 0 4px; }
        .chat-bubble .code-wrap pre { margin: 0; padding-right: 42px; }
        .chat-bubble .copy-btn {
          position: absolute; top: 6px; right: 6px; z-index: 1;
          display: inline-flex; align-items: center; justify-content: center;
          width: 26px; height: 26px; padding: 0;
          border: 1px solid hsl(var(--border)); border-radius: calc(var(--radius) * 0.6);
          /* Opaque background: in both light and dark theme the button
             stays readable even sitting on an hljs-colored line. */
          background: hsl(var(--background)); color: hsl(var(--muted-foreground));
          cursor: pointer; opacity: 0;
          transition: opacity .12s ease, color .12s ease, border-color .12s ease;
        }
        .chat-bubble .code-wrap:hover .copy-btn,
        .chat-bubble .copy-btn:focus-visible { opacity: 1; }
        .chat-bubble .copy-btn:hover {
          color: hsl(var(--foreground)); border-color: hsl(var(--foreground) / 0.3);
        }
        .chat-bubble .copy-btn svg { width: 14px; height: 14px; }
        .chat-bubble .copy-btn.url-copy {
          position: static; vertical-align: middle;
          width: 24px; height: 24px; margin-inline-start: 4px;
          opacity: 1;
        }
        .chat-bubble .url-copy:focus-visible {
          outline: 2px solid hsl(var(--ring)); outline-offset: 2px;
        }
        .chat-bubble .copy-btn .i-check { display: none; }
        .chat-bubble .copy-btn.copied {
          opacity: 1; color: hsl(var(--success)); border-color: hsl(var(--success) / 0.5);
        }
        .chat-bubble .copy-btn.copied .i-copy { display: none; }
        .chat-bubble .copy-btn.copied .i-check { display: block; }
        /* Without hover (touch), the button stays permanently visible —
           otherwise it would be unreachable. */
        @media (hover: none) {
          .chat-bubble .copy-btn { opacity: 1; }
        }
        /* Tool-use citation line: name + argument on a single row,
           wrapping only when the argument is genuinely too long for the
           bubble width. The old layout was a flex-COLUMN with a dashed
           border-top, which spread the citation across four stacked
           rows and ate huge vertical space on mobile. */
        .chat-bubble .cite {
          font-size: 11.5px; color: hsl(var(--muted-foreground));
          margin-top: 4px;
          display: flex; flex-flow: row wrap;
          align-items: baseline; gap: 6px;
          min-width: 0;
        }
        /* Inline argument: drop the chip styling inherited from the
           generic '.chat-bubble :not(pre) > code' rule so the citation
           reads as quiet metadata, not a callout. */
        .chat-bubble .cite code {
          overflow-wrap: anywhere; word-break: break-word;
          white-space: pre-wrap;
          background: transparent; border: 0; padding: 0;
          font-size: inherit;
        }
        /* Same button, inline version: the citation is a flex row, not a
           positioned block. The full (non-truncated) command is carried by
           data-copy. */
        .chat-bubble .cite .copy-btn {
          position: static; align-self: center;
          width: 18px; height: 18px; border-radius: calc(var(--radius) * 0.4);
          background: transparent; border: 0;
        }
        .chat-bubble .cite .copy-btn svg { width: 12px; height: 12px; }
        .chat-bubble .cite:hover .copy-btn { opacity: 1; }
        /* Grouped tool item inside a same-minute bubble, rendered as a
           <details>/<summary> pair so each call is collapsed by default —
           only the icon and readable tool name show until
           the user opens it. Subtle hairline between items so the eye can
           pick them apart without border-noise dominating the bubble. */
        .chat-bubble .tool-block {
          padding-top: 4px;
        }
        .chat-bubble .tool-block + .tool-block {
          border-top: 1px dashed hsl(var(--border));
          margin-top: 4px;
        }
        .chat-bubble .tool-block .cite {
          margin-top: 4px;
        }
        .chat-bubble .tool-summary {
          display: flex; flex-flow: row nowrap;
          align-items: center; gap: 5px;
          min-width: 0;
          cursor: pointer;
          list-style: none;
          padding: 2px 0;
          border-radius: calc(var(--radius) * 0.4);
          color: hsl(var(--muted-foreground));
        }
        .chat-bubble .tool-summary::-webkit-details-marker { display: none; }
        .chat-bubble .tool-summary:hover {
          color: hsl(var(--foreground));
        }
        .chat-bubble .tool-summary:focus-visible {
          outline: 2px solid hsl(var(--ring));
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-bubble .tool-summary-chevron { transition: none !important; }
        }
        .chat-bubble .tool-summary-chevron {
          transition: transform 0.12s ease;
          color: hsl(var(--muted-foreground) / 0.7);
          /* Caret at the far right of every fold (tools, reasoning,
             automated instructions): down when closed, up when open. */
          order: 99; margin-left: auto;
          transform: rotate(90deg);
        }
        .chat-bubble details[open] > .tool-summary .tool-summary-chevron {
          transform: rotate(-90deg);
        }
        .chat-bubble .tool-summary-name {
          min-width: 0;
          overflow-wrap: anywhere;
          font: 500 11.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          color: hsl(var(--primary));
        }
        .chat-bubble .tool-summary-bad .tool-summary-name {
          color: hsl(var(--destructive));
        }
        .chat-bubble .tool-summary-detail {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-size: 11.5px;
          color: hsl(var(--muted-foreground));
        }
        /* Stacked mode: the whole turn's calls as one row of overlapping
           chips. The overlap is what makes eleven calls read as "a handful"
           rather than a list.
           The row does NOT spread on hover, and that is deliberate: shifting
           every chip by 8px the moment the pointer enters the row slides the
           chips UNDER the cursor (the third one travels 24px), so aiming at a
           neighbour kept landing on the previous chip — its tooltip looked
           frozen because it had never been left. The hovered chip lifts
           instead, which moves nothing else. */
        .chat-bubble .tool-stack { padding-top: 4px; }
        .chat-bubble .tool-stack-row {
          display: flex; flex-flow: row wrap; align-items: center;
        }
        .chat-bubble .tool-chip {
          /* Positioned so z-index applies at all: a static element ignores
             it, and the lifted chip stayed under the next one. */
          position: relative;
          display: grid; place-items: center;
          width: 22px; height: 22px;
          margin-left: -7px;
          border-radius: 999px;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--card));
          color: hsl(var(--muted-foreground));
          transition: transform 0.12s ease, color 0.12s ease, border-color 0.12s ease;
        }
        .chat-bubble .tool-chip:first-child { margin-left: 0; }
        .chat-bubble .tool-chip:hover,
        .chat-bubble .tool-chip:focus-visible,
        .chat-bubble .tool-chip-open {
          color: hsl(var(--primary));
          border-color: hsl(var(--primary) / 0.6);
          /* Scale, not translate: the chip grows around its own centre, so
             the pointer stays inside it — no hover flicker at the edges. */
          transform: scale(1.12);
          z-index: 1;
        }
        .chat-bubble .tool-chip-bad { color: hsl(var(--destructive)); }
        .chat-bubble .tool-chip-error {
          border-color: hsl(var(--destructive) / 0.6);
          color: hsl(var(--destructive));
        }
        .chat-bubble .tool-chip:focus-visible {
          outline: 2px solid hsl(var(--ring));
          outline-offset: 2px;
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-bubble .tool-chip { transition: none; }
        }
        /* Call in flight: the chip takes the warning accent and breathes, so
           the stack tells by itself where the turn stands. */
        .chat-bubble .tool-chip-live {
          border-color: hsl(var(--warning) / 0.7);
          color: hsl(var(--warning));
          animation: tool-chip-live 1.4s ease-in-out infinite;
        }
        @keyframes tool-chip-live {
          0%, 100% { box-shadow: 0 0 0 0 hsl(var(--warning) / 0.35); }
          50%      { box-shadow: 0 0 0 3px hsl(var(--warning) / 0); }
        }
        @media (prefers-reduced-motion: reduce) {
          .chat-bubble .tool-chip-live { animation: none; }
        }
        /* The description of the current call, on the same reading line as
           the chips: it replaces the "thinking" bubble and the amber bar above
           the input, which said the same thing in two places the eye had to
           connect by itself. */
        .chat-bubble .tool-stack-live {
          display: flex; flex-flow: row wrap; align-items: center; gap: 6px;
          padding: 4px 0 0;
          font-size: 11.5px;
          color: hsl(var(--warning));
        }
        .chat-bubble .tool-stack-live-name {
          font: 500 11px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          color: hsl(var(--muted-foreground));
        }
        .chat-bubble .tool-stack-live-time {
          font: 400 11px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          font-variant-numeric: tabular-nums;
          color: hsl(var(--muted-foreground));
        }
        .chat-bubble .tool-stack-live-long { color: hsl(var(--warning)); }
        .chat-bubble .tool-stack-live-what {
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          font-weight: 500;
          color: hsl(var(--foreground));
        }
        .chat-bubble .tool-stack-open { margin-top: 10px; }
        .chat-bubble .tool-stack-open-name {
          display: flex; align-items: center; gap: 6px;
          font: 500 11.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          color: hsl(var(--primary));
        }
        /* The panel names the tool itself, in the accent: the citation that
           repeated it in grey, right underneath, said the same word twice. */
        .chat-bubble .tool-stack-open .tool-cite-name { display: none; }
        /* With that line gone, the arguments follow the name directly. The
           18px normally kept above a tool-json reserve room for the copy
           button; here it opened a hole under the name, and the button is
           invisible until hovered anyway — it may overlap the first row's
           right end, where it has always sat once shown. */
        .chat-bubble .tool-stack-open .tool-block-body { padding-top: 2px; }
        .chat-bubble .tool-stack-open .tool-json { margin-top: 0; padding-top: 4px; }
        /* Automated instruction (runtime preamble injected into a user
           message): collapsed it is one grey line, opened it must read as
           an inset quote — hairline + a background one notch darker than
           the bubble — so the machine text never passes for the human's. */
        /* Breathing room above and below, so the fold never touches the
           surrounding text; consecutive folds keep their hairline spacing. */
        .chat-bubble .automatic-instruction { padding-top: 0; margin-block: 10px; }
        /* The label names the block, never quotes it: one line, ellipsised,
           so a legacy free-text header cannot pass for the message itself. */
        .chat-bubble .automatic-instruction > .tool-summary .tool-summary-name {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        /* Opened, the frame's visible edge stays on the message's column, and
           the body starts under the bot icon. */
        .chat-bubble .automatic-instruction[open] {
          margin: 10px 0;
          border: 1px solid hsl(var(--border));
          border-radius: calc(var(--radius) * 0.6);
          background: hsl(var(--foreground) / 0.04);
          padding: 2px 8px 8px;
        }
        .chat-bubble .automatic-instruction[open] > .tool-summary { padding-bottom: 6px; }
        /* Work return card: the task, its outcome and the agent's summary in
           clear; everything written for the pilot stays behind "Details". */
        .chat-bubble .return-card { display: flex; flex-direction: column; gap: 6px; }
        .chat-bubble .return-card-head {
          display: flex; flex-flow: row wrap; align-items: center; gap: 6px;
          min-width: 0;
        }
        .chat-bubble .return-card-type {
          font: 500 10.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          color: hsl(var(--muted-foreground));
          border: 1px solid hsl(var(--border));
          border-radius: 4px;
          padding: 0 5px;
        }
        .chat-bubble .return-card-title {
          min-width: 0;
          font-weight: 600;
          overflow-wrap: anywhere;
        }
        .chat-bubble .return-card-badge {
          border: 1px solid;
          border-radius: 4px;
          padding: 0 6px;
          font: 500 10.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .chat-bubble .return-card-badge.is-success { color: hsl(var(--success)); border-color: hsl(var(--success) / 0.35); background: hsl(var(--success) / 0.1); }
        .chat-bubble .return-card-badge.is-warning { color: hsl(var(--warning)); border-color: hsl(var(--warning) / 0.35); background: hsl(var(--warning) / 0.1); }
        .chat-bubble .return-card-badge.is-danger { color: hsl(var(--destructive)); border-color: hsl(var(--destructive) / 0.35); background: hsl(var(--destructive) / 0.1); }
        .chat-bubble .return-card-badge.is-muted { color: hsl(var(--muted-foreground)); border-color: hsl(var(--border)); }
        .chat-bubble .return-card-chips { display: flex; flex-flow: row wrap; gap: 4px; }
        .chat-bubble .return-card-chip {
          border-radius: 4px;
          padding: 0 6px;
          font: 400 10.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          color: hsl(var(--muted-foreground));
          background: hsl(var(--muted) / 0.6);
        }
        .chat-bubble .return-card-summary > :first-child,
        .chat-bubble .return-card-alert > :nth-child(2),
        .chat-bubble .return-card-findings > :nth-child(2),
        .chat-bubble .return-card-report > :first-child { margin-top: 0; }
        .chat-bubble .return-card-summary > :last-child,
        .chat-bubble .return-card-alert > :last-child,
        .chat-bubble .return-card-findings > :last-child,
        .chat-bubble .return-card-report > :last-child { margin-bottom: 0; }
        .chat-bubble .return-card-alert,
        .chat-bubble .return-card-findings {
          border-left: 2px solid hsl(var(--warning) / 0.6);
          padding-left: 8px;
        }
        .chat-bubble .return-card-alert { border-left-color: hsl(var(--destructive) / 0.6); }
        .chat-bubble .return-card-label {
          font: 500 10.5px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          color: hsl(var(--muted-foreground));
          margin-bottom: 2px;
        }
        .chat-bubble .return-card-details { padding-top: 0; margin-top: -2px; }
        .chat-bubble .automatic-instruction > .tool-block-body > :first-child { margin-top: 0; }
        .chat-bubble .automatic-instruction > .tool-block-body > :last-child { margin-bottom: 0; }
        /* Tool result block: muted by default, red-tinted on is_error so
           failures don't get swallowed by the grouping. Pre wraps long
           lines instead of horizontal-scrolling inside the narrow
           bubble. */
        .chat-bubble .tool-json { position: relative; margin: 2px 0 4px; padding-top: 18px; }
        .chat-bubble .tool-json-scroll { max-height: 320px; overflow: auto; }
        /* code-font: a tool's raw payload, keys and values */
        .chat-bubble .tool-json table { width: 100%; border-collapse: collapse; font: 11.5px/1.5 var(--font-mono), monospace; }
        .chat-bubble .tool-json th, .chat-bubble .tool-json td { padding: 3px 8px; border: 0; text-align: left; vertical-align: top; }
        .chat-bubble .tool-json td { white-space: pre-wrap; overflow-wrap: anywhere; }
        /* width:1% + nowrap = the key column takes exactly the width of the
           longest path and no more. Wrapping was tried and rejected: with
           overflow-wrap:anywhere the min-content width falls to one glyph,
           and the browser then stacks 'result_ count' one letter per line.
           Deep paths are elided in renderToolJson instead. */
        .chat-bubble .tool-json th {
          font-weight: 400; color: hsl(var(--muted-foreground));
          width: 1%; white-space: nowrap;
        }
        /* Zebra: a tint lifted ABOVE the bubble, never surface-sunken —
           that one sits below the canvas and read as a black band. */
        .chat-bubble .tool-json tr:nth-child(even) { background: hsl(var(--foreground) / 0.055); }
        .chat-bubble .tool-result {
          margin: 4px 0 2px;
          border-left: 2px solid hsl(var(--border));
          padding: 0 0 0 8px;
        }
        .chat-bubble .tool-result pre {
          margin: 0;
          padding: 4px 6px;
          background: hsl(var(--surface-sunken));
          border: 1px solid hsl(var(--border));
          border-radius: calc(var(--radius) * 0.6);
          font-size: 11.5px;
          line-height: 1.45;
          white-space: pre-wrap;
          overflow-wrap: anywhere;
          word-break: break-word;
          max-height: 240px;
          overflow: auto;
        }
        .chat-bubble .tool-result-error {
          border-left-color: hsl(var(--destructive));
        }
        .chat-bubble .tool-result-error pre {
          background: hsl(var(--destructive) / 0.08);
          border-color: hsl(var(--destructive) / 0.4);
          color: hsl(var(--destructive));
        }
        .chat-bubble .tool-result-badge {
          display: inline-block;
          margin-bottom: 3px;
          padding: 1px 6px;
          border-radius: calc(var(--radius) * 0.4);
          background: hsl(var(--destructive));
          color: hsl(var(--destructive-foreground));
          font: 600 10px var(--font-sans), system-ui, sans-serif; font-variant-numeric: tabular-nums;
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .chat-bubble .tool-result-empty {
          color: hsl(var(--muted-foreground));
          font-style: italic;
        }
      `}</style>
      <ExternalFileDialog
        path={externalLink}
        onClose={() => setExternalLink(null)}
        onConfirm={(path) => { setExternalLink(null); void openAgentFile(agentId, path, true); }}
      />
  </ComposerReplyProvider>);
  if (chrome) return <BubbleFaceContext.Provider value={bubbleFace}><WithoutChatChrome>{body}</WithoutChatChrome></BubbleFaceContext.Provider>;
  return (
    <BubbleFaceContext.Provider value={bubbleFace}>
    <div
      className={cn(
        "relative z-[1] flex flex-col",
        // Full page: no clip, the topbar reaches over a docked window
        // (topbar.tsx). The content below clips itself.
        compact || inIsland ? "h-full overflow-hidden" : "h-[100dvh]",
      )}
    >
      {body}
    </div>
    </BubbleFaceContext.Provider>
  );
}

function DayDivider({ label }: { label: string }) {
  return (
    <div className="mx-auto mb-4 mt-2 max-w-[var(--chat-col,780px)] px-6 text-center text-[11px] uppercase tracking-[0.06em] text-muted-foreground/70">
      {label}
    </div>
  );
}

/**
 * The box of an agent bubble with no surface. Nothing visible marks its edge,
 * so its content defines the message's single column. On a phone that column is
 * the name's own edge; on desktop the name keeps a slight outdent, a choice of
 * the maintainer's (01/11/2026), so the inset stays.
 *
 * Only the viewport decides, through `sm:`. `compact` must not: it also means a
 * multichat cell or a narrow thread, which are still desktop.
 *
 * The bubble clips, so a zero inset would cut what overflows it on purpose (a
 * lifted chip, a focus ring): the phone's 4px, cancelled by the margin, keep
 * those inside the clip.
 */
const FLAT_BUBBLE_BOX =
  'rounded-tl-sm bg-transparent -mx-1 w-auto max-w-none self-stretch px-1 sm:mx-0 sm:w-full sm:max-w-full sm:px-3.5';

// Memoized so typing in the composer doesn't reconcile every bubble in
// a long chat — `msg` is referentially stable (state.messages doesn't
// change on input keystrokes), `agentName`/`accent` are value-equal.
/** A bubble, which tells its avatar which message it belongs to (`BubbleMessageContext`). */
const Message = memo(function Message(props: Parameters<typeof MessageBody>[0]) {
  return <BubbleMessageContext.Provider value={props.msg.id}><MessageBody {...props} /></BubbleMessageContext.Provider>;
});

function MessageBody({
  msg,
  missionId,
  agentName,
  accent,
  highlighted = false,
  iconUrl,
  iconFallback,
  roleKey,
  identityOf,
  compact = false,
  wide = false,
  live = false,
  terminalScope = null,
  hideToolNoise = false,
  owner = null,
  onRetryTurn,
}: {
  msg: Msg;
  /** Thread's mission — only permission cards use it (retrieving the
   *  payload of an unrenderable form). */
  missionId: string | null;
  /** Where a shell permission card pastes its command. */
  terminalScope?: TerminalScope | null;
  agentName: string;
  accent: string;
  highlighted?: boolean;
  iconUrl?: string | null;
  iconFallback: string;
  roleKey?: string | null;
  /** Resolves the sender of an injected `user` turn (`msg.origin`). */
  identityOf?: (name: string) => AgentIdentity;
  compact?: boolean;
  /** Use the available column width when the browser sidepanel is open. */
  wide?: boolean;
  /** This bubble is the one the agent is still writing into, and its turn is
   *  live. Set by the page, which alone knows `turn_active`: a result-less
   *  tool_use left by a killed turn would otherwise run forever. */
  live?: boolean;
  /** The setup conversation: the person meets their agent, not its tooling —
   *  no tool calls, no "permission" badge, no form preamble. */
  hideToolNoise?: boolean;
  /** The mission's owner: the human bubbles are theirs, not the viewer's. */
  owner?: MissionOwner | null;
  /** Re-sends the last message after the provider gave up (TODO #459); set on
   *  the latest retry line only. */
  onRetryTurn?: () => void;
}) {
  // Read before the early returns: a notice, a handover card and a bubble are
  // three exits of the SAME component, and a hook may not sit behind one.
  const appearance = useChatAppearance();
  const me = useMe();
  const bubbleRef = useRef<HTMLDivElement>(null);
  useGlassBubble(bubbleRef);
  // The thread holds sources; the HTML is built here, for mounted bubbles
  // only, and again when the highlight.js grammars land after a replay.
  const highlighter = useHighlighterVersion();
  const html = msg.content + useAgentTextHtml(msg.text);
  const tools = useMemo(
    () => (hideToolNoise ? undefined : msg.tools?.map((tool) => toolView(tool, highlighter))),
    [msg.tools, hideToolNoise, highlighter],
  );
  // The calls of THIS bubble still in flight — only ever non-empty on the
  // live bubble of a live turn, which the page tells us (`live`). Same
  // sentence as the bar above the composer: what the agent said the call is
  // FOR, else a generic phrase; on an MCP tool `description` is a payload
  // field, not an intent, so the name stands alone there.
  const runningInline: RunningTool[] = live && msg.tools?.length
    ? msg.tools
        .filter((tool) => !tool.result)
        .map((tool) => ({
          id: tool.id,
          name: toolLabel(tool.name, tool.title),
          label: tool.name?.startsWith('mcp__')
            ? undefined
            : tool.intent?.trim() || humanizeTool(tool.name, tool.detail) || undefined,
          startedAt: tool.startedAt,
        }))
    : [];
  if (msg.role === 'notice' && msg.retryLine) {
    return <ProviderRetryNotice line={msg.retryLine} onRetry={onRetryTurn} />;
  }
  if (msg.role === 'notice' && msg.compaction) {
    return <CompactionTrace trace={msg.compaction} agentName={agentName} time={msg.t} />;
  }
  if (msg.role === 'notice' && msg.handover) {
    return <LlmHandoverCard handover={msg.handover} time={msg.t} compact={compact} />;
  }
  if (msg.role === 'notice') {
    const alert = msg.noticeTone === 'alert';
    return (
      <div className={cn(
        // A backend error message doesn't fit on one line — truncating
        // it would hide exactly the quota's reopening time.
        'py-1 text-center text-[11px] tabular-nums whitespace-pre-wrap [overflow-wrap:anywhere]',
        alert ? 'mx-auto w-fit max-w-full rounded-md bg-destructive/10 px-3 text-destructive' : 'text-muted-foreground/70',
      )}>
        {msg.notice}
      </div>
    );
  }
  if (msg.role === 'permission' && msg.perm) {
    return <PermissionCard msg={msg} missionId={missionId} agentName={agentName} accent={accent} highlighted={highlighted} iconUrl={iconUrl} iconFallback={iconFallback} roleKey={roleKey} terminalScope={terminalScope} hideToolNoise={hideToolNoise} />;
  }
  if (msg.role === 'avatar' && msg.avatarRequest) {
    return (
      <SetupAvatarCard
        request={msg.avatarRequest}
        avatar={<BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />}
      />
    );
  }
  if (msg.role === 'proposal' && msg.proposal) {
    return (
      <LayoutProposalCard
        proposal={msg.proposal}
        time={msg.t}
        highlighted={highlighted}
        avatar={<BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />}
      />
    );
  }
  if (msg.role === 'ui') {
    // A document belongs to its mission's thread: without one there is nothing to load.
    if (!msg.uiDocument || !missionId) return null;
    return (
      <div
        // Same columns as the bubbles above and below, avatar gutter included.
        className={cn('grid w-full min-w-0 grid-cols-1 items-start gap-3', !compact && 'sm:grid-cols-[34px_minmax(0,1fr)_34px]')}
        data-perm-id={msg.uiDocument.id}
      >
        {compact ? null : msg.uiDocument.origin.kind === 'agent'
          ? <BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />
          : <span aria-hidden />}
        <div className="flex min-w-0 flex-col gap-1">
          <ChatUiDocumentSlot document={msg.uiDocument} missionId={missionId} />
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{msg.t}</span>
        </div>
      </div>
    );
  }
  if (msg.role === 'secret' && msg.secretRequest) {
    return (
      <div
        // Same columns as the bubbles above and below, avatar gutter included.
        className={cn('grid w-full min-w-0 grid-cols-1 items-start gap-3 scroll-mt-24', !compact && 'sm:grid-cols-[34px_minmax(0,1fr)_34px]')}
        // The deep-link of a notification looks for this attribute, as for a permission card.
        data-perm-id={msg.secretRequest.id}
      >
        {compact ? null : <BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />}
        <div className="flex min-w-0 flex-col gap-1">
          <ChatSecretRequestSlot request={msg.secretRequest} highlighted={highlighted} />
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{msg.t}</span>
        </div>
      </div>
    );
  }
  if (msg.role === 'command' && msg.cmd) {
    return (
      <CommandRequestCard
        request={msg.cmd}
        time={msg.t}
        highlighted={highlighted}
        avatar={<BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />}
      />
    );
  }
  // Without its calls, a bubble that held nothing else would be an empty box.
  if (hideToolNoise && msg.role === 'agent' && !hasProse(msg) && !msg.media?.length) return null;
  // A `user` turn pushed by another agent or by the daemon is drawn on the
  // agent side, under the real sender's name: the reader must see who
  // spoke, and it was not the human.
  const sender = msg.role === 'user' && msg.origin && identityOf ? identityOf(msg.origin.from) : null;
  const isUser = msg.role === 'user' && !sender;
  const human = isUser ? humanSpeaker(owner, actingUser(me)) : null;
  return (
    <div
      // A reply's quote scrolls back to the bubble it names.
      data-event-id={msg.eventId}
      className={cn(
        // `chat-msg`: skipped by the browser while far off screen (globals.css).
        'chat-msg grid w-full min-w-0 items-start gap-3',
        // Mobile: single column, no avatar gutter → bubbles use the full
        // width. Desktop (sm+): a 34px gutter on BOTH sides, whoever speaks —
        // the avatar takes the one on its own side, the opposite one stays
        // empty but reserved, so every bubble lives in a corridor of constant
        // width instead of running to the edge facing its avatar.
        // Compact (multichat grid cell): keep the mobile single-column
        // layout at every width so bubbles always span 100 %.
        compact
          ? 'grid-cols-1'
          : 'grid-cols-1 sm:grid-cols-[34px_minmax(0,1fr)_34px]',
      )}
    >
      {compact ? null : isUser ? (
        // Same geometry as the agents opposite: both sides of the conversation
        // read --avatar-radius, so a theme squares them together.
        <div className="row-start-1 sm:col-start-3 hidden size-[34px] place-items-center overflow-hidden rounded-[var(--avatar-radius)] border border-muted-foreground/30 bg-muted text-[13px] font-semibold text-foreground sm:grid">
          <HumanFace speaker={human} className="size-full" />
        </div>
      ) : sender ? (
        <AgentAvatar identity={sender} className="row-start-1 sm:col-start-1 hidden sm:block" />
      ) : (
        <BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />
      )}
      <div
        className={cn(
          // The conversation column shares the composer's gutters and cap.
          'group/msg flex w-full min-w-0 max-w-full flex-col gap-1.5',
          // Always the middle column on desktop, both sides — mobile keeps
          // the single column, compact never leaves it.
          compact ? '' : 'col-start-1 row-start-1 sm:col-start-2',
          isUser ? (compact ? 'items-end' : 'items-end sm:justify-self-end') : '',
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]',
            isUser && 'flex-row-reverse',
          )}
        >
          <span
            className={cn(
              'text-[11.5px] font-medium',
              isUser ? 'text-primary' : 'text-foreground',
            )}
          >
            {isUser ? (human?.name.trim() || 'you') : sender ? sender.name : msg.voice === 'voice' ? 'GPT-Live' : (
              <button
                type="button"
                onClick={() => openAgentEditor({ agent: agentName })}
                title={i18n('chatPage.editAgent', { name: agentName })}
                className="rounded-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {agentName}
              </button>
            )}
          </span>
          {msg.voice && (
            <span
              className="inline-flex items-center gap-1 rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 tabular-nums text-[10px] lowercase text-primary"
              title={i18n(msg.voice === 'user' ? 'gptLive.voiceUserHint' : 'gptLive.voiceAgentHint')}
            >
              {msg.voice === 'user' ? <Mic className="size-3" aria-hidden /> : <Volume2 className="size-3" aria-hidden />}
              {i18n('gptLive.voiceTag')}
            </span>
          )}
          {sender && msg.origin && (
            <span
              className="rounded border px-1.5 py-0.5 tabular-nums text-[10px] lowercase"
              style={{
                borderColor: `${sender.accent}55`,
                background: `${sender.accent}14`,
                color: sender.accent,
              }}
              title={msg.origin.missionId ? msg.origin.missionId.slice(0, 8) : undefined}
            >
              {originLabel(msg.origin.kind)}
            </span>
          )}
          {msg.tag && (
            <span
              className={cn(
                'rounded border px-1.5 py-0.5 tabular-nums text-[10px] lowercase',
                msg.tag === 'mission'
                  ? 'border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]'
                  : 'border-[hsl(var(--info)/0.3)] bg-[hsl(var(--info)/0.06)] text-[hsl(var(--info))]',
              )}
            >
              {msg.tag}
            </span>
          )}
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">
            {msg.t}
          </span>
          {/* A turn that spans several steps numbers them: without it, three
              consecutive bubbles from the same agent at the same minute read
              as one undated block. */}
          {!isUser && !hideToolNoise && (msg.step ?? 1) > 1 && (
            <span className="tabular-nums text-[10.5px] text-muted-foreground/45">
              {i18n('chatPage.stepIndex', { n: String(msg.step) })}
            </span>
          )}
        </div>
        <div
          ref={bubbleRef}
          // Which bubbles have a surface to frost: a danger frame stays as is,
          // and a flat agent bubble has no box left to blur.
          data-glass-surface={msg.danger ? undefined : isUser ? 'user' : appearance.flatBubbles ? undefined : 'agent'}
          className={cn(
            // min-w-0 + overflow-hidden so a long unbreakable token (URL,
            // path, code identifier) can't blow the flex parent's max-w
            // and bleed outside the column. The bubble itself clips and
            // the inner markdown wraps via the .chat-bubble rules in
            // globals.css.
            'chat-bubble w-full min-w-0 max-w-full overflow-hidden rounded-xl px-3.5 py-3 text-[13.5px] leading-relaxed',
            // The human's bubble is as wide as what it holds, and no wider: a
            // three-word question gets a three-word bubble, a long one stops
            // at 70 % and leaves the rest of the row empty. That empty room on
            // the left is what tells the two speakers apart at a glance, at no
            // cost in colour. Agents keep the full width — they write long,
            // and ragged left edges down a whole thread read badly.
            isUser && 'w-fit max-w-[85%] sm:max-w-[70%]',
            // Flat: the agents lose their box entirely, so the thread reads as
            // one surface over the page's background. The human keeps a tint —
            // without it, a dense thread gives no clue who is speaking.
            // `danger` keeps ITS frame whatever the setting: a bubble that
            // says something went wrong is not decoration.
            appearance.flatBubbles && !msg.danger
              ? isUser
                ? 'rounded-tr-sm bg-[var(--bubble-user)]'
                : FLAT_BUBBLE_BOX
              : isUser
                // Opaque, never an alpha gradient: the canvas grid showed
                // through the text. The tint follows --primary through
                // color-mix (cf. --bubble-user), a theme can replace it.
                ? 'rounded-tr-sm border border-[var(--bubble-user-border)] bg-[var(--bubble-user)] text-foreground'
                : msg.danger
                  ? 'rounded-tl-sm border-2 border-destructive bg-destructive/10 text-foreground shadow-[0_0_0_1px_hsl(var(--destructive)/0.2),0_0_24px_-8px_hsl(var(--destructive)/0.6)]'
                  : 'rounded-tl-sm border border-border/70 bg-card shadow-elev-1 dark:bg-surface-2',
          )}
        >
          {msg.thinking && <ThinkingBlock text={msg.thinking} />}
          {msg.reply && <ReplyQuote reply={msg.reply} />}
          {html && (
            <div dangerouslySetInnerHTML={{ __html: html }} />
          )}
          {msg.annotations && <AnnotationCard card={msg.annotations} />}
          {msg.media && missionId && msg.media.map((block) => (
            <ChatMediaSlot key={block.file} block={block} missionId={missionId} />
          ))}
          {/* Stacked groups the whole turn into one row, so it is decided
              HERE and not inside each call: a per-call component could only
              ever give back the column of lines the mode removes. */}
          {tools?.length ? (
            appearance.toolCalls === 'stacked' ? (
              <ToolCallStack
                tools={tools.map((tool) => ({ ...tool, icon: toolIconFor(tool.name, tool.detail) }))}
                running={runningInline}
                live={live}
              />
            ) : (
              tools.map((tool) => (
                <ToolCall
                  key={tool.id}
                  {...tool}
                  icon={toolIconFor(tool.name, tool.detail)}
                  mode={appearance.toolCalls}
                />
              ))
            )
          ) : null}
        </div>
        {!sender && html && (
          <MessageActionBar
            message={{
              role: isUser ? 'user' : 'agent',
              eventId: msg.eventId ?? null,
              missionId,
              markdown: isUser ? msg.typed ?? '' : (msg.text ?? []).join('\n\n'),
              html,
            }}
          />
        )}
      </div>
    </div>
  );
}

/** AskUserQuestion payload (claude builtin tool). The agent shipped one
 *  or more questions, each with predefined options. We render the form,
 *  collect the user's picks, then resolve the permission as "allow" with
 *  the picks encoded in updatedInput so claude reads them as the tool
 *  result. Deny just cancels. */
type AskUserInput = { questions?: AskUserQuestion[]; form?: SeriesPlanFormPayload };

/* ── Refusal reasons, one per CAUSE ───────────────────────────────────────────
 * INCIDENT 2026-08-21, mission e6893b9e: an `ask_user` whose form never
 * displayed was reported back to the agent as `denied by user`. The agent
 * concluded the user refused to answer, decided on its own, and told him so. The
 * root cause: ALL deny paths sent the same text, or none (the server then
 * applied "denied by user" by default).
 *
 * Rule: each refusal path sends ITS OWN reason, and no reason attributes an
 * intention to the user if they didn't perform the corresponding action.
 * These strings mirror `DENY_REASONS` (orchestrator/src/permissions.ts) —
 * the UI and the orchestrator are two separate packages, no import
 * possible; keeping them aligned is deliberate, they reach the same
 * recipient.
 * ────────────────────────────────────────────────────────────────────────── */
const DENY_USER_DENIED =
  'Explicit refusal from the user ("Deny" button). Do not retry the same request: '
  + 'pick an alternative that does not need this permission, or escalate.';
const DENY_FORM_CANCELLED =
  'The user closed the form without answering ("Cancel" button). This is NOT a refusal '
  + "of your request: they saw the questions and did not decide. Rephrase more simply, or "
  + "proceed while clearly stating the assumption you are making for lack of an answer.";
/** Action behind a decision, as the orchestrator expects it and persists it
 *  in `permission_resolved` (cf. DECISION_ORIGINS server-side). */
type DecisionOrigin =
  | 'ui_form_submit'
  | 'ui_form_cancel'
  | 'ui_form_unrenderable'
  | 'ui_card_allow'
  | 'ui_card_paste'
  | 'ui_card_deny';

const DENY_FORM_UNRENDERABLE =
  'The form could not be displayed on the interface side: the user NEVER saw your questions '
  + 'and therefore neither refused nor cancelled. Call the same tool again (`question` or '
  + '`kanban_plan`) with the same content.';

function PermissionCard({
  msg,
  missionId,
  agentName,
  accent,
  highlighted = false,
  iconUrl,
  iconFallback,
  roleKey,
  terminalScope = null,
  hideToolNoise = false,
}: {
  msg: Msg;
  /** Mission carrying the card — used to re-request the payload from the
   *  server when it hasn't arrived here (cf. recoverPayload). */
  missionId: string | null;
  /** The terminal "Paste into a terminal" types the command in. */
  terminalScope?: TerminalScope | null;
  agentName: string;
  accent: string;
  /** True for ~1.5s after a sidebar deep-link click — drives a one-shot
   *  ring flash so the eye lands on the card the user was sent to. */
  highlighted?: boolean;
  iconUrl?: string | null;
  iconFallback: string;
  roleKey?: string | null;
  /** Setup conversation: a question, not a permission (see `Message`). */
  hideToolNoise?: boolean;
}) {
  const perm = msg.perm!;
  const [busy, setBusy] = useState(false);
  // Local override for the card state — used when the resolve call
  // returns 404 (permission was lost in an orchestrator restart). Upstream
  // SSE never sends a resolved event in that case, so we flip the card
  // ourselves to make it obvious the click was a no-op.
  const [localState, setLocalState] = useState<PermissionState | null>(null);
  const effectiveState: PermissionState = localState ?? perm.state;

  // Specialised AskUserQuestion form state: per-question selected labels.
  // Initialised to first option when single-select; empty array for
  // multi-select. The shape sent back matches the AskUserQuestion schema's
  // `answers` (keyed by question text).
  //
  // Two tool_name values land here:
  //   - 'ask_user'         — the card our `timon_ask` MCP opens for its tools
  //                          `question` and `kanban_plan`. The card kept the
  //                          name it is persisted under when the tools were
  //                          renamed: past missions replay with it.
  //   - 'AskUserQuestion'  — claude builtin (now blocked via --disallowedTools,
  //                          kept as a safety net for older agents / Codex)
  const isAskUser =
    perm.tool_name === 'ask_user' || perm.tool_name === 'AskUserQuestion';
  // Payload retrieved from the server when the event's is missing
  // (cf. recoverPayload). Takes priority over perm.input as soon as it's
  // there.
  const [recovered, setRecovered] = useState<AskUserInput | null>(null);
  const askQuestions: AskUserQuestion[] = isAskUser
    ? (recovered?.questions ?? (perm.input as AskUserInput)?.questions ?? [])
    : [];
  /** TYPED form (series planner). It replaces `questions` — the agent only
   *  sends the context, the UI builds the menus from the catalog. */
  const seriesForm: SeriesPlanFormPayload | undefined = isAskUser
    ? (recovered?.form ?? (perm.input as AskUserInput)?.form)
    : undefined;
  /** Form expected, but nothing to display: the user must NOT be offered
   *  Approve/Deny on questions they can't read. */
  const askUnrenderable = isAskUser && !seriesForm && askQuestions.length === 0;
  // A form that expired comes back as a new card: same questions, same
  // mission → it starts from what the user had already ticked and typed.
  const [draft] = useState(() => (isAskUser ? loadAskDraft(sessionDraftStorage(), missionId, askQuestions) : null));
  const [picks, setPicks] = useState<Record<string, string | string[]>>(() => {
    if (draft) return draft.picks;
    const init: Record<string, string | string[]> = {};
    // Nothing ticked by default: a preselected option is a choice the user
    // never made, and a radio cannot be unticked back to "only my text".
    for (const q of askQuestions) {
      init[q.question] = q.multiSelect ? [] : '';
    }
    return init;
  });
  // Free text typed in each question's own field (its answer, or a remark on the pick).
  const [custom, setCustom] = useState<Record<string, string>>(() => draft?.custom ?? {});
  useEffect(() => {
    if (!isAskUser || effectiveState !== 'pending') return;
    saveAskDraft(sessionDraftStorage(), missionId, askQuestions, { picks, custom });
    // `askQuestions` is rebuilt every render; the draft follows what the user changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picks, custom]);
  const [recovering, setRecovering] = useState(false);
  const [recoverFailed, setRecoverFailed] = useState(false);

  // An automatic recovery attempt as soon as an ask_user card displays
  // with no questions: in the nominal case the human sees the form arrive
  // and has nothing to do — the error state is only there if it fails.
  useEffect(() => {
    if (askUnrenderable && effectiveState === 'pending' && !recovering && !recoverFailed) {
      void recoverPayload();
    }
    // Deliberately driven by the (renderability, state) pair alone:
    // retrying on every render would be a loop, `recoverFailed` arms the
    // guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [askUnrenderable, effectiveState]);

  // The recovered payload arrives AFTER mount: the picks initialized
  // empty must be reseeded, otherwise the first radio button has no
  // default.
  useEffect(() => {
    if (!recovered?.questions) return;
    setPicks((prev) => {
      const next = { ...prev };
      for (const q of recovered.questions ?? []) {
        if (next[q.question] === undefined) {
          next[q.question] = q.multiSelect ? [] : '';
        }
      }
      return next;
    });
  }, [recovered]);

  /**
   * Resolves the permission. `origin` NAMES the action (which button, which
   * view) and `message` the CAUSE of the refusal — both were missing
   * before the 2026-08-21 incident: the server fell back to "denied by
   * user" regardless of the reason, and nothing afterward could tell where
   * the click came from. A deny with no explicit `message` is a bug: it
   * would make the agent lie.
   */
  async function resolve(
    behavior: 'allow' | 'deny' | 'paste',
    opts: { origin: DecisionOrigin; message?: string; updatedInput?: unknown; scope?: ApprovalScope },
  ): Promise<boolean> {
    if (busy || effectiveState !== 'pending') return false;
    setBusy(true);
    try {
      const r = await fetch(`/api/ui/permissions/${encodeURIComponent(perm.request_id)}/resolve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          behavior,
          origin: opts.origin,
          message: behavior === 'deny' ? opts.message : undefined,
          updatedInput: opts.updatedInput,
          scope: behavior === 'allow' ? opts.scope : undefined,
        }),
      });
      if (r.status === 404) {
        // Permission map is in-memory only — an orchestrator restart wipes
        // pending requests, and the underlying subprocess died with it.
        // The card is a ghost; flip it locally so the user sees what
        // happened without a generic error toast.
        setLocalState('expired');
        toast.info('This request has expired (orchestrator restarted or mission ended).');
        return false;
      }
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        toast.error('resolve failed: ' + (apiErrorMessage(j, r.statusText)));
        return false;
      }
      // The orchestrator will emit a permission_resolved event over SSE
      // which flips state in our store. No optimistic update needed.
      return true;
    } finally {
      setBusy(false);
    }
  }

  /** The agent is refused the tool; the user gets the command at a prompt, without Enter. */
  async function paste() {
    const command = perm.shell_command;
    if (!command) return;
    const outcome = await pasteIntoTerminal({
      resolve: () => resolve('paste', { origin: 'ui_card_paste' }),
      scope: terminalScope,
      command,
    });
    if (outcome.kind !== 'window_refused') return;
    const label = terminalScope ? (terminalScope.kind === 'project' ? terminalScope.slug : terminalScope.name) : i18n('terminal.scopes.none');
    const copied = await copyToClipboard(command);
    toast.warning(i18n(copied ? 'terminal.request.windowRefused' : 'terminal.request.windowRefusedNoClipboard', { scope: label }));
  }
  const offersAllow = !perm.choices || perm.choices.includes('allow');
  const offersPaste = Boolean(perm.shell_command && perm.choices?.includes('paste'));

  async function submitAnswers() {
    const answers = buildAskAnswers(askQuestions, picks, custom);
    if (await resolve('allow', { origin: 'ui_form_submit', updatedInput: { answers } })) {
      clearAskDraft(sessionDraftStorage(), missionId, askQuestions);
    }
  }

  /**
   * Re-requests the form's payload from the server when it hasn't arrived
   * here. `GET /api/ui/permissions?mission_id=…` exposes still-pending
   * permissions WITH their `input` — the authoritative source, the one the
   * SSE event should have carried. Success → the form re-renders cleanly;
   * failure → the human keeps control via "Re-ask the agent".
   */
  async function recoverPayload() {
    if (recovering) return;
    setRecovering(true);
    setRecoverFailed(false);
    try {
      const qs = missionId ? `?mission_id=${encodeURIComponent(missionId)}` : '';
      const r = await fetch(`/api/ui/permissions${qs}`, { cache: 'no-store' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { pending?: Array<{ id: string; input?: unknown }> };
      const mine = j.pending?.find((x) => x.id === perm.request_id);
      const input = mine?.input as AskUserInput | undefined;
      const questions = input?.questions;
      const form = input?.form;
      if (!form && (!questions || questions.length === 0)) throw new Error('payload not found');
      setRecovered({ questions, form });
    } catch {
      setRecoverFailed(true);
    } finally {
      setRecovering(false);
    }
  }

  const inputPreview = (() => {
    try { return JSON.stringify(perm.input, null, 2); } catch { return String(perm.input); }
  })();
  return (
    <div
      // Trailing 34px column: no avatar on this side, but the message rows
      // above and below reserve it, so dropping it would push this card
      // 46px further right than the transcript it belongs to.
      className="grid grid-cols-1 items-start gap-3 scroll-mt-24 sm:grid-cols-[34px_minmax(0,1fr)_34px]"
      data-perm-id={perm.request_id}
      id={`perm-${perm.request_id}`}
    >
      <BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} />
      <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          <span className="tabular-nums text-[11.5px] font-medium text-foreground">{agentName}</span>
          {!hideToolNoise && (
            <span className="rounded border border-[hsl(var(--warning)/0.3)] bg-[hsl(var(--warning)/0.08)] px-1.5 py-0.5 tabular-nums text-[10px] lowercase text-[hsl(var(--warning))]">
              permission
            </span>
          )}
          <span className="text-[10.5px] tabular-nums text-muted-foreground/60">{msg.t}</span>
          {effectiveState === 'pending' && perm.expires_at !== undefined && (
            <PermissionCountdown expiresAt={perm.expires_at} />
          )}
        </div>
        <div
          className={cn(
            'rounded-xl rounded-tl-sm border px-3.5 py-3 text-[13px] transition-[background-color,border-color,box-shadow] duration-200',
            // Neutral surface identical to normal agent text bubbles; the
            // lifecycle is signalled by the BORDER colour only (amber while
            // pending, green when allowed, neutral when expired, red when
            // denied) — no background tint.
            'bg-card shadow-elev-1 dark:bg-surface-2',
            effectiveState === 'pending'
              ? 'border-[hsl(var(--warning)/0.5)]'
              : effectiveState === 'allowed' || effectiveState === 'pasted'
                ? 'border-[hsl(var(--success)/0.5)]'
                : effectiveState === 'expired'
                  ? 'border-muted-foreground/40'
                  : 'border-destructive/40',
            highlighted
              && 'ring-2 ring-[hsl(var(--warning))] shadow-[0_0_28px_hsl(var(--warning)/0.55)]',
          )}
        >
          {askUnrenderable ? (
            /* Expected form but missing payload. Forbidden to show
             * Approve/Deny here: this is exactly the blind card of the
             * 2026-08-21 incident. We say what's happening, try to recover
             * the payload, and failing that hand control back to the
             * agent with a reason that does NOT say the human refused. */
            <div className="flex flex-col gap-2.5">
              <div className="font-medium text-destructive">
                {i18n('chatPage.formNotDisplayable')}
              </div>
              <div className="text-[12.5px] text-muted-foreground">
                {i18n('chatPage.formNotDisplayableBody', { agentName })}
              </div>
              {effectiveState === 'pending' ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={recovering || busy}
                    onClick={() => void recoverPayload()}
                    className="h-7 gap-1.5"
                  >
                    {recovering ? i18n('chatPage.recovering') : i18n('chatPage.retryLoad')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() =>
                      resolve('deny', {
                        origin: 'ui_form_unrenderable',
                        message: DENY_FORM_UNRENDERABLE,
                      })
                    }
                    className="h-7 gap-1.5"
                  >
                    {i18n('chatPage.reAskAgent')}
                  </Button>
                  {recoverFailed && (
                    <span className="tabular-nums text-[10.5px] text-muted-foreground">
                      {i18n('chatPage.payloadNotFoundServer')}
                    </span>
                  )}
                </div>
              ) : (
                <span className="w-fit rounded border border-muted-foreground/30 bg-muted/50 px-2 py-0.5 tabular-nums text-[10.5px] text-muted-foreground">
                  {effectiveState}
                </span>
              )}
            </div>
          ) : seriesForm ? (
            <SeriesPlanForm
              form={seriesForm}
              missionId={missionId}
              pending={effectiveState === 'pending'}
              busy={busy}
              onSubmit={(plan) =>
                resolve('allow', { origin: 'ui_form_submit', updatedInput: { plan, note: plan.note } })
              }
              onCancel={() =>
                resolve('deny', { origin: 'ui_form_cancel', message: DENY_FORM_CANCELLED })
              }
            />
          ) : isAskUser ? (
            <AskUserForm
              questions={askQuestions}
              picks={picks}
              setPicks={setPicks}
              custom={custom}
              setCustom={setCustom}
              state={effectiveState}
              busy={busy}
              onSubmit={submitAnswers}
              onCancel={() =>
                resolve('deny', { origin: 'ui_form_cancel', message: DENY_FORM_CANCELLED })
              }
              preamble={!hideToolNoise}
            />
          ) : (
            <>
              <div className="font-medium">The agent is requesting permission to run:</div>
              {/* code-font: the tool id */}
              <code className="mt-1.5 inline-block break-all rounded border border-border bg-muted/40 px-2 py-1 font-mono text-[11.5px]">
                {perm.tool_name}
              </code>
              {inputPreview && inputPreview !== '{}' && (
                // code-font: the call input, JSON
                <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded border border-border bg-muted/30 p-2 font-mono text-[11px] leading-relaxed text-foreground/85">
                  {inputPreview}
                </pre>
              )}
              <div className="mt-3 flex items-center gap-2">
                {effectiveState === 'pending' ? (
                  <>
                    {offersAllow && (
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => resolve('allow', { origin: 'ui_card_allow' })}
                        className="h-7 gap-1.5"
                      >
                        {i18n('terminal.request.allow')}
                      </Button>
                    )}
                    {offersAllow && (perm.scopes ?? []).map((scope) => (
                      <Button
                        key={scope}
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => resolve('allow', { origin: 'ui_card_allow', scope })}
                        title={perm.motif ? i18n('chatPage.allowCovers', { motif: perm.motif }) : undefined}
                        className="h-7 gap-1.5"
                      >
                        {scope === 'session' ? i18n('chatPage.allowSession') : i18n('chatPage.allowAlways')}
                      </Button>
                    ))}
                    {offersPaste && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => void paste()}
                        className="h-7 gap-1.5"
                      >
                        {i18n('terminal.request.paste')}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        resolve('deny', { origin: 'ui_card_deny', message: DENY_USER_DENIED })
                      }
                      className="h-7 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      {i18n('chatPage.permDeny')}
                    </Button>
                  </>
                ) : (
                  <span
                    className={cn(
                      'rounded border px-2 py-0.5 text-[10.5px]',
                      effectiveState === 'allowed' || effectiveState === 'pasted'
                        ? 'border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]'
                        : effectiveState === 'expired'
                          ? 'border-muted-foreground/30 bg-muted/50 text-muted-foreground'
                          : 'border-destructive/30 bg-destructive/10 text-destructive',
                    )}
                  >
                    {effectiveState === 'pasted' ? i18n('terminal.request.state.paste') : effectiveState}
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}



/**
 * "Tool running" bar, stuck above the composer.
 *
 * WHY: when the agent launches a long `Bash` (a 7-min test suite, a
 * build), it stops producing any event until the tool returns. The chat
 * looks frozen and nothing indicates whether it's working, on what, or
 * for how long — to the point of thinking it crashed and trying to "wake
 * it up" while it's simply waiting on a process. The bar makes this wait
 * legible.
 *
 * A tool_use with no matching tool_result = tool in flight: the info
 * already existed in the state (`ToolUse.result === undefined`), it just
 * never surfaced on screen.
 */
const RunningToolBar = memo(function RunningToolBar({
  tools,
  compact = false,
}: {
  tools: ToolUse[];
  compact?: boolean;
}) {
  // Local timer. Only runs when there's something to display: without
  // this guard, a re-render every second would run permanently on an
  // inactive page to display nothing.
  const [now, setNow] = useState(() => Date.now());
  const active = tools.length > 0;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);

  if (!active) return null;

  return (
    // A strip of `ComposerTrays`: no wider than the composer's tab, docked on
    // it. OPAQUE background + warning tint — the original `bg-muted/40` let
    // the page content show through and looked off in practice.
      <div
        className={cn(composerTrayClass(compact), 'flex min-w-0 flex-col gap-0.5 px-3 py-1')}
        style={{
          backgroundColor: 'hsl(var(--background))',
          backgroundImage:
            'linear-gradient(hsl(var(--warning) / 0.14), hsl(var(--warning) / 0.14))',
          borderColor: 'hsl(var(--warning) / 0.4)',
        }}
      >
        {tools.map((t) => {
          const elapsed = t.startedAt ? Math.max(0, Math.floor((now - t.startedAt) / 1000)) : null;
          // Past a minute, a still-running tool deserves flagging: it's
          // the threshold where you start wondering if it crashed.
          const long = elapsed !== null && elapsed >= 60;
          // Readable phrase. We ALWAYS prefer `intent` — the description
          // the agent wrote itself — because it knows the mission's
          // context, which no heuristic can guess. `humanizeTool` only
          // acts as a fallback: tools without a description field (Read,
          // Edit, MCP…) and LLM backends that don't provide it (TIMON must
          // run on something other than Claude). A generic phrase beats no
          // phrase at all.
          const quoi = t.name?.startsWith('mcp__') ? null : t.intent?.trim() || humanizeTool(t.name, t.detail);
          return (
            <div key={t.id} className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2 text-[11px]">
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: 'hsl(var(--warning))' }}
                  aria-hidden
                />
                <span className="shrink-0 tabular-nums text-[11px] font-medium text-muted-foreground">
                  {toolLabel(t.name, t.title)}
                </span>
                {elapsed !== null && (
                  <span
                    className={cn(
                      'shrink-0 text-[11px] tabular-nums',
                      long ? 'text-[hsl(var(--warning))]' : 'text-muted-foreground',
                    )}
                  >
                    {fmtElapsedShort(elapsed)}
                  </span>
                )}
                {quoi && <span className="truncate font-medium text-foreground">{quoi}</span>}
              </div>
              {t.detail && !t.name?.startsWith('mcp__') && (
                // code-font: the command being run
                <code
                  className="truncate pl-[14px] font-mono text-[10.5px] text-muted-foreground/70"
                  title={t.detail}
                >
                  {t.detail}
                </code>
              )}
            </div>
          );
        })}
      </div>
  );
});



/**
 * Response currently being generated, rendered live under the last
 * message. Replaced by the real bubble as soon as the full message
 * arrives.
 *
 * Markdown is rendered per block while the provider is still writing.
 * Stable blocks retain their DOM, including horizontal table scroll hosts.
 */
const StreamingBubble = memo(function StreamingBubble({
  agentName,
  accent,
  text,
  iconUrl,
  iconFallback,
  roleKey,
  compact = false,
  wide = false,
}: {
  agentName: string;
  accent: string;
  text: string;
  iconUrl?: string | null;
  iconFallback: string;
  roleKey?: string | null;
  compact?: boolean;
  wide?: boolean;
}) {
  // The bubble being written must wear the same skin as the one that will
  // replace it, otherwise a frame appears and vanishes at every turn.
  const { flatBubbles } = useChatAppearance();
  const bubbleRef = useRef<HTMLDivElement>(null);
  useGlassBubble(bubbleRef);
  return (
    <div className={cn(
      'grid grid-cols-1 items-start gap-3',
      // Same corridor as a message row — the trailing gutter stays empty
      // here but must be reserved, else this row overruns the ones around it.
      !compact && 'sm:grid-cols-[34px_minmax(0,1fr)_34px]',
    )}>
      {!compact && <BubbleMessageContext.Provider value={STREAM_BUBBLE_ID}><BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} /></BubbleMessageContext.Provider>}
      <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          <span className="tabular-nums text-[11.5px] font-medium text-foreground">
            {agentName}
          </span>
          <span className="text-[10.5px] tabular-nums" suppressHydrationWarning>{nowTime()}</span>
        </div>
        <div ref={bubbleRef} data-glass-surface={flatBubbles ? undefined : 'agent'} className={cn(
          'chat-bubble w-full min-w-0 overflow-hidden rounded-xl rounded-tl-sm px-3.5 py-3 text-[13.5px] leading-relaxed [overflow-wrap:anywhere]',
          flatBubbles ? FLAT_BUBBLE_BOX : 'border border-border bg-card',
        )}>
          <StreamingMarkdown text={text} />
        </div>
      </div>
    </div>
  );
});

const Thinking = memo(function Thinking({
  agentName,
  accent,
  hint,
  iconUrl,
  iconFallback,
  roleKey,
  compact = false,
  wide = false,
}: {
  agentName: string;
  accent: string;
  hint?: string | null;
  iconUrl?: string | null;
  iconFallback: string;
  roleKey?: string | null;
  compact?: boolean;
  wide?: boolean;
}) {
  // Show the current activity (last tool name) when available so the
  // user sees what claude is actually doing between bubbles — otherwise
  // a long stretch of "thinking" looks like a frozen UI.
  const label = hint ? `running ${toolLabel(hint)}` : 'thinking';
  // Same skin as the agent bubbles it stands in for: a frame here while the
  // replies are flat made the indicator the only boxed thing in the thread.
  const { flatBubbles } = useChatAppearance();
  return (
    <div className={cn(
      'grid grid-cols-1 items-start gap-3',
      // Same corridor as a message row — the trailing gutter stays empty
      // here but must be reserved, else this row overruns the ones around it.
      !compact && 'sm:grid-cols-[34px_minmax(0,1fr)_34px]',
    )}>
      {!compact && <BubbleMessageContext.Provider value={STREAM_BUBBLE_ID}><BubbleAvatar color={accent} iconUrl={iconUrl} fallback={iconFallback} roleKey={roleKey} agent={agentName} /></BubbleMessageContext.Provider>}
      <div className="flex w-full min-w-0 max-w-full flex-col gap-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
          <span className="tabular-nums text-[11.5px] font-medium text-foreground">
            {agentName}
          </span>
          <span className="text-[10.5px] tabular-nums" suppressHydrationWarning>{nowTime()}</span>
        </div>
        <div className={cn(
          'inline-flex w-full min-w-0 flex-wrap items-center gap-2 rounded-xl rounded-tl-sm px-3.5 py-3 tabular-nums text-[12px] text-muted-foreground [overflow-wrap:anywhere]',
          flatBubbles ? FLAT_BUBBLE_BOX : 'border border-border bg-card',
        )}>
          <span>{label}</span>
          <ThinkingDots />
        </div>
      </div>
    </div>
  );
});

/* ────────────────────────────────────────────────────────────────────────── */


/** Opens a panel of the narrow chat. Opaque: it floats over the thread, whose
 *  text would otherwise show through the icon. */
function DeclencheurPanneau({ cible, label, ouvert, onClick, children }: {
  cible: string;
  label: string;
  ouvert: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-expanded={ouvert}
      aria-controls={cible}
      onClick={onClick}
      className="grid size-7 shrink-0 place-items-center rounded-md border border-border/40 bg-background text-muted-foreground/70 transition-colors hover:border-muted-foreground/40 hover:bg-background hover:text-foreground"
    >
      {children}
    </button>
  );
}

/** Below this many px of thread beside the columns, the thread takes its whole width. */
const LARGEUR_FIL_PLEINE = 900;
/** Below this many px of island, the chat reads as on a phone: Tailwind's
 *  `sm`, where `Message` leaves its avatar grid, measured on the island. */
const FIL_ETROIT = 640;
/** Margins kept around the reading column (both sides, gutters included) while it grows with the thread. */
const MARGES_FIL = 176;
const COLONNE_STANDARD = 780;
/** The setup composer's width (`max-w-2xl`): its conversation reads in the same column. */
const SETUP_COLONNE = 672;
/** `--chat-pad` steps. Whole literals: Tailwind only generates the classes it reads. */
const MARGE_VIEWPORT = '[--chat-pad:6px] md:[--chat-pad:12px] lg:[--chat-pad:24px]';
const MARGE_MOYENNE = '[--chat-pad:6px] md:[--chat-pad:12px]';
/** No margin, but clear of the page island's right gutter: the chat page paints
 *  its island with `IslandUnderlay`, inset by `--timon-island-gap` on the right,
 *  and a composer edge to edge ran past it. Inside a real island there is no underlay. */
const MARGE_NULLE = '[--chat-pad:0px] md:[[data-island-underlay]~&]:pr-[var(--timon-island-gap)]';
const COLONNE_GRANDE = 1180;

const fmtBytes = fmtSize;

function toastOverBudget(count: number): void {
  toast.error(i18n('chatPage.attachmentsOverBudget', { count: String(count), max: fmtAttachmentSize(MAX_TURN_BYTES) }));
}

function messageOverBudget(): string {
  return i18n('chatPage.messageOverBudget', { max: fmtAttachmentSize(MAX_TURN_BYTES) });
}

/** The daemon drops a file it cannot keep rather than failing the whole
 *  turn (`chat-attachments.ts`): the user is told which. */
function noteSkippedAttachments(reply: unknown): void {
  const skipped = (reply as { skipped_attachments?: unknown } | null)?.skipped_attachments;
  if (!Array.isArray(skipped) || skipped.length === 0) return;
  const names = skipped
    .map((entry) => (entry as { name?: unknown }).name)
    .filter((name): name is string => typeof name === 'string');
  toast.warning(i18n('chatPage.attachmentsSkipped', { names: names.join(', ') }));
}

/** Read a File / Blob as a base64 string with no data: prefix. The
 *  FileReader API returns `data:<media>;base64,<payload>` — we strip
 *  the leading metadata. */
function fileToBase64(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const r = fr.result;
      if (typeof r !== 'string') return reject(new Error('unexpected reader result'));
      const comma = r.indexOf(',');
      resolve(comma >= 0 ? r.slice(comma + 1) : r);
    };
    fr.onerror = () => reject(fr.error ?? new Error('read failed'));
    fr.readAsDataURL(file);
  });
}
