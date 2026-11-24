import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binaryCandidates } from './binary-path.js';

// The Linux and macOS candidates are built with the host's own `node:path` and
// PATH delimiter: on a Windows host a POSIX fixture comes back as `\usr\bin\…`
// and `/usr/bin:/bin` stays one entry. Those lookups only run on a POSIX host.
const POSIX_HOST = process.platform === 'win32' && 'Linux and macOS candidates use the host separators';

test('macOS looks for the user tools even when Finder provides a minimal PATH', { skip: POSIX_HOST }, () => {
  const node = binaryCandidates('node', { platform: 'darwin', path: '/usr/bin:/bin', homeDir: '/Users/sam' });
  assert.ok(node.includes('/Users/sam/.local/bin/node'));
  assert.ok(node.includes('/opt/homebrew/bin/node'));
});

test('the Codex CLI embedded in the ChatGPT app is a macOS candidate', { skip: POSIX_HOST }, () => {
  const codex = binaryCandidates('codex', { platform: 'darwin', path: '/usr/bin', homeDir: '/Users/sam' });
  assert.ok(codex.includes('/Applications/ChatGPT.app/Contents/Resources/codex'));
  assert.ok(codex.includes('/Users/sam/Applications/ChatGPT.app/Contents/Resources/codex'));
});

import { chmodSync, mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExecutableBinary } from './binary-path.js';

test('Windows discovers npm and per-user programs with a stale PATH', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-win-bins-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local') };
  const npm = join(env.APPDATA, 'npm');
  mkdirSync(npm, { recursive: true });
  const shim = join(npm, 'codex.cmd');
  writeFileSync(shim, '@echo off');
  const options = { platform: 'win32' as const, path: '', homeDir: home, env };
  assert.ok(binaryCandidates('codex', options).includes(shim));
  assert.ok(binaryCandidates('codex', options).includes(join(env.LOCALAPPDATA, 'Programs', 'codex', 'codex.exe')));
  assert.equal(findExecutableBinary('codex', options), shim);
});

test('Windows finds codex where its official standalone installer puts it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-win-codex-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { LOCALAPPDATA: join(home, 'Local') };
  const dir = join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'codex.exe'), '');
  assert.equal(findExecutableBinary('codex', { platform: 'win32', path: '', homeDir: home, env }), join(dir, 'codex.exe'));
});

test('Windows PATH uses semicolons and directories are not executables', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-win-path-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const first = join(home, 'first');
  const second = join(home, 'second');
  mkdirSync(join(first, 'codex.exe'), { recursive: true });
  mkdirSync(second);
  const shim = join(second, 'codex.cmd');
  writeFileSync(shim, '@echo off');
  assert.equal(findExecutableBinary('codex', {
    platform: 'win32', path: `${first};${second}`, homeDir: home,
  }), shim);
});

// winget.exe in WindowsApps: stat is refused, the alias runs. A link whose
// target sits in an unreadable directory gives the same EACCES here.
test('Windows accepts an app execution alias that stat refuses (winget)', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-win-alias-'));
  const locked = join(home, 'locked');
  t.after(() => { chmodSync(locked, 0o755); rmSync(home, { recursive: true, force: true }); });
  const apps = join(home, 'WindowsApps');
  mkdirSync(apps);
  mkdirSync(locked);
  writeFileSync(join(locked, 'winget.exe'), '');
  symlinkSync(join(locked, 'winget.exe'), join(apps, 'winget.exe'));
  chmodSync(locked, 0o000);
  if (process.getuid?.() === 0) { t.skip('root reads through any permission'); return; }
  const options = { platform: 'win32' as const, path: apps, homeDir: home, env: {} };
  assert.equal(findExecutableBinary('winget', options), join(apps, 'winget.exe'));
  assert.equal(findExecutableBinary('winget', { ...options, platform: 'linux' as const }), null,
    'only Windows has app execution aliases');
});

test('Windows native paths and unset optional environment directories are handled', () => {
  const env = { APPDATA: 'C:\\Users\\Sam\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' };
  const paths = binaryCandidates('codex', { platform: 'win32', path: 'C:\\Tools;D:\\Tools', homeDir: '', env });
  assert.ok(paths.includes('C:\\Users\\Sam\\AppData\\Roaming\\npm\\codex.cmd'));
  assert.ok(paths.includes('D:\\Tools\\codex.exe'));
  // Node.js and Git installed after this shell started: not on its PATH yet.
  const fresh = binaryCandidates('git', { platform: 'win32', path: '', homeDir: '', env: { ProgramFiles: 'C:\\Program Files' } });
  assert.ok(fresh.includes('C:\\Program Files\\Git\\cmd\\git.exe'));
  assert.ok(binaryCandidates('node', { platform: 'win32', path: '', homeDir: '', env: { ProgramFiles: 'C:\\Program Files' } })
    .includes('C:\\Program Files\\nodejs\\node.exe'));
  assert.deepEqual(binaryCandidates('codex', {
    platform: 'win32', path: '', homeDir: '', env: {}, installedBinariesFile: join(tmpdir(), 'absent-timon-binaries.json'),
  }), []);
});

import { utimesSync } from 'node:fs';
import { win32 } from 'node:path';
import { isDesktopBuildPath, pinnedBinaryCandidates, resolvePinnedBinary, type DirectoryReader } from './binary-path.js';

const LOCAL = 'C:\\Users\\admin\\AppData\\Local';
const CODEX_BIN = win32.join(LOCAL, 'OpenAI', 'Codex', 'bin');

