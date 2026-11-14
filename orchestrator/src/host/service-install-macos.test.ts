/**
 * macOS LaunchDaemon (backlog #141, volet 3). No test runs launchctl, sudo or
 * osascript: `exec` is a recorder, `/Library/LaunchDaemons` a temporary
 * directory, and what root would run is read as a script.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExecResult } from './types.js';
import {
  MACOS_LABEL, claudeTokenMarkerPath, installPreflight, installService, launchDaemonPath, macosLauncherPath, plistPath,
  readServiceDefinition, removeServiceDefinition, renderLaunchDaemonPlist, renderMacElevatedScript,
  renderMacLauncher, restoreServiceDefinition, shQuote, statusService, uninstallService, type ServiceOpts,
} from './service-install.js';
import { writeServiceSessionMode } from './service-session-mode.js';

type Call = { name: string; args: string[] };

/** A macOS host whose administrator prompt answers `steps` (label → code). */
function mac(opts: { token?: boolean; steps?: Record<string, number>; exec?: (c: Call) => ExecResult | undefined } = {}) {
  const homeDir = mkdtempSync(join(tmpdir(), "timon-mac-o'test-"));
  const calls: Call[] = [];
  const killed: number[] = [];
  const o: ServiceOpts = {
    platform: 'darwin',
    homeDir,
    timonHome: join(homeDir, '.timon'),
    installDir: join(homeDir, 'Timon App', 'orchestrator'),
    userName: 'tester',
    uid: 501,
    heapMb: 4096,
    port: 3010,
    nodePath: '/Applications/Timon.app/Contents/MacOS/Timon',
    launchDaemonsDir: join(homeDir, 'LaunchDaemons'),
    elevation: 'osascript',
    pause: () => {},
    kill: (pid) => { killed.push(pid); },
    exec: (name, args) => {
      const call = { name, args };
      calls.push(call);
      const own = opts.exec?.(call);
      if (own) return own;
      if (name === 'osascript' || name === 'sudo') {
        const out = Object.entries(opts.steps ?? {}).map(([label, code]) => `TIMON-STEP ${label}=${code}\n`).join('');
        return { code: 0, stdout: out, stderr: '' };
      }
      if (name === 'launchctl' && args[0] === 'print') return { code: 113, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    },
  };
  if (opts.token) {
    mkdirSync(dirname(claudeTokenMarkerPath(o.timonHome)), { recursive: true });
    writeFileSync(claudeTokenMarkerPath(o.timonHome), 'configured\n');
  }
  return { o, calls, killed };
}

const INSTALLED = { write: 0, 'bootout-agent': 113, bootout: 113, wait: 0, bootstrap: 0 };
const elevated = (calls: Call[]) => calls.filter((c) => c.name === 'osascript' || c.name === 'sudo');
const scriptOf = (call: Call) => (call.name === 'sudo' ? call.args[2]! : call.args[6]!);

test('the LaunchDaemon plist names the user and an explicit environment', () => {
  const { o } = mac();
  const xml = renderLaunchDaemonPlist(o);
  assert.match(xml, /<key>UserName<\/key><string>tester<\/string>/);
  for (const key of ['HOME', 'USER', 'LOGNAME', 'PATH', 'TIMON_HOME']) assert.match(xml, new RegExp(`<key>${key}</key>`));
  assert.match(xml, /<key>TIMON_SERVICE_KIND<\/key><string>launchd-system<\/string>/);
  assert.match(xml, /<key>KeepAlive<\/key><true\/>/);
  assert.match(xml, /<key>RunAtLoad<\/key><true\/>/);
  assert.ok(xml.includes(`<string>${macosLauncherPath(o.timonHome)}</string>`));
  assert.ok(xml.includes(join(o.homeDir, '.local', 'bin')));
  // Nothing release-specific: an update must not need a new plist, hence no prompt.
  assert.ok(!xml.includes(o.installDir));
  assert.ok(!xml.includes('StandardOutPath'));
  assert.equal(launchDaemonPath(), `/Library/LaunchDaemons/${MACOS_LABEL}.plist`);
});

test('the launcher logs to daemon.log and execs the daemon, and parses as sh', () => {
  const { o } = mac();
  const sh = renderMacLauncher({ ...o, environment: { ELECTRON_RUN_AS_NODE: '1', PATH: '/custom/bin:/usr/bin' } });
  assert.ok(sh.includes(`exec >>${shQuote(join(o.timonHome, 'tmp', 'daemon.log'))} 2>&1`));
  assert.match(sh, /export ELECTRON_RUN_AS_NODE='1'/);
  assert.match(sh, /export PATH='\/custom\/bin:\/usr\/bin'/);
  assert.match(sh, /^exec '\/Applications\/Timon\.app\/Contents\/MacOS\/Timon' --max-old-space-size=4096 /m);
  assert.equal(spawnSync('sh', ['-n'], { input: sh }).status, 0);
  assert.throws(() => renderMacLauncher({ ...o, environment: { 'BAD NAME': 'x' } }));
  assert.throws(() => renderMacLauncher({ ...o, nodePath: '/a\nb' }));
});

test('shQuote survives quotes and refuses line breaks', () => {
  const value = `it's "$HOME" \`x\``;
  assert.equal(spawnSync('sh', ['-c', `printf %s ${shQuote(value)}`], { encoding: 'utf8' }).stdout, value);
  assert.throws(() => shQuote('a\nb'));
});

test('without a claude token the LaunchAgent stays, with no administrator prompt', () => {
  const { o, calls } = mac();
  const res = installService(o);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.ok(existsSync(plistPath(o.homeDir)));
  assert.equal(elevated(calls).length, 0);
  assert.ok(calls.some((c) => c.args[0] === 'bootstrap' && c.args[1] === 'gui/501'));
  assert.match(res.lines.join('\n'), /session-mode always/);
});

test('the user chose the session: a claude token does not raise the LaunchDaemon', () => {
  const { o, calls } = mac({ token: true });
  const res = installService({ ...o, sessionMode: 'session' });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.ok(existsSync(plistPath(o.homeDir)));
  assert.equal(elevated(calls).length, 0, 'no administrator prompt for an agent');
  assert.equal(statusService(o).offSession, false, 'an agent stops with the login session');
});

test('the user chose to keep running logged out: the LaunchDaemon, even before any claude token', () => {
  const { o, calls } = mac({ steps: INSTALLED });
  const res = installService({ ...o, sessionMode: 'always' });
  assert.equal(res.ok, true, res.lines.join('\n'));
  const prompts = elevated(calls);
  assert.equal(prompts.length, 1);
  assert.ok(scriptOf(prompts[0]!).includes(renderLaunchDaemonPlist(o).trim()), 'root writes the LaunchDaemon');
  // What root wrote, on a real Mac.
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  const status = statusService(o);
  assert.equal(status.offSession, true);
  assert.match(status.lines.join('\n'), /logged out: keeps running/);
});

test('the recorded answer is read when the caller passes none (the desktop upgrade runner)', () => {
  const { o, calls } = mac({ token: true });
  writeServiceSessionMode(o.timonHome, 'session');
  assert.equal(installService(o).ok, true);
  assert.equal(elevated(calls).length, 0);
});

test('with a token: one prompt migrates the LaunchAgent to a LaunchDaemon', () => {
  const { o, calls } = mac({ token: true, steps: INSTALLED });
  mkdirSync(dirname(plistPath(o.homeDir)), { recursive: true });
  writeFileSync(plistPath(o.homeDir), '<plist>agent</plist>');
  const res = installService(o);
  assert.equal(res.ok, true, res.lines.join('\n'));
  const prompts = elevated(calls);
  assert.equal(prompts.length, 1);
  const script = scriptOf(prompts[0]!);
  assert.equal(spawnSync('sh', ['-n'], { input: script }).status, 0);
  // Written as root from the script itself, never copied from a user-owned file.
  assert.ok(script.includes(renderLaunchDaemonPlist(o).trim()));
  assert.match(script, /chown root:wheel .* && chmod 644 /);
  const order = ['bootout gui/501', 'bootout system/com.timon.daemon', 'launchctl print', 'bootstrap system'].map((needle) => script.replace(/'/g, '').indexOf(needle));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]!)), order.join(','));
  assert.equal(existsSync(plistPath(o.homeDir)), false, 'the agent file goes once the daemon is loaded');
  const launcher = macosLauncherPath(o.timonHome);
  assert.equal(statSync(launcher).mode & 0o777, 0o700);
  assert.ok(readFileSync(launcher, 'utf8').includes(shQuote(join(o.installDir, 'dist', 'boot.js'))));
  assert.match(res.lines.join('\n'), /LaunchDaemon/);
});

test('a refused prompt changes nothing: the agent keeps running, no launcher is left', () => {
  const { o, calls } = mac({ token: true, exec: (c) => (c.name === 'osascript' ? { code: 1, stdout: '', stderr: 'execution error: User canceled. (-128)' } : undefined) });
  mkdirSync(dirname(plistPath(o.homeDir)), { recursive: true });
  writeFileSync(plistPath(o.homeDir), '<plist>agent</plist>');
  const res = installService(o);
  assert.equal(res.ok, false);
  assert.equal(res.written, false);
  assert.match(res.reason!, /refused/);
  assert.equal(readFileSync(plistPath(o.homeDir), 'utf8'), '<plist>agent</plist>');
  assert.equal(existsSync(macosLauncherPath(o.timonHome)), false);
  assert.ok(!calls.some((c) => c.name === 'launchctl' && c.args[0] === 'bootout'));
});

test('an update with the same plist restarts the daemon without any prompt', () => {
  const { o, calls, killed } = mac({ token: true, exec: (c) => (c.name === 'launchctl' && c.args[0] === 'print'
    ? { code: 0, stdout: 'system/com.timon.daemon = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' } : undefined) });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  const res = installService({ ...o, installDir: join(o.homeDir, 'release-2', 'orchestrator') });
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(elevated(calls).length, 0);
  assert.deepEqual(killed, [4242]);
  assert.ok(readFileSync(macosLauncherPath(o.timonHome), 'utf8').includes('release-2'));
});

test('token removed: reinstalling goes back to the LaunchAgent', () => {
  const { o, calls } = mac({ steps: { bootout: 0, wait: 0, remove: 0 } });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  const res = installService(o);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.match(scriptOf(elevated(calls)[0]!), /bootout 'system\/com\.timon\.daemon'[\s\S]*rm -f /);
  assert.ok(existsSync(plistPath(o.homeDir)));
});

test('status names the kind and warns about a LaunchDaemon without token', () => {
  const { o } = mac();
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  const res = statusService(o);
  assert.equal(res.installed, true);
  assert.match(res.lines.join('\n'), /LaunchDaemon/);
  assert.match(res.lines.join('\n'), /no claude token/);
});

test('uninstall removes the LaunchDaemon, its launcher and the agent, never TIMON_HOME', () => {
  const { o, calls } = mac({ token: true, steps: { bootout: 0, wait: 0, remove: 0 } });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  mkdirSync(dirname(macosLauncherPath(o.timonHome)), { recursive: true });
  writeFileSync(macosLauncherPath(o.timonHome), '#!/bin/sh\n');
  const res = uninstallService(o);
  assert.equal(res.ok, true, res.lines.join('\n'));
  assert.equal(elevated(calls).length, 1);
  assert.equal(existsSync(macosLauncherPath(o.timonHome)), false);
  assert.ok(existsSync(o.timonHome));
  // A refused prompt is not reported as an uninstall.
  const refused = mac({ exec: (c) => (c.name === 'osascript' ? { code: 1, stdout: '', stderr: '(-128)' } : undefined) });
  mkdirSync(refused.o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(refused.o.launchDaemonsDir), '<plist/>');
  assert.equal(uninstallService(refused.o).ok, false);
});

test('a failed upgrade from a LaunchAgent removes the LaunchDaemon and restores the agent', () => {
  const { o, calls } = mac({ token: true, steps: { bootout: 0, wait: 0, remove: 0 } });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  const restored = restoreServiceDefinition(o, '<plist>agent</plist>');
  assert.equal(restored.ok, true, restored.lines.join('\n'));
  assert.equal(readFileSync(plistPath(o.homeDir), 'utf8'), '<plist>agent</plist>');
  assert.equal(elevated(calls).length, 1);
  assert.ok(calls.some((c) => c.args[0] === 'bootstrap' && c.args[1] === 'gui/501'));
});

test('a LaunchDaemon definition round-trips through read and restore, launcher included', () => {
  const { o, calls, killed } = mac({ token: true, exec: (c) => (c.name === 'launchctl' && c.args[0] === 'print'
    ? { code: 0, stdout: '\tpid = 7\n', stderr: '' } : undefined) });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), renderLaunchDaemonPlist(o));
  mkdirSync(dirname(macosLauncherPath(o.timonHome)), { recursive: true });
  writeFileSync(macosLauncherPath(o.timonHome), 'old launcher\n');
  const saved = readServiceDefinition(o)!;
  writeFileSync(macosLauncherPath(o.timonHome), 'new launcher\n');
  const restored = restoreServiceDefinition(o, saved);
  assert.equal(restored.ok, true, restored.lines.join('\n'));
  assert.equal(readFileSync(macosLauncherPath(o.timonHome), 'utf8'), 'old launcher\n');
  assert.equal(elevated(calls).length, 0);
  assert.deepEqual(killed, [7]);
  // And with nothing to restore, it is removed under one prompt.
  const removal = mac({ steps: { bootout: 0, wait: 0, remove: 0 } });
  mkdirSync(removal.o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(removal.o.launchDaemonsDir), '<plist/>');
  assert.equal(removeServiceDefinition(removal.o).ok, true);
  assert.equal(elevated(removal.calls).length, 1);
});

test('the elevated script stops at a failed write and never runs a later step', () => {
  const script = renderMacElevatedScript([
    { label: 'write', command: 'exit 3', stopOnFailure: true },
    { label: 'bootstrap', command: 'echo should-not-run' },
  ]);
  const out = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /TIMON-STEP write=3/);
  assert.ok(!out.stdout.includes('should-not-run'));
});

