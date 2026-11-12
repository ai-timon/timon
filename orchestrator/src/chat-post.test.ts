/**
 * A message an agent posts in its own chat through a tool call (`chat-post.ts`):
 * the `message` field of `question` / `kanban_plan`, and `chat_post_message`.
 *
 * What is locked here: the text is bounded and validated; it lands as an
 * ordinary `assistant` event, right BEFORE the card it explains, and never
 * inside that card; a refused or re-posted form never posts it twice; and only
 * the token of the mission itself may post in its chat.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { UserRow } from './db.js';
import type { RequestAuth } from './users/identity.js';
import type { BusEvent } from './bus.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-chat-post-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { requestPermission, listPending, validateAskUserPayload } = await import('./permissions.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { ChatPostRequestSchema, MAX_CHAT_POST_CHARS, formMessageOf, withoutFormMessage } = await import('./chat-post.js');
const { extractSearchFragments } = await import('./mission-search.js');
const { loadMcpCatalog } = await import('./remote-mcp/catalog.js');

const QUESTIONS = { questions: [{ question: 'Which option?', header: 'pick', options: [{ label: 'A' }, { label: 'B' }] }] };
const PLAN = { form: { kind: 'series_plan', chantier: 'Big feature', volets: [{ title: 'Front' }] } };
const REPORT = '## Comparison\n\n| option | cost |\n|---|---|\n| A | low |\n| B | high |';

function mission(owner?: string): string {
  const id = randomUUID();
  dbApi.createMission(id, 'post.agent', 'compare the options', undefined, owner);
  return id;
}

function events(missionId: string): Array<{ id: number; type: string; payload: Record<string, unknown> }> {
  return dbApi.listEvents(missionId).map((e) => ({ id: e.id, type: e.type, payload: JSON.parse(e.payload) as Record<string, unknown> }));
}

function textOf(payload: Record<string, unknown>): string {
  const content = (payload.message as { content?: Array<{ type: string; text?: string }> } | undefined)?.content ?? [];
  return content.filter((b) => b.type === 'text').map((b) => b.text).join('');
}

/* ── The text ──────────────────────────────────────────────────────────── */

test('the posted text is non-blank, bounded at 20000 characters, and nothing else rides along', () => {
  assert.equal(MAX_CHAT_POST_CHARS, 20_000);
  assert.ok(ChatPostRequestSchema.safeParse({ text: REPORT }).success);
  assert.ok(ChatPostRequestSchema.safeParse({ text: 'x'.repeat(MAX_CHAT_POST_CHARS) }).success);
  assert.ok(!ChatPostRequestSchema.safeParse({ text: 'x'.repeat(MAX_CHAT_POST_CHARS + 1) }).success);
  assert.ok(!ChatPostRequestSchema.safeParse({ text: '   \n ' }).success);
  assert.ok(!ChatPostRequestSchema.safeParse({ text: 42 }).success);
  assert.ok(!ChatPostRequestSchema.safeParse({}).success);
  // Who it is for is never a parameter: the mission comes from the token.
  assert.ok(!ChatPostRequestSchema.safeParse({ text: 'hi', mission_id: randomUUID() }).success);
});

test('a form\'s `message`: optional, a blank one is ignored, a wrong one is a named defect', () => {
  assert.equal(validateAskUserPayload({ ...QUESTIONS, message: REPORT }), null);
  assert.equal(validateAskUserPayload({ ...PLAN, message: REPORT }), null);
  assert.equal(validateAskUserPayload({ ...QUESTIONS, message: '  ' }), null, 'a blank message does not cost the question');
  assert.equal(formMessageOf({ ...QUESTIONS, message: '  ' }), null);
  assert.match(validateAskUserPayload({ ...QUESTIONS, message: 7 }) ?? '', /`message` is not a string/);
  assert.match(validateAskUserPayload({ ...QUESTIONS, message: 'x'.repeat(MAX_CHAT_POST_CHARS + 1) }) ?? '', /`message` is longer than 20000/);
  assert.deepEqual(withoutFormMessage({ ...QUESTIONS, message: REPORT }), QUESTIONS);
  assert.deepEqual(withoutFormMessage(QUESTIONS), QUESTIONS);
});

