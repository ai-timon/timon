/**
 * Wake digest: a mission return must be READABLE and distinguishable
 * from another, and only wake the pilot if it calls for a decision.
 *
 * The tested module is pure: no import opens the SQLite database.
 * `node --test --import tsx src/wake-digest.test.ts` (or `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIGEST_REPORTS_MAX,
  formatInboxDigest,
  reportShare,
  isUrgentReturn,
  returnPayloadOf,
  truncateComment,
  truncateFinalReport,
  type DigestMessage,
  type ReturnPayload,
} from './wake-digest.js';

// french-ok-file: French sample titles, comments and reports the digest renders

function msg(payload: unknown, from = 'TIMON.reviewer', at = 1_000): DigestMessage {
  return {
    from_agent: from,
    payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    created_at: at,
  };
}

/** The return really observed on 2026-08-21 on series `e6893b9e`: it
 *  already held everything, and the digest showed none of it. */
const REVIEW_RETURN = {
  kind: 'mission_complete',
  mission_id: 'aaaaaaaa-1111-4000-8000-000000000000',
  agent: 'TIMON.reviewer',
  status: 'terminated',
  task_id: '693469fa-2222-4000-8000-000000000000',
  task_title: 'review iter:1 — tasks: un blocage système ne survit pas au kill',
  task_status: 'DONE',
  task_type: 'review',
  done_comment: 'verdict: pass\n\n{ "findings": [] }',
};

test('a mission return gives a digest, not an empty line', () => {
  const out = formatInboxDigest([msg(REVIEW_RETURN)]);
  // That is exactly what was missing: task title, status, verdict.
  assert.match(out, /review iter:1 — tasks: un blocage système/);
  assert.match(out, /DONE/);
  assert.match(out, /Verdict: pass/);
  assert.match(out, /693469fa-2222-4000-8000-000000000000/);
  assert.match(out, /TIMON\.reviewer/);
});

test('two returns of different tasks can be told apart', () => {
  const other = { ...REVIEW_RETURN, task_id: 'b172e022-3333-4000-8000-000000000000', task_title: 'review iter:1 — 2e review vivante' };
  const out = formatInboxDigest([msg(REVIEW_RETURN, 'TIMON.reviewer', 1), msg(other, 'TIMON.reviewer', 2)]);
  assert.match(out, /un blocage système/);
  assert.match(out, /2e review vivante/);
  assert.equal(out.split('── Message').length - 1, 2);
});

test('the review verdict survives the truncation of the comment', () => {
  const long = 'verdict: changes_requested\n' + 'x'.repeat(50_000);
  const out = formatInboxDigest([msg({ ...REVIEW_RETURN, done_comment: long })]);
  assert.match(out, /Verdict: changes_requested/);
  assert.match(out, /truncated/);
  // The 1st line of the comment is never cut: that is the timon-task contract.
  assert.match(out, /verdict: changes_requested\n/);
  assert.ok(out.length < 5_000, 'a 50 kB report must not drown the digest');
});

test('truncateComment keeps the 1st line whole, even longer than the cap', () => {
  const oneLine = 'verdict: pass — ' + 'y'.repeat(2_000);
  const out = truncateComment(oneLine + '\nsuite\n' + 'z'.repeat(2_000));
  assert.ok(out.startsWith(oneLine), 'the 1st line must be intact');
});

/** The return observed on 2026-09-11: two `mission_spawn` delegations whose
 *  report (several hundred words, `stop_reason: end_turn`) slept in the
 *  database while the pilot only received "Mission ended (terminated)".
 *  The `terminated` status is NOT a failure here: the reaper freed an
 *  idle process after the agent finished its turn. */
const MISSION_RETURN = {
  kind: 'mission_complete',
  mission_id: 'd4d95593-d364-4181-8a31-13d425724f03',
  agent: 'timon.coder',
  status: 'terminated',
  task_id: null,
  final_text: 'Commit `c1f16158` — 665 pass / 0 fail.\n\nDivergence assumée : …',
};

test('mission without a task: the final report is returned, not only the status', () => {
  const out = formatInboxDigest([msg(MISSION_RETURN, 'timon.coder')]);
  assert.match(out, /Mission ended \(terminated\)\./, 'the status stays: it says the process was freed');
  assert.match(out, /Commit `c1f16158` — 665 pass/);
  assert.match(out, /Divergence assumée/);
});

test('mission without a task and without a report: the status line stays the fallback', () => {
  const out = formatInboxDigest([msg({ ...MISSION_RETURN, final_text: null }, 'timon.coder')]);
  assert.match(out, /Mission ended \(terminated\)\./);
  assert.doesNotMatch(out, /Final report/);
});

