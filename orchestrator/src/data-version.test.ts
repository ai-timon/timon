/** Versions, first copies and destructive migrations (fixtures: data-version-fixtures.ts). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyPendingRestore,
  backupsDir,
  compareVersions,
  DataSnapshotError,
  DESTRUCTIVE_MIGRATIONS,
  pendingDestructiveMigrations,
  packagedDaemon,
  protectDataBeforeOpen,
  readDataVersion,
  readSnapshotFailure,
  readSnapshotMeta,
  writeDataVersion,
  unpackagedDataNotice,
  type DataFiles,
  type DestructiveMigration,
} from './data-version.js';
import { home, fixtureDb, seed, notes, quiet, requestRestore, seedPlugins } from './data-version-fixtures.js';

test('the fixture databases keep their rows in the WAL without syncing it', () => {
  const files = home();
  const live = seed(files, 'in the wal');
  try {
    assert.equal(live.pragma('synchronous', { simple: true }), 0);
    assert.equal(live.pragma('journal_mode', { simple: true }), 'wal');
    assert.ok(statSync(`${files.dbPath}-wal`).size > 0);
    assert.deepEqual(notes(files.dbPath), ['in the wal']);
  } finally {
    live.close();
  }
});

test('compareVersions orders release versions, pre-releases first, and refuses anything else', () => {
  assert.equal(compareVersions('0.1.1', '0.1.0'), 1);
  assert.equal(compareVersions('0.1.0', '0.1.1'), -1);
  assert.equal(compareVersions('0.10.0', '0.9.9'), 1);
  assert.equal(compareVersions('0.2.0-beta.1', '0.2.0'), -1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('current', '0.1.0'), null);
});

test('compareVersions orders pre-releases by SemVer, never as strings: rc.10 comes after rc.9', () => {
  assert.equal(compareVersions('0.1.6-rc.10', '0.1.6-rc.9'), 1);
  assert.equal(compareVersions('0.1.6-rc.9', '0.1.6-rc.10'), -1);
  assert.equal(compareVersions('0.1.6-rc.10', '0.1.6'), -1, 'any rc still comes before its final version');
  assert.equal(compareVersions('0.1.6-rc.2', '0.1.6-rc.2'), 0);
  // SemVer §11: numeric before alphanumeric, a longer tag after its prefix, alphanumerics in ASCII order.
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  assert.equal(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta'), -1);
  assert.equal(compareVersions('1.0.0-alpha.beta', '1.0.0-beta'), -1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0-beta.11'), -1);
  assert.equal(compareVersions('1.0.0-beta.11', '1.0.0-rc.1'), -1);
});

test('only packaged daemons protect their data', () => {
  assert.equal(packagedDaemon({}), false);
  assert.equal(packagedDaemon({ TIMON_DESKTOP_EMBEDDED: '1' }), true);
  assert.equal(packagedDaemon({ TIMON_DESKTOP_SERVICE: '1' }), true);
});

test('a first start on a fresh directory records the version without any copy', () => {
  const files = home();
  assert.equal(protectDataBeforeOpen(files, '0.1.1', quiet), 'fresh');
  assert.equal(readDataVersion(files.home), '0.1.1');
  assert.equal(existsSync(backupsDir(files.home)), false);
});

test('the first start of a newer version copies the database, WAL included, and the config', () => {
  const files = home();
  const live = seed(files, 'written by 0.1.0');
  writeFileSync(files.configPath, '{"edition":"expert"}');
  try {
    // No data-version: the 0.1.0 installs, which predate this file.
    assert.equal(protectDataBeforeOpen(files, '0.1.1', { ...quiet, now: () => 42 }), 'snapshot');
  } finally {
    live.close();
  }
  const dir = join(backupsDir(files.home), 'pre-0.1.1');
  assert.deepEqual(notes(join(dir, 'timon.db')), ['written by 0.1.0']);
  assert.equal(readFileSync(join(dir, 'timon.config.json'), 'utf8'), '{"edition":"expert"}');
  assert.deepEqual(readSnapshotMeta(dir), { from: null, to: '0.1.1', createdAt: 42, config: true, pluginCopies: { plugins: { state: 'absent' }, 'plugins-data': { state: 'absent' } }, integrations: 'absent' });
  assert.equal(readDataVersion(files.home), '0.1.1');
  // Same version again: nothing to do.
  assert.equal(protectDataBeforeOpen(files, '0.1.1', quiet), 'current');
});

test('an older version leaves data-version and the copies alone', () => {
  const files = home();
  seed(files, 'x').close();
  writeDataVersion(files.home, '0.1.2');
  assert.equal(protectDataBeforeOpen(files, '0.1.1', quiet), 'older');
  assert.equal(readDataVersion(files.home), '0.1.2');
  assert.equal(existsSync(backupsDir(files.home)), false);
});

// TIM-0087: the Windows service installed by the CLI of 0.1.3 and earlier ran
// unpackaged, migrated without a copy and left data-version behind, silently.
test('an unpackaged daemon logs that it opens data of an older release, and writes nothing', () => {
  const files = home();
  assert.equal(unpackagedDataNotice(files, '0.1.5'), null, 'no database yet');
  seed(files, 'x').close();
  assert.equal(unpackagedDataNotice(files, '0.1.5'), null, 'no data-version: a source checkout, nothing recorded');
  writeDataVersion(files.home, '0.1.2');
  const notice = unpackagedDataNotice(files, '0.1.5');
  assert.match(notice ?? '', /Timon 0\.1\.5 is not running as the app's daemon/);
  assert.match(notice ?? '', /last used by Timon 0\.1\.2 without update approval or a backup, and leaves data-version at 0\.1\.2/);
  assert.equal(readDataVersion(files.home), '0.1.2');
  assert.equal(existsSync(backupsDir(files.home)), false);
  assert.equal(unpackagedDataNotice(files, '0.1.2'), null, 'same release');
  assert.equal(unpackagedDataNotice(files, '0.1.1'), null, 'an older daemon');
  assert.equal(unpackagedDataNotice(files, 'current'), null, 'not a release version');
});

test('only the three most recent copies are kept', () => {
  const files = home();
  seed(files, 'x').close();
  seedPlugins(files, 'rotated');
  let clock = 0;
  for (const version of ['0.1.1', '0.1.2', '0.1.3', '0.1.4']) {
    assert.equal(protectDataBeforeOpen(files, version, { ...quiet, now: () => ++clock }), 'snapshot');
  }
  assert.deepEqual(readdirSync(backupsDir(files.home)).sort(), ['pre-0.1.2', 'pre-0.1.3', 'pre-0.1.4', 'snapshot-progress.json']);
  for (const version of ['0.1.2', '0.1.3', '0.1.4']) {
    assert.equal(readFileSync(join(backupsDir(files.home), `pre-${version}`, 'plugins-data', 'sample', 'state'), 'utf8'), 'rotated');
  }
});

/** Drops `notes.legacy`, which 0.1.0 would still read. */
const dropLegacy: DestructiveMigration = {
  id: 'drop-notes-legacy',
  breaks: ['notes.legacy'],
  applied: (db) => !(db.prepare('PRAGMA table_info(notes)').all() as { name: string }[]).some((c) => c.name === 'legacy'),
};

