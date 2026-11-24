/**
 * A TO DO idea closes itself when the task chain that implements it lands.
 *
 * Until 05/10/2026 closing an idea relied on the agent remembering to call
 * `project_todo_update` — and the notebook never went down: on 147 ideas, the
 * coder of #209 shipped without ticking it and the orchestrator had to do it.
 * A task now carries `todo_id`; this module decides, from a task that just went
 * DONE, which ideas that closure settles. The agent keeps the CHANGELOG and the
 * TIM-XXXX identifier (AGENTS.md rule 15): only the checkbox is automated.
 *
 * "Lands" means the code is merged, never earlier — a review can still refuse a
 * `code` task that is DONE. Hence, per pipeline:
 *   - `full`       → the `merge` task DONE with its sha;
 *   - `code-self`  → the `code` task DONE with its sha (the coder merged it);
 *   - `code-group` → the final `merge` task, for every code task of the group;
 *   - `chore` / `doc` → their own closure;
 *   - `research`   → never closes: an idea studied is `analyzed`, not done.
 * A chain whose coder wrote `à tester Win/Mac` (rule 9) closes like any other
 * (the maintainer, 07/10/2026: a notebook that never goes down helps nobody). The owed OS
 * test is not lost: the closure carries `osTest`, the work return says so, and
 * the coder already listed it in `docs/A-TESTER-MULTI-OS.md`.
 *
 * Only the ROOT task of a chain carries `todo_id`; review, repair iterations,
 * merge and doc never copy it. Everything below walks back to that root.
 *
 * One idea, several chains (TODO #462): a series often splits one idea into N
 * root tasks carrying the same `todo_id`. A `done` closure waits for the LAST
 * of them: while another root chain of the idea has not landed, the idea only
 * moves to `partial` and the work return says how many chains landed. A root
 * counts as a sibling unless it is a `review`, `merge`, `doc` or `research`
 * (an idea studied is not an idea waiting); a BLOCKED root is still open, a
 * deleted one no longer exists. The `code-group` final merge lands every slice
 * of its batch at once, so a batch on a single idea still closes in one go.
 *
 * A chain on an integration branch (`integration_mode` 'branch' or 'pr') is
 * only INTEGRATED by its merge: the work is in `feat/<topic>`, not in the
 * target. Its idea then moves to `partial` and waits; it closes when the branch
 * lands (`chain-landing.ts`), when `integration-landing.ts` replays this same
 * closure on every DONE task of the job. A local chain is unchanged.
 *
 * Split in two on purpose: `planTodoClosure` is read-only, so the work return
 * (`handleTaskDone`, wake.ts) can announce the closure synchronously while the
 * chain applies it a tick later (`applyTodoClosure`, task-chain.ts).
 */
import { dbApi, type ProjectTodoRow, type TaskRow } from './db.js';
import { publishPluginRealtime } from './plugins/realtime.js';
import { hasLanded, pendingLanding } from './chain-landing.js';

export type TodoClosureProgress = 'done' | 'analyzed' | 'partial';
/** `osTest`: the idea is closed but its coder reported an OS test still owed.
 *  `landed` / `total`: for `partial`, the root chains of the idea that landed.
 *  `integrating`: the integration branch this closure's chain waits in; the
 *  idea closes when that branch lands. */
export type TodoClosure = {
  todoId: number; progress: TodoClosureProgress; osTest?: true; landed?: number; total?: number;
  integrating?: string;
};

/** The portability line of rule 9 (`portabilité : …`) announcing an OS test
 *  still owed. Only that line counts: prose quoting the rule elsewhere in the
 *  report is not a verdict. Nor is the bare template
 *  (`n/a | vérifiée | à tester Win/Mac`), which lists every value. */
// french-ok: the coder reports of rule 9 write this line in French
const PORTABILITY_LINE_RE = /portab(?:ilit[ée]|ility)\W*:\s*(.*)$/i;
const TO_TEST_RE = /(?:à|a)\s+tester\s+win\s*\/\s*mac|to\s+test\s+win\s*\/\s*mac/i;

export function needsMultiOsTest(comment: string | null): boolean {
  if (!comment) return false;
  return comment.split(/\r?\n/).some((line) => {
    const value = PORTABILITY_LINE_RE.exec(line)?.[1];
    return !!value && TO_TEST_RE.test(value) && !value.includes('|');
  });
}

