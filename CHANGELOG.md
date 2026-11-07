# Changelog

What changed in each version of Timon, written for the people who install it.

The engineering journal — why a change was made, which trap it avoided, which
sha carried it — stays in [docs/PROGRESS.md](docs/PROGRESS.md). This file is the
other audience: what a beta tester gets, and what is still broken for them.

**One test decides what belongs here: can someone who installed the packaged
app see it?** If the answer is no, the entry does not go in this file — no
matter how much work it was. Refactors, tests, internal documentation, the
Compose file, repository housekeeping: none of that reaches a tester, and
listing it buries the two lines they actually needed to read. Those live in
`docs/PROGRESS.md`, which exists for exactly that.

Every entry goes under one of these headings:

- **Added** — a capability they did not have before.
- **Fixed** — something that was broken for them and no longer is.
- **Changed** — existing behaviour or availability has changed.
- **Known issues** — something still broken for them, or working only under
  conditions. An entry stays here until a release actually fixes it; that
  release then moves it to **Fixed**.

Write from where they stand: what they see now. Not the file you changed.

**Short and factual.** Say what is fixed or added — one sentence usually, two if
the bug needs it. No storytelling: no "before… now…", no internal cause. When
the bug has a tester reference, it opens the entry in bold: `- **TIM-0016** — …`.
The explanation belongs in `docs/PROGRESS.md`, not here.

Versions follow `MAJOR.MINOR.PATCH`. The daemon reports its version to the
licence server as `appVersion`, so `orchestrator/package.json` and
`desktop/package.json` are bumped together, never one without the other.

A version number is bumped only when a release is published, and only when the maintainers
ask for it. Electron builds are made far more often than that — one is
regularly produced just to check that everything holds — and those carry no
bump. Until a release is called, everything accumulates under `Unreleased`.

## [Unreleased]

### Added

- **Simplified Chinese** for the interface and desktop menus: choose **简体中文** in **Settings → Interface → Language**.

### Known issues

- Onboarding form details are still in English outside English, French and Simplified Chinese; the step titles are translated.

- Chat: while a turn is being prepared, a tool the previous turn left unfinished can show as still running, with its old duration, until the new turn starts.
- An agent's island card applied to a page other than the one on screen removes the tabs it replaces, but a replaced terminal keeps running: end it from the Terminal page.
- Windows: a CLI installed with pnpm or yarn can keep running after Timon stops or crashes; end it from Task Manager, or install it with npm.
- **TIM-0034** — The installers are not code-signed: Windows SmartScreen or Smart App Control and macOS Gatekeeper warn about them or block them. On Windows, choose **More info → Run anyway** (turn Smart App Control off in Windows Security if it blocks); on macOS, allow the app in **System Settings → Privacy & Security**.
- Windows: a Codex agent in auto or acceptEdits mode cannot `git commit` (Codex keeps `.git` read-only); give its code and merge tasks the bypassPermissions mode, or run them on another backend.
- Windows: on a work or school account of a PC joined to Microsoft Entra ID, Windows may refuse to run Timon's background task; Timon then runs only while its window is open.
- macOS: the usage of a Claude subscription account is not shown in the LLM quotas widget nor under the chat composer; Codex accounts are.
- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- Copilot CLI card: **Update** may update another copy than the one shown, or install a new one, when the CLI's path is pinned in **Settings › AI models › Providers › CLI binaries**, or when it was installed under an nvm pre-release of Node (such as `v21.0.0-rc.1`); run `copilot update` with the CLI's full path in a terminal instead.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, or no reviewer) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- Pi has not been tried with a tester's own model provider yet, so a first mission may fail.
- With Pi as the only backend, conversations keep their default title.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.
- Windows: installing a new version of the app closes the built-in terminal's shells.
- Chat: pressing Escape to close a dialog while dictating also cancels the dictation and puts the message back as it was before you clicked the mic.
- Google refuses to sign in directly from the built-in browser ("This browser or app may not be secure"); use **Sign in with Chrome** in its options menu, which needs Chrome, Edge or Chromium installed outside a snap or flatpak package.
- **Sign in with Chrome** copies the sign-in into the built-in browser; whether Google keeps it valid there over time has not been verified, and a password or 2FA step has not been tried. Run it again if the session is lost.

## [0.1.7] — 2026-11-06

### Added
- Plugins can draw their menu entry with the product's own (`NavLink` from `@timon/ui`), so it folds with the side menu instead of squeezing its label into it.
- When accounts beyond the first superadmin are suspended (no pro licence, or no Multi-user plugin), the superadmin gets a card saying why; their data are kept.
- Signed plugins can now manage a team's accounts: add accounts and open their sessions (`accounts:provision`), say which rights each account holds (`accounts:permissions-source`), and serve pages without a session such as an invitation (`http:public`). The account provider also reads and updates the accounts it serves, writes the audit log, and reads the catalogue of rights a role can grant.
- Plugins can keep their data in a SQLite database of their own (`ctx.sql`, permission `storage:sql`), with migrations declared in their manifest and applied when they start.
- The Git widget's **Publish** tab can push to any remote of the repository: a picker beside **Push** shows each remote with what it lacks, and pushing anywhere other than the branch's upstream asks first.
- The Git widget asks before every push, naming the repository, the remote, its URL, the branch and the number of commits.
- The Git widget shows the other repositories inside a project folder (an ignored nested repository, or one listed in `.worktreelinks`): a picker switches between them, and a dot flags one with commits to push.
- A `.worktreelinks` file at the root of a repository lists ignored folders, such as a notes repository, that every Kanban task worktree links from the main checkout.
- Two advanced settings let task agents keep one account connector (**Settings → Memory → Obsidian**) and let any agent call chosen MCP tools without a permission card (**Settings → Missions → Permissions**).
- The first-run screens have a light/dark switch in the top-right corner; they follow your system until you pick, and your account keeps the mode you chose.
- **Timon theme**: the brand's dark and light palettes (the website's violet-tinted night, beige-leaning whites, peach and copper accents), now the theme of every new account. Existing accounts keep their theme and can pick Timon in Settings → Appearance.

