/**
 * The hand-rolled context menus close on a click outside them, even when the
 * clicked element stops the mousedown's propagation — d3-zoom does on every
 * left click of the Agents graph, so the menu stayed open (TIM-0123).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';

async function setup() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div><div id="graph"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { act } = await import('react');

  // What d3-zoom does on the graph's svg: nothing above it hears the event.
  const graph = dom.window.document.getElementById('graph')!;
  graph.addEventListener('mousedown', (e) => e.stopImmediatePropagation());

  const root = createRoot(dom.window.document.getElementById('root')!);
  const mount = async (el: ReactElement) => { await act(async () => { root.render(el); }); };
  const press = async (target: Element) => {
    await act(async () => { target.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true })); });
  };
  const menu = () => dom.window.document.querySelector('[role="menu"]');
  const done = async () => { await act(async () => { root.unmount(); }); dom.window.close(); };
  return { React, graph, mount, press, menu, done };
}

test('NodeMenu closes on a mousedown whose propagation is stopped outside it', async () => {
  const env = await setup();
  const { NodeMenu } = await import('../app/agents/node-menu');
  let closed = 0;
  const noop = () => {};
  await env.mount(env.React.createElement(NodeMenu, {
    target: { id: 'alice', x: 10, y: 10 },
    agents: [{ name: 'alice', project: null }],
    poles: [],
    hierarchy: {
      parentOf: new Map(), leadOfWorkspace: new Map(), workspaceOfLead: new Map(),
      workspaceOfProject: new Map(), leadOfProject: new Map(),
    },
    onClose: () => { closed += 1; },
    onReportsTo: noop, onMovePole: noop, onEditPole: noop, onDeletePole: noop, onDuplicate: noop,
  }));
  const menu = env.menu();
  assert.ok(menu, 'the menu is rendered');

  await env.press(menu.querySelector('button')!);
  assert.equal(closed, 0, 'a press inside the menu keeps it open');

  await env.press(env.graph);
  assert.equal(closed, 1, 'a press on the graph closes it');
  await env.done();
});

test('AgentContextMenu closes on a mousedown whose propagation is stopped outside it', async () => {
  const env = await setup();
  const { AgentContextMenu } = await import('../plugins-client/agent-chat/agent-context-menu');
  let closed = 0;
  const noop = () => {};
  await env.mount(env.React.createElement(AgentContextMenu, {
    target: { agent: 'alice', x: 10, y: 10 },
    onCustomize: noop, onEdit: noop, onDuplicate: noop, onRemove: noop, onStop: noop, onMakeMain: noop,
    onClose: () => { closed += 1; },
  }));
  await env.press(env.menu()!);
  assert.equal(closed, 0);
  await env.press(env.graph);
  assert.equal(closed, 1);
  await env.done();
});

test('FileContextMenu closes on a mousedown whose propagation is stopped outside it', async () => {
  const env = await setup();
  const { FileContextMenu } = await import('../components/chat/file-context-menu');
  let closed = 0;
  await env.mount(env.React.createElement(FileContextMenu, {
    x: 10, y: 10, label: 'notes.md',
    items: [{ key: 'open', label: 'Open', icon: null, onSelect: () => {} }],
    onClose: () => { closed += 1; },
  }));
  await env.press(env.menu()!);
  assert.equal(closed, 0);
  await env.press(env.graph);
  assert.equal(closed, 1);
  await env.done();
});
