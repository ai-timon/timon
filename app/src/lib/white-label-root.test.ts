/**
 * The browser's barrier of the White Label lock: a plugin half replaces the
 * whole interface (slot `root`) only if it is a layout and the daemon says the
 * licence includes White Label (`capabilities.whitelabel`). Without it the
 * product's `AppFrame` keeps `root`, and the person's `prefs.layout` is kept
 * untouched for the day the right comes back.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import {
  DEFAULT_CHROME_PREFS,
  PRODUCT_LAYOUT_PLUGIN,
  clientContext,
  isClientPluginWanted,
  resetClientPluginsForTests,
  rootAllowed,
  setLoadClientModuleForTests,
  syncClientPlugins,
  type ChromePrefs,
  type PublicPlugin,
} from './plugin-host/loader';
import { resetSlotsForTests, slotEntries } from './plugin-host/slots';
import { registerProductLayout } from './plugin-host/slot-root';
import { resetCapabilitiesCacheForTests } from './capabilities';

const Empty = () => React.createElement('div');
const CHOSEN: ChromePrefs = { theme: DEFAULT_CHROME_PREFS.theme, layout: 'blank-layout' };

const half = (id: string, kind: string[], slots: string[], state = 'active'): PublicPlugin => ({
  id, state, kind, client: { url: `/plugins/${id}/client.js`, rev: '1', slots },
});
const blankLayout = (state = 'active') => half('blank-layout', ['layout'], ['root'], state);

test('a chosen third-party layout is wanted only with the right', () => {
  assert.equal(isClientPluginWanted(blankLayout(), CHOSEN), false, 'no right by default');
  assert.equal(isClientPluginWanted(blankLayout(), CHOSEN, false), false);
  assert.equal(isClientPluginWanted(blankLayout(), CHOSEN, true), true);
  assert.equal(isClientPluginWanted(blankLayout(), DEFAULT_CHROME_PREFS, true), false, 'the right does not choose it');
});

test('a half naming `root` without being a layout is never wanted, right or not', () => {
  const sneaky = half('sneaky', ['behavior'], ['root']);
  assert.equal(isClientPluginWanted(sneaky, DEFAULT_CHROME_PREFS), false);
  assert.equal(isClientPluginWanted(sneaky, { ...DEFAULT_CHROME_PREFS, layout: 'sneaky' }, true), false);
  assert.equal(rootAllowed(sneaky, true), false);
});

test('only the product layout needs no right; themes, pages and widgets are untouched', () => {
  assert.equal(rootAllowed(half(PRODUCT_LAYOUT_PLUGIN, ['layout'], ['root']), false), true);
  for (const plugin of [half('page', ['page'], ['page', 'nav.item']), half('w', ['widget'], ['cockpit.widget']), half('o', ['overlay'], ['overlay'])]) {
    assert.equal(isClientPluginWanted(plugin, DEFAULT_CHROME_PREFS), true, plugin.id);
  }
  assert.equal(isClientPluginWanted(half('nord', ['theme'], ['theme']), { ...DEFAULT_CHROME_PREFS, theme: 'nord' }), true);
});

test('register refuses `root` to a context that may not occupy it', () => {
  resetSlotsForTests();
  const denied = clientContext('blank-layout', ['root']);
  assert.throws(() => denied.slots.register({ slot: 'root' }, Empty), /not allowed in slot root: .*White Label/);
  const granted = clientContext('blank-layout', ['root'], undefined, [], true);
  const dispose = granted.slots.register({ slot: 'root' }, Empty);
  assert.equal(slotEntries('root')[0]?.pluginId, 'blank-layout');
  dispose();
  denied.dispose(); granted.dispose();
});

// The daemon sets `builtin` for any package in a built-in location, even one
// the release manifest does not vouch for: it must not stand in for the right.
test('a layout flagged `builtin` still needs the right', () => {
  const dropped: PublicPlugin = { ...blankLayout(), builtin: true };
  assert.equal(rootAllowed(dropped, false), false);
  assert.equal(isClientPluginWanted(dropped, CHOSEN), false, 'whitelabel absent reads as false');
  assert.equal(isClientPluginWanted(dropped, CHOSEN, false), false);
  assert.equal(isClientPluginWanted(dropped, CHOSEN, true), true);
  resetSlotsForTests();
  const context = clientContext(dropped.id, ['root'], undefined, [], rootAllowed(dropped, false));
  assert.throws(() => context.slots.register({ slot: 'root' }, Empty), /not allowed in slot root: .*White Label/);
  assert.equal(slotEntries('root').length, 0);
  context.dispose();
});

type DaemonState = {
  plugins: PublicPlugin[];
  whitelabel: boolean | undefined;
  /** `false`: the capabilities route fails, as when they cannot be loaded. */
  capabilities?: boolean;
};

