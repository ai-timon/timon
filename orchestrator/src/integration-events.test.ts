/**
 * `integration_changed`: every write that moves a job's integration row (its
 * creation, state, pull request, stored checks, landing) publishes once, a
 * write that moves nothing publishes nothing, and the browser stream relays it
 * only to a viewer who may read the job through its routes.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { after, test } from 'node:test';
import type { Request, Response } from 'express';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { sseHandler } from './sse.js';
import type { RequestAuth } from './users/identity.js';

type Change = Extract<BusEvent, { kind: 'integration_changed' }>;

const seen: Change[] = [];
const listen = (ev: BusEvent) => { if (ev.kind === 'integration_changed') seen.push(ev); };
bus.on('event', listen);
after(() => { bus.off('event', listen); });

/** What `fn` published, and only that. */
function published(fn: () => unknown): Change[] {
  const from = seen.length;
  fn();
  return seen.slice(from);
}

const PROJECT = 'integration-events';
dbApi.upsertProject(PROJECT, { cwd: '/tmp/integration-events' });

function job(branch: string, owner: string): { id: string; series: string } {
  const series = randomUUID();
  dbApi.createTask(randomUUID(), `Job ${branch}`, 'acme.coder', {
    type: 'code', project: PROJECT, baseBranch: branch, integrationMode: 'pr', baseRef: 'origin/main',
    seriesId: series, ownerUserId: owner,
  });
  const out = published(() => dbApi.recordIntegration({
    repo: '/tmp/integration-events', branch, remote: 'origin', target: 'main', mode: 'pr', project: PROJECT, seriesId: series,
  }));
  assert.equal(out.length, 1, 'a new row is announced');
  assert.deepEqual(out[0]!.changed, ['created']);
  return { id: out[0]!.integrationId, series };
}

function checks(readAt: number, pending: number): string {
  return JSON.stringify({ read_at: readAt, state: 'open', draft: false, mergeable: 'mergeable', items: [{ name: 'ci', pending }] });
}

test('a new row is announced once, with its ids and state; recording it again is silent', () => {
  const { id, series } = job('feat/created', 'owner-a');
  const [created] = seen.filter((e) => e.integrationId === id);
  assert.deepEqual(
    { project: created!.project, seriesId: created!.seriesId, state: created!.state },
    { project: PROJECT, seriesId: series, state: 'branch' },
  );
  assert.deepEqual(published(() => dbApi.recordIntegration({
    repo: '/tmp/integration-events', branch: 'feat/created', remote: 'origin', target: 'main', mode: 'pr', project: PROJECT,
  })), []);
});

test('each transition of a pull request publishes once, a write that changes nothing publishes nothing', () => {
  const { id } = job('feat/transitions', 'owner-a');
  const opened = published(() => assert.equal(dbApi.markIntegrationOpen(id, { number: 7, url: 'https://github.com/acme/app/pull/7', headSha: 'a'.repeat(40) }), true));
  assert.deepEqual(opened.map((e) => [e.state, e.changed]), [['open', ['state', 'pull_request']]]);
  assert.deepEqual(published(() => dbApi.markIntegrationOpen(id, { number: 8, url: 'https://github.com/acme/app/pull/8', headSha: 'b'.repeat(40) })), []);

  assert.deepEqual(published(() => dbApi.setIntegrationChecks(id, checks(1, 1))).map((e) => e.changed), [['checks']]);
  // The same reading at a later time: the forge said nothing new.
  assert.deepEqual(published(() => dbApi.setIntegrationChecks(id, checks(2, 1))), []);
  assert.deepEqual(published(() => dbApi.setIntegrationChecks(id, checks(3, 0))).map((e) => e.changed), [['checks']]);

  assert.deepEqual(published(() => dbApi.setIntegrationHead(id, 'c'.repeat(40))).map((e) => e.changed), [['pull_request', 'checks']]);
  // Same head, no checks left to forget.
  assert.deepEqual(published(() => dbApi.setIntegrationHead(id, 'c'.repeat(40))), []);
  // Housekeeping columns no screen shows.
  assert.deepEqual(published(() => dbApi.touchIntegrationPolled(id)), []);

  assert.deepEqual(published(() => dbApi.markIntegrationMerged(id, 'd'.repeat(40))).map((e) => [e.state, e.changed]), [['merged', ['state']]]);
  assert.deepEqual(published(() => dbApi.markIntegrationMerged(id, null)), []);
  assert.deepEqual(published(() => dbApi.claimIntegrationNotice(id, 'merged')), []);

  assert.deepEqual(published(() => dbApi.claimIntegrationLanding(id)).map((e) => e.changed), [['landed']]);
  assert.deepEqual(published(() => dbApi.claimIntegrationLanding(id)), []);
  assert.deepEqual(published(() => dbApi.releaseIntegrationLanding(id)).map((e) => e.changed), [['landed']]);
  assert.deepEqual(published(() => dbApi.releaseIntegrationLanding(id)), []);
});

