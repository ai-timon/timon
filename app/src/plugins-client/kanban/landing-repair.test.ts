import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landing, LandingRepair, LandingRepairs, RepairKind } from './landing-api';

/**
 * Repairing our jobs from the Jobs widget and the job's window: the row's main
 * icon is the repair the forge calls for, a click (and only a click) asks the
 * daemon for it, the counter follows, and once the repairs are spent the
 * window hands the pull request over to a person.
 */

const repairs = (over: Partial<LandingRepairs> = {}): LandingRepairs => ({ used: 0, max: 3, running: null, last: null, needs: [], ...over });

const base: Landing = {
  id: 'job', project: 'acme', series_id: 's1', branch: 'feat/csv', remote: 'origin', target: 'main',
  mode: 'pr', state: 'open', pr_number: 51, pr_url: 'https://github.com/acme/app/pull/51', head_sha: 'a'.repeat(40),
  merge_sha: null, landed: false, created_at: 1, updated_at: 10, conflict: false, checks_running: false,
  pr_title: 'Add CSV export',
  checks: {
    read_at: 1, draft: false, mergeable: 'mergeable', review: null,
    counts: { pass: 2, fail: 1, pending: 0, skipped: 0 },
    items: [
      { name: 'ubuntu-latest · daemon 1/2', status: 'pass', url: null },
      { name: 'ubuntu-latest · app', status: 'fail', url: 'https://github.com/acme/app/actions/runs/1/job/2' },
      { name: 'public docs policy', status: 'pass', url: null },
    ],
  },
  repairs: repairs({ needs: ['checks'] }),
};

const running = (kind: RepairKind, used: number): LandingRepair => ({
  id: `r${used}`, kind, state: 'running', task_id: `t${used}`, head_after: null, error: null, created_at: 20, updated_at: 20,
});

type Ctx = {
  React: typeof import('react');
  calls: string[];
  bodies: unknown[];
  dom: import('jsdom').JSDOM;
  settle: () => Promise<void>;
  click: (el: Element | null) => Promise<void>;
};

async function show(jobs: Landing[], run: (ctx: Ctx) => Promise<void>, refuse = false) {
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
  const state = new Map(jobs.map((j) => [j.id, j]));
  const calls: string[] = [];
  const bodies: unknown[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const repair = /\/landings\/([^/]+)\/repairs$/.exec(url);
    if (repair) {
      const body = JSON.parse(String(init?.body)) as { kind: RepairKind };
      bodies.push(body);
      const job = state.get(decodeURIComponent(repair[1]!))!;
      const r = job.repairs!;
      if (refuse || r.used >= r.max) {
        return Response.json({ error: { code: 'landing_repair_cap', message: 'the job used its 3 repairs' } }, { status: 409 });
      }
      const fresh: Landing = { ...job, repairs: { ...r, used: r.used + 1, running: running(body.kind, r.used + 1), last: running(body.kind, r.used + 1) } };
      state.set(job.id, fresh);
      return Response.json({ repair: fresh.repairs!.running, task_id: 't', landing: fresh }, { status: 201 });
    }
    const checks = /\/landings\/([^/]+)\/checks$/.exec(url);
    if (checks) return Response.json({ landing: state.get(decodeURIComponent(checks[1]!)), fresh: true });
    if (url.endsWith('/preview')) return Response.json({ error: { code: 'internal', message: 'no preview here' } }, { status: 500 });
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [...state.values()] });
    return Response.json({});
  });
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
    await React.act(async () => {
      root.render(React.createElement(LandingWidget, { handle: null }));
    });
    await settle();
    await run({ React, calls, bodies, dom, settle, click });
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

const row = (id: string) => document.querySelector<HTMLElement>(`[data-landing="${id}"]`);
const posts = (calls: string[]) => calls.filter((c) => c.includes('/repairs'));

test('the main action, the menu and the counter follow what the forge calls for', async () => {
  const { canRepair, landingAction, mainRepair, repairsNeeded, repairsSpent } = await import('./landing-api');
  assert.equal(mainRepair(base), 'checks');
  assert.equal(landingAction(base), 'repair');
  const both: Landing = { ...base, repairs: repairs({ needs: ['comments', 'checks', 'conflict'] }) };
  assert.deepEqual(repairsNeeded(both), ['conflict', 'checks', 'comments'], 'a conflict first: the checks do not run on it');
  assert.equal(mainRepair(both), 'conflict');

  const busy: Landing = { ...base, repairs: repairs({ needs: ['checks'], used: 1, running: running('checks', 1) }) };
  assert.equal(canRepair(busy), false, 'one at a time');
  assert.equal(landingAction(busy), 'preview');
  const spent: Landing = { ...base, repairs: repairs({ needs: ['checks'], used: 3 }) };
  assert.equal(mainRepair(spent), null);
  assert.equal(repairsSpent(spent), true);
  assert.equal(repairsSpent({ ...spent, repairs: repairs({ used: 3 }) }), false, 'nothing left to fix: not a hand-over');
  assert.equal(mainRepair({ ...base, state: 'merged' }), null);
  assert.equal(mainRepair({ ...base, repairs: undefined }), null, 'an older daemon: no repair offered');
  assert.equal(landingAction({ ...base, repairs: repairs() }), 'preview');
});

