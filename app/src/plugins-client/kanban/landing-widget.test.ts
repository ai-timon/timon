import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landing, LandingPreview } from './landing-api';

/**
 * The jobs widget: one row per job with its state and checks, in groups by
 * what it waits for, the checks asked again while one runs, and the preview
 * dialog with the diff, the commits and the dry pre-checks.
 */

const branchJob: Landing = {
  id: 'job-branch', project: 'acme', series_id: 's1', branch: 'feat/add-export', remote: 'origin', target: 'main',
  mode: 'pr', state: 'branch', pr_number: null, pr_url: null, head_sha: null, merge_sha: null, landed: false,
  created_at: 2, updated_at: 2, checks: null, conflict: null, checks_running: false, pr_title: null,
};

const openJob: Landing = {
  ...branchJob,
  id: 'job-open', branch: 'feat/csv', state: 'open', pr_number: 12, pr_url: 'https://github.com/acme/app/pull/12',
  pr_title: 'Add CSV export', conflict: true, checks_running: true,
  checks: {
    read_at: 1, draft: false, mergeable: 'conflicting', review: 'review_required',
    counts: { pass: 2, fail: 1, pending: 1, skipped: 0 },
    items: [],
  },
};

const settled: Landing = {
  ...openJob,
  checks_running: false,
  checks: { ...openJob.checks!, counts: { pass: 3, fail: 1, pending: 0, skipped: 0 } },
};

const preview: LandingPreview = {
  integration: branchJob, head_sha: 'b'.repeat(40), target_sha: 'a'.repeat(40), problem: null,
  commit_count: 1,
  commits: [{ sha: 'c'.repeat(40), short: 'ccccccc', author: 'Acme Bot', subject: 'feat(app): add export' }],
  commits_truncated: false,
  files: [{
    path: 'src/export.ts', additions: 1, deletions: 1, binary: false, patch_truncated: false,
    patch: 'diff --git a/src/export.ts b/src/export.ts\nindex 1..2 100644\n--- a/src/export.ts\n+++ b/src/export.ts\n@@ -1 +1 @@\n-old line\n+new line',
  }],
  files_truncated: false, patch_truncated: false,
  totals: { files: 1, additions: 1, deletions: 1 },
  conflict: { state: 'clean', files: [] },
  pull_request: null,
  prechecks: {
    ran: true, ready: false,
    checks: [
      { name: 'account', ok: true, detail: 'gh signs in as ai-bot' },
      { name: 'commit_messages', ok: false, detail: 'messages carry internal references' },
      { name: 'public_tree', ok: true, skipped: true, detail: 'checked only when the pull request is opened' },
    ],
  },
};

type Ctx = { React: typeof import('react'); calls: string[] };

async function show(run: (ctx: Ctx) => Promise<void>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement',
    'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
    'CustomEvent', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const calls: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/job-open/checks')) return Response.json({ landing: settled, fresh: true });
    if (url.endsWith('/job-branch/preview')) return Response.json(preview);
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [branchJob, openJob] });
    return Response.json({});
  });
  const { createRoot } = await import('react-dom/client');
  const { LandingWidget } = await import('./landing-widget');
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => {
      root.render(React.createElement(LandingWidget, { handle: null }));
    });
    // Let the list and the first checks answer.
    await React.act(async () => { await new Promise<void>((r) => setTimeout(r, 30)); });
    await run({ React, calls });
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise<void>((r) => setTimeout(r, 20));
    const globals = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
}

