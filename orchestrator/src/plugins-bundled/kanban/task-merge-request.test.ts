/**
 * The pull / merge request a task carries as data: parsing of its URL, and the
 * writes that record it (task PUT, closing as BLOCKED or DONE). A refused value
 * changes nothing; an anonymous caller is refused before any of it is read.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { mergeRequestOf, parseMergeRequestUrl } from '../../merge-request.js';
import { registerRoutes } from './routes.js';
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const app = express();
app.use((req, _res, next) => {
  if (req.header('x-test-as') === 'writer') {
    req.auth = { kind: 'api-token', isSuperadmin: false, actorId: OWNER, permissions: ['kanban:read', 'kanban:write'] };
  }
  next();
});
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, as: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(as ? { 'x-test-as': as } : {}) };
  return fetch(`${base}${path}`, { method, headers, body: JSON.stringify(body) });
}
function seed(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'MR witness', 'witness', { ownerUserId: OWNER, type: 'merge' });
  return id;
}
const GITLAB = 'https://gitlab.example.com/group/sub/project/-/merge_requests/1875';
const GITHUB = 'https://github.com/ai-timon/timon/pull/12';

test('the forge and number come from the URL', () => {
  assert.deepEqual(parseMergeRequestUrl(`${GITLAB}/diffs?x=1#note`), { url: GITLAB, forge: 'gitlab', number: 1875 });
  assert.deepEqual(parseMergeRequestUrl(GITHUB), { url: GITHUB, forge: 'github', number: 12 });
});

test('anything else is refused: scheme, credentials, other pages', () => {
  for (const bad of ['javascript:alert(1)', 'ftp://gitlab.example.com/a/-/merge_requests/1',
    'https://user:token@gitlab.example.com/a/-/merge_requests/1', 'https://github.com/ai-timon/timon/issues/12',
    'https://gitlab.example.com/a/b', 'not a url']) {
    assert.equal(parseMergeRequestUrl(bad), null, bad);
  }
});

test('PUT records the request, defaulting to open, and keeps it when only the state moves', async () => {
  const id = seed();
  const put = await call('PUT', `/api/tasks/${id}`, 'writer', { merge_request: { url: GITLAB, pipeline: 'running' } });
  assert.equal(put.status, 200);
  assert.deepEqual(mergeRequestOf(dbApi.getTask(id)!), { url: GITLAB, forge: 'gitlab', number: 1875, state: 'open', pipeline: 'running' });
  await call('PUT', `/api/tasks/${id}`, 'writer', { merge_request: { url: GITLAB, state: 'merged' } });
  assert.deepEqual(mergeRequestOf(dbApi.getTask(id)!), { url: GITLAB, forge: 'gitlab', number: 1875, state: 'merged', pipeline: 'running' });
});

test('an invalid URL or state is a 400 and writes nothing', async () => {
  const id = seed();
  const badUrl = await call('PUT', `/api/tasks/${id}`, 'writer', { title: 'changed', merge_request: { url: 'https://example.com/x' } });
  assert.equal(badUrl.status, 400);
  assert.equal(((await badUrl.json()) as { code?: string }).code, 'merge_request_invalid');
  const badState = await call('PUT', `/api/tasks/${id}`, 'writer', { merge_request: { url: GITHUB, state: 'draft' } });
  assert.equal(badState.status, 400);
  const row = dbApi.getTask(id)!;
  assert.equal(row.mr_url, null);
  assert.equal(row.title, 'MR witness');
});

test('closing as BLOCKED carries the request next to the reason', async () => {
  const id = seed();
  const r = await call('POST', '/api/tasks/close', 'writer', { id, outcome: 'failed', reason: 'MR open, waiting for a merge', merge_request: { url: GITHUB } });
  assert.equal(r.status, 200);
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.mr_number, 12);
  assert.equal(row.mr_forge, 'github');
});

test('closing with an invalid request is refused before the task moves', async () => {
  const id = seed();
  const r = await call('POST', '/api/tasks/close', 'writer', { id, outcome: 'failed', reason: 'x', merge_request: { url: 'nope' } });
  assert.equal(r.status, 400);
  assert.notEqual(dbApi.getTask(id)!.status, 'BLOCKED');
});

test('anonymous writes carrying a request are refused', async () => {
  const id = seed();
  assert.equal((await call('PUT', `/api/tasks/${id}`, null, { merge_request: { url: GITHUB } })).status, 401);
  assert.equal((await call('POST', '/api/tasks/close', null, { id, outcome: 'failed', reason: 'x', merge_request: { url: GITHUB } })).status, 401);
  assert.equal(dbApi.getTask(id)!.mr_url, null);
});
