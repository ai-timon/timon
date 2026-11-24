/**
 * `plugins` and `plugins-data` must travel with an export/import: they are
 * the install itself (the third-party plugins) and their data, not
 * rebuildable cache. See paths.ts §ZONES and docs/PLAN §10.10.
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, symlinkSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire as createRequireFn } from 'node:module';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-export-test-'));
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

const { exportTimon, importTimon, removeOrMoveAside } = await import('./export.js');
const { ZONES } = await import('./paths.js');
const { timonVersion, updateNeedsApproval } = await import('./data-version.js');

test('plugins and plugins-data are declared in ZONES.config', () => {
  assert.ok((ZONES.config as readonly string[]).includes('plugins'));
  assert.ok((ZONES.config as readonly string[]).includes('plugins-data'));
});

test('an export takes the installed plugins and their data, and an import restores them', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-plugins-'));
  mkdirSync(join(home, 'plugins', 'timon-example-plugin'), { recursive: true });
  writeFileSync(
    join(home, 'plugins', 'timon-example-plugin', 'package.json'),
    '{"name":"timon-example-plugin"}\n',
  );
  mkdirSync(join(home, 'plugins-data', 'timon-example-plugin'), { recursive: true });
  writeFileSync(
    join(home, 'plugins-data', 'timon-example-plugin', 'state.json'),
    '{"compteur":42}\n',
  );

  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-plugins-archive-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });

  const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.ok(
    listing.includes('plugins/timon-example-plugin/package.json'),
    'the installed plugin must be in the archive',
  );
  assert.ok(
    listing.includes('plugins-data/timon-example-plugin/state.json'),
    "the plugin's data must be in the archive",
  );

  const to = mkdtempSync(join(tmpdir(), 'timon-import-plugins-'));
  importTimon({ file: out, to });

  const pkg = readFileSync(join(to, 'plugins', 'timon-example-plugin', 'package.json'), 'utf8');
  assert.equal(pkg, '{"name":"timon-example-plugin"}\n');
  const state = readFileSync(join(to, 'plugins-data', 'timon-example-plugin', 'state.json'), 'utf8');
  assert.equal(state, '{"compteur":42}\n');
});

test('TIM-0039: the avatars (uploads/avatars) make the export → import round trip', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-avatar-'));
  mkdirSync(join(home, 'uploads', 'avatars'), { recursive: true });
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0xfe, 0x00]);
  writeFileSync(join(home, 'uploads', 'avatars', 'a.png'), png);
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-avatar-out-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });
  const to = mkdtempSync(join(tmpdir(), 'timon-import-avatar-'));
  importTimon({ file: out, to });
  assert.deepEqual(readFileSync(join(to, 'uploads', 'avatars', 'a.png')), png);
});

test('TIM-0040: an import replaces agents/ instead of merging it (the fresh _main disappears)', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-main-'));
  mkdirSync(join(home, 'agents', 'Alice'), { recursive: true });
  writeFileSync(join(home, 'agents', 'Alice', 'config.json'), '{"role":"orchestrator"}\n');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-main-out-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });

  const to = mkdtempSync(join(tmpdir(), 'timon-import-main-'));
  mkdirSync(join(to, 'agents', '_main'), { recursive: true });
  writeFileSync(join(to, 'agents', '_main', 'config.json'), '{"role":"orchestrator"}\n');
  importTimon({ file: out, to, force: true });

  assert.ok(existsSync(join(to, 'agents', 'Alice', 'config.json')));
  assert.equal(existsSync(join(to, 'agents', '_main')), false);
});

test('TIM-0041: an import --force replaces timon.db and purges its stale -wal/-shm', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-db-'));
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-db-out-')), 'export.tar.gz');
  writeFileSync(join(home, 'timon.db'), 'new');
  exportTimon({ out, home, vacuumInto: (dest) => writeFileSync(dest, 'new') });

  const to = mkdtempSync(join(tmpdir(), 'timon-import-db-'));
  writeFileSync(join(to, 'timon.db'), 'old');
  writeFileSync(join(to, 'timon.db-wal'), 'stale');
  writeFileSync(join(to, 'timon.db-shm'), 'stale');
  importTimon({ file: out, to, force: true });

  assert.equal(readFileSync(join(to, 'timon.db'), 'utf8'), 'new');
  assert.equal(existsSync(join(to, 'timon.db-wal')), false);
  assert.equal(existsSync(join(to, 'timon.db-shm')), false);
});

test('TODO #547: integrations.db (connections, receipts) makes the round trip, even open in WAL', () => {
  const Database = createRequireFn(import.meta.url)('better-sqlite3');
  assert.ok((ZONES.state as readonly string[]).includes('integrations.db'));
  const home = mkdtempSync(join(tmpdir(), 'timon-export-integrations-'));
  // Held open in WAL, never checkpointed: a plain file copy would carry an
  // empty table and lose the row.
  const live = new Database(join(home, 'integrations.db'));
  live.pragma('journal_mode = WAL');
  live.pragma('wal_autocheckpoint = 0');
  live.exec('CREATE TABLE receipts (id TEXT PRIMARY KEY)');
  live.prepare('INSERT INTO receipts VALUES (?)').run('r-1');
  try {
    const out = join(mkdtempSync(join(tmpdir(), 'timon-export-integrations-out-')), 'export.tar.gz');
    exportTimon({ out, home, vacuumInto: () => {} });

    const to = mkdtempSync(join(tmpdir(), 'timon-import-integrations-'));
    writeFileSync(join(to, 'integrations.db-wal'), 'stale');
    writeFileSync(join(to, 'integrations.db-shm'), 'stale');
    importTimon({ file: out, to, force: true });

    assert.equal(existsSync(join(to, 'integrations.db-wal')), false);
    assert.equal(existsSync(join(to, 'integrations.db-shm')), false);
    const restored = new Database(join(to, 'integrations.db'), { readonly: true });
    try {
      assert.deepEqual(restored.prepare('SELECT id FROM receipts').all(), [{ id: 'r-1' }]);
    } finally {
      restored.close();
    }
  } finally {
    live.close();
  }
});

function errnoError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

test('TIM-0110: an EPERM/EACCES refusal keeps the original codes and does not talk about a lock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-replace-'));
  const file = join(dir, 'timon.db');
  writeFileSync(file, 'old');
  assert.throws(
    () =>
      removeOrMoveAside(file, {
        remove: () => {
          throw errnoError('EPERM', 'operation not permitted, unlink');
        },
        moveAside: () => {
          throw errnoError('EACCES', 'permission denied, rename');
        },
      }),
    (err: Error) => {
      assert.match(err.message, /remove EPERM: operation not permitted/);
      assert.match(err.message, /rename EACCES: permission denied/);
      assert.match(err.message, /permissions problem/);
      assert.doesNotMatch(err.message, /locked by another process|service stop/);
      assert.equal((err.cause as NodeJS.ErrnoException).code, 'EACCES');
      return true;
    },
  );
});

test('TIM-0110: a real EBUSY is announced as a lock, with a command that exists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-replace-'));
  const file = join(dir, 'timon.db');
  writeFileSync(file, 'old');
  assert.throws(
    () =>
      removeOrMoveAside(file, {
        remove: () => {
          throw errnoError('EBUSY', 'resource busy or locked, unlink');
        },
        moveAside: () => {
          throw errnoError('EBUSY', 'resource busy or locked, rename');
        },
      }),
    (err: Error) => {
      assert.match(err.message, /remove EBUSY/);
      assert.match(err.message, /holds it/);
      assert.match(err.message, /timon service uninstall/);
      assert.doesNotMatch(err.message, /service stop/);
      return true;
    },
  );
});

test('TIM-0110: a refused deletion falls back on moving, another error goes up as is', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-replace-'));
  const file = join(dir, 'timon.db');
  writeFileSync(file, 'old');
  const moved: string[] = [];
  removeOrMoveAside(file, {
    remove: () => {
      throw errnoError('EPERM', 'denied');
    },
    moveAside: (_from, to) => moved.push(to),
  });
  assert.equal(moved.length, 1);
  assert.match(moved[0]!, /timon\.db\.replaced-\d+$/);

  assert.throws(
    () =>
      removeOrMoveAside(file, {
        remove: () => {
          throw errnoError('ENOTEMPTY', 'not empty');
        },
        moveAside: () => assert.fail('no move aside for a non-busy error'),
      }),
    { code: 'ENOTEMPTY' },
  );
});

function projectArchive(): string {
  const Database = createRequireFn(import.meta.url)('better-sqlite3');
  const home = mkdtempSync(join(tmpdir(), 'timon-export-proj-'));
  mkdirSync(join(home, 'projects', 'alpha'), { recursive: true });
  writeFileSync(join(home, 'projects', 'alpha', 'roles.json'), '{}\n');
  writeFileSync(join(home, 'timon.db'), '');
  const here = mkdtempSync(join(tmpdir(), 'timon-export-proj-cwd-'));
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-proj-out-')), 'export.tar.gz');
  exportTimon({
    out,
    home,
    vacuumInto: (dest) => {
      const db = new Database(dest);
      db.exec('CREATE TABLE projects (slug TEXT PRIMARY KEY, cwd TEXT)');
      db.prepare('INSERT INTO projects VALUES (?, ?)').run('alpha', join(here, 'does-not-exist'));
      db.prepare('INSERT INTO projects VALUES (?, ?)').run('beta', here);
      db.close();
    },
  });
  return out;
}

test('TIM-0056: an import reports the projects whose folder cannot be found', () => {
  const to = mkdtempSync(join(tmpdir(), 'timon-import-proj-'));
  const result = importTimon({ file: projectArchive(), to });
  assert.deepEqual(result.missingProjects.map((p) => p.slug), ['alpha']);
  assert.equal(result.skippedProjects, 0);
  assert.ok(existsSync(join(to, 'projects', 'alpha', 'roles.json')));
});

test('TIM-0056: skipProjects restores neither projects/ nor the projects table', () => {
  const to = mkdtempSync(join(tmpdir(), 'timon-import-noproj-'));
  mkdirSync(join(to, 'projects', 'old'), { recursive: true });
  const result = importTimon({ file: projectArchive(), to, force: true, skipProjects: true });
  assert.equal(result.skippedProjects, 2);
  assert.deepEqual(result.missingProjects, []);
  assert.equal(existsSync(join(to, 'projects')), false);
  const Database = createRequireFn(import.meta.url)('better-sqlite3');
  const db = new Database(join(to, 'timon.db'), { readonly: true });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n, 0);
  db.close();
});

test('SUG-0063: a plugin installed from a folder (link) travels in the export and the import', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-link-'));
  const external = mkdtempSync(join(tmpdir(), 'timon-export-link-src-'));
  writeFileSync(join(external, 'index.js'), 'export {};\n');
  mkdirSync(join(home, 'plugins', 'node_modules', '@acme'), { recursive: true });
  symlinkSync(external, join(home, 'plugins', 'node_modules', '@acme', 'local'), 'junction');
  // Agent log: left out without --with-archive, whatever the path separator.
  mkdirSync(join(home, 'agents', 'a', 'memory'), { recursive: true });
  writeFileSync(join(home, 'agents', 'a', 'memory', 'log.jsonl'), '{}\n');
  writeFileSync(join(home, 'agents', 'a', 'memory', 'learnings.jsonl'), '{}\n');

  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-link-archive-')), 'export.tar.gz');
  exportTimon({ out, home, vacuumInto: () => {} });
  const listing = execFileSync('tar', ['-tzf', out], { encoding: 'utf8' });
  assert.ok(listing.includes('plugins/node_modules/@acme/local'), 'the link is in the archive');
  assert.ok(!listing.includes('memory/log.jsonl'));
  assert.ok(listing.includes('memory/learnings.jsonl'));

  const to = mkdtempSync(join(tmpdir(), 'timon-import-link-'));
  importTimon({ file: out, to });
  assert.ok(lstatSync(join(to, 'plugins', 'node_modules', '@acme', 'local')).isSymbolicLink());
});

/**
 * Runs `body` the way `timon import` / `timon export` load this module: a new
 * process with nothing else imported. In-process tests cannot see TIM-0133,
 * whose cause is what the module pulls in when it loads.
 */
