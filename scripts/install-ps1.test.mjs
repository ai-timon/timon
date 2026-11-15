/**
 * scripts/install.ps1, the one-line installer for Windows. The static cases
 * run everywhere; the ones that execute it need `pwsh` (or Windows
 * PowerShell) and are skipped without it. Nothing is installed: they stop at
 * -DryRun or -DownloadOnly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { RELEASES_SIGNATURE_DOMAIN, addInstallSignature, keyIdFor, p256KeyPair } from './release-manifest.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'install.ps1');
const TEXT = readFileSync(SCRIPT, 'utf8');

function findShell() {
  for (const name of process.platform === 'win32' ? ['pwsh', 'powershell'] : ['pwsh']) {
    const r = spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
    if (r.status === 0) return name;
  }
  return null;
}
const shell = findShell();
const needsShell = shell ? false : 'PowerShell is not installed';

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');

function p256Pair() {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return p256KeyPair(privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey.export({ type: 'spki', format: 'pem' }));
}
const spkiBase64 = (pem) => pem.replace(/-----[^-]+-----|\s/g, '');

function setup(channels, { keyId = 'release-test', expiresAt, p256, alter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-install-ps1-'));
  const now = new Date();
  const payload = {
    schema: 1,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt ?? new Date(now.getTime() + 86_400_000).toISOString(),
    channels,
  };
  let envelope = { keyId, payload: Buffer.from(JSON.stringify(payload)).toString('base64'), sig: Buffer.alloc(64).toString('base64') };
  if (p256) envelope = addInstallSignature(envelope, p256);
  if (alter) envelope = alter(envelope);
  const manifest = join(dir, 'releases.json');
  writeFileSync(manifest, JSON.stringify(envelope, null, 2));
  return { dir, manifest };
}

const channel = (version, artifact) => ({
  version, publishedAt: new Date().toISOString(), notesUrl: 'https://docs.timon-ai.com/changelog', notes: '', artifacts: { 'win-x64-nsis': artifact },
});
const httpsArtifact = (version) => ({
  name: `Timon.Setup.${version}.exe`, url: `https://github.com/acme/timon/releases/download/v${version}/Timon.Setup.${version}.exe`, size: 1000, sha256: 'a'.repeat(64),
});

function run(ctx, args, extraEnv = {}) {
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', SCRIPT, ...args], {
    env: {
      ...process.env,
      TIMON_INSTALL_TESTING: '1',
      TIMON_INSTALL_MANIFEST_URL: pathToFileURL(ctx.manifest).href,
      TIMON_INSTALL_KEY_ID: 'release-test',
      TMPDIR: ctx.dir,
      ...extraEnv,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

test('install.ps1 pins the manifest and the key the daemon trusts', () => {
  assert.match(TEXT, /\$manifestUrl = 'https:\/\/timon-ai\.com\/\.well-known\/timon-releases\.json'/);
  const keyring = readFileSync(join(dirname(SCRIPT), '..', 'orchestrator', 'src', 'plugins-bundled', 'updates', 'keyring.ts'), 'utf8');
  const keyId = /keyId: '([^']+)'/.exec(keyring)[1];
  assert.ok(TEXT.includes(`$releaseKeyId = '${keyId}'`), 'install.ps1 pins the keyId of keyring.ts');
  assert.match(TEXT, /\$testing = \$env:TIMON_INSTALL_TESTING -eq '1'/);
  assert.match(TEXT, /\$installManifestUrl = 'https:\/\/timon-ai\.com\/\.well-known\/timon-releases-install\.json'/);
  const p256 = /\$releaseP256PublicKey = '([^']*)'/.exec(TEXT)[1];
  const p256Id = /\$releaseP256KeyId = '([^']*)'/.exec(TEXT)[1];
  if (p256) assert.equal(keyIdFor(`-----BEGIN PUBLIC KEY-----\n${p256}\n-----END PUBLIC KEY-----\n`), p256Id, 'the pinned P-256 keyId derives from the pinned key');
  assert.match(TEXT, new RegExp(`\\$signatureDomain = '${RELEASES_SIGNATURE_DOMAIN.slice(0, -1)}'`));
});

test('install.ps1 ends by calling its function: a truncated download runs nothing', () => {
  assert.match(TEXT.trimEnd().split('\n').pop(), /^Install-Timon /);
});

test('install.ps1 keeps to the syntax of Windows PowerShell 5.1', () => {
  const code = TEXT.split('\n').filter((line) => !line.trimStart().startsWith('#')).join('\n');
  for (const [token, why] of [
    [/\?\?/, 'null-coalescing operator (PowerShell 7)'],
    [/\?\./, 'null-conditional member access (PowerShell 7)'],
    [/\s(&&|\|\|)\s/, 'pipeline chain operator (PowerShell 7)'],
    [/-AsHashtable/, 'ConvertFrom-Json -AsHashtable (PowerShell 6)'],
  ]) {
    assert.doesNotMatch(code, token, why);
  }
});

test('dry run picks the stable installer, else beta', { skip: needsShell }, () => {
  const ctx = setup({ stable: channel('0.2.0', httpsArtifact('0.2.0')), beta: channel('0.2.1-rc.1', httpsArtifact('0.2.1-rc.1')) });
  try {
    const r = run(ctx, ['-DryRun']);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Timon 0\.2\.0 \(stable channel\) for Windows/);
    assert.match(r.out, /package: +Timon\.Setup\.0\.2\.0\.exe/);
    assert.match(r.out, /Dry run: nothing was downloaded or installed\./);
    assert.match(run(ctx, ['-DryRun', '-Channel', 'beta']).out, /Timon 0\.2\.1-rc\.1 \(beta channel\)/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
  const rc = setup({ beta: channel('0.3.0-rc.1', httpsArtifact('0.3.0-rc.1')) });
  try {
    assert.match(run(rc, ['-DryRun']).out, /Timon 0\.3\.0-rc\.1 \(beta channel\)/);
  } finally {
    rmSync(rc.dir, { recursive: true, force: true });
  }
});

test('an unknown key or an expired manifest is refused', { skip: needsShell }, () => {
  const unknown = setup({ stable: channel('0.2.0', httpsArtifact('0.2.0')) }, { keyId: 'release-other' });
  try {
    const r = run(unknown, ['-DryRun']);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /unknown key/);
  } finally {
    rmSync(unknown.dir, { recursive: true, force: true });
  }
  const expired = setup({ stable: channel('0.2.0', httpsArtifact('0.2.0')) }, { expiresAt: '2020-01-01T00:00:00.000Z' });
  try {
    const r = run(expired, ['-DryRun']);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /has expired/);
  } finally {
    rmSync(expired.dir, { recursive: true, force: true });
  }
});

test('the P-256 signature is checked, and an altered or unknown one refused', { skip: needsShell }, () => {
  const p256 = p256Pair();
  const other = p256Pair();
  const env = { TIMON_INSTALL_P256_KEY: spkiBase64(p256.publicKey), TIMON_INSTALL_P256_KEY_ID: p256.keyId };
  const flip = (envelope) => {
    const sig = Buffer.from(envelope.p256.sig, 'base64');
    sig[sig.length - 1] ^= 1;
    return { ...envelope, p256: { ...envelope.p256, sig: sig.toString('base64') } };
  };
  const stable = { stable: channel('0.2.0', httpsArtifact('0.2.0')) };
  const cases = [
    ['genuine', { p256 }, /signature: verified/],
    ['altered P-256 signature', { p256, alter: flip }, /signature is INVALID/],
    ['altered payload', { p256, alter: (e) => ({ ...e, payload: Buffer.from(Buffer.from(e.payload, 'base64').toString().replace('0.2.0', '0.2.1')).toString('base64') }) }, /signature is INVALID/],
    ['signed by another P-256 key', { p256: { ...other, keyId: p256.keyId } }, /signature is INVALID/],
    ['unknown P-256 key', { p256: other }, /unknown P-256 key/],
    ['no P-256 signature', {}, /signature: checked by Timon once installed/],
  ];
  for (const [label, options, expected] of cases) {
    const ctx = setup(stable, options);
    try {
      const r = run(ctx, ['-DryRun'], env);
      assert.match(r.out + r.err, expected, label);
      if (/INVALID|unknown/.test(String(expected))) {
        assert.notEqual(r.code, 0, label);
        assert.doesNotMatch(r.out, /package:/, label);
      } else {
        assert.equal(r.code, 0, `${label}: ${r.err}`);
      }
    } finally {
      rmSync(ctx.dir, { recursive: true, force: true });
    }
  }
});

test('until the installers\' manifest is served, the release manifest is read', { skip: needsShell }, () => {
  const ctx = setup({ stable: channel('0.2.0', httpsArtifact('0.2.0')) });
  try {
    const r = run(ctx, ['-DryRun'], {
      TIMON_INSTALL_MANIFEST_URL: pathToFileURL(join(ctx.dir, 'missing.json')).href,
      TIMON_INSTALL_FALLBACK_MANIFEST_URL: pathToFileURL(ctx.manifest).href,
    });
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Timon 0\.2\.0 \(stable channel\) for Windows/);
  } finally {
    rmSync(ctx.dir, { recursive: true, force: true });
  }
});

test('-DownloadOnly keeps a matching installer and refuses one that does not match', { skip: needsShell }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-install-ps1-pkg-'));
  try {
    const bytes = Buffer.from('a genuine installer');
    const file = join(dir, 'Timon.Setup.0.2.0.exe');
    writeFileSync(file, bytes);
    const artifact = { name: 'Timon.Setup.0.2.0.exe', url: pathToFileURL(file).href, size: bytes.length, sha256: sha(bytes) };

    const ok = setup({ stable: channel('0.2.0', artifact) });
    try {
      const r = run(ok, ['-DownloadOnly']);
      assert.equal(r.code, 0, r.err);
      assert.match(r.out, /Package verified\./);
      const kept = r.out.trim().split(/\r?\n/).pop();
      assert.ok(existsSync(kept), `the verified installer stays at ${kept}`);
      rmSync(dirname(kept), { recursive: true, force: true });
    } finally {
      rmSync(ok.dir, { recursive: true, force: true });
    }

    const bad = setup({ stable: channel('0.2.0', { ...artifact, sha256: 'b'.repeat(64) }) });
    try {
      const r = run(bad, ['-DownloadOnly']);
      assert.notEqual(r.code, 0);
      assert.match(r.err + r.out, /does not match the manifest/);
      assert.doesNotMatch(r.out, /Package verified/);
    } finally {
      rmSync(bad.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
