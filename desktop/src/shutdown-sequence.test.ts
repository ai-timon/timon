import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ErrorBoxGate, quitAfterBox, type ShutdownWindow } from './shutdown-sequence.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeWindow(label: string, events: string[], opts: { neverCloses?: boolean } = {}): ShutdownWindow {
  let alive = true;
  const closed = deferred();
  return {
    label,
    alive: () => alive,
    close: () => {
      events.push(`close ${label}`);
      if (opts.neverCloses) return;
      alive = false;
      queueMicrotask(() => { events.push(`closed ${label}`); closed.resolve(); });
    },
    closed: () => closed.promise,
  };
}

test('TODO #478: box, then each window, then quit — the clipboard is written before anything is destroyed', async () => {
  const events: string[] = [];
  const log: string[] = [];
  await quitAfterBox({
    box: async () => { events.push('box shown'); events.push('clipboard written'); events.push('box closed'); },
    windows: () => [fakeWindow('update window', events), fakeWindow('main window', events)],
    quit: () => events.push('quit'),
    log: (line) => log.push(line),
  });
  assert.deepEqual(events, [
    'box shown', 'clipboard written', 'box closed',
    'close update window', 'closed update window',
    'close main window', 'closed main window',
    'quit',
  ]);
  assert.deepEqual(log, [
    '[desktop] shutdown: error box shown, nothing closes until it is dismissed',
    '[desktop] shutdown: error box closed',
    '[desktop] shutdown: closing the update window',
    '[desktop] shutdown: update window closed',
    '[desktop] shutdown: closing the main window',
    '[desktop] shutdown: main window closed',
    '[desktop] shutdown: app.quit()',
  ]);
});

test('the windows are read once the box is closed, and a window already gone is skipped', async () => {
  const events: string[] = [];
  let read = 0;
  const gone: ShutdownWindow = { label: 'gone', alive: () => false, close: () => events.push('close gone'), closed: () => Promise.resolve() };
  await quitAfterBox({
    box: async () => { assert.equal(read, 0, 'windows listed before the box closed'); },
    windows: () => { read += 1; return [gone, fakeWindow('main window', events)]; },
    quit: () => events.push('quit'),
    log: () => {},
  });
  assert.deepEqual(events, ['close main window', 'closed main window', 'quit']);
});

test('a window that never closes does not hold the quit, and a failing box still quits', async () => {
  const events: string[] = [];
  const log: string[] = [];
  await quitAfterBox({
    box: async () => { throw new Error('no display'); },
    windows: () => [fakeWindow('main window', events, { neverCloses: true })],
    quit: () => events.push('quit'),
    log: (line) => log.push(line),
    closeTimeoutMs: 5,
  });
  assert.deepEqual(events, ['close main window', 'quit']);
  assert.ok(log.includes('[desktop] shutdown: error box failed (no display), closing anyway'), log.join('\n'));
  assert.ok(log.includes('[desktop] shutdown: main window did not close in time, quitting anyway'), log.join('\n'));
});

test('a quit asked while a box is open waits for the last box, then runs once', async () => {
  const quits: string[] = [];
  const log: string[] = [];
  const gate = new ErrorBoxGate((line) => log.push(line), () => quits.push('quit'));
  assert.equal(gate.deferQuit(), false, 'no box: the quit goes through');
  const first = deferred();
  const second = deferred();
  const a = gate.hold(() => first.promise);
  const b = gate.hold(() => second.promise);
  assert.equal(gate.busy, true);
  assert.equal(gate.deferQuit(), true);
  assert.equal(gate.deferQuit(), true, 'asked twice, still one deferred quit');
  first.resolve();
  await a;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(quits, [], 'one box is still open');
  second.resolve();
  await b;
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(quits, ['quit']);
  assert.equal(gate.busy, false);
  assert.equal(log.filter((line) => /deferred until it closes/.test(line)).length, 1);
});

test('a window destroyed while a box is open waits for it; a rejected box still releases the gate', async () => {
  const events: string[] = [];
  const gate = new ErrorBoxGate(() => {}, () => {});
  gate.whenIdle('closing nothing', () => events.push('now'));
  assert.deepEqual(events, ['now'], 'no box: immediate');
  const box = deferred();
  const held = gate.hold(async () => { await box.promise; throw new Error('box crashed'); });
  gate.whenIdle('closing the update window', () => events.push('update window destroyed'));
  assert.deepEqual(events, ['now']);
  box.resolve();
  await assert.rejects(held, /box crashed/);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(events, ['now', 'update window destroyed']);
});

// The wiring lives in main.ts, which cannot load outside Electron: these guards read it.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');

test('main.ts: "Startup failed" goes through the box-then-quit sequence, with no bare quit after the box', () => {
  const start = source.indexOf("app.whenReady().then(main).catch(");
  const end = source.indexOf("app.on('window-all-closed'", start);
  const handler = source.slice(start, end);
  assert.match(handler, /await reportProblemThenQuit\(/);
  assert.doesNotMatch(handler, /app\.quit\(\)/);
  assert.doesNotMatch(handler, /updateWindow\?\.close\(\)/);
});

test('main.ts: every error box is held by the gate and gets the window on screen as parent', () => {
  assert.match(source, /async function reportProblem\(box: [^)]*, parent: BrowserWindow \| null = problemParent\(\)\)/);
  assert.match(source, /await errorBoxes\.hold\(\(\) => showProblem\(/);
  assert.match(source, /candidate && !candidate\.isDestroyed\(\) && candidate\.isVisible\(\)/);
});

test('main.ts: before-quit asks the gate first; the update window waits for an open box', () => {
  assert.match(source, /app\.on\('before-quit', \(event\) => \{\s*console\.log\('\[desktop\] shutdown: before-quit'\);\s*if \(errorBoxes\.deferQuit\(\)\) \{ event\.preventDefault\(\); return; \}/);
  assert.match(source, /errorBoxes\.whenIdle\('closing the update window', \(\) => completed\.close\(\)\)/);
  assert.match(source, /app\.on\('will-quit'/);
  assert.match(source, /app\.on\('quit'/);
});

test('main.ts: no reportProblem is followed by a bare app.quit()', () => {
  assert.doesNotMatch(source, /await reportProblem\([^;]*;\s*app\.quit\(\)/);
});
