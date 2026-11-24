import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FIRST_RUN_THEME } from './first-run-theme.js';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StartupView, probeUi, type ViewTarget } from './startup-view.js';
import { RELOAD_BUDGET_MS } from './window-load.js';

const UI = 'http://127.0.0.1:3101';

function setup(answers: boolean[], opts: { destroyed?: () => boolean } = {}) {
  const loaded: string[] = [];
  let clock = 0;
  let gaveUp = 0;
  const probes: boolean[] = [...answers];
  const target: ViewTarget = { isDestroyed: opts.destroyed ?? (() => false), loadURL: async (u) => { loaded.push(u); } };
  const view = new StartupView(target, UI, {
    locale: () => 'en', scheme: () => 'dark',
    probe: async () => probes.length > 1 ? probes.shift()! : probes[0]!,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    onGiveUp: () => { gaveUp++; },
  });
  return { view, loaded, gaveUp: () => gaveUp, advance: (ms: number) => { clock += ms; } };
}

const isWaiting = (u: string) => u.startsWith('data:text/html');

test('the interface is only loaded once it answers; a waiting page shows before', async () => {
  const { view, loaded } = setup([false, false, true]);
  await view.begin();
  assert.ok(isWaiting(loaded[0]!));
  assert.equal(loaded.at(-1), UI);
  assert.equal(loaded.filter((u) => u === UI).length, 1);
  assert.equal(view.state, 'ready');
});

test('the service step paints a page without polling the interface', () => {
  const { view, loaded } = setup([true]);
  view.start();
  assert.equal(loaded.length, 1);
  assert.equal(view.state, 'service');
  assert.equal(view.needsUi(), true);
});

test('giving up after the budget shows the failed page and reports once', async () => {
  const { view, loaded, gaveUp } = setup([false]);
  await view.begin();
  assert.equal(gaveUp(), 1);
  assert.equal(view.state, 'failed');
  assert.ok(isWaiting(loaded.at(-1)!));
  assert.ok(!loaded.includes(UI));
});

test('a startup that failed can be resumed from the tray', async () => {
  const { view, loaded } = setup([false, false, true]);
  view.start();
  view.fail();
  assert.equal(view.state, 'failed');
  await view.begin();
  assert.equal(loaded.at(-1), UI);
});

test('fail() does not overwrite an interface that is already loading', async () => {
  const { view } = setup([true]);
  await view.begin();
  view.fail();
  assert.equal(view.state, 'ready');
});

test('a destroyed window stops the polling', async () => {
  let destroyed = false;
  const { view, loaded } = setup([false], { destroyed: () => destroyed });
  const pending = view.begin();
  destroyed = true;
  await pending;
  assert.ok(!loaded.includes(UI));
});

test('retry waits again after the loaded interface refused, within the same budget', async () => {
  const { view, loaded, advance } = setup([true]);
  await view.begin();
  assert.equal(view.state, 'ready');
  await view.retry();
  assert.equal(loaded.filter((u) => u === UI).length, 2);
  advance(RELOAD_BUDGET_MS);
  assert.ok(view.elapsedMs() >= RELOAD_BUDGET_MS);
});

test('a probe that answers but a real load that keeps failing gives up once at the budget', async () => {
  const { view, loaded, gaveUp, advance } = setup([true]);
  await view.begin();
  await view.retry();
  await view.retry();
  assert.equal(gaveUp(), 0);
  assert.equal(view.state, 'ready');
  advance(RELOAD_BUDGET_MS);
  const before = loaded.filter((u) => u === UI).length;
  await view.retry();
  await view.retry();
  assert.equal(view.state, 'failed');
  assert.equal(gaveUp(), 1);
  assert.equal(loaded.filter((u) => u === UI).length, before);
  assert.ok(isWaiting(loaded.at(-1)!));
});

test('probeUi is true on any HTTP answer and false on a closed port', async () => {
  const server = createServer((_req, res) => { res.statusCode = 503; res.end(); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  assert.equal(await probeUi(`http://127.0.0.1:${port}`), true);
  await new Promise<void>((r) => server.close(() => r()));
  assert.equal(await probeUi(`http://127.0.0.1:${port}`), false);
});

test('a restart goes back to waiting, then reopens the interface on the route asked for, once', async () => {
  const { view, loaded } = setup([true]);
  await view.begin();
  assert.equal(view.state, 'ready');
  view.restart('/setup/agent');
  assert.equal(view.state, 'service');
  assert.equal(view.needsUi(), true, 'showWindow resumes it once the new daemon answers');
  const waiting = decodeURIComponent(loaded.at(-1)!);
  assert.match(waiting, /Restarting Timon/);
  await view.begin();
  assert.equal(loaded.at(-1), `${UI}/setup/agent`);
  // The next start is an ordinary one: its own address, and no restart wording.
  view.start();
  assert.doesNotMatch(decodeURIComponent(loaded.at(-1)!), /Restarting Timon/);
  await view.begin();
  assert.equal(loaded.at(-1), UI);
});

test('a restart that is never resumed does not let a pending load win', async () => {
  const { view, loaded } = setup([false, true]);
  const first = view.begin();
  view.restart('/setup/agent');
  await first;
  assert.ok(isWaiting(loaded.at(-1)!), 'the superseded wait loads nothing');
  assert.equal(view.state, 'service');
});

test('a first launch hands its look to the waiting page', () => {
  const loaded: string[] = [];
  const view = new StartupView({ isDestroyed: () => false, loadURL: async (u) => { loaded.push(u); } }, UI, {
    locale: () => 'en', scheme: () => 'dark', firstRun: true,
    probe: async () => false, sleep: async () => {}, now: () => 0, onGiveUp: () => {},
  });
  view.start();
  const html = decodeURIComponent(loaded[0]!.slice('data:text/html;charset=utf-8,'.length));
  assert.ok(html.includes(FIRST_RUN_THEME.dark.background), 'the onboarding look');
  assert.match(html, /<aside class="card" role="status"/, 'the steps in the corner card');
});

test('the handover page speaks the language and wears the mode chosen during the onboarding', () => {
  const loaded: string[] = [];
  let locale = 'en';
  let scheme: 'light' | 'dark' = 'light';
  const view = new StartupView({ isDestroyed: () => false, loadURL: async (u) => { loaded.push(u); } }, UI, {
    locale: () => locale, scheme: () => scheme, firstRun: true,
    probe: async () => false, sleep: async () => {}, now: () => 0, onGiveUp: () => {},
  });
  view.start();
  // The onboarding switched to French and dark, then created the account.
  locale = 'fr-FR';
  scheme = 'dark';
  view.restart('/onboarding?step=agent');
  const html = decodeURIComponent(loaded.at(-1)!.slice('data:text/html;charset=utf-8,'.length));
  assert.match(html, /Timon redémarre…/); // french-ok: the French locale under test
  assert.match(html, /color-scheme:dark/);
});
