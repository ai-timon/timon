import '../../test-home.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import type { PrOpenDeps } from '../../pr-open.js';
import { registerPrRoutes } from './pr-routes.js';

// Every network gesture is a stand-in that records the call: a test that
// reached one of them from a refused request would fail on `touched`.
let touched = 0;
const deps: PrOpenDeps = {
  forge: () => ({
    async login() { touched += 1; return { ok: true, login: 'ai-bot' }; },
    async repositoryAccess() { return { ok: true, exists: true, canPush: true }; },
    async forkRepository() { return { ok: true }; },
    async createPullRequest() { touched += 1; return { ok: false, code: 'gh_failed', reason: 'stub' }; },
  }),
  transport: () => ({
    async remoteBranchSha() { touched += 1; return { ok: true, sha: null }; },
    async fetchBranch() { touched += 1; return { ok: true }; },
    async pushBranch() { touched += 1; return { ok: true }; },
  }),
  publicTree: async () => { touched += 1; return { ran: false }; },
  agentCwd: () => null,
};

const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'manager') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['projects:manage'] };
  else if (who === 'writer') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, permissions: ['kanban:write', 'projects:read'] };
  next();
});
registerPrRoutes(app, deps);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const ID = 'f2b0b1a4-6c3e-4a51-9a63-0c1d2e3f4a5b';
const ROUTES = [`/api/tasks/${ID}/pull-request`, `/api/series/${ID}/pull-request`];

function post(who: 'anonymous' | 'writer' | 'manager' | 'daemon', body: unknown, path = ROUTES[0]!) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who !== 'anonymous') headers['x-test-who'] = who;
  return fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

const VALID = { title: 'Add x', body: 'Why x.' };

test('an anonymous request is refused before anything is read or pushed', async () => {
  for (const path of ROUTES) assert.equal((await post('anonymous', VALID, path)).status, 401, path);
  assert.equal(touched, 0);
});

test('a caller without projects:manage is refused', async () => {
  for (const path of ROUTES) assert.equal((await post('writer', VALID, path)).status, 403, path);
  assert.equal(touched, 0);
});

test('a body that does not validate is refused with its reason', async () => {
  for (const body of [
    {},
    { body: 'no title' },
    { title: '   ' },
    { title: 'x', force: true },
    { title: 'x', base: 'main' },
    { title: 'x'.repeat(300) },
    { title: 'x', body: 'y'.repeat(16_001) },
  ]) {
    const res = await post('manager', body);
    assert.equal(res.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(((await res.json()) as { code: string }).code, 'pr_request_invalid');
  }
  assert.equal((await post('manager', VALID, '/api/tasks/a.b/pull-request')).status, 400);
  assert.equal(touched, 0);
});

test('the daemon token and a manager reach the action: an unknown job is 404', async () => {
  for (const who of ['daemon', 'manager'] as const) {
    for (const path of ROUTES) {
      const res = await post(who, VALID, path);
      assert.equal(res.status, 404, `${who} ${path}`);
      assert.equal(((await res.json()) as { code: string }).code, 'pr_target_not_found');
    }
  }
  assert.equal(touched, 0);
  assert.equal(dbApi.getTask(ID), undefined);
});
