/**
 * A memory rule that was removed or rewritten must not survive in the provider
 * session the agent's next mission would resume: the session's history still
 * holds the rule. The agents it may have reached start fresh; the others
 * resume as before.
 */
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { upsertAgent, resolveSpawnResume } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { agentsReachedByRule } = await import('./memory-session-fence.js');
const { removeMemoryRule } = await import('./memory-queries.js');
const { applyCuration } = await import('./memory-synthesize.js');
const { applyBackfillDecisions } = await import('./memory-backfill.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { createBodyParser } = await import('./kernel/body-parser.js');
const { registerRoutes: memoryRoutes } = await import('./plugins-bundled/memory/routes.js');
const { memoryDialect } = await import('../tests/helpers/example-dialects.js') as {
  memoryDialect: import('./backends/types.js').RemoteDialect;
};

const OWNER = 'memory-session-fence-test';
const BACKEND = 'memory-fence-global';
invalidateSettingsCache();
const disposers = [
  registerDialect(OWNER, BACKEND, { ...memoryDialect, id: BACKEND, sessionStore: 'global' }),
  registerProfile(OWNER, { id: BACKEND, dialect: BACKEND, label: BACKEND, defaultModel: null, models: [], env: {} }),
];

const TOKEN = 'memory-session-fence-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(createBodyParser());
memoryRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => {
  server.closeAllConnections();
  server.close();
  for (const dispose of disposers.reverse()) dispose();
});

const call = (method: string, path: string, body?: unknown, token: string | null = TOKEN) => fetch(`${base}${path}`, {
  method,
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: body === undefined ? undefined : JSON.stringify(body),
});

/** Lets the clock move past a fence: a mission born in the same millisecond counts as before it. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** An agent whose previous mission left a resumable session. */
function agentWithSession(opts: { project?: string; role?: string } = {}): { agent: string; session: string; mission: string } {
  const agent = `fence-${randomUUID().slice(0, 8)}`;
  upsertAgent({
    name: agent,
    system_prompt: 'You are a witness.',
    config: {
      backend: BACKEND, cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE',
      ...(opts.project ? { project: opts.project } : {}),
      ...(opts.role ? { role: opts.role } : {}),
    },
  });
  const mission = randomUUID();
  const session = `sess-${randomUUID()}`;
  dbApi.createMission(mission, agent, 'earlier work');
  dbApi.setMissionSession(mission, session);
  return { agent, session, mission };
}

async function addRule(body: Record<string, unknown>): Promise<number> {
  const r = await call('POST', '/api/memory/rules', { kind: 'pitfall', ...body });
  assert.equal(r.status, 201, await r.clone().text());
  return ((await r.json()) as { rule: { id: number } }).rule.id;
}

test('an anonymous caller can neither delete nor edit a rule', async () => {
  const { agent } = agentWithSession();
  const id = await addRule({ scope: 'agent', agent, text: 'anonymous target' });
  assert.equal((await call('DELETE', `/api/memory/rules/${id}`, undefined, null)).status, 401);
  assert.equal((await call('PATCH', `/api/memory/rules/${id}`, { text: 'x' }, null)).status, 401);
  assert.ok(dbApi.getRule(id));
  assert.equal(dbApi.agentSessionFence(agent), null);
});

test('deleting a rule: the agent it reached starts fresh, another agent resumes', async () => {
  const reached = agentWithSession();
  const bystander = agentWithSession();
  assert.equal(resolveSpawnResume(reached.agent, randomUUID(), undefined), reached.session);

  const id = await addRule({ scope: 'agent', agent: reached.agent, text: 'injected instruction' });
  const r = await call('DELETE', `/api/memory/rules/${id}`);
  assert.equal(r.status, 200);
  const body = await r.json() as { deleted: { id: number }; fresh_conversation: string[] };
  assert.equal(body.deleted.id, id);
  assert.deepEqual(body.fresh_conversation, [reached.agent]);

  // Default resume, explicit resume (the chat's own session), and the wake's lookup.
  assert.equal(resolveSpawnResume(reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(reached.agent, randomUUID(), reached.session), null);
  assert.equal(dbApi.getLatestSessionForAgent(reached.agent), null);
  assert.equal(dbApi.getLatestSessionForAgent(reached.agent, null), null);
  // The agent the rule never reached keeps its conversation.
  assert.equal(resolveSpawnResume(bystander.agent, randomUUID(), undefined), bystander.session);
});

test('a session born after the removal is resumed normally', async () => {
  const { agent } = agentWithSession();
  const id = await addRule({ scope: 'agent', agent, text: 'short-lived rule' });
  assert.ok(removeMemoryRule(id));
  await tick();
  const fresh = randomUUID();
  dbApi.createMission(fresh, agent, 'after the removal');
  dbApi.setMissionSession(fresh, 'sess-after-fence');
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined), 'sess-after-fence');
});

