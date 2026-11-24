import assert from 'node:assert/strict';
import test from 'node:test';
import {
  availableTabs, draftFromTrigger, draftToBody, emptyAction, filterToDraft, hookUrl, slugify, tabFromSearch,
  type Filter, type TriggerPublic,
} from '../plugins-client/triggers/model';

test('tabs: the asked one when shown, the first shown otherwise', () => {
  const all = availableTabs({ routines: true, triggers: true });
  assert.deepEqual(all, ['routines', 'webhooks', 'events']);
  assert.deepEqual(availableTabs({ routines: true, triggers: false }), ['routines']);
  assert.deepEqual(availableTabs({ routines: false, triggers: true }), ['routines', 'webhooks', 'events']);
  assert.deepEqual(availableTabs({ routines: false, triggers: false }), []);
  assert.equal(tabFromSearch('?tab=events', all), 'events');
  assert.equal(tabFromSearch('?tab=nope', all), 'routines');
  assert.equal(tabFromSearch('?tab=webhooks', ['routines']), 'routines');
  assert.equal(tabFromSearch('', []), null);
});

test('a webhook address is built on the page origin', () => {
  assert.equal(hookUrl({ url: '/api/triggers/hooks/bugs' }, 'https://timon.example'), 'https://timon.example/api/triggers/hooks/bugs');
  assert.equal(hookUrl({ url: null }, 'https://timon.example'), null);
  assert.equal(slugify('Issues GitHub — été !'), 'issues-github-ete'); // french-ok: accented text, the slug folding under test
});

test('a webhook draft becomes the body the daemon validates', () => {
  const draft = draftFromTrigger(null, 'webhook');
  draft.name = ' Discord bugs ';
  draft.slug = 'discord-bugs';
  draft.filter = {
    mode: 'simple', combine: 'all', json: '',
    conditions: [
      { op: 'equals', path: 'channel', value: 'bugs', caseInsensitive: false },
      { op: 'in', path: 'headers.X-Event', value: 'message, edit', caseInsensitive: false },
      { op: 'regex', path: 'content', value: '^bug', caseInsensitive: true },
    ],
  };
  draft.actions = [{ ...emptyAction('todo'), text: 'Bug: {content}', urgency: 'bug' }];
  const built = draftToBody(draft);
  assert.ok(built.ok);
  assert.deepEqual(built.body, {
    source: 'webhook', name: 'Discord bugs', enabled: true, slug: 'discord-bugs',
    config: { auth: 'github' },
    filter: { all: [
      { op: 'equals', path: 'channel', value: 'bugs' },
      { op: 'in', path: 'headers.X-Event', values: ['message', 'edit'] },
      { op: 'regex', path: 'content', pattern: '^bug', flags: 'i' },
    ] },
    actions: [{ type: 'todo', text: 'Bug: {content}', urgency: 'bug' }],
  });
});

test('a problem names the step it belongs to', () => {
  const draft = draftFromTrigger(null, 'webhook');
  assert.deepEqual(draftToBody(draft), { ok: false, problem: { step: 0, key: 'triggersPage.errors.name' } });
  draft.name = 'x';
  draft.slug = 'Bad Slug';
  assert.equal(!draftToBody(draft).ok && (draftToBody(draft) as { problem: { key: string } }).problem.key, 'triggersPage.errors.slug');
  draft.slug = 'ok';
  draft.filter = { ...draft.filter, mode: 'json', json: '[1]' };
  const filterProblem = draftToBody(draft);
  assert.ok(!filterProblem.ok && filterProblem.problem.step === 1);
  draft.filter = { ...draft.filter, mode: 'none' };
  const actionProblem = draftToBody(draft);
  assert.ok(!actionProblem.ok && actionProblem.problem.step === 2 && actionProblem.problem.key === 'triggersPage.errors.todoText');
});

