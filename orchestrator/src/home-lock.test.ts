// Must stay first: the database below opens in this throwaway home.
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  HOME_HELD_EXIT_CODE,
  HomeHeldError,
  holdHomeLock,
  homeLockFile,
  homeLockHolderFile,
  readHomeLockHolder,
  recordHomeLockPort,
  recordServiceHeldOut,
  releaseHomeLock,
  serviceHeldOutFile,
} from './home-lock.js';

const freshHome = (): string => mkdtempSync(join(tmpdir(), 'timon-home-lock-'));

/** Another daemon, as the OS sees it: a second connection holding the same exclusive lock. */
function otherHolder(home: string, holder: { pid: number; port?: number }): Database.Database {
  const lock = new Database(homeLockFile(home), { timeout: 0 });
  lock.exec('BEGIN EXCLUSIVE');
  writeFileSync(homeLockHolderFile(home), JSON.stringify({ ...holder, startedAt: Date.now() }));
  return lock;
}

test('a home another daemon holds is refused, naming its pid and port', () => {
  const home = freshHome();
  const other = otherHolder(home, { pid: 4242, port: 3999 });
  try {
    assert.throws(() => holdHomeLock(home, { waitMs: 50 }), (error: unknown) => {
      assert.ok(error instanceof HomeHeldError);
      assert.match(error.message, /pid 4242, port 3999/);
      assert.match(error.message, /stops without touching the data/);
      return true;
    });
    // The refused daemon leaves the holder's description alone.
    assert.equal(readHomeLockHolder(home)?.pid, 4242);
  } finally {
    other.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('a holder that has not written its description yet is still refused', () => {
  const home = freshHome();
  const other = new Database(homeLockFile(home), { timeout: 0 });
  other.exec('BEGIN EXCLUSIVE');
  try {
    assert.throws(() => holdHomeLock(home, { waitMs: 50 }), /pid is not known yet/);
  } finally {
    other.close();
    rmSync(home, { recursive: true, force: true });
  }
});

test('the lock is taken, its port recorded, and given back on release', () => {
  const home = freshHome();
  try {
    holdHomeLock(home, { now: () => 1_000 });
    holdHomeLock(home); // Same process, same home: a second boot in a test is not refused.
    assert.deepEqual(readHomeLockHolder(home), { pid: process.pid, startedAt: 1_000 });
    recordHomeLockPort(home, 3101);
    assert.equal(readHomeLockHolder(home)?.port, 3101);

    const probe = new Database(homeLockFile(home), { timeout: 0 });
    assert.throws(() => probe.exec('BEGIN EXCLUSIVE'), { code: 'SQLITE_BUSY' });
    releaseHomeLock(home);
    assert.equal(existsSync(homeLockHolderFile(home)), false);
    probe.exec('BEGIN EXCLUSIVE');
    probe.close();
  } finally {
    releaseHomeLock(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('the lock of a daemon that crashed is taken over, whatever its description says', { timeout: 30_000 }, async () => {
  const home = freshHome();
  const witness = join(home, 'holder.mjs');
  writeFileSync(witness, `
    import { holdHomeLock } from ${JSON.stringify(new URL('./home-lock.ts', import.meta.url).href)};
    holdHomeLock(${JSON.stringify(home)});
    console.log('held');
    setInterval(() => {}, 1_000);
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', witness], { stdio: ['ignore', 'pipe', 'inherit'], timeout: 25_000 });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (chunk: Buffer) => { if (chunk.toString().includes('held')) resolve(); });
      child.once('exit', (code) => reject(new Error(`holder exited early (${code})`)));
    });
    assert.equal(readHomeLockHolder(home)?.pid, child.pid);
    assert.throws(() => holdHomeLock(home, { waitMs: 50 }), HomeHeldError);

    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    // Its description outlives it; the OS lock does not.
    assert.equal(readHomeLockHolder(home)?.pid, child.pid);
    holdHomeLock(home, { waitMs: 2_000 });
    assert.equal(readHomeLockHolder(home)?.pid, process.pid);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    releaseHomeLock(home);
    rmSync(home, { recursive: true, force: true });
  }
});

test('a refused service daemon leaves its mark for the desktop; an embedded or CLI start does not', () => {
  const home = freshHome();
  try {
    assert.equal(recordServiceHeldOut(home, {}), false, 'no marker: not the service');
    assert.equal(recordServiceHeldOut(home, { TIMON_DESKTOP_SERVICE: '0' }), false);
    assert.equal(recordServiceHeldOut(home, { TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '1' }), false);
    assert.equal(existsSync(serviceHeldOutFile(home)), false);
    assert.equal(recordServiceHeldOut(home, { TIMON_DESKTOP_SERVICE: '1' }, { pid: 4242, now: () => 1_700_000_000_000 }), true);
    assert.deepEqual(JSON.parse(readFileSync(serviceHeldOutFile(home), 'utf8')), { at: 1_700_000_000_000, pid: 4242 });
    assert.equal(serviceHeldOutFile(home), join(home, 'run', 'service-held-out'));
    const guard = readFileSync(new URL('./home-lock-boot.ts', import.meta.url), 'utf8');
    assert.ok(guard.indexOf('recordServiceHeldOut(TIMON_HOME)') > 0 && guard.indexOf('recordServiceHeldOut(TIMON_HOME)') < guard.indexOf('process.exit(HOME_HELD_EXIT_CODE)'),
      'the refusal is recorded before the exit');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('boot.ts takes the lock before it restores, migrates or composes anything', () => {
  const source = readFileSync(new URL('./boot.ts', import.meta.url), 'utf8');
  const lock = source.indexOf("import './home-lock-boot.js';");
  assert.ok(lock > 0, 'boot.ts must import home-lock-boot');
  assert.ok(lock > source.indexOf("import './log-boot.js';"), 'after the log, so the refusal is written down');
  for (const later of ["import './rejection-boot.js';", "import './data-restore-boot.js';", 'data-update-boot.js', "import('./kernel-boot.js')"]) {
    assert.ok(source.indexOf(later) > lock, `${later} must come after the home lock`);
  }
  const guard = readFileSync(new URL('./home-lock-boot.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(guard, /from '\.\/(db|data-version|config\/load|settings)\.js'/, 'the guard must not open what it protects');
});

test('a second daemon on a held home exits before touching a running mission', { timeout: 40_000 }, async () => {
  const home = process.env.TIMON_HOME!;
  const { dbApi } = await import('./db.js');
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'setup-agent', 'first-run setup');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');

  holdHomeLock(home);
  const probe = createServer().listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  recordHomeLockPort(home, address.port);
  await new Promise<void>((resolve) => probe.close(() => resolve()));

  const child = spawn(process.execPath, ['--import', 'tsx', 'src/boot.ts'], {
    env: { ...process.env, TIMON_HOME: home, PORT: String(address.port), TIMON_RESOURCE_GUARD_ENABLED: '0' },
    stdio: ['ignore', 'pipe', 'pipe'], timeout: 35_000,
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  try {
    const [code] = await once(child, 'exit') as [number | null];
    assert.equal(code, HOME_HELD_EXIT_CODE, output);
    assert.match(output, new RegExp(`pid ${process.pid}, port ${address.port}`));
    assert.equal(dbApi.getMission(missionId)?.status, 'running', 'the live daemon\'s mission must stay running');
    assert.equal(readHomeLockHolder(home)?.pid, process.pid, 'the refused daemon must not touch the holder');
    // One line per refused start: a supervisor relaunching it must not flood the log.
    const logs = readdirSync(join(home, 'tmp')).filter((name) => name.startsWith('daemon-'));
    const refusals = logs.flatMap((name) => readFileSync(join(home, 'tmp', name), 'utf8').split('\n'))
      .filter((line) => line.includes('another Timon daemon already serves'));
    assert.equal(refusals.length, 1, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    releaseHomeLock(home);
  }
});
