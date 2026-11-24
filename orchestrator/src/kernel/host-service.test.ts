/**
 * The `host` service: the platform adapter seen from the Cordis tree.
 *
 * What these tests protect: that a module can get the host through
 * `inject: ['host']` (hence AFTER `boot.ts` set it, never before), that
 * it is the SAME object as the `getHost()` singleton (otherwise an injected
 * module and a file outside a plugin would work on two distinct hosts),
 * and that the capabilities deciding the activation of modules have a
 * single source: `host.capabilities()`.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';

const { config } = await import('../config/load.js');
const { createHost, getHost } = await import('../host/index.js');
const { setHasSystemdForTest } = await import('../host/systemd.js');
const { createHostPlugin } = await import('./host-service.js');
const { diagnose } = await import('../doctor.js');

test('a module that injects `host` receives the adapter set by the boot', async () => {
  const host = createHost(config());
  const root = new Context();
  await root.plugin(createHostPlugin(host));

  let seen: unknown = null;
  await root.plugin({
    name: 'consommateur',
    inject: ['host'],
    apply(ctx: Context) { seen = ctx.host; },
  });

  assert.equal(seen, host, 'the module must see the boot host, not a copy');
});

test('without a provider, a module that injects `host` stays PENDING', async () => {
  const root = new Context();
  let applied = false;
  await root.plugin({ name: 'orphelin', inject: ['host'], apply() { applied = true; } });
  // That is the expected Cordis behaviour, and why `boot.ts` sets the
  // service BEFORE creating the loader entries.
  assert.equal(applied, false);
});

test('the singleton and the service return the same host', () => {
  const host = createHost(config());
  assert.equal(getHost(), host);
});

test('the host capabilities are not empty on this machine', () => {
  const caps = createHost(config()).capabilities();
  assert.ok(caps.length > 0, 'a dev machine can at least do git');
  assert.ok(caps.includes('git'), 'git is on the PATH of this repository');
});

test('the systemd capability follows the user manager probe', () => {
  // Linux does not imply systemd: `createHost` only lists it when
  // `hasSystemd()` has reached the user manager. An agent scope without
  // a session (`XDG_RUNTIME_DIR` / bus missing) fails that probe, and
  // asserting the capability from `process.platform` alone is a phantom
  // red. Inject the probe — same hook as `resources.test.ts` — so both
  // branches run on every machine.
  try {
    setHasSystemdForTest(true);
    const withManager = createHost(config()).capabilities();
    if (process.platform === 'linux') {
      assert.ok(
        withManager.includes('systemd'),
        'reachable user manager → linux host lists systemd',
      );
    } else {
      assert.equal(
        withManager.includes('systemd'),
        false,
        'non-linux never lists systemd, even with the probe forced on',
      );
    }

    setHasSystemdForTest(false);
    const withoutManager = createHost(config()).capabilities();
    assert.equal(
      withoutManager.includes('systemd'),
      false,
      'unreachable user manager → generic host, systemd absent from capabilities',
    );
  } finally {
    setHasSystemdForTest(null);
  }
});

test('the diagnosis no longer recomputes the capabilities, it reads the host ones', () => {
  const host = createHost(config());
  assert.deepEqual(diagnose().capabilities, host.capabilities());
});
