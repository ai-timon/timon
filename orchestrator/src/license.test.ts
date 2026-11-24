import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-license-test-'));
const { effectiveEdition, fingerprintHash, installLicenseToken, readLicense, verifyLicenseToken } = await import('./license/license.js');
const { overrideKeyringForTests } = await import('./license/pubkey.js');
const { fileClockAnchor, readLicenseStore } = await import('./license/store.js');
const { setLicenseState, licenseState } = await import('./license/runtime.js');
const { deviceId, rotateDeviceId } = await import('./license/device.js');
const { fingerprint, machineId } = await import('./license/fingerprint.js');
const { registerRoutes } = await import('./kernel/routes/license.js');
const { attachBundledReconciler } = await import('./kernel/bundled-reload.js');
const { attachPluginLoader } = await import('./plugins/runtime.js');
const { applyLicensedSurfaces } = await import('./kernel/routes/license.js');

// A vendored copy of the frozen contract (`timon-site/fixtures/token-claims.json`): the
// tests never read an absolute path into the other repository.
const fixture = JSON.parse(readFileSync(new URL('../fixtures/token-claims.json', import.meta.url), 'utf8')) as {
  examples: { name: string; header: Record<string, unknown>; claims: Record<string, unknown> }[];
};
const example = (name: string) => {
  const found = fixture.examples.find((e) => e.name === name);
  assert.ok(found, `example ${name} missing from the fixture`);
  return found;
};

const pair = generateKeyPairSync('ed25519');
const keys = [{ keyId: 'test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
const now = Math.floor(Date.now() / 1000);
/** Device identifier of THIS daemon: the test tokens are issued for it,
 *  as the server issues for the `deviceId()` the activation sent it. */
const DEVICE = deviceId();
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

/** Claims of the contract, aligned on the test clock (the fixture is dated). */
/** The fixture carries `fph` for the machine whose `fp` is 64 zeros; tokens
 *  for THIS machine drop it unless a test binds one on purpose. */
function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { fph: _fph, ...base } = example('beta-1-year').claims;
  return { ...base, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now, ...overrides };
}
const FIXTURE_FP = '0'.repeat(64);
function signed(payload: Record<string, unknown>, header: Record<string, unknown> = {}): string {
  const input = `${enc({ alg: 'EdDSA', typ: 'JWT', kid: 'test', ...header })}.${enc(payload)}`;
  return `${input}.${sign(null, Buffer.from(input), pair.privateKey).toString('base64url')}`;
}
const token = (overrides: Record<string, unknown> = {}) => signed(claims(overrides));
/** The device binding is no longer optional: except when the test targets it,
 *  the check starts from the real identifier of the test machine. */
const verify = (tok: string, opts: Record<string, unknown> = {}) =>
  verifyLicenseToken(tok, { keys, device: DEVICE, ...opts });

/** Who the express tests call as. Superadmin daemon-token unless a test says otherwise. */
type Caller = { kind: 'daemon-token' | 'session' | 'api-token'; isSuperadmin: boolean };
let caller: Caller = { kind: 'daemon-token', isSuperadmin: true };
const asCaller: express.RequestHandler = (req, _res, next) => {
  req.auth = { kind: caller.kind, user: null, isSuperadmin: caller.isSuperadmin } as typeof req.auth;
  next();
};
/** Signs a licence-server answer the way `timon-site` does (§5.9). */
function signedAnswer(init: RequestInit | undefined, status: number, body: unknown): Response {
  const text = JSON.stringify(body);
  const nonce = new Headers(init?.headers).get('x-timon-nonce') ?? '';
  const signature = `test.${sign(null, Buffer.from(`${nonce}\n${status}\n${text}`), pair.privateKey).toString('base64url')}`;
  return new Response(text, { status, headers: { 'content-type': 'application/json', 'x-timon-signature': signature } });
}

test('no file: local Free, the whole product, a single account', () => {
  const state = readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys });
  assert.equal(state.status, 'unlicensed');
  assert.equal(state.edition, 'expert');
  assert.equal(effectiveEdition('expert', state.edition), 'expert');
  assert.equal(effectiveEdition('lite', state.edition), 'lite', 'the lite preset stays the owner\'s choice');
});

test('an empty keyring never grants paid capabilities, with or without a token', () => {
  const file = join(process.env.TIMON_HOME!, 'empty-keyring.jwt');
  for (const present of [false, true]) {
    if (present) writeFileSync(file, token());
    const state = readLicense(file, { keys: [] });
    assert.equal(state.status, 'unlicensed');
    assert.equal(state.reason, present ? 'invalid:key' : 'missing');
    // Free is the whole product for one person: what a paid licence adds is
    // accounts, and an unverifiable token never unlocks them.
    assert.equal(state.localFree, true);
    assert.equal(state.modules, '*');
    assert.equal(state.users, 1);
    assert.equal(state.capabilities?.accounts, 'single-superadmin');
  }
});

