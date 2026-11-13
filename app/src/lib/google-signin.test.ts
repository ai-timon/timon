import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMPTY_TAB_TRAIL, googleSigninContinue, googleSigninPlan, googleSigninStartUrl, isGoogleAccountsPage, isGoogleOAuthFlow,
  isGoogleSigninRejected, noteUserTab, oauthRedirectOrigin, trackBrowserTabs, type BrowserTabTrail,
} from './google-signin';

/** The page the embedded browser landed on in the report that started this work. */
const REJECTED = 'https://accounts.google.com/v3/signin/rejected?continue=https%3A%2F%2Fwww.google.com%2F&dsh=S1&flowName=GlifWebSignIn&flowEntry=ServiceLogin';
const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1.apps.googleusercontent.com&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback&response_type=code';
const OAUTH_REJECTED = `https://accounts.google.com/v3/signin/rejected?continue=${encodeURIComponent(`https://accounts.google.com/signin/oauth/consent?authuser=0&continue=${encodeURIComponent(OAUTH_AUTH)}`)}&flowName=GeneralOAuthFlow`;

test('the refusal page is recognised in its known shapes, and only on Google\'s host', () => {
  assert.equal(isGoogleSigninRejected(REJECTED), true);
  assert.equal(isGoogleSigninRejected('https://accounts.google.com/signin/rejected?rrk=46'), true);
  assert.equal(isGoogleSigninRejected('https://accounts.google.com/signin/v2/rejected'), true);
  assert.equal(isGoogleSigninRejected('https://accounts.google.com/v2/signin/rejected/'), true);
  assert.equal(isGoogleSigninRejected('https://accounts.google.com/v3/signin/identifier?continue=x'), false);
  assert.equal(isGoogleSigninRejected('https://accounts.google.com.evil.example/v3/signin/rejected'), false);
  assert.equal(isGoogleSigninRejected('http://accounts.google.com/v3/signin/rejected'), false);
  assert.equal(isGoogleSigninRejected('https://evil.example/v3/signin/rejected'), false);
  assert.equal(isGoogleSigninRejected('not a url'), false);
  assert.equal(isGoogleAccountsPage('https://accounts.google.com/'), true);
  assert.equal(isGoogleAccountsPage('https://myaccount.google.com/'), false);
  assert.equal(isGoogleAccountsPage(undefined), false);
});

test('the page to return to is kept only when it is https', () => {
  assert.equal(googleSigninContinue(REJECTED), 'https://www.google.com/');
  assert.equal(googleSigninContinue('https://accounts.google.com/v3/signin/rejected?continue=javascript%3Aalert(1)'), null);
  assert.equal(googleSigninContinue('https://accounts.google.com/v3/signin/rejected?continue=http%3A%2F%2Fexample.com%2F'), null);
  assert.equal(googleSigninContinue('https://accounts.google.com/v3/signin/rejected'), null);
  assert.equal(googleSigninContinue('https://example.com/?continue=https%3A%2F%2Fwww.google.com%2F'), null);
});

