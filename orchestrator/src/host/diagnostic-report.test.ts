import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimonConfigSchema } from '../config/schema.js';
import {
  buildDiagnosticReport, diagnosticFindings, doctorSummary, knownSecretValues, probeFailureReason, redactReport, type DiagnosticFacts,
} from './diagnostic-report.js';
import { parseDsregcmd } from './machine.js';
import { instanceId } from './packaged-service.js';
import { serviceDiagnostics, type ServiceOpts } from './service-install.js';

function facts(over: Partial<DiagnosticFacts> = {}): DiagnosticFacts {
  return {
    source: 'desktop', generatedAt: '2026-10-13T19:00:00.000+02:00', platform: 'win32',
    appVersion: '0.1.5', daemonVersion: '0.1.5', dataVersion: '0.1.5', packagedRuntime: true, home: 'C:\\Users\\t\\.timon',
    service: { installed: true, running: true, lines: [], details: { marked: true, lastTaskResult: 0, lines: [] } },
    windows: { account: 'europe\\t', azureAdJoined: false, domainJoined: false, workplaceJoined: false },
    daemonPort: { origin: 'http://127.0.0.1:3010', health: { kind: 'ours' }, port: null },
    snapshotFailure: null,
    ...over,
  };
}

const ids = (f: DiagnosticFacts) => diagnosticFindings(f).map((finding) => finding.id);

test('a healthy install has nothing to say', () => {
  assert.deepEqual(ids(facts()), []);
});

test('a service without the app marker is named (TIM-0087), only on the app runtime', () => {
  const unmarked = facts({ service: { installed: true, running: true, lines: [], details: { marked: false, lastTaskResult: 0, lines: [] } } });
  assert.deepEqual(ids(unmarked), ['unmarked-service']);
  assert.deepEqual(ids({ ...unmarked, packagedRuntime: false }), [], 'a source checkout service is never marked');
  assert.deepEqual(ids(facts({ runningUnmarked: true })), ['unmarked-service']);
});

test('#464: each service whose home is gone is named, with how to remove it', () => {
  const orphan = {
    name: 'timon-desktop-abc', definition: '/home/t/.config/systemd/user/timon-desktop-abc.service', home: '/tmp/tmp.rc',
    removal: 'systemctl --user disable --now timon-desktop-abc',
  };
  const found = diagnosticFindings(facts({ orphanServices: [orphan] }));
  assert.deepEqual(found.map((finding) => finding.id), ['orphan-service-timon-desktop-abc']);
  assert.match(found[0]!.text, /\/tmp\/tmp\.rc, which no longer exists.*systemctl --user disable --now timon-desktop-abc/);
});

test('a Windows task that never ran is named, with the Entra ID join (#342)', () => {
  const never = facts({
    service: { installed: true, running: false, lines: [], details: { marked: true, lastTaskResult: 0x41303, lines: [] } },
    daemonPort: { origin: 'http://127.0.0.1:3010', health: { kind: 'none', error: 'ECONNREFUSED' }, port: { available: true, detail: 'port available' } },
  });
  assert.deepEqual(ids(never), ['windows-task-never-ran', 'daemon-down']);
  assert.doesNotMatch(diagnosticFindings(never)[0]!.text, /Entra/);
  const entra = { ...never, windows: { account: 'europe\\t', azureAdJoined: true, domainJoined: false, workplaceJoined: true } };
  assert.match(diagnosticFindings(entra)[0]!.text, /Entra ID.*timon service uninstall/);
  assert.deepEqual(ids({ ...never, platform: 'darwin' }), ['daemon-down']);
});

test('a Windows task whose last start was refused because it already ran is not a finding (TIM-0158)', () => {
  const running = facts({
    service: { installed: true, running: true, lines: [], details: { marked: true, lastTaskResult: 0x800710e0, lines: [] } },
  });
  assert.deepEqual(ids(running), []);
});

