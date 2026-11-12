---
title: CLI reference
sidebar_position: 9
---

<!-- Generated file. Do not edit by hand. Run npm run gen:cli. -->

Root help is captured from `orchestrator/bin/timon --help` with a disposable `TIMON_HOME`, an unreachable API target and a 20-second process limit. No daemon or subcommand is started. Additional usage blocks are read from literal source strings because subcommand help is not universally safe to execute. Legacy French prose is translated and command syntax is retained; descriptions then go through the publication policy in `scripts/doc-policy.json`.

This is a reference snapshot, not a shell script to execute in full. Replace placeholders with real values. Installation, task creation, deletion and service commands change the target instance.

## Root help

```text
timon — Timon control plane CLI

Getting started:
  timon                                   where this installation stands, and the next command
  timon init [--email A] [--name N]       finish the setup from the terminal: background service,
             [--password-stdin] [--yes]   first account, AI tools (the password is typed hidden)

Updates (run on the daemon host):
  timon update check [--json]            ask timon-ai.com whether a newer Timon is published
  timon update status                    inspect a pending packaged update
  timon update apply                     move the service onto the installed package
  timon update approve <daemon-version>   approve backup and data migration

Agents & missions:
  timon list                              list agents (json)
  timon spawn <agent> <input...>          start a mission, returns {mission_id}
             [--extra-skills s1,s2]       inject skills for this spawn only
             [--extra-mcp mcp1,mcp2]      inject MCP servers for this spawn only
             [--allow "Bash(timon:*)"]     pre-allow tool patterns for this spawn
             [--title "Short name"]        name the mission in the missions list
  timon send <mission_id> <input...>      send a follow-up to a running mission, without stopping its turn
  timon steer <mission_id> <input...> [--json]
                                         redirect the turn running now: the agent changes course
                                         without waiting for its end
  timon wait <mission_id> [--timeout=120] block until the turn ends, print assistant text
  timon status <mission_id>               full mission detail
  timon kill <mission_id>                 terminate a running mission
  timon stop agent <name> | project <slug> [--json]
                                         technical stop of a scope: kills its running missions,
                                         empties its inbox, settles its open requests without a reply,
                                         blocks its PENDING/IN_PROGRESS tasks, switches off its triggers,
                                         cancels the workflow runs it takes part in and switches off
                                         the workflows that would start new ones
  timon trace <traceId|missionId> [--json]
  timon trace backfill [--days N]         explicitly replay cold events into spans

  timon agent create <name> [flags]       new agent (prompt via --prompt-file or stdin)
  timon agent update <name> [flags]       partial update (omit prompt to leave unchanged)
    flags: --backend NAME          --model SLUG   --permission-mode MODE
           --cwd PATH               --project SLUG
           --skills a,b,c           --mcp-servers a,b   (repeatable or comma-sep)
           --allowed-tools …        --disallowed-tools …   --excluded-mcp-servers …
           --look '{"shape":"round","color":"#d4a373","eyes":"happy","acc":"coffee"}'
                                    (mascot look; --look null clears it)
           --avatar emoji|image|mascot   (head shown; --avatar null = picture, logo, emoji, initial)
    (--skills is the whole checked set, stored as the agent's skill attachments:
     unlisted ones are detached; import mode / exclusion: timon skill attach)
    (deletion: the app or the agent_delete tool; the agent waits in the trash)
  timon agent trash list [--json]         deleted agents, newest first, with their trash id
  timon agent trash restore <id>          puts one back under its name (refused if the name is taken)
  timon agent trash purge <id>            deletes one for good (a person's gesture, refused to a mission)
  timon agent set-scope <name> <scope>   set memory scope (NONE|SESSION|AGENT|GLOBAL)
  timon agent set-avatar <name> <image>  set the profile picture (png/jpg/webp/gif, ≤ 2 MB, inside the cwd)
  timon agent set-avatar <name> --clear  remove it
  timon agent rename <old> <new>          rename an agent and its references (refused if <new>
                                         exists or a mission of <old> is running)
  timon agent doc list <agent>            list the identity docs (*.md at ~/.timon/agents/<agent>/)
  timon agent doc get <agent> <file>      print one (SOUL.md, system-prompt.md…)
  timon agent doc put <agent> <file> [--file PATH]
                                         write one; content from --file or stdin (≤ 2 MB). From a
                                         mission: its own agent, or one it orchestrates
  timon agent doc rm <agent> <file>       delete one (system-prompt.md cannot be deleted)
  timon agent export <name…> | --all [--out FILE] [--force]
                                         chosen agents (or all) to a zip another Timon imports:
                                         prompt, identity docs, rules, skills, MCP servers, routines,
                                         picture, team; secrets by NAME only
  timon agent import <FILE> [--yes] [--accept-cwd] [--prefix P] [--json]
                                         shows what would be created, asks, then imports
                                         (--accept-cwd takes the proposed working directories)
  timon agent import --hermes [PROFILE…] [--yes] [--accept-cwd] [--prefix P] [--json]
                                         the same, read from Hermes on the machine running
                                         Timon (all its profiles, or those named); no zip
  timon agent export-skill [--out FILE] [--force]
                                         prints the timon-export skill: give it to Hermes, Grok Bot
                                         or another agent, which then writes a zip to import

  timon mission summarize <id> [--force]  compress the mission transcript for cross-LLM continuation
  timon mission fork <id> --to <agent> [--message "..."]
                                         spawn a continuation on another agent, seeded with summary
  timon mission search <text…>           full-text search in mission history
             [--agent NAME] [--project SLUG] [--since 7d|ISO] [--until …] [--limit N] [--json]
  timon mission reindex [--batch N]       rebuild the mission search index
  timon mission permission-mode get <id>  permission level of a mission, its source and the levels you may pick
  timon mission permission-mode set <id> <mode>
                                         change it from the next message (plan, default, acceptEdits, auto…;
                                         never above your own level, others need agents:privileged-config)
  timon mission egress <id> [--limit N] [--before ID]
                                         outbound connections the mission made through the egress proxy (off by default)

Skills (~/.timon/skills/<id>/SKILL.md):
  timon skill list                        list installed skills
  timon skill get <id> [--file PATH]      print the SKILL.md body, or a file next to it
  timon skill put <id> [--file PATH]      upsert; content from --file or stdin
         [--create-only]                  never replace: 409 when <id> already exists
  timon skill rm <id>                     delete
  timon skill attach <id> --scope global|project|role|agent [--target T]
         [--mode include|import] [--exclude]
                                          attach a skill: include = one catalogue line (body read
                                          with skill get), import = whole body in the prompt;
                                          --exclude removes a skill inherited from a wider scope
  timon skill detach <attachment-id>      remove an attachment
  timon skill attachments [--scope S] [--target T] [--skill ID]
                                          list attachments (json)
  timon skill resolve <agent>             skills the agent spawns with, mode and origin (json)
  timon skill reads <agent> [--json]      skill_get reads by the agent's missions over 30 days
                                          (a skill never read is absent: compare with resolve)

MCP servers (~/.timon/mcp/<id>.json):
  timon mcp list                          list installed MCP servers
  timon mcp get <id>                      print the full config (json)
  timon mcp put <id> [--file PATH]        upsert; JSON from --file or stdin
                                         (shape: {name?, description?, transport})
  timon mcp rm <id>                       delete

Tasks (Kanban backlog):
  timon task list [--status PENDING|IN_PROGRESS|DONE|BLOCKED]   (TODO = deprecated alias of PENDING)
  timon task get <id>
  timon task create --title TEXT --agent NAME [--type code|review|merge|research|doc|chore] [--project SLUG] [--description D] [--priority 1-5]
                   [--base BRANCH] [--todo TODO_ID] [--plan-group NAME]
                   [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
                   [--fallback-backend NAME|none] [--fallback-model SLUG]
                   [--deps id1,id2] [--scheduled ISO8601]
                   [--extra-skills s1,s2] [--extra-mcp mcp1,mcp2]
                   [--allow "Bash(timon:*),Read(/tmp/*)"]
  timon task done <id> [--comment TEXT | --comment-file PATH | --comment-stdin] [--merged-sha SHA] [--summary TEXT]
  timon task block <id> --reason TEXT
  timon task mark-as-done [id] --comment TEXT|--comment-file PATH|--comment-stdin [--verdict pass|changes_requested] [--merged-sha SHA] [--summary TEXT]
                                               closes THE current mission's task (no id to copy)
  timon task mark-merged <id> --sha SHA [--comment TEXT]
                                               branch merged outside Timon: records its merge commit
  timon task mark-as-failed [id] --reason TEXT closes it as BLOCKED
  timon task update <id> [--status ...] [--priority N] [--title ...] [--agent ...] [--type ...]
  timon task delete <id> [--chain]           --chain: also the verification chain it heads

  timon backends [--json]                      backends and models actually available

Series fallback plan (quota exhausted during a project):
  timon series fallback list [--series ID]     rules in effect (default: THIS mission's series)
  timon series fallback set --scope orchestrator|code|review|merge|doc|chore|*
                           --backend NAME [--model SLUG] [--group NAME] [--series ID] [--no-apply]
                           --backend none    → this scope does not fall back
                           --group NAME      → for ONE group of volets of the plan (read before
                                               the series rule; never with orchestrator)
                           applied at once to the pending tasks of that scope;
                           --no-apply records the rule without moving anything
  timon series fallback clear --scope SCOPE [--group NAME] [--series ID]

Series role choices (who runs, for THIS series only — roles.json untouched):
  timon series role list [--series ID]         choices in effect for the series
  timon series role set --scope code|review|merge|research|doc|chore
                        [--backend NAME] [--model SLUG] [--group NAME] [--series ID]
                        task override > group choice > series role > project role > agent config
                        --group NAME → for ONE group of volets of the plan (tasks created
                                       with --plan-group NAME, and their chain)
  timon series role clear --scope SCOPE [--group NAME] [--series ID]

Worktrees (git isolation per code task):
  timon worktree info <task-id>                show path/branch/base/merged-sha
  timon worktree create <task-id> [--base B]   force-create (dispatcher does it automatically for type=code)
  timon worktree dispose <task-id> [--force]   unmounts worktree + local branch (post-merge)

Projects (agent roles per project):
  timon project list                           lists configured projects
  timon project roles <slug>                   shows the role→agent mapping
  timon project set-role <slug> <role> <agent> [--model SLUG] [--permission-mode MODE]
                                             sets the agent + model/permission for a role
  timon project create <slug> [--name TEXT] [--cwd PATH] [--workspace NAME] [--create-workspace]
                       [--color #RRGGBB] [--icon TEXT] [--speech TEXT] [--kind TEXT] [--status TEXT]
                                             registers a project; the cwd must already exist on the host
  timon project update <slug> [--name TEXT] [--cwd PATH] [--workspace NAME] [--create-workspace]
                       [--color #RRGGBB] [--icon TEXT] [--speech TEXT] [--kind TEXT] [--status TEXT]
                                             edits what you pass; an empty value clears workspace, speech, icon, kind
  timon workspace list [--json]                workspaces (poles) with their lead agent and projects
  timon project demo                           creates the demo project (a small sample repository)

Routines (cron → creates a Kanban task on each due tick):
  timon routine list
  timon routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT [--type ...] [--project SLUG]
  timon routine update <id> [--cron ...] [--enabled true|false] ...
  timon routine delete <id>

Workflows (graphs of nodes — agents, conditions, waits — run from a published version):
  timon workflow list                          workflows you can see (json)
  timon workflow get <slug>                    one workflow, with its draft
  timon workflow create --file FILE            creates a workflow from a JSON definition
  timon workflow publish <slug>                publishes the draft as the next version
  timon workflow run <slug> [--input JSON]     starts a run of the published version
  timon workflow runs <slug>                   the runs of a workflow
  timon workflow status <run_id>               a run with its nodes, definition and spans
  timon workflow cancel <run_id>               stops a run
  timon workflow import pipeline|agent|routine <id>
                                             turns a pipeline, an agent or a routine into a workflow
  timon workflow node done --output JSON [--route PORT]
                                             closes the current node of a run from inside its mission
                                             (reads TIMON_WORKFLOW_RUN_ID and TIMON_WORKFLOW_NODE_ID)

Triggers (source → filter → actions, run unattended):
  timon trigger list [--source schedule|webhook|event]
  timon trigger create --source schedule --name TEXT --cron EXPR [--tz ZONE] --action JSON ...
  timon trigger create --source webhook --name TEXT --slug NAME --auth github|gitlab|standard|generic
                       [--filter JSON] --action JSON ...   prints the secret ONCE
  timon trigger create --source event --name TEXT --event KIND [--filter JSON] --action JSON ...
                       shortcuts instead of --action: --todo TEXT [--project SLUG] | --notify TITLE
                       | --task-agent NAME --prompt TEXT
                       | --script BIN [--arg A ...] --cwd DIR [--env SECRET ...] [--timeout SECONDS]
                         [--allow-overlap] [--no-failure-alert]   runs a program, no agent (scripts:run);
                         from an agent's mission it becomes a proposal the user approves
  timon trigger proposals [--status pending|applied|dismissed]
                                             scripts agents asked for, waiting for you
  timon trigger approve|reject <proposal-id> creates the trigger as yours, or drops it (never from a mission)
  timon trigger test <id|slug> [--payload JSON] [--header Name:Value ...] [--execute]
                                             dry run unless --execute
  timon trigger remove <id|slug>

Pipelines (multi-agent workflow templates → Kanban tasks):
  timon pipeline list
  timon pipeline get <id>
  timon pipeline create --name TEXT --file pipeline.json [--description D]
  timon pipeline run <id> [--input JSON | --input-file PATH]
  timon pipeline run-status <run_id>
  timon pipeline delete <id>

Agent messages (async inbox — doesn't block the parent's tokens):
  timon msg send <to_agent> <payload...>     fire-and-forget to an agent's inbox
                                            [--kind msg|request|response]
                                            [--in-reply-to <msg_id>]
                                            [--to-mission <mid>]
  timon msg recv [--to <agent>] [--from <agent>] [--status pending|picked] [--limit N]
  timon msg pick <message_id>                marks picked + returns the payload (atomic)
  timon msg reply <message_id> <payload...>  sends a response to the message's from_agent

Notifications (human center — sidebar canvas):
  timon notify report  <title…> [--body TEXT] [--task-id ID]    end-of-task report, result
  timon notify alert   <title…> [--body TEXT] [--urgent] [--task-id ID]   blocking alert
  timon notify action_required <title…> [--body TEXT] [--urgent] [--dismiss-on reply,task_done] [--ttl MIN]
                       closes by itself on the human's reply in the mission (default), the task's DONE, or after --ttl (default 24 h with no trigger, 7 days with one)
    --mission-id is auto-injected from TIMON_MISSION_ID if not provided.

PROJECT TO DO (a project's idea notebook — nothing here is ever dispatched):
  timon project-todo list [--status open|done|promoted|all] [--project SLUG] [--json]
  timon project-todo add <text...> [--project SLUG] [--notes TEXT]
  timon project-todo update <id> [<text...>] [--project SLUG] [--notes TEXT] [--status open|done]
  timon project-todo done <id> [--undo]        checks / unchecks the idea
  timon project-todo promote <id> --agent NAME [--type TYPE] [--priority N] [--base REF] [--pipeline P]
                                               the idea becomes a PENDING task, and keeps the link to it
  timon project-todo rm <id>

Users (daemon-token — the operator's account recovery; administering accounts is the Multi-user
plugin's, from its page in the app):
  timon setup-token                          one-time token the first-run form asks for on an exposed install
  timon user list                            accounts (json)
  timon user reset-password <email-or-id>    temporary password, printed once

Paired devices (another Timon that drives this machine — a headless server has no screen to click):
  timon device pair [--user EMAIL-OR-ID] [--json]
                                             one-time pairing code (5 min) + this daemon's tailnet
                                             address; --user: a superadmin issues it for that account
  timon device list [--json]                 devices, their state and last connection
  timon device rename <id> <name>
  timon device revoke <id>                   cut off at once; pair again with a new code

Subscription accounts (superadmin / daemon-token — who may use which account):
  timon backend-account list [--json]        accounts, their state and who they are assigned to
  timon backend-account grant <id> --user EMAIL-OR-ID[,…]
                                             lets these users use the account (adds to the list)
  timon backend-account revoke <id> --user EMAIL-OR-ID[,…]
                                             takes it back from them
      <id> is the account id or its instance (claude@<id>); signing in stays in the app.

Backends you add yourself (a person's gesture: a mission's token is refused with operator_only):
  timon backend add <name> --base-url URL --protocol anthropic|openai-responses
                    [--key-from-stdin | --no-key] [--id ID] [--models A,B]
                    [--default-model SLUG] [--brand KEY] [--icon VALUE] [--json]
      the key is NEVER an argument: a terminal asks for it (input hidden), or pipe it:
        printf %s "$KEY" | timon backend add DeepSeek --base-url https://api.deepseek.com/anthropic \
          --protocol anthropic --key-from-stdin
      it goes to the vault, reserved to this backend, and is never shown again.
  timon backend list [--json]                the backends you added, their state, never a key
  timon backend test <id> [--json]           one call to its model listing, with its saved key;
                                             exit code 0 only if the endpoint accepts the key
  timon backend test --base-url URL --protocol anthropic|openai-responses
                    [--key-from-stdin | --no-key] [--json]
                                             the same, before saving anything
  timon backend rm <id> [--json]             removes it; a key added with it leaves the vault

Secrets vault (write-only: no command ever prints a stored value):
  timon secret list [--project SLUG] [--agent NAME] [--json]
  timon secret set <NAME> [--scope global|project:<slug>|agent:<name>]
                          [--mode inject|broker] [--note TEXT] --stdin
      the value is ALWAYS piped on stdin, never an argument:
        printf %s "$TOKEN" | timon secret set GITHUB_TOKEN --scope global --stdin
      no --scope at all = the daemon alone, which no agent ever receives.
  timon secret grant <NAME> --scope …        opens it to one more scope
      backend:<id> is a reservation, not an audience: the entry then reaches
      only that backend's own process, for the missions its other grants admit.
  timon secret revoke <NAME> --scope …       closes that scope again
  timon secret rm <NAME>
  timon secret rekey                         new master key, staged then promoted
  timon secret import-env [--delete-source]  imports ~/.timon/secrets.env, no grant

Backend sign-in (write-only: the stored token is never printed):
  timon auth claude-token set      reads the token printed by 'claude setup-token'
                                   from stdin, or asks for it (hidden) in a terminal:
        claude setup-token          # then paste the token when asked
        printf %s "$TOKEN" | timon auth claude-token set
      every claude mission receives it; needed on macOS for Timon to run with
      no session open. Then run 'timon service install' to switch the service.
  timon auth claude-token status   configured or not, never the value
  timon auth claude-token clear

Memory (rules injected into agents — DIRECT write to the database):
  timon memory rule add <text…> [--scope agent|project|role|global] [--agent NAME]
                               [--project SLUG] [--role ROLE]
                               [--kind pitfall|decision|preference] [--tier normal|core]
                               [--text-file PATH] [--json]
      defaults: --scope agent, --kind pitfall, agent = $TIMON_AGENT, project = $TIMON_PROJECT.
      An exact duplicate on the same scope is refused (exit 3).
  timon memory rule list [--scope …] [--agent NAME] [--project SLUG] [--json]
  timon memory rule rm <id>
  timon memory search <query…>                 cross-cutting search (rules + facts)
  timon memory overview                        counters + pending proposals
  timon memory show <project|agent> <id> [file]  reads the reference .md files

Project's embedded browser:
  timon browser status [<slug>] [--json]     does the project have a browser up?
  timon browser start  [<slug>]              starts it (persistent profile, sessions kept)
  timon browser stop   [<slug>]              stops it (the profile itself survives)
  timon browser list   [--json]              all known sessions
  timon browser recording get <id>           the recording your conversion mission learns (that mission only)
  timon browser annotations get [<id>] [--batch <bab-…>] [--status pending|resolved|dismissed] [--json]
                                             annotations the user sent this mission (or its agent)
  timon browser annotations resolve <id> --summary "<what you changed>"
  timon browser annotations dismiss <id> --reason "<why not>"
    default slug: $TIMON_PROJECT, otherwise derived from cwd.

Widget arrangement of the user's screen (an agent's mission owner):
  timon widgets get [--view PATH] [--project SLUG]
                                             zones, cards, catalog, chat columns
  timon widgets propose [--view PATH] [--project SLUG] [--note TEXT] [--file F]
                                             a card the user applies (JSON on stdin)
  timon widgets preset-save <name> [--view PATH] [--project SLUG] [--replace]
                                             current arrangement → Layouts menu

Island workspace of the user's screen (an agent's mission owner):
  timon islands get [--view PATH] [--project SLUG]
                                             islands, tabs, focus, content types, limits
  timon islands propose [--view PATH] [--project SLUG] [--note TEXT] [--file F]
                                             a card the user applies (JSON on stdin:
                                             {open: {...}} or {layout: {...}})
  timon islands propose --arrangement ID [--view PATH] [--project SLUG] [--note TEXT]
                                             a card recalling a named arrangement on the view
  timon setup avatar|soul|team|finish        the main agent's own setup conversation (refused elsewhere)
  timon navigate routes                      pages of the app an agent can send the user to
  timon navigate go <path> [--param k=v]... [--note TEXT]
                                             ask the user to go there (a card they follow)
  timon ui-doc render <file.html> [--title TEXT] [--reply]
  timon ui-doc get <id>
                                             shows an HTML document as a card in this mission's chat
  timon nav get                              pages hidden from the side menu, and its layout
  timon nav propose [--hide <path>]... [--order <p,p,---,p>] [--footer <p,p>] [--note TEXT]
                                             proposes the complete list of hidden pages (no flag = show all),
                                             the main list and the bottom of the menu (--- = a separator)
  timon onboarding profile [set <developer|automation|beginner>]
                                             the onboarding profile of the account
  timon islands preset-save <name> [--view PATH] [--project SLUG] [--replace]
                                             current view (islands included) → Layouts menu
  timon islands arrangements [--full]        the account's named island arrangements
  timon islands arrangement-save <name> [--view PATH] [--project SLUG] [--file LAYOUT.json] [--replace]
                                             current islands of a view, or a layout ({root, focus?}),
                                             → Island arrangements menu (never the main menu)

Timon documentation (the pages of the installed version, read offline, no daemon needed):
  timon docs search <words…> [--limit N] [--json]
                                             pages that match, with an excerpt (same as docs_search)
  timon docs read [<route>] [--heading TEXT]  a page as Markdown, or one section of it; without a
                                             route, the list of every page (same as docs_read)

Resources (anti-saturation guard for the machine):
  timon export [--out F] [--with-archive]    portable archive of ~/.timon (secrets excluded)
  timon import F [--to DIR] [--force] [--no-projects]
                                             restores an archive on this machine
  timon backup enable                        nightly routine 03:30, on by default (re-arms it if turned off)
  timon backup status [--json]               state, next run, archives under backups/
  timon doctor [--json]                      binaries, host capabilities, config
  timon doctor --report [--save F]           diagnostic report to paste in a support request
  timon logs [--desktop|--prompts|--supervisor] [-n N]
                                             newest log lines first (default: daemon, 100)

Third-party plugins (hot-loaded, no daemon restart):
  timon plugin list [--json]                 installed, version, enabled, refused
  timon plugin add <spec> [--yes]            npm install (name, .tgz, .zip or dir)
  timon plugin remove <id>                   npm uninstall (data kept)
  timon plugin enable <id> | disable <id>    toggles in timon.config.json
  timon plugin check <dir> [--json] [--strict] [--deny <word>]…
                                             pre-ship check of a plugin folder: manifest, engines.node,
                                             signature, shipped files, author and machine data; never runs it
  timon plugin sign <dir>                    signs with ~/.timon-signing/plugins.key
  timon plugin verify <id>                   verifies without loading the plugin

Web app served by the daemon (NEVER an orchestrator restart):
  timon app status [--json]                  module active? app built? child alive?
  timon app restart                          signals the web-app child (or rearms a supervisor that gave up)

Daemon service (systemd user unit on Linux, launchd agent on macOS — a launchd
                daemon once a claude token is set —, scheduled task at boot on Windows):
  timon service install [--dry-run] [--allow-temp-home] [--force]
                                             writes the unit/plist and starts it; refuses a TIMON_HOME
                                             under the system temporary folder without the flag, and a
                                             service that belongs to another Timon installation without --force
  timon service uninstall [--force]          stops and removes it, ~/.timon untouched; same refusal
  timon service stop                         ends the daemon and its programs, keeps the service registered (Windows: the task is disabled); the app starts it again at its next launch
  timon service start                        starts a stopped service again
  timon service status [--json]              installed? running?
  timon service repair                       Windows: seals the session witness again when the service waits for a logon that never comes

Bundled modules (writes timon.config.json — effective on next daemon boot):
  timon module list [--json]                 catalog, wanted state, actual state + reason
  timon module enable <name> | disable <name>  toggles in timon.config.json

Secrets broker (the daemon acts, you never hold the value):
  git config credential.helper "timon git-credential"
                                             git then authenticates through the
                                             vault: no token in a remote URL,
                                             a command line or the environment

Licence:
  timon license status                       shows your licence status, edition and expiry date
  timon license deactivate                   release this machine (the seat transfers once its last token lease expires)
  timon license install <file>               installs a licence file
  timon license activate <key>               activates Timon with your licence key

  timon health [--json]                      day/night profile, Timon cgroups memory
                                            and CPU, live missions, OOM

Remote daemon:
  timon --daemon <url|name> <cmd> …       targets a daemon (URL or profile)
  timon daemon add <name> <url> <token>   profile in ~/.timon/cli-daemons.json (0600)
  timon daemon list                       profiles (url only, never the token)

Daemon address: --daemon > TIMON_API > timon.config.json daemon.listen
                > desktop-bootstrap.json daemonPort > http://localhost:3000
                Files are read under TIMON_HOME (default ~/.timon).
Authentication: named profile token, otherwise TIMON_API_TOKEN or daemon-token.
                daemon-token is only sent to the local listener, whether the
                target comes from --daemon <url> or TIMON_API.
                For remote URLs, set TIMON_API_TOKEN or use a named profile.
```

