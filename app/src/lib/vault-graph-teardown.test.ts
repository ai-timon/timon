import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * mountVaultGraph() used to have no teardown at all: unmounting the disc killed the
 * renderer and left every animation frame, observer and window/document listener it had
 * created running for the lifetime of the tab. Those loops kept calling refresh() on the
 * dead renderer -- "could not find a suitable program for node type circle" -- and kept
 * spending frames, so the app slowed down with every visit to the page.
 *
 * The pre-init path is asserted here rather than a full run: init lives inside a 20ms
 * timeout, so a fast unmount is the case that was a complete no-op, and it needs no WebGL.
 */
async function harness() {
  const { JSDOM } = await import('jsdom');
  const { VAULT_GRAPH_MARKUP } = await import('@/vendor/vault-graph/markup');
  const { mountVaultGraph } = await import('@/vendor/vault-graph/page.js');
  const graphology = await import('@/vendor/vault-graph/graphology.umd.min.js');

  const dom = new JSDOM(`<!doctype html><body>${VAULT_GRAPH_MARKUP}</body></html>`);
  const root = dom.window.document.body.firstElementChild as HTMLElement;
  // page.js reads the theme off the root through the BARE global, not through deps.win --
  // one of the reasons the teardown is an explicit list rather than a proxy over that window.
  (globalThis as { getComputedStyle?: unknown }).getComputedStyle =
    dom.window.getComputedStyle.bind(dom.window);

  const frames = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { fn: () => void; ms: number }>();
  const listeners: string[] = [];
  const observing = new Set<object>();
  let next = 1;
  let sigmaBuilt = 0;

  class FakeResizeObserver {
    observe() { observing.add(this); }
    disconnect() { observing.delete(this); }
  }
  const win = {
    requestAnimationFrame: (fn: FrameRequestCallback) => { const id = next++; frames.set(id, fn); return id; },
    cancelAnimationFrame: (id: number) => { frames.delete(id); },
    setTimeout: (fn: () => void, ms?: number) => { const id = next++; timers.set(id, { fn, ms: ms ?? 0 }); return id; },
    clearTimeout: (id: number) => { timers.delete(id); },
    ResizeObserver: FakeResizeObserver,
    addEventListener: (type: string) => { listeners.push(`win:${type}`); },
    removeEventListener: (type: string) => {
      const i = listeners.indexOf(`win:${type}`);
      if (i >= 0) listeners.splice(i, 1);
    },
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    devicePixelRatio: 1,
  } as unknown as Window;

  const doc = {
    visibilityState: 'visible',
    hidden: false,
    addEventListener: (type: string) => { listeners.push(`doc:${type}`); },
    removeEventListener: (type: string) => {
      const i = listeners.indexOf(`doc:${type}`);
      if (i >= 0) listeners.splice(i, 1);
    },
  } as unknown as Document;

  class Sigma {
    constructor() { sigmaBuilt += 1; }
  }
  const ns = graphology.default as { Graph?: unknown };
  const Graph = (ns && 'Graph' in ns && ns.Graph) ? ns.Graph : ns;

  const handle = mountVaultGraph(root, {
    vault: 'test', generated: '', nodes: [], edges: [],
    stats: { files: 0, nodes: 0, edges: 0, unresolved: 0, orphans: 0,
             dates: { frontmatter: 0, filename: 0, stamp: 0, none: 0 },
             templatesExcluded: false, ghostsIncluded: false },
  }, { Graph, Sigma, rendering: {}, win, doc });

  /** Run every timer and frame currently queued, as a later tick of the event loop would. */
  const flush = () => {
    for (const [id, t] of [...timers]) { timers.delete(id); t.fn(); }
    for (const [id, fn] of [...frames]) { frames.delete(id); fn(0); }
  };
  return { handle, flush, frames, timers, listeners, observing, sigma: () => sigmaBuilt };
}

test('destroy() before the deferred init builds nothing at all', async () => {
  const h = await harness();
  h.handle.destroy();
  h.flush();
  assert.equal(h.sigma(), 0, 'no renderer inside a container the host already threw away');
  assert.equal(h.handle.ready, false);
  assert.equal(h.handle.api, null);
});

test('destroy() releases every frame, timer, observer and listener', async () => {
  const h = await harness();
  // Not vacuous: the mount does register these before the assertions below clear them.
  assert.ok(h.listeners.includes('doc:visibilitychange'), 'the mount hooks the document');
  assert.ok(h.timers.size > 0, 'the mount schedules its deferred init');
  h.handle.destroy();
  assert.equal(h.frames.size, 0, 'no animation frame left outstanding');
  assert.equal(h.timers.size, 0, 'no timer left outstanding');
  // Proves nothing before init -- the ResizeObservers are created with the renderer, so
  // never here. Kept as a guard for the day this test covers a full mount.
  assert.equal(h.observing.size, 0, 'every ResizeObserver disconnected');
  assert.deepEqual(h.listeners, [], 'every window/document listener removed');
});

test('destroy() is idempotent', async () => {
  const h = await harness();
  h.handle.destroy();
  assert.doesNotThrow(() => h.handle.destroy());
});
