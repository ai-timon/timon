/**
 * Build channel × licence (beta build separation, 30/09/2026).
 *
 * The contract under test, under the `beta` setup policy: a `beta` build has
 * no Free tier — not when its licence ends, not when the licence file
 * disappears — and stops working at its own `expiresAt` whatever the licence
 * says. `stable` and `dev` builds are exactly what they were. Under the `free`
 * policy (the shipped one since 04/11/2026), only the end date remains.
 */
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-build-policy-test-'));
// Removed at exit, once the database is closed: Windows will not delete an open timon.db.
removeHomeOnExit(process.env.TIMON_HOME);
const { overrideBuildInfo } = await import('./build-info.js');
const { bootLicenseState, recordServerContact, startLicenseRefresh, writeLicenseKey } = await import('./license/refresh.js');
const { installLicenseToken, unlicensed } = await import('./license/license.js');
const runtime = await import('./license/runtime.js');
const { licenseState, mutationLicenseState } = runtime;
/** Every state goes through the test clock, like the daemon goes through its own. */
const setLicenseState = (state: Parameters<typeof runtime.setLicenseState>[0]) => runtime.setLicenseState(state, nowMs());
const { assertLicensedExecution, licenseCurrentlyValid } = await import('./license/capabilities.js');
const { deviceId } = await import('./license/device.js');
const { readLicenseStore, writeLicenseStore } = await import('./license/store.js');
const { bus } = await import('./bus.js');
const { LICENSE_FILE } = await import('./paths.js');
const { overrideSetupPolicyForTests } = await import('./users/setup-policy.js');
// Most of this file is the closed-beta contract: pin it, the last test flips it.
overrideSetupPolicyForTests('beta');

const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; claims: Record<string, unknown> }[];
};
const { fph: _fph, ...base } = fixture.examples.find((e) => e.name === 'beta-1-year')!.claims;
const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const DEVICE = deviceId();
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
function token(at: number): string {
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'test' })}.${enc({ ...base, did: DEVICE, iat: at, nbf: at - 60, exp: at + 900, srv: at, jti: `jti-${at}` })}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}

let clock = Math.floor(Date.now() / 1000);
const nowMs = () => clock * 1000;
const iso = (seconds: number) => new Date(seconds * 1000).toISOString();
const BUILT = iso(clock - 86_400);

const beta = (expiresInSeconds: number | null) => overrideBuildInfo({ channel: 'beta', builtAt: BUILT, expiresAt: expiresInSeconds === null ? null : iso(clock + expiresInSeconds) });
const validState = () => installLicenseToken(token(clock), LICENSE_FILE, { keys, device: DEVICE, fresh: true, now: new Date(nowMs()) });

const events: { kind: string; status: string; reason: string | null }[] = [];
bus.on('event', (ev: { kind: string; status: string; reason: string | null }) => { if (ev.kind === 'license_changed') events.push(ev); });
const notices: { title: string; body: string }[] = [];

function loop(fetchLike?: typeof fetch) {
  const calls: string[] = [];
  const refresh = startLicenseRefresh({
    app: null,
    client: { baseUrl: 'https://licence.test', keys, fetch: (async (url: unknown, init: unknown) => {
      calls.push(new URL(String(url)).pathname);
      if (fetchLike) return fetchLike(url as never, init as never);
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch },
    verify: { keys, device: DEVICE },
    now: nowMs,
    notify: (n) => { notices.push({ title: n.title, body: n.body }); },
    manual: true,
  });
  return { refresh, calls };
}

// Must run first: no `setLicenseState` yet, like a CLI process that never booted.
test('a CLI process without a boot is locked too, not Free', () => {
  beta(null);
  const state = mutationLicenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.localFree, false);
  assert.equal(state.reason, 'missing');
});

test('beta: a valid licence on a live build is untouched', () => {
  beta(3600);
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
  assert.equal(licenseState().reason, null);
});

test('beta: a build past its expiry is build_expired whatever the licence, offline included', () => {
  beta(-60);
  setLicenseState(validState());
  const state = licenseState();
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.reason, 'build_expired');
  assert.equal(state.localFree, false);
  assert.deepEqual(state.modules, []);
  assert.deepEqual(state.plugins, []);
  assert.equal(licenseCurrentlyValid(state), false);
  assert.throws(() => assertLicensedExecution(state), { code: 'license_required' });
});

