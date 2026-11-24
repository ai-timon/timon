/**
 * The upgrade welcome (docs/ONBOARDING.md, `Upgrade welcome`), rendered
 * (jsdom) against a fake daemon: the sign-in step signs in through the login
 * route; the mascot step saves the look and the mascot head on "Keep this
 * look", saves nothing on "Not now", and closes the welcome either way; an
 * account that may not edit agents is not shown the screen.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { forgetSharedReads } from '@/lib/shared-read';
import { closeWelcome, keepLook, WELCOME_DONE_PATH } from './steps/mascot';

type Call = { url: string; method: string; body: unknown };

type Me = { welcome: 'returning' | 'mascot' | null; signedIn: boolean; canManageAgents?: boolean };

function daemon(me: Me): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call: Call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      if (call.url === '/api/ui/auth/me') {
        return Response.json({
          user: me.signedIn ? { id: 'u1', email: 'robin@example.com', name: 'Robin' } : null,
          needsSetup: false,
          welcome: me.welcome,
          can: { 'agents:manage': me.canManageAgents !== false, 'projects:manage': true, 'agents:privileged-config': true },
        });
      }
      if (call.url === '/api/ui/auth/login') {
        me.signedIn = true;
        me.welcome = 'mascot';
        return Response.json({ user: { id: 'u1' } });
      }
      if (call.url === '/api/ui/setup/main-agent') return Response.json({ status: 'done', available: true, name: 'nova', named: true });
      if (call.url === '/api/ui/agents/nova') return Response.json({ name: 'nova', role: 'orchestrator', look: null });
      if (call.method === 'PATCH' || call.url === WELCOME_DONE_PATH) return Response.json({ ok: true });
      return Response.json({ error: 'not_found' }, { status: 404 });
    },
  };
}

test('"Keep this look" saves the look and makes the mascot the head', async () => {
  const d = daemon({ welcome: 'mascot', signedIn: true });
  const look = { shape: 'tri', color: '#7ed957', eyes: 'code', acc: 'none' } as const;
  assert.equal(await keepLook('nova', look, d.fetcher), true);
  await closeWelcome(d.fetcher);
  assert.deepEqual(d.calls.map((c) => `${c.method} ${c.url}`), ['PATCH /api/ui/agents/nova/config', `POST ${WELCOME_DONE_PATH}`]);
  assert.deepEqual(d.calls[0]?.body, { look, avatar: 'mascot' });
  assert.equal(await keepLook('nova', look, async () => { throw new Error('offline'); }), false);
  await closeWelcome(async () => { throw new Error('offline'); });
});

/* ---------- Rendered ---------- */

async function withDom<T>(url: string, run: (react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'SVGElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'XMLSerializer']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  try {
    return await run(React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

async function settle(React: typeof import('react')): Promise<void> {
  for (let i = 0; i < 8; i += 1) await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

async function render(step: 'signin' | 'mascot', me: Me, run: (host: HTMLElement, calls: Call[], React: typeof import('react')) => Promise<void>): Promise<void> {
  await withDom(`http://localhost/onboarding?step=${step}`, async (React) => {
    forgetSharedReads();
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { SigninStep } = await import('./steps/signin');
    const { MascotStep } = await import('./steps/mascot');
    const fake = daemon(me);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetcher(String(input), init)) as typeof fetch;
    const nav = {
      step, direction: 1 as const,
      next: () => undefined, back: () => undefined, goTo: () => undefined,
      setLanguage: async (tag: string) => tag, setBackHandler: () => undefined, skip: () => undefined, setOutcome: () => undefined,
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(step === 'signin' ? SigninStep : MascotStep)));
      });
      await settle(React);
      await run(host, fake.calls, React);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      forgetSharedReads();
    }
  });
}

function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

const sent = (calls: Call[]): string[] => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url}`);

test('the sign-in step signs in through the login route, with the new mark above it', async () => {
  await render('signin', { welcome: 'returning', signedIn: false }, async (host, calls, React) => {
    assert.ok(host.querySelector('[data-onboarding-signin] svg[data-brand-logo]'), 'the "T" mark');
    const [email, password] = Array.from(host.querySelectorAll('input'));
    assert.ok(email && password);
    await React.act(async () => { type(email, 'robin@example.com'); type(password, 'secret'); });
    const form = host.querySelector('form');
    assert.ok(form);
    await React.act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    await settle(React);
    const login = calls.find((c) => c.url === '/api/ui/auth/login');
    assert.deepEqual(login?.body, { email: 'robin@example.com', password: 'secret' });
  });
});

test('the mascot step offers the main agent\'s configurator and keeps the look', async () => {
  await render('mascot', { welcome: 'mascot', signedIn: true }, async (host, calls, React) => {
    const screen = host.querySelector('[data-onboarding-mascot]');
    assert.ok(screen, 'the screen is shown');
    assert.match(screen.querySelector('h1')?.textContent ?? '', /nova/);
    const keep = host.querySelector<HTMLButtonElement>('[data-mascot-keep]');
    assert.ok(keep);
    await React.act(async () => { keep.click(); });
    await settle(React);
    assert.deepEqual(sent(calls), ['PATCH /api/ui/agents/nova/config', 'POST /api/ui/telemetry/event', `POST ${WELCOME_DONE_PATH}`]);
    assert.deepEqual(calls.find((c) => c.url === '/api/ui/telemetry/event')?.body, { name: 'onboarding_screen', surface: 'web', screen: 'mascot', action: 'completed' });
    assert.equal((calls.find((c) => c.method === 'PATCH')?.body as { avatar?: string }).avatar, 'mascot');
  });
});

test('"Not now" saves nothing and closes the welcome', async () => {
  await render('mascot', { welcome: 'mascot', signedIn: true }, async (host, calls, React) => {
    const skip = Array.from(host.querySelectorAll('button')).find((b) => b.textContent === 'Not now');
    assert.ok(skip);
    await React.act(async () => { skip.click(); });
    await settle(React);
    assert.deepEqual(sent(calls), ['POST /api/ui/telemetry/event', `POST ${WELCOME_DONE_PATH}`]);
    assert.deepEqual(calls.find((c) => c.url === '/api/ui/telemetry/event')?.body, { name: 'onboarding_screen', surface: 'web', screen: 'mascot', action: 'skipped' });
  });
});

test('an account that may not edit agents is not shown the screen, and the welcome closes', async () => {
  await render('mascot', { welcome: 'mascot', signedIn: true, canManageAgents: false }, async (host, calls) => {
    assert.ok(!host.querySelector('[data-onboarding-mascot]'));
    assert.deepEqual(sent(calls), [`POST ${WELCOME_DONE_PATH}`]);
  });
});
