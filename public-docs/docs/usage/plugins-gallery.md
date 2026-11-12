---
title: Plugin gallery
sidebar_position: 6
---

Open **Plugins** to see installed extensions, including disabled ones. Account administration is a plugin too: with **Multi-user** installed and on, its **Team** page appears in the menu to invite other people to your Timon, sort them into groups, give them permissions and read the activity log. Cards show the manifest label, description, cover, kind and declared surfaces. A disabled plugin retains its card so it can be enabled again.

The `@timon` family identifies product-authored plugins. Third-party packages appear in the Marketplace family; a verified badge describes signature verification, not the plugin's purpose or whether it is enabled. This view is a local installed catalogue, not a promise of a remote store.

## Enable or disable

The **Provider** kind identifies a plugin that brings an AI provider. Its install sheet lists the program it launches, with the path found on your machine, and lets you allow that exact program in one tick. A bundle's sheet shows the same for each provider it brings, each with its own box, and where each dictation engine it brings sends your voice.

If the provider describes how its program identifies itself, Timon checks that answer when you confirm the authorization. A different program at the same path is refused, with what it printed; nothing is authorized or installed. Install the provider's own program, then try again. Opening the sheet alone runs no program.

The **Island** kind identifies a plugin that supplies workspace content. Use
the **Island** filter to find these plugins. Their content opens in a tab or
split beside the current page; see [Island content](../plugins/island.md).

Use the card's toggle or the CLI with the **manifest ID**:

```bash
timon plugin list
timon plugin disable acme-example
timon plugin enable acme-example
```

Toggles update the desired configuration and the loader reconciles the plugin without restarting the daemon. Installing or enabling third-party code through the UI requires a superadmin account.

A refused plugin displays its reason. An incompatible contract, invalid signature or missing licence cannot be repaired by toggling repeatedly. A Timon module your licence does not include says **Not included in your licence**, with its switch off. Core modules needed for the daemon have no usable off switch.

A built-in plugin can also run with part of it missing because this machine lacks a tool. Its card then says what is lost — for example the Kanban without Git refuses the code, review and merge tasks of a Git project. The **Git** plugin is the chat's [Git widget](git.md) and the branch shown above the message box, and works whether the Kanban is on or off. It needs Git on the machine, and its card in the gallery shows whether your licence includes it. The **Files** widget plugin (`@timon/files-widget`) is the Files card of the chat, the agent's working folder; it relies on the built-in Agents module, and turning it off removes the card without touching the folder or the agent. The **Skills** (`@timon/skills-widget`) and **MCP** (`@timon/mcp-widget`) widget plugins are, likewise, the Skills and MCP cards of the chat: turning one off removes its card, while the agent's skills and MCP servers, and the Capabilities pages, stay as they are.

With several accounts, a restricted role sees a card of the chat's columns only if it holds the card's permission: `widget:missions` for the missions list, mission details and agent tasks, `widget:workflows` for Trace, and `widget:git`, `widget:files-widget`, `widget:skills-widget`, `widget:mcp-widget`, `widget:docker-supervision`, `widget:orchestrator-self` or `widget:video-factory` for the others. It opens the card, not the plugin's page. Without `widget:git`, the branch shown above the message box is hidden too, and the project's branches, changes and commits cannot be read. Driving containers from a card also takes `projects:manage`, and restarting the daemon `settings:write`.

## Built-in plugins

Some plugins ship with Timon itself and carry a **Built-in** badge — for example the LLM quota monitor, and the **Codex (OpenAI)**, **Ollama Cloud**, **Grok Build**, **GitHub Copilot**, **ACP agents (opencode, Hermes)** and **Pi** providers. They are active after installation, work offline and with every licence, and need no `timon plugin add`. **Hermes Gateway** is the exception to the first point: it ships switched off, since it only serves people who run a Hermes gateway; turn it on from its card or with `timon plugin enable hermes-gateway`. You can disable them from their card or with `timon plugin disable <id>`, but not uninstall them: `timon plugin remove` refuses and suggests disabling instead. If you had installed your own copy of a built-in plugin earlier, that copy is ignored and can be removed with `timon plugin remove <npm name>`.

## Install a plugin from your computer

A superadmin sees **Install a plugin** at the top of **Plugins**:

- In the desktop app, choose **Choose a plugin folder…** (an unpacked plugin) or **Choose a plugin archive (.tgz or .zip)…**.
- Connected to another machine, or in a browser, pick a plugin folder or archive that is already on that machine (**Choose a plugin folder on the connected machine…**, **Choose a plugin archive on the connected machine…**), or **Send an archive from this computer…**.

An archive can be:

- a `.tgz` made with `npm pack`;
- a `.zip`, such as GitHub's **Download ZIP**, or a plugin folder compressed with the Windows Explorer (**Send to › Compressed (zipped) folder**) or the macOS Finder (**Compress**). The zip must hold the plugin's `package.json` at its root, or a single folder that holds it. The `__MACOSX` folder and `.DS_Store` files the Finder adds are ignored.

