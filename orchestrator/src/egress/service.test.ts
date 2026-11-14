/**
 * The daemon's egress proxy against real mission credentials (TODO #590):
 * only the live egress credential of the named mission passes; the
 * daemon-token, a user's own API token, the mission's API token, a finished
 * mission's credential and another mission's do not; the config only binds
 * the loopback; and neither the journal nor the daemon log shows a token.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { once } from 'node:events';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-egress-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { hashApiToken, issueApiTokenSecret, issueMissionApiToken, issueMissionEgressToken } = await import('../users/api-tokens.js');
const { ensureDaemonToken } = await import('../plugins-bundled/http/auth.js');
const { EgressSchema, TimonConfigSchema } = await import('../config/schema.js');
const { authenticateMissionToken, egressProxyAddress, formatEgressRecord, startEgressProxy } = await import('./service.js');
const { listMissionEgress } = await import('./journal.js');

const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });

function runningMission(): { id: string; token: string } {
  const id = randomUUID();
  dbApi.createMission(id, 'ada.agent', 'egress work', undefined, ada.id);
  return { id, token: issueMissionEgressToken(id) };
}

test('a live token passes only under its own mission id', () => {
  const a = runningMission();
  const b = runningMission();
  assert.equal(authenticateMissionToken(a.id, a.token), true);
  assert.equal(authenticateMissionToken(b.id, a.token), false);
  assert.equal(authenticateMissionToken(a.id, b.token), false);
  assert.equal(authenticateMissionToken(a.id, ''), false);
  assert.equal(authenticateMissionToken('', a.token), false);
});

test('credentials that are not a mission token are refused', () => {
  const a = runningMission();
  assert.equal(authenticateMissionToken(a.id, ensureDaemonToken()), false);
  const userToken = issueApiTokenSecret();
  dbApi.createApiToken({ tokenHash: hashApiToken(userToken), userId: ada.id, scope: 'user', label: 'cli' });
  assert.equal(authenticateMissionToken(a.id, userToken), false);
  assert.equal(authenticateMissionToken(a.id, 'not-a-token'), false);
  assert.equal(authenticateMissionToken(a.id, issueMissionApiToken(a.id)), false, "the mission's API token is no proxy credential");
  assert.equal(authenticateMissionToken(a.id, a.token), true, 'issuing the API token left the proxy credential alone');
});

test("a finished mission's token, or a re-issued one's predecessor, no longer passes", () => {
  const a = runningMission();
  const first = a.token;
  const second = issueMissionEgressToken(a.id);
  assert.equal(authenticateMissionToken(a.id, first), false);
  assert.equal(authenticateMissionToken(a.id, second), true);
  dbApi.finishMission(a.id, 'completed', 0);
  assert.equal(authenticateMissionToken(a.id, second), false);
});

test('the config binds the loopback only, defaults to off on an OS-chosen port', () => {
  assert.deepEqual(TimonConfigSchema.parse({}).host.isolation.egress, { mode: 'off', host: '127.0.0.1', port: 0 });
  for (const host of ['127.0.0.1', '127.0.0.2', '::1', '[::1]', '0:0:0:0:0:0:0:1']) {
    assert.equal(EgressSchema.safeParse({ host }).success, true, host);
  }
  for (const host of ['0.0.0.0', '::', '192.168.1.10', 'localhost', '10.0.0.1', 'example.com', '::2']) {
    assert.equal(EgressSchema.safeParse({ host }).success, false, host);
  }
  assert.equal(EgressSchema.safeParse({ port: 70_000 }).success, false);
  assert.equal(EgressSchema.safeParse({ mode: 'block' }).success, false);
});

test('mode off starts nothing', () => {
  const stop = startEgressProxy({ mode: 'off', host: '127.0.0.1', port: 0 });
  assert.equal(egressProxyAddress(), null);
  stop();
});

test('the daemon proxy refuses an anonymous client and logs no token for a real one', async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  console.warn = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  const stop = startEgressProxy({ mode: 'log', host: '127.0.0.1', port: 0 });
  after(stop);
  try {
    for (let i = 0; i < 200 && !egressProxyAddress(); i += 1) await new Promise((r) => setTimeout(r, 10));
    const address = egressProxyAddress();
    assert.ok(address);
    assert.equal(address.address, '127.0.0.1');

    const statusOf = async (authorization?: string): Promise<string> => {
      const socket = netConnect({ host: '127.0.0.1', port: address.port });
      await once(socket, 'connect');
      // Port 9 on the loopback: nothing listens, so an accepted client gets a 502, not a tunnel.
      socket.write(`CONNECT 127.0.0.1:9 HTTP/1.1\r\nHost: 127.0.0.1:9\r\n${authorization ? `Proxy-Authorization: ${authorization}\r\n` : ''}\r\n`);
      const [chunk] = await once(socket, 'data') as [Buffer];
      socket.destroy();
      return chunk.toString().split('\r\n')[0]!;
    };
    const a = runningMission();
    const b = runningMission();
    const basic = (id: string, token: string): string => `Basic ${Buffer.from(`${id}:${token}`).toString('base64')}`;

    assert.match(await statusOf(), / 407 /);
    assert.match(await statusOf(basic(b.id, a.token)), / 407 /);
    assert.match(await statusOf(basic(a.id, ensureDaemonToken())), / 407 /);
    assert.match(await statusOf(basic(a.id, a.token)), / 502 /);

    const journaled = () => listMissionEgress(a.id, { limit: 10 }).connections;
    for (let i = 0; i < 200 && journaled().length === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(journaled().map((row) => [row.method, row.host, row.port, row.status, row.error]), [['CONNECT', '127.0.0.1', 9, 502, 'ECONNREFUSED']]);
    assert.equal(lines.some((line) => line.includes(`mission=${a.id}`)), false, 'a journaled record also went to the daemon log');
    assert.ok(lines.filter((line) => line.includes('refused CONNECT')).length >= 3);
    const log = lines.join('\n');
    const journal = JSON.stringify(journaled());
    for (const secret of [a.token, b.token, ensureDaemonToken()]) {
      assert.equal(log.includes(secret), false, 'a token reached the daemon log');
      assert.equal(journal.includes(secret), false, 'a token reached the journal');
      assert.equal(log.includes(Buffer.from(`${a.id}:${secret}`).toString('base64')), false);
    }
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }
});

test('formatEgressRecord brackets an IPv6 host', () => {
  const line = formatEgressRecord({ missionId: 'm', method: 'CONNECT', host: '::1', port: 443, status: 200, bytesOut: 1, bytesIn: 2, startedAt: 0, durationMs: 3 });
  assert.equal(line, '[egress] mission=m CONNECT [::1]:443 status=200 out=1 in=2 3ms');
});
