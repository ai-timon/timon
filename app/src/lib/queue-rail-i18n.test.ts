/**
 * TIM-0144: the Tasks tile mixed English and French whatever the chosen
 * language ("file vide", "in progress · N", "Validation requise"). These tests
 * render the tile in English and in French and read what reaches the screen.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

interface Feed {
  missions: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
}

interface Rendered {
  text: string;
  headings: string[];
  labels: string[];
}

async function renderRail(locale: string, feed: Feed): Promise<Rendered> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent',
    'localStorage', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, dom.window[key]);
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (url: string) => {
    if (url.startsWith('/api/ui/missions')) return Response.json({ missions: feed.missions });
    if (url.startsWith('/api/ui/tasks')) return Response.json({ tasks: feed.tasks });
    if (url.startsWith('/api/ui/agents')) return Response.json({ agents: [] });
    if (url.startsWith('/api/ui/projects')) return Response.json({ projects: [] });
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { getLocale, setLocale } = await import('./i18n');
  await import('./i18n-test-locales');
  const { QueueRail } = await import('../app/agents/queue-rail');
  const previous = getLocale();
  setLocale(locale);
  const router = { push() {}, replace() {}, refresh() {}, back() {}, forward() {}, prefetch() {} };
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(
        React.createElement(AppRouterContext.Provider, { value: router as never },
          React.createElement(QueueRail, { handle: null })),
      );
    });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    const container = document.getElementById('root')!;
    return {
      text: container.textContent ?? '',
      headings: Array.from(container.querySelectorAll('h3')).map((h) => (h.textContent ?? '').trim()),
      labels: Array.from(container.querySelectorAll('[aria-label]')).map((el) => el.getAttribute('aria-label') ?? ''),
    };
  } finally {
    await React.act(async () => { root.unmount(); });
    setLocale(previous);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
}

const EMPTY: Feed = { missions: [], tasks: [] };
const BUSY: Feed = {
  missions: [
    { id: 'm1', agent_name: 'timon.coder', mission: 'build the thing', status: 'running', turn_active: true },
    { id: 'm2', agent_name: 'timon.reviewer', mission: 'review it', status: 'running', pending_action_at: 1 },
  ],
  tasks: [{ id: 't1', title: 'doc the thing', agent_name: 'timon.librarian', status: 'PENDING', type: 'doc' }],
};

test('the empty queue reads in English', async () => {
  const r = await renderRail('en', EMPTY);
  assert.match(r.text, /Queue empty/);
  assert.match(r.text, /No task running or waiting\./);
  assert.doesNotMatch(r.text, /file vide|Aucune/);
});

test('the empty queue reads in French', async () => {
  const r = await renderRail('fr', EMPTY);
  assert.match(r.text, /File vide/);
  assert.match(r.text, /Aucune tâche en cours ni en attente\./); // french-ok: the French locale under test
  assert.doesNotMatch(r.text, /Queue empty|No task/);
});

test('the counters and activity labels read in English', async () => {
  const r = await renderRail('en', BUSY);
  assert.deepEqual(r.headings, ['in progress · 2', 'queued · 1']);
  assert.match(r.text, /Validation required/);
  assert.ok(r.labels.includes('Needs validation'), r.labels.join(', '));
  assert.doesNotMatch(r.text, /Validation requise/);
});

test('the counters and activity labels read in French', async () => {
  const r = await renderRail('fr', BUSY);
  assert.deepEqual(r.headings, ['en cours · 2', 'en attente · 1']);
  assert.match(r.text, /Validation requise/);
  assert.ok(r.labels.includes('Validation requise'), r.labels.join(', '));
  assert.doesNotMatch(r.text, /in progress|queued/);
});
