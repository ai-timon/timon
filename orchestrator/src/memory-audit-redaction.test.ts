/**
 * A memory rule that is deleted or rewritten does not survive as text in the
 * curation journal (`memory_audit.candidate_text`): the decisions stay, the
 * wording of the rule goes.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dbApi, db } from './db.js';
import { editMemoryRule, removeMemoryRule } from './memory-queries.js';
import { applyCuration } from './memory-synthesize.js';

const uniq = (label: string) => `${label} ${randomUUID()}`;

const auditOf = (ruleId: number) => db.prepare(
  `SELECT action, candidate_text FROM memory_audit WHERE rule_id = ? OR target_rule_id = ? ORDER BY id`,
).all(ruleId, ruleId) as Array<{ action: string; candidate_text: string | null }>;

const newRule = (text: string) => dbApi.insertRule({
  scope: 'agent', agent: 'redaction-witness', kind: 'pitfall', text, source: 'synthesis',
});

test('deleting a rule empties every audit row that carried its text', () => {
  const text = uniq('never deploy on Friday');
  const id = newRule(text);
  const runId = randomUUID();
  dbApi.logMemoryAudit({ runId, action: 'new', ruleId: id, candidateText: text });
  dbApi.logMemoryAudit({ runId, action: 'merge', targetRuleId: id, candidateText: `${text} (merged)` });
  // A neighbour's row must keep its text.
  const other = uniq('keep the neighbour');
  const otherId = newRule(other);
  dbApi.logMemoryAudit({ runId, action: 'new', ruleId: otherId, candidateText: other });

  assert.ok(removeMemoryRule(id));

  const rows = auditOf(id);
  assert.deepEqual(rows.map((r) => r.action), ['new', 'merge', 'manual_delete']);
  assert.ok(rows.every((r) => r.candidate_text === null), 'no audit row keeps the deleted text');
  const leftovers = db.prepare(`SELECT COUNT(*) n FROM memory_audit WHERE candidate_text LIKE ?`).get(`%${text}%`) as { n: number };
  assert.equal(leftovers.n, 0);
  assert.equal(auditOf(otherId)[0]?.candidate_text, other);
});

test('rewriting a rule by hand drops its old wording from the audit, not the new one', () => {
  const before = uniq('old wording');
  const id = newRule(before);
  dbApi.logMemoryAudit({ action: 'new', ruleId: id, candidateText: before });

  const after = uniq('new wording');
  assert.ok(editMemoryRule(id, { text: after }));
  dbApi.logMemoryAudit({ action: 'merge', targetRuleId: id, candidateText: after });

  assert.deepEqual(auditOf(id).map((r) => r.candidate_text), [null, after]);
});

test('a curation merge that rewords a rule drops the old wording too', () => {
  const before = uniq('curated old wording');
  const id = newRule(before);
  dbApi.logMemoryAudit({ action: 'new', ruleId: id, candidateText: before });
  const rule = dbApi.getRule(id);
  assert.ok(rule);

  const after = uniq('curated new wording');
  applyCuration([{ action: 'merge', targetId: id, text: after }], 'global', null, null, [rule], randomUUID());

  assert.equal(dbApi.getRule(id)?.text, after);
  assert.deepEqual(auditOf(id).map((r) => r.candidate_text), [null, after]);
});

test('an edit that keeps the text leaves the audit untouched', () => {
  const text = uniq('stable wording');
  const id = newRule(text);
  dbApi.logMemoryAudit({ action: 'new', ruleId: id, candidateText: text });
  assert.ok(editMemoryRule(id, { tier: 'core' }));
  assert.equal(auditOf(id)[0]?.candidate_text, text);
});

test('the journal says which empty texts went with their deleted rule', () => {
  const text = uniq('a rule that will go');
  const id = newRule(text);
  const kept = uniq('a rule that stays');
  const keptId = newRule(kept);
  const runId = randomUUID();
  dbApi.logMemoryAudit({ runId, action: 'new', ruleId: id, candidateText: text });
  dbApi.logMemoryAudit({ runId, action: 'merge', targetRuleId: id, candidateText: `${text} (merged)` });
  dbApi.logMemoryAudit({ runId, action: 'new', ruleId: keptId, candidateText: kept });
  dbApi.logMemoryAudit({ runId, action: 'reject', candidateText: null });

  assert.ok(removeMemoryRule(id));

  const rows = dbApi.listMemoryAudit({ runId });
  const flag = (action: string, ruleId: number | null) =>
    rows.find((r) => r.action === action && (r.rule_id === ruleId || r.target_rule_id === ruleId))?.rule_deleted;
  assert.equal(flag('new', id), 1);
  assert.equal(flag('merge', id), 1);
  assert.equal(flag('new', keptId), 0);
  assert.equal(rows.find((r) => r.action === 'reject')?.rule_deleted, 0);
});
