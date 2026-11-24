/**
 * Tests of the direct write of a memory rule (memory-rule-add.ts).
 *
 * `import './test-home.js'` FIRST: this module touches the database through dbApi,
 * which opens the SQLite file on load. Without it, the suite would write into
 * `~/.timon/timon.db`, the real one.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addMemoryRule, MemoryRuleError } from './memory-rule-add.js';
import { dbApi } from './db.js';

/** A unique text per test: the test database is shared by the whole file. */
let n = 0;
const uniq = () => `règle de test #${++n} — ${Math.random().toString(36).slice(2)}`; // french-ok: free-text sample data

test('inserts a scope=agent rule and makes it listable', () => {
  const text = uniq();
  const rule = addMemoryRule({ scope: 'agent', agent: 'alice.main', text });
  assert.equal(rule.scope, 'agent');
  assert.equal(rule.agent, 'alice.main');
  assert.equal(rule.kind, 'pitfall');       // default
  assert.equal(rule.tier, 'normal');        // default
  assert.equal(rule.status, 'active');
  assert.equal(rule.source, 'manual');
  assert.equal(rule.text, text);
  const found = dbApi.listRules({ agent: 'alice.main' }).find((r) => r.id === rule.id);
  assert.ok(found, 'the rule must appear in listRules');
});

test('refuses an exact duplicate on the same scope', () => {
  const text = uniq();
  const first = addMemoryRule({ scope: 'agent', agent: 'dup.main', text });
  assert.throws(
    () => addMemoryRule({ scope: 'agent', agent: 'dup.main', text }),
    (err: unknown) => err instanceof MemoryRuleError && err.status === 409 && err.duplicate?.id === first.id,
  );
  assert.equal(dbApi.listRules({ agent: 'dup.main' }).length, 1);
});

test('the duplicate is detected despite different case and spaces', () => {
  const text = uniq();
  addMemoryRule({ scope: 'agent', agent: 'norm.main', text });
  assert.throws(
    () => addMemoryRule({ scope: 'agent', agent: 'norm.main', text: `  ${text.toUpperCase()}  ` }),
    (err: unknown) => err instanceof MemoryRuleError && err.status === 409,
  );
});

test('the same text on ANOTHER scope passes', () => {
  const text = uniq();
  addMemoryRule({ scope: 'agent', agent: 'a.main', text });
  const other = addMemoryRule({ scope: 'agent', agent: 'b.main', text });
  assert.ok(other.id);
  const proj = addMemoryRule({ scope: 'project', project: 'timon', text });
  assert.equal(proj.scope, 'project');
});

test('a scope without its target is refused (orphan rule, never injected)', () => {
  for (const bad of [
    { scope: 'agent' },
    { scope: 'project' },
    { scope: 'role' },
  ]) {
    assert.throws(
      () => addMemoryRule({ ...bad, text: uniq() }),
      (err: unknown) => err instanceof MemoryRuleError && err.status === 400,
      `scope=${bad.scope} without a target must be refused`,
    );
  }
});

test('scope=global n\'exige aucune cible', () => {
  const rule = addMemoryRule({ scope: 'global', kind: 'preference', text: uniq() });
  assert.equal(rule.scope, 'global');
  assert.equal(rule.agent, null);
  assert.equal(rule.project, null);
});

test('invalid values refused with 400', () => {
  assert.throws(() => addMemoryRule({ scope: 'nimportequoi', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', kind: 'lubie', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', tier: 'ultra', text: uniq() }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
  assert.throws(() => addMemoryRule({ scope: 'global', text: '   ' }),
    (e: unknown) => e instanceof MemoryRuleError && e.status === 400);
});

test('tier=core is kept (a rule always injected on its scope)', () => {
  const rule = addMemoryRule({ scope: 'project', project: 'timon', tier: 'core', kind: 'decision', text: uniq() });
  assert.equal(rule.tier, 'core');
  assert.ok(dbApi.coreRulesForProject('timon').some((r) => r.id === rule.id));
});

test('an added rule is immediately visible in the recall of its agent', () => {
  // The point of the feature: what `timon memory rule add` writes must come out
  // of the SAME path a mission spawn takes (searchRules), without a
  // rebuild or going through a proposal.
  const text = 'les RDV pro sont sur le calendrier Google Working, jamais sur le primary Perso';
  const rule = addMemoryRule({ scope: 'agent', agent: 'recall.main', text });

  // FTS path: the mission talks about the subject.
  const parFts = dbApi.searchRules('calendrier Google agenda', { agent: 'recall.main' });
  assert.ok(parFts.some((r) => r.id === rule.id), 'the rule must come out of the FTS recall');

  // Recency fallback path: the mission mentions nothing close.
  const parRecence = dbApi.searchRules('', { agent: 'recall.main' });
  assert.ok(parRecence.some((r) => r.id === rule.id), 'the rule must come out of the recency recall');

  // And it stays partitioned to its agent.
  assert.equal(dbApi.searchRules('calendrier', { agent: 'autre.main' }).length, 0);
});
