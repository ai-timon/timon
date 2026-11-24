// french-ok-file: the French alternatives the card reads in either locale
/**
 * The injections card, mounted: the list comes in the daemon's order, an
 * edit goes to the source the block names and the list is read again, and a
 * masked block offers no way to edit.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; method: string; body: string | null };

const DATA = {
  agent: 'timon.coder',
  backend: 'claude',
  prompt_chars: 1234,
  prompt_tokens: 3400,
  blocks: [
    { id: 'preamble', source: 'preamble', origin: 'timon', source_path: null, tokens: 10, injected_by: 'timon', order: 1, label: 'TIMON preamble', content: 'PREAMBLE TEXT', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null, items: [] },
    { id: 'memory', source: 'memory', origin: 'memory', source_path: null, tokens: 10, injected_by: 'timon', order: 2, label: 'Memory', content: 'memory text', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null,
      items: [{ id: 'memory-rule-7', label: 'project · core', content: 'old rule', tokens: 3, source_path: null, editable: true, editable_text: 'old rule', edit_target: { kind: 'memory_rule', rule_id: 7 } }] },
    { id: 'system-prompt', source: 'system-prompt', origin: 'agent', source_path: null, tokens: 10, injected_by: 'timon', order: 3, label: 'system-prompt.md', content: 'key=***', truncated: false, redacted: true, editable: false, editable_text: null, edit_target: null, items: [] },
  ],
};

/** Another agent's list: same block ids as `DATA`, sources of its own. */
const OTHER = {
  agent: 'timon.reviewer',
  backend: 'claude',
  prompt_chars: 99,
  prompt_tokens: 25,
  blocks: [
    { id: 'preamble', source: 'preamble', origin: 'timon', source_path: null, tokens: 10, injected_by: 'timon', order: 1, label: 'TIMON preamble', content: 'PREAMBLE TEXT', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null, items: [] },
    { id: 'system-prompt', source: 'system-prompt', origin: 'agent', source_path: null, tokens: 10, injected_by: 'timon', order: 2, label: 'system-prompt.md', content: 'reviewer prompt', truncated: false, redacted: false, editable: true, editable_text: 'reviewer source', edit_target: { kind: 'agent_file', agent: 'timon.reviewer', path: 'system-prompt.md' }, items: [] },
  ],
};
const CODER = {
  ...DATA,
  blocks: [
    DATA.blocks[0]!,
    { id: 'system-prompt', source: 'system-prompt', origin: 'agent', source_path: null, tokens: 10, injected_by: 'timon', order: 2, label: 'system-prompt.md', content: 'coder prompt', truncated: false, redacted: false, editable: true, editable_text: 'coder source', edit_target: { kind: 'agent_file', agent: 'timon.coder', path: 'system-prompt.md' }, items: [] },
  ],
};

async function mount(opts: { gate?: Promise<void>; first?: unknown; list?: () => unknown; inChat?: boolean; reads?: unknown } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'MutationObserver', 'CustomEvent', 'NodeFilter'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET', body: init?.body ?? null });
    if (url === '/api/ui/agents') return { ok: true, json: async () => ({ agents: [{ name: 'timon.coder' }, { name: 'timon.reviewer' }] }) };
    if (url.endsWith('/timon.reviewer/injections')) {
      // The reviewer's list can be held back, to look at the card in between.
      await opts.gate;
      return { ok: true, json: async () => OTHER };
    }
    if (url.endsWith('/injections')) return { ok: true, json: async () => (opts.list ? opts.list() : opts.first ?? DATA) };
    if (url.endsWith('/skill-reads') && opts.reads) return { ok: true, json: async () => opts.reads };
    if (url.startsWith('/api/ui/projects')) return { ok: true, json: async () => ({ projects: [] }) };
    return { ok: true, json: async () => ({ ok: true }) };
  });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentInjectionsCard } = await import('./agent-injections-card');
  const { ChatRailProvider } = await import('@/components/chat/chat-rails');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    const card = React.createElement(AgentInjectionsCard, { handle: null } as never);
    root.render(opts.inChat
      ? React.createElement(ChatRailProvider, { value: { agent: { name: 'timon.coder' } }, info: {} } as never, card)
      : card);
  });
  const act = (fn: () => void) => React.act(async () => { fn(); });
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  const pick = (name: string) => act(() => {
    const select = document.querySelector('select')!;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, name);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  return { calls, act, pick, unmount, window: dom.window };
}

const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('ol[aria-label] > li > button'));
const dialog = () => document.querySelector('[role="dialog"]');
const byText = (re: RegExp) => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => re.test(b.textContent ?? ''));

