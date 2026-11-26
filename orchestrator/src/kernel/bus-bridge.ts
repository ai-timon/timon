/**
 * Bridge between TIMON's historical bus and the Cordis events.
 *
 * The `bus` EventEmitter stays the source: all the existing code publishes and
 * listens on it, and rewriting it would bring nothing. The bridge re-emits each
 * `BusEvent` on the context under the name `timon/<kind>`, which gives
 * modules automatic unsubscription (`ctx.on` is an effect) without forcing
 * a migration: both worlds coexist for as long as needed.
 *
 * One-way, on purpose. A Cordis → bus bridge would loop every
 * event onto itself at the first republication.
 *
 * Each listener is isolated (TODO #630). Cordis' `ctx.emit` calls them in a
 * row with no `try`: one module's `throw` skipped the listeners after it, then
 * left `ctx.emit`, the bus `emit` and finally the `bus.publish` of a core write
 * that has nothing to do with that module. The plugin facade already guards
 * `ctx.events.on` this way (#614); the bridge does the same for the raw
 * `ctx.on('timon/…')` of bundled modules.
 */
import type { Context } from '@deepseek-ai/cordis';
import { bus, type BusEvent } from '../bus.js';
import { guardCallback, type RejectionOwner } from './rejection-guard.js';

/** Cordis event name matching a `BusEvent`. */
export type TimonEventName = `timon/${BusEvent['kind']}`;

declare module '@deepseek-ai/cordis' {
  interface Events {
    'timon/plugin_realtime'(ev: Extract<BusEvent, { kind: 'plugin_realtime' }>): void;
    'timon/ui_navigate'(ev: Extract<BusEvent, { kind: 'ui_navigate' }>): void;
    'timon/event'(ev: Extract<BusEvent, { kind: 'event' }>): void;
    'timon/event_delta'(ev: Extract<BusEvent, { kind: 'event_delta' }>): void;
    'timon/mission_complete'(ev: Extract<BusEvent, { kind: 'mission_complete' }>): void;
    'timon/turn_complete'(ev: Extract<BusEvent, { kind: 'turn_complete' }>): void;
    'timon/turn_started'(ev: Extract<BusEvent, { kind: 'turn_started' }>): void;
    'timon/onboarding_step'(ev: Extract<BusEvent, { kind: 'onboarding_step' }>): void;
    'timon/usage_kind_set'(ev: Extract<BusEvent, { kind: 'usage_kind_set' }>): void;
    'timon/account_limit_reached'(ev: Extract<BusEvent, { kind: 'account_limit_reached' }>): void;
    'timon/compact_progress'(ev: Extract<BusEvent, { kind: 'compact_progress' }>): void;
    'timon/mission_started'(ev: Extract<BusEvent, { kind: 'mission_started' }>): void;
    'timon/mission_child_started'(ev: Extract<BusEvent, { kind: 'mission_child_started' }>): void;
    'timon/mission_title_changed'(ev: Extract<BusEvent, { kind: 'mission_title_changed' }>): void;
    'timon/mission_archived'(ev: Extract<BusEvent, { kind: 'mission_archived' }>): void;
    'timon/mission_unarchived'(ev: Extract<BusEvent, { kind: 'mission_unarchived' }>): void;
    'timon/mission_archive_suggested'(ev: Extract<BusEvent, { kind: 'mission_archive_suggested' }>): void;
    'timon/task_blocked'(ev: Extract<BusEvent, { kind: 'task_blocked' }>): void;
    'timon/task_done'(ev: Extract<BusEvent, { kind: 'task_done' }>): void;
    'timon/task_started'(ev: Extract<BusEvent, { kind: 'task_started' }>): void;
    'timon/task_unblocked'(ev: Extract<BusEvent, { kind: 'task_unblocked' }>): void;
    'timon/integration_changed'(ev: Extract<BusEvent, { kind: 'integration_changed' }>): void;
    'timon/task_created'(ev: Extract<BusEvent, { kind: 'task_created' }>): void;
    'timon/task_updated'(ev: Extract<BusEvent, { kind: 'task_updated' }>): void;
    'timon/task_assigned'(ev: Extract<BusEvent, { kind: 'task_assigned' }>): void;
    'timon/task_deleted'(ev: Extract<BusEvent, { kind: 'task_deleted' }>): void;
    'timon/todo_done'(ev: Extract<BusEvent, { kind: 'todo_done' }>): void;
    'timon/todo_resolved'(ev: Extract<BusEvent, { kind: 'todo_resolved' }>): void;
    'timon/todo_deleted'(ev: Extract<BusEvent, { kind: 'todo_deleted' }>): void;
    'timon/project_created'(ev: Extract<BusEvent, { kind: 'project_created' }>): void;
    'timon/project_updated'(ev: Extract<BusEvent, { kind: 'project_updated' }>): void;
    'timon/agent_created'(ev: Extract<BusEvent, { kind: 'agent_created' }>): void;
    'timon/agent_updated'(ev: Extract<BusEvent, { kind: 'agent_updated' }>): void;
    'timon/agent_deleted'(ev: Extract<BusEvent, { kind: 'agent_deleted' }>): void;
    'timon/agent_message'(ev: Extract<BusEvent, { kind: 'agent_message' }>): void;
    'timon/workflow_run'(ev: Extract<BusEvent, { kind: 'workflow_run' }>): void;
    'timon/workflow_proposal'(ev: Extract<BusEvent, { kind: 'workflow_proposal' }>): void;
    'timon/notifications_changed'(ev: Extract<BusEvent, { kind: 'notifications_changed' }>): void;
    'timon/plugins_changed'(ev: Extract<BusEvent, { kind: 'plugins_changed' }>): void;
    'timon/browser_recording'(ev: Extract<BusEvent, { kind: 'browser_recording' }>): void;
    'timon/browser_annotation'(ev: Extract<BusEvent, { kind: 'browser_annotation' }>): void;
    'timon/backends_changed'(ev: Extract<BusEvent, { kind: 'backends_changed' }>): void;
    'timon/backend_fallback'(ev: Extract<BusEvent, { kind: 'backend_fallback' }>): void;
    'timon/license_changed'(ev: Extract<BusEvent, { kind: 'license_changed' }>): void;
    'timon/update_available'(ev: Extract<BusEvent, { kind: 'update_available' }>): void;
  }
}

