/**
 * The "Identity docs" of the agent editor, mounted in jsdom: the docs in a
 * column with the markdown rendered, an Edit button, suggestions for the
 * files the agent does not have yet, and the creation of a new doc.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { docNameOf, orderedDocs } from '../components/agent-editor/identity-docs';

test('a typed doc name becomes a valid .md file name, or nothing', () => {
  assert.equal(docNameOf('charter'), 'charter.md');
  assert.equal(docNameOf(' rules.md '), 'rules.md');
  assert.equal(docNameOf('bad name'), null);
  assert.equal(docNameOf('  '), null);
});

test('system-prompt.md comes first, then SOUL.md, then the others by name', () => {
  assert.deepEqual(orderedDocs(['rules.md', 'soul.md', 'charter.md']), ['system-prompt.md', 'soul.md', 'charter.md', 'rules.md']);
});

async function mount(over: { agent?: string | null; docs?: Record<string, string> } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, v: unknown) => Object.defineProperty(globalThis, key, { value: v, configurable: true, writable: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { IdentityDocs } = await import('../components/agent-editor/identity-docs');
  const created: { name: string; template: string }[] = [];
  const deleted: string[] = [];
  const edits: [string, string][] = [];
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(IdentityDocs, {
      agent: over.agent === undefined ? 'timon.coder' : over.agent,
      systemPrompt: '# Prompt heading\n\nBe brief.',
      onSystemPrompt: (v: string) => edits.push(['system-prompt.md', v]),
      docs: over.docs ?? { 'rules.md': '- Never lie' },
      onDoc: (n: string, v: string) => edits.push([n, v]),
      onCreate: async (name: string, template: string) => { created.push({ name, template }); return true; },
      onDelete: (n: string) => deleted.push(n),
    }));
  });
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const byText = (re: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => re.test(b.textContent ?? ''));
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { act, byText, created, deleted, edits, unmount, window: dom.window };
}

test('the markdown is rendered, and an Edit button opens the source', async () => {
  const r = await mount();
  try {
    assert.equal(document.querySelector('.chat-bubble h1')?.textContent, 'Prompt heading');
    assert.ok(!document.querySelector('textarea'));
    await r.act(() => r.byText(/^Edit/)!.click());
    assert.equal(document.querySelector('textarea')!.value, '# Prompt heading\n\nBe brief.');
    await r.act(() => r.byText(/^Done/)!.click());
    assert.ok(!document.querySelector('textarea'));
  } finally { await r.unmount(); }
});

test('the docs of the agent are listed, and the ones it lacks are offered dimmed', async () => {
  const r = await mount();
  try {
    const listed = Array.from(document.querySelectorAll('ul[aria-label="Identity docs of the agent"] button[aria-current]')).map((b) => b.textContent);
    assert.equal(listed.length, 2);
    assert.match(listed[0]!, /system-prompt\.md/);
    assert.match(listed[1]!, /rules\.md/);
    const offered = Array.from(document.querySelectorAll('ul[aria-label="Docs you could add"] li')).map((li) => li.textContent);
    assert.ok(offered.some((t) => /SOUL\.md/.test(t ?? '')));
    assert.ok(!offered.some((t) => /rules\.md/.test(t ?? '')), 'a doc the agent has is not offered again');
  } finally { await r.unmount(); }
});

test('a suggestion creates the doc from its starter, and a typed name creates an empty one', async () => {
  const r = await mount();
  try {
    await r.act(() => r.byText(/SOUL\.md/)!.click());
    assert.equal(r.created[0]!.name, 'SOUL.md');
    assert.match(r.created[0]!.template, /^# Who you are/);
    await r.act(() => r.byText(/New doc/)!.click());
    const input = document.querySelector('input') as HTMLInputElement;
    await r.act(() => {
      const setter = Object.getOwnPropertyDescriptor(r.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'notes');
      input.dispatchEvent(new r.window.Event('input', { bubbles: true }));
    });
    await r.act(() => input.dispatchEvent(new r.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.deepEqual(r.created[1], { name: 'notes.md', template: '' });
  } finally { await r.unmount(); }
});

test('the system prompt cannot be deleted, another doc can', async () => {
  const r = await mount();
  try {
    assert.ok(!document.querySelector('button[aria-label="Delete system-prompt.md"]'));
    await r.act(() => (document.querySelector('button[aria-label="Delete rules.md"]') as HTMLButtonElement).click());
    assert.deepEqual(r.deleted, ['rules.md']);
  } finally { await r.unmount(); }
});

test('an agent not created yet cannot get docs', async () => {
  const r = await mount({ agent: null });
  try {
    assert.equal(r.byText(/New doc/)!.disabled, true);
    assert.equal(r.byText(/SOUL\.md/)!.disabled, true);
  } finally { await r.unmount(); }
});
