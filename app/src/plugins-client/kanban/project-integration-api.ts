/**
 * A project's landing setting as the daemon answers it
 * (`orchestrator/src/project-integration.ts`, routes
 * `plugins-bundled/kanban/integration-routes.ts`): local merge or pull
 * requests, and where those go. Every verb needs `projects:manage`, reads
 * included: the setting names a folder of this machine and the account the
 * daemon pushes as. The mode alone (`readLandingMode`) is open to whoever
 * sees the project.
 */
import { apiErrorMessage } from '@/lib/api-error';
import type { GitRemoteEntry } from '@/lib/git-store';
import { refusalText } from '@/lib/permission-refusal';
import type { Answer } from './landing-api';

export type IntegrationMode = 'local' | 'pr';

export type ProjectIntegrationView = {
  mode: IntegrationMode;
  remote: string;
  target: string;
  forge: string;
  account: string | null;
  gh_config_dir: string | null;
  branch_prefix: string;
  remote_url: string | null;
  /** Push URL of the account's fork of the target, when it cannot push to the target. */
  push_remote_url?: string | null;
  contributor_conflicts?: string;
};

export type IntegrationRead = {
  integration: ProjectIntegrationView;
  /** False while the project never set one: `integration` is the default. */
  configured: boolean;
  /** Why the stored value no longer validates; `integration` is then the default. */
  invalid?: string;
};

/** How the project's jobs land, without the rest of the setting. `valid` is
 *  false when the stored setting no longer validates (the default applies). */
export type LandingModeRead = { mode: IntegrationMode; configured: boolean; valid: boolean };

/** What the dialog writes. `null` clears the account, the folder or the URL. */
export type IntegrationPatch = {
  mode: IntegrationMode;
  remote: string;
  target: string;
  account: string | null;
  gh_config_dir: string | null;
  branch_prefix: string;
  remote_url: string | null;
  push_remote_url?: string | null;
};

export type GhCheckCode = 'gh_missing' | 'gh_failed' | 'timed_out' | 'unexpected_answer';

/** `login` is what gh answered; `code`/`reason` say why it could not answer. */
export type IntegrationCheck = {
  ok: boolean;
  login: string | null;
  expected: string | null;
  code: GhCheckCode | null;
  reason: string | null;
  /** The account's rights on the target and on the fork, when the daemon read them. */
  access: IntegrationAccess | null;
};

/** What the account may push to: `canPush` is false for a repository that does not exist. */
export type RepositoryRights = { repository: string; exists: boolean; canPush: boolean } | { repository: string; unreadable: true };
export type IntegrationAccess = { target: RepositoryRights; fork: RepositoryRights | null };

const base = (project: string) => `/api/ui/projects/${encodeURIComponent(project)}/integration`;

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

