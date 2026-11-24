import { test } from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { backupsDir, packagedCli, readDataVersion, readSnapshotMeta, snapshotName, timonVersion, updateApprovalFile, writeDataVersion } from './data-version.js';

const electron = { ...process.versions, electron: '38.0.0' } as NodeJS.ProcessVersions;

test('only a terminal run of the packaged runtime is a packaged CLI', () => {
  assert.equal(packagedCli({}, electron), true);
  assert.equal(packagedCli({ TIMON_DESKTOP_EMBEDDED: '0', TIMON_DESKTOP_SERVICE: '0' }, electron), true);
  // The app's own processes, and a mission's `timon` under the service, already go through the daemon gate.
  assert.equal(packagedCli({ TIMON_DESKTOP_EMBEDDED: '1' }, electron), false);
  assert.equal(packagedCli({ TIMON_DESKTOP_SERVICE: '1' }, electron), false);
  // A source checkout runs on Node.
  assert.equal(packagedCli({}, { ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions), false);
  // The Node the package ships is the packaged runtime too.
  const shippedNode = { ...process.versions, electron: undefined } as unknown as NodeJS.ProcessVersions;
  const shippedPath = join(tmpdir(), 'Timon', 'resources', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  assert.equal(packagedCli({}, shippedNode, shippedPath), true);
  assert.equal(packagedCli({ TIMON_DESKTOP_SERVICE: '1' }, shippedNode, shippedPath), false);
});

/** Loads db.ts as the packaged CLI does: the Electron runtime, no daemon marker. */
async function openAsPackagedCli(home: string): Promise<{ code: number; output: string }> {
  const witness = join(home, 'packaged-cli-witness.mjs');
  writeFileSync(witness, `
    Object.defineProperty(process.versions, 'electron', { value: '38.0.0' });
    try {
      await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)});
      console.log('opened');
      process.exit(0);
    } catch (error) {
      console.log(error.name + ': ' + error.message);
      process.exit(3);
    }
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' };
  delete env.TIMON_DESKTOP_EMBEDDED;
  delete env.TIMON_DESKTOP_SERVICE;
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--import', 'tsx', witness], { env, timeout: 60_000 });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return { code: typeof failed.code === 'number' ? failed.code : -1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

test('a packaged CLI refuses data an unapproved update would migrate, then keeps the copy once approved (TODO #535)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-packaged-cli-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, 'timon.db');
  const seed = new Database(dbPath);
  seed.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('kept')");
  seed.close();
  writeDataVersion(home, '0.1.0');
  const before = readFileSync(dbPath);
  const version = timonVersion();

  const refused = await openAsPackagedCli(home);
  assert.equal(refused.code, 3, refused.output);
  assert.match(refused.output, /PackagedCliUpdatePendingError: These data were last used by Timon 0\.1\.0/);
  assert.match(refused.output, new RegExp(`timon update approve ${version.replace(/\./g, '\\.')}`));
  assert.deepEqual(readFileSync(dbPath), before, 'not one migration ran');
  assert.equal(readDataVersion(home), '0.1.0');
  assert.equal(existsSync(backupsDir(home)), false);

  writeFileSync(updateApprovalFile(home), `${JSON.stringify({ version, approvedAt: Date.now() })}\n`);
  const opened = await openAsPackagedCli(home);
  assert.equal(opened.code, 0, opened.output);
  assert.match(opened.output, /opened/);
  assert.equal(readDataVersion(home), version);
  const copy = new Database(join(backupsDir(home), snapshotName(version), 'timon.db'), { readonly: true });
  try {
    assert.deepEqual(copy.prepare('SELECT value FROM notes').all(), [{ value: 'kept' }]);
    // The copy predates the migrations: none of the product's tables are in it.
    const tables = copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    assert.deepEqual(tables, [{ name: 'notes' }]);
  } finally {
    copy.close();
  }
});

/** A loopback port nobody listens on, so the CLI never reaches the installed daemon. */
async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/**
 * Runs the real `bin/timon` as the packaged CLI: the Electron runtime, no
 * daemon marker. The bin loads `../dist/<mod>.js`, which a worktree never
 * builds; a resolve hook serves `src/<mod>.ts` instead, so the module graph
 * the bin walks (and the refusal db.ts raises while loading) is the real one.
 */
async function runPackagedCli(home: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const harness = mkdtempSync(join(tmpdir(), 'timon-packaged-bin-'));
  try {
    const orchestrator = new URL('../', import.meta.url);
    const dist = new URL('dist/', orchestrator).href;
    const src = new URL('src/', orchestrator).href;
    const hooks = join(harness, 'hooks.mjs');
    writeFileSync(hooks, `
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith(${JSON.stringify(dist)})) {
          specifier = ${JSON.stringify(src)} + specifier.slice(${dist.length}).replace(/\\.js$/, '.ts');
        }
        return next(specifier, context);
      }
    `);
    const register = join(harness, 'register.mjs');
    writeFileSync(register, `
      import { register } from 'node:module';
      import { pathToFileURL } from 'node:url';
      Object.defineProperty(process.versions, 'electron', { value: '38.0.0' });
      register(pathToFileURL(${JSON.stringify(hooks)}).href);
    `);
    const port = await freePort();
    const env: NodeJS.ProcessEnv = {
      ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0',
      PORT: String(port), TIMON_API: `http://127.0.0.1:${port}`,
    };
    delete env.TIMON_DESKTOP_EMBEDDED;
    delete env.TIMON_DESKTOP_SERVICE;
    delete env.TIMON_API_TOKEN;
    const bin = new URL('bin/timon', orchestrator);
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath,
        ['--import', 'tsx', '--import', pathToFileURL(register).href, fileURLToPath(bin), ...args], { env, timeout: 90_000 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code?: unknown; stdout?: string; stderr?: string };
      return { code: typeof failed.code === 'number' ? failed.code : -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? '' };
    }
  } finally {
    rmSync(harness, { recursive: true, force: true });
  }
}

