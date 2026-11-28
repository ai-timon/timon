/**
 * The window system, read and driven through the same injected executor as the input: which
 * application is in front, which windows are open, bringing one forward, and the list of
 * applications an agent may act in.
 *
 * Nothing here is spliced into a script: macOS and Windows run fixed text, a window id travels as
 * JSON, and Linux builds an argv array.
 */
import { macCommand, windowsQueryCommand, type InputPlatform, type SystemCommand } from './computer-use-input.js';

export type Exec = (command: SystemCommand) => Promise<{ stdout: string }>;

/** What identifies an application: every spelling the user may have put in the list. */
export interface AppIdentity {
  /** macOS bundle identifier. */
  bundle?: string;
  /** The name a person sees. */
  name: string;
  /** The executable's name. */
  exe?: string;
}

export interface WindowInfo { id: string; title: string; app: string; focused: boolean }
interface WindowEntry extends WindowInfo { identity: AppIdentity }

const MAX_WINDOWS = 60;

/**
 * JXA that picks the Accessibility window for a CGWindowNumber, shared by the focus and the a11y
 * scripts. The window server tells which windows of the application are floating (a layer above 0:
 * the computer-use banner, tooltips, palettes); those are never a target. The wanted window is found
 * by its bounds, then its title; without a match the focused window, the main window and only then
 * the first one are used, so the banner cannot be read in place of the application's own window.
 */
export const MAC_PICK_WINDOW_JS = `
function axGet(el, name) {
  const ref = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $(name), ref) !== 0 || !ref[0]) return null;
  return ObjC.castRefToObject(ref[0]);
}
function axText(el, name) {
  const v = axGet(el, name);
  if (v === null) return '';
  const u = ObjC.unwrap(v);
  return typeof u === 'string' ? u : '';
}
function axBox(el) {
  const p = axGet(el, 'AXPosition');
  const s = axGet(el, 'AXSize');
  if (p === null || s === null) return null;
  const pm = String(ObjC.unwrap(p.description)).match(/x:(-?[0-9.]+) y:(-?[0-9.]+)/);
  const sm = String(ObjC.unwrap(s.description)).match(/w:(-?[0-9.]+) h:(-?[0-9.]+)/);
  return pm && sm ? { x: Number(pm[1]), y: Number(pm[2]), w: Number(sm[1]), h: Number(sm[2]) } : null;
}
function sameBox(a, b) {
  return a !== null && b !== null && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;
}
function pickWindow(app, pid, number) {
  const infos = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || [];
  const box = (info) => info && info.kCGWindowBounds ? { x: info.kCGWindowBounds.X, y: info.kCGWindowBounds.Y, w: info.kCGWindowBounds.Width, h: info.kCGWindowBounds.Height } : null;
  const floating = infos.filter((info) => info.kCGWindowOwnerPID === pid && info.kCGWindowLayer !== 0).map(box);
  const list = axGet(app, 'AXWindows');
  const all = [];
  const count = list === null ? 0 : Number(list.count);
  for (let i = 0; i < count; i++) all.push(list.objectAtIndex(i));
  const targets = all.filter((w) => { const b = axBox(w); return !floating.some((f) => sameBox(f, b)); });
  if (targets.length === 0) return null;
  const mine = infos.find((info) => info.kCGWindowNumber === number);
  if (mine) {
    const wanted = box(mine);
    const byBox = targets.find((w) => sameBox(axBox(w), wanted));
    if (byBox) return byBox;
    if (mine.kCGWindowName) {
      const byTitle = targets.find((w) => axText(w, 'AXTitle') === mine.kCGWindowName);
      if (byTitle) return byTitle;
    }
  }
  const sameAs = (candidate) => candidate !== null && targets.find((w) => sameBox(axBox(w), axBox(candidate)) && axText(w, 'AXTitle') === axText(candidate, 'AXTitle')) || null;
  return sameAs(axGet(app, 'AXFocusedWindow')) || sameAs(axGet(app, 'AXMainWindow')) || targets[0];
}
`.trim();

// ── macOS ──────────────────────────────────────────────────────────────────

const MAC_FOREGROUND_SCRIPT = `
ObjC.import('AppKit');
function run() {
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const text = (value) => { const v = value ? ObjC.unwrap(value) : ''; return typeof v === 'string' ? v : ''; };
  return JSON.stringify({ bundle: text(app.bundleIdentifier), name: text(app.localizedName), exe: text(app.executableURL ? app.executableURL.lastPathComponent : null) });
}
`.trim();

