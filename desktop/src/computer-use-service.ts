/**
 * The computer-native service: availability, stop/resume, coordinate conversion and dispatch.
 *
 * Every effect on the machine goes through an injected dependency (executor, capture, display),
 * so the whole decision logic runs under test with simulated ones. This file imports no Electron.
 */
import {
  COMPUTER_DEFAULT_MAX_WIDTH, ComputerCommandError, FRONT_WINDOW, type AllowedApp, type ComputerActor, type ComputerUseMode, type ComputerCommand, type ComputerUnavailableReason,
} from './computer-use-protocol.js';
import { clipToDisplay, imageToPoints, pointsToImage, screenshotSize, type DisplayInfo, type Frame, type ImageSize, type Region } from './computer-use-geometry.js';
import { A11Y_DEFAULT_MAX_DEPTH, A11Y_PROBE_MAX_NODES, A11yError, buildTree, parseElementId, probeVerdict, type A11yBackend } from './computer-use-a11y.js';
import { selectA11yBackend } from './computer-use-a11y-select.js';
import { appMode, describeApp, findWindow, focusWindow, listWindows, readForegroundApp, windowApp, windowBounds } from './computer-use-windows.js';
import {
  MAC_TRUST_SCRIPT, buildInputCommand, macCommand, type InputAction, type InputPlatform, type SystemCommand,
} from './computer-use-input.js';

export interface ComputerUseDeps {
  platform: NodeJS.Platform;
  env: { XDG_SESSION_TYPE?: string; WAYLAND_DISPLAY?: string; DISPLAY?: string };
  /** Runs one command without a shell and rejects when it fails. */
  exec: (command: SystemCommand) => Promise<{ stdout: string }>;
  /** The primary display, or null on a machine without one. */
  display: () => DisplayInfo | null;
  /** The pointer, in screen points. */
  cursor: () => { x: number; y: number };
  /**
   * A JPEG (PNG when JPEG encoding fails) of the primary display, or of `region` of it, at exactly
   * this size, or null when the system gave an empty frame.
   */
  capture: (size: ImageSize, region?: Region) => Promise<Buffer | null>;
  /** macOS Screen Recording grant. `not-determined`: never asked yet, so asking shows the system prompt. */
  screenPermission: () => 'granted' | 'denied' | 'not-determined' | 'unknown';
  /**
   * Asks the system for the missing grant: the macOS prompt when it was never asked,
   * the matching Settings pane when the person already said no. Absent where nothing can be asked.
   */
  requestPermission?: (reason: 'permission-screen' | 'permission-accessibility') => Promise<void>;
  /** The accessibility backend; the one of the platform when absent. */
  a11y?: A11yBackend;
  /** Quits and starts the app again; absent where the shell cannot (tests). */
  restart?: () => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long an agent action keeps the indicator on. */
  activeMs?: number;
  onState?: (state: { active: boolean; stopped: boolean }) => void;
}

/** One prerequisite as the setup card shows it. `unsupported`: nothing the person can do on this machine. */
export type ComputerCheck = 'ok' | 'missing' | 'unsupported';

export interface ComputerChecks {
  desktop: ComputerCheck;
  /** macOS Accessibility grant. */
  accessibility?: ComputerCheck;
  /** macOS Screen Recording grant. */
  screen?: ComputerCheck;
  /** `osascript` on macOS, `xdotool` on Linux. */
  inputTool?: ComputerCheck;
  /** Linux: an X11 session (Wayland is `unsupported`). */
  session?: ComputerCheck;
  /** The accessibility tree. Optional: without it the agent works from screenshots. */
  a11y?: ComputerCheck;
}

export interface ComputerStatus {
  platform: string;
  available: boolean;
  reason?: ComputerUnavailableReason;
  display: { width: number; height: number; scaleFactor: number };
  active: boolean;
  stopped: boolean;
  checks: ComputerChecks;
  /** macOS: Screen Recording was granted while the app ran, and captures stay empty until it restarts. */
  needsRestart: boolean;
}

interface Probe { reason: ComputerUnavailableReason | null; checks: ComputerChecks }

