/**
 * A memory rule outlives its removal in every provider session that saw it.
 *
 * The rule reaches an agent through its system prompt, rebuilt at each spawn
 * (`collectMemoryInjection`), but a new mission resumes the agent's latest
 * session by default, and that session's history still holds the old prompt
 * and whatever the agent did because of it. Removing or rewriting a rule
 * therefore fences every agent it may have reached: from then on, a new
 * mission of those agents starts a fresh conversation instead of resuming a
 * session born before the fence (`dbApi.sessionFenced`, checked by
 * `resolveSpawnResume` for every backend alike).
 *
 * "May have reached" mirrors the recall's visibility filter (`searchRules`):
 * the agent itself for an agent rule, the agents of the project, of the role
 * (across projects or in the rule's project), every agent for a global rule.
 *
 * Every change of a stored rule goes through the doors below
 * (`reviseMemoryRule`, `supersedeMemoryRule`, `deleteMemoryRuleAndFence`),
 * whoever makes it: a person, a plugin, the nightly synthesis or the backfill.
 * A direct `dbApi.updateRule` / `supersedeRule` / `deleteRule` elsewhere would
 * change what the agents are told without fencing what they were told before;
 * `memory-session-fence.test.ts` keeps them here.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './agent-config.js';
import { dbApi, type MemoryRuleRow } from './db.js';
import { AGENTS_DIR } from './paths.js';
import { projectFromCwd } from './task-project.js';

type RuleTarget = Pick<MemoryRuleRow, 'scope' | 'project' | 'agent' | 'role'>;
type AgentTarget = { name: string; project: string | null; role: string | null };

function installedAgents(): AgentTarget[] {
  if (!existsSync(AGENTS_DIR)) return [];
  const out: AgentTarget[] = [];
  for (const name of readdirSync(AGENTS_DIR)) {
    try {
      if (!statSync(join(AGENTS_DIR, name)).isDirectory()) continue;
      const cfg = loadConfig(name);
      // Same resolution as the recall: a different one would fence the wrong agents.
      out.push({ name, project: cfg.project ?? projectFromCwd(cfg.cwd), role: cfg.role ?? null });
    } catch {
      // An unreadable config still names an agent that may hold a session.
      out.push({ name, project: null, role: null });
    }
  }
  return out;
}

function reaches(rule: RuleTarget, agent: AgentTarget): boolean {
  switch (rule.scope) {
    case 'agent': return !!rule.agent && rule.agent.toLowerCase() === agent.name.toLowerCase();
    case 'project': return !!rule.project && rule.project === agent.project;
    case 'role': return !!rule.role && rule.role === agent.role && (rule.project == null || rule.project === agent.project);
    case 'global': return true;
    // A scope the recall does not know was never injected; fencing everyone is the safe reading.
    default: return true;
  }
}

/** Names of the installed agents whose prompt the rule may have reached. */
export function agentsReachedByRule(rule: RuleTarget): string[] {
  const agents = installedAgents().filter((a) => reaches(rule, a)).map((a) => a.name);
  // An agent rule naming an agent with no folder (trashed, renamed by hand) still fences that name.
  if (rule.scope === 'agent' && rule.agent && agents.length === 0) agents.push(rule.agent);
  return agents.sort();
}

/**
 * Fences the agents the rule may have reached; returns their names, which
 * start a fresh conversation at their next mission.
 */
export function fenceSessionsForRule(rule: RuleTarget, at: number = Date.now()): string[] {
  const agents = agentsReachedByRule(rule);
  if (agents.length > 0) dbApi.fenceAgentSessions(agents, at);
  return agents;
}

/**
 * Whether an edit takes away from the agents something the rule used to tell
 * them: its text, its audience, or its being active at all. Raising its tier or
 * re-labelling its kind changes nothing an earlier session holds.
 */
export function ruleEditRevokes(before: MemoryRuleRow, after: MemoryRuleRow): boolean {
  if (before.text !== after.text) return true;
  if (before.scope !== after.scope || before.project !== after.project
    || before.agent !== after.agent || before.role !== after.role) return true;
  return before.status === 'active' && after.status !== 'active';
}

type RulePatch = Parameters<typeof dbApi.updateRule>[1];
type RuleChange = { rule: MemoryRuleRow; freshConversation: string[] };

/**
 * Changes a stored rule. An edit that takes something away from the agents
 * (`ruleEditRevokes`) fences the agents the OLD rule reached; a re-tier or a
 * support bump fences nobody. `undefined` when the rule does not exist.
 */
export function reviseMemoryRule(id: number, patch: RulePatch, at: number = Date.now()): RuleChange | undefined {
  const before = dbApi.getRule(id);
  if (!before) return undefined;
  const rule = dbApi.updateRule(id, patch);
  if (!rule) return undefined;
  return { rule, freshConversation: ruleEditRevokes(before, rule) ? fenceSessionsForRule(before, at) : [] };
}

/**
 * Marks a rule replaced by `byNewId`. The replacement only adds what it says:
 * the old wording stays in every session that saw it, so the agents it reached
 * are fenced. Returns their names.
 */
export function supersedeMemoryRule(oldId: number, byNewId: number | null = null, at: number = Date.now()): string[] {
  const before = dbApi.getRule(oldId);
  if (!before) return [];
  dbApi.supersedeRule(oldId, byNewId);
  return before.status === 'active' ? fenceSessionsForRule(before, at) : [];
}

/**
 * Deletes a rule and fences the agents it may have reached, whatever its
 * status: a superseded or archived rule may still sit in a session that
 * predates the fences. `undefined` when the rule does not exist.
 */
export function deleteMemoryRuleAndFence(id: number, at: number = Date.now()): RuleChange | undefined {
  const rule = dbApi.getRule(id);
  if (!rule) return undefined;
  dbApi.deleteRule(id);
  return { rule, freshConversation: fenceSessionsForRule(rule, at) };
}
