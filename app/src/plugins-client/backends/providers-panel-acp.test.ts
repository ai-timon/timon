import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';

/**
 * The ACP registry rows of the real `ProvidersPanel`: an unverified install is offered the verified build
 * (never installed by itself), and an installed agent's sign-in methods are asked for on a click only, with
 * the methods billed per token marked and never recommended. The daemon's refusal of anyone but a superadmin
 * signed in to the app is covered by `acp-registry-routes.test.ts`.
 */
test('the registry offers the verified build and lists sign-in methods with billed ones marked', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const registry = {
    registryVersion: '1', dropped: 0, stale: false,
    agents: [{
      id: 'antigravity-acp', name: 'Google Antigravity', version: '1.5.0', description: null, website: null, license: null,
      supported: true, reason: null, integrity: 'sha256',
      installed: { version: '1.4.1', integrity: 'unverified', updateAvailable: true, verifiedUpdate: true, state: 'ok', profileId: 'acp-antigravity-acp' },
    }],
  };
  const methods = [
    { id: 'gemini-api-key', name: 'Gemini API key', description: null, kind: 'agent', billedPerToken: true, recommended: false, command: null },
    { id: 'oauth-personal', name: 'Log in with Google', description: null, kind: 'agent', billedPerToken: false, recommended: true, command: null },
  ];
  const posts: { url: string; body: unknown }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'POST') {
      posts.push({ url, body: JSON.parse(String(init.body)) });
      if (url.endsWith('/auth-methods')) return Response.json({ methods });
      return Response.json({ agent: registry.agents[0] });
    }
    if (url === '/api/ui/providers/list') return Response.json({ providers: [] });
    if (url.startsWith('/api/ui/providers/acp-registry')) return Response.json(registry);
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { ProvidersPanel } = await import('./providers-panel');

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const button = (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes(label));
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await React.act(async () => {
      root.render(React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('') as never }, React.createElement(ProvidersPanel)));
    });
    await until(() => button('Browse the registry') !== undefined, 'the panel to render');
    await click(button('Browse the registry')!);
    await until(() => button('Install verified version') !== undefined, 'the verified build to be offered');
    const text = document.body.textContent ?? '';
    assert.match(text, /Unverified/);
    assert.match(text, /1\.4\.1 was installed without a published hash/);
    assert.equal(button('Update'), undefined, 'the verified build is the offer, not a plain update');
    assert.equal(posts.length, 0, 'nothing is installed nor started by itself');

    await click(button('Sign-in methods')!);
    await until(() => document.body.textContent?.includes('Billed per token') === true, 'the methods to show');
    assert.deepEqual(posts.map((p) => p.url), ['/api/ui/providers/acp-registry/antigravity-acp/auth-methods']);
    const items = Array.from(document.querySelectorAll('li li')).map((li) => li.textContent ?? '');
    assert.match(items[0] ?? '', /Log in with Google.*Recommended/, 'the subscription method comes first, suggested');
    assert.match(items[1] ?? '', /Gemini API key.*Billed per token/);
    assert.doesNotMatch(items[1] ?? '', /Recommended/);
    assert.match(document.body.textContent ?? '', /never chosen for you/);

    await click(button('Install verified version')!);
    await until(() => posts.length === 2, 'the install to be sent');
    assert.deepEqual(posts[1], { url: '/api/ui/providers/acp-registry/install', body: { agentId: 'antigravity-acp' } }, 'a verified build needs no acknowledgement');
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
