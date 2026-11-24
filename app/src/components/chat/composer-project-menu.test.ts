/**
 * The project pill above the composer and its menu: "Project settings…" opens
 * the project's window on the conversation's project; greyed with the reason
 * for an account without `projects:manage`; and no pill at all for a
 * conversation outside any project.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Who = 'reader' | 'manager';

async function mount(who: Who, project: string | null = 'acme') {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement',
    'HTMLTextAreaElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'SVGElement', 'Event',
    'CustomEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const urls: string[] = [];
  let projectName = 'Acme';
  install('fetch', async (input: string) => {
    const url = String(input);
    urls.push(url);
    if (url === '/api/ui/auth/me') {
      return Response.json({ user: { id: 'u1', email: 'a@b.c' }, can: { 'projects:manage': who === 'manager' }, prefs: {} });
    }
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'acme', name: projectName, cwd: '/srv/acme' }] });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe().catch(() => undefined);
  const { ComposerProjectMenu } = await import('./composer-project-menu');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(ComposerProjectMenu, { project })); });
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const openMenu = async () => {
    const trigger = dom.window.document.querySelector('[data-composer-project="acme"]');
    assert.ok(trigger, 'the project pill');
    await React.act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await settle();
  };
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  const rename = async (name: string) => {
    projectName = name;
    const { announceProjectsChanged } = await import('@/hooks/use-project-meta');
    await React.act(async () => { announceProjectsChanged(); });
    await settle();
  };
  return { document: dom.window.document, urls, openMenu, click, rename, unmount };
}

test('the project pill opens a menu whose "Project settings…" opens the project\'s window', async () => {
  const view = await mount('manager');
  try {
    await view.openMenu();
    const item = view.document.querySelector('[data-composer-project-settings]');
    assert.ok(item, 'the entry');
    assert.equal(item.textContent, 'Project settings…');
    assert.equal(item.getAttribute('aria-disabled'), null);
    assert.ok(!view.document.querySelector('[data-composer-project-reason]'));
    await view.click(item);
    const title = Array.from(view.document.querySelectorAll('[role="dialog"] h2'), (h) => h.textContent);
    assert.ok(title.some((text) => text?.includes('acme')), `the project's window on acme (${title.join(' | ')})`);
  } finally {
    await view.unmount();
  }
});

test('without projects:manage the entry stays, greyed, with the reason under the pointer', async () => {
  const view = await mount('reader');
  try {
    await view.openMenu();
    const item = view.document.querySelector('[data-composer-project-settings]');
    assert.ok(item, 'the entry is still listed');
    assert.equal(item.getAttribute('aria-disabled'), 'true');
    const wrapper = view.document.querySelector('[data-composer-project-reason]');
    assert.ok(wrapper?.getAttribute('title'), 'the reason on the wrapper');
    const describedBy = item.getAttribute('aria-describedby');
    assert.ok(describedBy);
    assert.equal(view.document.getElementById(describedBy)?.textContent, wrapper?.getAttribute('title'));
    await view.click(item);
    assert.ok(!view.document.querySelector('[role="dialog"]'), 'nothing opens');
  } finally {
    await view.unmount();
  }
});

test('a conversation without a project paints no pill, so no entry', async () => {
  const view = await mount('manager', null);
  try {
    assert.ok(!view.document.querySelector('[data-composer-project]'));
    assert.ok(!view.document.querySelector('[data-composer-project-settings]'));
  } finally {
    await view.unmount();
  }
});

test('the pill shows the project\'s name, and follows a rename made in its window', async () => {
  const view = await mount('manager');
  try {
    assert.equal(view.document.querySelector('[data-composer-project="acme"]')?.textContent, 'Acme');
    await view.rename('Acme Widgets');
    assert.equal(view.document.querySelector('[data-composer-project="acme"]')?.textContent, 'Acme Widgets');
  } finally {
    await view.unmount();
  }
});
