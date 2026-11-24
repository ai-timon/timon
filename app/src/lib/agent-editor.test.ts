import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from './test-wait';

test('agent editor accepts a new name in its dialog and saves agents without inventing a cwd', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'DocumentFragment'] as const) {
    install(key, dom.window[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentEditorModal, openAgentEditor, closeAgentEditor } = await import('../components/agent-editor/agent-editor-modal');
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const previousLocale = getLocale();
  setLocale('en');
  const posts: Array<{ name: string; config: Record<string, unknown> }> = [];
  let releaseCatalogs!: () => void;
  const catalogsReady = new Promise<void>((resolve) => { releaseCatalogs = resolve; });
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    await catalogsReady;
    if (url === '/api/ui/agents' && init?.method === 'POST') {
      posts.push(JSON.parse(String(init.body)));
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'Zeus' }] });
    if (url === '/api/ui/agents/Zeus') return Response.json({ name: 'Zeus' });
    return Response.json({ agents: [], skills: [], servers: [], roles: [], projects: [], files: [], backends: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  const nameInput = () => document.querySelector<HTMLInputElement>('[role="tabpanel"] input')!;
  // The button reads in the current language: French in the second half.
  const clickSave = (label = 'Save') => React.act(async () => {
    const button = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === label);
    assert.ok(button, `${label} is available`);
    button.click();
  });
  try {
    await React.act(async () => {
      root.render(React.createElement(AgentEditorModal));
      openAgentEditor({ isNew: true });
    });
    // The form is fetched on first open (next/dynamic), then paints at once.
    await waitUntil(React.act, () => document.querySelector('[role="tabpanel"] input') !== null, 'editor form loaded');
    const input = nameInput();
    assert.ok(input, 'creation initializes its draft before catalogs respond');
    assert.equal(input.getAttribute('aria-label'), 'Name');
    assert.match(document.querySelector('[role="tabpanel"]')!.textContent!, /shown in graph \+ console/);
    await React.act(async () => {
      input.focus();
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new.agent');
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    assert.equal(document.activeElement, input, 'dialog permits focus on Name');
    assert.equal(nameInput().value, 'new.agent');
    await React.act(async () => { releaseCatalogs(); });
    assert.equal(nameInput(), input, 'catalog responses do not remount the input');
    assert.equal(nameInput().value, 'new.agent', 'late catalogs preserve the typed name');
    await clickSave();
    assert.equal(posts[0]?.name, 'new.agent', 'Save receives the typed name');
    assert.equal(Object.hasOwn(posts[0]!.config, 'cwd'), false, 'new agent has no invented cwd');
    await React.act(async () => { closeAgentEditor(); });
    setLocale('fr');
    await React.act(async () => { openAgentEditor({ agent: 'Zeus' }); });
    assert.equal(nameInput().value, 'Zeus');
    assert.equal(nameInput().getAttribute('aria-label'), 'Nom');
    assert.match(document.querySelector('[role="tabpanel"]')!.textContent!, /affiché dans le graphe et la console/); // french-ok: the French locale under test
    await clickSave('Enregistrer');
    assert.equal(posts[1]?.name, 'Zeus');
    assert.equal(Object.hasOwn(posts[1]!.config, 'cwd'), false, 'existing agent keeps cwd absent');
  } finally {
    releaseCatalogs();
    await React.act(async () => { closeAgentEditor(); root.unmount(); });
    // Radix restores focus on a timer; keep DOM globals alive until it finishes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
