// french-ok-file: an accented user name, the non-ASCII home under test
import assert from 'node:assert/strict';
import test from 'node:test';
import * as nodeFs from 'node:fs';
import { mkdtempSync, realpathSync, mkdirSync, writeFileSync, existsSync, readFileSync, symlinkSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { createServer } from 'node:net';
import { cleanupData, cleanupPlan, canUninstall, uninstallRequest, removalInstructions, removeSharedChain } from './uninstall.js';
import { speechModelsDirCandidates } from './speech-paths.js';
import { performUninstall, portClosed } from './uninstall-controller.js';

function fixture(userName = 'user') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-uninstall-test-')));
  const user = join(root, userName); const home = join(user, '.timon');
  mkdirSync(join(home, 'desktop-runtime', 'releases'), { recursive: true });
  writeFileSync(join(home, 'timon.config.json'), '{}');
  writeFileSync(join(home, 'desktop-runtime', 'releases', 'old'), 'runtime');
  writeFileSync(join(home, 'timon.db'), 'private mission');
  const outside = join(user, '.claude'); mkdirSync(outside);
  writeFileSync(join(outside, 'credentials.json'), 'must survive');
  symlinkSync(outside, join(home, 'project-link'), 'dir');
  return { root, user, home, outside, clean: () => rmSync(root, { recursive: true, force: true }) };
}

test('only the window main frame on the settings desktop tab can request uninstall', () => {
  const origin = 'http://127.0.0.1:3110';
  const sender = { isWindow: true, isMainFrame: true, url: `${origin}/missions?settings=system%2Fdesktop` };
  assert.equal(canUninstall(sender, origin), true);
  for (const change of [{ isWindow: false }, { isMainFrame: false }, { url: `${origin}/login` },
    { url: 'http://evil.test/?settings=system%2Fdesktop' }, { url: `${origin}/?settings=system%2Fdiagnostics` },
    { url: `${origin}/settings?group=desktop` }, { url: 'invalid' }]) {
    assert.equal(canUninstall({ ...sender, ...change }, origin), false);
  }
});

test('deletion requires exact confirmation and accepts no caller path', () => {
  for (const confirmation of ['', true, 'supprimer']) assert.throws(() => uninstallRequest({ mode: 'delete', locale: 'fr', confirmation }));
  assert.throws(() => uninstallRequest({ mode: 'purge', locale: 'fr' }));
  assert.deepEqual(uninstallRequest({ mode: 'keep', locale: 'fr', home: '/' }), { mode: 'keep', locale: 'fr', confirmation: '' });
  assert.equal(uninstallRequest({ mode: 'delete', locale: 'en', confirmation: 'SUPPRIMER' }).mode, 'delete');
});

for (const mode of ['keep', 'delete'] as const) test(`${mode}: data policy preserves external targets`, async () => {
  const f = fixture();
  try {
    await cleanupData(cleanupPlan(f.home, mode, process.execPath, f.user));
    assert.equal(existsSync(join(f.home, 'desktop-runtime')), false);
    assert.equal(existsSync(join(f.home, 'timon.db')), mode === 'keep');
    assert.equal(readFileSync(join(f.outside, 'credentials.json'), 'utf8'), 'must survive');
  } finally { f.clean(); }
});

test('retained data cleanup does not follow a runtime symlink', async () => {
  const f = fixture();
  try {
    rmSync(join(f.home, 'desktop-runtime'), { recursive: true });
    symlinkSync(f.outside, join(f.home, 'desktop-runtime'), 'dir');
    await cleanupData(cleanupPlan(f.home, 'keep', process.execPath, f.user));
    assert.equal(readFileSync(join(f.outside, 'credentials.json'), 'utf8'), 'must survive');
  } finally { f.clean(); }
});

test('replacement or symlink swap after confirmation cancels deletion', async () => {
  for (const link of [false, true]) {
    const f = fixture();
    try {
      const plan = cleanupPlan(f.home, 'delete', process.execPath, f.user);
      renameSync(f.home, join(f.root, 'original'));
      if (link) symlinkSync(f.outside, f.home, 'dir');
      else { mkdirSync(f.home); writeFileSync(join(f.home, 'valuable'), 'keep'); }
      await assert.rejects(cleanupData(plan), /changed/);
      assert.equal(readFileSync(join(f.outside, 'credentials.json'), 'utf8'), 'must survive');
      assert.equal(existsSync(join(f.root, 'original', 'timon.db')), true);
    } finally { f.clean(); }
  }
});

test('shared paths, unmarked directories and an app inside data cannot be purged', () => {
  const f = fixture();
  try {
    for (const target of [f.user, f.root, '/', f.outside]) assert.throws(() => cleanupPlan(target, 'delete', process.execPath, f.user));
    const executable = join(f.home, 'Timon'); writeFileSync(executable, 'test');
    assert.throws(() => cleanupPlan(f.home, 'delete', executable, f.user), /running application/);
  } finally { f.clean(); }
});

test('cleanup is armed only after every shutdown check; failures never quit', async () => {
  const stages = ['stopEmbedded', 'stopService', 'stopBrowser', 'verifyStopped', 'disableLogin', 'armCleanup', 'quit'] as const;
  for (const failed of [...stages.slice(0, -1), null]) {
    const calls: string[] = [];
    const steps = Object.fromEntries(stages.map(stage => [stage, () => {
      calls.push(stage); if (stage === failed) throw new Error(stage);
    }])) as unknown as Parameters<typeof performUninstall>[0];
    if (failed) await assert.rejects(performUninstall(steps)); else await performUninstall(steps);
    assert.deepEqual(calls, failed ? stages.slice(0, stages.indexOf(failed) + 1) : stages);
  }
});