test('a task Windows refused to start, then removed, is still named from its marker (#342)', () => {
  const removed = facts({ service: { installed: false, running: false, lines: [], details: null }, serviceRefused: '2026-10-13T22:00:00.000Z' });
  assert.deepEqual(ids(removed), ['windows-service-refused']);
  assert.doesNotMatch(diagnosticFindings(removed)[0]!.text, /Entra|uninstall/);
  const kept = { ...removed, service: facts().service, windows: { account: 'europe\\t', azureAdJoined: true, domainJoined: false, workplaceJoined: false } };
  assert.match(diagnosticFindings(kept)[0]!.text, /2026-10-13T22:00:00\.000Z.*Entra ID.*timon service uninstall/);
  const neverRan = { ...kept, service: { installed: true, running: false, lines: [], details: { marked: true, lastTaskResult: 0x41303, lines: [] } } };
  assert.deepEqual(ids(neverRan), ['windows-task-never-ran'], 'one line for one cause');
  assert.deepEqual(ids({ ...removed, platform: 'darwin' }), []);
});

test('#116: a Windows task that opens a console in the session is named, with what to do', () => {
  const shape = { logon: 'InteractiveToken' as const, program: 'cmd.exe', triggers: ['Boot' as const, 'Time' as const], consoleVisible: true };
  const visible = facts({ service: { installed: true, running: true, lines: [], details: { marked: true, lastTaskResult: 0, lines: [], shape } } });
  assert.deepEqual(ids(visible), ['windows-task-console']);
  const text = diagnosticFindings(visible)[0]!.text;
  assert.match(text, /starts cmd\.exe in your session/);
  assert.match(text, /Run only when user is logged on/);
  assert.match(text, /timon service install/);
  // Not on another OS, nor for a task that is not there any more.
  assert.deepEqual(ids({ ...visible, platform: 'darwin' }), []);
  assert.deepEqual(ids({ ...visible, service: { ...visible.service, installed: false } }), []);
  // Timon.exe in the session, or the boot task: nothing to say.
  const quiet = (over: Partial<typeof shape>) => facts({ service: { installed: true, running: true, lines: [], details: { marked: true, lastTaskResult: 0, lines: [], shape: { ...shape, ...over } } } });
  assert.deepEqual(ids(quiet({ program: 'timon.exe', consoleVisible: false })), []);
  assert.deepEqual(ids(quiet({ logon: 'S4U', consoleVisible: false })), []);
  assert.deepEqual(ids(facts({ service: { installed: true, running: true, lines: [], details: { marked: true, lastTaskResult: 0, lines: [], shape: null } } })), []);
  // A source checkout's session task is a hidden PowerShell by design; the app's never is.
  const powershell = quiet({ program: 'powershell.exe' });
  assert.deepEqual(ids({ ...powershell, packagedRuntime: false }), []);
  assert.deepEqual(ids(powershell), ['windows-task-console']);
});

test('data last opened by an older release are named', () => {
  assert.deepEqual(ids(facts({ dataVersion: '0.1.4' })), ['data-version-behind']);
  assert.deepEqual(ids(facts({ dataVersion: '0.1.6' })), []);
  assert.deepEqual(ids(facts({ appVersion: null, daemonVersion: '0.1.5', dataVersion: '0.1.5-rc.1' })), ['data-version-behind']);
});

test('a Node CLI with no node to run on is named', () => {
  const codex = { name: 'codex', path: join('nvm', 'bin', 'codex') };
  const found = diagnosticFindings(facts({ nodelessBackends: [codex] }));
  assert.deepEqual(found.map((finding) => finding.id), ['node-missing-codex']);
  assert.match(found[0]!.text, /codex .* runs on Node\.js.*env: node/);
  assert.deepEqual(ids(facts({ nodelessBackends: [] })), []);
});

