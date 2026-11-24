/**
 * The client half of `@timon/browser-annotations` (TODO #468, reworked by TODO #481): ✎ and its
 * pill, "N annotations · Send" posting the queue as one message of the conversation, the history
 * drawer, the PWA layer with its bubble and pins. Everything it does goes through the plugin's
 * daemon routes or the chrome's `command()`, and only because the half declares `browser:control`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserChrome, BrowserSurface } from '@/components/browser-chrome';
import type { RemoteInput } from '@/lib/native-browser-input';
import type { NativeBrowserStatus } from '@/lib/native-browser';
import type { BundledClientPlugin } from '@/plugins-client/types';
import { waitUntil } from '@/lib/test-wait';

type FetchCall = { url: string; method: string; body: unknown };
type FakeRoute = (call: FetchCall) => Response | undefined;

const ID = 'ba-00000000-0000-4000-8000-000000000001';
const ID2 = 'ba-00000000-0000-4000-8000-000000000002';
const ID3 = 'ba-00000000-0000-4000-8000-000000000003';
/** A draft left from an earlier session: in the history, never in the current queue. */
const OLD = 'ba-00000000-0000-4000-8000-0000000000d0';
const BATCH = 'bab-00000000-0000-4000-8000-0000000000aa';
const JPEG = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAEBAQ==';

const meta = (extra: Record<string, unknown> = {}) => ({
  id: ID, profileId: 'p1', status: 'draft', createdAt: 10, updatedAt: 10, capturedAt: 10, hasThumbnail: true,
  sourceDetected: false, delivery: null, resolvedAt: null, ...extra,
});

const detail = (comment: string, extra: Record<string, unknown> = {}) => ({
  annotation: meta(extra), comment,
  page: {
    url: 'http://localhost:5173/cart', title: 'Cart',
    target: { selector: 'button#checkout', tag: 'button', role: 'button', name: 'Pay', text: 'Pay', id: 'checkout', classes: ['cta'] },
    rect: { x: 20, y: 30, width: 120, height: 30 }, viewport: { width: 800, height: 600 },
  },
  source: { detected: false }, resolution: null,
});

function status(annotation?: Record<string, unknown>, controlled = true): NativeBrowserStatus & { annotation?: unknown } {
  return {
    running: true, profileId: 'p1', tabs: [{ id: 'tab-1', url: 'http://localhost:5173/cart', title: 'Cart' }], activeTabId: 'tab-1',
    width: 800, height: 600, control: { holder: controlled ? 'you' : 'other', kind: 'human' }, ...(annotation ? { annotation } : {}),
  };
}

const idle = { active: false, pending: 0, capturing: 0 };
const annotating = (pending = 0) => ({ active: true, tabId: 'tab-1', pending, capturing: 0 });

type Conversation = { agent: string; mission: string | null; fresh?: boolean };