Timon refuses an archive larger than 25 MB, one that unpacks to more than 200 MB or 10,000 files, one that holds links or tries to write outside its folder, one with a file name Windows refuses (`CON`, `aux.txt`, a `:` in a name, a name ending with a dot or a space — refused on every OS, since a plugin must install on all three), and a `.zip` that is password-protected, split into several parts, or in the zip64 format. The message on screen says which.

Timon reads the package without running any of it and opens its sheet: name, version, author, kind, the permissions it asks for, where it plugs in, and its signature status — **Verified signature**, **Unsigned** (with whether it would load on this installation, see [Developer mode](#developer-mode-load-unsigned-plugins)) or **Altered package**. An altered package, or one whose manifest Timon cannot use, cannot be installed.

Nothing is installed until you click **Install** on that sheet. Read the disclaimer above the button: third-party plugins are not made, reviewed or guaranteed by Timon, and Timon is not responsible for what they do. Once installed, a plugin runs inside Timon with the rights of your account, so only install plugins from authors you trust.

The plugin appears in the gallery without restarting Timon. Its files are kept in the plugins folder (`~/.timon/plugins/` — on Windows `%USERPROFILE%\.timon\plugins\`), so you can delete the folder or archive you picked afterwards. Installing needs `npm`, which comes with Node.js, on the computer that runs Timon.

A bundle whose plugins sit in neighbouring folders (declared as `file:../name`) can be picked as a folder: the gallery copies those neighbours into the plugins folder too and installs them with the bundle. A dependency further away (`file:../../…`) is not copied, and a `.tgz` or `.zip` only carries its own folder: install such a bundle with `timon plugin add <folder>`.

## Developer mode: load unsigned plugins

A plugin you write yourself has no signature. Timon installs it, but loads it only in developer mode. A superadmin turns the mode on in **Settings › Plugins › Developer mode**, with the **Developer mode — load unsigned plugins** switch. The change applies at once, without restarting Timon: an unsigned plugin already installed starts when you turn the mode on and stops when you turn it off. Signed plugins load either way.

A plugin runs inside the Timon daemon, with the rights of the system account that runs it. Turn developer mode on only for code you wrote or have read.

The switch works the same on Free and on a paid licence, and shows what Timon actually applies. A licence that includes a fixed plugin composition does not let unsigned plugins load: the switch then stays off and greyed out, and says why.

The install sheet of an unsigned package, or of a bundle that brings one, follows the mode:

- **Developer mode off**: the sheet says the plugin can be installed but will not load, and offers **Turn on developer mode** right there (unless your licence includes a fixed plugin composition) or **Open developer mode settings**.
- **Developer mode on**: the sheet shows **Unsigned — loads in developer mode**.

Either way, clicking **Install** first asks you to confirm: the package is not signed, its publisher is not verified, and its code will run inside the Timon daemon, at once or as soon as developer mode is on. **Install anyway** goes on; **Cancel** installs nothing.

## Plugins found in the plugins folder

Drop a plugin folder or `.tgz` archive into the plugins folder and it is listed under **Found in the plugins folder, not installed**. Click it to open the same sheet and install it. A plugin you remove with `timon plugin remove` keeps its files there and reappears in this list. A `.zip` is not listed there: pick it with **Install a plugin** instead.

## Install from the command line

```bash
timon plugin add ./my-plugin
```

`timon plugin add` takes a folder, a `.tgz` or `.zip` archive, or an npm package name, and asks for confirmation before activating. Host plugins run inside the daemon process. See [Testing and installation](../plugins/testing.md) for signature and developer-mode requirements.

Removing a widget from a layout is different from disabling its plugin: the widget palette can restore a removed card, while an unavailable plugin cannot render it. Themes must also be selected in Appearance before their palette is used.


## Mail Sentinel

The Mails tile is an optional third-party plugin and is no longer built in or
preinstalled. Install the package you received by its path:

```bash
timon plugin add /path/to/my-plugin
```

Signature and developer-mode requirements still apply.
The separate Mail Sentinel service must already be running.

Your previously saved service URL is carried over automatically, even if you
install the plugin later. An existing `serviceUrl` setting is never overwritten.
If you configured the old integration only through an environment variable,
enter the URL in **Settings → Plugins → Mail Sentinel → serviceUrl**.

Add the service **hostname**, without scheme or port, to `pluginPolicy.http.allow`
in your Timon configuration. For example, a service at `http://127.0.0.1:8090`
needs `127.0.0.1` in that list. Keep your other allowed hosts. Migration never
changes this allowlist automatically.

The new widget uses its default placement; the old Mails placement is ignored.
Only grant plugin access to users allowed to read the configured mailboxes.
