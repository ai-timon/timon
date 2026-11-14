/**
 * Timon desktop shell — Electron main process (plan §5.1).
 *
 * The shell locates the daemon, displays its UI, and provides native OS capabilities.
 * Its Chromium provider hosts isolated browser profiles; policy and agent/workflow
 * authorization stay in the daemon. The PWA controls these same sessions through it.
 *
 * Quitting the window does not stop the daemon when it runs as a service. On
 * macOS the shell itself quits when no browser session needs it, so Finder can
 * replace Timon.app during an update. In embedded mode (§5.2) the daemon is our child and dies with us,
 * which is why the window says so.
 */
import { checkWithWindow, verifyReleaseInWorker } from './release-check.js';
import { assignBootstrapPorts } from './bootstrap.js';
import { spawn } from 'node:child_process';
import { accessSync, constants, createReadStream, mkdirSync, realpathSync, existsSync, lstatSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  controlDesktopService, daemonLogHint, forgetMissingWindowsService, forgetServiceStopped, hasDesktopService, repairSessionWitness,
  restartDesktopService, serviceStoppedByUser, startDesktopService, startStoppedServiceFailureMessage, stopServiceCopy, stopServiceFailureMessage,
  windowsRestartSeams, windowsServiceRefusedFile, windowsTaskState,
} from './service.js';
import { app, BrowserWindow, Menu, Tray, WebContentsView, clipboard, dialog, shell, nativeImage, ipcMain, screen, session, systemPreferences } from 'electron';
import { parseWindowSchemeReport, recordMachineScheme, WINDOW_BACKGROUND, WINDOW_SCHEME_CHANNEL, windowScheme, type Scheme } from './appearance.js';
import {
  cascadeFrom, placeSavedWindows, readWindowLayout, routeOfUrl, WindowLayoutKeeper, writeWindowLayout, type DisplayArea, type SavedWindow, type WindowOpening,
} from './window-layout.js';
import {
  isMachineId, LOCAL_MACHINE_ID, machineForNewWindow, machineNameIn, pageUrl, WINDOW_MACHINE_CHANNEL, windowTitle, withMachineHeader,
} from './window-machine.js';
import { WindowRegistry, type PageOf, type WindowRecord } from './window-registry.js';
import { ViewPool, type PooledView } from './view-pool.js';
import {
  canRestartFromSetup, handoverKeptMessage, handoverRoute, relaunchOptions, serviceHandover, serviceHandoverNeeded, setupRestarter, setupRestartPending,
  SETUP_HANDOVER_CHANNEL, SETUP_RESTART_CHANNEL, SETUP_RESTART_STATUS_CHANNEL,
} from './restart.js';
import { queueAppImageRelaunch } from './appimage-restart.js';
import { LEAVE as UNLOAD_LEAVE, unloadPrompt } from './unload-prompt.js';
import { daemonEnvOverrides, loadDesktopConfig, originOf, packagedFirstRun, resolveTimonHome, type DesktopConfig } from './config.js';
import { isTimon, probeHealth, waitForHealth, type HealthResult } from './health.js';
import {
  daemonEntryOf,
  daemonInstallDirOf,
  superviseEmbeddedDaemon,
  terminateProcessTree,
  endEmbeddedLeftovers,
  endFallenDaemonLeftovers,
} from './embedded.js';
import { daemonRuntime, type DaemonRuntime } from './daemon-runtime.js';
import { isTransientLoadError, giveUpMessage } from './window-load.js';
import { waitingUrl } from './waiting-page.js';
import { FIRST_RUN_THEME } from './first-run-theme.js';
import { StartupView, probeUi } from './startup-view.js';
import { requestAppRearm } from './app-rearm.js';
import { reportDesktopOpened } from './telemetry-ping.js';
import { reloadShortcut } from './reload-shortcuts.js';
import { externalUrl, navigationAction } from './external-links.js';
import { keepDictionariesLocal } from './spellcheck.js';
import {
  clearServiceRefused, declineServiceRepair, markServiceRefusedNotice, recordServiceRefused, serviceRefusedMessage, serviceRefusedNoticeDue,
  serviceRepairFailureMessage, serviceRepairPrompt, serviceRepairVerdict,
  serviceUpgradeNeeded, upgradeFailureMessage, upgradeNeedsFallback, upgradePackagedService,
} from './upgrade.js';
import {
  selectDirectory, selectExecutable, selectPluginSource, SELECT_DIRECTORY_CHANNEL, SELECT_EXECUTABLE_CHANNEL, SELECT_PLUGIN_SOURCE_CHANNEL,
} from './directory-picker.js';
import { revealEntry, REVEAL_PATH_CHANNEL } from './reveal-path.js';
import { TailscaleInstaller, TAILSCALE_INSTALLER_CHANNEL, TAILSCALE_OPEN_APP_CHANNEL } from './tailscale-installer.js';
import {
  keepCurrentData, requestRestore, restoreDialog, restoreOffer, restoreOutcome, restorePending,
  markSnapshotWarningShown, snapshotFailure, snapshotFailureDialog, unshownSnapshotWarning,
} from './data-restore.js';
import { quitWhenLastWindowCloses } from './lifecycle.js';
import { loadTrayIcon, trayIconDirOf } from './tray-icon.js';
import { reopenHint } from './reopen-hint.js';
import { startupText } from './startup-text.js';
import { NativeBrowserEngine } from './native-browser.js';
import { sessionAnnotationRoutes } from './native-browser-bubble.js';
import { startRendererDiagnostic } from './renderer-diagnostic.js';
import { NativeBrowserMedia } from './native-browser-media.js';
import { startNativeBrowserServer } from './native-browser-server.js';
import { APP_INFO_CHANNEL, canReadAppInfo } from './app-info.js';
import { machineForDetachedWindow, OPEN_WINDOW_CHANNEL, parseOpenWindowRequest } from './window-open.js';
import { createDesktopSpeech, type DesktopSpeech } from './speech-desktop.js';
import { fetchPluginPack, registerMicrophoneIpc, registerSpeechIpc, SPEECH_CHANNELS } from './speech-ipc.js';
import { installWindowPermissions, microphoneAccess } from './window-permissions.js';
import { installDesktopLog, logDir } from './desktop-log.js';
import { diagnosticCopy, fallbackReport, OPEN_LOGS_CHANNEL, runDiagnosticRunner, saveReport, showProblem, type ProblemBox } from './diagnostic-dialog.js';
import { canUninstall, cleanupCopy, cleanupPlan, uninstallRequest, removalInstructions, UNINSTALL_CHANNEL, UNINSTALL_INFO_CHANNEL, UNINSTALL_HELPER_FLAG } from './uninstall.js';
import { performUninstall, prepareCleanup, stopInstalledService, verifyStopped } from './uninstall-controller.js';
import { runUninstallHelper } from './uninstall-helper.js';
import { BROWSER_ATTACH_CHANNEL, BROWSER_DETACH_CHANNEL, trustedBrowserSender } from './native-browser-protocol.js';

import { DaemonStartTimeoutError, updateOffer, finishUpdate, updateCopy, updateFailureDialog, unmanagedDaemon, type UpdateStage } from './data-update.js';
import { UpdateWindow } from './update-window.js';
import { UpdateDownloader } from './update-download.js';
import { UPDATE_CHANNELS, UpdateController, localDaemonGet, registerUpdateIpc } from './update-ipc.js';
import { missionsAtStake, readMissionCount, removeAppImageBackup } from './update-install.js';
import { aboutCopy, readThirdPartyNotices, registerAboutIpc, thirdPartyNoticesPath } from './about.js';
import { showAboutWindow } from './about-window.js';
import { appMenuTemplate, newWindowCopy, newWindowShortcut } from './app-menu.js';
import { launchedOtherBuild, shellBuild, staleShellCopy, type LaunchData } from './shell-build.js';
import { shellLocalesDir, shellText, useShellLocales } from './shell-i18n.js';
import { LOCALE_COOKIE, ShellLocale } from './shell-locale.js';
import { devShellName } from './linux-desktop.js';
import { WINDOWS_APP_USER_MODEL_ID, windowsUserTasks } from './jump-list.js';
import { ErrorBoxGate, quitAfterBox, type ShutdownWindow } from './shutdown-sequence.js';

const DISPLAY_NAME = 'Timon';
// Before any word is shown: a package reads its languages from `resources/locales`.
useShellLocales(shellLocalesDir({
  packaged: app.isPackaged,
  resourcesPath: process.resourcesPath,
  desktopRoot: fileURLToPath(new URL('..', import.meta.url)),
}));
const APP_ICON_PATH = app.isPackaged
  ? join(process.resourcesPath, 'app', 'public', 'icon-512.png')
  : fileURLToPath(new URL('../../app/public/icon-512.png', import.meta.url));

/**
 * How long a daemon gets to answer before we stop waiting. A packaged daemon
 * verifies its release, then loads its plugins and asks each provider whether
 * it is signed in, before it listens: on a managed Windows PC (antivirus,
 * Entra profile) that took two and a half minutes, and a 30 s wait ended on
 * "does not answer" while the daemon was fine (21/10/2026). The embedded
 * child gets less: its supervisor reports a crash loop on its own.
 */
const EMBEDDED_BOOT_BUDGET_MS = 90_000;
const SERVICE_BOOT_BUDGET_MS = 180_000;
/** The service replacing the embedded daemon at the end of a first setup: its database is already migrated. */
const HANDOVER_BUDGET_MS = 90_000;

let updateWindow: UpdateWindow | null = null;
let updateApproved = false;
/** What the failure dialog of an approved update may claim happened. */
let updateStage: UpdateStage = 'none';
let desktopHome = '';
/**
 * A packaged install without `timon.config.json`: the onboarding comes next.
 * The windows then wait in its look rather than with the startup diagnostic.
 */
let firstRun = false;
/** The window's colour before its page paints: the onboarding's on a first launch. */
const windowBackground = (scheme: Scheme): string => (firstRun ? FIRST_RUN_THEME[scheme].background : WINDOW_BACKGROUND[scheme]);
/**
 * One page of a window (multi-window V4): the interface of one machine, in a
 * view of its own, with the waiting page in front of it while Timon boots.
 */
interface MachinePage {
  readonly view: WebContentsView;
  readonly startup: StartupView;
  /** Set once the shell asked the page to close: settles when it went, or the user kept it. */
  closed: Promise<'closed' | 'kept'> | null;
  settle: ((outcome: 'closed' | 'kept') => void) | null;
  /** The page it shows, as the layout keeps it (`routeOfUrl`); its waiting page leaves the last one. */
  route: string | null;
}
type Page = PooledView<MachinePage>;
/**
 * The interface windows (multi-window V3), oldest first. Each keeps a page
 * per machine visited, the three shown last alive (V4); every request of a
 * page names its machine through the `X-Timon-Machine` header the main
 * process writes. Each window may present its own native browser panel.
 */
type AppWindow = WindowRecord<BrowserWindow, MachinePage>;
/** A page and its window: who an IPC call comes from. */
type Caller = PageOf<BrowserWindow, MachinePage>;
const windows = new WindowRegistry<BrowserWindow, MachinePage>();
/** Window id → presenting page id: only that page takes its panel down. */
const browserOwners = new Map<number, number>();
/** A quit went ahead: a window that closed its pages first resumes it (its own close had stopped it). */
let quitInProgress = false;
/** Where the windows were, and on which machine: saved as they move, restored at launch. */
let layoutKeeper: WindowLayoutKeeper | null = null;
/** The interface every window loads, once `main` knows it: what "New window" opens. */
let interfaceUrl = '';
/** Local dictation (TODO #443), built on its first IPC call. */
let speech: DesktopSpeech | null = null;
/** The OS gate in front of the microphone (macOS prompt, Windows privacy switch). */
const microphone = microphoneAccess(process.platform, systemPreferences);
let tray: Tray | null = null;
let daemonUp = false;
let stopEmbedded: (() => Promise<void>) | null = null;
/** Where the embedded daemon listens, while it runs: the service taking its place must answer there. */
let embeddedDaemonOrigin: string | null = null;
/**
 * The origin of the interface, kept after the last window closes: the service
 * worker's notifications are checked against it with no window open.
 */
