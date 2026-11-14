/**
 * `POST /api/missions/:id/rewind` (docs/specs/rewind.md, "HTTP route"): the
 * owner's own interactive chat, from a person's session, never while a turn runs,
 * only to a visible message the user typed.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-rewind-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { whileTurnPrepares } = await import('../../agent.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');

const TOKEN = 'rewind-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json({ limit: '5mb' }));
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => { server.close(); });

async function call(path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(opts.body ?? {}) });
  return { status: res.status, json: await res.json() as Record<string, unknown>, res };
}

function cookieOf(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  assert.fail('no session cookie');
}

const setup = await call('/api/auth/setup', { body: { email: 'owner@example.com', name: 'Owner', password: 'owner-secret' } });
assert.equal(setup.status, 201);
const ownerId = (setup.json as { user: { id: string } }).user.id;
assert.equal((await postTestAccount(dbApi, { email: 'other@example.com', name: 'Other', password: 'other-secret' })).status, 201);
const ownerCookie = cookieOf((await call('/api/auth/login', { body: { email: 'owner@example.com', password: 'owner-secret' } })).res);
const otherCookie = cookieOf((await call('/api/auth/login', { body: { email: 'other@example.com', password: 'other-secret' } })).res);

const IMAGE = { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' };

function chat(channel = 'chat') {
  const id = randomUUID();
  dbApi.createMission(id, 'rewind.agent', 'hello', { channel }, ownerId);
  const first = dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: 'first question' } }).id;
  const answer = dbApi.insertEvent(id, 'assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'answer' }] } }).id;
  const toolResult = dbApi.insertEvent(id, 'user', { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } }).id;
  const fromAgent = dbApi.insertEvent(id, 'user', {
    type: 'user', message: { role: 'user', content: 'from a peer' }, origin: { kind: 'agent', from: 'peer.agent' },
  }).id;
  const second = dbApi.insertEvent(id, 'user', {
    type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'look at this' }, { type: 'image', source: IMAGE }] },
  }).id;
  dbApi.finishMission(id, 'completed', 0);
  return { id, first, answer, toolResult, fromAgent, second };
}

const rewind = (id: string, eventId: number, auth: { cookie?: string; bearer?: string } = { cookie: ownerCookie }) =>
  call(`/api/missions/${id}/rewind`, { body: { event_id: eventId }, ...auth });

test('anonymous and daemon-token requests are refused', async () => {
  const m = chat();
  assert.equal((await rewind(m.id, m.second, {})).status, 401);
  assert.equal((await rewind(m.id, m.second, { bearer: TOKEN })).status, 403);
  assert.equal(dbApi.getPendingRewind(m.id), null);
});

test('someone else\'s chat and a daemon-started mission are refused', async () => {
  const m = chat();
  assert.equal((await rewind(m.id, m.second, { cookie: otherCookie })).status, 403);
  const task = chat('dispatcher');
  assert.equal((await rewind(task.id, task.second)).status, 403);
  const spawned = chat('agent');
  assert.equal((await rewind(spawned.id, spawned.second)).status, 403);
});

test('only a visible message the user typed can be rewound to', async () => {
  const m = chat();
  for (const eventId of [m.answer, m.toolResult, m.fromAgent, 999_999_999]) {
    assert.equal((await rewind(m.id, eventId)).status, 400, `event ${eventId}`);
  }
  assert.equal((await call(`/api/missions/${m.id}/rewind`, { body: { event_id: 'x' }, cookie: ownerCookie })).status, 400);
  assert.equal((await rewind(m.id, m.second)).status, 200);
  assert.equal((await rewind(m.id, m.second)).status, 400, 'already rewound: no longer visible');
});

test('a running turn answers 409', async () => {
  const m = chat();
  let release!: () => void;
  const held = whileTurnPrepares(m.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const res = await rewind(m.id, m.second);
  release();
  await held;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'turn_in_progress');
});

test('the owner rewinds and gets the removed message back', async () => {
  const m = chat();
  const res = await rewind(m.id, m.second);
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.restored, { text: 'look at this', images: [{ media_type: 'image/png', data: IMAGE.data }] });
  const rewindId = res.json.rewind_event_id as number;
  assert.deepEqual(dbApi.listEvents(m.id).map((e) => e.id), [m.first, m.answer, m.toolResult, m.fromAgent, rewindId]);
  assert.equal(dbApi.getPendingRewind(m.id)?.rewind_event_id, rewindId);

  const further = await rewind(m.id, m.first);
  assert.equal(further.status, 200);
  assert.deepEqual(further.json.restored, { text: 'first question', images: [] });
  assert.deepEqual(dbApi.listEvents(m.id).map((e) => e.id), [further.json.rewind_event_id]);
});

const undo = (id: string, auth: { cookie?: string; bearer?: string } = { cookie: ownerCookie }) =>
  call(`/api/missions/${id}/rewind/undo`, auth);

test('undo is the owner\'s only, from a session', async () => {
  const m = chat();
  assert.equal((await rewind(m.id, m.second)).status, 200);
  assert.equal((await undo(m.id, {})).status, 401);
  assert.equal((await undo(m.id, { bearer: TOKEN })).status, 403);
  assert.equal((await undo(m.id, { cookie: otherCookie })).status, 403);
  assert.ok(dbApi.getPendingRewind(m.id), 'nothing was taken back');
});

test('undo takes back every rewind since the last message, with the session', async () => {
  const m = chat();
  dbApi.setMissionSession(m.id, 'spoken-session');
  const all = dbApi.listEvents(m.id).map((e) => e.id);
  assert.equal((await rewind(m.id, m.second)).status, 200);
  assert.equal((await rewind(m.id, m.first)).status, 200);
  assert.equal(dbApi.getMission(m.id)?.session_id, null);

  const res = await undo(m.id);
  assert.equal(res.status, 200);
  assert.deepEqual(dbApi.listEvents(m.id).map((e) => e.id), all, 'the thread as it was, without the rewind markers');
  assert.equal(dbApi.getMission(m.id)?.session_id, 'spoken-session');
  assert.equal(dbApi.getPendingRewind(m.id), null);
  assert.equal((await undo(m.id)).status, 409, 'nothing left to undo');
});

test('undo refuses once something was sent after the rewind, and leaves an older rewind alone', async () => {
  const m = chat();
  assert.equal((await rewind(m.id, m.second)).status, 200);
  dbApi.insertEvent(m.id, 'user', { type: 'user', message: { role: 'user', content: 'new branch' } });
  const res = await undo(m.id);
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'rewind_not_undoable');
  assert.equal(dbApi.listEvents(m.id).some((e) => e.id === m.second), false, 'still rewound');

  // A new series after the message: its undo restores only what it hid.
  dbApi.clearPendingRewind(m.id); // the message's launch spent it
  const visible = dbApi.listEvents(m.id).map((e) => e.id);
  assert.equal((await rewind(m.id, m.first)).status, 200);
  assert.equal((await undo(m.id)).status, 200);
  assert.deepEqual(dbApi.listEvents(m.id).map((e) => e.id), visible);
});

test('undo during a turn answers 409', async () => {
  const m = chat();
  assert.equal((await rewind(m.id, m.second)).status, 200);
  let release!: () => void;
  const held = whileTurnPrepares(m.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const res = await undo(m.id);
  release();
  await held;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'turn_in_progress');
});

test('a mission token is refused, its own mission\'s and another\'s, for rewind and undo alike', async () => {
  // Live tokens: a mission's token only lives while it runs.
  const token = (id: string) => { dbApi.reopenMission(id); return issueMissionApiToken(id); };
  const m = chat();
  const own = token(m.id);
  const foreign = token(chat().id);
  for (const bearer of [own, foreign]) {
    assert.equal((await rewind(m.id, m.second, { bearer })).status, 403);
  }
  assert.equal(dbApi.getPendingRewind(m.id), null, 'nothing was cut');

  assert.equal((await rewind(m.id, m.second)).status, 200);
  for (const bearer of [own, foreign]) {
    assert.equal((await undo(m.id, { bearer })).status, 403);
  }
  assert.ok(dbApi.getPendingRewind(m.id), 'nothing was taken back');
});
