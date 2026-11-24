// The writer (memory-promote.ts) and the reader (memory-view.ts) of
// proposals.md must agree on the target line: when #628 translated it, the
// reader still looked for the French label and every new proposal reached the
// Memory page without its target file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proposalBlock } from './memory-promote.js';
import { parseProposals } from './memory-view.js';

test('a block written by the promotion scan is read back with its target', () => {
  const block = proposalBlock(
    { hash: 'abc123', kind: 'pitfall', count: 4, agent: 'timon.coder', text: 'Never kill 0 in a trap' },
    '2026-10-31T00:00:00.000Z',
  );
  const [p] = parseProposals('\n' + block + '\n');
  assert.ok(p, 'the block must be parsed');
  assert.equal(p.text, 'Never kill 0 in a trap');
  assert.notEqual(p.target, '');
  assert.match(block, new RegExp(p.target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a block written before #628, with the French label, keeps its target', () => {
  const legacy =
    '<!-- proposal hash:def456 kind:decision count:3 agent:timon.coder ts:2026-09-01T00:00:00.000Z -->\n' +
    '- [decision ×3] Use node:path everywhere\n' +
    '  → cible suggérée : `decisions.md`\n' + // french-ok: the French line of the legacy proposal format
    '<!-- /proposal hash:def456 -->';
  const [p] = parseProposals(legacy);
  assert.equal(p?.target, 'decisions.md');
});
