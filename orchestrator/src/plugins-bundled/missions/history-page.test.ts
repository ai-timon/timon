/**
 * `GET /api/missions/:id?tail=N[&before=<id>]` (mission-history-page.ts): the
 * chat view read from its end, its bounds, the walk back with `before`, the
 * delta after a cached conversation (`after`), the
 * page that grows to keep a `tool_result` with its `tool_use`, the `prelude`
 * that replaces the replay of what came before, the later `resolutions` of an
 * older page's cards, and the access control the unpaged route already had.
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

const home = mkdtempSync(join(tmpdir(), 'timon-mission-history-page-'));
process.env.TIMON_HOME = home;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { db, dbApi, attachEventsArchive } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { ALIGN_MAX_EXTRA, DELTA_MAX, PRELUDE_FOLD_VERSION, clearPreludeFolds } = await import('../../mission-history-page.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type Ev = { id: number; type: string; timestamp: number; payload: Record<string, unknown> };
type Prelude = {
  session_id: string | null;
  backend: string | null;
  model: string | null;
  observed_model: string | null;
  stats: { tok: number; cost: number };
  totals: { in: number; out: number };
  context_windows: Record<string, number>;
  last_context_tokens: number;
  last_human_text: string | null;
  todo_tool_uses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  events: Ev[];
};
type Page = {
  events?: Ev[];
  has_more?: boolean;
  oldest_event_id?: number | null;
  prelude?: Prelude;
  resolutions?: Ev[];
  reset?: boolean;
  newest_event_id?: number | null;
  error?: string;
};

async function get(path: string, auth: { bearer?: string | null; cookie?: string } = {}): Promise<{ status: number; json: Page; res: Response }> {
  const headers: Record<string, string> = {};
  const bearer = auth.bearer === undefined && !auth.cookie ? TOKEN : auth.bearer;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  if (auth.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(auth.cookie)}`;
  const res = await fetch(`${base}${path}`, { headers });
  return { status: res.status, json: (await res.json()) as Page, res };
}

function newMission(): { id: string; ins: (type: string, payload: Record<string, unknown>) => number } {
  const id = randomUUID();
  dbApi.createMission(id, 'history.agent', 'history page witness');
  return { id, ins: (type, payload) => dbApi.insertEvent(id, type, payload).id };
}

const user = (content: unknown) => ({ type: 'user', message: { role: 'user', content } });
const says = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const uses = (id: string, name = 'Bash', input: Record<string, unknown> = {}) =>
  ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const answers = (id: string) => user([{ type: 'tool_result', tool_use_id: id, content: 'ok' }]);

/** No fold anywhere: the next opening reads the whole journal. {@link clearPreludeFolds}
 *  alone is a daemon restart, which keeps the stored ones. */
function forgetFolds(): void {
  clearPreludeFolds();
  db.exec('DELETE FROM mission_prelude_fold');
}

// A plain conversation: 40 user/assistant pairs, noise between them.
const plain = newMission();
const plainIds: number[] = [];
for (let i = 0; i < 40; i++) {
  plainIds.push(plain.ins('user', user(`question ${i}`)));
  plain.ins('system', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: i });
  plainIds.push(plain.ins('assistant', says(`answer ${i}`)));
}

test('tail=N returns the newest N rows of the chat view, oldest first', async () => {
  const { status, json } = await get(`/api/missions/${plain.id}?tail=10`);
  assert.equal(status, 200);
  assert.deepEqual(json.events?.map((e) => e.id), plainIds.slice(-10));
  assert.equal(json.has_more, true);
  assert.equal(json.oldest_event_id, plainIds[plainIds.length - 10]);
  assert.ok(json.prelude, 'a tail page with older rows carries its prelude');
});

