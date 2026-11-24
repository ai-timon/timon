/**
 * The install / sign-in / operator jobs, against doubles: no `tailscale up`,
 * no installer, no pkexec ever runs here.
 */
import { mock, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appBundleOf, authUrlIn, classifyUpOutput, HANDOFF_TIMEOUT_MS, nodeStateOf, TailscaleSetup,
  type TailscaleSetupDeps, type UpProcess,
} from './tailscale-setup.js';
import type { TailscaleInstallResult } from './host/tailscale-install.js';
import type { ExecResult } from './host/types.js';

const AUTH = 'https://login.tailscale.com/a/1a2b3c4d5e';

class FakeUp implements UpProcess {
  private out: ((chunk: string) => void)[] = [];
  private exit: ((code: number | null) => void)[] = [];
  killed = false;
  onOutput(listener: (chunk: string) => void): void { this.out.push(listener); }
  onExit(listener: (code: number | null) => void): void { this.exit.push(listener); }
  kill(): void {
    if (this.killed) return;
    this.killed = true;
    for (const l of this.exit) l(null);
  }
  print(chunk: string): void { for (const l of this.out) l(chunk); }
  end(code: number): void { for (const l of this.exit) l(code); }
}

type Harness = {
  setup: TailscaleSetup;
  state: { binary: string | null; status: ExecResult };
  ups: FakeUp[];
  launched: string[];
  finishInstall: (result: TailscaleInstallResult) => void;
  phase: (p: 'downloading' | 'verifying' | 'installing') => void;
  operatorCalls: string[];
  delegated: boolean[];
  removed: string[];
};

