/**
 * The Kanban board's filters — agent and project — as pure functions, so the
 * page only wires them to its Selects and the tests need no DOM.
 *
 * A task's project is its own `project` when it was created with one, else its
 * agent's: the rule the daemon applies to the DONE window (`done_project`,
 * `doneTaskFilter` in the kanban routes). Both sides must agree, or the DONE
 * column would count cards the board then hides.
 */

/** "No filter" in a Select. Neither an agent name nor a project slug can hold `*`. */
export const ALL_FILTER = '*';

/** `q` is a case-insensitive keyword over id, title, agent and description; '' = none. */
/** `mine` keeps only the tasks that wait for the person: a block they must lift or a permission to answer. */
export type KanbanFilters = { agent: string; project: string; q: string; mine: boolean };

export const DEFAULT_KANBAN_FILTERS: KanbanFilters = { agent: ALL_FILTER, project: ALL_FILTER, q: '', mine: false };

/** Per browser, like the Project TO DO widget's choice. */
export const KANBAN_FILTERS_KEY = 'timon.kanban.filters';

type FilterableTask = {
  agent_name: string;
  project?: string | null;
  id?: string;
  title?: string;
  description?: string | null;
  awaiting_user?: number | boolean | null;
  pending_permission?: unknown;
};
type FilterableAgent = { name: string; project?: string | null };

export function taskProject(
  task: FilterableTask,
  projectByAgent: ReadonlyMap<string, string | null>,
): string | null {
  return task.project || projectByAgent.get(task.agent_name) || null;
}

/** A BLOCKED task flagged as waiting for the person. */
export function isAwaitingUser(task: { awaiting_user?: number | boolean | null }): boolean {
  return !!task.awaiting_user;
}

/** Waits for the person: flagged so, or stopped on a permission card. */
export function needsMyAction(task: FilterableTask): boolean {
  return isAwaitingUser(task) || !!task.pending_permission;
}

export function isFiltered(filters: KanbanFilters): boolean {
  return filters.mine || filters.agent !== ALL_FILTER || filters.project !== ALL_FILTER || filters.q.trim() !== '';
}

export function filterBoardTasks<T extends FilterableTask>(
  tasks: readonly T[],
  filters: KanbanFilters,
  projectByAgent: ReadonlyMap<string, string | null>,
): T[] {
  if (!isFiltered(filters)) return [...tasks];
  return tasks.filter((t) =>
    (filters.agent === ALL_FILTER || t.agent_name === filters.agent)
    && (filters.project === ALL_FILTER || taskProject(t, projectByAgent) === filters.project)
    && (!filters.mine || needsMyAction(t))
    && matchesQuery([t.id, t.title, t.agent_name, t.description], filters.q));
}

function matchesQuery(fields: readonly (string | null | undefined)[], q: string): boolean {
  const needle = q.trim().toLowerCase();
  return !needle || fields.some((f) => f?.toLowerCase().includes(needle));
}

/** The TO DO column: ideas carry a project but no agent, so the project
 *  and keyword filters narrow them — the agent filter leaves the column whole. */
export function filterTodoItems<T extends { id: number; text: string; project?: string | null }>(
  items: readonly T[],
  filters: KanbanFilters,
): T[] {
  return items.filter((i) =>
    (filters.project === ALL_FILTER || i.project === filters.project)
    && matchesQuery([`#${i.id}`, i.text], filters.q));
}

/** Query of the board's list: `done_limit` first, then the filters the daemon
 *  windows DONE tasks with. */
export function boardTaskQuery(doneLimit: number, filters: KanbanFilters): string {
  const query = new URLSearchParams({ done_limit: String(doneLimit) });
  if (filters.agent !== ALL_FILTER) query.set('done_agent', filters.agent);
  if (filters.project !== ALL_FILTER) query.set('done_project', filters.project);
  if (filters.q.trim()) query.set('done_q', filters.q.trim());
  return query.toString();
}

/** Projects offered: those of the agents and of the loaded tasks, plus the
 *  current choice — a stored project nobody uses any more stays visible, so
 *  the user can see why the board is empty and clear it. */
export function projectOptions(
  agents: readonly FilterableAgent[],
  tasks: readonly FilterableTask[],
  filters: KanbanFilters,
): string[] {
  const slugs = new Set<string>();
  for (const a of agents) if (a.project) slugs.add(a.project);
  for (const t of tasks) if (t.project) slugs.add(t.project);
  if (filters.project !== ALL_FILTER) slugs.add(filters.project);
  return [...slugs].sort((a, b) => a.localeCompare(b));
}

/** Agents offered: those of the chosen project, plus the current choice. */
export function agentOptions(agents: readonly FilterableAgent[], filters: KanbanFilters): string[] {
  const names = agents
    .filter((a) => filters.project === ALL_FILTER || a.project === filters.project)
    .map((a) => a.name);
  if (filters.agent !== ALL_FILTER && !names.includes(filters.agent)) names.push(filters.agent);
  return names;
}

/** Choosing a project drops an agent that belongs to another one: the pair
 *  would leave the board empty for a reason the user no longer sees. */
export function withProject(
  filters: KanbanFilters,
  project: string,
  agents: readonly FilterableAgent[],
): KanbanFilters {
  if (project === ALL_FILTER || filters.agent === ALL_FILTER) return { ...filters, project };
  const agent = agents.find((a) => a.name === filters.agent);
  return { ...filters, project, agent: agent && agent.project === project ? filters.agent : ALL_FILTER };
}

export function readKanbanFilters(storage: Pick<Storage, 'getItem'> | null): KanbanFilters {
  try {
    const raw = storage?.getItem(KANBAN_FILTERS_KEY);
    if (!raw) return DEFAULT_KANBAN_FILTERS;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_KANBAN_FILTERS;
    const { agent, project, q, mine } = parsed as Record<string, unknown>;
    return {
      agent: typeof agent === 'string' && agent ? agent : ALL_FILTER,
      project: typeof project === 'string' && project ? project : ALL_FILTER,
      q: typeof q === 'string' ? q : '',
      mine: mine === true,
    };
  } catch {
    // Corrupt value or storage refused (private browsing): no filter.
    return DEFAULT_KANBAN_FILTERS;
  }
}

export function writeKanbanFilters(
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null,
  filters: KanbanFilters,
): void {
  try {
    if (!isFiltered(filters)) storage?.removeItem(KANBAN_FILTERS_KEY);
    else storage?.setItem(KANBAN_FILTERS_KEY, JSON.stringify(filters));
  } catch {
    // The choice simply won't survive a reload.
  }
}
