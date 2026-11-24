/**
 * The assisted installation of P3 (docs/AUTO-UPDATE.md §5): an AppImage is
 * replaced only once its copy is verified, and a failure keeps the running one;
 * the missions are counted on whichever daemon runs, old or new.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DaemonAnswerError, appImageBackupPath, debInstallCommand, missionsAtStake, previousAppImage, readMissionCount, removeAppImageBackup,
  replaceAppImage, rollBackAppImage, type AppImageFs,
} from './update-install.js';

const NEW = Buffer.from('the new AppImage');
const NEW_SHA = createHash('sha256').update(NEW).digest('hex');

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'timon appimage '));
  const appImage = join(dir, 'Timon 0.1.7.AppImage');
  writeFileSync(appImage, 'the running AppImage', { mode: 0o750 });
  const verified = join(mkdtempSync(join(tmpdir(), 'timon updates ')), 'Timon-0.1.8.AppImage');
  writeFileSync(verified, NEW, { mode: 0o644 });
  return { dir, appImage, verified };
}

/** The real file system, with one operation replaced. */
async function realFs(): Promise<AppImageFs> {
  const { access, chmod, copyFile, link, rename, rm, stat } = await import('node:fs/promises');
  const { sha256Of } = await import('./update-download.js');
  return {
    access, copyFile, link, rename, chmod, sha256: sha256Of,
    rm: (path) => rm(path, { force: true }),
    mode: async (path) => (await stat(path)).mode & 0o7777,
  };
}

test('the verified AppImage replaces the running one, executable, and the previous one waits beside it', { skip: process.platform === 'win32' }, async () => {
  const s = setup();
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA });
  assert.equal(outcome.status, 'replaced');
  assert.deepEqual(readFileSync(s.appImage), NEW);
  assert.equal(statSync(s.appImage).mode & 0o111, 0o111);
  assert.equal(readFileSync(appImageBackupPath(s.appImage), 'utf8'), 'the running AppImage');
  assert.equal(existsSync(join(s.dir, '.Timon 0.1.7.AppImage.timon-update')), false);
  if (outcome.status !== 'replaced') return;
  await outcome.restore();
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
});

test('a copy that does not hash to the signed sha256 replaces nothing and leaves nothing behind', async () => {
  const s = setup();
  await assert.rejects(replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: 'f'.repeat(64) }), /changed while it was copied/);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
  assert.equal(existsSync(join(s.dir, '.Timon 0.1.7.AppImage.timon-update')), false);
});

test('a replacement that fails at the last rename keeps the running AppImage', async () => {
  const s = setup();
  const fs = await realFs();
  const failing: AppImageFs = { ...fs, rename: async () => { throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); } };
  await assert.rejects(replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA }, failing), /EBUSY/);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
});

test('without hard links, the previous AppImage is copied', async () => {
  const s = setup();
  const fs = await realFs();
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA },
    { ...fs, link: async () => { throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); } });
  assert.equal(outcome.status, 'replaced');
  assert.equal(readFileSync(appImageBackupPath(s.appImage), 'utf8'), 'the running AppImage');
});

test('a folder that cannot be written: nothing is touched, and it is said', async () => {
  const s = setup();
  const fs = await realFs();
  let copied = false;
  const outcome = await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA }, {
    ...fs,
    access: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); },
    copyFile: async () => { copied = true; },
  });
  assert.deepEqual(outcome, { status: 'not_writable' });
  assert.equal(copied, false);
  assert.equal(readFileSync(s.appImage, 'utf8'), 'the running AppImage');
});

test('a relative AppImage path is refused before anything is read', async () => {
  await assert.rejects(replaceAppImage({ appImage: 'Timon.AppImage', verified: '/x', sha256: NEW_SHA }), /not absolute/);
});

test('the new version removes the previous AppImage once it runs', async () => {
  const s = setup();
  await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA });
  await removeAppImageBackup(s.appImage);
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
  assert.deepEqual(readFileSync(s.appImage), NEW);
  await removeAppImageBackup(undefined);
});

