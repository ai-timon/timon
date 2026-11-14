import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daemonHostPolicy, hostAllowed, hostnameOfHeader } from './http-host.js';

const loopback = daemonHostPolicy({
  daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: false },
  app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
});

test('hostnameOfHeader: port, brackets, case and trailing dot', () => {
  assert.equal(hostnameOfHeader('127.0.0.1:3001'), '127.0.0.1');
  assert.equal(hostnameOfHeader('[::1]:3001'), '::1');
  assert.equal(hostnameOfHeader('LocalHost.:3001'), 'localhost');
  assert.equal(hostnameOfHeader('evil.example'), 'evil.example');
  assert.equal(hostnameOfHeader('evil@127.0.0.1'), null);
  assert.equal(hostnameOfHeader('127.0.0.1/x'), null);
  assert.equal(hostnameOfHeader('[evil]:80'), null);
  assert.equal(hostnameOfHeader(':3001'), null);
});

test('loopback daemon: loopback names and IP literals pass, a foreign name does not', () => {
  for (const host of ['127.0.0.1:3001', 'localhost:3001', '[::1]:3001', 'localhost', '127.0.0.1:8765']) {
    assert.equal(hostAllowed(host, loopback), true, host);
  }
  for (const host of ['evil.example:3001', 'evil.example', 'localhost.evil.example:3001', 'ts.net', 'evil.example:3001@x']) {
    assert.equal(hostAllowed(host, loopback), false, host);
  }
});

test('loopback daemon: names that only resolve here pass (Traefik, Docker, Tailscale serve)', () => {
  for (const host of ['timon.localhost', 'channels.timon.localhost:80', 'host.docker.internal:3001', 'box.tail1234.ts.net:8443', '172.17.0.1:3001']) {
    assert.equal(hostAllowed(host, loopback), true, host);
  }
});

test('a request without Host is no browser\'s and passes', () => {
  assert.equal(hostAllowed(undefined, loopback), true);
});

test('configured names pass: publicUrl, listen hosts', () => {
  const policy = daemonHostPolicy({
    daemon: { listen: { host: 'localhost' }, behindTlsProxy: false },
    app: { listen: { host: 'box.lan' }, publicUrl: 'https://Timon.Example.com:8443/app' },
  });
  assert.equal(hostAllowed('timon.example.com', policy), true);
  assert.equal(hostAllowed('box.lan:3100', policy), true);
  assert.equal(hostAllowed('evil.example', policy), false);
});

test('published daemon: off the loopback or behind a TLS proxy, every name passes', () => {
  const exposed = daemonHostPolicy({
    daemon: { listen: { host: '0.0.0.0' }, behindTlsProxy: false },
    app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
  });
  const proxied = daemonHostPolicy({
    daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: true },
    app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
  });
  assert.equal(hostAllowed('timon.example.com', exposed), true);
  assert.equal(hostAllowed('timon.example.com', proxied), true);
});
