/**
 * TIM-0114: PowerShell 5 and conhost print Node's UTF-8 through the OEM code
 * page, so every accent and arrow of the CLI came out as box-drawing garbage.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installConsoleAscii, toConsoleAscii } from '../bin/console-ascii.mjs';

test('symbols get an ASCII look-alike and accents are dropped', () => {
  assert.equal(toConsoleAscii('task 1 → DONE · capacités — “ok” …'), 'task 1 -> DONE - capacites - "ok" ...'); // french-ok-file: accented text the console fold is about
  assert.equal(toConsoleAscii('plain ascii'), 'plain ascii');
  assert.equal(toConsoleAscii('日本語'), '日本語', 'what has no look-alike is left as it is');
});

function fakeStream(isTTY: boolean) {
  const out: unknown[] = [];
  return { isTTY, out, write(chunk: unknown) { out.push(chunk); return true; } };
}

test('an interactive Windows console gets ASCII; pipes, other OSes and the opt-out keep UTF-8', () => {
  const tty = fakeStream(true);
  const piped = fakeStream(false);
  assert.equal(installConsoleAscii({ platform: 'win32', env: {}, streams: [tty, piped] as never }), true);
  tty.write('capacités → ok');
  piped.write('capacités → ok');
  const bytes = Buffer.from('é');
  tty.write(bytes as never);
  assert.deepEqual(tty.out, ['capacites -> ok', bytes], 'a Buffer is passed through');
  assert.deepEqual(piped.out, ['capacités → ok']);

  for (const [platform, env] of [['linux', {}], ['darwin', {}], ['win32', { TIMON_CLI_UNICODE: '1' }]] as const) {
    const s = fakeStream(true);
    assert.equal(installConsoleAscii({ platform, env, streams: [s] as never }), false);
    s.write('é');
    assert.deepEqual(s.out, ['é']);
  }
});
