import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import express from 'express';
import { dbApi, type UserRow } from '../../db.js';
import { registerRoutes } from './routes.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';

const app = express();
app.use(express.json());
// A signed-in non-superadmin, to prove a series is not steerable by a stranger.
app.use((req, _res, next) => {
  const user = req.header('X-Test-User');
  if (user) req.auth = { kind: 'session', user: { id: user } as UserRow, isSuperadmin: false };
  next();
});
app.use(createDaemonAuthMiddleware({ token: 'roles-test', required: false }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Who = 'daemon' | 'anonymous' | { user: string };
function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (who === 'daemon') headers.Authorization = 'Bearer roles-test';
  else if (who !== 'anonymous') headers['X-Test-User'] = who.user;
  return fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

function pilot(owner: string | null = null): string {
  const id = randomUUID();
  dbApi.createMission(id, 'acme.main', 'pilot', undefined, owner);
  return id;
}

{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('an anonymous caller is refused on every verb', async () => {
  const series = pilot();
  assert.equal((await call('GET', `/api/series/${series}/roles`, 'anonymous')).status, 401);
  assert.equal((await call('PUT', `/api/series/${series}/roles`, 'anonymous', { scope: 'review', backend: 'codex' })).status, 401);
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review`, 'anonymous')).status, 401);
  assert.deepEqual(dbApi.listSeriesRoles(series), []);
});

test('sets, lists and clears a series role', async () => {
  const series = pilot();
  const put = await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', backend: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(put.status, 200);
  const listed = await (await call('GET', `/api/series/${series}/roles`, 'daemon')).json() as { roles: { scope: string; backend: string; model: string }[] };
  assert.deepEqual(listed.roles.map((r) => [r.scope, r.backend, r.model]), [['review', 'codex', 'gpt-5.6-sol']]);
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review`, 'daemon')).status, 200);
  assert.deepEqual(dbApi.listSeriesRoles(series), []);
});

test('rejects invalid bodies before they reach the database', async () => {
  const series = pilot();
  for (const body of [
    { scope: 'orchestrator', backend: 'codex' },
    { scope: 'review' },
    { scope: 'review', backend: 'nope' },
    { scope: 'review', backend: 'claude', model: 'gpt-5.6-sol' },
    { scope: 'review', backend: 'codex', extra: 1 },
  ]) {
    assert.equal((await call('PUT', `/api/series/${series}/roles`, 'daemon', body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await call('DELETE', `/api/series/${series}/roles/orchestrator`, 'daemon')).status, 400);
  assert.deepEqual(dbApi.listSeriesRoles(series), []);
});

test('a user who does not own the series gets 404, its owner gets through', async () => {
  const series = pilot('owner-1');
  const stranger = await call('PUT', `/api/series/${series}/roles`, { user: 'stranger' }, { scope: 'review', backend: 'codex' });
  assert.equal(stranger.status, 404);
  assert.equal((await call('GET', `/api/series/${series}/roles`, { user: 'stranger' })).status, 404);
  assert.deepEqual(dbApi.listSeriesRoles(series), []);
  const owner = await call('PUT', `/api/series/${series}/roles`, { user: 'owner-1' }, { scope: 'review', backend: 'claude' });
  assert.equal(owner.status, 200);
});

// ── Backend privilege (TODO #561) ─────────────────────────────────────────────

test('its owner cannot put the series on a backend it could not give a task: role and fallback refused, audited', async () => {
  const series = pilot('owner-3');
  const owner = { user: 'owner-3' };
  const audits = () => dbApi.listAuditLog(500).filter((row) => row.action === 'series.override_denied').length;
  const before = audits();
  const role = await call('PUT', `/api/series/${series}/roles`, owner, { scope: 'code', backend: 'codex', model: 'gpt-5.6-sol' });
  assert.equal(role.status, 403);
  assert.match(String(((await role.json()) as { reason?: string }).reason), /series role rule: backend codex cannot arbitrate/);
  const fallback = await call('PUT', `/api/series/${series}/fallbacks`, owner, { scope: '*', backend: 'codex', apply: false });
  assert.equal(fallback.status, 403);
  const grouped = await call('PUT', `/api/series/${series}/fallbacks`, owner, { scope: 'code', group: 'hard', backend: 'codex', apply: false });
  assert.equal(grouped.status, 403);
  assert.deepEqual(dbApi.listSeriesRoles(series), []);
  assert.deepEqual(dbApi.listSeriesFallbacks(series), []);
  assert.deepEqual(dbApi.listSeriesGroupFallbacks(series), []);
  assert.equal(audits(), before + 3);
});

test('its owner still names a backend that arbitrates each tool use, says "no fallback", or names a model alone', async () => {
  const series = pilot('owner-4');
  const owner = { user: 'owner-4' };
  assert.equal((await call('PUT', `/api/series/${series}/roles`, owner, { scope: 'code', backend: 'claude', model: 'opus' })).status, 200);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, owner, { scope: 'code', backend: 'claude', model: 'sonnet', apply: false })).status, 200);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, owner, { scope: '*', backend: null, apply: false })).status, 200);
  assert.equal((await call('PUT', `/api/series/${series}/roles`, owner, { scope: 'review', model: 'sonnet' })).status, 200);
});

