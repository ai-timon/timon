/**
 * The signed update manifest, `releases.json` (docs/AUTO-UPDATE.md §3).
 *
 * Composition and signing run on the Linux build machine (publish-release.mjs);
 * verification is the part the daemon reuses (P1b), so this module depends on
 * `node:crypto` alone and never reads a file or the network itself.
 *
 * Envelope: `{ "keyId": "...", "payload": "<base64 of the JSON>", "sig": "<base64 Ed25519>" }`.
 * Signed bytes: RELEASES_SIGNATURE_DOMAIN followed by the payload bytes, so a
 * signature made by the same release key for anything else (the daemon
 * inventory, `release-manifest.sig`) can never be replayed as an update
 * manifest, and the reverse.
 *
 * The installers read a second file, INSTALL_RELEASES_URL: the same envelope
 * plus `p256: { keyId, sig }`, an ECDSA P-256 / SHA-256 signature (DER) of the
 * same signed bytes. macOS (LibreSSL) and Windows PowerShell (.NET Framework)
 * cannot verify Ed25519 but verify P-256 natively. It is a separate file
 * because the daemons already installed accept exactly `{ keyId, payload, sig }`
 * at RELEASES_URL and would refuse any extra field.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto';

export const RELEASES_SCHEMA = 1;
export const RELEASES_SIGNATURE_DOMAIN = 'timon-releases-v1\0';
export const RELEASES_URL = 'https://timon-ai.com/.well-known/timon-releases.json';
export const INSTALL_RELEASES_URL = 'https://timon-ai.com/.well-known/timon-releases-install.json';
export const CHANNELS = Object.freeze(['beta', 'stable']);
/** Release notes are plain text in the payload; anything longer is cut and points to `notesUrl`. */
export const NOTES_MAX = 64 * 1024;
/** An envelope larger than this is refused before parsing: the real one is a few KB. */
export const ENVELOPE_MAX = 1024 * 1024;
/** Tolerated clock skew for an `issuedAt` slightly in the future of the verifier. */
export const CLOCK_SKEW_MS = 5 * 60_000;
export const DEFAULT_VALID_DAYS = 60;

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OS_FORMATS = { linux: ['appimage', 'deb'], mac: ['pkg', 'dmg'], win: ['nsis'] };
const ARTIFACT_KEY = /^(linux|mac|win)-(x64|arm64|universal)-(appimage|deb|pkg|dmg|nsis)$/;

function versionParts(value) {
  const match = typeof value === 'string' && value.match(VERSION);
  return match ? [BigInt(match[1]), BigInt(match[2]), BigInt(match[3]), match[4] === undefined ? null : BigInt(match[4])] : null;
}

export const isVersion = (value) => versionParts(value) !== null;
export const isPrerelease = (version) => versionParts(version)?.[3] != null;

/** SemVer precedence restricted to `x.y.z[-rc.N]`: a final version sorts after its rcs. */
export function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  if (!left || !right) throw new Error(`invalid version: ${left ? b : a}`);
  for (let i = 0; i < 4; i++) {
    if (left[i] === right[i]) continue;
    if (left[i] === null) return 1;
    if (right[i] === null) return -1;
    return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

/** An rc only goes to `beta`; a final version goes to both channels. */
export const channelsFor = (version) => (isPrerelease(version) ? ['beta'] : [...CHANNELS]);

/**
 * The key identifier derived from the public key itself (SHA-256 of its SPKI
 * DER, 16 hex digits): it needs no configuration on the build machine and the
 * daemon keyring pins the same value next to the PEM.
 */
export function keyIdFor(publicKey) {
  const der = createPublicKey(publicKey).export({ type: 'spki', format: 'der' });
  return `release-${createHash('sha256').update(der).digest('hex').slice(0, 16)}`;
}

/** Both PEM texts of the release pair; refuses anything but a matching Ed25519 pair. */
export function releaseKeyPair(privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
    throw new Error('Release signing keys must be a matching Ed25519 pair');
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey: publicKeyPem, keyId: keyIdFor(publicKeyPem) };
}

/** Both PEM texts of the installer pair; refuses anything but a matching ECDSA P-256 pair. */
export function p256KeyPair(privatePem, publicPem) {
  const privateKey = createPrivateKey(privatePem);
  const publicKey = createPublicKey(publicPem);
  const isP256 = (key) => key.asymmetricKeyType === 'ec' && key.asymmetricKeyDetails?.namedCurve === 'prime256v1';
  if (!isP256(privateKey) || !isP256(publicKey)
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
    throw new Error('Installer signing keys must be a matching ECDSA P-256 pair');
  }
  const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKey, publicKey: publicKeyPem, keyId: keyIdFor(publicKeyPem) };
}

const fail = (message) => { throw new Error(`releases.json: ${message}`); };
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function exactKeys(value, keys, where) {
  if (!plainObject(value)) fail(`${where} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${where}: unexpected field ${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail(`${where}: missing field ${key}`);
}
function isoDate(value, where) {
  if (typeof value !== 'string' || !ISO.test(value) || Number.isNaN(Date.parse(value))) fail(`${where} must be an ISO 8601 UTC date`);
  return Date.parse(value);
}
function httpsUrl(value, where) {
  let url;
  try { url = new URL(value); } catch { fail(`${where} must be a URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) fail(`${where} must be a plain https: URL, without credentials or query`);
}