## Additional command usage from source

These blocks supplement the root help (for example pipeline flags). Some commands have no separate usage block. The generator reads them without invoking them.

### timon spawn agent input... [--idempotency-key hash]

```text
usage: timon spawn <agent> <input...> [--idempotency-key <hash>]
       [--model SLUG] [--backend NAME] [--title "Short name"]
       [--extra-skills skill1,skill2] [--extra-mcp mcp1,mcp2]
       [--allow "Bash(timon:*),Read(/tmp/*)"]
```

### timon send mission_id input...

```text
usage: timon send <mission_id> <input...>
```

### timon steer mission_id input... [--json]

```text
usage: timon steer <mission_id> <input...> [--json]
```

### timon status mission_id

```text
usage: timon status <mission_id>
```

### timon kill mission_id

```text
usage: timon kill <mission_id>
```

### timon stop agent name | timon stop project slug [--json]

```text
usage: timon stop agent <name> | timon stop project <slug> [--json]
```

### timon wait mission_id [--timeout=120] [--json]

```text
usage: timon wait <mission_id> [--timeout=120] [--json]
```

### timon skill get id [--file PATH]

```text
usage: timon skill get <id> [--file PATH]
```

### timon skill put id [--file PATH] [--create-only]  (or pipe content on stdin)

