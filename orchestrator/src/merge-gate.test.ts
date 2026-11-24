/**
 * Tests of the dispatch gate (merge-gate.ts).
 *
 * `node --test --import tsx src/merge-gate.test.ts` (or `npm test`). The tested
 * module has no runtime import besides the verdict parser: nothing opens the
 * SQLite database or spawns a process.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDeps, repairWaitStall, REPAIR_WAIT_BLOCK_MS } from './merge-gate.js';
import type { TaskRow } from './db.js';

type Dep = Pick<TaskRow, 'id' | 'type' | 'status' | 'done_comment'>;

function lookup(...deps: Dep[]): (id: string) => Dep | undefined {
  return (id) => deps.find((d) => d.id === id);
}

function review(id: string, doneComment: string | null, status: TaskRow['status'] = 'DONE'): Dep {
  return { id, type: 'review', status, done_comment: doneComment };
}

type ChainDep = Dep & Partial<Pick<TaskRow, 'iteration' | 'verification_root_id'>>;

/** Review attached to a verification chain (`verification_root_id`), with
 *  its iteration: that is what the verification-loop produces. */
function chainReview(
  id: string,
  rootId: string,
  iteration: number,
  doneComment: string | null,
  status: TaskRow['status'] = 'DONE',
): ChainDep {
  return { ...review(id, doneComment, status), iteration, verification_root_id: rootId };
}

/** Chain lookup as the dispatcher injects it (dbApi.listTasksByVerificationRoot). */
function chain(...tasks: ChainDep[]): (rootId: string) => ChainDep[] {
  return (rootId) => tasks.filter((t) => t.verification_root_id === rootId);
}

/** done_comment as the review contract asks for it (1st line in plain text,
 *  optional JSON behind): that is the shape the verification-loop produces. */
const PASS_COMMENT = 'verdict: pass\n\n```json\n{"findings": [], "suggested_fixes": ""}\n```';

test('merge dispatched when the review has the pass verdict', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', PASS_COMMENT)),
  );
  assert.deepEqual(gate, { ok: true });
});

test('merge held back when the review asks for changes', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', 'verdict: changes_requested\n\nN+1 sur le checkout.')),
  );
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? (gate.blockedReason ?? '') : '', /changes_requested/);
  // The code stored beside the reason carries the same review and finding (TODO #1063).
  assert.deepEqual(gate.ok === false ? gate.blockedReasonCode : null, {
    code: 'merge_held_changes_requested',
    params: { reviewId: 'r1', finding: 'verdict: changes_requested\n\nN+1 sur le checkout.' },
  });
});

test('merge held back when the review is DONE without a usable verdict', () => {
  for (const comment of [null, '', 'RAS, ça me semble bien.', '{"verdit": "pass"']) { // french-ok: a free-text review comment
    const gate = evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(review('r1', comment)));
    assert.equal(gate.ok, false, `comment=${JSON.stringify(comment)}`);
    assert.match(
      gate.ok === false ? (gate.blockedReason ?? '') : '',
      /NO usable verdict/,
      `comment=${JSON.stringify(comment)}`,
    );
    assert.deepEqual(gate.ok === false ? gate.blockedReasonCode : null, {
      code: 'merge_held_no_verdict',
      params: { reviewId: 'r1' },
    });
  }
});

test('review not DONE yet: normal wait, without a block reason', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(review('r1', null, 'IN_PROGRESS')),
  );
  assert.deepEqual(gate, { ok: false, blockedReason: null });
});

test('non-regression: code/chore depending on a review keep the DONE behaviour', () => {
  for (const type of ['code', 'chore', 'doc'] as const) {
    for (const comment of [PASS_COMMENT, 'verdict: changes_requested', null]) {
      const gate = evaluateDeps({ type, deps: '["r1"]' }, lookup(review('r1', comment)));
      assert.deepEqual(gate, { ok: true }, `${type} / ${JSON.stringify(comment)}`);
    }
  }
});

test('non-regression: missing, empty or unreadable deps do not block', () => {
  assert.deepEqual(evaluateDeps({ type: 'merge', deps: '[]' }, lookup()), { ok: true });
  assert.deepEqual(evaluateDeps({ type: 'merge', deps: 'pas du json' }, lookup()), { ok: true });
});

test('multi-dep merge: one DONE code dep + one pass review → dispatched', () => {
  const gate = evaluateDeps(
    { type: 'merge', deps: '["c1","r1"]' },
    lookup({ id: 'c1', type: 'code', status: 'DONE', done_comment: 'fait' }, review('r1', PASS_COMMENT)),
  );
  assert.deepEqual(gate, { ok: true });
});

