/**
 * TIM-0067 — handing an idea to its project's orchestrator finds it by ROLE.
 *
 * The route used to accept `<slug>.main` only: an orchestrator named anything
 * else (`toto.Orchestrator`, `config.role = 'orchestrator'`) was never found
 * and the handoff answered 400. It now shares the dispatcher's rule.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Router } from 'express';

const todoRoutes = await import('./project-todo-routes.js');
await import('../../../tests/helpers/claude-provider.js');

const { AGENTS_DIR, TIMON_HOME } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { upsertAgent } = await import('../../agent.js');

async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

const d = await serve(todoRoutes.registerRoutes);
test.after(() => d.close());
// Its own cwd, distinct from the agents': the `_main` case below must not be
// attached to `toto` through its cwd and pass for the wrong reason.
dbApi.upsertProject('toto', { cwd: join(TIMON_HOME, 'toto-repo') });

function agent(name: string, config: Record<string, unknown>): void {
  upsertAgent({ name, system_prompt: 'x', config: { cwd: TIMON_HOME, ...config } });
}

// `orchestrator` is a protected key that `upsertAgent` strips: an operator (or
// an agent with shell access) writes it straight into config.json.
function flaggedAgent(name: string, config: Record<string, unknown>): void {
  mkdirSync(join(AGENTS_DIR, name), { recursive: true });
  writeFileSync(join(AGENTS_DIR, name, 'system-prompt.md'), 'x');
  writeFileSync(join(AGENTS_DIR, name, 'config.json'), JSON.stringify({ cwd: TIMON_HOME, ...config }));
}

async function handoff(): Promise<{ status: number; body: { to_agent?: string; error?: string } }> {
  const created = await fetch(d.url('/api/project-todo'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'une idée', project: 'toto' }), // french-ok: free-text sample data
  });
  assert.equal(created.status, 201);
  const { item } = (await created.json()) as { item: { id: number } };
  const r = await fetch(d.url(`/api/project-todo/${item.id}/handoff`), { method: 'POST' });
  return { status: r.status, body: (await r.json()) as { to_agent?: string; error?: string } };
}

test('no orchestrator anywhere: explicit 400', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  const r = await handoff();
  assert.equal(r.status, 400);
  assert.match(r.body.error ?? '', /no orchestrator for project "toto"/);
});

test('legacy fallback: <slug>.main is found when nobody holds the role', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  agent('toto.main', { project: 'toto' });
  const r = await handoff();
  assert.equal(r.status, 201);
  assert.equal(r.body.to_agent, 'toto.main');
});

test('an orchestrator with a free name is found by its role, ahead of <slug>.main', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  // A legacy `<slug>.main`, from before roles were stamped: `upsertAgent` would
  // give it the role too, and the order of the folder listing (sorted on
  // Windows) would pick between two role holders.
  flaggedAgent('toto.main', { project: 'toto' });
  agent('toto.Orchestrator', { project: 'toto', role: 'orchestrator' });
  // An orchestrator of ANOTHER project must not be picked up.
  agent('other.Orchestrator', { project: 'other', role: 'orchestrator' });
  const r = await handoff();
  assert.equal(r.status, 201);
  assert.equal(r.body.to_agent, 'toto.Orchestrator');
});

test('a project without an orchestrator falls back to the cross-project one', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  agent('_main', { role: 'orchestrator' });
  const r = await handoff();
  assert.equal(r.status, 201);
  assert.equal(r.body.to_agent, '_main');
});

test('an orchestrator carrying the flag but no role is found (TIM-0067, domotique.Orchestrator)', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  agent('_main', { role: 'orchestrator' });
  flaggedAgent('toto.Orchestrator', { project: 'toto', orchestrator: true });
  const r = await handoff();
  assert.equal(r.status, 201);
  assert.equal(r.body.to_agent, 'toto.Orchestrator');
});

test('the role holder wins over a flag holder, and an ephemeral flag holder is ignored', async () => {
  rmSync(AGENTS_DIR, { force: true, recursive: true });
  flaggedAgent('toto.helper', { project: 'toto', orchestrator: true });
  agent('toto.lead', { project: 'toto', role: 'orchestrator' });
  let r = await handoff();
  assert.equal(r.body.to_agent, 'toto.lead');

  rmSync(AGENTS_DIR, { force: true, recursive: true });
  agent('_main', { role: 'orchestrator' });
  flaggedAgent('toto.tmp', { project: 'toto', orchestrator: true, ephemeral: true });
  r = await handoff();
  assert.equal(r.body.to_agent, '_main');
});
