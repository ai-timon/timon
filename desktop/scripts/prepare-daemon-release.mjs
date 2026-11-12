import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createReleaseNotes } from './release-notes.mjs';
import { FRAGMENTS_DIR, readFragments, withUnreleased } from '../../scripts/changelog-fragments.mjs';
import { RELEASE_MANIFEST_VERSION, digest, productFiles, verifyRelease } from './release-integrity.mjs';
import { BUILD_INFO_FILE, buildInfoPath, readBuildInfo } from './build-info.mjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
export const releaseDir = join(desktop, 'build-resources', 'daemon-release');

export function releaseKeys(env = process.env) {
  if (!env.TIMON_RELEASE_PRIVATE_KEY_FILE || !env.TIMON_RELEASE_PUBLIC_KEY_FILE) {
    throw new Error('Distribution requires TIMON_RELEASE_PRIVATE_KEY_FILE and TIMON_RELEASE_PUBLIC_KEY_FILE (Ed25519 PEM files)');
  }
  const privateKey = createPrivateKey(readFileSync(env.TIMON_RELEASE_PRIVATE_KEY_FILE));
  const publicKey = createPublicKey(readFileSync(env.TIMON_RELEASE_PUBLIC_KEY_FILE));
  if (privateKey.asymmetricKeyType !== 'ed25519' || publicKey.asymmetricKeyType !== 'ed25519'
    || !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) {
    throw new Error('Release signing keys must be a matching Ed25519 pair');
  }
  return { privateKey, publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
}

function runNode(args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, args, { cwd, stdio: 'inherit', env: process.env });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Compilation failed (${code ?? signal})`)));
  });
}

export function sealTree(root, keys) {
  // The production keyring has no mutable test hook in the shipped artefact.
  const keyFile = join(root, 'dist/license/pubkey.js');
  let keyCode = readFileSync(keyFile, 'utf8');
  const old = 'return override ?? LICENSE_PUBLIC_KEYS;';
  // The setter's assignment, whatever its right-hand side (`keys`, a frozen
  // copy of them…): matched up to its semicolon, never the declaration.
  const setter = /\boverride = keys\b[^;]*;/;
  if (!keyCode.includes(old) || !setter.test(keyCode)) throw new Error('Review the release keyring transform after changing pubkey.ts');
  keyCode = keyCode.replace(old, 'return LICENSE_PUBLIC_KEYS;').replace(setter, "throw new Error('Test keyring overrides are unavailable in distributions');");
  writeFileSync(keyFile, keyCode);

  // Keep the entry path stable for installed services; dynamic import ensures
  // integrity is checked before ANY of the daemon's static imports execute.
  renameSync(join(root, 'dist/boot.js'), join(root, 'dist/boot-verified.js'));
  cpSync(new URL('./release-integrity.mjs', import.meta.url), join(root, 'dist/release-integrity.mjs'));
  // The verified inventory is handed to the daemon, which trusts a built-in
  // plugin only for files it lists (orchestrator/src/plugins/builtin.ts).
  writeFileSync(join(root, 'dist/boot.js'), `import { fileURLToPath } from 'node:url';\nimport { RELEASE_MARKER, verifyRelease } from './release-integrity.mjs';\nconst release = verifyRelease(fileURLToPath(new URL('../', import.meta.url)), ${JSON.stringify(keys.publicKey)});\nglobalThis[RELEASE_MARKER] = Object.freeze({ files: Object.freeze({ ...release.files }) });\nawait import('./boot-verified.js');\n`);
  // The terminal host is the daemon's second entry point, and it sees every
  // keystroke of the web terminal: it checks the release the same way.
  const terminalHost = join(root, 'dist/terminal-host/main.js');
  if (existsSync(terminalHost)) {
    renameSync(terminalHost, join(root, 'dist/terminal-host/main-verified.js'));
    writeFileSync(terminalHost, `import { fileURLToPath } from 'node:url';\nimport { verifyRelease } from '../release-integrity.mjs';\nverifyRelease(fileURLToPath(new URL('../../', import.meta.url)), ${JSON.stringify(keys.publicKey)});\nawait import('./main-verified.js');\n`);
  }

  const names = productFiles(root);
  for (const name of names) {
    if (/\.map$|\.test\.[cm]?js$|\.d\.ts$/.test(name)) throw new Error(`Build artefact in the release: ${name}`);
  }
  const files = Object.fromEntries(names.map((name) => [name, digest(join(root, name))]));
  const body = JSON.stringify({ version: RELEASE_MANIFEST_VERSION, files }, null, 2) + '\n';
  writeFileSync(join(root, 'release-manifest.json'), body);
  writeFileSync(join(root, 'release-manifest.sig'), sign(null, Buffer.from(body), keys.privateKey));
  verifyRelease(root, keys.publicKey);
  return names.length;
}

/**
 * Copies each built-in plugin of `orchestrator/builtin-plugins.json` — the
 * list the daemon reads too — to `builtin-plugins/<npm name>/`, with the list
 * beside it. Only what a package ships (`package.json`, `lib/`, README, NOTICE, LICENSE, and the
 * gallery files its manifest names: `icon`, `cover`, `screenshots`): both
 * roots then fall under the signed release manifest.
 */
export function copyBuiltinPlugins(target, orchestratorDir = join(repo, 'orchestrator')) {
  const listFile = join(orchestratorDir, 'builtin-plugins.json');
  const { plugins } = JSON.parse(readFileSync(listFile, 'utf8'));
  if (!Array.isArray(plugins)) throw new Error(`${listFile}: \`plugins\` must be an array`);
  mkdirSync(join(target, 'builtin-plugins'), { recursive: true });
  cpSync(listFile, join(target, 'builtin-plugins.json'));
  for (const { pkg, source } of plugins) {
    if (typeof pkg !== 'string' || !/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(pkg) || typeof source !== 'string') {
      throw new Error(`${listFile}: invalid entry ${JSON.stringify({ pkg, source })}`);
    }
    const from = resolve(orchestratorDir, source);
    const manifest = JSON.parse(readFileSync(join(from, 'package.json'), 'utf8'));
    if (manifest.name !== pkg) throw new Error(`${from}/package.json is \`${manifest.name}\`, not \`${pkg}\``);
    const dest = join(target, 'builtin-plugins', ...pkg.split('/'));
    mkdirSync(dest, { recursive: true });
    cpSync(join(from, 'package.json'), join(dest, 'package.json'));
    cpSync(join(from, 'lib'), join(dest, 'lib'), { recursive: true });
    // NOTICE and LICENSE carry the attributions of ported code (MIT asks for them in every copy).
    for (const doc of ['README.md', 'NOTICE', 'LICENSE']) {
      if (existsSync(join(from, doc))) cpSync(join(from, doc), join(dest, doc));
    }
    // A gallery file left behind is a card without its picto on every
    // installed client, while the dev tree shows it.
    const timon = manifest.timon ?? {};
    for (const asset of [timon.icon, timon.cover, ...(Array.isArray(timon.screenshots) ? timon.screenshots : [])]) {
      if (typeof asset !== 'string' || asset === '') continue;
      const file = resolve(from, asset);
      if (!file.startsWith(resolve(from) + sep)) throw new Error(`${from}/package.json: \`${asset}\` escapes the package`);
      if (!existsSync(file)) throw new Error(`${from}/package.json names \`${asset}\`, which is missing`);
      mkdirSync(dirname(join(dest, asset)), { recursive: true });
      cpSync(file, join(dest, asset));
    }
  }
  return plugins.length;
}