test('timon doctor from a packaged CLI says the update is pending, still lists its findings, and leaves the data untouched (TODO #593)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-packaged-doctor-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, 'timon.db');
  const seed = new Database(dbPath);
  seed.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('kept')");
  seed.close();
  writeDataVersion(home, '0.1.0');
  const before = readFileSync(dbPath);
  const entries = readdirSync(home).sort();
  const version = timonVersion().replace(/\./g, '\\.');

  const text = await runPackagedCli(home, ['doctor']);
  assert.equal(text.code, 1, text.stdout + text.stderr);
  assert.match(text.stdout, new RegExp(`^Update pending: These data were last used by Timon 0\\.1\\.0 and Timon ${version} is not yet approved`));
  assert.match(text.stdout, new RegExp(`timon update approve ${version}\\.\\n`));
  // The support report's findings, built without the database, follow the refusal.
  assert.match(text.stdout, /\nFindings:\n/);
  assert.match(text.stdout, new RegExp(`The data were last opened by Timon 0\\.1\\.0, this is ${version}`));
  assert.doesNotMatch(text.stderr, /PackagedCliUpdatePendingError|dist\/doctor\.js not found/);

  const json = await runPackagedCli(home, ['doctor', '--json']);
  assert.equal(json.code, 1, json.stdout + json.stderr);
  const report = JSON.parse(json.stdout) as { ok?: unknown; updatePending?: unknown };
  assert.equal(report.ok, false);
  assert.match(String(report.updatePending), /These data were last used by Timon 0\.1\.0/);

  // Refused means unopened: not one migration, no WAL, no copy, no approval, version unchanged.
  assert.deepEqual(readFileSync(dbPath), before);
  assert.deepEqual(readdirSync(home).sort(), entries);
  assert.equal(readDataVersion(home), '0.1.0');
  assert.equal(existsSync(updateApprovalFile(home)), false);
  assert.equal(existsSync(backupsDir(home)), false);
});

/**
 * The other packaged process of TODO #592 (the daemon, in practice): it takes the data lock, waits
 * for the word, then copies and migrates as db.ts does.
 */
