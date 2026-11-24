import React from 'react'
import { useAgentMascot } from '@timon/ui'

/**
 * A mascot pack whose part is a head the plugin draws itself: an ember, a
 * flame in the agent's colour with two eyes that follow its state.
 *
 * Two halves say the same id, as for every pack part:
 *   - the manifest (`timon.mascot.shape` in package.json) declares the slug,
 *     so the daemon accepts `example-mascot-head:ember` as an agent's skull;
 *   - this browser half registers the part in the `mascot.parts` slot with a
 *     `head` component instead of the four `skull` numbers.
 *
 * Only the agents whose look wears the ember are drawn by this component;
 * every other agent stays Timon's, and several such packs live side by side.
 * The component takes no props: it reads `useAgentMascot()`, like an
 * `agent.mascot` occupant. What it must respect:
 *   - paint a square of `size` pixels, as an <svg> or a <canvas> (the
 *     onboarding's welcome copies one of those into its scene);
 *   - no animation unless `live` (already false under reduced motion);
 *   - `label` names the image, `null` means decorative (`aria-hidden`).
 *
 * If it throws, Timon draws its own head for that agent. Remove the plugin:
 * the agent shows its role's default skull until the pack is back.
 */

// The eyes of a few states; any other state, or none, keeps them open.
const STATE_EYES = {
  sleeping: 'closed', sad: 'closed', done: 'happy', happy: 'happy', celebrate: 'happy', love: 'happy',
  error: 'cross', surprised: 'wide', listening: 'wide',
}
const FLAME = 'M50 6 C 62 24, 84 34, 84 62 C 84 82, 68 94, 50 94 C 32 94, 16 82, 16 62 C 16 46, 26 38, 32 26 C 36 38, 42 40, 44 40 C 42 28, 44 16, 50 6 Z'

function eye(kind, x) {
  const e = React.createElement
  if (kind === 'closed') return e('path', { key: x, d: `M${x - 5} 62 Q ${x} 66, ${x + 5} 62`, stroke: '#2a1405', strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' })
  if (kind === 'happy') return e('path', { key: x, d: `M${x - 5} 64 Q ${x} 57, ${x + 5} 64`, stroke: '#2a1405', strokeWidth: 2.4, fill: 'none', strokeLinecap: 'round' })
  if (kind === 'cross') return e('path', { key: x, d: `M${x - 4} 58 L ${x + 4} 66 M ${x + 4} 58 L ${x - 4} 66`, stroke: '#2a1405', strokeWidth: 2.4, strokeLinecap: 'round' })
  return e('ellipse', { key: x, cx: x, cy: 62, rx: kind === 'wide' ? 4.5 : 3.5, ry: kind === 'wide' ? 6 : 5, fill: '#2a1405' })
}

function EmberHead() {
  const m = useAgentMascot()
  if (!m) return null
  const e = React.createElement
  const kind = STATE_EYES[m.state] || 'open'
  const a11y = m.label ? { role: 'img', 'aria-label': m.label } : { 'aria-hidden': true }
  return e('svg', { viewBox: '0 0 100 100', width: m.size, height: m.size, 'data-ember': m.state || 'still', ...a11y },
    m.shadow ? e('ellipse', { cx: 50, cy: 96, rx: 30, ry: 3, fill: '#000', opacity: 0.25 }) : null,
    // `fur`: the agent's colour as `#rrggbb`, a pack's fur included.
    e('path', { d: FLAME, fill: m.fur },
      // A flicker only for a live mascot: `live` is already false under reduced motion.
      m.live ? e('animateTransform', { attributeName: 'transform', type: 'scale', values: '1 1;1.02 0.98;1 1', dur: '1.2s', repeatCount: 'indefinite', additive: 'sum' }) : null),
    e('path', { d: 'M50 40 C 58 52, 68 58, 68 72 C 68 84, 60 90, 50 90 C 40 90, 32 84, 32 72 C 32 60, 44 54, 50 40 Z', fill: '#fff', opacity: 0.28 }),
    eye(kind, 40), eye(kind, 60))
}

export function apply(ctx) {
  return ctx.slots.register({
    slot: 'mascot.parts',
    key: 'ember',
    mascotPart: { type: 'shape', label: { en: 'Ember', fr: 'Braise' }, head: EmberHead },
  })
}
