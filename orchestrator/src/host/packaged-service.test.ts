import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  activeReleaseFile,
  markActiveRelease,
  packagedReleaseId,
  packagedServiceOptions,
  packagedUnit,
  processToken,
  pruneInactiveReleases,
  readActiveRelease,
  recordHandover,
  runtimeDir,
  runtimeReleaseDir,
  stagePackagedRuntime,
  waitForHandover,
} from './packaged-service.js';
import { installService, statusService, unitPath, type ServiceOpts } from './service-install.js';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'timon-package-'));
  const mount = join(root, 'mount');
  const home = join(root, 'data');
  const installDir = join(mount, 'resources', 'orchestrator');
  const dist = join(installDir, 'dist');
  await mkdir(join(dist, 'host'), { recursive: true });
  await writeFile(join(mount, 'timon'), '#!/bin/sh\n', { mode: 0o755 });
  await writeFile(join(installDir, 'package.json'), '{"type":"module"}');
  for (const name of ['packaged-runner', 'packaged-service', 'bundled-node']) {
    const source = await readFile(new URL(`./${name}.ts`, import.meta.url), 'utf8');
    await writeFile(join(dist, 'host', `${name}.js`), ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
    }).outputText);
  }
  await writeFile(join(dist, 'boot.js'), 'import { writeFileSync } from "node:fs"; writeFileSync(process.env.PROBE_FILE, "booted");');
  return { root, mount, home, installDir, executable: join(mount, 'timon') };
}

test('real installer isolates dev, stages a durable runtime, and hands over only after embedded exit', {
  skip: process.platform !== 'linux' && 'The handover token is a Linux /proc contract',
}, async () => {
  const f = await fixture();
  try {
    const dev = unitPath(f.root);
    await mkdir(join(f.root, '.config', 'systemd', 'user'), { recursive: true });
    await writeFile(dev, 'development service — leave intact');
    await stagePackagedRuntime(f.home, f.executable, f.installDir);
    const calls: string[][] = [];
    let loaded = false;
    let opts: ServiceOpts;
    const base: ServiceOpts = { platform: 'linux', homeDir: f.root, timonHome: f.home,
      installDir: f.installDir, userName: 'test', uid: 1000, heapMb: 512, port: 3010,
      nodePath: f.executable, exec: (name, args) => {
        calls.push([name, ...args]);
        if (args.includes('show')) return { code: 0, stderr: '', stdout: loaded
          ? `LoadState=loaded\nActiveState=active\nUnitFileState=enabled\nNeedDaemonReload=no\nEnvironment=TIMON_HOME=${f.home}\nWorkingDirectory=${opts.installDir}`
          : 'LoadState=not-found' };
        if (args.includes('daemon-reload')) loaded = true;
        return { code: 0, stdout: '', stderr: '' };
      } };
    opts = { ...packagedServiceOptions(base, f.executable, 3110), pendingHandover: true };
    assert.equal(installService(opts).ok, true);
    assert.equal(statusService(opts).installed, true);
    assert.equal(statusService(opts).ok, false);
    assert.equal(statusService({ ...opts, pendingHandover: false }).ok, true);
    const unit = await readFile(unitPath(f.root, packagedUnit(f.home)), 'utf8');
    assert.ok(!unit.includes(f.mount));
    assert.ok(unit.includes('ELECTRON_RUN_AS_NODE=1'));
    assert.ok(unit.includes('TIMON_APP_ENABLED=1'));
    assert.ok(unit.includes('TIMON_APP_PORT=3110'));
    assert.ok(unit.includes('packaged-runner.js'));
    assert.equal(opts.environment?.PATH?.split(':')[0], join(dirname(opts.nodePath), 'cli'),
      'the package launcher runs the CLI with the app runtime, first on PATH');
    assert.ok(opts.environment?.PATH?.split(':').includes(join(opts.installDir, 'bin')),
      'the packaged timon CLI must be on PATH');
    assert.ok(opts.environment?.PATH?.split(':').includes(join(f.root, '.local', 'bin')),
      'user-scoped Node and backend CLIs must be on PATH');
    assert.ok(calls.every(call => !call.includes('timon-orchestrator')));
    assert.equal(await readFile(dev, 'utf8'), 'development service — leave intact');
    assert.ok((await stat(opts.nodePath)).mode & 0o100);

    // The original daemon lives until the test ends it: a fixed lifetime raced
    // the fixture's own I/O under load and left the wait unproven (TODO #581).
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const ownerExit = once(owner, 'exit');
    const probe = join(f.root, 'booted');
    let runner: Promise<unknown> | undefined;
    try {
      assert.ok(owner.pid);
      await recordHandover(f.home, owner.pid);
      await rm(f.mount, { recursive: true });
      runner = promisify(execFile)(process.execPath, [join(opts.installDir, 'dist', 'host', 'packaged-runner.js')], {
        timeout: 15000, env: { ...process.env, TIMON_HOME: f.home, PROBE_FILE: probe },
      });
      await new Promise((resolve) => setTimeout(resolve, 1000));
      assert.equal(existsSync(probe), false, 'runner must wait for the original daemon');
      owner.kill();
      await ownerExit;
      await runner;
      assert.equal(await readFile(probe, 'utf8'), 'booted');
    } finally {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
      await runner?.catch(() => {});
    }
    // Relaunch after handover never waits on the dead PID again.
    await promisify(execFile)(process.execPath, [join(opts.installDir, 'dist', 'host', 'packaged-runner.js')], {
      timeout: 15000, env: { ...process.env, TIMON_HOME: f.home, PROBE_FILE: probe },
    });
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the handover wait ends when the process dies between opening and reading its stat file', {
  skip: process.platform !== 'linux' && 'The handover token is a Linux /proc contract',
}, async () => {
  const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  const ownerExit = once(owner, 'exit');
  try {
    assert.ok(owner.pid);
    const token = processToken(await readFile(`/proc/${owner.pid}/stat`, 'utf8'));
    let readError: NodeJS.ErrnoException | undefined;
    await waitForHandover({ pid: owner.pid, token }, async (path) => {
      const file = await open(path);
      try {
        owner.kill('SIGKILL');
        await ownerExit;
        return await file.readFile('utf8');
      } catch (error) {
        readError = error as NodeJS.ErrnoException;
        throw error;
      } finally { await file.close(); }
    });
    assert.equal(readError?.code, 'ESRCH', 'the kernel error this wait must survive');
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) owner.kill('SIGKILL');
  }
});

