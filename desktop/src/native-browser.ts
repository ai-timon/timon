/** Chromium owned by Electron, shared by the native panel and daemon-controlled remote views. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync, openSync, closeSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, session, WebContentsView, ipcMain, type IpcMainEvent, type Rectangle, type Session, type WebContents, type WebPreferences, type DownloadItem } from 'electron';
import {
  BrowserCommandError, BrowserPresentationTickets, browserUrlOf, DEFAULT_VIEWPORT,
  objectOf, profileIdOf, viewportOf,
  browserFileName, browserFileChunk, BROWSER_FILE_CHUNK_BYTES, BROWSER_MAX_FILE_BYTES,
  BROWSER_PROMPT_CHANNEL, BROWSER_RECORD_EVENT_CHANNEL, BROWSER_RECORD_STATE_CHANNEL, BROWSER_RECORD_TOGGLE_CHANNEL,
  BROWSER_ANNOTATE_EVENT_CHANNEL, BROWSER_ANNOTATE_PICK_AT_CHANNEL, BROWSER_ANNOTATE_STATE_CHANNEL, BROWSER_ANNOTATE_TOGGLE_CHANNEL,
} from './native-browser-protocol.js';
import {
  RECORDING_AGENT_ALLOWED_COMMANDS, RECORDING_CONTROL_COMMANDS, RecordingSession, acceptsPageEventSize, credentialStep,
  maskUrl, navigationStep, normalizePageEvent, type RecordingResult, type RecordingStep,
} from './native-browser-recorder.js';
import {
  ANNOTATION_AGENT_ALLOWED_COMMANDS, ANNOTATION_CONTROL_COMMANDS, ANNOTATION_MAX_PICKS, ANNOTATION_THUMBNAIL_MAX_BYTES,
  ANNOTATION_VERSION, AnnotationSession, acceptsAnnotationEventSize, annotationSelectorOf, annotationTitle, annotationUrl, boxModelRect,
  normalizeAnnotationHover,
  normalizeAnnotationPick, readSource, thumbnailRect, thumbnailSize,
  type AnnotationCapture, type AnnotationPick, type AnnotationRect, type AnnotationSource, type AnnotationStopReason,
  type AnnotationThumbnail, type CdpProperty,
} from './native-browser-annotator.js';
import { credentialScript } from './native-browser-credentials.js';
import { describeCookieJar, persistentCopyOf } from './native-browser-cookies.js';
import { ChromeSignin } from './native-browser-chrome-signin.js';
import {
  chromeVersion, desktopUserAgent, identityForUrl, identityHeaders, identityOverride, isGoogleSigninUrl, isSigninRequest, mobileUserAgent, userAgentMetadata,
  type BrowserIdentity,
} from './native-browser-user-agent.js';
import { BODY_LIMIT, DevtoolsLog, metricsDelta, NETWORK_CONDITIONS, PERFORMANCE_SCRIPT } from './native-browser-devtools.js';
import {
  AnnotationBubbleController, anchorOf, anchorRectsOf, BROWSER_ANNOTATE_TRACK_CHANNEL, BUBBLE_CHANNEL, BUBBLE_MAX_QUEUE, bubbleCopy, bubbleDocument,
  bubbleLabel, bubbleMessageOf, type AnnotationRoutes, type BubbleConversation, type BubbleHost, type BubbleScheme, type QueuedCapture,
} from './native-browser-bubble.js';
import { AnnotationOverlay } from './native-browser-annotation-overlay.js';

interface BrowserTab {
  id: string; view: WebContentsView; uiWaiters: Set<() => void>; prepared: boolean;
  devtools: DevtoolsLog | null; trace: Array<{ name: string; value: number }> | null;
  /** The identity applied to the tab's current document (see `identityForUrl`). */
  identity: BrowserIdentity;
}
interface BrowserDialog {
  id: string; tabId: string; type: string; message: string; defaultPrompt: string; url: string;
  respond: (accept: boolean, prompt: string) => void;
  source: 'ipc' | 'native' | 'cdp'; cancelTimer: () => void;
}
interface BrowserFileChooser { id: string; tabId: string; multiple: boolean; backendNodeId: number }
interface BrowserPermission {
  id: string; tabId: string; permission: string; origin: string; mediaTypes: string[]; hostDevices: boolean;
  respond: (allow: boolean) => void; timer: ReturnType<typeof setTimeout>;
}
interface BrowserDownload {
  id: string; name: string; mimeType: string; size: number; receivedBytes: number;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'; url: string; createdAt: string;
  item?: DownloadItem;
}
interface BrowserUpload { id: string; chooserId: string; name: string; size: number; offset: number; path: string }
interface BrowserProfile {
  id: string;
  session: Session;
  host: BrowserWindow;
  tabs: Map<string, BrowserTab>;
  activeTabId: string;
  viewport: typeof DEFAULT_VIEWPORT;
  directory: string;
  stopping: boolean;
  dialogs: Map<string, BrowserDialog>;
  fileChooser: BrowserFileChooser | null;
  permissions: Map<string, BrowserPermission>;
  grantedPermissions: Set<string>;
  downloads: Map<string, BrowserDownload>;
  uploads: Map<string, BrowserUpload>;
  contextMenu: Record<string, unknown> | null;
  audioMuted: boolean;
  storageFlush: ReturnType<typeof setInterval> | null;
  cookieFlush: ReturnType<typeof setTimeout> | null;
  /** In memory only: collected by recordStop or returned by `stop`, dropped when the app quits. */
  recording: RecordingSession | null;
  recordingTimer: ReturnType<typeof setTimeout> | null;
  /** Annotate mode on one tab; kept once stopped so that `status` can say why. */
  annotation: AnnotationSession | null;
  annotationTimer: ReturnType<typeof setTimeout> | null;
  /** Picks made in the native view, in memory only, until the panel collects them. */
  annotationPicks: AnnotationCapture[];
  annotationCapturing: number;
  annotationWork: Promise<void>;
  /** PWA point requests waiting for the preload's answer, by request id. */
  annotationWaiters: Map<string, (payload: unknown) => void>;
  /** The comment bubble, its queue and its pins (TODO #481); created on the first pick in a presented view. */
  bubble: AnnotationBubbleController | null;
  overlay: AnnotationOverlay | null;
  /** The anchors the bubble follows, by tab: merged with the PWA's into what the preload reports. */
  bubbleAnchors: Map<string, string[]>;
  /** Elements the PWA picked (TODO #491), by capture id: their anchor in the tab and the last rectangle reported. */
  pwaPins: Map<string, PwaPin>;
  /** The capture ids the PWA draws pins for (its queue, its open bubble), set by `annotatePins`. */
  pwaFollowed: string[];
}
interface PwaPin { tabId: string; anchor: string; rect: AnnotationRect | null }
/** The preload remembers as many elements; past it, the oldest the PWA no longer follows is forgotten. */
const PWA_PINS_MAX = 64;
const ANNOTATION_ID = /^ba-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Presentation {
  profileId: string; window: BrowserWindow; bounds: Rectangle;
  /** What the app said of the panel it presents: the conversation it is open for, its language and scheme. */
  conversation: BubbleConversation | null; locale: string | null; scheme: BubbleScheme | null;
  timer?: ReturnType<typeof setTimeout>;
}

export interface NativeBrowserEngineOptions {
  /** The daemon's annotation routes with the user's own session; absent, the bubble queues but cannot send. */
  annotationRoutes?: AnnotationRoutes;
  /** Resolve the presenting window at call time: two windows may use different signed-in sessions. */
  annotationRoutesForWindow?: (window: BrowserWindow) => AnnotationRoutes;
  /** Scheme and language when the app did not say (an older app). */
  scheme?: () => BubbleScheme;
  locale?: () => string;
  /**
   * Gives the keyboard back to the window's interface once the panel leaves.
   * The interface is a view of its own in the window (multi-window V4), not
   * the window's webContents; absent, the window's webContents is focused.
   */
  focusWindow?: (window: BrowserWindow) => void;
}

const isQueued = (capture: AnnotationCapture): capture is QueuedCapture => (capture as Partial<QueuedCapture>).queued === true;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,128}$/;
const MISSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The conversation an attach names, or null: the daemon checks it again before posting anything. */
function conversationOf(value: unknown): BubbleConversation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { agent, mission, fresh } = value as Record<string, unknown>;
  if (typeof agent !== 'string' || !AGENT_NAME.test(agent)) return null;
  if (mission !== undefined && mission !== null && (typeof mission !== 'string' || !MISSION_ID.test(mission))) return null;
  if (typeof mission === 'string') return { agent, mission: mission.toLowerCase() };
  return { agent, mission: null, ...(fresh === true ? { fresh: true } : {}) };
}

const MAX_TABS = 24;
// Chromium commits cookies on its own roughly every 30 s; a kill inside that window loses a fresh sign-in.
const COOKIE_FLUSH_DELAY_MS = 2_000;
const STORAGE_FLUSH_MS = 30_000;
const VIEWPORT_SETTLE_MS = 1_000;
const IMMEDIATE_COMMANDS = new Set(['status', 'dialogRespond', 'permissionRespond', 'revokePresentation',
  'fileUploadBegin', 'fileUploadChunk', 'fileUploadCommit', 'fileUploadCancel', 'downloadRead', 'downloadCancel', 'downloadDelete',
  // The sign-in window lives in its own process: nothing it does waits for, or blocks, a page command.
  'chromeSigninStart', 'chromeSigninStatus', 'chromeSigninFinish', 'chromeSigninCancel',
  // Stopping a recording must not wait behind the gesture it is meant to end.
  'recordStop', 'recordStatus', 'annotateStop', 'annotateCollect', 'annotateUnpin',
  // The PWA's pins read rectangles the preload already reported: never behind a page command.
  'annotatePins']);
const DIALOG_BLOCKED_COMMANDS = new Set(['resize', 'screenshot', 'navigate', 'input', 'evaluate',
  'clipboardRead', 'clipboardPaste', 'fillCredential', 'captureCredential', 'fileUploadCommit', 'mediaSource',
  'emulate', 'performanceStart', 'performanceStop', 'annotateStart', 'annotatePick', 'annotateHighlight']);
const ALLOWED_PERMISSIONS = new Set(['media', 'geolocation', 'notifications', 'fullscreen', 'pointerLock', 'mediaKeySystem',
  'storage-access', 'top-level-storage-access']);
const promptEngines = new Set<NativeBrowserEngine>();
const promptDispatcher = (event: IpcMainEvent, message: unknown, defaultPrompt: unknown) => {
  for (const engine of promptEngines) if (engine.handlePrompt(event, message, defaultPrompt)) return;
  event.returnValue = null;
};
// Every document of every tab asks once, synchronously: an answer must always be set.
const recordStateDispatcher = (event: IpcMainEvent) => {
  for (const engine of promptEngines) if (engine.handleRecordState(event)) return;
  event.returnValue = false;
};
const recordEventDispatcher = (event: IpcMainEvent, payload: unknown) => {
  for (const engine of promptEngines) if (engine.handleRecordEvent(event, payload)) return;
};
const annotateStateDispatcher = (event: IpcMainEvent) => {
  for (const engine of promptEngines) if (engine.handleAnnotateState(event)) return;
  event.returnValue = false;
};
const annotateEventDispatcher = (event: IpcMainEvent, payload: unknown) => {
  for (const engine of promptEngines) if (engine.handleAnnotateEvent(event, payload)) return;
};
const bubbleDispatcher = (event: IpcMainEvent, payload: unknown) => {
  for (const engine of promptEngines) if (engine.handleBubbleMessage(event, payload)) return;
};
/** A bubble message is a few words typed by the user; anything far bigger is not from the bubble. */
const BUBBLE_MESSAGE_MAX_BYTES = 20 * 1024;
const ANNOTATION_SOURCE_TIMEOUT_MS = 3_000;
const ANNOTATION_CAPTURE_TIMEOUT_MS = 3_000;
const ANNOTATION_PICK_TIMEOUT_MS = 3_000;
const ANNOTATION_OBJECT_GROUP = 'timon-annotate';
const ANNOTATION_HIGHLIGHT = { color: { r: 59, g: 130, b: 246, a: 0.12 }, outlineColor: { r: 59, g: 130, b: 246, a: 0.9 } };

export class NativeBrowserEngine {
  private readonly profiles = new Map<string, BrowserProfile>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly tickets = new BrowserPresentationTickets();
  private readonly configuredSessions = new WeakSet<Session>();
  private readonly presentations = new Map<string, Presentation>();
  private closing = false;
  private readonly chromeSignin: ChromeSignin;
  /** Contents currently on Google's sign-in host: their requests keep the client hints Electron sends. */
  private readonly googleSigninContents = new Set<number>();

  constructor(private readonly home: string, private readonly options: NativeBrowserEngineOptions = {}) {
    this.chromeSignin = new ChromeSignin({ home });
    if (!promptEngines.size) {
      ipcMain.on(BROWSER_PROMPT_CHANNEL, promptDispatcher);
      ipcMain.on(BROWSER_RECORD_STATE_CHANNEL, recordStateDispatcher);
      ipcMain.on(BROWSER_RECORD_EVENT_CHANNEL, recordEventDispatcher);
      ipcMain.on(BROWSER_ANNOTATE_STATE_CHANNEL, annotateStateDispatcher);
      ipcMain.on(BROWSER_ANNOTATE_EVENT_CHANNEL, annotateEventDispatcher);
      ipcMain.on(BUBBLE_CHANNEL, bubbleDispatcher);
    }
    promptEngines.add(this);
  }

