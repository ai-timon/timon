/**
 * The ACP session driver against the scripted fake agent
 * (`__fixtures__/fake-acp-agent.mjs`), over the real pipes of a child process.
 * No opencode or Hermes is ever started: each test names the scenario it runs
 * through the text of its prompt.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NormalizedEvent, PermissionDecision, PermissionRequest } from '../types.js';

/* Throwaway TIMON_HOME, set BEFORE importing anything that reads paths.ts. */
const TMP_HOME = mkdtempSync(join(tmpdir(), 'timon-acp-driver-'));
process.env.TIMON_HOME = TMP_HOME;
process.env.PORT = '3010';
process.on('exit', () => rmSync(TMP_HOME, { recursive: true, force: true }));

const { AcpSessionDriver, MODEL_NOT_APPLIED } = await import('./driver.js');
type DriverOptions = ConstructorParameters<typeof AcpSessionDriver>[0];

const FAKE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'fake-acp-agent.mjs');
const SYSTEM_PROMPT = 'You are a Timon agent.';

type Rig = {
  driver: InstanceType<typeof AcpSessionDriver>;
  child: ChildProcess;
  events: NormalizedEvent[];
  asks: PermissionRequest[];
  closed: () => number;
};

const rigs: Rig[] = [];

type LaunchOptions = Partial<Omit<DriverOptions, 'io' | 'host'>> & {
  env?: Record<string, string>;
  decide?: (req: PermissionRequest) => Promise<PermissionDecision>;
};

function launch(over: LaunchOptions = {}): Rig {
  const child = nodeSpawn(process.execPath, [FAKE], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...(over.env ?? {}) },
  });
  child.stderr!.resume();
  const events: NormalizedEvent[] = [];
  const asks: PermissionRequest[] = [];
  let closes = 0;
  const { env: _env, decide, ...rest } = over;
  const driver = new AcpSessionDriver({
    io: { stdin: child.stdin!, stdout: child.stdout! },
    host: {
      emit: (ev) => { events.push(ev); },
      requestPermission: async (req) => {
        asks.push(req);
        return decide ? decide(req) : { allow: true };
      },
    },
    cwd: TMP_HOME,
    systemPrompt: SYSTEM_PROMPT,
    model: null,
    resumeSession: null,
    mcpServers: async () => [],
    permissionsByAgent: false,
    profileId: 'fake',
    ...rest,
    onClose: () => { closes += 1; rest.onClose?.(); },
  });
  const rig = { driver, child, events, asks, closed: () => closes };
  rigs.push(rig);
  return rig;
}

test.afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.driver.close();
    r.child.kill('SIGKILL');
  }
});

/** Every text the assistant said in the turn, deltas included, in order. */
function said(events: NormalizedEvent[]): string {
  return events
    .filter((e) => e.type === 'assistant_delta')
    .map((e) => (e.payload as { text: string }).text)
    .join('');
}

function result(events: NormalizedEvent[]): Record<string, unknown> {
  const all = events.filter((e) => e.type === 'result');
  assert.equal(all.length, 1, 'exactly one result per turn');
  return all[0]!.payload as Record<string, unknown>;
}

test('a full turn: handshake, init, streamed text, tool call, one result with usage', async () => {
  const { driver, events } = launch();
  const info = await driver.start();
  assert.equal(info.sessionId, 'sess-1');
  assert.equal(info.resumed, false);
  assert.deepEqual(info.capabilities, { loadSession: true, resume: false, mcp: true, image: true });
  assert.equal(driver.info, info);

  const init = events[0]!;
  assert.equal(init.type, 'system');
  assert.equal((init.payload as { session_id: string }).session_id, 'sess-1');
  assert.equal('permissions_by_agent' in (init.payload as object), false);

  events.length = 0;
  const out = await driver.prompt('hello');
  assert.deepEqual(out, { stopReason: 'end_turn' });
  assert.equal(said(events), 'Hello');
  const types = events.map((e) => e.type);
  assert.ok(types.includes('assistant'), 'the assembled message is persisted once');
  assert.ok(types.includes('user'), 'the tool result comes back');
  // The result is emitted BEFORE prompt resolved, and last.
  assert.equal(types.at(-1), 'result');
  const r = result(events);
  assert.equal(r.subtype, 'success');
  assert.equal(r.is_error, false);
  assert.deepEqual(r.usage, {
    input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 7, reasoning_tokens: 5,
  });
});

