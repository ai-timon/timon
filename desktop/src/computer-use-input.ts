/**
 * Synthetic input as a list of system commands, one generator per platform.
 *
 * Nothing here runs anything: each builder returns `{ file, args, env? }` for an injected executor.
 * Nothing typed or clicked is ever spliced into a script. The macOS and Windows scripts are fixed
 * text that read their steps as JSON (an argument, an environment variable), and the Linux command
 * is an argv array behind `--`. That is what keeps `type { text }` from becoming code.
 */
import { WINDOWS_UIA_LIB } from './computer-use-a11y-win32-script.js';
import { ComputerCommandError, type MouseButton } from './computer-use-protocol.js';
import type { DisplayInfo } from './computer-use-geometry.js';
import { pointerPath, type PointerPath } from './computer-use-pointer.js';

export interface SystemCommand {
  file: string;
  args: string[];
  env?: Record<string, string>;
  /**
   * The same work for a long-lived process that reads one request per line: `args` start it once
   * (the expensive part happens there), `input` is this request. An executor that has no such
   * process runs `file` and `args` as a plain one-shot command, which does the same thing.
   */
  worker?: { args: string[]; input: string; /** Environment of the long-lived process (the script of a Windows worker travels there). */ env?: Record<string, string>; /** The worker's answer line is the result (stdout), not just "ok". */ reply?: boolean };
}
export type InputPlatform = 'darwin' | 'win32' | 'linux';

export type InputAction =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: MouseButton; count: 1 | 2 }
  | { kind: 'drag'; fromX: number; fromY: number; toX: number; toY: number }
  | { kind: 'type'; text: string }
  | { kind: 'key'; keys: string }
  | { kind: 'scroll'; x: number; y: number; deltaX: number; deltaY: number };

/**
 * Where the pointer is before a `move` or a `click` and how long it takes to reach the target, in
 * the same points as the action. Absent: the pointer jumps, as it always did.
 */
export interface PointerMotion { fromX: number; fromY: number; durationMs: number }

/** The glide of an action, or nothing for the actions that do not take one. */
function glideOf(action: InputAction, motion: PointerMotion | undefined): PointerPath {
  if (!motion || (action.kind !== 'move' && action.kind !== 'click')) return { points: [], stepMs: 0 };
  return pointerPath(motion.fromX, motion.fromY, action.x, action.y, motion.durationMs);
}

// ── Key names ──────────────────────────────────────────────────────────────

type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';
export interface ParsedKeys { modifiers: Modifier[]; key: string }

const MODIFIER_ALIASES: Record<string, Modifier> = {
  ctrl: 'ctrl', control: 'ctrl', alt: 'alt', option: 'alt', opt: 'alt', shift: 'shift',
  cmd: 'meta', command: 'meta', meta: 'meta', super: 'meta', win: 'meta', windows: 'meta',
};
const KEY_ALIASES: Record<string, string> = {
  return: 'enter', esc: 'escape', del: 'delete', bksp: 'backspace', ' ': 'space',
  pgup: 'pageup', page_up: 'pageup', pgdn: 'pagedown', page_down: 'pagedown',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};
