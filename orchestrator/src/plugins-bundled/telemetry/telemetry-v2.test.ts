/**
 * Catalogue v2 (`docs/TELEMETRY.md`): features read from finished requests,
 * failures, the account slot, what the web app reports, and the daily
 * installation snapshot. Requests go to an injected `fetch`; a marker planted
 * in every name and path must never reach a payload.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-telemetry-v2-'));
await import('../../../tests/helpers/paid-license.js');

const { dbApi } = await import('../../db.js');
const { startTelemetry } = await import('./runtime.js');
const { createRequestObserver } = await import('../../kernel/request-observer.js');
const {
  apiAreaOf, cpuClassOf, failureCodeOf, featureOf, pageSectionOf, ramClassOf,
} = await import('./features.js');
const { validateEvent } = await import('./events.js');

const CAPTURE = 'http://127.0.0.1:9';
const MARKER = 'zq-secret-marker';
type Payload = { name: string; profileId: string; properties: Record<string, unknown> };

/** User agent each payload was sent with: kept beside it, the payload is what OpenPanel stores. */
const agentOf = new WeakMap<Payload, string>();

function recorder(): { sent: Payload[]; fetch: typeof fetch } {
  const sent: Payload[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = (JSON.parse(String(init?.body)) as { payload: Payload }).payload;
    agentOf.set(payload, String((init?.headers as Record<string, string> | undefined)?.['user-agent']));
    sent.push(payload);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sent, fetch: fake };
}

const noMission = { missionFacts: () => null, taskFacts: () => null };
const GLOBAL_KEYS = new Set(['surface', 'app_version', 'platform', 'arch', 'event_schema_version', 'license_tier', 'install_age', 'account_slot']);

function start(opts: { now?: () => number; intervalMs?: number; stored?: () => string | null } = {}) {
  const { sent, fetch } = recorder();
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, fetch,
    home: mkdtempSync(join(tmpdir(), 'timon-telemetry-v2-home-')),
    preference: { configValue: () => undefined, stored: opts.stored ?? (() => null) },
    collector: noMission, intervalMs: opts.intervalMs ?? 60_000, now: opts.now,
  });
  return { rt, sent };
}

const owner = createTestAccount(dbApi, { email: `${MARKER}@example.com`, name: MARKER, passwordHash: 'x', isSuperadmin: true });
const second = createTestAccount(dbApi, { email: `${MARKER}-2@example.com`, name: `${MARKER}-2`, passwordHash: 'x', isSuperadmin: false });

/* ── Mappings ───────────────────────────────────────────────────────────── */

test('features come from route templates, failures from closed codes', () => {
  assert.equal(featureOf('post', '/api/agents'), 'agent.create');
  assert.equal(featureOf('POST', '/api/agents/:name/rename'), 'agent.rename');
  assert.equal(featureOf('GET', '/api/agents'), null);
  assert.equal(featureOf('POST', null), null);
  assert.equal(failureCodeOf(201, null), 'none');
  assert.equal(failureCodeOf(409, 'user_limit'), 'user_limit');
  assert.equal(failureCodeOf(409, 'email_taken'), 'conflict');
  assert.equal(failureCodeOf(400, MARKER), 'invalid');
  assert.equal(failureCodeOf(503, null), 'server_error');
  assert.equal(failureCodeOf(418, null), 'other');
  assert.equal(apiAreaOf('/api/missions/:id/compact'), 'missions');
  assert.equal(apiAreaOf(`/api/${MARKER}/x`), 'other');
  assert.equal(apiAreaOf('/health'), null);
});

test('a page is reduced to its section: the rest of the path never leaves', () => {
  assert.equal(pageSectionOf('/'), 'home');
  assert.equal(pageSectionOf('/?tab=1'), 'home');
  assert.equal(pageSectionOf(`/agents/${MARKER}`), 'agents');
  assert.equal(pageSectionOf('/islands/abc-123'), 'islands');
  assert.equal(pageSectionOf(`/${MARKER}`), 'plugin');
  assert.equal(pageSectionOf('/Agents'), 'plugin');
  assert.equal(pageSectionOf('/home'), 'plugin');
  assert.equal(pageSectionOf('https://example.com/agents'), 'plugin');
});

