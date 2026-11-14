import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { copyBuiltinPlugins, sealTree, releaseKeys, stageBuildInfo, stageFence } from './prepare-daemon-release.mjs';
import { createBuildInfo, writeBuildInfo } from './build-info.mjs';
import { RELEASE_MANIFEST_VERSION, verifyRelease } from './release-integrity.mjs';
import { THIRD_PARTY_NOTICES, assertPackagedFence, assertPackagedPublicKey, assertPackagedReleaseCheck, assertPackagedSpeechEngine, assertPackagedThirdPartyNotices, beforePack, runtimeFuses } from './release-hooks.mjs';
import { sherpaPackageName } from '../src/speech-paths.ts';
import { checkMacSignature, describeSignature, parseSignatureDetails } from './mac-signature.mjs';
import { FuseV1Options } from '@electron/fuses';
import { Arch } from 'builder-util';
const pair = generateKeyPairSync('ed25519');
const keys = { privateKey: pair.privateKey, publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timon-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['dist/license', 'bin', 'scripts', 'presets']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/license/pubkey.js'), `const LICENSE_PUBLIC_KEYS = ['pinned']; let override = null;
export function activeKeyring() { return override ?? LICENSE_PUBLIC_KEYS; }
export function overrideKeyringForTests(keys) { override = keys; }`);
  writeFileSync(join(root, 'dist/boot.js'), `import { activeKeyring } from './license/pubkey.js';
const dynamic = await import('./feature.js');
console.log(JSON.stringify({keys: activeKeyring(), result: dynamic.greet('Timon')}));`);
  writeFileSync(join(root, 'dist/feature.js'), '// source comment\nexport function greet(name) { return `Hello ${name}`; }');
  sealTree(root, keys);
  return root;
}
function fixtureUnsealed(t) {
  const root = mkdtempSync(join(tmpdir(), 'timon-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['dist/license', 'bin', 'scripts', 'presets']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/license/pubkey.js'), `const LICENSE_PUBLIC_KEYS = ['pinned']; let override = null;
export function activeKeyring() { return override ?? LICENSE_PUBLIC_KEYS; }
export function overrideKeyringForTests(keys) { override = keys; }`);
  writeFileSync(join(root, 'dist/boot.js'), "console.log('boot');");
  return root;
}
function boot(root) {
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  return spawnSync(process.execPath, [join(root, 'dist/boot.js')], { encoding: 'utf8', timeout: 15000, env });
}
test('the sealed ESM keeps its imports and exports, and ships the daemon readable', async (t) => {
  const root = fixture(t);
  assert.equal(verifyRelease(root, keys.publicKey).version, RELEASE_MANIFEST_VERSION);
  const result = boot(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { keys: ['pinned'], result: 'Hello Timon' });
  // The daemon is public under AGPL: the release signs it, it never rewrites it.
  assert.equal(readFileSync(join(root, 'dist/feature.js'), 'utf8'), '// source comment\nexport function greet(name) { return `Hello ${name}`; }');
  const keyring = await import(pathToFileURL(join(root, 'dist/license/pubkey.js')).href);
  assert.throws(() => keyring.overrideKeyringForTests([]), /unavailable/);
  assert.deepEqual(keyring.activeKeyring(), ['pinned']);
});
for (const action of ['edit', 'delete', 'add', 'manifest', 'signature', 'remove-signature']) {
  test(`the artefact refuses ${action} before running application code`, (t) => {
    const root = fixture(t);
    if (action === 'edit') writeFileSync(join(root, 'dist/feature.js'), "export const greet = () => 'cracked';");
    if (action === 'delete') rmSync(join(root, 'dist/feature.js'));
    if (action === 'add') writeFileSync(join(root, 'dist/injected.js'), '');
    if (action === 'manifest') writeFileSync(join(root, 'release-manifest.json'), '{}');
    if (action === 'signature') writeFileSync(join(root, 'release-manifest.sig'), 'fake');
    if (action === 'remove-signature') rmSync(join(root, 'release-manifest.sig'));
    assert.throws(() => verifyRelease(root, keys.publicKey));
    const result = boot(root);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
  });
}
test('symlinks cannot substitute signed code', { skip: process.platform === 'win32' }, (t) => {
  const root = fixture(t);
  rmSync(join(root, 'dist/feature.js'));
  symlinkSync(join(root, 'dist/license/pubkey.js'), join(root, 'dist/feature.js'));
  assert.throws(() => verifyRelease(root, keys.publicKey), /symbolic link/);
});
test('distribution requires explicit matching signing keys', (t) => {
  assert.throws(() => releaseKeys({}), /Distribution requires/);
  const dir = mkdtempSync(join(tmpdir(), 'timon-release-keys-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const privateFile = join(dir, 'private.pem');
  const publicFile = join(dir, 'public.pem');
  writeFileSync(privateFile, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  writeFileSync(publicFile, keys.publicKey);
  const env = { TIMON_RELEASE_PRIVATE_KEY_FILE: privateFile, TIMON_RELEASE_PUBLIC_KEY_FILE: publicFile };
  assert.equal(releaseKeys(env).publicKey, keys.publicKey);
  writeFileSync(publicFile, generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => releaseKeys(env), /matching/);
});
test('native build guard runs before preparation', async () => {
  await assert.rejects(beforePack({ electronPlatformName: process.platform === 'win32' ? 'linux' : 'win32' }), /target OS/);
});
test('all OS policies turn Node mode off and disable injection', () => {
  for (const os of ['linux', 'win32', 'darwin']) {
    const fuses = runtimeFuses(os);
    assert.equal(fuses[FuseV1Options.RunAsNode], false);
    assert.equal(fuses[FuseV1Options.EnableNodeOptionsEnvironmentVariable], false);
    assert.equal(fuses[FuseV1Options.EnableNodeCliInspectArguments], false);
    assert.equal(fuses[FuseV1Options.EnableEmbeddedAsarIntegrityValidation], os !== 'linux');
  }
});

test('codesign details name the kind of macOS signature', () => {
  assert.deepEqual(parseSignatureDetails('Executable=/x/Timon.app/Contents/MacOS/Timon\nCodeDirectory v=20400 size=618 flags=0x2(adhoc) hashes=13+3 location=embedded\nSignature=adhoc\n'), { kind: 'adhoc', authority: null });
  const developerId = 'Signature size=9000\nAuthority=Developer ID Application: Acme (ABCDE12345)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\n';
  assert.deepEqual(parseSignatureDetails(developerId), { kind: 'developer-id', authority: 'Developer ID Application: Acme (ABCDE12345)' });
  assert.equal(parseSignatureDetails('Authority=Apple Development: someone (XYZ)\n').kind, 'other');
  assert.equal(parseSignatureDetails('code object is not signed at all\n').kind, 'unsigned');
  assert.match(describeSignature({ kind: 'adhoc', authority: null }), /Gatekeeper/);
});

test('a bundle whose code changed after signing is refused', { skip: process.platform !== 'darwin' && 'codesign is macOS-only' }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'timon-codesign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, 'Probe.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Probe</string><key>CFBundleIdentifier</key><string>com.timon.probe</string></dict></plist>\n');
  const binary = join(app, 'Contents', 'MacOS', 'Probe');
  copyFileSync('/usr/bin/true', binary);
  const sign = spawnSync('codesign', ['--sign', '-', '--force', app], { encoding: 'utf8' });
  assert.equal(sign.status, 0, sign.stderr);
  assert.equal(checkMacSignature(app).kind, 'adhoc');
  // What flipFuses does to Electron Framework: rewrite bytes of signed code.
  appendFileSync(binary, Buffer.from([0]));
  assert.throws(() => checkMacSignature(app), /broken code signature/);
});

test('macOS re-signs ad-hoc after the fuses, other OSes leave the binary alone', () => {
  assert.equal(runtimeFuses('darwin').resetAdHocDarwinSignature, true);
  assert.equal(runtimeFuses('linux').resetAdHocDarwinSignature, false);
  assert.equal(runtimeFuses('win32').resetAdHocDarwinSignature, false);
});


test('Electron Builder configuration parses and selects only the sealed daemon release', () => {
  // Use the YAML parser installed with the locked packaging toolchain.
  const { load } = createRequire(import.meta.url)('js-yaml');
  const config = load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  assert.equal(config.beforePack, './scripts/release-hooks.mjs');
  assert.equal(config.afterPack, './scripts/release-hooks.mjs');
  assert.equal(config.asar, true);
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/dist').from, 'build-resources/daemon-release/dist');
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/public-docs').from, 'build-resources/daemon-release/public-docs');
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/builtin-plugins').from, 'build-resources/daemon-release/builtin-plugins');
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/builtin-plugins.json').from, 'build-resources/daemon-release/builtin-plugins.json');
  // The channel/expiry file rides the same signed staging into the package.
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/build-info.json')?.from, 'build-resources/daemon-release/build-info.json');
  // The mission launcher rides the signed staging too, in Linux packages only.
  assert.equal(config.extraResources.find(r => r.to === 'orchestrator/native'), undefined);
  assert.equal(config.linux.extraResources.find(r => r.to === 'orchestrator/native')?.from, 'build-resources/daemon-release/native');
  // The shell reads the key from inside `app.asar`. electron-builder resolves
  // a fileset `from` as a base DIRECTORY: the earlier
  // `from: build-resources/release-public-key.pem` named a FILE, so the entry
  // was dropped silently and the packaged client died on ENOENT at startup.
  const embedded = config.files.find(f => typeof f === 'object' && (f.filter ?? []).includes('release-public-key.pem'));
  assert.ok(embedded, 'no fileset entry embeds release-public-key.pem');
  // `build-resources/` is generated by `beforePack` and gitignored, so this
  // discriminating check only runs where it exists; the proof that holds
  // everywhere is the `assertPackagedPublicKey` guard of afterPack.
  const from = new URL(`../${embedded.from}`, import.meta.url);
  if (existsSync(from)) assert.ok(statSync(from).isDirectory(),
    `the fileset \`from\` must be a directory, ${embedded.from} is not`);
  assert.equal(embedded.to, '.');
  // Load-bearing beyond the key: `build-resources` also holds the daemon
  // release and its node_modules, which an unfiltered entry would pour into the
  // archive.
  assert.deepEqual(embedded.filter, ['release-public-key.pem']);
});

