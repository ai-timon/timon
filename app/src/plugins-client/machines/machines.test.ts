/**
 * The Machines plugin on screen: Settings → Machines pairs, renames, removes
 * and says under which account this computer acts; the switcher names the
 * machine driven and switches through the app only.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

type Call = { method: string; url: string; body: unknown };

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  router: { pushed: string[]; onPush: (listener: (path: string) => void) => void };
  render: (element: import('react').ReactElement) => Promise<void>;
}) => Promise<void>, machine = 'local'): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<html data-timon-machine="${machine}"><body><div id="root"></div></body></html>`, { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Event', 'CustomEvent', 'NodeFilter', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLButtonElement', 'HTMLIFrameElement', 'DocumentFragment', 'ShadowRoot', 'FocusEvent', 'sessionStorage', 'localStorage']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const pushed: string[] = [];
  const pushListeners: Array<(path: string) => void> = [];
  const router = {
    back() {}, forward() {}, refresh() {}, prefetch() {},
    push(path: string) { pushed.push(path); for (const listener of pushListeners) listener(path); },
    replace(path: string) { pushed.push(path); },
  };
  const root = createRoot(document.getElementById('root')!);
  const render = async (element: import('react').ReactElement) => {
    await React.act(async () => { root.render(React.createElement(AppRouterContext.Provider, { value: router }, element)); });
  };
  const store = await import('./fleet-store');
  store.resetFleetStore();
  try {
    await run({ React, root, router: { pushed, onPush: (listener) => { pushListeners.push(listener); } }, render });
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function machineRow(id: string, over: Record<string, unknown> = {}) {
  return {
    id, name: id.toUpperCase(), url: `https://${id}.example.net`, status: 'online', version: '0.1.6', api_level: 1,
    last_checked_at: 1_700_000_000_000, last_ok_at: 1_700_000_000_000, created_at: 1, updated_at: 1,
    remote_user: { email: 'alice@example.net', name: 'Alice', is_superadmin: true }, ...over,
  };
}

/** The local daemon's fleet, as `/api/ui/machines*` relays it. */
function installFetch(calls: Call[], answer: (url: string, method: string, body: unknown) => Response | undefined = () => undefined): void {
  let fleet = [machineRow('vps')];
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    writable: true,
    value: async (input: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
      calls.push({ method, url: input, body });
      const custom = answer(input, method, body);
      if (custom) return custom;
      if (input === '/api/ui/machines' && method === 'GET') return json(200, { machines: fleet });
      if (input === '/api/ui/machines/pair') {
        const added = machineRow('nas', { name: (body as { name?: string }).name ?? 'nas.example.net' });
        fleet = [...fleet, added];
        return json(201, { machine: added, created: true });
      }
      if (input === '/api/ui/machines/vps' && method === 'PATCH') {
        fleet = [machineRow('vps', { name: (body as { name: string }).name })];
        return json(200, { machine: fleet[0] });
      }
      if (input === '/api/ui/machines/vps' && method === 'DELETE') {
        fleet = [];
        return json(200, { removed: true, remote_revoked: true });
      }
      if (input === '/api/ui/machines/active') return json(403, { error: 'cross_origin' });
      return json(404, { error: 'not found' });
    },
  });
}

function button(label: string | RegExp): HTMLButtonElement {
  const found = Array.from(document.querySelectorAll('button')).find((b) => (typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? '')));
  assert.ok(found, `button ${String(label)}`);
  return found;
}

function type(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function settle(React: typeof import('react'), ms = 10): Promise<void> {
  await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });
}