  /** Dispatches only the one capability exposed by browser-page preloads. */
  handlePrompt(event: IpcMainEvent, message: unknown, defaultPrompt: unknown): boolean {
    for (const profile of this.profiles.values()) {
      const tab = [...profile.tabs.values()].find((candidate) => candidate.view.webContents === event.sender);
      if (!tab) continue;
      if (this.closing || profile.stopping || event.senderFrame !== event.sender.mainFrame
        || typeof message !== 'string' || message.length > 32_768 || typeof defaultPrompt !== 'string' || defaultPrompt.length > 32_768) {
        event.returnValue = null; return true;
      }
      this.exposeDialog(profile, tab, { type: 'prompt', message, defaultPrompt,
        url: event.senderFrame?.url ?? event.sender.getURL() }, (accepted, value) => {
        try { event.returnValue = accepted ? value : null; } catch { /* The renderer may have exited while prompting. */ }
      }, 'ipc');
      return true;
    }
    return false;
  }

  private tabOf(sender: WebContents): { profile: BrowserProfile; tab: BrowserTab } | null {
    for (const profile of this.profiles.values()) {
      for (const tab of profile.tabs.values()) if (tab.view.webContents === sender) return { profile, tab };
    }
    return null;
  }

  /** A tab's preload asks, once per document, whether it must record. Only a profile tab's main frame is told yes. */
  handleRecordState(event: IpcMainEvent): boolean {
    const found = this.tabOf(event.sender);
    if (!found) return false;
    event.returnValue = !this.closing && !found.profile.stopping && event.senderFrame === event.sender.mainFrame
      && found.profile.recording?.active === true;
    return true;
  }

  /** One page event from a tab preload. Anything not from a recording profile tab's main frame is dropped. */
  handleRecordEvent(event: IpcMainEvent, payload: unknown): boolean {
    const found = this.tabOf(event.sender);
    if (!found) return false;
    const { profile, tab } = found;
    if (this.closing || profile.stopping || event.senderFrame !== event.sender.mainFrame
      || !profile.recording?.active || !acceptsPageEventSize(payload)) return true;
    this.recordStep(profile, normalizePageEvent(payload, { t: Date.now(), tabId: tab.id }), true);
    return true;
  }

  private recordStep(profile: BrowserProfile, step: RecordingStep | null, page = false): void {
    const session = profile.recording;
    if (!session?.active || !step) return;
    session.add(step, { page });
    if (!session.active) this.recordingEnded(profile);
  }

  /** Fires at the earliest possible idle time, then re-reads the last activity and re-arms. */
  private armRecordingTimer(profile: BrowserProfile): void {
    const session = profile.recording;
    if (profile.recordingTimer) clearTimeout(profile.recordingTimer);
    profile.recordingTimer = null;
    if (!session?.active) return;
    const remaining = session.idleRemaining();
    if (remaining === 0) {
      session.stop('idle');
      this.recordingEnded(profile);
      return;
    }
    profile.recordingTimer = setTimeout(() => this.armRecordingTimer(profile), remaining);
    profile.recordingTimer.unref?.();
  }

  /** The preloads stop sending; a finished session stays until recordStop collects it. */
  private recordingEnded(profile: BrowserProfile): void {
    if (profile.recordingTimer) clearTimeout(profile.recordingTimer);
    profile.recordingTimer = null;
    for (const tab of profile.tabs.values()) {
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send(BROWSER_RECORD_TOGGLE_CHANNEL, false);
    }
  }

  private recordStart(profile: BrowserProfile): Record<string, unknown> {
    if (profile.recording?.active) throw new BrowserCommandError('This browser is already recording.', 409);
    if (profile.recording) throw new BrowserCommandError('Collect the finished recording before starting another one.', 409);
    if (profile.annotation?.active) throw new BrowserCommandError('Finish annotating before recording.', 409);
    const tab = this.active(profile);
    const url = tab.view.webContents.getURL();
    profile.recording = new RecordingSession(maskUrl(url));
    this.recordStep(profile, navigationStep(url, { t: Date.now(), tabId: tab.id }));
    for (const current of profile.tabs.values()) {
      if (!current.view.webContents.isDestroyed()) current.view.webContents.send(BROWSER_RECORD_TOGGLE_CHANNEL, true);
    }
    this.armRecordingTimer(profile);
    return this.status(profile.id);
  }

  private recordStop(profileId: string): RecordingResult {
    const profile = this.profiles.get(profileId);
    const session = profile?.recording;
    if (!profile || !session) throw new BrowserCommandError('This browser has no recording to stop.', 409);
    session.stop('user');
    profile.recording = null;
    this.recordingEnded(profile);
    return session.result();
  }

  private recordingStatus(profile: BrowserProfile | undefined): Record<string, unknown> {
    const session = profile?.recording;
    return { active: session?.active === true, steps: session?.count ?? 0,
      ...(session && !session.active ? { stoppedReason: session.stoppedReason } : {}) };
  }

  /**
   * The agent's gestures are trusted input like the user's: while a profile records, only the
   * user drives it. The daemon sets `commandActor` on every command from the caller's
   * authentication (`commandActorOf` in `native-routes.ts`), dropping whatever the caller sent:
   * `'human'` for a person's session, `'agent'` otherwise. Anything not marked human is an agent's.
   */
  private assertRecordingAllows(profileId: string, body: Record<string, unknown>): void {
    const action = String(body.action);
    const human = body.commandActor === 'human';
    if (RECORDING_CONTROL_COMMANDS.has(action) && !human) {
      throw new BrowserCommandError('Only the user can start or stop a browser recording.', 403);
    }
    if (!human && this.profiles.get(profileId)?.recording?.active && !RECORDING_AGENT_ALLOWED_COMMANDS.has(action)) {
      throw new BrowserCommandError('The user is recording this browser; agent actions resume when the recording stops.', 409);
    }
    // Annotating is the same: an agent's Input.dispatch* would reach the preload as a trusted pick.
    if (ANNOTATION_CONTROL_COMMANDS.has(action) && !human) {
      throw new BrowserCommandError('Only the user can annotate the browser.', 403);
    }
    if (!human && this.profiles.get(profileId)?.annotation?.active && !ANNOTATION_AGENT_ALLOWED_COMMANDS.has(action)) {
      throw new BrowserCommandError('The user is annotating this browser; agent actions resume when they finish.', 409);
    }
  }

  // ---- Annotate mode (TODO #468) ----------------------------------------------------------------

  /** A tab's preload asks, once per document, whether it must annotate: only the annotated tab's main frame is told yes. */
  handleAnnotateState(event: IpcMainEvent): boolean {
    const found = this.tabOf(event.sender);
    if (!found) return false;
    const session = found.profile.annotation;
    event.returnValue = !this.closing && !found.profile.stopping && event.senderFrame === event.sender.mainFrame
      && session?.active === true && session.tabId === found.tab.id;
    return true;
  }

  /** One message from a tab preload. Anything not from the annotated tab's main frame, in annotate mode, is dropped. */
  handleAnnotateEvent(event: IpcMainEvent, payload: unknown): boolean {
    const found = this.tabOf(event.sender);
    if (!found) return false;
    const { profile, tab } = found;
    const session = profile.annotation;
    if (this.closing || profile.stopping || event.senderFrame !== event.sender.mainFrame || !session?.active
      || session.tabId !== tab.id || !acceptsAnnotationEventSize(payload)) return true;
    const message = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
    // The anchors' rectangles as the page scrolls: positions for Timon's own views, nothing stored.
    if (message.type === 'rects') {
      const rects = session.admitRectEvent() ? anchorRectsOf(payload) : null;
      if (rects) {
        profile.bubble?.rects(tab.id, rects);
        for (const { anchor, rect } of rects) {
          for (const pin of profile.pwaPins.values()) if (pin.tabId === tab.id && pin.anchor === anchor) pin.rect = rect;
        }
      }
      return true;
    }
    if (!session.admitPageEvent()) return true;
    // The answer to a PWA point: only a request id the engine issued is awaited.
    if (typeof message.requestId === 'string') {
      profile.annotationWaiters.get(message.requestId)?.(payload);
      return true;
    }
    if (message.type === 'exit' && message.reason === 'escape') { this.stopAnnotation(profile, 'escape'); return true; }
    if (message.type === 'hover') {
      const hover = normalizeAnnotationHover(payload);
      if (!hover) return true;
      session.touch();
      this.highlight(profile, tab, hover.rect);
      return true;
    }
    const pick = normalizeAnnotationPick(payload);
    if (!pick) return true;
    session.touch();
    // In a presented view the pick opens the bubble at once; its capture finishes behind it.
    const bubble = this.bubbleFor(profile, tab);
    if (bubble) {
      const capture = profile.annotationWork.then(() => this.captureAnnotation(profile, tab, pick));
      profile.annotationWork = capture.then(() => {}, () => {});
      bubble.picked(tab.id, pick.rect, bubbleLabel(pick), anchorOf(payload), capture.catch((error: unknown) => {
        console.error('[native-browser] Annotation capture failed', error);
        return null;
      }));
      return true;
    }
    if (profile.annotationPicks.length + profile.annotationCapturing >= ANNOTATION_MAX_PICKS) {
      console.warn(`[native-browser] Annotation pick dropped: ${ANNOTATION_MAX_PICKS} picks wait to be collected.`);
      return true;
    }
    profile.annotationCapturing++;
    // One capture at a time: CDP reads and capturePage of two picks must not interleave.
    profile.annotationWork = profile.annotationWork.then(async () => {
      try {
        const capture = await this.captureAnnotation(profile, tab, pick);
        if (!profile.stopping) profile.annotationPicks.push(capture);
      } catch (error) {
        console.error('[native-browser] Annotation capture failed', error);
      } finally { profile.annotationCapturing--; }
    });
    return true;
  }

  /**
   * The bubble of a profile whose page is presented here, or null (a hidden view, the PWA's video:
   * the pick waits for the app as before). One per profile, kept between annotate sessions.
   */
  private bubbleFor(profile: BrowserProfile, tab: BrowserTab): AnnotationBubbleController | null {
    const presentation = this.presentations.get(profile.id) ?? null;
    if (presentation?.profileId !== profile.id || presentation.window.isDestroyed() || profile.activeTabId !== tab.id) return null;
    if (!profile.overlay) {
      profile.overlay = new AnnotationOverlay({
        preload: fileURLToPath(new URL('./native-browser-bubble-preload.cjs', import.meta.url)),
        document: () => {
          const current = this.presentations.get(profile.id) ?? null;
          return bubbleDocument(bubbleCopy(this.bubbleLocale(current)), current?.scheme ?? this.options.scheme?.() ?? 'dark');
        },
      });
      profile.overlay.attach(presentation.window);
    }
    profile.bubble ??= new AnnotationBubbleController(this.bubbleHost(profile), profile.overlay, this.bubbleLocale(presentation));
    return profile.bubble;
  }

