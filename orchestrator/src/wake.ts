import { composePrompt } from './prompt-presentation.js';
/**
 * Wake-loop: wakes the orchestrator (TIMON.main / _main) at the right time.
 *
 * Problem solved: the orchestrator is fire-and-forget — it creates tasks
 * then its mission dies. `notifyParentOnComplete` (agent.ts) already queues
 * recaps in its inbox, but NOTHING wakes it to read them → messages
 * pile up on a dead agent. This module listens on the bus and re-spawns
 * the orchestrator (resuming ITS session, hence its plan context) when:
 *
 *   - `task_blocked`      → near-immediate wake with the blockage recap.
 *                           The orchestrator then decides (re-queue, reassign,
 *                           spawn a diagnostic coder, abandon, escalate to the user).
 *   - `task_done`         → the work return is sent AT TASK CLOSURE
 *                           (handleTaskDone), not at the death of the process
 *                           that ran it: that death sometimes arrives 10 min
 *                           later (reviewer missions, which stay `running`
 *                           until the idle reap). `notifyParentOnComplete`
 *                           (agent.ts) becomes the fallback for missions without
 *                           a task, and stays silent when the return has already
 *                           been delivered (`tasks.return_notified`).
 *   - end of batch        → `evaluateGroupCompleteForTask`, called by
 *                           `task-chain.ts` at closure of the group's last task:
 *                           if THIS group has no active task left
 *                           (`groupHasActiveTasks` false, scoped to the group) and
 *                           has not already been notified (`isGroupNotified`) → wake
 *                           with a consolidated recap (N done / M blocked), then
 *                           `markGroupNotified`. Tasks without a group_id do NOT
 *                           trigger a DONE wake (legacy unchanged).
 *   - `mission_complete`  → safety net for end-of-batch only, and therefore a no-op
 *                           in the nominal case (`isGroupNotified` already set).
 *
 * Routing by mission (2026-07-28) — FIRST RULE:
 *   A message that carries a `to_mission` is delivered IN THAT MISSION, not in
 *   a new one. That mission launched the work, so it alone has the plan in
 *   context. It is resurrected if needed (`respawnWithResume`, same missionId,
 *   same provider session) regardless of its age.
 *   Founding incident (2026-07-27): `acme.main` splits a project into
 *   4 sub-missions; at the end of the 1st, the wake-loop spawns a NEW `.main`
 *   which, lacking the plan, derives its own "mission 2/4" different from the
 *   one that had just been launched. Three concurrent orchestrators, diverging
 *   plan. `to_mission` had been stored in the database all along
 *   (`notifyParentOnComplete`) — nobody was reading it.
 *   Spawning a fresh wake mission remains the fallback: messages without
 *   `to_mission`, target mission without a resumable session, or target busy
 *   for too long (see MAX_ROUTE_DEFERRALS).
 *
 * Hard guards:
 *   - Single-flight: a wake mission already in flight for this agent blocks
 *     any new flush (entry in `wakeMissions`). WARNING: this is NOT an
 *     `isRunning` test — a live chat mission of the same agent blocks
 *     nothing (see flushWakeInner). That is exactly what allowed the fork in
 *     the incident above; routing by mission is what fixes it, not this guard.
 *   - Debounce: events in a short window are aggregated before waking,
 *     to absorb bursts of task completions (MAX_PARALLEL=3).
 *   - Anti-infinite-wake: blocked-wake counter per group + cooldown reset.
 *     Past the threshold → escalate to the user directly (notifyUser) instead of
 *     re-waking, to break a re-queue → re-block → wake loop.
 *   - Wake economy: a return that calls for no decision (the chain continues
 *     on its own, or it is a `doc` task) does not consume an orchestrator turn
 *     by itself — it is HELD and merged into the next digest (see
 *     splitByUrgency / DEFERRED_HOLD_MS). A BLOCKED task, a `changes_requested`
 *     verdict or a merge always wake.
 *
 * The wake-loop NEVER rebuilds/restarts the orchestrator: it spawns a mission
 * UNDER the current orchestrator.
 *
 * Wiring: `startWake()` at boot, after `startRecovery()` / `startDispatcher()`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { bus, type BusEvent } from './bus.js';
import { CRASH_LOOP_HARD_CEILING, MAX_SYSTEM_REQUEUES, dbApi, type TaskRow, type AgentMessageRow, type MissionRow, type IntegrationRow } from './db.js';
import { diedOfSystemCause } from './crash-loop.js';
import { isRequeueableInterruption, requeueBackoffMs, toInterruptionReason } from './interruption.js';
import { presentInboxDigest, isUrgentReturn, returnPayloadOf, type ReturnPayload } from './wake-digest.js';
import { planTodoClosure } from './todo-closure.js';
import { originOfDigest, type UserEventOrigin } from './user-origin.js';
import { completeRequestReplies, latestRequestMission, reconcileRequestReplies, requestDeliveryBatch } from './agent-request-replies.js';
import { awaitChainBarriers } from './chain-barrier.js';
import {
  canResumeForeignSession,
  canSpawnMission,
  getTurnState,
  isAutonomousMission,
  isRunning,
  isResumableBackend,
  isResumableBackendName,
  respawnWithResume,
  sendToAgent,
  spawnAgent,
  switchMissionBackend,
  loadConfig,
} from './agent.js';
import { enqueueMissionReturn } from './mission-return.js';
import { cooldownReason, redirectIfStillDry } from './backend-fallback.js';
import { agentDir } from './paths.js';
import { canonicalAgentName } from './agent-config.js';
import { BackendAccountError } from './backends/account-launch.js';
import { daemonMessage, decodeDaemonMessage } from './daemon-message.js';
import { notifyUser } from './notify.js';
import { createNotification } from './notifications.js';
import { sandboxCascadeNotice } from './sandbox-cascade.js';
import { mainAgentName, mainAgentNameOrSeed } from './main-agent.js';
import { settingNum } from './settings.js';
import { admitAgentMessage, clearAgentPairs, isHumanInput, resetAgentPairs } from './agent-pair-breaker.js';
import { isMirrorTask } from './task-mirror.js';
import { integrationOfTask } from './chain-landing.js';
import { integrationTargetLabel, usesIntegrationBranch } from './git-integration.js';

/** Aggregation window before a wake — absorbs bursts of task completions.
 *  Short (1 s) to keep the SLA "every inbox processed within a minute" while
 *  still grouping near-simultaneous completions from the same group. */
const DEBOUNCE_MS = 1_000;
/** How long to wait on chaining barriers before deciding a batch's urgency
 *  (see chain-barrier.ts). Generous in front of the only slow step in a chain
 *  (the verification-loop `git diff --stat`, 5 s timeout) and a no-op in
 *  normal operation, where barriers lift in milliseconds. Overrunning does
 *  not block anything: we decide from the current database state. */
const CHAIN_WAIT_MAX_MS = 15_000;
/** Recurring DELIVERY sweep: every SWEEP_INTERVAL_MS(), (re-)wake ALL agents
 *  that have deliverable messages waiting, IN PARALLEL (one mission each, up
 *  to the global cap). Safety net that holds the <1 min SLA even if a live
 *  event was missed (back-pressure, race, short downtime) — the previous
 *  purely event-driven wake-loop never retried a failed delivery: the message
 *  rotted until expiry (deleted UNREAD). */
const SWEEP_INTERVAL_MS = (): number => settingNum('TIMON_WAKE_SWEEP_MS');
/** A pending message WITHOUT `to_mission` older than this is STALE: we never
 *  wake for it and we expire it. Prevents a fresh orchestrator from surfacing
 *  an obsolete backlog (old notifications of finished tasks) on every
 *  boot/wake.
 *
 *  Messages that DO carry a live `to_mission` escape this expiry
 *  (see deliverablePending / expireStalePending): they are addressed to a
 *  specific mission that has the context, so their age does not matter. Without
 *  this exemption, an orchestrator down for 2 h silently lost the returns of
 *  its sub-missions. */
const MESSAGE_STALE_MS = 2 * 60 * 60_000; // 2 h
/** Consecutive flushes during which we accept deferring a delivery because
 *  the target mission has a turn in progress. Past this, we fall back to
 *  spawning a wake mission: a fresh orchestrator is better than returns that
 *  are never delivered (a mission can stay busy for hours, or lose its process
 *  without `getTurnState` noticing). At 30 s per sweep, 20 attempts ≈ 10 min
 *  of waiting. */
const MAX_ROUTE_DEFERRALS = 20;
/** Interval of the reaper that expires stale pending messages. */
const STALE_REAP_MS = 30 * 60_000; // 30 min
/** Past this many closely spaced blocked-wakes on the same group, escalate
 *  to the user instead of re-waking the orchestrator (anti-loop). */
const MAX_BLOCKED_WAKES_PER_GROUP = 5;
/** If the group has had no blockage for this long, the counter resets to zero —
 *  a healthy group that re-blocks once an hour must not escalate. */
const GROUP_COUNTER_RESET_MS = 10 * 60_000;
/** Map size from which stale counters are swept (the sweep is O(n)). */
const BLOCKED_WAKES_SWEEP_AT = 256;
/** Interval at which to retry the flush when under back-pressure. */
const BACKPRESSURE_RETRY_MS = 30_000;
/** Past this many consecutive back-pressure re-arms (≈ 10×30s = 5 min without
 *  being able to wake), escalate to the user: the machine is lastingly saturated or
 *  a paused mission is blocking the cap. Otherwise the wake-loop would spin a
 *  30 s timer forever with nobody told (silent stall). */
const MAX_BACKPRESSURE_RETRIES = 10;
/** Backoff after a failed wake spawn: base × 2^(failures-1), capped. Before this,
 *  a spawn that threw (agent gone, Claude account refused for the mission's
 *  owner) was retried by every 30 s sweep — 989 failed missions in a day
 *  (TIM-0109), 481 in two hours after a team was deleted (TIM-0112). */
const SPAWN_RETRY_BASE_MS = 30_000;
const SPAWN_RETRY_MAX_MS = 10 * 60_000;
/** Failed spawns after which the batch is given up (messages expired, user told
 *  once). An account refusal does not fix itself in minutes: it gives up sooner. */
const MAX_SPAWN_FAILURES = 5;
const MAX_ACCOUNT_FAILURES = 3;
/** Hold ceiling for a NON-urgent return. Normally it rides along with the next
 *  urgent return (end of chain: merge, blockage, verdict to arbitrate); this
 *  ceiling exists only for the case where that urgent return never arrives —
 *  otherwise a deferred return would rot until MESSAGE_STALE_MS (2 h) and be
 *  deleted UNREAD. A held return stays `pending`: it is re-evaluated on every
 *  sweep (30 s) and merged into the next digest. */
const DEFERRED_HOLD_MS = 10 * 60_000;

