/**
 * The "Open pull requests" widget: the list of one project, the author filter,
 * the verdict on the row, and the prepared brief shown beside the diff, which
 * the person copies: the widget starts no relecture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  anyReviewRunning, filterByAuthor, pullAuthors, reviewBadge, type PullRequestItem,
} from './pull-requests-model';

function pull(extra: Partial<PullRequestItem> = {}): PullRequestItem {
  return {
    number: 12, title: 'Add a dark theme', author: 'stranger', url: 'https://github.com/acme/widgets/pull/12',
    isDraft: false, updatedAt: '2026-11-17T10:00:00Z', headOwner: 'stranger', external: true, review: null, ...extra,
  };
}

const review = (extra: Partial<NonNullable<PullRequestItem['review']>> = {}): NonNullable<PullRequestItem['review']> => ({
  id: 'r1', number: 12, state: 'done', agent: 'acme.reviewer', verdict: 'mergeable', report: 'VERDICT: MERGEABLE',
  mission_id: 'm1', pr_updated_at: '2026-11-17T10:00:00Z', updated_at: 1, ...extra,
});

test('the author filter lists each author once and keeps their pull requests', () => {
  const list = [pull(), pull({ number: 13, author: 'ai-bot' }), pull({ number: 14 }), pull({ number: 15, author: null })];
  assert.deepEqual(pullAuthors(list), ['ai-bot', 'stranger']);
  assert.deepEqual(filterByAuthor(list, 'stranger').map((p) => p.number), [12, 14]);
  assert.equal(filterByAuthor(list, null).length, 4);
});

test('a row shows the verdict, outdated once the pull request changed; a draft shows nothing', () => {
  assert.equal(reviewBadge(pull()), null);
  assert.equal(reviewBadge(pull({ review: review({ state: 'draft' }) })), null);
  assert.deepEqual(reviewBadge(pull({ review: review({ state: 'running', verdict: null }) })), { kind: 'running' });
  assert.deepEqual(reviewBadge(pull({ review: review() })), { kind: 'verdict', verdict: 'mergeable', outdated: false });
  assert.deepEqual(reviewBadge(pull({ updatedAt: '2026-11-18T08:00:00Z', review: review() })),
    { kind: 'verdict', verdict: 'mergeable', outdated: true });
  assert.ok(anyReviewRunning([pull(), pull({ review: review({ state: 'running' }) })]));
});

type Call = { url: string; method: string; body: string | null };

const DETAIL_DIFF = 'diff --git a/x b/x\n@@ -1 +1 @@\n-old\n+new';

/** A pull request's page as the daemon answers it (`pull-request-page.ts`). */
const PAGE = {
  number: 12, title: 'Add a dark theme', url: 'https://github.com/acme/widgets/pull/12', state: 'open', isDraft: false,
  author: 'stranger', createdAt: '2026-11-17T10:00:00Z', updatedAt: '2026-11-17T10:00:00Z', mergedAt: null, closedAt: null,
  baseRef: 'main', headRef: 'dark-theme', headSha: 'a'.repeat(40), headOwner: 'stranger', headRepository: 'stranger/widgets',
  isCrossRepository: true, maintainerCanModify: true, mergeable: 'conflicting', mergeStateStatus: 'dirty',
  reviewDecision: 'changes_requested', additions: 1, deletions: 1, changedFiles: 1,
  body: 'The app hurts at night. [spec](https://example.com/spec) [x](javascript:alert(1)) <script>alert(1)</script>',
  bodyTruncated: false,
  labels: [{ name: 'ui', color: 'a2eeef' }], milestone: { title: '0.2', url: 'https://github.com/acme/widgets/milestone/3' },
  assignees: ['maintainer'], assigneesMore: 0, reviewRequests: ['reviewer', 'acme/core'], reviewRequestsMore: 2,
  closingIssues: [{ repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/issues/7' }],
  timeline: [
    { kind: 'review', author: 'reviewer', state: 'changes_requested', body: 'A few things.', bodyTruncated: false, createdAt: '2026-11-17T11:00:00Z' },
    { kind: 'comment', author: 'maintainer', body: 'Thanks!', bodyTruncated: false, createdAt: '2026-11-17T12:00:00Z', url: 'http://github.com/insecure', hidden: false },
  ],
  timelineMore: 3,
  commits: [{ sha: 'b'.repeat(40), headline: 'feat: dark theme', author: 'stranger', date: '2026-11-17T09:00:00Z', url: `https://github.com/acme/widgets/commit/${'b'.repeat(40)}` }],
  commitsMore: 0,
  files: [{ path: 'x', additions: 1, deletions: 1 }],
  filesMore: 0,
  checks: [
    { name: 'test', status: 'fail', url: 'https://github.com/acme/widgets/actions/runs/1/job/2', workflow: 'CI', startedAt: '2026-11-17T09:01:00Z', completedAt: '2026-11-17T09:04:30Z' },
    { name: 'lint', status: 'pass', url: null, workflow: 'CI', startedAt: null, completedAt: null },
  ],
  checksMore: 0,
  threads: [{
    path: 'x', line: 1, resolved: false, outdated: false, commentsMore: 0,
    comments: [{ author: 'reviewer', body: 'Rename this.', bodyTruncated: false, createdAt: '2026-11-17T11:00:00Z', url: 'https://github.com/acme/widgets/pull/12#discussion_r1' }],
  }],
  threadsMore: 0,
  threadsError: null,
};

/** How the widget is painted: alone by default, or as a tab of the Git stack. */
type Self = { tabbed: boolean; selected: boolean };

/**
 * `width`: what a ResizeObserver reports of every element it watches (none by
 * default). `page`: what the daemon answers for pull request #12, or how it
 * answers when the answer is not a page.
 */
type PageAnswer = object | (() => Promise<Response>);

async function mount(list: PullRequestItem[], self?: Self, keepRead = false, width?: number, page: PageAnswer = PAGE) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node',
    'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent',
    'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class {
    constructor(private readonly report: (entries: Array<{ contentRect: { width: number } }>) => void) {}
    observe() { if (width !== undefined) this.report([{ contentRect: { width } }]); }
    unobserve() {}
    disconnect() {}
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const opened: string[] = [];
  dom.window.open = ((href: string) => { opened.push(String(href)); return null; }) as typeof dom.window.open;
  const copied: string[] = [];
  Object.defineProperty(dom.window.navigator, 'clipboard', {
    value: { writeText: async (text: string) => { copied.push(text); } }, configurable: true,
  });

  const calls: Call[] = [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, method: init.method ?? 'GET', body: typeof init.body === 'string' ? init.body : null });
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'acme', name: 'Acme' }] });
    if (url === '/api/ui/projects/acme/pull-requests') return Response.json({ repo: 'acme/widgets', pulls: list });
    if (url.endsWith('/review')) {
      return Response.json({
        review: { id: '7d1c2a43-9b1e-4f3c-8a52-1f0e2d3c4b5a', agent: 'acme.reviewer', state: 'draft' },
        brief: 'Review pull request #12 of acme/widgets…\n<untrusted-data>\n{}\n</untrusted-data>',
      });
    }
    if (url.endsWith('/diff')) return Response.json({ diff: DETAIL_DIFF, truncated: false });
    if (url.startsWith('/api/ui/projects/acme/pull-requests/12/check-log?')) return Response.json({ log: { tail: 'Error: boom', truncated: false } });
    if (/^\/api\/ui\/projects\/acme\/pull-requests\/12(\?|$)/.test(url)) {
      return typeof page === 'function' ? (page as () => Promise<Response>)() : Response.json({ pull: page, cached: false });
    }
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { PullRequestsWidget } = await import('./pull-requests-widget');
  const { WidgetSelfProvider } = await import('@/components/widget-host/widget-self');
  if (!keepRead) (await import('./pull-requests-model')).forgetPullListsForTests();
  // A tab of the stack shows the stack's project, picked once.
  if (self) (await import('./git-stack-project')).pickStackProject('acme');
  const root = createRoot(document.getElementById('root')!);
  const counts: Array<number | null> = [];
  const paint = (current: Self | undefined) => {
    const widget = React.createElement(PullRequestsWidget, { handle: null });
    return current ? React.createElement(WidgetSelfProvider, { value: {
      id: 'pull-requests', ...current, publishCount: (_id: string, n: number | null) => { counts.push(n); },
      publishMenu: () => {}, publishAttention: () => {},
    } }, widget) : widget;
  };
  await React.act(async () => { root.render(paint(self)); });
  const repaint = async (next: Self) => { await React.act(async () => { root.render(paint(next)); }); };
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const choose = async (select: HTMLSelectElement | null, value: string) => {
    assert.ok(select);
    await React.act(async () => {
      select.value = value;
      select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
    });
    await settle();
  };
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  // Radix tabs switch on a mouse down, not on a click.
  const pressTab = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => {
      (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    });
    await settle();
  };
  const key = async (el: Element | null, k: string) => {
    assert.ok(el);
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true })); });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { calls, copied, counts, opened, repaint, choose, click, key, pressTab, settle, unmount };
}

