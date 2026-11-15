/**
 * « Forgot password? » (docs/EMAIL-CODE-UI.md): the address → the code → the
 * new password twice → done; a wrong code learnt with the password goes back
 * to the code with its tries left; the offline way is always recalled; and a
 * refusal of the daemon is said, its wait counted down.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Reply = { status: number; body: unknown } | 'network';

async function mount(ctx: TestContext, replies: Record<string, Reply[]>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/login', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  install('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    // The page's mascot reads the account's mascot style; with no session the daemon refuses it.
    if (url.startsWith('/api/ui/layout')) return new Response('{}', { status: 401 });
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
  const { PasswordReset } = await import('./password-reset');
  const closed: string[] = [];
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(PasswordReset, { initialEmail: 'ada@example.com', onClose: (email: string) => { closed.push(email); } })); });
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
    doc, calls, fill, press, button, closed,
    text: () => doc.body.textContent ?? '',
    status: () => doc.querySelector('[data-reset-status]')?.textContent ?? '',
    submit: () => doc.querySelector('button[type="submit"]') as HTMLButtonElement | null,
    code: () => doc.querySelector('input[autocomplete="one-time-code"]'),
    passwords: () => Array.from(doc.querySelectorAll('input[autocomplete="new-password"]')),
  };
}

test('ask → code → new password twice → done, and the offline way is recalled', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/password-reset': [{ status: 202, body: { challengeId: 'r1', expiresAt: Date.now() + 600_000, resendAt: Date.now() + 60_000 } }],
    '/api/ui/auth/password-reset/confirm': [{ status: 200, body: { ok: true } }],
  });
  assert.match(w.text(), /Reset your password/);
  assert.match(w.doc.querySelector('[data-reset-fallback]')?.textContent ?? '', /type timon user reset-password in a terminal/);
  assert.equal(w.doc.querySelector('[data-reset-fallback] code')?.textContent, 'timon user reset-password');
  assert.equal((w.doc.querySelector('input[type="email"]') as HTMLInputElement).value, 'ada@example.com', 'the address typed on the login');

  await w.press(w.submit());
  assert.deepEqual(w.calls[0], { url: '/api/ui/auth/password-reset', body: { email: 'ada@example.com', locale: 'en' } });
  assert.match(w.text(), /If an account here uses ada@example\.com and that address was confirmed/);

  await w.fill(w.code(), '123456');
  assert.match(w.text(), /Choose a new password/);
  assert.equal(w.calls.length, 1, 'the code is checked with the new password, not before');
  const [password, confirm] = w.passwords();
  await w.fill(password!, 'bbbbbbbb');
  await w.fill(confirm!, 'bbbbbbbc');
  assert.equal(w.status(), 'The two passwords don\'t match.');
  assert.equal(w.submit()?.disabled, true);
  await w.fill(confirm!, 'bbbbbbbb');
  await w.press(w.submit());
  assert.deepEqual(w.calls[1], { url: '/api/ui/auth/password-reset/confirm', body: { challengeId: 'r1', code: '123456', password: 'bbbbbbbb' } });
  assert.match(w.text(), /Password changed\. You can sign in\./);
  await w.press(w.button('Sign in'));
  assert.deepEqual(w.closed, ['ada@example.com']);
});

test('a wrong code, learnt with the password, brings back the code with its tries left', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/password-reset': [{ status: 202, body: { challengeId: 'r1', resendAt: Date.now() + 60_000 } }],
    '/api/ui/auth/password-reset/confirm': [
      { status: 400, body: { error: 'wrong', code: 'email_code_invalid', params: { attemptsLeft: 2 }, attemptsLeft: 2 } },
      { status: 200, body: { ok: true } },
    ],
  });
  await w.press(w.submit());
  await w.fill(w.code(), '000000');
  const [password, confirm] = w.passwords();
  await w.fill(password!, 'bbbbbbbb');
  await w.fill(confirm!, 'bbbbbbbb');
  await w.press(w.submit());
  assert.ok(w.code(), 'back on the code');
  assert.equal(w.doc.querySelector('[data-email-code-status]')?.textContent, 'Wrong code. 2 attempts left.');
  await w.fill(w.code(), '654321');
  assert.equal(w.passwords().length, 2);
  assert.equal((w.passwords()[0] as HTMLInputElement).value, 'bbbbbbbb', 'the new password is kept');
  await w.press(w.submit());
  assert.equal(w.calls.at(-1)?.body.code, '654321');
  assert.match(w.text(), /Password changed/);
});

test('a wait is counted down, the button held until it ends', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/password-reset': [
      { status: 429, body: { error: 'soon', code: 'email_code_too_soon', params: { seconds: 20 }, retryAfter: 20 } },
    ],
  });
  await w.press(w.submit());
  assert.match(w.status(), /Wait (20|19) seconds before asking for another code\./);
  assert.equal(w.submit()?.disabled, true, 'held until the wait ends');
});

test('without internet or without Timon, the reader reads why', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/password-reset': [
      { status: 503, body: { error: 'offline', code: 'email_connection_required', reason: 'offline' } },
      'network',
    ],
  });
  await w.press(w.submit());
  assert.equal(w.status(), 'An internet connection is needed to confirm the email address.');
  await w.press(w.submit());
  assert.equal(w.status(), 'Timon does not answer. Check that it is running, then try again.');
  await w.press(w.button('Back'));
  assert.deepEqual(w.closed, ['ada@example.com']);
});
