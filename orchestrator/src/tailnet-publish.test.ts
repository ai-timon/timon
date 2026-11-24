/**
 * Publishing the daemon on the tailnet, against a fake `tailscale`: no test
 * here ever runs the real binary (this machine has one, logged in).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyServeOutput, daemonServeAddress, daemonTarget, manualCommand, publishDaemonOnTailnet, publishThisDaemon,
  servedPorts, SERVE_HTTPS_PORTS, type TailnetPublishDeps,
} from './tailnet-publish.js';
import type { ExecResult } from './host/types.js';

const DNS = 'my-laptop.tail0000.ts.net';
const RUNNING = { BackendState: 'Running', Self: { DNSName: `${DNS}.`, TailscaleIPs: ['100.64.0.1'] } };

/** The maintainer's machine on 25/10/2026: the web UI on 443, one webhook path on 8443, the daemon nowhere. */
const ROM_SERVE = {
  TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
  Web: {
    [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3100' } } },
    [`${DNS}:8443`]: { Handlers: { '/api/hooks/abc': { Proxy: 'http://127.0.0.1:3001/api/hooks/abc' } } },
  },
};

type Fake = {
  deps: TailnetPublishDeps;
  calls: string[][];
};

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: '' });

/** A `tailscale` that answers `status`, holds a serve config, and applies `serve --bg` to it. */
function fakeTailscale(opts: {
  status?: unknown;
  serve?: Record<string, unknown>;
  serveResult?: ExecResult;
  platform?: NodeJS.Platform;
  binary?: string | null;
  daemonHost?: string;
} = {}): Fake {
  const calls: string[][] = [];
  const serve = structuredClone(opts.serve ?? {}) as { TCP?: Record<string, unknown>; Web?: Record<string, unknown> };
  const deps: TailnetPublishDeps = {
    platform: opts.platform ?? 'linux',
    binary: opts.binary === undefined ? '/usr/bin/tailscale' : opts.binary,
    daemonHost: opts.daemonHost ?? '127.0.0.1',
    daemonPort: 3001,
    async run(_binary, args) {
      calls.push(args);
      if (args[0] === 'status') return ok(JSON.stringify(opts.status ?? RUNNING));
      if (args[0] === 'serve' && args[1] === 'status') return ok(JSON.stringify(serve));
      if (args[0] === 'serve' && args[1] === '--bg') {
        if (opts.serveResult) return opts.serveResult;
        const port = Number(args[2]!.slice('--https='.length));
        serve.TCP = { ...serve.TCP, [port]: { HTTPS: true } };
        serve.Web = { ...serve.Web, [`${DNS}:${port}`]: { Handlers: { '/': { Proxy: args[3] } } } };
        return ok('');
      }
      throw new Error(`unexpected tailscale ${args.join(' ')}`);
    },
  };
  return { deps, calls };
}

function serveCalls(fake: Fake): string[][] {
  return fake.calls.filter((args) => args[0] === 'serve' && args[1] === '--bg');
}

test('on the maintainer\'s machine the daemon goes to 10000, the two taken ports are left alone', async () => {
  const fake = fakeTailscale({ serve: ROM_SERVE });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(result, { ok: true, address: `https://${DNS}:10000`, port: 10000, reused: false });
  assert.deepEqual(serveCalls(fake), [['serve', '--bg', '--https=10000', 'http://127.0.0.1:3001']]);
});

test('nothing served: 8443, leaving 443 to the web interface the docs publish there', async () => {
  const fake = fakeTailscale();
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(result, { ok: true, address: `https://${DNS}:8443`, port: 8443, reused: false });
});

test('443 only as a last resort, and then the address carries no port', async () => {
  const fake = fakeTailscale({ serve: { TCP: { 8443: {}, 10000: {} } } });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(result, { ok: true, address: `https://${DNS}`, port: 443, reused: false });
});

/** `tailscale` whose `serve status` cannot be read, the rest answering normally. */
function unreadableServe(answer: ExecResult): Fake {
  const fake = fakeTailscale();
  const run = fake.deps.run;
  fake.deps.run = async (binary, args) => {
    if (args[0] === 'serve' && args[1] === 'status') { fake.calls.push(args); return answer; }
    return run(binary, args);
  };
  return fake;
}

