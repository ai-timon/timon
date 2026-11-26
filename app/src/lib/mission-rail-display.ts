/**
 * What a row of the Missions widget shows besides its title: the agent's
 * avatar. Which missions it lists: only the user's own conversations, or every
 * mission of the project (TODO #284). And whether missions nest under the
 * orchestrator that launched them (`lib/mission-rail-groups.ts`), and whether
 * those groups start unfolded. And whether archived missions are listed too.
 * Stored by the daemon in the account's layout rows, like the TO DO display.
 */

/** Daemon layout scope (`^[a-z0-9][a-z0-9._-]{0,63}$`). */
export const MISSION_RAIL_DISPLAY_SCOPE = 'missions.rail';

/** `mineOnly` keeps its historical name: the filter menu shows it inverted, as "Automated missions". */
export type MissionRailDisplay = { showAvatar: boolean; mineOnly: boolean; groupByOrchestrator: boolean; expandSubagents: boolean; includeArchived: boolean };

/** Groups start folded: a busy orchestrator's sub-agents would bury the other conversations. */
export const DEFAULT_MISSION_RAIL_DISPLAY: MissionRailDisplay = { showAvatar: true, mineOnly: false, groupByOrchestrator: false, expandSubagents: false, includeArchived: false };

/** Anything unreadable falls back to the default. */
export function readMissionRailDisplay(raw: unknown): MissionRailDisplay {
  const entry = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const flag = (key: keyof MissionRailDisplay): boolean =>
    typeof entry[key] === 'boolean' ? entry[key] : DEFAULT_MISSION_RAIL_DISPLAY[key];
  return {
    showAvatar: flag('showAvatar'),
    mineOnly: flag('mineOnly'),
    groupByOrchestrator: flag('groupByOrchestrator'),
    expandSubagents: flag('expandSubagents'),
    includeArchived: flag('includeArchived'),
  };
}

export function writeMissionRailDisplay(next: MissionRailDisplay): { v: 1 } & MissionRailDisplay {
  return {
    v: 1,
    showAvatar: next.showAvatar,
    mineOnly: next.mineOnly,
    groupByOrchestrator: next.groupByOrchestrator,
    expandSubagents: next.expandSubagents,
    includeArchived: next.includeArchived,
  };
}

/** True when a setting of the widget differs from the default: the filter button wears a dot. */
export function missionRailDisplayChanged(display: MissionRailDisplay): boolean {
  return (Object.keys(DEFAULT_MISSION_RAIL_DISPLAY) as (keyof MissionRailDisplay)[])
    .some((key) => display[key] !== DEFAULT_MISSION_RAIL_DISPLAY[key]);
}
