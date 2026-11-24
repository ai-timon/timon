/**
 * "Publish on GitHub" (`forge.publish.dialog`): the exact text, where it goes
 * and as which account; nothing leaves before the click on Publish, the text
 * sent is the one on screen, a refusal keeps the dialog open; "Do not
 * publish" closes the proposal; a new comment becomes a proposal first; the
 * "to approve" chip on the rows; a plugin's dialog in place of the product's.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType, ReactElement } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { ForgeProposal } from './forge-proposals-api';
import type { Landing } from './landing-api';

const ID = '0f9c2a54-61f7-4c55-9b0e-0d6b2f6c1e11';

const PROPOSAL: ForgeProposal = {
  id: ID, project: 'acme', repo: 'acme/app', kind: 'comment',
  target: { type: 'issue', number: 209, url: 'https://github.com/acme/app/issues/209' },
  body: 'Fixed in #53, released with the next version.', state: 'draft', trigger: 'landing', key: 'todo:209:comment',
  source_ref: null, account: null, url: null, error: null, created_at: 1, updated_at: 1, published_at: null,
};

type Call = { method: string; url: string; body: unknown };
type Reply = (call: Call) => Response | undefined;

async function mount(reply: Reply = () => undefined, account: string | null = 'acme-bot') {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'HTMLTextAreaElement', 'SVGElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event',
    'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'InputEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: Call[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    const custom = reply(call);
    if (custom) return custom;
    if (url === '/api/ui/projects/acme/integration') return Response.json({ integration: { mode: 'pr', account }, configured: true });
    if (url === `/api/ui/projects/acme/forge-proposals/${ID}`) return Response.json({ proposal: PROPOSAL });
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
  const type = async (el: Element | null | undefined, value: string) => {
    assert.ok(el, 'field to type in');
    const area = el as HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setter.call(area, value);
      area.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
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
  return { React, slots, calls, render, until, click, type, unmount };
}

const q = (selector: string) => document.querySelector<HTMLElement>(selector);
const writes = (calls: Call[]) => calls.filter((c) => c.method !== 'GET');

async function open(m: Awaited<ReturnType<typeof mount>>, extra: Record<string, unknown> = {}) {
  const { PublishDialog } = await import('./publish-dialog');
  const events: string[] = [];
  await m.render(m.React.createElement(PublishDialog, {
    project: 'acme', proposalId: ID, onClose: () => events.push('close'), onChange: () => events.push('change'), ...extra,
  }));
  await m.until(() => !!q('[data-publish-text]') || !!q('[data-publish-body]'), 'the text');
  return events;
}

test('the dialog shows the exact text, where it goes, as which account; nothing leaves before Publish', async () => {
  const m = await mount(({ method, url }) => (method === 'POST' && url.endsWith('/publish')
    ? Response.json({ proposal: { ...PROPOSAL, state: 'published', account: 'acme-bot', url: 'https://github.com/acme/app/issues/209#issuecomment-1' } })
    : undefined));
  try {
    const events = await open(m);
    assert.equal(q('[data-publish-text]')?.textContent, PROPOSAL.body);
    assert.equal(q('[data-publish-state]')?.textContent, 'to approve');
    const dialog = q('[data-publish-dialog]')!.textContent ?? '';
    assert.match(dialog, /Comment on issue #209 \(public\)/);
    assert.match(dialog, /acme\/app · issue #209/);
    await m.until(() => (q('[data-publish-dialog]')?.textContent ?? '').includes('acme-bot'), 'the account');
    assert.match(dialog, /A landed job/);
    assert.match(dialog, /Draft prepared by Timon/);
    assert.deepEqual(writes(m.calls), [], 'opening writes nothing');

    await m.click(q('[data-publish-send]'));
    await m.until(() => events.includes('close'), 'closed once published');
    const sent = writes(m.calls);
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, `/api/ui/projects/acme/forge-proposals/${ID}/publish`);
    assert.deepEqual(sent[0]!.body, { body: PROPOSAL.body }, 'the text on screen is the one sent');
    assert.deepEqual(events, ['change', 'close']);
  } finally {
    await m.unmount();
  }
});

test('a plugin\'s proposal names the plugin and asks for a full read', async () => {
  const fromPlugin = { ...PROPOSAL, trigger: 'plugin' as const, plugin: 'acme-issues', key: 'plugin:acme-issues:thanks:209' };
  const m = await mount(({ url }) => (url === `/api/ui/projects/acme/forge-proposals/${ID}` ? Response.json({ proposal: fromPlugin }) : undefined));
  try {
    await open(m);
    await m.until(() => (q('[data-publish-dialog]')?.textContent ?? '').includes('acme-bot'), 'the account');
    const dialog = q('[data-publish-dialog]')!.textContent ?? '';
    assert.match(dialog, /Plugin acme-issues/);
    assert.match(dialog, /Written by a plugin, not by Timon/);
    assert.doesNotMatch(dialog, /Draft prepared by Timon/);
    assert.deepEqual(writes(m.calls), [], 'opening writes nothing');
  } finally {
    await m.unmount();
  }
});

test('an edited text is saved, then published as edited; a refusal keeps the dialog open', async () => {
  let refuse = true;
  const m = await mount(({ method, url, body }) => {
    if (method === 'PATCH') return Response.json({ proposal: { ...PROPOSAL, body: (body as { body: string }).body } });
    if (method === 'POST' && url.endsWith('/publish') && refuse) {
      refuse = false;
      return Response.json({ error: { code: 'forge_account_mismatch', message: 'x', params: { detail: 'gh signs in as other' } } }, { status: 409 });
    }
    if (method === 'POST' && url.endsWith('/publish')) return Response.json({ proposal: { ...PROPOSAL, state: 'published' } });
    return undefined;
  });
  try {
    const events = await open(m);
    await m.click(q('[data-publish-edit]'));
    await m.type(q('[data-publish-body]'), 'Fixed in #53. Thanks!');
    await m.click(q('[data-publish-save]'));
    await m.until(() => !!q('[data-publish-text]'), 'back to the read text');
    const patch = writes(m.calls).find((c) => c.method === 'PATCH');
    assert.deepEqual(patch?.body, { body: 'Fixed in #53. Thanks!' });

    await m.click(q('[data-publish-send]'));
    await m.until(() => !!q('[data-publish-error]'), 'the refusal');
    assert.ok(!events.includes('close'), 'a refusal keeps the dialog open');
    assert.ok(q('[data-publish-dialog]'));

    await m.click(q('[data-publish-send]'));
    await m.until(() => events.includes('close'), 'published at the second click');
    const publishes = writes(m.calls).filter((c) => c.url.endsWith('/publish'));
    assert.deepEqual(publishes.map((c) => c.body), [{ body: 'Fixed in #53. Thanks!' }, { body: 'Fixed in #53. Thanks!' }]);
  } finally {
    await m.unmount();
  }
});

test('without an account on the project, Publish stays off; "Do not publish" closes the proposal', async () => {
  const m = await mount(({ method, url }) => (method === 'POST' && url.endsWith('/discard')
    ? Response.json({ proposal: { ...PROPOSAL, state: 'discarded' } })
    : undefined), null);
  try {
    const events = await open(m);
    await m.until(() => !!q('[data-publish-no-account]') && !(q('[data-publish-no-account]')?.textContent ?? '').includes('…'), 'no account');
    assert.equal(q('[data-publish-no-account]')?.textContent, 'No account set on the project');
    assert.equal((q('[data-publish-send]') as HTMLButtonElement).disabled, true);
    await m.click(q('[data-publish-discard]'));
    await m.until(() => events.includes('close'), 'closed');
    assert.deepEqual(writes(m.calls).map((c) => c.url), [`/api/ui/projects/acme/forge-proposals/${ID}/discard`]);
  } finally {
    await m.unmount();
  }
});

test('a new comment on a pull request becomes a proposal, then is published; an empty one cannot leave', async () => {
  const created = { ...PROPOSAL, id: 'b'.repeat(8) + '-0000-4000-8000-' + 'c'.repeat(12), trigger: 'person' as const,
    target: { type: 'pull' as const, number: 58, url: 'https://github.com/acme/app/pull/58' } };
  const m = await mount(({ method, url, body }) => {
    if (method === 'POST' && url === '/api/ui/projects/acme/forge-proposals') return Response.json({ proposal: { ...created, body: (body as { body: string }).body }, created: true }, { status: 201 });
    if (method === 'POST' && url.endsWith('/publish')) return Response.json({ proposal: { ...created, state: 'published' } });
    return undefined;
  });
  try {
    const events = await open(m, {
      proposalId: undefined,
      target: { type: 'pull', number: 58, url: 'https://github.com/acme/app/pull/58', repo: 'acme/app' },
    });
    assert.match(q('[data-publish-dialog]')?.textContent ?? '', /Comment on pull request #58 \(public\)/);
    assert.equal((q('[data-publish-send]') as HTMLButtonElement).disabled, true, 'an empty text cannot leave');
    await m.type(q('[data-publish-body]'), 'Could you rebase on main?');
    await m.until(() => !(q('[data-publish-send]') as HTMLButtonElement).disabled, 'the text and the account read');
    await m.click(q('[data-publish-send]'));
    await m.until(() => events.includes('close'), 'published');
    const sent = writes(m.calls);
    assert.deepEqual(sent.map((c) => [c.method, c.url]), [
      ['POST', '/api/ui/projects/acme/forge-proposals'],
      ['POST', `/api/ui/projects/acme/forge-proposals/${created.id}/publish`],
    ]);
    assert.deepEqual(sent[0]!.body, { kind: 'comment', target: { type: 'pull', number: 58 }, body: 'Could you rebase on main?' });
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes forge.publish.dialog paints it from usePublishDialog', async () => {
  const m = await mount();
  try {
    const { PublishDialog } = await import('./publish-dialog');
    const { usePublishDialog } = await import('./publish-dialog-context');
    const Acme: ComponentType = () => {
      const host = usePublishDialog();
      return m.React.createElement('div', { 'data-acme-publish': host?.target.number }, host?.body);
    };
    m.slots.register({ slot: 'forge.publish.dialog', pluginId: 'acme-forge' }, Acme);
    await m.render(m.React.createElement(PublishDialog, { project: 'acme', proposalId: ID, onClose: () => {} }));
    await m.until(() => q('[data-acme-publish]')?.textContent === PROPOSAL.body, 'the plugin\'s dialog');
    assert.equal(q('[data-acme-publish]')?.getAttribute('data-acme-publish'), '209');
    assert.ok(!q('[data-publish-dialog]'));
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-publish-dialog`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-publish-dialog', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__publishTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__publishTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __publishTestReact: React, __publishTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'plugin-publish-dialog-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-publish-dialog template publishes the edited text with the SDK alone', async () => {
  const m = await mount(({ method, url }) => (method === 'POST' && url.endsWith('/publish')
    ? Response.json({ proposal: { ...PROPOSAL, state: 'published' } })
    : undefined));
  const example = await loadExample();
  try {
    const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
    const { usePublishDialog } = await import('./publish-dialog-context');
    assert.equal(UI_KIT.usePublishDialog, usePublishDialog);
    const disposers: Array<() => void> = [];
    example.apply({ id: 'example-publish-dialog', slots: { register: (options: { slot: string }, Component: ComponentType) => {
      const dispose = m.slots.register({ ...options, pluginId: 'example-publish-dialog' }, Component);
      disposers.push(dispose);
      return dispose;
    } } });
    const { PublishDialog } = await import('./publish-dialog');
    const events: string[] = [];
    await m.render(m.React.createElement(PublishDialog, { project: 'acme', proposalId: ID, onClose: () => events.push('close') }));
    const area = () => q('textarea[aria-label="Text to publish"]') as HTMLTextAreaElement | null;
    await m.until(() => area()?.value === PROPOSAL.body && !(q('[data-plain-publish]') as HTMLButtonElement | null)?.disabled, 'the plain window, ready');
    assert.ok(!q('[data-publish-dialog]'), 'the product\'s window is not painted');
    assert.match(document.body.textContent ?? '', /Comment on issue #209 · as acme-bot/);
    await m.type(area(), 'Fixed in #53. Thanks!');
    await m.click(q('[data-plain-publish]'));
    await m.until(() => events.includes('close'), 'published');
    assert.deepEqual(writes(m.calls).map((c) => [c.url, c.body]), [
      [`/api/ui/projects/acme/forge-proposals/${ID}/publish`, { body: 'Fixed in #53. Thanks!' }],
    ]);
    assert.ok(m.calls.every((c) => c.url.startsWith('/api/ui/')), 'every call goes through the session proxy');
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('which proposal waits on which row', async () => {
  const { proposalsForLanding, proposalsForPull } = await import('./forge-proposals-api');
  const job = {
    id: 'j', project: 'acme', pr_number: 53, pr_url: 'https://github.com/ACME/app/pull/53',
    links: { todos: [], issues: [{ repo: 'acme/app', number: 209, url: null, todo_id: 1, closes: false }], series_id: null, pilot_mission_id: null },
  } as unknown as Landing;
  const onPull = { ...PROPOSAL, id: 'p', target: { ...PROPOSAL.target, type: 'pull' as const, number: 53 } };
  const otherProject = { ...PROPOSAL, id: 'o', project: 'other' };
  const done = { ...PROPOSAL, id: 'd', state: 'published' as const };
  const failed = { ...PROPOSAL, id: 'f', state: 'failed' as const };
  assert.deepEqual(proposalsForLanding([PROPOSAL, onPull, otherProject, done, failed], job).map((p) => p.id), [ID, 'p', 'f']);
  assert.deepEqual(proposalsForLanding([PROPOSAL], { ...job, links: undefined }).map((p) => p.id), [], 'no links, no issue');
  assert.deepEqual(proposalsForPull([PROPOSAL, onPull], 'acme/app', { number: 53 }).map((p) => p.id), ['p']);
  assert.deepEqual(proposalsForPull([PROPOSAL], 'acme/app', { number: 60, links: job.links! }).map((p) => p.id), [ID]);
  assert.deepEqual(proposalsForPull([onPull], 'acme/other', { number: 53 }).map((p) => p.id), [], 'another repository');
});

test('a job\'s row says a publication waits, and opens it', async () => {
  const job: Landing = {
    id: 'job-53', project: 'acme', series_id: null, branch: 'feat/tray', remote: 'origin', target: 'main', mode: 'pr',
    state: 'merged', pr_number: 53, pr_url: 'https://github.com/acme/app/pull/53', head_sha: null, merge_sha: null, landed: true,
    created_at: 1, updated_at: Date.now(), checks: null, conflict: null, checks_running: false, pr_title: 'Keep the tray icon',
    links: { todos: [], issues: [{ repo: 'acme/app', number: 209, url: null, todo_id: null, closes: false }], series_id: null, pilot_mission_id: null },
  };
  const m = await mount(({ url }) => {
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [job] });
    if (url === '/api/ui/projects/acme/forge-proposals') return Response.json({ proposals: [PROPOSAL] });
    return undefined;
  });
  try {
    const { LandingWidget } = await import('./landing-widget');
    const { WidgetSelfProvider } = await import('@/components/widget-host/widget-self');
    // One tab of the Git stack: the widget asks for a dot on its tab too.
    const dots: Array<string | null> = [];
    const self = {
      id: 'jobs', tabbed: true, selected: true, publishCount: () => {}, publishMenu: () => {},
      publishAttention: (_id: string, label: string | null) => { dots.push(label); },
    };
    await m.render(m.React.createElement(WidgetSelfProvider, { value: self }, m.React.createElement(LandingWidget, { handle: null })));
    await m.until(() => !!q('[data-landing="job-53"] [data-proposal-chip]'), 'the chip');
    assert.equal(q('[data-proposal-chip]')?.textContent, 'to approve');
    assert.equal(dots.at(-1), '1 publication to approve', 'the dot on the Jobs tab');
    await m.click(q('[data-proposal-chip]'));
    await m.until(() => q('[data-publish-text]')?.textContent === PROPOSAL.body, 'the dialog on it');
    assert.deepEqual(writes(m.calls), []);
  } finally {
    await m.unmount();
  }
});