test('a pull request closed without its merge publishes its new state once', () => {
  const { id } = job('feat/closed', 'owner-a');
  assert.deepEqual(published(() => dbApi.markIntegrationClosed(id)), [], 'never opened: nothing to close');
  dbApi.markIntegrationOpen(id, { number: 9, url: 'https://github.com/acme/app/pull/9', headSha: 'e'.repeat(40) });
  assert.deepEqual(published(() => dbApi.markIntegrationClosed(id)).map((e) => [e.state, e.changed]), [['closed', ['state']]]);
  assert.deepEqual(published(() => dbApi.markIntegrationClosed(id)), []);
});

// ─── The browser stream ─────────────────────────────────────────────────────

function stream(auth: RequestAuth | null, missionId = ''): { frames: () => string; close: () => void } {
  const chunks: string[] = [];
  const res = new EventEmitter() as unknown as Response & EventEmitter;
  Object.assign(res, {
    set: () => res,
    flushHeaders: () => {},
    write: (s: string) => { chunks.push(s); return true; },
    status() { return res; },
    json() { return res; },
  });
  const req = new EventEmitter() as unknown as Request & EventEmitter;
  Object.assign(req, { params: { id: missionId }, query: {}, ...(auth ? { auth } : {}) });
  sseHandler(req, res);
  return { frames: () => chunks.join(''), close: () => { (req as unknown as EventEmitter).emit('close'); } };
}

const reader = (actorId: string): RequestAuth => ({
  kind: 'api-token', user: null, isSuperadmin: false, actorId, permissions: ['kanban:read'],
});

test('the stream relays a job\'s change to whoever may read the job, and to no one else', () => {
  const owner = stream(reader('owner-a'));
  const stranger = stream(reader('owner-b'));
  const admin = stream({ kind: 'daemon-token', user: null, isSuperadmin: true });
  const anonymous = stream(null);
  try {
    const { id } = job('feat/stream', 'owner-a');
    dbApi.markIntegrationOpen(id, { number: 11, url: 'https://github.com/acme/app/pull/11', headSha: 'f'.repeat(40) });

    const frames = owner.frames().split('\n\n').filter((f) => f.startsWith('event: integration_changed'));
    assert.equal(frames.length, 2, 'created, then opened');
    const body = JSON.parse(frames[1]!.split('\ndata: ')[1]!) as Record<string, unknown>;
    assert.deepEqual(body, {
      kind: 'integration_changed', integrationId: id, project: PROJECT,
      seriesId: dbApi.getIntegrationById(id)!.series_id, state: 'open', changed: ['state', 'pull_request'],
    });
    assert.ok(!owner.frames().includes('/tmp/integration-events'), 'the repository path stays on the daemon');
    assert.ok(admin.frames().includes(`"integrationId":"${id}"`));
    assert.ok(!stranger.frames().includes('integration_changed'), 'another account never hears of the job');
    assert.ok(!anonymous.frames().includes('integration_changed'));
  } finally {
    for (const s of [owner, stranger, admin, anonymous]) s.close();
  }
});

test('a mission\'s own stream never carries a job\'s change', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.coder', 'a mission', undefined, 'owner-a');
  const s = stream(reader('owner-a'), missionId);
  try {
    job('feat/mission-stream', 'owner-a');
    assert.ok(!s.frames().includes('integration_changed'));
  } finally {
    s.close();
  }
});
