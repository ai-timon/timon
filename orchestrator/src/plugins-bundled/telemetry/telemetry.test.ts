/**
 * `@timon/telemetry` without the network: the preference and its sources, the
 * anonymous identity, where events may go, the closed catalogue, the
 * collector, and the switch-off sequence. Requests go to an injected `fetch`
 * that records them; nothing here can reach the production endpoint, and a
 * test asserts the destination is `null` under the test runner.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-telemetry-unit-'));

const { parseToggle, resolvePreference } = await import('./preference.js');
const { loadTelemetryState, telemetryStatePath } = await import('./state.js');
const { OPENPANEL_API_URL, TelemetryTransport, captureUrl, systemToken, telemetryDestination, userAgentOf } = await import('./transport.js');
const {
  backendValue, licenseTierValue, modelValue, originValue, toolValue, validateEvent, validateGlobals,
} = await import('./events.js');
const { TelemetryCollector } = await import('./collector.js');
const { startTelemetry } = await import('./runtime.js');
const { TimonConfigSchema } = await import('../../config/schema.js');
const { loadConfig } = await import('../../config/load.js');

const CAPTURE = 'http://127.0.0.1:9';
type Sent = { url: string; body: { payload: { name: string; profileId: string; properties: Record<string, unknown> } } };

function recorder(): { sent: Sent[]; fetch: typeof fetch } {
  const sent: Sent[] = [];
  const fake = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Sent['body'] });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  return { sent, fetch: fake };
}

const noMission = { missionFacts: () => null, taskFacts: () => null };

/* ── Preference ─────────────────────────────────────────────────────────── */

test('a missing preference means sharing is on', () => {
  const pref = resolvePreference({ env: {}, configValue: () => undefined, stored: () => null });
  assert.deepEqual(pref, { enabled: true, source: 'default', malformed: false });
});

test('a malformed preference turns sharing off, whichever source holds it', () => {
  assert.deepEqual(resolvePreference({ env: { TIMON_TELEMETRY: 'maybe' }, configValue: () => true, stored: () => '1' }),
    { enabled: false, source: 'env', malformed: true });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => 'perhaps', stored: () => '1' }),
    { enabled: false, source: 'config', malformed: true });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => 2, stored: () => null }),
    { enabled: false, source: 'config', malformed: true });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => { throw new Error('unreadable'); }, stored: () => '1' }),
    { enabled: false, source: 'config', malformed: true });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => undefined, stored: () => '{"on":1}' }),
    { enabled: false, source: 'settings', malformed: true });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => undefined, stored: () => { throw new Error('db'); } }),
    { enabled: false, source: 'settings', malformed: true });
});

test('resolution order: environment, then config, then the settings row, then the default', () => {
  assert.equal(resolvePreference({ env: { TIMON_TELEMETRY: '0' }, configValue: () => true, stored: () => '1' }).source, 'env');
  assert.equal(resolvePreference({ env: { TIMON_TELEMETRY: '0' }, configValue: () => true }).enabled, false);
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => false, stored: () => '1' }),
    { enabled: false, source: 'config', malformed: false });
  assert.deepEqual(resolvePreference({ env: {}, configValue: () => undefined, stored: () => '0' }),
    { enabled: false, source: 'settings', malformed: false });
  // An empty variable is unset, as for every other TIMON_* key.
  assert.equal(resolvePreference({ env: { TIMON_TELEMETRY: '' }, configValue: () => undefined, stored: () => null }).enabled, true);
  assert.equal(parseToggle('YES'), true);
  assert.equal(parseToggle(' off '), false);
  assert.equal(parseToggle(null), null);
});

test('telemetry.enabled in the real configuration schema: a value of any shape is accepted, and read as off', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-telemetry-config-'));
  for (const value of [null, [], [true], {}, { on: true }, 'maybe', 2]) {
    const parsed = TimonConfigSchema.safeParse({ telemetry: { enabled: value } });
    assert.equal(parsed.success, true, `${JSON.stringify(value)} must not invalidate the whole configuration`);
    // Through the loader too: the file is read, the rest of it applies.
    const file = join(dir, 'timon.config.json');
    writeFileSync(file, JSON.stringify({ edition: 'lite', telemetry: { enabled: value } }));
    const cfg = loadConfig(file, { readonly: true });
    assert.equal(cfg.edition, 'lite');
    assert.deepEqual(resolvePreference({ env: {}, configValue: () => cfg.telemetry.enabled, stored: () => '1' }),
      { enabled: false, source: 'config', malformed: true }, JSON.stringify(value));
  }
  const yes = TimonConfigSchema.parse({ telemetry: { enabled: true } });
  assert.equal(resolvePreference({ env: {}, configValue: () => yes.telemetry.enabled, stored: () => '0' }).enabled, true);
  const unset = TimonConfigSchema.parse({});
  assert.equal(unset.telemetry.enabled, undefined);
  assert.equal(resolvePreference({ env: {}, configValue: () => unset.telemetry.enabled, stored: () => null }).enabled, true);
});