  /** What the tab's preload must follow: the bubble's anchors, then the PWA's, as many as it reports. */
  private trackAnchors(profile: BrowserProfile, tabId: string): void {
    const tab = profile.tabs.get(tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const pwa = profile.pwaFollowed.flatMap((id) => {
      const pin = profile.pwaPins.get(id);
      return pin && pin.tabId === tabId ? [pin.anchor] : [];
    });
    const anchors = [...new Set([...(profile.bubbleAnchors.get(tabId) ?? []), ...pwa])].slice(0, BUBBLE_MAX_QUEUE + 1);
    tab.view.webContents.send(BROWSER_ANNOTATE_TRACK_CHANNEL, anchors);
  }

  private bubbleLocale(presentation: Presentation | null): string | null {
    return presentation?.locale ?? this.options.locale?.() ?? null;
  }

  private bubbleHost(profile: BrowserProfile): BubbleHost {
    const presented = () => {
      const presentation = this.presentations.get(profile.id) ?? null;
      return presentation?.profileId === profile.id && !presentation.window.isDestroyed() ? presentation : null;
    };
    return {
      profileId: profile.id,
      panel: () => presented()?.bounds ?? null,
      conversation: () => presented()?.conversation ?? null,
      queuePick: (capture) => { if (!profile.stopping) profile.annotationPicks.push(capture); },
      pendingPick: (id) => profile.annotationPicks.find((capture): capture is QueuedCapture => capture.id === id && isQueued(capture)),
      dropPick: (id) => {
        const index = profile.annotationPicks.findIndex((capture) => capture.id === id && isQueued(capture));
        if (index < 0) return false;
        profile.annotationPicks.splice(index, 1);
        return true;
      },
      track: (tabId, anchors) => {
        profile.bubbleAnchors.set(tabId, anchors);
        this.trackAnchors(profile, tabId);
      },
      focusPage: () => {
        const tab = profile.annotation?.active ? profile.tabs.get(profile.annotation.tabId) : undefined;
        if (tab && !tab.view.webContents.isDestroyed()) tab.view.webContents.focus();
      },
      touch: () => profile.annotation?.touch(),
      stop: () => this.stopAnnotation(profile, 'user'),
      routes: this.options.annotationRoutesForWindow ? (method, path, body) => {
        const presentation = presented();
        if (!presentation) return Promise.reject(new Error('The browser panel is not presented.'));
        return this.options.annotationRoutesForWindow!(presentation.window)(method, path, body);
      } : this.options.annotationRoutes ?? null,
    };
  }

  /** One message of a bubble. Anything not from a bubble's own main frame is dropped. */
  handleBubbleMessage(event: IpcMainEvent, payload: unknown): boolean {
    for (const profile of this.profiles.values()) {
      if (!profile.overlay?.isBubbleSender(event)) continue;
      if (this.closing || profile.stopping || !profile.bubble) return true;
      let size = Number.POSITIVE_INFINITY;
      try { size = JSON.stringify(payload).length; } catch { /* Not a message of ours. */ }
      const message = size <= BUBBLE_MESSAGE_MAX_BYTES ? bubbleMessageOf(payload) : null;
      if (!message) return true;
      if (message.type === 'ready') profile.overlay.bubbleReady();
      profile.bubble.message(message);
      return true;
    }
    return false;
  }

  private annotationStatus(profile: BrowserProfile | undefined): Record<string, unknown> {
    const session = profile?.annotation;
    // Picks queued from the bubble are the bubble's: the app does not collect them into its drawer.
    return { active: session?.active === true, ...(session?.active ? { tabId: session.tabId } : {}),
      pending: profile?.annotationPicks.filter((capture) => !isQueued(capture)).length ?? 0,
      queued: profile?.bubble?.queued ?? 0, capturing: profile?.annotationCapturing ?? 0,
      // The ids of that queue (TODO #491): the app's "Send" posts this queue, never older drafts.
      ...(profile?.bubble?.queued ? { queuedIds: profile.bubble.annotationIds } : {}),
      ...(session && !session.active ? { stoppedReason: session.stoppedReason } : {}) };
  }

  private async annotateStart(profile: BrowserProfile): Promise<Record<string, unknown>> {
    if (profile.recording?.active) throw new BrowserCommandError('Stop the recording before annotating.', 409);
    if (profile.annotation?.active) throw new BrowserCommandError('This browser is already annotating.', 409);
    const tab = this.active(profile);
    const session = new AnnotationSession(tab.id);
    profile.annotation = session;
    // Overlay needs DOM first, and DOM tracks the tree while enabled: both are off again on exit.
    try {
      await this.cdp(tab, 'DOM.enable');
      await this.cdp(tab, 'Overlay.enable');
      await this.cdp(tab, 'Overlay.setShowViewportSizeOnResize', { show: false });
    } catch (error) {
      // Without a highlight the user still points; the pick does not depend on it.
      console.error('[native-browser] Annotation highlight unavailable', error);
    }
    if (profile.annotation !== session || !session.active) return this.status(profile.id);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.send(BROWSER_ANNOTATE_TOGGLE_CHANNEL, true);
    // The queue of an earlier session shows its pins again, where the preload still knows the elements.
    if (profile.bubble && this.bubbleFor(profile, tab)) profile.bubble.resume(tab.id);
    this.armAnnotationTimer(profile);
    return this.status(profile.id);
  }

  /** Ends annotate mode and hands back the picks still waiting; stopping twice is harmless. */
  private annotateStop(profileId: string): Record<string, unknown> {
    const profile = this.profiles.get(profileId);
    if (profile) this.stopAnnotation(profile, 'user');
    return { ...this.annotationStatus(profile), picks: this.collectPicks(profileId) };
  }

  private collectPicks(profileId: string): AnnotationCapture[] {
    const profile = this.profiles.get(profileId);
    if (!profile) return [];
    const picks = profile.annotationPicks;
    profile.annotationPicks = [];
    return picks;
  }

  private stopAnnotation(profile: BrowserProfile, reason: AnnotationStopReason): void {
    const session = profile.annotation;
    if (!session?.active) return;
    // What the bubble holds joins the queue before the views go.
    profile.bubble?.ended();
    // The PWA's pins go with annotate mode: its queue is drawn again from the next picks.
    profile.pwaPins.clear();
    profile.pwaFollowed = [];
    session.stop(reason);
    if (profile.annotationTimer) clearTimeout(profile.annotationTimer);
    profile.annotationTimer = null;
    for (const resolve of profile.annotationWaiters.values()) resolve({ type: 'miss' });
    profile.annotationWaiters.clear();
    const tab = profile.tabs.get(session.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    tab.view.webContents.send(BROWSER_ANNOTATE_TOGGLE_CHANNEL, false);
    void (async () => {
      for (const method of ['Overlay.hideHighlight', 'Overlay.disable', 'DOM.disable']) await this.cdp(tab, method).catch(() => {});
    })();
  }

  /** Fires at the earliest possible idle time, then re-reads the last activity and re-arms. */
  private armAnnotationTimer(profile: BrowserProfile): void {
    const session = profile.annotation;
    if (profile.annotationTimer) clearTimeout(profile.annotationTimer);
    profile.annotationTimer = null;
    if (!session?.active) return;
    const remaining = session.idleRemaining();
    if (remaining === 0) { this.stopAnnotation(profile, 'idle'); return; }
    profile.annotationTimer = setTimeout(() => this.armAnnotationTimer(profile), remaining);
    profile.annotationTimer.unref?.();
  }

  private highlight(profile: BrowserProfile, tab: BrowserTab, rect: AnnotationRect): void {
    const region = thumbnailRect(rect, profile.viewport, 0);
    void (region ? this.cdp(tab, 'Overlay.highlightRect', { ...region, ...ANNOTATION_HIGHLIGHT })
      : this.cdp(tab, 'Overlay.hideHighlight')).catch(() => {});
  }

  /**
   * The PWA points at a video of the page, so its point is relayed to the annotated tab's preload,
   * which picks with `elementFromPoint`. `preview` only asks what lies there, for the UI's highlight.
   */
  private async annotatePick(profile: BrowserProfile, body: Record<string, unknown>): Promise<unknown> {
    const session = profile.annotation;
    if (!session?.active) throw new BrowserCommandError('Start annotating before picking an element.', 409);
    const tab = profile.tabs.get(session.tabId);
    if (!tab || profile.activeTabId !== tab.id) throw new BrowserCommandError('The annotated tab is no longer active.', 409);
    const { x, y } = body;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= profile.viewport.width
      || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= profile.viewport.height) {
      throw new BrowserCommandError('Pointer coordinates are outside the browser viewport.');
    }
    if (body.preview !== undefined && typeof body.preview !== 'boolean') throw new BrowserCommandError('Invalid preview flag.');
    const preview = body.preview === true;
    session.touch();
    const requestId = randomUUID();
    const answer = await new Promise<unknown>((resolve) => {
      const timer = setTimeout(() => { profile.annotationWaiters.delete(requestId); resolve(null); }, ANNOTATION_PICK_TIMEOUT_MS);
      timer.unref?.();
      profile.annotationWaiters.set(requestId, (payload) => {
        clearTimeout(timer);
        profile.annotationWaiters.delete(requestId);
        resolve(payload);
      });
      tab.view.webContents.send(BROWSER_ANNOTATE_PICK_AT_CHANNEL, { requestId, x, y, preview });
    });
    if (answer === null) throw new BrowserCommandError('The page did not answer the annotation point.', 504);
    if (preview) {
      const hover = normalizeAnnotationHover(answer);
      if (!hover) throw new BrowserCommandError('Nothing to annotate at this point.', 404);
      return { hover };
    }
    const pick = normalizeAnnotationPick(answer);
    if (!pick) throw new BrowserCommandError('Nothing to annotate at this point.', 404);
    // In line with the native view's captures: two never read CDP or capture the page at once.
    const capture = profile.annotationWork.then(() => this.captureAnnotation(profile, tab, pick));
    profile.annotationWork = capture.then(() => {}, () => {});
    const annotation = await capture;
    // The element the PWA picked is remembered by the preload: its pin can follow it (`annotatePins`).
    const anchor = anchorOf(answer);
    if (anchor) this.rememberPwaPin(profile, annotation.id, { tabId: tab.id, anchor, rect: pick.rect });
    return { annotation };
  }

  private rememberPwaPin(profile: BrowserProfile, captureId: string, pin: PwaPin): void {
    profile.pwaPins.set(captureId, pin);
    for (const id of profile.pwaPins.keys()) {
      if (profile.pwaPins.size <= PWA_PINS_MAX) break;
      if (!profile.pwaFollowed.includes(id)) profile.pwaPins.delete(id);
    }
  }

  /**
   * The PWA draws its pins over a video of the page: it names the annotations it shows, the preload
   * of the annotated tab follows their elements, and the answer holds the last rectangle it
   * reported for each (`null`: gone from the page, picked elsewhere, or not by the PWA). Rectangles
   * only, the page's words never; an empty list stops following.
   */
  private annotatePins(profile: BrowserProfile, body: Record<string, unknown>): Record<string, unknown> {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > BUBBLE_MAX_QUEUE + 1 || !ids.every((id) => typeof id === 'string' && ANNOTATION_ID.test(id))) {
      throw new BrowserCommandError('Expected the ids of the annotations to follow.');
    }
    const session = profile.annotation;
    const tabId = session?.active ? session.tabId : null;
    const captureIds = (ids as string[]).map((id) => id.slice('ba-'.length));
    profile.pwaFollowed = tabId ? captureIds : [];
    if (tabId) { session!.touch(); this.trackAnchors(profile, tabId); }
    return {
      pins: (ids as string[]).map((id, index) => {
        const pin = tabId ? profile.pwaPins.get(captureIds[index]!) : undefined;
        return { id, rect: pin && pin.tabId === tabId ? pin.rect : null };
      }),
    };
  }

  /**
   * Shows again the element an annotation was made on, found by its selector in the annotated tab.
   * The lookup is the protocol's (`DOM.querySelector`): no script of the page runs, and what comes
   * back is a rectangle, never the page's words. In annotate mode only, where DOM and Overlay are on.
   */
  private async annotateHighlight(profile: BrowserProfile, body: Record<string, unknown>): Promise<unknown> {
    const session = profile.annotation;
    if (!session?.active) throw new BrowserCommandError('Start annotating before highlighting an element.', 409);
    const tab = profile.tabs.get(session.tabId);
    if (!tab || profile.activeTabId !== tab.id) throw new BrowserCommandError('The annotated tab is no longer active.', 409);
    const selector = annotationSelectorOf(body.selector);
    if (!selector) throw new BrowserCommandError('Invalid annotation selector.');
    session.touch();
    const { root } = await this.cdp(tab, 'DOM.getDocument', { depth: 0 }) as { root?: { nodeId?: unknown } };
    const found = typeof root?.nodeId === 'number'
      ? await this.cdp(tab, 'DOM.querySelector', { nodeId: root.nodeId, selector }).catch(() => null) as { nodeId?: unknown } | null
      : null;
    const nodeId = typeof found?.nodeId === 'number' && found.nodeId > 0 ? found.nodeId : null;
    if (nodeId === null) {
      await this.cdp(tab, 'Overlay.hideHighlight').catch(() => {});
      return { highlight: { found: false } };
    }
    // Scrolled into view first: an element out of the viewport has nothing to highlight.
    await this.cdp(tab, 'DOM.scrollIntoViewIfNeeded', { nodeId }).catch(() => {});
    const rect = boxModelRect(await this.cdp(tab, 'DOM.getBoxModel', { nodeId }).catch(() => null));
    if (!rect) return { highlight: { found: true, visible: false } };
    this.highlight(profile, tab, rect);
    return { highlight: { found: true, visible: !!thumbnailRect(rect, profile.viewport, 0), rect } };
  }