/** In-memory `%LOCALAPPDATA%\OpenAI\Codex\bin`: build → files with their mtime. */
function codexBinReader(builds: Record<string, Record<string, number>> | null): DirectoryReader {
  return {
    subdirectories: (dir) => {
      if (builds === null || dir !== CODEX_BIN) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.keys(builds);
    },
    fileMtimeMs: (file) => {
      const build = builds?.[win32.basename(win32.dirname(file))];
      return build && win32.dirname(win32.dirname(file)) === CODEX_BIN ? build[win32.basename(file)] ?? null : null;
    },
  };
}

const winOptions = (reader: DirectoryReader, path = '') => ({
  platform: 'win32' as const, path, homeDir: '', directoryReader: reader,
  env: { APPDATA: 'C:\\Users\\admin\\AppData\\Roaming', LOCALAPPDATA: LOCAL },
  installedBinariesFile: join(tmpdir(), 'absent-timon-binaries.json'),
});

const desktopBuilds = (paths: string[]) => paths.filter((p) => p.startsWith(CODEX_BIN));

test('Windows: the Codex desktop builds are candidates, most recent first', () => {
  const reader = codexBinReader({
    '1111aaaa': { 'codex.exe': 1_000 },
    '247581e40ee272fb': { 'codex.exe': 3_000 },
    '9999ffff': { 'codex.exe': 2_000 },
  });
  assert.deepEqual(desktopBuilds(binaryCandidates('codex', winOptions(reader))), [
    win32.join(CODEX_BIN, '247581e40ee272fb', 'codex.exe'),
    win32.join(CODEX_BIN, '9999ffff', 'codex.exe'),
    win32.join(CODEX_BIN, '1111aaaa', 'codex.exe'),
  ]);
});

test('Windows: a missing or unreadable Codex bin directory yields no candidate', () => {
  assert.deepEqual(desktopBuilds(binaryCandidates('codex', winOptions(codexBinReader(null)))), []);
  assert.deepEqual(desktopBuilds(binaryCandidates('codex', winOptions(codexBinReader({ empty: {} })))), []);
});

test('Windows: helpers and codex-computer-use are never taken for the CLI', () => {
  const reader = codexBinReader({
    abc: { 'codex-command-runner.exe': 1, 'codex-code-mode-host.exe': 1, 'codex-windows-sandbox-setup.exe': 1 },
  });
  const paths = binaryCandidates('codex', winOptions(reader));
  assert.deepEqual(desktopBuilds(paths), []);
  assert.ok(!paths.some((p) => /codex-[a-z-]+\.exe$/i.test(p)));
});

test('Windows: PATH and npm stay ahead of the Codex desktop build', () => {
  const reader = codexBinReader({ abc: { 'codex.exe': 1 } });
  const paths = binaryCandidates('codex', winOptions(reader, 'C:\\Tools'));
  const desktop = paths.indexOf(win32.join(CODEX_BIN, 'abc', 'codex.exe'));
  assert.ok(desktop > paths.indexOf('C:\\Tools\\codex.exe'));
  assert.ok(desktop > paths.indexOf('C:\\Users\\admin\\AppData\\Roaming\\npm\\codex.cmd'));
  assert.equal(desktop, paths.length - 1);
});

test('the Codex desktop discovery is Windows- and codex-only', () => {
  const reader: DirectoryReader = {
    subdirectories: () => { throw new Error('must not be read'); },
    fileMtimeMs: () => { throw new Error('must not be read'); },
  };
  const env = { LOCALAPPDATA: LOCAL };
  for (const platform of ['linux', 'darwin'] as const) {
    assert.ok(!binaryCandidates('codex', { platform, path: '/usr/bin', homeDir: '/home/sam', env, directoryReader: reader })
      .some((p) => p.includes('OpenAI')));
  }
  assert.ok(!binaryCandidates('claude', winOptions(reader)).some((p) => p.includes('OpenAI')));
});

test('Windows: the Codex desktop build is found on disk and a stale pin falls back to it', (t) => {
  const local = mkdtempSync(join(tmpdir(), 'timon-codex-desktop-'));
  t.after(() => rmSync(local, { recursive: true, force: true }));
  const bin = join(local, 'OpenAI', 'Codex', 'bin');
  const older = join(bin, 'aaaa1111', 'codex.exe');
  const newer = join(bin, 'bbbb2222', 'codex.exe');
  for (const file of [older, newer]) {
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, '');
  }
  mkdirSync(join(local, 'OpenAI', 'Codex', 'runtimes', 'cua_node'), { recursive: true });
  writeFileSync(join(local, 'OpenAI', 'Codex', 'runtimes', 'cua_node', 'codex-computer-use.exe'), '');
  utimesSync(older, 1_000, 1_000);
  utimesSync(newer, 2_000, 2_000);
  const options = {
    platform: 'win32' as const, path: '', homeDir: '', env: { LOCALAPPDATA: local },
    installedBinariesFile: join(local, 'absent.json'),
  };
  assert.equal(findExecutableBinary('codex', options), newer);

  const stale = join(bin, '0000dead', 'codex.exe');
  assert.equal(isDesktopBuildPath('codex', stale, options), true);
  assert.equal(resolvePinnedBinary('codex', stale, options), newer);
  // A live pin keeps priority over detection.
  assert.equal(resolvePinnedBinary('codex', older, options), older);
  // Any other broken pin stays an error.
  assert.equal(resolvePinnedBinary('codex', join(local, 'elsewhere', 'codex.exe'), options), null);
  assert.equal(resolvePinnedBinary('claude', stale, options), null);
  // Same stale pin, not under this LOCALAPPDATA or not on Windows: strict.
  assert.equal(resolvePinnedBinary('codex', stale, { ...options, env: { LOCALAPPDATA: join(local, 'other') } }), null);
  assert.equal(resolvePinnedBinary('codex', stale, { ...options, platform: 'linux' }), null);
  assert.equal(resolvePinnedBinary('codex', join(bin, 'not-hex', 'codex.exe'), options), null);

  // The doctor reports the pin, then the detection it falls back to.
  const attempted = pinnedBinaryCandidates('codex', stale, options);
  assert.equal(attempted[0], stale);
  assert.ok(attempted.includes(newer));
  assert.deepEqual(pinnedBinaryCandidates('codex', stale, { ...options, platform: 'linux' }), [stale]);
});

