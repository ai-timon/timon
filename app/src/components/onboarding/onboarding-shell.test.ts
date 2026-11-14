/**
 * The onboarding's frame, rendered: « Continue » walks the steps, « Back »
 * walks them back (a step's own sub-view first, a skipped step skipped both
 * ways), the dots and the address follow, and a reload reopens the step. With
 * the real card and guard: a stand-in that leaves the page installs nothing.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import type { ComponentType } from 'react';
import type { OnboardingStepEntry } from './steps/registry';

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(url: string, run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url, pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle']) {
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

/** How many times the shell left the onboarding (`finish`, the TIMs page in the product). */
let finished = 0;

/** `open`: every step mounts; `closed`: the steps that need the service wait (the real guard's rule). */
type GateMode = 'open' | 'closed';

async function renderShell(
  url: string,
  run: (host: HTMLElement, click: (el: Element | null | undefined) => Promise<void>, dom: Dom) => Promise<void>,
  gateMode: GateMode = 'open',
): Promise<void> {
  await withDom(url, async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { OnboardingShell } = await import('./onboarding-shell');
    const { useOnboarding, useOnboardingBack } = await import('./onboarding-context');
    const { legacyStep } = await import('./steps/legacy-step');
    const { stepNeedsService } = await import('@/lib/setup-plan');
    const h = React.createElement;

    // The real guard calls the daemon; this one holds the same steps, or none.
    function gate({ step, children }: { step: string; children: React.ReactNode }): React.ReactElement {
      if (gateMode === 'closed' && stepNeedsService(step)) return h('p', { 'data-gate': step }, 'waiting for the service');
      return h(React.Fragment, null, children);
    }

    const plain = (id: string): ComponentType => function Plain() {
      const { next } = useOnboarding();
      return h('section', { 'data-step': id }, h('button', { 'data-next': '', onClick: next }, 'next'));
    };
    // A step with a sub-view: « Back » closes the sub-view before leaving the step.
    function WithSubView() {
      const { next } = useOnboarding();
      const [sub, setSub] = React.useState(false);
      useOnboardingBack(() => {
        if (!sub) return false;
        setSub(false);
        return true;
      });
      return h('section', { 'data-step': 'account', 'data-sub': sub ? 'open' : 'closed' },
        h('button', { 'data-open-sub': '', onClick: () => setSub(true) }, 'sub'),
        h('button', { 'data-next': '', onClick: next }, 'next'));
    }
    const steps = [
      { id: 'splash', Component: plain('splash') },
      { id: 'background', Component: plain('background') },
      { id: 'account', Component: WithSubView },
      { id: 'llm', Component: plain('llm') },
      { id: 'profile', Component: legacyStep(null) },
      { id: 'agent', Component: plain('agent') },
      { id: 'discover', Component: plain('discover') },
    ] as const;

    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    const click = async (el: Element | null | undefined): Promise<void> => {
      assert.ok(el, 'element to click');
      await React.act(async () => { (el as HTMLElement).click(); });
    };
    try {
      await React.act(async () => { root.render(h(OnboardingShell, { steps, gate, companions: [], finish: () => { finished += 1; } })); });
      await run(host, click, dom);
    } finally {
      await React.act(async () => { root.unmount(); });
    }
  });
}

const shown = (host: HTMLElement): string | null => host.querySelector('[data-step]')?.getAttribute('data-step') ?? null;
const dots = (host: HTMLElement): string[] => Array.from(host.querySelectorAll('[data-dot]')).map((el) => el.getAttribute('data-dot') ?? '');
const backButton = (host: HTMLElement): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => !b.hasAttribute('data-next') && !b.hasAttribute('data-open-sub'));

test('« Continue » walks the steps; the dots and the address follow; a skipped step is skipped', async () => {
  await renderShell('http://localhost/onboarding', async (host, click, dom) => {
    assert.equal(shown(host), 'splash');
    assert.deepEqual(dots(host), [], 'no dots on the welcome');
    assert.equal(backButton(host), undefined, 'nothing to go back to');
    await click(host.querySelector('[data-next]'));
    assert.equal(shown(host), 'background', 'the background question first: the install carries its answer');
    assert.deepEqual(dots(host), ['current', 'todo', 'todo', 'todo', 'todo']);
    await click(host.querySelector('[data-next]'));
    assert.equal(shown(host), 'account');
    assert.deepEqual(dots(host), ['done', 'current', 'todo', 'todo', 'todo']);
    assert.equal(dom.window.location.search, '?step=account');
    await click(host.querySelector('[data-next]'));
    await click(host.querySelector('[data-next]'));
    assert.equal(shown(host), 'agent', 'the profile stand-in has no screen: skipped');
    assert.deepEqual(dots(host), ['done', 'done', 'done', 'done', 'current']);
    finished = 0;
    await click(host.querySelector('[data-next]'));
    assert.equal(shown(host), 'discover', 'the agent made, « Discover Timon » follows');
    assert.deepEqual(dots(host), [], 'no dots on the slides');
    assert.equal(backButton(host), undefined, 'no way back to the agent\'s creation');
    assert.equal(finished, 0);
    await click(host.querySelector('[data-next]'));
    assert.equal(finished, 1, 'the slides are the last step: their end leaves for the welcome on the TIMs page');
    assert.equal(shown(host), 'discover', 'no step after it in the onboarding');
  });
});

test('a tab still on the former chat step goes to the welcome, not to the splash', async () => {
  finished = 0;
  await renderShell('http://localhost/onboarding?step=chat', async (host) => {
    assert.equal(finished, 1);
    assert.equal(shown(host), null);
  });
});

