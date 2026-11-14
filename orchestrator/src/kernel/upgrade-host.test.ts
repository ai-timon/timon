/**
 * The `Host` guard on WebSocket upgrades. Upgrades bypass Express and its
 * auth middleware, so `handleUpgrade` applies the daemon's `Host` policy
 * itself: a page that rebound its own domain onto the loopback must not reach
 * the web terminal with the session cookie the browser attaches.
 */
// Isolate TIMON_HOME BEFORE any module that touches TIMON state (cf. test-home.ts).
import '../test-home.js';
import http from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { once } from 'node:events';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createHttpPlugin } = await import('./http-service.js');
const { daemonHostPolicy } = await import('../http-host.js');

const policy = daemonHostPolicy({
  daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: false },
  app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
});

const ctx = new Context();
await ctx.plugin(createHttpPlugin(express()));
let reached = 0;
ctx.http.upgrade((_req, socket) => {
  reached += 1;
  socket.end('HTTP/1.1 418 Witness\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  return true;
});

const server = http.createServer((_req, res) => { res.statusCode = 404; res.end(); });
server.on('upgrade', (req, socket, head) => ctx.http.handleUpgrade(req, socket, head, () => policy));
let port = 0;

before(async () => {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  port = (server.address() as AddressInfo).port;
});
after(() => { server.close(); });

/** Sends a raw WebSocket handshake and returns the status line of the answer. */
async function upgradeStatus(headers: Record<string, string>): Promise<string> {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const lines = [
    'GET /api/terminal/web/sessions/00000000-0000-0000-0000-000000000000/ws HTTP/1.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    ...Object.entries(headers).map(([name, value]) => `${name}: ${value}`),
  ];
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  let answer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => { answer += chunk; });
  await once(socket, 'close');
  return answer.split('\r\n')[0] ?? '';
}

test('an upgrade naming a foreign Host is refused with a neutral 421, before any handler', async () => {
  const before = reached;
  const status = await upgradeStatus({ Host: `evil.example:${port}`, Origin: `http://evil.example:${port}` });
  assert.equal(status, 'HTTP/1.1 421 Misdirected Request');
  assert.equal(reached, before, 'the handler never saw the request');
});

test('an upgrade naming a local Host reaches the handlers', async () => {
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `timon.localhost:${port}`]) {
    const before = reached;
    assert.equal(await upgradeStatus({ Host: host }), 'HTTP/1.1 418 Witness', host);
    assert.equal(reached, before + 1, host);
  }
});

test('a bearer credential exempts the upgrade, as it does any other request', async () => {
  const before = reached;
  const status = await upgradeStatus({ Host: `machine.example:${port}`, Authorization: 'Bearer tdev_witness' });
  assert.equal(status, 'HTTP/1.1 418 Witness');
  assert.equal(reached, before + 1);
});

test('the default policy is the daemon\'s own, read from its config', async () => {
  const other = http.createServer();
  other.on('upgrade', (req, socket, head) => ctx.http.handleUpgrade(req, socket, head));
  other.listen(0, '127.0.0.1');
  await once(other, 'listening');
  const saved = port;
  port = (other.address() as AddressInfo).port;
  try {
    assert.equal(await upgradeStatus({ Host: 'evil.example' }), 'HTTP/1.1 421 Misdirected Request');
  } finally {
    port = saved;
    other.close();
  }
});
