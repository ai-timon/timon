/**
 * `/api/gpt-live/*`: an anonymous caller is refused before anything else, the
 * session route stays shut while the setting is off or the key is missing, and
 * the key travels to OpenAI only — never back to the browser. Isolated
 * TIMON_HOME, witness on 127.0.0.1:0, OpenAI replaced by a fake fetch.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-gpt-live-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerSecretRoutes } = await import('../secrets-vault/routes.js');
const { registerRoutes, GPT_LIVE_SECRET, GPT_LIVE_SETTING, DEFAULT_INSTRUCTIONS, toLiveInput } = await import('./routes.js');
const { setSetting } = await import('../../settings.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { dbApi } = await import('../../db.js');
const { hashPassword } = await import('../../users/password.js');

const TOKEN = 'witness-daemon-token';
const KEY = 'sk-live-must-not-leak';

type Sent = { url: string; auth: string | null; body: Record<string, unknown> };
const sent: Sent[] = [];
let upstreamStatus = 201;

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerSecretRoutes(app);
registerRoutes(app, {
  fetch: async (url, init) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, auth: headers.authorization ?? null, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    if (upstreamStatus !== 201) {
      return new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: upstreamStatus });
    }
    return new Response(JSON.stringify({ session: { id: 'sess_1' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }), { status: 201 });
  },
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) as Record<string, unknown> : null, res };
}

function sessionCookie(res: Response): string {
  const line = res.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
  assert.ok(line);
  return decodeURIComponent(line.split(';')[0]!.slice(SESSION_COOKIE.length + 1));
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const admin = sessionCookie(setup.res);

test('an anonymous caller is refused on both routes', async () => {
  assert.equal((await call('GET', '/api/gpt-live/status')).status, 401);
  const session = await call('POST', '/api/gpt-live/session', { body: { sdp: 'v=0 offer' } });
  assert.equal(session.status, 401);
  assert.equal(sent.length, 0);
});

test('the session stays shut while the setting is off, then while the key is missing', async () => {
  const off = await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  assert.equal(off.status, 409);
  assert.equal(off.json?.code, 'gpt_live_disabled');

  assert.deepEqual(setSetting(GPT_LIVE_SETTING, '1'), { ok: true });
  const status = await call('GET', '/api/gpt-live/status', { cookie: admin });
  assert.equal(status.json?.enabled, true);
  assert.equal(status.json?.hasKey, false);

  const noKey = await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  assert.equal(noKey.status, 409);
  assert.equal(noKey.json?.code, 'gpt_live_no_key');
  assert.deepEqual(noKey.json?.params, { secret: 'OPENAI_GPT_LIVE_API_KEY' });
  assert.equal(sent.length, 0);
});

test('a missing SDP offer is a 400', async () => {
  const res = await call('POST', '/api/gpt-live/session', { cookie: admin, body: {} });
  assert.equal(res.status, 400);
});

test('with the key in the vault, the offer reaches OpenAI in client delegation and only the answer comes back', async () => {
  const stored = await call('POST', '/api/secrets', { bearer: TOKEN, body: { name: GPT_LIVE_SECRET, value: KEY } });
  assert.equal(stored.status, 201);
  const status = await call('GET', '/api/gpt-live/status', { cookie: admin });
  assert.equal(status.json?.hasKey, true);
  assert.ok(!status.text.includes(KEY));

  const res = await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  assert.equal(res.status, 201);
  assert.deepEqual(res.json, { sessionId: 'sess_1', sdp: 'v=0 answer' });
  const last = sent.at(-1)!;
  assert.equal(last.url, 'https://api.openai.com/v1/live/sessions');
  assert.equal(last.auth, `Bearer ${KEY}`);
  const session = last.body.session as { model: string; delegation: { type: string } };
  assert.equal(session.model, 'gpt-live-1');
  assert.deepEqual(session.delegation, { type: 'client' });
  assert.deepEqual(last.body.transport, { type: 'webrtc', sdp: 'v=0 offer' });
});

test('the voice prompt carries the three delegation labels OpenAI trains on', () => {
  for (const label of ['Delegation policy:', 'Backend tools:', 'Delegate to the backend when:', 'Do not delegate to the backend when:']) {
    assert.ok(DEFAULT_INSTRUCTIONS.includes(label), label);
  }
  assert.ok(DEFAULT_INSTRUCTIONS.includes('Do not guess the result while waiting.'));
});

test('the voice prompt forbids claiming work it did not delegate, and expects unrequested results', () => {
  assert.match(DEFAULT_INSTRUCTIONS, /Never say you are looking, checking or doing something unless you delegate it/);
  assert.match(DEFAULT_INSTRUCTIONS, /results can reach you without you asking/);
});

test('the chat history seeds the session as Live input messages, oldest first', async () => {
  const res = await call('POST', '/api/gpt-live/session', {
    cookie: admin,
    body: {
      sdp: 'v=0 offer',
      history: [{ role: 'user', text: 'Salut' }, { role: 'assistant', text: 'Bonjour !' }],
    },
  });
  assert.equal(res.status, 201);
  const session = sent.at(-1)!.body.session as { input?: unknown; instructions: string };
  assert.deepEqual(session.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Salut' }] },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Bonjour !' }] },
  ]);
  assert.ok(session.instructions.startsWith(DEFAULT_INSTRUCTIONS));

  const tooMany = Array.from({ length: 41 }, () => ({ role: 'user', text: 'x' }));
  assert.equal((await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer', history: tooMany } })).status, 400);
  assert.equal((await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer', history: [{ role: 'system', text: 'x' }] } })).status, 400);

  await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  assert.equal('input' in (sent.at(-1)!.body.session as object), false);
});

test('an over-budget history loses its oldest messages whole', () => {
  const long = 'a'.repeat(3_900);
  const history = Array.from({ length: 8 }, (_, i) => ({ role: 'user' as const, text: `${i}${long}` }));
  const input = toLiveInput(history);
  assert.equal(input.length, 5);
  assert.ok(input[0]!.content[0]!.text.startsWith('3'));
  assert.ok(input.at(-1)!.content[0]!.text.startsWith('7'));
});

test('an upstream refusal maps to a code, and its body never reaches the browser', async () => {
  upstreamStatus = 401;
  const res = await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  upstreamStatus = 201;
  assert.equal(res.status, 502);
  assert.equal(res.json?.code, 'gpt_live_bad_key');
  assert.ok(!res.text.includes(KEY));
  upstreamStatus = 500;
  const other = await call('POST', '/api/gpt-live/session', { cookie: admin, body: { sdp: 'v=0 offer' } });
  upstreamStatus = 201;
  assert.equal(other.json?.code, 'gpt_live_refused');
  assert.deepEqual(other.json?.params, { status: 500 });
  assert.equal(other.json?.upstreamStatus, 500);
});

test('a spoken turn is written into the mission history, without waking its agent', async () => {
  const me = dbApi.getUserByEmail('admin@example.com')!;
  const missionId = 'mission-voice-1';
  dbApi.createMission(missionId, 'demo.agent', 'voice mission', undefined, me.id);
  const body = { role: 'user', text: '  Où en est le build ?  ', startMs: 1000, endMs: 2400, clientId: 'v_1' }; // french-ok: a spoken sample

  assert.equal((await call('POST', `/api/missions/${missionId}/voice-transcript`, { body })).status, 401);
  assert.equal((await call('POST', '/api/missions/nope/voice-transcript', { cookie: admin, body })).status, 404);
  assert.equal((await call('POST', `/api/missions/${missionId}/voice-transcript`, { cookie: admin, body: { role: 'user', text: '   ' } })).status, 400);
  assert.equal((await call('POST', `/api/missions/${missionId}/voice-transcript`, { cookie: admin, body: { role: 'agent', text: 'x' } })).status, 400);
  assert.equal(dbApi.listEvents(missionId).length, 0);

  const ok = await call('POST', `/api/missions/${missionId}/voice-transcript`, { cookie: admin, body });
  assert.equal(ok.status, 201);
  const events = dbApi.listEvents(missionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]!.type, 'voice_transcript');
  assert.deepEqual(JSON.parse(events[0]!.payload), {
    type: 'voice_transcript', role: 'user', text: 'Où en est le build ?', start_ms: 1000, end_ms: 2400, client_id: 'v_1', // french-ok: a spoken sample
  });
});

test('a voice turn reading out the agent answer is journaled with its relay mark', async () => {
  const me = dbApi.getUserByEmail('admin@example.com')!;
  const missionId = 'mission-voice-relay';
  dbApi.createMission(missionId, 'demo.agent', 'voice mission', undefined, me.id);
  const url = `/api/missions/${missionId}/voice-transcript`;

  assert.equal((await call('POST', url, { body: { role: 'voice', text: 'Done.', relay: true } })).status, 401);
  assert.equal((await call('POST', url, { cookie: admin, body: { role: 'voice', text: 'Done.', relay: 'yes' } })).status, 400);
  assert.equal(dbApi.listEvents(missionId).length, 0);

  assert.equal((await call('POST', url, { cookie: admin, body: { role: 'voice', text: 'Done.', relay: true } })).status, 201);
  // Only GPT-Live can read an answer out: a user turn never carries the mark.
  assert.equal((await call('POST', url, { cookie: admin, body: { role: 'user', text: 'Thanks', relay: true } })).status, 201);
  const [voice, user] = dbApi.listEvents(missionId).map((event) => JSON.parse(event.payload) as { relay?: unknown });
  assert.equal(voice!.relay, true);
  assert.equal(user!.relay, undefined);
});

test('a signed-in user without the right to talk to missions is refused and writes nothing', async () => {
  const missionId = 'mission-voice-2';
  dbApi.createMission(missionId, 'demo.agent', 'someone else');
  createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
  const login = await call('POST', '/api/auth/login', { body: { email: 'ada@example.com', password: 'ada-secret' } });
  assert.equal(login.status, 200);
  const ada = sessionCookie(login.res);
  const res = await call('POST', `/api/missions/${missionId}/voice-transcript`, { cookie: ada, body: { role: 'voice', text: 'hello' } });
  assert.ok(res.status === 403 || res.status === 404, `got ${res.status}`);
  assert.equal(dbApi.listEvents(missionId).length, 0);
});