test('an unreadable serve config is not an empty one: nothing is published', async () => {
  for (const answer of [
    { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' },
    { code: 0, stdout: '{"TCP": {"443"', stderr: '' },
  ]) {
    const fake = unreadableServe(answer);
    const result = await publishDaemonOnTailnet(fake.deps);
    assert.equal(!result.ok && result.reason, answer.code === 0 ? 'unreadable' : 'failed');
    assert.equal(serveCalls(fake).length, 0);
  }
});

test('a status that exits 0 without JSON is unreadable, not "not connected", and says what tailscale printed', async () => {
  // The macOS app bundle started by launchd without TERM (the maintainer's Mac mini, 25/10/2026).
  const gui = 'The Tailscale GUI failed to start: The operation couldn\u2019t be completed. (Tailscale.CLIError error 3.)';
  const fake = fakeTailscale({ binary: '/Applications/Tailscale.app/Contents/MacOS/Tailscale', platform: 'darwin' });
  fake.deps.run = async (_binary, args) => {
    fake.calls.push(args);
    return ok(`${gui}\n`);
  };
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'unreadable');
  assert.equal(!result.ok && result.detail, gui);
  assert.deepEqual(fake.calls, [['status', '--json']]);
});

test('a serve config this account may not read: permission, nothing published', async () => {
  const fake = unreadableServe({ code: 1, stdout: '', stderr: 'Access denied: serve config denied' });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'permission');
  assert.equal(!result.ok && result.command, 'sudo tailscale serve status');
  assert.equal(serveCalls(fake).length, 0);
});

test('a blank serve status is the one empty answer: publication goes ahead', async () => {
  const fake = unreadableServe(ok(''));
  await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(serveCalls(fake), [['serve', '--bg', '--https=8443', 'http://127.0.0.1:3001']]);
});

test('a handler that already forwards to the daemon is reused: nothing runs', async () => {
  const fake = fakeTailscale({
    serve: { TCP: { 8443: {} }, Web: { [`${DNS}:8443`]: { Handlers: { '/': { Proxy: 'http://localhost:3001' } } } } },
  });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(result, { ok: true, address: `https://${DNS}:8443`, port: 8443, reused: true });
  assert.equal(serveCalls(fake).length, 0);
});

test('idempotent: a second call reuses what the first one published', async () => {
  const fake = fakeTailscale({ serve: ROM_SERVE });
  await publishDaemonOnTailnet(fake.deps);
  const again = await publishDaemonOnTailnet(fake.deps);
  assert.deepEqual(again, { ok: true, address: `https://${DNS}:10000`, port: 10000, reused: true });
  assert.equal(serveCalls(fake).length, 1);
});

test('a port with a TCP forward only, or one path only, is taken', () => {
  assert.deepEqual([...servedPorts({ TCP: { 10000: { TCPForward: '127.0.0.1:22' } } })], [10000]);
  assert.deepEqual([...servedPorts({ Web: { [`${DNS}:8443`]: { Handlers: { '/x': {} } } } })], [8443]);
  assert.deepEqual([...servedPorts(null)], []);
});

test('every port taken: a typed refusal, nothing overwritten', async () => {
  const fake = fakeTailscale({ serve: { TCP: { 443: {}, 8443: {}, 10000: {} } } });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.reason, 'no_free_port');
  assert.equal(serveCalls(fake).length, 0);
});

test('never funnel, and only the ports Tailscale accepts', async () => {
  for (const serve of [{}, ROM_SERVE, { TCP: { 443: {} } }]) {
    const fake = fakeTailscale({ serve });
    await publishDaemonOnTailnet(fake.deps);
    for (const args of fake.calls) assert.ok(!args.includes('funnel'), args.join(' '));
    for (const args of serveCalls(fake)) {
      const port = Number(args[2]!.slice('--https='.length));
      assert.ok((SERVE_HTTPS_PORTS as readonly number[]).includes(port), String(port));
    }
  }
});

test('no tailscale: not_installed, with how to install it', async () => {
  const fake = fakeTailscale({ binary: null, platform: 'darwin' });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'not_installed');
  assert.equal(!result.ok && result.command, 'curl -fsSLo "$TMPDIR/Tailscale.pkg" https://pkgs.tailscale.com/stable/Tailscale-latest-macos.pkg && sudo installer -pkg "$TMPDIR/Tailscale.pkg" -target /');
  assert.equal(fake.calls.length, 0);
});

