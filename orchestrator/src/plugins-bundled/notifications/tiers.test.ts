/**
 * End of the core tier: what each module turned off costs, and what it does
 * NOT cost.
 *
 * Two promises kept here, in this order of risk:
 *   1. `notifications` off makes nobody fail. An agent closes its task
 *      with a report; if that report threw, the task would go BLOCKED for
 *      a reason that has nothing to do with its work.
 *   2. `web-push` off does not touch the in-app centre. Push is a relay
 *      of the centre, never the reverse; cutting them together would be the bug the
 *      extraction is meant to make impossible.
 */
// Isolates TIMON_HOME BEFORE any module that touches TIMON state (see test-home.ts).
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { createNotification, notificationsEnabled, registerPushSink,
        closePushFor, closePushForAnchor } = await import('../../notifications.js');
const { setActiveModules, resetActiveModules } = await import('../../kernel/module-state.js');
const { dbApi } = await import('../../db.js');
const { CATALOG } = await import('../../kernel/catalog.js');
const { planEntries } = await import('../../kernel/registry.js');
const { config } = await import('../../config/load.js');

test('notifications is std, web-push is opt, and web-push injects notifications', async () => {
  const notifications = CATALOG.find((m) => m.id === '@timon/notifications');
  const webPush = CATALOG.find((m) => m.id === '@timon/web-push');
  assert.equal(notifications?.tier, 'std');
  assert.equal(webPush?.tier, 'opt');

  // Without a notification centre, push has nothing to relay: the dependency
  // is declared to Cordis, not only documented.
  const mod = await import('../web-push/index.js');
  assert.ok(mod.inject?.includes('notifications'));
});

test('the catalogue lets notifications be turned off', () => {
  const cfg = { ...config(), modules: { '@timon/notifications': false } };
  const decisions = planEntries(CATALOG, { config: cfg, capabilities: [] });
  const d = decisions.find((x) => x.id === '@timon/notifications');
  assert.equal(d?.disabled, true);
  assert.match(d?.reason ?? '', /timon\.config\.json/);
});

test('centre off: createNotification does not throw, returns null, writes nothing', () => {
  // The kernel spoke and did not name `notifications`: the centre is off.
  setActiveModules(['@timon/db', '@timon/http']);
  try {
    assert.equal(notificationsEnabled(), false);
    const before = dbApi.countActiveNotifications();
    const n = createNotification({ type: 'report', title: 'rapport de fin de task' });
    assert.equal(n, null);
    assert.equal(dbApi.countActiveNotifications(), before);
    // Closing a system notification without a centre or a sink does not throw either.
    closePushFor({ id: 'inexistante', anchor: null });
    closePushForAnchor('inexistante');
  } finally {
    resetActiveModules();
  }
});

test('centre on without web-push: the notification lives, the push is a no-op', async () => {
  // No kernel spoke = everything is on (see `kernel/module-state.ts`).
  assert.equal(notificationsEnabled(), true);
  {
    const n = createNotification({ type: 'alert', urgent: true, title: 'sans push' });
    assert.ok(n, 'the in-app centre does not depend on push');
    assert.equal(dbApi.getNotification(n.id)?.title, 'sans push');

    // `onPush` is indeed called, with the report of a fan-out that did not
    // happen. `permissions.ts` deduces "nobody was reached", hence the
    // short window: that is the right conclusion, not a fallback.
    const seen: { delivered: number; configured: boolean }[] = [];
    createNotification({
      type: 'action_required',
      title: 'permission sans push',
      onPush: (r) => void seen.push({ delivered: r.delivered, configured: r.configured }),
    });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(seen, [{ delivered: 0, configured: false }]);
  }
});

test('a registered sink receives the fan-out, and unplugging it stops it', async () => {
  const targets: string[] = [];
  const unregister = registerPushSink({
    notify: async (n) => {
      targets.push(n.title);
      return { configured: true, targeted: 1, delivered: 1, failed: 0, gone: 0, skipped: 0 };
    },
    closeFor: async () => {},
    closeForAnchor: async () => {},
  });
  try {
    createNotification({ type: 'action_required', title: 'avec sink' });
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(targets, ['avec sink']);

    unregister();
    createNotification({ type: 'action_required', title: 'sink débranché' }); // french-ok: free-text sample data
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(targets, ['avec sink'], 'an unloaded module no longer pushes');
  } finally {
    unregister();
  }
});
