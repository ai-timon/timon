/**
 * Raising a running mission's permission level is the same decision as
 * launching it there (TODO #430): with `agents:privileged-config` a mission
 * token may pick any level, but never above the one its own mission runs in.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const missionRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');

const OWNER = 'user-owner';
const caller = 'mission-caller';
const target = 'mission-target';
dbApi.createMission(caller, 'acme.pilot', 'orchestrate', undefined, OWNER);
dbApi.createMission(target, 'acme.coder', 'code', undefined, OWNER);
dbApi.setMissionPermissionModeOverride(caller, 'auto');

{
  // grok's profile exists only where its CLI is found: the stand-in keeps the
  // test off the developer's own install, which a clean machine (the CI) lacks.
  const { mountOfficialProviders, stubCliBinaries } = await import('../../../tests/helpers/official-providers.js');
  await stubCliBinaries('grok');
  await mountOfficialProviders();
}

async function request(
  method: 'GET' | 'POST',
  permissions: string[],
  body?: Record<string, unknown>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: OWNER, permissions, missionId: caller } as never;
    next();
  });
  missionRoutes.registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/missions/${target}/permission-mode`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

const READ = ['missions:read'];
const PRIVILEGED = [...READ, 'agents:privileged-config'];

test('with the permission, a mission cannot raise another one above its own level', async () => {
  const r = await request('POST', PRIVILEGED, { mode: 'bypassPermissions' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /above the caller's own level \(auto\)/);
  assert.equal(dbApi.getMission(target)?.permission_mode_override ?? null, null);
});

test('with the permission, a level up to its own passes', async () => {
  const r = await request('POST', PRIVILEGED, { mode: 'auto' });
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'auto');
  assert.equal(dbApi.getMission(target)?.permission_mode_override, 'auto');
});

test('the choices offered stop at the caller ceiling', async () => {
  const r = await request('GET', PRIVILEGED);
  assert.equal(r.status, 200);
  assert.equal(r.json.mode, 'auto');
  assert.equal(r.json.source, 'mission');
  const choices = r.json.choices as string[];
  assert.ok(choices.includes('auto'));
  assert.ok(!choices.includes('bypassPermissions'));
});

test('without the permission only the safe levels pass, whatever the caller runs in', async () => {
  dbApi.setMissionPermissionModeOverride(caller, 'bypassPermissions');
  try {
    const r = await request('POST', READ, { mode: 'bypassPermissions' });
    assert.equal(r.status, 403);
    assert.match(String(r.json.reason), /needs the agents:privileged-config permission/);
    const ok = await request('POST', READ, { mode: 'plan' });
    assert.equal(ok.status, 200);
    assert.equal(dbApi.getMission(target)?.permission_mode_override, 'plan');
  } finally {
    dbApi.setMissionPermissionModeOverride(caller, 'auto');
  }
});

test('every refusal is audited', async () => {
  await request('POST', READ, { mode: 'bypassPermissions' });
  assert.ok(dbApi.listAuditLog(50).some((row) => row.action === 'mission.permission_mode_denied'
    && String(row.target).startsWith(`mission:${target}`)));
});

test('on a backend that declares its supported modes, the state, the choices and a change are the mode it really runs', async () => {
  const grokMission = 'mission-grok';
  dbApi.createMission(grokMission, 'acme.grok', 'code', undefined, OWNER);
  dbApi.setMissionLlmOverrides(grokMission, 'grok', null);
  const call = async (method: 'GET' | 'POST', body?: Record<string, unknown>) => {
    let out: { status: number; json: Record<string, unknown> } | null = null;
    await withRoute(PRIVILEGED, async (base) => {
      const r = await fetch(`${base}/api/missions/${grokMission}/permission-mode`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      out = { status: r.status, json: (await r.json()) as Record<string, unknown> };
    });
    return out!;
  };
  // Nothing stored = `default`, which grok runs read-only.
  const state = await call('GET');
  assert.equal(state.status, 200);
  assert.equal(state.json.mode, 'plan');
  assert.deepEqual(state.json.choices, ['plan'], 'only the supported modes, up to the caller ceiling (auto)');
  // A guarded mode is judged and stored as what it runs: plan.
  const guarded = await call('POST', { mode: 'auto' });
  assert.equal(guarded.status, 200);
  assert.equal(guarded.json.mode, 'plan');
  assert.equal(dbApi.getMission(grokMission)?.permission_mode_override, 'plan');
  // bypassPermissions stays bypassPermissions, so the ceiling refuses it below its own level…
  const refused = await call('POST', { mode: 'bypassPermissions' });
  assert.equal(refused.status, 403);
  assert.match(String(refused.json.reason), /above the caller's own level/);
  // …and grants it to a caller that runs in it.
  dbApi.setMissionPermissionModeOverride(caller, 'bypassPermissions');
  try {
    assert.deepEqual((await call('GET')).json.choices, ['plan', 'bypassPermissions']);
    const granted = await call('POST', { mode: 'bypassPermissions' });
    assert.equal(granted.status, 200);
    assert.equal(dbApi.getMission(grokMission)?.permission_mode_override, 'bypassPermissions');
  } finally {
    dbApi.setMissionPermissionModeOverride(caller, 'auto');
  }
});

/* ── CLI and MCP (TODO #569): both transports only relay to this route, so the
   guard above is theirs too. Driven against the real route, never a stub: a
   transport that decided anything locally would show up here. */

