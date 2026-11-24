/**
 * Onboarding actions (step 5.7.3).
 *
 * This module is the one place where a browser can cause a command to run on
 * the machine. Its tests are therefore mostly about what it REFUSES: an
 * unknown name, a command needing root, a tool that is not there. Nothing here
 * installs anything — `exec` is injected, and the service installer too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-onboarding-test-'));

const {
  checkPath,
  runInstallBinary,
  failureReason,
  runInstallService,
  foreignServiceRefusal,
  parseOnboardingAction,
  OnboardingError,
  serviceOptsForPlatform,
  stagesPackagedRuntime,
} = await import('./onboarding.js');
const { plistPath, renderPlist, renderTaskXml, renderWindowsLauncherConfig, unitPath, windowsTaskAction } = await import('./host/service-install.js');
const { packagedServiceOptions } = await import('./host/packaged-service.js');
const { installPlanFor } = await import('./host/machine.js');

const APT = { platform: 'linux' as NodeJS.Platform, packageManager: 'apt' as const };
const MAC = { platform: 'darwin' as NodeJS.Platform, packageManager: null };
const ok = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });

test('a name outside the closed list is refused before any process', async () => {
  let called = false;
  const exec = () => { called = true; return ok(); };
  await assert.rejects(
    () => runInstallBinary('curl; rm -rf ~', APT, exec),
    (e: Error) => e instanceof OnboardingError,
  );
  // And above all: nothing was run.
  assert.equal(called, false);
});

test('no string from the client reaches an argv', () => {
  // The body only carries an action name and a binary name; there is
  // no room for a command.
  assert.deepEqual(parseOnboardingAction({ action: 'install-service' }), { action: 'install-service' });
  assert.deepEqual(
    parseOnboardingAction({ action: 'install-binary', name: 'claude' }),
    { action: 'install-binary', name: 'claude' },
  );
  assert.throws(() => parseOnboardingAction({ action: 'run', command: 'rm -rf /' }));
  assert.throws(() => parseOnboardingAction({ action: 'install-binary' }));
  // The answer to "keep running when logged out?" is one of two words, nothing else.
  assert.deepEqual(parseOnboardingAction({ action: 'install-service', mode: 'always' }), { action: 'install-service', mode: 'always' });
  assert.deepEqual(parseOnboardingAction({ action: 'install-service', mode: 'session' }), { action: 'install-service', mode: 'session' });
  assert.throws(() => parseOnboardingAction({ action: 'install-service', mode: 'enable-linger root' }));

  // The argv comes from the table, never from the request.
  assert.deepEqual(installPlanFor('claude', APT)?.argv, ['npm', 'install', '-g', '@anthropic-ai/claude-code']);
});

test('an npm package is installed, and its argv goes through no shell', async () => {
  const calls: Array<[string, string[]]> = [];
  const res = await runInstallBinary('claude', APT, (c, a) => { calls.push([c, a]); return ok(); });
  assert.equal(res.ok, true);
  assert.equal(res.command, null);
  assert.deepEqual(calls, [['npm', ['install', '-g', '@anthropic-ai/claude-code']]]);
});

test('Node is installed automatically in the macOS account, without Homebrew', async () => {
  let genericExecCalled = false;
  let internalCalled = false;
  const res = await runInstallBinary(
    'node',
    MAC,
    () => { genericExecCalled = true; return ok(); },
    async () => { internalCalled = true; return ['Node.js installed in ~/.local']; },
  );
  assert.equal(res.ok, true);
  assert.equal(internalCalled, true);
  assert.equal(genericExecCalled, false);
  assert.equal(res.command, null);
});

test('Codex uses the official standalone installer on macOS', async () => {
  const calls: Array<[string, string[]]> = [];
  const res = await runInstallBinary('codex', MAC, (c, a) => { calls.push([c, a]); return ok(); });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [[
    '/bin/sh',
    ['-c', 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'],
  ]]);
});

/**
 * The maintainer's decision: what cannot be run is SHOWN. A `sudo`
 * launched by a daemon would wait for a password nobody sees.
 */
test('a privileged command is shown, never run', async () => {
  let called = false;
  const res = await runInstallBinary('git', APT, () => { called = true; return ok(); });
  assert.equal(called, false);
  assert.equal(res.ok, false);
  assert.equal(res.command, 'sudo apt-get install -y git');
  assert.match(res.reason ?? '', /administrator rights/);
});

test('a machine without a known command says so, without inventing', async () => {
  const res = await runInstallBinary('git', { platform: 'linux', packageManager: null }, () => ok());
  assert.equal(res.ok, false);
  assert.equal(res.command, null);
  assert.match(res.reason ?? '', /no install command known/);
});

