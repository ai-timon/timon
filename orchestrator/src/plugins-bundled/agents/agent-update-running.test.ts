/**
 * #78 — saving an agent's configuration while one of its missions works must
 * not cut the turn in flight. The live CLI keeps the settings it started with,
 * is relaunched on its own session before its next message, and only an
 * explicit `restart_missions` (`timon agent update --restart-missions`) stops
 * it at once. Witness CLI, routes on 127.0.0.1:0, temporary TIMON_HOME.
 */
import '../../test-home.js';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import type { Dialect, NormalizedEvent } from '../../backends/types.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { witnessCli } = await import('../../../tests/helpers/witness-cli.js');
const WITNESS_CLI = witnessCli(tmpdir());

const { spawnAgent, upsertAgent, sendToAgent, killAgent, isRunning, getTurnState } = await import('../../agent.js');
const { dbApi } = await import('../../db.js');
const { bus } = await import('../../bus.js');
const { registerDialect, registerProfile } = await import('../../backends/registry.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');

/** Each launch: the mode it was given and the session it resumed. */
const launches: Array<{ mode: string | undefined; resume: string | null }> = [];
/** The first turn of the next launch stays open until this file exists. */
let releaseFlag = '';

// The first turn ends only once the test writes the flag; then one `result` per stdin line.
const SCRIPT = `
const fs = require('node:fs');
const flag = process.argv[1];
const out = (e) => console.log(JSON.stringify(e));
const turn = () => out({ type: 'result', payload: { subtype: 'success', is_error: false, result: 'ok' } });
out({ type: 'system', payload: { subtype: 'init', session_id: 'update-session' } });
const wait = setInterval(() => { if (fs.existsSync(flag)) { clearInterval(wait); turn(); } }, 20);
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\\n')) >= 0) { buf = buf.slice(i + 1); turn(); } });
`;

const dialect: Dialect = {
  defaultCmd: WITNESS_CLI, persistentProcess: true, finishMissionOnExit: false,
  sessionResumable: true, sessionStore: 'global', permissionModel: 'mcp-bridge', rateLimitReporting: 'none', hostedConnectors: false,
  async buildSpawn(opts) {
    launches.push({ mode: opts.cfg.permission_mode, resume: opts.resumeSession });
    // A relaunch must not wait: its first turn is the message that caused it.
    const flag = opts.resumeSession ? releasedFlag() : releaseFlag;
    return { cmd: WITNESS_CLI, args: ['-e', SCRIPT, flag], cwd: opts.cfg.cwd, initialStdin: null };
  },
  writeUserInput(proc, text) { proc.stdin.write(`${text.replace(/\n/g, ' ')}\n`); },
  parseLine(line) { return [JSON.parse(line) as NormalizedEvent]; },
  extractSessionId(event) { const payload = event.payload as { session_id?: string }; return payload.session_id ?? null; },
};

const scratch = mkdtempSync(join(tmpdir(), 'timon-agent-update-'));
/** A flag that already exists: a relaunched CLI answers its message at once. */
function releasedFlag(): string {
  const path = join(scratch, 'released');
  writeFileSync(path, '');
  return path;
}
let flagCount = 0;
function newFlag(): string { releaseFlag = join(scratch, `flag-${++flagCount}`); return releaseFlag; }

const removeDialect = registerDialect('agent-update-test', 'agent-update', dialect);
const removeProfile = registerProfile('agent-update-test', {
  id: 'agent-update', dialect: 'agent-update', label: 'Update', vendor: 'Test', custom: true,
  defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
});
const AGENT = 'agent-update-witness';
upsertAgent({
  name: AGENT,
  system_prompt: 'You are a witness.',
  config: { backend: 'agent-update', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'default' },
});

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const completed: string[] = [];
const onEvent = (ev: { kind: string; missionId?: string }): void => {
  if (ev.kind === 'mission_complete' && ev.missionId) completed.push(ev.missionId);
};
bus.on('event', onEvent);

const missions: string[] = [];
after(() => {
  bus.off('event', onEvent);
  for (const id of missions) killAgent(id, { source: 'test' });
  server.closeAllConnections();
  server.close();
  removeProfile();
  removeDialect();
});

const resultCount = (missionId: string) => dbApi.listEvents(missionId).filter((e) => e.type === 'result').length;

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A mission of the agent whose first turn is still in flight, and the only
 *  live one: the counts the routes return cover every process of the agent. */
async function busyMission(): Promise<{ missionId: string; release: () => void }> {
  for (const id of missions) if (isRunning(id)) killAgent(id, { source: 'test' });
  await until(() => missions.every((id) => !isRunning(id)), 'the earlier missions to stop');
  const flag = newFlag();
  const missionId = await spawnAgent(AGENT, 'long work');
  missions.push(missionId);
  await until(() => dbApi.getMission(missionId)?.session_id === 'update-session', 'the session id');
  assert.equal(getTurnState(missionId)?.turnActive, true, 'the first turn is in flight');
  return { missionId, release: () => writeFileSync(flag, '') };
}

