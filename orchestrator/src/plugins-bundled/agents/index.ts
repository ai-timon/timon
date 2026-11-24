/**
 * Module `@timon/agents` — the agents themselves: CRUD, roles, skills,
 * MCP servers, an agent's files, and the graph tying it all together.
 * Tier `core`: without agents, TIMON has nothing to drive.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import type { Context } from '@deepseek-ai/cordis';
import type { ModuleManifest } from '../../kernel/registry.js';
import { registerRoutes } from './routes.js';
import { holdLegacyMissionServersToPublic, migrateMcpHeadersToVault, migrateMcpOAuthTokensToVault, refreshToolsCacheFromInit, relabelLocalClaudeStubs } from '../../mcp.js';
import { whenProvidersLoaded } from '../../backends/registry.js';
import { seedDefaultAgent } from '../../agent.js';
import { backfillAgentRoles } from '../../agent-role-backfill.js';
import { seedBundledSkills } from '../../skills.js';
import { migrateDirectivesToDocs } from '../../agent-directives-migration.js';
import { migrateConfigSkills, migrateTrashedAgentSkills } from '../../agent-skills-migration.js';
import { sweepDeletedAgentGrants } from '../../agent-grants-migration.js';
import { migrateInjectedMcpStubs } from '../../injected-mcp-migration.js';
import { dbApi } from '../../db.js';
import { reconcileMainSeat, watchMainSeat } from '../../main-seat.js';
import { purgeExpiredAgentTrash } from '../../agent-trash.js';
import { dropTrashedAgentBrowserProfiles } from '../../browser-profiles.js';
import { dropTrashedAgentMemory, sweepDeletedAgentMemory } from '../../agent-memory-trash.js';

const TRASH_SWEEP_MS = 3_600_000;

export const manifest: ModuleManifest = {
  name: '@timon/agents',
  tier: 'core',
  inject: ['http', 'db', 'settings'],
};

export const name = manifest.name;
export const inject = manifest.inject;

export function apply(ctx: Context): void {
  // Mounted at the root: the routes already carry their public prefix,
  // moving them would break the front proxy, the CLI and the agents.
  registerRoutes(ctx.http.router());

  ctx.effect(() => {
    let active = true;
    // The default backend exists only after the release providers have registered.
    void whenProvidersLoaded().then(() => {
      if (!active) return;
      seedDefaultAgent();
      // Once, then never again: the role an agent's name used to imply becomes
      // the role it carries. Nothing reads a name after this.
      backfillAgentRoles();
      // After the roles are stamped: they are what the seat is counted by (TIM-0142).
      try {
        reconcileMainSeat();
      } catch (err) {
        console.warn(`[main-seat] check failed: ${(err as Error).message}`);
      }
      // Custom directives are an identity doc now; idempotent, so at every boot.
      migrateDirectivesToDocs();
      // Before the init replay below, and idempotent like it: the stubs of the
      // servers Timon injects, and the exclusions that named them.
      migrateInjectedMcpStubs();
      // Same moment, same reason: a server from the user's own claude config was
      // stored as a claude.ai connector (TIM-0088).
      relabelLocalClaudeStubs();
      // A server a mission declared before its url was judged on its addresses
      // is judged at launch from now on (TODO #577).
      const held = holdLegacyMissionServersToPublic();
      if (held.length) console.log(`[timon] mcp: ${held.length} server(s) declared by a mission now judged again at each launch: ${held.join(', ')}`);
      // OAuth tokens written in a server's file before the vault held them move into it.
      try {
        const tokens = migrateMcpOAuthTokensToVault();
        if (tokens.moved.length) console.log(`[timon] mcp: OAuth tokens of ${tokens.moved.join(', ')} moved into the secrets vault`);
        if (tokens.dropped.length) console.warn(`[timon] mcp: OAuth tokens of ${tokens.dropped.join(', ')} removed from their file, the secrets vault could not take them; connect these servers again`);
      } catch (err) {
        console.warn(`[timon] mcp: OAuth token migration failed: ${(err as Error).message}`);
      }
      // Same for the headers of a remote server, with no loss: what the vault
      // cannot take stays in the file, and the server out of the launches.
      try {
        const headers = migrateMcpHeadersToVault();
        if (headers.moved.length) console.log(`[timon] mcp: headers of ${headers.moved.join(', ')} moved into the secrets vault`);
      } catch (err) {
        console.warn(`[timon] mcp: header migration failed (${(err as Error).name})`);
      }
      seedBundledSkills();
      // After the seed, so a bundled skill named by an agent is not reported
      // missing. Idempotent: config.skills becomes agent-scope attachments.
      migrateConfigSkills();
      // Idempotent: what agents deleted before TODO #668 were granted stops
      // waiting for whoever is created under their name.
      try {
        sweepDeletedAgentGrants();
      } catch (err) {
        console.warn(`[agent-grants] sweep failed: ${(err as Error).message}`);
      }
      // Same for their memory (TODO #670): rules, proposals, learnings.
      try {
        sweepDeletedAgentMemory();
      } catch (err) {
        console.warn(`[agent-memory] sweep failed: ${(err as Error).message}`);
      }

      // Replays the MCP discovery of the last `init` observed: without it, the UI only lists
      // the claude.ai connectors at the next agent spawn, so not at all
      // after a plain restart.
      try {
        const last = dbApi.getLatestInitPayload();
        if (last) refreshToolsCacheFromInit(last);
      } catch (err) {
        console.warn('[timon] init backfill failed:', (err as Error).message);
      }
    }).catch((error: Error) => console.error(`[agents] initialization failed: ${error.message}`));
    return () => { active = false; };
  });

  // The seat holder can lose its folder, its role or its project, and a new
  // orchestrator can be the only candidate for an empty seat: same rules as at boot.
  ctx.effect(() => watchMainSeat());

  // Deleted agents past their retention leave the trash: once at boot, then
  // hourly — a day-granular retention needs no finer clock.
  ctx.effect(() => {
    const sweep = () => {
      try {
        // An entry from before TODO #623 takes its skill attachments out of
        // the table first, so the purge removes them with it.
        migrateTrashedAgentSkills();
        const purged = purgeExpiredAgentTrash();
        // Their parked browser profiles (TODO #668) and memory (TODO #670) go with them.
        for (const id of purged) { dropTrashedAgentBrowserProfiles(id); dropTrashedAgentMemory(id); }
        if (purged.length) console.log(`[agent-trash] purged ${purged.length} expired agent(s): ${purged.join(', ')}`);
      } catch (err) {
        console.warn(`[agent-trash] purge failed: ${(err as Error).message}`);
      }
    };
    sweep();
    const timer = setInterval(sweep, TRASH_SWEEP_MS);
    timer.unref();
    return () => clearInterval(timer);
  });

  // The reaper is NOT armed here, although §3.4 of the plan puts it here: it must
  // run AFTER the sweep of zombie missions, otherwise the two self-heals
  // compete on the same rows. `boot.ts` starts it after the audit.
}