test('the system prompt rides in front of the first message only', async () => {
  const { driver, events } = launch();
  await driver.start();
  events.length = 0;
  await driver.prompt('echo');
  const first = said(events);
  assert.match(first, /^<timon_instructions>\nYou are a Timon agent\.\n<\/timon_instructions>\|echo$/);
  events.length = 0;
  await driver.prompt('echo');
  assert.equal(said(events), 'echo');
});

test('a second turn while one runs is refused, and a closed driver refuses too', async () => {
  const { driver } = launch();
  await driver.start();
  const running = driver.prompt('slow');
  await assert.rejects(() => driver.prompt('hello'), /already running/);
  await driver.cancel();
  await running;
  driver.close();
  await assert.rejects(() => driver.prompt('hello'), /closed/);
});

test('prompt before start is refused', async () => {
  const { driver } = launch();
  await assert.rejects(() => driver.prompt('hello'), /not started/);
});

/* ── Permissions ────────────────────────────────────────────────────────── */

test('a permission ask reaches the host as a neutral request; Allow selects allow_once', async () => {
  const { driver, events, asks } = launch({ decide: async () => ({ allow: true }) });
  await driver.start();
  events.length = 0;
  await driver.prompt('perm');
  assert.equal(asks.length, 1);
  assert.deepEqual(asks[0], {
    toolCallId: 't2', tool: 'write /etc/passwd', title: 'write /etc/passwd', input: { path: '/etc/passwd' },
  });
  assert.equal(said(events), 'selected:allow');
});

test('the same ask refused: Deny selects the reject_once option', async () => {
  const { driver, events } = launch({ decide: async () => ({ allow: false }) });
  await driver.start();
  events.length = 0;
  await driver.prompt('perm');
  assert.equal(said(events), 'selected:deny');
  assert.equal(result(events).subtype, 'success', 'a refused tool use is not a failed turn');
});

test('a host that cannot ask (rejects) denies at once instead of blocking the agent', async () => {
  const { driver, events } = launch({ decide: async () => { throw new Error('no card channel'); } });
  await driver.start();
  events.length = 0;
  const started = Date.now();
  await driver.prompt('perm');
  assert.equal(said(events), 'selected:deny');
  assert.ok(Date.now() - started < 5_000);
});

test('a card nobody answers is refused when the wait ceiling is reached', async () => {
  const { driver, events } = launch({ decide: () => new Promise(() => undefined), permissionWaitMs: 60 });
  await driver.start();
  events.length = 0;
  await driver.prompt('perm');
  assert.equal(said(events), 'selected:deny');
});

test('options with no `kind` are answered by their ids, hyphenated as Cursor writes them, and never by allow-always', async () => {
  const allowed = launch({ decide: async () => ({ allow: true }) });
  await allowed.driver.start();
  allowed.events.length = 0;
  await allowed.driver.prompt('permhyphen');
  assert.equal(said(allowed.events), 'selected:allow-once');
  const refused = launch({ decide: async () => ({ allow: false }) });
  await refused.driver.start();
  refused.events.length = 0;
  await refused.driver.prompt('permhyphen');
  assert.equal(said(refused.events), 'selected:reject-once');
});

test('an allow-always-only ask is never turned into a standing grant: the agent is told cancelled', async () => {
  const { driver, events } = launch({ decide: async () => ({ allow: true }) });
  await driver.start();
  events.length = 0;
  await driver.prompt('permalways');
  assert.equal(said(events), 'outcome:cancelled');
});

