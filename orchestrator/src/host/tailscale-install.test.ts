/**
 * "Install Tailscale" against doubles: no network, no installer, no pkexec.
 * Nothing in this file may install anything on the machine that runs it.
 */
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  allowTailscaleOperator,
  authenticodeScript,
  installTailscale,
  isOfficialUrl,
  linuxElevatedScript,
  msiSignedByTailscale,
  packageFromIndex,
  parseSha256File,
  pkgSignedByTailscale,
  safeOperatorName,
  tailscaleManualInstallCommand,
  type TailscaleInstallDeps,
  type TailscaleInstallPhase,
} from './tailscale-install.js';
import type { ExecResult } from './types.js';

const INDEX = {
  MSIs: { amd64: 'tailscale-setup-1.104.2-amd64.msi', arm64: 'tailscale-setup-1.104.2-arm64.msi', x86: 'tailscale-setup-1.104.2-x86.msi' },
  MacZips: { universal: 'Tailscale-1.104.2-macos.zip', 'universal-package': 'Tailscale-1.104.2-macos.pkg' },
};

const PKG_SIGNED = `Package "Tailscale.pkg":
   Status: signed by a developer certificate issued by Apple for distribution
   Notarization: trusted by the Apple notary service
   Signed with a trusted timestamp on: 2026-10-20 18:56:10 +0000
   Certificate Chain:
    1. Developer ID Installer: Tailscale Inc. (W5364U7YZB)
       Expires: 2031-01-01 00:00:00 +0000
    2. Developer ID Certification Authority
    3. Apple Root CA
`;

const MSI_SIGNED = JSON.stringify({
  Status: 'Valid',
  Subject: 'CN=Tailscale Inc., O=Tailscale Inc., L=Toronto, S=Ontario, C=CA, SERIALNUMBER=1131559-5',
});

const ok = (stdout = ''): ExecResult => ({ code: 0, stdout, stderr: '' });

type Fake = {
  deps: TailscaleInstallDeps;
  fetched: string[];
  execs: { file: string; args: string[] }[];
  written: Map<string, Uint8Array>;
  removed: string[];
  phases: TailscaleInstallPhase[];
};

function fake(opts: {
  platform: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  body?: Uint8Array;
  sha?: string;
  finalUrl?: (url: string) => string;
  exec?: (file: string, args: string[]) => ExecResult;
  session?: 'graphical' | 'none' | 'unknown';
  pkexec?: string | null;
  username?: string | null;
  script?: string;
}): Fake {
  const body = opts.body ?? new TextEncoder().encode('official package bytes');
  const sha = opts.sha ?? createHash('sha256').update(body).digest('hex');
  const fetched: string[] = [];
  const execs: Fake['execs'] = [];
  const written = new Map<string, Uint8Array>();
  const removed: string[] = [];
  const phases: TailscaleInstallPhase[] = [];
  const response = (url: string, bytes: Uint8Array, status = 200) => ({
    ok: status === 200,
    status,
    url: opts.finalUrl ? opts.finalUrl(url) : url,
    text: async () => new TextDecoder().decode(bytes),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  });
  const deps: TailscaleInstallDeps = {
    platform: opts.platform,
    arch: opts.arch ?? 'x64',
    async fetcher(url) {
      fetched.push(url);
      if (url.endsWith('/?mode=json')) return response(url, new TextEncoder().encode(JSON.stringify(INDEX)));
      if (url.endsWith('.sha256')) return response(url, new TextEncoder().encode(`${sha}\n`));
      if (url === 'https://tailscale.com/install.sh') return response(url, new TextEncoder().encode(opts.script ?? '#!/bin/sh\necho install\n'));
      return response(url, body);
    },
    async exec(file, args) {
      execs.push({ file, args });
      return opts.exec ? opts.exec(file, args) : ok();
    },
    desktopSession: async () => opts.session ?? 'graphical',
    findBinary: (name) => (name === 'pkexec' ? (opts.pkexec === undefined ? '/usr/bin/pkexec' : opts.pkexec) : null),
    username: () => (opts.username === undefined ? 'rom' : opts.username),
    makeTempDir: async () => '/private/tmp/timon-tailscale-x',
    removeDir: async (path) => { removed.push(path); },
    writeFile: async (path, data) => { written.set(path, data); },
    onPhase: (phase) => { phases.push(phase); },
  };
  return { deps, fetched, execs, written, removed, phases };
}

