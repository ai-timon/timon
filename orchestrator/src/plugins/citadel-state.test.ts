/**
 * Citadel's host half (plugins/citadel/src/state.ts, index.ts): what the /state
 * route keeps of each facade row, and that one failing source never breaks the others.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { apply, buildState } from '../../../plugins/citadel/src/index.js';
import { filterMissions, normalizeQuestions, normalizeAgent, normalizeLook, clip } from '../../../plugins/citadel/src/state.js';

const NOW = 1_800_000_000_000;

/** First element of a list the test knows is not empty. */
function first<T>(list: readonly T[]): T {
  const v = list[0];
  assert.ok(v !== undefined, 'expected a first element');
  return v;
}

test('filterMissions keeps running, waiting and recent ended only', () => {
  const r = filterMissions([
    { id: 'a', agent_name: 'x', status: 'running', started_at: 1, ended_at: null },
    { id: 'b', agent_name: 'x', status: 'waiting', started_at: 1 },
    { id: 'c', agent_name: 'x', status: 'done', started_at: 1, ended_at: NOW - 60_000 },
    { id: 'd', agent_name: 'x', status: 'done', started_at: 1, ended_at: NOW - 31 * 60_000 },
    { id: 'e', status: 'running' }, {}, null,
  ], NOW);
  assert.deepEqual(r.map(m => m.id), ['a', 'b', 'c']);
  assert.equal(r[0]?.turn_active, true);
  assert.equal(r[2]?.turn_active, false);
});

test('mission output has only the contract fields', () => {
  const m = first(filterMissions([{ id: 'a', agent_name: 'x', status: 'running', started_at: 1, mission: 'secret prompt', total_cost_usd: 3, cwd: '/p' }], NOW));
  assert.deepEqual(Object.keys(m).sort(), ['agent_name', 'ended_at', 'id', 'started_at', 'status', 'title', 'turn_active']);
});

test('title never falls back to the prompt', () => {
  const [a, b] = filterMissions([
    { id: 'a', agent_name: 'x', status: 'running', mission: 'secret prompt' },
    { id: 'b', agent_name: 'x', status: 'running', mission: 'secret prompt', title: 'Title' }], NOW);
  assert.equal(a?.title, '');
  assert.equal(b?.title, 'Title');
});

test('turn_active uses last_user_id/last_result_id when present', () => {
  const [a, b] = filterMissions([
    { id: 'a', agent_name: 'x', status: 'running', last_user_id: 5, last_result_id: 9 },
    { id: 'b', agent_name: 'x', status: 'running', last_user_id: 9, last_result_id: 5 }], NOW);
  assert.equal(a?.turn_active, false);
  assert.equal(b?.turn_active, true);
});

test('normalizeQuestions picks text, clips to 160', () => {
  const r = normalizeQuestions([
    { id: 'q1', missionId: 'm1', agent: 'a', questions: [{ question: 'x'.repeat(300) }] },
    { id: 'q2', missionId: 'm2', agent: 'b', questions: [], plan: { title: 'Plan' } },
    { id: 'q3', agent: 'c', questions: [{ question: 'a\n  b' }] },
    { agent: 'z' },
  ]);
  assert.equal(r.length, 3);
  assert.equal(r[0]?.text.length, 160);
  assert.equal(r[1]?.text, 'Plan');
  assert.equal(r[2]?.text, 'a b');
  assert.equal(r[2]?.mission_id, null);
  assert.deepEqual(Object.keys(first(r)), ['id', 'agent_name', 'mission_id', 'text']);
});

test('normalizeAgent drops extra fields', () => {
  const a = normalizeAgent({ name: 'n', role: 'coder', project: 'p', extra: 'x', system_prompt: 's', reports_to: 'lead' });
  assert.ok(a);
  assert.deepEqual(Object.keys(a), ['name', 'role', 'project', 'reports_to', 'orchestrator', 'icon_url', 'main', 'look']);
  assert.equal(a.reports_to, 'lead');
});

