import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { db, dbApi } from '../../db.js';
import { agentConfig, agentDir } from '../../paths.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerLayoutProposalRoutes } from '../settings/layout-proposals.js';
import { registerComputerRoutes } from './routes.js';
import { COMPUTER_USE_PROPOSAL_KIND, nextAllowedApps } from './proposals.js';

const alice = createTestAccount(dbApi, { email: 'cu-proposal-alice@example.test', name: 'Alice', passwordHash: 'unused', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'cu-proposal-bob@example.test', name: 'Bob', passwordHash: 'unused', isSuperadmin: false });
const bobCookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(bobCookie), userId: bob.id, expiresAt: Date.now() + 60_000 });
const cookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: alice.id, expiresAt: Date.now() + 60_000 });

function writeAgent(name: string, config: object): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(agentConfig(name), JSON.stringify(config));
}
const missionToken = (agent: string, owner = alice.id): string => {
  const mission = randomUUID();
  dbApi.createMission(mission, agent, 'ask for Discord', undefined, owner);
  return issueMissionApiToken(mission);
};
const UNTOUCHED = { backend: 'claude', computer_use: false, computer_use_apps: ['Notepad'] };
const configOf = (name: string): { backend?: string; computer_use?: boolean; computer_use_apps?: unknown[] } => JSON.parse(readFileSync(agentConfig(name), 'utf8'));

writeAgent('cu-boss', { backend: 'claude' });
writeAgent('cu-target', { backend: 'claude', computer_use: false, computer_use_apps: ['Notepad'] });
const bossToken = missionToken('cu-boss');
// A mission of the TARGET agent: its own token must not be able to apply a proposal either.
const targetToken = missionToken('cu-target');
const bobBossToken = missionToken('cu-boss', bob.id);

