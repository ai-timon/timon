import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landing, LandingPreview } from './landing-api';

/**
 * Landing a job the planner kept on its branch, from the Jobs widget: the row
 * says it is kept, how many ideas wait and when the branch last took a merge;
 * its one icon merges the branch into the local target after a short
 * confirmation with the number of commits (or, in a pull request project,
 * opens the job's window where the pull request gets its title). The
 * daemon's refusals are said in the person's words, and the gesture is greyed
 * without `projects:manage` or while a task of the job still runs.
 */

const kept: Landing = {
  id: 'job-kept', project: 'acme', series_id: 's1', branch: 'feat/keep-export', remote: '', target: 'main',
  mode: 'branch', state: 'branch', pr_number: null, pr_url: null, head_sha: null, merge_sha: null, landed: false,
  created_at: 1, updated_at: 5, checks: null, conflict: null, checks_running: false, pr_title: null,
  finish: 'keep', kept: true, under_way: 0, last_merge: { sha: 'd'.repeat(40), at: Date.now() - 2 * 60 * 60 * 1000 },
  links: {
    todos: [
      { id: 7, text: 'Export the history as CSV', status: 'promoted', progress: 'partial', project: 'acme' },
      { id: 8, text: 'Name the export file', status: 'promoted', progress: 'partial', project: 'acme' },
      { id: 9, text: 'Old idea', status: 'done', progress: null, project: 'acme' },
    ],
    issues: [], series_id: 's1', pilot_mission_id: null,
  },
};

const keptPr: Landing = { ...kept, id: 'job-pr', branch: 'feat/add-csv-export', remote: 'origin', mode: 'pr', links: undefined };

const preview = (job: Landing, commits: number): LandingPreview => ({
  integration: job, head_sha: 'b'.repeat(40), target_sha: 'a'.repeat(40), problem: null, commit_count: commits,
  commits: [], commits_truncated: false, files: [], files_truncated: false, patch_truncated: false,
  totals: { files: 0, additions: 0, deletions: 0 }, conflict: { state: 'clean', files: [] }, pull_request: null,
  prechecks: { ran: false, reason: 'not asked' },
});

type LandAnswer = { status: number; body: unknown };
type Options = {
  jobs: Landing[];
  manage?: boolean;
  land?: (id: string, body: unknown) => LandAnswer | Promise<LandAnswer>;
  confirm?: boolean;
};
type Ctx = {
  React: typeof import('react');
  calls: string[];
  bodies: unknown[];
  asked: Array<{ title: string; description?: string; confirmLabel?: string }>;
  toasts: () => Array<{ type: string; title: string; description: string }>;
  settle: () => Promise<void>;
  click: (el: Element | null) => Promise<void>;
};

async function show(opts: Options, run: (ctx: Ctx) => Promise<void>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of [
    'window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLButtonElement',
    'SVGElement', 'Element', 'Node', 'NodeFilter', 'DocumentFragment', 'MutationObserver',
    'CustomEvent', 'Event', 'KeyboardEvent', 'PointerEvent', 'MouseEvent', 'FocusEvent', 'getComputedStyle',
    'requestAnimationFrame', 'cancelAnimationFrame', 'localStorage',
  ] as const) install(key, key === 'self' ? dom.window : (dom.window as unknown as Record<string, unknown>)[key]);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const state = new Map(opts.jobs.map((j) => [j.id, j]));
  const calls: string[] = [];
  const bodies: unknown[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/ui/auth/me') {
      return Response.json({ user: { id: 'u1', email: 'a@b.c' }, can: { 'projects:manage': opts.manage !== false }, prefs: {} });
    }
    const land = /\/landings\/([^/]+)\/land$/.exec(url);
    if (land) {
      const body: unknown = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      const out = await opts.land!(decodeURIComponent(land[1]!), body);
      const job = (out.body as { landing?: Landing }).landing;
      if (job) state.set(job.id, job);
      return Response.json(out.body, { status: out.status });
    }
    const pre = /\/landings\/([^/]+)\/preview$/.exec(url);
    if (pre) return Response.json(preview(state.get(decodeURIComponent(pre[1]!))!, 3));
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [...state.values()] });
    return Response.json({});
  });
  const { answerConfirmsForTests } = await import('@/components/confirm-dialog/confirm-dialog-context');
  const asked: Ctx['asked'] = [];
  answerConfirmsForTests((request) => { asked.push(request); return opts.confirm !== false; });
  const { createRequire } = await import('node:module');
  // The widget loads sonner through `require` under the test runner: take the same instance.
  const { toast } = createRequire(`${process.cwd()}/package.json`)('sonner') as typeof import('sonner');
  const before = toast.getHistory().length;
  const toasts = () => toast.getHistory().slice(before).map((item) => ({
    type: 'type' in item ? String(item.type) : '',
    title: 'title' in item ? String(item.title) : '',
    description: 'description' in item ? String(item.description ?? '') : '',
  }));
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe().catch(() => undefined);
  const { createRoot } = await import('react-dom/client');
  const { LandingWidget } = await import('./landing-widget');
  const root = createRoot(document.getElementById('root')!);
  const settle = async () => { await React.act(async () => { await new Promise<void>((r) => setTimeout(r, 30)); }); };
  const click = async (el: Element | null) => {
    assert.ok(el, 'the element is rendered');
    await React.act(async () => { (el as HTMLElement).click(); });
    await settle();
  };
  try {
    await React.act(async () => { root.render(React.createElement(LandingWidget, { handle: null })); });
    await settle();
    await run({ React, calls, bodies, asked, toasts, settle, click });
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise<void>((r) => setTimeout(r, 20));
    answerConfirmsForTests(null);
    const globals = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
}