/** System mission (finished, invisible to spinners) used as `from_mission`
 *  when a recap has no real source mission. FK NOT NULL requires one. */
const WAKE_SYSTEM_MISSION_ID = '00000000-0000-4000-8000-0000000000bb';
let wakeSystemReady = false;

const managerAgent = mainAgentNameOrSeed;

/** Sender of the recaps the wake-loop writes itself (`task_blocked`, end of
 *  group). */
const WAKE_SENDER = 'orchestrator-wake';

/** A recap the daemon wrote has no agent behind it: the chat shows it under
 *  the main orchestrator rather than a pseudo-sender nobody knows. */
function digestDisplayName(sender: string): string {
  if (sender !== WAKE_SENDER && sender !== 'orchestrator') return sender;
  return mainAgentName() ?? sender;
}

/** The orchestrator that launched this task = its mission's parent_agent, or
 *  the singleton manager as a fallback. */
function orchestratorForTask(task: TaskRow): string {
  if (task.mission_id) {
    const m = dbApi.getMission(task.mission_id);
    if (m?.parent_agent) return m.parent_agent;
  }
  return managerAgent();
}

function ensureWakeSystemMission(): string {
  if (!wakeSystemReady) {
    if (!dbApi.getMission(WAKE_SYSTEM_MISSION_ID)) {
      dbApi.createMission(WAKE_SYSTEM_MISSION_ID, managerAgent(), '[system] wake-loop recaps', {
        channel: 'system',
      });
      dbApi.finishMission(WAKE_SYSTEM_MISSION_ID, 'completed', 0);
    }
    wakeSystemReady = true;
  }
  return WAKE_SYSTEM_MISSION_ID;
}

/** Queue a recap in the orchestrator's inbox. `fromMission`, if valid, is used
 *  as the source (otherwise the system mission). */
function enqueueRecap(
  toAgent: string,
  fromMission: string | null,
  title: string,
  body: string,
  taskId: string | null,
  ownerUserId?: string | null,
): void {
  const src = fromMission && dbApi.getMission(fromMission) ? fromMission : ensureWakeSystemMission();
  dbApi.enqueueMessage({
    id: randomUUID(),
    fromMission: src,
    // The system mission has no owner to inherit: the work's own owner stands in.
    ownerUserId: ownerUserId ?? undefined,
    fromAgent: WAKE_SENDER,
    toAgent,
    kind: 'notification',
    payload: JSON.stringify({ kind: 'wake_recap', title, body, task_id: taskId }),
  });
}

/** True if at least one of this agent's missions has a process actually alive. */
function isAgentLive(agent: string): boolean {
  for (const m of dbApi.listMissions(50, [agent])) {
    if (isRunning(m.id)) return true;
  }
  return false;
}

type WakeState = {
  timer: NodeJS.Timeout | null;
  /** Timestamp of the last wake spawn — used as a bound so we only re-wake on
   *  messages that are genuinely new (anti-loop). */
  lastWakeAt: number;
  /** Consecutive flush re-arms caused by back-pressure (global cap / overload).
   *  Reset to 0 as soon as a wake actually goes out. Past
   *  MAX_BACKPRESSURE_RETRIES → escalate to the user (otherwise a mute loop of 30 s
   *  timers that never progresses and never tells anyone). */
  backpressureRetries: number;
  /** True once the back-pressure escalation has been sent, to avoid spam. */
  backpressureEscalated: boolean;
  /** Number of returns currently HELD (non-urgent, waiting to be merged into
   *  the next digest). Used only so we log the hold when it changes — otherwise
   *  the recurring sweep would write a line every 30 s. */
  heldCount: number;
  /** SYNCHRONOUS in-flight flag: set at the top of flushWake before any `await`,
   *  cleared in finally. `wakeMissions` is only populated AFTER `await spawnAgent`:
   *  without this flag, a 2nd flush (debounce timer or recurring sweep) that
   *  fires while the 1st is suspended on spawnAgent would pass the single-flight
   *  (wakeMissions still empty) → two wake missions for the same agent, same
   *  content. The flag closes that window. */
  flushing: boolean;
  /** Consecutive failed wake spawns for this agent; reset by a spawn that works
   *  or when nothing is left to deliver. */
  spawnFailures: number;
  /** No spawn attempt before this instant (exponential backoff). */
  retryAfter: number;
};
const wakeStates = new Map<string, WakeState>();
/** Missions spawned by the wake-loop: missionId → agentName.
 *  Used to (1) detect a wake already in flight for this agent (anti-duplicate
 *  guard), (2) recover the agent at mission_complete to clean the entry. */
const wakeMissions = new Map<string, string>();
/** Blocked-wake counter per group (key = group_id or `task:<id>`). */
const blockedWakes = new Map<string, { count: number; lastAt: number }>();
/** Deferred delivery attempts, PER TARGET MISSION (not per agent: with two
 *  target missions of which one is lastingly busy, a per-agent counter would
 *  be reset by the other one's deliveries and the fallback would never fire).
 *  Purged on delivery or fallback. */
const routeDeferrals = new Map<string, number>();

function stateFor(agent: string): WakeState {
  let st = wakeStates.get(agent);
  if (!st) {
    st = {
      timer: null,
      lastWakeAt: 0,
      backpressureRetries: 0,
      backpressureEscalated: false,
      heldCount: 0,
      flushing: false,
      spawnFailures: 0,
      retryAfter: 0,
    };
    wakeStates.set(agent, st);
  }
  return st;
}


function scheduleWake(agent: string): void {
  const st = stateFor(agent);
  if (st.timer) return; // a flush is already scheduled in the window
  st.timer = setTimeout(() => {
    st.timer = null;
    flushWake(agent).catch((err) =>
      console.error(`[wake] flush error for ${agent}: ${(err as Error).message}`),
    );
  }, DEBOUNCE_MS);
}

/** Sender whose messages are HUMAN ESCALATIONS (notifyUser): they show up in
 *  the Inbox UI and wait for the user to click "Pick". The wake-loop must NEVER
 *  deliver them to an agent or mark them picked — otherwise we would spawn an
 *  agent to "read" a message meant for the human, and we would clear the alert
 *  before they saw it. `orchestrator-wake` (task_blocked / group-complete recaps),
 *  on the other hand, IS meant for the agent → delivered normally. */
const HUMAN_ESCALATION_SENDER = 'orchestrator';

/** Does this message justify a turn for its recipient? A `request` (an answer
 *  is owed), a work return or wake recap, and a `response` correlated to a
 *  request (`in_reply_to`: a mission waits for it). A free `msg`, a
 *  `notification` and an uncorrelated `response` are informational: they stay
 *  in the inbox for the agent to read, and never spawn or resume a mission.
 *  Letting them wake their recipient is what made two agents ping each other
 *  into a loop (tester incident of 07/10/2026). */
/**
 * Whether resuming `session` carries on a conversation a person had with the
 * agent: the chat binds to the agent's latest mission, so the wake that
 * resumes it becomes where they keep talking, and must read as theirs
 * (`missions.user_engaged`) or "Only my conversations" hides it.
 */
export function resumesUserConversation(session: string | null): boolean {
  if (!session) return false;
  const resumed = dbApi.getMissionBySessionId(session);
  return !!resumed && dbApi.getMissionOrigin(resumed.id) === 'user';
}

export function callsForTurn(msg: AgentMessageRow): boolean {
  if (msg.kind === 'request') return true;
  if (msg.kind === 'response' && msg.in_reply_to) return true;
  return isWorkReturn(msg);
}

/** Messages actually deliverable to an agent: pending, not meant for a human,
 *  calling for a turn, not stale. This is the single source for every delivery
 *  path (live event, boot sweep, recurring sweep). */
function deliverablePending(agent: string): AgentMessageRow[] {
  const cutoff = Date.now() - MESSAGE_STALE_MS;
  return dbApi
    .listInbox(agent, { status: 'pending', limit: 200 })
    .filter(
      (m) =>
        m.from_agent !== HUMAN_ESCALATION_SENDER &&
        !m.id.startsWith('workflow-report:') &&
        callsForTurn(m) &&
        (m.created_at >= cutoff || ownerMissionOf(m, agent) !== null),
    );
}

/** Destination mission of a message, if it is routable: `to_mission` is set,
 *  exists, and actually belongs to the targeted agent (a message must never be
 *  injected into another agent's mission — save a work return, which belongs to
 *  its series pilot, see `pilotServes`). Returns null otherwise → the message
 *  takes the "spawn a wake mission" path. */
function isPinnedExchange(msg: AgentMessageRow): boolean {
  return Boolean(msg.to_mission && (msg.kind === 'request' || (msg.kind === 'response' && msg.in_reply_to)));
}

function ownerMissionOf(msg: AgentMessageRow, agent: string): string | null {
  if (msg.kind === 'request' && !msg.to_mission) {
    const previous = latestRequestMission(agent, msg.owner_user_id);
    if (previous && isRunning(previous)) return previous;
  }
  if (isPinnedExchange(msg)) {
    const target = dbApi.getMission(msg.to_mission!);
    return target && sameAgent(target.agent_name, agent) && target.owner_user_id === msg.owner_user_id
      ? target.id : null;
  }
  // The SERIES PILOT takes precedence over `to_mission`. `to_mission` is frozen at
  // the message's birth (via the task mission's `parent_mission_id`),
  // whereas the pilot is the CURRENT truth: it is what we replace when
  // the orchestrator switches backend or a wake mission takes the
  // helm. Routing on `to_mission` would resurrect a stale pilot and we would
  // end up with two orchestrators on the same project — exactly the
  // divergence that routing-by-mission is supposed to eliminate.
  const pilot = seriesPilotOf(msg, agent)?.pilotMissionId;
  if (pilot) return pilot;
  if (msg.to_mission) {
    const m = dbApi.getMission(msg.to_mission);
    if (m && sameAgent(m.agent_name, agent) && m.owner_user_id === msg.owner_user_id) return m.id;
  }
  return null;
}

/** Project (series) this message is returning from, and the mission currently
 *  piloting it if that mission may receive this message (see `pilotServes`).
 *  Null when the message does not come from a task, or from a task outside a
 *  series. */
function seriesPilotOf(
  msg: AgentMessageRow,
  agent: string,
): { seriesId: string; pilotMissionId: string | null } | null {
  const from = msg.from_mission ? dbApi.getMission(msg.from_mission) : null;
  const task = from?.task_id ? dbApi.getTask(from.task_id) : null;
  if (!task?.series_id) return null;
  const pilot = task.creator_mission_id ? dbApi.getMission(task.creator_mission_id) : null;
  return {
    seriesId: task.series_id,
    pilotMissionId: pilot && pilotServes(msg, agent, pilot) ? pilot.id : null,
  };
}

