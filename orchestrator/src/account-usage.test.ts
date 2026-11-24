/**
 * TODO #330 — the usage of a subscription account is measured on its own
 * sign-in, and only for whoever may use the account. Isolated TIMON_HOME,
 * witness server on 127.0.0.1:0, the provider endpoints stubbed in `fetch`.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-account-usage-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
// The host's sign-in: an account must never be measured with it.
process.env.CLAUDE_CODE_OAUTH_TOKEN = 'host-token';

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerRoutes: registerHttpRoutes } = await import('./plugins-bundled/http/routes.js');
const { dbApi } = await import('./db.js');
const accounts = await import('./backends/accounts.js');
const { getClaudeAccountUsage, resetClaudeUsageCache } = await import('../tests/helpers/claude-provider.js');
const { providerRuntime } = await import('./backends/provider-runtime.js');
const { createCodexUsage } = await import('../official-providers/provider-codex/lib/usage.js') as {
  createCodexUsage(runtime: unknown): { getCodexAccountUsage(dir: string, opts?: { force?: boolean }): Promise<import('./backends/types.js').AccountUsage> };
};
const { getCodexAccountUsage } = createCodexUsage(providerRuntime);
const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { isUsageNotSignedInError } = await import('./backends/usage-error.js');
const { collectUsage, collectBackendUsage, resetForcedUsageProbes } = await import('./usage.js');
const { SESSION_COOKIE } = await import('./users/session.js');

/** Each token answers its own figure, so a borrowed sign-in shows at once. */
const FIGURES: Record<string, number> = { 'host-token': 99, 'ada-token': 11, 'bob-token': 22, 'flaky-token': 33 };
/** Tokens whose usage endpoint is down for now (a 503: cached, unlike a sign-out). */
const OUTAGE = new Set<string>();
const probes: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith('https://')) return realFetch(input, init);
  if (url.includes('/oauth/token')) {
    // The refresh grant: `r-ok` is renewed (and rotated), anything else was revoked.
    const grant = JSON.parse(String(init?.body ?? '{}')) as { refresh_token?: string };
    probes.push(`refresh:${grant.refresh_token}`);
    return grant.refresh_token === 'r-ok'
      ? Response.json({ access_token: 'ada-token', refresh_token: 'r-rotated', expires_in: 3600 })
      : new Response('{"error":"invalid_grant"}', { status: 400 });
  }
  const token = (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, '');
  probes.push(token);
  if (OUTAGE.has(token)) return new Response('busy', { status: 503 });
  const utilization = FIGURES[token];
  if (utilization === undefined) return new Response('nope', { status: 401 });
  if (url.includes('wham/usage')) {
    return Response.json({ rate_limit: { primary_window: { used_percent: utilization, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } } });
  }
  return Response.json({ five_hour: { utilization, resets_at: '2026-10-14T20:00:00Z' }, seven_day: null, extra_usage: null });
}) as typeof fetch;
test.after(() => { globalThis.fetch = realFetch; });

function signIn(dir: string, token: string, expiresAt = Date.now() + 3_600_000, refreshToken: string | null = 'r'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token, ...(refreshToken ? { refreshToken } : {}), expiresAt } }));
}

const user = (email: string, isSuperadmin = false) =>
  createTestAccount(dbApi, { email, name: email.split('@')[0]!, passwordHash: 'x', isSuperadmin });
const ada = user('ada@example.com');
const bob = user('bob@example.com');
const adaViewer = { id: ada.id, isSuperadmin: false, permissions: [] };
const adminViewer = { id: 'admin', isSuperadmin: true, permissions: [] };

const adaAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Perso', ownerUserId: ada.id });
const bobAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Work', ownerUserId: bob.id });
const idleAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Idle', ownerUserId: ada.id });
const flakyAccount = accounts.createBackendAccount({ backend: 'claude', name: 'Flaky', ownerUserId: ada.id });
signIn(accounts.accountConfigDir(adaAccount.id), 'ada-token');
signIn(accounts.accountConfigDir(bobAccount.id), 'bob-token');
signIn(accounts.accountConfigDir(flakyAccount.id), 'flaky-token');
const adaInstance = accounts.accountInstance(adaAccount);
const bobInstance = accounts.accountInstance(bobAccount);
const idleInstance = accounts.accountInstance(idleAccount);
const flakyInstance = accounts.accountInstance(flakyAccount);

