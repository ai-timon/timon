/**
 * An agent's token cannot widen `computer_use_apps` through the agent config PATCH:
 * it may keep or narrow the list, never add to it, whatever its account holds.
 * Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-computer-apps-widening-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { agentConfig } = await import('../../paths.js');
const { hashApiToken, issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown }> {
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
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);

async function account(email: string, permissions: string[]): Promise<{ id: string; cookie: string }> {
  const created = await postTestAccount(dbApi, { email, name: email, password: 'pass-secret' });
  assert.equal(created.status, 201);
  const id = (created.json as { user: { id: string } }).user.id;
  grantTestPermissions(dbApi, id, permissions);
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'pass-secret' }),
  });
  const cookie = sessionCookie(res);
  assert.ok(cookie);
  return { id, cookie };
}

const manager = await account('manager@example.com', ['agents:manage', 'agents:read', 'missions:read']);

function missionToken(agent: string, ownerId: string): string {
  const missionId = randomUUID();
  dbApi.createMission(missionId, agent, 'work', undefined, ownerId);
  const raw = issueMissionApiToken(missionId);
  assert.ok(dbApi.getLiveApiToken(hashApiToken(raw)));
  return raw;
}

const cwd = mkdtempSync(join(tmpdir(), 'timon-computer-apps-cwd-'));
dbApi.upsertProject('apps-widening', { cwd });
// Coders, so that only the explicit reports_to tree decides who orchestrates whom.
for (const name of ['apps.lead', 'apps.helper', 'apps.stranger']) {
  const r = await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'witness', config: { cwd, role: 'coder' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}
const stored = (name: string): Record<string, unknown> => JSON.parse(readFileSync(agentConfig(name), 'utf8')) as Record<string, unknown>;



// A person (the operator's daemon token) lists the applications; the agent's own token then tries to change them.
const seeded = await call('PATCH', '/api/agents/apps.lead/config', { bearer: TOKEN, body: { computer_use_apps: ['Notepad'] } });
assert.equal(seeded.status, 200, JSON.stringify(seeded.json));
const leadToken = missionToken('apps.lead', manager.id);

test("an agent's token cannot add an application to computer_use_apps", async () => {
  const r = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: ['Notepad', 'Calculator'] } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(JSON.stringify(r.json), /adds Calculator/);
  assert.deepEqual(stored('apps.lead').computer_use_apps, ['Notepad']);
});

test("an agent's token cannot widen the list of an agent that has none", async () => {
  const r = await call('PATCH', '/api/agents/apps.helper/config', { bearer: leadToken, body: { computer_use_apps: ['Notepad'] } });
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(JSON.stringify(r.json), /adds Notepad/);
  assert.equal(stored('apps.helper').computer_use_apps, undefined);
});

test("an agent's token may narrow the list", async () => {
  const r = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: [] } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(stored('apps.lead').computer_use_apps ?? [], []);
});

test("an agent's token cannot change computer_use_mode, a person can", async () => {
  const refused = await call('PATCH', '/api/agents/apps.helper/config', { bearer: leadToken, body: { computer_use_mode: 'background' } });
  assert.equal(refused.status, 403, JSON.stringify(refused.json));
  assert.equal(stored('apps.helper').computer_use_mode, undefined);
  const invalid = await call('PATCH', '/api/agents/apps.helper/config', { bearer: TOKEN, body: { computer_use_mode: 'sideways' } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.json));
  const set = await call('PATCH', '/api/agents/apps.helper/config', { bearer: TOKEN, body: { computer_use_mode: 'background' } });
  assert.equal(set.status, 200, JSON.stringify(set.json));
  assert.equal(stored('apps.helper').computer_use_mode, 'background');
});

test("an agent's token cannot move an application from background to foreground, nor add one in either mode; it can move it to background", async () => {
  const seed = await call('PATCH', '/api/agents/apps.lead/config', { bearer: TOKEN, body: { computer_use_apps: [{ app: 'Notes', mode: 'background' }, { app: 'Discord', mode: 'foreground' }] } });
  assert.equal(seed.status, 200, JSON.stringify(seed.json));
  const widen = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: [{ app: 'notes', mode: 'foreground' }, { app: 'Discord', mode: 'foreground' }] } });
  assert.equal(widen.status, 403, JSON.stringify(widen.json));
  assert.match(JSON.stringify(widen.json), /background to foreground/);
  const add = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: [{ app: 'Notes', mode: 'background' }, { app: 'Mail', mode: 'background' }] } });
  assert.equal(add.status, 403, JSON.stringify(add.json));
  const narrow = await call('PATCH', '/api/agents/apps.lead/config', { bearer: leadToken, body: { computer_use_apps: [{ app: 'Notes', mode: 'background' }, { app: 'Discord', mode: 'background' }] } });
  assert.equal(narrow.status, 200, JSON.stringify(narrow.json));
  assert.deepEqual(stored('apps.lead').computer_use_apps, [{ app: 'Notes', mode: 'background' }, { app: 'Discord', mode: 'background' }]);
  const bad = await call('PATCH', '/api/agents/apps.lead/config', { bearer: TOKEN, body: { computer_use_apps: [{ app: 'Notes', mode: 'sideways' }] } });
  assert.equal(bad.status, 400);
});

test('"All applications" is turned on by a person only: an agent\'s token and the daemon\'s are refused', async () => {
  const agentToken = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: leadToken, body: { computer_use_all_apps: true } });
  assert.equal(agentToken.status, 403, JSON.stringify(agentToken.json));
  assert.match(JSON.stringify(agentToken.json), /only a person turns it on/);
  const daemonToken = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: TOKEN, body: { computer_use_all_apps: true } });
  assert.equal(daemonToken.status, 403, JSON.stringify(daemonToken.json));
  const created = await call('POST', '/api/agents', { bearer: TOKEN, body: { name: 'apps.everything', system_prompt: 'witness', config: { cwd, role: 'coder', computer_use_all_apps: true } } });
  assert.equal(created.status, 403, JSON.stringify(created.json));
  assert.equal(stored('apps.stranger').computer_use_all_apps, undefined);
  const ephemeral = await call('POST', '/api/agents/ephemeral', { bearer: TOKEN, body: { mission: 'm', system_prompt: 'p', config: { computer_use_all_apps: true } } });
  assert.equal(ephemeral.status, 403, JSON.stringify(ephemeral.json));
  const invalid = await call('PATCH', '/api/agents/apps.stranger/config', { cookie: manager.cookie, body: { computer_use_all_apps: 'yes' } });
  assert.equal(invalid.status, 400, JSON.stringify(invalid.json));

  const person = await call('PATCH', '/api/agents/apps.stranger/config', { cookie: manager.cookie, body: { computer_use_all_apps: true } });
  assert.equal(person.status, 200, JSON.stringify(person.json));
  assert.equal(stored('apps.stranger').computer_use_all_apps, true);
  const view = person.json as { computer_use_all_apps: boolean; computer_use_excluded_apps: string[] };
  assert.equal(view.computer_use_all_apps, true);
  assert.ok(view.computer_use_excluded_apps.includes('KeePassXC'), 'the defaults are served while nobody edited the list');
  assert.ok(view.computer_use_excluded_apps.includes('Timon'));

  const unchanged = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: leadToken, body: { computer_use_all_apps: true } });
  assert.equal(unchanged.status, 200, 'sending it unchanged passes');
  const journal = dbApi.listComputerJournal('apps.stranger', 10).map((row) => row.command);
  assert.deepEqual(journal, ['all_apps_on'], 'the journal notes the activation once');

  const off = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: leadToken, body: { computer_use_all_apps: false } });
  assert.equal(off.status, 200, 'an agent\'s token may turn it off');
  assert.equal(stored('apps.stranger').computer_use_all_apps, false);
  assert.deepEqual(dbApi.listComputerJournal('apps.stranger', 10).map((row) => row.command), ['all_apps_off', 'all_apps_on']);
});

test('the exclusions: a token may add one, never take one out; a person edits them freely', async () => {
  const lifted = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: leadToken, body: { computer_use_excluded_apps: ['Timon'] } });
  assert.equal(lifted.status, 403, JSON.stringify(lifted.json));
  assert.match(JSON.stringify(lifted.json), /lifts KeePassXC/);
  const daemon = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: TOKEN, body: { computer_use_excluded_apps: [] } });
  assert.equal(daemon.status, 403, JSON.stringify(daemon.json));

  const person = await call('PATCH', '/api/agents/apps.stranger/config', { cookie: manager.cookie, body: { computer_use_excluded_apps: ['KeePassXC', 'Terminal'] } });
  assert.equal(person.status, 200, JSON.stringify(person.json));
  assert.deepEqual(stored('apps.stranger').computer_use_excluded_apps, ['KeePassXC', 'Terminal']);
  const narrowed = await call('PATCH', '/api/agents/apps.stranger/config', { bearer: leadToken, body: { computer_use_excluded_apps: ['keepassxc', 'Terminal', 'Slack'] } });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json));
  const bad = await call('PATCH', '/api/agents/apps.stranger/config', { cookie: manager.cookie, body: { computer_use_excluded_apps: ['ok', ''] } });
  assert.equal(bad.status, 400, JSON.stringify(bad.json));
});