function startCopyingProcess(home: string): { held: Promise<void>; go: () => void; done: Promise<string> } {
  const script = join(home, 'daemon-witness.mjs');
  const module = (name: string) => JSON.stringify(new URL(name, import.meta.url).href);
  writeFileSync(script, `
    const { default: Database } = await import(${JSON.stringify(pathToFileURL(createRequire(import.meta.url).resolve('better-sqlite3')).href)});
    const { holdDataOpenLock, releaseDataOpenLock } = await import(${module('./data-open-lock.ts')});
    const { protectDataBeforeOpen, timonVersion } = await import(${module('./data-version.ts')});
    const home = process.env.TIMON_HOME;
    holdDataOpenLock(home);
    console.log('held');
    await new Promise((resolve) => process.stdin.once('data', resolve));
    const files = { home, dbPath: ${JSON.stringify(join(home, 'timon.db'))}, configPath: ${JSON.stringify(join(home, 'timon.config.json'))} };
    const outcome = protectDataBeforeOpen(files, timonVersion(), { now: () => 4242, warn: () => {} });
    const db = new Database(files.dbPath);
    db.exec('CREATE TABLE migrated_by_daemon (x)');
    db.close();
    releaseDataOpenLock(home);
    console.log('outcome ' + outcome);
  `);
  const child = spawn(process.execPath, ['--import', 'tsx', script], {
    env: { ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString(); });
  const held = new Promise<void>((resolve, reject) => {
    child.stdout.on('data', () => { if (output.includes('held')) resolve(); });
    child.once('exit', () => reject(new Error(`copying process exited early: ${output}`)));
  });
  const done = new Promise<string>((resolve) => child.once('exit', () => resolve(output)));
  return { held, go: () => { child.stdin.end('go\n'); }, done };
}

test('a packaged CLI approved while the daemon copies and migrates waits for it, then neither copies nor migrates twice (TODO #592)', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-packaged-cli-race-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dbPath = join(home, 'timon.db');
  const seed = new Database(dbPath);
  seed.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('kept')");
  seed.close();
  writeDataVersion(home, '0.1.0');
  const version = timonVersion();
  writeFileSync(updateApprovalFile(home), `${JSON.stringify({ version, approvedAt: Date.now() })}\n`);

  const daemon = startCopyingProcess(home);
  await daemon.held;
  // The CLI starts while the daemon is between its approval and its last migration.
  const witness = join(home, 'packaged-cli-witness.mjs');
  writeFileSync(witness, `
    Object.defineProperty(process.versions, 'electron', { value: '38.0.0' });
    await import(${JSON.stringify(new URL('./db.ts', import.meta.url).href)});
    console.log('opened');
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' };
  delete env.TIMON_DESKTOP_EMBEDDED;
  delete env.TIMON_DESKTOP_SERVICE;
  const cli = spawn(process.execPath, ['--import', 'tsx', witness], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let cliOutput = '';
  const cliDone = new Promise<number | null>((resolve) => cli.once('exit', resolve));
  // The daemon goes on once the CLI says it waits; a CLI that opens without waiting lets it go too, late.
  await new Promise<void>((resolve) => {
    const read = (chunk: Buffer) => { cliOutput += chunk.toString(); if (/waiting for it to finish/.test(cliOutput)) resolve(); };
    cli.stdout.on('data', read);
    cli.stderr.on('data', read);
    void cliDone.then(() => resolve());
  });
  daemon.go();
  const daemonOutput = await daemon.done;
  assert.equal(await cliDone, 0, cliOutput);
  assert.match(cliOutput, /waiting for it to finish/);
  assert.match(cliOutput, /opened/);
  // The daemon made the only copy, before anything migrated.
  assert.match(daemonOutput, /outcome snapshot/);
  const snapshot = join(backupsDir(home), snapshotName(version));
  assert.equal(readSnapshotMeta(snapshot)?.createdAt, 4242);
  const copy = new Database(join(snapshot, 'timon.db'), { readonly: true });
  try {
    assert.deepEqual(copy.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), [{ name: 'notes' }]);
  } finally {
    copy.close();
  }
  assert.equal(readDataVersion(home), version);
  // The CLI migrated what the daemon left: both changes are there, the data too.
  const after = new Database(dbPath, { readonly: true });
  try {
    const tables = (after.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    assert.ok(tables.includes('migrated_by_daemon') && tables.includes('tasks'), tables.join(', '));
    assert.deepEqual(after.prepare('SELECT value FROM notes').all(), [{ value: 'kept' }]);
  } finally {
    after.close();
  }
});