test('a click on the row asks for the repair, then the row says it runs', async () => {
  const job: Landing = { ...base, conflict: true, repairs: repairs({ needs: ['checks', 'conflict'] }) };
  await show([job], async ({ React, dom, calls, bodies, settle, click }) => {
    const action = row('job')!.querySelector('[data-landing-action]');
    assert.equal(action?.getAttribute('data-landing-action'), 'repair');
    assert.equal(action?.getAttribute('data-repair-kind'), 'conflict');
    assert.equal(action?.getAttribute('aria-label'), 'Resolve the conflict');
    assert.equal(action?.textContent, '', 'an icon, never a label in the row');
    assert.equal(posts(calls).length, 0, 'nothing starts before a click');

    // The other repair waits in "…".
    const trigger = row('job')!.querySelector('button[aria-haspopup="menu"]');
    assert.ok(trigger);
    await React.act(async () => { trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await settle();
    const other = document.querySelector('[data-repair-menu]');
    assert.equal(other?.getAttribute('data-repair-menu'), 'checks');
    assert.match(other!.textContent!, /Fix the checks/);
    assert.ok(!other!.hasAttribute('data-disabled'));
    await React.act(async () => { document.activeElement?.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await settle();

    await click(action);
    assert.deepEqual(posts(calls), ['POST /api/ui/kanban/landings/job/repairs']);
    assert.deepEqual(bodies, [{ kind: 'conflict' }]);

    const chip = row('job')!.querySelector('[data-repair-chip]');
    assert.equal(chip?.getAttribute('data-repair-chip'), 'running');
    assert.match(chip!.textContent!, /Repair 1\/3/);
    assert.match(chip!.getAttribute('title')!, /Resolve the conflict: repair 1 of 3 under way/);
    assert.equal(row('job')!.querySelector('[data-landing-action]')?.getAttribute('data-landing-action'), 'preview', 'one at a time');
  });
});

test('the window shows the checks, the counter, and repairs from its foot', async () => {
  await showDialog(base, async ({ calls, bodies, click }) => {
    const checks = document.querySelector('[data-job-checks]');
    assert.ok(checks);
    const statuses = Array.from(checks.querySelectorAll('[data-check-status]')).map((c) => c.getAttribute('data-check-status'));
    assert.deepEqual(statuses, ['fail', 'pass', 'pass'], 'the failure first');
    assert.match(document.querySelector('[data-repair-counter]')!.textContent!, /Automatic repairs\s*0 \/ 3/);

    const repair = document.querySelector('[data-job-repair]');
    assert.equal(repair?.getAttribute('data-job-repair'), 'checks');
    assert.match(repair!.textContent!, /Fix the checks/);
    assert.equal(repair!.getAttribute('title'), "Runs the job's agent with the failing checks as data");

    await click(repair);
    assert.deepEqual(posts(calls), ['POST /api/ui/kanban/landings/job/repairs']);
    assert.deepEqual(bodies, [{ kind: 'checks' }]);
    assert.match(document.querySelector('[data-repair-counter]')!.textContent!, /1 \/ 3/);
    assert.match(document.querySelector('[data-repair-running]')!.textContent!, /Under way: Fix the checks/);
    assert.ok(!document.querySelector('[data-job-repair]'), 'no second repair while one runs');

    await click(document.querySelector('[data-job-refresh]'));
    assert.ok(calls.includes('POST /api/ui/kanban/landings/job/checks'));
  });
});

test('spent repairs hand the pull request over; a refusal changes nothing', async () => {
  const spent: Landing = { ...base, repairs: repairs({ needs: ['checks'], used: 3, last: { ...running('checks', 3), state: 'failed', error: 'the push was refused 3 times' } }) };
  await show([spent], async ({ calls }) => {
    assert.equal(row('job')!.querySelector('[data-landing-action]')?.getAttribute('data-landing-action'), 'preview');
    const chip = row('job')!.querySelector('[data-repair-chip]');
    assert.equal(chip?.getAttribute('data-repair-chip'), 'spent');
    assert.match(chip!.textContent!, /Repairs 3\/3/);
    assert.equal(posts(calls).length, 0);
  });

  await showDialog(spent, async ({ calls }) => {
    assert.ok(!document.querySelector('[data-job-repair]'));
    const takeOver = document.querySelector<HTMLAnchorElement>('[data-job-take-over]');
    assert.ok(takeOver);
    assert.equal(takeOver.getAttribute('href'), spent.pr_url);
    assert.equal(takeOver.getAttribute('rel'), 'noopener noreferrer');
    assert.match(takeOver.textContent!, /Take over by hand/);
    assert.match(document.querySelector('[data-job-checks]')!.textContent!, /Last repair not pushed · the push was refused 3 times/);
    assert.equal(posts(calls).length, 0);
  });

  await showDialog(base, async ({ calls, click }) => {
    await click(document.querySelector('[data-job-repair]'));
    assert.equal(posts(calls).length, 1);
    assert.match(document.querySelector('[data-repair-counter]')!.textContent!, /0 \/ 3/, 'refused: the counter does not move');
    assert.ok(document.querySelector('[data-job-repair]'));
  }, true);
});

/** The window alone, as the Pull requests widget or a TO DO's badge opens it. */
async function showDialog(job: Landing, run: (ctx: Ctx) => Promise<void>, refuse = false) {
  await show([job], async (ctx) => {
    const { JobDialog } = await import('./job-dialog');
    const host = document.createElement('div');
    document.body.append(host);
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(host);
    await ctx.React.act(async () => {
      root.render(ctx.React.createElement(JobDialog, { landing: job, onClose: () => {} }));
    });
    await ctx.settle();
    try {
      await run(ctx);
    } finally {
      await ctx.React.act(async () => { root.unmount(); });
    }
  }, refuse);
}
