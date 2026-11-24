// french-ok-file: an accented sub-agent label, as a user names one
/**
 * The row of agent shortcuts on top of the cockpit chat card.
 *
 * The card itself embeds `ChatClient`, which needs the Next router and the
 * whole chat runtime; the switching contract lives in the row, so the row is
 * mounted here with the same selection state the card keeps.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function mount(
  modes: { value: string; label: string; avatar?: string }[],
  agents: unknown[] = [],
  projects: unknown[] = [],
) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentShortcuts } = await import('../plugins-client/agent-chat/agent-shortcuts');

  const shown: string[] = [];
  function Harness() {
    const [active, setActive] = React.useState(modes[0]!.value);
    shown.push(active);
    return React.createElement(AgentShortcuts, { modes, active, agents: agents as never[], projets: projects as never[], onSelect: setActive });
  }
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(Harness)); });
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button'));
  const click = async (button: HTMLButtonElement) => { await React.act(async () => { button.click(); }); };
  const key = async (target: HTMLElement, k: string) => {
    await React.act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { buttons, click, key, shown, unmount };
}

test('one avatar per agent; a click switches the active one and exposes it as pressed', async () => {
  const { buttons, click, shown, unmount } = await mount([
    { value: 'alice.main', label: 'Alice' },
    { value: 'Alice.helper', label: 'Santé', avatar: '/health.png' },
    { value: 'alice.coder', label: 'Coder' },
  ]);
  try {
    assert.equal(buttons().length, 3);
    assert.deepEqual(buttons().map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    assert.deepEqual(buttons().map((b) => b.getAttribute('aria-current')), ['true', null, null]);
    // Every avatar is a named button.
    for (const b of buttons()) assert.ok((b.getAttribute('aria-label') ?? '').length > 0);
    assert.ok(buttons()[1]!.getAttribute('title')?.includes('Santé'));
    assert.equal(buttons()[1]!.querySelector('img')?.getAttribute('src'), '/health.png');

    await click(buttons()[1]!);
    assert.equal(shown[shown.length - 1], 'Alice.helper');
    assert.deepEqual(buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);

    await click(buttons()[2]!);
    assert.deepEqual(buttons().map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);
  } finally {
    await unmount();
  }
});

test('an agent without an avatar wears its own icon, else its project\'s, else its initial', async () => {
  const { buttons, unmount } = await mount(
    [{ value: 'a.main', label: 'A' }, { value: 'p.coder', label: 'P' }, { value: 'b.main', label: 'B' }],
    [{ name: 'A.main', icon_url: '/a-icon.png' }, { name: 'p.coder', project: 'proj' }],
    [{ slug: 'proj', icon: '/proj.png' }],
  );
  try {
    assert.equal(buttons()[0]!.querySelector('img')?.getAttribute('src'), '/a-icon.png');
    assert.equal(buttons()[1]!.querySelector('img')?.getAttribute('src'), '/proj.png');
    assert.ok(!buttons()[2]!.querySelector('img'));
    assert.equal(buttons()[2]!.textContent, 'B');
  } finally {
    await unmount();
  }
});

test('a lone agent still has its avatar: the row is the picture of the card', async () => {
  const { buttons, unmount } = await mount([{ value: 'a.main', label: 'A' }]);
  try {
    assert.equal(buttons().length, 1);
    assert.equal(buttons()[0]!.getAttribute('aria-pressed'), 'true');
    assert.equal(buttons()[0]!.getAttribute('title'), 'A');
  } finally {
    await unmount();
  }
});

test('Tab lands on the current agent, the arrows walk the row, Enter-click switches', async () => {
  const { buttons, click, key, shown, unmount } = await mount([
    { value: 'a.main', label: 'A' },
    { value: 'b.main', label: 'B' },
    { value: 'c.main', label: 'C' },
  ]);
  try {
    assert.deepEqual(buttons().map((b) => b.tabIndex), [0, -1, -1]);
    buttons()[0]!.focus();
    await key(buttons()[0]!, 'ArrowRight');
    assert.ok(document.activeElement === buttons()[1]);
    await key(buttons()[1]!, 'End');
    assert.ok(document.activeElement === buttons()[2]);
    await key(buttons()[2]!, 'ArrowRight');
    assert.ok(document.activeElement === buttons()[0], 'wraps around');
    await key(buttons()[0]!, 'ArrowLeft');
    assert.ok(document.activeElement === buttons()[2]);
    // Moving focus does not switch the thread; activating the button does.
    assert.equal(shown[shown.length - 1], 'a.main');
    await click(buttons()[2]!);
    assert.equal(shown[shown.length - 1], 'c.main');
    assert.deepEqual(buttons().map((b) => b.tabIndex), [-1, -1, 0]);
  } finally {
    await unmount();
  }
});
