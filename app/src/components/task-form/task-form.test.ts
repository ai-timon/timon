/**
 * The product's task form (`task-form.tsx`) in its host, mounted in jsdom
 * against a stubbed daemon: the tabs and the keyboard, the focus held and
 * given back, the Markdown preview through the sanitiser, the files dropped
 * before the task exists and those of an edited task, and clearing a date.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { TaskFormSource } from './task-form-model';
import type { TaskAttachment } from '@/lib/task-attachments';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [{
    id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
    models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }, { slug: 'haiku', label: 'Haiku', presetRank: 2 }],
  }],
};

const AGENTS = [
  { name: 'timon.coder', project: 'timon', role: 'coder', backend: 'claude', model: 'opus' },
  { name: 'timon.reviewer', project: 'timon', role: 'reviewer', backend: 'claude', model: 'haiku' },
];

const STORED: TaskAttachment = {
  id: '0b8c3d6e-1f2a-4b5c-8d9e-0f1a2b3c4d5e', task_id: 'root', name: 'mockup.png', size: 2048, mime: 'image/png', kind: 'image', created_at: 1,
};

type Call = { method: string; url: string; body: Record<string, unknown> | null };

/** The daemon's own English text, which must never reach the screen. */
const DAEMON_TEXT = 'EIO: write failed at /var/lib/store';