test('macOS: the official pkg, checksum then signature checked, opened in the Installer, then removed', async () => {
  const f = fake({
    platform: 'darwin',
    exec: (file) => (file === '/usr/sbin/pkgutil' ? ok(PKG_SIGNED) : ok()),
  });
  const result = await installTailscale(f.deps);
  assert.deepEqual(result, { ok: true, method: 'macos-pkg' });
  assert.deepEqual(f.fetched, [
    'https://pkgs.tailscale.com/stable/?mode=json',
    'https://pkgs.tailscale.com/stable/Tailscale-1.104.2-macos.pkg.sha256',
    'https://pkgs.tailscale.com/stable/Tailscale-1.104.2-macos.pkg',
  ]);
  const pkg = [...f.written.keys()][0]!;
  assert.deepEqual(f.execs, [
    { file: '/usr/sbin/pkgutil', args: ['--check-signature', pkg] },
    { file: '/usr/bin/open', args: ['-W', pkg] },
  ]);
  assert.deepEqual(f.phases, ['downloading', 'verifying', 'installing']);
  assert.deepEqual(f.removed, ['/private/tmp/timon-tailscale-x']);
  // Never Homebrew.
  assert.ok(f.execs.every((call) => !call.file.includes('brew')));
});

test('a package whose bytes differ from the published sha256 is never opened', async () => {
  const f = fake({ platform: 'darwin', sha: 'a'.repeat(64) });
  const result = await installTailscale(f.deps);
  assert.equal(!result.ok && result.reason, 'checksum_mismatch');
  assert.equal(f.execs.length, 0);
  assert.deepEqual(f.removed, ['/private/tmp/timon-tailscale-x']);
});

test('a pkg not signed by Tailscale Inc. is never opened', async () => {
  const forged = PKG_SIGNED.replace('Tailscale Inc. (W5364U7YZB)', 'Someone Else (ABCDE12345)');
  const f = fake({ platform: 'darwin', exec: (file) => (file === '/usr/sbin/pkgutil' ? ok(forged) : ok()) });
  const result = await installTailscale(f.deps);
  assert.equal(!result.ok && result.reason, 'signature_invalid');
  assert.deepEqual(f.execs.map((call) => call.file), ['/usr/sbin/pkgutil']);
});

test('a redirect away from the vendor is refused', async () => {
  const f = fake({ platform: 'darwin', finalUrl: (url) => (url.endsWith('.pkg') ? 'https://evil.example/Tailscale.pkg' : url) });
  const result = await installTailscale(f.deps);
  assert.equal(!result.ok && result.reason, 'download_failed');
  assert.equal(f.execs.length, 0);
});

test('no desktop to show the installer on and no desktop app asking (a plain browser): nothing downloaded, the command to run', async () => {
  for (const platform of ['win32', 'darwin'] as const) {
    for (const session of ['none', 'unknown'] as const) {
      const f = fake({ platform, session });
      const result = await installTailscale(f.deps);
      assert.equal(!result.ok && result.reason, 'no_desktop');
      assert.equal(!result.ok && result.command, tailscaleManualInstallCommand(platform));
      assert.equal(f.fetched.length, 0);
    }
  }
});

test('packaged daemon without a desktop (Windows S4U, macOS LaunchDaemon), asked by the desktop app: verified here, handed over unopened', async () => {
  for (const [platform, session] of [['win32', 'none'], ['darwin', 'none'], ['win32', 'unknown'], ['darwin', 'unknown']] as const) {
    const f = fake({
      platform,
      session,
      exec: (file) => (file === 'powershell.exe' ? ok(MSI_SIGNED) : file === '/usr/sbin/pkgutil' ? ok(PKG_SIGNED) : ok()),
    });
    const result = await installTailscale(f.deps, { delegate: true });
    assert.ok(result.ok, `${platform}/${session}`);
    const file = platform === 'darwin' ? 'Tailscale.pkg' : 'tailscale-setup.msi';
    const path = [...f.written.keys()][0]!;
    assert.ok(path.endsWith(file));
    assert.deepEqual(result.installer, {
      dir: '/private/tmp/timon-tailscale-x',
      path,
      sha256: createHash('sha256').update(new TextEncoder().encode('official package bytes')).digest('hex'),
    });
    // The signature was checked; no installer was started by the daemon.
    assert.deepEqual(f.execs.map((call) => call.file), [platform === 'darwin' ? '/usr/sbin/pkgutil' : 'powershell.exe']);
    assert.deepEqual(f.phases, ['downloading', 'verifying']);
    // The app still has to read it.
    assert.deepEqual(f.removed, []);
  }
});

test('handed over or not, a package that fails its checks is removed and never offered', async () => {
  const f = fake({ platform: 'darwin', session: 'none', sha: 'b'.repeat(64) });
  const result = await installTailscale(f.deps, { delegate: true });
  assert.equal(!result.ok && result.reason, 'checksum_mismatch');
  assert.deepEqual(f.removed, ['/private/tmp/timon-tailscale-x']);

  const forged = fake({ platform: 'win32', session: 'none', exec: () => ok(JSON.stringify({ Status: 'HashMismatch', Subject: 'CN=Tailscale Inc.' })) });
  const refused = await installTailscale(forged.deps, { delegate: true });
  assert.equal(!refused.ok && refused.reason, 'signature_invalid');
  assert.deepEqual(forged.removed, ['/private/tmp/timon-tailscale-x']);
});

