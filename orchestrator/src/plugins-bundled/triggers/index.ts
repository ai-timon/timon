/**
 * Module `triggers` — native triggers (TODO #216): a source (schedule,
 * webhook, internal event), a declarative filter, actions (TO DO idea, task
 * for an agent, notification) and a call journal. Tier `std`.
 *
 * Independent of Workflows on purpose: Workflows may be switched off, and it
 * is meant to plug into these triggers, never the reverse. Injects `kanban`
 * because two of its actions write to the board.
 *
 * Routines are stored as schedule triggers, but `@timon/routines` keeps its
 * own clock and does not depend on this module: a Free licence names the
 * modules it runs, and one minted before this module existed must not switch
 * the routines off with it.
 */
import { daemonMessage } from '../../daemon-message.js';
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { bus, type BusEvent } from '../../bus.js';
import { createNotification } from '../../notifications.js';
import { emitAutomationEvent } from '../../plugins/automation-events.js';
import { registerActionProvider } from '../../triggers/actions.js';
import { armSchedules, fireTrigger, stopCoalescing, tickSchedules } from '../../triggers/engine.js';
import { createEventDispatcher } from '../../triggers/events.js';
import { startWebhookOutbox } from '../../triggers/outbound.js';
import { stopScripts } from '../../triggers/script-run.js';
import {
  disableUnapprovedAgentTriggers, getTrigger, getTriggerRow, sealLegacyTriggerSecrets, type UnapprovedTrigger,
} from '../../triggers/store.js';
import { registerTriggerWebhook } from '../../triggers/webhook.js';
import { registerRoutes } from './routes.js';

export type TriggersService = {
  get: typeof getTrigger;
  fire: typeof fireTrigger;
  /** Workflows plugs its `workflow` action in here — never the reverse. */
  registerAction: typeof registerActionProvider;
};

declare module '@deepseek-ai/cordis' {
  interface Context {
    triggers: TriggersService;
  }
}

export const manifest: ModuleManifest = {
  name: '@timon/triggers',
  tier: 'std',
  inject: ['http', 'db', 'kanban'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** Same cadence as the historical routines tick. */
const SCHEDULE_TICK_MS = 30_000;
const BUS_KINDS = new Set<BusEvent['kind']>(['task_done', 'task_blocked', 'mission_complete', 'agent_message', 'notifications_changed', 'todo_done', 'todo_resolved']);

function startScheduleSource(): () => void {
  armSchedules();
  const tick = () => {
    try { tickSchedules(); } catch (err) { console.error('[triggers] schedule tick error:', err); }
  };
  tick();
  const timer = setInterval(tick, SCHEDULE_TICK_MS);
  console.log(`[triggers] schedule source started (interval=${SCHEDULE_TICK_MS}ms)`);
  return () => clearInterval(timer);
}

/**
 * The bus listener of the event source. Deferred: a bus event is often
 * published from inside another module's write (a task closing); the trigger
 * runs once that write is done, not in the middle of it.
 */
export function deferredEventListener(dispatch: (ev: BusEvent) => void): (ev: BusEvent) => void {
  return (ev) => {
    if (BUS_KINDS.has(ev.kind)) setImmediate(() => dispatch(ev));
  };
}

function startEventSource(): () => void {
  const onEvent = deferredEventListener(createEventDispatcher());
  bus.on('event', onEvent);
  return () => { bus.off('event', onEvent); };
}

/**
 * Secrets written before they were sealed (TODO #529). A vault that cannot
 * open is reported and the boot goes on: those rows still verify, in the
 * clear, until the next boot that can seal them.
 */
function sealLegacySecrets(): void {
  try {
    const sealed = sealLegacyTriggerSecrets();
    if (sealed > 0) console.log(`[triggers] ${sealed} secret(s) stored in the clear are now sealed`);
  } catch (err) {
    console.warn(`[triggers] could not seal the secrets stored in the clear: ${(err as Error).message}`);
  }
}

/**
 * An agent's trigger made before #529 runs without anyone having switched it
 * on, and outlives the mission and token that made it (TODO #572). Switched
 * off before any source is armed; each owner is told which ones, so an
 * automation they rely on is one click away, never cut in silence.
 */
export function switchOffUnapprovedAgentTriggers(): UnapprovedTrigger[] {
  let off: UnapprovedTrigger[];
  try {
    off = disableUnapprovedAgentTriggers();
  } catch (err) {
    console.warn(`[triggers] could not switch off the agents' unapproved triggers: ${(err as Error).message}`);
    return [];
  }
  if (off.length === 0) return off;
  console.warn(`[triggers] ${off.length} agent trigger(s) nobody switched on are now off: ${off.map((t) => t.id).join(', ')}`);
  const byOwner = new Map<string | null, UnapprovedTrigger[]>();
  for (const trigger of off) byOwner.set(trigger.owner_user_id, [...byOwner.get(trigger.owner_user_id) ?? [], trigger]);
  for (const [owner, triggers] of byOwner) {
    const lines = triggers.map((t) => `- ${t.name} (${t.source}${t.creator_agent ? `, set up by ${t.creator_agent}` : ''})`);
    createNotification({
      type: 'alert',
      title: triggers.length === 1 ? 'An agent\'s trigger was switched off' : `${triggers.length} agents' triggers were switched off`,
      body: 'An agent set these up and nobody had switched them on. A trigger an agent makes now waits for you: '
        + `review each one on the Triggers page and switch it back on if you want it.\n${lines.join('\n')}`,
      ownerUserId: owner,
      message: daemonMessage('agent_triggers_switched_off', { count: triggers.length, list: lines.join('\n') }),
    });
  }
  for (const trigger of off) {
    const row = getTriggerRow(trigger.id);
    if (row) emitAutomationEvent({ kind: 'trigger_updated', row, origin: { kind: 'system', id: null } });
  }
  return off;
}

export function apply(ctx: Context): void {
  sealLegacySecrets();
  switchOffUnapprovedAgentTriggers();
  // The public hook first: `/api/triggers/hooks/<slug>` must not be read as
  // `/api/triggers/:id/…` by the management routes.
  registerTriggerWebhook(ctx.http.router());
  registerRoutes(ctx.http.router());

  ctx.provide('triggers', { get: getTrigger, fire: fireTrigger, registerAction: registerActionProvider });

  ctx.effect(() => startScheduleSource());
  ctx.effect(() => startEventSource());
  ctx.effect(() => startWebhookOutbox());
  ctx.effect(() => () => stopCoalescing());
  ctx.effect(() => () => stopScripts());
}
