/**
 * The onboarding's account step (docs/EMAIL-CODE-UI.md): what the form lets
 * through, the eye that stays out of Tab and keeps the focus, the code
 * sub-view ("Back" and "Change email" return to the filled form), the
 * account created only by the accepted code, and every refusal of the daemon
 * said — never a silent failure.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Call = { url: string; body: Record<string, unknown> };
type Reply = { status: number; body: unknown } | 'network';

test('the shared checks: matching passwords at the daemon\'s length, no complexity rule, a name even when none is typed', async () => {
  const { accountName, looksLikeEmail, passwordPairReady, passwordProblem, MIN_PASSWORD } = await import('@/components/auth/auth-form');
  assert.equal(MIN_PASSWORD, 8);
  assert.equal(passwordProblem('abcdefgh', ''), null, 'nothing said before the confirmation');
  assert.equal(passwordProblem('abcdefgh', 'abcdefgx'), 'mismatch');
  assert.equal(passwordProblem('abc', 'abc'), 'short');
  assert.equal(passwordPairReady('aaaaaaaa', 'aaaaaaaa'), true, 'no digit, no capital, no symbol required');
  assert.equal(passwordPairReady('aaaaaaa', 'aaaaaaa'), false);
  assert.equal(looksLikeEmail(' ada@example.com '), true);
  assert.equal(looksLikeEmail('ada@example'), false);
  assert.equal(accountName('  Ada ', 'ada@example.com'), 'Ada');
  assert.equal(accountName('', 'ada.l@example.com'), 'ada.l', 'the daemon wants a name: the address before the @');
});

async function mount(ctx: TestContext, replies: Record<string, Reply[]>, me: Record<string, unknown> = { user: null, needsSetup: true }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=account', pretendToBeVisual: true });
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
  install('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  Object.defineProperty(dom.window, 'matchMedia', { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), configurable: true });
  const calls: Call[] = [];
  install('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/auth/me') return new Response(JSON.stringify(me), { status: 200, headers: { 'content-type': 'application/json' } });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ url, body });
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
  const { OnboardingProvider } = await import('../onboarding-context');
  const { AccountStep } = await import('./account');
  let nexts = 0;
  let backHandler: (() => boolean) | null = null;
  const nav = {
    step: 'account' as const, direction: 1 as const,
    next: () => { nexts += 1; }, back: () => {}, goTo: () => {},
    setLanguage: async (tag: string) => tag, skip: () => {}, setOutcome: () => {},
    setBackHandler: (h: (() => boolean) | null) => { backHandler = h; },
  };
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(AccountStep))); });
  await flush();

  const doc = dom.window.document;
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
  const fill = async (field: HTMLInputElement, value: string) => {
    await act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const inputs = () => Array.from(doc.querySelectorAll('form input')) as HTMLInputElement[];
  const submit = () => doc.querySelector('button[type="submit"]') as HTMLButtonElement;
  const status = () => (doc.querySelector('[data-account-status]')?.textContent ?? '');
  const press = async (el: Element | null) => { await act(() => { (el as HTMLElement | null)?.click(); }); await flush(); };
  return {
    doc, calls, fill, inputs, submit, status, press, flush, act,
    nexts: () => nexts,
    back: () => backHandler?.() ?? false,
    fillForm: async (v: { name?: string; email: string; password: string; confirm?: string }) => {
      const [name, email, password, confirm] = inputs();
      if (v.name !== undefined) await fill(name!, v.name);
      await fill(email!, v.email);
      await fill(password!, v.password);
      await fill(confirm!, v.confirm ?? v.password);
    },
    typeCode: async (value: string) => { await fill(doc.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement, value); },
  };
}

test('the form: one column, a disabled button until the address and a matching pair are there, no licence field', async (t) => {
  const w = await mount(t, {});
  const [name, email, password, confirm, extra] = w.inputs();
  assert.equal(extra, undefined, 'four fields, no licence key');
  assert.equal(name?.autocomplete, 'given-name');
  assert.ok(name?.labels?.[0]?.textContent?.includes('First name'));
  assert.ok(!name?.labels?.[0]?.textContent?.includes('*'), 'the first name is optional');
  assert.ok(email?.labels?.[0]?.textContent?.includes('*'), 'the email is required');
  assert.match(w.doc.body.textContent ?? '', /So your agents call you by your first name\./);
  assert.match(w.doc.body.textContent ?? '', /Your email address and its codes go through our server, which emails them to you\. Anonymous usage statistics are shared by default/);
  assert.equal(w.submit().disabled, true);

  await w.fill(email!, 'ada@example.com');
  await w.fill(password!, 'aaaaaaaa');
  await w.fill(confirm!, 'aaaaaaab');
  assert.equal(w.status(), 'The two passwords don\'t match.');
  assert.equal(w.submit().disabled, true);
  await w.fill(confirm!, 'aaaaaaaa');
  assert.equal(w.status(), '');
  assert.equal(w.submit().disabled, false, 'no complexity rule: eight plain letters are enough');
  await w.fill(password!, 'abc');
  await w.fill(confirm!, 'abc');
  assert.equal(w.status(), 'At least 8 characters.');
  assert.equal(w.submit().disabled, true);
});

test('the eye: no text, a label, out of Tab, the field keeps the focus, both fields shown at once', async (t) => {
  const w = await mount(t, {});
  const eyes = Array.from(w.doc.querySelectorAll('[data-password-eye]')) as HTMLButtonElement[];
  assert.equal(eyes.length, 2);
  for (const eye of eyes) {
    assert.equal(eye.tabIndex, -1, 'Tab goes from field to field');
    assert.equal(eye.textContent, '', 'an icon, no text');
    assert.equal(eye.getAttribute('aria-label'), 'Show the password');
  }
  const tabbable = Array.from(w.doc.querySelectorAll('input, button')).filter((el) => (el as HTMLElement).tabIndex >= 0 && !(el as HTMLButtonElement).disabled);
  assert.deepEqual(tabbable.map((el) => (el as HTMLInputElement).autocomplete || el.tagName), ['given-name', 'username', 'new-password', 'new-password'], 'the submit is disabled; the eyes are out');

  const [, , password, confirm] = w.inputs();
  password!.focus();
  const down = new w.doc.defaultView!.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await w.act(() => { eyes[0]!.dispatchEvent(down); });
  assert.equal(down.defaultPrevented, true, 'a mousedown on the eye does not move the focus');
  await w.press(eyes[0]!);
  assert.equal(w.doc.activeElement, password, 'the field keeps the focus');
  assert.equal(password!.type, 'text');
  assert.equal(confirm!.type, 'text', 'one eye shows the pair');
  assert.equal(eyes[1]!.getAttribute('aria-label'), 'Hide the password');
});

test('"Create my account" opens the code; the account is created by the accepted code, with tries left said', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup/email-code': [{ status: 202, body: { challengeId: 'c1', email: 'ada@example.com', expiresAt: Date.now() + 600_000, resendAt: Date.now() + 60_000 } }],
    '/api/ui/auth/setup': [
      { status: 400, body: { error: 'wrong', code: 'email_code_invalid', params: { attemptsLeft: 4 }, attemptsLeft: 4 } },
      { status: 201, body: { user: { id: 'u1' } } },
    ],
  });
  await w.fillForm({ email: ' Ada@Example.com ', password: 'aaaaaaaa' });
  await w.press(w.submit());
  assert.deepEqual(w.calls[0], { url: '/api/ui/auth/setup/email-code', body: { email: 'Ada@Example.com', locale: 'en' } });
  assert.match(w.doc.body.textContent ?? '', /We sent a code to Ada@Example\.com\./);
  assert.ok(!w.calls.some((c) => c.url === '/api/ui/auth/setup'), 'no account before the code');

  await w.typeCode('111111');
  assert.equal(w.calls[1]?.url, '/api/ui/auth/setup');
  assert.equal(w.calls[1]?.body.challengeId, 'c1');
  assert.equal(w.calls[1]?.body.code, '111111');
  assert.equal(w.calls[1]?.body.name, 'Ada', 'no first name typed: the part before the @');
  assert.equal(w.calls[1]?.body.password, 'aaaaaaaa');
  assert.equal(w.calls[1]?.body.licenseKey, undefined);
  assert.equal(w.calls[1]?.body.scheme, 'dark', 'nothing picked on the switch: the OS scheme');
  assert.match(w.doc.body.textContent ?? '', /Wrong code\. 4 attempts left\./);
  assert.equal(w.nexts(), 0);

  // Picked on the onboarding's switch: the account takes it.
  window.sessionStorage.setItem('timon-onboarding-scheme', 'light');
  await w.typeCode('222222');
  assert.equal(w.calls[2]?.body.scheme, 'light', 'the switch wins over the OS');
  assert.match(w.doc.body.textContent ?? '', /Email confirmed/);
  await w.act(async () => { await new Promise((r) => setTimeout(r, 950)); });
  assert.equal(w.nexts(), 1, 'the next step once confirmed');
});

test('"Back" and "Change email" return to the form as it was filled', async (t) => {
  const challenge = () => ({ status: 202, body: { challengeId: 'c1', resendAt: Date.now() + 60_000 } });
  const w = await mount(t, { '/api/ui/auth/setup/email-code': [challenge(), challenge()] });
  await w.fillForm({ name: 'Ada', email: 'ada@example.com', password: 'aaaaaaaa' });
  assert.equal(w.back(), false, 'on the form, "Back" leaves the step');
  await w.press(w.submit());
  assert.ok(w.doc.querySelector('[data-email-code-boxes]'));
  await w.act(() => { assert.equal(w.back(), true, 'on the code, "Back" stays in the step'); });
  await w.flush();
  assert.deepEqual(w.inputs().map((i) => i.value), ['Ada', 'ada@example.com', 'aaaaaaaa', 'aaaaaaaa']);

  await w.press(w.submit());
  const change = Array.from(w.doc.querySelectorAll('button')).find((b) => b.textContent?.includes('Change email'));
  await w.press(change ?? null);
  assert.deepEqual(w.inputs().map((i) => i.value), ['Ada', 'ada@example.com', 'aaaaaaaa', 'aaaaaaaa']);
});

test('the daemon\'s refusals are said, a wait counted down and the button held until it ends', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup/email-code': [
      { status: 429, body: { error: 'limited', code: 'email_code_origin_limited', params: { seconds: 42 }, retryAfter: 42 } },
    ],
  });
  await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
  await w.press(w.submit());
  assert.match(w.status(), /Too many codes were requested from this network\. Try again in (42|41) seconds\./);
  assert.equal(w.submit().disabled, true, 'held for the wait');
  assert.ok(!w.doc.querySelector('[data-email-code-boxes]'), 'still on the form');
});

test('no internet, the email service down, no answer at all: a sentence each, never a silent failure', async (t) => {
  const w = await mount(t, {
    '/api/ui/auth/setup/email-code': [
      { status: 503, body: { error: 'offline', code: 'email_connection_required', reason: 'offline' } },
      { status: 503, body: { error: "Timon's email service is unavailable right now, try again later", code: 'email_service_unavailable', reason: 'mail_unavailable' } },
      'network',
      { status: 403, body: { error: 'setup_token_required' } },
    ],
  });
  await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
  const offline = () => w.doc.querySelector('[data-account-offline] code')?.textContent ?? null;
  await w.press(w.submit());
  assert.equal(w.status(), 'An internet connection is needed to confirm the email address.');
  assert.equal(offline(), 'timon user create-admin', 'offline: the terminal command to make the account without the code');
  await w.press(w.submit());
  assert.equal(w.status(), "Timon's email service is unavailable right now. Try again in a few minutes.", 'the relay down is not a connection problem');
  assert.equal(offline(), 'timon user create-admin', 'the relay down: the same way out');
  await w.press(w.submit());
  assert.equal(w.status(), 'Timon does not answer. Check that it is running, then try again.');
  assert.equal(offline(), null, 'the daemon out of reach: a terminal command would not help');
  await w.press(w.submit());
  assert.equal(w.status(), 'Setup token missing or wrong. Run the command below on the server and try again.');
});

test('an exposed install asks for the setup token, and sends it with the code request', async (t) => {
  const w = await mount(t, { '/api/ui/auth/setup/email-code': [{ status: 202, body: { challengeId: 'c1', resendAt: Date.now() + 60_000 } }] }, { user: null, needsSetup: true, setupRequiresToken: true });
  const fields = w.inputs();
  assert.equal(fields.length, 5);
  await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
  assert.equal(w.submit().disabled, true, 'the token is missing');
  await w.fill(fields[4]!, ' tok ');
  await w.press(w.submit());
  assert.equal(w.calls[0]?.body.setupToken, 'tok');
});

/** The licence key left the first-account screen (TODO #865): it is entered from
 *  the profile. Even a daemon pinned to the closed beta gets no field. */
test('no licence field whatever the daemon\'s policy, and its licence refusal is worded', async (t) => {
  for (const setupRequiresLicense of [true, false]) {
    await t.test(`setupRequiresLicense: ${setupRequiresLicense}`, async (st) => {
      const w = await mount(st, {
        '/api/ui/auth/setup/email-code': [{ status: 202, body: { challengeId: 'c1', resendAt: Date.now() + 60_000 } }],
        '/api/ui/auth/setup': [{ status: 400, body: { error: 'license_required' } }],
      }, { user: null, needsSetup: true, setupRequiresLicense });
      assert.equal(w.inputs().length, 4);
      assert.ok(!w.doc.querySelector('#login-license, input[value="free"], input[value="key"]'));
      await w.fillForm({ email: 'ada@example.com', password: 'aaaaaaaa' });
      await w.press(w.submit());
      await w.typeCode('123456');
      const setup = w.calls.find((c) => c.url === '/api/ui/auth/setup');
      assert.equal(setup?.body.licenseKey, undefined);
      assert.equal(setup?.body.licenseMode, undefined);
      assert.equal(w.doc.querySelector('[data-email-code-status]')?.textContent, 'Enter your license key to continue.', 'a refusal worded, never a raw code');
    });
  }
});