// Both scripts avoid Apple Events (System Events), which need an Automation grant of their own:
// the list reads the window server, the focus uses AppKit and the Accessibility API the input
// already needs. Window ids are `<unix pid>:<CGWindowID>`.
const MAC_LIST_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
function run() {
  const read = (option) => ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(option, 0))) || [];
  // On-screen first; some systems report none there for a window another Space or a runner shows.
  let infos = read($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements);
  if (!infos.some((info) => info.kCGWindowLayer === 0)) infos = read($.kCGWindowListOptionAll);
  const front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const frontPid = front ? Number(front.processIdentifier) : -1;
  const out = [];
  let frontSeen = false;
  for (const info of infos) {
    if (info.kCGWindowLayer !== 0) continue;
    const pid = info.kCGWindowOwnerPID;
    const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
    const bundle = app && app.bundleIdentifier ? String(ObjC.unwrap(app.bundleIdentifier) || '') : '';
    // The window list is ordered front to back: the first window of the front application is the focused one.
    const focused = pid === frontPid && !frontSeen;
    if (focused) frontSeen = true;
    out.push({ id: pid + ':' + info.kCGWindowNumber, title: info.kCGWindowName || '', app: info.kCGWindowOwnerName || '', bundle, focused });
    if (out.length >= ${MAX_WINDOWS}) break;
  }
  return JSON.stringify(out);
}
`.trim();

const MAC_FOCUS_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('AppKit');
ObjC.import('ApplicationServices');
${MAC_PICK_WINDOW_JS}
function run(argv) {
  const [pid, number] = JSON.parse(argv[0]);
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!app) return 'gone';
  app.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);
  const window = pickWindow($.AXUIElementCreateApplication(pid), pid, number);
  if (window === null) return 'activated';
  $.AXUIElementPerformAction(window, $('AXRaise'));
  return 'raised';
}
`.trim();

// ── Parsing ────────────────────────────────────────────────────────────────

function parseJson(stdout: string): unknown {
  try { return JSON.parse(stdout.trim()); } catch { return undefined; }
}

const str = (value: unknown): string => typeof value === 'string' ? value : '';

function identityOf(value: unknown): AppIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const identity: AppIdentity = { name: str(raw.name) };
  if (str(raw.bundle)) identity.bundle = str(raw.bundle);
  if (str(raw.exe)) identity.exe = str(raw.exe);
  return identity.name || identity.bundle || identity.exe ? identity : null;
}

function entriesOf(value: unknown): WindowEntry[] {
  if (!Array.isArray(value)) return [];
  const out: WindowEntry[] = [];
  for (const item of value.slice(0, MAX_WINDOWS)) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const id = str(raw.id);
    if (!/^[A-Za-z0-9:_.-]{1,64}$/.test(id)) continue;
    const identity = identityOf({ name: raw.app, bundle: raw.bundle, exe: raw.exe });
    if (!identity) continue;
    out.push({ id, title: str(raw.title), app: identity.name || identity.exe || identity.bundle || '', focused: raw.focused === true, identity });
  }
  return out;
}

// ── Linux ──────────────────────────────────────────────────────────────────

const xdotool = (...args: string[]): SystemCommand => ({ file: 'xdotool', args });

/**
 * Commands known to be absent, per executor: a missing tool is asked once, not once per window and
 * action (xdotool 3.20160805 of Ubuntu 24.04 has no getwindowclassname, and was asked dozens of times).
 */
const missingTools = new WeakMap<Exec, Set<string>>();

/** Runs `command` unless it is known to be missing; resolves null on any failure and remembers ENOENT. */
async function tryTool(exec: Exec, command: SystemCommand): Promise<string | null> {
  let missing = missingTools.get(exec);
  if (missing?.has(command.file)) return null;
  try { return (await exec(command)).stdout; } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
      if (!missing) { missing = new Set(); missingTools.set(exec, missing); }
      missing.add(command.file);
    }
    return null;
  }
}

/** The WM_CLASS class of an X11 window ("Navigator", "Electron"): the second quoted string xprop prints. */
async function linuxClassName(exec: Exec, windowId: string): Promise<string> {
  const out = await tryTool(exec, { file: 'xprop', args: ['-id', windowId, 'WM_CLASS'] });
  const quoted = out?.match(/"([^"]*)"/g)?.map((part) => part.slice(1, -1)) ?? [];
  return quoted[1] ?? quoted[0] ?? '';
}

