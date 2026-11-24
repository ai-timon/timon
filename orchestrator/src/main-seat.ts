/**
 * Keeps the cross-project orchestrator seat filled, or says that it is not.
 *
 * `mainAgentName()` is a pure read, run on every recap: it found the seat by
 * the recorded name, a seed literal, or — when only one project-less
 * orchestrator exists — by role. Nothing ever wrote that last answer down, and
 * nothing said when there was no answer at all. A tester rebuilt their
 * database with the agent folders restored and no `_main`: four days with
 * `main: false` on every agent, recaps addressed to a name nothing reads, and
 * not one word about it (TIM-0142).
 *
 * So, at boot and whenever an agent that could hold the seat changes:
 * - a holder found by role is recorded, so a second orchestrator created later
 *   does not empty the seat behind the user's back;
 * - an empty seat with exactly one candidate is given to it;
 * - otherwise the seat stays empty — choosing among several is the user's
 *   call — and a card says so, once per empty spell rather than at every boot.
 *
 * Nothing is written while the first-run wizard is pending: it seeds and names
 * the orchestrator itself, and a recorded key reads to it as "name step
 * answered" (`mainAgentNamed` in `onboarding-main-agent.ts`).
 */
import { daemonMessage } from './daemon-message.js';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { chooseMainAgent, mainSeatCandidates, mainSeatHolder } from './main-agent.js';
import { createNotification, resolveAnchor } from './notifications.js';
import { mainAgentOnboardingPending } from './onboarding-main-agent.js';

/** Set while the card announcing the current empty spell has been raised. */
export const MAIN_SEAT_NOTICE_KEY = 'orchestrator.main.emptyNotified';

/** Anchor of that card, so filling the seat takes it back. */
export const MAIN_SEAT_ANCHOR = 'main-seat:empty';

export type MainSeatOutcome =
  | { kind: 'deferred' }
  | { kind: 'held'; name: string }
  | { kind: 'elected'; name: string }
  | { kind: 'empty'; candidates: string[]; notified: boolean };

/** How the outcome reaches the notification centre; injectable for the tests. */
export type MainSeatNotices = {
  /** Raises the card; `false` when no centre took it (module off). */
  raise(candidates: readonly string[]): boolean;
  resolve(): void;
};

export function mainSeatNotice(candidates: readonly string[]): { title: string; body: string } {
  const what = 'No agent holds the main orchestrator seat: recaps and notifications have no recipient.';
  const how = candidates.length > 0
    ? `Eligible orchestrators: ${candidates.join(', ')}. In **Agents**, open the one you talk to and choose **Set as main orchestrator**, or run \`timon agent set-main <name>\`.`
    : 'No project-less orchestrator exists. Create one in **Agents**: when it is the only one, it takes the seat by itself.';
  return { title: 'No main orchestrator', body: `${what} ${how}` };
}

const centreNotices: MainSeatNotices = {
  raise(candidates) {
    const { title, body } = mainSeatNotice(candidates);
    return createNotification({
      type: 'action_required', urgent: false, title, body, anchor: MAIN_SEAT_ANCHOR,
      message: daemonMessage('main_seat_empty', { candidates: candidates.length > 0 ? candidates.join(', ') : 'none' }),
    }) !== null;
  },
  resolve() {
    resolveAnchor(MAIN_SEAT_ANCHOR);
  },
};

function seatFilled(name: string, notices: MainSeatNotices): void {
  if (!dbApi.getAllSettings()[MAIN_SEAT_NOTICE_KEY]) return;
  dbApi.deleteSetting(MAIN_SEAT_NOTICE_KEY);
  notices.resolve();
  console.log(`[main-seat] ${name} holds the seat again: the empty-seat card is closed`);
}

/** One pass of the rules above. Synchronous, so two events never race on the key. */
export function reconcileMainSeat(notices: MainSeatNotices = centreNotices): MainSeatOutcome {
  if (mainAgentOnboardingPending()) return { kind: 'deferred' };
  const holder = mainSeatHolder();
  if (holder) {
    if (holder.source === 'role') {
      const recorded = chooseMainAgent(holder.name);
      if (recorded.ok) console.log(`[main-seat] ${recorded.name} is the only project-less orchestrator: recorded as the main one`);
    }
    seatFilled(holder.name, notices);
    return { kind: 'held', name: holder.name };
  }
  const candidates = mainSeatCandidates();
  if (candidates.length === 1) {
    const elected = chooseMainAgent(candidates[0]!);
    if (elected.ok) {
      console.log(`[main-seat] the seat was empty: ${elected.name}, the only eligible orchestrator, now holds it`);
      seatFilled(elected.name, notices);
      return { kind: 'elected', name: elected.name };
    }
  }
  console.warn(`[main-seat] no main orchestrator; eligible: ${candidates.length > 0 ? candidates.join(', ') : 'none'}`);
  if (dbApi.getAllSettings()[MAIN_SEAT_NOTICE_KEY]) return { kind: 'empty', candidates, notified: false };
  const notified = notices.raise(candidates);
  if (notified) dbApi.setSetting(MAIN_SEAT_NOTICE_KEY, String(Date.now()));
  return { kind: 'empty', candidates, notified };
}

/** The agent events that can change who may hold the seat. */
const SEAT_FIELDS = new Set(['name', 'role', 'project', 'cwd', 'ephemeral']);

export function seatMayHaveChanged(event: { kind: string; changed?: readonly string[]; previousName?: string | null }): boolean {
  if (event.kind === 'agent_created' || event.kind === 'agent_deleted') return true;
  if (event.kind !== 'agent_updated') return false;
  return Boolean(event.previousName) || (event.changed ?? []).some((field) => SEAT_FIELDS.has(field));
}

/**
 * Runs the rules again after each agent event that can change the seat;
 * returns the unsubscribe. Deferred to a microtask: a rename publishes its
 * event before `renameAgentKeepingSeat` moves the recorded seat, and reading
 * in between would announce an empty seat that is not. Coalesced, as one
 * write can publish several events.
 */
export function watchMainSeat(notices: MainSeatNotices = centreNotices): () => void {
  let queued = false;
  let active = true;
  const onEvent = (event: BusEvent) => {
    if (queued || !seatMayHaveChanged(event)) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!active) return;
      try {
        reconcileMainSeat(notices);
      } catch (err) {
        console.warn(`[main-seat] check failed: ${(err as Error).message}`);
      }
    });
  };
  bus.on('event', onEvent);
  return () => { active = false; bus.off('event', onEvent); };
}
