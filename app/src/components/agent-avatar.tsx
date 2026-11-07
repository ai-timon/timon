'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { paletteFor } from '@/components/chat/chat-format';
import type { ProjectMeta } from '@/hooks/use-project-meta';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { agentRoleKey, resolveRole } from '@/lib/roles';
import { cn } from '@/lib/utils';
import { accentVars } from '@/lib/accent-color';
import { STATE_VISUALS, type ActiveState } from '@/lib/agent-state';
import { chatSenderName } from '@/lib/main-agent';
import { LiveAgentMascot } from '@/components/mascot/live-agent-mascot';
import { defaultLookFor, normalizeAgentLook, type AgentLook } from '@/components/mascot/agent-look';

/**
 * Visual identity of an agent, shared outside the chat.
 *
 * The rules below are the ones `chat-client.tsx` applies to its bubbles
 * (accent colour, logo, initial fallback, role sub-badge). They live here so
 * the inbox shows the same face for the same agent; the chat still carries
 * its own copy until its own refactor imports this module.
 */

export type AgentIdentitySource = {
  name: string;
  role?: string | null;
  project?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look (`config.look`), drawn when the agent has no picture. Any value: checked field by field. */
  look?: unknown;
  /** Which head the agent shows (`config.avatar`): `emoji`, `image`, `mascot`; absent or unknown = the historical order. */
  avatar?: unknown;
  /** Flagged by the daemon on the agent it addresses its recaps to. */
  main?: boolean;
  /** Read by the New mission picker (`lib/new-mission-agents.ts`). */
  orchestrator?: boolean;
  ephemeral?: boolean;
};

export type AgentIdentity = {
  name: string;
  /** Accent colour: agent config, else project colour, else hashed palette. */
  accent: string;
  iconUrl: string | null;
  fallback: string;
  roleKey: string | null;
  /** False for pseudo senders the daemon uses (`orchestrator`, `cockpit`…). */
  known: boolean;
  /** The agent's mascot, shown instead of the initial when there is no picture. */
  look?: AgentLook | null;
  /** What a part of `look` whose mascot pack is not here draws instead: its role's default. */
  lookBase?: AgentLook;
};

/** The heads an agent can pick (`config.avatar`), same list as the daemon's `AGENT_AVATAR_MODES`. */
export const AGENT_AVATAR_MODES = ['emoji', 'image', 'mascot'] as const;
export type AgentAvatarMode = typeof AGENT_AVATAR_MODES[number];

/** The mode an agent row carries; a value a newer daemon knows and this app does not reads as none. */
export function avatarModeOf(value: unknown): AgentAvatarMode | null {
  return (AGENT_AVATAR_MODES as readonly unknown[]).includes(value) ? value as AgentAvatarMode : null;
}

/**
 * The look an agent row carries, or null: a field that fails the check falls
 * back to its role's default. A mascot pack's part is kept even before (or
 * after) its pack is here: the row is often read before the plugins load, and
 * the editor sends it back whole — dropping it would overwrite the agent's
 * part. The drawing falls back to the role's default while the pack is away.
 */
export function lookOfAgent(agent: Pick<AgentIdentitySource, 'look' | 'role'>): AgentLook | null {
  if (typeof agent.look !== 'object' || agent.look === null) return null;
  return normalizeAgentLook(agent.look, defaultLookFor(agent.role ?? ''), { keepPackIds: true });
}

export function isHttpUrl(s: string | null | undefined): s is string {
  // http(s) OR a relative path served by TIMON (uploaded icon `/api/uploads/...`).
  return !!s && (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('/'));
}

/**
 * Same derivation as the chat header: config wins, project fills in, name
 * hashes last. A picked head (`avatar`) is shown whatever else the agent has —
 * the mascot over a picture or a project logo — as long as its own setting
 * exists; otherwise, and without a pick, the historical order: picture,
 * project logo, mascot, emoji (or the project's emoji), initial. That order
 * is what keeps the existing agents' faces (docs/AGENT-AVATAR.md).
 */
export function agentIdentity(
  agent: AgentIdentitySource,
  project: Partial<ProjectMeta> | null | undefined,
): AgentIdentity {
  const projectIcon = project?.icon ?? null;
  const projectColor = project?.color ?? null;
  const accent = agent.color || projectColor || paletteFor(agent.name);
  const look = lookOfAgent(agent);
  const emoji = agent.emoji?.trim() || null;
  const base = { name: agent.name, accent, roleKey: agentRoleKey(agent.role), known: true, ...(look ? { lookBase: defaultLookFor(agent.role ?? '') } : {}) };
  const mode = avatarModeOf(agent.avatar);
  if (mode === 'mascot' && look) return { ...base, iconUrl: null, fallback: emoji || glyphOf(agent.name), look };
  if (mode === 'emoji' && emoji) return { ...base, iconUrl: null, fallback: emoji, look: null };
  if (mode === 'image' && isHttpUrl(agent.icon_url)) return { ...base, iconUrl: agent.icon_url, fallback: emoji || glyphOf(agent.name), look: null };
  const iconUrl = isHttpUrl(agent.icon_url) ? agent.icon_url : (isHttpUrl(projectIcon) ? projectIcon : null);
  const fallback = (projectIcon && !isHttpUrl(projectIcon) ? projectIcon : null) || agent.emoji || glyphOf(agent.name);
  return { ...base, iconUrl, fallback, look };
}