// --- Chain guard: a single live review authorises the merge -----------
// nimbus incident of 2026-08-15: two `iter:4` reviews in parallel on the same
// commit 224c7ec, one `pass` (which triggered the merge) and the other
// `changes_requested`, whose finding was real and had to be caught up after
// the fact. The damage is not the duplicate, it is the merge leaving on the verdict of
// only one of the two live reviews.

const CR_COMMENT = 'verdict: changes_requested\n\n```json\n{"suggested_fixes": "gate le spawn sur la chaîne"}\n```'; // french-ok: a free-text review finding

test('nimbus incident: two reviews on the same chain, pass + changes_requested → merge held back', () => {
  const passing = chainReview('ec367332', 'root1', 4, PASS_COMMENT);
  const dissident = chainReview('997a618f', 'root1', 4, CR_COMMENT);
  const gate = evaluateDeps(
    { type: 'merge', deps: '["ec367332"]' },
    lookup(passing),
    chain(passing, dissident),
  );
  assert.equal(gate.ok, false);
  const reason = gate.ok === false ? (gate.blockedReason ?? '') : '';
  assert.match(reason, /997a618f/, 'the dissenting review must be named');
  assert.match(reason, /changes_requested/);
  assert.match(reason, /gate le spawn sur la chaîne/, 'its finding must be quoted'); // french-ok: a free-text review finding
});

test('nominal case: a single pass review on the chain → merge dispatched', () => {
  const only = chainReview('r1', 'root1', 1, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(only), chain(only)),
    { ok: true },
  );
});

test('competing review still live: wait, never BLOCKED', () => {
  for (const status of ['PENDING', 'IN_PROGRESS', 'BLOCKED'] as const) {
    const passing = chainReview('r1', 'root1', 2, PASS_COMMENT);
    const other = chainReview('r2', 'root1', 2, null, status);
    const gate = evaluateDeps(
      { type: 'merge', deps: '["r1"]' },
      lookup(passing),
      chain(passing, other),
    );
    assert.deepEqual(gate, { ok: false, blockedReason: null }, `status=${status}`);
  }
});

test('earlier iterations ignored: a past changes_requested does not block the merge', () => {
  // Healthy chain: iter 1 asked for changes (that is what created iter 2),
  // iter 2 approves. Counting iter 1 would block every legitimate merge.
  const old = chainReview('r1', 'root1', 1, CR_COMMENT);
  const fresh = chainReview('r2', 'root1', 2, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r2"]' }, lookup(fresh), chain(old, fresh)),
    { ok: true },
  );
});

test('more recent iteration not finished: the verdict the merge depends on is stale', () => {
  const stale = chainReview('r1', 'root1', 1, PASS_COMMENT);
  const newer = chainReview('r2', 'root1', 2, null, 'IN_PROGRESS');
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(stale), chain(stale, newer)),
    { ok: false, blockedReason: null },
  );
});

test('sister review DONE without a usable verdict → merge held back and review named', () => {
  const passing = chainReview('r1', 'root1', 3, PASS_COMMENT);
  const mute = chainReview('r2', 'root1', 3, 'RAS pour moi');
  const gate = evaluateDeps(
    { type: 'merge', deps: '["r1"]' },
    lookup(passing),
    chain(passing, mute),
  );
  assert.equal(gate.ok, false);
  assert.match(gate.ok === false ? (gate.blockedReason ?? '') : '', /r2.*NO usable verdict/s);
});

test('non-regression: tasks of neighbouring chains invisible to each other', () => {
  const mine = chainReview('r1', 'root1', 1, PASS_COMMENT);
  const other = chainReview('r9', 'root2', 1, CR_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(mine), chain(mine, other)),
    { ok: true },
  );
});

test('non-regression: review outside a chain (verification_root_id missing) → no chain guard', () => {
  const orphan = review('r1', PASS_COMMENT);
  const noise = chainReview('r2', 'root1', 1, CR_COMMENT);
  assert.deepEqual(
    evaluateDeps({ type: 'merge', deps: '["r1"]' }, lookup(orphan), chain(noise)),
    { ok: true },
  );
});

// --- Dependency guard: a `code` dep (full pipeline) waits for the merge ----
// ACP work of 29/09/2026: a `code` task goes DONE before its review and
// its merge exist; a dependent started on a `main` without its work.

type Full = ChainDep & Partial<Pick<TaskRow, 'pipeline' | 'branch_name' | 'worktree_path' | 'deps' | 'merged_commit_sha'>>;

