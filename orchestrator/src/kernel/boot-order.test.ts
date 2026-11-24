/**
 * The activation audit: the only guard against a module that does not start
 * WITHOUT A WORD.
 *
 * The trap this test protects against: in Cordis, a plugin whose `inject` is
 * provided by nobody stays PENDING forever. No error, no log:
 * the module simply does not run, and one notices days later
 * because a task was never dispatched. A misspelled dependency
 * or a module disabled by mistake produces exactly that.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Context } from '@deepseek-ai/cordis';
import Loader from '@deepseek-ai/cordis-plugin-loader';

const { auditActivation, formatActivationFailures } = await import('./activation-audit.js');

/** A minimal tree: a loader and nothing else to provide. */
async function loaderContext(): Promise<Context> {
  const ctx = new Context();
  ctx.baseUrl = new URL('.', import.meta.url).href;
  await ctx.plugin(Loader);
  return ctx;
}

test('the audit fails NAMING the missing service of a module left PENDING', async () => {
  const ctx = await loaderContext();
  // `./fixtures/needs-dispatcher.js` declares `inject: ['dispatcher']` and
  // nobody provides `dispatcher`: the exact case of the plan.
  await ctx.loader.create({ id: 'needs-dispatcher', name: './fixtures/needs-dispatcher.js' });

  const failures: unknown[] = [];
  await auditActivation(ctx, { timeoutMs: 1_000, onFailure: (f) => void failures.push(...f) });

  assert.equal(failures.length, 1, 'the module that did not activate must be reported');
  const rendered = formatActivationFailures(failures as never);
  assert.match(rendered, /needs-dispatcher/, 'the report must name the faulty entry');
  assert.match(rendered, /dispatcher/, 'and the service it lacks');
  await ctx.fiber.dispose();
});

test('a tree where everything is satisfied passes the audit without a word', async () => {
  const ctx = await loaderContext();
  await ctx.loader.create({ id: 'provides-dispatcher', name: './fixtures/provides-dispatcher.js' });
  await ctx.loader.create({ id: 'needs-dispatcher', name: './fixtures/needs-dispatcher.js' });

  let called = false;
  const failures = await auditActivation(ctx, { timeoutMs: 1_000, onFailure: () => { called = true; } });
  assert.deepEqual(failures, []);
  assert.equal(called, false, 'no failure must be reported');
  await ctx.fiber.dispose();
});


test('provider readiness is armed before modules can start the dispatcher', () => {
  const source = readFileSync(new URL('../kernel-boot.ts', import.meta.url), 'utf8');
  const armed = source.indexOf('expectProviders();');
  assert.ok(armed >= 0);
  assert.ok(armed < source.indexOf('await ctx.plugin('), 'no module may activate before readiness is armed');
  assert.ok(source.indexOf('providersLoaded();') > source.indexOf('await loader.update();'),
    'the dispatcher is released after official providers are loaded');
});