/** Valid data whose copy fails: the configuration path is a directory, copyFile refuses it. */
function uncopyable(withLegacy: boolean): DataFiles {
  const files = home();
  const db = fixtureDb(files.dbPath);
  db.exec(`CREATE TABLE notes (value TEXT${withLegacy ? ', legacy TEXT' : ''})`);
  db.prepare('INSERT INTO notes (value) VALUES (?)').run('kept');
  db.close();
  mkdirSync(files.configPath);
  writeDataVersion(files.home, '0.1.0');
  return files;
}

test('the registry holds only the move of the account tables (TODO #906)', () => {
  assert.deepEqual(DESTRUCTIVE_MIGRATIONS.map((m) => m.id), ['account-tables-to-file']);
});

test('a declared destructive migration is pending until its guard sees it applied', () => {
  assert.deepEqual(pendingDestructiveMigrations(uncopyable(true).dbPath, [dropLegacy]), ['drop-notes-legacy']);
  assert.deepEqual(pendingDestructiveMigrations(uncopyable(false).dbPath, [dropLegacy]), []);
  assert.deepEqual(pendingDestructiveMigrations(uncopyable(true).dbPath, []), []);
  // Unreadable: assume the worst.
  const files = home();
  writeFileSync(files.dbPath, 'not a database');
  assert.deepEqual(pendingDestructiveMigrations(files.dbPath, [dropLegacy]), ['drop-notes-legacy']);
});

