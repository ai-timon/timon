/**
 * T.4 — the client loader mounts one theme and one layout.
 *
 * Two active `kind: theme` halves must not both `apply`: the second would
 * throw `Single slot already taken`. Same for `layout`. Widgets stay as they
 * were. MULTI-THEME.md §5 / T.4.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  DEFAULT_CHROME_PREFS,
  PRODUCT_LAYOUT_PLUGIN,
  PRODUCT_THEME_PLUGIN,
  resetClientPluginsForTests,
  selectClientPlugins,
  setLoadClientModuleForTests,
  syncClientPlugins,
  type ChromePrefs,
  type PublicPlugin,
} from './plugin-host/loader';
import { resetCapabilitiesCacheForTests } from './capabilities';

function plugin(over: {
  id: string;
  kind?: readonly string[];
  state?: string;
  client?: PublicPlugin['client'] | null;
}): PublicPlugin {
  return {
    id: over.id,
    state: over.state ?? 'active',
    kind: over.kind,
    client: over.client === undefined
      ? { url: `/plugins/${over.id}/client.js`, rev: '1', slots: [] }
      : over.client,
  };
}

const nord = plugin({ id: 'nord', kind: ['theme'] });
const otherTheme = plugin({ id: 'other-theme', kind: ['theme'] });
const productTheme = plugin({ id: PRODUCT_THEME_PLUGIN, kind: ['theme'] });
const productLayout = plugin({ id: PRODUCT_LAYOUT_PLUGIN, kind: ['layout'] });
const blankLayout = plugin({ id: 'blank-layout', kind: ['layout'] });
const hello = plugin({ id: 'hello', kind: ['widget'] });
const overlay = plugin({ id: 'mascot', kind: ['overlay'] });
const page = plugin({ id: 'example-page', kind: ['page'] });

test('two active themes: only prefs.theme and the product fallback are selected', () => {
  const prefs: ChromePrefs = { theme: 'nord', layout: PRODUCT_LAYOUT_PLUGIN };
  const wanted = selectClientPlugins([productTheme, nord, otherTheme, hello], prefs);
  assert.deepEqual(wanted.map((p) => p.id).sort(), [PRODUCT_THEME_PLUGIN, 'hello', 'nord'].sort());
});

test('two active layouts: an installed blank-layout is ignored until chosen', () => {
  const idle = selectClientPlugins([productLayout, blankLayout, hello], DEFAULT_CHROME_PREFS);
  assert.deepEqual(idle.map((p) => p.id).sort(), [PRODUCT_LAYOUT_PLUGIN, 'hello'].sort());

  // A third-party layout also needs the White Label right (`white-label-root.test.ts`).
  const chosen = selectClientPlugins(
    [productLayout, blankLayout, hello],
    { theme: PRODUCT_THEME_PLUGIN, layout: 'blank-layout' },
    true,
  );
  assert.deepEqual(chosen.map((p) => p.id).sort(), [PRODUCT_LAYOUT_PLUGIN, 'blank-layout', 'hello'].sort());
});

test('an invalid chosen theme is silent: the product fallback stays', () => {
  const wanted = selectClientPlugins(
    [productTheme, otherTheme, hello],
    { theme: 'missing-theme', layout: PRODUCT_LAYOUT_PLUGIN },
  );
  assert.deepEqual(wanted.map((p) => p.id).sort(), [PRODUCT_THEME_PLUGIN, 'hello'].sort());
});

test('a chosen plugin of the wrong kind is not mounted as chrome', () => {
  const wanted = selectClientPlugins(
    [productTheme, hello, productLayout],
    { theme: 'hello', layout: 'hello' },
  );
  assert.deepEqual(wanted.map((p) => p.id).sort(), [PRODUCT_THEME_PLUGIN, PRODUCT_LAYOUT_PLUGIN, 'hello'].sort());
});

test('widgets, pages and overlays stay on every active half', () => {
  const wanted = selectClientPlugins(
    [hello, overlay, page, otherTheme],
    DEFAULT_CHROME_PREFS,
  );
  assert.deepEqual(wanted.map((p) => p.id).sort(), ['example-page', 'hello', 'mascot'].sort());
});

test('a disabled fallback is not mounted; an empty slot is already handled', () => {
  const off = plugin({ id: PRODUCT_THEME_PLUGIN, kind: ['theme'], state: 'disabled' });
  const wanted = selectClientPlugins([off, otherTheme], DEFAULT_CHROME_PREFS);
  assert.deepEqual(wanted.map((p) => p.id), []);
});

test('a plugin without a client half is never imported', () => {
  const bundled = plugin({ id: PRODUCT_THEME_PLUGIN, kind: ['theme'], client: null });
  const wanted = selectClientPlugins([bundled, nord], { theme: 'nord', layout: PRODUCT_LAYOUT_PLUGIN });
  assert.deepEqual(wanted.map((p) => p.id), ['nord']);
});

async function withLoader(opts: {
  plugins: PublicPlugin[];
  prefs?: ChromePrefs | null;
  /** `capabilities.whitelabel`: absent, the daemon answers no capabilities. */
  whitelabel?: boolean;
  run: (applied: string[]) => Promise<void> | void;
}): Promise<void> {
  const applied: string[] = [];
  const originalFetch = globalThis.fetch;
  setLoadClientModuleForTests(async (url) => {
    const id = decodeURIComponent(new URL(url, 'http://timon.invalid').pathname.split('/').pop() ?? '');
    return {
      apply() {
        applied.push(id);
      },
    };
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/ui/plugins')) {
      return new Response(JSON.stringify({ plugins: opts.plugins }));
    }
    if (url.includes('/api/ui/capabilities') && opts.whitelabel !== undefined) {
      return new Response(JSON.stringify({ whitelabel: opts.whitelabel }));
    }
    if (url.includes('/api/ui/auth/me')) {
      if (opts.prefs === null) return new Response('gone', { status: 404 });
      return new Response(JSON.stringify({
        prefs: opts.prefs ?? { ...DEFAULT_CHROME_PREFS, scheme: 'dark' },
      }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  resetClientPluginsForTests();
  resetCapabilitiesCacheForTests();
  try {
    await syncClientPlugins();
    await opts.run(applied);
  } finally {
    globalThis.fetch = originalFetch;
    setLoadClientModuleForTests(null);
    resetClientPluginsForTests();
  }
}

test('syncClientPlugins applies prefs.theme and the product fallback, not the other theme', async () => {
  await withLoader({
    plugins: [productTheme, nord, otherTheme, hello],
    prefs: { theme: 'nord', layout: PRODUCT_LAYOUT_PLUGIN },
    run(applied) {
      assert.deepEqual(applied.sort(), [PRODUCT_THEME_PLUGIN, 'hello', 'nord'].sort());
    },
  });
});

test('syncClientPlugins applies prefs.layout and the product fallback, not a spare layout', async () => {
  await withLoader({
    plugins: [productLayout, blankLayout, overlay],
    prefs: { theme: PRODUCT_THEME_PLUGIN, layout: 'blank-layout' },
    whitelabel: true,
    run(applied) {
      assert.deepEqual(applied.sort(), [PRODUCT_LAYOUT_PLUGIN, 'blank-layout', 'mascot'].sort());
    },
  });
});

test('syncClientPlugins does not apply blank-layout when it is only installed', async () => {
  await withLoader({
    plugins: [productLayout, blankLayout, hello],
    prefs: DEFAULT_CHROME_PREFS,
    run(applied) {
      assert.equal(applied.includes('blank-layout'), false);
      assert.equal(applied.includes(PRODUCT_LAYOUT_PLUGIN), true);
      assert.equal(applied.includes('hello'), true);
    },
  });
});

test('missing prefs fall back to the product chrome', async () => {
  await withLoader({
    plugins: [productTheme, otherTheme, productLayout, blankLayout],
    prefs: null,
    run(applied) {
      assert.deepEqual(applied.sort(), [PRODUCT_LAYOUT_PLUGIN, PRODUCT_THEME_PLUGIN].sort());
    },
  });
});

test('changing prefs disposes the previous chosen theme', async () => {
  const originalFetch = globalThis.fetch;
  const applied: string[] = [];
  const disposed: string[] = [];
  let prefs: ChromePrefs = { theme: 'nord', layout: PRODUCT_LAYOUT_PLUGIN };
  setLoadClientModuleForTests(async (url) => {
    const id = decodeURIComponent(new URL(url, 'http://timon.invalid').pathname.split('/').pop() ?? '');
    return {
      apply() {
        applied.push(id);
        return () => { disposed.push(id); };
      },
    };
  });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/api/ui/plugins')) {
      return new Response(JSON.stringify({ plugins: [productTheme, nord, otherTheme] }));
    }
    if (url.includes('/api/ui/auth/me')) {
      return new Response(JSON.stringify({ prefs: { ...prefs, scheme: 'dark' } }));
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
  resetClientPluginsForTests();
  try {
    await syncClientPlugins();
    assert.deepEqual(applied.sort(), [PRODUCT_THEME_PLUGIN, 'nord'].sort());
    applied.length = 0;
    prefs = { theme: 'other-theme', layout: PRODUCT_LAYOUT_PLUGIN };
    await syncClientPlugins();
    assert.deepEqual(disposed, ['nord']);
    assert.deepEqual(applied, ['other-theme']);
  } finally {
    globalThis.fetch = originalFetch;
    setLoadClientModuleForTests(null);
    resetClientPluginsForTests();
  }
});

test('SlotRoot registers the product layout as the default occupant', () => {
  const src = readFileSync(new URL('./plugin-host/slot-root.tsx', import.meta.url), 'utf8');
  assert.match(src, /useEffect\(\(\) => registerProductLayout\(caps\)/);
  assert.match(src, /isLayoutSurfaceAllowed/);
  assert.match(src, /fallback:\s*true/);
});

test('concurrent plugin syncs apply a keyed view only once', async () => {
  const originalFetch = globalThis.fetch;
  let applications = 0;
  resetClientPluginsForTests();
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).includes('/plugins')
    ? { plugins: [plugin({ id: 'company', kind: ['page'] })] }
    : { prefs: DEFAULT_CHROME_PREFS }))) as typeof fetch;
  setLoadClientModuleForTests(async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    return { apply() { applications += 1; } };
  });
  try {
    await Promise.all([syncClientPlugins(), syncClientPlugins(), syncClientPlugins()]);
    assert.equal(applications, 1);
  } finally { resetClientPluginsForTests(); setLoadClientModuleForTests(null); globalThis.fetch = originalFetch; }
});

test('a disposed host cannot be repopulated by a late plugin import', async () => {
  const originalFetch = globalThis.fetch;
  let release!: () => void;
  let imported!: () => void;
  const started = new Promise<void>(resolve => { imported = resolve; });
  const pending = new Promise<void>(resolve => { release = resolve; });
  let applications = 0;
  resetClientPluginsForTests();
  globalThis.fetch = (async input => new Response(JSON.stringify(String(input).includes('/plugins')
    ? { plugins: [plugin({ id: 'company', kind: ['page'] })] }
    : { prefs: DEFAULT_CHROME_PREFS }))) as typeof fetch;
  setLoadClientModuleForTests(async () => { imported(); await pending; return { apply() { applications += 1; } }; });
  try {
    const sync = syncClientPlugins();
    await started;
    resetClientPluginsForTests();
    release();
    await sync;
    assert.equal(applications, 0);
  } finally { release(); resetClientPluginsForTests(); setLoadClientModuleForTests(null); globalThis.fetch = originalFetch; }
});
