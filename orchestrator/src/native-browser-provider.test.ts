import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { browserErrorBody, callNativeBrowser, chromeMissingError, NativeBrowserError, readNativeProvider } from './native-browser-provider.js';
import { apiError } from './api-error.js';

test('provider accepts only local authenticated IPC and fixes the profile after caller arguments', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'timon-native-provider-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, 'browser-native'));
  const file = join(home, 'browser-native/provider.json');
  const token = 'provider-only-secret'.repeat(3);
  const requests: { path: string; auth: string; body: Record<string, unknown> }[] = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url!, auth: req.headers.authorization!, body: JSON.parse(body) });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ running: true }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const provider = { version: 1, origin: `${origin}/`, token, pid: process.pid };
  writeFileSync(file, JSON.stringify(provider));
  assert.equal(readNativeProvider(home)?.origin, origin);
  await callNativeBrowser('chosen', { action: 'status', profileId: 'spoofed' }, { home });
  assert.deepEqual(requests, [{ path: '/command', auth: `Bearer ${token}`, body: { action: 'status', profileId: 'chosen' } }]);
  await assert.rejects(callNativeBrowser('../outside', { action: 'status' }, { home }), /Invalid browser profile/);
  for (const bad of ['https://127.0.0.1:44', 'http://example.com:3000', 'http://localhost:3000', `${origin}/evil`, `${origin}?token=leak`, `http://u:p@127.0.0.1:33`]) {
    writeFileSync(file, JSON.stringify({ ...provider, origin: bad }));
    assert.equal(readNativeProvider(home), null, bad);
  }
  writeFileSync(file, JSON.stringify({ ...provider, origin: 'http://127.0.0.1:1' }));
  await assert.rejects(callNativeBrowser('chosen', { action: 'status' }, { home }), (err: Error) => {
    assert.doesNotMatch(err.message, /provider-only-secret|127\.0\.0\.1/);
    return /unavailable/.test(err.message);
  });
});

test('the Chrome capability names the browser, never its path, and explains a missing one', async () => {
  const { chromeCapability, nativeBrowserCapabilities } = await import('./native-browser-provider.js');
  const found = chromeCapability(() => ({ found: true, binary: { path: '/home/sam/bin/google-chrome', flavour: 'chrome', name: 'Google Chrome' } }));
  assert.deepEqual(found, { available: true, name: 'Google Chrome' });
  assert.ok(!JSON.stringify(found).includes('/home/sam'));
  const confined = chromeCapability(() => ({ found: false, reason: 'confined' }));
  assert.equal(confined.available, false);
  assert.match((confined as { message: string }).message, /snap or flatpak/);
  // The answer carries the Chrome part even when the desktop is not running.
  const offline = await nativeBrowserCapabilities(() => ({ found: false, reason: 'none' }));
  assert.equal(offline.chrome.available, false);
});

test('a browser refusal carries a code the webview translates; bare text stays a detail', () => {
  const coded = new NativeBrowserError(apiError('browser_profile_not_found', 'Browser profile not found.'), 404);
  assert.equal(coded.message, 'Browser profile not found.');
  assert.equal(coded.status, 404);
  assert.deepEqual(browserErrorBody(coded), { error: 'Browser profile not found.', code: 'browser_profile_not_found' });
  // Text with no code of its own (an agent-facing refusal) is quoted, not lost.
  assert.deepEqual(new NativeBrowserError('read-only browser').body,
    { error: 'read-only browser', code: 'browser_refused', params: { detail: 'read-only browser' } });
  assert.deepEqual(browserErrorBody(new Error('boom')), { error: 'boom', code: 'browser_refused', params: { detail: 'boom' } });
  assert.equal(chromeMissingError('none').code, 'browser_chrome_missing');
  assert.equal(chromeMissingError('confined').code, 'browser_chrome_confined');
});
