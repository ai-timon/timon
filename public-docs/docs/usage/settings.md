---
title: Settings
sidebar_position: 8
---

Open **Settings** from the navigation rail: it opens as a dialog over the page you are on. Close it with the **×** at the top right, with Escape, with the Back button, or by clicking the dimmed page outside it. If a field holds a value you typed and did not save, a click outside leaves the dialog open and says so; the **×** and Escape still close it and drop that value. Nine categories in the left column (Instructions, Interface, AI models, Missions, Resources, Memory, Access & network, System, Plugins) each split into tabs across the top. A plugin's settings appear in the category they concern, or under **Plugins** otherwise, and disappear while the plugin is disabled. Each registry setting shows where its effective value comes from.

## Search

The search field under the title looks through every setting at once: names, descriptions, setting keys and a few hidden keywords (searching `dark` finds Appearance, `concurrency` finds the live missions limit). Accents and case do not matter, and every word you type has to match. Results come in two groups: **Sections**, which open the tab that holds the setting (a setting painted by a special pane, such as the fallback cooldowns, leads to that pane), and **Settings**, which you can edit right in the list, with the category and tab above each one. Clear the field with its **×**, or pick a category, to go back to the tabs.

Every setting is always listed: nothing hides behind a "show advanced" button, and the search covers all of them (an installation configured with the lite preset still leaves its advanced settings out). A setting that belongs to a disabled plugin is not listed, and neither is it found.

**Environment → configuration file → saved UI value → default** is the precedence order. If an environment or file value controls a setting, changing the saved value does not override it. See [Configuration](../installation/configuration.md).

## Global instructions

**Settings → Instructions**, the first category, holds what you want from **every** agent: the language to answer in, your commit style, how you test. It is one Markdown file, `global-instructions.md` in the Timon folder (the table in [Where Timon keeps its files](../installation/configuration.md) gives its place on your OS).

Timon sends it to every agent each time one starts, right after the Timon preamble. A change applies from the next mission, not to one already running. In an agent's **Injections** tab it appears under its own origin, marked as yours. Keep it short: it is added to every prompt.

## Connections

**Settings → Secrets → Connections** lists your own connections to the services plugins talk to, grouped by the plugin type that uses them. **Add a connection** asks for an address and the keys the plugin needs; keys go to the vault and are never shown again. A new address waits for an administrator's approval before the plugin can reach it; **Test** works once it is approved. Tick *This service is on my machine or local network* for an address on your computer, your LAN or Tailscale: without it, such addresses are refused, and plain `http://` is only accepted for those. **Edit** reopens the form on a connection with its current values; leave a key empty to keep it. A new address, or a change of the local network setting, waits for approval again. Administrators see every connection under **Approval requests**, with who asked and where it points, and approve, refuse or revoke it. Uninstalling a plugin with `timon plugin remove` keeps its connections but sends them back to approval and deletes their keys: after a reinstall, an administrator approves them again and each owner re-enters the key with **Edit**.

The same page has a **Messaging integrations** section as soon as a plugin has created a messaging connection for you. It shows, per connection, the messages waiting, being retried or given up on. A message that keeps failing is retried for about a day of daemon uptime; Timon then stops, sends you an alert and keeps the message for `TIMON_INTEGRATION_RECEIPT_RETENTION_DAYS` days (30 by default). Each entry shows the last error. **Replay** sends a message back to where it stopped: a mission already started is not started again, and a reply resumes where it left off. **Replay all** does it for a whole connection once the provider is back. **Discard** gives up on a failed message for good. Replaying and discarding need you to be signed in: an agent cannot do it for you.

## Revealing a secret

Stored secrets are never displayed by default. To read one again, open it from the **Secrets** page and choose **Show**: Timon asks for your account password, then displays the value for 30 seconds, with **Copy** and **Unmask**. Only a superadmin signed in from the browser can do this, and every reveal is recorded. Too many wrong passwords lock the gesture for a while.

## Obsidian vault

**Settings → Memory** opens on the **Obsidian** tab. Type the path of your vault folder, or choose **Browse**: the desktop app on this computer opens your system's folder picker; connected to another machine, or in a plain browser, Timon lists the folders of the machine it runs on, since that is where the vault is read.

## Memory presets

In **Settings → Resources → Confinement**, Timon shows detected RAM and the automatic RAM
class. Choose **8, 16, 32 or 64 GB** to save three memory limits together:

