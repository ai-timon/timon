import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientRealtime } from './plugin-host/realtime';

/**
 * The board's TO DO column counts with the daemon, not with the rows it got:
 * those stop at one page, and a notebook past it showed the page size as its
 * number of open ideas.
 */
const realtime: ClientRealtime = { subscribe: () => () => {} };

const page = Array.from({ length: 200 }, (_, n) => ({
  id: n + 1, text: `idea ${n + 1}`, urgency: null, status: 'open', project: 'timon', author: null, notes: null, progress: null,
}));

async function mount(filters: { agent: string; project: string; q: string }, calls: string[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event'] as const) {
    install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    calls.push(String(input));
    return Response.json({
      items: page,
      counts: { byStatus: { open: 251, done: 737, promoted: 2 }, byUrgency: {} },
      truncated: true,
    });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { KanbanFiltersContext } = await import('./kanban-filters-context');
  const { KanbanTodoColumn } = await import('../plugins-client/kanban/kanban-todo-column');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(
      KanbanFiltersContext.Provider,
      { value: filters },
      React.createElement(KanbanTodoColumn, { realtime }),
    ));
  });
  await React.act(() => new Promise((r) => setTimeout(r, 0)));
  return { React, root };
}

test('the column shows the daemon\'s count of open ideas and says the page is cut', async () => {
  const calls: string[] = [];
  const { React, root } = await mount({ agent: '*', project: 'timon', q: '' }, calls);
  // The board's project narrows on the daemon's side.
  assert.deepEqual(calls, ['/api/ui/project-todo?status=open&project=timon&limit=500']);
  const header = document.querySelector('section')!.textContent!;
  assert.match(header, /251/);
  assert.doesNotMatch(header, /To do\s*200/);
  assert.match(document.body.textContent!, /Showing the latest 200 of 251/);
  await React.act(async () => { root.unmount(); });
});

test('a keyword counts the rows it keeps', async () => {
  const calls: string[] = [];
  const { React, root } = await mount({ agent: '*', project: '*', q: 'idea 12' }, calls);
  assert.deepEqual(calls, ['/api/ui/project-todo?status=open&limit=500']);
  // "idea 12" and "idea 120 … 129": eleven cards.
  assert.equal(document.querySelectorAll('article').length, 11);
  assert.match(document.querySelector('section')!.textContent!, /^To do\s*11/);
  await React.act(async () => { root.unmount(); });
});
