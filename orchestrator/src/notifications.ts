/**
 * The notification centre — the channel through which an agent alerts the human.
 *
 * The module that carries it has been `std` since the end of the core tier: it can be
 * disabled. This file stays in `src/` because its callers (permissions,
 * child supervisor, boot, third-party plugins) are part of the kernel: they
 * call `createNotification` without knowing whether the centre runs.
 *
 * Hence the activity test below: without the module, `createNotification` is
 * a LOGGED no-op that returns `null`. Never an exception — a lost
 * notification must not make the task that triggered it fail.
 */
import { randomUUID } from 'node:crypto';
import { dbApi, type NotificationDismissOn, type NotificationType, type NotificationRow } from './db.js';
import { bus, type BusEvent } from './bus.js';
import { moduleActive } from './kernel/module-state.js';
import { isMirrorTask } from './task-mirror.js';
import { sandboxCascadeNotice } from './sandbox-cascade.js';
import { daemonMessage, decodeDaemonMessage, withDaemonMessageBody, type DaemonMessage } from './daemon-message.js';

/**
 * Outcome of a Web Push fan-out, returned to the caller so that it can REASON
 * on it.
 *
 * The real use: the auto-refusal timeout of a permission (permissions.ts) is
 * adaptive — a long answer window is only granted if we KNOW a
 * human was told. `delivered > 0` is that proof; everything else
 * (module missing, zero subscriptions, failures) leaves the assumption "nobody will
 * click" intact and so the delay short.
 *
 * The type lives here and not in `web-push` because its readers are kernel code:
 * they reason on the outcome without depending on the module that produces it.
 */
export type PushFanoutResult = {
  /** VAPID configured: otherwise nothing was even attempted. */
  configured: boolean;
  /** Subscriptions targeted by this fan-out. */
  targeted: number;
  /** Sends accepted by the browser's push service. */
  delivered: number;
  /** Transient failures (the subscription stays in the database). */
  failed: number;
  /** Subscriptions purged along the way (404/410). */
  gone: number;
  /** Already served for this notification (idempotency of the tuple). */
  skipped: number;
};

/**
 * What the `web-push` module plugs behind the notification centre.
 *
 * The centre does NOT know push: it knows this contract. Without a registered
 * module, everything goes into the void and the outcome is that of a fan-out that
 * never happened — which is exactly the truth.
 */
export type PushSink = {
  notify(n: NotificationRow, opts: { permissionId: string | null }): Promise<PushFanoutResult>;
  /** Closes on the devices the system notification matching this row. */
  closeFor(n: Pick<NotificationRow, 'id' | 'anchor'>): Promise<void>;
  /** Same, when only the anchor is known (the row is already dismissed). */
  closeForAnchor(anchor: string): Promise<void>;
};

const NO_PUSH: PushFanoutResult = {
  configured: false, targeted: 0, delivered: 0, failed: 0, gone: 0, skipped: 0,
};

let sink: PushSink | null = null;

/** Armed by the `web-push` module when mounted, disarmed when unloaded. */
export function registerPushSink(next: PushSink): () => void {
  sink = next;
  return () => { if (sink === next) sink = null; };
}

/** Closes the system notification of a row — no-op without a push module.
 *  Best-effort: the caller has just dismissed, the echo to the device must not
 *  make its request fail. */
export function closePushFor(n: Pick<NotificationRow, 'id' | 'anchor'>): void {
  void sink?.closeFor(n).catch(() => { /* best-effort */ });
}

export function closePushForAnchor(anchor: string): void {
  void sink?.closeForAnchor(anchor).catch(() => { /* best-effort */ });
}

/** One place holds the id, so renaming the module is one line, not a grep. */
export const NOTIFICATIONS_MODULE_ID = '@timon/notifications';