test('beta: expired build wins over every other state, including a missing licence', () => {
  beta(-1);
  setLicenseState(unlicensed('missing'));
  assert.equal(licenseState().reason, 'build_expired');
  setLicenseState(unlicensed('revoked'));
  assert.equal(licenseState().reason, 'build_expired');
});

test('beta: an expired, revoked or deactivated licence is beta_ended, never Free', () => {
  beta(3600);
  for (const reason of ['expired', 'revoked', 'deactivated'] as const) {
    setLicenseState(unlicensed(reason));
    const state = licenseState();
    assert.equal(state.status, 'unlicensed', reason);
    assert.equal(state.reason, 'beta_ended', reason);
    assert.equal(state.localFree, false, reason);
    assert.equal(state.planId, undefined, reason);
    assert.deepEqual(state.modules, [], reason);
    assert.throws(() => assertLicensedExecution(state), { code: 'license_required' }, reason);
  }
});

test('beta: every other non-valid state is locked as well, keeping its own reason', () => {
  beta(3600);
  for (const reason of ['missing', 'invalid:machine', 'invalid:fingerprint', 'invalid:signature'] as const) {
    setLicenseState(unlicensed(reason));
    assert.equal(licenseState().reason, reason);
    assert.equal(licenseState().localFree, false, reason);
  }
});

test('stable: a dead licence still falls back to local Free, and its expiresAt is ignored', () => {
  overrideBuildInfo({ channel: 'stable', builtAt: BUILT, expiresAt: iso(clock - 3600) });
  setLicenseState(unlicensed('revoked'));
  const state = licenseState();
  assert.equal(state.localFree, true);
  assert.equal(state.reason, 'revoked');
  assert.equal(state.modules, '*');
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
});

test('dev (no stamp): nothing changes, expired licence is Free as before', () => {
  overrideBuildInfo(undefined);
  setLicenseState(unlicensed('expired'));
  assert.equal(licenseState().localFree, true);
  assert.equal(licenseState().reason, 'expired');
  assert.equal(licenseState().modules, '*');
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
  assert.equal(mutationLicenseState().status, 'valid');
});

test('refresh: the build ends while the daemon runs with a valid licence', async () => {
  beta(600);
  writeLicenseKey('TMN-BUILD');
  recordServerContact({ every: 300, offlineHours: 24 }, nowMs());
  setLicenseState(validState());
  events.length = 0; notices.length = 0;
  const { refresh, calls } = loop();

  await refresh.localTick();
  assert.equal(licenseState().status, 'valid');

  clock += 601; // past the build's end; the token (15 min) is still good
  await refresh.localTick();
  assert.equal(licenseState().reason, 'build_expired');
  assert.equal(events.at(-1)?.reason, 'build_expired');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.title, /beta build has expired/);

  await refresh.localTick(); // idempotent: announced once
  assert.equal(notices.length, 1);

  await refresh.tick(); // no server round-trip for a dead build
  assert.deepEqual(calls, []);
  assert.equal(licenseState().reason, 'build_expired');
});

test('refresh: a revocation on a beta build locks it and says there is no Free', async () => {
  clock += 10;
  beta(3600 * 24);
  writeLicenseKey('TMN-BUILD');
  recordServerContact({ every: 300, offlineHours: 24 }, nowMs());
  setLicenseState(validState());
  notices.length = 0;
  const { refresh } = loop(async (url, init) => {
    const nonce = (init as { headers: Record<string, string> }).headers['x-timon-nonce']!;
    const text = JSON.stringify({ error: 'revoked' });
    const headers = new Headers({ 'x-timon-signature': `test.${sign(null, Buffer.from(`${nonce}\n403\n${text}`), pair.privateKey).toString('base64url')}` });
    void url;
    return { ok: false, status: 403, headers, text: async () => text } as unknown as Response;
  });
  await refresh.tick();
  assert.equal(licenseState().reason, 'beta_ended');
  assert.equal(licenseState().localFree, false);
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.body, /no Free tier/);
  assert.doesNotMatch(notices[0]!.body, /uses local Free rights/);

  // The revocation is remembered across a restart: the boot comes up locked.
  setLicenseState(unlicensed('missing'));
  setLicenseState(bootLicenseState({ keys, now: new Date(nowMs()) }));
  assert.equal(licenseState().reason, 'beta_ended');
  assert.equal(licenseState().localFree, false);
});

