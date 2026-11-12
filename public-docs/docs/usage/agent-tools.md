---
title: Tools Timon gives agents
sidebar_position: 2.5
---

Whatever backend an agent runs on, Timon hands it its built-in MCP servers. You do not install, enable or grant them, and they are separate from the MCP servers you add yourself.

| Server | What it is for |
| --- | --- |
| `timon` | Acting on Timon: the Kanban, missions, other agents, memory, this documentation. |
| `timon_ask` | Asking **you**: forms that open in the chat and wait for your answer. |
| `timon-browser` | Driving the project's built-in browser, while it is running. |
| `grepai` | Searching the project's semantic index, when the project has one. |

They do not appear in the list of the agent editor's **MCP** tab, which only holds the servers you added: the tab shows them on a separate, read-only line. Nothing you select there, and no MCP override on a Kanban task or a mission (`extra_mcp_servers`, an empty list included), removes them. What an agent may do with some `timon` tools (creating agents or projects, declaring MCP servers) depends on the permissions of the account it acts for, set in **Settings → Users**, not on the agent's MCP servers.

## How the names appear

An agent sees each tool under its server's name, in a shape chosen by its CLI:

| Backend | The Kanban tool `kanban_add` | The form tool `question` |
| --- | --- | --- |
| Claude Code, Codex | `mcp__timon__kanban_add` | `mcp__timon_ask__question` |
| opencode | `timon_kanban_add` | `timon_ask_question` |

It is the same tool either way. When you write a prompt or a skill, the short name (`kanban_plan`, `question`) is enough: the agent finds it in its own list.

## The `timon` server

Whatever the `timon` command does in a terminal, a tool of the same name does for an agent: `timon agent update` is `agent_update`, `timon skill put` is `skill_put`, and so on. This is what lets an agent work on an install where the `timon` command is not on the PATH, such as the desktop app. Only the commands that read or change secrets, licences, the service, users and groups, and local files (`plugin add`, `app`, `import`) have no tool.

