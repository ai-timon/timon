/**
 * `kanban.card` and `todo.form` on the surfaces that ship (TODO #837): the
 * board's task column (`KanbanClient`), the board's TO DO column and the TO DO
 * widgets (`ProjectTodoTile`). `kanban-card-slot.test.ts` and
 * `todo-form-slot.test.ts` prove the hosts on their own; this proves the
 * screens go through them — the product's tiles and dialogs while only the
 * registered fallback holds a slot, a plugin's in their place once it takes
 * one, with the gestures reaching the real screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType, ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { KanbanCardValue } from './kanban-card-context';
import type { TodoFormValue } from './todo-form-context';
import type { ProjectTodo } from './project-todo-types';

const IDEA: ProjectTodo = {
  id: 209, text: 'Unify the cards', project: 'timon', author: 'Robin', status: 'open', notes: null,
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: 'bug', progress: null,
};
const now = Date.now();
const TASK = {
  id: 'task-1', title: 'Lay the tile out', agent_name: 'demo.coder', status: 'PENDING', priority: 3, deps: '[]',
  created_at: now, updated_at: now, type: 'code',
};

type Call = { method: string; url: string };

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks: [TASK], view: 'board', done_total: 0 });
    if (url === `/api/ui/tasks/${TASK.id}`) return Response.json({ task: TASK });
    if (url === '/api/ui/agents') return Response.json({ agents: [{ name: 'demo.coder', project: null, role: 'coder' }] });
    if (url === '/api/ui/agents/active') return Response.json({ agents: [] });
    if (url.startsWith('/api/ui/layout')) return Response.json({ layout: null });
    if (url.startsWith('/api/ui/project-todo')) return Response.json({ items: [IDEA] });
    return Response.json({ agents: [], projects: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const cardContext = await import('./kanban-card-context');
  const formContext = await import('./todo-form-context');
  const { ProductKanbanCard } = await import('./product-kanban-card');
  const { ProductTodoForm } = await import('./product-todo-form');

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: ReactElement) => { await React.act(async () => { root.render(element); }); };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  /** The product's occupants, registered as the bundled half of `@timon/kanban` does. */
  const registerProduct = () => [
    slots.register({ slot: 'kanban.card', fallback: true, pluginId: '@timon/kanban' }, ProductKanbanCard),
    slots.register({ slot: 'todo.form', fallback: true, pluginId: '@timon/kanban' }, ProductTodoForm),
  ];
  const cards: KanbanCardValue[] = [];
  const forms: TodoFormValue[] = [];
  /** A third-party plugin taking both slots, as `ctx.slots.register` does under its manifest id. */
  const registerAcme = () => {
    const AcmeCard: ComponentType = () => {
      const card = cardContext.useKanbanCard();
      if (!card) return null;
      cards.push(card);
      return React.createElement('div', { 'data-acme-card': card.kind, 'data-density': card.density },
        React.createElement('button', { type: 'button', 'data-acme-open': '', onClick: card.open },
          card.kind === 'todo' ? card.item.text : card.task.title),
        card.kind === 'todo' && card.toggleDone
          && React.createElement('button', { type: 'button', 'data-acme-toggle': '', onClick: card.toggleDone }, 'tick'));
    };
    const AcmeForm: ComponentType = () => {
      const form = formContext.useTodoForm();
      if (!form) return null;
      forms.push(form);
      return React.createElement('div', { 'data-acme-form': form.mode },
        React.createElement('h2', { id: form.titleId }, 'Acme idea'),
        React.createElement('button', { type: 'button', 'data-acme-close': '', onClick: form.close }, 'close'));
    };
    return [
      slots.register({ slot: 'kanban.card', pluginId: 'acme-kanban' }, AcmeCard),
      slots.register({ slot: 'todo.form', pluginId: 'acme-kanban' }, AcmeForm),
    ];
  };
  const dispose = async (disposers: Array<() => void>) => { await React.act(async () => { for (const d of disposers) d(); }); };
  const realtime = { subscribe: () => () => {} };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, calls, render, until, click, registerProduct, registerAcme, dispose, cards, forms, realtime, unmount };
}

test('the board paints its tasks through kanban.card: the product card by default, a plugin\'s once it takes the slot', async () => {
  const m = await mount();
  try {
    const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
    const { KanbanClient } = await import('./kanban-page');
    const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
    const product = m.registerProduct();
    await m.render(m.React.createElement(AppRouterContext.Provider, { value: router }, m.React.createElement(KanbanClient)));
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the product task card');

    const acme = m.registerAcme();
    await m.until(() => !!document.querySelector('[data-acme-card="task"]'), 'the plugin\'s task card');
    assert.ok(!document.querySelector('[data-task-card]'), 'the product card is not painted under it');
    const card = m.cards.find((c) => c.kind === 'task');
    assert.ok(card && card.kind === 'task');
    assert.equal(card.density, 'card');
    assert.equal(card.task.id, 'task-1');
    assert.equal(card.agentRole, 'coder', 'the board hands its own reading of the agent');
    assert.equal(card.drag.draggable, true, 'a queued task can be moved');

    await m.click(document.querySelector('[data-acme-card="task"] [data-acme-open]'));
    await m.until(() => m.calls.some((c) => c.url === '/api/ui/tasks/task-1'), 'the board reads the task to open it');
    await m.until(() => !!document.querySelector('[role="dialog"]'), 'the task popup');

    await m.dispose(acme);
    await m.until(() => !!document.querySelector('[data-task-card="task-1"]'), 'the product card back');
    await m.dispose(product);
  } finally {
    await m.unmount();
  }
});

