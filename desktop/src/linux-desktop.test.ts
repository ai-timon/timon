/**
 * The Linux launcher's "New Window" (01/11/2026). electron-builder 25 has no
 * desktop actions: `electron-builder.yml` slips the action group into the
 * value of the last `desktop` key. These tests render the deb and AppImage
 * entries with electron-builder's own code, so a version that writes the
 * entry differently fails here, not on a tester's dock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { DEV_DESKTOP_ID, NEW_WINDOW_FLAG, devShellName } from './linux-desktop.js';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml') as { load: (text: string) => unknown };
const { LinuxTargetHelper } = require('app-builder-lib/out/targets/LinuxTargetHelper.js') as {
  LinuxTargetHelper: new (packager: unknown) => { computeDesktopEntry: (options: unknown, exec?: string, extra?: Record<string, string>) => Promise<string> };
};

type Options = Record<string, unknown> & { desktop?: Record<string, string>; category?: string };
const config = yaml.load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8')) as {
  productName: string; linux: Options; deb: Options; appImage: Options; mac?: { category?: string };
};
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; description: string };

/** What electron-builder's packager hands the helper, for this config (`linuxPackager.js`). */
const packager = {
  appInfo: { productName: config.productName, sanitizedProductName: config.productName, description: pkg.description },
  executableName: pkg.name.toLowerCase(),
  fileAssociations: [],
  config,
  platformSpecificBuildOptions: config.linux,
};

/** A target's options as electron-builder merges them: `linux`, then the target's own. */
const optionsOf = (target: 'deb' | 'appImage'): Options => ({ ...config.linux, ...config[target] });

/** The groups of a desktop entry, each a map of its keys, in order. */
function groups(entry: string): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const line of entry.split('\n')) {
    if (line === '') continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) { current = new Map(); out.set(header[1]!, current); continue; }
    const eq = line.indexOf('=');
    assert.ok(current && eq > 0, `a key=value line inside a group: ${JSON.stringify(line)}`);
    assert.ok(!current.has(line.slice(0, eq)), `${line.slice(0, eq)} set twice`);
    current.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

async function render(target: 'deb' | 'appImage'): Promise<Map<string, Map<string, string>>> {
  const helper = new LinuxTargetHelper(packager);
  // Exactly the calls of FpmTarget (deb) and AppImageTarget.
  const entry = target === 'deb'
    ? await helper.computeDesktopEntry(optionsOf(target))
    : await helper.computeDesktopEntry(optionsOf(target), 'AppRun --no-sandbox %U', { 'X-AppImage-Version': '0.0.0' });
  return groups(entry);
}

for (const target of ['deb', 'appImage'] as const) {
  test(`${target}: the entry offers "New Window", which launches the same binary with ${NEW_WINDOW_FLAG}`, async () => {
    const entry = await render(target);
    assert.deepEqual([...entry.keys()], ['Desktop Entry', 'Desktop Action new-window']);
    const main = entry.get('Desktop Entry')!;
    const action = entry.get('Desktop Action new-window')!;
    assert.equal(main.get('Actions'), 'new-window;');
    assert.equal(main.get('Categories'), 'Development;', 'Categories stays in the main group');
    assert.equal(main.get('Comment'), pkg.description, 'Comment stays in the main group, with the package description');
    assert.equal(main.get('Type'), 'Application');
    assert.equal(action.get('Name'), 'New Window');
    assert.equal(action.get('Name[fr]'), 'Nouvelle fenêtre'); // french-ok: the French locale under test
    assert.deepEqual([...action.keys()].sort(), ['Exec', 'Name', 'Name[fr]'], 'nothing of the main group leaked into the action');
    const program = main.get('Exec')!.replace(/ %U$/, '');
    assert.equal(action.get('Exec'), `${program} ${NEW_WINDOW_FLAG}`);
  });
}

/**
 * Electron names a window's class `productName || name` of the package.json
 * it runs; electron-builder copies ours without adding productName (checked in
 * the app.asar of a build). A StartupWMClass of `Timon`, its default, left
 * AppImage windows beside their launcher instead of on it.
 */
test('the packaged entry claims the class Electron gives a packaged window: the package name', async () => {
  const raw = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<string, unknown>;
  assert.equal(raw.productName, undefined, 'a productName would rename the class');
  assert.equal((config as Record<string, unknown>).extraMetadata, undefined, 'so would extraMetadata');
  for (const target of ['deb', 'appImage'] as const) {
    assert.equal((await render(target)).get('Desktop Entry')!.get('StartupWMClass'), pkg.name);
  }
  assert.equal(config.linux.desktop?.StartupWMClass, pkg.name, 'and any other Linux target');
  assert.equal(config.linux.executableName, undefined, 'the deb action names /opt/<productName>/<package name>');
});

test('from the sources on Linux the shell renames itself after the dev entry, nowhere else', () => {
  assert.equal(devShellName('linux', false), DEV_DESKTOP_ID);
  assert.equal(devShellName('linux', true), null, 'a package keeps its productName');
  assert.equal(devShellName('darwin', false), null);
  assert.equal(devShellName('win32', false), null);
});