/**
 * Is the centre running? Same mechanism as the secrets vault
 * (`kernel/module-state.ts`, set by `setLiveDecisions`, hence followed hot):
 * `createNotification` is called from paths that have no `ctx`, and
 * "no kernel has spoken" (CLI, tests) means on.
 */
export function notificationsEnabled(): boolean {
  return moduleActive(NOTIFICATIONS_MODULE_ID);
}

export function createNotification(opts: {
  type: NotificationType;
  urgent?: boolean;
  title: string;
  body?: string | null;
  taskId?: string | null;
  missionId?: string | null;
  anchor?: string | null;
  /** Provenance: `plugin:<id>` when the notification comes from a third-party plugin
   *  (§10.4). Absent = the daemon itself. */
  source?: string | null;
  ownerUserId?: string | null;
  /** What closes the card by itself (an agent's `action_required`, SUG-0048). */
  dismissOn?: readonly NotificationDismissOn[] | null;
  /** Epoch ms after which the expiry sweep dismisses the card. */
  expiresAt?: number | null;
  /** The code of `title` and `body` when the daemon wrote them, for the webview to translate (TODO #845). */
  message?: DaemonMessage | null;
  /** See `PushSink.notify`: enables the Approve / Refuse buttons on the device. */
  pushPermissionId?: string | null;
  /**
   * Outcome of the Web Push fan-out, returned once the fan-out is over. The push stays
   * fire-and-forget (it must never make the creation fail), but its
   * OUTCOME matters to the caller: the permissions use it to grant
   * a long answer window only if a human was really reached.
   */
  onPush?: (result: PushFanoutResult) => void;
}): NotificationRow | null {
  const { pushPermissionId, onPush, ...rest } = opts;
  if (!notificationsEnabled()) {
    // Logged and not silent: without the centre, the log trace is the
    // only place where the alert survives.
    console.log(`[notifications] module disabled — ${opts.type} dropped: ${opts.title}`);
    return null;
  }
  const id = randomUUID();
  const row = dbApi.createNotification({ id, ...rest });
  bus.publish({ kind: 'notifications_changed', ownerUserId: row.owner_user_id, notificationId: row.id });
  console.log(`[notifications] ${opts.type}${opts.urgent ? ' (urgent)' : ''} created: ${id.slice(0, 8)} — ${opts.title}`);
  // Web Push sink: this chokepoint is the only place every
  // notification goes through, so the only one to hook. Fire-and-forget — a push that fails
  // must never make the creation of the notification fail, which stays
  // visible in the UI anyway. The filtering by type lives in push.ts.
  const fanout = sink
    ? sink.notify(row, { permissionId: pushPermissionId ?? null })
    : Promise.resolve({ ...NO_PUSH });
  void fanout
    .then((result) => { try { onPush?.(result); } catch { /* best-effort */ } })
    .catch((err) => {
      console.warn('[push] fan-out failed:', (err as Error).message);
    });
  return row;
}

/**
 * Closes one notification the caller has already resolved and checked visible:
 * the dismiss, the system notification on the devices, and the signal to the
 * centres. The route and `ctx.notifications.dismiss` both end here.
 */
export function dismissNotificationRow(row: NotificationRow): boolean {
  if (!dbApi.dismissNotification(row.id)) return false;
  closePushFor(row);
  bus.publish({ kind: 'notifications_changed', ownerUserId: row.owner_user_id });
  return true;
}

function publishChanged(ownerUserId?: string | null): void {
  bus.publish({ kind: 'notifications_changed', ownerUserId: ownerUserId ?? null });
}

/**
 * Closes the action_required cards that point at one thing the user has now
 * dealt with (a dream queue emptied, a plugin approved): the dismiss, the
 * system notification on the devices, and the signal to the centres.
 */
export function resolveAnchor(anchor: string): number {
  const dismissed = dbApi.dismissNotificationsByAnchor(anchor, 'action_required');
  if (dismissed > 0) {
    closePushForAnchor(anchor);
    publishChanged();
    console.log(`[notifications] ${dismissed} action_required auto-dismissed (${anchor} handled)`);
  }
  return dismissed;
}

