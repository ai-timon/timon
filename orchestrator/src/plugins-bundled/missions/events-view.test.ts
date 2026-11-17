/**
 * `GET /api/missions/:id` views (mission-events-view.ts): the default `chat`
 * view drops the per-token rows and keeps only the last `init` and
 * `rate_limit_event` of each window, `raw` still returns every stored row, and
 * neither is readable without credentials.
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

const home = mkdtempSync(join(tmpdir(), 'timon-mission-events-view-'));
process.env.TIMON_HOME = home;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { db, dbApi, attachEventsArchive } = await import('../../db.js');
const { CHAT_VIEW_SQL, isChatViewRow } = await import('../../mission-events-view.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerMissionRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type Ev = { id: number; type: string; payload: Record<string, unknown> };
type Detail = { events?: Ev[]; status?: string };

async function get(path: string, bearer: string | null = TOKEN): Promise<{ status: number; json: Detail; res: Response }> {
  const res = await fetch(`${base}${path}`, bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {});
  return { status: res.status, json: (await res.json()) as Detail, res };
}

const mission = randomUUID();
dbApi.createMission(mission, 'view.agent', 'chat view witness');
const ins = (type: string, payload: Record<string, unknown>): number => dbApi.insertEvent(mission, type, payload).id;

const initA = ins('system', { type: 'system', subtype: 'init', session_id: 'sess-old', model: 'old-model' });
ins('user', { type: 'user', message: { role: 'user', content: 'hello' } });
for (let i = 0; i < 50; i++) ins('system', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: i });
ins('system', { type: 'system', subtype: 'status', status: 'requesting' });
ins('tool_progress', { type: 'tool_progress', tool_use_id: 't1', elapsed_time_seconds: 1 });
ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', resetsAt: 1 } });
const sevenDay = ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'seven_day', status: 'allowed', resetsAt: 2 } });
const assistant = ins('assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } });
const result = ins('result', { type: 'result', subtype: 'success' });
const initB = ins('system', { type: 'system', subtype: 'init', session_id: 'sess-new', model: 'new-model' });
const compact = ins('system', { type: 'system', subtype: 'compact_boundary' });
const fiveHour = ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed_warning', resetsAt: 3 } });
const perm = ins('permission_request', { id: 'p1', tool_name: 'Bash' });
const TOTAL = 62;

test('the default view drops the per-token rows and keeps the last init and rate limit of each window, in order', async () => {
  const { status, json } = await get(`/api/missions/${mission}`);
  assert.equal(status, 200);
  const events = json.events ?? [];
  assert.deepEqual(
    events.map((e) => e.id),
    [initA + 1, sevenDay, assistant, result, initB, compact, fiveHour, perm],
    'user, seven_day, assistant, result, last init, compact_boundary, last five_hour, permission card',
  );
  assert.ok(!events.some((e) => e.payload.subtype === 'thinking_tokens' || e.payload.subtype === 'status' || e.type === 'tool_progress'));
  const inits = events.filter((e) => e.payload.subtype === 'init');
  assert.equal(inits.length, 1);
  assert.equal(inits[0]!.payload.session_id, 'sess-new', 'the session to resume is the last one');
  assert.deepEqual(
    (await get(`/api/missions/${mission}?view=chat`)).json.events?.map((e) => e.id),
    events.map((e) => e.id),
    '`chat` is the default view',
  );
});

test('`view=raw` returns every stored row, thinking tokens included', async () => {
  const { status, json } = await get(`/api/missions/${mission}?view=raw`);
  assert.equal(status, 200);
  assert.equal(json.events?.length, TOTAL);
  assert.equal(json.events?.filter((e) => e.payload.subtype === 'thinking_tokens').length, 50);
  assert.equal(dbApi.listEvents(mission).length, TOTAL, 'nothing was deleted');
});

test('`view=status` carries no events, an unknown view is refused', async () => {
  const light = await get(`/api/missions/${mission}?view=status`);
  assert.equal(light.status, 200);
  assert.equal(light.json.events, undefined);
  assert.equal((await get(`/api/missions/${mission}?view=everything`)).status, 400);
});

test('an anonymous caller reads no view of the journal', async () => {
  for (const view of ['', '?view=chat', '?view=raw']) {
    const anon = await get(`/api/missions/${mission}${view}`, null);
    assert.equal(anon.status, 401, `anonymous ${view || 'default'}`);
    assert.equal(anon.json.events, undefined);
    assert.equal((await get(`/api/missions/${mission}${view}`, 'wrong-token')).status, 401);
  }
});

test('the SQL filter and its JS twin agree on every stored row', () => {
  const kept = new Set((db.prepare(`SELECT id FROM events WHERE mission_id = ? AND ${CHAT_VIEW_SQL}`).all(mission) as { id: number }[]).map((r) => r.id));
  for (const row of dbApi.listEvents(mission)) assert.equal(kept.has(row.id), isChatViewRow(row), `row ${row.id} (${row.payload.slice(0, 50)})`);
  // `_` is a LIKE wildcard: a subtype differing by that one character must survive.
  assert.ok(isChatViewRow({ type: 'system', payload: '{"type":"system","subtype":"thinkingXtokens"}' }));
  const lookalike = ins('system', { type: 'system', subtype: 'thinkingXtokens' });
  assert.ok(dbApi.listChatEvents(mission).some((e) => e.id === lookalike));
});

test('archived rows go through the same filter', async () => {
  attachEventsArchive(join(home, 'archive-events.db'));
  const cold = randomUUID();
  dbApi.createMission(cold, 'view.agent', 'archived mission');
  const ids = [
    dbApi.insertEvent(cold, 'system', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 1 }).id,
    dbApi.insertEvent(cold, 'assistant', { type: 'assistant', message: { content: [] } }).id,
    dbApi.insertEvent(cold, 'tool_progress', { type: 'tool_progress' }).id,
  ];
  db.exec(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload) SELECT id, mission_id, type, timestamp, payload FROM events WHERE id IN (${ids[0]}, ${ids[1]})`);
  db.exec(`DELETE FROM events WHERE id IN (${ids[0]}, ${ids[1]})`);
  const { json } = await get(`/api/missions/${cold}`);
  assert.deepEqual(json.events?.map((e) => e.id), [ids[1]]);
  assert.equal((await get(`/api/missions/${cold}?view=raw`)).json.events?.length, 3);
});

test('both mission routes say where their time went, in Server-Timing', async () => {
  const phases = (res: Response): string[] => (res.headers.get('server-timing') ?? '')
    .split(',').map((entry) => entry.trim().split(';')[0]!).filter(Boolean);
  const detail = await get(`/api/missions/${mission}`);
  assert.deepEqual(phases(detail.res), ['db', 'parse', 'state', 'serialize', 'total']);
  assert.match(detail.res.headers.get('server-timing') ?? '', /^db;dur=\d+\.\d(, \w+;dur=\d+\.\d)+$/);
  assert.match(detail.res.headers.get('content-type') ?? '', /^application\/json/);
  const list = await fetch(`${base}/api/missions`, { headers: { authorization: `Bearer ${TOKEN}` } });
  assert.equal(list.status, 200);
  assert.deepEqual(phases(list), ['db', 'enrich', 'serialize', 'total']);
  assert.ok(((await list.json()) as { missions: unknown[] }).missions.length >= 1);
  assert.equal((await fetch(`${base}/api/missions`)).headers.get('server-timing'), null, 'nothing for an anonymous caller');
});
