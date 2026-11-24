import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_APPEARANCE, GLASS_TUNING_ENABLED, THEME_VARIANTS, effectiveGlass, ambientShades, appearanceCss, appearancePreviewVars, customPrimaryShades, glassCss, hslTripleToHex, readNativeAppearance, readThemeVariant, themeVariantCss } from '../plugins-client/ui-theme-variants';
import { sharedPresetsScope, workspaceScope } from './workspace-scope';
function luminance(hsl: string): number {
  const [h, s, l] = hsl.match(/[\d.]+/g)!.map(Number) as [number, number, number];
  const light = l / 100, a = s / 100 * Math.min(light, 1 - light);
  const channel = (n: number) => { const k = (n + h / 30) % 12; const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
  return .2126 * channel(0) + .7152 * channel(8) + .0722 * channel(4);
}
function contrast(a: string, b: string) { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0]! + .05) / (values[1]! + .05); }
test('five accents meet text contrast in both modes, including primary buttons', () => {
  assert.equal(new Set(THEME_VARIANTS.map((v) => v.id)).size, 5);
  for (const v of THEME_VARIANTS) {
    assert.ok(contrast(v.dark, '0 0% 8%') >= 4.5, `${v.id}: dark button text`);
    assert.ok(contrast(v.light, '0 0% 100%') >= 4.5, `${v.id}: light button text`);
    assert.ok(contrast(v.dark, '220 9% 16%') >= 4.5, `${v.id}: dark accent text`);
    assert.ok(contrast(v.light, '220 12% 94%') >= 4.5, `${v.id}: light accent text`);
  }
});
test('corrupt variants recover to native default', () => {
  for (const value of [undefined, {}, [], 42, { variant: 'removed' }]) assert.equal(readThemeVariant(value), 'teal');
  assert.equal(readThemeVariant({ variant: 'teal' }), 'teal');
  assert.equal(readThemeVariant({ variant: 'coral' }), 'coral', 'an explicit saved choice is preserved');
});
test('a custom accent keeps its hue and meets the same contrast as the native variants', () => {
  for (const hex of ['#0a1a4a', '#ffee00', '#ff0000', '#00ff88', '#7f7f7f', '#000000', '#ffffff', '#e07a5f']) {
    const { dark, light } = customPrimaryShades(hex);
    assert.ok(contrast(dark, '0 0% 8%') >= 4.5, `${hex}: dark button text`);
    assert.ok(contrast(dark, '220 9% 16%') >= 4.5, `${hex}: dark accent text`);
    assert.ok(contrast(light, '0 0% 100%') >= 4.5, `${hex}: light button text`);
    assert.ok(contrast(light, '220 12% 94%') >= 4.5, `${hex}: light accent text`);
  }
  const { dark } = customPrimaryShades('#e07a5f');
  assert.equal(dark.split(' ')[0], '13', 'hue preserved');
  assert.equal(hslTripleToHex('0 0% 100%'), '#ffffff');
  assert.equal(hslTripleToHex('0 100% 50%'), '#ff0000');
});
test('the appearance row reads old rows unchanged and rejects malformed colours', () => {
  assert.deepEqual(readNativeAppearance({ variant: 'coral' }), { variant: 'coral', primary: null, glass: false, glassBubbles: false, glassScope: 'island', widgetsBorderless: true, widgetsTransparent: false, widgetsStyleAt: 0, glassBlur: 16, glassTransparency: 40, glassTint: null, glassZones: {}, glassFloor: 0, tintDark: null, tintLight: null });
  assert.deepEqual(readNativeAppearance('iris'), { variant: 'iris', primary: null, glass: false, glassBubbles: false, glassScope: 'island', widgetsBorderless: true, widgetsTransparent: false, widgetsStyleAt: 0, glassBlur: 16, glassTransparency: 40, glassTint: null, glassZones: {}, glassFloor: 0, tintDark: null, tintLight: null });
  for (const primary of ['red', '#fff', 'url(x)', '#12345g', 42]) assert.equal(readNativeAppearance({ primary }).primary, null);
  assert.equal(readNativeAppearance({ primary: '#AABBCC', glass: true, glassBubbles: 'yes' }).primary, '#aabbcc');
  assert.equal(readNativeAppearance({ glass: true, glassBubbles: 'yes' }).glassBubbles, false);
  // The glass scope: whole island unless the row says widgets; anything else is the default.
  assert.equal(readNativeAppearance({ glass: true, glassScope: 'widgets' }).glassScope, 'widgets');
  for (const glassScope of [undefined, 'cards', 1, null]) assert.equal(readNativeAppearance({ glassScope }).glassScope, 'island');
  assert.deepEqual(readNativeAppearance({ widgetsBorderless: true, widgetsTransparent: 'yes' }).widgetsBorderless, true);
  assert.equal(readNativeAppearance({ widgetsTransparent: 'yes' }).widgetsTransparent, false, 'only a real true counts');
  assert.equal(themeVariantCss('teal'), themeVariantCss('teal', null), 'no colour, no change');
  assert.ok(themeVariantCss('teal', '#ff0000').includes(customPrimaryShades('#ff0000').dark));
});
test('glass tuning is clamped and painted as custom properties', () => {
  assert.equal(readNativeAppearance({ glassBlur: 99 }).glassBlur, 40);
  assert.equal(readNativeAppearance({ glassBlur: -3, glassTransparency: 'x' }).glassBlur, 0);
  assert.equal(readNativeAppearance({ glassTransparency: 'x' }).glassTransparency, 40);
  assert.equal(readNativeAppearance({ glassTint: 'red' }).glassTint, null);
  assert.equal(readNativeAppearance({ glassTint: '#FF0000' }).glassTint, '#ff0000');
  const css = glassCss({ glassBlur: 8, glassTransparency: 70, glassTint: '#ff0000' });
  for (const zone of ['chrome', 'island', 'widget', 'bubble']) {
    assert.match(css, new RegExp(`--timon-glass-${zone}-blur: 8px`), `${zone} follows the general blur`);
    assert.match(css, new RegExp(`--timon-glass-${zone}-alpha: 0\\.3;`));
    assert.match(css, new RegExp(`--timon-glass-${zone}-tone: 0 100% 50%`));
  }
  assert.doesNotMatch(glassCss(DEFAULT_APPEARANCE), /-tone:/, 'no tint, each plate keeps its surface');
});
test('a zone tunes its own glass and the readability floor holds up the zones that carry text', () => {
  const row = readNativeAppearance({ glassZones: { chrome: { blur: 30, transparency: 90, tint: '#0000FF' }, widgets: { blur: 'x' }, bogus: { blur: 3 } }, glassFloor: 50 });
  assert.deepEqual(Object.keys(row.glassZones).sort(), ['chrome', 'widgets'], 'unknown zones are dropped');
  assert.deepEqual(row.glassZones.widgets, { blur: 16, transparency: 40, tint: null }, 'a malformed field falls back on its default');
  assert.equal(readNativeAppearance({ glassFloor: 200 }).glassFloor, 90);
  const css = glassCss({ ...row, glassTransparency: 80 });
  assert.match(css, /--timon-glass-chrome-blur: 30px/);
  assert.match(css, /--timon-glass-chrome-alpha: 0\.1;/, 'the chrome carries no body text: not floored');
  assert.match(css, /--timon-glass-chrome-tone: 240 100% 50%/);
  assert.match(css, /--timon-glass-island-blur: 16px/, 'islands follow the general blur');
  assert.match(css, /--timon-glass-island-alpha: 0\.5;/, 'floored from 0.2');
  assert.match(css, /--timon-glass-widget-alpha: 0\.6;/, 'its own 40 % transparency, above the floor');
  assert.match(css, /--timon-glass-bubble-alpha: 0\.5;/);
});
test('an ambient tint moves the whole neutral scale and keeps the text readable', () => {
  assert.equal(appearanceCss(DEFAULT_APPEARANCE), themeVariantCss('teal') + '\n' + glassCss(DEFAULT_APPEARANCE), 'no tint, native greys');
  for (const hex of ['#101830', '#000000', '#ffffff', '#ff00ff', '#1a1420']) {
    const dark = ambientShades(hex, 'dark', 24);
    const order = ['--chrome', '--surface-sunken', '--surface-0', '--surface-1', '--surface-2', '--surface-3', '--surface-4'].map((k) => Number(dark[k]!.match(/[\d.]+/g)![2]));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `${hex}: dark levels keep their order`);
    for (const k of ['--surface-0', '--surface-4']) assert.ok(contrast(dark[k]!, '0 0% 92%') >= 7, `${hex}: text on ${k}`);
    assert.ok(contrast(dark['--surface-4']!, dark['--muted-foreground']!) >= 4.5, `${hex}: secondary text, dark`);
  }
  for (const hex of ['#f3ead8', '#ffffff', '#000000', '#c0c0c0', '#00ffff']) {
    const light = ambientShades(hex, 'light', 83);
    for (const k of ['--surface-0', '--surface-4', '--chrome']) assert.ok(contrast(light[k]!, '0 0% 9%') >= 7, `${hex}: text on ${k}`);
    assert.ok(contrast(light['--surface-4']!, light['--muted-foreground']!) >= 4.5, `${hex}: secondary text, light`);
  }
  assert.equal(ambientShades('#101830', 'dark', 24)['--surface-0']!.split(' ')[0], '225', 'hue preserved');
  const css = appearanceCss({ ...DEFAULT_APPEARANCE, tintDark: '#101830', tintLight: '#f3ead8' });
  assert.match(css, /\n:root \{ --surface-0: 225 /);
  assert.match(css, /\n:root\.light \{ --surface-0: 40 /);
});
test('the live preview of a drag paints the values the stylesheet will hold', () => {
  const row = { ...DEFAULT_APPEARANCE, primary: '#ff0000', tintDark: '#101830', tintLight: '#f3ead8', glassBlur: 8, glassTransparency: 70, glassTint: '#00ff00' };
  const css = appearanceCss(row);
  for (const scheme of ['dark', 'light'] as const) {
    const vars = appearancePreviewVars(row, scheme);
    assert.equal(vars['--primary'], customPrimaryShades('#ff0000')[scheme]);
    assert.equal(vars['--surface-0'], ambientShades(scheme === 'dark' ? '#101830' : '#f3ead8', scheme, scheme === 'dark' ? 24 : 83)['--surface-0'], `${scheme}: teal border`);
    for (const [key, value] of Object.entries(vars)) if (key !== '--input') assert.ok(css.includes(`${key}: ${value};`), `${scheme}: ${key} in the stylesheet`);
  }
  assert.equal(appearancePreviewVars(DEFAULT_APPEARANCE, 'dark')['--surface-0'], undefined, 'no tint, nothing inline');
});
test('while glass tuning is hidden, a stored tuning is kept but not painted', { skip: GLASS_TUNING_ENABLED }, () => {
  const row = readNativeAppearance({ glass: true, glassScope: 'both', glassBlur: 2, glassTransparency: 93, glassTint: '#ff0000', glassZones: { chrome: { blur: 0, transparency: 0, tint: null } }, glassFloor: 50 });
  assert.equal(row.glassScope, 'island', 'both reads as the whole island');
  assert.equal(row.glassTransparency, 93, 'the stored value is kept');
  assert.equal(appearanceCss(row), appearanceCss({ ...DEFAULT_APPEARANCE, glass: true }), 'painted as the defaults');
  assert.deepEqual(appearancePreviewVars(row, 'dark'), appearancePreviewVars(DEFAULT_APPEARANCE, 'dark'));
  assert.equal(effectiveGlass(row).glassFloor, 0);
});
test('workspace scopes isolate owner/view/project and fit daemon grammar', async () => {
  const values = await Promise.all([workspaceScope('a', '/chat', 'alpha'), workspaceScope('b', '/chat', 'alpha'), workspaceScope('a', '/', 'alpha'), workspaceScope('a', '/chat', 'beta'), workspaceScope('a', '/chat', null), workspaceScope('a', '/chat', 'é'.repeat(400))]); // french-ok: a non-ASCII scope name, the length cap under test
  assert.equal(new Set(values).size, values.length);
  assert.equal(values[0], await workspaceScope('a', '/chat', 'alpha'));
  for (const value of values) assert.match(`${value}.widgets`, /^[a-z0-9][a-z0-9._-]{0,63}$/);
});
/** The row listing the presets of a view is the longest scope the client
 *  writes: it hangs a suffix of its own off a key that is already 43
 *  characters, and the daemon refuses anything past 64. */
test('the shared presets scope ignores the project and fits daemon grammar', async () => {
  const shared = await sharedPresetsScope('a', '/chat');
  assert.match(shared, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  assert.ok(shared.length <= 64, `${shared.length} characters`);
  // The point of the whole row: two chats whose own keys differ — one under
  // project alpha, one under beta, one under no project at all — list their
  // arrangements from the SAME row.
  const keys = await Promise.all([
    workspaceScope('a', '/chat', 'alpha'),
    workspaceScope('a', '/chat', 'beta'),
    workspaceScope('a', '/chat', null),
  ]);
  assert.equal(new Set(keys).size, 3, 'the views themselves stay partitioned');
  assert.equal(shared, await sharedPresetsScope('a', '/chat'));
  assert.notEqual(shared, await sharedPresetsScope('a', '/'), 'a cockpit keeps its own list');
  assert.notEqual(shared, await sharedPresetsScope('b', '/chat'), 'another account keeps its own');
  // And it is never the row a project-less view writes its own presets into.
  assert.notEqual(shared, `${await workspaceScope('a', '/chat', null)}.presets`);
});

test('widgets are borderless by default, and an explicit false is kept', () => {
  assert.equal(readNativeAppearance(undefined).widgetsBorderless, true);
  assert.equal(readNativeAppearance({ variant: 'teal' }).widgetsBorderless, true);
  assert.equal(readNativeAppearance({ widgetsBorderless: false }).widgetsBorderless, false);
});