test('isCodexDesktopBuildPath recognises the fingerprinted layout under LOCALAPPDATA only', () => {
  const win = { platform: 'win32' as const, env: { LOCALAPPDATA: LOCAL } };
  const build = win32.join(CODEX_BIN, '247581e40ee272fb');
  assert.equal(isDesktopBuildPath('codex', win32.join(build, 'codex.exe'), win), true);
  // Win32 paths are case-insensitive and accept forward slashes.
  assert.equal(isDesktopBuildPath('codex', 'c:/users/admin/appdata/local/openai/codex/BIN/247581E40EE272FB/CODEX.EXE', win), true);

  assert.equal(isDesktopBuildPath('codex', win32.join(build, 'codex-command-runner.exe'), win), false);
  assert.equal(isDesktopBuildPath('codex', win32.join(LOCAL, 'OpenAI', 'Codex', 'runtimes', 'cua_node', 'codex-computer-use.exe'), win), false);
  assert.equal(isDesktopBuildPath('codex', 'C:\\Users\\admin\\AppData\\Roaming\\npm\\codex.cmd', win), false);
  // Non-hexadecimal, nested or missing fingerprint.
  assert.equal(isDesktopBuildPath('codex', win32.join(CODEX_BIN, 'latest', 'codex.exe'), win), false);
  assert.equal(isDesktopBuildPath('codex', win32.join(CODEX_BIN, 'abc', 'def', 'codex.exe'), win), false);
  assert.equal(isDesktopBuildPath('codex', win32.join(CODEX_BIN, 'codex.exe'), win), false);
  // The same layout outside LOCALAPPDATA.
  assert.equal(isDesktopBuildPath('codex', 'D:\\Tools\\OpenAI\\Codex\\bin\\abc123\\codex.exe', win), false);
  assert.equal(isDesktopBuildPath('codex', win32.join(LOCAL, '..', 'OpenAI', 'Codex', 'bin', 'abc123', 'codex.exe'), win), false);
  // No LOCALAPPDATA, or another platform.
  assert.equal(isDesktopBuildPath('codex', win32.join(build, 'codex.exe'), { platform: 'win32', env: {} }), false);
  for (const platform of ['linux', 'darwin'] as const) {
    assert.equal(isDesktopBuildPath('codex', win32.join(build, 'codex.exe'), { platform, env: { LOCALAPPDATA: LOCAL } }), false);
    assert.equal(isDesktopBuildPath('codex', '/home/sam/.local/OpenAI/Codex/bin/abc123/codex.exe', { platform, env: { LOCALAPPDATA: '/home/sam/.local' } }), false);
  }
});

import { chmodSync } from 'node:fs';
import { posix } from 'node:path';

const MAC_HOME = '/Users/sam';
const CLAUDE_CODE = posix.join(MAC_HOME, 'Library', 'Application Support', 'Claude', 'claude-code');
const claudeBuild = (version: string, root = CLAUDE_CODE) =>
  posix.join(root, version, 'claude.app', 'Contents', 'MacOS', 'claude');

/** In-memory `claude-code/`: version directory → mtime of its executable (`null`: no executable). */
function claudeCodeReader(versions: Record<string, number | null> | null): DirectoryReader {
  return {
    subdirectories: (dir) => {
      if (versions === null || dir !== CLAUDE_CODE) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.keys(versions);
    },
    fileMtimeMs: (file) => {
      const version = Object.keys(versions ?? {}).find((v) => claudeBuild(v) === file);
      return version === undefined ? null : versions?.[version] ?? null;
    },
  };
}

const macOptions = (reader: DirectoryReader, path = '') => ({
  platform: 'darwin' as const, path, homeDir: MAC_HOME, env: {}, directoryReader: reader,
});

const claudeBuilds = (paths: string[]) => paths.filter((p) => p.startsWith(CLAUDE_CODE));

test('macOS: the Claude desktop builds are candidates, highest version first', () => {
  const reader = claudeCodeReader({
    '2.1.9': 5_000,
    '2.1.275': 1_000,
    '2.1.275-beta.1': 9_000,
    '2.10.0': 1_000,
    'next': 3_000,
    'old': 4_000,
    '3.0.0': null,
  });
  assert.deepEqual(claudeBuilds(binaryCandidates('claude', macOptions(reader))), [
    claudeBuild('2.10.0'),
    claudeBuild('2.1.275'),
    claudeBuild('2.1.275-beta.1'),
    claudeBuild('2.1.9'),
    claudeBuild('old'),
    claudeBuild('next'),
  ]);
});

test('macOS: pre-releases of the Claude desktop build follow SemVer precedence', () => {
  const reader = claudeCodeReader({
    '2.1.275-1': 1_000,
    '2.1.275-beta': 1_000,
    '2.1.275-beta.2': 1_000,
    '2.1.275-beta.11': 1_000,
    '2.1.275-alpha': 1_000,
    '2.1.275-alpha.1': 1_000,
    '2.1.275': 1_000,
    '2.1.275-rc.1': 1_000,
    '2.1.274': 1_000,
  });
  assert.deepEqual(claudeBuilds(binaryCandidates('claude', macOptions(reader))), [
    claudeBuild('2.1.275'),
    claudeBuild('2.1.275-rc.1'),
    claudeBuild('2.1.275-beta.11'),
    claudeBuild('2.1.275-beta.2'),
    claudeBuild('2.1.275-beta'),
    claudeBuild('2.1.275-alpha.1'),
    claudeBuild('2.1.275-alpha'),
    claudeBuild('2.1.275-1'),
    claudeBuild('2.1.274'),
  ]);
});

