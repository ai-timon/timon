import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The maintainer's request: the top bar's bell opened the archive page, where a quick look at the
 * recent notifications was wanted. The bell now opens a dropdown — recent
 * list, mark as read, a link to the archive — and the same body is a widget.
 */

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

const NOTIFS = [
  { id: 'n1', type: 'alert', urgent: 1, title: 'CI broken', body: 'build failed', task_id: null, mission_id: 'm1', anchor: null, created_at: Date.now(), agent: 'timon.coder' },
  { id: 'n2', type: 'report', urgent: 0, title: 'Dream ready', body: null, task_id: null, mission_id: null, anchor: null, created_at: Date.now(), agent: null },
];

type Call = { url: string; method: string; body?: string };
type Notif = (typeof NOTIFS)[number];

/** Routed by URL: the feed's settings come from the layout store, the list
 *  from the notification center (which answers per-kind `counts` only when
 *  asked to — the first tests keep the older shape). */
type FakeOpts = {
  notifs?: Notif[];
  prefs?: unknown;
  counts?: boolean;
  withSettings?: boolean;
  withWidget?: boolean;
  /** Every settings read waits here until the test answers it, with the
   *  stored value of its choice. */
  heldReads?: Array<(layout: unknown) => void>;
  /** The next N settings writes are refused. */
  failPuts?: number;
};

function fakeFetch(calls: Call[], opts: FakeOpts = {}) {
  let list = [...(opts.notifs ?? NOTIFS)];
  let stored: unknown = opts.prefs ?? null;
  let failPuts = opts.failPuts ?? 0;
  const counts = () => ({
    action_required: list.filter((n) => n.type === 'action_required').length,
    alert: list.filter((n) => n.type === 'alert').length,
    report: list.filter((n) => n.type === 'report').length,
  });
  return async (input: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url: input, method, body: init?.body });
    if (input.startsWith('/api/ui/layout')) {
      if (method === 'PUT') {
        if (failPuts > 0) { failPuts -= 1; return new Response(null, { status: 500 }); }
        stored = (JSON.parse(init!.body!) as { layout: unknown }).layout;
      } else if (opts.heldReads) {
        const held = opts.heldReads;
        return new Promise<Response>((resolve) => {
          held.push((layout) => resolve(new Response(JSON.stringify({ layout }), { status: 200 })));
        });
      }
      return new Response(JSON.stringify({ layout: stored }), { status: 200 });
    }
    const dismissed = /\/notifications\/([^/]+)\/dismiss$/.exec(input);
    if (dismissed) list = list.filter((n) => n.id !== decodeURIComponent(dismissed[1]!));
    if (input.endsWith('/dismiss-all')) {
      const type = (JSON.parse(init?.body ?? '{}') as { type?: string }).type;
      list = type ? list.filter((n) => n.type !== type) : [];
    }
    const limit = Number(/limit=(\d+)/.exec(input)?.[1] ?? 50);
    return new Response(JSON.stringify({
      notifications: list.slice(0, limit),
      total_active: list.length,
      ...(opts.counts ? { counts: counts() } : {}),
    }), { status: 200 });
  };
}

async function renderBell(
  run: (host: HTMLElement, react: typeof import('react'), calls: Call[]) => Promise<void>,
  opts: FakeOpts = {},
) {
  await withDom(async (_dom, React) => {
    const calls: Call[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(calls, opts) as unknown as typeof fetch;
    // Each test is a fresh document: nothing read by the previous one.
    const { resetNotificationPrefsForTest } = await import('@/hooks/use-notification-prefs');
    const { forgetStoredLayouts } = await import('@/hooks/use-stored-layout');
    resetNotificationPrefsForTest();
    forgetStoredLayouts();
    const { createRoot } = await import('react-dom/client');
    const { NotificationBell } = await import('@/components/notification-bell');
    const { NotificationFeedSettings } = await import('@/plugins-client/notifications/notification-feed-settings');
    const { NotificationsWidget } = await import('@/plugins-client/notifications/notifications-widget');
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(React.Fragment, null,
          React.createElement(NotificationBell),
          opts.withSettings ? React.createElement(NotificationFeedSettings) : null,
          opts.withWidget
            ? React.createElement('div', { 'data-test-widget': '' }, React.createElement(NotificationsWidget, { handle: null }))
            : null));
      });
      await run(host, React, calls);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
    }
  });
}

