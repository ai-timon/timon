/**
 * TIM-0054 — removing a project: its agents are never left behind pointing at a
 * slug that no longer exists. The caller says what becomes of them (delete,
 * detach, move) or is refused with the list. Real auth middleware, so
 * "anonymous" is a true anonymous.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-project-removal-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerProjects } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerProjects(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);

function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}
// Holds projects:manage through the cap, but is not a privileged caller.
const adminToken = missionToken('admin.agent', adminId);
// An employee: no projects:manage.
const adaToken = missionToken('ada.agent', adaId);
assert.ok(dbApi.getLiveApiToken(hashApiToken(adminToken)));


const { upsertAgent, getAgent, loadConfig } = await import('../../agent.js');
const { createProject, readMeta } = await import('../../projects.js');
const { projectDir } = await import('../../paths.js');
const { existsSync, mkdirSync } = await import('node:fs');

const workdir = mkdtempSync(join(tmpdir(), 'timon-project-removal-cwd-'));
const dirOf = (name: string) => { const d = join(workdir, name); mkdirSync(d, { recursive: true }); return d; };

function seedProject(slug: string, agents: string[]): void {
  createProject(slug, { name: slug, cwd: dirOf(slug) });
  for (const role of agents) {
    upsertAgent({ name: `${slug}.${role}`, system_prompt: 'x', config: { project: slug, cwd: dirOf(slug), role: 'coder' } });
  }
}
const slugsInList = async () => ((await call('GET', '/api/projects', { bearer: TOKEN })).json.projects as { slug: string }[]).map((p) => p.slug);

test('a project with agents is refused with the list until the caller chooses', async () => {
  seedProject('acme', ['coder', 'reviewer']);
  const refused = await call('DELETE', '/api/projects/acme', { bearer: TOKEN });
  assert.equal(refused.status, 409);
  assert.deepEqual((refused.json.agents as string[]).sort(), ['acme.coder', 'acme.reviewer']);
  assert.ok(dbApi.getProjectRow('acme'), 'nothing was removed');
  assert.ok(existsSync(projectDir('acme')));
  assert.ok(getAgent('acme.coder'));
});

test('delete: the agents leave with the project', async () => {
  const r = await call('DELETE', '/api/projects/acme?agents=delete', { bearer: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getProjectRow('acme'), undefined);
  assert.equal(existsSync(projectDir('acme')), false);
  assert.equal(getAgent('acme.coder'), null);
  assert.equal(getAgent('acme.reviewer'), null);
  assert.ok(!(await slugsInList()).includes('acme'));
});

test('detach: the agents survive without a project, even one inferred from their folder', async () => {
  seedProject('beta', ['coder']);
  // A folder under `.../projects/<slug>` would otherwise keep inferring the project.
  const nested = join(workdir, 'projects', 'beta');
  mkdirSync(nested, { recursive: true });
  upsertAgent({ name: 'beta.coder', system_prompt: 'x', config: { project: 'beta', cwd: nested, role: 'coder' } });
  assert.equal(getAgent('beta.coder')?.project, 'beta');
  const r = await call('DELETE', '/api/projects/beta?agents=detach', { bearer: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getProjectRow('beta'), undefined);
  const agent = getAgent('beta.coder');
  assert.ok(agent, 'the agent is kept');
  assert.ok(!agent.project, `no project left, got ${agent.project}`);
  // A Windows path carries no `…/projects/<slug>` marker: the folder implied nothing and stays.
  if (process.platform !== 'win32') assert.equal(loadConfig('beta.coder').cwd, undefined, 'the folder that implied the project is dropped');
});

test('move: the agents join the other project and follow its folder', async () => {
  seedProject('gamma', ['coder']);
  seedProject('delta', []);
  const r = await call('DELETE', '/api/projects/gamma?agents=move&to=delta', { bearer: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getProjectRow('gamma'), undefined);
  assert.equal(getAgent('gamma.coder')?.project, 'delta');
  assert.equal(loadConfig('gamma.coder').cwd, readMeta('delta').cwd);
});

test('move to an unknown project or to itself is refused before anything changes', async () => {
  seedProject('eps', ['coder']);
  assert.equal((await call('DELETE', '/api/projects/eps?agents=move&to=nowhere', { bearer: TOKEN })).status, 400);
  assert.equal((await call('DELETE', '/api/projects/eps?agents=move&to=EPS', { bearer: TOKEN })).status, 400);
  assert.equal((await call('DELETE', '/api/projects/eps?agents=move', { bearer: TOKEN })).status, 400, '`to` is required with move');
  assert.equal((await call('DELETE', '/api/projects/eps?agents=detach&to=delta', { bearer: TOKEN })).status, 400, '`to` only goes with move');
  assert.equal((await call('DELETE', '/api/projects/eps?agents=burn', { bearer: TOKEN })).status, 400);
  assert.ok(dbApi.getProjectRow('eps'));
  assert.equal(getAgent('eps.coder')?.project, 'eps');
});

test('a project without agents still deletes with no choice to make', async () => {
  seedProject('solo', []);
  const r = await call('DELETE', '/api/projects/solo', { bearer: TOKEN });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getProjectRow('solo'), undefined);
});

test('anonymous and unprivileged callers cannot remove a project or its agents', async () => {
  seedProject('locked', ['coder']);
  assert.equal((await call('DELETE', '/api/projects/locked?agents=delete')).status, 401);
  assert.equal((await call('DELETE', '/api/projects/locked?agents=delete', { bearer: adaToken })).status, 403);
  assert.ok(dbApi.getProjectRow('locked'));
  assert.ok(getAgent('locked.coder'));
});
