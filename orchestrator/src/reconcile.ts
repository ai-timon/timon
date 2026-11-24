/**
 * Reconciliation loop: TIMON's central guard.
 *
 * ## Why this module exists
 *
 * TIMON is driven by events (`bus.emit`, synchronous, in-memory listeners).
 * An event is a single shot: if it gets lost — listener not registered yet,
 * orchestrator restart mid-flight, status not committed yet when the
 * handler reads the DB, task closed outside the end of a mission — the state stays
 * inconsistent FOREVER, and nothing reports it. The symptom is always the
 * same and always misleading: everything shows `DONE`, everything looks right, and the
 * work is not integrated.
 *
 * The pattern repeated itself often enough to stop being an accident:
 *   - 2026-05-25: merge tasks DONE without `merged_commit_sha` (branch never
 *     integrated) → `auditMergedTasksWithoutSha`.
 *   - IN_PROGRESS tasks whose mission had finished before the listeners
 *     were registered → `reconcileOrphanedTasks`.
 *   - 2026-08-04: `pass` review whose merge was never created, and librarian
 *     config never resynchronised with the code.
 *
 * Each had been patched in its own place, with its own cadence and its
 * own log style. This module gathers them: the system's invariants are
 * DECLARED here, in a single place, and a single loop checks them.
 *
 * ## The principle
 *
 * Do not ask "which event was lost?" but "what should the state
 * look like?". Each rule rebuilds the expected state and corrects the gap.
 * The rules must therefore be IDEMPOTENT: replaying them on a healthy system
 * must do nothing.
 *
 * ## Adding a rule
 *
 * Write the function in the module that owns the domain (dispatcher for the
 * tasks, librarian for its config…), then:
 *   - generic Kanban invariant, without an optional dependency → `RULES` below;
 *   - invariant of a module that may not be loaded (git, grepai, embedded
 *     browser) → `registerReconcileRule()`, called by the module itself.
 * This module must import ONLY `dispatcher`, `task-chain` and `worktree-gc`:
 * importing `grepai` or `browser-sessions` from here would make reconciliation —
 * hence the boot — depend on modules that can be disabled.
 * Choose the cadence with care — see `ReconcileCadence`.
 */
import { reconcileOrphanedTasks, auditMergedTasksWithoutSha } from './dispatcher.js';
import { reconcileLandedIntegrations, reconcileUnchainedTasks } from './task-chain.js';
import { reconcileStaleWorktrees } from './worktree-gc.js';

/**
 * When a rule runs.
 *
 * - `boot`: only once at start. For the rules that NOTIFY (a
 *   notification repeated every N minutes is spam) or whose domain can
 *   only drift between two boots.
 * - `interval`: periodically. For the drifts that appear during the
 *   process's life, while the orchestrator runs.
 * - `both`: both. The safest default when the rule is idempotent and
 *   silent in the absence of a gap.
 */
export type ReconcileCadence = 'boot' | 'interval' | 'both';

export interface ReconcileRule {
  /** Short identifier, shown in the logs. */
  name: string;
  /** The invariant checked, phrased as a true statement about the healthy system. */
  invariant: string;
  cadence: ReconcileCadence;
  /** Checks AND corrects. Must be idempotent and log its own actions. */
  run: () => void | Promise<void>;
}

/** Grace left to the listeners and to the recovery before a reconciliation
 *  rules on a freshly finished mission. */
const ORPHAN_GRACE_MS = 5 * 60 * 1000;

/** Goes `true` once the boot pass is over: the rules that
 *  behave differently at start (no grace on a frozen state) and in
 *  steady state refer to it. */
let bootDone = false;