```text
usage: timon skill put <id> [--file PATH] [--create-only]  (or pipe content on stdin)
```

### timon skill rm id

```text
usage: timon skill rm <id>
```

### timon skill attach id --scope S [--target T] [--mode M] [--exclude]

```text
usage: timon skill attach <id> --scope S [--target T] [--mode M] [--exclude]
  S: global|project|role|agent   M: include|import
```

### timon skill detach attachment-id

```text
usage: timon skill detach <attachment-id>
```

### timon skill resolve agent

```text
usage: timon skill resolve <agent>
```

### timon skill reads agent [--json]

```text
usage: timon skill reads <agent> [--json]
```

### timon skill list|get|put|rm|attach|detach|attachments|resolve|reads …

```text
usage: timon skill <list|get|put|rm|attach|detach|attachments|resolve|reads> …
```

### timon mcp get id

```text
usage: timon mcp get <id>
```

### timon mcp put id [--file PATH]  (or pipe JSON on stdin)

```text
usage: timon mcp put <id> [--file PATH]  (or pipe JSON on stdin)
```

### timon mcp rm id

```text
usage: timon mcp rm <id>
```

### timon mcp list|get|put|rm …

```text
usage: timon mcp <list|get|put|rm> …
```

### timon agent create name [--prompt-file PATH] [--backend …] [--model …] …

