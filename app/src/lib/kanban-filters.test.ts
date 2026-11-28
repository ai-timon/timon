import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_FILTER,
  DEFAULT_KANBAN_FILTERS,
  KANBAN_FILTERS_KEY,
  agentOptions,
  boardTaskQuery,
  filterBoardTasks,
  filterTodoItems,
  isFiltered,
  projectOptions,
  readKanbanFilters,
  taskProject,
  withProject,
  writeKanbanFilters,
} from './kanban-filters';

const agents = [
  { name: 'alpha.coder', project: 'alpha' },
  { name: 'alpha.reviewer', project: 'alpha' },
  { name: 'beta.coder', project: 'beta' },
  { name: 'loose', project: null },
];
const projectByAgent = new Map(agents.map((a) => [a.name, a.project]));
const tasks = [
  { id: 'a1', agent_name: 'alpha.coder' },
  { id: 'a2', agent_name: 'alpha.reviewer' },
  { id: 'b1', agent_name: 'beta.coder' },
  // Created with --project alpha on an agent of another project.
  { id: 'pinned', agent_name: 'beta.coder', project: 'alpha' },
  { id: 'orphan', agent_name: 'loose' },
];
const ids = (rows: { id: string }[]) => rows.map((t) => t.id);

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

test('a task\'s project is its own, else its agent\'s', () => {
  assert.equal(taskProject(tasks[0]!, projectByAgent), 'alpha');
  assert.equal(taskProject(tasks[3]!, projectByAgent), 'alpha');
  assert.equal(taskProject(tasks[4]!, projectByAgent), null);
  assert.equal(taskProject({ agent_name: 'gone' }, projectByAgent), null);
});

test('no filter keeps every task', () => {
  assert.deepEqual(ids(filterBoardTasks(tasks, DEFAULT_KANBAN_FILTERS, projectByAgent)), ids(tasks));
  assert.equal(isFiltered(DEFAULT_KANBAN_FILTERS), false);
});

test('the project filter alone keeps that project\'s tasks, explicit project included', () => {
  const filters = { agent: ALL_FILTER, project: 'alpha', q: '', mine: false };
  assert.deepEqual(ids(filterBoardTasks(tasks, filters, projectByAgent)), ['a1', 'a2', 'pinned']);
  assert.deepEqual(ids(filterBoardTasks(tasks, { agent: ALL_FILTER, project: 'beta', q: '', mine: false }, projectByAgent)), ['b1']);
});

test('agent and project combine', () => {
  assert.deepEqual(ids(filterBoardTasks(tasks, { agent: 'alpha.coder', project: 'alpha', q: '', mine: false }, projectByAgent)), ['a1']);
  assert.deepEqual(ids(filterBoardTasks(tasks, { agent: 'beta.coder', project: 'alpha', q: '', mine: false }, projectByAgent)), ['pinned']);
  assert.deepEqual(ids(filterBoardTasks(tasks, { agent: 'beta.coder', project: ALL_FILTER, q: '', mine: false }, projectByAgent)), ['b1', 'pinned']);
});

test('the query asks the daemon for the same DONE window', () => {
  assert.equal(boardTaskQuery(20, DEFAULT_KANBAN_FILTERS), 'done_limit=20');
  assert.equal(boardTaskQuery(40, { agent: ALL_FILTER, project: 'alpha', q: '', mine: false }), 'done_limit=40&done_project=alpha');
  assert.equal(
    boardTaskQuery(20, { agent: 'alpha.coder', project: 'alpha', q: '', mine: false }),
    'done_limit=20&done_agent=alpha.coder&done_project=alpha',
  );
});

test('options: projects of agents and tasks, agents of the chosen project, current choice kept', () => {
  assert.deepEqual(projectOptions(agents, tasks, DEFAULT_KANBAN_FILTERS), ['alpha', 'beta']);
  assert.deepEqual(
    projectOptions(agents, [{ agent_name: 'loose', project: 'gamma' }], { agent: ALL_FILTER, project: 'retired', q: '', mine: false }),
    ['alpha', 'beta', 'gamma', 'retired'],
  );
  assert.deepEqual(agentOptions(agents, DEFAULT_KANBAN_FILTERS), agents.map((a) => a.name));
  assert.deepEqual(agentOptions(agents, { agent: ALL_FILTER, project: 'alpha', q: '', mine: false }), ['alpha.coder', 'alpha.reviewer']);
  assert.deepEqual(agentOptions(agents, { agent: 'deleted.agent', project: 'alpha', q: '', mine: false }), ['alpha.coder', 'alpha.reviewer', 'deleted.agent']);
});

test('choosing a project keeps an agent of that project and drops another', () => {
  assert.deepEqual(withProject({ agent: 'alpha.coder', project: ALL_FILTER, q: '', mine: false }, 'alpha', agents), { agent: 'alpha.coder', project: 'alpha', q: '', mine: false });
  assert.deepEqual(withProject({ agent: 'beta.coder', project: ALL_FILTER, q: '', mine: false }, 'alpha', agents), { agent: ALL_FILTER, project: 'alpha', q: '', mine: false });
  assert.deepEqual(withProject({ agent: 'beta.coder', project: 'alpha', q: '', mine: false }, ALL_FILTER, agents), { agent: 'beta.coder', project: ALL_FILTER, q: '', mine: false });
});

