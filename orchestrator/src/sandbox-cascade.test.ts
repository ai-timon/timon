/**
 * TIM-0121, part B: a review or merge that stays on the backend whose sandbox
 * the coder was moved away from is named, with the commands that move it.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi, type TaskType } from './db.js';
import { agentDir } from './paths.js';
import { looksLikeSandboxFailure, sandboxCascadeNotice, warnSandboxCascadeAhead } from './sandbox-cascade.js';

{
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const PROJECT = 'cascade';
for (const role of ['coder', 'reviewer', 'merger']) {
  const name = `${PROJECT}.${role}`;
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ role, project: PROJECT, backend: 'codex' }));
  writeFileSync(join(agentDir(name), 'system-prompt.md'), role);
}
const AGENT: Record<string, string> = { code: 'cascade.coder', review: 'cascade.reviewer', merge: 'cascade.merger' };

function task(type: TaskType, opts: { seriesId?: string | null; deps?: string[]; backend?: string; status?: 'BLOCKED'; reason?: string } = {}) {
  const id = randomUUID();
  dbApi.createTask(id, `${type} witness`, AGENT[type] ?? 'cascade.coder', {
    type, project: PROJECT, seriesId: opts.seriesId ?? null, deps: opts.deps ?? [],
    backendOverride: opts.backend ?? null,
  });
  if (opts.status) dbApi.updateTaskStatus(id, opts.status, { blockedReason: opts.reason ?? null });
  return dbApi.getTask(id)!;
}

const SANDBOX_REASON = 'codex: windows unelevated restricted-token sandbox cannot reopen writable descendants under read-only carveouts directly; refusing to run unsandboxed';

test('sandbox refusals are recognised, other blockages are not', () => {
  for (const text of [
    SANDBOX_REASON,
    'exec failed: blocked by policy',
    "fatal: Unable to create '/r/.git/index.lock': Read-only file system",
    'process exited with code -1073741502',
    'Sandbox read-only forcé : toute écriture est refusée (403)', // french-ok: a French sandbox message the detector reads
    'Every write was denied by the sandbox.',
  ]) assert.equal(looksLikeSandboxFailure(text), true, text);
  for (const text of [
    null, '', 'You exceeded your current quota', 'merge conflict on src/a.ts',
    'tests fail on main', 'Verification loop: cap of 3 iterations reached',
  ]) assert.equal(looksLikeSandboxFailure(text), false, String(text));
});

test('a review blocked on its sandbox while the coder ran elsewhere names the cascade and the series commands', () => {
  const seriesId = randomUUID();
  dbApi.setSeriesRole(seriesId, 'code', 'claude', null);
  const code = task('code', { seriesId });
  const review = task('review', { seriesId, deps: [code.id], status: 'BLOCKED', reason: SANDBOX_REASON });
  const notice = sandboxCascadeNotice(review, SANDBOX_REASON);
  assert.match(notice, /Sandbox failure on `codex` while the code of this chain ran on `claude`/);
  assert.ok(notice.includes(`timon series role set --scope review --backend claude --series ${seriesId}`));
  assert.ok(notice.includes(`timon series role set --scope merge --backend claude --series ${seriesId}`));

  // The merge is one review away from the code.
  const passed = task('review', { seriesId, deps: [code.id] });
  const merge = task('merge', { seriesId, deps: [passed.id], status: 'BLOCKED', reason: 'blocked by policy' });
  assert.match(sandboxCascadeNotice(merge, 'blocked by policy'), /ran on `claude`/);
});

test('the backend a mission actually ran on wins over the resolution (a quota redirect)', () => {
  const code = task('code');
  const mission = randomUUID();
  dbApi.createMission(mission, 'cascade.coder', 'witness', { channel: 'dispatcher' });
  dbApi.setMissionLlmOverrides(mission, 'claude', null);
  dbApi.assignTaskMission(code.id, mission);
  const review = task('review', { deps: [code.id], status: 'BLOCKED', reason: SANDBOX_REASON });
  const notice = sandboxCascadeNotice(review, SANDBOX_REASON);
  assert.match(notice, /ran on `claude`/);
  assert.match(notice, /backend_override=claude/, 'outside a series, the task override is the lever');
});

test('silent when the coder shared the backend, when the reason is not the sandbox, or for a code task', () => {
  const code = task('code');
  const sameBackend = task('review', { deps: [code.id], status: 'BLOCKED', reason: SANDBOX_REASON });
  assert.equal(sandboxCascadeNotice(sameBackend, SANDBOX_REASON), '');

  const moved = task('code', { backend: 'claude' });
  const conflict = task('merge', { deps: [moved.id], status: 'BLOCKED', reason: 'merge conflict on a.ts' });
  assert.equal(sandboxCascadeNotice(conflict, 'merge conflict on a.ts'), '');

  const codeBlocked = task('code', { backend: 'claude', status: 'BLOCKED', reason: SANDBOX_REASON });
  assert.equal(sandboxCascadeNotice(codeBlocked, SANDBOX_REASON), '');
});

test('a review created on a backend a series task just blocked on for its sandbox raises an alert', () => {
  const seriesId = randomUUID();
  task('code', { seriesId, status: 'BLOCKED', reason: SANDBOX_REASON }); // the first attempt, on codex
  const retry = task('code', { seriesId, backend: 'claude' });
  const review = task('review', { seriesId, deps: [retry.id] });
  const text = warnSandboxCascadeAhead(review);
  assert.ok(text, 'warned');
  assert.match(text, /Sandbox failure on `codex` while the code of this chain ran on `claude`/);
  assert.match(text, /Blocked on its sandbox in this series/);

  // Nothing to say in a series with no sandbox blockage on that backend.
  const calm = randomUUID();
  const ok = task('code', { seriesId: calm, backend: 'claude' });
  assert.equal(warnSandboxCascadeAhead(task('review', { seriesId: calm, deps: [ok.id] })), null);
});

test('the "Task blocked" notification of such a review carries the notice under its reason', async () => {
  const { startNotificationResolver } = await import('./notifications.js');
  const stop = startNotificationResolver();
  try {
    const seriesId = randomUUID();
    dbApi.setSeriesRole(seriesId, 'code', 'claude', null);
    const code = task('code', { seriesId });
    const review = task('review', { seriesId, deps: [code.id], status: 'BLOCKED', reason: SANDBOX_REASON });
    const card = dbApi.listActiveNotifications('alert').find((n) => n.task_id === review.id);
    assert.ok(card, 'alert created');
    assert.ok(card.body?.startsWith(SANDBOX_REASON), 'the reason stays first');
    assert.match(card.body ?? '', /--scope merge --backend claude/);
  } finally {
    stop();
  }
});
