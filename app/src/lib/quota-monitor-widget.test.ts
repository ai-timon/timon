import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { UI_KIT } from './plugin-host/ui-kit';
import { setLocale } from './i18n';

/**
 * The shipped quota monitor (`examples/plugin-quota-monitor`), loaded as the
 * platform loads it: plain ESM whose `react` and `@timon/ui` imports are the
 * platform's own. What this pins: ONE widget registration, admitted on the top
 * bar's line and placed there by default, taking over the keyless tile's place,
 * and painting the ring flat or the tile in a column.
 */
type Registration = { options: { slot: string; key?: string; widget?: Record<string, unknown> }; Component: (props: Record<string, unknown>) => React.ReactNode };

async function loadClient(): Promise<{ apply: (ctx: unknown) => () => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-quota-monitor', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__quotaTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__quotaTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  Object.assign(globalThis, { React, __quotaTestReact: React, __quotaTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'quota-monitor-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the quota monitor is one widget: ring on the top bar, tile in a rail', async () => {
  setLocale('en');
  const { apply, cleanup } = await loadClient();
  try {
    const registrations: Registration[] = [];
    const ctx = {
      id: 'quota-monitor',
      slots: { register: (options: Registration['options'], Component: Registration['Component']) => { registrations.push({ options, Component }); return () => {}; } },
      api: async () => Response.json({ entries: [] }),
      settings: { set: async () => new Response(null) },
    };
    apply(ctx);

    // No `topbar.item` any more: the ring IS the widget's flat form.
    assert.deepEqual(registrations.map((r) => r.options.slot).sort(), ['cockpit.widget', 'settings.section']);
    const widget = registrations.find((r) => r.options.slot === 'cockpit.widget')!;
    assert.equal(widget.options.key, 'quota');
    assert.deepEqual(
      { zone: widget.options.widget?.zone, bar: widget.options.widget?.bar, placed: widget.options.widget?.placedByDefault, former: widget.options.widget?.formerKeys },
      { zone: 'topbar.widget', bar: true, placed: true, former: [''] },
    );

    const grip = React.createElement('button', { type: 'button' }, 'grip');
    const flat = renderToStaticMarkup(React.createElement(widget.Component, { orientation: 'horizontal', handle: grip }));
    assert.match(flat, /aria-label="Open LLM quotas"/, 'the ring and its menu');
    assert.doesNotMatch(flat, /<section/, 'no tile on the line');
    assert.match(flat, /grip/);

    // A sidebar: the same rings, stacked, without the tile.
    const stacked = renderToStaticMarkup(React.createElement(widget.Component, { orientation: 'vertical', compact: true, handle: grip }));
    assert.match(stacked, /data-quota-rings="vertical"/);
    assert.match(stacked, /aria-label="Open LLM quotas"/);
    assert.doesNotMatch(stacked, /<section/, 'no tile in a sidebar');
    assert.match(stacked, /grip/);

    const tile = renderToStaticMarkup(React.createElement(widget.Component, { orientation: 'vertical', handle: grip }));
    assert.match(tile, /<section/);
    assert.match(tile, /LLM quotas/);
    assert.doesNotMatch(tile, /Open LLM quotas/, 'a wide zone gets the tile, not the rings');
  } finally {
    cleanup();
  }
});

test('the rings open their detail on click, under them on the line and beside them in a sidebar', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  setLocale('en');
  const { apply, cleanup } = await loadClient();
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  let dispose = () => {};
  try {
    const window = (utilization: number) => ({ utilization, resets_at: new Date(Date.now() + 3_600_000).toISOString() });
    const entries = [
      { backend: 'claude', label: 'Claude', brand: 'claude', state: 'available', risk: 40, usage: { windows: { five_hour: window(40) } } },
      { backend: 'codex', label: 'Codex', brand: 'openai', state: 'available', risk: 75, usage: { windows: { five_hour: window(75) } } },
    ];
    const registrations: Registration[] = [];
    dispose = apply({
      id: 'quota-monitor',
      slots: { register: (options: Registration['options'], Component: Registration['Component']) => { registrations.push({ options, Component }); return () => {}; } },
      api: async (path: string) => path === 'all'
        ? Response.json({ entries, thresholds: { warning: 70, critical: 90 }, highestRisk: { utilization: 75 } })
        : Response.json({ points: [] }),
      settings: { set: async () => new Response(null) },
    });
    const widget = registrations.find((r) => r.options.slot === 'cockpit.widget')!;
    const rings = (orientation: string) => document.querySelector(`[data-quota-rings="${orientation}"]`);

    for (const [orientation, side] of [['vertical', 'right'], ['horizontal', 'below']] as const) {
      await React.act(async () => {
        root.render(React.createElement(widget.Component, { orientation, compact: true, handle: null }));
      });
      await waitUntil(React.act, () => (rings(orientation)?.querySelectorAll('[role="img"]').length ?? 0) > 0, `the ${orientation} rings`);
      const shown = rings(orientation)!;
      assert.ok(shown, `${orientation} rings`);
      assert.equal(shown.querySelectorAll('[role="img"]').length, 2, 'one ring per provider');
      assert.equal(shown.className.includes('flex-col'), orientation === 'vertical', 'stacked only in a column');
      assert.ok(!document.querySelector('section'), 'no tile');

      const button = document.querySelector<HTMLButtonElement>('button[aria-label="Open LLM quotas"]')!;
      await React.act(async () => { button.click(); });
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.ok(panel, 'the detail opens on click');
      assert.equal(panel.getAttribute('data-side'), side);
      assert.equal(button.getAttribute('aria-expanded'), 'true');
      assert.match(panel.textContent ?? '', /Claude/);
      assert.match(panel.textContent ?? '', /Codex/);
      await React.act(async () => { button.click(); });
      assert.ok(!document.querySelector('[role="dialog"]'), 'a second click closes it');
    }
  } finally {
    await React.act(async () => { root.unmount(); });
    dispose();
    cleanup();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
