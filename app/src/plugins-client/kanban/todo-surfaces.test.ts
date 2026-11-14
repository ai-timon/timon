/**
 * The product's surfaces of a TO DO idea once laid out like a task's (TODO
 * #837, volet B): the column's card and the widget's row on `BoardCard`, the
 * detail and the quick entry on `DetailShell` inside the host's `DetailFrame`,
 * with its keyboard (Escape, the focus held inside and given back).
 *
 * Assertions compare texts and booleans, never DOM nodes: an inspected jsdom
 * node blows the memory guard when an assertion fails.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { KanbanTodoCardValue } from './kanban-card-context';
import type { ProjectTodo } from './project-todo-types';

const IDEA: ProjectTodo = {
  id: 209, text: 'Unify the cards', project: 'timon', author: 'agent.main', status: 'open', notes: 'Some **context**',
  created_at: Date.UTC(2026, 10, 4, 9, 30), updated_at: Date.UTC(2026, 10, 4, 10, 0), done_at: null,
  promoted_task_id: null, urgency: 'bug', progress: 'analyzed',
  links: [
    { provider: 'github', ref: 'acme/app#12', url: 'https://github.com/acme/app/issues/12', label: 'Issue #12', plugin_id: null, created_at: 1 },
    { provider: 'evil', ref: 'x', url: 'javascript:alert(1)', label: 'Click', plugin_id: null, created_at: 2 },
  ],
};

type Call = { method: string; url: string; body: unknown };

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
    calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks: [] });
    if (url.endsWith('/handoff')) return Response.json({ to_agent: 'timon.main' });
    if (url.startsWith('/api/ui/project-todo')) return Response.json({ item: { id: 209 } });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: ReactElement) => { await React.act(async () => { root.render(element); }); };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const key = async (el: Element | null | undefined, init: KeyboardEventInit) => {
    assert.ok(el, 'element to press a key on');
    await React.act(async () => { el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  };
  const type = async (el: Element | null | undefined, value: string) => {
    assert.ok(el, 'field to type in');
    const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
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
  return { React, dom, calls, render, until, click, key, type, unmount };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

/** One idea's tile through the real host, recording the gestures it hands. */
async function renderTile(m: Mounted, density: 'card' | 'row', patch: Partial<KanbanTodoCardValue> = {}, item: ProjectTodo = IDEA) {
  const { KanbanCardHost } = await import('./kanban-card-slot');
  const gestures: string[] = [];
  const value: KanbanTodoCardValue = {
    kind: 'todo', density, item, show: { id: true, author: true, project: true },
    open: () => { gestures.push('open'); },
    toggleDone: () => { gestures.push('toggle'); },
    handoff: () => { gestures.push('handoff'); },
    remove: () => { gestures.push('remove'); },
    ...patch,
  };
  const host = m.React.createElement(KanbanCardHost, { value });
  await m.render(density === 'row' ? m.React.createElement('ul', null, host) : host);
  return gestures;
}

const button = (label: string) => document.querySelector(`button[aria-label="${label}"]`);
const dialog = () => document.querySelector('[role="dialog"]');

