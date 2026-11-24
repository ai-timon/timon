/**
 * Fallback rule set LIVE: it moves the tasks, right away.
 *
 * The gesture these tests lock is the one of the night of 2026-09-01:
 * `timon series fallback set --scope code --backend claude` set in the middle of the
 * incident. At the time it only WROTE the target: the next task
 * left again under the dead backend, and `backend_override` had to be rewritten
 * task by task. What is checked here, in order: the named scope moves,
 * the others do not, the task blocked by the backend restarts, and a healthy
 * pilot is not swapped on the way.
 *
 * `node --test --import tsx src/series-fallback-hot.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-fallback-hot-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { applySeriesFallbackRule, clearBackendCooldown } = await import('./backend-fallback.js');
const { upsertAgent, killAgent } = await import('./agent.js');
const { getHost } = await import('./host/index.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');

// A pilot's handover only counts once its turn starts: `p.main` can start one,
// on a CLI that stays up, and `p.nameless` (no system prompt) never can.
upsertAgent({ name: 'p.main', system_prompt: 'Test pilot.', config: {
  cwd: process.env.TIMON_HOME, backend: 'claude', model: 'opus', skills: [], mcp_servers: [], memory_scope: 'NONE',
} });
const host = getHost();
const originalSpawn = host.spawn;
host.spawn = (() => {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.exitCode = null; child.signalCode = null;
  child.pid = 4242;
  child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); return true; };
  return child;
}) as typeof host.spawn;
test.after(() => { host.spawn = originalSpawn; });

/** A running series: a pilot, a code part and a review, all on grok. */
function series(opts: { codeStatus?: 'PENDING' | 'BLOCKED'; pilotAgent?: string } = {}) {
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  const codeId = randomUUID();
  const reviewId = randomUUID();
  dbApi.createMission(pilotId, opts.pilotAgent ?? 'p.main', 'pilote de la série'); // french-ok: free-text sample data
  // The pilot runs on grok too: without an explicit backend it would fall back
  // on the repository default, and a switch to claude would be a mere
  // model change; the test would no longer prove anything about the swap.
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  for (const [id, type, title] of [[codeId, 'code', 'volet coder'], [reviewId, 'review', 'review du volet']] as const) {
    dbApi.createTask(id, title, 'p.coder', {
      type, seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
  }
  if (opts.codeStatus === 'BLOCKED') {
    dbApi.setTaskInterrupted(codeId, 'exhausted', 'compte sans crédit (HTTP 402)'); // french-ok: free-text sample data
  }
  return { seriesId, pilotId, codeId, reviewId };
}

test('a rule set live moves the tasks of its scope, and them alone', async () => {
  const { seriesId, codeId, reviewId } = series();
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', 'opus');

  const applied = await applySeriesFallbackRule(seriesId, 'code');

  assert.deepEqual(applied, { backend: 'claude', model: 'opus' });
  assert.equal(dbApi.getTask(codeId)?.backend_override, 'claude');
  assert.equal(dbApi.getTask(codeId)?.model_override, 'opus');
  // The review was not named. Without this guard it would leave anyway,
  // through the wildcard, the equivalence matrix or the global setting: three targets
  // the human did not ask for when typing `--scope code`.
  assert.equal(dbApi.getTask(reviewId)?.backend_override, 'grok');
});

test('a task blocked by the backend goes back in the queue, the rule applied', async () => {
  const { seriesId, codeId } = series({ codeStatus: 'BLOCKED' });
  assert.equal(dbApi.getTask(codeId)?.status, 'BLOCKED');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);

  await applySeriesFallbackRule(seriesId, 'code');

  const moved = dbApi.getTask(codeId);
  assert.equal(moved?.backend_override, 'claude');
  // The heart of the problem fixed here: the rule applied without a requeue
  // leaves the task BLOCKED on a fallback plan already set: movable
  // work nobody moves any more.
  assert.equal(moved?.status, 'PENDING');
  assert.equal(moved?.interrupted_reason, null);
});

test('a healthy pilot is not swapped by a rule aimed at the code', async () => {
  const { seriesId, pilotId } = series();
  clearBackendCooldown('grok');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);

  await applySeriesFallbackRule(seriesId, 'code');

  // `switchMissionBackend` replays the transcript of a LIVE mission: doing
  // it because the coder fallback was set would cut the orchestrator off in
  // the middle of its plan, without anything asking it to.
  assert.equal(dbApi.getMission(pilotId)?.backend_override, 'grok');
});