/**
 * The strict shape of the payload (schema 1). The daemon will mirror it in
 * zod; this is the reference both sides are tested against.
 */
export function validateReleasesPayload(payload) {
  exactKeys(payload, ['schema', 'issuedAt', 'expiresAt', 'channels'], 'payload');
  if (payload.schema !== RELEASES_SCHEMA) fail(`unsupported schema ${payload.schema}`);
  if (isoDate(payload.issuedAt, 'issuedAt') >= isoDate(payload.expiresAt, 'expiresAt')) fail('expiresAt must follow issuedAt');
  if (!plainObject(payload.channels) || !Object.keys(payload.channels).length) fail('channels must list at least one channel');
  for (const [name, channel] of Object.entries(payload.channels)) {
    if (!CHANNELS.includes(name)) fail(`unknown channel ${name}`);
    exactKeys(channel, ['version', 'publishedAt', 'notesUrl', 'notes', 'artifacts'], `channels.${name}`);
    if (!isVersion(channel.version)) fail(`channels.${name}.version is not x.y.z[-rc.N]`);
    if (name === 'stable' && isPrerelease(channel.version)) fail(`an rc (${channel.version}) never goes to the stable channel`);
    isoDate(channel.publishedAt, `channels.${name}.publishedAt`);
    httpsUrl(channel.notesUrl, `channels.${name}.notesUrl`);
    if (typeof channel.notes !== 'string' || channel.notes.length > NOTES_MAX) fail(`channels.${name}.notes must be text of at most ${NOTES_MAX} characters`);
    if (!plainObject(channel.artifacts) || !Object.keys(channel.artifacts).length) fail(`channels.${name}.artifacts is empty`);
    for (const [key, artifact] of Object.entries(channel.artifacts)) {
      const match = key.match(ARTIFACT_KEY);
      if (!match || !OS_FORMATS[match[1]].includes(match[3])) fail(`unknown artifact key ${key}`);
      const where = `channels.${name}.artifacts.${key}`;
      exactKeys(artifact, ['name', 'url', 'size', 'sha256'], where);
      if (typeof artifact.name !== 'string' || !ASSET.test(artifact.name)) fail(`${where}.name is not a plain file name`);
      httpsUrl(artifact.url, `${where}.url`);
      if (!Number.isSafeInteger(artifact.size) || artifact.size < 1) fail(`${where}.size must be a positive integer`);
      if (typeof artifact.sha256 !== 'string' || !SHA256.test(artifact.sha256)) fail(`${where}.sha256 must be 64 lowercase hex digits`);
    }
  }
  const { beta, stable } = payload.channels;
  if (beta && stable && compareVersions(beta.version, stable.version) < 0) fail('the beta channel carries the highest version of rc and final, never less than stable');
  return payload;
}

/**
 * Plain text, cut at a line boundary under NOTES_MAX: the full changelog stays
 * one click away at `notesUrl`.
 */
export function boundNotes(text, max = NOTES_MAX) {
  const notes = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (notes.length <= max) return notes;
  const marker = '\n\n…';
  const head = notes.slice(0, max - marker.length);
  const cut = head.lastIndexOf('\n');
  return (cut > 0 ? head.slice(0, cut) : head).trimEnd() + marker;
}

/**
 * Next payload: the new entry replaces each channel of its version unless that
 * channel already carries a strictly higher version (beta holding 0.1.8-rc.1
 * keeps it when 0.1.7 is published). Untouched channels are carried over.
 * Refuses a version that would change no channel at all.
 */
export function composeReleasesPayload({ previous = null, entry, now = new Date(), validDays = DEFAULT_VALID_DAYS }) {
  if (!Number.isInteger(validDays) || validDays < 1 || validDays > 365) throw new Error('validity must be 1 to 365 days');
  const channels = { ...(previous?.channels ?? {}) };
  const changed = [];
  for (const name of channelsFor(entry.version)) {
    const current = channels[name];
    if (current && compareVersions(current.version, entry.version) > 0) continue;
    channels[name] = entry;
    changed.push(name);
  }
  if (!changed.length) throw new Error(`${entry.version} is older than every channel it targets (${channelsFor(entry.version).map((name) => `${name} ${channels[name].version}`).join(', ')}); nothing to publish`);
  const issuedAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + validDays * 86_400_000).toISOString();
  return { payload: validateReleasesPayload({ schema: RELEASES_SCHEMA, issuedAt, expiresAt, channels }), changed };
}

const signedBytes = (payloadBytes) => Buffer.concat([Buffer.from(RELEASES_SIGNATURE_DOMAIN, 'utf8'), payloadBytes]);

