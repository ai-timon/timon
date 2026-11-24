/**
 * The landing badge of a TO DO idea (`kanban.todo.landing`): the product's
 * chip for each state, the job's dialog it opens, the detail of
 * several jobs, a plugin's badge in its place once it takes the slot, and the
 * landing filter of the TO DO widget.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType, ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import { filterByLanding, showLandingFilter } from '../../lib/project-todo-filter';
import type { ProjectTodo, TodoLanding, TodoLandingJob } from './project-todo-types';

const job = (state: TodoLandingJob['state'], branch: string, prNumber: number | null = null): TodoLandingJob => ({
  state, branch, prNumber, prUrl: prNumber === null ? null : `https://github.com/acme/app/pull/${prNumber}`,
});
const landing = (worst: TodoLandingJob, ...others: TodoLandingJob[]): TodoLanding => ({ ...worst, jobs: [worst, ...others] });

function idea(id: number, l: TodoLanding | null): ProjectTodo {
  return {
    id, text: `idea ${id}`, project: 'timon', author: 'user', status: 'open', notes: null,
    created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: null, landing: l,
  };
}

/** What `/api/ui/projects/timon/forge-proposals` answers; empty unless a test sets it. */
let PROPOSALS: unknown[] = [];

async function mount(items: ProjectTodo[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  const urls: string[] = [];
  install('fetch', async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/ui/project-todo')) {
      const wanted = new URL(url, 'http://localhost').searchParams.get('landing');
      const rows = wanted ? items.filter((i) => i.landing?.state === wanted) : items;
      return Response.json({ items: rows, counts: { byStatus: { open: rows.length, done: 0, promoted: 0 }, byUrgency: {
        open: { critical: 0, bug: 0, minor: 0, idea: 0, none: rows.length },
        done: { critical: 0, bug: 0, minor: 0, idea: 0, none: 0 },
        promoted: { critical: 0, bug: 0, minor: 0, idea: 0, none: 0 },
      } } });
    }
    if (url.startsWith('/api/ui/layout')) return Response.json({ layout: null });
    if (url === '/api/ui/projects/timon/forge-proposals') return Response.json({ proposals: PROPOSALS });
    if (url.startsWith('/api/ui/kanban/landings?')) return Response.json({ landings: [LANDING_OPEN, { ...LANDING_OPEN, id: 'job-old', updated_at: 1 }] });
    if (url.endsWith('/preview')) return Response.json(PREVIEW);
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
  return { React, slots, urls, render, until, click, unmount };
}

const LANDING_OPEN = {
  id: 'job-open', project: 'timon', series_id: 's1', branch: 'feat/open', remote: 'origin', target: 'main', mode: 'pr',
  state: 'open', pr_number: 12, pr_url: 'https://github.com/acme/app/pull/12', head_sha: null, merge_sha: null, landed: false,
  created_at: 2, updated_at: 5, checks: null, conflict: null, checks_running: false, pr_title: 'Open the export',
};

const PREVIEW = {
  integration: LANDING_OPEN, head_sha: null, target_sha: null, problem: null, commit_count: 0, commits: [], commits_truncated: false,
  files: [], files_truncated: false, patch_truncated: false, totals: { files: 0, additions: 0, deletions: 0 },
  conflict: { state: 'clean', files: [] }, pull_request: null, prechecks: { ran: false, reason: 'not asked' },
};

const IDEAS = [
  idea(1, null),
  idea(2, landing(job('branch', 'sec/fix-auth'))),
  idea(3, landing(job('pending', 'feat/pending'))),
  idea(4, landing(job('open', 'feat/open', 12))),
  idea(5, landing(job('merged', 'feat/merged', 13))),
  idea(6, landing(job('closed', 'feat/closed', 14))),
  idea(7, landing(job('pending', 'feat/second'), job('open', 'feat/first', 21))),
];

test('the product badge says each state, and opens its job rather than the browser', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    await m.render(m.React.createElement('div', null, IDEAS.map((it) =>
      m.React.createElement('div', { key: it.id, 'data-idea': it.id }, m.React.createElement(TodoLandingSlot, { item: it })))));
    const badge = (id: number) => document.querySelector(`[data-idea="${id}"] [data-todo-landing]`);
    assert.equal(badge(1), null, 'no job: no badge');
    assert.equal(badge(2)?.textContent, 'Branch');
    assert.equal(badge(3)?.textContent, 'PR not created');
    assert.equal(badge(3)?.tagName, 'BUTTON', 'a job without its pull request still has a preview');
    assert.equal(badge(4)?.textContent, 'PR #12');
    assert.equal(badge(4)?.tagName, 'BUTTON');
    assert.equal(badge(4)?.getAttribute('href'), null, 'no longer a link to the forge');
    assert.match(badge(4)?.getAttribute('aria-label') ?? '', /open the job's preview$/);
    assert.equal(badge(5)?.textContent, 'PR #13 merged');
    assert.equal(badge(6)?.textContent, 'PR #14 closed');
    assert.equal(badge(6)?.getAttribute('data-todo-landing'), 'closed');
  } finally {
    await m.unmount();
  }
});

