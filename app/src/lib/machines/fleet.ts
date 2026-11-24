/**
 * The fleet of machines as the browser sees it (TODO #329, P3d): the calls of
 * the Machines plugin and of the screens that bring the user back home.
 *
 * Every call goes to `/api/ui/machines*`, which the app anchors on the LOCAL
 * daemon whatever machine is active: the list, the switch and the way back
 * keep working on a remote machine that does not have the plugin, or is down.
 * A listing never carries a token.
 *
 * Switching is a full document load on the same origin (`enterActiveMachine`),
 * never a client-side navigation: the in-memory caches of the machine being
 * left (router cache, capabilities, `/api/auth/me`…) must not survive it. The
 * browser's stored state is scoped per machine (`machine-storage.ts`), so it
 * is not purged; only a machine taken out of the fleet loses it. That state
 * includes the last page seen on each machine (`last-route.ts`): a switch
 * lands there.
 *
 * In a desktop window (multi-window V3), the switch moves THAT window only:
 * the app checks the machine without writing the cookie, then hands the
 * machine to the shell. The window keeps a page per machine (V4): the shell
 * shows the machine's page as it was left, or opens one on its last page, and
 * hides this one, alive — nothing reloads. Every other window, and the
 * browser's cookie, stay put. An older shell only pins the window
 * (`X-Timon-Machine` on its requests), and the page loads itself again.
 */
import { activeMachineId, forgetMachineStorage } from './machine-storage';
import { landingRoute, lastRouteFor, rememberRoute } from './last-route';
import { LOCAL_MACHINE_ID } from './machine-id';
import { t } from '../i18n';
import { settingsPath } from '../settings-path';

/** The bundled host module the Machines client half belongs to. */
export const MACHINES_MODULE = '@timon/machines';

export type MachineStatus = 'unknown' | 'online' | 'unreachable' | 'unauthorized' | 'tls_error' | 'error';

/** `PublicMachine` of `orchestrator/src/machines/store.ts`. */
export type FleetMachine = {
  id: string;
  name: string;
  url: string;
  status: MachineStatus;
  version: string | null;
  api_level: number | null;
  last_checked_at: number | null;
  last_ok_at: number | null;
  created_at: number;
  updated_at: number;
  /** The account this computer acts as, on that machine. */
  remote_user: { email: string | null; name: string | null; is_superadmin: boolean };
};

export type MachineProbe = { machine: FleetMachine; reachable: boolean; version: string | null; apiLevel: number | null };

export type SwitchWarning = 'api_level_unknown' | 'api_level_newer';

/** Same bounds as the daemon (`MACHINE_NAME_MAX`, `MACHINE_URL_MAX`): longer is a 400. */
export const MACHINE_NAME_MAX = 64;
export const MACHINE_URL_MAX = 2048;

const BASE = '/api/ui/machines';

/**
 * `error` is the machine-readable code, never shown as is: the daemon's
 * `code`, or the `error` of an older daemon and of this app's own relays;
 * `detail` the machine status of an unreachable one.
 */
export type FleetFailure = { ok: false; status: number; error: string | null; detail: string | null };
export type FleetResult<T> = { ok: true; value: T } | FleetFailure;

async function failure(response: Response): Promise<FleetFailure> {
  const body = await response.json().catch(() => ({})) as { error?: unknown; code?: unknown; status?: unknown };
  const code = typeof body.code === 'string' ? body.code : typeof body.error === 'string' ? body.error : null;
  return {
    ok: false,
    status: response.status,
    error: code,
    detail: typeof body.status === 'string' ? body.status : null,
  };
}

function networkFailure(): FleetFailure {
  return { ok: false, status: 0, error: null, detail: null };
}

async function call<T>(path: string, init: RequestInit, read: (body: unknown) => T): Promise<FleetResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, { cache: 'no-store', ...init });
  } catch {
    return networkFailure();
  }
  if (!response.ok) return failure(response);
  return { ok: true, value: read(await response.json().catch(() => ({}))) };
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