```text
usage: timon agent create <name> [--prompt-file PATH] [--backend …] [--model …] …
       (system prompt: pipe on stdin or pass --prompt-file)
```

### timon agent update name [--prompt-file PATH] [--backend …] [--model …] …

```text
usage: timon agent update <name> [--prompt-file PATH] [--backend …] [--model …] …
       (everything optional; supply only the fields to change)
```

### timon agent set-scope name NONE|SESSION|AGENT|GLOBAL

```text
usage: timon agent set-scope <name> <NONE|SESSION|AGENT|GLOBAL>
```

### timon agent set-avatar name image-file | timon agent set-avatar name --clear

```text
usage: timon agent set-avatar <name> <image-file> | timon agent set-avatar <name> --clear
```

### timon agent rename old-name new-name

```text
usage: timon agent rename <old-name> <new-name>
```

### timon agent …

```text
usage: timon agent <create|update|set-scope|set-avatar|rename|doc|trash|export|import|export-skill> <name> …
       (deletion: the app or the agent_delete tool, which move the agent to the trash)
```

### timon mission summarize mission_id [--force]

```text
usage: timon mission summarize <mission_id> [--force]
```

### timon mission fork mission_id --to agent [--message "..."]

```text
usage: timon mission fork <mission_id> --to <agent> [--message "..."]
```