test('a tail wider than the journal returns it whole, with nothing more and no prelude', async () => {
  const { json } = await get(`/api/missions/${plain.id}?tail=500`);
  assert.deepEqual(json.events?.map((e) => e.id), plainIds);
  assert.equal(json.has_more, false);
  assert.equal(json.prelude, undefined);
  const empty = newMission();
  const none = await get(`/api/missions/${empty.id}?tail=5`);
  assert.deepEqual(none.json.events, []);
  assert.equal(none.json.has_more, false);
  assert.equal(none.json.oldest_event_id, null);
});

test('before= walks back page by page, each row exactly once, until has_more is false', async () => {
  const seen: number[] = [];
  let page = (await get(`/api/missions/${plain.id}?tail=15`)).json;
  seen.unshift(...(page.events ?? []).map((e) => e.id));
  let hops = 0;
  while (page.has_more) {
    hops += 1;
    assert.ok(hops < 10, 'the walk ends');
    page = (await get(`/api/missions/${plain.id}?tail=15&before=${page.oldest_event_id}`)).json;
    assert.equal(page.prelude, undefined, 'only the tail page has a prelude');
    assert.ok(Array.isArray(page.resolutions));
    seen.unshift(...(page.events ?? []).map((e) => e.id));
  }
  assert.deepEqual(seen, plainIds);
  const unpaged = (await get(`/api/missions/${plain.id}`)).json;
  assert.deepEqual(unpaged.events?.map((e) => e.id), plainIds, 'no paging parameter = the whole journal, as before');
  assert.equal(unpaged.has_more, undefined);
});

test('before= alone pages with the default size', async () => {
  const last = plainIds[plainIds.length - 1]!;
  const { status, json } = await get(`/api/missions/${plain.id}?before=${last}`);
  assert.equal(status, 200);
  assert.deepEqual(json.events?.map((e) => e.id), plainIds.slice(0, -1));
  assert.equal(json.has_more, false);
});

test('out-of-bounds or malformed paging is refused, and only the chat view pages', async () => {
  for (const query of ['tail=0', 'tail=-3', 'tail=abc', 'tail=2001', 'tail=1.5', 'before=0', 'before=x', 'tail=1&tail=2']) {
    assert.equal((await get(`/api/missions/${plain.id}?${query}`)).status, 400, query);
  }
  assert.equal((await get(`/api/missions/${plain.id}?view=raw&tail=5`)).status, 400);
  assert.equal((await get(`/api/missions/${plain.id}?view=status&before=5`)).status, 400);
  assert.equal((await get(`/api/missions/${plain.id}?view=chat&tail=5`)).status, 200);
});

test('a page grows into the past rather than cut a tool_result from its tool_use', async () => {
  const m = newMission();
  m.ins('user', user('go'));
  const useA = m.ins('assistant', uses('A'));
  const useB = m.ins('assistant', uses('B'));
  m.ins('user', answers('A'));
  m.ins('user', answers('B'));
  const last = m.ins('assistant', says('done'));
  // The 3 newest rows answer A and B: the page must reach back to A.
  const { json } = await get(`/api/missions/${m.id}?tail=3`);
  assert.equal(json.oldest_event_id, useA);
  assert.deepEqual(json.events?.map((e) => e.id), [useA, useB, useB + 1, useB + 2, last]);
  assert.equal(json.has_more, true);
  const older = await get(`/api/missions/${m.id}?tail=3&before=${useA}`);
  assert.deepEqual(older.json.events?.map((e) => e.payload.type), ['user']);
  assert.equal(older.json.has_more, false);
});

test('the growth stops at its bound', async () => {
  const m = newMission();
  const useFar = m.ins('assistant', uses('far'));
  for (let i = 0; i < ALIGN_MAX_EXTRA + 20; i++) m.ins('assistant', says(`filler ${i}`));
  m.ins('user', answers('far'));
  const { json } = await get(`/api/missions/${m.id}?tail=1`);
  assert.equal(json.events?.length, 1 + ALIGN_MAX_EXTRA);
  assert.ok((json.oldest_event_id ?? 0) > useFar);
  assert.equal(json.has_more, true);
});

