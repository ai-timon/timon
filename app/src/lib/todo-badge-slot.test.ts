import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientRealtime } from './plugin-host/realtime';

/**
 * `kanban.todo.badge`: a plugin's badge is rendered on every line of the TO DO
 * notebook and reads the idea of ITS line from context. An empty slot paints
 * nothing, so a stock install keeps the exact markup of its lines.
 */
const realtime: ClientRealtime = { subscribe: () => () => {} };

const ideas = [
  { id: 7, text: 'first idea', urgency: null, status: 'open', project: 'timon', author: 'Robin', notes: null, progress: null },
  { id: 8, text: 'second idea', urgency: 'bug', status: 'open', project: 'timon', author: 'trigger:discord-events', notes: null, progress: null },
];

async function installDom() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string) => {
    if (String(input).startsWith('/api/ui/layout')) return Response.json({ layout: null });
    return Response.json({ items: ideas, tasks: [] });
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  return { React, root: createRoot(document.getElementById('root')!) };
}

/** Registers a badge that prints the id of the idea it is given. */
async function withBadge(fn: () => Promise<void>) {
  const { declareSlot, register, slotKind } = await import('./plugin-host/slots');
  const { useTodoItem } = await import('../plugins-client/kanban/todo-badge-slot');
  const undo: Array<() => void> = [];
  if (slotKind('kanban.todo.badge') === null) undo.push(declareSlot('kanban.todo.badge', 'list'));
  function Badge() {
    const item = useTodoItem();
    return item ? `badge-of-${item.id}` : null;
  }
  undo.push(register({ slot: 'kanban.todo.badge', pluginId: 'test/badge' }, Badge));
  try { await fn(); } finally { for (const f of undo.reverse()) f(); }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test('a badge in a TO DO widget line reads the idea of its line', async () => {
  await withBadge(async () => {
    const { React, root } = await installDom();
    const { ProjectTodoTile } = await import('../plugins-client/kanban/project-todo-tile');
    await React.act(async () => {
      root.render(React.createElement(ProjectTodoTile, {
        scope: { kind: 'all' }, titre: 'Kanban TO DO', handle: null, realtime, editing: false,
      } as never));
    });
    await React.act(settle);
    const lines = Array.from(document.querySelectorAll('li')).map((li) => li.textContent!);
    const first = lines.find((l) => l.includes('first idea'))!;
    const second = lines.find((l) => l.includes('second idea'))!;
    assert.match(first, /badge-of-7/);
    assert.doesNotMatch(first, /badge-of-8/);
    assert.match(second, /badge-of-8/);
    await React.act(async () => { root.unmount(); });
  });
});

test('a badge in the Kanban TO DO column reads the idea of its card', async () => {
  await withBadge(async () => {
    const { React, root } = await installDom();
    const { KanbanTodoColumn } = await import('../plugins-client/kanban/kanban-todo-column');
    await React.act(async () => { root.render(React.createElement(KanbanTodoColumn, { realtime })); });
    await React.act(settle);
    const cards = Array.from(document.querySelectorAll('article')).map((a) => a.textContent!);
    assert.equal(cards.length, 2);
    assert.match(cards[0]!, /badge-of-7/);
    assert.match(cards[1]!, /badge-of-8/);
    await React.act(async () => { root.unmount(); });
  });
});

test('a badge in the idea detail reads the idea shown', async () => {
  await withBadge(async () => {
    const { React, root } = await installDom();
    const { TodoFormModal } = await import('../plugins-client/kanban/todo-form-modal');
    const item = { ...ideas[1], created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null };
    await React.act(async () => {
      root.render(React.createElement(TodoFormModal, {
        item, onClose: () => {}, onSaved: () => {},
      } as never));
    });
    assert.match(document.body.textContent!, /badge-of-8/);
    await React.act(async () => { root.unmount(); });
  });
});

test('without an occupant the slot paints nothing', async () => {
  const { React, root } = await installDom();
  const { TodoBadgeSlot } = await import('../plugins-client/kanban/todo-badge-slot');
  const item = { ...ideas[0], created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null };
  await React.act(async () => { root.render(React.createElement(TodoBadgeSlot, { item } as never)); });
  assert.equal(document.getElementById('root')!.innerHTML, '');
  await React.act(async () => { root.unmount(); });
});

test('the core author badge is generic: a Discord-made idea shows its author as text', async () => {
  const { React, root } = await installDom();
  const { AuthorBadge } = await import('../plugins-client/kanban/project-todo-tag-chips');
  await React.act(async () => {
    root.render(React.createElement(AuthorBadge, { author: 'trigger:discord-events' }));
  });
  const host = document.getElementById('root')!;
  assert.equal(host.textContent, 'trigger:discord-events');
  assert.ok(!host.querySelector('svg'), 'no brand logo hard-coded in the core');
  await React.act(async () => { root.unmount(); });
});

test('a third-party half gets the hooks through `@timon/ui`, and its manifest may declare both slots', async () => {
  const { UI_KIT } = await import('./plugin-host/ui-kit');
  const { useTodoItem } = await import('../plugins-client/kanban/todo-badge-slot');
  const { useTodoDetail } = await import('../plugins-client/kanban/todo-detail-slot');
  const { PLATFORM_MODULE_SOURCES, platformModuleExports } = await import('./plugin-host/platform-modules');
  const { isSlotAdmissible } = await import('./plugin-host/slot-compat');
  // One context object: a copy of the hook would read an empty context.
  assert.equal(UI_KIT.useTodoItem, useTodoItem);
  assert.equal(UI_KIT.useTodoDetail, useTodoDetail);
  assert.ok(platformModuleExports('ui.js').includes('useTodoItem'));
  assert.ok(platformModuleExports('ui.js').includes('useTodoDetail'));
  assert.match(PLATFORM_MODULE_SOURCES['ui.js']!, /useTodoItem=u\.useTodoItem/);
  assert.equal(isSlotAdmissible(['kanban.todo.badge'], 'kanban.todo.badge'), true);
  assert.equal(isSlotAdmissible(['kanban.todo.badge'], 'kanban.todo.detail'), false, 'exact name, never a family');
});
