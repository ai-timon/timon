// french-ok-file: the French locale of the stale-shell dialog under test
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { launchedOtherBuild, shellBuild, staleShellCopy } from './shell-build.js';

test('from the sources, a build is the version and the time its main script was written', () => {
  assert.equal(shellBuild({ packaged: false, version: '0.1.5', mainModifiedMs: 1_761_998_000_123.75 }), '0.1.5+1761998000123');
  assert.equal(shellBuild({ packaged: false, version: '0.1.5', mainModifiedMs: null }), '0.1.5', 'an unreadable script leaves the version alone');
});

/**
 * Review a4ea75d4: inside `app.asar`, Electron answers `stat` with the time the
 * process loaded the archive, so two launches of one package read two mtimes.
 */
test('in a package, two launches of the same version are the same build, whatever the asar mtime reads', () => {
  const first = shellBuild({ packaged: true, version: '0.1.5', mainModifiedMs: 1_793_543_433_310 });
  const second = shellBuild({ packaged: true, version: '0.1.5', mainModifiedMs: 1_793_543_434_372 });
  assert.equal(first, '0.1.5');
  assert.equal(launchedOtherBuild(first, { build: second }), false, 'a second launch opens a window');
  assert.equal(launchedOtherBuild(first, { build: shellBuild({ packaged: true, version: '0.1.6', mainModifiedMs: 1 }) }), true, 'an update installed while Timon ran');
  assert.equal(launchedOtherBuild(first, { build: shellBuild({ packaged: true, version: '0.1.5-rc.2', mainModifiedMs: 1 }) }), true, 'a release candidate is another build');
});

test('main.ts names its build with app.isPackaged', () => {
  const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
  assert.match(main, /const ownBuild = shellBuild\(\{ packaged: app\.isPackaged, version: app\.getVersion\(\),/);
});

test('only a launch that names another build, newer or older, is another build', () => {
  const own = shellBuild({ packaged: false, version: '0.1.5', mainModifiedMs: 200 });
  assert.equal(launchedOtherBuild(own, { build: own }), false);
  assert.equal(launchedOtherBuild(own, { build: shellBuild({ packaged: false, version: '0.1.5', mainModifiedMs: 300 }) }), true, 'a rebuild from the sources');
  assert.equal(launchedOtherBuild(own, { build: shellBuild({ packaged: false, version: '0.1.5', mainModifiedMs: 100 }) }), true, 'an older build');
  assert.equal(launchedOtherBuild(own, { build: '0.1.6' }), true, 'an update installed while Timon ran');
  for (const silent of [undefined, null, {}, { build: '' }, { build: 42 }, 'build', []]) {
    assert.equal(launchedOtherBuild(own, silent), false, `${JSON.stringify(silent)}: an older shell says nothing`);
  }
});

test('the restart notice speaks the user\'s language and does not claim an update', () => {
  assert.match(staleShellCopy('fr-FR', 'Timon').detail, /Quittez-le complètement/);
  assert.match(staleShellCopy('en-US', 'Timon').message, /^Another version of Timon was launched/);
  for (const locale of ['fr-FR', 'en-US']) {
    const { message, detail } = staleShellCopy(locale, 'Timon');
    assert.doesNotMatch(`${message} ${detail}`, /mis à jour|updated/);
  }
});