let windowOrigin = '';
// The app's language (cookie), else the OS's; read once the app is ready (`initShellLocale`).
let shellLocale: ShellLocale | null = null;
// What the tray was last built with: a language change rebuilds it as it stands.
let trayState: { cfg: DesktopConfig; uiUrl: string } | null = null;
let uninstalling = false;
let uninstallReadyToQuit = false;
let nativeBrowser: NativeBrowserEngine | null = null;
let browserMedia: NativeBrowserMedia | null = null;
let stopBrowserProvider: (() => Promise<void>) | null = null;
/** Until the installed release is verified, no other window opens (TODO #439). */
let releasePending = false;
let releaseCheckWindow: BrowserWindow | null = null;
/** The check window was closed by us as the only window: the next `window-all-closed` is not a quit (macOS). */
let releaseCheckWindowRetired = false;
/** No window destroyed and no quit while an error box is open (TODO #478). */
const errorBoxes = new ErrorBoxGate((line) => console.log(line), () => app.quit());
/** A box-then-quit sequence owns the shutdown: closing its windows must not quit on its own. */
let quittingAfterProblem = false;

/** The interface windows still alive, oldest first. */
function liveWindows(): AppWindow[] {
  return windows.list().filter((record) => !record.window.isDestroyed());
}

/** The window in front if it is an interface window, else the primary one. */
function frontWindow(): AppWindow | null {
  const focused = BrowserWindow.getFocusedWindow();
  const record = focused ? windows.find(focused) : null;
  if (record && !record.window.isDestroyed()) return record;
  return liveWindows()[0] ?? null;
}

/** The window an error box belongs to: the one on screen, if any (TODO #478). */
function problemParent(): BrowserWindow | null {
  for (const candidate of [updateWindow?.window, frontWindow()?.window, ...liveWindows().map((r) => r.window), releaseCheckWindow]) {
    if (candidate && !candidate.isDestroyed() && candidate.isVisible()) return candidate;
  }
  return null;
}

function closedEvent(w: BrowserWindow): Promise<void> {
  return new Promise((resolveClosed) => { w.once('closed', () => resolveClosed()); });
}

/** What a box-then-quit sequence closes, in order, after the box. */
function shutdownWindows(): ShutdownWindow[] {
  const list: ShutdownWindow[] = [];
  const update = updateWindow;
  if (update) {
    list.push({
      label: 'update window', alive: () => !update.window.isDestroyed(), closed: () => closedEvent(update.window),
      // Cleared first: `before-quit` holds the quit while an approved update window exists.
      close: () => { if (updateWindow === update) updateWindow = null; update.close(); },
    });
  }
  for (const { window: shown } of liveWindows()) {
    list.push({ label: 'main window', alive: () => !shown.isDestroyed(), closed: () => closedEvent(shown), close: () => shown.close() });
  }
  return list;
}

/** Box, then windows, then quit (TODO #478): the order the Linux crash after "Startup failed" lacked. */
function reportProblemThenQuit(box: Omit<ProblemBox, 'title'>): Promise<void> {
  quittingAfterProblem = true;
  return quitAfterBox({ box: () => reportProblem(box), windows: shutdownWindows, quit: () => app.quit(), log: (line) => console.log(line) });
}

/**
 * Every error box of the app carries the support report (TODO #343): copy it,
 * save it, open the logs folder. Resolves when the user closes the box, so a
 * caller that quits afterwards keeps the clipboard alive until then (Linux).
 */
async function reportProblem(box: Omit<ProblemBox, 'title'>, parent: BrowserWindow | null = problemParent()): Promise<void> {
  const error = `${box.message}\n${box.detail}`;
  const report = async () => {
    try {
      const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
      const { env, execPath } = runnerSeams(cfg);
      return await runDiagnosticRunner({ execPath, resourcesPath: process.resourcesPath, env, error });
    } catch (e) {
      console.log(`[desktop] diagnostic runner unavailable: ${(e as Error).message}`);
      return fallbackReport({ home: desktopHome, appVersion: app.getVersion(), platform: process.platform, error, why: (e as Error).message });
    }
  };
  console.log(`[desktop] error box parent: ${parent ? `window "${parent.getTitle()}"` : 'none'}`);
  try {
    await errorBoxes.hold(() => showProblem({
      show: (options) => parent && !parent.isDestroyed() ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options),
      report,
      writeClipboard: (text) => clipboard.writeText(text),
      save: (text) => saveReport(desktopHome, text),
      showInFolder: (path) => shell.showItemInFolder(path),
      openLogs: async () => {
        const dir = logDir(desktopHome);
        mkdirSync(dir, { recursive: true });
        return shell.openPath(dir);
      },
      log: (line) => console.log(line),
      copy: diagnosticCopy(uiLocale(), process.platform),
    }, { title: DISPLAY_NAME, ...box }));
  } catch (e) {
    console.error('[desktop] could not show the error box', e);
  }
}

/** The displays as the layout reads them, the primary one first. */
function displayAreas(): DisplayArea[] {
  const primary = screen.getPrimaryDisplay();
  return [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)]
    .map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));
}

/** What the layout remembers of one window. */
function savedWindow(record: AppWindow): SavedWindow {
  const w = record.window;
  const bounds = w.getNormalBounds();
  return {
    bounds, maximized: w.isMaximized(), fullScreen: w.isFullScreen(),
    displayId: screen.getDisplayMatching(bounds).id, machineId: record.machineId, route: record.route,
  };
}

/**
 * The window title names the machine the window drives ("Office VPS — Timon").
 * The name comes from the local fleet list, read with the window's own session;
 * a window without a machine of its own follows the `timon_machine` cookie.
 */
async function refreshTitle(record: AppWindow): Promise<void> {
  const w = record.window;
  const pinned = record.machineId;
  try {
    let id = pinned;
    if (id === null) {
      const [cookie] = await w.webContents.session.cookies.get({ url: record.origin, name: 'timon_machine' });
      let value: string | null = null;
      try { value = cookie ? decodeURIComponent(cookie.value) : null; } catch { /* malformed: served as local */ }
      id = isMachineId(value) ? value : LOCAL_MACHINE_ID;
    }
    let name: string | null = hostname() || null;
    if (id !== LOCAL_MACHINE_ID) {
      const res = await w.webContents.session.fetch(`${record.origin}/api/ui/machines`, {
        credentials: 'include', cache: 'no-store', signal: AbortSignal.timeout(5_000),
      });
      name = res.ok ? machineNameIn(await res.json().catch(() => null), id) : null;
    }
    // The window may have closed, or moved to another machine, meanwhile.
    if (!w.isDestroyed() && record.machineId === pinned) w.setTitle(windowTitle(DISPLAY_NAME, name));
  } catch (error) {
    console.log(`[desktop] window title: machine name unavailable (${(error as Error).message})`);
  }
}

/** The webContents of a page. */
function contentsOf(page: Page): Electron.WebContents { return page.view.view.webContents; }

/** The page on screen in a window, with its window. */
function activeCaller(record: AppWindow | null): Caller | null {
  const page = record?.pages.active ?? null;
  return record && page && !record.window.isDestroyed() && !contentsOf(page).isDestroyed() ? { record, page } : null;
}

/** `caller` while its window and page are still there. */
function liveCaller(caller: Caller | null): Caller | null {
  return caller && !caller.record.window.isDestroyed() && !contentsOf(caller.page).isDestroyed() ? caller : null;
}

function detachBrowser(contentsId: number): void {
  for (const [windowId, owner] of browserOwners) {
    if (owner !== contentsId) continue;
    const record = windows.get(windowId);
    if (record) nativeBrowser?.detachWindow(record.window);
    browserOwners.delete(windowId);
  }
}

let displaysWatched = false;

/** A display that changes scale or work area may resize a window's content without a resize event on every OS. */
function watchDisplays(): void {
  if (displaysWatched) return;
  displaysWatched = true;
  screen.on('display-metrics-changed', () => { for (const record of liveWindows()) layoutPages(record); });
}

/** Every page of a window covers its whole content area; Electron sizes views in DIPs, so a change of display density needs nothing more. */
function layoutPages(record: AppWindow): void {
  if (record.window.isDestroyed()) return;
  const [width = 0, height = 0] = record.window.getContentSize();
  for (const page of record.pages.list()) page.view.view.setBounds({ x: 0, y: 0, width, height });
}

/**
 * A page went to `target`: the page its window reopens on (TODO #760), if it
 * is on screen. The waiting page, sign-in or another origin leave the last one.
 */
function noteRoute(record: AppWindow, page: Page, target: string): void {
  const route = routeOfUrl(target, record.origin);
  if (route === null || route === page.view.route) return;
  page.view.route = route;
  if (!record.pages.isActive(page.contentsId)) return;
  record.route = route;
  layoutKeeper?.changed();
}

function showPage(record: AppWindow, page: Page): void {
  record.route = page.view.route;
  layoutPages(record);
  page.view.view.setVisible(true);
  if (record.window.isFocused()) contentsOf(page).focus();
}

/** Hidden, alive: its scroll, drafts and panels are there when it comes back. The native panel it presented leaves with it. */
function hidePage(page: Page): void {
  detachBrowser(page.contentsId);
  page.view.view.setVisible(false);
}

function settlePage(page: Page, outcome: 'closed' | 'kept'): void {
  const settle = page.view.settle;
  page.view.settle = null;
  page.view.closed = null;
  settle?.(outcome);
}

/**
 * Asks a page to go, through its own `beforeunload`: a document with unsaved
 * changes asks first (TIM-0128). Settles `kept` when the user stays.
 */
function closePage(page: Page): Promise<'closed' | 'kept'> {
  if (page.view.closed) return page.view.closed;
  const contents = contentsOf(page);
  if (contents.isDestroyed()) return Promise.resolve('closed');
  page.view.closed = new Promise((resolveClose) => { page.view.settle = resolveClose; });
  const closed = page.view.closed;
  contents.close({ waitForBeforeUnload: true });
  return closed;
}

/**
 * Builds the page of `machineId` in `record`, hidden, under everything else
 * the window shows (the native browser panel and its bubble stay on top).
 * Every guard of the interface is set on it: no page of a window goes without
 * its navigation guards.
 */
function createPage(record: AppWindow, machineId: string | null, url: string): Page {
  const w = record.window;
  // The machine's own mode: a page of another machine must not flash this computer's.
  const scheme = windowScheme(desktopHome, machineId);
  const view = new WebContentsView({
    webPreferences: {
      // Narrow native capabilities; the web app still has no Node access.
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  view.setBackgroundColor(windowBackground(scheme));
  view.setVisible(false);
  const contents = view.webContents;
  const id = contents.id;
  // The web app is a child of the daemon and binds its port seconds later (see
  // `window-load.ts`): the page shows a waiting page and only loads the
  // interface once it answers, instead of sitting on its background colour.
  const startup = new StartupView(contents, url, {
    // The machine's mode as recorded now: the account made during onboarding writes it.
    locale: uiLocale, scheme: () => windowScheme(desktopHome, machineId), firstRun,
    probe: probeUi,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    onGiveUp: () => {
      const locale = uiLocale();
      const t = startupText(locale);
      void reportProblem({
        type: 'warning',
        message: t('startup.uiMissing'),
        detail: t('startup.uiMissingDetail', { giveUp: giveUpMessage(url, locale) }),
      });
    },
  });
  const page: Page = { contentsId: id, machineId, view: { view, startup, closed: null, settle: null, route: routeOfUrl(url, record.origin) } };
  if (process.env.TIMON_RENDERER_DIAGNOSTICS === '1') {
    startRendererDiagnostic(contents.debugger, (line) => console.log(line));
  }
  // No menu bar carries the reload keys: the page handles them itself.
  contents.on('before-input-event', (event, input) => {
    if (newWindowShortcut(input, process.platform)) { event.preventDefault(); openNewWindow(); return; }
    const reload = reloadShortcut(input, process.platform);
    if (!reload) return;
    event.preventDefault();
    if (reload === 'force') contents.reloadIgnoringCache();
    else contents.reload();
  });
  // A document with unsaved changes holds the page (TIM-0128). Electron would
  // refuse the close, the reload or the quit without a word: ask instead.
  // Uninstalling does not ask — the user already chose to leave.
  contents.on('will-prevent-unload', (event) => {
    if (uninstalling || dialog.showMessageBoxSync(w, unloadPrompt(uiLocale(), DISPLAY_NAME)) === UNLOAD_LEAVE) { event.preventDefault(); return; }
    // The user stays: a page the shell was closing is kept.
    record.pages.keep(id);
    settlePage(page, 'kept');
  });
  contents.on('did-finish-load', () => { if (record.pages.isActive(id)) void refreshTitle(record); });
  contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) detachBrowser(id);
  });
  // In-app navigation is `pushState`, hence the in-page event too.
  contents.on('did-navigate', (_event, target) => noteRoute(record, page, target));
  contents.on('did-navigate-in-page', (_event, target, isMainFrame) => { if (isMainFrame) noteRoute(record, page, target); });
  // External links (docs, provider consoles) belong in the real browser.
  contents.setWindowOpenHandler(({ url: target }) => {
    const external = externalUrl(target);
    if (external) void shell.openExternal(external);
    return { action: 'deny' };
  });
  // The same goes for a plain link (no `target=_blank`) or a redirect: the window has no
  // address bar or back button, so leaving the app's origin would strand the user.
  contents.on('will-navigate', (event, target) => {
    const action = navigationAction(target, record.origin);
    if (action.kind === 'allow') return;
    event.preventDefault();
    if (action.kind === 'external') void shell.openExternal(action.url);
  });
  contents.on('will-redirect', (event, target) => {
    if (navigationAction(target, record.origin).kind !== 'allow') event.preventDefault();
  });
  // Backstop for a port that answered the probe and then refused the real load.
  contents.on('did-fail-load', (_event, errorCode, _desc, _url, isMainFrame) => {
    if (isMainFrame && isTransientLoadError(errorCode)) void startup.retry();
  });
  // Everything the shell kept of the page goes with it: its listeners went with its webContents.
  contents.once('destroyed', () => {
    record.pages.forget(id);
    if (!w.isDestroyed()) w.contentView.removeChildView(view);
    detachBrowser(id);
    settlePage(page, 'closed');
    console.log(`[desktop] window ${record.id}: page of machine ${machineId ?? '(cookie)'} closed; ${record.pages.size} alive`);
  });
  w.contentView.addChildView(view, 0);
  return page;
}

