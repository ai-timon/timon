/**
 * What the Agents graph draws inside an agent's node, by the same rule as
 * `AgentAvatar` (`agentIdentity`, docs/AGENT-AVATAR.md): the picked head first,
 * then the historical order. The graph is D3, not React, so it cannot mount
 * `AgentAvatar`; it reads the resolution here and paints it its own way.
 */
import { agentIdentity, glyphOf, showsMascot, type AgentIdentitySource } from '@/components/agent-avatar';
import type { AgentLook } from '@/components/mascot/agent-look';

export type GraphFace = {
  /** Picture drawn clipped in the disc. */
  iconUrl: string | null;
  /** The mascot, painted over the disc. */
  look: AgentLook | null;
  /** Text inside the disc (emoji, project glyph); `null`: the node's own initials. */
  glyph: string | null;
};

export function graphNodeFace(
  agent: AgentIdentitySource,
  project: { color?: string | null; icon?: string | null } | null | undefined,
): GraphFace {
  const identity = agentIdentity(agent, project);
  if (showsMascot(identity)) return { iconUrl: null, look: identity.look ?? null, glyph: null };
  if (identity.iconUrl) return { iconUrl: identity.iconUrl, look: null, glyph: null };
  // The bare initial `agentIdentity` falls back to: the graph writes its own
  // two-letter initials instead, from the caption.
  const initial = glyphOf(agent.name);
  return { iconUrl: null, look: null, glyph: identity.fallback === initial ? null : identity.fallback };
}