test('the examples of the contract are accepted', () => {
  for (const name of ['beta-1-year', 'beta-lifetime', 'developer']) {
    const source = example(name);
    // `did` aligned on this device, as the server issues for the device
    // declared to it; the rest of the claims is the contract one.
    const state = verify(signed({ ...source.claims, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: FIXTURE_FP });
    assert.equal(state.status, 'valid', name);
    // The fixture's `fph` is a real binding: another machine is refused.
    assert.equal(verify(signed({ ...source.claims, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: '1'.repeat(64) }).reason, 'invalid:fingerprint', name);
    assert.equal(state.reason, null);
    assert.equal(state.edition, 'expert');
    assert.deepEqual(state.modules, source.claims.modules);
    assert.equal(state.plugins, '*');
    assert.equal(state.paymentStatus, 'active');
  }
});

test('sub_exp null (developer plan) passes, a dated sub_exp is returned as ISO', () => {
  const developer = example('developer').claims;
  assert.equal(developer.sub_exp, null);
  const verified = verify(signed({ ...developer, did: DEVICE, iat: now - 1, nbf: now - 61, exp: now + 900, srv: now }), { fingerprint: FIXTURE_FP });
  assert.equal(verified.status, 'valid');
  assert.equal(verified.planId, 'internal');
  assert.equal(verified.subscriptionExpiresAt, null);
  const dated = verify(token({ sub_exp: 1767225600 }));
  assert.equal(dated.subscriptionExpiresAt, new Date(1767225600 * 1000).toISOString());
});

test('the claims of the contract cross the schema without being lost', () => {
  // Drift detection: if the server renames a claim, the fixture changes and
  // this test says so, without ever rejecting a token for an informative claim.
  const state = verify(token());
  const source = claims();
  assert.equal(state.edition, source.edition);
  assert.deepEqual(state.modules, source.modules);
  assert.equal(state.plugins, source.plugins);
  assert.equal(state.expiresAt, new Date((source.exp as number) * 1000).toISOString());
  for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'status']) {
    assert.ok(claim in source, `claim ${claim} absent du contrat`);
  }
  // `plan_name` is one of the three optional claims (with `fph` and `users`):
  // it arrived after the contract was frozen, the tokens already issued do not carry it. Present, it is what is
  // shown; absent, the plan identifier does the job.
  assert.equal(verify(token()).plan, source.plan_name);
  const { plan_name: _omit, ...sansLabel } = source;
  assert.equal(verify(signed(sansLabel)).plan, source.plan);
});

test('v4: seats null is an unlimited-machines licence, not a malformed token', () => {
  // Typed as a plain integer until v4, which made an unlimited licence
  // unusable client-side (`invalid:format`) even though the server had
  // signed it.
  const state = verify(token({ seats: null }));
  assert.equal(state.status, 'valid');
  assert.equal(state.reason, null);
  // Still a required key: a token that dropped it did not come from the server.
  const { seats: _omit, ...sansSeats } = claims();
  assert.equal(verify(signed(sansSeats)).reason, 'invalid:format');
});

test('v4: the users quota travels, and its absence restricts nothing', () => {
  assert.equal(verify(token({ users: 3 })).users, 3);
  // `null` = unlimited profiles, and so does the absent claim: tokens issued
  // before v4 carry none and must not suddenly cap an install.
  assert.equal(verify(token({ users: null })).users, null);
  const { users: _omit, ...sansUsers } = claims();
  const state = verify(signed(sansUsers));
  assert.equal(state.status, 'valid');
  assert.equal(state.users, null);
  // A malformed quota is a malformed token — no silent fallback to unlimited.
  assert.equal(verify(token({ users: 'three' })).reason, 'invalid:format');
  // TODO #551: zero would lock every profile out; unlimited is `null`.
  assert.equal(verify(token({ users: 0 })).reason, 'invalid:format');
  assert.equal(verify(token({ users: -1 })).reason, 'invalid:format');
});

test('a lite licence restricts an expert config', () => {
  assert.equal(effectiveEdition('expert', verify(token({ edition: 'lite' })).edition), 'lite');
});

test('status past_due stays a valid licence (banner, not refusal)', () => {
  const state = verify(token({ status: 'past_due' }));
  assert.equal(state.status, 'valid');
  assert.equal(state.paymentStatus, 'past_due');
  assert.equal(state.modules !== '*' && state.modules.length > 0, true);
});

test('clock guards: iat, nbf and srv', () => {
  assert.equal(verify(token({ iat: now + 120 })).reason, 'invalid:clock');
  assert.equal(verify(token({ nbf: now + 120 })).reason, 'invalid:clock');
  // 60 s tolerance: an nbf just in the future passes.
  assert.equal(verify(token({ nbf: now + 30 })).status, 'valid');
  assert.equal(verify(token({ srv: now + 7200 })).reason, 'invalid:clock');
});