/**
 * A simulated file system for "Go back to x.y.z": files by path, executable or not,
 * and every operation written down in order.
 */
function simulatedFs(files: Record<string, { content: string; executable: boolean }>) {
  const ops: string[] = [];
  return {
    files, ops,
    fs: {
      access: async (path: string, mode: number) => {
        ops.push(`access ${path}`);
        const file = files[path];
        if (!file || (mode & 0o1 && !file.executable)) throw Object.assign(new Error(`ENOENT ${path}`), { code: 'ENOENT' });
      },
      rename: async (from: string, to: string) => {
        ops.push(`rename ${from} -> ${to}`);
        const file = files[from];
        if (!file) throw Object.assign(new Error(`ENOENT ${from}`), { code: 'ENOENT' });
        files[to] = file;
        delete files[from];
      },
      rm: async (path: string) => { ops.push(`rm ${path}`); delete files[path]; },
    },
  };
}

const LAUNCHED = '/home/me/Applications/Timon.AppImage';
const PREVIOUS = '/home/me/Applications/.Timon.AppImage.previous';
const STAGED = '/home/me/Applications/.Timon.AppImage.timon-update';

test('going back puts the previous AppImage under the launched name, then queues its start', { skip: process.platform === 'win32' }, async () => {
  const sim = simulatedFs({
    [LAUNCHED]: { content: '0.2.0', executable: true }, [PREVIOUS]: { content: '0.1.8', executable: true },
    [STAGED]: { content: 'half a copy', executable: false },
  });
  const relaunched: string[] = [];
  const outcome = await rollBackAppImage(LAUNCHED, async (path) => { relaunched.push(`${path}: ${sim.files[path]!.content}`); }, sim.fs);
  assert.deepEqual(outcome, { status: 'relaunched' });
  assert.deepEqual(relaunched, [`${LAUNCHED}: 0.1.8`], 'the previous version is what starts, under the launched name');
  assert.deepEqual(Object.keys(sim.files), [LAUNCHED]);
  assert.deepEqual(sim.ops, [`access ${PREVIOUS}`, `rename ${PREVIOUS} -> ${LAUNCHED}`, `rm ${STAGED}`]);
});

test('without a previous AppImage there is nothing to go back to, and nothing is touched', { skip: process.platform === 'win32' }, async () => {
  for (const files of [
    { [LAUNCHED]: { content: '0.2.0', executable: true } },
    // A previous file that lost its executable bit would not start: no button either.
    { [LAUNCHED]: { content: '0.2.0', executable: true }, [PREVIOUS]: { content: '0.1.8', executable: false } },
  ]) {
    const sim = simulatedFs(files);
    assert.equal(await previousAppImage(LAUNCHED, sim.fs.access), null);
    let relaunched = false;
    assert.deepEqual(await rollBackAppImage(LAUNCHED, async () => { relaunched = true; }, sim.fs), { status: 'missing' });
    assert.equal(relaunched, false);
    assert.equal(sim.files[LAUNCHED]!.content, '0.2.0');
    assert.ok(sim.ops.every(op => op.startsWith('access ')), sim.ops.join('\n'));
  }
  const sim = simulatedFs({ [PREVIOUS]: { content: '0.1.8', executable: true } });
  for (const appImage of [undefined, '', 'Timon.AppImage', '/x\0y']) {
    assert.equal(await previousAppImage(appImage, sim.fs.access), null, String(appImage));
    assert.deepEqual(await rollBackAppImage(appImage, async () => {}, sim.fs), { status: 'missing' });
  }
  assert.deepEqual(sim.ops, [], 'a path that is not absolute is never looked at');
});

test('the previous AppImage is found beside the launched one', { skip: process.platform === 'win32' }, async () => {
  const sim = simulatedFs({ [PREVIOUS]: { content: '0.1.8', executable: true } });
  assert.equal(await previousAppImage(LAUNCHED, sim.fs.access), PREVIOUS);
});