/**
 * The product leaves a Claude account unmeasured on macOS (its CLI keeps the
 * session in the keychain): the tests that measure one run as on Linux there.
 */
async function measurable(run: () => Promise<void>): Promise<void> {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    await run();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

test('claude: an account is measured on its own sign-in, never the host\'s', { concurrency: false }, async () => {
  resetClaudeUsageCache();
  const ada = await getClaudeAccountUsage(accounts.accountConfigDir(adaAccount.id), { force: true });
  const bob = await getClaudeAccountUsage(accounts.accountConfigDir(bobAccount.id));
  assert.equal(ada.windows.five_hour?.utilization, 11);
  assert.equal(bob.windows.five_hour?.utilization, 22, 'one cache per account: the first answer is not everyone\'s');
  assert.ok(!probes.includes('host-token'));
  await assert.rejects(getClaudeAccountUsage(accounts.accountConfigDir(idleAccount.id), { force: true }),
    (error) => isUsageNotSignedInError(error), 'no file in the account directory = not signed in, whatever the host has');
});

test('claude: an expired account token is renewed with its refresh token, and the rotated pair written back', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-account-expired-'));
  signIn(dir, 'stale-token', Date.now() - 60_000, 'r-ok');
  const before = probes.length;
  const usage = await getClaudeAccountUsage(dir, { force: true, platform: 'linux' } as { force: boolean });
  assert.equal(usage.windows.five_hour?.utilization, 11);
  assert.deepEqual(probes.slice(before), ['refresh:r-ok', 'ada-token']);
  const stored = JSON.parse(readFileSync(join(dir, '.credentials.json'), 'utf8')) as { claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number } };
  assert.equal(stored.claudeAiOauth.accessToken, 'ada-token', 'the CLI of the account reads the renewed token');
  assert.equal(stored.claudeAiOauth.refreshToken, 'r-rotated');
  assert.ok(stored.claudeAiOauth.expiresAt > Date.now());
});

test('claude: a revoked refresh token reads as signed out; no refresh token is a gap, with no call', { concurrency: false }, async () => {
  const revoked = mkdtempSync(join(tmpdir(), 'timon-account-revoked-'));
  signIn(revoked, 'stale-token', Date.now() - 60_000, 'r-revoked');
  await assert.rejects(getClaudeAccountUsage(revoked, { force: true, platform: 'linux' } as { force: boolean }), (error) => isUsageNotSignedInError(error));
  const bare = mkdtempSync(join(tmpdir(), 'timon-account-bare-'));
  signIn(bare, 'stale-token', Date.now() - 60_000, null);
  const before = probes.length;
  await assert.rejects(getClaudeAccountUsage(bare, { force: true }), (error) => !isUsageNotSignedInError(error));
  assert.equal(probes.length, before, 'nothing to renew it with: no call at all');
});

test('claude: on macOS an account token is never rotated (the CLI keeps it in the keychain)', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-account-darwin-'));
  signIn(dir, 'stale-token', Date.now() - 60_000, 'r-ok');
  const before = probes.length;
  await assert.rejects(getClaudeAccountUsage(dir, { force: true, platform: 'darwin' } as { force: boolean }), (error) => !isUsageNotSignedInError(error));
  assert.equal(probes.length, before);
});

test('claude: an account probed before its sign-in shows its figures once signed in', { concurrency: false }, async () => {
  // The settings ask for the gauge while the login is still running: that first answer must not stick.
  const dir = mkdtempSync(join(tmpdir(), 'timon-account-late-sign-in-'));
  await assert.rejects(getClaudeAccountUsage(dir), (error) => isUsageNotSignedInError(error));
  signIn(dir, 'ada-token');
  const before = probes.length;
  const usage = await getClaudeAccountUsage(dir);
  assert.equal(usage.windows.five_hour?.utilization, 11);
  assert.equal(probes.length, before + 1, 'the credentials are read again and the endpoint really called');
});

