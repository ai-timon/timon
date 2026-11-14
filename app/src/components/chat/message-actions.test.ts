/**
 * The actions under a chat bubble are occupants of `chat.message.action`
 * (`message-actions.tsx`): what each bubble offers, and what Reply arms.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

// One window for the whole file, installed before Radix loads.
const env = makeEnv();

async function makeEnv() {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const install = (key: string, value: unknown) => {
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter',
    'DocumentFragment', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'SVGElement',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  return { React, until: (c: () => boolean, what: string) => waitUntil(React.act, c, what) };
}

type View = import('./message-actions').ChatMessageView;
type Reply = import('./message-actions').ComposerReply;
type Rewind = import('./message-actions').ChatRewindApi;

const AGENT: View = {
  role: 'agent', eventId: 12, missionId: 'm1',
  markdown: '**Done.** The plan has three steps.', html: '<p><strong>Done.</strong> The plan has three steps.</p>',
};

async function paint(message: View, onReply: (reply: Reply | null) => void = () => {}, rewind: Rewind | null = null) {
  const e = await env;
  const { createRoot } = await import('react-dom/client');
  const mod = await import('./message-actions');
  const { resetSlotsForTests } = await import('../../lib/plugin-host/slots');
  resetSlotsForTests();
  const unmountSlot = mod.mountMessageActionSlot();
  document.getElementById('root')!.replaceChildren();
  const root = createRoot(document.getElementById('root')!);
  const replyApi = { reply: null, setReply: onReply };
  await e.React.act(async () => {
    root.render(e.React.createElement(mod.ComposerReplyProvider, {
      value: replyApi,
      children: e.React.createElement(mod.ChatRewindProvider, {
        value: rewind,
        children: e.React.createElement(mod.MessageActionBar, { message }),
      }),
    }));
  });
  const labels = () => Array.from(document.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'));
  return {
    ...e, labels,
    button: (label: string) => Array.from(document.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label),
    done: async () => { await e.React.act(async () => { root.unmount(); }); unmountSlot(); },
  };
}

test('an agent bubble offers copy, copy as Markdown and reply, in that order', async () => {
  const ui = await paint(AGENT);
  try {
    // No speech synthesis in this window: Read aloud stays away rather than doing nothing.
    assert.deepEqual(ui.labels(), ['Copy', 'Copy as Markdown', 'Reply']);
  } finally { await ui.done(); }
});

test('a human bubble offers copy and reply, and a bubble no row backs cannot be replied to', async () => {
  const user = await paint({ ...AGENT, role: 'user', markdown: 'yes', html: '<p>yes</p>' });
  try { assert.deepEqual(user.labels(), ['Copy', 'Reply']); } finally { await user.done(); }
  const unbacked = await paint({ ...AGENT, eventId: null });
  try { assert.deepEqual(unbacked.labels(), ['Copy', 'Copy as Markdown']); } finally { await unbacked.done(); }
});

test('Reply arms the reply with the event id and the opening words, as read', async () => {
  const armed: (Reply | null)[] = [];
  const ui = await paint(AGENT, (reply) => armed.push(reply));
  try {
    await ui.React.act(async () => { ui.button('Reply')!.click(); });
    assert.deepEqual(armed, [{ eventId: 12, role: 'agent', excerpt: 'Done. The plan has three steps.' }]);
  } finally { await ui.done(); }
});

test('a plugin action lands after the product ones and reads the bubble', async () => {
  const e = await env;
  const { register } = await import('../../lib/plugin-host/slots');
  const mod = await import('./message-actions');
  const ui = await paint(AGENT);
  try {
    const Probe = () => {
      const message = mod.useChatMessage();
      return e.React.createElement('button', { 'aria-label': `probe ${message?.eventId}` });
    };
    let undo = () => {};
    await e.React.act(async () => { undo = register({ slot: mod.CHAT_MESSAGE_ACTION_SLOT, pluginId: 'acme' }, Probe); });
    await ui.until(() => ui.labels().length === 4, 'the plugin button');
    assert.equal(ui.labels().at(-1), 'probe 12');
    undo();
  } finally { await ui.done(); }
});

test('the strip excerpt is one line, cut at a word', async () => {
  const { replyExcerpt } = await import('./message-actions');
  assert.equal(replyExcerpt('a\n\nb'), 'a b');
  const cut = replyExcerpt('word '.repeat(100), 40);
  assert.ok(cut.endsWith('…') && cut.length <= 41);
});

test('the examples/plugin-message-action template adds its button with the SDK alone', async () => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { pathToFileURL } = await import('node:url');
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-message-action', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__messageActionTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__messageActionTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const e = await env;
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __messageActionTestReact: e.React, __messageActionTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'message-action-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const ui = await paint(AGENT);
  const { register } = await import('../../lib/plugin-host/slots');
  try {
    const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
    let undo = () => {};
    await e.React.act(async () => {
      undo = mod.apply({ slots: { register: (options: { slot: string }, Component: import('react').ComponentType) =>
        register({ ...options, pluginId: 'example-message-action' }, Component) } });
    });
    await ui.until(() => document.querySelector('[data-message-reference="m1#12"]') !== null, 'the template button');
    assert.equal(ui.labels().at(-1), 'Copy the message reference');
    await e.React.act(async () => { undo(); });
    await ui.until(() => document.querySelector('[data-message-reference]') === null, 'the button gone');
  } finally {
    await ui.done();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Rewind sits under the user\'s own messages only, waits for the turn, and asks first', async () => {
  const { answerConfirmsForTests } = await import('@/components/confirm-dialog/confirm-dialog-context');
  const USER: View = { ...AGENT, role: 'user', markdown: 'yes', html: '<p>yes</p>' };
  const cut: number[] = [];
  const api: Rewind = { allowed: true, busy: false, agentName: 'Ada', rewind: async (id) => { cut.push(id); } };

  const agent = await paint(AGENT, undefined, api);
  try { assert.ok(!agent.labels().includes('Rewind to here')); } finally { await agent.done(); }
  const notOffered = await paint(USER, undefined, { ...api, allowed: false });
  try { assert.ok(!notOffered.labels().includes('Rewind to here')); } finally { await notOffered.done(); }

  const busy = await paint(USER, undefined, { ...api, busy: true });
  try {
    const button = busy.button('Rewind to here')!;
    assert.equal(button.getAttribute('aria-disabled'), 'true');
    await busy.React.act(async () => { button.click(); });
    assert.deepEqual(cut, []);
  } finally { await busy.done(); }

  const ui = await paint(USER, undefined, api);
  try {
    answerConfirmsForTests(() => false);
    await ui.React.act(async () => { ui.button('Rewind to here')!.click(); });
    assert.deepEqual(cut, []);
    answerConfirmsForTests(() => true);
    await ui.React.act(async () => { ui.button('Rewind to here')!.click(); });
    await ui.until(() => cut.length === 1, 'the rewind');
    assert.deepEqual(cut, [12]);
  } finally {
    answerConfirmsForTests(null);
    await ui.done();
  }
});
