/**
 * Closed lists of the v2 catalogue (`docs/TELEMETRY.md`): which product
 * features a request stands for, how a failure is coded, which section of the
 * app a page belongs to, and the machine classes. Every mapping falls back to
 * a fixed value (`other`, `none`): nothing a person typed, named or pointed at
 * can come out of these functions.
 */

/** Product features, keyed by the HTTP route template that performs them. */
const FEATURE_ROUTES = {
  'POST /api/agents': 'agent.create',
  'DELETE /api/agents/:name': 'agent.delete',
  'POST /api/agents/:name/rename': 'agent.rename',
  'PATCH /api/agents/:name/config': 'agent.configure',
  'POST /api/projects': 'project.create',
  'POST /api/projects/demo': 'project.demo_create',
  'DELETE /api/projects/:slug': 'project.delete',
  'POST /api/routines': 'routine.create',
  'DELETE /api/routines/:id': 'routine.delete',
  'POST /api/workflows': 'workflow.create',
  'POST /api/workflows/:id/publish': 'workflow.publish',
  'POST /api/workflows/:id/run': 'workflow.run',
  'DELETE /api/workflows/:id': 'workflow.delete',
  'POST /api/triggers': 'trigger.create',
  'POST /api/pipelines': 'pipeline.create',
  'POST /api/pipelines/:id/run': 'pipeline.run',
  'POST /api/skills': 'skill.create',
  'POST /api/skills/:id/import': 'skill.import',
  'POST /api/mcp': 'mcp_server.add',
  'DELETE /api/mcp/:id': 'mcp_server.remove',
  'POST /api/secrets': 'secret.create',
  'POST /api/memory/rules': 'memory_rule.create',
  'POST /api/users': 'account.create',
  'POST /api/invitations': 'account.invite',
  'POST /api/teams': 'team.create',
  'POST /api/groups': 'group.create',
  'POST /api/islands/arrangements': 'islands.save',
  'POST /api/license/activate': 'license.activate',
  'PUT /api/license': 'license.activate',
  'POST /api/license/deactivate': 'license.deactivate',
  'POST /api/backup/enable': 'backup.enable',
  'POST /api/dreams/run': 'dreams.run',
  'POST /api/missions/:id/fork': 'mission.fork',
  'POST /api/missions/:id/interrupt': 'mission.interrupt',
  'POST /api/missions/:id/voice-transcript': 'voice.transcript',
} as const;

export const FEATURES = [...new Set(Object.values(FEATURE_ROUTES))] as [
  (typeof FEATURE_ROUTES)[keyof typeof FEATURE_ROUTES], ...(typeof FEATURE_ROUTES)[keyof typeof FEATURE_ROUTES][],
];
export type Feature = (typeof FEATURES)[number];

export function featureOf(method: string, template: string | null): Feature | null {
  if (!template) return null;
  const key = `${method.toUpperCase()} ${template}`;
  return Object.hasOwn(FEATURE_ROUTES, key) ? FEATURE_ROUTES[key as keyof typeof FEATURE_ROUTES] : null;
}

/** API areas, the first segment after `/api/` of a route template. */
export const API_AREAS = [
  'admin', 'agent-look', 'agent-roles', 'agent-trash', 'agents', 'app', 'appearance', 'audit-log', 'auth', 'backends',
  'backup', 'bots', 'browser', 'capabilities', 'chat', 'company', 'devices', 'docker', 'doctor', 'dreams', 'events',
  'files', 'git', 'git-remote', 'global-instructions', 'gpt-live', 'graph', 'grepai', 'groups',
  'health', 'host', 'human', 'integrations', 'invitations', 'islands', 'kanban', 'layout', 'license', 'machines',
  'mcp', 'mcp-apps', 'memory', 'messages', 'mission-titles', 'missions', 'native-browser', 'nav', 'navigate', 'notifications',
  'onboarding', 'orchestrator', 'permissions', 'pipelines', 'plugin-connections', 'plugins', 'prefs', 'project-todo',
  'projects', 'push', 'roles', 'routines', 'secrets', 'series', 'settings', 'setup', 'skill-attachments',
  'skill-weights', 'skills', 'stats', 'stop', 'stream', 'tasks', 'teams', 'telemetry', 'terminal', 'todo-outcomes',
  'trace', 'triggers', 'ui-documents', 'update', 'updates', 'uploads', 'usage', 'users', 'vault', 'video-factory',
  'webui-access', 'widgets', 'workflows', 'workspaces', 'other',
] as const;
export type ApiArea = (typeof API_AREAS)[number];

export function apiAreaOf(template: string | null): ApiArea | null {
  const match = template ? /^\/api\/([a-z][a-z0-9-]*)/.exec(template) : null;
  if (!match) return null;
  return (API_AREAS as readonly string[]).includes(match[1]!) ? match[1] as ApiArea : 'other';
}

