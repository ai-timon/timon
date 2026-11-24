// french-ok-file: a French message typed around a slash command
import assert from 'node:assert/strict';
import test from 'node:test';
import { applySlash, slashSpanAt } from './slash-caret';

test('the menu opens on a slash that starts a word, wherever the caret is', () => {
  assert.deepEqual(slashSpanAt('/ge', 3), { query: 'ge', start: 0 });
  // The case the popup used to miss entirely.
  assert.deepEqual(slashSpanAt('regarde ça puis /ge', 19), { query: 'ge', start: 16 });
  assert.deepEqual(slashSpanAt('ligne\n/au', 9), { query: 'au', start: 6 });
  assert.deepEqual(slashSpanAt('/', 1), { query: '', start: 0 });
});

test('a slash inside a word is a slash, not a command', () => {
  for (const [text, caret] of [['et/ou', 5], ['src/lib', 7], ['a/b/c', 5]] as const) {
    assert.equal(slashSpanAt(text, caret), null);
  }
  // Past the token: the caret left it, the menu closes.
  assert.equal(slashSpanAt('/geo audite', 11), null);
  // A space in the token ends it too.
  assert.equal(slashSpanAt('/ge o', 5), null);
});

test('accepting replaces the token alone, never the sentence around it', () => {
  const input = 'regarde ça puis /ge et dis-moi';
  const span = slashSpanAt(input, 19)!;
  assert.deepEqual(applySlash(input, 19, span, 'geo'), {
    text: 'regarde ça puis /geo  et dis-moi',
    caret: 21,
  });
  // At the start, the historic case, unchanged.
  assert.deepEqual(applySlash('/ge', 3, slashSpanAt('/ge', 3)!, 'geo'),
    { text: '/geo ', caret: 5 });
});