/** One sync pass against a fake daemon whose answers the test changes. */
function fakeDaemon(state: DaemonState) {
  const writes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
    if (url.includes('/api/ui/plugins')) return new Response(JSON.stringify({ plugins: state.plugins }));
    if (url.includes('/api/ui/auth/me')) return new Response(JSON.stringify({ prefs: { ...CHOSEN, scheme: 'dark' } }));
    if (url.includes('/api/ui/capabilities')) {
      if (state.capabilities === false) return new Response('unavailable', { status: 503 });
      const caps: Record<string, unknown> = { edition: 'expert', profile: 'x', capabilities: [], modules: [], ui: { hidden: [], home: '/' }, kernel: true, developer: { unsignedPlugins: false } };
      if (state.whitelabel !== undefined) caps.whitelabel = state.whitelabel;
      return new Response(JSON.stringify(caps));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  // The layout's browser half claims `root`, as `plugin-blank-layout` does.
  setLoadClientModuleForTests(async () => ({
    apply(context: ReturnType<typeof clientContext>) { context.slots.register({ slot: 'root' }, Empty); },
  }) as never);
  return { writes, restore: () => { globalThis.fetch = original; setLoadClientModuleForTests(null); } };
}

async function rootAfterSync(state: DaemonState): Promise<{ root: string | undefined; writes: string[] }> {
  resetSlotsForTests();
  resetClientPluginsForTests();
  resetCapabilitiesCacheForTests();
  registerProductLayout(null);
  const daemon = fakeDaemon(state);
  try {
    await syncClientPlugins();
    return { root: slotEntries('root')[0]?.pluginId, writes: daemon.writes };
  } finally {
    daemon.restore();
    resetClientPluginsForTests();
  }
}

test('without the right, `AppFrame` keeps `root` even when the layout is chosen', async () => {
  for (const whitelabel of [false, undefined]) {
    const { root, writes } = await rootAfterSync({ plugins: [blankLayout()], whitelabel });
    assert.equal(root, PRODUCT_LAYOUT_PLUGIN, `whitelabel: ${String(whitelabel)}`);
    assert.deepEqual(writes, [], 'prefs.layout is never rewritten');
  }
});

test('with the right, the chosen layout takes `root`', async () => {
  const { root } = await rootAfterSync({ plugins: [blankLayout()], whitelabel: true });
  assert.equal(root, 'blank-layout');
});

test('losing the right falls back to `AppFrame` without a reload, and the choice survives', async () => {
  resetSlotsForTests();
  resetClientPluginsForTests();
  resetCapabilitiesCacheForTests();
  registerProductLayout(null);
  const state: DaemonState = { plugins: [blankLayout()], whitelabel: true };
  const daemon = fakeDaemon(state);
  try {
    await syncClientPlugins();
    assert.equal(slotEntries('root')[0]?.pluginId, 'blank-layout');
    // What `plugins_changed` brings after the licence lost the right: the
    // daemon skipped the layout (`skipped:unlicensed`) and says so.
    state.plugins = [blankLayout('skipped')];
    state.whitelabel = false;
    await syncClientPlugins();
    assert.equal(slotEntries('root')[0]?.pluginId, PRODUCT_LAYOUT_PLUGIN);
    // The right comes back: same prefs, the layout resumes on its own.
    state.plugins = [blankLayout()];
    state.whitelabel = true;
    await syncClientPlugins();
    assert.equal(slotEntries('root')[0]?.pluginId, 'blank-layout');
    assert.deepEqual(daemon.writes, [], 'prefs.layout is never rewritten');
  } finally {
    daemon.restore();
    resetClientPluginsForTests();
  }
});

test('a daemon that still lists the layout active is overruled when it denies the right', async () => {
  const { root } = await rootAfterSync({ plugins: [blankLayout()], whitelabel: false });
  assert.equal(root, PRODUCT_LAYOUT_PLUGIN);
  const sneaky = await rootAfterSync({ plugins: [half('sneaky', ['behavior'], ['root'])], whitelabel: true });
  assert.equal(sneaky.root, PRODUCT_LAYOUT_PLUGIN);
});

test('a layout listed `active` and `builtin` by the daemon does not take `root` without the right', async () => {
  const dropped: PublicPlugin = { ...blankLayout(), builtin: true };
  for (const state of [
    { whitelabel: false },
    { whitelabel: undefined },
    { whitelabel: undefined, capabilities: false },
  ] as const) {
    const { root, writes } = await rootAfterSync({ plugins: [dropped], ...state });
    assert.equal(root, PRODUCT_LAYOUT_PLUGIN, JSON.stringify(state));
    assert.deepEqual(writes, []);
  }
});

test('the product layout keeps `root` when the capabilities are missing or say nothing', async () => {
  const product = half(PRODUCT_LAYOUT_PLUGIN, ['layout', 'widget'], ['root', 'cockpit.widget']);
  for (const state of [{ whitelabel: undefined }, { whitelabel: undefined, capabilities: false }] as const) {
    const { root } = await rootAfterSync({ plugins: [product], ...state });
    assert.equal(root, PRODUCT_LAYOUT_PLUGIN, JSON.stringify(state));
  }
});
