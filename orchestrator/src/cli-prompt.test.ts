/**
 * What a keypress does at the hidden prompt. A fake terminal rather than a real
 * one, so this runs on every OS; `backend-cli.test.ts` drives a real one on Linux.
 */
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { PROMPT_CANCELLED, readHiddenLine } = await import('../bin/cli-prompt.mjs');

function fakeTerminal() {
  let written = '';
  const input = Object.assign(new EventEmitter(), {
    raw: false,
    setRawMode(on: boolean) { input.raw = on; },
    setEncoding() {},
    resume() {},
    pause() {},
  });
  return {
    input,
    written: () => written,
    prompt: () => readHiddenLine('Key: ', { input, output: { write: (text: string) => { written += text; } } }),
  };
}

async function answerTo(...chunks: string[]) {
  const terminal = fakeTerminal();
  const answer = terminal.prompt();
  for (const chunk of chunks) terminal.input.emit('data', chunk);
  return answer;
}

/** The prompt has neither answered nor been abandoned. */
function assertStillOpen(terminal: ReturnType<typeof fakeTerminal>) {
  assert.equal(terminal.input.raw, true);
  assert.equal(terminal.input.listenerCount('data'), 1);
}

test('Enter hands back what was typed, and the terminal is left as it was found', async () => {
  const terminal = fakeTerminal();
  const answer = terminal.prompt();
  assertStillOpen(terminal);
  terminal.input.emit('data', 'sk-a');
  terminal.input.emit('data', 'bc\r');
  assert.equal(await answer, 'sk-abc');
  assert.equal(terminal.input.raw, false);
  assert.equal(terminal.input.listenerCount('data'), 0);
  assert.equal(terminal.written(), 'Key: \n', 'nothing typed is echoed');
});

test('Backspace erases, and characters beyond ASCII are part of the value', async () => {
  assert.equal(await answerTo('sk-abX\u007fc\bd\n'), 'sk-abd');
  assert.equal(await answerTo('clé-日本\r'), 'clé-日本'); // french-ok: a multi-byte answer
});

test('Ctrl-C cancels at any point, with what was typed thrown away', async () => {
  for (const typed of ['\u0003', 'sk-half\u0003', 'sk-half\u0003rest\r']) {
    const terminal = fakeTerminal();
    const answer = terminal.prompt();
    terminal.input.emit('data', typed);
    await assert.rejects(answer, (error: { code?: string }) => error.code === PROMPT_CANCELLED, JSON.stringify(typed));
    assert.equal(terminal.input.raw, false);
    assert.equal(terminal.input.listenerCount('data'), 0);
  }
});

test('Ctrl-D on an empty line cancels, like the end of the input', async () => {
  for (const typed of ['\u0004', 'x\u007f\u0004']) {
    const terminal = fakeTerminal();
    const answer = terminal.prompt();
    terminal.input.emit('data', typed);
    await assert.rejects(answer, (error: { code?: string }) => error.code === PROMPT_CANCELLED, JSON.stringify(typed));
    assert.equal(terminal.input.raw, false);
    assert.equal(terminal.input.listenerCount('data'), 0);
  }
});

test('Ctrl-D on a line in progress does nothing: a half-typed key is not submitted', async () => {
  const terminal = fakeTerminal();
  const answer = terminal.prompt();
  terminal.input.emit('data', 'sk-a\u0004');
  assertStillOpen(terminal);
  terminal.input.emit('data', '\u0004bc\r');
  assert.equal(await answer, 'sk-abc');
});

test('no control character enters the value', async () => {
  const handled = new Set(['\r', '\n', '\u0003', '\u0004', '\b', '\u007f']);
  const controls: string[] = [];
  for (let code = 0; code <= 0x9f; code++) {
    const ch = String.fromCharCode(code);
    if ((code < 0x20 || code >= 0x7f) && !handled.has(ch)) controls.push(ch);
  }
  for (const ch of controls) {
    assert.equal(await answerTo(`sk-a${ch}bc\r`), 'sk-abc', `U+${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
  }
  // Each key a person may hit by reflex, and what a terminal adds around a paste.
  for (const key of ['\u001b[A', '\u001b[1;5C', '\u001b[15~', '\u001bOP', '\u001b[200~', '\u001b[201~', '\u001b']) {
    assert.equal(await answerTo(`sk-a${key}bc\r`), 'sk-abc', JSON.stringify(key));
    assert.equal(await answerTo('sk-a', key, 'bc\r'), 'sk-abc', JSON.stringify(key));
  }
  // An escape sequence does not swallow the key that follows it.
  assert.equal(await answerTo('sk-abc\u001b\r'), 'sk-abc');
  await assert.rejects(answerTo('sk-abc\u001b\u0003'), (error: { code?: string }) => error.code === PROMPT_CANCELLED);
});
