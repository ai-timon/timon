import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { lineTail, superviseChild, wakeSupervisor } from './child-supervisor.js';

test('the tail keeps the last lines, across chunks, oldest first', () => {
  const tail = lineTail(2);
  tail.push('one\ntw');
  tail.push('o\n\nthree\nfou');
  assert.deepEqual(tail.lines(), ['three', 'fou']);
});

test('a failed exit carries the last stderr lines of the child (Next code 1, TODO #343)', { timeout: 20_000 }, async () => {
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  let stop: (() => void) | undefined;
  try {
    const host = { spawn: (name: string, args: string[], opts: object) => spawn(name, args, opts) };
    stop = superviseChild(host as never, {
      label: 'fake-next',
      command: process.execPath,
      args: ['-e', "console.error('Error: Cannot find module next'); console.error('at boot'); process.exit(1)"],
      spawn: { stdio: 'inherit', env: { ...process.env } },
      outputTail: 5,
    });
    const deadline = Date.now() + 15_000;
    while (!warnings.some((line) => line.includes('process exit')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } finally {
    stop?.();
    console.warn = realWarn;
  }
  const exit = warnings.find((line) => line.includes('process exit'));
  assert.ok(exit, warnings.join('\n'));
  assert.match(exit, /code 1.*last stderr: Error: Cannot find module next \| at boot/);
});

type Fake = EventEmitter & { pid: number; kill: () => boolean };

/** A host whose children never run: each spawn hands back an emitter the test drives. */
function fakeSpawner() {
  const children: Fake[] = [];
  const host = {
    spawn: () => {
      const child = Object.assign(new EventEmitter(), { pid: 1000 + children.length, kill: () => true }) as Fake;
      children.push(child);
      return child;
    },
  };
  return { host, children };
}

function quiet(): () => void {
  const saved = [console.log, console.warn, console.error];
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  return () => { [console.log, console.warn, console.error] = saved; };
}

test('TODO #485: wake rearms a supervisor that gave up after rapid falls, from zero', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  const stop = superviseChild(host as never, { label: 'wake-loop', command: 'x', args: [], spawn: {}, alert: null });
  try {
    for (const delay of [2_000, 4_000, 8_000, 16_000, 30_000]) {
      children.at(-1)!.emit('exit', 1, null);
      t.mock.timers.tick(delay);
    }
    children.at(-1)!.emit('exit', 1, null);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 6, 'gave up');

    assert.equal(wakeSupervisor('wake-loop'), 'rearmed');
    assert.equal(children.length, 7, 'started at once');
    assert.equal(wakeSupervisor('wake-loop'), 'running');
    // Counters start over: the first fall retries after 2 s again.
    children.at(-1)!.emit('exit', 1, null);
    t.mock.timers.tick(2_000);
    assert.equal(children.length, 8);
  } finally { stop(); restore(); t.mock.timers.reset(); }
});

test('TODO #485: wake rearms a supervisor stopped by clean exits', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  const stop = superviseChild(host as never, { label: 'wake-clean', command: 'x', args: [], spawn: {}, alert: null, cleanExit: 'stop' });
  try {
    children[0]!.emit('exit', 0, null);
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 1);
    assert.equal(wakeSupervisor('wake-clean'), 'rearmed');
    assert.equal(children.length, 2);
  } finally { stop(); restore(); t.mock.timers.reset(); }
});

test('TODO #551: clean exits days apart never use up the retries; exits minutes apart still do (TIM-0011)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  const stop = superviseChild(host as never, {
    label: 'clean-budget', command: 'x', args: [], spawn: {}, alert: null, cleanExit: 'stop', cleanExitRetries: 2,
  });
  try {
    for (let i = 0; i < 5; i++) {
      t.mock.timers.tick(86_400_000); // the app ran a day
      children.at(-1)!.emit('exit', 0, null);
      t.mock.timers.tick(30_000);
    }
    assert.equal(children.length, 6, 'every isolated exit was restarted');
    // The last day-long exit counts as the first; two more after a few minutes each stop it.
    for (let i = 0; i < 2; i++) {
      t.mock.timers.tick(120_000);
      children.at(-1)!.emit('exit', 0, null);
      t.mock.timers.tick(30_000);
    }
    assert.equal(children.length, 7, 'the third clean exit within the hour stops it');
  } finally { stop(); restore(); t.mock.timers.reset(); }
});

test('TODO #485: wake brings a pending retry or port check forward, without a second start', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  let busy = true;
  const stop = superviseChild(host as never, {
    label: 'wake-wait', command: 'x', args: [], spawn: {}, alert: null,
    beforeStart: () => (busy ? 'port occupied' : undefined),
  });
  try {
    assert.equal(children.length, 0);
    busy = false;
    assert.equal(wakeSupervisor('wake-wait'), 'woken');
    assert.equal(children.length, 1);
    // The cancelled timer must not fire a second start.
    t.mock.timers.tick(120_000);
    assert.equal(children.length, 1);
    children[0]!.emit('exit', 1, null);
    assert.equal(wakeSupervisor('wake-wait'), 'woken');
    assert.equal(children.length, 2);
  } finally { stop(); restore(); t.mock.timers.reset(); }
});

test('TODO #485: an asynchronous start check in flight is not doubled', async () => {
  const restore = quiet();
  const { host, children } = fakeSpawner();
  let release!: (why: string | undefined) => void;
  const stop = superviseChild(host as never, {
    label: 'wake-async', command: 'x', args: [], spawn: {}, alert: null,
    beforeStart: () => new Promise<string | undefined>((resolve) => { release = resolve; }),
  });
  try {
    assert.equal(wakeSupervisor('wake-async'), 'starting');
    release(undefined);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(children.length, 1);
  } finally { stop(); restore(); }
});

test('TODO #485: a disposed supervisor leaves the registry and is never woken', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  const stop = superviseChild(host as never, { label: 'wake-gone', command: 'x', args: [], spawn: {}, alert: null });
  stop();
  try {
    assert.equal(wakeSupervisor('wake-gone'), 'unknown');
    assert.equal(wakeSupervisor('never-registered'), 'unknown');
    assert.equal(children.length, 1);
  } finally { restore(); t.mock.timers.reset(); }
});

test('TODO #485: disposing an old supervisor keeps the newer one under the same label', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const first = fakeSpawner();
  const second = fakeSpawner();
  const stopFirst = superviseChild(first.host as never, { label: 'wake-twice', command: 'x', args: [], spawn: {}, alert: null });
  const stopSecond = superviseChild(second.host as never, { label: 'wake-twice', command: 'x', args: [], spawn: {}, alert: null });
  try {
    stopFirst();
    assert.equal(wakeSupervisor('wake-twice'), 'running');
  } finally { stopSecond(); restore(); t.mock.timers.reset(); }
});

test('giving up hands the alert its coded message, built from the same cause as its English', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const restore = quiet();
  const { host, children } = fakeSpawner();
  const causes: string[] = [];
  const stop = superviseChild(host as never, {
    label: 'coded-alert', command: 'x', args: [], spawn: {}, cleanExit: 'stop',
    alert: { title: 'stopped', body: (why) => why, message: (why) => { causes.push(why); return { code: 'web_app_clean_exit', params: { why } }; } },
  });
  try {
    children.at(-1)!.emit('exit', 0, null);
    assert.equal(causes.length, 1);
    assert.match(causes[0]!, /clean exit/);
  } finally { stop(); restore(); t.mock.timers.reset(); }
});