test('clock guard: winding the clock back after the build expired does not resurrect it', async () => {
  clock += 10;
  beta(600);
  const beta600ExpiresAt = iso(clock + 600);
  const good = validState();
  setLicenseState(good);
  assert.equal(licenseState().status, 'valid');

  clock += 700; // past the end
  setLicenseState(good);
  assert.equal(licenseState().reason, 'build_expired');
  assert.ok((readLicenseStore().clockHigh ?? 0) >= clock - 60);

  clock -= 5000; // the clock goes back to before the end
  assert.ok(nowMs() < Date.parse(beta600ExpiresAt));
  setLicenseState(good); // the licence itself is perfectly valid
  assert.equal(licenseState().reason, 'build_expired');
  const { refresh } = loop();
  await refresh.localTick();
  assert.equal(licenseState().reason, 'build_expired');
  clock += 5000;
});

test('clock guard: the licence server\'s time counts — a server clock past the end expires the build', () => {
  clock += 10;
  beta(3600);
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
  writeLicenseStore({ maxSrv: clock + 7200 }); // the last signed token said it is later than the end
  setLicenseState(validState());
  assert.equal(licenseState().reason, 'build_expired');
  writeLicenseStore({ maxSrv: 0, clockHigh: 0 });
});

test('clock guard: a clock earlier than the build itself is not believed', () => {
  overrideBuildInfo({ channel: 'beta', builtAt: iso(clock + 120), expiresAt: iso(clock + 60) });
  writeLicenseStore({ maxSrv: 0, clockHigh: 0, lastSeen: 0 });
  setLicenseState(validState());
  assert.equal(licenseState().reason, 'build_expired');
});

test('clock guard: a dev build records nothing and ignores the high-water mark', () => {
  writeLicenseStore({ clockHigh: 0 });
  overrideBuildInfo(undefined);
  clock += 1_000_000;
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
  assert.equal(readLicenseStore().clockHigh, 0);
  writeLicenseStore({ clockHigh: Math.floor(Date.now() / 1000) + 10 * 365 * 86400 });
  setLicenseState(validState());
  assert.equal(licenseState().status, 'valid');
  writeLicenseStore({ clockHigh: 0 });
  clock -= 1_000_000;
});

test('free policy: a beta build without a licence runs on local Free, and still stops at its end date', () => {
  overrideSetupPolicyForTests('free');
  // Earlier tests leave clock marks past the end of a fresh build.
  writeLicenseStore({ maxSrv: 0, clockHigh: 0, lastSeen: 0 });
  try {
    beta(3600);
    for (const reason of ['missing', 'expired', 'revoked', 'deactivated'] as const) {
      setLicenseState(unlicensed(reason));
      const state = licenseState();
      assert.equal(state.status, 'unlicensed', reason);
      assert.equal(state.reason, reason, reason);
      assert.equal(state.localFree, true, reason);
      assert.doesNotThrow(() => assertLicensedExecution(state), reason);
    }
    setLicenseState(validState());
    assert.equal(licenseState().status, 'valid');
    beta(-60);
    setLicenseState(unlicensed('missing'));
    assert.equal(licenseState().reason, 'build_expired');
    assert.equal(licenseState().localFree, false);
  } finally {
    overrideSetupPolicyForTests('beta');
    overrideBuildInfo(undefined);
  }
});

test.after(() => { overrideSetupPolicyForTests(undefined); overrideBuildInfo(undefined); });
