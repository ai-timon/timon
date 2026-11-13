/**
 * Module `@timon/missions` — a mission's lifecycle: launch, resume,
 * interruption, backend swap, inter-agent messages, permission cards.
 * Tier `core`.
 *
 * Registration order is load-bearing: `/api/missions/search` MUST precede
 * `/api/missions/:id`, otherwise `search` gets captured as an id. It is
 * kept exactly as it was in `index.ts`.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { startPermissionExpiry } from '../../permissions.js';
import { startMissionTitles } from '../../mission-titles.js';
import { purgeChatAttachments } from '../../chat-attachments.js';
import { purgeProviderScratch, trimProviderCaches } from '../../backends/provider-scratch.js';
import { dbApi } from '../../db.js';
import { settingNum } from '../../settings.js';
import { startEgressProxy } from '../../egress/service.js';
import { pruneEgressJournal } from '../../egress/journal.js';
import { registerEgressRoutes } from '../../egress/routes.js';

export const manifest: ModuleManifest = {
  name: '@timon/missions',
  tier: 'core',
  inject: ['http', 'db'],
};

export const name = manifest.name;
export const inject = manifest.inject;

/** How often the cleanup runs. An hour is plenty for a 30-day retention, and
 *  keeps the first pass close enough to a restart to be observable. */
const PURGE_EVERY_MS = 3_600_000;

/**
 * Deletes the chat attachments of missions finished long enough ago.
 *
 * The decision is never taken on age alone: a directory is named after its
 * mission, and the lifetime below is read from the database. A running
 * mission — including one a resume brought back to life, which `reopenMission`
 * puts back to `running` with a null `ended_at` — is never touched, whatever
 * its age. That is the whole point of naming the directories: a blind cleanup
 * could always delete a file an agent still needs.
 */
function missionLifetime(missionId: string): { live: boolean; endedAt: number | null } | null {
  const mission = dbApi.getMission(missionId);
  if (!mission) return null; // orphan: the caller falls back on the directory date
  return { live: mission.status === 'running' || mission.ended_at == null, endedAt: mission.ended_at };
}

/** The egress journal's age limit and global cap (the per-mission cap holds at every insert). */
function pruneEgress(): void {
  try {
    const removed = pruneEgressJournal();
    if (removed > 0) console.log(`[egress] ${removed} journal row(s) past retention removed`);
  } catch (err) {
    console.warn(`[egress] journal sweep failed: ${(err as Error).message}`);
  }
}

function purgeOnce(): void {
  const ttl = settingNum('TIMON_CHAT_ATTACHMENT_TTL_MS');
  if (ttl <= 0) return; // cleanup disabled by configuration
  const outcome = purgeChatAttachments(missionLifetime, ttl);
  if (outcome.removed.length) {
    console.log(`[attachments] ${outcome.removed.length} mission folder(s) cleaned up `
      + `(${outcome.keptLive} live, ${outcome.keptRecent} within retention)`);
  }
}

/**
 * Same rule for the provider's per-mission folders: a CLI's session store (codex's
 * rollout) lives there, so a kill no longer removes it (TIM-0111) — this does, once
 * the mission has been over for the retention. Nothing removed them before: an
 * install kept every reaped mission's folder forever.
 */
function purgeProviderSessions(): void {
  // Not tied to the retention: what goes is downloaded again, never the conversation.
  const trim = trimProviderCaches(missionLifetime);
  if (trim.missions) {
    console.log(`[provider-scratch] ${(trim.bytes / 1_048_576).toFixed(1)} MB of CLI caches freed `
      + `in ${trim.missions} finished mission folder(s)`);
  }
  const ttl = settingNum('TIMON_PROVIDER_SESSION_TTL_MS');
  if (ttl <= 0) return;
  const outcome = purgeProviderScratch(missionLifetime, ttl);
  if (outcome.removed.length) {
    console.log(`[provider-scratch] ${outcome.removed.length} mission folder(s) cleaned up `
      + `(${outcome.keptLive} live, ${outcome.keptRecent} within retention)`);
  }
}

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());
  registerEgressRoutes(ctx.http.router());

  // Expiry of the permission cards must be armed BEFORE the sweep of
  // zombie missions (done by `boot.ts` after the audit): otherwise the cards of
  // dead missions would stay open forever.
  ctx.effect(() => startPermissionExpiry());

  // A conversation opened by hand gets a short title at the end of its first
  // turn (TODO #358); automated missions never do. Off the turn's path.
  ctx.effect(() => startMissionTitles().stop);

  // Missions' outbound traffic, journaled per mission, never blocked (TODO #590).
  ctx.effect(() => startEgressProxy());

  ctx.effect(() => {
    const purge = (): void => { purgeOnce(); purgeProviderSessions(); pruneEgress(); };
    purge();
    const timer = setInterval(purge, PURGE_EVERY_MS);
    return () => clearInterval(timer);
  });
}
