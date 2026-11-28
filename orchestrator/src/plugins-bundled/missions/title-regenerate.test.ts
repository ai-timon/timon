/**
 * Explicit re-title: `POST /api/missions/:id/title/regenerate` and
 * `regenerateMissionTitle`. Rank of the sources, `force`, the 409 refusal, an
 * anonymous request and another owner's mission.
 *
 * `npm test -- src/plugins-bundled/missions/title-regenerate.test.ts`
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-title-regenerate-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { regenerateMissionTitle, regeneratePromptInput } = await import('../../mission-titles.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json(), res };
}

async function login(email: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(res.res);
  assert.ok(cookie, `no session for ${email}`);
  return cookie;
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const created = await postTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', password: 'bea-secret' });
const beaId = (created.json as { user: { id: string } }).user.id;

function mission(ownerId?: string): string {
  const id = randomUUID();
  dbApi.createMission(id, 'timon.main', 'Fix the login page', undefined, ownerId);
  return id;
}
const LOCAL = () => ({ backend: 'claude', model: 'haiku' });
const answering = (answer: string, seen: string[] = []) => async (_a: string, _c: unknown, message: string) => { seen.push(message); return answer; };

test('a generated, native or absent title is replaced by a generated one', async () => {
  for (const setUp of [() => undefined, (id: string) => dbApi.setMissionTitleIfUnclaimed(id, 'Old', 'generated'), (id: string) => dbApi.setMissionTitleIfUnclaimed(id, 'Old native', 'native')]) {
    const id = mission();
    setUp(id);
    const out = await regenerateMissionTitle(id, {}, { resolveLlm: LOCAL, oneShot: answering('"Fix login page."') });
    assert.deepEqual(out, { status: 'written', title: 'Fix login page' });
    assert.deepEqual([dbApi.getMission(id)?.title, dbApi.getMission(id)?.title_source], ['Fix login page', 'generated']);
  }
});

test('manual and preset are protected without force, replaced with it, and the one-shot is not re-armed', async () => {
  for (const [source, setUp] of [['manual', (id: string) => dbApi.setMissionTitle(id, 'Mine')], ['preset', (id: string) => dbApi.setMissionPresetTitle(id, 'Preset')]] as const) {
    const id = mission();
    setUp(id);
    const before = dbApi.getMission(id)?.title_generation;
    let calls = 0;
    const oneShot = async () => { calls++; return 'New title'; };
    assert.deepEqual(await regenerateMissionTitle(id, {}, { resolveLlm: LOCAL, oneShot }), { status: 'protected', source });
    assert.equal(calls, 0, 'a protected title costs no model call');
    assert.equal(dbApi.getMission(id)?.title_source, source);
    assert.deepEqual(await regenerateMissionTitle(id, { force: true }, { resolveLlm: LOCAL, oneShot }), { status: 'written', title: 'New title' });
    assert.equal(dbApi.getMission(id)?.title_source, 'generated');
    assert.equal(dbApi.getMission(id)?.title_generation, before);
  }
});

test('a rename landing during the model call wins without force', async () => {
  const id = mission();
  const out = await regenerateMissionTitle(id, {}, { resolveLlm: LOCAL, oneShot: async () => { dbApi.setMissionTitle(id, 'Raced'); return 'Generated'; } });
  assert.equal(out?.status, 'protected');
  assert.equal(dbApi.getMission(id)?.title, 'Raced');
});

test('the prompt carries the title and the first and last messages, bounded', () => {
  const id = mission();
  dbApi.setMissionTitleIfUnclaimed(id, 'Current one', 'generated');
  for (let i = 0; i < 20; i++) {
    dbApi.insertEvent(id, i % 2 ? 'assistant' : 'user', { message: { content: i % 2 ? [{ type: 'text', text: `answer ${i} ${'x'.repeat(2000)}` }] : `question ${i}` } });
  }
  const input = regeneratePromptInput(dbApi.getMission(id)!);
  assert.match(input, /^Current title: Current one/);
  assert.match(input, /question 0/);
  assert.match(input, /answer 19/);
  assert.doesNotMatch(input, /question 10/);
  assert.ok(input.length < 5000);
});

test('failures are classified and never echo the provider message', async () => {
  const id = mission();
  const quota = await regenerateMissionTitle(id, {}, { resolveLlm: LOCAL, oneShot: async () => { throw new Error('429 quota exceeded sk-secret-123'); } });
  assert.deepEqual(quota, { status: 'failed', reason: 'quota' });
  const down = await regenerateMissionTitle(id, {}, { resolveLlm: LOCAL, oneShot: async () => { throw new Error('boom sk-secret-123'); } });
  assert.deepEqual(down, { status: 'failed', reason: 'unavailable' });
  assert.deepEqual(await regenerateMissionTitle(id, {}, { resolveLlm: () => 'off' }), { status: 'off' });
  assert.equal(await regenerateMissionTitle(randomUUID()), null);
});

test('route: anonymous refused, other owner 404, manual without force 409, bad body 400', async () => {
  const adminMission = mission(adminId);
  const beaMission = mission(beaId);
  const url = (id: string) => `/api/missions/${id}/title/regenerate`;

  const anon = await call('POST', url(adminMission), { body: {} });
  assert.equal(anon.status, 401);

  const bea = await login('bea@example.com', 'bea-secret');
  assert.equal((await call('POST', url(adminMission), { cookie: bea, body: {} })).status, 404);
  assert.equal(dbApi.getMission(adminMission)?.title, null);

  dbApi.setMissionTitle(beaMission, 'Mine');
  const refused = await call('POST', url(beaMission), { cookie: bea, body: {} });
  assert.equal(refused.status, 409);
  assert.equal((refused.json as { code?: string }).code ?? (refused.json as { error?: { code?: string } }).error?.code, 'title_protected');
  assert.equal(dbApi.getMission(beaMission)?.title, 'Mine');

  assert.equal((await call('POST', url(beaMission), { cookie: bea, body: { force: 'yes' } })).status, 400);
  assert.equal((await call('POST', url(randomUUID()), { cookie: bea, body: {} })).status, 404);
});