async function inFreshCli(home: string, body: string, opts: { packaged?: boolean } = {}): Promise<string> {
  const witness = join(mkdtempSync(join(tmpdir(), 'timon-export-witness-')), 'witness.mjs');
  writeFileSync(witness, `
    ${opts.packaged ? "Object.defineProperty(process.versions, 'electron', { value: '38.0.0' });" : ''}
    const { exportTimon, importTimon } = await import(${JSON.stringify(new URL('./export.ts', import.meta.url).href)});
    const { readdirSync, readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    ${body}
  `);
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' };
  delete env.TIMON_DESKTOP_EMBEDDED;
  delete env.TIMON_DESKTOP_SERVICE;
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', witness], { env, timeout: 60_000 });
  return stdout;
}

/** A closed WAL database: reopening it recreates `-wal` and `-shm` beside it. */
function seedWalDatabase(file: string, value: string): void {
  const db = new (createRequireFn(import.meta.url)('better-sqlite3'))(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('${value}')`);
  db.close();
}

function readNote(file: string): string {
  const db = new (createRequireFn(import.meta.url)('better-sqlite3'))(file, { readonly: true });
  try {
    return (db.prepare('SELECT value FROM notes').get() as { value: string }).value;
  } finally {
    db.close();
  }
}

test('TIM-0133: loading the CLI export module creates no database in an empty home', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-fresh-'));
  await inFreshCli(home, '');
  assert.deepEqual(readdirSync(home), []);
});

test('TIM-0133: a CLI import --force holds no handle on the database it replaces', async () => {
  const source = mkdtempSync(join(tmpdir(), 'timon-export-source-'));
  seedWalDatabase(join(source, 'timon.db'), 'from-archive');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-out-')), 'export.tar.gz');
  exportTimon({ out, home: source });

  const home = mkdtempSync(join(tmpdir(), 'timon-export-home-'));
  seedWalDatabase(join(home, 'timon.db'), 'old');
  const seeded = readFileSync(join(home, 'timon.db')).toString('base64');
  const stdout = await inFreshCli(home, `
    const before = {
      entries: readdirSync(process.env.TIMON_HOME),
      db: readFileSync(join(process.env.TIMON_HOME, 'timon.db')).toString('base64'),
    };
    importTimon({ file: ${JSON.stringify(out)}, force: true });
    console.log(JSON.stringify(before));
  `);

  const before = JSON.parse(stdout) as { entries: string[]; db: string };
  // Opening the database would have left -wal/-shm and run the migrations.
  assert.deepEqual(before.entries, ['timon.db']);
  assert.equal(before.db, seeded);
  assert.equal(readNote(join(home, 'timon.db')), 'from-archive');
  assert.deepEqual(readdirSync(home).filter((e) => e.includes('.replaced-')), []);
});

test('TIM-0133: a CLI export without a daemon does not migrate the database it copies', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-export-plain-'));
  const dbFile = join(home, 'timon.db');
  const db = new (createRequireFn(import.meta.url)('better-sqlite3'))(dbFile);
  db.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('kept')");
  db.close();
  const seeded = readFileSync(dbFile).toString('base64');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-plain-out-')), 'export.tar.gz');

  await inFreshCli(home, `exportTimon({ out: ${JSON.stringify(out)} });`);

  assert.equal(readFileSync(dbFile).toString('base64'), seeded);
  const restored = mkdtempSync(join(tmpdir(), 'timon-export-plain-to-'));
  importTimon({ file: out, to: restored, force: true });
  assert.equal(readNote(join(restored, 'timon.db')), 'kept');
});

test('TIM-0133: a packaged CLI import on a new install is not taken for a legacy install', async () => {
  const source = mkdtempSync(join(tmpdir(), 'timon-export-stamp-'));
  seedWalDatabase(join(source, 'timon.db'), 'from-archive');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-stamp-out-')), 'export.tar.gz');
  exportTimon({ out, home: source });
  const body = `importTimon({ file: ${JSON.stringify(out)}, force: true });`;

  const packaged = mkdtempSync(join(tmpdir(), 'timon-export-stamp-packaged-'));
  await inFreshCli(packaged, body, { packaged: true });
  const files = { home: packaged, dbPath: join(packaged, 'timon.db'), configPath: join(packaged, 'timon.config.json') };
  assert.equal(readFileSync(join(packaged, 'data-version'), 'utf8').trim(), timonVersion());
  assert.equal(updateNeedsApproval(files, timonVersion()), false);

  // A source checkout never moves the data version.
  const checkout = mkdtempSync(join(tmpdir(), 'timon-export-stamp-checkout-'));
  await inFreshCli(checkout, body);
  assert.equal(existsSync(join(checkout, 'data-version')), false);
});

test('TIM-0133: a database another process holds stops the import before anything is replaced', () => {
  const source = mkdtempSync(join(tmpdir(), 'timon-export-locked-'));
  mkdirSync(join(source, 'agents', 'imported'), { recursive: true });
  writeFileSync(join(source, 'agents', 'imported', 'config.json'), '{}');
  writeFileSync(join(source, 'timon.db'), 'new');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-locked-out-')), 'export.tar.gz');
  exportTimon({ out, home: source, vacuumInto: (dest) => writeFileSync(dest, 'new') });

  const to = mkdtempSync(join(tmpdir(), 'timon-import-locked-'));
  mkdirSync(join(to, 'agents', 'mine'), { recursive: true });
  mkdirSync(join(to, 'projects', 'mine'), { recursive: true });
  writeFileSync(join(to, 'timon.db'), 'old');
  const busy = () => {
    throw errnoError('EBUSY', 'resource busy or locked');
  };

  assert.throws(
    () => importTimon({
      file: out,
      to,
      force: true,
      skipProjects: true,
      replaceOps: { remove: busy, moveAside: busy },
    }),
    /cannot replace .*timon\.db.*holds it/,
  );

  assert.equal(readFileSync(join(to, 'timon.db'), 'utf8'), 'old');
  assert.equal(existsSync(join(to, 'agents', 'mine')), true);
  assert.equal(existsSync(join(to, 'agents', 'imported')), false);
  assert.equal(existsSync(join(to, 'projects', 'mine')), true);
});

test('an import without --force is refused on a home in use and changes nothing', () => {
  const source = mkdtempSync(join(tmpdir(), 'timon-export-refused-'));
  writeFileSync(join(source, 'timon.db'), 'new');
  const out = join(mkdtempSync(join(tmpdir(), 'timon-export-refused-out-')), 'export.tar.gz');
  exportTimon({ out, home: source, vacuumInto: (dest) => writeFileSync(dest, 'new') });

  const to = mkdtempSync(join(tmpdir(), 'timon-import-refused-'));
  writeFileSync(join(to, 'timon.db'), 'old');

  assert.throws(() => importTimon({ file: out, to }), /--force/);
  assert.equal(readFileSync(join(to, 'timon.db'), 'utf8'), 'old');
  assert.deepEqual(readdirSync(to), ['timon.db']);
});