const CLI = fileURLToPath(new URL('../../../bin/timon', import.meta.url));
const MCP = fileURLToPath(new URL('../../../bin/timon-mcp.mjs', import.meta.url));

async function withRoute(permissions: string[], fn: (base: string) => Promise<void>): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: OWNER, permissions, missionId: caller } as never;
    next();
  });
  missionRoutes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try { await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); }
  finally { server.closeAllConnections(); server.close(); }
}

function childEnv(extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: mkdtempSync(join(tmpdir(), 'timon-perm-mode-')), TIMON_API_TOKEN: 'mission-token', ...extra };
  for (const key of ['TIMON_MISSION_ID', 'TIMON_TRACE_ID', 'TIMON_AGENT', 'TIMON_PROJECT']) delete env[key];
  return env;
}

async function runCli(base: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const child = spawn(process.execPath, [CLI, ...argv], { env: childEnv({ TIMON_API: base }), stdio: ['ignore', 'pipe', 'pipe'] });
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

type ToolReply = { result?: { isError?: boolean; content?: Array<{ text: string }> } };

async function callTool(base: string, name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const child = spawn(process.execPath, [MCP], { env: childEnv({ TIMON_ORCH_URL: base }), stdio: ['pipe', 'pipe', 'ignore'] });
  let buffer = '';
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 15_000);
    child.stdout.on('data', (c: Buffer) => {
      buffer += String(c);
      const line = buffer.split('\n').find((l) => l.trim());
      if (!line || !buffer.includes('\n')) return;
      clearTimeout(timer);
      child.kill();
      resolve(JSON.parse(line) as ToolReply);
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}

test('CLI: without the permission, bypassPermissions is refused with its reason and nothing is written', async () => {
  dbApi.setMissionPermissionModeOverride(target, 'plan');
  await withRoute(READ, async (base) => {
    const r = await runCli(base, ['mission', 'permission-mode', 'set', target, 'bypassPermissions']);
    assert.equal(r.code, 2);
    assert.match(r.err, /403/);
    assert.match(r.err, /needs the agents:privileged-config permission/);
    assert.equal(dbApi.getMission(target)?.permission_mode_override, 'plan');
  });
});

test('CLI: another owner\'s mission is invisible, and a safe level passes on one\'s own', async () => {
  const foreign = 'mission-foreign';
  dbApi.createMission(foreign, 'other.coder', 'code', undefined, 'user-other');
  await withRoute(PRIVILEGED, async (base) => {
    const hidden = await runCli(base, ['mission', 'permission-mode', 'set', foreign, 'plan']);
    assert.equal(hidden.code, 2);
    assert.match(hidden.err, /404/);
    assert.equal(dbApi.getMission(foreign)?.permission_mode_override ?? null, null);
    const ok = await runCli(base, ['mission', 'permission-mode', 'set', target, 'acceptEdits']);
    assert.equal(ok.code, 0, ok.err);
    assert.deepEqual(JSON.parse(ok.out), { ok: true, mode: 'acceptEdits', previous: 'plan' });
    const read = await runCli(base, ['mission', 'permission-mode', 'get', target]);
    assert.equal(read.code, 0, read.err);
    const state = JSON.parse(read.out) as { mode: string; source: string; choices: string[] };
    assert.equal(state.mode, 'acceptEdits');
    assert.equal(state.source, 'mission');
    assert.ok(!state.choices.includes('bypassPermissions'), 'the choices stop at the caller ceiling');
  });
});

test('MCP: the refusal surfaces as a tool error with its reason, and an alias is stored under its Claude name', async () => {
  dbApi.setMissionPermissionModeOverride(target, 'plan');
  await withRoute(READ, async (base) => {
    const denied = await callTool(base, 'mission_permission_mode_set', { mission_id: target, mode: 'danger-full-access' });
    assert.equal(denied.result?.isError, true);
    assert.match(denied.result?.content?.[0]?.text ?? '', /needs the agents:privileged-config permission/);
    assert.equal(dbApi.getMission(target)?.permission_mode_override, 'plan');
    const ok = await callTool(base, 'mission_permission_mode_set', { mission_id: target, mode: 'workspace-write' });
    assert.ok(!ok.result?.isError, ok.result?.content?.[0]?.text);
    assert.equal(dbApi.getMission(target)?.permission_mode_override, 'auto');
    const read = await callTool(base, 'mission_permission_mode_get', { mission_id: target });
    assert.match(read.result?.content?.[0]?.text ?? '', /"mode":\s*"auto"/);
  });
});
