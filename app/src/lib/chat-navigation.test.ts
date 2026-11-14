/**
 * Switching chats reloaded the app (agents graph, node menu, widgets' bare
 * `<a>`) or asked the server for a `force-dynamic` page it renders the same
 * (`<Link>` from a chat to a chat). What this locks: chat to chat is a
 * `history.pushState`, anything else a router push, never a page load; and
 * the next mission's log is read once, while the previous one is on screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { chatNavigationMode, openChat } from '@/lib/chat-navigation';
import {
  chatMissionWait,
  chatSwitchMission,
  missionDetailUrl,
  preloadChatMission,
  resetChatMissionPreloads,
  takePreloadedChatMission,
} from '@/lib/chat-mission-preload';

const HERE = 'http://localhost:3101';

test('chat to chat goes through history, anything else through the router', () => {
  assert.equal(chatNavigationMode('/chat?agent=B', `${HERE}/chat?agent=A`), 'history');
  assert.equal(chatNavigationMode('/chat?agent=A&mission=m2', `${HERE}/chat?agent=A&mission=m1`), 'history');
  assert.equal(chatNavigationMode('/chat?agent=A', `${HERE}/agents`), 'router');
  assert.equal(chatNavigationMode('/kanban', `${HERE}/chat?agent=A`), 'router');
  assert.equal(chatNavigationMode('/multichat', `${HERE}/chat?agent=A`), 'router');
  assert.equal(chatNavigationMode('https://elsewhere.example/chat?agent=A', `${HERE}/chat?agent=B`), 'router');
});

test('the conversation already on screen is not pushed again', () => {
  assert.equal(chatNavigationMode('/chat?agent=A&mission=m1', `${HERE}/chat?agent=A&mission=m1`), 'none');
  // The chat pins its mission in the address bar without telling the router:
  // the live URL decides, not what `useSearchParams` last saw.
  assert.equal(chatNavigationMode('/chat?agent=A', `${HERE}/chat?agent=A&mission=m1`), 'history');
});

async function withWindow<T>(url: string, run: (pushed: string[], routed: string[]) => Promise<T> | T): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url });
  const pushed: string[] = [];
  const original = dom.window.history.pushState.bind(dom.window.history);
  dom.window.history.pushState = (data: unknown, unused: string, next?: string | URL | null) => {
    if (next) pushed.push(String(next));
    original(data, unused, next);
  };
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  install('self', dom.window);
  install('fetch', async () => Response.json({ id: 'm', events: [] }));
  const routed: string[] = [];
  try {
    return await run(pushed, routed);
  } finally {
    dom.window.close();
    resetChatMissionPreloads();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

test('openChat pushes history from a chat, the router from elsewhere, nothing in place', async () => {
  await withWindow(`${HERE}/chat?agent=A`, (pushed, routed) => {
    const router = { push: (href: string) => { routed.push(href); } };
    openChat('/chat?agent=B&mission=m2', router);
    assert.deepEqual(pushed, ['/chat?agent=B&mission=m2']);
    assert.deepEqual(routed, []);
    assert.equal(window.location.search, '?agent=B&mission=m2');
    openChat('/chat?agent=B&mission=m2', router);
    assert.equal(pushed.length, 1, 'the same conversation is not pushed twice');
    openChat('/kanban', router);
    assert.deepEqual(routed, ['/kanban']);
  });
  await withWindow(`${HERE}/agents`, (pushed, routed) => {
    openChat('/chat?agent=A', { push: (href) => { routed.push(href); } });
    assert.deepEqual(pushed, []);
    assert.deepEqual(routed, ['/chat?agent=A']);
  });
});

test('opening a mission reads its log ahead, and the chat takes that read once', async () => {
  await withWindow(`${HERE}/chat?agent=A`, async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({ id: 'm2', events: [{ type: 'user' }] });
    };
    openChat('/chat?agent=B&mission=m2', { push() {} });
    const logReads = () => calls.filter((url) => url.startsWith('/api/ui/missions/'));
    assert.deepEqual(logReads(), [missionDetailUrl('m2')]);
    // The route asking again while the read is in flight does not fetch twice.
    preloadChatMission('m2');
    assert.equal(logReads().length, 1);
    const taken = takePreloadedChatMission('m2');
    assert.ok(taken);
    const response = await taken;
    assert.equal(response.ok, true);
    assert.deepEqual(await response.json(), { id: 'm2', events: [{ type: 'user' }] });
    assert.equal(takePreloadedChatMission('m2'), null, 'handed out once');
  });
});

test('opening another agent\'s chat resolves its workspace on the click', async () => {
  await withWindow(`${HERE}/chat?agent=A`, async () => {
    const calls: string[] = [];
    globalThis.fetch = async (input: string | URL | Request) => {
      calls.push(String(input));
      return Response.json({});
    };
    openChat('/chat?agent=Elsewhere', { push() {} });
    // Its project decides the layout the screen takes: asked before the
    // route re-renders, not after it committed an unresolved workspace.
    assert.ok(calls.includes('/api/ui/auth/me'));
    assert.ok(calls.includes('/api/ui/agents/Elsewhere'));
  });
});

test('a switch waits for the log, never past its budget', async () => {
  resetChatMissionPreloads();
  let release: (r: Response) => void = () => {};
  preloadChatMission('slow', { fetcher: () => new Promise<Response>((resolve) => { release = resolve; }), budgetMs: 20 });
  const wait = chatMissionWait('slow');
  assert.ok(wait, 'the switch suspends while the log is on its way');
  await wait;
  assert.equal(chatMissionWait('slow'), null, 'the budget is spent: the next conversation shows');
  release(Response.json({}));
  preloadChatMission('fast', { fetcher: async () => Response.json({ id: 'fast' }), budgetMs: 10_000 });
  await chatMissionWait('fast');
  assert.equal(chatMissionWait('fast'), null);
  assert.equal(chatMissionWait('never-preloaded'), null);
  resetChatMissionPreloads();
});

test('a failed read is reported by the chat that takes it, not by the wait', async () => {
  resetChatMissionPreloads();
  preloadChatMission('gone', { fetcher: async () => { throw new TypeError('network'); } });
  await chatMissionWait('gone');
  const taken = takePreloadedChatMission('gone');
  assert.ok(taken);
  await assert.rejects(taken, TypeError);
  preloadChatMission('missing', { fetcher: async () => Response.json({ error: 'not found' }, { status: 404 }) });
  assert.equal((await takePreloadedChatMission('missing'))!.status, 404);
});

test('a preload nobody took goes stale', () => {
  resetChatMissionPreloads();
  preloadChatMission('old', { fetcher: async () => Response.json({}), now: 1_000 });
  assert.equal(takePreloadedChatMission('old', 1_000 + 60_000), null);
});

test('only a switch between two conversations waits for the next one', () => {
  assert.equal(chatSwitchMission(null, 'A:m1', 'm1'), null, 'the first opening shows at once');
  assert.equal(chatSwitchMission('A:m1', 'A:m1', 'm1'), null);
  assert.equal(chatSwitchMission('A:m1', 'B:', ''), null, 'an agent-only switch has nothing to read ahead');
  assert.equal(chatSwitchMission('A:m1', 'B:m2', 'm2'), 'm2');
});

async function clickChatLink(url: string, href: string, init: MouseEventInit = {}): Promise<{ pushed: string[]; routed: string[] }> {
  return withWindow(url, async (pushed, routed) => {
    const React = await import('react');
    const { createRoot } = await import('react-dom/client');
    const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
    // Plain Node resolves `next/link` to the implementation that reads this
    // context (the build aliases the App Router's, which needs the bundler to
    // load); Next 14 shipped one link that read either. Both carry the router.
    const { RouterContext } = await import('next/dist/shared/lib/router-context.shared-runtime');
    const { ChatLink } = await import('@/components/chat/chat-link');
    // The tests compile JSX to `React.createElement`.
    const saved = new Map(['IS_REACT_ACT_ENVIRONMENT', 'React'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true, writable: true });
    Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });
    const router = {
      back() {}, forward() {}, refresh() {}, prefetch() {}, replace() {},
      push(path: string) { routed.push(path); },
    };
    const root = createRoot(document.getElementById('root')!);
    try {
      await React.act(async () => {
        root.render(React.createElement(AppRouterContext.Provider, { value: router },
          React.createElement(RouterContext.Provider, { value: router as never },
            React.createElement(ChatLink, { href }, 'open'))));
      });
      const anchor = document.querySelector('a')!;
      assert.equal(anchor.getAttribute('href'), href, 'still a real link for a new tab or a drag');
      await React.act(async () => {
        anchor.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }));
      });
      return { pushed: [...pushed], routed: [...routed] };
    } finally {
      await React.act(async () => root.unmount());
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete (globalThis as Record<string, unknown>)[key];
      }
    }
  });
}

test('a chat link from a chat pushes history, never the router (no RSC request)', async () => {
  const { pushed, routed } = await clickChatLink(`${HERE}/chat?agent=A`, '/chat?agent=B&mission=m2');
  assert.deepEqual(pushed, ['/chat?agent=B&mission=m2']);
  assert.deepEqual(routed, []);
});

test('a chat link from another page is a router navigation, not a page load', async () => {
  const { pushed, routed } = await clickChatLink(`${HERE}/agents`, '/chat?agent=B');
  assert.deepEqual(pushed, []);
  assert.deepEqual(routed, ['/chat?agent=B']);
});

test('Ctrl+click on a chat link is left to the browser', async () => {
  const { pushed, routed } = await clickChatLink(`${HERE}/chat?agent=A`, '/chat?agent=B', { ctrlKey: true });
  assert.deepEqual(pushed, []);
  assert.deepEqual(routed, []);
});
