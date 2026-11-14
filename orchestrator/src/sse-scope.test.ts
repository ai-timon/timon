/**
 * M.1f — SSE and /api/events/recent are scoped to the viewer, like
 * listMissions. A signed-in employee must not receive another user's
 * transcripts on `/api/stream`, nor open `/api/missions/:id/stream` on
 * an id they do not own (404, so existence stays hidden).
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Request, Response } from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-sse-scope-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { sseHandler } = await import('./sse.js');
const { bus } = await import('./bus.js');
const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerHttpRoutes } = await import('./plugins-bundled/http/routes.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { SESSION_COOKIE } = await import('./users/session.js');
import type { RequestAuth } from './users/identity.js';

const admin = createTestAccount(dbApi, {
  email: 'admin@example.com',
  name: 'Admin',
  passwordHash: await hashPassword('admin-secret'),
  isSuperadmin: true,
});
const ada = createTestAccount(dbApi, {
  email: 'ada@example.com',
  name: 'Ada',
  passwordHash: await hashPassword('ada-secret'),
  isSuperadmin: false,
});

const adminMission = randomUUID();
const adaMission = randomUUID();
const unowned = randomUUID();
dbApi.createMission(adminMission, 'admin.agent', 'admin mission', undefined, admin.id);
dbApi.createMission(adaMission, 'ada.agent', 'ada mission', undefined, ada.id);
dbApi.createMission(unowned, 'system.agent', 'system mission');
dbApi.insertEvent(adminMission, 'assistant', { text: 'admin-secret-transcript' });
dbApi.insertEvent(adaMission, 'assistant', { text: 'ada-own-transcript' });
dbApi.insertEvent(unowned, 'assistant', { text: 'unowned-transcript' });

const adaAuth: RequestAuth = { kind: 'session', user: ada, isSuperadmin: false };
const adminAuth: RequestAuth = { kind: 'session', user: admin, isSuperadmin: true };

type FakeStream = {
  chunks: string[];
  close: () => void;
  statusCode: number;
  jsonBody: unknown;
  headersFlushed: boolean;
};

function fakeStream(opts: { missionId?: string; auth?: RequestAuth } = {}): FakeStream {
  const state: FakeStream = {
    chunks: [],
    close: () => {},
    statusCode: 200,
    jsonBody: undefined,
    headersFlushed: false,
  };
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => { state.headersFlushed = true; },
    write: (s: string) => { state.chunks.push(s); return true; },
    status(code: number) { state.statusCode = code; return res; },
    json(body: unknown) { state.jsonBody = body; return res; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, {
    params: { id: opts.missionId ?? '' },
    ...(opts.auth ? { auth: opts.auth } : {}),
  });
  sseHandler(req, res);
  state.close = () => { (req as unknown as EventEmitter).emit('close'); };
  return state;
}

function publishAssistant(missionId: string, text: string): void {
  bus.publish({
    kind: 'event',
    missionId,
    type: 'assistant',
    timestamp: Date.now(),
    payload: { text },
  });
}

test('a non-owner gets 404 on another user\'s per-mission stream', () => {
  const s = fakeStream({ missionId: adminMission, auth: adaAuth });
  assert.equal(s.statusCode, 404);
  assert.equal(s.headersFlushed, false);
  assert.deepEqual(s.jsonBody, { error: 'mission not found', code: 'mission_not_found' });
  assert.equal(s.chunks.join(''), '');
  s.close();
});

test('a non-owner also gets 404 on a missing mission id (no existence leak)', () => {
  const s = fakeStream({ missionId: randomUUID(), auth: adaAuth });
  assert.equal(s.statusCode, 404);
  assert.deepEqual(s.jsonBody, { error: 'mission not found', code: 'mission_not_found' });
  s.close();
});

test('the owner replays their own per-mission stream', () => {
  const s = fakeStream({ missionId: adaMission, auth: adaAuth });
  assert.equal(s.statusCode, 200);
  assert.equal(s.headersFlushed, true);
  assert.ok(s.chunks.join('').includes('ada-own-transcript'));
  assert.ok(!s.chunks.join('').includes('admin-secret-transcript'));
  s.close();
});

test('the global stream hides other users\' events from a regular viewer', () => {
  const s = fakeStream({ auth: adaAuth });
  const before = s.chunks.length;
  publishAssistant(adminMission, 'live-admin-secret');
  publishAssistant(adaMission, 'live-ada-ok');
  publishAssistant(unowned, 'live-unowned');
  const wire = s.chunks.slice(before).join('');
  assert.ok(wire.includes('live-ada-ok'));
  assert.ok(!wire.includes('live-admin-secret'));
  assert.ok(!wire.includes('live-unowned'));
  s.close();
});

test('a superadmin receives every mission on the global stream', () => {
  const s = fakeStream({ auth: adminAuth });
  const before = s.chunks.length;
  publishAssistant(adminMission, 'sa-admin');
  publishAssistant(adaMission, 'sa-ada');
  publishAssistant(unowned, 'sa-unowned');
  const wire = s.chunks.slice(before).join('');
  assert.ok(wire.includes('sa-admin'));
  assert.ok(wire.includes('sa-ada'));
  assert.ok(wire.includes('sa-unowned'));
  s.close();
});

test('a null viewer keeps the historical unscoped stream', () => {
  const missing = randomUUID();
  const perMission = fakeStream({ missionId: missing });
  assert.equal(perMission.statusCode, 200);
  assert.equal(perMission.headersFlushed, true);
  assert.equal(perMission.jsonBody, undefined);

  const global = fakeStream();
  const before = global.chunks.length;
  publishAssistant(adminMission, 'anon-admin');
  publishAssistant(adaMission, 'anon-ada');
  const wire = global.chunks.slice(before).join('');
  assert.ok(wire.includes('anon-admin'));
  assert.ok(wire.includes('anon-ada'));
  perMission.close();
  global.close();
});

test('mission_start invalidates the ownership memo', () => {
  const transferred = randomUUID();
  dbApi.createMission(transferred, 'admin.agent', 'will move', undefined, admin.id);
  const s = fakeStream({ auth: adaAuth });
  publishAssistant(transferred, 'before-transfer');
  assert.ok(!s.chunks.join('').includes('before-transfer'));

  dbApi.setMissionOwner(transferred, ada.id);
  bus.publish({
    kind: 'event',
    missionId: transferred,
    type: 'mission_start',
    timestamp: Date.now(),
    payload: { started: true },
  });
  assert.ok(s.chunks.join('').includes('"type":"mission_start"'));
  s.close();
});

test('plugins_changed still reaches a regular viewer on the global stream', () => {
  const s = fakeStream({ auth: adaAuth });
  const before = s.chunks.length;
  bus.publish({ kind: 'plugins_changed', plugins: [] });
  const wire = s.chunks.slice(before).join('');
  assert.ok(wire.includes('event: plugins_changed\n'));
  s.close();
});

test('task closures reach the global stream of the task\'s viewers only', () => {
  const adaTask = randomUUID();
  const adminTask = randomUUID();
  dbApi.createTask(adaTask, 'ada task', 'ada.agent', { ownerUserId: ada.id });
  dbApi.createTask(adminTask, 'admin task', 'admin.agent', { ownerUserId: admin.id });
  const adaGlobal = fakeStream({ auth: adaAuth });
  const adminGlobal = fakeStream({ auth: adminAuth });
  const adaMissionStream = fakeStream({ auth: adaAuth, missionId: adaMission });
  try {
    for (const s of [adaGlobal, adminGlobal, adaMissionStream]) s.chunks.length = 0;
    bus.publish({ kind: 'task_done', taskId: adaTask });
    bus.publish({ kind: 'task_blocked', taskId: adminTask, reason: 'secret-blocking-reason' });
    bus.publish({ kind: 'task_blocked', taskId: adaTask, reason: 'ada-reason' });

    const adaWire = adaGlobal.chunks.join('');
    assert.ok(adaWire.includes(`event: task_done\ndata: {"kind":"task_done","taskId":"${adaTask}"}\n\n`));
    assert.ok(adaWire.includes(`event: task_blocked\ndata: {"kind":"task_blocked","taskId":"${adaTask}"}\n\n`));
    assert.ok(!adaWire.includes(adminTask), 'another user\'s task stays hidden');
    assert.ok(!adaWire.includes('ada-reason'), 'the reason never travels on the stream');

    const adminWire = adminGlobal.chunks.join('');
    assert.ok(adminWire.includes(adminTask));
    assert.ok(adminWire.includes(adaTask));
    assert.ok(!adminWire.includes('secret-blocking-reason'));

    assert.equal(adaMissionStream.chunks.join(''), '', 'a per-mission stream carries no task closure');
  } finally {
    for (const s of [adaGlobal, adminGlobal, adaMissionStream]) s.close();
  }
});

test('a task start reaches its owner only, with its title, and never for a follow-up', () => {
  const adaTask = randomUUID();
  const adminTask = randomUUID();
  const review = randomUUID();
  dbApi.createTask(adaTask, 'ada starts', 'ada.agent', { ownerUserId: ada.id });
  dbApi.createTask(adminTask, 'admin starts', 'admin.agent', { ownerUserId: admin.id });
  dbApi.createTask(review, 'ada review', 'ada.agent', { ownerUserId: ada.id, type: 'review', parentTaskId: adaTask });
  const adaGlobal = fakeStream({ auth: adaAuth });
  const adminGlobal = fakeStream({ auth: adminAuth });
  const adaMissionStream = fakeStream({ auth: adaAuth, missionId: adaMission });
  try {
    for (const s of [adaGlobal, adminGlobal, adaMissionStream]) s.chunks.length = 0;
    for (const id of [adaTask, adminTask, review]) {
      const missionId = randomUUID();
      dbApi.createMission(missionId, 'ada.agent', 'task mission');
      dbApi.assignTaskMission(id, missionId);
    }

    const adaWire = adaGlobal.chunks.join('');
    assert.ok(adaWire.includes(`event: task_started\ndata: {"kind":"task_started","taskId":"${adaTask}","title":"ada starts"}\n\n`));
    assert.ok(!adaWire.includes('admin starts'), 'another account\'s task stays silent');
    assert.equal(adaWire.split('event: task_started\n').length - 1, 1, 'a follow-up does not announce its start');

    // The superadmin reads every task, but hears only their own start.
    const adminWire = adminGlobal.chunks.join('');
    assert.ok(adminWire.includes('admin starts'));
    assert.ok(!adminWire.includes('ada starts'));
    assert.equal(adaMissionStream.chunks.join('').includes('task_started'), false, 'a per-mission stream carries no task start');
  } finally {
    for (const s of [adaGlobal, adminGlobal, adaMissionStream]) s.close();
  }
});

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerHttpRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: globalThis.Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: globalThis.Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const json = await res.json();
  return { status: res.status, json, res };
}

test('HTTP: events/recent and per-mission stream honour the viewer', async () => {
  const adaLogin = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'ada-secret' },
  });
  assert.equal(adaLogin.status, 200);
  const adaCookie = sessionCookie(adaLogin.res);
  assert.ok(adaCookie);

  const adminLogin = await call('POST', '/api/auth/login', {
    body: { email: 'admin@example.com', password: 'admin-secret' },
  });
  assert.equal(adminLogin.status, 200);
  const adminCookie = sessionCookie(adminLogin.res);
  assert.ok(adminCookie);

  const hidden = await fetch(`${base}/api/missions/${adminMission}/stream`, {
    headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(adaCookie)}` },
  });
  assert.equal(hidden.status, 404);
  assert.equal(((await hidden.json()) as { error: string }).error, 'mission not found');

  const adaRecent = await call('GET', '/api/events/recent', { cookie: adaCookie });
  assert.equal(adaRecent.status, 200);
  const adaEvents = (adaRecent.json as { events: Array<{ mission_id: string; payload: { text?: string } }> }).events;
  assert.ok(adaEvents.some((e) => e.mission_id === adaMission));
  assert.ok(adaEvents.every((e) => e.mission_id === adaMission));
  assert.ok(!JSON.stringify(adaEvents).includes('admin-secret-transcript'));
  assert.ok(!JSON.stringify(adaEvents).includes('unowned-transcript'));

  const adminRecent = await call('GET', '/api/events/recent', { cookie: adminCookie });
  const adminEvents = (adminRecent.json as { events: Array<{ mission_id: string }> }).events;
  const adminIds = new Set(adminEvents.map((e) => e.mission_id));
  assert.ok(adminIds.has(adminMission));
  assert.ok(adminIds.has(adaMission));
  assert.ok(adminIds.has(unowned));

  const bearerRecent = await call('GET', '/api/events/recent', { bearer: TOKEN });
  const bearerIds = new Set(
    (bearerRecent.json as { events: Array<{ mission_id: string }> }).events.map((e) => e.mission_id),
  );
  assert.ok(bearerIds.has(adminMission));
  assert.ok(bearerIds.has(adaMission));
});

test('HTTP: anonymous loopback is 401 once a user exists', async () => {
  const open = express();
  open.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
  open.use(express.json());
  registerHttpRoutes(open);
  const srv = open.listen(0, '127.0.0.1');
  await once(srv, 'listening');
  const p = (srv.address() as AddressInfo).port;
  assert.notEqual(p, 3000);
  try {
    const res = await fetch(`http://127.0.0.1:${p}/api/events/recent`);
    assert.equal(res.status, 401);
    assert.deepEqual(await res.json(), { error: 'unauthorized' });
  } finally {
    await new Promise<void>((resolve, reject) => {
      srv.close((err) => (err ? reject(err) : resolve()));
    });
  }
});

test('plugin realtime reaches only its owner on a global stream', async () => {
  const { publishPluginRealtime } = await import('./plugins/realtime.js');
  const other = createTestAccount(dbApi, { email: 'other@example.com', name: 'Other',
    passwordHash: await hashPassword('other-secret'), isSuperadmin: false });
  const streams = [
    fakeStream({ auth: { kind: 'session', user: other, isSuperadmin: false } }),
    fakeStream({ auth: adminAuth }),
    fakeStream({ auth: { kind: 'api-token', user: other, isSuperadmin: false,
      permissions: ['missions:read:all', 'kanban:read:all', 'notifications:read:all'] } }),
    fakeStream(),
    fakeStream({ auth: adaAuth, missionId: adaMission }),
    fakeStream({ auth: adaAuth }),
  ];
  try {
    for (const stream of streams) stream.chunks.length = 0;
    publishPluginRealtime('@timon/kanban', 'changed', { refresh: true }, { ownerUserId: ada.id });
    for (const stream of streams.slice(0, -1)) assert.deepEqual(stream.chunks, []);
    const wire = streams.at(-1)!.chunks.join('');
    assert.equal(wire, 'event: plugin:@timon/kanban:changed\n'
      + 'data: {"plugin":"@timon/kanban","topic":"changed","payload":{"refresh":true}}\n\n');
    assert.ok(!wire.includes(ada.id));
    assert.ok(!wire.includes('ownerUserId'));
    streams.at(-1)!.chunks.length = 0;
    publishPluginRealtime('third-party', 'task_done', {}, { ownerUserId: ada.id });
    assert.equal(streams.at(-1)!.chunks[0], 'event: plugin:third-party:task_done\n');
  } finally { for (const stream of streams) stream.close(); }
});

test('a direct navigation reaches only its owner\'s global stream', () => {
  const owner = fakeStream({ auth: adaAuth });
  const stranger = fakeStream({ auth: adminAuth });
  const perMission = fakeStream({ missionId: adaMission, auth: adaAuth });
  const before = (s: FakeStream) => s.chunks.length;
  const marks = [before(owner), before(stranger), before(perMission)];
  bus.publish({ kind: 'ui_navigate', ownerUserId: ada.id, path: '/agents', params: {} });
  const got = (s: FakeStream, mark: number) => s.chunks.slice(mark).join('');
  assert.match(got(owner, marks[0]!), /event: ui_navigate/);
  // A superadmin sees every mission and notification, never another account's screen.
  assert.doesNotMatch(got(stranger, marks[1]!), /ui_navigate/);
  // A mission's own stream closes when its chat unmounts: not a channel for the screen.
  assert.doesNotMatch(got(perMission, marks[2]!), /ui_navigate/);
  owner.close(); stranger.close(); perMission.close();
});

test('a finished turn sounds for an interactive mission of the viewer, never a task\'s or a failed one', () => {
  const taskMission = randomUUID();
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'sound task', 'ada.agent', {});
  dbApi.createMission(taskMission, 'ada.agent', 'task mission', undefined, ada.id);
  dbApi.setMissionLineage(taskMission, { taskId });
  const owner = fakeStream({ auth: adaAuth });
  const stranger = fakeStream({ auth: adminAuth });
  const mark = owner.chunks.length;
  const markStranger = stranger.chunks.length;
  bus.publish({ kind: 'turn_complete', missionId: adaMission, outcome: 'completed' });
  bus.publish({ kind: 'turn_complete', missionId: adaMission, outcome: 'failed' });
  bus.publish({ kind: 'turn_complete', missionId: taskMission, outcome: 'completed' });
  try {
  const text = owner.chunks.slice(mark).join('');
  assert.equal((text.match(/event: mission_turn_done/g) ?? []).length, 1);
  const done = [...text.matchAll(/event: mission_turn_done\ndata: (.*)\n/g)].map((m) => (JSON.parse(m[1]!) as { missionId: string }).missionId);
  assert.deepEqual(done, [adaMission], 'only the interactive mission, once');
  assert.match(stranger.chunks.slice(markStranger).join(''), /mission_turn_done/, 'a superadmin sees every mission, so hears it too');
  } finally {
    owner.close(); stranger.close();
  }
});

test('a permission card is announced by name on the global stream, only to who sees the mission', () => {
  const owner = fakeStream({ auth: adaAuth });
  const perMission = fakeStream({ missionId: adaMission, auth: adaAuth });
  const marks = [owner.chunks.length, perMission.chunks.length];
  const card = (missionId: string, type: string) =>
    bus.publish({ kind: 'event', missionId, type, timestamp: Date.now() + 10_000, payload: { id: 'perm-1', tool: 'Bash' } });
  card(adaMission, 'permission_request');
  card(adaMission, 'permission_resolved');
  card(adaMission, 'permission_expired');
  card(adminMission, 'permission_request');
  card(adaMission, 'assistant');
  try {
    const text = owner.chunks.slice(marks[0]).join('');
    const named = [...text.matchAll(/event: (permission_\w+)\ndata: (.*)\n/g)]
      .map((m) => [m[1], JSON.parse(m[2]!) as { kind: string; missionId: string }] as const);
    assert.deepEqual(named, [
      ['permission_request', { kind: 'permission_request', missionId: adaMission }],
      ['permission_resolved', { kind: 'permission_resolved', missionId: adaMission }],
      ['permission_expired', { kind: 'permission_expired', missionId: adaMission }],
    ], 'one named frame per card event of her own mission, without the card payload');
    assert.doesNotMatch(text, new RegExp(adminMission), 'another account\'s card stays hidden');
    // The chat of one mission reads the `event` frame itself: no echo there.
    assert.doesNotMatch(perMission.chunks.slice(marks[1]).join(''), /event: permission_/);
  } finally {
    owner.close(); perMission.close();
  }
});