const RULES: ReconcileRule[] = [
  {
    name: 'orphaned-tasks',
    invariant: 'Every IN_PROGRESS task has a mission still alive.',
    // Only touches the tasks whose mission is ALREADY finished — a task
    // legitimately in flight has a `running` mission and is never a candidate.
    // Periodically a grace is added: a mission that has just finished is
    // still in the hands of the listeners and the recovery, pre-empting it would
    // wrongly block a task that was about to resume. At boot the grace is zero, nothing
    // runs yet.
    cadence: 'both',
    run: () => reconcileOrphanedTasks(bootDone ? ORPHAN_GRACE_MS : 0),
  },
  {
    name: 'unchained-tasks',
    invariant: 'Every DONE task has had its follow-up chain started (review/merge/doc/batch recap).',
    // `both`: the nominal case is a restart mid-flight (the `task_done` event
    // is in memory, it does not survive the process), caught up at boot;
    // periodically we also catch up a chain that failed along the way.
    cadence: 'both',
    run: reconcileUnchainedTasks,
  },
  {
    name: 'landed-integrations',
    invariant: 'Every merged integration branch has had its landing replayed on its chains (TO DO, doc).',
    // `both`: the poller marks a branch merged then replays its landing; a stop
    // between the two writes is caught up at boot, a failed replay later on.
    // Idempotent and silent when every merged branch has landed.
    cadence: 'both',
    run: reconcileLandedIntegrations,
  },
  {
    name: 'stale-worktrees',
    invariant: 'A DONE task whose work is merged has neither worktree nor branch left.',
    // `both`: the leftovers pile up while the orchestrator runs (each
    // closed task is a source of them), and the boot pass catches up what was
    // left by a stop mid-flight. Never touches an unintegrated branch,
    // so the rule is safe to replay.
    cadence: 'both',
    run: reconcileStaleWorktrees,
  },
  {
    name: 'merge-without-sha',
    invariant: 'Every DONE merge task carries the SHA of the merge it produced.',
    // `boot` STRICTLY: this rule notifies the user and corrects nothing (the
    // targeted tasks have been closed for a long time, their dependents have moved on).
    // Making it periodic would send the same notification in a loop.
    cadence: 'boot',
    run: auditMergedTasksWithoutSha,
  },
];

/**
 * Rules set by the optional modules (kanban-code, grepai,
 * browser-embedded). Separate from `RULES` because they only exist if their
 * module is loaded: declaring them hard-coded here would force reconciliation to
 * import code the installation may very well not have — and so
 * make the boot depend on modules that can be disabled.
 *
 * Returns its removal: unloading a module must remove its invariants along with it.
 */
const registered: ReconcileRule[] = [];

export function registerReconcileRule(rule: ReconcileRule): () => void {
  registered.push(rule);
  return () => {
    const i = registered.indexOf(rule);
    if (i >= 0) registered.splice(i, 1);
  };
}

/** All the rules in force: the generic ones then the modules'. */
function allRules(): ReconcileRule[] {
  return [...RULES, ...registered];
}

/** Interval of the loop. Wide on purpose: it is a safety net, not a
 *  nominal path — events stay the normal way and react in ms. */
const INTERVAL_MS = 120_000;

/** Selects the rules to run for a given cadence. Pure function,
 *  exported to be testable without mounting the database or the business modules. */
export function selectRules<T extends { cadence: ReconcileCadence }>(
  rules: readonly T[],
  cadence: 'boot' | 'interval',
): T[] {
  return rules.filter((r) => r.cadence === cadence || r.cadence === 'both');
}

async function runRules(cadence: 'boot' | 'interval'): Promise<void> {
  for (const rule of selectRules(allRules(), cadence)) {
    try {
      await rule.run();
    } catch (err) {
      // A failing rule must never prevent the following ones from running:
      // it is precisely when the system is damaged that the others are needed.
      console.error(`[reconcile] rule "${rule.name}" failed: ${(err as Error).message}`);
    }
  }
}

/**
 * Starts the reconciliation: an immediate `boot` pass, then the periodic
 * loop.
 *
 * To call AFTER the zombie sweep and the registration of the listeners (dispatcher,
 * verification-loop, recovery): the boot pass corrects what those listeners
 * could not see, it does not replace them.
 */
export function startReconcile(): () => void {
  void runRules('boot').finally(() => { bootDone = true; });

  const timer = setInterval(() => {
    void runRules('interval');
  }, INTERVAL_MS);
  timer.unref();

  const rules = allRules();
  const periodic = rules.filter((r) => r.cadence !== 'boot').length;
  console.log(
    `[reconcile] started (${rules.length} invariants, ${periodic} periodic, interval=${INTERVAL_MS / 1000}s)`,
  );
  return () => clearInterval(timer);
}

/** Exposed for introspection (/debug API, tests): the list of invariants
 *  the system commits to maintaining. */
export function listReconcileRules(): ReadonlyArray<Omit<ReconcileRule, 'run'>> {
  return allRules().map(({ name, invariant, cadence }) => ({ name, invariant, cadence }));
}