test('machine classes round to the size a machine is sold as', () => {
  assert.equal(ramClassOf(7.6 * 1024 ** 3), '8-16');
  assert.equal(ramClassOf(4 * 1024 ** 3), 'lt8');
  assert.equal(ramClassOf(31.2 * 1024 ** 3), '32-64');
  assert.equal(ramClassOf(128 * 1024 ** 3), 'gte64');
  assert.equal(cpuClassOf(1), '1-2');
  assert.equal(cpuClassOf(8), '5-8');
  assert.equal(cpuClassOf(32), 'gt16');
});

test('the v2 events are closed too', () => {
  assert.ok(validateEvent('page_viewed', { section: 'agents' }));
  assert.equal(validateEvent('page_viewed', { section: MARKER }), null);
  assert.equal(validateEvent('feature_used', { feature: 'agent.create', actor: 'person', result: 'success', failure_code: 'none', name: MARKER }), null);
  assert.ok(validateEvent('installation_snapshot', { ram_class: '8-16', cpu_class: '5-8', backends: ['claude'] }));
  assert.ok(validateEvent('screen_view', { section: 'agents', __path: '/agents' }));
  assert.equal(validateEvent('screen_view', { section: 'agents', __path: `/agents/${MARKER}` }), null, 'a page view carries the section only');
  assert.equal(validateEvent('screen_view', { section: 'agents', __path: '/projects' }), null);
  assert.equal(validateEvent('installation_snapshot', { ram_class: '8-16', cpu_class: '5-8', backends: ['bad name'] }), null);
  assert.equal(validateEvent('upgrade_action', { action: 'buy_opened', entry_point: MARKER }), null);
});

/* ── Requests ───────────────────────────────────────────────────────────── */

