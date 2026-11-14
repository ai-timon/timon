/**
 * The closed catalogue of product analytics events (`docs/TELEMETRY.md`).
 *
 * Every event and every property is declared here, and every payload is
 * validated against its schema at runtime before it is queued: TypeScript
 * alone would let a widened string through. String values come from closed
 * lists or bounded safe formats; anything else is mapped to `other` by the
 * helpers below, or the event is dropped. Changing an event or a property
 * means bumping `EVENT_SCHEMA_VERSION` and updating `docs/TELEMETRY.md`.
 *
 * Never part of a payload: prompts, answers, any content; names of projects,
 * agents, skills, routines or MCP servers; paths, URLs, commands; raw error
 * text; addresses, host or user names; database ids.
 */
import { z } from 'zod';
import { ONBOARDING_STEP_ACTIONS, ONBOARDING_STEPS } from '../../onboarding-events.js';
import { builtinProviderIds } from '../../backends/builtin-declarations.js';
import { baseBackendId } from '../../backends/instance-id.js';
import {
  ACTORS, API_AREAS, CPU_CLASSES, DURATION_BUCKETS, ENTRY_POINTS, FAILURE_CODES, FEATURES, INSTALL_AGES, LOAD_BUCKETS,
  MILESTONES, PAGE_SECTIONS, PREVIOUS_EXITS, RAM_CLASSES, UPGRADE_ACTIONS, WAIT_BUCKETS,
} from './features.js';

export const EVENT_SCHEMA_VERSION = 4;

/**
 * Backends of the product's own providers, as their official manifests declare
 * them (the core spells no provider name: `no-provider-names.test.ts`). A
 * third-party or custom provider is `other`: its id is a name someone chose.
 */
let knownBackends: ReadonlySet<string> | null = null;
function isProductBackend(id: string): boolean {
  if (!knownBackends) {
    try { knownBackends = new Set(builtinProviderIds()); } catch { return false; }
  }
  return knownBackends.has(id);
}
const BACKEND_ID = /^[a-z][a-z0-9-]{0,31}$/;

export const ORIGINS = ['user', 'task', 'routine', 'trigger', 'agent', 'workflow', 'plugin', 'system', 'other'] as const;
export type TurnOrigin = (typeof ORIGINS)[number];

/** Native tools of the CLIs Timon drives; an MCP tool counts only when it is Timon's own. */
export const NATIVE_TOOLS = [
  // Claude Code
  'Agent', 'Bash', 'BashOutput', 'Edit', 'ExitPlanMode', 'Glob', 'Grep', 'KillShell', 'LS', 'MultiEdit',
  'NotebookEdit', 'Read', 'Skill', 'Task', 'TodoWrite', 'ToolSearch', 'WebFetch', 'WebSearch', 'Write',
  // Codex and the ACP family
  'apply_patch', 'exec_command', 'list_dir', 'read_file', 'shell', 'update_plan', 'view_image', 'web_search', 'write_stdin',
] as const;
const NATIVE_TOOL_SET = new Set<string>(NATIVE_TOOLS);
/** MCP servers the product itself injects into a mission. */
const TIMON_MCP_SERVERS = new Set(['timon', 'timon_ask', 'timon-browser']);
const MCP_TOOL = /^mcp__([a-z_-]{1,32})__([a-z][a-z0-9_]{1,48})$/;

export const TASK_TYPES = ['code', 'review', 'merge', 'research', 'doc', 'chore', 'other'] as const;
export const TASK_PIPELINES = ['full', 'code-self', 'code-group', 'none', 'other'] as const;
export const TASK_STATUSES = ['todo', 'pending', 'in_progress', 'done', 'blocked', 'failed', 'cancelled', 'other'] as const;

export const LICENSE_REASONS = [
  'none', 'missing', 'invalid', 'expired', 'revoked', 'deactivated', 'build_expired', 'beta_ended', 'other',
] as const;
export const MISSION_END_REASONS = ['none', 'rate_limit', 'killed', 'timeout', 'crash', 'other'] as const;
export const BROWSER_KINDS = ['recording', 'annotation'] as const;

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z.]{1,24})?$/;
/** A catalogue model slug (`claude-opus-4-5`, `gpt-5.5`, `kimi-k2:latest`). */
const MODEL_SLUG = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
/** A bundled or product-shipped plugin id (`@timon/kanban`, `provider-claude`). */
const PLUGIN_ID = /^@?[a-z0-9][a-z0-9._/-]{0,63}$/;
/** Final guard on every string value of every event, globals included. */
const SAFE_STRING = /^[A-Za-z0-9._:@/-]{1,64}$/;