test('the widget lists a project\'s pull requests, filters by author, and shows the brief and the diff without starting anything', async () => {
  const m = await mount([
    pull({ review: review({ verdict: 'changes_requested' }) }),
    pull({ number: 13, title: 'Tidy the docs', author: 'ai-bot', external: false, isDraft: true }),
  ]);
  try {
    assert.match(document.body.textContent ?? '', /Choose a project/);
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');

    const rows = () => Array.from(document.querySelectorAll('[data-pull-row]')).map((r) => r.getAttribute('data-pull-row'));
    assert.deepEqual(rows(), ['12', '13']);
    const first = document.querySelector('[data-pull-row="12"]')!;
    assert.match(first.textContent ?? '', /Add a dark theme/);
    assert.equal(first.querySelector('[data-pull-verdict]')?.textContent, 'Changes requested');
    assert.match(document.querySelector('[data-pull-row="13"]')?.textContent ?? '', /draft/);

    await m.choose(document.querySelector('[data-pull-author-filter]'), 'ai-bot');
    assert.deepEqual(rows(), ['13']);
    await m.choose(document.querySelector('[data-pull-author-filter]'), '');
    assert.deepEqual(rows(), ['12', '13']);

    // The loupe names what it does: it writes a brief, it starts nothing.
    const button = document.querySelector('[data-pull-row="12"] [data-pull-review]');
    assert.equal(button?.getAttribute('aria-label'), 'Review brief');
    assert.equal(button?.getAttribute('title'), 'Review brief');
    await m.click(button);
    assert.ok(m.calls.some((c) => c.method === 'POST' && c.url === '/api/ui/projects/acme/pull-requests/12/review'));
    assert.ok(m.calls.some((c) => c.method === 'GET' && c.url === '/api/ui/projects/acme/pull-requests/12/diff'));
    assert.match(document.querySelector('[data-pull-brief]')?.textContent ?? '', /untrusted-data/);
    assert.equal(document.querySelector('[data-pull-brief-description]')?.textContent, 'A brief to paste into a review mission: nothing is started.');
    assert.ok(!document.querySelector('[data-pull-send]'), 'no send button');
    assert.ok(!Array.from(document.querySelectorAll('button')).some((b) => /^Send/.test(b.textContent ?? '')));

    await m.click(document.querySelector('[data-pull-copy]'));
    assert.deepEqual(m.copied, ['Review pull request #12 of acme/widgets…\n<untrusted-data>\n{}\n</untrusted-data>']);

    await m.pressTab(document.querySelector('[data-pull-diff-tab]'));
    const diff = document.querySelector('[data-pull-diff]');
    assert.ok(diff, 'the diff tab shows the diff');
    assert.match(diff.textContent ?? '', /\+new/);

    // Only reads and the preparation: nothing that could start a mission.
    assert.deepEqual(
      m.calls.filter((c) => c.method !== 'GET').map((c) => c.url),
      ['/api/ui/projects/acme/pull-requests/12/review'],
    );

    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close') ?? null);
    assert.ok(!document.querySelector('[data-pull-brief]'), 'the dialog closes');
  } finally {
    await m.unmount();
  }
});

