/**
 * Computer use, screen side: what the daemon answers on `status`, and the
 * calls a person may make (status, stop, resume, setup).
 */

export interface ComputerStatus {
  /** An agent is controlling the mouse and keyboard right now. */
  active: boolean;
  /** The human stop is in force: agent commands are refused until a resume. */
  stopped: boolean;
}

const IDLE: ComputerStatus = { active: false, stopped: false };

/** Reads a `status` answer defensively: anything unexpected is "idle". */
export function parseComputerStatus(raw: unknown): ComputerStatus {
  if (!raw || typeof raw !== 'object') return IDLE;
  const body = raw as Record<string, unknown>;
  // The daemon may wrap the desktop's answer in `result`.
  const inner = body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : body;
  return { active: inner.active === true, stopped: inner.stopped === true };
}

/** One status poll. Desktop absent, feature off, signed out: idle, never an error. */
export async function fetchComputerStatus(): Promise<ComputerStatus> {
  try {
    const r = await fetch('/api/ui/computer/status', { cache: 'no-store' });
    if (!r.ok) return IDLE;
    return parseComputerStatus(await r.json());
  } catch {
    return IDLE;
  }
}

/** The human stop / resume. Resolves true when the daemon accepted it. */
export async function sendComputerControl(command: 'stop' | 'resume'): Promise<boolean> {
  try {
    const r = await fetch(`/api/ui/computer/${command}`, { method: 'POST' });
    return r.ok;
  } catch {
    return false;
  }
}

export type ComputerCheck = 'ok' | 'missing' | 'unsupported';
export const COMPUTER_CHECK_KEYS = ['desktop', 'accessibility', 'screen', 'inputTool', 'session', 'a11y'] as const;
export type ComputerCheckKey = (typeof COMPUTER_CHECK_KEYS)[number];

/** What the setup card shows: one entry per prerequisite the desktop reported. */
export interface ComputerSetup {
  /** The desktop app answered. False in a browser, or when the app is closed. */
  reachable: boolean;
  platform: string;
  available: boolean;
  checks: Partial<Record<ComputerCheckKey, ComputerCheck>>;
  /** macOS: Screen Recording was just granted and only a restart makes it work. */
  needsRestart: boolean;
}

export const COMPUTER_UNREACHABLE: ComputerSetup = { reachable: false, platform: '', available: false, checks: { desktop: 'missing' }, needsRestart: false };

/** Reads a `status` answer for the setup card; anything unexpected reads as "desktop not reachable". */
export function parseComputerSetup(raw: unknown): ComputerSetup {
  if (!raw || typeof raw !== 'object') return COMPUTER_UNREACHABLE;
  const body = raw as Record<string, unknown>;
  const inner = body.result && typeof body.result === 'object' ? (body.result as Record<string, unknown>) : body;
  const rawChecks = inner.checks && typeof inner.checks === 'object' ? (inner.checks as Record<string, unknown>) : null;
  if (!rawChecks) return COMPUTER_UNREACHABLE;
  const checks: ComputerSetup['checks'] = {};
  for (const key of COMPUTER_CHECK_KEYS) {
    const value = rawChecks[key];
    if (value === 'ok' || value === 'missing' || value === 'unsupported') checks[key] = value;
  }
  return {
    reachable: true,
    platform: typeof inner.platform === 'string' ? inner.platform : '',
    available: inner.available === true,
    checks,
    needsRestart: inner.needsRestart === true,
  };
}

export async function fetchComputerSetup(): Promise<ComputerSetup> {
  try {
    const r = await fetch('/api/ui/computer/status', { cache: 'no-store' });
    return r.ok ? parseComputerSetup(await r.json()) : COMPUTER_UNREACHABLE;
  } catch {
    return COMPUTER_UNREACHABLE;
  }
}

/** An open window, as `list_windows` answers it. */
export interface ComputerWindow { id: string; title: string; app: string; focused: boolean }

/** Reads a `list_windows` answer defensively: anything unexpected is an empty list. */
export function parseComputerWindows(raw: unknown): ComputerWindow[] {
  const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).result : undefined;
  if (!Array.isArray(result)) return [];
  const out: ComputerWindow[] = [];
  for (const item of result) {
    if (!item || typeof item !== 'object') continue;
    const w = item as Record<string, unknown>;
    if (typeof w.id !== 'string' || typeof w.app !== 'string' || !w.app.trim()) continue;
    out.push({ id: w.id, title: typeof w.title === 'string' ? w.title : '', app: w.app, focused: w.focused === true });
  }
  return out;
}