/* ── Identity ───────────────────────────────────────────────────────────── */

test('the installation id is a random UUID, stable from one start to the next', () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-id-'));
  const first = loadTelemetryState(home);
  const second = loadTelemetryState(home);
  assert.match(first.installId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(second.installId, first.installId);
  // Another installation draws another one: nothing about the machine goes in.
  assert.notEqual(loadTelemetryState(mkdtempSync(join(tmpdir(), 'timon-telemetry-id-'))).installId, first.installId);
  writeFileSync(telemetryStatePath(home), 'not json');
  assert.notEqual(loadTelemetryState(home).installId, first.installId, 'a damaged file is replaced, not trusted');
});

/* ── Destination ────────────────────────────────────────────────────────── */

test('no destination under the test runner, a source checkout, or without a loopback capture URL', () => {
  // The suite itself runs under the test runner: even a "packaged" daemon sends nowhere.
  assert.equal(telemetryDestination(process.env, true), null);
  assert.equal(telemetryDestination({ NODE_ENV: 'test' }, true), null);
  assert.equal(telemetryDestination({}, false), null);
  assert.equal(telemetryDestination({ TIMON_TELEMETRY_CAPTURE_URL: 'https://analytics.timon-ai.com/api' }, false), null);
  assert.equal(captureUrl('http://192.168.1.4:8080'), null);
  assert.equal(captureUrl('http://user:pw@127.0.0.1:8080'), null);
  assert.equal(captureUrl('file:///tmp/x'), null);
  assert.equal(telemetryDestination({ TIMON_TELEMETRY_CAPTURE_URL: 'http://127.0.0.1:47321/' }, false), 'http://127.0.0.1:47321');
  // A packaged daemon of a released build outside a test ignores the capture URL.
  assert.equal(telemetryDestination({ TIMON_TELEMETRY_CAPTURE_URL: 'http://127.0.0.1:47321' }, true, 'beta'), OPENPANEL_API_URL);
  assert.equal(telemetryDestination({}, true, 'stable'), OPENPANEL_API_URL);
  // The marker alone is not enough: a source checkout (no build stamp) never reaches production.
  assert.equal(telemetryDestination({}, true, 'dev'), null);
  assert.equal(telemetryDestination({ TIMON_TELEMETRY_CAPTURE_URL: 'http://127.0.0.1:47321' }, true, 'dev'), 'http://127.0.0.1:47321');
});

test('the timer sends one wave at a time; a silent network ends the wave, never piles up', async () => {
  let started = 0;
  const pending: (() => void)[] = [];
  const hanging = ((_url: string | URL | Request, init?: RequestInit) => {
    started++;
    return new Promise<Response>((_resolve, reject) => {
      const fail = () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
      init?.signal?.addEventListener('abort', fail);
      pending.push(fail);
    });
  }) as typeof fetch;
  const transport = new TelemetryTransport({ apiUrl: CAPTURE, sdkVersion: '0.1.6', fetch: hanging, timeoutMs: 60_000 });
  for (let i = 0; i < 5; i++) transport.enqueue({ type: 'track', payload: { name: 'app_started', profileId: 'p', properties: {} } });
  const first = transport.tick();
  void transport.tick();
  void transport.tick();
  assert.equal(started, 1, 'ticks while a wave is in flight send nothing more');
  pending.shift()!();
  await first;
  assert.equal(started, 1, 'the failed request ends its wave');
  assert.equal(transport.size, 0, 'the rest of the wave is dropped with it');
});

