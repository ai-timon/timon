import assert from 'node:assert/strict';
import test from 'node:test';
import en from '@/locales/en/core.json';
import fr from '@/locales/fr/core.json';
import { LATER_HINT_MS, LATER_HINT_TOAST_ID, declineTourOffer, GUIDED_TOUR_ENABLED, shouldAutoStartTour, shouldOfferTour } from './guided-tour';

// The rules below are the tour's own, read with the tour switched on.
const offerOn = (s: Parameters<typeof shouldOfferTour>[0]) => shouldOfferTour(s, true);
const autoStartOn = (s: Parameters<typeof shouldAutoStartTour>[0]) => shouldAutoStartTour(s, true);

test('the guided tour is switched off for the launch: no offer, no start after the welcome', () => {
  assert.equal(GUIDED_TOUR_ENABLED, false);
  const state = { pathname: '/', firstRun: false, offered: false } as const;
  assert.equal(shouldOfferTour(state), false);
  assert.equal(shouldAutoStartTour({ pathname: '/', firstRun: false, armed: true }), false);
});

const base = { pathname: '/', firstRun: false, offered: false } as const;

test('the tour is offered once, on a configured install, inside the app', () => {
  assert.equal(offerOn({ ...base }), true);
  assert.equal(offerOn({ ...base, pathname: '/chat' }), true);
});

test('it is not offered while anything is unknown or still being set up', () => {
  assert.equal(offerOn({ ...base, offered: null }), false, 'the account row is not read yet');
  assert.equal(offerOn({ ...base, offered: true }), false, 'already answered');
  assert.equal(offerOn({ ...base, firstRun: undefined }), false, 'capabilities not loaded');
  assert.equal(offerOn({ ...base, firstRun: true }), false);
  for (const step of ['teamOnboarding', 'mainAgentOnboarding', 'restartOnboarding'] as const) {
    assert.equal(offerOn({ ...base, [step]: true }), false, step);
  }
});

test('it is never offered on login, the setup or an invitation', () => {
  for (const pathname of ['/login', '/setup', '/setup/restart', '/invite', '/confirm-email/abc']) {
    assert.equal(offerOn({ ...base, pathname }), false, pathname);
  }
});

test('the conversation opens in a pinned popup that follows the tour, not on the chat page', async () => {
  const { announceIslandWorkspace } = await import('./island-bus');
  const opened: Array<{ type: string; edge: string; pinned: boolean | undefined; mission: unknown }> = [];
  const off = announceIslandWorkspace({
    open: (content, edge, pinned) => { opened.push({ type: content.type, edge, pinned, mission: content.params.missionId }); return true; },
    activate: () => {},
    close: () => {},
  });
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    return String(url).endsWith('/api/ui/missions')
      ? new Response(JSON.stringify({ mission_id: 'm-tour' }), { status: 200 })
      : new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const { startOnboardingTour } = await import('./guided-tour');
    const out = await startOnboardingTour('hello', { agent: 'nova' });
    assert.deepEqual(out, { ok: true, missionId: 'm-tour' });
    assert.deepEqual(opened, [{ type: '@timon/missions:chat', edge: 'float', pinned: true, mission: 'm-tour' }]);
    assert.ok(urls.includes('/api/ui/navigate/grant'), 'the grant is created by the same click');
  } finally {
    globalThis.fetch = realFetch;
    off();
  }
});

test('right after the setup the tour starts on its own, restart pending or not', () => {
  const base = { pathname: '/', firstRun: false, armed: true };
  assert.equal(autoStartOn(base), true);
  assert.equal(autoStartOn({ ...base, armed: false }), false);
  assert.equal(autoStartOn({ ...base, mainAgentOnboarding: true }), false);
  assert.equal(autoStartOn({ ...base, firstRun: undefined }), false);
  assert.equal(autoStartOn({ ...base, pathname: '/setup/agent' }), false);
});

test('"Not now" answers the offer and says where the tour stays', () => {
  const shown: Array<{ message: string; id: string; duration: number }> = [];
  let marked = 0;
  declineTourOffer(
    (message, opts) => { shown.push({ message, ...opts }); },
    'hint',
    async () => { marked += 1; },
  );
  assert.equal(marked, 1, 'the offer is not shown again');
  assert.deepEqual(shown, [{ message: 'hint', id: LATER_HINT_TOAST_ID, duration: LATER_HINT_MS }]);
  assert.ok(Number.isFinite(LATER_HINT_MS), 'a hint, not a card left open');
});

test('the hint and the offer name the menu entry that starts the tour, in every locale', () => {
  for (const [locale, root] of [['en', en], ['fr', fr]] as const) {
    const { menu, offer } = root.guidedTour;
    assert.ok(offer.laterHint.includes(menu), `${locale}: laterHint names "${menu}"`);
    assert.ok(offer.body.includes(menu), `${locale}: the offer names "${menu}"`);
  }
});