test('a missing tool is a reason to show, not an exception', async () => {
  const res = await runInstallBinary('claude', APT, () => Promise.reject(new Error('binary « npm » not found in PATH'))); // french-ok: sample error text with French quotes
  assert.equal(res.ok, false);
  assert.equal(res.command, 'npm install -g @anthropic-ai/claude-code');
  assert.match(res.reason ?? '', /npm/);
});

test('an install failure reports the reason and the command', async () => {
  const res = await runInstallBinary('claude', APT, () => Promise.resolve({ code: 1, stdout: '', stderr: 'EACCES: permission denied' }));
  assert.equal(res.ok, false);
  assert.equal(res.command, 'npm install -g @anthropic-ai/claude-code');
  assert.match(res.reason ?? '', /EACCES/);
});

test('the installed service returns ok, without a fallback command', () => {
  const res = runInstallService({} as never, () => ({ ok: true, lines: ['service installed'] }));
  assert.equal(res.ok, true);
  assert.equal(res.command, null);
  assert.deepEqual(res.lines, ['service installed']);
  assert.equal(res.sessionFallback, undefined);
});

test('#116: a Windows service kept for the session only is said to the route that installed it', () => {
  const res = runInstallService({} as never, () => ({ ok: true, lines: ['service installed', 'it stops at logout'], sessionFallback: true }));
  assert.equal(res.ok, true);
  assert.equal(res.sessionFallback, true);
  assert.deepEqual(res.lines, ['service installed', 'it stops at logout']);
});

/**
 * The case named in the brief: `loginctl enable-linger` behind polkit. The
 * refusal of the tool is what is shown: it says more than any sentence
 * one would write around it.
 */
test('a refused service returns the reason without assuming the CLI installed', () => {
  const res = runInstallService({} as never, () => ({
    ok: false,
    lines: ['loginctl enable-linger rom → 1', 'systemctl refused: Interactive authentication required.'],
  }));
  assert.equal(res.ok, false);
  assert.equal(res.command, null);
  assert.match(res.reason ?? '', /Interactive authentication required/);
});

test('an installer that throws exposes the reason without a made-up command', () => {
  const res = runInstallService({} as never, () => { throw new Error('systemd template not found'); });
  assert.equal(res.ok, false);
  assert.equal(res.command, null);
  assert.match(res.reason ?? '', /template not found/);
});

/**
 * `host.exec` is `spawnSync`: an `npm install -g` behind it would freeze the
 * event loop of the daemon (HTTP, SSE, agents) for the length of the
 * install. The path must stay asynchronous end to end.
 */
test('installing a prerequisite does not freeze the event loop', async () => {
  let ticked = false;
  setImmediate(() => { ticked = true; });
  const pending = runInstallBinary('claude', APT, () => new Promise((resolve) => {
    setTimeout(() => resolve({ code: 0, stdout: '', stderr: '' }), 20);
  }));
  // If the call were synchronous, nothing else could have run by then.
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(ticked, true, 'the loop kept turning during the install');
  assert.equal((await pending).ok, true);
});

/**
 * `check-path` (step 5.9.4): a `stat`, nothing else. No listing, no
 * creation, no command. It exists so that the user learns NOW
 * that a path is wrong, and not three weeks later when an agent does not
 * start.
 */
test('an existing path is confirmed, a wrong path is named', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'timon-checkpath-'));
  const okRes = checkPath(dir);
  assert.equal(okRes.ok, true);
  assert.equal(okRes.lines[0], dir);

  const missing = checkPath(join(dir, 'nowhere'));
  assert.equal(missing.ok, false);
  assert.match(missing.reason ?? '', /does not exist/);

  // A file is not a projects folder.
  const file = join(dir, 'a-file');
  writeFileSync(file, 'x');
  const notDir = checkPath(file);
  assert.equal(notDir.ok, false);
  assert.match(notDir.reason ?? '', /not a directory/);
});

test('check-path classifies the errno, quotes it in the message and logs it (#198)', () => {
  const failing = (code?: string) => () => { throw Object.assign(new Error(code ?? 'boom'), code ? { code } : {}); };
  const logged: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { logged.push(args.join(' ')); };
  try {
    const cases: Array<[string | undefined, RegExp]> = [
      ['EPERM', /refused access to this folder \(EPERM\)/],
      ['EACCES', /refused access to this folder \(EACCES\)/],
      ['ENOENT', /does not exist yet \(ENOENT\)/],
      ['ENOTDIR', /not a directory \(ENOTDIR\)/],
      ['EIO', /cannot be read \(EIO\)/],
      [undefined, /cannot be read \(unknown error\)/],
    ];
    for (const [code, expected] of cases) {
      logged.length = 0;
      const res = checkPath('/a/b', failing(code), 'linux');
      assert.equal(res.ok, false);
      assert.match(res.reason ?? '', expected);
      assert.deepEqual(logged, [`[onboarding] check-path /a/b → ${code ?? 'unknown error'}`]);
    }
  } finally {
    console.warn = original;
  }
});