test('cancel() stops the wave in flight: its request is aborted, the rest never starts, the next wave leaves at once', async () => {
  const started: string[] = [];
  const aborted: string[] = [];
  const release: (() => void)[] = [];
  const slow = ((_url: string | URL | Request, init?: RequestInit) => {
    const name = (JSON.parse(String(init?.body)) as Sent['body']).payload.name;
    started.push(name);
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted.push(name); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      release.push(() => resolve(new Response('{}', { status: 200 })));
    });
  }) as typeof fetch;
  const transport = new TelemetryTransport({ apiUrl: CAPTURE, sdkVersion: '0.1.6', fetch: slow, timeoutMs: 60_000 });
  const item = (name: string) => ({ type: 'track' as const, payload: { name, profileId: 'p', properties: {} } });
  for (const name of ['a', 'b', 'c']) transport.enqueue(item(name));
  const old = transport.tick();
  assert.deepEqual(started, ['a']);
  transport.cancel();
  transport.enqueue(item('goodbye'));
  const next = transport.tick();
  assert.deepEqual(started, ['a', 'goodbye'], 'the new wave does not wait behind the cancelled one');
  assert.deepEqual(aborted, ['a']);
  for (const go of release) go();
  await Promise.all([old, next]);
  await transport.flush();
  assert.deepEqual(started, ['a', 'goodbye'], 'nothing of the cancelled wave leaves after it');
});

