/**
 * One message, one left edge: the text, the tool chips, the reasoning, a tool's
 * detail and the copy / read-aloud row all start on the same column. On a phone
 * the agent's name sits on it too; on desktop the name keeps a slight outdent,
 * on purpose.
 *
 * Two independent dimensions: the viewport decides the inset, `compact` (a
 * multichat cell, a narrow thread) only drops the avatar gutter.
 *
 * jsdom lays nothing out, so this holds the classes and the rules that make the
 * geometry: an inset stacked back on one element is what brought the staircase.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { twMerge } from 'tailwind-merge';

const MATRIX = [
  { compact: false, label: 'regular' },
  { compact: true, label: 'compact' },
];

/** What a viewport applies: a phone ignores `sm:`, a desktop lets it win. */
function classesAt(viewport: 'phone' | 'desktop', classes: string[]): string[] {
  const base = classes.filter((name) => !name.startsWith('sm:'));
  if (viewport === 'phone') return base;
  const desktop = classes.filter((name) => name.startsWith('sm:')).map((name) => name.slice('sm:'.length));
  return twMerge([...base, ...desktop].join(' ')).split(' ');
}

interface Rendered {
  agentBubble: string[];
  userBubble: string[];
  actions: string[];
  quoteSources: string[];
  css: string;
}

async function renderThread(compact: boolean): Promise<Rendered> {
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
  const matchMedia = () => ({
    matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  });
  install('matchMedia', matchMedia);
  Object.defineProperty(dom.window, 'matchMedia', { value: matchMedia, configurable: true });
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const MISSION = {
    running: false,
    turn_active: false,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'Check the build.' } } },
      {
        type: 'assistant',
        timestamp: 2,
        payload: { type: 'assistant', message: { content: [
          { type: 'thinking', thinking: 'Reading the log first.' },
          { type: 'text', text: 'The build is green.' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } },
        ] } },
      },
      { type: 'user', timestamp: 3, payload: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } } },
      {
        type: 'user', timestamp: 4,
        payload: {
          type: 'user', origin: { kind: 'agent', from: 'reviewer' },
          message: { content: 'Review note from another agent.' },
        },
      },
    ],
  };
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) {
      return Response.json({
        missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 3, running: false }],
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
  const { ThemeProvider } = await import('../components/theme-provider');
  const { ChatClient } = await import('../app/chat/chat-client');
  // All props are optional: the cast only restores the ones the component declares.
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(PathnameContext.Provider, { value: '/chat' },
            React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('mission=m1') as never },
              React.createElement(ThemeProvider, null,
                React.createElement(WidgetHost, null,
                  React.createElement(Chat, { forcedMission: 'm1', compact })))))),
      );
    });
    const bubbles = Array.from(document.querySelectorAll('.chat-bubble'));
    const classesOf = (el: Element | null | undefined) => (el?.className ?? '').split(/\s+/);
    const agent = bubbles.find((el) => el.textContent?.includes('The build is green.'));
    const user = bubbles.find((el) => el.textContent?.includes('Check the build.'));
    const copy = agent?.parentElement?.querySelector('button[aria-label="Copy"]');
    return {
      agentBubble: classesOf(agent),
      userBubble: classesOf(user),
      actions: classesOf(copy?.parentElement),
      quoteSources: Array.from(document.querySelectorAll('[data-chat-quote-source]'), (node) => node.textContent?.trim() ?? ''),
      css: Array.from(document.querySelectorAll('style')).map((style) => style.textContent ?? '').join('\n'),
    };
  } finally {
    await React.act(async () => { root.unmount(); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

for (const { compact, label } of MATRIX) {
  test(`phone, ${label}: the column is the name's own edge`, async () => {
    const r = await renderThread(compact);
    const bubble = classesAt('phone', r.agentBubble);
    // 4px of inset, cancelled by the margin: net zero, and the clip stays clear.
    assert.ok(bubble.includes('px-1') && bubble.includes('-mx-1'), bubble.join(' '));
    assert.ok(!bubble.includes('px-3.5'), bubble.join(' '));
    assert.ok(classesAt('phone', r.actions).includes('-ml-1'), r.actions.join(' '));
  });

  test(`desktop, ${label}: the content keeps one inset, and the actions land on it`, async () => {
    const r = await renderThread(compact);
    const bubble = classesAt('desktop', r.agentBubble);
    assert.ok(bubble.includes('px-3.5') && bubble.includes('mx-0'), bubble.join(' '));
    assert.ok(!bubble.includes('px-1') && !bubble.includes('-mx-1'), bubble.join(' '));
    // 10px of margin + the 4px around a glyph in its hit area = the bubble's 14px.
    const actions = classesAt('desktop', r.actions);
    assert.ok(actions.includes('ml-2.5') && !actions.includes('-ml-1'), actions.join(' '));
  });
}

test('the human bubble keeps its tinted box and its inset', async () => {
  const r = await renderThread(false);
  assert.ok(r.userBubble.includes('px-3.5'), r.userBubble.join(' '));
});

test('nothing inside a bubble stacks its own left inset', async () => {
  const { css } = await renderThread(true);
  for (const selector of ['.tool-block-body', '.tool-stack-row', '.tool-stack-open-name']) {
    const rules = css.match(new RegExp(`\\.chat-bubble[^{}]*\\${selector}\\s*\\{[^}]*\\}`, 'g')) ?? [];
    for (const rule of rules) assert.doesNotMatch(rule, /padding-left/, rule);
  }
  const live = css.match(/\.chat-bubble \.tool-stack-live \{[^}]*\}/)?.[0] ?? '';
  assert.match(live, /padding: 4px 0 0;/);
  assert.match(css, /\.automatic-instruction\[open\] \{\s*margin: 10px 0;/, 'an opened frame stays on the column');
});

test('only messages shown as agent prose are marked as quote sources', async () => {
  const { quoteSources } = await renderThread(false);
  assert.deepEqual(quoteSources, ['The build is green.', 'Review note from another agent.']);
});
