/**
 * A mission on a machine with no account yet. It used to receive the
 * daemon-token, the operator's credential: the agent could then approve its
 * own permission cards and even create the install's first account. It now
 * holds a mission token like any other: the install's rights while no account
 * exists, as an agent — never as a person nor as the operator.
 *
 * Before the first account, an anonymous loopback call is refused the same
 * way: the mission could otherwise drop its token and approve anyway.
 *
 * Everything real but the click: the daemon auth middleware, the token issued
 * the way a launch does (`missionApiToken`), the card engine.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-token-first-run-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware, ensureDaemonToken } = await import('./plugins-bundled/http/auth.js');
const { missionApiToken } = await import('./agent.js');
const { hashApiToken } = await import('./users/api-tokens.js');
const { registerRoutes } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { listPending, requestPermission } = await import('./permissions.js');
const { createTestAccount } = await import('../tests/helpers/accounts.js');

assert.equal(dbApi.countUsers(), 0, 'the install has no account');
dbApi.createMission('m-first', 'timon.coder', 'work');
const daemonToken = ensureDaemonToken();
const missionToken = missionApiToken('m-first');

function listen(required: boolean): Promise<{ base: string; close: () => void }> {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: daemonToken, required }));
  app.use(express.json());
  registerRoutes(app);
  registerUserRoutes(app);
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => ({
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => { server.closeAllConnections(); server.close(); },
  }));
}

const loopback = await listen(false);
test.after(() => loopback.close());

type Caller = { bearer: string } | null;
const mission: Caller = { bearer: missionToken };
const operator: Caller = { bearer: daemonToken };
const anonymous: Caller = null;

function call(method: string, path: string, caller: Caller, body?: unknown, base = loopback.base): Promise<Response> {
  return fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(caller ? { authorization: `Bearer ${caller.bearer}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

let seq = 0;
function ask() {
  const toolUseId = `tu-${++seq}`;
  const decision = requestPermission({ mission_id: 'm-first', agent: 'timon.coder', tool_name: 'Bash', input: { command: 'rm -rf build' }, tool_use_id: toolUseId });
  const card = listPending('m-first').find((p) => p.tool_use_id === toolUseId);
  assert.ok(card, 'the card is pending');
  return { decision, card };
}

function stillPending(id: string): boolean {
  return listPending('m-first').some((p) => p.id === id);
}

test.describe('a mission launched before the first account', { concurrency: false }, () => {
  test('holds its own mission token, not the daemon-token', () => {
    assert.notEqual(missionToken, daemonToken);
    const live = dbApi.getLiveApiToken(hashApiToken(missionToken));
    assert.equal(live?.token.mission_id, 'm-first');
    assert.equal(live?.user, null);
  });

  test('still works: it reads its own mission', async () => {
    const res = await call('GET', '/api/missions/m-first?view=status', mission);
    assert.equal(res.status, 200);
  });

  test('cannot allow its own card, and may deny it', async () => {
    const first = ask();
    const refused = await call('POST', `/api/permissions/${first.card.id}/resolve`, mission, { behavior: 'allow' });
    assert.equal(refused.status, 403);
    assert.match((await refused.json() as { reason: string }).reason, /only a person can/);
    assert.equal((await call('POST', `/api/permissions/${first.card.id}/resolve`, mission, { behavior: 'paste' })).status, 403);
    assert.ok(stillPending(first.card.id), 'the card still waits');
    const denied = await call('POST', `/api/permissions/${first.card.id}/resolve`, mission, { behavior: 'deny', message: 'not needed' });
    assert.equal(denied.status, 200);
    assert.equal((await first.decision).behavior, 'deny');
  });

  test('dropping its token does not help: an anonymous loopback call cannot allow, and may deny', async () => {
    // The open loopback of a first run still answers anonymous reads.
    assert.equal((await call('GET', '/api/missions/m-first?view=status', anonymous)).status, 200);
    const { card, decision } = ask();
    const refused = await call('POST', `/api/permissions/${card.id}/resolve`, anonymous, { behavior: 'allow', updatedInput: { command: 'ls' } });
    assert.equal(refused.status, 401);
    assert.match((await refused.json() as { reason: string }).reason, /only a person can/);
    assert.equal((await call('POST', `/api/permissions/${card.id}/resolve`, anonymous, { behavior: 'paste' })).status, 401);
    assert.ok(stillPending(card.id), 'the card still waits');
    assert.equal((await call('POST', `/api/permissions/${card.id}/resolve`, anonymous, { behavior: 'deny' })).status, 200);
    assert.equal((await decision).behavior, 'deny');
  });

  test('the operator (daemon-token) still allows', async () => {
    const { card, decision } = ask();
    assert.equal((await call('POST', `/api/permissions/${card.id}/resolve`, operator, { behavior: 'allow' })).status, 200);
    assert.equal((await decision).behavior, 'allow');
  });

  test('is not the operator: no setup token for it', async () => {
    assert.equal((await call('POST', '/api/auth/setup-token', mission, {})).status, 403);
    assert.equal((await call('POST', '/api/auth/setup-token', operator, {})).status, 200);
  });

  test('an anonymous caller off the loopback is refused', async () => {
    const exposed = await listen(true);
    try {
      assert.equal((await call('GET', '/api/missions/m-first?view=status', anonymous, undefined, exposed.base)).status, 401);
      const { card, decision } = ask();
      assert.equal((await call('POST', `/api/permissions/${card.id}/resolve`, anonymous, { behavior: 'allow' }, exposed.base)).status, 401);
      assert.ok(stillPending(card.id));
      assert.equal((await call('POST', `/api/permissions/${card.id}/resolve`, operator, { behavior: 'deny' })).status, 200);
      await decision;
    } finally {
      exposed.close();
    }
  });

  test('loses the install-wide rights once the first account exists', async () => {
    createTestAccount(dbApi, { email: 'first@example.test', name: 'First', passwordHash: 'x' });
    const res = await call('GET', '/api/missions/m-first?view=status', mission);
    assert.equal(res.status, 404, 'an unattributed mission reads nothing any more');
  });
});