/* ── Before the card ───────────────────────────────────────────────────── */

test('question: the message is an ordinary agent message, written right before the card, and not in it', () => {
  const id = mission();
  const published: Array<{ type: string; id?: number }> = [];
  const listen = (ev: BusEvent) => { if (ev.kind === 'event' && ev.missionId === id) published.push({ type: ev.type, id: ev.id }); };
  bus.on('event', listen);
  try {
    void requestPermission({ mission_id: id, agent: 'post.agent', tool_name: 'ask_user', input: { ...QUESTIONS, message: REPORT }, tool_use_id: 'tu-q' });
  } finally { bus.off('event', listen); }
  const rows = events(id);
  const posted = rows.findIndex((e) => e.type === 'assistant');
  const card = rows.findIndex((e) => e.type === 'permission_request');
  assert.ok(posted >= 0 && card > posted, `message then card: ${rows.map((e) => e.type).join(', ')}`);
  assert.equal(card, posted + 1, 'nothing comes between them');
  const message = rows[posted]!.payload;
  assert.equal(message.type, 'assistant');
  assert.equal(textOf(message), REPORT);
  assert.equal(message.timon_posted, 'question');
  assert.equal(message.parent_tool_use_id, undefined, 'a sub-agent mark would hide it from the chat');
  // The card carries the questions only: the report lives in the thread.
  const input = rows[card]!.payload.input as Record<string, unknown>;
  assert.equal(input.message, undefined);
  assert.deepEqual(input.questions, QUESTIONS.questions);
  assert.equal((listPending(id)[0]?.input as Record<string, unknown>).message, undefined);
  // Live in the same order, with the row id a reply anchors on.
  assert.deepEqual(published.map((p) => p.type), ['assistant', 'permission_request']);
  assert.equal(published[0]!.id, rows[posted]!.id);
  // The search reads it as the agent's words.
  assert.deepEqual(extractSearchFragments('assistant', message), [{ role: 'assistant', text: REPORT }]);
});

test('kanban_plan: the same message, marked as the planner\'s, above the planner', () => {
  const id = mission();
  void requestPermission({ mission_id: id, agent: 'post.agent', tool_name: 'ask_user', input: { ...PLAN, message: REPORT }, tool_use_id: 'tu-plan' });
  const rows = events(id);
  const posted = rows.findIndex((e) => e.type === 'assistant');
  assert.equal(rows[posted + 1]?.type, 'permission_request');
  assert.equal(rows[posted]!.payload.timon_posted, 'kanban_plan');
  const input = rows[posted + 1]!.payload.input as Record<string, unknown>;
  assert.equal(input.message, undefined);
  assert.equal((input.form as Record<string, unknown>).kind, 'series_plan');
});

test('a shim that reconnects with the same call posts nothing twice', () => {
  const id = mission();
  const ask = () => requestPermission({ mission_id: id, agent: 'post.agent', tool_name: 'ask_user', input: { ...QUESTIONS, message: REPORT }, tool_use_id: 'tu-again' });
  void ask();
  void ask();
  const rows = events(id);
  assert.equal(rows.filter((e) => e.type === 'assistant').length, 1);
  assert.equal(rows.filter((e) => e.type === 'permission_request').length, 1);
});

test('a refused form posts nothing: no card, no message', async () => {
  const id = mission();
  const decision = await requestPermission({ mission_id: id, agent: 'post.agent', tool_name: 'ask_user', input: { questions: [], message: REPORT }, tool_use_id: 'tu-bad' });
  assert.equal(decision.behavior, 'deny');
  assert.equal(events(id).filter((e) => e.type === 'assistant').length, 0);
});

test('a form without `message` posts nothing', () => {
  const id = mission();
  void requestPermission({ mission_id: id, agent: 'post.agent', tool_name: 'ask_user', input: QUESTIONS, tool_use_id: 'tu-plain' });
  assert.deepEqual(events(id).map((e) => e.type), ['permission_request']);
});

/* ── POST /api/missions/:id/messages ──────────────────────────────────── */

type Caller = { user: string; mission?: string; kind?: 'api-token' | 'session' | 'daemon-token' | 'anonymous'; superadmin?: boolean };