test('claude: an account whose expired token is renewed shows its figures again', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-account-renewed-'));
  signIn(dir, 'bob-token', Date.now() - 60_000, null);
  await assert.rejects(getClaudeAccountUsage(dir), (error) => !isUsageNotSignedInError(error));
  signIn(dir, 'bob-token');
  const before = probes.length;
  const usage = await getClaudeAccountUsage(dir, { force: true });
  assert.equal(usage.windows.five_hour?.utilization, 22);
  assert.equal(probes.length, before + 1);
});

test('codex: an account reads its own auth.json and nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-codex-account-'));
  await assert.rejects(getCodexAccountUsage(dir, { force: true }), (error) => isUsageNotSignedInError(error));
  // A real ChatGPT access token is a JWT: the probe reads its expiry before asking.
  const claims = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  const token = `e30.${claims}.sig`;
  FIGURES[token] = 22;
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: token, account_id: 'acct' } }));
  const usage = await getCodexAccountUsage(dir, { force: true });
  assert.equal(usage.windows.five_hour?.utilization, 22);
});

test('collectUsage lists the accounts the viewer may use, signed-in ones only', { concurrency: false }, () => measurable(async () => {
  resetClaudeUsageCache();
  const ids = async (viewer: Parameters<typeof collectUsage>[0]) => (await collectUsage(viewer)).map((entry) => entry.backend);

  const adaSees = await ids(adaViewer);
  assert.ok(adaSees.includes('claude'), 'the host entry stays');
  assert.ok(adaSees.includes(adaInstance));
  assert.ok(!adaSees.includes(bobInstance), 'another user\'s account does not exist for her');
  assert.ok(!adaSees.includes(idleInstance), 'an account that is not signed in has no gauge');
  const adaEntry = (await collectUsage(adaViewer)).find((entry) => entry.backend === adaInstance)!;
  assert.equal(adaEntry.available, true);
  assert.equal(adaEntry.usage?.windows.five_hour?.utilization, 11);

  const adminSees = await ids(adminViewer);
  assert.ok(adminSees.includes(adaInstance) && adminSees.includes(bobInstance));
  assert.ok(!(await ids(null)).some((id) => id.includes('@')), 'no viewer (a job), no account');

  accounts.grantBackendAccount(bobAccount.id, ada.id, null);
  assert.ok((await ids(adaViewer)).includes(bobInstance), 'a granted account is measured for its grantee');
  accounts.revokeBackendAccountGrant(bobAccount.id, ada.id);
}));

