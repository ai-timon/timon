/**
 * Admission of unsigned third-party code.
 *
 * Two gates in series. Rights in force first (a valid paid licence or the
 * local Free tier) and no fixed composition, with no way for the config to buy
 * past either; then the owner's own switch: an unset setting resolves against
 * the registry rather than against a constant — open while it is empty, closed
 * since the first production key.
 */
import '../test-home.js';
import { paidTestLicense } from '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { unsignedPluginsAllowed, PLUGIN_PUBLIC_KEYS } = await import('./pubkey.js');
const { verifyPluginDirectory } = await import('./signature.js');
const { licenseState, setLicenseState } = await import('../license/runtime.js');
const { unlicensed } = await import('../license/license.js');
const { betaLocked } = await import('../license/build-policy.js');

const A_KEY = [{ keyId: 'timon-plugins-2026-11', publicKey: 'irrelevant-here' }] as const;

const PAID = { state: paidTestLicense() };
const FREE = { state: unlicensed('missing') };
const FIXED = { state: { ...paidTestLicense(), capabilities: { version: 1 as const, plugins: 'fixed' as const, accounts: 'standard' as const }, expiresAt: new Date(Date.now() + 86_400_000).toISOString() } };
const LOCKED = { state: betaLocked('missing') };

test('unset resolves open while the key registry is empty', () => {
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [], ...PAID }), true);
});

test('unset resolves closed as soon as a production key exists', () => {
  assert.equal(unsignedPluginsAllowed(undefined, { keys: A_KEY, ...PAID }), false);
});

test('an explicit setting wins over the registry, both ways', () => {
  assert.equal(unsignedPluginsAllowed(false, { keys: [], ...PAID }), false);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...PAID }), true);
});

/**
 * Free is `unlicensed` + `localFree`, never `valid`. Until 10/11/2026 the gate
 * tested `status === 'valid'`, so no Free user could load a plugin they wrote
 * themselves. The maintainer's decision: Free admits unsigned code exactly like
 * a paid licence, once the owner switches developer mode on explicitly.
 */
test('Free admits unsigned code only once the owner sets developer.unsignedPlugins to true', () => {
  assert.equal(FREE.state.status, 'unlicensed');
  assert.equal(FREE.state.localFree, true);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...FREE }), true);
  assert.equal(unsignedPluginsAllowed(undefined, { keys: A_KEY, ...FREE }), false);
  assert.equal(unsignedPluginsAllowed(false, { keys: A_KEY, ...FREE }), false);
});

test('a valid paid licence admits unsigned code with an explicit true', () => {
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...PAID }), true);
});

/**
 * The lock the 10/11/2026 amendment keeps: a fixed composition (a paid offer
 * may carry one, the locked beta state always does) refuses even an explicit
 * `true`, and so does a state with no rights in force.
 */
test('a fixed composition and the locked beta state refuse even an explicit true', () => {
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...FIXED }), false);
  assert.equal(unsignedPluginsAllowed(true, { keys: [], ...FIXED }), false);
  assert.equal(LOCKED.state.localFree, false);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY, ...LOCKED }), false);
  assert.equal(unsignedPluginsAllowed(true, { keys: [], ...LOCKED }), false);
});

test('the process licence state decides when none is injected', () => {
  // `setLicenseState` turns any non-valid state into the local Free tier.
  setLicenseState({ ...licenseState(), status: 'unlicensed' });
  assert.equal(licenseState().localFree, true);
  assert.equal(unsignedPluginsAllowed(true, { keys: A_KEY }), true);
  assert.equal(unsignedPluginsAllowed(undefined, { keys: A_KEY }), false);
  setLicenseState(paidTestLicense());
  assert.equal(unsignedPluginsAllowed(undefined, { keys: [] }), true);
  setLicenseState(FIXED.state);
  assert.equal(unsignedPluginsAllowed(true, { keys: [] }), false);
  setLicenseState(paidTestLicense());
});

const PRODUCTION_KEY_ID = 'timon-plugins-2026-11';
const PRODUCTION_KEY_X = 'PgAMt3tfQQkCaqDvx4oLdQ5ulPnepeg1XJR4C_NZ-UQ';

