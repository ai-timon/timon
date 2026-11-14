/**
 * One-shot backfill / cleanup of the EXISTING rule corpus (distinct from the
 * nightly curation that starts from raw facts). Per scope (a project, or the global
 * scope), the model is given ALL the active rules of the scope with their [id],
 * and it decides for each: update (re-tier / re-scope), merge (into another one),
 * archive (trivial/obsolete), or keep. Non-destructive: merge/archive set the
 * rule to `archived` (kept), never DELETE.
 *
 * Also serves to fix the historical problem of `global` rules that are in
 * fact project-specific (re-scope to the right project).
 *
 * Safety (see advisor): `dryRun` mode that RETURNS the decisions without writing
 * anything → pilot on 1 scope, inspection, THEN full. A `timon.db` snapshot to take
 * BEFORE, by the human. Per scope (never a single prompt over 924 rules).
 *
 * One-shot Sonnet under a CLI subscription (not the API). Triggered manually via
 * POST /api/memory/backfill — no nightly job.
 */
import { randomUUID } from 'node:crypto';
import { dbApi, type MemoryRuleRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent.js';
import { readMeta, listProjects } from './projects.js';
import { oneShotPrompt } from './summary.js';
import { getRole } from './agent-roles.js';
import { settingNum, settingStr } from './settings.js';
import { reviseMemoryRule } from './memory-session-fence.js';
import { oneShotTarget } from './backends/index.js';

const MAX_RULES_PER_SCOPE = 80; // bounds the prompt; beyond that, processed in batches

type BackfillAction = 'update' | 'merge' | 'archive' | 'keep';
export type BackfillDecision = {
  id: number;
  action: BackfillAction;
  tier?: 'core' | 'normal';
  scope?: 'project' | 'role' | 'global' | 'agent';
  project?: string | null;
  role?: string;
  intoId?: number;
  rationale?: string;
};

export type BackfillScopeResult = {
  scope: string;
  label: string;
  ruleCount: number;
  decisions: Array<BackfillDecision & { ruleText: string }>;
  applied: boolean;
  stats: { updated: number; merged: number; archived: number; kept: number };
};

const SYSTEM_PROMPT = `You are the CURATOR who CLEANS UP an existing corpus of memory rules (dev/ops). You are given every ACTIVE rule of a scope, each with [id], tier (core/normal) and support. For EACH rule, emit a decision:

- "keep": the rule is useful, well scoped, not redundant → change nothing.
- "update": the rule stays but changes "tier" and/or "scope" classification. Give the fields to change.
- "merge": DUPLICATE of another one in the batch → "into_id" (the id to keep). The current one is archived, its support carried over.
- "archive": trivial, obvious, obsolete, or contradicted by a better one → archived. For a contradiction, archive the WORSE one.

CLASSIFICATION (the most important part of this cleanup) — pick the right "scope":
- "role": a JOB rule (workflow/process of a role), valid for ALL projects. E.g. merge procedure, SHA capture, Kanban blocking, dispatch routing, review conventions → scope="role" + "role" = an id among: coder, reviewer, merger, orchestrator, ops, librarian, research. ⚠️ MANY rules currently under "global" or "project" are actually job rules: a merger of ANOTHER project needs them → "role":"merger". Re-scope them aggressively to "role".
- "project": specific to the CODE/domain of ONE project → scope="project" + "project"=<slug> from the list.
- "global": TRULY universal (all roles AND projects), rare.

Rules:
- Conservative on archive/merge (when in doubt, keep), but ACTIVE on role re-classification (that is the point).
- "core" sparingly (≤ ${settingNum('TIMON_MEMORY_CORE_CAP')}). Project slug EXACTLY from the list. "into_id" only if it is in the batch.

Produce ONLY a JSON array (omit the "keep" entries if you want it lighter):
[{"id":N,"action":"keep|update|merge|archive","tier":"core|normal","scope":"project|role|global","project":"slug-ou-null","role":"merger","into_id":N,"rationale":"…"}]`;

function baseCfg(slug: string | null): { name: string; cfg: AgentConfig } {
  let cfg: AgentConfig;
  try { cfg = loadConfig(settingStr('TIMON_MEMORY_SYNTH_AGENT')); } catch { cfg = {}; }
  const cwd = (slug ? readMeta(slug).cwd : null) ?? cfg.cwd;
  return { name: settingStr('TIMON_MEMORY_SYNTH_AGENT'), cfg: { ...cfg, ...oneShotTarget(settingStr('TIMON_MEMORY_SYNTH_MODEL')), cwd: cwd ?? undefined } };
}

function parseDecisions(out: string): BackfillDecision[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = (fenced ? fenced[1]! : out).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let arr: unknown;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out2: BackfillDecision[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const id = typeof o.id === 'number' ? o.id : undefined;
    const action = o.action;
    if (id === undefined) continue;
    if (action !== 'update' && action !== 'merge' && action !== 'archive' && action !== 'keep') continue;
    out2.push({
      id, action,
      tier: o.tier === 'core' ? 'core' : o.tier === 'normal' ? 'normal' : undefined,
      scope: o.scope === 'project' || o.scope === 'role' || o.scope === 'global' || o.scope === 'agent' ? o.scope : undefined,
      project: typeof o.project === 'string' ? o.project : o.project === null ? null : undefined,
      role: typeof o.role === 'string' ? o.role.trim() : undefined,
      intoId: typeof o.into_id === 'number' ? o.into_id : undefined,
      rationale: typeof o.rationale === 'string' ? o.rationale.trim() : undefined,
    });
  }
  return out2;
}

/** Backfill of ONE scope. `dryRun` → decisions returned, NO write. */
export async function backfillScope(
  scope: 'project' | 'global',
  slug: string | null,
  opts: { dryRun?: boolean; runId?: string } = {},
): Promise<BackfillScopeResult> {
  const label = slug ?? '(global)';
  const rules = (slug
    ? dbApi.listRules({ scope: 'project', project: slug })
    : dbApi.listRules({ scope: 'global', project: null })
  ).filter((r) => r.status === 'active').slice(0, MAX_RULES_PER_SCOPE);

  const empty: BackfillScopeResult = {
    scope, label, ruleCount: rules.length, decisions: [], applied: false,
    stats: { updated: 0, merged: 0, archived: 0, kept: 0 },
  };
  if (rules.length === 0) return empty;

  const validSlugs = new Set(listProjects().map((s) => s.toLowerCase()));
  const projectList = [...validSlugs].sort().join(', ');
  const corpus = rules.map((r) => `[${r.id}] (${r.tier}, support ${r.support}) ${r.text}`).join('\n');
  const userMsg = `# Valid projects (for re-scoping): ${projectList}\n\n# Rules of scope "${label}" to curate:\n${corpus}`;

  const { name, cfg } = baseCfg(slug);
  let outText: string;
  try {
    outText = await oneShotPrompt(name, cfg, userMsg, SYSTEM_PROMPT);
  } catch (err) {
    console.warn(`[memory-backfill] ${label}: extraction failed — ${(err as Error).message}`);
    return empty;
  }
  const byId = new Map(rules.map((r) => [r.id, r]));
  const decisions = parseDecisions(outText).filter((d) => byId.has(d.id));
  const withText = decisions.map((d) => ({ ...d, ruleText: byId.get(d.id)!.text }));

  if (opts.dryRun) {
    return { ...empty, decisions: withText, applied: false };
  }

  const runId = opts.runId ?? randomUUID();
  const stats = applyBackfillDecisions(decisions, rules, scope, slug, validSlugs, runId);
  return { ...empty, decisions: withText, applied: true, stats };
}

/** Applies the backfill decisions of one scope; logs each in memory_audit. */
export function applyBackfillDecisions(
  decisions: BackfillDecision[],
  rules: MemoryRuleRow[],
  scope: 'project' | 'global',
  slug: string | null,
  validSlugs: ReadonlySet<string>,
  runId: string,
): BackfillScopeResult['stats'] {
  const byId = new Map(rules.map((r) => [r.id, r]));
  // Archiving or re-scoping takes the rule away from agents it reached: they
  // start a fresh conversation (memory-session-fence.ts). A re-tier fences nobody.
  const fresh = (id: number, patch: Parameters<typeof dbApi.updateRule>[1]): void => {
    const agents = reviseMemoryRule(id, patch)?.freshConversation ?? [];
    if (agents.length) console.log(`[memory-backfill] rule #${id} changed — fresh conversation for ${agents.join(', ')}`);
  };
  let coreActive = rules.filter((r) => r.tier === 'core').length;
  const stats = { updated: 0, merged: 0, archived: 0, kept: 0 };
  for (const d of decisions) {
    const rule = byId.get(d.id)!;
    const audit = { runId, scope, project: slug, agent: null as string | null };
    if (d.action === 'keep') { stats.kept++; continue; }
    if (d.action === 'archive') {
      fresh(d.id, { status: 'archived' });
      dbApi.logMemoryAudit({ ...audit, action: 'archive', ruleId: d.id, candidateText: rule.text, rationale: d.rationale ?? null });
      stats.archived++;
      continue;
    }
    if (d.action === 'merge') {
      const into = d.intoId != null ? byId.get(d.intoId) : undefined;
      if (!into || into.id === d.id) { stats.kept++; continue; }
      dbApi.bumpRuleSupport(into.id, rule.support || 1);
      fresh(d.id, { status: 'archived' });
      dbApi.logMemoryAudit({ ...audit, action: 'merge', ruleId: d.id, targetRuleId: into.id, candidateText: rule.text, rationale: d.rationale ?? null });
      stats.merged++;
      continue;
    }
    // update: re-tier and/or re-scope.
    const patch: Parameters<typeof dbApi.updateRule>[1] = {};
    if (d.tier) {
      let tier = d.tier;
      if (tier === 'core' && coreActive >= settingNum('TIMON_MEMORY_CORE_CAP')) tier = 'normal';
      if (tier !== rule.tier) { patch.tier = tier; if (tier === 'core') coreActive++; }
    }
    if (d.scope) {
      if (d.scope === 'role') {
        // Domain re-classification: the heart of this cleanup.
        const role = (d.role ?? '').toLowerCase();
        if (role && getRole(role)) {
          patch.scope = 'role'; patch.role = role; patch.project = null; patch.agent = null;
        }
      } else if (d.scope === 'project') {
        const proj = (d.project ?? '').toLowerCase();
        if (proj && validSlugs.has(proj)) { patch.scope = 'project'; patch.project = proj; patch.role = null; patch.agent = null; }
      } else if (d.scope === 'global') {
        patch.scope = 'global'; patch.project = null; patch.role = null; patch.agent = null;
      }
    }
    if (Object.keys(patch).length === 0) { stats.kept++; continue; }
    fresh(d.id, patch);
    const act = patch.scope || patch.project !== undefined ? 'rescope' : 'retier';
    dbApi.logMemoryAudit({ ...audit, action: act, ruleId: d.id, candidateText: rule.text, rationale: d.rationale ?? null });
    stats.updated++;
  }
  return stats;
}

/**
 * Full or targeted backfill. `scope`/`project` to pilot (e.g. global first),
 * `dryRun` to inspect without writing. Without a target: all projects + global.
 */
export async function runBackfill(opts: {
  project?: string | null; onlyGlobal?: boolean; dryRun?: boolean;
} = {}): Promise<{ runId: string; scopes: BackfillScopeResult[] }> {
  const runId = randomUUID();
  const scopes: BackfillScopeResult[] = [];
  const targets: Array<{ scope: 'project' | 'global'; slug: string | null }> = [];
  if (opts.project) {
    targets.push({ scope: 'project', slug: opts.project });
  } else if (opts.onlyGlobal) {
    targets.push({ scope: 'global', slug: null });
  } else {
    targets.push({ scope: 'global', slug: null });
    for (const slug of listProjects()) targets.push({ scope: 'project', slug });
  }
  for (const t of targets) {
    try {
      scopes.push(await backfillScope(t.scope, t.slug, { dryRun: opts.dryRun, runId }));
    } catch (err) {
      console.error(`[memory-backfill] ${t.slug ?? '(global)'}: ${(err as Error).message}`);
    }
  }
  return { runId, scopes };
}