test('expiry: no more local grace, the expired token is refused', () => {
  assert.equal(verify(token({ exp: now - 120 })).reason, 'expired');
  // 14 days of grace no longer exist (PRD 03: revocation ≤ 15 min).
  assert.equal(verify(token({ exp: now - 86400 })).status, 'unlicensed');
  // Clock tolerance: an expiry to the second does not reject.
  assert.equal(verify(token({ exp: now - 30 })).status, 'valid');
});

test('a lifetime plan expires like the others: "lifetime" qualifies the subscription, not the token (L-2)', () => {
  // Until 04/09 a `sub_exp: null` token ignored `exp`: a permanent bearer,
  // duplicable, irrevocable. The renewal loop now exists, the
  // guard has no more reason to be lifted.
  const aVie = verify(token({ sub_exp: null, exp: now - 86400 }));
  assert.equal(aVie.status, 'unlicensed');
  assert.equal(aVie.reason, 'expired');
  const frais = verify(token({ sub_exp: null }));
  assert.equal(frais.status, 'valid');
  assert.equal(frais.lifetime, true);
  // The token announces its due date, like all the others.
  assert.equal(typeof frais.expiresAt, 'string');
  assert.equal(verify(token({ sub_exp: now + 86400 })).lifetime, false);
  // A dated subscription keeps its expiry.
  assert.equal(verify(token({ sub_exp: now + 86400, exp: now - 120 })).reason, 'expired');
});

test('offline tolerance: graceUntil accepts an expired token, up to the given instant (L-7)', () => {
  const expired = token({ exp: now - 3600 });
  assert.equal(verify(expired, { graceUntil: now + 60 }).status, 'valid');
  assert.equal(verify(expired, { graceUntil: now - 1 }).reason, 'expired');
});

test('srv measures a drift, never an age (L-6)', () => {
  // Read back from disk, a 48 h old token whose exp still holds
  // (artificial: TTL 15 min) is not refused for its old `srv`.
  const ancien = token({ iat: now - 172_800, nbf: now - 172_860, srv: now - 172_800, exp: now + 900 });
  assert.equal(verify(ancien).status, 'valid');
  // The same token ARRIVING from the server betrays a clock off by a day.
  assert.equal(verify(ancien, { fresh: true }).reason, 'invalid:clock');
  // Two server values that diverge: the token is not consistent.
  assert.equal(verify(token({ srv: now - 7200 })).reason, 'invalid:clock');
  // A fresh token whose srv matches the local clock passes.
  assert.equal(verify(token(), { fresh: true }).status, 'valid');
});

test('fph: the token is bound to the machine, not only to the device-id file (L-2)', () => {
  const fp = 'a'.repeat(64);
  assert.equal(verify(token({ fph: fingerprintHash(fp) }), { fingerprint: fp }).status, 'valid');
  assert.equal(verify(token({ fph: fingerprintHash(fp) }), { fingerprint: 'b'.repeat(64) }).reason, 'invalid:fingerprint');
  // Without `fph` (a token from before the amendment), the `did` binding alone applies.
  assert.equal(verify(token(), { fingerprint: 'b'.repeat(64) }).status, 'valid');
  // Strict grammar: a malformed `fph` is a malformed token.
  assert.equal(verify(token({ fph: 'zz' })).reason, 'invalid:format');
});

test('clock anchor: an srv older than one already accepted, or a local clock set back, is refused (L-5)', () => {
  const file = join(process.env.TIMON_HOME!, 'anchor-test.json');
  const anchor = fileClockAnchor(file);
  assert.equal(verify(token(), { anchor }).status, 'valid');
  assert.equal(readLicenseStore(file).maxSrv, now);
  // A token issued before that one: replayed or revived by faketime.
  assert.equal(verify(token({ iat: now - 3600, nbf: now - 3660, srv: now - 3600, exp: now + 900 }), { anchor }).reason, 'invalid:clock:rollback');
  // A local clock two days behind the last instant seen.
  const past = new Date((now - 2 * 86400) * 1000);
  assert.equal(verify(token({ iat: now - 2 * 86400, nbf: now - 2 * 86400 - 60, srv: now - 2 * 86400, exp: now - 2 * 86400 + 900 }), { anchor, now: past }).reason, 'invalid:clock:rollback');
  // One minute of drift between two servers is not a step back.
  assert.equal(verify(token({ iat: now - 30, nbf: now - 90, srv: now - 30 }), { anchor }).status, 'valid');
  // A refusal does not move the anchor.
  assert.equal(readLicenseStore(file).maxSrv, now);
});