test('shutdown verification distinguishes a live listener from a closed port', async () => {
  const server = createServer(socket => socket.end());
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  assert.equal(await portClosed(port), false);
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(await portClosed(port), true);
});

// The home is a real POSIX directory; only its machine-wide model folders are
// computed as on Windows, and handed to an injected remover.
const windowsEnv = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };

test('TODO #444: deleting the data of a non-ASCII Windows home also removes its ProgramData models', async () => {
  const f = fixture('Zoé');
  try {
    const chains: string[][] = [];
    const leftovers = await cleanupData(cleanupPlan(f.home, 'delete', process.execPath, f.user),
      { platform: 'win32', env: windowsEnv, removeShared: async chain => { chains.push(chain); } });
    const expected = speechModelsDirCandidates(f.home, 'win32', windowsEnv).slice(0, -1);
    assert.equal(expected.length, 2);
    assert.deepEqual(chains, expected.map(dir => [win32.dirname(win32.dirname(dir)), win32.dirname(dir), dir]));
    assert.deepEqual(chains[0]?.slice(0, 2), ['C:\\ProgramData\\Timon', 'C:\\ProgramData\\Timon\\speech-models']);
    assert.deepEqual(leftovers, []);
    assert.equal(existsSync(f.home), false);
  } finally { f.clean(); }
});

test('TODO #444: keep mode, other OSes, ASCII homes and trapped roots never touch a shared folder', async () => {
  const cases = [
    { name: 'Zoé', mode: 'keep', platform: 'win32', env: windowsEnv },
    { name: 'Zoé', mode: 'delete', platform: 'linux', env: windowsEnv },
    { name: 'Zoé', mode: 'delete', platform: 'darwin', env: windowsEnv },
    { name: 'zoe', mode: 'delete', platform: 'win32', env: windowsEnv },
    { name: 'Zoé', mode: 'delete', platform: 'win32', env: { ProgramData: '\\\\server\\share', PUBLIC: 'relative\\Public' } },
  ] as const;
  for (const c of cases) {
    const f = fixture(c.name);
    try {
      const chains: string[][] = [];
      await cleanupData(cleanupPlan(f.home, c.mode, process.execPath, f.user),
        { platform: c.platform, env: c.env, removeShared: async chain => { chains.push(chain); } });
      assert.deepEqual(chains, [], JSON.stringify(c));
      assert.equal(existsSync(join(f.home, 'timon.db')), c.mode === 'keep');
    } finally { f.clean(); }
  }
});

test('TODO #444: a shared folder that resists is reported, and the home is deleted anyway', async () => {
  const f = fixture('Zoé');
  try {
    const leftovers = await cleanupData(cleanupPlan(f.home, 'delete', process.execPath, f.user),
      { platform: 'win32', env: { ProgramData: 'C:\\ProgramData' }, removeShared: async () => { throw new Error('EBUSY'); } });
    assert.deepEqual(leftovers, speechModelsDirCandidates(f.home, 'win32', { ProgramData: 'C:\\ProgramData' }).slice(0, -1));
    assert.equal(existsSync(f.home), false);
  } finally { f.clean(); }
});

test('TODO #444: the shared models folder goes, its parents only once empty, never through a link', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-shared-models-')));
  try {
    const timon = join(root, 'Timon'); const models = join(timon, 'speech-models');
    const mine = join(models, '0123456789abcdef'); const other = join(models, 'fedcba9876543210');
    for (const dir of [mine, other]) { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'model.onnx'), 'x'); }
    await removeSharedChain([timon, models, mine], nodeFs);
    assert.equal(existsSync(mine), false);
    assert.equal(readFileSync(join(other, 'model.onnx'), 'utf8'), 'x');

    await removeSharedChain([timon, models, other], nodeFs);
    assert.equal(existsSync(timon), false);
    await removeSharedChain([timon, models, other], nodeFs);

    // A link anywhere in the chain (a junction, on Windows) refuses the deletion.
    const victim = join(root, 'victim'); const target = join(victim, '0123456789abcdef');
    mkdirSync(target, { recursive: true }); writeFileSync(join(target, 'keep'), 'keep');
    mkdirSync(timon); symlinkSync(victim, models, 'dir');
    await assert.rejects(removeSharedChain([timon, models, join(models, '0123456789abcdef')], nodeFs), /plain directory/);
    rmSync(models); mkdirSync(models); symlinkSync(target, mine, 'dir');
    await assert.rejects(removeSharedChain([timon, models, mine], nodeFs), /plain directory/);
    assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'keep');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('final instructions cover macOS, Windows, AppImage and package managers', () => {
  assert.match(removalInstructions('darwin', 'fr'), /Finder/);
  assert.match(removalInstructions('win32', 'en'), /Windows Settings/);
  assert.match(removalInstructions('linux', 'fr', '/tmp/Timon.AppImage'), /\/tmp\/Timon.AppImage/);
  assert.match(removalInstructions('linux', 'en'), /software manager/);
});