test('packaging fails when the release key is missing from the archive', async (t) => {
  const { createPackageWithOptions } = createRequire(import.meta.url)('@electron/asar');
  const root = mkdtempSync(join(tmpdir(), 'timon-asar-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // `@electron/asar` caches archive headers by path, so each case gets its own
  // `resources` directory rather than overwriting one archive three times.
  const build = async (files) => {
    const src = mkdtempSync(join(tmpdir(), 'timon-asar-src-'));
    const resources = mkdtempSync(join(root, 'resources-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(src, name), body);
    await createPackageWithOptions(src, join(resources, 'app.asar'), {});
    rmSync(src, { recursive: true, force: true });
    return resources;
  };

  const without = await build({ 'package.json': '{}' });
  assert.throws(() => assertPackagedPublicKey(without, keys.publicKey), /No release-public-key\.pem/);

  const wrong = await build({ 'package.json': '{}', 'release-public-key.pem': 'not the release key\n' });
  assert.throws(() => assertPackagedPublicKey(wrong, keys.publicKey), /not the key of this release/);

  const good = await build({ 'package.json': '{}', 'release-public-key.pem': keys.publicKey });
  assert.doesNotThrow(() => assertPackagedPublicKey(good, keys.publicKey));
});

test('packaging fails when a script of the release check worker is missing from the archive', async (t) => {
  const { createPackageWithOptions } = createRequire(import.meta.url)('@electron/asar');
  const root = mkdtempSync(join(tmpdir(), 'timon-asar-check-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const build = async (names) => {
    const src = mkdtempSync(join(tmpdir(), 'timon-asar-src-'));
    const resources = mkdtempSync(join(root, 'resources-'));
    mkdirSync(join(src, 'scripts'));
    writeFileSync(join(src, 'package.json'), '{}');
    for (const name of names) writeFileSync(join(src, name), '');
    await createPackageWithOptions(src, join(resources, 'app.asar'), {});
    rmSync(src, { recursive: true, force: true });
    return resources;
  };
  const config = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  for (const name of ['scripts/release-integrity-worker.mjs', 'scripts/release-integrity.mjs']) {
    assert.match(config, new RegExp(`- ${name.replace(/[.]/g, '\\.')}\\n`));
    const others = ['scripts/release-integrity-worker.mjs', 'scripts/release-integrity.mjs'].filter(n => n !== name);
    const missing = await build(others);
    assert.throws(() => assertPackagedReleaseCheck(missing), new RegExp(`No ${name.replace(/[.]/g, '\\.')}`));
  }
  const complete = await build(['scripts/release-integrity-worker.mjs', 'scripts/release-integrity.mjs']);
  assert.doesNotThrow(() => assertPackagedReleaseCheck(complete));
});

test('TODO #550: the package carries the speech models\' licences and the Apache-2.0 NOTICE beside the app', (t) => {
  const { load } = createRequire(import.meta.url)('js-yaml');
  const config = load(readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8'));
  assert.deepEqual(config.extraResources.find(r => r.to === THIRD_PARTY_NOTICES), { from: THIRD_PARTY_NOTICES, to: THIRD_PARTY_NOTICES });
  const expected = readFileSync(new URL(`../${THIRD_PARTY_NOTICES}`, import.meta.url));
  const text = expected.toString('utf8');
  assert.match(text, /^NOTICE\r?$/m);
  assert.match(text, /Licensed under the Apache License, Version 2\.0/);
  const resources = mkdtempSync(join(tmpdir(), 'timon-notices-'));
  t.after(() => rmSync(resources, { recursive: true, force: true }));
  assert.throws(() => assertPackagedThirdPartyNotices(resources, expected), /No THIRD-PARTY-MODELS\.md .*extraResources/);
  writeFileSync(join(resources, THIRD_PARTY_NOTICES), text.slice(0, text.indexOf('NOTICE')));
  assert.throws(() => assertPackagedThirdPartyNotices(resources, expected), /not the one of this checkout/);
  writeFileSync(join(resources, THIRD_PARTY_NOTICES), expected);
  assert.doesNotThrow(() => assertPackagedThirdPartyNotices(resources, expected));
});

test('the package carries the dictation engine of its own OS only, unpacked, and no model', async (t) => {
  const { createPackageWithOptions } = createRequire(import.meta.url)('@electron/asar');
  const root = mkdtempSync(join(tmpdir(), 'timon-speech-pack-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // File lists of the published 1.12.37 tarballs.
  const linux = ['sherpa-onnx.node', 'libonnxruntime.so', 'libsherpa-onnx-c-api.so', 'libsherpa-onnx-cxx-api.so', 'index.js', 'package.json'];
  const windows = ['sherpa-onnx.node', 'onnxruntime.dll', 'onnxruntime_providers_shared.dll', 'sherpa-onnx-c-api.dll', 'index.js'];
  const mac = ['sherpa-onnx.node', 'libonnxruntime.1.23.2.dylib', 'libonnxruntime.dylib', 'libsherpa-onnx-c-api.dylib', 'index.js'];
  // One resources directory per case: `@electron/asar` caches headers by path.
  const pack = async (packages, archived = {}) => {
    const resources = mkdtempSync(join(root, 'resources-'));
    const src = mkdtempSync(join(root, 'src-'));
    for (const [name, body] of Object.entries({ 'package.json': '{}', ...archived })) {
      mkdirSync(join(src, name, '..'), { recursive: true });
      writeFileSync(join(src, name), body);
    }
    await createPackageWithOptions(src, join(resources, 'app.asar'), {});
    for (const [name, files] of Object.entries(packages)) {
      for (const file of files) {
        const path = join(resources, 'app.asar.unpacked', 'node_modules', name, file);
        mkdirSync(join(path, '..'), { recursive: true });
        writeFileSync(path, 'x');
      }
    }
    return resources;
  };

  for (const [name, files] of [['sherpa-onnx-linux-x64', linux], ['sherpa-onnx-win-x64', windows], ['sherpa-onnx-darwin-arm64', mac]]) {
    const resources = await pack({ [name]: files });
    assert.doesNotThrow(() => assertPackagedSpeechEngine(resources, name), name);
  }
  const twoEngines = await pack({ 'sherpa-onnx-linux-x64': linux, 'sherpa-onnx-win-x64': windows });
  assert.throws(() => assertPackagedSpeechEngine(twoEngines, 'sherpa-onnx-linux-x64'), /and only it; found sherpa-onnx-linux-x64, sherpa-onnx-win-x64/);
  const otherOs = await pack({ 'sherpa-onnx-darwin-x64': mac });
  assert.throws(() => assertPackagedSpeechEngine(otherOs, 'sherpa-onnx-darwin-arm64'), /found sherpa-onnx-darwin-x64/);
  const none = await pack({});
  assert.throws(() => assertPackagedSpeechEngine(none, 'sherpa-onnx-linux-x64'), /found none\. Install the desktop dependencies/);
  const noRuntime = await pack({ 'sherpa-onnx-linux-x64': linux.filter((file) => file !== 'libonnxruntime.so') });
  assert.throws(() => assertPackagedSpeechEngine(noRuntime, 'sherpa-onnx-linux-x64'), /no onnxruntime library/);
  const noCApi = await pack({ 'sherpa-onnx-win-x64': windows.filter((file) => file !== 'sherpa-onnx-c-api.dll') });
  assert.throws(() => assertPackagedSpeechEngine(noCApi, 'sherpa-onnx-win-x64'), /no sherpa-onnx C API library/);
  const noAddon = await pack({ 'sherpa-onnx-linux-x64': linux.filter((file) => file !== 'sherpa-onnx.node') });
  assert.throws(() => assertPackagedSpeechEngine(noAddon, 'sherpa-onnx-linux-x64'), /no sherpa-onnx\.node/);
  const unpackedModel = await pack({ 'sherpa-onnx-linux-x64': [...linux, 'models/encoder.int8.onnx'] });
  assert.throws(() => assertPackagedSpeechEngine(unpackedModel, 'sherpa-onnx-linux-x64'), /is a speech model/);
  const archivedModel = await pack({ 'sherpa-onnx-linux-x64': linux }, { 'speech/decoder.int8.onnx': 'x' });
  assert.throws(() => assertPackagedSpeechEngine(archivedModel, 'sherpa-onnx-linux-x64'), /carries a speech model/);
  // Windows on Arm, Linux armv7l: no published engine, so none may travel.
  assert.doesNotThrow(() => assertPackagedSpeechEngine(none, null));
  const stray = await pack({ 'sherpa-onnx-win-x64': windows });
  assert.throws(() => assertPackagedSpeechEngine(stray, null), /No dictation engine is published for this target/);
});

/** afterPack reads the shell's table: every name it can return must be a package npm installs. */
test('every engine the shell looks for is an optional dependency of the desktop package', () => {
  const optional = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).optionalDependencies ?? {};
  const targets = [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['linux', 'x64'], ['win32', 'x64'], ['win32', 'arm64'], ['linux', 'armv7l']];
  const names = targets.map(([platform, arch]) => sherpaPackageName(platform, arch)).filter(Boolean);
  assert.equal(names.length, 5);
  for (const name of names) assert.ok(optional[name], `${name} is not in optionalDependencies`);
  assert.deepEqual(Object.keys(optional).filter((name) => name.startsWith('sherpa-onnx')).sort(), [...names].sort());
  const hooks = readFileSync(new URL('./release-hooks.mjs', import.meta.url), 'utf8');
  assert.match(hooks, /import\('\.\.\/dist\/speech-paths\.js'\)/, 'afterPack uses the compiled table, not a copy');
});

test('cross-architecture packaging is refused before native artefacts are selected', async () => {
  await assert.rejects(beforePack({ electronPlatformName: process.platform,
    arch: process.arch === 'arm64' ? Arch.x64 : Arch.arm64 }), /CPU architecture/);
});

test('the terminal host entry checks the release before running, like boot.js', (t) => {
  const root = fixtureUnsealed(t);
  mkdirSync(join(root, 'dist/terminal-host'), { recursive: true });
  writeFileSync(join(root, 'dist/terminal-host/main.js'), "console.log('host up');");
  sealTree(root, keys);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const run = () => spawnSync(process.execPath, [join(root, 'dist/terminal-host/main.js')], { encoding: 'utf8', timeout: 15000, env });
  const ok = run();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ok.stdout.trim(), 'host up');
  assert.ok(verifyRelease(root, keys.publicKey).files['dist/terminal-host/main-verified.js']);
  writeFileSync(join(root, 'dist/terminal-host/main-verified.js'), "console.log('tampered');");
  const tampered = run();
  assert.notEqual(tampered.status, 0);
  assert.doesNotMatch(tampered.stdout, /tampered/);
});

// ── build-info.json: channel and expiry, signed with the release ────────────

test('build-info.json is staged, signed, and its removal or edit fails the release', (t) => {
  const source = mkdtempSync(join(tmpdir(), 'timon-build-info-src-'));
  t.after(() => rmSync(source, { recursive: true, force: true }));
  // No file, no package: the staging refuses instead of shipping a build that never expires.
  assert.throws(() => stageBuildInfo(source, join(source, 'orchestrator')), /build-info\.json is missing/);
  mkdirSync(join(source, 'orchestrator'));
  const info = createBuildInfo({ now: new Date('2026-10-01T00:00:00Z') });
  writeBuildInfo(source, info);

  for (const action of ['edit', 'delete']) {
    const root = fixtureUnsealed(t);
    assert.deepEqual(stageBuildInfo(root, join(source, 'orchestrator')), info);
    sealTree(root, keys);
    assert.ok(verifyRelease(root, keys.publicKey).files['build-info.json'], 'build-info.json is not in the signed inventory');
    if (action === 'edit') writeFileSync(join(root, 'build-info.json'), JSON.stringify({ ...info, expiresAt: '2099-01-01T00:00:00.000Z' }));
    else rmSync(join(root, 'build-info.json'));
    assert.throws(() => verifyRelease(root, keys.publicKey), undefined, action);
  }
});

// ── timon-fence: the Linux mission launcher, signed with the release ────────

test('the Linux mission launcher is signed with the release: replacing or removing it fails the check', (t) => {
  for (const action of ['edit', 'delete']) {
    const root = fixtureUnsealed(t);
    mkdirSync(join(root, 'native'));
    writeFileSync(join(root, 'native', 'timon-fence'), 'launcher', { mode: 0o755 });
    sealTree(root, keys);
    assert.ok(verifyRelease(root, keys.publicKey).files['native/timon-fence'], 'native/timon-fence is not in the signed inventory');
    if (action === 'edit') writeFileSync(join(root, 'native', 'timon-fence'), '#!/bin/sh\nexec "$@"\n');
    else rmSync(join(root, 'native'), { recursive: true });
    assert.throws(() => verifyRelease(root, keys.publicKey), undefined, action);
  }
});

// The daemon skips a launcher it cannot execute (host/fence.ts) and the
// digest does not see a mode: the execute bit must be checked on its own, or a
// chmod on the durable copy would unfence every mission without failing boot.
test('a release whose launcher lost its execute bit fails the check; a release without one is unaffected', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, (t) => {
  const root = fixtureUnsealed(t);
  mkdirSync(join(root, 'native'));
  const fence = join(root, 'native', 'timon-fence');
  writeFileSync(fence, 'launcher', { mode: 0o755 });
  sealTree(root, keys);
  assert.doesNotThrow(() => verifyRelease(root, keys.publicKey));
  chmodSync(fence, 0o644);
  assert.throws(() => verifyRelease(root, keys.publicKey), /native\/timon-fence is not executable/);
  chmodSync(fence, 0o755);
  assert.doesNotThrow(() => verifyRelease(root, keys.publicKey));

  const older = fixtureUnsealed(t);
  sealTree(older, keys);
  assert.equal(verifyRelease(older, keys.publicKey).files['native/timon-fence'], undefined);
});

test('a launcher that is not executable is never sealed', { skip: process.platform === 'win32' && 'Windows has no execute bit' }, (t) => {
  const root = fixtureUnsealed(t);
  mkdirSync(join(root, 'native'));
  writeFileSync(join(root, 'native', 'timon-fence'), 'launcher', { mode: 0o644 });
  assert.throws(() => sealTree(root, keys), /not executable/);
});

test('the launcher is staged on Linux only, and a Linux build without a compiler stops', () => {
  const calls = [];
  const build = (arch, out) => { calls.push([arch, out]); return 'cc'; };
  assert.equal(stageFence('/stage', 'darwin', 'arm64', build), null);
  assert.equal(stageFence('/stage', 'win32', 'x64', build), null);
  assert.deepEqual(calls, []);
  assert.equal(stageFence('/stage', 'linux', 'arm64', build), join('/stage', 'native', 'timon-fence'));
  assert.deepEqual(calls, [['arm64', join('/stage', 'native', 'timon-fence')]]);
  assert.throws(() => stageFence('/stage', 'linux', 'x64', () => null), /No C compiler for timon-fence/);
});

test('a Linux package without its executable launcher is refused; other OSes carry none', { skip: process.platform === 'win32' }, (t) => {
  const resources = mkdtempSync(join(tmpdir(), 'timon-fence-pack-'));
  t.after(() => rmSync(resources, { recursive: true, force: true }));
  assert.doesNotThrow(() => assertPackagedFence(resources, 'darwin'));
  assert.doesNotThrow(() => assertPackagedFence(resources, 'win32'));
  assert.throws(() => assertPackagedFence(resources, 'linux'), /timon-fence is missing/);
  mkdirSync(join(resources, 'orchestrator', 'native'), { recursive: true });
  const fence = join(resources, 'orchestrator', 'native', 'timon-fence');
  writeFileSync(fence, '#!/bin/sh\necho impostor\n');
  chmodSync(fence, 0o644);
  assert.throws(() => assertPackagedFence(resources, 'linux'), /not executable/);
  chmodSync(fence, 0o755);
  if (process.platform === 'linux') assert.throws(() => assertPackagedFence(resources, 'linux'), /not the mission launcher/);
});

// ── Built-in plugins: signed with the release, handed to the daemon ─────────

const BUILTIN_FILE = 'builtin-plugins/@fx/plugin/lib/index.js';
function builtinFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'timon-builtin-release-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['dist/license', 'bin', 'scripts', 'presets', 'builtin-plugins/@fx/plugin/lib']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'dist/license/pubkey.js'), `const LICENSE_PUBLIC_KEYS = ['pinned']; let override = null;
export function activeKeyring() { return override ?? LICENSE_PUBLIC_KEYS; }
export function overrideKeyringForTests(keys) { override = keys; }`);
  writeFileSync(join(root, 'dist/boot.js'), `const release = globalThis[Symbol.for('timon.verifiedRelease')];
console.log(JSON.stringify(Object.keys(release?.files ?? {}).filter((n) => n.startsWith('builtin-plugins'))));`);
  writeFileSync(join(root, 'builtin-plugins.json'), '{"plugins":[{"pkg":"@fx/plugin","source":"x"}]}');
  writeFileSync(join(root, 'builtin-plugins/@fx/plugin/package.json'), '{"name":"@fx/plugin"}');
  writeFileSync(join(root, BUILTIN_FILE), '// readable SDK source\nexport function apply() {}\n');
  sealTree(root, keys);
  return root;
}

test('an altered or removed built-in file fails the release inventory', (t) => {
  for (const action of ['edit', 'add', 'delete']) {
    const root = builtinFixture(t);
    if (action === 'edit') writeFileSync(join(root, BUILTIN_FILE), 'export function apply() { /* cracked */ }');
    if (action === 'add') writeFileSync(join(root, 'builtin-plugins/@fx/plugin/lib/extra.js'), '');
    if (action === 'delete') rmSync(join(root, 'builtin-plugins'), { recursive: true });
    assert.throws(() => verifyRelease(root, keys.publicKey), undefined, action);
  }
});

test('built-in plugins are signed, left readable, and their inventory reaches the daemon', (t) => {
  const root = builtinFixture(t);
  const manifest = verifyRelease(root, keys.publicKey);
  assert.ok(manifest.files[BUILTIN_FILE]);
  assert.ok(manifest.files['builtin-plugins.json']);
  assert.match(readFileSync(join(root, BUILTIN_FILE), 'utf8'), /readable SDK source/, 'left as written');
  const result = boot(root);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    'builtin-plugins.json', 'builtin-plugins/@fx/plugin/lib/index.js', 'builtin-plugins/@fx/plugin/package.json',
  ]);
});

test('staging copies each listed built-in (package.json, lib, README, gallery files) and the list', (t) => {
  const target = mkdtempSync(join(tmpdir(), 'timon-builtin-stage-'));
  t.after(() => rmSync(target, { recursive: true, force: true }));
  assert.ok(copyBuiltinPlugins(target) >= 1);
  const dir = join(target, 'builtin-plugins', '@timon-ai', 'plugin-quota-monitor');
  for (const name of ['package.json', 'README.md', 'lib/index.js', 'lib/client.js', 'icon.svg']) assert.ok(existsSync(join(dir, name)), name);
  assert.ok(existsSync(join(target, 'builtin-plugins.json')));  // Ported code keeps its licence notice in the shipped copy.
  assert.ok(existsSync(join(target, 'builtin-plugins', '@timon-ai', 'plugin-hermes-gateway', 'NOTICE')));
});

test('staging refuses a list entry whose package is not the one it names', (t) => {
  const orch = mkdtempSync(join(tmpdir(), 'timon-builtin-list-'));
  t.after(() => rmSync(orch, { recursive: true, force: true }));
  mkdirSync(join(orch, 'pkg', 'lib'), { recursive: true });
  writeFileSync(join(orch, 'pkg', 'package.json'), '{"name":"@other/name"}');
  writeFileSync(join(orch, 'builtin-plugins.json'), '{"plugins":[{"pkg":"@fx/plugin","source":"pkg"}]}');
  assert.throws(() => copyBuiltinPlugins(join(orch, 'out'), orch), /not `@fx\/plugin`/);
  writeFileSync(join(orch, 'builtin-plugins.json'), '{"plugins":[{"pkg":"../escape","source":"pkg"}]}');
  assert.throws(() => copyBuiltinPlugins(join(orch, 'out2'), orch), /invalid entry/);
  writeFileSync(join(orch, 'pkg', 'package.json'), '{"name":"@fx/plugin","timon":{"icon":"../outside.svg"}}');
  writeFileSync(join(orch, 'builtin-plugins.json'), '{"plugins":[{"pkg":"@fx/plugin","source":"pkg"}]}');
  assert.throws(() => copyBuiltinPlugins(join(orch, 'out3'), orch), /escapes the package/);
  writeFileSync(join(orch, 'pkg', 'package.json'), '{"name":"@fx/plugin","timon":{"icon":"icon.svg"}}');
  assert.throws(() => copyBuiltinPlugins(join(orch, 'out4'), orch), /missing/);
});

test('the keyring transform matches the real pubkey.ts, not only a fixture', async (t) => {
  // A fixture kept the old `override = keys;` while pubkey.ts moved on: every
  // release test stayed green and the packaging refused to build (05/11/2026).
  const source = readFileSync(new URL('../../orchestrator/src/license/pubkey.ts', import.meta.url), 'utf8');
  const root = mkdtempSync(join(tmpdir(), 'timon-release-real-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const dir of ['dist/license', 'bin', 'scripts', 'presets']) mkdirSync(join(root, dir), { recursive: true });
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  // The two lines the transform rewrites, as the real source writes them.
  const lines = source.split('\n').filter((line) => /return override \?\? LICENSE_PUBLIC_KEYS;|\boverride = keys\b/.test(line));
  assert.equal(lines.length, 2, 'pubkey.ts still has the getter and the setter the transform rewrites');
  writeFileSync(join(root, 'dist/license/pubkey.js'), `const LICENSE_PUBLIC_KEYS = ['pinned']; let override = null;\nexport function activeKeyring() {\n${lines[0]}\n}\nexport function overrideKeyringForTests(keys) {\n${lines[1]}\n}\n`);
  writeFileSync(join(root, 'dist/boot.js'), "export {};\n");
  sealTree(root, keys);
  const mod = await import(pathToFileURL(join(root, 'dist/license/pubkey.js')).href);
  assert.deepEqual(mod.activeKeyring(), ['pinned'], 'the pinned keyring only');
  assert.throws(() => mod.overrideKeyringForTests(['forged']), /unavailable in distributions/, 'no path left to a test keyring');
});
