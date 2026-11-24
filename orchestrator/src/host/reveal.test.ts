import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-reveal-test-'));

const { chooseRevealLane, opensAsFolder, revealCommand, revealInFileManager } = await import('./reveal.js');
const { detectDesktopSession } = await import('./desktop-session.js');
const { createGenericHost } = await import('./generic.js');
const { TimonConfigSchema } = await import('../config/schema.js');
const { terminalStatus } = await import('../terminal.js');
const { getHost } = await import('./index.js');

const ENV = { SystemRoot: 'C:\\Windows' };
// french-ok-file: accented user folders the paths must keep

test('win32 file: /select, with the quoted path, verbatim, backslashes', () => {
  const c = revealCommand('win32', 'C:/Users/Zoé/Mes documents/a b.txt', false, ENV);
  assert.equal(c.file, 'C:\\Windows\\explorer.exe');
  assert.deepEqual(c.args, ['/select,"C:\\Users\\Zoé\\Mes documents\\a b.txt"']);
  assert.equal(c.windowsVerbatimArguments, true);
  assert.equal(c.via, 'explorer');
});

test('win32 folder: opened directly, no /select', () => {
  const c = revealCommand('win32', 'C:\\Users\\Zoé\\Mes documents', true, ENV);
  assert.deepEqual(c.args, ['"C:\\Users\\Zoé\\Mes documents"']);
  assert.equal(c.windowsVerbatimArguments, true);
});

test('win32 explorer location follows %SystemRoot%, falls back to C:\\Windows', () => {
  assert.equal(revealCommand('win32', 'D:\\x', true, { SystemRoot: 'E:\\WinNT' }).file, 'E:\\WinNT\\explorer.exe');
  assert.equal(revealCommand('win32', 'D:\\x', true, {}).file, 'C:\\Windows\\explorer.exe');
});

test('win32 refuses a quote or NUL in the path instead of escaping', () => {
  assert.throws(() => revealCommand('win32', 'C:\\a"b\\c.txt', false, ENV), /invalid path/);
  assert.throws(() => revealCommand('win32', 'C:\\a\0b', false, ENV), /invalid path/);
});

test('darwin: open -R for a file, open for a folder, accents and spaces untouched', () => {
  const file = revealCommand('darwin', '/Users/Zoé/Mes documents/a b.txt', false);
  assert.equal(file.file, '/usr/bin/open');
  assert.deepEqual(file.args, ['-R', '/Users/Zoé/Mes documents/a b.txt']);
  assert.equal(file.windowsVerbatimArguments, false);
  assert.equal(file.via, 'finder');
  assert.deepEqual(revealCommand('darwin', '/Users/Zoé/Mes documents', true).args, ['/Users/Zoé/Mes documents']);
});

/** An in-memory disk: directories only, links resolved through `links`. */
function fakeDisk(dirs: string[], links: Record<string, string> = {}) {
  return {
    isDirectory: (p: string) => dirs.includes(p) || p in links,
    realpath: (p: string) => links[p] ?? p,
    exists: (p: string) => dirs.some((d) => d === p || d.startsWith(`${p}/`)) || p in links,
  };
}

test('darwin: a plain folder is opened, a bundle never is (open would launch it)', () => {
  const disk = fakeDisk(['/u/Mes documents', '/u/.hidden', '/u/Calculator.app', '/u/APP.APP', '/u/Tool.framework', '/u/v1.2']);
  assert.equal(opensAsFolder('darwin', '/u/Mes documents', disk), true);
  assert.equal(opensAsFolder('darwin', '/u/.hidden', disk), true);
  for (const bundle of ['/u/Calculator.app', '/u/APP.APP', '/u/Tool.framework', '/u/v1.2']) {
    assert.equal(opensAsFolder('darwin', bundle, disk), false, bundle);
  }
});

test('darwin: a link to a bundle, a bundle without extension and a file are revealed', () => {
  const disk = fakeDisk(
    ['/u/Calculator.app', '/u/Contents/Info.plist', '/u/Hidden/Contents/Info.plist', '/u/Hidden'],
    { '/u/Shortcut': '/u/Calculator.app', '/u/Loop.app': '/u/Elsewhere' },
  );
  assert.equal(opensAsFolder('darwin', '/u/Shortcut', disk), false, 'extension-less link, bundle target');
  assert.equal(opensAsFolder('darwin', '/u/Loop.app', disk), false, 'bundle-looking link name');
  assert.equal(opensAsFolder('darwin', '/u/Hidden', disk), false, 'Contents/Info.plist makes it a bundle');
  assert.equal(opensAsFolder('darwin', '/u/a b.txt', disk), false, 'a file is selected, not opened');
  assert.equal(opensAsFolder('darwin', '/u/Broken', { ...disk, isDirectory: () => true, realpath: () => { throw new Error('ENOENT'); } }), false);
});

test('darwin on a real disk: a bundle and a symlink to it get open -R, a folder gets open', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-reveal-bundle-'));
  mkdirSync(join(dir, 'Calculator.app', 'Contents'), { recursive: true });
  writeFileSync(join(dir, 'Calculator.app', 'Contents', 'Info.plist'), '<plist/>');
  mkdirSync(join(dir, 'Mes documents é'));
  symlinkSync(join(dir, 'Calculator.app'), join(dir, 'Raccourci'));
  const args = (p: string) => revealCommand('darwin', p, opensAsFolder('darwin', p)).args;
  assert.deepEqual(args(join(dir, 'Calculator.app')), ['-R', join(dir, 'Calculator.app')]);
  assert.deepEqual(args(join(dir, 'Raccourci')), ['-R', join(dir, 'Raccourci')]);
  assert.deepEqual(args(join(dir, 'Mes documents é')), [join(dir, 'Mes documents é')]);
});

