/**
 * scripts/install.ps1, the one-line installer for Windows. The static cases
 * run everywhere; the ones that execute it need `pwsh` (or Windows
 * PowerShell) and are skipped without it. Nothing is installed: they stop at
 * -DryRun or -DownloadOnly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

function setup(channels, { keyId = 'release-test', expiresAt } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'timon-install-ps1-'));
  const now = new Date();
  const payload = {
    schema: 1,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt ?? new Date(now.getTime() + 86_400_000).toISOString(),
    channels,
  };
  const envelope = { keyId, payload: Buffer.from(JSON.stringify(payload)).toString('base64'), sig: Buffer.alloc(64).toString('base64') };
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

function run(ctx, args) {
  const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', SCRIPT, ...args], {
    env: {
      ...process.env,
      TIMON_INSTALL_TESTING: '1',
      TIMON_INSTALL_MANIFEST_URL: pathToFileURL(ctx.manifest).href,
      TIMON_INSTALL_KEY_ID: 'release-test',
      TMPDIR: ctx.dir,
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