/** The open windows, to offer their applications for the agent's list. Null when the desktop cannot answer. */
export async function fetchComputerWindows(): Promise<ComputerWindow[] | null> {
  try {
    const r = await fetch('/api/ui/computer/list_windows', { method: 'POST' });
    return r.ok ? parseComputerWindows(await r.json()) : null;
  } catch {
    return null;
  }
}

export type ComputerAppMode = 'foreground' | 'background';

/** An allowed application with the mode it is driven in. */
export interface AllowedApp { app: string; mode: ComputerAppMode }

/**
 * The list as the daemon sends it (`{ app, mode }`), or as an older one stored it (bare names, which take
 * `fallback`). Blank names and repeats (case apart) are dropped.
 */
export function normalizeAllowedApps(raw: unknown, fallback: ComputerAppMode = 'foreground'): AllowedApp[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: AllowedApp[] = [];
  for (const item of raw) {
    let app = '';
    let mode = fallback;
    if (typeof item === 'string') app = item;
    else if (item && typeof item === 'object' && typeof (item as { app?: unknown }).app === 'string') {
      app = (item as { app: string }).app;
      const own = (item as { mode?: unknown }).mode;
      if (own === 'foreground' || own === 'background') mode = own;
    }
    app = app.trim();
    if (!app || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    out.push({ app, mode });
  }
  return out;
}

/**
 * What "All applications" leaves out until a person edits the list. A copy of the daemon's
 * `DEFAULT_COMPUTER_USE_EXCLUDED_APPS` (orchestrator/src/agent-config.ts): the editor needs it for an
 * agent not saved yet, and to tell whether a list is still the default one. `computer-use.test.ts`
 * compares the two.
 */
export const DEFAULT_EXCLUDED_APPS: readonly string[] = Object.freeze([
  // Password managers and key stores.
  'KeePassXC', 'org.keepassxc.keepassxc', 'KeePass', 'KeeWeb',
  '1Password', 'com.1password.1password', 'com.agilebits.onepassword7',
  'Bitwarden', 'com.bitwarden.desktop',
  'Dashlane', 'LastPass', 'Enpass', 'Proton Pass', 'ProtonPass', 'NordPass', 'RoboForm', 'Keeper Password Manager',
  'Keychain Access', 'com.apple.keychainaccess', 'Passwords', 'com.apple.Passwords',
  'Seahorse', 'org.gnome.seahorse.Application', 'kwalletmanager5', 'KWalletManager',
  // Terminals.
  'Terminal', 'com.apple.Terminal', 'iTerm2', 'com.googlecode.iterm2', 'Warp', 'dev.warp.Warp-Stable',
  'Ghostty', 'com.mitchellh.ghostty', 'Alacritty', 'kitty', 'WezTerm', 'wezterm-gui', 'org.wezfurlong.wezterm',
  'Hyper', 'Tabby',
  'gnome-terminal', 'gnome-terminal-server', 'org.gnome.Terminal', 'kgx', 'org.gnome.Console', 'ptyxis', 'org.gnome.Ptyxis',
  'konsole', 'xterm', 'uxterm', 'urxvt', 'rxvt', 'xfce4-terminal', 'tilix', 'terminator', 'mate-terminal', 'lxterminal',
  'qterminal', 'foot', 'terminology', 'deepin-terminal', 'guake', 'yakuake', 'tilda', 'st',
  'WindowsTerminal', 'Windows Terminal', 'wt', 'cmd', 'powershell', 'pwsh', 'Windows PowerShell', 'conhost', 'OpenConsole', 'mintty',
  // Timon itself, packaged and run from the sources.
  'Timon', 'com.timon.desktop', 'timon-desktop', 'timon-dev',
]);

/** The excluded applications as the daemon serves them; the defaults when absent. Blanks and repeats (case apart) are dropped. */
export function normalizeExcludedApps(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [...DEFAULT_EXCLUDED_APPS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const app = item.trim();
    if (!app || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    out.push(app);
  }
  return out;
}

/** Whether a list names exactly the default applications, in any order and case. */
export function isDefaultExcludedApps(list: readonly string[]): boolean {
  const wanted = new Set(DEFAULT_EXCLUDED_APPS.map((app) => app.toLowerCase()));
  const got = new Set(list.map((app) => app.trim().toLowerCase()));
  return got.size === wanted.size && [...wanted].every((app) => got.has(app));
}

/**
 * What a save sends: null while the list is the default one, so the agent keeps following the product's
 * defaults (an absent key would keep a list stored earlier), the names otherwise.
 */
export function excludedAppsToSave(list: readonly string[]): string[] | null {
  return isDefaultExcludedApps(list) ? null : [...list];
}

/** How rich an application's accessibility tree is: `rich` can be driven in the background. */
export type AppVerdict = 'rich' | 'poor' | 'empty';

/** The mode a verdict suggests: only a rich tree works without the screen. */
export const modeForVerdict = (verdict: AppVerdict): ComputerAppMode => (verdict === 'rich' ? 'background' : 'foreground');

/** Reads an `a11y_probe_app` answer defensively. */
export function parseProbeVerdict(raw: unknown): AppVerdict | null {
  const result = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).result : undefined;
  const verdict = result && typeof result === 'object' ? (result as Record<string, unknown>).verdict : undefined;
  return verdict === 'rich' || verdict === 'poor' || verdict === 'empty' ? verdict : null;
}

/** Asks the desktop whether an open window's application is eligible for the background. Null when it cannot answer. */
export async function probeComputerApp(windowId: string): Promise<AppVerdict | null> {
  try {
    const r = await fetch('/api/ui/computer/a11y_probe_app', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ windowId }),
    });
    return r.ok ? parseProbeVerdict(await r.json()) : null;
  } catch {
    return null;
  }
}