- After updating from an earlier version, Timon signs you out once and opens the new welcome screen, then a new **Sign in** screen; once signed in, it offers to dress your main agent's mascot (**Keep this look** or **Not now**).
- Chat: **Reply** under a message (the agent's or yours) answers it: a strip above the input shows which one, and your message shows a quote that scrolls back to the original. The agent receives the message's reference and opening words, not a copy.
- Chat: **Copy as Markdown** under an agent's message copies its answer with the formatting, and every button under a message names itself on hover.
- **Plugins**: the `chat.message.action` slot adds a button under chat messages, with `useChatMessage()`, `useComposerReply()` and `MessageActionButton` (API 15).
- Agents: the `mission_message_get` tool reads a message of the conversation back by its id.
- After your account, a **Choose your LLM** screen asks whether Timon runs on your AI subscription (the AI tools Timon supports — Claude Code, Codex, Copilot CLI, Grok Build — installed and signed in from compact cards, then **Ready with …**) or on local models with Ollama; the main agent setup no longer shows its own **Your AIs** step a second time.
- Then **What brings you here?** asks your profile in one click — **I write code**, **I automate** or **I'm discovering** — and the setup conversation and the guided tour no longer ask it again.
- Then **Bring your agent to life** creates your main agent on one screen: its mascot, name, role and model on a card, and the view your profile recommends — six ready-made profiles, a five-question interview, or a sheet with role, folder, model, exact permission mode, skills, MCP servers and instructions — with a switcher to the other two.
- After your main agent is created, **Discover Timon** shows in four quick animated slides what your TIMs can do: work on their own, work as a team, and live inside a project with its own rules and memory; **Next** and **Skip all** keep it short.
- **Customise** on that card opens a side panel to pick the mascot's skull, fur, eyes and accessory, with a live preview and states to try; until then it dresses for the agent's job.
- Agents without a picture show their mascot instead of their initial.
- The agent editor has an **Avatar** tab, before Identity: pick the head the agent shows everywhere — an emoji, an uploaded image you frame, or its mascot, dressed with the same configurator as the first-run setup. The other two settings are kept, and agents whose head was never chosen keep their face.
- **Change avatar** in the right-click menu of an agent (chat card, Agents graph) opens that tab.
- An agent's mascot now shows what the agent is doing wherever it appears — chat cards and bubbles, the chat header, side rails, Multichat, the Agents graph, the Kanban: asleep, thinking, working, searching, waiting for you, happy when a turn ends, celebrating when a task is done.
- **Settings → Appearance → Animate mascots** keeps them still; they still show their state with their eyes, as they do when your system asks to reduce motion.
- The chat bubbles, Multichat, the Agents graph and the mobile agent list now show the head picked in the **Avatar** tab.
- Then your main agent's first conversation opens inside the onboarding: it speaks first, greets you by your first name in the language you picked, and writes its character from the card you made instead of asking for its language, name or picture again; beside it, its mascot shows whether it is thinking, working, waiting for your answer or pleased.
- In that conversation, the agent offers to set up what its card asked to run on its own (every day at a set time, on a webhook), creates nothing before your yes, and saves it switched off: switch it on in **Triggers**, under **Routines** for a daily routine or **Webhooks** for a webhook.
- It also offers to recruit two teammates, a coder and a reviewer, who appear beside it in the list; **Later** skips it.
- `timon setup team --coder NAME --reviewer NAME` and `timon setup finish --no-tour`, the CLI counterparts of the setup conversation's new tools.
- Onboarding: Timon installs its background service while you create your account, choose your AI and your profile, instead of holding a setup screen until it answers; a **Preparing Timon** card in the corner follows the service, the local database, the built-in browser and the search for your AIs, and a refused service shows why, with **Try again** and the repair screen. Only creating your agent waits for the service.
- A new welcome screen opens a fresh install: mascots tumble in and pile up (you can grab them), and a language roller, each language with its flag, switches the whole screen to your language as soon as it stops on it, before you create your account.
- `timon agent update --look '<json>'` and the `agent_update` tool set an agent's mascot (head, fur, eyes, accessory); `agent_list` returns it, and an unknown value is refused with the accepted ones.
- Ask an agent to change its look ("put on your chef's hat") and it does it itself with the new `agent_set_look` tool, on itself or an agent it orchestrates, never on another one.
- **Plugins**: `ctx.agents` reads an agent's mascot (`look`) and sets it on `create` / `update`, with the same lists as the Agents page (API 15).
- **Plugins**: a mascot pack adds skulls, furs, eyes and accessories to the mascot configurator, in their own group under the pack's name; an agent wearing a part of a removed pack shows its role's default for it (API 15, template `examples/plugin-mascot-pack`).
- Creating your local account confirms your email address with a 6-digit code sent by email, and **Forgot password** on the sign-in screen resets it with a code; an internet connection is needed for both.
- **Create your local account** follows the welcome screen: first name, email and password on one screen, then the 6-digit code in six boxes, with **Resend** after 60 seconds and **Change email**; the account is created once the code is accepted. Waits and errors from Timon are shown with the time left.
- **Plugins**: the `email.code` slot and `useEmailCode()` let a plugin replace the screen where the emailed code is typed (API 15).
- A banner tells every signed-in account when a newer Timon is published for your channel, with its notes and a download link for your system; **Later** hides it until the next version. A beta build that has ended shows the newer version, with its download link, on its lock screen as soon as Timon has checked, without a reload. Turn the check off in **Settings › Plugins › Timon updates › Check for Timon updates**, or ask now with `timon update check`.
- **Plugins**: the `updates.banner` slot and `useUpdateStatus()` let a plugin replace the "new version" banner (API 15).
- Desktop app: **Download and verify** on the new-version banner (and on the lock screen of an ended beta build) downloads the installer for your computer, checks it against the signed checksum, then opens it or shows it in its folder.
- Desktop app: **Install** on the new-version banner installs the verified update — the AppImage is replaced and Timon restarts, the Windows and macOS installers open, a `.deb` opens in your software manager with the command to run. When missions are running, Timon says how many first and offers **Wait** or **Install anyway**; the **Update Timon from X to Y** screen does the same before moving the service.
- **Plugins**: `useUpdateStatus().download` lets a replacement banner drive that download (API 15).
- The interface is available in Spanish, Italian and Portuguese (Brazil), desktop app windows and menus included: pick it in **Settings › Interface › Language**, or let Timon follow your system language.
- The interface is available in Polish, desktop app windows and menus included.
- The interface is available in Japanese (日本語) and Korean (한국어), desktop app windows and menus included.
- The interface is available in German (Deutsch) and Dutch (Nederlands), desktop app windows and menus included.
- **Official connectors**: the Connectors tab of Capabilities opens with the official MCP servers of 20 services (GitHub, GitLab, Sentry, Vercel, Cloudflare, Supabase, Neon, Notion, Linear, Atlassian, Stripe, Canva…), each with its publisher's logo, connected in one click by signing in with the publisher or with a key kept in the secrets vault.
- **Capabilities**: skills are listed as compact rows grouped by source, and the Skills and Connectors tabs get a table of contents on the left to jump to a group.
- **Plugins**: the `page.toc` slot and `usePageToc()` let a plugin replace that table of contents; any section enters it with a `data-toc` attribute (API 15).
- **Plugins**: the `apps.card` slot and `useAppCard()` let a plugin replace the cards of the official connectors; the `mcp.featured` slot and `useMcpTab()` let it add its own section at the head of the Connectors tab (API 15).
- **Plugins**: the `kanban.card` and `todo.form` slots, with `useKanbanCard()` and `useTodoForm()` in `@timon/ui`, let a plugin replace the tiles of the Kanban and of the TO DO widgets, and the window of a TO DO idea; `BoardCard`, `DetailShell` and `DetailFrame` join the kit (API 15).
- Kanban: an idea of the TO DO notebook can carry files (screenshots, logs, specs), and promoting it hands the task its own copy; agents list, attach and remove them with `project_todo_attachments_list`, `_add` and `_remove`.
- Kanban: attach files to a TO DO idea from its window, by dropping, choosing or pasting them, also when creating it; its card shows a paperclip with the number of files.
- **Plugins**: `ctx.kanban.todos.attachments` lists, adds, reads and removes the files of an idea, and `PluginTodo.attachment_count` counts them (API 15).
- **Plugins**: `ctx.webhooks.asOwner(name, fn)` runs code as a delivery of that webhook would, without waiting for the service to call (API 15).
- Discord connector: a tester's screenshots and logs are attached to the ticket's idea instead of being pasted as paths in its notes; files saved by earlier versions move there at start.
- Kanban: task attachments also accept source and config files (`.py`, `.ts`, `.js`, `.xml`, `.toml`, `.ini`, `.css`), kept as plain text.
- **Plugins**: a plugin route can answer an error with a stable code (`apiError` in `@timon-ai/sdk`), and `apiErrorMessage` in `@timon/ui` shows it in the reader's language (API 15).
- **Plugins**: `@timon/ui` exports the formatters Timon uses for dates, times, numbers, sizes, relative times and lists, in the reader's language (`formatDate`, `formatNumber`, `formatRelativeTime`…, API 15).
- Chat: an agent can ask you for a password, a code or an API key (`secret_request`): a card with a masked field shows who asks, why, for how long and where the value may go (a service, or a website the built-in browser fills it into); **Provide** sends it straight to the vault and the agent never sees it, only whether you provided or refused. Unattended missions (Kanban tasks, sub-missions) are refused at once instead of waiting.
- **Plugins**: the `chat.secret` slot and `useSecretRequest()` in `@timon/ui` let a plugin replace the secret request card (API 15).
- Usage statistics also count, without any name or address, the days the app is opened, which parts of it are used, which features work or fail, how the previous run ended, subscription limits reached, how long agents wait for your answers, completed tasks, first steps reached, and a daily summary of the installation in numbers (see **Settings › System › Privacy** and the docs).
- Licences: Free now includes every feature and every plugin (Machines, the embedded browser, Dreams, the native terminal, third-party plugins…); only additional user accounts need a paid licence.
- **Bots**: the bots list is a widget, shown in an island of its own beside the chat; picking a bot changes the chat without a page change, and the **Bots** card dropped on any other view opens the bot's chat on that view.
- **SUG-0084** — Agents: copy chosen agents (or all of them) to another Timon with **Export** and **Import agents** on the Agents page, or `timon agent export` / `timon agent import`; secrets stay behind, and the preview says when a working folder, backend or model does not exist on the other machine.
- Agents: **Import agents** (Agents and Bots pages, Settings, first-run setup) brings agents from Grok Bot, Hermes or another agent tool, with their identity, memory, text skills, routines and Grok Bot groups as teams; a preview shows what will be created and what stays behind (secrets, history, working files) before anything is written.
- Agents: the **Grok Bot, Hermes or another agent** import card gives Timon's export skill (**Copy the export skill**, or `timon agent export-skill`): pasted to Hermes or Grok Bot, it writes the `.zip` to import.
- Agents: **Import agents** finds Hermes on the machine running Timon and imports the profiles you tick, with no archive to make first; also `timon agent import --hermes [profile…]`.
- **Plugins**: `createTranslator()` in `@timon/ui` takes a plugin's strings in any language, with plurals in one message (ICU), and `getLocale()` returns any language tag (API 15); template `examples/plugin-i18n`.
- **Plugins**: the `agentimport.source` slot and `useAgentImport()` let a plugin add a source to the agent import (API 15).
- **SUG-0078** — Setup: **Skip this step** is offered on every screen of the main-agent step, from the start, to go straight to the cockpit.
- Chat: the missions list can group each mission under the orchestrator that launched it (filter menu › **Group by orchestrator**), each group folding from its mission count; under a role filter, an orchestrator of another role, kept only to place its missions, is dimmed and not counted.
- Anonymous usage statistics, on by default, with a switch to turn them off in **Settings › System › Privacy** (also `telemetry.enabled` in `timon.config.json` or `TIMON_TELEMETRY=0`); what is and is never sent is listed there and in the docs.
- **Plugins**: the `directory.picker` slot and `useDirectoryBrowser()` in `@timon/ui` let a plugin replace the folder browser of Settings, projects and agents on another machine, and the plugin-archive and CLI-binary file pickers there (API 15).
- **Plugins**: the `confirm.dialog` slot lets a plugin replace Timon's confirmation dialog, and `confirmAction()` in `@timon/ui` lets a plugin ask its own confirmations in it (API 15).
- **Plugins**: a plugin whose `engines.node` needs a newer Node than the one Timon runs plugins on is refused at install, with both versions named; one already installed shows the same reason on the Plugins page, and `timon plugin check` reports it.
- Settings → Appearance → Frosted glass: **Where the glass sits** puts it on the whole island (the default) or on each widget and the chat over a clear wallpaper, and any island can choose otherwise from its menu (right click on its tab → **Glass**).
- **Plugins**: `useGlassScope()` in `@timon/ui` tells a widget where the frosted glass sits, so it can match it.
- **Bots**: the list has a search bar at its foot, with **New bot**, **New team** and **Import agents** beside it; a right click on a bot, a team or the empty space opens its menu, a bot is moved into a team by dragging it there or from **Move to a team** in its menu, and **Export** in a bot's menu downloads that bot alone.
- **Plugins**: the `bots.rail.action` and `agent.menu.item` slots, with `useAgentMenuItem()` in `@timon/ui`, let a plugin add a button to the foot of the Bots list and an entry to an agent's menu (API 15).
- Settings → Appearance: **Ambient tint** picks one colour per mode (dark, light) and every background level, border and secondary text follows it — a blue-grey or violet dark mode, a beige light mode — while the accent colour stays separate.
- Customize interface menu: **Appearance** now sits right under the dark theme switch.
- Desktop app: its menus, tray icon menu, Dock menu, taskbar jump list, startup and update windows and dialogs follow the language chosen in **Settings → Interface → Language** (or the computer's language with **System language**); menus change at once, without restarting.
- Desktop app: the boxes shown when Timon cannot start (daemon missing, crashing or not answering, port already in use, interface not coming up, background service not updated) are written in the app's language, or the computer's before one is chosen.

### Fixed
- In a language other than French, the chat's tool descriptions, the calendar event details, the multichat mission picker, the project form placeholders, the cockpit clock and the push notification buttons are no longer in French.
- A plugin installed with `timon plugin add` now loads once its files are in place, without disabling and re-enabling it.
- Chat: the thread no longer shows a “Conversation compacted” line, nor a message of yours, when the agent read an image or loaded a skill without any compaction.
- Plugins: `timon plugin check` no longer fails with a `pack` error when npm is installed but cannot start (no `node` on the PATH); it falls back to the `files` list with its warning, as when npm is missing.
- Desktop app: on a slow computer, the startup window no longer fills itself with the list of startup steps; the steps sit in a small card in the bottom-right corner, and on a first launch the integrity check already shows the welcome screen's colours.
- Onboarding: the screens no longer flash the colours of the theme already installed before showing the Timon theme.
- When a card waits for your answer in a chat, only that card's mascot hops; the agent's other bubbles, and its other conversations, stay still.
- **TIMs**: a TIM created with **New TIM** now appears in the list right away, without reloading the page.
- **TIMs**: clicking the list or the chat no longer draws a coloured outline around it.
- Onboarding: **Customise** on the agent step opens beside the agent's card instead of a panel covering the form; the cards' shadows are no longer cut into a grey box in light mode.
- The titles of the first-run screens now follow the language picked on the welcome screen in German, Spanish, Italian, Japanese, Korean, Dutch, Polish and Brazilian Portuguese, instead of staying in English.
- The sentence under **Create my account** now reads: “We only collect your email in case you want to reset your password. The account you create stays local.”
- When Timon's email service cannot send the confirmation or reset code, the account and password-reset screens now say so, instead of asking for an internet connection.
- The first launch of the desktop app no longer shows the **Starting Timon…** screen with its list of steps before the welcome screen: the window waits in the welcome screen's colours.
- Chat widgets: with borders on, the composer keeps the same margin on its sides as below it; without borders it lines up with the other widgets, with a small side margin on a phone or inside a tab stack. In Multichat, the composer no longer touches the cell's outline. On the cockpit, the side widget columns now end level with the centre.

- Desktop app: when the downloaded update is no longer on the computer, **Install** now says so and offers **Download again** instead of reporting a failed installation.
- **TIM-0144** — The Tasks tile now shows all its text in the selected language.
- Timon's database, backups and configuration are no longer readable by other accounts on the computer: they are now private to your account, and an existing install is corrected at every start.
- Third-party plugins showed translation keys instead of their text.
- Connecting an MCP server through the publisher's sign-in (official connectors included) no longer fails with `dynamic client registration failed` or after the sign-in page.
- A TO DO idea or task popup opened from a widget no longer shows the chat's text through it, and the idea's title field no longer shows a scrollbar.
- With several accounts, a pipeline is private to the account that created it, and so are its runs and their tasks; the built-in `feature-flow` pipeline can be run by everyone and changed only by a superadmin. An agent can no longer make an agent it does not orchestrate work through a pipeline.
- **TIM-0142** — When no agent holds the main orchestrator seat (for example after a rebuilt database), Timon now gives it to the only eligible orchestrator, or raises a notification and a `timon doctor` line listing the orchestrators you can set as main.
- **TIM-0143** — With no main orchestrator, the **Agents** page no longer shows the first agent of the list as main: agents without a manager stay at the root of the graph and of the **Organization** panel, and a warning offers to set an eligible orchestrator as main.
- **TIM-0141** — A Windows path written by an agent in the chat keeps its backslashes before a dot or other punctuation: `C:\Users\toto\.copilot` no longer shows as `C:\Users\toto.copilot`, and a `\\server\share` path keeps its leading double backslash.
- The French interface is complete again: daemon error messages, the **Projects** menu entry and the team choice of the first-run setup are now in French.
- Error messages from the daemon (not found, invalid request, wrong password, too many attempts, task and attachment errors…) now show in the interface language.
- In the dark theme, a Kanban task's popup now stands out from the dimmed page behind it instead of blending into it.
- MCP servers connected with OAuth: neither the agent's MCP configuration nor the server's file holds its tokens any more (they are kept in the secrets vault); Timon relays the calls itself, refreshes an expired token, and a disconnected or detached server answers the agent with an error instead of starting a login. With the secrets vault turned off or locked, a server connected before this version must be connected again.
- Dates, times, counts and sizes across the interface (notifications, licence, machines, devices, Kanban, Git, missions, memory, routines, triggers, secrets) follow the interface language instead of the browser's, and relative times (« 3 min ago ») are written in it, and the workflow pages no longer write « ago » in English whatever the language.
- Texts shown as a raw key or with a placeholder left in braces now read properly: the ages and the “Browse by project” link of the Memory page, the tooltip of the widget catalog's handle, the count of the series graph, the summary of the agent injections tile and a project card's “up to date”.
- Menus: the secondary line and the icon of a highlighted entry (a machine's account, a bot's actions…) now take the entry's colour instead of staying grey.
- Claude account usage: when Anthropic rate-limits the usage check, the gauge keeps the last figures instead of an error, and Timon waits before asking again.
- Frosted glass: a popup island (a terminal opened over the page, for example) is now frosted like a widget, over what lies under it, instead of showing the sharp wallpaper through its title bar.
- Settings → Appearance: dragging a colour picker follows the hand smoothly instead of updating about once a second.
- Frosted glass: an island no longer mixes blurred and unblurred widgets — a transparent widget keeps its island's frosted plate instead of showing the sharp wallpaper, and the chat is blurred like its island.
- **Plugins**: `timon plugin add <name>` no longer replaces a working plugin with an update whose `engines.node` excludes the Node Timon runs plugins on; the installed release stays, or is put back. A bundle's install sheet and `timon plugin add` also name a child that will not load for the same reason.
- Frosted glass: the top bar, the side menu (folded, unfolded on hover or pinned) and the gaps between panels now form one evenly tinted and blurred frame, with no darker band or seam between the menu and the top bar.
- Kanban task popup: fallback and permission overrides can be removed to restore inherited settings.
- Windows: stopping a script whose main process has already exited avoids stopping an unrelated process that reused its identifier.
- Plugins: the Kanban plugin's gallery details include its `task.form` slot.
- Desktop app: the built-in browser works in every window and follows its selected machine; a refused native view uses live video.
- Desktop app: at the next launch each window reopens on the page it showed, such as a window opened on the Kanban, instead of the home page.
- Skipping the assistant setup step during onboarding now ends the setup conversation instead of leaving it running in the background.
- Confirmations (stopping a mission, deleting a task, a secret, an agent, a file…) open in Timon's own dialog, matching the theme, instead of the browser's box.
- **TIM-0135** — Machines: on another machine opened from the machine selector, the built-in quota monitor shows that machine's LLM usage instead of waiting for approval on this computer.
- **TIM-0136** — Connected to another machine, **Browse…** for a folder (Obsidian vault in Settings › Memory, a project's or an agent's working directory) lists that machine's folders instead of opening this computer's picker; in a web browser it now works too.
- **TIM-0136** — Connected to another machine, or in a web browser, **Browse…** for a CLI binary (Settings › AI models) and **Install a plugin** (a folder or an archive) pick on that machine's disk; an archive can still be sent from this computer.
- **TIM-0128** — Desktop app: choosing **Stay** on « You have unsaved changes » while quitting keeps Timon fully running: missions, the built-in browser and the saving of window positions carry on.
- **TIM-0138** — Windows: **Update** on the Copilot CLI card (Settings › AI models) updates the CLI, whether npm or winget installed it.
- macOS and Linux: **Update** on the Copilot CLI card runs `copilot update` on the CLI Timon detects (npm, nvm, Volta, Homebrew or the install script) instead of installing a second copy in `~/.local/bin`.
- **TIM-0139** — Desktop app: back on a machine you switched away from, the machine selector names that machine again instead of staying on **Switching to …**.
- Web and installed web app: after switching machines, going **Back** to the page you left reloads it instead of showing it stuck on **Switching to …**.
- **TIM-0137** — Machines: on another machine opened from the machine selector, the layout presets saved there before 0.1.6 are back in **Customize interface › Saved layouts**, next to those saved since.
- **TIM-0137** — Machines: on another machine opened from the machine selector, each view's arrangement (widgets, islands, chat columns and appearance), the pinned rail, the pinned agent tabs and the pinned popups set there before 0.1.6 come back, unless you arranged them again since.
- **TIM-0140** — Chat split into panels: a panel switched to another agent's conversation from its missions list is titled after that agent, and keeps it when you leave the view and come back by its agent's tab in the top bar, so the split comes back as you left it.
- Widgets: a widget left alone in its column after its neighbour was moved away takes the whole height again, instead of keeping its former share with empty space below.
- Setup: when the main agent's conversation fails (its tools refused, the conversation interrupted or stopped, no answer), **Skip this step** is put forward, with **Restart the conversation** when it stopped, instead of leaving you stuck on that screen.
- Desktop app: when setup installs the background service, Timon restarts on it before you meet your main agent, so that conversation shows its cards instead of failing until the app is reopened.
- A second Timon started on the same data folder (the background service next to the app's own, for example) now stops at once and no longer ends the conversations of the one already running.
- Chat: in the missions list, the avatars of the missions scrolling by no longer show over the open mission pinned at the top or bottom.
- Kanban: an account that may only read the Kanban can no longer create, change or delete a task, nor promote an idea into one; a new task or a change carrying a field Timon does not know is refused and names that field.
- Kanban: an account that may only read the Kanban can no longer close someone else's task, mark a task merged, create, detach or delete its worktree, nor create, change, delete or run a pipeline; a pipeline step carrying a field Timon does not know is refused and names it.
- Pipelines: running a pipeline whose steps set a permission mode or extra tools you may not give a task yourself is refused, and opens none of its tasks.
- Chat: in English, the Grepai block of the right rail (labels, buttons, index age and size) is no longer shown in French.
- In English, the Docker block of the chat's right rail, the cockpit's Dreams tile, the mobile agent list and the memory page's empty rule text are no longer shown in French.
- The remote control API's OpenAPI description is titled "Timon — Remote Control", and the embedded browser's routable hosts default to `timon.localhost` only.

### Changed
- The Google agenda is removed for now — the cockpit **Agenda** widget, `timon agenda`, the agents' `agenda` tool and the plugins' `ctx.agenda` — and will come back once finished; an install that had it switched on starts normally.
- Chat missions list: with **Group by orchestrator**, an orchestrator's missions now start folded (the new **Unfold sub-agents** option opens them by default), and once unfolded they sit on a lightly tinted panel joined to the orchestrator by a thin line.
- The `timon migrate-v1` command, which imported a home from the earlier v1 build, is removed.
- Inviting other people, roles, groups and the audit log move to the **Multi-user** plugin: its **Team** page replaces the **Users**, **Roles** and **Groups** pages. `timon user reset-password` still works without it, and an invitation link then shows "invitation not found".
- Account administration now comes only from the **Multi-user** plugin (pro licence): an existing install's roles, groups and pending invitations are kept for it to take over, and `timon user disable|enable|invite|add-group|remove-group|groups`, `timon role` and `timon group` are removed (`timon user list` and `timon user reset-password` remain). Plugins lose `ctx.roles`, `ctx.groups` and `ctx.users.setGroups`.
- The **Customize the menu** button at the foot of the side menu now shows a painter's palette, like the other appearance menus.
- The guided tour is switched off for now: it is no longer offered after the setup, nor in the appearance menu.
- A fresh install opens on simpler views: the cockpit shows Notifications, your main agent, TODO and Tasks, a project's chat shows Missions, Files, Git and Docker, and the agents canvas starts empty. A dashed **Your widget here** card opens the widget window.
- The **Grepai index** widget is no longer offered.
- After creating your agent, the onboarding opens the **TIMs** page: your main agent speaks first in its conversation and asks what you want to do next — another TIM, or a project with a team of TIMs. The conversation stays open afterwards.
- Agent mascots no longer sit in a circle (top bar, rails, chat card, Kanban, Projects, Agents graph); emoji and picture avatars keep their round frame, and a working agent keeps its animated pulse.
- **TIMs**: the chat no longer has a title bar with a drag handle; the view reads as a single page.
- The **Bots** view is now called **TIMs**: menu entry, page, list, widget card and plugin gallery; its address stays `/bots`.
- The onboarding opens in dark mode for everyone, whatever the system's mode; the switch at the top changes it.
- New Timon logo: the « T » mark, drawn in the theme's primary colour on the sign-in page, the navigation and the top bar. The app, browser tab, installed app and system tray icons show it too, in the new brand colours.

- Agent editor, **Avatar** tab: laid out on two columns, a larger head on the left and, on the right, the Emoji / Image / Mascot switch with the choices of the picked head, all in view without scrolling. The mascot's eyes choices show the screen and its eyes only, the accessory choices the tool only.
- Chat: the message box has a new layout. A strip above it shows the project and the Git branch, with the **Terminal** and **New conversation** buttons; the model, thinking level and permission mode are pills at its bottom left; attach, dictation and the context ring sit beside a round send button. The message box is outlined by default, and a running tool or delegated missions show as a slim strip docked on top of it.
- Creating the first account no longer asks for a licence key: Timon starts on Free (every feature and plugin, one account). Enter or replace a key in **Settings › Profile › License key**.
- A beta build whose licence ends, or that never had one, keeps running on Free; only the build's own end date still stops it.
- The project TO DO widget gives the idea's title the full width: the id and the buttons (mark done, send, delete, with tooltips) sit on a line below it, and the list no longer leaves a gap before the scrollbar.
- Kanban: TO DO ideas, on the board, in the TO DO widgets and in their window, now take the look of task cards; an idea's card on the board can be ticked done, sent to the orchestrator or deleted.
- Notifications: cards stay neutral; the kind shows as one coloured badge, a picto of the source and its word (**Alert**, **Needs you**, **Report** or **Urgent**), replacing the emoji; title and text use the full width of the card.
- Setup: once onboarding is over, Timon opens on **Bots**, with the main bot's chat ready.
- **Bots**: the list is redrawn — main bot centred on top, avatars twice as large, team headings without colour, and no title bar on the Bots view; **Export** left the foot of the list for each bot's menu.
- Widgets: the **Edit Layout** mode is gone. Drag a widget by its title at any time; resting the pointer on a title for two seconds shows the grab hand and a small bar with the grip and the ⚙ menu, also opened by a right click on the title.
- Widgets: the widgets of a column always share its whole height and never run past its bottom; drag the gap between two of them to resize, with stops at 25 %, 33 %, 50 % and 100 % (Shift drags freely).
- Chat: resizing a side column resizes the other one by the same amount (hold Ctrl or ⌘ to resize only one), and the conversation's own width can be dragged from either of its edges.
- Chat: the scrollbar of the conversation has a transparent track, like the widgets'; the **Chat appearance** switches are also in **Customize interface**.
- Chat: the **+** and **⋯** buttons of the side columns are gone: right-click a column's tabs (Menu key or `Shift+F10`, or press and hold on a touch screen) to add or close a tab, add or remove a column, swap or collapse; a column with one tab shows a thin bar that carries this menu.
- Chat: the top of the missions list shows the filter in effect (**All · 300**) with a funnel menu for role, automated missions, grouping and avatar, and a pen to start a new mission; a working mission's avatar pulses instead of showing dots.
- **Plugins**: the deprecated `codexAuth` field is gone from `ctx.system.doctor()` and `timon doctor --json`; the codex entry of `auth[]` carries the same information (API 15).
- **Settings → Interface → Language**: the first entry is now **System language**, followed by every language Timon ships, each in its own name; a browser asking for a regional variant (`fr-CA`, `pt-PT`) gets the closest language available.
- **Kanban**: the **Tasks / Missions** switch at the top right of the board is gone; **Missions** stays in the navigation.
- **Kanban**: a task's card shows its type and status as badges, its priority in the top right corner, its notices (validation required, interruption, block) under its badges, and its graph button with the other actions; in a task's window, the files sit in their own area, in view whatever the tab.
- Desktop app: the Timon executable no longer runs as a Node interpreter (`ELECTRON_RUN_AS_NODE` is ignored); the daemon, the `timon` CLI and the web app run on the Node the package ships.

### Known issues
- Onboarding form details are still in English outside English and French; the step titles are translated.

- Chat: while a turn is being prepared, a tool the previous turn left unfinished can show as still running, with its old duration, until the new turn starts.
- An agent's island card applied to a page other than the one on screen removes the tabs it replaces, but a replaced terminal keeps running: end it from the Terminal page.
- Windows: a CLI installed with pnpm or yarn can keep running after Timon stops or crashes; end it from Task Manager, or install it with npm.
- **TIM-0034** — The installers are not code-signed: Windows SmartScreen or Smart App Control and macOS Gatekeeper warn about them or block them. On Windows, choose **More info → Run anyway** (turn Smart App Control off in Windows Security if it blocks); on macOS, allow the app in **System Settings → Privacy & Security**.
- Windows: a Codex agent in auto or acceptEdits mode cannot `git commit` (Codex keeps `.git` read-only); give its code and merge tasks the bypassPermissions mode, or run them on another backend.
- Windows: on a work or school account of a PC joined to Microsoft Entra ID, Windows may refuse to run Timon's background task; Timon then runs only while its window is open.
- macOS: the usage of a Claude subscription account is not shown in the LLM quotas widget nor under the chat composer; Codex accounts are.
- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- Copilot CLI card: **Update** may update another copy than the one shown, or install a new one, when the CLI's path is pinned in **Settings › AI models › Providers › CLI binaries**, or when it was installed under an nvm pre-release of Node (such as `v21.0.0-rc.1`); run `copilot update` with the CLI's full path in a terminal instead.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, or no reviewer) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- Pi has not been tried with a tester's own model provider yet, so a first mission may fail.
- With Pi as the only backend, conversations keep their default title.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.
- Windows: installing a new version of the app closes the built-in terminal's shells.
- Chat: pressing Escape to close a dialog while dictating also cancels the dictation and puts the message back as it was before you clicked the mic.
- Google refuses to sign in directly from the built-in browser ("This browser or app may not be secure"); use **Sign in with Chrome** in its options menu, which needs Chrome, Edge or Chromium installed outside a snap or flatpak package.
- **Sign in with Chrome** copies the sign-in into the built-in browser; whether Google keeps it valid there over time has not been verified, and a password or 2FA step has not been tried. Run it again if the session is lost.

## [0.1.6] — 2026-11-02

### Added

- **Desktop app**: several windows, each driving its own machine: **New window** in the tray menu (the Dock and File menus on macOS), Ctrl+Shift+N (Cmd+Shift+N on macOS) or launching Timon again opens one more; a window's machine selector switches that window only, its title names its machine, and it keeps that machine's light or dark mode.
- **Desktop app**: right-click Timon in the taskbar or the dock → **New window** opens one more window: the jump list on Windows, the dock or app grid menu on Linux (GNOME, KDE), the Dock menu on macOS.
- **Desktop app**: open a page in a new window on the same machine, to put it on another screen: Shift+click or middle click on its menu entry.
- **Plugins**: `useOpenInNewWindow()` in `@timon/ui` lets a plugin open one of its pages in a new desktop window (API 14).
- **Desktop app**: at the next launch the windows reopen where they were, each on its screen and its machine; a window whose screen is gone comes back on a visible one.
- **Desktop app**: switching machines in a window is instant and finds each of the last three machines exactly as you left it (page, scroll, unsent message, open panels).
- **Machines**: switching machines brings you back to the last page you viewed on that machine (the home page for a machine never visited; the section's main page when what it showed has since been deleted there).
- **Kanban**: a task can carry attached images and documents (PDF, text, Office; up to 15 MB each, 20 per task). The agent that runs the task, and the later iterations and reviews of the same work, receive their paths; they are deleted with the task.
- **Kanban**: attach files from the task form: drop or choose them, see image thumbnails (click to enlarge), remove them. The form also sets a task's fallback, its pipeline and the TO DO idea it carries out.
- **Plugins**: the `task.form` slot and `useTaskForm()` in `@timon/ui` let a plugin replace the task form of the Kanban, the Agents page and the agents grid (API 14).
- **Kanban**: clicking a card opens its task form whatever its status; the form shows the closing report and holds the red **Delete** button. Each card ends with one always-visible row: series graph and priority on the left, open-mission and a red stop (running task) icons on the right.
- **Kanban**: the task form's right column, in three blocks, sets the agent (searchable list with avatars), type and priority (lists with icons and colours), permission (with the models), TO DO idea (with its text), start date, model and fallback model, and shows the dependency count; the Execution and Schedule tabs and the backend field are gone. The start date opens a calendar matching the theme instead of the system date popup. Attached files sit inside the dashed drop zone, the closing report comes after them, and **Delete** carries a bin icon. The form uses smaller text, the closing report sits under the description, and a stored description opens in preview, with eye and pencil toggles.
- **Kanban**: each status column carries a faint wash of its colour from the top-left corner (beige pending, blue in progress, green done, red blocked).
- **Kanban**: a running task's agent avatar pulses and carries its role badge; the card no longer repeats the role, the project or the task and series ids, nor the closing report.
- With a provider that keeps no session, one line in the chat says each message starts without the earlier turns.
- **Mission network**: a chat widget, also opened beside the chat by the new-host alert, lists the hosts a mission contacted (new ones marked) and its recent outbound connections when the connection record is on.
- **Agent editor**: inherited skills open their recipient settings and offer **Exclude for this agent**, with an updated prompt estimate after exclusion.
- Optional record of agents' outbound connections, off by default (`host.isolation.egress.mode: "log"` turns it on): per mission (host, port, status, volume — never the address path), readable with `timon mission egress <mission_id>`, with a notification when a mission reaches a host its project never contacted before. Nothing is blocked.
- **Skills**: a Timon skill's page shows **Who receives this skill** — every agent, a project, an agent role or one agent, exclusions included — and lets you add, change or remove each attachment; changes apply the next time the agents start. Controls your account cannot use, **Exclude for this agent** included, are disabled and name the missing permission.
- Agents can list your island arrangements and save one for you (`islands_arrangements_list`, `islands_arrangement_save`, `timon islands arrangements|arrangement-save`): it lands in **Island arrangements** without changing your screen or the main menu.

- `timon plugin check <folder>` checks a plugin before you send it: manifest, signature, the files that will ship, and personal or machine data left in them, with a file and line for each finding and the points left to check by hand (`--json`, `--strict`, `--deny <word>`). The example plugins pass it with no error.
- `timon backend add|list|test|rm` adds, checks and removes a provider from a terminal, like **Add a backend** in Settings: the API key comes from a hidden prompt or `--key-from-stdin`, never from an argument. `timon doctor` gains a **Backend profiles** section: present, testable, in error.
- Agents can propose one of your island arrangements for a page (`islands_propose` with `arrangement`, `timon islands propose --arrangement`): the card shows its name and sketch, and **Apply** lays it as the **Island arrangements** menu would.
- Installing a bundle now shows, for each plugin it brings, the programs a provider launches and where a dictation engine sends your voice, and lets you authorize each provider's programs on the same sheet.
- Installing a bundle now asks, for each plugin it brings, which of the secrets and hosts it names to grant it, with its own boxes, and says why nothing is asked for a plugin already installed, unreadable before installing, or altered.
- Installing a bundle now warns when one of the plugins it brings takes the id of a package that is no longer installed, and names that package.
- **Settings → Interface → Voice dictation** in the desktop app offers the speech models your installed plugins ship, under **From plugins**: **Add and download** shows where the files come from, their size and licence before anything downloads.
- **Skills**: `timon skill reads <agent>` and the agent tool `skill_reads` show how often an agent's missions read each of its skills over the last 30 days.
- **Settings → Secrets → Connections** lists the messages a messaging integration could not process, with the reason, and lets you replay or discard them. Timon now stops retrying a message after about a day, warns you, and keeps it for the retention period.
- Authorizing a provider's program now refuses it, quoting what it printed, when it is not the program the provider's manifest describes; nothing is allowed or installed.
- Workflows: an **HTTP request** node calls a web service and returns its status and response; vault secrets go in its headers, and the workflow owner needs the *Outbound HTTP calls* permission.

- **Plugins**: `ctx.connections.receipts(connectionId, options?)` lets a messaging plugin show its own connection's queue and the messages that are retrying or failed, read-only (`connections:read`, API 14).
- `timon steer <mission_id> <input...>` and the agent tool `mission_steer` redirect the turn a mission is running, as Enter does in the chat; `timon send` and `mission_send` never stop a turn.
- Model pickers that choose for an agent or a project (composer, task, agent sheet, workflow node) no longer offer a provider whose key that agent or project cannot use, and a model already set on one shows as unavailable.
- **Secrets**: a key can be reserved to a provider from the page with the scope **backend only**, including a provider still waiting for that key.
- **TIM-0109** — Kanban: a task run by another agent than the one it names shows **run by …** on its card, with the reason on hover, and its **mission** link opens that agent's chat.
- **TIM-0109** — Kanban: a done `code` task whose branch never got its merge offers **merged?** on its card, to record a merge made outside Timon and start the tasks waiting for it; `timon task mark-merged <id> --sha <sha>` does the same from a terminal.
- **TIM-0113** — Kanban: the editor of a pending or blocked task offers **Detach the worktree**, which removes its working folder and keeps its branch and commits.
- Desktop app: **About Timon**, in the tray or menu bar icon menu and in **Settings › System › Installation**, shows the app version and the licences of the speech models, Cohere's NOTICE included.
- **Skills on demand**: a skill checked for an agent now adds one line with its description to the prompt, and the agent reads the whole skill when it needs it; **Import** in the agent's Skills tab pastes it whole instead. A skill can also be attached to every agent, a project or a role, or excluded from a narrower one, with `timon skill attach` or the `skill_attach` tool.
- **Skills**: the files next to a skill's `SKILL.md` (`references/…`, scripts) now reach agents that cannot open your disk: `skill_get` reads them with `file`, and an agent with neither Timon's tools nor files gets the text ones pasted (64 KB per skill), the others listed in the agent's Skills tab.
- **Skills**: skills from `~/.claude` and from Claude Code plugins are marked **Not available in missions**; **Import into Timon**, in their popup, copies one into your Timon skills so you can attach it to an agent.
- **Agent injections**: each catalogue skill shows how many times the agent's missions read it over the last 30 days, and a skill none of them read is highlighted so you know to rewrite its description.
- **Skill weights**: the agent's Skills tab shows how many tokens each skill adds in the mode chosen, with a **Context injected at spawn** total; the Agent injections widget also shows what reading a catalogue skill would cost.
- `timon device pair` prints a one-time pairing code and this machine's address, so a headless server can be paired over SSH; `timon device list|rename|revoke` manage its devices.
- `timon mission permission-mode get|set` and the `mission_permission_mode_get` / `mission_permission_mode_set` agent tools read and change a running mission's permission mode, with the same rules as the chat's shield.
- Secrets: grant a vault secret to a plugin from the Secrets page (new **plugin** scope), or from the card a plugin raises when it asks for one, which opens the grant to confirm. The plugin install sheet now says what its secrets and network permissions open.
- **Plugin install sheet**: when a plugin names the secrets and hosts it needs, the sheet lists each one and lets you grant it to that plugin alone with a tick-box before installing, a ticked host being opened to no other plugin; a secret not yet in the vault links to the Secrets page to create it. Plugin authors name them in the manifest with `secrets` and `http.hosts`.
- Plugins: a provider can answer its agent's own questions and plan approvals with Timon's question cards, have Timon check its program's version banner before running it, and list what it has not verified, shown as an **Unverified** chip in the model picker. The Cursor template uses all three.
- **SUG-0005** — **Your AIs**: a new setup step, with the same cards in Settings → AI models → Providers, shows each AI tool (Claude Code, Codex, Grok, Copilot CLI, opencode, Hermes, Pi) with its state, installs it with the vendor's official installer while showing that installer's output, signs it in with **Sign in**, and offers **Update** when a newer version is out.
- New plugin documentation page, *Ship to someone else*: the rules that make a plugin installable by another person (no absolute path or personal data, everything in the package, settings and secrets through Timon) and the check to run before sending it.
- **Interface in French**: Timon now follows the language of your browser or computer (English or French), and **Settings → Interface → Language** lets you pick one.
- **Side menu**: plugin pages can be reordered and hidden like Timon's own, and **Customize the menu** now lets you add, move and remove separators and put any page at the bottom of the menu, above Settings. An agent's menu proposal can set the order, separators and bottom pages too.
- **Island arrangements**: save how a page is split into islands under a name, lay it on any other page from the appearance menu, or show it in the main menu as a page of its own; saved arrangements and saved layouts bring back the agents and a new terminal, not that day's conversations and shells.
- **Agent navigation**: an agent can now find and take you to the pages your plugins add, not only Timon's own; it only sees the plugins your account can open.
- **SUG-0079** — Steer an agent while it works, on every backend: Enter sends your message into the running turn, Ctrl/⌘+Enter queues it for the next one. You can swap the two in the chat's appearance menu.
- **Pi**: agents get Timon's tools (Kanban, questions, missions, memory) and the MCP servers configured for them, follow their permission mode with Allow/Deny cards, show Pi's reasoning in its own block, switch model mid-conversation and take a steer into the running turn.
- **TIM-0129** — Compact a conversation in one click from the context gauge: its panel shows the window used, the model and the conversation's tokens, and the compaction's progress, which the gauge's ring also shows while it runs. Claude and Grok compact in place and the conversation goes on; other backends continue in a new conversation that opens by itself, and **Compact onto another model…** compacts at once, with no confirmation step.
- A compaction shows in the conversation as one line with the tokens before and after, the summary folded under it, instead of messages that looked like yours.
- **TIM-0121** — Kanban: when a review or merge blocks on its sandbox while its code ran on another backend, the "Task blocked" notification says so and gives the commands that move review and merge too.
- **Agent trash**: deleting an agent moves it to a trash from which it can be restored — the editor's toast, Settings → System → Backups & trash, `timon agent trash restore` or the `agent_trash_restore` tool. Deleted agents are purged after 30 days by default.
- **Backup retention**: choose how many nightly archives to keep and their maximum age in Settings → System → Backups & trash (or `TIMON_BACKUP_KEEP` / `TIMON_BACKUP_MAX_AGE_DAYS` in `timon.config.json`); older archives are deleted right after each backup.
- **Working agents widget**: the top bar's agent tabs are now a widget you can move into the nav rail, the cockpit, a chat column or an island, or remove, in Edit Layout. Its options show every agent or only the orchestrators, or group the tabs by project with the project's agents listed on hover. It replaces the Agents list card.
- **SUG-0080** — Reorder your pinned agent tabs by dragging one onto another, or with Move left / Move right in the tab's right-click menu; the order is kept for your account.
- `timon doctor` lists the Timon background services left behind for a data directory that no longer exists, with the commands that remove them.
- `timon service install` refuses a data directory inside the system temporary folder, where the service would outlive the folder; `--allow-temp-home` installs it anyway.
- **Hermes Gateway**: use several Hermes gateways from one account, even when they serve the same profile — each one gets its own Timon agent (`hermes.<connection>.<profile>`), and **Settings → Hermes Gateway** shows which agent reaches which gateway.
- **Edit a plugin connection** in Settings → Secrets → Connections (address, Hermes profile, key, local network) without deleting it: a key left empty is kept, and a new address or local network access waits for an administrator's approval again.
- The desktop app window reloads with Ctrl+R or F5 (Cmd+R on macOS), and Ctrl+Shift+R (Cmd+Shift+R) reloads it past the cache.
- **Teach an agent by recording a browser flow**: press ● in the built-in browser's address bar, do the flow once, review the steps (passwords, one-time codes and card details are never recorded; possible secrets are flagged for you to mask), then **Learn** turns it into a new skill (it never changes your existing ones, and runs on an agent whose backend can work without a shell or file writes) you can attach to an agent and run from a chat or a routine.
- **Point at a page and tell the agent what to change**: press ✎ in the built-in browser's address bar, click an element (the page does not react), type what should change in the bubble that opens on it and press Enter; annotate as many elements as you like, each marked by a numbered pin, then **Send** posts them all to the agent's conversation in one message, shown as a card. The agent marks each one resolved or dismissed on that card, and gets the page's text and source file only for pages served from your own computer or network.
- **TIM-0061** — Voice dictation now works in the desktop app, from the chat mic and the cockpit voice mode: a speech model is downloaded once, when you accept it (Canary, 207 MB, for English, French, German and Spanish; Parakeet, 670 MB, for Auto and other languages), then dictation runs offline and your voice never leaves your computer.
- **Settings → Interface → Voice dictation** in the desktop app: choose the dictation language or Auto and how provisional text shows, download, pause or delete speech models, pick a model per language, or add a model from a local folder.
- **Cohere Transcribe**, a precise dictation model for 14 languages in the desktop app: 2.9 GB, up to 3.6 GB of memory, final text only and a language to choose (no Auto); Download shows its size and memory before it starts.
- **Dictation engines from plugins ask before they hear you**: the plugin's card, its install sheet and the Voice dictation settings say where each engine sends your voice, and the first dictation with it asks your consent on that machine, again if an update changes the destination. The Plugins gallery filters **Dictation** plugins.
- **Choose your dictation engine** in Settings → Interface → Voice dictation: Automatic (as before), your browser's, Timon's local engine or one from a plugin, with that engine's own settings shown below it; a chosen engine that is unavailable is reported, never replaced by another one.
- **Quit and stop the background service**, in the tray icon menu: ends the daemon and the programs it started, then quits; the service starts again the next time you open Timon. From a terminal, `timon service stop` and `timon service start` do the same (Windows asks for permission once; a macOS launchd daemon asks for an administrator password).

- Chat: a brain icon marks the thinking level in the composer bar, and a new shield next to it changes the conversation's permission mode; the change applies from the next message.

- **Machines** (paid licence, off by default, in Plugins): pair other Timon machines in **Settings → Plugins → Machines** with the code they show, then switch the whole interface to one of them from the foot of the menu, in the same window, with the account you act as shown. Each machine keeps its own light or dark mode, like its primary colour. A machine that stops answering, runs an incompatible version or has an expired licence offers a way back to this computer.
- **Machines**: notifications raised on your other machines appear in this computer's notification centre, titled with the machine's name, and reach your phone; **Approve** / **Deny** answers the machine that asked, and opening one switches the interface to that machine.
- **Machines**: on another machine, a project's built-in browser shows and drives that machine's browser from a web browser or the installed web app, as on this computer; that machine needs the Timon desktop app running.
- **Machines**: on another machine, a third-party plugin's interface loads only when the same signed version is installed and enabled on this computer; the gallery marks the others **To approve on this computer**.
- **Settings → Access & network → Devices** authorizes a new device with a one-time pairing code (valid 5 minutes, with where to enter it and this machine's address when known) and lists the devices connected to your account, to rename or revoke them. **Enter a code from another machine** opens the Machines form, or says why Machines is unavailable. When no address is known, **Make this machine reachable** publishes this machine on your tailnet with `tailscale serve` (never on the internet) and shows its address; when Tailscale is missing or signed out, the card installs it from Tailscale's official site (no Homebrew on macOS) and signs the machine in first.

- The built-in `create-timon-plugin` skill now builds plugins that anyone can install: self-contained data, English, neutral defaults, no author paths or names, declared dependencies, no lock-in to one model provider, a first-run setup, upgrades that keep the user's data, and a pre-ship check to run before sharing a plugin. Installs that already have the skill get the new version unless they edited it.

- The built-in `create-timon-plugin` skill now asks whether a plugin gets its own page in the side menu, and if so builds the page together with its menu entry and picto.

- The built-in `create-timon-plugin` skill now has a plugin that works with an agent open that agent's chat beside its page on the first visit, with a button to bring it back.

- **One model picker everywhere**: the chat, the series plan, Kanban task cards and the task form, agents, workflow nodes and the conversation-title setting all choose a model the same way, with a search across every provider, per-user favorites, and each subscription account as its own entry in the left rail. Plugins can replace this picker everywhere in the interface (slot `model.picker`, `useModelPicker()` in `@timon/ui`, API 13).

- **Model presets in the series planner**: save the models chosen for each role as a named preset, then apply it in one click to the primary models, the fallbacks or a group of tasks.

- **OpenRouter provider pack**: a ready-to-install example plugin adds OpenRouter as a backend once you enter your OpenRouter key in its settings, with OpenRouter's current model list in the selectors.
- *Add a provider* documentation: a recipe for a self-hosted LiteLLM proxy, through the Anthropic protocol (`/v1/messages`) or OpenAI Responses (`/v1/responses`).
- Plugins: when a mission is refused because a third-party provider's program changed (moved, a link now leading elsewhere, authorization removed), a notification card says so and opens **Settings → AI models → LLM backends → Providers** on that provider, with its authorization dialog ready to confirm.
- Plugins: `@timon-ai/sdk` exports the `PluginPolicyError` type (`name`, `pluginId`, `rule`), so a plugin can tell a policy refusal apart from other errors; the API reference documents it.
- Plugins: `@timon/ui` exports `NativeViewCover` (API 14), so a panel a plugin mounts in its own portal shows above the desktop's built-in browser instead of under it.

### Fixed

- **Plugins**: plugins that need Node.js 22, such as Growth Studio, now run in the installed desktop app: its background service runs on a Node.js 22 shipped inside the app.
- **Desktop app**: launching Timon again after an update installed while it was running now asks you to restart it, instead of opening a window whose new-window controls did nothing.
- **Chat**: an agent's text, tool chips, reasoning, tool details and copy / read-aloud buttons now start on the same left edge; on a phone the agent's name lines up with them too.
- Kanban: clearing a task's start date in the task form now removes it; it used to stay scheduled.
- Chat: reloading a conversation while a turn is being prepared (a context summary, a launch) shows the agent working and follows the turn; a message sent then waits for its turn instead of being refused.
- Windows: stopping a CLI that Timon started (cancelled sign-in, timed-out installer or script) also stops the processes it launched.
- macOS: a Timon opened on another data folder no longer mistakes the installed service for its own, and can no longer stop or restart it.
- Skills: `skill_get` and `skill_list` show vault values as `***` to agents, and an agent can no longer overwrite them by saving that text back; the skill editor still shows the real text.
- The system prompt log (`TIMON_LOG_SYSTEM_PROMPT`) and the skill weights of the agent editor no longer show vault values.
- **Agent injections**: a masked item now says whether the agent still receives the value in clear (**masked here**) or not (**masked when sent**).
- Linux: the background service no longer exits with an error when the app's own daemon stops at the moment the service takes over from it.
- Chat: the "thinking" indicator no longer stays up forever once the daemon says the turn is over and none is on its way.
- Chat: a conversation deleted or no longer yours from another window stops showing "thinking" and stops reconnecting every 5 seconds.
- Chat: a background sub-agent that speaks after a finished turn now shows the agent as working.
- Linux: `timon service install`, `timon service start` and the install button no longer start a second service on a data folder that another Timon's service already uses; the refusal names that service, and `timon service install --force` replaces it. A service systemd cannot confirm is refused too, and `--force` leaves it in place.
- Pressing Ctrl-C at the hidden prompt of `timon auth claude-token set` now exits cleanly with code 130, without an error message.
- At the hidden prompts of `timon backend` and `timon auth claude-token set`, Ctrl-D now cancels on an empty line and does nothing on a line in progress, and arrow keys and other control characters no longer end up in the value.
- **Windows**: the background task of an existing install now names your account by its SID, as new installs do, so Windows cannot mistake it for another account. The first launch after this update asks for the Windows permission once more to rewrite the task; if the new task does not answer, the previous one is put back and Timon tries again at the next launch.
- An orchestrator moved to its fallback while stopped now shows it in its chat, and your next message there gives the new backend the conversation.
- A Kanban task that keeps crashing while its backend is out of quota no longer restarts indefinitely: after a few failures it counts them like any other crash, then stays **Blocked** and notifies you.
- A Kanban task with a working fallback now starts on that fallback while its backend is out of quota, even when the backend's usage cannot be read.
- `timon service install` no longer replaces a service that belongs to another Timon installation: it refuses, names that service's data folder and program, and goes ahead only with `--force`. `timon service uninstall`, `stop` and `start` refuse it too, and `--dry-run` no longer says the service was installed.
- `timon send` and `mission_send` now say that a conversation's fallback did not start, with the reason, instead of claiming that no fallback is available.
- **Providers**: when a program cannot be checked at authorization because its identity pattern is too slow, the refusal now names the field to change in the manifest, `provider.binaries[].identity`.

- **Settings → Secrets → Connections** and `ctx.connections.receipts` now mask a vault value in a message's failure reason even when the value was added after the failure.
- **Skills**: on a backend that reaches neither Timon's disk nor its tools, a vault secret written in a skill or in the files next to it is now sent as `***`.
- **Skills**: on the same backends, the files pasted next to several skills now stop at 128 KB per prompt, and the agent is told which files were not sent.
- **Skills**: the agent's **Skills** tab now names, under each skill, the files that this 128 KB limit holds back, and shows the skill's weight without them.
- **Skills**: `timon skill get` and `skill_get` no longer list a file next to a skill that they refuse to read, such as a name containing `:` or `\`.
- An open chat now shows the agent working as soon as it goes back to work by itself after a background job, instead of looking idle until the turn ends.
- `timon backend rm` now names the key that left the vault, and mentions none when the backend had no key of its own: a shared secret its profile references stays in the vault.
- Pressing Ctrl-C at the hidden key prompt of `timon backend` now exits cleanly with code 130, without an error message.
- In the agent editor, a skill inherited from a wider scope now names the files a backend that cannot read skills on demand will not receive, as a checked skill already did.

- **TIM-0134** — A Kanban task stopped by a usage limit no longer retries before the announced reopening or uses up its automatic retries: it restarts on its own two minutes after that time, even when the coordinator agent is out of quota on the same account.
- When an agent's session can no longer be found, the conversation now continues from its recorded history instead of starting blank, and a card in the chat says whether the history was replayed, summarized, cut to its end, or lost.
- An autonomous mission that went back to work by itself after a background job finished is no longer stopped as idle in the middle of its work, and the agent that delegated it now receives its final answer.
- An orchestrator whose account runs out of quota now moves to another of your connections of the same provider, then to its usual fallback; when nothing is usable it stays stopped and you get one urgent alert saying what to do. The quota notice now arrives once, to the agent piloting the series, and says when the orchestrator did not move.
- Moving a conversation off an account that is out of quota now takes effect. A target out of quota is refused at once, and a model that cannot start leaves the conversation where it was, with the reason in the thread.
- A provider plugin whose program check uses a pattern that never finishes, or whose program ignores being stopped, no longer freezes Timon: the program is refused after a short limit.
- **Workflows**: a loop edge now runs its target and the nodes after it again each time it is taken, up to its **Max iterations** (100 at most); it was accepted but never followed. `{{loops.<edge>.count}}` gives the pass number.
- **Plugin install sheet**: **Secrets and network** now explains every secret or network permission the plugin does not name, and says that hosts can also be opened to that plugin alone or reached through an approved connection.
- **Islands**: an agent's card, or a saved layout applied to every project, now also closes the tabs it replaces on pages not on screen and ends their terminals' shells; the card lists them per project first, and a terminal shown on the current page is kept.
- **Workflows**: a template or condition that names a node created in the builder, such as `{{nodes.agent-1.output.text}}`, now reads that node's output instead of staying as typed or being refused.
- A trigger's **Webhook (send)** action only reaches public addresses: a private or local network address, this machine or a cloud metadata address is refused, including through a name that resolves to one.
- Applying an agent's island card now closes the tabs it replaces on the page on screen, and the card names them first: a replaced terminal ends its shell. A document with unsaved changes can keep its tab: nothing changes and the card stays pending.
- Workflows: a **script** node now needs the **Run scripts on the host** permission on the workflow owner's account, at publish and at every run; an agent can only propose one, never write, publish or run it itself.
- Multichat: **Paste into a terminal** on a command card in a cell opens the terminal of that conversation's project and types the command there, instead of only copying it to the clipboard.
- An HTML card shown by an agent whose page asks for the full window height (`min-height: 100vh`, `height: 100vh`) no longer keeps growing up to its maximum height: it fits its content, or keeps the height it was first shown at.
- Multichat: the **Terminal** button of a cell now files its shell under that conversation's project, or its agent, instead of **No project**.
- The cockpit Agenda tile and its week view decide "today", "tomorrow" and overdue Google Tasks in your own time zone instead of Paris time, so due dates no longer shift by a day around midnight outside France.
- **Bots**, **Terminal** and the workflow builder, run and trace pages fit their island: opened next to another island, their bottom (the chat's message box, the terminal's prompt) is no longer cut off.
- Kanban: a task whose worktree was detached no longer leaves its `timon/task/…` branch in the repository once the task is done and merged.
- **LLM quotas** widget: the refresh button now reads fresh figures from Claude, Codex, Grok and Copilot CLI, instead of showing the last cached reading or a recent error for up to a minute.
- Renaming an agent now updates event trigger filters that spell its exact name with **contains** or a plain regex, and the agent form lists the triggers it could not update, each of which also notifies its owner.
- macOS: **About Timon** in the application menu opens Timon's own window, with the licences of the speech models, instead of Electron's panel.
- The vault graph widget, the vault page and the note preview now follow the interface language; some of their labels always showed in French.
- Workflows: a run whose condition, switch, human question or agent route left a branch untaken now completes; it stayed *running* forever.
- Workflows: a script node now continues by its `done` port, and a wired `failed` port catches its failure instead of failing the run.
- Workflows: nodes created without a position (command line, API, agent proposal) are laid out on the canvas instead of piled on top of each other, and **Tidy** orders each column so fewer edges cross.
- A role without the matching permission can no longer start, stop or rebuild containers, Grepai watchers or the daemon, nor read their status, by calling the API behind the chat's cards.
- **Machines**: on another machine, the screen layout is the one of the account you act as there, as when you open that machine directly and as its agents see it; administration pages, greyed buttons and "your" missions follow that account too.
- Layout: with the same view open in two windows, a change refused because the other window had just saved is now applied on top of that window's layout instead of being dropped.
- A role without the chat's Git card can no longer read a project's branches, changes, commits or remotes through the API, and no longer sees the branch above the message box; a role that opens **Agents** still sees its project cards' publication state.

- Workflows: a run whose condition, switch, human question or agent route left a branch untaken now completes; it stayed *running* forever.
- Workflows: a script node now continues by its `done` port, and a wired `failed` port catches its failure instead of failing the run.
- Workflows: nodes created without a position (command line, API, agent proposal) are laid out on the canvas instead of piled on top of each other, and **Tidy** orders each column so fewer edges cross.
- Skills checked on a Hermes Gateway agent now reach it as their full text; it only received a line it had no way to follow up on.
- Deleting an agent revokes the secrets and browser profiles granted to it: an agent created later under the same name no longer inherits them, nor the old agent's signed-in browser. A restored agent gets its own browser back; its secrets must be granted again.
- Skills page, agent editor and the chat's Skills rail: a project's skills (`.claude/skills`) are now described as loaded natively by Claude Code agents only, no longer as available to every agent.
- An agent created under the name of a deleted agent no longer receives the old agent's memory rules; restoring the deleted agent from the trash brings them back.
- `timon wait` and the `mission_wait` tool no longer return the error of a turn Timon is about to retry after a provider outage: they wait for the retried turn's answer, and the mission shows as working meanwhile.
- **Agent injections**: a skill the agent opened as a file now counts as read, and a backend without the `skill_get` tool shows **reads not measured on this backend** instead of flagging its skills as never read.
- An agent created under the name of a deleted agent no longer inherits its checked skills; restoring the deleted agent from the trash brings them back.
- **Context injected at spawn**, in the agent's Skills tab, now gives the exact total: it counts exclusions and project, role and global attachments, follows a role or project changed before saving, and names a checked skill the agent excludes.
- Removing a plugin closes the secret consent cards it raised, so their **Grant** can no longer give the secret to another package published later under the same id.
- Security: `timon plugin remove` now sends the plugin's user connections back to approval and deletes their keys (bundle children it removes included), so a package installed later under the same id can neither reach those addresses nor read those keys; the command lists them.
- **Agent navigation**: an agent no longer offers to take you to a page of Timon your account's permissions do not open, such as **Users**.
- `timon wait` and `mission_wait` no longer return the half-written text of a turn you redirect while they are waiting: they return the answer of the redirected turn.
- Skills: an `allowed-tools` list written over several lines (`allowed-tools: [` then one entry per line, or `>`) now pre-authorises its tools instead of none.
- Skills: a `SKILL.md` saved with Windows line endings no longer loses its name and description in the skills list.
- Triggers: pressing Escape in the trigger editor after changing something now asks before discarding the draft instead of closing it.
- Windows: Claude Code and Codex installed with npm no longer keep running after Timon stops or crashes.
- On a busy machine, the Git picker no longer loses the agent's branch or says the agent works in another repository, and the Git panel no longer says "not a git repository", when git is merely slow to answer.
- An install whose main agent was never renamed through onboarding no longer loses it once a pole is led by another orchestrator: recaps and notifications reach the main agent again, and the app finds it.
- **Secrets**: only a superadmin can remove **backend only** from a key that keeps other scopes, since that shares the key with those projects or agents on every provider.
- **TIM-0133** — Windows: `timon import --force` no longer fails with `EBUSY` on `timon.db` when Timon is closed, and a database held by another process now stops the import before anything else in the Timon folder is replaced.
- Events page: each event shows the agent of its mission instead of `_main`, and an event whose mission was deleted shows the mission's short id.
- **TIM-0130** — Desktop app: a dialog, a side panel or a menu opened above an embedded browser (the agent settings, for instance) now shows on top of it instead of behind it.
- **TIM-0132** — Files: **Rename** in a row's right-click menu turns the name into an editable field (Enter to apply, Escape to cancel); **New file** and **New folder** ask the name the same way, so all three work in the desktop app. Changing only the case of a name (`notes.txt` → `Notes.txt`) now works on Windows and macOS.
- Security: a project's `opencode.json` can no longer make an opencode compaction or summary load an npm package, read a file or environment variable, or send your stored keys to an address it chooses; only an address on this machine is accepted, a provider on another machine goes in your global `opencode.json`.
- Chat: with **Only my conversations**, a conversation you keep writing in after an agent's message woke it no longer disappears from the list.
- Git and Files widgets: an agent folder the system refuses access to (a protected macOS folder) now reads as access denied, with the system's code, instead of not found.
- A Kanban task assigned to an agent installed from the ACP registry no longer fails when Timon starts: it waits until that agent has been checked and registered.
- Grok: with `GROK_AUTH_DIR` pointing outside `~/.grok`, Grok missions now start signed in.
- LLM quotas: on Linux and Windows, a Claude subscription account no longer shows a stale gauge after a few idle hours; its session is renewed when its usage is read.
- The web interface no longer stays down after its third normal exit since the daemon started: only repeated exits within the hour now stop it.
- Multi-user: a subscription account that is not yours, or not assigned to you, is now refused when you save it on an agent, a task, a series rule or a project role, instead of failing later when a mission starts; project roles also follow the same permission limits as agents for non-administrators.
- Renaming an agent now carries over the workflows and pipelines that run it, the chat cards that show it and the multichat templates that place it.
- Deleting an agent no longer leaves the agents that reported to it or delegated to it unable to save their settings; restoring it from the trash puts those links back.
- Plugin API reference: the `PluginManifest` page now lists every field of the manifest, with the values `kind` accepts.
- Codex: the command shown to sign in when Codex keeps its sign-in in the system keyring is now the same everywhere (`codex -c cli_auth_credentials_store=file login`) and works in PowerShell and the Command Prompt.
- Laying a named island arrangement or a saved layout on the current page closes the tabs it replaces: a terminal it removes ends its shell, and a document with unsaved changes asks first.
- Applying a whole island arrangement proposed by an agent no longer closes your popups.
- When the islands are shown one at a time (phone, or a window too small for them), each tab has its menu again (right click, Menu key, or the arrow of the shown tab): Detach, Close, and move it left or right within its island; on a computer the tabs can also be dragged to reorder them.
- Switching a mission to Bypass permissions now asks in a Timon dialog, with Cancel focused, instead of the browser's native prompt.
- Desktop: when the daemon does not answer at startup and the notification area icon is missing, the message now says to launch Timon again instead of pointing to the tray.
- Settings search announces "1 result" instead of "1 results" to screen readers.
- Question form: the selected option is highlighted again in light theme.
- A pinned navigation rail is shown pinned as soon as a page is reloaded, instead of opening collapsed then widening.
- Plugins: a bundle picked as a folder in the gallery now installs its plugins kept in neighbouring folders, as `timon plugin add` does.
- Chat: leaving a conversation while an older prompt recalled with ↑ is shown no longer replaces the message you were writing.
- Chat: the empty message field shrinks back to its placeholder when you switch to another agent.
- Skills page: the card of a skill masked by another one with the same name now opens that skill, not the one masking it.
- A `timon` command run from a terminal while the app applies an update now waits for it ("another Timon process is saving and converting your data") instead of making a second pre-update backup and converting the data at the same time.
- An agent's picture can only be one Timon stores: a web address is now refused, and an agent that had one shows its emoji or initial instead of a broken image.
- A project's logo is an uploaded picture, an emoji or a short text: a web address is now refused, and a project that had one shows its initials instead of a broken image.
- A plugin that leaves an error unhandled in a background task, a timer or an event listener no longer stops Timon and its running agents: the error is logged under the plugin's name and a notification names the plugin.
- The "Plugin … failed" notification, the Web Push test notification, the agenda and Google Tasks text agents read, and the dates in backend fallback notifications are now in English, whatever your computer's language.
- Web Push now uses a `TIMON_VAPID_PRIVATE_KEY` stored in the secrets vault.
- Kanban planner: reloading the page, or a planner card that expired and comes back, now keeps the pipeline, models, group settings and note you had already chosen in this browser tab.
- **TIM-0109** — When the disk fails while Timon is already running (disk full, I/O error), the daemon now also waits a minute before restarting.
- `timon export`, the nightly backup and the copy kept before an update now include your messaging integrations' connections and message history, which an import used to lose.
- A conversation keeps at most 1 GB of media shown by its agent; past that, the agent is told the limit is reached instead of filling the disk.
- A workflow run with thousands of steps opens quickly: its trace shows the workflow steps and the 2,000 most recent others, and loads a step's input and output when you open it.
- Delivered messages of a messaging integration are deleted after 30 days (`TIMON_INTEGRATION_RECEIPT_RETENTION_DAYS`), and with **Hot retention of the events table** set, the traces of missions finished for that long are deleted too.
- Stop: `timon stop` and **Stop everything** now also cancel the workflow runs in progress of the agent or project, which could otherwise start a new mission on the stopped agent.
- Stop: `timon stop` and **Stop everything** now also switch off the workflows that would start a new run on the agent or project (schedule, webhook, event or plugin entry), and they stay off after a restart.
- Agent injections: next to a chat, the widget now lists the skills the open mission adds to the agent, such as those of a Kanban task.
- Skills: a skill written in the standard format now has its `allowed-tools` taken into account, whether listed on one line, inline or one entry per line.
- Routines: an account now only lists, edits and deletes its own routines (a superadmin still sees them all), and managing them needs the **Manage triggers** permission, as for any trigger.
- Nightly backup: only a superadmin can now see its status and archives or switch it on; other accounts and their agents are refused.
- Plugins: `ctx.backup.status()` now answers only a superadmin's request or a background job; a request from another account is refused.
- **TIM-0079** — Chat: when no main agent can be found, the screen now says why (agent list unreadable, no agent designated, or no orchestrator) and lets you make one of your orchestrators the main agent in one click.
- **TIM-0079** — macOS and Windows: Timon finds the main agent again when its recorded name differs from the agent's folder only by upper/lower case.
- A plugin route that fails no longer stops Timon and its running missions: the request gets an error answer and the failure is logged under the plugin's name.
- **TIM-0111** — A Codex conversation keeps its context after its mission is stopped or its task closed: the next message resumes the same thread instead of starting a new one, and a stopped Codex mission no longer stays shown as running.
- **TIM-0111** — Codex: a task return now goes back into the Codex conversation that launched the work instead of opening a new one, and stopping a Codex turn no longer warns that the conversation will be lost.
- The folders Timon keeps for each Codex or Grok mission are now deleted 30 days after the mission ends (setting `TIMON_PROVIDER_SESSION_TTL_MS`), instead of piling up on disk.
- Windows: the skills and commands of a project's `.claude/skills` and `.claude/commands` folders can be edited and deleted from Timon.
- Windows: moving or renaming an entry that sits in a subfolder of the Files widget no longer fails with "path escapes agent cwd".
- Plugins: an archive holding a file name Windows refuses (`CON`, `aux.txt`, a `:` in a name, a name ending with a dot) is refused before install with a message that says so, on every OS.
- Opening Settings from the machine switcher ("Add a machine…", "Manage connections") or from the appearance menu no longer leaves the page unresponsive to clicks after Settings is closed.
- Settings: "Allow remote access over HTTP" and "Cockpit Google account" now take effect, after the app or the daemon restarts.
- Islands: a tab holding a widget that has since moved to another plugin (Skills, MCP servers, Files, Git) shows the widget again instead of "widget not found".
- Triggers: copying a webhook secret or address says "copied" only once it is in the clipboard; if the copy fails, the secret is shown selected so you can copy it by hand instead of losing it.
- Triggers: the trigger editor, secret, test and journal windows keep keyboard focus inside them and close with Escape; a click beside them no longer closes them, and Escape does not close the secret window until the secret has been copied.
- Mission programs (Claude Code, Codex and the like) no longer keep running once their daemon is gone: quitting Timon in portable mode on macOS and Linux, `timon service stop`, **Quit and stop the background service** and the next start after a daemon crash now end them.
- Agents: the active agents strip, the Agents page, Multichat and the mobile agent list show an agent waiting for your approval as soon as the card appears, and clear it as soon as it is answered or expires.
- Workflows: an agent step whose mission is stopped now fails at once instead of staying "running" for up to 30 seconds.
- Security: an account that manages secrets without being an administrator can no longer give a secret to an agent or a plugin by editing it; only an administrator decides who receives a secret.
- **TIM-0100** — Missions: a link to a mission from Messages, Pipelines or another mission's parent/child list now opens that mission's detail panel.
- **TIM-0079** — Agents: Timon finds your main agent again when it was renamed or created by hand next to workspace hubs (`_main.<workspace>`), instead of showing "Unable to find the main agent".
- Agents: the agent editor opened without a chosen agent now shows your main agent, even after you renamed it.
- Updates: a `timon` command from a newly installed package no longer updates your data before the app has asked for your approval and saved a copy; it says to open the app first, and `timon doctor` still reports what it found.
- Updates: after you already approved an update, opening Timon again no longer shows the update screen a second time, and a data folder whose recorded version cannot be read now shows the update screen instead of an app that stays unavailable.
- Kanban: a review agent closes its review with a flag `timon task done` accepts, including reviewers created before this version, instead of failing its close and leaving the review without a verdict.
- Kanban: a task whose agent finished while Timon was restarting no longer closes with an empty report; its card says it was closed automatically, and a task stopped by a quota limit is blocked instead of marked done.
- Kanban: the end-of-batch recap reaches the orchestrator once the reviews and merges of the batch's coding tasks are done, instead of as soon as the last coding task closes.
- Kanban: a task blocked because its AI ran out of quota, credit or availability restarts on its own as soon as that AI is available again or a fallback can take it, even outside a series, instead of staying blocked until someone restarts it.
- Kanban: an account without the `agents:privileged-config` permission can no longer reach a backend it may not select (Codex, Grok…) through a task's fallback or a series' role or fallback rule; it is refused with `403 forbidden` and the reason, as for a task's own backend.
- Windows: `timon service status` and `timon service repair` say why the session witness cannot be opened, and a newly installed background task records that cause once in `daemon.log`.
- The subscription note of Claude and Grok in the agent editor no longer shows in French in the English interface.
- Error messages, notifications, logs and CLI usage lines of the background service are in English; route errors, plugin install and signature errors, memory and out-of-memory alerts, deploy and Kanban chain notices no longer show in French.
- Agents seeded by Timon, the librarian, conversation handovers, memory curation and dreaming now answer in your language instead of always in French; their instructions are in English.
- The push notification setting follows the interface language, and its "not configured" hint points to the VAPID keys in the vault instead of a `.env` file.
- Git: pushing, fetching, creating the GitHub repository, switching or deleting a branch of a project now needs the *Create, update and delete projects* permission, like editing its remotes; any signed-in account could do it before.
- Git: an account without the *Create, update and delete projects* permission sees Push, Fetch, Create on GitHub, the remote editing and branch switching greyed out with the reason, and a refused Git action names the missing permission instead of showing "forbidden".
- Kanban: an agent running a task now receives Timon's task instructions (how to close it, how to work in its worktree, how to delegate) on a fresh install; they ship as the `timon-task`, `timon-worktree` and `timon-delegate` skills, and a copy you already edited is kept.
- Reassigning a Kanban task to another agent is refused when the task carries a permission level, extra tools or a backend the person reassigning it could not grant themselves.
- The `timon` CLI and the `timon` MCP server no longer send this computer's administrator token to an address set in `TIMON_API` or `TIMON_ORCH_URL` other than the local Timon (its loopback address, or the `daemon.listen.host` address it listens on when that address belongs to this computer): for a remote daemon, set `TIMON_API_TOKEN` or use `timon daemon add`.
- An agent can no longer declare an MCP server whose name resolves to this computer, your local network or a cloud metadata address: the resolved address is checked when the server is saved and again each time an agent starts with it, and the agent's connection goes to the address that was checked (declaring such a server from a mission needs `agents:privileged-config`, or do it from the MCP servers page). Servers agents declared before this rule are checked the same way until you save them again from the MCP servers page.
- Restoring a deleted agent from the trash now needs the same rights as creating it: an account or a mission without the permission to choose tools, MCP servers and permission levels can no longer bring back an agent that has them, and an agent cannot restore one that orchestrates others.
- Working agents: a scrollbar no longer flickers in and shifts the list while an agent's avatar pulses.
- Signing in to another account from a second tab no longer lets the first tab briefly show the previous account's conversations.
- On opencode and Pi, a compaction, a conversation title or a memory pass can no longer edit files, run commands or browse the web, whatever the conversation it reads asks for.
- **TIM-0129** — Compacting an opencode or Hermes conversation no longer stays on "Compacting…": the summary is written by the agent's own model, and a failure is reported within seconds.
- Compacting a conversation, switching an agent to another model, mission titles and the memory and Dreaming jobs work again on Claude, Codex, Copilot and Grok agents (they failed with "ctx.provider.scratch needs a launch in progress").
- After installing a newer .deb or macOS package without opening the app, `timon update status` and `timon doctor` say the background service still runs the previous version, and the new `timon update apply` (or `timon service install`) moves it onto the installed one.
- When the web interface stopped restarting after repeated crashes, reopening the desktop app or running `timon app restart` now starts it again, without restarting Timon or its running agents.
- **TIM-0121** — Windows: a Codex agent in auto or acceptEdits mode can run commands again in a git repository or a task worktree.
- Code blocks in a conversation opened right after starting the app are now coloured instead of staying grey, and long conversations scroll and reopen faster.
- **TIM-0127** — A Markdown file opened from the Git panel now switches to its preview with the View button, and Markdown files open on their preview by default.
- **TIM-0128** — Document editor: closing a tab or an island with unsaved changes now asks whether to save them, discard them or keep the document open, and leaving the page warns first.
- The built-in browser's live view from a Linux computer now has sound on a device that only plays MP4 video (iPhone, iPad); when no shared audio format exists, it shows the picture without sound instead of an error.
- Browser annotations: **Send** in the address bar posts only what you annotated since your last send, never an older annotation left unsent (send that one from the history); on a phone or in a web browser, pins follow their element as the page scrolls and hide when it is out of view.
- Kanban task cards name a subscription account by the name you gave it in Settings instead of its raw id (`claude@…`).
- **TIM-0126** — Agent editor: on an opencode agent, the permission mode is greyed out with a warning that opencode ignores it and applies the `permission` key of its `opencode.json`.
- The daemon no longer stops when a plugin connection (Hermes Gateway's Test button, its settings, a mission using it) or a media shown by an agent points to an unreachable address: the connection fails with an error instead.
- The Hermes Gateway plugin's button no longer fails with a 500 error, and now reads « Add my Hermes agents to Timon »: it adds your Hermes agents to Timon and creates nothing on your gateway.
- The model picker opened from the chat bar is now compact, at the scale of the rest of the interface, and the thinking level is a row of stops (Auto, Low, Medium…) you click or drag across. The « Type a model id… » field is gone from it: custom models are added in Settings.
- The model picker no longer opens downward as a thin strip with no model to click when the chat bar has moved up (a long message being typed); it opens above it.
- Desktop dictation in Auto no longer flashes English words such as "Yeah." in the provisional text as you start a sentence; pick your language to use the French model.
- On a phone, the model picker now opens as a sheet that stays above the keyboard, instead of landing too high or behind the keyboard, and the keyboard only opens when you tap the search.
- Desktop app: after the background service takes over from the built-in daemon, the interface no longer stays unreachable ("did not answer within 120s") until the service is restarted, and a built-in daemon that crashed no longer leaves its web server holding the port.
- macOS: the LLM quotas widget no longer stays in error for Claude when Claude Code is signed in, and an expired Claude sign-in now reads as signed out with how to sign in again.
- An agent whose CLI fails to start (for example `node` missing from the PATH) no longer crashes the daemon in a loop: its mission ends as failed and shows the CLI's error.
- **LLM quotas** widget: a Codex sign-in that has expired or that OpenAI refuses now shows Codex as not signed in, with `codex login` as the fix, instead of a raw *probe temporarily unavailable — wham/usage 401* error that never cleared.
- Missions on Codex (or another CLI installed with npm) now start when Node.js was installed with nvm, Volta or nvm-windows, instead of failing with `env: node: No such file or directory`; Claude sessions there no longer stop on `mcp__timon_ask__request ... not found`. `timon doctor` and the diagnostic report say when such a CLI has no Node.js to run on.
- Claude sessions now start on a computer without Node.js (Claude Code from its native installer) instead of stopping on `mcp__timon_ask__request ... not found`, and signing a Codex account in from Settings works when Codex was installed with nvm, Volta or nvm-windows.
- Desktop app: opened on a data directory whose daemon was started outside the app (from a source checkout, or a service you installed yourself), Timon no longer offers a data update it cannot apply and opens on that daemon. When an approved update fails, its message now says only what happened, such as nothing sent and data unchanged.
- Built-in browser: an agent taking several screenshots of a page that does not change now gets every one of them, instead of one in two failing after 15 seconds.
- Built-in browser: a click sent right after the page was resized, by an agent or from another device, now reaches the page instead of being lost.
- A mission opened from the chat's mission list now shows its own agent's name, avatar and settings, and replying continues it with that agent.
- A provider that drops its connection no longer ends the turn: the chat shows the attempt in progress ("retrying 2/5…") on one line, offers **Retry** if the provider gives up, and unattended missions are retried by Timon up to 3 times before reporting the failure.
- **TIM-0124** — Settings → Resources: **Start of the day** accepts 0 to 23 and **End of the day** 0 to 24; a value outside the range is refused with a message, and an hour already saved out of range (such as 25) no longer keeps the day profile on all night.
- **TIM-0120** — On Windows, a project's built-in browser now starts when the project folder is on a drive such as `D:\`, and agents can upload the project's files from it; if Docker refuses to start the browser, its message is shown.
- **TIM-0125** — Chat: a dozen images now go out in one message: they are resized before sending and fold into a stack past three. An attachment that would take a message over 18 MB is refused when you add it, with a message, instead of the send failing.
- TO DO notebook: an idea split into several Kanban tasks no longer closes when the first one lands; it is tagged *partial* until the last one does.
- **TIM-0123** — The Agents page context menu now closes when you click elsewhere on the graph.
- **TIM-0117** — Desktop app: **Save report** in the diagnostic box now confirms in a box of its own, with the file's location and a **Show in folder** button (or the reason if saving failed), and **Preparing report…** shows while the report is being gathered.
- **TIM-0122** — An account marked **Out of quota** in the model selector becomes selectable again within a few minutes of its quota reopening, even when nothing runs on it, instead of staying greyed out until the estimated cooldown ends.
- **TIM-0118** — With several users, a mission now shows its owner's name and picture on their messages, and a superadmin sees whose mission each row of the Missions list is; the list's person button is now labelled **Started by hand**, which is what it filters.
- Desktop app: long mission titles in the chat's Missions list end with an ellipsis again instead of overflowing the card and making the widget scroll sideways.
- macOS: with the Tailscale app (standalone or App Store), Settings → Access & network reads Tailscale's state again, and **Make this machine reachable** no longer says the Mac is not connected while Tailscale runs.
- Plugins: a Timon module your licence does not include now says **Not included in your licence**, with its switch off, instead of looking turned on.
- Triggers: a webhook without authentication is no longer accepted from another machine when the background service is published behind a proxy such as `tailscale serve`.
- Workflows: the **Notify** node now posts to the Notifications widget of the workflow's owner, at the chosen level (report or alert), and fails instead of reporting ok when nothing could be sent.
- Workflows: a **Human** approval node now raises an "action required" card in the Notifications widget, which opens the run and closes once answered, timed out or cancelled.
- macOS: a site in the built-in browser can now use the camera in the signed app; the system camera prompt appears instead of a black or failed capture.
- macOS: the microphone and camera permission prompts are in English, and in French on a Mac set to French.
- The usage of a Claude subscription account added from the settings now shows in the quota widget as soon as the account is signed in, without restarting Timon.
- **TIM-0119** — After the daemon restarts, a chat whose turn was cut short shows a notice that Timon restarted and whether the conversation can be resumed, instead of silently dropping the "Reasoning" indicator.
- **TIM-0119** — The daemon no longer dies with `RangeError: Maximum call stack size exceeded` (macOS) or freezes for minutes with its API unreachable (Windows) when it re-checks whether a provider is signed in.
- Windows: updating Timon while its background service runs on a standard account (an Interactive task, or the elevation prompt refused) now pauses the task and ends the daemon before the files are replaced, instead of leaving an installation that fails at launch on a missing `ffmpeg.dll`.
- Windows: updating Timon after quitting the app no longer stops at "Timon cannot be closed" when the daemon's web server, a mission's browser helper or the built-in terminal's host is still running; the installer ends every background Timon process of the installation before replacing its files.
- Windows, portable mode: quitting the app now also ends the built-in terminal's host and a mission's browser helper, which stayed behind and blocked the next update.
- Memory capture, the overnight synthesis and the other background summaries no longer fail for good when the configured model is not one the provider's CLI accepts (for example a `claude-haiku-4.5` slug handed to Claude Code): they run once more on the provider's default model.
- The desktop app waits up to three minutes for the background service to answer at launch (90 s for the portable daemon), and five minutes for the daemon to come back after an update, instead of reporting « does not answer » after 30 s while the daemon was still starting; when that wait runs out after an update, it says the daemon is still starting rather than « data may have changed ».
- The desktop log and the support diagnostic say why the daemon did not answer (nothing listens, connected but no reply, connection reset) instead of a bare `fetch failed`, and a Timon process holding the port without answering is reported as a daemon still starting or busy, not as an unknown program.
- Images served by a plugin (covers, icons, any binary asset) are displayed correctly instead of being corrupted.
- Windows: closing a built-in terminal no longer writes `AttachConsole failed` stack traces to `daemon.log`.
- The dictation, GPT-Live and Terminal error messages now point to the right place in Settings (Interface → Voice dictation, Interface → Terminal), and the provider hints say Providers instead of Backends.
- Workflows: **Run draft** opens the run view at once, instead of a « Loading… » page that could last several seconds on an installation with a long mission history.
- Chat: when an agent's folder is a different Git repository than its project's, the branch menu above the message box no longer switches the project's branches; it says the agent works in another repository.
- Windows: **Uninstall and delete data** now also removes the dictation speech model kept in `C:\ProgramData\Timon` when your user folder name has accented or non-Latin characters.
- Security: the secrets of your triggers' webhooks are now stored encrypted, in the database and in its backups; existing ones are encrypted at the next start.
- Security: a trigger or routine an agent creates is saved switched off and runs only once you switch it on in **Triggers**; an agent cannot switch one on, and changing what an enabled one does switches it off.
- Security: triggers an agent created earlier and nobody ever switched on are switched off at the first start of this version; a notification names each one so you can switch it back on in **Triggers**.
- Security: `timon plugin remove` now deletes the plugin's incoming-webhook secrets, so a package installed later under the same id cannot receive the calls meant for the old one; after a reinstall, set a new secret.
- Security: `timon plugin remove` now withdraws the vault grants made to the plugin (and to the bundle children it removes), so a package installed later under the same id cannot read those secrets; the command lists them.
- Security: `timon plugin remove` now withdraws the plugin's mission approval and Kanban project grants (and those of the bundle children it removes) and closes its approval and program-authorization cards, so a package installed later under the same id starts unapproved; the command lists them.
- Security: a plugin removed another way (folder deleted, `npm uninstall`) no longer hands its incoming-webhook secrets to a different package installed later under the same id; the Webhooks pane asks for a new secret instead.
- Security: a plugin removed another way (folder deleted, `npm uninstall`) no longer hands its vault grants, mission and Kanban approvals, opened hosts or user connections to a different package installed later under the same id; everything is withdrawn before that package runs, connection keys included, and a card lists it. Updating the same package keeps everything.
- Security: a different package installed under the id of a previous plugin, however that one was removed, no longer reads its secret settings; they are deleted before it runs and the card lists them, while updating or reinstalling the same package keeps them.
- Security: a plugin reinstalled from another package under the same id now starts from scratch: the previous one's settings and stored data are deleted and its data folder is moved to `plugins-data/.trash`; updating or reinstalling the same package keeps them.
- Security: when Timon summarises, titles or compacts an opencode conversation, opencode may only read the project's files (never its `.env` files): the tools of the MCP servers in your `opencode.json`, and every other tool, are refused.
- Security: when Timon summarises, titles or compacts an opencode conversation, opencode no longer starts any MCP server and no longer loads the project's `opencode.json` or `.opencode` folder (plugins, agents); a model provider declared in the project still answers.
- Security: a workflow's **Script** step no longer receives Timon's own environment variables (keys, tokens); it gets the system variables it needs to run and the vault secrets it names.
- Security: **Always allow** and **Allow for this session** on a Claude Code permission card now cover the same file, the same web domain or the same MCP call, not every use of the tool; approvals given before on a whole tool other than a shell command are removed, so those cards ask once more. A session approval ends with its mission.

### Changed

- **Plugins**: Timon now recognises plugins signed by Timon, so a signed plugin (Growth Studio included) installs and runs without developer mode. An unsigned plugin is no longer loaded unless `"developer": { "unsignedPlugins": true }` is set in `timon.config.json` on a licensed installation; if one stops loading after the update, install its signed version or set that option.
- **Plugins**: installing the signed version of a plugin you installed unsigned (Growth Studio rc.21 → rc.22, for instance) is now an update: its data, settings, grants and connections are kept, and the install sheet and `timon plugin add` say so. Installing an unsigned copy over a signed plugin still starts it from scratch.
- **Plugins**: a signed plugin that declares `missions:spawn` can start missions as soon as it is installed, without an entry in `pluginPolicy.spawn.approved`; the quota still applies. `pluginPolicy.spawn.denied` refuses a plugin anyway, and `pluginPolicy.spawn.autoApproveSigned: false` restores the explicit approval.
- **Linux**: the desktop app now needs glibc 2.28 or later (Ubuntu 20.04, Debian 10, RHEL 8 and newer).
- **Kanban**: redesigned columns and cards. Each card shows the agent's avatar and role (with its running time while in progress), the model's logo, the linked TO DO idea's tags, the scheduled date, how many tasks it waits on and unblocks, its attachments and its priority; colours follow the light and dark themes.
- **Kanban**: the task form is redesigned: a large title, five tabs with counters (General, Execution, Dependencies, Capabilities, Schedule), a summary on the right, agents as cards with their picture and role, models with their logo, and a Markdown preview of the description.
- Plugins: a plugin can have at most 5 pipeline runs open at once (a run stays open while one of its tasks is pending or running); a sixth is refused with a message saying so.
- Schedules (triggers, routines, workflow schedule nodes, plugins' triggers) run at most once a minute: a cron with several values in its seconds field is refused when saved; one saved earlier can still be renamed or turned off, not turned back on.
- The timeline of a mission over for 90 days is now removed to save disk space; the mission list keeps its tools, errors and duration, and a button on the mission rebuilds it from its events. `TIMON_TRACE_SPANS_RETENTION_DAYS` sets the delay, 0 keeps every timeline.
- Accounts: every card of the chat's columns now follows its `widget:` permission, such as `widget:missions`, `widget:git` or `widget:workflows` for Trace. Existing roles that open the chat keep the cards they could use, and **Employé** starts with its missions and traces.
- Plugins: routines, a trigger's task actions, and pipeline or workflow runs started with nobody in front (a background job, a webhook, an event handler) now need `pluginPolicy.spawn.approved` and count against the spawn quota; a plugin that is not approved gets a refusal and you get a card naming the config line, a pipeline run counting one per step.
- The key of a provider added with **Add a provider** now reaches only that provider's own process, never other agents or plugins; keys saved earlier are moved over at startup, and one you had shared with a project or agent stays as it is with a card offering both choices.
- Plugins read from the Secret Vault only the secrets granted to them by name (`agent:plugin:<id>`), no longer those granted to `global`; a plugin that asks for one gets an action card that opens the grant in Secrets.
- Plugins: an API call under a brokered secret (`ctx.secrets.httpCall`) now needs the `http:outbound` permission and a host allowed in `pluginPolicy.http.allow`, like any other outbound call from a plugin.
- Plugins: a third-party provider's program is checked again each time a mission starts it, resumes included; if it has moved, a link now leads to another file, or its authorization was removed, the mission is refused and you authorize the program again from **Settings → AI models → LLM backends → Providers** (a program authorized through a link before this version needs that once).
- Plugins: a task that runs, created or put back in the queue by a plugin on its own (a background job, an incoming webhook such as the Discord connector's investigations, or an event handler), now needs the plugin's spawn approval and counts against its spawn quota (`pluginPolicy.spawn`); until approved, an action card asks for it and the Discord connector's settings name the ticket waiting.
- Pi needs only the `pi` command, version 1.4.0 or later (sign in with `/login` inside `pi`); the `pi-acp` adapter is no longer used, and conversations started through it reopen with their history.
- The nightly backup (03:30) is now on by default, on new and existing installs; a backup you had turned off stays off.
- Desktop: when Timon's check of its installation files takes more than a second at launch (up to a minute behind an antivirus), a **Checking the installation…** window shows instead of an app that seems frozen. The troubleshooting page lists the folders to exclude from antivirus scanning.
- Chat: opening an agent's chat shows its latest conversation without waiting for the missions list, and the list updates as conversations start and finish instead of every 10 seconds, so switching chats no longer stalls behind it.
- Chat: the context indicator in the composer bar is now a ring that fills up, with the model's maximum context size in its centre; the exact usage and percentage are in its tooltip.
- Chat: opening a long conversation is much faster — the history no longer carries the agent's per-token progress events.
- Chat: a conversation opens on its latest messages only; **Show older messages** loads the earlier ones as you scroll back, and a link to an older permission still opens on its card.
- Chat: going back to one of the last conversations you opened shows it at once, then adds only what happened since.
- Skills: opening a skill shows its `SKILL.md` rendered, in a popup with the file viewer's Preview / Edit switch and its code editor; plugin skills open read-only, and **New Timon skill** asks only for an ID before opening the editor.
- Chat: opening a chat from the Agents graph, a widget or a notification no longer reloads the app, and switching between chats keeps the current conversation on screen until the next one is ready.
- Faster first load: every page downloads about half as much code; Settings, the agent editor, the built-in browser, the terminal, file viewers and code highlighting load when first opened.
- Security: the Timon window now only connects to Timon itself and to the hosts a dictation engine declares (over HTTPS); a plugin's interface can no longer send data to any other site. After installing a dictation engine that uses an online service, Timon asks you to reload once.
- Plugins: the routes of a plugin with a `daemon` dictation engine accept a request body of at most 1 MB (25 MB elsewhere); a larger audio block is refused with `413`.
- Security: Timon refuses to start with `daemon.auth` set to `"off"` while the web interface listens beyond the loopback or `daemon.behindTlsProxy` is set, since anyone reaching the web interface could then use the API without signing in; remove the `auth` line to start again.
- Plugin API reference: types now show their written values (event kinds, permissions) instead of internal names, the dictation and browser annotation types are documented, and browser-side `@timon/ui` types come from `@timon-ai/sdk/ui`.
- Labels, counters, dates and badges across the interface use the product font (monospace stays for code, commands, JSON and IDs you type), and panels, lists and dialogs no longer draw separator lines between their parts.
- Chat notices, the chat's day labels and the last menus that had them no longer draw separator lines; in the plugin UI kit, `Separator`, `SelectSeparator` and `DropdownMenuSeparator` now leave a blank gap.
- The desktop app now ships the licences of its downloadable speech models, with the Apache-2.0 NOTICE of Cohere Transcribe, as `THIRD-PARTY-MODELS.md` in its resources folder.

### Known issues

- Chat: while a turn is being prepared, a tool the previous turn left unfinished can show as still running, with its old duration, until the new turn starts.
- An agent's island card applied to a page other than the one on screen removes the tabs it replaces, but a replaced terminal keeps running: end it from the Terminal page.
- Windows: a CLI installed with pnpm or yarn can keep running after Timon stops or crashes; end it from Task Manager, or install it with npm.
- **TIM-0034** — The installers are not code-signed: Windows SmartScreen or Smart App Control and macOS Gatekeeper warn about them or block them. On Windows, choose **More info → Run anyway** (turn Smart App Control off in Windows Security if it blocks); on macOS, allow the app in **System Settings → Privacy & Security**.
- Windows: a Codex agent in auto or acceptEdits mode cannot `git commit` (Codex keeps `.git` read-only); give its code and merge tasks the bypassPermissions mode, or run them on another backend.
- **Machines**: in the desktop app's window, the built-in browser keeps showing this computer's browser after switching to another machine; open Timon in a web browser or the installed web app to use another machine's.
- **Desktop app**: the built-in browser panel shows in the first window open only; in the other windows it stays closed.
- Windows: on a work or school account of a PC joined to Microsoft Entra ID, Windows may refuse to run Timon's background task; Timon then runs only while its window is open.
- macOS: the usage of a Claude subscription account is not shown in the LLM quotas widget nor under the chat composer; Codex accounts are.
- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, or no reviewer) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- Pi has not been tried with a tester's own model provider yet, so a first mission may fail.
- With Pi as the only backend, conversations keep their default title.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.
- Windows: installing a new version of the app closes the built-in terminal's shells.
- Chat: pressing Escape to close a dialog while dictating also cancels the dictation and puts the message back as it was before you clicked the mic.
- Google refuses to sign in directly from the built-in browser ("This browser or app may not be secure"); use **Sign in with Chrome** in its options menu, which needs Chrome, Edge or Chromium installed outside a snap or flatpak package.
- **Sign in with Chrome** copies the sign-in into the built-in browser; whether Google keeps it valid there over time has not been verified, and a password or 2FA step has not been tried. Run it again if the session is lost.

## [0.1.5] — 2026-10-21

### Added

- Series planner: when the agent sorts the workstreams into groups (simple, complex…), each group is a fold-out where you pick its own model and fallback per role; the general rows below still apply to any group left untouched, and a group's choice follows its tasks through review, merge and docs. From a terminal, `timon series role set --group`, `timon series fallback set --group` and `timon task create --plan-group` do the same. Each group says whether it uses the general models or its own, with **Override models** / **Use general models** buttons; model menus show the model's logo instead of the provider name and stay readable in the dark theme, the selected pipeline is visible in the light theme, and open groups are more spaced out. The pipeline choice sits at the top of the form, and only one group is open at a time (the open one is outlined). The form no longer draws borders.
- **SUG-0075** — Notifications: an optional sound, and an optional on-screen notification, when one of your Kanban tasks starts — both off by default, in **Settings › Interface › Notifications › Sounds**.
- Chat: in a project, the **New** buttons let you pick which of the project's agents starts the new mission.
- **SUG-0021** — Chat: press ↑ / ↓ in the message box to bring back the prompts you already sent to this agent, like in a terminal; ↓ past the latest one returns to what you were typing.
- **SUG-0073** — Guided tour: clicking **Not now** on the tour offer tells you where to start it later — the appearance menu (palette icon in the top bar) › **Guided tour**.
- **SUG-0072** — Chat: right-click a mission in the list and choose **Copy CLI session ID** to copy the session id of the CLI behind it (Claude Code, Codex…), shown shortened in the menu; the entry appears once the CLI has started its session.
- **SUG-0055** — Multichat: a cell's header has an **Open this mission** button that opens its conversation in the full chat, where the terminal and the widget columns are; Ctrl/Cmd+click or the middle button opens it in a new tab.
- **SUG-0006** — Setup: **Re-detect** in the Prerequisites panel finds a tool you just installed by hand (Node.js, Git, Claude Code, Codex, including through nvm, Volta or Homebrew) without closing the window or restarting Timon; the screen also checks again when you come back to it, and a reload keeps what you had chosen.
- **SUG-0066** — Settings › AI models › Providers › **CLI binaries**: see where each provider's command-line tool was found, pin its path (with **Browse…** in the desktop app) or click **Check again** — it applies to the next mission without restarting Timon.
- Missions: a conversation you open gets a short title at the end of its first reply, shown in the chat's mission list, the Missions table and the picker; rename it from the list and your name is kept.
- Settings › Missions › Execution: **Conversation titles** chooses the model that writes them — automatic (the lightest model of the conversation's backend), a specific backend and model, or off; a backend served remotely is greyed out. `timon spawn --title` and `mission_spawn` can name a mission at launch.
- Chat: an option an agent offers can show an **Agent** or **You** badge, saying who carries the action out.
- Workflows: every workflow is piloted by one of your existing agents, chosen when you create it and changeable in its settings: it answers in the canvas chat, is woken for every run, and each agent node runs as a sub-agent that reports to it. Timon no longer creates a hidden `workflow.<id>` agent per workflow.
- Workflows: schedule, webhook and event start nodes are native triggers. Publishing creates or updates them on the Triggers page (journal, rate limit, signed webhook secret); the node's panel shows the route, rotates the secret and links to the trigger.
- Chat: a single **Git** widget replaces the Git status and Git remote cards, with **Branches**, **Graph** and **Publish** tabs. The graph draws the latest 150 commits of every branch and tag with their worktrees, and a commit opens its full hash, author and parents.
- Chat: clicking the branch above the message box opens the project's branches and worktrees; pick a branch to switch to it. The bar also shows the agent's folder and the lines added and removed.
- Git widget: **Remotes…** in the Publish tab adds, changes or removes a project's remotes on any Git server (SSH, GitLab, Gitea, your own), and shows Git's message when a remote does not answer; a URL holding a user name or a token is refused.
- Settings › AI models › Auto switch: a **Preferred provider** that new agents, missions and chats use when they name none, as long as it is signed in.
- Model selectors flag with **Not signed in** a provider whose CLI is installed but signed in to nobody.
- **SUG-0048** — Notifications: a **Need you only** switch in the bell's menu and the Notifications widget lists only what waits for you, and the badge counts only those.
- **SUG-0048** — Notifications: a "Need you" notification sent by an agent clears by itself once you reply in its conversation or its task is done, after 24 hours when it is tied to neither, and after 7 days at most (`timon notify action_required --dismiss-on`, `--ttl`).
- **TIM-0109** — A blocked Kanban task whose branch was merged outside Timon (a pull request merged on GitHub, a merge by hand) can be marked as merged from its editor, with the merge commit: it closes as done and the tasks that depend on it start.
- **TIM-0109** — When a Kanban task runs under another agent than the one it names, the daemon log says why (role pinned for the project, agent of another project or holding another role, orchestrator).
- **SUG-0033** — Tasks widget: in an agent's chat it lists only that project's missions and tasks; on the Agents page and the cockpit a project selector narrows it (all projects by default, choice remembered).
- **SUG-0045** — Agents: right-click an agent (chat avatar or Agents graph) → **Duplicate agent** asks for a name and creates a copy with the same configuration and prompt; its memory starts empty, and an existing name is refused.
- **SUG-0034** — Desktop app: the window reopens at the size and position you left it, maximized or full screen included (on a remaining screen if its screen is gone).
- **SUG-0029** — Notifications: a **Copy** button on each notification (bell menu, widget, column and archive) copies its title and full text.
- **SUG-0074** — Files: right-click a file or a folder → **Copy path** (full path on the machine) or **Copy relative path** (from the agent's folder).
- Triggers: a new **Script (run)** action runs a program in one of your projects on a schedule or an event, with no agent and no token spent — argv without a shell, vault secrets injected by name and hidden from the journal, a time limit, no overlapping runs, an alert with the end of the output when it fails, and the trigger switched off after 5 failures in a row. It needs the new **Run scripts on the host** permission; when an agent asks for one, nothing is created until you approve its card in the conversation (or `timon trigger approve` in a terminal).
- Providers: a plugin can now be a **provider** (new type in the gallery). Installing one shows the program it launches with the path Timon found on your machine, and one tick allows exactly that program — no more editing `timon.config.json`. A new version of a provider replaces the running one without a restart, waits for missions in progress, and is refused while Timon runs if it would change how missions talk to the provider.
- Providers: **Settings → AI models → LLM backends → Providers** installs agents from the official ACP registry (Cursor, opencode, Hermes… as listed there): the download is checked against the published sha256, an agent without a published hash needs your confirmation, files are re-checked every time Timon starts, and updates keep the working version until the new one is verified.
- Setup: finishing the setup now requires at least one AI provider that can run on the machine, and the last-resort quota fallback no longer assumes a given provider is installed (`TIMON_FALLBACK_BACKEND` is empty by default).
- **SUG-0059**, **SUG-0060** — Plugins: **Plugin SDK API 10** lets a plugin do what the CLI and the agent tools do — act on missions and read their traces, answer the questions agents wait on, sync the Kanban and the TO DO notebook with GitHub, Linear or Jira, manage agents, projects, automations and the installation. Each capability is its own permission; `timon plugin add` names apart those that act on other people's work or reach secrets and the machine, a plugin can only give roles and groups ordinary rights, and without `missions:transcript` a trace comes back without what was said.
- Plugins: **Plugin SDK API 11** gives provider authors the conformance suite Timon runs on its own providers (`@timon-ai/sdk/testing`), with session replay and a fake CLI. A plugin declaring `apiVersion` 11 has its dialect checked at registration, with the reason when a declaration contradicts another; older plugins load as before.
- Plugins: **Plugin SDK API 12** gives provider authors `ctx.provider`: the codecs, session drivers and ACP client now come from Timon itself (a fix reaches every installed provider), the mission token and your MCP servers' credentials never reach the plugin, and a whole provider definition can be registered, checked and replaced in one step. The install screen lists the home folders a provider reads its sign-in from (`provider.credentialDirs`); `.ssh`, `.aws`, `.config` and the like are refused. Plugins declaring an older version load as before.
- **SUG-0044** — Plugins: **Write a provider** is now a complete guide for outside developers — what to write for each case, how a provider is described, capabilities, the usage gauge, testing against a recorded session, and the pitfalls of each supported CLI; the SDK reference now lists the newer provider services.
- **SUG-0041** — Providers: a **Cursor** provider template (`cursor-agent acp`, your Cursor sign-in, never the API billed per token) ships with the developer distribution as the worked example of an ACP provider written on the SDK alone. It has not been run against a real Cursor yet, and Timon's own tools may not reach a Cursor mission. The SDK test kit can now play a recorded ACP session, and an ACP provider can declare the sign-in method to try once when its agent asks to authenticate.
- CLI: `timon docs search` and `timon docs read` look up the documentation of your installed version from a terminal, offline; the CLI reference and the agent tools page now cover workflows, pipelines, routines, the setup conversation and the other tools that were missing.
- CLI: `timon project create` and `timon project update` register and edit a project from a terminal, and `timon workspace list` lists the workspaces.
- Agents: an agent can propose a whole screen — panels and widget columns — in a single card you apply in one click.
- Setup: the backend list is hidden when a CLI backend already works on the machine.
- Setup: once the daemon service is installed and nothing is missing, setup writes the configuration and moves on by itself.
- Setup: a step indicator shows where you are, with the finished steps ticked.
- Setup: three steps instead of five — no team to pick and no restart screen. Once the main agent is set up, the guided tour starts on its own in the cockpit, and a banner offers the restart.
- Setup: the main agent's picture is chosen with its name; its first conversation opens behind a loading screen and starts by asking which language you speak. Its questions come as free-text form cards.
- Setup: when the main agent's backend fails, Timon tries the next installed one; if none answers, setup explains what to install and opens Settings › AI models.
- Menu: Reorder the side menu pages by drag and drop in **Customize the menu**.
- Islands: every tab starts with a picto telling its type (terminal, browser, file, page…), and an agent's chat tab shows that agent's avatar and name, the page's included. Every island has **Minimize** and **Close** at its right end, like a popup; the island that holds the page has neither.
- Secrets: the vault list has a search box and a project filter (the secrets that project can access), and each secret's tags now sit under its name.
- Agents: a new `secret_create` tool lets an agent store a new secret in the vault, generated by Timon or supplied by the agent. The secret stays private to Timon until you open it from the Secrets page.
- Secrets: **Show** in a secret's editor displays its value again after you confirm your account password (superadmin only). The value hides itself after 30 seconds, and every reveal is logged.
- Chat: an agent can show a table, a chart or a preview as an interactive HTML card inside the conversation, isolated from the rest of Timon.
- Chat: an agent's HTML card can ask you to fill in a form and send your answer back to the agent; a message it proposes waits for your **Send**, and the card can open full screen.
- Islands: a popup's **Minimize** button (or its menu) folds it into a tab in the bottom-right corner; a click on the tab brings it back where it was.
- Onboarding: the guided tour asks whether you are a developer, want to automate tasks or are new to AI, and sets Timon up for that — pages shown, screen layout, menu.
- Navigation: **Customize the menu** at the foot of the side menu hides the pages you do not use (they still open by their address); an agent can propose it too.
- Projects: a **demo project** (`timon project demo`) — a small sample repository to try the agents on when you have none of your own.
- Islands: an agent can propose a layout with a new terminal in it; the shell starts when you apply the card.
- Agents: a question can now ask for a free-text answer — a single text field (for a name, say) instead of buttons.
- Setup: after naming your main agent, a short conversation lets it introduce itself — it asks for a picture and what you expect of its character, then configures itself. A voice button and a model picker are the only controls.
- Onboarding: after the setup, Timon offers a **guided tour** — your assistant shows you around and helps you arrange your screen. It stays available under **Guided tour** in the appearance menu.
- Notifications: a sound when an agent finishes its turn in a conversation you started (**Mission finished**, in Settings › Notifications › Sounds), with its own on/off, sound and optional file.
- Notifications: each sound event (task done, task blocked, approval) can play **your own sound file** — pick it with the folder button in Settings › Notifications › Sounds (WAV, MP3, OGG, FLAC, M4A; up to 1 MiB and 10 seconds). It is saved on your account.
- Agents: a built-in **onboarding** skill walks you through the app — it takes you to pages and proposes arrangements of your islands and widgets, one card at a time.
- Islands: any widget opens as an island, and a **widget zone** island lets you assemble a page by dropping cards into it — by hand or by asking an agent.
- Agents: an agent can ask to take you to a page of the app (`ui_navigate`) — a **Go there** card appears in the conversation, and nothing moves until you click it (a guided tour, once you start one, opens its pages directly).
- Notifications: a sound when a Kanban task is done, when one is blocked or fails, and when an agent waits on your approval — each with its own sound, on/off switch and preview in **Settings › Interface › Notifications**, under one volume; a single open window plays it.
- Browser and files: the built-in browser and every file (text, picture, PDF, Office document) open as an island — a popup over the page by default — with the same tabs, menu and drag as the terminal; files of one agent share an island, and a picture's arrows still turn through its folder.
- Terminal: the **Terminal** button opens a session as a popup over the page, in the same island as the project's other shells; **+** in its header starts another one and closing a tab stops its shell.
- Islands: any island, tab or content (terminal, chat, file, browser) can open as a **popup** above the page — hold Alt while dropping it, release it outside the workspace, or use **Open as a popup** in the island menu; a popup resizes from any edge or corner, docks back from its menu, and **Keep on every page** makes it follow you across pages and projects.
- Islands: an island dragged by its header moves smoothly like a window, docked ones included; it docks only when pushed against an edge of the screen, where a highlighted area shows the place first, and otherwise stays a popup where it is released. It keeps following the pointer up to the screen's border instead of stopping at the edge of the page. Around the middle of an edge it spans the whole page; further along, and in a corner, it docks to the column (or row) under the pointer, under the terminal for instance.
- Multichat: **Grid → Open in the workspace** turns the occupied cells into separate islands; right-click an agent or a cell header to open one chat beside the grid or in a tab.
- Plugins: third-party plugins can add island content, identified by an Island badge and filter in the gallery.
- Terminal: a session can open next to the page you are on (right, left, below, above, or as a tab), in islands you resize by dragging the gap between them, the chat included, whose widget columns fold into panels when its island gets narrow.
- Islands: drag a terminal tab, an island's tab or an island's handle onto the edge of another island to split beside it or stack under it, onto its centre or its tab bar to add a tab, or along the edge of the screen for a full-height column; a highlighted area and a label show where it will land.
- Islands: the Events, Notifications, Agents, Projects and Multichat pages can be split too.
- Islands from the keyboard: F6 moves between islands, arrow keys and Delete work in a row of tabs, and **Move…** in an island's menu places a tab or an island with the arrow keys, Tab and Enter.
- Files: a file opens next to the page in an island of its own, from **Open in a split** in its right-click menu or by dragging it out of the Files tree; renaming, moving or deleting it closes its island.
- Browser: the built-in browser moves next to the conversation in an island of its own, by the handle or the **Place in the workspace** menu of its window's title bar; **Open in a window** brings it back.
- Docked windows: the inner edge of a docked window resizes from the keyboard (arrow keys, Home, End).
- Islands: an agent's conversation can open next to the page — drag an agent chip from the top bar or a conversation from the Missions list, or right-click either and pick where; only the chat you last clicked shows its widget columns, the others offer buttons to bring them back.
- Agents can propose a new arrangement of your widgets and chat columns (`widgets_propose`): a card in the mission's chat shows it, and **Apply this arrangement** puts it on screen at once; agents can also read your arrangement (`widgets_get`) and save it as a named layout (`widgets_preset_save`).
- Agents can propose how to split your screen into islands (`islands_get`, `islands_propose`, `islands_preset_save`, CLI `timon islands`): a card with a sketch of the islands lets you apply the arrangement at once, or ignore it.
- Chat column tabs can carry a name, shown in the tab.
- **SUG-0051** — Kanban: a **Search** box filters the board by keyword (id, title, agent, description); it combines with the Project and Agent filters, narrows the TO DO column and the Done column, is remembered in the browser, and **Reset filters** clears it.
- `timon agent doc list|get|put|rm` and the `agent_doc_*` agent tools read and edit an agent's identity docs (`SOUL.md`…); an agent may change its own, or those of an agent it orchestrates.
- Missions: an **Origin** filter separates your own conversations from what runs on its own (Kanban tasks, routines and triggers, other agents, system), with a small icon on each row; the chat's mission list gets an **Only my conversations** toggle.
- Permission cards of Claude Code missions offer **Allow for this session** and **Always allow**: the same tool (or, for a shell command, the exact same command) is then allowed without asking, for the rest of the mission or for every mission of that agent you run; the agent's **Permissions** tab lists your always-allowed tools, each one revocable.
- Subscription accounts: rename an account from its row in Settings › AI models › Subscription accounts; an administrator also assigns it to other users there (**Assign**) or with `timon backend-account grant|revoke`, and `timon backend-account list` shows who may use each one.
- Subscription accounts: the LLM quotas widget and the strip under the chat composer show the usage of each signed-in account you may use, next to the provider's sign-in of the Timon machine.
- Plugins: **Install a plugin** picks a plugin folder or `.tgz` archive on your computer (a file upload in a browser), and the gallery lists the packages found in the plugins folder that are not installed yet; each opens a sheet with its details, signature status and a third-party disclaimer, and nothing is installed before you click **Install** (superadmin only).
- Plugins: **Install a plugin** and `timon plugin add` also accept a `.zip`, such as GitHub's **Download ZIP** or a folder compressed by the Windows Explorer or the macOS Finder.
- **SUG-0043**, **SUG-0042** — Kanban: a **Project** filter next to the **Agent** filter; the two combine, the Done column counts and pages the matching tasks only, the choice is remembered in the browser, and **Reset filters** clears it.
- **SUG-0030** — `timon agent rename <old> <new>` (and the `agent_rename` tool for agents) renames an agent with its memory, missions, tasks, routines, triggers, messages, browser profiles and project roles; it is refused while one of its missions is running or when the new name is taken.
- Support diagnostic: the desktop app's error boxes offer **Copy diagnostic**, **Save report** and **Open logs folder**, as do Settings › System › Installation (superadmin) and the tray menu; `timon doctor --report` prints it in a terminal. The report gives versions, how Timon runs, the service's last run, detected problems and the latest log lines newest first, with tokens and secrets masked, even when the daemon does not start.
- Logs: the daemon and the desktop app write one file per day (`daemon-<date>.log`, `desktop-<date>.log`) in the `tmp` folder of the Timon data directory, every line stamped with the local time; files older than 14 days are deleted (**Log retention**, **Log size ceiling**). `timon logs` shows the latest lines, newest first.
- `timon doctor` names known problems: a service installed without the app's marker, a Windows task that never ran (with Microsoft Entra ID join), data last opened by an older version, the daemon port held by another program.
- Settings › System › **Installation** (superadmin): installed version of Timon and of the desktop app, data folder, installation folder and daemon log, how the daemon runs (service or inside the app) and where it listens, the service state with an **Install the service** / **Repair the service** button, a data export button and the exact commands to import an archive.
- Built-in browser: **Sign in with Chrome** (browser options menu) opens an installed Chrome, Edge or Chromium on the computer running Timon so you can sign in to Google and other sites that refuse the built-in browser, then copies the sign-in into the built-in browser. Without one installed, the dialog says so.
- Plugin webhooks accept the signatures of GitHub, Gitea, Forgejo, GitLab, Stripe, Slack, Shopify, Linear, Discord interactions and Meta, so these services can call a plugin directly; Settings › Plugins shows each webhook's format and security level and lets an administrator paste the secret a service provides. The GitHub Issues connector template no longer needs a relay.
- Triggers: a task action can be marked **Silent return**, so the agent's report stays where the task puts it and never reaches the orchestrator's conversation. The Discord connector's ticket investigations are silent by default (setting *The investigation reports in the idea only*).
- **TIM-0050** — GitHub Copilot: the LLM quotas widget and the strip under the chat composer show the share of your monthly premium requests used and when it resets.
- Settings › AI models › Subscription accounts: add several Claude or Codex subscriptions and sign each one in from the browser, even on another computer (paste the code for Claude, enter a device code for Codex); each account becomes its own choice in the model selectors. An administrator can add and sign in accounts for other users.
- Idea outcomes: when the public note is changed on an already-set outcome without also changing the outcome itself, a notice appears below the note field warning that the author will not be notified — only an outcome change triggers a notification.
- Every built-in plugin and widget now has its own icon in the Plugins gallery and the widget window, following the light or dark theme. Third-party plugins can ship one too (`timon.icon` in the manifest, `icon` on a widget).
- New `agents:privileged-config` permission, held by administrators by default: agents launched by a mission can create agents and Kanban tasks on any backend (Codex included) with any permission level up to their own, instead of being refused with `403 forbidden`.
- Settings › Secrets › Connections: each account adds its own connections to the services plugins use (address and keys kept in the vault), tests them, and administrators approve which addresses plugins may reach.
- New Hermes Gateway plugin, shipped with the app and off by default (turn it on from **Plugins**): the Hermes agents of your own Hermes gateway (0.21.0 or later), even on another machine, answer in Timon like other agents — each account connects its own gateway in Settings › Secrets › Connections.
- Agents can debug a page in the built-in browser: console messages, network requests, network and CPU throttling, and a performance summary, with the same tool names as chrome-devtools-mcp. Cookie and authorization headers stay hidden from them.
- New **Git** plugin in the Plugins gallery: the chat's Git widget now works with the Kanban switched off.
- **TIM-0080**, **SUG-0040** — Built-in terminal: copy and paste with Ctrl+Shift+C / Ctrl+Shift+V (Cmd+C / Cmd+V on macOS, Ctrl+C on a selection on Windows), a right-click Copy/Paste menu, and a Copy key on a phone while text is selected.
- Chat: a command an agent asks you to run shows as a card in the mission's conversation, with **Allow** (when the agent can run it itself), **Paste into a terminal** (typed without Enter in the terminal of the mission's project) and **Refuse**. Shell permission cards get the same **Paste into a terminal** button, and a project with a command waiting for you shows a badge.
- New documentation page, *Remote access to the web interface*, for installs on a server or VPS: why the interface only answers on the machine itself, and how to reach it with Tailscale, an SSH tunnel, an HTTPS reverse proxy or a Cloudflare Tunnel, with the ports and firewall rules and a troubleshooting table.

### Changed

- Settings › AI models: model rows now have aligned **Slug**, **Label** and **Context window** headers; default and visibility icons explain their columns on hover.
- Chat: an agent's questions open as tabs, walked with **Next** then **Send reply**; each question ends with a free-text field that replaces the « Other » option and the note under the form, and nothing is preselected any more.
- Workflows: the webhook addresses `/api/workflows/hooks/<token>` no longer answer. A published webhook node has a native route `/api/triggers/hooks/<name>` and a signing secret to copy from its panel; give the new address to your sender.
- Providers: **Claude** and **Kimi** appear in the **Plugins** gallery as built-in providers; Kimi becomes inactive when Claude is switched off.
- Providers: **Grok Build** and **GitHub Copilot** are now plugins shipped with the app and listed in the **Plugins** gallery with a Built-in badge; they are on by default and can be switched off there.
- Providers: **opencode**, **Hermes** and **Pi** are now one plugin shipped with the app (**ACP agents**), listed in the **Plugins** gallery with a Built-in badge; it is on by default and can be switched off there.
- Providers: **Codex** and **Ollama Cloud** are now plugins shipped with the app and listed in the **Plugins** gallery with a Built-in badge; they are on by default and can be switched off there (Ollama Cloud then waits for Codex).
- Plugins: the programs a plugin runs through `ctx.host.exec` no longer inherit the daemon's environment (only the system variables a program needs), and a third-party provider can no longer launch `claude`, `codex`, a shell or an interpreter from its launch code.
- Islands: a popup closes from a cross at the right of its header, like a window; the **+** of a new tab sits right after the last tab; the island menu opens from a chevron and shows an icon per action. **Move…** left the menu: on a focused tab, **M** moves the tab and **Shift+M** its whole island.
- Design: the page, the chat and docked windows (browser, terminal, file preview) are now rounded islands separated by the background instead of a hard line; the top bar runs the full width above them.
- Docked windows: the resize edge shows a line and a grip on hover, and a window docked on the left no longer pushes the menu rail away from the screen edge.
- Themes: stronger contrast between the frame and the page in both themes; dark surfaces are slightly lighter.
- The chat's **Skills** and **MCP** cards are now their own plugins in the gallery: each can be turned off on its own, keeps its place, and a restricted role sees it only with the `widget:skills-widget` or `widget:mcp-widget` permission.
- On a machine without Git, the Kanban keeps working but refuses the code, review and merge tasks of a Git project with a clear reason; its card in the Plugins gallery and `timon doctor` say so. Git is now recommended rather than required: the setup screen offers it without blocking, and `timon doctor` no longer fails without it.
- TO DO idea detail: reorganised in two zones — title, urgency, progress and project in the header, the description in the main area, and links, linked tasks, the outcome block and dates in a side column; urgency and progress are one chip each that opens its choices, and the Save button stays visible.
- A refused request (HTTP 403) from the CLI or an agent's tools now says which permission is missing, why, and what to do next, instead of a bare `forbidden`.
- An agent in a mission can no longer rewrite the prompt, directives or shared context of an agent that runs at a higher permission level than its own, or that it does not orchestrate.
- Turning a built-in module on or off now requires the *Install, enable and disable plugins* permission, and the keys, headers and tokens of an MCP server are hidden from anyone who cannot manage MCP servers.

### Fixed

- In the dark theme, the agent's question form is easier to read: options and tabs stand out from the card, the current tab is filled with the accent colour, and the Agent / You badges are clearly visible.
- **SUG-0014** — A form opened by an autonomous mission now waits 30 minutes instead of 5 (**Settings → Missions → Permissions**), shows the time left, and a form asked again with the same questions keeps what you had ticked and typed.
- Workflows: **Run** and **Publish** name the node that is incomplete and mark it on the canvas, instead of failing with a wall of raw text; **Run** stays off, with the reason shown, until the workflow has a pilot agent.
- Git widget, Publish tab: pushing a branch picked in the list pushes that branch, no longer the current one.
- Chat: the branch shown above the composer no longer lags behind: it follows the Git widget after a checkout, a push, a fetch or the agent's turn, without reloading the page.
- Git widget, Publish tab: a branch never pushed, a detached HEAD, a branch whose remote copy was deleted or a remote without a default branch no longer show "0 to push" or "up to date"; they read not published, ahead or unknown.
- Auto switch no longer moves a conversation or a task onto a provider that is installed but not signed in, so with a single signed-in provider nothing switches; a blank agent no longer defaults to a signed-out provider.
- Setup on macOS: when the CLI only comes with the Claude or ChatGPT desktop app, setup gives the line that signs that copy in instead of asking to install it, and a Claude sign-in kept in the macOS keychain now shows as ready.
- Chat: a message another agent sends into a conversation (`mission_send`) shows as that agent's, no longer as yours.
- **SUG-0048** — Notifications: a card that asked for an action disappears once it is done — the Dreaming "tracks to review" card when the last track is decided, a plugin's spawn approval card once the plugin is approved, and permission cards left over from before a restart.
- **TIM-0115** — Windows: `timon service uninstall` now also ends the daemon and the terminal host that the task left running, says so when the permission prompt was refused instead of reporting a removal, and quitting the app in portable mode ends the daemon's web server and mission programs with it.
- **TIM-0107** — Windows: when the account password was reset, the background task could keep waiting for a sign-in and Timon never started. Opening the app now repairs it, `timon service repair` does the same, and `timon service status` says why the task is waiting.
- **TIM-0108** — Windows: a boot task deleted outside Timon (PowerShell, Task Scheduler) is now noticed, and Timon offers to reinstall it; the reason is written to the desktop log when it does not.
- **TIM-0116** — Plugins: enabling again a third-party plugin whose host half failed to load now loads the current files, instead of repeating the same error until the daemon restarts.
- **SUG-0063** — Windows: `timon export` and `timon import` no longer fail with `EPERM … symlink` from a non-elevated prompt when a plugin was installed from a local folder.
- **TIM-0114** — Windows: the `timon` CLI no longer prints garbled characters (`capacit├⌐s`, `┬╖`) in PowerShell 5 and the classic console; its output is plain ASCII there.
- **TIM-0106** — Windows: a chat link to a local file written as `D:/…` (or `C:\…`, `file:///D:/…`, with spaces) now opens the file instead of doing nothing.
- **TIM-0105** — The pinned navigation rail no longer collapses and re-expands each time you change page.
- On a phone, the central chat of the cockpit scrolls again.
- **TIM-0110** — `timon import --force` on Windows no longer reports "timon.db is locked" when the real cause is a permissions refusal: the error now gives the system codes and says whether it is a lock or an access problem, and the fix it suggests uses commands that exist.
- **TIM-0113** — A task whose worktree folder was removed by hand can be deleted again, and its worktree can be released even when its agent has no working folder.
- **TIM-0111** — A Codex follow-up whose saved thread can no longer be found now continues on a new thread instead of failing, and no longer sidelines Codex for 30 minutes. A backend paused by the failure safeguard is no longer reported as "out of quota".
- **TIM-0112** — Deleting a team no longer makes the daemon try to wake it again and again at startup; messages waiting for a deleted agent are set aside.
- **TIM-0109** — When the daemon cannot use its database because of the disk (I/O error, disk full), its log now says so with the free space left and it waits a minute before restarting, instead of restarting every 2 seconds; on Linux the service also spaces its restarts out up to 5 minutes. `timon doctor` shows the free disk space.
- **TIM-0109** — A failed automatic wake of an agent (for example a Claude account that belongs to a user refusing a mission with no owner) is retried with a growing delay, then given up with a single notification, instead of every 30 seconds. Returns and recaps now keep the owner of the work they report.

- Windows: switching a Codex conversation to another subscription account uses that account even when symbolic links are unavailable.

- Providers: a permission question from an ACP agent whose options carry no `kind` is answered by their ids (`allow-once`, `reject-once`) instead of being cancelled.
- Windows: Grok missions get the Grok sign-in even when Windows refuses symbolic links, and an attached image keeps its file name and a valid link.
- Linux: a mission running on another backend can no longer read the sign-in folders of Copilot, opencode, Hermes and Pi (`~/.copilot`, `~/.config/opencode`, `~/.local/share/opencode`, `~/.hermes`, `~/.pi`), as it already could not read those of Claude, Codex and Grok; `timon doctor` counts them among the masked paths.
- Backends: a backend set aside after a quota error is checked again before each new mission or message — against the account's real usage when Timon can read it — so it is used again as soon as its quota reopens instead of staying blocked for up to 5 hours.
- Backends: Timon no longer moves a conversation or a task onto a fallback backend whose CLI is not installed on this machine.
- Plugins: a third-party provider plugin no longer receives the mission's token.
- Kanban: a merge task now integrates into the base branch of its code task (`main` by default) instead of whatever branch the repository is currently on.
- Guided tour: the developer tour now creates the project with its own orchestrator (the demo project too), so the Agents page shows your main agent, then the project's orchestrator, then its coder.
- Guided tour: the developer code screen is set up in one card for the project and for your main agent's chat.
- Guided tour: the developer tour starts with the project, then shows the agents it created, and no longer stops on the multi-chat page.
- Setup: when no AI model answers, the setup screen offers to install Claude Code or Codex with their official installers — in one click, or by pasting the command — then gives the exact sign-in command for this machine.
- Setup: the setup step is centred vertically under the step indicator instead of sitting at the top of the window.
- Setup: the conversation now offers a Continue button after the agent presents Timon.
- Onboarding: the developer tour sets the whole code screen up in one card — the agent's chat on two thirds with its missions, files, project TO DO and git, the agent's browser above a terminal beside it — and explains each change in plain words.
- Onboarding: the guided tour opens in a taller popup and no longer puts a question under a long explanation; the profile is asked during setup.
- Onboarding: once setup is over, the cockpit's chat card starts a new conversation instead of reopening the setup one.
- Notifications: a question card in a conversation you are having no longer raises a “Permission required” alert.
- Setup: the restart banner fits on one line.
- Setup: the main agent's first conversation shows only what it says and its questions — no tool calls, “permission” badge or running-tool bar.
- Notifications: the “turn done” sound no longer plays twice when Timon is open in two windows.
- Setup: the main agent's first conversation shows the real top bar, and the menu rail no longer rides over it; the submit button reads `Meet <name>`.
- Setup: the main agent introduces itself under the name you gave it, and its first conversation keeps the composer's width.
- Onboarding: the guided tour first asks which language to speak, in a free-text field.
- Onboarding: the guided tour's chat popup opens in the bottom-right corner instead of covering the middle of the page it shows.
- Pages load faster: the Activity, Kanban, Workflows, Capabilities, Brain, Memory, Dreams, Bots, Secrets and Terminal pages, and the chat of an island or a card, are now downloaded only when opened.
- Chat: the scrollbar no longer fades under the gradients at the top and bottom of the thread, and it stays inside the composer's edges at every window width.
- Chat: the buttons that open the folded columns sit at the island's edges on desktop and no longer cover the running-tool and delegation bars.
- Chat: once the side columns fold away for lack of room, the thread and the message box span the island's full width with no side margin, the scrollbar on its edge, without running past the page's right edge; messages switch to the compact layout when the island is narrow.
- **SUG-0051** — Kanban: the Search box now also finds old Done tasks hidden behind **Load more**, and the Done counter and **Load more** follow the matches.
- Command cards: the **Refuse** button is now **Dismiss** — it only closes the card; the agent is not woken up and is not told the command was refused.
- Chat: the conversation and the message box take the full width when the widget columns are hidden or the room beside them is slim (a half-screen window, for instance), and the reading column is wider on a full screen.
- Mobile: scrolling inside an open widget column (or a dialog, a menu) no longer hides and shows the top bar.
- Popups: dragging a popup past the edge of the screen no longer makes scrollbars appear and shift the interface.
- Popups: opening a popup no longer pushes the page down by a "Page" tab header.
- Popups: opening a terminal (or any popup) no longer flashes the whole screen blank before it appears.
- Mobile chat: the buttons that open the widget columns sit just above the message box, smaller and discreet, and the copy / read-aloud icons under an agent message are no longer hidden by the fade at the bottom of the thread.
- Embedded browser: on a machine without the `traefik_network` docker network, starting the browser creates it; if docker cannot, the error names the network and the **Browser docker network** setting.
- **TIM-0104** — Docker widget: starting a project whose containers were created on a since-deleted network (`network … not found`) recreates them on the networks of the current Compose file; if that fails, the error names the network and suggests **Rebuild**.
- Chat on a phone: scrolling another island than the chat (a terminal, a file, the rails) now hides the top menu bar too, as scrolling the conversation does.
- **TIM-0102** — Agents: the editor's **MCP** tab shows Timon's built-in servers (`timon`, `timon_ask`, `timon-browser`, `grepai`) as always on, so they no longer look missing or impossible to grant.
- **TIM-0103** — An agent refused a mission or a task for an agent it does not orchestrate now learns which rule decided — a list set by hand in the **Orchestration** tab, or the reporting lines — and what lifts it.
- Layout: with the same view open in two windows (the desktop app and a browser tab, for instance), a change made in one is no longer erased by the next gesture in the other; that window reloads the layout and says so.
- Chat: the input of a chat opened in an island or a popup has its normal height again, instead of a tall empty box under the placeholder.
- Islands: closing the last island of a view, or the last popup kept on every page, no longer shows a "Could not save the layout" error, and the island no longer comes back on reload.
- Islands: the first click in an island without focus works — the microphone of a chat, or an answer to an agent's question with two chats side by side — instead of being lost while the island takes the focus.
- Islands: on a phone, the top bar folds and unfolds smoothly again while you scroll a chat that has islands, instead of stuttering with the page sliding under it.
- Phone: the menu bar now slides up out of view when you scroll down, instead of fading out behind the row of agent tabs.
- Phone: the menu bar and the agent tabs now slide together, smoothly, when they hide or come back on scroll.
- Chat: an agent's question shown in two places at once (the page and an island) can be answered from either, the two forms no longer unchecking each other.
- Multichat: the page no longer crashes with a React error when it opens.
- Islands: with the frosted-glass appearance on, the gaps between islands and the islands themselves are visible again instead of blending into the page.
- Islands: when docked windows leave little room, the stacked tab bar now offers **Detach** for a terminal or browser tab.
- Islands: an agent proposing to open the built-in browser or a file without the settings they need is now told so at once, instead of the card failing with "Embedded browser refused the settings it was given" when you apply it.
- Islands: applying an agent's whole arrangement keeps the islands whose content stays on screen, so a second card from the agent that opens something in one of them still applies.
- Islands: an agent's arrangement card for the chat now reads "View: Chat" instead of "View: Page".
- Plugins: editing a file under a plugin's `lib/` (not only its entry file) is now picked up live, within a couple of seconds, without restarting the daemon.
- Chat on a narrow window (phone, or a docked browser): each widget column now opens as its own panel inside the chat, with its real tabs and widgets, instead of a full-screen drawer that merged both columns; tap outside, swipe or Escape closes it.
- Kanban: the **Project** filter now also narrows the TO DO (backlog) column, which used to keep showing every project's ideas.
- **TIM-0101** — The Kanban page no longer fails with "Plugin @timon/kanban en erreur" when a task carries an unknown status such as `CANCELLED`; it is listed in the Done column.
- **TIM-0100** — The Missions list no longer scrolls behind the open mission detail panel.
- **TIM-0094** — A mission whose turn runs past 45 minutes while still working is no longer stopped as hung: only 45 minutes without any output count as stuck, and a separate turn budget (4 h by default, **Settings → Missions → Cleanup**) stops longer turns under the cause "turn budget reached".
- **TIM-0093** — On Windows, the Copilot CLI is found when installed with winget or under a custom npm prefix, even if the Timon service started before it was installed.
- **TIM-0099** — A new Codex (or Grok) mission of an agent now starts a fresh conversation instead of failing at once with "no rollout found for thread id".
- **TIM-0098** — A question or permission card left unanswered for more than 30 minutes no longer makes the agent give up waiting, and a card the agent stops waiting for is marked expired instead of staying pending.
- **TIM-0092** — An agent that ends its turn without closing its Kanban task is now asked whether the mission is finished and, if so, to close the task, instead of being stopped and its task requeued.
- Closing an agent tab in the top bar removes it until that agent starts new work.
- **TIM-0088** — MCP servers page: Timon's own servers (`timon`, the built-in browser, grepai) are no longer listed as claude.ai connectors, and a server from your local Claude Code configuration is badged "claude (local config)" instead of "claude.ai".
- Windows: when Windows never starts Timon's background task for your account (work or school account on a PC joined to Microsoft Entra ID), Timon says so and runs its built-in daemon instead of "The Timon daemon does not answer"; the setup screen offers the portable mode.
- Security: when the web interface listens beyond this machine (`app.listen.host`), or sits behind an HTTPS proxy, the daemon now refuses anonymous requests even before the first account is created; the first-run form keeps working with the one-time setup token.
- Security: the daemon now listens only on the address set in `daemon.listen.host` — by default this machine alone (127.0.0.1 and ::1) — instead of every network interface, so another device on the network can no longer reach it before the first account is created.
- Renaming an agent keeps its memory rules, routines, triggers, secrets and its place as a workspace lead.
- macOS: the background service's `daemon.log` no longer grows without limit; past 10 MB it is cut at the next start, its end kept in `daemon.log.1`.
- When the web interface stops starting, the alert and the daemon log now give the error the web app printed.
- With **Log the full system prompt** on, prompts go to `prompts-<date>.log` instead of filling the daemon log.
- **TIM-0087** — Windows: a background service installed with `timon service install` from Timon 0.1.3 or earlier is now rewritten at the next update (one Windows permission prompt), so the update window no longer fails with a 401 and stops coming back at every launch; your data is backed up before the update.
- **TIM-0085** — On Windows, agents no longer chain commands with `&&` (a parse error in PowerShell 5.1), and the built-in terminal starts PowerShell 7 when it is installed.
- Built-in browser: an agent and the browser panel now open the same profile for the same project, including when the agent's folder is registered outside a `…/projects/` directory (macOS `~/Documents/…`), for task missions and when the agent's project field is blank, so a sign-in made in the panel is there for the agent.
- First-run setup on a server whose web interface is reachable from the network now asks for a one-time setup token (`timon setup-token`), so a visitor can no longer create the first administrator account.
- Subscription account sign-in: the sign-in address is shown in full under the link, selectable, with a **Copy** button, for desktops where the link opens nothing (seen on Windows).
- The chat's **Files** card is now its own **Files** plugin in the gallery: it no longer disappears when the code pipeline plugin is off (Lite edition, or a licence without it), stays where you placed it, and a restricted role sees it only with the `widget:files-widget` permission.
- **TIM-0081** — Opening the Agents page no longer freezes for 20–30 seconds on an install that has been running for days: a window that is closed or reconnects no longer leaves its live event stream open on the background service, and a stream nobody reads is released after five minutes.
- **TIM-0082** — A mission running on Codex or another non-Claude backend no longer has its Kanban tasks executed by a Claude/Opus agent created behind its back: the agents it names in the project are used, and the agents Timon creates for a missing role follow the orchestrator's backend and model.
- **TIM-0083** — Projects: a project whose folder cannot be used now says why (folder not found, access denied with the system error code, or not a folder) and shows the registered path, instead of "no working directory". Saving a path that does not exist on this computer is accepted for the owner but now warns.
- **TIM-0084** — Files widget: **Show in system explorer** now opens Explorer on Windows and Finder on macOS, with the file selected, including when Timon runs as a background service. In a browser against a service with no desktop session, it says the file is on the computer running Timon.
- **TIM-0086** — Built-in browser: Ctrl+V, Ctrl+C and Ctrl+X (⌘ on macOS) copy and paste text on the page without a browser permission prompt; the **Paste into page** button says what it is waiting for and what to do if access is refused.
- An autonomous mission that ended its turn waiting on a background job of its own, such as a test suite, is no longer stopped at the 10-minute idle mark; a hard ceiling of one hour (`TIMON_REAP_BG_MS`) still frees its slot.
- Windows: after Timon was uninstalled and reinstalled, it no longer runs without its background service unannounced; at launch it offers to reinstall the service, so it starts with Windows and keeps running after you sign out again.
- A refusal on a mission with no owning account now says to relaunch it from your account instead of a bare `403 forbidden`.
- The role editor no longer lists the *Read workflows* and *Create and edit workflows* permissions, which never restricted anything; *Run workflows* is renamed *Start workflows from a trigger*, which is all it controls.
- `timon agent update --prompt-file` no longer clears the agent's role, picture, shared context or browser profile.
- Agents in a mission are no longer offered the `agent_spawn_ephemeral` and `export` tools they could never call; a workflow node waiting for explicit completion can be closed with the new `workflow_node_done` tool.
- Agents launched by a mission can create and update agents without a `403 forbidden` on Codex permission modes or on settings the agent already had, and a refusal says which field to change.
- **TIM-0097** — Agents created by another agent no longer lose the Timon tools, and the Timon servers no longer appear as a second `ext-timon` connector in the MCP list; installs already affected are repaired at startup.
- **TIM-0096** — Agents launched by a mission can create, replace and delete skills (`skill_put`, `skill_rm`) when your account may manage skills, instead of being refused with `403 forbidden`. The same goes for `http` MCP servers (`mcp_server_put`, `mcp_server_rm`); a `stdio` server, which runs a command on your machine, still needs the app or `agents:privileged-config`.
- On a phone, a long file opened from the Files widget can be scrolled again instead of showing only its first lines.
- **TIM-0070** — The built-in terminal shows Nerd Font icons and Powerline symbols (starship, Powerlevel10k, eza…) instead of unsupported-character boxes, with no font to install.
- **TIM-0063** — GitHub Copilot: a command outside the agent's allowed list now shows as refused by that list, with how to allow it, instead of an invitation to "retry in an interactive session"; agents are told to use an allowed command instead.
- **TIM-0062** — Windows: a Codex agent in plan mode can read files again (`Get-Content` and other commands) instead of failing with "blocked by policy", without any administrator prompt.
- **TIM-0075** — Built-in browser: sign-ins are kept when you quit and reopen Timon, including on sites that only keep you signed in until the browser closes, and survive the app being closed abruptly.
- **TIM-0064** — Changing a conversation's model: when the current model cannot summarise the conversation, the new model summarises it instead of only the end of the transcript being carried over, and a failed summary now shows its reason instead of "unknown error".
- **TIM-0065** — Kanban: a task whose mission keeps dying no longer restarts in a loop: past its automatic retries an agent may only restart it after changing its agent, backend or model, and past a second limit only you can. Its blocked reason now shows the last error reported by the CLI.
- Kanban: clearing a task's backend or model in its edit form now resets it to the project's default instead of keeping the previous one.
- **TIM-0078** — Kanban: a refused deletion names the tasks in the way, each card shows which tasks it depends on and which depend on it, and a task heading a verification chain can be deleted with its whole chain.
- **TIM-0061** — Desktop app: the chat mic no longer shows "Dictation unavailable: network" and stays stuck on "Listening…"; it is greyed out and says that voice dictation is not available in the desktop app yet.
- **TIM-0069** — Chat: messages from a previous day show their date next to the time (and the year when it differs).
- **TIM-0076** — Windows: a chat link to a local file written as `/D:/…` now opens the file instead of showing "Could not open".
- **TIM-0079** — Clicking a notification about a task (for example a blocked task) now opens that task's agent instead of an empty "Unable to find the main agent" screen.
- A conversation containing a very large message (big paste or attachments) updates live again instead of only after a page refresh.
- **TIM-0073** — The Codex backend model selector now includes models visible on the account (gpt-6.1-sol, gpt-6-sol, gpt-6-luna…) that were missing from the built-in list; the frozen list is used as a fallback when the account cache is absent or unreadable.
- The `project_todo_update` MCP tool and `PATCH /api/project-todo/:id` now return a 400 error naming the unknown field and listing the accepted ones (including `resolution`, `public_note`, `duplicate_of`) instead of silently ignoring it; `project_todo_add` / `POST /api/project-todo` behaves the same way.
- **TIM-0072** — A command an agent suggests no longer opens another project's terminal; each project keeps its own terminal window, tabs and position.
- TO DO cards: the Discord badge is one purple chip with the Discord logo in front of its name (it was a grey name next to a loose logo), and the three-line mark that appeared on every card with a description is gone.
- Voice dictation in the chat (mobile and some Android engines): a sentence is no longer repeated word by word ("salut salut comment salut comment ça…"); each word appears once.
- Plugins gallery: the Widget filter now lists every built-in plugin that provides a widget (clock, Files, Git, Grepai, Docker, Timon daemon, Video factory).
- Plugins gallery and widget window: the icon at the top of each card is centred again in the installed app (it sat against the left edge).
- TO DO ideas you add yourself no longer show the platform owner's first name as their author: they say "You", including the ideas already saved; the setting for the working day and the texts agents receive no longer name a person.
- **TIM-0067**, **TIM-0071** — Kanban: "Send back to the orchestrator" now reaches the project's orchestrator whatever its name, instead of failing with `expected <project>.main`.
- LLM quotas widget: Claude's extra credits show in euros (€2.73 / €20) instead of being read as cents (€273 / €2,000).
- Git widget (and any panel served by a module you turned off): shows "This feature is not available on this install" instead of `SyntaxError: Unexpected token '<'`.
- **TIM-0074**, **TIM-0095** — `mission_spawn` called by an agent with `model`, `backend`, `extra_skills`, `extra_mcp_servers`, `extra_allowed_tools` or `idempotency_key` now starts the mission instead of failing with a bare `403 forbidden`; a value that is still refused is named in the error.
- **TIM-0074** — the `timon spawn` command from inside a mission now starts the mission too (it answered a bare `403 forbidden` for every spawn), matching the `mission_spawn` tool.
- **TIM-0066** — Agents creating or editing an agent from a mission: a refusal now says which value was refused (permission mode, tools, backend, working directory) instead of a bare `403 forbidden` that looked like a missing `agents:manage` right.
- A Kanban task created by a mission can no longer set a permission level, backend or extra tools above what its creator may.
- **TIM-0068** — Windows: updating no longer reports a partial backup ("plugins changed during its copy") when plugins are linked from a local folder or written to during the copy. A partial backup now says your data were saved and only the plugins were not, and is shown once instead of at every launch.
- **TIM-0077** — Windows: updating an install with a large database no longer reports a failed backup; the plugins are backed up too, and a file briefly locked by the antivirus no longer fails the copy.
- Agents in a mission can call an API under a secret granted to them (`timon_http_call`) instead of being refused with `403 forbidden`.
- Pipelines: deleting a pipeline that had already run no longer fails.

### Known issues

- Chat: when an agent's folder is a different Git repository than its project's (not one of its worktrees), the branch menu above the message box lists and switches the project's branches.
- Windows: quitting the app does not stop a daemon run by the background task, and ending the task from Task Scheduler leaves its repeating trigger to start it again within five minutes; only `timon service uninstall` stops it for good.
- Windows: on a work or school account of a PC joined to Microsoft Entra ID, Windows may refuse to run Timon's background task; Timon then runs only while its window is open.
- macOS: the usage of a Claude subscription account is not shown in the LLM quotas widget nor under the chat composer; Codex accounts are.
- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, or no reviewer) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- Pi has not been tried on a tester's own account yet, so a first mission may fail.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.
- Windows: installing a new version of the app closes the built-in terminal's shells.
- Voice dictation (chat mic and cockpit voice mode) is not available in the desktop app; it works when Timon is opened in Chrome or Edge.
- Google refuses to sign in directly from the built-in browser ("This browser or app may not be secure"); use **Sign in with Chrome** in its options menu, which needs Chrome, Edge or Chromium installed outside a snap or flatpak package.
- **Sign in with Chrome** copies the sign-in into the built-in browser; whether Google keeps it valid there over time has not been verified, and a password or 2FA step has not been tried. Run it again if the session is lost.

## [0.1.4] — 2026-10-09

### Added

- Agents can do from their tools whatever the `timon` command does: change an agent (`agent_update`, memory scope, deletion), manage skills and MCP servers, follow and steer missions, start the project's browser, run pipelines and routines, read memory, notify you. A new agent in the desktop app no longer needs the `timon` command on the PATH to edit the agents it creates.
- `mission_spawn`, `kanban_add` and `kanban_update` accept a model, a backend and extra skills, MCP servers and allowed tools, like their CLI counterparts, and any backend id instead of only Claude and Codex.
- Chat: hovering an agent's message shows **Copy** and **Read aloud** buttons under it, bottom left. The read-aloud toggle next to Send in the composer is gone.
- Terminal, browser and Files windows: drag a floating window to the left or right edge of the screen and a light bar shows where it will dock; release to dock it. Drag a docked window's title bar to turn it back into a floating window.
- An agent can **suggest a command for your terminal**: it is typed at the prompt of the terminal window without pressing Enter, so you read it and validate it yourself.
- A built-in **terminal** runs a shell on your computer from the desktop app, a browser or your phone (**Terminal** page, or the chat's **Terminal** button), with extra keys on touch screens; shells keep running when you leave, your phone locks or Timon's service restarts, and the window floats, docks to either side of the app (beside or over the content) or folds into a tab. Reserved to accounts allowed to open a terminal (the superadmin by default).
- Settings → Appearance → **Widget style**: **No borders** and **Transparent background** apply to every widget at once (with the frosted glass switch, a glass look in three clicks). Switching one of them restyles every widget at once, including those you styled one by one; a choice made afterwards from a widget's own menu is kept, and **Follow the site style** gives the widget back to the site's.
- Layout editing: each widget has a grip at its left and a gear at its right, and the cross is gone. Drag a card by any part of it; the gear (or a right click on the card or a tab) opens its settings, with **Delete** last, in red, and an **Undo** after deleting. A column's buttons (second column, swap sides, collapse) fold into one **⋯** menu next to **+**, and the "Vertical / Horizontal" label is gone. The **Done** button is now inside the widget window, which opens from **Add widget** (Edit Layout alone does not open it); closing that window (Done, the cross or Escape) ends layout editing, and Escape leaves a plain Edit Layout. Every widget has a precise name and a one-line description in that window, which has one tab per page (Cockpit, Chat, Agents, Sidebars, Top bar); the chat widgets for your agents are all called **Agent chat**, "Kanban TO DO" becomes **All-projects TO DO**, and the Agents widget is **Agents list**. The widget cards in that window lose their zone menu and their **+** button: you drag a widget out of the window, and it is painted live in your hand as it will appear.
- Missions list widget: right-click a mission to rename it, copy its ID or stop it; missions are ordered by their latest activity, each row shows the agent's avatar (switchable in the widget's options while editing the layout) and the age next to the ID. The three dots wave again while a mission is working, and the state badge, event count and cost are gone from each row.
- The right side of the top bar is a widget zone: in layout editing, drag the notification bell or the LLM quotas rings into a sidebar, where they stay compact (the bell button, the rings stacked), or into the cockpit or a chat column, where they show as a card, and back. Clicking the bell or the rings opens their detail next to them, always kept on screen, phone included.
- The archive page (`/notifications`) can choose which kinds of notification the bell's menu and the Notifications widget list, and how many (5 to 100); the bell's badge then counts only the kinds shown.
- Every notification names the agent that raised it (in the bell's menu with the agent's avatar, in the notification center and in the archive); notifications from Timon itself say Timon.
- **Pi** ([pi.dev](https://pi.dev/)) can run as a backend through the `pi-acp` adapter: install `pi-acp` and `pi`, sign in with `pi-acp --terminal-login`, and agents can run on it. Pi decides its own tool permissions, and Timon's own tools do not reach it.
- A built-in `create-timon-plugin` skill: type `/create-timon-plugin` and what you want in the chat, and the agent builds, installs and checks a plugin by following the plugin docs.
- Agents can set or remove the profile picture of any agent (`agent_set_avatar` tool, `timon agent set-avatar` command), and `agent_list` now returns each agent's picture as `icon_url`.
- Agent tabs in the top bar are now centred, and a small pin button keeps an agent's tab open even when it is idle; pinned tabs come first and are remembered on your account.
- A bell in the top bar, next to the appearance menu, opens the notification center and shows how many notifications are active.
- `timon health` shows the daemon's memory use and open event streams.
- Files widget: with a picture open, the left and right arrow keys (or the arrow buttons) show the other pictures of the same folder, with a "3 / 12" counter; it stops at the first and last picture.
- Files widget: right-click a file or folder for a menu to open it, rename it, show it in your system explorer or delete it.

- Files widget: drag a file or folder onto another folder (or the empty area, for the root) to move it, after a confirmation; an entry of the same name is never overwritten.

- The sign-in page has a **Forgot your password?** section explaining how to recover an account, including the `timon user reset-password` command for an administrator who is locked out.
- **Set as main orchestrator** in the right-click menu of an agent's avatar: wake recaps and notifications are addressed to that orchestrator instead of the seeded `_main`. The agent that holds the seat cannot be removed until another one takes it.
- Each TO DO idea shows its number (for example `#209`, the number agents cite in their reports) and its author as grey badges, in the TO DO widgets and the Kanban TO DO column; a widget's display options, in edit mode, can hide either one.
- Settings → Backends: each model takes a context window typed by hand (for example `200k` or `1M`), which the chat's context gauge uses instead of the detected one.
- The side columns of a chat can hold several tabs of widgets: add one with **+** while editing the layout, drag a widget onto a tab's number to move it there.
- **SUG-0020** — The chat's side columns can be widened or narrowed by dragging their inner edge (or with the arrow keys; double-click restores the width), and each side can get a second column while editing the layout; when the window is too narrow for it, the second column folds into a tab of the first.
- Codex: the thinking levels offered for each model follow those your Codex account lists (for example `max` or `ultra`), instead of a fixed list.
- The TO DO widgets can be filtered by type (critical, bug, minor issue, idea, no type) with compact icon-and-count chips beside the Open / Done switch, and their title sits on its own line again.
- A TO DO idea linked to a Kanban task is ticked done on its own once that task's work is merged, and its detail dialog lists the linked tasks.
- Task returns in an orchestrator's chat show as one card per return, under the agent that did the work: task, outcome, merge commit, closed ideas and the agent's short summary, with the full report behind **Details**. Agents give that summary when they close a task (`--summary`, or `summary` on `kanban_mark_as_done`).
- Triggers → Webhooks: GitHub, GitLab, Standard Webhooks or your own signed calls can run actions in Timon, with filters on what they send, a sample tester and a journal of calls.
- Triggers → Events: actions can run when a task is done or blocked, a mission ends, an agent sends a message or a notification arrives.
- Triggers: an event fires when a TO DO idea is done, and a new **Webhook (send)** action posts a signed call (Standard Webhooks) to an https address you choose, retried while the receiver is down.
- A trigger's actions can create a TO DO idea, a task for an agent, a notification, or start a workflow (when the Workflows module is on).
- A task created by a trigger right after a TO DO idea is linked to that idea: a research task marks it analyzed when done, other tasks tick it done when their work lands.
- A TO DO idea can be given an outcome (fixed, declined, duplicate, needs info, in progress, planned) with a public note for its author and the item it duplicates; each new outcome fires the `todo_resolved` trigger event, so it can be sent to the author on Discord.
- Plugins can create TO DO ideas tied to a ticket elsewhere (a GitHub issue, a Discord thread, a Jira ticket) with the new `todos:read` / `todos:write` permissions; a ticket received twice lands on the same idea, and the idea's detail links to where it lives.
- Plugins can keep a TO DO idea and its ticket elsewhere in step: they are told when an idea gets an outcome, is closed or is deleted (and who did it), can edit and close ideas, and can send their updates through a queue that retries, keeps their order and signs them.
- Plugins can receive signed calls from services outside Timon (webhooks, permission `webhooks:receive`); their address and secret are in Settings → Plugins → the plugin, where a superadmin generates or rotates the secret.
- Plugins can switch off the triggers they replace (permission `triggers:disable`) and show their own badge or block on a TO DO idea.
- Settings has a search field: it finds a setting by name, description or a few hidden keywords and lets you edit it right in the results, and it jumps to sections such as Appearance, Notifications or Instructions.
- A mission shows what it really is — **Working** (a turn is running), **Turn done** (process alive, waiting for your next message), **Open** (nothing running) or **Interrupted** (with the cause: usage limit, killed, stopped by hand, crash…) — plus the messages and requests still waiting, in the chat's mission list and the Missions table; on the Agents graph a small dot marks an agent whose turn is done, whose mission is open or was cut.
- `timon stop agent <name>` / `timon stop project <slug>`, and **Stop everything** in an agent avatar's menu, really stop a scope: running missions terminated, inbox and open requests cleared without a reply, pending tasks blocked, triggers switched off, with the list of what was neutralised (permission `missions:stop`).
- **TIM-0056** — `timon import --no-projects` leaves the archive's projects out of the restore, and `timon import` lists the restored projects whose folder does not exist on this machine.

### Changed

- The built-in browser no longer has a "take control" arrow: you and the agent can use it at the same time. Opening the panel is enough to click and type, even while the agent is browsing; only a second device of yours waits for a click to take over.
- Widgets now start without borders on a new install (Settings → Appearance → **Widget style** → **No borders**, switch it off to get them back). An install that already saved its appearance keeps its choice.
- The built-in browser and the Files widget's viewer and editor open in the same window as the terminal, with the same buttons: it floats and moves, docks to the left or right of the app (beside or over the content) and remembers its place on each device, so a file can stay open next to the chat. The browser's pin button is replaced by these buttons. Text files open as tabs in the same window, and the View / Edit switch and the Save button are now icons (the separate Source mode is gone).
- In the Files viewer, minified JSON is shown indented, and keys, strings and numbers get distinct colours in both View and Edit. Files in the Files tree and in the editor tabs get a coloured icon per type (PDF red, Word blue, Excel green, PHP purple, JS yellow, and so on). Floating windows resize from any edge or corner.
- A link an agent posts to a file it created (an absolute path, a `file://` link or a relative path) opens in the Files viewer window instead of failing, including on a remote install. A link to a file outside the agent's folder asks first (Yes / No, with the full path); on Yes the file opens for reading and editing, for accounts holding the new **Open files outside an agent's folder** permission (superadmins have it).
- The first-run setup no longer asks for a projects folder: the agents it creates work in the `workspace` folder of the Timon home (`~/.timon/workspace`).
- The bell of the top bar opens a dropdown of the recent notifications, with **Mark as read**, **Mark all as read** and a link to the full list. The same list is a **Notifications** widget you can add from the widget palette, for example into the side navigation.
- The LLM usage card is now called **LLM quotas**, so searching the widget palette for "quota" finds it; it can be placed in any widget zone while the ring stays in the top bar.
- The agent tabs of the top bar show the agent's avatar, with a pulse around it while it works; the close button sits at the top right and the pin at the bottom right.
- Idea outcomes (resolution, public note, duplicate reference) now come with the TODO outcomes plugin and are off by default: turn on "Idea outcomes" in Settings → Plugins → TODO outcomes; the Outcome block of an idea then saves with its own button.
- On a phone, the agent tabs have their own bar under the menu bar, and it stays at the top of the screen when the menu bar hides on scroll; the home-screen app on iPhone no longer draws the top bar under the status bar.
- The top bar and the side navigation share one colour with no border between them, clearly set apart from the page (darker in the dark theme, a soft grey in the light one), and the page curves into them with rounded corners at the top and at the bottom.
- Settings → AI models: turning a provider off now asks for confirmation in a dialog, instead of a message that appeared under the list.
- Settings → AI models: "backends" are now called **providers** (the tab, the button to add one, and the messages).
- Settings → AI models: each backend row is cleaner — only the switch and the pencil remain. **Remove** and **Test** are in the edit panel, and a backend whose program is not installed shows a **Not detected** badge instead of a line of red text.
- Agent chat widget: right-click an avatar for **Customize agent** (a nickname and a photo, on this card only), **Edit agent** (the agent's settings) and **Remove**. The card's configuration form, reached through Edit layout, is gone.
- Agent chat widget: the header row and its voice button are gone outside layout editing, so the card starts on the avatars; the top of the conversation fades out under them, whatever the wallpaper. Chats opened on a project fade out at both ends the same way.
- **New conversation** moves into the message box of every chat, project chats included.
- Navigation: Missions, Inbox, Memory and Stats are grouped under one **Activity** entry, and Skills and MCP under one **Capabilities** entry, each with horizontal tabs. The old pages still open from their links.
- Navigation: the account menu is gone from the foot of the navigation. Profile, License and Sign out now sit at the foot of the Settings window, and Profile and License open inside it; License is shown to the superadmin only. The Settings gear takes the very bottom of the navigation.
- Secrets moves from the navigation into Settings, as its own category.
- Settings: the window is larger, and the search field sits in the header next to the **×** instead of on a line of its own.
- Settings: every setting is now always shown; the **Show advanced settings** button is gone.
- Settings closes with a small **×** instead of a **Close** button, and a click outside it closes it too (Escape still works). A click outside keeps it open while a field holds a value you did not save.
- The Routines page becomes **Triggers**, with three tabs: Routines, Webhooks and Events. Your routines are unchanged, and Routines links open the Routines tab.
- Setup screen: when Timon cannot open the folder you picked, the message gives the error code it received (for example `EPERM` or `ENOENT`) instead of always saying the folder does not exist, and the folder picker opens in your home folder when the field is empty.
- Setup screen: the **Projects folder** field is now **Working folder**, with a line saying it is where your main agent and the starter team work; it does not have to hold your projects.
- Settings → AI models → Auto switch: the fallback model is now picked from the model selector instead of typing the backend and model by hand, so the pair can no longer be mistyped or disagree.

### Fixed

- `timon agent set-scope` now changes the agent's memory scope; it was silently ignored.
- The built-in browser's tools are now named `timon-browser` and a new agent is told so, with how to start it (`timon browser start`). Your own `chrome-devtools` server is no longer replaced and keeps working next to it.
- First-run screen: DeepSeek, Kimi and Ollama Cloud appear as cards that say which tool they run through (Claude or Codex) and that they need an API key, added in Settings once Timon is installed.
- First-run screen: opencode, Hermes and Pi are detected and shown next to Claude, GPT, Grok and Copilot, so a machine with only one of them no longer reads as "no agent tool found".
- Reloading the page in a chat now brings you back to the conversation you were in, instead of the agent's latest one.
- Your profile name and picture now show on your messages in the chat, instead of a fixed "you" and the letter "b".
- GPT agents (Codex) use Timon's built-in browser when asked to open, read or check a website, instead of answering from a web search.
- Files widget: a new file or folder is created in the folder you are in (the last one you clicked, or the one holding the file you opened) instead of the root, and hovering a truncated name shows it in full.

- **TIM-0060** — Mobile: the top bar no longer flickers in and out when you scroll a short page, scrolling to the bottom of the message box or of the thread no longer makes the screen jump, and the layout follows the on-screen keyboard.
- **TIM-0044** — macOS: Claude usage and the Agent tab show the account as signed in after `/login` in the terminal, instead of staying on "Not signed in".
- **TIM-0045** **TIM-0046** — macOS: `timon service install` while Timon.app is open no longer leaves the service in a restart loop on port 3010; it stops with a message asking you to quit Timon.app first.
- **TIM-0033** — The `timon` command shipped with the app no longer crashes when it is started with your system's Node: it relaunches itself through the runtime bundled with the app.
- **TIM-0049** — When a backend such as Copilot stops without answering, the chat says so, with its exit code and the end of what it wrote, instead of "thinking" and then nothing.
- `timon plugin add ./some-folder` installs a plugin from a relative path instead of failing with `ENOENT` on `package.json`.
- **TIM-0052** — Signing in to a site such as Google or X in the agent's browser no longer loops back to the login page: the browser, popups included, now presents itself as plain Chrome from its first request.
- **TIM-0057** — You are no longer signed out in the middle of your work: a session now renews while you use Timon (up to 30 days after sign-in), and the sign-in page says when your session has expired.
- **TIM-0054** — Deleting a project no longer leaves it on the agents grid: a window asks whether its agents are moved to another project, detached or deleted.
- **TIM-0051** — Desktop: clicking a link to another site (for example a GitHub pull request) opens it in your browser instead of replacing the Timon window, which had no way back.
- **TIM-0053** — The main orchestrator no longer calls you by the maintainer's first name when it asks you to decide (series plan, closed form channel, fast-mode briefs): it says "the user".
- **TIM-0055** — `timon project list` prints the project slugs instead of `[object Object]`.
- In a chat, the task briefs sent by the dispatcher and the other automated instructions are shown under the main orchestrator's name instead of the bare word `orchestrator`.
- An agent that answers another agent's request with a plain message no longer sends a second, automatic answer: the asking agent gets one reply and wakes once.
- An agent that asked another agent two questions and got a plain message in return now still receives an answer to each question, instead of waiting forever.
- A plain message or notification sent to an agent no longer starts a turn for it: only requests, answers to a request and task or mission returns do, the rest waits in the agent's inbox. Use a request to ask another agent to act.
- Two agents that keep messaging and waking each other without any input from you are stopped: past a ceiling their messages are held in the Inbox (status **Held**) and you get an alert naming the pair; writing to either agent lets them resume.
- Chat: the caret of every fold (tool calls, reasoning, automated instructions) sits at the right; consecutive automated blocks are merged into one fold, with more space around it.
- An agent closing its Kanban task no longer gets a "Connection closed" error on `kanban_mark_as_done` and no longer retries a task that is already done.
- The Trace card, the mission Trace tab and the trace page stay fast on missions with a huge number of spans: they load the latest page, fetch older ones on request and refresh with only what is new.
- A chat conversation whose backend runs out of quota mid-turn now switches itself onto the fallback backend and carries on the same conversation, instead of staying stuck on the exhausted account until you act.
- A Kanban task whose model the provider reports at capacity (for example codex "Selected model is at capacity") now moves to its fallback backend and runs again right away, instead of being retried three times on the same model and then blocked.
- `timon service install` run from the installed app now sets up a working service: on macOS the daemon no longer restarts Timon in a loop with nothing listening on its port.
- Uninstalling Timon while an update is waiting for your approval now removes the service instead of failing and leaving it running.
- **TIM-0037** — Windows and macOS: the "daemon does not answer" dialog no longer points to a `daemon.log` that does not exist; it says no log was written and what to check instead.
- **TIM-0043** — opencode: the **Thinking level** slider now appears for the models that offer levels, and the level you pick is applied to the mission.
- Custom providers: each model shows the thinking control that fits it (levels, low / medium / high budget steps, or off / on), detected automatically and correctable per model in the backend editor. On the Anthropic protocol, the setting now reaches models set by a budget or a switch (such as Qwen), and level-based models (such as `claude-sonnet-4.6`) receive the level you pick.
- The opencode and Nous Research logos now show in the LLM Quota widget and in the backends settings (they were replaced by a letter); the Hermes backend is labelled "Hermes (Nous Research)".

### Known issues

- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, no reviewer, or a branch merged by hand) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- Pi has not been tried on a tester's own account yet, so a first mission may fail.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.
- Windows: installing a new version of the app closes the built-in terminal's shells.

## [0.1.3] — 2026-10-02

### Added

- **Beta build end date**: a banner announces the end of the build or of your licence 14 days ahead (red from 3 days), then a «This build has expired» or «The beta has ended» screen takes over — the latter accepts a new key, both keep an **Export my data** button. There is no fallback to Free during the beta.
- **TO DO tags**: each idea carries an urgency tag (critical, bug, minor issue, idea) and a progress tag (to do, analyzed, partially done, to test, done), with an icon and a colour, set when creating or editing an idea and shown on the TO DO widget and the Kanban column. Ticking an idea and tagging it done stay in step.
- **Global instructions** (Settings → Instructions, first category): one markdown file, `global-instructions.md` in the Timon folder, sent to every agent at each spawn right after the Timon preamble — for what you want from all your agents (language, commit style, how you test). It shows in an agent's Injections tab with its own «you» origin.
- The agent's **Identity docs** are a column of files with the markdown rendered and an Edit button; files you could add (`SOUL.md`, `charter.md`, `rules.md`, `style.md`…) are listed dimmed and created in one click. Every `.md` file of an agent is now sent to the model, right after `SOUL.md`.
- The LLM tab of the agent editor has a **Thinking level** slider over the levels the chosen model supports, saved with the agent; the useless «Use plan max» switch is gone.
- The **Agent injections** widget lists, in the order Timon hands them to the model, everything Timon injects into an agent when it starts (Timon preamble, SOUL.md, role, custom directives, memory rules, `system-prompt.md`, skills), then the project's `AGENTS.md`/`CLAUDE.md` as files the CLI may read; each item shows where it comes from (Timon, agent, memory, skills, project) and its size in tokens, with the total sent before the first message. Click an item to read it as markdown in a dialog, and edit it there where its source is editable. Pinned in an agent's chat, the widget shows that agent only. The agent editor has an **Injections** tab with the same steps as a timeline. Secrets are masked, and a masked item cannot be edited.
- The agent editor has an **Orchestration** tab to choose which agents an agent may hand work to: tick agents, or pick **All** or **None**. The inherited list (its sub-agents, or everyone for an orchestrator) is shown as such and can be overridden or restored; a refusal from Timon is shown with its reason.
- The Files widget opens images, videos, PDFs and Word, Excel and PowerPoint documents in a read-only viewer instead of "Binary file — preview omitted"; Office files show their text, cells and slide text (no pictures or layout), with a Download button.
- The Multichat side bar folds into a rail of avatars (`Ctrl+B`, `⌘B` on macOS) and now holds the templates and grid-size menus.
- Multichat agents are grouped by pole, project and team, folded by default, with a search (`/`) that ignores accents; `Enter` adds the first result to the first empty cell.
- **SUG-0008** — Agents can show an image or a video in the chat (a file of their working folder, an `https://` address downloaded by Timon, or an inline image), with a preview you can enlarge and a Download button; images generated by a Codex agent appear at the end of its turn.
- The cockpit chat card shows its agents as one row of avatars, the one you are talking to larger; click an avatar to switch the chat, or the + at the end of the row to add an agent from a searchable list.
- **SUG-0001** — Multichat can save the grid and its agents as named templates and switch between them in one click.
- The Files widget has a Refresh button that reloads the folder listing and the open file.
- **SUG-0004** — GitHub Copilot is a new LLM backend: install the Copilot CLI and run `copilot login`, and agents can run on your personal or company Copilot subscription, with the models your organisation allows.
- Saved layouts can be applied to every project's view of the same page from the "Manage" mode of the appearance menu; the "Manage" button is now labelled, so overwriting a saved layout with the current one is easy to find.
- **OpenCode** and **Hermes** (**Nous Research**) can run as backends, through **ACP**: install `opencode` or `hermes-acp`, sign in with the agent's own CLI, and agents can run on them, with replies, tool calls, Allow/Deny cards (Hermes) and Stop working like on the other backends. opencode defaults to the free Muse Spark 1.3 model, which needs no account.
- The chat shows the reasoning of agents that expose it (opencode, Hermes, Codex, Copilot) as a collapsed "Reasoning" block.

### Changed

- The chat's **Identity** widget is gone: click the agent's avatar or name in its messages to open its editor. On hover, the role badge turns into a pencil inside a spinning ring.

- The Timon preamble sent to every agent is now in English and only describes Timon: no hard-coded project path, no personal conventions, and the knowledge vault and code-index (`grepai`) sections appear only when a vault is configured or the project has an index.
- The agent editor loses its **Role** tab: the role is picked in **Identity**, «Project tasks» and «Global context» moved to **Workspace**, and an agent's custom directives are now a `directives.md` identity doc (existing ones are moved there when the daemon starts).
- The Orchestration tab of the agent editor lists only the agents the edited one may hand work to, each with its avatar and a delete button, and a search field adds another; the agents that report to it in the canvas and the team of bots of each one are tagged, and two buttons add the canvas reports or the team in one click.
- The agent editor is plainer: the header shows the avatar and the name only, Save sits at the bottom right, and the agent picker, «Open in canvas», «Test prompt», «Open chat with this agent» and the «All changes saved» indicator are gone. An agent without a picture of its own shows its project's.
- An agent's prompt now puts its `system-prompt.md` and skills before the memory rules and the cross-project digest, so the rules read against a project the model already knows.
- Agents asked to plan work on the Kanban now open the planner instead of a plain question: the form tools are named `kanban_plan` and `question`, on the `timon_ask` server. Replace `ask_user`, `ask_series_plan` and `timon_permission` in your own agent prompts and skills.
- An agent can start a mission or assign a task only to the agents it orchestrates — its sub-agents (agents that report to it), or everyone for the main agent and orchestrator-role agents; otherwise the request is refused with a 403 naming both agents. Messages are unchanged.

### Fixed

- On a first install the service start no longer ends on a "Startup failed: launchctl kickstart" dialog on macOS; Timon loads its service itself and waits for it.
- **TIM-0042** — Onboarding, «Meet your main agent»: once a picture is set, the button now reads «Choose another picture» and opens the file picker, so it can be replaced before Continue.
- **TIM-0040** — Importing a backup replaces the agents of the install instead of merging them: the imported orchestrator is your main agent, no stray `_main` remains.
- **TIM-0041** — `timon import --force` no longer fails with `EBUSY` on `timon.db` on Windows: a locked file is retried, then moved aside, and the old database's `-wal`/`-shm` files are removed.
- Closing the agent editor now asks «Discard unsaved changes?» when the Orchestration tab holds a selection you have not applied; applying it clears the warning.
- The thinking-level slider is back next to the model name, in the chat bar and in the agent editor, for an agent pinned to a full model version such as `claude-opus-5-5`.
- A skill you invoke with `/skill` in a follow-up message to an agent on Codex, Grok or Copilot now folds its procedure into a «Skill /name» line you can expand, instead of pasting the whole text in your bubble.

- Settings → Memory opens on the **Obsidian** tab, and its vault folder field has a **Browse** button in every client: the desktop app opens the folder picker, a plain browser explains that and leaves the text field.

- An agent started by Timon or by another agent (Kanban task, routine, sub-mission) can no longer ask you a question and wait for you: the question is refused and the agent is told to ask the agent that started it, or to decide on its own when there is none.

- Multichat accepts an agent dropped anywhere on a cell, including one showing a conversation, and highlights the cell under the pointer.
- The built-in browser address bar accepts `google.fr` without `https://`, and searches the web when you type words instead of an address.
- opencode installed with its official script (`~/.opencode/bin`), or with Scoop or Chocolatey on Windows, is detected even when that folder is not on the service's PATH. Hermes installed on Windows (`%LOCALAPPDATA%\hermes\bin`) is detected the same way.

- The desktop app shows a "Starting Timon…" screen with the current step instead of a black window while Timon starts, and says so if the interface never answers.
- **SUG-0009** — The Agents entry in the side menu stays highlighted while you are in a conversation.
- **TIM-0036** — An unsent message in the composer is kept per conversation when you switch windows or pages, and cleared once sent.
- **TIM-0035** — Clicking Cancel in the "Compact the mission" dialog no longer leaves the whole interface unresponsive.
- **TIM-0031** — An agent you just created now shows up in the Agents graph instead of staying hidden under a folded project lead.
- On Windows, restarting the service from the desktop (first-run wizard, once the configuration is written) now asks for administrator approval and actually replaces the running daemon.
- The in-progress task list on the Agents page animates the "thinking" indicator on every mission being worked on, not only the first one of each agent.
- A Kanban task that depends on a `code` task of the default pipeline now waits for that task's review and merge, instead of starting as soon as the code is written.

### Changed

- Images written inside a message, a note or an inbox item are no longer loaded; their caption is shown instead.
- **SUG-0003** — The main agent's default prompt shows the real agents folder of your installation and an example working directory for your OS (Windows, macOS or Linux), and the docs gain a "Where Timon keeps its files" table with the Windows and macOS equivalents of `~/.timon`.

### Known issues

- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.
- **TIM-0034** — Windows Smart App Control can block the unsigned installer; workaround: turn Smart App Control off in Windows Security.
- If your organisation disables third-party MCP servers in Copilot, agents on Copilot cannot use Timon's tools and fall back to the `timon` command.
- **TIM-0030** — Windows: a popup at startup and daemon crashes. The VBScript deprecation alert is no longer raised since 0.1.2 (the launcher no longer uses `wscript`); the cause of the crash is still under investigation.
- A Kanban task that depends on a `code` task which never gets a merge (no changes to review, no reviewer, or a branch merged by hand) waits indefinitely; remove that dependency to release it.
- opencode and Hermes have not yet been tried on a tester's own account, so a first mission (Hermes especially) may still fail.
- opencode decides its own tool permissions: Timon shows no Allow/Deny card for it and cannot restrict what it does. The agent editor says so.
- MCP servers you add over HTTP are not passed to opencode and Hermes agents; Timon's own tools and stdio servers are.
- Opening the model list of opencode or Hermes leaves one empty session per agent in that agent's own history.

## [0.1.2] — 2026-09-27

### Added

- Windows: the installer installs Node.js (LTS) and Git when they are missing, after asking for permission once.
- Settings → Appearance: pick your own accent colour with a colour picker; it applies in light and dark mode.
- Settings → Appearance → Frosted glass: translucent, blurred widgets, top bar and side menu, and optionally frosted chat bubbles.
- Agents can search and read the Timon documentation of your installed version, offline, with the new `docs_search` and `docs_read` tools.
- The LLM quota monitor is now included and active out of the box — no install needed, on every licence; turn it off from Plugins.
- Voice conversation with a mission through OpenAI GPT-Live: turn it on and store its API key in Settings → Interface → Voice, then use the new conversation button next to the mic. The mission's agent still answers; GPT-Live speaks for it.
- GPT-Live conversations are now written into the chat as they happen, with a sphere showing whether it is listening, speaking or waiting for the agent, and requests about your projects are reliably handed to the mission.
- Workspaces are now poles of their own: a pole can exist before any project joins it, and a pole without a lead agent shows on the Agents graph as a grouping node with its projects.
- Agents graph: a **+ New pole** chip creates a pole (name, colour, optional lead agent), and right-clicking a node opens its menu: open chat, configure, change who it reports to, move its project to another pole, edit the pole.
- Agents graph: drop an agent onto another to make it report to it, or a project's lead onto a pole to move the whole project; every move can be undone from its confirmation.
- Agents graph: an **Organization** panel lists the whole hierarchy as a tree you can reorganise by drag and drop.
- Agents graph: a group you drag by its top agent stays there, even after a reload; right-click → **Reset position** puts it back. Any other agent springs back under its parent when released.
- Agents graph: only the orchestrators show at first; the **+N** badge on an agent shows its sub-agents, right-click hides them again, and the graph remembers your choice.
- The Company chart and the Agents graph now show the same reporting lines; changing a manager in Company moves the agent on the graph too.
- Agents graph: the badge on an open agent folds its sub-agents back, and a folded agent lights up while one of the agents it hides is working.
- macOS: with a Claude token from `claude setup-token` (Settings → Backends, or `timon auth claude-token set`), `timon service install` makes Timon start at boot and keep running after you log out.

### Fixed

- Windows: updating an installation that runs the Timon service no longer fails with "Update request failed (401)", and your data is backed up before the update.
- The update window no longer lists an older version's known issues when a newer version fixed them.
- Windows: installing an update while the Timon service runs no longer stops on "Timon cannot be closed"; the installer asks for permission once to pause the service.
- Windows: after uninstalling and reinstalling Timon, it starts instead of reporting "The Timon daemon does not answer".
- Windows: the setup screen no longer shows "Failed to fetch" while installing the background service.
- Windows: the setup screen's Install buttons for Node.js and Git find winget and install them.
- macOS and Linux: the `timon` command no longer crashes when your system's Node.js runs it; it switches to the app's own runtime.
- Dragging an agent in the Agents canvas now moves its sub-agents along with it, their links stretching slightly as they follow, and the group stays where it is dropped, after a reload or when a branch is unfolded.
- The chat opens faster: the conversation now loads before the side panels and the navigation links.
- Long conversations open quickly: the chat shows the latest 60 messages, with a button at the top of the thread to load older ones.
- On a large installation, the interface no longer freezes for a fraction of a second every few seconds.
- On a large installation, the chat opens faster and its mission list refreshes without slowing the app down.
- The dashboard and the chat's Git widget no longer make the whole app stall each time they refresh.
- An open Kanban page no longer slows the whole app down on installs with thousands of finished tasks.
- Agents graph: zooming with the mouse wheel and panning are smooth again; with frosted glass on, the panels over the graph are no longer blurred.
- Agents graph: when a project has several orchestrators, the one its agents report to stays at the top, instead of whichever was created last.
- Agents graph: the canvas can be grabbed and panned through the side panels wherever they hold nothing, and the page content now starts right under the top bar.
- Saving an agent in the agent editor no longer takes it out of its team.
- The Agents graph no longer piles up nodes when there are many projects: every workspace, project and role gets enough room around its parent, and workspaces sit side by side without overlapping.
- GPT-Live now reads out the agent's answers even when the request was typed in the chat, answered in a form or came back from a mission, and no longer says it is looking at something without asking the agent.
- When GPT-Live reads out the agent's answer, the chat no longer shows that answer a second time as a voice bubble.
- A single GPT-Live answer no longer splits into two voice bubbles when it pauses, for instance after reading out an identifier.
- Windows: Timon now starts at boot and keeps running after you sign out; after a restart it waits for your first sign-in, and it restarts on its own if it stops. Its output goes to `%USERPROFILE%\.timon\tmp\daemon.log`.
- **TIM-0024** — The "Licence is no longer valid" alert disappears once the licence is valid again, and a brief failure to identify the machine no longer switches a valid licence off.
- **TIM-0022** — Windows setup: the Install buttons for prerequisites work on a fresh Windows, and a failed install now shows the tool's own error instead of a bare `exit 1`.
- Workflows: the post-run timeline of an agent node shows what the agent did (turns and tool calls), including for runs made before this version.
- The light/dark theme no longer changes between onboarding and the app: a new install keeps the OS theme shown during onboarding, and an existing install keeps its own theme in the desktop window and the update window.
- Setup: when "Write configuration" is greyed out, the screen says why (projects folder missing or unusable), and a reinstall offers the projects folder of the previous installation.
- **TIM-0028** — Windows: updating no longer reports a partial backup when a plugin was installed from a local folder; the plugins are backed up with the rest.
- Chat: a first message made only of pasted text (or of an attached file) now starts the mission instead of being refused.
- A coder delegated by another agent no longer opens the series planner card; it works on its brief directly.
- **TIM-0025** — Long notifications can be expanded in the Notification center.
- Chat: the context gauge now shows the context actually used on GPT (codex) models instead of staying at 0.
- **TIM-0027** — Agent editor: the Identity text stays visible after Save.
- Settings → Backends: every model of a built-in or plugin backend can now be renamed or deleted, and the model ID field no longer locks while you type.
- Chat: a reply that arrives while the live stream missed the end of the turn (for example right after switching model) now shows up without reloading the page, and the thinking indicator stops.
- Chat: the thinking indicator follows the transparent bubbles setting.
- Layout mode: a widget can be dropped as the last tab of a stack, in the free space after its tabs.
- Kanban tasks no longer stay queued while every mission slot is held by agents that have finished their turn.
- The Telegram channel now starts on machines where Node.js is not installed.
- Ollama Cloud and Kimi use an `OLLAMA_API_KEY` or `KIMI_API_KEY` saved in the Secret Vault (granted to `global`), without a restart.
- Company canvas, Bots and Agents views: the main agent you named at onboarding stays at the top, and a new agent is attached to it instead of appearing as `_main` above it. A new agent is created with the coder role instead of orchestrator.

### Changed

- Agents graph: each node carries a single caption (the project for its orchestrator, the full name for a role, with its role icon), initials instead of words inside the disc, and links stop short of captions so they stay clean on any background or wallpaper; the full name and project are in the tooltip.
- Agents graph: agents are laid out in rings around their pole or orchestrator, so links keep a steady length as you add agents, and an unfolded project fans its sub-agents out tight around it and only its own link lengthens, without moving its siblings or its group; names hide when you zoom out and reappear on hover.
- Settings opens as a dialog over the page you are on, with eight categories (each with its own icon) split into tabs; the Obsidian vault folder is now under Memory → Obsidian, with a Browse button in the desktop app, and a plugin's settings sit in its category or under Plugins, hidden while the plugin is disabled.
- Settings → Access & network → Web interface shows at a glance whether remote access works and is safe, then walks you through opening Timon from your phone step by step.
- Settings → LLM backends is easier to read: every backend row lines up, a backend opens in a side panel, its picture is picked from a single row of icons, and its models are reordered by dragging a handle.
- Grouped widgets show their tabs as a segmented control inside the widget card, and a long row of tabs scrolls with the mouse wheel without a scrollbar; a lone widget keeps its plain title.
- The widget appearance menu has a Hide title option: a lone widget then shows only its content, with no tab or title.
- The Missions widget shows its role filter and the new button on a single row; the New mission dialog (LLM choice and resume) is removed — start a fresh chat with new and pick the model from the composer.
- Project TO DO: an Open / Done switch with counts filters the list, and an Add button at the top right opens the full dialog (title and description); the inline field at the bottom is gone.
- Widgets (Files, Project TO DO, Missions…) no longer draw a separator line under their header or toolbar.
- Widget toolbars (Missions, Files, Git, Skills, MCP servers, Project TO DO) share one layout: same height and margins, ghost icon buttons, the main action outlined; the Skills and MCP "manage" links become a settings icon.
- The voice sphere is larger and sits over the input instead of above it, so the conversation keeps its room; it takes the colour of your theme, and the input stays usable underneath. In GPT-Live, the status pill and captions above the input are gone: the sphere alone shows the live session, and the conversation no longer shifts when it starts or stops.

### Known issues

- macOS: while Timon runs with no session open, Git over HTTPS and `gh` fail in missions; Git over SSH works.

## [0.1.1] — 2026-09-21

### Changed

- The desktop app is much smaller to install, which speeds up installation, especially on Windows: about 7,000 files instead of 31,000, and installers roughly half the size.
- **The Mails tile is now an optional plugin, no longer built in.** Install the
  supplied package with `timon plugin add <folder>` from the source
  checkout (or use the path to your supplied package). Your saved service URL is
  carried over automatically, even if you install later; an existing plugin URL
  is kept. Add the service hostname to `pluginPolicy.http.allow` to permit the
  connection. The plugin is not preinstalled, and its widget starts with a new
  placement. 
- A plugin's browser half can only subscribe to the same platform events as its host half; other event kinds, including mission transcripts, now throw.
- A `codex` backend file that sets `OPENROUTER_API_KEY`, as the earlier OpenRouter recipe did, is now refused with the name to use instead: rename it `BACKEND_OPENROUTER_API_KEY` in `env` and `envKey`.
- The day and night "Memory — soft threshold" resource settings are removed; missions now only have a hard memory ceiling (Linux). A value still set for `TIMON_DAY_MEM_HIGH_GB` or `TIMON_NIGHT_MEM_HIGH_GB` is ignored and reported in the daemon log.

### Added

- Built-in role prompts can be edited and reset to their shipped defaults from Manage roles.
- Browse for a project's working directory when creating or editing it in the desktop app.

- Settings → LLM backends now lets you disable and reorder all backends, edit their model lists and pictures, and pin exact model IDs; recently added models show a New badge for seven days.

- Desktop updates now ask for approval before changing your installation, with release notes and backup progress.

- Packaged updates wait for your approval before backing up and migrating existing data; headless installations can approve with `timon update approve <version>`.

- Memory limits automatically adapt to detected RAM, with 8/16/32/64 GB presets available in Settings → Resources.

- Install code-free provider packs and enter their API keys in plugin settings.

- **Add your own LLM provider.** Settings → LLM backends adds any Anthropic- or
  OpenAI-Responses-compatible provider from a form (name, base URL, key, Test
  button), or from a JSON file in `~/.timon/backends/`, with no restart. An
  inactive backend shows why.
- **Name the models of a backend you added, and give it a logo.** Settings → LLM
  backends now edits a saved backend: its model list (slug, label, default), its
  key, and a picture for the backend and for each model — a brand we ship, an
  emoji, or an image of your own. Providers that do not list their models, such
  as the Anthropic endpoint of DeepSeek, no longer need a hand-written file.
- **TIM-0021** — An opt-in agent editor focus diagnostic is available for investigating uneditable fields on Windows.
- Plugin authors can reuse Timon’s dialog and select components and cockpit surface styling through `@timon/ui`.
- **Go back to a previous version.** Reinstalling an older installer, 0.1.0 included, moves the background service back to it; Timon now keeps a copy of your data before each new version and, when you open an older version, offers to restore it or keep the current data.

### Fixed

- Codex missions can search the web again on macOS.
- **TIM-0011 (2)** — macOS (Apple Silicon): the web interface no longer stops on its own.
- **TIM-0011 (6)** — macOS: plugin switches turn plugins on and off without an invalid-ID error.
- **TIM-0011 (7)** — macOS: pages no longer fail with `SyntaxError: Unexpected end of input`.
- **TIM-0011 (8)** — macOS: a new skill saves without a `content required` error.
- On a fresh macOS or Linux install, the final “Restart” step of the setup no longer loops back to itself: it now restarts the background service.
- On desktop, a conversation with only short messages keeps the full width of the message box below instead of shrinking.
- Updating the desktop app on macOS and Linux no longer fails right after clicking “Update” with a service updater error.
- When a desktop update fails, the error window shows the actual reason instead of a block of unreadable code.
- The desktop update window now uses the same colours as the rest of the app.
- Release notes in the desktop update window are now formatted (headings, lists, bold, code) instead of showing raw Markdown.
- A mission whose backend CLI cannot be started now says so in the conversation, naming the backend and the command that was not found, instead of opening an empty thread. A backend whose CLI is missing is also reported at startup, with what to install or how to point Timon at it.
- Onboarding identifies the main orchestrator and explains that it delegates work to other agents.
- Onboarding preserves the chosen main agent name during concurrent startup and assigns the configured workspace when the agent has none.

- Restoring a pre-update backup also restores saved plugins and their data; partial backups are explicitly reported and can restore your database and settings while leaving omitted plugins unchanged.

- GPT is now detected on Windows when only the Codex desktop app is installed, and keeps working after the app updates itself.
- Claude is now detected on macOS when only the Claude desktop app is installed, and keeps working after the app updates Claude Code.
- Installing a new version over an existing one now also updates the background service on Linux (.deb and AppImage). If that update fails, Timon says so and keeps running on the previous service or its built-in daemon, with your data untouched.
- Automatic memory presets account for reserved RAM so nominal 16/32/64 GB machines keep their expected class.
- A day or night CPU quota changed in Settings now applies within a minute, without waiting for the day/night switch or a restart (Linux).

- An agent whose process runs out of memory — a runaway test, for example — is now stopped on its own and told why, instead of freezing every other running mission (Linux).
- A mission using a lot of memory no longer gets the whole desktop session closed by the system OOM daemon; a mission is stopped instead, with an alert beforehand when memory pressure builds up (Linux).
- On the agents grid, a project without an orchestrator agent now shows its own logo and colour instead of a generic folder icon.
- A task sent back for changes after review now keeps the backend and model you chose for it.
- The Bots view now appears in the plugin gallery and can be switched off there; switching it off also closes `/bots`.
- Finished tasks no longer leave leftover folders in Timon's worktrees directory, which could consume several gigabytes of disk space.
- Desktop installers expose the `timon` command without requiring Node.js (Linux deb, Windows, and macOS pkg).
- Unknown API URLs no longer display the application shell to signed-out visitors.
- Remote-access commands use the managed web server’s port and are withheld when the local target is unknown, including Docker behind a reverse proxy.
- Selecting a remote daemon by URL no longer exposes local credentials to that host.
- **TIM-0021** — New-agent fields accept input immediately, without waiting for catalogs to load.
- **TIM-0011** — Empty or malformed sign-in state responses now report the failing endpoint and HTTP status instead of a bare JSON parsing error.
- `timon wait` returns as soon as the mission finishes its turn, instead of blocking until the agent process is released minutes later.
- The final report of a delegated mission is no longer cut short with a pointer to a task that does not exist; longer reports are kept and the pointer names the mission.
- The CLI automatically connects to the local daemon on the port saved by the desktop installation or configuration.
- The desktop window opens even when its icons are unreadable, with a reinstall warning; closing the window without a tray icon quits the app.
- **TIM-0015** — Windows uninstall removes the scheduled task while updates preserve it; silent uninstall requires administrator rights.
- **TIM-0011 (7)** — The onboarding theme script parses correctly and applies the system color scheme before the first paint.
- **TIM-0011 (5)** — The usage tile stays idle when Claude Code is not signed in, with a sign-in hint, instead of showing an error.
- **TIM-0011 (3)** — macOS and Windows no longer offer “Open a terminal”, which cannot open a window on those hosts.
- **TIM-0011 (1)** — Pinning the navigation keeps it expanded on every page.
- **TIM-0019** — The notification area icon is visible on Windows, macOS and Linux.
- **TIM-0011 (4)** — Opening chat uses the renamed main agent without duplicate “agent not found” requests.
- **TIM-0011 (2)** — Web app startup waits for an occupied port, retries clean exits twice with backoff, and reports persistent failures without incorrectly requesting a rebuild.
- **TIM-0018** — Missing Codex credentials are reported with sign-in instructions and the searched path before a mission starts, in Setup, and in the diagnostic.
- **TIM-0014** — Windows: Codex installed from Setup is detected immediately and after reopening Timon.
- **TIM-0020** — Agents without a working directory can be created and saved.
- The agent editor’s Name label and hint now follow the selected language.
- **TIM-0016** — Deleting a Pending or Blocked task no longer fails with a server error; the Kanban explains why a deletion is refused.
- **TIM-0009** — Windows: the first agent now starts after onboarding, with its Codex credentials.
  A Codex CLI too old for the selected model is refused with the command that updates it.
- **TIM-0013** — Windows and macOS: the main orchestrator can now create agents and projects instead of getting `403`.
- **TIM-0010** — macOS: the app stays clickable after creating a team in Bots.
- **TIM-0017** — Licence transfer: activating another machine too early now shows when to retry.
- Tasks now switch to the fallback backend as soon as a CLI session expires.
- The models picked per role in the series planner now apply to every task of the series, without changing the project roles.
- Skill forms show invalid IDs and missing instructions before saving.
- TO DO ideas update without reloading the page.
- **TIM-0012** — Codex agents can ask you questions again on instances with accounts.
- Saving a file from the Files widget works again.

### Known issues

- Ollama Cloud does not use an API key saved in the Secret Vault or the settings; it only works with `OLLAMA_API_KEY` in `~/.timon/secrets.env`, followed by a restart.

## [0.1.0] — 2026-09-12

First beta release, distributed to testers as packaged Electron builds for
Windows, macOS and Linux.

### Added

- Desktop client for the three platforms, shipping its own daemon.
- Guided first-run setup: account creation, projects directory in the notation
  of your own OS, agent seeding, daemon restart as the closing step.
- Beta licence keys, revocable server-side, required to create the first
  account.
- Multi-user accounts with groups, roles and per-user preferences.
- Agents with roles per project — who codes, who reviews, who merges — and a
  Kanban board that dispatches work into git worktrees.
- Plugin runtime: every surface of the product is a slot occupant, and
  third-party plugins install as signed npm packages without a restart.
- Remote access over Tailscale, Telegram channels, inbound webhooks, and a
  bearer-auth remote API.
