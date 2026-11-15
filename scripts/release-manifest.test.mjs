import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  RELEASES_SIGNATURE_DOMAIN, NOTES_MAX, addInstallSignature, boundNotes, channelsFor, compareVersions, composeReleasesPayload, keyIdFor,
  p256KeyPair, releaseKeyPair, serializeEnvelope, signReleasesPayload, validateReleasesPayload, verifyInstallManifest, verifyReleaseManifest,
} from './release-manifest.mjs';

// A throwaway pair per run: no test ever touches ~/.timon-release.
function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}
const now = new Date('2026-11-10T09:00:00.000Z');
const sha = 'c'.repeat(64);
const entry = (version, extra = {}) => ({
  version,
  publishedAt: now.toISOString(),
  notesUrl: 'https://docs.timon-ai.com/changelog',
  notes: `Notes of ${version}`,
  artifacts: {
    'linux-x64-appimage': { name: `Timon-${version}.AppImage`, url: `https://github.com/acme/timon-releases/releases/download/v${version}/Timon-${version}.AppImage`, size: 123, sha256: sha },
    'win-x64-nsis': { name: `Timon.Setup.${version}.exe`, url: `https://github.com/acme/timon-releases/releases/download/v${version}/Timon.Setup.${version}.exe`, size: 456, sha256: sha },
  },
  ...extra,
});
const keyringOf = (key, extra = {}) => [{ keyId: key.keyId, publicKey: key.publicKey, ...extra }];
const decode = (envelope) => JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'));
const reencode = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

test('a signed manifest verifies with its key and returns the payload', () => {
  const key = pair();
  const { payload, changed } = composeReleasesPayload({ entry: entry('0.1.8'), now });
  assert.deepEqual(changed, ['beta', 'stable']);
  const text = serializeEnvelope(signReleasesPayload(payload, key));
  assert.deepEqual(Object.keys(JSON.parse(text)), ['keyId', 'payload', 'sig']);
  assert.match(key.keyId, /^release-[a-f0-9]{16}$/);
  assert.equal(keyIdFor(key.publicKey), key.keyId, 'the keyId derives from the public key alone');
  assert.deepEqual(verifyReleaseManifest(text, keyringOf(key), { now }), payload);
  assert.deepEqual(verifyReleaseManifest(Buffer.from(text), keyringOf(key), { now }), payload);
});

test('an altered payload is refused', () => {
  const key = pair();
  const envelope = signReleasesPayload(composeReleasesPayload({ entry: entry('0.1.8'), now }).payload, key);
  const tampered = decode(envelope);
  tampered.channels.stable.artifacts['win-x64-nsis'].url = 'https://evil.example/Timon.exe';
  assert.throws(() => verifyReleaseManifest({ ...envelope, payload: reencode(tampered) }, keyringOf(key), { now }), /invalid signature/);
  // One flipped byte of the signature as well.
  const sig = Buffer.from(envelope.sig, 'base64');
  sig[0] ^= 1;
  assert.throws(() => verifyReleaseManifest({ ...envelope, sig: sig.toString('base64') }, keyringOf(key), { now }), /invalid signature/);
  assert.throws(() => verifyReleaseManifest({ ...envelope, extra: 1 }, keyringOf(key), { now }), /unexpected field extra/);
  assert.throws(() => verifyReleaseManifest('{not json', keyringOf(key), { now }), /not JSON/);
});

test('an unknown keyId, or a keyId pointing at another key, is refused', () => {
  const key = pair();
  const other = pair();
  const envelope = signReleasesPayload(composeReleasesPayload({ entry: entry('0.1.8'), now }).payload, key);
  assert.throws(() => verifyReleaseManifest(envelope, keyringOf(other), { now }), /unknown keyId/);
  // The keyId is only a lookup: naming a trusted key does not make another key's signature valid.
  assert.throws(() => verifyReleaseManifest({ ...envelope, keyId: other.keyId }, keyringOf(other), { now }), /invalid signature/);
  assert.throws(() => verifyReleaseManifest(envelope, keyringOf(key, { expiresAt: '2026-11-01T00:00:00Z' }), { now }), /has expired/);
  assert.throws(() => verifyReleaseManifest(envelope, [], { now }), /unknown keyId/);
});

test('a signature of the same bytes in another domain is refused', () => {
  const key = pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.1.8'), now });
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const forge = (prefix) => ({ keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(prefix), bytes]), key.privateKey).toString('base64') });
  // What the daemon inventory signature looks like: the raw body, no prefix.
  assert.throws(() => verifyReleaseManifest(forge(''), keyringOf(key), { now }), /invalid signature/);
  assert.throws(() => verifyReleaseManifest(forge('timon-releases-v2\0'), keyringOf(key), { now }), /invalid signature/);
  assert.throws(() => verifyReleaseManifest(forge('timon-releases-v1'), keyringOf(key), { now }), /invalid signature/, 'the separator is part of the domain');
  assert.deepEqual(verifyReleaseManifest(forge(RELEASES_SIGNATURE_DOMAIN), keyringOf(key), { now }), payload);
});