/** Who performed a request. */
export const ACTORS = ['person', 'agent', 'cli', 'other'] as const;
export type Actor = (typeof ACTORS)[number];

/** Error codes the product's routes send and that say something to us; anything else is coded by status. */
const PRODUCT_ERROR_CODES = [
  'user_limit', 'single_superadmin_required', 'free_account_restricted', 'plugin_composition_fixed',
  'license_required', 'free_incompatible', 'local_free', 'transfer_pending', 'client_upgrade_required',
] as const;
/** Why a server error happened, read from its raw text in-process (`causeOf`). */
const SERVER_CAUSES = [
  'upstream_rate_limited', 'upstream_unauthorized', 'upstream_error', 'timeout', 'network', 'db_locked',
  'disk_full', 'permission_denied', 'cli_missing', 'not_signed_in',
] as const;
export const FAILURE_CODES = [
  'none', ...PRODUCT_ERROR_CODES,
  'invalid', 'unauthenticated', 'forbidden', 'not_found', 'conflict', 'too_large', 'rate_limited',
  ...SERVER_CAUSES, 'server_error', 'other',
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

export function failureCodeOf(status: number, errorCode: string | null): FailureCode {
  if (status < 400) return 'none';
  if (errorCode && (PRODUCT_ERROR_CODES as readonly string[]).includes(errorCode)) return errorCode as FailureCode;
  if (status >= 500) return 'server_error';
  switch (status) {
    case 400: case 422: return 'invalid';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 409: return 'conflict';
    case 413: return 'too_large';
    case 429: return 'rate_limited';
    default: return 'other';
  }
}

/**
 * The closed cause of a server error, from its raw text and system code, which
 * never leave this function: only the code (and an external service's HTTP
 * status, a number) come out. Order matters: the most specific first.
 */
const CAUSE_PATTERNS: readonly (readonly [FailureCode, RegExp])[] = [
  ['db_locked', /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i],
  ['disk_full', /ENOSPC|no space left/i],
  ['permission_denied', /EACCES|EPERM|permission denied|operation not permitted/i],
  ['cli_missing', /spawn \S+ ENOENT|command not found|not found in PATH|binary not found|is not installed/i],
  ['not_signed_in', /not signed in|signed out|session (?:expired|rejected)|\/login\b/i],
  ['timeout', /ETIMEDOUT|ESOCKETTIMEDOUT|TimeoutError|AbortError|timed? ?out\b/i],
  ['network', /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up/i],
];
/** A 4xx/5xx standing alone in an error text: the status an external service answered. */
const UPSTREAM_STATUS = /(?:^|[\s(:\/])([45]\d{2})(?=$|[\s),;:.])/;

export type ServerCause = { cause: FailureCode; upstreamStatus?: number };

export function causeOf(status: number, errorCode: string | null, errorText: string | null, systemCode: string | null): ServerCause {
  const coded = failureCodeOf(status, errorCode);
  if (status < 500 || coded !== 'server_error') return { cause: coded };
  const text = `${systemCode ?? ''} ${errorText ?? ''}`;
  for (const [cause, pattern] of CAUSE_PATTERNS) if (pattern.test(text)) return { cause };
  const upstream = UPSTREAM_STATUS.exec(errorText ?? '');
  if (upstream) {
    const code = Number(upstream[1]);
    const cause: FailureCode = code === 429 ? 'upstream_rate_limited' : code === 401 || code === 403 ? 'upstream_unauthorized' : 'upstream_error';
    return { cause, upstreamStatus: code };
  }
  return { cause: 'server_error' };
}

/** Codes that mean a licence stopped the person from adding an account. */
export const ACCOUNT_LIMIT_CODES: readonly FailureCode[] = ['user_limit', 'single_superadmin_required'];

/**
 * Sections of the app: the first segment of a page path. A page a plugin adds
 * under a name of its own is `plugin`; the rest of a path (an agent's name, a
 * project's slug, a mission id) never leaves.
 */
export const PAGE_SECTIONS = [
  'home', 'activate', 'activity', 'agents', 'agents-grid', 'apps', 'bots', 'brain', 'capabilities', 'chat', 'confirm-email',
  'dashboard', 'dreams', 'edit', 'events', 'groups', 'invite', 'islands', 'kanban', 'license', 'login', 'mcp',
  'memory', 'messages', 'missions', 'multichat', 'notifications', 'onboarding', 'pipelines', 'plugins', 'profile', 'projects',
  'remote', 'roles', 'secrets', 'settings', 'setup', 'skills', 'terminal', 'trace', 'users', 'workflows', 'plugin',
] as const;
export type PageSection = (typeof PAGE_SECTIONS)[number];

export function pageSectionOf(path: string): PageSection {
  const first = /^\/([a-z][a-z0-9-]*)?/.exec(path)?.[1];
  if (first === undefined) return /^\/(?:[?#]|$)/.test(path) ? 'home' : 'plugin';
  return (PAGE_SECTIONS as readonly string[]).includes(first) && first !== 'home' && first !== 'plugin'
    ? first as PageSection
    : 'plugin';
}

export const ENTRY_POINTS = ['license_page', 'users', 'settings', 'banner', 'other'] as const;
export const UPGRADE_ACTIONS = ['plans_viewed', 'buy_opened', 'account_limit_reached'] as const;

/** Days since the installation's first event, as cohorts. */
export const INSTALL_AGES = ['0', '1', '2-7', '8-30', '31-90', 'gt90'] as const;
export function installAgeOf(firstDay: string, today: string): (typeof INSTALL_AGES)[number] {
  const days = Math.max(0, Math.round((Date.parse(today) - Date.parse(firstDay)) / 86_400_000));
  if (!Number.isFinite(days) || days === 0) return '0';
  if (days === 1) return '1';
  if (days <= 7) return '2-7';
  if (days <= 30) return '8-30';
  if (days <= 90) return '31-90';
  return 'gt90';
}

/**
 * UTC calendar days from `createdAt` to `at`: 0 the same UTC day, 1 the next.
 * A clock set before the creation reads as 0, never a negative age.
 */
export function installAgeDaysOf(createdAt: number, at: number): number {
  const day = (ms: number): number => Math.floor(ms / 86_400_000);
  return Math.max(0, day(at) - day(createdAt));
}

export const PREVIOUS_EXITS = ['first', 'clean', 'error', 'unknown'] as const;
export const WAIT_BUCKETS = ['lt10s', '10s-1m', '1-10m', '10-60m', 'gt1h'] as const;
export function waitBucketOf(ms: number): (typeof WAIT_BUCKETS)[number] {
  if (ms < 10_000) return 'lt10s';
  if (ms < 60_000) return '10s-1m';
  if (ms < 600_000) return '1-10m';
  if (ms < 3_600_000) return '10-60m';
  return 'gt1h';
}
export const DURATION_BUCKETS = ['lt1m', '1-10m', '10-60m', '1-6h', '6-24h', 'gt24h'] as const;
export function durationBucketOf(ms: number): (typeof DURATION_BUCKETS)[number] {
  if (ms < 60_000) return 'lt1m';
  if (ms < 600_000) return '1-10m';
  if (ms < 3_600_000) return '10-60m';
  if (ms < 6 * 3_600_000) return '1-6h';
  if (ms < 24 * 3_600_000) return '6-24h';
  return 'gt24h';
}
export const LOAD_BUCKETS = ['lt1s', '1-3s', '3-10s', 'gt10s'] as const;
export const MILESTONES = [
  'first_agent_created', 'first_project', 'first_turn_completed', 'first_routine', 'first_workflow', 'first_task_done',
] as const;
export type Milestone = (typeof MILESTONES)[number];
/** The milestone a successful feature marks, when it is one. */
export const FEATURE_MILESTONES: Partial<Record<Feature, Milestone>> = {
  'agent.create': 'first_agent_created',
  'project.create': 'first_project',
  'routine.create': 'first_routine',
  'workflow.create': 'first_workflow',
};
/** Where a mission's message came from: the app, or a messaging channel (its name never leaves). */
const INTERNAL_CHANNELS = new Set([
  'agent', 'wake', 'routine', 'task', 'dispatcher', 'kanban', 'recovery', 'workflow', 'trigger', 'webhook',
  'system', 'librarian', 'setup',
]);
export function messageChannelOf(sourceChannel: string | null): 'app' | 'external' | null {
  if (sourceChannel === null || sourceChannel === 'chat' || sourceChannel === 'fork') return 'app';
  if (INTERNAL_CHANNELS.has(sourceChannel) || sourceChannel.startsWith('plugin:')) return null;
  return 'external';
}

export const RAM_CLASSES = ['lt8', '8-16', '16-32', '32-64', 'gte64'] as const;
export const CPU_CLASSES = ['1-2', '3-4', '5-8', '9-16', 'gt16'] as const;

export function ramClassOf(bytes: number): (typeof RAM_CLASSES)[number] {
  const gib = bytes / 1024 ** 3;
  // A machine sold as 8 GB reports a little less: classes round to the label.
  if (gib < 7) return 'lt8';
  if (gib < 15) return '8-16';
  if (gib < 31) return '16-32';
  if (gib < 62) return '32-64';
  return 'gte64';
}

export function cpuClassOf(cores: number): (typeof CPU_CLASSES)[number] {
  if (cores <= 2) return '1-2';
  if (cores <= 4) return '3-4';
  if (cores <= 8) return '5-8';
  if (cores <= 16) return '9-16';
  return 'gt16';
}