test('in the Git stack, a hidden PR tab reads the pull requests only when its count is over a minute old', async () => {
  const reads = (calls: Call[]) => calls.filter((c) => c.url === '/api/ui/projects/acme/pull-requests').length;
  const list = [pull({ number: 12, author: 'alice' }), pull({ number: 13, author: 'bob' })];
  // Hidden, nothing read on the page yet: one read, for the count.
  const first = await mount(list, { tabbed: true, selected: false });
  try {
    assert.equal(reads(first.calls), 1);
    assert.equal(first.counts.at(-1), 2, 'the count for the tab');
  } finally { await first.unmount(); }

  // Mounted again behind another tab within the minute: no call to gh.
  const again = await mount(list, { tabbed: true, selected: false }, true);
  try {
    assert.equal(reads(again.calls), 0, 'the list read a moment ago is enough');
    assert.equal(again.counts.at(-1), 2, 'and its count stays on the tab');
    // Its tab comes forward: the list is read again.
    await again.repaint({ tabbed: true, selected: true });
    await again.settle();
    assert.equal(reads(again.calls), 1);
  } finally { await again.unmount(); }

  // In front, it reads at once, whatever it read before.
  const front = await mount(list, { tabbed: true, selected: true }, true);
  try {
    assert.equal(reads(front.calls), 1);
  } finally { await front.unmount(); }

  const { shouldReadPulls } = await import('./pull-requests-model');
  assert.equal(shouldReadPulls(false, 1_000, 60_999), false);
  assert.equal(shouldReadPulls(false, 1_000, 61_000), true, 'a minute later, a hidden tab reads again');
  assert.equal(shouldReadPulls(false, null, 1_000), true);
});

