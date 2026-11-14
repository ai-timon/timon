/**
 * Non-leak test, end to end (the model is OpenBot's `analytics-redaction-e2e`).
 *
 * A secret marker is planted everywhere a person writes something: an agent
 * name, a project, an MCP server and its tool, a prompt, a path, a model
 * override, a third-party plugin id, a task title, a tool's input, an answer.
 * The real daemon pieces then run — the bus, the database, the collector and
 * the real HTTP transport, pointed at a local capture server through the
 * capture URL (honoured outside a packaged build only). The test asserts that
 * events DID arrive, that the expected ones are there, and that not one
 * captured byte (URL, headers, body) holds the marker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const MARKER = 'zqleak7f3kmarker';
const home = mkdtempSync(join(tmpdir(), 'timon-telemetry-e2e-'));
process.env.TIMON_HOME = home;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { bus } = await import('../../bus.js');
const GLOBAL_KEYS = new Set(['surface', 'app_version', 'platform', 'arch', 'event_schema_version', 'license_tier', 'install_age', 'account_slot']);
const { dbApi } = await import('../../db.js');
const { onboardingStep } = await import('../../onboarding-events.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { resolvePreference } = await import('./preference.js');
const { setTelemetryRuntime, startTelemetry, clearTelemetryRuntime } = await import('./runtime.js');

type Captured = { url: string; headers: string; body: string };
const captured: Captured[] = [];
const capture = createServer((req: IncomingMessage, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    captured.push({ url: req.url ?? '', headers: JSON.stringify(req.headers), body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{}');
  });
});
capture.listen(0, '127.0.0.1');
await once(capture, 'listening');
const captureUrl = `http://127.0.0.1:${(capture.address() as AddressInfo).port}`;

// An agent whose every field a person typed carries the marker.
const agentName = `acme-${MARKER}-agent`;
const agentDir = join(home, 'agents', agentName);
const secretPath = join(home, `projects-${MARKER}`, 'repo');
mkdirSync(agentDir, { recursive: true });
writeFileSync(join(agentDir, 'config.json'), JSON.stringify({
  backend: 'claude',
  model: `${MARKER}-finetune`,
  cwd: secretPath,
  project: `${MARKER}-project`,
  mcp_servers: { [`${MARKER}-mcp`]: { command: join(secretPath, `${MARKER}-server`) } },
}));
writeFileSync(join(agentDir, 'system-prompt.md'), `You work for ${MARKER}.`);

const missionId = randomUUID();
dbApi.createMission(missionId, agentName, `Read ${secretPath} and email ${MARKER}@example.com`, { channel: 'chat' });
dbApi.setMissionCwdOverride(missionId, secretPath);
dbApi.setMissionLlmOverrides(missionId, 'claude', `${MARKER}-override`);
const taskId = randomUUID();
dbApi.createTask(taskId, `Ship ${MARKER} feature`, agentName, { description: `Touch ${secretPath}`, type: 'code' });

const DAEMON_TOKEN = 'e2e-daemon-token';
const runtime = startTelemetry({
  env: { TIMON_TELEMETRY_CAPTURE_URL: captureUrl },
  packaged: false,
  home,
  intervalMs: 3_600_000,
  preference: { configValue: () => undefined },
});
setTelemetryRuntime(runtime);

const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, () => resolvePreference({ env: {}, configValue: () => undefined }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

test.after(async () => {
  clearTelemetryRuntime(runtime);
  await runtime.dispose();
  server.close();
  capture.close();
});

function plugin(id: string, state: string, source: 'bundled' | 'third-party') {
  return {
    id, pkg: id, version: '1.0.0', source, tier: null, wanted: null, kind: ['behavior'], label: `${MARKER} label`,
    description: `${MARKER} description`, signed: false, signature: null, builtin: false, author: MARKER,
    screenshots: [], cover: null, icon: null, slots: [], route: null, declares: {}, modifies: [], contains: [],
    state, reason: null, error: null, client: null, settings: [], webhooks: [],
  } as never;
}

test('nothing a person wrote reaches the analytics endpoint', async () => {
  assert.equal(runtime.active, true, 'the capture URL is honoured outside a packaged build');

  bus.publish({ kind: 'mission_started', missionId, agent: agentName, channel: 'chat', ownerUserId: null, at: Date.now() });
  bus.publish({ kind: 'turn_started', missionId, at: Date.now() });
  bus.publish({ kind: 'event', missionId, type: 'assistant', timestamp: Date.now(), payload: { message: { content: [
    { type: 'text', text: `Working on ${MARKER}` },
    { type: 'tool_use', id: 't1', name: 'Bash', input: { command: `cat ${secretPath}/${MARKER}.env` } },
    { type: 'tool_use', id: 't2', name: `mcp__${MARKER}-mcp__${MARKER}_tool`, input: { q: MARKER } },
    { type: 'tool_use', id: 't3', name: 'mcp__timon__kanban_add', input: { title: MARKER } },
  ] } } });
  bus.publish({ kind: 'event', missionId, type: 'user', timestamp: Date.now(), payload: { message: { content: [
    { type: 'tool_result', tool_use_id: 't1', content: `SECRET=${MARKER}`, is_error: true },
  ] } } });
  bus.publish({ kind: 'event', missionId, type: 'result', timestamp: Date.now(), payload: {
    result: `Done: ${MARKER}`, is_error: false, errors: [`Error at ${secretPath}`],
    usage: { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 800 },
  } });
  bus.publish({ kind: 'turn_complete', missionId, outcome: 'completed' });
  bus.publish({ kind: 'task_created', taskId });
  bus.publish({ kind: 'task_updated', taskId, changed: ['status'], previous: { status: 'PENDING', title: MARKER } });
  bus.publish({ kind: 'plugins_changed', plugins: [plugin('@timon/kanban', 'active', 'bundled')] });
  bus.publish({ kind: 'plugins_changed', plugins: [plugin('@timon/kanban', 'active', 'bundled'), plugin(`${MARKER}-plugin`, 'active', 'third-party')] });
  bus.publish({ kind: 'license_changed', status: 'unlicensed', reason: `invalid:${MARKER}`, offlineSince: null });
  bus.publish({ kind: 'browser_annotation', event: 'annotation_created', profileId: MARKER, annotationId: MARKER, ownerUserId: MARKER,
    annotation: { url: `https://${MARKER}.example/`, comment: MARKER } as never, origin: { kind: 'user', id: MARKER } as never });
  onboardingStep('main_agent', 'completed');
  bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: 'crash' });

  const opened = await fetch(`${base}/api/telemetry/desktop-opened`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ version: '0.1.6' }),
  });
  assert.equal(opened.status, 200);

  await runtime.flushNow();

  // The test must not pass on an empty capture.
  assert.ok(captured.length >= 10, `events were captured (${captured.length})`);
  const names = captured.map((c) => (JSON.parse(c.body) as { payload: { name: string } }).payload.name);
  for (const expected of ['app_started', 'mission_spawned', 'turn_started', 'token_usage', 'turn_completed', 'tool_used',
    'task_action', 'plugin_action', 'license_action', 'browser_action', 'onboarding_step', 'mission_ended', 'desktop_app_opened']) {
    assert.ok(names.includes(expected), `${expected} was sent`);
  }
  for (const c of captured) {
    assert.equal(c.url, '/track');
    for (const part of [c.url, c.headers, c.body]) {
      assert.equal(part.toLowerCase().includes(MARKER), false, `marker leaked in ${part.slice(0, 300)}`);
      assert.equal(part.includes(home), false, 'the home path leaked');
    }
  }

  // What did go out, for the record: closed values only.
  const bodies = captured.map((c) => JSON.parse(c.body) as { payload: { name: string; profileId: string; properties: Record<string, unknown> } });
  const tools = bodies.filter((b) => b.payload.name === 'tool_used').map((b) => b.payload.properties.tool).sort();
  assert.deepEqual(tools, ['Bash', 'mcp__timon__kanban_add', 'other']);
  const spawned = bodies.find((b) => b.payload.name === 'mission_spawned')!.payload.properties;
  assert.equal(spawned.model, 'other');
  assert.equal(spawned.origin, 'user');
  // A fresh identity knows its creation: the turn reads day 0, and nothing else was added.
  const turn = bodies.find((b) => b.payload.name === 'turn_completed')!.payload.properties;
  assert.equal(turn.install_age_days, 0);
  assert.deepEqual(Object.keys(turn).filter((k) => !GLOBAL_KEYS.has(k)).sort(),
    ['backend', 'duration_ms', 'install_age_days', 'model', 'origin', 'status']);
  const installed = bodies.find((b) => b.payload.name === 'plugin_action')!.payload.properties;
  assert.deepEqual({ plugin: installed.plugin, source: installed.source }, { plugin: 'third_party', source: 'third_party' });
  assert.equal(new Set(bodies.map((b) => b.payload.profileId)).size, 1, 'one anonymous profile');
  const first = captured[0]!;
  assert.match(first.headers, /"openpanel-client-id":"abdaa564-293b-4dc6-a018-c81af47a1daf"/);
  assert.match(first.headers, /"origin":"timon-app:\/\/app"/);
});