const PROBE_TTL_MS = 3000;
/** One system prompt per missing grant and per minute: an agent retrying must not stack dialogs. */
const PERMISSION_ASK_INTERVAL_MS = 60_000;
const INPUT_TIMEOUT_NOTE = 'Input command failed.';
/**
 * What acts on the screen with the keyboard or the mouse: refused unless the foreground application is
 * on the agent's list. screenshot, list_windows and wait stay open (the capture shows the whole screen).
 */
/** What a background agent may not do: they use the screen, the mouse, the keyboard or the focus of the user. */
// What takes the user's screen, mouse or keyboard: the application in front must be allowed in the foreground mode.
// `focus_window` is judged on the window it targets, in `focus`.
const FOREGROUND_GATED = new Set(['screenshot', 'cursor_position', 'click', 'double_click', 'move', 'drag', 'type', 'key', 'scroll']);

export class ComputerUseService {
  private stopped = false;
  private lastAgentAt = 0;
  private activeTimer: NodeJS.Timeout | null = null;
  private frame: Frame | null = null;
  private probe: ({ at: number } & Probe) | null = null;
  private screenWasMissing = false;
  private queue: Promise<unknown> = Promise.resolve();
  private reported = { active: false, stopped: false };
  private asked = new Map<string, number>();

  private readonly a11y: A11yBackend;

