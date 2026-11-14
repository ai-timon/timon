/**
 * Read side and rule removal of Timon's memory, shared by the HTTP routes, the
 * CLI / MCP tools that call them, and `ctx.memory` (`plugins/memory-facade.ts`).
 * Extracted verbatim from `plugins-bundled/memory/routes.ts`.
 */
import { dbApi, type DbViewer, type MemoryRuleRow } from './db.js';
import { emitMemoryRuleEvent, type PluginMemoryActor } from './memory-rule-events.js';
import { deleteMemoryRuleAndFence, reviseMemoryRule } from './memory-session-fence.js';
import { listProjects } from './projects.js';
import { settingNum } from './settings.js';
import { scopedDb } from './users/scoped-db.js';
import type { MemoryOverview, MemorySearchResult } from './plugins/contract/memory.js';
export type { MemoryOverview, MemorySearchResult } from './plugins/contract/memory.js';

/* Cross-cutting search through ALL of memory (DB) — serves as a "pull" tool for a
   supervisor (_main via `timon memory search`). Rules via FTS5 + learnings via
   LIKE, deduplicated. */
const SEARCH_SNIPPET = 240;

export function memoryOverview(viewer: DbViewer | null): MemoryOverview {
  const c = dbApi.memoryCounts();
  const pending = scopedDb(viewer).listPendingProposals();
  // `hash` = stringified id → keeps the contract of the accept/reject route
  // (the UI POSTing to /proposals/:hash keeps working unchanged).
  const proposals = pending.map((p) => ({
    id: p.id, hash: String(p.id), slug: p.project, scope: p.scope,
    kind: p.kind, text: p.text, rationale: p.rationale, count: p.cluster_size,
    ts: new Date(p.created_at).toISOString(),
  }));
  return {
    counts: { facts: c.learnings, pitfalls: c.pitfalls, rules: c.rules, pending: pending.length, projects: listProjects().length },
    proposals,
  };
}

/** `onlySource` restricts the hits to the rules carrying that `source` (a plugin's own). */
export function searchMemoryHits(rawQuery: string, onlySource?: string): MemorySearchResult {
  const q = String(rawQuery ?? '').trim();
  if (!q) return { q: '', count: 0, hits: [] };
  const hits = dbApi.searchMemory(q, settingNum('TIMON_MEMORY_SEARCH_CAP'), onlySource);
  const out = hits.map((h) => ({
    scope: h.scope, id: h.id, file: h.file, kind: h.kind,
    text: h.text.length > SEARCH_SNIPPET ? h.text.slice(0, SEARCH_SNIPPET) + '…' : h.text,
  }));
  return { q, count: out.length, truncated: out.length >= settingNum('TIMON_MEMORY_SEARCH_CAP'), hits: out };
}

/**
 * Deletes a rule, audits it, and fences the sessions of the agents it may have
 * reached (`memory-session-fence.ts`): `freshConversation` names them, their
 * next mission does not resume a session that still holds the rule.
 * `undefined` when the rule does not exist.
 */
export function removeMemoryRule(
  id: number,
  actor: PluginMemoryActor = { kind: 'manual', id: null },
): { rule: MemoryRuleRow; freshConversation: string[] } | undefined {
  const removed = deleteMemoryRuleAndFence(id);
  if (!removed) return undefined;
  const cur = removed.rule;
  dbApi.logMemoryAudit({
    scope: cur.scope, project: cur.project, agent: cur.agent,
    action: 'manual_delete', ruleId: id, candidateText: cur.text,
  });
  emitMemoryRuleEvent('memory_rule_removed', cur, actor);
  return removed;
}

/** `removeMemoryRule` for the callers that only need the deleted row. */
export function deleteMemoryRule(id: number, actor: PluginMemoryActor = { kind: 'manual', id: null }): MemoryRuleRow | undefined {
  return removeMemoryRule(id, actor)?.rule;
}

/**
 * Manual edit of a rule. An edit that takes something away from the agents
 * (text, audience, deactivation) fences the agents the OLD rule reached, as a
 * deletion does; `freshConversation` names them. `undefined` when the rule
 * does not exist.
 */
export function editMemoryRule(
  id: number,
  patch: Parameters<typeof dbApi.updateRule>[1],
): { rule: MemoryRuleRow; freshConversation: string[] } | undefined {
  return reviseMemoryRule(id, patch);
}
