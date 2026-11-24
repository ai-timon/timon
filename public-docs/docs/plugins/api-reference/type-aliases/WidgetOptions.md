
<!-- Generated file. Do not edit by hand. Run npm run gen:sdk. -->

# Type Alias: WidgetOptions

> **WidgetOptions** = `object`

Initial widget appearance; saved user placement takes precedence.

## Properties

### bar?

> `optional` **bar?**: `boolean`

The widget also has a compact form: admitted on the top bar's line
(`topbar.widget`), and painted compact there and in the sidebars
(`WidgetChromeProps.compact`).

***

### catalogTitle?

> `optional` **catalogTitle?**: `string`

What the widget window calls it when `title` is the user's own (one chat
card per agent): "Agent chat" rather than the agent's name.

***

### description?

> `optional` **description?**: `string`

One sentence on what the widget does, shown under its name in the widget
window: what it shows or lets you do, not how it is built.

***

### formerKeys?

> `optional` **formerKeys?**: readonly `string`[]

Keys this widget was registered under before; `''` names a keyless
registration. A place saved under one of them is handed down to the widget.

***

### frame?

> `optional` **frame?**: `"tile"` \| `"none"`

Use tile for host framing or none to render your own frame.

***

### height?

> `optional` **height?**: `number`

Initial fixed height in pixels before user resizing.

***

### heightMode?

> `optional` **heightMode?**: `"fixed"` \| `"fill"`

Fill the remaining zone height by default; users can choose a fixed size.

***

### icon?

> `optional` **icon?**: `string`

Picto on the widget's card in the widget window: SVG markup (`<svg …>`)
or the URL of an SVG. Painted as a mask in the theme's text colour, so
only its shape counts — a 24×24 line drawing reads best.

***

### liveCount?

> `optional` **liveCount?**: `boolean`

The widget publishes a count or a dot for its tab (`useWidgetCount`,
`useWidgetAttention` from `@timon/ui`): in a stack it stays mounted,
hidden, behind the tab in front, so its tab stays true. Keep it quiet
while hidden: read `useWidgetInFront()` before any costly call. Client API 19.

***

### minHeight?

> `optional` **minHeight?**: `number`

Minimum resize height in pixels.

***

### placedByDefault?

> `optional` **placedByDefault?**: `boolean`

Placed in `zone` on every view that has neither placed nor removed it yet,
instead of waiting in the palette. For a surface that was already on screen
before it became a widget.

***

### tabTitle?

> `optional` **tabTitle?**: `string`

Name on the widget's tab when it is stacked, where `title` would not fit
("PR" for "Pull requests"); the tab's tooltip keeps `title`. Client API 19.

***

### title?

> `optional` **title?**: `string`

Card title; defaults to the registration key or plugin ID.

***

### zone?

> `optional` **zone?**: `string`

Preferred first placement zone; absent zones remain pending.