function depsOf(task: TaskRow): string[] {
  try {
    const deps: unknown = JSON.parse(task.deps);
    return Array.isArray(deps) ? deps.filter((d): d is string => typeof d === 'string') : [];
  } catch {
    return [];
  }
}

function chainRoot(task: TaskRow): TaskRow {
  if (!task.verification_root_id) return task;
  return dbApi.getTask(task.verification_root_id) ?? task;
}

/** The code task whose report is current: the highest DONE iteration. */
function latestCode(root: TaskRow): TaskRow {
  const codes = [root, ...dbApi.listTasksByVerificationRoot(root.id)]
    .filter((t) => t.type === 'code' && t.status === 'DONE');
  codes.sort((a, b) => b.iteration - a.iteration || b.created_at - a.created_at);
  return codes[0] ?? root;
}

/**
 * Root code tasks a merge integrates.
 *
 * The verification loop does not tag a `merge` with `verification_root_id` —
 * only its review is tagged — so the walk is merge → deps (review or code) →
 * root. It never follows a CODE task's own deps: those may name an earlier,
 * unrelated feature whose idea this merge has nothing to do with.
 */
function codeRootsOfMerge(merge: TaskRow): TaskRow[] {
  const roots = new Map<string, TaskRow>();
  const add = (t: TaskRow) => { const root = chainRoot(t); roots.set(root.id, root); };
  let followsReview = false;
  for (const depId of depsOf(merge)) {
    const dep = dbApi.getTask(depId);
    if (!dep) continue;
    if (dep.type === 'code') add(dep);
    if (dep.type !== 'review') continue;
    followsReview = true;
    const reviewed = dep.verification_root_id ? [dep.verification_root_id] : depsOf(dep);
    for (const id of reviewed) {
      const code = dbApi.getTask(id);
      if (code?.type === 'code') add(code);
    }
  }
  // `code-group`: the final merge consolidates the whole batch. Restricted to
  // that pipeline — a merge created by hand in a `full` batch would otherwise
  // close ideas whose code has not been merged — and to DONE work: a slice left
  // BLOCKED did not land with the others. A merge that follows a review is one
  // feature's chain merge, which sits in its batch too (TODO #521): in a batch
  // mixing `full` and `code-group` slices it integrates its own branch only.
  if (merge.group_id && !followsReview) {
    for (const t of dbApi.listTasksByGroup(merge.group_id)) {
      if (t.type === 'code' && t.pipeline === 'code-group' && t.status === 'DONE') add(t);
    }
  }
  return [...roots.values()];
}

/** Types that never hold an idea open: they follow a chain, or only study. */
const NOT_A_SIBLING = new Set<string>(['review', 'merge', 'doc', 'research']);

/** Root chains implementing `todoId`, deduplicated through their root. */
function siblingRoots(todoId: number): TaskRow[] {
  const roots = new Map<string, TaskRow>();
  for (const t of dbApi.listTasksByTodo(todoId)) {
    const root = chainRoot(t);
    if (!NOT_A_SIBLING.has(root.type)) roots.set(root.id, root);
  }
  return [...roots.values()];
}

/** Whether the chain of `root` has landed, by the same rules as the closure:
 *  integrated into its base, and that base landed. */
function chainLanded(root: TaskRow): boolean {
  if (root.type !== 'code') return root.status === 'DONE' && hasLanded(root);
  const chain = dbApi.listVerificationChain(root.id);
  if (chain.some((t) => t.type === 'code' && t.status === 'DONE' && !!t.merged_commit_sha)) {
    return hasLanded(root);
  }
  const merges = chain.filter((t) => t.type === 'merge');
  if (root.group_id && root.pipeline === 'code-group') {
    merges.push(...dbApi.listTasksByGroup(root.group_id).filter((t) => t.type === 'merge'));
  }
  return merges.some((m) => m.status === 'DONE' && !!m.merged_commit_sha
    && codeRootsOfMerge(m).some((r) => r.id === root.id) && hasLanded(m) && hasLanded(root));
}

