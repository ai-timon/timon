/**
 * Module `notifications` — the in-app notification centre.
 * Tier `std`: active by default, can be disabled.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Router } from 'express';
import { z } from 'zod';
import { bus } from '../../bus.js';
import { config } from '../../config/load.js';
import { dbApi, NOTIFICATION_DISMISS_ON, type NotificationDismissOn, type NotificationType } from '../../db.js';
import { closePushFor, createNotification, dismissNotificationRow } from '../../notifications.js';
import { viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { apiError } from '../../api-error.js';
import { backendBinaryPresentation, checkBackendBinaries } from '../../backends/binary-check.js';

/**
 * How an agent's `action_required` goes away by itself (SUG-0048). An agent
 * cannot know when the human has done what it asked, so the card names the
 * event that answers it: the human writing in the mission (`reply`), or the
 * linked task reaching DONE (`task_done`). A TTL backs every card up: 24 h
 * when no such event can apply, 7 days when one can but may never come (nobody
 * types into an autonomous task's mission; a task can end FAILED, not DONE).
 */
const NOTIFY_TTL_MAX_MIN = 30 * 24 * 60;
export const NOTIFY_DEFAULT_TTL_MIN = 24 * 60;
export const NOTIFY_BACKSTOP_TTL_MIN = 7 * 24 * 60;
const LifecycleBody = z.object({
  dismiss_on: z.array(z.enum(NOTIFICATION_DISMISS_ON as [NotificationDismissOn, ...NotificationDismissOn[]])).max(2).nullish(),
  ttl_minutes: z.number().int().min(1).max(NOTIFY_TTL_MAX_MIN).nullish(),
});

type Lifecycle = { dismissOn: NotificationDismissOn[] | null; expiresAt: number | null };

/** The card's lifecycle, or the reason it cannot have this one. */
export function notifyLifecycle(
  body: unknown,
  type: NotificationType,
  link: { taskId: string | null; missionId: string | null },
  now = Date.now(),
): Lifecycle | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const parsed = LifecycleBody.safeParse({ dismiss_on: raw.dismiss_on, ttl_minutes: raw.ttl_minutes });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: `${issue?.path.join('.') || 'body'}: ${issue?.message ?? 'invalid'}` };
  }
  const { dismiss_on: asked, ttl_minutes: ttl } = parsed.data;
  if (type !== 'action_required') {
    return asked != null || ttl != null
      ? { error: 'dismiss_on and ttl_minutes apply to action_required only' }
      : { dismissOn: null, expiresAt: null };
  }
  if (asked?.includes('reply') && !link.missionId) return { error: 'dismiss_on reply needs a mission' };
  if (asked?.includes('task_done') && !link.taskId) return { error: 'dismiss_on task_done needs a task_id' };
  const dismissOn = asked ?? [
    ...(link.missionId ? ['reply' as const] : []),
    ...(link.taskId ? ['task_done' as const] : []),
  ];
  const minutes = ttl ?? (dismissOn.length === 0 ? NOTIFY_DEFAULT_TTL_MIN : NOTIFY_BACKSTOP_TTL_MIN);
  return {
    dismissOn: dismissOn.length > 0 ? [...new Set(dismissOn)] : null,
    expiresAt: now + minutes * 60_000,
  };
}

export function registerRoutes(app: Router): void {
  app.get('/api/notifications', (req, res) => {
    const archived = req.query.archived === 'true';
    const limit = Math.min(200, Number(req.query.limit ?? 50) || 50);
    const scope = scopedDb(viewerFromRequest(req));
    const rows = scope.listNotifications({ archived, limit });
    // Which agent raised it: the center shows it on every row.
    const agents = dbApi.notificationAgents(rows);
    const binaries = rows.some((n) => n.anchor?.startsWith('backend-binary:')) ? checkBackendBinaries() : [];
    const notifications = rows.map((n) => ({
      ...n,
      agent: agents.get(n.id) ?? null,
      presentation: backendBinaryPresentation(n, binaries),
    }));
    const counts = scope.countActiveByType();
    res.json({ notifications, counts, total_active: scope.countActiveNotifications() });
  });

  app.post('/api/notifications', (req, res) => {
    const { type, urgent, title, body, task_id, mission_id, anchor } = req.body ?? {};
    if (!type || !title) { res.status(400).json({ error: 'type and title required' }); return; }
    if (!['action_required', 'alert', 'report'].includes(type)) {
      res.status(400).json({ error: 'invalid type' });
      return;
    }
    // SECU-USERS U-7: the owner is inherited from the linked task / mission,
    // so a caller may only link what they can read — otherwise a notification
    // lands in someone else's centre. Unknown and foreign answer the same 404.
    const scope = scopedDb(viewerFromRequest(req));
    if (typeof task_id === 'string' && task_id && !scope.getTask(task_id)) {
      res.status(404).json({ error: 'task not found' });
      return;
    }
    if (typeof mission_id === 'string' && mission_id && !scope.getMission(mission_id)) {
      res.status(404).json(apiError('mission_not_found', 'mission not found'));
      return;
    }
    const lifecycle = notifyLifecycle(req.body, type, {
      taskId: typeof task_id === 'string' && task_id ? task_id : null,
      missionId: typeof mission_id === 'string' && mission_id ? mission_id : null,
    });
    if ('error' in lifecycle) { res.status(400).json({ error: lifecycle.error }); return; }
    const n = createNotification({
      type, urgent: Boolean(urgent), title, body, taskId: task_id, missionId: mission_id, anchor,
      ownerUserId: task_id || mission_id ? undefined : viewerFromRequest(req)?.id ?? null,
      ...lifecycle,
    });
    // `null` = centre off. Impossible from THIS route (it is only mounted
    // by the module), but the type requires it and the 503 stays the honest
    // answer if the mounting order ever changed.
    if (!n) { res.status(503).json({ error: 'notifications module disabled' }); return; }
    res.status(201).json({ notification: n });
  });

  app.post('/api/notifications/dismiss-all', (req, res) => {
    const type = req.body?.type as string | undefined;
    if (type && !['action_required', 'alert', 'report'].includes(type)) {
      res.status(400).json({ error: 'invalid type' });
      return;
    }
    const t = type as NotificationType | undefined;
    const scope = scopedDb(viewerFromRequest(req));
    // Rows read BEFORE the dismiss: afterwards, they can no longer be listed and we
    // could no longer close their system notifications.
    const rows = scope.listActiveNotifications(t);
    const dismissed = scope.dismissAllNotifications(t);
    for (const row of rows) closePushFor(row);
    if (dismissed > 0) bus.publish({ kind: 'notifications_changed', ownerUserId: viewerFromRequest(req)?.id ?? null });
    res.json({ ok: true, dismissed });
  });

  app.post('/api/notifications/:id/dismiss', (req, res) => {
    // Row read BEFORE the dismiss: afterwards, its system notification can no longer be closed.
    const row = scopedDb(viewerFromRequest(req)).getNotification(req.params.id);
    if (!row) { res.status(404).json(apiError('already_dismissed', 'not found or already dismissed')); return; }
    if (!dismissNotificationRow(row)) { res.status(404).json(apiError('already_dismissed', 'not found or already dismissed')); return; }
    res.json({ ok: true });
  });
}
