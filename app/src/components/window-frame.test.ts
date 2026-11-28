/**
 * The top bar as the window's title bar, in a desktop window without the
 * system's: the buttons it draws, the room it keeps for them, its drag areas.
 * In a plain browser nothing of it exists.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';

Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

const DRAWN = { controls: 'drawn' as const, maximized: false, fullScreen: false, machineName: 'Office VPS', active: true };

test('the buttons are the system\'s three, labelled, and the middle one follows the window', async () => {
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { WindowControls } = await import('./window-frame');
  const html = renderToStaticMarkup(React.createElement(WindowControls, { state: DRAWN }));
  assert.match(html, /role="group" aria-label="Window controls"/);
  const labels = [...html.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(labels, ['Minimize', 'Maximize', 'Close']);
  assert.match(html, /hover:bg-destructive/, 'close warns in the theme\'s own colour');
  const maximized = renderToStaticMarkup(React.createElement(WindowControls, { state: { ...DRAWN, maximized: true } }));
  assert.deepEqual([...maximized.matchAll(/aria-label="([^"]+)"/g)].map((match) => match[1]).slice(1), ['Minimize', 'Restore down', 'Close']);
  const full = renderToStaticMarkup(React.createElement(WindowControls, { state: { ...DRAWN, fullScreen: true } }));
  assert.deepEqual([...full.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((match) => match[1]), ['Exit full screen'], 'in full screen, only the way out');
});

async function withDom(t: test.TestContext, bridge: unknown) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  if (bridge) Object.defineProperty(dom.window, 'timonDesktop', { value: { restartAfterSetup: async () => {}, windowFrame: bridge }, configurable: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MouseEvent', 'KeyboardEvent', 'FocusEvent', 'CustomEvent', 'NodeFilter', 'HTMLInputElement', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'IS_REACT_ACT_ENVIRONMENT']) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    const value = key === 'window' ? dom.window : key === 'IS_REACT_ACT_ENVIRONMENT' ? true : Reflect.get(dom.window, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void) => React.act(async () => { fn(); });
  t.after(async () => {
    await act(() => root.unmount());
    // Radix's focus scope dispatches its unmount event on a timer, which must run while the jsdom globals are still installed.
    await new Promise((resolve) => setTimeout(resolve, 0));
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return { dom, root, act };
}

function fakeShell(state: Record<string, unknown>) {
  const acted: string[] = [];
  let listener: ((state: unknown) => void) | null = null;
  return {
    acted,
    announce: (next: Record<string, unknown>) => listener?.(next),
    bridge: {
      get: async () => state,
      act: async (action: string) => { acted.push(action); },
      onChange: (fn: (state: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    },
  };
}

test('in a browser the page carries no frame, no strip and no button', async (t) => {
  const { dom, root, act } = await withDom(t, null);
  const { WindowFrame } = await import('./window-frame');
  await act(() => root.render(React.createElement(WindowFrame)));
  const html = dom.window.document.documentElement;
  assert.equal(html.hasAttribute('data-timon-frame'), false);
  assert.equal(html.hasAttribute('data-timon-drag'), false);
  assert.ok(!dom.window.document.querySelector('.timon-window-strip'));
  assert.ok(!dom.window.document.querySelector('button'));
});

test('a frameless window gets its drag strip first and its buttons last, and the buttons act on it', async (t) => {
  const shell = fakeShell({ frameless: true, ...DRAWN });
  const { dom, root, act } = await withDom(t, shell.bridge);
  const { WindowFrame } = await import('./window-frame');
  const doc = dom.window.document;
  doc.body.insertAdjacentHTML('beforeend', '<header class="timon-topbar-bar"><button>page control</button></header>');
  await act(() => root.render(React.createElement(WindowFrame)));
  await act(() => {});
  assert.equal(doc.documentElement.getAttribute('data-timon-frame'), 'drawn');
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), true);
  const strip = doc.querySelector('.timon-window-strip')!;
  const controls = doc.querySelector('.timon-window-controls')!;
  assert.ok(strip && controls);
  assert.equal(controls.parentElement, doc.body, 'the buttons are portalled to <body>');
  assert.equal(doc.body.lastElementChild, controls, 'after every drag area of the page');
  assert.ok(strip.compareDocumentPosition(doc.querySelector('header')!) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, 'the strip precedes the page');
  const button = (label: string) => doc.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  await act(() => button('Maximize').click());
  await act(() => button('Close').click());
  assert.deepEqual(shell.acted, ['toggle-maximize', 'close']);
  await act(() => shell.announce({ frameless: true, ...DRAWN, maximized: true }));
  assert.ok(button('Restore down'), 'maximized by the shell, whoever asked');
  await act(() => shell.announce({ frameless: true, ...DRAWN, fullScreen: true }));
  assert.equal(doc.documentElement.getAttribute('data-timon-frame'), 'drawn-full-screen');
  assert.ok(button('Exit full screen'));
});

test('a page the shell hides drops its drag areas, and takes them back on screen', async (t) => {
  const shell = fakeShell({ frameless: true, ...DRAWN });
  const { dom, root, act } = await withDom(t, shell.bridge);
  const { WindowFrame } = await import('./window-frame');
  const doc = dom.window.document;
  let state = 'visible';
  Object.defineProperty(doc, 'visibilityState', { get: () => state, configurable: true });
  await act(() => root.render(React.createElement(WindowFrame)));
  await act(() => {});
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), true);
  await act(() => { state = 'hidden'; doc.dispatchEvent(new dom.window.Event('visibilitychange')); });
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), false);
  assert.equal(doc.documentElement.getAttribute('data-timon-frame'), 'drawn', 'the room stays: no relayout when it comes back');
  await act(() => { state = 'visible'; doc.dispatchEvent(new dom.window.Event('visibilitychange')); });
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), true);
  // The shell put another machine's page on screen over this one.
  await act(() => shell.announce({ frameless: true, ...DRAWN, active: false }));
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), false, 'a page the shell put away drags nothing');
  await act(() => shell.announce({ frameless: true, ...DRAWN, active: true }));
  assert.equal(doc.documentElement.hasAttribute('data-timon-drag'), true);
});

test('macOS keeps its traffic lights: no button drawn, room kept at the left end', async (t) => {
  const shell = fakeShell({ frameless: true, ...DRAWN, controls: 'native' });
  const { dom, root, act } = await withDom(t, shell.bridge);
  const { WindowFrame } = await import('./window-frame');
  await act(() => root.render(React.createElement(WindowFrame)));
  await act(() => {});
  assert.equal(dom.window.document.documentElement.getAttribute('data-timon-frame'), 'native');
  assert.ok(!dom.window.document.querySelector('button'));
});

test('the top bar keeps the room the stylesheet gives the frame, and drags the window', () => {
  const topbar = readFileSync(new URL('./topbar.tsx', import.meta.url), 'utf8');
  assert.match(topbar, /pr-\[calc\(0\.75rem\+var\(--timon-window-controls-w,0px\)\)\]/);
  assert.match(topbar, /pl-\[calc\(0\.75rem\+var\(--timon-window-lights-w,0px\)\)\]/);
  assert.match(topbar, /<WindowMachineName /);
  const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
  // Zero outside a frameless desktop window: a browser's top bar is unchanged.
  assert.match(css, /:root \{\s*--timon-window-controls-w: 0px;\s*--timon-window-lights-w: 0px;/);
  assert.match(css, /html\[data-timon-frame='drawn'\] \{ --timon-window-controls-w: /);
  assert.match(css, /html\[data-timon-frame='native'\] \{ --timon-window-lights-w: /);
  // The strip drags only where the page has no top bar of its own: under a
  // folded bar it would sit over the content.
  assert.match(css, /html\[data-timon-drag\]:not\(:has\(\.timon-topbar-bar\)\) \.timon-window-strip,\s*html\[data-timon-drag\] \.timon-topbar-bar \{\s*-webkit-app-region: drag;/);
  const noDrag = /html\[data-timon-drag\] :is\(([^)]*(?:\([^)]*\)[^)]*)*)\) \{\s*-webkit-app-region: no-drag;/.exec(css)?.[1] ?? '';
  for (const control of ['button', 'a', 'input', '[role=\'menuitem\']', '.widget-frame', '.timon-window-controls']) {
    assert.ok(noDrag.includes(control), `${control} stays clickable inside the drag area`);
  }
  // Drag areas ignore stacking: every layer a portal lays over the bar cuts itself out.
  for (const layer of [
    '[role=\'dialog\']', '[role=\'alertdialog\']', '[role=\'menu\']', '[role=\'listbox\']', '[role=\'option\']', '[role=\'tooltip\']',
    '[aria-modal=\'true\']', '[data-radix-popper-content-wrapper]', '.timon-window-layer',
  ]) {
    assert.ok(noDrag.includes(layer), `${layer} never moves the window`);
  }
});

test('a side sheet starts below the drawn buttons, so its own close button is not under the window\'s', async (t) => {
  const css = readFileSync(new URL('../styles/globals.css', import.meta.url), 'utf8');
  // The band is as tall as the buttons' row (`h-12`), and only a drawn frame has one.
  assert.match(css, /--timon-window-band-h: 0px;/);
  assert.match(css, /html\[data-timon-frame='drawn'\] \{[^}]*--timon-window-band-h: 3rem;/);
  assert.match(css, /html\[data-timon-frame='drawn-full-screen'\] \{[^}]*--timon-window-band-h: 3rem;/);
  assert.match(css, /html\[data-timon-frame\^='drawn'\] \.timon-below-window-band \{\s*top: var\(--timon-window-band-h\);\s*height: auto;/);
  const { renderToStaticMarkup } = await import('react-dom/server');
  const { WindowControls } = await import('./window-frame');
  assert.match(renderToStaticMarkup(React.createElement(WindowControls, { state: DRAWN })), /class="timon-window-controls fixed right-0 top-0 z-\[60\][^"]* h-12 /);

  const { root, act, dom } = await withDom(t, null);
  const { Sheet, SheetContent, SheetTitle } = await import('./ui/sheet');
  await act(() => root.render(React.createElement(Sheet, { open: true },
    React.createElement(SheetContent, { 'aria-describedby': undefined }, React.createElement(SheetTitle, null, 'Mission')))));
  const sheet = dom.window.document.querySelector('[role="dialog"]');
  assert.ok(sheet?.classList.contains('timon-below-window-band'), 'the right sheet moves down by the band');
  assert.ok(sheet?.querySelector('button.right-4.top-4'), 'its close button sits in its own top right corner, now below the band');
  assert.ok(sheet?.previousElementSibling?.classList.contains('timon-window-layer'), 'the overlay still covers the band, and never drags');
});

test('the full-window corners of onboarding and setup leave the window\'s buttons free', () => {
  // These layers are their own stacking contexts (or paint after the buttons
  // at the same z): only a horizontal offset keeps a click off the buttons.
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const right = /right-\[calc\(1rem\+var\(--timon-window-controls-w,0px\)\)\]/;
  const shell = read('./onboarding/onboarding-shell.tsx');
  assert.match(shell, new RegExp(`absolute ${right.source} top-3\\.5 z-20 flex`), 'the scheme switch and mascot toggle');
  assert.match(shell, /absolute left-\[calc\(1rem\+var\(--timon-window-lights-w,0px\)\)\] top-3\.5 z-20 gap-1/, 'Back, clear of macOS\'s traffic lights');
  assert.match(read('./onboarding/steps/agent.tsx'), new RegExp(`md:${right.source} md:top-3\\.5`), 'the agent step\'s view switcher');
  assert.match(read('../app/setup/agent/setup-escape.tsx'), new RegExp(`fixed ${right.source} top-4 z-\\[60\\]`), 'the setup escape');
});

test('the onboarding corners sit on the same line as the drawn buttons', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const shell = read('./onboarding/onboarding-shell.tsx');
  assert.match(shell, /top-3\.5 z-20 flex items-center gap-2 timon-window-band-centred"/, 'the scheme switch and mascot toggle');
  assert.match(shell, /top-3\.5 z-20 gap-1 timon-window-band-centred"/, 'Back');
  assert.match(read('./onboarding/steps/agent.tsx'), /md:top-3\.5 md:mb-0 timon-window-band-centred-md/, 'the agent step\'s view switcher');
  const css = read('../styles/globals.css');
  assert.match(css, /html\[data-timon-frame\^='drawn'\] \.timon-window-band-centred \{\s*top: calc\(var\(--timon-window-band-h\) \/ 2\);\s*transform: translateY\(-50%\);/);
  assert.match(css, /@media \(min-width: 768px\) \{\s*html\[data-timon-frame\^='drawn'\] \.timon-window-band-centred-md \{/);
});