/** The envelope, ready to be written as `releases.json`. */
export function signReleasesPayload(payload, { privateKey, keyId }) {
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error('invalid keyId');
  const bytes = Buffer.from(JSON.stringify(validateReleasesPayload(payload)), 'utf8');
  return { keyId, payload: bytes.toString('base64'), sig: sign(null, signedBytes(bytes), privateKey).toString('base64') };
}

export const serializeEnvelope = (envelope) => JSON.stringify(envelope, null, 2) + '\n';

function strictBase64(value, where) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0 || !BASE64.test(value)) fail(`${where} is not base64`);
  return Buffer.from(value, 'base64');
}

/**
 * Verifies an envelope (its text or the parsed object) against a keyring of
 * `{ keyId, publicKey (PEM), expiresAt? }` and returns the payload. The
 * signature is checked BEFORE the payload is parsed; any failure throws, and
 * the caller treats it as "no update known", never as an offer.
 *
 * - `now`: the verifier's clock; an expired manifest or key is refused, and an
 *   `issuedAt` more than CLOCK_SKEW_MS in the future too.
 * - `minIssuedAt`: the highest `issuedAt` already accepted (anti-rollback);
 *   an older manifest is refused, an equal one accepted.
 * - `allowExpired`: only for the build machine, which carries channels over
 *   from the last manifest it published, however old.
 */
export function verifyReleaseManifest(input, keyring, { now = new Date(), minIssuedAt = null, allowExpired = false } = {}) {
  let envelope = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > ENVELOPE_MAX) fail('envelope too large');
    try { envelope = JSON.parse(input.toString()); } catch { fail('envelope is not JSON'); }
  }
  exactKeys(envelope, ['keyId', 'payload', 'sig'], 'envelope');
  if (typeof envelope.keyId !== 'string') fail('keyId must be a string');
  const key = (keyring ?? []).find((entry) => entry.keyId === envelope.keyId);
  if (!key) fail(`unknown keyId ${JSON.stringify(envelope.keyId).slice(0, 80)}`);
  if (!allowExpired && key.expiresAt && Date.parse(key.expiresAt) <= now.getTime()) fail(`key ${key.keyId} has expired`);
  const bytes = strictBase64(envelope.payload, 'payload');
  const signature = strictBase64(envelope.sig, 'sig');
  if (signature.length !== 64 || !verify(null, signedBytes(bytes), key.publicKey, signature)) fail('invalid signature');
  let payload;
  try { payload = JSON.parse(bytes.toString('utf8')); } catch { fail('payload is not JSON'); }
  validateReleasesPayload(payload);
  const issued = Date.parse(payload.issuedAt);
  if (!allowExpired && Date.parse(payload.expiresAt) <= now.getTime()) fail(`expired on ${payload.expiresAt}`);
  if (!allowExpired && issued > now.getTime() + CLOCK_SKEW_MS) fail(`issued in the future (${payload.issuedAt})`);
  if (minIssuedAt && issued < Date.parse(minIssuedAt)) fail(`older than the last accepted manifest (${payload.issuedAt} < ${minIssuedAt})`);
  return payload;
}

const P256 = { dsaEncoding: 'der' };

/**
 * The installers' envelope: a verified release envelope plus its P-256
 * signature. DER, the encoding `openssl dgst -verify` reads (LibreSSL
 * included); install.ps1 converts it for .NET.
 */
export function addInstallSignature(envelope, { privateKey, keyId }) {
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error('invalid keyId');
  exactKeys(envelope, ['keyId', 'payload', 'sig'], 'envelope');
  const bytes = strictBase64(envelope.payload, 'payload');
  const sig = sign('sha256', signedBytes(bytes), { key: privateKey, ...P256 });
  return { keyId: envelope.keyId, payload: envelope.payload, sig: envelope.sig, p256: { keyId, sig: sig.toString('base64') } };
}

/**
 * Verifies the installers' envelope: the P-256 signature against `p256Key`
 * (`{ keyId, publicKey }`), then the release envelope inside it exactly as
 * verifyReleaseManifest does. Returns the payload; any failure throws.
 */
export function verifyInstallManifest(input, keyring, p256Key, options = {}) {
  let envelope = input;
  if (typeof input === 'string' || Buffer.isBuffer(input)) {
    if (input.length > ENVELOPE_MAX) fail('envelope too large');
    try { envelope = JSON.parse(input.toString()); } catch { fail('envelope is not JSON'); }
  }
  exactKeys(envelope, ['keyId', 'payload', 'sig', 'p256'], 'envelope');
  exactKeys(envelope.p256, ['keyId', 'sig'], 'envelope.p256');
  if (envelope.p256.keyId !== p256Key?.keyId) fail(`unknown P-256 keyId ${JSON.stringify(envelope.p256.keyId).slice(0, 80)}`);
  const bytes = strictBase64(envelope.payload, 'payload');
  const signature = strictBase64(envelope.p256.sig, 'p256.sig');
  if (!verify('sha256', signedBytes(bytes), { key: p256Key.publicKey, ...P256 }, signature)) fail('invalid P-256 signature');
  return verifyReleaseManifest({ keyId: envelope.keyId, payload: envelope.payload, sig: envelope.sig }, keyring, options);
}
