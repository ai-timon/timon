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
const { planTitleBackfill, runTitleBackfill, backfillCeiling, startTitleBackfillJob, getTitleBackfillJob, resetTitleBackfillJobs } = await import('../../mission-titles-backfill.js');

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
  assert.deepEqual([json.dryRun, json.written], [true, undefined]);
  assert.ok(json.targeted >= 1 && json.calls === json.targeted);
  assert.equal(dbApi.getMission(id)?.title, null);
});

/** A model call that waits for the test to let it through, so a job can be observed mid-run. */
function gate(): { oneShot: () => Promise<string>; release: () => void; started: Promise<void> } {
  let release!: () => void;
  const pass = new Promise<void>((r) => { release = r; });
  let signalStarted!: () => void;
  const started = new Promise<void>((r) => { signalStarted = r; });
  let n = 0;
  return { oneShot: async () => { signalStarted(); await pass; return `Gated ${++n}`; }, release, started };
}

async function settled(jobId: string, viewer: { id: string; isSuperadmin: boolean }) {
  for (let i = 0; i < 200; i++) {
    const j = getTitleBackfillJob(jobId, viewer);
    if (j && j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job did not settle');
}

const beaViewer = { id: beaId, isSuperadmin: false };

test('a real run is a background job: it answers at once and reports progress', async () => {
  resetTitleBackfillJobs();
  for (let i = 0; i < 3; i++) mission(beaId);
  const g = gate();
  const job = startTitleBackfillJob({ viewer: beaViewer, limit: 3, delayMs: 0, sleep: noSleep, deps: { resolveLlm: LOCAL, oneShot: g.oneShot } });
  assert.ok(job);
  assert.equal(job.status, 'running');
  assert.equal(job.targeted, 3);
  await g.started;
  assert.deepEqual([getTitleBackfillJob(job.jobId, beaViewer)?.status, getTitleBackfillJob(job.jobId, beaViewer)?.processed], ['running', 0]);
  g.release();
  const end = await settled(job.jobId, beaViewer);
  assert.deepEqual([end.status, end.processed, end.written, end.skipped, end.errored, end.lastError], ['done', 3, 3, 0, 0, null]);
  assert.ok(end.finishedAt !== null);
});

test('one running job per account: a second start is refused, another account is not', async () => {
  resetTitleBackfillJobs();
  mission(beaId);
  mission(adminId);
  const g = gate();
  const first = startTitleBackfillJob({ viewer: beaViewer, limit: 1, delayMs: 0, deps: { resolveLlm: LOCAL, oneShot: g.oneShot } });
  assert.ok(first);
  await g.started;
  assert.equal(startTitleBackfillJob({ viewer: beaViewer, limit: 1, deps: { resolveLlm: LOCAL, oneShot: async () => 'x' } }), null);
  const route = await call('POST', '/api/missions/titles/backfill', { cookie: await login('bea@example.com', 'bea-secret'), body: { dryRun: false } });
  assert.equal(route.status, 409);
  const other = startTitleBackfillJob({ viewer: adminViewer, limit: 1, delayMs: 0, deps: { resolveLlm: LOCAL, oneShot: async () => 'Other' } });
  assert.ok(other);
  g.release();
  await settled(first.jobId, beaViewer);
  await settled(other.jobId, adminViewer);
  // Once finished, the account can start again.
  const again = startTitleBackfillJob({ viewer: beaViewer, limit: 1, delayMs: 0, deps: { resolveLlm: LOCAL, oneShot: async () => 'Again' } });
  assert.ok(again);
  await settled(again.jobId, beaViewer);
});

test('cancel stops between two missions and keeps what was written', async () => {
  resetTitleBackfillJobs();
  for (let i = 0; i < 4; i++) mission(beaId);
  const g = gate();
  const job = startTitleBackfillJob({ viewer: beaViewer, limit: 4, delayMs: 0, deps: { resolveLlm: LOCAL, oneShot: g.oneShot } });
  assert.ok(job);
  await g.started;
  const bea = await login('bea@example.com', 'bea-secret');
  const cancel = await call('POST', `/api/missions/titles/backfill/${job.jobId}/cancel`, { cookie: bea });
  assert.equal(cancel.status, 200);
  assert.equal((cancel.json as { cancelRequested: boolean }).cancelRequested, true);
  g.release();
  const end = await settled(job.jobId, beaViewer);
  assert.deepEqual([end.status, end.processed, end.written], ['cancelled', 1, 1]);
});

test('a quota signal ends the job as stopped_quota with a fixed message', async () => {
  resetTitleBackfillJobs();
  for (let i = 0; i < 3; i++) mission(beaId);
  let calls = 0;
  const job = startTitleBackfillJob({ viewer: beaViewer, limit: 3, delayMs: 0, sleep: noSleep, deps: { resolveLlm: LOCAL, oneShot: async () => { calls++; throw new Error('429 quota exceeded for key sk-secret-123'); } } });
  assert.ok(job);
  const end = await settled(job.jobId, beaViewer);
  assert.deepEqual([end.status, end.errored, end.processed, calls], ['stopped_quota', 1, 1, 1]);
  assert.equal(end.lastError, 'the title model is out of quota');
  assert.doesNotMatch(JSON.stringify(end), /sk-secret/);
});

test('routes: a real run answers 202 with a job id, the owner reads it, anonymous and others are refused', async () => {
  resetTitleBackfillJobs();
  const carol = await postTestAccount(dbApi, { email: 'carol@example.com', name: 'Carol', password: 'carol-secret' });
  const carolId = (carol.json as { user: { id: string } }).user.id;
  const cookie = await login('carol@example.com', 'carol-secret');
  // Carol has no mission, so the job ends at once without any model call.
  const started = await call('POST', '/api/missions/titles/backfill', { cookie, body: { dryRun: false } });
  assert.equal(started.status, 202);
  const { jobId } = started.json as { jobId: string };
  assert.ok(jobId);
  const own = await settled(jobId, { id: carolId, isSuperadmin: false });
  assert.equal(own.status, 'done');
  const read = await call('GET', `/api/missions/titles/backfill/${jobId}`, { cookie });
  assert.equal(read.status, 200);
  const body = read.json as { status: string; targeted: number; processed: number; written: number; skipped: number; errored: number; lastError: string | null };
  assert.deepEqual([body.status, body.targeted, body.processed, body.written, body.skipped, body.errored, body.lastError], ['done', 0, 0, 0, 0, 0, null]);
  assert.equal((await call('GET', `/api/missions/titles/backfill/${jobId}`)).status, 401);
  assert.equal((await call('POST', `/api/missions/titles/backfill/${jobId}/cancel`)).status, 401);
  const bea = await login('bea@example.com', 'bea-secret');
  assert.equal((await call('GET', `/api/missions/titles/backfill/${jobId}`, { cookie: bea })).status, 404);
  assert.equal((await call('POST', `/api/missions/titles/backfill/${jobId}/cancel`, { cookie: bea })).status, 404);
  assert.equal((await call('GET', '/api/missions/titles/backfill/unknown', { cookie })).status, 404);
});
