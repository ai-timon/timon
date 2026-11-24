import { test } from 'node:test';
import assert from 'node:assert/strict';
import { day10, isRealDay, nameDay, resolveCreated } from './vault-disc-dates.js';
import {
  inferType,
  mineLinks,
  paraDirs,
  paraFolder,
  parseFrontmatter,
} from './vault-disc.js';

test('isRealDay refuses Templater placeholders and impossible days', () => {
  assert.equal(isRealDay('2026-08-23'), true);
  assert.equal(isRealDay('{{date:YYY'), false);
  assert.equal(isRealDay('2026-02-31'), false);
  assert.equal(isRealDay('2026-13-01'), false);
});

test('day10 ignores a non-calendar date', () => {
  assert.equal(day10('2026-08-23'), '2026-08-23');
  assert.equal(day10('{{date:YYYY-MM-DD}}'), '');
});

test('nameDay only takes a date at the head of the file', () => {
  assert.equal(nameDay('2026-08-23'), '2026-08-23');
  assert.equal(nameDay('2026-08-23 Kickoff'), '2026-08-23');
  assert.equal(nameDay('Q3 2026-08-23 review'), '');
});

test('resolveCreated favours the frontmatter, then the name', () => {
  assert.equal(resolveCreated({ created: '2026-01-02' }, '2026-08-23.md', 0, 0).source, 'frontmatter');
  assert.equal(resolveCreated({}, '2026-08-23 note', 0, 0).source, 'filename');
  assert.equal(resolveCreated({}, 'hello', 1_700_000_000_000, 1_700_000_000_000).source, 'stamp');
  assert.equal(resolveCreated({}, 'hello', 0, 0).source, 'none');
});

test('paraFolder / paraDirs respect the date buckets', () => {
  assert.equal(paraFolder('index.md'), '(vault root)');
  assert.equal(paraFolder('journal/2026-08-26.md'), 'journal');
  assert.deepEqual(paraDirs('journal/2026-08/2026-08-26.md'), ['2026-08']);
  assert.deepEqual(paraDirs('journal/2026-08/2026-08-26.md', true), []);
});

test('paraFolder remonte perso hors de wiki', () => {
  assert.equal(paraFolder('wiki/perso/surpoids/glp1-traitement.md'), 'perso');
  assert.equal(paraFolder('wiki/topics/grepai.md'), 'wiki');
  assert.equal(paraFolder('wiki/idees/mail-watch.md'), 'wiki');
  assert.equal(paraFolder('wiki/people/tristan.md'), 'wiki');
  assert.equal(paraFolder('wiki/index.md'), 'wiki');
  // A file at the root of wiki/, not a folder: do not promote.
  assert.equal(paraFolder('wiki/projects.md'), 'wiki');
  assert.deepEqual(paraDirs('wiki/perso/surpoids/glp1-traitement.md'), ['surpoids']);
  assert.deepEqual(paraDirs('wiki/topics/grepai.md'), ['topics']);
  assert.deepEqual(paraDirs('wiki/index.md'), []);
});

test('each project is its own root group', () => {
  assert.equal(paraFolder('wiki/projects/timon/_index.md'), 'timon');
  assert.equal(paraFolder('wiki/projects/example-project/notes/dune.md'), 'example-project');
  assert.deepEqual(paraDirs('wiki/projects/timon/_index.md'), []);
  assert.deepEqual(paraDirs('wiki/projects/example-project/notes/dune.md'), ['notes']);
  // A note set directly in projects/: no folder of its own, it stays in the bucket.
  assert.equal(paraFolder('wiki/projects/prestashop-modules.md'), 'projects');
  assert.deepEqual(paraDirs('wiki/projects/prestashop-modules.md'), []);
});

test('parseFrontmatter lit tags tableau et aliases liste', () => {
  const { fm, body } = parseFrontmatter('---\ntags: [timon, vault]\naliases:\n  - disc\n---\ncorps');
  assert.deepEqual(fm.tags, ['timon', 'vault']);
  assert.deepEqual(fm.aliases, ['disc']);
  assert.equal(body.trim(), 'corps');
});

test('mineLinks ignores fences and resolves heading refs', () => {
  const body = [
    'voir [[timon-memoire#Recall]]',
    '',
    '```',
    '[[faux-lien]]',
    '```',
    '',
    '[note](wiki/topics/kanban.md)',
  ].join('\n');
  assert.deepEqual(mineLinks(body, { person: '[[Ada]]' }), [
    'timon-memoire',
    'wiki/topics/kanban.md',
    'Ada',
  ]);
});

test('inferType reads the named folder, not the date bucket', () => {
  assert.equal(inferType({ type: 'person' }, 'x.md', [], '', () => false), 'person');
  assert.equal(inferType({}, 'journal/2026-08-26.md', ['daily-note'], '', () => false), 'daily');
  assert.equal(
    inferType({}, 'wiki/projects/timon/_index.md', [], '', () => false),
    'timon',
  );
});