test('the handover wait stops on a gone or reused PID, and only there', async () => {
  const failing = (code: string) => async () => { throw Object.assign(new Error(code), { code }); };
  const stat = (token: string) => `1 (a) b) S ${Array.from({ length: 18 }, (_, i) => i).join(' ')} ${token}`;
  assert.equal(processToken(stat('42')), '42');
  await waitForHandover({ pid: 1, token: '42' }, failing('ENOENT'));
  await waitForHandover({ pid: 1, token: '42' }, failing('ESRCH'));
  await waitForHandover({ pid: 1, token: '42' }, async () => stat('43'));
  await assert.rejects(waitForHandover({ pid: 1, token: '42' }, failing('EACCES')), { code: 'EACCES' });
  let reads = 0;
  await waitForHandover({ pid: 1, token: '42' }, async () => stat(++reads < 2 ? '42' : '43'));
  assert.equal(reads, 2, 'the same token keeps waiting');
});

test('the packaged unit backs off its restarts; the legacy template it repairs keeps the old directives', () => {
  const opts = packagedServiceOptions({ platform: 'linux', homeDir: '/home/u', timonHome: '/home/u/.timon',
    installDir: '/pkg/resources/orchestrator', userName: 'u', uid: 1000, heapMb: 512, port: 3010,
    nodePath: '/pkg/timon', exec: () => { throw new Error('No service operations in render test'); },
  }, '/pkg/timon', 3110);
  // TIM-0109: 4 718 restarts at 2 s on a failing disk. Growing delay, never a give-up.
  assert.match(opts.unitContent!, /\nRestartSec=2\nRestartSteps=10\nRestartMaxDelaySec=300\n/);
  assert.doesNotMatch(opts.unitContent!, /StartLimit/);
  // `repairLegacyPackagedUnit` compares bytes: the release that wrote the
  // malformed unit had no backoff lines.
  assert.doesNotMatch(opts.legacyUnitContent!, /RestartSteps|RestartMaxDelaySec/);
  assert.equal(
    opts.legacyUnitContent!.replace(/^WorkingDirectory=.*$/m, ''),
    opts.unitContent!.replace('RestartSteps=10\nRestartMaxDelaySec=300\n', '').replace(/^WorkingDirectory=.*$/m, ''),
  );
});

