import { createHash, verify } from 'node:crypto';
import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Only immutable product files: user state and installed dependencies are not
// covered. Signing packages and OS trust remain separate layers.
export const protectedRoots = ['dist', 'bin', 'scripts', 'presets', 'package.json'];
// Built-in plugins (orchestrator/src/plugins/builtin.ts): signed when shipped.
// Optional only for inventories that predate them — a manifest that lists
// them still fails on their removal, since the inventories must match.
// `build-info.json` (channel + expiry) is signed too, so the date cannot be
// edited in an installed package; a release prepared before it stays valid.
// `native/` holds the Linux mission launcher (timon-fence): signed, so a
// replaced launcher fails the boot check instead of unfencing the missions.
export const optionalRoots = ['builtin-plugins', 'builtin-plugins.json', 'build-info.json', 'native'];
// Files the daemon only runs when executable, so their mode is part of what a
// release guarantees, not only their bytes: a launcher stripped of its execute
// bit keeps its digest, and the daemon would skip it and run every mission
// unfenced. Same test as the daemon (`orchestrator/src/host/fence.ts`): the
// owner may execute it. Checked only when the manifest lists the file, so a
// release that predates it, or targets another OS, is unaffected.
export const executableFiles = ['native/timon-fence'];
// Read by the daemon to trust built-in plugins by location; set only here,
// after the inventory below has been verified.
export const RELEASE_MARKER = Symbol.for('timon.verifiedRelease');
// Version 2 lists the signed files and nothing else; version 1 also named a
// protection scheme the package no longer applies. The shell and the daemon of
// a package only check their own release, so no reader of version 1 remains.
export const RELEASE_MANIFEST_VERSION = 2;
export function productFiles(root) {
  const files = [];
  function visit(name) {
    const path = join(root, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Release contains a symbolic link: ${name}`);
    if (stat.isDirectory()) {
      for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile()) files.push(name);
    else throw new Error(`Unsupported release file: ${name}`);
  }
  for (const name of protectedRoots) visit(name);
  for (const name of optionalRoots) if (existsSync(join(root, name))) visit(name);
  return files.sort();
}
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export function digest(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
export function verifyRelease(root, publicKey) {
  const body = readFileSync(join(root, 'release-manifest.json'));
  const signature = readFileSync(join(root, 'release-manifest.sig'));
  if (!verify(null, body, publicKey, signature)) throw new Error('Invalid release signature');
  const manifest = JSON.parse(body.toString('utf8'));
  if (manifest.version !== RELEASE_MANIFEST_VERSION) throw new Error('Unsupported release manifest version');
  const actual = productFiles(root);
  const expected = Object.keys(manifest.files).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Release inventory differs');
  for (const name of actual) {
    if (digest(join(root, name)) !== manifest.files[name]) throw new Error(`Release integrity failed: ${name}`);
  }
  for (const name of executableFiles) {
    if (name in manifest.files && !isExecutable(join(root, name))) throw new Error(`Release integrity failed: ${name} is not executable`);
  }
  return manifest;
}