test('the daemon port held by someone else is named, with its owner', () => {
  const port = { available: false, detail: 'port occupied; listener PID(s) 42 [node] (application identity unverified)' };
  assert.deepEqual(ids(facts({ daemonPort: { origin: 'o', health: { kind: 'foreign', status: 404 }, port } })), ['port-foreign']);
  assert.deepEqual(ids(facts({ daemonPort: { origin: 'o', health: { kind: 'other-timon' }, port } })), ['port-other-timon']);
  const held = diagnosticFindings(facts({ daemonPort: { origin: 'o', health: { kind: 'none', error: 'timeout' }, port } }));
  assert.equal(held[0]!.id, 'port-held');
  assert.match(held[0]!.text, /42 \[node\]/);
  assert.match(held[0]!.text, /still starting, or busy/, 'a Timon or Node holder is a daemon not answering yet, not an intruder');
  const foreign = { available: false, detail: 'port occupied; listener PID(s) 7 [python3] (application identity unverified)' };
  const other = diagnosticFindings(facts({ daemonPort: { origin: 'o', health: { kind: 'none', error: 'timeout' }, port: foreign } }));
  assert.match(other[0]!.text, /its port is taken — port occupied/);
  assert.doesNotMatch(other[0]!.text, /still starting/);
});

test('a probe failure names its cause instead of "fetch failed"', () => {
  assert.equal(probeFailureReason(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } })), 'connection refused: nothing listens on the port');
  assert.equal(probeFailureReason(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } })), 'connection reset: the daemon closed it without replying');
  assert.equal(probeFailureReason(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })), 'connected, but no reply in time: the daemon is still starting, or busy');
  assert.equal(probeFailureReason(new TypeError('fetch failed', { cause: { code: 'EHOSTUNREACH' } })), 'EHOSTUNREACH: fetch failed');
  assert.equal(probeFailureReason(new Error('odd')), 'odd');
});

test('redaction: file values, token shapes, query secrets and addresses', () => {
  const text = [
    'Authorization: Bearer abcdefghijklmnop1234',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and ghp_ABCDEFGHIJKLMNOPQRSTUVWX12',
    'OPENAI_API_KEY=sk-short-but-real',
    'GET /cb?code=4/0AY0e-g7abc&state=x',
    'mail jane.doe@example.com',
    'the daemon token is f00dfeedf00dfeed',
  ].join('\n');
  const out = redactReport(text, ['f00dfeedf00dfeed']);
  for (const leak of ['abcdefghijklmnop1234', 'dozjgNryP4J3', 'ABCDEFGHIJKLMNOPQRSTUV', 'sk-short-but-real', '0AY0e-g7abc', 'jane.doe', 'f00dfeedf00dfeed']) {
    assert.ok(!out.includes(leak), `${leak} leaked:\n${out}`);
  }
  assert.match(out, /\*\*\*@example\.com/);
  assert.match(out, /state=x/);
});

