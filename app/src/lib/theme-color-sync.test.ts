/**
 * `<meta name="theme-color">` follows `--primary` across a change of
 * occupant of the `theme` slot.
 *
 * Run against a real DOM (jsdom): the point of T.6 is that a third-party
 * theme rethemes the URL bar, and that only holds if the sync survives the
 * bundled theme being unmounted — which no string assertion can observe.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

const TEAL_DARK = 'hsl(173 51% 58%)';
const CLAIMED = 'hsl(200 80% 50%)';

// Before any DOM exists: the helper must be inert on the server, where the
// layout is rendered first. Kept ahead of the jsdom install below, which is
// process-wide and irreversible.
test('readPrimaryCssColor is inert without a document', async () => {
  const { readPrimaryCssColor, startThemeColorSync } = await import('@/components/theme-color-sync');
  assert.equal(typeof document, 'undefined');
  assert.equal(readPrimaryCssColor(), null);
  assert.doesNotThrow(() => startThemeColorSync()());
});

test('the meta follows --primary when a theme claims the slot and when it leaves', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', {
    url: 'http://localhost/',
    pretendToBeVisual: true,
  });
  installGlobals(dom.window);

  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { declareLayoutSlots } = await import('@/lib/plugin-host/client-plugin-host');
  const { SlotSingle } = await import('@/lib/plugin-host/render');
  const { mountBundledClients } = await import('@/plugins-client/mount');
  const { ThemeColorSync } = await import('@/components/theme-color-sync');

  resetSlotsForTests();
  declareLayoutSlots();
  mountBundledClients(null);

  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);

  await act(async () => {
    root.render(
      React.createElement(ThemeColorSync, null, React.createElement(SlotSingle, { name: 'theme' })),
    );
  });
  assert.equal(themeColor(), TEAL_DARK, 'the bundled theme paints the meta on mount');

  // A theme that only does what the contract asks — paint `--primary`.
  // Nothing about `theme-color`: that stays the host's job.
  const Claimant = () =>
    React.createElement('style', { id: 'fixture-theme' }, ':root { --primary: 200 80% 50%; }');
  let dispose = () => {};
  await act(async () => {
    dispose = register({ slot: 'theme', pluginId: 'fixture-theme' }, Claimant);
  });
  assert.equal(document.getElementById('timon-theme-tokens'), null, 'the bundled theme stepped aside');
  assert.equal(themeColor(), CLAIMED, 'the claimant rethemes the URL bar');

  await act(async () => {
    dispose();
  });
  assert.equal(themeColor(), TEAL_DARK, 'disposing the claimant returns teal');

  // The light palette lives behind `.light` on <html>: the scheme swap is
  // an attribute change, not a style insertion.
  await act(async () => {
    document.documentElement.classList.add('light');
  });
  assert.equal(themeColor(), 'hsl(174 72% 27%)', 'the light palette repaints the meta');

  await act(async () => {
    root.unmount();
  });
  const orphan = document.createElement('style');
  orphan.textContent = ':root { --primary: 0 100% 50%; }';
  document.body.appendChild(orphan);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(themeColor(), 'hsl(174 72% 27%)', 'unmounting disconnects the observers');
});

function themeColor(): string | null {
  return document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null;
}

function installGlobals(window: Window & typeof globalThis): void {
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = window;
  g.document = window.document;
  // `navigator` is a getter-only global on Node — assigning to it throws.
  Object.defineProperty(globalThis, 'navigator', {
    value: window.navigator,
    configurable: true,
  });
  for (const key of [
    'Node',
    'Element',
    'HTMLElement',
    'SVGElement',
    'Event',
    'MutationObserver',
    'getComputedStyle',
    'requestAnimationFrame',
    'cancelAnimationFrame',
    'MessageChannel',
  ]) {
    g[key] = (window as unknown as Record<string, unknown>)[key];
  }
}
