import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';
import { t } from './i18n';
import { formatDateTime } from './intl';
import { activationErrorMessage, betaLock, expiryNotices, isActivationKey, licenseCards, submitLicense, type PublicLicense } from './license';

const VALID: PublicLicense = {
  status: 'valid', reason: null, edition: 'expert', plan: 'Timon Expert', lifetime: false,
  expiresAt: '2026-09-03T12:00:00.000Z', subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
};

const AT = Date.parse('2026-09-04T12:00:00.000Z');
const CONTACT = '2026-09-04T08:00:00.000Z';
const FREE: PublicLicense = { ...VALID, status: 'unlicensed', localFree: true, plan: 'Free', reason: 'missing', edition: 'expert', lifetime: true };

test('a server out of reach within the offline tolerance shows nothing', () => {
  assert.deepEqual(licenseCards({ ...VALID, offlineSince: CONTACT }, AT), []);
  assert.deepEqual(licenseCards({ ...VALID, offlineSince: CONTACT, lapse: null }, AT), []);
});

test('nothing while the subscription is paid, nor before the state is read', () => {
  assert.deepEqual(licenseCards(VALID, AT), []);
  assert.deepEqual(licenseCards(null, AT), []);
});

test('the tolerance run out: one "paused" card, keyed by the episode', () => {
  const paused = { ...FREE, reason: 'expired', lapse: { cause: 'offline', since: CONTACT } } satisfies PublicLicense;
  assert.deepEqual(licenseCards(paused, AT), [{ kind: 'paused', id: `license-paused-${Date.parse(CONTACT) / 1000}` }]);
  // Without a known contact the card still shows, under a stable id.
  assert.deepEqual(licenseCards({ ...paused, lapse: { cause: 'offline', since: null } }, AT), [{ kind: 'paused', id: 'license-paused-unknown' }]);
});

test('a licence the server refused: one "refused" card', () => {
  const refused = { ...FREE, reason: 'revoked', lapse: { cause: 'refused', since: CONTACT } } satisfies PublicLicense;
  assert.deepEqual(licenseCards(refused, AT), [{ kind: 'refused', id: `license-refused-${Date.parse(CONTACT) / 1000}` }]);
});

test('rights back: no card any more', () => {
  assert.deepEqual(licenseCards({ ...VALID, lapse: null }, AT), []);
});

test('a late payment is a card, quiet during the beta', () => {
  assert.deepEqual(licenseCards({ ...VALID, paymentStatus: 'past_due' }, AT), [{ kind: 'pastDue', id: 'license-past-due-open', until: null }]);
  assert.deepEqual(
    licenseCards({ ...VALID, paymentStatus: 'past_due', subscriptionExpiresAt: '2026-12-01T00:00:00.000Z' }, AT),
    [{ kind: 'pastDue', id: 'license-past-due-2026-12-01', until: '2026-12-01T00:00:00.000Z' }],
  );
  assert.deepEqual(licenseCards({ ...VALID, paymentStatus: 'past_due' }, AT, { beta: true }), []);
  // A late payment while the server is out of reach is still only the payment.
  assert.deepEqual(licenseCards({ ...VALID, paymentStatus: 'past_due', offlineSince: CONTACT }, AT).map((c) => c.kind), ['pastDue']);
});

test('the licence\'s end is a card 14 days ahead, urgent at 3, with an id per stage', () => {
  const ends = (days: number) => licenseCards({ ...VALID, subscriptionExpiresAt: new Date(AT + days * 86_400_000).toISOString() }, AT);
  assert.deepEqual(ends(30), []);
  assert.deepEqual(ends(10).map((c) => c.id), ['license-ends-2026-09-14']);
  assert.deepEqual(ends(2).map((c) => c.id), ['license-ends-2026-09-06-urgent']);
  assert.deepEqual(licenseCards({ ...VALID, lifetime: true, subscriptionExpiresAt: new Date(AT + 2 * 86_400_000).toISOString() }, AT), []);
});