const row = (id: string) => document.querySelector<HTMLElement>(`[data-landing="${id}"]`);
const landButton = (id: string) => row(id)?.querySelector<HTMLButtonElement>('[data-landing-action="land"]') ?? null;
const lands = (calls: string[]) => calls.filter((c) => c.endsWith('/land'));
const merged = (job: Landing): Landing => ({ ...job, state: 'merged', landed: true, kept: false, merge_sha: 'e'.repeat(40), updated_at: Date.now() });

test('a kept job: its own group, its idea as title, the ideas that wait and its last merge', async () => {
  await show({ jobs: [kept] }, async () => {
    const groups = Array.from(document.querySelectorAll('[data-landing-group]')).map((g) => g.getAttribute('data-landing-group'));
    assert.deepEqual(groups, ['kept']);
    assert.match(document.querySelector('[data-landing-group="kept"]')!.textContent!, /Kept on a branch\s*1/);
    const r = row('job-kept')!;
    assert.match(r.textContent!, /Export the history as CSV/, 'the first idea names the job');
    assert.equal(r.querySelector('[data-landing-kept]')?.textContent, 'Kept on feat/keep-export');
    assert.equal(r.querySelector('[data-landing-waiting]')?.getAttribute('data-landing-waiting'), '2', 'the idea already done does not wait');
    assert.equal(r.querySelector('[data-landing-waiting]')?.getAttribute('title'), '2 TO DOs wait for the landing');
    assert.match(r.querySelector('[data-landing-last-merge]')?.getAttribute('title') ?? '', /^Last merge into feat\/keep-export: ddddddd, /);
    // One icon, no label: the row's width is the job's.
    const button = landButton('job-kept');
    assert.ok(button);
    assert.equal(button.getAttribute('aria-label'), 'Merge into main');
    assert.equal(button.textContent, '');
    assert.equal(button.disabled, false);
  });
});

test('without an idea, the branch is the title and the state is not said twice', async () => {
  await show({ jobs: [{ ...kept, links: undefined }] }, async () => {
    const r = row('job-kept')!;
    assert.match(r.textContent!, /feat\/keep-export/);
    assert.equal(r.querySelector('[data-landing-kept]')?.textContent, 'Kept');
    assert.ok(!r.querySelector('[data-landing-waiting]'));
  });
});

test('merge: a confirmation with the commits, a spinner during the call, the row lands', async () => {
  let release: () => void = () => undefined;
  const answered = new Promise<void>((r) => { release = r; });
  await show({
    jobs: [kept],
    land: async (id) => { await answered; return { status: 200, body: { ok: true, outcome: 'merged', already: false, move: 'fast_forward', landing: merged(kept), merge_sha: 'e'.repeat(40) } }; },
  }, async ({ React, calls, bodies, asked, toasts, settle, click }) => {
    await click(landButton('job-kept'));
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job-kept/preview'), 'the commits are counted first');
    assert.deepEqual(asked, [{ title: 'Merge feat/keep-export into main?', description: '3 commits land in main.', confirmLabel: 'Merge into main' }]);
    // The call is under way: the icon turns and the button waits.
    assert.equal(landButton('job-kept')?.getAttribute('aria-busy'), 'true');
    assert.equal(landButton('job-kept')?.disabled, true);
    await React.act(async () => { release(); });
    await settle();
    assert.deepEqual(lands(calls), ['POST /api/ui/kanban/landings/job-kept/land']);
    assert.deepEqual(bodies, [{}], 'a local merge sends nothing');
    assert.deepEqual(toasts().map((t) => [t.type, t.title]), [['success', 'feat/keep-export merged into main']]);
    assert.ok(!landButton('job-kept'), 'landed: no gesture left');
    assert.equal(document.querySelector('[data-landing-group="landed"]')?.textContent?.includes('Landed'), true);
  });
});

test('a "no" to the confirmation lands nothing', async () => {
  await show({ jobs: [kept], confirm: false, land: () => { throw new Error('not called'); } }, async ({ calls, asked, click }) => {
    await click(landButton('job-kept'));
    assert.equal(asked.length, 1);
    assert.deepEqual(lands(calls), []);
    assert.equal(landButton('job-kept')?.disabled, false);
  });
});