function authOf(as: Caller): RequestAuth | undefined {
  const user = { id: as.user, is_superadmin: as.superadmin === true } as UserRow;
  if (as.kind === 'anonymous') return undefined;
  if (as.kind === 'session') return { kind: 'session', user, isSuperadmin: as.superadmin === true };
  if (as.kind === 'daemon-token') return { kind: 'daemon-token', user: null, isSuperadmin: true };
  return {
    kind: 'api-token', user: null, isSuperadmin: as.superadmin === true, actorId: as.user, permissions: ['missions:read'],
    ...(as.mission ? { missionId: as.mission } : {}),
  };
}

async function post(missionId: string, as: Caller, body: unknown) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const auth = authOf(as);
    if (auth) req.auth = auth;
    next();
  });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  try {
    const port = (server.address() as AddressInfo).port;
    const r = await fetch(`http://127.0.0.1:${port}/api/missions/${missionId}/messages`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  } finally {
    server.close();
  }
}

test('the mission\'s own token posts an ordinary agent message', async () => {
  const owner = randomUUID();
  const id = mission(owner);
  const r = await post(id, { user: owner, mission: id }, { text: REPORT });
  assert.equal(r.status, 201);
  assert.equal(r.json.posted, true);
  const rows = events(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.id, r.json.event_id);
  assert.equal(rows[0]!.type, 'assistant');
  assert.equal(textOf(rows[0]!.payload), REPORT);
  assert.equal(rows[0]!.payload.timon_posted, 'chat_post_message');
});

test('nobody else puts words in the agent\'s mouth', async () => {
  const owner = randomUUID();
  const id = mission(owner);
  const sibling = mission(owner);
  const refused: Caller[] = [
    { user: owner, kind: 'anonymous' },
    { user: owner, mission: sibling },
    { user: owner },
    { user: owner, superadmin: true },
    { user: owner, mission: sibling, superadmin: true },
    { user: owner, kind: 'session' },
    { user: randomUUID(), kind: 'session', superadmin: true },
    { user: owner, kind: 'daemon-token' },
  ];
  for (const as of refused) {
    const r = await post(id, as, { text: 'not mine' });
    assert.ok(r.status === 401 || r.status === 403 || r.status === 404, `${JSON.stringify(as)} → ${r.status}`);
  }
  assert.equal(events(id).length, 0, 'no refusal leaves a message');
});

test('a malformed or oversized body is a 400 and posts nothing', async () => {
  const owner = randomUUID();
  const id = mission(owner);
  for (const body of [{}, { text: '' }, { text: '  ' }, { text: 3 }, { text: 'x'.repeat(MAX_CHAT_POST_CHARS + 1) }, { text: 'hi', html: '<b>' }]) {
    const r = await post(id, { user: owner, mission: id }, body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
  }
  assert.equal((await post(randomUUID(), { user: owner, mission: id }, { text: 'hi' })).status, 404);
  assert.equal(events(id).length, 0);
});

/* ── The MCP tool ──────────────────────────────────────────────────────── */

test('chat_post_message: listed with a title, refused outside a mission, posts to the mission\'s own thread', async () => {
  const { TOOLS, runTool } = await loadMcpCatalog();
  const tool = TOOLS.find((t) => t.name === 'chat_post_message');
  assert.ok(tool?.title);
  assert.match(tool.description, /may never reach the user/);
  const sent: Array<{ method: string; path: string; body?: unknown }> = [];
  const call = async (method: string, path: string, body?: unknown) => { sent.push({ method, path, body }); return { posted: true, event_id: 9 }; };
  await assert.rejects(runTool('chat_post_message', { text: 'hi' }, { call, env: {}, hostFiles: true }), /only works inside a mission/);
  assert.equal(sent.length, 0);
  const out = await runTool('chat_post_message', { text: REPORT, mission_id: 'elsewhere' }, { call, env: { missionId: 'm-1' }, hostFiles: true });
  assert.deepEqual(out, { posted: true, event_id: 9 });
  assert.deepEqual(sent, [{ method: 'POST', path: '/api/missions/m-1/messages', body: { text: REPORT } }]);
});