test('a pilot whose backend is running dry switches, whatever the scope', async () => {
  const { seriesId, pilotId } = series();
  dbApi.setBackendCooldown('grok', Date.now() + 3600_000, 'balance exhausted', false, 'exhausted');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');
  try {
    await applySeriesFallbackRule(seriesId, 'code');
    // With the pilot dead, no task return is handled any more: that is the cascade
    // of the 2026-08-20 incident. It is not left on a dry backend on the
    // pretext that the rule named the coder.
    assert.equal(dbApi.getMission(pilotId)?.backend_override, 'claude');
  } finally {
    clearBackendCooldown('grok');
    await killAgent(pilotId, { source: 'test' });
  }
});

test('a pilot whose fallback cannot start stays where it was, and the tasks still move', async () => {
  const { seriesId, pilotId, codeId } = series({ pilotAgent: 'p.nameless' });
  dbApi.setMissionSession(pilotId, 'pilot-session');
  dbApi.setBackendCooldown('grok', Date.now() + 3600_000, 'balance exhausted', false, 'exhausted');
  dbApi.setSeriesFallback(seriesId, 'code', 'claude', null);
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');
  try {
    await applySeriesFallbackRule(seriesId, 'code');
    // No handover happened: its session stays resumable, and the next wake,
    // still on a dry backend, tries the fallback again.
    const pilot = dbApi.getMission(pilotId);
    assert.equal(pilot?.backend_override, 'grok');
    assert.equal(pilot?.model_override, 'grok-4.6');
    assert.equal(pilot?.session_id, 'pilot-session');
    assert.equal(dbApi.listEvents(pilotId).filter((e) => e.type === 'backend_switch').length, 0);
    assert.equal(dbApi.getTask(codeId)?.backend_override, 'claude');
  } finally {
    clearBackendCooldown('grok');
  }
});

test('the orchestrator scope does target the pilot, and it alone', async () => {
  const { seriesId, pilotId, codeId, reviewId } = series();
  dbApi.setSeriesFallback(seriesId, 'orchestrator', 'claude', 'opus');

  await applySeriesFallbackRule(seriesId, 'orchestrator');

  assert.equal(dbApi.getMission(pilotId)?.backend_override, 'claude');
  assert.equal(dbApi.getMission(pilotId)?.model_override, 'opus');
  // No task moves: `orchestrator` governs no task type, and
  // never falls into the `'*'` wildcard (see `seriesRule`).
  assert.equal(dbApi.getTask(codeId)?.backend_override, 'grok');
  assert.equal(dbApi.getTask(reviewId)?.backend_override, 'grok');
  await killAgent(pilotId, { source: 'test' });
});

/** The Kanban route mounted bare: it is the one carrying the `apply` default. */
async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The series routes refuse an anonymous caller (same guard as `/roles`): the
  // test speaks as the daemon, like the CLI does.
  app.use(createDaemonAuthMiddleware({ token: 'hot-test', required: false }));
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test('the route applies by default, and touches nothing with apply:false', async () => {
  const noApply = series();
  const byDefault = series();

  await withApi(async (base) => {
    const put = (seriesId: string, body: Record<string, unknown>) =>
      fetch(`${base}/api/series/${seriesId}/fallbacks`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', Authorization: 'Bearer hot-test' },
        body: JSON.stringify({ scope: 'code', backend: 'claude', ...body }),
      }).then((r) => r.json() as Promise<{ applied: { backend: string } | null }>);

    // `apply: false`: the rule is written, the running tasks do not move.
    const recorded = await put(noApply.seriesId, { apply: false });
    assert.equal(recorded.applied, null);
    assert.equal(dbApi.getSeriesFallback(noApply.seriesId, 'code')?.backend, 'claude');
    assert.equal(dbApi.getTask(noApply.codeId)?.backend_override, 'grok');

    // Nothing specified: it applies. That is the gesture missed on 2026-09-01.
    const applied = await put(byDefault.seriesId, {});
    assert.equal(applied.applied?.backend, 'claude');
    assert.equal(dbApi.getTask(byDefault.codeId)?.backend_override, 'claude');
  });
});