### timon mission search text… [--agent NAME] [--project SLUG]

```text
usage: timon mission search <text…> [--agent NAME] [--project SLUG]
                            [--since 7d|ISO] [--until 7d|ISO] [--limit N] [--json]
```

### timon mission egress mission_id [--limit N] [--before ID]

```text
usage: timon mission egress <mission_id> [--limit N] [--before ID]
```

### timon mission summarize|fork|search|reindex|permission-mode|egress …

```text
usage: timon mission <summarize|fork|search|reindex|permission-mode|egress> …
```

### timon task get id

```text
usage: timon task get <id>
```

### timon task create --title TEXT --agent NAME [--description D] [--priority 1-5]

```text
usage: timon task create --title TEXT --agent NAME [--description D] [--priority 1-5]
       [--type code|review|merge|research|doc|chore] [--project SLUG] [--base BRANCH]
       [--pipeline full|code-self|code-group] [--group-id ID] [--plan-group NAME] [--todo ID]
       [--backend NAME] [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
       [--fallback-backend NAME|none] [--fallback-model SLUG]
       [--deps id1,id2] [--scheduled ISO] [--extra-skills s1,s2] [--extra-mcp m1,m2]
       [--allow "Bash(timon:*),Read(/tmp/*)"]
```

### timon task done id [--comment TEXT | --comment-file PATH | --comment-stdin] …

