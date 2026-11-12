/**
 * scripts/install.sh, the one-line installer, run for real with `sh` against
 * a manifest signed by a throwaway key and packages served from file:// URLs.
 * Nothing is installed: the cases stop at --dry-run or --download-only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  RELEASES_SIGNATURE_DOMAIN, composeReleasesPayload, releaseKeyPair, serializeEnvelope, signReleasesPayload,
} from './release-manifest.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'install.sh');
const skip = process.platform === 'win32' ? 'install.sh is a POSIX shell script' : false;

const openssl = spawnSync('openssl', ['version'], { encoding: 'utf8' });
const canVerify = openssl.status === 0 && /^OpenSSL ([3-9]|[1-9]\d)\./.test(openssl.stdout);

function pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return releaseKeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function entry(version, artifacts, notes = `Notes of ${version}`) {
  return { version, publishedAt: new Date().toISOString(), notesUrl: 'https://docs.timon-ai.com/changelog', notes, artifacts };
}

function httpsArtifact(name) {
  return { name, url: `https://github.com/acme/timon/releases/download/v1/${name}`, size: 1000, sha256: 'a'.repeat(64) };
}

/** Signs any payload, even one the generator would refuse (file:// URLs). */
function envelopeOf(payload, key) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  const signed = Buffer.concat([Buffer.from(RELEASES_SIGNATURE_DOMAIN, 'utf8'), bytes]);
  return { keyId: key.keyId, payload: bytes.toString('base64'), sig: sign(null, signed, key.privateKey).toString('base64') };
}

function setup(envelope, key) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-install-sh-'));
  const manifest = join(dir, 'releases.json');
  writeFileSync(manifest, typeof envelope === 'string' ? envelope : serializeEnvelope(envelope));
  const keyFile = join(dir, 'key.pem');
  writeFileSync(keyFile, key.publicKey);
  return { dir, manifest, keyFile };
}