test('runtime staging omits links to the live tree without following them', async () => {
  const f = await fixture();
  try {
    await symlink(f.root, join(f.installDir, 'node_modules'));
    await stagePackagedRuntime(f.home, f.executable, f.installDir);
    await assert.rejects(stat(join(runtimeReleaseDir(f.home), 'resources', 'orchestrator', 'node_modules')), { code: 'ENOENT' });
    assert.ok(await stat(f.root));
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

// The durable copy boots through `verifyRelease`, which refuses a launcher
// stripped of its execute bit: the copy itself must not strip it.
test('runtime staging keeps the mission launcher executable', {
  skip: process.platform === 'win32' && 'Windows has no execute bit',
}, async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.installDir, 'native'), { recursive: true });
    await writeFile(join(f.installDir, 'native', 'timon-fence'), '#!/bin/sh\n', { mode: 0o755 });
    await stagePackagedRuntime(f.home, f.executable, f.installDir);
    const staged = await stat(join(runtimeReleaseDir(f.home), 'resources', 'orchestrator', 'native', 'timon-fence'));
    assert.equal(staged.mode & 0o111, 0o111);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('the generated unit passes the real systemd parser, including paths with spaces and percent signs', {
  skip: process.platform !== 'linux' || !existsSync('/usr/bin/systemd-analyze'),
}, async () => {
  const f = await fixture();
  try {
    const home = join(f.root, 'data with spaces %');
    await stagePackagedRuntime(home, f.executable, f.installDir);
    const opts = packagedServiceOptions({ platform: 'linux', homeDir: f.root, timonHome: home,
      installDir: f.installDir, userName: 'test', uid: 1000, heapMb: 512, port: 3010,
      nodePath: f.executable, exec: () => { throw new Error('No service operations in parser test'); },
    }, f.executable, 3110);
    const file = join(f.root, `${opts.unitName}.service`);
    await writeFile(file, opts.legacyUnitContent!);
    // `--user` looks up a runtime directory, absent without a login session (a CI runner, a container):
    // a temporary one is all the parser needs, and it keeps the check off the real user manager.
    const runtimeDir = join(f.root, 'runtime');
    await mkdir(runtimeDir, { mode: 0o700 });
    const verify = () => promisify(execFile)('/usr/bin/systemd-analyze', ['--user', '--generators=no', '--man=no', 'verify', file],
      { timeout: 10000, env: { ...process.env, XDG_RUNTIME_DIR: runtimeDir } });
    await assert.rejects(verify(), /WorkingDirectory= path is not absolute/);
    await writeFile(file, opts.unitContent!);
    await verify();
  } finally { await rm(f.root, { recursive: true, force: true }); }
});

test('Electron stages ASAR archives as files and cleans up a failed copy', {
  skip: !existsSync(new URL('../../../desktop/node_modules/electron/path.txt', import.meta.url))
    && 'Install desktop dependencies to run the real Electron regression',
}, async (t) => {
  const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url));
  const electron = desktopRequire('electron') as string;
  const asar = desktopRequire('@electron/asar') as {
    createPackage(source: string, destination: string): Promise<void>;
  };
  for (const missingRunner of [false, true]) {
    await t.test(missingRunner ? 'failure removes the staging directory' : 'archive and unpacked files survive', async () => {
      const f = await fixture();
      try {
        const archiveSource = join(f.root, 'archive-source');
        await mkdir(archiveSource);
        await writeFile(join(archiveSource, 'package.json'), '{"name":"archive-fixture"}');
        await asar.createPackage(archiveSource, join(f.mount, 'resources', 'app.asar'));
        await mkdir(join(f.mount, 'resources', 'app.asar.unpacked'));
        await writeFile(join(f.mount, 'resources', 'app.asar.unpacked', 'payload'), 'unpacked payload');
        if (missingRunner) await rm(join(f.installDir, 'dist', 'host', 'packaged-runner.js'));
        const moduleUrl = pathToFileURL(join(f.installDir, 'dist', 'host', 'packaged-service.js')).href;
        await promisify(execFile)(electron, ['--input-type=module', '-e', `
          import assert from 'node:assert/strict';
          import fs from 'node:fs';
          import { createRequire } from 'node:module';
          import { join } from 'node:path';
          const [moduleUrl, home, executable, installDir, missingRunner] = process.argv.slice(1);
          const rawFs = createRequire(moduleUrl)('original-fs');
          const { pruneInactiveReleases, stagePackagedRuntime, runtimeReleaseDir } = await import(moduleUrl);
          const archive = join(installDir, '..', 'app.asar');
          assert.ok(fs.statSync(archive).isDirectory(), 'ASAR interception must be active');
          const noAsar = process.noAsar;
          if (missingRunner === 'true') {
            await assert.rejects(stagePackagedRuntime(home, executable, installDir), /missing its service runner/);
            assert.equal(rawFs.existsSync(runtimeReleaseDir(home) + '.staging-' + process.pid), false);
            assert.equal(rawFs.existsSync(runtimeReleaseDir(home)), false);
          } else {
            await stagePackagedRuntime(home, executable, installDir);
            const copied = join(runtimeReleaseDir(home), 'resources', 'app.asar');
            assert.ok(rawFs.statSync(copied).isFile());
            assert.deepEqual(rawFs.readFileSync(copied), rawFs.readFileSync(archive));
            assert.equal(fs.readFileSync(join(copied, 'package.json'), 'utf8'), '{"name":"archive-fixture"}');
            assert.equal(rawFs.readFileSync(copied + '.unpacked/payload', 'utf8'), 'unpacked payload');
            await stagePackagedRuntime(home, executable, installDir);
            const obsolete = runtimeReleaseDir(home, 'obsolete');
            rawFs.mkdirSync(obsolete, { recursive: true });
            rawFs.copyFileSync(archive, join(obsolete, 'old.asar'));
            await pruneInactiveReleases(home);
            assert.equal(rawFs.existsSync(obsolete), false);
            assert.equal(rawFs.existsSync(runtimeReleaseDir(home)), true);
          }
          assert.equal(process.noAsar, noAsar, 'staging must not change global ASAR handling');
          assert.ok(fs.statSync(archive).isDirectory());
          rawFs.writeFileSync(join(home, 'electron-result'), 'passed');
        `, moduleUrl, f.home, f.executable, f.installDir, String(missingRunner)], {
          timeout: 15000,
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TIMON_HOME: f.home },
        });
        assert.equal(await readFile(join(f.home, 'electron-result'), 'utf8'), 'passed');
      } finally { await rm(f.root, { recursive: true, force: true }); }
    });
  }
});