// A long mission whose state lives before the cut.
const rich = newMission();
dbApi.setMissionLlmOverrides(rich.id, 'claude', 'opus');
rich.ins('system', { type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-opus-4' });
rich.ins('user', user('first words'));
rich.ins('assistant', uses('todo-1', 'TaskCreate', { subject: 'stale' }));
rich.ins('assistant', uses('todo-2', 'TodoWrite', { todos: [{ content: 'plan', status: 'in_progress' }] }));
rich.ins('assistant', uses('todo-3', 'TaskCreate', { subject: 'extra' }));
rich.ins('assistant', { ...uses('todo-sub', 'TaskCreate', { subject: 'sub-agent' }), parent_tool_use_id: 'x' });
rich.ins('user', answers('todo-1'));
rich.ins('model_switch', { model: 'sonnet', previous_model: 'opus', status: 'applied' });
rich.ins('assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 5 } } });
rich.ins('result', { type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 100, output_tokens: 20 }, modelUsage: { 'claude-sonnet-4-5-20250929': { contextWindow: 200000, canonicalModel: 'claude-sonnet-4-5' } } });
rich.ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed', resetsAt: 1 } });
rich.ins('rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed_warning', resetsAt: 2 } });
const openPerm = rich.ins('permission_request', { id: 'perm-open', tool_name: 'Bash' });
const adapted = rich.ins('permission_timeout_adapted', { id: 'perm-open', expires_at: 99 });
rich.ins('permission_request', { id: 'perm-done', tool_name: 'Edit' });
rich.ins('permission_resolved', { id: 'perm-done', behavior: 'allow' });
const openCmd = rich.ins('command_request', { id: 'cmd-open', command: 'ls', status: 'pending' });
rich.ins('ui_document', { id: 'doc-shown', status: 'shown' });
rich.ins('user', user([{ type: 'text', text: 'last typed words' }]));
rich.ins('user', { ...user('a task return'), origin: { kind: 'task_return' } });
rich.ins('result', { type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 7, output_tokens: 3 }, context_tokens: 4321 });
const lateCard = rich.ins('layout_proposal', { id: 'layout-late', status: 'pending' });
const cut = rich.ins('assistant', says('the tail starts here'));
rich.ins('layout_proposal_resolved', { id: 'layout-late', status: 'applied' });
rich.ins('command_request_resolved', { id: 'cmd-open', status: 'allow' });
rich.ins('assistant', says('and ends here'));

test('the prelude holds what the rows before the cut would have left behind', async () => {
  const { json } = await get(`/api/missions/${rich.id}?tail=4`);
  assert.equal(json.oldest_event_id, cut);
  const p = json.prelude!;
  assert.equal(p.session_id, 'sess-1');
  assert.equal(p.backend, 'claude', 'the override, untouched by any backend switch');
  assert.equal(p.model, 'sonnet', 'the switch before the cut wins over the override');
  assert.equal(p.observed_model, 'sonnet', 'an applied switch moves the observed model past the init');
  assert.deepEqual(p.stats, { tok: 130, cost: 0.75 });
  assert.deepEqual(p.totals, { in: 107, out: 23 });
  assert.deepEqual(p.context_windows, { 'claude-sonnet-4-5-20250929': 200000, 'claude-sonnet-4-5': 200000 });
  assert.equal(p.last_context_tokens, 4321, 'the result after the last assistant usage wins');
  assert.equal(p.last_human_text, 'last typed words', 'a task return is not the human speaking');
  assert.deepEqual(p.todo_tool_uses.map((u) => u.id), ['todo-2', 'todo-3'], 'from the last TodoWrite, sub-agents left out');
});

test('the prelude replays the last rate limit of each window and the cards still waiting', async () => {
  const p = (await get(`/api/missions/${rich.id}?tail=4`)).json.prelude!;
  const kinds = p.events.map((e) => `${e.type}:${String(e.payload.id ?? (e.payload.rate_limit_info as { status?: string } | undefined)?.status)}`);
  assert.deepEqual(kinds, [
    'rate_limit_event:allowed_warning',
    'permission_request:perm-open',
    'permission_timeout_adapted:perm-open',
  ], 'no settled card, no shown-only document; a command settled after the cut is not waiting');
  assert.deepEqual(p.events.map((e) => e.id).slice(1), [openPerm, adapted]);
  assert.ok(!p.events.some((e) => e.id === openCmd));
});

