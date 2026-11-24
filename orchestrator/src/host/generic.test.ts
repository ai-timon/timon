import { strict as assert } from 'node:assert';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-host-test-'));

const { TimonConfigSchema } = await import('../config/schema.js');
const { createGenericHost, unresolvedBinaryPath } = await import('./generic.js');

const host = createGenericHost(TimonConfigSchema.parse({}));

test('generic confine keeps the command and its arguments', () => {
  assert.deepEqual(host.confine('/bin/echo', ['ok'], 'unit'), { cmd: '/bin/echo', args: ['ok'] });
});

// `node` and not `sleep`: the same command on all three OSes.
test('execAsync tells a command it stopped from a command that failed', async () => {
  const hung = await host.execAsync(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeout: 200 });
  assert.equal(hung.timedOut, true);
  const failed = await host.execAsync(process.execPath, ['-e', 'process.exit(3)'], { timeout: 60_000 });
  assert.equal(failed.code, 3);
  assert.equal(failed.timedOut, undefined);
  const verbose = await host.execAsync(process.execPath, ['-e', 'console.log("x".repeat(4096))'], { timeout: 60_000, maxBuffer: 16 });
  assert.notEqual(verbose.code, 0);
  assert.equal(verbose.timedOut, undefined, 'an output over maxBuffer is no timeout');
});

test('generic bin finds git in the PATH', () => {
  assert.match(host.bin('git'), /git(?:\.exe)?$/);
});

test('generic bin names the missing binary in the error', () => {
  assert.throws(() => host.bin('binaire-inexistant'), /binaire-inexistant/);
});

/** The child prints its environment: Node instead of `env`, which Windows does not have. */
const PRINT_ENV = ['-e', 'for (const [k, v] of Object.entries(process.env)) console.log(`${k}=${v}`)'];