test('the choice persists, and a reset clears it', () => {
  const storage = new MemoryStorage();
  assert.deepEqual(readKanbanFilters(storage), DEFAULT_KANBAN_FILTERS);
  writeKanbanFilters(storage, { agent: 'alpha.coder', project: 'alpha', q: '', mine: false });
  assert.deepEqual(readKanbanFilters(storage), { agent: 'alpha.coder', project: 'alpha', q: '', mine: false });

  writeKanbanFilters(storage, DEFAULT_KANBAN_FILTERS);
  assert.equal(storage.getItem(KANBAN_FILTERS_KEY), null, 'a reset leaves nothing behind');
  assert.deepEqual(readKanbanFilters(storage), DEFAULT_KANBAN_FILTERS);
});

test('a corrupt or refused storage means no filter', () => {
  const storage = new MemoryStorage();
  storage.setItem(KANBAN_FILTERS_KEY, '{not json');
  assert.deepEqual(readKanbanFilters(storage), DEFAULT_KANBAN_FILTERS);
  storage.setItem(KANBAN_FILTERS_KEY, JSON.stringify({ agent: 42, project: '', q: '' }));
  assert.deepEqual(readKanbanFilters(storage), DEFAULT_KANBAN_FILTERS);
  const refusing = {
    getItem(): string | null { throw new Error('SecurityError'); },
    setItem(): void { throw new Error('QuotaExceededError'); },
    removeItem(): void { throw new Error('SecurityError'); },
  };
  assert.deepEqual(readKanbanFilters(refusing), DEFAULT_KANBAN_FILTERS);
  assert.doesNotThrow(() => writeKanbanFilters(refusing, { agent: ALL_FILTER, project: 'alpha', q: '', mine: false }));
  assert.deepEqual(readKanbanFilters(null), DEFAULT_KANBAN_FILTERS);
});

test('the keyword matches id, title, agent and description, case-insensitively', () => {
  const rows = [
    { id: 'a1', agent_name: 'alpha.coder', title: 'Fix Login flow' },
    { id: 'b1', agent_name: 'beta.coder', title: 'Docs', description: 'mentions the LOGIN page' },
    { id: 'c1', agent_name: 'loose', title: 'Other' },
  ];
  const withQ = (q: string) => ({ ...DEFAULT_KANBAN_FILTERS, q });
  assert.deepEqual(ids(filterBoardTasks(rows, withQ('login'), projectByAgent)), ['a1', 'b1']);
  assert.deepEqual(ids(filterBoardTasks(rows, withQ('BETA'), projectByAgent)), ['b1']);
  assert.deepEqual(ids(filterBoardTasks(rows, withQ('c1'), projectByAgent)), ['c1']);
  assert.deepEqual(ids(filterBoardTasks(rows, withQ('  '), projectByAgent)), ids(rows));
  assert.equal(isFiltered(withQ('x')), true);
  assert.equal(isFiltered(withQ('  ')), false);
  assert.equal(boardTaskQuery(20, withQ(' login ')), 'done_limit=20&done_q=login');
  assert.deepEqual(withProject(withQ('x'), 'alpha', agents).q, 'x');
});

test('the TO DO column follows the project and keyword filters, not the agent', () => {
  const ideas = [
    { id: 1, text: 'Dark mode', project: 'alpha' },
    { id: 2, text: 'Export CSV', project: 'beta' },
    { id: 3, text: 'Loose idea', project: null },
  ];
  const tid = (r: { id: number }[]) => r.map((i) => i.id);
  assert.deepEqual(tid(filterTodoItems(ideas, DEFAULT_KANBAN_FILTERS)), [1, 2, 3]);
  assert.deepEqual(tid(filterTodoItems(ideas, { ...DEFAULT_KANBAN_FILTERS, project: 'alpha' })), [1]);
  assert.deepEqual(tid(filterTodoItems(ideas, { ...DEFAULT_KANBAN_FILTERS, agent: 'beta.coder' })), [1, 2, 3]);
  assert.deepEqual(tid(filterTodoItems(ideas, { ...DEFAULT_KANBAN_FILTERS, q: 'csv' })), [2]);
  assert.deepEqual(tid(filterTodoItems(ideas, { ...DEFAULT_KANBAN_FILTERS, q: '#3' })), [3]);
});

test('the "my turn" filter keeps the tasks flagged as waiting for the person, or stopped on a permission', () => {
  const board = [
    { id: 'x1', agent_name: 'alpha.coder', awaiting_user: 1 },
    { id: 'x2', agent_name: 'alpha.coder', awaiting_user: 0 },
    { id: 'x3', agent_name: 'alpha.coder', pending_permission: { tool_name: 'Bash' } },
    { id: 'x4', agent_name: 'alpha.coder' },
  ];
  const mine = { ...DEFAULT_KANBAN_FILTERS, mine: true };
  assert.equal(isFiltered(mine), true);
  assert.deepEqual(filterBoardTasks(board, mine, projectByAgent).map((t) => t.id), ['x1', 'x3']);
  assert.equal(filterBoardTasks(board, DEFAULT_KANBAN_FILTERS, projectByAgent).length, 4);
});

test('the "my turn" choice survives a reload, and an older stored value reads as off', () => {
  const store = new Map<string, string>();
  writeKanbanFilters({ setItem: (k, v) => void store.set(k, v), removeItem: (k) => void store.delete(k) }, { ...DEFAULT_KANBAN_FILTERS, mine: true });
  const read = () => readKanbanFilters({ getItem: (k) => store.get(k) ?? null });
  assert.equal(read().mine, true);
  store.set(KANBAN_FILTERS_KEY, JSON.stringify({ agent: ALL_FILTER, project: ALL_FILTER, q: 'x' }));
  assert.equal(read().mine, false);
});