/**
 * Puts `machineId` on screen in `record` (V4): its live page, exactly as it
 * was left, or a new one opened on `url`. The page that was on screen stays
 * alive, hidden; the least recently shown beyond the limit closes.
 */
function enterMachine(record: AppWindow, machineId: string | null, url: string, begin: 'service' | 'interface' = 'interface'): Page {
  const step = record.pages.enter(machineId, () => createPage(record, machineId, url));
  // Started once filed: the header must ride the very first load.
  if (step.created) {
    if (begin === 'service') step.entering.view.startup.start();
    else void step.entering.view.startup.begin();
  }
  showPage(record, step.entering);
  if (step.leaving) hidePage(step.leaving);
  if (windows.setMachine(record.id, machineId)) {
    layoutKeeper?.changed();
    void refreshTitle(record);
  }
  for (const evicted of step.evicted) {
    console.log(`[desktop] window ${record.id}: closing the page of machine ${evicted.machineId ?? '(cookie)'}, shown least recently`);
    void closePage(evicted).then((outcome) => {
      if (outcome === 'kept' && !record.closing && !record.window.isDestroyed()) enterMachine(record, evicted.machineId, url);
    });
  }
  return step.entering;
}

/**
 * Closing a window closes its pages first, the one on screen last, each
 * through its own `beforeunload`. A page the user keeps comes in front and
 * the window stays; otherwise the window closes for real, and a quit its
 * close interrupted goes on.
 */
async function closePages(record: AppWindow): Promise<void> {
  if (record.closing) return;
  record.closing = true;
  let kept: Page | null = null;
  try {
    for (const page of record.pages.list()) {
      record.pages.close(page.contentsId);
      if (await closePage(page) === 'kept') { kept = page; break; }
    }
    // Pages already closing (pushed out by the limit) are waited for too.
    for (const page of kept ? [] : record.pages.closingPages()) {
      if (await closePage(page) === 'kept') { kept = page; break; }
    }
  } finally {
    record.closing = false;
  }
  if (record.window.isDestroyed()) {
    if (quitInProgress) app.quit();
    return;
  }
  if (kept) {
    callOffQuit();
    enterMachine(record, kept.machineId, record.origin);
    return;
  }
  record.window.close();
  if (quitInProgress) app.quit();
}

/**
 * A page kept its window open: the quit stops there. Nothing was stopped yet
 * (`windowsHoldQuit`), so only the layout keeper has to follow the windows again.
 */
function callOffQuit(): void {
  if (!quitInProgress) return;
  quitInProgress = false;
  layoutKeeper?.thaw();
  console.log('[desktop] shutdown: called off, a page was kept');
}

/**
 * A quit closes the interface windows before anything else stops (TODO #758):
 * each page is asked about unsaved changes, hidden ones included, and "Stay"
 * must find the embedded daemon and the native browser still running. One
 * window at a time, the front one first, so two boxes never open together;
 * each `closePages` resumes the quit once its window is empty. True while a
 * window still holds pages.
 */
function windowsHoldQuit(): boolean {
  const holding = liveWindows().filter((record) => record.closing || record.pages.size > 0 || record.pages.closingCount > 0);
  if (holding.length === 0) return false;
  if (!holding.some((record) => record.closing)) {
    const front = frontWindow();
    void closePages(holding.find((record) => record === front) ?? holding[0]!);
  }
  return true;
}

function createWindow(url: string, begin: 'service' | 'interface', opening: WindowOpening): AppWindow {
  // A real window exists from now on: a stale marker must not swallow its quit.
  releaseCheckWindowRetired = false;
  const scheme = windowScheme(desktopHome, opening.machineId);
  const place = opening.placement;
  const w = new BrowserWindow({
    width: place.width,
    height: place.height,
    // Left out when absent so the OS centres the window.
    ...(place.x !== undefined && place.y !== undefined ? { x: place.x, y: place.y } : {}),
    title: DISPLAY_NAME,
    icon: APP_ICON_PATH,
    backgroundColor: windowBackground(scheme),
    autoHideMenuBar: true,
    // The window's own webContents stays blank under its pages: no preload, no bridge.
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true },
  });
  if (place.maximized) w.maximize();
  if (place.fullScreen) w.setFullScreen(true);
  // Kept: once the window is closed its webContents can no longer be asked.
  const id = w.webContents.id;
  windowOrigin = new URL(url).origin;
  const record = windows.add({
    id, window: w, origin: windowOrigin, machineId: opening.machineId, pages: new ViewPool<MachinePage>(), closing: false, route: null,
  });
  console.log(`[desktop] window ${id} opened on machine ${record.machineId ?? '(cookie)'}; ${windows.size} open`);
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  w.webContents.on('will-navigate', (event) => event.preventDefault());
  // The pages follow the window's content area: no view resizes on its own.
  const relayout = () => layoutPages(record);
  w.on('resize', () => { relayout(); layoutKeeper?.changed(); });
  w.on('maximize', relayout);
  w.on('unmaximize', relayout);
  w.on('enter-full-screen', relayout);
  w.on('leave-full-screen', relayout);
  w.on('restore', relayout);
  w.on('move', () => layoutKeeper?.changed());
  watchDisplays();
  layoutKeeper?.changed();
  // The window's own webContents, under the pages, takes the keyboard when the window comes back to the front: the page on screen gets it.
  w.on('focus', () => {
    setImmediate(() => {
      const page = record.pages.active;
      if (page && !w.isDestroyed() && w.webContents.isFocused() && !contentsOf(page).isDestroyed()) contentsOf(page).focus();
    });
  });
  // The title is the machine's, not the page's: three windows on three machines must be told apart.
  w.on('page-title-updated', (event) => event.preventDefault());
  w.on('close', (event) => {
    // Its pages go first, each asked about unsaved changes; the window closes once they are gone.
    if (record.pages.size > 0 || record.pages.closingCount > 0) {
      event.preventDefault();
      void closePages(record);
      return;
    }
    layoutKeeper?.closing(savedWindow(record));
    // Return the view to its hidden host before Electron destroys the UI window.
    const owner = browserOwners.get(id);
    if (owner !== undefined) detachBrowser(owner);
  });
  w.on('closed', () => {
    const owner = browserOwners.get(id);
    if (owner !== undefined) detachBrowser(owner);
    windows.remove(id);
    // A view's webContents outlives its window: one still there (a window destroyed outright) is closed, unasked.
    for (const page of record.pages.everyPage()) if (!contentsOf(page).isDestroyed()) contentsOf(page).close();
    layoutKeeper?.save();
    // Hidden browser hosts must not keep an inaccessible shell alive without a tray.
    if (windows.size === 0 && !tray && !uninstalling && !quittingAfterProblem) app.quit();
  });
  enterMachine(record, opening.machineId, url, begin);
  return record;
}

/**
 * Opens the remembered arrangement: every window of the last session, each on
 * its display, its machine and its page, or one window at the default place.
 */
function openLayout(url: string, begin: 'service' | 'interface'): void {
  const layout = layoutKeeper?.current ?? { windows: [], lastMachine: null };
  const openings = placeSavedWindows(layout.windows, displayAreas());
  if (openings.length === 0) {
    openings.push({ placement: cascadeFrom(null, []), machineId: machineForNewWindow(null, layout.lastMachine), route: null });
  }
  console.log(`[desktop] restoring ${openings.length} window(s)`);
  for (const opening of openings) createWindow(opening.route === null ? url : pageUrl(url, { route: opening.route }), begin, opening);
}

function showWindow(url: string): void {
  if (releasePending) { releaseCheckWindow?.show(); releaseCheckWindow?.focus(); return; }
  if (updateWindow) { updateWindow.window.show(); updateWindow.window.focus(); return; }
  const open = liveWindows();
  if (open.length > 0) {
    for (const { pages } of open) {
      for (const { view: { startup } } of pages.list()) {
        if (startup.needsUi() && (daemonUp || startup.state === 'failed')) void startup.begin();
      }
    }
    const front = frontWindow()!.window;
    front.show();
    front.focus();
    return;
  }
  openLayout(url, 'interface');
}

/**
 * "New window" (tray, File menu, Ctrl/Cmd+Shift+N, a second launch): one more
 * window, just below the one in front, on the machine chosen last. Before the
 * first window exists there is nothing to add to: the usual opening runs.
 */
function openNewWindow(machineId: string | null = null): void {
  if (releasePending || updateWindow || !interfaceUrl || liveWindows().length === 0) {
    if (interfaceUrl) showWindow(interfaceUrl);
    return;
  }
  const from = frontWindow()?.window.getNormalBounds() ?? null;
  const record = createWindow(interfaceUrl, daemonUp ? 'interface' : 'service', {
    placement: cascadeFrom(from, displayAreas()),
    machineId: machineForNewWindow(machineId, layoutKeeper?.current.lastMachine ?? null),
  });
  record.window.focus();
}

/**
 * "Open in a new window" (V5): the page of `caller`, at another of its routes,
 * in one more window just below it, on `machineId`. `url` is already checked to
 * be on the caller's origin (`parseOpenWindowRequest`).
 */
function openDetachedWindow(caller: AppWindow, url: string, machineId: string | null): boolean {
  if (releasePending || updateWindow || !interfaceUrl) return false;
  const from = caller.window.isDestroyed() ? null : caller.window.getNormalBounds();
  const record = createWindow(url, daemonUp ? 'interface' : 'service', {
    placement: cascadeFrom(from, displayAreas()),
    machineId,
  });
  record.window.focus();
  return true;
}

/**
 * The daemon answers but its interface does not: its supervisor may have given
 * up on the web app (TODO #485). Waking it runs alongside the startup view's
 * wait rather than before it, so the window never opens later for it.
 */
/** Once the daemon answers, it hears that the app opened (anonymous usage statistics). */
function noteDesktopOpened(cfg: DesktopConfig): void {
  if (!daemonUp) return;
  void reportDesktopOpened(originOf(cfg.daemon.listen), cfg.home, app.getVersion())
    .then((line) => console.log(`[desktop] opening reported → ${line}`))
    .catch(() => { /* never thrown, see telemetry-ping.ts */ });
}

function rearmAppIfDown(cfg: DesktopConfig, uiUrl: string): void {
  void (async () => {
    if (await probeUi(uiUrl)) return;
    console.log(`[desktop] interface not answering; web app rearm → ${await requestAppRearm(originOf(cfg.daemon.listen), cfg.home)}`);
  })().catch((error: unknown) => console.error('[desktop] web app rearm failed', error));
}

/** The daemon will not come up: the waiting pages must stop claiming it is starting. */
function failStartup(): void {
  for (const { pages } of windows.list()) for (const { view: { startup } } of pages.list()) startup.fail();
}

/** Waiting page while the service starts; `showWindow` moves it on once the daemon answers. */
function showStartingWindow(url: string): void {
  if (releasePending || updateWindow || liveWindows().length > 0) return;
  openLayout(url, 'service');
}

