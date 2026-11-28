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
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Where the daemon runs an allowed command: a folder the missions own, so the checks pass.
const WORK = realpathSync(mkdtempSync(join(tmpdir(), 'timon-allow-')));
for (const id of ['m-task', 'm-claude', 'm-codex', 'm-late', 'm-task-live', 'm-task-closed', 'm-task-leaked']) {
  if (dbApi.getMission(id)) dbApi.setMissionCwdOverride(id, WORK);
}
dbApi.upsertProject('project-onboarding', { cwd: WORK });
dbApi.upsertProject('project-live', { cwd: WORK });
type Ran = { command: string; cwd: string; env: Record<string, string> };
const ran: Ran[] = [];
let runResult = { exitCode: 3 as number | null, timedOut: false, output: 'boom: it failed\n', truncated: false, durationMs: 1200, failedToStart: false };
const fakeRun = async (o: { command: string; cwd: string; env: Record<string, string> }): Promise<typeof runResult> => {
  ran.push({ command: o.command, cwd: o.cwd, env: o.env });
  await new Promise((r) => setTimeout(r, 20));
  return runResult;
};

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
  run: { run: fakeRun, env: () => ({ PATH: '/bin' }), timeoutMs: () => 5_000 },
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
    assert.deepEqual(body.choices, ['allow', 'paste', 'deny'], 'the daemon runs it: no backend is needed');

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

  test('a sandbox backend is offered allow too; paste gives the agent an instructive refusal in its turn', async () => {
    const { id, reply } = await openCard('m-codex', 'sudo apt upgrade');
    assert.deepEqual(seen.at(-1)!.payload.choices, ['allow', 'paste', 'deny']);

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

  test('allow runs the command in the daemon and the answer to the agent carries its output and code', async () => {
    ran.length = 0;
    const allowed = await openCard('m-claude', 'sudo make install');
    assert.deepEqual(seen.at(-1)!.payload.choices, ['allow', 'paste', 'deny']);
    const click = await decide(allowed.id, ownerBrowser, { decision: 'allow', origin: 'ui_card_allow' });
    assert.equal(click.status, 200);
    const agent = await (await allowed.reply).json() as { status: string; message: string };
    assert.equal(agent.status, 'allow');
    assert.match(agent.message, /exited with code 3 after 1\.2 s/);
    assert.match(agent.message, /boom: it failed/);
    assert.doesNotMatch(agent.message, /run it yourself/);
    assert.equal(ran.length, 1);
    assert.equal(ran[0]!.command, 'sudo make install');
    assert.equal(ran[0]!.cwd, WORK);

    const events = seen.filter((e) => e.type === 'command_request_resolved' && e.payload.id === allowed.id);
    assert.equal(events.length, 2, 'one when the click is taken, one when the run ended');
    assert.equal(events[0]!.payload.running, true);
    assert.equal(events[1]!.payload.running, false);
    assert.deepEqual((events[1]!.payload.run as { exitCode: number; output: string }).exitCode, 3);
    const row = dbApi.getCommandRequest(allowed.id)!;
    assert.equal(row.run_exit_code, 3);
    assert.match(row.run_output ?? '', /boom/);
    assert.equal(row.run_cwd, WORK);
    assert.ok(row.run_finished_at);

    const denied = await openCard('m-claude', 'sudo rm -rf /opt/x');
    assert.equal((await decide(denied.id, ownerBrowser, { decision: 'deny' })).status, 200);
    const refusal = await (await denied.reply).json() as { status: string; message: string };
    assert.equal(refusal.status, 'deny');
    assert.match(refusal.message, /dismissed/);
    assert.equal(ran.length, 1, 'a dismissal runs nothing');
  });

  test('a double click on allow runs the command once', async () => {
    ran.length = 0;
    const { id, reply } = await openCard('m-claude', 'npm run lint');
    const [a, b] = await Promise.all([
      decide(id, ownerBrowser, { decision: 'allow' }),
      decide(id, ownerBrowser, { decision: 'allow' }),
    ]);
    assert.deepEqual([a.status, b.status].sort(), [200, 409]);
    await reply;
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(ran.length, 1);
  });

  test('a command that could not start comes back as such, never as a success', async () => {
    const saved = runResult;
    runResult = { exitCode: null, timedOut: false, output: 'not run: the folder to run in is outside this project', truncated: false, durationMs: 0, failedToStart: true };
    try {
      const { id, reply } = await openCard('m-claude', 'git push');
      assert.equal((await decide(id, ownerBrowser, { decision: 'allow' })).status, 200);
      const agent = await (await reply).json() as { message: string };
      assert.match(agent.message, /could not run it \(the folder to run in is outside this project\)/);
      assert.equal(dbApi.getCommandRequest(id)!.run_exit_code, null);
    } finally {
      runResult = saved;
    }
  });

  test('a secret the command printed is masked before it is stored and sent', async () => {
    const saved = runResult;
    runResult = { ...saved, exitCode: 0, output: 'token=ghp_a_vault_value_123456\n' };
    const { setRedactionSource, invalidateRedactionCache } = await import('../../secrets/redact.js');
    const previous = setRedactionSource(() => ['ghp_a_vault_value_123456']);
    invalidateRedactionCache();
    try {
      const { id, reply } = await openCard('m-claude', 'env');
      assert.equal((await decide(id, ownerBrowser, { decision: 'allow' })).status, 200);
      const agent = await (await reply).json() as { message: string };
      assert.ok(!agent.message.includes('ghp_a_vault_value_123456'));
      assert.match(agent.message, /token=\*\*\*/);
      assert.ok(!(dbApi.getCommandRequest(id)!.run_output ?? '').includes('ghp_a_vault_value_123456'));
    } finally {
      setRedactionSource(previous);
      invalidateRedactionCache();
      runResult = saved;
    }
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
      assert.deepEqual(body.choices, ['allow', 'paste', 'deny']);
      ids[decision] = body.id;
    }
    const before = late.length;
    for (const decision of ['allow', 'paste', 'deny'] as const) {
      assert.equal((await decide(ids[decision]!, ownerBrowser, { decision })).status, 200, decision);
      assert.equal((await decide(ids[decision]!, ownerBrowser, { decision })).status, 409, `${decision}: decided once`);
    }
    await new Promise((r) => setTimeout(r, 100));
    const sent = late.slice(before);
    assert.equal(sent.length, 2, 'one message per decision, never two — and none for a dismissal, which must not wake the agent');
    assert.ok(sent.every((m) => m.missionId === 'm-task-live'));
    const text = (re: RegExp): string | undefined => sent.find((m) => re.test(m.text))?.text;
    assert.match(text(/allow-it/) ?? '', /^\[command request\] The user allowed `sudo allow-it`; Timon ran it for you .*exited with code 3/s);
    assert.match(text(/paste-it/) ?? '', /^\[command request\] The user runs `sudo paste-it` themselves/);
  });

  test('allow still runs the command when no agent listens any more, and says nothing to a closed task', async () => {
    ran.length = 0;
    const before = late.length;
    const body = await (await propose(agentOf('m-task-closed'), { command: 'sudo make deploy' })).json() as { id: string; choices: string[] };
    assert.deepEqual(body.choices, ['allow', 'paste', 'deny']);
    // The task is closed and its mission over: its idle process is not woken.
    dbApi.setTaskStatusOnly('t-closed', 'DONE', 'done');
    dbApi.finishMission('m-task-closed', 'completed', 0);
    const list = await (await send('GET', '?mission_id=m-task-closed&status=pending', ownerBrowser)).json() as
      { requests: Array<{ id: string; choices: string[] }> };
    assert.deepEqual(list.requests.find((r) => r.id === body.id)!.choices, ['allow', 'paste', 'deny']);
    assert.equal((await decide(body.id, ownerBrowser, { decision: 'allow' })).status, 200);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(ran.length, 1, 'the daemon ran it');
    assert.equal(dbApi.getCommandRequest(body.id)!.run_exit_code, 3, 'and the card keeps the result');
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
