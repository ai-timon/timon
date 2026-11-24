/**
 * What thirty live mascots cost (docs/AGENT-MASCOT.md, "Coût"): the shared french-ok: the heading of a French internal doc
 * frame of the motion engine, driven for ten seconds of 60 Hz frames, with
 * every DOM write counted. The write count is the bound that holds on any
 * machine; the JavaScript time per frame is printed as a diagnostic (jsdom is
 * slower than a browser at `setAttribute`, so it is an upper bound).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { headLayout } from './mascot-geometry';
import type { MascotState } from './mascot-states';

const SVG = 'http://www.w3.org/2000/svg';

test('thirty busy mascots stay within a few DOM writes each per frame', async (t) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('document', dom.window.document);
  let pending: FrameRequestCallback | null = null;
  install('requestAnimationFrame', (fn: FrameRequestCallback) => { pending = fn; return 1; });
  install('cancelAnimationFrame', () => { pending = null; });
  t.after(() => {
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });

  const { startMascotMotion } = await import('./mascot-motion');
  const doc = dom.window.document;
  let writes = 0;
  const counted = <T extends Element>(el: T): T => {
    const set = el.setAttribute.bind(el);
    el.setAttribute = (name: string, value: string) => { writes += 1; set(name, value); };
    return el;
  };
  const geo = headLayout('squircle').geo;
  // Every state a working agent shows outside the chat; none sleeps (a sleeping one runs no engine at all).
  const states: MascotState[] = ['idle', 'thinking', 'working', 'searching', 'waiting', 'happy'];
  const engines = Array.from({ length: 30 }, (_, i) => {
    const svg = counted(doc.createElementNS(SVG, 'svg') as SVGSVGElement);
    const eyes = counted(doc.createElementNS(SVG, 'g') as SVGGElement);
    const blink = counted(doc.createElementNS(SVG, 'g') as SVGGElement);
    const path = () => counted(doc.createElementNS(SVG, 'path') as SVGPathElement);
    const paths = { L: path(), R: path(), M: path() };
    blink.append(paths.L, paths.R, paths.M);
    eyes.append(blink);
    svg.append(eyes);
    doc.body.append(svg);
    svg.getBoundingClientRect = () => ({ left: i * 40, top: 0, width: 32, height: 32, right: i * 40 + 32, bottom: 32, x: i * 40, y: 0, toJSON: () => ({}) }) as DOMRect;
    return startMascotMotion({ svg, eyes, blink, paths }, geo, 'pill', states[i % states.length]!);
  });

  const FRAMES = 600;
  const start = performance.now();
  let clock = start;
  writes = 0;
  let cpu = 0;
  for (let f = 0; f < FRAMES; f += 1) {
    clock += 1000 / 60;
    // The pointer moves every frame: the worst case for the mascots that follow it.
    dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: (f * 7) % 1200, clientY: 300 }));
    const fn = pending as FrameRequestCallback | null;
    pending = null;
    assert.ok(fn, 'the shared frame keeps running while mascots live');
    const t0 = performance.now();
    fn(clock);
    cpu += performance.now() - t0;
  }
  for (const e of engines) e.dispose();

  const perFrame = writes / FRAMES;
  const msPerFrame = cpu / FRAMES;
  t.diagnostic(`30 mascots, ${FRAMES} frames: ${perFrame.toFixed(1)} DOM writes/frame (${(perFrame / 30).toFixed(2)} per mascot), ${msPerFrame.toFixed(3)} ms of JS/frame in jsdom`);
  // At most: three eye paths while a morph runs, a blink, a gaze — about five per mascot.
  assert.ok(perFrame / 30 <= 5, `writes per mascot per frame: ${(perFrame / 30).toFixed(2)}`);
});
