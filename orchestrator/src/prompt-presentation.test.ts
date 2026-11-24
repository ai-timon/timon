import assert from 'node:assert/strict';
import test from 'node:test';
import { composePrompt } from './prompt-presentation.js';
import { formatInboxDigest, presentInboxDigest } from './wake-digest.js';

// french-ok-file: French sample comments and summaries the test feeds in

test('prompt composition preserves every byte while merging adjacent display sections', () => {
  const parts = [{ kind: 'instruction' as const, text: 'TASK_ID: abc\n\n' },
    { kind: 'text' as const, text: 'Brief 🦊\n' }, { kind: 'instruction' as const, text: '\nPipeline' },
    { kind: 'instruction' as const, text: '\nWorktree' }];
  const original = JSON.stringify(parts);
  const prompt = composePrompt(parts);
  assert.equal(prompt.text, 'TASK_ID: abc\n\nBrief 🦊\n\nPipeline\nWorktree');
  assert.equal(prompt.presentation.parts.length, 3);
  assert.equal(JSON.stringify(parts), original, 'caller-owned parts must not be mutated');
});

test('return identifiers collapse while verdict, blocker and author commentary remain visible', () => {
  const messages = [{ from_agent: 'reviewer', created_at: 1, payload: JSON.stringify({
    kind: 'task_closed', task_id: 'task-secret-id', task_title: 'Chat', task_type: 'review', task_status: 'BLOCKED',
    merged_commit_sha: 'commit-secret-id', group_id: 'group-secret-id', blocked_reason: 'Keyboard focus lost',
    done_comment: 'verdict: changes_requested\nTask `quoted-by-agent`\nFix keyboard access.',
  }) }];
  const prompt = presentInboxDigest(messages);
  assert.equal(prompt.text, formatInboxDigest(messages));
  assert.equal(prompt.presentation.parts.map((part) => part.text).join(''), prompt.text);
  const visible = prompt.presentation.parts.filter((part) => part.kind === 'text').map((part) => part.text).join('');
  // The header belongs to the collapsed block it titles — one fold per return.
  // Its label says WHAT the block is, as a short i18n key: never the header
  // itself, which the client would then print in full next to the bot icon.
  assert.equal(prompt.presentation.parts[0]!.label, 'taskBlocked');
  assert.doesNotMatch(visible, /BLOCKED : Chat/);
  assert.match(visible, /Keyboard focus lost/);
  assert.match(visible, /verdict: changes_requested/);
  assert.match(visible, /Task `quoted-by-agent`/);
  assert.doesNotMatch(visible, /task-secret-id|commit-secret-id|group-secret-id/);
});

test('ordinary agent messages are never classified as instructions by their wording', () => {
  const prompt = presentInboxDigest([{ from_agent: 'a', created_at: 1, payload: 'Task `abc`\nTASK_ID: abc\n\n' }]);
  assert.equal(prompt.text, '── Message 1 (from `a`) ──\nTask `abc`\nTASK_ID: abc');
  assert.deepEqual(prompt.presentation.parts.map((part) => part.kind), ['instruction', 'text']);
  assert.equal(prompt.presentation.parts[1]!.text, 'Task `abc`\nTASK_ID: abc');
});

test('parts of two messages never merge, and every part names its message', () => {
  const ret = (agent: string, title: string) => JSON.stringify({
    kind: 'task_closed', agent, task_id: `id-${title}`, task_title: title, task_type: 'merge', task_status: 'DONE',
    merged_commit_sha: 'abcdef1234567', done_comment: 'mergé',
  });
  const prompt = presentInboxDigest([
    { from_agent: 'p.coder', created_at: 1_000, from_mission: 'm-1', payload: ret('p.coder', 'A') },
    { from_agent: 'p.merger', created_at: 2_000, from_mission: 'm-2', payload: ret('p.merger', 'B') },
  ]);
  const { parts, segments } = prompt.presentation;
  assert.equal(parts.map((part) => part.text).join(''), prompt.text, 'the text is unchanged');
  assert.deepEqual(segments?.map((s) => [s.from, s.at, s.mission_id]), [['p.coder', 1_000, 'm-1'], ['p.merger', 2_000, 'm-2']]);
  assert.ok(parts.every((part) => part.segment === 0 || part.segment === 1));
  // The second return's header stays its own part, not glued to the first one.
  const second = parts.findIndex((part) => part.segment === 1);
  assert.match(parts[second]!.text, /^── Message 2/);
  assert.equal(segments?.[1]?.card?.merged_sha, 'abcdef1234567');
});

test('the runtime preamble belongs to no message and keeps its own part', () => {
  const digest = presentInboxDigest([{ from_agent: 'a', created_at: 1, payload: 'bonjour' }]);
  const composed = composePrompt([{ kind: 'instruction', text: 'Preamble\n\n' }, ...digest.presentation.parts], digest.presentation.segments);
  assert.equal(composed.presentation.parts[0]!.text, 'Preamble\n\n');
  assert.equal(composed.presentation.parts[0]!.segment, undefined);
  assert.equal(composed.presentation.parts[1]!.segment, 0);
  assert.equal(composed.presentation.segments?.length, 1);
  assert.equal(composed.presentation.segments?.[0]?.card, undefined, 'an agent message has no card');
});

test('the card shows what calls a decision, and caps it', () => {
  const blocked = presentInboxDigest([{ from_agent: 'r', created_at: 1, payload: JSON.stringify({
    kind: 'task_closed', agent: 'p.reviewer', task_id: 't', task_title: 'Review', task_type: 'review', task_status: 'DONE',
    summary: 'Deux points à corriger.', done_comment: `verdict: changes_requested\n${'z'.repeat(5_000)}`,
  }) }]).presentation.segments![0]!.card!;
  assert.equal(blocked.verdict, 'changes_requested');
  assert.equal(blocked.summary, 'Deux points à corriger.');
  assert.ok(blocked.findings && blocked.findings.length <= 1_200, 'findings are capped');

  const pass = presentInboxDigest([{ from_agent: 'r', created_at: 1, payload: JSON.stringify({
    kind: 'task_closed', agent: 'p.reviewer', task_id: 't', task_title: 'Review', task_type: 'review', task_status: 'DONE',
    done_comment: 'verdict: pass\n\n{ "findings": [] }',
  }) }]).presentation.segments![0]!.card!;
  assert.equal(pass.verdict, 'pass');
  assert.equal(pass.findings, undefined);

  const stuck = presentInboxDigest([{ from_agent: 'c', created_at: 1, payload: JSON.stringify({
    kind: 'task_closed', agent: 'p.coder', task_id: 't', task_title: 'Code', task_type: 'code', task_status: 'BLOCKED',
    blocked_reason: 'Mac sans session',
  }) }]).presentation.segments![0]!.card!;
  assert.equal(stuck.blocked_reason, 'Mac sans session');
});

test('a daemon recap is shown under the name the caller resolves', () => {
  const digest = presentInboxDigest(
    [{ from_agent: 'orchestrator-wake', created_at: 1, payload: JSON.stringify({ title: 'Lot terminé', body: '3 tasks' }) }],
    { displayName: (s) => (s === 'orchestrator-wake' ? 'Alice' : s) },
  );
  assert.equal(digest.presentation.segments?.[0]?.from, 'Alice');
  assert.match(digest.text, /from `orchestrator-wake`/, 'the pilot still reads the real sender');
});
