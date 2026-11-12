import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAGMENTS_DIR, parseFragment, readFragments, readFragmentsAt, renderFragments, withUnreleased } from './changelog-fragments.mjs';
import { createReleaseNotes, parseChangelog } from '../desktop/scripts/release-notes.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fragment = (type, text, extra = '') => `---\ntype: ${type}\n${extra}---\n${text}\n`;

test('every fragment of the repository is valid, and the changelog has no hand-written Unreleased section', () => {
  readFragments(join(ROOT, FRAGMENTS_DIR));
  assert.doesNotMatch(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), /^## \[Unreleased\]/m);
});

test('a fragment is read from its front matter, and anything else is refused with the reason', () => {
  assert.deepEqual(parseFragment(fragment('fixed', 'It works now.', 'tim: TIM-0068\n'), 'it-works.md'),
    { name: 'it-works.md', type: 'fixed', tim: 'TIM-0068', text: 'It works now.' });
  const refused = [
    ['no-front-matter.md', 'Just text.\n', /front matter/],
    ['bad-type.md', fragment('feature', 'x'), /`type` must be one of/],
    ['bad-tim.md', fragment('fixed', 'x', 'tim: 68\n'), /`tim` must look like/],
    ['unknown-field.md', fragment('fixed', 'x', 'pr: 12\n'), /unknown field `pr`/],
    ['empty.md', fragment('added', ''), /empty/],
    ['list.md', fragment('added', '- one\n- two'), /one entry per fragment/],
    ['inline-tim.md', fragment('fixed', '**TIM-0001** — x'), /put the tester reference in `tim:`/],
    ['Bad Name.md', fragment('fixed', 'x'), /file name/],
  ];
  for (const [name, text, why] of refused) assert.throws(() => parseFragment(text, name), why, name);
});

test('the section reads like the hand-written one: types in order, tester references first in bold', () => {
  const body = renderFragments([
    parseFragment(fragment('known-issue', 'Still broken.'), 'a.md'),
    parseFragment(fragment('fixed', 'Repaired.', 'tim: TIM-0034\n'), 'b.md'),
    parseFragment(fragment('added', 'A new thing,\nover two lines.'), 'c.md'),
  ]);
  assert.equal(body, '### Added\n- A new thing,\n  over two lines.\n\n### Fixed\n- **TIM-0034** — Repaired.\n\n### Known issues\n- Still broken.');
});

test('the release notes of an rc show the fragments as its Unreleased changes', () => {
  const changelog = '# Changelog\n\nIntro.\n\n## [0.1.7] — 2026-11-06\n\n### Added\n- Old thing.\n';
  const merged = withUnreleased(changelog, [parseFragment(fragment('added', 'New thing.'), 'new.md')]);
  assert.deepEqual(parseChangelog(merged).map((entry) => entry.version), ['Unreleased', '0.1.7']);
  const notes = createReleaseNotes(merged, '0.1.8-rc.1');
  assert.equal(notes.entries[0].version, '0.1.8-rc.1');
  assert.match(notes.entries[0].content, /New thing\./);
  assert.equal(withUnreleased(changelog, []), changelog);
});

test('fragments are read from a commit, so a build gets the notes of its own commit', () => {
  const repo = mkdtempSync(join(tmpdir(), 'timon-fragments-git-'));
  try {
    const git = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '-q');
    mkdirSync(join(repo, FRAGMENTS_DIR));
    writeFileSync(join(repo, FRAGMENTS_DIR, 'README.md'), '# not a fragment\n');
    writeFileSync(join(repo, FRAGMENTS_DIR, 'one.md'), fragment('fixed', 'One.'));
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'one');
    const first = git('rev-parse', 'HEAD').stdout.trim();
    writeFileSync(join(repo, FRAGMENTS_DIR, 'two.md'), fragment('added', 'Two.'));
    assert.deepEqual(readFragmentsAt(repo, first).map((f) => f.name), ['one.md']);
    assert.deepEqual(readFragments(join(repo, FRAGMENTS_DIR)).map((f) => f.name), ['one.md', 'two.md']);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test('a release writes the fragments into the version, deletes them and keeps the known issues', () => {
  const copy = mkdtempSync(join(tmpdir(), 'timon-bump-'));
  try {
    mkdirSync(join(copy, 'scripts'));
    mkdirSync(join(copy, 'desktop', 'scripts'), { recursive: true });
    for (const file of ['bump-version.mjs', 'changelog-fragments.mjs']) cpSync(join(ROOT, 'scripts', file), join(copy, 'scripts', file));
    for (const pkg of ['orchestrator', 'app', 'desktop']) {
      mkdirSync(join(copy, pkg), { recursive: true });
      writeFileSync(join(copy, pkg, 'package.json'), '{\n  "name": "x",\n  "version": "0.1.7"\n}\n');
    }
    writeFileSync(join(copy, 'CHANGELOG.md'), '# Changelog\n\nIntro.\n\n## [0.1.7] — 2026-11-06\n\n### Added\n- Old thing.\n');
    mkdirSync(join(copy, FRAGMENTS_DIR));
    writeFileSync(join(copy, FRAGMENTS_DIR, 'README.md'), '# Unreleased changes\n');
    writeFileSync(join(copy, FRAGMENTS_DIR, 'new-thing.md'), fragment('added', 'New thing.'));
    writeFileSync(join(copy, FRAGMENTS_DIR, 'still-broken.md'), fragment('known-issue', 'Still broken.'));

    const bump = (...args) => spawnSync(process.execPath, [join(copy, 'scripts', 'bump-version.mjs'), ...args], { encoding: 'utf8' });
    const dry = bump('patch', '--dry-run');
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(existsSync(join(copy, FRAGMENTS_DIR, 'new-thing.md')), 'a dry run deletes nothing');

    const run = bump('patch');
    assert.equal(run.status, 0, run.stderr);
    const changelog = readFileSync(join(copy, 'CHANGELOG.md'), 'utf8');
    assert.match(changelog, /## \[0\.1\.8\] — \d{4}-\d{2}-\d{2}\n\n### Added\n- New thing\.\n\n### Known issues\n- Still broken\.\n\n## \[0\.1\.7\]/);
    assert.deepEqual(readdirSync(join(copy, FRAGMENTS_DIR)).sort(), ['README.md', 'still-broken.md']);
    assert.match(readFileSync(join(copy, 'desktop', 'package.json'), 'utf8'), /"version": "0\.1\.8"/);

    const nothing = bump('patch');
    assert.equal(nothing.status, 1, 'only known issues left: nothing to release');
    assert.match(nothing.stderr, /no added, fixed or changed entry/);
    assert.match(readFileSync(join(copy, 'orchestrator', 'package.json'), 'utf8'), /"version": "0\.1\.8"/, 'a refused bump writes nothing');
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});
