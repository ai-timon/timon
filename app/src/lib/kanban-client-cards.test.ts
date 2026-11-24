import assert from 'node:assert/strict';
import { waitUntil } from './test-wait';
import test from 'node:test';

/**
 * The Kanban card as rendered by the real `KanbanClient`: the agent's own
 * avatar and role, the running dot and time, the model logo, the linked
 * idea's tags, the "Scheduled" line and the footer counts. `kanban-card.test.ts`
 * covers the arithmetic; this checks each piece lands on the right card.
 *
 * Same harness and teardown as `kanban-client-graph.test.ts` — see its header
 * for why absence is asserted on booleans.
 */
test('a card shows its agent, model, idea tags, schedule and dependency counts', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/kanban' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const now = Date.now();
  const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
    id, title, agent_name: 'demo.coder', status: 'PENDING', priority: 3, deps: '[]',
    created_at: now, updated_at: now, type: 'code', effective_backend: 'claude', effective_model: 'opus', ...extra,
  });
  const tasks = [
    task('base-aaaaaa', 'Foundation', {
      status: 'IN_PROGRESS', mission_id: 'm-1', started_at: now - 26 * 60_000,
      dependents: [{ id: 'next-bbbbbb', kind: 'dep' }, { id: 'old-dddddd', kind: 'dep' }],
    }),
    task('next-bbbbbb', 'Follow-up', {
      deps: '["base-aaaaaa","old-dddddd","gone-eeeeee"]', priority: 4, todo_id: 42,
      scheduled_at: new Date(2026, 10, 2, 9, 0).getTime(), attachment_count: 2,
    }),
    task('old-dddddd', 'Finished earlier', { status: 'DONE', effective_backend: 'nobody', effective_model: null }),
  ];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith('/api/ui/tasks?')) return Response.json({ tasks, view: 'board', done_total: 1 });
    if (url === '/api/ui/agents') {
      return Response.json({ agents: [{ name: 'demo.coder', project: null, role: 'coder', icon_url: '/api/uploads/coder.png' }] });
    }
    if (url === '/api/ui/agents/active') return Response.json({ agents: [{ name: 'demo.coder', state: 'thinking', mission_id: 'm-1' }] });
    if (url.startsWith('/api/ui/project-todo')) {
      return Response.json({ items: [{ id: 42, text: 'An idea', status: 'promoted', urgency: 'bug', progress: 'partial' }] });
    }
    if (url.startsWith('/api/ui/backends/catalog')) {
      return Response.json({
        defaultBackend: 'claude',
        backends: [{ id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus' }] }],
      });
    }
    return Response.json({ agents: [], projects: [] });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { resetSlotsForTests } = await import('./plugin-host/slots');
  resetSlotsForTests();
  const { KanbanClient } = await import('../plugins-client/kanban/kanban-page');

  const router = { back() {}, forward() {}, refresh() {}, prefetch() {}, push() {}, replace() {} };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const card = (id: string) => document.querySelector(`[data-task-card="${id}"]`);
  const text = (id: string) => card(id)?.textContent ?? '';

  await React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router }, React.createElement(KanbanClient)));
  });
  await until(() => text('next-bbbbbb').includes('Bug'), 'the cards and the idea tags to load');

  try {
    // Agent: its own picture, its sheet's role, the running dot and time.
    const running = card('base-aaaaaa')!;
    assert.equal(running.querySelector('img')?.getAttribute('src'), '/api/uploads/coder.png', 'the agent\'s real avatar');
    assert.match(text('base-aaaaaa'), /coder · 26 min/, 'role from the agent\'s sheet, then the running time');
    assert.ok(running.querySelector('[aria-label="Running"]'), 'the running dot');
    assert.ok(!card('next-bbbbbb')!.querySelector('[aria-label="Running"]'), 'no dot on a queued task');

    // Model: the backend's logo drawn, "inherited" when nothing is known.
    await until(() => !!running.querySelector('[data-task-params] svg'), 'the model logo');
    assert.match(running.querySelector('[data-task-params]')?.textContent ?? '', /opus/);
    assert.match(card('old-dddddd')!.querySelector('[data-task-params]')?.textContent ?? '', /nobody$/, 'no model: the backend name, no dropdown mark once the task is done');

    // Footer: waits on unfinished deps only, unblocks unfinished dependents only.
    assert.match(text('next-bbbbbb'), /Waits on 1 task(?!s)/, 'the finished and the missing dependency do not count');
    assert.match(text('base-aaaaaa'), /Unblocks 1 task(?!s)/, 'the DONE dependent does not count');
    assert.doesNotMatch(text('old-dddddd'), /Waits on|Unblocks/);

    // The card opens the popup; its own buttons reach the mission or stop it.
    assert.doesNotMatch(text('old-dddddd'), /delete/, 'deleting lives in the popup');
    const action = (id: string, label: string) => card(id)?.querySelector(`[aria-label="${label}"]`);
    assert.ok(action('base-aaaaaa', 'Open the mission'), 'a running task links to its mission');
    assert.match(action('base-aaaaaa', 'Stop the mission')?.className ?? '', /text-destructive/, 'and stops in red');
    assert.ok(!action('next-bbbbbb', 'Open the mission') && !action('next-bbbbbb', 'Stop the mission'), 'a queued task has no mission yet');
    assert.ok(!card('old-dddddd')?.querySelector('[aria-label="Stop the mission"]'), 'a finished task cannot be stopped');
    assert.doesNotMatch(card('base-aaaaaa')?.innerHTML ?? '', /md:opacity-0/, 'the actions are always visible');
    assert.doesNotMatch(text('base-aaaaaa'), /#base-aaa/, 'the task id stays in the popup');
    assert.ok(running.querySelector('[data-chip-avatar] [data-chip-pulse]'), 'the working agent pulses');

    // Idea tags, schedule, attachments, highlighted priority.
    const followUp = text('next-bbbbbb');
    assert.match(followUp, /#42/);
    assert.match(followUp, /Partially done|Partial/i);
    assert.match(followUp, /Scheduled/);
    assert.ok(card('next-bbbbbb')!.querySelector('[aria-label="2 attachments"]'), 'the attachment count');
    assert.match(card('next-bbbbbb')!.querySelector('[title="Priority 4"]')?.className ?? '', /text-warning/, 'P4 stands out');
    assert.doesNotMatch(text('base-aaaaaa'), /Scheduled/, 'no schedule line without a date');

    // Columns: real counts, the DONE one from the server's total.
    const counts = Array.from(document.querySelectorAll('section[aria-label]'))
      .map((s) => [s.getAttribute('aria-label'), s.querySelector('header span:last-child')?.textContent]);
    assert.deepEqual(counts, [['Pending', '1'], ['In progress', '1'], ['Done', '1'], ['Blocked', '0']]);
    assert.match(document.querySelector('section[aria-label="Blocked"]')?.textContent ?? '', /Nothing blocked/);
    // Each status column carries a faint wash of its own colour from the top-left corner.
    const wash = (label: string) => (document.querySelector(`section[aria-label="${label}"]`) as HTMLElement | null)?.style.backgroundImage ?? '';
    assert.match(wash('Pending'), /radial-gradient.*--warning/);
    assert.match(wash('In progress'), /--info/);
    assert.match(wash('Done'), /--success/);
    assert.match(wash('Blocked'), /--destructive/);
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    resetSlotsForTests();
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