test('did: the device binding is mandatory, never implicit', () => {
  // A token issued for ANOTHER machine does not run here, even signed.
  assert.equal(verify(token({ did: example('beta-1-year').claims.did as string })).reason, 'invalid:machine');
  assert.equal(verify(token({ did: 'dev_0000000000000000' })).reason, 'invalid:machine');
  // `did` missing: a required claim of the contract, hence format, not a free pass.
  const { did: _did, ...withoutDid } = claims();
  assert.equal(verify(signed(withoutDid)).reason, 'invalid:format');
  // Without an explicit `device`, the check resolves the daemon identifier.
  assert.equal(verifyLicenseToken(token(), { keys }).status, 'valid');
  assert.equal(verifyLicenseToken(token({ did: 'dev_0000000000000000' }), { keys }).reason, 'invalid:machine');
});

test('deviceId: opaque, persistent, identical to the one readLicense compares', () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  assert.match(DEVICE, /^dev_[0-9a-f]{16}$/);
  // Persistence: two calls return the same id, and it is indeed on disk.
  assert.equal(deviceId(), DEVICE);
  assert.equal(readFileSync(join(process.env.TIMON_HOME!, 'device-id'), 'utf8').trim(), DEVICE);
  // Production path: readLicense without an explicit `device` reads this file.
  writeFileSync(file, token());
  assert.equal(readLicense(file, { keys }).status, 'valid');
  // The same token, issued for another device, is refused by that path.
  writeFileSync(file, token({ did: 'dev_ffffffffffffffff' }));
  assert.equal(readLicense(file, { keys }).reason, 'invalid:machine');
});

