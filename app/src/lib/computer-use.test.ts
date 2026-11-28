/**
 * Computer use, screen side: the status answer is read defensively, and the
 * human stop / resume only ever call the UI proxy (never an agent command).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COMPUTER_UNREACHABLE, fetchComputerSetup, fetchComputerStatus, parseComputerSetup, parseComputerStatus, requestComputerPermissions,
  restartComputerApp, sendComputerControl,
} from './computer-use';

test('parseComputerStatus reads active, bare or wrapped in result', () => {
  assert.deepEqual(parseComputerStatus({ active: true }), { active: true, stopped: false });
  assert.deepEqual(parseComputerStatus({ ok: true, result: { active: true, stopped: true } }), { active: true, stopped: true });
  assert.deepEqual(parseComputerStatus({ active: 'yes' }), { active: false, stopped: false });
  assert.deepEqual(parseComputerStatus(null), { active: false, stopped: false });
});

test('status and controls go through the UI proxy; failures read as idle / refused', async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const real = globalThis.fetch;
  let status = 200;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ active: true }), { status });
  }) as typeof fetch;
  try {
    assert.equal((await fetchComputerStatus()).active, true);
    assert.equal(await sendComputerControl('stop'), true);
    assert.equal(await sendComputerControl('resume'), true);
    status = 503; // desktop absent
    assert.equal((await fetchComputerStatus()).active, false);
    assert.equal(await sendComputerControl('stop'), false);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal((await fetchComputerStatus()).active, false);
    assert.deepEqual(calls.slice(0, 3), [
      { url: '/api/ui/computer/status', method: 'GET' },
      { url: '/api/ui/computer/stop', method: 'POST' },
      { url: '/api/ui/computer/resume', method: 'POST' },
    ]);
  } finally {
    globalThis.fetch = real;
  }
});

test('the UI proxy only relays status, stop and resume, and refuses the agent commands', async () => {
  const { uiComputerPath } = await import('./computer-use');
  assert.equal(uiComputerPath('GET', 'status'), '/api/computer/status');
  for (const command of ['status', 'stop', 'resume', 'request_permissions', 'restart_app']) {
    assert.equal(uiComputerPath('POST', command), `/api/computer/${command}`);
  }
  for (const command of ['click', 'type', 'key', 'screenshot', 'move', 'drag', 'scroll', 'wait', '..%2Fstatus', '']) {
    assert.equal(uiComputerPath('POST', command), null, command);
    assert.equal(uiComputerPath('GET', command), null, command);
  }
  assert.equal(uiComputerPath('GET', 'stop'), null);
  assert.equal(uiComputerPath('GET', 'resume'), null);
  // Setup commands change the machine: never a GET (a link or a prefetch could fire them).
  assert.equal(uiComputerPath('GET', 'request_permissions'), null);
  assert.equal(uiComputerPath('GET', 'restart_app'), null);
});

test('the UI status poll (GET) is relayed upstream as POST /api/computer/status, the only route the daemon has', async () => {
  const { uiComputerUpstream } = await import('./computer-use');
  assert.deepEqual(uiComputerUpstream('GET', 'status'), { method: 'POST', path: '/api/computer/status' });
  for (const command of ['status', 'stop', 'resume', 'request_permissions', 'restart_app']) {
    assert.deepEqual(uiComputerUpstream('POST', command), { method: 'POST', path: `/api/computer/${command}` });
  }
  assert.equal(uiComputerUpstream('GET', 'stop'), null);
  assert.equal(uiComputerUpstream('GET', 'click'), null);
});

test('parseComputerSetup keeps only known prerequisites and reads anything else as unreachable', () => {
  const setup = parseComputerSetup({ ok: true, result: { platform: 'darwin', available: false, needsRestart: true, checks: { desktop: 'ok', screen: 'missing', accessibility: 'ok', bogus: 'ok', inputTool: 'maybe' } } });
  assert.deepEqual(setup, { reachable: true, platform: 'darwin', available: false, needsRestart: true, checks: { desktop: 'ok', screen: 'missing', accessibility: 'ok' } });
  assert.deepEqual(parseComputerSetup(null), COMPUTER_UNREACHABLE);
  assert.deepEqual(parseComputerSetup({ active: true }), COMPUTER_UNREACHABLE, 'an older desktop without checks');
});

test('the setup calls go through the UI proxy and fail soft', async () => {
  const real = globalThis.fetch;
  const calls: Array<{ url: string; method: string }> = [];
  let status = 200;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ checks: { desktop: 'ok' }, available: true }), { status });
  }) as typeof fetch;
  try {
    assert.equal((await fetchComputerSetup()).available, true);
    assert.equal(await requestComputerPermissions(), true);
    assert.equal(await restartComputerApp(), true);
    assert.deepEqual(calls, [
      { url: '/api/ui/computer/status', method: 'GET' },
      { url: '/api/ui/computer/request_permissions', method: 'POST' },
      { url: '/api/ui/computer/restart_app', method: 'POST' },
    ]);
    status = 503;
    assert.deepEqual(await fetchComputerSetup(), COMPUTER_UNREACHABLE);
    assert.equal(await requestComputerPermissions(), false);
    globalThis.fetch = (async () => { throw new Error('offline'); }) as typeof fetch;
    assert.equal(await restartComputerApp(), false);
  } finally {
    globalThis.fetch = real;
  }
});

test('the journal path is built for a named agent only, with a bounded limit and an encoded name', async () => {
  const { uiComputerJournalPath, uiComputerPath } = await import('./computer-use');
  assert.equal(uiComputerJournalPath('', 50), null);
  assert.equal(uiComputerJournalPath('a b&c', 9999), '/api/computer/journal?agent=a%20b%26c&limit=500');
  assert.equal(uiComputerJournalPath('tim', 0), '/api/computer/journal?agent=tim&limit=50');
  // `journal` is not a command of the generic relay: it has its own route.
  assert.equal(uiComputerPath('GET', 'journal'), null);
  assert.equal(uiComputerPath('POST', 'journal'), null);
});

test('list_windows goes through the UI proxy, focus_window never does, and the answer is read defensively', async () => {
  const { uiComputerPath, parseComputerWindows, fetchComputerWindows } = await import('./computer-use');
  assert.equal(uiComputerPath('POST', 'list_windows'), '/api/computer/list_windows');
  assert.equal(uiComputerPath('GET', 'list_windows'), null);
  assert.equal(uiComputerPath('POST', 'focus_window'), null);
  assert.deepEqual(parseComputerWindows({ ok: true, result: [{ id: '1', title: 't', app: 'Notepad', focused: true }, { id: 2 }, null, { id: '3', app: ' ' }] }),
    [{ id: '1', title: 't', app: 'Notepad', focused: true }]);
  assert.deepEqual(parseComputerWindows('nope'), []);
  const real = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response(JSON.stringify({ ok: true, result: [{ id: '1', title: '', app: 'Mail' }] }))) as typeof fetch;
    assert.deepEqual(await fetchComputerWindows(), [{ id: '1', title: '', app: 'Mail', focused: false }]);
    globalThis.fetch = (async () => new Response('{}', { status: 503 })) as typeof fetch;
    assert.equal(await fetchComputerWindows(), null);
  } finally { globalThis.fetch = real; }
});

test('the allowed applications are normalised: bare names take the default mode, objects keep theirs, blanks and repeats go', async () => {
  const { normalizeAllowedApps, modeForVerdict, parseProbeVerdict } = await import('./computer-use');
  assert.deepEqual(normalizeAllowedApps(['Notes', { app: 'Discord', mode: 'foreground' }, 'notes', ' ', 3, { app: 'Mail' }], 'background'), [
    { app: 'Notes', mode: 'background' }, { app: 'Discord', mode: 'foreground' }, { app: 'Mail', mode: 'background' },
  ]);
  assert.deepEqual(normalizeAllowedApps(undefined), []);
  assert.equal(modeForVerdict('rich'), 'background');
  assert.equal(modeForVerdict('poor'), 'foreground');
  assert.equal(modeForVerdict('empty'), 'foreground');
  assert.equal(parseProbeVerdict({ result: { nodes: 4, actionable: 3, verdict: 'rich' } }), 'rich');
  assert.equal(parseProbeVerdict({ result: { verdict: 'amazing' } }), null);
  assert.equal(parseProbeVerdict(null), null);
});

test('the probe of an open window goes through the UI proxy with its window id only; the agent commands stay out', async () => {
  const { uiComputerUpstream, uiComputerBody } = await import('./computer-use');
  assert.deepEqual(uiComputerUpstream('POST', 'a11y_probe_app'), { method: 'POST', path: '/api/computer/a11y_probe_app' });
  assert.equal(uiComputerUpstream('GET', 'a11y_probe_app'), null);
  assert.equal(uiComputerUpstream('POST', 'a11y_tree'), null);
  assert.deepEqual(uiComputerBody('a11y_probe_app', { windowId: '12:3', actor: 'agent' }), { windowId: '12:3' });
  assert.equal(uiComputerBody('a11y_probe_app', { windowId: '../x' }), null);
  assert.equal(uiComputerBody('a11y_probe_app', null), null);
  assert.deepEqual(uiComputerBody('list_windows', { windowId: '1' }), {}, 'no other command forwards a body');
});

test('the default exclusions are the daemon\'s, name for name', async () => {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { DEFAULT_EXCLUDED_APPS } = await import('./computer-use');
  const source = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'orchestrator', 'src', 'agent-config.ts'), 'utf8');
  const start = source.indexOf('DEFAULT_COMPUTER_USE_EXCLUDED_APPS: readonly string[] = Object.freeze([');
  assert.ok(start > 0, 'the daemon list is where this test reads it');
  const block = source.slice(start, source.indexOf(']);', start));
  const daemon = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...DEFAULT_EXCLUDED_APPS], daemon);
  assert.ok(daemon.includes('KeePassXC') && daemon.includes('Timon') && daemon.includes('gnome-terminal'));
});

test('excluded applications: the defaults when absent, null on save while unchanged, the names once edited', async () => {
  const { DEFAULT_EXCLUDED_APPS, excludedAppsToSave, isDefaultExcludedApps, normalizeExcludedApps } = await import('./computer-use');
  assert.deepEqual(normalizeExcludedApps(undefined), [...DEFAULT_EXCLUDED_APPS]);
  assert.deepEqual(normalizeExcludedApps([' Slack ', 'slack', '', 3, 'Terminal']), ['Slack', 'Terminal']);
  assert.deepEqual(normalizeExcludedApps([]), [], 'an empty list a person chose stays empty');
  assert.equal(isDefaultExcludedApps([...DEFAULT_EXCLUDED_APPS].reverse().map((app) => app.toUpperCase())), true, 'order and case apart');
  assert.equal(excludedAppsToSave([...DEFAULT_EXCLUDED_APPS]), null);
  assert.deepEqual(excludedAppsToSave(['Slack']), ['Slack']);
  assert.deepEqual(excludedAppsToSave([]), []);
  assert.notEqual(excludedAppsToSave(DEFAULT_EXCLUDED_APPS.slice(1)), null, 'one entry removed is an edit');
});