test('in a terminal the prompt goes through sudo', () => {
  const { o, calls } = mac({ token: true, steps: INSTALLED });
  assert.equal(installService({ ...o, elevation: 'sudo' }).ok, true);
  const sudo = elevated(calls)[0]!;
  assert.equal(sudo.name, 'sudo');
  assert.deepEqual(sudo.args.slice(0, 2), ['/bin/sh', '-c']);
});

test('a refused bootstrap rolls back: daemon removed, launcher and LaunchAgent restored and relaunched', () => {
  for (const failure of [{ ...INSTALLED, bootstrap: 5, rollback: 0 }, { ...INSTALLED, wait: 1, rollback: 0 }]) {
    const { o, calls } = mac({ token: true, steps: failure });
    mkdirSync(dirname(plistPath(o.homeDir)), { recursive: true });
    writeFileSync(plistPath(o.homeDir), '<plist>agent</plist>');
    mkdirSync(dirname(macosLauncherPath(o.timonHome)), { recursive: true });
    writeFileSync(macosLauncherPath(o.timonHome), 'old launcher\n');
    const res = installService(o);
    assert.equal(res.ok, false);
    assert.equal(res.written, false, 'everything is back: an upgrade must not restore (and prompt) again');
    assert.match(res.reason!, /previous service was restored/);
    assert.equal(readFileSync(plistPath(o.homeDir), 'utf8'), '<plist>agent</plist>');
    assert.equal(readFileSync(macosLauncherPath(o.timonHome), 'utf8'), 'old launcher\n');
    // The daemon side is undone by root before the agent starts again.
    const prompt = calls.findIndex((c) => c.name === 'osascript');
    const relaunch = calls.findIndex((c) => c.name === 'launchctl' && c.args[0] === 'bootstrap' && c.args[1] === 'gui/501');
    assert.ok(prompt >= 0 && relaunch > prompt, `${prompt} < ${relaunch}`);
    assert.match(scriptOf(calls[prompt]!), /rc_bootstrap:-1[\s\S]*bootout 'system\/com\.timon\.daemon'[\s\S]*rm -f /);
  }
});

