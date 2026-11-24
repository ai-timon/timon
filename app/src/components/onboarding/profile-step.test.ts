/**
 * The profile step, rendered (jsdom) against a fake daemon: the second
 * question is optional and written on click, the agency card carries its
 * badge and opens the offer with an unticked box and the account's address,
 * "Continue" waits for a profile, sends the offer request only when the box
 * is ticked, and stays on the step when the address is refused.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { resetOnboardingProfile } from './onboarding-profile';
import { looksLikeEmail, parseAgencyOffer, agencyOfferStatusKey } from '@/lib/agency-offer';

type Call = { url: string; method: string; body: unknown };
type Answer = (call: Call) => Response | undefined;

function daemon(override: Answer = () => undefined): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      const special = override(call);
      if (special) return special;
      if (call.url === '/api/ui/auth/me') {
        return Response.json({ user: { id: 'u1', email: 'boss@agency.example', name: 'Boss', is_superadmin: true, status: 'active' }, needsSetup: false });
      }
      if (call.url === '/api/ui/onboarding/profile') return Response.json(call.method === 'PUT' ? { ...(call.body as object), at: 1 } : { profile: null, at: null });
      if (call.url === '/api/ui/onboarding/usage-kind') return Response.json(call.method === 'PUT' ? { ...(call.body as object), at: 1 } : { usageKind: null, at: null });
      if (call.url === '/api/ui/partners/lead') return Response.json({ state: 'subscribed', email: 'boss@agency.example', error: null, at: 1 });
      return Response.json({}, { status: 404 });
    },
  };
}

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=profile', pretendToBeVisual: true });
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
    return await run(dom as unknown as Dom, React);
  } finally {
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
  }
}

type Rendered = { host: HTMLElement; calls: Call[]; nexts: () => number; react: typeof import('react'); dom: Dom };

async function renderStep(run: (r: Rendered) => Promise<void>, override?: Answer): Promise<void> {
  await withDom(async (dom, React) => {
    resetOnboardingProfile();
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { ProfileStep } = await import('./steps/profile');
    const fake = daemon(override);
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => fake.fetcher(String(input), init)) as typeof fetch;
    let nexts = 0;
    const nav = {
      step: 'profile' as const, direction: 1 as const,
      next: () => { nexts += 1; }, back: () => undefined, goTo: () => undefined,
      setLanguage: async (tag: string) => tag, setBackHandler: () => undefined, skip: () => undefined, setOutcome: () => undefined,
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(ProfileStep))); });
      await settle(React);
      await run({ host, calls: fake.calls, nexts: () => nexts, react: React, dom });
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      resetOnboardingProfile();
    }
  });
}

const settle = (react: typeof import('react'), ms = 20): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const q = <T extends Element = HTMLElement>(host: HTMLElement, selector: string): T => {
  const el = host.querySelector<T>(selector);
  assert.ok(el, `${selector} is on screen`);
  return el;
};
const click = async (r: Rendered, selector: string): Promise<void> => {
  await r.react.act(async () => { q<HTMLElement>(r.host, selector).click(); });
  await settle(r.react);
};
const writes = (calls: readonly Call[], url: string): Call[] => calls.filter((c) => c.url === url && c.method !== 'GET');

test('the second question is optional: a profile alone opens the agent step', async () => {
  await renderStep(async (r) => {
    assert.equal(q<HTMLButtonElement>(r.host, '[data-profile-continue]').disabled, true, 'a profile is needed first');
    await click(r, '[data-profile="developer"]');
    assert.equal(r.nexts(), 0, 'a profile no longer leaves the step by itself');
    assert.ok(!r.host.querySelector('[data-agency-offer]'));
    await click(r, '[data-profile-continue]');
    assert.equal(r.nexts(), 1);
    assert.deepEqual(writes(r.calls, '/api/ui/onboarding/usage-kind'), []);
    assert.deepEqual(writes(r.calls, '/api/ui/partners/lead'), []);
  });
});

test('the agency card carries its badge; once chosen, the offer opens unticked with the account\'s address', async () => {
  await renderStep(async (r) => {
    assert.ok(q(r.host, '[data-usage-kind="agency"] [data-agency-badge]'));
    await click(r, '[data-usage-kind="team"]');
    await click(r, '[data-usage-kind="agency"]');
    assert.deepEqual(writes(r.calls, '/api/ui/onboarding/usage-kind').map((c) => c.body), [{ usageKind: 'team' }, { usageKind: 'agency' }]);
    assert.equal(q(r.host, '[data-usage-kind="agency"]').getAttribute('aria-pressed'), 'true');
    assert.equal(q<HTMLInputElement>(r.host, '[data-agency-consent]').checked, false, 'never ticked for the person');
    assert.equal(q<HTMLInputElement>(r.host, '[data-agency-email]').value, 'boss@agency.example');
    await click(r, '[data-profile="automation"]');
    await click(r, '[data-profile-continue]');
    assert.equal(r.nexts(), 1);
    assert.deepEqual(writes(r.calls, '/api/ui/partners/lead'), [], 'unticked: nothing is asked');
  });
});

test('ticked: "Continue" asks the daemon for the offer, then moves on', async () => {
  await renderStep(async (r) => {
    await click(r, '[data-profile="beginner"]');
    await click(r, '[data-usage-kind="agency"]');
    await click(r, '[data-agency-consent]');
    await click(r, '[data-profile-continue]');
    const posted = writes(r.calls, '/api/ui/partners/lead');
    assert.equal(posted.length, 1);
    assert.equal((posted[0]!.body as { email: string }).email, 'boss@agency.example');
    assert.equal(typeof (posted[0]!.body as { locale: unknown }).locale, 'string');
    assert.equal(r.nexts(), 1);
  });
});

test('a refused address keeps the person on the step with a readable error', async () => {
  await renderStep(async (r) => {
    await click(r, '[data-profile="beginner"]');
    await click(r, '[data-usage-kind="agency"]');
    await click(r, '[data-agency-consent]');
    await click(r, '[data-profile-continue]');
    assert.equal(r.nexts(), 0);
    assert.ok(r.host.querySelector('[role="alert"]'));
  }, (c) => (c.url === '/api/ui/partners/lead' && c.method === 'POST'
    ? Response.json({ state: 'rejected', email: 'boss@agency.example', error: 'invalid', at: 1 })
    : undefined));
});

test('the helpers read the daemon\'s answer and nothing else', () => {
  assert.equal(parseAgencyOffer({ state: 'bogus' }), null);
  assert.deepEqual(parseAgencyOffer({ state: 'pending', email: 'a@b.co', error: 'rate_limited', at: 3 }), { state: 'pending', email: 'a@b.co', error: 'rate_limited', at: 3 });
  assert.equal(parseAgencyOffer({ state: 'rejected', error: 'weird' })?.error, null);
  assert.equal(agencyOfferStatusKey({ state: 'rejected', email: null, error: 'invalid', at: null }), 'agencyOffer.status.invalid');
  assert.equal(looksLikeEmail(' boss@agency.example '), true);
  assert.equal(looksLikeEmail('boss@agency'), false);
});