const count = z.number().int().min(0).max(1_000_000_000_000);
const version = z.string().regex(SEMVER);
const model = z.string().regex(MODEL_SLUG);
const pluginRef = z.string().regex(PLUGIN_ID);

export const GlobalPropertiesSchema = z.object({
  surface: z.enum(['daemon', 'desktop', 'web']),
  app_version: version,
  platform: z.enum(['linux', 'darwin', 'win32', 'other']),
  arch: z.enum(['x64', 'arm64', 'ia32', 'arm', 'other']),
  event_schema_version: z.literal(EVENT_SCHEMA_VERSION),
  license_tier: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
  /** Rank of the account behind the event (1 = the first one created), never its id. */
  account_slot: z.number().int().min(1).max(10_000).optional(),
  /** Days since this installation's first event, as a cohort. */
  install_age: z.enum(INSTALL_AGES).optional(),
}).strict();
export type GlobalProperties = z.infer<typeof GlobalPropertiesSchema>;

const backend = z.string().regex(BACKEND_ID);
const origin = z.enum(ORIGINS);

export const EVENT_SCHEMAS = {
  app_started: z.object({
    mode: z.enum(['host', 'docker']),
    daemon_mode: z.enum(['embedded', 'service', 'process']),
    edition: z.enum(['expert', 'lite']),
    /** How the previous run ended: `error` = non-zero exit, `unknown` = no exit recorded (killed, power loss). */
    previous_exit: z.enum(PREVIOUS_EXITS).optional(),
    boot_ms: z.number().int().min(0).max(3_600_000).optional(),
  }).strict(),
  app_updated: z.object({ from_version: version, to_version: version }).strict(),
  desktop_app_opened: z.object({ desktop_version: version.optional() }).strict(),
  onboarding_step: z.object({
    step: z.enum(ONBOARDING_STEPS),
    action: z.enum(ONBOARDING_STEP_ACTIONS),
  }).strict(),
  mission_spawned: z.object({ backend, model, origin, child: z.boolean() }).strict(),
  mission_ended: z.object({
    origin,
    status: z.enum(['completed', 'failed', 'terminated']),
    reason: z.enum(MISSION_END_REASONS),
  }).strict(),
  turn_started: z.object({ backend, model, origin, channel: z.enum(['app', 'external']).optional() }).strict(),
  turn_completed: z.object({
    backend, model, origin,
    status: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    duration_ms: z.number().int().min(0).max(30 * 24 * 3_600_000),
    /** Whole UTC days from the identity's creation to this turn; absent when the creation is unknown. */
    install_age_days: z.number().int().min(0).max(36_500).optional(),
  }).strict(),
  token_usage: z.object({
    backend, model, origin,
    input_tokens: count.optional(),
    output_tokens: count.optional(),
    cache_read_tokens: count.optional(),
    reasoning_tokens: count.optional(),
  }).strict(),
  tool_used: z.object({ backend, tool: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_]{0,40}|mcp__[a-z_-]{1,32}__[a-z][a-z0-9_]{1,48}|other)$/), count: z.number().int().min(1).max(10_000) }).strict(),
  task_action: z.object({
    action: z.enum(['created', 'status_changed', 'deleted']),
    type: z.enum(TASK_TYPES),
    pipeline: z.enum(TASK_PIPELINES),
    status: z.enum(TASK_STATUSES),
  }).strict(),
  plugin_action: z.object({
    action: z.enum(['install', 'remove', 'enable', 'disable']),
    plugin: pluginRef,
    source: z.enum(['bundled', 'builtin', 'third_party']),
  }).strict(),
  license_action: z.object({
    action: z.enum(['activated', 'expired', 'refreshed']),
    reason: z.enum(LICENSE_REASONS),
  }).strict(),
  browser_action: z.object({
    kind: z.enum(BROWSER_KINDS),
    action: z.string().regex(/^[a-z][a-z_]{0,31}$/),
  }).strict(),
  app_opened: z.object({ setup_completed: z.boolean(), load: z.enum(LOAD_BUCKETS).optional() }).strict(),
  ui_error: z.object({ section: z.enum(PAGE_SECTIONS) }).strict(),
  quota_reached: z.object({
    backend,
    window: z.enum(['five_hour', 'seven_day', 'other']),
    kind: z.enum(['rate_limit', 'exhausted']),
  }).strict(),
  user_prompt_answered: z.object({
    kind: z.enum(['question', 'kanban_plan', 'permission']),
    decision: z.enum(['allow', 'deny', 'paste', 'expired']),
    resolved_by: z.enum(['user', 'system', 'other']),
    wait: z.enum(WAIT_BUCKETS),
    tool: z.string().regex(/^(?:[A-Za-z][A-Za-z0-9_]{0,40}|mcp__[a-z_-]{1,32}__[a-z][a-z0-9_]{1,48}|other)$/).optional(),
  }).strict(),
  task_completed: z.object({
    type: z.enum(TASK_TYPES),
    pipeline: z.enum(TASK_PIPELINES),
    duration: z.enum(DURATION_BUCKETS),
    verdict: z.enum(['pass', 'changes_requested', 'unknown', 'none']),
    merged: z.boolean(),
  }).strict(),
  milestone_reached: z.object({ milestone: z.enum(MILESTONES) }).strict(),
  page_viewed: z.object({ section: z.enum(PAGE_SECTIONS) }).strict(),
  /**
   * OpenPanel's own page view, sent beside each `page_viewed`: its overview
   * counts pages and sessions from this name and its `__path`. The path is the
   * section and nothing else, never the page's real address.
   */
  screen_view: z.object({ section: z.enum(PAGE_SECTIONS), __path: z.string().max(64) }).strict()
    .refine((v) => v.__path === `/${v.section}`, { message: '__path is the section' }),
  feature_used: z.object({
    feature: z.enum(FEATURES),
    actor: z.enum(ACTORS),
    result: z.enum(['success', 'failure']),
    failure_code: z.enum(FAILURE_CODES),
  }).strict(),
  operation_failed: z.object({
    area: z.enum(API_AREAS),
    feature: z.enum([...FEATURES, 'other']),
    cause_code: z.enum(FAILURE_CODES),
    /** The HTTP status an external service answered, when the error carried one. */
    upstream_status: z.number().int().min(400).max(599).optional(),
  }).strict(),
  installation_snapshot: z.object({
    agents: count.optional(),
    projects: count.optional(),
    routines: count.optional(),
    routines_enabled: count.optional(),
    workflows: count.optional(),
    mcp_servers: count.optional(),
    skills: count.optional(),
    accounts: count.optional(),
    teams: count.optional(),
    bundled_plugins_active: count.optional(),
    third_party_plugins: count.optional(),
    backends: z.array(backend).max(32).optional(),
    ram_class: z.enum(RAM_CLASSES),
    cpu_class: z.enum(CPU_CLASSES),
  }).strict(),
  upgrade_action: z.object({
    action: z.enum(UPGRADE_ACTIONS),
    entry_point: z.enum(ENTRY_POINTS),
  }).strict(),
  telemetry_preference_changed: z.object({
    enabled: z.boolean(),
    source: z.enum(['settings', 'config']),
  }).strict(),
} as const;