/** What closing `task` does to the ideas it carries. Read-only. */
export function planTodoClosure(task: TaskRow): TodoClosure[] {
  if (task.status !== 'DONE') return [];
  const plan = new Map<number, TodoClosure>();
  // Root chains this closure lands: they no longer hold their idea open.
  const landedNow = new Set<string>();
  // Two slices of one batch implementing the same idea: an owed OS test on
  // either one is kept.
  const put = (todoId: number | null, progress: TodoClosureProgress, osTest = false, integrating: string | null = null) => {
    if (!todoId) return;
    const owed = osTest || plan.get(todoId)?.osTest === true;
    // Two slices of one idea, one landed and one only integrated: the idea
    // waits for the second.
    const waits = integrating ?? plan.get(todoId)?.integrating ?? null;
    plan.set(todoId, {
      todoId,
      progress: waits && progress === 'done' ? 'partial' : progress,
      ...(owed ? { osTest: true as const } : {}),
      ...(waits ? { integrating: waits } : {}),
    });
  };
  const landed = (root: TaskRow) => {
    // Integrated into an integration branch only: the chain is not counted
    // as landed, and its idea is held open until that branch lands.
    const waits = pendingLanding(task, root);
    if (!waits) landedNow.add(root.id);
    const code = latestCode(root);
    const osTest = needsMultiOsTest(code.done_comment);
    put(root.todo_id, 'done', osTest, waits);
    if (code.todo_id !== root.todo_id) put(code.todo_id, 'done', osTest, waits);
  };
  switch (task.type) {
    case 'merge':
      if (!task.merged_commit_sha) break;
      for (const root of codeRootsOfMerge(task)) landed(root);
      put(task.todo_id, 'done', false, pendingLanding(task));
      break;
    case 'code':
      // `full` / `code-group`: the review or the final merge still has a say,
      // unless the task was marked merged by hand (TIM-0109).
      if (task.merged_commit_sha) landed(chainRoot(task));
      break;
    case 'chore':
    case 'doc': {
      const waits = pendingLanding(task);
      if (!waits) landedNow.add(chainRoot(task).id);
      put(task.todo_id, 'done', false, waits);
      break;
    }
    case 'research':
      put(task.todo_id, 'analyzed');
      break;
    case 'review':
      break;
  }
  return [...plan.values()].flatMap((c) => {
    const todo = dbApi.getProjectTodo(c.todoId);
    if (!todo) return [];
    // An idea already done stays as it is: `applyTodoClosure` never touches it.
    if (todo.status === 'done') return [c];
    if (c.progress !== 'done' && !c.integrating) return [c];
    const roots = siblingRoots(c.todoId);
    const open = roots.filter((r) => !landedNow.has(r.id) && !chainLanded(r)).length;
    if (!open && !c.integrating) return [c];
    // An integrated chain is open by definition; a sibling list that does not
    // name it (its root carries no `todo_id`) still counts it.
    const total = Math.max(roots.length, 1);
    return [{ ...c, progress: 'partial' as const, landed: total - Math.max(open, 1), total }];
  });
}

function publishTodoChanged(row: ProjectTodoRow): void {
  // Same event as the notebook routes: the widget refreshes on it. System rows
  // have no account to address.
  if (!row.owner_user_id) return;
  publishPluginRealtime('@timon/kanban', 'project-todo.changed', { id: row.id }, { ownerUserId: row.owner_user_id });
}

/**
 * Apply `planTodoClosure`. Idempotent and one-way: an idea already `done` is
 * never touched — never reopened — `analyzed` only replaces an untouched
 * `todo`, and `partial` never moves an idea back (`to_test` stays). A promoted idea goes to `done`
 * too: promotion is where it left the notebook, landing is where it ends.
 * Returns what actually changed.
 */
export function applyTodoClosure(task: TaskRow): TodoClosure[] {
  const applied: TodoClosure[] = [];
  for (const closure of planTodoClosure(task)) {
    const todo = dbApi.getProjectTodo(closure.todoId);
    if (!todo || todo.status === 'done') continue;
    let row: ProjectTodoRow | undefined;
    if (closure.progress === 'done') {
      // Both fields: the status↔progress sync of `updateProjectTodo` is skipped
      // on a promoted idea, which would otherwise keep its old progress.
      row = dbApi.updateProjectTodo(todo.id, { status: 'done', progress: 'done' });
    } else if (closure.progress === 'partial') {
      if (todo.progress === 'partial' || todo.progress === 'to_test') continue;
      row = dbApi.updateProjectTodo(todo.id, { progress: 'partial' });
    } else {
      if (todo.progress && todo.progress !== 'todo') continue;
      row = dbApi.updateProjectTodo(todo.id, { progress: 'analyzed' });
    }
    if (!row) continue;
    publishTodoChanged(row);
    applied.push(closure);
    const count = closure.total ? ` (${closure.landed}/${closure.total} chains landed)` : '';
    console.log(`[todo-closure] task ${task.id} (${task.type}) → TO DO #${todo.id} ${closure.progress}${count}`);
  }
  return applied;
}