  constructor(private readonly deps: ComputerUseDeps) {
    this.a11y = deps.a11y ?? selectA11yBackend(deps.platform, deps.exec);
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  private get activeMs(): number { return this.deps.activeMs ?? 8000; }
  get isStopped(): boolean { return this.stopped; }
  get isActive(): boolean { return !this.stopped && this.lastAgentAt > 0 && this.now() - this.lastAgentAt < this.activeMs; }

  /** Pushes the state to the indicator when it changed. */
  private publish(): void {
    const state = { active: this.isActive, stopped: this.stopped };
    if (state.active === this.reported.active && state.stopped === this.reported.stopped) return;
    this.reported = state;
    this.deps.onState?.(state);
  }

  private touch(): void {
    this.lastAgentAt = this.now();
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = setTimeout(() => { this.activeTimer = null; this.publish(); }, this.activeMs + 50);
    this.activeTimer.unref();
    this.publish();
  }

  /** Called by the global shortcut and the indicator's button: same effect as the `stop` command. */
  stop(): void {
    this.stopped = true;
    if (this.activeTimer) { clearTimeout(this.activeTimer); this.activeTimer = null; }
    this.publish();
  }

  resume(): void {
    this.stopped = false;
    this.lastAgentAt = 0;
    this.publish();
  }

  dispose(): void {
    if (this.activeTimer) clearTimeout(this.activeTimer);
    this.activeTimer = null;
  }

  private async probed(): Promise<Probe> {
    if (this.probe && this.now() - this.probe.at < PROBE_TTL_MS) return this.probe;
    const result = await this.probeSystem();
    this.probe = { at: this.now(), ...result };
    return this.probe;
  }

  private async unavailableReason(): Promise<ComputerUnavailableReason | null> {
    return (await this.probed()).reason;
  }

  /** Every prerequisite is checked, not only the first one missing: the setup card lists them all. */
  private async probeSystem(): Promise<Probe> {
    const probe = await this.probePlatform();
    // Never a reason to refuse the other commands: the screen and the input work without the tree.
    try { probe.checks.a11y = await this.a11y.probe(); } catch { probe.checks.a11y = 'missing'; }
    return probe;
  }

  private async probePlatform(): Promise<Probe> {
    const { platform, env } = this.deps;
    const checks: ComputerChecks = { desktop: this.deps.display() === null ? 'missing' : 'ok' };
    if (platform === 'darwin') {
      const screen = this.deps.screenPermission();
      checks.screen = screen === 'granted' || screen === 'unknown' ? 'ok' : 'missing';
      if (checks.screen === 'missing') this.screenWasMissing = true;
      checks.inputTool = 'ok';
      try {
        const out = await this.deps.exec(macCommand(MAC_TRUST_SCRIPT));
        checks.accessibility = out.stdout.trim() === 'true' ? 'ok' : 'missing';
      } catch { checks.inputTool = 'missing'; checks.accessibility = 'missing'; }
      const reason = checks.desktop === 'missing' ? 'no-desktop'
        : checks.screen === 'missing' ? 'permission-screen'
        : checks.inputTool === 'missing' ? 'no-input-tool'
        : checks.accessibility === 'missing' ? 'permission-accessibility' : null;
      return { reason, checks };
    }
    if (platform === 'win32') return { reason: checks.desktop === 'missing' ? 'no-desktop' : null, checks };
    if (platform === 'linux') {
      // Under Wayland, DISPLAY (XWayland) can be set too, and xdotool then only reaches X11 windows:
      // a launcher that drops XDG_SESSION_TYPE must not make the session look like X11.
      const wayland = env.XDG_SESSION_TYPE === 'wayland' || (!!env.WAYLAND_DISPLAY && env.XDG_SESSION_TYPE !== 'x11');
      checks.session = wayland ? 'unsupported' : env.DISPLAY ? 'ok' : 'missing';
      checks.inputTool = 'missing';
      if (checks.session === 'ok') {
        try { await this.deps.exec({ file: 'xdotool', args: ['version'] }); checks.inputTool = 'ok'; } catch { /* absent */ }
      }
      const reason = checks.desktop === 'missing' ? 'no-desktop'
        : wayland ? 'wayland'
        : checks.session === 'missing' ? 'no-desktop'
        : checks.inputTool === 'missing' ? 'no-input-tool' : null;
      return { reason, checks };
    }
    return { reason: 'no-desktop', checks: { desktop: 'unsupported' } };
  }

  async status(): Promise<ComputerStatus> {
    const display = this.deps.display();
    const { reason, checks } = await this.probed();
    return {
      platform: this.deps.platform,
      available: reason === null,
      ...(reason ? { reason } : {}),
      display: { width: display?.width ?? 0, height: display?.height ?? 0, scaleFactor: display?.scaleFactor ?? 1 },
      active: this.isActive,
      stopped: this.stopped,
      checks,
      needsRestart: this.screenWasMissing && checks.screen === 'ok',
    };
  }

  /**
   * The person pressed "Allow": ask for every missing macOS grant now (no rate limit, a person asked).
   * Elsewhere nothing can be asked, so the status alone comes back.
   */
  private async requestPermissions(): Promise<unknown> {
    this.probe = null;
    const { checks } = await this.probed();
    const requested: Array<'permission-screen' | 'permission-accessibility'> = [];
    if (this.deps.platform === 'darwin' && this.deps.requestPermission) {
      if (checks.accessibility === 'missing' && checks.inputTool !== 'missing') requested.push('permission-accessibility');
      if (checks.screen === 'missing') requested.push('permission-screen');
      for (const reason of requested) {
        try { await this.deps.requestPermission(reason); } catch { /* the status shows what is still missing */ }
      }
    }
    this.probe = null;
    return { ...(await this.status()), requested };
  }

  /** One command at a time: two inputs interleaved would be worse than a short wait. */
  handle(actor: ComputerActor, command: ComputerCommand, allowedApps: readonly (string | AllowedApp)[] = [], mode: ComputerUseMode = 'foreground'): Promise<unknown> {
    // A bare name takes `mode`, the agent's default.
    const apps = allowedApps.map((entry): AllowedApp => (typeof entry === 'string' ? { app: entry, mode } : entry));
    const run = this.queue.then(() => this.dispatch(actor, command, apps));
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async dispatch(actor: ComputerActor, command: ComputerCommand, allowedApps: readonly AllowedApp[]): Promise<unknown> {
    if (command.command === 'status') return this.status();
    if (command.command === 'request_permissions' || command.command === 'restart_app') {
      if (actor !== 'human') throw new ComputerCommandError('Only a person can change the computer permissions or restart Timon.', 403, 'forbidden');
      if (command.command === 'request_permissions') return this.requestPermissions();
      const restart = this.deps.restart;
      if (!restart) throw new ComputerCommandError('Restarting is not available here.', 501, 'restart_unavailable');
      // After the answer left: the app quits right away.
      setTimeout(restart, 300).unref();
      return { restarting: true };
    }
    if (command.command === 'stop' || command.command === 'resume') {
      if (actor !== 'human') throw new ComputerCommandError('Only a person can stop or resume computer use.', 403, 'forbidden');
      if (command.command === 'stop') this.stop(); else this.resume();
      return { stopped: this.stopped };
    }
    if (actor === 'agent' && this.stopped) {
      throw new ComputerCommandError('Computer use was stopped by the user.', 409, 'computer_stopped');
    }
    const reason = await this.unavailableReason();
    if (reason) {
      if (reason === 'permission-screen' || reason === 'permission-accessibility') await this.askPermission(reason);
      throw new ComputerCommandError(`Computer use is unavailable: ${reason}.`, 503, 'computer_unavailable');
    }
    const display = this.deps.display();
    if (!display) throw new ComputerCommandError('Computer use is unavailable: no-desktop.', 503, 'computer_unavailable');
    if (actor === 'agent') this.touch();
    const platform = this.deps.platform as InputPlatform;
    // Everything is refused except an explicit list: what takes the screen, mouse or keyboard needs the
    // application in front allowed in the foreground mode, each application carrying its own mode.
    if (actor === 'agent' && FOREGROUND_GATED.has(command.command)) {
      await this.requireForeground(await readForegroundApp(platform, this.deps.exec), allowedApps, 'The foreground application');
    }
    if (command.command === 'a11y_probe_app' && actor !== 'human') {
      throw new ComputerCommandError('Only a person can probe an application.', 403, 'forbidden');
    }
    switch (command.command) {
      case 'list_windows': return this.windows(platform);
      case 'focus_window': return this.focus(actor, platform, command.id, allowedApps);
      case 'a11y_tree': return this.a11yTree(actor, platform, display, command, allowedApps);
      case 'a11y_action': return this.a11yAction(actor, platform, command, allowedApps, display);
      case 'a11y_probe_app': return this.probeApp(display, command.windowId);
      case 'screenshot': return this.screenshot(actor, platform, display, command, allowedApps);
      case 'cursor_position': {
        const point = this.deps.cursor();
        return pointsToImage(display, this.currentFrame(display), point.x, point.y);
      }
      case 'wait':
        await (this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(command.ms);
        return {};
      default: return this.input(display, command);
    }
  }

  private notAllowed(app: Parameters<typeof describeApp>[0], allowedApps: readonly AllowedApp[], subject = 'The foreground application'): ComputerCommandError {
    const where = app ? `${subject} is ${describeApp(app)}` : 'The foreground application could not be read';
    const why = allowedApps.length === 0 ? 'this agent has no allowed applications' : 'it is not in this agent\'s allowed applications';
    return new ComputerCommandError(`${where}, and ${why}, so this action is refused.`, 403, 'computer_app_not_allowed');
  }

  /** The application must be allowed in any mode (reading and acting through accessibility). */
  private requireAllowed(app: Parameters<typeof describeApp>[0], allowedApps: readonly AllowedApp[], subject: string): 'foreground' | 'background' {
    const mode = appMode(app, allowedApps);
    if (!mode) throw this.notAllowed(app, allowedApps, subject);
    return mode;
  }

  /** The application must be allowed in the foreground mode: a background one is told to use accessibility. */
  private async requireForeground(app: Parameters<typeof describeApp>[0], allowedApps: readonly AllowedApp[], subject: string): Promise<void> {
    const mode = this.requireAllowed(app, allowedApps, subject);
    if (mode === 'background') {
      const name = app?.name || app?.exe || app?.bundle || 'This application';
      throw new ComputerCommandError(`${name} is allowed in the background only: use a11y_tree / a11y_action. Screenshots, the mouse and the keyboard are refused for it.`, 403, 'computer_background_only');
    }
  }

  private async windows(platform: InputPlatform): Promise<unknown> {
    try { return await listWindows(platform, this.deps.exec); }
    catch { throw new ComputerCommandError('Listing the windows failed.', 502, 'windows_failed'); }
  }

  /** The accessibility check as the commands need it: a refusal, with what the person can do, when the tree cannot be read. */
  private async requireA11y(): Promise<void> {
    const check = (await this.probed()).checks.a11y;
    if (check === 'ok') return;
    throw new ComputerCommandError(`The accessibility tree is unavailable on this machine (${check ?? 'missing'}). Work from screenshots instead.`, 503, 'a11y_unavailable');
  }

  private a11yFailure(error: unknown, fallback: string): ComputerCommandError {
    if (error instanceof A11yError) {
      if (error.kind === 'stale') return new ComputerCommandError('That element or window no longer exists: read the tree again with a11y_tree.', 409, 'a11y_element_stale');
      if (error.kind === 'unsupported') {
        const possible = error.actions.length ? ` Possible actions: ${error.actions.join(', ')}.` : ' This element accepts no action.';
        return new ComputerCommandError(`That element cannot do this.${possible}`, 422, 'a11y_action_unsupported');
      }
    }
    // Never the backend's text: for set_value it could carry the value.
    return new ComputerCommandError(fallback, 502, 'a11y_failed');
  }

  private async a11yTree(
    actor: ComputerActor, platform: InputPlatform, display: DisplayInfo, command: Extract<ComputerCommand, { command: 'a11y_tree' }>, allowedApps: readonly AllowedApp[],
  ): Promise<unknown> {
    await this.requireA11y();
    let windows;
    try { windows = await listWindows(platform, this.deps.exec); }
    catch { throw new ComputerCommandError('Listing the windows failed.', 502, 'windows_failed'); }
    const info = command.windowId ? windows.find((window) => window.id === command.windowId) : windows.find((window) => window.focused);
    if (!info) throw new ComputerCommandError(command.windowId ? 'No open window has this id.' : 'No window is in front.', 404, 'window_not_found');
    let app;
    try { app = await windowApp(platform, this.deps.exec, info.id); }
    catch { throw new ComputerCommandError('Reading the windows failed.', 502, 'windows_failed'); }
    if (actor === 'agent') this.requireAllowed(app, allowedApps, 'The application of that window');
    const query = command.query?.trim().toLowerCase();
    let raw;
    try { raw = await this.a11y.tree({ windowId: info.id, maxDepth: command.maxDepth, maxNodes: command.maxNodes, ...(query ? { query } : {}) }); }
    catch (error) { throw this.a11yFailure(error, 'Reading the accessibility tree failed.'); }
    return buildTree({ id: info.id, title: info.title, app: info.app }, raw, { maxDepth: command.maxDepth, maxNodes: command.maxNodes, ...(query ? { query } : {}) }, display, this.currentFrame(display));
  }

  private async a11yAction(
    actor: ComputerActor, platform: InputPlatform, command: Extract<ComputerCommand, { command: 'a11y_action' }>, allowedApps: readonly AllowedApp[],
    display?: DisplayInfo,
  ): Promise<unknown> {
    await this.requireA11y();
    const target = parseElementId(command.id);
    if (!target) throw new ComputerCommandError('"id" must be an element id returned by a11y_tree.');
    let app;
    try { app = await windowApp(platform, this.deps.exec, target.windowId); }
    catch { throw new ComputerCommandError('Reading the windows failed.', 502, 'windows_failed'); }
    if (!app) throw this.a11yFailure(new A11yError('stale', 'No such window.'), '');
    // An application driven in the background never gets the user's focus, mouse or keyboard.
    const background = actor === 'agent' && this.requireAllowed(app, allowedApps, 'The application of that element') === 'background';
    if (background && command.action === 'focus') {
      throw new ComputerCommandError('This application is allowed in the background only: use a11y_tree and a11y_action. Focusing an element would take the user\'s focus.', 403, 'computer_background_only');
    }
    try {
      await this.a11y.act({ windowId: target.windowId, path: target.path, action: command.action, ...(command.value === undefined ? {} : { value: command.value }), ...(background ? { background: true } : {}) });
    } catch (error) {
      if (background && command.action === 'set_value' && error instanceof A11yError && error.kind === 'failed') {
        throw new ComputerCommandError('This field refused the value through accessibility, and an application allowed in the background only may not be typed into with the keyboard. Try another element, or ask the user to allow this application in the foreground mode.', 502, 'a11y_failed');
      }
      // Some toolkits refuse to write a field's text through accessibility (Chromium under Linux did,
      // CI run 46006353531): focus the element through accessibility, then select its content and type
      // the value with the keyboard. The keyboard goes to the application in front, so the allowed
      // applications are checked again on it, as for any typed text.
      if (command.action !== 'set_value' || !(error instanceof A11yError) || error.kind !== 'failed' || !display) {
        throw this.a11yFailure(error, 'The accessibility action failed.');
      }
      try { await this.a11y.act({ windowId: target.windowId, path: target.path, action: 'focus' }); }
      catch (focusError) { throw this.a11yFailure(focusError, 'The accessibility action failed.'); }
      await (this.deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(150);
      if (actor === 'agent') {
        await this.requireForeground(await readForegroundApp(platform, this.deps.exec), allowedApps, 'The foreground application');
      }
      await this.input(display, { command: 'key', keys: platform === 'darwin' ? 'cmd+a' : 'ctrl+a' });
      if ((command.value ?? '') !== '') await this.input(display, { command: 'type', text: command.value ?? '' });
      else await this.input(display, { command: 'key', keys: 'Backspace' });
      return { ok: true, via: 'keyboard' };
    }
    return { ok: true };
  }

  private async focus(actor: ComputerActor, platform: InputPlatform, id: string, allowedApps: readonly AllowedApp[]): Promise<unknown> {
    let app;
    try { app = await windowApp(platform, this.deps.exec, id); }
    catch { throw new ComputerCommandError('Reading the windows failed.', 502, 'windows_failed'); }
    if (!app) throw new ComputerCommandError('No open window has this id.', 404, 'window_not_found');
    // An agent only brings forward the windows of the applications it may drive in the foreground.
    if (actor === 'agent') await this.requireForeground(app, allowedApps, 'The application of that window');
    let focused = false;
    try { focused = await focusWindow(platform, this.deps.exec, id); }
    catch { throw new ComputerCommandError('Bringing the window forward failed.', 502, 'windows_failed'); }
    return { focused };
  }

  /** For a person adding an application: is its accessibility tree rich enough to be driven in the background? */
  private async probeApp(display: DisplayInfo, windowId: string): Promise<unknown> {
    await this.requireA11y();
    let raw;
    try { raw = await this.a11y.tree({ windowId, maxDepth: A11Y_DEFAULT_MAX_DEPTH, maxNodes: A11Y_PROBE_MAX_NODES }); }
    catch (error) { throw this.a11yFailure(error, 'Reading the accessibility tree failed.'); }
    const tree = buildTree({ id: windowId, title: '', app: '' }, raw, { maxDepth: A11Y_DEFAULT_MAX_DEPTH, maxNodes: A11Y_PROBE_MAX_NODES }, display, this.currentFrame(display));
    return probeVerdict(tree.nodes);
  }

  /**
   * The first refused action is what shows the person the system prompt: without it, a grant
   * that was never asked for stays missing and nothing tells them where to give it.
   */
  private async askPermission(reason: 'permission-screen' | 'permission-accessibility'): Promise<void> {
    const request = this.deps.requestPermission;
    if (!request) return;
    const last = this.asked.get(reason);
    if (last !== undefined && this.now() - last < PERMISSION_ASK_INTERVAL_MS) return;
    this.asked.set(reason, this.now());
    // The grant changes outside the app: probe again at the next command rather than in 3 s.
    this.probe = null;
    try { await request(reason); } catch { /* A failed prompt leaves the refusal as it is. */ }
  }

  private currentFrame(display: DisplayInfo): Frame {
    return this.frame ?? screenshotSize(display, COMPUTER_DEFAULT_MAX_WIDTH);
  }

  /**
   * The rectangle of the display a window capture shows, and the window it is. The window's application
   * must be allowed in the foreground mode, as for the screen: the capture is a crop of the screen.
   */
  private async captureWindow(
    actor: ComputerActor, platform: InputPlatform, display: DisplayInfo, windowId: string, allowedApps: readonly AllowedApp[],
  ): Promise<{ region: Region; window: { id: string; title: string; app: string } }> {
    const front = windowId === FRONT_WINDOW;
    let entry;
    try { entry = await findWindow(platform, this.deps.exec, front ? null : windowId); }
    catch { throw new ComputerCommandError('Listing the windows failed.', 502, 'windows_failed'); }
    if (!entry) throw new ComputerCommandError(front ? 'No window is in front.' : 'No open window has this id.', 404, 'window_not_found');
    if (actor === 'agent') await this.requireForeground(entry.identity, allowedApps, 'The application of that window');
    let bounds;
    try { bounds = await windowBounds(platform, this.deps.exec, entry, display.scaleFactor); }
    catch { throw new ComputerCommandError('Reading the window\'s position failed.', 502, 'windows_failed'); }
    const region = bounds ? clipToDisplay(display, bounds) : null;
    if (!region) {
      throw new ComputerCommandError('That window is minimised or not on the main screen: bring it forward with focus_window, or capture the whole screen.', 409, 'window_not_visible');
    }
    return { region, window: { id: entry.id, title: entry.title, app: entry.app } };
  }

  private async screenshot(
    actor: ComputerActor, platform: InputPlatform, display: DisplayInfo, command: Extract<ComputerCommand, { command: 'screenshot' }>, allowedApps: readonly AllowedApp[],
  ): Promise<unknown> {
    const target = command.windowId ? await this.captureWindow(actor, platform, display, command.windowId, allowedApps) : null;
    const size = screenshotSize(display, command.maxWidth, target?.region);
    const png = await this.deps.capture(size, target?.region);
    if (!png || png.length === 0) throw new ComputerCommandError('Computer use is unavailable: permission-screen.', 503, 'computer_unavailable');
    // Later coordinates are expressed in this image, and in the rectangle it shows.
    this.frame = target ? { ...size, region: target.region } : size;
    // The capture is JPEG unless the encoder fell back to PNG: the bytes say which.
    const mimeType = png[0] === 0xff && png[1] === 0xd8 ? 'image/jpeg' : 'image/png';
    return { mimeType, data: png.toString('base64'), width: size.width, height: size.height, ...(target ? { window: target.window } : {}) };
  }

  private async input(display: DisplayInfo, command: ComputerCommand): Promise<unknown> {
    const frame = this.currentFrame(display);
    const point = (x: number, y: number) => imageToPoints(display, frame, x, y);
    let action: InputAction;
    switch (command.command) {
      case 'move': action = { kind: 'move', ...point(command.x, command.y) }; break;
      case 'click': action = { kind: 'click', ...point(command.x, command.y), button: command.button, count: 1 }; break;
      case 'double_click': action = { kind: 'click', ...point(command.x, command.y), button: 'left', count: 2 }; break;
      case 'drag': {
        const from = point(command.fromX, command.fromY);
        const to = point(command.toX, command.toY);
        action = { kind: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y };
        break;
      }
      case 'type': action = { kind: 'type', text: command.text }; break;
      case 'key': action = { kind: 'key', keys: command.keys }; break;
      case 'scroll': action = { kind: 'scroll', ...point(command.x, command.y), deltaX: command.deltaX, deltaY: command.deltaY }; break;
      default: throw new ComputerCommandError('Unknown computer command.', 404, 'unknown_command');
    }
    const system = buildInputCommand(this.deps.platform as InputPlatform, action, display);
    try {
      await this.deps.exec(system);
    } catch {
      // Never echo the error: for `type` it could carry the text.
      throw new ComputerCommandError(INPUT_TIMEOUT_NOTE, 502, 'input_failed');
    }
    return {};
  }
}
