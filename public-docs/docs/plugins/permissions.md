---
title: Permissions
sidebar_position: 14
---

Declare permissions in `timon.permissions`. Request only the capabilities your extension uses. Missing capabilities fail rather than returning fabricated data.

| Permission | Surface |
| --- | --- |
| `missions:spawn` | Start missions as the caller; the operator's `pluginPolicy.spawn` approval and quota apply (see the operator policy below) |
| `missions:read` | Read the caller's missions and `ctx.traces.get` as a skeleton: ids, agents, statuses, costs, senders, recipients, kinds and timestamps, but not what was said (see `missions:transcript`); events `mission_started` and `turn_complete` |
| `missions:control` | Redirect (`send`), stop (`kill`), `fork` and `stopScope` the missions the caller can see. `send` and `kill` check no account right beyond seeing the mission ([Controlling missions](missions-control.md)). Requires `apiVersion: 10` |
| `missions:transcript` | Everything that was said: `search` and `summarize`, the full `ctx.traces.get` (mission prompts and channel metadata, mission summaries, message bodies, task descriptions, reports and block reasons), span payloads, the summary returned by `fork`, and the transcript events. Requires `apiVersion: 10` |
| `todos:write`, `todos:read` | Create, edit, close, promote and delete TO DO ideas and tie them to external tickets (`ctx.kanban.todos`); list and read caller-scoped ideas, their links and their lifecycle events. Promoting an idea into a task also needs `kanban:write`. `list`, `promote` and `delete` require `apiVersion: 10`; `ctx.kanban.todos.attachments` (list, add, read and remove an idea's files) requires `apiVersion: 15` |
| `kanban:write`, `kanban:read` | Create, edit, close and link tasks; read caller-scoped tasks, their links and their lifecycle events ([Syncing the Kanban](kanban-sync.md)) |
| `kanban:delete` | Delete tasks (`ctx.kanban.delete`). Sensitive: a plugin that only syncs does not need it |
| `kanban:read:project` | Let a plugin's background jobs read the tasks of the projects you grant it in `pluginPolicy.kanban.projects`. Sensitive: reading only, and nothing is readable until you list the projects in your configuration |
| `triggers:disable` | List the triggers you may see and switch one off (`ctx.triggers`), so a plugin can retire the hand-made rules it replaces; it cannot create, edit, delete or re-enable one |
| `agents:read`, `agents:manage` | `agents:manage` is **sensitive**. List Timon agents (identity only); create agents and update, rename, delete and re-skin the ones your plugin created (`ctx.agents`), and receive their `agent_created` / `agent_updated` / `agent_deleted` events (with `events:subscribe`; API 10 for the rename, delete, picture and events). In a request the caller's account needs the same right; a job sees only your plugin's agents. `create` never overwrites, `role` is required, and agents you create are kept, not deleted, when your plugin is uninstalled |
| `agents:docs:read`, `agents:docs:write` | **Sensitive.** Read and write the identity documents of the agents your plugin created (`ctx.agents.docs`): they are the agent's instructions. Requires `apiVersion: 10` ([Agents, messages, skills and MCP servers](agents.md)) |
| `agents:export` | **Sensitive.** Read the portable definition of any agent the signed-in account may read (`ctx.agents.export`): prompt, identity documents, settings, skills, MCP servers, team, picture and routines — never a secret, log or transcript. A request only. Requires `apiVersion: 15` ([Agents, messages, skills and MCP servers](agents.md)) |
| `messages:send`, `messages:read` | Send messages as one of your agents and read the inbox of the agents you created (`ctx.messages`); both are **sensitive**: `send` writes into an agent's inbox, `read` carries other agents' conversations. Requires `apiVersion: 10` |
| `skills:read`, `skills:write` | Read Timon skills; write and remove the ones your plugin created, never a product skill (`ctx.skills`). `write` is **sensitive**. Requires `apiVersion: 10` |
| `mcp-servers:read`, `mcp-servers:write` | Read MCP server declarations (secrets masked); declare, change and remove `http` servers your plugin created (`ctx.mcpServers`). `write` is **sensitive**. Requires `apiVersion: 10` |
| `backends:read` | List the LLM backends and models available (`ctx.backends.list`). Requires `apiVersion: 10` |
| `routines:read`, `routines:write` | `routines:write` is **sensitive**. List, create, update and delete recurring routines (`ctx.routines`); a routine you create opens one task per tick, so writing also needs `kanban:write`. See [Automations](automations.md). Requires `apiVersion: 10` |
| `triggers:read`, `triggers:write`, `triggers:execute` | `write` and `execute` are **sensitive**. Read triggers, create and delete the ones your plugin owns, and test them (`ctx.triggers.get/create/remove/test`); `triggers:execute` makes `test` do what it shows. In a request the caller's account needs `triggers:manage`. Requires `apiVersion: 10` |
| `pipelines:read`, `pipelines:write`, `pipelines:run` | `write` and `run` are **sensitive**. List, define and delete multi-agent pipelines, run them and follow a run (`ctx.pipelines`); a run opens tasks, so `run` also needs `kanban:write`. Requires `apiVersion: 10` |
| `workflows:read`, `workflows:run` | `run` is **sensitive**. List and read the workflows and runs the caller can see; start a published workflow and cancel a run (`ctx.workflows`). In a request the caller's account needs `workflows:run` to start one. Requires `apiVersion: 10` |
| `notify` | Reports and alerts |
| `storage` | Plugin-scoped key/value storage and data directory |
| `accounts:provision` | **Sensitive.** Add accounts to the install and open their browser sessions (`ctx.accountProvider`), for a plugin that manages a team's accounts. Signed plugins only, one plugin at a time ([Administration](administration.md#adding-accounts)). Requires `apiVersion: 15` |
| `accounts:permissions-source` | **Sensitive.** Answer which rights each account holds (`ctx.permissionSource`), from the plugin's own directory. Signed plugins only, one plugin at a time ([Administration](administration.md#providing-the-accounts-rights)). Requires `apiVersion: 15` |
| `http:public` | **Sensitive.** Open the paths declared in the manifest's `routes.publicPaths` to callers without a session, under the plugin's own prefix ([Manifest](manifest.md#routes-reachable-without-a-session)). Requires `apiVersion: 15` |
| `storage:sql` | The plugin's own SQLite database (`ctx.sql`), created and migrated by Timon from the manifest's `migrations` folder ([Database](manifest.md#database-and-migrations)). Requires `apiVersion: 15` |
| `settings` | Declared plugin settings |
| `secrets:read` | **Sensitive.** Authorised vault secret lookup: the plugin reads the values granted to it |
| `users:read` | Explicit checks for user-protected functionality |
| `http:outbound` | Outbound `ctx.fetch` and the durable `ctx.outbox`, from the host half. A browser half reaches only the app's own origin: it calls its host half with `ctx.api` (only a `page` dictation engine adds the hosts it declares) |
| `host:exec` | **Sensitive.** Host command execution, behind the operator's allowlist |
| `events:subscribe` | Permitted daemon event subscriptions (TO DO events also need `todos:read`; memory events need `memory:read`; `mission_started` and `turn_complete` need `missions:read`; the transcript stream needs `missions:transcript`) |
| `usage:read`, `usage:collect` | Read usage; register usage probes |
| `backends:register` | **Sensitive.** Register backend profiles and provider definitions (the older dialects too) |
| `events:register`, `events:publish` | Register and publish business events |
| `workflows:triggers:register`, `workflows:executors:register` | Workflow extension callbacks |
| `transports:register` | **Sensitive.** Messaging transport registration |
| `connections:read`, `connections:write` | Integration connections |
| `connections:register`, `connections:users:read` | `connections:users:read` is **sensitive**. Declare a per-user connection type; read one account's connections and keys ([Per-user connections](connections.md)) |
| `webhooks:receive` | Receive signed calls from services outside Timon ([Receiving webhooks](webhooks.md)) |
| `mcp:issue` | **Sensitive.** Issue restricted tokens that give an agent on another machine Timon's tools for one running mission ([Timon tools for a remote agent](remote-mcp.md)) |
| `realtime:publish` | Signal your browser half that data changed, to its owner account only ([Live updates](realtime.md)) |
| `ui-documents:write`, `ui-documents:read` | Show HTML documents in a mission's conversation and take back your own (`ctx.ui.documents`); read the documents you can see, the answers to your own, and their events ([HTML documents in a conversation](ui-documents.md)). Requires `apiVersion: 9` |
| `questions:read`, `questions:answer` | List the questions agents are waiting on and hear them open and close; answer one on the user's behalf (`questions:answer` is sensitive: it unblocks the agent) ([Questions and notifications](questions-notifications.md)). Requires `apiVersion: 10` |
| `approvals:read`, `approvals:resolve` | List the tool-use approvals (Allow / Deny) an agent is waiting on and hear them open and close; allow or deny one on the user's behalf (both are sensitive: reading shows what the agent wants to run, resolving lets it run or stops it) ([Questions and notifications](questions-notifications.md#approvals)). Requires `apiVersion: 18` |
| `notifications:read`, `notifications:write` | List the notification centre and dismiss a notification (`ctx.notifications`; raising one stays `notify`) ([Questions and notifications](questions-notifications.md)). Requires `apiVersion: 10` |
| `memory:read`, `memory:write` | Read and search Timon's memory and write memory rules (`ctx.memory`, [Memory](memory.md)). **Sensitive:** `memory:write` changes what agents do, `memory:read` exposes agent memory. In a request the caller's account needs `agents:read` / `agents:manage` to read and `agents:manage` to write; a job sees only the rules and agents your plugin created. Requires `apiVersion: 10` |
| `projects:read`, `projects:manage` | List projects, poles and role pins; register and edit the projects your plugin registered, pin a role (`ctx.projects`), and hear `project_created` / `project_updated` with the writer's `origin`. `projects:manage` is sensitive ([Projects, series and worktrees](projects-series-worktrees.md)). Requires `apiVersion: 10` |
| `series:read`, `series:manage` | Read and set the fallback plan and the per-role models of a task series (`ctx.series`). `series:manage` is sensitive. Requires `apiVersion: 10` |
| `worktrees:read`, `worktrees:manage` | Read, create and dispose the git worktree of a task you can see (`ctx.worktrees`). `worktrees:manage` is sensitive. Requires `apiVersion: 10` |
| `layout:read`, `layout:propose`, `layout:presets` | Read the arrangement of the calling account's screen (`ctx.layout`), ask them to change it or to go to a page with a card they accept (`ctx.layout.*.propose`, `ctx.ui.navigate`), save a preset ([The screen and the chat](screen-and-chat.md)). Requires `apiVersion: 10` |
| `chat:media`, `chat:command` | **Sensitive.** Show a media in a mission's conversation (an https source is a fetch: it also needs `http:outbound` and an allowed host); propose a command the owner may paste into their terminal (`ctx.chat`). Requires `apiVersion: 10` |
| `onboarding:read` | Read the profile the calling account picked in the onboarding (`ctx.onboarding.profile()`). Requires `apiVersion: 10` |
| `secrets:list`, `secrets:manage`, `secrets:broker` | **Sensitive.** List the vault without values; create, replace, grant and revoke secrets; call an API under a brokered identity ([Administration and system](administration.md)). Requires `apiVersion: 10` |
| `accounts:read`, `accounts:manage` | **Sensitive.** Users, roles, groups and subscription-account sharing, for a superadmin's request only. Requires `apiVersion: 10` |
| `plugins:read`, `plugins:manage` | **Sensitive.** List plugins and modules; switch them on or off. Requires `apiVersion: 10` |
| `system:read`, `system:logs` | **Sensitive.** Health and doctor report; the daemon's logs, masked. Requires `apiVersion: 10` |
| `backup:read`, `backup:manage`, `browser:read`, `browser:manage` | **Sensitive.** Backup status and enabling; project browsers. Requires `apiVersion: 10` |
| `browser:recordings:read`, `browser:recordings:write` | **Sensitive.** Recordings of the built-in browser, in their owner's request only: list, read, review, delete, link to an outside object (`ctx.browserRecordings`), and their `browser_recording_*` events. Requires `apiVersion: 13` |
| `browser:control` | **Sensitive.** `command()` of `useBrowserChrome()`: navigate, type, click and fill saved credentials in the built-in browser your `browser.toolbar`, `browser.drawer` or `browser.surface` entry is painted in. It also gates every action of `useBrowserRecording()` and `useBrowserAnnotations()` (start, pick, comment, send…), and lets `useBrowserAnnotations()` read the annotations. Without it, these actions reject; the browser's state stays readable. Requires `apiVersion: 13` |
| `browser:annotations:read`, `browser:annotations:write` | **Sensitive.** Annotations of the built-in browser, in their owner's request only: list, read (the comment and what the page showed at that element), resolve or dismiss, delete, link to an outside object (`ctx.browserAnnotations`), and their `browser_annotation_*` events. In the app, `read` also lets `useBrowserAnnotations()` read the list and the details, without acting on them. Sending annotations to an agent stays the user's. Requires `apiVersion: 13` |
| `dictation:engine` | **Sensitive.** Register a speech-to-text engine in the `dictation.engine` slot (`kind: dictation`): Timon opens the microphone and hands your engine the audio between the start and the end of a dictation. Mandatory for `kind: dictation`. Requires `apiVersion: 14` |
| `license:read` | The edition, `lite` or `expert`, and nothing of the licence itself (`ctx.license.edition`). Not sensitive. Requires `apiVersion: 10` |
| `docs:read` | Search and read the local copy of the public documentation (`ctx.docs`). Not sensitive. Requires `apiVersion: 10` |

## Sensitive permissions

Some permissions act on other people's work, validate an action, hand out a secret or what an agent said, or reach the machine. `timon plugin add` names them apart before you accept the install, so read that line twice. Every other permission reads or uses only what the plugin, or the account it serves, already owns.

| Permission | Why it is sensitive |
| --- | --- |
| `accounts:provision` | Adds accounts to the install and opens their sessions: the plugin that holds it decides who gets in. |
| `accounts:permissions-source` | Answers which rights every account holds. |
| `http:public` | Opens routes to anyone, without a session. |
| `missions:control` | Kills, forks and sends into running missions. |
| `missions:transcript` | Reads what the agents said: prompts, summaries, message bodies, spans. |
| `kanban:delete` | Deletes tasks. |
| `kanban:read:project` | Reads the whole board of a granted project, not only the plugin's own tasks. |
| `triggers:write` | Creates and edits schedules, webhooks and event rules that start agents. |
| `triggers:execute` | Fires a trigger now. |
| `routines:write` | Creates and edits recurring missions. |
| `pipelines:write` | Edits pipelines that chain agents. |
| `pipelines:run` | Starts a pipeline: agents run with their tools. |
| `workflows:run` | Starts a workflow. |
| `memory:read` | What agents remember, which can hold private facts. |
| `memory:write` | Rewrites what every agent remembers. |
| `agents:manage` | Creates, edits and deletes agents, their tools and instructions. |
| `messages:send` | Writes into an agent's inbox as if the owner had. |
| `projects:manage` | Creates, edits and deletes projects. |
| `series:manage` | Drives a series of tasks. |
| `worktrees:manage` | Creates and removes worktrees on disk. |
| `skills:write` | What agents load. |
| `mcp-servers:write` | The tools agents load. |
| `questions:answer` | Validates dangerous tool requests on the owner's behalf. |
| `approvals:read` | Reads pending tool-use cards, including a bounded view of what the agent wants to run. |
| `approvals:resolve` | Allows or denies a tool use on the owner's behalf. |
| `chat:media` | Puts a picture or video in the owner's conversation; an https source makes the daemon fetch it. |
| `chat:command` | Proposes a command the owner may paste into their terminal. |
| `agents:docs:read` | An agent's instructions. |
| `agents:docs:write` | Rewrites an agent's instructions. |
| `agents:export` | The whole definition of any agent the account may read: instructions, documents, routines. |
| `messages:read` | Private conversations between agents. |
| `secrets:read` | Reads the secret values granted to the plugin. |
| `secrets:list` | Names and grants of the vault. |
| `secrets:manage` | Writes the vault and its grants. |
| `secrets:broker` | Calls an API or fetches a git credential under a brokered identity. |
| `mcp:issue` | Issues bearer tokens for the remote MCP. |
| `connections:users:read` | Other accounts' connections and their secrets. |
| `accounts:read` | Lists accounts. |
| `accounts:manage` | Disables accounts, shares subscription accounts. |
| `plugins:read` | Which plugins and modules are installed, and in what state. |
| `plugins:manage` | Enables and disables other plugins. |
| `host:exec` | Runs binaries on the host (still behind the operator's allowlist). |
| `transports:register` | A transport carries agents' replies out and outside messages in, which start missions. |
| `backends:register` | A backend receives the prompts routed to it, and its binary runs on the host. |
| `system:read` | The daemon's health and the machine report of `doctor`. |
| `system:logs` | Daemon logs. |
| `backup:read` | Whether and where backups run: a superadmin's request, or a job. |
| `backup:manage` | Turns backups on. |
| `browser:read` | The project browsers and their state: they hold sign-ins. |
| `browser:manage` | Starts and stops browsers. |
| `browser:recordings:read` | What the user did and typed in their browser, ready to become a skill. |
| `browser:recordings:write` | Edits and deletes those recordings, masks included. |
| `browser:control` | Drives a signed-in browsing session and can fill saved credentials. |
| `browser:annotations:read` | What you pointed at in your browser, what you said about it and what the page showed there. |
| `browser:annotations:write` | Resolves, links and deletes those annotations. |
| `dictation:engine` | Hears the user's voice and turns it into text, which may leave the window. |

A plugin holding `browser:recordings:read` sees the steps of your recordings **as your review left them**: the plain values you typed into ordinary fields, values flagged as possible secrets that you have not masked yet, and the identifier of the saved login used on a site. Passwords, one-time codes and card details stay masked placeholders: they are never recorded. It reaches only the recordings of the person using it, inside that person's request. `browser:recordings:write` also edits (mask, parameter, delete steps) and deletes them; neither permission can press **Learn**.

A plugin holding `browser:annotations:read` reads your annotations in full: your comment, and what the page showed at that element (its address with sign-in codes and tokens masked, title, text, a trimmed copy of its markup and the source file when one was found). That page content comes from the website and is untrusted. It reaches only the annotations of the person using it, inside that person's request, and gets no picture. `browser:annotations:write` also resolves, dismisses, links and deletes them; neither permission can send annotations to an agent.

In the app, a plugin with an entry in a browser panel's address bar, drawer or page layer reads your annotations only if it holds `browser:annotations:read` or `browser:control`, even once the built-in **Annotations** drawer has loaded them; acting on them needs `browser:control`. Plugin interfaces still run inside the app's page, so these checks are not a wall against a malicious plugin: install only plugins you trust for the browser.

A plugin holding `dictation:engine` receives the audio of every dictation that uses its engine. Its manifest says where that audio goes (`dictation.engines[].egress`: it stays in the window, it goes to the daemon of the active machine, or to the hosts it names), and the install screen shows it. The window enforces it for connections: a plugin's interface reaches the app's own origin and, over HTTPS, the hosts a `page` engine declares, and nothing else. It still runs inside the app's page, with your session, like every other plugin interface. Sending audio to a host also needs `http:outbound` and a host the operator allows (`pluginPolicy.http.allow`, or `pluginPolicy.http.byPlugin` for that plugin). Install only engines you trust with your voice.

Declare a sensitive permission only when the plugin cannot work without it. Every other permission is ordinary. `docs:read` reads the documentation that is public on docs.timon-ai.com, and `license:read` returns only the edition.

The integration families require API 3; `realtime:publish` requires API 4; `todos:*` and `webhooks:receive` require API 6; `connections:register`, `connections:users:read`, `agents:*` and `mcp:issue` require API 7; a webhook `auth` other than `standard`, and a webhook handler's reply body, require API 8; `ui-documents:*` require API 9; `memory:*`, `missions:control`, `missions:transcript`, `questions:*`, `notifications:*`, `ctx.kanban.todos.list`, `promote` and `delete`, `projects:*`, `series:*`, `worktrees:*`, `agents:docs:*`, `messages:*`, `skills:*`, `mcp-servers:*`, `backends:read`, the agent rename, delete, picture and events, `layout:*`, `chat:*`, `onboarding:read` and the automation permissions (`routines:*`, `triggers:read|write|execute`, `pipelines:*`, `workflows:read|run`) require API 10. `dictation:engine` and `kind: dictation` require API 14. See the generated SDK reference for exact method shapes.

:::warning Operator policy is an additional ceiling
`host:exec` and `http:outbound` are denied by default even when declared, and so is `missions:spawn` for an unsigned plugin. The operator must configure `pluginPolicy` in `timon.config.json`. A signed plugin that declares `missions:spawn` is approved by its signature and only held to the quota. An address a user registered in an approved [per-user connection](connections.md) is also reachable by `ctx.fetch`, through Timon's address checks.
:::

`ctx.host.exec` runs the program with the system variables it needs (`PATH`, the home folder, locale, proxies…), never with Timon's own environment: no secret of the vault, no token. Pass anything else as an argument or read it from your plugin's settings.

```json
{
  "pluginPolicy": {
    "spawn": {"approved": ["acme-weather"], "denied": [], "autoApproveSigned": true, "max": 5, "windowMs": 3600000},
    "exec": {"allow": ["rsync"]},
    "http": {
      "allow": ["api.example.com", "*.example.com"],
      "byPlugin": {"acme-weather": ["api.weather.example"]}
    }
  }
}
```

A signed plugin, or one built into Timon, that declares `missions:spawn` may start missions without an entry in `spawn.approved`: the publisher's signature stands for the approval. An unsigned plugin (developer mode) still needs one, and its refusal says it is unsigned. `spawn.denied` refuses a plugin whatever else says, signature included; `"autoApproveSigned": false` puts every plugin back behind `spawn.approved`. The quota (`max` per `windowMs`) applies to every plugin, signed ones included. The spawn approval names the plugin, and `timon plugin remove` withdraws it (a `spawn.denied` entry stays), as does a different package taking the id after the previous one left another way, so a package installed later under the same id starts unapproved; limits apply per time window. `http.allow` opens a host to every plugin holding `http:outbound`; `http.byPlugin` opens it to one plugin only, and is where the install sheet writes the hosts the administrator ticks ([Secrets](secrets.md#what-the-administrator-sees-at-install)). It also covers the tasks that run which your plugin creates or re-queues from a background job, a webhook handler or an event handler: they start missions, so they share the same approval and the same quota ([Syncing the Kanban](kanban-sync.md)). So do your routines, your triggers' task actions, and pipeline or workflow runs started with nobody in front ([Automations](automations.md)). An HTTP wildcard covers subdomains, not the apex. Empty allowlists refuse access.

Backend CLIs, daemon CLIs, credential helpers and generic launchers cannot be opened through this allowlist. The check is not an inspection of executable contents or all argument semantics: allowlisting a tool still requires trust. Catch policy errors and show the rule to the user instead of retrying indefinitely.

:::danger Identity belongs to a request
The host plugin loads once. Call **`ctx.user()` inside the route handler** to read the current caller; never cache a user at plugin activation.
:::

Inside a plugin route, mission, task and TO DO operations are scoped to that caller. Outside a request, `ctx.user()` is `undefined`, and reads are limited to rows owned by `plugin:<id>`. A background job does not inherit an administrator's identity.

`ctx.assertPermission(permission)` checks a declared capability when applicable and the caller's rights. User permissions are denied when there is no user. Declared UI surfaces also have server-side permission targets: a hidden plugin route can return **404**, not 403. Do not treat a client-side visibility check as authorization.

## TO DO ideas and external tickets

A connector that mirrors tickets from another system (GitHub issues, a Discord thread, Jira) creates the idea **with** its link in one call, so a ticket received twice lands on the same idea:

```js
const { item, created } = await ctx.kanban.todos.create(
  { text: issue.title, project: 'acme' },
  [{ provider: 'github', ref: `acme/app#${issue.number}`, url: issue.html_url, label: `#${issue.number}` }],
);
```

`created` is `false` when one of the links was already tied to an idea the caller can see; that idea is returned and nothing is written. `ctx.kanban.todos.links` lists, sets, removes and looks up links (`findByRef(provider, ref)`); `ctx.kanban.todos.get(id)` reads an idea with its links.

- One ticket points at one idea. Tying it to another idea fails with `code: 'conflict'`, as does creating an idea for a ticket already tied to an idea the caller cannot see.
- An idea outside the caller's view behaves as if it did not exist (`undefined`, or `code: 'not_found'`).
- `url` must be `http` or `https`; `provider` is a lowercase slug. Invalid input fails with `code: 'invalid'` and writes nothing.
- The idea's owner is the caller (the plugin itself in a background job) and each link records your plugin id. Neither can be passed as an argument.
- Links show in the idea's detail in the TO DO notebook. Deleting the idea deletes its links.

## Keeping a TO DO idea and a ticket in step

A connector is told about an idea's lifecycle on the host half, with `events:subscribe` and `todos:read`:

| Event | When |
| --- | --- |
| `todo_resolved` | the idea gets a new outcome; sent **before** `todo_done` when the outcome closes it |
| `todo_done` | the idea is closed (checkbox, tag, closing outcome, or the task built from it lands) |
| `todo_deleted` | the idea is deleted; `todo` keeps its text and links as they were |

Each event carries `todo` (with its `links`) and `origin: { kind, id }` — `user`, `agent`, `plugin` or `system`. Writes made through your plugin's facade carry `{ kind: 'plugin', id: ctx.id }`: skip them to avoid sending your own changes back. You receive the ideas your plugin created, and those of users allowed to use your plugin, inside that user's identity (`ctx.user()`). Handlers run one at a time, in event order.

A ticket's files go to its idea with `ctx.kanban.todos.attachments.add(id, { name, data })`, where `data` is a `Uint8Array` or its base64; `list`, `read` and `remove` complete it. `list` and `read` need `todos:read`, `add` and `remove` `todos:write`, on an idea the caller can see. A refused file (type, content that does not match its type, 15 MB per file, 20 files or 100 MB per idea) throws `code: 'invalid'` with the reason in `reason`. Promoting the idea copies its files into the task.

To apply what happens in the other system, `ctx.kanban.todos.update(id, patch)` edits an idea like the TO DO detail does (an outcome included, when outcomes are enabled; otherwise `code: 'forbidden'`), and `ctx.kanban.todos.close(id)` closes it.

### Listing, promoting and deleting ideas

Requires `apiVersion: 10`.

```js
const open = await ctx.kanban.todos.list({ status: 'open', project: 'acme', limit: 50 });
const { task, item } = await ctx.kanban.todos.promote(open[0].id, { agent: 'acme.coder', type: 'code', base: 'main' });
await ctx.kanban.todos.delete(item.id);
```

- `list` returns what the caller sees, open ideas first, links included. Filters: `status` (`open`, `done`, `promoted`), `project`, `urgency`, `progress`, `limit` (200 at most). Any other key fails with `code: 'invalid'`.
- `promote` turns the idea into a pending task for `agent` and marks the idea promoted. It needs **both** `todos:write` and `kanban:write`, and only works on an idea the caller owns. `type`, `priority`, `base` (a branch name) and `pipeline` (`full`, `code-self`, `code-group`) are optional; the task's project is the idea's. The task carries the idea, so it closes once the task lands. An idea already promoted fails with `code: 'conflict'`; a refused input with `code: 'invalid'`, and nothing is created.
- `delete` removes the idea and its links; `todo_deleted` follows with your plugin as `origin`. An idea outside the caller's view fails with `code: 'not_found'` and stays.

To send changes out reliably, use `ctx.outbox.post(target, body, options)` instead of `ctx.fetch`:

```js
ctx.events.on('todo_done', async (ev) => {
  if (ev.origin.kind === 'plugin' && ev.origin.id === ctx.id) return;
  const link = ev.todo.links.find((l) => l.provider === 'github');
  if (!link) return;
  const [repo, number] = link.ref.split('#');
  await ctx.outbox.post(`https://api.github.com/repos/${repo}/issues/${number}`, { state: 'closed' },
    { key: `todo:${ev.todoId}`, method: 'PATCH', auth: { secret: 'GITHUB_TOKEN' } });
});
```

- Calls are stored and retried with back-off (up to 10 attempts over several hours). A `4xx` response other than 408, 425 or 429 is final.
- Calls sharing a `key` leave in order: an outcome, then the closure.
- `sign: { secret }` signs the call the Standard Webhooks way; `webhook-id` stays the same across retries.
- Credentials are named, never passed: `auth`, `sign` and a target `{ secret: 'name' }` refer to vault entries granted to your plugin (`secrets:read`), read again at each attempt. `Authorization` and `Cookie` cannot be set through `headers`.
- The target host must be allowed for your plugin: in `pluginPolicy.http.allow`, or in `pluginPolicy.http.byPlugin` under your ID. `ctx.outbox.get(id)` reports `pending`, `delivered` or `failed`.
