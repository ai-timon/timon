/**
 * Module `memory` — TIMON's memory: rules injected at spawn, raw facts,
 * agent and project memories, promotion proposals, agent docs.
 * Tier `core`: the agents' preamble depends on it.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import { AGENT_DOC_MAX_BYTES, canonicalAgentName, deleteDoc, deleteMemory, getAgent, listDocs, listMemory, readDoc, readMemory, writeDoc, writeMemory } from '../../agent.js';
import { dbApi } from '../../db.js';
import { delegatingAgent } from '../../delegation-guard.js';
import { rejectIfDenied, rejectUnlessAny, viewerFromRequest } from '../../users/identity.js';
import { recordWriteOrigin } from '../../write-origin.js';
import { promptRewriteRefusal, rejectOverride } from '../../users/privileged-overrides.js';
import { scopedDb } from '../../users/scoped-db.js';
import { runBackfill } from '../../memory-backfill.js';
import { MemoryRuleError, addMemoryRule } from '../../memory-rule-add.js';
import { editMemoryRule, memoryOverview, removeMemoryRule, searchMemoryHits } from '../../memory-queries.js';
import { runSynthesisNow } from '../../memory-synthesize.js';
import { deleteProjectMemory, listProjectMemory, readProjectMemory, writeProjectMemory } from '../../projects.js';
import { apiError } from '../../api-error.js';

/**
 * SECU-USERS U-2: agent memory, docs and learnings are secret-bearing
 * (SECURITY.md §6.5) and belong to no owned table, so nothing else scopes
 * them. Reads need `agents:read` (or `manage`); writes are `agents:manage`
 * for an agent and `projects:manage` for a project's shared memory.
 */
const AGENT_READ = ['agents:read', 'agents:manage'] as const;

/** The text parser bounds a `text/plain` doc (the UI); a JSON one (CLI, MCP)
 *  only meets the daemon's 25 MB parser, so the ceiling is enforced on the
 *  content itself, whatever carried it. */
const DOC_MAX_BYTES = AGENT_DOC_MAX_BYTES;

/** `{ content }` from the CLI and MCP; `text/plain` from the UI, where an
 *  empty body arrives as `{}` or nothing: the editor saving an emptied doc.
 *  A JSON `{}` is not that, and must not wipe the doc. */
const jsonDocBodySchema = z.object({ content: z.string() }).strict();
const textDocBodySchema = z.union([z.string(), z.object({}).strict(), z.undefined()]);

/**
 * The agent whose identity docs a write may touch, or `null` once refused.
 * Every `*.md` at the agent root is injected into the missions it runs
 * (`loadIdentityDocs`), so writing one rewrites its prompt: a mission-bound
 * caller obeys the prompt-rewrite guard — itself, or an agent it orchestrates
 * that runs no higher than it (TODO #240) — and only on an agent that exists,
 * since the delegation check lets an unknown target through and `writeDoc`
 * would create its directory. Humans and operators keep `agents:manage` alone.
 */
function docWriteTarget(req: Request<{ name: string; file: string }>, res: Response): string | null {
  if (rejectIfDenied(req, res, 'agents:manage')) return null;
  let name: string;
  let exists: boolean;
  try {
    name = canonicalAgentName(req.params.name);
    exists = getAgent(name) !== null;
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
    return null;
  }
  if (!exists && delegatingAgent(req) !== null) {
    res.status(404).json(apiError('agent_not_found', 'agent not found'));
    return null;
  }
  const refusal = promptRewriteRefusal(req, name);
  if (refusal) {
    rejectOverride(req, res, 'agent.doc_write_denied', `agent:${name}/${req.params.file}`, refusal);
    return null;
  }
  return name;
}

/** Who acts, for a rule's lifecycle event: the agent of a mission, else the account. */
function requestActor(req: Request): { kind: string; id: string | null } {
  const agent = delegatingAgent(req);
  if (agent) return { kind: 'agent', id: agent };
  return req.auth?.user ? { kind: 'user', id: req.auth.user.id } : { kind: 'manual', id: null };
}

