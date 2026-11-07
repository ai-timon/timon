import assert from 'node:assert/strict';
import test from 'node:test';
import { plainPreview } from './plain-preview';

test('bold, underscore bold and inline code lose their markers, not their words', () => {
  assert.equal(plainPreview('the `codex` CLI was **not found**'), 'the codex CLI was not found');
  assert.equal(plainPreview('__Action needed__: install it'), 'Action needed: install it');
});

test('an unclosed bold marker is dropped', () => {
  assert.equal(plainPreview('fails as soon as it starts. **Action: install'), 'fails as soon as it starts. Action: install');
});

test('line breaks, bullets and a lone star are kept', () => {
  assert.equal(plainPreview('* one\n* two'), '* one\n* two');
  assert.equal(plainPreview('2 * 3 = 6'), '2 * 3 = 6');
});
