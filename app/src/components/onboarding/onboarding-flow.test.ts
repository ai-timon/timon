/**
 * The onboarding's frame: the registry follows the mockup's order, the dots
 * cover the account up to the agent, "Back" goes back (sub-views first,
 * skipped steps skipped both ways), a step reopens from its URL, the language
 * applies at once, and the routes around it agree (login, gate, session).
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test from 'node:test';
import { getLocale, setLocale, t } from '@/lib/i18n';
import { pageRequiresLogin, shouldRedirectOn401 } from '@/lib/auth';
import { FIRST_RUN_PATH, WELCOME_PATH, firstRunTarget, schemeFollowsSystem } from '@/lib/first-run-gate';
import { applyLanguage, LANGUAGE_DWELL_MS, languageDwell, type LanguageTarget } from './language';
import {
  afterSplash, asksFormerChatStep, canGoBack, DOTTED_STEPS, isLastStep, loginOpensWelcome, nextStep, ONBOARDING_PATH, ONBOARDING_STEP_IDS,
  openedFromOnboarding, previousStep, progressDots, RETURNING_STEP_IDS, SETUP_AGENT_FROM_ONBOARDING, stepFromSearch, stepHref,
} from './onboarding-flow';
import { signedInTarget } from './welcome-landing';

test('the steps follow the mockup: welcome, background choice, account, LLM, profile, agent, "Discover Timon" — no chat step any more', () => {
  assert.deepEqual([...ONBOARDING_STEP_IDS], ['splash', 'background', 'account', 'llm', 'profile', 'agent', 'discover']);
  assert.equal(nextStep('splash'), 'background', 'the service installs right after the welcome: its question comes first');
  assert.equal(nextStep('background'), 'account');
  assert.equal(nextStep('agent'), 'discover', 'the slides follow the agent\'s creation');
  assert.equal(nextStep('discover'), null, 'the last step: the welcome follows on the TIMs page');
  assert.equal(isLastStep('discover'), true);
  assert.equal(isLastStep('agent'), false);
  assert.equal(isLastStep('signin'), false, 'an out-of-order step goes on by itself');
  assert.equal(isLastStep('profile'), false);
  assert.equal(asksFormerChatStep('?step=chat'), true, 'the former chat step');
  assert.equal(asksFormerChatStep('?step=agent'), false);
  assert.equal(stepFromSearch('?step=chat'), 'splash', 'no step of that name: the shell sends it to the welcome first');
  assert.equal(previousStep('account'), 'background');
  assert.equal(previousStep('background'), 'splash');
  assert.equal(previousStep('splash'), null);
});

test('the registry holds one entry per step, in the same order', async () => {
  const { ONBOARDING_STEPS } = await import('./steps/registry');
  assert.deepEqual(ONBOARDING_STEPS.map((entry) => entry.id), [...ONBOARDING_STEP_IDS, ...RETURNING_STEP_IDS]);
  for (const entry of ONBOARDING_STEPS) assert.equal(typeof entry.Component, 'function', entry.id);
});

test('the background install starts on the account step, which lives in the onboarding', async () => {
  const { ONBOARDING_STEPS } = await import('./steps/registry');
  const { preparationStarts } = await import('@/lib/setup-plan');
  const starts = ONBOARDING_STEPS.filter((entry) => preparationStarts(entry.id, entry.leavesPage !== true)).map((entry) => entry.id);
  assert.equal(starts[0], 'account', 'the first step past the welcome and its background question, whose answer the install carries');
  assert.deepEqual(starts, ['account', 'llm', 'profile', 'agent'], 'every step past the welcome stays in the onboarding; the upgrade welcome and the slides after the agent prepare nothing');
  assert.ok(ONBOARDING_STEPS.every((entry) => entry.leavesPage !== true), 'no stand-in left');
});

test('the dots cover the background choice up to the agent; "Back" shows on those steps only', () => {
  assert.deepEqual([...DOTTED_STEPS], ['background', 'account', 'llm', 'profile', 'agent']);
  assert.equal(progressDots('splash'), null);
  assert.deepEqual(progressDots('background'), ['current', 'todo', 'todo', 'todo', 'todo']);
  assert.deepEqual(progressDots('profile'), ['done', 'done', 'done', 'current', 'todo']);
  assert.deepEqual(ONBOARDING_STEP_IDS.filter(canGoBack), ['background', 'account', 'llm', 'profile', 'agent']);
  assert.equal(progressDots('discover'), null, 'the slides have their own progress bars');
  assert.equal(canGoBack('discover'), false, 'the agent is made: no way back to its creation');
});

test('a step reopens from its URL; an unknown one opens the welcome', () => {
  for (const id of ONBOARDING_STEP_IDS) assert.equal(stepFromSearch(new URL(stepHref(id), 'http://x').search), id);
  assert.equal(stepHref('splash'), ONBOARDING_PATH);
  assert.equal(stepFromSearch('?step=nope'), 'splash');
  assert.equal(stepFromSearch(''), 'splash');
});

test('the login hands a fresh install to the welcome, whose account step makes the account', () => {
  assert.equal(loginOpensWelcome(true), true);
  assert.equal(loginOpensWelcome(false), false, 'an install with an account signs in');
});

test('an account made before this onboarding meets the welcome, then signs in, then the mascot', async () => {
  assert.equal(loginOpensWelcome(false, 'returning'), true);
  assert.equal(loginOpensWelcome(false, 'mascot'), false, 'a signed-in stage never sends the login anywhere');
  assert.equal(afterSplash(true), 'signin');
  assert.equal(afterSplash(false), 'background');
  for (const id of RETURNING_STEP_IDS) {
    assert.equal(stepFromSearch(new URL(stepHref(id), 'http://x').search), id, 'reopens from its URL');
    assert.equal(nextStep(id), null, 'outside the order: each goes on by itself');
    assert.equal(previousStep(id), null);
    assert.equal(canGoBack(id), false);
    assert.equal(progressDots(id), null);
  }
  const landing = async (): Promise<string> => '/chat';
  assert.equal(await signedInTarget({ welcome: 'mascot' }, landing), '/onboarding?step=mascot');
  assert.equal(await signedInTarget({ welcome: null }, landing), '/chat');
  assert.equal(await signedInTarget({}, landing), '/chat', 'a daemon older than the field');
});

test('the onboarding is reachable before any session, and the first-run gate leaves it alone', () => {
  assert.equal(pageRequiresLogin('/onboarding'), false);
  assert.equal(shouldRedirectOn401('/onboarding', '/api/ui/capabilities'), false, 'no bounce to /login from the welcome');
  assert.equal(pageRequiresLogin('/onboarding-admin'), true, 'only the onboarding itself');
  assert.equal(firstRunTarget({ pathname: '/onboarding', firstRun: true, canConfigure: true }), null);
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true, canConfigure: true }), stepHref('llm'), 'a signed-in fresh install goes on with the onboarding, past its account');
  assert.equal(FIRST_RUN_PATH, stepHref('llm'));
  assert.equal(firstRunTarget({ pathname: '/onboarding', firstRun: false, teamOnboarding: true, mainAgentOnboarding: true, canConfigure: true }), null);
  assert.equal(firstRunTarget({ pathname: '/', firstRun: false, teamOnboarding: true, mainAgentOnboarding: true, canConfigure: true }), WELCOME_PATH, 'past the agent step, the welcome on the TIMs page');
  assert.equal(schemeFollowsSystem('/onboarding'), true, 'the welcome follows the OS scheme, like the login');
});

test('every stand-in hands over to a page the first-run gate lets through', async () => {
  for (const href of ['/login', SETUP_AGENT_FROM_ONBOARDING]) {
    const { pathname } = new URL(href, 'http://x');
    assert.equal(firstRunTarget({ pathname, firstRun: true, canConfigure: true }), null, href);
  }
});

test('the main agent\'s screen knows the LLM step already showed the provider cards', () => {
  assert.equal(openedFromOnboarding(new URL(SETUP_AGENT_FROM_ONBOARDING, 'http://x').search), true);
  assert.equal(openedFromOnboarding(''), false, 'the gate opens it bare: its own "Your AIs" stays');
  assert.equal(openedFromOnboarding('?from=elsewhere'), false);
});

test('a language picked on the roller applies at once and is remembered', async () => {
  const before = getLocale();
  const target: LanguageTarget = { cookie: '', documentElement: { lang: 'en', dir: 'ltr' } };
  try {
    assert.equal(await applyLanguage('fr', target), 'fr');
    assert.equal(t('onboarding.continue'), 'Continuer');
    assert.equal(target.documentElement.lang, 'fr');
    assert.match(target.cookie, /^timon-locale=fr;/);
    assert.equal(await applyLanguage('xx', target), 'fr', 'an unknown language keeps the current one');
    assert.equal(await applyLanguage('de', target), 'de');
    assert.equal(t('onboarding.continue'), 'Weiter');
    // Any message German still lacks (TODO #900 translates them one by one): it reads in English.
    const { readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const flat = (d: Record<string, unknown>, p = ''): [string, string][] => Object.entries(d).flatMap(([k, v]) => (v && typeof v === 'object' ? flat(v as Record<string, unknown>, `${p}${k}.`) : [[`${p}${k}`, String(v)] as [string, string]]));
    const read = (tag: string) => { const f = join(process.cwd(), 'src', 'locales', tag, 'onboarding.json'); return existsSync(f) ? new Map(flat(JSON.parse(readFileSync(f, 'utf8')) as Record<string, unknown>)) : new Map<string, string>(); };
    const german = read('de');
    const lacking = [...read('en')].find(([key, text]) => !german.has(key) && !/[{}]/.test(text));
    if (lacking) assert.equal(t(lacking[0]), lacking[1], `a message German lacks (${lacking[0]}) reads in English`);
  } finally {
    setLocale(before);
  }
});

test('the roller applies a language after a short rest on it, not every row a drag crosses', () => {
  const applied: string[] = [];
  let clock = 0;
  const queue = new Map<number, { at: number; run: () => void }>();
  let ids = 0;
  const timers = {
    set: (run: () => void, ms: number): unknown => { ids += 1; queue.set(ids, { at: clock + ms, run }); return ids; },
    clear: (handle: unknown): void => { queue.delete(handle as number); },
  };
  const advance = (ms: number): void => {
    clock += ms;
    for (const [id, job] of [...queue]) if (job.at <= clock) { queue.delete(id); job.run(); }
  };
  const dwell = languageDwell('en', (tag) => applied.push(tag), { timers });

  for (const tag of ['fr', 'de', 'es', 'it']) { dwell.cross(tag); advance(30); }
  assert.deepEqual(applied, [], 'a drag across four rows loads none of them');
  advance(LANGUAGE_DWELL_MS);
  assert.deepEqual(applied, ['it'], 'the row it rests on applies');
  dwell.rest('it');
  assert.deepEqual(applied, ['it'], 'the stop applies nothing twice');

  dwell.cross('nl');
  dwell.rest('nl');
  advance(LANGUAGE_DWELL_MS);
  assert.deepEqual(applied, ['it', 'nl'], 'released on a row: applied at once, once');

  dwell.cross('pl');
  dwell.flush();
  dwell.flush();
  assert.deepEqual(applied, ['it', 'nl', 'pl'], 'leaving mid-rest keeps the language in the middle');
  dwell.cross('en');
  dwell.cross('pl');
  advance(LANGUAGE_DWELL_MS);
  assert.deepEqual(applied, ['it', 'nl', 'pl'], 'back to the applied one: nothing to load');
});

test('every language the app ships has its flag on the roller', async () => {
  const { FLAGS } = await import('./language-flags');
  const { readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const locales = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'locales');
  const shipped = readdirSync(locales, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort();
  assert.deepEqual(Object.keys(FLAGS).sort(), shipped);
});
