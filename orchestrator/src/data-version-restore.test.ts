/** Restoring a copy: the swap, its failures at each step, and the running daemon. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyPendingRestore,
  snapshotRequiredBytes,
  backupsDir,
  lastRestoreFile,
  protectDataBeforeOpen,
  readDataVersion,
  readSnapshotMeta,
  restoreRequestFile,
  watchRestoreRequest,
  type DataFiles,
  type SnapshotMeta,
} from './data-version.js';
import { home, seed, notes, quiet, integrationsPath, seedIntegrations, requestRestore, downgraded, liveState, leftovers, FAILING_STEPS, windowsRename } from './data-version-fixtures.js';

test('a restore replaces the database and config, drops the stale WAL and keeps what it replaced', () => {
  const files = downgraded();
  const live = seed(files, 'after the update');
  assert.ok(existsSync(`${files.dbPath}-wal`));
  // Its latest writes still sit in the -wal, un-checkpointed. Windows will not
  // rename a database another handle holds (the restore runs at boot, before
  // the open): there the writer is closed first, which checkpoints the WAL.
  if (process.platform === 'win32') live.close();
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  const result = applyPendingRestore(files, '0.1.1', { now: () => 7 });
  if (live.open) live.close();
  assert.deepEqual(result, { id: 'r1', snapshot: 'pre-0.1.2', ok: true, error: null, at: 7 });
  assert.deepEqual(notes(files.dbPath), ['before the update']);
  assert.equal(readFileSync(files.configPath, 'utf8'), '{"v":"0.1.1"}');
  assert.equal(readDataVersion(files.home), '0.1.1');
  assert.equal(existsSync(restoreRequestFile(files.home)), false);
  assert.deepEqual(JSON.parse(readFileSync(lastRestoreFile(files.home), 'utf8')), result);
  assert.deepEqual(notes(join(backupsDir(files.home), 'before-restore', 'timon.db')), ['before the update', 'after the update']);
  // TODO #547: the receipts and connections go back with the missions they point at.
  assert.deepEqual(notes(integrationsPath(files)), ['receipt before the update']);
  assert.deepEqual(notes(join(backupsDir(files.home), 'before-restore', 'integrations.db')), ['receipt before the update', 'receipt after the update']);
});

test('TODO #547: the copy holds the integrations database, writes still in its WAL included', () => {
  const files = home();
  seed(files, 'missions').close();
  const live = seedIntegrations(files, 'receipt only in the wal');
  try {
    assert.ok(existsSync(`${integrationsPath(files)}-wal`));
    assert.equal(protectDataBeforeOpen(files, '0.1.1', quiet), 'snapshot');
  } finally {
    live.close();
  }
  const dir = join(backupsDir(files.home), 'pre-0.1.1');
  assert.deepEqual(notes(join(dir, 'integrations.db')), ['receipt only in the wal']);
  assert.equal(readSnapshotMeta(dir)?.integrations, 'saved');
  assert.ok(snapshotRequiredBytes(files) > statSync(files.dbPath).size + statSync(integrationsPath(files)).size);
});

test('TODO #547: a copy made before integrations were saved leaves the live integrations database alone', () => {
  const files = downgraded();
  const file = join(backupsDir(files.home), 'pre-0.1.2', 'snapshot.json');
  const meta = JSON.parse(readFileSync(file, 'utf8')) as SnapshotMeta;
  delete meta.integrations;
  writeFileSync(file, JSON.stringify(meta));
  rmSync(join(backupsDir(files.home), 'pre-0.1.2', 'integrations.db'));
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.deepEqual(notes(files.dbPath), ['before the update']);
  assert.deepEqual(notes(integrationsPath(files)), ['receipt before the update', 'receipt after the update']);
});

test('TODO #547: a copy that lost its integrations database is refused before anything moves', () => {
  const files = downgraded();
  const before = liveState(files);
  rmSync(join(backupsDir(files.home), 'pre-0.1.2', 'integrations.db'));
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  const result = applyPendingRestore(files, '0.1.1');
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /lost its integrations database/);
  assert.deepEqual(liveState(files), before);
});

test('a restore request for another version is left for that version', () => {
  const files = downgraded();
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  // The newer daemon still runs until the older one replaces it.
  assert.equal(applyPendingRestore(files, '0.1.2'), null);
  assert.ok(existsSync(restoreRequestFile(files.home)));
  assert.equal(readDataVersion(files.home), '0.1.2');
});

test('a restore that cannot run is reported once and never retried', () => {
  const files = downgraded();
  requestRestore(files, '../../etc', '0.1.1');
  const result = applyPendingRestore(files, '0.1.1');
  assert.equal(result?.ok, false);
  assert.match(result?.error ?? '', /invalid snapshot name/);
  assert.equal(existsSync(restoreRequestFile(files.home)), false);
  assert.equal(readDataVersion(files.home), '0.1.2');
  assert.equal(applyPendingRestore(files, '0.1.1'), null);
});




for (const step of FAILING_STEPS) {
  test(`a restore failing at ${step} leaves database, config and data-version untouched`, () => {
    const files = downgraded();
    seed(files, 'after the update').close();
    const before = liveState(files);
    requestRestore(files, 'pre-0.1.2', '0.1.1');
    const result = applyPendingRestore(files, '0.1.1', {
      fault: (at) => { if (at === step) throw new Error(`injected at ${at}`); },
    });
    assert.equal(result?.ok, false);
    assert.equal(result?.error, `injected at ${step}`);
    assert.deepEqual(liveState(files), before);
    assert.deepEqual(notes(files.dbPath), ['before the update', 'after the update']);
    assert.deepEqual(leftovers(files), []);
    // Reported once, never retried.
    assert.equal(existsSync(restoreRequestFile(files.home)), false);
    assert.equal(applyPendingRestore(files, '0.1.1'), null);
  });
}

test("with Windows' rename, a restore completes", () => {
  const files = downgraded();
  seed(files, 'after the update').close();
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1', { rename: windowsRename })?.ok, true);
  assert.deepEqual(notes(files.dbPath), ['before the update']);
  assert.equal(readFileSync(files.configPath, 'utf8'), '{"v":"0.1.1"}');
  assert.equal(readDataVersion(files.home), '0.1.1');
});

// Windows refuses to rename a database another connection holds open.
test('a failed restore keeps writes that only live in the -wal', { skip: process.platform === 'win32' }, () => {
  const files = downgraded();
  const live = seed(files, 'only in the wal');
  const before = liveState(files);
  assert.notEqual(before.wal, null);
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  const result = applyPendingRestore(files, '0.1.1', {
    fault: (at) => { if (at === 'swap:config') throw new Error('injected'); },
  });
  assert.equal(result?.ok, false);
  assert.deepEqual(liveState(files), before);
  live.close();
  assert.deepEqual(notes(files.dbPath), ['before the update', 'only in the wal']);
});

test('a restore killed in the middle of the swap is undone at the next start', () => {
  const files = downgraded();
  seed(files, 'after the update').close();
  const before = liveState(files);
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  // The state on disk at the moment the process would have died.
  const crashed = mkdtempSync(join(tmpdir(), 'timon-data-crash-'));
  applyPendingRestore(files, '0.1.1', {
    fault: (at) => { if (at === 'swap:db') cpSync(files.home, crashed, { recursive: true }); },
  });
  const copy: DataFiles = { home: crashed, dbPath: join(crashed, 'timon.db'), configPath: join(crashed, 'timon.config.json') };
  assert.ok(existsSync(join(backupsDir(crashed), 'restore-journal.json')));
  assert.notDeepEqual(liveState(copy), before);
  assert.equal(applyPendingRestore(copy, '0.1.1', { now: () => 9 }), null);
  assert.deepEqual(liveState(copy), before);
  assert.deepEqual(leftovers(copy), []);
  const last = JSON.parse(readFileSync(lastRestoreFile(crashed), 'utf8')) as { id: string; ok: boolean; at: number };
  assert.deepEqual([last.id, last.ok, last.at], ['r1', false, 9]);
});

test('a damaged copy is refused before anything moves', () => {
  const files = downgraded();
  const before = liveState(files);
  writeFileSync(join(backupsDir(files.home), 'pre-0.1.2', 'timon.db'), 'garbage');
  requestRestore(files, 'pre-0.1.2', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, false);
  assert.deepEqual(liveState(files), before);
  assert.deepEqual(leftovers(files), []);
});

test('restoring the copy made before snapshots existed forgets data-version', () => {
  const files = home();
  seed(files, '0.1.0 data').close();
  protectDataBeforeOpen(files, '0.1.1', quiet);
  requestRestore(files, 'pre-0.1.1', '0.1.1');
  assert.equal(applyPendingRestore(files, '0.1.1')?.ok, true);
  assert.equal(readDataVersion(files.home), null);
});

test('a running daemon notices a restore addressed to its version', async () => {
  const files = home();
  let fired = 0;
  const stop = watchRestoreRequest(files.home, '0.1.1', () => { fired++; }, 10);
  try {
    requestRestore(files, 'pre-0.1.2', '0.1.2');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fired, 0);
    requestRestore(files, 'pre-0.1.2', '0.1.1');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fired, 1);
  } finally {
    stop();
  }
});