test('a failed rollback does not start the agent next to a daemon that may remain', () => {
  const { o, calls } = mac({ token: true, steps: { ...INSTALLED, bootstrap: 5, rollback: 1 } });
  mkdirSync(dirname(plistPath(o.homeDir)), { recursive: true });
  writeFileSync(plistPath(o.homeDir), '<plist>agent</plist>');
  const res = installService(o);
  assert.equal(res.ok, false);
  assert.notEqual(res.written, false);
  assert.match(res.reason!, /could not be restored/);
  assert.ok(!calls.some((c) => c.name === 'launchctl' && c.args[0] === 'bootstrap'));
  assert.ok(existsSync(plistPath(o.homeDir)), 'the agent file stays, the way back at the next install');
});

test('a failed upgrade from a LaunchDaemon is restored only if the previous daemon restarts', () => {
  const running = { code: 0, stdout: 'system/com.timon.daemon = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' };
  const cases: { name: string; print: ExecResult; kill: boolean; restored: boolean }[] = [
    { name: 'restarted', print: running, kill: true, restored: true },
    { name: 'kill fails', print: running, kill: false, restored: false },
    { name: 'job not found', print: { code: 113, stdout: '', stderr: '' }, kill: true, restored: false },
  ];
  for (const c of cases) {
    const { o, calls } = mac({
      token: true,
      steps: { ...INSTALLED, bootstrap: 5, rollback: 0 },
      exec: (call) => (call.name === 'launchctl' && call.args[0] === 'print' ? c.print : undefined),
    });
    if (!c.kill) o.kill = () => { throw new Error('EPERM'); };
    mkdirSync(o.launchDaemonsDir!, { recursive: true });
    writeFileSync(launchDaemonPath(o.launchDaemonsDir), '<plist>old daemon</plist>');
    const res = installService(o);
    assert.equal(res.ok, false, c.name);
    if (c.restored) {
      assert.equal(res.written, false, c.name);
      assert.match(res.reason!, /previous service was restored/, c.name);
    } else {
      assert.notEqual(res.written, false, c.name);
      assert.match(res.reason!, /could not be restored/, c.name);
    }
    assert.ok(!calls.some((x) => x.name === 'launchctl' && x.args[0] === 'bootstrap'), c.name);
  }
});