export const name = 'timon-bus-bridge';

/** The fiber that registered the listener: a bundled module's is named by its manifest. */
function listenerOwner(owner: Context): RejectionOwner {
  const name = owner.fiber.name;
  return name === 'root' ? { kind: 'core' } : { kind: 'module', id: name };
}

/**
 * `ctx.emit`, minus the propagation. Same listeners, same order, same `this`
 * (`null`, no filter: the bridge passes no `thisArg`), and the same
 * `internal/dispatch` notice first. The list is copied before the loop, as
 * Cordis does, so a listener that unsubscribes does not shift the next one.
 */
function emitIsolated(ctx: Context, name: TimonEventName, ev: BusEvent): void {
  const hooks = [...(ctx.events._hooks[name] ?? [])];
  guardCallback({ kind: 'core' }, `event ${name} dispatch notice`, () => ctx.emit('internal/dispatch', 'emit', name, [ev], null))();
  for (const hook of hooks) {
    guardCallback(listenerOwner(hook.ctx), `event ${name}`, (payload: BusEvent) => hook.callback.call(null, payload))(ev);
  }
}

export function apply(ctx: Context): void {
  ctx.effect(() => {
    const forward = (ev: BusEvent) => {
      emitIsolated(ctx, `timon/${ev.kind}` as TimonEventName, ev);
    };
    bus.on('event', forward);
    return () => void bus.off('event', forward);
  });
}