/**
 * Closes the action_required cards of every anchor that starts with `prefix`:
 * the cards one thing raised under several anchors, when that thing is gone
 * (a plugin removed, `plugin-secret:<id>:` — TODO #661). The prefix is compared
 * literally; the caller ends it with its own separator so `acme:` never takes
 * `acme-2:` along.
 */
export function resolveAnchorPrefix(prefix: string): number {
  const rows = dbApi.listActiveNotificationsByAnchorPrefix(prefix, 'action_required');
  let closed = 0;
  for (const row of rows) if (dbApi.dismissNotification(row.id)) closed++;
  // Every anchor ever raised, not just those still open: see `resolveGoneAnchor`.
  const anchors = dbApi.listNotificationAnchorsByPrefix(prefix);
  for (const anchor of anchors) closePushForAnchor(anchor);
  if (anchors.length > 0) publishChanged();
  if (closed > 0) console.log(`[notifications] ${closed} action_required auto-dismissed (${prefix}* gone)`);
  return closed;
}

/**
 * Closes an anchor that is gone for good, on the devices and the open pages even
 * when no row is left to dismiss. `timon plugin remove` dismisses from the CLI,
 * another process with no push sink and no subscriber: the daemon that follows
 * finds nothing open, and `resolveAnchor` would then leave a system notification
 * on the phones whose button re-arms the removed id (TODO #663).
 */
export function resolveGoneAnchor(anchor: string): number {
  const dismissed = resolveAnchor(anchor);
  if (dismissed === 0) {
    closePushForAnchor(anchor);
    publishChanged();
  }
  return dismissed;
}

/** Dismisses rows the caller already selected, closes them on the devices, signals once. */
function dismissRows(rows: readonly NotificationRow[], why: string): number {
  let closed = 0;
  for (const row of rows) {
    if (!dbApi.dismissNotification(row.id)) continue;
    closed++;
    closePushFor(row);
  }
  if (closed > 0) {
    publishChanged();
    console.log(`[notifications] ${closed} notification(s) auto-dismissed (${why})`);
  }
  return closed;
}

/**
 * A user event the human typed: no origin, or one that only sections their
 * own text (`presentation` without kind/from). An agent's message relayed into
 * the conversation, a wake digest or a dispatcher prompt is not an answer.
 */
function typedByHuman(payload: unknown): boolean {
  const origin = (payload as { origin?: { kind?: unknown; from?: unknown } } | null)?.origin;
  return !origin || !origin.kind || !origin.from;
}

/** Cards whose `expires_at` has passed: the TTL of an agent's `action_required`. */
export function sweepExpiredNotifications(now = Date.now()): number {
  return dismissRows(dbApi.listExpiredNotifications(now), 'expired');
}

const EXPIRY_SWEEP_MS = 60_000;