const delivered: { missionId: string; text: string }[] = [];
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'cu-proposal-daemon' }));
app.use(express.json());
registerComputerRoutes(app, { call: async () => ({}) });
registerLayoutProposalRoutes(app, { deliver: (missionId, text) => { delivered.push({ missionId, text }); } });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const root = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Who = 'person' | 'bob' | 'bobBoss' | 'boss' | 'target' | 'daemon' | 'anonymous';
async function send(path: string, who: Who, body: object): Promise<{ status: number; json: any }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'person') headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (who === 'bob') headers.cookie = `${SESSION_COOKIE}=${bobCookie}`;
  if (who === 'bobBoss') headers.authorization = `Bearer ${bobBossToken}`;
  if (who === 'boss') headers.authorization = `Bearer ${bossToken}`;
  if (who === 'target') headers.authorization = `Bearer ${targetToken}`;
  if (who === 'daemon') headers.authorization = 'Bearer cu-proposal-daemon';
  const res = await fetch(`${root}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() as any };
}
const propose = (body: object, who: Who = 'boss') => send('/api/computer/proposals', who, body);
const decide = (id: string, who: Who, decision: 'applied' | 'dismissed' = 'applied') => send(`/api/layout/proposals/${id}/resolve`, who, { decision });

test('nextAllowedApps adds without duplicate (case apart) and removes by name', () => {
  assert.deepEqual(nextAllowedApps(['Notepad', 'Slack'], ['notepad', 'Discord'], ['SLACK']), [{ app: 'Notepad', mode: 'foreground' }, { app: 'Discord', mode: 'foreground' }]);
  assert.deepEqual(nextAllowedApps([], [], ['x']), []);
});

test('nextAllowedApps gives a bare name the default mode, keeps an object\'s own, and changes the mode of a listed application', () => {
  assert.deepEqual(nextAllowedApps(['Notes'], ['Mail', { app: 'Discord', mode: 'foreground' }], [], 'background'), [
    { app: 'Notes', mode: 'background' }, { app: 'Mail', mode: 'background' }, { app: 'Discord', mode: 'foreground' },
  ]);
  assert.deepEqual(nextAllowedApps([{ app: 'Notes', mode: 'background' }], [{ app: 'notes', mode: 'foreground' }], []), [{ app: 'Notes', mode: 'foreground' }]);
});

test('a mission token proposes: a pending card, and nothing changes on the agent', async () => {
  const res = await propose({ agent: 'cu-target', addApps: ['Discord'], enable: true, note: 'to answer the community' });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  assert.equal(res.json.status, 'pending');
  const row = dbApi.getLayoutProposal(res.json.id)!;
  assert.equal(row.kind, COMPUTER_USE_PROPOSAL_KIND);
  assert.equal(row.status, 'pending');
  const payload = JSON.parse(row.payload);
  assert.deepEqual(payload.before, { enabled: false, apps: [{ app: 'Notepad', mode: 'foreground' }], defaultMode: 'foreground' });
  assert.deepEqual(payload.addApps, [{ app: 'Discord', mode: 'foreground' }], 'a bare name is settled on the card');
  assert.ok(payload.expiresAt > Date.now());
  assert.deepEqual(configOf('cu-target'), UNTOUCHED);
});

test('a proposal is refused for a person, the daemon token, an anonymous caller; and validated', async () => {
  assert.equal((await propose({ agent: 'cu-target', addApps: ['x'] }, 'person')).status, 403);
  assert.equal((await propose({ agent: 'cu-target', addApps: ['x'] }, 'daemon')).status, 403);
  assert.equal((await propose({ agent: 'cu-target', addApps: ['x'] }, 'anonymous')).status, 401);
  assert.equal((await propose({ agent: 'cu-target' })).json.code, 'computer_proposal_empty');
  assert.equal((await propose({ agent: 'cu-target', addApps: ['x'], extra: 1 })).json.code, 'computer_proposal_invalid');
  assert.equal((await propose({ agent: 'cu-target', addApps: Array.from({ length: 21 }, (_, i) => `a${i}`) })).status, 400);
  assert.equal((await propose({ agent: 'cu-target', addApps: ['x'.repeat(201)] })).status, 400);
  assert.equal((await propose({ agent: 'cu-nobody', addApps: ['x'] })).status, 404);
});

test('applying is refused to an agent token (the proposer and the target), the daemon token and an anonymous caller', async () => {
  const id = (await propose({ agent: 'cu-target', addApps: ['Discord'], enable: true })).json.id as string;
  assert.equal((await decide(id, 'boss')).status, 403);
  assert.equal((await decide(id, 'target')).status, 403);
  assert.equal((await decide(id, 'daemon')).status, 403);
  assert.equal((await decide(id, 'anonymous')).status, 401);
  assert.equal(dbApi.getLayoutProposal(id)?.status, 'pending');
  assert.deepEqual(configOf('cu-target'), UNTOUCHED);
});

test('a person applies it once: config written, the mission told, a second click refused', async () => {
  const before = delivered.length;
  const id = (await propose({ agent: 'cu-target', addApps: ['Discord'], enable: true })).json.id as string;
  const res = await decide(id, 'person');
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(configOf('cu-target'), { backend: 'claude', computer_use: true, computer_use_apps: [{ app: 'Notepad', mode: 'foreground' }, { app: 'Discord', mode: 'foreground' }] });
  assert.equal(delivered.length, before + 1);
  assert.match(delivered.at(-1)!.text, /^\[computer-use proposal\] The user allowed it: cu-target: computer use on, allowed applications: Notepad \(foreground\), Discord \(foreground\)/);
  // A proposal applies once.
  assert.equal((await decide(id, 'person')).status, 409);
  assert.equal(delivered.length, before + 1);
});

test('removing an application, without touching the switch', async () => {
  const id = (await propose({ agent: 'cu-target', removeApps: ['notepad'] })).json.id as string;
  assert.equal((await decide(id, 'person')).status, 200);
  assert.deepEqual(configOf('cu-target'), { backend: 'claude', computer_use: true, computer_use_apps: [{ app: 'Discord', mode: 'foreground' }] });
});

test('refusing changes nothing and tells the mission', async () => {
  const before = delivered.length;
  const id = (await propose({ agent: 'cu-target', addApps: ['Slack'] })).json.id as string;
  assert.equal((await decide(id, 'person', 'dismissed')).status, 200);
  assert.deepEqual(configOf('cu-target').computer_use_apps, [{ app: 'Discord', mode: 'foreground' }]);
  assert.match(delivered.at(-1)!.text, /refused your computer-use proposal/);
  assert.equal(delivered.length, before + 1);
});

test('an expired proposal is not applied, and stays untouched', async () => {
  const id = (await propose({ agent: 'cu-target', addApps: ['Slack'] })).json.id as string;
  const row = dbApi.getLayoutProposal(id)!;
  const payload = { ...JSON.parse(row.payload), expiresAt: Date.now() - 1 };
  db.prepare('UPDATE layout_proposals SET payload = ? WHERE id = ?').run(JSON.stringify(payload), id);
  const res = await decide(id, 'person');
  assert.equal(res.status, 409);
  assert.equal(res.json.problems[0].code, 'expired');
  assert.deepEqual(configOf('cu-target').computer_use_apps, [{ app: 'Discord', mode: 'foreground' }]);
});

test('a person without agents:manage cannot apply, and another account never sees the card', async () => {
  const mine = (await propose({ agent: 'cu-target', addApps: ['Slack'] }, 'bobBoss')).json.id as string;
  const refused = await decide(mine, 'bob');
  assert.equal(refused.status, 409);
  assert.equal(refused.json.problems[0].code, 'forbidden');
  const alices = (await propose({ agent: 'cu-target', addApps: ['Slack'] })).json.id as string;
  assert.equal((await decide(alices, 'bob')).status, 404);
  assert.deepEqual(configOf('cu-target').computer_use_apps, [{ app: 'Discord', mode: 'foreground' }]);
});

test('a proposal carries the mode of each application, shown on the card and applied as asked', async () => {
  writeAgent('cu-modes', { backend: 'claude', computer_use: true, computer_use_apps: [{ app: 'Notes', mode: 'background' }] });
  const res = await propose({ agent: 'cu-modes', addApps: ['Mail', { app: 'Discord', mode: 'foreground' }, { app: 'notes', mode: 'foreground' }] });
  assert.equal(res.status, 202, JSON.stringify(res.json));
  const payload = JSON.parse(dbApi.getLayoutProposal(res.json.id)!.payload);
  assert.deepEqual(payload.before.apps, [{ app: 'Notes', mode: 'background' }], 'the card shows the modes of before');
  assert.deepEqual(payload.addApps, [{ app: 'Mail', mode: 'foreground' }, { app: 'Discord', mode: 'foreground' }, { app: 'notes', mode: 'foreground' }], 'and of after');
  assert.equal((await propose({ agent: 'cu-modes', addApps: [{ app: 'x', mode: 'sideways' }] })).status, 400);
  assert.equal((await decide(res.json.id, 'person')).status, 200);
  assert.deepEqual(configOf('cu-modes').computer_use_apps, [
    { app: 'Notes', mode: 'foreground' }, { app: 'Mail', mode: 'foreground' }, { app: 'Discord', mode: 'foreground' },
  ]);
});

test('"All applications" and its exclusions cannot be proposed: the card is never drawn', async () => {
  const before = configOf('cu-target');
  for (const body of [
    { agent: 'cu-target', allApps: true },
    { agent: 'cu-target', computer_use_all_apps: true, addApps: ['x'] },
    { agent: 'cu-target', excludedApps: [] },
    { agent: 'cu-target', computer_use_excluded_apps: ['Timon'] },
  ]) {
    const res = await propose(body);
    assert.equal(res.status, 403, JSON.stringify(res.json));
    assert.equal(res.json.code, 'computer_proposal_all_apps_refused');
  }
  assert.deepEqual(configOf('cu-target'), before);
});
