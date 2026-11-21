import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dockIconPath, DOCK_ICONS, parseDockIconRequest, readDockIcon, writeDockIcon } from './dock-icon.js';

test('a Dock never set, or a damaged choice, shows the classic icon', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-dock-icon-'));
  assert.equal(readDockIcon(home), 'classic');
  writeFileSync(join(home, 'dock-icon.json'), '{broken');
  assert.equal(readDockIcon(home), 'classic');
  writeFileSync(join(home, 'dock-icon.json'), JSON.stringify({ icon: 'neon' }));
  assert.equal(readDockIcon(home), 'classic', 'an unknown icon is not shown');
});

test('a choice is kept across launches', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-dock-icon-'));
  assert.equal(writeDockIcon(home, 'dark'), true);
  assert.equal(readDockIcon(home), 'dark');
  assert.equal(writeDockIcon(home, 'classic'), true);
  assert.equal(readDockIcon(home), 'classic');
  assert.equal(writeDockIcon(join(home, 'missing', 'folder'), 'dark'), false, 'an unwritable home reports it');
});

test('a page names an icon, never a path', () => {
  assert.equal(parseDockIconRequest({ icon: 'dark' }), 'dark');
  assert.equal(parseDockIconRequest({ icon: 'classic' }), 'classic');
  assert.equal(parseDockIconRequest({ icon: '../../etc/passwd' }), null);
  assert.equal(parseDockIconRequest({ icon: 'icon-512-dark.png' }), null);
  assert.equal(parseDockIconRequest('dark'), null);
  assert.equal(parseDockIconRequest(null), null);
});

test('every icon has its picture beside the classic one in app/public', () => {
  const classic = fileURLToPath(new URL('../../app/public/icon-512.png', import.meta.url));
  assert.equal(dockIconPath(classic, 'classic'), classic);
  for (const icon of DOCK_ICONS) assert.ok(existsSync(dockIconPath(classic, icon)), `${icon} has no picture`);
});