async function annotationsDom(options: {
  owner: boolean; native?: boolean; remote?: boolean; conversation?: Conversation;
  plugin?: (base: BundledClientPlugin) => BundledClientPlugin; route?: FakeRoute;
  /** Other halves painted in the same browser, mounted after the product's. */
  others?: BundledClientPlugin[];
}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat?agent=a', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement', 'Node', 'Event', 'MouseEvent', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle', 'localStorage']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  // The global stream: the test pushes what the daemon would.
  const streams: Array<{ listeners: Map<string, Set<(event: { data: string }) => void>> }> = [];
  install('EventSource', class {
    static CLOSED = 2;
    readyState = 1;
    listeners = new Map<string, Set<(event: { data: string }) => void>>();
    constructor() { streams.push(this); }
    close() {}
    addEventListener(type: string, listener: (event: { data: string }) => void) { (this.listeners.get(type) ?? this.listeners.set(type, new Set()).get(type)!).add(listener); }
    removeEventListener(type: string, listener: (event: { data: string }) => void) { this.listeners.get(type)?.delete(listener); }
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const slots = await import('@/lib/plugin-host/slots');
  const chromeModule = await import('@/components/browser-chrome');
  const { BrowserRemoteSurface } = await import('@/components/browser-remote-surface');
  const { resetClientPermissionsForTests } = await import('@/lib/plugin-host/plugin-permissions');
  const { resetBrowserAnnotationsForTests } = await import('@/lib/browser-annotations');
  const { resetPendingAttachmentsForTests } = await import('@/lib/pending-attachments');
  const { BROWSER_ANNOTATIONS_POSTED } = await import('@/lib/browser-panel-bus');
  const { mountBundledClients } = await import('@/plugins-client/mount');
  const { browserAnnotationsClient } = await import('@/plugins-client/browser-annotations');
  slots.resetSlotsForTests();
  resetClientPermissionsForTests();
  resetBrowserAnnotationsForTests();
  resetPendingAttachmentsForTests();
  const undeclare = [
    slots.declareSlot(chromeModule.BROWSER_TOOLBAR_SLOT, 'list'), slots.declareSlot(chromeModule.BROWSER_DRAWER_SLOT, 'keyed'),
    slots.declareSlot(chromeModule.BROWSER_SURFACE_SLOT, 'list'),
  ];
  const unmount = mountBundledClients(null, [(options.plugin ?? ((base) => base))(browserAnnotationsClient), ...(options.others ?? [])]);

  const calls: FetchCall[] = [];
  const commands: Array<[string, Record<string, unknown> | undefined]> = [];
  const inputs: RemoteInput[] = [];
  const clipboard: unknown[] = [];
  const posted: unknown[] = [];
  window.addEventListener(BROWSER_ANNOTATIONS_POSTED, (event) => { posted.push((event as CustomEvent).detail); });
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined };
    calls.push(call);
    const answer = options.route?.(call);
    if (answer) return answer;
    if (call.url === '/api/ui/native-browser/p1/annotations') {
      return options.owner ? Response.json({ annotations: [] }) : Response.json({ error: 'Browser profile not found.' }, { status: 404 });
    }
    assert.fail(`unexpected request: ${call.method} ${call.url}`);
  };

  // The surface maps one to one: a window pixel is a page pixel.
  const surface: BrowserSurface = {
    native: options.native === true, blocked: false, viewport: { width: 800, height: 600 },
    toPage: (x, y) => ({ x: Math.floor(x), y: Math.floor(y) }),
    toSurface: (rect) => ({ left: rect.x, top: rect.y, width: rect.width, height: rect.height }),
  };
  // The PWA's real remote surface: what it sends the browser is recorded.
  function Remote() {
    const node = React.useRef<HTMLDivElement>(null);
    const video = React.useRef<HTMLVideoElement>(null);
    React.useLayoutEffect(() => {
      node.current!.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}) });
    }, []);
    return React.createElement(BrowserRemoteSurface, {
      surface: node, video, overlay: false, controlled: true, blocked: false, running: true, viewport: { width: 800, height: 600 },
      screenshot: null, useScreenshot: false, dragTouch: false, sendInput: (value: RemoteInput) => { inputs.push(value); },
      onClipboard: (value: unknown) => { clipboard.push(value); }, children: null,
    });
  }
  let setBrowser: (value: { status: NativeBrowserStatus | null; controlled: boolean }) => void = () => {};
  function Harness() {
    const [browser, set] = React.useState<{ status: NativeBrowserStatus | null; controlled: boolean }>({ status: status(idle), controlled: true });
    const [drawer, setDrawer] = React.useState<string | null>(null);
    setBrowser = set;
    const value = React.useMemo<BrowserChrome>(() => ({
      profileId: 'p1', status: browser.status, controlled: browser.controlled, conversation: options.conversation ?? { agent: 'a', mission: null }, drawer,
      command: async <T,>(action: string, data?: Record<string, unknown>): Promise<T> => {
        commands.push([action, data]);
        return (action === 'annotateHighlight' ? { highlight: { found: true, visible: true, rect: { x: 20, y: 30, width: 120, height: 30 } } } : null) as T;
      },
      openDrawer: (key: string) => { if (slots.slotEntry(chromeModule.BROWSER_DRAWER_SLOT, key)) setDrawer(key); },
      closeDrawer: () => setDrawer(null),
    }), [browser, drawer]);
    return React.createElement(chromeModule.BrowserChromeProvider, { value, children: [
      React.createElement('form', { key: 'bar', 'data-browser-chrome': 'controls' }, React.createElement(chromeModule.BrowserToolbarSlot)),
      options.remote
        ? React.createElement(Remote, { key: 'surface' })
        : React.createElement('div', { key: 'surface', 'data-surface': '', className: 'relative' }, React.createElement(chromeModule.BrowserSurfaceSlot, { value: surface })),
      drawer ? React.createElement('div', { key: 'drawer', className: 'relative' }, React.createElement(chromeModule.BrowserDrawerSlot, { entryKey: drawer, label: 'drawer' })) : null,
    ] });
  }
  const root = createRoot(document.getElementById('root') as HTMLElement);
  await React.act(async () => root.render(React.createElement(Harness)));

  const buttons = () => Array.from(document.querySelectorAll('button'));
  const pointer = (type: string, node: Element, x: number, y: number) => React.act(async () => {
    node.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
  });
  const field = () => document.querySelector<HTMLTextAreaElement>('[data-annotation-bubble] textarea');
  return {
    React, dom, calls, commands, inputs, clipboard, posted, field,
    until: (condition: () => boolean, what: string) => waitUntil(React.act, condition, what),
    browse: (value: { status: NativeBrowserStatus | null; controlled?: boolean }) => React.act(async () => setBrowser({ status: value.status, controlled: value.controlled ?? true })),
    button: (label: string | RegExp) => buttons().find((node) => {
      const name = node.getAttribute('aria-label') ?? node.textContent ?? '';
      return typeof label === 'string' ? name === label || node.textContent === label : label.test(name) || label.test(node.textContent ?? '');
    }),
    click: (node: Element | null | undefined) => React.act(async () => { assert.ok(node, 'the element is on screen'); (node as HTMLElement).click(); }),
    type: (node: HTMLTextAreaElement | null, value: string) => React.act(async () => {
      assert.ok(node, 'the field is on screen');
      Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')?.set?.call(node, value);
      node.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    }),
    key: (node: Element | null, key: string, extra: KeyboardEventInit = {}) => React.act(async () => {
      assert.ok(node, 'the element is on screen');
      node.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...extra }));
    }),
    paste: (node: Element, text: string) => React.act(async () => {
      const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
      node.dispatchEvent(event);
    }),
    /** Something the daemon published on the global stream. */
    stream: (type: string, data: unknown) => React.act(async () => {
      for (const stream of streams) for (const listener of stream.listeners.get(type) ?? []) listener({ data: JSON.stringify(data) });
    }),
    pointer,
    async cleanup() {
      await React.act(async () => root.unmount());
      unmount();
      for (const dispose of undeclare) dispose();
      globalThis.fetch = original;
      for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
      dom.window.close();
    },
  };
}

const saved = (rows: unknown[]) => Response.json({ annotations: rows, refused: 0, thumbnailsDropped: 0 });
const pageCommands = (commands: Array<[string, unknown]>) => commands.filter(([action]) => action !== 'annotateHighlight' && action !== 'annotateUnpin');
const postedAnswer = (ids: string[], missionId = 'm-new', spawned = true) =>
  Response.json({ ok: true, missionId, spawned, batchId: BATCH, annotations: ids.map((id) => meta({ id, status: 'pending' })), images: ids.length });