function harness(opts: { platform?: NodeJS.Platform; binary?: string | null; onSpawn?: (up: FakeUp) => void } = {}): Harness {
  const state = {
    binary: opts.binary === undefined ? '/usr/bin/tailscale' : opts.binary,
    status: { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin' }), stderr: '' } as ExecResult,
  };
  const ups: FakeUp[] = [];
  const launched: string[] = [];
  const operatorCalls: string[] = [];
  const delegated: boolean[] = [];
  const removed: string[] = [];
  let finishInstall: (result: TailscaleInstallResult) => void = () => undefined;
  let phase: Harness['phase'] = () => undefined;
  const deps: TailscaleSetupDeps = {
    platform: opts.platform ?? 'linux',
    binary: () => state.binary,
    run: async () => state.status,
    spawnUp: () => {
      const up = new FakeUp();
      ups.push(up);
      opts.onSpawn?.(up);
      return up;
    },
    install: (onPhase, delegate) => {
      delegated.push(delegate);
      phase = onPhase;
      return new Promise((resolve) => { finishInstall = resolve; });
    },
    allowOperator: async (binary) => {
      operatorCalls.push(binary);
      return { ok: true };
    },
    launchApp: async (binary) => { launched.push(binary); },
    removeDir: async (path) => { removed.push(path); },
    now: () => 1_000,
  };
  const setup = new TailscaleSetup(deps);
  return {
    setup, state, ups, launched, operatorCalls, delegated, removed,
    finishInstall: (r) => finishInstall(r),
    phase: (p) => phase(p),
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('status reads the machine: absent, logged out, running, not answering, unreadable', async () => {
  const h = harness({ binary: null });
  assert.deepEqual(await h.setup.status(), { platform: 'linux', state: 'not_installed', error: null, job: null });
  h.state.binary = '/usr/bin/tailscale';
  assert.equal((await h.setup.status()).state, 'needs_login');
  h.state.status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running' }), stderr: '' };
  assert.equal((await h.setup.status()).state, 'running');
  h.state.status = { code: 1, stdout: '', stderr: 'failed to connect to local tailscaled' };
  assert.equal((await h.setup.status()).state, 'unreachable');
  h.state.status = { code: 0, stdout: 'The Tailscale GUI failed to start', stderr: '' };
  const unreadable = await h.setup.status();
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.error, 'The Tailscale GUI failed to start');
});

test('install: one job, its phases followed, done once the installer returns', async () => {
  const h = harness({ binary: null });
  const started = await h.setup.install();
  assert.equal(started.job?.kind, 'install');
  assert.equal(started.job?.phase, 'downloading');
  h.phase('installing');
  // A second click while it runs starts nothing new.
  const again = await h.setup.install();
  assert.equal(again.job?.phase, 'installing');
  h.state.binary = '/usr/bin/tailscale';
  h.finishInstall({ ok: true, method: 'linux-script' });
  await tick();
  const after = await h.setup.status();
  assert.equal(after.job?.phase, 'done');
  assert.equal(after.state, 'needs_login');
});

test('install: a typed failure with its command and detail', async () => {
  const h = harness({ binary: null });
  await h.setup.install();
  h.finishInstall({ ok: false, reason: 'elevation_unavailable', command: 'curl -fsSL https://tailscale.com/install.sh | sudo sh', detail: null });
  await tick();
  const job = (await h.setup.status()).job!;
  assert.equal(job.phase, 'failed');
  assert.equal(job.failure, 'elevation_unavailable');
  assert.equal(job.command, 'curl -fsSL https://tailscale.com/install.sh | sudo sh');
});

const SHA = 'c'.repeat(64);
const HANDED = { ok: true, method: 'windows-msi', installer: { dir: 'C:\\Temp\\timon-tailscale-1', path: 'C:\\Temp\\timon-tailscale-1\\tailscale-setup.msi', sha256: SHA } } as const;

test('install from the desktop app on a daemon without a desktop: handoff, then done once Tailscale is there', async () => {
  const h = harness({ platform: 'win32', binary: null });
  await h.setup.install({ client: 'desktop' });
  assert.deepEqual(h.delegated, [true]);
  h.finishInstall(HANDED);
  await tick();
  const waiting = await h.setup.status();
  assert.equal(waiting.job?.phase, 'handoff');
  assert.deepEqual(waiting.job?.installer, { path: HANDED.installer.path, sha256: SHA });
  // Still busy: a second click does not download again.
  await h.setup.install({ client: 'desktop' });
  assert.deepEqual(h.delegated, [true]);
  h.state.binary = 'C:\\Program Files\\Tailscale\\tailscale.exe';
  const installed = await h.setup.status();
  assert.equal(installed.job?.phase, 'done');
  assert.equal(installed.job?.installer, null);
  // The package stays until the app is done with it.
  assert.deepEqual(h.removed, []);
  await h.setup.reportInstaller({ sha256: SHA, outcome: 'installed', code: 0 });
  assert.deepEqual(h.removed, [HANDED.installer.dir]);
  assert.equal((await h.setup.status()).job?.phase, 'done');
  h.setup.dispose();
});

test('install from a browser: never delegated', async () => {
  const h = harness({ platform: 'darwin', binary: null });
  await h.setup.install();
  assert.deepEqual(h.delegated, [false]);
  h.setup.dispose();
});

test('the app reports a cancelled or failed installer: typed, with the command, package removed', async () => {
  for (const [outcome, failure] of [['cancelled', 'cancelled'], ['failed', 'installer_failed']] as const) {
    const h = harness({ platform: 'win32', binary: null });
    await h.setup.install({ client: 'desktop' });
    h.finishInstall(HANDED);
    await tick();
    const after = await h.setup.reportInstaller({ sha256: SHA, outcome, code: 1602 });
    assert.equal(after.job?.phase, 'failed');
    assert.equal(after.job?.failure, failure);
    assert.equal(after.job?.detail, 'the installer exited with 1602');
    assert.match(after.job?.command ?? '', /^winget install/);
    assert.equal(after.job?.installer, null);
    assert.deepEqual(h.removed, [HANDED.installer.dir]);
    h.setup.dispose();
  }
});

test('"installed" while Tailscale is still missing (macOS Installer closed): cancelled', async () => {
  const h = harness({ platform: 'darwin', binary: null });
  await h.setup.install({ client: 'desktop' });
  h.finishInstall({ ok: true, method: 'macos-pkg', installer: { dir: '/tmp/timon-tailscale-2', path: '/tmp/timon-tailscale-2/Tailscale.pkg', sha256: SHA } });
  await tick();
  const after = await h.setup.reportInstaller({ sha256: SHA, outcome: 'installed', code: 0 });
  assert.equal(after.job?.failure, 'cancelled');
  h.setup.dispose();
});

test('no app ever came for the package: removed, and the job says so with the command', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const h = harness({ platform: 'darwin', binary: null });
    await h.setup.install({ client: 'desktop' });
    h.finishInstall({ ok: true, method: 'macos-pkg', installer: { dir: '/tmp/timon-tailscale-3', path: '/tmp/timon-tailscale-3/Tailscale.pkg', sha256: SHA } });
    await tick();
    mock.timers.tick(HANDOFF_TIMEOUT_MS);
    const after = await h.setup.status();
    assert.equal(after.job?.phase, 'failed');
    assert.equal(after.job?.failure, 'no_desktop');
    assert.ok(after.job?.command?.includes('Tailscale-latest-macos.pkg'));
    assert.deepEqual(h.removed, ['/tmp/timon-tailscale-3']);
  } finally {
    mock.timers.reset();
  }
});