/**
 * Stages `orchestrator/build-info.json` (channel + expiry) at the root of the
 * daemon, where `sealTree` signs it. Refuses to package without it: a build
 * that cannot tell when it expires would run on a tester's machine forever.
 * The build scripts write it; a hand-run `npm run dist` gets this error.
 */
export function stageBuildInfo(target, orchestratorDir = join(repo, 'orchestrator')) {
  const info = readBuildInfo(buildInfoPath(orchestratorDir));
  writeFileSync(buildInfoPath(target), JSON.stringify(info, null, 2) + '\n');
  return info;
}

/**
 * The user documentation as Markdown, for the MCP tools docs_search/docs_read
 * (orchestrator/bin/docs-local.mjs): agents read the version they run, offline.
 * Public content, so it sits outside the signed roots.
 */
export async function exportDocs(target) {
  const { exportMarkdown, writeExport } = await import(pathToFileURL(join(repo, 'public-docs', 'scripts', 'export-markdown.mjs')).href);
  const result = exportMarkdown();
  mkdirSync(target, { recursive: true });
  writeExport(result, target, { index: true });
  console.log(`[release] ${result.pages.length} documentation pages exported: ${target}`);
}

export async function prepareDaemonRelease() {
  const keys = releaseKeys(); // fail before compiling, never ship an unsigned daemon
  mkdirSync(dirname(releaseDir), { recursive: true });
  if (existsSync(releaseDir) && lstatSync(releaseDir).isSymbolicLink()) throw new Error('Release staging must not be a symlink');
  const stage = mkdtempSync(join(dirname(releaseDir), 'daemon-release-'));
  try {
    await runNode([join(repo, 'orchestrator/node_modules/typescript/bin/tsc'), '--project', join(repo, 'orchestrator/tsconfig.json'), '--outDir', join(stage, 'dist'), '--sourceMap', 'false', '--declaration', 'false'], repo);
    for (const name of ['bin', 'presets', 'scripts']) {
      cpSync(join(repo, 'orchestrator', name), join(stage, name), { recursive: true, verbatimSymlinks: true });
    }
    const pkg = JSON.parse(readFileSync(join(repo, 'orchestrator/package.json'), 'utf8'));
    // Standalone consumers can install runtime dependencies without build/test tooling.
    delete pkg.devDependencies;
    pkg.scripts = { start: 'node dist/index.js' };
    writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
    // Test fixtures and developer smoke scripts are never runtime assets.
    rmSync(join(stage, 'dist/kernel/fixtures'), { recursive: true, force: true });
    rmSync(join(stage, 'scripts/test-plugin-hot-reload.mjs'), { force: true });
    console.log(`[release] ${copyBuiltinPlugins(stage)} built-in plugin(s) staged`);
    let changelog = '';
    try { changelog = readFileSync(join(repo, 'CHANGELOG.md'), 'utf8'); }
    catch { console.warn('[release] Changelog unavailable; shipping empty release notes'); }
    // An rc's notes are the changes not released yet: they live in changes/,
    // not in the file, and are rendered as its Unreleased section.
    changelog = withUnreleased(changelog, readFragments(join(repo, FRAGMENTS_DIR)));
    const info = stageBuildInfo(stage);
    console.log(`[release] ${BUILD_INFO_FILE}: channel ${info.channel}, built ${info.builtAt}, expires ${info.expiresAt ?? 'never'}`);
    writeFileSync(join(stage, 'scripts', 'release-notes.json'), JSON.stringify(createReleaseNotes(changelog, pkg.version), null, 2) + '\n');
    cpSync(new URL('./release-notes.mjs', import.meta.url), join(stage, 'scripts', 'release-notes.mjs'));
    await exportDocs(join(stage, 'public-docs'));
    const count = sealTree(stage, keys);
    rmSync(releaseDir, { recursive: true, force: true });
    renameSync(stage, releaseDir);
    writeFileSync(join(dirname(releaseDir), 'release-public-key.pem'), keys.publicKey);
    console.log(`[release] ${count} files signed: ${releaseDir}`);
    return releaseDir;
  } finally { rmSync(stage, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--check')) releaseKeys();
  else await prepareDaemonRelease();
}