| You want the agent to… | Tools |
| --- | --- |
| Create, update, read or close Kanban tasks | `kanban_add`, `kanban_update`, `kanban_list`, `kanban_get`, `kanban_delete`, `kanban_mark_as_done`, `kanban_mark_as_failed` |
| Park an idea without starting work | `project_todo_add`, `project_todo_list`, `project_todo_update`, `project_todo_promote`, `project_todo_delete` |
| Read or attach the files of an idea | `project_todo_attachments_list`, `project_todo_attachments_add`, `project_todo_attachments_remove` |
| Hand work to another agent (`agent_list` also returns each agent's picture as `icon_url`) | `mission_spawn`, `agent_list`, `agent_send_message`, `agent_recv_messages`, `agent_pick_message`, `agent_reply` |
| Create, change, rename or delete an agent, set its memory scope, list the available backends and models | `agent_create`, `agent_update`, `agent_rename`, `agent_set_scope`, `agent_set_avatar`, `agent_set_look`, `agent_delete`, `backends_list` |
| Find a deleted agent in the trash and restore it | `agent_trash_list`, `agent_trash_restore` |
| Read or edit an agent's identity docs (`SOUL.md`…): its own, or those of an agent it orchestrates | `agent_doc_list`, `agent_doc_get`, `agent_doc_put`, `agent_doc_rm` |
| Manage the skills and MCP servers an agent can use | `skill_list`, `skill_get`, `skill_put`, `skill_rm`, `skill_attach`, `skill_detach`, `skill_attachment_list`, `skill_resolve`, `skill_reads`, `mcp_server_list`, `mcp_server_get`, `mcp_server_put`, `mcp_server_rm` |
| Create or edit a project, list the workspaces and the project's roles | `project_create`, `project_update`, `workspace_list`, `project_list`, `project_roles`, `project_set_role` |
| Create the demo project (a small sample repository to try the agents on) | `project_demo_create` |
| Read or record the onboarding profile you chose (developer, automation, beginner) | `onboarding_profile_get`, `onboarding_profile_set` |
| Follow a mission and write to it: `mission_send` never stops the running turn, `mission_steer` redirects it now ([Writing while the agent works](missions.md#writing-while-the-agent-works)) | `mission_wait`, `mission_status`, `mission_send`, `mission_steer`, `mission_kill`, `stop_scope`, `mission_summarize`, `mission_fork`, `mission_permission_mode_get`, `mission_permission_mode_set` |
| Start and stop the project's built-in browser | `browser_status`, `browser_start`, `browser_stop`, `browser_list` |
| Read the browser recording a **Learn** mission was started for ([Teach an agent by recording a browser flow](browser-recording.md)) | `browser_recording_get` |
| Read the annotations you sent from the built-in browser, and mark each one resolved or dismissed ([Point at a page and tell the agent what to change](browser-annotations.md)) | `browser_annotations_get`, `browser_annotations_resolve` |
| Run multi-agent pipeline templates | `pipeline_list`, `pipeline_get`, `pipeline_create`, `pipeline_run`, `pipeline_run_status`, `pipeline_delete` |
| Schedule a recurring task with a routine | `routine_list`, `routine_create`, `routine_update`, `routine_delete` |
| React to a schedule, a webhook or an event ([Triggers](triggers.md)) | `trigger_create`, `trigger_list`, `trigger_test`, `trigger_remove` |
| Run workflows, follow their runs, propose changes to them | `workflow_list`, `workflow_get`, `workflow_node_types`, `workflow_propose`, `workflow_run`, `workflow_status`, `workflow_node_done` |
| Create, inspect and dispose the worktree of a task | `worktree_info`, `worktree_create`, `worktree_dispose` |
| Notify you | `notify` |
| Check the machine | `doctor`, `health`, `plugin_list`, `plugin_set_enabled`, `backup_status`, `backup_enable` (the backup tools are a superadmin's and an agent is refused them, even an agent you started as superadmin: `timon backup` does the same from a terminal) |
| Look up past missions (`trace_get` returns the latest 500 spans of a trace and says when more exist) | `mission_search`, `trace_get` |
| Read back the whole message you replied to, by the event id of its `<reply-to>` header, once it has left the agent's context ([Replying to a message](missions.md#replying-to-a-message)) | `mission_message_get` |
| Read the outbound connections a mission made, and the hosts it was the first of its project to reach; the record is off by default ([What your agents connect to](network-activity.md)) | `mission_egress` |
| Repair the mission search index and the traces of older events | `mission_reindex`, `trace_backfill` |
| Set the models and fallbacks of a series | `series_role_set`, `series_role_list`, `series_role_clear`, `series_fallback_set`, `series_fallback_list`, `series_fallback_clear` |
| Remember a rule for later missions, or look memory up | `memory_rule_add`, `memory_rule_list`, `memory_rule_rm`, `memory_search`, `memory_overview`, `memory_show` |
| Read this documentation (from a terminal: `timon docs search` and `timon docs read`) | `docs_search`, `docs_read` |
| Post a message in the chat: a report, a comparison table, a step report during a long job | `chat_post_message` |
| Show you an image or a video in the chat | `chat_show_media` |
| Show you a table, a chart, a preview or a form as an HTML card in the chat, and read your answer ([HTML cards in the chat](html-cards.md)) | `ui_render`, `ui_document_get` |
| Suggest a command for your terminal | `terminal_propose` |
| Read and rearrange your widgets and chat columns | `widgets_get`, `widgets_propose`, `widgets_preset_save` |
| Split your screen into islands, and keep an arrangement under a name | `islands_get`, `islands_propose`, `islands_preset_save`, `islands_arrangements_list`, `islands_arrangement_save` |
| Take you to a page of the app, or of a plugin you can open | `ui_routes`, `ui_navigate` |
| Hide, reorder or separate the pages of the side menu | `nav_get`, `nav_propose` |
| Store a new secret (a database password, an API key it generated) in the vault | `secret_create` |
| Call an HTTP service under a secret's identity, without ever seeing the secret | `timon_http_call` |
| Ask you for a password, a code or an API key it must never see | `secret_request` |
| Set up itself during the setup conversation: write its character, recruit its two teammates, finish (and ask for a picture) | `setup_set_soul`, `setup_recruit_team`, `setup_finish`, `setup_request_avatar` |

`terminal_propose` is for a command the agent may not run itself: one that needs
`sudo` or a password, or that would stop its own mission (restarting Timon's
service, for instance). Everything else, the agent runs on its own. The command,
on a single line, shows as a card in the mission's conversation, with the agent,
its project and its note, and a notification leads you to it from anywhere in
the app. Choose:

- **Allow**: the agent runs it itself. Offered only while the agent can still
  act on your answer, and never on a backend that fixes its permissions when
  the mission starts (Codex, Grok, Copilot).
- **Paste into a terminal**: the command is typed, without Enter, in the
  terminal of the mission's project, also from a multichat cell. Read it,
  then press Enter yourself. The agent is told you run it, and gets no output
  back.
- **Refuse**: the agent is told not to run or propose it again.

The card keeps its answer, also after a reload, and a project with a command
waiting for you shows a badge on the Projects page. Pasting needs an account
allowed to open a terminal.

### Rearranging your screen

An agent can read how your widgets are arranged and propose another
arrangement, but it never changes your screen by itself.

- `widgets_get` lists, for one view (the cockpit, a chat, the Agents page), its
  zones, the cards in each zone in order, the cards you took out, the widgets
  your account can place, and on a chat its two columns: order, collapsed
  columns, tabs, the tab shown, a second column, widths and tab names.
- `widgets_propose` shows a card in the mission's conversation: **Apply this
  arrangement**, with a sketch of each zone and the cards it will hold, and the
  column changes in words. **Apply** rearranges the screen at once, without a
  reload, also when the chat shows its columns as panels; **Ignore** changes
  nothing. Either way the agent is told your answer. A notification leads you
  to the card, and the card keeps its answer after a reload.
- `widgets_preset_save` saves the current arrangement of a view as a named
  layout in the appearance menu, directly: it changes nothing on screen.

A proposal can move, add, reorder or take out cards, swap or collapse the
chat's columns, open, close, name and show their tabs, open a second column and
set widths. It only uses widgets your account is allowed to see: a widget of a
plugin you have no access to is refused, at the proposal and again when you
click Apply. An agent arranges the screen of the account that launched its
mission, and no other. A tab name shows in the tab itself.

The widget list comes from your browser: until you have opened Timon once
after updating, an agent gets an empty catalog and its proposals are refused.
The same three tools exist in the CLI as `timon widgets get`, `timon widgets
propose` and `timon widgets preset-save`.

### Splitting your screen into islands

An agent can also compose how a view is split into islands (see
[the terminal next to a page](terminal.md#next-to-a-page-split-the-screen)),
through the same card.

- `islands_get` shows, for one view, its islands and their tabs, which one is
  focused, the limits (8 islands, 3 levels of splits, 12 tabs per island, 32
  tabs in all) and the contents your account can open there, with the settings
  each one takes. A terminal session is one of them.
- `islands_propose` either opens one content next to an island (right, left,
  below, above) or as one of its tabs, or proposes the whole arrangement of the
  view. The card shows a sketch of the islands to scale, new islands
  highlighted. **Apply** splits the screen at once, without a reload; **Ignore**
  changes nothing, and the agent is told your answer. A content that is
  already open, such as a terminal session, is moved rather than opened twice,
  exactly as if you had dragged it there; a whole arrangement keeps the
  islands whose contents stay on screen, and your popups. Tabs it leaves out
  are named on the card and closed on **Apply** when the page is the one on
  screen: a terminal ends its shell, and a document with unsaved changes can
  keep its tab, which leaves everything as it was and the card waiting. On
  another page, a replaced terminal keeps running: find it on the Terminal page.
  A whole arrangement can also set the
  widget columns of the same view: the card shows both, and one **Apply**
  sets up the whole screen. The same card can set up that page for other
  projects too (`also_projects`, `""` for the chat outside any project): the
  card lists them.
- Two contents let an agent build a page without code: a **widget** (any card of
  the catalog, as an island) and a **widget zone** (an island you drop cards
  into). Ask the agent for a "page with my missions and my notifications" and it
  proposes the arrangement as usual.
- `islands_preset_save` saves the view as a named layout in the appearance
  menu, islands included, directly. The conversations, shells and browser
  sessions open in those islands are not saved: recalling the layout brings
  back the agents and a new shell, not that day's work.
- `islands_arrangements_list` lists your
  [island arrangements](terminal.md#save-an-arrangement-of-islands), with
  what each one holds and the address of its page.
- `islands_arrangement_save` keeps the islands of a view, or an arrangement the
  agent writes (checked like a proposal), under a name in **Island
  arrangements**, directly. It changes nothing on screen and never adds the
  arrangement to the main menu: you do that from **Manage**. As with a layout,
  conversations and shells are not kept. A menu already open shows the new
  arrangement the next time you open it.
- `islands_propose` can also lay one of your island arrangements on a page
  (`arrangement` and its id). The card shows its name and a sketch of it;
  **Apply** lays it exactly as the **Island arrangements** menu would. If the
  arrangement was deleted in the meantime, the card says so and changes
  nothing.

The page of the view always keeps its island. A proposal only uses contents
your account is allowed to see, is checked again when you click Apply, and is
refused if the island it targets has been closed meanwhile. Settings a
content does not accept (a browser with no agent, a file with no path) are
refused when the agent proposes, not when you click Apply. A content whose
plugin is installed but not loaded yet in your browser shows as unavailable
until it is. As for widgets, the list of contents comes from your browser:
open Timon once after updating before asking an agent to arrange it. The CLI
counterparts are `timon islands get`, `timon islands propose` and `timon
islands preset-save`.

An agent can write skills and declare MCP servers. `skill_put` and `skill_rm` work on the skills of the Timon skills folder, by id. `skill_put` with `create_only: true` (`timon skill put <id> --create-only`) creates a skill and never replaces one: if the id is taken, it is refused and the existing skill stays as it was. The mission that turns a browser recording into a skill can only create one new skill named `browser-…`: it cannot replace, rewrite or delete any skill, its own included. For every other mission: a product skill (`timon-task`, `timon-worktree`…) stays yours to change, so does a skill folder that is a link to somewhere else, and a skill that pre-authorises tools (`allowed-tools` or `allowed_tools`) needs the account to hold `agents:privileged-config`, the same permission as setting those tools on an agent. An account without `skills:manage` is refused. `mcp_server_put` and `mcp_server_rm` need the account to hold `mcp:manage`. An `http` server whose address resolves to the public internet is accepted, and checked again each time an agent starts with it and at each of its requests (the agent only ever connects to the address that was checked); servers agents declared before this rule are checked the same way until you save them again from the MCP servers page; an address that is, or resolves to, the machine itself, your local network, a Tailscale network or a link-local address, and a `stdio` server (a command run on your machine), need `agents:privileged-config`, the permission that already lets an agent pre-authorise tools. The same permission is needed to change or remove a server the agent did not declare itself. The servers Timon injects and the connectors discovered from your account are never writable from a mission, and a mission never starts an OAuth sign-in. Secrets (headers, `env` values, OAuth tokens) are returned masked as `***` to an agent; sending a masked value back keeps the stored one as long as the server still points at the same address. Each refusal names what to do, usually to declare the server on the MCP servers page of the app, and the agent attaches it with `agent_update`. Each server a mission declares or removes is recorded in the audit log with the mission and its agent.

`skill_attach` decides which agents get a skill and how: in their catalogue (one line, read with `skill_get` when needed) or imported whole, for every agent, a project, a role or one agent, and `exclude: true` removes an inherited skill for a narrower scope. From a mission it may only change an agent the mission orchestrates; every agent, a project or a role needs `agents:privileged-config`. `skill_resolve` shows what an agent starts with. `skill_get` lists files next to a skill's `SKILL.md`; pass `file` (a listed path such as `references/api.md`) to read that text file without leaving the skill folder. `skill_reads` (`timon skill reads <agent>` in a terminal) counts, over the last 30 days and on the missions you can see, how often the agent's missions read each skill with `skill_get`. See [How a skill reaches the agent](agents.md#how-a-skill-reaches-the-agent).

`agent_update` changes only the fields you pass (backend, model, permission mode, skills, MCP servers, allowed and excluded tools, memory scope, reporting line). `skills` is the agent's whole set of checked skills: a new one enters its catalogue, one already attached keeps its mode, and one left out is removed; use `skill_attach` to import a skill whole or exclude one. Without `system_prompt` the prompt stays as it is; with it, the prompt is replaced and the rest of the configuration is kept. `agent_create` accepts the same fields, but replaces an agent that already has the name: use `agent_update` to edit one. Take `backend` and `model` values from `backends_list`. Deleting an agent needs `agents:manage` and is refused for the main orchestrator.

Which backend, permission level, tools and MCP servers an agent can give to the agents, missions and Kanban tasks it creates depends on the `agents:privileged-config` permission. Administrators hold it by default, and it can be removed per role in Settings → Users. With it, an agent can pick any backend (Codex included) and any permission level, never above its own: an agent running in `default` cannot hand out `acceptEdits`, one already running in `bypassPermissions` can pass it on. Without it, an agent is limited to the safe permission modes and cannot use a backend that decides on its own at launch. The Codex sandbox names sit on the same scale as the Claude modes (`read-only` = `plan`, `workspace-write` = `auto`, `danger-full-access` = `bypassPermissions`), and a Codex agent with no mode set runs, and hands out, `workspace-write`. A value the agent already has is never refused, so updating an agent's prompt does not trip over a backend, mode or directory an administrator chose. A working directory must lie inside a registered project (or a sub-folder of one): create the project first with `project_create`, then give its directory to the agent. A refusal names the value that was refused and what to do about it, in the MCP tool, the CLI and the API.

Starting a mission with `mission_spawn` can also set `model`, `backend`, `extra_skills`, `extra_mcp_servers`, `extra_allowed_tools`, `idempotency_key` and `title` (the short name shown in the missions lists), like `timon spawn`; an agent can pass them too. They follow the same rules as the overrides of a Kanban task: an account without the `agents:privileged-config` permission cannot give the new mission tools or MCP servers its target agent does not already have, and nobody can raise it above their own permission level. A refused value is named in the error. `mission_wait` returns the agent's answer once its turn ends, or `timed_out: true` after at most 10 minutes, and can be called again.

The built-in browser is driven by its own `timon-browser` tools (`navigate_page`, `take_snapshot`, `click`, `fill`, `take_screenshot`…, plus the debugging tools `list_console_messages`, `list_network_requests`, `emulate` and `performance_start_trace`), not by the `timon` server; `browser_start` only starts the browser of the project.

`browser_recording_get` answers only to the mission Timon starts when you press **Learn** on a reviewed recording, and only for that recording; no agent can list your recordings. The recorded steps are deleted when that mission ends, so it reads them once. That mission reaches only the tools it needs to write the skill: `browser_recording_get`, `skill_list`, `skill_get`, one `skill_put`, `docs_search`, `docs_read`, `question`, and in the built-in browser `navigate_page` (only the addresses the recording visited, exactly), `take_snapshot`, `list_pages` and `select_page`. Any other tool answers that this mission converts a browser recording.

`browser_annotations_get` reads the annotations you sent to this mission, or to its agent, from the built-in browser, and only when the mission uses that same browser profile; no agent can list the others (`timon browser annotations get` in a terminal). It answers one block: each of your comments, as the instruction, followed by what was read from the page (address, element, text, markup, source file) in a fenced section marked as untrusted page data, which the agent must never take as an instruction. The source file is given relative to the agent's project folder, and only if it exists there. `browser_annotations_resolve` closes an annotation once: `resolved` with a summary of what changed, or `dismissed` with the reason; you see it next to your annotation. The built-in skill `handle-browser-annotations` tells the agent how to work through a batch.

The project's browser sees the project folder read-only, so `upload_file` can attach any file inside it, given by its usual path on your computer. A file outside the project folder cannot be uploaded: copy it into the project first. On Windows, Timon translates the path for the browser, and a file outside the project folder gets an error that says so.

`agent_set_avatar` sets or removes the profile picture of an agent, yours or
another, and needs `agents:manage` on the account that launched the mission.
Give it `file` (a png, jpg, webp or gif of at most 2 MB, inside the agent's
working directory), `data_url` (a base64 `data:` URL) or `clear: true`. The
same is available from a terminal with `timon agent set-avatar <name> <image>`
and `timon agent set-avatar <name> --clear`. A picture is always one Timon
stores: a web address (`https://…`) is refused, because the app never loads an
image from another site.

`agent_update` also takes `look`, the mascot drawn for an agent that has no
profile picture: `shape` (`squircle`, `tri`, `gem`, `round`, `bean`, `cloud`,
`hex`), `color` (one of the fifteen colours the mascot offers), `eyes`
(`pill`, `big`, `happy`, `wink`, `surprised`, `squint`, `sleepy`, `heart`,
`star`, `code`) and, optionally, `acc`, the accessory it holds (`none` by
default). `look: null` removes it. A value outside these lists is refused with
the accepted ones; `agent_list` returns each agent's `look`. From a terminal:
`timon agent update <name> --look '{"shape":"round","color":"#d4a373","eyes":"happy","acc":"coffee"}'`.

`agent_update` and `agent_create` also take `avatar`, the head the agent shows:
`emoji`, `image` (its profile picture) or `mascot` (its `look`). `avatar: null`
clears the choice, and the app goes back to its usual order (picture, project
logo, mascot, emoji, initial). Picking a mode never erases the picture, the
emoji or the look, so switching back finds them as they were. From a terminal:
`timon agent update <name> --avatar mascot` (`--avatar null` clears it).

`agent_set_look` lets an agent change its own mascot when you ask it ("put on
your chef's hat"): it takes a `look` from the same lists and, with
`use_mascot: true`, also makes the mascot the head it shows. It works on the
agent of the mission, or with `agent` on an agent it orchestrates (one that
reports to it, or any agent for the main agent and orchestrators). Any other
agent is refused, even when the account that launched the mission may manage
agents: changing another agent goes through `agent_update`. The account still
needs `agents:manage`. The tool asks no permission card, since it only changes
how an agent looks.

Projects belong to a workspace. `project_create` and `project_update` take a
`workspace` that must already exist (`workspace_list` returns the names; the
match ignores case): an unknown name is refused, so a typo cannot start a second
workspace. Pass `create_workspace: true` to create one on purpose.
`project_create` with `with_orchestrator: true` (and a `cwd`) also creates the
project's orchestrator, `<slug>.main`, unless the project already has one; the
project's agents then report to it, and it to your main agent.
`project_demo_create` always comes with its orchestrator and its coder. `project_update`
changes only the fields you pass and never moves the `cwd` of a project that
already has one. All three need `projects:manage` on the account that launched
the mission.

What a message does depends on its `kind`. A `request` wakes the agent it is
addressed to and expects an answer; a `response` that answers a request goes
back to the mission that asked. A plain `msg`, a `notification` and a `response`
that answers nothing are informational: they wait in the recipient's inbox
(`agent_recv_messages`) and never start or resume a turn. Use `request` when you
need the other agent to act.
Two agents that keep messaging each other with no input from you are stopped:
past 30 requests and answers between them within 30 minutes (both directions counted),
their next messages are held in the Inbox with the status **Held**, neither
agent wakes the other any more, and you get an alert naming the pair. Write to
either agent in its chat to let them resume; held messages are not delivered
afterwards. Task and mission returns never count. The ceiling and the window
are the settings `TIMON_WAKE_PAIR_MAX_MESSAGES` and `TIMON_WAKE_PAIR_WINDOW_MS`
(Settings → Missions → Execution).

An agent that read a message with `agent_recv_messages` can consume it with `agent_pick_message`, which marks the message as picked and returns its text once only: two agents racing for the same message cannot both get it.

See [Kanban](kanban.md) and [Missions](missions.md) for what these create.
A task created with `kanban_add` and a `todo_id` closes that notebook idea by
itself once its work is merged ([Ideas close themselves](kanban.md#ideas-close-themselves)).

### Pipelines and routines

A **pipeline** is a reusable template of steps for several agents. `pipeline_create` takes a `name`, an optional `description` and a `definition` of the form `{ steps: [...] }`; `pipeline_run` runs one (optionally with an `input` object) and produces Kanban tasks wired together by their dependencies, and `pipeline_run_status` follows a run by its `run_id`. `pipeline_list`, `pipeline_get` and `pipeline_delete` do what they say. The CLI equivalents are `timon pipeline list|get|create|run|run-status|delete`.

A **routine** is a cron expression that creates a Kanban task for an agent on each due tick. `routine_create` takes a `name`, an `agent_name`, a `cron` expression and the `prompt` that becomes the task's brief, plus an optional `task_type`, `project` slug and `enabled` flag (on by default). A routine an agent creates is saved switched off: it runs once you switch it on in **Triggers**, and an agent can never switch one on (changing the agent, prompt, schedule, type or project of an enabled routine switches it off too). A routine runs at most once a minute. `routine_update` changes only the fields you pass (`project: null` detaches the routine from its project); `routine_list` and `routine_delete` complete the set. The CLI equivalents are `timon routine list|create|update|delete`. For a routine that does more than create a task, see [Triggers](triggers.md).

### Workflows

A workflow is a graph of nodes (agents, conditions, waits…) that you build in the Workflows module. A run starts from a **published** version of the workflow. An agent can read and run workflows, and propose changes to one, but it never publishes or applies a change itself.

- `workflow_list` lists the workflows you can see, and `workflow_get` returns one by id or slug with its current draft. Read the draft right before proposing a change: it may have moved since it was described to the agent.
- `workflow_node_types` returns the live catalogue of node types and their output ports. It is the only authority on which types and ports exist; an agent should not guess them.
- `workflow_propose` validates a complete new definition against that catalogue and records it with a `rationale`. **It never applies or publishes it**: the proposal waits for you to accept or reject it in the workflow. It only works inside a mission. A proposal is the only way an agent can add or change a **script** node, which runs a program on your computer: it cannot write one into the draft, publish one or run a draft holding one, and publishing it needs the **Run scripts on the host** permission on the workflow owner's account.
- `workflow_run` starts a published workflow by `slug`, with an optional `input`. `workflow_status` takes the `run_id` and returns the run with its nodes and up to 2,000 of its spans, without their inputs and outputs: the workflow steps and the most recent others (`spans_total` and `spans_truncated` say when some were left out).
- `workflow_node_done` is for the agent a workflow node launched. It closes that node with an `output` and, optionally, the `route` (output port) to follow next, `done` by default. The run and the node come from the mission's own environment; a mission that coordinates a whole workflow passes `run_id` and `node_id` explicitly. A mission can only close the node it owns, and only while that node is active.

The CLI counterparts are `timon workflow list|get|publish|run|runs|status|cancel|import|node done` ([Command-line interface](cli.md#workflows)). Triggers can also start a workflow ([Running a workflow](triggers.md#running-a-workflow)).

### Arranging the side menu

`nav_get` returns the pages currently hidden from your side menu, how you laid it out, and the menu entries of the product (path and title). The layout is two lists of paths and separators (`"---"`): `order`, the main list from top to bottom, and `footer`, the pages at the bottom of the menu, above Settings. Both are `null` while you have never laid the menu out. A hidden page still opens by its address.

`nav_propose` takes at least one of:

- `hidden` — the **complete** list of pages to hide once applied (an empty list shows every page again);
- `order` — the main list, e.g. `["/", "/agents", "---", "/kanban"]`;
- `footer` — the pages at the bottom of the menu, e.g. `["/plugins"]`.

A list left out keeps what your menu has; a page neither list names shows at the end of the main list. A note of up to 300 characters is optional. Like `widgets_propose`, it only shows a card in the conversation: nothing changes until you apply it, and the agent is told your answer. The menu always offers to show every page again. The CLI counterparts are `timon nav get` and `timon nav propose [--hide <path>]... [--order /,/agents,---,/kanban] [--footer /plugins]`.

### Calling a service under a secret's identity

`timon_http_call` lets an agent call an HTTP service without ever holding the credential. The agent names the **identity** (the name of a secret you stored in broker mode, such as `GITHUB_TOKEN`), the `method` (GET by default), an absolute `path` starting with `/`, and optionally a `host`, extra `headers` and a `body` (an object is sent as JSON). Timon checks that the agent has been granted that secret, that the host is on the secret's list of allowed hosts, adds the credential itself and returns `{ status, body, host }`.

The secret never reaches the agent's environment, its command lines or the response. Only the hosts declared on the secret can be reached, the credential header cannot be overridden, redirects are not followed, and every call is journalled. Grant a secret to a project or an agent on the **Secrets** page; without a grant the call is refused. `git` can use the same vault through `git config credential.helper "timon git-credential"`.

### The setup conversation

Right after installation, your main agent builds itself in a conversation with you. These tools exist for that, and they work **only** in that conversation, while the step is pending: they are refused anywhere else, and they change nothing but the agent itself and the two teammates it may recruit.

- `setup_set_soul` writes the agent's character (`SOUL.md`, plain markdown, at most 20 000 characters) from the card you made for it, with an optional `objective` (one or two sentences, at most 2 000 characters) on what you expect of it. It can be called again to refine. It never touches the agent's technical instructions.
- `setup_recruit_team` creates two teammates once you said yes: a coder and a reviewer, reporting to your main agent, on its working folder and its model. It takes their two first names; a name already used by another agent is refused. Calling it again returns the same two.
- `setup_finish` ends the conversation: the agent's card appears on your cockpit and the setup moves on. With `tour: false` (you chose to get to work), the guided tour does not start.
- `setup_request_avatar` asks you for a picture: a card with a file picker opens in the conversation. The setup conversation no longer uses it (your agent already has its mascot); a picture can be set from the agent's page.

The routines and triggers the agent offers during that conversation are made with the usual `routine_create` and `trigger_create`, after your yes, and are saved switched off.

The CLI counterparts are `timon setup soul`, `timon setup team --coder NAME --reviewer NAME`, `timon setup finish [--no-tour]` and `timon setup avatar`. See [First run](../installation/first-run.md) for the conversation from your side.

## The `timon_ask` server: two forms

Both tools open a form in the chat and **block the agent until you answer**. They are not interchangeable.

| | `question` | `kanban_plan` |
| --- | --- | --- |
| Use | A one-off decision: a choice between options, a go / no-go, a confirmation. | Planning work: Kanban tasks, a large multi-part job, work in parallel, which models run it. |
| What you see | One to four questions, one tab each, each with two to four choices and a free-text field — or a single text field for an open question. | The planner: how the work runs, a model and a fallback per role, and, when the agent sorted the parts into groups, a fold-out per group with its own choices. |
| What the agent gets back | Your answer to each question, with what you typed under it. | The plan, and the exact `timon` commands that put it in place. |

### The explanation before the form

Both tools take an optional `message`: a text in markdown — headings, lists, tables — that Timon posts as an ordinary agent message in the chat, right above the form, and not inside it. It is where the agent puts what you need to choose well: its report, a comparison of the options, a table. The message stays in the conversation like any other, after a reload too, and the search finds it.

Agents are told why it exists: a long text an agent writes in its reply just before opening a form can stay in its reasoning, which the chat does not show. What goes through a tool always arrives whole. At any other moment, the tool `chat_post_message` posts the same kind of message, for example a step report during a long job. Both are limited to 20,000 characters, and an agent can only post in its own conversation.

### `question`

Only an agent you are talking to can ask you. An agent started by Timon or by another agent (a Kanban task, a routine, a sub-mission) cannot ask you a question and wait: the question is refused, and the agent is told to ask the agent that started it, or to decide on its own when there is none.

The agent asks, you click. When it asks several questions, each one has its tab: **Next** moves on, **Send reply** on the last one sends everything, and the tabs take you back to change an answer.

Under the choices of each question, a free-text field takes your own words: a remark on the choice you ticked, or your answer when none of the choices fits — tick nothing and write it there. A question needs a ticked choice or some text before you can move on. Nothing is ticked for you in advance.

When a choice is something to do, a badge in front of it says who does it: **Agent** means the agent will do it once you pick it, **You** means it is yours to do.

For an open question — the name of a new agent, a phrase — the agent sends no choices and you get one text field instead: type your answer and press Enter. Cancelling the form is not a refusal: the agent is told you did not decide, and may rephrase or go on while stating the assumption it made.

### `kanban_plan`

The agent sends only a title and the parts it proposes. You choose how the work runs:

| Mode | What happens |
| --- | --- |
| Sequential, here | The agent does the work in the current mission. No task is created. |
| Sequential, new mission | The agent hands the whole job to one fresh mission and waits for it. |
| Kanban, full pipeline | One coding task per part, each followed by review and merge. |
| Kanban, `code-self` | One coding task per part; each coder integrates its own branch. |
| Kanban, `code-group` | One coding task per part, then a single merge task for the group. |

The model and fallback menus are built from the backends available on your installation, so the agent never proposes a model you do not have. The planner covers the sequential modes too: ask for it whenever you want to decide how a job runs, not only when you want tasks.

The planner opens only in a mission you drive. A mission another agent delegated, or a mission running a Kanban task, already has its scope: the agent is told to do the work there.

#### Groups of workstreams

When the parts differ in difficulty, the agent can sort them into named groups ("simple", "complex"…, six at most) — it still names no model. The planner then shows one fold-out per group, closed by default, with the group's parts and a model and a fallback for each role that creates tasks (coder, reviewer, merger, docs). The orchestrator has no per-group setting: it drives the whole job.

- **Nothing chosen in a group** means the **General settings** below apply to it. The fold-out's header says so ("inherits the general settings"), and each menu's first option names what will actually run: the general setting you picked, or the current default when you picked none.
- **A choice in a group** applies to that group's tasks only, and to everything chained after them: the review, the merge, the doc task and any further coding round of the same part run on the group's model. A group that sets only a fallback keeps the general model, and the other way round.
- **Parts without a group** are listed under **Other workstreams** and take the general settings.
- **Quota fallback** works the same way: a group's fallback is tried before the series' one; a group that sets none follows the general fallback.

The commands the agent gets back carry it all: `timon series role set --group <name>` and `timon series fallback set --group <name>` for the group's choices, `timon task create --plan-group <name>` on the group's tasks. See [Which agent and model run a task](kanban.md#which-agent-and-model-run-a-task) for the order in which these choices are read.

### Getting the right form

Ask in the words of what you want: "plan this on the Kanban", "create the tasks for this", "run these in parallel", "which models for this job" lead to `kanban_plan`; "ask me before you…" leads to `question`.

:::note Renamed tools
These tools were called `ask_user` and `ask_series_plan`, on a server named `timon_permission`. Agents had trouble telling them apart, so they are now `question` and `kanban_plan` on `timon_ask`. If one of your own agent prompts or skills names the former ones, replace them with the new names; until you do, Timon tells every agent what they have become.
:::

## Permission cards are not a tool

The Allow / Deny card that appears when an agent wants to run something sensitive is raised by the backend, not chosen by the agent. How it behaves depends on the backend: see [Agents](agents.md#skills-and-tools).

When the request is a one-line shell command and your account may open a terminal, the card offers a third choice between **Allow** and **Deny**: **Paste into a terminal** refuses the command to the agent and types it, without Enter, in the terminal of the mission's project, for you to run.

## The guided tour

The guided tour is switched off in this version: Timon does not offer it, and the appearance menu has no **Guided tour** item. The rest of this section describes it for when it comes back.

Once the setup is done, Timon offers a quick tour: your assistant shows you
around and helps you arrange your screen, one step at a time. Say **Show me
around**, or **Not now** — it is offered once, and stays one click away in the
appearance menu (the palette icon in the top bar), under **Guided tour**. After
**Not now**, a short notice reminds you where to find it.

During the tour the assistant opens pages for you without asking each time; a
notice stays on screen with **End tour**. Anything that changes your layout
still waits for you to apply it.

The tour starts by asking who you are, and fits Timon to the answer:

- **Developer** — every page, one by one: first a project (yours, or a small
  demo project) created with its orchestrator and its coder, then the agents'
  tree (you → the project's orchestrator → its coder), the project's chat, a
  code screen of panels side by side (a terminal, the agent's browser) set up
  for the project and for your main agent's chat in one card, the Kanban,
  saved layouts.
- **Automating tasks** — a calmer menu, a screen with your agents on the left
  and the chat of the one you pick on the right, a cockpit that shows what they
  did, and a plan of the agents to set up after the tour.
- **New to AI** — the fewest pages possible, and a first request made together.

The pages it hides only leave the menu: **Customize the menu**, at its foot,
brings them back.

## Taking you to a page

`ui_navigate` asks you to go to a page of the app: the Kanban, an agent's
settings, a given mission. Nothing moves until you click **Go there** on the
card shown in the conversation; the agent is told your answer. (While you run a
guided tour with an agent, its pages open at once; you can end the tour any time.) It can only name
a page of Timon, never an outside address.

## Secrets an agent creates

`secret_create` lets an agent store a **new** secret in the vault, either generated by Timon (the agent never sees the value) or one the agent made itself. The secret is created for Timon only: no agent receives it until you open it to a project or an agent on the **Secrets** page, where you can also reveal it. An agent cannot list, read, replace or delete secrets, and a name already in use is refused. The note on the secret says which agent created it and whether Timon generated the value. Your account needs the `secrets:create` permission for your agents to use it.

## Secrets an agent asks you for

When an agent needs a secret only you have (a password, a sign-in code, an API key), it asks with `secret_request` instead of asking in the chat. A card appears in the mission's conversation with:

- the agent asking and the name of the secret (`SHOP_API_KEY`, for instance);
- why it needs it;
- how long the value lives: **once** (destroyed after its first use), **until the mission ends**, or **kept** in the vault afterwards;
- where it may go: the addresses Timon may call with it on the agent's behalf, a website the built-in browser may fill it into, or the agent's environment.

Type or paste the value in the masked field (the eye button shows it), then **Provide**, or **Refuse**. The value goes from your browser straight to the vault: it is never written in the conversation, and the agent only learns that you provided it or refused. A request you do not answer expires after 30 minutes, and when the mission ends.

How the agent then uses it matters:

- **With addresses** (the card lists them): the agent calls the service through `timon_http_call`, and Timon adds the secret to the request itself. The agent never holds the value, and Timon only sends it to the addresses shown on the card. This is the only way a value stays truly hidden.
- **For a website** (the card shows its address): the agent fills it into that site's sign-in or code form in the built-in browser, and only on that exact site. It fills the password or the one-time code, never submits the form for you. Once filled, the value is in the page like anything you type yourself.
- **Otherwise**: the value enters the agent's environment the next time its program starts, as a variable of that name. Anything the agent runs can read it, so it can also print it (an `echo` is enough); Timon masks a value it recognises in the conversation, but that is a safety net, not a guarantee. Prefer the first way for an API key.

A secret is only open to the mission that asked for it, not to other missions of the same agent. One kept after the mission stays in the vault with no agent able to use it, until you open it to a project or an agent on the **Secrets** page. A mission nobody is watching (a Kanban task, a sub-mission, a routine) cannot ask: the request is refused at once, and the agent is told to have you store the secret on the **Secrets** page instead. Your account needs the `secrets:create` permission for your agents to ask.