async function patchConfig(body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const r = await fetch(`${base}/api/agents/${AGENT}/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
}

test('an update during a turn leaves the turn running and applies at the next message', async () => {
  const { missionId, release } = await busyMission();
  const before = launches.length;

  const r = await patchConfig({ permission_mode: 'plan' });
  assert.equal(r.status, 200);
  assert.equal(r.json._killed, 0);
  assert.equal(r.json._restart_pending, 1);
  assert.equal(r.json.permission_mode, 'plan', 'the change is saved at once');

  // The turn in flight finishes on the settings it started with.
  release();
  await until(() => resultCount(missionId) === 1, 'the first turn to end on its own');
  assert.ok(isRunning(missionId), 'the update did not stop the process');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason ?? null, null);
  assert.ok(!completed.includes(missionId), 'the mission was not ended');
  assert.equal(launches.length, before);

  // The next message relaunches the CLI on its session, with the new settings.
  assert.equal(await sendToAgent(missionId, 'go on'), 'delivered');
  await until(() => resultCount(missionId) === 2, 'the relaunched turn');
  assert.equal(launches.length, before + 1);
  assert.deepEqual(launches[launches.length - 1], { mode: 'plan', resume: 'update-session' });
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  assert.ok(!completed.includes(missionId), 'the relaunch is not the end of the mission');

  // Relaunched once: the process now runs the current settings.
  assert.equal(await sendToAgent(missionId, 'again'), 'delivered');
  await until(() => resultCount(missionId) === 3, 'the third turn');
  assert.equal(launches.length, before + 1);
});

test('a field that does not reach the CLI touches no process', async () => {
  const { missionId, release } = await busyMission();
  const r = await patchConfig({ emoji: '🦉' });
  assert.equal(r.status, 200);
  assert.equal(r.json._killed, 0);
  assert.equal(r.json._restart_pending, 0);
  release();
  await until(() => resultCount(missionId) === 1, 'the first turn to end');
  assert.ok(isRunning(missionId));
});

test('restart_missions stops the running mission at once, as before', async () => {
  const { missionId } = await busyMission();
  const r = await patchConfig({ permission_mode: 'default', restart_missions: true });
  assert.equal(r.status, 200);
  assert.equal(r.json._killed, 1);
  assert.equal(r.json._restart_pending, 0);
  assert.equal('restart_missions' in r.json, false, 'the flag is not stored in the config');
  await until(() => !isRunning(missionId), 'the process to stop');
  await until(() => completed.includes(missionId), 'the mission to end');
});

test('restart_missions is honoured for a field outside the implicit restart list', async () => {
  const { missionId } = await busyMission();
  // `cwd` is accepted by the route but never restarts a process on its own.
  const r = await patchConfig({ cwd: mkdtempSync(join(tmpdir(), 'timon-agent-update-cwd-')), restart_missions: true });
  assert.equal(r.status, 200);
  assert.equal(r.json._killed, 1);
  assert.equal(r.json._restart_pending, 0);
  await until(() => !isRunning(missionId), 'the process to stop');
});

test('a save through the agent editor (POST /api/agents) defers too', async () => {
  const { missionId, release } = await busyMission();
  const r = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({
      name: AGENT,
      system_prompt: 'You are a witness.',
      config: { backend: 'agent-update', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'plan' },
    }),
  });
  const json = (await r.json()) as Record<string, unknown>;
  assert.equal(r.status, 200, JSON.stringify(json));
  assert.equal(json._killed, 0);
  assert.equal(json._restart_pending, 1);
  release();
  await until(() => resultCount(missionId) === 1, 'the first turn to end on its own');
  assert.ok(isRunning(missionId), 'the save did not stop the process');
});

/* The CLI relays the flag and says what happens to the live missions. */

const CLI = fileURLToPath(new URL('../../../bin/timon', import.meta.url));

async function runCli(argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const env: NodeJS.ProcessEnv = {
    ...process.env, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-agent-update-cli-')), TIMON_API: base, TIMON_API_TOKEN: TOKEN,
  };
  for (const key of ['TIMON_MISSION_ID', 'TIMON_TRACE_ID', 'TIMON_AGENT', 'TIMON_PROJECT']) delete env[key];
  const child = spawn(process.execPath, [CLI, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += String(c); });
  child.stderr.on('data', (c: Buffer) => { err += String(c); });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 15_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out, err }); });
  });
}

test('CLI: agent update spares a working mission and names the flag; --restart-missions stops it', async () => {
  const { missionId } = await busyMission();
  const spared = await runCli(['agent', 'update', AGENT, '--permission-mode', 'acceptEdits']);
  assert.equal(spared.code, 0, spared.err);
  assert.equal((JSON.parse(spared.out) as { _restart_pending: number })._restart_pending, 1);
  assert.match(spared.err, /--restart-missions/);
  assert.ok(isRunning(missionId), 'the mission is still working');

  const stopped = await runCli(['agent', 'update', AGENT, '--permission-mode', 'default', '--restart-missions']);
  assert.equal(stopped.code, 0, stopped.err);
  assert.equal((JSON.parse(stopped.out) as { _killed: number })._killed, 1);
  assert.match(stopped.err, /stopped 1 running mission/);
  await until(() => !isRunning(missionId), 'the process to stop');
});
