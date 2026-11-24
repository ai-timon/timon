/**
 * The agent editor's Avatar tab (`avatar-tab.tsx`), against a stubbed daemon:
 * it opens on the tab when asked, shows the mode the agent picked or the one
 * its historical order shows, and Save sends the mode with every mode's
 * setting — changing the head never clears the other two. The mascot is the
 * shared configurator: a plugin that takes `agent.lookstyler` paints here too.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { answerConfirmsForTests } from '@/components/confirm-dialog/confirm-dialog-context';
import { waitUntil } from './test-wait';
import type { BackendCatalog } from './backends';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [{ id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }] }],
};

const LOOK = { shape: 'hex', color: '#7ed957', eyes: 'code', acc: 'coffee' };
const AGENTS: Record<string, Record<string, unknown>> = {
  // Everything set, no head picked: the historical order shows the picture.
  Hera: { name: 'Hera', role: 'coder', backend: 'claude', model: 'opus', emoji: '🦊', icon_url: '/api/uploads/hera.png', look: LOOK, avatar: null },
  // Nothing set at all.
  Zeus: { name: 'Zeus', role: 'review', backend: 'claude', model: 'opus' },
  // A head picked by a newer daemon this app does not know.
  Iris: { name: 'Iris', role: 'coder', backend: 'claude', model: 'opus', emoji: '🐙', avatar: 'hologram' },
};

type Post = { name: string; config: Record<string, unknown> };

async function withEditor(run: (h: {
  React: typeof import('react');
  posts: Post[];
  open: (agent: string, tab?: 'avatar') => Promise<void>;
  click: (el: Element | null | undefined) => Promise<void>;
  save: () => Promise<Post>;
  q: (selector: string) => HTMLElement | null;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  // Reduced motion: the preview's mascot stays still, no frame loop to run.
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'SVGElement', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  answerConfirmsForTests(() => true);
  const posts: Post[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/agents' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)) as Post);
      return Response.json({ ok: true });
    }
    if (url.includes('/api/ui/backends/catalog')) return Response.json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return Response.json({ favorites: [] });
    if (url === '/api/ui/agents') return Response.json({ agents: Object.values(AGENTS) });
    const one = /^\/api\/ui\/agents\/([^/]+)$/.exec(url);
    if (one && AGENTS[decodeURIComponent(one[1]!)]) return Response.json(AGENTS[decodeURIComponent(one[1]!)]);
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { invalidateBackendCatalog } = await import('./backends');
  const { getLocale, setLocale } = await import('./i18n');
  const previousLocale = getLocale();
  setLocale('en');
  invalidateBackendCatalog();
  const root = createRoot(document.getElementById('root')!);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const q = (selector: string) => document.querySelector<HTMLElement>(selector);
  try {
    await React.act(async () => { root.render(React.createElement(AgentEditorModal)); });
    await run({
      React,
      posts,
      q,
      click,
      open: async (agent, tab) => {
        await React.act(async () => { closeAgentEditor(); });
        await React.act(async () => { openAgentEditor({ agent, tab }); });
        await waitUntil(React.act, () => q('[data-editor-avatar]') !== null && q('h1')?.textContent === agent, `${agent} loaded`);
      },
      save: async () => {
        const before = posts.length;
        await click(Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === 'Save'));
        await waitUntil(React.act, () => posts.length > before, 'saved');
        return posts[posts.length - 1]!;
      },
    });
  } finally {
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    // Radix restores focus on a timer; keep DOM globals alive until it finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    invalidateBackendCatalog();
    setLocale(previousLocale);
    answerConfirmsForTests(null);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const tabSelected = (q: (s: string) => HTMLElement | null, tab: string) => q(`[role="tab"][data-tab="${tab}"]`)?.getAttribute('aria-selected');
const modeChecked = (q: (s: string) => HTMLElement | null) => q('[data-avatar-mode][aria-checked="true"]')?.getAttribute('data-avatar-mode');

test('the Avatar tab comes before Identity, the editor opens on it when asked, and on Identity otherwise', async () => {
  await withEditor(async ({ open, q }) => {
    await open('Hera');
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((el) => el.textContent);
    assert.deepEqual(tabs.slice(0, 2), ['Avatar', 'Identity']);
    assert.equal(tabSelected(q, 'identity'), 'true');
    await open('Hera', 'avatar');
    assert.equal(tabSelected(q, 'avatar'), 'true');
    assert.equal(modeChecked(q), 'image', 'no head picked: the one the historical order shows, read only');
    assert.match(q('[data-editor-avatar]')?.innerHTML ?? '', /hera\.png/);
  });
});

test('each mode is saved with every setting: changing the head never clears the other two', async () => {
  await withEditor(async ({ open, click, save, q }) => {
    await open('Hera', 'avatar');
    await click(q('[data-avatar-mode="mascot"]'));
    assert.ok(q('[data-editor-avatar] [data-agent-mascot]'), 'the header follows the mode: the mascot over the picture');
    assert.ok(q('[data-look-styler-content]'), 'the shared configurator');
    assert.equal(document.querySelectorAll('[data-look-styler-choices] [data-avatar-mode]').length, 3, 'the mode switch sits with the mascot\'s choices');
    await click(q('button[data-shape="cloud"]'));
    const mascot = await save();
    assert.equal(mascot.config.avatar, 'mascot');
    assert.deepEqual(mascot.config.look, { ...LOOK, shape: 'cloud' });
    assert.equal(mascot.config.emoji, '🦊', 'the emoji is kept');
    assert.equal(mascot.config.icon_url, '/api/uploads/hera.png', 'the picture is kept');

    await open('Hera', 'avatar');
    await click(q('[data-avatar-mode="emoji"]'));
    // By value: jsdom's selector engine does not match an emoji in an attribute selector.
    await click(Array.from(document.querySelectorAll('[data-avatar-emoji]')).find((el) => el.getAttribute('data-avatar-emoji') === '🤖'));
    assert.ok(q('[data-avatar-preview]'), 'the head on its own, beside the switch and the emoji grid');
    assert.match(q('[data-editor-avatar]')?.textContent ?? '', /🤖/, 'the header shows the emoji');
    const emoji = await save();
    assert.equal(emoji.config.avatar, 'emoji');
    assert.equal(emoji.config.emoji, '🤖');
    assert.equal(emoji.config.icon_url, '/api/uploads/hera.png');
    assert.deepEqual(emoji.config.look, LOOK, 'the look is kept');

    await open('Hera', 'avatar');
    await click(q('[data-avatar-mode="image"]'));
    const image = await save();
    assert.equal(image.config.avatar, 'image');
    assert.equal(image.config.icon_url, '/api/uploads/hera.png');
    assert.equal(image.config.emoji, '🦊');
    assert.deepEqual(image.config.look, LOOK);
  });
});

test('a mascot picked without touching the configurator is saved with the role\'s default look; no pick writes no mode', async () => {
  const { defaultLookFor } = await import('@/components/mascot/agent-look');
  await withEditor(async ({ open, click, save, q }) => {
    await open('Zeus', 'avatar');
    assert.equal(modeChecked(q), 'mascot', 'nothing set: the tab opens on the mascot');
    const untouched = await save();
    assert.ok(!('avatar' in untouched.config) && !('look' in untouched.config), 'opening the tab writes nothing');
    await open('Zeus', 'avatar');
    await click(q('[data-avatar-mode="mascot"]'));
    const picked = await save();
    assert.equal(picked.config.avatar, 'mascot');
    assert.deepEqual(picked.config.look, defaultLookFor('review'));

    await open('Zeus', 'avatar');
    await click(q('[data-avatar-mode="image"]'));
    assert.ok(q('[data-avatar-missing]'), 'an image mode without a picture says the face stays as it is');

    await open('Iris', 'avatar');
    assert.equal(modeChecked(q), 'emoji', 'an unknown mode reads as none');
    const unknown = await save();
    assert.ok(!('avatar' in unknown.config), 'and is not written back');
  });
});

test('the Avatar tab\'s mascot is the `agent.lookstyler` slot: a plugin that takes it paints here', async () => {
  const { register, AGENT_LOOK_STYLER_SLOT } = await import('@/lib/plugin-host/slots');
  const { useLookStyler } = await import('@/components/mascot/look-styler/look-styler-context');
  await withEditor(async ({ React, open, click, save, q }) => {
    function Replacement() {
      const v = useLookStyler();
      return React.createElement('button', {
        type: 'button',
        'data-plugin-styler': `${v?.name}/${v?.role}`,
        onClick: () => v?.onChange({ shape: 'bean', color: '#a35bff', eyes: 'heart', acc: 'brush' }),
      });
    }
    const dispose = register({ slot: AGENT_LOOK_STYLER_SLOT, pluginId: 'acme-styler' }, Replacement);
    try {
      await open('Hera', 'avatar');
      await click(q('[data-avatar-mode="mascot"]'));
      assert.equal(q('[data-plugin-styler]')?.getAttribute('data-plugin-styler'), 'Hera/coder');
      assert.ok(!q('[data-look-styler-content]'), 'the product\'s grids stepped aside');
      await click(q('[data-plugin-styler]'));
      const post = await save();
      assert.deepEqual(post.config.look, { shape: 'bean', color: '#a35bff', eyes: 'heart', acc: 'brush' });
    } finally {
      dispose();
    }
  });
});

test('"Change avatar" in the right-click menu opens the editor on the Avatar tab', async () => {
  const { openAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { AgentContextMenu } = await import('../plugins-client/agent-chat/agent-context-menu');
  await withEditor(async ({ React, click, q }) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const { createRoot } = await import('react-dom/client');
    const menuRoot = createRoot(host);
    const noop = () => {};
    // The wiring of the chat card's menu (`agent-chat-card.tsx`).
    await React.act(async () => {
      menuRoot.render(React.createElement(AgentContextMenu, {
        target: { agent: 'Hera', x: 10, y: 10 },
        onCustomize: noop, onEdit: noop, onDuplicate: noop, onRemove: noop, onStop: noop, onMakeMain: noop, onClose: noop,
        onChangeAvatar: () => openAgentEditor({ agent: 'Hera', tab: 'avatar' }),
      }));
    });
    await click(q('[data-menu-change-avatar]'));
    await waitUntil(React.act, () => q('h1')?.textContent === 'Hera', 'editor open');
    assert.equal(tabSelected(q, 'avatar'), 'true');
    assert.ok(q('[data-avatar-tab]'));
    await React.act(async () => { menuRoot.unmount(); });
  });
});