test('collectUsage leaves out an account it cannot measure here (a Claude account on macOS)', { concurrency: false }, async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  try {
    const entries = await collectUsage(adaViewer);
    assert.ok(entries.some((entry) => entry.backend === 'claude'), 'the host entry stays');
    assert.ok(!entries.some((entry) => entry.backend === adaInstance), 'no "no probe" gauge under the account\'s name');
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

test('collectUsage keeps an account whose probe fails, so the gauge can show its last reading', { concurrency: false }, () => measurable(async () => {
  resetClaudeUsageCache();
  signIn(accounts.accountConfigDir(idleAccount.id), 'idle-token', Date.now() - 60_000, null);
  try {
    const entry = (await collectUsage(adaViewer)).find((candidate) => candidate.backend === idleInstance);
    assert.ok(entry, 'an expired token is a gap, not an absence');
    assert.equal(entry.available, false);
    assert.ok(entry.error);
  } finally {
    rmSync(join(accounts.accountConfigDir(idleAccount.id), '.credentials.json'), { force: true });
  }
}));

test('collectBackendUsage answers null for an account the viewer may not use', async () => {
  assert.equal(await collectBackendUsage(bobInstance, adaViewer), null);
  assert.equal(await collectBackendUsage(bobInstance, null), null);
  assert.equal((await collectBackendUsage(adaInstance, adaViewer))?.backend, adaInstance);
});

/** A witness daemon with the user and HTTP routes, Ada signed in. */
async function withAdaSession(run: (base: string, cookie: string) => Promise<void>): Promise<void> {
  const DAEMON = 'witness-daemon-token';
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: DAEMON, required: true }));
  app.use(express.json());
  registerUserRoutes(app, { setupPolicy: 'free' });
  registerHttpRoutes(app as never);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    // Ada gets a password the login route can check.
    const reset = await realFetch(`${base}/api/users/${ada.id}/reset-password`, {
      method: 'POST', headers: { authorization: `Bearer ${DAEMON}` },
    });
    assert.equal(reset.status, 200);
    const { password } = await reset.json() as { password: string };
    const login = await realFetch(`${base}/api/auth/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', password }),
    });
    const line = login.headers.getSetCookie().find((l) => l.startsWith(`${SESSION_COOKIE}=`));
    assert.ok(line, 'ada signs in');
    await run(base, line.split(';')[0]!);
  } finally {
    server.close();
  }
}

test('GET /api/usage: an account is measured for whoever may use it, and 404 for anyone else', { concurrency: false }, () => measurable(async () => {
  await withAdaSession(async (base, cookie) => {
    const usage = (backend: string, headers: Record<string, string> = {}) =>
      realFetch(`${base}/api/usage?backend=${encodeURIComponent(backend)}`, { headers });

    assert.equal((await usage(adaInstance)).status, 401, 'anonymous is refused');
    const own = await usage(adaInstance, { cookie });
    assert.equal(own.status, 200);
    assert.equal(((await own.json()) as { windows?: { five_hour?: { utilization: number } } }).windows?.five_hour?.utilization, 11);
    const other = await usage(bobInstance, { cookie });
    assert.equal(other.status, 404, 'another user\'s account does not exist for her');
    assert.ok(!JSON.stringify(await other.json()).includes('Work'));
  });
}));

test('GET /api/usage?refresh=1: a ↻ after a cached failure asks the provider again (TODO #632)', { concurrency: false }, () => measurable(async () => {
  resetForcedUsageProbes();
  await withAdaSession(async (base, cookie) => {
    const usage = (backend: string, query = '', headers: Record<string, string> = { cookie }) =>
      realFetch(`${base}/api/usage?backend=${encodeURIComponent(backend)}${query}`, { headers });
    const calls = () => probes.filter((token) => token === 'flaky-token').length;

    // Earlier tests may have cached a reading of this account: the outage is
    // read with a ↻ of its own, then its floor is let pass.
    const before = calls();
    OUTAGE.add('flaky-token');
    try {
      assert.equal((await usage(flakyInstance, '&refresh=1')).status, 503, 'the endpoint is down');
    } finally {
      OUTAGE.delete('flaky-token');
    }
    const afterOutage = calls();
    assert.equal(afterOutage, before + 1);
    resetForcedUsageProbes();
    assert.equal((await usage(flakyInstance)).status, 503, 'polling replays the cached failure');
    assert.equal(calls(), afterOutage, 'and does not call the provider');

    const refreshed = await usage(flakyInstance, '&refresh=1');
    assert.equal(refreshed.status, 200, 'the ↻ skips the cached failure');
    assert.equal(((await refreshed.json()) as { windows?: { five_hour?: { utilization: number } } }).windows?.five_hour?.utilization, 33);
    assert.equal(calls(), afterOutage + 1, 'one real call to the provider');

    assert.equal((await usage(flakyInstance, '&refresh=1')).status, 200);
    assert.equal(calls(), afterOutage + 1, 'a second ↻ inside the floor serves the cache: no 429 from a hammered endpoint');

    // Refused before any probe: anonymous, and an account that is not hers.
    resetForcedUsageProbes();
    const bobCalls = probes.filter((token) => token === 'bob-token').length;
    assert.equal((await usage(flakyInstance, '&refresh=1', {})).status, 401, 'anonymous is refused');
    assert.equal((await usage(bobInstance, '&refresh=1')).status, 404, 'another user\'s account does not exist for her');
    assert.equal(calls(), afterOutage + 1);
    assert.equal(probes.filter((token) => token === 'bob-token').length, bobCalls, 'the refused ↻ reached no probe');
  });
  resetForcedUsageProbes();
}));
