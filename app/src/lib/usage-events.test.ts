import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PAGE_POLL_MS, USAGE_EVENT_ROUTE, reportOnboardingScreen, reportUsage, startUsageReporting, usageSurface, type ReporterHost,
} from './usage-events';

function fakeHost(path: string, desktop = false) {
  const sent: Record<string, unknown>[] = [];
  let tick: (() => void) | null = null;
  let popstate: (() => void) | null = null;
  const host: ReporterHost & { location: { pathname: string } } = {
    location: { pathname: path },
    setInterval: (fn, ms) => { assert.equal(ms, PAGE_POLL_MS); tick = fn; return 1; },
    clearInterval: () => { tick = null; },
    addEventListener: (_type, fn) => { popstate = fn; },
    removeEventListener: () => { popstate = null; },
    ...(desktop ? { timonDesktop: {} } : {}),
  };
  const fetcher = async (url: string, init: RequestInit) => {
    assert.equal(url, USAGE_EVENT_ROUTE);
    assert.equal(init.method, 'POST');
    sent.push(JSON.parse(String(init.body)) as Record<string, unknown>);
  };
  return { host, sent, fetcher, tick: () => tick?.(), popstate: () => popstate?.(), stopped: () => tick === null && popstate === null };
}

test('the opening, then each page once, until stopped', () => {
  const h = fakeHost('/agents/acme');
  const stop = startUsageReporting(h.host, h.fetcher);
  h.tick();
  h.host.location.pathname = '/projects/x';
  h.tick();
  h.tick();
  h.host.location.pathname = '/agents/acme';
  h.popstate();
  stop();
  assert.ok(h.stopped());
  assert.deepEqual(h.sent, [
    { name: 'app_opened', surface: 'web', setupCompleted: true },
    { name: 'page_viewed', surface: 'web', path: '/agents/acme' },
    { name: 'page_viewed', surface: 'web', path: '/projects/x' },
    { name: 'page_viewed', surface: 'web', path: '/agents/acme' },
  ]);
});

test('setup is not a completed setup, the desktop shell is the desktop surface', () => {
  const h = fakeHost('/setup/agent', true);
  startUsageReporting(h.host, h.fetcher)();
  assert.deepEqual(h.sent[0], { name: 'app_opened', surface: 'desktop', setupCompleted: false });
  assert.equal(usageSurface({ timonDesktop: {} }), 'desktop');
  assert.equal(usageSurface({}), 'web');
  assert.equal(usageSurface(undefined), 'web');
});

test('a signed-out page reports nothing', () => {
  const h = fakeHost('/login');
  startUsageReporting(h.host, h.fetcher)();
  assert.deepEqual(h.sent, []);
});

test('a failing report never throws', async () => {
  assert.doesNotThrow(() => reportUsage({ name: 'page_viewed', surface: 'web', path: '/' }, () => { throw new Error('offline'); }));
  assert.doesNotThrow(() => reportUsage({ name: 'page_viewed', surface: 'web', path: '/' }, () => Promise.reject(new Error('offline'))));
  await new Promise((r) => setTimeout(r, 5));
});

test('the load time rides on the opening; UI errors are counted per section, without their text, at most once a minute', () => {
  const h = fakeHost('/agents/acme');
  let fire: (() => void) | null = null;
  let clock = 0;
  h.host.loadMs = () => 2_412.6;
  h.host.now = () => clock;
  h.host.onError = (fn) => { fire = fn; return () => { fire = null; }; };
  const stop = startUsageReporting(h.host, h.fetcher);
  fire!();
  fire!();
  clock += 61_000;
  fire!();
  h.host.location.pathname = '/settings';
  fire!();
  stop();
  assert.equal(fire, null, 'stopping removes the error listeners');
  assert.deepEqual(h.sent[0], { name: 'app_opened', surface: 'web', setupCompleted: true, loadMs: 2413 });
  assert.deepEqual(h.sent.filter((e) => e.name === 'ui_error').map((e) => e.path), ['/agents/acme', '/agents/acme', '/settings']);
});

test('an onboarding screen is one closed event to the usage route', () => {
  const posted: Array<{ url: string; body: unknown }> = [];
  const fetcher = (url: string, init: RequestInit): Promise<unknown> => {
    posted.push({ url, body: JSON.parse(String(init.body)) });
    return Promise.resolve();
  };
  reportOnboardingScreen('account', 'viewed', {}, fetcher);
  reportOnboardingScreen('llm', 'completed', { llmChoice: 'plan', backend: 'claude', connection: 'ok' }, fetcher);
  assert.deepEqual(posted, [
    { url: USAGE_EVENT_ROUTE, body: { name: 'onboarding_screen', surface: 'web', screen: 'account', action: 'viewed' } },
    {
      url: USAGE_EVENT_ROUTE,
      body: { name: 'onboarding_screen', surface: 'web', screen: 'llm', action: 'completed', llmChoice: 'plan', backend: 'claude', connection: 'ok' },
    },
  ]);
});
