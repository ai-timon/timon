/**
 * A job's dialog (`kanban.job.dialog`): its Links island (the ideas it
 * carries, their issues, the mission that pilots it, its branch), the way it
 * hands over to an idea or to the mission, the same links in a row's "…"
 * menu, and a plugin's dialog in its place once it takes the slot.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType, ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { Landing, LandingPreview } from './landing-api';
import type { ProjectTodo } from './project-todo-types';

const JOB: Landing = {
  id: 'job-51', project: 'acme', series_id: 's1', branch: 'feat/add-csv-export', remote: 'origin', target: 'main',
  mode: 'pr', state: 'open', pr_number: 51, pr_url: 'https://github.com/acme/app/pull/51', head_sha: null, merge_sha: null,
  landed: false, created_at: 1, updated_at: 2, checks: null, conflict: null, checks_running: false, pr_title: 'Add CSV export',
  links: {
    todos: [{ id: 209, text: 'Export CSV of the mission history', status: 'promoted', progress: null, project: 'acme' }],
    issues: [
      { repo: 'acme/app', number: 212, url: 'https://github.com/acme/app/issues/212', todo_id: 209, closes: false },
      { repo: 'other/lib', number: 3, url: 'javascript:alert(1)', todo_id: null, closes: true },
    ],
    series_id: 's1',
    pilot_mission_id: 'mission-pilot',
  },
};

const PREVIEW: LandingPreview = {
  integration: JOB, head_sha: null, target_sha: null, problem: null, commit_count: 0, commits: [], commits_truncated: false,
  files: [], files_truncated: false, patch_truncated: false, totals: { files: 0, additions: 0, deletions: 0 },
  conflict: { state: 'clean', files: [] }, pull_request: null, prechecks: { ran: false, reason: 'not asked' },
};

const TODO: ProjectTodo = {
  id: 209, text: 'Export CSV of the mission history', project: 'acme', author: 'user', status: 'promoted', notes: null,
  created_at: 1, updated_at: 1, done_at: null, promoted_task_id: null, urgency: null, progress: null, links: [], landing: null,
};

async function mount() {
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
    if (url.endsWith('/preview')) return Response.json(PREVIEW);
    if (url.startsWith('/api/ui/project-todo?')) return Response.json({ items: [TODO] });
    return Response.json({});
  });
  const navigations: string[] = [];
  dom.window.addEventListener('timon:navigate', (e) => { navigations.push((e as CustomEvent<string>).detail); });

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
  return { React, slots, urls, navigations, render, until, click, unmount };
}

/** The dialog as a screen opens it: closing it unmounts it, the idea's form lives beside it. */
async function Screen(): Promise<ComponentType> {
  const React = await import('react');
  const { JobDialog } = await import('./job-dialog');
  const { useTodoOpener } = await import('./todo-opener');
  return function Screen() {
    const [open, setOpen] = React.useState(true);
    const { openTodo, todoModal } = useTodoOpener();
    const close = React.useCallback(() => setOpen(false), []);
    return React.createElement(React.Fragment, null,
      open ? React.createElement(JobDialog, { landing: JOB, onClose: close, openTodo }) : null,
      todoModal);
  };
}

