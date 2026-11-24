/**
 * The project's row "Contributors' conflicts": shown only for a project that
 * opens pull requests on GitHub, one action that opens the choice in a
 * dialog, and a write that carries nothing but the setting. A refusal of the
 * daemon (an agent, the daemon's token) stays in the dialog.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; method: string; body: unknown };

async function mount(integration: Record<string, unknown>, refuse = false) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'NodeFilter', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent',
    'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let stored = { ...integration };
  const calls: Call[] = [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, method, body });
    if (url !== '/api/ui/projects/acme/integration') return Response.json({ error: 'not_found' }, { status: 404 });
    if (method === 'PUT') {
      if (refuse) {
        return Response.json({ error: 'only a signed-in person lets Timon resolve a contributor\'s conflict', code: 'person_required' }, { status: 403 });
      }
      stored = { ...stored, ...(body as Record<string, unknown>) };
    }
    return Response.json({ integration: stored, configured: true });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const { ContributorConflictsSetting } = await import('./contributor-conflicts-setting');
  const dispose = slots.register({ slot: 'project.settings', pluginId: '@timon/kanban', key: 'contributor-conflicts' }, ContributorConflictsSetting);
  const { ProjectSettingsSlot } = await import('@/components/project-settings-slot');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(ProjectSettingsSlot, { project: 'acme' })); });
  const settle = async () => {
    for (let i = 0; i < 6; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    dispose();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { calls, click, unmount };
}

const status = () => document.querySelector('[data-contributor-conflicts-status]')?.getAttribute('data-contributor-conflicts-status');

test('a project that opens pull requests on GitHub gets the row, and the choice is written alone', async () => {
  const m = await mount({ mode: 'pr', forge: 'github', account: 'acme-bot', contributor_conflicts: 'ask' });
  try {
    assert.equal(status(), 'ask');
    assert.match(document.body.textContent ?? '', /Contributors' conflicts/);
    assert.match(document.body.textContent ?? '', /Ask the contributor/);
    assert.ok(!document.querySelector('[data-contributor-conflicts-dialog]'), 'no field is shown in the row');

    await m.click(document.querySelector('[data-contributor-conflicts-configure]'));
    assert.equal(document.querySelector('[data-contributor-conflicts-mode="ask"]')?.getAttribute('aria-checked'), 'true');
    await m.click(document.querySelector('[data-contributor-conflicts-mode="resolve"]'));
    await m.click(document.querySelector('[data-contributor-conflicts-save]'));
    const put = m.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(put?.body, { contributor_conflicts: 'resolve' });
    assert.equal(status(), 'resolve');
    assert.ok(!document.querySelector('[data-contributor-conflicts-dialog]'));
  } finally {
    await m.unmount();
  }
});

test('a refusal of the daemon stays in the dialog, the row unchanged', async () => {
  const m = await mount({ mode: 'pr', forge: 'github', contributor_conflicts: 'ask' }, true);
  try {
    await m.click(document.querySelector('[data-contributor-conflicts-configure]'));
    await m.click(document.querySelector('[data-contributor-conflicts-mode="resolve"]'));
    await m.click(document.querySelector('[data-contributor-conflicts-save]'));
    assert.equal(
      document.querySelector('[data-contributor-conflicts-error]')?.textContent,
      'Only a person signed in to Timon lets it resolve contributors\' conflicts.',
      'the refusal names the gesture, not only who may make it',
    );
    assert.equal(status(), 'ask');
  } finally {
    await m.unmount();
  }
});

test('a project that does not open pull requests gets no row, and its section hides itself', async () => {
  const m = await mount({ mode: 'local', forge: 'github', contributor_conflicts: 'ask' });
  try {
    assert.ok(!document.querySelector('[data-contributor-conflicts]'));
    const section = document.querySelector('[data-project-settings]');
    assert.ok(section?.className.includes('has-[>div:empty]:hidden'));
    assert.equal(section?.lastElementChild?.childElementCount, 0);
  } finally {
    await m.unmount();
  }
});
