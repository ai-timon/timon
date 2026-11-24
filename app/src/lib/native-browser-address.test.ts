import assert from 'node:assert/strict';
import test from 'node:test';
import { addressBarTarget } from './native-browser';

test('a bare host gets https://', () => {
  assert.equal(addressBarTarget('google.fr'), 'https://google.fr');
  assert.equal(addressBarTarget('  www.example.com/a?b=1 '), 'https://www.example.com/a?b=1');
  assert.equal(addressBarTarget('localhost:3000/x'), 'https://localhost:3000/x');
  assert.equal(addressBarTarget('192.168.1.1:8080'), 'https://192.168.1.1:8080');
});

test('an explicit scheme is left for the host to judge', () => {
  assert.equal(addressBarTarget('http://google.fr'), 'http://google.fr');
  assert.equal(addressBarTarget('https://google.fr'), 'https://google.fr');
  assert.equal(addressBarTarget('file:///etc/passwd'), 'file:///etc/passwd');
  assert.equal(addressBarTarget('javascript:alert(1)'), 'javascript:alert(1)');
});

test('free text becomes a search', () => {
  assert.equal(addressBarTarget('météo paris'), 'https://www.google.com/search?q=m%C3%A9t%C3%A9o%20paris'); // french-ok: an accented search, the encoding under test
  assert.equal(addressBarTarget('timon'), 'https://www.google.com/search?q=timon');
});