function trayImage(): Electron.NativeImage {
  return loadTrayIcon({
    platform: process.platform,
    dir: trayIconDirOf({
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      moduleDir: fileURLToPath(new URL('.', import.meta.url)),
    }),
    appIconPath: APP_ICON_PATH,
    exists: existsSync,
  }, {
    createFromPath: (path) => nativeImage.createFromPath(path),
    warn: (message) => console.warn(message),
  });
}

function buildTray(cfg: DesktopConfig, uiUrl: string): void {
  try {
    tray = new Tray(trayImage());
  } catch (error) {
    tray = null;
    console.warn('[tray] Continuing without a tray icon.', error);
    const t = shellText(uiLocale());
    void dialog.showMessageBox({
      type: 'warning',
      title: DISPLAY_NAME,
      message: t('tray.iconMissing'),
      detail: t('tray.iconMissingDetail'),
    }).catch((error: unknown) => console.warn('[tray] Could not display the icon warning.', error));
    return;
  }
  tray.setToolTip(DISPLAY_NAME);
  refreshTray(cfg, uiUrl);
}

/** "About Timon" (TODO #582): version and the speech-model licences, opened by the tray, the macOS menu bar or Settings › System. */
function openAbout(): void {
  // The menu bar exists before the release is verified, and no other window opens until then (TODO #439).
  if (releasePending) { releaseCheckWindow?.show(); releaseCheckWindow?.focus(); return; }
  showAboutWindow({
    version: app.getVersion(),
    electron: process.versions.electron ?? '',
    notices: readThirdPartyNotices(thirdPartyNoticesPath({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      desktopRoot: fileURLToPath(new URL('..', import.meta.url)),
    })),
    locale: uiLocale(),
    scheme: windowScheme(desktopHome),
    icon: APP_ICON_PATH,
  });
}

/** macOS: "About Timon" in the menu bar leads to the same window (TODO #641). */
function installAppMenu(): void {
  const template = appMenuTemplate({
    platform: process.platform, appName: app.name, locale: uiLocale(), onAbout: openAbout, onNewWindow: () => openNewWindow(),
  });
  if (template) Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  // macOS never sends a second launch to a running app: the Dock menu is where "New window" is looked for.
  if (template) app.dock?.setMenu(Menu.buildFromTemplate([{ label: newWindowCopy(uiLocale()).item, click: () => openNewWindow() }]));
}

/** Windows: "New window" on a right-click of Timon in the taskbar. */
function installJumpList(): void {
  const tasks = windowsUserTasks({ platform: process.platform, packaged: app.isPackaged, execPath: process.execPath, locale: uiLocale() });
  if (tasks && !app.setUserTasks(tasks)) console.warn('[desktop] the taskbar jump list was refused');
}

function refreshTray(cfg: DesktopConfig, uiUrl: string): void {
  trayState = { cfg, uiUrl };
  if (!tray) return;
  const t = shellText(uiLocale());
  const diagnostic = diagnosticCopy(uiLocale(), process.platform);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: t('menu.open', { appName: DISPLAY_NAME }), click: () => showWindow(uiUrl) },
    { label: newWindowCopy(uiLocale()).item, click: () => openNewWindow() },
    { label: t('menu.daemon', { state: daemonUp ? 'running' : 'unreachable', origin: originOf(cfg.daemon.listen) }), enabled: false },
    { label: diagnostic.trayItem, click: () => { void reportProblem({ type: 'info', message: diagnostic.trayMessage, detail: diagnostic.trayDetail }); } },
    { label: aboutCopy(uiLocale()).trayItem, click: openAbout },
    { type: 'separator' },
    // Only when a service owns the daemon: in portable mode "Quit" already
    // takes the daemon along, and there is no service to stop.
    ...(stopEmbedded === null && hasDesktopService(cfg.home)
      ? [{ label: stopServiceCopy(uiLocale()).trayItem, click: () => { void quitAndStopService(cfg); } }]
      : []),
    { label: t('menu.quit'), click: () => app.quit() },
  ]));
}

/** The OS's languages, most preferred first; `getLocale` closes the list on systems that report none. */
function systemLanguages(): string[] {
  return [...app.getPreferredSystemLanguages(), app.getLocale()];
}

/** The language of the shell's words: the app's choice, else the OS's. */
function uiLocale(): string {
  return shellLocale?.current ?? systemLanguages()[0] ?? '';
}

/**
 * Reads the language picked in the app (the `timon-locale` cookie of the
 * windows' session) and follows it: a change rebuilds the menu bar, the
 * Dock menu, the jump list and the tray at once. Windows already open
 * keep their words; the next dialog speaks the new language.
 */
async function initShellLocale(): Promise<void> {
  const locale = new ShellLocale(systemLanguages, () => {
    console.log(`[desktop] shell language: ${locale.current}`);
    installAppMenu();
    installJumpList();
    if (trayState) refreshTray(trayState.cfg, trayState.uiUrl);
  });
  shellLocale = locale;
  const cookies = session.defaultSession.cookies;
  cookies.on('changed', (_event, cookie, cause, removed) => locale.changed(cookie, removed, cause));
  try {
    locale.load(await cookies.get({ name: LOCALE_COOKIE }), windowOrigin ? new URL(windowOrigin).hostname : null);
  } catch (error) {
    console.warn('[desktop] could not read the language cookie', error);
  }
  console.log(`[desktop] shell language: ${locale.current}`);
}

/** The environment the host adapter's runners read: the same home and ports as this shell. */
function runnerSeams(cfg: DesktopConfig) {
  const runtime = shellDaemonRuntime();
  return windowsRestartSeams(cfg, { execPath: runtime.execPath, runtimeEnv: runtime.env, resourcesPath: process.resourcesPath, version: app.getVersion() });
}

/** Who runs the daemon and the runners this shell starts (`daemonRuntime`). */
function shellDaemonRuntime(): DaemonRuntime {
  return daemonRuntime({ packaged: app.isPackaged, resourcesPath: process.resourcesPath, electronExecPath: process.execPath });
}

/**
 * "Quit and stop the background service" (decision of 22/10/2026). Plain
 * Quit leaves the service's daemon running on purpose; this one ends it and
 * what it started, through the host adapter, then quits. The service stays
 * installed: the next launch starts it again (`serviceStoppedByUser`).
 */
async function quitAndStopService(cfg: DesktopConfig): Promise<void> {
  const locale = uiLocale();
  const copy = stopServiceCopy(locale);
  const { response } = await dialog.showMessageBox({
    type: 'question', title: DISPLAY_NAME, message: copy.message, detail: copy.detail,
    buttons: copy.buttons, defaultId: 0, cancelId: 1, noLink: true,
  });
  if (response !== 0) return;
  try {
    const said = await controlDesktopService('stop', runnerSeams(cfg));
    console.log(`[desktop] service stopped by the user: ${said}`);
  } catch (error) {
    console.error('[desktop] service stop failed', error);
    void reportProblem({ type: 'warning', ...stopServiceFailureMessage(error, locale) });
    return;
  }
  app.quit();
}

/**
 * Portable mode (§5.2) — no supervisor declared, so the shell runs the daemon
 * as its own child. Closing the shell stops that child.
 */
async function startEmbeddedDaemon(cfg: DesktopConfig, uiUrl: string): Promise<void> {
  const entry = daemonEntryOf(process.resourcesPath);
  if (!existsSync(entry)) {
    failStartup();
    const t = startupText(uiLocale());
    void reportProblem({
      type: 'error',
      message: t('startup.missing'),
      detail: t('startup.missingDetail', { path: entry, app: DISPLAY_NAME }),
    });
    return;
  }

  // Last-moment lock: between the first probe and here, a service could have
  // come up. Two daemons on one TIMON_HOME write the same database.
  const raced = await probeHealth(originOf(cfg.daemon.listen));
  if (isTimon(raced, cfg.home)) {
    await completeApprovedUpdate(cfg);
    daemonUp = true;
    noteDesktopOpened(cfg);
    showWindow(uiUrl);
    refreshTray(cfg, uiUrl);
    return;
  }
  // Not ours, but the port is taken: spawning here would give a daemon that
  // cannot bind, then five restarts and a crash dialog blaming the daemon.
  if (raced.ok) {
    reportForeignDaemon(cfg);
    return;
  }

  showStartingWindow(uiUrl);
  embeddedDaemonOrigin = originOf(cfg.daemon.listen);
  const daemonOpts = {
    installDir: daemonInstallDirOf(process.resourcesPath),
    overrides: { ...daemonEnvOverrides(cfg), TIMON_DESKTOP_VERSION: app.getVersion() },
    home: cfg.home,
    heapMb: cfg.daemon.heapMb,
    execPath: shellDaemonRuntime().execPath,
    runtimeEnv: shellDaemonRuntime().env,
  };
  stopEmbedded = superviseEmbeddedDaemon({
    entry,
    ...daemonOpts,
    spawn,
    terminate: terminateProcessTree,
    // What the signal or `taskkill /T` on the daemon never reached: mission
    // CLIs it recorded (every OS), and on Windows the terminal host and a
    // mission's browser helper. Left behind, they blocked the next update.
    afterStop: () => endEmbeddedLeftovers(daemonOpts),
    // A crashed daemon's web server would otherwise keep the app port after
    // this shell gives up, and the service installed next waits on it.
    endLeftovers: (pid) => endFallenDaemonLeftovers(pid, daemonInstallDirOf(process.resourcesPath)),
    onGiveUp: (why) => {
      daemonUp = false;
      failStartup();
      refreshTray(cfg, uiUrl);
      const unsaved = snapshotFailure(cfg.home, app.getVersion());
      if (unsaved?.blocking) {
        void reportProblem({ type: 'error', ...snapshotFailureDialog(unsaved, uiLocale()) });
        return;
      }
      const t = startupText(uiLocale());
      void reportProblem({
        type: 'error',
        message: t('startup.crashing'),
        detail: t('startup.crashingDetail', { why, home: cfg.home }),
      });
    },
  });

  const health: HealthResult = await waitForHealth(originOf(cfg.daemon.listen), EMBEDDED_BOOT_BUDGET_MS);
  daemonUp = isTimon(health, cfg.home);
  noteDesktopOpened(cfg);
  console.log(`[desktop] embedded daemon health: ${describeHealth(health, cfg.home)}`);
  refreshTray(cfg, uiUrl);
  if (daemonUp) {
    await completeApprovedUpdate(cfg);
    showWindow(uiUrl);
  } else {
    failStartup();
    const locale = uiLocale();
    const t = startupText(locale);
    void reportProblem({
      type: 'warning',
      message: t('startup.slow'),
      detail: t('startup.slowDetail', {
        origin: originOf(cfg.daemon.listen),
        seconds: EMBEDDED_BOOT_BUDGET_MS / 1000,
        reopen: reopenHint(locale, tray !== null, DISPLAY_NAME, 'moment'),
      }),
    });
  }
}

/**
 * Starts the installed service now, once the embedded daemon has freed its
 * port: its supervisor would retry on its own, but systemd's backoff reaches
 * minutes and a Windows task only every 5. `false` when it cannot start.
 */
async function kickService(cfg: DesktopConfig): Promise<boolean> {
  if (process.platform === 'win32') {
    // `/Run`, never the restart runner: that one asks for elevation, and the
    // launcher already ended with the daemon that could not bind.
    const started = await startDesktopService(cfg.home, false);
    console.log(`[desktop] handover: start the service → ${started}`);
    if (started === 'never-ran') recordServiceRefused(cfg.home);
    return started === 'started';
  }
  try {
    await restartDesktopService(cfg.home);
  } catch (error) {
    // A LaunchDaemon between two lives has no pid to signal: KeepAlive brings it back.
    console.warn(`[desktop] handover: service restart: ${(error as Error).message}`);
  }
  return true;
}

/**
 * Something answers on the daemon's port, and it is not Timon.
 *
 * Any neighbour whose `/api/health` says `{ ok: true }` used to be read as
 * "Timon is up". The window then opened on an app port nobody served: a blank
 * page, no message, and no way for the user to guess why. Naming the port and
 * the fix is the whole point.
 */
function reportForeignDaemon(cfg: DesktopConfig): void {
  failStartup();
  const locale = uiLocale();
  const t = startupText(locale);
  void reportProblem({
    type: 'error',
    message: t('startup.portTaken', { origin: originOf(cfg.daemon.listen) }),
    detail: t('startup.portTakenDetail', {
      app: DISPLAY_NAME,
      config: join(cfg.home, 'timon.config.json'),
      reopen: reopenHint(locale, tray !== null, DISPLAY_NAME),
    }),
  });
}

