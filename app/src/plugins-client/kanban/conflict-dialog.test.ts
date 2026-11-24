/**
 * A contributor's branch from the Pull requests widget: the menu offers what
 * GitHub's state and the project's setting allow, a branch update opens in
 * "Publish on GitHub" with no text to edit, and the Conflict dialog resolves
 * each file, shows what the commit changes, then hands its publication over.
 * Nothing is sent to GitHub from here: the only writes are the daemon's
 * routes that prepare a proposal or a resolution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  capLines, conflictBlocks, conflictHunks, hasConflictMarkers, lineDiff, MAX_SHOWN_LINES, shownDiff,
} from './conflict-model';
import { branchChip, type PullRequestItem } from './pull-requests-model';

const MERGED = [
  'import { app } from "electron";',
  '',
  'export function onHide(win) {',
  '<<<<<<< contributor',
  '  if (!win.isVisible() && !updating) hideTray();',
  '=======',
  '  if (!win.isVisible()) keepTray();',
  '>>>>>>> main',
  '}',
].join('\n');
const CONTRIBUTOR = MERGED.split('\n').filter((_, i) => ![3, 5, 6, 7].includes(i)).join('\n');
const TARGET = MERGED.split('\n').filter((_, i) => ![3, 4, 5, 7].includes(i)).join('\n');

test('the model counts blocks, tells the sides apart and keeps a little context', () => {
  assert.equal(conflictBlocks(MERGED), 1);
  assert.equal(conflictBlocks(null), 0);
  assert.ok(hasConflictMarkers(MERGED));
  assert.ok(!hasConflictMarkers(CONTRIBUTOR));
  // A line of equal signs inside a text is not a marker unless it stands alone.
  assert.ok(!hasConflictMarkers('a ======= b\n========'));

  const hunks = conflictHunks(MERGED);
  const kinds = hunks.map((l) => l.kind);
  assert.deepEqual(kinds, ['same', 'same', 'same', 'marker', 'ours', 'marker', 'theirs', 'marker', 'same']);
  const long = ['x', 'x', 'x', 'x', 'x', 'x', 'x', MERGED].join('\n');
  assert.equal(conflictHunks(long)[0]?.kind, 'gap');
});

test('a resolution reads as a diff against the contributor\'s version, cut to what changed', () => {
  assert.deepEqual(shownDiff(CONTRIBUTOR, CONTRIBUTOR), []);
  const diff = shownDiff(CONTRIBUTOR, TARGET);
  assert.deepEqual(diff.filter((l) => l.kind === 'del').map((l) => l.kind !== 'gap' && l.text), ['  if (!win.isVisible() && !updating) hideTray();']);
  assert.deepEqual(diff.filter((l) => l.kind === 'add').map((l) => l.kind !== 'gap' && l.text), ['  if (!win.isVisible()) keepTray();']);
  // Unchanged lines far from the change become one gap.
  const before = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 20', 'line twenty');
  const cut = shownDiff(before, after);
  assert.equal(cut[0]?.kind, 'gap');
  assert.equal(cut.at(-1)?.kind, 'gap');
  assert.ok(cut.length < 12);
  // A huge rewrite still answers, as removals then additions.
  const huge = lineDiff(Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n'), Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n'));
  assert.equal(huge.length, 6000);
  assert.equal(capLines(huge.map((d) => ({ ...d, line: null }))).hidden, 6000 - MAX_SHOWN_LINES);
});

function pull(extra: Partial<PullRequestItem> = {}): PullRequestItem {
  return {
    number: 58, title: 'fix(tray): keep the icon', author: 'bob', url: 'https://github.com/acme/widgets/pull/58',
    isDraft: false, updatedAt: '2026-11-19T10:00:00Z', headOwner: 'bob', external: true, review: null,
    mergeStateStatus: 'clean', gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false }, ...extra,
  };
}

test('the row names a conflict, and a branch behind only when it can be updated', () => {
  assert.equal(branchChip(pull()), null);
  assert.equal(branchChip(pull({ mergeStateStatus: 'dirty' })), 'conflict');
  assert.equal(branchChip(pull({ mergeStateStatus: 'behind' })), null);
  assert.equal(branchChip(pull({ mergeStateStatus: 'behind', gestures: { update_branch: true, ask_contributor: false, resolve_conflict: false } })), 'behind');
});

type Call = { url: string; method: string; body: unknown };
const CONFLICT_ID = '3b1d2c4e-5f60-4a7b-8c9d-0e1f2a3b4c5d';
const PROPOSAL_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';

function proposal(kind: string, body: string, extra: Record<string, unknown> = {}) {
  return {
    id: PROPOSAL_ID, project: 'acme', repo: 'acme/widgets', kind, target: { type: 'pull', number: 58, url: 'https://github.com/acme/widgets/pull/58' },
    body, state: 'draft', trigger: 'person', plugin: null, key: 'k', source_ref: null, details: null, editable: kind !== 'update_branch',
    account: null, url: null, error: null, created_at: 1, updated_at: 1, published_at: null, ...extra,
  };
}

const HOSTILE = '<img src=x onerror="alert(1)">';

async function mount(list: PullRequestItem[]) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node',
    'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent',
    'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const file = (resolution: unknown) => ({
    path: 'app/src/tray.ts', mode: '100644', sensitive: false, base: null, contributor: CONTRIBUTOR, target: TARGET, merged: MERGED, resolution,
  });
  const view = (state: string, resolution: unknown, extra: Record<string, unknown> = {}) => ({
    id: CONFLICT_ID, project: 'acme', repo: 'acme/widgets', number: 58, url: 'https://github.com/acme/widgets/pull/58',
    head: { repository: 'bob/widgets', ref: 'tray-icon', sha: 'f'.repeat(40) }, base: { ref: 'main', sha: 'e'.repeat(40) },
    state, proposal_id: null, commit_sha: null, files: [file(resolution)], created_at: 1, updated_at: 1, ...extra,
  });
  let current = view('open', null);
  let published: unknown = null;

  const calls: Call[] = [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, method, body });
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'acme', name: 'Acme' }] });
    if (url === '/api/ui/projects/acme/pull-requests') return Response.json({ repo: 'acme/widgets', pulls: list });
    if (url === '/api/ui/projects/acme/integration') return Response.json({ integration: { mode: 'pr', account: 'acme-bot' }, configured: true });
    if (url.startsWith('/api/ui/projects/acme/forge-proposals?') || url === '/api/ui/projects/acme/forge-proposals') return Response.json({ proposals: [] });
    if (url.endsWith('/pull-requests/58/update-branch')) {
      return Response.json({ proposal: proposal('update_branch', 'Update the branch of #58 on GitHub', {
        details: { expected_head_sha: 'a'.repeat(40), base_ref: 'main', head_ref: 'tray-icon', head_repository: 'bob/widgets' },
      }), created: true }, { status: 201 });
    }
    if (url.endsWith(`/forge-proposals/${PROPOSAL_ID}/publish`)) {
      published = body;
      if (current.state === 'proposed') {
        const reason = 'the push URL is no longer the one shown: discard this publication and propose the resolution again';
        return Response.json({ error: reason, code: 'forge_conflict_changed', params: { detail: reason } }, { status: 409 });
      }
      return Response.json({ proposal: proposal('update_branch', 'x', { state: 'published' }) });
    }
    if (url.endsWith(`/forge-proposals/${PROPOSAL_ID}`)) {
      const kind = current.state === 'proposed' ? 'conflict_push' : 'update_branch';
      return Response.json({ proposal: proposal(kind, kind === 'conflict_push' ? 'This branch conflicted with `main`…' : 'Update the branch of #58 on GitHub', {
        details: kind === 'conflict_push'
          ? { commit_sha: 'c'.repeat(40), expected_head_sha: 'f'.repeat(40), head_repository: 'bob/widgets', head_ref: 'tray-icon', base_ref: 'main', files: ['app/src/tray.ts'],
            push_host: 'github.com', push_repository: 'bob/widgets', push_url: 'git@github.com:bob/widgets.git' }
          : { expected_head_sha: 'a'.repeat(40), base_ref: 'main', head_ref: 'tray-icon', head_repository: 'bob/widgets' },
      }) });
    }
    if (url.endsWith('/pull-requests/58/conflict')) return Response.json({ conflict: current, created: true }, { status: 201 });
    if (url.endsWith(`/forge-conflicts/${CONFLICT_ID}/suggest`)) return Response.json({ path: 'app/src/tray.ts', text: `${HOSTILE}\n${TARGET}` });
    if (url.endsWith(`/forge-conflicts/${CONFLICT_ID}/files`)) {
      const b = body as { choice: string; text?: string };
      current = view('open', { choice: b.choice, text: b.choice === 'text' ? b.text ?? null : null });
      return Response.json({ conflict: current });
    }
    if (url.endsWith(`/forge-conflicts/${CONFLICT_ID}/propose`)) {
      current = view('proposed', current.files[0]!.resolution, { proposal_id: PROPOSAL_ID, commit_sha: 'c'.repeat(40) });
      return Response.json({ conflict: current, proposal: proposal('conflict_push', 'comment'), diff: { text: 'diff --git a/app/src/tray.ts b/app/src/tray.ts\n@@ -4 +4 @@\n-old\n+new', truncated: false } }, { status: 201 });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  localStorage.setItem('timon.git-stack.project', 'acme');
  const { PullRequestsWidget } = await import('./pull-requests-widget');
  (await import('./pull-requests-model')).forgetPullListsForTests();
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(PullRequestsWidget, { handle: null })); });
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const fire = async (el: Element | null, event: Event) => {
    assert.ok(el);
    await React.act(async () => { el.dispatchEvent(event); });
    await settle();
  };
  const click = (el: Element | null) => fire(el, new dom.window.MouseEvent('click', { bubbles: true }));
  /** Radix opens a menu from the keyboard as well as from a pointer. */
  const openMenu = (row: number) => fire(
    document.querySelector(`[data-pull-row="${row}"] button[aria-haspopup="menu"]`),
    new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
  );
  const type = async (el: Element | null, value: string) => {
    assert.ok(el);
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setter.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    // Radix returns the focus on a timer once a dialog unmounts: let it run against this window.
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { calls, click, openMenu, type, settle, unmount, published: () => published };
}