test('the TO DO column paints its ideas through kanban.card and opens them through todo.form', async () => {
  const m = await mount();
  try {
    const { KanbanTodoColumn } = await import('./kanban-todo-column');
    const product = m.registerProduct();
    await m.render(m.React.createElement(KanbanTodoColumn, { realtime: m.realtime } as never));
    await m.until(() => Array.from(document.querySelectorAll('article')).some((a) => a.textContent?.includes('#209')), 'the product idea card');
    await m.click(Array.from(document.querySelectorAll('article')).find((a) => a.textContent?.includes('#209')));
    await m.until(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Save'), 'the product detail dialog');
    await m.React.act(async () => {
      document.dispatchEvent(new (globalThis.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true }));
    });

    const acme = m.registerAcme();
    await m.until(() => !!document.querySelector('[data-acme-card="todo"]'), 'the plugin\'s idea card');
    const card = m.cards.find((c) => c.kind === 'todo');
    assert.ok(card && card.kind === 'todo');
    assert.equal(card.density, 'card');
    assert.ok(card.toggleDone && card.remove, 'the column hands the idea\'s checkbox and deletion');
    assert.ok(card.handoff, 'an idea with a project can be handed to the orchestrator');
    assert.deepEqual(card.show, { id: true, author: true, project: true });

    await m.click(document.querySelector('[data-acme-card="todo"] [data-acme-open]'));
    await m.until(() => !!document.querySelector('[role="dialog"] [data-acme-form="edit"]'), 'the plugin\'s form in the host frame');
    assert.equal(m.forms.at(-1)?.item?.id, 209);
    await m.click(document.querySelector('[data-acme-close]'));
    await m.until(() => !document.querySelector('[data-acme-form]'), 'the form closed');

    await m.dispose(acme);
    await m.until(() => !document.querySelector('[data-acme-card]'), 'the product card back');
    await m.dispose(product);
  } finally {
    await m.unmount();
  }
});

test('the TO DO widget paints its rows through kanban.card, and creates and edits through todo.form', async () => {
  const m = await mount();
  try {
    const { ProjectTodoTile } = await import('./project-todo-tile');
    const product = m.registerProduct();
    await m.render(m.React.createElement(ProjectTodoTile, {
      scope: { kind: 'project', slug: 'timon' }, titre: 'Project TO DO', handle: null, realtime: m.realtime, editing: false,
    } as never));
    await m.until(() => !!document.querySelector('li button[aria-label="Mark as done"]'), 'the product row');
    const add = () => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Add');

    const acme = m.registerAcme();
    await m.until(() => !!document.querySelector('[data-acme-card="todo"]'), 'the plugin\'s row');
    assert.ok(!document.querySelector('li button[aria-label="Mark as done"]'), 'the product row is not painted under it');
    const row = m.cards.find((c) => c.kind === 'todo');
    assert.ok(row && row.kind === 'todo');
    assert.equal(row.density, 'row');
    assert.equal(row.show.project, false, 'a project widget does not repeat its project');
    assert.ok(row.toggleDone && row.remove && row.handoff, 'a row hands its checkbox, hand-off and deletion');

    await m.click(document.querySelector('[data-acme-toggle]'));
    await m.until(() => m.calls.some((c) => c.method === 'PATCH' && c.url === '/api/ui/project-todo/209'), 'the tick reaches the notebook');

    await m.click(document.querySelector('[data-acme-card="todo"] [data-acme-open]'));
    await m.until(() => !!document.querySelector('[role="dialog"] [data-acme-form="edit"]'), 'the edition through the plugin');
    await m.click(document.querySelector('[data-acme-close]'));
    await m.until(() => !document.querySelector('[data-acme-form]'), 'the edition closed');

    await m.click(add());
    await m.until(() => !!document.querySelector('[role="dialog"] [data-acme-form="create"]'), 'the creation through the plugin');
    const form = m.forms.at(-1);
    assert.equal(form?.item, null);
    assert.equal(form?.defaultProject, 'timon', 'a new idea is filed under the widget\'s project');
    assert.equal(form?.handoff, null, 'nothing to hand off before it exists');
    await m.click(document.querySelector('[data-acme-close]'));

    await m.dispose(acme);
    await m.until(() => !!document.querySelector('li button[aria-label="Mark as done"]'), 'the product row back');
    await m.click(add());
    await m.until(() => Array.from(document.querySelectorAll('[role="dialog"] button')).some((b) => b.textContent?.trim() === 'Add'), 'the product quick entry');
    await m.dispose(product);
  } finally {
    await m.unmount();
  }
});