test('several jobs: the worst one shows, every one is named', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    await m.render(m.React.createElement(TodoLandingSlot, { item: IDEAS[6]! }));
    const chip = document.querySelector('[data-todo-landing]');
    assert.equal(chip?.getAttribute('data-todo-landing'), 'pending');
    assert.match(chip?.textContent ?? '', /^PR not created\+1$/);
    const label = chip?.getAttribute('aria-label') ?? '';
    assert.match(label, /feat\/second: PR not created/);
    assert.match(label, /feat\/first: PR #21/);
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes kanban.todo.landing paints in place of the product, from useTodoItem', async () => {
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    const { ProductTodoLanding } = await import('./product-todo-landing');
    const { useTodoItem } = await import('./todo-badge-slot');
    m.slots.register({ slot: 'kanban.todo.landing', fallback: true, pluginId: '@timon/kanban' }, ProductTodoLanding);
    const Acme: ComponentType = () => {
      const item = useTodoItem();
      return m.React.createElement('span', { 'data-acme-landing': item?.landing?.state ?? 'none' }, item?.landing?.prUrl ?? '');
    };
    await m.render(m.React.createElement('div', null,
      m.React.createElement('div', { 'data-idea': 4 }, m.React.createElement(TodoLandingSlot, { item: IDEAS[3]! })),
      m.React.createElement('div', { 'data-idea': 1 }, m.React.createElement(TodoLandingSlot, { item: IDEAS[0]! }))));
    assert.ok(document.querySelector('[data-idea="4"] [data-todo-landing="open"]'), 'the product badge under its fallback');

    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = m.slots.register({ slot: 'kanban.todo.landing', pluginId: 'acme-issues' }, Acme); });
    await m.until(() => !!document.querySelector('[data-acme-landing]'), 'the plugin\'s badge');
    assert.ok(!document.querySelector('[data-todo-landing]'), 'the product badge is not painted under it');
    assert.equal(document.querySelector('[data-idea="4"] [data-acme-landing]')?.getAttribute('data-acme-landing'), 'open');
    assert.equal(document.querySelector('[data-idea="4"] [data-acme-landing]')?.textContent, 'https://github.com/acme/app/pull/12');
    // A replacement may have something to say about an idea without a job.
    assert.equal(document.querySelector('[data-idea="1"] [data-acme-landing]')?.getAttribute('data-acme-landing'), 'none');

    await m.React.act(async () => { dispose(); });
    await m.until(() => !!document.querySelector('[data-idea="4"] [data-todo-landing="open"]'), 'the product badge back');
  } finally {
    await m.unmount();
  }
});

test('the TO DO widget filters on an open or a missing pull request', async () => {
  const m = await mount(IDEAS);
  try {
    const { ProjectTodoTile } = await import('./project-todo-tile');
    await m.render(m.React.createElement(ProjectTodoTile, {
      scope: { kind: 'project', slug: 'timon' }, titre: 'Project TO DO', handle: null, realtime: { subscribe: () => () => {} }, editing: false,
    } as never));
    await m.until(() => !!document.querySelector('[data-landing-filter="open"]'), 'the landing filter');
    assert.equal(document.querySelectorAll('[data-todo-landing]').length, 6, 'one badge per idea with a job');

    await m.click(document.querySelector('[data-landing-filter="open"]'));
    await m.until(() => m.urls.some((u) => u.includes('landing=open')), 'the filter reaches the daemon');
    await m.until(() => document.querySelectorAll('[data-todo-landing]').length === 1, 'only the open pull request');
    assert.equal(document.querySelector('[data-landing-filter="open"]')?.getAttribute('aria-pressed'), 'true');

    await m.click(document.querySelector('[data-landing-filter="pending"]'));
    await m.until(() => m.urls.some((u) => u.includes('landing=pending')), 'the other state');
    await m.until(() => document.querySelectorAll('[data-todo-landing="pending"]').length === 2, 'the two ideas without a pull request');

    await m.click(document.querySelector('[data-landing-filter="pending"]'));
    await m.until(() => document.querySelectorAll('[data-todo-landing]').length === 6, 'the filter off');
  } finally {
    await m.unmount();
  }
});

