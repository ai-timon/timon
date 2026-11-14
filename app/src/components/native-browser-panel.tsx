'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, AppWindow, ArrowLeft, ArrowRight, ClipboardPaste, Copy, Download, Globe, Settings2, KeyRound, Loader2, LogIn, Monitor, MousePointer2, Plus, Power, RotateCw, Send, Smartphone, Volume2, VolumeX, X } from 'lucide-react';
import { useWorkspaceLayout } from '@/components/workspace-layout-provider';
import { useChatConversation } from '@/lib/browser-panel-bus';
import { DESKTOP_RES } from '@/lib/browser-display';
import { desktopBridge } from '@/lib/desktop';
import { activeMachineId } from '@/lib/machines/machine-storage';
import { LOCAL_MACHINE_ID } from '@/lib/machines/machine-id';
import { addressBarTarget, browserPanelBounds, nativeBrowserCommand, nativeBrowserRequest, shouldAutoClaim, type BrowserCommand, type BrowserProfile, type BrowserShot, type NativeBrowserStatus } from '@/lib/native-browser';
import { getLocale, t } from '@/lib/i18n';
import { openAgentEditor } from '@/components/agent-editor/agent-editor-modal';
import { cn } from '@/lib/utils';
import { browserInputQueue, type RemoteInput } from '@/lib/native-browser-input';
import { useBrowserMedia } from '@/hooks/use-browser-media';
import { BrowserRemoteSurface } from '@/components/browser-remote-surface';
import { BrowserCredentials } from '@/components/browser-credentials';
import { BrowserChromeSignin, chromeSigninReport, type ChromeSigninReason, type ChromeSigninStatus } from '@/components/browser-chrome-signin';
import { EMPTY_TAB_TRAIL, googleSigninPlan, isGoogleAccountsPage, isGoogleSigninRejected, noteUserTab, trackBrowserTabs, type GoogleSigninPlan } from '@/lib/google-signin';
import { BrowserPrompts } from '@/components/browser-prompts';
import { BROWSER_DRAWER_SLOT, BrowserChromeProvider, BrowserDrawerSlot, BrowserToolbarSlot, PLUGIN_DRAWER_PREFIX, type BrowserChrome, type PluginDrawer } from '@/components/browser-chrome';
import { useSlotEntry } from '@/lib/plugin-host/render';
import { slotEntry } from '@/lib/plugin-host/slots';
import { useIslandGesture } from '@/lib/island-drag';
import { useNativeViewsCovered } from '@/lib/native-view-cover';

export { BROWSER_ISLAND_KEY, BROWSER_ISLAND_TYPE, NativeBrowserPanel } from './native-browser-opener';
import { apiErrorMessage } from '@/lib/api-error';

const button = 'rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40';
const menuButton = 'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs hover:bg-muted disabled:opacity-40';
const field = 'min-w-0 rounded-md border border-input bg-background px-2 py-1.5 text-xs';

/** Whether this daemon offers the native browser; asked again by `retry`. */
export function useNativeBrowserCapability(): { available: boolean; error: string | null; retry: () => void } {
  const [provider, setProvider] = useState<'checking' | 'native'>('checking');
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void nativeBrowserRequest<{ available: boolean; reason?: string }>('capabilities', undefined, controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        if (value.available) setProvider('native');
        else { setProvider('checking'); setError(value.reason || t('browserPanel.native.unavailable')); }
      })
      .catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); });
    return () => controller.abort();
  }, [attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  return { available: provider === 'native', error, retry };
}

export type BrowserDisplay = 'auto' | 'desktop' | 'mobile';

/**
 * The browser of the window, without the window: address bar, tabs, the
 * remote surface and its drawers. `visible` says whether it is on screen;
 * `placement` changes each time its frame settles at a new place, which a
 * ResizeObserver does not see.
 */