/** Root `code` task of a chain (verification_root_id null, as in the database). */
function codeDep(id: string, extra: Partial<Full> = {}): Full {
  return {
    id,
    type: 'code',
    status: 'DONE',
    done_comment: 'fait',
    pipeline: null,
    branch_name: `timon/task/${id}`,
    worktree_path: `/wt/${id}`,
    ...extra,
  };
}

function mergeOf(id: string, reviewId: string, status: TaskRow['status'] = 'DONE'): Full {
  // The verification-loop never labels a merge task.
  return { id, type: 'merge', status, done_comment: null, deps: JSON.stringify([reviewId]) };
}

/** Chain lookup like `dbApi.listVerificationChain`: every task provided. */
function wholeChain(...tasks: Full[]): () => Full[] {
  return () => tasks;
}

function waiting(gate: ReturnType<typeof evaluateDeps>): string {
  assert.equal(gate.ok, false);
  assert.ok(!gate.ok && gate.blockedReason === null, 'wait, never BLOCKED');
  return !gate.ok ? (gate.waitingFor ?? '') : '';
}

const DEPENDENT = { type: 'chore' as const, deps: '["c1"]' };

test('full code dep without a created chain: readable wait', () => {
  const c1 = codeDep('c1');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1))), /review has not been created/);
});

test('full code dep: review in progress → wait', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, null, 'IN_PROGRESS');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1))), /review r1 .* IN_PROGRESS/);
});

test('full code dep: review pass but merge not created yet or not DONE → wait', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1))), /merge has not been created/);
  for (const status of ['PENDING', 'IN_PROGRESS', 'BLOCKED'] as const) {
    const gate = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1', status)));
    assert.match(waiting(gate), new RegExp(`merge m1 .* ${status}`), status);
  }
});

test('full code dep with a DONE merge → satisfied', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.deepEqual(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1'))),
    { ok: true },
  );
});

test('full code dep: chain in changes_requested or unreadable review → wait, not BLOCKED', () => {
  const c1 = codeDep('c1');
  const cr = chainReview('r1', 'c1', 1, CR_COMMENT);
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr))), /requested changes/);
  const mute = chainReview('r1', 'c1', 1, 'RAS');
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, mute))), /no usable verdict/);
});

test('full code dep: the merge of the last iteration prevails', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, CR_COMMENT);
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1' };
  const r2 = chainReview('r2', 'c1', 2, PASS_COMMENT);
  // iter 2 in progress: wait
  const running = { ...c2, status: 'IN_PROGRESS' as const };
  assert.match(waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, running))), /repair iteration 2/);
  // iter 2 approved, merge in progress: wait
  assert.match(
    waiting(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, c2, r2, mergeOf('m2', 'r2', 'PENDING')))),
    /merge m2/,
  );
  // A DONE merge of iteration 1 (earlier pass review) is not enough if iter 2 exists.
  const r1pass = chainReview('r1', 'c1', 1, PASS_COMMENT);
  assert.equal(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1pass, mergeOf('m1', 'r1'), c2)).ok,
    false,
  );
  // iter 2 merged: satisfied.
  assert.deepEqual(
    evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1, c2, r2, mergeOf('m2', 'r2'))),
    { ok: true },
  );
});

test('TIM-0109: full code dep marked as merged outside Timon → satisfied without a chain merge', () => {
  const c1 = codeDep('c1', { merged_commit_sha: 'abcdef1' });
  const r1 = chainReview('r1', 'c1', 1, CR_COMMENT);
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, r1)), { ok: true });
  // The escalated iteration of the chain was the one marked merged.
  const root = codeDep('c1');
  const c3 = { ...codeDep('c3', { merged_commit_sha: 'abcdef1' }), iteration: 3, verification_root_id: 'c1' };
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(root), wholeChain(root, r1, c3)), { ok: true });
  // A sha on an iteration that is not DONE does not count.
  const open = { ...c3, status: 'BLOCKED' as const };
  assert.equal(evaluateDeps(DEPENDENT, lookup(root), wholeChain(root, r1, open)).ok, false);
});

test('full code dep of iteration 2: the chain resolves through its verification_root_id', () => {
  const c1 = codeDep('c1');
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1' };
  const r2 = chainReview('r2', 'c1', 2, PASS_COMMENT);
  const seen: string[] = [];
  const gate = evaluateDeps(
    { type: 'chore', deps: '["c2"]' },
    lookup(c2),
    (rootId) => {
      seen.push(rootId);
      return [c1, c2, r2, mergeOf('m2', 'r2')];
    },
  );
  assert.deepEqual(gate, { ok: true });
  assert.deepEqual(seen, ['c1']);
});