/**
 * The letter a head without a picture shows: the first letter or digit of the
 * name. `_main`, the main agent every install has, showed a bare underscore.
 */
export function glyphOf(name: string): string {
  return (name.match(/[\p{L}\p{N}]/u)?.[0] ?? name.charAt(0)).toLowerCase() || '?';
}

/** True when the identity's head is its mascot: no picture, and a look. */
export function showsMascot(identity: Pick<AgentIdentity, 'iconUrl' | 'look'>): boolean {
  return !isHttpUrl(identity.iconUrl) && !!identity.look;
}

/**
 * The inside of a round avatar, from an identity: the mascot when the agent's
 * head is one, else its picture, else its glyph. The frame (size, border,
 * ring) is the caller's, as for `FaceAgent`: the Multichat cell and rail do
 * not draw it the way `AgentAvatar` does. A caller that frames a mascot in a
 * clipped disc should drop the frame when `showsMascot(identity)`.
 */
export function AgentHead({ identity, px, glyphClassName, glyphStyle, live = true }: {
  identity: AgentIdentity;
  /** Edge of the caller's frame, in CSS pixels. */
  px: number;
  glyphClassName?: string;
  glyphStyle?: CSSProperties;
  /** `false`: the mascot's bare look, still, without the agent's live state. */
  live?: boolean;
}) {
  if (showsMascot(identity) && identity.look) {
    return (
      <span aria-hidden className="grid size-full place-items-center [&_svg]:size-full" data-agent-mascot>
        <LiveAgentMascot name={identity.name} look={identity.look} size={px} live={live && identity.known} className="size-full" />
      </span>
    );
  }
  if (isHttpUrl(identity.iconUrl)) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={identity.iconUrl} alt="" className="size-full object-cover" />;
  }
  return <span className={glyphClassName} style={glyphStyle}>{identity.fallback}</span>;
}

/** Identity for a sender that is not a configured agent (daemon pseudo names). */
export function pseudoIdentity(name: string): AgentIdentity {
  return {
    name,
    accent: paletteFor(name),
    iconUrl: null,
    fallback: glyphOf(name),
    roleKey: null,
    known: false,
  };
}

/**
 * Resolver `name → identity` backed by one fetch of `/api/ui/agents` and the
 * shared project table. Unknown names still get a stable colour so a
 * `orchestrator-wake` sender is recognisable across rows.
 */
export function useAgentIdentities(opts: { daemonAsMain?: boolean } = {}): {
  agents: AgentIdentitySource[];
  identityOf: (name: string) => AgentIdentity;
} {
  const [agents, setAgents] = useState<AgentIdentitySource[]>([]);
  const projects = useProjectMeta();

  useEffect(() => {
    let off = false;
    fetch('/api/ui/agents', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { agents: [] }))
      .then((j: { agents?: AgentIdentitySource[] }) => {
        if (!off) setAgents(j.agents ?? []);
      })
      .catch(() => {});
    return () => { off = true; };
  }, []);

  const identityOf = useMemo(() => {
    const byName = new Map<string, AgentIdentity>();
    for (const a of agents) {
      byName.set(a.name, agentIdentity(a, a.project ? projects.get(a.project) ?? null : null));
    }
    // Chat only: the Inbox keeps `orchestrator` for what the daemon says to the
    // human, the chat names the agent that actually receives the recaps.
    const daemonAsMain = opts.daemonAsMain === true;
    return (name: string) => {
      const shown = daemonAsMain ? chatSenderName(name, agents) : name;
      return byName.get(shown) ?? pseudoIdentity(shown);
    };
  }, [agents, projects, opts.daemonAsMain]);

  return { agents, identityOf };
}

const SIZE = {
  sm: { disc: 'size-6 text-[10px]', badge: 'size-3', icon: 'size-2', px: 24 },
  md: { disc: 'size-[34px] text-[13px]', badge: 'size-4', icon: 'size-2.5', px: 34 },
  lg: { disc: 'size-12 text-[17px]', badge: 'size-4', icon: 'size-2.5', px: 48 },
  xl: { disc: 'size-[72px] text-[26px]', badge: 'size-5', icon: 'size-3', px: 72 },
} as const;