test('the bell opens a dropdown, not the archive page', async () => {
  await renderBell(async (host, React) => {
    const bell = host.querySelector('button')!;
    assert.equal(bell.tagName, 'BUTTON');
    assert.ok(!host.querySelector('a[href="/notifications"]'));
    assert.equal(bell.getAttribute('aria-expanded'), 'false');
    assert.match(bell.textContent ?? '', /2/);

    await React.act(async () => { bell.click(); });
    assert.equal(bell.getAttribute('aria-expanded'), 'true');
    const panel = document.querySelector('[role="dialog"]')!;
    assert.ok(panel, 'the dropdown is on screen');
    assert.equal(panel.querySelectorAll('[data-notification]').length, 2);
    assert.ok(panel.querySelector('a[href="/notifications"]'), 'a "see all" link to the archive');
    assert.ok(panel.querySelector('a[href="/chat?mission=m1"]'), 'a row links to its mission');

    await React.act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    assert.ok(!document.querySelector('[role="dialog"]'));
    assert.equal(bell.getAttribute('aria-expanded'), 'false');
  });
});

test('marking one notification as read dismisses it, and the badge follows', async () => {
  await renderBell(async (host, React, calls) => {
    const bell = host.querySelector('button')!;
    await React.act(async () => { bell.click(); });
    const read = document.querySelector<HTMLButtonElement>('[data-notification="n1"] button[aria-label="Mark as read"]')!;
    await React.act(async () => { read.click(); });
    assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/ui/notifications/n1/dismiss'));
    assert.equal(document.querySelectorAll('[data-notification]').length, 1);
    assert.doesNotMatch(bell.textContent ?? '', /2/);
  });
});

test('"mark all as read" empties the list', async () => {
  await renderBell(async (host, React, calls) => {
    await React.act(async () => { host.querySelector('button')!.click(); });
    const all = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((b) => /mark all/i.test(b.textContent ?? ''))!;
    assert.ok(all);
    await React.act(async () => { all.click(); });
    assert.ok(calls.some((c) => c.method === 'POST' && c.url === '/api/ui/notifications/dismiss-all'));
    assert.equal(document.querySelectorAll('[data-notification]').length, 0);
  });
});

test('each row says which agent raised it, Timon for its own', async () => {
  await renderBell(async (host, React) => {
    await React.act(async () => { host.querySelector('button')!.click(); });
    const agentOf = (id: string) => document.querySelector(`[data-notification="${id}"] [data-notification-agent]`)?.textContent;
    assert.equal(agentOf('n1'), 'timon.coder');
    assert.equal(agentOf('n2'), 'Timon');
  });
});

/** 10 reports, then 8 alerts, then 2 requests — newest first. */
function mixed(): Notif[] {
  const make = (type: string, i: number) => ({ ...NOTIFS[1]!, id: `${type}-${i}`, type, title: `${type} ${i}`, created_at: Date.now() - i });
  return [
    ...Array.from({ length: 10 }, (_, i) => make('report', i)),
    ...Array.from({ length: 8 }, (_, i) => make('alert', i)),
    ...Array.from({ length: 2 }, (_, i) => make('action_required', i)),
  ];
}

test('the dropdown lists the chosen kinds only, at most the chosen number, the badge counting them', async () => {
  await renderBell(async (host, React, calls) => {
    const bell = host.querySelector('button')!;
    // Alerts and requests: 10 of them, the badge says so — not the 20 active.
    assert.match(bell.getAttribute('aria-label') ?? '', /10/);
    assert.ok(calls.some((c) => c.url === '/api/ui/notifications?limit=200'), 'a filtered feed fetches all the server serves');
    await React.act(async () => { bell.click(); });
    const rows = Array.from(document.querySelectorAll('[data-notification]')).map((r) => r.getAttribute('data-notification'));
    assert.deepEqual(rows, ['alert-0', 'alert-1', 'alert-2', 'alert-3', 'alert-4']);
  }, { notifs: mixed(), counts: true, prefs: { v: 1, types: ['alert', 'action_required'], max: 5 } });
});

