/**
 * Mission isolation (`host.isolation`): what the Settings › System › Security
 * card reads and writes, through `/api/ui/isolation`.
 *
 * `status` is the daemon's own verdict — what a mission launched now gets —
 * and the only thing allowed to say "active": a mode set to `auto` on a
 * machine without the mechanism must read as unprotected, never as the wish.
 * The daemon's `reason` and `gaps` arrive in English, like `timon doctor`;
 * the card frames them with translated text.
 */
import { parseApiError } from '@/lib/api-error';
import { t } from '@/lib/i18n';
import type { SettingsTarget } from '@/lib/settings-layout';

export type IsolationMode = 'auto' | 'enforce' | 'off';
export type UnixSockets = 'deny' | 'allow';

export type FenceException = { unixSockets?: UnixSockets; writable: string[] };
export type FenceExceptions = { agents: Record<string, FenceException>; projects: Record<string, FenceException> };

export type MissionIsolationStatus = {
  configured: IsolationMode;
  mechanism: 'landlock' | 'seatbelt' | 'none';
  abi: number;
  enforced: boolean;
  state: 'ready' | 'unsupported' | 'tampered' | 'off';
  launch: 'fenced' | 'unfenced' | 'refused';
  reason: string | null;
  message: string;
  gaps: string[];
  unixSockets: UnixSockets;
  exceptions: { agents: string[]; projects: string[] };
};

export type IsolationSettingsState = {
  status: MissionIsolationStatus;
  settings: { filesystem: IsolationMode; unixSockets: UnixSockets; exceptions: FenceExceptions };
};

export type IsolationPatch = Partial<{ filesystem: IsolationMode; unixSockets: UnixSockets; exceptions: FenceExceptions }>;

/** Where the card lives: Settings › System › Security. */
export const MISSION_ISOLATION_TARGET: SettingsTarget = { category: 'system', tab: 'security' };

const ENDPOINT = '/api/ui/isolation';

export class MissionIsolationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'MissionIsolationError';
  }
}

function errorMessage(status: number, body: unknown): string {
  if (status === 401) return t('missionIsolation.errors.unauthenticated');
  if (status === 403) return t('missionIsolation.errors.forbidden');
  // The daemon names the field it refused (`exceptions.agents.x.writable.0: …`), in English.
  const message = typeof (body as { message?: unknown } | null)?.message === 'string' ? (body as { message: string }).message : null;
  if (status === 400 && message) return t('missionIsolation.errors.invalid', { detail: message });
  if (status === 409) return t('missionIsolation.errors.configUnreadable');
  return t('missionIsolation.errors.generic', { status });
}

async function call(init: RequestInit): Promise<IsolationSettingsState> {
  const response = await fetch(ENDPOINT, { ...init, cache: 'no-store' });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new MissionIsolationError(response.status, errorMessage(response.status, json));
  return json as IsolationSettingsState;
}

export function fetchMissionIsolation(): Promise<IsolationSettingsState> {
  return call({ method: 'GET' });
}

export function saveMissionIsolation(patch: IsolationPatch): Promise<IsolationSettingsState> {
  return call({ method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
}

/** The chip of the status row. `refused` and `altered` are said apart from a plain absence. */
export type IsolationTone = 'active' | 'inactive' | 'off' | 'altered' | 'refusing';

export function isolationTone(status: MissionIsolationStatus): IsolationTone {
  if (status.enforced) return 'active';
  if (status.state === 'off') return 'off';
  if (status.launch === 'refused') return 'refusing';
  if (status.state === 'tampered') return 'altered';
  return 'inactive';
}

/** The status line under the title: how missions are fenced, or why they are not. */
export function isolationSummary(status: MissionIsolationStatus): string {
  if (status.enforced) {
    if (status.mechanism === 'seatbelt') return t('missionIsolation.summary.seatbelt');
    return t('missionIsolation.summary.landlock', { abi: status.abi });
  }
  if (status.state === 'off') return t('missionIsolation.summary.off');
  return t('missionIsolation.summary.unfenced', { reason: status.reason ?? '' });
}

/** How many agents and projects carry an exception, for the Exceptions row. */
export function exceptionsSummary(exceptions: FenceExceptions): string {
  const agents = Object.keys(exceptions.agents).length;
  const projects = Object.keys(exceptions.projects).length;
  if (agents === 0 && projects === 0) return t('missionIsolation.exceptions.none');
  return t('missionIsolation.exceptions.count', { agents, projects });
}

/** One exception as the dialog edits it: a name, its kind, and the paths as typed. */
export type ExceptionDraft = { kind: 'agent' | 'project'; name: string; unixSockets: boolean; writable: string };

export function toDrafts(exceptions: FenceExceptions): ExceptionDraft[] {
  const rows = (kind: ExceptionDraft['kind'], map: Record<string, FenceException>): ExceptionDraft[] =>
    Object.keys(map).sort().map((name) => ({
      kind,
      name,
      unixSockets: map[name]!.unixSockets === 'allow',
      writable: map[name]!.writable.join('\n'),
    }));
  return [...rows('agent', exceptions.agents), ...rows('project', exceptions.projects)];
}

/** Same rule as the daemon (`isFenceSegment`): a name the fence would ignore is refused here first. */
export const EXCEPTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * The drafts as the daemon takes them. A draft whose sockets are off writes
 * no `unixSockets` at all: the global value then applies, which is what
 * "not an exception" means. One path per line, blank lines dropped.
 */
export function fromDrafts(drafts: readonly ExceptionDraft[]): FenceExceptions {
  const out: FenceExceptions = { agents: {}, projects: {} };
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!name) continue;
    const writable = draft.writable.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const entry: FenceException = { ...(draft.unixSockets ? { unixSockets: 'allow' as const } : {}), writable };
    (draft.kind === 'agent' ? out.agents : out.projects)[name] = entry;
  }
  return out;
}

/** What is wrong with the drafts, or null: an invalid name, or the same one twice. */
export function draftsProblem(drafts: readonly ExceptionDraft[]): string | null {
  const seen = new Set<string>();
  for (const draft of drafts) {
    const name = draft.name.trim();
    if (!EXCEPTION_NAME.test(name)) return t('missionIsolation.dialog.badName', { name: name || '…' });
    const key = `${draft.kind}:${name}`;
    if (seen.has(key)) return t('missionIsolation.dialog.duplicate', { name });
    seen.add(key);
  }
  return null;
}

/**
 * The daemon refused a launch because `enforce` is set and this machine
 * cannot fence it. Nothing the chat retries will do better: it says why, in
 * the reader's language (`apiErrors.mission_fence_refused`).
 */
export function isFenceRefusal(body: unknown): boolean {
  return parseApiError(body)?.code === 'mission_fence_refused';
}