test('full code dep: code, chore or research dependents all wait for the merge', () => {
  const c1 = codeDep('c1');
  for (const type of ['code', 'chore', 'research'] as const) {
    assert.equal(evaluateDeps({ type, deps: '["c1"]' }, lookup(c1), wholeChain(c1)).ok, false, type);
  }
});

test('non-regression: code-self and code-group unchanged (DONE is enough)', () => {
  for (const pipeline of ['code-self', 'code-group']) {
    const c1 = codeDep('c1', { pipeline });
    assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: true }, pipeline);
  }
});

test('non-regression: the chain itself does not wait on itself (review, merge, doc depending on the code)', () => {
  const c1 = codeDep('c1');
  for (const type of ['review', 'merge', 'doc'] as const) {
    assert.deepEqual(
      evaluateDeps({ type, deps: '["c1"]' }, lookup(c1), wholeChain(c1)),
      { ok: true },
      type,
    );
  }
});

test('the merge that opens a pull request waits for the merges of its code deps', () => {
  const c1 = codeDep('c1');
  const r1 = chainReview('r1', 'c1', 1, PASS_COMMENT);
  const pr = { type: 'merge' as const, deps: '["c1"]', landing: 'pr' };
  assert.match(waiting(evaluateDeps(pr, lookup(c1), wholeChain(c1, r1))), /merge/);
  assert.match(waiting(evaluateDeps(pr, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1', 'IN_PROGRESS')))), /m1/);
  assert.deepEqual(evaluateDeps(pr, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1'))), { ok: true });
  // code-self volets integrate themselves: DONE is enough, as for any dependent.
  const self = codeDep('c2', { pipeline: 'code-self' });
  assert.deepEqual(evaluateDeps({ ...pr, deps: '["c2"]' }, lookup(self), wholeChain(self)), { ok: true });
  // The merge that lands a job's branch locally waits the same way.
  const local = { ...pr, landing: 'local' };
  assert.match(waiting(evaluateDeps(local, lookup(c1), wholeChain(c1, r1))), /merge/);
  assert.deepEqual(evaluateDeps(local, lookup(c1), wholeChain(c1, r1, mergeOf('m1', 'r1'))), { ok: true });
});

test('non-regression: code dep without a branch or worktree (agent outside git) → DONE is enough', () => {
  const c1 = codeDep('c1', { branch_name: null, worktree_path: null });
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: true });
});

test('non-regression: non-code dep (chore) → DONE is enough', () => {
  const dep: Dep = { id: 'x1', type: 'chore', status: 'DONE', done_comment: 'ok' };
  assert.deepEqual(evaluateDeps({ type: 'code', deps: '["x1"]' }, lookup(dep), wholeChain()), { ok: true });
});

test('full code dep not DONE: wait unchanged, without a reason', () => {
  const c1 = codeDep('c1', { status: 'IN_PROGRESS' });
  assert.deepEqual(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1)), { ok: false, blockedReason: null });
});

test('full code dep: changes_requested without an iteration → dated wait, BLOCKED only once the delay is past', () => {
  const c1 = codeDep('c1');
  const closedAt = 1_000_000;
  const cr = { ...chainReview('r1', 'c1', 1, CR_COMMENT), updated_at: closedAt };
  const gate = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr));
  assert.equal(gate.ok, false);
  assert.equal(gate.ok === false ? gate.awaitingRepairSince : null, closedAt);
  // Plausible wait: no reason.
  assert.equal(repairWaitStall(gate, closedAt + REPAIR_WAIT_BLOCK_MS - 1), null);
  // Beyond: a readable reason, quoting the review.
  const stall = repairWaitStall(gate, closedAt + REPAIR_WAIT_BLOCK_MS + 60_000);
  assert.match(stall?.reason ?? '', /review r1 .* requested changes/);
  assert.match(stall?.reason ?? '', /no iteration has appeared/);
  assert.deepEqual(stall?.code, {
    code: 'repair_wait_stalled',
    params: { reviewId: 'r1', codeId: 'c1', waited: 11, limit: 10 },
  });
});

test('full code dep: an iteration in progress or an unreadable review are never "blocked by delay"', () => {
  const c1 = codeDep('c1');
  const cr = { ...chainReview('r1', 'c1', 1, CR_COMMENT), updated_at: 1 };
  const c2 = { ...codeDep('c2'), iteration: 2, verification_root_id: 'c1', status: 'IN_PROGRESS' as const };
  const running = evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, cr, c2));
  assert.equal(repairWaitStall(running, Date.now()), null);
  const mute = { ...chainReview('r1', 'c1', 1, 'RAS'), updated_at: 1 };
  assert.equal(repairWaitStall(evaluateDeps(DEPENDENT, lookup(c1), wholeChain(c1, mute)), Date.now()), null);
});
