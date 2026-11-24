/**
 * TODO #825: a third-party plugin runs in the daemon's process and can import
 * the build. It must not be able to install its own licence keys, edit the
 * pinned ones, or set a paid licence state the verifier did not issue.
 *
 * The refusal only exists outside the test runner, and the runner flag is
 * frozen when the module loads: the real refusal is probed in a child process
 * started WITHOUT `NODE_TEST_CONTEXT`, like `paths.test.ts` does for the home.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-license-guard-test-'));
const { forgetVerifiedLicenses, isVerifiedLicense, unlicensed, verifyLicenseToken } = await import('./license/license.js');
type LicenseState = ReturnType<typeof unlicensed>;
const { LICENSE_PUBLIC_KEYS, activeKeyring, overrideKeyringForTests } = await import('./license/pubkey.js');
const { setLicenseState, unverifiedGrant } = await import('./license/runtime.js');
const { assertTestRunner, isTestRunnerEnv, underTestRunner } = await import('./license/test-runner.js');
const { deviceId } = await import('./license/device.js');

const orchestrator = join(dirname(fileURLToPath(import.meta.url)), '..');

const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'guard-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const now = Math.floor(Date.now() / 1000);
const enc = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
// The frozen contract of the licence server, as `license.test.ts` reads it.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; claims: Record<string, unknown> }[];
};
const base = fixture.examples.find((e) => e.name === 'beta-1-year')?.claims;
assert.ok(base, 'beta-1-year missing from the fixture');
let serial = 0;
function token(overrides: Record<string, unknown> = {}): string {
  serial++;
  const { fph: _fph, ...rest } = base!;
  const claims = { ...rest, lic: `lic-guard-${serial}`, did: deviceId(), iat: now - 1, nbf: now - 61, exp: now + 900, srv: now, ...overrides };
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'guard-test' })}.${enc(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

const forged = (): LicenseState => ({
  status: 'valid', reason: null, plan: 'Forged', planId: 'forged', edition: 'expert', lifetime: true,
  modules: '*', plugins: '*', users: null, expiresAt: null, subscriptionExpiresAt: null,
  paymentStatus: 'active', offlineSince: null,
});

/** Verifies against the test keyring installed as the ACTIVE one, the way production verifies against the pinned keys. */
function verifiedState(overrides: Record<string, unknown> = {}): LicenseState {
  overrideKeyringForTests(keys);
  try { return verifyLicenseToken(token(overrides)); }
  finally { overrideKeyringForTests(null); }
}

