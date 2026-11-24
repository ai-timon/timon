---
title: Widget
sidebar_position: 6
---

Declare `kind: "widget"` and a slot ending in `.widget`, then register the body component. The host supplies the frame, drag handle, remove control and resizing.

## Registration metadata

| `widget` option | Meaning |
| --- | --- |
| `title` | Header, palette and drag-preview title |
| `zone` | Preferred initial placement zone |
| `height` | Initial fixed height in pixels |
| `minHeight` | Resize floor |
| `heightMode` | `fixed` or `fill` |
| `frame` | `tile` by default; `none` when the plugin supplies its own frame |
| `bar` | The widget also has a compact form: it may sit on the top bar's line (`topbar.widget`) and paints that form in the sidebars |
| `placedByDefault` | Placed in `zone` on every page that has not placed or removed it yet, instead of waiting in the palette |
| `formerKeys` | Keys the widget was registered under before (`''` for a keyless registration): a saved place is handed down |
| `tabTitle` | Short name on the widget's tab when it is stacked (« PR » for « Pull requests »); the tooltip keeps `title` (API 19) |
| `liveCount` | Kept mounted, hidden, behind the stack's front tab, so the count or dot it publishes stays true (API 19) |

Without metadata, the title falls back to the registration key or plugin ID, the default height is 260px and the default cockpit placement is the left rail. The existing cockpit zone IDs are `gauche` and `droite`; they are placement identifiers, not translated UI text.

These defaults apply only on first placement. The user's saved layout takes precedence afterward. A preferred zone that is not mounted can leave the card waiting for that zone.

## Multiple instances

Placement is identified by **plugin ID plus registration key**. Give each instance a stable, distinct key. Do not derive it from a mutable label or agent name. To change a registration title, dispose and re-register under the same key; its placement remains associated with that key.

If instance configuration arrives asynchronously, clean up its subscription when the plugin unloads. Otherwise a disabled plugin can accidentally register its cards again.

## In a stack of tabs

The user can stack widgets into one card with a tab each, like the chat's **Git** stack. Your tab can say more than your title, through four hooks of the [UI kit](ui-kit.md) (manifest `"apiVersion": 19`):

- `useWidgetCount(n)` puts a number on your tab (« Issues 2 »); `null` or 0 shows none. It returns whether the tab shows it: when it does not (a card on its own), paint the number next to your own title.
- `useWidgetAttention(label)` puts a dot on your tab while something in your widget waits for the person; `label` (« 2 to approve ») is said in the tab's tooltip and to a screen reader, `null` clears it.
- `useWidgetMenu(items)` moves header actions (`{ key, label, icon?, onSelect }`) into the widget's menu, the gear or a right click on the tabs: at 300px the tab strip has no room left. It returns whether it did; when it did not, keep them in your header.
- `useWidgetInFront()` tells whether your widget is in view.

Without `liveCount`, a stacked widget is painted only while its tab is in front, and its count leaves with it. With `liveCount`, it stays mounted behind the front tab: keep it cheap there. Read `useWidgetInFront()` and wait for it before a costly read, or reuse what you read less than a minute ago; read again when your tab comes forward.

```js
import { Tile, useWidgetCount, useWidgetMenu } from '@timon/ui'

const left = issues ? issues.length : null
const onTab = useWidgetCount(left)
const inMenu = useWidgetMenu([{ key: 'refresh', label: 'Refresh', onSelect: reload }])
return h(Tile, { title: 'Issues', subtitle: onTab ? undefined : left, actions: inMenu ? handle : h(React.Fragment, null, refreshButton, handle), className }, rows)
```

## In the chat's columns

A widget placed in a chat column (`chat.left.widget`, `chat.right.widget`) does not get a fixed width: the user resizes each column, from 240 to 800px, and can open a second column per side. Lay the body out for any width in that range — no fixed pixel width, let rows wrap or truncate. A second column, like a column tab, is a zone of its own (`chat.right.widget#…`) governed by its column's slot: register in the column's slot as usual, never under a tab's zone ID, which belongs to one user's layout.

## On the top bar