test('macOS: an invalid SemVer directory ranks by mtime, after every valid version', () => {
  const reader = claudeCodeReader({
    '02.1.275': 5_000,
    '2.1.275-beta..1': 4_000,
    '2.1.275-01': 3_000,
    '2.1.275-': 2_000,
    '2.1.9': 1_000,
    '2.1.10+build.7': 1_000,
  });
  assert.deepEqual(claudeBuilds(binaryCandidates('claude', macOptions(reader))), [
    claudeBuild('2.1.10+build.7'),
    claudeBuild('2.1.9'),
    claudeBuild('02.1.275'),
    claudeBuild('2.1.275-beta..1'),
    claudeBuild('2.1.275-01'),
    claudeBuild('2.1.275-'),
  ]);
});

test('macOS: a missing or unreadable claude-code directory yields no candidate', () => {
  assert.deepEqual(claudeBuilds(binaryCandidates('claude', macOptions(claudeCodeReader(null)))), []);
  assert.deepEqual(claudeBuilds(binaryCandidates('claude', macOptions(claudeCodeReader({})))), []);
});

test('macOS: PATH and the usual install locations stay ahead of the Claude desktop build', { skip: POSIX_HOST }, () => {
  const paths = binaryCandidates('claude', macOptions(claudeCodeReader({ '2.1.275': 1 }), '/custom/bin'));
  const desktop = paths.indexOf(claudeBuild('2.1.275'));
  assert.equal(desktop, paths.length - 1);
  for (const earlier of [
    '/custom/bin/claude',
    `${MAC_HOME}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${MAC_HOME}/.volta/bin/claude`,
    `${MAC_HOME}/.npm-global/bin/claude`,
    `${MAC_HOME}/.claude/local/claude`,
  ]) {
    const index = paths.indexOf(earlier);
    assert.ok(index >= 0 && index < desktop, earlier);
  }
});

test('the Claude desktop discovery is macOS- and claude-only', () => {
  const reader: DirectoryReader = {
    subdirectories: () => { throw new Error('must not be read'); },
    fileMtimeMs: () => { throw new Error('must not be read'); },
  };
  for (const platform of ['linux', 'win32'] as const) {
    const paths = binaryCandidates('claude', {
      platform, path: '', homeDir: MAC_HOME, env: {}, directoryReader: reader,
      installedBinariesFile: join(tmpdir(), 'absent-timon-binaries.json'),
    });
    assert.ok(!paths.some((p) => p.includes('claude-code') || p.includes(`${posix.sep}.claude${posix.sep}local`)), platform);
  }
  assert.ok(!binaryCandidates('codex', macOptions(reader)).some((p) => p.includes('claude-code')));
});

test('macOS: the Claude desktop build is found on disk and a stale pin falls back to it', { skip: POSIX_HOST }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-claude-desktop-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const root = posix.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  const older = claudeBuild('2.1.9', root);
  const newer = claudeBuild('2.1.275', root);
  for (const file of [older, newer]) {
    mkdirSync(posix.dirname(file), { recursive: true });
    writeFileSync(file, '#!/bin/sh\n');
    chmodSync(file, 0o755);
  }
  mkdirSync(posix.join(home, 'Library', 'Application Support', 'Claude', 'claude-code-sessions'), { recursive: true });
  const options = { platform: 'darwin' as const, path: '', homeDir: home, env: {} };
  assert.equal(findExecutableBinary('claude', options), newer);

  const stale = claudeBuild('2.1.200', root);
  assert.equal(isDesktopBuildPath('claude', stale, options), true);
  assert.equal(resolvePinnedBinary('claude', stale, options), newer);
  // A live pin keeps priority over detection.
  assert.equal(resolvePinnedBinary('claude', older, options), older);
  // Any other broken pin stays an error.
  assert.equal(resolvePinnedBinary('claude', posix.join(home, 'elsewhere', 'claude'), options), null);
  assert.equal(resolvePinnedBinary('codex', stale, options), null);
  // Same stale pin, under another home or not on macOS: strict.
  assert.equal(resolvePinnedBinary('claude', stale, { ...options, homeDir: posix.join(home, 'other') }), null);
  assert.equal(resolvePinnedBinary('claude', stale, { ...options, platform: 'linux' }), null);
  assert.equal(resolvePinnedBinary('claude', claudeBuild('latest', root), options), null);

  // The doctor reports the pin, then the detection it falls back to.
  const attempted = pinnedBinaryCandidates('claude', stale, options);
  assert.equal(attempted[0], stale);
  assert.ok(attempted.includes(newer));
  assert.deepEqual(pinnedBinaryCandidates('claude', stale, { ...options, platform: 'linux' }), [stale]);
});

