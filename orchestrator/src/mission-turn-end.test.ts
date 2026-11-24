/**
 * End of turn observable from the API: what `timon wait` needs.
 *
 * Defect fixed (17/09/2026, card #101): `cmdWait` looped as long as the
 * status was `running`. With a persistent backend, the process stays alive
 * after the end of the turn until the idle reap (`TIMON_REAP_IDLE_MS`), so
 * `wait` only returned at the reap (ten minutes later) or never.
 * Worse, the pilot blocked in `wait` kept a turn active, and the return of the
 * sub-mission is precisely DEFERRED while a turn is active (`wake.ts`,
 * `MAX_ROUTE_DEFERRALS`): each one waited for the other.
 *
 * The observable chosen is the one that already prevails on the daemon side: a
 * `result` event later than the last user input. It is persisted:
 * it survives a restart of the orchestrator, unlike
 * `turn_active`, which lives in memory.
 *
 * `node --test --import tsx src/mission-turn-end.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-turn-end-test-'));

const { dbApi } = await import('./db.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
// Through a URL: the file is an untyped .mjs of the CLI, not part of the build.
const { handlers } = await import(new URL('../bin/mcp-tools-missions.mjs', import.meta.url).href) as {
  handlers: {
    mission_wait: (
      args: { mission_id: string; timeout_s?: number },
      ctx: { call: (method: string, path: string) => Promise<unknown> },
    ) => Promise<{ timed_out: boolean; text: string }>;
  };
};

type MissionView = {
  id?: string;
  status?: string;
  turn_complete?: boolean;
  events?: unknown[];
  error?: string;
};

async function get(path: string): Promise<{ status: number; body: MissionView }> {
  const app = express();
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`);
    return { status: r.status, body: (await r.json()) as MissionView };
  } finally {
    server.close();
  }
}

function mission(): string {
  const id = randomUUID();
  dbApi.createMission(id, 'timon.coder', 'un brief délégué'); // french-ok: free-text sample data
  return id;
}

test('no turn finished as long as no `result` has come in', () => {
  const id = mission();
  assert.equal(dbApi.missionTurnEnded(id), false);
  dbApi.insertEvent(id, 'assistant', {
    message: { content: [{ type: 'text', text: 'je travaille' }] },
  });
  assert.equal(dbApi.missionTurnEnded(id), false);
});

test('a `result` ends the turn; a user input opens a new one', () => {
  const id = mission();
  dbApi.insertEvent(id, 'result', { subtype: 'success' });
  assert.equal(dbApi.missionTurnEnded(id), true);

  // `timon send`: a new turn, the previous `result` is worth nothing any more.
  dbApi.insertEvent(id, 'user', { message: { content: 'une relance' } });
  assert.equal(dbApi.missionTurnEnded(id), false);

  dbApi.insertEvent(id, 'result', { subtype: 'success' });
  assert.equal(dbApi.missionTurnEnded(id), true);
});

test('light view: the status without the transcript', async () => {
  const id = mission();
  dbApi.insertEvent(id, 'result', { subtype: 'success' });

  const light = await get(`/api/missions/${id}?view=status`);
  assert.equal(light.status, 200);
  assert.equal(light.body.id, id);
  assert.equal(light.body.status, 'running');
  assert.equal(light.body.turn_complete, true);
  // The full transcript is precisely what we do not want to download again
  // every 1.5 s: 2.2 MB per call measured on 17/09/2026.
  assert.equal(light.body.events, undefined);
});

test('default view unchanged: the transcript is always there', async () => {
  const id = mission();
  dbApi.insertEvent(id, 'result', { subtype: 'success' });

  const full = await get(`/api/missions/${id}`);
  assert.equal(full.status, 200);
  assert.ok(Array.isArray(full.body.events));
  assert.equal(full.body.events?.length, 1);
  assert.equal(full.body.turn_complete, true);
});

test('the light view goes through the same access check: unknown mission → 404', async () => {
  const unknown = await get(`/api/missions/${randomUUID()}?view=status`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error, 'mission not found');
});

// --- A turn a steer stopped is not the end of the turn (TODO #662) -----------

/** What `steerMission` leaves in the transcript of the turn it stops. */
function stopTurn(id: string, halfWritten: string): void {
  dbApi.insertEvent(id, 'assistant', { message: { content: [{ type: 'text', text: halfWritten }] } });
  dbApi.insertEvent(id, 'turn_interrupted', { type: 'turn_interrupted', resumable: true, backend: 'x', turn_active: true, reason: 'steered' });
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'cancelled', is_error: false, timon_steered: true });
}

function finishTurn(id: string, instruction: string, answer: string): void {
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: instruction } });
  dbApi.insertEvent(id, 'assistant', { message: { content: [{ type: 'text', text: answer }] } });
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'success', is_error: false });
}

