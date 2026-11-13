/**
 * Turns bus events into catalogue events (`events.ts`). Reads ids, enums and
 * numbers out of what the core publishes; it never forwards a payload, a
 * name or a text. The mission facts it needs (backend, model, origin) are
 * looked up once per mission and mapped to closed lists right away, so the
 * cache never holds anything that could not be sent.
 *
 * Turns are counted from `turn_started` to `turn_complete`, keyed on the
 * mission: a second start while one is open is the same turn announced twice.
 * Tool calls are tallied per turn and sent once, at its end.
 */
import type { BusEvent } from '../../bus.js';
import { bestRateLimit } from '../../rate-limit.js';
import { parseReviewVerdict } from '../../review-verdict.js';
import { durationBucketOf, installAgeDaysOf, messageChannelOf, waitBucketOf, type Milestone } from './features.js';
import type { PluginPublic } from '../../plugins/public.js';
import {
  backendValue, licenseReasonValue, missionEndReasonValue, modelValue, originValue, taskPipelineValue,
  taskStatusValue, taskTypeValue, toolValue, type TelemetryEventName, type TurnOrigin,
} from './events.js';

export type MissionFacts = { backend: string; model: string; origin: TurnOrigin; child: boolean; channel: 'app' | 'external' | null };

export type TaskFacts = {
  type: string; pipeline: string | null; status: string;
  createdAt?: number; doneComment?: string | null; merged?: boolean;
};

export type CollectorDeps = {
  /** Backend, model and origin of a mission, already mapped; `null` when unknown. */
  missionFacts(missionId: string): MissionFacts | null;
  /** Type, pipeline and status of a task, raw; `null` when it is gone. */
  taskFacts(taskId: string): TaskFacts | null;
  now(): number;
  /** When the installation's identity was created (ms), `null` when unknown. */
  installCreatedAt?(): number | null;
  /** A first-time milestone was reached; the runtime keeps it from repeating. */
  milestone?(milestone: Milestone): void;
};

export type Emit = (name: TelemetryEventName, props: Record<string, unknown>) => void;

const MAX_OPEN_TURNS = 1_000;
const TURN_TTL_MS = 24 * 3_600_000;
const MAX_TOOLS_PER_TURN = 32;
const MAX_FACTS = 1_000;
const MAX_PENDING_PROMPTS = 500;
/** One `quota_reached` per backend and window in this span: a limit is reported by every event of the turn. */
const QUOTA_REPORT_GAP_MS = 30 * 60_000;
const SYSTEM_DECISIONS = new Set(['auto_timeout', 'mission_end', 'client_disconnected', 'payload_invalid']);

type PendingPrompt = { kind: 'question' | 'kanban_plan' | 'permission'; at: number; tool?: string };

function quotaWindowOf(window: string | null): 'five_hour' | 'seven_day' | 'other' {
  if (window?.startsWith('five_hour')) return 'five_hour';
  if (window?.startsWith('seven_day')) return 'seven_day';
  return 'other';
}

function promptKindOf(payload: Record<string, unknown>): PendingPrompt['kind'] {
  if (payload.tool_name !== 'ask_user') return 'permission';
  const form = (payload.input as { form?: { kind?: unknown } } | undefined)?.form;
  return form?.kind === 'series_plan' ? 'kanban_plan' : 'question';
}

type OpenTurn = { startedAt: number; tools: Map<string, number> };

/** The facts a mission had when the collector first met it. */
export function missionFactsFrom(
  row: {
    source_channel: string | null; task_id?: string | null; routine_id?: string | null;
    parent_mission_id?: string | null; workflow_run_id?: string | null;
  },
  backend: string | null,
  model: string | null,
  isCatalogModel: (backend: string, model: string) => boolean,
): MissionFacts {
  const b = backendValue(backend);
  return {
    backend: b,
    model: modelValue(backend ?? '', model, isCatalogModel),
    origin: originValue(row),
    child: Boolean(row.parent_mission_id),
    channel: messageChannelOf(row.source_channel),
  };
}

