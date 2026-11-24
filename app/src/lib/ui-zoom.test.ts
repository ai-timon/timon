import assert from 'node:assert/strict';
import test from 'node:test';
import { cachedUiZoom, formatUiZoom, readUiZoom, resetUiZoomForTests, setUiZoom, stepUiZoom, subscribeUiZoom, UI_ZOOM_STEPS } from './ui-zoom';

type Globals = { window?: unknown };
const g = globalThis as unknown as Globals;

/**
 * A page of a desktop shell holding `factor`, announcing each change the way
 * the preload does. `blink` is the factor Blink has laid the page out at, read
 * by `zoom.current()`; `null` leaves `current` out, like an older desktop.
 */
function shell(factor: number, steps: unknown = [...UI_ZOOM_STEPS], blink: number | null = null) {
  const state = { factor, blink, listeners: new Set<(factor: number) => void>(), calls: [] as unknown[] };
  const announce = (next: number) => { state.factor = next; for (const listener of state.listeners) listener(next); };
  const zoom: Record<string, unknown> = {
    get: async () => ({ factor: state.factor, steps }),
    set: async (next: number) => { state.calls.push(['set', next]); announce(next); return { factor: next }; },
    step: async (direction: string) => { state.calls.push(['step', direction]); const next = direction === 'reset' ? 1 : 1.1; announce(next); return { factor: next }; },
    onChange: (listener: (factor: number) => void) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
  };
  if (blink !== null) zoom.current = () => state.blink;
  g.window = { timonDesktop: { restartAfterSetup: async () => {}, zoom } };
  return { state, announce };
}

test.afterEach(() => {
  resetUiZoomForTests();
  delete g.window;
});

test('the web, the PWA and an older desktop offer no interface size, and measure at 100 %', async () => {
  assert.equal(await readUiZoom(), null);
  g.window = { timonDesktop: { restartAfterSetup: async () => {} } };
  assert.equal(await readUiZoom(), null);
  assert.equal(await setUiZoom(1.25), null);
  assert.equal(await stepUiZoom('in'), null);
  assert.equal(cachedUiZoom(), 1);
  const stop = subscribeUiZoom(() => assert.fail('nothing to hear'));
  stop();
});

test('a failing shell reads as no setting at all', async () => {
  g.window = {
    timonDesktop: {
      restartAfterSetup: async () => {},
      zoom: {
        get: async () => { throw new Error("No handler registered for 'timon:ui-zoom-get'"); },
        set: async () => { throw new Error('refused'); },
        step: async () => ({ factor: 'big' }),
        onChange: () => () => {},
      },
    },
  };
  assert.equal(await readUiZoom(), null);
  assert.equal(await setUiZoom(1.25), null);
  assert.equal(await stepUiZoom('in'), null);
  assert.equal(cachedUiZoom(), 1);
});

test('the size and its stops come from the shell, and are cached for the next measure', async () => {
  shell(1.25);
  assert.deepEqual(await readUiZoom(), { factor: 1.25, steps: [...UI_ZOOM_STEPS] });
  assert.equal(cachedUiZoom(), 1.25);
  resetUiZoomForTests();
  shell(1.5, 'not a list');
  assert.deepEqual(await readUiZoom(), { factor: 1.5, steps: UI_ZOOM_STEPS }, 'a partial answer falls back to the known stops');
});

test('a change made anywhere (another window, the keys, the menu) reaches every subscriber at once', async () => {
  const { announce } = shell(1);
  const heard: number[] = [];
  const stop = subscribeUiZoom((factor) => heard.push(factor));
  announce(1.2);
  assert.equal(cachedUiZoom(), 1.2, 'cached before the resize the zoom causes');
  announce(1.2);
  assert.deepEqual(heard, [1.2], 'the same size is heard once');
  stop();
  announce(1.5);
  assert.deepEqual(heard, [1.2]);
  assert.equal(cachedUiZoom(), 1.5, 'the cache keeps following with no subscriber');
});

test('setting and stepping ask the shell and keep what it settled on', async () => {
  const { state } = shell(1);
  const heard: number[] = [];
  subscribeUiZoom((factor) => heard.push(factor));
  assert.equal(await setUiZoom(1.25), 1.25);
  assert.equal(await stepUiZoom('in'), 1.1);
  assert.equal(await stepUiZoom('reset'), 1);
  assert.deepEqual(state.calls, [['set', 1.25], ['step', 'in'], ['step', 'reset']]);
  assert.deepEqual(heard, [1.25, 1.1, 1]);
  assert.equal(cachedUiZoom(), 1);
});

test('a size reads as a whole percentage', () => {
  assert.equal(formatUiZoom(1), '100%');
  assert.equal(formatUiZoom(1.25), '125%');
  assert.equal(formatUiZoom(1.33), '133%');
  assert.equal(formatUiZoom(0.8), '80%');
});

test('with Blink\'s own factor, a measure taken before the shell first answers already uses it', async () => {
  for (const blink of [0.8, 0.9]) {
    resetUiZoomForTests();
    const { state } = shell(blink, undefined, blink);
    let answer!: () => void;
    const held = new Promise<void>((resolve) => { answer = resolve; });
    const zoom = (g.window as { timonDesktop: { zoom: { get: () => Promise<unknown> } } }).timonDesktop.zoom;
    const get = zoom.get;
    zoom.get = async () => { await held; return get(); };
    const reading = readUiZoom();
    assert.equal(cachedUiZoom(), blink, `${blink}: the layout\'s factor, not 100 %, before readUiZoom() resolves`);
    answer();
    assert.deepEqual(await reading, { factor: state.factor, steps: [...UI_ZOOM_STEPS] });
    assert.equal(cachedUiZoom(), blink);
  }
});

test('with Blink\'s own factor, rapid changes measure at the factor the layout has, not the last one announced', async () => {
  const { announce, state } = shell(1, undefined, 1);
  await readUiZoom();
  const heard: number[] = [];
  subscribeUiZoom((factor) => heard.push(factor));
  announce(1.1);
  state.blink = 1.1;
  // 1.2 is announced while Blink still lays the page out at 1.1.
  announce(1.2);
  assert.equal(cachedUiZoom(), 1.1, 'the factor of the layout, whatever was heard last');
  assert.deepEqual(heard, [1.1, 1.2], 'subscribers still hear every change at once');
  state.blink = 1.2;
  assert.equal(cachedUiZoom(), 1.2);
});

test('an older desktop without current() falls back to the last factor the shell announced', async () => {
  const { announce } = shell(1.25);
  assert.equal(cachedUiZoom(), 1, 'nothing heard yet');
  await readUiZoom();
  assert.equal(cachedUiZoom(), 1.25);
  announce(0.9);
  assert.equal(cachedUiZoom(), 0.9);
});

test('a Blink factor that cannot be read falls back to the announced one', async () => {
  const { state } = shell(1.5, undefined, 1.5);
  await readUiZoom();
  state.blink = Number.NaN;
  assert.equal(cachedUiZoom(), 1.5);
});

test('setting or stepping alone follows the shell from then on', async () => {
  const { announce } = shell(1);
  assert.equal(await stepUiZoom('in'), 1.1);
  announce(1.5);
  assert.equal(cachedUiZoom(), 1.5, 'listening since the step');
  resetUiZoomForTests();
  const second = shell(1);
  assert.equal(await setUiZoom(1.25), 1.25);
  second.announce(0.8);
  assert.equal(cachedUiZoom(), 0.8, 'listening since the set');
});
