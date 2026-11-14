/**
 * A workflow expression's `matches` runs on the daemon loop: it must go
 * through the linear regex engine, refuse what that engine refuses at save,
 * and keep the result of every pattern the engine supports.
 */
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { dbApi } = await import('../db.js');
const { agentDir } = await import('../paths.js');
const { evaluateExpr, refusedMatchesPattern, MAX_EXPR_LENGTH } = await import('./expr.js');
const { createRun } = await import('./engine.js');
const { parseWorkflowDefinition, parseWorkflowDraft } = await import('./schema.js');
const { registerRoutes } = await import('../plugins-bundled/workflows/routes.js');

const PILOT = 'expr-regex-pilot';
mkdirSync(agentDir(PILOT), { recursive: true });

/** `input.v matches "(a)\1"`: a backreference, refused by the safe engine. */
const BACKREFERENCE = 'input.v matches "(a)\\\\1"';

function definition(condition: string, edgeCondition?: string) {
  return {
    schemaVersion: 1,
    nodes: [
      { id: 'manual', type: 'trigger.manual', config: {} },
      { id: 'check', type: 'condition', config: { expr: condition } },
      { id: 'note', type: 'notify', config: { title: 't' } },
    ],
    edges: [
      { id: 'e1', from: 'manual', fromPort: 'out', to: 'check', toPort: 'in' },
      { id: 'e2', from: 'check', fromPort: 'true', to: 'note', toPort: 'in', condition: edgeCondition ?? null },
    ],
    variables: [], settings: {},
  };
}

function seed(draft: unknown) {
  const id = randomUUID(); const now = Date.now();
  dbApi.insertWorkflow({ id, slug: `expr-${id.slice(0, 8)}`, name: 'Expr witness', description: null, project: null, owner_user_id: null, draft: JSON.stringify(draft), published_version: null, enabled: 1, created_at: now, updated_at: now, agent_name: PILOT });
  return id;
}

const admin: RequestAuth = { kind: 'daemon-token', user: null, isSuperadmin: true };
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.auth = admin; next(); });
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as { error?: string; issues?: Array<{ nodeId?: string; edgeId?: string }>; ok?: boolean } };
}

test('a catastrophic pattern ends at once, literal or read from the context', () => {
  const v = `${'a'.repeat(5000)}b`;
  let started = performance.now();
  assert.equal(evaluateExpr('v matches "^(a|aa)+$"', { v }), false);
  assert.ok(performance.now() - started < 200, `literal pattern took ${performance.now() - started} ms`);

  started = performance.now();
  assert.equal(evaluateExpr('v matches p', { v, p: '^(a+)+$' }), false);
  assert.ok(performance.now() - started < 200, `context pattern took ${performance.now() - started} ms`);
});

test('a supported pattern keeps the result RegExp gave it', () => {
  for (const [pattern, subject] of [['^foo.*bar$', 'foo-and-bar'], ['^foo.*bar$', 'foo-and-baz'], ['\\d{3}', 'id 4521'], ['', 'anything'], ['B', 'abc']] as const) {
    assert.equal(evaluateExpr('v matches p', { v: subject, p: pattern }), new RegExp(pattern).test(subject), pattern);
  }
  assert.equal(evaluateExpr("v matches '^foo.*bar$'", { v: 'foobar' }), true);
  assert.equal(evaluateExpr('v matches "^foo.*bar$" and not v matches "baz"', { v: 'foo bar' }), true);
});

test('a refused or oversized pattern throws at run, like an invalid one', () => {
  assert.throws(() => evaluateExpr('v matches p', { v: 'aa', p: '(a)\\1' }), /backreferences/);
  assert.throws(() => evaluateExpr('v matches p', { v: 'a', p: '(?=a)' }), /lookarounds/);
  assert.throws(() => evaluateExpr('v matches p', { v: 'a', p: 'a'.repeat(MAX_EXPR_LENGTH + 1) }), /longer than/);
  assert.throws(() => evaluateExpr(`v == "${'a'.repeat(MAX_EXPR_LENGTH)}"`, { v: 'a' }), /expression longer than/);
  // One evaluation spends at most what a trigger filter call may: a pattern
  // near the program cap fits a 4096-character subject, not twice.
  const heavy = 'a'.repeat(4000);
  assert.equal(evaluateExpr('v matches ".{1,999}"', { v: heavy }), true);
  assert.throws(() => evaluateExpr('v matches ".{1,999}" or v matches "x.{1,999}"', { v: heavy }), /exceed the work/);
});

