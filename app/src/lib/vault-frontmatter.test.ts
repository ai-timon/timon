import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVaultNote, wikilinkLabel, wikilinkTarget } from './vault-frontmatter';

test('parseVaultNote reads scalars, inline lists and body', () => {
  const { props, body } = parseVaultNote(
    '---\ntype: topic\ncreated: 2026-04-11\ntags: [recherche, cli]\n---\n\n# GrepAI\n',
  );
  assert.deepEqual(
    props.map((p) => [p.key, p.values, p.list]),
    [
      ['type', ['topic'], false],
      ['created', ['2026-04-11'], false],
      ['tags', ['recherche', 'cli'], true],
    ],
  );
  assert.equal(body, '\n# GrepAI\n');
});

test('parseVaultNote does not break wikilinks on their inner commas', () => {
  const { props } = parseVaultNote(
    '---\nrelated: ["[[claude-code]]", "[[timon/grepai-supervision]]"]\n---\ncorps',
  );
  assert.deepEqual(props[0]?.values, ['[[claude-code]]', '[[timon/grepai-supervision]]']);
});

test('parseVaultNote reads a dash list under a bare key', () => {
  const { props } = parseVaultNote('---\naliases:\n  - disc\n  - disque\n---\ncorps');
  assert.deepEqual(props[0], { key: 'aliases', values: ['disc', 'disque'], list: true });
});

test('parseVaultNote without front matter returns the text intact', () => {
  assert.deepEqual(parseVaultNote('# Titre\ntexte'), { props: [], body: '# Titre\ntexte' });
});

test('wikilinkTarget and wikilinkLabel handle alias and anchor', () => {
  assert.equal(wikilinkTarget('[[timon/_index|TIMON]]'), 'timon/_index');
  assert.equal(wikilinkLabel('[[timon/_index|TIMON]]'), 'TIMON');
  assert.equal(wikilinkTarget('[[note#section]]'), 'note');
  assert.equal(wikilinkTarget('topic'), null);
  assert.equal(wikilinkLabel('topic'), 'topic');
});
