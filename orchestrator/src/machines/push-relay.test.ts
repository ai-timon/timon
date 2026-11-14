/**
 * Push relayed from the fleet (multi-machine P4a). The witness daemon on
 * 127.0.0.1:0 plays the remote machine (plain HTTP is allowed on the loopback
 * only); the relay under test is the local daemon. Both share one database,
 * which is what makes the loop guard observable: the relayed copy shows up in
 * the remote's own list, and must not be relayed again.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-push-relay-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(HOME, 'timon.config.json'), JSON.stringify({ version: 1 }));

await import('../../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerRoutes: registerNotificationRoutes } = await import('../plugins-bundled/notifications/routes.js');
const { registerDeviceRoutes } = await import('../users/devices-http.js');
const { sseHandler } = await import('../sse.js');
const { bus } = await import('../bus.js');
const { db, dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { SESSION_COOKIE } = await import('../users/session.js');
const { issuePairingCode, redeemPairingCode, revokeDevice } = await import('../users/devices.js');
const { createNotification } = await import('../notifications.js');
const { deleteMachine, getOwnedMachine, savePairedMachine } = await import('./store.js');
const { MachinePushRelay, RELAY_MAX_PER_MINUTE } = await import('./push-relay.js');
const { relayedAnchor, relayedMachineId, relayedSource } = await import('./relayed.js');
const { openMachineStream } = await import('./stream.js');

const TOKEN = 'witness-daemon-token';
const PASSWORD = 'super-secret';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerDeviceRoutes(app);
registerNotificationRoutes(app);
app.get('/api/stream', sseHandler);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

const relays: InstanceType<typeof MachinePushRelay>[] = [];
test.after(() => {
  for (const relay of relays) relay.stop();
  server.closeAllConnections();
  server.close();
});

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string } = {}): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'robin@example.com', name: 'Robin', password: PASSWORD } });
assert.equal(setup.status, 201);
const rom = dbApi.getUserByEmail('robin@example.com')!;
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword(PASSWORD), status: 'active' });

/** A device of the user on the witness, and the machine of the user's fleet that holds it. */
function pairMachine(name: string, url: string = base): { machineId: string; deviceId: string } {
  const { code } = issuePairingCode(rom.id);
  const paired = redeemPairingCode({ code, name: `relay ${name}`, ip: null, userAgent: null });
  assert.equal(paired.kind, 'ok');
  if (paired.kind !== 'ok') throw new Error('unreachable');
  const { row } = savePairedMachine({
    ownerUserId: rom.id, name, url, token: paired.token, remoteDeviceId: paired.device.id,
    remoteUser: { email: rom.email, name: rom.name, is_superadmin: true },
  });
  return { machineId: row.id, deviceId: paired.device.id };
}

