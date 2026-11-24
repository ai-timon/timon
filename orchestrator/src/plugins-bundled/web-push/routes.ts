/**
 * Module `web-push` — the Web Push subscription routes.
 *
 * Bodies extracted verbatim from `plugins-bundled/notifications/routes.ts`.
 */
import { daemonMessage } from '../../daemon-message.js';
import type { Router } from 'express';
import { dbApi } from '../../db.js';
import { createNotification } from '../../notifications.js';
import { getVapidPublicKey, isPushConfigured, subscribeDevice, unsubscribeDevice } from './push.js';
import { apiError } from '../../api-error.js';

export function registerRoutes(app: Router): void {
  app.get('/api/push/config', (_req, res) => {
    // The PUBLIC key is meant to be exposed: the browser needs it for
    // `pushManager.subscribe()`. The private one never leaves the host.
    res.json({ enabled: isPushConfigured(), public_key: getVapidPublicKey() });
  });

  app.get('/api/push/subscriptions', (_req, res) => {
    // No keys in the response: the UI only needs the device's identity.
    const subs = dbApi.listPushSubscriptions().map((s) => ({
      id: s.id,
      endpoint: s.endpoint,
      device_label: s.device_label,
      created_at: s.created_at,
      last_seen_at: s.last_seen_at,
      last_error: s.last_error,
    }));
    res.json({ subscriptions: subs });
  });

  app.post('/api/push/subscribe', (req, res) => {
    const { endpoint, keys, device_label } = req.body ?? {};
    const p256dh = keys?.p256dh;
    const auth = keys?.auth;
    if (typeof endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') {
      res.status(400).json(apiError('push_subscription_invalid', 'endpoint, keys.p256dh and keys.auth are required'));
      return;
    }
    if (!isPushConfigured()) {
      res.status(503).json(apiError('push_not_configured', 'VAPID is not configured on the orchestrator'));
      return;
    }
    const row = subscribeDevice({
      endpoint,
      p256dh,
      auth,
      deviceLabel: typeof device_label === 'string' ? device_label.slice(0, 120) : null,
    });
    console.log(`[push] subscription recorded — ${row.device_label ?? row.id.slice(0, 8)}`);
    res.status(201).json({ ok: true, id: row.id });
  });

  app.post('/api/push/unsubscribe', (req, res) => {
    const { endpoint } = req.body ?? {};
    if (typeof endpoint !== 'string') { res.status(400).json(apiError('push_endpoint_required', 'endpoint is required')); return; }
    const removed = unsubscribeDevice(endpoint);
    res.json({ ok: true, removed });
  });

  app.post('/api/push/test', async (_req, res) => {
    // Check round trip from the UI: goes through createNotification to take
    // exactly the same path as a real permission request.
    if (!isPushConfigured()) { res.status(503).json(apiError('push_not_configured', 'VAPID is not configured on the orchestrator')); return; }
    const n = createNotification({
      type: 'action_required',
      urgent: true,
      title: 'Timon test push',
      body: 'If you can read this on your phone, the channel works.',
      anchor: '/notifications',
      message: daemonMessage('push_test'),
    });
    if (!n) { res.status(503).json(apiError('notifications_disabled', 'notifications module disabled')); return; }
    res.json({ ok: true, id: n.id, devices: dbApi.listPushSubscriptions().length });
  });
}
