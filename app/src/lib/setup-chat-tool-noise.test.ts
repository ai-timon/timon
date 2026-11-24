/**
 * The setup conversation shows the person their agent, not its tooling.
 *
 * Seen on 0.1.5-rc.7: when the main agent asked its first question, the setup
 * screen stacked a bubble holding nothing but two tool pills, the question card
 * under a "permission" badge and "The agent has a question:", a "running Timon
 * Ask · Question" bubble and the amber running-tool bar over the composer. The
 * same mission is replayed twice: in the setup conversation all of that is
 * gone and the question itself stays; in the normal chat every piece is still
 * there, since this fix is the setup's alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Rendered {
  text: string;
  /** Bubbles drawn, the live "thinking" one included (the question card is not one). */
  bubbles: number;
  /** The question's category label is drawn in a fixed-width font. */
  headerMono: boolean;
}

async function renderMission(setup: boolean, asked = true): Promise<Rendered> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', {
    url: 'http://localhost/chat?mission=m1',
    pretendToBeVisual: true,
  });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element',
    'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('matchMedia', () => ({
    matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const question = {
    id: 'q1',
    tool_name: 'ask_user',
    input: { questions: [{ header: 'Language', question: 'Which language do you prefer?', options: [{ label: 'English' }, { label: 'Français' }] }] }, // french-ok: the name of a language option
  };
  const MISSION = {
    // Mid-turn: the agent's `question` call is still in flight, waiting for the card.
    running: false,
    turn_active: true,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'bootstrap skill' } } },
      {
        type: 'assistant',
        timestamp: 2,
        payload: { type: 'assistant', message: { content: [
          { type: 'tool_use', id: 't1', name: 'mcp__timon__docs_search', input: { query: 'setup' } },
        ] } },
      },
      { type: 'user', timestamp: 3, payload: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } },
      {
        type: 'assistant',
        timestamp: 4,
        payload: { type: 'assistant', message: { content: [
          { type: 'text', text: 'Hello, I am your new agent.' },
          { type: 'tool_use', id: 't2', name: 'mcp__timon_ask__question', input: {} },
        ] } },
      },
      ...(asked ? [{ type: 'permission_request', timestamp: 5, payload: { type: 'permission_request', ...question } }] : []),
    ],
  };
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) {
      return Response.json({
        missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 5, running: false }],
      });
    }
    if (url.startsWith('/api/ui/missions/m1')) return Response.json(MISSION);
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  // All props are optional: the cast only restores the ones the component declares.
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean; setup?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
              React.createElement(WidgetHost, null,
                React.createElement(Chat, { forcedMission: 'm1', compact: true, setup }))))),
      );
    });
    const header = Array.from(document.querySelectorAll('span')).find((el) => el.textContent === 'Language');
    // The page's own <style> blocks are text too: only what is drawn counts.
    const body = document.body.cloneNode(true) as HTMLElement;
    body.querySelectorAll('style').forEach((style) => style.remove());
    return {
      text: body.textContent ?? '',
      bubbles: document.querySelectorAll('.chat-bubble').length,
      headerMono: Boolean(header?.className.includes('font-mono')),
    };
  } finally {
    await React.act(async () => { root.unmount(); });
    setLocale(locale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('the normal chat still shows the tool calls, the permission badge and the running call', async () => {
  const r = await renderMission(false);
  assert.equal(r.bubbles, 3, 'the tools-only bubble, the text bubble and the running one');
  assert.match(r.text, /Timon · Docs Search/, 'the tool pills');
  assert.match(r.text, /step 2/);
  assert.match(r.text, /running Timon Ask · Question/, 'the live bubble');
  assert.match(r.text, /Timon Ask · Question\d/, 'the running-tool bar and its timer');
  assert.match(r.text, /permission/);
  assert.match(r.text, /The agent has a question:/);
  assert.match(r.text, /Which language do you prefer\?/);
});

test('the setup conversation hides the tool noise and keeps the question', async () => {
  const r = await renderMission(true);
  assert.equal(r.bubbles, 1, 'only the bubble that says something');
  assert.match(r.text, /Hello, I am your new agent\./);
  assert.doesNotMatch(r.text, /Docs Search|Timon Ask/, 'no tool pill, live bubble nor running-tool bar');
  assert.doesNotMatch(r.text, /thinking/, 'no sign of life while the question waits');
  assert.doesNotMatch(r.text, /step 2/, 'its first step is gone, so is the numbering');
  assert.doesNotMatch(r.text, /permission/);
  assert.doesNotMatch(r.text, /The agent has a question:/);
  assert.match(r.text, /Language/);
  assert.match(r.text, /Which language do you prefer\?/);
  assert.equal(r.headerMono, false);
});

test('the setup conversation keeps one bare sign of life while the agent works', async () => {
  const r = await renderMission(true, false);
  assert.match(r.text, /thinking/);
  assert.doesNotMatch(r.text, /Timon Ask/, 'not what it is running');
});
