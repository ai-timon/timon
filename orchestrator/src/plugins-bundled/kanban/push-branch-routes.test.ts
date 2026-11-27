import '../../test-home.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { registerPushBranchRoutes } from './push-branch-routes.js';

let gitCalls = 0;
const app = express();
app.use(express.json());
// Stand-in for the daemon's auth middleware.
app.use((req, _res, next) => {
  const who = req.header('x-test-who');
  if (who === 'daemon') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
  else if (who === 'mission') req.auth = { kind: 'api-token', user: null, isSuperadmin: false, missionId: 'no-such-mission' };
  else if (who === 'plain') req.auth = { kind: 'api-token', user: null, isSuperadmin: false };
  next();
});
registerPushBranchRoutes(app, { git: async () => { gitCalls += 1; return { code: 0, stdout: '', stderr: '' }; } });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function post(who: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who) headers['x-test-who'] = who;
  return fetch(`${base}/api/tasks/t1/push-branch`, { method: 'POST', headers, body: JSON.stringify(body) });
}

test('an anonymous request is refused before anything is read or pushed', async () => {
  assert.equal((await post(null, { branch: 'SELP-1_a' })).status, 401);
  assert.equal(gitCalls, 0);
});

test('the daemon token and a token with no mission are refused', async () => {
  assert.equal((await post('daemon', { branch: 'SELP-1_a' })).status, 403);
  assert.equal((await post('plain', { branch: 'SELP-1_a' })).status, 403);
  assert.equal(gitCalls, 0);
});

test('a malformed body is a 400, an unknown mission is refused', async () => {
  assert.equal((await post('mission', {})).status, 400);
  assert.equal((await post('mission', { branch: 'SELP-1_a', force: true })).status, 400);
  assert.equal((await post('mission', { branch: 'SELP-1_a' })).status, 403);
  assert.equal(gitCalls, 0);
});