test('finished requests become features, failures and the account limit, with the account slot only', async () => {
  const { rt, sent } = start();
  const app = express();
  app.use((req, _res, next) => {
    const user = req.headers['x-user'] === 'second' ? second : owner;
    req.auth = { kind: req.headers['x-agent'] ? 'api-token' : 'session', user, isSuperadmin: true, ...(req.headers['x-agent'] ? { missionId: 'm-1' } : {}) };
    next();
  });
  app.use(createRequestObserver());
  app.post('/api/agents', (_req, res) => { res.status(201).json({ name: MARKER }); });
  app.post('/api/users', (_req, res) => { res.status(409).json({ error: 'user_limit', message: `${MARKER} cannot be added` }); });
  app.get('/api/agents/:name', (_req, res) => { res.json({ name: MARKER }); });
  app.post('/api/missions/:id/compact', (_req, res) => { res.status(500).json({ error: `boom ${MARKER}` }); });
  app.post('/api/telemetry/ui-event', (_req, res) => { res.json({ ok: true }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await fetch(`${base}/api/agents`, { method: 'POST' });
    await fetch(`${base}/api/agents`, { method: 'POST', headers: { 'x-agent': '1' } });
    await fetch(`${base}/api/users`, { method: 'POST', headers: { 'x-user': 'second' } });
    await fetch(`${base}/api/agents/${MARKER}`);
    await fetch(`${base}/api/missions/${MARKER}/compact`, { method: 'POST' });
    await fetch(`${base}/api/telemetry/ui-event`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 30));
    await rt.flushNow();
  } finally {
    server.close();
    await rt.dispose();
  }
  const events = sent.filter((p) => p.name !== 'app_started' && p.name !== 'milestone_reached');
  assert.deepEqual(sent.filter((p) => p.name === 'milestone_reached').map((p) => p.properties.milestone), ['first_agent_created'], 'once, the first success only');
  assert.deepEqual(events.map((p) => p.name), ['feature_used', 'feature_used', 'feature_used', 'upgrade_action', 'operation_failed']);
  assert.deepEqual(
    events.slice(0, 3).map((p) => [p.properties.feature, p.properties.actor, p.properties.result, p.properties.failure_code, p.properties.account_slot]),
    [['agent.create', 'person', 'success', 'none', 1], ['agent.create', 'agent', 'success', 'none', 1], ['account.create', 'person', 'failure', 'user_limit', 2]],
  );
  assert.deepEqual(events[3]!.properties.action, 'account_limit_reached');
  assert.deepEqual([events[4]!.properties.area, events[4]!.properties.feature, events[4]!.properties.cause_code], ['missions', 'other', 'server_error']);
  assert.ok(!JSON.stringify(sent).includes(MARKER), 'no name, path or message reaches a payload');
  assert.ok(!JSON.stringify(sent).includes(owner.id), 'the account id never leaves, only its slot');
});

/* ── Web app ────────────────────────────────────────────────────────────── */

test('app_opened is counted once a day per account; pages and upgrade clicks each time', async () => {
  let clock = Date.parse('2026-11-03T09:00:00Z');
  const { rt, sent } = start({ now: () => clock });
  const opened = { name: 'app_opened' as const, surface: 'web' as const, setupCompleted: true };
  rt.trackUi(opened, { userId: owner.id });
  rt.trackUi({ ...opened, surface: 'desktop' }, { userId: owner.id });
  rt.trackUi(opened, { userId: second.id });
  clock += 24 * 3_600_000;
  rt.trackUi(opened, { userId: owner.id });
  rt.trackUi({ name: 'page_viewed', surface: 'web', path: `/projects/${MARKER}` }, { userId: owner.id });
  rt.trackUi({ name: 'upgrade_action', surface: 'web', action: 'buy_opened', entryPoint: 'license_page' }, { userId: owner.id });
  await rt.flushNow();
  await rt.dispose();
  const events = sent.filter((p) => p.name !== 'app_started');
  assert.deepEqual(events.map((p) => [p.name, p.properties.account_slot]), [
    ['app_opened', 1], ['app_opened', 2], ['app_opened', 1], ['page_viewed', 1], ['screen_view', 1], ['upgrade_action', 1],
  ]);
  assert.equal(events[3]!.properties.section, 'projects');
  assert.equal(events[4]!.properties.__path, '/projects', 'the page view carries the section, never the real path');
  // A person's events name the system, so OpenPanel opens a session; the daemon's own stay a bare agent.
  for (const event of events) assert.match(agentOf.get(event)!, /^Timon\/[^ ]+ \(.+\)$/, event.name);
  const started = sent.find((p) => p.name === 'app_started');
  assert.ok(started);
  assert.match(agentOf.get(started)!, /^Timon\/[^ ()]+$/);
  assert.equal(events[0]!.properties.surface, 'web');
  assert.ok(!JSON.stringify(sent).includes(MARKER));
});

test('sharing off: the web app reports nothing', async () => {
  const { rt, sent } = start({ stored: () => '0' });
  rt.trackUi({ name: 'app_opened', surface: 'web', setupCompleted: true }, { userId: owner.id });
  rt.trackUi({ name: 'page_viewed', surface: 'web', path: '/agents' }, { userId: owner.id });
  await rt.flushNow();
  await rt.dispose();
  assert.equal(sent.length, 0);
});

/* ── Snapshot ───────────────────────────────────────────────────────────── */

test('the version recorded at start survives the later writes of telemetry.json', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-v2-version-'));
  const run = async (): Promise<Payload[]> => {
    const { sent, fetch } = recorder();
    const rt = startTelemetry({
      env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, fetch, home,
      preference: { configValue: () => undefined, stored: () => null }, collector: noMission, intervalMs: 60_000,
    });
    // An opened day is written from the in-memory state, after the start recorded the version.
    rt.trackUi({ name: 'app_opened', surface: 'web', setupCompleted: true }, { userId: owner.id });
    await rt.flushNow();
    await rt.dispose();
    return sent;
  };
  const file = join(home, 'telemetry.json');
  await run();
  const recorded = (JSON.parse(readFileSync(file, 'utf8')) as { lastVersion: string | null }).lastVersion;
  assert.ok(recorded, 'lastVersion is still on disk after the opened day was saved');
  const { resetReportedStartsForTests } = await import('./runtime.js');
  resetReportedStartsForTests();
  const again = await run();
  assert.ok(!again.some((p) => p.name === 'app_updated'), 'same version: no update');
});

test('the installation snapshot goes once a day, in counts and classes only', async () => {
  let clock = Date.parse('2026-11-03T09:00:00Z');
  const { rt, sent } = start({ now: () => clock, intervalMs: 15 });
  await new Promise((r) => setTimeout(r, 80));
  await rt.flushNow();
  const first = sent.filter((p) => p.name === 'installation_snapshot');
  assert.equal(first.length, 1);
  const props = first[0]!.properties;
  assert.ok(typeof props.ram_class === 'string' && typeof props.cpu_class === 'string');
  assert.equal(props.accounts, 2);
  for (const [key, value] of Object.entries(props)) {
    if (['ram_class', 'cpu_class', 'backends', 'surface', 'app_version', 'platform', 'arch', 'license_tier', 'install_age'].includes(key)) continue;
    assert.equal(typeof value, 'number', key);
  }
  clock += 24 * 3_600_000;
  await new Promise((r) => setTimeout(r, 60));
  await rt.flushNow();
  await rt.dispose();
  assert.equal(sent.filter((p) => p.name === 'installation_snapshot').length, 2, 'the next day has its own');
  assert.ok(!JSON.stringify(sent).includes(MARKER));
});