test('the Links island names the ideas, the issues, the pilot mission and the branch', async () => {
  const m = await mount();
  try {
    await m.render(m.React.createElement(await Screen()));
    await m.until(() => !!document.querySelector('[data-job-links]'), 'the links');
    const links = document.querySelector('[data-job-links]')!;
    assert.match(links.textContent ?? '', /^Links/);
    assert.equal(links.querySelector('[data-job-todo="209"]')?.textContent, 'Export CSV of the mission history');
    const ours = links.querySelector('[data-job-issue="212"]');
    assert.equal(ours?.textContent, '#212', 'the pull request\'s own repository goes without saying');
    assert.equal(ours?.getAttribute('href'), 'https://github.com/acme/app/issues/212');
    const theirs = links.querySelector('[data-job-issue="3"]');
    assert.match(theirs?.textContent ?? '', /^other\/lib#3· closes$/, 'another repository is named, the author\'s claim said');
    assert.equal(theirs?.tagName, 'SPAN', 'a javascript: address is never a link');
    assert.ok(links.querySelector('[data-job-pilot="mission-pilot"]'));
    assert.match(links.textContent ?? '', /feat\/add-csv-export → main/);
    assert.match(document.querySelector('[role="dialog"]')?.textContent ?? '', /Add CSV export\s*PR #51/);
  } finally {
    await m.unmount();
  }
});

test('an idea of the links closes the dialog and opens in its form; the pilot opens its chat', async () => {
  const m = await mount();
  try {
    await m.render(m.React.createElement(await Screen()));
    await m.until(() => !!document.querySelector('[data-job-todo="209"]'), 'the idea');
    await m.click(document.querySelector('[data-job-todo="209"]'));
    await m.until(() => m.urls.includes('/api/ui/project-todo?status=all&ids=209&limit=1'), 'the idea read again');
    await m.until(() => !document.querySelector('[data-job-links]'), 'the job dialog closed');
    await m.until(() => (document.querySelector('[role="dialog"]')?.textContent ?? '').includes('Export CSV'), 'the idea\'s form');
  } finally {
    await m.unmount();
  }

  const n = await mount();
  try {
    await n.render(n.React.createElement(await Screen()));
    await n.until(() => !!document.querySelector('[data-job-pilot]'), 'the pilot');
    await n.click(document.querySelector('[data-job-pilot]'));
    assert.deepEqual(n.navigations, ['/chat?mission=mission-pilot']);
    await n.until(() => !document.querySelector('[data-job-links]'), 'the dialog closed');
  } finally {
    await n.unmount();
  }
});

test('a job\'s row reaches its ideas and its pilot from its menu', async () => {
  const m = await mount();
  try {
    const { LandingWidget } = await import('./landing-widget');
    const bare: Landing = { ...JOB, id: 'job-bare', branch: 'feat/bare', pr_title: 'Bare', links: undefined };
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/checks')) return Response.json({ landing: JOB, fresh: true });
      if (url.startsWith('/api/ui/kanban/landings') && !url.includes('/job-')) return Response.json({ landings: [JOB, bare] });
      return original(input);
    }) as typeof fetch;
    await m.render(m.React.createElement(LandingWidget, { handle: null }));
    await m.until(() => !!document.querySelector('[data-landing="job-51"]'), 'the row');
    const openMenu = async (id: string) => {
      const trigger = document.querySelector(`[data-landing="${id}"] button[aria-label="More actions"]`)!;
      await m.React.act(async () => {
        trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
      });
      await m.until(() => document.querySelectorAll('[role="menuitem"]').length > 0, 'the menu');
    };
    await openMenu('job-51');
    assert.equal(document.querySelector('[data-menu-todo="209"]')?.textContent, 'Show the TO DO (#209)');
    assert.equal(document.querySelector('[data-menu-pilot]')?.textContent, 'Open the job');
    await m.click(document.querySelector('[data-menu-pilot]'));
    assert.deepEqual(m.navigations, ['/chat?mission=mission-pilot']);
    await m.until(() => document.querySelectorAll('[role="menuitem"]').length === 0, 'the menu closed');

    await openMenu('job-bare');
    assert.ok(!document.querySelector('[data-menu-todo]'), 'no links, no entry');
    assert.ok(!document.querySelector('[data-menu-pilot]'));
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes kanban.job.dialog paints the dialog from useJobDialog', async () => {
  const m = await mount();
  try {
    const { JobDialog } = await import('./job-dialog');
    const { useJobDialog } = await import('./job-dialog-context');
    const Acme: ComponentType = () => {
      const host = useJobDialog();
      return m.React.createElement('div', { 'data-acme-job': host?.landing.id }, host?.landing.links?.todos.length);
    };
    m.slots.register({ slot: 'kanban.job.dialog', pluginId: 'acme-jobs' }, Acme);
    await m.render(m.React.createElement(JobDialog, { landing: JOB, onClose: () => {} }));
    await m.until(() => !!document.querySelector('[data-acme-job]'), 'the plugin\'s dialog');
    assert.equal(document.querySelector('[data-acme-job]')?.getAttribute('data-acme-job'), 'job-51');
    assert.ok(!document.querySelector('[data-job-links]'), 'the product\'s is not painted under it');
  } finally {
    await m.unmount();
  }
});
