/**
 * `timon init` creates the first account through `POST /api/auth/setup` with
 * the daemon token, which asks no mailed code: the address is kept
 * unconfirmed, as with `timon user create-admin`, and the relay is never
 * called. Witness daemon on 127.0.0.1:0, relay pointed at a dead port.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-setup-operator-email-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { bus } = await import('../../bus.js');
type BusEvent = import('../../bus.js').BusEvent;

const TOKEN = 'witness-daemon-token';
const daemon = express();
daemon.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
daemon.use(express.json());
registerRoutes(daemon, { setupPolicy: 'free', emailVerification: true, mailRelay: { baseUrl: 'http://127.0.0.1:9' } });
const server = daemon.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

test('the operator\'s setup keeps the address unconfirmed', async () => {
  const heard: BusEvent[] = [];
  const listen = (ev: BusEvent): void => { if (ev.kind === 'onboarding_step') heard.push(ev); };
  bus.on('event', listen);
  const res = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ email: 'owner@example.com', name: 'Owner', password: 'operator-password' }),
  });
  assert.equal(res.status, 201);
  const user = dbApi.getUserByEmail('owner@example.com');
  assert.ok(user);
  assert.equal(dbApi.userEmailUnverified(user.id), true);
  bus.off('event', listen);
  // The funnel tells this account from one whose address was confirmed by its code.
  assert.deepEqual(heard, [{ kind: 'onboarding_step', step: 'account', action: 'completed', via: 'operator' }]);
});
