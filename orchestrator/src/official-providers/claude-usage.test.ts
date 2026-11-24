import '../test-home.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { getClaudeUsage, resetClaudeUsageCache } from '../../tests/helpers/claude-provider.js';
import { isUsageNotSignedInError } from '../backends/usage-error.js';

test('refreshes expired CLI credentials and persists rotated tokens', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-credentials-'));
  const path = join(dir, '.credentials.json');
  writeFileSync(path, JSON.stringify({
    unrelated: { preserved: true },
    claudeAiOauth: {
      accessToken: 'expired-access',
      refreshToken: 'refresh-old',
      expiresAt: Date.now() - 60_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      subscriptionType: 'max',
    },
  }));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const calls: Array<{ url: string; authorization?: string; json?: Record<string, unknown> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = typeof init?.body === 'string'
      ? JSON.parse(init.body) as Record<string, unknown>
      : undefined;
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization') ?? undefined,
      json,
    });
    if (url.endsWith('/v1/oauth/token')) {
      return Response.json({
        access_token: 'fresh-access',
        refresh_token: 'refresh-new',
        expires_in: 3600,
        refresh_token_expires_in: 7200,
      });
    }
    return Response.json({
      five_hour: { utilization: 27, resets_at: '2026-09-04T20:00:00Z' },
      seven_day: { utilization: 16, resets_at: '2026-09-08T00:00:00Z' },
      extra_usage: null,
    });
  }) as typeof fetch;
  try {
    // The refresh is the Linux and Windows path: on macOS the CLI's keychain session is never rotated.
    const usage = await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => null, platform: 'linux' });
    assert.equal(usage.windows.five_hour?.utilization, 27);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.json?.grant_type, 'refresh_token');
    assert.equal(calls[0]?.json?.refresh_token, 'refresh-old');
    assert.equal(calls[0]?.json?.scope, 'user:profile user:inference');
    assert.equal(calls[1]?.authorization, 'Bearer fresh-access');
    const stored = JSON.parse(readFileSync(path, 'utf8')) as {
      unrelated: { preserved: boolean };
      claudeAiOauth: Record<string, unknown>;
    };
    assert.equal(stored.unrelated.preserved, true);
    assert.equal(stored.claudeAiOauth.accessToken, 'fresh-access');
    assert.equal(stored.claudeAiOauth.refreshToken, 'refresh-new');
    assert.equal(stored.claudeAiOauth.subscriptionType, 'max');
    // Windows reports 0o666 for any writable file: owner-only there is an ACL, not mode bits.
    if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousEnvToken;
  }
});

test('does not call the token endpoint when the environment supplies a token', { concurrency: false }, async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'environment-access';
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(String(input));
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer environment-access');
    return Response.json({ five_hour: null, seven_day: null, extra_usage: null });
  }) as typeof fetch;
  try {
    await getClaudeUsage({ force: true, fetchImpl });
    assert.deepEqual(seen, ['https://api.anthropic.com/api/oauth/usage']);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

test('shares one upstream usage request between concurrent callers', { concurrency: false }, async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'shared-access';
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async () => {
    calls += 1;
    await gate;
    return Response.json({ five_hour: null, seven_day: null, extra_usage: null });
  }) as typeof fetch;
  try {
    const first = getClaudeUsage({ force: true, fetchImpl });
    const second = getClaudeUsage({ force: true, fetchImpl });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

test('missing OAuth session is a typed not-signed-in error, not a bare Error', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-no-session-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    await assert.rejects(
      getClaudeUsage({
        force: true,
        fetchImpl: (async () => { throw new Error('must not fetch'); }) as typeof fetch,
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal((error as { code?: unknown }).code, 'not_signed_in');
        assert.notEqual(error.constructor, Error, 'must not be a generic Error matched by message text');
        return true;
      },
    );
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousEnvToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousEnvToken;
  }
});

test('turns a rejected session into a login instruction', { concurrency: false }, async () => {
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'rejected-access';
  try {
    await assert.rejects(
      getClaudeUsage({
        force: true,
        fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
      }),
      /run `\/login` in the CLI/,
    );
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

test('macOS: reads the CLI login from the keychain without writing it back', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-keychain-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir; // no .credentials.json inside, as on a Mac
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization') ?? ''}`);
    return Response.json({ five_hour: { utilization: 9, resets_at: '2026-10-08T00:00:00Z' }, seven_day: null, extra_usage: null });
  }) as typeof fetch;
  const entry = JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-access', expiresAt: Date.now() + 3_600_000 } });
  try {
    const usage = await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => entry });
    assert.equal(usage.windows.five_hour?.utilization, 9);
    assert.deepEqual(seen, ['https://api.anthropic.com/api/oauth/usage Bearer keychain-access']);
    // `security -w` hands back hex when the secret is not printable.
    const hex = Buffer.from(entry, 'utf8').toString('hex');
    await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => hex });
    assert.equal(seen[1], 'https://api.anthropic.com/api/oauth/usage Bearer keychain-access');
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousEnvToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = previousEnvToken;
  }
});

