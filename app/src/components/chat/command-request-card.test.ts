/**
 * The card of a command an agent asks the user to decide: its buttons are the
 * daemon's choices (a plugin's card has two, an agent's three), "Paste into a terminal" records the decision before it
 * opens the terminal, and a decided card shows its outcome, not its buttons.
 */
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import test, { type TestContext } from 'node:test';
import type { CommandRequestView } from '@/lib/command-requests';
import type { TerminalOpenRequest } from '@/lib/terminal-web';

const request = (over: Partial<CommandRequestView> = {}): CommandRequestView => ({
  id: 'r1', missionId: 'm1', agent: 'timon.coder', command: 'sudo systemctl restart nginx', note: null,
  sessionId: null, project: 'timon', missionTitle: 'Fix nginx', taskId: null,
  choices: ['allow', 'paste', 'deny'], status: 'pending', createdAt: 1, resolvedAt: null, run: null, running: false, ...over,
});

type Call = { method: string; url: string; body?: unknown };

async function mount(ctx: TestContext, listed: CommandRequestView[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  const calls: Call[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (method === 'POST') {
      const { decision } = JSON.parse(String(init!.body)) as { decision: CommandRequestView['status'] };
      return new Response(JSON.stringify({ ok: true, request: request({ status: decision, resolvedAt: 2 }) }), { status: 200 });
    }
    return new Response(JSON.stringify({ requests: listed }), { status: 200 });
  });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { CommandRequestCard } = await import('./command-request-card');
  const root = createRoot(document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  const opened: TerminalOpenRequest[] = [];
  let accept = true;
  const openTerminal = (r: TerminalOpenRequest) => { calls.push({ method: 'OPEN', url: '' }); opened.push(r); return accept; };
  const render = (view: CommandRequestView) => act(() => {
    root.render(React.createElement(CommandRequestCard, { request: view, time: '12:00', openTerminal }));
  });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const buttons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-decision]')).map((b) => b.dataset.decision);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  // A decided card drops its buttons; a paste then hands the command over.
  const click = async (decision: string) => {
    await act(() => { document.querySelector<HTMLButtonElement>(`button[data-decision="${decision}"]`)!.click(); });
    await until(() => buttons().length === 0 && (decision !== 'paste' || opened.length > 0), `the "${decision}" decision to land`);
  };
  return { render, buttons, click, until, calls, opened, refuse: () => { accept = false; } };
}

test('three choices on an agent\'s card, two on a plugin\'s', async (t) => {
  const w = await mount(t);
  await w.render(request());
  assert.deepEqual(w.buttons(), ['allow', 'paste', 'deny']);
  assert.match(document.body.textContent ?? '', /Paste into a terminal/);
  assert.match(document.querySelector('pre')!.textContent ?? '', /sudo systemctl restart nginx/);

  await w.render(request({ id: 'r2', choices: ['paste', 'deny'] }));
  assert.deepEqual(w.buttons(), ['paste', 'deny']);
});

test('a replayed card takes the buttons the daemon offers now', async (t) => {
  const w = await mount(t, [request({ choices: ['paste', 'deny'] })]);
  await w.render(request());
  await w.until(() => w.buttons().length === 2, 'the daemon\'s current choices');
  assert.deepEqual(w.buttons(), ['paste', 'deny'], 'the daemon narrowed the choices');
  assert.equal(w.calls[0]?.url, '/api/ui/terminal/web/proposals?mission_id=m1&limit=500');
});

test('paste records the decision, then types the command in the terminal of the request\'s project', async (t) => {
  const w = await mount(t);
  await w.render(request());
  await w.click('paste');
  const post = w.calls.findIndex((c) => c.method === 'POST');
  const open = w.calls.findIndex((c) => c.method === 'OPEN');
  assert.ok(post >= 0 && open > post, 'resolved before the terminal opens');
  assert.equal(w.calls[post]!.url, '/api/ui/terminal/web/proposals/r1/resolve');
  assert.deepEqual(w.calls[post]!.body, { decision: 'paste', origin: 'ui_card_paste' });
  assert.deepEqual(w.opened, [{ scope: { kind: 'project', slug: 'timon' }, insert: 'sudo systemctl restart nginx' }]);
  assert.deepEqual(w.buttons(), [], 'decided: no button left');
  assert.match(document.body.textContent ?? '', /Pasted into a terminal/);
});

test('refuse and allow record their decision and open no terminal', async (t) => {
  const w = await mount(t);
  await w.render(request());
  await w.click('deny');
  assert.deepEqual(w.calls.find((c) => c.method === 'POST')!.body, { decision: 'deny', origin: 'ui_card_deny' });
  assert.equal(w.opened.length, 0);
  assert.match(document.body.textContent ?? '', /Dismissed/);
});

test('a window that refuses (another project on screen) leaves the decision recorded', async (t) => {
  const w = await mount(t);
  w.refuse();
  await w.render(request());
  await w.click('paste');
  assert.equal(w.opened.length, 1);
  assert.match(document.body.textContent ?? '', /Pasted into a terminal/);
  assert.ok(document.querySelector('pre'), 'the command stays on the card, to copy by hand');
});

test('reloaded, a decided card shows its outcome and asks nothing of the daemon', async (t) => {
  const w = await mount(t);
  await w.render(request({ status: 'paste', resolvedAt: 2 }));
  assert.deepEqual(w.buttons(), []);
  assert.match(document.body.textContent ?? '', /Pasted into a terminal/);
  assert.equal(w.calls.length, 0, 'no reconciliation for a decided card');
});

test('an allowed command shows its exit code, with the output folded away', async (t) => {
  const w = await mount(t);
  await w.render(request({
    status: 'allow', resolvedAt: 2,
    run: { exitCode: 3, timedOut: false, output: 'boom: it failed', durationMs: 1200, notRun: false },
  }));
  assert.deepEqual(w.buttons(), []);
  assert.match(document.body.textContent ?? '', /Executed, code 3 \(1\.2 s\)/);
  const details = document.querySelector('details');
  assert.ok(details, 'the output is a collapsible block');
  assert.equal(details!.open, false);
  assert.match(details!.textContent ?? '', /boom: it failed/);
});

test('an allowed command still running, stopped by the time limit, or never started', async (t) => {
  const w = await mount(t);
  await w.render(request({ status: 'allow', resolvedAt: 2, running: true }));
  assert.match(document.body.textContent ?? '', /running/);
  await w.render(request({ id: 'r2', status: 'allow', resolvedAt: 2, run: { exitCode: null, timedOut: true, output: '', durationMs: 120000, notRun: false } }));
  assert.match(document.body.textContent ?? '', /stopped after 120\.0 s/);
  assert.equal(document.querySelector('details'), null, 'no output, nothing to unfold');
  await w.render(request({ id: 'r3', status: 'allow', resolvedAt: 2, run: { exitCode: null, timedOut: false, output: 'not run: outside', durationMs: 0, notRun: true } }));
  assert.match(document.body.textContent ?? '', /could not run/);
});