function card(id: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-landing="${id}"]`);
  assert.ok(el, `card ${id} is rendered`);
  return el;
}

test('one row per job, in groups, with its state, conflict and checks', async () => {
  await show(async ({ calls }) => {
    const branch = card('job-branch');
    assert.match(branch.textContent!, /feat\/add-export/);
    assert.match(branch.textContent!, /Not pushed/);

    const open = card('job-open');
    assert.match(open.textContent!, /PR #12/);
    assert.match(open.textContent!, /Add CSV export/);
    assert.match(open.textContent!, /feat\/csv/, 'the branch under the title');
    assert.match(open.textContent!, /Conflict/);
    assert.equal(open.querySelectorAll('a').length, 0, 'no link in the row: one action, the rest in its menu');
    assert.equal(open.querySelector('[data-landing-action]')?.getAttribute('aria-label'), 'Preview');

    // The conflict puts it on top, the branch under "In progress".
    const groups = Array.from(document.querySelectorAll('[data-landing-group]')).map((g) => g.getAttribute('data-landing-group'));
    assert.deepEqual(groups, ['attention', 'progress']);
    assert.match(document.querySelector('[data-landing-group="attention"]')!.textContent!, /Needs action\s*1/);

    // The check that was running is asked again at once; the branch never is.
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job-open/checks'));
    assert.ok(!calls.some((c) => c.includes('job-branch/checks')));
    // Settled: 1 failed, none running; the passed ones are not the news.
    assert.ok(open.querySelector('[title="1 check failed"]'));
    assert.ok(!open.querySelector('[title="3 checks passed"]'));
    assert.ok(!open.querySelector('[title$="running"]'));
  });
});

test('the preview shows the diff, the commits and the dry pre-checks', async () => {
  await show(async ({ React, calls }) => {
    const button = card('job-branch').querySelector<HTMLButtonElement>('[data-landing-action="preview"]');
    assert.ok(button);
    await React.act(async () => { button.click(); });
    await React.act(async () => { await new Promise<void>((r) => setTimeout(r, 30)); });
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job-branch/preview'));

    const body = document.body.textContent!;
    assert.match(body, /1 commit, 1 file/);
    assert.match(body, /Merges cleanly into origin\/main/);
    assert.match(body, /1 check refuses/);
    // A short diff opens whole, its lines painted by kind.
    assert.equal(document.querySelector('[data-kind="add"]')?.textContent, '+new line');
    assert.equal(document.querySelector('[data-kind="del"]')?.textContent, '-old line');
    assert.equal(document.querySelector('[data-kind="hunk"]')?.textContent, '@@ -1 +1 @@');
  });
});

test('diff lines, patch bodies and the jobs to refresh', async () => {
  const { diffLineKind, patchBody, landingsToRefresh } = await import('./landing-api');
  assert.equal(diffLineKind('+++ b/x'), 'meta');
  assert.equal(diffLineKind('+x'), 'add');
  assert.equal(diffLineKind('-x'), 'del');
  assert.equal(diffLineKind('@@ -1 +1 @@'), 'hunk');
  assert.equal(diffLineKind(' x'), 'context');
  assert.deepEqual(patchBody('diff --git a/x b/x\nindex 1..2\n@@ -1 +1 @@\n-a\n+b'), ['@@ -1 +1 @@', '-a', '+b']);
  assert.deepEqual(landingsToRefresh([branchJob, openJob, settled, { ...settled, id: 'unread', checks: null }]).map((l) => l.id), ['job-open', 'unread']);
});

test('the groups: what needs a gesture first, landed jobs for a week only', async () => {
  const { groupLandings, landingGroup, landingAction, LANDED_WINDOW_MS } = await import('./landing-api');
  const now = 10 * LANDED_WINDOW_MS;
  const at = (l: Landing, updated: number): Landing => ({ ...l, updated_at: updated });
  const clean: Landing = {
    ...settled, id: 'clean', conflict: false,
    checks: { ...settled.checks!, mergeable: 'mergeable', counts: { pass: 4, fail: 0, pending: 0, skipped: 0 } },
  };
  assert.equal(landingGroup(clean, now), 'review');
  assert.equal(landingGroup({ ...clean, checks: { ...clean.checks!, counts: { ...clean.checks!.counts, fail: 1 } } }, now), 'attention');
  assert.equal(landingGroup({ ...clean, checks: { ...clean.checks!, mergeable: 'conflicting' } }, now), 'attention');
  assert.equal(landingGroup({ ...clean, checks: { ...clean.checks!, review: 'changes_requested' } }, now), 'attention');
  assert.equal(landingGroup({ ...clean, checks: null }, now), 'review', 'checks not read yet: waiting, not alarming');
  assert.equal(landingGroup(branchJob, now), 'progress');
  const merged: Landing = { ...clean, id: 'merged', state: 'merged', landed: true };
  assert.equal(landingGroup(at(merged, now - 1000), now), 'landed');
  assert.equal(landingGroup(at(merged, now - LANDED_WINDOW_MS - 1), now), null, 'old news');
  const closed: Landing = { ...clean, id: 'closed', state: 'closed' };
  assert.equal(landingGroup(at(closed, now - 1000), now), 'attention', 'closed without its merge: a decision to take');
  assert.equal(landingGroup(at(closed, now - LANDED_WINDOW_MS - 1), now), null);

  const grouped = groupLandings([at(merged, now - 5), at(branchJob, now - 3), at(clean, now - 2), at({ ...settled, id: 'late' }, now - 9), at(settled, now - 1)], now);
  assert.deepEqual(grouped.map((g) => [g.group, g.landings.map((l) => l.id)]), [
    ['attention', ['job-open', 'late']],
    ['review', ['clean']],
    ['progress', ['job-branch']],
    ['landed', ['merged']],
  ]);

  assert.equal(landingAction(clean), 'preview');
  assert.equal(landingAction(merged), 'openPr', 'merged: its pull request, the preview is empty');
  assert.equal(landingAction({ ...merged, pr_url: null }), 'preview');
});
