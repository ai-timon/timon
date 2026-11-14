/**
 * Memory curator (mechanism 3/3). NIGHTLY job: per project (null slug =
 * cross-project → global rules), reads the raw facts (status `raw`), gives the
 * "smart" model (Sonnet) THE EXISTING CORPUS (with ids) + the facts, and
 * asks it for DECISIONS that are applied automatically (full-auto):
 *   - new       : a really new & actionable rule → inserted active
 *   - merge     : duplicate of an existing rule → +support (optionally refined text)
 *   - supersede : contradicts/replaces an existing rule → new one active +
 *                 the old one goes `superseded` (non-destructive, kept)
 *   - reject    : trivial / "goes without saying" / low value → nothing, traced
 * Each decision is logged in memory_audit (reversible). The human no longer
 * validates each line: they receive a digest and can veto afterwards.
 *
 * Economy: one Sonnet one-shot per project, once a night, on compact facts (not
 * the transcripts). Spread over the credit window. Runs under a CLI subscription
 * (not the API). Gating: TIMON_MEMORY_SYNTH_ENABLED != '0' (ON by default).
 */
import { randomUUID } from 'node:crypto';
import { dbApi, type LearningRow, type MemoryRuleRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent.js';
import { readMeta } from './projects.js';
import { oneShotPrompt } from './summary.js';
import { getRole } from './agent-roles.js';
import { settingBool, settingNum, settingStr } from './settings.js';
import { reviseMemoryRule, supersedeMemoryRule } from './memory-session-fence.js';
import { oneShotTarget } from './backends/index.js';

const MAX_DECISIONS = 24;
const TICK_MS = 30 * 60_000; // checks the window every 30 min

type Action = 'new' | 'merge' | 'supersede' | 'reject';
type RuleScope = 'project' | 'role' | 'agent' | 'global';
type Decision = {
  action: Action;
  kind?: string;          // decision | pitfall | preference (new/supersede)
  text?: string;          // text of the rule (new/supersede; merge if refined)
  tier?: 'core' | 'normal';
  ruleScope?: RuleScope;  // classification: project | role | agent | global
  role?: string;          // if ruleScope='role': the targeted trade (merger, coder…)
  targetId?: number;      // existing rule targeted (merge/supersede)
  rationale?: string;
  clusterSize?: number;   // nb de faits couverts (→ support)
};

const CURATOR_SYSTEM_PROMPT = `You are the CURATOR of the memory of an agent system (dev/ops). Comparing against the WHOLE existing corpus, you decide what deserves to come in or to change.

For ONE scope you are given: (1) the EXISTING RULES with their [id], support and tier, and (2) recent RAW FACTS (each prefixed with the ROLE of the agent that produced it).

For each insight drawn from the facts, emit ONE decision:
- "new": a truly NEW, durable and ACTIONABLE insight, missing from the corpus. Give "text" (an imperative, self-contained, concise rule, written in the language the facts are written in), "kind", "tier", "cluster_size", and ITS CLASSIFICATION "rule_scope" (see below).
- "merge": the insight restates an existing rule → "target_id" of that rule. If you can REFINE it, also give "text"; otherwise omit "text".
- "supersede": the insight CONTRADICTS / replaces an existing rule that became wrong → "target_id" (the old one) + "text"/"kind"/"tier"/"rule_scope" (the new one that replaces it).
- "reject": trivial, obvious, "goes without saying", derivable from git/common sense, or already covered → "rationale". Do NOT clutter the memory with platitudes.

CLASSIFICATION "rule_scope" — DECISIVE, it is the heart of your mission:
- "role": the rule is about a JOB (the work of a role), not a specific project. E.g. merge procedure, SHA capture, Kanban blocking, dispatch routing → they apply to ALL agents of that role, whatever the project. Also give "role" = the id of the targeted role among: coder, reviewer, merger, orchestrator, ops, librarian, research. → THIS IS THE MOST FREQUENT CASE for workflow/process rules.
- "project": the rule is specific to the CODE/domain of ONE project (API, schema, conventions of that repo).
- "global": TRULY universal, all roles AND all projects (rare).
- "agent": specific to a single named agent (rare).
Always ask yourself: "would a merger of ANOTHER project need this rule?" If yes → "role":"merger". Do NOT put a job rule under "project" just because the fact comes from that project.

QUALITY over quantity:
- Reject the trivial and the redundant aggressively. Better 2 useful rules than 20 flat ones.
- Detect DUPLICATES (→ merge) and CONTRADICTIONS (→ supersede), never let two rules contradict each other.
- "tier"="core" ONLY for a FUNDAMENTAL rule. Sparingly (≤ ${settingNum('TIMON_MEMORY_CORE_CAP')}).
- PITFALLS come first: phrase the actionable PREVENTIVE rule. Invent nothing beyond the facts. Reference a "target_id" ONLY if it exists.

Produce ONLY a JSON array, nothing else:
[{"action":"new|merge|supersede|reject","kind":"decision|pitfall|preference","text":"…","tier":"core|normal","rule_scope":"project|role|global|agent","role":"merger","target_id":N,"cluster_size":N,"rationale":"…"}]
At most ${MAX_DECISIONS} decisions. If nothing deserves action: answer exactly "[]".`;

function parseDecisions(out: string): Decision[] {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(out);
  const body = (fenced ? fenced[1]! : out).trim();
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  let arr: unknown;
  try { arr = JSON.parse(body.slice(start, end + 1)); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out2: Decision[] = [];
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const o = it as Record<string, unknown>;
    const action = o.action;
    if (action !== 'new' && action !== 'merge' && action !== 'supersede' && action !== 'reject') continue;
    const kind = o.kind === 'decision' || o.kind === 'pitfall' || o.kind === 'preference' ? o.kind : undefined;
    const text = typeof o.text === 'string' ? o.text.trim() : undefined;
    const tier = o.tier === 'core' ? 'core' : 'normal';
    const targetId = typeof o.target_id === 'number' ? o.target_id : undefined;
    const rs = o.rule_scope;
    const ruleScope: RuleScope | undefined =
      rs === 'project' || rs === 'role' || rs === 'agent' || rs === 'global' ? rs : undefined;
    const role = typeof o.role === 'string' ? o.role.trim() : undefined;
    // Consistency guards: new/supersede require a text; merge/supersede a target.
    if ((action === 'new' || action === 'supersede') && !text) continue;
    if ((action === 'merge' || action === 'supersede') && targetId === undefined) continue;
    out2.push({
      action, kind, text, tier, targetId, ruleScope, role,
      rationale: typeof o.rationale === 'string' ? o.rationale.trim() : undefined,
      clusterSize: typeof o.cluster_size === 'number' ? o.cluster_size : undefined,
    });
    if (out2.length >= MAX_DECISIONS) break;
  }
  return out2;
}

function baseCfg(slug: string | null): { name: string; cfg: AgentConfig } {
  let cfg: AgentConfig;
  try { cfg = loadConfig(settingStr('TIMON_MEMORY_SYNTH_AGENT')); } catch { cfg = {}; }
  const cwd = (slug ? readMeta(slug).cwd : null) ?? cfg.cwd;
  return { name: settingStr('TIMON_MEMORY_SYNTH_AGENT'), cfg: { ...cfg, ...oneShotTarget(settingStr('TIMON_MEMORY_SYNTH_MODEL')), cwd: cwd ?? undefined } };
}

/** Renders the facts grouped by type — pitfalls first (preventive rules). */
function renderByKind(rows: LearningRow[]): string {
  const titles: Record<string, string> = {
    pitfall: 'Pitfalls met (→ phrase the preventive rule)',
    decision: 'Decisions taken',
    preference: 'Preferences expressed',
  };
  const sections: string[] = [];
  for (const kind of ['pitfall', 'decision', 'preference'] as const) {
    const items = rows.filter((r) => r.kind === kind);
    if (!items.length) continue;
    sections.push(`## ${titles[kind]}\n` + items.map((r, i) => `${i + 1}. [role:${r.role || '?'}] ${r.text}`).join('\n'));
  }
  return sections.join('\n\n');
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function logFresh(ruleId: number, agents: string[]): void {
  if (agents.length) console.log(`[memory-synth] rule #${ruleId} changed — fresh conversation for ${agents.join(', ')}`);
}

type CurationStats = { added: number; merged: number; superseded: number; rejected: number };

/**
 * Applies the curator's decisions. `existing` serves to validate the target_ids
 * (anti-hallucination). Logs each decision in memory_audit.
 * Exported for reuse by the backfill (Phase 4).
 */
export function applyCuration(
  decisions: Decision[],
  scope: 'project' | 'global' | 'agent',
  slug: string | null,
  agent: string | null,
  existing: MemoryRuleRow[],
  runId: string,
): CurationStats {
  const stats: CurationStats = { added: 0, merged: 0, superseded: 0, rejected: 0 };
  const byId = new Map(existing.map((r) => [r.id, r]));
  let coreActive = existing.filter((r) => r.tier === 'core' && r.status === 'active').length;

  for (const d of decisions) {
    const auditBase = { runId, scope, project: slug, agent };
    if (d.action === 'reject') {
      dbApi.logMemoryAudit({ ...auditBase, action: 'reject', candidateText: d.text ?? null, rationale: d.rationale ?? null });
      stats.rejected++;
      continue;
    }
    if (d.action === 'merge') {
      const target = d.targetId != null ? byId.get(d.targetId) : undefined;
      if (!target) continue; // hallucinated target → ignored
      dbApi.bumpRuleSupport(target.id, d.clusterSize ?? 1);
      // A merge that rewords the rule takes the old wording away: the agents
      // it reached start a fresh conversation (memory-session-fence.ts).
      if (d.text && d.text !== target.text) logFresh(target.id, reviseMemoryRule(target.id, { text: d.text })?.freshConversation ?? []);
      dbApi.logMemoryAudit({ ...auditBase, action: 'merge', targetRuleId: target.id, candidateText: d.text ?? null, rationale: d.rationale ?? null });
      stats.merged++;
      continue;
    }
    // new / supersede: an active rule is inserted, respecting the
    // curator's CLASSIFICATION (project | role | agent | global), with safe
    // fallbacks when the pass lacks the info (e.g. invalid role, or 'agent' scope
    // asked by the nightly pass which has no precise agent).
    let effScope: RuleScope = d.ruleScope ?? scope;
    let project: string | null = slug;
    let ruleAgent: string | null = agent;
    let role: string | null = null;
    if (effScope === 'role') {
      if (d.role && getRole(d.role)) { role = d.role; project = null; ruleAgent = null; }
      else effScope = slug ? 'project' : 'global'; // invalid role → fallback
    }
    if (effScope === 'agent' && !ruleAgent) effScope = slug ? 'project' : 'global';
    if (effScope === 'project' && !project) effScope = 'global';
    if (effScope === 'project') { ruleAgent = null; role = null; }
    if (effScope === 'global') { project = null; ruleAgent = null; role = null; }
    let tier = d.tier ?? 'normal';
    if (tier === 'core' && coreActive >= settingNum('TIMON_MEMORY_CORE_CAP')) tier = 'normal'; // hard cap of the core tier
    const newId = dbApi.insertRule({
      scope: effScope, project, agent: ruleAgent, role, kind: d.kind ?? 'pitfall', text: d.text!,
      source: 'synthesis', tier, status: 'active', support: d.clusterSize ?? 1,
      supersedes: d.action === 'supersede' ? d.targetId ?? null : null,
    });
    if (tier === 'core') coreActive++;
    if (d.action === 'supersede' && d.targetId != null && byId.has(d.targetId)) {
      logFresh(d.targetId, supersedeMemoryRule(d.targetId, newId));
      dbApi.logMemoryAudit({ ...auditBase, action: 'supersede', ruleId: newId, targetRuleId: d.targetId, candidateText: d.text ?? null, rationale: d.rationale ?? null });
      stats.superseded++;
    } else {
      dbApi.logMemoryAudit({ ...auditBase, action: 'new', ruleId: newId, candidateText: d.text ?? null, rationale: d.rationale ?? null });
      stats.added++;
    }
  }
  return stats;
}

/** Curation of a scope (null slug = cross-project → global rules). */
async function curateProject(slug: string | null): Promise<void> {
  const all = dbApi.listRawLearnings(slug);
  if (all.length < settingNum('TIMON_MEMORY_SYNTH_MIN_FACTS')) return;
  const rows = all.slice(0, settingNum('TIMON_MEMORY_SYNTH_MAX_FACTS'));
  const label = slug ?? '(global)';
  const scope: 'project' | 'global' = slug ? 'project' : 'global';

  // Existing ACTIVE corpus of the scope, with ids/tier/support → the curator can
  // reference an id for merge/supersede.
  const existing = (slug
    ? dbApi.listRules({ scope: 'project', project: slug })
    : dbApi.listRules({ scope: 'global', project: null })
  ).filter((r) => r.status === 'active').slice(0, 60);

  const corpusBlock = existing.length
    ? `# Existing corpus (reference an [id] for merge/supersede):\n${existing
        .map((r) => `[${r.id}] (${r.tier}, support ${r.support}) ${r.text}`)
        .join('\n')}\n\n`
    : '# Existing corpus: (empty)\n\n';
  const userMsg = `${corpusBlock}# Recent raw facts — scope ${label}\n\n${renderByKind(rows)}`;

  const { name, cfg } = baseCfg(slug);
  let out: string;
  try {
    out = await oneShotPrompt(name, cfg, userMsg, CURATOR_SYSTEM_PROMPT);
  } catch (err) {
    console.warn(`[memory-curate] ${label}: extraction failed — ${(err as Error).message}`);
    return;
  }
  const decisions = parseDecisions(out);

  // Consumed facts → synthesized (even with 0 decisions: analysed, no point
  // submitting them again).
  dbApi.markLearningsSynthesized(rows.map((r) => r.id));
  if (decisions.length === 0) {
    console.log(`[memory-curate] ${label}: ${rows.length} facts analysed, 0 decision`);
    return;
  }

  const runId = randomUUID();
  const stats = applyCuration(decisions, scope, slug, null, existing, runId);
  const touched = stats.added + stats.merged + stats.superseded;
  if (touched === 0 && stats.rejected === decisions.length) {
    console.log(`[memory-curate] ${label}: ${rows.length} facts → all rejected (${stats.rejected})`);
    return;
  }
  // Digest (no gate): the human can veto afterwards through /memory.
  if (touched > 0) {
    dbApi.createNotification({
      id: randomUUID(),
      type: 'report',
      title: `Memory curated — ${label}`,
      body: `+${stats.added} rule(s), ${stats.merged} merge(s), ${stats.superseded} replaced, ${stats.rejected} rejected. You can veto them in /memory.`,
      // Anchor to THIS pass: /memory opens the detail of the run's decisions
      // (rules added/merged/rejected) instead of the whole corpus. The
      // run_id is the one set on the memory_audit rows by applyCuration.
      anchor: `/memory?run=${runId}`,
    });
  }
  console.log(`[memory-curate] ${label}: ${rows.length} facts → +${stats.added} new, ${stats.merged} merge, ${stats.superseded} supersede, ${stats.rejected} reject`);
}

async function runSynthesisPass(): Promise<void> {
  const slugs = dbApi.projectsWithRawLearnings();
  if (!slugs.length) return;
  console.log(`[memory-curate] nightly pass: ${slugs.length} target(s) with raw facts`);
  for (const slug of slugs) {
    try { await curateProject(slug); } catch (err) {
      console.error(`[memory-curate] error ${slug ?? '(global)'}: ${(err as Error).message}`);
    }
    await delay(settingNum('TIMON_MEMORY_SYNTH_SPACING_MS')); // credit spacing
  }
}

export function startMemorySynthesizer(): () => void {
  if (!settingBool('TIMON_MEMORY_SYNTH_ENABLED')) {
    console.log('[memory-curate] disabled (TIMON_MEMORY_SYNTH_ENABLED=0)');
    return () => { /* nothing was started */ };
  }
  let lastRunDay = '';
  const tick = () => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const h = now.getHours();
    if (day === lastRunDay) return;
    if (h < settingNum('TIMON_MEMORY_SYNTH_HOUR') || h >= settingNum('TIMON_MEMORY_SYNTH_HOUR') + settingNum('TIMON_MEMORY_SYNTH_WINDOW_H')) return;
    lastRunDay = day;
    runSynthesisPass().catch((err) => console.error(`[memory-curate] pass failed: ${(err as Error).message}`));
  };
  const timer = setInterval(tick, TICK_MS);
  console.log(`[memory-curate] active (window ${settingNum('TIMON_MEMORY_SYNTH_HOUR')}h–${settingNum('TIMON_MEMORY_SYNTH_HOUR') + settingNum('TIMON_MEMORY_SYNTH_WINDOW_H')}h, model ${settingStr('TIMON_MEMORY_SYNTH_MODEL')})`);
  return () => clearInterval(timer);
}

/** Triggers an immediate pass (debug / manual test via endpoint). */
export async function runSynthesisNow(): Promise<void> {
  await runSynthesisPass();
}