const NAMED_KEYS = new Set(['enter', 'tab', 'escape', 'backspace', 'delete', 'space', 'up', 'down', 'left', 'right',
  'home', 'end', 'pageup', 'pagedown', ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const PUNCTUATION = '`-=[]\;\',./';

/** "Cmd+Shift+T" → modifiers and one key. Anything unknown is refused rather than guessed. */
export function parseKeys(input: string): ParsedKeys {
  let parts = input.split('+').map((part) => part.trim().toLowerCase());
  // A trailing "+" is the plus key itself ("ctrl++").
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts = [...parts.slice(0, -2), '+'];
  const modifiers: Modifier[] = [];
  let key: string | null = null;
  for (const raw of parts) {
    const part = raw;
    const modifier = MODIFIER_ALIASES[part];
    if (modifier) {
      if (!modifiers.includes(modifier)) modifiers.push(modifier);
      continue;
    }
    if (key !== null) throw new ComputerCommandError('Only one non-modifier key is allowed in "keys".');
    const name = KEY_ALIASES[part] ?? part;
    const valid = NAMED_KEYS.has(name) || (name.length === 1 && (/[a-z0-9]/.test(name) || PUNCTUATION.includes(name) || name === '+'));
    if (!valid) throw new ComputerCommandError(`Unsupported key "${raw.slice(0, 20)}".`);
    key = name;
  }
  if (key === null) throw new ComputerCommandError('"keys" needs a key besides the modifiers.');
  return { modifiers, key };
}

const MAC_KEYCODES: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9, b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17,
  1: 18, 2: 19, 3: 20, 4: 21, 6: 22, 5: 23, '=': 24, 9: 25, 7: 26, '-': 27, 8: 28, 0: 29, ']': 30, o: 31, u: 32,
  '[': 33, i: 34, p: 35, enter: 36, l: 37, j: 38, "'": 39, k: 40, ';': 41, '\\': 42, ',': 43, '/': 44, n: 45, m: 46,
  '.': 47, '+': 24, tab: 48, space: 49, '`': 50, backspace: 51, escape: 53, delete: 117, home: 115, end: 119, pageup: 116,
  pagedown: 121, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111,
};
// '+' is shift+'=' on a US layout.
const MAC_FLAGS: Record<Modifier, number> = { shift: 0x20000, ctrl: 0x40000, alt: 0x80000, meta: 0x100000 };
/** Virtual key codes of the left-hand modifier keys. */
const MAC_MODIFIER_KEYCODES: Record<Modifier, number> = { shift: 56, ctrl: 59, alt: 58, meta: 55 };

const WIN_VK: Record<string, number> = {
  enter: 0x0d, tab: 0x09, escape: 0x1b, backspace: 0x08, delete: 0x2e, space: 0x20, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22, ';': 0xba, '=': 0xbb, ',': 0xbc, '-': 0xbd, '.': 0xbe, '/': 0xbf,
  '`': 0xc0, '[': 0xdb, '\\': 0xdc, ']': 0xdd, "'": 0xde, '+': 0xbb,
};
const WIN_MODIFIER_VK: Record<Modifier, number> = { shift: 0x10, ctrl: 0x11, alt: 0x12, meta: 0x5b };

function windowsVirtualKey(key: string): number {
  if (/^[a-z]$/.test(key)) return key.toUpperCase().charCodeAt(0);
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
  const fn = /^f(\d{1,2})$/.exec(key);
  if (fn) return 0x6f + Number(fn[1]);
  const code = WIN_VK[key];
  if (code === undefined) throw new ComputerCommandError(`Unsupported key "${key}".`);
  return code;
}

const XDO_KEYS: Record<string, string> = {
  enter: 'Return', tab: 'Tab', escape: 'Escape', backspace: 'BackSpace', delete: 'Delete', space: 'space',
  up: 'Up', down: 'Down', left: 'Left', right: 'Right', home: 'Home', end: 'End', pageup: 'Prior', pagedown: 'Next',
  '`': 'grave', '-': 'minus', '=': 'equal', '[': 'bracketleft', ']': 'bracketright', '\\': 'backslash',
  ';': 'semicolon', "'": 'apostrophe', ',': 'comma', '.': 'period', '/': 'slash', '+': 'plus',
};
const XDO_MODIFIERS: Record<Modifier, string> = { ctrl: 'ctrl', alt: 'alt', shift: 'shift', meta: 'super' };

function xdotoolKey(key: string): string {
  return XDO_KEYS[key] ?? (/^f\d{1,2}$/.test(key) ? key.toUpperCase() : key);
}

// ── macOS: JXA + CGEvent ───────────────────────────────────────────────────

/** Fixed text. The steps arrive as JSON in argv[0]; nothing of them is ever evaluated. */
export const MAC_INPUT_SCRIPT = `
ObjC.import('CoreGraphics');
ObjC.import('Foundation');
function post(event) { $.CGEventPost($.kCGHIDEventTap, event); }
function pause(ms) { $.NSThread.sleepForTimeInterval(ms / 1000); }
const MOUSE = {
  left: { down: $.kCGEventLeftMouseDown, up: $.kCGEventLeftMouseUp, drag: $.kCGEventLeftMouseDragged, button: $.kCGMouseButtonLeft },
  right: { down: $.kCGEventRightMouseDown, up: $.kCGEventRightMouseUp, drag: $.kCGEventRightMouseDragged, button: $.kCGMouseButtonRight },
  middle: { down: $.kCGEventOtherMouseDown, up: $.kCGEventOtherMouseUp, drag: $.kCGEventOtherMouseDragged, button: $.kCGMouseButtonCenter },
};
function mouse(type, x, y, button, clickState) {
  const event = $.CGEventCreateMouseEvent($(), type, $.CGPointMake(x, y), button);
  if (clickState) $.CGEventSetIntegerValueField(event, $.kCGMouseEventClickState, clickState);
  post(event);
}
function run(argv) {
  const steps = JSON.parse(argv[0]);
  const events = Application('System Events');
  let x = 0, y = 0;
  for (const step of steps) {
    if (step.t === 'move') { x = step.x; y = step.y; mouse($.kCGEventMouseMoved, x, y, 0); }
    else if (step.t === 'down') mouse(MOUSE[step.b].down, x, y, MOUSE[step.b].button, step.n);
    else if (step.t === 'up') mouse(MOUSE[step.b].up, x, y, MOUSE[step.b].button, step.n);
    else if (step.t === 'drag') { x = step.x; y = step.y; mouse(MOUSE.left.drag, x, y, MOUSE.left.button); }
    else if (step.t === 'wheel') post($.CGEventCreateScrollWheelEvent2($(), $.kCGScrollEventUnitLine, 2, step.dy, step.dx, 0));
    else if (step.t === 'key') {
      const event = $.CGEventCreateKeyboardEvent($(), step.code, step.down);
      $.CGEventSetFlags(event, step.flags);
      post(event);
    }
    else if (step.t === 'text') events.keystroke(step.s);
    else if (step.t === 'keycode') events.keyCode(step.code);
    else if (step.t === 'sleep') pause(step.ms);
  }
  return 'ok';
}
`.trim();

/** Reads the Accessibility grant of the process that runs the script. Prints "true" or "false". */
export const MAC_TRUST_SCRIPT = `
ObjC.import('ApplicationServices');
function run() { return $.AXIsProcessTrusted() ? 'true' : 'false'; }
`.trim();

/** `osascript` with a fixed script; the payload, when there is one, is a single JSON argument. */
export function macCommand(script: string, payload?: unknown): SystemCommand {
  return { file: 'osascript', args: ['-l', 'JavaScript', '-e', script, ...(payload === undefined ? [] : [JSON.stringify(payload)])] };
}

type MacStep =
  | { t: 'move' | 'drag'; x: number; y: number }
  | { t: 'down' | 'up'; b: MouseButton; n: number }
  | { t: 'wheel'; dx: number; dy: number }
  | { t: 'key'; code: number; flags: number; down: boolean }
  | { t: 'text'; s: string } | { t: 'keycode'; code: number } | { t: 'sleep'; ms: number };

/** Pieces of text are typed by System Events; line breaks and tabs are real key presses. */
function splitText(text: string): Array<{ text: string } | { control: 'enter' | 'tab' }> {
  const out: Array<{ text: string } | { control: 'enter' | 'tab' }> = [];
  for (const piece of text.split(/(\r\n|\n|\r|\t)/)) {
    if (piece === '') continue;
    if (piece === '\t') out.push({ control: 'tab' });
    else if (piece === '\n' || piece === '\r' || piece === '\r\n') out.push({ control: 'enter' });
    else out.push({ text: piece });
  }
  return out;
}

function macSteps(action: InputAction, glide: PointerPath): MacStep[] {
  const approach = glide.points.flatMap((point): MacStep[] => [{ t: 'move', x: point.x, y: point.y }, { t: 'sleep', ms: glide.stepMs }]);
  return [...approach, ...macActionSteps(action)];
}

function macActionSteps(action: InputAction): MacStep[] {
  switch (action.kind) {
    case 'move': return [{ t: 'move', x: action.x, y: action.y }];
    case 'click': {
      const steps: MacStep[] = [{ t: 'move', x: action.x, y: action.y }];
      for (let n = 1; n <= action.count; n++) {
        steps.push({ t: 'down', b: action.button, n }, { t: 'up', b: action.button, n });
        if (n < action.count) steps.push({ t: 'sleep', ms: 40 });
      }
      return steps;
    }
    case 'drag': {
      const steps: MacStep[] = [{ t: 'move', x: action.fromX, y: action.fromY }, { t: 'down', b: 'left', n: 1 }, { t: 'sleep', ms: 60 }];
      for (let i = 1; i <= 8; i++) {
        steps.push({ t: 'drag', x: action.fromX + (action.toX - action.fromX) * i / 8, y: action.fromY + (action.toY - action.fromY) * i / 8 }, { t: 'sleep', ms: 15 });
      }
      steps.push({ t: 'up', b: 'left', n: 1 });
      return steps;
    }
    case 'type':
      return splitText(action.text).map((piece): MacStep => 'text' in piece ? { t: 'text', s: piece.text } : { t: 'keycode', code: MAC_KEYCODES[piece.control]! });
    case 'key': {
      const { modifiers, key } = parseKeys(action.keys);
      const code = MAC_KEYCODES[key];
      if (code === undefined) throw new ComputerCommandError(`Unsupported key "${key}".`);
      const held: Modifier[] = key === '+' && !modifiers.includes('shift') ? [...modifiers, 'shift'] : [...modifiers];
      // A flag alone is not a pressed key: Spotlight and Chromium ignore ⌘A unless ⌘ itself goes down first.
      const steps: MacStep[] = [];
      let flags = 0;
      for (const modifier of held) {
        flags |= MAC_FLAGS[modifier];
        steps.push({ t: 'key', code: MAC_MODIFIER_KEYCODES[modifier], flags, down: true });
      }
      steps.push({ t: 'key', code, flags, down: true }, { t: 'key', code, flags, down: false });
      for (const modifier of [...held].reverse()) {
        flags &= ~MAC_FLAGS[modifier];
        steps.push({ t: 'key', code: MAC_MODIFIER_KEYCODES[modifier], flags, down: false });
      }
      return steps;
    }
    case 'scroll':
      // DOM convention (positive = down) in, wheel convention (positive = up) out.
      return [{ t: 'move', x: action.x, y: action.y }, { t: 'wheel', dx: -Math.round(action.deltaX), dy: -Math.round(action.deltaY) }];
  }
}

// ── Windows: PowerShell + SendInput ────────────────────────────────────────

/**
 * Fixed text, shared by the one-shot and the persistent forms. Compiling the C# helper is what costs
 * (hundreds of milliseconds per `powershell.exe`), so the persistent form does it once.
 */
const WINDOWS_INPUT_LIB = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class TimonInput {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
  static void Send(INPUT input) {
    if (SendInput(1, new INPUT[] { input }, Marshal.SizeOf(typeof(INPUT))) != 1) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
  }
  public static void Mouse(int dx, int dy, int data, uint flags) {
    INPUT i = new INPUT(); i.type = 0; i.u.mi.dx = dx; i.u.mi.dy = dy; i.u.mi.mouseData = unchecked((uint)data); i.u.mi.dwFlags = flags; Send(i);
  }
  public static void Key(ushort vk, ushort scan, uint flags) {
    INPUT i = new INPUT(); i.type = 1; i.u.ki.wVk = vk; i.u.ki.wScan = scan; i.u.ki.dwFlags = flags; Send(i);
  }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int max);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr l);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static long Foreground() { return GetForegroundWindow().ToInt64(); }
  public static uint Pid(long h) { uint pid; GetWindowThreadProcessId(new IntPtr(h), out pid); return pid; }
  public static string Title(long h) {
    StringBuilder s = new StringBuilder(512); GetWindowText(new IntPtr(h), s, s.Capacity); return s.ToString();
  }
  public static long[] Visible() {
    List<long> list = new List<long>();
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (IsWindowVisible(h) && GetWindowTextLength(h) > 0) list.Add(h.ToInt64());
      return true;
    }, IntPtr.Zero);
    return list.ToArray();
  }
  public static bool Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return false;
    if (IsIconic(h)) ShowWindow(h, 9);
    // Windows refuses SetForegroundWindow to a process that did not receive the last input: a bare Alt press lifts that lock.
    keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetForegroundWindow(h);
    return GetForegroundWindow() == h;
  }
}
"@
$buttons = @{ left = @(0x2, 0x4); right = @(0x8, 0x10); middle = @(0x20, 0x40) }
function Invoke-TimonSteps($steps) {
  $ax = 0; $ay = 0
  foreach ($s in $steps) {
    switch ($s.t) {
      'move' { $ax = [int]$s.x; $ay = [int]$s.y; [TimonInput]::Mouse($ax, $ay, 0, 0x8001) }
      'down' { [TimonInput]::Mouse($ax, $ay, 0, [uint32](0x8000 -bor $buttons[$s.b][0])) }
      'up' { [TimonInput]::Mouse($ax, $ay, 0, [uint32](0x8000 -bor $buttons[$s.b][1])) }
      'wheel' {
        if ($s.dy -ne 0) { [TimonInput]::Mouse(0, 0, [int]$s.dy, 0x800) }
        if ($s.dx -ne 0) { [TimonInput]::Mouse(0, 0, [int]$s.dx, 0x1000) }
      }
      'key' { [TimonInput]::Key([uint16]$s.vk, 0, $(if ($s.up) { 2 } else { 0 })) }
      'unicode' { [TimonInput]::Key(0, [uint16]$s.unit, $(if ($s.up) { 6 } else { 4 })) }
      'sleep' { Start-Sleep -Milliseconds ([int]$s.ms) }
    }
  }
}
function Get-TimonApp([long]$h) {
  $name = ''; $exe = ''
  try {
    $p = Get-Process -Id ([TimonInput]::Pid($h)) -ErrorAction Stop
    $exe = $p.ProcessName; $name = $exe
    try { if ($p.MainModule.FileVersionInfo.FileDescription) { $name = $p.MainModule.FileVersionInfo.FileDescription } } catch { }
  } catch { }
  @{ name = $name; exe = $exe }
}
${WINDOWS_UIA_LIB}
function Invoke-TimonQuery($q) {
  $result = $null
  switch ($q.q) {
    'foreground' { $result = Get-TimonApp ([TimonInput]::Foreground()) }
    'windows' {
      $fg = [TimonInput]::Foreground()
      $result = @(foreach ($h in [TimonInput]::Visible()) { $a = Get-TimonApp $h; @{ id = [string]$h; title = [TimonInput]::Title($h); app = $a.name; exe = $a.exe; focused = ($h -eq $fg) } })
    }
    'focus' { $result = @{ ok = [TimonInput]::Focus([long]$q.id) } }
    'a11y_probe' { try { Initialize-TimonUia; $result = @{ ok = $true } } catch { $result = @{ ok = $false } } }
    'a11y_tree' { $result = Invoke-TimonUiaTree $q }
    'a11y_act' { $result = Invoke-TimonUiaAct $q }
  }
  $json = ConvertTo-Json -InputObject $result -Compress -Depth 6
  if ($null -eq $json) { $json = 'null' }
  # ASCII only on the wire: the console code page must not alter a title. A plain loop: Windows
  # PowerShell 5.1 does not bind a script block to [regex]::Replace (MethodInvocationException, CI run 45988561718).
  $sb = New-Object System.Text.StringBuilder
  foreach ($c in $json.ToCharArray()) { if ([int]$c -gt 127) { [void]$sb.AppendFormat('\\u{0:x4}', [int]$c) } else { [void]$sb.Append($c) } }
  $sb.ToString()
}
`.trim();

/** One-shot form: the steps arrive as JSON in TIMON_CU_STEPS. */
export const WINDOWS_INPUT_SCRIPT = `${WINDOWS_INPUT_LIB}
Invoke-TimonSteps ($env:TIMON_CU_STEPS | ConvertFrom-Json)
`;

/**
 * Persistent form: one JSON array of steps per line on stdin, answered by one line, "ok" or "error".
 * The steps hold numbers and ASCII only (typed text is sent as UTF-16 unit numbers), so the console
 * code page cannot alter them, and nothing read here is ever evaluated as code.
 */
export const WINDOWS_WORKER_SCRIPT = `${WINDOWS_INPUT_LIB}
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  try {
    $request = $line | ConvertFrom-Json
    # An array of steps is input. Testing \$request.q on it would enumerate its members: an array
    # of nulls, which PowerShell reads as true, so every click was taken for a query (CI run 45989910875).
    if ($request -isnot [System.Array] -and $null -ne $request.q) { [Console]::Out.WriteLine((Invoke-TimonQuery $request)) }
    else { Invoke-TimonSteps $request; [Console]::Out.WriteLine('ok') }
  } catch {
    # Diagnostic mode only: where it failed and which kind of error, never the request or the message
    # (a parse error can quote typed text). The Win32 message is the one safe exception.
    if ($env:TIMON_COMPUTER_USE_DEBUG -eq '1') {
      $detail = $_.Exception.GetType().FullName + ' at line ' + $_.InvocationInfo.ScriptLineNumber + ': ' + $_.InvocationInfo.Line.Trim()
      if ($_.Exception -is [System.ComponentModel.Win32Exception]) { $detail += ' / ' + $_.Exception.Message }
      [Console]::Error.WriteLine('computer-use worker: ' + $detail)
    }
    [Console]::Out.WriteLine('error')
  }
}
`;

type WinStep =
  | { t: 'move'; x: number; y: number } | { t: 'down' | 'up'; b: MouseButton }
  | { t: 'wheel'; dx: number; dy: number } | { t: 'key'; vk: number; up: boolean }
  | { t: 'unicode'; unit: number; up: boolean } | { t: 'sleep'; ms: number };

/**
 * Screen points → SendInput absolute coordinates (0..65535 over the primary monitor). Windows maps
 * them back as floor(value × physicalSize / 65536), so the point goes through the physical pixel
 * first (points × scaleFactor, as Electron reports them) and is rounded up to land inside it:
 * a plain ratio drifts by a pixel or two on 125 % and 150 % displays.
 */
const normalize = (value: number, points: number, scaleFactor: number): number => {
  const physical = Math.max(1, Math.round(points * scaleFactor));
  const pixel = Math.min(Math.max(Math.round(value * scaleFactor), 0), physical - 1);
  return Math.min(65535, Math.ceil(pixel * 65536 / physical));
};

function windowsSteps(action: InputAction, display: DisplayInfo, glide: PointerPath): WinStep[] {
  const at = (x: number, y: number): WinStep => ({ t: 'move', x: normalize(x, display.width, display.scaleFactor), y: normalize(y, display.height, display.scaleFactor) });
  const approach = glide.points.flatMap((point): WinStep[] => [at(point.x, point.y), { t: 'sleep', ms: glide.stepMs }]);
  return [...approach, ...windowsActionSteps(action, at)];
}

function windowsActionSteps(action: InputAction, at: (x: number, y: number) => WinStep): WinStep[] {
  switch (action.kind) {
    case 'move': return [at(action.x, action.y)];
    case 'click': {
      const steps: WinStep[] = [at(action.x, action.y)];
      for (let n = 0; n < action.count; n++) {
        steps.push({ t: 'down', b: action.button }, { t: 'up', b: action.button });
        if (n + 1 < action.count) steps.push({ t: 'sleep', ms: 40 });
      }
      return steps;
    }
    case 'drag': {
      const steps: WinStep[] = [at(action.fromX, action.fromY), { t: 'down', b: 'left' }, { t: 'sleep', ms: 60 }];
      for (let i = 1; i <= 8; i++) steps.push(at(action.fromX + (action.toX - action.fromX) * i / 8, action.fromY + (action.toY - action.fromY) * i / 8), { t: 'sleep', ms: 15 });
      steps.push({ t: 'up', b: 'left' });
      return steps;
    }
    case 'type': {
      const steps: WinStep[] = [];
      for (const piece of splitText(action.text)) {
        if ('control' in piece) {
          const vk = windowsVirtualKey(piece.control);
          steps.push({ t: 'key', vk, up: false }, { t: 'key', vk, up: true });
          continue;
        }
        // One UTF-16 unit at a time: surrogate pairs are sent as two units, as Windows expects.
        for (let i = 0; i < piece.text.length; i++) {
          const unit = piece.text.charCodeAt(i);
          steps.push({ t: 'unicode', unit, up: false }, { t: 'unicode', unit, up: true });
        }
      }
      return steps;
    }
    case 'key': {
      const { modifiers, key } = parseKeys(action.keys);
      const mods = key === '+' && !modifiers.includes('shift') ? [...modifiers, 'shift' as const] : modifiers;
      const vk = windowsVirtualKey(key);
      return [
        ...mods.map((m): WinStep => ({ t: 'key', vk: WIN_MODIFIER_VK[m], up: false })),
        { t: 'key', vk, up: false }, { t: 'key', vk, up: true },
        ...[...mods].reverse().map((m): WinStep => ({ t: 'key', vk: WIN_MODIFIER_VK[m], up: true })),
      ];
    }
    case 'scroll':
      return [at(action.x, action.y), { t: 'wheel', dx: Math.round(action.deltaX) * 120, dy: -Math.round(action.deltaY) * 120 }];
  }
}

/** One-shot form of a query: the request arrives as JSON in TIMON_CU_QUERY and the answer is printed. */
export const WINDOWS_QUERY_SCRIPT = `${WINDOWS_INPUT_LIB}
Write-Output (Invoke-TimonQuery ($env:TIMON_CU_QUERY | ConvertFrom-Json))
`;

export type WindowsQuery =
  | { q: 'foreground' } | { q: 'windows' } | { q: 'focus'; id: string }
  | { q: 'a11y_probe' }
  | { q: 'a11y_tree'; id: string; maxDepth: number; maxNodes: number }
  | { q: 'a11y_act'; id: string; path: string; action: string; value?: string; background?: boolean };

/** A read of the window system, answered as one JSON line, by the same worker as the input. */
export function windowsQueryCommand(query: WindowsQuery): SystemCommand {
  const json = JSON.stringify(query);
  return {
    file: 'powershell.exe',
    args: powershellArgs(),
    env: { TIMON_CU_SCRIPT: WINDOWS_QUERY_SCRIPT, TIMON_CU_QUERY: json },
    worker: { args: powershellArgs(), env: { TIMON_CU_SCRIPT: WINDOWS_WORKER_SCRIPT }, input: json, reply: true },
  };
}

/**
 * The scripts are too long for a command line: Windows caps it at 32 767 characters and the
 * UTF-16 base64 of the UI Automation worker is about 43 000, so the process never started and
 * nothing said why (CI run 45996549913). The fixed script travels in TIMON_CU_SCRIPT (an
 * environment variable holds up to 32 767 characters) and a short -EncodedCommand evaluates it.
 * -EncodedCommand is UTF-16LE base64: no quoting layer between us and PowerShell.
 */
const POWERSHELL_BOOTSTRAP = 'Invoke-Expression $env:TIMON_CU_SCRIPT';
function powershellArgs(): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(POWERSHELL_BOOTSTRAP, 'utf16le').toString('base64')];
}

function windowsCommand(steps: WinStep[]): SystemCommand {
  const json = JSON.stringify(steps);
  return {
    file: 'powershell.exe',
    args: powershellArgs(),
    env: { TIMON_CU_SCRIPT: WINDOWS_INPUT_SCRIPT, TIMON_CU_STEPS: json },
    worker: { args: powershellArgs(), env: { TIMON_CU_SCRIPT: WINDOWS_WORKER_SCRIPT }, input: json },
  };
}

// ── Linux: xdotool under X11 ───────────────────────────────────────────────

function linuxCommand(action: InputAction, display: DisplayInfo, glide: PointerPath): SystemCommand {
  const px = (value: number, origin: number | undefined): string => String(Math.round(((origin ?? 0) + value) * display.scaleFactor));
  const px2 = (x: number, y: number): string[] => [px(x, display.originX), px(y, display.originY)];
  const button = (name: MouseButton): string => name === 'left' ? '1' : name === 'middle' ? '2' : '3';
  const args: string[] = [];
  // xdotool chains its commands in one process; its `sleep` takes seconds, read with the C locale's dot
  // (libxdo only sets LC_CTYPE, so a French session does not turn "0.017" into 0).
  const pause = (glide.stepMs / 1000).toFixed(3);
  for (const point of glide.points) args.push('mousemove', ...px2(point.x, point.y), 'sleep', pause);
  switch (action.kind) {
    case 'move': args.push('mousemove', ...px2(action.x, action.y)); break;
    case 'click':
      args.push('mousemove', ...px2(action.x, action.y), 'click', '--repeat', String(action.count), '--delay', '40', button(action.button));
      break;
    case 'drag':
      args.push('mousemove', ...px2(action.fromX, action.fromY), 'mousedown', '1', 'mousemove', ...px2(action.toX, action.toY), 'mouseup', '1');
      break;
    case 'type': args.push('type', '--clearmodifiers', '--delay', '8', '--', action.text); break;
    case 'key': {
      const { modifiers, key } = parseKeys(action.keys);
      args.push('key', '--clearmodifiers', '--', [...modifiers.map((m) => XDO_MODIFIERS[m]), xdotoolKey(key)].join('+'));
      break;
    }
    case 'scroll': {
      args.push('mousemove', ...px2(action.x, action.y));
      const vertical = Math.min(Math.abs(Math.round(action.deltaY)), 100);
      const horizontal = Math.min(Math.abs(Math.round(action.deltaX)), 100);
      if (vertical > 0) args.push('click', '--repeat', String(vertical), action.deltaY > 0 ? '5' : '4');
      if (horizontal > 0) args.push('click', '--repeat', String(horizontal), action.deltaX > 0 ? '7' : '6');
      break;
    }
  }
  return { file: 'xdotool', args };
}

/** The single entry point: one action → the one command that performs it on this platform. */
export function buildInputCommand(platform: InputPlatform, action: InputAction, display: DisplayInfo, motion?: PointerMotion): SystemCommand {
  const glide = glideOf(action, motion);
  switch (platform) {
    case 'darwin': return macCommand(MAC_INPUT_SCRIPT, macSteps(action, glide));
    case 'win32': return windowsCommand(windowsSteps(action, display, glide));
    case 'linux': return linuxCommand(action, display, glide);
  }
}