test('a click on a row opens its page in a window, at the mouse and at the keyboard; its buttons keep their own click', async () => {
  const m = await mount([pull({ review: review({ verdict: 'changes_requested' }) }), pull({ number: 13, title: 'Tidy the docs' })]);
  const pageReads = () => m.calls.filter((c) => /\/pull-requests\/12(\?|$)/.test(c.url)).length;
  const dialog = () => document.querySelector('[data-pull-dialog]');
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');

    // The loupe and the menu do not open the window.
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-review]'));
    assert.equal(dialog(), null);
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close') ?? null);
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-menu]'));
    assert.equal(dialog(), null);
    assert.equal(pageReads(), 0);

    // The keyboard: the row's main zone is a button that takes Enter and Space.
    const zone = document.querySelector('[data-pull-row="12"] [data-pull-open]')!;
    assert.equal(zone.getAttribute('role'), 'button');
    assert.equal(zone.getAttribute('tabindex'), '0');
    await m.key(zone, 'Enter');
    assert.equal(dialog()?.getAttribute('data-pull-dialog'), '12');
    assert.equal(pageReads(), 1);
    assert.ok(m.calls.some((c) => c.url === '/api/ui/projects/acme/pull-requests/12?updated=2026-11-17T10%3A00%3A00Z'));
    await m.key(document.activeElement ?? document.body, 'Escape');

    // The mouse.
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = dialog()!;
    assert.ok(d);
    const text = d.textContent ?? '';
    assert.match(text, /Add a dark theme/);
    assert.match(text, /wants to merge 1 commit into main from stranger:dark-theme/);
    assert.equal(d.querySelector('[data-pull-state]')?.getAttribute('data-pull-state'), 'open');
    assert.equal(d.querySelector('[data-pull-status-card] [data-pull-box-decision]')?.textContent, 'Changes requested');
    assert.equal(d.querySelector('[data-pull-status-card] [data-pull-box-merge]')?.getAttribute('data-pull-box-merge'), 'conflict');

    // Conversation: the description as markdown without raw HTML, the reviews and comments, the threads.
    const markdown = d.querySelector('[data-pull-body] [data-pull-markdown]')!;
    assert.ok(!markdown.querySelector('script'));
    assert.match(markdown.textContent ?? '', /The app hurts at night\./);
    assert.deepEqual(Array.from(markdown.querySelectorAll('a')).map((a) => a.getAttribute('href')), ['https://example.com/spec']);
    assert.deepEqual(Array.from(d.querySelectorAll('[data-pull-timeline]')).map((e) => e.getAttribute('data-pull-timeline')), ['review', 'comment']);
    assert.equal(d.querySelector('[data-pull-review-state]')?.textContent, 'Changes requested');
    assert.match(d.querySelector('[data-pull-more="timeline"]')?.textContent ?? '', /3 earlier entries/);
    assert.ok(d.querySelector('[data-pull-thread-state="open"]'));
    assert.match(d.querySelector('[data-pull-side="reviewers"]')?.textContent ?? '', /reviewer.*acme\/core.*and 2 more/);
    assert.match(d.querySelector('[data-pull-side="issues"]')?.textContent ?? '', /#7/);

    // Commits.
    await m.pressTab(d.querySelector('[data-pull-tab="commits"]'));
    assert.match(d.querySelector(`[data-pull-commit="${'b'.repeat(40)}"]`)?.textContent ?? '', /feat: dark theme.*bbbbbbb/);

    // Checks: failures first, the end of a failed job's log on demand.
    await m.pressTab(d.querySelector('[data-pull-tab="checks"]'));
    assert.deepEqual(Array.from(d.querySelectorAll('[data-pull-check]')).map((e) => e.getAttribute('data-status')), ['fail', 'pass']);
    await m.click(d.querySelector('[data-pull-check="test"] [data-pull-check-log]'));
    assert.match(d.querySelector('[data-pull-check-tail]')?.textContent ?? '', /Error: boom/);

    // Files: the diff read at the first unfolding, the thread under its line.
    // (The loupe clicked above read it once, for the brief's dialog.)
    const diffReads = () => m.calls.filter((c) => c.url.endsWith('/12/diff')).length;
    const before = diffReads();
    await m.pressTab(d.querySelector('[data-pull-tab="files"]'));
    assert.equal(diffReads(), before, 'no diff before a file is unfolded');
    await m.click(d.querySelector('[data-pull-file="x"] button'));
    assert.equal(diffReads(), before + 1);
    assert.match(d.querySelector('[data-pull-file-diff]')?.textContent ?? '', /\+new/);
    assert.match(d.querySelector('[data-pull-inline-thread]')?.textContent ?? '', /Rename this\./);

    // Every link out of the window is https, and opens apart from the app.
    const links = Array.from(document.querySelectorAll('[data-pull-dialog] a[href]'));
    assert.ok(links.length > 0);
    for (const a of links) {
      assert.match(a.getAttribute('href') ?? '', /^https:\/\//, a.outerHTML);
      assert.equal(a.getAttribute('target'), '_blank');
      assert.match(a.getAttribute('rel') ?? '', /noopener/);
    }

    // Reads only: the window posts nothing.
    assert.deepEqual(m.calls.filter((c) => c.method !== 'GET').map((c) => c.url), ['/api/ui/projects/acme/pull-requests/12/review']);

    // Closed before the page goes: Radix's focus timers must not outlive the test.
    await m.key(document.activeElement ?? document.body, 'Escape');
    assert.equal(dialog(), null);
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('beside the column, the tab bar is a row of its own: the card starts level with the first block of every tab', async () => {
  const m = await mount([conflicted()]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    // jsdom lays nothing out: the rows the grid gives each part stand for the alignment.
    const body = d.querySelector('[data-pull-body-layout="wide"]');
    assert.ok(body, 'a window with no width read counts as wide');
    assert.match(body.className, /grid-rows-\[auto_minmax\(0,1fr\)\]/);
    const bar = d.querySelector('[role="tablist"]');
    assert.ok(bar);
    assert.match(bar.className, /\brow-start-1\b/);
    assert.match(bar.parentElement?.className ?? '', /\bcontents\b/, 'Tabs lays out nothing: its bar and panels are cells of the grid');
    for (const tab of ['conversation', 'commits', 'checks', 'files']) {
      await m.pressTab(d.querySelector(`[data-pull-tab="${tab}"]`));
      const panel = Array.from(d.querySelectorAll('[role="tabpanel"]')).find((p) => !p.hasAttribute('hidden'));
      assert.ok(panel, tab);
      assert.match(panel.className, /\brow-start-2\b/, `${tab}: under the bar`);
    }
    const column = d.querySelector('[data-pull-side-column]');
    assert.ok(column);
    assert.match(column.className, /\brow-start-2\b/, 'the column shares the row of the tab\'s content, not the bar\'s');
    assert.ok(column.firstElementChild?.querySelector('[data-pull-status-card="column"]'), 'the card heads it');

    await m.click(d.querySelector('[data-pull-close]'));
    assert.ok(!document.querySelector('[data-pull-dialog]'), 'the header\'s close button closes the window');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

const conflicted = (extra: Partial<PullRequestItem> = {}) => pull({
  mergeStateStatus: 'dirty', gestures: { update_branch: false, ask_contributor: true, resolve_conflict: true, locked: null }, ...extra,
});

test('the window shows its main gestures in its column without opening "…": the one its state calls for filled, the frequent ones under it', async () => {
  const m = await mount([conflicted()]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    const card = d.querySelector('[data-pull-side-column] [data-pull-status-card="column"]');
    assert.ok(card, 'the status card heads the column beside the tabs');
    const primary = card.querySelector('[data-pull-action-primary]');
    assert.equal(primary?.getAttribute('data-pull-action'), 'resolveConflict');
    assert.equal(primary?.textContent, 'Resolve the conflict…');
    assert.deepEqual(
      Array.from(card.querySelectorAll('[data-pull-action]:not([data-pull-action-primary])')).map((b) => b.getAttribute('data-pull-action')),
      ['askContributor', 'review'],
    );
    assert.equal(d.querySelectorAll('[data-pull-action]').length, 3, 'each gesture shows once');
    assert.ok(!document.querySelector('[data-menu-comment]'), 'no menu was opened to see them');

    // The header keeps its icon buttons only: the title has the width. The
    // window's own close button is the last of them, not a corner apart.
    const tools = Array.from(d.querySelectorAll('[data-pull-header-tools] button, [data-pull-header-tools] a'));
    assert.deepEqual(tools.map((b) => b.getAttribute('aria-label')), ['Read again from GitHub', 'Open on GitHub', 'More actions', 'Close']);
    assert.equal(d.querySelectorAll('button[aria-label="Close"]').length, 1, 'no second close button in the corner');
    for (const b of tools) assert.equal(b.textContent, '', `${b.getAttribute('aria-label')} has no visible label`);
    assert.equal(d.querySelector('[data-pull-title]')?.getAttribute('title'), 'Add a dark theme');

    // The rest, and the job's links, sit in "…".
    await m.key(d.querySelector('[data-pull-dialog-menu]'), 'Enter');
    assert.ok(document.querySelector('[data-menu-comment]'));
    assert.ok(document.querySelector('[data-menu-forge]'));
    assert.ok(!document.querySelector('[data-menu-resolve-conflict]'), 'a button of the card is not repeated in the menu');
    assert.ok(!document.querySelector('[data-menu-ask-contributor]'));
    await m.key(document.activeElement ?? document.body, 'Escape');

    // A gesture the daemon prepares closes the window once ready, onto what it opens.
    await m.click(d.querySelector('[data-pull-action="review"]'));
    assert.ok(m.calls.some((c) => c.method === 'POST' && c.url === '/api/ui/projects/acme/pull-requests/12/review'));
    assert.ok(!document.querySelector('[data-pull-dialog]'));
    assert.ok(document.querySelector('[data-pull-brief]'));
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Close') ?? null);
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('a refused gesture shows greyed with its reason, on hover and to a screen reader', async () => {
  const m = await mount([conflicted({ gestures: { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: 'not_allowed' } })]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    // Nothing this person can do unblocks it: no filled button, the brief first of the outlined ones.
    assert.ok(!d.querySelector('[data-pull-action-primary]'));
    assert.deepEqual(
      Array.from(d.querySelectorAll('[data-pull-box-actions] [data-pull-action]')).map((b) => b.getAttribute('data-pull-action')),
      ['review', 'resolveConflict', 'askContributor'],
    );
    const resolve = d.querySelector('[data-pull-action="resolveConflict"]');
    assert.ok(resolve);
    assert.ok(resolve.hasAttribute('disabled'));
    assert.match(d.querySelector('[data-pull-action-reason="resolveConflict"]')?.getAttribute('title') ?? '', /does not let the maintainers change this branch/);
    const reason = document.getElementById(resolve.getAttribute('aria-describedby') ?? '');
    assert.match(reason?.textContent ?? '', /does not let the maintainers change this branch/);
    assert.equal(d.querySelector('[data-pull-action="askContributor"]')?.hasAttribute('disabled'), false);
    const lock = d.querySelector('[data-pull-status-card] [data-pull-box-lock]');
    assert.equal(lock?.textContent, 'Changes not allowed');
    assert.match(lock?.getAttribute('title') ?? '', /does not let the maintainers change this branch/);
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('a clean pull request\'s window fills no button: the review brief leads the outlined ones', async () => {
  const m = await mount([pull({ mergeStateStatus: 'clean', gestures: { update_branch: false, ask_contributor: false, resolve_conflict: false, locked: null } })]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    assert.ok(!d.querySelector('[data-pull-action-primary]'));
    const buttons = Array.from(d.querySelectorAll('[data-pull-box-actions] [data-pull-action]'));
    assert.deepEqual(buttons.map((b) => b.getAttribute('data-pull-action')), ['review', 'comment']);
    assert.equal(buttons[0]?.textContent, 'Review brief');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('a narrow window moves the card above the tabs, across the window; the header still has no labelled button', async () => {
  const m = await mount([conflicted()], undefined, false, 480);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    assert.equal(d.querySelector('[data-pull-body-layout]')?.getAttribute('data-pull-body-layout'), 'narrow');
    assert.ok(!d.querySelector('[data-pull-side-column]'), 'no column beside the tabs');
    const card = d.querySelector('[data-pull-status-card="across"]');
    assert.ok(card);
    assert.ok(card.compareDocumentPosition(d.querySelector('[data-pull-tab="conversation"]') as Node) & 4, 'the card comes before the tabs');
    assert.deepEqual(
      Array.from(card.querySelectorAll('[data-pull-action]')).map((b) => b.getAttribute('data-pull-action')),
      ['resolveConflict', 'askContributor', 'review'],
    );
    assert.equal(card.querySelector('[data-pull-action-primary]')?.getAttribute('data-pull-action'), 'resolveConflict');
    for (const b of Array.from(d.querySelectorAll('[data-pull-header-tools] button, [data-pull-header-tools] a'))) assert.equal(b.textContent, '');

    // The people and the issues close the conversation.
    const conversation = d.querySelector('[role="tabpanel"]');
    assert.ok(conversation?.querySelector('[data-pull-side="reviewers"]'));

    // "…" keeps the rest, never the card's gestures.
    await m.key(d.querySelector('[data-pull-dialog-menu]'), 'Enter');
    assert.ok(document.querySelector('[data-menu-comment]'));
    assert.ok(!document.querySelector('[data-menu-ask-contributor]'));
    assert.ok(!document.querySelector('[data-menu-review]'));
    await m.key(document.activeElement ?? document.body, 'Escape');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('the column\'s card says the checks, the merge state and the decision over its gestures, with no merge button and no box under the conversation', async () => {
  const m = await mount([conflicted()]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const box = document.querySelector('[data-pull-dialog] [data-pull-status-card]');
    assert.ok(box);
    assert.equal(document.querySelectorAll('[data-pull-dialog] [data-pull-status-card]').length, 1);
    const conversation = document.querySelector('[data-pull-dialog] [role="tabpanel"]');
    assert.ok(conversation);
    assert.ok(conversation.querySelector('[data-pull-body]'));
    assert.ok(!conversation.querySelector('[data-pull-status-card], [data-pull-action]'), 'the conversation ends on its threads');
    const checks = box.querySelector('[data-pull-box-checks]');
    assert.equal(checks?.getAttribute('data-pull-box-checks'), 'failed');
    assert.match(checks?.textContent ?? '', /Some checks failed.*1 passed · 1 failed · 0 running/);
    assert.equal(box.querySelector('[data-pull-box-merge]')?.getAttribute('data-pull-box-merge'), 'conflict');
    assert.match(box.querySelector('[data-pull-box-merge]')?.textContent ?? '', /conflicts with the base branch/);
    assert.equal(box.querySelector('[data-pull-box-decision]')?.textContent, 'Changes requested');
    assert.deepEqual(
      Array.from(box.querySelectorAll('[data-pull-box-actions] [data-pull-action]')).map((b) => b.getAttribute('data-pull-action')),
      ['resolveConflict', 'askContributor', 'review'],
    );
    assert.ok(!Array.from(box.querySelectorAll('button')).some((b) => /merge/i.test(b.textContent ?? '')), 'a person merges on GitHub');

    // Its checks line leads to the Checks tab.
    assert.ok(!document.querySelector('[data-pull-dialog] [data-pull-check]'));
    await m.click(checks);
    assert.ok(document.querySelector('[data-pull-dialog] [data-pull-check="test"]'));
    assert.ok(document.querySelector('[data-pull-dialog] [data-pull-status-card] [data-pull-action-primary]'), 'the card stays on every tab');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('the column lists only the fields a pull request has, and no block when it has none', async () => {
  const bare = {
    ...PAGE, labels: [], milestone: null, assignees: [], assigneesMore: 0, reviewRequests: [], reviewRequestsMore: 0, closingIssues: [],
  };
  const m = await mount([pull()], undefined, false, undefined, bare);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const column = document.querySelector('[data-pull-dialog] [data-pull-side-column]');
    assert.ok(column);
    assert.ok(column.querySelector('[data-pull-status-card]'));
    assert.equal(column.querySelectorAll('[data-pull-side]').length, 0);
    assert.equal(column.querySelectorAll('dl').length, 0, 'no empty block under the card');
    assert.doesNotMatch(column.textContent ?? '', /None/);
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }

  const some = await mount([pull()], undefined, false, undefined, { ...bare, labels: [{ name: 'ui', color: 'a2eeef' }] });
  try {
    await some.choose(document.querySelector('[data-stack-project]'), 'acme');
    await some.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    assert.deepEqual(
      Array.from(document.querySelectorAll('[data-pull-dialog] [data-pull-side]')).map((e) => e.getAttribute('data-pull-side')),
      ['labels'],
    );
    await some.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await some.unmount();
  }
});

test('while GitHub\'s page is read, the card is there with its gestures and says so', async () => {
  let answer: (res: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => { answer = resolve; });
  const m = await mount([conflicted()], undefined, false, undefined, () => pending);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    const card = d.querySelector('[data-pull-side-column] [data-pull-status-card="column"]');
    assert.ok(card, 'the card does not wait for the page');
    assert.match(card.querySelector('[data-pull-box-reading]')?.textContent ?? '', /Reading the pull request on GitHub/);
    assert.ok(!card.querySelector('[data-pull-box-checks]'), 'no checks line before the page');
    assert.equal(card.querySelector('[data-pull-action-primary]')?.getAttribute('data-pull-action'), 'resolveConflict');
    assert.deepEqual(
      Array.from(card.querySelectorAll('[data-pull-action]')).map((b) => b.getAttribute('data-pull-action')),
      ['resolveConflict', 'askContributor', 'review'],
    );
    assert.ok(!d.querySelector('[data-pull-tab]'), 'no tabs before the page');

    // The page arrives: the card says what it says, the same gestures under it.
    await m.settle();
    answer(Response.json({ pull: PAGE, cached: false }));
    await m.settle();
    const read = d.querySelector('[data-pull-status-card]');
    assert.equal(read?.querySelector('[data-pull-box-checks]')?.getAttribute('data-pull-box-checks'), 'failed');
    assert.ok(!read?.querySelector('[data-pull-box-reading]'));
    assert.equal(read?.querySelector('[data-pull-action-primary]')?.getAttribute('data-pull-action'), 'resolveConflict');
    assert.ok(d.querySelector('[data-pull-tab="conversation"]'));
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    answer(Response.json({ pull: PAGE, cached: false }));
    await m.unmount();
  }
});

test('when GitHub\'s page cannot be read, the card keeps every gesture, says why and reads again on demand', async () => {
  let fail = true;
  const m = await mount([conflicted()], undefined, false, 480, async () => (
    fail ? Response.json({ error: 'gh_failed' }, { status: 502 }) : Response.json({ pull: PAGE, cached: false })
  ));
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    const card = d.querySelector('[data-pull-status-card="across"]');
    assert.ok(card, 'a narrow window shows the card across, page or not');
    const error = card.querySelector('[data-pull-box-error]');
    assert.ok(error);
    assert.notEqual((error.textContent ?? '').trim(), '');
    assert.equal(card.querySelector('[data-pull-action-primary]')?.getAttribute('data-pull-action'), 'resolveConflict');
    assert.equal(card.querySelectorAll('[data-pull-action]').length, 3);

    // "…" keeps the rest, as with a page.
    await m.key(d.querySelector('[data-pull-dialog-menu]'), 'Enter');
    assert.ok(document.querySelector('[data-menu-comment]'));
    assert.ok(!document.querySelector('[data-menu-resolve-conflict]'));
    await m.key(document.activeElement ?? document.body, 'Escape');

    // Read again: the page comes, the error goes.
    fail = false;
    await m.click(card.querySelector('[data-pull-retry]'));
    assert.ok(!d.querySelector('[data-pull-box-error]'));
    assert.equal(d.querySelector('[data-pull-status-card] [data-pull-box-merge]')?.getAttribute('data-pull-box-merge'), 'conflict');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});

test('the line under the title says what the pull request is; where it stands is said once, in the card', async () => {
  const m = await mount([conflicted({
    gestures: { update_branch: false, ask_contributor: true, resolve_conflict: false, locked: 'not_allowed' },
    review: review({ verdict: 'changes_requested' }),
  })]);
  try {
    await m.choose(document.querySelector('[data-stack-project]'), 'acme');
    await m.click(document.querySelector('[data-pull-row="12"] [data-pull-open]'));
    const d = document.querySelector('[data-pull-dialog]');
    assert.ok(d);
    const header = d.querySelector('[data-pull-header]');
    assert.ok(header);
    assert.equal(header.querySelector('[data-pull-state]')?.textContent, 'Open');
    assert.match(header.textContent ?? '', /stranger/);
    assert.match(header.textContent ?? '', /wants to merge 1 commit into main from stranger:dark-theme/);
    assert.match(header.textContent ?? '', /opened/);
    assert.ok(!header.querySelector('[data-pull-locked], [data-pull-branch], [data-pull-decision], [data-pull-mergeable]'));
    assert.doesNotMatch(header.textContent ?? '', /Changes not allowed|conflict|Changes requested|Timon:/i);

    const card = d.querySelector('[data-pull-status-card]');
    assert.ok(card);
    assert.equal(card.querySelector('[data-pull-box-lock]')?.textContent, 'Changes not allowed');
    assert.equal(card.querySelector('[data-pull-box-merge]')?.getAttribute('data-pull-box-merge'), 'conflict');
    assert.equal(card.querySelector('[data-pull-box-decision]')?.textContent, 'Changes requested');
    assert.equal(card.querySelector('[data-pull-box-verdict]')?.textContent, 'Timon: Changes requested');
    await m.key(document.activeElement ?? document.body, 'Escape');
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    await m.unmount();
  }
});