test('a daemon in the desktop session opens the installer itself, even when the desktop app asked', async () => {
  const f = fake({ platform: 'win32', session: 'graphical', exec: (file) => (file === 'powershell.exe' ? ok(MSI_SIGNED) : ok()) });
  const result = await installTailscale(f.deps, { delegate: true });
  assert.deepEqual(result, { ok: true, method: 'windows-msi' });
  assert.equal(f.execs[1]!.file, 'msiexec.exe');
  assert.deepEqual(f.removed, ['/private/tmp/timon-tailscale-x']);
});

test('Windows: the MSI for this CPU, Authenticode of Tailscale Inc., msiexec with its UAC prompt', async () => {
  const f = fake({
    platform: 'win32',
    arch: 'arm64',
    exec: (file) => (file === 'powershell.exe' ? ok(MSI_SIGNED) : ok()),
  });
  const result = await installTailscale(f.deps);
  assert.deepEqual(result, { ok: true, method: 'windows-msi' });
  assert.ok(f.fetched.includes('https://pkgs.tailscale.com/stable/tailscale-setup-1.104.2-arm64.msi'));
  const msi = [...f.written.keys()][0]!;
  assert.equal(f.execs[0]!.file, 'powershell.exe');
  assert.deepEqual(f.execs[1], { file: 'msiexec.exe', args: ['/i', msi, '/passive', '/norestart'] });
});

test('Windows: a cancelled UAC prompt is "cancelled", an unsigned MSI never runs', async () => {
  const cancelled = fake({
    platform: 'win32',
    exec: (file) => (file === 'powershell.exe' ? ok(MSI_SIGNED) : { code: 1602, stdout: '', stderr: '' }),
  });
  const result = await installTailscale(cancelled.deps);
  assert.equal(!result.ok && result.reason, 'cancelled');

  const unsigned = fake({
    platform: 'win32',
    exec: (file) => (file === 'powershell.exe' ? ok(JSON.stringify({ Status: 'NotSigned', Subject: '' })) : ok()),
  });
  const refused = await installTailscale(unsigned.deps);
  assert.equal(!refused.ok && refused.reason, 'signature_invalid');
  assert.ok(unsigned.execs.every((call) => call.file !== 'msiexec.exe'));
});

