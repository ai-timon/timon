import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LINUX_GLIBC_FLOOR, assertGlibcFloor, compareVersions, newestGlibcRequired } from './glibc-floor.mjs';

// A trimmed `readelf --version-info` of the node-pty of the 0.1.9 Linux package.
const PTY_0_1_9 = `Version needs section '.gnu.version_r' contains 1 entry:
 Addr: 0x0000000000000a10  Offset: 0x00000a10  Link: 4 (.dynstr)
  000000: Version: 1  File: libc.so.6  Cnt: 5
  0x0010:   Name: GLIBC_2.42  Flags: none  Version: 7
  0x0020:   Name: GLIBC_2.34  Flags: none  Version: 6
  0x0030:   Name: GLIBC_2.32  Flags: none  Version: 5
  0x0040:   Name: GLIBC_2.3.4  Flags: none  Version: 4
  0x0050:   Name: GLIBC_2.2.5  Flags: none  Version: 2
`;

test('versions compare numerically, not as text', () => {
  assert.ok(compareVersions('2.42', '2.4') > 0);
  assert.ok(compareVersions('2.3.4', '2.28') < 0);
  assert.equal(compareVersions('2.28', '2.28.0'), 0);
});

test('the newest required glibc is read from the version needs', () => {
  assert.equal(newestGlibcRequired('/pty.node', () => PTY_0_1_9), '2.42');
  assert.equal(newestGlibcRequired('/static', () => 'No version information found in this file.\n'), null);
});

test('an artefact above the floor is refused, one within it passes', () => {
  assert.throws(() => assertGlibcFloor('/pty.node', { read: () => PTY_0_1_9 }), /requires GLIBC_2\.42, newer than the glibc 2\.28/);
  const old = PTY_0_1_9.replace('GLIBC_2.42', 'GLIBC_2.17').replace('GLIBC_2.34', 'GLIBC_2.14').replace('GLIBC_2.32', 'GLIBC_2.4');
  assert.doesNotThrow(() => assertGlibcFloor('/pty.node', { read: () => old }));
  assert.doesNotThrow(() => assertGlibcFloor('/static', { read: () => '' }));
});

test('the floor is the one the requirements promise', () => {
  const requirements = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'public-docs', 'docs', 'installation', 'requirements.md'), 'utf8');
  assert.match(requirements, new RegExp(`glibc ${LINUX_GLIBC_FLOOR.replace('.', '\\.')} or later`));
});