test('check-path: the macOS permissions are only a lead, never an asserted cause (#198)', () => {
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
  const original = console.warn;
  console.warn = () => {};
  try {
    const mac = checkPath('/Users/me/Documents/projets', denied, 'darwin').reason ?? '';
    assert.match(mac, /EPERM/);
    assert.match(mac, /Privacy & Security/);
    assert.match(mac, /one place to check/);
    assert.doesNotMatch(mac, /does not exist/);
    const linux = checkPath('/home/me/projets', denied, 'linux').reason ?? '';
    assert.match(linux, /EPERM/);
    assert.doesNotMatch(linux, /macOS|Privacy/);
  } finally {
    console.warn = original;
  }
});

test('a path with a space and an accent, composed or decomposed (NFC/NFD), is recognised (#198)', async () => {
  const { mkdirSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'timon-198-'));
  try {
    // One parent per variant: a volume that compares names Unicode-normalised
    // would otherwise raise EEXIST on the second form before checkPath runs.
    for (const [index, name] of ['timon projects', 'projets é'.normalize('NFC'), 'projets é'.normalize('NFD')].entries()) { // french-ok: an accented folder name
      const parent = join(dir, `case-${index}`);
      mkdirSync(parent);
      const created = join(parent, name);
      mkdirSync(created);
      const action = parseOnboardingAction(JSON.parse(JSON.stringify({ action: 'check-path', path: ` ${created} ` })));
      assert.equal(action.action, 'check-path');
      const res = checkPath((action as { path: string }).path);
      assert.equal(res.ok, true, name);
      assert.equal(res.lines[0], created);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a relative or empty path is refused, never guessed', async () => {
  assert.equal(checkPath('').ok, false);
  const relative = checkPath('projets');
  assert.equal(relative.ok, false);
  assert.match(relative.reason ?? '', /absolute/);
});

test('the ~ is expanded the way the daemon will', async () => {
  const { homedir } = await import('node:os');
  const res = checkPath('~');
  assert.equal(res.ok, true);
  assert.equal(res.lines[0], homedir());
});

test('check-path only accepts a string, and stays a named action', () => {
  assert.deepEqual(parseOnboardingAction({ action: 'check-path', path: '/tmp' }), {
    action: 'check-path', path: '/tmp',
  });
  assert.throws(() => parseOnboardingAction({ action: 'check-path' }));
  assert.throws(() => parseOnboardingAction({ action: 'check-path', path: 42 }));
});

test('a real service identity refusal reaches onboarding without a CLI workaround', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-onboarding-conflict-'));
  const calls: string[][] = [];
  const result = runInstallService({
    platform: 'linux', homeDir, timonHome: join(homeDir, 'app-data'),
    installDir: join(homeDir, 'app/orchestrator'), userName: 'tester', uid: 1000,
    heapMb: 2048, port: 3010, nodePath: '/usr/bin/node',
    exec: (name, args) => {
      calls.push([name, ...args]);
      return { code: 0, stderr: '', stdout:
        `LoadState=loaded\nNeedDaemonReload=no\nActiveState=active\nEnvironment=TIMON_HOME=${homeDir}/dev-data\nWorkingDirectory=${homeDir}/dev/orchestrator` };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.command, null);
  assert.match(result.reason ?? '', /another installation or data directory/);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('show'));
});

test('Windows setup discovers a custom npm prefix immediately and durably', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { whichBin } = await import('./doctor.js');
  const { CONFIG_FILE } = await import('./config/load.js');
  const { existsSync } = await import('node:fs');
  const prefix = mkdtempSync(join(tmpdir(), 'timon-npm-prefix-'));
  const shim = join(prefix, 'codex.cmd');
  const calls: Array<[string, string[]]> = [];
  try {
    const result = await runInstallBinary('codex', { platform: 'win32', packageManager: null }, async (command, args) => {
      calls.push([command, args]);
      if (args[0] === 'install') {
        mkdirSync(prefix, { recursive: true });
        writeFileSync(shim, '@echo off');
        return { code: 0, stdout: '', stderr: '' };
      }
      assert.deepEqual(args, ['prefix', '-g']);
      return { code: 0, stdout: `${prefix}\r\n`, stderr: '' };
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2);
    assert.equal(whichBin('codex', {}, { platform: 'win32', path: '', homeDir: prefix }).path, shim);
    assert.equal(existsSync(CONFIG_FILE), false, 'discovery must not finish first-run setup');
    const { readFileSync } = await import('node:fs');
    assert.equal(JSON.parse(readFileSync(join(process.env.TIMON_HOME!, 'installed-binaries.json'), 'utf8')).codex, shim);
    assert.deepEqual(whichBin('codex', { codex: join(prefix, 'missing.cmd') }, { platform: 'win32' }), { path: null, pinned: true });
  } finally {
    rmSync(prefix, { recursive: true, force: true });
  }
});

test('Windows npm failures and missing output never record a successful installation', async () => {
  const { readInstalledBinaries } = await import('./host/binary-path.js');
  const before = readInstalledBinaries();
  for (const prefixResult of [
    { code: 1, stdout: '', stderr: 'failed' },
    { code: 0, stdout: 'relative', stderr: '' },
    { code: 0, stdout: join(process.env.TIMON_HOME!, 'absent-prefix'), stderr: '' },
  ]) {
    const result = await runInstallBinary('codex', { platform: 'win32', packageManager: null }, async (_command, args) =>
      args[0] === 'install' ? { code: 0, stdout: '', stderr: '' } : prefixResult);
    assert.equal(result.ok, false);
    assert.match(result.reason!, /Installation finished, but/);
    assert.deepEqual(readInstalledBinaries(), before);
  }
  let calls = 0;
  const result = await runInstallBinary('codex', { platform: 'win32', packageManager: null }, async () => {
    calls++;
    return { code: 1, stdout: '', stderr: 'install failed' };
  });
  assert.equal(result.ok, false);
  assert.equal(calls, 1);
  assert.deepEqual(readInstalledBinaries(), before);
});

// Guard for desktop/src/upgrade.ts: its migration skips Windows because the
// logon task runs the installation directory. If Windows ever starts running a
// staged copy, this test must fail until the migration covers it too.
test('packaged windows: the service launches the install folder, never a copy under desktop-runtime/releases', () => {
  const installDir = 'C:\\Program Files\\Timon\\resources\\orchestrator';
  const executable = 'C:\\Program Files\\Timon\\resources\\node\\node.exe';
  const base = {
    platform: 'win32' as NodeJS.Platform,
    homeDir: 'C:\\Users\\sam',
    timonHome: 'C:\\Users\\sam\\.timon',
    installDir,
    userName: 'sam',
    uid: 0,
    heapMb: 4096,
    port: 3001,
    nodePath: executable,
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
  };
  for (const env of [{ TIMON_DESKTOP_EMBEDDED: '1' }, { TIMON_DESKTOP_SERVICE: '1' }]) {
    assert.equal(stagesPackagedRuntime('win32', env), false);
    const opts = serviceOptsForPlatform(base, env, executable, 3101);
    assert.equal(opts.installDir, installDir);
    assert.equal(opts.nodePath, executable);
    const launcher = JSON.parse(renderWindowsLauncherConfig(opts)) as { node: string; env: Record<string, string> };
    for (const text of [JSON.stringify(launcher), JSON.stringify(windowsTaskAction(opts, true)), JSON.stringify(windowsTaskAction(opts, false)), renderTaskXml(opts)]) {
      assert.doesNotMatch(text, /desktop-runtime|releases/);
    }
    assert.equal(launcher.node, executable);
    assert.equal(windowsTaskAction(opts, false).command, 'C:\\Program Files\\Timon\\Timon.exe');
    // Packaged like the macOS and Linux services: update approval and routes.
    assert.equal(launcher.env.TIMON_DESKTOP_SERVICE, '1');
    assert.equal(launcher.env.TIMON_DESKTOP_EMBEDDED, '0');
  }
  // `timon service install` from a plain shell is no packaged daemon.
  assert.equal(serviceOptsForPlatform(base, {}, executable, 3101).environment, undefined);
  // The same packaged environment does stage a copy on macOS and Linux.
  for (const platform of ['linux', 'darwin'] as NodeJS.Platform[]) {
    assert.equal(stagesPackagedRuntime(platform, { TIMON_DESKTOP_SERVICE: '1' }), true);
    const opts = serviceOptsForPlatform({ ...base, platform, homeDir: '/home/sam', timonHome: '/home/sam/.timon' }, { TIMON_DESKTOP_SERVICE: '1' }, '/opt/Timon/timon', 3101);
    assert.match(opts.installDir, /desktop-runtime/);
  }
});

test('TIM-0022: a failed install says why, even when the tool writes on stdout', () => {
  const agreement = 'The msstore source requires that you view the following agreements before using.\r\n  -\\|/ \r\n';
  assert.equal(failureReason({ code: 1, stdout: agreement, stderr: '' }),
    'The msstore source requires that you view the following agreements before using. (exit 1)');
  assert.equal(failureReason({ code: 1, stdout: 'ok', stderr: 'npm ERR! EACCES\n' }), 'npm ERR! EACCES (exit 1)');
  assert.equal(failureReason({ code: 2, stdout: '', stderr: '' }), 'exit 2');
});

test('the install button refuses the service of another installation, and its own passes (TODO #734)', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-onboarding-owner-'));
  const installDir = join(homeDir, 'app', 'orchestrator');
  const exec = () => ({ code: 0, stdout: '', stderr: '' });
  const opts = {
    platform: 'darwin', homeDir, timonHome: join(homeDir, 'test-home'), installDir, userName: 'tester', uid: 501, heapMb: 4096, port: 3010,
    nodePath: '/usr/bin/node', launchDaemonsDir: join(homeDir, 'LaunchDaemons'), exec,
  };
  assert.equal(foreignServiceRefusal(opts, installDir), null, 'no service yet');

  const file = plistPath(homeDir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderPlist({ ...opts, timonHome: join(homeDir, 'real-home') }));
  const refused = foreignServiceRefusal(opts, installDir);
  assert.equal(refused?.ok, false);
  assert.equal(refused?.installed, false);
  assert.equal(refused?.command, null);
  assert.match(refused?.reason ?? '', /real-home/);
  assert.match(refused?.reason ?? '', /timon service install --force/);

  writeFileSync(file, renderPlist(opts));
  assert.equal(foreignServiceRefusal(opts, installDir), null, 'its own service');

  // Its home, but no installation named: a click must not take it over on a guess.
  writeFileSync(file, renderPlist(opts).replace(/<key>WorkingDirectory<\/key><string>[^<]*<\/string>\n?/, ''));
  assert.match(foreignServiceRefusal(opts, installDir)?.reason ?? '', /does not say which installation/);
});