| RAM class | Per mission | All missions, day | All missions, night |
| --- | --- | --- | --- |
| 8 GB | 2 GB | 3 GB | 4 GB |
| 16 GB | 4 GB | 6 GB | 8 GB |
| 32 GB | 8 GB | 10 GB | 16 GB |
| 64 GB | 12 GB | 16 GB | 24 GB |

Without an explicit setting, each limit uses the highest class for which
detected usable RAM reaches at least 90% of the nominal capacity. This allows
for RAM reserved by the kernel and firmware: 7.6 GB uses 8 GB, 15.4 GB uses
16 GB, 31 GB uses 32 GB, and 62.5 GB uses 64 GB. The 64 GB class starts at
57.6 GB; 57 GB still uses 32 GB. Below 8 GB the minimum class remains 8 GB;
12 GB uses 8 GB and 28 GB uses 16 GB. Detection uses GB of 1024³ bytes.
Existing saved limits are kept. CPU limits are unchanged.

Preset values remain editable individually. Environment and configuration-file
values keep priority over saved presets. Reset a saved field to return to its
automatic default, unless a higher-priority value still controls it.

The resource guard applies changes on its next tick (normally within 30 seconds)
without restarting Timon. Lowering a ceiling can stop a process already over
that limit. Enforcement uses the host's available confinement support;
detecting RAM does not add systemd confinement to Windows or macOS.

## Backend and fallback choices

**Settings → AI models → LLM backends** lists built-in providers, providers installed by
plugins, and providers you added yourself. Only a superadmin can change them.
Drag a row's handle to set the order in model selectors. Keyboard users can
press Space on the handle, move with the arrow keys, then press Space again.

Turning a backend off hides it from selectors and refuses new launches that
explicitly name it. Timon shows the agents, routines and pending tasks that
still reference it in a confirmation dialog; those choices are kept, without a
silent fallback. The last active backend cannot be disabled. If the usual
default is disabled, launches with no explicit backend use an active one.
Existing running missions are not stopped by this setting.

Choose **Edit** to rename a backend, choose its picture, add an exact model ID,
hide or show models, change their order, or select the default model. For
built-in and plugin backends, connection details remain under their provider's
control. An exact model ID is sent unchanged; a display label does not create
an alias. Newly added models appear first and carry a **New** badge for seven
days. Renaming one does not restart that period.

Each model row also has a **context window** field. Its placeholder shows the
window Timon detected (for example `auto · 400k`). If the context gauge in the
chat (the ring beside the send button, with the maximum in its centre)
shows the wrong limit for your plan or gateway, type the right one, such as
`200k`, `1M` or `128000`. A value you type is used instead of the detected one,
including the value the CLI reports. Clear the field to go back to detection.

Use the live backend catalogue (`timon backends`) rather than copying model IDs from an old guide. Providers can appear or disappear as tools, credentials or plugins change. Select the backend and its model together. To add a provider of your own, see [Add a provider](./add-a-provider.md).

### AI tools on this machine

**Settings → AI models → Providers** shows one card per AI command-line tool Timon works with — Claude Code, Codex, Grok, Copilot CLI, opencode, Hermes, Pi — with its state on this computer (**Not installed**, **Installed — sign in**, **Desktop app — sign in**, **Ready**), its version and the path Timon runs. Only a superadmin signed in to the app sees it. These are the same cards as the **Your AIs** step of the first-run setup.

- **Install** runs the vendor's official installer (Claude Code, Codex, Grok, Copilot CLI, Pi; opencode on macOS and Linux). The command being run and the installer's own output appear on the card while it works. **Run it yourself** shows the same command to paste into a terminal. Hermes, and opencode on Windows, link to their vendor's installation page instead. Pi's installer needs Node.js 22.19 or newer and npm already installed.
- Once installed, **Sign in** types the tool's sign-in command in Timon's terminal (press Enter there), or copies it when no terminal is open on the page; sign in through your browser, then click **Try again**. The command also stays shown on the card, to run in a **new** terminal of your own.
- Timon supports opencode 1. When opencode 2 is installed, its card says so and offers neither install nor update, which would replace it.
- **Update available** appears when the vendor has published a newer version than the one installed; **Update** runs the official installer again. Timon looks for new versions shortly after it starts and then every 12 hours; **Check for updates** looks now. To stop these checks, turn off the **Check for CLI updates** setting (`TIMON_CLI_UPDATE_CHECK`); `TIMON_CLI_UPDATE_INTERVAL_HOURS` sets the interval, one hour at the least. Turned off, Timon asks the vendors for nothing and still shows the installed version.