test('nothing hidden: the server is asked for the maximum only', async () => {
  await renderBell(async (host, React, calls) => {
    assert.ok(calls.some((c) => c.url === '/api/ui/notifications?limit=40'));
    assert.ok(!calls.some((c) => c.url === '/api/ui/notifications?limit=200'));
    await React.act(async () => { host.querySelector('button')!.click(); });
    assert.equal(document.querySelectorAll('[data-notification]').length, 20);
  }, { notifs: mixed(), counts: true, prefs: { v: 1, types: ['action_required', 'alert', 'report'], max: 40 } });
});

test('"mark all as read" leaves the hidden kinds alone', async () => {
  await renderBell(async (host, React, calls) => {
    await React.act(async () => { host.querySelector('button')!.click(); });
    const all = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'))
      .find((b) => /mark all/i.test(b.textContent ?? ''))!;
    await React.act(async () => { all.click(); });
    const dismissals = calls.filter((c) => c.url === '/api/ui/notifications/dismiss-all').map((c) => c.body);
    assert.deepEqual(dismissals.sort(), ['{"type":"action_required"}', '{"type":"alert"}']);
    assert.equal(document.querySelectorAll('[data-notification]').length, 0);
  }, { notifs: mixed(), counts: true, prefs: { v: 1, types: ['alert', 'action_required'], max: 15 } });
});

test('a hundred rows stay inside the scrolling panel', async () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ ...NOTIFS[0]!, id: `n${i}`, title: `n ${i}` }));
  await renderBell(async (host, React) => {
    await React.act(async () => { host.querySelector('button')!.click(); });
    const list = document.querySelector('[role="dialog"] ul')!;
    assert.equal(list.querySelectorAll('[data-notification]').length, 100);
    // The panel is height-capped and the list is its only scroller.
    assert.equal(document.querySelector<HTMLElement>('[role="dialog"]')!.style.maxHeight, '512px');
    assert.match(list.className, /overflow-y-auto/);
    assert.match(list.className, /min-h-0/);
  }, { notifs: many, counts: true, prefs: { v: 1, types: ['alert', 'action_required', 'report'], max: 100 } });
});

test('the settings of the archive page reach the open bell at once, and are stored', async () => {
  await renderBell(async (host, React, calls) => {
    const bell = host.querySelector('button')!;
    await React.act(async () => { bell.click(); });
    assert.equal(document.querySelectorAll('[data-notification]').length, 15);
    assert.match(bell.getAttribute('aria-label') ?? '', /20/);

    const settings = document.querySelector('[data-notification-feed-settings]')!;
    const report = settings.querySelector<HTMLInputElement>('[data-notification-type="report"]')!;
    await React.act(async () => { report.click(); });
    const rows = Array.from(document.querySelectorAll('[data-notification]')).map((r) => r.getAttribute('data-notification'));
    assert.equal(rows.length, 10);
    assert.ok(rows.every((id) => !id!.startsWith('report')), 'no report left in the open dropdown');
    assert.match(bell.getAttribute('aria-label') ?? '', /10/);
    const put = calls.find((c) => c.method === 'PUT' && c.url === '/api/ui/layout?scope=notifications.feed');
    assert.ok(put, 'stored by the daemon, in the account\'s layout rows');
    assert.deepEqual(JSON.parse(put.body!), { layout: { v: 1, types: ['action_required', 'alert'], max: 15 } });

    // The maximum is committed on blur, clamped, and applies after the filter.
    const max = settings.querySelector<HTMLInputElement>('input[type="number"]')!;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setValue.call(max, '3');
      max.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.equal(document.querySelectorAll('[data-notification]').length, 10, 'nothing applied while typing');
    await React.act(async () => { max.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true })); });
    assert.equal(max.value, '5');
    assert.equal(document.querySelectorAll('[data-notification]').length, 5);
  }, { notifs: mixed(), counts: true, withSettings: true });
});

