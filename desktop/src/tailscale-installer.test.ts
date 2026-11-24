/**
 * "Install Tailscale" from the desktop app, against doubles: no installer,
 * no msiexec, no `open` ever runs here.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptedInstallerPath, handoffOf, TAILSCALE_MAC_APP, TailscaleInstaller, type TailscaleInstallerDeps,
} from './tailscale-installer.js';

const origin = 'http://127.0.0.1:3101';
const sender = { isWindow: true, isMainFrame: true, url: `${origin}/settings/devices` };
const SHA = 'a'.repeat(64);
const MAC_PKG = '/tmp/timon-tailscale-Ab12/Tailscale.pkg';
const WIN_MSI = 'C:\\Users\\robin\\AppData\\Local\\Temp\\timon-tailscale-Ab12\\tailscale-setup.msi';

const handoff = (path: string, sha256 = SHA) => ({
  status: 200,
  body: { platform: 'x', state: 'not_installed', job: { kind: 'install', phase: 'handoff', installer: { path, sha256 } } },
});

function fake(platform: NodeJS.Platform, opts: {
  reply?: { status: number; body: unknown };
  onDisk?: string;
  symlink?: boolean;
  exitCode?: number | null;
  appInstalled?: boolean;
} = {}) {
  const runs: { file: string; args: string[] }[] = [];
  const reports: unknown[] = [];
  const deps: TailscaleInstallerDeps = {
    platform,
    readStatus: async () => opts.reply ?? handoff(platform === 'win32' ? WIN_MSI : MAC_PKG),
    report: async (body) => { reports.push(body); },
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => opts.symlink === true }),
    sha256File: async () => opts.onDisk ?? SHA,
    run: async (file, args) => {
      runs.push({ file, args });
      return { code: opts.exitCode === undefined ? 0 : opts.exitCode, error: null };
    },
    systemRoot: 'C:\\Windows',
    exists: (path) => path === TAILSCALE_MAC_APP && opts.appInstalled !== false,
  };
  return { installer: new TailscaleInstaller(deps), runs, reports };
}

test('macOS: the verified pkg is opened in the Installer, and the daemon told', async () => {
  const f = fake('darwin');
  assert.deepEqual(await f.installer.openInstaller(sender, origin), { status: 'installed' });
  assert.deepEqual(f.runs, [{ file: '/usr/bin/open', args: ['-W', MAC_PKG] }]);
  assert.deepEqual(f.reports, [{ sha256: SHA, outcome: 'installed', code: 0 }]);
});

test('Windows: msiexec by its absolute path, UAC; cancelled and failed are told apart', async () => {
  const f = fake('win32');
  assert.deepEqual(await f.installer.openInstaller(sender, origin), { status: 'installed' });
  assert.deepEqual(f.runs, [{ file: 'C:\\Windows\\System32\\msiexec.exe', args: ['/i', WIN_MSI, '/passive', '/norestart'] }]);

  const cancelled = fake('win32', { exitCode: 1223 });
  assert.deepEqual(await cancelled.installer.openInstaller(sender, origin), { status: 'cancelled' });
  assert.deepEqual(cancelled.reports, [{ sha256: SHA, outcome: 'cancelled', code: 1223 }]);

  const failed = fake('win32', { exitCode: 1603 });
  assert.deepEqual(await failed.installer.openInstaller(sender, origin), { status: 'failed', message: 'msiexec exited with 1603' });
  assert.deepEqual(failed.reports, [{ sha256: SHA, outcome: 'failed', code: 1603 }]);
});

test('only the Timon window may ask, and it passes nothing', async () => {
  const f = fake('darwin');
  for (const bad of [
    { ...sender, isWindow: false },
    { ...sender, isMainFrame: false },
    { ...sender, url: 'https://evil.example/' },
    { ...sender, url: 'not a url' },
  ]) {
    await assert.rejects(f.installer.openInstaller(bad, origin));
    await assert.rejects(f.installer.openApp(bad, origin));
  }
  assert.equal(f.runs.length, 0);
});

test('a path the daemon would never write is never opened', async () => {
  for (const [platform, path] of [
    ['darwin', '/Applications/Evil.app/Contents/Tailscale.pkg'],
    ['darwin', '/tmp/timon-tailscale-x/../evil/Tailscale.pkg'],
    ['darwin', '/tmp/timon-tailscale-x/Tailscale.pkg.app'],
    ['darwin', 'tmp/timon-tailscale-x/Tailscale.pkg'],
    ['win32', '\\\\evil.example\\share\\timon-tailscale-x\\tailscale-setup.msi'],
    ['win32', '\\\\?\\C:\\Temp\\timon-tailscale-x\\tailscale-setup.msi'],
    ['win32', 'C:\\Temp\\timon-tailscale-x\\tailscale-setup.exe'],
    ['win32', 'C:\\Temp\\other\\tailscale-setup.msi'],
    ['win32', 'C:\\Temp\\timon-tailscale-x\\..\\x\\tailscale-setup.msi'],
  ] as const) {
    const f = fake(platform, { reply: handoff(path) });
    const outcome = await f.installer.openInstaller(sender, origin);
    assert.equal(outcome.status, 'failed', path);
    assert.equal(f.runs.length, 0, path);
    // Reported, so the daemon closes the job and removes its file at once.
    assert.deepEqual(f.reports, [{ sha256: SHA, outcome: 'failed' }], path);
  }
});

test('bytes that changed since the daemon verified them, or a link in their place: never opened', async () => {
  const changed = fake('darwin', { onDisk: 'b'.repeat(64) });
  assert.equal((await changed.installer.openInstaller(sender, origin)).status, 'failed');
  assert.equal(changed.runs.length, 0);
  assert.deepEqual(changed.reports, [{ sha256: SHA, outcome: 'failed' }]);

  const linked = fake('win32', { symlink: true });
  assert.equal((await linked.installer.openInstaller(sender, origin)).status, 'failed');
  assert.equal(linked.runs.length, 0);
  assert.deepEqual(linked.reports, [{ sha256: SHA, outcome: 'failed' }]);
});

test('nothing waiting, another step running, Linux, or a refused status read: nothing opened', async () => {
  for (const reply of [
    { status: 200, body: { job: null } },
    { status: 200, body: { job: { kind: 'install', phase: 'downloading', installer: null } } },
    { status: 200, body: { job: { kind: 'connect', phase: 'handoff', installer: { path: MAC_PKG, sha256: SHA } } } },
    { status: 200, body: { job: { kind: 'install', phase: 'handoff', installer: { path: MAC_PKG, sha256: 'short' } } } },
  ]) {
    const f = fake('darwin', { reply });
    assert.deepEqual(await f.installer.openInstaller(sender, origin), { status: 'none' });
    assert.equal(f.runs.length, 0);
  }
  const refused = fake('darwin', { reply: { status: 403, body: { error: 'forbidden' } } });
  assert.equal((await refused.installer.openInstaller(sender, origin)).status, 'failed');
  const linux = fake('linux');
  assert.deepEqual(await linux.installer.openInstaller(sender, origin), { status: 'none' });
  assert.equal(linux.runs.length, 0);
});

test('one installer per package at a time; a later attempt may open it again', async () => {
  let release: () => void = () => undefined;
  const f = fake('darwin');
  const runs: string[] = [];
  const installer = new TailscaleInstaller({
    platform: 'darwin',
    readStatus: async () => handoff(MAC_PKG),
    report: async () => undefined,
    lstat: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    sha256File: async () => SHA,
    run: (file) => {
      runs.push(file);
      return new Promise((resolve) => { release = () => resolve({ code: 0, error: null }); });
    },
    systemRoot: null,
    exists: () => true,
  });
  const first = installer.openInstaller(sender, origin);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await installer.openInstaller(sender, origin), { status: 'busy' });
  release();
  assert.deepEqual(await first, { status: 'installed' });
  void installer.openInstaller(sender, origin);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs.length, 2);
  release();
  assert.equal(f.runs.length, 0);
});

test('macOS: the Tailscale app opened from its fixed place, in the user session', async () => {
  const f = fake('darwin');
  assert.deepEqual(await f.installer.openApp(sender, origin), { status: 'opened' });
  assert.deepEqual(f.runs, [{ file: '/usr/bin/open', args: ['-a', '/Applications/Tailscale.app'] }]);
  assert.deepEqual(await fake('darwin', { appInstalled: false }).installer.openApp(sender, origin), { status: 'missing' });
  assert.deepEqual(await fake('win32').installer.openApp(sender, origin), { status: 'unsupported' });
});

test('parsers', () => {
  assert.deepEqual(handoffOf(handoff(MAC_PKG).body), { path: MAC_PKG, sha256: SHA });
  assert.equal(handoffOf(null), null);
  assert.ok(acceptedInstallerPath(MAC_PKG, 'darwin'));
  assert.ok(acceptedInstallerPath(WIN_MSI, 'win32'));
  assert.ok(!acceptedInstallerPath(MAC_PKG, 'linux'));
  assert.ok(!acceptedInstallerPath(`${MAC_PKG}\0`, 'darwin'));
});
