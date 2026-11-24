/**
 * Names Windows refuses are recognised on every OS, so a reader can refuse
 * them with a code before a raw `fs` error does it on a tester's machine (TODO #541).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toPosixRelative, windowsSegmentProblem } from './portable-names.js';

test('device names, alternate streams, forbidden characters and trailing dots are refused', () => {
  for (const name of [
    'CON', 'con', 'aux.txt', 'Nul.tar.gz', 'COM1', 'lpt9.js', 'com¹', 'prn .txt',
    'a:b', 'index.js:stream', 'a<b', 'a>b', 'a"b', 'a|b', 'a?b', 'a*b', 'Icon\r', 'tab\tname',
    'trailing.', 'trailing ',
  ]) {
    assert.ok(windowsSegmentProblem(name), JSON.stringify(name));
  }
});

test('ordinary names, and names that only resemble a device, pass', () => {
  for (const name of ['package.json', 'console.js', 'auxiliary', 'com10', 'lpt', 'nul-check.md', '.hidden', 'a b', 'é.txt']) { // french-ok: an accented file name
    assert.equal(windowsSegmentProblem(name), null, name);
  }
});

test('a host-relative path is answered with forward slashes whatever the separator', () => {
  assert.equal(toPosixRelative('docs\\a.md', '\\'), 'docs/a.md');
  assert.equal(toPosixRelative('docs/a.md', '/'), 'docs/a.md');
  // On POSIX a backslash is a character of the name, not a separator.
  assert.equal(toPosixRelative('odd\\name', '/'), 'odd\\name');
});