test('the shipped registry pins the first production key, a valid Ed25519 public key', () => {
  const key = PLUGIN_PUBLIC_KEYS.find((candidate) => candidate.keyId === PRODUCTION_KEY_ID);
  assert.ok(key, `${PRODUCTION_KEY_ID} is in PLUGIN_PUBLIC_KEYS`);
  // No expiry: rotation adds an entry and dates the old one instead.
  assert.equal(key.expiresAt, undefined);
  const parsed = createPublicKey(key.publicKey);
  assert.equal(parsed.type, 'public');
  assert.equal(parsed.asymmetricKeyType, 'ed25519');
  assert.equal(parsed.export({ format: 'jwk' }).x, PRODUCTION_KEY_X);
  // Every pinned key id is unique, or a signature would match the wrong key.
  assert.equal(new Set(PLUGIN_PUBLIC_KEYS.map((k) => k.keyId)).size, PLUGIN_PUBLIC_KEYS.length);
});

test('with the production key shipped, an unset setting resolves closed on a licensed install', () => {
  setLicenseState(paidTestLicense());
  assert.equal(unsignedPluginsAllowed(undefined, PAID), false);
  assert.equal(unsignedPluginsAllowed(undefined), false);
  // The escape hatch for a developer install: an explicit `true`.
  assert.equal(unsignedPluginsAllowed(true), true);
});

const SIGN_SCRIPT = fileURLToPath(new URL('../../scripts/sign-plugin.mjs', import.meta.url));

/**
 * The script runs under a throwaway home so it reads a test key, never the
 * real one: `os.homedir()` follows HOME on POSIX and USERPROFILE on Windows.
 */
function signWithScript(pluginDir: string, privatePem: string, env: Record<string, string> = {}): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-sign-home-'));
  try {
    mkdirSync(join(home, '.timon-signing'));
    writeFileSync(join(home, '.timon-signing', 'plugins.key'), privatePem, { mode: 0o600 });
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, ...env };
    if (!('TIMON_PLUGIN_SIGNING_KEY_ID' in env)) delete childEnv.TIMON_PLUGIN_SIGNING_KEY_ID;
    const run = spawnSync(process.execPath, [SIGN_SCRIPT, pluginDir], { env: childEnv, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return readFileSync(join(pluginDir, 'SIGNATURE'), 'utf8');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('sign-plugin.mjs signs under the production key id by default, and the daemon verifies it', () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const dir = mkdtempSync(join(tmpdir(), 'timon-signed-plugin-'));
  try {
    mkdirSync(join(dir, 'lib'));
    writeFileSync(join(dir, 'package.json'), '{"name":"signed-fixture","version":"1.0.0"}\n');
    writeFileSync(join(dir, 'lib', 'index.js'), 'export const apply = () => {};\n');

    const signature = JSON.parse(signWithScript(dir, privatePem)) as { keyId: string };
    assert.equal(signature.keyId, PRODUCTION_KEY_ID);

    const keys = [{ keyId: PRODUCTION_KEY_ID, publicKey: publicPem }];
    const verdict = verifyPluginDirectory(dir, keys);
    assert.equal(verdict.ok, true, verdict.ok ? '' : verdict.message);

    // The real production key did not sign this: the shipped registry refuses it.
    const shipped = verifyPluginDirectory(dir);
    assert.equal(shipped.ok, false);
    assert.equal(shipped.ok ? '' : shipped.code, 'tampered');

    writeFileSync(join(dir, 'lib', 'index.js'), 'export const apply = () => { /* changed */ };\n');
    const altered = verifyPluginDirectory(dir, keys);
    assert.equal(altered.ok ? '' : altered.code, 'tampered');

    // An expired key no longer admits what it signed.
    signWithScript(dir, privatePem);
    const expired = verifyPluginDirectory(dir, [{ ...keys[0]!, expiresAt: '2026-01-01T00:00:00.000Z' }]);
    assert.equal(expired.ok ? '' : expired.code, 'unsigned');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