export type TelemetryEventName = keyof typeof EVENT_SCHEMAS;
export type TelemetryEventProps<N extends TelemetryEventName> = z.infer<(typeof EVENT_SCHEMAS)[N]>;
export const EVENT_NAMES = Object.keys(EVENT_SCHEMAS) as TelemetryEventName[];

function stringsAreSafe(value: Record<string, unknown>): boolean {
  return Object.values(value).every((v) => (Array.isArray(v) ? v : [v]).every((item) => typeof item !== 'string' || SAFE_STRING.test(item)));
}

/** The validated properties, or `null`: an event that fails is dropped, never repaired. */
export function validateEvent(name: string, props: unknown): Record<string, unknown> | null {
  if (!Object.hasOwn(EVENT_SCHEMAS, name)) return null;
  const parsed = EVENT_SCHEMAS[name as TelemetryEventName].safeParse(props);
  if (!parsed.success) return null;
  const data = parsed.data as Record<string, unknown>;
  return stringsAreSafe(data) ? data : null;
}

export function validateGlobals(props: unknown): GlobalProperties | null {
  const parsed = GlobalPropertiesSchema.safeParse(props);
  if (!parsed.success) return null;
  return stringsAreSafe(parsed.data) ? parsed.data : null;
}

/* ── Mapping helpers: anything not on a list becomes `other` ───────────── */

/** A subscription account (`claude@<account>`) counts as its backend; the account never leaves. */
export function backendValue(id: string | null | undefined): string {
  const base = baseBackendId(id);
  return base && BACKEND_ID.test(base) && isProductBackend(base) ? base : 'other';
}