test('the blocks are listed in the order the daemon gave, numbered, with their origin and tokens', async () => {
  const { unmount } = await mount();
  try {
    const labels = rows().map((b) => b.textContent ?? '');
    assert.match(labels[0]!, /1.*TIMON preamble.*timon.*~10 tokens/);
    assert.match(labels[1]!, /2.*Memory.*memory/);
    assert.match(labels[2]!, /3.*system-prompt\.md.*agent/);
    assert.match(document.body.textContent ?? '', /3\.4k tokens/, 'the total sent before the first message');
  } finally { await unmount(); }
});

test('pinned in a chat, the card shows that agent and offers no selector', async () => {
  const { calls, unmount } = await mount({ inChat: true });
  try {
    assert.ok(!document.querySelector('select'));
    assert.ok(calls.some((c) => c.url === '/api/ui/agents/timon.coder/injections'));
  } finally { await unmount(); }
});

test('a row opens its block in a dialog instead of unfolding', async () => {
  const { act, unmount } = await mount();
  try {
    assert.ok(!dialog());
    await act(() => rows()[0]!.click());
    assert.match(dialog()?.textContent ?? '', /PREAMBLE TEXT/);
  } finally { await unmount(); }
});

test('a rule of the memory block is edited in the dialog and written to the rule, then the list is read again', async () => {
  const { calls, act, unmount, window } = await mount();
  try {
    await act(() => rows()[1]!.click());
    await act(() => byText(/^(Edit|Modifier)/)!.click());
    const area = document.querySelector('textarea')!;
    assert.equal(area.value, 'old rule');
    await act(() => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!;
      setter.call(area, 'new rule');
      area.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    const before = calls.filter((c) => c.url.endsWith('/injections')).length;
    await act(() => byText(/^(Save|Enregistrer)/)!.click());
    const write = calls.find((c) => c.method === 'PATCH');
    assert.equal(write?.url, '/api/ui/memory/rules/7');
    assert.deepEqual(JSON.parse(write!.body!), { text: 'new rule' });
    assert.equal(calls.filter((c) => c.url.endsWith('/injections')).length, before + 1, 'the list is read again after a save');
  } finally { await unmount(); }
});

test('a masked block has no edit button', async () => {
  const { act, unmount } = await mount();
  try {
    await act(() => rows()[2]!.click());
    assert.match(dialog()?.textContent ?? '', /key=\*\*\*/);
    assert.equal(byText(/^(Edit|Modifier)/), undefined);
  } finally { await unmount(); }
});

test('a masked block says the agent receives the value in clear, on its row and in the dialog', async () => {
  const { act, unmount } = await mount();
  try {
    assert.match(rows()[2]!.textContent ?? '', /masked here|masqué ici/);
    assert.doesNotMatch(rows()[0]!.textContent ?? '', /masked|masqué/);
    await act(() => rows()[2]!.click());
    assert.match(dialog()!.querySelector('[role="note"]')?.textContent ?? '', /in clear|en clair/);
  } finally { await unmount(); }
});

test('a block without a secret carries no masking notice', async () => {
  const { act, unmount } = await mount();
  try {
    await act(() => rows()[0]!.click());
    assert.match(dialog()?.textContent ?? '', /PREAMBLE TEXT/);
    assert.ok(!dialog()!.querySelector('[role="note"]'));
  } finally { await unmount(); }
});

test('a skill masked in the prompt too does not claim the agent receives the value', async () => {
  const masked = {
    id: 'skill-sk-remote', label: 'sk-remote', content: 'token=***', tokens: 9, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'import', skill_via: 'agent', skill_promoted: true,
  };
  const skills = {
    id: 'skills', source: 'skills', origin: 'skills', source_path: null, tokens: 9, injected_by: 'timon', order: 2, label: 'Skills', content: '', truncated: false, redacted: true, sent_masked: true, editable: false, editable_text: null, edit_target: null,
    items: [masked],
  };
  const { act, unmount } = await mount({ first: { ...DATA, blocks: [DATA.blocks[0]!, skills] } });
  try {
    assert.match(rows()[1]!.textContent ?? '', /masked when sent|masqué à l'envoi/);
    await act(() => rows()[1]!.click());
    const note = dialog()!.querySelector('[role="note"]')?.textContent ?? '';
    assert.match(note, /does not receive|ne reçoit donc pas/);
    assert.doesNotMatch(note, /in clear|en clair/);
  } finally { await unmount(); }
});

const type = (window: Window, text: string) => {
  const area = document.querySelector('textarea')!;
  const setter = Object.getOwnPropertyDescriptor((window as unknown as { HTMLTextAreaElement: typeof HTMLTextAreaElement }).HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(area, text);
  area.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
};

test('switching agent mid-edit drops the draft: it can never be saved onto the other agent', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const { calls, act, pick, unmount, window } = await mount({ first: CODER, gate });
  try {
    // An edit of the coder's system-prompt.md is under way…
    await act(() => rows()[1]!.click());
    await act(() => byText(/^(Edit|Modifier)/)!.click());
    await act(() => type(window as unknown as Window, "the coder's unsaved draft"));
    assert.equal(document.querySelector('textarea')!.value, "the coder's unsaved draft");

    // …the reviewer is picked, and its list is still being read.
    await pick('timon.reviewer');
    assert.ok(document.querySelector('textarea') === null, 'no editor survives the change of agent');
    assert.equal(byText(/^(Save|Enregistrer)/), undefined);

    // Its list arrives: same block ids, an editor that starts clean.
    await act(async () => { release(); await gate; });
    await act(() => rows()[1]!.click());
    await act(() => byText(/^(Edit|Modifier)/)!.click());
    assert.equal(document.querySelector('textarea')!.value, 'reviewer source', "the coder's draft did not follow");
    await act(() => byText(/^(Save|Enregistrer)/)!.click());

    const writes = calls.filter((c) => c.method !== 'GET');
    assert.equal(writes.length, 1);
    assert.match(writes[0]!.url, /^\/api\/ui\/agents\/timon\.reviewer\/files/);
    assert.equal(writes[0]!.body, 'reviewer source');
    assert.equal(writes.filter((w) => w.url.includes('timon.coder')).length, 0, 'nothing was written to the coder');
  } finally { await unmount(); }
});

test('a list read again under an open editor never lets its draft reach the new source', async () => {
  // Same agent, same item id — but the rule it stands for changed between two
  // reads, so the item now points at another source.
  const memory = (ruleId: number) => ({
    ...DATA.blocks[1]!,
    items: [
      { id: 'a', label: 'first', content: 'first text', tokens: 2, source_path: null, editable: true, editable_text: 'first text', edit_target: { kind: 'memory_rule', rule_id: ruleId } },
      { id: 'b', label: 'second', content: 'second text', tokens: 2, source_path: null, editable: true, editable_text: 'second text', edit_target: { kind: 'memory_rule', rule_id: 50 } },
    ],
  });
  let ruleId = 7;
  const list = () => ({ ...DATA, blocks: [DATA.blocks[0]!, memory(ruleId)] });
  const { calls, act, unmount, window } = await mount({ list });
  try {
    await act(() => rows()[1]!.click());
    const edits = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => /^(Edit|Modifier)/.test(b.textContent ?? ''));
    await act(() => edits()[0]!.click());
    await act(() => type(window as unknown as Window, 'draft meant for rule 7'));
    await act(() => edits()[0]!.click()); // the second item, its Edit button now first
    // The second editor saves (which reads the list again) while item `a` moved to rule 8.
    ruleId = 8;
    assert.equal(document.querySelectorAll('textarea').length, 2);
    const saves = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter((b) => /^(Save|Enregistrer)/.test(b.textContent ?? ''));
    await act(() => saves[1]!.click());
    assert.ok(document.querySelector('textarea') === null, 'the first draft did not survive the change of source');
    assert.equal(calls.filter((c) => c.url.endsWith('/memory/rules/7')).length, 0, 'no write reached rule 7');
  } finally { await unmount(); }
});

test('a skill pasted because the backend cannot read it says so, and is not called never read', async () => {
  const promoted = {
    id: 'skill-sk-remote', label: 'sk-remote', content: 'the whole body', tokens: 900, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'import', skill_via: 'agent', skill_promoted: true,
  };
  const skills = {
    id: 'skills', source: 'skills', origin: 'skills', source_path: null, tokens: 900, injected_by: 'timon', order: 2, label: 'Skills', content: '', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null,
    items: [promoted],
  };
  const reads = { agent: 'timon.coder', window_days: 30, missions: 12, skills: {} };
  const { act, unmount } = await mount({ first: { ...DATA, blocks: [DATA.blocks[0]!, skills] }, reads });
  try {
    assert.doesNotMatch(rows()[1]!.textContent ?? '', /never read|jamais lu/);
    await act(() => rows()[1]!.click());
    const item = dialog()!.querySelector('ol > li')!.textContent ?? '';
    assert.match(item, /imported|importé/);
    assert.match(item, /cannot read a skill on demand|ne peut pas lire un skill à la demande/);
  } finally { await unmount(); }
});

test('a catalogue skill no mission read stands out, on its row and in the dialog', async () => {
  const skill = (label: string, mode: 'include' | 'import') => ({
    id: `skill-${label}`, label, content: `- \`${label}\` — d`, tokens: 2, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: mode, skill_via: 'agent',
  });
  const skills = {
    id: 'skills', source: 'skills', origin: 'skills', source_path: null, tokens: 6, injected_by: 'timon', order: 2, label: 'Skills', content: '', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null,
    items: [skill('sk-read', 'include'), skill('sk-cold', 'include'), skill('sk-pasted', 'import')],
  };
  const reads = { agent: 'timon.coder', window_days: 30, missions: 12, skills: { 'sk-read': { reads: 4, missions: 3 } } };
  const { calls, act, unmount } = await mount({ first: { ...DATA, blocks: [DATA.blocks[0]!, skills] }, reads });
  try {
    assert.ok(calls.some((c) => c.url === '/api/ui/agents/timon.coder/skill-reads'));
    assert.match(rows()[1]!.textContent ?? '', /(never read|jamais lus) ?: 1/);
    assert.doesNotMatch(rows()[0]!.textContent ?? '', /never read|jamais lu/);
    await act(() => rows()[1]!.click());
    const items = Array.from(dialog()!.querySelectorAll('ol > li')).map((li) => li.textContent ?? '');
    assert.match(items[0]!, /(read|lu) 4× · 3\/12 missions · 30 (d|j)/);
    assert.match(items[1]!, /(never read|jamais lu) · 12 missions/);
    assert.match(items[1]!, /description/);
    // Imported whole: no counter.
    assert.doesNotMatch(items[2]!, /missions/);
  } finally { await unmount(); }
});

test('on a backend whose reads cannot be measured, no skill is called never read', async () => {
  const skill = (label: string) => ({
    id: `skill-${label}`, label, content: `- \`${label}\` — d`, tokens: 2, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'include', skill_via: 'agent',
  });
  const skills = {
    id: 'skills', source: 'skills', origin: 'skills', source_path: null, tokens: 2, injected_by: 'timon', order: 2, label: 'Skills', content: '', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null,
    items: [skill('sk-cold')],
  };
  const reads = { agent: 'timon.coder', window_days: 30, missions: 12, unmeasured_missions: 12, skills: {} };
  const { act, unmount } = await mount({ first: { ...DATA, blocks: [DATA.blocks[0]!, skills] }, reads });
  try {
    assert.doesNotMatch(rows()[1]!.textContent ?? '', /never read|jamais lu/);
    await act(() => rows()[1]!.click());
    const item = dialog()!.querySelector('ol > li')!;
    assert.match(item.textContent ?? '', /not measured on this backend|non mesurées sur ce backend/);
    assert.doesNotMatch(item.textContent ?? '', /never read|jamais lu|rewrite|réécris/);
  } finally { await unmount(); }
});

test('without a counter (older daemon), no reads badge is shown', async () => {
  const { unmount } = await mount();
  try {
    assert.doesNotMatch(document.body.textContent ?? '', /never read|jamais lu/);
  } finally { await unmount(); }
});

test('a catalogue skill shows what reading it would cost, apart from the total', async () => {
  const skills = {
    id: 'skills', source: 'skills', origin: 'skills', source_path: null, tokens: 120, injected_by: 'timon', order: 4, label: 'Skills', content: 'skills', truncated: false, redacted: false, editable: false, editable_text: null, edit_target: null,
    items: [
      { id: 'skill-cat', label: 'cat', content: '- `cat` — read me', tokens: 12, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'include', skill_via: 'agent', on_demand_tokens: 2500 },
      { id: 'skill-imp', label: 'imp', content: 'imported body', tokens: 90, source_path: null, editable: false, editable_text: null, edit_target: null, skill_mode: 'import', skill_via: 'agent', on_demand_tokens: null },
    ],
  };
  const { act, unmount } = await mount({ first: { ...DATA, on_demand_tokens: 2500, blocks: [...DATA.blocks, skills] } });
  try {
    const text = document.body.textContent ?? '';
    assert.match(text, /3\.4k tokens of context/, 'the total stays the prompt of the spawn');
    assert.match(text, /Catalogue skills add ~2\.5k tokens only if the agent reads them/);
    await act(() => rows()[3]!.click());
    const items = Array.from(dialog()!.querySelectorAll('ol > li')).map((li) => li.textContent ?? '');
    assert.match(items[0]!, /cat.*catalogue.*~12 tokens.*\+2\.5k if read/);
    assert.match(items[1]!, /imp.*imported.*~90 tokens/);
    assert.doesNotMatch(items[1]!, /if read/, 'an imported skill is already paid');
  } finally { await unmount(); }
});