test('macOS: no keychain entry and an expired one both read "not signed in", never refreshed', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-keychain-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  let fetched = 0;
  const fetchImpl = (async () => { fetched++; return Response.json({}); }) as typeof fetch;
  try {
    await assert.rejects(
      getClaudeUsage({ force: true, fetchImpl, readKeychain: () => null }),
      (e: unknown) => isUsageNotSignedInError(e),
    );
    const expired = JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: Date.now() - 60_000 } });
    await assert.rejects(
      getClaudeUsage({ force: true, fetchImpl, readKeychain: () => expired }),
      (e: unknown) => isUsageNotSignedInError(e) && /run `claude` once to renew/.test((e as Error).message),
    );
    assert.equal(fetched, 0, 'no token endpoint call: the refresh token belongs to the CLI');
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousEnvToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = previousEnvToken;
  }
});

/** A Mac where `~/.claude/.credentials.json` outlived the session the CLI now keeps in the keychain. */
async function withStaleCredentialsFile(
  run: (path: string, before: string) => Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-stale-file-'));
  const path = join(dir, '.credentials.json');
  writeFileSync(path, JSON.stringify({
    claudeAiOauth: {
      accessToken: 'stale-access',
      refreshToken: 'refresh-rotated-away',
      expiresAt: Date.now() - 86_400_000,
      scopes: ['user:inference'],
    },
  }));
  const before = readFileSync(path, 'utf8');
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousEnvToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  try {
    await run(path, before);
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousEnvToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = previousEnvToken;
  }
}

test('macOS: a valid keychain session wins over a stale credentials file, with no refresh', { concurrency: false }, async () => {
  await withStaleCredentialsFile(async (path, before) => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      seen.push(`${String(input)} ${new Headers(init?.headers).get('authorization') ?? ''}`);
      return Response.json({ five_hour: { utilization: 41, resets_at: '2026-10-27T00:00:00Z' }, seven_day: null, extra_usage: null });
    }) as typeof fetch;
    const keychain = JSON.stringify({
      claudeAiOauth: { accessToken: 'keychain-access', refreshToken: 'keychain-refresh', expiresAt: Date.now() + 3_600_000 },
    });
    const usage = await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => keychain });
    assert.equal(usage.windows.five_hour?.utilization, 41);
    assert.deepEqual(seen, ['https://api.anthropic.com/api/oauth/usage Bearer keychain-access']);
    assert.equal(readFileSync(path, 'utf8'), before, 'the stale file is left as it was');
  });
});

test('both stores live: the access token that expires last is used', { concurrency: false }, async () => {
  await withStaleCredentialsFile(async (path) => {
    writeFileSync(path, JSON.stringify({
      claudeAiOauth: { accessToken: 'file-access', refreshToken: 'r', expiresAt: Date.now() + 600_000 },
    }));
    const seen: string[] = [];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      seen.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ five_hour: null, seven_day: null, extra_usage: null });
    }) as typeof fetch;
    const later = JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-access', expiresAt: Date.now() + 3_600_000 } });
    await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => later });
    const earlier = JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-access', expiresAt: Date.now() + 300_000 } });
    await getClaudeUsage({ force: true, fetchImpl, readKeychain: () => earlier });
    assert.deepEqual(seen, ['Bearer keychain-access', 'Bearer file-access']);
  });
});

