#!/usr/bin/env node
/**
 * Changelog fragments: each visible change is a file in `changes/`, and the
 * `Unreleased` section of CHANGELOG.md is computed from them instead of being
 * edited by hand. Every pull request used to add its line at the same place in
 * CHANGELOG.md, so each merge put every other open pull request in conflict;
 * two fragments never touch the same lines.
 *
 * A fragment (`changes/<any-name>.md`):
 *
 *   ---
 *   type: fixed          # added | fixed | changed | known-issue
 *   tim: TIM-0068        # optional tester reference, opens the entry in bold
 *   ---
 *   One or two sentences, from the user's point of view.
 *
 * `scripts/bump-version.mjs` writes the fragments into the new version's
 * section and deletes them, except `known-issue` ones: a known issue stays
 * listed in every release until the pull request that fixes it deletes its
 * fragment (and adds a `fixed` one).
 *
 *   node scripts/changelog-fragments.mjs          # print the Unreleased section
 *   node scripts/changelog-fragments.mjs --check  # validate every fragment
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
/** A git pathspec as much as a folder name: git takes `/` on every OS. */
export const FRAGMENTS_DIR = 'changes';
/** Not a fragment: the folder's own explanation. */
const README = 'README.md';

/** Rendering order, and the heading of each type in CHANGELOG.md. */
export const TYPES = [
  ['added', 'Added'],
  ['fixed', 'Fixed'],
  ['changed', 'Changed'],
  ['known-issue', 'Known issues'],
];
const TYPE_NAMES = new Set(TYPES.map(([type]) => type));
const TIM = /^TIM-\d{4,6}$/;
const NAME = /^[a-z0-9][a-z0-9._-]*\.md$/;

/** One fragment, or a thrown error that names the file and what is wrong. */
export function parseFragment(text, name) {
  const fail = (why) => { throw new Error(`${FRAGMENTS_DIR}/${name}: ${why}`); };
  if (!NAME.test(name)) fail('the file name must be lowercase letters, digits, dots, dashes or underscores, ending in .md');
  const match = String(text).replace(/\r\n?/g, '\n').match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) fail('it must start with a front matter block between two `---` lines');
  const fields = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const field = line.match(/^([a-z-]+):\s*(.*?)\s*(?:#.*)?$/);
    if (!field) fail(`unreadable front matter line: ${JSON.stringify(line)}`);
    if (field[1] in fields) fail(`\`${field[1]}\` is given twice`);
    fields[field[1]] = field[2];
  }
  for (const key of Object.keys(fields)) {
    if (key !== 'type' && key !== 'tim') fail(`unknown field \`${key}\` (only \`type\` and \`tim\`)`);
  }
  if (!TYPE_NAMES.has(fields.type)) fail(`\`type\` must be one of ${[...TYPE_NAMES].join(', ')}`);
  if (fields.tim !== undefined && !TIM.test(fields.tim)) fail('`tim` must look like TIM-0034');
  const body = match[2].trim();
  if (!body) fail('the entry is empty');
  if (/^\s*[-*]\s/m.test(body) || /^#/m.test(body)) fail('one entry per fragment: no list item and no heading in the text');
  if (/^\*\*TIM-\d+\*\*/.test(body)) fail('put the tester reference in `tim:`, not in the text');
  return { name, type: fields.type, tim: fields.tim ?? null, text: body };
}

/** Every fragment of a folder, sorted by file name. */
export function readFragments(dir = join(ROOT, FRAGMENTS_DIR)) {
  let names;
  try { names = readdirSync(dir); } catch { return []; }
  return names.filter((name) => name.endsWith('.md') && name !== README).sort()
    .map((name) => parseFragment(readFileSync(join(dir, name), 'utf8'), name));
}

/** The fragments as they were at a commit: release notes of a build come from its own commit. */
export function readFragmentsAt(root, commit) {
  const run = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const list = run(['ls-tree', '--name-only', `${commit}:${FRAGMENTS_DIR}`]);
  // A commit from before the fragments has no such folder: no Unreleased entry.
  if (list.status !== 0) return [];
  return list.stdout.split('\n').filter((name) => name.endsWith('.md') && name !== README).sort().map((name) => {
    const show = run(['show', `${commit}:${FRAGMENTS_DIR}/${name}`]);
    if (show.status !== 0) throw new Error(`cannot read ${FRAGMENTS_DIR}/${name} at ${commit}: ${show.stderr.trim()}`);
    return parseFragment(show.stdout, name);
  });
}

function item(fragment) {
  const text = fragment.text.replace(/\n/g, '\n  ');
  return fragment.tim ? `- **${fragment.tim}** — ${text}` : `- ${text}`;
}

/** The body of a changelog section: `### Added`, `### Fixed`, … in that order. */
export function renderFragments(fragments) {
  return TYPES.map(([type, heading]) => {
    const items = fragments.filter((fragment) => fragment.type === type).map(item);
    return items.length ? `### ${heading}\n${items.join('\n')}` : '';
  }).filter(Boolean).join('\n\n');
}

/**
 * The changelog as the release tooling reads it: the file, with an
 * `## [Unreleased]` section rendered from the fragments before the first
 * version. Nothing is added when there is no fragment.
 */
export function withUnreleased(changelog, fragments) {
  const body = renderFragments(fragments);
  if (!body) return changelog;
  const section = `## [Unreleased]\n\n${body}\n\n`;
  const at = changelog.search(/^## \[/m);
  return at < 0 ? `${changelog.replace(/\n*$/, '\n\n')}${section}` : `${changelog.slice(0, at)}${section}${changelog.slice(at)}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const fragments = readFragments();
    if (process.argv.includes('--check')) console.log(`${fragments.length} changelog fragment(s), all valid.`);
    else console.log(renderFragments(fragments) || 'No unreleased change.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