test('isClaudeDesktopBuildPath recognises the versioned layout under the home only', () => {
  const mac = { platform: 'darwin' as const, homeDir: MAC_HOME };
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275'), mac), true);
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275-beta.1'), mac), true);

  // Not a semver, nested, or missing version segment.
  assert.equal(isDesktopBuildPath('claude', claudeBuild('latest'), mac), false);
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1'), mac), false);
  for (const invalid of ['02.1.275', '2.1.275-01', '2.1.275-beta..1', '2.1.275-']) {
    assert.equal(isDesktopBuildPath('claude', claudeBuild(invalid), mac), false, invalid);
  }
  assert.equal(isDesktopBuildPath('claude', posix.join(CLAUDE_CODE, 'x', '2.1.275', 'claude.app', 'Contents', 'MacOS', 'claude'), mac), false);
  assert.equal(isDesktopBuildPath('claude', posix.join(CLAUDE_CODE, 'claude.app', 'Contents', 'MacOS', 'claude'), mac), false);
  // Another file of the bundle, or the sessions directory.
  assert.equal(isDesktopBuildPath('claude', posix.join(CLAUDE_CODE, '2.1.275', 'claude.app', 'Contents', 'MacOS', 'helper'), mac), false);
  assert.equal(isDesktopBuildPath('claude', posix.join(MAC_HOME, 'Library', 'Application Support', 'Claude', 'claude-code-sessions', '2.1.275', 'claude.app', 'Contents', 'MacOS', 'claude'), mac), false);
  // The same layout outside this home, or escaping it.
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275', '/Users/other/Library/Application Support/Claude/claude-code'), mac), false);
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275', `${CLAUDE_CODE}/../../../../../other/Library/Application Support/Claude/claude-code`), mac), false);
  // Relative path, no home, or another platform.
  assert.equal(isDesktopBuildPath('claude', 'Library/Application Support/Claude/claude-code/2.1.275/claude.app/Contents/MacOS/claude', mac), false);
  assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275'), { platform: 'darwin', homeDir: '' }), false);
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(isDesktopBuildPath('claude', claudeBuild('2.1.275'), { platform, homeDir: MAC_HOME }), false);
  }
});