test('generic spawn: a given `env` is the FULL environment of the child', async () => {
  // Hinge of S.4: as long as `spawn` redid `{ ...process.env, ...opts.env }`,
  // the `missionEnv` allowlist had no effect and the absence tests
  // passed for the wrong reasons. This test fails if someone brings it back.
  process.env.TEMOIN_DU_DAEMON = 'ne-doit-pas-passer';
  try {
    const child = host.spawn(process.execPath, PRINT_ENV, { env: { SEUL_CE_QUI_EST_POSE: '1' }, stdio: ['ignore', 'pipe', 'ignore'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout!.on('data', (chunk) => { buf += String(chunk); });
      child.on('close', () => resolve(buf));
    });
    assert.match(out, /^SEUL_CE_QUI_EST_POSE=1$/m);
    assert.doesNotMatch(out, /TEMOIN_DU_DAEMON/);
  } finally {
    delete process.env.TEMOIN_DU_DAEMON;
  }
});

test('generic spawn: without `env`, the child inherits as before', async () => {
  process.env.TEMOIN_HERITE = 'present';
  try {
    const child = host.spawn(process.execPath, PRINT_ENV, { stdio: ['ignore', 'pipe', 'ignore'] });
    const out = await new Promise<string>((resolve) => {
      let buf = '';
      child.stdout!.on('data', (chunk) => { buf += String(chunk); });
      child.on('close', () => resolve(buf));
    });
    assert.match(out, /^TEMOIN_HERITE=present$/m);
  } finally {
    delete process.env.TEMOIN_HERITE;
  }
});

test('generic bin (win32): a pin to a replaced Codex desktop build falls back on detection', async (t) => {
  const { mkdirSync, rmSync, utimesSync, writeFileSync } = await import('node:fs');
  const local = mkdtempSync(join(tmpdir(), 'timon-codex-pin-'));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  const current = join(bin, 'bbbb2222', 'codex.exe');
  mkdirSync(join(bin, 'bbbb2222'), { recursive: true });
  writeFileSync(current, '');
  utimesSync(current, 2_000, 2_000);
  const win = {
    platform: 'win32' as const, path: '', homeDir: '', env: { LOCALAPPDATA: local },
    installedBinariesFile: join(local, 'absent.json'),
  };
  const hostWith = (pin: string, options: typeof win | { platform: 'linux'; path: string; homeDir: string; env: { LOCALAPPDATA: string } }) =>
    createGenericHost(TimonConfigSchema.parse({ host: { binaries: { codex: pin } } }), options);

  // Without a pin: detection finds the desktop app build.
  assert.equal(createGenericHost(TimonConfigSchema.parse({}), win).bin('codex'), current);
  // Stale pin to an old build: fallback on detection.
  assert.equal(hostWith(join(bin, 'aaaa1111', 'codex.exe'), win).bin('codex'), current);

  // Outside this precise case, a broken pin stays an error.
  for (const broken of [
    join(bin, 'pas-hexa', 'codex.exe'),
    join(local, 'ailleurs', 'OpenAI', 'Codex', 'bin', 'aaaa1111', 'codex.exe'),
    join(local, 'ailleurs', 'codex.exe'),
  ]) {
    assert.throws(() => hostWith(broken, win).bin('codex'), /not found or not executable/, broken);
  }
  const linux = { platform: 'linux' as const, path: '', homeDir: '', env: { LOCALAPPDATA: local } };
  assert.throws(() => hostWith(join(bin, 'aaaa1111', 'codex.exe'), linux).bin('codex'), /not found or not executable/);
});

// What the registry asks (`requiredBinary`) and what a mission spawns both go
// through `host.bin`: found must mean launchable.
test('generic bin and spawn reach an ACP agent in its installer directory', async (t) => {
  const { chmodSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'timon-acp-bins-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const local = join(home, 'Local');
  const hermes = join(local, 'hermes', 'bin', 'hermes-acp.exe');
  mkdirSync(join(local, 'hermes', 'bin'), { recursive: true });
  writeFileSync(hermes, '');
  const win = {
    platform: 'win32' as const, path: '', homeDir: home, env: { LOCALAPPDATA: local },
    installedBinariesFile: join(home, 'absent.json'),
  };
  assert.equal(createGenericHost(TimonConfigSchema.parse({}), win).bin('hermes-acp'), hermes);
  assert.throws(() => createGenericHost(TimonConfigSchema.parse({}), { ...win, env: {} }).bin('hermes-acp'), /hermes-acp/);

  if (process.platform === 'win32') { t.skip('the stub below is a shell script'); return; }
  const opencode = join(home, '.opencode', 'bin', 'opencode');
  mkdirSync(join(home, '.opencode', 'bin'), { recursive: true });
  writeFileSync(opencode, '#!/bin/sh\necho "stub:$0"\n');
  chmodSync(opencode, 0o755);
  // A service PATH that does not list the installer directory.
  const service = createGenericHost(TimonConfigSchema.parse({}), { path: '/usr/bin:/bin', homeDir: home, env: {} });
  assert.equal(service.bin('opencode'), opencode);
  const child = service.spawn('opencode', [], { stdio: ['ignore', 'pipe', 'ignore'] });
  const out = await new Promise<string>((resolve, reject) => {
    let buf = '';
    child.stdout!.on('data', (chunk) => { buf += String(chunk); });
    child.on('error', reject);
    child.on('close', () => resolve(buf));
  });
  assert.equal(out.trim(), `stub:${opencode}`);
});

test('generic (win32): an npm shim starts its script as a direct child, arguments untouched', async (t) => {
  const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'timon-npm-shim-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node_modules', 'acme'), { recursive: true });
  writeFileSync(
    join(dir, 'node_modules', 'acme', 'cli.js'),
    'process.stdout.write(JSON.stringify({ pid: process.pid, args: process.argv.slice(2) }));',
  );
  writeFileSync(join(dir, 'acme-cli.cmd'), [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start', 'SETLOCAL', 'CALL :find_dp0', '',
    'IF EXIST "%dp0%\\node.exe" (', '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\acme\\cli.js" %*', '',
  ].join('\r\n'));
  const win = createGenericHost(TimonConfigSchema.parse({}), {
    platform: 'win32', homeDir: '', env: {},
    path: `${dir};${dirname(process.execPath)}`,
    installedBinariesFile: join(dir, 'absent.json'),
  });
  const args = ['-p', 'a b', '^caret', '100%', 'say "hi"', '', 'trailing\\', '&calc'];

  const child = win.spawn('acme-cli', args, { stdio: ['ignore', 'pipe', 'inherit'] });
  const out = await new Promise<string>((resolve) => {
    let buf = '';
    child.stdout!.on('data', (chunk) => { buf += String(chunk); });
    child.on('close', () => resolve(buf));
  });
  const seen = JSON.parse(out) as { pid: number; args: string[] };
  // The pid held is the CLI's own: nothing stands between it and the daemon.
  assert.equal(seen.pid, child.pid);
  assert.deepEqual(seen.args, args);

  assert.deepEqual((JSON.parse(win.exec('acme-cli', ['x y']).stdout) as { args: string[] }).args, ['x y']);
  const asynchronous = await win.execAsync('acme-cli', ['x y']);
  assert.deepEqual((JSON.parse(asynchronous.stdout) as { args: string[] }).args, ['x y']);
});

