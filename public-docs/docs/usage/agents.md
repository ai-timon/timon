---
title: Agents
sidebar_position: 2
---

## Create a worker

Open **Agents**, choose the create-agent action and set:

- A unique name and a focused system prompt describing the work.
- An existing absolute working directory on the daemon's machine.
- A project, if this agent belongs to one.
- A backend and model from the available catalogue.
- The permission mode, skills and MCP servers needed for the task.

Save, open the agent's chat and start with a small request. An agent configuration is reusable; creating it does not itself complete a mission.

For the CLI equivalent, prepare a plain-text prompt file and replace the example path with your project:

```bash
timon agent create project.writer --cwd /path/to/project --prompt-file writer.md
timon list
timon spawn project.writer "Summarize the README in this project."
```

## The agent editor

Open an agent's editor by selecting its avatar or name in the chat, or from the node menu of the Agents graph. Its tabs:

| Tab | What you set |
|---|---|
| **Avatar** | The face the agent shows everywhere: an emoji, an image, or its mascot (see [Change an agent's avatar](#change-an-agents-avatar)). |
| **Identity** | Name, colour, role, and the agent's identity docs. |
| **Orchestration** | Which agents it may hand work to. |
| **LLM** | Backend and model, in the [model picker](missions.md#choosing-a-model), and **Thinking level**. |
| **Workspace** | Working folder, «Project tasks» and «Global context». |
| **Permissions** | Permission mode, allowed and denied tools, and the tools you always allowed from a permission card. |
| **Skills**, **MCP** | The skills and MCP servers attached to it. |
| **Injections** | What Timon hands the model when the agent starts (see below). |

The header shows the avatar and the name only; select the avatar to open the **Avatar** tab. **Save** sits at the bottom right. Closing the editor with changes you have not saved, the Orchestration selection included, asks **Discard unsaved changes?**.

### Change an agent's avatar

Open the **Avatar** tab of the agent editor, or right-click the agent's avatar in a chat card or its node in the Agents graph and choose **Change avatar** (shown only if your account may edit agents). The head shows on the left; on the right, pick one of three heads, then set it:

- **Emoji**: type or paste one, choose a quick pick, or open the full list.
- **Image**: upload a picture, then frame it (zoom, position, background). **Adjust** frames the current picture again; **Remove** takes it off.
- **Mascot**: dress the agent's meerkat — skull, fur, eyes and accessory, with a live preview and states to try. In the tab, the preview, its states and **Surprise me** stay on the left and every choice fits on the right; in the narrower first-run panel they are stacked. **Surprise me** draws a whole look. It starts from the look the agent has, or the one its role gets by default. It is the same configurator as the one the first-run setup opens. Plugins can add parts to it: a mascot pack's skulls, furs, eyes and accessories show in their own group under the pack's name, and **Surprise me** draws among them too. If you disable or remove the pack, an agent that wore one of its parts shows its role's default for that part until the pack is back.

Select **Save**. The chosen head is shown everywhere the agent appears. The settings of the two other heads are kept: switch back at any time without setting them again. A head with nothing set yet (an image mode without a picture, an empty emoji) leaves the agent's current face until you set it.

An agent whose head was never chosen keeps the face it had: its picture, else its project's logo, else its mascot, else its emoji or initial.

#### What a mascot shows

When an agent's head is its mascot, the mascot shows what the agent is doing, wherever it appears: chat cards and bubbles, the chat's header, the side rails, Multichat, the Agents graph and the Kanban cards. In a conversation, only one bubble's mascot is alive: the card waiting for your answer, otherwise the message being written or the agent's latest one; the others keep still.

| The mascot | Means |
|---|---|
| Sleeping, eyes closed | The agent has no conversation or mission running. |
| Calm, blinking, following your pointer | A conversation is open; the agent is not working on a turn. |
| Thinking (dots, a look aside) | The agent is working on a turn and writing its answer. |
| Working (focused eyes, looking down) | The agent is using a tool that changes something (editing a file, running a command). |
| Searching (eyes sweeping) | The agent is looking something up (reading, searching, listing). |
| Waiting for you (wide eyes, hopping) | The agent waits for your answer, a permission or a question. |
| Happy, briefly | The agent just finished its turn. |
| Celebrating, briefly | One of the agent's tasks was just marked done. |

Menus and long lists show the mascot's plain look, without its state. A mascot that is off screen, or whose agent is asleep, does not move.

To keep the mascots still, turn off **Settings → Appearance → Animate mascots**: they still show their state with their eyes, without moving. If your system asks to reduce motion, mascots never move, whatever this setting says.

**Customize agent**, in the same right-click menu of a chat card, is something else: it changes the nickname and photo shown on that card only.

### Identity docs

An agent's identity is a set of Markdown files next to it: `SOUL.md` (its character and ground rules), `directives.md` (its custom directives), and any other `.md` file you add. The **Identity** tab shows them as a column of files with the Markdown rendered and an **Edit** button. Files you could add (`SOUL.md`, `charter.md`, `rules.md`, `style.md`…) are listed dimmed and created in one click. Every `.md` file of an agent is sent to the model, right after `SOUL.md`.

From a terminal, `timon agent doc list|get|put|rm <agent> [<file>]` does the same (`put` reads the content from `--file PATH` or from stdin, up to 2 MB); an agent uses the `agent_doc_list`, `agent_doc_get`, `agent_doc_put` and `agent_doc_rm` tools. An agent may change its own docs, and an orchestrator those of the agents it orchestrates, as long as they do not run with a higher permission mode than its own; any other write from an agent is refused. Changing a doc from the app or with your own account is not limited. `system-prompt.md` cannot be deleted, and the agent's settings (model, permissions, MCP servers) are not docs: they change in the editor or with `timon agent update`.

The agent's role is picked in the same tab. There is no separate Role tab.

### Thinking level

The **LLM** tab has a **Thinking level** slider over the levels the chosen model supports; the choice is saved with the agent. A higher level makes the model think longer before it answers: slower, and it uses more of your subscription. The same slider sits next to the model name in the chat bar, for an agent pinned to a full model version such as `claude-opus-5-5`. A model with no levels shows no slider. With opencode the levels come from opencode itself, model by model, so the slider appears for the models that have some and the chosen level is applied when the mission starts. With Codex the levels follow those your Codex account lists, read from the cache the Codex CLI keeps (`~/.codex/models_cache.json`); that cache is refreshed when you run `codex` yourself, and without it Timon offers its built-in list. A model of a provider you added shows the control that fits it: a level slider, **low / medium / high** budget steps for a model set by a token budget, or **off / on** for a model with a thinking switch (see [Add a provider](./add-a-provider.md#thinking-setting-of-each-model)).

### Rename an agent

Change the name in the **Identity** tab, or run `timon agent rename <old> <new>` (an agent uses the `agent_rename` tool). The agent keeps its folder, identity docs and memory, and its missions, tasks, routines, triggers, messages, secrets, browser profiles, project roles, reporting lines, workflows, pipelines, chat cards and multichat templates follow the new name. A trigger filter that names the agent exactly is updated, including **contains** or a plain regex such as `^name$` that spells the whole name; any other pattern or substring is left as is, and you are told which triggers to check: on screen and in `triggers_to_check` for the triggers you can see, and through a notification to each trigger's owner. The rename is refused while one of its missions is running, and when another agent already has the new name.

### Delete an agent

**Delete** in the agent editor, or **Delete agent** when you right-click its node in the Agents graph (shown only if your account may edit agents), moves the agent to the trash: its configuration, system prompt, identity docs, memory and checked skills wait there (an agent created later under the same name starts without them), and **Restore** in the confirmation toast brings it back at once. Later, restore it from **Settings › System › Backups & trash**, or with `timon agent trash list` then `timon agent trash restore <id>`; an agent uses `agent_trash_list` and `agent_trash_restore`. The main orchestrator cannot be deleted. See [Backups and the agent trash](settings.md#backups-and-the-agent-trash-system) for how long the trash keeps them.

### Duplicate an agent

Right-click an agent's avatar in a chat card, or its node in the Agents graph, and choose **Duplicate agent**. Timon asks for the name of the copy and refuses one that is already taken. The copy has the same configuration and prompt as the original; edit it afterwards like any other agent. Its memory starts empty: nothing the original learned is carried over. The copy is never the main orchestrator, does not take over a role pinned for a project, and starts with no conversation or mission of its own.

### Copy agents to another Timon

To bring one agent, a few or all of them from one Timon to another, export them on the first machine and import the archive on the second. To bring agents from Grok Bot or Hermes, and for everything the import preview lets you choose, see [Import agents](import-agents.md).

- **From the app**: on the **Agents** page, **Export** opens the list of the agents your account can read. Pick some, or **All agents**, then **Export**: a `.zip` lands in your downloads. On the other Timon, **Import agents** on the same page, choose **Timon agent archive (.zip)**, check the preview, then import.
- **From a terminal**:

```bash
timon agent export researcher writer --out agents.zip
timon agent export --all --out all-agents.zip
timon agent import agents.zip
```

`timon agent import` shows the preview, then asks before writing anything. Pass `--yes` to import from a script; without `--yes` and without a terminal to answer in, nothing is imported. An existing file is never replaced unless you add `--force`. These commands copy agents only: `timon export` and `timon import` copy a whole installation, see [Upgrading](../installation/upgrading.md).

What is carried over: the name, the system prompt, the identity docs (`SOUL.md`, `USER.md`…), the extra directives, the agent's memory rules, its skills (text), its MCP servers, its routines (schedule and time zone, switched on or off as they were), its picture, its team, its role and project, its backend and model, and its working folder.

What stays behind: secret values, conversations, missions, logs and memory files. An MCP server comes with the **names** of its headers or variables, never their values; the preview lists the secrets to enter again in the vault. An MCP server that runs a command on the machine is not created on the other side: add it by hand if you trust it. Skills that ship with Timon are not copied, since every Timon has them.

The preview says what does not fit the other machine:

- a working folder that does not exist there (a Windows path imported on Linux, for example). The agent is created without one, and when a folder with the same last names exists under your home, the preview proposes it: **Use it** in the app, or `--accept-cwd` with `timon agent import`;
- a backend or a model that is not installed there. The agent then uses the default one;
- a role, a project or a folder the account may not set. The agent is created with the defaults, and the result says so.

Imported agents are named `timon.<name>`, or `import.<name>` when agents that the import did not create already use names starting with `timon.`. Importing the same archive again updates them instead of making copies, unless you changed them by hand in the meantime. Exporting needs an account that can read agents, and importing needs one that can create them.

## Agents graph

**Agents** shows your organisation as a graph: poles (workspaces) group projects, each project's orchestrator sits at the top of its agents, and every link is a reporting line. The Company chart shows the same lines.

- **Poles.** Choose **+ New pole** to create one (name, colour, optional lead agent). A pole can exist before any project joins it.
- **Unfold and fold.** At first only the orchestrators show. Select the **+N** badge on an agent to show its sub-agents, and select it again to fold them. A folded agent lights up while one of the agents it hides is working. The graph remembers your choice.
- **Reorganise.** Drop an agent onto another to make it report to it, or drop a project's lead onto a pole to move the whole project. Every move can be undone from its confirmation. The **Organization** panel lists the same hierarchy as a tree you can reorganise by drag and drop.
- **Arrange.** Dragging an agent carries its sub-agents with it. A group you drag by its top agent stays where you drop it, even after a reload; right-click it and choose **Reset position** to put it back.
- **Node menu.** Right-click a node to open its chat, configure it, duplicate it, change who it reports to, move its project to another pole, edit the pole or delete the agent.

## See what an agent is given at start

An agent that drifts is often following an instruction you forgot it had. Add the **Agent injections** widget from the widget palette, pick the agent, and it lists everything Timon injects when that agent starts, numbered in the order it hands it to the model:

1. the Timon preamble and the description of the agent's LLM backend;
2. your [global instructions](settings.md), when you wrote some;
3. `SOUL.md`, the other identity docs, the role, then the agent's custom directives;
4. `system-prompt.md`, then the skills — imported ones whole, then the catalogue, one line per skill (each entry is badged **imported** or **catalogue**, with where it comes from);
5. the memory: the global digest, the curated rules that apply to the project, the role and the agent, then the recent pitfalls.

The stable text comes first and what is recalled for each mission comes last, so a memory that differs from one mission to the next never breaks the identical start of the prompt.

The project's `AGENTS.md` and `CLAUDE.md`, when they exist in the working folder, are listed last, unnumbered, and marked **may be read by the CLI**. Timon does not inject them: whether the backend reads them, and where they land in the prompt, is up to that CLI and differs from one backend to the next. They are candidates, not part of the order above, and are read-only here. Files a CLI reads elsewhere (your home folder, parent folders, imports) are not listed.

Select a row to read it. Items you can change carry an **editable** badge: **Edit** opens an editor and **Save** writes to the real source (the agent's file, its directives, the role, the memory rule or the skill), then the list is read again. Editing a role changes it for every agent that has it. Preamble, backend description and digest are written by Timon and cannot be edited.

A secret from the vault appears masked on this screen, and the item says what the agent receives: **masked here** means the agent gets the value in clear, **masked when sent** means it does not (a skill pasted for a backend that reaches neither the skill's folder nor Timon's tools). An item that contains a secret cannot be edited from the list, because saving the masked text would replace the real one. Next to a chat, the widget follows the open mission: its backend and model, and the skills it adds to the agent's own (a Kanban task adds `timon-task`, and `timon-worktree` when it works in a worktree), are listed as that mission received them. Elsewhere, the list shows the agent's start-up in general. Tools a task adds and the mission's own text are never part of it.

## Who can hand work to whom

An agent can start a mission for another agent, or assign it a Kanban task, only if it **orchestrates** that agent. Talking to an agent (messages) is not affected.

- The main agent and every agent with the orchestrator role can hand work to all agents.
- Any other agent can hand work to the agents that report to it, directly or through other agents. An agent nobody reports to can hand work to nobody but itself.
- Asking an agent it does not orchestrate is refused with a **403** naming both agents, the rule that decided (a list set by hand, or the reporting lines) and what would allow it.
- An agent cannot change these rights, nor move an agent it does not orchestrate, nor change its own reporting line.

## Working agents

The **Working agents** widget shows the agents doing something right now: thinking, waiting for you, or done in the last minutes. It starts in the middle of the top bar (on a phone, in a row under it). A click on a tab opens that agent's chat.

- **Pin** an agent with the pin at the bottom right of its tab, shown when you hover the tab: its tab stays, even when the agent rests, and pinned tabs come first. Your pins are kept for your account, on every device.
- **Reorder the pinned tabs** by dragging a tab along the widget: a coloured line shows where it will land. A tab that was not pinned becomes pinned where you drop it. From the keyboard, right-click a pinned tab (the menu key) and choose **Move left** or **Move right** (**Move up** / **Move down** in a column).
- **Open a chat beside the page** by dragging its tab out of the widget onto the page: the island workspace takes it where you drop it.
- **Hide** a tab with the cross at its top right; it comes back with the agent's next mission. The tab of the chat you are in never hides.

The widget is moved by its title and removed from its ⚙ menu, like any other widget. It takes the shape of where you put it: tabs side by side on the top bar, faces stacked in the side navigation (pin and hide are then in the right-click menu), a card of rows in the cockpit, a chat column or an island.

Its options (the ⚙ button in its header; on the top bar and the side navigation, rest the pointer on the widget for two seconds to show it):

| Option | What it does |
| --- | --- |
| **Show: Agents at work / All agents** | Every agent you have, at rest too, instead of only the ones at work |
| **Orchestrators only** | Only your main orchestrator, always shown, and the projects' orchestrators while they work |
| **Group by project** | One tab per project, with its agents' most urgent state and how many are at work (thinking or waiting for you); a click opens the chat of the project's orchestrator, and a drag out of the widget opens it in an island. The pin then holds the project: a pinned project comes first, stays even when its agents rest, and is reordered by a drag like an agent's tab. An agent that belongs to no project keeps its own tab |
| **List the project's agents on hover** | With the grouping, hovering a project's tab lists its agents at work, each one opening its chat; with none at work, no list opens |

The options and the order of your pinned tabs belong to your account, like your pins.

## The main orchestrator

One orchestrator receives what Timon says on its own: the wake recaps (a blocked task, the end of a batch) and the notifications. A fresh install starts with `_main`; renaming it during setup keeps it in that seat.

To give the seat to another orchestrator, for example one you created yourself, right-click its avatar in the chat card and choose **Set as main orchestrator**. It must have the orchestrator role, belong to no project and not be temporary; Timon says why when it is refused. The change takes effect for the next recap.

The agent that holds the seat cannot be removed: designate another orchestrator first, then remove the old one.

If no agent holds the seat — after a database restore, for example — Timon checks it at startup and whenever an agent is created, renamed, removed or changes role: when exactly one orchestrator is eligible, it takes the seat. Otherwise the seat stays empty, because choosing among several is your call: a notification **No main orchestrator** lists the eligible ones, once per empty spell, and `timon doctor` shows `main orchestrator NONE` until you designate one.

If no agent holds the seat, the **Agents** page draws no main agent: agents without a manager stay at the root of the graph and of the **Organization** panel, and a warning offers each eligible orchestrator the seat with **Set … as main orchestrator**.

## Customize a role prompt

In the agent editor's **Identity** tab, next to the role, open **Manage roles** and select a built-in role. Edit its
instructions and save. The role is marked **Modified**; its identity, icon,
colour, model and permission defaults remain unchanged.

The saved prompt applies to all agents using that role in new missions.
Choose **Reset prompt** to discard the customization and restore the prompt
shipped with Timon. Roles without a customization follow prompt updates in
future releases. Built-in roles cannot be deleted.

## Choose who an agent orchestrates

In the agent editor, open the **Orchestration** tab to choose which agents this agent may hand work to (missions it starts, Kanban tasks it assigns). The tab lists only the agents it may hand work to, each with its avatar and a delete button; a search field adds another. The agents that report to it in the graph and the members of its team are tagged, and two buttons add them in one click. **All** and **None** are there too.

Until you change it, the list is inherited — the agents that report to it, or everyone for the main agent and orchestrators — and the tab says so; choose **Restore inherited** to drop your override. A list set by hand replaces the reporting lines entirely: an agent that reports to this one, now or later, is not part of it unless you add it. Only you can change it: an agent cannot edit its own list, and a refusal from Timon is shown with its reason.

## Skills and tools

Skills are `SKILL.md` instruction packages attached to an agent; [Skills](#skills) below explains how they reach it. MCP servers expose tools. Attach the ones the agent actually needs; a backend's hosted account connectors and Timon's configured MCP servers are different sources of tools.

On the MCP servers page, a server Claude Code loads by itself is read-only and badged **claude.ai** when it is a connector of your claude.ai account, or **claude (local config)** when it comes from Claude Code's own configuration on the machine (`~/.claude.json`, a project's `.mcp.json`, a plugin). Turn either off per agent from the chat sidebar.

An agent working a Kanban task does not inherit those account connectors: Timon turns them off for it unless its role lists them. Two advanced settings widen that:

- **Notes connector kept for task agents** (**Settings → Memory → Obsidian**) names one connector, by its id on the MCP servers page, that every task agent and the librarian keep. It is meant for the connector that serves your notes.
- **MCP tools allowed without asking** (**Settings → Missions → Permissions**) lists tool names (`mcp__server__tool`, comma-separated) that any agent may call without a permission card. List read tools only: a tool that writes should stay behind a decision.

Every agent also gets Timon's own tools without any setup — the Kanban, missions, and the forms it uses to ask you a question or to plan work. [Tools Timon gives agents](agent-tools.md) lists them.

Permission behaviour depends on the backend's capabilities. Some support interactive tool approval; others receive a sandbox policy fixed when the mission starts. Read the editor's explanation for the selected backend instead of assuming every model can show the same permission dialog.

### Allow for this session, always allow

On a Claude Code mission, a permission card offers two wider answers next to **Allow**:

- **Allow for this session** — the same request is allowed without a card until the mission ends. A mission that stops and is reopened later asks again.
- **Always allow** — the same request is allowed without a card in every mission of this agent that you run.

"The same request" means the same tool reaching the same thing:

- a shell command: the exact same command — approving `npm test` does not approve `npm test && rm -rf build`;
- `Edit`, `Write`, `Read`: the same file — approving an edit of `src/app.ts` does not approve an edit of `~/.bashrc`;
- `WebFetch`: the same domain — approving `docs.example.com` does not approve another site;
- an MCP tool or any other tool: the exact same call, with the same arguments.

Hover the button to see what it covers. When Timon cannot tell which file, address or command a request reaches, the card offers **Allow** alone.

An approval belongs to you and to that agent: it does not open the agent's missions run by another user, nor another agent's missions. A tool in the agent's **Denied tools** is never allowed this way, and what Claude Code refuses on its own still never reaches a card. Only the owner of the mission can give a wider answer, from their browser; an agent cannot give one to itself.

The **Permissions** tab of the agent lists your always-allowed tools and commands under **Always allowed**. The bin icon revokes one: the next request asks again. Deleting the agent removes them.

Codex has no permission cards: its rights are fixed by its sandbox when the mission starts. Agents that remember approvals themselves, such as Hermes, keep doing so on their side.

### Agents read this documentation

Every agent can look up this documentation without leaving Timon: the `docs_search` and `docs_read` tools of the built-in `timon` MCP server read the pages that shipped with your installed version, offline. From a terminal, `timon docs search` and `timon docs read` do the same ([Command-line interface](cli.md#read-this-documentation)). Ask an agent how to configure or extend Timon and it can quote the page it used. The same pages are published for other AI tools as Markdown: add `.md` to any page address, or start from [llms.txt](https://docs.timon-ai.com/llms.txt).

Use [Projects](projects.md) to share role defaults across a project and [Missions](missions.md) to follow the worker's output.

## Skills

A skill is a folder holding a `SKILL.md` file: a short header, then the instructions the agent follows. Timon keeps its skills in the `skills` folder of the Timon home and lists them in the **Skills** tab of **Capabilities**, one row per skill, grouped by where it comes from (Timon, your global Claude skills, the project, plugins); on a wide screen, a column on the left jumps to a group. A `SKILL.md` follows the standard Agent Skills format, so the same file works in other tools; Timon adds nothing to it, and which agents receive a skill is stored by Timon, not in the file.

### How a skill reaches the agent

A skill you check in the agent's **Skills** tab goes into the agent's **catalogue**: its prompt carries one line, the skill's ID and its description, and the agent reads the whole skill with the `skill_get` tool when its task calls for it (a backend without Timon's tools is told to open the skill's file instead). A long skill then costs one line until it is needed. `skill_get` shows vault values as `***`, and an agent cannot save that text back over them: change such a skill from the skill editor. A skill that needs a secret should take it from the vault, not hold it.

Next to each checked skill, **Catalogue** / **Import** picks how it reaches the agent. **Import** pastes the whole skill into every prompt: keep it for procedures the agent must always follow. Skills Timon adds to a Kanban task or a workflow step for one mission (`timon-task`, `timon-worktree`…) are always pasted whole.

An agent that runs elsewhere, with neither Timon's tools nor Timon's files (a [Hermes gateway](hermes-gateway.md), for example), has no way to read a skill later, so every skill it receives is pasted whole, **Catalogue** ones included. The whole text then leaves your machine with every prompt, like the rest of that agent's instructions, and its weight counts in the prompt. The **Skills** tab says so and shows the real weight, and **Catalogue** / **Import** cannot be changed while that backend is selected. Your choice is kept: the agent goes back to the catalogue if you move it to a backend that can read it. Text files next to a skill's `SKILL.md` are pasted with it when they fit; any file that is not sent is named under the skill, whether you checked it or inherited it.

A skill folder can hold other files next to its `SKILL.md` (a `references/` folder, scripts) that the skill's text points to. An agent on your machine opens them itself; `skill_get` lists them after the skill and reads one with its `file` argument (`timon skill get <id> --file references/api.md` in a terminal). An agent with neither Timon's tools nor Timon's files receives the text files pasted after the skill, up to 64 KB per skill, whole files only; the others (images, files past that size) are named in its prompt as files it cannot open, and the **Skills** tab lists them under the skill. Files whose name starts with a dot are never sent. `skill_get` neither lists nor reads a file with `:` or `\` in its name: rename it if the skill's text points to it.

### Attach a skill to several agents

A Timon skill can reach agents at four scopes:

| Scope | Who receives it |
| --- | --- |
| Every agent | All agents in this Timon instance |
| Project | Agents attached to the chosen project |
| Agent role | Agents with the chosen role, such as coder or reviewer, across projects |
| Agent | One named agent |

On the **Skills** page, open a Timon skill, then expand **Who receives this skill** below its header. This section lists its attachments by scope. Choose a scope, a target and **Catalogue**, **Import** or **Exclude**, then **Add**. Each existing attachment lets you change the mode or remove it. Global attachments offer Catalogue and Import only: there is no wider scope to exclude.

The narrowest attachment decides, from widest to narrowest: every agent, project, agent role, agent. An **Exclude** attachment removes a skill inherited from a wider scope for that target. A more specific Catalogue or Import attachment can include it again. Removing an attachment reveals the choice from the wider scopes; removing an exclusion can therefore bring the skill back. Skills Timon adds specifically for a mission are always imported and cannot be removed by an exclusion.

In the agent editor's **Skills** tab, **Inherited** lists skills received from every agent, the project or the role. Click a skill to open **Who receives this skill** on its Timon copy. From the editor popup, opening it closes the editor, with a warning if you have unsaved changes. **Exclude for this agent** saves an agent-only exclusion immediately, preserving the other fields you are editing and refreshing the prompt estimate. Save a new agent before excluding a skill for it. To restore an excluded skill, open it from the Skills page and remove its agent exclusion.

Attachment edits and exclusions are saved immediately and apply at the **next launch** of the affected agents; they do not change instructions already sent to a running turn. Changes to the editor's checked skills and Catalogue / Import choices still require **Save**. An agent-only attachment change can interrupt that agent's running process so that its next turn starts with the new instructions. Changes for every agent, a project or a role let running processes finish.

Every change needs the `agents:manage` permission, and attaching to every agent, a project or a role needs `agents:privileged-config` as well; the controls your account cannot use are disabled, with the missing permission named. Agent-only changes need permission to manage the target agent. A refused change shows the reason and leaves the skill in place; an agent can only change the skills of an agent it orchestrates.

The same attachments can be managed from the command line or by an agent:

```bash
timon skill attach code-style --scope project --target my-app
timon skill attach release-checklist --scope role --target merger --mode import
timon skill attach code-style --scope agent --target scratch.agent --exclude
timon skill resolve my-app.coder
```

`--exclude` creates an exclusion for the chosen scope. `timon skill attachments` lists the attachments and `timon skill detach <id>` removes one; the agent tools are `skill_attach`, `skill_detach`, `skill_attachment_list` and `skill_resolve`.

### What a skill weighs

Each skill in the **Skills** tab shows what it weighs in tokens, in the mode chosen: a catalogue line is a few dozen tokens, an imported skill its whole text. A catalogue skill also shows what reading it would add (**+N if read**), paid only when the agent reads it. At the top of the tab, **Context injected at spawn** gives the whole prompt the agent would start with if you saved now: it follows the boxes, the role, the project and the system prompt, and counts skills attached to every agent, the project or the role. A checked skill that this agent excludes is named below the total and not counted. Draft fields apply on Save; **Exclude for this agent** is saved immediately and recalculates the total. The **Agent injections** widget shows the same weights for what is saved, and the cost of reading the catalogue skills apart from its total.

### Check that the agent reads it

The **Agent injections** widget shows, next to each catalogue skill, how many times the agent's missions read it over the last 30 days, out of how many missions. A read through `skill_get` counts, and so does a mission opening the skill's file by its full path. The count is a minimum: a read Timon cannot see is left out. A skill no mission was seen reading is highlighted: its description probably does not tell the agent when to reach for it, so rewrite it. If the agent's missions ran on a backend without the `skill_get` tool, the skill shows **reads not measured on this backend** instead, since their silence proves nothing. An imported skill has no counter, since its text is always there.

### Write a description that triggers

The agent decides from the description alone whether to read a catalogue skill, so the description does most of the work:

- Say what the skill does **and when to use it**, with the words a request would use: `Draft release notes from the git log. Use when asked for release notes, a changelog entry or what changed since a version.`
- Put the essential first. The catalogue keeps one line of up to 500 characters, and some tools cut long descriptions shorter.
- Write it on one line, in the `description` field of the header. Without a description, the catalogue shows the first paragraph of the instructions instead.
- Give each skill a distinct trigger: two skills with overlapping descriptions leave the agent guessing.

A procedure the agent must follow on every task, whatever the request says, belongs in **Import** rather than in the catalogue.

### Create a skill

Open **Skills** and choose **New Timon skill**, then enter an ID: lowercase
letters, digits, dots, underscores and hyphens; `.` and `..` alone are not
valid IDs, and an ID already used by a Timon skill is refused. Timon creates
the skill from a short template and opens its `SKILL.md` in the editor: write
the instructions, then **Save** (or Ctrl+S / Cmd+S). Saving with no
instructions is refused, and your text stays in the editor until it is saved.

The header holds the standard fields:

```yaml
---
name: release-notes
description: Draft release notes from the git log. Use when asked for release notes or what changed since a version.
---
```

### Pre-authorise tools

A skill can pre-authorise tools in its header, with the standard
`allowed-tools` key (Timon's older `allowed_tools` spelling works too). The
agents the skill is attached to can then use those tools without asking:

```yaml
---
name: release-notes
allowed-tools: Bash(git log:*) Read
---
```

The value can be one line (entries separated by spaces or commas), a list in
brackets (`[Bash(git log:*), Read]`, on one line or several), a list with one
`- entry` per line, or a folded value (`>`). A list in brackets that never
closes pre-authorises nothing. If a header has both spellings, the skill gets
the tools of both. An agent or a plugin can write such a skill only when the
account holds `agents:privileged-config`.

### Read or edit a skill

Select a skill card to open its `SKILL.md` in a popup, rendered as Markdown.
The eye and pencil buttons switch between the preview and the editor. Above
them, the skill shows where it comes from, where its file is stored (with a
button to copy the path) and, when you may change it, a button to delete it.
Skills provided by plugins open read-only. The popup belongs to the page's
workspace, like a file opened from the Files panel.

### Skills from Claude Code

The Skills page also lists Claude Code's own skills and commands
(`~/.claude/skills`, `~/.claude/commands`) and those of the Claude Code plugins
installed on the computer. Agents do not see them: a mission runs with its own
Claude Code configuration, not yours, so these cards are marked **Not available
in missions**. A project's skills (its `.claude/skills` folder) are different:
Claude Code reads them by itself when a Claude Code agent works in that
project, without going through Timon's catalogue. Other backends, such as
Codex, do not read that folder, and a project skill cannot be attached to an
agent.

To use one of them in missions, open it and choose **Import into Timon**. Pick
the ID of the copy (the original ID by default, with a plugin's prefix joined
by a hyphen, as in `code-review-review`), then **Import**. Timon copies the
skill's folder into its own skills, where you can edit it and attach it to an
agent like any other; the original stays where it is and later changes to it
are not copied. An ID already used by a Timon skill is refused: choose another
one. From a plugin, only that skill is copied, never the plugin's hooks or MCP
servers. Links inside the folder are not copied, and a folder of more than 200
files or 10 MB is refused. A skill that pre-approves tools (`allowed-tools`)
needs the **agents:privileged-config** permission to be imported.
