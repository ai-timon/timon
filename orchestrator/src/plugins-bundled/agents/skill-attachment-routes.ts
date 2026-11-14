/**
 * `/api/skill-attachments`: which skill reaches which agents, and how
 * (skill-attachments.ts). `/api/agents/:name/skills`: what an agent resolves.
 * `/api/agents/:name/skill-reads`: how often its missions read a skill (skill-reads.ts).
 * `/api/skill-weights`: what each skill costs in the prompt, per mode.
 * `/api/skill-attachments/preview`: what a spawn would send with the editor's draft.
 *
 * Every route refuses an anonymous caller, even on the first-run loopback
 * where `rejectIfDenied` alone lets one through: an attachment rewrites the
 * prompt of the agents it reaches.
 *
 * Writing is bounded like the prompt itself:
 *  - agent scope: `agents:manage`, plus the prompt rewrite guard for a caller
 *    who is not the operator (a mission may only touch an agent it orchestrates,
 *    at or below its own level);
 *  - global / project / role: these reach agents the caller may not even see,
 *    so the operator or a holder of `agents:privileged-config` only;
 *  - whatever the scope, an agent's token never makes a skill that
 *    pre-authorises tools reach an agent that does not already hold them
 *    (`skillReachRefusal`): that takes a person.
 *
 * The target must exist (agent, project, agent role): a mistyped one would
 * store an attachment that never reaches anyone.
 */
import type express from 'express';
import type { Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName, killRunningForAgent, loadConfig, resolveSpawnSkills } from '../../agent.js';
import { getRole } from '../../agent-roles.js';
import { tryDefaultBackendName } from '../../backends/index.js';
import { agentDir, skillFile } from '../../paths.js';
import { listProjects } from '../../projects.js';
import { buildSkillsPreview, skillWeights } from '../../prompt-injections.js';
import {
  deleteSkillAttachment, getSkillAttachment, listSkillAttachments, putSkillAttachment,
  SKILL_ATTACHMENT_SCOPES, SKILL_MODES, type SkillAttachment,
} from '../../skill-attachments.js';
import { auditRequest } from '../../users/audit-actor.js';
import { skillReadStats } from '../../skill-reads.js';
import { rejectIfDenied, rejectUnlessAny, viewerFromRequest } from '../../users/identity.js';
import {
  agentConfigRefusal, isAgentToken, isPrivilegedCaller, overrideAuthority, PRIVILEGED_CONFIG_PERMISSION, promptRewriteRefusal, rejectOverride,
  skillWideningDenied, skillWideningRefusal,
} from '../../users/privileged-overrides.js';

const AGENT_READ = ['agents:read', 'agents:manage'] as const;
const SKILL_ID = z.string().trim().regex(/^[a-z0-9._-]+$/).refine((id) => id !== '.' && id !== '..', 'invalid skill id');
const TARGET = z.string().trim().min(1).max(200).refine((t) => !/[\\/\0]/.test(t), 'invalid target');

const attachSchema = z.object({
  skill: SKILL_ID,
  scope: z.enum(SKILL_ATTACHMENT_SCOPES),
  /** Project slug, role id or agent name; ignored for `global`. */
  target: TARGET.optional(),
  mode: z.enum(SKILL_MODES).default('include'),
  exclude: z.boolean().default(false),
}).strict().refine((b) => b.scope === 'global' || b.target !== undefined, {
  message: 'target is required for scope project, role and agent', path: ['target'],
});

const listSchema = z.object({
  scope: z.enum(SKILL_ATTACHMENT_SCOPES).optional(),
  target: z.string().max(200).optional(),
  skill: z.string().max(200).optional(),
});

const previewSchema = z.object({
  /** An existing agent; absent for one the editor has not created yet. */
  agent: TARGET.optional(),
  skills: z.array(z.object({ id: SKILL_ID, mode: z.enum(SKILL_MODES) }).strict()).max(2000),
  role: z.string().trim().max(200).optional(),
  project: z.string().max(200).optional(),
  cwd: z.string().max(4096).optional(),
  backend: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  global_context: z.boolean().optional(),
  system_prompt: z.string().max(2_000_000).optional(),
}).strict();

function anonymous(req: Request, res: Response): boolean {
  if (req.auth) return false;
  res.status(401).json({ error: 'unauthorized' });
  return true;
}

/** Why this caller may not write an attachment of `scope` on `target`, or null. */
function writeRefusal(req: Request, scope: SkillAttachment['scope'], target: string): string | null {
  if (isPrivilegedCaller(req)) return null;
  if (scope === 'agent') return promptRewriteRefusal(req, target);
  if (overrideAuthority(req).relaxed) return null;
  return `a ${scope} attachment changes the prompt of every agent it reaches: that needs the ${PRIVILEGED_CONFIG_PERMISSION} permission`;
}

/**
 * Why an agent's token may not make `skill` reach the agents of `scope` /
 * `target` (an attachment, or the removal of an exclusion), or null. A skill
 * that pre-authorises tools adds them to every agent it reaches: on one agent,
 * it passes when that agent already holds them; on a project, a role or every
 * agent, it reaches agents nobody named, so any declared tool is refused unless
 * the same attachment is already in force (a change of mode grants nothing).
 * Judged before the privileged exemption of `writeRefusal`: no account lifts it.
 */
function skillReachRefusal(req: Request, skill: string, scope: SkillAttachment['scope'], target: string): string | null {
  if (!isAgentToken(req)) return null;
  if (scope === 'agent') {
    const cfg = (() => { try { return loadConfig(target); } catch { return null; } })();
    return skillWideningDenied(req, [skill], target, cfg, 'skill');
  }
  const inForce = listSkillAttachments({ scope, target, skill }).some((a) => !a.exclude);
  if (inForce) return null;
  return skillWideningRefusal([skill], [], { label: 'skill', reach: scope === 'global' ? 'of every agent' : `of ${scope} ${target}` });
}

