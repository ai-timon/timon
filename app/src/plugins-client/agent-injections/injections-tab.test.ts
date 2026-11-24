/**
 * The "Injections" tab of the agent editor: the steps come as a timeline in the
 * order the daemon gave, the step picked is read in the middle, and a file of
 * the project is shown with its path but never offers an editor.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const block = (over: Record<string, unknown>) => ({
  truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null, items: [], source_path: null, tokens: 10, ...over,
});
const DATA = {
  agent: 'timon.coder',
  backend: 'claude',
  prompt_chars: 100,
  prompt_tokens: 25,
  blocks: [
    block({ id: 'preamble', source: 'preamble', origin: 'timon', injected_by: 'timon', order: 1, label: 'TIMON preamble', content: '# Preamble heading' }),
    block({ id: 'system-prompt', source: 'system-prompt', origin: 'agent', injected_by: 'timon', order: 2, label: 'system-prompt.md', content: 'agent text', editable: true, editable_text: 'agent source', source_path: '/home/x/.timon/agents/timon.coder/system-prompt.md', edit_target: { kind: 'agent_file', agent: 'timon.coder', path: 'system-prompt.md' } }),
    block({ id: 'project-file-AGENTS.md', source: 'project-file', origin: 'project', injected_by: 'cli', order: 3, label: 'AGENTS.md', content: 'project rules', source_path: '/work/proj/AGENTS.md' }),
  ],
};

async function mount() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async () => ({ ok: true, json: async () => DATA }));
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentInjectionsTab } = await import('./injections-tab');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(AgentInjectionsTab, { agent: 'timon.coder' })); });
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { act, unmount };
}

const steps = () => Array.from(document.querySelectorAll<HTMLButtonElement>('ol[aria-label] > li > button'));
const byText = (re: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => re.test(b.textContent ?? ''));

test('the timeline lists the steps in order, each with its origin, and the first one is read', async () => {
  const { unmount } = await mount();
  try {
    assert.equal(steps().length, 3);
    assert.match(steps()[0]!.textContent ?? '', /TIMON preamble.*timon/);
    assert.match(steps()[1]!.textContent ?? '', /system-prompt\.md.*agent.*editable/);
    assert.ok(document.querySelector('h3')?.textContent?.includes('TIMON preamble'));
    // Rendered as markdown, not shown raw.
    assert.equal(document.querySelector('.chat-bubble h1')?.textContent, 'Preamble heading');
    assert.match(document.body.textContent ?? '', /~25 tokens/);
  } finally { await unmount(); }
});

test('picking a step shows its file and its editor', async () => {
  const { act, unmount } = await mount();
  try {
    await act(() => steps()[1]!.click());
    assert.match(document.body.textContent ?? '', /system-prompt\.md.*\.timon/s);
    assert.ok(byText(/^(Edit|Modifier)/));
  } finally { await unmount(); }
});

test('a project file is read-only and shows its path', async () => {
  const { act, unmount } = await mount();
  try {
    await act(() => steps()[2]!.click());
    assert.match(document.body.textContent ?? '', /\/work\/proj\/AGENTS\.md/);
    assert.ok(!byText(/^(Edit|Modifier)/));
  } finally { await unmount(); }
});