test('cancelling a turn that waits on a permission answers the agent cancelled', async () => {
  const { driver, events, asks } = launch({ decide: () => new Promise(() => undefined), permissionWaitMs: 60_000 });
  await driver.start();
  events.length = 0;
  const turn = driver.prompt('permslow');
  while (asks.length === 0) await new Promise((r) => setTimeout(r, 10));
  await driver.cancel();
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(said(events), 'outcome:cancelled');
  assert.equal(result(events).subtype, 'cancelled');
});

/* ── Cancellation and time limits ───────────────────────────────────────── */

test('cancel ends the turn with a cancelled result, and the session takes the next turn', async () => {
  const { driver, events } = launch();
  await driver.start();
  events.length = 0;
  const turn = driver.prompt('slow');
  await new Promise((r) => setTimeout(r, 50));
  await driver.cancel();
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(result(events).subtype, 'cancelled');
  assert.equal(said(events), 'working');
});

test('an agent that ignores the cancel is not waited for; its session is then refused', async () => {
  const { driver, events } = launch({ cancelGraceMs: 60 });
  await driver.start();
  events.length = 0;
  const turn = driver.prompt('hang');
  await new Promise((r) => setTimeout(r, 30));
  await driver.cancel();
  assert.deepEqual(await turn, { stopReason: 'cancelled' });
  assert.equal(result(events).subtype, 'cancelled');
  await assert.rejects(() => driver.prompt('hello'), /did not stop/);
});

test('a silent turn is stopped: the result says why', async () => {
  const { driver, events } = launch({ turnIdleTimeoutMs: 60, cancelGraceMs: 60 });
  await driver.start();
  events.length = 0;
  await driver.prompt('hang');
  const r = result(events);
  assert.equal(r.is_error, true);
  assert.match(String(r.error), /produced nothing for too long/);
});

test('a turn that keeps talking is not cut by the silence limit', async () => {
  const { driver, events } = launch({ turnIdleTimeoutMs: 5_000 });
  await driver.start();
  events.length = 0;
  await driver.prompt('hello');
  assert.equal(result(events).is_error, false);
});

/* ── Agent death ────────────────────────────────────────────────────────── */

test('an agent that dies mid-turn: one error result, prompt rejects, the next one too', async () => {
  const { driver, events } = launch();
  await driver.start();
  events.length = 0;
  await assert.rejects(() => driver.prompt('die'), /agent stopped/);
  const r = result(events);
  assert.equal(r.is_error, true);
  assert.match(String(r.error), /agent stopped/);
  await assert.rejects(() => driver.prompt('hello'));
});

test('an agent that is gone before the handshake fails start with a readable message', async () => {
  const rig = launch();
  rig.child.kill('SIGKILL');
  await assert.rejects(() => rig.driver.start(), /agent/);
  assert.equal(rig.closed(), 1);
});

test('close rejects the turn in flight and calls onClose once', async () => {
  const rig = launch();
  await rig.driver.start();
  const turn = rig.driver.prompt('hang');
  await new Promise((r) => setTimeout(r, 30));
  rig.driver.close();
  rig.driver.close();
  await assert.rejects(turn);
  assert.equal(rig.closed(), 1);
});

/* ── Resuming ───────────────────────────────────────────────────────────── */

test('resume: session/resume when announced, its history replay dropped, no system prompt again', async () => {
  const { driver, events } = launch({ resumeSession: 'old-1', env: { FAKE_ACP_RESUME: '1' } });
  const info = await driver.start();
  assert.equal(info.sessionId, 'old-1');
  assert.equal(info.resumed, true);
  assert.equal(info.capabilities.resume, true);
  assert.equal(said(events), '', 'the replayed history is not conversation');
  assert.equal((events[0]!.payload as { session_id: string }).session_id, 'old-1');
  events.length = 0;
  await driver.prompt('echo');
  assert.equal(said(events), 'echo');
});

