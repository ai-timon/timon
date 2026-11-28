/**
 * The task tile on `BoardCard` (TODO #837, volet C): each piece of a task lands
 * in the zone an idea uses for its own — the agent as identity, `P<n>` in the
 * corner, the type, the status, the runner and the linked idea as badges,
 * validation / interruption / block as context, schedule, dependencies and files as meta, the gestures as
 * actions — and the gestures keep their paths: the title button opens the task,
 * an action never does, the drag attributes stay on the root, and a draggable
 * tile opens through a span with the button role (Firefox drags no button).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentProps } from 'react';
import type { KanbanTaskCard as Card } from './kanban-task-card';
import type { Task } from './kanban-task';
import type { ProjectTodo } from './project-todo-types';

const IDEA: ProjectTodo = {
  id: 42, text: 'An idea', project: 'timon', author: 'user', status: 'promoted', notes: null,
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: 'bug', progress: 'partial',
};

const NOW = Date.UTC(2026, 10, 4, 12, 0);
const MERGE_LABEL = 'merged?';

function task(extra: Partial<Task> = {}): Task {
  return {
    id: 'task-1', title: 'Lay the tile out', agent_name: 'demo.coder', status: 'PENDING', priority: 4, deps: '[]',
    created_at: NOW, updated_at: NOW, type: 'code', ...extra,
  };
}

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent',
    'PointerEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async () => Response.json({ defaultBackend: 'claude', backends: [] }));

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { KanbanTaskCard } = await import('./kanban-task-card');

  const router = { bfcacheId: 'test', back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const gestures: string[] = [];
  const render = async (t: Task, extra: Partial<ComponentProps<typeof Card>> = {}) => {
    const props: ComponentProps<typeof Card> = {
      task: t, byId: new Map([[t.id, t]]), now: NOW,
      agent: { name: t.agent_name, accent: '#888', iconUrl: null, fallback: 'C', roleKey: 'coder', known: true },
      agentRole: 'Coder', todo: null, needsAction: false, dragging: false, modelTarget: { agent: t.agent_name },
      onOpen: () => { gestures.push('open'); },
      onStop: () => { gestures.push('stop'); },
      onMarkMerged: () => { gestures.push('merge'); },
      onOpenGraph: (id) => { gestures.push(`graph:${id}`); },
      onSaved: () => {},
      onDragStart: () => { gestures.push('drag'); },
      onDragEnd: () => {},
      ...extra,
    };
    await React.act(async () => {
      root.render(React.createElement(AppRouterContext.Provider, { value: router },
        React.createElement(KanbanTaskCard, props)));
    });
  };
  const card = () => document.querySelector<HTMLElement>('[data-task-card="task-1"]')!;
  const zone = (name: string) => card().querySelector<HTMLElement>(`[data-board-card-${name}]`);
  const text = (name: string) => zone(name)?.textContent ?? '';
  const click = async (el: Element | null | undefined) => {
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { render, card, zone, text, click, gestures, unmount };
}

test('a queued task lays its pieces in the shared zones of a board card', async () => {
  const m = await mount();
  try {
    await m.render(task({
      run_by: { agent: 'demo.reviewer', source: 'role', reason: 'other_role', planned: true },
      scheduled_at: new Date(2026, 10, 5, 2, 0).getTime(),
      attachment_count: 2,
      deps: '["other"]',
    }), { todo: IDEA });
    const card = m.card();
    assert.equal(card.tagName, 'ARTICLE');
    assert.equal(card.getAttribute('data-board-card'), '');
    assert.equal(card.getAttribute('data-density'), 'card');
    assert.equal(card.getAttribute('draggable'), 'true', 'a queued task can be dragged');

    // #1109: the agent the dispatcher hands the task to, not the one it names.
    assert.match(m.text('identity'), /demo\.reviewer/);
    assert.doesNotMatch(m.text('identity'), /demo\.coder/);
    assert.match(m.text('identity'), /Coder/, 'the agent\'s role under its name');
    assert.ok(m.zone('identity')?.querySelector('[data-task-params]'), 'the model chip beside the agent');
    assert.equal(m.text('corner'), 'P4');
    assert.match(m.zone('corner')?.querySelector('[title="Priority 4"]')?.className ?? '', /text-warning/, 'P4 stands out');

    assert.equal(m.card().querySelector('[data-card-title]')?.textContent, 'Lay the tile out');
    assert.ok(m.zone('title')?.closest('[data-board-card-open]'), 'the title is the open button');
    assert.equal(m.card().querySelector('[data-board-card-open]')?.getAttribute('role'), 'button',
      'a span with the button role on a draggable card: Firefox starts no drag from a button');

    assert.match(m.text('badges'), /^code/, 'the type first');
    assert.equal(m.zone('badges')?.querySelector('[data-task-status]')?.textContent, 'Pending', 'then the status');
    const runner = m.zone('badges')?.querySelector('[data-task-runner="demo.reviewer"]');
    assert.ok(runner, 'the runner badge');
    assert.equal(runner?.textContent, 'assigned to demo.coder', 'the badge recalls the agent the task names');
    assert.match(runner?.getAttribute('title') ?? '', /will be run by demo\.reviewer/, 'a plan, not a past run');
    assert.match(m.text('badges'), /#42/, 'the linked idea');
    assert.match(m.text('badges'), /Bug/, 'its urgency');

    assert.match(m.text('meta'), /Scheduled/);
    assert.ok(m.zone('meta')?.querySelector('[aria-label="2 attachments"]'), 'the attachment count');
    assert.equal(m.zone('context'), null, 'nothing asks for attention');
    assert.equal(m.zone('actions'), null, 'no gesture on a queued task without a series');
  } finally {
    await m.unmount();
  }
});

test('a running task shows its validation banner as context and its gestures as actions', async () => {
  const m = await mount();
  try {
    await m.render(task({ status: 'IN_PROGRESS', mission_id: 'm-1', started_at: NOW - 60_000, series_id: 's-1' }), { needsAction: true });
    assert.equal(m.card().getAttribute('draggable'), 'false', 'a running task stays in its column');
    assert.match(m.card().className, /ring-primary/, 'the running ring');
    assert.match(m.text('context'), /Validation required/);
    for (const label of ['Series graph', 'Open the mission', 'Stop the mission']) {
      assert.ok(m.zone('actions')?.querySelector(`[aria-label="${label}"]`), label);
    }
    await m.click(m.zone('actions')?.querySelector('[aria-label="Stop the mission"]'));
    await m.click(m.zone('actions')?.querySelector('[aria-label="Series graph"]'));
    assert.deepEqual(m.gestures, ['stop', 'graph:task-1'], 'an action never opens the task');
    assert.equal(m.card().querySelector('[data-board-card-open]')?.tagName, 'BUTTON', 'a running task, not draggable, opens through a real button');
    await m.click(m.card().querySelector('[data-board-card-open]'));
    await m.click(m.zone('meta') ?? m.card());
    assert.deepEqual(m.gestures, ['stop', 'graph:task-1', 'open', 'open'], 'the title and the card body open it');
  } finally {
    await m.unmount();
  }
});

test('a running task whose mission waits on a card says on what, since when and until when (TODO #1094)', async () => {
  const m = await mount();
  try {
    const running = { status: 'IN_PROGRESS' as const, mission_id: 'm-1', started_at: NOW - 600_000 };
    await m.render(task({ ...running, pending_permission: {
      kind: 'permission', tool_name: 'Bash', since: NOW - 3 * 60_000, expires_at: NOW + 2 * 60_000, remaining_ms: 2 * 60_000, count: 2,
    } }), { needsAction: true });
    const line = m.zone('context')?.querySelector<HTMLElement>('[data-pending-permission="Bash"]');
    assert.ok(line, 'the waiting line');
    assert.match(line.textContent ?? '', /Waiting for a permission \(Bash\) for 3\smin/);
    assert.match(line.textContent ?? '', /auto-deny in 2\smin/);
    assert.match(line.title, /1 more card waiting/, 'the other cards in the tooltip');
    assert.doesNotMatch(m.text('context'), /Validation required/, 'one banner, not two');

    await m.render(task({ ...running, pending_permission: {
      kind: 'question', tool_name: 'ask_user', since: NOW - 20_000, expires_at: null, remaining_ms: null, count: 1,
    } }));
    assert.match(m.text('context'), /Waiting for an answer for <\s1\smin/);
    assert.doesNotMatch(m.text('context'), /auto-deny/, 'a chat mission never times out');

    await m.render(task({ ...running, status: 'BLOCKED', pending_permission: {
      kind: 'permission', tool_name: 'Bash', since: NOW, expires_at: null, remaining_ms: null, count: 1,
    } }));
    assert.ok(!m.card().querySelector('[data-pending-permission]'), 'only a running task says it');
  } finally {
    await m.unmount();
  }
});

test('a task that waits for the person is amber and says so, never the red of a breakdown', async () => {
  const m = await mount();
  try {
    await m.render(task({ status: 'BLOCKED', awaiting_user: 1, blocked_reason: 'Merge request !42 is ready' }));
    assert.match(m.card().className, /ring-warning/);
    assert.doesNotMatch(m.card().className, /ring-destructive/);
    assert.match(m.text('badges'), /Waiting for you/);
    assert.doesNotMatch(m.text('badges'), /Blocked/);
    assert.match(m.text('context'), /Merge request !42 is ready/);
    assert.ok(!m.zone('context')?.querySelector('.text-destructive'), 'no red text');

    await m.render(task({ status: 'BLOCKED', awaiting_user: 0, blocked_reason: 'Conflict' }));
    assert.match(m.card().className, /ring-destructive/, 'a real block stays red');
    assert.ok(!m.card().querySelector('[data-awaiting-user]'));
  } finally {
    await m.unmount();
  }
});

test('a blocked or interrupted task says why in the context zone, and a finished one offers mark-merged', async () => {
  const m = await mount();
  try {
    await m.render(task({ status: 'BLOCKED', blocked_reason: 'Waits for a review', interrupted_reason: 'rate_limit' }));
    assert.match(m.card().className, /ring-destructive/, 'the blocked ring');
    assert.match(m.text('context'), /Waits for a review/);
    assert.match(m.text('context'), /rate_limit/, 'the raw cause stays grepable');
    assert.equal(m.zone('actions'), null, 'mark-merged waits for the popup on a blocked task');

    await m.render(task({ status: 'DONE', awaiting_merge: true, mission_id: 'm-2' }));
    assert.equal(m.zone('context'), null);
    assert.ok(m.zone('actions')?.querySelector('[aria-label="Open the mission"]'));
    assert.ok(m.zone('actions')?.querySelector(`[aria-label="${MERGE_LABEL}"]`), 'a finished code task awaiting its merge');
    assert.ok(!m.card().querySelector('[data-board-card-title]')?.className.includes('line-through'), 'a finished task is not struck through');
  } finally {
    await m.unmount();
  }
});