test('every section of the app is on the closed list (a new page needs its entry)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { PAGE_SECTIONS } = await import('./features.js');
  const appDir = new URL('../../../../app/src/app/', import.meta.url);
  const sections = new Set<string>();
  for (const dir of [appDir, new URL('(main)/', appDir)]) {
    for (const entry of readdirSync(dir)) {
      if (!statSync(new URL(entry, dir)).isDirectory() || /^[([]/.test(entry) || entry === 'api') continue;
      sections.add(entry);
    }
  }
  const pluginsDir = new URL('../../../../app/src/plugins-client/', import.meta.url);
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir)) {
      const url = new URL(entry, dir);
      if (statSync(url).isDirectory()) { walk(new URL(`${entry}/`, dir)); continue; }
      if (!/\.tsx?$/.test(entry) || entry.includes('.test.')) continue;
      for (const m of readFileSync(url, 'utf8').matchAll(/route: ['"]\/([a-z][a-z0-9-]*)/g)) sections.add(m[1]!);
    }
  };
  walk(pluginsDir);
  const missing = [...sections].filter((s) => !(PAGE_SECTIONS as readonly string[]).includes(s));
  assert.deepEqual(missing, []);
});

test('every API area of the product is on the closed list (a new one needs its entry)', async () => {
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const { API_AREAS } = await import('./features.js');
  const root = new URL('../../', import.meta.url);
  const areas = new Set<string>();
  const walk = (dir: URL): void => {
    for (const entry of readdirSync(dir)) {
      const url = new URL(entry, dir);
      if (statSync(url).isDirectory()) { walk(new URL(`${entry}/`, dir)); continue; }
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      for (const m of readFileSync(url, 'utf8').matchAll(/\.(?:get|post|put|patch|delete|all|use)\(\s*'\/api\/([a-z][a-z0-9-]*)/g)) areas.add(m[1]!);
    }
  };
  walk(root);
  assert.ok(areas.size > 50);
  assert.deepEqual([...areas].filter((a) => !(API_AREAS as readonly string[]).includes(a)), []);
});

test('a subscription account counts as its backend, the account never leaves', async () => {
  const { backendValue, modelValue } = await import('./events.js');
  const { builtinProviderIds } = await import('../../backends/builtin-declarations.js');
  const product = builtinProviderIds()[0]!;
  assert.equal(backendValue(`${product}@${MARKER}`), product);
  assert.equal(backendValue(`${MARKER}@x`), 'other');
  const seen: string[] = [];
  modelValue(`${product}@${MARKER}`, 'some-model', (backend) => { seen.push(backend); return true; });
  assert.deepEqual(seen, [product]);
});

test('a server error is reduced to a closed cause; its text never leaves', async () => {
  const { causeOf } = await import('./features.js');
  assert.deepEqual(causeOf(503, null, 'oauth/usage 429', null), { cause: 'upstream_rate_limited', upstreamStatus: 429 });
  assert.deepEqual(causeOf(502, null, `GitHub answered (401) for ${MARKER}`, null), { cause: 'upstream_unauthorized', upstreamStatus: 401 });
  assert.deepEqual(causeOf(500, null, 'upstream 503: busy', null), { cause: 'upstream_error', upstreamStatus: 503 });
  assert.deepEqual(causeOf(500, null, `open /home/${MARKER}/db`, 'SQLITE_BUSY'), { cause: 'db_locked' });
  assert.deepEqual(causeOf(500, null, 'spawn some-cli ENOENT', null), { cause: 'cli_missing' });
  assert.deepEqual(causeOf(500, null, 'connect ECONNREFUSED 127.0.0.1:9', null), { cause: 'network' });
  assert.deepEqual(causeOf(500, null, 'The operation was aborted due to timeout', null), { cause: 'timeout' });
  assert.deepEqual(causeOf(500, null, 'Claude Code session expired; run /login', null), { cause: 'not_signed_in' });
  assert.deepEqual(causeOf(500, 'internal_error', `boom at /home/${MARKER}`, null), { cause: 'server_error' });
  assert.deepEqual(causeOf(409, 'user_limit', 'oauth/usage 429', null), { cause: 'user_limit' }, 'a client error keeps its own code');
  assert.deepEqual(causeOf(500, null, 'line 4123 of a file', null), { cause: 'server_error' }, 'a number that is not an HTTP status is ignored');
});

test('requests: a provider refusal and a thrown error each come out as a precise cause', async () => {
  const { routeErrorHandler } = await import('../../kernel/async-routes.js');
  const { rt, sent } = start();
  const app = express();
  app.use((req, _res, next) => { req.auth = { kind: 'session', user: owner, isSuperadmin: true }; next(); });
  app.use(createRequestObserver());
  app.get('/api/usage', (_req, res) => { res.status(503).json({ backend: `claude@${MARKER}`, error: 'oauth/usage 429' }); });
  const router = express.Router();
  router.post('/api/missions/:id/compact', () => {
    throw Object.assign(new Error(`database is locked at /home/${MARKER}/timon.db`), { code: 'SQLITE_BUSY' });
  });
  app.use((req, res, next) => router(req, res, routeErrorHandler('test', req, res, next)));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const errors = console.error;
  console.error = () => {};
  try {
    assert.equal((await fetch(`${base}/api/usage?backend=x`)).status, 503);
    assert.equal((await fetch(`${base}/api/missions/${MARKER}/compact`, { method: 'POST' })).status, 500);
    await new Promise((r) => setTimeout(r, 30));
    await rt.flushNow();
  } finally {
    console.error = errors;
    server.close();
    await rt.dispose();
  }
  const failed = sent.filter((p) => p.name === 'operation_failed').map((p) => p.properties);
  assert.deepEqual(failed.map((p) => [p.area, p.cause_code, p.upstream_status]), [
    ['usage', 'upstream_rate_limited', 429],
    ['missions', 'db_locked', undefined],
  ]);
  assert.ok(!JSON.stringify(sent).includes(MARKER), 'no text of the error reaches a payload');
});

/* ── v3: crashes, quotas, prompts, tasks, milestones, cohorts ───────────── */

test('the previous run is read back: first, clean, error, or unknown when nothing was recorded', async () => {
  const { loadTelemetryState, saveTelemetryState } = await import('./state.js');
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-exit-'));
  const startIn = async (): Promise<unknown> => {
    const { sent, fetch } = recorder();
    const rt = startTelemetry({
      env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, fetch, home,
      preference: { configValue: () => undefined, stored: () => null }, collector: noMission, intervalMs: 60_000,
    });
    await rt.flushNow();
    await rt.dispose();
    return sent.find((p) => p.name === 'app_started')?.properties.previous_exit;
  };
  const { features } = { features: await import('./features.js') };
  assert.ok(features.PREVIOUS_EXITS.includes('unknown'));
  // A fresh installation.
  const runtime = await import('./runtime.js');
  const reset = (runtime as unknown as { resetReportedStartsForTests?: () => void }).resetReportedStartsForTests;
  assert.equal(typeof reset, 'function');
  reset!();
  assert.equal(await startIn(), 'first');
  assert.equal(loadTelemetryState(home).running, true, 'marked running until it exits');
  for (const [state, expected] of [
    [{ running: false, lastExitCode: 0 }, 'clean'],
    [{ running: false, lastExitCode: 1 }, 'error'],
    [{ running: true, lastExitCode: null }, 'unknown'],
  ] as const) {
    saveTelemetryState({ ...loadTelemetryState(home), ...state }, home);
    reset!();
    assert.equal(await startIn(), expected, JSON.stringify(state));
  }
});

test('collector: quota reached once per window, prompts with their wait, review tasks with their verdict', async () => {
  const { TelemetryCollector } = await import('./collector.js');
  let clock = 1_000_000;
  const emitted: [string, Record<string, unknown>][] = [];
  const milestones: string[] = [];
  const collector = new TelemetryCollector({
    missionFacts: () => ({ backend: 'claude', model: 'default', origin: 'user', child: false, channel: 'external' }),
    taskFacts: () => ({ type: 'review', pipeline: 'full', status: 'DONE', createdAt: clock - 20 * 60_000, doneComment: `verdict: changes_requested\n${MARKER}`, merged: false }),
    now: () => clock,
    milestone: (m) => milestones.push(m),
  }, (name, props) => emitted.push([name, props]));
  const limit = { type: 'rate_limit_event', payload: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2_000_000 } } };
  collector.handle({ kind: 'event', missionId: 'm', type: limit.type, timestamp: clock, payload: limit.payload });
  collector.handle({ kind: 'event', missionId: 'm', type: limit.type, timestamp: clock, payload: limit.payload });
  collector.handle({ kind: 'turn_started', missionId: 'm', at: clock });
  collector.handle({ kind: 'event', missionId: 'm', type: 'permission_request', timestamp: clock, payload: { id: 'p1', tool_name: 'Bash', input: { command: `rm -rf /home/${MARKER}` } } });
  collector.handle({ kind: 'event', missionId: 'm', type: 'permission_request', timestamp: clock, payload: { id: 'q1', tool_name: 'ask_user', input: { form: { kind: 'series_plan' } } } });
  clock += 45_000;
  collector.handle({ kind: 'event', missionId: 'm', type: 'permission_resolved', timestamp: clock, payload: { id: 'p1', behavior: 'deny', origin: 'user_click' } });
  clock += 30 * 60_000;
  collector.handle({ kind: 'event', missionId: 'm', type: 'permission_expired', timestamp: clock, payload: { id: 'q1' } });
  collector.handle({ kind: 'turn_complete', missionId: 'm', outcome: 'completed' });
  collector.handle({ kind: 'task_updated', taskId: 't', changed: ['status'] } as never);
  const names = emitted.map(([n]) => n);
  assert.equal(names.filter((n) => n === 'quota_reached').length, 1, 'one report per window, not one per event');
  assert.deepEqual(emitted.find(([n]) => n === 'quota_reached')![1], { backend: 'claude', window: 'five_hour', kind: 'rate_limit' });
  assert.equal(emitted.find(([n]) => n === 'turn_started')![1].channel, 'external');
  const prompts = emitted.filter(([n]) => n === 'user_prompt_answered').map(([, p]) => p);
  assert.deepEqual(prompts, [
    { kind: 'permission', decision: 'deny', resolved_by: 'user', wait: '10s-1m', tool: 'Bash' },
    { kind: 'kanban_plan', decision: 'expired', resolved_by: 'system', wait: '10-60m' },
  ]);
  const task = emitted.find(([n]) => n === 'task_completed')![1];
  assert.deepEqual(task, { type: 'review', pipeline: 'full', duration: '10-60m', verdict: 'changes_requested', merged: false });
  assert.deepEqual(milestones, ['first_turn_completed', 'first_task_done']);
  for (const [name, props] of emitted) assert.ok(validateEvent(name, props), `${name} passes the catalogue`);
  assert.ok(!JSON.stringify(emitted).includes(MARKER));
});

test('milestones are sent once per installation; every event carries its cohort', async () => {
  let clock = Date.parse('2026-11-03T09:00:00Z');
  const { rt, sent } = start({ now: () => clock });
  rt.trackUi({ name: 'page_viewed', surface: 'web', path: '/' }, { userId: owner.id });
  clock += 3 * 86_400_000;
  rt.trackUi({ name: 'page_viewed', surface: 'web', path: '/' }, { userId: owner.id });
  rt.trackUi({ name: 'app_opened', surface: 'web', setupCompleted: true, loadMs: 2_400 }, { userId: owner.id });
  rt.trackUi({ name: 'ui_error', surface: 'web', path: `/agents/${MARKER}` }, { userId: owner.id });
  await rt.flushNow();
  await rt.dispose();
  const pages = sent.filter((p) => p.name === 'page_viewed').map((p) => p.properties.install_age);
  assert.deepEqual(pages, ['0', '2-7']);
  assert.equal(sent.find((p) => p.name === 'app_opened')!.properties.load, '1-3s');
  assert.equal(sent.find((p) => p.name === 'ui_error')!.properties.section, 'agents');
  assert.ok(!JSON.stringify(sent).includes(MARKER));
});

/* ── v4: install_age_days on turn_completed ──────────────────────────────── */

test('turn_completed carries the whole UTC days since the identity was created, and only that', async () => {
  const { bus } = await import('../../bus.js');
  const { loadTelemetryState } = await import('./state.js');
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-age-'));
  // 23:30 UTC: the next turn, an hour later, is already day 1.
  const created = Date.parse('2026-11-03T23:30:00Z');
  let clock = created;
  const { sent, fetch } = recorder();
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, fetch, home, now: () => clock,
    preference: { configValue: () => undefined, stored: () => null },
    collector: { missionFacts: () => ({ backend: 'claude', model: 'default', origin: 'user', child: false }), taskFacts: () => null },
    intervalMs: 60_000,
  });
  const turnAt = (at: number, mission: string): void => {
    clock = at;
    bus.publish({ kind: 'turn_started', missionId: mission, at });
    bus.publish({ kind: 'turn_complete', missionId: mission, outcome: 'completed' });
  };
  turnAt(created + 10 * 60_000, 'age-same-day');
  turnAt(created + 60 * 60_000, 'age-next-day');
  turnAt(created + 7 * 86_400_000, 'age-day-7');
  await rt.flushNow();
  await rt.dispose();
  assert.equal(loadTelemetryState(home).createdAt, new Date(created).toISOString(), 'drawn with the identity (by app_started), on the injected clock');
  const turns = sent.filter((p) => p.name === 'turn_completed').map((p) => p.properties);
  // Created 23:30; a turn at 23:40 is day 0, at 00:30 the next UTC day 1, a week later 7.
  assert.deepEqual(turns.map((p) => p.install_age_days), [0, 1, 7]);
  assert.deepEqual(Object.keys(turns[0]!).filter((k) => !GLOBAL_KEYS.has(k)).sort(),
    ['backend', 'duration_ms', 'install_age_days', 'model', 'origin', 'status'], 'no other property was added');
});