### CLI binaries

Below them comes **CLI binaries**: one row per command-line tool Timon runs for a provider (`claude`, `codex`, `grok`, `copilot`…), with the path it will launch and a status — **Found**, **Pinned**, **Pinned path broken** or **Not found**. Only a superadmin signed in to the app sees it.

If a tool is missing or installed somewhere unusual, type its full path (for example `/opt/homebrew/bin/claude`, `~/.local/bin/claude` or `C:\Users\you\AppData\Roaming\npm\claude.cmd`) and choose **Save path**. In the desktop app, **Browse…** opens a file picker; on macOS it can open an app bundle to reach the binary inside it. While the window is connected to another machine, or in a web browser, **Browse…** lists that machine's folders and files instead, opening on the pinned binary when there is one. Timon checks that the file exists and can be run, then the next mission uses it: no restart. **Remove pin** goes back to automatic detection.

**Check again** looks for the tools once more — after you installed one while Timon was running, or after you edited `host.binaries` in `timon.config.json` by hand — without restarting either.

**Settings → AI models → Auto switch** opens on **Preferred provider**: the provider new agents, missions and chats run on when they name none. It applies only while that provider is signed in; **Automatic** takes the first signed-in provider. A provider whose CLI is installed but signed in to nobody carries a **Not signed in** badge in every model selector, and Auto switch never moves work onto it: with a single signed-in provider, a quota limit stops the work instead of switching. Changing the preferred provider never moves a conversation already started: it keeps the provider it began on.