export function registerSkillAttachmentRoutes(app: express.IRouter): void {
  app.get('/api/skill-attachments', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const q = listSchema.safeParse(req.query);
    if (!q.success) { res.status(400).json({ error: 'invalid query', fields: q.error.flatten().fieldErrors }); return; }
    res.json({ attachments: listSkillAttachments(q.data) });
  });

  app.post('/api/skill-attachments', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const parsed = attachSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid skill attachment', fields: parsed.error.flatten().fieldErrors });
      return;
    }
    const body = parsed.data;
    let target = body.scope === 'global' ? '' : body.target!;
    if (body.scope === 'agent') {
      target = canonicalAgentName(target);
      if (!existsSync(agentDir(target))) { res.status(404).json({ error: `agent not found: ${target}` }); return; }
    }
    // An exclusion may name a skill that is gone: it still has to stop an inheritance.
    if (!body.exclude && !existsSync(skillFile(body.skill))) {
      res.status(404).json({ error: `skill not found: ${body.skill} (see skill_list)` });
      return;
    }
    const refusal = (body.exclude ? null : skillReachRefusal(req, body.skill, body.scope, target))
      ?? writeRefusal(req, body.scope, target);
    if (refusal) { rejectOverride(req, res, 'skill.attach_denied', `skill:${body.skill}@${body.scope}:${target}`, refusal); return; }
    // After the refusal, so a caller who may not write here learns nothing of
    // which projects exist; a mistyped slug or role id would otherwise store an
    // attachment no agent ever resolves.
    if (body.scope === 'project' && !listProjects().includes(target)) {
      res.status(404).json({ error: `project not found: ${target}` });
      return;
    }
    if (body.scope === 'role' && !getRole(target)) {
      res.status(404).json({ error: `role not found: ${target} (see agent roles)` });
      return;
    }
    const row = putSkillAttachment({ skill: body.skill, scope: body.scope, target, mode: body.mode, exclude: body.exclude });
    auditRequest(req, 'skill.attach', `skill:${row.skill}@${row.scope}:${row.target} mode=${row.mode}${row.exclude ? ' exclude' : ''}`);
    // Same as a `skills` change in the agent's config: the running process
    // carries the old prompt, the next turn respawns with the new one.
    const killed = row.scope === 'agent' ? killRunningForAgent(row.target) : 0;
    res.json({ ...row, _killed: killed });
  });

  app.delete('/api/skill-attachments/:id', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    const id = Number(req.params.id);
    const row = Number.isInteger(id) && id > 0 ? getSkillAttachment(id) : null;
    if (!row) { res.status(404).json({ error: 'skill attachment not found' }); return; }
    // Removing an exclusion hands the agents it covered the skill it held back.
    const refusal = (row.exclude ? skillReachRefusal(req, row.skill, row.scope, row.target) : null)
      ?? writeRefusal(req, row.scope, row.target);
    if (refusal) { rejectOverride(req, res, 'skill.detach_denied', `skill:${row.skill}@${row.scope}:${row.target}`, refusal); return; }
    deleteSkillAttachment(id);
    auditRequest(req, 'skill.detach', `skill:${row.skill}@${row.scope}:${row.target}`);
    const killed = row.scope === 'agent' ? killRunningForAgent(row.target) : 0;
    res.json({ ok: true, _killed: killed });
  });

  // Read by the agent editor to weigh each box: the bodies are not sent, only
  // their token counts, but they still describe the installed skills.
  app.get('/api/skill-weights', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    res.json(skillWeights());
  });

  // POST because a draft does not fit a query string (a whole system prompt),
  // but it writes nothing: reading an agent is enough. It answers with skill ids
  // and token counts, never a text.
  app.post('/api/skill-attachments/preview', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const parsed = previewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid skills preview', fields: parsed.error.flatten().fieldErrors });
      return;
    }
    const { agent: wanted, ...draft } = parsed.data;
    const agent = wanted === undefined ? null : canonicalAgentName(wanted);
    if (agent !== null && !existsSync(agentDir(agent))) { res.status(404).json({ error: `agent not found: ${agent}` }); return; }
    // The prompt looks into the working folder (`.grepai`), so a path this caller
    // could not give the agent must not be tested: a save would refuse it anyway.
    if (draft.cwd && !isPrivilegedCaller(req)
      && agentConfigRefusal({ cwd: draft.cwd }, agent === null ? null : loadConfig(agent), overrideAuthority(req))) {
      delete draft.cwd;
    }
    try {
      res.json(buildSkillsPreview(agent, draft));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // What the agent spawns with, attachments and config resolved (code-added
  // skills excepted: those belong to a mission, not to the agent).
  app.get('/api/agents/:name/skills', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const name = canonicalAgentName(req.params.name);
    if (!existsSync(agentDir(name))) { res.status(404).json({ error: `agent not found: ${name}` }); return; }
    res.json({ agent: name, skills: resolveSpawnSkills(name, loadConfig(name)) });
  });

  // Skill reads by the agent's missions over 30 days, counted on the missions
  // the caller may see: a scoped user learns nothing of the others'.
  app.get('/api/agents/:name/skill-reads', (req, res) => {
    if (anonymous(req, res)) return;
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    const name = canonicalAgentName(req.params.name);
    if (!existsSync(agentDir(name))) { res.status(404).json({ error: `agent not found: ${name}` }); return; }
    res.json({ agent: name, ...skillReadStats(name, viewerFromRequest(req), loadConfig(name).backend ?? tryDefaultBackendName()) });
  });
}