test('logged out or stopped: not_connected, before any serve', async () => {
  for (const status of [{ BackendState: 'NeedsLogin' }, { BackendState: 'Stopped' }, { BackendState: 'Running', Self: {} }]) {
    const fake = fakeTailscale({ status });
    const result = await publishDaemonOnTailnet(fake.deps);
    assert.equal(!result.ok && result.reason, 'not_connected');
    assert.equal(!result.ok && result.command, 'sudo tailscale up');
    assert.ok(fake.calls.every((args) => args[0] === 'status'));
  }
});

test('Linux without --operator: permission, with the sudo line to copy', async () => {
  const fake = fakeTailscale({
    serveResult: { code: 1, stdout: '', stderr: 'Access denied: serve config denied\nUse \'sudo tailscale serve\' or run \'sudo tailscale set --operator=$USER\'' },
  });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'permission');
  assert.equal(!result.ok && result.command, 'sudo tailscale serve --bg --https=8443 http://127.0.0.1:3001');
});

test('Windows: the command names the resolved binary, for an administrator PowerShell', async () => {
  const exe = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const fake = fakeTailscale({ platform: 'win32', binary: exe, serveResult: { code: 1, stdout: '', stderr: 'Access denied' } });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.platform, 'win32');
  assert.equal(!result.ok && result.command, `& "${exe}" serve --bg --https=8443 http://127.0.0.1:3001`);
});

test('Serve not enabled on the tailnet: the console link, no command', async () => {
  const fake = fakeTailscale({
    serveResult: { code: 1, stdout: 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nXyz\n', stderr: '' },
  });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'serve_disabled');
  assert.equal(!result.ok && result.enableUrl, 'https://login.tailscale.com/f/serve?node=nXyz');
  assert.equal(!result.ok && result.command, null);
});

test('a serve that exits 0 but publishes nothing is not taken for a success', async () => {
  const fake = fakeTailscale({ serveResult: ok('') });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'failed');
});

test('a daemon bound to a LAN address cannot be relayed from the loopback', async () => {
  const fake = fakeTailscale({ daemonHost: '192.168.1.20' });
  const result = await publishDaemonOnTailnet(fake.deps);
  assert.equal(!result.ok && result.reason, 'listen_not_loopback');
  assert.equal(fake.calls.length, 0);
});

test('the relay target is the loopback whatever wildcard the daemon binds', () => {
  assert.equal(daemonTarget('0.0.0.0', 3001), 'http://127.0.0.1:3001');
  assert.equal(daemonTarget('::', 3001), 'http://127.0.0.1:3001');
  assert.equal(daemonTarget('::1', 3001), 'http://[::1]:3001');
  assert.equal(daemonTarget('10.0.0.2', 3001), null);
});

test('only a ROOT handler to the daemon port counts', () => {
  assert.equal(daemonServeAddress(ROM_SERVE, 3001), null);
  assert.equal(daemonServeAddress(ROM_SERVE, 3100)?.address, `https://${DNS}`);
});

test('output classification', () => {
  assert.equal(classifyServeOutput('must be run as root').reason, 'permission');
  assert.equal(classifyServeOutput('something else broke').reason, 'failed');
});

test('macOS: the app bundle CLI needs no sudo, a Homebrew one does', () => {
  const args = ['serve', '--bg', '--https=443', 'http://127.0.0.1:3001'];
  assert.equal(
    manualCommand('darwin', '/Applications/Tailscale.app/Contents/MacOS/Tailscale', args),
    '"/Applications/Tailscale.app/Contents/MacOS/Tailscale" serve --bg --https=443 http://127.0.0.1:3001',
  );
  assert.equal(manualCommand('darwin', '/opt/homebrew/bin/tailscale', args), 'sudo tailscale serve --bg --https=443 http://127.0.0.1:3001');
});

test('two clicks at once publish once', async () => {
  const fake = fakeTailscale({ serve: ROM_SERVE });
  const [a, b] = await Promise.all([publishThisDaemon(() => fake.deps), publishThisDaemon(() => fake.deps)]);
  assert.deepEqual(a, b);
  assert.equal(serveCalls(fake).length, 1);
});