test('✎ starts annotate mode through the plugin route; the pill shows, and Done stops it', async () => {
  const ui = await annotationsDom({
    owner: true,
    route: (call) => (call.url.endsWith('/p1/annotation/start') ? Response.json({ annotation: annotating() })
      : call.url.endsWith('/p1/annotation/stop') ? saved([]) : undefined),
  });
  try {
    await ui.until(() => !!ui.button('Annotate'), 'the owner to get ✎');
    const annotate = ui.button('Annotate');
    assert.ok(annotate?.closest('[data-browser-chrome="controls"]'), 'in the address bar');
    await ui.click(annotate);
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotation/start')), 'the start route');
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/annotation/start'))?.body, {});

    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-browser-annotating]'), 'the mode pill');
    assert.equal(document.querySelector('[data-browser-annotating]')?.getAttribute('role'), 'status');
    assert.ok(!ui.button('Annotate'), 'no ✎ while annotating');
    await ui.click(ui.button('Done'));
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotation/stop')), 'the stop route');
    assert.deepEqual(ui.commands, [], 'never a raw command');
  } finally { await ui.cleanup(); }
});

test('a pick waiting on the desktop is collected once into the queue: no drawer opens, the chip counts it', async () => {
  let collected = false;
  const ui = await annotationsDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: collected ? [meta()] : [] });
      if (call.url.endsWith('/p1/annotation/collect')) { collected = true; return saved([meta()]); }
      return undefined;
    },
  });
  try {
    await ui.browse({ status: status(annotating(1)) });
    await ui.until(() => document.querySelector('[data-annotation-queue]')?.textContent?.includes('1 annotation') === true, 'the chip');
    assert.equal(ui.calls.filter((call) => call.url.endsWith('/annotation/collect')).length, 1, 'three occupants, one collect');
    assert.ok(!document.querySelector('[data-browser-drawer]'), 'the drawer is no longer on the way');
    // The desktop's bubble queue and the picks collected here are one queue: each id once.
    await ui.browse({ status: status({ ...annotating(0), queued: 3, queuedIds: [ID, ID2, ID3] }) });
    await ui.until(() => document.querySelector('[data-annotation-queue]')?.getAttribute('data-annotation-queue') === '3', 'the bubble\'s queue');
    assert.match(document.querySelector('[data-annotation-queue]')?.textContent ?? '', /3 annotations/);
  } finally { await ui.cleanup(); }
});

test('"N annotations · Send" posts the current queue to the chat\'s conversation: no composer, the pins go, the chat follows', async () => {
  const sent = new Set<string>();
  const ui = await annotationsDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) {
        return Response.json({ annotations: [meta({ id: OLD, createdAt: 1 }), meta(), meta({ id: ID2, createdAt: 11 })]
          .map((row) => (sent.has(row.id) ? { ...row, status: 'pending' } : row)) });
      }
      if (call.url.endsWith('/p1/annotation/collect')) return saved([]);
      if (call.url.endsWith('/p1/annotations/post')) {
        const ids = (call.body as { ids: string[] }).ids;
        for (const id of ids) sent.add(id);
        return postedAnswer(ids);
      }
      return undefined;
    },
  });
  try {
    // An earlier session left a draft: nothing waits until something is queued now.
    await ui.until(() => !!ui.button('Annotation history'), 'the history');
    assert.ok(!document.querySelector('[data-annotation-queue]'), 'an old draft is not the queue');
    await ui.browse({ status: status({ ...annotating(0), queued: 2, queuedIds: [ID, ID2] }) });
    await ui.until(() => document.querySelector('[data-annotation-queue]')?.textContent?.includes('2 annotations') === true, 'the chip');
    const send = ui.button('Send');
    assert.ok(send?.closest('[data-browser-chrome="controls"]'), 'in the address bar');
    await ui.click(send);
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotations/post')), 'the post route');
    const collect = ui.calls.findIndex((call) => call.url.endsWith('/annotation/collect'));
    const post = ui.calls.findIndex((call) => call.url.endsWith('/annotations/post'));
    assert.ok(collect >= 0 && collect < post, 'what waits on the desktop is sealed first');
    assert.deepEqual(ui.calls[post]?.body, { ids: [ID, ID2], agent: 'a' }, 'this queue, in its order; never the old draft');
    await ui.until(() => ui.commands.some(([action]) => action === 'annotateUnpin'), 'the pins taken off the page');
    assert.deepEqual(ui.commands.find(([action]) => action === 'annotateUnpin'), ['annotateUnpin', { ids: [ID, ID2] }]);
    assert.deepEqual(ui.posted, [{ agent: 'a', missionId: 'm-new' }], 'the chat opens the conversation');
    const { listPendingAttachments } = await import('@/lib/pending-attachments');
    const { draftKey } = await import('@/lib/composer-draft');
    assert.deepEqual(listPendingAttachments(draftKey('a')), [], 'nothing waits in the composer');
    assert.ok(!ui.calls.some((call) => call.url.endsWith('/annotations/send')), 'never the composer\'s path');
    await ui.until(() => !document.querySelector('[data-annotation-queue]'), 'the queue is empty');
    await ui.until(() => Array.from(document.querySelectorAll('[role="status"]')).some((node) => node.textContent?.includes('Sent to a')), 'said in the bar');

    // The old draft is sent from the history, by name, on its own.
    await ui.browse({ status: status(idle) });
    await ui.click(ui.button('Annotation history'));
    await ui.until(() => !!document.querySelector(`[data-annotation-row="${OLD}"]`), 'the old draft in the history');
    assert.ok(!document.querySelector(`[data-annotation-row="${ID}"]`)?.closest('li')?.querySelector('[data-annotation-status="draft"]'), 'what was sent is no longer a draft');
    await ui.click(document.querySelector(`[data-annotation-row="${OLD}"]`));
    await ui.until(() => !!ui.button('Send'), 'Send on a draft');
    await ui.click(ui.button('Send'));
    await ui.until(() => ui.calls.filter((call) => call.url.endsWith('/annotations/post')).length === 2, 'the second post');
    assert.deepEqual(ui.calls.filter((call) => call.url.endsWith('/annotations/post'))[1]?.body, { ids: [OLD], agent: 'a' });
  } finally { await ui.cleanup(); }
});

