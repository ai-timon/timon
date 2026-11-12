/**
 * A message an agent posts through a tool call (`orchestrator/src/chat-post.ts`),
 * seen from the thread on a replay: the daemon wrote it as an ordinary
 * `assistant` event right before the form, so it is a normal agent bubble —
 * markdown, table included — ABOVE the card, not inside it; and the call's
 * chip does not repeat it.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { forgetAllChatMissions } from './chat-mission-cache';
import { chipInput } from './chat-post';

afterEach(() => forgetAllChatMissions());

const REPORT = 'Here is the comparison you need to choose.\n\n| option | cost |\n|---|---|\n| Alpha | low |\n| Beta | high |';
const QUESTIONS = { questions: [{ question: 'Which option do we keep?', header: 'Pick', options: [{ label: 'Alpha' }, { label: 'Beta' }] }] };

const ev = (id: number, type: string, payload: Record<string, unknown>) => ({ id, type, timestamp: id * 10, payload });
const TAIL = {
  running: false,
  turn_active: false,
  has_more: false,
  oldest_event_id: 1,
  events: [
    ev(1, 'user', { type: 'user', message: { content: 'compare the two options' } }),
    ev(2, 'assistant', { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu-1', name: 'mcp__timon__chat_post_message', input: { text: 'Step one is done, the comparison follows.' } },
    ] } }),
    ev(3, 'assistant', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Step one is done, the comparison follows.' }] }, timon_posted: 'chat_post_message' }),
    ev(4, 'assistant', { type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'tu-2', name: 'mcp__timon_ask__question', input: { message: REPORT, ...QUESTIONS } },
    ] } }),
    ev(5, 'assistant', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: REPORT }] }, timon_posted: 'question' }),
    ev(6, 'permission_request', { id: 'p-ask', tool_name: 'ask_user', input: QUESTIONS, tool_use_id: 'ask_user_1' }),
  ],
  prelude: {
    session_id: 'sess-1', backend: null, model: null, observed_model: null,
    stats: { tok: 0, cost: 0 }, totals: { in: 0, out: 0 }, context_windows: {}, last_context_tokens: 0,
    last_human_text: null, todo_tool_uses: [], events: [],
  },
};

async function chatDom(search: string) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: `http://localhost/chat?${search}`, pretendToBeVisual: true });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
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
  // The deep-link lookup escapes the id; jsdom has no `CSS` global.
  install('CSS', { escape: (value: string) => value });
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const reads: string[] = [];
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) return Response.json({ missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: false }] });
    if (url.startsWith('/api/ui/missions/m1?')) {
      reads.push(url);
      return Response.json(TAIL);
    }
    return Response.json({ modules: [], ui: { hidden: [] }, agents: [], missions: [], items: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { SearchParamsContext, PathnameContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { WidgetHost } = await import('../components/widget-host/widget-host');
  const { ChatClient } = await import('../app/chat/chat-client');
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; compact?: boolean }>;
  const { getLocale, setLocale } = await import('./i18n');
  const locale = getLocale();
  setLocale('en');
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(
      React.createElement(AppRouterContext.Provider, { value: router as never },
        React.createElement(PathnameContext.Provider, { value: '/chat' },
          React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
            React.createElement(WidgetHost, null, React.createElement(Chat, { forcedMission: 'm1', compact: true }))))),
    );
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  await settle();
  return {
    React,
    reads,
    settle,
    text: () => document.body.textContent ?? '',
    card: (id: string) => document.querySelector(`[data-perm-id="${id}"]`),
    async close() {
      await React.act(async () => { root.unmount(); });
      setLocale(locale);
      dom.window.close();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    },
  };
}

const position = (text: string, needle: string): number => {
  const at = text.indexOf(needle);
  assert.ok(at >= 0, `"${needle}" is in the thread`);
  return at;
};

const count = (text: string, needle: string): number => text.split(needle).length - 1;

test('the chip of a posting call leaves its text to the thread', () => {
  assert.deepEqual(chipInput('mcp__timon__chat_post_message', { text: REPORT }), {});
  assert.deepEqual(chipInput('mcp__timon_ask__question', { message: REPORT, ...QUESTIONS }), QUESTIONS);
  assert.deepEqual(chipInput('mcp__timon_ask__kanban_plan', { message: REPORT, chantier: 'X' }), { chantier: 'X' });
  assert.deepEqual(chipInput('mcp__timon_permission__ask_user', { message: REPORT, ...QUESTIONS }), QUESTIONS);
  // Another tool's own `message` / `text` is what it is about: kept.
  assert.deepEqual(chipInput('mcp__timon__agent_send_message', { message: 'hi' }), { message: 'hi' });
  assert.deepEqual(chipInput('mcp__other__chat_post_message', { text: 'hi' }), { text: 'hi' });
});

test('replayed: the posted report is a normal agent bubble, with its table, above the card', async () => {
  const chat = await chatDom('mission=m1');
  try {
    const card = chat.card('p-ask');
    assert.ok(card, 'the form card is in');
    const table = Array.from(document.querySelectorAll('table')).find((t) => /Alpha/.test(t.textContent ?? ''));
    assert.ok(table, 'the markdown table is drawn as a table');
    assert.ok(!card.contains(table), 'the report is not inside the card');
    assert.doesNotMatch(card.textContent ?? '', /comparison you need/);
    // Document order: the report comes before the card.
    assert.ok(table.compareDocumentPosition(card) & 4, 'the card follows the report');
    const text = chat.text();
    assert.equal(count(text, 'comparison you need'), 1, 'the report is drawn once');
    assert.equal(count(text, 'Step one is done'), 1, 'and so is the step report');
    assert.ok(position(text, 'Step one is done') < position(text, 'comparison you need'));
  } finally {
    await chat.close();
  }
});
