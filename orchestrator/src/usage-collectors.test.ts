/**
 * `ctx.usage` on the daemon side: the aggregated view of quotas and the probes a
 * plugin can provide (§10.15).
 *
 * The risk computation is no longer here: it belongs to the plugin that
 * shows it (`examples/plugin-quota-monitor`), with its thresholds. The daemon returns
 * measures, not a judgement.
 */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-usage-global-test-'));
const {
  collectUsage, collectBackendUsage, collectUsageFor,
  registerUsageCollector, usageCollectorBackends, resetForcedUsageProbes,
} = await import('./usage.js');
await import('../tests/helpers/claude-provider.js');

const { PERMISSION_MODELS, RATE_LIMIT_REPORTINGS } = await import('./backends/types.js');

/** Catalogue entry of a provider brought by a plugin: no first-party probe. */
function pluginProvider(id: string) {
  return {
    id, label: id, models: [], defaultModel: null,
    permissionModel: PERMISSION_MODELS[0]!, rateLimitReporting: RATE_LIMIT_REPORTINGS[0]!,
    accountUsage: false, sessionResumable: false,
  };
}

test('a plugin probe covers a backend the product does not measure', async () => {
  const item = pluginProvider('acme-llm');
  assert.deepEqual(await collectUsageFor(item), {
    backend: 'acme-llm', label: 'acme-llm', vendor: 'acme-llm', brand: null,
    available: false, usage: null,
  }, 'without a probe: unavailable and WITHOUT a figure, never a zero');

  const remove = registerUsageCollector('acme-plugin', 'acme-llm', async () => ({
    windows: { week: { utilization: 42, resets_at: null } },
    extra: null,
  }));
  assert.deepEqual(usageCollectorBackends(), ['acme-llm']);
  const measured = await collectUsageFor(item);
  assert.equal(measured.available, true);
  assert.equal(measured.usage?.windows.week?.utilization, 42);

  // Two probes for the same account would tell two truths: the second is
  // refused, naming the owner of the first.
  assert.throws(() => registerUsageCollector('other-plugin', 'acme-llm', async () => null), /acme-plugin/);

  remove();
  assert.deepEqual(usageCollectorBackends(), []);
  assert.equal((await collectUsageFor(item)).available, false, 'probe removed, no figure any more');
});

test('a ↻ reaches the probe as `force`, at most once per floor, and only a literal true counts', async () => {
  resetForcedUsageProbes();
  const item = pluginProvider('refresh-llm');
  const calls: unknown[][] = [];
  const remove = registerUsageCollector('acme-plugin', 'refresh-llm', async (...args) => {
    calls.push(args);
    return { windows: {}, extra: null };
  });
  try {
    await collectUsageFor(item);
    await collectUsageFor(item, { force: 'yes' } as never);
    await collectUsageFor(item, null as never);
    await collectUsageFor(item, { force: true });
    await collectUsageFor(item, { force: true });
    assert.deepEqual(calls, [[], [], [], [{ force: true }], []],
      'polling sees the call it always saw; a second ↻ inside the floor serves the cache');
    resetForcedUsageProbes();
    await collectUsageFor(item, { force: true });
    assert.deepEqual(calls.at(-1), [{ force: true }], 'past the floor, a ↻ is honoured again');
  } finally {
    remove();
    resetForcedUsageProbes();
  }
});

test("a plugin probe does not replace the product's measure", async () => {
  // `claude` carries the native probe: a plugin cannot stand in for it.
  const native = await collectBackendUsage('claude');
  assert.ok(native, 'claude is an active backend');
  const remove = registerUsageCollector('acme-plugin', 'claude', async () => ({
    windows: { week: { utilization: 7, resets_at: null } },
    extra: null,
  }));
  const after = await collectBackendUsage('claude');
  assert.notEqual(after?.usage?.windows.week?.utilization, 7);
  remove();
});

test('a plugin probe that fails returns an error, not a figure', async () => {
  const item = pluginProvider('flaky-llm');
  const remove = registerUsageCollector('acme-plugin', 'flaky-llm', async () => {
    throw new Error('endpoint injoignable');
  });
  const entry = await collectUsageFor(item);
  assert.equal(entry.available, false);
  assert.equal(entry.usage, null);
  assert.match(entry.error ?? '', /injoignable/);
  remove();
});

test('a missing CLI session is not a probe error', { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-usage-collect-no-oauth-'));
  const previousDir = process.env.CLAUDE_CONFIG_DIR;
  const previousToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CONFIG_DIR = dir;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const { resetClaudeUsageCache } = await import('../tests/helpers/claude-provider.js');
  resetClaudeUsageCache();
  try {
    const entry = await collectBackendUsage('claude');
    assert.ok(entry);
    assert.equal(entry.available, false);
    assert.equal(entry.usage, null);
    assert.equal(entry.connected, false);
    assert.equal(entry.reason, 'not_signed_in');
    assert.equal(entry.error, undefined);
  } finally {
    if (previousDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousDir;
    if (previousToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    else process.env.CLAUDE_CODE_OAUTH_TOKEN = previousToken;
  }
});

test('an unknown backend returns null, never a made-up entry', async () => {
  assert.equal(await collectBackendUsage('backend-qui-nexiste-pas'), null);
  const entries = await collectUsage();
  assert.ok(entries.length > 0, 'at least one active backend');
  for (const entry of entries) {
    assert.equal(typeof entry.backend, 'string');
    // Three states, never a stand-in zero.
    if (!entry.available) assert.equal(entry.usage, null);
  }
});