test('without a copy, additive migrations still start, with a warning and a retry at the next start', () => {
  const files = uncopyable(false);
  const warnings: string[] = [];
  const outcome = protectDataBeforeOpen(files, '0.1.1', { warn: (m) => warnings.push(m), now: () => 3, destructive: [dropLegacy] });
  assert.equal(outcome, 'unprotected');
  assert.match(warnings.join('\n'), /started without saving a copy/);
  assert.equal(readDataVersion(files.home), '0.1.0');
  const failure = readSnapshotFailure(files.home);
  assert.equal(failure?.blocking, false);
  assert.equal(failure?.at, 3);
  assert.deepEqual(readdirSync(backupsDir(files.home)), ['snapshot-failure.json', 'snapshot-progress.json']);
  // Next start: the copy works, the warning goes away.
  rmSync(files.configPath, { recursive: true });
  assert.equal(protectDataBeforeOpen(files, '0.1.1', { ...quiet, destructive: [dropLegacy] }), 'snapshot');
  assert.equal(readSnapshotFailure(files.home), null);
  assert.equal(readDataVersion(files.home), '0.1.1');
});

test('without a copy, a pending destructive migration stops the start and leaves the data as they were', () => {
  const files = uncopyable(true);
  const before = createHash('sha256').update(readFileSync(files.dbPath)).digest('hex');
  assert.throws(() => protectDataBeforeOpen(files, '0.1.1', { ...quiet, now: () => 5, destructive: [dropLegacy] }), (error: unknown) => {
    assert.ok(error instanceof DataSnapshotError);
    assert.deepEqual(error.migrations, ['drop-notes-legacy']);
    assert.match(error.message, /Timon 0\.1\.1 did not start/);
    // The copy of a folder fails with EISDIR on Linux, ENOTSUP on macOS, EPERM on Windows.
    assert.match(error.message, /EISDIR|ENOTSUP|EPERM|directory/);
    assert.match(error.message, /Nothing was changed/);
    return true;
  });
  assert.equal(createHash('sha256').update(readFileSync(files.dbPath)).digest('hex'), before);
  assert.equal(readDataVersion(files.home), '0.1.0');
  const failure = readSnapshotFailure(files.home);
  assert.equal(failure?.blocking, true);
  assert.equal(failure?.at, 5);
  assert.match(failure?.message ?? '', /did not start/);
});

test('a copy made without a configuration file records it, and restoring it removes the one written since', () => {
  const files = home();
  seed(files, 'no config yet').close();
  writeDataVersion(files.home, '0.1.1');
  assert.equal(protectDataBeforeOpen(files, '0.1.2', quiet), 'snapshot');
  const dir = join(backupsDir(files.home), 'pre-0.1.2');
  assert.equal(readSnapshotMeta(dir)?.config, false);
  assert.equal(existsSync(join(dir, 'timon.config.json')), false);
  writeFileSync(files.configPath, '{"v":"0.1.2"}');
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.equal(existsSync(files.configPath), false);
  assert.equal(readDataVersion(files.home), '0.1.1');
  // What was removed is still in the copy of what the restore replaced.
  assert.equal(readFileSync(join(backupsDir(files.home), 'before-restore', 'timon.config.json'), 'utf8'), '{"v":"0.1.2"}');
});