// The Linux guard reads the effective unit's identity as POSIX paths; a Windows
// temporary folder (`C:\…`) leaves it unproven. That code runs on Linux only.
test('the install button of a package refuses a clone unit on its home, and only there (TODO #736)', {
  skip: process.platform === 'win32' && 'the systemd unit identity is read as POSIX paths',
}, () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'timon-onboarding-shared-'));
  const installDir = join(homeDir, 'app', 'orchestrator');
  const timonHome = join(homeDir, 'test-home');
  // What systemd answers for the unit on disk: the guard reads the effective one.
  const exec = () => {
    const text = readFileSync(unitPath(homeDir), 'utf8');
    const line = (key: string) => new RegExp(`^${key}=(.*)$`, 'm').exec(text)?.[1] ?? '';
    return { code: 0, stdout: `LoadState=loaded\nNeedDaemonReload=no\nWorkingDirectory=${line('WorkingDirectory')}\nEnvironment=${line('Environment')}\n`, stderr: '' };
  };
  const opts = packagedServiceOptions({
    platform: 'linux', homeDir, timonHome, installDir, userName: 'tester', uid: 501, heapMb: 4096, port: 3010,
    nodePath: '/usr/bin/node', exec,
  }, join(homeDir, 'Timon'), 3110, '0.2.0');
  const clone = unitPath(homeDir);
  mkdirSync(dirname(clone), { recursive: true });

  writeFileSync(clone, `[Service]\nWorkingDirectory=/srv/clone/orchestrator\nEnvironment="TIMON_HOME=${join(homeDir, 'real-home')}"\n`);
  assert.equal(foreignServiceRefusal(opts, installDir), null, 'first launch beside a clone on another home');

  writeFileSync(clone, `[Service]\nWorkingDirectory=/srv/clone/orchestrator\nEnvironment="TIMON_HOME=${timonHome}"\n`);
  const refused = foreignServiceRefusal(opts, installDir);
  assert.equal(refused?.ok, false);
  assert.equal(refused?.command, null);
  assert.match(refused?.reason ?? '', /timon-orchestrator already runs on this data directory/);
  assert.match(refused?.reason ?? '', /\/srv\/clone\/orchestrator/);
  assert.match(refused?.reason ?? '', /timon service install --force/);
});
