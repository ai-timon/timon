/**
 * The White Label right: replacing the whole interface (slot `root`) needs a
 * valid paid licence whose signed `features` names `whitelabel` exactly. The
 * right rides on a claim every token already carries, so tokens issued for
 * earlier daemons verify exactly as before.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-white-label-licence-'));
const { verifyLicenseToken, fingerprintHash, isVerifiedLicense, unlicensed } = await import('./license/license.js');
const { whiteLabelAllowed, WHITE_LABEL_FEATURE } = await import('./license/capabilities.js');
const { betaLocked } = await import('./license/build-policy.js');
const { setLicenseState, licenseState } = await import('./license/runtime.js');
const { deviceId } = await import('./license/device.js');
const { fingerprint } = await import('./license/fingerprint.js');
const { overrideKeyringForTests } = await import('./license/pubkey.js');

const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'white-label-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
// Pinned rather than passed per call: only a verification against the pinned
// keyring is remembered as a granted right (`isVerifiedLicense`).
overrideKeyringForTests(keys);
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; claims: Record<string, unknown> }[];
};
const claimsOf = (name: string): Record<string, unknown> => fixture.examples.find((e) => e.name === name)!.claims;

function token(claims: Record<string, unknown>): string {
  const body = { ...claims, did: deviceId(), fph: fingerprintHash(fingerprint()), iat: now, nbf: now - 60, exp: now + 900, srv: now };
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'white-label-test' })}.${enc(body)}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const paid = (features: string[], extra: Record<string, unknown> = {}) =>
  verifyLicenseToken(token({ ...claimsOf('beta-1-year'), plan: 'pro', plan_name: 'Pro', modules: '*', plugins: '*', features, ...extra }));

test('a paid licence whose features name `whitelabel` grants the right', () => {
  const state = paid(['code-pipeline', WHITE_LABEL_FEATURE]);
  assert.equal(state.status, 'valid');
  assert.deepEqual(state.features, ['code-pipeline', 'whitelabel']);
  assert.equal(whiteLabelAllowed(state), true);
});

test('a paid licence with every plugin but without the string has no right', () => {
  const state = paid(['code-pipeline', 'browser']);
  assert.equal(state.status, 'valid');
  assert.equal(state.plugins, '*');
  assert.equal(whiteLabelAllowed(state), false);
  // Exact match only: neither a wildcard nor a look-alike opens it.
  assert.equal(whiteLabelAllowed(paid(['*'])), false);
  assert.equal(whiteLabelAllowed(paid(['WhiteLabel', 'white-label', 'whitelabel:trial'])), false);
});

test('a retired Free token carrying the string never grants the right', () => {
  const free = verifyLicenseToken(token({ ...claimsOf('free'), features: [WHITE_LABEL_FEATURE] }));
  assert.equal(free.status, 'unlicensed', 'a Free token reads as no licence');
  assert.equal(free.reason, 'missing');
  assert.equal(whiteLabelAllowed(free), false);
  setLicenseState(free);
  assert.equal(licenseState().localFree, true);
  assert.equal(whiteLabelAllowed(licenseState()), false);
  assert.equal(whiteLabelAllowed(unlicensed('missing')), false);
});

test('the issuer examples grant the right exactly when their features name it (contract v9)', () => {
  let granted = 0;
  for (const example of fixture.examples) {
    if (example.name === 'free') continue;
    const features = example.claims.features as string[];
    const state = verifyLicenseToken(token(example.claims));
    assert.equal(state.status, 'valid', example.name);
    assert.equal(whiteLabelAllowed(state), features.includes(WHITE_LABEL_FEATURE), example.name);
    if (features.includes(WHITE_LABEL_FEATURE)) granted += 1;
  }
  // v9 gives it to the Developer plan only: a fixture where nobody holds it
  // would leave the positive path untested against the issuer's own shape.
  assert.equal(granted, 1);
});

test('tokens issued for earlier daemons verify unchanged, without the right', () => {
  // Before v9 no plan carried the string: the same claims minus the right.
  for (const example of fixture.examples) {
    if (example.name === 'free') continue;
    const features = (example.claims.features as string[]).filter((f) => f !== WHITE_LABEL_FEATURE);
    const state = verifyLicenseToken(token({ ...example.claims, features }));
    assert.equal(state.status, 'valid', example.name);
    assert.equal(whiteLabelAllowed(state), false, example.name);
  }
  assert.equal(whiteLabelAllowed(paid([])), false);
});

test('a beta-locked install has no right', () => {
  for (const reason of ['beta_ended', 'build_expired', 'missing'] as const) {
    const state = betaLocked(reason);
    assert.deepEqual(state.features, []);
    assert.equal(whiteLabelAllowed(state), false);
  }
});

test('the right survives the runtime copy and counts as a verified right', () => {
  const granted = paid([WHITE_LABEL_FEATURE]);
  setLicenseState(granted);
  const live = licenseState();
  assert.deepEqual(live.features, ['whitelabel']);
  assert.equal(whiteLabelAllowed(live), true);
  // A state that differs only by the right is another grant: a copy of a
  // licence without it cannot be turned into one that has it.
  const plain = paid([], { lic: 'lic_without_white_label' });
  assert.equal(isVerifiedLicense(plain), true);
  assert.equal(isVerifiedLicense({ ...plain, features: [WHITE_LABEL_FEATURE] }), false);
  assert.equal(isVerifiedLicense({ ...granted, features: [WHITE_LABEL_FEATURE, 'extra'] }), false);
  // Order is not a right.
  const two = paid(['a', WHITE_LABEL_FEATURE]);
  assert.equal(isVerifiedLicense({ ...two, features: [WHITE_LABEL_FEATURE, 'a'] }), true);
});
