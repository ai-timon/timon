import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEV_DESKTOP_ID, NEW_WINDOW_FLAG, devDesktopEntry, entryPath, execArgument } from './install-dev-desktop-entry.mjs';

test('the dev entry claims the class and the flag the shell uses (copies of src/linux-desktop.ts)', () => {
  const source = readFileSync(new URL('../src/linux-desktop.ts', import.meta.url), 'utf8');
  assert.equal(/export const DEV_DESKTOP_ID = '([^']+)'/.exec(source)?.[1], DEV_DESKTOP_ID);
  assert.equal(/export const NEW_WINDOW_FLAG = '([^']+)'/.exec(source)?.[1], NEW_WINDOW_FLAG);
});

test('the dev entry starts this checkout like npm start, and offers "New Window"', () => {
  const entry = devDesktopEntry({
    electron: '/src/timon/desktop/node_modules/electron/dist/electron',
    main: '/src/timon/desktop/dist/main.js',
    cwd: '/src/timon/desktop',
    icon: '/src/timon/app/public/icon-dev-512.png',
  });
  const lines = entry.split('\n');
  const action = lines.indexOf('[Desktop Action new-window]');
  assert.equal(lines[0], '[Desktop Entry]');
  assert.ok(action > 0);
  const main = lines.slice(0, action);
  assert.ok(main.includes('Exec=/src/timon/desktop/node_modules/electron/dist/electron /src/timon/desktop/dist/main.js %U'));
  assert.ok(main.includes('Path=/src/timon/desktop'));
  assert.ok(main.includes(`StartupWMClass=${DEV_DESKTOP_ID}`));
  assert.ok(main.includes('Actions=new-window;'));
  assert.deepEqual(lines.slice(action + 1).filter(Boolean), [
    'Name=New Window',
    'Name[fr]=Nouvelle fenêtre', // french-ok: the French name of the action under test
    'Exec=/src/timon/desktop/node_modules/electron/dist/electron /src/timon/desktop/dist/main.js --new-window',
  ]);
});

test('an Exec argument with spaces or reserved characters is quoted and escaped', () => {
  assert.equal(execArgument('/home/a/timon/dist/main.js'), '/home/a/timon/dist/main.js');
  assert.equal(execArgument('/home/a b/main.js'), '"/home/a b/main.js"');
  assert.equal(execArgument('/x/$HOME/"q"/`c`\\'), '"/x/\\$HOME/\\"q\\"/\\`c\\`\\\\"');
  assert.equal(execArgument('/x/100%'), '"/x/100%%"');
});

test('the entry goes under XDG_DATA_HOME when it is absolute, else ~/.local/share', () => {
  assert.equal(entryPath({ XDG_DATA_HOME: '/data' }, '/home/a'), join('/data', 'applications', 'timon-dev.desktop'));
  assert.equal(entryPath({}, '/home/a'), join('/home/a', '.local', 'share', 'applications', 'timon-dev.desktop'));
  assert.equal(entryPath({ XDG_DATA_HOME: 'relative' }, '/home/a'), join('/home/a', '.local', 'share', 'applications', 'timon-dev.desktop'));
});