/**
 * May the series pilot receive `msg`, addressed to `agent`?
 *
 * Its own agent's messages, always. Case-insensitive comparison: the same agent
 * exists in the database under two spellings (`Nimbus.main` created by hand,
 * `nimbus.main` derived from the project slug). A strict equality then declared
 * the series "has no pilot of this agent" and the return went off to found a
 * fresh wake mission, which stole the helm from the chat in progress (incident
 * 2026-08-22).
 *
 * Another agent's messages, only when they are WORK RETURNS of the series. The
 * series is derived from the task of `from_mission`, so its pilot is by
 * construction the one legitimate reader of what that task produced; the
 * agent the return was addressed to is a guess frozen at dispatch, and it can
 * be wrong — a project-less agent (`TIMON.librarian`) used to resolve to
 * `_main` while the series was piloted by `timon.main`. Dropping the pilot on
 * that mismatch spawned a wake mission that adopted the series, and the next
 * return, addressed to the other agent, did the same in reverse: 14 wake
 * missions alternating between the two (2026-10-01).
 *
 * What stays out: a request or a free message an agent sends to another agent
 * from a task mission is meant for THAT agent, not for whoever pilots the
 * series — it is never redirected. Two orchestrators running side by side are
 * unaffected: each series names its own pilot. And the owner must match, as on
 * the `to_mission` path, so a return never crosses users.
 */
function pilotServes(msg: AgentMessageRow, agent: string, pilot: MissionRow): boolean {
  if (sameAgent(pilot.agent_name, agent)) return true;
  return isWorkReturn(msg) && pilot.owner_user_id === msg.owner_user_id;
}

/** A task or mission return (`task_closed`, `mission_complete`), or a recap
 *  the wake-loop wrote about a task (`task_blocked`, end of group). */
function isWorkReturn(msg: AgentMessageRow): boolean {
  if (returnPayloadOf(msg)) return true;
  if (msg.from_agent !== WAKE_SENDER) return false;
  try {
    const p: unknown = JSON.parse(msg.payload);
    return typeof p === 'object' && p !== null && (p as { kind?: unknown }).kind === 'wake_recap';
  } catch {
    return false;
  }
}

