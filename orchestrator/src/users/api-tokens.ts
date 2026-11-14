/**
 * Mission API tokens (Phase M.5, `docs/MULTI-USER.md` §6).
 *
 * A spawned agent authenticates as the user who launched the mission,
 * never as the daemon. Plugin jobs get a system identity (`plugin:<id>`)
 * that cannot pick up `:all` just by running inside the process. The CLI
 * keeps using the daemon-token — that is operator access, not a mission.
 *
 * The plaintext is returned once, injected as `TIMON_API_TOKEN`, and only
 * its hash is stored. Re-issuing for the same mission revokes the previous
 * row so a respawned turn does not accumulate live tokens.
 *
 * Ordinary mission tokens do not carry `isSuperadmin`. Their grants are
 * the mission cap ∩ the launcher's permissions (`users/permissions.ts`).
 * Verified developer-owner missions inherit full authority, checked live.
 */
import { randomBytes } from 'node:crypto';
import { db, dbApi } from '../db.js';
import { hashSessionToken } from './session.js';
import { EGRESS_PROXY_TOKEN_SCOPE } from './permissions.js';

export const SYSTEM_ACTOR_ID = 'system';
export const PLUGIN_OWNER_PREFIX = 'plugin:';
/** Stored in `api_tokens.scope` for a user-owned mission token. */
export const MISSION_TOKEN_SCOPE = 'mission';

export {
  EGRESS_PROXY_TOKEN_SCOPE,
  MISSION_TOKEN_PERMISSIONS,
  intersectMissionTokenPermissions,
} from './permissions.js';

export function hashApiToken(token: string): string {
  return hashSessionToken(token);
}

export function issueApiTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function isPluginOwner(owner: string | null | undefined): owner is string {
  return typeof owner === 'string' && owner.startsWith(PLUGIN_OWNER_PREFIX);
}

/**
 * Token to inject into a mission's environment, with or without an account
 * on the machine: a mission never holds the daemon-token. Before the first
 * account, the row has no user and `getLiveApiToken` gives it the install's
 * rights as an agent (`db.ts`).
 */
export function issueMissionApiToken(missionId: string): string {
  // The egress credential has its own lifecycle: issuing it after the API token,
  // or the API token after it, must not revoke the one the process already holds.
  dbApi.revokeApiTokensForMission(missionId, { keepScope: EGRESS_PROXY_TOKEN_SCOPE });
  const raw = issueApiTokenSecret();
  dbApi.createApiToken({
    tokenHash: hashApiToken(raw),
    ...missionTokenIdentity(missionId),
    label: `mission:${missionId}`,
    missionId,
  });
  return raw;
}

/**
 * The mission's egress proxy credential: what `HTTP(S)_PROXY` carries, so that
 * neither the daemon-token (an install with no account) nor the mission's API
 * token ever lands in a proxy URL — and a mission whose CLI is a third party's
 * (no `TIMON_API_TOKEN`) still has one. No user, no grant: the row exists for
 * `missionOfEgressToken` alone, and dies with the mission like every token
 * bound to it (`finishMission`). Re-issuing replaces the previous one only.
 */
export function issueMissionEgressToken(missionId: string): string {
  const raw = issueApiTokenSecret();
  db.transaction(() => {
    dbApi.revokeApiTokensForMission(missionId, { onlyScope: EGRESS_PROXY_TOKEN_SCOPE });
    dbApi.createApiToken({
      tokenHash: hashApiToken(raw),
      userId: null,
      label: `egress:${missionId}`,
      scope: EGRESS_PROXY_TOKEN_SCOPE,
      missionId,
    });
  })();
  return raw;
}

/** The running mission an egress credential belongs to, or `null`. */
export function missionOfEgressToken(token: string, now: number = Date.now()): string | null {
  if (!token) return null;
  const row = dbApi.getApiTokenByHash(hashApiToken(token));
  if (!row || row.scope !== EGRESS_PROXY_TOKEN_SCOPE || !row.mission_id) return null;
  if (row.expires_at != null && row.expires_at <= now) return null;
  return dbApi.getMission(row.mission_id)?.status === 'running' ? row.mission_id : null;
}

/** Who a mission's token acts as: its active owner, a plugin, or the system. */
function missionTokenIdentity(missionId: string): { userId: string | null; scope: string } {
  const owner = dbApi.getMission(missionId)?.owner_user_id ?? null;
  if (owner) {
    const user = dbApi.getUserById(owner);
    if (user && user.status === 'active') return { userId: user.id, scope: MISSION_TOKEN_SCOPE };
    if (isPluginOwner(owner)) return { userId: null, scope: owner };
  }
  return { userId: null, scope: SYSTEM_ACTOR_ID };
}

/** The mission a delegate was asked for is gone or no longer running. */
export class MissionNotRunningError extends Error {
  constructor() {
    super('mission is not running');
    this.name = 'MissionNotRunningError';
  }
}

/**
 * A second credential for the same mission, with the same grants, that does
 * NOT revoke the one its process holds: the remote MCP endpoint acts as the
 * mission for one tool call, then deletes it (`revokeApiToken`). Short-lived
 * by construction, and dies with the mission like any mission token.
 *
 * The row is inserted only while the mission is `running`, in the same
 * statement: a mission that ended a moment earlier (its tokens already swept
 * by `finishMission`) must not get a fresh one back. With `agentName`, the
 * mission must also run under that agent: a grant issued for one agent never
 * acts for a mission the id now points at under another.
 */
export function issueMissionDelegateToken(missionId: string, label: string, ttlMs: number, agentName?: string): { raw: string; hash: string } {
  const raw = issueApiTokenSecret();
  const hash = hashApiToken(raw);
  const now = Date.now();
  const agent = agentName ?? null;
  const inserted = db.transaction(() => {
    const identity = missionTokenIdentity(missionId);
    return db.prepare(
      `INSERT INTO api_tokens (token_hash, user_id, label, scope, created_at, last_used_at, expires_at, mission_id)
       SELECT ?, ?, ?, ?, ?, NULL, ?, id FROM missions
       WHERE id = ? AND status = 'running' AND (? IS NULL OR agent_name = ?)`,
    ).run(hash, identity.userId, label, identity.scope, now, now + ttlMs, missionId, agent, agent).changes;
  })();
  if (inserted !== 1) throw new MissionNotRunningError();
  return { raw, hash };
}

/** Owner to stamp on a newly created mission row, before the child starts. */
export function ownerForSpawn(opts: {
  ownerUserId?: string | null;
  sourceChannel?: string | null;
}): string | null {
  if (opts.ownerUserId !== undefined) return opts.ownerUserId;
  if (isPluginOwner(opts.sourceChannel)) return opts.sourceChannel;
  return null;
}