  /** Annotations sent or deleted from the app lose their pin and leave the bubble's queue. */
  private annotateUnpin(profile: BrowserProfile, body: Record<string, unknown>): Record<string, unknown> {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length > 100 || !ids.every((id) => typeof id === 'string' && /^ba-[0-9a-f-]{36}$/.test(id))) {
      throw new BrowserCommandError('Expected the ids of the annotations to unpin.');
    }
    const unpinned = profile.bubble?.unpin(ids as string[]) ?? 0;
    return { annotation: this.annotationStatus(profile), unpinned };
  }

  /** What only the host can add to a pick: the page's identity, the component source, a thumbnail. */
  private async captureAnnotation(profile: BrowserProfile, tab: BrowserTab, pick: AnnotationPick): Promise<AnnotationCapture> {
    const contents = tab.view.webContents;
    const source = await this.annotationSource(tab, pick);
    const thumbnail = await this.annotationThumbnail(profile, tab, pick);
    return {
      version: ANNOTATION_VERSION, id: randomUUID(), capturedAt: new Date().toISOString(), tabId: tab.id,
      url: annotationUrl(contents.getURL()), title: annotationTitle(contents.getTitle()), ...pick, source,
      ...(thumbnail ? { thumbnail } : {}),
    };
  }

  /**
   * The component source, read without running page code: the node at the pick's point, resolved
   * to a handle, then walked by own-property listings only (never `Runtime.callFunctionOn`, never
   * `Runtime.enable`). `DOM.getNodeForLocation` takes document coordinates, the pick viewport ones.
   */
  private async annotationSource(tab: BrowserTab, pick: AnnotationPick): Promise<AnnotationSource> {
    const none: AnnotationSource = { detected: false };
    const own = async (objectId: string): Promise<CdpProperty[]> =>
      (await this.cdp(tab, 'Runtime.getProperties', { objectId, ownProperties: true, generatePreview: false })).result ?? [];
    const lookup = async (): Promise<AnnotationSource> => {
      const visual = (await this.cdp(tab, 'Page.getLayoutMetrics'))?.cssVisualViewport ?? {};
      const pageX = Number.isFinite(visual.pageX) ? visual.pageX : 0;
      const pageY = Number.isFinite(visual.pageY) ? visual.pageY : 0;
      const located = await this.cdp(tab, 'DOM.getNodeForLocation', {
        x: Math.round(pick.point.x + pageX), y: Math.round(pick.point.y + pageY), includeUserAgentShadowDOM: false,
      });
      const backendNodeId = located?.backendNodeId;
      if (!Number.isInteger(backendNodeId)) return none;
      // The page may have changed under the point since the click: a different element is not ours.
      const { node } = await this.cdp(tab, 'DOM.describeNode', { backendNodeId });
      if (String(node?.nodeName ?? '').toLowerCase() !== pick.target.tag) return none;
      const { object } = await this.cdp(tab, 'DOM.resolveNode', { backendNodeId, objectGroup: ANNOTATION_OBJECT_GROUP });
      return typeof object?.objectId === 'string' ? readSource(object.objectId, own) : none;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([lookup(), new Promise<AnnotationSource>((resolve) => {
        timer = setTimeout(() => resolve(none), ANNOTATION_SOURCE_TIMEOUT_MS);
        timer.unref?.();
      })]);
    } catch { return none; } finally {
      if (timer) clearTimeout(timer);
      void this.cdp(tab, 'Runtime.releaseObjectGroup', { objectGroup: ANNOTATION_OBJECT_GROUP }).catch(() => {});
    }
  }

  /**
   * `capturePage` with a viewport rectangle, not `Page.captureScreenshot` with a clip: on a hidden
   * host window the latter leaves one capture in two unanswered (spike #468, TODO #473), and
   * `captureBeyondViewport` resizes and scrolls the page. A target out of view gets no thumbnail.
   */
  private async annotationThumbnail(profile: BrowserProfile, tab: BrowserTab, pick: AnnotationPick): Promise<AnnotationThumbnail | undefined> {
    const region = thumbnailRect(pick.rect, profile.viewport);
    if (!region || tab.view.webContents.isDestroyed()) return undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const image = await Promise.race([tab.view.webContents.capturePage(region), new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ANNOTATION_CAPTURE_TIMEOUT_MS);
        timer.unref?.();
      })]);
      if (!image || image.isEmpty()) return undefined;
      const size = image.getSize();
      const target = thumbnailSize(size.width, size.height);
      const scaled = target.width === size.width && target.height === size.height ? image : image.resize({ ...target, quality: 'good' });
      for (const quality of [72, 55, 40]) {
        const jpeg = scaled.toJPEG(quality);
        if (jpeg.length <= ANNOTATION_THUMBNAIL_MAX_BYTES) {
          return { mimeType: 'image/jpeg', data: jpeg.toString('base64'), ...scaled.getSize() };
        }
      }
      return undefined;
    } catch (error) {
      console.error('[native-browser] Annotation thumbnail failed', error);
      return undefined;
    } finally { if (timer) clearTimeout(timer); }
  }

  get hasSessions(): boolean { return this.profiles.size > 0; }

  mediaSource(profileId: string): { webContents: WebContents; width: number; height: number } {
    const profile = this.requireProfile(profileIdOf(profileId));
    this.assertDialogAllows(profile.id, 'mediaSource');
    return { webContents: this.active(profile).view.webContents, width: profile.viewport.width, height: profile.viewport.height };
  }

  private assertDialogAllows(profileId: string, action: unknown): void {
    if (this.profiles.get(profileId)?.dialogs.size && DIALOG_BLOCKED_COMMANDS.has(String(action))) {
      throw new BrowserCommandError('Respond to the pending browser dialog before continuing.', 409);
    }
  }

  /** Serialize a profile's commands without preventing independent profiles from progressing. */
  command(body: Record<string, unknown>): Promise<unknown> {
    if (this.closing) return Promise.reject(new BrowserCommandError('Browser provider is shutting down.', 503));
    const profileId = profileIdOf(body.profileId);
    // A sync prompt suspends its renderer. Reject new renderer work before it can
    // queue behind that prompt, without interrupting the gesture that opened it.
    try { this.assertDialogAllows(profileId, body.action); this.assertRecordingAllows(profileId, body); }
    catch (error) { return Promise.reject(error); }
    // Responding to a modal must never wait behind the gesture/evaluation it suspended.
    if (IMMEDIATE_COMMANDS.has(String(body.action))) return this.execute(profileId, body);
    const previous = this.queues.get(profileId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.execute(profileId, body));
    this.queues.set(profileId, next);
    void next.finally(() => {
      if (this.queues.get(profileId) === next) this.queues.delete(profileId);
    }).catch(() => {});
    return next;
  }

  private status(profileId: string): Record<string, unknown> {
    const profile = this.profiles.get(profileId);
    return {
      running: !!profile, profileId,
      tabs: profile ? [...profile.tabs.values()].map(({ id, view }) => ({
        id, url: view.webContents.getURL() || 'about:blank', title: view.webContents.getTitle(),
      })) : [],
      activeTabId: profile?.activeTabId || null,
      ...(profile?.viewport ?? DEFAULT_VIEWPORT),
      canGoBack: !!profile && this.active(profile).view.webContents.navigationHistory.canGoBack(),
      canGoForward: !!profile && this.active(profile).view.webContents.navigationHistory.canGoForward(),
      dialog: profile ? [...profile.dialogs.values()].map(({ respond: _respond, cancelTimer: _timer, source: _source, ...data }) => data)[0] ?? null : null,
      fileChooser: profile?.fileChooser ? (({ backendNodeId: _node, ...data }) => data)(profile.fileChooser) : null,
      permissions: profile ? [...profile.permissions.values()].map(({ respond: _respond, timer: _timer, ...data }) => data) : [],
      downloads: profile ? [...profile.downloads.values()].map(({ item: _item, ...data }) => data) : [],
      contextMenu: profile?.contextMenu ?? null,
      audioMuted: profile?.audioMuted ?? true,
      recording: this.recordingStatus(profile),
      annotation: this.annotationStatus(profile),
    };
  }

  private requireProfile(profileId: string): BrowserProfile {
    const profile = this.profiles.get(profileId);
    if (!profile) throw new BrowserCommandError('The requested browser profile is not running.', 409);
    return profile;
  }

  private active(profile: BrowserProfile): BrowserTab {
    const tab = profile.tabs.get(profile.activeTabId);
    if (!tab) throw new BrowserCommandError('The browser has no active tab.', 409);
    return tab;
  }

  private async execute(profileId: string, body: Record<string, unknown>): Promise<unknown> {
    // A dialog can also open, or a recording start, while an otherwise valid command waits in the queue.
    this.assertDialogAllows(profileId, body.action);
    this.assertRecordingAllows(profileId, body);
    if (body.action === 'status') return this.status(profileId);
    if (body.action === 'recordStatus') return { recording: this.recordingStatus(this.profiles.get(profileId)) };
    if (body.action === 'recordStop') return { recording: this.recordStop(profileId) };
    if (body.action === 'recordStart') return this.recordStart(this.requireProfile(profileId));
    if (body.action === 'annotateStart') return this.annotateStart(this.requireProfile(profileId));
    if (body.action === 'annotateStop') return { ...this.status(profileId), annotation: this.annotateStop(profileId) };
    if (body.action === 'annotateCollect') return { annotation: { ...this.annotationStatus(this.profiles.get(profileId)), picks: this.collectPicks(profileId) } };
    if (body.action === 'annotatePick') return this.annotatePick(this.requireProfile(profileId), body);
    if (body.action === 'annotateHighlight') return this.annotateHighlight(this.requireProfile(profileId), body);
    if (body.action === 'annotateUnpin') return this.annotateUnpin(this.requireProfile(profileId), body);
    if (body.action === 'annotatePins') return this.annotatePins(this.requireProfile(profileId), body);
    if (body.action === 'start') {
      if (!this.profiles.has(profileId)) await this.startProfile(profileId);
      return this.status(profileId);
    }
    if (body.action === 'stop') {
      const recording = await this.stopProfile(profileId);
      // An agent may stop the browser once a recording ended on its own; what the user typed is
      // handed to a human command only (the daemon collects it first for an agent's stop).
      return { ...this.status(profileId), ...(recording && body.commandActor === 'human' ? { recordingResult: recording } : {}) };
    }
    if (body.action === 'revokePresentation') {
      this.tickets.revoke(profileId);
      const revoked = this.profiles.get(profileId);
      if (revoked) {
        revoked.audioMuted = true;
        for (const tab of revoked.tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.setAudioMuted(true);
      }
      this.detachProfile(profileId);
      return this.status(profileId);
    }
    if (body.action === 'chromeSigninStatus') return this.chromeSignin.status(profileId);
    if (body.action === 'chromeSigninFinish') return this.chromeSignin.finish(profileId);
    if (body.action === 'chromeSigninCancel') return this.chromeSignin.cancel(profileId);
    if (body.action === 'chromeSigninStart') {
      // The cookies land in this profile's session and nowhere else.
      return this.chromeSignin.start(profileId, { executable: body.executable, url: body.url },
        this.requireProfile(profileId).session.cookies);
    }
    const profile = this.requireProfile(profileId);
    const tab = this.active(profile);
    const contents = tab.view.webContents;
    switch (body.action) {
      case 'audio': {
        if (typeof body.muted !== 'boolean') throw new BrowserCommandError('Expected a muted flag.');
        profile.audioMuted = body.muted;
        for (const current of profile.tabs.values()) current.view.webContents.setAudioMuted(body.muted);
        break;
      }
      case 'dialogRespond': {
        const pending = typeof body.dialogId === 'string' ? profile.dialogs.get(body.dialogId) : undefined;
        if (!pending) throw new BrowserCommandError('This browser dialog is no longer pending.', 404);
        if (typeof body.accept !== 'boolean' || (body.promptText !== undefined
          && (typeof body.promptText !== 'string' || body.promptText.length > 32_768))) {
          throw new BrowserCommandError('Invalid browser dialog response.');
        }
        profile.dialogs.delete(pending.id);
        pending.respond(body.accept, typeof body.promptText === 'string' ? body.promptText : '');
        break;
      }
      case 'permissionRespond': {
        const pending = typeof body.permissionId === 'string' ? profile.permissions.get(body.permissionId) : undefined;
        if (!pending) throw new BrowserCommandError('This browser permission is no longer pending.', 404);
        if (typeof body.allow !== 'boolean') throw new BrowserCommandError('Invalid browser permission response.');
        const requestingTab = profile.tabs.get(pending.tabId);
        // A permission prompt cannot outlive the origin which requested it.
        const currentOrigin = requestingTab ? new URL(requestingTab.view.webContents.getURL()).origin : '';
        const allowed = body.allow && currentOrigin === pending.origin;
        if (allowed) {
          if (pending.permission === 'media') {
            for (const mediaType of pending.mediaTypes) profile.grantedPermissions.add(`${pending.origin}|media:${mediaType}`);
          } else profile.grantedPermissions.add(`${pending.origin}|${pending.permission}`);
        }
        this.completePermission(profile, pending, allowed);
        break;
      }
      case 'contextMenuDismiss': profile.contextMenu = null; break;
      case 'clipboardRead': {
        const result = await this.cdp(tab, 'Runtime.evaluate', {
          expression: `(() => {
            const element = document.activeElement;
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
              if (element instanceof HTMLInputElement && element.type === 'password') return { text: '' };
              const start = element.selectionStart, end = element.selectionEnd;
              if (start === null || end === null) return { text: '' };
              const text = element.value.slice(start, end);
              if (${body.cut === true} && !element.readOnly && !element.disabled) {
                element.setRangeText('', start, end, 'start');
                element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteByCut' }));
              }
              return { text };
            }
            const selection = getSelection(); const text = selection?.toString() ?? '';
            if (${body.cut === true} && element instanceof HTMLElement && element.isContentEditable) document.execCommand('delete');
            return { text };
          })()`, returnByValue: true, userGesture: true,
        });
        return { text: String(result.result?.value?.text ?? '').slice(0, 100_000) };
      }
      case 'clipboardPaste': {
        if (typeof body.text !== 'string' || body.text.length > 100_000) throw new BrowserCommandError('Invalid clipboard text.');
        await this.cdp(tab, 'Input.insertText', { text: body.text });
        break;
      }
      case 'fillCredential':
      case 'captureCredential': {
        const result = await this.cdp(tab, 'Runtime.evaluate', {
          expression: credentialScript(body.action === 'fillCredential' ? 'fill' : 'capture', body),
          returnByValue: true, userGesture: true, timeout: 5000,
        });
        const value = result.result?.value;
        if (result.exceptionDetails || !value || value.error) throw new BrowserCommandError('This page cannot use the selected browser credential.', 422);
        // The script's own input/change events are synthetic, so the preload ignores them: say it here.
        if (body.action === 'fillCredential' && body.commandActor === 'human') {
          this.recordStep(profile, credentialStep(body.origin, body.credentialId, { t: Date.now(), tabId: tab.id }));
        }
        return value;
      }
      case 'fileUploadBegin': return this.beginUpload(profile, body);
      case 'fileUploadChunk': return this.uploadChunk(profile, body);
      case 'fileUploadCommit': await this.commitUploads(profile, body); break;
      case 'fileUploadCancel': this.cancelUploads(profile, body.chooserId); break;
      case 'downloadRead': return this.readDownload(profile, body);
      case 'downloadCancel': {
        const download = this.downloadOf(profile, body.downloadId);
        download.item?.cancel();
        break;
      }
      case 'downloadDelete': {
        const download = this.downloadOf(profile, body.downloadId);
        download.item?.cancel();
        profile.downloads.delete(download.id);
        rmSync(join(profile.directory, 'timon-downloads', download.id), { force: true });
        this.saveDownloads(profile);
        break;
      }
      case 'navigate': {
        const result = await this.cdp(tab, 'Page.navigate', { url: browserUrlOf(body.url) });
        if (result.errorText) throw new BrowserCommandError(`Navigation failed: ${result.errorText}`, 502);
        break;
      }
      case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
      case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
      case 'reload': contents.reload(); break;
      case 'resize': {
        profile.viewport = viewportOf(body);
        // A remote client changing the viewport must not leave a native panel at the old size.
        const presentation = this.presentations.get(profileId);
        if (presentation
          && (presentation.bounds.width !== profile.viewport.width || presentation.bounds.height !== profile.viewport.height)) {
          this.detachProfile(profileId);
        }
        profile.host.setContentSize(profile.viewport.width, profile.viewport.height);
        for (const other of profile.tabs.values()) await this.applyViewport(profile, other);
        this.presentActive(profile);
        this.saveTabs(profile);
        await this.viewportSettled(tab);
        break;
      }
      case 'input': await this.input(profile, tab, objectOf(body.event)); break;
      case 'screenshot': {
        // Not Page.captureScreenshot: on a page that paints nothing new, one call in two never
        // answers (TODO #473). capturePage reads the last composited frame, painted or not.
        if (contents.isDestroyed()) throw new BrowserCommandError('The browser tab was closed.', 409);
        const { width, height } = profile.viewport;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let image = await Promise.race([
          contents.capturePage(),
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new BrowserCommandError('The browser command timed out.', 504)), 15_000);
            timeout.unref();
          }),
        ]).finally(() => clearTimeout(timeout));
        if (image.isEmpty()) throw new BrowserCommandError('The page has no frame to capture yet.', 503);
        // The frame is in device pixels: keep the CSS-px size agents and the panel always received.
        const size = image.getSize();
        if (size.width !== width || size.height !== height) image = image.resize({ width, height, quality: 'good' });
        return { data: image.toJPEG(72).toString('base64'), mimeType: 'image/jpeg', width, height };
      }
      case 'newTab': {
        const url = browserUrlOf(body.url ?? 'about:blank');
        const created = this.createTab(profile);
        await this.applyViewport(profile, created);
        await this.cdp(created, 'Page.navigate', { url });
        this.activate(profile, created.id);
        break;
      }
      case 'activateTab': {
        this.activate(profile, this.tabId(profile, body.tabId));
        break;
      }
      case 'closeTab': {
        const id = this.tabId(profile, body.tabId);
        const closing = profile.tabs.get(id)!;
        if (profile.annotation?.active && profile.annotation.tabId === id) this.stopAnnotation(profile, 'tab-closed');
        this.removeView(profile, closing);
        profile.tabs.delete(id);
        this.recordStep(profile, { t: Date.now(), type: 'closeTab', tabId: id });
        closing.view.webContents.close({ waitForBeforeUnload: false });
        if (!profile.tabs.size) {
          const replacement = this.createTab(profile);
          await this.applyViewport(profile, replacement);
          await this.cdp(replacement, 'Page.navigate', { url: 'about:blank' });
        }
        if (profile.activeTabId === id) this.activate(profile, profile.tabs.keys().next().value!);
        this.saveTabs(profile);
        break;
      }
      case 'evaluate': {
        if (typeof body.expression !== 'string' || body.expression.length > 100_000) {
          throw new BrowserCommandError('Invalid browser expression.');
        }
        const result = await this.cdp(tab, 'Runtime.evaluate', {
          expression: body.expression, returnByValue: true, awaitPromise: true, timeout: 5000,
        });
        if (result.exceptionDetails) throw new BrowserCommandError(result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text ?? 'Browser evaluation failed.', 422);
        return { result: result.result?.value ?? null };
      }
      case 'presentation': return { viewToken: this.tickets.issue(profileId) };
      case 'consoleList': return (await this.devtools(tab)).listConsole(body);
      case 'consoleGet': {
        const message = (await this.devtools(tab)).getConsole(body.msgid);
        if (!message) throw new BrowserCommandError('No console message with this id on the current page.', 404);
        return message;
      }
      case 'networkList': return (await this.devtools(tab)).listNetwork(body);
      case 'networkGet': return this.networkRequest(tab, body.reqid);
      case 'emulate': return this.emulate(tab, body);
      case 'performanceStart': return this.performanceStart(tab, body);
      case 'performanceStop': return this.performanceStop(tab);
      default: throw new BrowserCommandError('Unknown browser command.');
    }
    return this.status(profileId);
  }

  private tabId(profile: BrowserProfile, value: unknown): string {
    if (typeof value !== 'string' || !profile.tabs.has(value)) {
      throw new BrowserCommandError('The tab does not belong to the requested browser profile.', 404);
    }
    return value;
  }

  // Applied to the session, not per tab over CDP: an OAuth popup sends its first request before any
  // debugger command can reach it, and a request that still names Electron makes the provider's
  // sign-in loop back instead of completing. The session's own UA does not reach those requests
  // (a navigation the page starts carries Electron's raw UA), so the header itself is rewritten.
  private presentAsChrome(browserSession: Session): void {
    const userAgent = desktopUserAgent(browserSession.getUserAgent());
    browserSession.setUserAgent(userAgent);
    const hints = userAgentMetadata(chromeVersion(userAgent), false, process.platform, process.getSystemVersion());
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      // Google's sign-in gets the versionless UA and Chromium's brands, everything else the full
      // Chrome identity; a popup's first requests also lose Electron's raw UA here (see above).
      const signin = isSigninRequest({ url: details.url, resourceType: details.resourceType,
        onSigninPage: details.webContentsId !== undefined && this.googleSigninContents.has(details.webContentsId) });
      callback({ requestHeaders: identityHeaders(details.requestHeaders, signin, hints) });
    });
  }

  private async startProfile(profileId: string): Promise<void> {
    const directory = join(this.home, 'browser-profiles', profileId, 'electron');
    // Says in the shell log whether a sign-in could have survived at all: a fresh directory means a new profile.
    const reused = existsSync(join(directory, 'Cookies')) || existsSync(join(directory, 'Network', 'Cookies'));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const browserSession = session.fromPath(directory);
    if (!this.configuredSessions.has(browserSession)) {
      browserSession.setPermissionRequestHandler((contents, permission, callback, details) => {
        this.requestPermission(profileId, contents, permission, callback, details);
      });
      browserSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
        const current = this.profiles.get(profileId);
        if (!current || !contents || ![...current.tabs.values()].some((entry) => entry.view.webContents === contents)) return false;
        try {
          const origin = new URL(requestingOrigin).origin;
          if (origin !== new URL(contents.getURL()).origin) return false;
          return current.grantedPermissions.has(`${origin}|${permission === 'media' ? `media:${details.mediaType}` : permission}`);
        }
        catch { return false; }
      });
      browserSession.setDisplayMediaRequestHandler((_request, callback) => callback({}));
      browserSession.on('will-download', (event, item, contents) => {
        const current = this.profiles.get(profileId);
        if (!current || ![...current.tabs.values()].some((entry) => entry.view.webContents === contents)) {
          event.preventDefault(); return;
        }
        try { this.registerDownload(current, item); }
        catch (error) { item.cancel(); console.error('[native-browser] Download failed', error); }
      });
      browserSession.cookies.on('changed', (_event, cookie, _cause, removed) => {
        const current = this.profiles.get(profileId);
        if (!current || current.stopping) return;
        this.scheduleCookieFlush(current);
        if (removed) return;
        const copy = persistentCopyOf(cookie);
        if (copy) browserSession.cookies.set(copy).catch((error: Error) => {
          console.error(`[native-browser] Could not keep session cookie ${cookie.name}: ${error.message}`);
        });
      });
      this.presentAsChrome(browserSession);
      this.configuredSessions.add(browserSession);
    }
    const host = new BrowserWindow({
      show: false, width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height,
      useContentSize: true, skipTaskbar: true, backgroundColor: '#000000',
      webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true, backgroundThrottling: false },
    });
    const profile: BrowserProfile = {
      id: profileId, session: browserSession, host, tabs: new Map(), activeTabId: '',
      viewport: { ...DEFAULT_VIEWPORT }, directory, stopping: false,
      dialogs: new Map(), fileChooser: null, permissions: new Map(), grantedPermissions: new Set(),
      downloads: new Map(), uploads: new Map(), contextMenu: null, audioMuted: true,
      storageFlush: null, cookieFlush: null, recording: null, recordingTimer: null,
      annotation: null, annotationTimer: null, annotationPicks: [], annotationCapturing: 0, annotationWork: Promise.resolve(),
      annotationWaiters: new Map(), bubble: null, overlay: null, bubbleAnchors: new Map(), pwaPins: new Map(), pwaFollowed: [],
    };
    this.profiles.set(profileId, profile);
    profile.storageFlush = setInterval(() => this.flushProfile(profile), STORAGE_FLUSH_MS);
    browserSession.cookies.get({}).then((cookies) => {
      console.log(`[native-browser] Profile ${profileId} ${reused ? 'reopened' : 'created'}: `
        + describeCookieJar(cookies, process.env.TIMON_BROWSER_COOKIE_LOG === '1'));
    }).catch(() => { /* Diagnostics only. */ });
    this.restoreDownloads(profile);
    let urls = ['about:blank'];
    let activeIndex = 0;
    try {
      const saved = objectOf(JSON.parse(readFileSync(join(directory, 'timon-tabs.json'), 'utf8')));
      if (Array.isArray(saved.urls) && saved.urls.length) {
        urls = saved.urls.slice(0, MAX_TABS).map(browserUrlOf);
      }
      if (typeof saved.activeIndex === 'number' && saved.activeIndex >= 0 && saved.activeIndex < urls.length) {
        activeIndex = Math.floor(saved.activeIndex);
      }
      profile.viewport = viewportOf(objectOf(saved.viewport));
    } catch { /* A new/corrupt tab list never prevents access to the persistent profile. */ }
    try {
      host.setContentSize(profile.viewport.width, profile.viewport.height);
      for (const url of urls) {
        const tab = this.createTab(profile);
        await this.applyViewport(profile, tab);
        await this.cdp(tab, 'Page.navigate', { url });
      }
      this.activate(profile, [...profile.tabs.keys()][activeIndex]!);
    } catch (error) {
      await this.stopProfile(profileId);
      throw error;
    }
  }

  private createTab(profile: BrowserProfile, popupPreferences?: WebPreferences, guest?: WebContents, openerTabId?: string): BrowserTab {
    if (profile.tabs.size >= MAX_TABS) throw new BrowserCommandError(`A browser profile can have at most ${MAX_TABS} tabs.`);
    const view = new WebContentsView({ ...(guest ? { webContents: guest } : {}), webPreferences: {
      ...popupPreferences, session: profile.session, sandbox: true, contextIsolation: true,
      nodeIntegration: false, nodeIntegrationInSubFrames: false, webviewTag: false,
      backgroundThrottling: false, safeDialogs: true, navigateOnDragDrop: false,
      // One bounded prompt capability; never the Timon UI preload or a CDP endpoint.
      preload: fileURLToPath(new URL('./native-browser-preload.cjs', import.meta.url)),
    } });
    const tab: BrowserTab = { id: randomUUID(), view, uiWaiters: new Set(), prepared: false, devtools: null, trace: null, identity: 'chrome' };
    profile.tabs.set(tab.id, tab);
    if (!profile.activeTabId) profile.activeTabId = tab.id;
    this.recordStep(profile, { t: Date.now(), type: 'newTab', tabId: tab.id, ...(openerTabId ? { openerTabId } : {}) });
    profile.host.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: profile.viewport.width, height: profile.viewport.height });
    const contents = view.webContents;
    contents.setAudioMuted(profile.audioMuted);
    this.installInteractionHandlers(profile, tab);
    contents.on('will-navigate', (event, url) => {
      try { browserUrlOf(url); } catch { event.preventDefault(); }
    });
    contents.on('will-redirect', (event, url) => {
      try { browserUrlOf(url); } catch { event.preventDefault(); }
    });
    contents.setWindowOpenHandler(({ url }) => {
      try { browserUrlOf(url); } catch { return { action: 'deny' }; }
      if (profile.stopping || profile.tabs.size >= MAX_TABS) return { action: 'deny' };
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: { session: profile.session, sandbox: true, contextIsolation: true,
            nodeIntegration: false, nodeIntegrationInSubFrames: false, backgroundThrottling: false, webviewTag: false,
            preload: fileURLToPath(new URL('./native-browser-preload.cjs', import.meta.url)) },
        },
        createWindow: (options) => {
          // Electron supplies the popup's existing contents (not present in its v33
          // public option type). Adopting it preserves window.opener and the navigation.
          const guest = (options as typeof options & { webContents?: WebContents }).webContents;
          const popup = this.createTab(profile, options.webPreferences, guest, tab.id);
          // Its first requests come before any DevTools command can reach it: the session's header
          // rewrite gives them the sign-in identity already when they head for Google.
          if (isGoogleSigninUrl(url)) this.googleSigninContents.add(popup.view.webContents.id);
          // Finish an in-flight remote gesture before hiding its originating tab.
          void (this.queues.get(profile.id) ?? Promise.resolve()).catch(() => {}).then(() => {
            if (!profile.stopping && profile.tabs.has(popup.id)) this.activate(profile, popup.id);
          });
          popup.view.webContents.once('did-finish-load', () => {
            void this.applyViewport(profile, popup).then(() => this.presentActive(profile)).catch(() => {});
          });
          return popup.view.webContents;
        },
      };
    });
    contents.on('did-navigate', (_event, url) => {
      // Only once the navigation has committed: an identity changed during a navigation or a
      // redirect makes Electron cancel it, which breaks the cross-site POSTs of a sign-in.
      if (identityForUrl(url) !== tab.identity) {
        void this.applyIdentity(profile, tab, url).catch((error: Error) => {
          console.error(`[native-browser] Could not change the browser identity: ${error.message}`);
        });
      }
      this.saveTabs(profile);
      // A new document: the elements the bubble and the pins were anchored on are gone.
      profile.bubble?.navigated(tab.id);
      // Its preload names elements afresh (`a1`…): an old anchor would name another element.
      for (const [id, pin] of profile.pwaPins) if (pin.tabId === tab.id) profile.pwaPins.delete(id);
      // Main frame only (sub-frames emit did-frame-navigate); internal pages and tokens never reach the step.
      this.recordStep(profile, navigationStep(url, { t: Date.now(), tabId: tab.id }));
    });
    contents.on('did-navigate-in-page', () => this.saveTabs(profile));
    const contentsId = contents.id;
    contents.on('destroyed', () => {
      this.googleSigninContents.delete(contentsId);
      if (profile.stopping || !profile.tabs.delete(tab.id)) return;
      if (profile.annotation?.active && profile.annotation.tabId === tab.id) this.stopAnnotation(profile, 'tab-closed');
      this.recordStep(profile, { t: Date.now(), type: 'closeTab', tabId: tab.id });
      if (!profile.tabs.size) {
        const replacement = this.createTab(profile);
        void this.applyViewport(profile, replacement)
          .then(() => this.cdp(replacement, 'Page.navigate', { url: 'about:blank' })).catch(() => {});
      }
      if (profile.activeTabId === tab.id) this.activate(profile, profile.tabs.keys().next().value!);
      this.saveTabs(profile);
    });
    return tab;
  }

  private signalUi(tab: BrowserTab): void {
    for (const resolve of tab.uiWaiters) resolve();
    tab.uiWaiters.clear();
  }

  private exposeDialog(profile: BrowserProfile, tab: BrowserTab,
    details: Pick<BrowserDialog, 'type' | 'message' | 'defaultPrompt' | 'url'>,
    callback: BrowserDialog['respond'], source: BrowserDialog['source']): void {
    const existing = source === 'native'
      ? [...profile.dialogs.values()].find((pending) => pending.tabId === tab.id && pending.source === 'cdp') : undefined;
    existing?.cancelTimer();
    const id = existing?.id ?? randomUUID();
    let replied = false;
    const timer = setTimeout(() => { profile.dialogs.delete(id); pending.respond(false, ''); }, 120_000);
    timer.unref();
    const pending: BrowserDialog = { id, tabId: tab.id, ...details, source,
      cancelTimer: () => clearTimeout(timer),
      respond: (accepted, text) => {
        if (replied) return;
        replied = true; clearTimeout(timer); callback(accepted, text);
      },
    };
    profile.dialogs.set(id, pending);
    this.signalUi(tab);
    this.detachProfile(profile.id);
  }

  private installInteractionHandlers(profile: BrowserProfile, tab: BrowserTab): void {
    const contents = tab.view.webContents;
    // Electron 33 has no public dialog delegate. Its internal handler otherwise
    // opens native message boxes (and refuses prompt()). Keep this adapter covered
    // by the real Electron smoke when upgrading the pinned runtime.
    contents.removeAllListeners('-run-dialog');
    (contents as unknown as EventEmitter).on('-run-dialog', (info: any, callback: (accepted: boolean, prompt: string) => void) => {
      this.exposeDialog(profile, tab, { type: String(info.dialogType),
        message: String(info.messageText ?? '').slice(0, 32_768),
        defaultPrompt: String(info.defaultPromptText ?? '').slice(0, 32_768),
        url: String(info.frame?.url ?? contents.getURL()) }, callback, 'native');
    });
    (contents as unknown as EventEmitter).on('-cancel-dialogs', () => {
      for (const [id, pending] of profile.dialogs) if (pending.tabId === tab.id) {
        profile.dialogs.delete(id); pending.respond(false, '');
      }
    });
    contents.debugger.on('message', (_event, method, params) => {
      tab.devtools?.handle(method, params);
      if (method === 'Page.javascriptDialogOpening') {
        if (![...profile.dialogs.values()].some((pending) => pending.tabId === tab.id)) {
          this.exposeDialog(profile, tab, { type: String(params.type), message: String(params.message).slice(0, 32_768),
            defaultPrompt: String(params.defaultPrompt ?? '').slice(0, 32_768), url: String(params.url) },
            (accept, promptText) => {
              void contents.debugger.sendCommand('Page.handleJavaScriptDialog', { accept, promptText }).catch(() => {});
            }, 'cdp');
        }
        this.signalUi(tab);
        this.detachProfile(profile.id);
        return;
      }
      if (method === 'Page.javascriptDialogClosed') {
        for (const [id, pending] of profile.dialogs) if (pending.tabId === tab.id && pending.source !== 'ipc') {
          pending.cancelTimer(); profile.dialogs.delete(id);
        }
        return;
      }
      if (method !== 'Page.fileChooserOpened') return;
      if (!Number.isInteger(params.backendNodeId)) return;
      if (profile.fileChooser) this.cancelUploads(profile, profile.fileChooser.id);
      profile.fileChooser = { id: randomUUID(), tabId: tab.id,
        multiple: params.mode === 'selectMultiple', backendNodeId: params.backendNodeId };
      this.signalUi(tab);
      this.detachProfile(profile.id);
    });
    contents.on('context-menu', (event, params) => {
      event.preventDefault();
      profile.contextMenu = { id: randomUUID(), tabId: tab.id, x: params.x, y: params.y,
        selectionText: params.formControlType === 'input-password' ? '' : params.selectionText.slice(0, 100_000),
        linkURL: /^https?:/.test(params.linkURL) ? params.linkURL : '', isEditable: params.isEditable };
      this.detachProfile(profile.id);
    });
    const discardRequests = () => {
      for (const [id, pending] of profile.dialogs) {
        if (pending.tabId === tab.id) { profile.dialogs.delete(id); pending.respond(false, ''); }
      }
      if (profile.fileChooser?.tabId === tab.id) this.cancelUploads(profile, profile.fileChooser.id);
      for (const pending of profile.permissions.values()) if (pending.tabId === tab.id) this.completePermission(profile, pending, false);
      if (profile.contextMenu?.tabId === tab.id) profile.contextMenu = null;
    };
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) discardRequests(); });
    contents.once('destroyed', discardRequests);
  }

  private requestPermission(profileId: string, contents: WebContents, permission: string,
    callback: (allow: boolean) => void, details: unknown): void {
    const profile = this.profiles.get(profileId);
    const tab = profile && [...profile.tabs.values()].find((candidate) => candidate.view.webContents === contents);
    if (!profile || !tab || profile.stopping || !ALLOWED_PERMISSIONS.has(permission) || profile.permissions.size >= 20) {
      callback(false); return;
    }
    const request = details as Record<string, unknown>;
    let origin: string;
    try {
      origin = new URL(typeof request.requestingUrl === 'string' ? request.requestingUrl : contents.getURL()).origin;
      if (origin === 'null' || origin !== new URL(contents.getURL()).origin) { callback(false); return; }
    } catch { callback(false); return; }
    const mediaTypes = Array.isArray(request.mediaTypes) ? [...new Set(request.mediaTypes.map(String))] : [];
    if (permission === 'media' && (!mediaTypes.length || mediaTypes.some((type) => !['audio', 'video'].includes(type)))) {
      callback(false); return;
    }
    const alreadyGranted = permission === 'media'
      ? mediaTypes.every((type) => profile.grantedPermissions.has(`${origin}|media:${type}`))
      : profile.grantedPermissions.has(`${origin}|${permission}`);
    if (alreadyGranted) { callback(true); return; }
    const id = randomUUID();
    const pending: BrowserPermission = {
      id, tabId: tab.id, permission, origin, mediaTypes,
      hostDevices: permission === 'media' || permission === 'geolocation', respond: callback,
      timer: setTimeout(() => this.completePermission(profile, pending, false), 120_000),
    };
    pending.timer.unref();
    profile.permissions.set(id, pending);
    this.signalUi(tab);
    this.detachProfile(profileId);
  }

  private completePermission(profile: BrowserProfile, pending: BrowserPermission, allow: boolean): void {
    if (!profile.permissions.delete(pending.id)) return;
    clearTimeout(pending.timer);
    pending.respond(allow);
  }

  private chooserOf(profile: BrowserProfile, id: unknown): BrowserFileChooser {
    if (typeof id !== 'string' || profile.fileChooser?.id !== id) throw new BrowserCommandError('This file chooser is no longer pending.', 404);
    return profile.fileChooser;
  }

  private beginUpload(profile: BrowserProfile, body: Record<string, unknown>): unknown {
    const chooser = this.chooserOf(profile, body.chooserId);
    const name = browserFileName(body.name);
    if (!Number.isInteger(body.size) || (body.size as number) < 0 || (body.size as number) > BROWSER_MAX_FILE_BYTES) {
      throw new BrowserCommandError('Browser uploads are limited to 100 MiB per file.');
    }
    const count = [...profile.uploads.values()].filter((upload) => upload.chooserId === chooser.id).length;
    if (count >= (chooser.multiple ? 20 : 1) || profile.uploads.size >= 200) throw new BrowserCommandError('Too many uploaded browser files.');
    const id = randomUUID();
    const directory = join(profile.directory, 'timon-uploads', id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, name);
    writeFileSync(path, '', { mode: 0o600, flag: 'wx' });
    profile.uploads.set(id, { id, chooserId: chooser.id, name, size: body.size as number, offset: 0, path });
    return { uploadId: id, offset: 0 };
  }

  private uploadChunk(profile: BrowserProfile, body: Record<string, unknown>): unknown {
    const upload = typeof body.uploadId === 'string' ? profile.uploads.get(body.uploadId) : undefined;
    if (!upload || profile.fileChooser?.id !== upload.chooserId) throw new BrowserCommandError('This upload is no longer pending.', 404);
    const bytes = browserFileChunk(body.data);
    if (body.offset !== upload.offset || upload.offset + bytes.length > upload.size) throw new BrowserCommandError('Invalid browser upload offset or size.');
    appendFileSync(upload.path, bytes);
    upload.offset += bytes.length;
    return { uploadId: upload.id, offset: upload.offset };
  }

  private async commitUploads(profile: BrowserProfile, body: Record<string, unknown>): Promise<void> {
    const chooser = this.chooserOf(profile, body.chooserId);
    if (!Array.isArray(body.uploadIds) || !body.uploadIds.length || body.uploadIds.length > (chooser.multiple ? 20 : 1)
      || new Set(body.uploadIds).size !== body.uploadIds.length) throw new BrowserCommandError('Invalid browser upload selection.');
    const uploads = body.uploadIds.map((id) => typeof id === 'string' ? profile.uploads.get(id) : undefined);
    if (uploads.some((upload) => !upload || upload.chooserId !== chooser.id || upload.offset !== upload.size)) {
      throw new BrowserCommandError('Browser upload is incomplete or belongs to another chooser.');
    }
    const tab = profile.tabs.get(chooser.tabId);
    if (!tab) throw new BrowserCommandError('The file chooser tab was closed.', 409);
    await this.cdp(tab, 'DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: uploads.map((upload) => upload!.path) });
    profile.fileChooser = null;
    // Chromium reads selected files lazily at form submission. Retain them until this profile stops.
  }

  private cancelUploads(profile: BrowserProfile, chooserId: unknown): void {
    const chooser = this.chooserOf(profile, chooserId);
    for (const [id, upload] of profile.uploads) {
      if (upload.chooserId !== chooser.id) continue;
      rmSync(join(profile.directory, 'timon-uploads', id), { force: true, recursive: true });
      profile.uploads.delete(id);
    }
    profile.fileChooser = null;
    const tab = profile.tabs.get(chooser.tabId);
    if (tab && !tab.view.webContents.isDestroyed()) {
      void this.cdp(tab, 'DOM.resolveNode', { backendNodeId: chooser.backendNodeId }).then(({ object }) => {
        if (!object?.objectId) return;
        return this.cdp(tab, 'Runtime.callFunctionOn', { objectId: object.objectId,
          functionDeclaration: 'function(){ this.dispatchEvent(new Event("cancel", {bubbles:true})); }' });
      }).catch(() => {});
    }
  }

  private registerDownload(profile: BrowserProfile, item: DownloadItem): void {
    if (profile.downloads.size >= 100 || item.getTotalBytes() > BROWSER_MAX_FILE_BYTES) { item.cancel(); return; }
    const id = randomUUID();
    const directory = join(profile.directory, 'timon-downloads');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    item.setSavePath(join(directory, id));
    const download: BrowserDownload = { id, name: browserFileName(item.getFilename()), mimeType: item.getMimeType(),
      size: item.getTotalBytes(), receivedBytes: item.getReceivedBytes(), state: 'progressing', url: item.getURL(), createdAt: new Date().toISOString(), item };
    profile.downloads.set(id, download);
    item.on('updated', (_event, state) => {
      download.receivedBytes = item.getReceivedBytes(); download.size = item.getTotalBytes(); download.state = state;
      if (download.receivedBytes > BROWSER_MAX_FILE_BYTES) item.cancel();
    });
    item.once('done', (_event, state) => {
      download.receivedBytes = item.getReceivedBytes(); download.size = item.getTotalBytes(); download.state = state;
      delete download.item;
      this.saveDownloads(profile);
    });
  }

  private saveDownloads(profile: BrowserProfile): void {
    try {
      writeFileSync(join(profile.directory, 'timon-downloads.json'), JSON.stringify([...profile.downloads.values()].map(({ item: _item, ...data }) => data)), { mode: 0o600 });
    } catch (error) { console.error('[native-browser] Could not save download list', error); }
  }

  private restoreDownloads(profile: BrowserProfile): void {
    rmSync(join(profile.directory, 'timon-uploads'), { recursive: true, force: true });
    try {
      const rows: unknown = JSON.parse(readFileSync(join(profile.directory, 'timon-downloads.json'), 'utf8'));
      if (!Array.isArray(rows)) return;
      for (const row of rows.slice(0, 100)) {
        if (!row || typeof row.id !== 'string' || !/^[a-f0-9-]{36}$/.test(row.id)) continue;
        const size = statSync(join(profile.directory, 'timon-downloads', row.id)).size;
        profile.downloads.set(row.id, { id: row.id, name: browserFileName(row.name), mimeType: String(row.mimeType ?? 'application/octet-stream'),
          size, receivedBytes: size, state: row.state === 'completed' ? 'completed' : 'interrupted',
          url: String(row.url ?? ''), createdAt: String(row.createdAt ?? '') });
      }
    } catch { /* A deleted download or corrupt list must not prevent opening a profile. */ }
  }

  private downloadOf(profile: BrowserProfile, id: unknown): BrowserDownload {
    const download = typeof id === 'string' ? profile.downloads.get(id) : undefined;
    if (!download) throw new BrowserCommandError('The download does not belong to this browser profile.', 404);
    return download;
  }

  private readDownload(profile: BrowserProfile, body: Record<string, unknown>): unknown {
    const download = this.downloadOf(profile, body.downloadId);
    if (download.state !== 'completed') throw new BrowserCommandError('The browser download is not complete.', 409);
    const length = body.length ?? BROWSER_FILE_CHUNK_BYTES;
    if (!Number.isInteger(body.offset) || (body.offset as number) < 0 || (body.offset as number) > download.receivedBytes
      || !Number.isInteger(length) || (length as number) < 1 || (length as number) > BROWSER_FILE_CHUNK_BYTES) {
      throw new BrowserCommandError('Invalid browser download range.');
    }
    const fd = openSync(join(profile.directory, 'timon-downloads', download.id), 'r');
    try {
      const bytes = Buffer.alloc(length as number);
      const read = readSync(fd, bytes, 0, bytes.length, body.offset as number);
      return { data: bytes.subarray(0, read).toString('base64'), offset: body.offset, size: download.receivedBytes,
        name: download.name, mimeType: download.mimeType, eof: (body.offset as number) + read >= download.receivedBytes };
    } finally { closeSync(fd); }
  }

  private async cdp(tab: BrowserTab, method: string, parameters?: Record<string, unknown>): Promise<any> {
    const contents = tab.view.webContents;
    if (contents.isDestroyed()) throw new BrowserCommandError('The browser tab was closed.', 409);
    if (!contents.debugger.isAttached()) contents.debugger.attach('1.3');
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let uiReady: (() => void) | undefined;
    try {
      return await Promise.race([
        contents.debugger.sendCommand(method, parameters),
        ...(method.startsWith('Input.') ? [new Promise<Record<string, never>>((resolve) => {
          uiReady = () => resolve({}); tab.uiWaiters.add(uiReady);
        })] : []),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            // Runtime's own timeout does not bound an unresolved awaited Promise.
            if (method === 'Runtime.evaluate' && !contents.isDestroyed()) {
              void contents.debugger.sendCommand('Runtime.terminateExecution').catch(() => {});
            }
            reject(new BrowserCommandError('The browser command timed out.', 504));
          }, method === 'Runtime.evaluate' ? 6000 : 15_000);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (uiReady) tab.uiWaiters.delete(uiReady);
    }
  }

  /**
   * Console, log and network reporting starts on a tab's first debug request, never at creation:
   * an enabled Runtime domain is a well-known automation tell that some sites check for.
   */
  private async devtools(tab: BrowserTab): Promise<DevtoolsLog> {
    if (tab.devtools) return tab.devtools;
    const { frameTree } = await this.cdp(tab, 'Page.getFrameTree');
    const log = new DevtoolsLog(String(frameTree?.frame?.id ?? ''));
    tab.devtools = log;
    try {
      // Runtime.enable replays the messages Chromium already holds for this document.
      await this.cdp(tab, 'Runtime.enable');
      await this.cdp(tab, 'Log.enable');
      await this.cdp(tab, 'Network.enable', { maxPostDataSize: BODY_LIMIT });
    } catch (error) {
      tab.devtools = null;
      throw error;
    }
    return log;
  }

  private async networkRequest(tab: BrowserTab, reqid: unknown): Promise<unknown> {
    const entry = (await this.devtools(tab)).getNetwork(reqid);
    if (!entry) throw new BrowserCommandError('No network request with this id on the current page.', 404);
    const { requestId: _requestId, ...request } = entry;
    let responseBody: string | undefined;
    if (entry.state === 'finished') {
      try {
        const { body, base64Encoded } = await this.cdp(tab, 'Network.getResponseBody', { requestId: entry.requestId });
        responseBody = base64Encoded ? `<binary, ${Math.floor(String(body).length * 3 / 4)} bytes>`
          : String(body).length > BODY_LIMIT ? `${String(body).slice(0, BODY_LIMIT)}…` : String(body);
      } catch { responseBody = undefined; /* Evicted from Chromium's buffer, or a response without a body. */ }
    }
    return { ...request, ...(responseBody !== undefined ? { responseBody } : {}) };
  }

  private async emulate(tab: BrowserTab, body: Record<string, unknown>): Promise<unknown> {
    const preset = body.networkConditions;
    const rate = body.cpuThrottlingRate;
    if (preset === undefined && rate === undefined) throw new BrowserCommandError('Supply networkConditions or cpuThrottlingRate.');
    if (preset !== undefined && (typeof preset !== 'string' || !Object.hasOwn(NETWORK_CONDITIONS, preset))) {
      throw new BrowserCommandError(`Unknown network condition. Use one of: ${Object.keys(NETWORK_CONDITIONS).join(', ')}.`);
    }
    if (rate !== undefined && (typeof rate !== 'number' || !Number.isFinite(rate) || rate < 1 || rate > 20)) {
      throw new BrowserCommandError('cpuThrottlingRate must be between 1 and 20.');
    }
    if (typeof preset === 'string') {
      await this.devtools(tab);
      await this.cdp(tab, 'Network.emulateNetworkConditions', NETWORK_CONDITIONS[preset]);
    }
    if (typeof rate === 'number') await this.cdp(tab, 'Emulation.setCPUThrottlingRate', { rate });
    return { networkConditions: preset ?? null, cpuThrottlingRate: rate ?? null };
  }

  private async performanceStart(tab: BrowserTab, body: Record<string, unknown>): Promise<unknown> {
    await this.cdp(tab, 'Performance.enable', { timeDomain: 'timeTicks' });
    tab.trace = (await this.cdp(tab, 'Performance.getMetrics')).metrics ?? [];
    if (body.reload !== true) return { recording: true };
    const contents = tab.view.webContents;
    const loaded = new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 12_000); timer.unref();
      contents.once('did-stop-loading', () => { clearTimeout(timer); resolve(); });
    });
    contents.reload();
    await loaded;
    return body.autoStop === true ? this.performanceStop(tab) : { recording: true, reloaded: true };
  }

  private async performanceStop(tab: BrowserTab): Promise<unknown> {
    if (!tab.trace) throw new BrowserCommandError('No performance recording is running on this tab.', 409);
    const before = tab.trace;
    tab.trace = null;
    const after = (await this.cdp(tab, 'Performance.getMetrics')).metrics ?? [];
    await this.cdp(tab, 'Performance.disable').catch(() => {});
    const page = await this.cdp(tab, 'Runtime.evaluate', { expression: PERFORMANCE_SCRIPT, returnByValue: true, awaitPromise: true, timeout: 5000 });
    return { metrics: metricsDelta(before, after), page: page.result?.value ?? null };
  }

  private async applyViewport(profile: BrowserProfile, tab: BrowserTab): Promise<void> {
    // Electron 33 can crash in device emulation before a WebContents has its first document.
    if (!tab.view.webContents.getURL()) await tab.view.webContents.loadURL('about:blank');
    await this.cdp(tab, 'Page.enable');
    await this.cdp(tab, 'Page.setInterceptFileChooserDialog', { enabled: true });
    if (!tab.prepared) {
      await this.cdp(tab, 'Page.addScriptToEvaluateOnNewDocument', {
        source: `(() => {
          const fallback = window.prompt;
          window.prompt = function(message = '', defaultValue = '') {
            if (typeof globalThis.__timonNativePrompt !== 'function') return fallback.call(window, message, defaultValue);
            return globalThis.__timonNativePrompt(String(message), String(defaultValue));
          };
        })()`, runImmediately: true,
      });
      tab.prepared = true;
    }
    const { width, height, mobile } = profile.viewport;
    tab.view.setBounds({ x: 0, y: 0, width, height });
    await this.cdp(tab, 'Emulation.setDeviceMetricsOverride', {
      width, height, mobile, deviceScaleFactor: 1, screenWidth: width, screenHeight: height,
    });
    await this.cdp(tab, 'Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 1 });
    await this.cdp(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
    await this.applyIdentity(profile, tab, tab.view.webContents.getURL());
  }

  /**
   * Applies the identity `url` calls for: the UA without its Chrome version and Electron's own
   * brands on Google's sign-in host, the full Chrome identity everywhere else. Through DevTools,
   * which reaches the document already loaded and its later requests at once; never through the
   * contents' own `setUserAgent`, which reloads a page that is still loading.
   */
  private async applyIdentity(profile: BrowserProfile, tab: BrowserTab, url: string): Promise<void> {
    const identity = identityForUrl(url);
    const desktopAgent = desktopUserAgent(profile.session.getUserAgent());
    const chrome = chromeVersion(desktopAgent);
    const { mobile } = profile.viewport;
    const applied = identityOverride(identity, mobile ? mobileUserAgent(chrome) : desktopAgent,
      userAgentMetadata(chrome, mobile, process.platform, process.getSystemVersion()));
    tab.identity = identity;
    if (identity === 'googleSignin') this.googleSigninContents.add(tab.view.webContents.id);
    else this.googleSigninContents.delete(tab.view.webContents.id);
    await this.cdp(tab, 'Emulation.setUserAgentOverride', { userAgent: applied.userAgent, userAgentMetadata: applied.userAgentMetadata });
  }

  /**
   * Chromium drops pointer input dispatched before the renderer has painted at a new viewport
   * size: a click sent right after `resize` never reached the page (TODO #465). Two animation
   * frames mean a frame at the new size was produced; the bound covers a page that never paints.
   */
  private async viewportSettled(tab: BrowserTab): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      this.cdp(tab, 'Runtime.evaluate', {
        expression: 'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))',
        awaitPromise: true, returnByValue: true,
      }).catch(() => {}),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, VIEWPORT_SETTLE_MS); timer.unref(); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private activate(profile: BrowserProfile, tabId: string): void {
    this.tabId(profile, tabId);
    if (this.presentations.has(profile.id)) this.parkPresented(profile);
    if (profile.activeTabId !== tabId) this.recordStep(profile, { t: Date.now(), type: 'switchTab', tabId });
    if (profile.annotation?.active && profile.annotation.tabId !== tabId) this.stopAnnotation(profile, 'tab-change');
    profile.activeTabId = tabId;
    this.presentActive(profile);
    this.saveTabs(profile);
  }

  private presentActive(profile: BrowserProfile): void {
    const active = this.active(profile);
    const presentation = this.presentations.get(profile.id) ?? null;
    for (const tab of profile.tabs.values()) tab.view.setVisible(tab === active);
    if (presentation && !presentation.window.isDestroyed()) {
      profile.host.contentView.removeChildView(active.view);
      presentation.window.contentView.addChildView(active.view);
      active.view.setBounds(presentation.bounds);
      // Adding the page's view put it above the bubble and the pins (spike #481): they go back on top.
      profile.overlay?.raise();
    } else {
      profile.host.contentView.addChildView(active.view);
      active.view.setBounds({ x: 0, y: 0, width: profile.viewport.width, height: profile.viewport.height });
    }
  }

  private parkPresented(profile: BrowserProfile): void {
    const presentation = this.presentations.get(profile.id) ?? null;
    if (!presentation || presentation.profileId !== profile.id) return;
    const active = profile.tabs.get(profile.activeTabId);
    if (!active) return;
    if (!presentation.window.isDestroyed()) presentation.window.contentView.removeChildView(active.view);
    profile.host.contentView.addChildView(active.view);
    active.view.setBounds({ x: 0, y: 0, width: profile.viewport.width, height: profile.viewport.height });
  }

  private removeView(profile: BrowserProfile, tab: BrowserTab): void {
    const presentation = this.presentations.get(profile.id);
    if (presentation && !presentation.window.isDestroyed()) {
      presentation.window.contentView.removeChildView(tab.view);
    }
    profile.host.contentView.removeChildView(tab.view);
  }

  /** Called only after main verifies its own UI sender. Ticket binds the selected profile. */
  attach(window: BrowserWindow, value: unknown): void {
    const request = objectOf(value);
    const profileId = profileIdOf(request.profileId);
    if (!this.tickets.permits(profileId, request.viewToken)) {
      throw new BrowserCommandError('Browser presentation ticket is invalid or expired.', 403);
    }
    const profile = this.requireProfile(profileId);
    const raw = objectOf(request.bounds);
    const bounds = { x: raw.x, y: raw.y, width: raw.width, height: raw.height };
    if (Object.values(bounds).some((n) => typeof n !== 'number' || !Number.isFinite(n))) {
      throw new BrowserCommandError('Invalid browser panel bounds.');
    }
    const rectangle = Object.fromEntries(Object.entries(bounds).map(([key, n]) => [key, Math.round(n as number)])) as unknown as Rectangle;
    const [windowWidth = 0, windowHeight = 0] = window.getContentSize();
    if (rectangle.x < 0 || rectangle.y < 0 || rectangle.width !== profile.viewport.width
      || rectangle.height !== profile.viewport.height || rectangle.x + rectangle.width > windowWidth
      || rectangle.y + rectangle.height > windowHeight) {
      console.error('[native-browser] Invalid attachment bounds', { bounds: rectangle, viewport: profile.viewport, windowWidth, windowHeight });
      throw new BrowserCommandError('Native panel bounds must fit the window and match the browser viewport.');
    }
    const locale = typeof request.locale === 'string' && /^[a-z]{2}(?:-[A-Za-z0-9]{2,8})?$/.test(request.locale) ? request.locale : null;
    const scheme = request.scheme === 'light' || request.scheme === 'dark' ? request.scheme : null;
    // The app renews the presentation every 25 s: the bubble being typed in keeps its view and the keyboard.
    const same = this.presentations.get(profileId)?.window === window;
    const typing = same && profile.overlay?.bubbleContents?.isFocused() === true;
    // A window has one panel; a profile's active tab can belong to only one window.
    for (const [id, presented] of this.presentations) {
      if (id !== profileId && presented.window === window) this.detachProfile(id);
    }
    this.detachProfile(profileId, { keepOverlay: same, refocus: !same });
    const presentation: Presentation = { profileId, window, bounds: rectangle, conversation: conversationOf(request.conversation), locale, scheme };
    this.presentations.set(profileId, presentation);
    this.presentActive(profile);
    if (profile.overlay) {
      profile.overlay.attach(window);
      profile.bubble?.setLocale(this.bubbleLocale(presentation));
      profile.bubble?.layout();
      if (typing) profile.overlay.bubbleContents?.focus();
    }
    presentation.timer = setTimeout(() => this.detachProfile(profileId), this.tickets.expiresAt(request.viewToken as string) - Date.now());
    presentation.timer.unref();
  }

  /** Return only this window's tab to its hidden host, leaving other windows alone. */
  detachWindow(window: BrowserWindow): void {
    for (const [profileId, presentation] of this.presentations) {
      if (presentation.window === window) this.detachProfile(profileId);
    }
  }

  /** Shutdown releases every window. Profile-scoped events use `detachProfile`. */
  detach(): void {
    for (const profileId of this.presentations.keys()) this.detachProfile(profileId);
  }

  private detachProfile(profileId: string, options: { keepOverlay?: boolean; refocus?: boolean } = {}): void {
    const presentation = this.presentations.get(profileId);
    if (!presentation) return;
    if (presentation.timer) clearTimeout(presentation.timer);
    const profile = this.profiles.get(profileId);
    if (profile) {
      this.parkPresented(profile);
      if (!options.keepOverlay) profile.overlay?.detach();
    }
    if (options.refocus !== false && !presentation.window.isDestroyed() && presentation.window.isFocused()) {
      if (this.options.focusWindow) this.options.focusWindow(presentation.window);
      else presentation.window.webContents.focus();
    }
    this.presentations.delete(profileId);
  }

  private saveTabs(profile: BrowserProfile): void {
    if (profile.stopping) return;
    const tabs = [...profile.tabs.values()];
    try {
      writeFileSync(join(profile.directory, 'timon-tabs.json'), JSON.stringify({
        urls: tabs.map(({ view }) => view.webContents.getURL() || 'about:blank'),
        activeIndex: tabs.findIndex(({ id }) => id === profile.activeTabId), viewport: profile.viewport,
      }), { mode: 0o600 });
    } catch (error) { console.error('[native-browser] Could not persist tabs', error); }
  }

  private scheduleCookieFlush(profile: BrowserProfile): void {
    if (profile.cookieFlush) return;
    profile.cookieFlush = setTimeout(() => {
      profile.cookieFlush = null;
      this.flushProfile(profile);
    }, COOKIE_FLUSH_DELAY_MS);
  }

  /** Covers a crash or a killed shell: stopProfile's flush never runs then. */
  private flushProfile(profile: BrowserProfile): void {
    if (profile.stopping) return;
    profile.session.flushStorageData();
    profile.session.cookies.flushStore().catch((error: Error) => {
      console.error(`[native-browser] Could not flush cookies of profile ${profile.id}: ${error.message}`);
    });
  }

  /** Returns the recording it ends: the provider has no push channel, so `stop` hands it to the daemon. */
  private async stopProfile(profileId: string): Promise<RecordingResult | null> {
    const profile = this.profiles.get(profileId);
    if (!profile) return null;
    const recording = profile.recording;
    recording?.stop('profile-stopped');
    profile.recording = null;
    if (profile.recordingTimer) clearTimeout(profile.recordingTimer);
    profile.recordingTimer = null;
    // Picks nobody collected are dropped with the profile, like an uncollected page.
    this.stopAnnotation(profile, 'profile-stopped');
    profile.annotationPicks = [];
    profile.overlay?.close();
    profile.overlay = null;
    profile.bubble = null;
    // A sign-in still open is kept, not lost: its cookies are copied before the session is flushed.
    await this.chromeSignin.finish(profileId).catch(() => {});
    if (profile.storageFlush) clearInterval(profile.storageFlush);
    if (profile.cookieFlush) clearTimeout(profile.cookieFlush);
    profile.storageFlush = profile.cookieFlush = null;
    this.detachProfile(profileId);
    this.saveTabs(profile);
    profile.stopping = true;
    for (const pending of profile.dialogs.values()) pending.respond(false, '');
    profile.dialogs.clear();
    for (const pending of profile.permissions.values()) this.completePermission(profile, pending, false);
    for (const download of profile.downloads.values()) download.item?.cancel();
    this.saveDownloads(profile);
    this.tickets.revoke(profileId);
    this.profiles.delete(profileId);
    for (const tab of profile.tabs.values()) {
      this.removeView(profile, tab);
      tab.view.webContents.close({ waitForBeforeUnload: false });
    }
    profile.tabs.clear();
    try {
      profile.session.flushStorageData();
      await profile.session.cookies.flushStore();
    } finally {
      profile.host.destroy();
      rmSync(join(profile.directory, 'timon-uploads'), { recursive: true, force: true });
    }
    return recording?.result() ?? null;
  }

  async close(): Promise<void> {
    this.closing = true;
    // Release sync page prompts before waiting for any suspended input/evaluation.
    for (const profile of this.profiles.values()) {
      for (const pending of profile.dialogs.values()) pending.respond(false, '');
      profile.dialogs.clear();
    }
    await Promise.allSettled([...this.queues.values()]);
    this.detach();
    const results = await Promise.allSettled([...this.profiles.keys()].map((profileId) => this.stopProfile(profileId)));
    for (const result of results) {
      if (result.status === 'rejected') console.error('[native-browser] Could not flush browser profile', result.reason);
    }
    promptEngines.delete(this);
    if (!promptEngines.size) {
      ipcMain.removeListener(BROWSER_PROMPT_CHANNEL, promptDispatcher);
      ipcMain.removeListener(BROWSER_RECORD_STATE_CHANNEL, recordStateDispatcher);
      ipcMain.removeListener(BROWSER_RECORD_EVENT_CHANNEL, recordEventDispatcher);
      ipcMain.removeListener(BROWSER_ANNOTATE_STATE_CHANNEL, annotateStateDispatcher);
      ipcMain.removeListener(BROWSER_ANNOTATE_EVENT_CHANNEL, annotateEventDispatcher);
      ipcMain.removeListener(BUBBLE_CHANNEL, bubbleDispatcher);
    }
  }

  private async input(profile: BrowserProfile, tab: BrowserTab, event: Record<string, unknown>): Promise<void> {
    let modifiers = 0;
    if (Array.isArray(event.modifiers)) {
      for (const modifier of event.modifiers) {
        const bit = ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 } as Record<string, number>)[String(modifier)];
        if (!bit) throw new BrowserCommandError('Unknown keyboard modifier.');
        modifiers |= bit;
      }
    } else if (event.modifiers !== undefined) {
      if (!Number.isInteger(event.modifiers) || (event.modifiers as number) < 0 || (event.modifiers as number) > 15) {
        throw new BrowserCommandError('Invalid keyboard modifiers.');
      }
      modifiers = event.modifiers as number;
    }
    if (event.type === 'text') {
      if (typeof event.text !== 'string' || event.text.length > 32_768) throw new BrowserCommandError('Invalid browser text.');
      await this.cdp(tab, 'Input.insertText', { text: event.text });
      return;
    }
    if (event.type === 'key') {
      if (typeof event.key !== 'string' || event.key.length > 32) throw new BrowserCommandError('Invalid browser key.');
      const key = event.key;
      if ((modifiers & 6) && /^[cvx]$/i.test(key)) {
        throw new BrowserCommandError('Use the explicit clipboard command for copy, cut or paste.');
      }
      const special: Record<string, { code: string; vk: number; text?: string }> = {
        Enter: { code: 'Enter', vk: 13, text: '\r' }, Backspace: { code: 'Backspace', vk: 8 },
        Tab: { code: 'Tab', vk: 9 }, Escape: { code: 'Escape', vk: 27 },
        Delete: { code: 'Delete', vk: 46 }, ArrowLeft: { code: 'ArrowLeft', vk: 37 },
        ArrowUp: { code: 'ArrowUp', vk: 38 }, ArrowRight: { code: 'ArrowRight', vk: 39 },
        ArrowDown: { code: 'ArrowDown', vk: 40 }, Home: { code: 'Home', vk: 36 },
        End: { code: 'End', vk: 35 }, PageUp: { code: 'PageUp', vk: 33 }, PageDown: { code: 'PageDown', vk: 34 },
      };
      const definition = special[key] ?? (key.length === 1 ? {
        code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key === ' ' ? 'Space' : '',
        vk: key.toUpperCase().charCodeAt(0), text: modifiers & 7 ? undefined : key,
      } : null);
      if (!definition) throw new BrowserCommandError('Unsupported browser key.');
      const params = {
        key, code: definition.code, windowsVirtualKeyCode: definition.vk, modifiers,
        ...(definition.text ? { text: definition.text, unmodifiedText: definition.text } : {}),
      };
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await this.cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params, text: undefined, unmodifiedText: undefined });
      return;
    }
    if (!['click', 'down', 'up', 'move', 'wheel'].includes(String(event.type))) throw new BrowserCommandError('Unknown browser input type.');
    const { x, y } = event;
    if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x >= profile.viewport.width
      || typeof y !== 'number' || !Number.isFinite(y) || y < 0 || y >= profile.viewport.height) {
      throw new BrowserCommandError('Pointer coordinates are outside the browser viewport.');
    }
    const button = event.button ?? 'left';
    const clickCount = event.clickCount ?? 1;
    const buttons = event.buttons ?? (event.type === 'down' ? ({ left: 1, right: 2, middle: 4 } as Record<string, number>)[String(button)] : 0);
    const unpressed = (event.type === 'move' || event.type === 'wheel') && buttons === 0;
    if (!(unpressed && button === 'none') && !['left', 'right', 'middle'].includes(String(button)) || ![1, 2].includes(clickCount as number)
      || !Number.isInteger(buttons) || (buttons as number) < 0 || (buttons as number) > 7) {
      throw new BrowserCommandError('Invalid browser pointer button.');
    }
    const params = { x, y, modifiers, button: unpressed ? 'none' : button, buttons };
    if (event.type === 'click') {
      await this.cdp(tab, 'Input.dispatchMouseEvent', { ...params, type: 'mousePressed', clickCount,
        buttons: ({ left: 1, right: 2, middle: 4 } as Record<string, number>)[String(button)] });
      await this.cdp(tab, 'Input.dispatchMouseEvent', { ...params, type: 'mouseReleased', clickCount, buttons: 0 });
    } else if (event.type === 'down' || event.type === 'up') {
      await this.cdp(tab, 'Input.dispatchMouseEvent', { ...params, type: event.type === 'down' ? 'mousePressed' : 'mouseReleased', clickCount });
    } else if (event.type === 'move') {
      await this.cdp(tab, 'Input.dispatchMouseEvent', { ...params, type: 'mouseMoved' });
    } else {
      const deltaX = event.deltaX ?? 0;
      const deltaY = event.deltaY ?? 0;
      if ([deltaX, deltaY].some((n) => typeof n !== 'number' || !Number.isFinite(n) || Math.abs(n) > 10_000)) {
        throw new BrowserCommandError('Invalid browser wheel delta.');
      }
      await this.cdp(tab, 'Input.dispatchMouseEvent', { ...params, type: 'mouseWheel', deltaX, deltaY });
    }
  }
}
