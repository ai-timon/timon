/**
 * "Confirm your address" on the profile (docs/EMAIL-CODES.md): one row, one
 * action; the code goes to the account's own address, the code screen opens
 * in a dialog, the right code closes it; a relay that cannot mail is said on
 * the row, and nothing opens.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Reply = { status: number; body: unknown } | 'network';

async function mount(ctx: TestContext, replies: Record<string, Reply[]>, url = 'http://localhost/profile') {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment', 'CustomEvent', 'KeyboardEvent', 'FocusEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  install('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
    const reply = replies[url]?.shift();
    if (!reply) return new Response('{}', { status: 500 });
    if (reply === 'network') throw new TypeError('fetch failed');
    return new Response(JSON.stringify(reply.body), { status: reply.status, headers: { 'content-type': 'application/json' } });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const { ConfirmEmailRow } = await import('./confirm-email-row');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(ConfirmEmailRow, { email: 'member@example.com' })); });
  await flush();
  const doc = dom.window.document;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  const fill = async (field: Element | null, value: string) => {
    await act(() => {
      setter?.call(field, value);
      field?.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const press = async (el: Element | null | undefined) => { await act(() => { (el as HTMLElement | null)?.click(); }); await flush(); };
  const button = (text: string) => Array.from(doc.querySelectorAll('button')).find((b) => b.textContent?.includes(text));
  return {
    doc, calls, fill, press, button,
    /** Lets the "confirmed" state settle (`EmailCodeHost`'s 900 ms) inside React's act. */
    wait: (ms: number) => act(() => new Promise<void>((r) => { setTimeout(r, ms); })),
    row: () => doc.querySelector('[data-confirm-email-row] [role="status"]')?.textContent ?? '',
    code: () => doc.querySelector('input[autocomplete="one-time-code"]'),
  };
}

test('the code goes to the account\'s address, and the right one closes the dialog', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/email-verification': [{ status: 202, body: { challengeId: 'v1', email: 'member@example.com', expiresAt: Date.now() + 600_000, resendAt: Date.now() + 60_000 } }],
    '/api/ui/auth/email-verification/confirm': [
      { status: 400, body: { error: 'wrong', code: 'email_code_invalid', params: { attemptsLeft: 4 }, attemptsLeft: 4 } },
      { status: 200, body: { ok: true } },
    ],
  });
  assert.equal(w.row(), 'Not confirmed yet. Needed to reset your password by email.');
  assert.equal(w.code(), null, 'nothing opens before the code is sent');
  await w.press(w.button('Send the code'));
  assert.deepEqual(w.calls[0], { url: '/api/ui/auth/email-verification', body: { locale: 'en' } });
  assert.match(w.doc.body.textContent ?? '', /We sent a code to member@example\.com/);

  await w.fill(w.code(), '000000');
  assert.deepEqual(w.calls[1], { url: '/api/ui/auth/email-verification/confirm', body: { challengeId: 'v1', code: '000000' } });
  assert.ok(w.code(), 'a wrong code keeps the dialog open');
  await w.fill(w.code(), '123456');
  assert.deepEqual(w.calls[2], { url: '/api/ui/auth/email-verification/confirm', body: { challengeId: 'v1', code: '123456' } });
  await w.wait(1000);
  assert.equal(w.code(), null, 'the dialog closed');
  assert.ok(w.calls.some((c) => c.url.startsWith('/api/ui/auth/me')), 'the account is read again, so the row goes away');
});

test('a relay that cannot mail is said on the row, and nothing opens', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/email-verification': [
      { status: 503, body: { error: 'offline', code: 'email_connection_required', reason: 'offline' } },
      { status: 503, body: { error: 'down', code: 'email_service_unavailable', reason: 'mail_unavailable' } },
    ],
  });
  await w.press(w.button('Send the code'));
  assert.equal(w.row(), 'An internet connection is needed to confirm the email address.');
  await w.press(w.button('Send the code'));
  assert.equal(w.row(), "Timon's email service is unavailable right now. Try again in a few minutes.");
  assert.equal(w.code(), null);
});

test('reached from the bottom-left card, the row takes the focus and sends nothing', async (t) => {
  const w = await mount(t, {}, 'http://localhost/profile#confirm-email');
  assert.equal(w.doc.querySelector('[data-confirm-email-row]')?.id, 'confirm-email');
  assert.equal(w.doc.activeElement, w.button('Send the code'), 'the one action is focused');
  assert.deepEqual(w.calls, [], 'mailing a code stays the person\'s gesture');
});

test('opened plainly, the Profile leaves the focus where it is', async (t) => {
  const w = await mount(t, {});
  assert.notEqual(w.doc.activeElement, w.button('Send the code'));
});
