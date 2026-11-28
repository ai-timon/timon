import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitLinks } from './linkify';

test('a URL at the end of a sentence drops the final punctuation', () => {
  assert.deepEqual(splitLinks('MR opened: https://gitlab.example/mr/1875.'), [
    { kind: 'text', text: 'MR opened: ' },
    { kind: 'link', text: 'https://gitlab.example/mr/1875', href: 'https://gitlab.example/mr/1875' },
    { kind: 'text', text: '.' },
  ]);
  assert.equal(splitLinks('(see https://a.io/x),')[1]?.text, 'https://a.io/x');
});

test('several URLs become several links', () => {
  const links = splitLinks('a http://x.io/1 and https://y.io/2; done').filter((p) => p.kind === 'link');
  assert.deepEqual(links.map((l) => l.text), ['http://x.io/1', 'https://y.io/2']);
});

test('text without a URL is one text part', () => {
  assert.deepEqual(splitLinks('nothing here'), [{ kind: 'text', text: 'nothing here' }]);
  assert.deepEqual(splitLinks(''), []);
});

test('a non-http scheme is ignored', () => {
  assert.deepEqual(splitLinks('javascript:alert(1) ftp://x.io file:///etc/passwd'), [
    { kind: 'text', text: 'javascript:alert(1) ftp://x.io file:///etc/passwd' },
  ]);
});
