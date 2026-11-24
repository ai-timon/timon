/**
 * Changing language on the welcome screen changes the step titles too.
 *
 * The maintainer saw the text follow the roller but not the titles (0.1.7-rc.1): they
 * were never translated outside English and French, so every other language
 * showed them in English. The rendered test switches language on the real
 * welcome and account steps; the guard below holds every language to the
 * titles and subtitles of every step.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_PATHS, discoverLocales, lookup, readLocaleDictionary } from '../../../scripts/build-locales.mjs';

/** What each step shows in large type, and the line under it; the switch above them. */
const STEP_HEADINGS = [
  'onboarding.splash.title', 'onboarding.splash.subtitle', 'onboarding.splash.hint',
  'onboarding.account.title', 'onboarding.account.subtitle', 'onboarding.account.privacy',
  'onboarding.llm.title', 'onboarding.llm.subtitle',
  'onboarding.profile.title', 'onboarding.profile.subtitle',
  'onboarding.agent.templates.title', 'onboarding.agent.templates.subtitle',
  'onboarding.agent.interview.title', 'onboarding.agent.interview.subtitle',
  'onboarding.agent.sheet.title', 'onboarding.agent.sheet.subtitle',
  'onboarding.signin.title', 'onboarding.signin.subtitle',
  'onboarding.mascot.title', 'onboarding.mascot.subtitle',
  'onboarding.discover.autonomous.title', 'onboarding.discover.autonomous.body',
  'onboarding.discover.teams.title', 'onboarding.discover.teams.body',
  'onboarding.discover.projects.title', 'onboarding.discover.projects.body',
  'onboarding.discover.connected.title', 'onboarding.discover.connected.body',
  'onboarding.discover.next', 'onboarding.discover.skip',
  'onboarding.preparation.title',
  'onboarding.scheme.label', 'onboarding.scheme.light', 'onboarding.scheme.dark',
];

test('every language carries the title and subtitle of every onboarding step', () => {
  const english = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, 'en'));
  for (const key of STEP_HEADINGS) assert.equal(typeof lookup(english, key), 'string', `en: ${key}`);
  for (const { tag } of discoverLocales()) {
    const dictionary = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, tag));
    const missing = STEP_HEADINGS.filter((key) => typeof lookup(dictionary, key) !== 'string');
    assert.deepEqual(missing, [], `${tag} would show these in English`);
  }
});

test('switching language on the welcome screen translates the titles, then the next step’s', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'MutationObserver', 'Event', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async () => new Response(JSON.stringify({ user: null, needsSetup: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { getLocale, loadLocale } = await import('@/lib/i18n');
  const { OnboardingShell } = await import('./onboarding-shell');
  const { useOnboarding } = await import('./onboarding-context');
  const { SplashStep } = await import('./steps/splash');
  const { AccountStep } = await import('./steps/account');
  const { legacyStep } = await import('./steps/legacy-step');
  const h = React.createElement;
  // The roller's own gestures are another test's business: this calls what it calls.
  function Welcome(): React.ReactElement {
    const { setLanguage, next } = useOnboarding();
    return h('div', null,
      h('button', { 'data-lang': 'fr', onClick: () => { void setLanguage('fr'); } }),
      h('button', { 'data-lang': 'es', onClick: () => { void setLanguage('es'); } }),
      h('button', { 'data-next': '', onClick: next }),
      h(SplashStep));
  }
  const host = dom.window.document.getElementById('root')!;
  const root = createRoot(host);
  const title = (): string => host.querySelector('h1')?.textContent ?? '';
  const press = async (selector: string): Promise<void> => {
    await React.act(async () => {
      (host.querySelector(selector) as HTMLElement).click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };
  const initial = getLocale();
  try {
    await React.act(async () => {
      root.render(h(OnboardingShell, {
        // The background question is another test's business: stepped over here, as on a machine with nothing to ask.
        steps: [{ id: 'splash', Component: Welcome }, { id: 'background', Component: legacyStep(null) }, { id: 'account', Component: AccountStep }],
        companions: [],
        gate: ({ children }: { children: React.ReactNode }) => h(React.Fragment, null, children),
      }));
    });
    assert.equal(title(), 'Your AI team,\nat home.');
    await press('[data-lang="fr"]');
    assert.equal(title(), 'Votre équipe d’IA,\nchez vous.'); // french-ok: the French locale under test
    await press('[data-lang="es"]');
    assert.equal(title(), 'Tu equipo de IA,\nen casa.', 'a language other than French translates the title too');
    await press('[data-next]');
    assert.equal(title(), 'Crea tu cuenta local');
  } finally {
    await React.act(async () => { root.unmount(); });
    await loadLocale(initial);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
