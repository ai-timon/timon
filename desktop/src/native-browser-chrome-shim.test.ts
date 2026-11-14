import assert from 'node:assert/strict';
import test from 'node:test';
import { createContext, runInContext, type Context } from 'node:vm';
import { CHROME_SHIM_SOURCE } from './native-browser-chrome-shim.js';

/** A realm of its own, whose global is also `window`, as in a page. */
function page(setup = ''): Context {
  const context = createContext({ performance: { now: () => 12.5 } });
  runInContext(`globalThis.window = globalThis; ${setup}`, context);
  return context;
}

const run = (context: Context, expression: string): unknown => runInContext(expression, context);
/** As JSON: an array of another realm is never deep-equal to one of this realm. */
const keys = (context: Context): unknown => JSON.parse(String(runInContext('JSON.stringify(Object.keys(window.chrome))', context)));
const shim = (context: Context): void => { runInContext(CHROME_SHIM_SOURCE, context); };

test('an empty window.chrome gets loadTimes, csi and app, as Chrome has them', () => {
  const context = page('window.chrome = {};');
  shim(context);
  assert.deepEqual(keys(context), ['loadTimes', 'csi', 'app']);
  assert.equal(run(context, 'typeof chrome.loadTimes().requestTime'), 'number');
  assert.equal(run(context, 'chrome.loadTimes().connectionInfo'), 'h2');
  assert.equal(run(context, 'chrome.csi().pageT'), 12.5);
  assert.equal(run(context, 'chrome.app.isInstalled'), false);
  assert.equal(run(context, 'chrome.app.getIsInstalled()'), false);
  assert.equal(run(context, 'chrome.app.getDetails()'), null);
  assert.equal(run(context, 'chrome.app.runningState()'), 'cannot_run');
  assert.equal(run(context, 'chrome.app.InstallState.NOT_INSTALLED'), 'not_installed');
  assert.equal(run(context, 'chrome.app.RunningState.READY_TO_RUN'), 'ready_to_run');
});

test('a page without window.chrome gets one', () => {
  const context = page();
  shim(context);
  assert.deepEqual(keys(context), ['loadTimes', 'csi', 'app']);
});

test('the functions are named, without prototype and not constructible, like native ones', () => {
  const context = page('window.chrome = {};');
  shim(context);
  for (const path of ['chrome.loadTimes', 'chrome.csi', 'chrome.app.getDetails', 'chrome.app.getIsInstalled', 'chrome.app.runningState']) {
    const name = path.split('.').at(-1)!;
    assert.equal(run(context, `${path}.name`), name);
    assert.equal(run(context, `${path}.prototype`), undefined, `${path} has no prototype`);
    assert.throws(() => run(context, `new ${path}()`), /not a constructor/);
  }
});

test('the toString of an added function answers as native code; the page keeps its own sources', () => {
  const context = page('window.chrome = {}; function mine() { return 1; }');
  shim(context);
  assert.equal(run(context, 'chrome.loadTimes.toString()'), 'function loadTimes() { [native code] }');
  assert.equal(run(context, 'Function.prototype.toString.call(chrome.csi)'), 'function csi() { [native code] }');
  assert.equal(run(context, 'String(chrome.app.runningState)'), 'function runningState() { [native code] }');
  assert.equal(run(context, 'Function.prototype.toString.toString()'), 'function toString() { [native code] }');
  assert.equal(run(context, 'mine.toString()'), 'function mine() { return 1; }');
  assert.equal(run(context, 'Math.max.toString()'), 'function max() { [native code] }');
  assert.throws(() => run(context, 'Function.prototype.toString.call({})'), { name: 'TypeError' });
});

test('a second run replaces nothing and wraps toString no further', () => {
  const context = page('window.chrome = {};');
  shim(context);
  run(context, 'globalThis.first = { loadTimes: chrome.loadTimes, app: chrome.app, toString: Function.prototype.toString }');
  shim(context);
  assert.equal(run(context, 'chrome.loadTimes === first.loadTimes && chrome.app === first.app'), true);
  assert.equal(run(context, 'Function.prototype.toString === first.toString'), true);
  assert.deepEqual(keys(context), ['loadTimes', 'csi', 'app']);
});

test('what already exists stays, and a complete window.chrome is left alone', () => {
  const partial = page('window.chrome = { app: { mine: true }, runtime: {} };');
  shim(partial);
  assert.equal(run(partial, 'chrome.app.mine'), true);
  assert.equal(run(partial, 'typeof chrome.loadTimes'), 'function');
  assert.deepEqual(keys(partial), ['app', 'runtime', 'loadTimes', 'csi']);

  const complete = page('window.chrome = { loadTimes() {}, csi() {}, app: {} }; globalThis.before = Function.prototype.toString;');
  shim(complete);
  assert.equal(run(complete, 'Function.prototype.toString === before'), true, 'toString is not touched');
  assert.equal(run(complete, 'chrome.loadTimes.toString()'), 'loadTimes() {}');
});