test('filter helpers: a single state, shown once an idea could match', () => {
  assert.deepEqual(filterByLanding(IDEAS, 'open').map((i) => i.id), [4]);
  assert.deepEqual(filterByLanding(IDEAS, 'pending').map((i) => i.id), [3, 7]);
  assert.equal(filterByLanding(IDEAS, null).length, IDEAS.length);
  assert.equal(showLandingFilter([IDEAS[0]!, IDEAS[4]!], null), false, 'nothing to filter on');
  assert.equal(showLandingFilter([IDEAS[0]!], 'open'), true, 'an active choice stays reachable');
  assert.equal(showLandingFilter([IDEAS[3]!], null), true);
});

test('a click on the badge of a TO DO line opens the job dialog, not the idea', async () => {
  const m = await mount(IDEAS);
  try {
    const { ProjectTodoTile } = await import('./project-todo-tile');
    await m.render(m.React.createElement(ProjectTodoTile, {
      scope: { kind: 'project', slug: 'timon' }, titre: 'Project TO DO', handle: null, realtime: { subscribe: () => () => {} }, editing: false,
    } as never));
    await m.until(() => !!document.querySelector('[data-todo-landing="open"]'), 'the open pull request badge');
    await m.click(document.querySelector('[data-todo-landing="open"]'));
    await m.until(() => !!document.querySelector('[data-landing-forge]'), 'the job dialog');
    assert.ok(m.urls.includes('/api/ui/kanban/landings?project=timon'), 'the job looked up in the idea\'s project');
    assert.ok(m.urls.includes('/api/ui/kanban/landings/job-open/preview'), 'the latest job of the branch');
    assert.equal(document.querySelector('[data-landing-forge]')?.getAttribute('href'), 'https://github.com/acme/app/pull/12', 'the forge one click away, in the dialog');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'the idea did not open under it');
  } finally {
    await m.unmount();
  }
});

test('a badge that knows its job opens it by id, with no lookup by branch', async () => {
  const withId: TodoLanding = { ...job('open', 'feat/open', 12), jobId: 'job-open', jobs: [] };
  withId.jobs = [withId];
  const m = await mount();
  try {
    const { TodoLandingSlot } = await import('./todo-landing-slot');
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/ui/kanban/landings/job-open') { m.urls.push(url); return Response.json({ landing: LANDING_OPEN }); }
      return original(input);
    }) as typeof fetch;
    await m.render(m.React.createElement(TodoLandingSlot, { item: idea(4, withId) }));
    await m.click(document.querySelector('[data-todo-landing="open"]'));
    await m.until(() => !!document.querySelector('[data-landing-forge]'), 'the job dialog');
    assert.ok(m.urls.includes('/api/ui/kanban/landings/job-open'));
    assert.ok(!m.urls.some((u) => u.startsWith('/api/ui/kanban/landings?')), 'no list read');
  } finally {
    await m.unmount();
  }
});