test('an operator puts a series on any backend', async () => {
  const series = pilot('owner-5');
  assert.equal((await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'code', backend: 'codex' })).status, 200);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, 'daemon', { scope: 'code', backend: 'codex', apply: false })).status, 200);
});

// ── Per-group rules (TODO #433) ───────────────────────────────────────────────

test('a group choice is set, listed with its group, and cleared by group', async () => {
  const series = pilot();
  assert.equal((await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', backend: 'codex', model: 'gpt-5.6-sol' })).status, 200);
  const put = await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', group: ' hard ', backend: 'claude', model: 'sonnet' });
  assert.equal(put.status, 200);
  const listed = await (await call('GET', `/api/series/${series}/roles`, 'daemon')).json() as { roles: { scope: string; backend: string; plan_group: string | null }[] };
  // Series-wide rows first (plan_group null), then the group's, name trimmed.
  assert.deepEqual(listed.roles.map((r) => [r.scope, r.backend, r.plan_group]), [['review', 'codex', null], ['review', 'claude', 'hard']]);
  // Clearing the group leaves the series choice; clearing without a group leaves the group's.
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review?group=hard`, 'daemon')).status, 200);
  assert.deepEqual(dbApi.listSeriesGroupRoles(series), []);
  assert.equal(dbApi.listSeriesRoles(series).length, 1);
});

test('a group fallback rule is set, listed and cleared by group; the pilot takes none', async () => {
  const series = pilot();
  const put = await call('PUT', `/api/series/${series}/fallbacks`, 'daemon', { scope: 'code', group: 'hard', backend: 'claude', model: 'opus', apply: false });
  assert.equal(put.status, 200);
  const body = await put.json() as { fallbacks: { scope: string; plan_group: string | null }[] };
  assert.deepEqual(body.fallbacks.map((f) => [f.scope, f.plan_group]), [['code', 'hard']]);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, 'daemon', { scope: 'orchestrator', group: 'hard', backend: 'claude', apply: false })).status, 400);
  assert.equal((await call('DELETE', `/api/series/${series}/fallbacks/code?group=hard`, 'daemon')).status, 200);
  assert.deepEqual(dbApi.listSeriesGroupFallbacks(series), []);
});

test('a group name is a bounded label: blank, too long, not a string and repeated query are refused', async () => {
  const series = pilot();
  for (const group of ['', '   ', 'x'.repeat(61), 7]) {
    const res = await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', group, backend: 'codex' });
    assert.equal(res.status, group === '' ? 200 : 400, JSON.stringify(group));
  }
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review?group=a&group=b`, 'daemon')).status, 400);
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review?group=${encodeURIComponent('x'.repeat(61))}`, 'daemon')).status, 400);
  assert.equal((await call('DELETE', `/api/series/${series}/fallbacks/code?group=${encodeURIComponent('   ')}`, 'daemon')).status, 400);
  assert.deepEqual(dbApi.listSeriesGroupRoles(series), []);
});

test('a group name with a control character is refused on every entry: rule body, delete query, task creation', async () => {
  const series = pilot();
  const before = dbApi.listTasks().length;
  for (const group of ['a\nb', 'a\rb', 'tab\there', 'nul\u0000', 'del\u007f', '\u001b[0m']) {
    const label = JSON.stringify(group);
    assert.equal((await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', group, backend: 'codex' })).status, 400, label);
    assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, 'daemon', { scope: 'code', group, backend: 'codex', apply: false })).status, 400, label);
    assert.equal((await call('DELETE', `/api/series/${series}/roles/review?group=${encodeURIComponent(group)}`, 'daemon')).status, 400, label);
    assert.equal((await call('DELETE', `/api/series/${series}/fallbacks/code?group=${encodeURIComponent(group)}`, 'daemon')).status, 400, label);
    assert.equal((await call('POST', '/api/tasks', 'daemon', { title: 'bad', agent_name: 'acme.coder', plan_group: group })).status, 400, label);
  }
  assert.deepEqual(dbApi.listSeriesGroupRoles(series), []);
  assert.deepEqual(dbApi.listSeriesGroupFallbacks(series), []);
  assert.equal(dbApi.listTasks().length, before);
  // Accented letters and inner spaces are a name like any other.
  assert.equal((await call('PUT', `/api/series/${series}/roles`, 'daemon', { scope: 'review', group: 'très simple', backend: 'codex' })).status, 200); // french-ok: an accented group label
});

test('group rules are refused to an anonymous caller and hidden from a stranger, fallbacks included', async () => {
  const series = pilot('owner-2');
  const rule = { scope: 'review', group: 'hard', backend: 'codex' };
  assert.equal((await call('PUT', `/api/series/${series}/roles`, 'anonymous', rule)).status, 401);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, 'anonymous', { ...rule, apply: false })).status, 401);
  assert.equal((await call('GET', `/api/series/${series}/fallbacks`, 'anonymous')).status, 401);
  assert.equal((await call('DELETE', `/api/series/${series}/fallbacks/review?group=hard`, 'anonymous')).status, 401);
  assert.equal((await call('PUT', `/api/series/${series}/roles`, { user: 'stranger' }, rule)).status, 404);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, { user: 'stranger' }, { ...rule, apply: false })).status, 404);
  assert.equal((await call('GET', `/api/series/${series}/fallbacks`, { user: 'stranger' })).status, 404);
  assert.equal((await call('DELETE', `/api/series/${series}/roles/review?group=hard`, { user: 'stranger' })).status, 404);
  assert.deepEqual(dbApi.listSeriesGroupRoles(series), []);
  assert.deepEqual(dbApi.listSeriesGroupFallbacks(series), []);
  // Its owner names a backend it may select (TODO #561: codex is not one).
  const allowed = { ...rule, backend: 'claude' };
  assert.equal((await call('PUT', `/api/series/${series}/roles`, { user: 'owner-2' }, allowed)).status, 200);
  assert.equal((await call('PUT', `/api/series/${series}/fallbacks`, { user: 'owner-2' }, { ...allowed, apply: false })).status, 200);
  assert.equal((await call('GET', `/api/series/${series}/fallbacks`, { user: 'owner-2' })).status, 200);
});

test('a task is created with its plan group, trimmed; a bad one is refused before any write', async () => {
  const ok = await call('POST', '/api/tasks', 'daemon', { title: 'grouped', agent_name: 'acme.coder', plan_group: ' hard ' });
  assert.equal(ok.status, 201);
  const { task } = await ok.json() as { task: { id: string; plan_group: string | null } };
  assert.equal(task.plan_group, 'hard');
  assert.equal(dbApi.getTask(task.id)?.plan_group, 'hard');
  const plain = await call('POST', '/api/tasks', 'daemon', { title: 'plain', agent_name: 'acme.coder' });
  assert.equal(((await plain.json()) as { task: { plan_group: string | null } }).task.plan_group, null);
  const before = dbApi.listTasks().length;
  for (const plan_group of ['x'.repeat(61), '   ', 12, {}]) {
    const res = await call('POST', '/api/tasks', 'daemon', { title: 'bad', agent_name: 'acme.coder', plan_group });
    assert.equal(res.status, 400, JSON.stringify(plan_group));
  }
  assert.equal(dbApi.listTasks().length, before);
});
