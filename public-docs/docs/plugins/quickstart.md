---
title: Your first plugin
sidebar_position: 2
---

:::tip Let an agent do it
Timon ships a skill named `create-timon-plugin`. Type `/create-timon-plugin` followed by what you want (for example `/create-timon-plugin a card that shows the weather in Lyon`) in any chat, or attach the skill to an agent from the Skills page. The agent follows the steps of this page and the guides it links, asks you before installing, and checks with `timon plugin list` that the plugin is active. Everything it does is what this page describes by hand.
:::

Use the supplied `examples/plugin-widget` as your first plugin. It has no host half, no requested permissions and no build step: the browser entry is already JavaScript.

## Prepare

Copy that directory to your own plugin directory. Read `package.json` and `lib/client.js`. Change the npm package name to your own scope, set a unique valid manifest ID and update its label and description. Preserve the ESM package type and the `./client` export.

The client imports React from the platform and returns the disposer from `ctx.slots.register`. Keep React external if you later add a bundler.

## Install and inspect

:::warning Timon 0.1.7 and earlier
In Timon 0.1.7 and earlier, a Free installation installs an unsigned plugin but does not load it, whatever the value of `developer.unsignedPlugins`. Loading it on Free needs a later version; until you have one, an unsigned plugin loads only on an installation where a licence key is activated.
:::

Turn on developer mode first, as explained in [Testing](testing.md): your plugin is unsigned, and an unsigned plugin loads only in developer mode, on Free as on a paid licence. Then run:

```bash
timon plugin add ./my-plugin
timon plugin list
```

Inspect the installation confirmation. Open the cockpit and look for the card. Move it, reload the page and confirm its placement survives. Disable the plugin and confirm the card disappears; enable it and confirm it returns.

```bash
timon plugin disable acme-weather
timon plugin enable acme-weather
```

Replace `acme-weather` with your manifest ID. If it is refused, read the reported reason before retrying. See the [widget guide](widget.md) for sizing and multiple instances, and the example catalogue for the full source.

Continue with the [example cookbook](examples.md) for verified source excerpts from all eleven packages. Write it shippable from the first line: [Ship to someone else](distribution.md) lists the rules.
