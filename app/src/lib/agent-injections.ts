/**
 * What the daemon says an agent is injected at spawn
 * (`GET /api/agents/:name/injections`), and how an edit reaches the real source.
 *
 * The app is a separate package from the daemon, so the shapes are restated
 * here; the daemon validates its answer with zod before sending it.
 */

export type EditTarget =
  | { kind: 'agent_file'; agent: string; path: string }
  | { kind: 'global_instructions' }
  | { kind: 'agent_config'; agent: string; field: 'directives' }
  | { kind: 'agent_role'; role_id: string }
  | { kind: 'memory_rule'; rule_id: number }
  | { kind: 'skill'; skill_id: string };

/** Which part of the product a block comes from. */
export type InjectionOrigin = 'timon' | 'user' | 'agent' | 'memory' | 'skills' | 'project';

export type InjectionItem = {
  id: string;
  label: string;
  content: string;
  tokens: number;
  source_path: string | null;
  editable: boolean;
  editable_text: string | null;
  edit_target: EditTarget | null;
  /** A skill entry: pasted whole (`import`) or one catalogue line (`include`). */
  skill_mode?: 'include' | 'import' | null;
  /** Where that skill comes from: an attachment scope, the agent's config, or the code. */
  skill_via?: 'global' | 'project' | 'role' | 'agent' | 'config' | 'code' | null;
  /** Attached to the catalogue, but pasted whole: this backend has no way to read a skill on demand. */
  skill_promoted?: boolean;
  /** A catalogue skill: what reading its body with `skill_get` costs, paid only if the agent reads it. */
  on_demand_tokens?: number | null;
};

export type InjectionBlock = {
  id: string;
  source: string;
  origin: InjectionOrigin;
  source_path: string | null;
  tokens: number;
  injected_by: 'timon' | 'cli';
  order: number;
  label: string;
  content: string;
  truncated: boolean;
  redacted: boolean;
  /** The secret is masked in what the model receives too; a daemon that does not say it masks only the view. */
  sent_masked?: boolean;
  editable: boolean;
  editable_text: string | null;
  edit_target: EditTarget | null;
  items: InjectionItem[];
};

export type AgentInjections = {
  agent: string;
  backend: string;
  blocks: InjectionBlock[];
  prompt_chars: number;
  prompt_tokens: number;
  /** What reading every catalogue skill would add: information, never part of `prompt_tokens`. */
  on_demand_tokens?: number;
};

export type SaveRequest = {
  method: 'PUT' | 'PATCH' | 'POST';
  url: string;
  headers: Record<string, string>;
  body: string;
};

const JSON_HEADERS = { 'content-type': 'application/json' };

/**
 * The write that saves `text` into the source `target` names — through the
 * route that already owns that source, never into a copy held by the view.
 */
export function saveRequest(target: EditTarget, text: string): SaveRequest {
  switch (target.kind) {
    case 'agent_file':
      return {
        method: 'PUT',
        url: `/api/ui/agents/${encodeURIComponent(target.agent)}/files?path=${encodeURIComponent(target.path)}`,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
      };
    case 'global_instructions':
      return {
        method: 'PUT',
        url: '/api/ui/global-instructions',
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        body: text,
      };
    case 'agent_config':
      return {
        method: 'PATCH',
        url: `/api/ui/agents/${encodeURIComponent(target.agent)}/config`,
        headers: JSON_HEADERS,
        body: JSON.stringify({ [target.field]: text }),
      };
    case 'agent_role':
      return {
        method: 'PUT',
        url: `/api/ui/agent-roles/${encodeURIComponent(target.role_id)}`,
        headers: JSON_HEADERS,
        body: JSON.stringify({ default_directives: text }),
      };
    case 'memory_rule':
      return {
        method: 'PATCH',
        url: `/api/ui/memory/rules/${target.rule_id}`,
        headers: JSON_HEADERS,
        body: JSON.stringify({ text }),
      };
    case 'skill':
      return {
        method: 'POST',
        url: '/api/ui/skills',
        headers: JSON_HEADERS,
        body: JSON.stringify({ id: target.skill_id, content: text }),
      };
  }
}

/**
 * Agents an edit of a memory rule sends to a fresh conversation: their earlier
 * session still held the old rule (`fresh_conversation` in the daemon's answer).
 * Empty for any other answer.
 */
export function freshConversationAgents(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const agents = (body as { fresh_conversation?: unknown }).fresh_conversation;
  return Array.isArray(agents) ? agents.filter((a): a is string => typeof a === 'string') : [];
}

