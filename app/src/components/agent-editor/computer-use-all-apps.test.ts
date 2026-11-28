/**
 * "All applications": a switch row, then, once on, the mode of the unlisted applications and the
 * exclusions, edited in a dialog on a copy and restorable to the defaults from the row's menu.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

async function withDom<T>(run: (ctx: { React: typeof import('react'); root: import('react-dom/client').Root; doc: Document; win: Window }) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'PointerEvent', 'FocusEvent', 'MutationObserver', 'HTMLInputElement', 'HTMLButtonElement', 'CustomEvent', 'DocumentFragment', 'NodeFilter', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (key === 'window') install(key, dom.window);
    else if (value !== undefined) install(key, typeof value === 'function' && /^[a-z]/.test(key) ? (value as (...a: unknown[]) => unknown).bind(dom.window) : value);
  }
  install('self', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (!('ResizeObserver' in globalThis)) install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  try {
    return await run({ React, root, doc: dom.window.document, win: dom.window as unknown as Window });
  } finally {
    await React.act(async () => root.unmount());
    // Radix's focus scope dispatches its unmount event on a timer: it must still find jsdom's globals.
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const [key, desc] of saved) {
      if (desc) Object.defineProperty(globalThis, key, desc); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('off: one row with the switch; on: the unlisted mode and the exclusions, no list painted on the page', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ComputerUseAllApps } = await import('./computer-use-all-apps');
    const { DEFAULT_EXCLUDED_APPS } = await import('@/lib/computer-use');
    const changes: unknown[] = [];
    const render = (enabled: boolean, excluded: string[] = [...DEFAULT_EXCLUDED_APPS], mode: 'foreground' | 'background' = 'foreground') => React.act(async () => {
      root.render(React.createElement(ComputerUseAllApps, {
        enabled, mode, excluded,
        onEnabledChange: (next) => changes.push(['enabled', next]),
        onModeChange: (next) => changes.push(['mode', next]),
        onExcludedChange: (next) => changes.push(['excluded', next]),
      }));
    });
    await render(false);
    assert.equal(doc.querySelector('[data-computer-use-all-apps]')?.getAttribute('data-computer-use-all-apps'), 'off');
    assert.ok(!doc.querySelector('[data-computer-use-unlisted-mode]'));
    assert.ok(!doc.querySelector('[data-computer-use-excluded]'));
    await React.act(async () => { (doc.querySelector('[data-computer-use-all-apps-switch]') as HTMLElement).click(); });
    assert.deepEqual(changes.at(-1), ['enabled', true]);

    await render(true, [...DEFAULT_EXCLUDED_APPS], 'background');
    assert.equal(doc.querySelector('[data-computer-use-unlisted-mode]')?.getAttribute('data-computer-use-unlisted-mode'), 'background');
    assert.equal(doc.querySelector('[data-computer-use-excluded]')?.getAttribute('data-computer-use-excluded'), 'default');
    assert.ok(!doc.querySelector('[data-computer-use-excluded-app]'), 'the list is not painted on the page');
    assert.match(doc.body.textContent ?? '', new RegExp(String(DEFAULT_EXCLUDED_APPS.length)));
    await React.act(async () => { (doc.querySelector('[data-computer-use-unlisted-option="foreground"]') as HTMLElement).click(); });
    assert.deepEqual(changes.at(-1), ['mode', 'foreground']);

    await render(true, ['Slack']);
    assert.equal(doc.querySelector('[data-computer-use-excluded]')?.getAttribute('data-computer-use-excluded'), 'edited');
  });
});

test('the dialog edits a copy: add and remove change nothing until Save', async () => {
  await withDom(async ({ React, root, doc }) => {
    const { ExcludedAppsDialog } = await import('./computer-use-all-apps');
    let saved: string[] | null = null;
    let cancelled = 0;
    await React.act(async () => {
      root.render(React.createElement(ExcludedAppsDialog, { initial: ['KeePassXC', 'Terminal'], onCancel: () => { cancelled++; }, onSave: (next) => { saved = next; } }));
    });
    const apps = () => Array.from(doc.querySelectorAll('[data-computer-use-excluded-app]')).map((li) => li.getAttribute('data-computer-use-excluded-app'));
    assert.deepEqual(apps(), ['KeePassXC', 'Terminal']);
    const input = doc.querySelector('[data-computer-use-excluded-input]') as HTMLInputElement;
    const type = async (value: string) => {
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!;
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      });
      await React.act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    };
    await type('Slack');
    await type('terminal');
    assert.deepEqual(apps(), ['Slack', 'KeePassXC', 'Terminal'], 'a repeat (case apart) is not added');
    await React.act(async () => { (doc.querySelector('[data-computer-use-excluded-app="KeePassXC"] button') as HTMLElement).click(); });
    assert.equal(saved, null);
    await React.act(async () => { (doc.querySelector('[data-computer-use-excluded-save]') as HTMLElement).click(); });
    assert.deepEqual(saved, ['Slack', 'Terminal']);
    assert.equal(cancelled, 0);
  });
});