const posts = (calls: readonly Call[]) => calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace('/api/ui/projects/acme', '')}`);

test('the menu offers only what the branch allows, and a branch update opens in Publish with no text to edit', async () => {
  const m = await mount([
    pull({ mergeStateStatus: 'behind', gestures: { update_branch: true, ask_contributor: false, resolve_conflict: false } }),
    pull({ number: 57, mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: false } }),
  ]);
  try {
    assert.equal(document.querySelector('[data-pull-row="58"] [data-pull-branch]')?.getAttribute('data-pull-branch'), 'behind');
    assert.equal(document.querySelector('[data-pull-row="57"] [data-pull-branch]')?.getAttribute('data-pull-branch'), 'conflict');

    await m.openMenu(57);
    assert.ok(document.querySelector('[data-menu-ask-contributor]'));
    assert.ok(!document.querySelector('[data-menu-update-branch]'));
    assert.ok(!document.querySelector('[data-menu-resolve-conflict]'), 'the project asks the contributor');
    await m.click(document.querySelector('[data-menu-comment]'));
    await m.click(document.querySelector('[data-publish-cancel]'));

    await m.openMenu(58);
    assert.ok(!document.querySelector('[data-menu-ask-contributor]'));
    await m.click(document.querySelector('[data-menu-update-branch]'));
    assert.deepEqual(posts(m.calls), ['POST /pull-requests/58/update-branch'], 'preparing reaches nothing but the daemon');
    const dialog = document.querySelector('[data-publish-dialog]');
    assert.ok(dialog);
    assert.match(dialog.textContent ?? '', /bob\/widgets:tray-icon/);
    assert.match(dialog.textContent ?? '', /aaaaaaaaaaaa/);
    assert.ok(!document.querySelector('[data-publish-edit]'), 'a branch update has no text to edit');
    assert.ok(!document.querySelector('[data-publish-body]'));
    assert.match(document.querySelector('[data-publish-send]')?.textContent ?? '', /Update the branch/);
    await m.click(document.querySelector('[data-publish-send]'));
    assert.deepEqual(m.published(), { body: 'Update the branch of #58 on GitHub' }, 'the daemon\'s text leaves as it is');
  } finally {
    await m.unmount();
  }
});

test('a contributor\'s branch the maintainers may not change says so, with only "Ask the contributor" left', async () => {
  const locked = { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: 'not_allowed' as const };
  const m = await mount([
    pull({ mergeStateStatus: 'dirty', gestures: locked }),
    pull({ number: 57, gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false, locked: 'fork_deleted' } }),
    pull({ number: 56 }),
  ]);
  try {
    const chip = document.querySelector('[data-pull-row="58"] [data-pull-locked]');
    assert.equal(chip?.textContent, 'Changes not allowed');
    assert.match(chip?.getAttribute('title') ?? '', /does not let the maintainers change this branch/, 'the reason on hover');
    assert.equal(document.querySelector('[data-pull-row="57"] [data-pull-locked]')?.textContent, 'Fork deleted');
    assert.ok(!document.querySelector('[data-pull-row="56"] [data-pull-locked]'), 'a branch we may write says nothing');
    await m.openMenu(58);
    assert.ok(document.querySelector('[data-menu-ask-contributor]'));
    assert.ok(!document.querySelector('[data-menu-update-branch]'));
    // The resolution its conflict calls for stays, greyed, with the reason on hover.
    const resolve = document.querySelector('[data-menu-resolve-conflict]');
    assert.ok(resolve);
    assert.ok(resolve.hasAttribute('data-disabled'));
    assert.match(resolve.getAttribute('title') ?? '', /does not let the maintainers change this branch/);
    const reason = document.getElementById(resolve.getAttribute('aria-describedby') ?? '');
    assert.match(reason?.textContent ?? '', /does not let the maintainers change this branch/);
  } finally {
    await m.unmount();
  }
});

test('the Conflict dialog resolves a file, shows the commit, and hands its publication to Publish on GitHub', async () => {
  const m = await mount([pull({ mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: true } })]);
  try {
    await m.openMenu(58);
    await m.click(document.querySelector('[data-menu-resolve-conflict]'));
    const dialog = () => document.querySelector('[data-conflict-dialog]');
    assert.ok(dialog());
    assert.match(dialog()!.textContent ?? '', /Resolve the conflict · #58 bob:tray-icon/);
    assert.match(dialog()!.textContent ?? '', /acme-bot/);
    assert.doesNotMatch(dialog()!.textContent ?? '', /allowed by the contributor|Files in conflict:/, 'no check row the dialog cannot vouch for');
    assert.equal(document.querySelector('[data-line="marker"]')?.textContent?.trim(), '<<<<<<< contributor');
    assert.equal(document.querySelector('[data-conflict-next]')?.hasAttribute('disabled'), true, 'a file is left to resolve');

    // The agent's suggestion is shown as text and applied only on a click.
    await m.click(document.querySelector('[data-conflict-suggest]'));
    assert.ok(dialog()!.textContent?.includes(HOSTILE));
    assert.ok(!document.querySelector('img'), 'a suggestion is text, never markup');
    assert.equal(m.calls.filter((c) => c.url.endsWith('/files')).length, 0);
    await m.click(document.querySelector('[data-conflict-ignore]'));

    // Editing by hand refuses markers before anything is sent.
    await m.click(document.querySelector('[data-conflict-edit]'));
    assert.equal(document.querySelector('[data-conflict-save]')?.hasAttribute('disabled'), true);
    await m.type(document.querySelector('[data-conflict-editor]'), TARGET);
    assert.equal(document.querySelector('[data-conflict-save]')?.hasAttribute('disabled'), false);
    await m.click(document.querySelector('[data-conflict-save]'));
    const put = m.calls.find((c) => c.url.endsWith('/files'));
    assert.deepEqual(put?.body, { path: 'app/src/tray.ts', choice: 'text', text: TARGET });
    assert.equal(document.querySelector('[data-conflict-state]')?.getAttribute('data-conflict-state'), 'text');
    assert.ok(document.querySelector('[data-line="add"]'), 'the resolution reads as a diff');

    await m.click(document.querySelector('[data-conflict-keep="contributor"]'));
    assert.ok(document.querySelector('[data-conflict-no-change]'));

    await m.click(document.querySelector('[data-conflict-next]'));
    assert.ok(document.querySelector('[data-conflict-preview]'));
    assert.equal(document.querySelector('[data-conflict-step="3"]')?.getAttribute('data-state'), 'current');
    await m.click(document.querySelector('[data-conflict-publish]'));
    assert.ok(!dialog(), 'the conflict closes before its publication opens');
    const publish = document.querySelector('[data-publish-dialog]');
    assert.ok(publish);
    assert.match(publish.textContent ?? '', /cccccccccccc/);
    assert.match(document.querySelector('[data-publish-send]')?.textContent ?? '', /Push and comment/);
    const to = document.querySelector('[data-publish-push-to]');
    assert.equal(to?.textContent, 'bob/widgets on github.com', 'the host and the fork the commit goes to');
    assert.equal(to?.getAttribute('title'), 'git@github.com:bob/widgets.git');
    assert.deepEqual(posts(m.calls), [
      'POST /pull-requests/58/conflict',
      `POST /forge-conflicts/${CONFLICT_ID}/suggest`,
      `PUT /forge-conflicts/${CONFLICT_ID}/files`,
      `PUT /forge-conflicts/${CONFLICT_ID}/files`,
      `POST /forge-conflicts/${CONFLICT_ID}/propose`,
    ], 'nothing is published from the Conflict dialog');

    // The remote moved since: the refusal says that nothing left and what to do.
    await m.click(document.querySelector('[data-publish-send]'));
    assert.match(document.querySelector('[data-publish-error]')?.textContent ?? '', /nothing was pushed\. Choose Do not push, then resolve the conflict again/);
  } finally {
    await m.unmount();
  }
});