test('a conflict is refused with its files, in the person\'s words', async () => {
  const reason = 'the branch conflicts with the target on src/a.ts, src/b.ts: resolve it on the branch, then land again';
  await show({
    jobs: [kept],
    land: () => ({ status: 409, body: { error: reason, code: 'landing_conflict', params: { detail: reason }, files: ['src/a.ts', 'src/b.ts'] } }),
  }, async ({ toasts, click }) => {
    await click(landButton('job-kept'));
    assert.deepEqual(toasts().map((t) => [t.type, t.title, t.description]), [[
      'error', 'Not merged',
      'The branch conflicts with main on src/a.ts, src/b.ts: resolve it on the branch, then land again. Nothing was merged.',
    ]]);
    assert.ok(row('job-kept')?.querySelector('[data-landing-kept]'), 'still kept');
  });
});

test('a target checked out with changes, and a missing right, are said too', async () => {
  const dirty = 'main is checked out in a working directory with uncommitted changes';
  const answers: LandAnswer[] = [
    { status: 409, body: { error: dirty, code: 'landing_target_dirty', params: { detail: dirty } } },
    { status: 403, body: { error: 'forbidden', code: 'account_lacks_permission', permission: 'projects:manage' } },
  ];
  await show({ jobs: [kept], land: () => answers.shift()! }, async ({ toasts, click }) => {
    await click(landButton('job-kept'));
    await click(landButton('job-kept'));
    const [first, second] = toasts();
    assert.match(first!.description, /^The target branch is checked out with uncommitted changes or untracked files/);
    assert.match(second!.description, /projects:manage|manage projects/i);
  });
});

test('without projects:manage the gesture is greyed, the reason in its tooltip', async () => {
  await show({ jobs: [kept], manage: false, land: () => { throw new Error('not called'); } }, async ({ calls, click }) => {
    const button = landButton('job-kept');
    assert.equal(button?.disabled, true);
    const reason = row('job-kept')?.querySelector('[data-landing-land-reason]')?.getAttribute('title') ?? '';
    assert.match(reason, /projects|manage/i);
    await click(button);
    assert.deepEqual(lands(calls), []);
  });
});

test('while a task of the job still runs the gesture waits, and says why', async () => {
  await show({ jobs: [{ ...kept, under_way: 2 }], land: () => { throw new Error('not called'); } }, async () => {
    assert.equal(landButton('job-kept')?.disabled, true);
    assert.equal(
      row('job-kept')?.querySelector('[data-landing-land-reason]')?.getAttribute('title'),
      '2 tasks of the job are still running: land it once they are done',
    );
  });
});

test('a pull request project: the icon opens the job, where the pull request gets its title', async () => {
  await show({
    jobs: [keptPr],
    land: (_id, body) => ({
      status: 200,
      body: {
        ok: true, outcome: 'pull_request', already: false, pr_url: 'https://github.com/acme/app/pull/77', pr_number: 77,
        landing: { ...keptPr, state: 'open', kept: false, pr_number: 77, pr_url: 'https://github.com/acme/app/pull/77', pr_title: (body as { title: string }).title },
      },
    }),
  }, async ({ React, calls, bodies, asked, toasts, settle, click }) => {
    const button = landButton('job-pr');
    assert.equal(button?.getAttribute('aria-label'), 'Open the PR');
    await click(button);
    assert.deepEqual(lands(calls), [], 'the icon only opens the window');
    const title = document.querySelector<HTMLInputElement>('[data-job-land-title]');
    assert.ok(title);
    assert.equal(title.value, 'Add csv export', 'a first title from the branch');
    // React reads the value through its own setter.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await React.act(async () => {
      setter.call(title, 'Export the mission history as CSV');
      title.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    await settle();
    await click(document.querySelector('[data-job-land]'));
    assert.deepEqual(asked.map((a) => [a.title, a.description]), [['Open the pull request of feat/add-csv-export into main?', '3 commits land in main.']]);
    assert.deepEqual(bodies, [{ title: 'Export the mission history as CSV' }]);
    assert.deepEqual(toasts().map((t) => [t.type, t.title, t.description]), [['success', 'Pull request opened', 'https://github.com/acme/app/pull/77']]);
  });
});

test('the row\'s action and group of a kept job', async () => {
  const { landingAction, landingGroup } = await import('./landing-api');
  assert.equal(landingAction(kept), 'land');
  assert.equal(landingGroup(kept, Date.now()), 'kept');
  assert.equal(landingAction({ ...kept, kept: false }), 'preview', 'a job still in progress is previewed');
  assert.equal(landingGroup({ ...kept, kept: false }, Date.now()), 'progress');
  const { titleFromBranch } = await import('./landing-land');
  assert.equal(titleFromBranch('feat/add-csv_export'), 'Add csv export');
  assert.equal(titleFromBranch('main'), 'Main');
});