test('an older page carries the later resolutions of its cards', async () => {
  const older = (await get(`/api/missions/${rich.id}?tail=3&before=${cut}`)).json;
  assert.ok(older.events?.some((e) => e.id === lateCard));
  const resolved = (older.resolutions ?? []).map((e) => `${e.type}:${String(e.payload.id)}`);
  assert.deepEqual(resolved, ['layout_proposal_resolved:layout-late']);
  const oldest = (await get(`/api/missions/${rich.id}?tail=200&before=${cut}`)).json;
  assert.ok(!oldest.events?.some((e) => e.type === 'rate_limit_event' || e.payload.subtype === 'init'), 'an older page leaves the state rows to the prelude');
  assert.ok(oldest.events?.some((e) => e.type === 'model_switch'), 'the switch notices stay in the thread');
  assert.deepEqual(
    (oldest.resolutions ?? []).map((e) => `${e.type}:${String(e.payload.id)}`),
    ['layout_proposal_resolved:layout-late', 'command_request_resolved:cmd-open'],
  );
});

// A mission that keeps growing between two openings of its chat.
const grow = newMission();
grow.ins('user', user('hello'));
// Sub-agent prompts: user rows that are neither typed words nor tool results,
// more of them than one read of the newest candidates.
for (let i = 0; i < 25; i++) grow.ins('user', { ...user(`sub-agent ${i}`), parent_tool_use_id: 'agent-1' });
const growFirstTodo = grow.ins('assistant', uses('grow-1', 'TaskCreate', { subject: 'one' }));
grow.ins('result', { type: 'result', total_cost_usd: 0.125, usage: { input_tokens: 1, output_tokens: 2 } });
for (let i = 0; i < 6; i++) grow.ins('assistant', says(`first stretch ${i}`));

test('the prelude finds the typed words behind more than one read of other user rows', async () => {
  forgetFolds();
  const p = (await get(`/api/missions/${grow.id}?tail=3`)).json.prelude!;
  assert.equal(p.last_human_text, 'hello');
  assert.deepEqual(p.todo_tool_uses.map((u) => u.id), ['grow-1']);
});

test('a later opening folds only the rows after the last cut, and agrees with a full read', async () => {
  forgetFolds();
  await get(`/api/missions/${grow.id}?tail=3`);
  // Probe: a row before the folded cut is changed behind the cache's back.
  // Nothing in the daemon rewrites a stored event; a read that still sees the
  // change is a read that swept the journal again.
  db.prepare('UPDATE events SET payload = replace(payload, ?, ?) WHERE id = ?').run('"subject":"one"', '"subject":"probe"', growFirstTodo);
  grow.ins('assistant', uses('grow-2', 'TaskUpdate', { id: 'grow-1', status: 'completed' }));
  grow.ins('user', user('again'));
  grow.ins('result', { type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 }, modelUsage: { m: { contextWindow: 1000 } } });
  for (let i = 0; i < 6; i++) grow.ins('assistant', says(`second stretch ${i}`));

  const folded = (await get(`/api/missions/${grow.id}?tail=3`)).json.prelude!;
  assert.deepEqual(folded.todo_tool_uses.map((u) => [u.id, u.input.subject ?? u.input.status]), [['grow-1', 'one'], ['grow-2', 'completed']], 'the old row was not read again');
  assert.equal(folded.last_human_text, 'again');
  assert.deepEqual(folded.stats, { tok: 33, cost: 0.375 });
  assert.deepEqual(folded.totals, { in: 11, out: 22 });
  assert.deepEqual(folded.context_windows, { m: 1000 });

  forgetFolds();
  const full = (await get(`/api/missions/${grow.id}?tail=3`)).json.prelude!;
  assert.equal(full.todo_tool_uses[0]!.input.subject, 'probe', 'a cold read sees the whole journal');
  assert.deepEqual({ ...full, todo_tool_uses: full.todo_tool_uses.map((u) => u.id) }, { ...folded, todo_tool_uses: folded.todo_tool_uses.map((u) => u.id) });
});