test('clip', () => { assert.equal(clip(5), ''); assert.equal(clip('abc', 10), 'abc'); });

test('buildState isolates failing sources', async () => {
  const source = {
    agents: { list: async () => [{ name: 'a' }] },
    projects: { list: () => { throw new Error('boom'); } },
    missions: { list: async () => [{ id: 'm', agent_name: 'a', status: 'running' }] },
    questions: { list: async () => { throw new Error('nope'); } },
  };
  // The test double carries only the four facades the snapshot reads.
  const s = await buildState(source as unknown as Parameters<typeof buildState>[0], NOW);
  assert.equal(s.agents.length, 1);
  assert.deepEqual(s.projects, []);
  assert.deepEqual(s.questions, []);
  assert.equal(s.missions.length, 1);
  assert.equal(s.errors.length, 2);
});

test('normalizeLook keeps valid values only', () => {
  assert.deepEqual(normalizeLook({ shape: 'gem', color: '#33231D', eyes: 'heart', acc: 'crown', x: 1 }), { shape: 'gem', color: '#33231d', eyes: 'heart', acc: 'crown' });
  assert.deepEqual(normalizeLook({ shape: 'tri', color: '#7ed957', eyes: 'zzz', acc: '../x' }), { shape: 'tri', color: '#7ed957', eyes: 'pill', acc: 'none' });
  assert.equal(normalizeLook({ shape: 'cube', color: '#7ed957' }), null);
  assert.equal(normalizeLook({ shape: 'tri', color: 'red' }), null);
  assert.equal(normalizeLook(null), null);
  assert.deepEqual(normalizeAgent({ name: 'a', look: { shape: 'hex', color: '#000000' } })?.look, { shape: 'hex', color: '#000000', eyes: 'pill', acc: 'none' });
  assert.equal(normalizeAgent({ name: 'a' })?.look, null);
});

type Handler = (req: { params: Record<string, string> }, res: FakeRes) => Promise<void>;
interface FakeRes { code: number; body: unknown; status(n: number): FakeRes; json(b: unknown): FakeRes; set(h: unknown): FakeRes; send(b: unknown): FakeRes }

/** The two routes of the plugin, mounted on a fake context whose caller is signed in or not. */
function mount(signedIn: boolean): Map<string, Handler> {
  const routes = new Map<string, Handler>();
  const router = { get: (path: string, handler: Handler) => { routes.set(path, handler); return router; } };
  const ctx = {
    router: () => router, user: () => (signedIn ? { id: 'u1' } : null),
    agents: { list: async () => [] }, projects: { list: async () => [] }, missions: { list: async () => [] }, questions: { list: async () => [] },
  };
  // The test double carries only what the routes read.
  apply(ctx as unknown as Parameters<typeof apply>[0]);
  return routes;
}
async function call(routes: Map<string, Handler>, path: string, name = ''): Promise<FakeRes> {
  const res: FakeRes = { code: 200, body: undefined, status(n) { this.code = n; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, send(b) { this.body = b; return this; } };
  const handler = routes.get(path);
  assert.ok(handler, `route ${path} is mounted`);
  await handler({ params: { name } }, res);
  return res;
}

test('an anonymous request is refused on both routes', async () => {
  const routes = mount(false);
  assert.equal((await call(routes, '/state')).code, 401);
  assert.equal((await call(routes, '/assets/:name', 'office.glb')).code, 401);
});

test('a signed-in caller gets the snapshot, and only the two allow-listed assets', async () => {
  const routes = mount(true);
  const state = await call(routes, '/state');
  assert.equal(state.code, 200);
  assert.deepEqual(Object.keys(state.body as object).sort(), ['agents', 'errors', 'generated_at', 'missions', 'projects', 'questions']);
  assert.equal((await call(routes, '/assets/:name', '../package.json')).code, 404);
  assert.equal((await call(routes, '/assets/:name', 'mascot3d.json')).code, 200);
});
