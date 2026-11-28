/**
 * The watch over the merge requests tasks carry: a merge closes the waiting
 * task and frees its dependants, a closure without a merge tells the person
 * once and changes nothing else, a failed reading changes nothing. The forge is
 * simulated (no network): GitLab through the broker's `fetchImpl`, GitHub and
 * the general logic through a stand-in reader. Nothing is ever written to it.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { CHAIN_DONE, dbApi, db } from './db.js';
import { evaluateDeps } from './merge-gate.js';
import { gitlabReader, watchMergeRequests, watchTask, type MergeRequestReader, type WatchDeps } from './merge-request-watch.js';
import { mergeRequestOf } from './merge-request.js';
await import('../tests/helpers/claude-provider.js');

const GITLAB = 'https://gitlab.example.com/group/sub/project/-/merge_requests/7';
const GITHUB = 'https://github.com/ai-timon/timon/pull/12';
const SHA = 'a'.repeat(40);
const TOKEN = 'glpat_a_long_enough_token_value';

function seed(opts: { url?: string; type?: 'code' | 'merge'; status?: 'PENDING' | 'IN_PROGRESS' } = {}): string {
  const id = randomUUID();
  dbApi.createTask(id, `MR task ${id.slice(0, 4)}`, 'witness', { type: opts.type ?? 'code' });
  const url = opts.url ?? GITLAB;
  dbApi.setTaskMergeRequest(id, { url, forge: url.includes('github') ? 'github' : 'gitlab', number: 7, state: 'open', pipeline: null });
  if (opts.status === 'IN_PROGRESS') dbApi.updateTaskStatus(id, 'IN_PROGRESS');
  return id;
}

function deps(reader: MergeRequestReader, notices: string[] = []): WatchDeps {
  return {
    read: { gitlab: reader, github: reader },
    notify: ((title: string) => { notices.push(title); }) as WatchDeps['notify'],
  };
}

test('a merged request closes the waiting task, records the commit and the chip', async () => {
  const id = seed({ status: 'IN_PROGRESS' });
  const out = await watchTask(dbApi.getTask(id)!, deps(async () => ({ ok: true, state: 'merged', mergeSha: SHA })));
  assert.equal(out, 'merged');
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'DONE');
  assert.equal(row.merged_commit_sha, SHA);
  assert.equal(mergeRequestOf(row)!.state, 'merged');
});

test('a dependant task is freed by the automatic close', async () => {
  const id = seed();
  const dependant = randomUUID();
  dbApi.createTask(dependant, 'Dependant', 'witness', { type: 'chore', deps: [id] });
  const gate = () => evaluateDeps(dbApi.getTask(dependant)!, (d) => dbApi.getTask(d));
  assert.equal(gate().ok, false, 'waits while its dependency is open');
  await watchTask(dbApi.getTask(id)!, deps(async () => ({ ok: true, state: 'merged', mergeSha: null })));
  assert.equal(dbApi.getTask(id)!.status, 'DONE');
  assert.equal(gate().ok, true);
  assert.ok(dbApi.listPendingReady().some((t) => t.id === dependant), 'the dependant is dispatchable');
});

test('the forge close settles the chain so no review or merge follows', async () => {
  const id = seed({ status: 'IN_PROGRESS' });
  await watchTask(dbApi.getTask(id)!, deps(async () => ({ ok: true, state: 'merged', mergeSha: null })));
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'DONE');
  assert.equal(row.chain_ran, CHAIN_DONE);
});

test('a task that is neither waiting nor done is not brought back to life', async () => {
  const id = seed();
  // The board has no FAILED status today; the write stands for one.
  db.prepare("UPDATE tasks SET status = 'FAILED' WHERE id = ?").run(id);
  const notices: string[] = [];
  const out = await watchTask(dbApi.getTask(id)!, deps(async () => ({ ok: true, state: 'merged', mergeSha: SHA }), notices));
  assert.equal(out, 'merged');
  const row = dbApi.getTask(id)!;
  assert.equal(row.status as string, 'FAILED');
  assert.equal(mergeRequestOf(row)!.state, 'merged');
  assert.equal(notices.length, 1);
});

test('a lost race writes nothing, not even the commit', async () => {
  const id = seed();
  const stale = dbApi.getTask(id)!;
  dbApi.setTaskMergeRequestState(id, 'closed');
  assert.equal(await watchTask(stale, deps(async () => ({ ok: true, state: 'merged', mergeSha: SHA }))), 'open');
  assert.equal(dbApi.getTask(id)!.merged_commit_sha, null);
});

test('a merge task without a known commit is left alone rather than blocked', async () => {
  const id = seed({ type: 'merge' });
  const out = await watchTask(dbApi.getTask(id)!, deps(async () => ({ ok: true, state: 'merged', mergeSha: null })));
  assert.equal(out, 'unknown');
  const row = dbApi.getTask(id)!;
  assert.notEqual(row.status, 'BLOCKED');
  assert.equal(mergeRequestOf(row)!.state, 'open');
});

test('a request closed without a merge notifies once and leaves the task waiting', async () => {
  const id = seed({ url: GITHUB });
  const notices: string[] = [];
  const reader = deps(async () => ({ ok: true, state: 'closed', mergeSha: null }), notices);
  assert.equal(await watchTask(dbApi.getTask(id)!, reader), 'closed');
  assert.equal(await watchTask(dbApi.getTask(id)!, reader), 'open');
  assert.equal(notices.length, 1);
  const row = dbApi.getTask(id)!;
  assert.notEqual(row.status, 'DONE');
  assert.equal(mergeRequestOf(row)!.state, 'closed');
});

test('a failed reading and a request still open change nothing', async () => {
  const failing = seed();
  const waiting = seed({ url: GITHUB });
  const read: MergeRequestReader = async (ref) =>
    ref.forge === 'gitlab' ? { ok: false, reason: 'boom' } : { ok: true, state: 'open', mergeSha: null };
  const results = await watchMergeRequests(deps(read));
  assert.equal(results.get(failing), 'unknown');
  assert.equal(results.get(waiting), 'open');
  for (const id of [failing, waiting]) {
    assert.equal(mergeRequestOf(dbApi.getTask(id)!)!.state, 'open');
    assert.notEqual(dbApi.getTask(id)!.status, 'DONE');
  }
});

test('GitLab is read with one GET under the vault identity, and the token never surfaces', async () => {
  const secret = dbApi.createSecret({
    name: 'GITLAB_API_TOKEN', value_enc: 'enc:1:iv:tag:gl', mode: 'broker',
    broker_spec: JSON.stringify({
      type: 'http', hosts: ['gitlab.example.com'],
      inject: { kind: 'header', name: 'PRIVATE-TOKEN', template: '{{value}}' },
    }),
  });
  dbApi.addSecretGrant(secret.id, 'global', null);
  const calls: Array<{ url: string; method: string | undefined; auth: string | null }> = [];
  const read = gitlabReader({
    openValue: () => TOKEN,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), method: init?.method, auth: new Headers(init?.headers).get('private-token') });
      return new Response(JSON.stringify({ state: 'merged', merge_commit_sha: SHA, sha: 'b'.repeat(40) }), { status: 200 });
    },
  });
  const ref = mergeRequestOf({ mr_url: GITLAB, mr_forge: 'gitlab', mr_number: 7, mr_state: 'open' })!;
  const out = await read(ref, { agent: 'witness', project: null });
  assert.deepEqual(out, { ok: true, state: 'merged', mergeSha: SHA });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, 'GET');
  assert.equal(calls[0]!.url, 'https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fproject/merge_requests/7');
  assert.equal(calls[0]!.auth, TOKEN);
  assert.equal(JSON.stringify(out).includes(TOKEN), false);

  const refused = await gitlabReader({ openValue: () => TOKEN, fetchImpl: async () => new Response('nope', { status: 401 }) })(ref, { agent: 'witness', project: null });
  assert.deepEqual(refused, { ok: false, reason: 'GitLab answered 401' });
  const closed = await gitlabReader({ openValue: () => TOKEN, fetchImpl: async () => new Response('{"state":"closed"}', { status: 200 }) })(ref, { agent: 'witness', project: null });
  assert.deepEqual(closed, { ok: true, state: 'closed', mergeSha: null });
});