**Settings → AI models → Auto switch** controls global fallback behaviour. The **Fallback model** control shows the last-resort backend and model currently set; click it to open the same [model picker](missions.md#choosing-a-model) as the chat and pick both together. **Remove** leaves no last resort (the switch stops at the model-equivalence step), and **Default** restores the shipped pair. The **Circuit breaker** tab next to it sidelines a backend after repeated sterile turns, and sets how many times Timon retries the turn of an unattended mission whose provider dropped the connection (3 by default, 0 turns it off). A series can override it by scope, and a task can carry an even more specific override. Unknown quota reset times are displayed as unknown; the cooldown is a fallback estimate, not a provider guarantee.

## Subscription accounts

**Settings → AI models → Subscription accounts** lets you use several subscriptions of the same provider, for example a personal and a work Claude plan, or two ChatGPT plans for Codex. Each account appears in every model selector as its own choice (`Claude · Perso`), next to the provider's plain entry.

- **Add an account** asks for the provider and a name (administrators also choose who it is **For**: themselves, a user, or the instance), then starts the sign-in on the Timon machine while you stay in your browser.
- A row shows the address the account is signed in as and its state: **Signed in**, **Not signed in**, **Sign in again** or **Out of quota**.
- You sign in your own accounts. An administrator sees and signs in everyone's.
- A mission never moves to another subscription on its own.

How sign-in works, who may use which account, instance accounts, assigning an account to a user, and how it interacts with quotas and Auto switch are in [Subscription accounts](subscription-accounts.md).

## Installation (System)

**System › Installation** shows how Timon runs on this computer. Only the superadmin sees this tab.

- **Version**: the version of Timon's daemon and, in the desktop app, the app's own version. When the two differ, the daemon was not updated with the app: quit and reopen Timon, and if they still differ, run the `timon service install` command the tab shows. **Data version** is the version that last opened your data; it catches up at the next start once you accept the update. The tab also shows your edition, plan and licence status, the operating system and the runtime.
- **Daemon**: whether it runs as a system service (it keeps running when the app is closed), inside the app (it stops when you quit Timon) or was started by hand, the address and port it listens on, the web app's address, and its process ID.
- **Service**: whether a service is installed and running — a systemd unit on Linux, a launchd agent or daemon on macOS, a scheduled task on Windows, with its revision. **Install the service** appears when there is none; **Repair the service** when it is out of date. Both do what the first-run setup does (an administrator prompt on Windows). When the daemon answering you *is* the service, reinstalling it would stop it mid-request, so the tab gives the command to run in a terminal instead: `timon service install`. A service installed while the app's own daemon holds the port takes over at Timon's next launch.
- **Support diagnostic**: **Copy diagnostic**, **Save report** and **Show report** prepare the report to send with a support request (versions, how Timon runs, the service, detected problems, latest log lines newest first; secrets masked), and **Open logs folder** in the desktop app. See [Troubleshooting](../installation/troubleshooting.md#diagnostic-report-and-logs).
- **Paths**: the installation folder, the data folder, the configuration file, the logs folder (one file per day) and the daemon's service output — a file for the Windows and macOS services, the system journal for the Linux service (with the `journalctl` command to read it), the app's or the terminal's output otherwise.
- **Export and import**: **Export my data** writes a portable archive to the data folder (secrets are never included) and shows its path. Importing replaces the database, so it cannot run while Timon runs: quit the app, then run the commands the tab lists, with your data folder filled in (replace `ARCHIVE.tar.gz` with your archive). See [Upgrading](../installation/upgrading.md) for what an import restores.

## Backups and the agent trash (System)

**System › Backups & trash** holds the safety net of your data.

- **Nightly backup**: Timon writes an archive of your data folder every night at 03:30, secrets excluded, under `backups/` in your data folder. It is on by default. A backup you turned off stays off; `timon backup enable` turns it back on and `timon backup status` shows the archives. The backup covers every account's data, so only a superadmin can see or switch it on.
- **Backups kept** (7 by default) and **Delete backups older than** (in days, `0` = no age limit): right after each backup, the archives beyond these limits are deleted. The newest archive is always kept.
- **Keep deleted agents in the trash** (on by default): deleting an agent moves its configuration, system prompt, identity docs and memory to the trash instead of erasing them. Off, a deletion is final.
- Whether the trash is on or off, deleting an agent revokes the secrets and the browser profiles granted to it, so an agent created later under the same name starts without them. The agent's own browser, with its signed-in sessions, waits in the trash with it and is erased when the agent leaves the trash for good. So do the memory rules written for that agent alone: a new agent of the same name starts without them, a restore brings them back, and they are deleted with the agent. The facts its missions taught a project stay with the project.
- **Empty the trash after** (30 days by default, `0` = until you delete them yourself): a deleted agent is deleted for good this many days after its deletion.

Below the settings, **Deleted agents** lists what the trash holds, with who deleted each agent and when it will be purged. **Restore** puts an agent back under its name, with its own browser but without its secrets: grant them again from the **Secrets** page; it is refused while another agent holds that name, so rename or delete that one first. Restoring takes the same rights as creating the agent: an account that may not choose tools, MCP servers or permission levels cannot restore an agent that has them, and an agent cannot restore one that orchestrates others. **Delete for good** removes it at once. A restored agent gets its files and memory back, but not its *always allowed* approvals nor the messages that were waiting in its inbox.

The same settings can be written in `timon.config.json`, under `settings`:

```json
{ "settings": { "TIMON_BACKUP_KEEP": 14, "TIMON_BACKUP_MAX_AGE_DAYS": 30, "TIMON_AGENT_TRASH_RETENTION_DAYS": 60 } }
```

## Mission timelines and history

Two settings bound what Timon keeps about finished missions. They are independent.

`TIMON_TRACE_SPANS_RETENTION_DAYS` (90 by default) removes the timeline of a mission over for that long. The mission list still shows its tools, errors and duration, and **Rebuild the timeline** on the mission brings it back from its events. A workflow run's own steps are kept. Set it to 0 to keep every timeline. `timon trace backfill` without `--days` stops at this horizon, since anything older would be removed again by the next daily pass.

`TIMON_EVENTS_HOT_DAYS` (0 by default, off) moves older events to `archive/events.db`. They stay readable, but a standard export or backup no longer includes them unless you pass `--with-archive`, which is why it is off until you ask for it.

## Stopping stuck missions (Cleanup)

**Settings → Missions → Cleanup** decides when Timon frees a mission that no longer needs its process, or stops one that is stuck. Two settings govern a turn that is still running:

- **Silent turn before reap** (45 min by default): a turn is stopped as stuck only once its agent has produced nothing for that long, no output, no tool progress, no event. A long turn that keeps working is left alone. The mission shows **Interrupted**, cause *silent too long*.
- **Turn budget** (4 h by default, `0` turns it off): a ceiling on the length of a single turn, even one still working. Past it, the turn is stopped with the cause *turn budget reached*, and its Kanban task is not replayed automatically. On an autonomous mission, turns the agent resumes by itself after a background job finishes count as one.

A turn waiting on a permission card you have not answered is never stopped by either setting.

Two more govern an autonomous mission (a Kanban task, a routine, a sub-mission) whose turn has ended:

- **Idle time before reap** (10 min by default, `TIMON_REAP_IDLE_MS`): the mission is ended and frees its slot once its turn has ended and nothing has been heard from it for this long.
- **Idle time before reap, background job running** (1 h by default, `TIMON_REAP_BG_MS`): a mission whose CLI still runs a process it started, such as a test suite launched in the background, is spared past the idle time, up to this ceiling measured from the end of its turn.

## Answer deadlines on autonomous missions (Permissions)

A card opened by a mission nobody is watching (a Kanban task, a routine, a sub-mission) does not wait forever: past a delay, the agent is told it got no answer and goes on without it. The card shows the time left (**Expires in 12:34**). A conversation you are having never expires. **Settings → Missions → Permissions** sets the delays:

- **Delay before auto-deny (autonomous missions)** (5 min by default): an Allow / Deny card, when no phone could be notified.
- **Delay before auto-deny (human notified)** (35 min by default): the same card, once a push notification reached one of your devices.
- **Delay before a form expires (autonomous missions)** (30 min by default): a form the agent opens, which takes reading and choosing.

All three stay under the **Silent turn before reap** delay above. When a form expires and the agent asks the same questions again, the new card starts from what you had already ticked and typed in this browser tab. The Kanban planner does the same, and also keeps your choices across a page reload, until you launch the plan.

## Conversation titles

A conversation you open in the chat gets a short title at the end of its first reply: four to six words in the language of your message, shown in the chat's mission list, in the Missions table and in the multichat picker instead of the first line of your message. Missions started by a Kanban task, a routine, a trigger, a workflow or another agent keep the name their launcher gave them; nothing is generated for them. Right-click a mission in the chat's list and choose **Rename** to give it a name of your own: that name is kept, and never replaced by a generated one. Clear it to show the first line of your message again: Timon generates a title only once, at the end of the first reply, and clearing it does not bring generation back.

**Settings → Missions → Execution → Conversation titles** chooses, for your account, the model that writes these titles:

- **Instance setting** follows what the administrator set (`TIMON_MISSION_TITLE_MODEL`: `auto`, `off` or `backend:model`);
- **Automatic** uses the lightest model of the backend the conversation runs on;
- **A model of my choice…** opens the [model picker](missions.md#choosing-a-model) on the models that can write titles; a backend served remotely, which cannot answer such a short call, is left out and named under the picker with the reason;
- **Off** generates nothing: only the names you type and the names launchers give remain.

Each generated title is one short call on the quota or credits of the chosen backend, and the first message of the conversation is sent to that backend. Conversations that already exist are not renamed.

## Appearance and plugin settings

**Frosted glass** in Appearance blurs what lies behind the widgets, the top bar and the side menu. **Where the glass sits** chooses who carries it: **Whole island** (the default) makes each island one frosted plate, its widgets standing out by a slightly lighter surface; **Widgets** leaves the islands clear, so the wallpaper shows sharp between the cards, and makes each widget and the chat's reading column a frosted card. Any island can choose otherwise from its menu (right click on its tab → **Glass**): **Follow the Appearance setting**, **Whole island** or **Widgets**, remembered for that island on that page. A popup island (a terminal opened over the page, for example) is always frosted like a widget, over what lies under it.

**Ambient tint**, under the accent colour, sets the mood of the neutral surfaces from a single colour per mode. The colour you pick is the page background: its hue colours every background level, border and secondary text, and its lightness moves them all together, so the steps between canvas, cards and fields stay the same. A dark blue-grey turns the dark mode bluish, a light beige warms the light mode. The lightness stays within a range where text remains readable, and a very vivid colour is toned down to a tinted grey. **Native greys** goes back to the default. The accent colour, for buttons and links, stays independent.

**Widget style** in Appearance sets **No borders** and **Transparent background** for every widget at once, so a wallpaper with frosted glass takes one switch instead of one menu per widget. Switching one of them restyles every widget at once, including those you styled one by one; a choice you make afterwards from a widget's own gear menu is kept, and **Follow the site style** in that menu hands the widget back to the site's. Select an installed theme from Appearance. Installed themes that are not selected remain in the gallery without overriding the current palette. **Timon**, the brand theme, ships with the app in a dark and a light version: the website's violet-tinted night in dark, beige instead of greys in light, peach and copper accents. It is the theme of every account created from version 0.1.7 on; an account that existed before keeps the theme it had, and can switch to Timon here.

Plugins can add fields to an existing tab or provide their own tab under **Plugins**. A manifest-only settings declaration generates a form automatically. Secret fields display whether a value is configured; they do not return the stored secret to the browser.

## Layout preferences

A fresh install starts with few widgets. The cockpit shows **Notifications** and a dashed **Your widget here** card on the left, your main agent in the middle, and **TODO** and **Tasks** on the right. A project's chat shows **Missions** and **Files** on the left, and **Git** and **Docker** on the right. The agents canvas starts with no widget, only a **Your widget here** card at the foot of each column. Click the **+** of a **Your widget here** card to open the widget window. You can move that card or delete it like any other widget.

Widgets move and resize at any time: there is no layout mode to switch on. Drag a widget by its title (a stack by the space beside its tabs, or by a tab to take that one alone) and drop it in any zone. Rest the pointer on a title for two seconds and the hand appears, with a small bar at the top of the card holding a grip (the keyboard's way to move it: focus it, then Space and the arrow keys) and a gear. The gear opens the widget's settings — appearance, detaching a tab — and, last and in red, **Delete**; a right click on the title (or on a tab) opens the same menu. Deleting offers **Undo** for a few seconds, and a removed card remains available in the palette. In a column, widgets always share its whole height; drag the gap between two of them to trade height, with natural stops at 25 %, 33 %, 50 % and 100 % of the column (Shift drags freely). **Add widget** opens the widget window (the catalog of removed widgets) with its **Done** button; Done, its cross or Escape close it. The window has one tab per page (Cockpit, Chat, Agents, Sidebars, Top bar), a search that reads each widget's name and description, and a one-line description under every name. Drag a card from the window into a zone: the widget itself follows your pointer, as it will appear; while you drag, empty zones show where they are. From the **Manage** mode of the appearance menu, you can also apply a saved layout to every project's view of the same page (the island tabs it replaces there close, and a replaced terminal ends its shell), or overwrite a saved layout with the current one. Host configuration and disabled modules can hide surfaces independently of your personal placement preferences.

The right side of the top bar is a widget zone too. It holds the **Notifications** bell and the **LLM quotas** ring by default. Rest the pointer on either one for two seconds to show its grip, then drag it into the side navigation or the right sidebar: it stays compact there, the bell as its button and the quota rings stacked. Drop it into the cockpit or a chat column instead and it becomes a card, with the notification list or every quota window and its trend. Drag it back to the top bar to put it on one line again. Clicking the bell or the rings opens their detail next to them, kept on screen. Only widgets that have a compact form can go in the top bar; other cards are refused there.

**Customize the menu**, at the foot of the side navigation (hover it to unfold it) or of the mobile menu, lets you hide the pages you do not use and put the others in the order you want — the pages added by plugins included. Click a page's eye to hide or show it, and drag the page to move it (keyboard: press Space on the small grip at its left, move it with the up and down arrow keys, press Space again), then **Done**. A hidden page leaves only the menu: it still opens by its address, and the same button shows it again.

While customizing, you can also:

- **Add a separator** (button under the list): it appears at the end of the main list as a gap between two pages. Drag it where you want it, or remove it with its cross. The gap between the product's main pages and Activity is a separator like the others: move it or remove it too.
- **Put pages at the bottom of the menu**, just above Settings: drag them under the **Bottom of the menu** mark (or drag the mark up). Separators work there too.

The menu looks the same collapsed, unfolded and in the mobile menu. A plugin you switch off and on again finds its page where you left it. An agent can propose a menu too — hidden pages, order, separators and bottom pages — as a card in its conversation, applied only when you click it.

The bell opens the recent notifications: mark one or all as read, or open the full list. Marking as read moves a notification to that list's archive. Each notification names the agent that raised it, or Timon for its own.

Like every placement, this one is saved per page: moving the bell on the cockpit leaves it in the top bar of the chat.

The chat's side columns are resized by dragging their inner edge, and each side can get a second column from the right-click menu of its tab line; see [Column width and a second column](missions.md#column-width-and-a-second-column).

The desktop app remembers its windows: each reopens at the size and position you left it, maximized or full screen if it was, and on the machine it showed; leaving either state gives back the size you had chosen before. If the screen a window was on is no longer connected, it opens inside a remaining screen, shrunk to fit if needed. See [Several windows in the desktop app](machines.md#several-windows-in-the-desktop-app). On Linux under Wayland, the compositor places the window itself: only its size is kept.

## Interface language

Timon is available in English, French, German, Spanish, Italian, Dutch, Polish, Portuguese (Brazil), Japanese, Korean and Simplified Chinese. By default it follows the language of your browser, or of your computer in the desktop app: a regional variant reads the closest language available (French for `fr-CA`, Brazilian Portuguese for `pt-PT`), and any other language falls back to English. Simplified Chinese is selected automatically for Simplified Chinese locales, not for Traditional Chinese locales. **Settings → Interface → Language** lists **System language** first, which shows the language it detected, then every language Timon ships, each in its own name; choose **简体中文** to pin Simplified Chinese. A text not yet translated in that language shows in English. Dates, times, numbers, sizes and relative times (« 3 min ago ») follow the chosen language too, in the time zone of your computer. Changing the language reloads the page. The choice is kept by this browser (or by the desktop app), not by your account, so the sign-in screen already uses it.

In the desktop app, the application's own menus, the tray icon menu, the Dock menu on macOS, the taskbar jump list on Windows, the startup and update windows and Timon's dialogs follow the same choice. Menus switch as soon as you pick a language; a window already open keeps its words until it is opened again.

## Voice conversation (GPT-Live)

For dictation in the chat and the cockpit's voice mode, see [Voice dictation](voice-dictation.md).

**Settings → Interface → Voice dictation** can turn on a live voice conversation with your missions, powered by OpenAI GPT-Live. It is off by default.

1. Paste an OpenAI API key with access to GPT-Live and choose **Save to the vault**. The key is stored in the secrets vault as `OPENAI_GPT_LIVE_API_KEY`. Only Timon reads it, no agent receives it, and it is never shown again.
2. Turn on **Enable conversation mode**.

A conversation button then appears next to the mic in the chat composer. Click it and speak: GPT-Live handles the voice, with natural turn-taking and interruptions. It answers small talk and general questions itself, and hands everything that touches your projects, files, code, notes or memory, every action, and every fact worth checking to the mission. The mission's own agent does that work with its usual model, tools and project, writes its answer in the chat, and GPT-Live says it aloud. Long answers and code are cut short in speech, but they stay complete in the chat.

While the conversation runs:

- A sphere in the background shows whether GPT-Live is listening, speaking or waiting for the agent, with live captions of both of you above the composer. The chat stays usable underneath.
- The whole spoken exchange is written into the conversation as it happens, in bubbles tagged **voice**: your words as transcribed, and what GPT-Live said. They stay in the mission's history and come back when you reopen it.
- When GPT-Live hands a request over, the agent also receives the recent spoken exchanges, so it knows what "that" refers to. GPT-Live in turn starts each conversation with the latest messages of the chat.

Click the button again, or the cross next to the status, to end the conversation. The microphone is released as soon as it ends.

OpenAI bills voice time on your key (about $0.05 per minute at the time of writing). The mission itself keeps running on its usual backend.

## Remote access

For a server or a VPS, [Remote access to the web interface](../installation/remote-access.md) compares the methods (Tailscale, SSH tunnel, reverse proxy, Cloudflare Tunnel) and lists the ports and firewall rules.

The remote-access panel and WebUI settings show a Tailscale Serve command when Timon manages a known local web listener. The command uses that listener's configured port, regardless of the browser address.

For external hosting, including Docker behind a reverse proxy, the sharing command is withheld because the host-side target is unknown. Verify which local address serves Timon on the host before configuring Tailscale Serve. A port inside a container is not necessarily published on the host. If you switch to Timon's managed web server, reopen the panel to read its current configuration and update your existing Tailscale forwarding rule accordingly.
