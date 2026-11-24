/**
 * The code screen (docs/EMAIL-CODE-UI.md): the daemon's refusals read in the
 * reader's language with their wait counted down, six digits checked once
 * complete, a wrong code cleared with its tries left, "Resend" closed for
 * 60 s, and the `email.code` slot taken and given back by a plugin.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import type { EmailCodeHostProps } from './email-code';
import type { CodeFailure } from './email-code-failure';

test('a refusal that asks to wait counts its seconds down, then says nothing', async () => {
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { codeFailure, failureText, networkFailure, digitsOnly, clock } = await import('./email-code-failure');
  const now = 1_000_000;
  const limited = codeFailure(429, { error: 'too many', code: 'email_code_origin_limited', params: { seconds: 42 }, retryAfter: 42 }, now);
  assert.equal(limited.retryUntil, now + 42_000);
  assert.equal(failureText(limited, now), 'Too many codes were requested from this network. Try again in 42 seconds.');
  assert.equal(failureText(limited, now + 41_100), 'Too many codes were requested from this network. Try again in 1 second.');
  assert.equal(failureText(limited, now + 42_000), null, 'the wait is over');

  const busy = codeFailure(429, { error: 'busy', code: 'email_code_busy', retryAfter: 600 }, now);
  assert.match(failureText(busy, now) ?? '', /600 seconds/);
  const soon = codeFailure(429, { error: 'soon', code: 'email_code_too_soon', params: { seconds: 12 }, retryAfter: 12 }, now);
  assert.match(failureText(soon, now + 2_000) ?? '', /10 seconds/);

  const wrong = codeFailure(400, { error: 'wrong', code: 'email_code_invalid', params: { attemptsLeft: 3 }, attemptsLeft: 3 }, now);
  assert.equal(wrong.attemptsLeft, 3);
  assert.equal(wrong.retryUntil, null);
  assert.equal(failureText(wrong, now + 999_999), 'Wrong code. 3 attempts left.', 'no wait: the sentence stays');

  const offline = codeFailure(503, { error: 'offline', code: 'email_connection_required', reason: 'offline' }, now);
  assert.equal(offline.message, 'An internet connection is needed to confirm the email address.');
  assert.equal(networkFailure().message, 'Timon does not answer. Check that it is running, then try again.');
  assert.equal(codeFailure(502, null, now).message, 'HTTP 502', 'no body: the status, never a silent failure');
  assert.equal(codeFailure(403, { error: 'setup_token_required' }, now, () => 'token!').message, 'token!', 'an uncoded refusal goes to the fallback');

  assert.equal(digitsOnly(' 12 34-56 7'), '123456');
  assert.equal(clock(60), '1:00');
  assert.equal(clock(9), '0:09');
});

test('a throttled request that only says its delay in Retry-After still counts it down', async () => {
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { failureText, retryAfterSeconds } = await import('./email-code-failure');
  const { createAccount, requestSetupCode } = await import('./email-code-api');
  // `sendThrottled`: the shared `too_many_attempts` body, the delay in the header alone.
  const throttled: typeof fetch = async () => new Response(
    JSON.stringify({ error: 'too many attempts, try again later', code: 'too_many_attempts' }),
    { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '37' } },
  );
  const asked = await requestSetupCode({ email: 'a@b.c' }, throttled);
  assert.equal(asked.ok, false);
  if (asked.ok) return;
  const now = Date.now();
  assert.ok(asked.failure.retryUntil !== null, 'a wait, not a dead end');
  assert.match(failureText(asked.failure, now) ?? '', /^Too many attempts\. Try again in 3[67] seconds\.$/);
  assert.equal(failureText(asked.failure, now + 40_000), null, 'gone once the wait is over');

  const made = await createAccount({ email: 'a@b.c', name: 'A', password: 'x'.repeat(12), challengeId: 'c', code: '123456' }, throttled);
  assert.equal(made.ok, false);
  if (!made.ok) assert.ok(made.failure.retryUntil !== null);

  // The body wins when it says it; no header and no body delay: the plain sentence, no countdown.
  const both: typeof fetch = async () => new Response(
    JSON.stringify({ error: 'soon', code: 'email_code_too_soon', retryAfter: 5 }),
    { status: 429, headers: { 'retry-after': '50' } },
  );
  const soon = await requestSetupCode({ email: 'a@b.c' }, both);
  if (!soon.ok) assert.match(failureText(soon.failure, Date.now()) ?? '', /\b[45] seconds/);
  const bare: typeof fetch = async () => new Response(JSON.stringify({ error: 'x', code: 'too_many_attempts' }), { status: 429 });
  const plain = await requestSetupCode({ email: 'a@b.c' }, bare);
  if (!plain.ok) {
    assert.equal(plain.failure.retryUntil, null);
    assert.equal(failureText(plain.failure, Date.now()), 'Too many attempts. Try again later.');
  }

  assert.equal(retryAfterSeconds('120', 0), 120);
  assert.equal(retryAfterSeconds(new Date(30_000).toUTCString(), 0), 30, 'an HTTP date');
  assert.equal(retryAfterSeconds('soon', 0), null);
  assert.equal(retryAfterSeconds(null, 0), null);
});

type Mounted = {
  document: Document;
  act: (fn: () => void | Promise<void>) => Promise<void>;
  type: (value: string) => Promise<void>;
  flush: () => Promise<void>;
  render: (props: EmailCodeHostProps) => Promise<void>;
};

async function mount(ctx: TestContext): Promise<Mounted> {
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
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { EmailCodeHost } = await import('./email-code');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  // React tracks the value it set: go through the native setter so `onChange` fires.
  const type = async (value: string) => {
    const field = dom.window.document.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set;
    await act(() => {
      setter?.call(field, value);
      field.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await flush();
  };
  const render = async (props: EmailCodeHostProps) => {
    await act(() => { root.render(React.createElement(EmailCodeHost, props)); });
    await flush();
  };
  return { document: dom.window.document, act, type, flush, render };
}

function wrongCode(attemptsLeft: number): CodeFailure {
  return { code: 'email_code_invalid', status: 400, params: { attemptsLeft }, message: `Wrong code. ${attemptsLeft} attempts left.`, retryUntil: null, attemptsLeft };
}

test('six digits are checked once complete; a wrong one is cleared with its tries left, a right one moves on', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const w = await mount(t);
  const checked: string[] = [];
  let verified = 0;
  await w.render({
    purpose: 'verify',
    email: 'ada@example.com',
    resendAt: Date.now() + 60_000,
    verify: async (code) => { checked.push(code); return code === '123456' ? { ok: true } : { ok: false, failure: wrongCode(4) }; },
    resend: async () => ({ ok: true, resendAt: Date.now() + 60_000 }),
    onVerified: () => { verified += 1; },
    changeEmail: () => {},
    settleMs: 0,
  });
  assert.match(w.document.body.textContent ?? '', /We sent a code to ada@example\.com\./);
  const resend = () => w.document.querySelector('[data-email-code-resend]') as HTMLButtonElement;
  assert.equal(resend().disabled, true, 'resend waits 60 s');
  assert.match(resend().textContent ?? '', /Resend in (1:00|0:59)/);

  await w.type('12a3');
  assert.deepEqual(checked, [], 'not complete, not sent');
  assert.deepEqual(Array.from(w.document.querySelectorAll('[data-email-code-box]')).map((b) => b.textContent), ['1', '2', '3', '', '', '']);

  await w.type('999999');
  assert.deepEqual(checked, ['999999']);
  const status = () => w.document.querySelector('[data-email-code-status]') as HTMLElement;
  assert.equal(status().dataset.emailCodeStatus, 'bad');
  assert.equal(status().textContent, 'Wrong code. 4 attempts left.');
  assert.equal((w.document.querySelector('input') as HTMLInputElement).value, '', 'the digits are cleared for the next try');

  await w.type('1');
  assert.equal(status().dataset.emailCodeStatus, 'idle', 'typing again answers the refusal');
  await w.type('123456');
  assert.deepEqual(checked, ['999999', '123456']);
  assert.equal(verified, 1);
});

test('"Resend" opens after its wait, and a refused resend shows the delay the daemon asked for', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const { codeFailure } = await import('./email-code-failure');
  const w = await mount(t);
  let resends = 0;
  let changed = 0;
  await w.render({
    purpose: 'reset',
    email: 'ada@example.com',
    resendAt: Date.now() - 1,
    verify: async () => ({ ok: true }),
    resend: async () => {
      resends += 1;
      return resends === 1
        // Already open: the host's clock ticks twice a second, the test does not wait for it.
        ? { ok: true, resendAt: Date.now() - 5_000 }
        : { ok: false, failure: codeFailure(429, { error: 'x', code: 'email_code_origin_limited', retryAfter: 30, params: { seconds: 30 } }, Date.now()) };
    },
    onVerified: () => {},
    changeEmail: () => { changed += 1; },
  });
  assert.match(w.document.body.textContent ?? '', /If an account here uses ada@example\.com/, 'a reset never says the account exists');
  const resend = () => w.document.querySelector('[data-email-code-resend]') as HTMLButtonElement;
  assert.equal(resend().disabled, false);
  await w.act(() => { resend().click(); });
  await w.flush();
  assert.equal(resends, 1);
  const status = () => w.document.querySelector('[data-email-code-status]') as HTMLElement;
  assert.equal(status().textContent, 'New code sent');

  await w.act(() => { resend().click(); });
  await w.flush();
  assert.equal(resends, 2);
  assert.equal(status().dataset.emailCodeStatus, 'failed');
  assert.match(status().textContent ?? '', /from this network\. Try again in (30|29) seconds\./);
  assert.equal(resend().disabled, true, 'closed for the wait the daemon asked');
  assert.match(resend().textContent ?? '', /Resend in 0:(30|29)/);

  const change = Array.from(w.document.querySelectorAll('button')).find((b) => b.textContent?.includes('Change email'));
  await w.act(() => { change?.click(); });
  assert.equal(changed, 1);
});

test('a plugin that takes email.code paints the screen from useEmailCode, and leaves it to the product', async (t) => {
  const { register, resetSlotsForTests, EMAIL_CODE_SLOT, slotEntries } = await import('@/lib/plugin-host/slots');
  const { useEmailCode } = await import('./email-code-context');
  resetSlotsForTests();
  assert.equal(slotEntries(EMAIL_CODE_SLOT).length, 0, 'a boot slot, empty');
  const React = await import('react');
  function Replacement() {
    const code = useEmailCode();
    return React.createElement('button', { 'data-replacement': code?.state ?? '', onClick: () => code?.input('654321') }, `${code?.purpose}:${code?.email}:${code?.length}`);
  }
  const dispose = register({ slot: EMAIL_CODE_SLOT, pluginId: 'acme-code' }, Replacement);
  const w = await mount(t);
  const checked: string[] = [];
  await w.render({
    purpose: 'verify', email: 'ada@example.com', resendAt: Date.now(), settleMs: 0,
    verify: async (code) => { checked.push(code); return { ok: true }; },
    resend: async () => ({ ok: true, resendAt: Date.now() }), onVerified: () => {}, changeEmail: () => {},
  });
  const button = w.document.querySelector('[data-replacement]') as HTMLButtonElement;
  assert.equal(button.textContent, 'verify:ada@example.com:6');
  assert.ok(!w.document.querySelector('[data-email-code-boxes]'), 'the product boxes step aside');
  await w.act(() => { button.click(); });
  await w.flush();
  assert.deepEqual(checked, ['654321'], 'what the replacement passes to input is checked by the host');
  await w.act(() => { dispose(); });
  await w.flush();
  assert.ok(w.document.querySelector('[data-email-code-boxes]'), 'the product boxes come back');
});

test('the examples/plugin-email-code template paints the screen with the SDK alone', async (t) => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const React = await import('react');
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-email-code', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__emailCodeTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__emailCodeTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __emailCodeTestReact: React, __emailCodeTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'email-code-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  const dispose = mod.apply({ slots: { register: (options: { slot: string }, Component: React.ComponentType) => register({ ...options, pluginId: 'example-email-code' }, Component) } });
  const w = await mount(t);
  const checked: string[] = [];
  await w.render({
    purpose: 'verify', email: 'ada@example.com', resendAt: Date.now() + 60_000, settleMs: 0,
    verify: async (code) => { checked.push(code); return { ok: false, failure: wrongCode(2) }; },
    resend: async () => ({ ok: true, resendAt: Date.now() }), onVerified: () => {}, changeEmail: () => {},
  });
  assert.ok(w.document.querySelector('[data-example-email-code]'));
  assert.match((w.document.querySelector('[data-example-resend]') as HTMLButtonElement).textContent ?? '', /Resend in (60|59) s/);
  await w.type('11 22 33');
  assert.deepEqual(checked, ['112233']);
  assert.match(w.document.body.textContent ?? '', /Wrong code\. 2 attempts left\./, 'the host message reaches the template');
  await w.act(() => { dispose(); });
  await w.flush();
  assert.ok(!w.document.querySelector('[data-example-email-code]'));
  assert.ok(w.document.querySelector('[data-email-code-boxes]'), 'the product boxes come back');
});