/**
 * A model is reported only when the product's catalogue names it for that
 * backend (`isCatalogModel`): a custom provider or a hand-added model carries
 * a name the person chose.
 */
export function modelValue(
  backendId: string,
  slug: string | null | undefined,
  isCatalogModel: (backend: string, model: string) => boolean,
): string {
  if (!slug) return 'default';
  if (backendValue(backendId) === 'other' || !MODEL_SLUG.test(slug)) return 'other';
  try {
    return isCatalogModel(baseBackendId(backendId), slug) ? slug : 'other';
  } catch {
    return 'other';
  }
}

export function toolValue(name: unknown): string {
  if (typeof name !== 'string') return 'other';
  if (NATIVE_TOOL_SET.has(name)) return name;
  const mcp = MCP_TOOL.exec(name);
  if (mcp && TIMON_MCP_SERVERS.has(mcp[1]!)) return name;
  return 'other';
}

/** Where a mission comes from, read from its row (`missions` columns), never its names. */
export function originValue(row: {
  source_channel: string | null;
  task_id?: string | null;
  routine_id?: string | null;
  parent_mission_id?: string | null;
  workflow_run_id?: string | null;
}): TurnOrigin {
  const channel = row.source_channel;
  if (row.routine_id || channel === 'routine') return 'routine';
  if (channel === 'trigger' || channel === 'webhook') return 'trigger';
  if (row.workflow_run_id || channel === 'workflow') return 'workflow';
  if (row.task_id || channel === 'dispatcher' || channel === 'kanban' || channel === 'recovery') return 'task';
  if (channel === 'agent' || channel === 'wake' || row.parent_mission_id) return 'agent';
  if (channel === null || channel === 'chat' || channel === 'fork') return 'user';
  if (channel.startsWith('plugin:')) return 'plugin';
  if (channel === 'system' || channel === 'librarian' || channel === 'setup') return 'system';
  return 'other';
}

function closed<T extends readonly string[]>(list: T, value: unknown): T[number] {
  const v = typeof value === 'string' ? value.toLowerCase() : '';
  return (list.includes(v) ? v : 'other') as T[number];
}

export const taskTypeValue = (v: unknown) => closed(TASK_TYPES, v);
export const taskPipelineValue = (v: unknown) => (v === null || v === undefined ? 'none' : closed(TASK_PIPELINES, v));
export const taskStatusValue = (v: unknown) => closed(TASK_STATUSES, v);

export function licenseReasonValue(reason: string | null): (typeof LICENSE_REASONS)[number] {
  if (reason === null) return 'none';
  if (reason.startsWith('invalid')) return 'invalid';
  return (LICENSE_REASONS as readonly string[]).includes(reason) ? reason as (typeof LICENSE_REASONS)[number] : 'other';
}

export function missionEndReasonValue(reason: string | null | undefined): (typeof MISSION_END_REASONS)[number] {
  if (!reason) return 'none';
  return (MISSION_END_REASONS as readonly string[]).includes(reason) ? reason as (typeof MISSION_END_REASONS)[number] : 'other';
}

export function platformValue(p: string = process.platform): GlobalProperties['platform'] {
  return p === 'linux' || p === 'darwin' || p === 'win32' ? p : 'other';
}

export function archValue(a: string = process.arch): GlobalProperties['arch'] {
  return a === 'x64' || a === 'arm64' || a === 'ia32' || a === 'arm' ? a : 'other';
}

export const LICENSE_TIERS = ['free', 'beta', 'trial', 'solo', 'developer', 'pro', 'team', 'business', 'enterprise', 'internal', 'lifetime'] as const;

/**
 * The plan's tier, from a closed list: every beta plan (`beta-1-year`,
 * `beta-lifetime`, `beta-expert`…) is `beta`. The licence key, its id and its
 * holder never leave.
 */
export function licenseTierValue(state: { status: string; planId?: string; localFree?: boolean }): string {
  if (state.localFree) return 'free';
  if (state.status !== 'valid') return 'unlicensed';
  const id = (state.planId ?? '').toLowerCase();
  if (id === 'beta' || id.startsWith('beta-')) return 'beta';
  return (LICENSE_TIERS as readonly string[]).includes(id) ? id : 'other';
}

export function versionValue(raw: string | null | undefined): string | null {
  return raw && SEMVER.test(raw) ? raw : null;
}