/** Round avatar shared by all agent bubbles: colored round disc, project/
 *  agent logo image if available else initial/emoji, + role badge. */
export function AgentAvatar({ identity, size = 'md', className, roleBadge = true, live = true }: {
  identity: AgentIdentity;
  size?: keyof typeof SIZE;
  className?: string;
  /** Off where the role is written beside the avatar and the corner carries another mark. */
  roleBadge?: boolean;
  /** A mascot shows what the agent does (docs/AGENT-MASCOT.md); `false`: its bare look, still — menus, very long lists. */
  live?: boolean;
}) {
  const { accent: color, iconUrl, fallback, roleKey, look, lookBase } = identity;
  // Tiny role sub-badge bottom-right. Skip `main` (orchestrator) — the
  // avatar disc already carries project identity; a Network glyph here is noise.
  const roleVisual = roleBadge && roleKey && roleKey !== 'main' ? resolveRole(roleKey) : null;
  const RoleIcon = roleVisual?.icon ?? null;
  const s = SIZE[size];
  return (
    <div className={cn('relative shrink-0', s.disc.split(' ')[0], className)}>
      {/* Soft project-tinted disc, same tint as ProjectBadge and published the
          same way — two variants, CSS picks the readable one per theme.
          The logo fills the disc (`object-cover`, no padding): logos are
          framed at upload time, so a square picture in a round bubble is now
          the uploader's own crop rather than a letterboxed thumbnail. */}
      {/* No picture but a look: the agent's mascot, through the `agent.mascot`
          slot so a plugin that replaces the mascot replaces it here too, and
          alive with what the agent is doing. */}
      {!isHttpUrl(iconUrl) && look ? (
        <div className={cn('grid place-items-center', s.disc)} data-agent-mascot>
          <LiveAgentMascot name={identity.name} look={look} base={lookBase} size={s.px} live={live && identity.known} />
        </div>
      ) : (
        <div
          className={cn('grid place-items-center overflow-hidden rounded-[var(--avatar-radius)] border font-semibold bg-[var(--accent-soft)] border-[var(--accent-border)] text-[var(--accent)] dark:bg-[var(--accent-soft-dark)] dark:border-[var(--accent-border-dark)] dark:text-[var(--accent-dark)]', s.disc)}
          style={accentVars(color)}
        >
          {isHttpUrl(iconUrl) ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={iconUrl} alt="" className="size-full object-cover" />
          ) : (
            <span>{fallback}</span>
          )}
        </div>
      )}
      {RoleIcon && roleVisual && (
        <span
          className={cn('absolute -bottom-1 -right-1 grid place-items-center rounded-full ring-2 ring-background', s.badge)}
          style={{ background: roleVisual.color }}
        >
          <RoleIcon className={cn('text-white', s.icon)} />
        </span>
      )}
    </div>
  );
}

/**
 * The agent's face, with its state AROUND it: a thin ring in the state's
 * colour, and while it works (thinking, needs you) a pulse expanding from that
 * ring. Under `prefers-reduced-motion` the pulse is not painted; the ring and
 * the state word still say it. A mascot wears no static ring — its face
 * already shows the state, and a circle around it read as a frame — but keeps
 * the pulse while it works.
 */
export function ActiveAgentAvatar({ identity, state, size, className, label, live }: {
  identity: AgentIdentity;
  state: ActiveState;
  size?: keyof typeof SIZE;
  className?: string;
  live?: boolean;
  /** Names the state for assistive tech where no word beside the face says it. */
  label?: string;
}) {
  const vis = STATE_VISUALS[state];
  const mascot = showsMascot(identity);
  return (
    <span
      className="relative inline-grid shrink-0 place-items-center"
      data-chip-avatar
      data-state={state}
      role={label ? 'img' : undefined}
      aria-label={label}
    >
      {state !== 'idle' && !mascot && (
        <span
          aria-hidden
          data-chip-ring
          className="pointer-events-none absolute -inset-[2px] rounded-[var(--avatar-radius)]"
          style={{ boxShadow: `0 0 0 1.5px ${vis.colorVar}` }}
        />
      )}
      {vis.pulse && (
        <span
          aria-hidden
          data-chip-pulse
          className="pointer-events-none absolute -inset-[2px] rounded-[var(--avatar-radius)] opacity-70 motion-safe:animate-[ping_1.6s_ease-out_infinite] motion-reduce:hidden"
          style={{ border: `1.5px solid ${vis.colorVar}` }}
        />
      )}
      {/* Above the ring and the pulse, so the role badge is never painted over. */}
      <span className="relative z-10 inline-grid">
        <AgentAvatar identity={identity} size={size} className={className} live={live} />
      </span>
    </span>
  );
}
