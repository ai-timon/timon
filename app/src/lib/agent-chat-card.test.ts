// french-ok-file: an accented sub-agent label, as a user names one
/**
 * The cockpit chat card, mounted whole: one click on a shortcut avatar must
 * hand the chat below the agent that was chosen.
 *
 * `ChatClient` needs the Next router and the whole chat runtime: it is replaced
 * at the module boundary, in the CommonJS module cache tsx compiles the card
 * into (no test-runner flag needed), with a stub that records the props the
 * card gives it. Everything else — the card, the shortcut row, `Tile`,
 * the instance helpers — is the real code.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

type ChatProps = { forcedAgent?: string };

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
  // The agents list the card fetches on mount: two known icons, no network.
  install('fetch', async () => ({
    ok: true,
    json: async () => ({ agents: [{ name: 'alice.main', icon_url: '/main.png' }, { name: 'Alice.helper', icon_url: '/health-own.png' }] }),
  }));

  const React = await import('react');
  install('React', React);

  const chatProps: ChatProps[] = [];
  install('__cardStubs', {
    ChatClient: (props: ChatProps) => {
      chatProps.push(props);
      return React.createElement('div', { 'data-testid': 'chat', 'data-agent': props.forcedAgent ?? '' });
    },
  });

  const req = createRequire(import.meta.url);
  const replace = (specifier: string, exports: Record<string, unknown>) => {
    const filename = req.resolve(specifier);
    req.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] } as never;
  };
  replace('@/app/chat/chat-client', { ChatClient: (props: ChatProps) => (globalThis as never as { __cardStubs: { ChatClient: (p: ChatProps) => unknown } }).__cardStubs.ChatClient(props) });
  // The card loads `ChatClient` on demand: the loader is skipped for the stub.
  replace('next/dynamic', { __esModule: true, default: () => (props: ChatProps) => (globalThis as never as { __cardStubs: { ChatClient: (p: ChatProps) => unknown } }).__cardStubs.ChatClient(props) });

  const { createRoot } = await import('react-dom/client');
  const { AgentChatCard } = await import('../plugins-client/agent-chat/agent-chat-card');
  const saved: { subAgents: { agent: string }[] }[] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(AgentChatCard, {
      instance: instance as never,
      onSave: (next: { subAgents: { agent: string }[] }) => { saved.push(next); },
      onDelete: () => {},
    } as never));
  });

  const shortcuts = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('[role="group"] button'));
  const chatAgent = () => document.querySelector('[data-testid="chat"]')?.getAttribute('data-agent');
  const click = async (button: HTMLButtonElement) => { await React.act(async () => { button.click(); }); };
  const key = async (target: Element, k: string) => {
    await React.act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true }));
    });
  };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { shortcuts, chatAgent, chatProps, click, key, saved, unmount };
}

test('a click on a shortcut avatar switches the chat of the card to that agent', async () => {
  const { shortcuts, chatAgent, chatProps, click, unmount } = await mount({
    id: 'main',
    agent: 'alice.main',
    title: '',
    avatar: '',
    zone: '',
    subAgents: [
      { agent: 'Alice.helper', label: 'Santé' },
      { agent: 'alice.coder', label: 'Coder', avatar: '/coder.png' },
    ],
  });
  try {
    // Opens on the instance's own agent, its shortcut pressed.
    assert.equal(chatAgent(), 'alice.main');
    assert.equal(shortcuts().length, 3);
    assert.deepEqual(shortcuts().map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
    // Icons come from the agents list unless the card carries a photo of its
    // own for that agent, and an agent the list does not know shows its initial.
    assert.equal(shortcuts()[1]!.querySelector('img')?.getAttribute('src'), '/health-own.png');
    assert.equal(shortcuts()[2]!.querySelector('img')?.getAttribute('src'), '/coder.png');
    assert.equal(shortcuts()[1]!.getAttribute('title'), 'Santé');

    await click(shortcuts()[1]!);
    assert.equal(chatProps[chatProps.length - 1]!.forcedAgent, 'Alice.helper');
    assert.equal(chatAgent(), 'Alice.helper');
    assert.deepEqual(shortcuts().map((b) => b.getAttribute('aria-pressed')), ['false', 'true', 'false']);

    await click(shortcuts()[2]!);
    assert.equal(chatAgent(), 'alice.coder');
    assert.deepEqual(shortcuts().map((b) => b.getAttribute('aria-pressed')), ['false', 'false', 'true']);

    await click(shortcuts()[0]!);
    assert.equal(chatAgent(), 'alice.main');
    assert.deepEqual(shortcuts().map((b) => b.getAttribute('aria-pressed')), ['true', 'false', 'false']);
  } finally {
    await unmount();
  }
});

test('the + at the end of the row adds an agent in one pick, without the config', async () => {
  const { shortcuts, click, key, saved, unmount } = await mount({
    id: 'main', agent: 'alice.main', title: '', avatar: '', zone: '', subAgents: [],
  });
  try {
    // A lone agent keeps its avatar: the row replaced the medallion.
    assert.equal(shortcuts().length, 1);
    const plus = document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
    assert.ok(plus, 'the + button');
    assert.ok(!plus.closest('[role="group"]'), 'the + is not one of the agents');

    await click(plus);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog);
    const input = dialog.querySelector<HTMLInputElement>('[role="combobox"]')!;
    assert.ok(document.activeElement === input, 'the search has the focus');
    // The card's own agent is listed but out of reach.
    const options = Array.from(dialog.querySelectorAll('[role="option"]'));
    const disabled = (name: string) =>
      options.find((o) => o.textContent?.includes(name))?.getAttribute('aria-disabled') ?? null;
    assert.equal(options.length, 2);
    assert.equal(disabled('alice.main'), 'true');
    assert.equal(disabled('Alice.helper'), null);

    await key(input, 'Enter');
    assert.deepEqual(saved[saved.length - 1]?.subAgents, [{ agent: 'Alice.helper' }]);
    assert.ok(!document.querySelector('[role="dialog"]'), 'closed after the pick');
    assert.ok(document.activeElement === plus, 'focus back on the +');

    // Escape closes without adding.
    await click(plus);
    await key(document.querySelector('[role="dialog"] [role="combobox"]')!, 'Escape');
    assert.ok(!document.querySelector('[role="dialog"]'));
    assert.equal(saved.length, 1);
  } finally {
    await unmount();
  }
});
