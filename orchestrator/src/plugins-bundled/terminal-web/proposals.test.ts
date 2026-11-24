/**
 * An agent asks its owner to decide on a command; the card lives in the
 * mission's conversation. The refusals matter most: only a mission's own agent
 * may ask, only the owner's browser may answer, the text must be one plain
 * line, and a sandbox backend is never offered `allow`.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

await import('../../../tests/helpers/paid-license.js');
delete process.env.TIMON_TERMINAL_WEB_ENABLED;

const { registerProposalRoute, isSingleLineCommand } = await import('./proposals.js');
const { PENDING_REPLY, UNATTENDED_REPLY } = await import('./command-requests.js');
const { dbApi } = await import('../../db.js');
const { bus } = await import('../../bus.js');
const { startNotificationResolver } = await import('../../notifications.js');
const { invalidateSettingsCache } = await import('../../settings.js');
import type { PermissionModel } from '../../backends/types.js';

const stopResolver = startNotificationResolver();
const owner = createTestAccount(dbApi, { email: 'owner@example.com', name: 'owner', passwordHash: 'x', isSuperadmin: true });
const stranger = createTestAccount(dbApi, { email: 'other@example.com', name: 'other', passwordHash: 'x', isSuperadmin: false });
const noTerminal = createTestAccount(dbApi, { email: 'noterm@example.com', name: 'noterm', passwordHash: 'x', isSuperadmin: false });
dbApi.createMission('m-owned', 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-claude', 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-codex', 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-late', 'timon.coder', 'work', undefined, owner.id);
dbApi.createMission('m-orphan', 'timon.coder', 'work', undefined, null);
dbApi.createMission('m-noterm', 'timon.coder', 'work', undefined, noTerminal.id);
// Two agents with the same name in two projects: only the origin tells them apart (TIM-0072).
dbApi.createTask('t-onboarding', 'Install the onboarding plugin', 'acme.coder', { project: 'project-onboarding', ownerUserId: owner.id });
dbApi.createMission('m-task', 'acme.coder', 'TASK_ID: t-onboarding\n\nbrief', undefined, owner.id);
dbApi.setMissionLineage('m-task', { taskId: 't-onboarding' });
// Unattended missions whose backend is alive: answered at once, decided later.
dbApi.createTask('t-live', 'Rebuild the app', 'acme.coder', { project: 'project-live', ownerUserId: owner.id });
dbApi.createMission('m-task-live', 'acme.coder', 'TASK_ID: t-live\n\nbrief', undefined, owner.id);
dbApi.setMissionLineage('m-task-live', { taskId: 't-live' });
dbApi.createTask('t-closed', 'Ship the fix', 'acme.coder', { project: 'project-live', ownerUserId: owner.id });
dbApi.createMission('m-task-closed', 'acme.coder', 'TASK_ID: t-closed\n\nbrief', undefined, owner.id);
dbApi.setMissionLineage('m-task-closed', { taskId: 't-closed' });
const SECRET_ID = '3f2a9c1e-7b4d-4e8a-9f60-1c2d3e4f5a6b';
dbApi.createMission(SECRET_ID, 'acme.coder', 'deploy with TOKEN=sk-live-never-shown\nthen restart', undefined, owner.id);

const MODELS: Record<string, PermissionModel> = {
  'm-claude': 'mcp-bridge', 'm-codex': 'sandbox', 'm-late': 'mcp-bridge',
  'm-task-live': 'mcp-bridge', 'm-task-closed': 'protocol',
};
let waitMs = 10_000;
const late: Array<{ missionId: string; text: string }> = [];

type Fake = { kind: 'daemon-token' | 'session' | 'api-token'; userId?: string; missionId?: string | null };
const app = express();
app.use(express.json());
// The real token lookup lives in http/auth.ts; here the caller's identity is the test input.
app.use((req, _res, next) => {
  const raw = req.header('x-test-auth');
  if (raw) {
    const fake = JSON.parse(raw) as Fake;
    const user = fake.userId ? dbApi.getUserById(fake.userId) ?? null : null;
    req.auth = {
      kind: fake.kind, user,
      isSuperadmin: fake.kind === 'daemon-token' || !!user?.is_superadmin,
      missionId: fake.missionId ?? null,
    };
  }
  next();
});
registerProposalRoute(app, {
  waitMs: () => waitMs,
  permissionModel: (id) => MODELS[id] ?? null,
  deliverLate: (missionId, text) => { late.push({ missionId, text }); },
});
const server = createServer(app);
server.listen(0, '127.0.0.1');
await once(server, 'listening');
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test.after(() => { stopResolver(); server.closeAllConnections(); server.close(); });
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/terminal/web/proposals`;

type Seen = { missionId: string; type: string; payload: Record<string, unknown> };
const seen: Seen[] = [];
bus.on('event', (ev: { kind: string; missionId?: string; type?: string; payload?: Record<string, unknown> }) => {
  if (ev.kind === 'event' && ev.type?.startsWith('command_request')) seen.push({ missionId: ev.missionId!, type: ev.type, payload: ev.payload! });
});

function send(method: string, path: string, auth: Fake | null, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { 'x-test-auth': JSON.stringify(auth) } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const propose = (auth: Fake | null, body: unknown): Promise<Response> => send('POST', '', auth, body);
const decide = (id: string, auth: Fake | null, body: unknown): Promise<Response> => send('POST', `/${id}/resolve`, auth, body);
const agentOf = (missionId: string): Fake => ({ kind: 'api-token', userId: owner.id, missionId });
const ownerBrowser: Fake = { kind: 'session', userId: owner.id };

/** Starts a proposal and returns once its card exists, with the agent's call still waiting. */
async function openCard(missionId: string, command: string): Promise<{ id: string; reply: Promise<Response> }> {
  const before = seen.length;
  const reply = propose(agentOf(missionId), { command });
  for (let i = 0; i < 200; i++) {
    const card = seen.slice(before).find((s) => s.type === 'command_request' && s.missionId === missionId);
    if (card) return { id: card.payload.id as string, reply };
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('no card');
}

test.describe('command requests', { concurrency: false }, () => {
  test('anonymous, a browser session and the daemon token cannot ask', async () => {
    assert.equal((await propose(null, { command: 'ls' })).status, 401);
    assert.equal((await propose(ownerBrowser, { command: 'ls' })).status, 403);
    assert.equal((await propose({ kind: 'daemon-token' }, { command: 'ls' })).status, 403);
    assert.equal((await propose({ kind: 'api-token', missionId: null }, { command: 'ls' })).status, 403, 'a token with no mission');
    assert.equal(seen.length, 0);
  });

  test('a newline or a control character is refused, never stripped', async () => {
    for (const command of ['ls\n', 'ls\rrm -rf x', 'echo \u001b[2Khi', 'a\u0008b', '   ', '']) {
      assert.equal((await propose(agentOf('m-owned'), { command })).status, 400, JSON.stringify(command));
    }
    assert.equal((await propose(agentOf('m-owned'), { command: 'ls', extra: 1 })).status, 400, 'unknown field');
    assert.equal((await propose(agentOf('m-owned'), { command: 'x'.repeat(2_001) })).status, 400, 'too long');
    assert.equal(seen.length, 0);
    assert.equal(isSingleLineCommand('git status --short'), true);
    assert.equal(isSingleLineCommand('echo "é ü 漢"'), true); // french-ok: non-ASCII letters in a command
  });

  test('a mission without an owner, or an owner who cannot open a terminal, is refused', async () => {
    assert.equal((await propose(agentOf('m-orphan'), { command: 'ls' })).status, 409);
    assert.equal((await propose(agentOf('m-noterm'), { command: 'ls' })).status, 403);
    assert.equal((await propose(agentOf('gone'), { command: 'ls' })).status, 409);
    assert.equal(seen.length, 0);
  });

  test('an unattended mission is answered at once; its card names project, mission and task', async () => {
    const res = await propose(agentOf('m-task'), { command: 'sudo systemctl restart nginx', note: 'reload the proxy' });
    assert.equal(res.status, 202);
    const body = await res.json() as { id: string; status: string; message: string; choices: string[] };
    assert.equal(body.status, 'pending');
    assert.equal(body.message, UNATTENDED_REPLY);
    assert.deepEqual(body.choices, ['paste', 'deny'], 'no live backend: nothing could act on allow');

    const ev = seen.at(-1)!;
    assert.equal(ev.type, 'command_request');
    assert.equal(ev.missionId, 'm-task');
    assert.equal(ev.payload.id, body.id);
    assert.equal(ev.payload.command, 'sudo systemctl restart nginx');
    assert.equal(ev.payload.note, 'reload the proxy');
    assert.equal(ev.payload.agent, 'acme.coder');
    assert.equal(ev.payload.project, 'project-onboarding');
    assert.equal(ev.payload.missionTitle, 'Install the onboarding plugin');
    assert.equal(ev.payload.taskId, 't-onboarding');
    assert.equal(ev.payload.status, 'pending');
    const stored = dbApi.listEvents('m-task').filter((e) => e.type === 'command_request');
    assert.equal(stored.length, 1, 'persisted: a reloaded page replays the card');

    const notes = dbApi.listActiveNotificationsByMission('m-task', 'action_required');
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.anchor, body.id);
    assert.match(notes[0]!.title, /acme\.coder/);
    assert.match(notes[0]!.body ?? '', /project-onboarding/);
  });

  test('the prompt never reaches the card, even with no mission or task title', async () => {
    waitMs = 0;
    try {
      assert.equal((await propose(agentOf(SECRET_ID), { command: 'ls' })).status, 202);
    } finally {
      waitMs = 10_000;
    }
    const ev = seen.at(-1)!;
    assert.equal(ev.payload.missionTitle, '3f2a9c1e');
    assert.equal(ev.payload.taskId, null);
    const wire = JSON.stringify(ev) + JSON.stringify(dbApi.listActiveNotificationsByMission(SECRET_ID, 'action_required'));
    assert.ok(!wire.includes('never-shown'), 'the secret in the prompt stays out');
    assert.ok(!wire.includes('deploy with'), 'no line of the prompt either');
  });

  test('only the owner’s browser answers: anonymous, daemon token, agent and another user are refused', async () => {
    const [card] = dbApi.listCommandRequests({ ownerUserId: owner.id, missionId: 'm-task', status: 'pending' });
    const id = card!.id;
    assert.equal((await decide(id, null, { decision: 'deny' })).status, 401);
    assert.equal((await decide(id, { kind: 'daemon-token' }, { decision: 'deny' })).status, 403);
    assert.equal((await decide(id, agentOf('m-task'), { decision: 'deny' })).status, 403);
    assert.equal((await decide(id, { kind: 'session', userId: stranger.id }, { decision: 'deny' })).status, 404);
    assert.equal((await decide(id, ownerBrowser, { decision: 'maybe' })).status, 400);
    assert.equal((await decide(id, ownerBrowser, { decision: 'deny', extra: 1 })).status, 400);
    assert.equal((await decide('not-a-uuid', ownerBrowser, { decision: 'deny' })).status, 400);
    assert.equal(dbApi.getCommandRequest(id)!.status, 'pending');
  });

  test('a sandbox backend is never offered allow; paste gives the agent an instructive refusal in its turn', async () => {
    const { id, reply } = await openCard('m-codex', 'sudo apt upgrade');
    assert.deepEqual(seen.at(-1)!.payload.choices, ['paste', 'deny']);
    assert.equal((await decide(id, ownerBrowser, { decision: 'allow' })).status, 400, 'allow is not offered');

    const res = await decide(id, ownerBrowser, { decision: 'paste', origin: 'ui_card_paste' });
    assert.equal(res.status, 200);
    const answered = await res.json() as { request: { status: string; command: string } };
    assert.equal(answered.request.status, 'paste');
    assert.equal(answered.request.command, 'sudo apt upgrade', 'the browser pastes what the daemon holds');

    const agent = await (await reply).json() as { status: string; message: string };
    assert.equal(agent.status, 'paste');
    assert.match(agent.message, /runs `sudo apt upgrade` themselves/);
    assert.match(agent.message, /ask the user/);
    const resolved = seen.at(-1)!;
    assert.equal(resolved.type, 'command_request_resolved');
    assert.deepEqual({ id: resolved.payload.id, status: resolved.payload.status, origin: resolved.payload.origin },
      { id, status: 'paste', origin: 'ui_card_paste' });
    assert.equal((await decide(id, ownerBrowser, { decision: 'deny' })).status, 409, 'decided once');
  });

  test('a backend that asks mid-turn is offered allow; deny comes back as a refusal', async () => {
    const allowed = await openCard('m-claude', 'sudo make install');
    assert.deepEqual(seen.at(-1)!.payload.choices, ['allow', 'paste', 'deny']);
    assert.equal((await decide(allowed.id, ownerBrowser, { decision: 'allow' })).status, 200);
    assert.match(((await (await allowed.reply).json()) as { message: string }).message, /run it yourself now/);

    const denied = await openCard('m-claude', 'sudo rm -rf /opt/x');
    assert.equal((await decide(denied.id, ownerBrowser, { decision: 'deny' })).status, 200);
    const agent = await (await denied.reply).json() as { status: string; message: string };
    assert.equal(agent.status, 'deny');
    assert.match(agent.message, /dismissed/);
  });

  test('no answer in time: the agent is told so, and the late answer goes out as a message', async () => {
    waitMs = 30;
    try {
      const res = await propose(agentOf('m-late'), { command: 'sudo reboot' });
      assert.equal(res.status, 202);
      const body = await res.json() as { id: string; status: string; message: string };
      assert.equal(body.status, 'pending');
      assert.equal(body.message, PENDING_REPLY);
      assert.equal(dbApi.listActiveNotificationsByMission('m-late', 'action_required').length, 1);

      assert.equal((await decide(body.id, ownerBrowser, { decision: 'paste' })).status, 200);
      assert.equal(late.length, 1);
      assert.equal(late[0]!.missionId, 'm-late');
      assert.match(late[0]!.text, /^\[command request\] The user runs `sudo reboot` themselves/);
      assert.equal(dbApi.listActiveNotificationsByMission('m-late', 'action_required').length, 0, 'decided: notification gone');
    } finally {
      waitMs = 10_000;
    }
  });

  test('an unattended mission answered at once still gets each decision, once, while it runs', async () => {
    const ids: Record<string, string> = {};
    for (const decision of ['allow', 'paste', 'deny'] as const) {
      const res = await propose(agentOf('m-task-live'), { command: `sudo ${decision}-it` });
      assert.equal(res.status, 202);
      const body = await res.json() as { id: string; message: string; choices: string[] };
      assert.equal(body.message, UNATTENDED_REPLY);
      assert.deepEqual(body.choices, ['allow', 'paste', 'deny'], 'a live mcp-bridge agent can run it');
      ids[decision] = body.id;
    }
    const before = late.length;
    for (const decision of ['allow', 'paste', 'deny'] as const) {
      assert.equal((await decide(ids[decision]!, ownerBrowser, { decision })).status, 200, decision);
      assert.equal((await decide(ids[decision]!, ownerBrowser, { decision })).status, 409, `${decision}: decided once`);
    }
    const sent = late.slice(before);
    assert.equal(sent.length, 2, 'one message per decision, never two — and none for a dismissal, which must not wake the agent');
    assert.ok(sent.every((m) => m.missionId === 'm-task-live'));
    assert.match(sent[0]!.text, /^\[command request\] The user allowed `sudo allow-it`: run it yourself now/);
    assert.match(sent[1]!.text, /^\[command request\] The user runs `sudo paste-it` themselves/);
  });

  test('allow is neither offered nor accepted once no agent can run it', async () => {
    const card = async (command: string): Promise<string> => {
      const body = await (await propose(agentOf('m-task-closed'), { command })).json() as { id: string; choices: string[] };
      assert.deepEqual(body.choices, ['allow', 'paste', 'deny']);
      return body.id;
    };
    const listed = async (id: string): Promise<string[]> => {
      const list = await (await send('GET', '?mission_id=m-task-closed&status=pending', ownerBrowser)).json() as
        { requests: Array<{ id: string; choices: string[] }> };
      return list.requests.find((r) => r.id === id)!.choices;
    };
    const gone = await card('sudo systemctl restart app');
    const closed = await card('sudo make deploy');
    assert.deepEqual(await listed(gone), ['allow', 'paste', 'deny']);

    // The backend stopped serving the mission: nobody would run an allowed command.
    delete MODELS['m-task-closed'];
    assert.deepEqual(await listed(gone), ['paste', 'deny']);
    assert.equal((await decide(gone, ownerBrowser, { decision: 'allow' })).status, 400);
    assert.equal(dbApi.getCommandRequest(gone)!.status, 'pending');
    MODELS['m-task-closed'] = 'protocol';

    // The task is closed: its idle process is not woken, not even for paste.
    dbApi.setTaskStatusOnly('t-closed', 'DONE', 'done');
    assert.deepEqual(await listed(closed), ['paste', 'deny']);
    assert.equal((await decide(closed, ownerBrowser, { decision: 'allow' })).status, 400);
    const before = late.length;
    assert.equal((await decide(closed, ownerBrowser, { decision: 'paste' })).status, 200);
    assert.equal(late.length, before, 'a closed task is not woken');

    // A mission that ended: same.
    dbApi.setTaskStatusOnly('t-closed', 'IN_PROGRESS');
    dbApi.finishMission('m-task-closed', 'completed', 0);
    assert.deepEqual(await listed(gone), ['paste', 'deny']);
    assert.equal((await decide(gone, ownerBrowser, { decision: 'deny' })).status, 200);
    assert.equal(late.length, before, 'a finished mission is not woken');
  });

  test('paste is refused once the owner lost the terminal; the card stays pending', async () => {
    waitMs = 0;
    try {
      const body = await (await propose(agentOf('m-late'), { command: 'sudo true' })).json() as { id: string };
      process.env.TIMON_TERMINAL_WEB_ENABLED = '0';
      invalidateSettingsCache();
      assert.equal((await decide(body.id, ownerBrowser, { decision: 'paste' })).status, 403);
      assert.equal(dbApi.getCommandRequest(body.id)!.status, 'pending');
    } finally {
      delete process.env.TIMON_TERMINAL_WEB_ENABLED;
      invalidateSettingsCache();
      waitMs = 10_000;
    }
  });

  test("the badge counts the owner's pending requests by project, and nobody else's", async () => {
    const res = await send('GET', '/pending', ownerBrowser);
    assert.equal(res.status, 200);
    const counts = await res.json() as { total: number; projects: Array<{ project: string | null; pending: number }> };
    assert.equal(counts.projects.find((p) => p.project === 'project-onboarding')?.pending, 1);
    assert.equal(counts.total, counts.projects.reduce((s, p) => s + p.pending, 0));
    assert.ok(counts.total >= 2);

    const theirs = await (await send('GET', '/pending', { kind: 'session', userId: stranger.id })).json() as { total: number };
    assert.equal(theirs.total, 0);
    assert.equal((await send('GET', '/pending', null)).status, 401);
    assert.equal((await send('GET', '/pending', { kind: 'daemon-token' })).status, 403);
    assert.equal((await send('GET', '/pending', agentOf('m-task'))).status, 403);

    const list = await (await send('GET', '?mission_id=m-task&status=pending', ownerBrowser)).json() as { requests: Array<{ missionId: string }> };
    assert.equal(list.requests.length, 1);
    assert.equal(list.requests[0]!.missionId, 'm-task');
    assert.equal((await send('GET', '?nope=1', ownerBrowser)).status, 400);
    const none = await (await send('GET', '?mission_id=m-task', { kind: 'session', userId: stranger.id })).json() as { requests: unknown[] };
    assert.equal(none.requests.length, 0);
  });
});
