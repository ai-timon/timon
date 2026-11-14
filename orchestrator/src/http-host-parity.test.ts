/**
 * The daemon's `Host` rule (`http-host.ts`) and the app's
 * (`app/src/lib/host-guard.ts`) are two copies: the packages share no code.
 * This test fails as soon as they diverge outside the differences declared
 * below, so a fix made on one side cannot silently miss the other.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as daemon from './http-host.js';

type HostPolicy = daemon.HostPolicy;

/** The app module's surface this test compares. */
interface AppHostGuard {
  hostnameOfHeader(value: string): string | null;
  hostAllowed(header: string | undefined, policy: HostPolicy): boolean;
  appHostPolicy(raw: unknown): HostPolicy;
}

const app = await import(new URL('../../app/src/lib/host-guard.ts', import.meta.url).href) as AppHostGuard;

/**
 * Declared differences, and why they are wanted:
 *  — `host.docker.internal` is admitted by the daemon only: the app container
 *    reaches the daemon by that name, while nothing reaches the app by it;
 *  — each side opens its policy on its OWN listener (`daemon.listen.host` for
 *    the daemon, `app.listen.host` for the app): what is published is the
 *    socket a stranger can reach.
 */
const DAEMON_ONLY_NAMES: readonly string[] = ['host.docker.internal'];

const HEADERS: readonly string[] = [
  '127.0.0.1', '127.0.0.1:3001', '[::1]:3001', '[::1]', '::1', '[evil]:80', '[::ffff:127.0.0.1]:80',
  '10.0.0.5:3100', '0.0.0.0', '1.2.3.4.5',
  'localhost', 'LocalHost.:3001', 'localhost.', 'timon.localhost', 'a.b.timon.localhost:443',
  'localhost.evil.example', 'evillocalhost', 'xlocalhost:80',
  'box.tail1234.ts.net:8443', 'ts.net', 'evil-ts.net', 'tail.ts.net.evil.example',
  'host.docker.internal:3001', 'evil.internal', 'internal',
  'timon.example.com', 'Timon.Example.com:8443', 'box.lan:3100', 'evil.example', 'evil.example:3001',
  'evil@127.0.0.1', '127.0.0.1/x', 'evil.example:3001@x', ':3001', '', '  localhost  ', 'a b', 'under_score.lan',
  'example.com:99999', 'example.com:',
];

test('parity: both sides read a Host header the same way', () => {
  for (const header of HEADERS) {
    assert.equal(app.hostnameOfHeader(header), daemon.hostnameOfHeader(header), JSON.stringify(header));
  }
});

test('parity: same verdict for every header under the same policy', () => {
  const policies: HostPolicy[] = [
    { open: true },
    { open: false, names: new Set() },
    { open: false, names: new Set(['timon.example.com', 'box.lan']) },
  ];
  for (const policy of policies) {
    for (const header of [...HEADERS, undefined]) {
      assert.equal(
        app.hostAllowed(header, policy),
        daemon.hostAllowed(header, policy),
        `${JSON.stringify(header)} under ${policy.open ? 'open' : [...policy.names].join(',') || 'no names'}`,
      );
    }
  }
});

/** A configuration as the daemon types it and as the app reads it from the file. */
function configs(): Array<{ daemon: { listen: { host: string }; behindTlsProxy: boolean }; app: { listen: { host: string }; publicUrl: string } }> {
  const out = [];
  for (const daemonHost of ['127.0.0.1', 'localhost', '::1', 'box.lan', '0.0.0.0']) {
    for (const appHost of ['127.0.0.1', 'localhost', 'timon.lan', '0.0.0.0']) {
      for (const publicUrl of ['http://timon.localhost', 'https://Timon.Example.com:8443/app', 'http://127.0.0.1:3100', 'not a url']) {
        for (const behindTlsProxy of [false, true]) {
          out.push({ daemon: { listen: { host: daemonHost }, behindTlsProxy }, app: { listen: { host: appHost }, publicUrl } });
        }
      }
    }
  }
  return out;
}

test('parity: same admitted names from the same configuration, but for the declared ones', () => {
  for (const cfg of configs()) {
    const fromDaemon = daemon.daemonHostPolicy(cfg);
    const fromApp = app.appHostPolicy(JSON.parse(JSON.stringify(cfg)));
    const label = JSON.stringify(cfg);
    // Each side opens on its own listener (declared above), and both on a TLS proxy.
    const daemonPublished = cfg.daemon.behindTlsProxy || !['127.0.0.1', 'localhost', '::1'].includes(cfg.daemon.listen.host);
    const appPublished = cfg.daemon.behindTlsProxy || !['127.0.0.1', 'localhost', '::1'].includes(cfg.app.listen.host);
    assert.equal(fromDaemon.open, daemonPublished, `daemon: ${label}`);
    assert.equal(fromApp.open, appPublished, `app: ${label}`);
    if (fromDaemon.open || fromApp.open) continue;
    const daemonNames = [...fromDaemon.names].filter((name) => !DAEMON_ONLY_NAMES.includes(name)).sort();
    assert.deepEqual([...fromApp.names].sort(), daemonNames, label);
    for (const name of DAEMON_ONLY_NAMES) {
      assert.ok(fromDaemon.names.has(name), `${name} is still admitted by the daemon: ${label}`);
      assert.ok(!fromApp.names.has(name), `${name} is still refused by the app: ${label}`);
    }
  }
});
