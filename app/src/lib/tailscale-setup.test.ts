import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  handoffKey, installerOutcomeOf, installerReportProxyBody, installProxyBody, parseSetupStatus, setupView, shouldPoll, startTailscaleStep,
  type TailscaleSetupStatus,
} from './tailscale-setup';

const AUTH = 'https://login.tailscale.com/a/1a2b3c';

const job = (fields: Record<string, unknown>) => ({
  kind: 'install', phase: 'downloading', failure: null, command: null, detail: null, auth_url: null, started_at: 1, ...fields,
});

function status(state: string, jobFields: Record<string, unknown> | null = null): TailscaleSetupStatus {
  const parsed = parseSetupStatus(200, { platform: 'darwin', state, error: null, job: jobFields && job(jobFields) });
  assert.ok(parsed);
  return parsed;
}

test('the daemon answer is read, refusals and unknown states are not', () => {
  assert.deepEqual(parseSetupStatus(202, { platform: 'linux', state: 'needs_login', error: null, job: null }), {
    platform: 'linux', state: 'needs_login', error: null, job: null,
  });
  assert.equal(parseSetupStatus(403, { error: 'forbidden' }), null);
  assert.equal(parseSetupStatus(200, { state: 'something_new' }), null);
  // A failure this build does not know reads as a plain failure.
  assert.equal(status('not_installed', { phase: 'failed', failure: 'brand_new' }).job?.failure, 'failed');
});

test('only a login.tailscale.com sign-in URL is kept', () => {
  assert.equal(status('needs_login', { kind: 'connect', phase: 'waiting_login', auth_url: AUTH }).job?.authUrl, AUTH);
  assert.equal(status('needs_login', { kind: 'connect', phase: 'waiting_login', auth_url: 'javascript:alert(1)' }).job?.authUrl, null);
  assert.equal(status('needs_login', { kind: 'connect', phase: 'waiting_login', auth_url: 'https://login.tailscale.com.evil.example/a' }).job?.authUrl, null);
});

test('what the card offers: install, installing, sign in, waiting, ready', () => {
  assert.deepEqual(setupView(status('not_installed')), { kind: 'offer', step: 'install', failure: null });
  assert.deepEqual(setupView(status('not_installed', { phase: 'installing' })), { kind: 'busy', step: 'install', phase: 'installing', authUrl: null });
  assert.deepEqual(setupView(status('needs_login', { phase: 'done' })), { kind: 'offer', step: 'connect', failure: null });
  assert.deepEqual(
    setupView(status('needs_login', { kind: 'connect', phase: 'waiting_login', auth_url: AUTH })),
    { kind: 'busy', step: 'connect', phase: 'waiting_login', authUrl: AUTH },
  );
  assert.deepEqual(setupView(status('running', { kind: 'connect', phase: 'done' })), { kind: 'ready' });
  assert.equal(setupView(status('unreachable')).kind, 'offer');
});

test('a failed step stays next to the button that retries it', () => {
  const view = setupView(status('not_installed', { phase: 'failed', failure: 'cancelled', command: 'winget install …' }));
  assert.equal(view.kind === 'offer' && view.failure?.failure, 'cancelled');
  const login = setupView(status('needs_login', { kind: 'connect', phase: 'failed', failure: 'permission' }));
  assert.equal(login.kind === 'offer' && login.step, 'connect');
  assert.equal(login.kind === 'offer' && login.failure?.failure, 'permission');
});

test('an unreadable CLI answer is shown, not taken for "not connected"', () => {
  const parsed = parseSetupStatus(200, { platform: 'darwin', state: 'unreadable', error: 'The Tailscale GUI failed to start', job: null });
  assert.ok(parsed);
  assert.deepEqual(setupView(parsed), { kind: 'unreadable', error: 'The Tailscale GUI failed to start' });
});

test('polled only while something is in progress', () => {
  assert.equal(shouldPoll(status('not_installed')), false);
  assert.equal(shouldPoll(status('not_installed', { phase: 'verifying' })), true);
  assert.equal(shouldPoll(status('starting')), true);
  assert.equal(shouldPoll(status('running', { kind: 'connect', phase: 'done' })), false);
  assert.equal(shouldPoll(null), false);
});

test('handoff: busy while the desktop app has the installer, keyed once per job', () => {
  const waiting = status('not_installed', { phase: 'handoff', started_at: 42 });
  assert.equal(shouldPoll(waiting), true);
  assert.deepEqual(setupView(waiting), { kind: 'busy', step: 'install', phase: 'handoff', authUrl: null });
  assert.equal(handoffKey(waiting), 'install:42');
  assert.equal(handoffKey(status('not_installed', { phase: 'downloading' })), null);
  assert.equal(handoffKey(status('needs_login', { kind: 'connect', phase: 'waiting_login' })), null);
  assert.equal(handoffKey(null), null);
});

test('the desktop app outcome: only known words', () => {
  assert.equal(installerOutcomeOf({ status: 'installed' }), 'installed');
  assert.equal(installerOutcomeOf({ status: 'cancelled' }), 'cancelled');
  assert.equal(installerOutcomeOf({ status: 'busy' }), 'busy');
  assert.equal(installerOutcomeOf({ status: 'pwned' }), 'failed');
  assert.equal(installerOutcomeOf(undefined), 'failed');
});

test('Install from the desktop app says so; nothing else, and no other step, carries it', async () => {
  const sent: { url: string; body: unknown }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    sent.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) as unknown });
    return new Response(JSON.stringify({ platform: 'win32', state: 'not_installed', error: null, job: null }), { status: 202 });
  }) as typeof fetch;
  try {
    await startTailscaleStep('install', { desktop: true });
    await startTailscaleStep('install');
    await startTailscaleStep('connect', { desktop: true });
  } finally {
    globalThis.fetch = original;
  }
  assert.deepEqual(sent, [
    { url: '/api/ui/devices/tailscale/install', body: { client: 'desktop' } },
    { url: '/api/ui/devices/tailscale/install', body: {} },
    { url: '/api/ui/devices/tailscale/connect', body: {} },
  ]);
});

test('the proxies pass on the desktop word and the three report fields, nothing else', () => {
  assert.deepEqual(installProxyBody({ client: 'desktop' }), { client: 'desktop' });
  assert.deepEqual(installProxyBody({ client: 'desktop', url: 'https://evil.example/x.pkg' }), { client: 'desktop' });
  assert.deepEqual(installProxyBody({ client: 'browser' }), {});
  assert.deepEqual(installProxyBody(null), {});
  const sha256 = 'f'.repeat(64);
  assert.deepEqual(installerReportProxyBody({ sha256, outcome: 'cancelled', code: 1602, path: 'C:\\evil.msi' }), { sha256, outcome: 'cancelled', code: 1602 });
  assert.deepEqual(installerReportProxyBody({ sha256, outcome: 'installed' }), { sha256, outcome: 'installed' });
  assert.deepEqual(installerReportProxyBody('junk'), { sha256: undefined, outcome: undefined });
});