/** Why a block cannot be edited, as a locale key suffix (`agentInjections.why.*`). */
export function whyNotEditable(block: Pick<InjectionBlock, 'editable' | 'redacted' | 'injected_by' | 'items'>): 'redacted' | 'cli' | 'code' | null {
  if (block.editable) return null;
  if (block.redacted) return 'redacted';
  if (block.injected_by === 'cli') return 'cli';
  return block.items.length > 0 ? null : 'code';
}

/** What masking a block means for the agent, as a locale key suffix (`agentInjections.masking.*`). */
export function maskingNotice(block: Pick<InjectionBlock, 'redacted' | 'sent_masked' | 'injected_by'>): 'sent' | 'cli' | 'shown' | null {
  if (!block.redacted) return null;
  if (block.sent_masked) return 'sent';
  return block.injected_by === 'cli' ? 'cli' : 'shown';
}

/** A token count short enough for a badge: 850, 1.2k, 21k. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  const k = n / 1000;
  return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
}

/** Tokens per origin, heaviest first: where the context sent before the first message comes from. */
export function tokensByOrigin(blocks: Pick<InjectionBlock, 'origin' | 'tokens' | 'injected_by'>[]): { origin: InjectionOrigin; tokens: number }[] {
  const totals = new Map<InjectionOrigin, number>();
  // A file the CLI may read is a candidate, not part of what Timon sends.
  for (const b of blocks) if (b.injected_by === 'timon') totals.set(b.origin, (totals.get(b.origin) ?? 0) + b.tokens);
  return [...totals].map(([origin, tokens]) => ({ origin, tokens })).sort((a, b) => b.tokens - a.tokens);
}

/** Skill reads by an agent's missions (`GET /api/agents/:name/skill-reads`): a minimum, a read Timon cannot see is not counted. */
export type SkillReads = {
  window_days: number;
  /** Missions of the agent in the window, among those the viewer sees. */
  missions: number;
  /** Those that ran on a backend without `skill_get`. */
  unmeasured_missions: number;
  /** Per skill id; a skill never read is absent. */
  skills: Record<string, { reads: number; missions: number }>;
};

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** The daemon's answer, or null when it is not one (an older daemon, an error body). */
export function parseSkillReads(value: unknown): SkillReads | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (!isCount(v.window_days) || !isCount(v.missions) || !v.skills || typeof v.skills !== 'object') return null;
  const skills: SkillReads['skills'] = {};
  for (const [id, s] of Object.entries(v.skills as Record<string, unknown>)) {
    const e = s as Record<string, unknown> | null;
    if (e && isCount(e.reads) && isCount(e.missions)) skills[id] = { reads: e.reads, missions: e.missions };
  }
  // Absent from an older daemon, which counted every mission as measured.
  const unmeasured = isCount(v.unmeasured_missions) ? v.unmeasured_missions : 0;
  return { window_days: v.window_days, missions: v.missions, unmeasured_missions: unmeasured, skills };
}

/**
 * How a catalogue skill fares: `never` when missions ran in the window and
 * none read it — its description does not make the agent reach for it.
 * `idle` when no mission ran, `unmeasured` when all of them ran on a backend
 * without `skill_get`: nothing to conclude from a silence.
 */
export type SkillReadState =
  | { kind: 'idle'; days: number }
  | { kind: 'unmeasured'; days: number }
  | { kind: 'never'; total: number; days: number }
  | { kind: 'read'; reads: number; missions: number; total: number; days: number };

export function skillReadState(reads: SkillReads, skillId: string): SkillReadState {
  const days = reads.window_days;
  if (reads.missions === 0) return { kind: 'idle', days };
  const s = reads.skills[skillId];
  if (!s || s.reads === 0) {
    const measured = reads.missions - reads.unmeasured_missions;
    return measured > 0 ? { kind: 'never', total: measured, days } : { kind: 'unmeasured', days };
  }
  return { kind: 'read', reads: s.reads, missions: s.missions, total: reads.missions, days };
}

/** The catalogue skills of a block (mode `include`) no mission read in the window. */
export function neverReadSkills(block: Pick<InjectionBlock, 'items'>, reads: SkillReads | null): string[] {
  if (!reads) return [];
  return block.items
    .filter((it) => it.skill_mode === 'include' && skillReadState(reads, it.label).kind === 'never')
    .map((it) => it.label);
}
