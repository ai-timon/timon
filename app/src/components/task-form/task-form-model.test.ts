/**
 * The task form's rules apart from the DOM (`task-form-model.ts`): what a
 * stored task opens as, what is sent on creation and on edition, what blocks
 * the save, and the counters of the tabs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBody, buildInitial, formProblems, matchesFilter, tabCounts, tabOfProblem, type TaskFormSource } from './task-form-model';

const TASK: TaskFormSource = {
  id: 't1', title: 'Ship it', agent_name: 'coder', priority: 4, deps: '["a","b"]', type: 'code',
  extra_skills: '["tdd"]', extra_allowed_tools: '["Bash(git:*)","Read"]', pipeline: 'code-self', todo_id: 209,
  fallback_backend_override: 'codex', fallback_model_override: 'gpt-5.5', permission_mode_override: 'plan',
};

test('a stored task opens with every field it carries', () => {
  const form = buildInitial(TASK, null, []);
  assert.equal(form.priority, 4);
  assert.deepEqual(form.deps, ['a', 'b']);
  assert.deepEqual(form.extra_skills, ['tdd']);
  assert.equal(form.extra_allowed_tools, 'Bash(git:*), Read');
  assert.equal(form.pipeline, 'code-self');
  assert.equal(form.todo_id, '209');
  assert.equal(form.fallback_backend_override, 'codex');
  assert.equal(form.permission_mode_override, 'plan');
  // A new task: the default agent, else the first known, a normal priority, a chore.
  const blank = buildInitial(null, null, [{ name: 'first' }]);
  assert.equal(blank.agent_name, 'first');
  assert.equal(blank.priority, 3);
  assert.equal(blank.type, 'chore');
  assert.equal(blank.pipeline, 'full');
});

test('the pipeline is sent at creation of a code task only, never on an edition', () => {
  const form = buildInitial(TASK, null, []);
  assert.equal(buildBody(form, 'create').pipeline, 'code-self');
  assert.equal('pipeline' in buildBody(form, 'edit'), false);
  assert.equal('pipeline' in buildBody({ ...form, type: 'doc' }, 'create'), false);
});

test('the body carries the overrides as the daemon reads them', () => {
  const body = buildBody({ ...buildInitial(TASK, null, []), permission_mode_override: 'default', title: '  Ship it  ' }, 'edit');
  assert.equal(body.title, 'Ship it');
  assert.equal(body.permission_mode_override, null, '"default" is no override');
  assert.equal(body.clear_permission_mode, true);
  assert.equal('clear_fallback' in body, false, 'a stored fallback stays unchanged');
  assert.deepEqual(body.extra_allowed_tools, ['Bash(git:*)', 'Read']);
  assert.equal(body.todo_id, 209);
  assert.equal(body.backend_override, null);
  assert.equal(body.fallback_backend_override, 'codex');
  assert.equal(body.fallback_model_override, 'gpt-5.5');
  const never = buildBody({ ...buildInitial(TASK, null, []), fallback_backend_override: 'none' }, 'edit');
  assert.equal(never.fallback_backend_override, 'none');
  assert.equal(never.fallback_model_override, null, 'no model rides with "never"');
  assert.equal(buildBody({ ...buildInitial(TASK, null, []), todo_id: '' }, 'edit').todo_id, null);
  assert.equal(buildBody({ ...buildInitial(TASK, null, []), scheduled_at: '' }, 'edit').scheduled_at, null);
});

test('inherited settings send reset sentinels only on edition', () => {
  const form = {
    ...buildInitial(TASK, null, []),
    fallback_backend_override: '', fallback_model_override: '', permission_mode_override: 'default',
  };
  const edited = buildBody(form, 'edit');
  assert.equal(edited.clear_fallback, true);
  assert.equal(edited.clear_permission_mode, true);
  assert.equal(edited.fallback_backend_override, null);
  assert.equal(edited.fallback_model_override, null);
  assert.equal(edited.permission_mode_override, null);
  const created = buildBody(form, 'create');
  assert.equal('clear_fallback' in created, false, 'POST has no reset fields');
  assert.equal('clear_permission_mode' in created, false);
});

test('saving a fallback half-pair or a never-fallback does not erase it', () => {
  for (const overrides of [
    { fallback_backend_override: 'claude', fallback_model_override: null },
    { fallback_backend_override: null, fallback_model_override: 'old-model' },
    { fallback_backend_override: 'none', fallback_model_override: null },
  ]) {
    const body = buildBody(buildInitial({ ...TASK, ...overrides }, null, []), 'edit');
    assert.equal('clear_fallback' in body, false);
    assert.equal(body.fallback_backend_override, overrides.fallback_backend_override);
    assert.equal(body.fallback_model_override, overrides.fallback_model_override);
    assert.equal('clear_permission_mode' in body, false, 'the stored plan mode stays unchanged');
  }
});

test('a missing title, a missing agent or a TO DO that is not a number blocks the save, in the tab that holds it (none for the right column)', () => {
  const form = buildInitial(null, null, []);
  assert.deepEqual(formProblems({ ...form, title: '   ', todo_id: '12a' }), ['title', 'agent', 'todo']);
  assert.deepEqual(formProblems({ ...form, title: 'x', agent_name: 'a', todo_id: ' 7 ' }), []);
  assert.equal(tabOfProblem('agent'), null, 'the agent sits in the right column too');
  assert.equal(tabOfProblem('todo'), null, 'the TO DO sits in the right column, beside every tab');
  assert.equal(tabOfProblem('title'), null, 'the title sits above the tabs');
});

test('each tab counts what it holds', () => {
  const counts = tabCounts({ ...buildInitial(TASK, null, []), extra_mcp_servers: ['github'], scheduled_at: '2026-11-02T09:00' }, 2);
  assert.deepEqual(counts, { general: 2, dependencies: 2, capabilities: 4 });
});

test('a filter ignores case and accents', () => {
  assert.equal(matchesFilter('ECHEANCE', 'Échéance du lot'), true); // french-ok: an accented label, the folding under test
  assert.equal(matchesFilter('', 'anything'), true);
  assert.equal(matchesFilter('zz', 'abc', null), false);
});