/** "Allow": the desktop shows the system prompts, or opens the Settings pane. */
export async function requestComputerPermissions(): Promise<boolean> {
  try {
    return (await fetch('/api/ui/computer/request_permissions', { method: 'POST' })).ok;
  } catch {
    return false;
  }
}

/** "Restart Timon", after Screen Recording was granted. */
export async function restartComputerApp(): Promise<boolean> {
  try {
    return (await fetch('/api/ui/computer/restart_app', { method: 'POST' })).ok;
  } catch {
    return false;
  }
}

/**
 * What the UI proxy may forward to the daemon, by method. Every other command
 * (click, type…) is the agent's and must never be reachable from a browser
 * request: it answers null, and the route refuses with a 404 and forwards nothing.
 */
const UI_ALLOWED: Record<'GET' | 'POST', ReadonlySet<string>> = {
  GET: new Set(['status']),
  // The person's setup of the machine: system prompts and the restart they may need.
  // list_windows is read-only: a person fills the agent's allowed applications from it. focus_window stays the agent's.
  POST: new Set(['status', 'list_windows', 'a11y_probe_app', 'stop', 'resume', 'request_permissions', 'restart_app']),
};

export function uiComputerPath(method: 'GET' | 'POST', command: string): string | null {
  return UI_ALLOWED[method].has(command) ? `/api/computer/${command}` : null;
}

/** The only body the UI proxy forwards: a window id for the probe, nothing for every other command. */
export function uiComputerBody(command: string, raw: unknown): Record<string, unknown> | null {
  if (command !== 'a11y_probe_app') return {};
  const id = raw && typeof raw === 'object' ? (raw as Record<string, unknown>).windowId : undefined;
  return typeof id === 'string' && /^[A-Za-z0-9:_.-]{1,64}$/.test(id) ? { windowId: id } : null;
}

/**
 * The upstream call for a UI request. The daemon exposes only
 * `POST /api/computer/:command` (no GET route), so the screen's status poll
 * (GET) is relayed upstream as a POST: relaying it as a GET would 404 and the
 * banner would never appear.
 */
export function uiComputerUpstream(method: 'GET' | 'POST', command: string): { method: 'POST'; path: string } | null {
  const path = uiComputerPath(method, command);
  return path ? { method: 'POST', path } : null;
}

/** One line of an agent's action journal, as the daemon serves it. */
export interface ComputerJournalEntry {
  id: number;
  at: number;
  command: string;
  args: Record<string, unknown>;
  result: string;
  duration_ms: number;
}

/**
 * The journal read goes through its own UI route, never through the `[command]`
 * allow list: it carries a query, and only people read it (the daemon refuses any token).
 * Null for an empty name; the limit is clamped to what the daemon serves.
 */
export function uiComputerJournalPath(agent: string, limit = 50): string | null {
  if (!agent.trim()) return null;
  const bounded = Math.max(1, Math.min(Math.trunc(limit) || 50, 500));
  return `/api/computer/journal?agent=${encodeURIComponent(agent)}&limit=${bounded}`;
}

/** The last journal lines of an agent, most recent first; null when they cannot be read. */
export async function fetchComputerJournal(agent: string, limit = 50): Promise<ComputerJournalEntry[] | null> {
  if (!uiComputerJournalPath(agent, limit)) return [];
  try {
    const r = await fetch(`/api/ui/computer/journal?agent=${encodeURIComponent(agent)}&limit=${limit}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const body = await r.json() as { entries?: unknown };
    return Array.isArray(body.entries) ? (body.entries as ComputerJournalEntry[]) : null;
  } catch {
    return null;
  }
}
