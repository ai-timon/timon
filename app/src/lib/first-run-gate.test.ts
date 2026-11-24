import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_RUN_PATH, MAIN_AGENT_REPAIR_PATH, WELCOME_PATH, firstRunTarget, schemeFollowsSystem, firstRunScheme } from './first-run-gate';

/**
 * The real journey of 04/09/2026, the one nobody had played: package
 * launched, account created, home reached — and the blocking screen of step 5.7.4
 * never shown, hence no service installed.
 */
test('the "account created → home" journey goes through the onboarding', () => {
  // 1. Anonymous: we do not divert to a screen that needs a session.
  assert.equal(firstRunTarget({ pathname: '/login', firstRun: true }), null);
  // 2. Account created, the login page sends to the home page…
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true }), FIRST_RUN_PATH);
  // 3. …and every other page of the product sends there too.
  for (const page of ['/dashboard', '/missions', '/chat', '/plugins', '/settings/general']) {
    assert.equal(firstRunTarget({ pathname: page, firstRun: true }), FIRST_RUN_PATH);
  }
  // 4. Neither the journey nor the repair screen send back to themselves.
  assert.equal(firstRunTarget({ pathname: '/onboarding', firstRun: true }), null);
  assert.equal(firstRunTarget({ pathname: '/setup', firstRun: true }), null);
});

test('a configured install never sees this screen', () => {
  for (const page of ['/', '/dashboard', '/setup']) {
    assert.equal(firstRunTarget({ pathname: page, firstRun: false }), null);
  }
});

test('as long as the capabilities are unknown, nothing is diverted', () => {
  // Otherwise `/setup` would flicker on the cold start of every install.
  assert.equal(firstRunTarget({ pathname: '/', firstRun: undefined }), null);
});

test('path variants do not serve as a bypass', () => {
  assert.equal(firstRunTarget({ pathname: '/dashboard/', firstRun: true }), FIRST_RUN_PATH);
  assert.equal(firstRunTarget({ pathname: '/login/', firstRun: true }), null);
  // A sub-path of /setup stays in the onboarding.
  assert.equal(firstRunTarget({ pathname: '/setup/anything', firstRun: true }), null);
  // …but a path that STARTS with the same letters does not.
  assert.equal(firstRunTarget({ pathname: '/setup-other', firstRun: true }), FIRST_RUN_PATH);
});

/**
 * We redirect with `replace`: sending someone to a screen they cannot
 * display would lock them in with no history to go back. Trapping a user
 * is worse than the bug this guard fixes.
 */
test('a visitor who cannot see /setup is not sent there', () => {
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true, canConfigure: false }), null);
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true, canConfigure: true }), FIRST_RUN_PATH);
  // Not filled in = the normal case (first-launch superadmin, surfaces
  // not restricted): we redirect.
  assert.equal(firstRunTarget({ pathname: '/', firstRun: true }), FIRST_RUN_PATH);
});


test('team setup survives configuration and redirects until completed', () => {
  assert.equal(firstRunTarget({ pathname: '/', firstRun: false, teamOnboarding: true }), '/setup/team');
  assert.equal(firstRunTarget({ pathname: '/setup', firstRun: false, teamOnboarding: true }), '/setup/team');
  assert.equal(firstRunTarget({ pathname: '/setup/team', firstRun: false, teamOnboarding: true }), null);
  assert.equal(firstRunTarget({ pathname: '/login', firstRun: false, teamOnboarding: true }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: false, teamOnboarding: false }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: false, teamOnboarding: true, canConfigure: false }), null);
  assert.equal(firstRunTarget({ pathname: '/agents', firstRun: true, teamOnboarding: true }), FIRST_RUN_PATH);
});

test('until the main agent ends its welcome, every page leads to the TIMs page, where it speaks', () => {
  const pending = { firstRun: false, teamOnboarding: true, mainAgentOnboarding: true };
  assert.equal(WELCOME_PATH, '/bots');
  for (const pathname of ['/', '/agents', '/chat', '/settings', '/setup/team']) {
    assert.equal(firstRunTarget({ pathname, ...pending }), WELCOME_PATH, pathname);
  }
  assert.equal(firstRunTarget({ pathname: '/bots', ...pending }), null, 'the welcome itself');
  assert.equal(firstRunTarget({ pathname: '/bots/', ...pending }), null);
  // `/setup/agent` stays reachable as the repair screen, the onboarding and the login too.
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...pending }), null);
  assert.equal(firstRunTarget({ pathname: '/onboarding', ...pending }), null);
  assert.equal(firstRunTarget({ pathname: '/login', ...pending }), null);
  // The TIMs page out of reach (module off, a role without the surface): the repair screen hosts the welcome.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, welcomeAvailable: false }), MAIN_AGENT_REPAIR_PATH);
  assert.equal(firstRunTarget({ pathname: '/bots', ...pending, welcomeAvailable: false }), MAIN_AGENT_REPAIR_PATH);
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...pending, welcomeAvailable: false }), null);
  // A viewer who may not configure is never held.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, canConfigure: false }), null);
  // Answered: the team screen becomes the destination again.
  const answered = { firstRun: false, teamOnboarding: true, mainAgentOnboarding: false };
  assert.equal(firstRunTarget({ pathname: '/setup/agent', ...answered }), '/setup/team');
});

test('a skipped step 3 lets the cockpit open: the gate no longer sends anyone back to /setup/agent', () => {
  // `skipMainAgent` answers step 3 AND closes the team step: both flags drop together.
  const skipped = { firstRun: false, teamOnboarding: false, mainAgentOnboarding: false };
  for (const pathname of ['/', '/agents', '/chat', '/settings']) {
    assert.equal(firstRunTarget({ pathname, ...skipped }), null, pathname);
  }
});

test('onboarding takes its light/dark from the OS, the rest of the product does not', () => {
  for (const path of ['/login', '/login/', '/setup', '/setup/agent', '/setup/team', '/setup/restart']) {
    assert.equal(schemeFollowsSystem(path), true, path);
  }
  for (const path of ['/', '/agents', '/settings', '/setups', '/loginx']) {
    assert.equal(schemeFollowsSystem(path), false, path);
  }
});

test('the restart no longer holds anyone: the banner offers it', () => {
  const pending = { firstRun: false, restartOnboarding: true };
  for (const pathname of ['/', '/agents', '/setup', '/setup/restart']) {
    assert.equal(firstRunTarget({ pathname, ...pending }), null, pathname);
  }
  // The welcome still comes first.
  assert.equal(firstRunTarget({ pathname: '/', ...pending, teamOnboarding: true, mainAgentOnboarding: true }), WELCOME_PATH);
});

test('the onboarding opens dark for everyone, whatever the OS, until someone picks', () => {
  const globals = globalThis as { window?: unknown };
  assert.equal(firstRunScheme(), undefined, 'no browser, no scheme');
  for (const light of [true, false]) {
    globals.window = { matchMedia: () => ({ matches: light }), sessionStorage: { getItem: () => null } };
    try { assert.equal(firstRunScheme(), 'dark', `OS ${light ? 'light' : 'dark'}: dark`); } finally { delete globals.window; }
  }
});
