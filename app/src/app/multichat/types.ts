/** Multichat shared types. */

export type GridLayout = {
  cols: number;
  rows: number;
};

/** A slot in the grid. Empty when agentName is null. */
export type Slot = {
  agentName: string | null;
  missionId: string | null;
  /** Monotonic counter incremented when the user explicitly asks for a fresh
   *  chat in this slot (no mission yet). Disambiguates "waiting for mission
   *  pick" (missionId=null, no counter) from "start a new conversation now"
   *  (missionId=null, counter>0), and each increment forces ChatClient to
   *  remount when the user clicks "Nouvelle" again. */
  newConvKey?: number;
};

export const PRESETS: { label: string; cols: number; rows: number }[] = [
  { label: '1×2', cols: 2, rows: 1 },
  { label: '1×3', cols: 3, rows: 1 },
  { label: '2×2', cols: 2, rows: 2 },
  { label: '2×3', cols: 3, rows: 2 },
  { label: '3×2', cols: 2, rows: 3 },
  { label: '3×3', cols: 3, rows: 3 },
];

export const DEFAULT_LAYOUT: GridLayout = { cols: 2, rows: 2 };

export type AgentMeta = {
  name: string;
  project: string | null;
  icon_url: string | null;
  emoji: string | null;
  color: string | null;
  role: string | null;
  /** Team id (`config.team`); an agent can be in a team and a project. */
  team?: string | null;
  /** Mascot look and picked head (`config.look`, `config.avatar`), read by `agentIdentity`. */
  look?: unknown;
  avatar?: unknown;
};

export type ProjectMeta = {
  slug: string;
  name?: string;
  color?: string;
  icon?: string | null;
};

export type MissionSummary = {
  id: string;
  agent_name: string;
  status: string;
  started_at?: number;
  pending_action_at?: number | null;
  mission?: string;
  input?: string;
  /** Display name set by hand, by the launcher or generated (`lib/mission-title.ts`). */
  title?: string | null;
  task_title?: string | null;
};

/** Returns first non-empty value among agent.icon_url, project.icon (if URL). */
export function logoUrlFor(
  agent: { icon_url?: string | null } | null | undefined,
  project: { icon?: string | null } | undefined,
): string | null {
  const c = agent?.icon_url || project?.icon || null;
  if (!c) return null;
  return c.startsWith('http') || c.startsWith('/') ? c : null;
}

/** Returns a textual fallback when no URL logo exists. */
export function logoFallbackFor(
  agent: { name: string; emoji?: string | null } | null | undefined,
  project: { icon?: string | null } | undefined,
): string {
  if (project?.icon && !project.icon.startsWith('http') && !project.icon.startsWith('/')) {
    return project.icon;
  }
  if (agent?.emoji) return agent.emoji;
  // The first letter or digit: `_main`, every install's main agent, showed
  // a bare underscore (same rule as `glyphOf` in components/agent-avatar).
  const name = agent?.name ?? '';
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name.charAt(0)).toUpperCase() || '?';
}

/** Auto color hash for projects without explicit color (mirrors orchestrator
 *  side autoColorFor — keeps colors consistent if backend metadata missing). */
export function autoColorFor(slug: string | null | undefined): string {
  if (!slug) return '#737373';
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue}, 60%, 55%)`;
}