test('Google\'s sign-in page carries an https continue, encoded, and drops anything else', () => {
  const url = new URL(googleSigninStartUrl('https://www.google.com/search?q=a&b=c'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/ServiceLogin');
  assert.equal(url.searchParams.get('continue'), 'https://www.google.com/search?q=a&b=c');
  assert.equal(new URL(googleSigninStartUrl('javascript:alert(1)')).searchParams.has('continue'), false);
  assert.equal(new URL(googleSigninStartUrl(null)).searchParams.has('continue'), false);
});

test('a "Sign in with Google" flow is told from a sign-in to Google, and its site read from redirect_uri', () => {
  assert.equal(isGoogleOAuthFlow(REJECTED), false);
  assert.equal(isGoogleOAuthFlow(OAUTH_REJECTED), true);
  assert.equal(isGoogleOAuthFlow(OAUTH_AUTH), true);
  assert.equal(isGoogleOAuthFlow('https://accounts.google.com/v3/signin/rejected?flowName=GeneralOAuthLite'), true);
  assert.equal(oauthRedirectOrigin(OAUTH_REJECTED), 'https://app.example.com/');
  assert.equal(oauthRedirectOrigin(REJECTED), null);
});

const tab = (id: string, url: string) => ({ id, url });
function trail(...readings: Array<{ tabs: { id: string; url: string }[]; activeTabId: string | null }>): BrowserTabTrail {
  return readings.reduce(trackBrowserTabs, EMPTY_TAB_TRAIL);
}

test('a sign-in to Google itself returns to the page Google named', () => {
  const seen = trail({ tabs: [tab('a', 'https://www.google.com/')], activeTabId: 'a' }, { tabs: [tab('a', REJECTED)], activeTabId: 'a' });
  const plan = googleSigninPlan(seen, 'a', REJECTED);
  assert.equal(plan.oauth, false);
  assert.equal(new URL(plan.startUrl!).searchParams.get('continue'), 'https://www.google.com/');
  assert.equal(plan.returnUrl, 'https://www.google.com/');
  assert.deepEqual([plan.returnTabId, plan.closeTabId], ['a', null]);
  // No https page named: the account page, never a reload of the refusal.
  assert.equal(googleSigninPlan(seen, 'a', 'https://accounts.google.com/signin/rejected').returnUrl, 'https://myaccount.google.com/');
});

test('a site that sends its own tab to Google: Chrome opens on the site, and the tab returns there', () => {
  const seen = trail(
    { tabs: [tab('a', 'https://app.example.com/login')], activeTabId: 'a' },
    { tabs: [tab('a', OAUTH_REJECTED)], activeTabId: 'a' },
  );
  const plan = googleSigninPlan(seen, 'a', OAUTH_REJECTED);
  assert.equal(plan.oauth, true);
  assert.equal(plan.startUrl, 'https://app.example.com/login');
  assert.equal(plan.returnUrl, 'https://app.example.com/login');
  assert.deepEqual([plan.returnTabId, plan.closeTabId], ['a', null]);
});

test('a sign-in popup: Chrome opens on the opener\'s site, the popup closes and the opener returns', () => {
  const seen = trail(
    { tabs: [tab('a', 'https://app.example.com/')], activeTabId: 'a' },
    // Firebase-like: the popup first shows the site's own handler, then Google.
    { tabs: [tab('a', 'https://app.example.com/'), tab('p', 'https://app-example.firebaseapp.com/__/auth/handler?apiKey=k')], activeTabId: 'p' },
    { tabs: [tab('a', 'https://app.example.com/'), tab('p', OAUTH_REJECTED)], activeTabId: 'p' },
  );
  const plan = googleSigninPlan(seen, 'p', OAUTH_REJECTED);
  assert.equal(plan.startUrl, 'https://app.example.com/');
  assert.equal(plan.returnUrl, 'https://app.example.com/');
  assert.deepEqual([plan.returnTabId, plan.closeTabId], ['a', 'p']);
});

test('a tab the user opened by hand is no popup of the page that was active', () => {
  const seen = trail(
    { tabs: [tab('a', 'https://other.example/')], activeTabId: 'a' },
  );
  const after = [
    { tabs: [tab('a', 'https://other.example/'), tab('b', 'about:blank')], activeTabId: 'b' },
    { tabs: [tab('a', 'https://other.example/'), tab('b', 'https://app.example.com/login')], activeTabId: 'b' },
    { tabs: [tab('a', 'https://other.example/'), tab('b', OAUTH_REJECTED)], activeTabId: 'b' },
  ].reduce(trackBrowserTabs, noteUserTab(seen));
  const plan = googleSigninPlan(after, 'b', OAUTH_REJECTED);
  assert.equal(plan.startUrl, 'https://app.example.com/login');
  assert.deepEqual([plan.returnTabId, plan.closeTabId], ['b', null]);
});

test('without any page of the site, Chrome replays Google\'s flow and the tab returns to the redirect origin', () => {
  const seen = trail({ tabs: [tab('a', OAUTH_REJECTED)], activeTabId: 'a' });
  const plan = googleSigninPlan(seen, 'a', OAUTH_REJECTED);
  assert.equal(plan.oauth, true);
  assert.equal(new URL(plan.startUrl!).pathname, '/signin/oauth/consent');
  assert.equal(plan.returnUrl, 'https://app.example.com/');
  assert.equal(plan.closeTabId, null, 'tabs already open at the first reading have no known opener');
});

test('a closed tab leaves the trail', () => {
  const seen = trail(
    { tabs: [tab('a', 'https://app.example.com/'), tab('b', 'https://b.example/')], activeTabId: 'a' },
    { tabs: [tab('a', 'https://app.example.com/')], activeTabId: 'a' },
  );
  assert.deepEqual(Object.keys(seen.site), ['a']);
  assert.deepEqual(seen.seen, ['a']);
});