function numberOf(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

function contentBlocks(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object') return [];
  const p = payload as { message?: { content?: unknown }; content?: unknown };
  const content = p.message?.content ?? p.content;
  return Array.isArray(content) ? content : [];
}

export class TelemetryCollector {
  private readonly turns = new Map<string, OpenTurn>();
  private readonly facts = new Map<string, MissionFacts | null>();
  private plugins: Map<string, { state: string; source: 'bundled' | 'builtin' | 'third_party'; id: string }> | null = null;
  private licenseValid: boolean | null = null;
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly quotaReported = new Map<string, number>();

  constructor(private readonly deps: CollectorDeps, private readonly emit: Emit) {}

  /** Seeds the licence state so the first change is not read as an activation. */
  setInitialLicense(valid: boolean): void {
    this.licenseValid = valid;
  }

  handle(ev: BusEvent): void {
    switch (ev.kind) {
      case 'mission_started': return this.onMissionStarted(ev.missionId);
      case 'turn_started': return this.openTurn(ev.missionId, ev.at);
      case 'event': return this.onEvent(ev.missionId, ev.type, ev.payload);
      case 'turn_complete': return this.closeTurn(ev.missionId, ev.outcome ?? 'completed');
      case 'mission_complete': return this.onMissionComplete(ev);
      case 'task_created': return this.onTask(ev.taskId, 'created');
      case 'task_updated':
        if (ev.changed.includes('status')) this.onTask(ev.taskId, 'status_changed');
        return;
      case 'task_deleted':
        this.emit('task_action', {
          action: 'deleted', type: taskTypeValue(ev.task.type), pipeline: 'other', status: taskStatusValue(ev.task.status),
        });
        return;
      case 'plugins_changed': return this.onPlugins(ev.plugins);
      case 'license_changed': return this.onLicense(ev.status, ev.reason);
      case 'browser_recording': return this.emit('browser_action', { kind: 'recording', action: ev.event });
      case 'browser_annotation': return this.emit('browser_action', { kind: 'annotation', action: ev.event });
      case 'onboarding_step': return this.emit('onboarding_step', { step: ev.step, action: ev.action });
      default: return;
    }
  }

  private factsOf(missionId: string): MissionFacts | null {
    if (this.facts.has(missionId)) return this.facts.get(missionId) ?? null;
    const facts = this.deps.missionFacts(missionId);
    // A mission not there yet is not remembered as absent: its row may land after the event.
    if (facts) {
      if (this.facts.size >= MAX_FACTS) this.facts.delete(this.facts.keys().next().value as string);
      this.facts.set(missionId, facts);
    }
    return facts;
  }

  private onMissionStarted(missionId: string): void {
    // The facts are read fresh: a fork or a relaunch reuses nothing of a previous row.
    this.facts.delete(missionId);
    const f = this.factsOf(missionId);
    if (!f) return;
    this.emit('mission_spawned', { backend: f.backend, model: f.model, origin: f.origin, child: f.child });
  }

  private openTurn(missionId: string, at: number): void {
    if (this.turns.has(missionId)) return;
    this.prune();
    const f = this.factsOf(missionId);
    if (!f) return;
    this.turns.set(missionId, { startedAt: at, tools: new Map() });
    this.emit('turn_started', {
      backend: f.backend, model: f.model, origin: f.origin,
      ...(f.origin === 'user' && f.channel ? { channel: f.channel } : {}),
    });
  }

  private onEvent(missionId: string, type: string, payload: unknown): void {
    this.onQuota(missionId, type, payload);
    if (type === 'permission_request' || type === 'permission_resolved' || type === 'permission_expired') {
      this.onPrompt(missionId, type, payload);
      return;
    }
    if (type === 'assistant') {
      const turn = this.turns.get(missionId);
      if (!turn) return;
      for (const block of contentBlocks(payload)) {
        if (!block || typeof block !== 'object' || (block as { type?: unknown }).type !== 'tool_use') continue;
        const tool = toolValue((block as { name?: unknown }).name);
        if (!turn.tools.has(tool) && turn.tools.size >= MAX_TOOLS_PER_TURN) continue;
        turn.tools.set(tool, (turn.tools.get(tool) ?? 0) + 1);
      }
      return;
    }
    if (type === 'result') {
      // Outside a turn a `result` is a replay (a resume): its tokens were counted.
      if (!this.turns.has(missionId)) return;
      const usage = payload && typeof payload === 'object' ? (payload as { usage?: Record<string, unknown> }).usage : undefined;
      if (!usage || typeof usage !== 'object') return;
      const f = this.factsOf(missionId);
      if (!f) return;
      const props: Record<string, unknown> = { backend: f.backend, model: f.model, origin: f.origin };
      const input = numberOf(usage.input_tokens);
      const output = numberOf(usage.output_tokens);
      const cacheRead = numberOf(usage.cache_read_input_tokens);
      const reasoning = numberOf(usage.reasoning_tokens);
      if (input !== undefined) props.input_tokens = input;
      if (output !== undefined) props.output_tokens = output;
      if (cacheRead !== undefined) props.cache_read_tokens = cacheRead;
      if (reasoning !== undefined) props.reasoning_tokens = reasoning;
      // A usage record with no count says nothing; never sent as zeros.
      if (Object.keys(props).length > 3) this.emit('token_usage', props);
    }
  }

  private onQuota(missionId: string, type: string, payload: unknown): void {
    const hit = bestRateLimit([{ type, payload }]);
    if (!hit) return;
    const f = this.factsOf(missionId);
    if (!f) return;
    const window = quotaWindowOf(hit.window);
    const key = `${f.backend}:${window}:${hit.kind}`;
    const now = this.deps.now();
    if (now - (this.quotaReported.get(key) ?? -Infinity) < QUOTA_REPORT_GAP_MS) return;
    this.quotaReported.set(key, now);
    this.emit('quota_reached', { backend: f.backend, window, kind: hit.kind });
  }

  /** Questions and permission cards: how long the agent waited for a human, and what was decided. */
  private onPrompt(missionId: string, type: string, payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const p = payload as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : null;
    if (!id) return;
    const key = `${missionId}:${id}`;
    if (type === 'permission_request') {
      if (this.prompts.size >= MAX_PENDING_PROMPTS) this.prompts.delete(this.prompts.keys().next().value as string);
      const kind = promptKindOf(p);
      this.prompts.set(key, { kind, at: this.deps.now(), ...(kind === 'permission' ? { tool: toolValue(p.tool_name) } : {}) });
      return;
    }
    const pending = this.prompts.get(key);
    if (!pending) return;
    this.prompts.delete(key);
    const origin = typeof p.origin === 'string' ? p.origin : 'unknown';
    const decision = type === 'permission_expired' ? 'expired'
      : p.choice === 'paste' ? 'paste' : p.behavior === 'allow' ? 'allow' : 'deny';
    this.emit('user_prompt_answered', {
      kind: pending.kind,
      decision,
      resolved_by: type === 'permission_expired' || SYSTEM_DECISIONS.has(origin) ? 'system' : origin === 'unknown' ? 'other' : 'user',
      wait: waitBucketOf(Math.max(0, this.deps.now() - pending.at)),
      ...(pending.tool ? { tool: pending.tool } : {}),
    });
  }

  private closeTurn(missionId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted'): void {
    const turn = this.turns.get(missionId);
    if (!turn) return;
    this.turns.delete(missionId);
    const f = this.factsOf(missionId);
    if (!f) return;
    const at = this.deps.now();
    const duration = Math.max(0, at - turn.startedAt);
    const createdAt = this.deps.installCreatedAt?.() ?? null;
    this.emit('turn_completed', {
      backend: f.backend, model: f.model, origin: f.origin, status, duration_ms: duration,
      // Omitted, never guessed, for an installation older than `createdAt`.
      ...(createdAt !== null ? { install_age_days: installAgeDaysOf(createdAt, at) } : {}),
    });
    if (status === 'completed') this.deps.milestone?.('first_turn_completed');
    for (const [tool, count] of turn.tools) this.emit('tool_used', { backend: f.backend, tool, count });
  }

  private onMissionComplete(ev: Extract<BusEvent, { kind: 'mission_complete' }>): void {
    if (this.turns.has(ev.missionId)) this.closeTurn(ev.missionId, ev.status === 'completed' ? 'completed' : 'interrupted');
    const f = this.factsOf(ev.missionId);
    if (f) this.emit('mission_ended', { origin: f.origin, status: ev.status, reason: missionEndReasonValue(ev.reason ?? null) });
    this.facts.delete(ev.missionId);
  }

  private onTask(taskId: string, action: 'created' | 'status_changed'): void {
    const t = this.deps.taskFacts(taskId);
    if (!t) return;
    this.emit('task_action', {
      action, type: taskTypeValue(t.type), pipeline: taskPipelineValue(t.pipeline), status: taskStatusValue(t.status),
    });
    if (action === 'status_changed' && taskStatusValue(t.status) === 'done') {
      const type = taskTypeValue(t.type);
      const verdict = type !== 'review' ? 'none' : parseReviewVerdict(t.doneComment ?? null).verdict;
      this.emit('task_completed', {
        type, pipeline: taskPipelineValue(t.pipeline),
        duration: durationBucketOf(Math.max(0, this.deps.now() - (t.createdAt ?? this.deps.now()))),
        verdict: verdict === 'pass' || verdict === 'changes_requested' || verdict === 'none' ? verdict : 'unknown',
        merged: Boolean(t.merged),
      });
      this.deps.milestone?.('first_task_done');
    }
  }

  /** Takes the plugin list as it stands, without reporting anything, if none is known yet. */
  seedPlugins(list: readonly PluginPublic[]): void {
    if (!this.plugins) this.onPlugins(list);
  }

  /**
   * Two publishers, two scopes: the bundled reconciler sends the whole gallery
   * (bundled modules always in it), the package loader its packages only. A
   * list without any bundled module is the loader's, and says nothing about
   * the bundled ones: only packages can have been removed from it.
   */
  private onPlugins(list: readonly PluginPublic[]): void {
    type Row = { state: string; source: 'bundled' | 'builtin' | 'third_party'; id: string };
    const next = new Map<string, Row>();
    for (const p of list) {
      const source = p.source === 'bundled' ? 'bundled' : p.builtin ? 'builtin' : 'third_party';
      // A third-party id is a name someone chose: it never leaves, whatever it looks like.
      next.set(p.id, { state: p.state, source, id: source === 'third_party' ? 'third_party' : p.id });
    }
    const whole = list.some((p) => p.source === 'bundled');
    const previous = this.plugins;
    const merged = new Map<string, Row>(whole || !previous ? [] : [...previous].filter(([, row]) => row.source === 'bundled'));
    for (const [key, row] of next) merged.set(key, row);
    this.plugins = merged;
    // The first list after start is the baseline, not a wave of installs.
    if (!previous) return;
    for (const [key, cur] of next) {
      const before = previous.get(key);
      if (!before) { this.emit('plugin_action', { action: 'install', plugin: cur.id, source: cur.source }); continue; }
      const wasOn = before.state === 'active';
      const isOn = cur.state === 'active';
      if (wasOn && !isOn && cur.state === 'disabled') this.emit('plugin_action', { action: 'disable', plugin: cur.id, source: cur.source });
      if (!wasOn && isOn && before.state === 'disabled') this.emit('plugin_action', { action: 'enable', plugin: cur.id, source: cur.source });
    }
    for (const [key, before] of previous) {
      if (next.has(key) || (!whole && before.source === 'bundled')) continue;
      this.emit('plugin_action', { action: 'remove', plugin: before.id, source: before.source });
    }
  }

  /**
   * The licence as the runtime holds it, read on every tick: an activation
   * from the licence page installs the token without a bus event. Only a
   * change of status counts; the bus reports renewals.
   */
  observeLicense(valid: boolean, reason: string | null): void {
    if (this.licenseValid === null) { this.licenseValid = valid; return; }
    if (valid === this.licenseValid) return;
    this.onLicense(valid ? 'valid' : 'unlicensed', reason);
  }

  private onLicense(status: 'valid' | 'unlicensed', reason: string | null): void {
    const was = this.licenseValid;
    const valid = status === 'valid';
    this.licenseValid = valid;
    if (valid && was === false) this.emit('license_action', { action: 'activated', reason: 'none' });
    else if (!valid && was !== false) this.emit('license_action', { action: 'expired', reason: licenseReasonValue(reason) });
    else if (valid && was === true) this.emit('license_action', { action: 'refreshed', reason: licenseReasonValue(reason) });
  }

  private prune(): void {
    const now = this.deps.now();
    for (const [id, turn] of this.turns) if (now - turn.startedAt > TURN_TTL_MS) this.turns.delete(id);
    while (this.turns.size >= MAX_OPEN_TURNS) this.turns.delete(this.turns.keys().next().value as string);
  }
}
