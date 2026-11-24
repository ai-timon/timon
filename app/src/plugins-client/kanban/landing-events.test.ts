import assert from 'node:assert/strict';
import test from 'node:test';
import type { Landing } from './landing-api';
import {
  LANDING_COALESCE_MS, LANDING_EVENT, LANDING_MAX_WAIT_MS, inProject, movesTodoLanding, parseLandingChange,
  subscribeLandingChanges, type LandingChange,
} from './landing-events';

/**
 * `integration_changed` on the client: its body read defensively, a burst
 * gathered into one reload, and the jobs widget reading its list again when
 * the daemon announces a change.
 */

const change = (over: Partial<LandingChange> = {}): LandingChange => ({
  integrationId: 'job-1', project: 'acme', seriesId: 's1', state: 'open', changed: ['state', 'pull_request'], ...over,
});

/** A stream and a clock the test drives by hand. */
function harness() {
  let listener: ((event: MessageEvent) => void) | null = null;
  let stopped = 0;
  let now = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  let next = 1;
  return {
    on: (type: string, fn: (event: MessageEvent) => void) => {
      assert.equal(type, LANDING_EVENT);
      listener = fn;
      return () => { stopped += 1; listener = null; };
    },
    timers: {
      set: (fn: () => void, ms: number) => { const id = next++; pending.set(id, { at: now + ms, fn }); return id; },
      clear: (id: unknown) => { pending.delete(id as number); },
      now: () => now,
    },
    emit: (body: unknown) => listener?.({ data: typeof body === 'string' ? body : JSON.stringify(body) } as MessageEvent),
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) { pending.delete(id); t.fn(); }
      }
    },
    get stopped() { return stopped; },
    get listening() { return listener !== null; },
  };
}

test('the body is read defensively', () => {
  assert.deepEqual(parseLandingChange(JSON.stringify(change())), change());
  assert.deepEqual(parseLandingChange({ ...change(), project: null, seriesId: 7, changed: ['state', 'bogus'] }),
    change({ project: null, seriesId: null, changed: ['state'] }));
  assert.equal(parseLandingChange('not json'), null);
  assert.equal(parseLandingChange({ state: 'open', changed: [] }), null);
  assert.equal(parseLandingChange(null), null);
});

test('a burst is one reload, after a quiet window', () => {
  const h = harness();
  const batches: LandingChange[][] = [];
  subscribeLandingChanges((b) => batches.push(b), { on: h.on, timers: h.timers });
  h.emit(change({ integrationId: 'a' }));
  h.advance(LANDING_COALESCE_MS - 1);
  h.emit(change({ integrationId: 'b' }));
  h.advance(LANDING_COALESCE_MS - 1);
  assert.equal(batches.length, 0, 'still in the burst');
  h.advance(1);
  assert.deepEqual(batches.map((b) => b.map((c) => c.integrationId)), [['a', 'b']]);
  h.advance(10 * LANDING_COALESCE_MS);
  assert.equal(batches.length, 1, 'nothing more without a change');
});

test('a steady trickle still reloads within the longest wait', () => {
  const h = harness();
  const batches: LandingChange[][] = [];
  subscribeLandingChanges((b) => batches.push(b), { on: h.on, timers: h.timers });
  let elapsed = 0;
  while (batches.length === 0 && elapsed <= LANDING_MAX_WAIT_MS * 2) {
    h.emit(change());
    h.advance(LANDING_COALESCE_MS / 2);
    elapsed += LANDING_COALESCE_MS / 2;
  }
  assert.equal(batches.length, 1);
  assert.ok(elapsed <= LANDING_MAX_WAIT_MS + LANDING_COALESCE_MS, `reloaded after ${elapsed} ms`);
});

test('the filter keeps a surface\'s changes, and unsubscribing drops a waiting burst', () => {
  const h = harness();
  const batches: LandingChange[][] = [];
  const stop = subscribeLandingChanges((b) => batches.push(b), { on: h.on, timers: h.timers, filter: inProject('acme') });
  h.emit(change({ project: 'other' }));
  h.advance(LANDING_MAX_WAIT_MS);
  assert.equal(batches.length, 0, 'another project\'s job');
  h.emit(change());
  stop();
  h.advance(LANDING_MAX_WAIT_MS);
  assert.equal(batches.length, 0);
  assert.equal(h.stopped, 1);
  assert.equal(h.listening, false);

  assert.equal(inProject(null)(change({ project: 'other' })), true, 'no project picked: all of them');
  assert.equal(movesTodoLanding(change({ changed: ['checks'] })), false, 'the badge shows no checks');
  assert.equal(movesTodoLanding(change({ changed: ['checks', 'landed'] })), true);
});

// ─── The jobs widget ────────────────────────────────────────────────────────

const job: Landing = {
  id: 'job-1', project: 'acme', series_id: 's1', branch: 'feat/add-export', remote: 'origin', target: 'main',
  mode: 'pr', state: 'branch', pr_number: null, pr_url: null, head_sha: null, merge_sha: null, landed: false,
  created_at: 2, updated_at: 2, checks: null, conflict: null, checks_running: false, pr_title: null,
};
const opened: Landing = {
  ...job, state: 'open', pr_number: 12, pr_url: 'https://github.com/acme/app/pull/12', pr_title: 'Add CSV export',
};

test('the jobs widget reads its list again when the daemon announces a change', async () => {
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
  const sources: Source[] = [];
  class Source extends EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor(readonly url: string) { super(); sources.push(this); }
    close() { this.readyState = Source.CLOSED; }
  }
  install('EventSource', Source);
  const React = await import('react');
  install('React', React);
  let current = job;
  const reads: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/ui/kanban/landings') && (init?.method ?? 'GET') === 'GET') {
      reads.push(url);
      return Response.json({ landings: [current] });
    }
    if (url.endsWith('/job-1/checks')) return Response.json({ landing: { ...current, checks_running: false } });
    return Response.json({});
  });
  const { createRoot } = await import('react-dom/client');
  const { LandingWidget } = await import('./landing-widget');
  const root = createRoot(document.getElementById('root')!);
  const settle = (ms: number) => React.act(async () => { await new Promise<void>((r) => setTimeout(r, ms)); });
  const announce = (body: LandingChange) => {
    for (const s of sources) s.dispatchEvent(new MessageEvent(LANDING_EVENT, { data: JSON.stringify(body) }));
  };
  try {
    await React.act(async () => { root.render(React.createElement(LandingWidget, { handle: null })); });
    await settle(30);
    assert.equal(reads.length, 1);
    assert.match(document.querySelector('[data-landing="job-1"]')!.textContent!, /Not pushed/);

    // The pull request opens: two writes on the daemon, one read here.
    current = opened;
    announce(change({ changed: ['state', 'pull_request'] }));
    announce(change({ changed: ['checks'] }));
    await settle(LANDING_COALESCE_MS + 100);
    assert.equal(reads.length, 2, 'one read for the burst');
    assert.match(document.querySelector('[data-landing="job-1"]')!.textContent!, /PR #12/);

    // Something that is not a job's change reads nothing.
    for (const s of sources) s.dispatchEvent(new MessageEvent(LANDING_EVENT, { data: '{"oops":true}' }));
    await settle(LANDING_COALESCE_MS + 100);
    assert.equal(reads.length, 2);
  } finally {
    await React.act(async () => { root.unmount(); });
    await new Promise<void>((r) => setTimeout(r, 20));
    assert.ok(sources.every((s) => s.readyState === Source.CLOSED), 'the widget gave its stream back');
    const globals = globalThis as Record<string, unknown>;
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globals[key];
    }
    dom.window.close();
  }
});
