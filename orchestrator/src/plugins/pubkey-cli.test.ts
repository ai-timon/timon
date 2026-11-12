/**
 * Admission of unsigned code from a CLI process that never booted.
 *
 * `timon plugin add` asks `unsignedPluginsAllowed()` whether the daemon will
 * mount what it just installed, from a process where `setLicenseState` never
 * ran. The answer must come from the installed receipt under the build policy
 * (`mutationLicenseState()`), for both questions the gate asks: rights in force
 * and a fixed composition. This file deliberately imports nothing that sets the
 * licence state (no `tests/helpers/paid-license.js`).
 */
import '../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { unsignedPluginsAllowed } = await import('./pubkey.js');
const { mutationLicenseState } = await import('../license/runtime.js');
const { overrideBuildInfo } = await import('../build-info.js');
const { overrideSetupPolicyForTests } = await import('../users/setup-policy.js');

const A_KEY = [{ keyId: 'timon-plugins-2026-11', publicKey: 'irrelevant-here' }] as const;

test('without a boot and without a licence file, a stable build is Free and follows the setting', () => {
  overrideBuildInfo({ channel: 'stable' });
  const state = mutationLicenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.localFree, true);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY }), true);
  assert.equal(unsignedPluginsAllowed(undefined, { keys: A_KEY }), false);
  assert.equal(unsignedPluginsAllowed(false, { keys: A_KEY }), false);
  overrideBuildInfo(undefined);
});

test('without a boot, a locked beta build refuses unsigned code even with true', () => {
  overrideSetupPolicyForTests('beta');
  overrideBuildInfo({ channel: 'beta' });
  try {
    const state = mutationLicenseState();
    assert.equal(state.localFree, false);
    assert.equal(state.capabilities?.plugins, 'fixed');
    assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY }), false);
    assert.equal(unsignedPluginsAllowed(true, { keys: [] }), false);
  } finally {
    overrideBuildInfo(undefined);
    overrideSetupPolicyForTests(undefined);
  }
});