test('resume: an agent that only announces session/load is reopened that way', async () => {
  const { driver, events } = launch({ resumeSession: 'old-2' });
  const info = await driver.start();
  assert.equal(info.resumed, true);
  assert.equal(info.capabilities.resume, false);
  assert.equal(said(events), '');
});

test('resume: a session/resume the agent lacks (-32601) falls back to session/load', async () => {
  const { driver } = launch({ resumeSession: 'old-3', env: { FAKE_ACP_RESUME: '1', FAKE_ACP_RESUME_FAIL: '1' } });
  const info = await driver.start();
  assert.equal(info.resumed, true);
  assert.equal(info.sessionId, 'old-3');
});

test('resume: a session the agent no longer has starts a fresh one, and says so', async () => {
  const { driver, events } = launch({
    resumeSession: 'gone',
    env: { FAKE_ACP_RESUME: '1', FAKE_ACP_RESUME_FAIL: '1', FAKE_ACP_LOAD_FAIL: '1' },
  });
  const info = await driver.start();
  assert.equal(info.resumed, false);
  assert.equal(info.sessionId, 'sess-1');
  events.length = 0;
  await driver.prompt('echo');
  assert.match(said(events), /^<timon_instructions>/, 'a fresh session gets the system prompt');
});

/* ── Session set-up ─────────────────────────────────────────────────────── */

test('the MCP servers are handed to session/new as given', async () => {
  const servers = [{ name: 'timon', command: 'node', args: ['/x/timon-mcp.mjs'], env: [{ name: 'TIMON_MISSION_ID', value: 'm1' }] }];
  const { driver, events } = launch({ mcpServers: async () => servers });
  await driver.start();
  events.length = 0;
  await driver.prompt('mcp');
  assert.deepEqual(JSON.parse(said(events)), servers);
});

test('the configured model is selected when the session does not already run it', async () => {
  const { driver, events } = launch({ model: 'b' });
  await driver.start();
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:b');
});

test('the model the session already runs is not re-selected', async () => {
  const { driver, events } = launch({ model: 'a' });
  await driver.start();
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:null');
});

function initPayload(events: NormalizedEvent[]): Record<string, unknown> {
  const init = events.find((e) => e.type === 'system');
  assert.ok(init, 'the session opens with an init event');
  return init.payload as Record<string, unknown>;
}

function notApplied(events: NormalizedEvent[]): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === MODEL_NOT_APPLIED).map((e) => e.payload as Record<string, unknown>);
}

test('the init event says which model was asked and which one runs', async () => {
  const { driver, events } = launch({ model: 'b' });
  await driver.start();
  const init = initPayload(events);
  assert.equal(init.model, 'b');
  assert.equal(init.requested_model, 'b');
  assert.deepEqual(notApplied(events), []);
});

test('an agent that refuses set_model gets the model through its model config option (opencode)', async () => {
  const { driver, events } = launch({ model: 'b', env: { FAKE_ACP_NO_SET_MODEL: '1' } });
  await driver.start();
  assert.equal(initPayload(events).model, 'b');
  assert.deepEqual(notApplied(events), []);
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:b');
});

test('a model no way can select is said in the thread, with the one that runs, and the mission starts', async () => {
  const { driver, events } = launch({ model: 'b', env: { FAKE_ACP_NO_SET_MODEL: '1', FAKE_ACP_NO_CONFIG: '1' } });
  await driver.start();
  const init = initPayload(events);
  assert.equal(init.model, 'a', 'the init reports the model the agent kept');
  assert.equal(init.requested_model, 'b');
  const [notice, ...more] = notApplied(events);
  assert.deepEqual(more, []);
  assert.equal(notice!.backend, 'fake');
  assert.equal(notice!.requested_model, 'b');
  assert.equal(notice!.active_model, 'a');
  assert.match(String(notice!.model_reason), /Method not found/);
  assert.equal('requested_effort' in notice!, false);
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:null');
});

