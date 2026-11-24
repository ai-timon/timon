/**
 * T.7 — Appearance lists are `caps.surfaces.themes` / `.layouts`
 * (gallery labels). A revoked grant falls back without a broken screen.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  appearanceOptions,
  chromeSelection,
  layoutSelection,
  themeSelection,
  type AppearanceCatalogRow,
} from './appearance-options';
import type { Capabilities } from './capabilities';
import { PRODUCT_LAYOUT_PLUGIN, PRODUCT_THEME_PLUGIN } from './plugin-host/loader';
import { setLocale } from './i18n';
import './i18n-test-locales';

function caps(over: {
  all?: true;
  themes?: string[];
  layouts?: string[];
  plugins?: string[];
}): Capabilities {
  return {
    edition: 'expert',
    profile: 'host',
    capabilities: [],
    modules: [],
    ui: { hidden: [], home: '/' },
    kernel: true,
    developer: { unsignedPlugins: false },
    surfaces: over.all
      ? { all: true }
      : {
          pages: [],
          widgets: [],
          nav: [],
          plugins: over.plugins ?? [],
          themes: over.themes ?? [],
          layouts: over.layouts ?? [],
        },
  };
}

const catalog: AppearanceCatalogRow[] = [
  { id: PRODUCT_THEME_PLUGIN, label: null, state: 'active', kind: ['theme'], source: 'bundled' },
  { id: 'plugin-theme', label: 'Nord', state: 'active', kind: ['theme'], source: 'third-party' },
  { id: 'idle-theme', label: 'Idle', state: 'disabled', kind: ['theme'], source: 'third-party' },
  { id: PRODUCT_LAYOUT_PLUGIN, label: null, state: 'active', kind: ['layout'], source: 'bundled' },
  { id: 'blank-layout', label: 'Blank', state: 'active', kind: ['layout'], source: 'third-party' },
  { id: 'hello', label: 'Hello', state: 'active', kind: ['widget'], source: 'third-party' },
];

test('unrestricted viewer lists every active theme and layout, gallery labels', () => {
  setLocale('en');
  const themes = appearanceOptions('theme', caps({ all: true }), catalog);
  assert.deepEqual(themes.map((row) => row.id).sort(), [PRODUCT_THEME_PLUGIN, 'plugin-theme'].sort());
  assert.equal(themes.find((row) => row.id === PRODUCT_THEME_PLUGIN)?.label, 'Theme');
  assert.equal(themes.find((row) => row.id === 'plugin-theme')?.label, 'Nord');
  assert.equal(themes.some((row) => row.id === 'idle-theme' || row.id === 'hello'), false);

  const layouts = appearanceOptions('layout', caps({ all: true }), catalog);
  assert.deepEqual(layouts.map((row) => row.id).sort(), [PRODUCT_LAYOUT_PLUGIN, 'blank-layout'].sort());
  assert.equal(layouts.find((row) => row.id === PRODUCT_LAYOUT_PLUGIN)?.label, 'Layout');
});

test('restricted lists follow surfaces.themes / surfaces.layouts', () => {
  const themes = appearanceOptions('theme', caps({ themes: ['ui-theme'] }), catalog);
  assert.deepEqual(themes.map((row) => row.id), [PRODUCT_THEME_PLUGIN]);

  const layouts = appearanceOptions('layout', caps({ layouts: ['ui-layout'] }), catalog);
  assert.deepEqual(layouts.map((row) => row.id), [PRODUCT_LAYOUT_PLUGIN]);
});

test('a revoked stored theme falls back to the product salmon, screen stays whole', () => {
  const themes = appearanceOptions('theme', caps({ themes: ['ui-theme'] }), catalog);
  assert.equal(themeSelection('plugin-theme', themes), PRODUCT_THEME_PLUGIN);
  assert.equal(themeSelection(PRODUCT_THEME_PLUGIN, themes), PRODUCT_THEME_PLUGIN);

  const empty = appearanceOptions('theme', caps({ themes: [] }), catalog);
  assert.deepEqual(empty, []);
  assert.equal(chromeSelection('plugin-theme', empty, PRODUCT_THEME_PLUGIN), PRODUCT_THEME_PLUGIN);
});

test('a revoked stored layout falls back to the product chrome', () => {
  const layouts = appearanceOptions('layout', caps({ layouts: ['ui-layout'] }), catalog);
  assert.equal(layoutSelection('blank-layout', layouts), PRODUCT_LAYOUT_PLUGIN);
});

test('French gallery labels land on the same ids', () => {
  setLocale('fr');
  try {
    const themes = appearanceOptions('theme', caps({ all: true }), catalog);
    assert.equal(themes.find((row) => row.id === PRODUCT_THEME_PLUGIN)?.label, 'Thème'); // french-ok: the French locale under test
    assert.equal(themes.find((row) => row.id === 'plugin-theme')?.label, 'Nord');
  } finally {
    setLocale('en');
  }
});

test('the topbar toggle writes scheme outside Settings; Appearance writes theme/layout', () => {
  const toggle = readFileSync(new URL('../components/theme-toggle.tsx', import.meta.url), 'utf8');
  assert.match(toggle, /JSON\.stringify\(\{ scheme: next \}\)/);
  assert.match(toggle, /t\('nav\.(dark|light)Theme'\)/);
  const pane = readFileSync(new URL('../plugins-client/ui-theme-appearance.tsx', import.meta.url), 'utf8');
  assert.match(pane, /choose\(\{ theme: id \}\)/);
  assert.match(pane, /choose\(\{ layout: id \}\)/);
  assert.match(pane, /syncClientPlugins/);
  assert.doesNotMatch(pane, /choose\(\{[^}]*scheme/);
});
