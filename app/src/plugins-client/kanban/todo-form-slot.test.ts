/**
 * The TO DO idea form's slot `todo.form` (TODO #837), the twin of `task.form`:
 * declared at boot, the product's dialogs are painted while nothing claims
 * it, a plugin loaded through the real client loader is painted inside the
 * host's frame, reads the idea with `useTodoForm()` and saves through the
 * host, and its removal gives the product's dialog back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { TodoFormValue } from './todo-form-context';
import type { ProjectTodo } from './project-todo-types';

const ACME = { id: 'acme-todo-form', state: 'active', client: { url: '/x', rev: '1', slots: ['todo.form'] } };

const IDEA: ProjectTodo = {
  id: 209, text: 'Unify the cards', project: 'timon', author: 'Robin', status: 'open', notes: 'Both natures',
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: 'idea', progress: 'analyzed',
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };

async function mount(plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent',
    'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null });
    if (url === '/api/ui/plugins') return Response.json({ plugins });
    if (url === '/api/ui/project-todo' && method === 'POST') return Response.json({ item: { ...IDEA, id: 210 } }, { status: 201 });
    if (url === `/api/ui/project-todo/${IDEA.id}` && method === 'PATCH') return Response.json({ item: IDEA });
    if (url === `/api/ui/project-todo/${IDEA.id}/handoff`) return Response.json({ to_agent: 'timon.main' });
    if (url.startsWith('/api/ui/tasks')) return Response.json({ tasks: [] });
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { TodoFormModal } = await import('./todo-form-modal');
  const { ProductTodoForm } = await import('./product-todo-form');
  const context = await import('./todo-form-context');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');

  const root = createRoot(document.getElementById('root')!);
  let finished = 0;
  let closed = 0;
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const host = (item: ProjectTodo | null = null) => React.createElement(TodoFormModal, {
    item, defaultProject: 'timon', onSaved: () => { finished++; }, onClose: () => { closed++; },
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  /** The label of the product's dialog on screen — the detail's "Save" or the quick entry's "Add" —, if any.
   *  A text, never an element: `assert` would inspect a jsdom node, whose graph exhausts the memory. */
  const productForm = (): string | undefined => Array.from(document.querySelectorAll('button'))
    .filter((b) => !b.hasAttribute('data-plain-save') && !b.hasAttribute('data-acme-save'))
    .map((b) => b.textContent?.trim() ?? '')
    .find((text) => /^(Save|Add)$/.test(text));
  const occupants = () => slots.slotEntries('todo.form').map((e) => e.pluginId);
  const registerProduct = () => slots.register({ slot: 'todo.form', fallback: true, pluginId: '@timon/kanban' }, ProductTodoForm);

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    await new Promise((r) => setTimeout(r, 0));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return {
    React, dom, calls, context, slots, loader, UI_KIT, render, host, until, click, productForm, occupants, registerProduct, unmount,
    finished: () => finished, closed: () => closed,
  };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function acmeForm(m: Mounted, seen: Array<TodoFormValue | null>): ComponentType {
  const { React, context } = m;
  return function AcmeForm() {
    const host = context.useTodoForm();
    seen.push(host);
    if (!host) return null;
    return React.createElement('div', { 'data-acme': host.mode },
      React.createElement('h2', { id: host.titleId }, 'Acme idea'),
      React.createElement('button', {
        type: 'button', 'data-acme-save': '',
        onClick: () => void host.submit({
          text: 'From acme', project: host.item?.project ?? host.defaultProject, notes: host.item?.notes ?? null,
          urgency: host.item?.urgency ?? null, progress: 'analyzed',
        }).then((r) => { if (r.ok) host.finish(); }),
      }, 'save'),
      host.handoff && React.createElement('button', { type: 'button', 'data-acme-handoff': '', onClick: () => void host.handoff?.() }, 'hand off'));
  };
}

test('the slot is declared at boot, and an empty slot still paints the product dialogs', async () => {
  const m = await mount();
  try {
    assert.equal(m.slots.slotKind('todo.form'), 'single');
    await m.render(m.host(IDEA));
    await m.until(() => m.productForm() === 'Save', 'the product detail');
    const dispose = m.registerProduct();
    assert.equal(m.slots.slotEntries('todo.form')[0]?.fallback, true);
    await m.render(m.host(null));
    await m.until(() => m.productForm() === 'Add', 'the product quick entry through the slot');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('the kanban module registers the product form as the fallback of todo.form', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'kanban.tsx'), 'utf8');
  assert.match(source, /ctx\.register\(\{ slot: TODO_FORM_SLOT, fallback: true \}, ProductTodoForm\)/);
});

