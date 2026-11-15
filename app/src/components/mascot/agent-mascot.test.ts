/**
 * The agent's mascot (`agent.mascot`): every skull wears every accessory,
 * every expression morphs on the same point count, the default looks follow
 * the onboarding's tables, a live mascot stays still under
 * `prefers-reduced-motion`, and a plugin that takes the slot replaces it.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';
import { ACC, EYES, FURS, SHAPES, accFor, defaultLookFor, isAgentLook, normalizeAgentLook, DEFAULT_LOOK } from './agent-look';
import { EXPRESSIONS, EYE_POINTS, exprPoints, furOf, headLayout } from './mascot-geometry';
import { accessoryAnchor, accessoryPlace } from './mascot-accessories';
import { MASCOT_STATES, STATES, stateExpression } from './mascot-states';

// The test runner compiles JSX to `React.createElement`; the app's build does not need this.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

test('every skull renders with every accessory, spilling or fitted, without a NaN', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentMascot } = await import('./agent-mascot');
  let count = 0;
  for (const shape of SHAPES) {
    for (const acc of ACC) {
      for (const fit of [false, true]) {
        const html = renderToStaticMarkup(React.createElement(AgentMascot, { shape, acc, fit, color: '#ff5fbf', size: 64 }));
        assert.match(html, /^<svg[^>]*class="timon-mascot"/, `${shape}/${acc}`);
        assert.ok(!html.includes('NaN') && !html.includes('undefined'), `${shape}/${acc}/${fit}: no broken number`);
        assert.equal(html.includes(`data-mascot-acc="${acc}"`), acc !== 'none', `${shape}/${acc}: the tool is drawn`);
        assert.equal(html.includes('data-mascot-cap'), acc === 'teacher', 'the mortarboard comes with the book');
        count += 1;
      }
    }
  }
  assert.equal(count, 7 * 31 * 2);
  assert.equal(ACC.length - 1, 30, 'thirty tools and none');
});

test('a fitted tool stays inside the box, on every skull', () => {
  for (const shape of SHAPES) {
    const L = headLayout(shape);
    for (const acc of ACC) {
      if (acc === 'none') continue;
      const at = accessoryPlace(acc, L, true);
      const reach = 16 * at.s;
      assert.ok(at.x - reach >= -0.01 && at.x + reach <= 100.01 && at.y - reach >= -0.01 && at.y + reach <= 100.01, `${shape}/${acc}: inside the box`);
    }
  }
  // Each tool hangs where the 3D character carries it.
  assert.equal(accessoryAnchor('crown'), 'hat');
  assert.equal(accessoryAnchor('loupe'), 'eye');
  assert.equal(accessoryAnchor('pen'), 'ear');
  assert.equal(accessoryAnchor('globe'), 'ground');
  assert.equal(accessoryAnchor('hammer'), 'hand');
  assert.equal(accessoryAnchor('acme-pack:cap'), 'hand', 'a tool from a pack is held');
  const L = headLayout('squircle');
  assert.ok(accessoryPlace('crown', L, false).y < L.top, 'a hat sits on the top of the skull');
  assert.ok(accessoryPlace('hammer', L, false).x > 50 + L.belly, 'a held tool is beside the body');
});

test('the fur is the colour of the look exactly, presets and picked colours alike', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentMascot } = await import('./agent-mascot');
  for (const color of [...FURS, '#123456']) {
    assert.equal(furOf(color), color);
    const html = renderToStaticMarkup(React.createElement(AgentMascot, { color, size: 48 }));
    assert.ok(html.includes(`stop-color="${color}"`), `${color}: painted as is`);
  }
  assert.equal(furOf('#ABCDEF'), '#abcdef');
  assert.equal(furOf('not-a-colour'), DEFAULT_LOOK.color);
});

test('a part drawn alone: the screen with its eyes, or the tool centred, never the fur', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentMascot } = await import('./agent-mascot');
  for (const shape of SHAPES) {
    const L = headLayout(shape);
    const screen = renderToStaticMarkup(React.createElement(AgentMascot, { shape, eyes: 'heart', acc: 'wrench', size: 48, part: 'screen' }));
    assert.match(screen, new RegExp(`viewBox="${L.visor.x - 2} ${L.visor.y - 2} ${L.visor.w + 4} ${L.visor.h + 4}"`), `${shape}: framed on the screen`);
    assert.ok(screen.includes('timon-mascot-eyes'), 'the eyes are drawn');
    assert.ok(!screen.includes(L.body), `${shape}: no fur`);
    assert.ok(!screen.includes('data-mascot-acc'), 'no tool');
    assert.ok(!screen.includes('NaN'));
  }
  for (const acc of ACC.filter((a) => a !== 'none')) {
    const html = renderToStaticMarkup(React.createElement(AgentMascot, { acc, size: 48, part: 'acc' }));
    assert.ok(html.includes(`data-mascot-acc="${acc}"`) && html.includes('translate(50 50)'), `${acc}: the tool, centred`);
    assert.ok(!html.includes('timon-mascot-eyes') && !html.includes(headLayout(DEFAULT_LOOK.shape).body), `${acc}: neither eyes nor fur`);
    assert.ok(!html.includes('data-mascot-cap'), 'the cell shows the tool, not the mortarboard');
  }
});

test('two mascots on one page never share a filter id', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { AgentMascot } = await import('./agent-mascot');
  const html = renderToStaticMarkup(React.createElement('div', null, React.createElement(AgentMascot), React.createElement(AgentMascot)));
  const ids = [...html.matchAll(/<filter id="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(ids.length, 6);
  assert.equal(new Set(ids).size, 6);
  assert.ok(ids.every((id) => /^[a-zA-Z0-9]+$/.test(id ?? '')), 'ids usable in url(#…)');
});

test('every expression is three outlines of the same point count, so any morphs into any', () => {
  const geo = headLayout('squircle').geo;
  for (const name of EXPRESSIONS) {
    const p = exprPoints(name, geo);
    for (const slot of [p.L, p.R, p.M]) {
      assert.equal(slot.length, EYE_POINTS, name);
      assert.ok(slot.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)), name);
    }
  }
  for (const eyes of EYES) assert.ok(EXPRESSIONS.includes(eyes), `${eyes} is an expression`);
});

test('every state draws its expressions from known glyphs; base stands for the look', () => {
  for (const state of MASCOT_STATES) {
    for (const e of STATES[state].pool) assert.ok(e === 'base' || EXPRESSIONS.includes(e), `${state}: ${e}`);
  }
  assert.equal(stateExpression('idle', 'code'), 'code', 'idle keeps the look\'s eyes');
  assert.equal(stateExpression('thinking', 'code'), 'dots');
});

test('defaultLookFor reads the onboarding tables, by role and by missions', () => {
  assert.deepEqual(defaultLookFor('code'), { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' });
  assert.deepEqual(defaultLookFor('research'), { ...DEFAULT_LOOK, eyes: 'big', acc: 'loupe' });
  assert.deepEqual(defaultLookFor('review'), { ...DEFAULT_LOOK, eyes: 'squint', acc: 'pen' });
  assert.deepEqual(defaultLookFor('orchestrator'), { ...DEFAULT_LOOK, acc: 'baton' });
  assert.deepEqual(defaultLookFor('chore'), { ...DEFAULT_LOOK, acc: 'hammer' });
  assert.deepEqual(defaultLookFor('coder'), defaultLookFor('code'), 'an agent\'s config.role name works too');
  assert.deepEqual(defaultLookFor('reviewer'), defaultLookFor('review'));
  assert.deepEqual(defaultLookFor('ops'), defaultLookFor('chore'));
  assert.deepEqual(defaultLookFor('nobody'), DEFAULT_LOOK);

  assert.deepEqual(defaultLookFor(['mail', 'agenda']), { shape: 'squircle', color: '#ff5fbf', eyes: 'pill', acc: 'clipboard' });
  assert.deepEqual(defaultLookFor(['code']), { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'coffee' });
  assert.deepEqual(defaultLookFor(['watch', 'research']), { shape: 'hex', color: '#ffc233', eyes: 'pill', acc: 'telescope' });
  assert.deepEqual(defaultLookFor(['write']), { shape: 'cloud', color: '#ff8a2a', eyes: 'pill', acc: 'quill' });
  assert.deepEqual(defaultLookFor(['research']), { shape: 'gem', color: '#a35bff', eyes: 'pill', acc: 'loupe' });
  assert.deepEqual(defaultLookFor(['agenda']), { shape: 'round', color: '#3fa9ff', eyes: 'pill', acc: 'calendar' });
  assert.deepEqual(defaultLookFor([]), { shape: 'squircle', color: '#a35bff', eyes: 'pill', acc: 'none' });
  assert.deepEqual(defaultLookFor(['bogus', 'mail']), defaultLookFor(['mail']), 'an unknown mission is skipped');
  assert.equal(accFor(['agenda', 'mail']), 'clipboard');
  for (const look of [defaultLookFor('code'), defaultLookFor(['mail']), defaultLookFor([])]) assert.ok(isAgentLook(look));
});

test('a look read from elsewhere keeps its valid fields and falls back field by field', () => {
  assert.deepEqual(normalizeAgentLook({ shape: 'hex', color: '#FFC233', eyes: 'laser', acc: 'coffee' }), { shape: 'hex', color: '#ffc233', eyes: 'pill', acc: 'coffee' });
  assert.equal(normalizeAgentLook({ color: '#ABCDEF' }).color, '#abcdef', 'a fur off the lists from the colour picker is kept, lower case');
  assert.equal(normalizeAgentLook({ color: '#abcdeg' }).color, DEFAULT_LOOK.color, 'a colour the daemon would not store falls back');
  assert.deepEqual(normalizeAgentLook(null), DEFAULT_LOOK);
  assert.deepEqual(normalizeAgentLook({ color: 'red' }, defaultLookFor('code')), defaultLookFor('code'));
  assert.equal(isAgentLook({ shape: 'hex', color: '#abc', eyes: 'pill', acc: 'none' }), false, 'three-digit colours are refused');
});

test('the lists are the ones the daemon stores (orchestrator/src/agent-look.ts)', async () => {
  const { LOOK_COLORS } = await import('./agent-look');
  const daemon = await import('../../../../orchestrator/src/agent-look');
  assert.deepEqual([...SHAPES], [...daemon.AGENT_LOOK_SHAPES]);
  assert.deepEqual([...LOOK_COLORS], [...daemon.AGENT_LOOK_COLORS]);
  assert.deepEqual([...EYES], [...daemon.AGENT_LOOK_EYES]);
  assert.deepEqual([...ACC], [...daemon.AGENT_LOOK_ACCESSORIES]);
  // Every default look an agent gets must be storable as is.
  for (const input of [...['code', 'review', 'research', 'orchestrator', 'chore', 'nobody'], ...[[], ['mail', 'agenda'], ['watch'], ['write'], ['research'], ['agenda']]]) {
    const look = defaultLookFor(input);
    assert.deepEqual(daemon.parseAgentLook(look), look, JSON.stringify(input));
  }
});

test('every list entry has an English and a French label', async () => {
  const { hasKey, setLocale, t } = await import('@/lib/i18n');
  const { LOOK_COLORS, accessoryLabelKey, eyesLabelKey, furLabelKey, shapeLabelKey } = await import('./agent-look');
  const { stateLabelKey } = await import('./mascot-states');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const fr = JSON.parse(readFileSync(join(process.cwd(), 'src', 'locales', 'fr', 'mascot.json'), 'utf8')) as Record<string, unknown>;
  const inFr = (key: string) => key.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), fr);
  const keys = [
    ...SHAPES.map(shapeLabelKey), ...EYES.map(eyesLabelKey), ...ACC.map(accessoryLabelKey),
    ...LOOK_COLORS.map(furLabelKey), furLabelKey('#123456'), ...MASCOT_STATES.map(stateLabelKey),
  ];
  setLocale('en');
  for (const key of keys) {
    assert.ok(hasKey(key), `en: ${key}`);
    assert.equal(typeof inFr(key), 'string', `fr: ${key}`);
  }
  assert.equal(t(furLabelKey('#123456')), 'Custom');
  assert.equal(t(accessoryLabelKey('teacher')), 'Book and cap');
});

type Dom = {
  act: (fn: () => void | Promise<void>) => Promise<void>;
  render: (el: unknown) => Promise<void>;
  document: Document;
  frames: () => number;
  setReduced: (on: boolean) => void;
};

async function mount(ctx: TestContext, reduced: boolean): Promise<Dom> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MutationObserver', 'getComputedStyle']) {
    install(key, Reflect.get(dom.window, key));
  }
  install('window', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  let matches = reduced;
  const listeners = new Set<() => void>();
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      get matches() { return query.includes('reduced-motion') && matches; },
      media: query,
      addEventListener: (_: string, fn: () => void) => { listeners.add(fn); },
      removeEventListener: (_: string, fn: () => void) => { listeners.delete(fn); },
    }),
  });
  // Frames are counted, never run: the test reads what the engine asked for.
  let frames = 0;
  install('requestAnimationFrame', () => { frames += 1; return frames; });
  install('cancelAnimationFrame', () => {});

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return {
    act,
    render: (el) => act(() => { root.render(el as React.ReactElement); }),
    document: dom.window.document,
    frames: () => frames,
    setReduced: (on) => { matches = on; for (const fn of listeners) fn(); },
  };
}

test('under prefers-reduced-motion a live mascot stays still: no frame, no body move, the state\'s first face', async (t) => {
  const { AgentMascot } = await import('./agent-mascot');
  const { liveMascotCount } = await import('./mascot-motion');
  const w = await mount(t, true);
  await w.render(React.createElement(AgentMascot, { live: true, state: 'done' }));
  const svg = w.document.querySelector('svg[data-mascot]')!;
  assert.equal(svg.getAttribute('data-motion'), 'reduced');
  assert.equal(svg.hasAttribute('data-live'), false, 'no live engine, so the CSS blink is off too (media query)');
  assert.equal(svg.getAttribute('data-expr'), 'happy', 'the state still shows, as one still face');
  assert.equal(w.frames(), 0);
  assert.equal(liveMascotCount(), 0);
  assert.ok(!/timon-mascot-(jump|hop|wiggle)/.test(svg.getAttribute('class') ?? ''), 'no body move');

  // The user turns the setting off: the same mascot wakes up.
  await w.act(() => { w.setReduced(false); });
  assert.equal(svg.getAttribute('data-motion'), 'full');
  assert.ok(svg.hasAttribute('data-live'));
  assert.equal(liveMascotCount(), 1);
  assert.ok(w.frames() > 0, 'the shared frame runs');
  await w.render(React.createElement(AgentMascot, { live: true, state: 'error' }));
  assert.match(svg.getAttribute('class') ?? '', /timon-mascot-wiggle/, 'an error state wiggles in');

  // And back on: the engine stops, nothing it wrote is left behind.
  await w.act(() => { w.setReduced(true); });
  assert.equal(liveMascotCount(), 0);
  assert.ok(!/timon-mascot-(jump|hop|wiggle)/.test(svg.getAttribute('class') ?? ''));
  assert.equal(svg.querySelector('.timon-mascot-eyes')?.hasAttribute('transform'), false);
});

test('the host paints the product while the slot is empty, a plugin\'s mascot once it takes it, and the product again after', async (t) => {
  const { register, resetSlotsForTests, AGENT_MASCOT_SLOT, slotEntries } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost, ProductAgentMascot } = await import('./agent-mascot');
  const { useAgentMascot } = await import('./agent-mascot-context');
  resetSlotsForTests();
  assert.equal(slotEntries(AGENT_MASCOT_SLOT).length, 0, 'a boot slot, empty');
  const w = await mount(t, true);
  const host = React.createElement(AgentMascotHost, { look: { shape: 'gem', color: '#ff5fbf', eyes: 'bogus' as never, acc: 'globe' }, size: 40, live: true, state: 'thinking', label: 'Nova' });
  await w.render(host);
  const product = () => w.document.querySelector('svg[data-mascot]');
  assert.equal(product()?.getAttribute('data-shape'), 'gem');
  assert.equal(product()?.getAttribute('aria-label'), 'Nova');

  const disposeFallback = register({ slot: AGENT_MASCOT_SLOT, pluginId: '@timon/agents', fallback: true }, ProductAgentMascot);
  await w.act(() => {});
  assert.equal(product()?.getAttribute('data-acc'), 'globe', 'the default occupant paints the same mascot');

  const seen: unknown[] = [];
  function Replacement() {
    const m = useAgentMascot();
    seen.push(m);
    return React.createElement('i', { 'data-replacement': m?.look.eyes });
  }
  const dispose = register({ slot: AGENT_MASCOT_SLOT, pluginId: 'acme-mascot' }, Replacement);
  await w.act(() => {});
  assert.ok(!product(), 'the product steps aside');
  assert.equal(w.document.querySelector('[data-replacement]')?.getAttribute('data-replacement'), 'pill', 'an invalid field reaches the plugin normalised');
  const last = seen[seen.length - 1] as { size: number; live: boolean; state: string; reducedMotion: boolean; label: string };
  assert.deepEqual({ size: last.size, live: last.live, state: last.state, reducedMotion: last.reducedMotion, label: last.label },
    { size: 40, live: false, state: 'thinking', reducedMotion: true, label: 'Nova' }, 'live is already folded with the user\'s setting');
  // A part alone is the product's drawing only: a replacement keeps its whole head.
  await w.render(React.createElement(AgentMascotHost, { look: { eyes: 'heart' }, size: 40, part: 'screen' }));
  assert.ok(!product(), 'the part is not forced on a plugin\'s mascot');
  assert.ok(w.document.querySelector('[data-replacement]'), 'the replacement paints instead');
  await w.act(() => { dispose(); });
  assert.equal(product()?.getAttribute('data-mascot-part'), 'screen', 'the product draws the part alone');
  await w.render(host);
  assert.equal(product()?.getAttribute('data-shape'), 'gem', 'the product comes back');
  disposeFallback();
});

test('the examples/plugin-mascot template paints every mascot with the SDK alone', async (t) => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-mascot', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__mascotTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__mascotTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __mascotTestReact: React, __mascotTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'mascot-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  const { AgentMascotHost } = await import('./agent-mascot');
  const w = await mount(t, false);
  const dispose = mod.apply({ slots: { register: (options: { slot: string }, Component: React.ComponentType) => register({ ...options, pluginId: 'example-mascot' }, Component) } });
  await w.render(React.createElement(AgentMascotHost, { look: defaultLookFor('code'), size: 48, state: 'sleeping' }));
  const pixel = w.document.querySelector('[data-pixel-mascot]');
  assert.equal(pixel?.getAttribute('data-pixel-mascot'), 'sleeping');
  assert.equal(pixel?.getAttribute('width'), '48');
  assert.ok(!w.document.querySelector('svg[data-mascot]'));
  await w.act(() => { dispose(); });
  assert.ok(w.document.querySelector('svg[data-mascot]'), 'the meerkat comes back');
});