/** Report a failed supervised start without assuming a globally installed CLI. */
function offerServiceInstall(cfg: DesktopConfig): void {
  failStartup();
  const locale = uiLocale();
  const t = startupText(locale);
  void reportProblem({
    type: 'warning',
    message: t('startup.silent', { app: DISPLAY_NAME }),
    detail: t('startup.silentDetail', {
      origin: originOf(cfg.daemon.listen),
      supervisor: cfg.daemon.supervisor,
      seconds: SERVICE_BOOT_BUDGET_MS / 1000,
      reopen: reopenHint(locale, tray !== null, DISPLAY_NAME, 'minute'),
      logHint: daemonLogHint(locale, cfg.home, hasDesktopService(cfg.home)),
    }),
  });
}

/**
 * Windows: the boot task is gone (an uninstall deleted it, a reinstall did not
 * write it back). Before any daemon starts, so the runner finds the port free;
 * the same runner as an update registers it and removes it again if its
 * daemon never answers. Declined or failed, this session runs portable.
 */
async function offerServiceRepair(cfg: DesktopConfig): Promise<void> {
  const locale = uiLocale();
  const copy = serviceRepairPrompt(locale);
  const { response } = await dialog.showMessageBox({
    type: 'question', title: DISPLAY_NAME, message: copy.message, detail: copy.detail,
    buttons: copy.buttons, defaultId: 0, cancelId: 1,
  });
  if (response !== 0) { declineServiceRepair(cfg.home, app.getVersion()); return; }
  try {
    await upgradePackagedService(cfg, {
      execPath: shellDaemonRuntime().execPath,
      runtimeEnv: shellDaemonRuntime().env,
      resourcesPath: process.resourcesPath,
      version: app.getVersion(),
    });
  } catch (error) {
    console.error('[desktop] service repair failed', error);
    void reportProblem({ type: 'warning', ...serviceRepairFailureMessage(error, cfg.home, locale) });
  }
}

/**
 * Asked before any daemon of this version touches the data: an older version
 * reinstalled over a newer one can put back the copy saved before the update.
 * Returns the id of the restore the user asked for.
 */
async function offerDataRestore(home: string): Promise<string | null> {
  const offer = restoreOffer(home, app.getVersion());
  if (!offer) return null;
  const { response } = await dialog.showMessageBox({
    type: 'question', title: DISPLAY_NAME, noLink: true,
    ...restoreDialog(offer, app.getVersion(), home, uiLocale()),
  });
  if (response === 1) return requestRestore(home, offer, app.getVersion()).id;
  keepCurrentData(home, app.getVersion());
  return null;
}

/**
 * A daemon of this version that was already running (a logon task started it
 * before the window) sees the request and exits so its supervisor restarts it
 * into the restore. Wait for that boot rather than open on the old data.
 */
async function waitForRestoreBoot(cfg: DesktopConfig, id: string): Promise<void> {
  if (!isTimon(await probeHealth(originOf(cfg.daemon.listen)), cfg.home)) return;
  const deadline = Date.now() + EMBEDDED_BOOT_BUDGET_MS;
  while (restorePending(cfg.home, id) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function reportRestore(home: string, id: string): void {
  const outcome = restoreOutcome(home, id);
  if (outcome?.ok) return;
  const t = shellText(uiLocale());
  void reportProblem({
    type: 'warning',
    message: t('restore.notRestored'),
    detail: outcome ? `${t('restore.notRestoredDetail')}\n\n${outcome.error ?? ''}` : t('restore.pending'),
  });
}

async function completeApprovedUpdate(cfg: DesktopConfig): Promise<void> {
  if (!updateApproved || !updateWindow) return;
  await finishUpdate({ home: cfg.home, origin: originOf(cfg.daemon.listen), version: app.getVersion(), locale: uiLocale(),
    progress: (message, progress) => updateWindow?.progress(message, progress),
    approving: () => { updateStage = 'approval'; },
    warning: async (message, detail) => { await dialog.showMessageBox(updateWindow!.window, { type: 'warning', title: DISPLAY_NAME, message, detail }); },
  });
  // Keep a window alive while the main window is constructed (macOS lifecycle).
  const completed = updateWindow;
  updateWindow = null;
  showWindow(originOf(cfg.app.listen));
  // A warning box may still sit on it (a failed service upgrade): GTK must not lose its parent (TODO #478).
  errorBoxes.whenIdle('closing the update window', () => completed.close());
}

/**
 * The release check outlasted its delay: a small local page says what Timon is
 * doing, instead of an app that looks frozen for up to a minute (TODO #439).
 * Returns what retires it.
 */
function showReleaseCheckWindow(): () => void {
  const scheme = windowScheme(desktopHome);
  const check = new BrowserWindow({ width: 480, height: 340, resizable: false, maximizable: false, fullscreenable: false,
    title: DISPLAY_NAME, icon: APP_ICON_PATH, backgroundColor: windowBackground(scheme), autoHideMenuBar: true,
    webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  releaseCheckWindow = check;
  // A local page without script: nothing may open or navigate from it.
  check.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  check.webContents.on('will-navigate', (event) => event.preventDefault());
  let retired = false;
  check.on('closed', () => {
    releaseCheckWindow = null;
    // Nothing else is open yet: closing it is leaving Timon.
    if (!retired) app.quit();
  });
  void check.loadURL(waitingUrl(uiLocale(), scheme, 'verifying', false, firstRun)).catch(() => { /* closed meanwhile */ });
  return () => {
    if (check.isDestroyed()) return;
    retired = true;
    if (BrowserWindow.getAllWindows().length === 1) releaseCheckWindowRetired = true;
    check.destroy();
  };
}

/**
 * The trust key lives inside app.asar, independently of the daemon files.
 * Hashing every file of the release in a worker leaves the main thread free
 * to show the check window; the verdict and its messages stay those of
 * `verifyRelease`.
 */
async function verifyInstalledRelease(): Promise<void> {
  const publicKey = readFileSync(join(app.getAppPath(), 'release-public-key.pem'), 'utf8');
  const started = Date.now();
  releasePending = true;
  try {
    await checkWithWindow({
      verify: () => verifyReleaseInWorker(join(process.resourcesPath, 'orchestrator'), publicKey),
      show: showReleaseCheckWindow,
    });
  } finally {
    releasePending = false;
    console.log(`[desktop] release check: ${Date.now() - started} ms`);
  }
}

/** One line for the desktop log: what answered, and whether it is this home's Timon. */
function describeHealth(health: HealthResult, home: string): string {
  if (!health.ok) return `no answer (${health.error ?? 'unknown'})`;
  if (isTimon(health, home)) return `Timon, this home${health.updatePending ? ', update pending' : ''}`;
  return health.identity === 'timon' ? `Timon of another home (HTTP ${health.status})` : `not Timon (HTTP ${health.status})`;
}

/** When this shell's main script was written, from the sources only: inside `app.asar` it is the time the process started (`shell-build.ts`). */
function mainModifiedMs(): number | null {
  try {
    return statSync(fileURLToPath(import.meta.url)).mtimeMs;
  } catch {
    return null;
  }
}

/** The page of an interface window an IPC call came from, or null for anything else (a frame, a closed window). */
function senderPage(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): Caller | null {
  const found = windows.pageOf(event.sender.id);
  return found && contentsOf(found.page) === event.sender ? liveCaller(found) : null;
}

/**
 * A page switched light/dark: its background, and the window's while it is the
 * page on screen, follow — what shows during a resize or before a reload.
 */
function paintPageScheme(caller: Caller, scheme: Scheme): void {
  caller.page.view.view.setBackgroundColor(windowBackground(scheme));
  if (caller.record.pages.isActive(caller.page.contentsId)) caller.record.window.setBackgroundColor(windowBackground(scheme));
}

/** The interface window an IPC call came from, whichever of its pages sent it. */
function senderWindow(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): AppWindow | null {
  return senderPage(event)?.record ?? null;
}

/** What the IPC gates read of a caller: one of our windows, its main frame, its URL. */
function senderOf(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): { isWindow: boolean; isMainFrame: boolean; url: string } {
  return {
    isWindow: senderPage(event) !== null,
    isMainFrame: event.senderFrame === event.sender.mainFrame,
    url: event.senderFrame?.url ?? '',
  };
}

/** The origin a caller's window loads, checked against its frame's URL; empty for a stranger. */
function senderOrigin(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): string {
  return senderWindow(event)?.origin ?? '';
}

/**
 * A call the main process makes for a page, with its session and its
 * machine: what the page itself would have sent. `session.fetch` carries no
 * webContents, so the request hook cannot name the machine for it.
 */
function pageFetch(caller: Caller): (url: string, init?: RequestInit) => Promise<Response> {
  return (url, init = {}) => {
    if (!liveCaller(caller)) return Promise.reject(new Error('The Timon window is closed.'));
    const headers = new Headers(init.headers);
    if (caller.page.machineId !== null) headers.set('X-Timon-Machine', caller.page.machineId);
    return contentsOf(caller.page).session.fetch(url, { ...init, headers });
  };
}

/**
 * One request hook for the whole session (Electron keeps a single listener per
 * session): it names the machine of the page each request comes from.
 */
function installMachineHeader(): void {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: withMachineHeader(details, (id) => windows.pinnedFor(id)) });
  });
}