test('an rc goes to beta only and never into stable', () => {
  assert.deepEqual(channelsFor('0.1.8-rc.2'), ['beta']);
  assert.deepEqual(channelsFor('0.1.8'), ['beta', 'stable']);
  const stable = composeReleasesPayload({ entry: entry('0.1.7'), now }).payload;
  const { payload, changed } = composeReleasesPayload({ previous: stable, entry: entry('0.1.8-rc.2'), now });
  assert.deepEqual(changed, ['beta']);
  assert.equal(payload.channels.beta.version, '0.1.8-rc.2');
  assert.equal(payload.channels.stable.version, '0.1.7', 'stable is carried over untouched');
  const first = composeReleasesPayload({ entry: entry('0.1.8-rc.1'), now }).payload;
  assert.equal(first.channels.stable, undefined);
  // A hand-made payload putting an rc in stable fails validation, so a forged
  // but well-signed manifest of that shape cannot exist from this tooling.
  const wrong = { ...first, channels: { stable: entry('0.1.8-rc.1') } };
  assert.throws(() => validateReleasesPayload(wrong), /never goes to the stable channel/);
  const key = pair();
  const bytes = Buffer.from(JSON.stringify(wrong), 'utf8');
  const envelope = { keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, Buffer.concat([Buffer.from(RELEASES_SIGNATURE_DOMAIN), bytes]), key.privateKey).toString('base64') };
  assert.throws(() => verifyReleaseManifest(envelope, keyringOf(key), { now }), /never goes to the stable channel/);
});

test('beta keeps the highest version; an older release changing nothing is refused', () => {
  const rc = composeReleasesPayload({ entry: entry('0.1.8-rc.1'), now }).payload;
  const { payload, changed } = composeReleasesPayload({ previous: rc, entry: entry('0.1.7'), now });
  assert.deepEqual(changed, ['stable']);
  assert.equal(payload.channels.beta.version, '0.1.8-rc.1');
  const final = composeReleasesPayload({ previous: payload, entry: entry('0.1.8'), now }).payload;
  assert.equal(final.channels.beta.version, '0.1.8', 'a final sorts after its rcs');
  assert.throws(() => composeReleasesPayload({ previous: final, entry: entry('0.1.8-rc.3'), now }), /older than every channel/);
  // Republishing the same version is allowed: it refreshes the dates.
  assert.deepEqual(composeReleasesPayload({ previous: final, entry: entry('0.1.8'), now }).changed, ['beta', 'stable']);
  assert.equal(compareVersions('0.1.10-rc.10', '0.1.10-rc.9'), 1);
});

test('dates: expiry, future issue, rollback', () => {
  const key = pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.1.8'), now, validDays: 30 });
  assert.equal(payload.expiresAt, '2026-12-10T09:00:00.000Z');
  const envelope = signReleasesPayload(payload, key);
  const keyring = keyringOf(key);
  assert.throws(() => verifyReleaseManifest(envelope, keyring, { now: new Date('2026-12-11T00:00:00Z') }), /expired/);
  assert.ok(verifyReleaseManifest(envelope, keyring, { now: new Date('2026-12-11T00:00:00Z'), allowExpired: true }));
  assert.throws(() => verifyReleaseManifest(envelope, keyring, { now: new Date('2026-11-10T08:00:00Z') }), /in the future/);
  assert.ok(verifyReleaseManifest(envelope, keyring, { now, minIssuedAt: payload.issuedAt }), 'the same manifest again is fine');
  assert.throws(() => verifyReleaseManifest(envelope, keyring, { now, minIssuedAt: '2026-11-10T09:00:01.000Z' }), /older than the last accepted/);
  assert.throws(() => composeReleasesPayload({ entry: entry('0.1.8'), now, validDays: 0 }), /1 to 365/);
});