async function until<T>(read: () => T | undefined | null | false, what: string, timeoutMs = 4_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

type Row = { id: string; title: string; body: string | null; owner_user_id: string | null; source: string | null; anchor: string | null; dismissed_at: number | null; type: string };
const copiesOf = (machineId: string): Row[] =>
  db.prepare(`SELECT * FROM notifications WHERE source = ? ORDER BY created_at ASC`).all(relayedSource(machineId)) as Row[];

function startRelay(opts: { rateWindowMs?: number } = {}): InstanceType<typeof MachinePushRelay> {
  const relay = new MachinePushRelay({ timings: { backoffBaseMs: 20, backoffMaxMs: 100, stableMs: 50 }, reconcileMs: 60_000, ...opts });
  relays.push(relay);
  relay.start();
  return relay;
}

test('the relayed mark names a machine id, and nothing else', () => {
  assert.equal(relayedMachineId('machine:0f8fad5b-d9cb-469f-a165-70867728950e'), '0f8fad5b-d9cb-469f-a165-70867728950e');
  assert.equal(relayedMachineId('plugin:acme'), null);
  assert.equal(relayedMachineId('machine:../../x'), null);
  assert.equal(relayedMachineId(null), null);
});

test('the notifications topic carries the notification signal only', async () => {
  const { code } = issuePairingCode(rom.id);
  const paired = redeemPairingCode({ code, name: 'topic', ip: null, userAgent: null });
  if (paired.kind !== 'ok') throw new Error('pairing failed');
  const names: string[] = [];
  const opened = new Promise<void>((resolve) => {
    const stream = openMachineStream(base, { path: '/api/stream?topics=notifications', token: paired.token }, {
      onOpen: () => resolve(),
      onEvent: (name) => {
        names.push(name);
        if (name === 'notifications_changed') stream.close();
      },
      onEnd: () => {},
    });
  });
  await opened;
  bus.publish({ kind: 'license_changed', status: 'valid', reason: null, offlineSince: null });
  bus.publish({ kind: 'notifications_changed', ownerUserId: rom.id });
  await until(() => names.length > 0, 'the stream event');
  assert.deepEqual(names, ['notifications_changed']);
  revokeDevice(paired.device.id);
});

test("a card raised on the machine reaches its owner's centre here, marked, once", async () => {
  const old = createNotification({ type: 'alert', title: 'Before pairing', ownerUserId: rom.id });
  assert.ok(old);
  // `created_at` is per millisecond: the pairing must come strictly after.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const { machineId } = pairMachine('VPS');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');

  const card = createNotification({ type: 'action_required', urgent: true, title: 'Approve the deploy', body: 'v2', ownerUserId: rom.id });
  assert.ok(card);
  const [copy] = await until(() => { const rows = copiesOf(machineId); return rows.length > 0 ? rows : null; }, 'the relayed copy');
  assert.equal(copy!.title, 'VPS · Approve the deploy');
  assert.equal(copy!.body, 'v2');
  assert.equal(copy!.type, 'action_required');
  assert.equal(copy!.owner_user_id, rom.id);
  assert.equal(copy!.anchor, relayedAnchor(machineId, card.id));
  // The copy is in the remote's own list too (one database): never relayed back.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(copiesOf(machineId).length, 1, 'no second copy, no bounce');
  assert.ok(!copiesOf(machineId).some((row) => row.anchor === relayedAnchor(machineId, old.id)), 'a card older than the pairing is history');
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test("another account's cards and cards that came from a machine stay where they are", async () => {
  const { machineId } = pairMachine('NAS');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  createNotification({ type: 'alert', title: "Bob's secret", ownerUserId: bob.id });
  createNotification({ type: 'alert', title: 'Bounced', ownerUserId: rom.id, source: 'machine:0f8fad5b-d9cb-469f-a165-70867728950e', anchor: 'machine:x:y' });
  const system = createNotification({ type: 'alert', title: 'Daemon restarted', ownerUserId: null });
  assert.ok(system);
  await until(() => copiesOf(machineId).some((row) => row.anchor === relayedAnchor(machineId, system.id)), 'the unowned card');
  const titles = copiesOf(machineId).map((row) => row.title);
  assert.ok(!titles.some((title) => title.includes("Bob's secret")), "another account's card is not copied");
  assert.ok(!titles.some((title) => title.includes('Bounced')), 'a relayed card is not relayed again');
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test('a card dismissed on the machine is dismissed here too', async () => {
  const { machineId } = pairMachine('Desk');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  const card = createNotification({ type: 'alert', title: 'Disk almost full', ownerUserId: rom.id })!;
  const copy = await until(() => copiesOf(machineId).find((row) => row.anchor === relayedAnchor(machineId, card.id)), 'the copy');
  assert.equal(copy.dismissed_at, null);
  const { dismissNotificationRow } = await import('../notifications.js');
  dismissNotificationRow(dbApi.getNotification(card.id)!);
  await until(() => (db.prepare(`SELECT dismissed_at FROM notifications WHERE id = ?`).get(copy.id) as { dismissed_at: number | null }).dismissed_at !== null, 'the copy dismissed');
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test('a flood is capped per machine and per minute', async () => {
  const { machineId } = pairMachine('Noisy');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  for (let i = 0; i < RELAY_MAX_PER_MINUTE + 10; i++) createNotification({ type: 'report', title: `spam ${i}`, ownerUserId: rom.id });
  await until(() => copiesOf(machineId).length >= RELAY_MAX_PER_MINUTE, 'the first cards');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(copiesOf(machineId).length, RELAY_MAX_PER_MINUTE);
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test('the cards held back by the cap are relayed when the window ends, with no new event', { timeout: 15_000 }, async () => {
  const { machineId } = pairMachine('Burst');
  // A 1 s window stands for the minute.
  const relay = startRelay({ rateWindowMs: 1_000 });
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  for (let i = 0; i < RELAY_MAX_PER_MINUTE; i++) createNotification({ type: 'report', title: `burst ${i}`, ownerUserId: rom.id });
  await until(() => copiesOf(machineId).length >= RELAY_MAX_PER_MINUTE, 'the first window', 8_000);
  // Strictly newer than the copies, which share this database with the
  // witness: the held-back cards stay at the top of its 50-card list.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const held = 10;
  for (let i = 0; i < held; i++) createNotification({ type: 'report', title: `held ${i}`, ownerUserId: rom.id });
  // Nothing else happens on the machine: only the scheduled resync can relay them.
  await until(() => copiesOf(machineId).length >= RELAY_MAX_PER_MINUTE + held, 'the held-back cards', 8_000);
  assert.equal(copiesOf(machineId).length, RELAY_MAX_PER_MINUTE + held);
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test('revoked on the machine: the stream is cut there, the link stops and the machine reads unauthorized', async () => {
  const { machineId, deviceId } = pairMachine('Revoked');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  revokeDevice(deviceId);
  await until(() => relay.states()[machineId] === 'dead', 'the link to stop');
  assert.equal(getOwnedMachine(rom.id, machineId)!.status, 'unauthorized');
  // No retry loop on a dead device: still dead a while later.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(relay.states()[machineId], 'dead');
  relay.stop();
  deleteMachine(rom.id, machineId);
});

test('a machine removed from the fleet loses its link at the next alignment', async () => {
  const { machineId } = pairMachine('Removed');
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'open', 'the link to open');
  deleteMachine(rom.id, machineId);
  relay.reconcile();
  assert.equal(relay.states()[machineId], undefined);
  relay.stop();
});

test('an unreachable machine is retried with a backoff, and reached once it answers', async () => {
  // A port that refuses, then a witness that comes up on it.
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const deadPort = (probe.address() as AddressInfo).port;
  probe.close();
  await once(probe, 'close');
  const { machineId } = pairMachine('Late', `http://127.0.0.1:${deadPort}`);
  const relay = startRelay();
  await until(() => relay.states()[machineId] === 'waiting', 'a retry to be scheduled');
  const late = express();
  late.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
  late.use(express.json());
  registerUserRoutes(late, { setupPolicy: 'free' });
  registerNotificationRoutes(late);
  late.get('/api/stream', sseHandler);
  const lateServer = late.listen(deadPort, '127.0.0.1');
  await once(lateServer, 'listening');
  try {
    await until(() => relay.states()[machineId] === 'open', 'the link to open once the machine answers');
  } finally {
    relay.stop();
    lateServer.closeAllConnections();
    lateServer.close();
    deleteMachine(rom.id, machineId);
  }
});