export function listMachines(): Promise<FleetResult<FleetMachine[]>> {
  return call(BASE, {}, (body) => (body as { machines?: FleetMachine[] }).machines ?? []);
}

export function pairMachine(input: { url: string; code: string; name?: string }): Promise<FleetResult<{ machine: FleetMachine; created: boolean }>> {
  return call(`${BASE}/pair`, jsonInit('POST', input), (body) => body as { machine: FleetMachine; created: boolean });
}

export function renameMachine(id: string, name: string): Promise<FleetResult<FleetMachine>> {
  return call(`${BASE}/${encodeURIComponent(id)}`, jsonInit('PATCH', { name }), (body) => (body as { machine: FleetMachine }).machine);
}

/** Removes the machine and erases what this browser kept for it. */
export async function removeMachine(id: string): Promise<FleetResult<{ remoteRevoked: boolean }>> {
  const result = await call(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' }, (body) => ({
    remoteRevoked: (body as { remote_revoked?: unknown }).remote_revoked === true,
  }));
  if (result.ok) forgetMachineStorage(id);
  return result;
}

export function probeMachine(id: string): Promise<FleetResult<MachineProbe>> {
  return call(`${BASE}/${encodeURIComponent(id)}/status`, {}, (body) => body as MachineProbe);
}

/**
 * Writes the active machine (the app checks it first). Does not reload.
 * `window`: checked the same way, cookie left alone — the desktop window pins
 * itself instead.
 */
export function selectMachine(id: string, scope: 'browser' | 'window' = 'browser'): Promise<FleetResult<{ id: string; warning: SwitchWarning | null }>> {
  const payload = scope === 'window' ? { id, scope } : { id };
  return call(`${BASE}/active`, jsonInit('POST', payload), (body) => body as { id: string; warning: SwitchWarning | null });
}

type WindowMachineBridge = { set: (id: string, request?: { route?: string }) => Promise<unknown> };

/** The desktop shell's hold on this window's machine; absent on the web, the PWA and an older desktop. */
function windowMachineBridge(): WindowMachineBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.timonDesktop?.windowMachine;
  return typeof bridge?.set === 'function' ? bridge : null;
}

/**
 * Loads the interface again for the machine the cookie now names, on this
 * same origin: a PWA stays in its window. To `route`, a page of THAT machine —
 * never the page on screen, which names objects (a mission, a project) of the
 * machine being left.
 *
 * The page left can come back with Back, restored from the back/forward cache
 * as it was: still on "Switching to…", and still rendered for the machine it
 * left while every call now goes to the one the cookie names (TODO #788). It
 * is loaded again instead, as a Back outside that cache would — once: the
 * reloaded document has no such listener.
 */
export function enterActiveMachine(route = '/'): void {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) window.location.reload();
  }, { once: true });
  window.location.assign(route);
}

/**
 * A switch that went through. `kept`: a desktop window that keeps pages (V4)
 * hid this page alive instead of loading another document, and shows it
 * again, as it is, when its machine comes back — so whatever the caller set
 * while switching ("Switching to…", a disabled button) must be undone, or
 * it is still there on the way back (TIM-0139).
 */
export type MachineSwitched = { ok: true; kept: boolean };

/**
 * Switches, then reloads on the last page seen on `id` (`/` for a machine
 * never visited, the root of its section when the object that page names is
 * gone there). A refusal comes back for the caller to show.
 */