test('only a person\'s events name the system in the user agent, in the tokens browsers use', async () => {
  assert.equal(systemToken('win32', 'x64'), 'Windows NT 10.0; Win64; x64');
  assert.equal(systemToken('win32', 'arm64'), 'Windows NT 10.0; ARM64');
  assert.equal(systemToken('darwin', 'arm64'), 'Macintosh; Intel Mac OS X 10_15_7');
  assert.equal(systemToken('linux', 'x64'), 'X11; Linux x86_64');
  assert.equal(systemToken('linux', 'arm64'), 'X11; Linux aarch64');
  assert.equal(systemToken('freebsd', 'x64'), null);
  assert.equal(userAgentOf('0.1.7', true, 'X11; Linux x86_64'), 'Timon/0.1.7 (X11; Linux x86_64)');
  assert.equal(userAgentOf('0.1.7', false, 'X11; Linux x86_64'), 'Timon/0.1.7');
  assert.equal(userAgentOf('0.1.7', true, null), 'Timon/0.1.7', 'an unknown system stays a bare agent');

  const agents: string[] = [];
  const capture = (async (_url: string | URL | Request, init?: RequestInit) => {
    agents.push(String((init?.headers as Record<string, string>)['user-agent']));
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const transport = new TelemetryTransport({ apiUrl: CAPTURE, sdkVersion: '0.1.7', fetch: capture });
  const item = { type: 'track' as const, payload: { name: 'page_viewed', profileId: 'p', properties: {} } };
  transport.enqueue(item, { person: true });
  transport.enqueue(item);
  await transport.flush();
  assert.equal(agents.length, 2);
  assert.equal(agents[0], userAgentOf('0.1.7', true));
  assert.equal(agents[1], 'Timon/0.1.7');
});

/* ── Catalogue ──────────────────────────────────────────────────────────── */

test('the catalogue is closed: unknown events, extra properties and free text are dropped', () => {
  assert.equal(validateEvent('page_viewed', {}), null);
  assert.equal(validateEvent('onboarding_step', { step: 'account', action: 'completed', note: 'x' }), null);
  assert.equal(validateEvent('onboarding_step', { step: 'my secret step', action: 'completed' }), null);
  assert.equal(validateEvent('browser_action', { kind: 'recording', action: 'Visited https://bank.example' }), null);
  assert.deepEqual(validateEvent('onboarding_step', { step: 'account', action: 'completed' }), { step: 'account', action: 'completed' });
  assert.equal(validateEvent('token_usage', { backend: 'claude', model: 'opus', origin: 'user', input_tokens: -1 }), null);
  assert.equal(validateGlobals({ surface: 'daemon', app_version: '0.1.6', platform: 'linux', arch: 'x64', event_schema_version: 4, license_tier: 'beta' })?.surface, 'daemon');
  assert.equal(validateGlobals({ surface: 'daemon', app_version: 'dev build', platform: 'linux', arch: 'x64', event_schema_version: 4, license_tier: 'beta' }), null);
});

test('names that a person chose map to other', () => {
  assert.equal(toolValue('Bash'), 'Bash');
  assert.equal(toolValue('mcp__timon__kanban_add'), 'mcp__timon__kanban_add');
  assert.equal(toolValue('mcp__timon-browser__click'), 'mcp__timon-browser__click');
  assert.equal(toolValue('mcp__acme-crm__export_customers'), 'other');
  assert.equal(toolValue('MyPrivateTool'), 'other');
  assert.equal(backendValue('claude'), 'claude');
  assert.equal(backendValue('my-llm-proxy'), 'other');
  const catalog = (b: string, m: string) => b === 'claude' && m === 'opus';
  assert.equal(modelValue('claude', 'opus', catalog), 'opus');
  assert.equal(modelValue('claude', 'acme-finetune', catalog), 'other');
  assert.equal(modelValue('my-llm-proxy', 'opus', catalog), 'other');
  assert.equal(modelValue('claude', null, catalog), 'default');
  assert.equal(licenseTierValue({ status: 'valid', planId: 'beta-1-year' }), 'beta');
  assert.equal(licenseTierValue({ status: 'valid', planId: 'internal' }), 'internal');
  assert.equal(licenseTierValue({ status: 'valid', planId: 'acme-corp-deal' }), 'other');
  assert.equal(licenseTierValue({ status: 'unlicensed', localFree: true }), 'free');
  assert.equal(licenseTierValue({ status: 'unlicensed' }), 'unlicensed');
  assert.equal(originValue({ source_channel: null }), 'user');
  assert.equal(originValue({ source_channel: 'dispatcher', task_id: 't' }), 'task');
  assert.equal(originValue({ source_channel: 'wake' }), 'agent');
  assert.equal(originValue({ source_channel: 'plugin:acme' }), 'plugin');
  assert.equal(originValue({ source_channel: 'acme-inbox' }), 'other');
});

/* ── Collector ──────────────────────────────────────────────────────────── */

test('a turn is counted once, with its tools tallied and its tokens as numbers', () => {
  const out: { name: string; props: Record<string, unknown> }[] = [];
  let clock = 1_000;
  const c = new TelemetryCollector({
    missionFacts: () => ({ backend: 'claude', model: 'opus', origin: 'user', child: false }),
    taskFacts: () => null,
    now: () => clock,
  }, (name, props) => out.push({ name, props }));
  c.handle({ kind: 'turn_started', missionId: 'm1', at: 1_000 });
  c.handle({ kind: 'turn_started', missionId: 'm1', at: 1_200 });
  c.handle({ kind: 'event', missionId: 'm1', type: 'assistant', timestamp: 1, payload: { message: { content: [
    { type: 'text', text: 'hello' },
    { type: 'tool_use', name: 'Bash', input: { command: 'cat /home/someone/secret' } },
    { type: 'tool_use', name: 'Bash', input: {} },
    { type: 'tool_use', name: 'mcp__acme__thing', input: {} },
  ] } } });
  c.handle({ kind: 'event', missionId: 'm1', type: 'result', timestamp: 2, payload: { result: 'done', usage: { input_tokens: 120, output_tokens: 30 } } });
  clock = 4_500;
  c.handle({ kind: 'turn_complete', missionId: 'm1', outcome: 'completed' });
  c.handle({ kind: 'turn_complete', missionId: 'm1', outcome: 'completed' });
  assert.deepEqual(out.map((e) => e.name), ['turn_started', 'token_usage', 'turn_completed', 'tool_used', 'tool_used']);
  assert.deepEqual(out[1]!.props, { backend: 'claude', model: 'opus', origin: 'user', input_tokens: 120, output_tokens: 30 });
  assert.deepEqual(out[2]!.props, { backend: 'claude', model: 'opus', origin: 'user', status: 'completed', duration_ms: 3_500 });
  assert.deepEqual(out.slice(3).map((e) => e.props), [
    { backend: 'claude', tool: 'Bash', count: 2 },
    { backend: 'claude', tool: 'other', count: 1 },
  ]);
});

test('plugins: the first list is a baseline, then installs, toggles and removals; a third-party id never leaves', () => {
  const out: Record<string, unknown>[] = [];
  const c = new TelemetryCollector({ ...noMission, now: () => 0 }, (_n, props) => out.push(props));
  const p = (id: string, state: string, source: 'bundled' | 'third-party', builtin = false) =>
    ({ id, state, source, builtin }) as never;
  c.handle({ kind: 'plugins_changed', plugins: [p('@timon/kanban', 'active', 'bundled')] });
  assert.equal(out.length, 0);
  c.handle({ kind: 'plugins_changed', plugins: [p('@timon/kanban', 'disabled', 'bundled'), p('acme-secret-crm', 'active', 'third-party'), p('provider-claude', 'active', 'third-party', true)] });
  c.handle({ kind: 'plugins_changed', plugins: [p('@timon/kanban', 'active', 'bundled')] });
  assert.deepEqual(out, [
    { action: 'disable', plugin: '@timon/kanban', source: 'bundled' },
    { action: 'install', plugin: 'third_party', source: 'third_party' },
    { action: 'install', plugin: 'provider-claude', source: 'builtin' },
    { action: 'enable', plugin: '@timon/kanban', source: 'bundled' },
    { action: 'remove', plugin: 'third_party', source: 'third_party' },
    { action: 'remove', plugin: 'provider-claude', source: 'builtin' },
  ]);
});

test('plugins: the loader\'s list (packages only) says nothing about the bundled modules', () => {
  const out: Record<string, unknown>[] = [];
  const c = new TelemetryCollector({ ...noMission, now: () => 0 }, (_n, props) => out.push(props));
  const p = (id: string, state: string, source: 'bundled' | 'third-party') => ({ id, state, source, builtin: false }) as never;
  c.seedPlugins([p('@timon/kanban', 'active', 'bundled'), p('acme', 'active', 'third-party')]);
  c.seedPlugins([]);
  c.handle({ kind: 'plugins_changed', plugins: [p('acme', 'active', 'third-party'), p('other-pkg', 'active', 'third-party')] });
  c.handle({ kind: 'plugins_changed', plugins: [p('@timon/kanban', 'active', 'bundled'), p('acme', 'active', 'third-party'), p('other-pkg', 'active', 'third-party')] });
  c.handle({ kind: 'plugins_changed', plugins: [p('other-pkg', 'active', 'third-party')] });
  assert.deepEqual(out, [
    { action: 'install', plugin: 'third_party', source: 'third_party' },
    { action: 'remove', plugin: 'third_party', source: 'third_party' },
  ]);
});

test('licence: an activation the bus never announced is seen on the next tick, once', () => {
  const out: Record<string, unknown>[] = [];
  const c = new TelemetryCollector({ ...noMission, now: () => 0 }, (_n, props) => out.push(props));
  c.observeLicense(false, 'missing');
  c.observeLicense(true, null);
  c.observeLicense(true, null);
  c.handle({ kind: 'license_changed', status: 'valid', reason: null, offlineSince: null });
  assert.deepEqual(out, [{ action: 'activated', reason: 'none' }, { action: 'refreshed', reason: 'none' }]);
});

test('licence: activated, refreshed, expired', () => {
  const out: Record<string, unknown>[] = [];
  const c = new TelemetryCollector({ ...noMission, now: () => 0 }, (_n, props) => out.push(props));
  c.setInitialLicense(false);
  c.handle({ kind: 'license_changed', status: 'valid', reason: null, offlineSince: null });
  c.handle({ kind: 'license_changed', status: 'valid', reason: null, offlineSince: null });
  c.handle({ kind: 'license_changed', status: 'unlicensed', reason: 'invalid:fingerprint', offlineSince: null });
  assert.deepEqual(out, [
    { action: 'activated', reason: 'none' },
    { action: 'refreshed', reason: 'none' },
    { action: 'expired', reason: 'invalid' },
  ]);
});

/* ── Runtime ────────────────────────────────────────────────────────────── */

test('TIMON_TELEMETRY=0: nothing is sent, and no identity is drawn', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-off-'));
  const { sent, fetch } = recorder();
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE, TIMON_TELEMETRY: '0' }, packaged: false, home, fetch,
    preference: { configValue: () => undefined, stored: () => null }, collector: noMission,
  });
  assert.equal(rt.active, true);
  rt.track('onboarding_step', { step: 'account', action: 'completed' });
  rt.track('desktop_app_opened', {}, 'desktop');
  await rt.flushNow();
  await rt.dispose();
  assert.equal(sent.length, 0);
  assert.equal(existsSync(telemetryStatePath(home)), false);
});