test('Send follows the chat: its mission, or a fresh conversation on "New conversation"', async () => {
  for (const [conversation, expected] of [
    [{ agent: 'a', mission: '6f9c1a52-1111-4222-8333-944455556666' }, { missionId: '6f9c1a52-1111-4222-8333-944455556666' }],
    [{ agent: 'a', mission: null, fresh: true }, { fresh: true }],
  ] as const) {
    const ui = await annotationsDom({
      owner: true, conversation,
      route: (call) => {
        if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: [meta()] });
        if (call.url.endsWith('/p1/annotation/collect')) return saved([]);
        if (call.url.endsWith('/p1/annotations/post')) return postedAnswer([ID]);
        return undefined;
      },
    });
    try {
      await ui.browse({ status: status({ ...idle, queued: 1, queuedIds: [ID] }) });
      await ui.until(() => !!ui.button('Send'), 'the chip');
      await ui.click(ui.button('Send'));
      await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotations/post')), 'the post route');
      assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/annotations/post'))?.body, { ids: [ID], agent: 'a', ...expected });
    } finally { await ui.cleanup(); }
  }
});

test('a turn in progress keeps the queue and says when to send again', async () => {
  const ui = await annotationsDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: [meta()] });
      if (call.url.endsWith('/p1/annotation/collect')) return saved([]);
      if (call.url.endsWith('/p1/annotations/post')) return Response.json({ error: 'a turn is in progress', code: 'turn_in_progress' }, { status: 409 });
      return undefined;
    },
  });
  try {
    await ui.browse({ status: status({ ...idle, queued: 1, queuedIds: [ID] }) });
    await ui.until(() => !!ui.button('Send'), 'the chip');
    await ui.click(ui.button('Send'));
    await ui.until(() => !!document.querySelector('[role="alert"]'), 'the refusal');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /The agent is answering/);
    assert.ok(document.querySelector('[data-annotation-queue]'), 'the queue is still there');
    assert.ok(!ui.commands.some(([action]) => action === 'annotateUnpin'), 'the pins stay');
    assert.deepEqual(ui.posted, []);
  } finally { await ui.cleanup(); }
});

test('a message the desktop\'s bubble posted to a new conversation is followed by the chat; another browser\'s is not', async () => {
  const ui = await annotationsDom({ owner: true, conversation: { agent: 'a', mission: null, fresh: true } });
  try {
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/p1/annotations')), 'the list');
    const card = (profile: string) => ({ presentation: { version: 1, parts: [], attachments: [{ type: 'annotation', batch_id: BATCH, profile_id: profile, items: [
      { id: ID, comment: 'Bigger', url: 'http://localhost:5173/cart', title: 'Cart', selector: null, image: null },
    ] }] } });
    await ui.stream('event', { kind: 'event', missionId: 'm-other', type: 'user', timestamp: 1, payload: { type: 'user', origin: card('p2') } });
    await ui.stream('event', { kind: 'event', missionId: 'm-plain', type: 'user', timestamp: 2, payload: { type: 'user', message: { content: 'hi' } } });
    await ui.stream('event', { kind: 'event', missionId: 'm-bubble', type: 'user', timestamp: 3, payload: { type: 'user', origin: card('p1') } });
    await ui.until(() => ui.posted.length > 0, 'the chat told');
    assert.deepEqual(ui.posted, [{ agent: 'a', missionId: 'm-bubble' }]);
  } finally { await ui.cleanup(); }
});

test('the history lists by page; Show on page highlights the stored selector, Delete takes the pin off the page', async () => {
  let deleted = false;
  const ui = await annotationsDom({
    owner: true,
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: deleted ? [] : [meta({ hasThumbnail: false, status: 'resolved' })] });
      // Showing an element again starts annotate mode when it is off.
      if (call.url.endsWith('/p1/annotation/start')) return Response.json({ annotation: annotating() });
      if (call.url === `/api/ui/native-browser/annotations/${ID}` && call.method === 'DELETE') { deleted = true; return Response.json({ deleted: true }); }
      if (call.url === `/api/ui/native-browser/annotations/${ID}`) {
        return Response.json({ ...detail('Bigger', { hasThumbnail: false, status: 'resolved' }), resolution: { status: 'resolved', summary: 'Done in 1f2e' } });
      }
      return undefined;
    },
  });
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!ui.button('Annotation history'), 'the history entry, while annotating');
    assert.ok(!document.querySelector('[data-annotation-queue]'), 'nothing waits: no chip');
    await ui.browse({ status: status(idle) });
    await ui.until(() => !!ui.button('Annotation history'), 'and once done');
    await ui.click(ui.button('Annotation history'));
    await ui.until(() => document.querySelector(`[data-annotation-row="${ID}"]`)?.textContent?.includes('Bigger') === true, 'the comment in its row');
    assert.equal(document.querySelector('[data-annotation-page]')?.getAttribute('data-annotation-page'), 'Cart', 'grouped by page');
    for (const gone of ['Save', /Send \d/, 'Attach the thumbnails']) assert.ok(!ui.button(gone), `no ${String(gone)} in the history`);
    assert.ok(!document.querySelector('[data-browser-drawer] textarea'), 'no comment is typed here');
    await ui.click(document.querySelector(`[data-annotation-row="${ID}"]`));
    await ui.until(() => document.querySelector('[data-annotation-resolution]')?.textContent?.includes('Done in 1f2e') === true, 'what the agent did');
    await ui.click(ui.button(/Show on page/));
    await ui.until(() => ui.commands.length > 0, 'the highlight command');
    assert.deepEqual(ui.commands, [['annotateHighlight', { selector: 'button#checkout' }]]);
    await ui.until(() => !document.querySelector('[data-browser-drawer]'), 'the drawer closed over the page');

    await ui.click(ui.button('Annotation history'));
    await ui.until(() => !!document.querySelector(`[data-annotation-row="${ID}"]`), 'the list again');
    await ui.click(ui.button('Delete'));
    await ui.until(() => ui.commands.some(([action]) => action === 'annotateUnpin'), 'the pin off the page');
    assert.deepEqual(ui.commands.at(-1), ['annotateUnpin', { ids: [ID] }]);
    assert.ok(ui.calls.some((call) => call.method === 'DELETE'));
  } finally { await ui.cleanup(); }
});

