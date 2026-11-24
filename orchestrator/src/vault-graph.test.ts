/**
 * Tests of the wikilink resolution helpers (vault-graph.ts).
 *
 * `node --test --import tsx src/vault-graph.test.ts` (or `npm test`). No
 * disk access: the pure functions are tested, not buildGraph.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractWikilinks, resolveWikilink } from './vault-graph.js';
import type { NoteNode } from './vault-graph.js';

function node(id: string): NoteNode {
  return { id, title: id, folder: '', tags: [], degree: 0, mtime: 0 };
}

test('extractWikilinks strips heading refs and block refs', () => {
  assert.deepEqual(extractWikilinks('voir [[timon-memoire#Recall]]'), ['timon-memoire']);
  assert.deepEqual(extractWikilinks('voir [[timon-memoire^a1b2c3]]'), ['timon-memoire']);
  assert.deepEqual(extractWikilinks('voir [[timon-memoire#Recall|le recall]]'), ['timon-memoire']);
  assert.deepEqual(extractWikilinks('voir [[wiki/topics/kanban#Types]]'), ['wiki/topics/kanban']);
});

test('extractWikilinks leaves simple links intact', () => {
  assert.deepEqual(extractWikilinks('[[a]] et [[b|alias]]'), ['a', 'b']);
  assert.deepEqual(extractWikilinks('rien ici'), []);
});

test('a link with a heading ref resolves to the target note', () => {
  const target = node('wiki/topics/kanban');
  const nodeMap = new Map([[target.id, target]]);
  const basenameIndex = new Map([['kanban', [target.id]]]);

  const [extracted] = extractWikilinks('cf [[kanban#Types de task]]');
  assert.equal(extracted, 'kanban');
  assert.equal(
    resolveWikilink(extracted!, nodeMap, basenameIndex, 'journal/2026-08-04'),
    'wiki/topics/kanban',
  );
});
