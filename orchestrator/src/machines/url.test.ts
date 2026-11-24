/**
 * The URL of a machine is typed by a person and called server side: every
 * refusal of the SSRF policy first, then what must pass.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBlockedAddress, parseMachineUrl, resolvedAddressAllowed } from './url.js';

const problem = (raw: unknown) => {
  const parsed = parseMachineUrl(raw);
  return parsed.ok ? null : parsed.problem;
};

test('plain HTTP is refused off the loopback, HTTPS everywhere else', () => {
  assert.equal(problem('http://vps.example.com'), 'https_required');
  assert.equal(problem('http://192.168.1.20:3001'), 'https_required');
  // A tailnet is encrypted, the arbitration still says HTTPS (`tailscale serve`).
  assert.equal(problem('http://100.101.102.103:3001'), 'https_required');
  assert.equal(problem('http://vps.tail1234.ts.net'), 'https_required');
  assert.equal(problem('ftp://vps.example.com'), 'invalid_url');
  assert.equal(problem('javascript:alert(1)'), 'invalid_url');
  assert.equal(problem('not a url'), 'invalid_url');
  assert.equal(problem(''), 'invalid_url');
  assert.equal(problem(42), 'invalid_url');
  assert.equal(problem(`https://${'a'.repeat(2050)}.com`), 'invalid_url');
});

test('no credentials, query string nor fragment in the URL', () => {
  assert.equal(problem('https://rom:secret@vps.example.com'), 'credentials_in_url');
  assert.equal(problem('https://vps.example.com/?token=abc'), 'query_in_url');
  assert.equal(problem('https://vps.example.com/#x'), 'query_in_url');
  assert.equal(problem('https://vps.example.com/?'), 'query_in_url');
});

test('addresses that are never a daemon are refused, however they are written', () => {
  for (const raw of [
    'https://169.254.169.254', 'https://[fe80::1]', 'https://0.0.0.0', 'https://[::]',
    'https://224.0.0.1', 'https://255.255.255.255', 'https://100.100.100.200',
    'https://[::ffff:169.254.169.254]', 'https://[::ffff:a9fe:a9fe]', 'https://[fd00:ec2::254]',
    'https://[ff02::1]', 'https://2852039166', 'https://0xa9fea9fe',
  ]) {
    assert.equal(problem(raw), 'blocked_address', raw);
  }
});

test('a LAN, a tailnet, a public host and the loopback pass, normalised', () => {
  const ok = (raw: string) => {
    const parsed = parseMachineUrl(raw);
    assert.ok(parsed.ok, raw);
    return parsed.value;
  };
  assert.deepEqual(ok('https://vps.tail1234.ts.net/'), { url: 'https://vps.tail1234.ts.net', loopback: false });
  assert.deepEqual(ok(' https://nas.lan:8443/timon/ '), { url: 'https://nas.lan:8443/timon', loopback: false });
  assert.deepEqual(ok('https://192.168.1.20'), { url: 'https://192.168.1.20', loopback: false });
  assert.deepEqual(ok('https://100.101.102.103'), { url: 'https://100.101.102.103', loopback: false });
  assert.deepEqual(ok('https://[fd7a:115c:a1e0::1]'), { url: 'https://[fd7a:115c:a1e0::1]', loopback: false });
  assert.deepEqual(ok('http://localhost:3002'), { url: 'http://localhost:3002', loopback: true });
  assert.deepEqual(ok('http://127.0.0.1:3002'), { url: 'http://127.0.0.1:3002', loopback: true });
  assert.deepEqual(ok('http://[::1]:3002'), { url: 'http://[::1]:3002', loopback: true });
  assert.deepEqual(ok('HTTPS://VPS.Example.COM'), { url: 'https://vps.example.com', loopback: false });
});

test('at connect time: the loopback only for a URL that named it, blocked ranges never', () => {
  // DNS rebinding onto this host.
  assert.equal(resolvedAddressAllowed('127.0.0.1', false), false);
  assert.equal(resolvedAddressAllowed('::1', false), false);
  assert.equal(resolvedAddressAllowed('::ffff:127.0.0.1', false), false);
  assert.equal(resolvedAddressAllowed('169.254.169.254', false), false);
  assert.equal(resolvedAddressAllowed('fe80::1', false), false);
  // `localhost` must stay on this host.
  assert.equal(resolvedAddressAllowed('127.0.0.1', true), true);
  assert.equal(resolvedAddressAllowed('::1', true), true);
  assert.equal(resolvedAddressAllowed('93.184.216.34', true), false);
  // Ordinary destinations.
  assert.equal(resolvedAddressAllowed('93.184.216.34', false), true);
  assert.equal(resolvedAddressAllowed('192.168.1.20', false), true);
  assert.equal(resolvedAddressAllowed('100.64.0.7', false), true);
  assert.equal(isBlockedAddress('not-an-ip'), true);
});

test('the address "Make this machine reachable" publishes is accepted, port included', () => {
  const parsed = parseMachineUrl('https://my-laptop.tail0000.ts.net:10000');
  assert.deepEqual(parsed, { ok: true, value: { url: 'https://my-laptop.tail0000.ts.net:10000', loopback: false } });
});
