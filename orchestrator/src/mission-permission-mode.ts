/**
 * The permission mode of a mission that is already running, as the composer's
 * selector reads and changes it (TODO #430).
 *
 * The level lives on `missions.permission_mode_override`, which every turn
 * reads (`spawnTurn`). What differs from one backend to the next is WHEN a new
 * value takes hold: a one-shot CLI is respawned on every turn and picks it up
 * at once, while a persistent one (claude) fixed it at launch and is relaunched
 * on its session before the next message (`sendToAgent`).
 */
import { dbApi, type MissionRow } from './db.js';
import { loadConfig, type AgentConfig } from './agent-config.js';
import { defaultBackendName } from './backends/index.js';
import { catalogBackend } from './backends/catalog.js';
import { canonicalPermissionMode, effectiveLevel, permissionModeRefusal, type OverrideAuthority } from './users/privileged-overrides.js';

/**
 * The rungs a selector offers, lowest first. `dontAsk` stays out: it refuses
 * every tool use that was not pre-approved, which reads as a broken agent to
 * someone choosing from a menu. The route still accepts it from a caller
 * allowed to name it.
 */
const BRIDGE_LADDER = ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions'] as const;

/** A sandbox dialect only knows three levels (`sandboxLevelForPermissionMode`):
 *  offering five would show three entries that all run the same sandbox. */
const SANDBOX_LADDER = ['plan', 'auto', 'bypassPermissions'] as const;

export type MissionPermissionState = {
  /** The level the next turn really runs in, as its Claude name: on a backend
   *  that declares its supported modes, the one it really runs (`plan` for any
   *  other); a sandbox dialect runs `default` and `acceptEdits` in its
   *  workspace-write sandbox, so it reads `auto` here, not the label the
   *  agent's config carries. */
  mode: string;
  /** The level as written on the mission or the agent, before the backend
   *  had its say. Differs from `mode` only where the backend rounds it. */
  configured: string;
  /** Where that level comes from. */
  source: 'mission' | 'agent' | 'default';
  backend: string;
  /** False when the backend cannot honour a change of level mid-mission: the
   *  selector is then hidden rather than offering a value that does nothing. */
  switchable: boolean;
  /** What THIS caller may pick, lowest first. */
  choices: string[];
};

function agentConfigOf(mission: MissionRow): AgentConfig {
  try { return loadConfig(mission.agent_name); } catch { return {}; }
}

function backendOf(mission: MissionRow, cfg: AgentConfig): string {
  return mission.backend_override ?? cfg.backend ?? defaultBackendName();
}

/**
 * Only the two models that apply a level at launch can follow a change: the
 * bridge re-reads it when the CLI is relaunched, the sandbox when it is
 * respawned. A protocol session (ACP) negotiates its own permissions, and
 * `none` runs everything unguarded whatever we write.
 */
function switchableBackend(backend: string): boolean {
  const model = catalogBackend(backend)?.permissionModel;
  return model === 'mcp-bridge' || model === 'sandbox';
}

export function missionPermissionState(
  missionId: string,
  authority: OverrideAuthority,
): MissionPermissionState | null {
  const mission = dbApi.getMission(missionId);
  if (!mission) return null;
  const cfg = agentConfigOf(mission);
  const backend = backendOf(mission, cfg);
  const fromMission = mission.permission_mode_override;
  const configured = canonicalPermissionMode(fromMission || cfg.permission_mode || 'default');
  const source = fromMission ? 'mission' : cfg.permission_mode ? 'agent' : 'default';
  const entry = catalogBackend(backend);
  const ladder: readonly string[] = entry?.permissionModel === 'sandbox' ? SANDBOX_LADDER : BRIDGE_LADDER;
  // A rung the backend would run as another one is not a choice.
  const supported = entry?.supportedPermissionModes;
  return {
    // The same rounding the permission ceiling applies: showing the label
    // would name a level the sandbox does not have (a tester read
    // `acceptEdits` on the agent and a mode the mission did not run in).
    mode: effectiveLevel(configured, backend),
    configured,
    source,
    backend,
    switchable: switchableBackend(backend),
    choices: ladder.filter((m) => (!supported || supported.includes(m)) && permissionModeRefusal(m, authority, backend) === null),
  };
}

/** Whether the backend serving `missionId` can take a new level mid-mission. */
export function missionPermissionSwitchable(missionId: string): boolean {
  const mission = dbApi.getMission(missionId);
  if (!mission) return false;
  return switchableBackend(backendOf(mission, agentConfigOf(mission)));
}