function run(ctx, key, args, extraEnv = {}) {
  const env = {
    PATH: process.env.PATH,
    HOME: ctx.dir,
    TMPDIR: ctx.dir,
    TIMON_INSTALL_TESTING: '1',
    TIMON_INSTALL_MANIFEST_URL: pathToFileURL(ctx.manifest).href,
    TIMON_INSTALL_PUBLIC_KEY_FILE: ctx.keyFile,
    TIMON_INSTALL_KEY_ID: key.keyId,
    TIMON_INSTALL_UNAME_S: 'Linux',
    TIMON_INSTALL_UNAME_M: 'x86_64',
    ...extraEnv,
  };
  const r = spawnSync('sh', [SCRIPT, ...args], { env, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const linuxArtifacts = (version) => ({
  'linux-x64-deb': httpsArtifact(`timon-desktop_${version}_amd64.deb`),
  'linux-x64-appimage': httpsArtifact(`Timon-${version}.AppImage`),
  'mac-universal-pkg': httpsArtifact(`Timon-${version}.pkg`),
});

test('dry run reads a manifest written by the release generator', { skip }, () => {
  const key = pair();
  // A note that quotes the manifest structure must not be read as structure.
  const notes = 'Fixed "linux-x64-deb":{"name":"evil.deb","url":"https://evil.example/x"} and "stable":{';
  const { payload } = composeReleasesPayload({ entry: entry('0.2.0', linuxArtifacts('0.2.0'), notes) });
  const ctx = setup(signReleasesPayload(payload, key), key);
  try {
    const r = run(ctx, key, ['--dry-run', '--format', 'deb']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Timon 0\.2\.0 \(stable channel\) for linux-x64/);
    assert.match(r.out, /package: +timon-desktop_0\.2\.0_amd64\.deb/);
    assert.match(r.out, /from: +https:\/\/github\.com\/acme\/timon\/releases\/download\/v1\/timon-desktop_0\.2\.0_amd64\.deb/);
    assert.match(r.out, new RegExp(`signature: +${canVerify ? 'verified' : 'unchecked'}`));
    assert.match(r.out, /Dry run: nothing was downloaded or installed\./);
    assert.doesNotMatch(r.out, /evil/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('the default channel is stable, and beta when only an rc is published', { skip }, () => {
  const key = pair();
  const first = composeReleasesPayload({ entry: entry('0.2.0', linuxArtifacts('0.2.0')) }).payload;
  const both = composeReleasesPayload({ previous: first, entry: entry('0.2.1-rc.1', linuxArtifacts('0.2.1-rc.1')) }).payload;
  const ctx = setup(signReleasesPayload(both, key), key);
  try {
    assert.match(run(ctx, key, ['--dry-run', '--format', 'appimage']).out, /Timon 0\.2\.0 \(stable channel\)/);
    assert.match(run(ctx, key, ['--dry-run', '--format', 'appimage', '--channel', 'beta']).out, /Timon 0\.2\.1-rc\.1 \(beta channel\)/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }

  const onlyRc = composeReleasesPayload({ entry: entry('0.3.0-rc.2', linuxArtifacts('0.3.0-rc.2')) }).payload;
  const rc = setup(signReleasesPayload(onlyRc, key), key);
  try {
    assert.match(run(rc, key, ['--dry-run', '--format', 'deb']).out, /Timon 0\.3\.0-rc\.2 \(beta channel\)/);
    const stable = run(rc, key, ['--dry-run', '--format', 'deb', '--channel', 'stable']);
    assert.equal(stable.code, 1);
    assert.match(stable.err, /no Timon release is published on the stable channel/);
  } finally {
    rmSync(rc.dir, { recursive: true, force: true });
  }
});

test('the package follows the system', { skip }, () => {
  const key = pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.2.0', linuxArtifacts('0.2.0')) });
  const ctx = setup(signReleasesPayload(payload, key), key);
  try {
    const mac = run(ctx, key, ['--dry-run'], { TIMON_INSTALL_UNAME_S: 'Darwin', TIMON_INSTALL_UNAME_M: 'arm64' });
    assert.equal(mac.code, 0, mac.err);
    assert.match(mac.out, /package: +Timon-0\.2\.0\.pkg/, 'a Mac without its own build takes the universal one');

    const arm = run(ctx, key, ['--dry-run', '--format', 'deb'], { TIMON_INSTALL_UNAME_M: 'aarch64' });
    assert.equal(arm.code, 1);
    assert.match(arm.err, /no Timon package for linux-arm64 \(deb\)/);

    const win = run(ctx, key, ['--dry-run'], { TIMON_INSTALL_UNAME_S: 'MINGW64_NT-10.0' });
    assert.equal(win.code, 1);
    assert.match(win.err, /install\.ps1/);

    const server = run(ctx, key, ['--dry-run', '--format', 'deb', '--server']);
    assert.match(server.out, /then: +timon service install/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('a manifest signed by another key, or altered, is refused', { skip: skip || (!canVerify && 'needs OpenSSL 3') }, () => {
  const key = pair();
  const other = pair();
  const { payload } = composeReleasesPayload({ entry: entry('0.2.0', linuxArtifacts('0.2.0')) });

  const forged = { ...signReleasesPayload(payload, other), keyId: key.keyId };
  const ctx = setup(forged, key);
  try {
    const r = run(ctx, key, ['--dry-run', '--format', 'deb']);
    assert.equal(r.code, 1);
    assert.match(r.err, /signature is INVALID/);
    assert.doesNotMatch(r.out, /package:/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }

  const unknown = setup(signReleasesPayload(payload, other), key);
  try {
    const r = run(unknown, key, ['--dry-run', '--format', 'deb']);
    assert.equal(r.code, 1);
    assert.match(r.err, /unknown key/);
  } finally {
    rmSync(unknown.dir, { recursive: true, force: true });
  }
});

test('an expired manifest is refused', { skip }, () => {
  const key = pair();
  const past = new Date(Date.now() - 10 * 86_400_000);
  const { payload } = composeReleasesPayload({ entry: entry('0.2.0', linuxArtifacts('0.2.0')), now: past, validDays: 2 });
  const ctx = setup(signReleasesPayload(payload, key), key);
  try {
    const r = run(ctx, key, ['--dry-run', '--format', 'deb']);
    assert.equal(r.code, 1);
    assert.match(r.err, /has expired/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('--download-only keeps a package that matches the manifest and refuses one that does not', { skip }, () => {
  const key = pair();
  const dir = mkdtempSync(join(tmpdir(), 'timon-install-pkg-'));
  try {
    const good = Buffer.from('a genuine package');
    const goodFile = join(dir, 'Timon-0.2.0.AppImage');
    writeFileSync(goodFile, good);
    const now = new Date();
    const payloadFor = (artifact) => ({
      schema: 1,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      channels: { stable: entry('0.2.0', { 'linux-x64-appimage': artifact }) },
    });
    const artifact = { name: 'Timon-0.2.0.AppImage', url: pathToFileURL(goodFile).href, size: good.length, sha256: sha(good) };

    const ok = setup(envelopeOf(payloadFor(artifact), key), key);
    try {
      const r = run(ok, key, ['--download-only', '--format', 'appimage']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Package verified\./);
      const kept = r.out.trim().split('\n').pop();
      assert.ok(existsSync(kept), `the verified package stays at ${kept}`);
      assert.deepEqual(readFileSync(kept), good);
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }

    const bad = setup(envelopeOf(payloadFor({ ...artifact, sha256: 'b'.repeat(64) }), key), key);
    try {
      const r = run(bad, key, ['--download-only', '--format', 'appimage']);
      assert.equal(r.code, 1);
      assert.match(r.err, /does not match the manifest/);
      assert.doesNotMatch(r.out, /Package verified/);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }

    const traversal = setup(envelopeOf(payloadFor({ ...artifact, name: '..evil' }), key), key);
    try {
      const r = run(traversal, key, ['--dry-run', '--format', 'appimage']);
      assert.equal(r.code, 1);
      assert.match(r.err, /invalid file/);
    } finally {
      rmSync(traversal.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('outside the test hooks, only the pinned manifest and key are read', { skip }, () => {
  const text = readFileSync(SCRIPT, 'utf8');
  // The key the daemon pins (updates/keyring.ts) is the one the script embeds.
  const keyring = readFileSync(join(dirname(SCRIPT), '..', 'orchestrator', 'src', 'plugins-bundled', 'updates', 'keyring.ts'), 'utf8');
  const keyId = /keyId: '([^']+)'/.exec(keyring)[1];
  const x = /pemFromJwkX\('([^']+)'\)/.exec(keyring)[1];
  const pem = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString().trim();
  assert.ok(text.includes(`RELEASE_KEY_ID='${keyId}'`), 'install.sh pins the keyId of keyring.ts');
  assert.ok(text.includes(`RELEASE_PUBLIC_KEY='${pem}'`), 'install.sh pins the public key of keyring.ts');
  assert.match(text, /MANIFEST_URL='https:\/\/timon-ai\.com\/\.well-known\/timon-releases\.json'/);
  assert.match(text, /if \[ "\$\{TIMON_INSTALL_TESTING:-\}" = 1 \]; then/);
  // The script must end by calling main: a truncated download then runs nothing.
  assert.equal(text.trimEnd().split('\n').pop(), 'main "$@"');
  const r = spawnSync('sh', [SCRIPT, '--bogus'], { env: { PATH: process.env.PATH, HOME: tmpdir() }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option: --bogus/);
});