```text
usage: timon task done <id> [--comment TEXT | --comment-file PATH | --comment-stdin] [--merged-sha SHA] [--summary TEXT]
```

### timon task mark-merged id --sha SHA [--comment TEXT]

```text
usage: timon task mark-merged <id> --sha SHA [--comment TEXT]
```

### timon task mark-as-done [id] --comment TEXT | --comment-file PATH | --comment-stdin

```text
usage: timon task mark-as-done [id] --comment TEXT | --comment-file PATH | --comment-stdin
       [--verdict pass|changes_requested] [--merged-sha SHA] [--summary TEXT]
```

### timon task mark-as-failed [id] --reason TEXT

```text
usage: timon task mark-as-failed [id] --reason TEXT
```

### timon task block id --reason ...

```text
usage: timon task block <id> --reason ...
```

### timon task update id [--status ...] [--priority N] [--title ...] …

```text
usage: timon task update <id> [--status ...] [--priority N] [--title ...] [--scheduled ISO | --clear-scheduled]
```

### timon task delete id [--chain]

```text
usage: timon task delete <id> [--chain]
```

### timon task …

```text
usage: timon task <list|get|create|done|block|mark-as-done|mark-as-failed|mark-merged|update|delete> …
```

### timon series fallback set --scope orchestrator|code|review|merge|doc|chore|* 