/** An executable stub at `file`, parents included. */
function stubBinary(file: string): string {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

const absentInstalled = join(tmpdir(), 'absent-timon-binaries.json');

test('Linux: opencode from its install script is found with a service PATH that omits it', { skip: POSIX_HOST }, (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-opencode-linux-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const options = { platform: 'linux' as const, path: '/usr/bin:/bin', homeDir: home, env: {} };
  assert.equal(findExecutableBinary('opencode', options), null);
  const installed = stubBinary(join(home, '.opencode', 'bin', 'opencode'));
  assert.equal(findExecutableBinary('opencode', options), installed);
  // A copy on the service PATH or in `~/.local/bin` keeps priority; the
  // vendor's own folder comes after the Node managers' (SUG-0006).
  const paths = binaryCandidates('opencode', options);
  assert.deepEqual(paths.slice(0, 3), ['/usr/bin/opencode', '/bin/opencode', join(home, '.local', 'bin', 'opencode')]);
  assert.equal(paths.at(-1), installed);
});

test('macOS: opencode from its install script is a candidate under a LaunchAgent PATH', { skip: POSIX_HOST }, (t) => {
  const paths = binaryCandidates('opencode', { platform: 'darwin', path: '/usr/bin:/bin', homeDir: MAC_HOME, env: {} });
  const installed = paths.indexOf(`${MAC_HOME}/.opencode/bin/opencode`);
  assert.equal(installed, paths.length - 1);
  assert.ok(paths.indexOf('/opt/homebrew/bin/opencode') >= 0 && paths.indexOf('/opt/homebrew/bin/opencode') < installed);

  const home = mkdtempSync(join(tmpdir(), 'timon-opencode-mac-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const onDisk = stubBinary(join(home, '.opencode', 'bin', 'opencode'));
  assert.equal(findExecutableBinary('opencode', { platform: 'darwin', path: '/usr/bin:/bin', homeDir: home, env: {} }), onDisk);
});

test('Windows: opencode is a candidate in its script, Scoop and Chocolatey directories', () => {
  const env = {
    APPDATA: 'C:\\Users\\Sam\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local',
    ProgramData: 'C:\\ProgramData',
  };
  const options = { platform: 'win32' as const, path: 'C:\\Windows\\System32', homeDir: 'C:\\Users\\Sam', env, installedBinariesFile: absentInstalled };
  const paths = binaryCandidates('opencode', options);
  const expected = [
    'C:\\Users\\Sam\\.opencode\\bin\\opencode.exe',
    'C:\\Users\\Sam\\scoop\\shims\\opencode.exe',
    'C:\\ProgramData\\chocolatey\\bin\\opencode.exe',
  ];
  for (const file of expected) assert.ok(paths.includes(file), file);
  // PATH and npm first: the copy the user maintains wins.
  assert.ok(paths.indexOf('C:\\Users\\Sam\\AppData\\Roaming\\npm\\opencode.cmd') < paths.indexOf(expected[0]!));
  assert.ok(paths.indexOf('C:\\Windows\\System32\\opencode.exe') < paths.indexOf(expected[0]!));

  // Roots moved with the package managers' own variables.
  const moved = binaryCandidates('opencode', {
    ...options, env: { ...env, SCOOP: 'D:\\Scoop', ChocolateyInstall: 'D:\\Choco' },
  });
  assert.ok(moved.includes('D:\\Scoop\\shims\\opencode.exe'));
  assert.ok(moved.includes('D:\\Choco\\bin\\opencode.exe'));
  assert.ok(!moved.some((p) => p.startsWith('C:\\Users\\Sam\\scoop') || p.startsWith('C:\\ProgramData')));
  // No home, no ProgramData: nothing is invented.
  assert.deepEqual(binaryCandidates('opencode', { platform: 'win32', path: '', homeDir: '', env: {}, installedBinariesFile: absentInstalled }), []);
});

test('Windows: opencode installed after the daemon started is found on disk', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-opencode-win-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const env = { APPDATA: join(home, 'Roaming'), LOCALAPPDATA: join(home, 'Local'), ProgramData: join(home, 'ProgramData') };
  const options = { platform: 'win32' as const, path: '', homeDir: home, env, installedBinariesFile: absentInstalled };
  assert.equal(findExecutableBinary('opencode', options), null);
  const choco = stubBinary(join(env.ProgramData, 'chocolatey', 'bin', 'opencode.exe'));
  assert.equal(findExecutableBinary('opencode', options), choco);
  const scoop = stubBinary(join(home, 'scoop', 'shims', 'opencode.exe'));
  assert.equal(findExecutableBinary('opencode', options), scoop);
  const script = stubBinary(join(home, '.opencode', 'bin', 'opencode.exe'));
  assert.equal(findExecutableBinary('opencode', options), script);
});

test('Linux and macOS: the Hermes wrappers in ~/.local/bin are found with a service PATH that omits it', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-hermes-posix-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const wrappers = Object.fromEntries((['hermes', 'hermes-acp'] as const)
    .map((name) => [name, stubBinary(join(home, '.local', 'bin', name))]));
  for (const platform of ['linux', 'darwin'] as const) {
    const options = { platform, path: '/usr/bin:/bin', homeDir: home, env: { LOCALAPPDATA: join(home, 'Local') } };
    for (const name of ['hermes', 'hermes-acp'] as const) {
      assert.equal(findExecutableBinary(name, options), wrappers[name], `${platform} ${name}`);
      // The Windows layout is never looked up elsewhere.
      assert.ok(!binaryCandidates(name, options).some((p) => p.startsWith(options.env.LOCALAPPDATA)), `${platform} ${name}`);
    }
  }
});

test('Windows: Hermes is found in %LOCALAPPDATA%\\hermes with a PATH that omits it', (t) => {
  const paths = binaryCandidates('hermes-acp', {
    platform: 'win32', path: 'C:\\Windows\\System32', homeDir: 'C:\\Users\\Sam',
    env: { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local' }, installedBinariesFile: absentInstalled,
  });
  const documented = paths.indexOf('C:\\Users\\Sam\\AppData\\Local\\hermes\\bin\\hermes-acp.exe');
  const variant = paths.indexOf('C:\\Users\\Sam\\AppData\\Local\\hermes\\hermes-agent\\bin\\hermes-acp.exe');
  assert.ok(documented >= 0 && variant > documented);
  // The variant layout closes the list.
  assert.equal(paths.at(-1), 'C:\\Users\\Sam\\AppData\\Local\\hermes\\hermes-agent\\bin\\hermes-acp');

  const home = mkdtempSync(join(tmpdir(), 'timon-hermes-win-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const local = join(home, 'Local');
  const options = { platform: 'win32' as const, path: '', homeDir: home, env: { LOCALAPPDATA: local }, installedBinariesFile: absentInstalled };
  for (const name of ['hermes', 'hermes-acp'] as const) {
    assert.equal(findExecutableBinary(name, options), null);
    const fallback = stubBinary(join(local, 'hermes', 'hermes-agent', 'bin', `${name}.exe`));
    assert.equal(findExecutableBinary(name, options), fallback);
    const installed = stubBinary(join(local, 'hermes', 'bin', `${name}.exe`));
    assert.equal(findExecutableBinary(name, options), installed);
  }
  // Without LOCALAPPDATA there is no Hermes directory to guess.
  assert.ok(!binaryCandidates('hermes', { ...options, env: {} }).some((p) => p.includes('hermes-agent')));
});

test('the installer directories are per binary name', () => {
  const win = {
    platform: 'win32' as const, path: '', homeDir: 'C:\\Users\\Sam', installedBinariesFile: absentInstalled,
    env: { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local', ProgramData: 'C:\\ProgramData' },
  };
  const foreign = (paths: string[]) => paths.filter((p) => /\.opencode|scoop|chocolatey|\\hermes\\/.test(p));
  for (const name of ['node', 'git', 'claude', 'codex', 'grok']) {
    assert.deepEqual(foreign(binaryCandidates(name, win)), [], name);
    assert.deepEqual(foreign(binaryCandidates(name, { platform: 'linux', path: '/usr/bin', homeDir: '/home/sam', env: {} })), [], name);
  }
  assert.ok(!binaryCandidates('hermes', win).some((p) => /\.opencode|scoop|chocolatey/.test(p)));
  assert.ok(!binaryCandidates('opencode', win).some((p) => p.includes('\\hermes\\')));
});

import { npmPrefixCandidates, parseNpmPrefix } from './binary-path.js';

const WINGET = win32.join(LOCAL, 'Microsoft', 'WinGet');

/** In-memory `%LOCALAPPDATA%\Microsoft\WinGet\Packages`: package folder → mtime of its `copilot.exe`. */
function wingetReader(packages: Record<string, number | null> | null): DirectoryReader {
  const root = win32.join(WINGET, 'Packages');
  return {
    subdirectories: (dir) => {
      if (packages === null || dir !== root) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Object.keys(packages);
    },
    fileMtimeMs: (file) => win32.dirname(win32.dirname(file)) === root && win32.basename(file) === 'copilot.exe'
      ? packages?.[win32.basename(win32.dirname(file))] ?? null : null,
  };
}

test('TIM-0093 Windows: copilot is a candidate in the winget links and packages, after PATH and npm', () => {
  const reader = wingetReader({
    'GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe': 1_000,
    'GitHub.Copilot.Prerelease_Microsoft.Winget.Source_8wekyb3d8bbwe': 2_000,
    'GitHub.cli_Microsoft.Winget.Source_8wekyb3d8bbwe': 3_000,
    'GitHub.Copilot_empty': null,
  });
  const options = { ...winOptions(reader, 'C:\\Tools'), env: { ...winOptions(reader).env, ProgramFiles: 'C:\\Program Files' } };
  const paths = binaryCandidates('copilot', options);
  const links = paths.indexOf(win32.join(WINGET, 'Links', 'copilot.exe'));
  const machineLinks = paths.indexOf('C:\\Program Files\\WinGet\\Links\\copilot.exe');
  const prerelease = paths.indexOf(win32.join(WINGET, 'Packages', 'GitHub.Copilot.Prerelease_Microsoft.Winget.Source_8wekyb3d8bbwe', 'copilot.exe'));
  const stable = paths.indexOf(win32.join(WINGET, 'Packages', 'GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe', 'copilot.exe'));
  assert.ok(links > paths.indexOf('C:\\Tools\\copilot.exe'));
  assert.ok(links > paths.indexOf('C:\\Users\\admin\\AppData\\Roaming\\npm\\copilot.cmd'));
  // Links first, then the packages, most recently written first.
  assert.ok(links < machineLinks && machineLinks < prerelease && prerelease < stable, JSON.stringify(paths));
  // Other packages, and a Copilot folder without its executable, are not taken.
  assert.ok(!paths.some((p) => p.includes('GitHub.cli_') || p.includes('GitHub.Copilot_empty')));
  // No WinGet\Packages folder: the links alone.
  const bare = binaryCandidates('copilot', winOptions(wingetReader(null)));
  assert.ok(bare.includes(win32.join(WINGET, 'Links', 'copilot.exe')));
  assert.ok(!bare.some((p) => p.includes('Packages')));
});

test('TIM-0093: the winget discovery is Windows- and copilot-only', () => {
  const reader: DirectoryReader = {
    subdirectories: () => { throw new Error('must not be read'); },
    fileMtimeMs: () => { throw new Error('must not be read'); },
  };
  for (const name of ['claude', 'codex', 'opencode', 'node']) {
    assert.ok(!binaryCandidates(name, winOptions(reader)).some((p) => p.includes('WinGet')), name);
  }
  for (const platform of ['linux', 'darwin'] as const) {
    assert.ok(!binaryCandidates('copilot', {
      platform, path: '/usr/bin', homeDir: '/home/sam', env: { LOCALAPPDATA: LOCAL }, directoryReader: reader,
    }).some((p) => p.includes('WinGet')), platform);
  }
});

test('TIM-0093 Windows: copilot installed by winget after the daemon started is found on disk', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timon-copilot-winget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const local = join(root, 'Local');
  const options = {
    platform: 'win32' as const, path: '', homeDir: root, env: { LOCALAPPDATA: local },
    installedBinariesFile: absentInstalled, npmPrefix: () => null,
  };
  assert.equal(findExecutableBinary('copilot', options), null);
  const pkg = stubBinary(join(local, 'Microsoft', 'WinGet', 'Packages', 'GitHub.Copilot_Microsoft.Winget.Source_8wekyb3d8bbwe', 'copilot.exe'));
  assert.equal(findExecutableBinary('copilot', options), pkg);
  const link = stubBinary(join(local, 'Microsoft', 'WinGet', 'Links', 'copilot.exe'));
  assert.equal(findExecutableBinary('copilot', options), link);
});

test('TIM-0093 Windows: an npm CLI under a custom npm prefix is found, npm asked last', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timon-npm-prefix-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = join(root, 'npm-global');
  let asked = 0;
  const options = {
    platform: 'win32' as const, path: '', homeDir: root,
    env: { APPDATA: join(root, 'Roaming'), LOCALAPPDATA: join(root, 'Local') },
    installedBinariesFile: absentInstalled,
    npmPrefix: () => { asked += 1; return prefix; },
  };
  assert.equal(findExecutableBinary('copilot', options), null);
  const shim = stubBinary(join(prefix, 'copilot.cmd'));
  assert.equal(findExecutableBinary('copilot', options), shim);
  assert.deepEqual(npmPrefixCandidates('codex', options), ['.exe', '.cmd', '.bat', ''].map((ext) => join(prefix, `codex${ext}`)));

  // Found in a known location: npm is never asked.
  asked = 0;
  const known = stubBinary(join(root, 'Roaming', 'npm', 'copilot.cmd'));
  assert.equal(findExecutableBinary('copilot', options), known);
  assert.equal(asked, 0);
  // Not an npm CLI, or not Windows: npm is never asked either.
  assert.equal(findExecutableBinary('git', options), null);
  assert.deepEqual(npmPrefixCandidates('copilot', { ...options, platform: 'linux' }), []);
  assert.equal(asked, 0);
  // npm without a usable answer: nothing is invented.
  assert.deepEqual(npmPrefixCandidates('copilot', { ...options, npmPrefix: () => null }), []);
});

test('TIM-0093: the npm prefix is one absolute path or nothing', () => {
  assert.equal(parseNpmPrefix('D:\\npm-global\r\n'), 'D:\\npm-global');
  assert.equal(parseNpmPrefix('/home/sam/.npm-global\n'), '/home/sam/.npm-global');
  assert.equal(parseNpmPrefix(''), null);
  assert.equal(parseNpmPrefix('npm-global'), null);
  assert.equal(parseNpmPrefix('npm warn config\nD:\\npm-global'), null);
});

// SUG-0006: a CLI installed by hand while the setup screen is open must be
// found by the next lookup, from a running daemon whose PATH never learnt
// the folder — no restart.
test('SUG-0006: a binary that appears in a candidate folder is found by the next lookup', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-redetect-'));
  try {
    const options = { platform: 'linux' as const, path: '', homeDir: home, env: {} };
    assert.equal(findExecutableBinary('timon-probe-cli', options), null);
    const installed = stubBinary(join(home, '.local', 'bin', 'timon-probe-cli'));
    assert.equal(findExecutableBinary('timon-probe-cli', options), installed);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SUG-0006: npm CLIs under nvm, Volta and npm-global are found without the login shell', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-nvm-'));
  try {
    for (const platform of ['linux', 'darwin'] as const) {
      const options = { platform, path: '', homeDir: home, env: {} };
      const nvm = join(home, '.nvm', 'versions', 'node');
      mkdirSync(join(nvm, 'not-a-version'), { recursive: true });
      stubBinary(join(nvm, 'v18.20.0', 'bin', 'timon-probe-npm'));
      const newest = stubBinary(join(nvm, 'v22.3.0', 'bin', 'timon-probe-npm'));
      assert.equal(findExecutableBinary('timon-probe-npm', options), newest);
      const candidates = binaryCandidates('timon-probe-npm', options);
      assert.ok(candidates.includes(join(home, '.volta', 'bin', 'timon-probe-npm')));
      assert.ok(candidates.includes(join(home, '.npm-global', 'bin', 'timon-probe-npm')));
      assert.ok(!candidates.some((c) => c.includes('not-a-version')));
    }
    // NVM_DIR moves nvm's root; the default one is then not read.
    const custom = join(home, 'custom-nvm');
    const moved = stubBinary(join(custom, 'versions', 'node', 'v20.0.0', 'bin', 'timon-probe-moved'));
    assert.equal(findExecutableBinary('timon-probe-moved', { platform: 'linux', path: '', homeDir: home, env: { NVM_DIR: custom } }), moved);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('SUG-0006: Linuxbrew, Volta and nvm-windows folders are candidates', () => {
  const linux = binaryCandidates('codex', { platform: 'linux', path: '', homeDir: '/home/sam', env: {} });
  assert.ok(linux.includes(join('/home/linuxbrew/.linuxbrew/bin', 'codex'))); // portability: Linux candidate under test
  assert.ok(linux.includes(join('/usr/local/bin', 'codex'))); // portability: Linux candidate under test
  const env = { LOCALAPPDATA: 'C:\\Users\\Sam\\AppData\\Local', NVM_SYMLINK: 'D:\\nodejs' };
  const windows = binaryCandidates('node', { platform: 'win32', path: '', homeDir: 'C:\\Users\\Sam', env, installedBinariesFile: absentInstalled });
  assert.ok(windows.includes('D:\\nodejs\\node.exe'));
  assert.ok(windows.includes('C:\\Users\\Sam\\AppData\\Local\\Volta\\bin\\node.exe'));
});

test('tailscale: the folders its installers use are candidates on Windows and macOS', () => {
  const win = binaryCandidates('tailscale', {
    platform: 'win32', path: '', homeDir: '', env: { ProgramFiles: 'C:\\Program Files' },
    installedBinariesFile: join(tmpdir(), 'absent-timon-binaries.json'),
    directoryReader: { subdirectories: () => [], fileMtimeMs: () => null },
  });
  assert.ok(win.includes('C:\\Program Files\\Tailscale\\tailscale.exe'), win.join('\n'));
  if (process.platform === 'win32') return; // the macOS half needs a POSIX host, see POSIX_HOST
  const mac = binaryCandidates('tailscale', { platform: 'darwin', path: '/usr/bin', homeDir: '/Users/sam' });
  assert.ok(mac.includes('/Applications/Tailscale.app/Contents/MacOS/tailscale'), mac.join('\n'));
  // The bundle's real name, for a case-sensitive volume.
  assert.ok(mac.includes('/Applications/Tailscale.app/Contents/MacOS/Tailscale'), mac.join('\n'));
});

// GHSA-f58g: a binary a mission could have written is never the one the
// daemon runs, wherever it sits on PATH.
test('a binary in a folder a mission writes is skipped for the next one', { skip: process.platform === 'win32' }, (t) => {
  // Canonical root: a link resolves to `/private/var/…` on macOS.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'timon-planted-bin-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const timonHome = join(root, 'timon-home');
  const exe = (dir: string) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'git'), '#!/bin/sh\n', { mode: 0o755 });
    return dir;
  };
  const planted = exe(join(timonHome, 'worktrees', 'task', 'bin'));
  const scratch = exe(join(timonHome, 'tmp', 'missions', 'm1'));
  const system = exe(join(root, 'usr-bin'));
  const options = { platform: 'linux' as const, homeDir: '', env: {}, timonHome };
  assert.equal(findExecutableBinary('git', { ...options, path: [planted, scratch, system].join(':') }), join(system, 'git'));
  // A relative entry resolves against the daemon's cwd, a worktree as often as not.
  assert.equal(findExecutableBinary('git', { ...options, path: ['.', '', system].join(':') }), join(system, 'git'));
  // A link elsewhere that leads into a worktree is judged by where it leads.
  // Links are only followed for the host's own platform: a simulated one has
  // no disk to resolve them on.
  const linkDir = join(root, 'linked');
  mkdirSync(linkDir);
  symlinkSync(join(planted, 'git'), join(linkDir, 'git'));
  assert.equal(findExecutableBinary('git', { ...options, platform: process.platform, path: [linkDir, system].join(':') }), join(system, 'git'));
  // A pin into a worktree is refused like any other candidate.
  assert.equal(findExecutableBinary(join(planted, 'git'), options), null);
  // What the daemon installs itself stays reachable.
  const plugin = exe(join(timonHome, 'plugins', 'p', 'bin'));
  assert.equal(findExecutableBinary('git', { ...options, path: [plugin, system].join(':') }), join(plugin, 'git'));
});
