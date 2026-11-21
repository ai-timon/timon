/**
 * "Delete pole…" in the right-click menu of the Agents page: offered on a pole
 * itself (a chip of the Workspace bar, a pole without a lead on the graph) to
 * an account that may manage projects, the right the daemon's
 * `DELETE /api/workspaces/:slug` checks. A lead's menu does not offer it: it
 * already ends with deleting the agent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function setup(can: Record<string, boolean>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string | URL | Request) => {
    if (String(input) === '/api/ui/auth/me') return Response.json({ user: { id: 'u1', email: 'a@example.com' }, needsSetup: false, can });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { refreshMe } = await import('@/hooks/use-me');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  // The account is read once per page: read it again with this test's rights.
  await refreshMe();
  const root = createRoot(dom.window.document.getElementById('root')!);
  const mount = async (el: React.ReactElement) => { await React.act(async () => { root.render(el); }); };
  const entry = () => dom.window.document.querySelector<HTMLElement>('[data-menu-delete-pole]');
  const done = async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  };
  return { React, mount, entry, done };
}

const POLE = { slug: 'research', name: 'Research', color: null, lead_agent: null, projects: [] };

function hierarchy(lead?: string) {
  return {
    parentOf: new Map(), leadOfProject: new Map(), workspaceOfProject: new Map(),
    leadOfWorkspace: new Map(lead ? [[POLE.slug, lead]] : []),
    workspaceOfLead: new Map(lead ? [[lead, POLE.slug]] : []),
  };
}

test('a pole\'s menu offers "Delete pole…" with projects:manage, and hands the pole over', async () => {
  const env = await setup({ 'projects:manage': true });
  try {
    const { NodeMenu } = await import('./node-menu');
    const noop = () => {};
    let closed = 0;
    const deleted: string[] = [];
    await env.mount(env.React.createElement(NodeMenu, {
      target: { id: 'workspace:research', x: 10, y: 10 },
      agents: [], poles: [POLE], hierarchy: hierarchy(),
      onClose: () => { closed += 1; }, onReportsTo: noop, onMovePole: noop, onEditPole: noop, onDuplicate: noop,
      onDeletePole: (pole) => { deleted.push(pole.slug); },
    }));
    assert.equal(env.entry()?.textContent, 'Delete pole…');
    await env.React.act(async () => { env.entry()!.click(); });
    assert.deepEqual({ deleted, closed }, { deleted: ['research'], closed: 1 }, 'the menu closes and the pole is handed over');
  } finally {
    await env.done();
  }
});

test('a pole\'s menu withholds "Delete pole…" without projects:manage', async () => {
  const env = await setup({ 'projects:manage': false });
  try {
    const { NodeMenu } = await import('./node-menu');
    const noop = () => {};
    await env.mount(env.React.createElement(NodeMenu, {
      target: { id: 'workspace:research', x: 10, y: 10 },
      agents: [], poles: [POLE], hierarchy: hierarchy(),
      onClose: noop, onReportsTo: noop, onMovePole: noop, onEditPole: noop, onDeletePole: noop, onDuplicate: noop,
    }));
    assert.equal(env.entry(), null);
  } finally {
    await env.done();
  }
});

test('the menu of a pole\'s lead agent does not offer "Delete pole…"', async () => {
  const env = await setup({ 'projects:manage': true, 'agents:manage': true });
  try {
    const { NodeMenu } = await import('./node-menu');
    const noop = () => {};
    await env.mount(env.React.createElement(NodeMenu, {
      target: { id: 'alice', x: 10, y: 10 },
      agents: [{ name: 'alice', project: null }], poles: [{ ...POLE, lead_agent: 'alice' }], hierarchy: hierarchy('alice'),
      onClose: noop, onReportsTo: noop, onMovePole: noop, onEditPole: noop, onDeletePole: noop, onDuplicate: noop,
    }));
    assert.equal(env.entry(), null);
  } finally {
    await env.done();
  }
});