test('win32 opens any directory, even one named like an executable', () => {
  assert.equal(opensAsFolder('win32', '/x', fakeDisk(['/x'])), true);
  assert.equal(opensAsFolder('win32', '/x.exe', fakeDisk(['/x.exe'])), true);
  assert.equal(opensAsFolder('win32', '/f', fakeDisk([])), false);
});

test('explorer.exe exiting 1 is a success, a launch failure is not', async () => {
  const via = await revealInFileManager('win32', 'C:\\a\\b.txt', false, async () => ({ code: 1, stderr: '' }), ENV);
  assert.equal(via, 'explorer');
  await assert.rejects(
    revealInFileManager('win32', 'C:\\a\\b.txt', false, async () => { throw new Error('spawn explorer.exe ENOENT'); }, ENV),
    /could not open the desktop file manager: spawn explorer\.exe ENOENT/,
  );
});

test('open: non-zero exit is an error carrying stderr', async () => {
  assert.equal(await revealInFileManager('darwin', '/a', true, async () => ({ code: 0, stderr: '' })), 'finder');
  await assert.rejects(
    revealInFileManager('darwin', '/nope', true, async () => ({ code: 1, stderr: 'The file /nope does not exist.\n' })),
    /could not open the desktop file manager: The file \/nope does not exist\./,
  );
});

test('generic host exposes a reveal-only gui on win32/darwin, none elsewhere or when disabled', () => {
  const cfg = TimonConfigSchema.parse({});
  for (const platform of ['win32', 'darwin'] as const) {
    const host = createGenericHost(cfg, { platform });
    assert.ok(host.gui, platform);
    assert.equal(host.gui.openTerminal, undefined, 'terminal stays out of scope');
    assert.ok(host.capabilities().includes('gui'), platform);
  }
  const linux = createGenericHost(cfg, { platform: 'linux' });
  assert.equal(linux.gui, undefined);
  assert.equal(linux.capabilities().includes('gui'), false);

  const off = createGenericHost(TimonConfigSchema.parse({ host: { gui: 'disabled' } }), { platform: 'win32' });
  assert.equal(off.gui, undefined);
  assert.equal(off.capabilities().includes('gui'), false);
});

test('a reveal-only gui does not switch the native terminal on', () => {
  const host = getHost();
  const previous = host.gui;
  host.gui = { reveal: async () => 'explorer' };
  try {
    assert.deepEqual(
      { enabled: terminalStatus().enabled, reason: terminalStatus().reason },
      { enabled: false, reason: 'no_gui' },
    );
  } finally {
    host.gui = previous;
  }
});

test('lane decision: the host launches only with a proven desktop session', () => {
  const table: Array<[boolean, 'graphical' | 'none' | 'unknown', boolean, string]> = [
    [true, 'graphical', false, 'host'],
    [true, 'graphical', true, 'host'],
    [true, 'none', true, 'client'],
    [true, 'none', false, 'none'],
    [true, 'unknown', true, 'client'],
    [true, 'unknown', false, 'none'],
    [false, 'none', true, 'client'],
    [false, 'none', false, 'none'],
  ];
  for (const [hostHasGui, hostSession, clientCanOpen, expected] of table) {
    assert.equal(
      chooseRevealLane({ hostHasGui, hostSession, clientCanOpen }),
      expected,
      `gui=${hostHasGui} session=${hostSession} client=${clientCanOpen}`,
    );
  }
});

test('session probe: Windows session 0 is the service, 1+ is a desktop', async () => {
  const seen: string[][] = [];
  const probe = (out: string) => async (file: string, args: string[]) => { seen.push([file, ...args]); return out; };
  assert.equal(await detectDesktopSession('win32', probe('0\r\n'), 4242), 'none');
  assert.equal(await detectDesktopSession('win32', probe('1\r\n'), 4242), 'graphical');
  assert.equal(await detectDesktopSession('win32', probe('3'), 4242), 'graphical');
  assert.equal(await detectDesktopSession('win32', probe(''), 4242), 'unknown');
  assert.equal(await detectDesktopSession('win32', probe('garbage'), 4242), 'unknown');
  assert.match(seen[0]!.join(' '), /^powershell\.exe .*\(Get-Process -Id 4242\)\.SessionId$/);
});

test('session probe: macOS Aqua is a desktop, the system domain is not', async () => {
  const probe = (out: string) => async () => out;
  assert.equal(await detectDesktopSession('darwin', probe('Aqua\n')), 'graphical');
  assert.equal(await detectDesktopSession('darwin', probe('System\n')), 'none');
  assert.equal(await detectDesktopSession('darwin', probe('Background\n')), 'none');
  assert.equal(await detectDesktopSession('darwin', probe('')), 'unknown');
});

test('session probe: a failing probe or another OS is unknown, never graphical', async () => {
  const fails = async () => { throw new Error('spawn powershell.exe ENOENT'); };
  assert.equal(await detectDesktopSession('win32', fails), 'unknown');
  assert.equal(await detectDesktopSession('darwin', fails), 'unknown');
  assert.equal(await detectDesktopSession('linux', async () => 'Aqua'), 'unknown');
});

test('generic host answers the session itself, once', () => {
  const host = createGenericHost(TimonConfigSchema.parse({}), { platform: 'win32' });
  assert.equal(typeof host.gui?.desktopSession, 'function');
  assert.equal(host.gui.desktopSession(), host.gui.desktopSession(), 'one probe per daemon lifetime');
});