test('task return: the done_comment alone, no duplicate report', () => {
  // A task return carries no `final_text` (agent.ts only attaches it
  // without a task); and if an old payload carried one, it must not
  // add to the closing comment that already says the same thing.
  const out = formatInboxDigest([msg({ ...REVIEW_RETURN, final_text: 'le même texte, en double' })]);
  assert.match(out, /Closing comment/);
  assert.doesNotMatch(out, /Final report/);
  assert.doesNotMatch(out, /en double/);
});

test('non-regression: a {title, body} payload renders as before', () => {
  const out = formatInboxDigest([msg({ kind: 'wake_recap', title: 'Task bloquée : X', body: 'Raison : conflit' }, 'orchestrator-wake')]);
  assert.equal(out, '── Message 1 (from `orchestrator-wake`) — Task bloquée : X ──\nRaison : conflit');
});

test('non-regression: a non-JSON payload renders the raw text', () => {
  const out = formatInboxDigest([msg('coucou, peux-tu relire ma branche ?', 'p.coder')]);
  assert.equal(out, '── Message 1 (from `p.coder`) ──\ncoucou, peux-tu relire ma branche ?');
});

test('returnPayloadOf only recognises work returns', () => {
  assert.ok(returnPayloadOf(msg(REVIEW_RETURN)));
  assert.ok(returnPayloadOf(msg({ ...REVIEW_RETURN, kind: 'task_closed' })));
  assert.equal(returnPayloadOf(msg({ kind: 'wake_recap', title: 'x' })), null);
  assert.equal(returnPayloadOf(msg('texte libre')), null);
});

// ── urgence ────────────────────────────────────────────────────────────────

function ret(p: Partial<ReturnPayload>): ReturnPayload {
  return { kind: 'task_closed', task_id: 't1', task_status: 'DONE', ...p };
}

test('a BLOCKED task always wakes, even with a follow-up already created', () => {
  assert.equal(isUrgentReturn(ret({ task_status: 'BLOCKED', task_type: 'code' }), true), true);
  assert.equal(isUrgentReturn(ret({ task_status: 'BLOCKED', task_type: 'doc' }), true), true,
    'even a blocked doc wakes: a block calls for an intervention');
});

test('a changes_requested verdict wakes, a pass waits for the next digest', () => {
  const cr = ret({ task_type: 'review', done_comment: 'verdict: changes_requested\n…' });
  assert.equal(isUrgentReturn(cr, false), true);
  const pass = ret({ task_type: 'review', done_comment: 'verdict: pass' });
  assert.equal(isUrgentReturn(pass, false), false);
  // Unreadable verdict = human/orchestrator arbitration → wake.
  assert.equal(isUrgentReturn(ret({ task_type: 'review', done_comment: 'ça me va' }), false), true);
});

test('a merge WITHOUT a sha always wakes: integration not proven', () => {
  // Non-negotiable invariant: without a sha, there is no proof that the branch
  // is integrated. Neither the running batch nor an existing follow-up softens it.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null }), true), true);
  assert.equal(
    isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: null, group_id: 'lot-1' }), false),
    true,
  );
});

test("a proven merge only wakes if it really calls for a decision", () => {
  const sha = 'a'.repeat(40);
  // Outside a batch and without a follow-up: end of the chain, the pilot resumes its plan.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha }), false), true);
  // In a batch: the consolidated end-of-group recap is the useful signal.
  // Waking on each merge means N orchestrator turns for a batch of N.
  assert.equal(
    isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha, group_id: 'lot-1' }), false),
    false,
  );
  // A follow-up already exists: it carries the decision, not this return.
  assert.equal(isUrgentReturn(ret({ task_type: 'merge', merged_commit_sha: sha }), true), false);
});

test('a DONE code task without a review is URGENT, even in a full pipeline', () => {
  // The pipeline proves nothing: `full` says what SHOULD follow, not what
  // followed. Assuming the review meant letting a chain broken between the
  // closing and the creation of the review disappear without the slightest signal.
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'full' }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: null }), false), true);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'code-self' }), false), true);
});

test('a code task whose review really exists waits for the next digest', () => {
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'full' }), true), false);
  assert.equal(isUrgentReturn(ret({ task_type: 'code', pipeline: 'code-group' }), true), false);
});

test('a doc task never wakes the pilot on its own', () => {
  assert.equal(isUrgentReturn(ret({ task_type: 'doc' }), false), false);
});

test('a task not closed (system requeue) does not wake; a free sub-mission does', () => {
  assert.equal(isUrgentReturn(ret({ task_status: 'PENDING', task_type: 'code' }), false), false);
  assert.equal(isUrgentReturn({ kind: 'mission_complete', task_id: null, status: 'completed' }, false), true);
});

/** Part 3 (card #101): the final report of a mission WITHOUT a task is the only
 *  deliverable; no task carries the full text, so the pointer "full
 *  comment on the task" designates an object that does not exist. */