async function main(): Promise<void> {
  // Also here: whether `session-created` reports the default session is not documented.
  keepDictionariesLocal(session.defaultSession, process.platform);
  // Before any window: without handlers Electron grants every request.
  installWindowPermissions(session.defaultSession, {
    windowOrigin: () => windowOrigin,
    isWindow: (contents) => {
      const found = contents ? windows.pageOf(contents.id) : null;
      return !!found && contentsOf(found.page) === contents && liveCaller(found) !== null;
    },
    microphone,
    log: (line) => console.log(line),
  });
  installMachineHeader();
  await initShellLocale();
  installAppMenu();
  installJumpList();
  // Verify before any service startup or native browser side effects.
  // Known before the release check: its window, the first one shown, already takes the onboarding's look.
  firstRun = packagedFirstRun(desktopHome, app.isPackaged);
  if (app.isPackaged) await verifyInstalledRelease();
  if (process.platform === 'darwin') {
    // A damaged app icon must not abort startup before the tray fallback can report it.
    try {
      const icon = nativeImage.createFromPath(APP_ICON_PATH);
      if (!icon.isEmpty()) app.dock?.setIcon(icon);
    } catch (error) {
      console.warn('[desktop] Could not load the dock icon.', error);
    }
  }
  const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
  firstRun = cfg.packagedDefaults;
  let offer = app.isPackaged ? updateOffer(cfg.home, app.getVersion()) : null;
  if (offer) {
    // A daemon this app does not run (sources, a service installed by hand)
    // has no update routes: it keeps its data, and the window just opens on it.
    const unmanaged = unmanagedDaemon(cfg.home, await probeHealth(originOf(cfg.daemon.listen)), hasDesktopService(cfg.home));
    if (unmanaged) {
      console.log(`[desktop] update offer: none, the daemon on ${originOf(cfg.daemon.listen)} (supervisor ${cfg.daemon.supervisor}) ${unmanaged}`);
      offer = null;
    } else console.log('[desktop] update offer: shown');
  } else console.log('[desktop] update offer: none');
  if (offer) {
    // Asked to the daemon that runs now, the installed version's: approving moves its service.
    const installedDaemon = localDaemonGet(originOf(cfg.daemon.listen), cfg.home);
    updateWindow = new UpdateWindow(offer,
      join(process.resourcesPath, 'orchestrator', 'scripts', 'release-notes.json'), uiLocale(),
      windowScheme(desktopHome),
      () => readMissionCount(installedDaemon).then(missionsAtStake));
    if (!await updateWindow.choice) { console.log('[desktop] update declined: quitting'); app.quit(); return; }
    updateApproved = true;
  }
  // Past the approval, the new AppImage has started: the one it replaced is no longer needed.
  if (process.platform === 'linux') {
    void removeAppImageBackup(process.env.APPIMAGE).catch((error: unknown) => console.warn('[desktop] previous AppImage not removed', error));
  }
  console.log(`[desktop] daemon ${originOf(cfg.daemon.listen)}, app ${originOf(cfg.app.listen)}, supervisor ${cfg.daemon.supervisor}`);
  nativeBrowser = new NativeBrowserEngine(desktopHome, {
    // Each annotation bubble uses the session of the page that presented its profile.
    annotationRoutesForWindow: (w) => sessionAnnotationRoutes((url, init) => {
      const record = windows.find(w);
      const ownerId = record ? browserOwners.get(record.id) : undefined;
      const owner = liveCaller(ownerId === undefined ? null : windows.pageOf(ownerId));
      if (!owner) return Promise.reject(new Error('The Timon window is closed.'));
      return pageFetch(owner)(url, init);
    }, () => windowOrigin),
    // The keyboard goes back to the page on screen, not to the window's own blank webContents.
    focusWindow: (w) => {
      const caller = activeCaller(windows.find(w));
      if (caller) contentsOf(caller.page).focus();
    },
    scheme: () => windowScheme(desktopHome),
    locale: () => uiLocale(),
  });
  browserMedia = new NativeBrowserMedia(desktopHome, profileId => nativeBrowser!.mediaSource(profileId));
  const browserProvider = await startNativeBrowserServer(desktopHome, (body) => {
    if (typeof body.action === 'string' && body.action.startsWith('media')) return browserMedia!.command(body);
    if (body.action === 'stop' && typeof body.profileId === 'string') browserMedia!.closeProfile(body.profileId);
    return nativeBrowser!.command(body);
  });
  stopBrowserProvider = browserProvider.close;
  const restoreId = await offerDataRestore(cfg.home);
  // Asked before anything reads the revision file: a task deleted outside
  // Timon leaves it behind, and everything below would believe in a service.
  const winService = app.isPackaged && process.platform === 'win32';
  const taskState = winService ? await windowsTaskState() : null;
  if (taskState) {
    console.log(`[desktop] boot task: schtasks ${taskState.schtasks ? 'sees' : 'does not see'} it, ScheduledTasks says ${taskState.lookup}`);
    if (taskState.confirmedAbsent) {
      const forgotten = forgetMissingWindowsService(cfg.home);
      if (forgotten.length > 0) console.log(`[desktop] the boot task was deleted outside Timon: forgot ${forgotten.join(', ')}`);
    }
  }
  const serviceInstalled = hasDesktopService(cfg.home);
  // The session witness the launcher waits on can go stale (password reset):
  // sealed again here, in the user's own session. Not awaited, the launcher
  // retries every 10 s whatever this answers.
  if (winService && serviceInstalled) {
    void repairSessionWitness(cfg.home)
      .then(result => console.log(`[desktop] session witness: ${result}`))
      .catch((error: unknown) => console.error('[desktop] session witness check failed', error));
  }
  let serviceUnusable = false;
  const upgradeNeeded = serviceUpgradeNeeded(cfg.home, app.getVersion(), {
    packaged: app.isPackaged,
    serviceInstalled,
  });
  console.log(`[desktop] service installed: ${serviceInstalled}; upgrade needed: ${upgradeNeeded}`);
  const repair = serviceRepairVerdict(cfg.home, app.getVersion(), {
    packaged: app.isPackaged,
    // A portable install chose no supervisor: nothing was lost there.
    configured: cfg.daemon.supervisor !== 'none' && existsSync(join(cfg.home, 'timon.config.json')),
    taskExists: taskState?.exists ?? true,
  });
  if (repair !== 'task-exists' && repair !== 'not-applicable') console.log(`[desktop] service repair verdict: ${repair}`);
  if (!upgradeNeeded && repair === 'wanted') {
    console.log('[desktop] service repair wanted: asking');
    if (updateApproved) updateStage = 'service';
    await offerServiceRepair(cfg);
  } else if (upgradeNeeded && taskState && !taskState.exists) {
    console.log('[desktop] the boot task is missing and a service upgrade is pending: the upgrade runs instead of the repair offer');
  }
  if (upgradeNeeded) {
    if (updateApproved) updateStage = 'service';
    try {
      await upgradePackagedService(cfg, {
        execPath: shellDaemonRuntime().execPath,
        runtimeEnv: shellDaemonRuntime().env,
        resourcesPath: process.resourcesPath,
        version: app.getVersion(),
      });
    } catch (error) {
      // Boot on whatever the runner left rather than refusing to start, and
      // say so instead of silently serving the old UI.
      console.error('[desktop] service upgrade failed', error);
      if (updateApproved && !upgradeNeedsFallback(error)) throw error;
      serviceUnusable = upgradeNeedsFallback(error);
      const unsaved = snapshotFailure(cfg.home, app.getVersion());
      void reportProblem({
        type: 'warning',
        ...(unsaved?.blocking ? snapshotFailureDialog(unsaved, uiLocale()) : upgradeFailureMessage(error, app.getVersion(), cfg.home, uiLocale())),
      });
    }
  }
  if (restoreId) await waitForRestoreBoot(cfg, restoreId);
  let daemonOrigin = originOf(cfg.daemon.listen);
  let health = await probeHealth(daemonOrigin);
  if (cfg.packagedDefaults && !hasDesktopService(cfg.home)
    && (!health.ok || (health.identity === 'timon' && health.instance && !isTimon(health, cfg.home)))) {
    await assignBootstrapPorts(cfg);
    daemonOrigin = originOf(cfg.daemon.listen);
    health = await probeHealth(daemonOrigin);
  }
  const uiUrl = originOf(cfg.app.listen);
  interfaceUrl = uiUrl;
  daemonUp = isTimon(health, cfg.home);
  noteDesktopOpened(cfg);
  console.log(`[desktop] health of ${daemonOrigin}: ${describeHealth(health, cfg.home)}`);

  if (!updateWindow) buildTray(cfg, uiUrl);

  if (daemonUp) {
    console.log('[desktop] branch: daemon already up');
    // Started again by other means (`timon service start`, a boot): the marker
    // would otherwise prompt for a start that already happened.
    if (serviceStoppedByUser(cfg.home)) forgetServiceStopped(cfg.home);
    await completeApprovedUpdate(cfg);
    rearmAppIfDown(cfg, uiUrl);
    showWindow(uiUrl);
  } else if (health.ok) {
    console.log('[desktop] branch: foreign daemon on the port');
    reportForeignDaemon(cfg);
  } else if (serviceUnusable) {
    console.log('[desktop] branch: service unusable, embedded daemon');
    await startEmbeddedDaemon(cfg, uiUrl);
  } else if (hasDesktopService(cfg.home)) {
    showStartingWindow(uiUrl);
    if (serviceStoppedByUser(cfg.home)) {
      // "Quit and stop the background service" disabled the Windows task
      // (booted the launchd job out): nothing but this starts it again.
      console.log('[desktop] branch: the service was stopped by the user, starting it again');
      try {
        console.log(`[desktop] service started again: ${await controlDesktopService('start', runnerSeams(cfg))}`);
      } catch (error) {
        console.error('[desktop] service start failed', error);
        failStartup();
        await reportProblemThenQuit({ type: 'warning', ...startStoppedServiceFailureMessage(error, cfg.home, uiLocale()) });
        return;
      }
    }
    // Already refused for this account (TODO #342): a short look, not the full
    // wait, at every launch until the task is removed.
    const service = await startDesktopService(cfg.home, cfg.packagedDefaults, undefined, process.platform, undefined, {},
      existsSync(windowsServiceRefusedFile(cfg.home)) ? { budgetMs: 2_000 } : {});
    console.log(`[desktop] branch: start the service → ${service}`);
    if (service === 'needs-repair') {
      await startEmbeddedDaemon(cfg, uiUrl);
    } else if (service === 'never-ran') {
      // Windows will not run the task for this account (TODO #342): waiting
      // on it would end in "does not answer" with no log to read.
      recordServiceRefused(cfg.home);
      await startEmbeddedDaemon(cfg, uiUrl);
      if (serviceRefusedNoticeDue(cfg.home, app.getVersion())) {
        markServiceRefusedNotice(cfg.home, app.getVersion());
        void reportProblem({ type: 'warning', ...serviceRefusedMessage(uiLocale()) });
      }
    } else {
      // Windows ran the task this time: kept, the marker would keep the setup
      // on the portable mode and the repair offer silent (TODO #342).
      clearServiceRefused(cfg.home);
      const serviceHealth = await waitForHealth(daemonOrigin, SERVICE_BOOT_BUDGET_MS);
      daemonUp = isTimon(serviceHealth, cfg.home);
      noteDesktopOpened(cfg);
      console.log(`[desktop] service health after ${SERVICE_BOOT_BUDGET_MS / 1000}s: ${describeHealth(serviceHealth, cfg.home)}`);
      refreshTray(cfg, uiUrl);
      if (daemonUp) { await completeApprovedUpdate(cfg); showWindow(uiUrl); }
      else offerServiceInstall(cfg);
    }
  } else if (cfg.daemon.supervisor === 'none' || app.isPackaged) {
    console.log('[desktop] branch: embedded daemon');
    await startEmbeddedDaemon(cfg, uiUrl);
  } else {
    console.log('[desktop] branch: no service, no embedded daemon');
    offerServiceInstall(cfg);
  }

  if (updateWindow) throw new Error(updateCopy(uiLocale()).failure);
  if (!tray && updateApproved && daemonUp) buildTray(cfg, uiUrl);

  if (restoreId && daemonUp) reportRestore(cfg.home, restoreId);
  // Started without a copy: said after each attempt until one is made. A partial copy: said once.
  const unshown = daemonUp ? unshownSnapshotWarning(cfg.home, app.getVersion()) : null;
  if (unshown) {
    markSnapshotWarningShown(cfg.home, unshown);
    void dialog.showMessageBox({ type: 'warning', title: DISPLAY_NAME, ...snapshotFailureDialog(unshown, uiLocale()) });
  }

  // Opening at login is what makes the tray useful; the user can undo it in
  // their OS settings, and we never fight that choice back.
  app.setLoginItemSettings({ openAtLogin: true });
}