type PwaRecord = { comments: Record<string, string>; deleted: string[]; rects?: Record<string, { x: number; y: number; width: number; height: number } | null> };
const POINTED = { x: 20, y: 30, width: 120, height: 30 };

/** The PWA's picks: a new draft per pick, read back with its element; its pin's element where `rects` says (as pointed by default). */
function pwaRoutes(record: PwaRecord) {
  let picks = 0;
  return (call: FetchCall): Response | undefined => {
    const body = call.body as { preview?: boolean; comment?: string } | undefined;
    if (call.url.endsWith('/p1/annotation/pins')) {
      const ids = (call.body as { ids: string[] }).ids;
      return Response.json({ pins: ids.map((id) => ({ id, rect: record.rects && id in record.rects ? record.rects[id] : POINTED })) });
    }
    if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: [] });
    if (call.url.endsWith('/p1/annotation/pick') && body?.preview) return Response.json({ hover: { rect: { x: 40, y: 50, width: 60, height: 20 }, tag: 'button' } });
    if (call.url.endsWith('/p1/annotation/pick')) { picks += 1; return saved([meta({ id: picks === 1 ? ID : ID2 })]); }
    if (call.url.endsWith('/p1/annotation/stop')) return saved([]);
    if (call.url.endsWith('/p1/annotations/post')) return postedAnswer((call.body as { ids: string[] }).ids, 'm-1', false);
    for (const id of [ID, ID2]) {
      if (call.url !== `/api/ui/native-browser/annotations/${id}`) continue;
      if (call.method === 'PATCH') { record.comments[id] = body!.comment!; return Response.json({ annotation: meta({ id, updatedAt: 12 }) }); }
      if (call.method === 'DELETE') { record.deleted.push(id); return Response.json({ deleted: true }); }
      return Response.json(detail(record.comments[id] ?? '', { id }));
    }
    return undefined;
  };
}

test('PWA: click, type, Enter, another, Send — one message of the queue, numbered pins, nothing in the page', async () => {
  const record = { comments: {} as Record<string, string>, deleted: [] as string[] };
  const ui = await annotationsDom({ owner: true, route: pwaRoutes(record) });
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-annotation-layer]'), 'the layer over the video');
    const layer = document.querySelector('[data-annotation-layer]')!;
    await ui.pointer('pointermove', layer, 45, 55);
    await ui.until(() => !!document.querySelector('[data-annotation-highlight]'), 'the UI-drawn highlight');
    const box = document.querySelector<HTMLElement>('[data-annotation-highlight]')!;
    assert.deepEqual([box.style.left, box.style.top, box.style.width, box.style.height], ['40px', '50px', '60px', '20px']);
    await ui.pointer('pointerdown', layer, 45, 55);
    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'the bubble of the pick');
    assert.equal(document.querySelector('[data-annotation-bubble]')?.getAttribute('data-annotation-bubble'), 'new');
    assert.equal(document.activeElement, ui.field(), 'the cursor waits in the bubble');
    assert.match(document.querySelector('[data-annotation-bubble]')?.textContent ?? '', /<button> Pay/);
    assert.ok(!document.querySelector('[data-browser-drawer]'), 'no drawer');
    await ui.type(ui.field(), 'Bigger');
    await ui.key(ui.field(), 'Enter');
    await ui.until(() => record.comments[ID] === 'Bigger', 'the comment stored');
    await ui.until(() => !ui.field(), 'Enter closes the bubble');
    await ui.until(() => document.querySelector('[data-annotation-pin="1"]') !== null, 'pin 1 on the element');
    const pin = document.querySelector<HTMLElement>('[data-annotation-pin="1"]')!;
    assert.deepEqual([pin.style.left, pin.style.top], ['10px', '20px'], 'on the element\'s corner');

    await ui.pointer('pointerdown', layer, 300, 200);
    await ui.pointer('pointerup', layer, 300, 200);
    await ui.until(() => !!ui.field(), 'the second bubble');
    await ui.type(ui.field(), 'Red,\nnot blue');
    await ui.click(ui.button('Send (2)'));
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotations/post')), 'the post');
    assert.equal(record.comments[ID2], 'Red,\nnot blue');
    assert.deepEqual(ui.calls.find((call) => call.url.endsWith('/annotations/post'))?.body, { ids: [ID, ID2], agent: 'a' }, 'in the order pointed');
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/annotation/stop')), 'annotate mode ends once sent');
    assert.deepEqual(ui.posted, [{ agent: 'a', missionId: 'm-1' }]);
    assert.deepEqual(pageCommands(ui.commands), [], 'not a key of it reached the page');
  } finally { await ui.cleanup(); }
});