test('a session renewed in place still counts from the mission that began it', async () => {
  const { agent, mission } = agentWithSession();
  const id = await addRule({ scope: 'agent', agent, text: 'renewed session rule' });
  assert.ok(removeMemoryRule(id));
  await tick();
  // The pre-fence mission is resumed in place and its CLI hands back a new id.
  dbApi.setMissionSession(mission, 'sess-renewed');
  assert.equal(resolveSpawnResume(agent, randomUUID(), 'sess-renewed'), null);
  assert.equal(resolveSpawnResume(agent, randomUUID(), undefined), null);
});

test('scopes: project, role and global rules fence the agents the recall would reach', async () => {
  const project = `p-${randomUUID().slice(0, 6)}`;
  const inProject = agentWithSession({ project, role: 'coder' });
  const coderElsewhere = agentWithSession({ project: `${project}-other`, role: 'coder' });
  const reviewer = agentWithSession({ project, role: 'reviewer' });

  assert.deepEqual(agentsReachedByRule({ scope: 'project', project, agent: null, role: null }),
    [inProject.agent, reviewer.agent].sort());
  // A role rule across projects reaches every coder; one tied to a project only its coders.
  const coders = agentsReachedByRule({ scope: 'role', project: null, agent: null, role: 'coder' });
  assert.ok(coders.includes(inProject.agent) && coders.includes(coderElsewhere.agent));
  assert.ok(!coders.includes(reviewer.agent));
  assert.deepEqual(agentsReachedByRule({ scope: 'role', project, agent: null, role: 'coder' }), [inProject.agent]);

  const id = await addRule({ scope: 'global', text: 'global rule' });
  const body = await (await call('DELETE', `/api/memory/rules/${id}`)).json() as { fresh_conversation: string[] };
  for (const a of [inProject, coderElsewhere, reviewer]) {
    assert.ok(body.fresh_conversation.includes(a.agent), a.agent);
    assert.equal(resolveSpawnResume(a.agent, randomUUID(), undefined), null, a.agent);
  }
});

test('editing a rule: a new text fences, a new tier does not', async () => {
  const tiered = agentWithSession();
  const tierId = await addRule({ scope: 'agent', agent: tiered.agent, text: 'keep my text' });
  const tierEdit = await (await call('PATCH', `/api/memory/rules/${tierId}`, { tier: 'core' })).json() as { tier: string; fresh_conversation: string[] };
  assert.equal(tierEdit.tier, 'core');
  assert.deepEqual(tierEdit.fresh_conversation, []);
  assert.equal(resolveSpawnResume(tiered.agent, randomUUID(), undefined), tiered.session);

  const rewritten = agentWithSession();
  const textId = await addRule({ scope: 'agent', agent: rewritten.agent, text: 'old wording' });
  const textEdit = await (await call('PATCH', `/api/memory/rules/${textId}`, { text: 'new wording' })).json() as { text: string; fresh_conversation: string[] };
  assert.equal(textEdit.text, 'new wording');
  assert.deepEqual(textEdit.fresh_conversation, [rewritten.agent]);
  assert.equal(resolveSpawnResume(rewritten.agent, randomUUID(), undefined), null);

  // Moving a rule to another agent fences the agent that lost it.
  const loser = agentWithSession();
  const gainer = agentWithSession();
  const movedId = await addRule({ scope: 'agent', agent: loser.agent, text: 'moving rule' });
  const moved = await (await call('PATCH', `/api/memory/rules/${movedId}`, { agent: gainer.agent })).json() as { fresh_conversation: string[] };
  assert.deepEqual(moved.fresh_conversation, [loser.agent]);
  assert.equal(resolveSpawnResume(gainer.agent, randomUUID(), undefined), gainer.session);
});

test('a rename carries the fence to the new name', async () => {
  const { agent } = agentWithSession();
  const id = await addRule({ scope: 'agent', agent, text: 'rename rule' });
  assert.ok(removeMemoryRule(id));
  const renamed = `${agent}-renamed`;
  dbApi.renameAgentRefs(agent, renamed);
  assert.ok(dbApi.agentSessionFence(renamed));
  assert.equal(dbApi.agentSessionFence(agent), null);
});

/** A stored rule written straight to the table, as the synthesis and the backfill find it. */
function storedRule(r: { scope: string; project?: string | null; agent?: string | null; text: string }): number {
  return dbApi.insertRule({ kind: 'pitfall', source: 'synthesis', ...r });
}

type CurationDecisions = Parameters<typeof applyCuration>[0];