export async function switchToMachine(id: string): Promise<MachineSwitched | FleetFailure> {
  // Before the cookie moves: this page still belongs to the machine on screen.
  const leaving = activeMachineId();
  rememberRoute(`${window.location.pathname}${window.location.search}`, leaving);
  const pinned = windowMachineBridge();
  const result = await selectMachine(id, pinned ? 'window' : 'browser');
  if (!result.ok) return result;
  if (pinned) {
    let answer: unknown;
    try {
      // The page a new view of `id` opens on: synchronous, so no probe can go to the wrong machine.
      answer = await pinned.set(id, { route: lastRouteFor(id) });
    } catch {
      return { ok: false, status: 0, error: null, detail: null };
    }
    // The shell switched pages itself (V4): this one is hidden as it is.
    if ((answer as { shown?: unknown } | null)?.shown === true) return { ok: true, kept: true };
  }
  // The cookie, or this window's pin, names `id` now: the probes go to the machine being entered.
  enterActiveMachine(await landingRoute(lastRouteFor(id)));
  return { ok: true, kept: false };
}

/** Back to this computer: always allowed, whatever state the remote is in. */
export function switchToLocal(): Promise<MachineSwitched | FleetFailure> {
  return switchToMachine(LOCAL_MACHINE_ID);
}

export type FleetErrorKind =
  | 'invalidCode' | 'invalidUrl' | 'httpsRequired' | 'blockedAddress' | 'notTimon' | 'requiresTls'
  | 'unreachable' | 'unauthorized' | 'tlsError' | 'redirect' | 'badResponse' | 'throttled'
  | 'tooMany' | 'vault' | 'incompatible' | 'notFound' | 'notHere' | 'sessionRequired' | 'invalidName' | 'generic';

/** Which localized message a failed call deserves. */
export function fleetErrorKind(failure: Pick<FleetFailure, 'status' | 'error' | 'detail'>): FleetErrorKind {
  switch (failure.error) {
    case 'invalid_code': return 'invalidCode';
    case 'invalid_url':
    case 'credentials_in_url':
    case 'query_in_url': return 'invalidUrl';
    case 'https_required': return 'httpsRequired';
    case 'blocked_address': return 'blockedAddress';
    case 'not_a_timon_machine': return 'notTimon';
    case 'machine_requires_tls': return 'requiresTls';
    case 'machine_tls_error': return 'tlsError';
    case 'machine_redirect': return 'redirect';
    case 'machine_bad_response': return 'badResponse';
    case 'machine_throttled': return 'throttled';
    case 'too_many_machines': return 'tooMany';
    case 'vault_unavailable': return 'vault';
    case 'machine_incompatible': return 'incompatible';
    case 'machine_unknown': return 'notFound';
    case 'machine_session_required': return 'sessionRequired';
    case 'machine_unreachable':
      if (failure.detail === 'unauthorized') return 'unauthorized';
      if (failure.detail === 'tls_error') return 'tlsError';
      return 'unreachable';
    case 'machine_credential_unavailable': return 'unreachable';
    default: break;
  }
  if (failure.status === 429) return 'throttled';
  // A paired device or a mission cannot manage the fleet: only a browser
  // signed in on this computer can.
  if (failure.status === 403) return 'notHere';
  if (failure.status === 404) return 'notFound';
  if (failure.status === 400) return 'invalidName';
  return 'generic';
}

/** What a name field may submit, or null when the daemon would refuse it. */
export function cleanMachineName(raw: string): string | null {
  const name = raw.trim();
  // eslint-disable-next-line no-control-regex
  if (name.length === 0 || name.length > MACHINE_NAME_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(name)) return null;
  return name;
}

/** The URL as typed, trimmed; `https://` added to a bare host. The daemon decides the rest. */
export function normalizeMachineUrl(raw: string): string {
  const url = raw.trim();
  if (url.length === 0) return url;
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `https://${url}`;
}

/** How the account a device acts as is named: its name, else its email. */
export function remoteAccountLabel(machine: Pick<FleetMachine, 'remote_user'>): string | null {
  return machine.remote_user.name?.trim() || machine.remote_user.email?.trim() || null;
}

/** `Settings → Plugins → Machines`: where the fleet is managed, as the dialog labels it. */
export function machinesSettingsPath(): string {
  return `${settingsPath('plugins')} → ${t('machines.title')}`;
}
