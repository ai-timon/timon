// french-ok-file: an accented sub-agent label, as a user names one
/**
 * The config of a cockpit chat card: the other agents of the row are picked
 * from the installed agents, and nothing else is asked about them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mount(instance: unknown) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (url: string) => ({
    ok: true,
    json: async () => (String(url).includes('projects')
      ? { projects: [{ slug: 'perso', name: 'Perso', icon: '/perso.png' }] }
      : { agents: [
          { name: 'alice.main', icon_url: '/main.png' },
          { name: 'Alice.helper', project: 'perso' },
          { name: 'timon.coder' },
        ] }),
  }));

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { InstanceConfig } = await import('../plugins-client/agent-chat/instance-config');

  const saved: unknown[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(InstanceConfig, {
      instance: instance as never,
      onSave: (next: unknown) => { saved.push(next); },
      onCancel: () => {},
    }));
  });
  const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const act = React.act;
  const key = async (k: string) => {
    await act(async () => {
      input().dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };
  const type = async (value: string) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      document.querySelector('form')!.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    });
  };
  const rows = () => Array.from(document.querySelectorAll('form ul:not([role]) > li')).map((li) => li.textContent);
  const unmount = async () => { await act(async () => { root.unmount(); }); dom.window.close(); };
  return { input, key, type, submit, rows, saved, unmount };
}

test('a card opens in the new-card config, gains an agent by search, and keeps the per-agent overrides on save', async () => {
  const c = await mount({
    id: 'main',
    agent: 'alice.main',
    title: 'Alice',
    avatar: '',
    zone: 'centre',
    // As a tester's stored card still has it, straight from #155.
    subAgents: [{ agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }],
  });
  try {
    // One search field for the agents, no label or avatar URL field.
    assert.equal(document.querySelectorAll('[role="combobox"]').length, 1);
    assert.equal(document.querySelectorAll('form input').length, 3, 'main agent, title, search');
    // The row shows the agent's own name and its project's icon.
    assert.equal(c.rows().length, 1);
    assert.ok(c.rows()[0]?.includes('Alice.helper'));
    assert.ok(!c.rows()[0]?.includes('Santé'));
    assert.equal(document.querySelector('form ul:not([role]) > li img')?.getAttribute('src'), '/perso.png');

    await c.type('coder');
    await c.key('Enter');
    assert.equal(c.rows().length, 2);
    assert.ok(c.rows()[1]?.includes('timon.coder'));

    await c.submit();
    const [next] = c.saved as { subAgents: unknown[] }[];
    assert.deepEqual(next?.subAgents, [{ agent: 'Alice.helper', label: 'Santé', avatar: '/health.png' }, { agent: 'timon.coder' }]);
  } finally {
    await c.unmount();
  }
});