test('a cut behind the folded one is read whole, and the fold ahead stays', async () => {
  forgetFolds();
  const ahead = (await get(`/api/missions/${grow.id}?tail=3`)).json.prelude!;
  const behind = (await get(`/api/missions/${grow.id}?tail=12`)).json;
  assert.deepEqual(behind.prelude!.todo_tool_uses.map((u) => u.id), ['grow-1'], 'nothing past the earlier cut');
  assert.equal(behind.prelude!.last_human_text, 'hello');
  assert.deepEqual(behind.prelude!.stats, { tok: 3, cost: 0.125 });
  assert.deepEqual((await get(`/api/missions/${grow.id}?tail=3`)).json.prelude, ahead);
});

/** A journal to fold, whose first row can be changed behind the fold's back. */
function restartMission(): { id: string; ins: (type: string, payload: Record<string, unknown>) => number; firstTodo: number } {
  const m = newMission();
  m.ins('user', user('before the restart'));
  const firstTodo = m.ins('assistant', uses('r-1', 'TaskCreate', { subject: 'one' }));
  m.ins('result', { type: 'result', total_cost_usd: 0.5, usage: { input_tokens: 1, output_tokens: 2 }, modelUsage: { m: { contextWindow: 1000, canonicalModel: 'model-m' } } });
  for (let i = 0; i < 6; i++) m.ins('assistant', says(`first stretch ${i}`));
  return { ...m, firstTodo };
}
const probe = db.prepare('UPDATE events SET payload = replace(payload, ?, ?) WHERE id = ?');
const storedFold = db.prepare('SELECT version, up_to, state FROM mission_prelude_fold WHERE mission_id = ?');
type StoredFold = { version: number; up_to: number; state: string };

test('after a restart the first opening reads only the rows after the stored fold, and agrees with a full read', async () => {
  const m = restartMission();
  const before = (await get(`/api/missions/${m.id}?tail=3`)).json;
  const first = storedFold.get(m.id) as StoredFold;
  assert.equal(first.version, PRELUDE_FOLD_VERSION);
  assert.equal(first.up_to, before.oldest_event_id);

  // Probe: nothing in the daemon rewrites a stored event; a read that still
  // sees the change is a read that swept the journal again.
  probe.run('"subject":"one"', '"subject":"probe"', m.firstTodo);
  m.ins('assistant', uses('r-2', 'TaskUpdate', { id: 'r-1', status: 'completed' }));
  m.ins('user', user('after the restart'));
  m.ins('result', { type: 'result', total_cost_usd: 0.25, usage: { input_tokens: 10, output_tokens: 20 } });
  for (let i = 0; i < 6; i++) m.ins('assistant', says(`second stretch ${i}`));

  clearPreludeFolds();
  const reopened = (await get(`/api/missions/${m.id}?tail=3`)).json;
  const p = reopened.prelude!;
  assert.deepEqual(p.todo_tool_uses.map((u) => [u.id, u.input.subject ?? u.input.status]), [['r-1', 'one'], ['r-2', 'completed']], 'the old row was not read again');
  assert.equal(p.last_human_text, 'after the restart');
  assert.deepEqual(p.stats, { tok: 33, cost: 0.75 });
  assert.deepEqual(p.totals, { in: 11, out: 22 });
  assert.deepEqual(p.context_windows, { m: 1000, 'model-m': 1000 });
  assert.equal((storedFold.get(m.id) as StoredFold).up_to, reopened.oldest_event_id, 'the stored fold moved with the cut');

  forgetFolds();
  const full = (await get(`/api/missions/${m.id}?tail=3`)).json.prelude!;
  assert.equal(full.todo_tool_uses[0]!.input.subject, 'probe', 'a read with no fold sees the whole journal');
  const ids = (prelude: Prelude) => ({ ...prelude, todo_tool_uses: prelude.todo_tool_uses.map((u) => u.id) });
  assert.deepEqual(ids(p), ids(full));
});