test('a model id the agent does not know is refused through the config option too, and said', async () => {
  const { driver, events } = launch({ model: 'zzz', env: { FAKE_ACP_NO_SET_MODEL: '1' } });
  await driver.start();
  const [notice] = notApplied(events);
  assert.equal(notice!.requested_model, 'zzz');
  assert.equal(notice!.active_model, 'a');
  assert.match(String(notice!.model_reason), /invalid option model=zzz/);
});

test('a refused thinking level is said in the thread', async () => {
  const { driver, events } = launch({ model: 'b', reasoningEffort: 'high' });
  await driver.start();
  const [notice, ...more] = notApplied(events);
  assert.deepEqual(more, []);
  assert.equal(notice!.requested_effort, 'high');
  assert.match(String(notice!.effort_reason), /invalid option/);
  assert.equal('requested_model' in notice!, false, 'the model itself was applied');
});

test('setModel between turns falls back on the model config option when set_model is refused', async () => {
  const { driver, events } = launch({ env: { FAKE_ACP_NO_SET_MODEL: '1' } });
  await driver.start();
  assert.equal(await driver.setModel!('b'), true);
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:b');
});

test('setModel answers false when no way selects the model', async () => {
  const { driver } = launch({ env: { FAKE_ACP_NO_SET_MODEL: '1', FAKE_ACP_NO_CONFIG: '1' } });
  await driver.start();
  assert.equal(await driver.setModel!('b'), false);
});

test('setModel switches between turns and refuses during one', async () => {
  const { driver, events } = launch();
  await driver.start();
  assert.equal(await driver.setModel!('b'), true);
  events.length = 0;
  await driver.prompt('model');
  assert.equal(said(events), 'model:b');
  const turn = driver.prompt('slow');
  assert.equal(await driver.setModel!('a'), false);
  await driver.cancel();
  await turn;
});

test('the thinking level is selected after the model, through the config option', async () => {
  const { driver, events } = launch({ model: 'a', reasoningEffort: 'high' });
  await driver.start();
  events.length = 0;
  await driver.prompt('effort');
  assert.equal(said(events), 'effort:high');
});

test('no thinking level asked: none is sent', async () => {
  const { driver, events } = launch({ model: 'a' });
  await driver.start();
  events.length = 0;
  await driver.prompt('effort');
  assert.equal(said(events), 'effort:null');
});

test('a level the model does not offer is dropped with a warning, and the mission starts', async () => {
  const { driver, events } = launch({ model: 'b', reasoningEffort: 'high' });
  await driver.start();
  events.length = 0;
  await driver.prompt('effort');
  assert.equal(said(events), 'effort:null');
});

test('an agent without set_config_option still starts with a thinking level asked', async () => {
  const { driver } = launch({ model: 'a', reasoningEffort: 'high', env: { FAKE_ACP_NO_CONFIG: '1' } });
  await driver.start();
});

/* ── Session modes ─────────────────────────────────────────────────────── */

test('session modes announced: the mapped mode is selected through session/set_mode', async () => {
  const { driver, events } = launch({ sessionMode: 'plan', env: { FAKE_ACP_MODES: '1' } });
  await driver.start();
  assert.equal(initPayload(events).session_mode, 'plan');
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:plan via:set_mode');
});

test('no session modes announced: nothing is sent, whatever the mode asked', async () => {
  const { driver, events } = launch({ sessionMode: 'plan' });
  await driver.start();
  assert.equal(initPayload(events).session_mode, undefined);
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:default via:null');
});

test('session modes announced but none asked (no table): the agent keeps its own', async () => {
  const { driver, events } = launch({ env: { FAKE_ACP_MODES: '1' } });
  await driver.start();
  assert.equal(initPayload(events).session_mode, 'default');
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:default via:null');
});

