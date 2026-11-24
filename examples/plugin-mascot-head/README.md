# plugin-mascot-head

A **mascot pack whose part is a head the plugin draws itself**: an ember, a
flame in the agent's colour whose eyes follow its state. It shows in the skull
grid of the mascot configurator (the onboarding's « Customise » panel and the
Avatar tab of the agent editor), in its own group under the pack's name, and a
random look may draw it. Client API 15.

Only the agents that wear the ember are drawn by this plugin: every other
agent stays Timon's mascot, in the person's 2D or 3D style, and several packs
can each add their own heads side by side. A plugin that takes the
`agent.mascot` slot still replaces every mascot, the ember included.

Two halves say the same id:

- `package.json`, `timon.mascot.shape`: the slug `ember`. The daemon accepts
  `example-mascot-head:ember` as an agent's skull while the plugin is enabled.
- `lib/client.js`: registers the part in the `mascot.parts` slot,
  `ctx.slots.register({ slot: 'mascot.parts', key: 'ember', mascotPart: { type: 'shape', label, head } })`,
  with a `head` component instead of the four `skull` numbers.

The component takes no props: it reads `useAgentMascot()` from `@timon/ui` —
`look`, `fur`, `size`, `live`, `state`, `fit`, `shadow`, `label`,
`reducedMotion` — exactly like an `agent.mascot` occupant. It paints a square of
`size` pixels as an `<svg>` (a `<canvas>` works too: the onboarding's welcome
copies either into its scene), animates only when `live`, and names the image
with `label`.

If the head throws, Timon draws its own head for that agent and the page goes
on. Remove the plugin: an agent that wore the ember shows its role's default
skull until the pack is back.

Guide: [Create a mascot pack](../../public-docs/docs/plugins/mascot-pack.md#draw-a-head-yourself).

The package deliberately ships no `SIGNATURE` file.
