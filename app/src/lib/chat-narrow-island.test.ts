/**
 * A chat in a slim or middling island on a wide screen.
 *
 * The thread's gutters and the bubbles' avatar grid used to follow the
 * WINDOW (`md:`/`lg:`/`sm:`): a 420px island on a desktop kept 24px margins on
 * top of the composer's, a scrollbar far inside the input's edge and 150px
 * bubbles beside their avatar; a 760px one still got the 24px of `lg:`. The
 * width that decides is the island's, measured by the chat itself. jsdom loads
 * no stylesheet, so the margin is read from the column's `--chat-pad` classes
 * as a desktop window would apply them (the widest breakpoint wins), and "same
 * margin" is proven structurally: one variable on the column, read by the
 * thread and by the composer alike.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Rendered {
  text: string;
  avatarGrids: number;
  /** The `--chat-pad` a desktop window applies, in px. */
  chatPad: number;
  scrollerPad: boolean;
  composerPad: boolean;
}

/** The `[--chat-pad:Npx]` of the widest breakpoint present: what `lg:` and up resolve to. */
function desktopPad(classes: string): number {
  const rank = { '': 0, 'md:': 1, 'lg:': 2 } as const;
  let best = { rank: -1, px: Number.NaN };
  for (const m of classes.matchAll(/(?:^|\s)(md:|lg:)?\[--chat-pad:(\d+)px\]/g)) {
    const r = rank[(m[1] ?? '') as keyof typeof rank];
    if (r > best.rank) best = { rank: r, px: Number(m[2]) };
  }
  return best.px;
}

async function renderChatAt(width: number): Promise<Rendered> {
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
  // A desktop window: no media query matches the mobile ones.
  install('matchMedia', () => ({
    matches: false,
    addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // The island's width, as the chat measures it on mount. No ResizeObserver
  // in jsdom: this first read is the only one.
  dom.window.HTMLElement.prototype.getBoundingClientRect = () => ({
    width, height: 800, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 800, toJSON() {},
  });

  const MISSION = {
    running: false,
    turn_active: false,
    events: [
      { type: 'user', timestamp: 1, payload: { type: 'user', message: { content: 'salut' } } },
      {
        type: 'assistant',
        timestamp: 2,
        payload: { type: 'assistant', message: { content: [{ type: 'text', text: 'bonjour à toi' }] } },
      },
    ],
  };
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions?')) {
      return Response.json({
        missions: [{ id: 'm1', agent: 'a', started_at: 1, last_event_at: 2, running: false }],
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
  const Chat = ChatClient as React.FunctionComponent<{ forcedMission?: string; inIsland?: boolean }>;
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
                React.createElement(Chat, { forcedMission: 'm1', inIsland: true }))))),
      );
    });
    // `className` is an object on SVG icons: read the attribute.
    const all = Array.from(document.querySelectorAll<HTMLElement>('[class]'));
    const cls = (el: Element | undefined) => el?.getAttribute('class') ?? '';
    const column = Array.from(document.querySelectorAll<HTMLElement>('[style]'))
      .find((el) => el.style.getPropertyValue('--chat-col') !== '');
    const scroller = all.find((el) => el.classList.contains('scrollbar-hover'));
    const composer = all.find((el) => el.classList.contains('shrink-0') && el.classList.contains('bg-transparent'));
    return {
      text: document.body.textContent ?? '',
      avatarGrids: all.filter((el) => cls(el).includes('sm:grid-cols-[34px')).length,
      chatPad: desktopPad(cls(column)),
      scrollerPad: Boolean(scroller?.classList.contains('sm:px-[max(6px,var(--chat-pad))]')),
      composerPad: cls(composer).includes('px-[var(--chat-pad'),
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

test('a slim island on a desktop window: compact bubbles, one margin for thread and composer', async () => {
  const narrow = await renderChatAt(420);
  assert.match(narrow.text, /salut/, 'the thread must be rendered');
  assert.match(narrow.text, /bonjour à toi/);
  assert.equal(narrow.avatarGrids, 0, 'no avatar grid in a 420px island, whatever the window');
  assert.equal(narrow.chatPad, 0, 'columns folded into panels: no margin, the composer edge to edge');
  assert.ok(narrow.scrollerPad, 'the thread reads the column margin');
  assert.ok(narrow.composerPad, 'the composer reads the same margin');
});

test('a middling island on a desktop window: columns folded, no margin, thread and composer alike', async () => {
  const middling = await renderChatAt(760);
  assert.match(middling.text, /bonjour à toi/, 'the thread must be rendered');
  assert.ok(middling.avatarGrids > 0, 'above the phone width, bubbles keep their avatar grid');
  assert.equal(middling.chatPad, 0, 'a 760px island folds its columns: no margin, not lg\'s 24px');
  assert.ok(middling.scrollerPad, 'the thread reads the column margin');
  assert.ok(middling.composerPad, 'the composer reads the same margin');
});

test('a wide island keeps the desktop bubbles and the 24px margin', async () => {
  const wide = await renderChatAt(1400);
  assert.match(wide.text, /bonjour à toi/, 'the thread must be rendered');
  assert.ok(wide.avatarGrids > 0, 'bubbles keep their avatar grid');
  assert.equal(wide.chatPad, 24, 'room to spare: the full viewport steps apply');
  assert.ok(wide.scrollerPad && wide.composerPad);
});