test('a start that cannot be queued still leaves the previous version in place, and says so', { skip: process.platform === 'win32' }, async () => {
  const sim = simulatedFs({ [LAUNCHED]: { content: '0.2.0', executable: true }, [PREVIOUS]: { content: '0.1.8', executable: true } });
  const outcome = await rollBackAppImage(LAUNCHED, async () => { throw new Error('Could not create the restart control pipe.'); }, sim.fs);
  assert.deepEqual(outcome, { status: 'restored', message: 'Could not create the restart control pipe.' });
  assert.equal(sim.files[LAUNCHED]!.content, '0.1.8');
});

test('a rename that fails keeps the new AppImage and starts nothing', { skip: process.platform === 'win32' }, async () => {
  const sim = simulatedFs({ [LAUNCHED]: { content: '0.2.0', executable: true }, [PREVIOUS]: { content: '0.1.8', executable: true } });
  let relaunched = false;
  const outcome = await rollBackAppImage(LAUNCHED, async () => { relaunched = true; }, {
    ...sim.fs, rename: async () => { throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' }); },
  });
  assert.deepEqual(outcome, { status: 'failed', message: 'EROFS: read-only file system' });
  assert.equal(relaunched, false);
  assert.equal(sim.files[LAUNCHED]!.content, '0.2.0');
  assert.equal(sim.files[PREVIOUS]!.content, '0.1.8');
});

test('on the real file system, an install then a refusal brings the running AppImage back', { skip: process.platform === 'win32' }, async () => {
  const s = setup();
  await replaceAppImage({ appImage: s.appImage, verified: s.verified, sha256: NEW_SHA });
  assert.equal(await previousAppImage(s.appImage), appImageBackupPath(s.appImage));
  const relaunched: string[] = [];
  assert.deepEqual(await rollBackAppImage(s.appImage, async (path) => { relaunched.push(readFileSync(path, 'utf8')); }), { status: 'relaunched' });
  assert.deepEqual(relaunched, ['the running AppImage']);
  assert.equal(statSync(s.appImage).mode & 0o111, 0o110);
  assert.equal(existsSync(appImageBackupPath(s.appImage)), false);
  assert.equal(await previousAppImage(s.appImage), null);
});

test('the .deb command quotes its path for a POSIX shell', () => {
  assert.equal(debInstallCommand('/home/a b/.timon/updates/0.1.8/timon_0.1.8_amd64.deb'),
    "sudo apt install '/home/a b/.timon/updates/0.1.8/timon_0.1.8_amd64.deb'");
  assert.equal(debInstallCommand("/home/o'neil/x.deb"), "sudo apt install '/home/o'\\''neil/x.deb'");
});

test('missions: the route of this version, the live count of an older daemon, nothing from a daemon that cannot tell', async () => {
  const asked: string[] = [];
  const answers = (table: Record<string, unknown>) => async (path: string) => {
    asked.push(path);
    const value = table[path];
    if (value instanceof Error) throw value;
    if (value === undefined) throw new DaemonAnswerError(404);
    return value;
  };
  assert.deepEqual(await readMissionCount(answers({ '/api/updates/missions': { live: 3, working: 1 } })), { live: 3, working: 1 });
  assert.deepEqual(await readMissionCount(answers({ '/api/health/resources': { liveMissions: 2, load1: 0.3 } })), { live: 2, working: null });
  asked.length = 0;
  // A refusal is not an older daemon: no second question.
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': new DaemonAnswerError(401) })), null);
  assert.deepEqual(asked, ['/api/updates/missions']);
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': new TypeError('fetch failed') })), null);
  assert.equal(await readMissionCount(answers({ '/api/updates/missions': { live: -1, working: 'x' } })), null);
  assert.equal(await readMissionCount(answers({})), null);
  assert.equal(missionsAtStake({ live: 3, working: 1 }), 1);
  assert.equal(missionsAtStake({ live: 2, working: null }), 2);
  assert.equal(missionsAtStake(null), 0);
});
