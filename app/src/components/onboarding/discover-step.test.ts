/**
 * "Discover Timon", the slides after the agent's creation: "Next" walks
 * them, the last one leaves for the welcome, "Skip all" leaves from any
 * slide, the progress bars follow and jump, the arrow keys walk both ways,
 * and the lead is the person's own TIM — its name on the last button.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import { t } from '@/lib/i18n';
import type { MainAgentState } from './agent-create';
import {
  autoAdvances, DISCOVER_SLIDE_IDS, DISCOVER_VIEWS, discoverSegments, nextSlide, previousSlide,
} from './discover-slides';

const AGENT: MainAgentState = {
  name: 'Nova', named: true, backend: null, model: null, skills: [], mcpServers: [],
  look: { shape: 'hex', color: '#7ed957', eyes: 'pill', acc: 'none' }, role: null,
};

test('four slides, from the TIM alone to everything around it, naming the product views', () => {
  assert.deepEqual([...DISCOVER_SLIDE_IDS], ['autonomous', 'teams', 'projects', 'connected']);
  assert.equal(nextSlide(0), 1);
  assert.equal(nextSlide(DISCOVER_SLIDE_IDS.length - 1), null, 'the last slide ends the slides');
  assert.equal(previousSlide(0), null);
  assert.equal(previousSlide(2), 1);
  assert.deepEqual(discoverSegments(1), ['done', 'current', 'todo', 'todo']);
  assert.equal(autoAdvances(0, false), true);
  assert.equal(autoAdvances(DISCOVER_SLIDE_IDS.length - 1, false), false, 'leaving is the person\'s gesture');
  assert.equal(autoAdvances(0, true), false, 'nothing moves on by itself without motion');
  const views = Object.values(DISCOVER_VIEWS).flat();
  for (const view of ['canvas', 'kanban', 'connectors', 'projectChat', 'widgets', 'multichat', 'workflows', 'plugins']) {
    assert.ok(views.includes(view), view);
  }
});

type Dom = { window: Window & typeof globalThis };

async function withDom<T>(run: (dom: Dom, react: typeof import('react')) => Promise<T>): Promise<T> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding?step=discover', pretendToBeVisual: true });
  const globals = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'KeyboardEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
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

type Harness = {
  host: HTMLElement;
  click: (el: Element | null | undefined) => Promise<void>;
  key: (name: string) => Promise<void>;
  nexts: () => number;
  skips: () => number;
};

async function renderDiscover(run: (h: Harness) => Promise<void>, agent: MainAgentState = AGENT): Promise<void> {
  await withDom(async (dom, React) => {
    const { createRoot } = await import('react-dom/client');
    const { OnboardingProvider } = await import('./onboarding-context');
    const { DiscoverStep } = await import('./steps/discover');
    let nexts = 0;
    let skips = 0;
    const nav = {
      step: 'discover' as const, direction: 1 as const,
      next: () => { nexts += 1; }, back: () => {}, goTo: () => {},
      skip: () => { skips += 1; }, setOutcome: () => {},
      setLanguage: async (tag: string) => tag, setBackHandler: () => {},
    };
    const host = document.getElementById('root');
    assert.ok(host);
    const root = createRoot(host);
    const loadAgent = async (): Promise<MainAgentState> => agent;
    const click = async (el: Element | null | undefined): Promise<void> => {
      assert.ok(el, 'element to click');
      await React.act(async () => { (el as HTMLElement).click(); });
    };
    const key = async (name: string): Promise<void> => {
      await React.act(async () => { dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name })); });
    };
    try {
      await React.act(async () => {
        root.render(React.createElement(OnboardingProvider, { value: nav }, React.createElement(DiscoverStep, { loadAgent })));
      });
      await run({ host, click, key, nexts: () => nexts, skips: () => skips });
    } finally {
      await React.act(async () => { root.unmount(); });
    }
  });
}

const slideOf = (host: HTMLElement): string | null =>
  host.querySelector('[data-onboarding-step="discover"]')?.getAttribute('data-discover-slide') ?? null;
const segments = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll('[data-segment]')).map((el) => el.getAttribute('data-segment') ?? '');

test('"Next" walks the slides; the last one leaves for the welcome, named after the TIM', async () => {
  await renderDiscover(async ({ host, click, nexts }) => {
    assert.equal(slideOf(host), 'autonomous');
    assert.deepEqual(segments(host), ['current', 'todo', 'todo', 'todo']);
    assert.equal(host.querySelector('h1')?.textContent, t('onboarding.discover.autonomous.title'));
    assert.ok(host.querySelector('[data-discover-view="canvas"]'), 'the views of the slide as chips');
    for (const id of DISCOVER_SLIDE_IDS.slice(1)) {
      await click(host.querySelector('[data-discover-next]'));
      assert.equal(slideOf(host), id);
    }
    assert.deepEqual(segments(host), ['done', 'done', 'done', 'current']);
    assert.ok(!host.querySelector('[data-discover-next]'), 'the last slide has no "Next"');
    const finish = host.querySelector('[data-discover-finish]');
    assert.equal(finish?.textContent, t('onboarding.discover.finish', { name: 'Nova' }));
    assert.equal(nexts(), 0, 'nothing left before the person\'s click');
    await click(finish);
    assert.equal(nexts(), 1, 'the shell leaves for the TIMs page');
  });
});

test('"Skip all" leaves from the first slide; a progress bar jumps to its slide', async () => {
  await renderDiscover(async ({ host, click, nexts, skips }) => {
    await click(host.querySelectorAll('[data-segment]')[2]);
    assert.equal(slideOf(host), 'projects', 'the third bar opens the third slide');
    await click(host.querySelectorAll('[data-segment]')[0]);
    assert.equal(slideOf(host), 'autonomous');
    await click(host.querySelector('[data-discover-skip]'));
    assert.equal(skips(), 1, 'the funnel counts it skipped, not completed');
    assert.equal(nexts(), 0);
  });
});

test('the arrow keys walk the slides both ways, past the last one too', async () => {
  await renderDiscover(async ({ host, key, nexts }) => {
    await key('ArrowLeft');
    assert.equal(slideOf(host), 'autonomous', 'nothing before the first slide');
    await key('ArrowRight');
    await key('ArrowRight');
    assert.equal(slideOf(host), 'projects');
    await key('ArrowLeft');
    assert.equal(slideOf(host), 'teams');
    await key('ArrowRight');
    await key('ArrowRight');
    await key('ArrowRight');
    assert.equal(nexts(), 1, '→ on the last slide leaves');
  });
});

test('a TIM without a chosen name: the last button says "Let\'s go"', async () => {
  await renderDiscover(async ({ host, click }) => {
    await click(host.querySelectorAll('[data-segment]')[DISCOVER_SLIDE_IDS.length - 1]);
    assert.equal(host.querySelector('[data-discover-finish]')?.textContent, t('onboarding.discover.finishNoName'));
  }, { ...AGENT, name: '_main', named: false });
});