test('a token minted for another machine names the expected device', () => {
  const message = activationErrorMessage(
    { error: 'licence invalide', reason: 'invalid:machine', device: 'dev_0123456789abcdef' },
    t,
  );
  assert.match(message, /dev_0123456789abcdef/);
  assert.match(message, /invalid:machine/);
});

test('a refusal without device keeps the plain reason', () => {
  assert.equal(activationErrorMessage({ error: 'licence invalide', reason: 'expired' }, t), 'licence invalide (expired)');
  assert.equal(activationErrorMessage({}, t), en.activate.rejected);
});

test('a server-named activation refusal appends its message', () => {
  const message = activationErrorMessage({ error: 'seat_limit', message: 'no seat left on this plan' }, t);
  assert.equal(message, 'seat_limit — no seat left on this plan');
});

test('an activation key is told apart from a JWT by the absence of a dot', () => {
  assert.equal(isActivationKey('TMN-B96R-3NB5-G0Z6-X8DH'), true);
  assert.equal(isActivationKey('  TMN-B96R-3NB5-G0Z6-X8DH  '), true);
  assert.equal(isActivationKey('eyJhbGciOiJFZERTQSIs.eyJzdWIiOiJhY21lIn0.c2ln'), false);
});

test('both locales cover the activate page; the former banner\'s keys are gone', () => {
  for (const dict of [en, fr]) {
    assert.equal(typeof dict.activate.deviceMismatch, 'string');
    assert.match(dict.activate.deviceMismatch, /\{device\}/);
    assert.equal('license' in dict, false, 'the licence speaks through notice cards now');
  }
});

// `t()` merges the root dictionary with a dozen sub-files, the last one
// winning: a key present in a file can still resolve to nothing.
test('the licence card keys resolve through t()', () => {
  assert.match(t('notices.license.pastDue.bodyUntil', { date: '01/10/2026' }), /01\/10\/2026/);
  assert.match(t('notices.license.ends.title', { date: '01/10/2026' }), /01\/10\/2026/);
  for (const key of ['enterKey', 'paused.title', 'paused.body', 'refused.title', 'refused.body', 'pastDue.title', 'pastDue.body']) {
    assert.equal(t(`notices.license.${key}`, { brand: 'Timon' }).includes('notices.license'), false, key);
  }
});

test('commercial refusals resolve to actionable copy in both languages', () => {
  for (const dict of [en, fr]) {
    for (const code of ['plugin_composition_fixed', 'single_superadmin_required', 'free_incompatible', 'license_changed', 'activation_key_missing', 'local_free', 'transfer_pending', 'client_upgrade_required'] as const) {
      const message = activationErrorMessage({ error: code, message: 'server detail' }, (key) => {
        assert.equal(key, `freeLicense.${code}`);
        return dict.freeLicense[code];
      });
      assert.ok(message.length > 20);
      assert.notEqual(message, code);
    }
    assert.match(dict.freeLicense.deactivateConfirm, /data|données/); // french-ok: the French locale under test
  }
});

test('Free has no warning, whatever ended the licence before it', () => {
  // Free is an install without an activation key: the daemon then reports no lapse.
  for (const reason of ['missing', null, 'expired', 'revoked', 'deactivated', 'invalid:format']) {
    assert.deepEqual(licenseCards({ ...FREE, reason }, AT), [], String(reason));
    assert.deepEqual(licenseCards({ ...FREE, reason, lapse: null, paymentStatus: 'past_due', offlineSince: CONTACT }, AT), [], String(reason));
  }
});

test('no message speaks of activating Free any more', () => {
  for (const dict of [en, fr]) {
    for (const code of ['free_incompatible', 'single_superadmin_required', 'local_free'] as const) {
      assert.doesNotMatch(dict.freeLicense[code], /\bFree\b/, code);
    }
  }
});