async function linuxIdentity(exec: Exec, windowId: string): Promise<AppIdentity | null> {
  let pid = '';
  try { pid = (await exec(xdotool('getwindowpid', windowId))).stdout.trim(); } catch { /* no pid: the class may still name it */ }
  // Without xprop the process name read below names the application.
  const className = await linuxClassName(exec, windowId);
  let exe = '';
  if (/^\d+$/.test(pid)) {
    // portability: Linux branch only, the same X11 session xdotool needs
    try { exe = (await exec({ file: 'ps', args: ['-p', pid, '-o', 'comm='] })).stdout.trim(); } catch { /* gone */ }
  }
  return identityOf({ name: className || exe, exe });
}

/**
 * The windows the window manager manages (_NET_CLIENT_LIST on the root window), as decimal ids like
 * xdotool's, or null when it cannot be read: no xprop, or no window manager publishing it.
 */
async function linuxClientWindows(exec: Exec): Promise<Set<string> | null> {
  const out = await tryTool(exec, { file: 'xprop', args: ['-root', '_NET_CLIENT_LIST'] });
  // "_NET_CLIENT_LIST(WINDOW): window id # 0x1e00003, 0x2400007"; without a window manager: "not found."
  const listed = out?.match(/^_NET_CLIENT_LIST\(WINDOW\): window id #(.*)$/m)?.[1];
  if (listed === undefined) return null;
  const ids = (listed.match(/0x[0-9a-fA-F]{1,8}/g) ?? []).map((hex) => String(Number.parseInt(hex, 16)));
  return ids.length ? new Set(ids) : null;
}

/**
 * Processes and classes that only draw another window's decorations. Mutter (GNOME 44+ under X11)
 * draws server-side frames from a separate client, mutter-x11-frames, whose frame windows carry the
 * client's title: listed, every decorated window came out twice. The client list already leaves them
 * out; this catches them when that list cannot be read.
 */
const FRAME_APPS = new Set(['mutter-x11-frames']);
const isFrame = (identity: AppIdentity): boolean => [identity.name, identity.exe].some((name) => !!name && FRAME_APPS.has(name.toLowerCase()));

async function linuxWindows(exec: Exec): Promise<WindowEntry[]> {
  const active = (await exec(xdotool('getactivewindow')).catch(() => ({ stdout: '' }))).stdout.trim();
  const found = await exec(xdotool('search', '--onlyvisible', '--name', '.'));
  const clients = await linuxClientWindows(exec);
  const out: WindowEntry[] = [];
  const ids = found.stdout.split('\n').map((line) => line.trim()).filter((line) => /^\d{1,20}$/.test(line));
  for (const id of ids.filter((candidate) => !clients || clients.has(candidate)).slice(0, MAX_WINDOWS)) {
    let title = '';
    try { title = (await exec(xdotool('getwindowname', id))).stdout.trim(); } catch { continue; }
    const identity = await linuxIdentity(exec, id);
    if (!identity || isFrame(identity)) continue;
    out.push({ id, title, app: identity.name || identity.exe || '', focused: id === active, identity });
  }
  return out;
}

const activeWindow = async (exec: Exec): Promise<string> => (await exec(xdotool('getactivewindow')).catch(() => ({ stdout: '' }))).stdout.trim();

/**
 * windowactivate asks the window manager (_NET_ACTIVE_WINDOW): with none running, as on a bare X
 * server, it does nothing. The fallback maps, raises and focuses the window directly. Either way the
 * result is read back, and a window that is still not active is an error, not a silent success.
 */
async function linuxFocus(exec: Exec, id: string): Promise<boolean> {
  try { await exec(xdotool('windowactivate', '--sync', id)); } catch { /* handled below */ }
  if (await activeWindow(exec) === id) return true;
  for (const step of ['windowmap', 'windowraise', 'windowfocus']) {
    try { await exec(xdotool(step, '--sync', id)); } catch { /* the check below says whether it worked */ }
  }
  if (await activeWindow(exec) === id) return true;
  throw new Error('The window did not become active.');
}

// ── Per-OS entry points ────────────────────────────────────────────────────

/** The application in front, or null when the system cannot tell. */
export async function readForegroundApp(platform: InputPlatform, exec: Exec): Promise<AppIdentity | null> {
  try {
    if (platform === 'darwin') return identityOf(parseJson((await exec(macCommand(MAC_FOREGROUND_SCRIPT))).stdout));
    if (platform === 'win32') return identityOf(parseJson((await exec(windowsQueryCommand({ q: 'foreground' }))).stdout));
    // Without a window manager there is no active window: the window holding the input focus is the next best.
    let active = (await exec(xdotool('getactivewindow')).catch(() => ({ stdout: '' }))).stdout.trim();
    if (!/^\d+$/.test(active)) active = (await exec(xdotool('getwindowfocus'))).stdout.trim();
    return /^\d+$/.test(active) ? await linuxIdentity(exec, active) : null;
  } catch (error) {
    // Diagnostic mode only: a null here becomes a refusal ("could not be read"), which said nothing about why.
    if (process.env.TIMON_COMPUTER_USE_DEBUG === '1') console.error(`[computer-use] reading the foreground application failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300)}`);
    return null;
  }
}

async function entries(platform: InputPlatform, exec: Exec): Promise<WindowEntry[]> {
  if (platform === 'darwin') {
    const { stdout } = await exec(macCommand(MAC_LIST_SCRIPT));
    // CI diagnostics only (TIMON_COMPUTER_USE_DEBUG=1): an empty list on a runner said nothing about why.
    if (process.env.TIMON_COMPUTER_USE_DEBUG === '1') console.error(`[computer-use] macOS window list: ${stdout.length} bytes: ${stdout.slice(0, 400)}`);
    return entriesOf(parseJson(stdout));
  }
  if (platform === 'win32') return entriesOf(parseJson((await exec(windowsQueryCommand({ q: 'windows' }))).stdout));
  return linuxWindows(exec);
}

/** The open windows, front to back as far as the system says. */
export async function listWindows(platform: InputPlatform, exec: Exec): Promise<WindowInfo[]> {
  return (await entries(platform, exec)).map(({ id, title, app, focused }) => ({ id, title, app, focused }));
}

/** The application owning window `id`, or null when no such window is open. */
export async function windowApp(platform: InputPlatform, exec: Exec, id: string): Promise<AppIdentity | null> {
  return (await entries(platform, exec)).find((entry) => entry.id === id)?.identity ?? null;
}

/** Brings window `id` forward. Resolves false when the system did not (Windows reports it). */
export async function focusWindow(platform: InputPlatform, exec: Exec, id: string): Promise<boolean> {
  if (platform === 'darwin') {
    const [pid, number] = id.split(':').map(Number);
    if (!Number.isInteger(pid) || !Number.isInteger(number)) return false;
    return (await exec(macCommand(MAC_FOCUS_SCRIPT, [pid, number]))).stdout.trim() !== 'gone';
  }
  if (platform === 'win32') {
    const answer = parseJson((await exec(windowsQueryCommand({ q: 'focus', id }))).stdout) as { ok?: unknown } | undefined;
    return answer?.ok === true;
  }
  return linuxFocus(exec, id);
}

// ── The allowed applications ───────────────────────────────────────────────

/** Case and a trailing ".exe" never matter: "Notepad", "notepad.exe" and "NOTEPAD.EXE" are one name. */
const normalize = (value: string): string => value.trim().toLowerCase().replace(/\.exe$/, '');

type AllowedEntry = string | { app: string; mode: 'foreground' | 'background' };

/**
 * How the list allows this application: the mode of the entries that name it (any of its three names),
 * or null when none does. An empty or absent list allows nothing. When two entries name the same
 * application with different modes, the background one wins: the stricter reading.
 */
export function appMode(app: AppIdentity | null, allowed: readonly AllowedEntry[], fallback: 'foreground' | 'background' = 'foreground'): 'foreground' | 'background' | null {
  if (!app) return null;
  const names = [app.bundle, app.name, app.exe].filter((name): name is string => !!name).map(normalize);
  let found: 'foreground' | 'background' | null = null;
  for (const entry of allowed) {
    const { app: listed, mode } = typeof entry === 'string' ? { app: entry, mode: fallback } : entry;
    const wanted = normalize(listed);
    if (!wanted || !names.includes(wanted)) continue;
    if (mode === 'background') return 'background';
    found = 'foreground';
  }
  return found;
}

/** The list is explicit: an empty or absent one allows nothing. Any of the app's three names may be listed, in any mode. */
export function isAppAllowed(app: AppIdentity | null, allowed: readonly AllowedEntry[]): boolean {
  return appMode(app, allowed) !== null;
}

/** How an application is named in a refusal: what the agent can read back into the list. */
export function describeApp(app: AppIdentity | null): string {
  if (!app) return 'unknown';
  const detail = [app.bundle, app.exe].filter((part) => part && part !== app.name);
  return `${app.name || app.exe || app.bundle}${detail.length ? ` (${detail.join(', ')})` : ''}`;
}