test('the runner flag is NODE_TEST_CONTEXT, read once', () => {
  assert.equal(isTestRunnerEnv({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(isTestRunnerEnv({}), false);
  assert.equal(isTestRunnerEnv({ NODE_TEST_CONTEXT: '' }), false);
  assert.equal(isTestRunnerEnv({ NODE_ENV: 'test' }), false, 'NODE_ENV alone is a deployment setting, not the runner');
  assert.equal(underTestRunner(), true);
  assert.throws(() => assertTestRunner('x', false), /only available under the test runner/);
  assert.doesNotThrow(() => assertTestRunner('x', true));
});

test('the pinned licence keyring is frozen, array and entries', () => {
  assert.ok(Object.isFrozen(LICENSE_PUBLIC_KEYS));
  for (const key of LICENSE_PUBLIC_KEYS) assert.ok(Object.isFrozen(key));
  const mutable = LICENSE_PUBLIC_KEYS as { keyId: string; publicKey: string }[];
  assert.throws(() => { mutable.push({ keyId: 'evil', publicKey: 'x' }); }, TypeError);
  const first = mutable[0];
  assert.ok(first);
  const pinned = first.publicKey;
  assert.throws(() => { first.publicKey = 'evil'; }, TypeError);
  assert.equal(LICENSE_PUBLIC_KEYS[0]?.publicKey, pinned);
  assert.equal(activeKeyring(), LICENSE_PUBLIC_KEYS);
});

test('an installed test keyring is copied: editing the caller\'s array changes nothing', () => {
  const mine = [{ keyId: 'guard-test', publicKey: keys[0]!.publicKey }];
  overrideKeyringForTests(mine);
  try {
    mine.push({ keyId: 'evil', publicKey: 'x' });
    mine[0]!.keyId = 'renamed';
    assert.deepEqual(activeKeyring().map((k) => k.keyId), ['guard-test']);
    assert.ok(Object.isFrozen(activeKeyring()));
  } finally { overrideKeyringForTests(null); }
});

test('outside the runner, a state the verifier did not issue is refused; taking rights away never is', () => {
  assert.equal(unverifiedGrant(forged(), false), true);
  assert.equal(unverifiedGrant(unlicensed('missing'), false), false);
  assert.equal(unverifiedGrant(forged(), true), false, 'tests install paid states by hand');
});

test('a state verified against the active keyring passes, with the copies the daemon makes', () => {
  const state = verifiedState();
  assert.equal(state.status, 'valid');
  assert.equal(unverifiedGrant(state, false), false);
  // `licenseState()` copies, `bootLicenseState` / the refresh loop mark it offline.
  const offline = { ...state, offlineSince: new Date().toISOString(), localFree: false };
  assert.equal(unverifiedGrant(offline, false), false);
  // The same object, with more rights, is another state.
  assert.equal(unverifiedGrant({ ...state, users: null }, false), true);
  assert.equal(unverifiedGrant({ ...state, planId: 'enterprise' }, false), true);
  assert.equal(unverifiedGrant({ ...state, expiresAt: new Date(Date.now() + 86_400_000).toISOString() }, false), true);
});

test('keys the caller brings grant nothing outside the runner', () => {
  const ownKeys = verifyLicenseToken(token(), { keys });
  assert.equal(ownKeys.status, 'valid');
  assert.equal(isVerifiedLicense(ownKeys), false);
  assert.equal(unverifiedGrant(ownKeys, false), true);
});

test('a licence that goes off cannot be brought back from a copy', () => {
  const state = verifiedState();
  setLicenseState(state);
  assert.equal(isVerifiedLicense(state), true);
  setLicenseState(unlicensed('revoked'));
  assert.equal(isVerifiedLicense(state), false);
  assert.equal(unverifiedGrant(state, false), true);
  forgetVerifiedLicenses();
});

test('outside the runner, both setters refuse, even once a plugin sets NODE_TEST_CONTEXT', () => {
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-license-guard-child-')), NODE_ENV: 'production' };
  delete env.NODE_TEST_CONTEXT;
  const probe = `
    const { overrideKeyringForTests } = await import('./src/license/pubkey.ts');
    const { setLicenseState, licenseState } = await import('./src/license/runtime.ts');
    const { unlicensed } = await import('./src/license/license.ts');
    const out = {};
    const attempt = (name, fn) => { try { fn(); out[name] = 'ok'; } catch (err) { out[name] = err.message; } };
    attempt('override', () => overrideKeyringForTests([]));
    attempt('forged', () => setLicenseState(${JSON.stringify(forged())}));
    process.env.NODE_TEST_CONTEXT = 'child-v8';
    attempt('overrideAfterEnv', () => overrideKeyringForTests([]));
    attempt('forgedAfterEnv', () => setLicenseState(${JSON.stringify(forged())}));
    attempt('downgrade', () => setLicenseState(unlicensed('missing')));
    out.status = licenseState().status;
    console.log('RESULT' + JSON.stringify(out));
  `;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', probe], { encoding: 'utf8', cwd: orchestrator, env });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT'));
  assert.ok(line, r.stdout + r.stderr);
  const out = JSON.parse(line.slice('RESULT'.length)) as Record<string, string>;
  assert.match(out.override ?? '', /only available under the test runner/);
  assert.match(out.overrideAfterEnv ?? '', /only available under the test runner/);
  assert.match(out.forged ?? '', /refuses a licence the pinned keyring did not verify/);
  assert.match(out.forgedAfterEnv ?? '', /refuses a licence the pinned keyring did not verify/);
  assert.equal(out.downgrade, 'ok');
  assert.equal(out.status, 'unlicensed');
});
