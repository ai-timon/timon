import assert from 'node:assert/strict';
import test from 'node:test';
import { setupErrorMessage } from './setup-license';
import en from '../locales/en/login.json';
import fr from '../locales/fr/login.json';
import { fetchMe } from './auth';

test('onboarding errors have actionable translations and never reflect raw service data', () => {
  for (const locale of [en, fr]) {
    const messages = locale.loginPage as Record<string, string>;
    const t = (key: string) => messages[key.replace('loginPage.', '')]!;
    for (const code of ['license_required', 'license_invalid', 'revoked', 'expired', 'seat_limit', 'device_mismatch', 'license_unavailable', 'rate_limited', 'setup_in_progress', 'user_limit', 'client_upgrade_required', 'transfer_pending', 'free_incompatible', 'build_expired']) {
      assert.ok(setupErrorMessage(code, t));
      assert.notEqual(setupErrorMessage(code, t), messages.setupFailed);
    }
    assert.equal(setupErrorMessage('private-host TMN-SECRET', t), messages.setupFailed);
  }
});

test('the login form receives the release policy from the daemon, defaulting to required', async (t) => {
  for (const policy of [true, false, undefined]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      user: null, needsSetup: true, setupRequiresLicense: policy,
    }), { status: 200 }));
    try {
      const me = await fetchMe();
      assert.equal(me.needsSetup, true);
      assert.equal(me.setupRequiresLicense, policy !== false);
    } finally { mock.mock.restore(); }
  }
});

// The first-account screen is the onboarding's account step: its "never a licence
// field, whatever the policy" test lives with it (components/onboarding/steps/account.test.ts).