export function registerRoutes(app: Router): void {
  // The writer of an agent, for the `agent_*` events its write causes.
  app.use('/api/agents', recordWriteOrigin);
  app.get('/api/agents/:name/memory', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      res.json({ files: listMemory(req.params.name) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/memory/:file', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      const content = readMemory(req.params.name, req.params.file);
      if (content === null) {
        res.status(404).json(apiError('memory_file_not_found', 'memory file not found'));
        return;
      }
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/agents/:name/memory/:file', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    try {
      const content = typeof req.body === 'string' ? req.body : '';
      const info = writeMemory(req.params.name, req.params.file, content);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agents/:name/memory/:file', (req, res) => {
    if (rejectIfDenied(req, res, 'agents:manage')) return;
    try {
      const ok = deleteMemory(req.params.name, req.params.file);
      if (!ok) {
        res.status(404).json(apiError('memory_file_not_found', 'memory file not found'));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/projects/:slug/memory', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      res.json({ files: listProjectMemory(req.params.slug) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/projects/:slug/memory/:file', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      const content = readProjectMemory(req.params.slug, req.params.file);
      if (content === null) {
        res.status(404).json(apiError('memory_file_not_found', 'memory file not found'));
        return;
      }
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/projects/:slug/memory/:file', express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      const content = typeof req.body === 'string' ? req.body : '';
      const info = writeProjectMemory(req.params.slug, req.params.file, content);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/projects/:slug/memory/:file', (req, res) => {
    if (rejectIfDenied(req, res, 'projects:manage')) return;
    try {
      const ok = deleteProjectMemory(req.params.slug, req.params.file);
      if (!ok) {
        res.status(404).json(apiError('memory_file_not_found', 'memory file not found'));
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/memory/overview', (req, res) => {
    try {
      res.json(memoryOverview(viewerFromRequest(req)));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/learnings', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      res.json({ facts: dbApi.groupedLearnings(req.params.name) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/memory/projects/:slug/proposals/:hash', (req, res) => {
    try {
      const id = Number(req.params.hash);
      const action = (req.body as { action?: string } | undefined)?.action;
      if (action !== 'accept' && action !== 'reject') {
        res.status(400).json({ error: 'action must be accept|reject' });
        return;
      }
      if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid proposal id' }); return; }
      const p = scopedDb(viewerFromRequest(req)).getProposal(id);
      if (!p) { res.status(404).json(apiError('proposal_not_found', 'proposal not found')); return; }
      const status = action === 'accept' ? 'accepted' : 'rejected';
      const changed = p.status === 'pending';
      if (changed) dbApi.decideProposal(id, status);
      res.json({ ok: true, changed, status });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/memory/proposals/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      const action = (req.body as { action?: string } | undefined)?.action;
      if (action !== 'accept' && action !== 'reject') {
        res.status(400).json({ error: 'action must be accept|reject' }); return;
      }
      if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid proposal id' }); return; }
      const p = scopedDb(viewerFromRequest(req)).getProposal(id);
      if (!p) { res.status(404).json(apiError('proposal_not_found', 'proposal not found')); return; }
      const status = action === 'accept' ? 'accepted' : 'rejected';
      const changed = p.status === 'pending';
      if (changed) dbApi.decideProposal(id, status);
      res.json({ ok: true, changed, status });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.post('/api/memory/rules', (req, res) => {
    try {
      const rule = addMemoryRule((req.body ?? {}) as Record<string, unknown>, { actor: requestActor(req) });
      res.status(201).json({ ok: true, rule });
    } catch (err) {
      if (err instanceof MemoryRuleError) {
        res.status(err.status).json({ error: err.message, duplicate: err.duplicate ?? null });
        return;
      }
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/memory/rules', (req, res) => {
    try {
      const opts: Parameters<typeof dbApi.listRules>[0] = {};
      if (typeof req.query.scope === 'string' && req.query.scope) opts.scope = req.query.scope;
      if (typeof req.query.project === 'string' && req.query.project) opts.project = req.query.project;
      if (typeof req.query.agent === 'string' && req.query.agent) opts.agent = req.query.agent;
      res.json({ rules: dbApi.listRules(opts) });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.delete('/api/memory/rules/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid rule id' }); return; }
      const removed = removeMemoryRule(id, requestActor(req));
      if (!removed) { res.status(404).json(apiError('rule_not_found', 'rule not found')); return; }
      // `fresh_conversation`: the agents whose next mission starts without their old session.
      res.json({ ok: true, deleted: removed.rule, fresh_conversation: removed.freshConversation });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.patch('/api/memory/rules/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json({ error: 'invalid rule id' }); return; }
      const b = (req.body ?? {}) as Record<string, unknown>;
      const patch: Parameters<typeof dbApi.updateRule>[1] = {};
      for (const k of ['scope', 'project', 'agent', 'role', 'kind', 'text', 'tier', 'status'] as const) {
        if (k in b) (patch as Record<string, unknown>)[k] = b[k];
      }
      if ('supersedes' in b) patch.supersedes = b.supersedes == null ? null : Number(b.supersedes);
      const edited = editMemoryRule(id, patch);
      if (!edited) { res.status(404).json(apiError('rule_not_found', 'rule not found')); return; }
      res.json({ ...edited.rule, fresh_conversation: edited.freshConversation });
    } catch (err) { res.status(400).json({ error: (err as Error).message }); }
  });

  app.get('/api/memory/audit', (req, res) => {
    try {
      const runId = typeof req.query.run === 'string' ? req.query.run : undefined;
      const limit = req.query.limit ? Number(req.query.limit) : undefined;
      res.json({ audit: dbApi.listMemoryAudit({ runId, limit }) });
    } catch (err) { res.status(500).json({ error: (err as Error).message }); }
  });

  app.post('/api/memory/backfill', (req, res) => {
    const b = (req.body ?? {}) as { project?: string; onlyGlobal?: boolean; dryRun?: boolean };
    runBackfill({ project: b.project, onlyGlobal: b.onlyGlobal, dryRun: b.dryRun })
      .then((r) => res.json({ ok: true, ...r }))
      .catch((err) => res.status(500).json({ error: (err as Error).message }));
  });

  app.post('/api/memory/synthesize', (_req, res) => {
    runSynthesisNow()
      .then(() => res.json({ ok: true }))
      .catch((err) => res.status(500).json({ error: (err as Error).message }));
  });

  app.get('/api/memory/search', (req, res) => {
    try {
      res.json(searchMemoryHits(String((req.query.q as string) ?? '')));
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/docs', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      res.json({ files: listDocs(req.params.name) });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/agents/:name/docs/:file', (req, res) => {
    if (rejectUnlessAny(req, res, AGENT_READ)) return;
    try {
      const content = readDoc(req.params.name, req.params.file);
      if (content === null) {
        res.status(404).json({ error: 'doc not found' });
        return;
      }
      // The CLI and MCP read JSON: a doc whose text happens to parse as JSON
      // must not come back as an object.
      if (req.query.format === 'json') {
        res.json({ name: req.params.file, content });
        return;
      }
      res.type('text/plain; charset=utf-8').send(content);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/agents/:name/docs/:file', express.text({ type: '*/*', limit: DOC_MAX_BYTES }), (req, res) => {
    const name = docWriteTarget(req, res);
    if (name === null) return;
    const json = req.is('application/json') ? jsonDocBodySchema.safeParse(req.body) : null;
    const text = json ? null : textDocBodySchema.safeParse(req.body);
    if (json ? !json.success : !text?.success) {
      res.status(400).json({ error: 'body must be the doc text (text/plain) or { "content": string }' });
      return;
    }
    const content = json?.success ? json.data.content : typeof text?.data === 'string' ? text.data : '';
    if (Buffer.byteLength(content, 'utf8') > DOC_MAX_BYTES) {
      res.status(413).json({ error: `doc too large (max ${DOC_MAX_BYTES} bytes)` });
      return;
    }
    try {
      const info = writeDoc(name, req.params.file, content);
      res.json(info);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/agents/:name/docs/:file', (req, res) => {
    const name = docWriteTarget(req, res);
    if (name === null) return;
    try {
      const ok = deleteDoc(name, req.params.file);
      if (!ok) {
        res.status(404).json({ error: 'doc not found' });
        return;
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
}