test('install_age_days is left out for an identity written before its creation date was kept', async () => {
  const { bus } = await import('../../bus.js');
  const { telemetryStatePath } = await import('./state.js');
  const { writeFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-age-old-'));
  const legacy = { installId: '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b', lastVersion: '0.1.5', firstSeenDay: '2026-10-01' };
  writeFileSync(telemetryStatePath(home), JSON.stringify(legacy));
  const { sent, fetch } = recorder();
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, fetch, home,
    preference: { configValue: () => undefined, stored: () => null },
    collector: { missionFacts: () => ({ backend: 'claude', model: 'default', origin: 'user', child: false }), taskFacts: () => null },
    intervalMs: 60_000,
  });
  bus.publish({ kind: 'turn_started', missionId: 'age-legacy', at: Date.now() });
  bus.publish({ kind: 'turn_complete', missionId: 'age-legacy', outcome: 'completed' });
  await rt.flushNow();
  await rt.dispose();
  const turn = sent.find((p) => p.name === 'turn_completed')!;
  assert.equal(turn.profileId, legacy.installId, 'the same identity, not a new one');
  assert.equal('install_age_days' in turn.properties, false, 'unknown, so not sent');
  const stored = JSON.parse(readFileSync(telemetryStatePath(home), 'utf8')) as { createdAt?: unknown };
  assert.ok(stored.createdAt === undefined || stored.createdAt === null, 'no creation date invented afterwards');
});