// Windows looks for a bare name in the child's cwd BEFORE the PATH: a daemon
// spawn whose cwd is a mission's worktree would start the `<name>.exe` planted
// there.
test('generic spawn (win32): a binary that does not resolve is never passed by its bare name', async () => {
  const runtime = 'C:\\Program Files\\Timon\\Timon.exe';
  const path = unresolvedBinaryPath('codex', 'win32', runtime);
  assert.equal(path, 'C:\\Program Files\\Timon\\Timon.exe\\unresolved-binary\\codex');
  const { win32 } = await import('node:path');
  assert.ok(win32.isAbsolute(path));
  assert.equal(unresolvedBinaryPath('sub\\codex.exe', 'win32', runtime), 'C:\\Program Files\\Timon\\Timon.exe\\unresolved-binary\\codex.exe');
  assert.equal(unresolvedBinaryPath('C:\\tools\\x.exe', 'win32', runtime), 'C:\\tools\\x.exe', 'an absolute name is looked up nowhere');
  assert.equal(unresolvedBinaryPath('C:x.exe', 'win32', runtime), 'C:\\Program Files\\Timon\\Timon.exe\\unresolved-binary\\x.exe');

  const win = createGenericHost(TimonConfigSchema.parse({}), {
    platform: 'win32', path: '', homeDir: '', env: {}, installedBinariesFile: join(tmpdir(), 'timon-absent.json'),
  });
  const child = win.spawn('timon-no-such-cli', [], { stdio: 'ignore', cwd: tmpdir() });
  assert.equal(child.spawnfile, unresolvedBinaryPath('timon-no-such-cli', 'win32'));
  const code = await new Promise<string | undefined>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code));
    child.on('close', () => resolve(undefined));
  });
  assert.equal(code, 'ENOENT');
});

test('generic spawn: a binary planted in the cwd never runs in place of a missing one', { skip: process.platform === 'win32' }, async (t) => {
  const { chmodSync, existsSync, rmSync, writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'timon-planted-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const witness = join(dir, 'ran');
  // A shell builtin: the child's PATH holds nothing else.
  writeFileSync(join(dir, 'timon-no-such-cli'), `#!/bin/sh\n: > '${witness}'\n`);
  chmodSync(join(dir, 'timon-no-such-cli'), 0o755);
  // A relative PATH entry: the bare name would resolve in the cwd.
  const posixHost = createGenericHost(TimonConfigSchema.parse({}), { path: '.', homeDir: '', env: {} });
  const child = posixHost.spawn('timon-no-such-cli', [], { stdio: 'ignore', cwd: dir, env: { PATH: '.' } });
  const code = await new Promise<string | undefined>((resolve) => {
    child.on('error', (err: NodeJS.ErrnoException) => resolve(err.code));
    child.on('close', () => resolve(undefined));
  });
  assert.equal(code, 'ENOENT');
  assert.equal(existsSync(witness), false);
});