if (process.argv.includes(UNINSTALL_HELPER_FLAG)) {
  void runUninstallHelper().catch(error => { dialog.showErrorBox(DISPLAY_NAME, String(error)); app.exit(1); });
} else {
// Before any window: the class the dock matches its launcher against (`linux-desktop.ts`).
const devName = devShellName(process.platform, app.isPackaged);
if (devName) {
  app.setName(devName);
  // Wayland's app_id: Electron derived it from the name it started with.
  process.env.CHROME_DESKTOP = `${devName}.desktop`;
}
// Windows: the installer's ID, which its shortcuts carry and the jump list hangs on (`jump-list.ts`).
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
// The session and single-instance lock belong to a data directory, not the whole product.
const requestedHome = resolve(resolveTimonHome());
mkdirSync(requestedHome, { recursive: true });
desktopHome = realpathSync(requestedHome);
installDesktopLog(desktopHome);
console.log(`[desktop] Timon ${app.getVersion()} starting on ${process.platform} (packaged: ${app.isPackaged}), home ${desktopHome}`);
const configuredAtLaunch = existsSync(join(desktopHome, 'timon.config.json'));
// Also inherited by app.relaunch: never create or select another instance.
process.env.TIMON_HOME = desktopHome;
app.setPath('userData', join(desktopHome, 'desktop-profile'));
layoutKeeper = new WindowLayoutKeeper(readWindowLayout(desktopHome), {
  snapshot: () => liveWindows().map(savedWindow),
  write: (layout) => writeWindowLayout(desktopHome, layout),
});

/** This shell's build, sent by a second launch so the running shell can tell it is stale (`shell-build.ts`). */
const ownBuild = shellBuild({ packaged: app.isPackaged, version: app.getVersion(), mainModifiedMs: mainModifiedMs() });

// A second launch opens a window in this shell (`second-instance`), never a second shell.
if (!app.requestSingleInstanceLock({ build: ownBuild } satisfies LaunchData)) {
  app.quit();
} else {
  const restartAfterSetup = setupRestarter({
    validate: () => {
      if (!existsSync(join(desktopHome, 'timon.config.json'))) {
        throw new Error('Save the configuration before restarting Timon.');
      }
      const options = relaunchOptions(process.platform, process.env, process.argv);
      if (options.execPath) accessSync(options.execPath, constants.X_OK);
    },
    stopEmbedded: async () => {
      await stopEmbedded?.();
      stopEmbedded = null;
    },
    relaunch: () => {
      const options = relaunchOptions(process.platform, process.env, process.argv);
      return options.execPath
        ? queueAppImageRelaunch(options.execPath, options.args, desktopHome)
        : app.relaunch(options);
    },
    quit: () => app.quit(),
    serviceOwnsDaemon: () => stopEmbedded === null && hasDesktopService(desktopHome),
    restartService: () => restartDesktopService(desktopHome, undefined, process.platform, undefined, {},
      process.platform === 'win32'
        ? runnerSeams(loadDesktopConfig(desktopHome, { packaged: true }))
        : undefined),
  });
  // End of a first setup: the service the wizard installed takes over before
  // step 3, so its agent never runs on a daemon about to be replaced.
  const handOverToService = serviceHandover({
    needed: () => {
      const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
      const state = {
        embedded: stopEmbedded !== null,
        configuredAtLaunch,
        configuredNow: existsSync(join(desktopHome, 'timon.config.json')),
        serviceInstalled: hasDesktopService(desktopHome),
        serviceRefused: existsSync(windowsServiceRefusedFile(desktopHome)),
        supervisor: cfg.daemon.supervisor,
        sameOrigins: originOf(cfg.app.listen) === interfaceUrl && originOf(cfg.daemon.listen) === embeddedDaemonOrigin,
      };
      const needed = serviceHandoverNeeded(state);
      // A recette must tell "nothing to hand over" from a guard that never holds.
      if (!needed) console.log(`[desktop] handover skipped: ${JSON.stringify(state)}`);
      return needed;
    },
    showRestarting: (route) => {
      console.log('[desktop] handover: the embedded daemon gives its place to the service');
      daemonUp = false;
      for (const { pages } of windows.list()) for (const { view: { startup } } of pages.list()) startup.restart(route);
    },
    stopEmbedded: async () => {
      await stopEmbedded?.();
      stopEmbedded = null;
    },
    kickService: () => kickService(loadDesktopConfig(desktopHome, { packaged: app.isPackaged })),
    waitService: async () => {
      const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
      const health = await waitForHealth(originOf(cfg.daemon.listen), HANDOVER_BUDGET_MS);
      console.log(`[desktop] handover: service health: ${describeHealth(health, cfg.home)}`);
      return isTimon(health, cfg.home);
    },
    resume: () => {
      const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
      daemonUp = true;
      noteDesktopOpened(cfg);
      refreshTray(cfg, interfaceUrl);
      showWindow(interfaceUrl);
    },
    resumeEmbedded: async () => {
      console.warn('[desktop] handover: the service did not answer, the embedded daemon serves again');
      await startEmbeddedDaemon(loadDesktopConfig(desktopHome, { packaged: app.isPackaged }), interfaceUrl);
    },
    reportKept: (why) => {
      void reportProblem({ type: 'warning', ...handoverKeptMessage(uiLocale(), desktopHome, why) });
    },
  });
  ipcMain.handle(SELECT_DIRECTORY_CHANNEL, async (event, defaultPath: unknown) => {
    const parent = senderWindow(event)?.window;
    return selectDirectory(senderOf(event), senderOrigin(event), defaultPath, (options) => dialog.showOpenDialog(parent!, options));
  });
  ipcMain.handle(SELECT_PLUGIN_SOURCE_CHANNEL, async (event, kind: unknown) => {
    const parent = senderWindow(event)?.window;
    return selectPluginSource(senderOf(event), senderOrigin(event), kind, (options) => dialog.showOpenDialog(parent!, options));
  });
  ipcMain.handle(SELECT_EXECUTABLE_CHANNEL, async (event, defaultPath: unknown) => {
    const parent = senderWindow(event)?.window;
    return selectExecutable(senderOf(event), senderOrigin(event), defaultPath, (options) => dialog.showOpenDialog(parent!, options));
  });
  ipcMain.handle(REVEAL_PATH_CHANNEL, (event, request: unknown) => revealEntry(senderOf(event), senderOrigin(event), request, {
    platform: process.platform,
    // The window's own session carries the user's `timon_session` cookie, and the request its machine.
    callRoute: async (agentId, path) => {
      const caller = senderPage(event);
      if (!caller) throw new Error('The Timon window is closed.');
      const res = await pageFetch(caller)(
        `${caller.record.origin}/api/ui/agents/${encodeURIComponent(agentId)}/files/reveal`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path, client: 'desktop' }),
          credentials: 'include',
          signal: AbortSignal.timeout(15_000),
        },
      );
      return { status: res.status, body: await res.json().catch(() => null) as unknown };
    },
    stat: (path) => statSync(path, { throwIfNoEntry: false }) ?? null,
    realpath: (path) => realpathSync(path),
    exists: (path) => existsSync(path),
    showItemInFolder: (path) => shell.showItemInFolder(path),
    openPath: (path) => shell.openPath(path),
  }));
  // Settings › Devices › Install Tailscale, when the daemon runs where no window
  // shows (Windows session 0, macOS LaunchDaemon): it verified the package, this
  // process opens it in the user's session. The renderer passes nothing.
  // The page that asked last: its session, its machine.
  let tailscaleCaller: Caller | null = null;
  const tailscaleRoute = async (path: string, init: RequestInit = {}) => {
    const caller = liveCaller(tailscaleCaller) ?? activeCaller(windows.primary());
    if (!caller) throw new Error('The Timon window is closed.');
    return pageFetch(caller)(`${caller.record.origin}/api/ui/devices/tailscale${path}`, {
      ...init,
      credentials: 'include',
      signal: AbortSignal.timeout(15_000),
    });
  };
  const tailscaleInstaller = new TailscaleInstaller({
    platform: process.platform,
    readStatus: async () => {
      const res = await tailscaleRoute('', { cache: 'no-store' });
      return { status: res.status, body: await res.json().catch(() => null) as unknown };
    },
    report: async (body) => {
      await tailscaleRoute('/install/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
    lstat: (path) => lstatSync(path, { throwIfNoEntry: false }) ?? null,
    sha256File: (path) => new Promise((resolveHash, rejectHash) => {
      const hash = createHash('sha256');
      createReadStream(path).on('error', rejectHash).on('data', (chunk) => hash.update(chunk)).on('end', () => resolveHash(hash.digest('hex')));
    }),
    // The installer waits on a person (password, UAC): no timeout kills it halfway.
    run: (file, args) => new Promise((resolveRun) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(file, args, { stdio: 'ignore' });
      } catch (err) {
        resolveRun({ code: null, error: err instanceof Error ? err.message : String(err) });
        return;
      }
      child.once('error', (err) => resolveRun({ code: null, error: err.message }));
      child.once('exit', (code) => resolveRun({ code, error: null }));
    }),
    systemRoot: process.env.SystemRoot ?? null,
    exists: (path) => existsSync(path),
  });
  ipcMain.handle(TAILSCALE_INSTALLER_CHANNEL, (event) => {
    tailscaleCaller = senderPage(event) ?? tailscaleCaller;
    return tailscaleInstaller.openInstaller(senderOf(event), senderOrigin(event));
  });
  ipcMain.handle(TAILSCALE_OPEN_APP_CHANNEL, (event) => {
    tailscaleCaller = senderPage(event) ?? tailscaleCaller;
    return tailscaleInstaller.openApp(senderOf(event), senderOrigin(event));
  });
  // "Download" on the new-version banner (docs/AUTO-UPDATE.md P2): the installer
  // the local daemon verified, for this machine, into the data directory. Pages of
  // another machine neither start it nor hear of it: it updates this app.
  const localPage = (caller: Caller | null): boolean => caller !== null && (caller.page.machineId === null || caller.page.machineId === LOCAL_MACHINE_ID);
  let updates: UpdateController | null = null;
  const updateController = (): UpdateController => {
    if (updates) return updates;
    const downloader = new UpdateDownloader({
      root: join(loadDesktopConfig(desktopHome, { packaged: app.isPackaged }).home, 'updates'),
      onState: (state) => {
        for (const record of liveWindows()) {
          for (const page of record.pages.list()) {
            const caller = liveCaller({ record, page });
            if (caller && localPage(caller)) contentsOf(page).send(UPDATE_CHANNELS.event, state);
          }
        }
      },
      log: (line) => console.log(line),
    });
    const daemonGet = () => {
      const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
      return localDaemonGet(originOf(cfg.daemon.listen), cfg.home);
    };
    updates = new UpdateController({
      downloader,
      readStatus: () => daemonGet()('/api/updates'),
      readMissions: () => readMissionCount(daemonGet()),
      installed: app.getVersion(),
      machine: { platform: process.platform, arch: process.arch, appImage: Boolean(process.env.APPIMAGE) },
      appImage: process.platform === 'linux' ? process.env.APPIMAGE ?? null : null,
      relaunchAppImage: (appImage) => queueAppImageRelaunch(appImage, relaunchOptions(process.platform, process.env, process.argv).args, desktopHome),
      quit: () => app.quit(),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      openPath: (path) => shell.openPath(path),
      log: (line) => console.log(line),
    });
    return updates;
  };
  registerUpdateIpc<Electron.IpcMainInvokeEvent>(
    { handle: (channel, listener) => ipcMain.handle(channel, (event, input: unknown) => listener(event, input)) },
    (event) => canReadAppInfo(senderOf(event), senderOrigin(event)) && localPage(senderPage(event)),
    updateController,
  );
  const browserSenderAllowed = (event: Electron.IpcMainInvokeEvent): boolean => trustedBrowserSender(senderOf(event), senderOrigin(event));
  // Every window may present a local profile. Remote pages use their daemon's video.
  ipcMain.handle(BROWSER_ATTACH_CHANNEL, (event, request: unknown) => {
    const caller = senderPage(event);
    if (!browserSenderAllowed(event) || !caller || !nativeBrowser) throw new Error('Browser presentation is only available from Timon.');
    // A hidden page renews its panel on a timer: nothing shows, and no error either (it would greet the user on return).
    if (!caller.record.pages.isActive(caller.page.contentsId)) return;
    if (caller.page.machineId !== null && caller.page.machineId !== LOCAL_MACHINE_ID) return { attached: false };
    nativeBrowser.attach(caller.record.window, request);
    browserOwners.set(caller.record.id, caller.page.contentsId);
    return { attached: true };
  });
  ipcMain.handle(BROWSER_DETACH_CHANNEL, (event) => {
    if (!browserSenderAllowed(event)) throw new Error('Browser presentation is only available from Timon.');
    // Only the page the panel shows for takes it down: another window's, or a hidden page's, leaves it alone.
    const caller = senderPage(event);
    if (!caller || browserOwners.get(caller.record.id) !== caller.page.contentsId) return;
    detachBrowser(caller.page.contentsId);
  });
  const uninstallSenderAllowed = (event: Electron.IpcMainInvokeEvent) => app.isPackaged && canUninstall(senderOf(event), senderOrigin(event));
  ipcMain.handle(UNINSTALL_INFO_CHANNEL, event => {
    if (!uninstallSenderAllowed(event)) throw new Error('Uninstall is only available in installed Timon settings.');
    return { home: desktopHome, platform: process.platform, appImage: process.env.APPIMAGE ?? null };
  });
  // Settings › System › Installation compares the app with its daemon, which
  // may be a service left on an older release.
  ipcMain.handle(APP_INFO_CHANNEL, (event) => {
    if (!canReadAppInfo(senderOf(event), senderOrigin(event))) throw new Error('App information is only available in the Timon window.');
    return { version: app.getVersion() };
  });
  // Settings › System: the same folder as the error boxes (TODO #343).
  ipcMain.handle(OPEN_LOGS_CHANNEL, async (event) => {
    if (!canReadAppInfo(senderOf(event), senderOrigin(event))) throw new Error('The logs folder is only available from the Timon window.');
    const dir = logDir(desktopHome);
    mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  registerAboutIpc((channel, listener) => ipcMain.handle(channel, (event) => listener(senderOf(event))),
    (sender) => canReadAppInfo(sender, windowOrigin), openAbout);
  // Local dictation (TODO #443): same window, frame and origin checks as the
  // app info. One engine for all windows: its events go to the window that
  // started the dictation or the download, its boxes are modal to it.
  let speechOwner: Caller | null = null;
  const speechWindow = (): Caller | null => liveCaller(speechOwner) ?? activeCaller(windows.primary());
  const SPEECH_OWNING = new Set<string>([SPEECH_CHANNELS.start, SPEECH_CHANNELS.download, SPEECH_CHANNELS.importModel, SPEECH_CHANNELS.proposePack]);
  registerSpeechIpc({
    handle: (channel, listener) => ipcMain.handle(channel, (event, input: unknown) => {
      if (SPEECH_OWNING.has(channel)) speechOwner = senderPage(event) ?? speechOwner;
      return listener(senderOf(event), input);
    }),
    on: (channel, listener) => { ipcMain.on(channel, (event, input: unknown) => listener(senderOf(event), input)); },
  }, (sender) => canReadAppInfo(sender, windowOrigin), () => {
    speech ??= createDesktopSpeech(desktopHome, (event) => {
      const owner = speechWindow();
      if (owner) contentsOf(owner.page).send(SPEECH_CHANNELS.event, event);
    }, () => speechWindow()?.record.window ?? null, (pluginId) => {
      // The page's own session carries the user's cookie: the daemon answers for the plugins this user sees.
      const owner = speechWindow();
      if (!owner) return Promise.resolve({ ok: false, code: 'unavailable' });
      return fetchPluginPack(pageFetch(owner), owner.record.origin, pluginId);
    }, uiLocale);
    return speech.controller;
  });
  registerMicrophoneIpc({
    handle: (channel, listener) => ipcMain.handle(channel, (event, input: unknown) => listener(senderOf(event), input)),
    on: (channel, listener) => { ipcMain.on(channel, (event, input: unknown) => listener(senderOf(event), input)); },
  }, (sender) => canReadAppInfo(sender, windowOrigin), microphone);
  ipcMain.handle(UNINSTALL_CHANNEL, async (event, input: unknown) => {
    if (!uninstallSenderAllowed(event)) throw new Error('Uninstall is only available in installed Timon settings.');
    if (uninstalling) throw new Error('Uninstall is already in progress.');
    const request = uninstallRequest(input);
    const parent = senderWindow(event)?.window ?? null;
    const plan = cleanupPlan(desktopHome, request.mode, process.execPath);
    const t = shellText(request.locale);
    uninstalling = true;
    let helper: Awaited<ReturnType<typeof prepareCleanup>> | undefined;
    try {
      const confirmed = await dialog.showMessageBox(parent!, {
        type: 'warning', title: DISPLAY_NAME, noLink: true, defaultId: 0, cancelId: 0,
        buttons: [t('uninstall.cancel'), t(request.mode === 'delete' ? 'uninstall.confirmDelete' : 'uninstall.confirmKeep')],
        message: t('uninstall.message'),
        detail: [
          t('uninstall.stops'),
          t(request.mode === 'delete' ? 'uninstall.deletes' : 'uninstall.keeps', { home: desktopHome }),
          t('uninstall.outside'),
        ].join('\n\n'),
      });
      if (confirmed.response !== 1) return { cancelled: true };
      const cfg = loadDesktopConfig(desktopHome, { packaged: true });
      helper = await prepareCleanup(process.execPath, { plan, copy: cleanupCopy(request.locale, plan.home),
        instructions: removalInstructions(process.platform, request.locale, process.env.APPIMAGE) });
      await performUninstall({
        stopEmbedded: async () => { await stopEmbedded?.(); stopEmbedded = null; },
        stopService: () => stopInstalledService(cfg, shellDaemonRuntime(), process.resourcesPath, app.getVersion()),
        stopBrowser: async () => {
          await stopBrowserProvider?.(); stopBrowserProvider = null;
          browserMedia?.close(); browserMedia = null;
          await nativeBrowser?.close(); nativeBrowser = null;
        },
        verifyStopped: () => verifyStopped(cfg),
        disableLogin: () => app.setLoginItemSettings({ openAtLogin: false }),
        armCleanup: () => helper!.arm(),
        quit: () => { uninstallReadyToQuit = true; app.quit(); },
      });
      return { cancelled: false };
    } catch (error) {
      helper?.cancel();
      void reportProblem({
        type: 'error',
        message: t('uninstall.incomplete'),
        detail: `${t('uninstall.incompleteDetail')}\n\n${(error as Error).message}`,
      }, parent);
      throw error;
    } finally { if (!uninstallReadyToQuit) uninstalling = false; }
  });
  ipcMain.handle(SETUP_RESTART_STATUS_CHANNEL, (event) => {
    if (!canRestartFromSetup(senderOf(event), senderOrigin(event))) throw new Error('Restart status is only available to the Timon window.');
    return setupRestartPending({
      embedded: stopEmbedded !== null, configuredAtLaunch,
      configuredNow: existsSync(join(desktopHome, 'timon.config.json')),
      serviceInstalled: hasDesktopService(desktopHome),
    });
  });
  ipcMain.handle(SETUP_HANDOVER_CHANNEL, async (event, route: unknown) => {
    if (!canRestartFromSetup(senderOf(event), senderOrigin(event))) throw new Error('The handover is only available to the Timon window.');
    const path = handoverRoute(route, interfaceUrl);
    if (path === null) throw new Error('The handover route must be a path of the interface.');
    try {
      return await handOverToService(path);
    } catch (error) {
      const t = startupText(uiLocale());
      void reportProblem({
        type: 'error',
        message: t('startup.restartFailed'),
        detail: t('startup.restartFailedDetail', { home: desktopHome, reason: (error as Error).message }),
      });
      throw error;
    }
  });
  ipcMain.handle(SETUP_RESTART_CHANNEL, async (event) => {
    if (!canRestartFromSetup(senderOf(event), senderOrigin(event))) throw new Error('Restart is only available to the Timon window.');
    try {
      await restartAfterSetup();
    } catch (error) {
      // Stopping the daemon may also stop the page that requested the restart.
      const t = startupText(uiLocale());
      void reportProblem({
        type: 'error',
        message: t('startup.restartFailed'),
        detail: t('startup.restartFailedDetail', { home: desktopHome, reason: (error as Error).message }),
      });
      throw error;
    }
  });
  // A second launch opens one more window (multi-window V3): three screens,
  // three windows, each on its machine. While the interface is failing or a
  // check or update window is up, it is the gesture that brings them back.
  app.on('second-instance', (_event, _argv, _cwd, launch: unknown) => {
    const cfg = loadDesktopConfig(desktopHome, { packaged: app.isPackaged });
    const url = originOf(cfg.app.listen);
    // Another build launched: its pages would ask for bridges this main process does not have.
    if (launchedOtherBuild(ownBuild, launch)) {
      console.log(`[desktop] another build was launched (${String((launch as LaunchData).build)}, running ${ownBuild}): asking for a restart`);
      showWindow(url);
      const copy = staleShellCopy(uiLocale(), DISPLAY_NAME);
      const parent = frontWindow()?.window;
      void (parent ? dialog.showMessageBox(parent, { type: 'info', title: DISPLAY_NAME, ...copy }) : dialog.showMessageBox({ type: 'info', title: DISPLAY_NAME, ...copy }))
        .catch((error: unknown) => console.warn('[desktop] restart notice failed', error));
      return;
    }
    // Reopening Timon after the interface gave up is the gesture that retries it.
    const failed = windows.list().some(({ pages }) => pages.list().some(({ view }) => view.startup.state === 'failed'));
    if (daemonUp && failed) rearmAppIfDown(cfg, url);
    if (failed || !daemonUp) { showWindow(url); return; }
    openNewWindow();
  });
  // The page asks for its window to drive another machine (the machine
  // switcher in Electron). An id only: the app resolves it with the local
  // session at every request, exactly like the cookie. The window shows that
  // machine's page, kept alive or opened on the route the page read from
  // `lastRouteFor` (V4); the caller is hidden as it is, it does not reload.
  ipcMain.handle(WINDOW_MACHINE_CHANNEL, (event, id: unknown, request: unknown) => {
    const caller = senderPage(event);
    if (!caller || !canReadAppInfo(senderOf(event), caller.record.origin)) throw new Error('Only a Timon window chooses its machine.');
    if (!caller.record.pages.isActive(caller.page.contentsId) || caller.record.closing) throw new Error('Only the page on screen chooses its window\'s machine.');
    if (!isMachineId(id)) throw new Error('A machine is named by its id.');
    const shown = enterMachine(caller.record, id, pageUrl(caller.record.origin, request));
    layoutKeeper?.machineChosen(id);
    console.log(`[desktop] window ${caller.record.id} now shows machine ${id} (${shown === caller.page ? 'already' : 'switched'}; ${caller.record.pages.size} page(s) alive)`);
    return { id, shown: true };
  });

  // A page reports the mode it paints: each machine keeps its own, and the
  // next window or page opened on a remote one paints it before it loads. The
  // machine is the window's pin; an unpinned page names the one it was served for.
  ipcMain.handle(WINDOW_SCHEME_CHANNEL, (event, input: unknown) => {
    const caller = senderPage(event);
    if (!caller || !canReadAppInfo(senderOf(event), caller.record.origin)) throw new Error('Only a Timon window reports its mode.');
    const report = parseWindowSchemeReport(input);
    if (!report) throw new Error('A mode is light or dark.');
    paintPageScheme(caller, report.scheme);
    return { recorded: recordMachineScheme(desktopHome, caller.page.machineId ?? report.machineId, report.scheme) };
  });

  // A page opens one of its routes in a new window (V5): a route and the
  // machine it shows, never a URL; the address is the caller's own origin.
  ipcMain.handle(OPEN_WINDOW_CHANNEL, (event, input: unknown) => {
    const caller = senderWindow(event);
    if (!caller || !canReadAppInfo(senderOf(event), caller.origin)) throw new Error('Only a Timon window opens another one.');
    const request = parseOpenWindowRequest(input, caller.origin);
    if (!request) throw new Error('A window opens on a route of this interface.');
    const machineId = machineForDetachedWindow(caller.machineId, request.machineId);
    const opened = openDetachedWindow(caller, request.url, machineId);
    console.log(`[desktop] window ${caller.id} detached a page on machine ${machineId ?? '(cookie)'}: ${opened ? 'opened' : 'not now'}`);
    return { opened };
  });

  // Every session, before any page loads: no spell-check dictionary from Google.
  app.on('session-created', (created) => keepDictionariesLocal(created, process.platform));
  app.whenReady().then(main).catch(async (e: unknown) => {
    console.error('[desktop] startup failed', e);
    // Quit only once the box is closed: on Linux the copied report would go with the app.
    await reportProblemThenQuit(e instanceof DaemonStartTimeoutError
      // The migration is done; only the boot is slow. No "data may have changed".
      ? { type: 'warning', message: e.message, detail: e.detail }
      : updateApproved
        // Only what happened: no "service replaced" when nothing was sent (TODO #477).
        ? { type: 'error', ...updateFailureDialog(uiLocale(), updateStage, (e as Error).message) }
        : { type: 'error', message: startupText(uiLocale())('startup.failed'), detail: (e as Error).message });
  });

  // On macOS the daemon already lives outside the bundle. Closing the only
  // window quits the shell when no native browser session needs it. Active profiles
  // remain in their hidden hosts for workflows and the remote PWA until explicit Quit.
  app.on('window-all-closed', () => {
    // Let the provider finish replying when a remote stop closed its last hidden host.
    setImmediate(() => {
      if (releaseCheckWindowRetired) { releaseCheckWindowRetired = false; return; }
      if (!uninstalling && !quittingAfterProblem && quitWhenLastWindowCloses() && !nativeBrowser?.hasSessions && BrowserWindow.getAllWindows().length === 0) app.quit();
    });
  });

  // In portable mode the daemon is our child: quitting must take it with us,
  // and must not leave a supervisor restarting a daemon nobody watches.
  let quittingAfterEmbeddedStop = false;
  app.on('before-quit', (event) => {
    console.log('[desktop] shutdown: before-quit');
    if (errorBoxes.deferQuit()) { event.preventDefault(); return; }
    if (updateWindow && updateApproved) { event.preventDefault(); return; }
    if (uninstalling && !uninstallReadyToQuit) { event.preventDefault(); return; }
    // The quit goes ahead: the windows Electron closes from here on are the arrangement to restore.
    layoutKeeper?.freeze();
    quitInProgress = true;
    // Every page answers first: a quit the user calls off must leave nothing stopped (TODO #758).
    if (windowsHoldQuit()) { event.preventDefault(); return; }
    speech?.dispose();
    speech = null;
    if (quittingAfterEmbeddedStop || (!stopEmbedded && !stopBrowserProvider && !nativeBrowser)) return;
    event.preventDefault();
    quittingAfterEmbeddedStop = true;
    const stop = stopEmbedded;
    const stopProvider = stopBrowserProvider;
    const browser = nativeBrowser;
    const media = browserMedia;
    stopEmbedded = null;
    stopBrowserProvider = null;
    nativeBrowser = null;
    browserMedia = null;
    void (async () => {
      await stopProvider?.();
      media?.close();
      const stopped = await Promise.allSettled([browser?.close(), stop?.()]);
      for (const result of stopped) {
        if (result.status === 'rejected') console.error('[desktop] stop failed', result.reason);
      }
    })()
      .catch((error: unknown) => console.error('[embedded] stop failed', error))
      .finally(() => app.quit());
  });
  // macOS: a click on the Dock icon with no window left (browser sessions keep the app) opens them again.
  app.on('activate', () => {
    if (interfaceUrl && liveWindows().length === 0) showWindow(interfaceUrl);
  });
  // The last lines before a crash at exit say how far the shutdown went (TODO #478).
  app.on('will-quit', () => console.log('[desktop] shutdown: will-quit'));
  app.on('quit', (_event, code) => console.log(`[desktop] shutdown: quit, exit code ${code}`));
}

}