async function call<T>(url: string, init: RequestInit | undefined, pick: (body: unknown) => T | undefined, fetchImpl: typeof fetch): Promise<Answer<T>> {
  try {
    const res = await fetchImpl(url, init ?? { cache: 'no-store' });
    const body: unknown = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, message: refusalText(body) ?? apiErrorMessage(body, { status: res.status }) };
    const value = pick(body);
    return value === undefined ? { ok: false, message: apiErrorMessage(null) } : { ok: true, value };
  } catch {
    return { ok: false, message: apiErrorMessage(null) };
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

function readOf(body: unknown): IntegrationRead | undefined {
  const b = body as { integration?: Record<string, unknown>; configured?: unknown; invalid?: unknown } | null;
  const i = b?.integration;
  if (!i || typeof i !== 'object') return undefined;
  return {
    integration: {
      mode: i.mode === 'pr' ? 'pr' : 'local',
      remote: str(i.remote) ?? 'origin',
      target: str(i.target) ?? 'main',
      forge: str(i.forge) ?? 'github',
      account: str(i.account),
      gh_config_dir: str(i.gh_config_dir),
      branch_prefix: str(i.branch_prefix) ?? 'feat/',
      remote_url: str(i.remote_url),
      push_remote_url: str(i.push_remote_url),
      ...(typeof i.contributor_conflicts === 'string' ? { contributor_conflicts: i.contributor_conflicts } : {}),
    },
    configured: b?.configured === true,
    ...(typeof b?.invalid === 'string' ? { invalid: b.invalid } : {}),
  };
}

export function readIntegration(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<IntegrationRead>> {
  return call(base(project), undefined, readOf, fetchImpl);
}

/** The mode alone, for any signed-in account: no account, folder nor remote. */
export function readLandingMode(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<LandingModeRead>> {
  return call(`${base(project)}/mode`, undefined, (body) => {
    const b = body as Record<string, unknown> | null;
    if (!b || (b.mode !== 'local' && b.mode !== 'pr')) return undefined;
    return { mode: b.mode, configured: b.configured === true, valid: b.valid !== false };
  }, fetchImpl);
}

export function saveIntegration(project: string, patch: IntegrationPatch, fetchImpl: typeof fetch = fetch): Promise<Answer<IntegrationRead>> {
  return call(base(project), json('PUT', patch), readOf, fetchImpl);
}

/** Back to the local merge; answers the default setting. */
export function resetIntegration(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<IntegrationRead>> {
  return call(base(project), { method: 'DELETE' }, readOf, fetchImpl);
}

const GH_CODES: readonly GhCheckCode[] = ['gh_missing', 'gh_failed', 'timed_out', 'unexpected_answer'];

/** Asks gh which account it signs in as: with `draft`, the dialog's account
 *  and folder before they are saved; without, the stored setting. */
export function checkIntegration(
  project: string, draft?: Pick<IntegrationPatch, 'account' | 'gh_config_dir'>, fetchImpl: typeof fetch = fetch,
): Promise<Answer<IntegrationCheck>> {
  return call(`${base(project)}/check`, json('POST', draft ?? {}), (body) => {
    const b = body as Record<string, unknown> | null;
    if (!b || typeof b.ok !== 'boolean') return undefined;
    const code = GH_CODES.find((c) => c === b.code) ?? null;
    return { ok: b.ok, login: str(b.login), expected: str(b.expected), code, reason: str(b.reason), access: accessOf(b.access) };
  }, fetchImpl);
}

function rightsOf(v: unknown): RepositoryRights | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r.repository !== 'string') return null;
  if (r.unreadable === true) return { repository: r.repository, unreadable: true };
  return { repository: r.repository, exists: r.exists === true, canPush: r.can_push === true };
}

function accessOf(v: unknown): IntegrationAccess | null {
  const a = v as Record<string, unknown> | null;
  const target = rightsOf(a?.target);
  return target ? { target, fork: rightsOf(a?.fork) } : null;
}

/** Creates the account's fork of the target. Only a person's click calls it,
 *  after the confirmation the dialog shows; the daemon refuses anything else. */
export function createFork(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<IntegrationRead & { fork: string }>> {
  return call(`${base(project)}/fork`, json('POST', { confirm: true }), (body) => {
    const read = readOf(body);
    const fork = (body as { fork?: unknown } | null)?.fork;
    return read && typeof fork === 'string' ? { ...read, configured: true, fork } : undefined;
  }, fetchImpl);
}

/** The repository's remotes, for the dialog's choice; an empty list when it has none. */
export function listRemotes(project: string, fetchImpl: typeof fetch = fetch): Promise<Answer<GitRemoteEntry[]>> {
  return call(`/api/ui/git-remote/${encodeURIComponent(project)}/remotes`, undefined, (body) => {
    const remotes = (body as { remotes?: unknown } | null)?.remotes;
    if (!Array.isArray(remotes)) return undefined;
    return remotes.filter((r): r is GitRemoteEntry => !!r && typeof (r as GitRemoteEntry).name === 'string');
  }, fetchImpl);
}

const CHANGED = 'timon:project-integration-changed';

/** Tells the other rows of the project's settings that its landing changed
 *  (the contributors' conflicts row only exists in pull request mode). */
export function announceIntegrationChanged(project: string): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(CHANGED, { detail: { project } }));
}

/** Calls `onChange` when the row of `project` changes its landing. */
export function onIntegrationChanged(project: string, onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const listener = (e: Event) => {
    if ((e as CustomEvent<{ project?: string }>).detail?.project === project) onChange();
  };
  window.addEventListener(CHANGED, listener);
  return () => window.removeEventListener(CHANGED, listener);
}
