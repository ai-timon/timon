/**
 * TIM-0109 — marking a blocked task merged outside Timon: who is offered the
 * action, what reaches the daemon, and how its refusals come back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMarkMerged, isCommitSha, markTaskMerged } from './mark-merged';

test('a blocked code or merge task offers the action', () => {
  assert.equal(canMarkMerged({ type: 'code', status: 'BLOCKED' }), true);
  assert.equal(canMarkMerged({ type: 'merge', status: 'BLOCKED' }), true);
  assert.equal(canMarkMerged({ type: 'code', status: 'PENDING' }), false);
  assert.equal(canMarkMerged({ type: 'review', status: 'BLOCKED' }), false);
  assert.equal(canMarkMerged({ status: 'BLOCKED' }), false);
});

test('a done code task offers it only while its chain has not landed', () => {
  assert.equal(canMarkMerged({ type: 'code', status: 'DONE', awaiting_merge: true }), true);
  assert.equal(canMarkMerged({ type: 'code', status: 'DONE' }), false);
  assert.equal(canMarkMerged({ type: 'code', status: 'DONE', awaiting_merge: false }), false);
  assert.equal(canMarkMerged({ type: 'review', status: 'DONE', awaiting_merge: true }), false);
});

test('a commit sha is 7 to 40 hex characters, spaces around ignored', () => {
  assert.equal(isCommitSha(' bcd02520 '), true);
  assert.equal(isCommitSha('a'.repeat(40)), true);
  assert.equal(isCommitSha('abc12'), false);
  assert.equal(isCommitSha('a'.repeat(41)), false);
  assert.equal(isCommitSha('main'), false);
});

test('the request posts the trimmed sha to the task route and reads the verdict', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const ok = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify({ verified: false }), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await markTaskMerged('t/1', ' bcd02520 ', ok), { ok: true, verified: false });
  assert.deepEqual(calls, [{ url: '/api/ui/tasks/t%2F1/mark-merged', body: { sha: 'bcd02520' } }]);
});

test('a refusal keeps its code and a readable message, its params or the daemon English; a network failure has neither', async () => {
  const refused = (async () => new Response(
    JSON.stringify({ error: 'Commit x is not in main', code: 'sha_not_in_base' }), { status: 409 },
  )) as typeof fetch;
  assert.deepEqual(await markTaskMerged('t', 'abcdef1', refused),
    { ok: false, code: 'sha_not_in_base', message: 'Commit x is not in main' });
  const worded = (async () => new Response(JSON.stringify({
    error: 'Commit abcdef1 is not in main', code: 'sha_not_in_base', params: { sha: 'abcdef1', base: 'main' },
  }), { status: 409 })) as typeof fetch;
  assert.deepEqual(await markTaskMerged('t', 'abcdef1', worded), {
    ok: false, code: 'sha_not_in_base',
    message: 'Commit abcdef1 is not in main of this repository. Check the sha of the merge.',
  });
  const down = (async () => { throw new Error('offline'); }) as typeof fetch;
  assert.deepEqual(await markTaskMerged('t', 'abcdef1', down), { ok: false, code: null, message: null });
});