test('install_age_days counts UTC calendar days and refuses what is not a day count', async () => {
  const { installAgeDaysOf } = await import('./features.js');
  const at = Date.parse('2026-11-03T12:00:00Z');
  assert.equal(installAgeDaysOf(at, at), 0);
  assert.equal(installAgeDaysOf(at, Date.parse('2026-11-03T23:59:59Z')), 0);
  assert.equal(installAgeDaysOf(at, Date.parse('2026-11-04T00:00:00Z')), 1);
  assert.equal(installAgeDaysOf(at, at + 30 * 86_400_000), 30);
  assert.equal(installAgeDaysOf(at, at - 86_400_000), 0, 'a clock moved back never gives a negative age');
  const base = { backend: 'claude', model: 'default', origin: 'user', status: 'completed', duration_ms: 1 };
  assert.ok(validateEvent('turn_completed', { ...base, install_age_days: 7 }));
  assert.ok(validateEvent('turn_completed', base), 'the property is optional');
  assert.equal(validateEvent('turn_completed', { ...base, install_age_days: -1 }), null);
  assert.equal(validateEvent('turn_completed', { ...base, install_age_days: 1.5 }), null);
  assert.equal(validateEvent('turn_completed', { ...base, install_age_days: '7' }), null);
  assert.equal(validateEvent('turn_completed', { ...base, install_created_at: '2026-11-03' }), null, 'strict: no date property');
});