/** The real routes, with a hook on each `?view=status` poll (its 1-based rank),
 *  run BEFORE the route answers: the state a poll reads is exact, no timer. */
async function withApi<T>(onPoll: (rank: number) => void, run: (url: string) => Promise<T>): Promise<T> {
  const app = express();
  let polls = 0;
  app.use((req, _res, next) => {
    if (req.query.view === 'status') onPoll(++polls);
    next();
  });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('a result a steer stopped does not end the turn, whichever side of the instruction it lands on', () => {
  // The usual order: the window between the stopped turn's result and the instruction.
  const id = mission();
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: 'go' } });
  stopTurn(id, 'half of');
  assert.equal(dbApi.missionTurnEnded(id), false);
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: 'other road' } });
  assert.equal(dbApi.missionTurnEnded(id), false);
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'success' });
  assert.equal(dbApi.missionTurnEnded(id), true);

  // A cancel acknowledged after the 5 s wait: the instruction is logged first.
  const late = mission();
  dbApi.insertEvent(late, 'user', { message: { role: 'user', content: 'other road' } });
  dbApi.insertEvent(late, 'result', { type: 'result', subtype: 'cancelled', timon_steered: true });
  assert.equal(dbApi.missionTurnEnded(late), false);
  dbApi.insertEvent(late, 'result', { type: 'result', subtype: 'success' });
  assert.equal(dbApi.missionTurnEnded(late), true);
});

test('a daemon death during a steered turn whose stop landed late still reads as a cut turn', () => {
  const id = mission();
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: 'other road' } });
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'cancelled', timon_steered: true });
  assert.equal(dbApi.missionTurnOpen(id), true, 'the steered turn is running, nothing closed it');
  dbApi.insertEvent(id, 'result', { type: 'result', subtype: 'success' });
  assert.equal(dbApi.missionTurnOpen(id), false);

  // The stop itself says the thread was cut: no second notice for it.
  const cut = mission();
  dbApi.insertEvent(cut, 'user', { message: { role: 'user', content: 'go' } });
  stopTurn(cut, 'half of');
  assert.equal(dbApi.missionTurnOpen(cut), false);
});

test('the detail, the light view and the list agree during the window', async () => {
  const agent = `turn-end.${randomUUID().slice(0, 8)}`;
  const id = randomUUID();
  dbApi.createMission(id, agent, 'a delegated brief');
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: 'go' } });
  stopTurn(id, 'half of');
  const listed = async (): Promise<boolean | undefined> => {
    const { body } = await get(`/api/missions?agent=${agent}`);
    return (body as { missions?: MissionView[] }).missions?.[0]?.turn_complete;
  };
  assert.equal((await get(`/api/missions/${id}?view=status`)).body.turn_complete, false);
  assert.equal((await get(`/api/missions/${id}`)).body.turn_complete, false);
  assert.equal(await listed(), false);

  finishTurn(id, 'other road', 'done the other way');
  assert.equal((await get(`/api/missions/${id}?view=status`)).body.turn_complete, true);
  assert.equal((await get(`/api/missions/${id}`)).body.turn_complete, true);
  assert.equal(await listed(), true);
});

/** A wait already running when the steer stops the turn: its first poll falls in
 *  the window, the steered turn has ended by its second. Anything else than the
 *  steered turn's text means the wait stopped on the stopped turn. */
function steerUnderWait(): { id: string; onPoll: (rank: number) => void } {
  const id = mission();
  dbApi.insertEvent(id, 'user', { message: { role: 'user', content: 'go' } });
  stopTurn(id, 'half of the first pl');
  return { id, onPoll: (rank) => { if (rank === 2) finishTurn(id, 'other road', 'done the other way'); } };
}

test('mission_wait running across a steer returns the steered turn, not the stopped one', async () => {
  const { id, onPoll } = steerUnderWait();
  const out = await withApi(onPoll, (url) => handlers.mission_wait({ mission_id: id, timeout_s: 20 }, {
    call: async (_method, path) => (await fetch(`${url}${path}`)).json() as Promise<unknown>,
  }));
  assert.equal(out.timed_out, false);
  assert.equal(out.text, 'done the other way');
});

test('timon wait running across a steer prints the steered turn, not the stopped one', async () => {
  const { id, onPoll } = steerUnderWait();
  const stdout = await withApi(onPoll, (url) => new Promise<string>((resolve, reject) => {
    const env = { ...process.env, TIMON_API: url, TIMON_RESOURCE_GUARD_ENABLED: '0' };
    delete env.TIMON_API_TOKEN;
    const child = spawn(process.execPath, [TIMON, 'wait', id, '--timeout=20'], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c: Buffer | string) => { out += String(c); });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  }));
  assert.equal(stdout.trim(), 'done the other way');
});