test('a long subject is read whole: a small pattern sees past the filter cap', () => {
  const output = `${'x'.repeat(200_000)} error`;
  const started = performance.now();
  assert.equal(evaluateExpr('v matches "error$"', { v: output }), true);
  assert.equal(evaluateExpr('v matches "^x+$"', { v: output }), false);
  assert.ok(performance.now() - started < 500, `took ${performance.now() - started} ms`);
});

test('the worst case one evaluation may spend stays short', () => {
  // Program near the cap, subject sized to the whole budget, no early match.
  const started = performance.now();
  assert.equal(evaluateExpr('v matches "[ab]{999}[ab]{999}c"', { v: 'ab'.repeat(2000) }), false);
  assert.ok(performance.now() - started < 2000, `took ${performance.now() - started} ms`);
});

test('only a literal pattern is checked at save; a context pattern waits for the run', () => {
  assert.match(refusedMatchesPattern('v matches "(a)\\\\1"') ?? '', /matches pattern refused: backreferences/);
  assert.match(refusedMatchesPattern("v matches '(?<n>a)'") ?? '', /refused/);
  assert.equal(refusedMatchesPattern('v matches "^foo.*bar$"'), null);
  assert.equal(refusedMatchesPattern('v matches p'), null);
  assert.equal(refusedMatchesPattern('v == "matches"'), null);
  assert.equal(refusedMatchesPattern('???'), null, 'a malformed expression still fails at run only');
  assert.match(refusedMatchesPattern(`v == "${'a'.repeat(MAX_EXPR_LENGTH)}"`) ?? '', /expression longer than/);
});

test('a draft or a definition holding a refused pattern is refused, the node or edge blamed', () => {
  assert.throws(() => parseWorkflowDraft(definition(BACKREFERENCE)), /check: matches pattern refused/);
  assert.throws(() => parseWorkflowDefinition(definition('true', BACKREFERENCE)), /edge e2: matches pattern refused/);
  const trigger = { ...definition('true'), nodes: [{ id: 'evt', type: 'trigger.event', config: { filter: BACKREFERENCE } }, ...definition('true').nodes] };
  assert.throws(() => parseWorkflowDraft(trigger), /evt: matches pattern refused/);
  assert.equal(parseWorkflowDefinition(definition('input.v matches "^foo.*bar$"')).nodes.length, 3);
});

test('POST /api/workflows answers 400 with a readable reason; PUT too', async () => {
  const created = await call('POST', '/api/workflows', { slug: `expr-${randomUUID().slice(0, 8)}`, name: 'expr', agent_name: PILOT, draft: definition(BACKREFERENCE) });
  assert.equal(created.status, 400);
  assert.match(created.body.error ?? '', /^check: matches pattern refused: backreferences are not supported/);
  assert.equal(created.body.issues?.[0]?.nodeId, 'check');

  const workflow = seed(definition('true'));
  const put = await call('PUT', `/api/workflows/${workflow}`, { draft: definition('true', BACKREFERENCE) });
  assert.equal(put.status, 400);
  assert.equal(put.body.issues?.[0]?.edgeId, 'e2');
  assert.doesNotMatch(dbApi.getWorkflow(workflow)!.draft, /\\\\1/, 'the draft was not written');

  const fine = await call('POST', '/api/workflows', { slug: `expr-${randomUUID().slice(0, 8)}`, name: 'expr', agent_name: PILOT, draft: definition('input.v matches "^foo.*bar$"') });
  assert.equal(fine.status, 201);
});

test('a workflow saved before the rule fails its run with the reason, and stays deletable', async () => {
  const workflow = seed(definition(BACKREFERENCE));
  assert.throws(() => createRun(workflow, { trigger: {}, draft: true }), /matches pattern refused: backreferences/);
  const removed = await call('DELETE', `/api/workflows/${workflow}`);
  assert.equal(removed.status, 200);
  assert.equal(dbApi.getWorkflow(workflow), undefined);
});