test('the last kind shown cannot be unticked', async () => {
  await renderBell(async () => {
    const box = (type: string) => document.querySelector<HTMLInputElement>(`[data-notification-feed-settings] [data-notification-type="${type}"]`)!;
    assert.equal(box('alert').checked, true);
    assert.equal(box('alert').disabled, true);
    assert.equal(box('report').checked, false);
    assert.equal(box('report').disabled, false);
  }, { notifs: mixed(), counts: true, withSettings: true, prefs: { v: 1, types: ['alert'], max: 15 } });
});

/** Rows listed by the open dropdown, and by the widget. */
const rowsOf = (selector: string) => Array.from(document.querySelectorAll(`${selector} [data-notification]`))
  .map((r) => r.getAttribute('data-notification')!);

/** Answers every settings read still waiting, then lets the renders settle. */
async function answerReads(react: typeof import('react'), held: Array<(layout: unknown) => void>, layout: unknown) {
  await react.act(async () => {
    for (const answer of held.splice(0)) answer(layout);
  });
}

const EVERY_KIND = { v: 1, types: ['action_required', 'alert', 'report'], max: 15 };

test('a settings read answered after a change never puts the old value back', async () => {
  const held: Array<(layout: unknown) => void> = [];
  await renderBell(async (host, React, calls) => {
    const bell = host.querySelector('button')!;
    // The bell, the widget and the settings mounted together: the first read
    // to come back is the settings' one.
    assert.equal(held.length > 0, true);
    await React.act(async () => { held.shift()!(EVERY_KIND); });
    await React.act(async () => { bell.click(); });
    const report = document.querySelector<HTMLInputElement>('[data-notification-feed-settings] [data-notification-type="report"]')!;
    await React.act(async () => { report.click(); });

    // Any read of the bell or the widget still on the wire now answers with
    // the row as it was before the click.
    await answerReads(React, held, EVERY_KIND);

    assert.equal(report.checked, false, 'the form keeps the change');
    const max = document.querySelector<HTMLInputElement>('[data-notification-feed-settings] input[type="number"]')!;
    assert.equal(max.value, '15');
    assert.equal(rowsOf('[role="dialog"]').length, 10);
    assert.ok(rowsOf('[role="dialog"]').every((id) => !id.startsWith('report')), 'the dropdown stays filtered');
    assert.ok(rowsOf('[data-test-widget]').every((id) => !id.startsWith('report')), 'the widget stays filtered');
    assert.match(bell.getAttribute('aria-label') ?? '', /\b10\b/, 'the badge counts the visible kinds');
    // One store for the document: three surfaces, one read.
    assert.equal(calls.filter((c) => c.method === 'GET' && c.url.startsWith('/api/ui/layout')).length, 1);
  }, { notifs: mixed(), counts: true, withSettings: true, withWidget: true, heldReads: held });
});