test('a failed upgrade from a LaunchDaemon with a leftover agent plist relaunches the daemon only', () => {
  const { o, calls, killed } = mac({
    token: true,
    steps: { ...INSTALLED, bootstrap: 5, rollback: 0 },
    exec: (c) => (c.name === 'launchctl' && c.args[0] === 'print'
      ? { code: 0, stdout: 'system/com.timon.daemon = {\n\tstate = running\n\tpid = 4242\n}', stderr: '' } : undefined),
  });
  mkdirSync(o.launchDaemonsDir!, { recursive: true });
  writeFileSync(launchDaemonPath(o.launchDaemonsDir), '<plist>old daemon</plist>');
  mkdirSync(dirname(plistPath(o.homeDir)), { recursive: true });
  writeFileSync(plistPath(o.homeDir), '<plist>agent</plist>');
  const res = installService(o);
  assert.equal(res.ok, false);
  assert.equal(res.written, false);
  assert.match(res.reason!, /previous service was restored/);
  assert.deepEqual(killed, [4242]);
  assert.ok(!calls.some((c) => c.name === 'launchctl' && c.args[0] === 'bootstrap'), 'the agent is not started next to the daemon');
  assert.equal(readFileSync(plistPath(o.homeDir), 'utf8'), '<plist>agent</plist>');
});

