---
title: Kinds
sidebar_position: 4
---

`kind` tells Timon what a plugin is; slots tell it where that plugin inserts components. These must agree.

| Kind | Surface |
| --- | --- |
| `widget` | At least one slot ending in `.widget` |
| `page` | `page`, with a declared `route` |
| `island` | Exact `island.content` slot; a [workspace tab or split](island.md) (API 8) |
| `overlay` | Exact `overlay` slot, inside the app window |
| `theme` | Single `theme` slot |
| `composer` | Single `chat.composer` slot |
| `layout` | Single `root` slot; needs a licence that includes White Label |
| `behavior` | Effects or settings without a required visual kind |
| `provider` | Brings an AI provider (`backends:register`); declares the programs it launches in `provider.binaries`. No slot |
| `dictation` | Exact `dictation.engine` slot; a [speech-to-text engine](dictation.md) that says where the voice goes (`dictation:engine`, API 14) |
| `bundle` | Installs `contains`; no browser half |

A string is shorthand for a one-element list. A plugin can declare `['widget', 'overlay']` and register both surfaces in the same `apply`. They remain **one identity**. `plugin-hello` likewise registers navigation and a widget without becoming a bundle.

A bundle is exclusive: it cannot combine `bundle` with another kind or include a browser half. Only bundles may declare nonempty `contains`. Each child keeps its own identity and independent toggle.

## Layouts and White Label

A `layout` replaces the whole interface: navigation, top bar, rails and logo. It runs only under a licence that includes White Label. Without it, the plugin installs and stays listed, but `timon plugin list` shows it as `skipped:unlicensed`, **Plugins** says it needs a licence that includes White Label, and the standard interface stays. When the licence gains or loses White Label, the layout comes back or goes away on its own; the layout you chose in **Settings › Interface › Appearance** is kept. Themes, pages, widgets, overlays and every other kind stay open on Free.

Only a `layout` may name `root`: a manifest that declares `root` in `client.slots` with another kind is refused (`` `client.slots` names `root` but `kind` is not `layout` ``).

A missing kind is inferred from recognised slots. A plugin with no recognised visual kind becomes `behavior`; there is no separate `settings` kind. Declare settings fields or exact settings slots instead.

`island` requires `client.slots` to contain `island.content` exactly; a widget
zone cannot substitute for it. When `kind` is omitted, that slot infers `island`.
For a plugin with both a card and island content, declare
`"kind": ["widget", "island"]` and both slots. Use `apiVersion: 8` for the
island client helpers; see the [complete template](island.md).

A `provider` plugin needs the `backends:register` permission and may list, in `provider.binaries`, the bare names (never paths) of the programs it launches. See [Write a provider](providers.md#declare-the-programs-a-provider-launches).

A `dictation` plugin needs `apiVersion: 14`, the `dictation:engine` permission and a `dictation` block that lists its engines and where each sends the voice. The `dictation.engine` slot and the `dictation` block are refused under any other kind. See [Write a dictation engine](dictation.md).