test('editing keeps what the simple form cannot show, and a verbatim prompt', () => {
  const nested: Filter = { not: { op: 'exists', path: 'draft' } };
  assert.equal(filterToDraft(nested).mode, 'json');
  assert.deepEqual(JSON.parse(filterToDraft(nested).json), nested);
  const flat = filterToDraft({ any: [{ op: 'exists', path: 'a' }, { op: 'equals', path: 'b', value: 'x' }] });
  assert.equal(flat.mode, 'simple');
  assert.equal(flat.combine, 'any');

  const trigger: TriggerPublic = {
    id: 't1', name: 'Nightly', slug: null, source: 'schedule', enabled: false,
    config: { cron: '0 2 * * *', tz: 'Europe/Paris' }, filter: null,
    actions: [{ type: 'task', agent: 'coder', prompt: 'Run {x}', raw: true, priority: 2 }],
    created_by: 'user', creator_agent: null, has_secret: false, url: null,
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
  const built = draftToBody(draftFromTrigger(trigger, 'schedule'));
  assert.ok(built.ok);
  assert.deepEqual(built.body, {
    source: 'schedule', name: 'Nightly', enabled: false, config: { cron: '0 2 * * *', tz: 'Europe/Paris' },
    actions: [{ type: 'task', agent: 'coder', prompt: 'Run {x}', task_type: 'chore', priority: 2, raw: true }],
  });
});

test('a silent task action keeps its flag through an edit; off, the key is not sent', () => {
  const trigger: TriggerPublic = {
    id: 't2', name: 'Discord tickets', slug: null, source: 'event', enabled: true,
    config: { event: 'todo_done' }, filter: null,
    actions: [{ type: 'task', agent: 'researcher', prompt: 'Study {todo.text}', task_type: 'research', silent_return: true }],
    created_by: 'user', creator_agent: null, has_secret: false, url: null,
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
  const draft = draftFromTrigger(trigger, 'event');
  assert.equal(draft.actions[0]?.silentReturn, true);
  const built = draftToBody(draft);
  assert.ok(built.ok);
  assert.deepEqual((built.body.actions as Record<string, unknown>[])[0]?.silent_return, true);

  draft.actions[0]!.silentReturn = false;
  const loud = draftToBody(draft);
  assert.ok(loud.ok);
  assert.equal('silent_return' in (loud.body.actions as Record<string, unknown>[])[0]!, false);
  assert.equal(emptyAction('task').silentReturn, false);
});

function webhook(filter: Filter | null, config: TriggerPublic['config']): TriggerPublic {
  return {
    id: 'w1', name: 'GitLab issues', slug: 'gitlab-issues', source: 'webhook', enabled: true, config, filter,
    actions: [{ type: 'todo', text: 'Issue: {issue.title}' }],
    created_by: 'agent', creator_agent: 'coder', has_secret: true, url: '/api/triggers/hooks/gitlab-issues',
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
}

/** Opens the trigger, renames it, saves: what the daemon would receive. */
function renamed(trigger: TriggerPublic): Record<string, unknown> {
  const draft = draftFromTrigger(trigger, trigger.source);
  draft.name = 'Renamed';
  const built = draftToBody(draft);
  assert.ok(built.ok, JSON.stringify(!built.ok && built.problem));
  return built.body;
}

test('a filter the simple form cannot hold opens as JSON and survives a rename untouched', () => {
  const lossy: Filter[] = [
    { op: 'equals', path: 'assignee', value: null },
    { op: 'in', path: 'labels', values: ['a,b', 'c'] },
    { op: 'in', path: 'labels', values: ['', ' x '] },
    { op: 'in', path: 'iid', values: [1, true, null] },
    { op: 'equals', path: 'iid', value: 42 },
    { op: 'contains', path: 'labels', value: false },
    { op: 'regex', path: 'title', pattern: '^bug', flags: '' },
    { all: [{ op: 'exists', path: 'issue' }, { op: 'equals', path: 'draft', value: true }] },
    { any: [{ op: 'exists', path: 'issue' }] },
    { all: [] },
  ];
  for (const filter of lossy) {
    assert.equal(filterToDraft(filter).mode, 'json', JSON.stringify(filter));
    assert.deepEqual(renamed(webhook(filter, { auth: 'gitlab' })).filter, filter);
  }
});

test('a filter the simple form holds exactly stays simple and comes back identical', () => {
  const exact: Filter[] = [
    { op: 'equals', path: 'object_kind', value: 'issue' },
    { op: 'not_equals', path: 'state', value: '' },
    { op: 'equals', path: 'label', value: ' bug ' },
    { op: 'in', path: 'action', values: ['open', 'reopen'] },
    { op: 'regex', path: 'title', pattern: '^bug ', flags: 'i' },
    { any: [{ op: 'exists', path: 'issue' }, { op: 'contains', path: 'labels', value: 'bug' }, { op: 'missing', path: 'draft' }] },
  ];
  for (const filter of exact) {
    assert.equal(filterToDraft(filter).mode, 'simple', JSON.stringify(filter));
    assert.deepEqual(renamed(webhook(filter, { auth: 'gitlab' })).filter, filter);
  }
});

test('coalescing keeps its milliseconds and its ceiling through an edit', () => {
  for (const coalesce of [
    { key: 'issue.id', quiet_ms: 1500, max_ms: 10_000 },
    { key: 'issue.id', quiet_ms: 500 },
    { key: 'issue.id', quiet_ms: 1234, max_ms: 86_400_000 },
    { key: 'issue.id', quiet_ms: 3_600_000, max_ms: 500 },
  ]) {
    const config = { auth: 'gitlab' as const, rate_limit: 12, coalesce };
    assert.deepEqual(renamed(webhook(null, config)).config, config);
    const event = { ...webhook(null, { event: 'task_done', coalesce }), source: 'event' as const, slug: null, url: null };
    assert.deepEqual(renamed(event).config, { event: 'task_done', coalesce });
  }

  const draft = draftFromTrigger(webhook(null, { auth: 'gitlab', coalesce: { key: 'issue.id', quiet_ms: 1500, max_ms: 10_000 } }), 'webhook');
  assert.equal(draft.coalesceQuietS, '1.5');
  assert.equal(draft.coalesceMaxS, '10');
  draft.coalesceQuietS = '2,5';
  draft.coalesceMaxS = '';
  const edited = draftToBody(draft);
  assert.ok(edited.ok);
  assert.deepEqual(edited.body.config, { auth: 'gitlab', coalesce: { key: 'issue.id', quiet_ms: 2500 } });

  for (const [quiet, max, key] of [
    ['0.4', '', 'triggersPage.errors.coalesceQuiet'],
    ['abc', '', 'triggersPage.errors.coalesceQuiet'],
    ['3601', '', 'triggersPage.errors.coalesceQuiet'],
    ['1', '86401', 'triggersPage.errors.coalesceMax'],
    ['1', 'x', 'triggersPage.errors.coalesceMax'],
  ] as const) {
    draft.coalesceQuietS = quiet;
    draft.coalesceMaxS = max;
    const built = draftToBody(draft);
    assert.ok(!built.ok && built.problem.key === key, `${quiet} / ${max}`);
  }
});

test('a workflow action needs its workflow and entry node, and survives an edit', () => {
  const draft = draftFromTrigger(null, 'event');
  draft.name = 'Bug to workflow';
  draft.actions = [{ ...emptyAction('workflow'), workflow: 'wf-1' }];
  const missing = draftToBody(draft);
  assert.ok(!missing.ok && missing.problem.step === 2 && missing.problem.key === 'triggersPage.errors.workflowTarget');
  draft.actions = [{ ...emptyAction('workflow'), workflow: 'wf-1', node: 'entry' }];
  const built = draftToBody(draft);
  assert.ok(built.ok);
  assert.deepEqual(built.body.actions, [{ type: 'workflow', workflow: 'wf-1', node: 'entry' }]);
  const stored: TriggerPublic = {
    id: 'e1', name: 'Bug to workflow', slug: null, source: 'event', enabled: true, config: { event: 'task_done' }, filter: null,
    actions: [{ type: 'workflow', workflow: 'wf-1', node: 'entry' }],
    created_by: 'user', creator_agent: null, has_secret: false, url: null,
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
  assert.deepEqual(renamed(stored).actions, stored.actions);
});

test('a webhook action takes an https address without credentials, and survives an edit', () => {
  const draft = draftFromTrigger(null, 'event');
  draft.name = 'Closed ideas to Discord';
  draft.event = 'todo_done';
  for (const url of ['', 'http://bot.example/hook', 'https://u:p@bot.example/hook', 'bot.example']) {
    draft.actions = [{ ...emptyAction('webhook'), url }];
    const refused = draftToBody(draft);
    assert.ok(!refused.ok && refused.problem.step === 2 && refused.problem.key === 'triggersPage.errors.webhookUrl', url);
  }
  draft.actions = [{ ...emptyAction('webhook'), url: ' https://bot.example/timon/events ' }];
  const built = draftToBody(draft);
  assert.ok(built.ok);
  assert.deepEqual(built.body.config, { event: 'todo_done' });
  assert.deepEqual(built.body.actions, [{ type: 'webhook', url: 'https://bot.example/timon/events' }]);
  const stored: TriggerPublic = {
    id: 'e2', name: 'Closed ideas to Discord', slug: null, source: 'event', enabled: true, config: { event: 'todo_done' }, filter: null,
    actions: [{ type: 'webhook', url: 'https://bot.example/timon/events' }],
    created_by: 'user', creator_agent: null, has_secret: false, has_outbound_secret: true, url: null,
    last_run_at: null, next_run_at: null, created_at: 0, updated_at: 0,
  };
  assert.deepEqual(renamed(stored).actions, stored.actions);
});

test('a script action: argv one per line, secret names, round trip, and its refusals', () => {
  const draft = draftFromTrigger(null, 'schedule');
  draft.name = 'X watcher';
  draft.cron = '*/5 7-22 * * *';
  draft.actions = [{
    ...emptyAction('script'), command: ' python3 ', scriptArgs: 'scripts/watch.py\npoll\n', cwd: '/home/me/projects/growth',
    scriptEnv: 'TREG_API_KEY, ', timeoutS: '120',
  }];
  const built = draftToBody(draft);
  assert.ok(built.ok);
  const action = { type: 'script', command: 'python3', args: ['scripts/watch.py', 'poll'], cwd: '/home/me/projects/growth', env: ['TREG_API_KEY'], timeout_s: 120 };
  assert.deepEqual(built.body.actions, [action]);
  const back = draftFromTrigger({ ...(built.body as unknown as TriggerPublic), actions: [action] } as TriggerPublic, 'schedule');
  const rebuilt = draftToBody(back);
  assert.ok(rebuilt.ok);
  assert.deepEqual(rebuilt.body.actions, [action]);

  const problem = (patch: Record<string, unknown>) => {
    draft.actions = [{ ...draft.actions[0]!, ...patch }];
    const result = draftToBody(draft);
    return result.ok ? null : result.problem.key;
  };
  assert.equal(problem({ cwd: 'projects/growth' }), 'triggersPage.errors.scriptCwd');
  assert.equal(problem({ cwd: 'C:\\work\\growth', scriptEnv: 'lower_case' }), 'triggersPage.errors.scriptEnv');
  assert.equal(problem({ scriptEnv: '', timeoutS: '0' }), 'triggersPage.errors.scriptTimeout');
  assert.equal(problem({ timeoutS: '', command: ' ' }), 'triggersPage.errors.scriptCommand');
  draft.actions = [{ ...draft.actions[0]!, command: 'node', allowOverlap: true, notifyOnFailure: false }];
  const flags = draftToBody(draft);
  assert.ok(flags.ok);
  assert.deepEqual((flags.body.actions as Array<Record<string, unknown>>)[0], {
    type: 'script', command: 'node', args: ['scripts/watch.py', 'poll'], cwd: 'C:\\work\\growth', overlap: 'allow', notify_on_failure: false,
  });
});
