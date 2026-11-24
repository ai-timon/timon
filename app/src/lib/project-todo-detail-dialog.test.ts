// french-ok-file: idea and task titles as a French user writes them
import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * The detail dialog of an idea lists the tasks that carry it (`todo_id`):
 * they are what will close it once merged.
 */
async function mountDialog(tasks: unknown[], calls: string[], bodies: unknown[] = [], extra: Record<string, unknown> = {}) {
  const { JSDOM } = await import('jsdom');
  // Radix Dialog (portal, focus scope) needs the wider set of DOM globals.
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
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  install('fetch', async (input: string, init?: RequestInit) => {
    calls.push(String(input));
    if (init?.body) bodies.push(JSON.parse(String(init.body)));
    return Response.json({ tasks });
  });
  const { TodoFormModal } = await import('../plugins-client/kanban/todo-form-modal');
  const item = {
    id: 42, text: 'idée', project: 'timon', author: 'Robin', status: 'promoted', notes: null,
    created_at: 1, updated_at: 1, done_at: null, promoted_task_id: 't-1', urgency: null, progress: 'todo', ...extra,
  };
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(TodoFormModal, {
      item, onClose: () => {}, onSaved: () => {},
    } as never));
  });
  return { React, root };
}

test('the dialog lists the tasks linked to the idea', async () => {
  const calls: string[] = [];
  const { React, root } = await mountDialog([
    { id: 't-1', title: 'Implémenter l\'idée', type: 'code', status: 'IN_PROGRESS' },
  ], calls);
  // The popup also reads the idea's attachments: only the tasks call counts here.
  assert.deepEqual(calls.filter((u) => u.startsWith('/api/ui/tasks')), ['/api/ui/tasks?todo_id=42']);
  assert.match(document.body.textContent!, /linked tasks/);
  assert.match(document.body.textContent!, /Implémenter l'idée/);
  assert.match(document.body.textContent!, /code · IN_PROGRESS/);
  await React.act(async () => { root.unmount(); });
});

test('no linked task, no field', async () => {
  const { React, root } = await mountDialog([], []);
  assert.doesNotMatch(document.body.textContent!, /linked tasks/);
  await React.act(async () => { root.unmount(); });
});

test('a plugin block in kanban.todo.detail reads the idea it is shown with', async () => {
  const { declareSlot, register, slotKind } = await import('./plugin-host/slots');
  const { useTodoDetail } = await import('../plugins-client/kanban/todo-detail-slot');
  const undo: Array<() => void> = [];
  if (slotKind('kanban.todo.detail') === null) undo.push(declareSlot('kanban.todo.detail', 'list'));
  function Block() {
    const detail = useTodoDetail();
    return detail ? `plugin block for #${detail.item.id}` : null;
  }
  undo.push(register({ slot: 'kanban.todo.detail', pluginId: 'test/block' }, Block));
  try {
    const { React, root } = await mountDialog([], []);
    assert.match(document.body.textContent!, /plugin block for #42/);
    await React.act(async () => { root.unmount(); });
  } finally { for (const fn of undo.reverse()) fn(); }
});

test('the dialog shows the idea\'s external links, and never an href that is not http(s)', async () => {
  const { React, root } = await mountDialog([], [], [], {
    links: [
      { provider: 'github', ref: 'acme/app#12', url: 'https://github.com/acme/app/issues/12', label: 'Issue #12', plugin_id: null, created_at: 1 },
      { provider: 'discord', ref: 'thread-9', url: null, label: null, plugin_id: null, created_at: 2 },
      { provider: 'evil', ref: 'x', url: 'javascript:alert(1)', label: 'Click', plugin_id: null, created_at: 3 },
    ],
  });
  const anchors = Array.from(document.querySelectorAll('a'));
  const issue = anchors.find((a) => a.textContent === 'Issue #12');
  assert.ok(issue);
  assert.equal(issue.getAttribute('href'), 'https://github.com/acme/app/issues/12');
  assert.equal(issue.getAttribute('target'), '_blank');
  assert.equal(issue.getAttribute('rel'), 'noopener noreferrer');
  assert.match(document.body.textContent!, /discord · thread-9/);
  assert.match(document.body.textContent!, /Click/);
  assert.ok(!anchors.some((a) => (a.getAttribute('href') ?? '').startsWith('javascript:')));
  await React.act(async () => { root.unmount(); });
});

test('no external link, no field', async () => {
  const { React, root } = await mountDialog([], []);
  assert.doesNotMatch(document.body.textContent!, /elsewhere/);
  await React.act(async () => { root.unmount(); });
});

test('urgency and progress are one chip each, and the vocabulary opens from it', async () => {
  const { React, root } = await mountDialog([], [], [], { progress: 'analyzed', urgency: 'bug' });
  const chip = (label: string) => document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const progress = chip('progress');
  assert.ok(progress);
  assert.match(progress.textContent!, /Analyzed/);
  assert.match(chip('urgency')!.textContent!, /Bug/);
  // Closed, the other values are not on screen: one chip, not a row of five.
  assert.doesNotMatch(document.body.textContent!, /Partially done/);
  await React.act(async () => {
    progress.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  });
  const items = Array.from(document.querySelectorAll('[role="menuitem"]')).map((el) => el.textContent);
  assert.deepEqual(items, ['To do', 'Analyzed', 'Partially done', 'To test', 'Done']);
  await React.act(async () => { root.unmount(); });
});

test('the author is not named twice when a connector already carries it', async () => {
  const { React, root } = await mountDialog([], [], [], {
    author: 'discord',
    links: [{ provider: 'discord', ref: 'TIM-0070', url: null, label: 'TIM-0070', plugin_id: null, created_at: 1 }],
  });
  const chips = Array.from(document.querySelectorAll('span')).filter((el) => el.textContent === 'discord');
  assert.equal(chips.length, 0);
  await React.act(async () => { root.unmount(); });
});

test('the save button stays in the footer, whatever the length of the description', async () => {
  const { React, root } = await mountDialog([], [], [], { notes: 'x\n'.repeat(400) });
  const footer = document.querySelector('footer');
  assert.ok(footer);
  assert.ok(Array.from(footer.querySelectorAll('button')).some((b) => /Save/.test(b.textContent ?? '')));
  await React.act(async () => { root.unmount(); });
});