test('after a restart a cut behind the stored fold is read whole, and the fold ahead stays', async () => {
  const m = restartMission();
  const later = m.ins('assistant', uses('r-2', 'TaskUpdate', { id: 'r-1', status: 'completed' }));
  for (let i = 0; i < 2; i++) m.ins('assistant', says(`more ${i}`));
  await get(`/api/missions/${m.id}?tail=2`);
  const ahead = storedFold.get(m.id) as StoredFold;
  assert.ok(ahead.up_to > later);

  clearPreludeFolds();
  const behind = (await get(`/api/missions/${m.id}?tail=8`)).json.prelude!;
  assert.deepEqual(behind.todo_tool_uses.map((u) => u.id), ['r-1'], 'nothing past the earlier cut');
  assert.deepEqual(storedFold.get(m.id), ahead);
});

test('a stored fold of another version, or unreadable, is rebuilt from the journal', async () => {
  const m = restartMission();
  await get(`/api/missions/${m.id}?tail=3`);
  probe.run('"subject":"one"', '"subject":"probe"', m.firstTodo);
  const good = storedFold.get(m.id) as StoredFold;
  const spoil = db.prepare('UPDATE mission_prelude_fold SET version = ?, state = ? WHERE mission_id = ?');
  const spoiled: Array<[string, number, string]> = [
    ['another version', PRELUDE_FOLD_VERSION + 1, good.state],
    ['not JSON', PRELUDE_FOLD_VERSION, '{"todo":'],
    ['not an object', PRELUDE_FOLD_VERSION, '[1]'],
    ['the wrong shape', PRELUDE_FOLD_VERSION, JSON.stringify({ ...JSON.parse(good.state) as object, todo: 'nope' })],
  ];
  for (const [label, version, state] of spoiled) {
    spoil.run(version, state, m.id);
    clearPreludeFolds();
    const { status, json } = await get(`/api/missions/${m.id}?tail=3`);
    assert.equal(status, 200, label);
    assert.equal(json.prelude!.todo_tool_uses[0]!.input.subject, 'probe', `${label}: read from the journal`);
    assert.equal(json.prelude!.last_human_text, 'before the restart', label);
    const rebuilt = storedFold.get(m.id) as StoredFold;
    assert.equal(rebuilt.version, PRELUDE_FOLD_VERSION, `${label}: stored again`);
    assert.ok(JSON.parse(rebuilt.state), label);
  }
});

test('a fold that cannot be stored does not fail the opening, and the next one saves it', async () => {
  const m = restartMission();
  const reference = (await get(`/api/missions/${m.id}?tail=3`)).json.prelude!;
  forgetFolds();
  db.exec(`CREATE TRIGGER refuse_prelude_fold BEFORE INSERT ON mission_prelude_fold BEGIN SELECT RAISE(ABORT, 'disk is full'); END`);
  try {
    const { status, json } = await get(`/api/missions/${m.id}?tail=3`);
    assert.equal(status, 200);
    assert.deepEqual(json.prelude, reference);
    assert.equal(storedFold.get(m.id), undefined);
  } finally {
    db.exec('DROP TRIGGER refuse_prelude_fold');
  }
  clearPreludeFolds();
  await get(`/api/missions/${m.id}?tail=3`);
  assert.ok(storedFold.get(m.id));
});

