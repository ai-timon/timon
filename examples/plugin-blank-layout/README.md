# plugin-blank-layout

Template of a `root` layout: the smallest package that replaces Timon's whole
chrome. Guide: [Kinds](../../public-docs/docs/plugins/kinds.md).

The product layout occupies the `root` slot as a fallback. This package takes
the slot and renders only the page the router chose: no navigation, no top
bar, no rails. Nothing else is drawn, so every region the product layout owns
(widget zones, sidebars, the browser pane) disappears with it.

`page` is keyed by route. A layout renders the reserved key `next-router`
through `SlotKeyed`, never the whole `page` slot: that would stack every
plugin page on top of each other.

No host half, no permission, no build: `client.js` is already ESM, and
`react` and `@timon/ui` stay external, provided by the platform.

## Licence

Replacing the whole interface needs a licence that includes White Label. Without
it the package installs, `timon plugin list` shows it as `skipped:unlicensed`,
and the standard interface stays. To try it, activate such a licence on the test
instance below.

## Try it

Try it on a separate test instance, never on the one you work in:

```bash
timon plugin add ./examples/plugin-blank-layout
# reload the window: only the current page is left
timon plugin remove blank-layout      # the product layout comes back
```

Keep a terminal open while it is installed: with the chrome gone, the
command line is how you take it out again.