test('an idea shows its GitHub issues and whether a connector wrote it', async () => {
  const m = await mount();
  try {
    const { TodoBadges, TodoMeta } = await import('./todo-card-parts');
    const { todoIssues, todoIsExternal } = await import('./todo-issue-chips');
    const link = (provider: string, ref: string, url: string | null, plugin_id: string | null) =>
      ({ provider, ref, url, label: null, plugin_id, created_at: 1 });
    const imported: ProjectTodo = {
      ...idea(8, null),
      links: [
        link('github', 'acme/app#212', 'https://github.com/acme/app/issues/212', '@timon/github-issues'),
        link('github', 'ACME/app#212', 'https://github.com/acme/app/issues/212', null),
        link('discord', 'thread-1', 'javascript:alert(1)', null),
      ],
    };
    assert.deepEqual(todoIssues(imported).map((i) => [i.repo, i.number]), [['acme/app', 212]], 'one issue, once');
    assert.equal(todoIsExternal(imported), true);
    assert.equal(todoIsExternal({ ...idea(9, null), links: [link('github', 'acme/app#3', null, null)] }), false, 'a link no plugin wrote');

    await m.render(m.React.createElement('div', null,
      m.React.createElement('div', { 'data-zone': 'badges' }, m.React.createElement(TodoBadges, { item: imported })),
      m.React.createElement('div', { 'data-zone': 'meta' }, m.React.createElement(TodoMeta, { item: imported }))));
    const chip = document.querySelector('[data-zone="badges"] [data-todo-issue]');
    assert.equal(chip?.textContent, '#212');
    assert.equal(chip?.getAttribute('href'), 'https://github.com/acme/app/issues/212');
    assert.equal(chip?.getAttribute('target'), '_blank');
    assert.equal(chip?.getAttribute('aria-label'), 'Issue acme/app#212');
    assert.equal(document.querySelector('[data-zone="badges"] [data-todo-external]')?.textContent, 'external');
    const meta = document.querySelector('[data-zone="meta"]')?.textContent ?? '';
    assert.ok(!meta.includes('github'), 'the issue is not named twice on the card');
    assert.ok(meta.includes('discord'), 'other links stay in the meta line');
    assert.ok(!document.querySelector('[data-zone="meta"] a'), 'a javascript: link is never an href');
  } finally {
    await m.unmount();
  }
});

test('a publication waiting on an idea\'s issue or its pull request shows on its line, and opens over the page', async () => {
  const proposal = (id: string, type: 'issue' | 'pull', number: number, state = 'draft', project = 'timon') => ({
    id, project, repo: 'acme/app', kind: 'comment', target: { type, number, url: `https://github.com/acme/app/${type === 'issue' ? 'issues' : 'pull'}/${number}` },
    body: 'Fixed by #12.', state, trigger: 'landing', key: `k-${id}`, source_ref: null, account: null, url: null, error: null,
    created_at: 1, updated_at: 1, published_at: null,
  });
  PROPOSALS = [
    proposal('00000000-0000-4000-8000-000000000001', 'issue', 212),
    proposal('00000000-0000-4000-8000-000000000002', 'pull', 12),
    proposal('00000000-0000-4000-8000-000000000003', 'issue', 212, 'published'),
    proposal('00000000-0000-4000-8000-000000000004', 'issue', 99),
  ];
  const m = await mount();
  try {
    const { TodoBadges, useTodoHasBadges } = await import('./todo-card-parts');
    const github = { provider: 'github', ref: 'acme/app#212', url: 'https://github.com/acme/app/issues/212', label: null, plugin_id: null, created_at: 1 };
    const linked: ProjectTodo = { ...idea(10, landing(job('open', 'feat/open', 12))), links: [github] };
    const quiet: ProjectTodo = { ...idea(11, null), links: [{ ...github, ref: 'acme/app#5', url: null }] };
    const plain = idea(12, null);
    const has: Record<number, boolean> = {};
    function Line({ item }: { item: ProjectTodo }) {
      has[item.id] = useTodoHasBadges(item);
      return m.React.createElement('div', { 'data-line': item.id }, m.React.createElement(TodoBadges, { item }));
    }
    await m.render(m.React.createElement('div', null,
      m.React.createElement(Line, { item: linked }), m.React.createElement(Line, { item: quiet }), m.React.createElement(Line, { item: plain })));
    await m.until(() => !!document.querySelector('[data-line="10"] [data-proposal-chip]'), 'the chip on the linked idea');
    const chip = document.querySelector<HTMLElement>('[data-line="10"] [data-proposal-chip]')!;
    assert.equal(chip.textContent, '2 to approve', 'its issue and its pull request, a published one left out');
    assert.ok(!document.querySelector('[data-line="11"] [data-proposal-chip]'), 'nothing waits on another issue');
    assert.equal(has[12], false, 'an idea with neither issue nor pull request has no badge zone');
    assert.equal(m.urls.filter((u) => u.includes('/forge-proposals')).length, 1, 'one read for every line of the project');
    await m.click(chip);
    const params = new URL(window.location.href).searchParams;
    assert.equal(params.get('forge-proposal'), '00000000-0000-4000-8000-000000000001');
    assert.equal(params.get('forge-project'), 'timon');
  } finally {
    PROPOSALS = [];
    await m.unmount();
  }
});