test('synthesis: a merge that rewords a rule fences the agent it reached', () => {
  const reached = agentWithSession();
  const bystander = agentWithSession();
  const id = storedRule({ scope: 'agent', agent: reached.agent, text: 'curated wording' });
  const decisions: CurationDecisions = [{ action: 'merge', targetId: id, text: 'curated wording, refined' }];
  applyCuration(decisions, 'agent', null, reached.agent, [dbApi.getRule(id)!], randomUUID());
  assert.equal(dbApi.getRule(id)!.text, 'curated wording, refined');
  assert.equal(resolveSpawnResume(reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(bystander.agent, randomUUID(), undefined), bystander.session);
});

test('synthesis: a merge that keeps the wording fences nobody', () => {
  const kept = agentWithSession();
  const id = storedRule({ scope: 'agent', agent: kept.agent, text: 'stable wording' });
  const decisions: CurationDecisions = [{ action: 'merge', targetId: id, text: 'stable wording' }];
  applyCuration(decisions, 'agent', null, kept.agent, [dbApi.getRule(id)!], randomUUID());
  assert.equal(resolveSpawnResume(kept.agent, randomUUID(), undefined), kept.session);
});

test('synthesis: a superseded rule fences the agent it reached', () => {
  const reached = agentWithSession();
  const bystander = agentWithSession();
  const id = storedRule({ scope: 'agent', agent: reached.agent, text: 'to be replaced' });
  const decisions: CurationDecisions = [{ action: 'supersede', targetId: id, text: 'the replacement', ruleScope: 'agent' }];
  applyCuration(decisions, 'agent', null, reached.agent, [dbApi.getRule(id)!], randomUUID());
  assert.equal(dbApi.getRule(id)!.status, 'superseded');
  assert.equal(resolveSpawnResume(reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(bystander.agent, randomUUID(), undefined), bystander.session);
});

test('backfill: archive, merge and re-scope fence the project agents, a re-tier does not', () => {
  type Decisions = Parameters<typeof applyBackfillDecisions>[0];
  const run = (project: string, decisions: (ids: number[]) => Decisions) => {
    const reached = agentWithSession({ project });
    const bystander = agentWithSession({ project: `${project}-other` });
    const ids = [storedRule({ scope: 'project', project, text: `${project} rule A` }),
      storedRule({ scope: 'project', project, text: `${project} rule B` })];
    const rules = ids.map((id) => dbApi.getRule(id)!);
    applyBackfillDecisions(decisions(ids), rules, 'project', project, new Set([project]), randomUUID());
    return { reached, bystander, ids };
  };
  const slug = () => `bf-${randomUUID().slice(0, 6)}`;

  const archived = run(slug(), ([a]) => [{ id: a!, action: 'archive' }]);
  assert.equal(dbApi.getRule(archived.ids[0]!)!.status, 'archived');
  assert.equal(resolveSpawnResume(archived.reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(archived.bystander.agent, randomUUID(), undefined), archived.bystander.session);

  const merged = run(slug(), ([a, b]) => [{ id: a!, action: 'merge', intoId: b! }]);
  assert.equal(dbApi.getRule(merged.ids[0]!)!.status, 'archived');
  assert.equal(resolveSpawnResume(merged.reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(merged.bystander.agent, randomUUID(), undefined), merged.bystander.session);

  const rescoped = run(slug(), ([a]) => [{ id: a!, action: 'update', scope: 'global' }]);
  assert.equal(dbApi.getRule(rescoped.ids[0]!)!.scope, 'global');
  assert.equal(resolveSpawnResume(rescoped.reached.agent, randomUUID(), undefined), null);
  assert.equal(resolveSpawnResume(rescoped.bystander.agent, randomUUID(), undefined), rescoped.bystander.session);

  const retiered = run(slug(), ([a]) => [{ id: a!, action: 'update', tier: 'core' }]);
  assert.equal(dbApi.getRule(retiered.ids[0]!)!.tier, 'core');
  assert.equal(resolveSpawnResume(retiered.reached.agent, randomUUID(), undefined), retiered.reached.session);
});

test('no rule is changed or removed outside the fencing doors', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const direct = /dbApi\.(updateRule|supersedeRule|deleteRule)\(/;
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(path); continue; }
      if (!/\.(ts|mjs)$/.test(entry.name) || /\.test\.ts$/.test(entry.name)) continue;
      if (entry.name === 'memory-session-fence.ts') continue;
      if (direct.test(readFileSync(path, 'utf8'))) offenders.push(relative(root, path));
    }
  };
  walk(join(root, 'src'));
  walk(join(root, 'bin'));
  assert.deepEqual(offenders, [], 'go through reviseMemoryRule / supersedeMemoryRule / deleteMemoryRuleAndFence');
});
