import assert from 'node:assert/strict';
import test from 'node:test';
import { isSecureOrigin, pairingAddress, tailnetUrl } from './webui-access';

test('the tailnet URL is the node name over https, or nothing', () => {
  assert.equal(tailnetUrl('my-laptop.tail0000.ts.net'), 'https://my-laptop.tail0000.ts.net');
  assert.equal(tailnetUrl(null), null);
});

test('https and the localhost exception are secure contexts', () => {
  assert.equal(isSecureOrigin('https://my-laptop.tail0000.ts.net/settings'), true);
  // The origin this very tab is usually read on: installable, without TLS.
  assert.equal(isSecureOrigin('http://timon.localhost/settings'), true);
  assert.equal(isSecureOrigin('http://localhost:3100/'), true);
  assert.equal(isSecureOrigin('http://127.0.0.1:3100/'), true);
  assert.equal(isSecureOrigin('http://[::1]:3100/'), true);
  // The packaged desktop client, served from its own privileged scheme.
  assert.equal(isSecureOrigin('app://timon/settings'), true);
});

test('a LAN address over plain HTTP is not — no PWA, no service worker', () => {
  assert.equal(isSecureOrigin('http://192.168.1.20:3100/'), false);
  assert.equal(isSecureOrigin('http://100.64.0.1:3100/'), false);
  // A tailnet NAME without TLS is no better than its address.
  assert.equal(isSecureOrigin('http://my-laptop.tail0000.ts.net/'), false);
});

test('an unusable href is never called secure', () => {
  assert.equal(isSecureOrigin(null), false);
  assert.equal(isSecureOrigin(''), false);
  assert.equal(isSecureOrigin('not a url'), false);
});

function served(serve: Array<{ host: string; target: string }>, port = 3001) {
  return { tailscale: { serve }, security: { daemon: { port } } };
}

test('the pairing address is the tailnet vhost that serves this daemon, not the interface', () => {
  const report = served([
    { host: 'box.tail1.ts.net:443', target: 'http://127.0.0.1:3101' },
    { host: 'box.tail1.ts.net:8443', target: 'http://127.0.0.1:3001' },
  ]);
  assert.equal(pairingAddress(report), 'https://box.tail1.ts.net:8443');
  // The daemon on 443: the default port is not spelled out.
  assert.equal(pairingAddress(served([{ host: 'box.tail1.ts.net:443', target: 'http://[::1]:3001' }])), 'https://box.tail1.ts.net');
});

test('no pairing address without a root handler to this daemon on the loopback', () => {
  assert.equal(pairingAddress(served([])), null);
  assert.equal(pairingAddress(served([{ host: 'box.tail1.ts.net:8443/api', target: 'http://127.0.0.1:3001' }])), null);
  assert.equal(pairingAddress(served([{ host: 'box.tail1.ts.net:8443', target: 'http://192.168.1.4:3001' }])), null);
  assert.equal(pairingAddress(served([{ host: 'box.tail1.ts.net:8443', target: '/srv/files' }])), null);
  assert.equal(pairingAddress(null), null);
  assert.equal(pairingAddress({ error: 'forbidden' }), null);
});

test('what "Make this machine reachable" publishes is read back as the pairing address', () => {
  // `serve status` after `tailscale serve --bg --https=10000 http://127.0.0.1:3001`, flattened by the daemon.
  assert.equal(pairingAddress(served([
    { host: 'box.tail1.ts.net:443', target: 'http://127.0.0.1:3100' },
    { host: 'box.tail1.ts.net:8443/api/hooks/abc', target: 'http://127.0.0.1:3001/api/hooks/abc' },
    { host: 'box.tail1.ts.net:10000', target: 'http://127.0.0.1:3001' },
  ])), 'https://box.tail1.ts.net:10000');
});
