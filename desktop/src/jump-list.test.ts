import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { WINDOWS_APP_USER_MODEL_ID, windowsUserTasks } from './jump-list.js';

const EXE = 'C:\\Program Files\\Timon\\Timon.exe';

test('Windows: the jump list of a package relaunches Timon with --new-window, in the user\'s language', () => {
  assert.deepEqual(windowsUserTasks({ platform: 'win32', packaged: true, execPath: EXE, locale: 'fr-FR' }), [{
    program: EXE, arguments: '--new-window', title: 'Nouvelle fenêtre', description: 'Nouvelle fenêtre', iconPath: EXE, iconIndex: 0, // french-ok: the French locale under test
  }]);
  assert.equal(windowsUserTasks({ platform: 'win32', packaged: true, execPath: EXE, locale: 'en-US' })![0]!.title, 'New window');
});

test('no jump list from the sources (electron.exe alone is not Timon), nor off Windows', () => {
  assert.equal(windowsUserTasks({ platform: 'win32', packaged: false, execPath: EXE, locale: 'en' }), null);
  assert.equal(windowsUserTasks({ platform: 'linux', packaged: true, execPath: '/opt/Timon/timon-desktop', locale: 'en' }), null);
  assert.equal(windowsUserTasks({ platform: 'darwin', packaged: true, execPath: '/Applications/Timon.app', locale: 'en' }), null);
});

test('the shell takes the AppUserModelID the installer writes on its shortcuts', () => {
  const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  assert.equal(/^appId: (.+)$/m.exec(yml)?.[1], WINDOWS_APP_USER_MODEL_ID);
});
