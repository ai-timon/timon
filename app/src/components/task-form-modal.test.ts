/**
 * The task form's model field (`task-form-modal.tsx`) mounted in jsdom against
 * a stubbed daemon: one ModelPicker writes `backend_override` and
 * `model_override` together, "inherit" clears both, a slug typed by hand
 * goes to the opened provider, and a half-pair saved by an older form is sent
 * back untouched when the user does not pick.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { TaskFormSource } from './task-form-modal';

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }, { slug: 'haiku', label: 'Haiku', presetRank: 2 }],
    },
    {
      id: 'codex', label: 'Codex', vendor: 'OpenAI', brand: 'openai', defaultModel: 'gpt-5.5',
      models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }],
    },
  ],
};

type Saved = { method: string; url: string; body: Record<string, unknown> };

async function withForm(task: TaskFormSource, run: (m: Awaited<ReturnType<typeof mount>>) => Promise<void>, onDelete?: () => Promise<boolean>) {
  const m = await mount(task, onDelete);
  try { await run(m); } finally { await m.unmount(); }
}

async function mount(task: TaskFormSource, onDelete?: () => Promise<boolean>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
    'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'SubmitEvent',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: Saved[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/ui/backends/catalog')) return json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return json({ favorites: [] });
    if (url.startsWith('/api/ui/tasks') && method !== 'GET') {
      sent.push({ method, url, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return json({ task: {} });
    }
    if (url.startsWith('/api/ui/tasks')) return json({ tasks: [] });
    if (url.startsWith('/api/ui/skills')) return json({ skills: [] });
    if (url.startsWith('/api/ui/mcp')) return json({ servers: [] });
    return json({ error: 'not found' }, 404);
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  const { resetModelFavoritesForTest } = await import('@/hooks/use-model-favorites');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();
  const { TaskFormModal } = await import('./task-form-modal');

  let closed = 0;
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(TaskFormModal, {
      task,
      agents: [{ name: 'coder' }],
      onDelete,
      onClose: () => { closed++; },
    }));
  });

  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const button = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  const row = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]')).find((el) => el.textContent?.includes(text));
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const type = async (input: HTMLInputElement | null, value: string) => {
    assert.ok(input, 'input');
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const chip = () => $<HTMLButtonElement>('button[data-model-chip]');
  /** Opens "Advanced" when the task has no override, then the picker. */
  const openPicker = async () => {
    if (!chip()) await click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.includes('Advanced')));
    await until(() => !!chip(), 'the model chip');
    await click(chip());
    await until(() => !!row('Opus') || !!row('GPT-5.5'), 'the picker rows');
  };
  const save = async () => {
    await click(button('Save'));
    await until(() => sent.length > 0, 'the task to be saved');
    return sent[sent.length - 1]!;
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
  return { $, button, row, click, type, chip, until, openPicker, save, unmount, closed: () => closed };
}

const TASK: TaskFormSource = {
  id: 't1', title: 'Fix it', agent_name: 'coder', status: 'PENDING', priority: 3, deps: '[]',
  backend_override: null, model_override: null,
};

test('a pick sets the backend and the model together', async () => {
  await withForm(TASK, async (m) => {
    await m.openPicker();
    assert.match(m.chip()?.textContent ?? '', /Project role/);
    await m.click(m.row('Haiku'));
    await m.until(() => !!m.chip()?.textContent?.includes('Haiku'), 'the chip to name the pick');
    const saved = await m.save();
    assert.equal(saved.method, 'PUT');
    assert.equal(saved.url, '/api/ui/tasks/t1');
    assert.equal(saved.body.backend_override, 'claude');
    assert.equal(saved.body.model_override, 'haiku');
  });
});

test('"inherit" clears both halves', async () => {
  await withForm({ ...TASK, backend_override: 'codex', model_override: 'gpt-5.5' }, async (m) => {
    await m.openPicker();
    await m.click(m.row('Project role'));
    await m.until(() => !!m.chip()?.textContent?.includes('Project role'), 'the chip to read inherit');
    const saved = await m.save();
    assert.equal(saved.body.backend_override, null);
    assert.equal(saved.body.model_override, null);
  });
});

test('no hand-typed slug in the picker: custom models are set up in Settings', async () => {
  await withForm({ ...TASK, backend_override: 'codex', model_override: 'gpt-5.5' }, async (m) => {
    await m.openPicker();
    assert.equal(m.button('Type a model id…'), undefined);
  });
});

test('a half-pair from an older form shows its default model and is sent back as stored', async () => {
  await withForm({ ...TASK, backend_override: 'codex', model_override: null }, async (m) => {
    await m.until(() => !!m.chip()?.textContent?.includes('GPT-5.5'), 'the chip to name the backend default');
    const saved = await m.save();
    assert.equal(saved.body.backend_override, 'codex');
    assert.equal(saved.body.model_override, null);
    assert.equal(m.closed(), 1);
  });
});

test('the popup shows the closing report and deletes in red, closing once the task is gone', async () => {
  let asked = 0;
  await withForm({ ...TASK, status: 'DONE', done_comment: 'Merged at abc123' }, async (m) => {
    assert.match(m.$('[role="dialog"]')?.textContent ?? '', /Merged at abc123/);
    const del = m.button('Delete');
    assert.ok(del, 'the delete button');
    assert.match(del.className, /text-destructive/);
    assert.ok(del.querySelector('svg'), 'with its bin icon');
    await m.click(del);
    await m.until(() => m.closed() === 1, 'the popup to close');
    assert.equal(asked, 1);
  }, async () => { asked++; return true; });
});

test('no delete button where the screen offers no deletion, and none kept open on a refusal', async () => {
  await withForm(TASK, async (m) => {
    assert.equal(m.button('Delete'), undefined);
  });
  await withForm(TASK, async (m) => {
    await m.click(m.button('Delete'));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(m.closed(), 0, 'a refused or cancelled deletion leaves the popup open');
  }, async () => false);
});

test('the frame has a contour in dark only, where the chrome fill meets the veil', async () => {
  await withForm(TASK, async (m) => {
    const frame = m.$('[role="dialog"]');
    assert.ok(frame, 'the dialog frame');
    const classes = frame.className.split(/\s+/);
    assert.ok(classes.includes('md:dark:ring-1') && classes.includes('md:dark:ring-border'), 'a border-token contour in dark');
    assert.ok(!classes.some((c) => /^(md:)?ring(-|$)/.test(c)), 'no contour in light: its look is unchanged');
  });
});