test('« Back » walks back: past a skipped step, and through a sub-view before leaving its step', async () => {
  await renderShell('http://localhost/onboarding?step=agent', async (host, click) => {
    assert.equal(shown(host), 'agent', 'a reload reopens the step of the address');
    await click(backButton(host));
    assert.equal(shown(host), 'llm', 'the skipped profile is skipped going back too');
    await click(backButton(host));
    assert.equal(shown(host), 'account');
    await click(host.querySelector('[data-open-sub]'));
    assert.equal(host.querySelector('[data-step]')?.getAttribute('data-sub'), 'open');
    await click(backButton(host));
    assert.equal(shown(host), 'account', 'the sub-view closes first');
    assert.equal(host.querySelector('[data-step]')?.getAttribute('data-sub'), 'closed');
    await click(backButton(host));
    assert.equal(shown(host), 'background');
    await click(backButton(host));
    assert.equal(shown(host), 'splash');
  });
});

test('the guard keeps the agent step closed while the service is not ready; the other steps pass', async () => {
  await renderShell('http://localhost/onboarding?step=llm', async (host, click) => {
    assert.equal(shown(host), 'llm', 'the AI step needs no service');
    await click(host.querySelector('[data-next]'));
    assert.equal(shown(host), null, 'the agent step is not mounted');
    assert.equal(host.querySelector('[data-gate]')?.getAttribute('data-gate'), 'agent');
    assert.deepEqual(dots(host), ['done', 'done', 'done', 'done', 'current'], 'the frame stays: dots and « Back »');
    await click(backButton(host));
    assert.equal(shown(host), 'llm', '« Back » still leaves a closed step');
  }, 'closed');
});

/**
 * The real « Preparing Timon » card and guard against a fake daemon: what the
 * page asked, in order — `/api/ui/onboarding` actions, the configuration
 * write, and the moment the stand-in left (`left:<hash>`).
 */
async function renderPrepared(
  url: string,
  steps: readonly OnboardingStepEntry[],
  seen?: { status?: Record<string, unknown>; html?: string[] },
): Promise<string[]> {
  return withDom(url, async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { OnboardingShell } = await import('./onboarding-shell');
    const { PreparationCard } = await import('./preparation-card');
    const { ServiceGate } = await import('./service-gate');
    const events: string[] = [];
    let configured = false;
    let installed = false;
    const json = (body: unknown, status = 200): Response =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = String(input);
      if (path === '/api/ui/capabilities') return json({ firstRun: !configured });
      if (path === '/api/ui/doctor') {
        return json({ platform: 'linux', supervisor: 'systemd-user', linux: null, binaries: [], blockers: [], desktop: false });
      }
      if (path === '/api/ui/native-browser/capabilities') return json({ available: false });
      if (path === '/api/ui/setup/resume') return json({ present: false });
      if (path === '/api/ui/setup') {
        events.push('write-config');
        configured = true;
        return json({ ok: true });
      }
      if (path === '/api/ui/onboarding') {
        const { action } = JSON.parse(String(init?.body)) as { action: string };
        events.push(action);
        if (action === 'install-service') installed = true;
        if (action === 'service-status' && seen?.status) return json({ ok: installed, installed, ...seen.status });
        return json({ ok: installed, installed });
      }
      return json({}, 404);
    };
    const onHash = (): void => { events.push(`left:${dom.window.location.hash}`); };
    dom.window.addEventListener('hashchange', onHash);
    const saved = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    try {
      await React.act(async () => {
        root.render(React.createElement(OnboardingShell, { steps, companions: [PreparationCard], gate: ServiceGate }));
      });
      for (let i = 0; i < 8; i += 1) {
        await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
      }
      seen?.html?.push(host.innerHTML);
      return events;
    } finally {
      await React.act(async () => { root.unmount(); });
      globalThis.fetch = saved;
    }
  });
}

// A hash stands for the screen a stand-in opens: jsdom loads no document.
async function standIns(): Promise<OnboardingStepEntry[]> {
  const { legacyStep } = await import('./steps/legacy-step');
  return [
    { id: 'account', Component: legacyStep('#login'), leavesPage: true },
    { id: 'agent', Component: legacyStep('#setup-agent'), leavesPage: true },
  ];
}

test('a stand-in that opens another screen starts no background install', async () => {
  const events = await renderPrepared('http://localhost/onboarding?step=account', await standIns());
  assert.deepEqual(events, ['left:#login'], 'nothing asked of the daemon from a page about to unload');
});

test('the background question reads the machine but installs nothing: the install waits for its answer', async () => {
  const { BackgroundStep } = await import('./steps/background');
  const events = await renderPrepared('http://localhost/onboarding?step=background', [{ id: 'background', Component: BackgroundStep }]);
  assert.deepEqual(events, ['service-status']);
});

test('on a Linux account that already lingers, "only while logged in" says it turns lingering off (audit F2)', async () => {
  const { BackgroundStep } = await import('./steps/background');
  const steps: OnboardingStepEntry[] = [{ id: 'background', Component: BackgroundStep }];
  for (const lingering of [true, false]) {
    const html: string[] = [];
    await renderPrepared('http://localhost/onboarding?step=background', steps, { status: { sessionModeSupported: true, lingering }, html });
    assert.match(html[0]!, /data-session-mode="session"/);
    assert.equal(/data-linger-note/.test(html[0]!), lingering, String(lingering));
  }
});

// Last: the page's store is shared by the module, and this one starts it.
test('a stand-in agent step leaves only once the service is installed and the configuration written', async () => {
  const events = await renderPrepared('http://localhost/onboarding?step=agent', await standIns());
  const install = events.indexOf('install-service');
  const write = events.indexOf('write-config');
  const left = events.indexOf('left:#setup-agent');
  assert.ok(install >= 0 && write > install && left > write, events.join(' → '));
});
