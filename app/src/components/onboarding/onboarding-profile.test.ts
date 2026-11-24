/**
 * The onboarding's profile: the step writes it to the daemon through the
 * proxy, the agent step reads it back (the same document's answer first), a
 * refused write never moves the onboarding on, and a stale read never
 * overwrites a choice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentViewFor, isOnboardingProfile, loadOnboardingProfile, ONBOARDING_PROFILE_PATH, ONBOARDING_PROFILES,
  resetOnboardingProfile, saveOnboardingProfile,
} from './onboarding-profile';

type Call = { url: string; method: string; body: unknown };

function fakeDaemon(answer: (call: Call) => Response | Promise<Response>): { calls: Call[]; fetcher: (input: string, init?: RequestInit) => Promise<Response> } {
  const calls: Call[] = [];
  return {
    calls,
    fetcher: async (input, init) => {
      const call = { url: input, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined };
      calls.push(call);
      return answer(call);
    },
  };
}

test('the three profiles are the daemon\'s, and each opens its agent view', () => {
  assert.deepEqual([...ONBOARDING_PROFILES], ['developer', 'automation', 'beginner']);
  assert.equal(isOnboardingProfile('automation'), true);
  assert.equal(isOnboardingProfile('expert'), false);
  assert.equal(agentViewFor('developer'), 'sheet');
  assert.equal(agentViewFor('automation'), 'interview');
  assert.equal(agentViewFor('beginner'), 'templates');
  assert.equal(agentViewFor(null), 'templates', 'no profile: the simplest view');
});

test('a choice is PUT to the proxy and becomes the document\'s answer', async () => {
  resetOnboardingProfile();
  const daemon = fakeDaemon(() => Response.json({ profile: 'automation', at: 1 }));
  await saveOnboardingProfile('automation', daemon.fetcher);
  assert.deepEqual(daemon.calls, [{ url: ONBOARDING_PROFILE_PATH, method: 'PUT', body: { profile: 'automation' } }]);
  assert.equal(ONBOARDING_PROFILE_PATH, '/api/ui/onboarding/profile');
});

test('a refused write rejects and keeps the previous answer', async () => {
  resetOnboardingProfile();
  await saveOnboardingProfile('beginner', fakeDaemon(() => Response.json({}, { status: 200 })).fetcher);
  const refused = fakeDaemon(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
  await assert.rejects(saveOnboardingProfile('developer', refused.fetcher), /401/);
  const reread = fakeDaemon(() => Response.json({ profile: 'beginner' }));
  assert.equal(await loadOnboardingProfile(reread.fetcher), 'beginner');
});

test('a read asks the daemon once, whoever asks, and drops an unknown value', async () => {
  resetOnboardingProfile();
  const daemon = fakeDaemon(() => Response.json({ profile: 'developer', at: 1 }));
  const [a, b] = await Promise.all([loadOnboardingProfile(daemon.fetcher), loadOnboardingProfile(daemon.fetcher)]);
  assert.equal(a, 'developer');
  assert.equal(b, 'developer');
  assert.equal(daemon.calls.length, 1);
  resetOnboardingProfile();
  assert.equal(await loadOnboardingProfile(fakeDaemon(() => Response.json({ profile: 'wizard' })).fetcher), null);
});

test('a read that lands after a choice never overwrites it', async () => {
  resetOnboardingProfile();
  let release: (r: Response) => void = () => undefined;
  const slow = fakeDaemon(() => new Promise<Response>((resolve) => { release = resolve; }));
  const reading = loadOnboardingProfile(slow.fetcher);
  await saveOnboardingProfile('developer', fakeDaemon(() => Response.json({})).fetcher);
  release(Response.json({ profile: null }));
  assert.equal(await reading, 'developer');
  assert.equal(await loadOnboardingProfile(fakeDaemon(() => Response.json({ profile: 'developer' })).fetcher), 'developer');
});

test('a failed read is not final: the next read asks the daemon again', async () => {
  resetOnboardingProfile();
  const down = fakeDaemon(() => Response.json({ error: 'unreachable' }, { status: 502 }));
  await assert.rejects(loadOnboardingProfile(down.fetcher), /502/);
  const up = fakeDaemon(() => Response.json({ profile: 'developer', at: 1 }));
  assert.equal(await loadOnboardingProfile(up.fetcher), 'developer');
  assert.equal(up.calls.length, 1);
  resetOnboardingProfile();
});

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=profile', pretendToBeVisual: true });
  // Reduced motion: the step moves on without waiting for the jump.
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
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
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

async function renderStep(
  answer: (call: Call) => Response,
  run: (host: HTMLElement, state: { calls: Call[]; nexts: number }, react: typeof import('react')) => Promise<void>,
): Promise<void> {
  await withDom(async (_dom, React) => {
    resetOnboardingProfile();
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { ProfileStep } = await import('./steps/profile');
    const state = { calls: [] as Call[], nexts: 0 };
    const daemon = fakeDaemon(answer);
    state.calls = daemon.calls;
    const savedFetch = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => daemon.fetcher(String(input), init)) as typeof fetch;
    const nav = {
      step: 'profile' as const, direction: 1 as const,
      next: () => { state.nexts += 1; }, back: () => undefined, goTo: () => undefined,
      setLanguage: async (tag: string) => tag, setBackHandler: () => undefined, skip: () => undefined, setOutcome: () => undefined,
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => { root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(ProfileStep))); });
      await run(host, state, React);
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = savedFetch;
      resetOnboardingProfile();
    }
  });
}

const row = (host: HTMLElement, profile: string): HTMLButtonElement | null => host.querySelector(`[data-profile="${profile}"]`);
const settle = (react: typeof import('react')): Promise<void> => react.act(async () => { await new Promise((r) => setTimeout(r, 10)); });

test('the step shows three rows with a mascot each; a click records the profile, "Continue" moves on', async () => {
  await renderStep((call) => (call.method === 'PUT' ? Response.json({ profile: 'automation', at: 2 }) : Response.json({ profile: null, at: null })), async (host, state, React) => {
    const rows = Array.from(host.querySelectorAll('[data-profile]')).map((el) => el.getAttribute('data-profile'));
    assert.deepEqual(rows, ['developer', 'automation', 'beginner']);
    assert.equal(host.querySelectorAll('[data-profile] svg').length >= 3, true, 'a mascot on each row');
    assert.ok(!host.querySelector('[aria-current]'), 'nothing chosen yet');
    await React.act(async () => { row(host, 'automation')?.click(); });
    await settle(React);
    const put = state.calls.filter((c) => c.method === 'PUT');
    assert.deepEqual(put, [{ url: '/api/ui/onboarding/profile', method: 'PUT', body: { profile: 'automation' } }]);
    assert.equal(state.nexts, 0, 'the second question is on the same step');
    await React.act(async () => { host.querySelector<HTMLButtonElement>('[data-profile-continue]')?.click(); });
    await settle(React);
    assert.equal(state.nexts, 1, 'the agent step opens');
  });
});

test('a refused write says so and stays on the step', async () => {
  await renderStep((call) => (call.method === 'PUT' ? Response.json({ error: 'unauthorized' }, { status: 401 }) : Response.json({ profile: null })), async (host, state, React) => {
    await React.act(async () => { row(host, 'developer')?.click(); });
    await settle(React);
    assert.equal(state.nexts, 0);
    assert.ok(host.querySelector('[role="alert"]'), 'the failure is shown');
    assert.equal(row(host, 'developer')?.disabled, false, 'the rows can be clicked again');
  });
});

test('a profile already recorded is marked on its row', async () => {
  await renderStep(() => Response.json({ profile: 'beginner', at: 1 }), async (host, _state, React) => {
    await settle(React);
    assert.equal(row(host, 'beginner')?.getAttribute('aria-current'), 'true');
    assert.equal(row(host, 'developer')?.hasAttribute('aria-current'), false);
  });
});
