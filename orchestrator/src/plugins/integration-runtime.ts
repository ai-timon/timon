import { daemonMessage } from '../daemon-message.js';
import { dbApi } from '../db.js';
import { INTEGRATIONS_DB_PATH } from '../paths.js';
import { settingInt } from '../settings.js';
import { findChannelMission, serializeReceipt } from '../channel-receipts.js';
import { readPluginSecret } from '../secrets/plugins.js';
import { assertSpawnAllowed } from './policy.js';
import { assertIntegrationPermission } from './integration-host.js';
import { IntegrationStore } from './integration-store.js';
import { IntegrationService, startIntegrationWorker, type IntegrationHost } from './integration-service.js';
import type { PluginInboundMessage } from './integration-types.js';

const GAVE_UP_CARD_EVERY_MS = 3_600_000;
const lastGaveUpCard = new Map<string, number>();

export function daemonIntegrationHost(): IntegrationHost {
  return {
    assert: assertIntegrationPermission,
    secret: readPluginSecret,
    async spawn(connection, receipt, signal) {
      const source = `plugin:${connection.pluginId}`;
      let missionId: string | undefined;
      await serializeReceipt(JSON.stringify(['integration', connection.identity.ownerUserId, receipt.id]), async () => {
        signal.throwIfAborted();
        missionId = findChannelMission({ channel: source, id: receipt.id }, connection.identity.ownerUserId);
        if (missionId) return;
        const { spawnAgent } = await import('../agent.js');
        signal.throwIfAborted();
        assertSpawnAllowed(connection.pluginId);
        const message = JSON.parse(receipt.message) as PluginInboundMessage;
        missionId = await spawnAgent(connection.agent, message.text, {
          channel: source, meta: { channel_receipt_id: receipt.id, integration_connection_id: connection.id },
        }, { ownerUserId: connection.identity.ownerUserId, explicitResume: null });
      });
      return missionId!;
    },
    async mission(id, ownerUserId) {
      const mission = dbApi.getMission(id, { id: ownerUserId, isSuperadmin: false, permissions: [] });
      if (!mission) return;
      return { status: mission.status, events: dbApi.listEvents(id).map((event) => ({ type: event.type, payload: JSON.parse(event.payload) as unknown })) };
    },
    gaveUp(connection) {
      // A provider outage fails a whole backlog within minutes: one card per
      // connection and per hour says it just as well as a thousand.
      const now = Date.now();
      if (now - (lastGaveUpCard.get(connection.id) ?? 0) < GAVE_UP_CARD_EVERY_MS) return;
      lastGaveUpCard.set(connection.id, now);
      void import('../notifications.js').then(({ createNotification }) => {
        createNotification({
          type: 'alert',
          title: 'A messaging integration stopped retrying a message',
          body: `A message on the ${connection.transport} connection could not be processed. Replay it from Settings › Secrets › Connections.`,
          message: daemonMessage('integration_gave_up', { transport: connection.transport }),
          // A connection the plugin owns itself names no account: the card goes to the administrators.
          ownerUserId: connection.identity.ownerUserId.startsWith('plugin:') ? null : connection.identity.ownerUserId,
        });
      }).catch(() => { console.error('[integrations] could not report a failed receipt'); });
    },
  };
}

const RECEIPT_PRUNE_EVERY_MS = 3_600_000;

/** Applies `TIMON_INTEGRATION_RECEIPT_RETENTION_DAYS` once, now. 0 keeps every receipt. */
export function pruneIntegrationReceipts(store: IntegrationStore, now = Date.now()): number {
  const days = settingInt('TIMON_INTEGRATION_RECEIPT_RETENTION_DAYS');
  if (!(days > 0)) return 0;
  const cutoff = now - days * 86_400_000;
  const delivered = store.pruneDelivered(cutoff);
  const failed = store.pruneFailed(cutoff);
  if (delivered) console.log(`[integrations] ${delivered} delivered receipt(s) older than ${days} days removed`);
  if (failed) console.log(`[integrations] ${failed} failed receipt(s) not replayed within ${days} days removed`);
  return delivered + failed;
}

function startReceiptRetention(store: IntegrationStore): () => void {
  const run = (): void => {
    try { pruneIntegrationReceipts(store); }
    catch (error) { console.error(`[integrations] receipt cleanup failed: ${(error as Error).message}`); }
  };
  run();
  const timer = setInterval(run, RECEIPT_PRUNE_EVERY_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

let current: IntegrationService | undefined;
export function integrationService(): IntegrationService {
  if (!current) throw new Error('Integration runtime unavailable');
  return current;
}
export function startIntegrationRuntime(): { service: IntegrationService; stop: () => Promise<void> } {
  if (current) throw new Error('Integration runtime already started');
  const store = new IntegrationStore(INTEGRATIONS_DB_PATH);
  const service = new IntegrationService(store, daemonIntegrationHost());
  current = service;
  const stopWorker = startIntegrationWorker(service);
  const stopPrune = startReceiptRetention(store);
  return { service, stop: async () => {
    if (current !== service) return;
    current = undefined;
    stopPrune();
    await stopWorker();
    store.close();
  } };
}