test('a pending seat transfer names the time to retry (TIM-0017)', () => {
  const retryAt = 1_800_000_000;
  const message = activationErrorMessage({ error: 'transfer_pending', body: { retry_at: retryAt } }, t);
  assert.match(message, new RegExp(formatDateTime(retryAt * 1000).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // Without the time the generic sentence stays.
  assert.equal(activationErrorMessage({ error: 'transfer_pending' }, t), en.freeLicense.transfer_pending);
});

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const inDays = (days: number) => new Date(NOW + days * 86_400_000).toISOString();
const beta = (expiresAt: string | null, extra: Partial<PublicLicense> = {}): PublicLicense => ({ ...VALID, build: { channel: 'beta', expiresAt }, ...extra });

test('the build end is announced 14 days ahead, insisted on at 3', () => {
  assert.deepEqual(expiryNotices(beta(inDays(30)), NOW), []);
  assert.deepEqual(expiryNotices(beta(inDays(14)), NOW), [{ kind: 'build', at: inDays(14), days: 14, urgent: false }]);
  assert.equal(expiryNotices(beta(inDays(4)), NOW)[0]?.urgent, false);
  assert.deepEqual(expiryNotices(beta(inDays(3)), NOW), [{ kind: 'build', at: inDays(3), days: 3, urgent: true }]);
  // Less than a day left still reads as one day, never as zero.
  assert.equal(expiryNotices(beta(inDays(0.2)), NOW)[0]?.days, 1);
});

test('the licence end is announced on its own, and alongside the build end', () => {
  const both = expiryNotices(beta(inDays(10), { subscriptionExpiresAt: inDays(2) }), NOW);
  assert.deepEqual(both.map((n) => [n.kind, n.days, n.urgent]), [['build', 10, false], ['license', 2, true]]);
  const licenceOnly = expiryNotices({ ...VALID, build: { channel: 'stable', expiresAt: null }, subscriptionExpiresAt: inDays(9) }, NOW);
  assert.deepEqual(licenceOnly.map((n) => n.kind), ['license']);
  // An older daemon says nothing of its build: the licence still counts.
  assert.deepEqual(expiryNotices({ ...VALID, subscriptionExpiresAt: inDays(9) }, NOW).map((n) => n.kind), ['license']);
});

test('no notice for a dev build, an endless build, a lifetime plan, a passed date or no licence', () => {
  assert.deepEqual(expiryNotices({ ...VALID, build: { channel: 'dev', expiresAt: inDays(2) }, subscriptionExpiresAt: inDays(2) }, NOW), []);
  assert.deepEqual(expiryNotices(beta(null), NOW), []);
  assert.deepEqual(expiryNotices(beta(null, { lifetime: true, subscriptionExpiresAt: inDays(2) }), NOW), []);
  assert.deepEqual(expiryNotices(beta(inDays(-1), { subscriptionExpiresAt: inDays(-3) }), NOW), []);
  assert.deepEqual(expiryNotices(beta('not a date'), NOW), []);
  assert.deepEqual(expiryNotices(beta(inDays(2), { status: 'unlicensed', reason: 'expired' }), NOW), []);
  assert.deepEqual(expiryNotices(null, NOW), []);
});

test('only a beta build that is not valid is locked, and the reason says what to do', () => {
  const locked = (reason: string, extra: Partial<PublicLicense> = {}): PublicLicense => ({
    ...VALID, status: 'unlicensed', reason, edition: 'lite', localFree: false, build: { channel: 'beta', expiresAt: '2026-09-30T00:00:00.000Z' }, ...extra,
  });
  assert.deepEqual(betaLock(locked('build_expired')), { kind: 'build_expired', buildExpiresAt: '2026-09-30T00:00:00.000Z' });
  assert.equal(betaLock(locked('beta_ended'))?.kind, 'beta_ended');
  assert.equal(betaLock(locked('missing'))?.kind, 'other');
  assert.equal(betaLock(locked('invalid:machine'))?.kind, 'other');
  assert.equal(betaLock(beta(inDays(5))), null, 'a valid licence is not a lock');
  assert.equal(betaLock(locked('revoked', { build: { channel: 'stable', expiresAt: null } })), null, 'stable falls back to Free');
  assert.equal(betaLock(locked('revoked', { build: { channel: 'dev', expiresAt: null }, localFree: true })), null);
  assert.equal(betaLock(locked('revoked', { build: undefined })), null, 'an older daemon says nothing of its build');
  assert.equal(betaLock(null), null);
});

test('both locales carry the lock screen', () => {
  const keys = [
    'betaLock.build_expired_title', 'betaLock.build_expired', 'betaLock.build_expired_undated', 'betaLock.beta_ended_title',
    'betaLock.beta_ended', 'betaLock.other_title', 'betaLock.other', 'betaLock.keyTitle', 'betaLock.submit', 'betaLock.notAdmin',
    'betaLock.export', 'betaLock.exported', 'betaLock.exportFailed', 'betaLock.exportAdminOnly', 'betaLock.signOut',
  ];
  for (const locale of [en, fr] as unknown as Array<Record<string, Record<string, string>>>) {
    for (const key of keys) {
      const [group, name] = key.split('.');
      assert.ok(locale[group!]?.[name!], key);
    }
  }
  // Free does not exist on a beta build: none of this copy may offer it.
  for (const locale of [en, fr] as unknown as Array<Record<string, Record<string, string>>>) {
    for (const value of Object.values(locale.betaLock!)) assert.doesNotMatch(value, /\bfree\b|gratuit/i);
  }
});

/** Replays `answers` in order and records each request the page would send. */
function stubFetch(answers: { status: number; body: unknown }[]): { calls: { url: string; method: string; body: unknown }[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: { url: string; method: string; body: unknown }[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET', body: JSON.parse(String(init?.body ?? 'null')) });
    const next = answers.shift();
    if (!next) throw new Error('unexpected request');
    return new Response(JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test('a short key goes to /activate, a token to PUT /license', async () => {
  const keyed = stubFetch([{ status: 200, body: { edition: 'expert' } }]);
  try {
    assert.deepEqual(await submitLicense('  TMN-AAAA-BBBB  ', async () => true), { status: 'installed', edition: 'expert' });
    assert.deepEqual(keyed.calls, [{ url: '/api/ui/license/activate', method: 'POST', body: { key: 'TMN-AAAA-BBBB', force: false } }]);
  } finally { keyed.restore(); }
  const pasted = stubFetch([{ status: 400, body: { error: 'invalid license', reason: 'invalid:key' } }]);
  try {
    assert.deepEqual(await submitLicense('a.b.c', async () => true), { status: 'refused', body: { error: 'invalid license', reason: 'invalid:key' } });
    assert.deepEqual(pasted.calls, [{ url: '/api/ui/license', method: 'PUT', body: { token: 'a.b.c', force: false } }]);
  } finally { pasted.restore(); }
});

test('a downgrade is sent again with force only once confirmed', async () => {
  const downgrade = { status: 409, body: { error: 'downgrade', current: { edition: 'expert', plan: null }, next: { edition: 'lite', plan: null } } };
  const declined = stubFetch([downgrade]);
  try {
    let asked: string | undefined;
    assert.deepEqual(await submitLicense('TMN-LESS', async (refusal) => { asked = refusal.next?.edition; return false; }), { status: 'cancelled' });
    assert.equal(asked, 'lite');
    assert.equal(declined.calls.length, 1);
  } finally { declined.restore(); }
  const accepted = stubFetch([downgrade, { status: 200, body: { edition: 'lite' } }]);
  try {
    assert.deepEqual(await submitLicense('TMN-LESS', async () => true), { status: 'installed', edition: 'lite' });
    assert.deepEqual(accepted.calls.map((call) => call.body), [{ key: 'TMN-LESS', force: false }, { key: 'TMN-LESS', force: true }]);
  } finally { accepted.restore(); }
});