test('a malformed preference: nothing is sent', async () => {
  const { sent, fetch } = recorder();
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, home: mkdtempSync(join(tmpdir(), 'timon-telemetry-bad-')), fetch,
    preference: { configValue: () => 'not sure', stored: () => null }, collector: noMission,
  });
  rt.track('onboarding_step', { step: 'account', action: 'completed' });
  await rt.flushNow();
  await rt.dispose();
  assert.equal(sent.length, 0);
});

test('without a destination the runtime is inert', async () => {
  const rt = startTelemetry({ env: {}, packaged: false });
  assert.equal(rt.active, false);
  rt.track('onboarding_step', { step: 'account', action: 'completed' });
  await rt.dispose();
});

test('switching off drops the queue and sends exactly one telemetry_preference_changed, then nothing', async () => {
  const { sent, fetch } = recorder();
  let stored: string | null = null;
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, home: mkdtempSync(join(tmpdir(), 'timon-telemetry-switch-')), fetch,
    preference: { configValue: () => undefined, stored: () => stored }, collector: noMission, intervalMs: 3_600_000,
  });
  await rt.flushNow();
  const atStart = sent.length;
  assert.ok(sent.some((s) => s.body.payload.name === 'app_started'));
  rt.track('onboarding_step', { step: 'team', action: 'completed' });
  stored = '0';
  rt.refreshPreference();
  await rt.flushNow();
  rt.track('onboarding_step', { step: 'restart', action: 'completed' });
  rt.refreshPreference();
  await rt.flushNow();
  await rt.dispose();
  const after = sent.slice(atStart);
  assert.equal(after.length, 1, 'the queued event was dropped, nothing follows the goodbye');
  assert.equal(after[0]!.body.payload.name, 'telemetry_preference_changed');
  assert.deepEqual(
    { enabled: after[0]!.body.payload.properties.enabled, source: after[0]!.body.payload.properties.source },
    { enabled: false, source: 'settings' },
  );
});

