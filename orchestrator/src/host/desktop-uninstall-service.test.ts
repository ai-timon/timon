import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { removeDesktopService } from './desktop-uninstall-service.js';
import { launchDaemonPath, plistPath, unitPath, type ServiceOpts } from './service-install.js';

type Result = ReturnType<ServiceOpts['exec']>;
const ok = (stdout = ''): Result => ({ code: 0, stdout, stderr: '' });
const absent = (): Result => ({ code: 113, stdout: '', stderr: 'not found' });
function fixture(platform: NodeJS.Platform, execute: ServiceOpts['exec']) {
  const root = mkdtempSync(join(tmpdir(), 'timon-remove-service-test-'));
  const opts: ServiceOpts = { platform, homeDir: root, timonHome: join(root, '.timon'), installDir: join(root, 'app'),
    nodePath: process.execPath, uid: 502, userName: 'test', port: 3010, heapMb: 2048, exec: execute, pause: () => {},
    launchDaemonsDir: join(root, 'LaunchDaemons'), elevation: 'osascript' };
  const file = platform === 'darwin' ? plistPath(root) : unitPath(root);
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'test');
  mkdirSync(opts.timonHome); writeFileSync(join(opts.timonHome, 'valuable'), 'data');
  return { opts, file, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('macOS waits for launchd exit before removing its plist and preserves data', () => {
  let prints = 0; const calls: string[] = [];
  const f = fixture('darwin', (cmd, args) => {
    calls.push(`${cmd}:${args[0]}`);
    if (cmd.endsWith('plutil')) return ok(f.opts.timonHome);
    if (args[0] === 'print') return ++prints <= 3 ? ok(`\tTIMON_HOME => ${f.opts.timonHome}\n`) : absent();
    assert.equal(existsSync(f.file), true); return ok();
  });
  try {
    removeDesktopService(f.opts);
    assert.equal(prints, 4); assert.equal(existsSync(f.file), false);
    assert.equal(existsSync(join(f.opts.timonHome, 'valuable')), true);
    assert.equal(calls.includes('launchctl:bootout'), true);
  } finally { f.clean(); }
});

for (const failure of ['foreign', 'bootout', 'timeout', 'query']) test(`macOS ${failure} prevents plist deletion`, () => {
  const f = fixture('darwin', (cmd, args) => {
    if (cmd.endsWith('plutil')) return ok(failure === 'foreign' ? '/another/home' : f.opts.timonHome);
    if (args[0] === 'print') return failure === 'query' ? { code: 5, stdout: '', stderr: 'denied' } : ok(`TIMON_HOME => ${f.opts.timonHome}\n`);
    if (args[0] === 'bootout' && failure === 'bootout') return { code: 5, stdout: '', stderr: 'denied' };
    return ok();
  });
  try { assert.throws(() => removeDesktopService(f.opts)); assert.equal(existsSync(f.file), true); }
  finally { f.clean(); }
});

test('macOS: a LaunchDaemon is verified by its TIMON_HOME, then removed under one administrator prompt', () => {
  const calls: string[] = [];
  const f = fixture('darwin', (cmd, args) => {
    calls.push(`${cmd}:${args[0]}:${args[1] ?? ''}`);
    if (cmd.endsWith('plutil')) return ok(f.opts.timonHome);
    if (cmd === 'osascript') return ok('TIMON-STEP bootout=0\nTIMON-STEP wait=0\nTIMON-STEP remove=0\n');
    if (args[0] === 'print') return ok(`\tTIMON_HOME => ${f.opts.timonHome}\n`);
    if (args[0] === 'bootout') return absent();
    return ok();
  });
  try {
    rmSync(f.file);
    const daemon = launchDaemonPath(f.opts.launchDaemonsDir);
    mkdirSync(dirname(daemon), { recursive: true }); writeFileSync(daemon, 'test');
    removeDesktopService(f.opts);
    assert.ok(calls.includes('launchctl:print:system/com.timon.daemon'));
    assert.equal(calls.filter((c) => c.startsWith('osascript')).length, 1);
    assert.equal(existsSync(join(f.opts.timonHome, 'valuable')), true);
  } finally { f.clean(); }
});

test('macOS missing service is an idempotent success', () => {
  const f = fixture('darwin', () => absent());
  try { rmSync(f.file); removeDesktopService(f.opts); }
  finally { f.clean(); }
});

// The unit carries a Windows home on a Windows host, which the systemd reader
// cannot match: the Linux removal only runs on Linux.
const LINUX_UNIT = process.platform === 'win32' && 'a systemd unit is read with POSIX paths';
for (const failure of [null, 'foreign', 'stop', 'still-running', 'reload']) test(`Linux ${failure ?? 'success'} verifies the unit and shutdown`, { skip: LINUX_UNIT }, () => {
  const calls: string[] = [];
  const f = fixture('linux', (_cmd, args) => {
    calls.push(args.join(' '));
    if (args.includes('--property=LoadState,FragmentPath,Environment,NeedDaemonReload')) return ok(
      `LoadState=loaded\nFragmentPath=${f.file}\nEnvironment=TIMON_HOME=${failure === 'foreign' ? '/another/home' : f.opts.timonHome}\nNeedDaemonReload=no\n`);
    if (args.includes('disable') && failure === 'stop') return { code: 1, stdout: '', stderr: 'denied' };
    if (args.includes('--property=ActiveState,MainPID')) return ok(failure === 'still-running' ? 'ActiveState=active\nMainPID=123\n' : 'ActiveState=inactive\nMainPID=0\n');
    if (args.includes('daemon-reload') && failure === 'reload') return { code: 1, stdout: '', stderr: 'denied' };
    return ok();
  });
  writeFileSync(f.file, `Environment="TIMON_HOME=${f.opts.timonHome}"\n`);
  try {
    if (failure) assert.throws(() => removeDesktopService(f.opts)); else removeDesktopService(f.opts);
    assert.equal(existsSync(f.file), Boolean(failure && failure !== 'reload'));
    assert.equal(existsSync(join(f.opts.timonHome, 'valuable')), true);
    if (failure === 'foreign') assert.equal(calls.some(c => c.includes('disable')), false);
  } finally { f.clean(); }
});

for (const failure of [null, 'foreign', 'query', 'stop']) test(`Windows ${failure ?? 'success'} checks the owning home and reports errors`, () => {
  let queries = 0;
  const f = fixture('win32', (_cmd, _args) => {
    if (++queries === 1) {
      if (failure === 'query') return { code: 1, stdout: '', stderr: 'access denied' };
      return ok(JSON.stringify({ Arguments: `/c set TIMON_HOME=${failure === 'foreign' ? 'C:\\elsewhere' : f.opts.timonHome}&& run` }));
    }
    return failure === 'stop' ? { code: 1, stdout: '', stderr: 'access denied' } : ok();
  });
  try {
    if (failure) assert.throws(() => removeDesktopService(f.opts)); else removeDesktopService(f.opts);
    if (failure === 'foreign' || failure === 'query') assert.equal(queries, 1);
    assert.equal(existsSync(join(f.opts.timonHome, 'valuable')), true);
  } finally { f.clean(); }
});

test('Windows recognises the task of its home in every revision, and no other home', () => {
  const home = 'C:\\Users\\Sam\\.timon';
  const actions = [
    `"C:\\T\\resources\\orchestrator\\dist\\host\\windows-service-launcher.js" "${home}\\run\\timon-service.json"`,
    `--timon-service "${home}\\run\\timon-service.json"`,
    `/d /s /c ""${home}\\run\\timon-service.cmd""`,
    `/c set TIMON_HOME=${home}&& run`,
  ];
  for (const [index, args] of actions.entries()) {
    for (const timonHome of [home, 'c:\\users\\sam\\.TIMON', 'C:\\Users\\Other\\.timon']) {
      const calls: string[] = [];
      const f = fixture('win32', (_cmd, a) => {
        calls.push(a.at(-1) ?? '');
        return calls.length === 1 ? ok(JSON.stringify({ Arguments: args })) : ok();
      });
      try {
        const opts = { ...f.opts, timonHome };
        const own = timonHome.toLowerCase() === home.toLowerCase() && (index < 3 || timonHome === home);
        if (own) removeDesktopService(opts); else assert.throws(() => removeDesktopService(opts), /another data directory/);
        assert.equal(calls.some((c) => c.includes('Unregister-ScheduledTask')), own, `${args} for ${timonHome}`);
      } finally { f.clean(); }
    }
  }
});

test('Linux missing service accepts systemctl exit 4 without modifying anything', () => {
  let calls = 0;
  const f = fixture('linux', () => { calls++; return { code: 4, stdout: 'LoadState=not-found\n', stderr: '' }; });
  try { rmSync(f.file); removeDesktopService(f.opts); assert.equal(calls, 1); }
  finally { f.clean(); }
});

test('TIM-0115: Windows desktop removal also sweeps the daemon of this installation, and does not fail when it cannot', () => {
  const calls: string[] = [];
  const f = fixture('win32', (_cmd, args) => {
    const script = args.at(-1) ?? '';
    calls.push(script);
    if (calls.length === 1) return ok(JSON.stringify({ Arguments: `/c set TIMON_HOME=${f.opts.timonHome}&& run` }));
    // The sweep is best effort: a daemon out of reach is reported by the exit code, never thrown.
    return script.includes('terminal-host') ? { code: 5, stdout: '', stderr: '' } : ok();
  });
  try {
    removeDesktopService(f.opts);
    const sweep = calls.at(-1)!;
    assert.match(sweep, /taskkill\.exe \/F \/T/);
    assert.match(sweep, /dist.boot\.js/);
    assert.match(sweep, /terminal-host/);
  } finally { f.clean(); }
});
