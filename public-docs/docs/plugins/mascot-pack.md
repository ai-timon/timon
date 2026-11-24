---
title: Create a mascot pack
---

A mascot pack adds parts to the mascot configurator: skulls, furs, eyes and accessories that people can dress their agents with, beside Timon's own. Your parts show in their own group, under your plugin's name, in the **Customise** panel of the first-run agent step and in the **Avatar** tab of the agent editor. A random draw picks among them too.

A pack is mostly data: you describe each part, and Timon draws it. A skull is the exception you may take: your pack can [draw a whole head itself](#draw-a-head-yourself), for the agents that wear it. Requires `apiVersion: 15`. The complete template is `examples/plugin-mascot-pack`: a woolly hat, a scarf, a midnight fur and snowflake eyes; `examples/plugin-mascot-head` draws its own head, an ember.

## Two halves, the same ids

Each part has a **slug** (`beanie`, `midnight`): 1 to 40 characters among `a-z`, `0-9` and `-`, not starting with `-`. The id an agent's look stores is `<your plugin id>:<slug>`, for example `example-mascot-pack:beanie`. Two packs may use the same slug: the plugin id keeps them apart.

**The manifest** declares the slugs, by look field — `shape`, `color`, `eyes` or `acc` — up to 32 per field. It must also name the `mascot.parts` slot, where the browser half registers the drawings:

```json
{
  "timon": {
    "id": "example-mascot-pack",
    "apiVersion": 15,
    "kind": "behavior",
    "label": "Winter mascot pack",
    "client": { "slots": ["mascot.parts"], "external": [], "mode": "esm" },
    "mascot": {
      "acc": ["beanie", "scarf"],
      "color": ["midnight"],
      "eyes": ["snowflake"]
    }
  }
}
```

Timon accepts your ids in an agent's look while your plugin is installed and enabled, and refuses any id your manifest does not declare. A `mascot` block without the `mascot.parts` slot, or the slot without the block, is refused at install.

**The browser half** registers each part's drawing under the same slug, with no component:

```js
export function apply(ctx) {
  const off = [
    ctx.slots.register({ slot: 'mascot.parts', key: 'midnight', mascotPart: { type: 'color', label: 'Midnight', hex: '#2b3a67' } }),
    ctx.slots.register({ slot: 'mascot.parts', key: 'beanie', mascotPart: { type: 'acc', label: { en: 'Woolly hat', fr: 'Bonnet' }, svg: '…' } }),
  ]
  return () => { for (const dispose of off) dispose() }
}
```

A part that your manifest does not declare for that field, or whose data fails a check below, is refused when it registers: `register` throws with the reason.

## The parts

Every part has a `label`: one string, or one per language tag (`{ en: 'Scarf', fr: 'Écharpe' }`), up to 40 characters. Timon shows the reader's language, then its base language, then English.

| `type` | What you give | Rules |
|---|---|---|
| `shape` | `skull: { top, bottom, height, radius }`, or `head` ([below](#draw-a-head-yourself)) | Top width and bottom width 56 to 96, height 48 to 84, corner radius 4 to 40, in a 100 × 100 box where the head sits on y = 92. A skull is four numbers, not a free outline: Timon places the ears, the mask, the screen and the accessory from them, so every skull still looks like the mascot. |
| `color` | `hex: '#rrggbb'` | Blended into fur like Timon's dyed colours, so the head stays a plush. |
| `eyes` | `left`, and optionally `right`, `middle`, `blink` | Outlines of 3 to 128 `[x, y]` points centred on (0, 0), x and y within ±9 (the screen is 29 high). Without `right`, the left eye is mirrored. `middle` draws a glyph between the eyes. Your eyes morph into Timon's expressions and back when the agent's state changes. `blink: false` for drawn or closed eyes, which never blink. |
| `acc` | `svg`, and optionally `tilt` | SVG shapes drawn around (0, 0) in a box of about 32 × 32, without an `<svg>` root. `tilt` turns the tool in the paw, -90 to 90 degrees. |

## Draw a head yourself

A `shape` may carry a `head` component instead of the four `skull` numbers. An agent whose skull is that part (`<your plugin id>:<slug>`) is then drawn entirely by your component, everywhere its mascot shows: the configurator's preview and skull grid, avatars, the chat, the onboarding. Every other agent stays Timon's mascot, in the 2D or 3D style the person picked, so several packs can each add their own heads side by side. A shape has either `skull` or `head`, never both: `register` throws otherwise.

```js
import React from 'react'
import { useAgentMascot } from '@timon/ui'

function EmberHead() {
  const m = useAgentMascot()
  if (!m) return null
  const a11y = m.label ? { role: 'img', 'aria-label': m.label } : { 'aria-hidden': true }
  return React.createElement('svg', { viewBox: '0 0 100 100', width: m.size, height: m.size, ...a11y },
    React.createElement('circle', { cx: 50, cy: 54, r: 38, fill: m.fur }))
}

export function apply(ctx) {
  return ctx.slots.register({ slot: 'mascot.parts', key: 'ember', mascotPart: { type: 'shape', label: 'Ember', head: EmberHead } })
}
```

The manifest declares the slug under `mascot.shape` as for any skull, and lists `react` and `@timon/ui` in `client.external`, since this part is code. The component takes no props: `useAgentMascot()` returns the same value an [`agent.mascot`](slots.md#special-surfaces) replacement reads — the agent's `look` (its `eyes` and `acc` too, to draw them your way or not at all), `fur` (the colour to paint, as `#rrggbb`), `size`, `live`, `state`, `fit`, `shadow`, `label` and `reducedMotion`. Paint a square of `size` pixels as an `<svg>` or a `<canvas>`: the onboarding's welcome copies one of those into its falling crowd, and leaves out a head drawn with anything else. Never animate when `live` is `false`.

What Timon keeps:

- **A plugin that takes `agent.mascot` wins.** It replaces every mascot, your head included.
- **The configurator's eyes and accessory cells** show the eyes and the tool alone, drawn by Timon on its classic screen; the skull and fur cells show your head.
- **A head that throws** is replaced by Timon's head for that agent, on its role's default skull, and the rest of the page goes on. The error is logged in the browser console under your plugin's id.
- **When your plugin is removed**, an agent that wore your head shows its role's default skull until your pack is back.

A Timon release older than this feature refuses a shape without `skull`: there, `register` throws `a shape needs skull { top, bottom, height, radius }`. Wrap that call in `try` / `catch` if the rest of your pack should load anyway.

## What an accessory may draw

Timon draws your accessory inside every head that wears it, so it reads the markup with a strict whitelist and refuses anything else — it never trims a part to make it pass:

- elements: `g`, `path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`;
- attributes: geometry (`d`, `x`, `y`, `width`, `height`, `rx`, `ry`, `cx`, `cy`, `r`, `x1`…`y2`, `points`, `transform`) and presentation (`fill`, `stroke`, `opacity`, `fill-opacity`, `stroke-opacity`, `stroke-width`, `stroke-linecap`, `stroke-linejoin`, `stroke-dasharray`, `stroke-miterlimit`, `fill-rule`, `clip-rule`);
- values: numbers, path commands, colours (`#hex`, names, `rgb()`, `hsl()`) and transforms;
- comments are allowed; up to 16,384 characters, 200 elements, 12 levels of nesting.

Refused: text, `<script>`, `<style>`, `<image>`, `<use>`, `<a>`, `<foreignObject>`, animations, any `on…` handler, `style`, `class`, `id`, `href`, any `url(…)`, any scheme (`https:`, `javascript:`) and any entity. What is kept becomes drawing elements; your markup is never inserted in the page as HTML.

## When your plugin is removed

Your parts leave the configurator. An agent that wore one keeps its id stored, and shows its job's default for that part — the skull, fur, eyes or tool Timon gives an agent of that role — until your pack is back. Nothing else of its look changes. A head your pack drew is a skull like the others: the agent gets its role's default skull meanwhile.

## Test it

Install the template on a test instance, open an agent's **Avatar** tab and pick **Mascot**: the group **Winter mascot pack** shows under each grid it fills. Pick the scarf, save, then disable the plugin in the gallery: the agent shows its default tool, and gets the scarf back when you enable it again. See [Testing](testing.md) and the [example cookbook](examples.md#mascot-pack).

For a head you draw, install `examples/plugin-mascot-head`: **Ember head** shows under the skull grid. Pick it, save, and the agent's mascot is the ember everywhere; switch the mascot style between 2D and 3D and only the other agents change. Disable the plugin: the agent shows its role's skull. See the [cookbook entry](examples.md#mascot-head).
