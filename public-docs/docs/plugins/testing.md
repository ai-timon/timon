---
title: Testing
sidebar_position: 16
---

Test on a dedicated Timon instance and data directory. Set `TIMON_HOME` for every process in that instance, use separate ports and do not point examples at a production daemon by accident.

## Developer admission

An unsigned plugin, which includes any plugin you write yourself, loads only in **developer mode**. Turn it on in `timon.config.json`:

```json
{"developer": {"unsignedPlugins": true}}
```

This works the same on Free and on a paid licence. When the setting is absent or `false`, unsigned packages are installed but not loaded.

:::warning Timon 0.1.7 and earlier
In Timon 0.1.7 and earlier, a Free installation installs an unsigned plugin but does not load it, whatever the value of `developer.unsignedPlugins`. Loading it on Free needs a later version; until you have one, an unsigned plugin loads only on an installation where a licence key is activated.
:::

:::warning What developer mode does not open
A licence with a fixed plugin composition refuses unsigned plugins even with this setting. An altered package, whose `SIGNATURE` no longer matches its files, is always refused. A plugin with `license.required: true` must also be permitted by the licence.
:::

## Installation loop

```bash
timon plugin add ./my-plugin
timon plugin list
timon plugin verify YOUR_PLUGIN_ID
timon plugin disable YOUR_PLUGIN_ID
timon plugin enable YOUR_PLUGIN_ID
```

Installation accepts npm specifications, archives or local directories and runs npm with `--ignore-scripts`. Build the package before installing it. Inspect the permission confirmation even for a package with no requested permissions: in-process host code is still code execution.

### Editing a plugin while Timon runs

Timon watches the source files of every installed plugin. Save a change to any file of the host half — the entry or a file it imports, such as `lib/core.js` — and the plugin is remounted within a couple of seconds, with no daemon restart. A plugin linked from your working copy in developer mode is picked up the same way. Only files inside the plugin's own directory are reloaded; a file imported from outside it, or from `node_modules`, keeps its first version until the daemon restarts.

## Verify actual behaviour

- Install the package through the real loader and inspect its reported state.
- Exercise host routes with two different users; confirm caller scoping.
- Exercise missing permission, denied policy and absent-secret paths.
- Before sending the package, run the [pre-ship check](distribution.md#pre-ship-check) on a clean instance.
- Disable and enable the plugin; confirm routes, registrations, subscriptions and timers are cleaned up.
- Move a widget, reload and confirm placement; test multiple stable keys.
- Test light/dark themes, keyboard controls, narrow layouts and error states.
- Supply fake external services or injectable test doubles; tests should not need real paid API keys.

For an authorised source checkout, the runtime includes plugin example and backend contract tests under `orchestrator/src/plugins/examples.test.ts` and `orchestrator/src/backends/contract.test.ts`. A copied fixture alone does not prove that a plugin can pass admission and run through the actual loader.