test('switching off while a wave is in flight: that wave stops, the goodbye leaves right away and alone', async () => {
  const started: string[] = [];
  const aborted: string[] = [];
  const release: (() => void)[] = [];
  let hold = false;
  const fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    const name = (JSON.parse(String(init?.body)) as Sent['body']).payload.name;
    started.push(name);
    if (!hold || name === 'telemetry_preference_changed') return Promise.resolve(new Response('{}', { status: 200 }));
    return new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted.push(name); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); });
      release.push(() => resolve(new Response('{}', { status: 200 })));
    });
  }) as typeof fetch;
  let stored: string | null = null;
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, home: mkdtempSync(join(tmpdir(), 'timon-telemetry-inflight-')), fetch,
    preference: { configValue: () => undefined, stored: () => stored }, collector: noMission, intervalMs: 3_600_000,
  });
  await rt.flushNow();
  const atStart = started.length;
  hold = true;
  for (const step of ['team', 'restart', 'main_agent'] as const) rt.track('onboarding_step', { step, action: 'completed' });
  const wave = rt.flushNow();
  assert.equal(started.length - atStart, 1, 'the first request of the wave is held in flight');
  stored = '0';
  rt.refreshPreference();
  assert.deepEqual(started.slice(atStart), ['onboarding_step', 'telemetry_preference_changed']);
  assert.deepEqual(aborted, ['onboarding_step']);
  for (const go of release) go();
  await wave;
  await rt.flushNow();
  rt.track('onboarding_step', { step: 'team', action: 'completed' });
  await rt.flushNow();
  await rt.dispose();
  assert.deepEqual(started.slice(atStart), ['onboarding_step', 'telemetry_preference_changed'], 'exactly one last event, then nothing');
});

test('the same profileId across two starts, and an update counted once', async () => {
  const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-restart-'));
  writeFileSync(telemetryStatePath(home), JSON.stringify({ installId: '6f1c2b8e-3d4a-4b5c-8d6e-7f8091a2b3c4', lastVersion: '0.0.1' }));
  const ids: string[] = [];
  for (let start = 0; start < 2; start++) {
    const { sent, fetch } = recorder();
    const rt = startTelemetry({
      env: { TIMON_TELEMETRY_CAPTURE_URL: CAPTURE }, packaged: false, home, fetch,
      preference: { configValue: () => undefined, stored: () => null }, collector: noMission,
    });
    await rt.flushNow();
    await rt.dispose();
    ids.push(...sent.map((s) => s.body.payload.profileId));
    const names = sent.map((s) => s.body.payload.name);
    assert.equal(names.includes('app_updated'), start === 0, 'the update is reported by the first start only');
    assert.ok(sent.every((s) => s.url === `${CAPTURE}/track`));
  }
  assert.ok(ids.length >= 2);
  assert.deepEqual([...new Set(ids)], ['6f1c2b8e-3d4a-4b5c-8d6e-7f8091a2b3c4']);
  assert.notEqual(JSON.parse(readFileSync(telemetryStatePath(home), 'utf8')).lastVersion, '0.0.1');
});
