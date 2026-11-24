// french-ok-file: an accented agent name, the folding under test
/**
 * The agent search of the cockpit chat card: the one way to add an agent to a
 * card, from its config or from the "+" of its avatar row.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { filterAgents } from '@/plugins-client/agent-chat/agent-picker';

const AGENTS = [
  { name: 'timon.coder', role: 'coder', project: 'timon' },
  { name: 'Équipe.santé', role: 'health', project: 'perso' },
  { name: 'acme.reviewer', role: 'reviewer', project: 'acme' },
  { name: 'one-shot', ephemeral: true },
];
const PROJECTS = [{ slug: 'perso', name: 'Vie personnelle' }, { slug: 'acme', name: 'Ácme' }];

test('the search ignores accents and case, over name, role and project (slug and name)', () => {
  const names = (q: string) => filterAgents(AGENTS, PROJECTS, q).map((a) => a.name);
  assert.deepEqual(names('EQUIPE'), ['Équipe.santé']);
  assert.deepEqual(names('sante'), ['Équipe.santé']);
  assert.deepEqual(names('coder timon'), ['timon.coder']);
  assert.deepEqual(names('personnelle'), ['Équipe.santé'], 'project name');
  assert.deepEqual(names('ácme'), ['acme.reviewer']);
  assert.deepEqual(names('nobody'), []);
});

test('no query lists every agent by name, never an ephemeral one', () => {
  // Accents do not push `Équipe` past `timon`.
  assert.deepEqual(filterAgents(AGENTS, PROJECTS, '  ').map((a) => a.name), [
    'acme.reviewer', 'Équipe.santé', 'timon.coder',
  ]);
});

async function mount(excluded: string[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { AgentPicker } = await import('../plugins-client/agent-chat/agent-picker');

  const picked: string[] = [];
  let submits = 0;
  const root = createRoot(document.getElementById('root')!);
  // Inside a form, as in the card config: Enter in the search must add, not save.
  await React.act(async () => {
    root.render(React.createElement(
      'form',
      { onSubmit: (e: Event) => { e.preventDefault(); submits += 1; } },
      React.createElement(AgentPicker, {
        agents: AGENTS,
        projects: PROJECTS,
        excluded: new Set(excluded),
        onPick: (a: string) => { picked.push(a); },
      }),
    ));
  });
  const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
  const options = () => Array.from(document.querySelectorAll('[role="option"]'));
  const active = () => document.getElementById(input().getAttribute('aria-activedescendant') ?? '')?.textContent ?? null;
  /** Resolves to whether the key's default action (Enter: the form's implicit
   *  submit, which jsdom does not simulate) was prevented. */
  const key = async (k: string) => {
    let prevented = false;
    await React.act(async () => {
      prevented = !input().dispatchEvent(new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    });
    return prevented;
  };
  const type = async (value: string) => {
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input(), value);
      input().dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  const focus = async () => { await React.act(async () => { input().focus(); }); };
  const unmount = async () => { await React.act(async () => { root.unmount(); }); dom.window.close(); };
  return { input, options, active, key, type, focus, picked, submits: () => submits, unmount };
}

test('arrows skip the agents already on the card, Enter adds without submitting, Escape closes', async () => {
  const p = await mount(['timon.coder']);
  try {
    assert.equal(p.input().getAttribute('aria-expanded'), 'false');
    await p.focus();
    assert.equal(p.input().getAttribute('aria-expanded'), 'true');
    assert.equal(p.options().length, 3);
    // Greyed, not hidden: a search for it says "already there".
    const coder = p.options().find((o) => o.textContent?.includes('timon.coder'))!;
    assert.equal(coder.getAttribute('aria-disabled'), 'true');

    assert.ok(p.active()?.includes('acme.reviewer'), 'first available is active');
    await p.key('ArrowDown');
    assert.ok(p.active()?.includes('Équipe.santé'), 'timon.coder skipped');
    await p.key('ArrowDown');
    assert.ok(p.active()?.includes('acme.reviewer'), 'wraps');
    await p.key('ArrowUp');
    assert.ok(p.active()?.includes('Équipe.santé'));

    assert.equal(await p.key('Enter'), true, 'Enter in the search never submits the form');
    assert.deepEqual(p.picked, ['Équipe.santé']);
    assert.equal(p.submits(), 0);

    await p.type('SANTE');
    assert.equal(p.options().length, 1);
    await p.key('Escape');
    assert.equal(p.input().getAttribute('aria-expanded'), 'false');
    assert.ok(!document.querySelector('[role="listbox"]'));
  } finally {
    await p.unmount();
  }
});

test('a query nothing matches says so, and Enter adds nothing', async () => {
  const p = await mount([]);
  try {
    await p.focus();
    await p.type('zzz');
    assert.equal(p.options().length, 0);
    assert.ok((document.querySelector('[role="listbox"]')?.textContent ?? '').length > 0);
    await p.key('Enter');
    assert.deepEqual(p.picked, []);
  } finally {
    await p.unmount();
  }
});