test('payload schema refuses what the daemon must never act on', () => {
  const base = () => structuredClone(composeReleasesPayload({ entry: entry('0.1.8-rc.1'), now }).payload);
  const cases = [
    [(p) => { p.channels.beta.artifacts['win-x64-nsis'].url = 'http://github.com/x.exe'; }, /https/],
    [(p) => { p.channels.beta.artifacts['win-x64-nsis'].url = 'https://user:pw@github.com/x.exe'; }, /without credentials/],
    [(p) => { p.channels.beta.artifacts['win-x64-nsis'].sha256 = 'C'.repeat(64); }, /lowercase hex/],
    [(p) => { p.channels.beta.artifacts['win-x64-nsis'].size = 0; }, /positive integer/],
    [(p) => { p.channels.beta.artifacts['win-x64-deb'] = p.channels.beta.artifacts['win-x64-nsis']; }, /unknown artifact key/],
    [(p) => { p.channels.beta.artifacts['win-x64-nsis'].name = '../x.exe'; }, /plain file name/],
    [(p) => { p.channels.nightly = p.channels.beta; }, /unknown channel/],
    [(p) => { p.channels.beta.notes = 'x'.repeat(NOTES_MAX + 1); }, /at most/],
    [(p) => { p.schema = 2; }, /unsupported schema/],
    [(p) => { p.expiresAt = p.issuedAt; }, /follow issuedAt/],
    [(p) => { p.channels.beta.version = '0.1.8-beta'; }, /x\.y\.z/],
    [(p) => { p.channels.stable = { ...p.channels.beta, version: '0.1.9' }; }, /never less than stable/],
  ];
  for (const [mutate, error] of cases) {
    const payload = base();
    mutate(payload);
    assert.throws(() => validateReleasesPayload(payload), error);
  }
});

test('notes stay plain text under the bound, cut at a line', () => {
  assert.equal(boundNotes('a\r\nb\r\n'), 'a\nb');
  const long = Array.from({ length: 50 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
  const cut = boundNotes(long, 200);
  assert.ok(cut.length <= 200);
  assert.ok(cut.endsWith('\n\n…'));
  assert.ok(long.startsWith(cut.slice(0, -3)));
});

test('the release pair must match', () => {
  const a = generateKeyPairSync('ed25519');
  const b = generateKeyPairSync('ed25519');
  assert.throws(() => releaseKeyPair(a.privateKey.export({ type: 'pkcs8', format: 'pem' }), b.publicKey.export({ type: 'spki', format: 'pem' })), /matching Ed25519 pair/);
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 });
  assert.throws(() => releaseKeyPair(rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), rsa.publicKey.export({ type: 'spki', format: 'pem' })), /matching Ed25519 pair/);
});

function p256Pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return p256KeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}

test('the installers\' envelope adds a P-256 signature (DER) of the same signed bytes', () => {
  const key = pair();
  const p256 = p256Pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.1.8'), now });
  const envelope = signReleasesPayload(payload, key);
  const install = addInstallSignature(envelope, p256);
  assert.deepEqual(Object.keys(install), ['keyId', 'payload', 'sig', 'p256']);
  assert.deepEqual(Object.keys(install.p256), ['keyId', 'sig']);
  assert.equal(install.payload, envelope.payload);
  assert.equal(install.sig, envelope.sig, 'the Ed25519 signature is carried over unchanged');
  assert.match(install.p256.keyId, /^release-[a-f0-9]{16}$/);
  const der = Buffer.from(install.p256.sig, 'base64');
  assert.equal(der[0], 0x30, 'a DER SEQUENCE');
  assert.equal(der[1], der.length - 2);
  assert.deepEqual(verifyInstallManifest(serializeEnvelope(install), keyringOf(key), p256, { now }), payload);
  assert.throws(() => verifyReleaseManifest(install, keyringOf(key), { now }), /unexpected field p256/, 'the daemons\' envelope never carries it');
});

test('the installers\' envelope refuses another P-256 key, an altered signature or payload', () => {
  const key = pair();
  const p256 = p256Pair();
  const other = p256Pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.1.8'), now });
  const install = addInstallSignature(signReleasesPayload(payload, key), p256);
  assert.throws(() => verifyInstallManifest(install, keyringOf(key), other, { now }), /unknown P-256 keyId/);
  const forged = addInstallSignature(signReleasesPayload(payload, key), { ...other, keyId: p256.keyId });
  assert.throws(() => verifyInstallManifest(forged, keyringOf(key), p256, { now }), /invalid P-256 signature/);
  const sig = Buffer.from(install.p256.sig, 'base64');
  sig[sig.length - 1] ^= 1;
  assert.throws(() => verifyInstallManifest({ ...install, p256: { ...install.p256, sig: sig.toString('base64') } }, keyringOf(key), p256, { now }), /invalid P-256 signature/);
  const altered = reencode({ ...payload, expiresAt: '2027-12-31T00:00:00.000Z' });
  assert.throws(() => verifyInstallManifest({ ...install, payload: altered }, keyringOf(key), p256, { now }), /invalid P-256 signature/);
  assert.throws(() => verifyInstallManifest({ ...install, p256: undefined }, keyringOf(key), p256, { now }), /envelope/);
  assert.throws(() => p256KeyPair(other.privateKey.export({ type: 'pkcs8', format: 'pem' }), p256.publicKey), /matching ECDSA P-256 pair/);
  assert.throws(() => p256KeyPair(generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }), key.publicKey), /matching ECDSA P-256 pair/);
});

