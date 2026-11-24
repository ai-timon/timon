/**
 * A project's `.claude/skills|commands` folder is editable from Timon on every
 * OS — the `/` regex never matched a resolved Windows path (TODO #541) — and
 * nothing outside the managed roots is.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

const claudeHome = mkdtempSync(join(process.env.TIMON_HOME as string, 'claude-home-'));
process.env.CLAUDE_CONFIG_DIR = claudeHome;
const { inProjectClaudeDir, isManagedPath, writeEntryFile } = await import('./skill-registry.js');

test('a Windows project path to .claude\\skills or .claude\\commands is recognised', () => {
  assert.ok(inProjectClaudeDir(win32.join('C:\\', 'Users', 'sam', 'proj', '.claude', 'skills', 'x', 'SKILL.md'), win32.sep));
  assert.ok(inProjectClaudeDir(win32.join('D:\\', 'w', '.claude', 'commands', 'go.md'), win32.sep));
});

test('the folders themselves, look-alikes and POSIX backslash names are not', () => {
  for (const [path, separator] of [
    [win32.join('C:\\', 'proj', '.claude', 'skills'), win32.sep],
    [win32.join('C:\\', 'proj', 'claude', 'skills', 'x.md'), win32.sep],
    [win32.join('C:\\', 'proj', '.claude', 'agents', 'x.md'), win32.sep],
    [posix.join('/home', 'sam', 'x\\.claude\\skills\\evil'), posix.sep],
  ] as const) {
    assert.equal(inProjectClaudeDir(path, separator), false, path);
  }
  assert.ok(inProjectClaudeDir(posix.join('/home', 'sam', 'proj', '.claude', 'skills', 'x', 'SKILL.md'), posix.sep));
});

test('on this host: a project skill is managed, anything else and the plugins cache are refused', () => {
  const proj = mkdtempSync(join(process.env.TIMON_HOME as string, 'proj-'));
  assert.ok(isManagedPath(join(proj, '.claude', 'commands', 'go.md')));
  assert.equal(isManagedPath(join(proj, 'notes', 'go.md')), false);
  assert.equal(isManagedPath(join(claudeHome, 'plugins', 'p', '.claude', 'skills', 'x', 'SKILL.md')), false);

  // A backslash is only a name character outside Windows: there this path IS
  // a project skill folder, rightly managed.
  if (process.platform !== 'win32') {
    const outside = join(proj, 'x\\.claude\\skills\\evil.md');
    assert.throws(() => writeEntryFile(outside, 'pwned'), /unmanaged path/);
    assert.equal(existsSync(outside), false);
  }
});
