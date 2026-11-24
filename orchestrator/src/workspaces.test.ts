import './test-home.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';

const { dbApi } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { agentDir } = await import('./paths.js');
const { registerRoutes } = await import('./plugins-bundled/projects/routes.js');
const { listWorkspaceRecords, workspaceSlug } = await import('./workspaces.js');

for (const name of ['_main.perso', 'pilot']) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME }));
}

type Who = 'stranger' | 'reader' | 'manager';
async function withServer(fn: (call: (method: string, path: string, who: Who, body?: unknown) => Promise<Response>) => Promise<void>) {
  const app = express();
  app.use(express.json());
  // Stand-in for the daemon's auth middleware: an api-token carrying the
  // grants of the persona the test names.
  app.use((req, _res, next) => {
    const who = req.header('x-test-who') as Who;
    const permissions = who === 'manager' ? ['projects:manage'] : [];
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions };
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as AddressInfo).port;
  try {
    await fn((method, path, who, body) => fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-test-who': who },
      body: body === undefined ? undefined : JSON.stringify(body),
    }));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test('a caller without projects:manage cannot create, edit or delete a pole', async () => {
  dbApi.insertWorkspace({ slug: 'locked', name: 'Locked', color: null, lead_agent: null });
  await withServer(async (call) => {
    for (const who of ['stranger', 'reader'] as const) {
      assert.equal((await call('POST', '/api/workspaces', who, { name: 'Nope' })).status, 403);
      assert.equal((await call('PATCH', '/api/workspaces/locked', who, { name: 'Nope' })).status, 403);
      assert.equal((await call('DELETE', '/api/workspaces/locked', who)).status, 403);
    }
    assert.equal((await call('GET', '/api/workspaces', 'reader')).status, 200);
  });
  assert.equal(dbApi.getWorkspaceRow('locked')?.name, 'Locked');
  assert.equal(dbApi.getWorkspaceRow('nope'), undefined);
});

test('input is validated before it reaches the database', async () => {
  await withServer(async (call) => {
    assert.equal((await call('POST', '/api/workspaces', 'manager', {})).status, 400);
    assert.equal((await call('POST', '/api/workspaces', 'manager', { name: 'X', color: 'red' })).status, 400);
    assert.equal((await call('POST', '/api/workspaces', 'manager', { name: 'X', extra: 1 })).status, 400);
    assert.equal((await call('POST', '/api/workspaces', 'manager', { name: 'X', lead_agent: 'ghost' })).status, 400);
    assert.equal((await call('PATCH', '/api/workspaces/missing', 'manager', { name: 'Y' })).status, 404);
  });
});

test('an empty pole can be created, led, renamed and deleted', async () => {
  await withServer(async (call) => {
    const created = await call('POST', '/api/workspaces', 'manager', { name: 'Design Studio', color: '#112233' });
    assert.equal(created.status, 201);
    const { workspace } = await created.json() as { workspace: { slug: string; projects: string[] } };
    assert.equal(workspace.slug, 'design-studio');
    assert.deepEqual(workspace.projects, []);
    assert.equal((await call('POST', '/api/workspaces', 'manager', { name: 'design studio' })).status, 400, 'same slug twice');

    const led = await call('PATCH', '/api/workspaces/design-studio', 'manager', { lead_agent: 'pilot', name: 'Agence' });
    assert.equal(led.status, 200);
    assert.equal(dbApi.getWorkspaceRow('design-studio')?.lead_agent, 'pilot');
    assert.equal(dbApi.getWorkspaceRow('design-studio')?.name, 'Agence');

    const listed = await (await call('GET', '/api/projects', 'reader')).json() as { workspaces: string[] };
    assert.ok(listed.workspaces.includes('Agence'), 'an empty pole is offered to the project picker');

    assert.equal((await call('DELETE', '/api/workspaces/design-studio', 'manager')).status, 200);
    assert.equal(dbApi.getWorkspaceRow('design-studio'), undefined);
  });
});

test('project tags become poles, a legacy `_main.<ws>` hub becomes their lead', () => {
  dbApi.upsertProject('blog', { workspace: 'Perso' });
  dbApi.upsertProject('shop', { workspace: 'Clients Pro' });
  const records = listWorkspaceRecords();
  const perso = records.find((w) => w.slug === 'perso');
  assert.deepEqual(perso && { name: perso.name, lead: perso.lead_agent, projects: perso.projects }, { name: 'Perso', lead: '_main.perso', projects: ['blog'] });
  const clients = records.find((w) => w.slug === 'clients-pro');
  assert.deepEqual(clients && { lead: clients.lead_agent, projects: clients.projects }, { lead: null, projects: ['shop'] });
  // Idempotent: a second read inserts nothing new.
  assert.equal(listWorkspaceRecords().length, records.length);
});

test('deleting a pole keeps its projects and its lead agent', async () => {
  dbApi.upsertProject('app', { workspace: 'Temp' });
  listWorkspaceRecords();
  dbApi.updateWorkspace('temp', { lead_agent: 'pilot' });
  await withServer(async (call) => {
    assert.equal((await call('DELETE', '/api/workspaces/temp', 'manager')).status, 200);
  });
  assert.equal(dbApi.getProjectRow('app')?.workspace, null);
  assert.ok(dbApi.getProjectRow('app'));
  assert.equal(listWorkspaceRecords().some((w) => w.slug === 'temp'), false, 'the detached tag does not resurrect it');
});

test('workspaceSlug folds case, accents and spaces', () => {
  assert.equal(workspaceSlug('  Équipe Été '), 'equipe-ete'); // french-ok: an accented name the slug folds
  assert.equal(workspaceSlug('Design Studio'), 'design-studio');
});

test('a renamed pole keeps the projects tagged with its old or its new name', () => {
  dbApi.upsertProject('old', { workspace: 'Studio' });
  listWorkspaceRecords();
  dbApi.updateWorkspace('studio', { name: 'Atelier Pro' });
  dbApi.upsertProject('new', { workspace: 'Atelier Pro' });
  const records = listWorkspaceRecords();
  assert.deepEqual(records.find((w) => w.slug === 'studio')?.projects, ['new', 'old']);
  assert.equal(records.some((w) => w.slug === 'atelier-pro'), false, 'no second pole');
});