test('truncated final report: a clean cap and a pointer to `timon status`', () => {
  const id = 'd4d95593-d364-4181-8a31-13d425724f03';
  const out = truncateFinalReport('r'.repeat(20_000), id);
  assert.match(out, /truncated/);
  assert.match(out, new RegExp(`timon status ${id}`), 'the pointer must target the mission');
  assert.doesNotMatch(out, /sur la task/, 'no task carries this text');
  // Wider than a done_comment (900): this report is the only deliverable.
  assert.ok(out.length > 3_000 && out.length < 5_000, `unexpected length: ${out.length}`);
});

test('a short report is not touched', () => {
  assert.equal(truncateFinalReport('  tout tient  ', 'x'), 'tout tient');
});

test('truncateComment keeps its contract: a pointer to the task', () => {
  const out = truncateComment('l'.repeat(20_000));
  assert.match(out, /full comment on the task/);
});

test('the human summary appears in the digest only when it exists', () => {
  const withSummary = formatInboxDigest([msg({ ...REVIEW_RETURN, summary: 'Relecture OK, rien à corriger.' })]);
  assert.match(withSummary, /Summary: Relecture OK, rien à corriger\./);
  const without = formatInboxDigest([msg(REVIEW_RETURN)]);
  assert.doesNotMatch(without, /Summary:/);
});

/** The batch PROGRESS noted without a cap: six `mission_spawn` delegations
 *  back together, each with a final report at the per-entry cap. */
function sixDelegations(): DigestMessage[] {
  return Array.from({ length: 6 }, (_, i) => msg({
    ...MISSION_RETURN,
    mission_id: `0000000${i}-d364-4181-8a31-13d425724f03`,
    final_text: truncateFinalReport(`Verdict ${i} : livré.\n${String(i).repeat(20_000)}`, `0000000${i}`),
  }, 'timon.coder', 1_000 + i));
}

test('six final reports back together fit within the global cap of the digest', () => {
  const messages = sixDelegations();
  const unbounded = messages.reduce((sum, m) => sum + (returnPayloadOf(m)!.final_text ?? '').length, 0);
  assert.ok(unbounded > 3 * DIGEST_REPORTS_MAX, `the witness batch must exceed the cap (${unbounded})`);
  const out = formatInboxDigest(messages);
  // Headers, statuses and pointers on top of the reports themselves.
  assert.ok(out.length < DIGEST_REPORTS_MAX + 2_500, `digest de ${out.length} car.`);
  for (let i = 0; i < 6; i++) {
    assert.match(out, new RegExp(`Verdict ${i} : livré\\.`), 'the head of each report stays');
    assert.match(out, new RegExp(`shortened to fit this digest — full report: timon status 0000000${i}-`));
  }
});

test('a batch that fits within the global cap comes out identical', () => {
  const short = [msg(REVIEW_RETURN), msg(MISSION_RETURN, 'timon.coder', 2_000)];
  assert.doesNotMatch(formatInboxDigest(short), /shortened to fit/);
  assert.equal(reportShare([100, 200, 300]), Infinity);
});

test('the global cap shortens the long reports, leaves the short ones whole', () => {
  const long = 'L'.repeat(3_000);
  const out = formatInboxDigest([
    msg({ ...REVIEW_RETURN, done_comment: 'verdict: pass\n\ncourt' }, 'TIMON.reviewer', 1),
    ...[0, 1, 2, 3].map((i) => msg({ ...MISSION_RETURN, mission_id: `m${i}`, final_text: long }, 'timon.coder', 2 + i)),
  ]);
  assert.match(out, /verdict: pass\n\ncourt\n/, 'le court passe entier');
  assert.equal((out.match(/shortened to fit/g) ?? []).length, 4);
  // Water level: (8,000 − 19) / 4 for each of the four long ones.
  assert.equal(reportShare([19, 3_000, 3_000, 3_000, 3_000]), Math.floor((DIGEST_REPORTS_MAX - 19) / 4));
});

test('a comment shortened by the batch keeps its first line and points to the task', () => {
  const firstLine = `verdict: changes_requested ${'x'.repeat(600)}`;
  const comment = `${firstLine}\n${'détail '.repeat(200)}`;
  const out = formatInboxDigest(Array.from({ length: 30 }, (_, i) =>
    msg({ ...REVIEW_RETURN, task_id: `task-${i}`, done_comment: comment }, 'TIMON.reviewer', i)));
  assert.equal((out.match(new RegExp(firstLine, 'g')) ?? []).length, 30, 'the verdict is never cut');
  assert.match(out, /shortened to fit this digest — full text: timon task get task-0/);
});

test('an agent→agent message does not enter the cap: the request stays whole', () => {
  const body = 'B'.repeat(20_000);
  const out = formatInboxDigest([...sixDelegations(), msg({ title: 'demande', body }, 'timon.main', 9_000)]);
  assert.ok(out.includes(body));
});