test('PWA: the pins follow their elements as the page scrolls, and leave when the element is out of view or gone', async () => {
  const record: PwaRecord = { comments: {}, deleted: [], rects: {} };
  const ui = await annotationsDom({ owner: true, route: pwaRoutes(record) });
  const pins = () => ui.calls.filter((call) => call.url.endsWith('/p1/annotation/pins'));
  const pin = () => document.querySelector<HTMLElement>('[data-annotation-pin="1"]');
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-annotation-layer]'), 'the layer');
    assert.deepEqual(pins(), [], 'nothing followed before a pick');
    const layer = document.querySelector('[data-annotation-layer]')!;
    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'the bubble');
    // The open bubble's element is followed as soon as it is pointed.
    await ui.until(() => pins().some((call) => JSON.stringify(call.body) === JSON.stringify({ ids: [ID] })), 'its element followed');
    await ui.type(ui.field(), 'Bigger');
    await ui.key(ui.field(), 'Enter');
    await ui.until(() => pin()?.style.top === '20px', 'pin 1 where it was pointed');

    // The page scrolls by 200 px: the pin goes with its element.
    record.rects![ID] = { x: 20, y: 230, width: 120, height: 30 };
    await ui.until(() => pin()?.style.top === '220px', 'the pin moved with the page');
    assert.equal(pin()?.style.left, '10px');
    // Scrolled out of the viewport: no pin stuck at the edge.
    record.rects![ID] = { x: 20, y: -100, width: 120, height: 30 };
    await ui.until(() => !pin(), 'out of view, no pin');
    record.rects![ID] = { x: 20, y: 30, width: 120, height: 30 };
    await ui.until(() => pin()?.style.top === '20px', 'back in view');
    // Gone from the page (re-rendered, removed): no pin either.
    record.rects![ID] = null;
    await ui.until(() => !pin(), 'gone, no pin');

    // Annotate mode ends: the desktop is told to stop following, and nothing is read any more.
    await ui.browse({ status: status(idle) });
    await ui.until(() => JSON.stringify(pins().at(-1)?.body) === JSON.stringify({ ids: [] }), 'following stopped');
    const read = pins().length;
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(pins().length, read, 'no read after the mode ended');
    assert.deepEqual(pageCommands(ui.commands), [], 'following moves nothing on the page');
  } finally { await ui.cleanup(); }
});

test('inViewport: some of the element shows', async () => {
  const { inViewport } = await import('@/plugins-client/browser-annotations');
  const viewport = { width: 800, height: 600 };
  assert.equal(inViewport({ x: 0, y: 0, width: 10, height: 10 }, viewport), true);
  assert.equal(inViewport({ x: 0, y: -9, width: 10, height: 10 }, viewport), true, 'partly above');
  assert.equal(inViewport({ x: 0, y: -10, width: 10, height: 10 }, viewport), false, 'just above');
  assert.equal(inViewport({ x: 0, y: 600, width: 10, height: 10 }, viewport), false, 'just below');
  assert.equal(inViewport({ x: 800, y: 0, width: 10, height: 10 }, viewport), false, 'right of it');
  assert.equal(inViewport({ x: -10, y: 0, width: 10, height: 10 }, viewport), false, 'left of it');
});

test('PWA: Escape cancels a new annotation (its pick is dropped); a pin reopens one to edit or delete', async () => {
  const record = { comments: {} as Record<string, string>, deleted: [] as string[] };
  const ui = await annotationsDom({ owner: true, route: pwaRoutes(record) });
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-annotation-layer]'), 'the layer');
    const layer = document.querySelector('[data-annotation-layer]')!;
    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'the bubble');
    await ui.type(ui.field(), 'never mind');
    await ui.key(ui.field(), 'Escape');
    await ui.until(() => record.deleted.includes(ID), 'the pick dropped');
    assert.ok(!ui.field(), 'closed');
    assert.equal(record.comments[ID], undefined, 'nothing kept');
    assert.deepEqual(ui.calls.filter((call) => call.url.endsWith('/annotations/post')), []);

    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'another bubble');
    await ui.type(ui.field(), 'Line one');
    await ui.key(ui.field(), 'Enter', { shiftKey: true });
    assert.ok(ui.field(), 'Shift+Enter keeps the bubble open');
    await ui.key(ui.field(), 'Enter');
    await ui.until(() => !!document.querySelector('[data-annotation-pin="1"]'), 'its pin');
    await ui.click(document.querySelector('[data-annotation-pin="1"]'));
    await ui.until(() => document.querySelector('[data-annotation-bubble]')?.getAttribute('data-annotation-bubble') === 'edit', 'reopened');
    assert.equal(ui.field()?.value, 'Line one');
    await ui.click(ui.button('Delete'));
    await ui.until(() => record.deleted.includes(ID2), 'deleted');
    await ui.until(() => !document.querySelector('[data-annotation-pin]'), 'its pin gone');

    // No Escape on a phone: the bubble's cross cancels the same way.
    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'a third bubble');
    await ui.type(ui.field(), 'typed on a phone');
    await ui.click(ui.button('Cancel'));
    await ui.until(() => !ui.field(), 'cancelled by touch');
  } finally { await ui.cleanup(); }
});

test('PWA: what is typed in the bubble never reaches the browser — keys, Enter, Escape, paste', async () => {
  const record = { comments: {} as Record<string, string>, deleted: [] as string[] };
  const ui = await annotationsDom({ owner: true, remote: true, route: pwaRoutes(record) });
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-annotation-layer]'), 'the layer over the real surface');
    const layer = document.querySelector('[data-annotation-layer]')!;
    await ui.pointer('pointerdown', layer, 45, 55);
    await ui.pointer('pointerup', layer, 45, 55);
    await ui.until(() => !!ui.field(), 'the bubble');
    for (const key of ['s', 'e', 'c', 'r', 'e', 't', ' ', 'Backspace', 'ArrowLeft', 'Tab', 'Unidentified']) await ui.key(ui.field(), key);
    await ui.key(ui.field(), 'v', { ctrlKey: true });
    await ui.paste(ui.field()!, 'pasted secret');
    for (const button of Array.from(document.querySelectorAll('[data-annotation-bubble] button'))) await ui.pointer('pointerdown', button, 1, 1);
    await ui.type(ui.field(), 'secret words');
    await ui.key(ui.field(), 'Enter');
    await ui.until(() => record.comments[ID] === 'secret words', 'added');
    assert.deepEqual(ui.inputs, [], 'no input command left for the browser');
    assert.deepEqual(ui.clipboard, [], 'no paste reached the page');
    assert.deepEqual(pageCommands(ui.commands), []);
  } finally { await ui.cleanup(); }
});

