import './test-home.js';
import '../tests/helpers/unfenced.js';
import '../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_FALLBACK_ENABLED = '1';
const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, sendToAgent, switchMissionBackend, BackendExhaustedError } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { backendNames } = await import('./backends/index.js');
const { invalidateSettingsCache } = await import('./settings.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');

// The rejection emitted by mission 6582633f on 2026-10-05, reduced to the
// provider's quota fields. Its process remains alive after this failed result.
const REJECTED = { type: 'rate_limit_event', rate_limit_info: {
  status: 'rejected', resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour',
} };
const RESULT = { type: 'result', subtype: 'success', is_error: true, api_error_status: 429,
  result: "You've hit your session limit · resets 6:40pm (Europe/Paris)",
  usage: { input_tokens: 0, output_tokens: 0 }, session_id: 'dry-session', num_turns: 1 };

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Chat fallback timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('quota rejection resumes the same chat once, with its history and permissions', { timeout: 20000 }, async () => {
  const host = getHost();
  const original = host.spawn;
  const children: { child: ChildProcessWithoutNullStreams; env: NodeJS.ProcessEnv; input: string[]; args: readonly string[] }[] = [];
  host.spawn = ((_cmd, _args, options) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 4242; child.exitCode = null; child.signalCode = null;
    const input: string[] = [];
    child.stdin.on('data', (data: Buffer) => input.push(data.toString()));
    child.kill = () => {
      child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true;
    };
    children.push({ child, env: options?.env ?? {}, input, args: _args ?? [] });
    return child;
  }) as typeof host.spawn;
  const emit = (child: ChildProcessWithoutNullStreams, event: unknown) =>
    child.stdout.emit('data', Buffer.from(JSON.stringify(event) + '\n'));
  const create = async (name: string) => {
    for (const backend of backendNames()) clearBackendCooldown(backend);
    upsertAgent({ name, system_prompt: 'Test chat agent.', config: {
      cwd: process.env.TIMON_HOME, backend: 'claude', model: 'sonnet',
      skills: [], mcp_servers: [], memory_scope: 'NONE', permission_mode: 'acceptEdits',
    } });
    const id = await spawnAgent(name, 'Keep the release plan and answer my last question.');
    const child = children.at(-1)!.child;
    // A plan can exist before a coordinator creates its first task.
    dbApi.setSeriesFallback(id, 'orchestrator', 'codex', 'gpt-6.1-sol');
    emit(child, { type: 'system', subtype: 'init', session_id: 'original-session' });
    emit(child, { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'The release plan is ready.' }] } });
    emit(child, { type: 'result', is_error: false, result: 'The release plan is ready.' });
    return { id, child };
  };
  try {
    const { id, child } = await create('quota-chat');
    await sendToAgent(id, 'Which release is next?');
    const before = children.length;
    emit(child, REJECTED);
    assert.equal(children.length, before, 'the quota event must not cut the active turn');
    emit(child, RESULT);
    emit(child, RESULT);
    assert.equal(await sendToAgent(id, 'A concurrent follow-up'), 'turn_in_flight');
    await assert.rejects(switchMissionBackend(id, { backend: 'codex', model: 'gpt-6.1-sol' }), /switch is in progress/);
    await until(() => children.length === before + 1);
    const replacement = children.at(-1)!;
    const mission = dbApi.getMission(id)!;
    assert.equal(mission.backend_override, 'codex');
    assert.equal(mission.model_override, 'gpt-6.1-sol');
    assert.equal(mission.status, 'running');
    assert.equal(replacement.env.TIMON_MISSION_ID, id);
    assert.ok(replacement.args.includes('workspace-write'), 'the configured privilege level must cross the handover');
    assert.equal(mission.permission_mode_override, null);
    assert.match(replacement.input.join(''), /The release plan is ready/);
    assert.match(replacement.input.join(''), /Which release is next/);
    const events = dbApi.listEvents(id);
    assert.equal(events.filter((e) => e.type === 'backend_switch').length, 1);
    assert.equal(events.filter((e) => e.type === 'user').length, 2, 'history must not be duplicated');
    assert.equal(dbApi.listMissions(100, ['quota-chat']).length, 1);
    emit(replacement.child, { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } });
    assert.equal(dbApi.getMission(id)!.interrupted_reason, null);
    replacement.child.kill();

    const refused = await create('quota-refused');
    dbApi.setSeriesFallback(refused.id, 'orchestrator', null, null);
    const count = children.length;
    emit(refused.child, REJECTED); emit(refused.child, RESULT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(children.length, count, 'an explicit refusal must be respected');
    assert.equal(dbApi.getMission(refused.id)!.interrupted_reason, 'rate_limit');
    const written = children.at(-1)!.input.length;
    await assert.rejects(sendToAgent(refused.id, 'Do not write to the dry CLI'), BackendExhaustedError);
    assert.equal(children.at(-1)!.input.length, written);
    await switchMissionBackend(refused.id, { backend: 'codex', model: 'gpt-6.1-sol',
      message: 'The next question must survive replay.', inputOrigin: null });
    const freshInput = dbApi.listEvents(refused.id).filter((e) => e.type === 'user').at(-1)!;
    assert.equal(JSON.parse(freshInput.payload).message.content, 'The next question must survive replay.');
    children.at(-1)!.child.kill();

    const dryBackup = await create('quota-dry-backup');
    for (const backend of backendNames()) {
      if (backend !== 'claude') dbApi.setBackendCooldown(backend, Date.now() + 3600_000, 'five_hour', true, 'rate_limit');
    }
    const dryCount = children.length;
    emit(dryBackup.child, REJECTED); emit(dryBackup.child, RESULT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(children.length, dryCount, 'a dry backup must not start a retry loop');
    dryBackup.child.kill();

    const queued = await create('quota-queued');
    const queuedCount = children.length;
    emit(queued.child, { ...REJECTED, rate_limit_info: { ...REJECTED.rate_limit_info, status: 'queued' } });
    emit(queued.child, { type: 'result', is_error: false });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(children.length, queuedCount, 'a queued request is not replayed');
    queued.child.kill();

    const guarded = await create('quota-known-dry');
    noteBackendRateLimit('claude', { kind: 'rate_limit', window: 'five_hour', resetsAt: Date.now() + 3600_000, source: 'event', pending: false });
    await assert.rejects(sendToAgent(guarded.id, 'A known-dry backend must be refused before writing'), BackendExhaustedError);
    guarded.child.kill();

    // A breaker cooldown is not a quota, and the refusal must not claim one (TIM-0111).
    dbApi.setBackendCooldown('claude', Date.now() + 1_800_000, 'circuit breaker', false, 'unavailable');
    assert.match(new BackendExhaustedError('claude').message, /^backend claude is sidelined by the circuit breaker until .+ — turn refused before spawn$/);
    noteBackendRateLimit('claude', { kind: 'rate_limit', window: 'five_hour', resetsAt: Date.now() + 3600_000, source: 'event', pending: false });
    assert.equal(new BackendExhaustedError('claude').message, 'backend claude has no quota — turn refused before spawn');

    const disabled = await create('quota-disabled');
    process.env.TIMON_FALLBACK_ENABLED = '0';
    invalidateSettingsCache();
    const disabledCount = children.length;
    emit(disabled.child, REJECTED); emit(disabled.child, RESULT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(children.length, disabledCount, 'disabled fallback must leave the chat paused');
    disabled.child.kill();
    process.env.TIMON_FALLBACK_ENABLED = '1';
    invalidateSettingsCache();

    const exhausted = await create('chat-credit-exhausted');
    const exhaustedCount = children.length;
    emit(exhausted.child, { ...RESULT, api_error_status: 402 });
    await until(() => children.length === exhaustedCount + 1);
    assert.equal(dbApi.getMission(exhausted.id)!.backend_override, 'codex');
    children.at(-1)!.child.kill();

    const task = await create('quota-task');
    const taskId = randomUUID();
    dbApi.createTask(taskId, 'Task retry is owned by the dispatcher', 'quota-task', { type: 'code' });
    dbApi.assignTaskMission(taskId, task.id);
    const taskCount = children.length;
    emit(task.child, REJECTED); emit(task.child, RESULT);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(children.length, taskCount, 'chat fallback must not duplicate the task dispatcher');
    task.child.kill();
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill();
    for (const backend of backendNames()) clearBackendCooldown(backend);
    process.env.TIMON_FALLBACK_ENABLED = '1';
    invalidateSettingsCache();
    host.spawn = original;
  }
});