test('secret files and secrets.env values of the home are known values', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-diag-secrets-'));
  try {
    writeFileSync(join(home, 'daemon-token'), 'tok-1234567890\n');
    writeFileSync(join(home, 'secrets.env'), 'A=short\nexport GITHUB_TOKEN="gh-value-123456"\n# comment\n');
    assert.deepEqual(knownSecretValues(home).sort(), ['gh-value-123456', 'tok-1234567890']);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('dsregcmd flags are read whatever their spacing', () => {
  const out = '+---+\n Device State\n+---+\n\n             AzureAdJoined : YES\n          EnterpriseJoined : NO\n              DomainJoined : NO\n           WorkplaceJoined : YES\n';
  assert.deepEqual(parseDsregcmd(out), { azureAdJoined: true, domainJoined: false, workplaceJoined: true });
  assert.deepEqual(parseDsregcmd(''), { azureAdJoined: null, domainJoined: null, workplaceJoined: null });
});

test('the doctor summary keeps the essentials', () => {
  const lines = doctorSummary({ ok: false, binaries: [{ name: 'node', ok: true }, { name: 'claude', ok: false }], supervisor: 'windows', blockers: ['claude missing'] });
  assert.deepEqual(lines, ['ok        no', 'binaries  node ✓, claude ✗', 'supervisor windows', 'BLOCKING  claude missing']);
});

test('a full report: findings, newest log lines first, secrets masked, no database', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-diag-report-'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'timon', instance: instanceId(home) }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    mkdirSync(join(home, 'tmp'), { recursive: true });
    writeFileSync(join(home, 'daemon-token'), 'secret-daemon-token-value');
    writeFileSync(join(home, 'data-version'), '0.1.4\n');
    writeFileSync(join(home, 'tmp', 'daemon-2026-10-12.log'), 'old line\n');
    writeFileSync(join(home, 'tmp', 'daemon-2026-10-13.log'), 'first\nlatest uses secret-daemon-token-value\n');
    writeFileSync(join(home, 'tmp', 'desktop-2026-10-13.log'), '[desktop] window shown\n');
    const cfg = TimonConfigSchema.parse({ daemon: { listen: { host: '127.0.0.1', port: address.port } } });
    const exec = (name: string, args: string[]) => {
      if (name === 'systemctl' && args.includes('show')) return { code: 0, stdout: 'LoadState=not-found\nActiveState=inactive\n', stderr: '' };
      return { code: 1, stdout: '', stderr: '' };
    };
    const serviceOpts: ServiceOpts = {
      platform: 'linux', homeDir: home, timonHome: home, installDir: join(home, 'install'), userName: 't', uid: 1000,
      heapMb: 1024, port: address.port, nodePath: process.execPath, exec,
    };
    const { text, findings } = await buildDiagnosticReport({
      source: 'cli', home, cfg, host: { platform: 'linux', execAsync: async () => ({ code: 1, stdout: '', stderr: '' }) },
      serviceOpts, appVersion: '0.1.5', daemonVersion: '0.1.5',
      doctor: async () => ['ok        yes'],
      now: new Date(2026, 9, 13, 12),
    });
    assert.deepEqual(findings.map((finding) => finding.id), ['data-version-behind']);
    assert.match(text, /answer {4}Timon, this data directory/);
    assert.match(text, /== Doctor ==\nok {8}yes/);
    const daemonLog = text.split('== Daemon log')[1]!;
    assert.ok(daemonLog.indexOf('\nlatest uses ***') < daemonLog.indexOf('\nfirst\n'), 'newest first');
    assert.ok(daemonLog.indexOf('\nfirst\n') < daemonLog.indexOf('\nold line'));
    assert.match(text, /\[desktop\] window shown/);
    assert.ok(!text.includes('Installer service pause'), 'a Windows installer journal, on Windows only');
    assert.ok(!text.includes('secret-daemon-token-value'));
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a Windows report reads the refused marker the host left (#342)', { timeout: 20_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-diag-refused-'));
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, service: 'timon', instance: instanceId(home) }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'service-refused'), '2026-10-13T22:00:00.000Z\n');
    mkdirSync(join(home, 'tmp'), { recursive: true });
    // Written by the installer's pause script, with the BOM Windows PowerShell puts first.
    writeFileSync(join(home, 'tmp', 'timon-service-pause.log'), '\uFEFF2026-11-17T10:00:00 pause: start, elevated: True\r\n2026-11-17T10:00:09 pause: exit 5, 1 process(es) of Timon still run: the installer must not go on\r\n');
    const cfg = TimonConfigSchema.parse({ daemon: { listen: { host: '127.0.0.1', port: address.port } } });
    const exec = () => ({ code: 1, stdout: '', stderr: '' });
    const serviceOpts: ServiceOpts = {
      platform: 'win32', homeDir: home, timonHome: home, installDir: join(home, 'install'), userName: 't', uid: 0,
      heapMb: 1024, port: address.port, nodePath: process.execPath, exec,
    };
    const { text, findings } = await buildDiagnosticReport({
      source: 'desktop', home, cfg, host: { platform: 'win32', execAsync: async () => ({ code: 1, stdout: '', stderr: '' }) },
      serviceOpts, appVersion: '0.1.5', daemonVersion: '0.1.5',
    });
    assert.deepEqual(findings.map((finding) => finding.id), ['windows-service-refused']);
    assert.match(text, /refused {3}Windows never started the task for this account \(recorded 2026-10-13T22:00:00\.000Z\)/);
    // The journal of the installer's service pause: what an update found running and left behind.
    const pause = text.split('== Installer service pause timon-service-pause.log (newest first) ==')[1]!;
    assert.ok(pause.indexOf('pause: exit 5') < pause.indexOf('pause: start'), 'newest first');
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the service marker is read from the definition each supervisor runs', () => {
  const root = mkdtempSync(join(tmpdir(), 'timon-diag-marker-'));
  try {
    const home = join(root, 'home');
    const timonHome = join(home, '.timon');
    mkdirSync(join(timonHome, 'run'), { recursive: true });
    const base = {
      homeDir: home, timonHome, installDir: root, userName: 't', uid: 501, heapMb: 1024, port: 3010,
      nodePath: process.execPath, launchDaemonsDir: join(root, 'LaunchDaemons'),
      exec: () => ({ code: 0, stdout: 'LastTaskResult=267011\nLastRunTime=1999-11-30T00:00:00\n', stderr: '' }),
    };
    const win = { ...base, platform: 'win32' as const };
    assert.equal(serviceDiagnostics(win).marked, null);
    writeFileSync(join(timonHome, 'run', 'timon-service.cmd'), '@echo off\r\nset "TIMON_HOME=x"\r\n');
    assert.equal(serviceDiagnostics(win).marked, false);
    writeFileSync(join(timonHome, 'run', 'timon-service.cmd'), '@echo off\r\nset "TIMON_DESKTOP_SERVICE=1"\r\n');
    const windows = serviceDiagnostics(win);
    assert.equal(windows.marked, true);
    assert.equal(windows.lastTaskResult, 0x41303);
    assert.ok(windows.lines.includes('last result: 267011 (0x41303)'));
    const refused = serviceDiagnostics({ ...win, exec: () => ({ code: 0, stdout: 'LastTaskResult=2147946720\nLastRunTime=2026-11-18T19:05:05\n', stderr: '' }) });
    assert.equal(refused.lastTaskResult, 0x800710e0);
    assert.ok(refused.lines.includes('last result: 2147946720 (0x800710e0: an instance was already running, not a failure)'), refused.lines.join('\n'));
    // #116: the logon, the action and the verdict, read from the task XML.
    const consoleTask = serviceDiagnostics({ ...win, exec: (_name: string, args: string[]) => (args.includes('/XML')
      ? { code: 0, stdout: '<Task><Principals><Principal><LogonType>InteractiveToken</LogonType></Principal></Principals><Actions><Exec><Command>cmd.exe</Command></Exec></Actions></Task>', stderr: '' }
      : { code: 0, stdout: 'LastTaskResult=0\nLogonType=Interactive\n', stderr: '' }) });
    assert.equal(consoleTask.shape?.consoleVisible, true);
    assert.ok(consoleTask.lines.includes('Action: cmd.exe'), consoleTask.lines.join('\n'));
    assert.ok(consoleTask.lines.includes('ConsoleVisible: yes'));
    assert.equal(windows.shape, null, 'a definition that cannot be read is no shape');

    const mac = { ...base, platform: 'darwin' as const };
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(join(home, 'Library', 'LaunchAgents', 'com.timon.daemon.plist'), '<key>TIMON_DESKTOP_SERVICE</key><string>1</string>');
    assert.equal(serviceDiagnostics(mac).marked, true);
    mkdirSync(base.launchDaemonsDir, { recursive: true });
    writeFileSync(join(base.launchDaemonsDir, 'com.timon.daemon.plist'), '<plist/>');
    writeFileSync(join(timonHome, 'run', 'timon-service.sh'), "#!/bin/sh\nexport TIMON_HOME='/x'\n");
    assert.equal(serviceDiagnostics(mac).marked, false, 'the LaunchDaemon is read through its launcher');

    const linux = { ...base, platform: 'linux' as const, unitName: 'timon-desktop-abc' };
    mkdirSync(join(home, '.config', 'systemd', 'user'), { recursive: true });
    writeFileSync(join(home, '.config', 'systemd', 'user', 'timon-desktop-abc.service'), '[Service]\nEnvironment="TIMON_DESKTOP_SERVICE=1"\n');
    assert.equal(serviceDiagnostics(linux).marked, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