test('the root script really removes the partial LaunchDaemon when bootstrap fails', () => {
  const { o, calls } = mac({ token: true, steps: { ...INSTALLED, bootstrap: 5, rollback: 0 } });
  installService(o);
  const dir = mkdtempSync(join(tmpdir(), 'timon-launchctl-'));
  const fake = join(dir, 'launchctl');
  // bootstrap refused, nothing loaded, bootout acknowledged.
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in bootstrap) exit 5;; print) exit 1;; *) exit 0;; esac\n', { mode: 0o755 });
  const script = scriptOf(elevated(calls)[0]!)
    .replaceAll('/bin/launchctl', fake)
    .replaceAll('chown root:wheel', 'true');
  const out = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /TIMON-STEP write=0/);
  assert.match(out.stdout, /TIMON-STEP bootstrap=5/);
  assert.match(out.stdout, /TIMON-STEP rollback=0/);
  assert.equal(existsSync(launchDaemonPath(o.launchDaemonsDir)), false);
  // A successful bootstrap skips the rollback altogether.
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in print) exit 1;; *) exit 0;; esac\n', { mode: 0o755 });
  const ok = spawnSync('sh', ['-c', script], { encoding: 'utf8' });
  assert.match(ok.stdout, /TIMON-STEP bootstrap=0/);
  assert.ok(!ok.stdout.includes('rollback='));
  assert.ok(existsSync(launchDaemonPath(o.launchDaemonsDir)));
});

