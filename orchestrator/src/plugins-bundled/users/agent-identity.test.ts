/**
 * M.5 — a non-superadmin spawn injects a token that cannot read another
 * user's resources. This is the test that proves the daemon-token hole
 * is closed, not just that the code compiles.
 *
 * Same resource, several paths: GET by id, list, events/recent (M.1f
 * lesson). Plugin-job identity must not pick up `:all`. CLI daemon-token
 * stays operator superadmin.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once, EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-identity-'));
await import('../../../tests/helpers/paid-license.js');
await import('../../../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./routes.js');
const { registerRoutes: registerMissions } = await import('../missions/routes.js');
const { registerRoutes: registerKanban } = await import('../kanban/routes.js');
const { registerRoutes: registerHttp } = await import('../http/routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { getHost } = await import('../../host/index.js');
const { spawnAgent, upsertAgent } = await import('../../agent.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissions(app);
registerKanban(app);
registerHttp(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
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
  return { status: res.status, json, res };
}

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    child.killed = true;
    child.emit('exit', 0, signal ?? null);
    child.emit('close', 0, signal ?? null);
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

upsertAgent({
  name: 'env-temoin',
  system_prompt: 'témoin M.5 — ne fait rien.', // french-ok: free-text sample data
  config: {
    backend: 'claude',
    cwd: tmpdir(),
    skills: [],
    mcp_servers: [],
    memory_scope: 'NONE',
  },
});

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
assert.ok(employeePreset);
grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'ada-secret' },
});
const adaCookie = sessionCookie(adaLogin.res)!;
assert.ok(adaCookie);

const adminMission = randomUUID();
dbApi.createMission(adminMission, 'admin.agent', 'admin only', undefined, adminId);
dbApi.insertEvent(adminMission, 'assistant', { text: 'admin transcript' });
const adminTask = randomUUID();
dbApi.createTask(adminTask, 'admin only', 'admin.agent', { ownerUserId: adminId });

async function spawnWithFake(
  fn: () => Promise<string>,
): Promise<{ missionId: string; env: NodeJS.ProcessEnv; dispose: () => void }> {
  const host = getHost();
  const original = host.spawn;
  const calls: { env: NodeJS.ProcessEnv }[] = [];
  const children: FakeChild[] = [];
  host.spawn = ((cmd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
    const child = fakeChild();
    children.push(child);
    calls.push({ env: (opts?.env ?? {}) as NodeJS.ProcessEnv });
    return child;
  }) as typeof host.spawn;
  try {
    const missionId = await fn();
    assert.equal(calls.length, 1, 'one spawn, via the host');
    return {
      missionId,
      env: calls[0]!.env,
      dispose: () => {
        for (const child of children) {
          if (!child.killed) child.kill();
        }
      },
    };
  } finally {
    host.spawn = original;
  }
}

test('HTTP spawn as Ada injects a token that 404s on the superadmin\'s resources', async () => {
  const { missionId, env, dispose } = await spawnWithFake(async () => {
    const res = await call('POST', '/api/missions', {
      cookie: adaCookie,
      body: { agent: 'env-temoin', mission: 'ping' },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    return (res.json as { mission_id: string }).mission_id;
  });

  try {
    const injected = env.TIMON_API_TOKEN;
    assert.ok(injected);
    assert.notEqual(injected, TOKEN, 'must not be the daemon-token');
    assert.equal(dbApi.getMission(missionId)?.owner_user_id, adaId);

    const hiddenMission = await call('GET', `/api/missions/${adminMission}`, { bearer: injected });
    assert.equal(hiddenMission.status, 404);

    const ownMission = await call('GET', `/api/missions/${missionId}`, { bearer: injected });
    assert.equal(ownMission.status, 200);

    const list = await call('GET', '/api/missions', { bearer: injected });
    assert.equal(list.status, 200);
    const ids = ((list.json as { missions: Array<{ id: string }> }).missions).map((m) => m.id);
    assert.ok(ids.includes(missionId));
    assert.ok(!ids.includes(adminMission));

    const hiddenTask = await call('GET', `/api/tasks/${adminTask}`, { bearer: injected });
    assert.equal(hiddenTask.status, 404);

    const recent = await call('GET', '/api/events/recent', { bearer: injected });
    assert.equal(recent.status, 200);
    const events = (recent.json as { events: Array<{ mission_id: string }> }).events;
    assert.ok(events.every((e) => e.mission_id !== adminMission));

    const asCli = await call('GET', `/api/missions/${adminMission}`, { bearer: TOKEN });
    assert.equal(asCli.status, 200, 'CLI daemon-token stays operator superadmin');
  } finally {
    dispose();
  }
});

test('plugin-job spawn is system identity: no :all, cannot read Ada\'s mission', async () => {
  const adaMission = randomUUID();
  dbApi.createMission(adaMission, 'ada.agent', 'ada work', undefined, adaId);

  const { missionId, env, dispose } = await spawnWithFake(() =>
    spawnAgent('env-temoin', 'cron ping', { channel: 'plugin:acme' }),
  );

  try {
    assert.equal(dbApi.getMission(missionId)?.owner_user_id, 'plugin:acme');
    const injected = env.TIMON_API_TOKEN;
    assert.ok(injected);
    assert.notEqual(injected, TOKEN);

    const hidden = await call('GET', `/api/missions/${adaMission}`, { bearer: injected });
    assert.equal(hidden.status, 404);
    const hiddenAdmin = await call('GET', `/api/missions/${adminMission}`, { bearer: injected });
    assert.equal(hiddenAdmin.status, 404);

    const own = await call('GET', `/api/missions/${missionId}`, { bearer: injected });
    assert.equal(own.status, 200);

    const list = await call('GET', '/api/missions', { bearer: injected });
    assert.equal(list.status, 200);
    const ids = ((list.json as { missions: Array<{ id: string }> }).missions).map((m) => m.id);
    assert.ok(ids.includes(missionId));
    assert.ok(!ids.includes(adaMission));
    assert.ok(!ids.includes(adminMission));
  } finally {
    dispose();
  }
});

test('unowned system spawn after setup is not the daemon-token and has no :all', async () => {
  const { missionId, env, dispose } = await spawnWithFake(() => spawnAgent('env-temoin', 'system ping'));
  try {
    assert.equal(dbApi.getMission(missionId)?.owner_user_id, null);
    const injected = env.TIMON_API_TOKEN;
    assert.ok(injected);
    assert.notEqual(injected, TOKEN);

    const hidden = await call('GET', `/api/missions/${adminMission}`, { bearer: injected });
    assert.equal(hidden.status, 404);
  } finally {
    dispose();
  }
});