test('fresh install: the device is drawn on the fly, a token from before is refused', () => {
  // The case the previous test does NOT cover: no `device-id` on
  // disk yet. It is the first boot after a reinstall, with a token
  // inherited from the previous install; it must fall, not pass by default.
  const fresh = mkdtempSync(join(tmpdir(), 'timon-license-fresh-'));
  const idFile = join(fresh, 'device-id');
  const file = join(fresh, 'license.jwt');
  writeFileSync(file, token({ did: 'dev_ffffffffffffffff' }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).reason, 'invalid:machine');
  // The drawn identifier is new, persisted, and different from the test daemon one.
  const drawn = readFileSync(idFile, 'utf8').trim();
  assert.match(drawn, /^dev_[0-9a-f]{16}$/);
  assert.notEqual(drawn, DEVICE);
  assert.equal(deviceId(idFile), drawn);
  // A token issued for THIS new device passes.
  writeFileSync(file, token({ did: drawn }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');
});

test('fingerprint: a stable hash of the machine-id, never the raw identifier', () => {
  // The §5.8 contract: 64 lowercase hex, and nothing else leaves the machine.
  const fp = fingerprint('b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e');
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(fingerprint('b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e'), fp);
  assert.notEqual(fp.includes('b8e3f1a2'), true);
  // Two machines, two fingerprints: that is all the server decides on.
  assert.notEqual(fingerprint('une-autre-machine'), fp);
  // The spaces of the file do not count: /etc/machine-id ends with \n.
  assert.equal(fingerprint('  b8e3f1a2-0000-4c11-9d55-7e0a1b2c3d4e\n'), fp);
  // No made-up fingerprint when the OS returns nothing: a bogus value would bind
  // the activation to a machine that does not exist, and the next boot would be
  // refused with device_mismatch.
  assert.throws(() => fingerprint(null));
  assert.throws(() => fingerprint('   '));
  // On this machine, the OS answers: the production path is walked through.
  const raw = machineId();
  if (raw !== null) assert.match(fingerprint(), /^[0-9a-f]{64}$/);
});

test('rotateDeviceId: the emergency exit of the 409 device_mismatch', () => {
  // ~/.timon copied from another machine: the server returned
  // device_mismatch, a new identifier is drawn and activation is retried once.
  const home = mkdtempSync(join(tmpdir(), 'timon-license-clone-'));
  const idFile = join(home, 'device-id');
  const file = join(home, 'license.jwt');
  const copied = deviceId(idFile);
  writeFileSync(file, token({ did: copied }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');

  const rotated = rotateDeviceId(idFile);
  assert.match(rotated, /^dev_[0-9a-f]{16}$/);
  assert.notEqual(rotated, copied);
  // Persisted, hence stable at the next boot.
  assert.equal(readFileSync(idFile, 'utf8').trim(), rotated);
  assert.equal(deviceId(idFile), rotated);
  // The token inherited from the copy is worth nothing on this machine any more.
  assert.equal(readLicense(file, { keys, device: rotated }).reason, 'invalid:machine');
  // And the token the server will issue for the new identifier passes.
  writeFileSync(file, token({ did: rotated }));
  assert.equal(readLicense(file, { keys, device: deviceId(idFile) }).status, 'valid');
});

test('header: alg, typ and kid are validated', () => {
  assert.equal(verify(signed(claims(), { typ: 'JWE' })).reason, 'invalid:format');
  assert.equal(verify(signed(claims(), { alg: 'HS256' })).reason, 'invalid:format');
  assert.equal(verify(signed(claims(), { kid: '' })).reason, 'invalid:format');
});

test("modules: '*' or @timon/* ids, nothing else", () => {
  assert.equal(verify(token({ modules: '*' })).modules, '*');
  assert.deepEqual(verify(token({ modules: ['@timon/dreams'] })).modules, ['@timon/dreams']);
  assert.equal(verify(token({ modules: ['dreams'] })).reason, 'invalid:format');
  assert.equal(verify(token({ modules: ['@autre/dreams'] })).reason, 'invalid:format');
  // Plugin ids are third-party npm packages: no prefix imposed.
  assert.deepEqual(verify(token({ plugins: ['acme-widget'] })).plugins, ['acme-widget']);
});

test('every claim of the contract is required (sub_exp nullable, not optional)', () => {
  for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'sub_exp', 'status']) {
    const partial = { ...claims() };
    delete partial[claim];
    assert.equal(verify(signed(partial)).reason, 'invalid:format', `missing claim ${claim} should be refused`);
  }
  // The examples of the contract do carry all these claims.
  for (const name of ['beta-1-year', 'beta-lifetime', 'developer']) {
    for (const claim of ['sub', 'lic', 'did', 'plan', 'edition', 'modules', 'plugins', 'features', 'seats', 'iat', 'nbf', 'exp', 'srv', 'jti', 'sub_exp', 'status']) {
      assert.ok(claim in example(name).claims, `${claim} missing from example ${name}`);
    }
  }
});

test('unknown kid, forged signature and broken format are told apart', () => {
  assert.equal(verify(token(), { keys: [{ ...keys[0]!, keyId: 'autre' }] }).reason, 'invalid:key');
  const [header, payload, signature] = token().split('.') as [string, string, string];
  const flipped = Buffer.from(signature, 'base64url');
  flipped[0] = flipped[0]! ^ 0xff;
  assert.equal(verify(`${header}.${payload}.${flipped.toString('base64url')}`).reason, 'invalid:signature');
  assert.equal(verify('invalide').reason, 'invalid:format');
  // Required claim missing: format, never a mute licence.
  const { status: _status, ...withoutStatus } = claims();
  assert.equal(verify(signed(withoutStatus)).reason, 'invalid:format');
});

test('an invalid install does not replace the file', () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  const state = installLicenseToken('invalide', file, { keys });
  assert.equal(state.status, 'unlicensed');
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('PUT /api/license refuses an invalid JWT without touching the file', async () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  const response = await fetch(`http://127.0.0.1:${port}/api/license`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'invalide' }),
  });
  assert.equal(response.status, 400);
  assert.equal(readFileSync(file, 'utf8'), original);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

// A successful `installLicenseToken` over HTTP would require a token signed by the
// production PRIVATE key, absent from the repository by construction (§4 of the
// `timon-site` runbook); like `PUT /api/license refuses an invalid JWT` above,
// this path is only played as a refusal. `applyLicensedSurfaces` (what the
// success would trigger) is therefore tested directly, outside HTTP.
function fakeApp(): { get(key: string): unknown; set(key: string, value: unknown): unknown } {
  const store = new Map<string, unknown>();
  return { get: (key) => store.get(key), set: (key, value) => { store.set(key, value); return undefined; } };
}

test('applyLicensedSurfaces recomposes the bundled modules AND rereads the licensed plugins (lic-6)', async () => {
  const app = fakeApp();
  let reconciled = 0;
  attachBundledReconciler(app, {
    reconcile: () => { reconciled += 1; return Promise.resolve([]); },
    watch: () => () => {},
    dispose: () => {},
  });
  let updated = 0;
  attachPluginLoader(app, { update: () => { updated += 1; return Promise.resolve([]); } } as unknown as Parameters<typeof attachPluginLoader>[1]);

  await applyLicensedSurfaces(app as unknown as Parameters<typeof applyLicensedSurfaces>[0]);
  assert.equal(reconciled, 1);
  assert.equal(updated, 1);
});

test('applyLicensedSurfaces crashes nothing outside a booted kernel (no reconciler/loader attached)', async () => {
  await assert.doesNotReject(applyLicensedSurfaces(fakeApp() as unknown as Parameters<typeof applyLicensedSurfaces>[0]));
});

test('a reconciler or a loader that rejects does not make applyLicensedSurfaces fail', async () => {
  const app = fakeApp();
  attachBundledReconciler(app, {
    reconcile: () => Promise.reject(new Error('boom')),
    watch: () => () => {},
    dispose: () => {},
  });
  attachPluginLoader(app, { update: () => Promise.reject(new Error('boom')) } as unknown as Parameters<typeof attachPluginLoader>[1]);
  await assert.doesNotReject(applyLicensedSurfaces(app as unknown as Parameters<typeof applyLicensedSurfaces>[0]));
});

test('the failure of the install triggers no recomposition', async () => {
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  let reconciled = 0;
  attachBundledReconciler(app, {
    reconcile: () => { reconciled += 1; return Promise.resolve([]); },
    watch: () => () => {},
    dispose: () => {},
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/license`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'invalide' }),
    });
    assert.equal(response.status, 400);
    assert.equal(reconciled, 0);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('the licence is not a catalogue module', async () => {
  // Decision of 30/08: the licence is a door of the kernel, not a brick
  // one installs or disables. It must therefore not appear in
  // the catalogue, and hence not as a gallery card either,
  // which derives from `CATALOG` through `bundledModuleRows`.
  const { CATALOG } = await import('./kernel/catalog.js');
  const { BUNDLED_IDENTITY } = await import('./plugins/bundled-identity.js');
  assert.equal(CATALOG.some((m) => m.id === 'core-license'), false);
  assert.equal('core-license' in BUNDLED_IDENTITY, false);
  // The count goes down as "end of the core tier" takes the modules that can
  // be disabled out of the kernel (30/08: `@timon/projects` went `std`, the
  // secrets vault `opt`, the notification centre `std`, the memory `opt`).
  // 05/11/2026: `@timon/users` joins it.
  assert.equal(CATALOG.filter((m) => m.tier === 'core').length, 8);
});

/**
 * `POST /api/license/activate` calls the license-server client, which uses
 * `globalThis.fetch` (no `opts.fetch` threading through the route). Swapping
 * it for the duration of one test — and delegating anything that is not the
 * license-server call to the real `fetch` — lets these tests hit both the
 * mocked server AND the local express instance through the same global.
 */
async function withMockedLicenseServer<T>(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/v1/license/')) return handler(url, init as RequestInit);
    return original(input as never, init);
  }) as typeof fetch;
  try { return await run(); }
  finally { globalThis.fetch = original; }
}

async function withActivateServer<T>(run: (port: number) => Promise<T>, as: Caller = { kind: 'daemon-token', isSuperadmin: true }): Promise<T> {
  caller = as;
  overrideKeyringForTests(keys);
  const app = express();
  app.use(express.json());
  app.use(asCaller);
  registerRoutes(app);
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = (server.address() as { port: number }).port;
  try { return await run(port); }
  finally {
    overrideKeyringForTests(null);
    caller = { kind: 'daemon-token', isSuperadmin: true };
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

const post = (port: number, path: string, body: unknown) => fetch(`http://127.0.0.1:${port}${path}`, {
  method: path === '/api/license' ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

test('L-3: the install routes are 403 for a mission token and for a non-superadmin session', async () => {
  for (const as of [{ kind: 'api-token', isSuperadmin: false }, { kind: 'session', isSuperadmin: false }] as Caller[]) {
    await withActivateServer(async (port) => {
      assert.equal((await post(port, '/api/license', { token: token() })).status, 403, `PUT as ${as.kind}`);
      assert.equal((await post(port, '/api/license/activate', { key: 'TMN-TEST' })).status, 403, `activate as ${as.kind}`);
      // Reading stays open: it is everybody's banner.
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/license`)).status, 200);
    }, as);
  }
  // A mission token marked superadmin (does not exist, but the refusal must hold on `kind`).
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token() })).status, 403);
  }, { kind: 'api-token', isSuperadmin: true });
  // La session superadmin passe.
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token() })).status, 200);
  }, { kind: 'session', isSuperadmin: true });
});

test('L-3: a downgrade requires force: true', async () => {
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: '*' }) })).status, 200);
    assert.equal(licenseState().edition, 'expert');
    const refused = await post(port, '/api/license', { token: token({ edition: 'lite', modules: [] }) });
    assert.equal(refused.status, 409);
    const body = await refused.json() as { error: string; current: { edition: string }; next: { edition: string } };
    assert.equal(body.error, 'downgrade');
    assert.equal(body.current.edition, 'expert');
    assert.equal(body.next.edition, 'lite');
    assert.equal(licenseState().edition, 'expert');
    // One module less is a downgrade too…
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: ['@timon/dreams'] }) })).status, 409);
    // …and force lets it through.
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'lite', modules: [] }), force: true })).status, 200);
    assert.equal(licenseState().edition, 'lite');
    // Going up asks for nothing.
    assert.equal((await post(port, '/api/license', { token: token({ edition: 'expert', modules: '*' }) })).status, 200);
    setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
  });
});

test('L-1: a successful activation persists the key and the server schedule', async () => {
  const { readLicenseKey } = await import('./license/refresh.js');
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 200, { token: token(), refresh: { every: 120, offlineHours: 48 } }),
    () => withActivateServer(async (port) => {
      const response = await post(port, '/api/license/activate', { key: 'TMN-PERSIST' });
      assert.equal(response.status, 200);
      assert.equal(readLicenseKey(), 'TMN-PERSIST');
      const store = readLicenseStore();
      assert.equal(store.every, 120);
      assert.equal(store.offlineHours, 48);
      assert.ok(store.lastContact && store.lastContact >= now - 5);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    }),
  );
});

test('POST /api/license/activate refuses a missing key without calling the server', async () => {
  await withActivateServer(async (port) => {
    const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: '' }),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, 'missing license key');
  });
});

test('POST /api/license/activate relays the refusal of the licence server', async () => {
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 409, { error: 'seat_limit', message: 'no seat left' }),
    () => withActivateServer(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TMN-TEST' }),
      });
      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(body.error, 'seat_limit');
      assert.equal(body.message, 'no seat left');
    }),
  );
});

test('POST /api/license/activate refuses a token this daemon does not recognise without installing it', async () => {
  const file = join(process.env.TIMON_HOME!, 'license.jwt');
  const original = token();
  writeFileSync(file, original);
  // A response signed by the key the daemon pins, but a token signed by another
  // one: the server on the other side is genuine, the token is not.
  const issued = signed(claims(), { kid: 'unknown' });
  await withMockedLicenseServer(
    (_url, init) => signedAnswer(init, 200, { token: issued }),
    () => withActivateServer(async (port) => {
      const response = await fetch(`http://127.0.0.1:${port}/api/license/activate`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'TMN-TEST' }),
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).reason, 'invalid:key');
      assert.equal(readFileSync(file, 'utf8'), original);
    }),
  );
});

test('the pinned production key is indeed the one of the published JWKS', async () => {
  const { LICENSE_PUBLIC_KEYS } = await import('./license/pubkey.js');
  const { createPublicKey } = await import('node:crypto');
  const pinned = LICENSE_PUBLIC_KEYS.find((k) => k.keyId === 'license-2026-09');
  assert.ok(pinned, 'production key missing from the registry');
  const jwk = createPublicKey(pinned.publicKey).export({ format: 'jwk' }) as { crv?: string; x?: string };
  assert.equal(jwk.crv, 'Ed25519');
  assert.equal(jwk.x, '5lx205PP0N9rtsGjKdJHBO0sv4IO5GtzwL62eP4LOwE');
});

/**
 * `POST /api/license/name` (PRD §5.10). The name is written once; what this
 * daemon can display afterwards is only what its own accepted write returned,
 * since neither the token nor the 409 carries it.
 */
test('POST /api/license/name records the accepted name and publishes it', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { ok: true, customName: 'atelier' }),
      () => withActivateServer(async (port) => {
        const response = await post(port, '/api/license/name', { name: '  atelier  ' });
        assert.equal(response.status, 200);
        const body = await response.json() as { machineName: string; machineNameLocked: boolean };
        assert.equal(body.machineName, 'atelier');
        assert.equal(body.machineNameLocked, true);
        // Survives a restart: the state file is the only place the name lives.
        assert.equal(readLicenseStore().machineName, 'atelier');
        // And `GET` says the same thing, since the page reads that one.
        const read = await (await fetch(`http://127.0.0.1:${port}/api/license`)).json() as { machineName: string };
        assert.equal(read.machineName, 'atelier');
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name relays 409 name_locked and stops offering the field', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 409, { error: 'name_locked', message: 'This machine already has a name; a name is set once.' }),
      () => withActivateServer(async (port) => {
        const response = await post(port, '/api/license/name', { name: 'second try' });
        assert.equal(response.status, 409);
        assert.equal((await response.json() as { error: string }).error, 'name_locked');
        // §5.10 sends no name back, so none is stored — but the lock is, which
        // is what turns the form into a plain sentence.
        const store = readLicenseStore();
        assert.equal(store.machineNameLocked, true);
        assert.equal(store.machineName ?? null, null);
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name refuses an invalid name before any network call', async () => {
  const { writeLicenseKey, forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName } = await import('./license/store.js');
  forgetMachineName();
  setLicenseState(verifyLicenseToken(token(), { keys, device: DEVICE }));
  writeLicenseKey('TMN-NAME');
  let calls = 0;
  try {
    await withMockedLicenseServer(
      (_url, init) => { calls += 1; return signedAnswer(init, 200, { ok: true, customName: 'x' }); },
      () => withActivateServer(async (port) => {
        for (const name of ['', '   ', 'x'.repeat(33), 'line\nbreak', 42]) {
          const response = await post(port, '/api/license/name', { name });
          assert.equal(response.status, 400, `expected ${JSON.stringify(name)} to be refused`);
          assert.equal((await response.json() as { error: string }).error, 'invalid_name');
        }
        assert.equal(calls, 0);
        assert.equal(readLicenseStore().machineNameLocked ?? false, false);
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('POST /api/license/name is refused for a mission token, like its neighbours', async () => {
  await withActivateServer(async (port) => {
    assert.equal((await post(port, '/api/license/name', { name: 'atelier' })).status, 403);
  }, { kind: 'api-token', isSuperadmin: true });
});

test('POST /api/license/name without an activation key never reaches the server', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  forgetLicenseKey();
  await withActivateServer(async (port) => {
    const response = await post(port, '/api/license/name', { name: 'atelier' });
    assert.equal(response.status, 409);
    assert.equal((await response.json() as { error: string }).error, 'activation_key_missing');
  });
});

test('re-activating the SAME key keeps the machine name, another key drops it', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { token: token(), refresh: { every: 120, offlineHours: 48 } }),
      () => withActivateServer(async (port) => {
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SAME' })).status, 200);
        writeLicenseStore({ machineName: 'atelier', machineNameLocked: true });
        // A repair — same key, re-activated. The name is not re-readable from
        // anywhere, so losing it here would lose it for good.
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SAME' })).status, 200);
        assert.equal(readLicenseStore().machineName, 'atelier');
        // Another licence, another activation: its name is not this one's.
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-OTHER' })).status, 200);
        const store = readLicenseStore();
        assert.equal(store.machineName, null);
        assert.equal(store.machineNameLocked, false);
        setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('activating another key replaces the renewal key and drops the previous schedule', async () => {
  const { forgetLicenseKey, readLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  let refresh: { every: number; offlineHours: number } | undefined = { every: 120, offlineHours: 48 };
  try {
    await withMockedLicenseServer(
      (_url, init) => signedAnswer(init, 200, { token: token(), ...(refresh ? { refresh } : {}) }),
      () => withActivateServer(async (port) => {
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-FIRST' })).status, 200);
        writeLicenseStore({ machineName: 'atelier', machineNameLocked: true, machineNameLicense: 'lic_first' });
        refresh = undefined;
        assert.equal((await post(port, '/api/license/activate', { key: 'TMN-SECOND' })).status, 200);
        assert.equal(readLicenseKey(), 'TMN-SECOND');
        const store = readLicenseStore();
        assert.equal(store.machineName, null);
        assert.equal(store.machineNameLocked, false);
        assert.equal(store.machineNameLicense, null);
        assert.equal(store.every, undefined);
        assert.equal(store.offlineHours, undefined);
        assert.ok(store.lastContact && store.lastContact >= now - 5);
        setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      }),
    );
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('PUT /api/license forgets the previous licence\'s name and key, keeps them on the same licence', async () => {
  const { forgetLicenseKey, readLicenseKey, writeLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withActivateServer(async (port) => {
      // The shape a hand-pasted token actually arrives in: named under one
      // licence, and nothing valid installed any more — the token expired,
      // which is precisely why someone is pasting a fresher one. Comparing
      // against the LIVE state here would read every repair as a replacement.
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      writeLicenseStore({ machineName: 'atelier', machineNameLocked: true, machineNameLicense: claims().lic as string });
      writeLicenseKey('TMN-SAME');
      const repair = await post(port, '/api/license', { token: token({ jti: 'another-token' }) });
      assert.equal(repair.status, 200);
      const kept = await repair.json() as { machineName: string | null; machineNameLocked: boolean };
      assert.equal(kept.machineName, 'atelier');
      assert.equal(kept.machineNameLocked, true);
      assert.equal(readLicenseKey(), 'TMN-SAME');
      // Another licence, pasted from the same expired footing: the recorded
      // `lic` is the only thing that can tell it from the repair above.
      // Asserted on the ANSWER, not on the store — a forget that lands after
      // the response would still leave the old name on screen.
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
      const replaced = await post(port, '/api/license', { token: token({ lic: 'lic_other' }) });
      assert.equal(replaced.status, 200);
      const body = await replaced.json() as { machineName: string | null; machineNameLocked: boolean };
      assert.equal(body.machineName, null);
      assert.equal(body.machineNameLocked, false);
      assert.equal(readLicenseStore().machineNameLocked, false);
      // The key renewed the licence that just left: keeping it would put its
      // token back over the one just installed.
      assert.equal(readLicenseKey(), null);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    });
  } finally { forgetLicenseKey(); forgetMachineName(); }
});

test('PUT /api/license clears an unbound name and renewal key', async () => {
  const { forgetLicenseKey } = await import('./license/refresh.js');
  const { forgetMachineName, writeLicenseStore } = await import('./license/store.js');
  forgetLicenseKey();
  forgetMachineName();
  try {
    await withActivateServer(async (port) => {
      // Unknown provenance cannot keep a stale renewal key tied to the old licence.
      writeLicenseStore({ machineName: 'atelier', machineNameLocked: true });
      const response = await post(port, '/api/license', { token: token({ lic: 'lic_yet_another' }) });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { machineName: string | null }).machineName, null);
      setLicenseState(readLicense(join(process.env.TIMON_HOME!, 'absent.jwt'), { keys }));
    });
  } finally { forgetLicenseKey(); forgetMachineName(); }
});