test('the mode the session already runs is not selected again', async () => {
  const { driver, events } = launch({ sessionMode: 'default', env: { FAKE_ACP_MODES: '1' } });
  await driver.start();
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:default via:null');
});

test('a mapped mode the agent did not announce is never replaced by another one', async () => {
  const { driver, events } = launch({ sessionMode: 'read-only', env: { FAKE_ACP_MODES: '1' } });
  await driver.start();
  assert.equal(initPayload(events).session_mode, 'default');
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:default via:null');
});

test('modes announced as a config option: selected through session/set_config_option', async () => {
  const { driver, events } = launch({ sessionMode: 'accept-edits', model: 'b', env: { FAKE_ACP_MODES: 'config' } });
  await driver.start();
  assert.equal(initPayload(events).session_mode, 'accept-edits');
  assert.equal(initPayload(events).model, 'b', 'the model is still selected after the mode');
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:accept-edits via:set_config_option');
});

test('an agent that refuses session/set_mode gets the mode through its mode config option', async () => {
  const { driver, events } = launch({ sessionMode: 'plan', env: { FAKE_ACP_MODES: 'both', FAKE_ACP_NO_SET_MODE: '1' } });
  await driver.start();
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:plan via:set_config_option');
});

test('a mode no way selects leaves the agent in its own, and the mission starts', async () => {
  const { driver, events } = launch({ sessionMode: 'plan', env: { FAKE_ACP_MODES: '1', FAKE_ACP_NO_SET_MODE: '1' } });
  const info = await driver.start();
  assert.equal(info.sessionId, 'sess-1');
  assert.equal(initPayload(events).session_mode, 'default');
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:default via:null');
});

test('a reopened session that announces its modes is switched too', async () => {
  const { driver, events } = launch({ resumeSession: 'old-9', sessionMode: 'plan', env: { FAKE_ACP_RESUME: '1', FAKE_ACP_MODES: '1' } });
  const info = await driver.start();
  assert.equal(info.resumed, true);
  events.length = 0;
  await driver.prompt('mode');
  assert.equal(said(events), 'mode:plan via:set_mode');
});

test('an agent that wants a sign-in fails start with what to do, and lets go', async () => {
  const rig = launch({ env: { FAKE_ACP_AUTH: '1' } });
  await assert.rejects(() => rig.driver.start(), /sign in first \(Log in\)/);
  assert.equal(rig.closed(), 1);
});

test('a sign-in refusal names the login step the agent\'s provider declared, and nothing when it declared none', async () => {
  const opencode = launch({ env: { FAKE_ACP_AUTH: '1' }, profileId: 'opencode', signIn: { fallback: 'run `opencode auth login` in a terminal on this machine, then retry' } });
  await assert.rejects(() => opencode.driver.start(), /sign in first \(Log in\) — run `opencode auth login`/);
  const hermes = launch({ env: { FAKE_ACP_AUTH: '1' }, profileId: 'hermes', signIn: { fallback: 'run `hermes setup` in a terminal on this machine, then retry' } });
  await assert.rejects(() => hermes.driver.start(), /run `hermes setup`/);
  const unknown = launch({ env: { FAKE_ACP_AUTH: '1' }, profileId: 'unknown' });
  await assert.rejects(() => unknown.driver.start(), (err: Error) => /sign in first \(Log in\)$/.test(err.message));
});

