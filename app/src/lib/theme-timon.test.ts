/**
 * The Timon theme, a built-in plugin package (`plugins/theme-timon`): the
 * default theme of an account without a row, worn only by the account that
 * has it as its theme, the 2026 palette in dark and light, and a floor copy
 * of its tokens that must stay equal to the package's.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_CHROME_PREFS, isClientPluginWanted, type PublicPlugin } from './plugin-host/loader';
import { ThemeFloor } from './plugin-host/theme-floor';
import { DEFAULT_USER_PREFS } from './auth';
import { TIMON_THEME_PLUGIN, TIMON_THEME_TOKENS_CSS } from '@/plugins-client/theme-timon-floor';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

/** The floor takes an optional props object: typed here so `createElement` keeps the `theme` prop. */
const Floor = ThemeFloor as (props: { theme?: string }) => React.ReactElement;

const repo = resolve(process.cwd(), '..');
const pkgDir = join(repo, 'plugins', 'theme-timon');
const clientSource = readFileSync(join(pkgDir, 'lib', 'client.js'), 'utf8');
const template = (name: string) => new RegExp(`const ${name} = \`([\\s\\S]*?)\``).exec(clientSource)?.[1] ?? '';

test('the Timon theme is the default an account without a row gets', () => {
  assert.equal(DEFAULT_USER_PREFS.theme, TIMON_THEME_PLUGIN);
  assert.equal(DEFAULT_CHROME_PREFS.theme, TIMON_THEME_PLUGIN);
});

test('a built-in package: listed, a theme manifest, named Timon', () => {
  const list = JSON.parse(readFileSync(join(repo, 'orchestrator', 'builtin-plugins.json'), 'utf8')) as { plugins: { pkg: string; source: string; enabledByDefault?: boolean }[] };
  const entry = list.plugins.find((p) => p.source === '../plugins/theme-timon');
  assert.ok(entry && entry.enabledByDefault !== false, 'shipped and on');
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { name: string; timon: { id: string; kind: string; label: string; client: { slots: string[] } } };
  assert.equal(manifest.name, entry.pkg);
  assert.equal(manifest.timon.id, TIMON_THEME_PLUGIN);
  assert.equal(manifest.timon.kind, 'theme');
  assert.equal(manifest.timon.label, 'Timon');
  assert.deepEqual(manifest.timon.client.slots, ['theme']);
});

test('installed is not worn: the loader mounts it only for the account that chose it', () => {
  const plugin = { id: TIMON_THEME_PLUGIN, state: 'active', kind: ['theme'], client: { rev: '1', slots: ['theme'] } } as unknown as PublicPlugin;
  assert.equal(isClientPluginWanted(plugin, { theme: TIMON_THEME_PLUGIN, layout: '@timon/ui-layout' }), true);
  assert.equal(isClientPluginWanted(plugin, { theme: '@timon/ui-theme', layout: '@timon/ui-layout' }), false);
});

test('the package registers its palette and its glows in the theme slot', async (t) => {
  const platform = clientSource.replace(/import React from 'react'\n/, 'const React = globalThis.__timonThemeReact\n');
  assert.notEqual(platform, clientSource, 'the client imports react');
  Object.assign(globalThis, { __timonThemeReact: React });
  const dir = mkdtempSync(join(tmpdir(), 'theme-timon-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'client.mjs'), platform);
  const mod = await import(pathToFileURL(join(dir, 'client.mjs')).href) as { apply: (ctx: unknown) => unknown };
  let slot = '';
  let Component: React.ComponentType | null = null;
  mod.apply({ slots: { register: (options: { slot: string }, C: React.ComponentType) => { slot = options.slot; Component = C; return () => undefined; } } });
  assert.equal(slot, 'theme');
  const html = renderToStaticMarkup(React.createElement(Component!));
  assert.ok(html.includes('id="timon-theme-timon"') && html.includes('--surface-0: 266 15% 10.5%') && html.includes('radial-gradient'));
});

test('the floor copy is the package\'s tokens, word for word', () => {
  const tokens = template('TOKENS');
  assert.ok(tokens.includes('--primary'), 'TOKENS read from the package');
  assert.equal(TIMON_THEME_TOKENS_CSS, tokens, 'app/src/plugins-client/theme-timon-floor.ts must copy plugins/theme-timon/lib/client.js');
});

test('the palette: the website\'s violet-black in dark, beige in light, peach and copper', () => {
  const [dark, light] = template('TOKENS').split(':root.light');
  assert.ok(dark && light);
  assert.match(dark, /--surface-0: 266 15% 10\.5%;/);
  // The frame, the islands and the cards read apart: steps of at least 2.5 points, the frame well below.
  const lightness = (name: string) => Number(new RegExp(`--${name}: \\d+ \\d+% ([\\d.]+)%`).exec(dark)?.[1]);
  assert.ok(lightness('surface-0') - lightness('chrome') >= 5, 'islands stand off the frame');
  assert.ok(lightness('surface-1') - lightness('surface-0') >= 2.5, 'cards stand off the islands');
  assert.ok(lightness('border') > lightness('surface-4'), 'borders above the highest surface');
  assert.match(dark, /--primary: 24 90% 77\.3%;/);
  assert.match(dark, /--foreground: 30 50% 93\.7%;/);
  assert.match(light, /--surface-0: 33 32% 93\.2%;/);
  assert.match(light, /--primary: 21 48% 47\.8%;/);
  const surfaces = (block: string) => [...block.matchAll(/--surface-\d: (\d+) (\d+)%/g)].map((m) => ({ h: Number(m[1]), s: Number(m[2]) }));
  assert.ok(surfaces(dark).length >= 5 && surfaces(light).length >= 5);
  for (const { h, s } of surfaces(dark)) assert.ok(h >= 260 && h <= 280 && s >= 10, `violet-black like the site: ${h} ${s}%`);
  for (const { h, s } of surfaces(light)) assert.ok(h >= 25 && h <= 40 && s >= 30, `beige, not neutral: ${h} ${s}%`);
});

test('the glows stay very light, and never reach the floor', () => {
  const alphas = [...template('GLOW').matchAll(/\/ (0\.\d+)\)/g)].map((m) => Number(m[1]));
  assert.ok(alphas.length >= 4);
  for (const a of alphas) assert.ok(a <= 0.08, `glow ${a}`);
  assert.ok(!TIMON_THEME_TOKENS_CSS.includes('radial-gradient'));
});

test('the floor paints Timon\'s tokens before hydration for an account that wears it, after the product\'s', () => {
  const worn = renderToStaticMarkup(React.createElement(Floor, { theme: TIMON_THEME_PLUGIN }));
  assert.ok(worn.includes('@layer timon-floor'));
  assert.ok(worn.lastIndexOf('--surface-0: 266 15% 10.5%') > worn.indexOf('--surface-0: 220 12% 11%'), 'after the product\'s, so it wins in the layer');
  const product = renderToStaticMarkup(React.createElement(Floor, { theme: '@timon/ui-theme' }));
  assert.ok(!product.includes('266 15% 10.5%'), 'an account on the product theme gets the product floor only');
});