/** What `lsof`, `ps` and `launchctl print` answer when `listeners` hold the port and the job has `jobPid`. */
function portHeld(listeners: Record<number, string>, jobPid: number | null, loaded = jobPid !== null) {
  return (c: Call): ExecResult | undefined => {
    if (c.name === 'lsof') {
      const pids = Object.keys(listeners);
      return pids.length ? { code: 0, stdout: `${pids.join('\n')}\n`, stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (c.name === 'ps') return { code: 0, stdout: `${listeners[Number(c.args[3])] ?? ''}\n`, stderr: '' };
    if (c.name === 'launchctl' && c.args[0] === 'print' && loaded) {
      return { code: 0, stdout: jobPid !== null ? `state = running\n\tpid = ${jobPid}\n` : 'state = spawn scheduled\n', stderr: '' };
    }
    return undefined;
  };
}

const EMBEDDED = '/Applications/Timon.app/Contents/MacOS/Timon /Applications/Timon.app/Contents/Resources/orchestrator/dist/boot.js';

test('TIM-0045/0046: the install is refused while Timon.app\'s daemon holds the port, and nothing is written or prompted', () => {
  const { o, calls } = mac({ token: true, exec: portHeld({ 87183: EMBEDDED }, null) });
  const res = installPreflight(o)!;
  assert.equal(res.ok, false);
  assert.equal(res.written, false);
  assert.match(res.reason!, /port 3010 is held by a Timon daemon that is not the service \(pid 87183\)/);
  assert.match(res.reason!, /Quit Timon\.app/);
  assert.equal(elevated(calls).length, 0);
  assert.equal(existsSync(macosLauncherPath(o.timonHome)), false);
  assert.equal(existsSync(plistPath(o.homeDir)), false);
});

test('TIM-0045/0046: a job already looping on EADDRINUSE does not hide the embedded daemon', () => {
  // Job loaded and waiting to be restarted (no pid): the app is still the listener.
  const { o } = mac({ token: true, exec: portHeld({ 87183: EMBEDDED }, null, true) });
  assert.match(installPreflight(o)!.reason!, /pid 87183/);
});

test('the preflight names a foreign program, with its command', () => {
  const { o } = mac({ exec: portHeld({ 555: '/usr/local/bin/other-server --port 3010' }, null) });
  assert.match(installPreflight(o)!.reason!, /another program \(pid 555: \/usr\/local\/bin\/other-server --port 3010\)/);
});

test('the preflight lets a reinstall through when the listener is the launchd job itself', () => {
  const { o } = mac({ token: true, exec: portHeld({ 4242: EMBEDDED }, 4242) });
  assert.equal(installPreflight(o), null);
});

test('the preflight lets the install through when nobody holds the port or lsof is missing', () => {
  assert.equal(installPreflight(mac({ exec: portHeld({}, null) }).o), null);
  const missing = mac({ exec: (c) => (c.name === 'lsof' ? { code: 127, stdout: '', stderr: 'not found' } : undefined) });
  assert.equal(installPreflight(missing.o), null);
});

test('the preflight only concerns macOS', () => {
  const { o } = mac({ exec: portHeld({ 87183: EMBEDDED }, null) });
  assert.equal(installPreflight({ ...o, platform: 'linux' }), null);
  assert.equal(installPreflight({ ...o, platform: 'win32' }), null);
});

test('timon service install runs the preflight before staging the runtime', () => {
  const cli = readFileSync(join(import.meta.dirname, '..', '..', 'bin', 'timon'), 'utf8');
  const at = cli.indexOf('mod.installPreflight(opts)');
  assert.ok(at > 0, 'cmdService calls installPreflight');
  assert.ok(at < cli.indexOf('installWithRuntime(opts, cfg.daemon.installDir'), 'before installWithRuntime stages anything');
});
