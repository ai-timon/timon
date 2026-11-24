/**
 * The composer's model chip (`llm-menu.tsx`) mounted in jsdom against a
 * stubbed daemon: the ModelPicker opened from the chip, the thinking control
 * and the switch confirmation in its footer. A model change on the same
 * engine, a handover to another account of the same vendor (preview, two
 * doors), an account to sign in again, a turn in flight, and a stored
 * setting that applies at once.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { BackendCatalog } from '@/lib/backends';
import type { SwitchContextChoice } from './llm-menu';

const LEVELS = ['low', 'medium', 'high'];

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    {
      id: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      models: [
        { slug: 'opus', label: 'Opus', presetRank: 1, supportedReasoningLevels: LEVELS },
        { slug: 'sonnet', label: 'Sonnet', presetRank: 2, supportedReasoningLevels: ['low', 'medium'] },
      ],
    },
    {
      id: 'claude@perso', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'perso', name: 'Perso', state: 'active' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1, supportedReasoningLevels: LEVELS }],
    },
    {
      id: 'claude@krz', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', defaultModel: 'opus',
      instanceOf: 'claude', account: { id: 'krz', name: 'KRZDIGITAL', state: 'reauth' },
      models: [{ slug: 'opus', label: 'Opus', presetRank: 1 }],
    },
    {
      id: 'codex', label: 'Codex', vendor: 'OpenAI', brand: 'openai', defaultModel: 'gpt-5.5',
      models: [{ slug: 'gpt-5.5', label: 'GPT-5.5' }],
    },
  ],
};

type Call = { backend: string; model: string; contextMode: SwitchContextChoice };

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const previews: string[] = [];
  install('fetch', async (input: string) => {
    const url = String(input);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.includes('/api/ui/backends/catalog')) return json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return json({ favorites: [] });
    if (url.includes('/switch-preview')) {
      previews.push(url);
      return json({ ok: true, transcriptTokens: 12_000, fitsWhole: true, mode: 'transcript' });
    }
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
  const { LlmMenu } = await import('./llm-menu');

  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const $ = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]'));
  const row = (text: string) => rows().find((el) => el.textContent?.includes(text));
  const rail = (label: string) => $<HTMLButtonElement>(`nav button[aria-label="${label}"]`);
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === text);
  const chip = () => $<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  const confirmation = () => $('[role="group"][aria-label="Switch LLM?"]');
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const key = async (el: Element | null, k: string) => {
    assert.ok(el, `element for ${k}`);
    await React.act(async () => {
      el.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
  };

  const calls: Call[] = [];
  const efforts: (string | null)[] = [];
  const render = async (props: Record<string, unknown>) => {
    await React.act(async () => {
      root.render(React.createElement(LlmMenu, {
        backend: 'claude',
        model: 'opus',
        reasoningEffort: null,
        onReasoningEffort: async (effort: string | null) => { efforts.push(effort); },
        onPick: async (backend: string, model: string, contextMode: SwitchContextChoice) => { calls.push({ backend, model, contextMode }); },
        missionId: 'm1',
        children: React.createElement('button', { type: 'button' as const, className: 'chip' }, 'model chip'),
        ...props,
      }));
    });
  };
  const openMenu = async () => {
    await click(chip());
    await until(() => rows().length > 0, 'the picker to list models');
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
  return { React, render, openMenu, until, rows, row, rail, button, chip, confirmation, click, key, $, calls, efforts, previews, unmount };
}

async function withMenu(props: Record<string, unknown>, body: (m: Awaited<ReturnType<typeof mount>>) => Promise<void>): Promise<void> {
  const m = await mount();
  try {
    await m.render(props);
    await m.openMenu();
    await body(m);
  } finally {
    await m.unmount();
  }
}

test('the chip opens the picker on the account of the next turn, with the thinking control in its footer', async () => {
  await withMenu({ backend: 'claude@perso', model: 'opus', reasoningEffort: 'high' }, async (m) => {
    assert.equal(m.chip()?.textContent, 'model chip', 'the caller\'s own trigger');
    assert.equal(m.chip()?.getAttribute('aria-expanded'), 'true');
    assert.equal(m.rail('Anthropic · Perso')?.getAttribute('aria-pressed'), 'true');
    assert.equal(m.row('Opus')?.getAttribute('aria-pressed'), 'true');
    const slider = m.$<HTMLInputElement>('input[type="range"]');
    assert.ok(slider, 'the thinking slider');
    assert.equal(slider.value, '3', 'the stop of "high"');
  });
});

test('same engine: the confirmation applies the model as is, and drops a level the new model does not know', async () => {
  await withMenu({ reasoningEffort: 'high' }, async (m) => {
    await m.click(m.row('Sonnet'));
    assert.ok(m.confirmation(), 'the click arms the switch');
    assert.ok(m.$('[role="dialog"]'), 'the panel stays open');
    assert.equal(m.button('Compact'), undefined, 'no handover, no compaction door');
    assert.deepEqual(m.calls, []);
    await m.click(m.button('Switch'));
    assert.deepEqual(m.calls, [{ backend: 'claude', model: 'sonnet', contextMode: 'auto' }]);
    await m.until(() => m.efforts.length === 1, 'the level to be reset');
    assert.deepEqual(m.efforts, [null]);
    assert.equal(m.$('[role="dialog"]'), null, 'closed once the switch leaves');
    assert.deepEqual(m.previews, [], 'nothing crosses, nothing to preview');
  });
});

test('another account of the same vendor is a handover: preview, two doors, the whole thread by default', async () => {
  await withMenu({}, async (m) => {
    await m.click(m.rail('Anthropic · Perso'));
    await m.click(m.row('Opus'));
    await m.until(() => !!m.confirmation()?.textContent?.includes('~12 k tokens'), 'the context preview');
    assert.match(m.previews[0] ?? '', /\/missions\/m1\/switch-preview\?backend=claude%40perso$/);
    assert.ok(m.button('Compact'));
    await m.click(m.button('Hand over whole'));
    assert.deepEqual(m.calls, [{ backend: 'claude@perso', model: 'opus', contextMode: 'transcript' }]);
    assert.deepEqual(m.efforts, [], 'the level is known by the new model');
  });
});

test('the summary door hands the context over compacted', async () => {
  await withMenu({}, async (m) => {
    await m.click(m.rail('OpenAI'));
    await m.click(m.row('GPT-5.5'));
    await m.until(() => m.previews.length === 1, 'the preview');
    await m.click(m.button('Compact'));
    assert.deepEqual(m.calls, [{ backend: 'codex', model: 'gpt-5.5', contextMode: 'summary' }]);
  });
});

test('an account to sign in again cannot be picked; Escape on the confirmation goes back to the list', async () => {
  await withMenu({}, async (m) => {
    await m.click(m.rail('Anthropic · KRZDIGITAL'));
    assert.equal(m.row('Opus')?.disabled, true);
    await m.click(m.row('Opus'));
    assert.equal(m.confirmation(), null);

    await m.click(m.rail('OpenAI'));
    await m.click(m.row('GPT-5.5'));
    assert.ok(m.confirmation());
    await m.key(m.confirmation(), 'Escape');
    assert.equal(m.confirmation(), null);
    assert.ok(m.$('[role="dialog"]'), 'still open on the list');
    assert.deepEqual(m.calls, []);
  });
});

test('a turn in flight blocks a handover, not a model change on the same engine', async () => {
  await withMenu({ thinking: true }, async (m) => {
    assert.ok(document.body.textContent?.includes('turn'), 'the footer says a turn is running');
    await m.click(m.rail('OpenAI'));
    await m.click(m.row('GPT-5.5'));
    assert.ok(m.confirmation()?.textContent?.includes('A turn is running'));
    assert.equal(m.button('Hand over whole')?.disabled, true);
    assert.equal(m.button('Compact')?.disabled, true);

    await m.click(m.rail('Anthropic'));
    await m.click(m.row('Sonnet'));
    assert.equal(m.button('Switch')?.disabled, false);
  });
});

test('re-picking the running model closes without a switch', async () => {
  await withMenu({}, async (m) => {
    await m.click(m.row('Opus'));
    assert.equal(m.$('[role="dialog"]'), null);
    assert.deepEqual(m.calls, []);
  });
});

test('a stored setting (no confirmation) applies the pick at once and shows no thinking control', async () => {
  await withMenu({ confirm: false, missionId: null, onReasoningEffort: undefined, align: 'end' }, async (m) => {
    assert.equal(m.$('input[type="range"]'), null);
    await m.click(m.rail('OpenAI'));
    await m.click(m.row('GPT-5.5'));
    assert.deepEqual(m.calls, [{ backend: 'codex', model: 'gpt-5.5', contextMode: 'auto' }]);
    assert.equal(m.$('[role="dialog"]'), null);
  });
});

test('a switch in flight upstream freezes the chip', async () => {
  const m = await mount();
  try {
    await m.render({ busy: true });
    assert.equal(m.chip()?.disabled, true);
  } finally {
    await m.unmount();
  }
});