test('a read sent before a later change is dropped when it answers', async () => {
  const held: Array<(layout: unknown) => void> = [];
  await renderBell(async (host, React, calls) => {
    await answerReads(React, held, EVERY_KIND);
    const box = (type: string) => document.querySelector<HTMLInputElement>(`[data-notification-feed-settings] [data-notification-type="${type}"]`)!;
    // The write is refused: the store reads the row back to show what is stored…
    await React.act(async () => { box('report').click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assert.equal(held.length, 1, 'a read-back is on the wire');
    // …and a new change is made before that read answers.
    await React.act(async () => { box('alert').click(); });
    await answerReads(React, held, EVERY_KIND);

    assert.equal(box('report').checked, false);
    assert.equal(box('alert').checked, false);
    assert.match(host.querySelector('button')!.getAttribute('aria-label') ?? '', /\b2\b/);
    const puts = calls.filter((c) => c.method === 'PUT').map((c) => JSON.parse(c.body!) as { layout: { types: string[] } });
    assert.deepEqual(puts.at(-1)!.layout.types, ['action_required']);
  }, { notifs: mixed(), counts: true, withSettings: true, heldReads: held, failPuts: 1 });
});

test('another account never sees the previous one\'s settings, even for a moment', async () => {
  const held: Array<(layout: unknown) => void> = [];
  await renderBell(async (host, React) => {
    const { announceAccount } = await import('@/lib/account-change');
    await React.act(async () => { announceAccount('alice'); });
    await answerReads(React, held, { v: 1, types: ['alert'], max: 15 });
    const bell = host.querySelector('button')!;
    assert.match(bell.getAttribute('aria-label') ?? '', /\b8\b/);

    await React.act(async () => { announceAccount('bob'); });
    // Bob's settings are on the wire: nothing of Alice's is shown meanwhile.
    assert.equal(held.length, 1, 'the new account\'s settings are read');
    const box = (type: string) => document.querySelector<HTMLInputElement>(`[data-notification-feed-settings] [data-notification-type="${type}"]`)!;
    assert.equal(box('report').checked, true, 'not Alice\'s ticks');
    assert.equal(document.querySelector('[data-notification-feed-settings] fieldset')!.hasAttribute('disabled'), true);
    assert.doesNotMatch(bell.getAttribute('aria-label') ?? '', /\b8\b/);

    await answerReads(React, held, { v: 1, types: ['report'], max: 15 });
    assert.equal(box('alert').checked, false);
    assert.equal(box('report').checked, true);
    assert.match(bell.getAttribute('aria-label') ?? '', /\b10\b/);
  }, { notifs: mixed(), counts: true, withSettings: true, heldReads: held });
});

test('in a sidebar the bell widget is its button only; the list opens beside it on click', async () => {
  await withDom(async (_dom, React) => {
    const calls: Call[] = [];
    const savedFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch(calls) as unknown as typeof fetch;
    const { resetNotificationPrefsForTest } = await import('@/hooks/use-notification-prefs');
    const { forgetStoredLayouts } = await import('@/hooks/use-stored-layout');
    resetNotificationPrefsForTest();
    forgetStoredLayouts();
    const { createRoot } = await import('react-dom/client');
    const { BellWidget } = await import('@/plugins-client/notifications/bell-widget');
    const host = document.getElementById('root')!;
    const root = createRoot(host);
    const grip = React.createElement('button', { type: 'button', 'data-grip': '' }, 'grip');
    try {
      // A narrow column: the button, its badge and the grip — no list, no card.
      await React.act(async () => {
        root.render(React.createElement(BellWidget, { orientation: 'vertical', compact: true, handle: grip }));
      });
      assert.equal(host.querySelectorAll('[data-notification]').length, 0, 'no list in the rail');
      assert.ok(!host.querySelector('section'), 'no card in the rail');
      assert.ok(host.querySelector('[data-grip]'), 'the grip follows the button');
      const bell = host.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]')!;
      assert.match(bell.getAttribute('aria-label') ?? '', /2/);

      await React.act(async () => { bell.click(); });
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      assert.ok(panel, 'the dropdown opens on click');
      assert.equal(panel.getAttribute('data-side'), 'right', 'next to the rail, not under it');
      assert.equal(panel.querySelectorAll('[data-notification]').length, 2);

      // A wide column (cockpit, chat): the card with its list.
      await React.act(async () => {
        root.render(React.createElement(BellWidget, { orientation: 'vertical', handle: grip }));
      });
      assert.equal(host.querySelectorAll('[data-notification]').length, 2, 'the list as a card');
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
    }
  });
});

test('each row has a Copy button next to "mark as read" that leaves the list alone', async () => {
  await renderBell(async (host, React, calls) => {
    await React.act(async () => { host.querySelector('button')!.click(); });
    const copy = document.querySelector<HTMLButtonElement>('[data-notification="n1"] button[aria-label="Copy"]');
    assert.ok(copy, 'the row has a Copy button');
    await React.act(async () => { copy.click(); });
    assert.equal(calls.some((c) => c.url.includes('/dismiss')), false, 'copying dismisses nothing');
    assert.equal(document.querySelectorAll('[data-notification]').length, 2);
  });
});