test('a stored fold survives its rows moving to the archive', async () => {
  attachEventsArchive(join(home, 'archive-events.db'));
  const m = restartMission();
  const reference = (await get(`/api/missions/${m.id}?tail=3`)).json;
  const cut = reference.oldest_event_id!;
  db.prepare(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload) SELECT id, mission_id, type, timestamp, payload FROM events WHERE mission_id = ? AND id < ?`).run(m.id, cut);
  db.prepare('DELETE FROM events WHERE mission_id = ? AND id < ?').run(m.id, cut);
  clearPreludeFolds();
  assert.deepEqual((await get(`/api/missions/${m.id}?tail=3`)).json.prelude, reference.prelude);
});

test('both history phases show in Server-Timing', async () => {
  const { res } = await get(`/api/missions/${rich.id}?tail=4`);
  const phases = (res.headers.get('server-timing') ?? '').split(',').map((entry) => entry.trim().split(';')[0]);
  assert.deepEqual(phases, ['db', 'history', 'parse', 'state', 'serialize', 'total']);
});

test('archived rows page like hot ones', async () => {
  attachEventsArchive(join(home, 'archive-events.db'));
  const cold = newMission();
  const ids = [cold.ins('user', user('old')), cold.ins('assistant', says('old answer')), cold.ins('user', user('new'))];
  db.exec(`INSERT INTO archive.events (id, mission_id, type, timestamp, payload) SELECT id, mission_id, type, timestamp, payload FROM events WHERE id IN (${ids[0]}, ${ids[1]})`);
  db.exec(`DELETE FROM events WHERE id IN (${ids[0]}, ${ids[1]})`);
  const tail = (await get(`/api/missions/${cold.id}?tail=2`)).json;
  assert.deepEqual(tail.events?.map((e) => e.id), ids.slice(1));
  assert.equal(tail.has_more, true);
  const older = (await get(`/api/missions/${cold.id}?tail=2&before=${ids[1]}`)).json;
  assert.deepEqual(older.events?.map((e) => e.id), [ids[0]]);
});

test('after= returns the chat-view rows newer than the cursor, oldest first', async () => {
  const m = newMission();
  const held = m.ins('user', user('first'));
  m.ins('assistant', says('first answer'));
  const { status, json } = await get(`/api/missions/${m.id}?after=${held}`);
  assert.equal(status, 200);
  const later = [
    m.ins('user', user('second')),
    m.ins('assistant', says('second answer')),
  ];
  m.ins('system', { type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 });
  m.ins('tool_progress', { type: 'tool_progress', elapsed_time_seconds: 1 });
  const done = m.ins('result', { type: 'result', subtype: 'success', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(json.events?.length, 1, 'only the row after the cursor at the time');
  const delta = (await get(`/api/missions/${m.id}?after=${json.newest_event_id}`)).json;
  assert.deepEqual(delta.events?.map((e) => e.id), [...later, done], 'the noise stays out');
  assert.equal(delta.reset, false);
  assert.equal(delta.newest_event_id, done);
  assert.equal(delta.prelude, undefined);
  assert.equal(delta.has_more, undefined);
  const none = (await get(`/api/missions/${m.id}?after=${done}`)).json;
  assert.deepEqual(none.events, []);
  assert.equal(none.reset, false);
  assert.equal(none.newest_event_id, null, 'nothing new: the client keeps its cursor');
});

test('after= keeps the last init only, in its place', async () => {
  const m = newMission();
  const held = m.ins('user', user('go'));
  m.ins('system', { type: 'system', subtype: 'init', session_id: 's1' });
  const switched = m.ins('backend_switch', { backend: 'codex', model: 'gpt-5.5' });
  const lastInit = m.ins('system', { type: 'system', subtype: 'init', session_id: 's2' });
  const { json } = await get(`/api/missions/${m.id}?after=${held}`);
  assert.deepEqual(json.events?.map((e) => e.id), [switched, lastInit]);
});

test('after= answers reset rather than a delta too long to patch a cache with', async () => {
  const m = newMission();
  const held = m.ins('user', user('go'));
  for (let i = 0; i <= DELTA_MAX; i++) m.ins('assistant', says(`step ${i}`));
  const { status, json } = await get(`/api/missions/${m.id}?after=${held}`);
  assert.equal(status, 200);
  assert.equal(json.reset, true);
  assert.deepEqual(json.events, []);
  assert.equal(json.newest_event_id, null);
});

test('after= is refused malformed, mixed with paging, or outside the chat view', async () => {
  for (const query of ['after=0', 'after=-1', 'after=x', 'after=1.5', 'after=1&after=2', 'after=1&tail=5', 'after=1&before=9']) {
    assert.equal((await get(`/api/missions/${plain.id}?${query}`)).status, 400, query);
  }
  assert.equal((await get(`/api/missions/${plain.id}?view=raw&after=1`)).status, 400);
  assert.equal((await get(`/api/missions/${plain.id}?view=status&after=1`)).status, 400);
  assert.equal((await get(`/api/missions/${plain.id}?view=chat&after=1`)).status, 200);
});

test('paging reads no mission the caller cannot see, and nothing for an anonymous caller', async () => {
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', name: 'Admin', password: 'admin-secret' }),
  });
  assert.equal(setup.status, 201);
  const created = postTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', password: 'bea-secret' });
  assert.equal(created.status, 201);
  const adminId = ((await setup.json()) as { user: { id: string } }).user.id;
  const secret = randomUUID();
  dbApi.createMission(secret, 'admin.agent', 'admin only', undefined, adminId);
  dbApi.insertEvent(secret, 'assistant', says('secret words'));
  // Older rows too, so a tail of 1 has a prelude and an opening would store a fold.
  dbApi.insertEvent(secret, 'assistant', uses('secret-1', 'TaskCreate', { subject: 'secret todo' }));
  dbApi.insertEvent(secret, 'assistant', says('newest secret words'));
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bea@example.com', password: 'bea-secret' }),
  });
  const match = login.headers.getSetCookie()
    .map((line) => new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line)?.[1])
    .find(Boolean);
  const cookie = match ? decodeURIComponent(match) : '';
  assert.ok(cookie, 'bea has a session');
  for (const query of ['?tail=5', `?tail=5&before=${Number.MAX_SAFE_INTEGER}`, '?after=1']) {
    const hidden = await get(`/api/missions/${secret}${query}`, { cookie });
    assert.equal(hidden.status, 404, `employee ${query}`);
    assert.ok(!JSON.stringify(hidden.json).includes('secret words'));
    const anon = await get(`/api/missions/${secret}${query}`, { bearer: null });
    assert.equal(anon.status, 401, `anonymous ${query}`);
    assert.equal(anon.json.events, undefined);
    assert.equal((await get(`/api/missions/${secret}${query}`, { bearer: 'wrong-token' })).status, 401);
  }
  // A prelude read now writes: a refused opening must leave nothing behind, and
  // must never be served what an allowed one stored.
  const foldRow = db.prepare('SELECT 1 FROM mission_prelude_fold WHERE mission_id = ?');
  const refusals = [{ auth: { cookie }, status: 404 }, { auth: { bearer: null }, status: 401 }, { auth: { bearer: 'wrong-token' }, status: 401 }];
  for (const { auth, status } of refusals) {
    assert.equal((await get(`/api/missions/${secret}?tail=1`, auth)).status, status);
    assert.equal(foldRow.get(secret), undefined, 'a refused opening stores no fold');
  }
  const allowed = (await get(`/api/missions/${secret}?tail=1`)).json;
  assert.equal(allowed.prelude?.todo_tool_uses[0]?.input.subject, 'secret todo');
  assert.ok(foldRow.get(secret), 'an allowed opening does');
  clearPreludeFolds();
  for (const { auth, status } of refusals) {
    const refused = await get(`/api/missions/${secret}?tail=1`, auth);
    assert.equal(refused.status, status, 'still refused with a fold stored');
    assert.ok(!JSON.stringify(refused.json).includes('secret todo'));
  }
  assert.equal((await get(`/api/missions/${secret}?tail=5`)).status, 200, 'the daemon token still reads it');
  assert.equal((await get(`/api/missions/${secret}?after=1`)).json.events?.length, 3, 'and its delta');
});
