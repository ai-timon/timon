import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appHostPolicy, createHostPolicyReader, hostAllowed, hostGuardExempt, hostnameOfHeader } from './host-guard';

const defaults = appHostPolicy(undefined);

test('hostnameOfHeader: port, brackets, case, trailing dot, malformed', () => {
  assert.equal(hostnameOfHeader('127.0.0.1:3100'), '127.0.0.1');
  assert.equal(hostnameOfHeader('[::1]:3100'), '::1');
  assert.equal(hostnameOfHeader('Timon.Localhost.'), 'timon.localhost');
  assert.equal(hostnameOfHeader('evil@127.0.0.1'), null);
  assert.equal(hostnameOfHeader('[evil]'), null);
});

test('no config file: a foreign name is refused, loopback names and IP literals pass', () => {
  for (const host of ['127.0.0.1:3100', 'localhost:3100', '[::1]:3100', '192.168.1.10:3100']) {
    assert.equal(hostAllowed(host, defaults), true, host);
  }
  for (const host of ['evil.example:3100', 'evil.example', 'localhost.evil.example']) {
    assert.equal(hostAllowed(host, defaults), false, host);
  }
});

test('Docker behind Traefik, Tailscale serve, desktop window: their names pass', () => {
  // Compose publishes timon.localhost and channels.timon.localhost; the desktop
  // window opens http://127.0.0.1:<port>; `tailscale serve` keeps the tailnet name.
  for (const host of ['timon.localhost', 'channels.timon.localhost', '127.0.0.1:3110', 'box.tail1234.ts.net']) {
    assert.equal(hostAllowed(host, defaults), true, host);
  }
});

test('a configured publicUrl or listen host is served', () => {
  const policy = appHostPolicy({ app: { publicUrl: 'https://timon.example.com', listen: { host: '127.0.0.1' } } });
  assert.equal(hostAllowed('timon.example.com', policy), true);
  assert.equal(hostAllowed('evil.example', policy), false);
});

test('an exposed app or a declared TLS proxy keeps every name', () => {
  assert.equal(appHostPolicy({ app: { listen: { host: '0.0.0.0' } } }).open, true);
  assert.equal(appHostPolicy({ daemon: { behindTlsProxy: true } }).open, true);
  assert.equal(appHostPolicy({ daemon: { listen: { host: '0.0.0.0' } } }).open, false);
});

test('webhooks and the remote API are exempt, nothing reached through a dot segment is', () => {
  for (const url of [
    '/api/channels/telegram/inbound',
    '/api/triggers/hooks/abc',
    '/api/plugins/hooks/acme/push?hub.challenge=1',
    '/api/remote/missions',
  ]) {
    assert.equal(hostGuardExempt(url), true, url);
  }
  for (const url of [
    '/api/ui/auth/setup',
    '/',
    '/api/remote/../ui/auth/setup',
    '/api/remote/%2e%2e/ui/auth/setup',
    '/api/triggers/hooks/..%2f..%2fui',
    '/api/channels/x/inbound/../../ui',
    undefined,
  ]) {
    assert.equal(hostGuardExempt(url), false, String(url));
  }
});

test('the reader follows the config file, closed while it is missing', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-host-guard-'));
  let now = 0;
  const read = createHostPolicyReader(home, () => now);
  assert.equal(read().open, false);
  const file = join(home, 'timon.config.json');
  writeFileSync(file, JSON.stringify({ daemon: { behindTlsProxy: true } }));
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  assert.equal(read().open, false, 'not looked at again within the recheck window');
  now = 10_000;
  assert.equal(read().open, true);
  writeFileSync(file, '{ not json');
  utimesSync(file, new Date(), new Date(Date.now() + 10_000));
  now = 20_000;
  assert.equal(read().open, false, 'an unreadable file falls back to the closed defaults');
});