export function NativeBrowserView({ agent, mission, visible, available, capabilityError, retryCapability, display, onDisplay, placement, trackPosition = false }: {
  agent: string;
  mission: string | null;
  visible: boolean;
  available: boolean; capabilityError: string | null; retryCapability: () => void;
  display: BrowserDisplay;
  onDisplay: (display: BrowserDisplay) => void;
  placement: number;
  /** In an island: no frame tells it when it moves (a split beside it, a drop), so it checks. */
  trackPosition?: boolean;
}) {
  const workspace = useWorkspaceLayout();
  const [narrow, setNarrow] = useState(false);
  // What the annotations are posted to follows the chat of this agent when it is on screen
  // (TODO #481): its current conversation, or a fresh one on "New conversation", as its composer.
  // The profile stays the one this browser was opened with.
  const chat = useChatConversation(agent);
  const conversation = useMemo(() => (chat
    ? { agent, mission: chat.missionId, ...(chat.missionId ? {} : { fresh: true }) }
    : { agent, mission }), [agent, mission, chat]);
  const conversationRef = useRef(conversation);
  conversationRef.current = conversation;
  const bindingKey = JSON.stringify([workspace.owner, agent, mission, workspace.project]);
  const [loadedBinding, setLoadedBinding] = useState<string | null>(null);
  const [boundProfile, setProfile] = useState<BrowserProfile | null>(null);
  const profile = loadedBinding === bindingKey ? boundProfile : null;
  const [profiles, setProfiles] = useState<BrowserProfile[]>([]);
  const [boundStatus, setStatus] = useState<NativeBrowserStatus | null>(null);
  const status = loadedBinding === bindingKey ? boundStatus : null;
  const [clientId] = useState(() => crypto.randomUUID());
  const browserCommand = useCallback(<T,>(id: string, action: string, data: Record<string, unknown> = {}, signal?: AbortSignal) =>
    nativeBrowserCommand<T>(id, action, { ...data, clientId }, signal), [clientId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [failedNativeBinding, setFailedNativeBinding] = useState<string | null>(null);
  const [shot, setShot] = useState<BrowserShot | null>(null);
  const [url, setUrl] = useState('');
  const [textInput, setTextInput] = useState('');
  const [newProfileName, setNewProfileName] = useState('');
  const [creating, setCreating] = useState(false);
  const [area, setArea] = useState({ x: 0, y: 0, width: 0, height: 0 });
  const surface = useRef<HTMLDivElement>(null);
  const measureSurface = useCallback(() => {
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return null;
    const next = browserPanelBounds(rect, { width: window.innerWidth, height: window.innerHeight });
    setArea((old) => JSON.stringify(old) === JSON.stringify(next) ? old : next);
    return next;
  }, []);
  const video = useRef<HTMLVideoElement>(null);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const [screenshotMode, setScreenshotMode] = useState(false);
  const [mediaRevision, setMediaRevision] = useState(0);
  const [dragTouch, setDragTouch] = useState(false);
  const [drawer, setDrawer] = useState<'options' | 'credentials' | 'chromeSignin' | 'downloads' | 'clipboard' | PluginDrawer | null>(null);
  const pluginDrawer = drawer?.startsWith(PLUGIN_DRAWER_PREFIX) ? drawer.slice(PLUGIN_DRAWER_PREFIX.length) : null;
  // A plugin unloaded with its drawer open would leave the view detached over an empty dialog.
  const pluginDrawerEntry = useSlotEntry(BROWSER_DRAWER_SLOT, pluginDrawer ?? '');
  useEffect(() => { if (pluginDrawer && !pluginDrawerEntry) setDrawer(null); }, [pluginDrawer, pluginDrawerEntry]);
  const [clipboardText, setClipboardText] = useState('');
  const [clipboardWaiting, setClipboardWaiting] = useState(false);
  const [clipboardNotice, setClipboardNotice] = useState<string | null>(null);
  // A notice is a passing remark: it fades from the page, and is dropped with the drawer that showed it.
  useEffect(() => {
    if (!clipboardNotice || drawer) return;
    const timer = setTimeout(() => setClipboardNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [clipboardNotice, drawer]);
  useEffect(() => {
    if (drawer !== 'clipboard') return;
    return () => setClipboardNotice(null);
  }, [drawer]);
  const optionsTrigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!drawer) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { setDrawer(null); optionsTrigger.current?.focus(); } };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [drawer]);
  const nativeViewQueue = useRef(Promise.resolve());
  const hostAudioProfile = useRef<string | null>(null);
  /** Attaches the presented view again, with the conversation of the moment; null while none is presented. */
  const reattach = useRef<(() => Promise<unknown>) | null>(null);
  const queueNativeView = useCallback((operation: () => Promise<unknown>) => {
    const next = nativeViewQueue.current.catch(() => {}).then(async () => { await operation(); });
    nativeViewQueue.current = next;
    return next;
  }, []);
  const muteOwnedHostAudio = useCallback((profileId: string) => queueNativeView(async () => {
    if (hostAudioProfile.current !== profileId) return;
    hostAudioProfile.current = null;
    await browserCommand(profileId, 'audio', { muted: true });
  }), [browserCommand, queueNativeView]);
  const commandEpoch = useRef(0);
  const controlled = status?.control?.holder === 'you';
  // A remote daemon owns different tabs, even if its profile ids match the local ones.
  const electron = !!desktopBridge()?.browser && activeMachineId() === LOCAL_MACHINE_ID && failedNativeBinding !== bindingKey;
  const mobileViewport = display === 'mobile' || (display === 'auto' && narrow && !electron);
  const viewport = display === 'desktop' ? DESKTOP_RES : { width: Math.min(display === 'mobile' ? 430 : 3840, Math.max(240, area.width)), height: Math.min(2160, Math.max(240, area.height)) };
  // The native view is painted above the DOM: no drop layer can cover it. While
  // an island drag or a window move runs it takes the modal path — view
  // detached, last capture shown — and comes back at the end of the gesture
  // (docs/ISLAND-WORKSPACE.md §9, §12). Same for a dialog, a sheet or a menu the
  // app opens above it (TIM-0130). On the web the stream is DOM, which the
  // layer covers: nothing to do there.
  const islandDragging = useIslandGesture();
  const appCovered = useNativeViewsCovered();
  const modal = !!drawer || !!status?.dialog || !!status?.fileChooser || !!status?.permissions?.length || !!status?.contextMenu
    || (electron && (islandDragging || appCovered));
  const overlay = controlled && !modal && electron && display !== 'desktop' && viewport.width === area.width && viewport.height === area.height;
  const mediaEnabled = visible && !!status?.running && !overlay && !screenshotMode && !modal;
  const mediaAllowed = useRef(mediaEnabled);
  mediaAllowed.current = mediaEnabled;
  const currentProfileId = useRef<string | null>(null);
  currentProfileId.current = profile?.id ?? null;
  const currentBindingKey = useRef(bindingKey);
  currentBindingKey.current = bindingKey;
  const execute = useCallback<BrowserCommand>(async <T,>(action: string, data: Record<string, unknown> = {}): Promise<T> => {
    if (!profile || currentProfileId.current !== profile.id || currentBindingKey.current !== bindingKey) throw new Error('Browser profile changed.');
    return browserCommand<T>(profile.id, action, data);
  }, [profile, bindingKey, browserCommand]);
  // Cleanup must remain able to close its former media session after the visible binding changes.
  const mediaCommand = useCallback<BrowserCommand>(async <T,>(action: string, data: Record<string, unknown> = {}): Promise<T> => {
    if (!profile) throw new Error('Browser profile unavailable.');
    // Finish detaching and silencing this view before audio starts in the remote player.
    if (action === 'mediaOffer' || action === 'mediaStart') {
      await nativeViewQueue.current.catch(() => {});
      if (!mediaAllowed.current) throw new DOMException('Browser presentation paused', 'AbortError');
    }
    return browserCommand<T>(profile.id, action, data);
  }, [profile, browserCommand]);
  const viewportRevision = `${mediaRevision}:${status?.width}:${status?.height}:${status?.mobile}`;
  const media = useBrowserMedia(video, mediaEnabled, profile?.id ?? null, status?.activeTabId ?? null, audioEnabled, mediaCommand, viewportRevision);
  const queuedInput = useMemo(() => browserInputQueue((event) => execute('input', { event }), (err) => setError((err as Error).message)), [execute]);
  useEffect(() => () => queuedInput.cancel(), [queuedInput]);

  useEffect(() => {
    const resize = () => setNarrow(window.innerWidth < 768 || window.matchMedia('(pointer: coarse)').matches);
    resize(); window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  // The binding is resolved by the server. No cwd inference and no fallback to a different profile.
  useEffect(() => {
    if (!visible || !available || !workspace.owner) return;
    const controller = new AbortController();
    setLoadedBinding(bindingKey);
    setFailedNativeBinding(null);
    setBusy(true); setError(null); setProfile(null); setStatus(null); setShot(null); setTextInput(''); setCreating(false); setDrawer(null); setClipboardText(''); setClipboardNotice(null); setClipboardWaiting(false); setScreenshotMode(false);
    const query = new URLSearchParams({ agent });
    if (mission) query.set('mission', mission);
    if (workspace.project) query.set('project', workspace.project);
    void (async () => {
      const [resolved, catalogue] = await Promise.all([
        nativeBrowserRequest<{ profile: BrowserProfile | null }>(`resolve?${query}`, undefined, controller.signal),
        nativeBrowserRequest<{ profiles: BrowserProfile[] }>('profiles', undefined, controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setProfiles(catalogue.profiles); setProfile(resolved.profile);
      if (resolved.profile) {
        const result = await browserCommand<NativeBrowserStatus>(resolved.profile.id, 'start', {}, controller.signal);
        if (!controller.signal.aborted) setStatus(result);
      }
    })().catch((err) => { if (!controller.signal.aborted) setError((err as Error).message); })
      .finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [visible, available, workspace.owner, workspace.project, agent, mission, bindingKey, revision, browserCommand]);

  // The window paints its content a tick after its first render: the surface
  // is observed once it exists, and re-measured when the window moves, which
  // a ResizeObserver does not see.
  const [placed, setPlaced] = useState(false);
  useEffect(() => { if (placement) { setPlaced(true); measureSurface(); } }, [placement, measureSurface]);
  useEffect(() => {
    if (!visible || !surface.current) return;
    measureSurface();
    const observer = new ResizeObserver(measureSurface); observer.observe(surface.current);
    window.addEventListener('resize', measureSurface);
    return () => { observer.disconnect(); window.removeEventListener('resize', measureSurface); };
  }, [visible, placed, busy, profile?.id, measureSurface]);
  // Cheap: `measureSurface` only sets a new area when the rectangle changed.
  useEffect(() => {
    if (!visible || !trackPosition) return;
    const timer = setInterval(measureSurface, 400);
    return () => clearInterval(timer);
  }, [visible, trackPosition, measureSurface]);

  useEffect(() => {
    if (!visible || !profile || !status?.running || !controlled || modal || !area.width || !area.height) return;
    let cancelled = false;
    let refresh: ReturnType<typeof setInterval> | undefined;
    const bridge = desktopBridge()?.browser;
    const stillMeasured = () => !cancelled && JSON.stringify(measureSurface()) === JSON.stringify(area);
    const attach = async () => {
      if (!overlay || !bridge || !stillMeasured()) return;
      const result = await browserCommand<{ viewToken: string }>(profile.id, 'presentation');
      // The desktop's annotation bubble posts to this conversation, in the app's language and scheme (TODO #481).
      const scheme = document.documentElement.classList.contains('dark') ? 'dark' : 'light';
      if (!stillMeasured()) return;
      try {
        const shown = await bridge.attach({ profileId: profile.id, viewToken: result.viewToken, bounds: area, conversation: conversationRef.current, locale: getLocale(), scheme });
        if (shown && typeof shown === 'object' && 'attached' in shown && shown.attached === false && stillMeasured()) setFailedNativeBinding(bindingKey);
      } catch {
        // An older shell only presents in its first window. Keep this profile's authenticated
        // video/input path, including its own errors, rather than leaving a blank native surface.
        if (stillMeasured()) setFailedNativeBinding(bindingKey);
      }
    };
    reattach.current = () => queueNativeView(attach);
    // Serialize resize as well as attach: an older HTTP resize must never overwrite a newer view.
    void queueNativeView(async () => {
      if (!stillMeasured()) return;
      await browserCommand(profile.id, 'resize', { ...viewport, mobile: mobileViewport });
      await attach();
    }).then(() => { if (!cancelled && overlay) refresh = setInterval(() => { void queueNativeView(attach).catch((err) => { if (stillMeasured()) setError((err as Error).message); }); }, 25_000); })
      .catch((err) => { if (stillMeasured()) setError((err as Error).message); });
    return () => { cancelled = true; reattach.current = null; if (refresh) clearInterval(refresh); if (overlay && bridge) void queueNativeView(() => bridge.detach()).catch(() => {}); };
  }, [visible, profile?.id, status?.running, controlled, modal, area.x, area.y, area.width, area.height, overlay, mobileViewport, viewport.width, viewport.height, browserCommand, queueNativeView, measureSurface, bindingKey]);
  // The chat moved to another conversation: the desktop's bubble hears it without the view being detached.
  const conversationKey = `${conversation.agent}|${conversation.mission ?? ''}|${'fresh' in conversation ? 'fresh' : ''}`;
  useEffect(() => { void reattach.current?.().catch(() => {}); }, [conversationKey]);
  // A desktop window keeps a page per machine (V4): hidden, this page lost the panel; back on screen, it shows it again at once.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') void reattach.current?.().catch(() => {}); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!visible || !profile || !overlay || !audioEnabled) return;
    let cancelled = false;
    void queueNativeView(async () => {
      if (cancelled) return;
      hostAudioProfile.current = profile.id;
      await browserCommand(profile.id, 'audio', { muted: false });
    }).catch((err) => { if (!cancelled) setError((err as Error).message); });
    // Only undo host audio explicitly enabled by this panel. Remote playback is local.
    return () => { cancelled = true; void muteOwnedHostAudio(profile.id).catch(() => {}); };
  }, [visible, profile?.id, overlay, audioEnabled, browserCommand, queueNativeView, muteOwnedHostAudio]);

  useEffect(() => {
    if (!visible || !profile || !status?.running) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const epoch = commandEpoch.current;
      try {
        const nextStatus = await browserCommand<NativeBrowserStatus>(profile.id, 'status', {}, controller.signal);
        if (controller.signal.aborted) return;
        if (epoch === commandEpoch.current) setStatus(nextStatus);
        if (nextStatus.running && !overlay && screenshotMode && !modal && !nextStatus.dialog && !nextStatus.fileChooser && !nextStatus.permissions?.length && !nextStatus.contextMenu) {
          const nextShot = await browserCommand<BrowserShot>(profile.id, 'screenshot', {}, controller.signal);
          if (!controller.signal.aborted && epoch === commandEpoch.current) setShot(nextShot);
        }
        timer = setTimeout(() => void poll(), screenshotMode && !overlay ? 450 : 1000);
      } catch (err) { if (!controller.signal.aborted) { setError((err as Error).message); timer = setTimeout(() => void poll(), 1500); } }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [visible, profile?.id, status?.running, overlay, screenshotMode, modal, browserCommand]);

  useEffect(() => {
    if (!visible || !profile || !controlled) return;
    return () => { void queueNativeView(() => browserCommand(profile.id, 'releaseControl')).catch(() => {}); };
  }, [visible, profile?.id, controlled, browserCommand, queueNativeView]);


  const activeTab = status?.tabs.find((tab) => tab.id === status.activeTabId);
  useEffect(() => { setUrl(activeTab?.url === 'about:blank' ? '' : activeTab?.url ?? ''); }, [activeTab?.url]);
  // Which site sent a tab, or a popup, to Google: the page Chrome opens on when Google refuses this browser.
  const tabTrail = useRef(EMPTY_TAB_TRAIL);
  useEffect(() => { tabTrail.current = status ? trackBrowserTabs(tabTrail.current, status) : EMPTY_TAB_TRAIL; }, [status]);
  const [signin, setSignin] = useState<{ plan: GoogleSigninPlan | null; reason: ChromeSigninReason }>({ plan: null, reason: 'manual' });
  const [signinNotice, setSigninNotice] = useState<string | null>(null);
  useEffect(() => {
    if (!signinNotice) return;
    const timer = setTimeout(() => setSigninNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [signinNotice]);
  const openChromeSignin = useCallback(() => {
    const page = activeTab && isGoogleAccountsPage(activeTab.url) ? activeTab : null;
    const plan = page ? googleSigninPlan(tabTrail.current, page.id, page.url) : null;
    const reason: ChromeSigninReason = page && isGoogleSigninRejected(page.url) ? plan?.oauth ? 'rejectedSite' : 'rejected' : 'manual';
    setSignin({ plan, reason });
    setDrawer('chromeSignin');
  }, [activeTab]);
  // Google's refusal opens the Chrome detour by itself, once per refused page: closing it is an answer.
  // Only the refusal shows it: a sign-in Google accepts never sees the detour.
  const autoOpened = useRef(new Set<string>());
  const refusedUrl = activeTab && isGoogleSigninRejected(activeTab.url) ? activeTab.url : null;
  useEffect(() => {
    if (!refusedUrl || drawer || !visible || !profile || !status?.running || autoOpened.current.has(refusedUrl)) return;
    autoOpened.current.add(refusedUrl);
    openChromeSignin();
  }, [refusedUrl, drawer, visible, profile, status?.running, openChromeSignin]);

  const command = useCallback(async (action: string, data: Record<string, unknown> = {}) => {
    if (!profile || currentProfileId.current !== profile.id || currentBindingKey.current !== bindingKey) return;
    const id = profile.id;
    const epoch = ++commandEpoch.current;
    try {
      if (action === 'releaseControl' || action === 'stop') await muteOwnedHostAudio(id);
      const result = await browserCommand<NativeBrowserStatus | undefined>(id, action, data);
      if (currentProfileId.current !== id || currentBindingKey.current !== bindingKey || epoch !== commandEpoch.current) return;
      if (result && typeof result.running === 'boolean') setStatus(result);
      else { const next = await browserCommand<NativeBrowserStatus>(id, 'status'); if (currentProfileId.current === id && currentBindingKey.current === bindingKey && epoch === commandEpoch.current) setStatus(next); }
    } catch (err) { if (currentProfileId.current === id && currentBindingKey.current === bindingKey && epoch === commandEpoch.current) setError((err as Error).message); }
  }, [profile, browserCommand, bindingKey, muteOwnedHostAudio]);
  // The sign-in is in this browser now: show the site with it, from the tab that wanted it, without a popup left behind.
  const returnFromSignin = async (result: ChromeSigninStatus) => {
    setDrawer(null);
    setSigninNotice(chromeSigninReport(result));
    const plan = signin.plan;
    const open = new Set(status?.tabs.map((tab) => tab.id) ?? []);
    if (!plan) { await command('reload'); return; }
    const back = plan.returnTabId && open.has(plan.returnTabId) ? plan.returnTabId : null;
    if (back && back !== status?.activeTabId) await command('activateTab', { tabId: back });
    if (plan.closeTabId && plan.closeTabId !== back && open.has(plan.closeTabId)) await command('closeTab', { tabId: plan.closeTabId });
    await command('navigate', { url: plan.returnUrl });
  };
  // No "take control" button: an open panel on a running browser takes the lease by itself.
  // The agent holds none (it drives the same browser alongside the user); only another device
  // of the user's can hold it, and a click or a key in this panel takes it over.
  const holder = status?.control?.holder ?? null;
  const claimWhenFree = shouldAutoClaim({ holder, visible: !!visible, hasProfile: !!profile, running: !!status?.running });
  useEffect(() => { if (claimWhenFree) void command('claimControl'); }, [claimWhenFree, command]);
  const takeOver = () => { if (holder === 'other' && status?.running) void command('claimControl'); };
  const sendInput = useCallback((event: RemoteInput) => { if (controlled) queuedInput.push(event); }, [queuedInput, controlled]);
  const runAction = useCallback<BrowserCommand>(async <T,>(action: string, data: Record<string, unknown> = {}): Promise<T> => {
    const result = await execute<T>(action, data);
    if (action === 'fileUploadBegin' || action === 'fileUploadChunk') return result;
    const next = await execute<NativeBrowserStatus>('status');
    if (currentBindingKey.current === bindingKey) setStatus(next);
    return result;
  }, [execute, bindingKey]);
  const chrome = useMemo<BrowserChrome>(() => ({
    profileId: profile?.id ?? null,
    status,
    controlled,
    conversation,
    command: runAction,
    drawer: pluginDrawer,
    openDrawer: (key: string) => { if (slotEntry(BROWSER_DRAWER_SLOT, key)) setDrawer(`${PLUGIN_DRAWER_PREFIX}${key}`); },
    closeDrawer: () => setDrawer(null),
  }), [profile?.id, status, controlled, conversation, runAction, pluginDrawer]);
  // Control can be lost between the gesture and its handler: say so rather than do nothing.
  const clipboardGuard = () => {
    if (controlled) return true;
    setClipboardNotice(t('browserPanel.native.clipboardNeedsControl'));
    return false;
  };
  const pasteText = async (text: string) => {
    if (!clipboardGuard()) return;
    if (!text) { setClipboardNotice(t('browserPanel.native.clipboardEmpty')); return; }
    try { await execute('clipboardPaste', { text }); }
    catch (err) { setClipboardText(text); setDrawer('clipboard'); setError((err as Error).message); }
  };
  const copySelection = async (cut: boolean) => {
    if (!clipboardGuard()) return;
    try {
      const result = await execute<{ text: string }>('clipboardRead', { cut });
      setClipboardText(result.text);
      try { await navigator.clipboard.writeText(result.text); }
      catch { setClipboardNotice(t('browserPanel.native.copyDenied')); setDrawer('clipboard'); }
    } catch (err) { setClipboardText(''); setDrawer('clipboard'); setError((err as Error).message); }
  };
  // Button and menu only. Ctrl/Cmd+V never lands here: the surface gets the text from the DOM paste event.
  // readText is the first await so the click's user activation is still alive when the browser asks.
  const pasteFromDevice = async () => {
    if (!clipboardGuard()) return;
    setClipboardWaiting(true);
    let text: string;
    try { text = await navigator.clipboard.readText(); }
    catch {
      setClipboardWaiting(false); setClipboardText(''); setClipboardNotice(t('browserPanel.native.pasteDenied')); setDrawer('clipboard');
      return;
    }
    setClipboardWaiting(false);
    await pasteText(text);
  };

  const chooseProfile = async (id: string | null) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/ui/agents/${encodeURIComponent(agent)}/config`, {
        method: 'PATCH', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ browser_profile_id: id }),
      });
      if (!response.ok) { const value = await response.json(); throw new Error(apiErrorMessage(value, { status: response.status })); }
      setRevision((value) => value + 1);
    } catch (err) { setError((err as Error).message); setBusy(false); }
  };
  const createProfile = async () => {
    if (!newProfileName.trim()) return;
    try {
      const result = await nativeBrowserRequest<{ profile: BrowserProfile }>('profiles', { name: newProfileName.trim(), scope_kind: 'custom' });
      setCreating(false); setNewProfileName(''); await chooseProfile(result.profile.id);
    } catch (err) { setError((err as Error).message); }
  };

  // Floating, a strip under the page keeps the resize corner reachable: the native view paints over the DOM.
  return (
    <BrowserChromeProvider value={chrome}>
    <div aria-label={t('browserPanel.aria.embeddedBrowser')} className="flex h-full flex-col" onPointerDownCapture={takeOver} onKeyDownCapture={takeOver}>
    {/* A plugin control that forgot `type="button"` submits this form: it must not navigate. */}
    <form data-browser-chrome="controls" className="flex h-10 shrink-0 items-center gap-0.5 px-1.5" onSubmit={(event) => { event.preventDefault(); if ((event.nativeEvent as SubmitEvent).submitter?.closest('[data-browser-toolbar]')) return; if (url.trim()) void command('navigate', { url: addressBarTarget(url) }); }}>
      <button type="button" className={button} disabled={!status?.running || !controlled} aria-label={t('browserPanel.native.back')} title={t('browserPanel.native.back')} onClick={() => void command('back')}><ArrowLeft className="size-3.5" /></button>
      <button type="button" className={button} disabled={!status?.running || !controlled} aria-label={t('browserPanel.native.forward')} title={t('browserPanel.native.forward')} onClick={() => void command('forward')}><ArrowRight className="size-3.5" /></button>
      <button type="button" className={button} disabled={!status?.running || !controlled} aria-label={t('browserPanel.native.reload')} title={t('browserPanel.native.reload')} onClick={() => void command('reload')}><RotateCw className="size-3.5" /></button>
      <input className={cn(field, 'h-7 flex-1')} disabled={!status?.running || !controlled} value={url} onChange={(event) => setUrl(event.target.value)} aria-label={t('browserPanel.native.address')} placeholder="https://" autoCapitalize="none" autoCorrect="off" spellCheck={false} />
      <BrowserToolbarSlot />
      <button ref={optionsTrigger} type="button" className={cn(button, 'relative flex shrink-0 items-center gap-1', drawer === 'options' && 'bg-muted text-foreground')} aria-label={t('browserPanel.native.options')} title={`${t('browserPanel.native.options')} · ${profile?.name ?? t('browserPanel.native.noAccess')}`} aria-haspopup="dialog" aria-expanded={drawer === 'options'} onClick={() => setDrawer(drawer === 'options' ? null : 'options')}>
        <Settings2 className="size-4" />
        {(error || capabilityError || media.phase === 'error') && <span role="alert" className="absolute -right-0.5 -top-0.5 rounded-full bg-card text-destructive"><AlertTriangle className="size-3" /><span className="sr-only">{error || capabilityError || media.error}</span></span>}
      </button>
    </form>
    <div aria-label={t('browserPanel.native.tabs')} data-browser-chrome="tabs" className="flex h-9 shrink-0 gap-1 overflow-x-auto px-1.5 py-1">
      {status?.tabs.map((tab) => <div key={tab.id} className={cn('flex max-w-40 shrink-0 items-center rounded text-xs', tab.id === status.activeTabId ? 'bg-muted' : 'text-muted-foreground')}><button type="button" className="min-w-0 truncate px-2 py-1" disabled={!controlled} onClick={() => void command('activateTab', { tabId: tab.id })}>{tab.title || tab.url || t('browserPanel.native.newTab')}</button><button type="button" className={button} disabled={!controlled} aria-label={t('browserPanel.native.closeTab')} onClick={() => void command('closeTab', { tabId: tab.id })}><X className="size-3" /></button></div>)}
      <button type="button" className={button} disabled={!status?.running || !controlled} aria-label={t('browserPanel.native.newTab')} onClick={() => { tabTrail.current = noteUserTab(tabTrail.current); void command('newTab'); }}><Plus className="size-3.5" /></button>
    </div>
    {(signinNotice || profile && status?.running && refusedUrl && drawer !== 'chromeSignin') && <div data-browser-chrome="signin" className="flex min-h-8 shrink-0 items-center gap-2 bg-muted px-2.5 py-1 text-xs">
      {signinNotice ? <span role="status" className="min-w-0 flex-1">{signinNotice}</span> : <><LogIn className="size-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1">{t('browserPanel.native.googleSigninBanner')}</span><button type="button" className="shrink-0 rounded px-2 py-0.5 font-medium hover:bg-background disabled:opacity-40" disabled={!controlled} onClick={openChromeSignin}>{t('browserPanel.native.chromeSignin')}</button></>}
    </div>}
    <BrowserRemoteSurface surface={surface} video={video} overlay={overlay} controlled={controlled} blocked={modal || !screenshotMode && media.phase !== 'live'} running={!!status?.running} viewport={status?.width && status?.height ? { width: status.width, height: status.height } : viewport} screenshot={shot} useScreenshot={screenshotMode} dragTouch={dragTouch} sendInput={sendInput} onClipboard={(action) => { if (action.kind === 'paste') void pasteText(action.text); else void copySelection(action.kind === 'cut'); }}>
      {(busy || !available && !capabilityError || !overlay && !screenshotMode && media.phase === 'connecting') && <div className="pointer-events-none absolute inset-0 grid place-items-center text-white/70"><Loader2 className="size-6 animate-spin" /></div>}
      {!busy && available && !profile && !error && <div className="absolute inset-0 grid place-items-center p-8 text-center text-xs text-white/70">{t('browserPanel.native.noAccessHint')}</div>}
      {!busy && profile && status && !status.running && <div className="absolute inset-0 grid place-items-center text-xs text-white/70"><button type="button" className="rounded border border-white/30 px-3 py-2" onClick={() => void command('start')}>{t('browserPanel.native.start')}</button></div>}
      {media.autoplayBlocked && !overlay && !screenshotMode && <button type="button" className="absolute bottom-3 left-3 rounded bg-card px-3 py-2 text-xs" onClick={media.resume}>{t('browserPanel.native.playVideo')}</button>}
      {!drawer && (clipboardWaiting || clipboardNotice) && <div role="status" className="pointer-events-none absolute inset-x-3 top-3 z-10 rounded-lg bg-card px-3 py-2 text-xs shadow-xl">{clipboardWaiting ? t('browserPanel.native.pasteWaiting') : clipboardNotice}</div>}
      {status && <BrowserPrompts status={status} controlled={controlled} command={runAction} />}
      {drawer === 'options' && <div className="absolute inset-0 z-20" onPointerDown={(event) => { if (event.target === event.currentTarget) setDrawer(null); }}>
        <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.options')} className="absolute inset-y-1 right-1 flex w-[calc(100%_-_0.5rem)] max-w-[22rem] flex-col rounded-lg border border-border bg-card shadow-xl">
          <div className="flex shrink-0 items-center gap-2 p-2"><Settings2 className="size-4 text-muted-foreground" /><h2 className="flex-1 text-xs font-medium">{t('browserPanel.native.options')}</h2><button type="button" className={button} aria-label={t('browserPanel.native.close')} onClick={() => { setDrawer(null); optionsTrigger.current?.focus(); }}><X className="size-4" /></button></div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            <div className="space-y-1 rounded border border-border p-2">
              <div className="flex items-end gap-1">
      <label className="min-w-0 flex-1 text-[10px] text-muted-foreground">{mission ? t('browserPanel.native.missionProfile') : t('browserPanel.native.agentProfile', { agent })}
        <select aria-label={t('browserPanel.native.profile')} value={profile?.id ?? '__none__'} disabled={busy || !available || !!mission} className={cn(field, 'mt-0.5 w-full text-foreground')} onChange={(event) => void chooseProfile(event.target.value === '__none__' ? null : event.target.value)}>
          <option value="__none__">{t('browserPanel.native.noAccess')}</option>
          {profile && !profiles.some((value) => value.id === profile.id) && <option value={profile.id}>{profile.name}</option>}
          {profiles.map((value) => <option key={value.id} value={value.id}>{value.name}</option>)}
        </select>
      </label>
      <button type="button" className={button} disabled={!available || !!mission} aria-label={t('browserPanel.native.createProfile')} title={t('browserPanel.native.createProfile')} onClick={() => setCreating(!creating)}><Plus className="size-4" /></button>
              </div>
    {mission && <p className="px-2 py-1 text-[10px] text-muted-foreground">{t('browserPanel.native.frozenProfile')} <a className="underline" href={`/edit?agent=${encodeURIComponent(agent)}`} onClick={(e) => { e.preventDefault(); openAgentEditor({ agent }); }}>{t('browserPanel.native.editAgent')}</a></p>}
    {creating && <form className="flex gap-1 p-1.5" onSubmit={(event) => { event.preventDefault(); void createProfile(); }}><input className={cn(field, 'flex-1')} autoFocus placeholder={t('browserPanel.native.profileName')} aria-label={t('browserPanel.native.profileName')} value={newProfileName} onChange={(event) => setNewProfileName(event.target.value)} /><button type="submit" className={button} disabled={!newProfileName.trim()}>{t('browserPanel.native.create')}</button></form>}

            </div>
            {(error || capabilityError) && <div className="rounded bg-destructive/10 p-2 text-xs text-destructive"><p>{error || capabilityError}</p><button type="button" className={menuButton} onClick={() => { setDrawer(null); if (capabilityError) retryCapability(); else setRevision((value) => value + 1); }}>{t('browserPanel.native.retry')}</button></div>}
            <div className="grid grid-cols-3 gap-1">
              {([{ mode: 'auto', label: 'normal', Icon: AppWindow }, { mode: 'mobile', label: 'mobile', Icon: Smartphone }, { mode: 'desktop', label: 'desktop', Icon: Monitor }] as const).map(({ mode, label, Icon }) => <button key={mode} type="button" className={cn(button, 'flex flex-col items-center gap-1 text-[10px]', display === mode && 'bg-muted text-foreground')} disabled={!controlled} aria-label={t(`browserPanel.native.${label}`)} aria-pressed={display === mode} onClick={() => { onDisplay(mode); setDrawer(null); }}><Icon className="size-4" /><span>{t(`browserPanel.native.${label}`)}</span></button>)}
            </div>
            <div className="rounded bg-muted/30 py-1">
              <button type="button" className={menuButton} disabled={!profile} onClick={() => setDrawer('credentials')}><KeyRound className="size-4" />{t('browserPanel.native.credentials')}</button>
              <button type="button" className={menuButton} disabled={!profile || !status?.running} onClick={openChromeSignin}><LogIn className="size-4" />{t('browserPanel.native.chromeSignin')}</button>
              <button type="button" className={menuButton} disabled={!profile} onClick={() => setDrawer('downloads')}><Download className="size-4" />{t('browserPanel.native.downloads')}</button>
              <button type="button" className={menuButton} aria-pressed={audioEnabled} onClick={() => { setAudioEnabled(!audioEnabled); setDrawer(null); }}>{audioEnabled ? <Volume2 className="size-4" /> : <VolumeX className="size-4" />}{t('browserPanel.native.audio')}</button>
            </div>
            <div className="grid grid-cols-2 gap-1">
              <button type="button" className={menuButton} disabled={!controlled} onClick={() => { setDrawer(null); void copySelection(false); }}><Copy className="size-4 shrink-0" />{t('browserPanel.native.copy')}</button>
              <button type="button" className={menuButton} disabled={!controlled} onClick={() => { setDrawer(null); void pasteFromDevice(); }}><ClipboardPaste className="size-4 shrink-0" />{t('browserPanel.native.paste')}</button>
            </div>
            <button type="button" className={menuButton} disabled={!controlled} aria-pressed={dragTouch} onClick={() => { setDragTouch(!dragTouch); setDrawer(null); }}><MousePointer2 className="size-4" />{t('browserPanel.native.dragTouch')}</button>
            <label className="block text-[10px] text-muted-foreground">{t('browserPanel.native.typeText')}</label>
      <form className="flex gap-1 p-1.5" onSubmit={(event) => { event.preventDefault(); if (textInput) { sendInput({ type: 'text', text: textInput }); setTextInput(''); setDrawer(null); } }}>
      <input value={textInput} onChange={(event) => setTextInput(event.target.value)} disabled={!status?.running || !controlled} className={cn(field, 'flex-1')} aria-label={t('browserPanel.native.typeText')} placeholder={t('browserPanel.native.typeText')} />
      <button type="submit" disabled={!textInput || !status?.running || !controlled} className={button} aria-label={t('browserPanel.native.sendText')}><Send className="size-4" /></button>
      <button type="button" disabled={!status?.running || !controlled} className={cn(button, 'text-xs')} onClick={() => { if (textInput) { sendInput({ type: 'text', text: textInput }); setTextInput(''); setDrawer(null); } sendInput({ type: 'key', key: 'Enter' }); }}>↵</button>
      <button type="button" disabled={!status?.running || !controlled} className={cn(button, 'text-xs')} aria-label="Backspace" onClick={() => sendInput({ type: 'key', key: 'Backspace' })}>⌫</button>
    </form>
            <div className="rounded bg-muted/30 py-1">
              {!controlled && <p className="px-2 py-1 text-[10px] text-muted-foreground">{holder === 'other' ? t('browserPanel.native.otherControl') : t('browserPanel.native.viewer')}</p>}
              <button type="button" className={menuButton} disabled={!profile || busy || !!status?.running && !controlled} onClick={() => { void command(status?.running ? 'stop' : 'start'); setDrawer(null); }}><Power className="size-4" />{status?.running ? t('browserPanel.native.stop') : t('browserPanel.native.start')}</button>
              <p className="px-2 text-[10px] text-muted-foreground">{screenshotMode ? t('browserPanel.native.screenshotMode') : media.phase === 'error' ? media.error : electron && display !== 'desktop' && controlled ? t('browserPanel.native.localView') : media.transport === 'webrtc' ? 'WebRTC' : 'HTTPS'}</p>
              <button type="button" className={menuButton} onClick={() => { setScreenshotMode(false); setMediaRevision((value) => value + 1); setDrawer(null); }}>{t('browserPanel.native.retryVideo')}</button>
              {!screenshotMode && <button type="button" className={menuButton} onClick={() => { setScreenshotMode(true); setDrawer(null); }}>{t('browserPanel.native.useScreenshots')}</button>}
            </div>
          </div>
        </section>
      </div>}
      {drawer === 'credentials' && profile && <BrowserCredentials key={profile.id} profileId={profile.id} url={activeTab?.url ?? ''} controlled={controlled} command={runAction} close={() => setDrawer(null)} />}
      {drawer === 'chromeSignin' && profile && <BrowserChromeSignin key={profile.id} controlled={controlled} command={runAction} close={() => setDrawer(null)} startUrl={signin.plan?.startUrl} reason={signin.reason} onSignedIn={(result) => void returnFromSignin(result)} />}
      {drawer === 'downloads' && profile && <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.downloads')} className="absolute inset-0 z-20 space-y-3 overflow-y-auto bg-card p-3">
        <div className="flex items-center justify-between"><h2 className="text-sm font-medium">{t('browserPanel.native.downloads')}</h2><button type="button" className={button} aria-label={t('browserPanel.native.close')} onClick={() => setDrawer(null)}><X className="size-4" /></button></div>
        {!status?.downloads?.length && <p className="text-xs text-muted-foreground">{t('browserPanel.native.noDownloads')}</p>}
        {status?.downloads?.map((download) => <div key={download.id} className="space-y-1 rounded border border-border p-2 text-xs"><p className="break-all font-medium">{download.name}</p><p className="text-muted-foreground">{download.state} · {Math.round(download.receivedBytes / 1024)} / {Math.round(download.size / 1024)} KiB</p><div className="flex gap-2">
          {download.state === 'completed' && <a className="rounded border border-border px-2 py-1" download href={`/api/ui/native-browser/${encodeURIComponent(profile.id)}/downloads/${encodeURIComponent(download.id)}?clientId=${encodeURIComponent(clientId)}`}>{t('browserPanel.native.downloadToDevice')}</a>}
          {download.state === 'progressing' ? <button type="button" className={button} disabled={!controlled} onClick={() => void command('downloadCancel', { downloadId: download.id })}>{t('browserPanel.native.cancel')}</button> : <button type="button" className={button} disabled={!controlled} onClick={() => void command('downloadDelete', { downloadId: download.id })}>{t('browserPanel.native.delete')}</button>}
        </div></div>)}
      </section>}
      {pluginDrawer && <BrowserDrawerSlot entryKey={pluginDrawer} label={t('browserPanel.native.pluginDrawer')} />}
      {drawer === 'clipboard' && <section role="dialog" aria-modal="true" aria-label={t('browserPanel.native.clipboard')} className="absolute inset-0 z-20 space-y-3 bg-card p-3"><div className="flex justify-between"><h2 className="text-sm font-medium">{t('browserPanel.native.clipboard')}</h2><button type="button" className={button} aria-label={t('browserPanel.native.close')} onClick={() => setDrawer(null)}><X className="size-4" /></button></div>{clipboardNotice && <p role="status" className="text-xs text-destructive">{clipboardNotice}</p>}<p className="text-xs text-muted-foreground">{t('browserPanel.native.clipboardHint')}</p><textarea aria-label={t('browserPanel.native.clipboard')} className="h-40 w-full rounded border border-input bg-background p-2 text-sm" value={clipboardText} onChange={(event) => setClipboardText(event.target.value)} /><button type="button" className="rounded border border-border px-3 py-2 text-xs" disabled={!controlled} onClick={() => { void execute('clipboardPaste', { text: clipboardText }).then(() => setDrawer(null)).catch((err) => setError((err as Error).message)); }}>{t('browserPanel.native.paste')}</button></section>}
      {!drawer && status?.contextMenu && <div role="menu" className="absolute bottom-3 left-3 z-10 flex max-w-[90%] flex-col gap-1 rounded border border-border bg-card p-2 shadow-xl">
        {status.contextMenu.selectionText && <button type="button" role="menuitem" className={button} disabled={!controlled} onClick={() => { void copySelection(false); void command('contextMenuDismiss'); }}>{t('browserPanel.native.copy')}</button>}
        {status.contextMenu.isEditable && <><button type="button" role="menuitem" className={button} disabled={!controlled} onClick={() => { void copySelection(true); void command('contextMenuDismiss'); }}>{t('browserPanel.native.cut')}</button><button type="button" role="menuitem" className={button} disabled={!controlled} onClick={() => { void pasteFromDevice(); void command('contextMenuDismiss'); }}>{t('browserPanel.native.paste')}</button></>}
        {status.contextMenu.linkURL && <button type="button" role="menuitem" className={button} disabled={!controlled} onClick={() => { void command('newTab', { url: status.contextMenu!.linkURL }); void command('contextMenuDismiss'); }}>{t('browserPanel.native.openLink')}</button>}
        <button type="button" role="menuitem" className={button} disabled={!controlled} onClick={() => void command('contextMenuDismiss')}>{t('browserPanel.native.close')}</button>
      </div>}
    </BrowserRemoteSurface>
    </div>
    </BrowserChromeProvider>
  );
}
