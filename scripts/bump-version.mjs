/**
 * Bumps the product version in one gesture, and writes the changelog
 * fragments of `changes/` into the new version's section of CHANGELOG.md.
 *
 * Why a script rather than three `npm version` calls: the daemon reports its
 * own version to the licence server as `appVersion` (`timonVersion()` in
 * `orchestrator/src/license/client.ts`, which reads `orchestrator/package.json`),
 * while `desktop/package.json` carries the version of the installer a tester
 * actually downloaded. Bump one without the other and the two halves of the
 * same build declare different versions to the server — with
 * `LICENSE_FREE_MIN_CLIENT_VERSION` able to filter on exactly that value.
 *
 * Writes files and nothing else. Committing and tagging stay a human gesture:
 * a tag is the anchor a release is read from afterwards, and an agent that
 * lays one down by accident is a mess to unwind.
 *
 *   node scripts/bump-version.mjs patch|minor|major|<x.y.z> [--dry-run]
 */
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAGMENTS_DIR, readFragments, renderFragments } from './changelog-fragments.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Every package whose version must move as one. `app` holds no version of its
 *  own meaning, but a lone `0.1.0` left behind reads as a bug to the next one
 *  to open it. */
const PACKAGES = ['orchestrator/package.json', 'app/package.json', 'desktop/package.json'];
/** The one the daemon actually reports. Source of the current version. */
const REFERENCE = 'orchestrator/package.json';
const CHANGELOG = 'CHANGELOG.md';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

const [target, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');

if (!target || flags.some((f) => f !== '--dry-run')) {
  fail('Usage: node scripts/bump-version.mjs patch|minor|major|<x.y.z> [--dry-run]');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function read(path) {
  return readFileSync(resolve(ROOT, path), 'utf8');
}

function write(path, content) {
  if (dryRun) return;
  writeFileSync(resolve(ROOT, path), content);
}

function versionOf(source, path) {
  // Read by regex rather than by parsing: writing the file back through
  // JSON.stringify would reformat every line npm wrote, and the diff of a
  // version bump has to stay one line.
  const match = source.match(/"version":\s*"([^"]+)"/);
  if (!match) fail(`no "version" field in ${path}`);
  return match[1];
}

function nextVersion(current, how) {
  if (SEMVER.test(how)) return how;
  const parts = current.match(SEMVER);
  if (!parts) fail(`current version is not x.y.z: ${current}`);
  const [major, minor, patch] = parts.slice(1).map(Number);
  if (how === 'major') return `${major + 1}.0.0`;
  if (how === 'minor') return `${major}.${minor + 1}.0`;
  if (how === 'patch') return `${major}.${minor}.${patch + 1}`;
  return fail(`unknown bump: ${how} (expected patch, minor, major or x.y.z)`);
}

/** The new version's section, written from the fragments above the previous
 *  versions. Fragments with nothing to say for this release (only known issues)
 *  refuse the bump: a version with nothing to say is a version nobody needs. */
function releaseChangelog(source, fragments, version, date) {
  if (source.includes('## [Unreleased]')) {
    fail(`${CHANGELOG} still has an "## [Unreleased]" section: move its entries into ${FRAGMENTS_DIR}/ (see ${FRAGMENTS_DIR}/README.md)`);
  }
  if (!fragments.some((fragment) => fragment.type !== 'known-issue')) {
    fail(`${FRAGMENTS_DIR}/ holds no added, fixed or changed entry — a version with nothing to say is a version nobody needs`);
  }
  const section = `## [${version}] — ${date}\n\n${renderFragments(fragments)}\n\n`;
  const at = source.search(/^## \[/m);
  return at < 0 ? `${source.replace(/\n*$/, '\n\n')}${section}` : `${source.slice(0, at)}${section}${source.slice(at)}`;
}

const current = versionOf(read(REFERENCE), REFERENCE);
const version = nextVersion(current, target);
const date = new Date().toISOString().slice(0, 10);

// Read and validated before anything is written: an invalid fragment stops
// the bump with every file untouched.
const fragments = readFragments(resolve(ROOT, FRAGMENTS_DIR));
const changelog = releaseChangelog(read(CHANGELOG), fragments, version, date);

for (const path of PACKAGES) {
  const source = read(path);
  const was = versionOf(source, path);
  if (was !== current) {
    console.warn(`  ! ${path} was at ${was}, not ${current} — realigning on ${version}`);
  }
  write(path, source.replace(/"version":\s*"[^"]+"/, `"version": "${version}"`));
  console.log(`  ${path}: ${was} → ${version}`);
}

write(CHANGELOG, changelog);
console.log(`  ${CHANGELOG}: [${version}] — ${date}, from ${fragments.length} fragment(s)`);
// Known issues are not fixed by the act of releasing: their fragments stay and
// are listed again in the next version, until a fix deletes them.
const released = fragments.filter((fragment) => fragment.type !== 'known-issue');
for (const fragment of released) {
  if (!dryRun) unlinkSync(join(ROOT, FRAGMENTS_DIR, fragment.name));
}
console.log(`  ${FRAGMENTS_DIR}/: ${released.length} fragment(s) released and deleted, ${fragments.length - released.length} known issue(s) kept`);

console.log(dryRun ? '\nDry run: nothing written.' : `\nWritten. Commit it on a release branch and open its pull request:

  git add -A CHANGELOG.md changes ${PACKAGES.join(' ')}
  git commit -m "chore(release): ${version}"

The tag v${version} goes on main once the pull request is merged.
`);
