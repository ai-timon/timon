// french-ok-file: an accented value, the UTF-8 framing under test
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acceptableChromeExecutable, chromeEnvironment, chromeLaunchArguments, electronCookieFrom, framePipeMessage, PipeFrames,
  type ChromeCookie,
} from './native-browser-chrome.js';
import { KEPT_SESSION_COOKIE_DAYS } from './native-browser-cookies.js';

const NOW = Date.UTC(2026, 9, 12);
const cookie = (overrides: Partial<ChromeCookie>): ChromeCookie => ({
  name: 'SID', value: 'secret-value', domain: '.google.com', path: '/', expires: NOW / 1000 + 86_400,
  session: false, secure: true, httpOnly: true, sameSite: 'None', ...overrides,
});

test('only a closed list of absolute browser paths may be launched', () => {
  assert.equal(acceptableChromeExecutable('/usr/bin/google-chrome', 'linux'), true);
  assert.equal(acceptableChromeExecutable('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'darwin'), true);
  assert.equal(acceptableChromeExecutable('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'win32'), true);
  assert.equal(acceptableChromeExecutable('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\MSEDGE.EXE', 'win32'), true);
  for (const refused of ['google-chrome', './google-chrome', '/bin/sh', '/usr/bin/curl', '', '/usr/bin/chrome\0', 42, null]) {
    assert.equal(acceptableChromeExecutable(refused, 'linux'), false, String(refused));
  }
  assert.equal(acceptableChromeExecutable('C:\\Windows\\System32\\cmd.exe', 'win32'), false);
  // A relative path is no path at all on Windows either.
  assert.equal(acceptableChromeExecutable('chrome.exe', 'win32'), false);
});

test('the launch flags are the measured ones and leave the automation bar off', () => {
  const args = chromeLaunchArguments('/home/sam/.timon/browser-profiles/bp-1/chrome', 'https://accounts.google.com/');
  assert.ok(args.includes('--remote-debugging-pipe'));
  assert.ok(args.includes('--disable-blink-features=AutomationControlled'));
  assert.ok(args.includes('--user-data-dir=/home/sam/.timon/browser-profiles/bp-1/chrome'));
  assert.ok(!args.some((arg) => arg.includes('--enable-automation')));
  assert.ok(!args.some((arg) => arg.startsWith('--headless')));
  assert.equal(args.at(-1), 'https://accounts.google.com/');
});

test('pipe messages are split on NUL and survive being cut anywhere', () => {
  const frames = new PipeFrames();
  const whole = Buffer.concat([framePipeMessage({ id: 1, result: { a: 'é' } }), framePipeMessage({ id: 2 })]);
  const received: string[] = [];
  for (let at = 0; at < whole.length; at += 3) received.push(...frames.push(whole.subarray(at, at + 3)));
  assert.deepEqual(received.map((text) => JSON.parse(text)), [{ id: 1, result: { a: 'é' } }, { id: 2 }]);
});

test('an unterminated message that grows without bound is refused', () => {
  const frames = new PipeFrames(16);
  assert.throws(() => frames.push(Buffer.alloc(32, 65)), /too large/);
});

test('a domain cookie keeps its leading dot, path, flags, SameSite and expiry', () => {
  const copy = electronCookieFrom(cookie({ path: '/accounts', httpOnly: false, sameSite: 'Strict' }), NOW);
  assert.deepEqual(copy, {
    url: 'https://google.com/accounts', name: 'SID', value: 'secret-value', path: '/accounts', secure: true,
    httpOnly: false, sameSite: 'strict', domain: '.google.com', expirationDate: NOW / 1000 + 86_400,
  });
});

test('a host-only cookie is set without a Domain attribute', () => {
  const copy = electronCookieFrom(cookie({ domain: 'accounts.google.com', sameSite: undefined }), NOW);
  assert.equal(copy?.url, 'https://accounts.google.com/');
  assert.equal('domain' in copy!, false);
  assert.equal(copy?.sameSite, 'unspecified');
});

test('a session cookie is kept for as long as the longest cookie a site may set', () => {
  const copy = electronCookieFrom(cookie({ session: true, expires: -1 }), NOW);
  assert.equal(copy?.expirationDate, NOW / 1000 + KEPT_SESSION_COOKIE_DAYS * 86_400);
});

test('cookies whose scope cannot be rebuilt exactly are left behind', () => {
  const refused: Array<Partial<ChromeCookie>> = [
    { partitionKey: { topLevelSite: 'https://example.com' } },
    { name: '__Host-id', domain: '.google.com' },
    { name: '__Host-id', domain: 'google.com', path: '/a' },
    { name: '__Secure-id', secure: false },
    { sameSite: 'None', secure: false },
    { sameSite: 'Bogus' },
    { domain: '[::1]' },
    { expires: NOW / 1000 - 10, session: false },
  ];
  for (const overrides of refused) assert.equal(electronCookieFrom(cookie(overrides), NOW), null, JSON.stringify(overrides));
});

test('a __Host- cookie that is well-formed passes', () => {
  const copy = electronCookieFrom(cookie({ name: '__Host-GAPS', domain: 'accounts.google.com', sameSite: 'Lax' }), NOW);
  assert.equal(copy?.name, '__Host-GAPS');
  assert.equal('domain' in copy!, false);
});

test('the browser does not inherit Electron\'s environment or the AppImage libraries', () => {
  const env = chromeEnvironment({
    PATH: '/usr/bin', HOME: '/home/sam', CHROME_DESKTOP: 'timon.desktop', ELECTRON_RUN_AS_NODE: '1', NODE_OPTIONS: '--inspect',
    APPDIR: '/tmp/.mount_Timon1', LD_LIBRARY_PATH: '/tmp/.mount_Timon1/usr/lib:/opt/other/lib',
  }, 'linux');
  assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/home/sam', APPDIR: '/tmp/.mount_Timon1', LD_LIBRARY_PATH: '/opt/other/lib' });
  const onlyImage = chromeEnvironment({ APPDIR: '/tmp/.mount_Timon1', LD_LIBRARY_PATH: '/tmp/.mount_Timon1/usr/lib' }, 'linux');
  assert.equal('LD_LIBRARY_PATH' in onlyImage, false);
  assert.equal(chromeEnvironment({ APPDIR: '/x', LD_LIBRARY_PATH: '/x/lib' }, 'darwin').LD_LIBRARY_PATH, '/x/lib');
});
