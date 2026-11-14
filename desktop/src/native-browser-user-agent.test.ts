import assert from 'node:assert/strict';
import test from 'node:test';
import {
  chromeVersion, desktopUserAgent, identityForUrl, identityHeaders, identityOverride, isSigninRequest, isGoogleSigninUrl, mobileUserAgent, signinUserAgent, userAgentMetadata, versionlessUserAgent,
} from './native-browser-user-agent.js';

const ELECTRON_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) '
  + 'Timon/0.1.3 Chrome/130.0.6723.191 Electron/33.4.11 Safari/537.36';

test('the desktop user agent names neither Electron nor the app', () => {
  const ua = desktopUserAgent(ELECTRON_UA);
  assert.equal(ua, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.191 Safari/537.36');
  assert.equal(desktopUserAgent(ua), ua);
});

test('a user agent without an app token is left alone', () => {
  const plain = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
  assert.equal(desktopUserAgent(plain), plain);
});

test('chrome version falls back when the string carries none', () => {
  assert.equal(chromeVersion(ELECTRON_UA), '130.0.6723.191');
  assert.equal(chromeVersion('curl/8'), '130.0.0.0');
  assert.match(mobileUserAgent('130.0.6723.191'), /Chrome\/130\.0\.6723\.191 Mobile Safari/);
});

test('client hints carry no Electron brand and follow the host platform', () => {
  const mac = userAgentMetadata('130.0.6723.191', false, 'darwin', '14.5.0');
  assert.equal(mac.platform, 'macOS');
  assert.equal(mac.platformVersion, '14.5.0');
  assert.ok(mac.brands.every((entry) => !/electron/i.test(entry.brand)));
  assert.equal(mac.brands[0]?.version, '130');
  assert.equal(userAgentMetadata('130.0.0.0', false, 'win32', '10.0.19045').platform, 'Windows');
  assert.equal(userAgentMetadata('130.0.0.0', false, 'linux', '6.14.0').platform, 'Linux');
  const phone = userAgentMetadata('130.0.0.0', true, 'darwin', '14.5.0');
  assert.deepEqual([phone.mobile, phone.platform], [true, 'Android']);
});

test('only https pages of Google\'s sign-in host get the sign-in identity', () => {
  assert.equal(identityForUrl('https://accounts.google.com/v3/signin/identifier?continue=x'), 'googleSignin');
  assert.equal(identityForUrl('https://accounts.google.com/o/oauth2/v2/auth?client_id=1'), 'googleSignin');
  assert.equal(identityForUrl('https://accounts.google.com.evil.example/'), 'chrome');
  assert.equal(identityForUrl('http://accounts.google.com/'), 'chrome');
  assert.equal(identityForUrl('https://www.google.com/'), 'chrome');
  assert.equal(identityForUrl('https://app.example.com/?next=https://accounts.google.com/'), 'chrome');
  assert.equal(identityForUrl('about:blank'), 'chrome');
  assert.equal(isGoogleSigninUrl('not a url'), false);
});

test('on Google\'s sign-in host the UA loses its Chrome version and no brand is announced', () => {
  const ua = desktopUserAgent(ELECTRON_UA);
  assert.equal(versionlessUserAgent(ua), 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari/537.36');
  assert.equal(versionlessUserAgent(mobileUserAgent('130.0.6723.191')), 'Mozilla/5.0 (Linux; Android 14; Timon) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Mobile Safari/537.36');
  const metadata = userAgentMetadata('130.0.6723.191', false, 'darwin', '14.5.0');
  const signin = identityOverride('googleSignin', ua, metadata);
  assert.equal(signin.userAgent, versionlessUserAgent(ua));
  assert.deepEqual(signin.userAgentMetadata.brands.map((entry) => entry.brand), ['Chromium', 'Not_A Brand']);
  assert.deepEqual(signin.userAgentMetadata.fullVersionList.map((entry) => entry.brand), ['Chromium', 'Not_A Brand']);
  assert.equal(signin.userAgentMetadata.platform, 'macOS');
  // Everywhere else the identity stays what it was, Chrome brand included.
  assert.deepEqual(identityOverride('chrome', ua, metadata), { userAgent: ua, userAgentMetadata: metadata });
  assert.ok(metadata.brands.some((entry) => entry.brand === 'Google Chrome'));
});

test('a request header loses Electron\'s tokens, and its Chrome version only on the sign-in host', () => {
  const clean = desktopUserAgent(ELECTRON_UA);
  assert.equal(signinUserAgent(ELECTRON_UA, false), clean);
  assert.equal(signinUserAgent(ELECTRON_UA, true), versionlessUserAgent(clean));
  assert.equal(signinUserAgent(versionlessUserAgent(clean), true), versionlessUserAgent(clean));
});

test('a request carries one coherent identity: versionless UA with Chromium brands, or the full Chrome one', () => {
  const metadata = userAgentMetadata('130.0.6723.191', false, 'linux', '6.14.0');
  const google = 'https://accounts.google.com/v3/signin/identifier?continue=x';
  // A tab sent to Google by its site: the navigation leaves before did-navigate switches the tab.
  assert.equal(isSigninRequest({ url: google, resourceType: 'mainFrame', onSigninPage: false }), true);
  // A site's "Sign in with Google" button frame keeps the site's identity, like its navigator.
  assert.equal(isSigninRequest({ url: google, resourceType: 'subFrame', onSigninPage: false }), false);
  // A popup opened onto Google, or a document already there: all of its requests.
  assert.equal(isSigninRequest({ url: 'https://www.gstatic.com/x.js', resourceType: 'script', onSigninPage: true }), true);
  assert.equal(isSigninRequest({ url: 'https://app.example.com/', resourceType: 'mainFrame', onSigninPage: false }), false);
  const sent = { 'User-Agent': ELECTRON_UA, 'sec-ch-ua': '"Chromium";v="130", "Google Chrome";v="130"', 'sec-ch-ua-full-version-list': 'x', Accept: '*/*' };
  const signin = identityHeaders(sent, true, metadata);
  assert.equal(signin['User-Agent'], versionlessUserAgent(desktopUserAgent(ELECTRON_UA)));
  assert.equal(signin['sec-ch-ua'], '"Chromium";v="130", "Not_A Brand";v="24"');
  assert.doesNotMatch(signin['sec-ch-ua-full-version-list']!, /Google Chrome/);
  assert.equal(signin.Accept, '*/*');
  const site = identityHeaders(sent, false, metadata);
  assert.equal(site['User-Agent'], desktopUserAgent(ELECTRON_UA));
  assert.match(site['sec-ch-ua']!, /"Google Chrome";v="130"/);
  assert.equal(identityHeaders({ Accept: '*/*' }, true, metadata).Accept, '*/*', 'no hint header is added where none was sent');
});