```text
usage: timon series fallback set --scope orchestrator|code|review|merge|doc|chore|* 
         --backend NAME [--model SLUG] [--group NAME] [--series ID] [--no-apply]
       --backend none  → this scope does not fall back (failure accepted)
       --group NAME    → rule of ONE group of volets of the plan (never with orchestrator)
       --no-apply      → record the rule only, do not move the pending tasks
```

### timon series fallback clear --scope SCOPE [--group NAME] [--series ID]

```text
usage: timon series fallback clear --scope SCOPE [--group NAME] [--series ID]
```

### timon series fallback list|set|clear …

```text
usage: timon series fallback <list|set|clear> …
```

### timon series role set --scope code|review|merge|research|doc|chore

```text
usage: timon series role set --scope code|review|merge|research|doc|chore
         [--backend NAME] [--model SLUG] [--group NAME] [--series ID]   (at least one of backend/model)
       --group NAME → choice of ONE group of volets of the plan (tasks created with --plan-group)
```

### timon series role clear --scope SCOPE [--group NAME] [--series ID]

```text
usage: timon series role clear --scope SCOPE [--group NAME] [--series ID]
```

### timon series role list|set|clear …

```text
usage: timon series role <list|set|clear> …
```

### timon series fallback|role list|set|clear …

```text
usage: timon series <fallback|role> <list|set|clear> …
```

### timon worktree info task-id

```text
usage: timon worktree info <task-id>
```

### timon worktree create task-id [--base BRANCH]

```text
usage: timon worktree create <task-id> [--base BRANCH]
```

### timon worktree dispose task-id [--force]

```text
usage: timon worktree dispose <task-id> [--force]
```

### timon worktree info|create|dispose task-id …

```text
usage: timon worktree <info|create|dispose> <task-id> …
```

### timon project roles slug

```text
usage: timon project roles <slug>
```

### timon project set-role slug code|review|merge|research|doc|chore agent-name

```text
usage: timon project set-role <slug> <code|review|merge|research|doc|chore> <agent-name>
       [--backend NAME] [--model SLUG] [--permission-mode default|acceptEdits|bypassPermissions]
       timon project set-role <slug> <role> ""   (to clear)
```

### timon workspace list [--json]

```text
usage: timon workspace list [--json]
```

### timon project list|roles|set-role|create|update|demo …

```text
usage: timon project <list|roles|set-role|create|update|demo> …
```

### timon msg send to_agent payload...

```text
usage: timon msg send <to_agent> <payload...>
       [--kind msg|request|response] [--in-reply-to <msg_id>] [--to-mission <mid>]
```

### timon msg pick message_id

```text
usage: timon msg pick <message_id>
```

### timon msg reply message_id payload...

```text
usage: timon msg reply <message_id> <payload...>
```

### timon msg send|recv|pick|reply …

```text
usage: timon msg <send|recv|pick|reply> …
```

### timon pipeline get id

```text
usage: timon pipeline get <id>
```

### timon pipeline create --name TEXT --file PATH [--description D]

```text
usage: timon pipeline create --name TEXT --file PATH [--description D]
       (--file points to a JSON file with the pipeline definition: { steps: [...] })
```

### timon pipeline run id [--input JSON | --input-file PATH]

```text
usage: timon pipeline run <id> [--input JSON | --input-file PATH]
```

### timon pipeline run-status run_id

```text
usage: timon pipeline run-status <run_id>
```

### timon pipeline delete id

```text
usage: timon pipeline delete <id>
```

### timon pipeline list|get|create|run|run-status|delete …

```text
usage: timon pipeline <list|get|create|run|run-status|delete> …
```

### timon routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT

```text
usage: timon routine create --name TEXT --agent NAME --cron EXPR --prompt TEXT
       [--type code|review|merge|research|doc|chore] [--project SLUG] [--enabled true|false]
```

### timon routine update id [--name ...] [--cron ...] [--enabled true|false] ...

```text
usage: timon routine update <id> [--name ...] [--cron ...] [--enabled true|false] ...
```

### timon routine delete id

```text
usage: timon routine delete <id>
```

### timon routine list|create|update|delete …

```text
usage: timon routine <list|create|update|delete> …
```

### timon trigger test id|slug [--payload JSON] [--header Name:Value ...] [--execute]

```text
usage: timon trigger test <id|slug> [--payload JSON] [--header Name:Value ...] [--execute]
```

### timon trigger remove id|slug

```text
usage: timon trigger remove <id|slug>
```

### timon trigger list|create|test|remove|proposals|approve|reject …

```text
usage: timon trigger <list|create|test|remove|proposals|approve|reject> …
```

### timon project-todo add text... [--project SLUG] [--notes TEXT]

```text
usage: timon project-todo add <text...> [--project SLUG] [--notes TEXT]
```

### timon project-todo update id [text...] [--text TEXT] [--project SLUG] [--notes TEXT] …

```text
usage: timon project-todo update <id> [<text...>] [--text TEXT] [--project SLUG] [--notes TEXT] [--status open|done]
```

### timon project-todo done id [--undo]

```text
usage: timon project-todo done <id> [--undo]
```

### timon project-todo promote id --agent NAME [--type TYPE] [--priority N] [--base REF] …

```text
usage: timon project-todo promote <id> --agent NAME [--type TYPE] [--priority N] [--base REF] [--pipeline P] [--project SLUG]
```

### timon project-todo rm id

```text
usage: timon project-todo rm <id>
```

### timon project-todo list|add|update|done|promote|rm …

```text
usage: timon project-todo <list|add|update|done|promote|rm> …
```