test('authenticate: tried once, only after auth_required, with the method the provider declared and the agent announced', async () => {
  const rig = launch({ env: { FAKE_ACP_AUTH: 'authenticate' }, authenticateWith: 'cursor_login' });
  await rig.driver.start();
  rig.events.length = 0;
  await rig.driver.prompt('auth');
  assert.equal(said(rig.events), '["cursor_login"]');

  // A provider that declared nothing never calls it: the sign-in sentence is reported.
  const undeclared = launch({ env: { FAKE_ACP_AUTH: 'authenticate' }, signIn: { fallback: 'run `cursor-agent login`' } });
  await assert.rejects(() => undeclared.driver.start(), /sign in first \(Cursor Login\) — run `cursor-agent login`/);

  // A method the agent did not announce is never sent.
  const unannounced = launch({ env: { FAKE_ACP_AUTH: 'authenticate' }, authenticateWith: 'other_login' });
  await assert.rejects(() => unannounced.driver.start(), /sign in first/);

  // Already signed in: no `authenticate` ahead of time (the fake without `auth_required` has no method to answer it).
  const signedIn = launch({ authenticateWith: 'cursor_login' });
  await signedIn.driver.start();
  signedIn.events.length = 0;
  await signedIn.driver.prompt('auth');
  assert.equal(said(signedIn.events), '[]');
});

test('authenticate refused: the sign-in sentence is what the user reads, and the driver lets go', async () => {
  const rig = launch({
    env: { FAKE_ACP_AUTH: 'authenticate', FAKE_ACP_AUTH_FAIL: '1' },
    authenticateWith: 'cursor_login',
    signIn: { fallback: 'run `cursor-agent login` in a terminal on this machine, then retry' },
  });
  await assert.rejects(() => rig.driver.start(), /sign in first \(Cursor Login\) — run `cursor-agent login`/);
  assert.equal(rig.closed(), 1);
});

test('inside the mission fence, authenticate is never tried: the sign-in step is reported at once', async () => {
  // The agent's sign-in would wait for a browser redirect a fenced process cannot get.
  const signIn = { fallback: 'run `cursor-agent login` in a terminal on this machine, then retry' };
  const fenced = launch({ env: { FAKE_ACP_AUTH: 'authenticate', FAKE_ACP_AUTH_HANG: '1' }, authenticateWith: 'cursor_login', signIn, fenced: () => true });
  const started = Date.now();
  await assert.rejects(() => fenced.driver.start(), /sign in first \(Cursor Login\) — run `cursor-agent login`/);
  assert.ok(Date.now() - started < 10_000, 'no wait on the sign-in method');
  assert.equal(fenced.closed(), 1);

  // The same agent outside the fence still gets the detour.
  const open = launch({ env: { FAKE_ACP_AUTH: 'authenticate' }, authenticateWith: 'cursor_login', fenced: () => false });
  await open.driver.start();
  open.events.length = 0;
  await open.driver.prompt('auth');
  assert.equal(said(open.events), '["cursor_login"]');
});

test('images: sent as image blocks when the agent takes them, a note otherwise', async () => {
  const image = { media_type: 'image/png', data: 'AAAA' };
  const yes = launch();
  await yes.driver.start();
  yes.events.length = 0;
  await yes.driver.prompt('echo', [image]);
  assert.match(said(yes.events), /\|echo\|image$/);

  const no = launch({ env: { FAKE_ACP_NO_IMAGE: '1' } });
  await no.driver.start();
  no.events.length = 0;
  await no.driver.prompt('echo', [image]);
  assert.match(said(no.events), /\[1 image\(s\) not sent: this agent does not accept images\]\|echo$/);
});

/* ── Agents that decide alone ───────────────────────────────────────────── */

test('an agent that decides its own permissions says so, through capabilities and the init event', async () => {
  const { driver, events } = launch({ permissionsByAgent: true });
  const info = await driver.start();
  assert.equal(info.capabilities.permissionsByAgent, true);
  assert.equal((events[0]!.payload as { permissions_by_agent?: boolean }).permissions_by_agent, true);
});

test('permissionsByAgent adds no guard: an ask that does come is still routed to the host', async () => {
  const { driver, asks } = launch({ permissionsByAgent: true, decide: async () => ({ allow: false }) });
  await driver.start();
  await driver.prompt('perm');
  assert.equal(asks.length, 1);
});