/** Do two agent names designate the same actor? Case-insensitive. */
function sameAgent(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

/**
 * Make `newMissionId` the pilot of every series these messages come from.
 *
 * Called AFTER spawning a wake mission: without this remap, the new mission
 * handles this wake then disappears, and the next return spawns yet another
 * one. Each orchestrator then rediscovers the project from scratch and makes
 * it diverge — that is no longer orchestration. After the remap, later returns
 * of the series all land in that same mission, which is resurrected in place
 * as needed (`respawnWithResume`).
 */
function adoptSeries(messages: AgentMessageRow[], agent: string, newMissionId: string): void {
  const seen = new Set<string>();
  for (const msg of messages) {
    // Only a work return hands over a series. A wake spawned to answer a
    // request an agent sent from one of its task missions is not piloting
    // anything: taking the helm there stole it from the real pilot, by
    // another door than the ping-pong of 2026-10-01.
    if (!isWorkReturn(msg)) continue;
    const s = seriesPilotOf(msg, agent);
    if (!s || seen.has(s.seriesId) || s.pilotMissionId === newMissionId) continue;
    seen.add(s.seriesId);
    // The outgoing pilot keeps the helm if it can still be resumed in place:
    // it is the one that has the project's plan in its head. Without this refusal, a single
    // mis-routed message was enough to transfer an entire series to a wake
    // mission born from nothing, and the chat that was piloting the project ended up
    // a spectator of its own work — with nothing to signal it.
    const keep = resumablePilot(s.pilotMissionId);
    if (keep) {
      console.log(
        `[wake] series ${s.seriesId.slice(0, 8)} : pilot ${keep.slice(0, 8)} kept ` +
        `(resumable) — mission ${newMissionId.slice(0, 8)} only handles this batch`,
      );
      continue;
    }
    const moved = dbApi.remapSeriesOrchestratorMission(s.seriesId, s.pilotMissionId, newMissionId);
    console.log(
      `[wake] series ${s.seriesId.slice(0, 8)} piloted by mission ` +
      `${newMissionId.slice(0, 8)} (${moved} task(s) repointed, ` +
      `outgoing pilot ${s.pilotMissionId?.slice(0, 8) ?? 'unknown'})`,
    );
  }
}

/** Id of the pilot if it can be resurrected in place (`respawnWithResume`), null
 *  otherwise. A missing session or a one-shot backend make resume
 *  impossible: then handing over the helm is the only way out. */
function resumablePilot(pilotMissionId: string | null): string | null {
  if (!pilotMissionId) return null;
  const m = dbApi.getMission(pilotMissionId);
  if (!m?.session_id) return null;
  try {
    // The mission's override wins: a pilot already switched onto a
    // one-shot backend is no longer resumable, whatever the agent's config says.
    const backend = m.backend_override ?? loadConfig(m.agent_name).backend ?? null;
    if (!isResumableBackendName(backend)) return null;
  } catch {
    return null;
  }
  return m.id;
}

/**
 * Deliver the messages into the mission that is waiting for them (`to_mission`).
 *
 * Returns the UNDELIVERED messages: those with no owner mission, and those
 * whose target could not be reached (no session to resume, spawn error).
 * The caller handles them on the historical path. Merely DEFERRED messages
 * (busy mission) are in neither list: they stay `pending` and the recurring
 * sweep presents them again.
 */
async function routeToOwnerMissions(
  agent: string,
  messages: AgentMessageRow[],
): Promise<AgentMessageRow[]> {
  // Backend whose session does not survive the process: NO routing by
  // mission. Resuming it would crash the turn ASYNCHRONOUSLY, after
  // sendToAgent/respawnWithResume returned true and the messages were marked
  // `picked` for a dead mission. The spawn path re-injects the digest into a
  // fresh prompt instead: nothing is lost. (Codex used to be such a backend,
  // until its CODEX_HOME outlived a kill — #607. A rollout lost all the same
  // is caught by `session.notFound`, which replays the SAME turn, digest
  // included, on a fresh thread.)
  //
  // The criterion is `sessionResumable`, not "one-shot": grok respawns on
  // every turn but keeps its session on disk, so its missions
  // wake IN PLACE like claude's — that is the whole point, the
  // task return comes back into the mission that launched the work.
  let resumable: boolean;
  try { resumable = isResumableBackend(agent); }
  catch { resumable = false; } // unreadable config → historical path

  const unrouted: AgentMessageRow[] = [];
  const byMission = new Map<string, AgentMessageRow[]>();
  for (const msg of messages) {
    const owner = ownerMissionOf(msg, agent);
    // A series pilot of ANOTHER agent (see `pilotServes`) runs on its own
    // backend: the recipient's says nothing about whether it can be resumed.
    // Judge that mission itself; when it cannot be resumed, the return falls
    // back to a wake mission, which then takes the helm (`adoptSeries`).
    const target = owner ? dbApi.getMission(owner) : null;
    const routable = isPinnedExchange(msg) ||
      (target && !sameAgent(target.agent_name, agent) ? resumablePilot(target.id) !== null : resumable);
    if (!routable) {
      unrouted.push(msg);
      continue;
    }
    if (!owner) {
      if (!isPinnedExchange(msg)) unrouted.push(msg);
      continue;
    }
    const bucket = byMission.get(owner);
    if (bucket) bucket.push(msg);
    else byMission.set(owner, [msg]);
  }

  for (const [missionId, batch] of byMission) {
    const msgs = requestDeliveryBatch(batch);
    const exactReply = msgs.some(isPinnedExchange);
    // Turn in progress: injecting now would clobber the turn accounting
    // (turnActive/turnSince), the very one the hung and turn budget reaps read. We
    // defer — unless it lasts too long, in which case we fall back to spawn.
    if (getTurnState(missionId)?.turnActive) {
      const tries = (routeDeferrals.get(missionId) ?? 0) + 1;
      routeDeferrals.set(missionId, tries);
      if (exactReply || tries <= MAX_ROUTE_DEFERRALS) {
        console.log(
          `[wake] ${agent}: mission ${missionId.slice(0, 8)} busy — delivery deferred ` +
          `(${tries}/${MAX_ROUTE_DEFERRALS}, ${msgs.length} msg)`,
        );
        continue;
      }
      console.warn(
        `[wake] ${agent}: mission ${missionId.slice(0, 8)} busy after ${tries} ` +
        `attempts; falling back to a new wake mission`,
      );
      routeDeferrals.delete(missionId);
      unrouted.push(...msgs);
      continue;
    }

    const instruction = [
      `Mission return — delivered INTO THIS mission because it is the one that`,
      `started the work. Process each return, then continue the rest of your plan`,
      `or close the project.`,
      ``,
    ].join('\n') + '\n';
    const digest = presentInboxDigest(msgs, { displayName: digestDisplayName });
    const composed = composePrompt([
      { kind: 'instruction', text: instruction },
      ...digest.presentation.parts,
    ], digest.presentation.segments);
    const prompt = composed.text;

    try {
      // Quota exhausted on this mission's backend: resuming it as-is
      // would make it die of the usage limit without having read the message.
      // Switch it FIRST — same id, transcript replayed — and the return
      // becomes the first-turn prompt on the new CLI.
      const origin = { ...originOfDigest(msgs), presentation: composed.presentation };
      let delivered = await deliverViaFallbackIfExhausted(
        missionId,
        prompt,
        dbApi.seriesIdForMission(missionId),
        origin,
      );
      // The chat names the real author of the return, not the human.
      if (!delivered) delivered = (await sendToAgent(missionId, prompt, undefined, origin)) === 'delivered';
      if (!delivered) {
        // Dead process (idle reap, crash, orchestrator restart): resume
        // the mission IN PLACE — same id, same session — to recover the
        // plan context. Age does not matter: that is the whole point.
        delivered = await respawnWithResume(missionId, prompt, undefined, origin);
      }
      if (!delivered) {
        console.warn(
          `[wake] ${agent}: mission ${missionId.slice(0, 8)} not resumable ` +
          (exactReply ? '(no session) — reply remains pending in its original mission' : '(no session) — falling back to a wake mission'),
        );
        if (!exactReply) unrouted.push(...msgs);
        continue;
      }
      for (const m of msgs) dbApi.pickMessage(m.id);
      routeDeferrals.delete(missionId);
      console.log(
        `[wake] ${agent}: ${msgs.length} msg(s) delivered into mission ${missionId.slice(0, 8)}`,
      );
    } catch (err) {
      console.error(
        `[wake] ${agent}: delivery to ${missionId.slice(0, 8)} : ` +
        `${(err as Error).message} — ${exactReply ? 'reply remains pending in its original mission' : 'falling back to a wake mission'}`,
      );
      if (!exactReply) unrouted.push(...msgs);
    }
  }
  return unrouted;
}

/**
 * Switch the mission onto the fallback backend if its own has no quota left,
 * delivering `prompt` as the first message. Returns false if there was nothing
 * to do (quota intact, no fallback available) or if the switch failed: the
 * caller then resumes its normal path.
 */
async function deliverViaFallbackIfExhausted(
  missionId: string,
  prompt: string,
  seriesId: string | null,
  inputOrigin?: UserEventOrigin,
): Promise<boolean> {
  const m = dbApi.getMission(missionId);
  if (!m) return false;
  const current = m.backend_override ?? loadConfig(m.agent_name).backend ?? null;
  const currentModel = m.model_override ?? loadConfig(m.agent_name).model ?? null;
  // `orchestrator` scope: THIS mission is the one that receives alerts for
  // the whole project; its fallback is chosen independently of the tasks'.
  const target = await redirectIfStillDry(current, {
    seriesId,
    scope: 'orchestrator',
    fromModel: currentModel,
    missionOwnerUserId: m.owner_user_id ?? null,
  });
  if (!target) return false;
  try {
    const switched = await switchMissionBackend(missionId, {
      backend: target.backend,
      model: target.model,
      message: prompt,
      inputOrigin,
      cause: 'fallback',
      causeDetail: `${current ?? 'default backend'} ${cooldownReason(current)}`,
    });
    if (!switched || switched.mode !== 'backend') return false;
    console.warn(
      `[wake] mission ${missionId.slice(0, 8)} switched to ${target.backend} ` +
      `(backend ${current ?? 'default'} exhausted) — context preserved`,
    );
    return true;
  } catch (err) {
    console.warn(
      `[wake] could not swap ${missionId.slice(0, 8)}: ${(err as Error).message}`,
    );
    return false;
  }
}

/**
 * A wake = one orchestrator turn. Split pending messages into those that
 * justify a turn RIGHT NOW and those that can ride along with the next one.
 *
 * Why (2026-08-21): a single `code` task produces up to FOUR returns
 * — code, its review, its merge, its doc — and each one woke the pilot. Three
 * of those four turns had no decision to make: the chain continues on its own
 * (verification-loop creates the review, then the merge; the doc leads
 * nowhere). Hence the burst the user described.
 *
 * Anything that is NOT a work return (blockage recap, request, correlated
 * response) stays urgent by construction: the wake-loop has no way to judge
 * its contents, and we never drop a signal by default. Informational messages
 * never get here (see `callsForTurn`).
 */
function splitByUrgency(messages: AgentMessageRow[]): {
  urgent: AgentMessageRow[];
  held: AgentMessageRow[];
} {
  const urgent: AgentMessageRow[] = [];
  const held: AgentMessageRow[] = [];
  for (const m of messages) {
    const ret = returnPayloadOf(m);
    if (!ret) { urgent.push(m); continue; }
    const followUp = ret.task_id ? dbApi.hasFollowUpTask(ret.task_id) : false;
    if (!isUrgentReturn(ret, followUp)) { held.push(m); continue; }
    // Task of a BATCH still in progress: the wake-loop will send a
    // consolidated recap anyway when the whole group is finished (evaluateGroupComplete).
    // Waking on top of that for every slice is N turns for a batch of N — the
    // burst of 10 returns on 2026-08-21. A blockage is not concerned: it
    // goes through the `task_blocked` recap, which is not a work return.
    if (ret.task_status === 'DONE' && ret.group_id && dbApi.groupHasActiveTasks(ret.group_id)) {
      held.push(m);
      continue;
    }
    urgent.push(m);
  }
  return { urgent, held };
}

async function flushWake(agent: string): Promise<void> {
  const st = stateFor(agent);
  // Synchronous in-flight guard: closes the race window before
  // `wakeMissions` is populated (see WakeState.flushing). Set BEFORE any await.
  if (st.flushing) return;
  st.flushing = true;
  try {
    await flushWakeInner(agent, st);
  } finally {
    st.flushing = false;
  }
}

async function flushWakeInner(agent: string, st: WakeState): Promise<void> {
  // Single-flight: a wake mission is already in flight for this agent (entry
  // present = spawned and not yet completed → its pick at completion will drain
  // the queue). We do NOT test `isRunning`: one-shot backends (codex) have
  // no live process between their turn and mission_complete, which would reopen
  // the double-spawn window. The entry is cleaned in handleMissionComplete,
  // and the reaper finalizes any orphan (→ mission_complete) within ~60 s.
  for (const ag of wakeMissions.values()) {
    if (ag === agent) return;
  }

  const queued = deliverablePending(agent);
  if (queued.length === 0) {
    st.spawnFailures = 0;
    st.retryAfter = 0;
    return;
  }

  // The recipient may be gone (team deleted while returns were in flight).
  // Spawning it can only fail, every sweep: give the messages up once.
  if (!agentExists(agent)) {
    const n = dbApi.expirePendingMessages(queued.map((m) => m.id));
    console.warn(`[wake] ${agent} no longer exists: ${n} undeliverable message(s) expired`);
    return;
  }
  if (Date.now() < st.retryAfter) return; // backing off after a failed spawn

  // Wait until this batch's follow-up chains have been EVALUATED before
  // judging their urgency. Without this rendezvous, `hasFollowUpTask`
  // answers on a Kanban where the review is not yet created and the return looks
  // terminal: the pilot wakes for a chain that was going to continue on its
  // own. The old version bet on DEBOUNCE_MS (1 s) > duration of the
  // chain, whereas the chain starts with a `git diff` that has a 5 s timeout.
  const chained = await awaitChainBarriers(
    queued.map((m) => returnPayloadOf(m)?.task_id).filter((id): id is string => !!id),
    CHAIN_WAIT_MAX_MS,
  );
  if (!chained) {
    console.warn(
      `[wake] ${agent}: follow-up chain(s) not evaluated after ${CHAIN_WAIT_MAX_MS / 1000}s — ` +
      `urgency decided from the current Kanban state`,
    );
  }
  // Re-read after the wait: in normal operation it lasts a few ms, but
  // nothing guarantees an agent has not consumed a message in the meantime
  // (`agent_pick_message`). We only deliver what is STILL pending.
  const pending = deliverablePending(agent);
  if (pending.length === 0) return;

  // Nothing urgent in the batch → do not spend an orchestrator turn on
  // this. Messages stay `pending` and will go out, grouped, with the first
  // return that actually calls for a decision. The hold ceiling guarantees
  // they will not rot if that urgent return never arrives.
  const { urgent, held } = splitByUrgency(pending);
  if (urgent.length === 0) {
    const oldest = Math.min(...held.map((m) => m.created_at));
    if (Date.now() - oldest < DEFERRED_HOLD_MS) {
      if (st.heldCount !== held.length) {
        st.heldCount = held.length;
        console.log(
          `[wake] ${agent}: ${held.length} return(s) require no decision — ` +
          `merged into the next digest (no wake)`,
        );
      }
      return;
    }
    console.log(
      `[wake] ${agent}: ${held.length} return(s) held for ` +
      `${Math.round((Date.now() - oldest) / 60_000)} min — forcing delivery`,
    );
  }
  st.heldCount = 0;

  // FIRST RULE: deliver into the mission that commissioned the work. What
  // comes back has no precise destination (or could not be delivered) and
  // takes the historical path: spawn a wake mission.
  const deliverable = requestDeliveryBatch(await routeToOwnerMissions(agent, pending));
  if (deliverable.length === 0) return;

  // Back-pressure (anti-freeze): at the global cap / under overload, defer and
  // retry in BACKPRESSURE_RETRY_MS (the recurring sweep retries too).
  const adm = canSpawnMission();
  if (!adm.ok) {
    st.backpressureRetries += 1;
    console.log(`[wake] wake ${agent} deferred (${st.backpressureRetries}×): ${adm.reason}`);
    if (st.backpressureRetries >= MAX_BACKPRESSURE_RETRIES && !st.backpressureEscalated) {
      st.backpressureEscalated = true;
      const minutes = Math.round((st.backpressureRetries * BACKPRESSURE_RETRY_MS) / 60_000);
      notifyUser(
        `Wake loop blocked by back-pressure: ${agent}`,
        [
          `Wake for agent \`${agent}\` has been deferred for ${st.backpressureRetries}`,
          `attempt(s) (~${minutes} min).`,
          `Reason: ${adm.reason}.`,
          ``,
          `${deliverable.length} message(s) are waiting in its inbox and cannot be processed.`,
          `Likely cause: global mission cap reached (paused/zombie mission?) or`,
          `high machine load. Check the state of live missions.`,
        ].join('\n'),
        {
          message: daemonMessage('wake_backpressure_stalled', {
            agent,
            attempts: st.backpressureRetries,
            minutes,
            reason: adm.reason ?? '',
            waiting: deliverable.length,
          }),
        },
      );
    }
    if (!st.timer) {
      st.timer = setTimeout(() => {
        st.timer = null;
        flushWake(agent).catch((err) =>
          console.error(`[wake] flush error for ${agent}: ${(err as Error).message}`),
        );
      }, BACKPRESSURE_RETRY_MS);
    }
    return;
  }
  // Admission OK → start again on a clean back-pressure counter.
  st.backpressureRetries = 0;
  st.backpressureEscalated = false;

  const spawnedAt = Date.now();
  const instruction = [
    `You have ${deliverable.length} message(s) waiting in your inbox. Their content`,
    `is reproduced below (already handled on the inbox side — no need to`,
    `pick them again). Process each request, then continue the rest of the plan or close the`,
    `project.`,
    ``,
  ].join('\n') + '\n';
  const digest = presentInboxDigest(deliverable, { displayName: digestDisplayName });
  const composed = composePrompt([
    { kind: 'instruction', text: instruction },
    ...digest.presentation.parts,
  ], digest.presentation.segments);
  const prompt = composed.text;
  const ownerUserId = deliveryOwner(deliverable);
  try {
    // Resume only if (a) the agent does not already have an active mission (otherwise
    // collision on the --resume transcript) AND (b) its backend knows how to resume
    // ANOTHER mission's session. A per-mission scratch (codex, grok) does not
    // know how: the wake mission is born with an empty HOME, --resume finds
    // nothing and the turn is lost (codex crashes in ~200 ms "no rollout
    // found" — that is what prevented ANY wake of TIMON.main). With the content
    // injected into the prompt, a fresh session loses nothing essential.
    const session =
      !deliverable.some((m) => m.kind === 'request') && !isAgentLive(agent) && canResumeForeignSession(agent)
        ? dbApi.getLatestSessionForAgent(agent, ownerUserId)
        : null;
    // Agent backend exhausted: the wake would be born dead. Spawn it on the
    // fallback — this is exactly the case that produced the cascade of dead
    // missions on 2026-08-20 (each return woke a `.main` with no quota).
    // The series these returns come from may carry an orchestrator-specific
    // fallback plan; failing that we fall back to the global setting.
    const wakeSeries = deliverable.map((m) => seriesPilotOf(m, agent)?.seriesId).find(Boolean) ?? null;
    const redirect = await redirectIfStillDry(loadConfig(agent).backend ?? null, {
      seriesId: wakeSeries,
      scope: 'orchestrator',
      fromModel: loadConfig(agent).model ?? null,
      ownerUserId,
    });
    if (redirect) {
      console.warn(`[wake] wake ${agent} redirected to ${redirect.backend} (backend exhausted)`);
    }
    // Read before the spawn, which may give the new row the same session id.
    const resumesUserSession = !redirect && resumesUserConversation(session);
    const missionId = await spawnAgent(
      agent,
      prompt,
      { channel: 'wake', meta: { parent_agent: agent } },
      {
        // A session belongs to its provider: we do not resume it on a
        // different CLI (resume would fail, silently empty conversation).
        explicitResume: redirect ? null : session,
        backendOverride: redirect?.backend ?? null,
        modelOverride: redirect?.model ?? null,
        // The chat names the real author of the digest, not the human.
        origin: { ...originOfDigest(deliverable), presentation: composed.presentation },
        ownerUserId,
      },
    );
    if (resumesUserSession) dbApi.markMissionUserEngaged(missionId);
    // Delivery = injection into the prompt. `spawnAgent` did NOT throw → the first
    // turn was dispatched → the content is in the agent's transcript (durable).
    // So we mark picked RIGHT NOW: that is the correct "delivered" signal.
    //
    // Why NOT wait for the mission to complete: a wake mission is
    // AUTONOMOUS (channel `wake`) → it does its turn, goes idle, and the reaper
    // kills it at 10 min → it ends as `failed`, NEVER `completed`. Picking only
    // on `completed` therefore never fired → messages stayed pending
    // → the recurring sweep re-delivered every 30 s = spam loop (observed bug).
    // Residual risk (mission dies BEFORE acting) is rare: the known cause
    // (stale codex resume) is neutralized by `canResumeForeignSession` above, and the
    // content of a recap remains re-derivable from durable state (Kanban tasks) at boot.
    for (const m of deliverable) dbApi.pickMessage(m.id);
    // THIS mission becomes the pilot of the projects these
    // returns come from: later ones will be delivered INTO it instead of spawning others.
    adoptSeries(deliverable, agent, missionId);
    wakeMissions.set(missionId, agent);
    st.lastWakeAt = spawnedAt;
    st.spawnFailures = 0;
    st.retryAfter = 0;
    console.log(`[wake] wake ${agent} (mission ${missionId.slice(0, 8)}, ${deliverable.length} msg delivereds)`);
  } catch (err) {
    recordSpawnFailure(agent, st, deliverable, err);
  }
}

function agentExists(agent: string): boolean {
  try {
    return existsSync(agentDir(canonicalAgentName(agent)));
  } catch {
    return false; // a name that cannot even be a directory is not an agent
  }
}

/** Account a wake mission acts as. A message carries its owner from insertion
 *  (`enqueueMessage`); one that predates that, or came from a system sender, is
 *  attributed from what produced it, so a user's Claude account is not refused
 *  to a mission "without an owner". A request keeps its own: its replies are
 *  matched on that exact owner. Null stays null — an instance account is a
 *  legitimate launcher, and accounts are never loosened to make a wake pass. */
function deliveryOwner(batch: AgentMessageRow[]): string | null {
  const first = batch[0]!;
  if (first.owner_user_id || first.kind === 'request') return first.owner_user_id ?? null;
  for (const m of batch) {
    const task = returnPayloadOf(m)?.task_id ? dbApi.getTask(returnPayloadOf(m)!.task_id!) : null;
    const owner = task?.owner_user_id
      ?? dbApi.missionOwnerId(m.from_mission)
      ?? (m.to_mission ? dbApi.missionOwnerId(m.to_mission) : null);
    if (owner) return owner;
  }
  return null;
}

/** A wake spawn threw. Back off, and past the ceiling give the batch up: the
 *  messages are expired and the user is told ONCE. The message used to stay
 *  pending and be re-delivered by every sweep, forever. */
function recordSpawnFailure(agent: string, st: WakeState, batch: AgentMessageRow[], err: unknown): void {
  const reason = (err as Error).message;
  st.spawnFailures += 1;
  const ceiling = err instanceof BackendAccountError ? MAX_ACCOUNT_FAILURES : MAX_SPAWN_FAILURES;
  console.error(`[wake] failed to spawn wake ${agent} (${st.spawnFailures}/${ceiling}): ${reason}`);
  if (st.spawnFailures < ceiling) {
    st.retryAfter = Date.now() + spawnRetryDelayMs(st.spawnFailures);
    return;
  }
  const n = dbApi.expirePendingMessages(batch.map((m) => m.id));
  st.spawnFailures = 0;
  st.retryAfter = 0;
  notifyUser(
    `Wake abandoned: ${agent}`,
    [
      `${agent} could not be woken ${ceiling} times in a row, so ${n} message(s) addressed to it`,
      `were set aside (status \`expired\`) instead of being retried.`,
      ``,
      `Last error: ${reason}`,
    ].join('\n'),
    { message: daemonMessage('wake_abandoned', { agent, ceiling, expired: n, error: reason }) },
  );
}

/** Test-only. */
export function spawnRetryDelayMs(failures: number): number {
  return Math.min(SPAWN_RETRY_BASE_MS * 2 ** Math.max(0, failures - 1), SPAWN_RETRY_MAX_MS);
}

/** Test-only: lets a test skip the wait of the backoff. */
export function expediteWakeRetry(agent: string): void {
  const st = wakeStates.get(agent);
  if (st) st.retryAfter = 0;
}

/** Count a blocked-wake for this group and return the current total. The
 *  counter resets to zero if the last blockage is older than
 *  GROUP_COUNTER_RESET_MS. */
export function bumpBlockedCounter(key: string): number {
  const now = Date.now();
  // A counter past the window restarts at 1 on its next bump anyway: dropping
  // it now is the same behaviour, minus one entry per task that ever blocked.
  if (blockedWakes.size >= BLOCKED_WAKES_SWEEP_AT) {
    for (const [k, v] of blockedWakes) if (now - v.lastAt > GROUP_COUNTER_RESET_MS) blockedWakes.delete(k);
  }
  const cur = blockedWakes.get(key);
  if (!cur || now - cur.lastAt > GROUP_COUNTER_RESET_MS) {
    blockedWakes.set(key, { count: 1, lastAt: now });
    return 1;
  }
  cur.count += 1;
  cur.lastAt = now;
  return cur.count;
}

/** Test-only. */
export function blockedWakeEntries(): number {
  return blockedWakes.size;
}

/** Said to the pilot BEFORE it tries a requeue the route would refuse
 *  (TIM-0065, crash-loop.ts): otherwise it learns the rule from a 409. */
function crashLoopNotice(task: TaskRow): string {
  if (!diedOfSystemCause(task)) return '';
  const deaths = task.requeue_count ?? 0;
  if (deaths >= CRASH_LOOP_HARD_CEILING) {
    return `Crash loop: ${deaths} system deaths. A requeue by an agent is refused; only a human can restart it — escalate, do not recreate it as a new task.`;
  }
  if (deaths >= MAX_SYSTEM_REQUEUES) {
    return `Crash loop: ${deaths} system deaths, automatic retries exhausted. Requeuing it unchanged is refused: `
      + `change its agent, backend or model in the same update, or escalate.`;
  }
  return '';
}

export function handleTaskBlocked(taskId: string, reason: string | null, opts: { byPerson?: boolean } = {}): void {
  const task = dbApi.getTask(taskId);
  if (!task || isMirrorTask(task)) return;
  // A person blocked it from the interface (a cancellation, "do not relaunch"):
  // handing it to the pilot would ask an agent to undo their decision.
  // `updateTaskStatus` already marked the return as given.
  if (opts.byPerson) {
    console.log(`[wake] task ${taskId} blocked by a person: the pilot is not woken`);
    return;
  }
  const agent = orchestratorForTask(task);
  const counterKey = task.group_id ?? `task:${taskId}`;
  const wakes = bumpBlockedCounter(counterKey);

  const reasonText = reason ?? task.blocked_reason ?? '(unspecified)';

  // Anti-loop: too many closely spaced blockages on this group → stop
  // waking the orchestrator (which re-queues in a loop) and escalate to the user.
  if (wakes > MAX_BLOCKED_WAKES_PER_GROUP) {
    notifyUser(
      `Blocking loop detected; intervention required: ${task.title}`,
      [
        `Task ${taskId} (group ${task.group_id ?? 'none'}) has been blocked ${wakes} times`,
        `in a row. The wake loop stopped waking the orchestrator to break the`,
        `loop. Reason for the last blockage: ${reasonText}.`,
        ``,
        `Unblock it manually after review (UI Kanban → task ${taskId}).`,
      ].join('\n'),
      {
        taskId,
        fromMission: task.mission_id,
        message: daemonMessage('blocking_loop_detected', {
          title: task.title,
          taskId,
          group: task.group_id ?? 'none',
          wakes,
          reason: reason ?? task.blocked_reason ?? 'none',
        }),
      },
    );
    // The user holds it now: a restart must not hand it back to the pilot.
    dbApi.markTaskReturnNotified(taskId);
    return;
  }

  const body = [
    `Task BLOCKED: \`${task.id}\` (type \`${task.type}\`, agent \`${task.agent_name}\`)`,
    `Title: ${task.title}`,
    `Reason: ${reasonText}`,
    task.branch_name ? `Branch: \`${task.branch_name}\` (base \`${task.base_branch ?? 'main'}\`)` : '',
    task.group_id ? `Group: \`${task.group_id}\`` : '',
    crashLoopNotice(task),
    sandboxCascadeNotice(task, reasonText),
    ``,
    `Decide what comes next: fix/re-queue, reassign, spawn a diagnostic coder,`,
    `abandon, or escalate through notifyUser.`,
  ].filter(Boolean).join('\n');

  enqueueRecap(agent, task.mission_id, `Task blocked: ${task.title}`, body, taskId, task.owner_user_id);
  // The pilot has been served: the `mission_complete` that this mission's death
  // will produce (sometimes 10 min later) would have nothing more to tell it.
  dbApi.markTaskReturnNotified(taskId);
  scheduleWake(agent);
}

/**
 * Boot pass over the BLOCKED tasks: hands the pilot only those it has not
 * been told about. Every BLOCKED task used to be re-sent at each start, so a
 * task cancelled by its maintainer came back to the pilot after every restart
 * (three "Task blocked" for the same decision, 2026-11-06). Skipped: a task
 * whose return is already given (`return_notified` — its recap went out, a
 * person blocked it, a scope stop silenced it, the user holds an escalated
 * loop), unless the recap it got expired unread. A recap still pending is
 * delivered by the inbox sweep, never doubled. Returns how many it presented.
 */
export function representBlockedTasks(): number {
  const blocked = dbApi.listTasks('BLOCKED').filter((t) => !isMirrorTask(t));
  const told = blocked.filter((t) => t.return_notified === 1);
  const recaps = dbApi.latestTaskRecapStatus(WAKE_SENDER, told.map((t) => t.id));
  let presented = 0;
  for (const t of blocked) {
    if (t.return_notified === 1 && recaps.get(t.id) !== 'expired') continue;
    handleTaskBlocked(t.id, t.blocked_reason);
    presented++;
  }
  return presented;
}

/** How recent a system death must be for the boot sweep to replay its task. */
export const BOOT_REQUEUE_MAX_AGE_MS = 24 * 60 * 60_000;

/** When the task was blocked by its death: the end of the mission that died,
 *  which the block leaves attached. `updated_at` moves with any later edit
 *  (title, priority, worktree), so it is only the fallback. */
function systemDeathAt(task: TaskRow): number {
  const m = task.mission_id ? dbApi.getMission(task.mission_id) : null;
  return m?.ended_at ?? task.updated_at;
}

/** Expires the "Task blocked" recaps still unread for tasks that are no
 *  longer blocked: the pilot would otherwise be woken on a stale state and
 *  might recreate or reassign a task that is already queued again. */
function expireBlockedRecaps(taskIds: ReadonlySet<string>): number {
  if (taskIds.size === 0) return 0;
  const stale = dbApi.listAllInbox({ status: 'pending', limit: 500 }).filter((m) => {
    if (m.from_agent !== WAKE_SENDER) return false;
    try {
      const p = JSON.parse(m.payload) as { kind?: unknown; task_id?: unknown; title?: unknown };
      return p.kind === 'wake_recap' && typeof p.task_id === 'string' && taskIds.has(p.task_id)
        && typeof p.title === 'string' && p.title.startsWith('Task blocked:');
    } catch {
      return false;
    }
  });
  return dbApi.expirePendingMessages(stale.map((m) => m.id));
}

/**
 * Boot pass that sends back to PENDING the tasks a recent system death left
 * BLOCKED once their automatic retries ran out (TIM-0149). A restart often
 * removes the very cause (a reboot that killed the missions, an overloaded
 * backend), and those tasks otherwise waited for a human to notice them.
 *
 * Bounded so a restart never turns into a spending spree:
 *   - only a replayable cause that counts toward the crash loop: a quota, an
 *     auth failure or a stop is not cured by a restart, and a death that is
 *     not counted would let a task be replayed at every boot;
 *   - only a task blocked less than `BOOT_REQUEUE_MAX_AGE_MS` ago: an update
 *     must not replay weeks-old work (stale reviews cost credits);
 *   - only under `CRASH_LOOP_HARD_CEILING` deaths. The count is never reset
 *     here and each new death still adds one, so a task gets at most a couple
 *     of boot replays before only a human can restart it (TIM-0065).
 *
 * Runs before `representBlockedTasks`, so a replayed task is not also handed
 * to its pilot as blocked. Returns how many tasks it requeued.
 */
export function requeueRecentSystemDeaths(now: number = Date.now()): number {
  const requeued = new Set<string>();
  for (const t of dbApi.listTasks('BLOCKED')) {
    if (isMirrorTask(t) || !diedOfSystemCause(t)) continue;
    const reason = toInterruptionReason(t.interrupted_reason);
    if (!reason || !isRequeueableInterruption(reason)) continue;
    if (now - systemDeathAt(t) >= BOOT_REQUEUE_MAX_AGE_MS) continue;
    const deaths = t.requeue_count ?? 0;
    if (deaths >= CRASH_LOOP_HARD_CEILING) continue;
    dbApi.updateTaskStatus(t.id, 'PENDING');
    // The death is consumed by this replay. Kept, it would outlive a block a
    // person sets before the dispatch, and the next boot would replay the
    // task against their decision. Nothing reads it afterwards: the age check
    // ran above, and the next death writes its own cause and mission.
    dbApi.clearTaskInterruption(t.id);
    // Same backoff as an agent's requeue: an overloaded backend may still be.
    dbApi.deferTask(t.id, now + requeueBackoffMs(Math.max(1, deaths)));
    console.log(`[wake] boot: task ${t.id} requeued after a system death (${reason}, ${deaths}/${CRASH_LOOP_HARD_CEILING} deaths)`);
    requeued.add(t.id);
  }
  const expired = expireBlockedRecaps(requeued);
  if (expired) console.log(`[wake] boot: ${expired} stale "Task blocked" recap(s) expired`);
  return requeued.size;
}

/**
 * TO DO ideas this closure settles, for the pilot: without it the orchestrator
 * goes on ticking them by hand. Read from the PLAN — the chain applies it a
 * tick after this synchronous handler. A failure only drops the mention: it
 * must never cost the return itself.
 */
function todoReturnFields(task: TaskRow): Pick<ReturnPayload, 'todo_closed' | 'todo_progress' | 'todo_os_test'> {
  try {
    const plan = planTodoClosure(task);
    const closed = plan.filter((c) => c.progress === 'done').map((c) => c.todoId);
    // `partial`: sibling chains of the idea are still open (TODO #462).
    // `integrating`: merged into an integration branch only, the idea waits
    // for that branch to land.
    const progress = plan.filter((c) => c.progress !== 'done').map((c) => ({
      id: c.todoId, progress: c.progress,
      ...(c.total ? { landed: c.landed ?? 0, total: c.total } : {}),
      ...(c.integrating ? { integrating: c.integrating } : {}),
    }));
    const osTest = plan.filter((c) => c.osTest).map((c) => c.todoId);
    return {
      ...(closed.length ? { todo_closed: closed } : {}),
      ...(progress.length ? { todo_progress: progress } : {}),
      ...(osTest.length ? { todo_os_test: osTest } : {}),
    };
  } catch (err) {
    console.error(`[wake] TO DO plan failed for ${task.id}: ${(err as Error).message}`);
    return {};
  }
}

/**
 * Send the work return up to the pilot AT TASK CLOSURE.
 *
 * Defect fixed (2026-08-21): the return was enqueued by `notifyParentOnComplete`
 * at PROCESS DEATH, which sometimes happens well after the agent has closed its
 * task. Coder/merger missions: almost immediate. Reviewer missions: they stay
 * `running` until the idle reap — review `b172e022` closed at 09:15 was
 * reported at 09:25, `693469fa` closed at 09:18 at 09:29. The orchestrator
 * therefore learned a `verdict: pass` ten minutes after the chain had already
 * continued without it.
 *
 * The `mission_complete` bus event is NOT touched: `verification-loop.ts` and
 * `doc-task.ts` listen to it to create follow-up tasks. Only the TRIGGER of
 * the message enqueue changes. The duplicate is closed by `return_notified`,
 * read by `notifyParentOnComplete`.
 *
 * Exported so a test can drive it without starting the wake loop (whose boot
 * sweeps and debounced flush would try to spawn real agents).
 */
export function handleTaskDone(taskId: string): void {
  const task = dbApi.getTask(taskId);
  if (!task || task.status !== 'DONE' || isMirrorTask(task)) return;
  if (dbApi.isTaskReturnNotified(taskId)) return;
  const mission = task.mission_id ? dbApi.getMission(task.mission_id) : null;
  // The return no longer depends on `parent_agent` being set. A task closed
  // outside dispatch (typed closure by an agent that was not spawned by the
  // dispatcher, manual close, replay) used to return NOTHING: the pilot saw the
  // Kanban move and never learnt what the work produced. We fall back to the
  // orchestrator resolved for the task, exactly like the `task_blocked` recap
  // right above — so DONE and BLOCKED now report symmetrically.
  const recipient = orchestratorForTask(task);
  // No self-wake: an orchestrator that closes its own task would wake itself in
  // a loop. `mission.agent_name` when the task ran in a mission, the assignee
  // otherwise.
  if (recipient === (mission?.agent_name ?? task.agent_name)) return;

  dbApi.enqueueMessage({
    id: randomUUID(),
    // Same provenance as the historical return: that is what lets
    // routing-by-mission recover the series and its current pilot. Without a
    // mission, the system mission carries it (an unknown source id would be
    // rejected and the return lost).
    fromMission: mission?.id ?? ensureWakeSystemMission(),
    fromAgent: mission?.agent_name ?? task.agent_name,
    toAgent: recipient,
    toMission: mission?.parent_mission_id ?? task.creator_mission_id ?? null,
    // With no mission the system mission is the sender and carries no owner: the
    // task's own owner keeps the return attributable (TIM-0112).
    ownerUserId: task.owner_user_id ?? undefined,
    kind: 'notification',
    payload: JSON.stringify({
      kind: 'task_closed',
      mission_id: mission?.id ?? null,
      agent: mission?.agent_name ?? task.agent_name,
      task_id: task.id,
      task_title: task.title,
      task_status: task.status,
      task_type: task.type,
      pipeline: task.pipeline,
      merged_commit_sha: task.merged_commit_sha,
      done_comment: task.done_comment,
      summary: task.done_summary,
      blocked_reason: task.blocked_reason,
      // Its code, for the screen to read the reason in the reader's language.
      blocked_reason_code: decodeDaemonMessage(task.blocked_reason_code),
      group_id: task.group_id,
      ...todoReturnFields(task),
    }),
  });
  dbApi.markTaskReturnNotified(taskId);
  // `enqueueMessage` already publishes `agent_message` → scheduleWake. We do not
  // add another: the urgent/held split will decide whether this return deserves a turn.
}

/**
 * Reports the return of a mission WITHOUT a task AT THE END OF ITS TURN.
 *
 * Exact counterpart of `handleTaskDone` for the missions that do not run a
 * task (`mission_spawn` delegation, `timon spawn`). They had no
 * equivalent: their only return left from `notifyParentOnComplete`, hooked to
 * the DEATH OF THE PROCESS. With a persistent backend (claude) that process does not die
 * at the end of a turn, it waits for the idle reap — `TIMON_REAP_IDLE_MS`,
 * 600,000 ms. Measured on 11/09/2026: turn finished at 12:34 → return at 12:48; turn
 * finished at 13:08 → return at 13:20. The pilot received its return ten minutes
 * later, in the middle of another conversation.
 *
 * The reaper keeps its role of freeing a slot; we only take away from it the
 * job of announcing a return. The BUS `mission_complete` event is not
 * touched: only the trigger of the MESSAGE enqueueing changes.
 *
 * Exported so that a test can call it without starting the wake loop.
 */
export function handleMissionTurnComplete(missionId: string): void {
  const m = dbApi.getMission(missionId);
  if (!m) return;
  // Chat mission: a human reads the screen, nobody waits for a return in
  // their inbox. `isAutonomousMission` answers true for every task mission, hence
  // the next filter.
  if (!isAutonomousMission(m)) return;
  // Mission carrying a task: the return already left at the task's CLOSING
  // (`handleTaskDone` / `handleTaskBlocked`). Doubling it here would produce the
  // second message this work removes.
  if (m.task_id) return;
  enqueueMissionReturn(missionId, 'completed');
  // `enqueueMessage` already publishes `agent_message` → the wake is scheduled by
  // the bus handler, as for a task return.
}

/** Max times a task mission is asked whether it is finished. Past it the
 *  reaper takes over: asking forever would loop on an agent that answers in
 *  prose every time. */
const MAX_CLOSURE_QUESTIONS = 2;
/** Per mission: questions attempted, and those the agent actually received. */
const closureQuestions = new Map<string, { asked: number; delivered: number }>();

export const CLOSURE_QUESTION =
  'Your turn ended but your Kanban task is still open. Is the mission finished?\n' +
  '- If yes, close the task now with `kanban_mark_as_done` (comment mandatory).\n' +
  '- If not, finish your work, then close the task.';

/**
 * A task mission ended its turn without closing its task: ask the agent, who
 * is the one that knows, instead of deciding for it (TIM-0092). Without this,
 * a coder that committed and narrated "done" was reaped and its task requeued,
 * spawning a duplicate mission on an already-committed branch.
 *
 * Once every question was received and the agent still ends a clean turn with
 * its task open, the mission is marked `closure_ignored` (TIM-0149): the idle
 * reap that follows then closes the task instead of replaying it as a system
 * death (dispatcher `watchMissionComplete`). The mark is dropped as soon as a
 * turn starts again (`handleTurnStarted`), so only a mission killed idle right
 * after that clean turn qualifies.
 *
 * Exported with an injectable `send` so a test needs no live process.
 */
export async function askUnclosedTaskMission(
  missionId: string,
  send: (id: string, text: string) => Promise<string> = (id, text) =>
    sendToAgent(id, text, undefined, { kind: 'system', from: 'orchestrator', mission_id: id }),
): Promise<boolean> {
  const m = dbApi.getMission(missionId);
  if (!m?.task_id || m.status !== 'running' || m.interrupted_reason) return false;
  const task = dbApi.getTask(m.task_id);
  // Only a task this very mission still holds: a requeued task now belongs to
  // another mission, and a DONE/BLOCKED one already carries its verdict.
  if (!task || task.status !== 'IN_PROGRESS' || task.mission_id !== missionId) return false;
  const count = closureQuestions.get(missionId) ?? { asked: 0, delivered: 0 };
  if (count.asked >= MAX_CLOSURE_QUESTIONS) {
    // A question lost on the way is not one the agent ignored.
    if (count.delivered >= MAX_CLOSURE_QUESTIONS) dbApi.setMissionClosureIgnored(missionId, true);
    return false;
  }
  closureQuestions.set(missionId, { ...count, asked: count.asked + 1 });
  try {
    const delivered = (await send(missionId, CLOSURE_QUESTION)) === 'delivered';
    if (delivered) {
      const now = closureQuestions.get(missionId);
      if (now) now.delivered += 1;
    }
    return delivered;
  } catch (err) {
    console.error(`[wake] closure question failed ${missionId}: ${(err as Error).message}`);
    return false;
  }
}

/** A turn started: the mission is working again, whatever it ignored before. */
export function handleTurnStarted(missionId: string): void {
  if (dbApi.getMission(missionId)?.closure_ignored) dbApi.setMissionClosureIgnored(missionId, false);
}

/** Delay before evaluating group completion on the `mission_complete` path.
 *  This path is now only a safety net (the normal path is
 *  `evaluateGroupCompleteForTask`, called by task-chain once the chain has
 *  run), but it can still beat a follow-up task creation if chaining ever
 *  goes asynchronous again on this event: without a delay, the
 *  `groupHasActiveTasks` check would wrongly see the group as "finished" and
 *  `markGroupNotified` (permanent) would suppress the real completion. */
const GROUP_COMPLETE_DEFER_MS = 6_000;

function handleGroupMaybeComplete(missionId: string): void {
  const m = dbApi.getMission(missionId);
  if (!m?.task_id) return;
  const task = dbApi.getTask(m.task_id);
  // No group_id → legacy DONE wake not triggered (behaviour unchanged).
  if (!task?.group_id) return;
  setTimeout(() => {
    try { evaluateGroupCompleteForTask(task.id); }
    catch (err) { console.error(`[wake] group-complete error: ${(err as Error).message}`); }
  }, GROUP_COMPLETE_DEFER_MS);
}

/**
 * Evaluate the end of the batch a task belongs to, and send the consolidated
 * recap up to the pilot if the batch is finished.
 *
 * Called by `task-chain.ts` at CLOSURE of the group's last task, once the
 * follow-up chain has run (so on a Kanban where the follow-up review/merge
 * already exists — that is what makes the `groupHasActiveTasks` check reliable
 * without waiting). Before this move, this recap depended on the last
 * mission's `mission_complete`: up to 10 min after the batch's real end
 * (`TIMON_REAP_IDLE_MS`). The `mission_complete` path remains as a safety net;
 * `isGroupNotified` makes it harmless (no-op once the recap has gone out).
 */
export function evaluateGroupCompleteForTask(taskId: string): void {
  const task = dbApi.getTask(taskId);
  if (!task?.group_id) return;
  const gid = task.group_id;
  // Scoped to the group: we wait until THIS group is fully finished.
  if (dbApi.groupHasActiveTasks(gid)) return;
  // Idempotent: a single end-of-group wake (the DB flag survives a restart,
  // and the synchronous check below + markGroupNotified avoids a double-notify
  // on near-simultaneous completions in the same tick).
  if (dbApi.isGroupNotified(gid)) return;
  dbApi.markGroupNotified(gid);

  const tasks = dbApi.listTasksByGroup(gid);
  const done = tasks.filter((t) => t.status === 'DONE');
  const blocked = tasks.filter((t) => t.status === 'BLOCKED');
  const agent = orchestratorForTask(task);

  const lines: string[] = [
    `Group \`${gid}\` complete: ${done.length} done / ${blocked.length} blocked of ${tasks.length} tasks.`,
    ``,
  ];
  for (const t of tasks) {
    const tag = t.status === 'DONE' ? '✓' : t.status === 'BLOCKED' ? '✗' : '·';
    // Machine-readable tag in front of the reason: the orchestrator reading this recap must
    // be able to tell "the agent blocked for a business reason" from "the
    // mission was killed" without interpreting a French sentence.
    const interrupted = t.interrupted_reason ? `[interrupted:${t.interrupted_reason}] ` : '';
    const note = t.status === 'BLOCKED'
      ? ` — ${interrupted}${t.blocked_reason ?? '(reason unspecified)'}`
      : t.done_comment ? ` — ${t.done_comment}` : '';
    lines.push(`${tag} [${t.type}] ${t.title}${note}`);
  }
  lines.push('');
  lines.push(
    blocked.length
      ? `Tasks are BLOCKED: decide what to do (re-queue, diagnose, escalate).`
      : `Everything is done: continue the plan or close the project.`,
  );

  enqueueRecap(agent, task.mission_id, `Group complete: ${done.length}/${tasks.length} done`, lines.join('\n'), null,
    tasks.find((t) => t.owner_user_id)?.owner_user_id);
  scheduleWake(agent);
}

/** The tasks whose chain merges into `row`'s branch, newest first. */
function tasksOfIntegration(row: IntegrationRow): TaskRow[] {
  return dbApi.listTasksByBaseBranch(row.branch)
    .filter((t) => usesIntegrationBranch(t.integration_mode) && integrationOfTask(t)?.id === row.id)
    .reverse();
}

/**
 * The agent that hears of a job's outcome: its series' pilot, else the
 * orchestrator that launched its task, else the manager agent.
 *
 * Null when that pilot is gone: its mission was deleted, or its agent was. A
 * recap to a missing agent would only be expired by the wake loop after a
 * spawn that cannot work, so the notification card is the whole notice.
 */
function integrationPilot(tasks: readonly TaskRow[], anchor: TaskRow | undefined): string | null {
  const seriesId = tasks.find((t) => t.series_id)?.series_id;
  const pilotId = seriesId ? dbApi.seriesPilotMission(seriesId) : null;
  if (pilotId) {
    const pilot = dbApi.getMission(pilotId);
    return pilot && agentExists(pilot.agent_name) ? pilot.agent_name : null;
  }
  const parent = anchor?.mission_id ? dbApi.getMission(anchor.mission_id)?.parent_agent : null;
  if (parent) return agentExists(parent) ? parent : null;
  return managerAgent();
}

/**
 * Tells the pilot of a job that its pull request was merged or closed
 * (`docs/KANBAN-PR-PIPELINE.md` §2.6): once per outcome, whoever learnt it
 * (the landing poller, a `mark-merged` by hand, the replay of a notice a stop
 * cut short) and across restarts (`integrations.notified_state`, claimed
 * before the message, handed back if it cannot be queued).
 *
 * Two channels: a recap in the pilot's inbox, which leaves from the mission of
 * a task of the job so routing by series delivers it to the series' current
 * pilot like a task return, and a card in the notification centre (a report
 * for a merge, an alert for a pull request closed without one). A pilot that
 * no longer exists gets no recap: the card alone tells the person.
 *
 * `lines` adds what the caller knows (the landing replay). Returns false when
 * there was nothing to tell. `wake` is injectable so a test can drive it
 * without the wake loop.
 */
export function notifyIntegrationOutcome(
  integrationId: string,
  outcome: 'merged' | 'closed',
  lines: readonly string[] = [],
  wake: (agent: string) => void = scheduleWake,
): boolean {
  const row = dbApi.getIntegrationById(integrationId);
  if (!row || row.state !== outcome) return false;
  if (!dbApi.claimIntegrationNotice(row.id, outcome)) return false;
  let anchor: TaskRow | undefined;
  let owner: string | null | undefined;
  const pr = row.pr_url ?? (row.pr_number ? `#${row.pr_number}` : null);
  // A branch under embargo lands by hand, without a pull request.
  const what = pr ? 'Pull request' : 'Integration branch';
  const title = outcome === 'merged' ? `${what} merged: ${row.branch}` : `${what} closed: ${row.branch}`;
  try {
    const tasks = tasksOfIntegration(row);
    anchor = tasks.find((t) => t.mission_id && t.series_id) ?? tasks.find((t) => t.mission_id) ?? tasks[0];
    owner = tasks.find((t) => t.owner_user_id)?.owner_user_id;
    const agent = integrationPilot(tasks, anchor);
    const body = outcome === 'merged'
      ? [
          pr ? `Pull request merged: ${pr}`
            : row.remote ? `Integration branch landed by hand: ${row.branch}` : `Branch merged on this machine: ${row.branch}`,
          `Branch \`${row.branch}\` landed in \`${integrationTargetLabel(row)}\`${row.merge_sha ? ` (merge commit \`${row.merge_sha}\`)` : ''}.`,
          ...lines,
          ``,
          `The job's TO DO ideas and doc tasks follow on their own. Nothing to decide unless the plan goes on.`,
        ]
      : [
          `Pull request closed without a merge: ${pr ?? row.branch}`,
          `Branch \`${row.branch}\` did not land in \`${integrationTargetLabel(row)}\`: no TO DO idea closes, no doc task is created, the branches are kept.`,
          ...lines,
          ``,
          `Decide what comes next: reopen it on the forge, plan a new pull request, or abandon the job.`,
        ];
    if (agent) {
      enqueueRecap(agent, anchor?.mission_id ?? null, title, body.join('\n'), anchor?.id ?? null, owner);
      wake(agent);
    } else {
      console.log(`[wake] pilot of ${row.branch} no longer exists: the ${outcome} notice goes to the notification centre only`);
    }
  } catch (err) {
    dbApi.releaseIntegrationNotice(row.id, outcome);
    throw err;
  }
  // After the claim holds: a card that fails must not hand the notice back,
  // or the recap would leave twice.
  try {
    const target = integrationTargetLabel(row);
    createNotification({
      type: outcome === 'merged' ? 'report' : 'alert',
      urgent: false,
      title,
      body: outcome === 'merged'
        ? `${row.branch} landed in ${target}. Its TO DO ideas and doc tasks follow on their own.`
        : `${row.branch} did not land in ${target}: nothing closes and the branches are kept. Its pilot decides what comes next.`,
      message: outcome === 'merged'
        ? daemonMessage('integration_merged', { branch: row.branch, pr: pr ?? 'none', target })
        : daemonMessage('integration_closed', { branch: row.branch, pr: pr ?? 'none', target }),
      taskId: anchor?.id ?? null,
      missionId: anchor?.mission_id ?? null,
      anchor: `integration:${row.id}:${outcome}`,
      ownerUserId: owner ?? null,
    });
  } catch (err) {
    console.error(`[wake] ${outcome} card of ${row.branch} not created: ${(err as Error).message}`);
  }
  return true;
}

function handleMissionComplete(missionId: string, status: 'completed' | 'failed' | 'terminated'): void {
  wakeMissions.delete(missionId); // clean the wake entry if this was a wake
  closureQuestions.delete(missionId);
  const m = dbApi.getMission(missionId);
  // Systematic re-check: any agent whose mission ends may have
  // messages that appeared during the run. flushWake returns early if the inbox is empty.
  if (m) scheduleWake(m.agent_name);
  // End of group → consolidated recap. On `completed` AND `terminated`: a
  // task mission idle-reaped (terminated) after the agent closed its task may be the
  // last of the group → completion still has to be evaluated. `failed` does not
  // trigger it (handleGroupMaybeComplete is idempotent anyway and returns
  // early if the group still has active tasks).
  if (status === 'completed' || status === 'terminated') handleGroupMaybeComplete(missionId);
}

/** Sweep ALL inboxes and schedule a wake (in parallel, one mission per
 *  agent) for every recipient with ≥1 deliverable message. Single delivery
 *  path shared by the boot sweep AND the recurring sweep. Filters
 *  `orchestrator` (human escalations) but NOT `orchestrator-wake` (agentic
 *  recaps) — that is exactly what was missing: a recap whose explicit
 *  scheduleWake had failed was never retried. */
function sweepInboxes(label: string): void {
  try {
    const pending = dbApi.listAllInbox({ status: 'pending', limit: 500 });
    const recipients = new Set(
      pending
        .filter((m) => m.from_agent !== HUMAN_ESCALATION_SENDER && callsForTurn(m))
        .map((m) => m.to_agent),
    );
    for (const a of recipients) scheduleWake(a);
    if (recipients.size) console.log(`[wake] ${label}: ${recipients.size} inbox(es) to drain`);
  } catch (err) {
    console.error(`[wake] ${label} error: ${(err as Error).message}`);
  }
}

/**
 * Any agent receiving a message that calls for a turn (`callsForTurn`) is woken
 * (not only *.main), unless the agent-pair breaker holds it
 * (agent-pair-breaker.ts). A `msg`, `notification` or uncorrelated `response`
 * only lands in the inbox, and does not count against the pair. Messages from
 * `orchestrator` (system alerts → human channel) and `orchestrator-wake`
 * (recaps already handled via explicit scheduleWake) wake nobody, to avoid
 * re-triggering the wake-loop on its own emissions.
 *
 * Exported with an injectable `wake` so a test can drive it without the wake
 * loop's real spawns.
 */
export function handleAgentMessage(
  ev: Extract<BusEvent, { kind: 'agent_message' }>,
  wake: (agent: string) => void = scheduleWake,
): void {
  if (ev.fromAgent === HUMAN_ESCALATION_SENDER || ev.fromAgent === WAKE_SENDER) return;
  const msg = dbApi.getMessage(ev.messageId);
  if (!msg || !callsForTurn(msg)) return;
  if (admitAgentMessage(msg) === 'held') return;
  wake(ev.toAgent);
}

/** A human spoke to this mission's agent: its agent pairs start from zero. */
export function handleUserInput(missionId: string, payload: unknown): void {
  if (!isHumanInput(payload)) return;
  const agent = dbApi.getMission(missionId)?.agent_name;
  if (agent) resetAgentPairs(agent);
}

export function startWake(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind === 'turn_complete') {
      // A turn a steer stopped is not an answer: the steered turn that follows
      // carries the return, the request reply and the wake (TODO #568).
      if (ev.outcome === 'cancelled') return;
      try {
        completeRequestReplies(ev.missionId, ev.outcome);
        // A turn that ends on a failure (quota exit) is not a
        // return: the process died without producing anything, and it is the
        // mission's finalisation that will tell the pilot what happened.
        if (ev.outcome !== 'failed') handleMissionTurnComplete(ev.missionId);
        if (ev.outcome !== 'failed') void askUnclosedTaskMission(ev.missionId);
        const agent = wakeMissions.get(ev.missionId) ?? dbApi.getMission(ev.missionId)?.agent_name;
        wakeMissions.delete(ev.missionId);
        if (agent) scheduleWake(agent);
      } catch (err) {
        console.error(`[wake] request reply failed ${ev.missionId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'turn_started') {
      try {
        handleTurnStarted(ev.missionId);
      } catch (err) {
        console.error(`[wake] turn_started handler error ${ev.missionId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'task_blocked') {
      try {
        handleTaskBlocked(ev.taskId, ev.reason, { byPerson: ev.byPerson === true });
      } catch (err) {
        console.error(`[wake] task_blocked handler error ${ev.taskId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'task_done') {
      try {
        handleTaskDone(ev.taskId);
      } catch (err) {
        console.error(`[wake] task_done handler error ${ev.taskId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'mission_complete') {
      try {
        completeRequestReplies(ev.missionId, ev.status);
        handleMissionComplete(ev.missionId, ev.status);
      } catch (err) {
        console.error(`[wake] mission_complete handler error ${ev.missionId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'agent_message') {
      try {
        handleAgentMessage(ev);
      } catch (err) {
        console.error(`[wake] agent_message handler error ${ev.messageId}: ${(err as Error).message}`);
      }
    } else if (ev.kind === 'event' && ev.type === 'user') {
      try {
        handleUserInput(ev.missionId, ev.payload);
      } catch (err) {
        console.error(`[wake] human input handler error ${ev.missionId}: ${(err as Error).message}`);
      }
    }
  };
  bus.on('event', onBusEvent);
  try { reconcileRequestReplies(); }
  catch (err) { console.error(`[wake] request reconciliation failed: ${(err as Error).message}`); }

  // Boot sweep: inboxes accumulated during downtime do not re-emit
  // bus events → nothing would wake the recipients without this pass.
  // Every agent with deliverable messages is woken (no longer only *.main),
  // each in its own mission → wakes in parallel (the global cap throttles them).
  try {
    const expired = dbApi.expireStalePending(MESSAGE_STALE_MS);
    if (expired) console.log(`[wake] boot: ${expired} message(s) expired stale message(s)`);
  } catch (err) {
    console.error(`[wake] boot expire error: ${(err as Error).message}`);
  }
  sweepInboxes('boot sweep');

  // Boot sweep of BLOCKED tasks: this is DURABLE state (tasks table), not
  // an ephemeral message. A task blocked while the orchestrator was
  // dead (or whose recap expired) must be re-presented on resume —
  // otherwise it stays BLOCKED forever (the bug the user hit). The
  // task_blocked recap comes from `orchestrator-wake` → excluded from the inbox sweep above,
  // hence this dedicated pass. handleTaskBlocked honours the anti-loop.
  try {
    const requeued = requeueRecentSystemDeaths();
    if (requeued) console.log(`[wake] boot: ${requeued} task(s) BLOCKED by a system death requeued`);
  } catch (err) {
    console.error(`[wake] boot requeue-sweep error: ${(err as Error).message}`);
  }
  try {
    const presented = representBlockedTasks();
    if (presented) console.log(`[wake] boot: ${presented} task(s) BLOCKED re-presented`);
  } catch (err) {
    console.error(`[wake] boot blocked-sweep error: ${(err as Error).message}`);
  }

  // Reaper: continuously expire stale pending messages (live hygiene).
  const reaper = setInterval(() => {
    try {
      const n = dbApi.expireStalePending(MESSAGE_STALE_MS);
      if (n) console.log(`[wake] reaper: ${n} message(s) expired stale message(s)`);
    } catch (err) {
      console.error(`[wake] reaper error: ${(err as Error).message}`);
    }
  }, STALE_REAP_MS);

  // Recurring delivery sweep (safety net for the <1 min SLA). Re-wakes
  // IN PARALLEL every agent that still has a deliverable message waiting — covers
  // missed live events (back-pressure, race, short downtime) that nothing
  // retried before. Wakes already in flight are deduplicated by
  // flushWake's single-flight; messages already delivered are picked so
  // invisible here. The BLOCKED-task sweep stays at boot (durable state
  // re-derived), no need to replay it on every tick.
  const sweeper = setInterval(() => {
    try { reconcileRequestReplies(); }
    catch (err) { console.error(`[wake] request reconciliation failed: ${(err as Error).message}`); }
    sweepInboxes('recurring sweep');
  }, SWEEP_INTERVAL_MS());

  console.log(`[wake] loop started (recurring sweep every ${Math.round(SWEEP_INTERVAL_MS() / 1000)}s)`);
  return () => {
    bus.off('event', onBusEvent);
    clearInterval(reaper);
    clearInterval(sweeper);
    for (const state of wakeStates.values()) if (state.timer) clearTimeout(state.timer);
    wakeStates.clear();
    wakeMissions.clear();
    routeDeferrals.clear();
    clearAgentPairs();
  };
}