test('the native view draws its own bubble: no PWA layer under it', async () => {
  const native = await annotationsDom({ owner: true, native: true });
  try {
    await native.browse({ status: status(annotating()) });
    await native.until(() => !!document.querySelector('[data-browser-annotating]'), 'the pill');
    assert.ok(!document.querySelector('[data-annotation-layer]'), 'the native view points and highlights by itself');
  } finally { await native.cleanup(); }
});

test('without browser:control the half reads nothing, sends nothing and starts nothing', async () => {
  const ui = await annotationsDom({
    owner: true,
    plugin: (base) => ({ ...base, permissions: [] }),
    route: (call) => (call.url.endsWith('/p1/annotations') ? Response.json({ annotations: [meta()] }) : undefined),
  });
  try {
    await ui.browse({ status: status({ ...annotating(2), queued: 1, queuedIds: [ID] }) });
    await ui.until(() => !!document.querySelector('[data-browser-annotating]'), 'the pill, from the status every viewer gets');
    assert.ok(!ui.button('Annotate') && !ui.button('Done') && !ui.button('Annotation history') && !ui.button('Send'), 'nothing to act with');
    assert.ok(!document.querySelector('[data-annotation-queue]'), 'no queue read');
    assert.deepEqual(ui.calls, [], 'not even the list was asked');
    assert.deepEqual(ui.commands, []);
    assert.deepEqual(ui.posted, []);
  } finally { await ui.cleanup(); }
});

test('a half that may read but not control lists, cannot start, and its Send names browser:control', async () => {
  const ui = await annotationsDom({
    owner: true,
    plugin: (base) => ({ ...base, permissions: ['browser:annotations:read'] }),
    route: (call) => (call.url.endsWith('/p1/annotations') ? Response.json({ annotations: [meta()] }) : undefined),
  });
  try {
    await ui.until(() => !!ui.button('Annotate'), 'the button, painted');
    assert.equal(ui.button('Annotate')?.disabled, true, 'it cannot start');
    await ui.browse({ status: status({ ...idle, queued: 1, queuedIds: [ID] }) });
    await ui.until(() => !!ui.button('Send'), 'the chip');
    await ui.click(ui.button('Send'));
    await ui.until(() => !!document.querySelector('[role="alert"]'), 'the refusal');
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? '', /browser:control/);
    assert.deepEqual(ui.calls.map((call) => call.url).filter((url) => !url.endsWith('/p1/annotations')), [], 'no route but the list was reached');
    assert.deepEqual(ui.commands, []);
    assert.deepEqual(ui.posted, []);
  } finally { await ui.cleanup(); }
});

/** A third-party occupant of the address bar: shows what `useBrowserAnnotations()` hands it, and tries to read more. */
async function spyPlugin(module: string, permissions: string[]): Promise<BundledClientPlugin> {
  const React = await import('react');
  const { BROWSER_TOOLBAR_SLOT } = await import('@/components/browser-chrome');
  const { useBrowserAnnotations } = await import('@/hooks/use-browser-annotations');
  function Spy() {
    const handle = useBrowserAnnotations();
    const [refused, setRefused] = React.useState<string[]>([]);
    const refuse = (error: unknown) => setRefused((current) => [...current, (error as Error).message]);
    const seen = {
      readable: handle?.readable ?? null, annotations: handle?.annotations.map((row) => row.id) ?? [],
      details: Object.values(handle?.details ?? {}).map((one) => one.comment), selected: handle?.selectedId ?? null,
      queue: handle?.queue ?? 0, queueIds: handle?.queueIds ?? [], refused,
    };
    return React.createElement('div', { 'data-spy': JSON.stringify(seen) },
      React.createElement('button', { type: 'button', onClick: () => { void handle?.refresh().catch(refuse); } }, 'spy refresh'),
      React.createElement('button', { type: 'button', onClick: () => { void handle?.read(ID).catch(refuse); } }, 'spy read'),
      React.createElement('button', { type: 'button', onClick: () => { void handle?.start().catch(refuse); } }, 'spy start'));
  }
  return { module, permissions, apply(ctx) { ctx.register({ slot: BROWSER_TOOLBAR_SLOT }, Spy); } };
}

type Spied = { readable: boolean | null; annotations: string[]; details: string[]; selected: string | null; queue: number; queueIds: string[]; refused: string[] };
const spied = (): Spied => JSON.parse(document.querySelector('[data-spy]')?.getAttribute('data-spy') ?? '{}') as Spied;

/** A pick of this session, as `land()` queues it: this app's queue, which only a reader may see. */
async function queueHere(ui: { React: typeof import('react') }, ids: string[]) {
  const { queueBrowserAnnotations } = await import('@/lib/browser-annotations');
  await ui.React.act(async () => queueBrowserAnnotations('p1', ids));
}

