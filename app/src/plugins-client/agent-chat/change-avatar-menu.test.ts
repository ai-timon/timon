/**
 * "Change avatar" in the right-click menus of an agent: shown only to an
 * account that may edit agents (`agents:manage`), it opens the editor on its
 * Avatar tab. Not to be confused with "Customize", which changes the card
 * only. The opening on the tab itself is covered by `agent-editor-avatar.test.ts`.
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
  const entry = () => dom.window.document.querySelector<HTMLElement>('[data-menu-change-avatar]');
  const done = async () => {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  };
  return { React, mount, entry, done };
}

const HIERARCHY = {
  parentOf: new Map(), leadOfWorkspace: new Map(), workspaceOfLead: new Map(),
  workspaceOfProject: new Map(), leadOfProject: new Map(),
};

test('the chat card\'s menu shows "Change avatar" only when given the gesture, and runs it', async () => {
  const env = await setup({ 'agents:manage': true });
  try {
    const { AgentContextMenu } = await import('./agent-context-menu');
    const noop = () => {};
    const base = { target: { agent: 'alice', x: 10, y: 10 }, onCustomize: noop, onEdit: noop, onDuplicate: noop, onRemove: noop, onStop: noop, onMakeMain: noop };
    let closed = 0;
    let changed = 0;
    await env.mount(env.React.createElement(AgentContextMenu, { ...base, onClose: () => { closed += 1; }, onChangeAvatar: () => { changed += 1; } }));
    assert.equal(env.entry()?.textContent, 'Change avatar');
    await env.React.act(async () => { env.entry()!.click(); });
    assert.deepEqual({ changed, closed }, { changed: 1, closed: 1 }, 'the menu closes and the editor is asked for');
    await env.mount(env.React.createElement(AgentContextMenu, { ...base, onClose: noop }));
    assert.equal(env.entry(), null, 'no gesture, no entry');
  } finally {
    await env.done();
  }
});

for (const [allowed, shown] of [[true, true], [false, false]] as const) {
  test(`the Agents graph's menu ${shown ? 'shows' : 'hides'} "Change avatar" ${allowed ? 'with' : 'without'} agents:manage`, async () => {
    const env = await setup({ 'agents:manage': allowed });
    try {
      const { NodeMenu } = await import('../../app/agents/node-menu');
      const noop = () => {};
      await env.mount(env.React.createElement(NodeMenu, {
        target: { id: 'alice', x: 10, y: 10 },
        agents: [{ name: 'alice', project: null }],
        poles: [],
        hierarchy: HIERARCHY,
        onClose: noop, onReportsTo: noop, onMovePole: noop, onEditPole: noop, onDeletePole: noop, onDuplicate: noop,
      }));
      assert.equal(env.entry() !== null, shown);
    } finally {
      await env.done();
    }
  });
}

for (const [allowed, shown] of [[true, true], [false, false]] as const) {
  test(`the chat card ${shown ? 'offers' : 'withholds'} "Change avatar" ${allowed ? 'with' : 'without'} agents:manage`, async () => {
    const env = await setup({ 'agents:manage': allowed });
    try {
      const { AgentContextMenu, useChangeAvatar } = await import('./agent-context-menu');
      const noop = () => {};
      // Wired exactly as `agent-chat-card.tsx` wires its menu.
      function CardMenu() {
        const changeAvatar = useChangeAvatar();
        return env.React.createElement(AgentContextMenu, {
          target: { agent: 'alice', x: 10, y: 10 },
          onClose: noop, onCustomize: noop, onEdit: noop, onDuplicate: noop, onRemove: noop, onStop: noop, onMakeMain: noop,
          onChangeAvatar: changeAvatar ? () => changeAvatar('alice') : undefined,
        });
      }
      await env.mount(env.React.createElement(CardMenu));
      assert.equal(env.entry() !== null, shown);
    } finally {
      await env.done();
    }
  });
}