export function startNotificationResolver(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    // An agent's card set to close on the human's answer: the human wrote in
    // its mission (SUG-0048).
    if (ev.kind === 'event' && ev.type === 'user') {
      if (!typedByHuman(ev.payload)) return;
      dismissRows(dbApi.listActiveNotificationsDismissedOn({ missionId: ev.missionId }, 'reply'), `reply in mission ${ev.missionId.slice(0, 8)}`);
      return;
    }

    if (ev.kind === 'task_done') {
      dismissRows(dbApi.listActiveNotificationsDismissedOn({ taskId: ev.taskId }, 'task_done'), `task ${ev.taskId.slice(0, 8)} done`);
      return;
    }

    // task BLOCKED → create an alert (after dismissing a possible previous alert)
    if (ev.kind === 'task_blocked') {
      const dismissed = dbApi.dismissNotificationsByTask(ev.taskId, 'alert');
      if (dismissed > 0) publishChanged();
      const task = dbApi.getTask(ev.taskId);
      // A blocked ticket mirrored from another system is that system's news.
      if (isMirrorTask(task)) return;
      const shortTitle = task ? (task.title.length > 60 ? task.title.slice(0, 59) + '…' : task.title) : null;
      // TIM-0121: a review or merge stuck on the sandbox the coder was moved away from.
      const cascade = task ? sandboxCascadeNotice(task, ev.reason) : '';
      // The body is the reason alone: it reads in the reader's language when the
      // daemon wrote it with a code. With the sandbox notice beside it, it stays English.
      const reasonCode = task && !cascade && ev.reason === task.blocked_reason
        ? decodeDaemonMessage(task.blocked_reason_code)
        : null;
      createNotification({
        type: 'alert',
        urgent: true,
        title: shortTitle !== null ? `Task blocked: ${shortTitle}` : `Task blocked (${ev.taskId.slice(0, 8)})`,
        body: [ev.reason, cascade].filter(Boolean).join('\n\n') || null,
        message: withDaemonMessageBody(
          daemonMessage('task_blocked', { title: shortTitle ?? 'none', taskId: ev.taskId.slice(0, 8) }),
          reasonCode,
        ),
        taskId: ev.taskId,
        missionId: task?.mission_id ?? null,
      });
      return;
    }

    // task UNBLOCKED → auto-dismiss the linked alerts
    if (ev.kind === 'task_unblocked') {
      const dismissed = dbApi.dismissNotificationsByTask(ev.taskId, 'alert');
      if (dismissed > 0) {
        publishChanged();
        console.log(`[notifications] ${dismissed} alert(s) auto-dismissed (task ${ev.taskId.slice(0, 8)} unblocked)`);
      }
      return;
    }

    // permission resolved or expired → dismiss the associated action_required.
    // Targeted by anchor (= the permission's id): a mission can have
    // several pending cards, resolving one must not erase the
    // others. Without a usable anchor (payload of an old format), fall back
    // on the mission-wide dismiss.
    // A settled command request (`command_request_resolved`) closes its
    // notification the same way: its anchor is the request's id.
    // Same for a layout proposal applied or ignored, a document answered or closed,
    // and a secret request provided, refused or expired: its anchor is its id.
    if (ev.kind === 'event' && (ev.type === 'permission_resolved' || ev.type === 'permission_expired'
      || ev.type === 'command_request_resolved' || ev.type === 'layout_proposal_resolved'
      || ev.type === 'ui_document_resolved' || ev.type === 'secret_request_resolved')) {
      const anchor = (ev.payload as { id?: string } | null)?.id;
      // Rows to close on the devices — captured BEFORE the dismiss, otherwise
      // they can no longer be listed in the mission-wide branch.
      // An agent's card (`dismiss_on`) is not this permission's: it keeps its own lifecycle.
      if (!anchor) {
        const rows = dbApi.listActiveNotificationsByMission(ev.missionId, 'action_required')
          .filter((n) => n.dismiss_on === null);
        dismissRows(rows, `mission ${ev.missionId.slice(0, 8)} ${ev.type}`);
        return;
      }
      const dismissed = dbApi.dismissNotificationsByAnchor(anchor, 'action_required');
      // The card is no longer actionable: the system notification is removed from the device.
      closePushForAnchor(anchor);
      if (dismissed > 0) {
        publishChanged();
        console.log(`[notifications] ${dismissed} action_required auto-dismissed (mission ${ev.missionId.slice(0, 8)} ${ev.type})`);
      }
      return;
    }
  };
  bus.on('event', onBusEvent);
  // TTL of the cards no event can close; unref'd so it never holds a process open.
  const sweep = setInterval(() => sweepExpiredNotifications(), EXPIRY_SWEEP_MS);
  sweep.unref();
  sweepExpiredNotifications();

  console.log('[notifications] resolver started');
  return () => {
    clearInterval(sweep);
    bus.off('event', onBusEvent);
  };
}