test('a plugin takes the slot inside the host frame, reads the idea, saves and hands off through it, and its removal gives the product form back', async () => {
  const m = await mount([ACME]);
  const seen: Array<TodoFormValue | null> = [];
  try {
    const dispose = m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'todo.form' }, acmeForm(m, seen)); },
    }));
    await m.loader.syncClientPlugins();
    assert.equal(m.occupants()[0], 'acme-todo-form', 'the replacement wins over the fallback');
    await m.render(m.host(IDEA));
    await m.until(() => !!document.querySelector('[data-acme="edit"]'), 'the replacement');
    assert.equal(m.productForm(), undefined, 'the product form is not painted under it');
    const dialog = document.querySelector('[role="dialog"]');
    assert.equal(document.getElementById(dialog!.getAttribute('aria-labelledby')!)?.textContent, 'Acme idea', 'the host frames it');
    const value = seen.find((v) => v)!;
    assert.equal(value.item?.id, 209);
    assert.equal(value.remove, null, 'no deletion where the screen offers none');

    await m.click(document.querySelector('[data-acme-save]'));
    await m.until(() => m.finished() === 1 && m.closed() === 1, 'the screen told to re-read, the form closed');
    const patch = m.calls.find((c) => c.method === 'PATCH')!;
    assert.equal(patch.url, '/api/ui/project-todo/209');
    assert.equal(patch.body?.text, 'From acme');
    assert.ok(!('progress' in (patch.body ?? {})), 'an unchanged progress is not sent: it would move the done checkbox');

    await m.click(document.querySelector('[data-acme-handoff]'));
    await m.until(() => m.calls.some((c) => c.url === '/api/ui/project-todo/209/handoff'), 'the hand-off');

    await m.React.act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new (globalThis.KeyboardEvent)('keydown', { key: 'Escape', bubbles: true })); });
    assert.equal(m.closed(), 2, 'Escape closes through the frame');

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    await m.until(() => m.productForm() === 'Save', 'the product form back');
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('a new idea is created through the host, with its default project and no hand-off', async () => {
  const m = await mount([ACME]);
  const seen: Array<TodoFormValue | null> = [];
  try {
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'todo.form' }, acmeForm(m, seen)); },
    }));
    await m.loader.syncClientPlugins();
    await m.render(m.host(null));
    await m.until(() => !!document.querySelector('[data-acme="create"]'), 'the replacement in creation');
    assert.ok(!document.querySelector('[data-acme-handoff]'));
    await m.click(document.querySelector('[data-acme-save]'));
    await m.until(() => m.finished() === 1, 'the save');
    const post = m.calls.find((c) => c.method === 'POST')!;
    assert.equal(post.url, '/api/ui/project-todo');
    assert.deepEqual(post.body, { text: 'From acme', project: 'timon', notes: null, urgency: null, progress: 'analyzed' });
    assert.equal(m.UI_KIT.useTodoForm, m.context.useTodoForm);
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-todo-form`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-todo-form', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__todoFormTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__todoFormTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __todoFormTestReact: React, __todoFormTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'plugin-todo-form-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Registers the example as the loader would, under its manifest id. */
function applyExample(m: { slots: typeof import('@/lib/plugin-host/slots') }, example: { apply: (ctx: unknown) => void }, id: string): Array<() => void> {
  const disposers: Array<() => void> = [];
  example.apply({
    id,
    slots: { register: (options: { slot: string }, Component: ComponentType) => {
      const dispose = m.slots.register({ ...options, pluginId: id }, Component);
      disposers.push(dispose);
      return dispose;
    } },
  });
  return disposers;
}

test('the examples/plugin-todo-form template edits an idea with the SDK alone, inside the host frame', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposeProduct = m.registerProduct();
    const disposers = applyExample(m, example, 'example-todo-form');
    assert.equal(m.occupants()[0], 'example-todo-form');
    await m.render(m.host(IDEA));
    await m.until(() => !!document.querySelector('[data-plain-save]'), 'the plain form');
    assert.equal(m.productForm(), undefined);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.ok(dialog.querySelector('[data-detail-shell]'), 'laid out on DetailShell inside the frame');
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent, 'Idea #209');
    await m.click(document.querySelector('[data-plain-save]'));
    await m.until(() => m.finished() === 1, 'the save');
    const patch = m.calls.find((c) => c.method === 'PATCH')!;
    assert.deepEqual(patch.body, { text: 'Unify the cards', project: 'timon', notes: 'Both natures', urgency: 'idea' });
    await m.click(document.querySelector('[data-plain-handoff]'));
    await m.until(() => document.querySelector('[role="status"]')?.textContent === 'Handed off to timon.main', 'the hand-off answer');
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    await m.until(() => m.productForm() === 'Save', 'the product form back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