test('the fleet lists each machine with its state, version and the account this computer acts as', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      const text = document.body.textContent ?? '';
      assert.match(text, /This computer/);
      assert.match(text, /VPS/);
      assert.match(text, /https:\/\/vps\.example\.net/);
      assert.match(text, /Acts as Alice, administrator/);
      assert.match(text, /Version 0\.1\.6/);
      assert.match(text, /Online/);
      assert.doesNotMatch(text, /machines\.(settings|status)\./, 'every key is translated');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('pairing posts the address (https added to a bare host), the code and the name, then lists the machine', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      await React.act(async () => { button('Add a machine').click(); });
      const inputs = Array.from(document.querySelectorAll('form input')) as HTMLInputElement[];
      assert.equal(inputs.length, 3);
      await React.act(async () => {
        type(inputs[0]!, '  nas.example.net ');
        type(inputs[1]!, ' ABCD-EFGH-JKMN ');
        type(inputs[2]!, 'NAS');
      });
      await React.act(async () => { button('Pair').click(); });
      await settle(React);
      const pair = calls.find((c) => c.url === '/api/ui/machines/pair');
      assert.deepEqual(pair?.body, { url: 'https://nas.example.net', code: 'ABCD-EFGH-JKMN', name: 'NAS' });
      assert.equal(document.querySelectorAll('form[aria-label="Add a machine"]').length, 0, 'the form closes');
      assert.match(document.body.textContent ?? '', /NAS/);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('a refused code is said in words, and the form stays open', async () => {
  const realFetch = globalThis.fetch;
  installFetch([], (url) => (url === '/api/ui/machines/pair' ? json(422, { error: 'the machine refused this pairing code: wrong, expired or already used', code: 'invalid_code' }) : undefined));
  try {
    await withDom(async ({ React, render }) => {
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      await React.act(async () => { button('Add a machine').click(); });
      const inputs = Array.from(document.querySelectorAll('form input')) as HTMLInputElement[];
      await React.act(async () => { type(inputs[0]!, 'https://nas.example.net'); type(inputs[1]!, 'WRONG'); });
      await React.act(async () => { button('Pair').click(); });
      await settle(React);
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /refused this code/);
      assert.ok(document.querySelector('form[aria-label="Add a machine"]'));
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('"Add a machine…" from the switcher opens the form, even before the pane is mounted', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      const store = await import('./fleet-store');
      store.requestAddMachine();
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      assert.ok(document.querySelector('form[aria-label="Add a machine"]'));
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('renaming and removing go to the local daemon; nothing is removed before it is confirmed', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  try {
    await withDom(async ({ React, render }) => {
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      await React.act(async () => { button('Rename').click(); });
      const field = document.querySelector('input[aria-label="Machine name"]') as HTMLInputElement;
      await React.act(async () => { type(field, '  Paris VPS '); });
      await React.act(async () => { button('Save').click(); });
      await settle(React);
      assert.deepEqual(calls.find((c) => c.method === 'PATCH'), { method: 'PATCH', url: '/api/ui/machines/vps', body: { name: 'Paris VPS' } });
      assert.match(document.body.textContent ?? '', /Paris VPS/);

      await React.act(async () => { button('Remove').click(); });
      assert.equal(calls.filter((c) => c.method === 'DELETE').length, 0);
      assert.match(document.querySelector('[role="alertdialog"]')?.textContent ?? '', /Remove Paris VPS from this computer/);
      await React.act(async () => { button('Remove the machine').click(); });
      await settle(React);
      assert.deepEqual(calls.filter((c) => c.method === 'DELETE').map((c) => c.url), ['/api/ui/machines/vps']);
      assert.match(document.body.textContent ?? '', /No other machine yet/);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('on a remote machine the pane offers the way back, and the active machine cannot be switched to again', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      const { MachinesSettings } = await import('./settings');
      await render(React.createElement(MachinesSettings));
      await settle(React);
      assert.ok(button('Back to this computer'));
      assert.equal(Array.from(document.querySelectorAll('button')).filter((b) => b.textContent === 'Switch to it').length, 0);
      assert.match(document.body.textContent ?? '', /Active/);
    }, 'vps');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

async function renderSwitcher(React: typeof import('react'), render: (element: import('react').ReactElement) => Promise<void>, forceLabel = true, holdExpanded?: () => () => void): Promise<void> {
  const { NavChromeProvider } = await import('@/components/nav-link');
  const { MachineSwitcher } = await import('./switcher');
  await render(React.createElement(NavChromeProvider, { value: { expanded: true, forceLabel, holdExpanded } }, React.createElement(MachineSwitcher)));
}

test('the menu opens above the trigger, from its left edge, on the rail as in the drawer', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    for (const forceLabel of [false, true]) {
      await withDom(async ({ React, render }) => {
        await renderSwitcher(React, render, forceLabel);
        await settle(React);
        const trigger = document.querySelector('button[aria-label^="Machine:"]') as HTMLButtonElement;
        await React.act(async () => {
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await settle(React);
        const menu = document.querySelector('[role="menu"]');
        assert.equal(menu?.getAttribute('data-side'), 'top', `forceLabel=${forceLabel}`);
        assert.equal(menu?.getAttribute('data-align'), 'start', `forceLabel=${forceLabel}`);
      });
    }
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('the rail stays expanded while the menu is open, and only then', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  let holds = 0;
  const holdExpanded = () => {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
    };
  };
  try {
    await withDom(async ({ React, render }) => {
      await renderSwitcher(React, render, false, holdExpanded);
      await settle(React);
      assert.equal(holds, 0, 'a closed menu holds nothing');
      const trigger = document.querySelector('button[aria-label^="Machine:"]') as HTMLButtonElement;
      const openMenu = async () => {
        await React.act(async () => {
          trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await settle(React);
      };
      await openMenu();
      assert.equal(holds, 1, 'the open menu holds the rail');
      const menu = document.querySelector('[role="menu"]') as HTMLElement;
      await React.act(async () => {
        menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await settle(React);
      assert.ok(!document.querySelector('[role="menu"]'), 'the menu is closed');
      assert.equal(holds, 0, 'closing releases it');
      await openMenu();
      assert.equal(holds, 1);
      const manage = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === 'Manage connections') as HTMLElement;
      await React.act(async () => { manage.click(); });
      await settle(React);
      assert.equal(holds, 0, 'a choice releases it too');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('"Manage connections" opens Settings and the page still answers once it is closed (TIM-0035)', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render, router }) => {
      const { NavChromeProvider } = await import('@/components/nav-link');
      const { MachineSwitcher } = await import('./switcher');
      const { Dialog, DialogContent, DialogTitle } = await import('@/components/ui/dialog');
      const state = { settings: false, outside: 0 };
      const paint = () => render(React.createElement(React.Fragment, null,
        React.createElement(NavChromeProvider, { value: { expanded: true, forceLabel: true } }, React.createElement(MachineSwitcher)),
        React.createElement('button', { type: 'button', id: 'outside', onClick: () => { state.outside += 1; } }, 'Outside'),
        // Stands for the Settings dialog, which the `?settings=` push mounts.
        React.createElement(Dialog, { open: state.settings, onOpenChange: (open: boolean) => { state.settings = open; void paint(); } },
          React.createElement(DialogContent, { 'aria-describedby': undefined },
            React.createElement(DialogTitle, null, 'Settings'),
            React.createElement('button', { type: 'button', id: 'close-settings', onClick: () => { state.settings = false; void paint(); } }, 'Close')))));
      router.onPush((path) => { if (path.includes('settings=')) { state.settings = true; void paint(); } });
      await paint();
      await settle(React);

      const trigger = document.querySelector('button[aria-label^="Machine:"]') as HTMLButtonElement;
      await React.act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle(React);
      assert.ok(document.querySelector('[role="menu"]'), 'the menu is open');
      assert.notEqual(document.body.style.pointerEvents, 'none', 'an open menu does not lock the page');

      const manage = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === 'Manage connections') as HTMLElement;
      await React.act(async () => { manage.click(); });
      await settle(React, 50);
      assert.ok(document.querySelector('[role="dialog"]'), 'Settings is open');

      await React.act(async () => { (document.getElementById('close-settings') as HTMLButtonElement).click(); });
      await settle(React, 50);
      assert.ok(!document.querySelector('[role="dialog"]'), 'Settings is closed');
      assert.notEqual(document.body.style.pointerEvents, 'none', 'nothing is left locking the page');
      await React.act(async () => { (document.getElementById('outside') as HTMLButtonElement).click(); });
      assert.equal(state.outside, 1);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('the switcher names this computer when it drives it', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      await renderSwitcher(React, render);
      await settle(React);
      const trigger = document.querySelector('button[aria-label^="Machine:"]');
      assert.match(trigger?.textContent ?? '', /This computer/);
      assert.doesNotMatch(trigger?.textContent ?? '', /as /);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('on a remote machine the switcher names it and the account this computer acts as there', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      await renderSwitcher(React, render);
      await settle(React);
      const trigger = document.querySelector('button[aria-label^="Machine:"]');
      assert.match(trigger?.textContent ?? '', /VPS/);
      assert.match(trigger?.textContent ?? '', /as Alice/);
    }, 'vps');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('the menu lists this computer first, then the fleet; a choice goes to the app, a refusal is said', async (t) => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls);
  // `require`, not `import()`: the component's `sonner` is the CommonJS build.
  const { toast } = createRequire(join(process.cwd(), 'package.json'))('sonner') as typeof import('sonner');
  const errors = t.mock.method(toast, 'error', () => '');
  try {
    await withDom(async ({ React, render, router }) => {
      await renderSwitcher(React, render);
      await settle(React);
      const trigger = document.querySelector('button[aria-label^="Machine:"]') as HTMLButtonElement;
      await React.act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle(React);
      const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((item) => item.textContent ?? '');
      assert.deepEqual(items.map((text) => text.replace(/as Alice/, '').trim()), ['This computer', 'VPS', 'Add a machine…', 'Manage connections']);

      const vps = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => /VPS/.test(item.textContent ?? '')) as HTMLElement;
      await React.act(async () => { vps.click(); });
      await settle(React);
      assert.deepEqual(calls.find((c) => c.url === '/api/ui/machines/active')?.body, { id: 'vps' });
      assert.equal(errors.mock.callCount(), 1, 'the refusal is shown');

      await React.act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle(React);
      const manage = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => item.textContent === 'Manage connections') as HTMLElement;
      await React.act(async () => { manage.click(); });
      assert.match(decodeURIComponent(router.pushed.at(-1) ?? ''), /settings=plugins\/@timon\/machines/);
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

/** A desktop window that keeps pages (V4): the shell shows the machine chosen and hides this page alive. */
function installKeepingShell(): string[] {
  const asked: string[] = [];
  (window as unknown as { timonDesktop?: unknown }).timonDesktop = {
    windowMachine: { set: async (id: string) => { asked.push(id); return { id, shown: true }; } },
  };
  return asked;
}

test('TIM-0139: a page the desktop keeps alive names its own machine again when it comes back, not the one it left for', async () => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls, (url) => (url === '/api/ui/machines/active' ? json(200, { id: 'vps', warning: null }) : undefined));
  try {
    await withDom(async ({ React, render }) => {
      const asked = installKeepingShell();
      await renderSwitcher(React, render);
      await settle(React);
      const trigger = document.querySelector('button[aria-label^="Machine:"]') as HTMLButtonElement;
      await React.act(async () => {
        trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle(React);
      const vps = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) => /VPS/.test(item.textContent ?? '')) as HTMLElement;
      await React.act(async () => { vps.click(); });
      await settle(React);
      assert.deepEqual(asked, ['vps'], 'the window was asked to show the VPS');
      assert.equal(window.location.pathname, '/', 'the page was hidden alive, not reloaded');
      // The shell shows this page again on the way back: as it was before the switch.
      assert.match(trigger.textContent ?? '', /This computer/);
      assert.doesNotMatch(trigger.textContent ?? '', /Switching/);
      assert.equal(trigger.disabled, false, 'it can switch again');
    });
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('TIM-0139: "Back to this computer" on a page the desktop keeps alive is not left busy', async () => {
  const realFetch = globalThis.fetch;
  installFetch([], (url) => (url === '/api/ui/machines/active' ? json(200, { id: 'local', warning: null }) : undefined));
  try {
    await withDom(async ({ React, render }) => {
      const asked = installKeepingShell();
      const { BackToLocalButton } = await import('@/components/machines/back-to-local');
      await render(React.createElement(BackToLocalButton));
      const back = button('Back to this computer');
      await React.act(async () => { back.click(); });
      await settle(React);
      assert.deepEqual(asked, ['local']);
      assert.equal(back.disabled, false);
    }, 'vps');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('banner: a machine that stops answering after the load is said, with the way back', async (t) => {
  const realFetch = globalThis.fetch;
  const calls: Call[] = [];
  installFetch(calls, (url) => (url === '/api/ui/machines/vps/status'
    ? json(200, { machine: machineRow('vps', { status: 'unreachable' }), reachable: false, version: null, apiLevel: null })
    : undefined));
  t.mock.timers.enable({ apis: ['setInterval'] });
  try {
    await withDom(async ({ React, render }) => {
      const { MachineBanner, PROBE_INTERVAL_MS } = await import('./banner');
      await render(React.createElement(MachineBanner, { machineId: 'vps', machine: machineRow('vps') as never }));
      assert.ok(!document.querySelector('[role="alert"]'), 'nothing before a probe says so');
      await React.act(async () => { t.mock.timers.tick(PROBE_INTERVAL_MS); });
      await settle(React);
      assert.ok(calls.some((c) => c.url === '/api/ui/machines/vps/status'), 'probed through the local daemon');
      assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /VPS cannot be reached right now/);
      assert.ok(button('Back to this computer'));
    }, 'vps');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});

test('banner: an unknown or newer contract level is said once, and dismissed for the session', async () => {
  const realFetch = globalThis.fetch;
  installFetch([]);
  try {
    await withDom(async ({ React, render }) => {
      const { MachineBanner } = await import('./banner');
      await render(React.createElement(MachineBanner, { machineId: 'vps', machine: machineRow('vps', { api_level: null }) as never }));
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /VPS does not say which interface it expects/);
      await React.act(async () => { button('Dismiss').click(); });
      assert.ok(!document.querySelector('[role="status"]'));
      // Stored for that machine only.
      assert.equal(window.sessionStorage.getItem('m:vps:timon.machines.levelNoticeDismissed'), '1');

      // A fresh banner in a fresh session.
      await render(React.createElement('div'));
      window.sessionStorage.clear();
      await render(React.createElement(MachineBanner, { machineId: 'nas', machine: machineRow('nas', { api_level: 99 }) as never }));
      assert.match(document.querySelector('[role="status"]')?.textContent ?? '', /NAS runs a newer Timon than this interface/);
      await render(React.createElement(MachineBanner, { machineId: 'ok', machine: machineRow('ok') as never }));
      assert.ok(!document.querySelector('[role="status"]'), 'a compatible machine gets no notice');
    }, 'vps');
  } finally {
    Object.defineProperty(globalThis, 'fetch', { value: realFetch, configurable: true, writable: true });
  }
});