test('Linux: the official script run through pkexec, this account made operator in the same prompt', async () => {
  const f = fake({ platform: 'linux' });
  const result = await installTailscale(f.deps);
  assert.deepEqual(result, { ok: true, method: 'linux-script' });
  assert.deepEqual(f.fetched, ['https://tailscale.com/install.sh']);
  const wrapper = [...f.written.keys()].find((path) => path.endsWith('timon-install.sh'))!;
  assert.deepEqual(f.execs, [{ file: '/usr/bin/pkexec', args: ['/bin/sh', wrapper] }]);
  const script = new TextDecoder().decode(f.written.get(wrapper));
  assert.match(script, /^#!\/bin\/sh\nset -e\n\/bin\/sh '.*install\.sh'\ntailscale set --operator='rom' \|\| true\n$/);
});

test('Linux: no pkexec → the command to paste, nothing downloaded; a dismissed dialog → cancelled; no agent → elevation_unavailable', async () => {
  const none = fake({ platform: 'linux', pkexec: null });
  const r1 = await installTailscale(none.deps);
  assert.equal(!r1.ok && r1.reason, 'elevation_unavailable');
  assert.equal(!r1.ok && r1.command, 'curl -fsSL https://tailscale.com/install.sh | sudo sh');
  assert.equal(none.fetched.length, 0);

  const dismissed = await installTailscale(fake({ platform: 'linux', exec: () => ({ code: 126, stdout: '', stderr: '' }) }).deps);
  assert.equal(!dismissed.ok && dismissed.reason, 'cancelled');

  const noAgent = await installTailscale(fake({
    platform: 'linux',
    exec: () => ({ code: 127, stdout: '', stderr: 'Error executing command as another user: Not authorized' }),
  }).deps);
  assert.equal(!noAgent.ok && noAgent.reason, 'elevation_unavailable');
  assert.equal(!noAgent.ok && noAgent.detail, 'Error executing command as another user: Not authorized');
});

test('Linux: a script that is not a shell script is never elevated', async () => {
  const f = fake({ platform: 'linux', script: '<html>captive portal</html>' });
  const result = await installTailscale(f.deps);
  assert.equal(!result.ok && result.reason, 'download_failed');
  assert.equal(f.execs.length, 0);
});

test('an account name that is not a plain POSIX name is never written into the elevated script', () => {
  assert.equal(safeOperatorName('rom'), 'rom');
  assert.equal(safeOperatorName("rom'; rm -rf / #"), null);
  assert.equal(safeOperatorName('Robin Smith'), null);
  assert.equal(safeOperatorName(null), null);
  assert.equal(linuxElevatedScript('/tmp/x/install.sh', null), "#!/bin/sh\nset -e\n/bin/sh '/tmp/x/install.sh'\n");
  assert.throws(() => linuxElevatedScript("/tmp/it's/install.sh", 'rom'));
});

test('Linux operator: pkexec runs tailscale set for this account, refusals typed with the sudo line', async () => {
  const calls: { file: string; args: string[] }[] = [];
  const deps = (code: number) => ({
    exec: async (file: string, args: string[]) => { calls.push({ file, args }); return { code, stdout: '', stderr: '' }; },
    findBinary: () => '/usr/bin/pkexec',
    username: () => 'rom',
  });
  assert.deepEqual(await allowTailscaleOperator(deps(0), '/usr/bin/tailscale'), { ok: true });
  assert.deepEqual(calls[0], { file: '/usr/bin/pkexec', args: ['/usr/bin/tailscale', 'set', '--operator=rom'] });
  const cancelled = await allowTailscaleOperator(deps(126), '/usr/bin/tailscale');
  assert.deepEqual(cancelled, { ok: false, reason: 'cancelled', command: 'sudo tailscale set --operator=$USER', detail: null });
  const noPkexec = await allowTailscaleOperator({ ...deps(0), findBinary: () => null }, '/usr/bin/tailscale');
  assert.equal(!noPkexec.ok && noPkexec.reason, 'elevation_unavailable');
});

test('the package index: one file name per OS and CPU, nothing that could leave the directory', () => {
  assert.equal(packageFromIndex(INDEX, 'darwin', 'arm64'), 'Tailscale-1.104.2-macos.pkg');
  assert.equal(packageFromIndex(INDEX, 'win32', 'x64'), 'tailscale-setup-1.104.2-amd64.msi');
  assert.equal(packageFromIndex(INDEX, 'win32', 'ia32'), 'tailscale-setup-1.104.2-x86.msi');
  assert.equal(packageFromIndex({ MacZips: { 'universal-package': '../../evil.pkg' } }, 'darwin', 'x64'), null);
  assert.equal(packageFromIndex({ MSIs: { amd64: 'setup.exe' } }, 'win32', 'x64'), null);
  assert.equal(packageFromIndex(INDEX, 'linux', 'x64'), null);
});

test('checksums, hosts and signatures', () => {
  assert.equal(parseSha256File(`${'A'.repeat(64)}  file.msi\n`), 'a'.repeat(64));
  assert.equal(parseSha256File('<html>'), null);
  assert.equal(isOfficialUrl('https://pkgs.tailscale.com/stable/x.pkg'), true);
  assert.equal(isOfficialUrl('http://pkgs.tailscale.com/stable/x.pkg'), false);
  assert.equal(isOfficialUrl('https://pkgs.tailscale.com.evil.example/x.pkg'), false);
  assert.equal(pkgSignedByTailscale(PKG_SIGNED), true);
  assert.equal(pkgSignedByTailscale(PKG_SIGNED.replace(/Status:.*/, 'Status: no signature')), false);
  assert.equal(msiSignedByTailscale(MSI_SIGNED), true);
  assert.equal(msiSignedByTailscale(JSON.stringify({ Status: 'Valid', Subject: 'CN=Tailscale Inc. Fake Ltd, O=Fake' })), false);
  assert.equal(msiSignedByTailscale('not json'), false);
  // The temp path is quoted for PowerShell, a quote in it cannot close the literal.
  assert.match(authenticodeScript("C:\\Users\\O'Brien\\x.msi"), /-LiteralPath 'C:\\Users\\O''Brien\\x\.msi'/);
});

test('the commands to copy: no Homebrew on macOS, winget on Windows, the vendor script under sudo on Linux', () => {
  assert.doesNotMatch(tailscaleManualInstallCommand('darwin'), /brew/);
  assert.match(tailscaleManualInstallCommand('darwin'), /pkgs\.tailscale\.com.*sudo installer -pkg/);
  assert.match(tailscaleManualInstallCommand('win32'), /^winget install .*tailscale\.tailscale$/);
  assert.equal(tailscaleManualInstallCommand('linux'), 'curl -fsSL https://tailscale.com/install.sh | sudo sh');
  // The elevation is the command's, never left to what the script does inside.
  assert.match(tailscaleManualInstallCommand('linux'), /\| sudo sh$/);
});