test('macOS: an expired keychain session is never refreshed through the stale file', { concurrency: false }, async () => {
  await withStaleCredentialsFile(async (path, before) => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return Response.json({}); }) as typeof fetch;
    const expired = JSON.stringify({
      claudeAiOauth: { accessToken: 'old', refreshToken: 'keychain-refresh', expiresAt: Date.now() - 60_000 },
    });
    await assert.rejects(
      getClaudeUsage({ force: true, fetchImpl, readKeychain: () => expired }),
      (e: unknown) => isUsageNotSignedInError(e) && /run `claude` once to renew/.test((e as Error).message),
    );
    assert.equal(fetched, 0, 'no token endpoint call: the refresh token belongs to the CLI');
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('invalid_grant is a readable "signed out", not the token endpoint JSON', { concurrency: false }, async () => {
  await withStaleCredentialsFile(async (path, before) => {
    const seen: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      seen.push(String(input));
      return Response.json(
        { error: 'invalid_grant', error_description: 'Refresh token not found or invalid' },
        { status: 400 },
      );
    }) as typeof fetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(
        getClaudeUsage({ force: attempt === 0, fetchImpl, readKeychain: () => null, platform: 'linux' }),
        (error: unknown) => {
          assert.ok(isUsageNotSignedInError(error), `attempt ${attempt}: ${(error as Error).message}`);
          assert.match((error as Error).message, /run `claude`, then `\/login`/);
          assert.doesNotMatch((error as Error).message, /invalid_grant|\{/);
          return true;
        },
      );
    }
    // Not cached: the second, unforced probe asked again instead of replaying a frozen error.
    assert.deepEqual(seen, ['https://platform.claude.com/v1/oauth/token', 'https://platform.claude.com/v1/oauth/token']);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('macOS: an unreadable keychain never lets the probe rotate the stale file', { concurrency: false }, async () => {
  await withStaleCredentialsFile(async (path, before) => {
    let fetched = 0;
    const fetchImpl = (async () => { fetched++; return Response.json({}); }) as typeof fetch;
    // `null` is also what a refused prompt or a `security` timeout answers.
    await assert.rejects(
      getClaudeUsage({ force: true, fetchImpl, readKeychain: () => null, platform: 'darwin' }),
      (e: unknown) => isUsageNotSignedInError(e) && /run `claude` once to renew/.test((e as Error).message),
    );
    assert.equal(fetched, 0);
    assert.equal(readFileSync(path, 'utf8'), before);
  });
});

test('a rate-limited probe backs off and keeps the last good figures', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T20:00:00Z') });
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'limited-access';
  resetClaudeUsageCache();
  let calls = 0;
  let limited = false;
  const fetchImpl = (async () => {
    calls += 1;
    if (limited) return new Response('slow down', { status: 429, headers: { 'retry-after': '120' } });
    return Response.json({ five_hour: { utilization: 42, resets_at: null }, seven_day: null, extra_usage: null });
  }) as typeof fetch;
  try {
    assert.equal((await getClaudeUsage({ force: true, fetchImpl })).windows.five_hour?.utilization, 42);
    limited = true;
    t.mock.timers.tick(61_000);
    // Refused upstream: the last figures stand in, and the backoff starts.
    assert.equal((await getClaudeUsage({ fetchImpl })).windows.five_hour?.utilization, 42);
    assert.equal(calls, 2);
    // Inside the backoff nothing reaches the endpoint, not even a forced refresh.
    t.mock.timers.tick(60_000);
    assert.equal((await getClaudeUsage({ force: true, fetchImpl })).windows.five_hour?.utilization, 42);
    assert.equal(calls, 2);
    // Once it ends, the endpoint is asked again.
    limited = false;
    t.mock.timers.tick(61_000);
    await getClaudeUsage({ force: true, fetchImpl });
    assert.equal(calls, 3);
  } finally {
    resetClaudeUsageCache();
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});

test('rate-limited with no figures yet: the error stays, the backoff still holds', { concurrency: false }, async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-03T21:00:00Z') });
  const previous = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'limited-access';
  resetClaudeUsageCache();
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response('', { status: 429 }); }) as typeof fetch;
  try {
    await assert.rejects(getClaudeUsage({ force: true, fetchImpl }), /oauth\/usage 429/);
    t.mock.timers.tick(4 * 60_000);
    await assert.rejects(getClaudeUsage({ force: true, fetchImpl }), /oauth\/usage 429/);
    assert.equal(calls, 1, 'no Retry-After: five minutes without asking');
  } finally {
    resetClaudeUsageCache();
    if (previous === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previous;
  }
});