async function mount(opts: { task?: TaskFormSource | null; attachments?: TaskAttachment[]; refuse?: boolean } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<button id="opener">open</button><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'HTMLAnchorElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event',
    'SubmitEvent', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // jsdom lays nothing out: every element counts as visible to the focus trap.
  dom.window.HTMLElement.prototype.getClientRects = function () { return [{}] as unknown as DOMRectList; };
  const calls: Call[] = [];
  const stored = [...(opts.attachments ?? [])];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    if (method !== 'GET') calls.push({ method, url, body });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.includes('/api/ui/backends/catalog')) return json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return json({ favorites: [] });
    if (url === '/api/ui/agents') return json({ agents: AGENTS });
    if (url === '/api/ui/skills') return json({ skills: [{ id: 'tdd' }, { id: 'git-publish' }] });
    if (url === '/api/ui/mcp') return json({ servers: [] });
    if (/\/attachments$/.test(url) && method === 'GET') return json({ attachments: stored });
    if (opts.refuse && /\/attachments(\/[^/]+)?$/.test(url) && method !== 'GET') {
      return json({ error: DAEMON_TEXT, code: 'attachment_failed' }, 500);
    }
    if (/\/attachments$/.test(url) && method === 'POST') {
      const taskId = /\/api\/ui\/tasks\/([^/]+)\//.exec(url)![1]!;
      return json({ attachment: { ...STORED, id: `a-${calls.length}`, task_id: taskId, name: String(body?.name) } }, 201);
    }
    if (/\/attachments\/[^/]+$/.test(url) && method === 'DELETE') return json({ ok: true });
    if (url === '/api/ui/tasks' && method === 'POST') return json({ task: { id: 'new-task' } }, 201);
    if (url.startsWith('/api/ui/tasks/') && method === 'PUT') return json({ task: {} });
    if (url === '/api/ui/tasks') return json({ tasks: [{ id: 'dep-1', title: 'Write the routes', status: 'PENDING' }, { id: 'old', title: 'Old', status: 'DONE' }] });
    return json({ error: 'not found' }, 404);
  });
  install('URL', Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} }));

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  invalidateBackendCatalog();
  const { TaskFormModal } = await import('../task-form-modal');

  const opener = document.getElementById('opener') as HTMLButtonElement;
  opener.focus();
  let closed = 0;
  let savedCount = 0;
  const root = createRoot(document.getElementById('root')!);
  const show = async (visible: boolean) => {
    await React.act(async () => {
      root.render(visible ? React.createElement(TaskFormModal, {
        task: opts.task ?? null,
        defaultAgent: opts.task ? undefined : 'timon.coder',
        agents: [{ name: 'timon.coder' }, { name: 'timon.reviewer' }],
        onSaved: () => { savedCount++; },
        onClose: () => { closed++; },
      }) : null);
    });
  };
  await show(true);

  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  const tab = (name: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="tab"]')).find((b) => b.textContent?.startsWith(name));
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const key = async (target: Element | null, init: KeyboardEventInit) => {
    assert.ok(target, 'key target');
    await React.act(async () => { target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })); });
  };
  const setValue = async (el: HTMLInputElement | HTMLTextAreaElement | null, value: string) => {
    assert.ok(el, 'field');
    const proto = el instanceof dom.window.HTMLTextAreaElement ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const addFiles = async (files: File[]) => {
    const input = $<HTMLInputElement>('[data-attachment-input]');
    assert.ok(input, 'the file input');
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await React.act(async () => { input.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
  };
  const title = () => document.getElementById(Array.from(document.querySelectorAll('label')).find((l) => l.textContent === 'Title')!.htmlFor) as HTMLInputElement;
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await new Promise((r) => setTimeout(r, 0));
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return {
    React, dom, calls, opener, $, button, tab, click, key, setValue, addFiles, title, until, show, unmount,
    closed: () => closed, saved: () => savedCount,
  };
}

const TASK: TaskFormSource = {
  id: 'edited-task', title: 'Fix it', agent_name: 'timon.coder', status: 'PENDING', priority: 3, deps: '[]', type: 'code',
  scheduled_at: Date.UTC(2026, 10, 2, 9, 0), effective_backend: 'claude', effective_model: 'opus',
};

test('three tabs, the arrows move between them and each shows its own panel', async () => {
  const m = await mount();
  try {
    const dialog = m.$('[role="dialog"]');
    assert.equal(dialog?.getAttribute('aria-modal'), 'true');
    assert.equal(document.getElementById(dialog!.getAttribute('aria-labelledby')!)?.textContent, 'New task');
    const tabs = Array.from(document.querySelectorAll('[role="tab"]')).map((b) => b.textContent);
    assert.deepEqual(tabs, ['General', 'Dependencies', 'Capabilities']);
    assert.equal(m.tab('General')?.getAttribute('aria-selected'), 'true');
    await m.key(m.tab('General')!, { key: 'ArrowRight' });
    assert.equal(m.tab('Dependencies')?.getAttribute('aria-selected'), 'true');
    assert.equal(document.activeElement, m.tab('Dependencies'), 'the focus follows');
    const panel = document.getElementById(m.tab('Dependencies')!.getAttribute('aria-controls')!);
    assert.equal(panel?.hidden, false);
    // The attribute alone loses to a `flex` utility: an inactive panel carries `hidden` as a class too.
    const general = document.getElementById(m.tab('General')!.getAttribute('aria-controls')!);
    assert.equal(general?.hidden, true);
    assert.equal(general?.className, 'hidden');
    await m.key(m.tab('Dependencies')!, { key: 'ArrowLeft' });
    await m.key(m.tab('General')!, { key: 'ArrowLeft' });
    assert.equal(m.tab('Capabilities')?.getAttribute('aria-selected'), 'true', 'the arrows wrap');
    await m.key(m.tab('Capabilities')!, { key: 'Home' });
    assert.equal(m.tab('General')?.getAttribute('aria-selected'), 'true');

    // Checking a dependency counts on its tab; a finished task is not offered.
    await m.click(m.tab('Dependencies'));
    await m.until(() => !!m.$('[data-dep="dep-1"]'), 'the candidates');
    assert.equal(m.$('[data-dep="old"]'), null);
    await m.click(m.$('[data-dep="dep-1"] input'));
    assert.equal(m.tab('Dependencies')?.textContent, 'Dependencies1');
  } finally {
    await m.unmount();
  }
});

test('Escape closes the form and the focus goes back to what opened it', async () => {
  const m = await mount();
  try {
    await m.until(() => document.activeElement === m.title(), 'the title focused on open');
    await m.key(m.title(), { key: 'Escape' });
    assert.equal(m.closed(), 1);
    await m.show(false);
    assert.equal(document.activeElement, m.opener);
  } finally {
    await m.unmount();
  }
});

test('Tab stays inside the form', async () => {
  const m = await mount();
  try {
    const save = m.button('Create task')!;
    save.focus();
    await m.key(save, { key: 'Tab' });
    assert.equal(document.activeElement?.getAttribute('aria-label'), 'Close', 'from the last control to the first');
    await m.key(document.activeElement, { key: 'Tab', shiftKey: true });
    assert.equal(document.activeElement, save, 'and back');
  } finally {
    await m.unmount();
  }
});

test('no title, nothing is sent and the field says why', async () => {
  const m = await mount();
  try {
    await m.click(m.button('Create task'));
    assert.equal(m.calls.length, 0);
    assert.equal(m.title().getAttribute('aria-invalid'), 'true');
    assert.ok(document.body.textContent?.includes('Give the task a title.'));
  } finally {
    await m.unmount();
  }
});

test('the description previews its Markdown through the sanitiser', async () => {
  const m = await mount();
  try {
    const area = m.$<HTMLTextAreaElement>('textarea');
    await m.setValue(area, '**bold** <img src=x onerror="alert(1)"> <script>alert(2)</script>');
    const toggle = (label: string) => m.$(`button[aria-label="${label}"]`);
    assert.equal(toggle('Write')?.getAttribute('aria-pressed'), 'true', 'an empty description opens ready to write');
    await m.click(toggle('Preview'));
    const preview = m.$('[data-task-description-preview]');
    assert.ok(preview?.querySelector('strong'), 'Markdown is rendered');
    assert.ok(!preview?.querySelector('script'));
    assert.ok(!preview?.querySelector('[onerror]'), 'no handler survives');
    await m.click(toggle('Write'));
    assert.match(m.$<HTMLTextAreaElement>('textarea')?.value ?? '', /\*\*bold\*\*/, 'the source is kept');
  } finally {
    await m.unmount();
  }
});

test('a file dropped before the task exists is sent once it is created; a refused type never leaves', async () => {
  const m = await mount();
  try {
    await m.setValue(m.title(), 'New thing');
    await m.addFiles([new File([new Uint8Array([1, 2])], 'mockup.png', { type: 'image/png' }), new File(['<svg/>'], 'logo.svg')]);
    assert.ok(m.$('[data-attachment-drop] [data-attachment="mockup.png"]'), 'queued, inside the drop zone');
    assert.ok(document.body.textContent?.includes('Sent when the task is created'));
    assert.match(m.$('[role="alert"]')?.textContent ?? '', /logo\.svg: this type of file is not accepted/);
    assert.equal(m.tab('General')?.textContent, 'General1', 'the tab counts the file');
    await m.click(m.button('Create task'));
    await m.until(() => m.closed() === 1, 'the form to close');
    assert.deepEqual(m.calls.map((c) => `${c.method} ${c.url}`), ['POST /api/ui/tasks', 'POST /api/ui/tasks/new-task/attachments']);
    assert.equal(m.calls[0]?.body?.agent_name, 'timon.coder');
    assert.equal(m.calls[0]?.body?.pipeline, undefined, 'a chore has no pipeline');
    assert.equal(m.calls[1]?.body?.name, 'mockup.png');
    assert.equal(m.saved(), 1);
  } finally {
    await m.unmount();
  }
});

test('an edited task lists its files, sends a new one at once and removes one', async () => {
  const m = await mount({ task: TASK, attachments: [STORED] });
  try {
    await m.until(() => !!m.$('[data-attachment="mockup.png"]'), 'the stored file');
    assert.equal(m.$('[data-attachment="mockup.png"] img')?.getAttribute('src'), `/api/ui/tasks/root/attachments/${STORED.id}`);
    assert.ok(document.body.textContent?.includes('From an earlier iteration'), 'owned by the root of the chain');
    // A click on the thumbnail shows it large; Escape closes that, not the form.
    await m.click(m.$('[data-attachment="mockup.png"] button'));
    const enlarged = m.$('[aria-label="mockup.png, enlarged"]');
    assert.ok(enlarged);
    await m.key(document.activeElement, { key: 'Escape' });
    assert.equal(m.$('[aria-label="mockup.png, enlarged"]'), null);
    assert.equal(m.closed(), 0);

    await m.addFiles([new File(['# notes'], 'notes.md', { type: 'text/markdown' })]);
    await m.until(() => m.calls.some((c) => c.url === '/api/ui/tasks/edited-task/attachments'), 'the upload');
    await m.until(() => !document.body.textContent?.includes('Sending…'), 'the upload to end');
    await m.click(m.$('[aria-label="Remove mockup.png"]'));
    await m.until(() => !m.$('[data-attachment="mockup.png"]'), 'the removal');
    assert.ok(m.calls.some((c) => c.method === 'DELETE' && c.url === `/api/ui/tasks/root/attachments/${STORED.id}`));
  } finally {
    await m.unmount();
  }
});

test('a refused upload or removal is told in the interface\'s words, never the daemon\'s', async () => {
  const m = await mount({ task: TASK, attachments: [STORED], refuse: true });
  try {
    await m.until(() => !!m.$('[data-attachment="mockup.png"]'), 'the stored file');
    await m.addFiles([new File(['# notes'], 'notes.md', { type: 'text/markdown' })]);
    await m.until(() => /notes\.md: could not be sent\./.test(m.$('[role="alert"]')?.textContent ?? ''), 'the upload refusal');
    assert.equal(m.$('[data-attachment="notes.md"]'), null, 'the refused file left the list');
    await m.click(m.$('[aria-label="Remove mockup.png"]'));
    await m.until(() => /Could not remove mockup\.png\./.test(m.$('[role="alert"]')?.textContent ?? ''), 'the removal refusal');
    assert.ok(m.$('[data-attachment="mockup.png"]'), 'the refused removal keeps the file');
    assert.ok(!document.body.textContent?.includes(DAEMON_TEXT), 'the daemon text stays off screen');
  } finally {
    await m.unmount();
  }
});

test('clearing the date of an edited task asks the daemon to clear it', async () => {
  const m = await mount({ task: TASK });
  try {
    // The start date sits in the right column, beside every tab.
    const aside = m.$('aside');
    assert.ok(aside?.querySelector('[data-date-time-picker]'), 'the schedule block, drawn by the product');
    assert.ok(aside?.querySelector('[data-model-chip]'), 'the model picker');
    assert.equal(aside?.querySelectorAll('[data-model-chip]').length, 2, 'the fallback has its own unified picker');
    assert.ok(!aside?.querySelector('select'), 'no native select left on the right');
    const typeSelect = aside?.querySelector<HTMLButtonElement>('button[aria-label^="Type:"]');
    assert.ok(typeSelect?.querySelector('svg'), 'the type shows its icon');
    await m.click(typeSelect);
    await m.until(() => !!m.$('[data-choice="merge"]'), 'the type list');
    await m.click(m.$('[data-choice="merge"]'));
    assert.match(aside?.querySelector('button[aria-label^="Type:"]')?.getAttribute('aria-label') ?? '', /merge/, 'a pick changes the type');
    assert.ok(aside?.querySelector('button[aria-label^="Permission:"]'), 'the permission sits with the models');
    assert.equal(m.$('[role="tabpanel"] [aria-pressed][aria-label="Type"]'), null);
    await m.click(m.$('button[aria-label="Clear the date"]'));
    await m.click(m.button('Save'));
    await m.until(() => m.calls.some((c) => c.method === 'PUT'), 'the save');
    const put = m.calls.find((c) => c.method === 'PUT')!;
    assert.equal(put.url, '/api/ui/tasks/edited-task');
    assert.equal(put.body?.scheduled_at, null);
    assert.equal(put.body?.clear_scheduled_at, true);
    assert.equal('pipeline' in (put.body ?? {}), false, 'an edition never sends a pipeline');
  } finally {
    await m.unmount();
  }
});

test('the agent picker lists every agent with its role and searches them; the model chip names what "inherit" runs on', async () => {
  const m = await mount({ task: TASK });
  try {
    assert.equal(m.tab('Execution'), undefined, 'no Execution tab: its controls sit in the right column');
    await m.until(() => /timon\.coder/.test(m.$('[data-agent-picker]')?.textContent ?? ''), 'the picker to name the agent');
    await m.click(m.$('[data-agent-picker]'));
    await m.until(() => !!m.$('[data-agent-card="timon.reviewer"]'), 'the agent list');
    assert.equal(m.$('[data-agent-card="timon.coder"]')?.getAttribute('aria-selected'), 'true');
    assert.match(m.$('[data-agent-card="timon.reviewer"]')?.textContent ?? '', /reviewer/);
    await m.setValue(m.$<HTMLInputElement>('[data-agent-search]'), 'review');
    assert.ok(!m.$('[data-agent-card="timon.coder"]'), 'the search filters the list');
    await m.until(() => m.$('[data-model-chip]')?.textContent === 'Opus (inherited)', 'the inherited model');
    // Given to another agent, the task inherits that agent's model.
    await m.click(m.$('[data-agent-card="timon.reviewer"]'));
    assert.ok(!m.$('[data-agent-card]'), 'a pick closes the list');
    await m.until(() => m.$('[data-model-chip]')?.textContent === 'Haiku (inherited)', 'the new agent\'s model');
    await m.click(m.button('Save'));
    await m.until(() => m.calls.some((c) => c.method === 'PUT'), 'the save');
    assert.equal(m.calls.find((c) => c.method === 'PUT')?.body?.agent_name, 'timon.reviewer');
  } finally {
    await m.unmount();
  }
});

test('an edited task can inherit its fallback and permission again from the popup', async () => {
  const m = await mount({ task: {
    ...TASK, fallback_backend_override: 'claude', fallback_model_override: 'haiku', permission_mode_override: 'plan',
  } });
  try {
    await m.until(() => document.querySelectorAll('[data-model-chip]')[1]?.textContent === 'Haiku', 'the stored fallback');
    assert.ok(!document.body.textContent?.includes('not removed'), 'no obsolete removal warning');
    await m.click(document.querySelectorAll('[data-model-chip]')[1]);
    const inherit = () => Array.from(document.querySelectorAll('[data-picker-row]'))
      .find((row) => row.textContent?.includes('Series or global setting'));
    await m.until(() => !!inherit(), 'the inherited fallback option even with a stored fallback');
    await m.click(inherit());
    assert.equal(document.querySelectorAll('[data-model-chip]')[1]?.textContent, 'Series or global setting');
    await m.click(m.$('button[aria-label^="Permission:"]'));
    await m.until(() => !!m.$('[data-choice="default"]'), 'the inherited permission option');
    assert.equal(m.$('[data-choice="default"]')?.textContent, 'Inherited from agent');
    await m.click(m.$('[data-choice="default"]'));
    await m.click(m.button('Save'));
    await m.until(() => m.calls.some((c) => c.method === 'PUT'), 'the reset request');
    const body = m.calls.find((c) => c.method === 'PUT')!.body!;
    assert.equal(body.clear_fallback, true);
    assert.equal(body.fallback_backend_override, null);
    assert.equal(body.fallback_model_override, null);
    assert.equal(body.clear_permission_mode, true);
    assert.equal(body.permission_mode_override, null);
  } finally { await m.unmount(); }
});

test('unchecking a stored never-fallback restores inheritance', async () => {
  const m = await mount({ task: { ...TASK, fallback_backend_override: 'none' } });
  try {
    const checkbox = m.$<HTMLInputElement>('aside input[type="checkbox"]');
    assert.equal(checkbox?.checked, true);
    await m.click(checkbox);
    await m.click(m.button('Save'));
    await m.until(() => m.calls.some((c) => c.method === 'PUT'), 'the reset request');
    assert.equal(m.calls.find((c) => c.method === 'PUT')!.body!.clear_fallback, true);
    assert.equal(m.calls.find((c) => c.method === 'PUT')!.body!.fallback_backend_override, null);
  } finally { await m.unmount(); }
});

test('saving stored overrides without changing them sends no reset sentinel', async () => {
  const m = await mount({ task: {
    ...TASK, fallback_backend_override: 'claude', fallback_model_override: 'haiku', permission_mode_override: 'plan',
  } });
  try {
    await m.click(m.button('Save'));
    await m.until(() => m.calls.some((c) => c.method === 'PUT'), 'the save');
    const body = m.calls.find((c) => c.method === 'PUT')!.body!;
    assert.equal(body.fallback_backend_override, 'claude');
    assert.equal(body.fallback_model_override, 'haiku');
    assert.equal(body.permission_mode_override, 'plan');
    assert.equal('clear_fallback' in body, false);
    assert.equal('clear_permission_mode' in body, false);
  } finally { await m.unmount(); }
});

test('the popup lays its zones out on DetailShell: header, body, attachments, rail and footer', async () => {
  const m = await mount({ task: TASK, attachments: [STORED] });
  try {
    const shell = m.$('form > [data-detail-shell]');
    assert.ok(shell, 'the shell sits inside the form, so the footer still submits it');
    assert.match(m.$('[data-detail-shell-header]')?.textContent ?? '', /edited-t/, 'the header names the task');
    assert.ok(m.$('[data-detail-shell-header] [aria-label="Close"]'), 'and closes it');
    assert.ok(m.$('[data-detail-shell-body] [role="tablist"]'), 'the tabs in the body');
    assert.ok(m.$('[data-detail-shell-body] [role="tabpanel"]'), 'their panels too');
    assert.equal(m.$('[role="tabpanel"] [data-attachment-drop]'), null, 'the files left the General tab');
    await m.until(() => !!m.$('[data-detail-shell-attachments] [data-attachment-drop] [data-attachment="mockup.png"]'), 'the stored file in its own zone');
    assert.equal(m.$('[data-detail-shell-attachments]')?.getAttribute('aria-label'), 'Attachments');
    // Another tab keeps the files in view.
    await m.click(m.tab('Dependencies'));
    assert.ok(m.$('[data-detail-shell-attachments] [data-attachment="mockup.png"]'));

    const rail = m.$('aside[data-detail-shell-rail]');
    assert.equal(rail?.getAttribute('aria-label'), 'Summary');
    assert.ok(rail?.className.includes('timon-island'), 'the rail is one island');
    assert.equal(rail?.querySelectorAll('.timon-island').length, 0, 'with no island nested in it');
    assert.ok(rail?.querySelector('[data-agent-picker]') && rail.querySelector('[data-date-time-picker]') && rail.querySelector('[data-model-chip]'));

    const footer = m.$('[data-detail-shell-footer]');
    const buttons = Array.from(footer?.querySelectorAll('button') ?? []).map((b) => b.textContent?.trim());
    assert.deepEqual(buttons, ['Cancel', 'Save']);
    assert.equal(footer?.querySelector('button[type="submit"]')?.closest('form'), m.$('form'));
  } finally {
    await m.unmount();
  }
});
