/**
 * Capped catch-up of old titles: `POST /api/missions/titles/backfill` and
 * `runTitleBackfill`. Targets, dry run by default, ceiling, quota stop,
 * rank protection, owner scope, anonymous refusal.
 *
 * `npm test -- src/plugins-bundled/missions/title-backfill.test.ts`
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-title-backfill-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { planTitleBackfill, runTitleBackfill, backfillCeiling } = await import('../../mission-titles-backfill.js');

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

const adminViewer = { id: adminId, isSuperadmin: false };
const LOCAL = () => ({ backend: 'claude', model: 'haiku' });
const noSleep = async () => {};

function mission(ownerId: string, text = 'Fix the login page'): string {
  const id = randomUUID();
  dbApi.createMission(id, 'timon.main', text, undefined, ownerId);
  return id;
}

test('targets untitled and cut generated titles, never manual, preset or native', async () => {
  const bare = mission(beaId);
  const cut = mission(beaId);
  dbApi.setMissionTitleIfUnclaimed(cut, 'Fix the login pa…', 'generated');
  const good = mission(beaId);
  dbApi.setMissionTitleIfUnclaimed(good, 'Fix the login page', 'generated');
  const manual = mission(beaId);
  dbApi.setMissionTitle(manual, 'Mine…');
  const preset = mission(beaId);
  dbApi.setMissionPresetTitle(preset, 'Preset…');
  const native = mission(beaId);
  dbApi.setMissionTitleIfUnclaimed(native, 'Native…', 'native');
  const viewer = { id: beaId, isSuperadmin: false };
  const plan = planTitleBackfill({ viewer, limit: 100 });
  assert.deepEqual([plan.dryRun, plan.targeted, plan.calls], [true, 2, 2]);
  let calls = 0;
  const out = await runTitleBackfill({ viewer, limit: 100, dryRun: false, delayMs: 0, sleep: noSleep, deps: { resolveLlm: LOCAL, oneShot: async () => { calls++; return `Title ${calls}`; } } });
  assert.deepEqual([out?.written, out?.stopped, calls], [2, null, 2]);
  assert.equal(dbApi.getMission(good)?.title, 'Fix the login page');
  assert.equal(dbApi.getMission(manual)?.title, 'Mine…');
  assert.equal(dbApi.getMission(preset)?.title, 'Preset…');
  assert.equal(dbApi.getMission(native)?.title, 'Native…');
  assert.ok(dbApi.getMission(bare)?.title?.startsWith('Title'));
  assert.equal(dbApi.getMission(cut)?.title_source, 'generated');
});

test('dry run is the default: no model call, nothing written', async () => {
  const id = mission(adminId);
  let calls = 0;
  const out = await runTitleBackfill({ viewer: adminViewer, deps: { resolveLlm: LOCAL, oneShot: async () => { calls++; return 'X'; } } });
  assert.equal(out?.dryRun, true);
  assert.ok((out?.targeted ?? 0) >= 1);
  assert.equal(calls, 0);
  assert.equal(dbApi.getMission(id)?.title, null);
});

test('the ceiling lowers the limit, the default is 50, calls are paused', async () => {
  for (let i = 0; i < 4; i++) mission(adminId);
  assert.equal(planTitleBackfill({ viewer: adminViewer }).limit, Math.min(50, backfillCeiling()));
  assert.equal(planTitleBackfill({ viewer: adminViewer, limit: 1_000_000 }).limit, backfillCeiling());
  const pauses: number[] = [];
  const out = await runTitleBackfill({ viewer: adminViewer, limit: 3, dryRun: false, delayMs: 7, sleep: async (ms) => { pauses.push(ms); }, deps: { resolveLlm: LOCAL, oneShot: async () => 'A title' } });
  assert.equal(out?.targeted, 3);
  assert.deepEqual(pauses, [7, 7]);
});

test('the first quota signal stops the run cleanly', async () => {
  for (let i = 0; i < 4; i++) mission(beaId);
  let calls = 0;
  const out = await runTitleBackfill({ viewer: { id: beaId, isSuperadmin: false }, limit: 4, dryRun: false, delayMs: 0, sleep: noSleep, deps: { resolveLlm: LOCAL, oneShot: async () => { calls++; if (calls === 2) throw new Error('429 quota exceeded'); return `T${calls}`; } } });
  assert.deepEqual([out?.written, out?.failed, out?.stopped, calls], [1, 1, 'quota', 2]);
});

test('generation turned off stops the run without a call', async () => {
  mission(adminId);
  const out = await runTitleBackfill({ viewer: adminViewer, limit: 2, dryRun: false, delayMs: 0, sleep: noSleep, deps: { resolveLlm: () => 'off', oneShot: async () => 'never' } });
  assert.deepEqual([out?.stopped, out?.written], ['off', 0]);
});

test('the viewer scopes the targets to its own missions', () => {
  const mine = mission(beaId);
  const plan = planTitleBackfill({ viewer: { id: beaId, isSuperadmin: false }, limit: 1000 });
  assert.ok(plan.targeted >= 1);
  assert.equal(dbApi.listTitleBackfillCandidates({ id: beaId, isSuperadmin: false }, null, 1000).some((m) => m.owner_user_id !== beaId), false);
  assert.ok(dbApi.listTitleBackfillCandidates({ id: beaId, isSuperadmin: false }, null, 1000).some((m) => m.id === mine));
});

test('since keeps only the missions started at or after it', () => {
  const future = Date.now() + 60_000;
  assert.equal(planTitleBackfill({ viewer: adminViewer, since: future }).targeted, 0);
});

test('route: anonymous refused, bad body 400, dry run by default writes nothing', async () => {
  const id = mission(beaId);
  const anon = await call('POST', '/api/missions/titles/backfill', { body: {} });
  assert.equal(anon.status, 401);
  const bea = await login('bea@example.com', 'bea-secret');
  assert.equal((await call('POST', '/api/missions/titles/backfill', { cookie: bea, body: { limit: 0 } })).status, 400);
  assert.equal((await call('POST', '/api/missions/titles/backfill', { cookie: bea, body: { since: 'not a date' } })).status, 400);
  assert.equal((await call('POST', '/api/missions/titles/backfill', { cookie: bea, body: { extra: 1 } })).status, 400);
  const dry = await call('POST', '/api/missions/titles/backfill', { cookie: bea, body: { since: '2020-01-01', limit: 10 } });
  assert.equal(dry.status, 200);
  const json = dry.json as { dryRun: boolean; targeted: number; calls: number; written: number };
  assert.deepEqual([json.dryRun, json.written], [true, 0]);
  assert.ok(json.targeted >= 1 && json.calls === json.targeted);
  assert.equal(dbApi.getMission(id)?.title, null);
});