test('the column\'s idea is a BoardCard: task shell, identity, corner, badges, meta and gestures', async () => {
  const m = await mount();
  try {
    const gestures = await renderTile(m, 'card');
    const card = document.querySelector('article[data-board-card]')!;
    assert.equal(card.getAttribute('data-density'), 'card');
    const shell = card.className;
    assert.ok(shell.includes('rounded-xl') && shell.includes('shadow-elev-1'), 'the task tile\'s shell');
    assert.ok(!shell.includes('border-dashed'), 'no dashed outline any more');
    assert.equal(card.querySelector('[data-board-card-identity]')?.textContent, 'agent.main·timon');
    assert.equal(card.querySelector('[data-board-card-corner]')?.textContent, '#209');
    assert.match(card.querySelector('[data-board-card-badges]')?.textContent ?? '', /Bug.*Analyzed/);

    const meta = card.querySelector('[data-board-card-meta]')!;
    const issue = Array.from(meta.querySelectorAll('a')).find((a) => a.textContent === 'Issue #12');
    assert.equal(issue?.getAttribute('href'), 'https://github.com/acme/app/issues/12');
    assert.equal(issue?.getAttribute('rel'), 'noopener noreferrer');
    assert.match(meta.textContent ?? '', /Click/, 'a link that is not http(s) stays text');
    assert.ok(!Array.from(document.querySelectorAll('a')).some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:')));

    await m.click(button('Mark as done'));
    await m.click(button('Send back to the orchestrator'));
    await m.click(button('Delete'));
    assert.deepEqual(gestures, ['toggle', 'handoff', 'remove'], 'a gesture never opens the idea');
    await m.click(card.querySelector('[data-board-card-open]'));
    assert.deepEqual(gestures.slice(3), ['open']);
  } finally {
    await m.unmount();
  }
});

test('a withheld gesture is not drawn, and an idea without a badge draws no badge zone', async () => {
  const m = await mount();
  try {
    await renderTile(m, 'card', { handoff: null, remove: null, toggleDone: null }, { ...IDEA, urgency: null, progress: null, links: [] });
    assert.ok(!document.querySelector('[data-board-card-actions]'));
    assert.ok(!document.querySelector('[data-board-card-badges]'));
  } finally {
    await m.unmount();
  }
});

test('the widget\'s idea is the same tile in row density: title, tags, then id and gestures on the foot line', async () => {
  const m = await mount();
  try {
    const gestures = await renderTile(m, 'row');
    const row = document.querySelector('li[data-board-card]')!;
    assert.equal(row.getAttribute('data-density'), 'row');
    assert.ok(!row.querySelector('[data-board-card-leading]'), 'no checkbox in front of the title');
    const foot = row.querySelector('[data-board-card-foot]')!;
    assert.equal(foot.querySelector('[data-board-card-corner]')?.textContent, '#209');
    assert.ok(!foot.querySelector('button[title]'), 'gestures are named by a tooltip, not a native title');
    assert.match(row.textContent ?? '', /Bug.*Analyzed.*timon.*agent\.main/);
    await m.click(foot.querySelector('button[aria-label="Mark as done"]'));
    await m.click(button('Send back to the orchestrator'));
    await m.click(button('Delete'));
    assert.deepEqual(gestures, ['toggle', 'handoff', 'remove']);
    await m.click(row.querySelector('[data-board-card-title]'));
    assert.deepEqual(gestures.slice(3), ['open']);
  } finally {
    await m.unmount();
  }
});

test('a row follows the widget\'s display options', async () => {
  const m = await mount();
  try {
    await renderTile(m, 'row', { show: { id: false, author: false, project: false } });
    const row = document.querySelector('li[data-board-card]')!;
    assert.ok(!row.querySelector('[data-board-card-corner]'));
    assert.doesNotMatch(row.textContent ?? '', /agent\.main|timon/);
  } finally {
    await m.unmount();
  }
});

/** A button that opens the idea's popup, as a tile does, and closes it on `onClose`. */
async function renderPopup(m: Mounted, item: ProjectTodo | null, record: string[] = []) {
  const { TodoFormModal } = await import('./todo-form-modal');
  const { useState } = m.React;
  function Screen() {
    const [open, setOpen] = useState(false);
    return m.React.createElement(m.React.Fragment, null,
      m.React.createElement('button', { type: 'button', id: 'opener', onClick: () => setOpen(true) }, 'open'),
      open && m.React.createElement(TodoFormModal, {
        item, defaultProject: 'timon',
        onSaved: () => { record.push('saved'); },
        onClose: () => { record.push('closed'); setOpen(false); },
      }));
  }
  await m.render(m.React.createElement(Screen));
  const opener = document.getElementById('opener')!;
  opener.focus();
  await m.click(opener);
  await m.until(() => !!dialog(), 'the popup');
  return opener;
}

test('the detail is laid out on DetailShell in the host\'s frame, named by the idea, dates in the interface language', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    const frame = dialog()!;
    assert.ok(frame.querySelector('[data-detail-shell]'));
    assert.ok(frame.querySelector('[data-detail-shell-rail]'), 'the meta rail');
    assert.equal(document.getElementById(frame.getAttribute('aria-labelledby')!)?.textContent, 'Idea #209');
    const { formatDateTime } = await import('@/lib/intl');
    const created = formatDateTime(IDEA.created_at, { dateStyle: 'short', timeStyle: 'short' });
    assert.match(frame.textContent ?? '', new RegExp(`Created ${created.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(frame.contains(document.activeElement), 'the focus moves into the frame');
  } finally {
    await m.unmount();
  }
});

test('Escape closes the popup and gives the focus back to what opened it', async () => {
  const m = await mount();
  try {
    const record: string[] = [];
    await renderPopup(m, IDEA, record);
    await m.key(document.activeElement, { key: 'Escape' });
    await m.until(() => !dialog(), 'the popup closed');
    assert.deepEqual(record, ['closed']);
    assert.equal(document.activeElement?.id, 'opener');
  } finally {
    await m.unmount();
  }
});

test('Escape in an open urgency menu closes the menu, not the popup', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    const chip = button('urgency')!;
    await m.React.act(async () => {
      chip.dispatchEvent(new m.dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await m.until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 'the urgency menu');
    await m.key(document.activeElement, { key: 'Escape' });
    await m.until(() => document.querySelectorAll('[role="menuitem"]').length === 0, 'the menu closed');
    assert.ok(dialog(), 'the popup stays open');
  } finally {
    await m.unmount();
  }
});

test('Tab is held inside the popup', async () => {
  const m = await mount();
  // jsdom lays nothing out: every element reads as invisible to the frame's focus filter.
  const proto = m.dom.window.HTMLElement.prototype;
  const original = Object.getOwnPropertyDescriptor(m.dom.window.Element.prototype, 'getClientRects');
  Object.defineProperty(proto, 'getClientRects', { configurable: true, value: () => [{}] });
  try {
    await renderPopup(m, IDEA);
    const focusable = Array.from(dialog()!.querySelectorAll<HTMLElement>('button:not([disabled]), input, textarea'));
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    last.focus();
    await m.key(last, { key: 'Tab' });
    assert.ok(document.activeElement === first, 'Tab on the last control comes back to the first');
    await m.key(first, { key: 'Tab', shiftKey: true });
    assert.ok(document.activeElement === last, 'Shift+Tab on the first goes to the last');
  } finally {
    delete (proto as unknown as Record<string, unknown>).getClientRects;
    if (original) Object.defineProperty(m.dom.window.Element.prototype, 'getClientRects', original);
    await m.unmount();
  }
});

test('the close button closes the popup', async () => {
  const m = await mount();
  try {
    await renderPopup(m, IDEA);
    await m.click(dialog()!.querySelector('button[aria-label="Close"]'));
    await m.until(() => !dialog(), 'the popup closed');
  } finally {
    await m.unmount();
  }
});

test('Save sends the edition through the host and keeps the popup open', async () => {
  const m = await mount();
  try {
    const record: string[] = [];
    await renderPopup(m, IDEA, record);
    await m.type(dialog()!.querySelector('textarea[aria-label="Title"]'), 'Unify the cards, both natures');
    const save = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Save');
    await m.click(save);
    await m.until(() => record.includes('saved'), 'the screen reads its ideas again');
    const patch = m.calls.find((c) => c.method === 'PATCH');
    assert.equal(patch?.url, '/api/ui/project-todo/209');
    assert.deepEqual(patch?.body, { text: 'Unify the cards, both natures', project: 'timon', notes: 'Some **context**', urgency: 'bug' },
      'an unchanged progress is not sent');
    assert.ok(dialog(), 'the popup stays open');
  } finally {
    await m.unmount();
  }
});

test('the hand-off goes through the host and closes the popup', async () => {
  const m = await mount();
  try {
    const record: string[] = [];
    await renderPopup(m, IDEA, record);
    const handoff = Array.from(dialog()!.querySelectorAll('button')).find((b) => /Send back to the orchestrator/.test(b.textContent ?? ''));
    await m.click(handoff);
    await m.until(() => !dialog(), 'the popup closed');
    assert.ok(m.calls.some((c) => c.method === 'POST' && c.url === '/api/ui/project-todo/209/handoff'));
  } finally {
    await m.unmount();
  }
});

test('the quick entry has the title focused, adds on Enter and closes', async () => {
  const m = await mount();
  try {
    const record: string[] = [];
    await renderPopup(m, null, record);
    const frame = dialog()!;
    assert.ok(frame.querySelector('[data-detail-shell]'));
    assert.equal(document.getElementById(frame.getAttribute('aria-labelledby')!)?.textContent, 'New idea');
    const title = frame.querySelector('input[placeholder="The idea, in one line"]');
    assert.ok(title && document.activeElement === title, 'the title has the focus');
    assert.equal((frame.querySelector('input[aria-label="project"]') as HTMLInputElement | null)?.value, 'timon');
    await m.type(title, 'A fresh idea');
    await m.key(title, { key: 'Enter' });
    await m.until(() => !dialog(), 'the popup closed');
    const post = m.calls.find((c) => c.method === 'POST');
    assert.equal(post?.url, '/api/ui/project-todo');
    assert.deepEqual(post?.body, { text: 'A fresh idea', project: 'timon', notes: null, urgency: null, progress: 'todo' });
    assert.deepEqual(record, ['saved', 'closed']);
  } finally {
    await m.unmount();
  }
});