test('a report about another package closes nothing and removes nothing', async () => {
  const h = harness({ platform: 'win32', binary: null });
  await h.setup.install({ client: 'desktop' });
  h.finishInstall(HANDED);
  await tick();
  const after = await h.setup.reportInstaller({ sha256: 'd'.repeat(64), outcome: 'failed' });
  assert.equal(after.job?.phase, 'handoff');
  assert.deepEqual(h.removed, []);
  // Nor does a report with no handoff at all.
  const idle = harness({ platform: 'win32', binary: null });
  assert.equal((await idle.setup.reportInstaller({ sha256: SHA, outcome: 'installed' })).job, null);
  h.setup.dispose();
  assert.deepEqual(h.removed, [HANDED.installer.dir]);
});

test('install on a machine that already has tailscale starts nothing', async () => {
  const h = harness();
  assert.equal((await h.setup.install()).job, null);
});

test('connect: the sign-in URL tailscale prints is answered, then the job ends when the node runs', async () => {
  const h = harness({ onSpawn: (up) => setImmediate(() => up.print(`\nTo authenticate, visit:\n\n\t${AUTH}\n\n`)) });
  const answer = await h.setup.connect();
  assert.equal(answer.job?.kind, 'connect');
  assert.equal(answer.job?.phase, 'waiting_login');
  assert.equal(answer.job?.authUrl, AUTH);
  h.state.status = { code: 0, stdout: JSON.stringify({ BackendState: 'Running' }), stderr: '' };
  const done = await h.setup.status();
  assert.equal(done.job?.phase, 'done');
  assert.equal(h.ups[0]!.killed, true, 'tailscale up does not outlive the sign-in');
});

test('connect: a node that only needed to come up exits 0, done', async () => {
  const h = harness({ onSpawn: (up) => setImmediate(() => up.end(0)) });
  const answer = await h.setup.connect();
  assert.equal(answer.job?.phase, 'done');
});

test('connect on Linux without operator: permission, with the operator line', async () => {
  const h = harness({ onSpawn: (up) => setImmediate(() => { up.print('Access denied: prefs write access denied\n'); up.end(1); }) });
  const job = (await h.setup.connect()).job!;
  assert.equal(job.failure, 'permission');
  assert.equal(job.command, 'sudo tailscale set --operator=$USER');
  assert.equal(job.detail, 'Access denied: prefs write access denied');
});

test('connect on macOS opens the app the CLI lives in first', async () => {
  const bin = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  const h = harness({ platform: 'darwin', binary: bin, onSpawn: (up) => setImmediate(() => up.print(AUTH)) });
  await h.setup.connect();
  assert.deepEqual(h.launched, [bin]);
  // A Homebrew CLI has no app to open.
  const brew = harness({ platform: 'darwin', binary: '/opt/homebrew/bin/tailscale', onSpawn: (up) => setImmediate(() => up.print(AUTH)) });
  await brew.setup.connect();
  assert.deepEqual(brew.launched, []);
});

test('connect: the URL may come from status when up printed none', async () => {
  const h = harness({ onSpawn: () => undefined });
  // Not awaited: the job is read through status while `up` stays silent.
  const pending = h.setup.connect();
  h.state.status = { code: 0, stdout: JSON.stringify({ BackendState: 'NeedsLogin', AuthURL: AUTH }), stderr: '' };
  const seen = await h.setup.status();
  assert.equal(seen.job?.authUrl, AUTH);
  h.ups[0]!.end(0);
  await pending;
});

test('operator: Linux only, through the elevated helper', async () => {
  const linux = harness();
  await linux.setup.allowOperator();
  await tick();
  assert.deepEqual(linux.operatorCalls, ['/usr/bin/tailscale']);
  assert.equal((await linux.setup.status()).job?.phase, 'done');
  const mac = harness({ platform: 'darwin' });
  const refused = (await mac.setup.allowOperator()).job!;
  assert.equal(refused.failure, 'unsupported');
  assert.deepEqual(mac.operatorCalls, []);
});

test('parsers', () => {
  assert.equal(authUrlIn(`visit:\n\t${AUTH}\n`), AUTH);
  assert.equal(authUrlIn('visit https://evil.example/a/1'), null);
  assert.deepEqual(nodeStateOf({ BackendState: 'NeedsLogin', AuthURL: 'https://evil.example/x' }), { state: 'needs_login', authUrl: null });
  assert.deepEqual(nodeStateOf({ BackendState: 'Stopped' }), { state: 'stopped', authUrl: null });
  assert.equal(classifyUpOutput('failed to connect to local Tailscale service; is Tailscale running?'), 'not_running');
  assert.equal(classifyUpOutput('Error: changing settings via \'tailscale up\' requires mentioning all non-default flags'), 'failed');
  assert.equal(appBundleOf('/Applications/Tailscale.app/Contents/MacOS/Tailscale'), '/Applications/Tailscale.app');
  assert.equal(appBundleOf('/usr/bin/tailscale'), null);
});
