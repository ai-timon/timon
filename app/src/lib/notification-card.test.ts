import assert from 'node:assert/strict';
import test from 'node:test';
import { plainPreview } from './plain-preview';

/**
 * TIM-0025: the Notification center cut a long alert to one title line and a
 * two-line body, with no way to read the rest — and the alert was precisely
 * the diagnostic the tester needed. A long card now carries a Show more
 * toggle, which must not follow the mission link the card sits in.
 */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const LONG = {
  id: 'n1', type: 'alert' as const, urgent: 1,
  title: 'Backend claude: the `claude` CLI was not found on this machine',
  body: 'Timon cannot run `claude` on this machine, so every mission on claude fails as soon as it starts. Install it, then run `claude` once to sign in.',
  task_id: null, mission_id: null as string | null, anchor: null,
  created_at: Date.now(), read_at: null, dismissed_at: null,
};

async function render(n: typeof LONG, run: (root: HTMLElement, react: typeof import('react')) => Promise<void>) {
  await withDom(async (_dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { NotifCard } = await import('@/app/agents/notification-rail');
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    await React.act(async () => { root.render(React.createElement(NotifCard, { n, onDismiss: () => {} })); });
    try { await run(host, React); } finally { await React.act(async () => { root.unmount(); }); }
  });
}

test('a long card is clamped, and its toggle expands it in place', async () => {
  await render(LONG, async (host, React) => {
    const body = Array.from(host.querySelectorAll('p')).find((p) => p.textContent === plainPreview(LONG.body))!;
    assert.ok(body.className.includes('line-clamp-2'));
    assert.equal(body.getAttribute('title'), plainPreview(LONG.body));
    assert.ok(!(body.textContent ?? '').includes('`'), 'inline markdown markers are not shown raw');
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    assert.ok(toggle);
    await React.act(async () => { toggle.click(); });
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
    assert.ok(!body.className.includes('line-clamp-2'));
    assert.ok(body.className.includes('select-text'));
  });
});

test('expanding a card that links to its mission does not navigate', async () => {
  await render({ ...LONG, mission_id: 'm1' }, async (host, React) => {
    assert.ok(host.querySelector('a'));
    const toggle = host.querySelector('button[aria-expanded]') as HTMLButtonElement;
    let followed = false;
    host.addEventListener('click', (e) => { if (!e.defaultPrevented) followed = true; });
    await React.act(async () => { toggle.click(); });
    assert.equal(followed, false);
    assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  });
});

test('a short card has no toggle', async () => {
  await render({ ...LONG, title: 'Merged', body: 'Task done.' }, async (host) => {
    assert.ok(!host.querySelector('button[aria-expanded]'));
  });
});
