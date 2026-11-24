/**
 * Where a mascot is mounted outside the chat it shows what its agent does
 * (docs/AGENT-MASCOT.md, "États vivants hors du chat"), soberly: one source french-ok: the heading of a French internal doc
 * for every avatar, `live={false}` for the bare look, the eyes alone under
 * reduced motion or with "Animate mascots" off, no motion off screen nor
 * while the agent sleeps.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ActiveAgent } from '@/lib/agent-state';

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'none' } as const;

class FakeObserver {
  static instances: FakeObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly cb: IntersectionObserverCallback) { FakeObserver.instances.push(this); }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  takeRecords() { return []; }
  fire(el: Element, visible: boolean) {
    this.cb([{ target: el, isIntersecting: visible } as unknown as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

type Env = Awaited<ReturnType<typeof setup>>;

async function setup(opts: { rows: ActiveAgent[]; reduced?: boolean }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
    'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
    'PointerEvent', 'getComputedStyle', 'SVGElement',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  const matchMedia = () => ({ matches: opts.reduced === true, addEventListener() {}, removeEventListener() {} });
  install('matchMedia', matchMedia);
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMedia, configurable: true });
  // The motion engine's frame never runs here: what is under test is whether it starts.
  install('requestAnimationFrame', () => 1);
  install('cancelAnimationFrame', () => {});
  install('IntersectionObserver', FakeObserver);
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url === '/api/ui/agents/active') return Response.json({ agents: opts.rows, computed_at: 1 });
    if (url.startsWith('/api/ui/layout')) return Response.json(init?.method === 'PUT' ? { ok: true } : { layout: null });
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'u1' }, needsSetup: false, can: {} });
    return Response.json({}, { status: 404 });
  });
  FakeObserver.instances = [];
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); };
  return {
    React,
    dom,
    requests,
    async mount(el: React.ReactElement) { await React.act(async () => { root.render(el); }); await settle(); },
    settle,
    q: <T extends Element>(sel: string) => Array.from(dom.window.document.querySelectorAll<T>(sel)),
    async done() {
      await React.act(async () => { root.unmount(); });
      dom.window.close();
      for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
    },
  };
}

const row = (name: string, state: ActiveAgent['state']): ActiveAgent => ({ name, state, mission_id: `m-${name}`, at: 1, pending_count: 0, project: null });

async function avatars(env: Env, names: string[], extra: Record<string, unknown> = {}) {
  const { AgentAvatar, agentIdentity } = await import('../agent-avatar');
  const { createElement, Fragment } = env.React;
  await env.mount(createElement(Fragment, null, ...names.map((name) =>
    createElement(AgentAvatar, { key: name, identity: agentIdentity({ name, look: LOOK, avatar: 'mascot' }, null), ...extra }))));
}

test('an avatar shows its agent\'s state, alive; thirty share one poll and one observer', async () => {
  const names = Array.from({ length: 30 }, (_, i) => `agent${i}`);
  const env = await setup({ rows: [row('agent0', 'thinking'), row('agent1', 'needs_action')] });
  try {
    await avatars(env, names);
    const live = env.q<HTMLElement>('[data-mascot-state]');
    assert.equal(live.length, 30);
    assert.equal(live[0]!.dataset.mascotState, 'thinking');
    assert.equal(live[1]!.dataset.mascotState, 'waiting');
    assert.equal(live[2]!.dataset.mascotState, 'sleeping');
    const svg = (i: number) => live[i]!.querySelector('svg')!;
    assert.equal(svg(0).getAttribute('data-expr'), 'dots', 'thinking shows its first expression');
    assert.ok(svg(0).hasAttribute('data-live'), 'a working agent moves');
    assert.equal(svg(2).getAttribute('data-expr'), 'sleepy');
    assert.ok(!svg(2).hasAttribute('data-live'), 'a sleeping one keeps its closed eyes, without the engine');

    assert.equal(env.requests.filter((r) => r.url === '/api/ui/agents/active').length, 1, 'one request for thirty avatars');
    assert.equal(FakeObserver.instances.length, 1, 'one observer');
    assert.equal(FakeObserver.instances[0]!.targets.size, 30);

    // Scrolled out of view: it stops moving, its state stays.
    await env.React.act(async () => { FakeObserver.instances[0]!.fire(live[0]!, false); });
    assert.ok(!svg(0).hasAttribute('data-live'));
    assert.equal(svg(0).getAttribute('data-expr'), 'dots');
    await env.React.act(async () => { FakeObserver.instances[0]!.fire(live[0]!, true); });
    assert.ok(svg(0).hasAttribute('data-live'));
  } finally {
    await env.done();
  }
});

test('live={false}: the bare look, still, and nothing watched', async () => {
  const env = await setup({ rows: [row('nova', 'thinking')] });
  try {
    await avatars(env, ['nova'], { live: false });
    assert.equal(env.q('[data-mascot-state]').length, 0, 'no state');
    const svg = env.q<SVGSVGElement>('[data-agent-mascot] svg')[0]!;
    assert.equal(svg.getAttribute('data-expr'), 'code', 'the look\'s own eyes');
    assert.ok(!svg.hasAttribute('data-live'));
    assert.equal(env.requests.filter((r) => r.url === '/api/ui/agents/active').length, 0, 'no subscription, no request');
    assert.equal(FakeObserver.instances[0]?.targets.size ?? 0, 0);
  } finally {
    await env.done();
  }
});

test('reduced motion: the state shows by the eyes alone', async () => {
  const env = await setup({ rows: [row('nova', 'thinking')], reduced: true });
  try {
    await avatars(env, ['nova']);
    const svg = env.q<SVGSVGElement>('[data-mascot-state="thinking"] svg')[0]!;
    assert.equal(svg.getAttribute('data-motion'), 'reduced');
    assert.equal(svg.getAttribute('data-expr'), 'dots');
    assert.ok(!svg.hasAttribute('data-live'));
  } finally {
    await env.done();
  }
});

test('"Animate mascots" off keeps the state still; the switch stores the choice', async () => {
  const env = await setup({ rows: [row('nova', 'thinking')] });
  try {
    const { MascotAnimationSetting } = await import('@/plugins-client/ui-theme-appearance');
    const { AgentAvatar, agentIdentity } = await import('../agent-avatar');
    const { createElement, Fragment } = env.React;
    await env.mount(createElement(Fragment, null,
      createElement(MascotAnimationSetting),
      createElement(AgentAvatar, { identity: agentIdentity({ name: 'nova', look: LOOK, avatar: 'mascot' }, null) })));
    const svg = () => env.q<SVGSVGElement>('[data-mascot-state] svg')[0]!;
    const toggle = env.q<HTMLButtonElement>('[data-mascot-animation-switch]')[0]!;
    assert.equal(toggle.getAttribute('aria-checked'), 'true', 'on by default');
    assert.ok(svg().hasAttribute('data-live'));

    await env.React.act(async () => { toggle.click(); });
    await env.settle();
    assert.equal(toggle.getAttribute('aria-checked'), 'false');
    assert.ok(!svg().hasAttribute('data-live'), 'it stops moving');
    assert.equal(svg().getAttribute('data-expr'), 'dots', 'its state still shows');
    const put = env.requests.filter((r) => r.method === 'PUT');
    assert.deepEqual(put.map((r) => [r.url, r.body]), [['/api/ui/layout?scope=mascot.animation', { layout: { animate: false } }]]);

    await env.React.act(async () => { toggle.click(); });
    await env.settle();
    assert.ok(svg().hasAttribute('data-live'));
  } finally {
    await env.done();
  }
});

test('the stored choice: anything but an explicit false animates; a read never beats a choice', async () => {
  const { createMascotAnimationPref, readMascotAnimation } = await import('./mascot-animation-pref');
  assert.equal(readMascotAnimation(null), true);
  assert.equal(readMascotAnimation({ animate: 'no' }), true);
  assert.equal(readMascotAnimation({ animate: false }), false);

  let release: (r: Response) => void = () => {};
  const pref = createMascotAnimationPref({
    fetchImpl: async (_url, init) => (init?.method === 'PUT'
      ? Response.json({ ok: true })
      : new Promise<Response>((resolve) => { release = resolve; })),
  });
  pref.subscribe(() => {});
  assert.equal(pref.get(), true, 'on until the daemon answers');
  await pref.set(true);
  release(Response.json({ layout: { animate: false } }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(pref.get(), true, 'the late read does not undo the choice made meanwhile');

  const stored = createMascotAnimationPref({ fetchImpl: async () => Response.json({ layout: { animate: false } }) });
  stored.subscribe(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(stored.get(), false);
});

test('a given state wins over the store: a chat shows its own conversation, not the agent\'s other ones (TODO #902)', async () => {
  const env = await setup({ rows: [row('nova', 'needs_action')] });
  try {
    const { LiveAgentMascot } = await import('./live-agent-mascot');
    await env.mount(env.React.createElement(LiveAgentMascot, { name: 'nova', look: LOOK, size: 34, state: 'idle' }));
    const shown = env.q<HTMLElement>('[data-mascot-state]');
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.dataset.mascotState, 'idle', 'the card waits in another conversation of nova');
    assert.equal(env.requests.filter((r) => r.url === '/api/ui/agents/active').length, 0, 'the store is not read at all');
  } finally {
    await env.done();
  }
});