The right side of the top bar is a widget zone laid out as one line, `topbar.widget`, 36px tall. It only admits widgets registered with `bar: true`; any other card is refused there before the drop. Register in `cockpit.widget` as usual, set `zone: 'topbar.widget'` to make the top bar its first place, and `placedByDefault: true` only if the surface was already on screen before it became a widget.

The middle of the top bar, between the logo and the controls, is a second line zone, `topbar.center.widget`, with the same rule. It is where the Working agents widget starts; on a phone it is a row of its own under the menu bar. A widget there may be narrower than its content: give its root `min-width: 0` and let it scroll sideways rather than push the controls away.

## Compact zones

Every widget receives `orientation`: `horizontal` on the top bar's line, `vertical` in a column. A widget registered with `bar: true` also receives `compact: true` where it must paint its compact form instead of its card:

| Zone | Shape | A `bar` widget paints |
| --- | --- | --- |
| Top bar (`topbar.widget`, `topbar.center.widget`) | horizontal | its compact form, side by side |
| Side navigation and right sidebar (`sidebar.left.widget`, `sidebar.right.widget`) | vertical, compact | its compact form, stacked |
| Cockpit, chat columns, agents rails | vertical | its card |

The rule is the zone's, never the widget's width: the side navigation widens on hover, and a widget must not change form under the pointer. A widget without `bar` keeps its card everywhere it is admitted, sidebars included; a widget in a stack of tabs keeps its card too. The shape is not painted as a label: read it from `orientation` and `compact`.

The compact form is icons and badges only. Its detail opens on click with `AnchoredPopover` from the [UI kit](ui-kit.md) (manifest `"apiVersion": 6`): `placement: 'below'` on the line, `'beside'` in a column. The popover keeps itself inside the window. Use `frame: 'none'` so the component chooses between the forms; a `tile` widget is painted without its frame in a compact zone. The host gives the compact form no height, no resize, no style menu and no tab stacking: only the grip and the gear (settings menu, whose last item deletes the widget), passed in `handle` while editing, laid out after it in the zone's direction.

```js
ctx.slots.register(
  { slot: 'cockpit.widget', key: 'status', widget: { title: 'Status', zone: 'topbar.widget', frame: 'none', bar: true } },
  ({ orientation, compact, handle, className }) => compact
    ? h(React.Fragment, null, h(StatusButton, { placement: orientation === 'horizontal' ? 'below' : 'beside' }), handle)
    : h(Tile, { title: 'Status', actions: handle, className }, h(StatusDetails)),
)
```

`topbar.item` still exists for a plain control that should never move.

## Naming your widget

`widget.title` is the card's title. Add `widget.description`: one sentence, shown under the name in the widget window, saying what the widget shows or lets the user do. Name it for what it does, precisely enough that two widgets of yours never read alike. When the title is the user's own (one card per agent), set `widget.catalogTitle` to what the window should call it (« Agent chat »). Give it a picto with `widget.icon`: SVG markup (`<svg …>`) or the URL of an SVG, drawn on its card in the widget window in the theme's text colour — only the shape counts, so a single-colour 24×24 line drawing reads best.

## Supplying your own frame

Choose `frame: 'none'` only when the header needs custom content. The host passes `handle` (layout controls), `className` (including height classes) and optional `editing`. Forward `className` to the root and propagate the host's full-height class for a fill-mode widget. In layout editing the host draws the card's own controls — a grip at the left and a gear at the right, in a strip above your header — and makes the body inert so the whole card can be grabbed: `handle` is then empty on a card, and only filled on a compact form. Keep rendering it in your header's actions anyway, and keep your own actions (filters, an Add button) there: they never share a row with the layout controls. A right click on the card in layout editing, or on a stack's tab at any time, opens the same menu as the gear.

`handle` is given from manifest `"apiVersion": 17`. A widget written for an earlier version reads the same controls as `poignee`: the host still passes it, and the SDK keeps it as a deprecated alias.

Do not create another drag context or duplicate the host's palette. The [UI kit](ui-kit.md) provides `Tile` for a custom frame. The supplied `plugin-widget` is the simplest starting point.