test('macOS stages Contents outside Timon.app and points launchd at that copy', async () => {
  const root = await mkdtemp(join(tmpdir(), 'timon-mac-package-'));
  const contents = join(root, 'Timon.app', 'Contents');
  const executable = join(contents, 'MacOS', 'Timon');
  const installDir = join(contents, 'Resources', 'orchestrator');
  const home = join(root, 'home');
  try {
    await mkdir(join(installDir, 'dist', 'host'), { recursive: true });
    await mkdir(join(contents, 'Frameworks'), { recursive: true });
    await mkdir(join(contents, 'MacOS'), { recursive: true });
    await writeFile(executable, '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(join(installDir, 'dist', 'host', 'packaged-runner.js'), '');
    await writeFile(join(contents, 'Frameworks', 'framework'), 'needed by Electron');
    await stagePackagedRuntime(home, executable, installDir, '0.2.0');

    const base: ServiceOpts = { platform: 'darwin', homeDir: home, timonHome: home,
      installDir, userName: 'test', uid: 501, heapMb: 512, port: 3010,
      nodePath: executable, exec: () => ({ code: 0, stdout: '', stderr: '' }) };
    const opts = packagedServiceOptions(base, executable, 3110, '0.2.0');
    const copiedContents = join(runtimeReleaseDir(home, '0.2.0'), 'Timon.app', 'Contents');
    assert.equal(opts.nodePath, join(copiedContents, 'MacOS', 'Timon'));
    assert.equal(opts.installDir, join(copiedContents, 'Resources', 'orchestrator'));
    // The launcher runs the CLI with the app's runtime, not a system Node.
    assert.equal(opts.environment?.PATH?.split(':')[0], join(copiedContents, 'cli'));
    assert.equal(opts.environment?.PATH?.split(':')[1], join(opts.installDir, 'bin'));
    assert.ok(opts.environment?.PATH?.split(':').includes(join(home, '.local', 'bin')));
    assert.equal(await readFile(join(copiedContents, 'Frameworks', 'framework'), 'utf8'), 'needed by Electron');
    assert.ok(!opts.nodePath.startsWith(contents), 'launchd must not point at the replaceable application');

    await markActiveRelease(home, '0.2.0');
    assert.equal((await readFile(activeReleaseFile(home), 'utf8')).trim(), packagedReleaseId('0.2.0'));

    const oldRelease = runtimeReleaseDir(home, '0.1.0');
    await mkdir(oldRelease, { recursive: true });
    await writeFile(join(oldRelease, 'old'), 'obsolete');
    await pruneInactiveReleases(home, '0.2.0');
    assert.equal(existsSync(oldRelease), false);
    assert.equal(existsSync(runtimeReleaseDir(home, '0.2.0')), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('pruning keeps the release that was active before, so going back reuses its copy', async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-prune-'));
  try {
    for (const version of ['0.1.0', '0.1.1', '0.1.2']) await mkdir(runtimeReleaseDir(home, version), { recursive: true });
    await markActiveRelease(home, '0.1.1');
    const previous = await readActiveRelease(home);
    assert.equal(previous, packagedReleaseId('0.1.1'));
    await markActiveRelease(home, '0.1.2');
    await pruneInactiveReleases(home, '0.1.2', [previous!]);
    assert.equal(existsSync(runtimeReleaseDir(home, '0.1.0')), false);
    assert.equal(existsSync(runtimeReleaseDir(home, '0.1.1')), true);
    assert.equal(existsSync(runtimeReleaseDir(home, '0.1.2')), true);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('an upgrade runner hands nothing over and restarts the previous release', () => {
  const saved = { embedded: process.env.TIMON_DESKTOP_EMBEDDED, upgrade: process.env.TIMON_DESKTOP_UPGRADE };
  const base = {
    platform: 'linux', homeDir: '/home/sam', timonHome: '/home/sam/.timon', installDir: '/mount/resources/orchestrator',
    userName: 'sam', uid: 1000, heapMb: 4096, port: 3010, nodePath: '/mount/timon',
    exec: () => ({ code: 0, stdout: '', stderr: '' }),
  } satisfies ServiceOpts;
  try {
    process.env.TIMON_DESKTOP_EMBEDDED = '1';
    delete process.env.TIMON_DESKTOP_UPGRADE;
    const firstRun = packagedServiceOptions(base, '/mount/timon', 3110, '0.2.0');
    assert.equal(firstRun.pendingHandover, true);
    assert.equal(firstRun.restart, false);
    assert.equal(firstRun.releasesRoot, join(runtimeDir(base.timonHome), 'releases'));

    process.env.TIMON_DESKTOP_UPGRADE = '1';
    const upgrade = packagedServiceOptions(base, '/mount/timon', 3110, '0.2.0');
    assert.equal(upgrade.pendingHandover, false);
    assert.equal(upgrade.restart, true);
  } finally {
    for (const [key, value] of [['TIMON_DESKTOP_EMBEDDED', saved.embedded], ['TIMON_DESKTOP_UPGRADE', saved.upgrade]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
