import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCodexUsage } from '../../official-providers/provider-codex/lib/usage.js';

test('normalises the Codex windows by their duration and keeps the resets', () => {
  const usage = normalizeCodexUsage({
    rate_limit: {
      primary_window: {
        used_percent: 6,
        limit_window_seconds: 604_800,
        reset_at: 1_787_221_536,
      },
      secondary_window: {
        used_percent: 27,
        limit_window_seconds: 18_000,
        reset_at: 1_786_636_800,
      },
    },
  });

  assert.deepEqual(usage, {
    windows: {
      seven_day: { utilization: 6, resets_at: '2026-08-20T10:25:36.000Z' },
      five_hour: { utilization: 27, resets_at: '2026-08-13T16:00:00.000Z' },
    },
    extra: null,
  });
});

test('ignores a missing or invalid window instead of making up a zero', () => {
  const usage = normalizeCodexUsage({
    rate_limit: {
      primary_window: null,
      secondary_window: { used_percent: 'unknown', limit_window_seconds: 18_000 },
    },
  });
  assert.deepEqual(usage, { windows: { five_hour: null }, extra: null });
});

// The probe itself: what a sign-in Codex can no longer use turns into, and what it never costs.
const { mkdtempSync, writeFileSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { providerRuntime } = await import('../backends/provider-runtime.js');
const { isUsageNotSignedInError } = await import('../backends/usage-error.js');
const { createCodexUsage } = await import('../../official-providers/provider-codex/lib/usage.js') as {
  createCodexUsage(runtime: unknown): {
    getCodexUsage(opts?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<import('../backends/types.js').AccountUsage>;
    getCodexAccountUsage(dir: string, opts?: { force?: boolean; fetchImpl?: typeof fetch }): Promise<import('../backends/types.js').AccountUsage>;
  };
};

/** A JWT the server would parse: only `exp` matters to the probe, which never checks the signature. */
function jwt(exp: number): string {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ exp })}.c2ln`;
}
const IN_AN_HOUR = () => Math.floor(Date.now() / 1000) + 3600;
const AN_HOUR_AGO = () => Math.floor(Date.now() / 1000) - 3600;

/** A host sign-in in its own CODEX_AUTH_DIR: the real `~/.codex` is never read. */
function hostSignIn(accessToken: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), 'timon-codex-usage-'));
  if (accessToken !== null) {
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: accessToken, account_id: 'acct' } }));
  }
  process.env.CODEX_AUTH_DIR = dir;
  return dir;
}

const UNAUTHORIZED_BODY = '{"error":{"message":"Could not parse your authentication token. Please try signing in again.","code":"unauthorized_unknown"},"status":401}';
function stubFetch(answers: Array<() => Response>): typeof fetch & { calls: number } {
  const stub = (async () => {
    const answer = answers[Math.min(stub.calls, answers.length - 1)]!;
    stub.calls += 1;
    return answer();
  }) as unknown as typeof fetch & { calls: number };
  stub.calls = 0;
  return stub;
}
const usageBody = () => Response.json({ rate_limit: { primary_window: { used_percent: 42, limit_window_seconds: 18_000, reset_at: 1_900_000_000 } } });

test('a 401 from wham/usage is a sign-in to renew, never the raw server body', async () => {
  hostSignIn(jwt(IN_AN_HOUR()));
  const { getCodexUsage } = createCodexUsage(providerRuntime);
  const fetchImpl = stubFetch([() => new Response(UNAUTHORIZED_BODY, { status: 401 })]);
  await assert.rejects(getCodexUsage({ force: true, fetchImpl }), (error: Error) => {
    assert.ok(isUsageNotSignedInError(error));
    assert.match(error.message, /codex login/);
    assert.doesNotMatch(error.message, /unauthorized_unknown|Could not parse/);
    return true;
  });
  assert.equal(fetchImpl.calls, 1);
});

test('a 403 reads the same way', async () => {
  hostSignIn(jwt(IN_AN_HOUR()));
  const { getCodexUsage } = createCodexUsage(providerRuntime);
  const fetchImpl = stubFetch([() => new Response('forbidden', { status: 403 })]);
  await assert.rejects(getCodexUsage({ force: true, fetchImpl }), (error) => isUsageNotSignedInError(error));
});

test('an expired, malformed or absent token never reaches the network', async () => {
  for (const token of [jwt(AN_HOUR_AGO()), 'not-a-jwt', 'a.!!!.c', null]) {
    hostSignIn(token);
    const { getCodexUsage } = createCodexUsage(providerRuntime);
    const fetchImpl = stubFetch([usageBody]);
    await assert.rejects(getCodexUsage({ force: true, fetchImpl }), (error) => isUsageNotSignedInError(error), String(token));
    assert.equal(fetchImpl.calls, 0, `no request for ${String(token)}`);
  }
});

test('an unreadable auth.json is a sign-in to renew, not a probe failure', async () => {
  const dir = hostSignIn(null);
  writeFileSync(join(dir, 'auth.json'), '{ not json');
  const { getCodexUsage } = createCodexUsage(providerRuntime);
  const fetchImpl = stubFetch([usageBody]);
  await assert.rejects(getCodexUsage({ force: true, fetchImpl }), (error) => isUsageNotSignedInError(error));
  assert.equal(fetchImpl.calls, 0);
});

test('a refused sign-in is not cached: the next probe after `codex login` shows the figures', async () => {
  const dir = hostSignIn(jwt(IN_AN_HOUR()));
  const { getCodexUsage } = createCodexUsage(providerRuntime);
  const fetchImpl = stubFetch([() => new Response(UNAUTHORIZED_BODY, { status: 401 }), usageBody]);
  await assert.rejects(getCodexUsage({ fetchImpl }), (error) => isUsageNotSignedInError(error));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(IN_AN_HOUR() + 60), account_id: 'acct' } }));
  const usage = await getCodexUsage({ fetchImpl });
  assert.equal(usage.windows.five_hour?.utilization, 42);
  assert.equal(fetchImpl.calls, 2);
});

test('an outage is cached briefly without its body, and ↻ (force) asks again', async () => {
  hostSignIn(jwt(IN_AN_HOUR()));
  const { getCodexUsage } = createCodexUsage(providerRuntime);
  const fetchImpl = stubFetch([() => new Response('<html>bad gateway</html>', { status: 502 }), usageBody]);
  await assert.rejects(getCodexUsage({ fetchImpl }), (error: Error) => {
    assert.ok(!isUsageNotSignedInError(error));
    assert.equal(error.message, 'wham/usage 502');
    return true;
  });
  await assert.rejects(getCodexUsage({ fetchImpl }), /wham\/usage 502/);
  assert.equal(fetchImpl.calls, 1, 'cached between two polls');
  const usage = await getCodexUsage({ force: true, fetchImpl });
  assert.equal(usage.windows.five_hour?.utilization, 42);
  assert.equal(fetchImpl.calls, 2);
});

test('an account: an expired token is a gap its next mission fills, a refused one a sign-in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-codex-account-usage-'));
  const { getCodexAccountUsage } = createCodexUsage(providerRuntime);
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(AN_HOUR_AGO()), account_id: 'acct' } }));
  const fetchImpl = stubFetch([() => new Response(UNAUTHORIZED_BODY, { status: 401 })]);
  await assert.rejects(getCodexAccountUsage(dir, { force: true, fetchImpl }), (error) => !isUsageNotSignedInError(error));
  assert.equal(fetchImpl.calls, 0);
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: jwt(IN_AN_HOUR()), account_id: 'acct' } }));
  await assert.rejects(getCodexAccountUsage(dir, { force: true, fetchImpl }), (error: Error) =>
    isUsageNotSignedInError(error) && /settings/.test(error.message));
  assert.equal(fetchImpl.calls, 1);
});