### timon memory rule add text… [--scope agent|project|role|global] [--agent NAME] …

```text
usage: timon memory rule add <text…> [--scope agent|project|role|global] [--agent NAME] [--project SLUG] [--role ROLE] [--kind pitfall|decision|preference] [--tier normal|core]
```

### timon memory rule rm id

```text
usage: timon memory rule rm <id>
```

### timon memory rule add text… | list | rm id

```text
usage: timon memory rule <add <text…> | list | rm <id>>
```

### timon memory search query…

```text
usage: timon memory search <query…>
```

### timon memory show project|agent id [file]

```text
usage: timon memory show <project|agent> <id> [file]
```

### timon memory rule add|list|rm | search query… | overview | show project|agent id …

```text
usage: timon memory <rule <add|list|rm> | search <query…> | overview | show <project|agent> <id> [file]>
```

### timon browser recording get id

```text
usage: timon browser recording get <id>
```

### timon browser annotations get [id] [--batch id] [--status s] | resolve id --summary …

```text
usage: timon browser annotations get [<id>] [--batch <id>] [--status <s>] | resolve <id> --summary <text> | dismiss <id> --reason <text>
```

### timon browser status|start|stop|list [slug] [--json] | recording get id | …

```text
usage: timon browser status|start|stop|list [<slug>] [--json] | recording get <id> | annotations get|resolve|dismiss
```

### timon import archive.tar.gz [--to DIR] [--force] [--no-projects]

```text
usage: timon import <archive.tar.gz> [--to DIR] [--force] [--no-projects]
```

### timon docs search words... [--limit N] [--json]

```text
usage: timon docs search <words...> [--limit N] [--json]
       timon docs read [<route>] [--heading TEXT]
```

### timon widgets preset-save name [--view PATH] [--project SLUG] [--replace]

```text
usage: timon widgets preset-save <name> [--view PATH] [--project SLUG] [--replace]
```

### timon widgets get|propose|preset-save [--view PATH] [--project SLUG]

```text
usage: timon widgets <get|propose|preset-save> [--view PATH] [--project SLUG]
```

### timon islands preset-save name [--view PATH] [--project SLUG] [--replace]

```text
usage: timon islands preset-save <name> [--view PATH] [--project SLUG] [--replace]
```

### timon islands arrangement-save name [--view PATH] [--project SLUG] …

```text
usage: timon islands arrangement-save <name> [--view PATH] [--project SLUG] [--file LAYOUT.json] [--replace]
```

### timon islands get|propose|preset-save|arrangements|arrangement-save [--view PATH] …

```text
usage: timon islands <get|propose|preset-save|arrangements|arrangement-save> [--view PATH] [--project SLUG]
```

### timon navigate go path [--param k=v]... [--note TEXT]

```text
usage: timon navigate go <path> [--param k=v]... [--note TEXT]
```

### timon navigate routes|go

```text
usage: timon navigate <routes|go>
```

### timon nav get|propose

```text
usage: timon nav <get|propose>
```

### timon ui-doc render file.html [--title TEXT] [--reply] | timon ui-doc get id

```text
usage: timon ui-doc render <file.html> [--title TEXT] [--reply] | timon ui-doc get <id>
```

### timon onboarding profile [set developer|automation|beginner]

```text
usage: timon onboarding profile [set <developer|automation|beginner>]
```

### timon setup avatar|soul|team --coder NAME --reviewer NAME|finish [--no-tour]

```text
usage: timon setup <avatar|soul|team --coder NAME --reviewer NAME|finish [--no-tour]>
```

### timon backup enable|status [--json]

```text
usage: timon backup <enable|status> [--json]
```

### timon plugin add spec [--yes]

```text
usage: timon plugin add <spec> [--yes]
```

### timon plugin remove id

```text
usage: timon plugin remove <id>
```

### timon plugin sign dir

```text
usage: timon plugin sign <dir>
```

### timon plugin verify id

```text
usage: timon plugin verify <id>
```

### timon auth claude-token set|clear|status

```text
usage: timon auth claude-token set|clear|status
```

### timon secret set NAME [--scope global|project:slug|agent:name] …

```text
usage: timon secret set <NAME> [--scope global|project:<slug>|agent:<name>] [--mode inject|broker] --stdin
```

### timon secret rm NAME

```text
usage: timon secret rm <NAME>
```

### timon user reset-password email-or-id

```text
usage: timon user reset-password <email-or-id>
```

### timon backend-account list|grant|revoke …

```text
usage: timon backend-account list|grant|revoke …
```

### timon user list|reset-password …

```text
usage: timon user list|reset-password …
```

### timon secret list|set|grant|revoke|rm|rekey|import-env …

```text
usage: timon secret <list|set|grant|revoke|rm|rekey|import-env> …
```

### timon license install file

```text
usage: timon license install <file>
```

### timon license activate key

```text
usage: timon license activate <key>
```

### timon license status|install file|activate key

```text
usage: timon license status|install <file>|activate <key>
```

### timon logs [--desktop|--prompts|--supervisor] [-n N]

```text
usage: timon logs [--desktop|--prompts|--supervisor] [-n N]
```

### timon trace backfill [--days N]

```text
usage: timon trace backfill [--days N]
```

### timon trace traceId|missionId [--json]

```text
usage: timon trace <traceId|missionId> [--json]
```

### timon daemon add name url token

```text
usage: timon daemon add <name> <url> <token>
```

### timon daemon list

```text
usage: timon daemon list
       timon daemon add <name> <url> <token>
```

### timon --daemon url|name command …

```text
usage: timon --daemon <url|name> <command> …
```