test('an occupant without the permission gets nothing of what the drawer loaded, and its reads are refused', async () => {
  const ui = await annotationsDom({
    owner: true,
    others: [await spyPlugin('acme-spy', [])],
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: [meta()] });
      if (call.url === `/api/ui/native-browser/annotations/${ID}`) return Response.json(detail('Bigger, the page says: secret total 42'));
      return undefined;
    },
  });
  try {
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/p1/annotations')), 'the list asked');
    await queueHere(ui, [ID]);
    await ui.until(() => !!ui.button('1 annotation'), 'the chip');
    await ui.click(ui.button('1 annotation'));
    await ui.until(() => document.querySelector(`[data-annotation-row="${ID}"]`)?.textContent?.includes('Bigger') === true, 'the drawer read the detail');
    await ui.click(document.querySelector(`[data-annotation-row="${ID}"]`));
    await ui.until(() => !!document.querySelector(`[data-annotation-record="${ID}"]`), 'the record open');

    assert.deepEqual(spied(), { readable: false, annotations: [], details: [], selected: null, queue: 0, queueIds: [], refused: [] },
      'the shared state stays out of reach, its queue of drafts included');
    const asked = ui.calls.length;
    await ui.click(ui.button('spy refresh'));
    await ui.click(ui.button('spy read'));
    await ui.until(() => spied().refused.length === 2, 'both reads refused');
    assert.ok(!document.querySelector('[role="alert"]'), 'a refused read is the occupant\'s own, not the product\'s');
    await ui.click(ui.button('spy start'));
    await ui.until(() => spied().refused.length === 3, 'the action refused too');
    const [refresh, read, start] = spied().refused;
    assert.match(refresh!, /acme-spy.*browser:annotations:read.*browser:control/);
    assert.match(read!, /acme-spy.*browser:annotations:read/);
    assert.match(start!, /acme-spy.*browser:control/);
    assert.equal(ui.calls.length, asked, 'no request left for the daemon');
    assert.deepEqual(spied().annotations, [], 'still nothing');
    // The desktop bubble's queue is in the status every viewer gets: that one, and only that one.
    await ui.browse({ status: status({ ...idle, queued: 1, queuedIds: [ID2] }) });
    await ui.until(() => spied().queue === 1, 'the bubble\'s count');
    assert.deepEqual(spied().queueIds, [ID2], 'never this app\'s draft');
  } finally { await ui.cleanup(); }
});

test('an occupant holding browser:annotations:read reads the list and the details, and still cannot act', async () => {
  const ui = await annotationsDom({
    owner: true,
    others: [await spyPlugin('acme-reader', ['browser:annotations:read'])],
    route: (call) => {
      if (call.url.endsWith('/p1/annotations')) return Response.json({ annotations: [meta()] });
      if (call.url === `/api/ui/native-browser/annotations/${ID}`) return Response.json(detail('Bigger'));
      return undefined;
    },
  });
  try {
    await ui.until(() => spied().annotations.length === 1, 'the list');
    assert.equal(spied().readable, true);
    assert.equal(spied().queue, 0, 'a draft of an earlier session is not the queue');
    await queueHere(ui, [ID]);
    await ui.until(() => spied().queue === 1, 'the queue');
    assert.deepEqual(spied().queueIds, [ID]);
    await ui.click(ui.button('spy read'));
    await ui.until(() => spied().details.includes('Bigger'), 'the detail');
    await ui.click(ui.button('spy start'));
    await ui.until(() => spied().refused.length === 1, 'the refusal');
    assert.match(spied().refused[0]!, /acme-reader.*browser:control/);
    assert.ok(!ui.calls.some((call) => call.url.endsWith('/annotation/start')), 'start never reached the daemon');
  } finally { await ui.cleanup(); }
});

test('PWA: a pick that saved several annotations opens the bubble on the latest by date, not the last of the answer', async () => {
  const record = { comments: {} as Record<string, string>, deleted: [] as string[] };
  const routes = pwaRoutes(record);
  const ui = await annotationsDom({
    owner: true,
    route: (call) => {
      // The newest first, as a list is drawn: the last row is the oldest.
      if (call.url.endsWith('/p1/annotation/pick') && !(call.body as { preview?: boolean } | undefined)?.preview) {
        return saved([meta({ id: ID2, createdAt: 20 }), meta({ id: ID, createdAt: 10 })]);
      }
      return routes(call);
    },
  });
  try {
    await ui.browse({ status: status(annotating()) });
    await ui.until(() => !!document.querySelector('[data-annotation-layer]'), 'the layer');
    await ui.pointer('pointerup', document.querySelector('[data-annotation-layer]')!, 45, 55);
    await ui.until(() => !!ui.field(), 'the bubble');
    assert.ok(ui.calls.some((call) => call.url === `/api/ui/native-browser/annotations/${ID2}`), 'the latest is read');
    assert.ok(!ui.calls.some((call) => call.url === `/api/ui/native-browser/annotations/${ID}`), 'the older is not');
    await ui.type(ui.field(), 'On the latest');
    await ui.key(ui.field(), 'Enter');
    await ui.until(() => record.comments[ID2] === 'On the latest', 'the comment on the latest');
    assert.equal(record.comments[ID], undefined);
  } finally { await ui.cleanup(); }
});

test('another viewer sees the mode, never ✎, Done, the queue or the annotations', async () => {
  const ui = await annotationsDom({ owner: false });
  try {
    await ui.until(() => ui.calls.some((call) => call.url.endsWith('/p1/annotations')), 'the list asked');
    await ui.browse({ status: status({ ...annotating(1), queued: 2, queuedIds: [ID, ID2] }) });
    await ui.until(() => !!document.querySelector('[data-browser-annotating]'), 'the pill for every viewer');
    assert.ok(!ui.button('Annotate') && !ui.button('Done') && !ui.button('Annotation history') && !ui.button('Send'));
    assert.ok(!document.querySelector('[data-annotation-queue]'));
    assert.equal(ui.calls.some((call) => call.url.endsWith('/annotation/collect')), false, 'a viewer never collects');
    assert.ok(!document.querySelector('[data-annotation-layer]'));
  } finally { await ui.cleanup(); }
});

// Last: it loads react-dom outside a DOM, and react-dom decides at load whether `input` events exist.
test('a third-party half gets the hooks through `@timon/ui` (client API 13)', async () => {
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  const { useBrowserAnnotations } = await import('@/hooks/use-browser-annotations');
  const { useBrowserSurface } = await import('@/components/browser-chrome');
  const { PLATFORM_MODULE_SOURCES, platformModuleExports } = await import('@/lib/plugin-host/platform-modules');
  assert.equal(UI_KIT.useBrowserAnnotations, useBrowserAnnotations);
  assert.equal(UI_KIT.useBrowserSurface, useBrowserSurface);
  for (const name of ['useBrowserAnnotations', 'useBrowserSurface']) {
    assert.ok(platformModuleExports('ui.js').includes(name));
    assert.match(PLATFORM_MODULE_SOURCES['ui.js']!, new RegExp(`${name}=u\\.${name}`));
  }
});
