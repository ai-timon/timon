---
title: Kanban
sidebar_position: 4
---

## Give work a durable brief

A Kanban task carries a title, detailed description, assignee, type and priority. Add dependencies when one result must exist before another task starts. A task that depends on a `code` task of the default pipeline waits for that task's review **and** merge, not just for the code to be written. If that code task never gets a merge (no changes to review, no reviewer, or a branch you merged by hand), the dependent task waits indefinitely: remove the dependency to release it. Schedule work only after checking the intended date and timezone.

The board uses four statuses:

| Status | Meaning |
| --- | --- |
| `PENDING` | Waiting for dispatch, scheduling or dependencies |
| `IN_PROGRESS` | Work is being executed |
| `DONE` | A result has been recorded |
| `BLOCKED` | A reason prevents completion or continuation, or the task waits for you |

A task stored with any other status (left by an older version, for example `CANCELLED`) is listed in the **Done** column; the stored value is not changed.

`PENDING` used to be called `TODO`. The old name is still accepted on input
(API, CLI, MCP) as a **deprecated** alias, and is never returned in a response.
Update your scripts: the board's idea column is named "TO DO", and only the
status was renamed.

Filter the board with **Project**, **Agent** and **Search** at the top of the page.
Search matches a task's id, title, agent and description (an idea's number and
text in the TO DO column). The filters combine: choosing a project narrows the agent list to that project's agents. A
task belongs to the project it was created for (`--project`), otherwise to its
agent's project. The TO DO column follows the project and the search; the Done column counts and
loads only the matching tasks. The
browser remembers your filters; **Reset filters** shows the whole board again.

**My turn to act** keeps only the tasks that wait for you: those marked **Waiting for you** and the running ones
stopped on a permission card.

### Waiting for you, or blocked

A blocked task is not always broken. When an agent has nothing left to do but wait for you (a merge request to
merge, a plan to validate), it closes its task with `timon task block <id> --awaiting-user --reason "…"` (the
`awaiting_user` field of the `kanban_mark_as_failed` tool does the same). The card then shows an amber **Waiting for
you** badge and the reason says what to do, instead of the red **Blocked** of a real obstacle. The task stays
blocked, so Timon never restarts it by itself; move it back to Pending, or finish it, once you have acted.

### Read a card

Each card opens with the agent that runs the task: its avatar, its name and the
role written on its sheet. A dot on the avatar and a running time mark a task in
progress. On the right, the model chip shows the logo and name of the model the
task runs on; a pending or blocked task lets you change it from there. Under the
task's id and title come the tags of the TO DO idea it carries out, then
**Scheduled** with the date and time when the task waits for one. The last line
says how many unfinished tasks it **waits on** and how many it **unblocks**
(click either to list them), how many files are attached, and its priority, from
P1 to P5 (P4 and P5 stand out). The Done column shows the latest tasks first;
**N more tasks** loads the next ones.

Creating a task can lead to execution by the dispatcher. The following creates real work for an existing agent:

```bash
timon task create --title "Improve installation instructions" --type code --agent project.coder --description "Update the README and verify each documented command." --pipeline full
timon task list --status PENDING
```

## Create or edit a task

**New task** on the board, on the Agents page or in the agents grid opens the
task form; clicking a task on the board opens the same form to change it. The
title sits at the top, the rest is split in five tabs, and a number next to a
tab tells what it already holds:

- **General**: the type, the priority (5 urgent to 1 someday), the description,
  the attached files and the TO DO idea the task carries out (its number: the
  idea closes by itself when the task's work lands). The description accepts
  Markdown: **Preview** shows it as the agent's brief will read.
- **Execution**: the agent, chosen from cards with its picture and role; the
  model, with its logo (**Project role** shows the model the task inherits);
  the backend that goes with it; the permission mode; the fallback if the quota
  runs out, or **Never switch on its own**; and for a `code` task, the pipeline
  (set at creation only).
- **Dependencies**: the tasks that must be done before this one starts, with a
  filter and their status.
- **Capabilities**: extra skills, MCP servers and tools for this task only.
  Nothing selected: the agent keeps its own.
- **Schedule**: a start date, and **Clear** to remove it.

On a wide screen a summary on the right repeats the agent, model, type,
priority, dependencies, start and status. The arrow keys move between tabs,
Escape closes the form.

To remove a task's own fallback, choose **Series or global setting** in the
fallback picker. To remove its permission override, choose **Inherited from
agent**. Save the form to restore those inherited settings. If **Never switch
on its own** was selected, uncheck it to restore inheritance.

Creating, changing, deleting a task, and promoting a TO DO idea into one, need
the right to change Kanban tasks: an account that may only read the Kanban sees
the board but cannot change it. The same right covers closing another task,
marking a task merged, creating, detaching or deleting its worktree, and
creating, changing, deleting or running a pipeline. An agent can always close
the task it is running, done or blocked, with its merge commit.

With several accounts, a pipeline belongs to the account that created it:
others do not see it. Its runs, and the tasks they open, belong to the account
that started them. The built-in `feature-flow` pipeline is shared: every
account can run it, only a superadmin can change or delete it. An agent running
a pipeline must be allowed to delegate to the agent of every step, as for a
task it creates.

## Attach files to a task

A task can carry the files its work depends on: a mockup, a screenshot, a
specification. Accepted types are images (PNG, JPEG, GIF, WebP) and current
documents (PDF, plain text, Markdown, CSV, JSON, YAML, Word, Excel, PowerPoint,
OpenDocument, RTF). Source and configuration files (XML, TOML, INI, CSS,
JavaScript, TypeScript, Python) are accepted as plain text: they are only ever
downloaded, never run nor displayed as a page. SVG, HTML, shell scripts,
archives and programs are refused. A file can
weigh up to 15 MB, and a task holds up to 20 files (100 MB in total).

- **The agent reads them.** When the task starts, its agent is told where each
  file is on this machine and opens it with its own tools, images included.
  The automatic reviews and repair iterations of the same work receive the
  original task's files too.
- **They live as long as the task.** Deleting the task deletes its files.
- **Who can use them.** Attaching or removing a file needs the right to change
  Kanban tasks; seeing them needs the right to read the Kanban. Nobody sees the
  files of a task they cannot see.
- An agent that runs on another machine (a remote provider) cannot open files on
  this one: a task with attachments assigned to it is blocked with that reason.
  Assign it to a local agent, or remove the files.

In the task form, drop files on the **Attachments** area or choose them. Images
show as thumbnails (click one to see it large), documents with their name and
size. Files added to a new task are sent once it is created; on an existing
task they are sent at once. A file of a refused type, too large, or over the
task's limit is named with the reason and never sent.

Agents see the list of a task's files with `kanban_get` (`timon task get`).

## Let an agent plan the work

### Which agent and model run a task

A task runs on the agent it is assigned to when that agent exists in the task's project and is not an orchestrator (the main agent, `<project>.main`, the agent that created the task) nor the holder of another role. Otherwise Timon sends it to the project agent that holds the role for its type (`code` to the coder, `review` to the reviewer, and so on), or creates `<project>.<role>` when nobody holds it.

An agent pinned to the role for the project (`timon project set-role <project> <type> <agent>`) comes first: it runs every task of that type, whichever agent the task names. When a task runs under another agent than the one it names, its card shows the agent that runs it, its picture and its model, with **assigned to** and the agent the task names underneath; hover it for the reason (role pinned for the project, agent of another project or holding another role, orchestrator). A task still waiting already shows the agent it will be handed to, and the task form says **Will be run by** under the agent field. Once the task has run, the card shows the agent and the model its mission really used, and its **mission** link opens that agent's chat. The other places that list tasks say the same: the **Tasks** widget, each box of the series graph and the linked tasks of a TO DO idea name the agent that runs the task and its model, with the same reason on hover. Creating such a task still works: `kanban_add` and `timon task create` answer with a warning naming the agent that will run it. The daemon log says it too, for example `task … → mission … (acme.coder) (resolved from acme.builder-ui: the coder role is pinned to acme.coder in roles.json)`.

An agent Timon creates this way runs on the backend and model of the orchestrator that created the task, so a mission on Codex gets Codex agents. Without that information it is a Claude agent. A task created by an orchestrator that is not on Claude, with no backend or model of its own, takes the orchestrator's backend and model, unless the series, the project's role, or the agent itself sets one. An account that may not choose a backend itself (no privileged-config permission) never gets one this way: its tasks run on the agent's own backend. The same account cannot name such a backend as a task's fallback or in a series' models and fallbacks either: only a backend that asks you before each tool use, or a remote one, is accepted there, and `none` (no fallback) always is.

The model a task runs on is read, in this order: the task's own backend and model (`timon task create --backend --model`), then the choice made for its **group of workstreams** in the planner (`timon series role set --group`), then the choice made for the whole series (`timon series role set`), then the project's role (`timon project set-role`), then the agent's own configuration. Each level fills only what the level above left empty: a group that sets a model but no backend keeps the series' backend. The series and group choices live with the series and never change the project's roles.

From the board, the task's own model is one picker: in the task form, under **Execution**, and on the model chip of a card. On a card, clicking the chip of a Pending or Blocked task opens the picker and saves your choice at once; the chip of a running or finished task only shows its model and settings. Pick a model to set both the backend and the model, or choose **Project role** to clear the task's own choice and let the levels above decide.

You do not have to create tasks one by one. Ask the agent you are talking to to plan a job on the Kanban: it opens the planner form in the chat, where you choose how the work runs (in the current mission, in a fresh one, or as Kanban tasks with the pipeline you want) and which model and fallback each role uses. When the agent sorts the parts into groups (simple, complex…), each group gets its own fold-out, labelled **General models** while it follows the general settings and **Own models** once it has its own. Press **Override models** to pick a different model and fallback for that group, or **Use general models** to go back; the menus show the model's logo and name. The pipeline choice is at the top of the form, and opening a group folds the others. Until you launch the plan, the form keeps what you chose and typed in this browser tab: a page reload, or the same plan asked again after its card expired, starts from there. The agent then creates the tasks from your answer. See [Tools Timon gives agents](agent-tools.md#kanban_plan).

### Reuse a set of models: presets

A preset is a named set of models, one per role (Orchestrator, New mission, Coder, Reviewer, Merger, Docs), that you save once and put back on the planner in one click. Presets belong to your account: you find them in every planner you open, on any device signed in with it.

The **Presets** bar sits at the top of the general settings, and in the panel of each group.

- **Save**: choose the models of a column, press the floppy disk icon next to its **Model** or **Fallback** heading, check the list of models it will keep and give it a name. A name already taken (upper or lower case alike) asks **Replace it?** before replacing that preset.
- **Apply**: click a preset, then choose **Primary** or **Fallback** to put its models on that column. The roles the preset does not set keep their current model, and so do the roles the form does not show for the chosen way of running the work and the orchestrator's primary model, which is the mission already running. Applied in a group, the preset gives that group its **Own models**.
- **Rename or delete**: the **…** button next to a preset.

A preset whose model is no longer offered, or whose account is no longer connected, still applies its other roles: the planner names the roles it skipped under the bar, with the reason when you hover them. You can keep up to 50 presets.

## Follow the queue by project

The **Tasks** widget lists the missions running and the tasks waiting. Inside an
agent's chat it shows only that agent's project. Elsewhere (the Agents page, the
cockpit) it shows every project; the selector at the top narrows it to one, and
the choice is remembered in your browser.

Each waiting task names the agent that will run it and the model it will run
on; clicking it opens that agent's chat, where its mission will appear.

## Keep ideas in TO DO

The TO DO column is an idea notebook: adding an idea does not schedule work.
Project TO DO and Kanban TO DO widgets show the same notebook. Changes made by
an agent, the CLI or another tab refresh these views automatically for ideas
owned by your signed-in account, including completion, promotion and deletion.
Ideas owned by other accounts do not trigger live updates in your views.

Each idea carries two tags, set when you create or edit it and shown with an
icon and a colour on the TO DO widgets and in the Kanban column:

- **Urgency**: critical, bug, minor issue or idea.
- **Progress**: to do, analyzed, partially done, to test or done.

An idea with no tag reads as *to do*. Ticking an idea and tagging it *done*
stay in step: one sets the other.

In the Kanban column an idea is a card like a task's: its author and project at
the top, its number in the corner, its tags, when it last changed and where it
lives outside Timon. The buttons at its foot tick it done, send it to the
project's orchestrator (who discusses it with you before filing a task) and
delete it; in a TO DO widget the same buttons show when you hover a line.

Open an idea to see its detail: the title, urgency, progress and project sit in
the header (urgency and progress are one chip each, click it to choose), the
description is on the left, and the links, linked tasks, outcome and dates are in
the column on the right. **Save** stays in view at the bottom. The detail and the
**Add** window open in the same frame as the task form: Escape or the cross
closes them.

### Files of an idea

An idea can carry files too: a tester's screenshot, a log, a specification. The
accepted types and limits are those of a task (15 MB per file, 20 files and
100 MB per idea).

- **In the idea's window**, the **Attachments** area works like a task's: drop
  files on it, choose them, or paste a screenshot anywhere in the window. Images
  show as thumbnails, documents with their name and size; open, download or
  remove each one. Files go at once on an existing idea and do not wait for
  **Save**; in the **New idea** window they are sent once the idea is added.
- **On the card**, a paperclip and a number tell how many files the idea holds,
  in the Kanban column and in the TO DO widgets.
- **Agents** list them with `project_todo_attachments_list`, which gives each
  file's path on this machine to open, attach one with
  `project_todo_attachments_add` (the path of a file on this machine) and remove
  one with `project_todo_attachments_remove`.
- **Promoting the idea** gives the task its own copy of the files: its agent is
  told where they are, like for any task attachment, and the task keeps them
  if the idea is deleted later.
- **They live as long as the idea.** Deleting the idea deletes its files.
- **Who can use them**: the same rights as a task's files, on the ideas you can
  see.
- The **Discord connector** attaches a tester's screenshots and logs to the
  ticket's idea.

### Give an idea an outcome

A tester's report (`TIM-0001 · …`) or suggestion (`SUG-0001 · …`) usually
deserves an answer. Outcomes come with the **TODO outcomes** plugin and are
off by default: turn on **Idea outcomes** in Settings → Plugins → TODO
outcomes. The idea's detail then shows an **Outcome** block with its own
**Save outcome** button.

Pick the idea's **outcome**: fixed, declined,
duplicate, needs info, in progress or planned. *Fixed*, *declined* and
*duplicate* also tick the idea done; the other three keep it open. Click the
active outcome again to clear it.

- **Public note**: a short message for the person who reported the item, up to
  500 characters. It is **public**: it leaves Timon with the outcome (for
  example, posted to the author by a trigger, in the chat or tracker the item
  came from). Keep anything private
  in the description, which never leaves.
- **Duplicate of**: shown for the *duplicate* outcome, the reference of the
  original item, such as `TIM-0007` or `SUG-0003`.

Each new outcome fires the `todo_resolved` event, which a trigger can forward
(see [Triggers](./triggers.md)). Saving the same outcome again, or only editing
the note, sends nothing — a notice appears in the block when you are about to
do this, so you know the author will not receive the update unless you also
change the outcome. Agents set the same fields with `project_todo_update`
(`resolution`, `public_note`, `duplicate_of`); while outcomes are off, Timon
refuses them.

Each idea shows its number (`#209`) and its author, in the TO DO widgets and in
the Kanban column. Agents use this number when
they report on an idea, and when they link a task to it (`todo_id`). To hide
either badge in a widget, edit the layout, open the widget's **Display options**
(the sliders button in its header) and untick **Idea number** or **Author**.
Each TO DO widget keeps its own choice.

To isolate bugs or ideas in a TO DO widget, press the type chips under its
title, to the right of Open / Done: each one shows the type's icon and how many
ideas of that type the current list holds (hover a chip to read its type), and
pressing several shows them together. With no chip pressed, every idea shows.
The Open and Done counts follow the selected types.

Promotion is the only notebook action that creates dispatchable work. The idea
becomes a `PENDING` task, created through the same path as `timon task create`.
It is neither deleted nor left open: it is marked promoted and keeps the id of
the task it produced. A second promotion is refused and names the existing task.

```bash
timon project-todo promote 42 --agent myproject.coder --type code
```

### Ideas close themselves

A task can carry the idea it implements: promotion links them, and an agent
links them with the `todo_id` field of `kanban_add` (or
`timon task create --todo 42`). The idea's detail dialog lists its linked
tasks. When the work lands, the idea is ticked done on its own:

| Linked task | What happens to the idea |
| --- | --- |
| `code` in the `full` pipeline | Done when its merge task is done, not before: the review can still send the code back |
| `code` in `code-self` | Done when the coder closes it with the merge SHA |
| `code` in `code-group` | Done when the group's final merge task is done |
| `chore` or `doc` | Done when the task is done |
| `research` | Tagged *analyzed*, left open |

When several tasks carry the same idea, it closes with the last one to land:
until then, each landing tags it *partial* and the work return counts the
chains landed (for example 1/7). A blocked sibling task keeps the idea open; a
`research` sibling does not. An idea already done is never reopened.

## Choose the pipeline

| Pipeline | How integration works |
| --- | --- |
| `full` | Code proceeds through automatic review and merge stages |
| `code-self` | The coding agent integrates its own branch and supplies the merge SHA |
| `code-group` | Coding tasks form a group integrated by a designated final merge task |

![Full pipeline: code, then review when the code has a diff, then merge on a pass verdict, then doc when an agent holds the librarian role. Changes requested return to another code round, three rounds at most, then the task is blocked. code-self and code-group have no automatic review.](/img/diagrams/kanban-pipeline.svg)

The stages are described step by step in [How Timon works](how-timon-works.md#the-kanban-pipeline).

A project can also land its jobs through a pull request instead of a local merge: see [Land a job through a pull request](pull-requests.md).

Git coding tasks use dedicated worktrees. This isolates tracked files, not an external database or a running service. A completed code task can still require downstream integration in a full pipeline.

A `code` or `merge` task of a Git project never runs in the project's own folder, the checkout you and every agent share. When its base branch does not exist, or its worktree cannot be created, the task is blocked with the reason: create the branch or change the task's base, then move the task back to Pending. When a task is merged, its base branch moves by reference only: your checkout, its files and its current position stay as they are, unless you stand on that base branch yourself.

Creating a worktree checks out every tracked file, which takes a while on a large repository or on a disk slowed down by an antivirus. Timon waits for as long as git reports its progress (`Updating files: 55% (4760/8608)`). When git reports nothing for 2 minutes, Timon stops it with every process it started, removes the half-made worktree, keeps its branch, and blocks the task with git's last line. Raise **Worktree creation without progress** in **Settings → Missions → Cleanup** (`TIMON_WORKTREE_ADD_STALL_MS`, in milliseconds) for a repository that slow, then move the task back to Pending. A task never starts in a worktree whose checkout is unfinished: while git still writes it, the task is blocked and says so.

A worktree starts with the tracked files only. Timon links the installed `node_modules` of the main checkout into it, and you can ask for more: list folders in a `.worktreelinks` file at the root of the repository, one path per line (`#` starts a comment), and every task worktree links them from the main checkout. Use it for a folder git ignores and the agents need, such as a notes repository cloned inside your project:

```text
# .worktreelinks
docs
```

Timon links a listed folder only when it exists in the main checkout, when the worktree has nothing at that path, and when git ignores it **as a file**: a link is a file to git, so write `/docs` in `.gitignore`, not `/docs/`, or the link would show as a new file and could be committed. A path can sit inside an untracked folder, such as `.claude/skills` for an agent's project skills: Timon creates the missing parent folders when git ignores them and they stay inside the worktree. A folder that does not pass is skipped, with a warning in the daemon log. Removing the worktree removes these links first, the `node_modules` ones included, never the folders they point to. When a link cannot be removed (on Windows, an antivirus or a process still exiting can hold it for a moment), the worktree is kept as it is and the removal fails with the link's path; the automatic cleanup tries again on its next pass. What an agent writes there lands in the main checkout at once, so two tasks writing the same file at the same time can overwrite each other: keep such writes short, and commit them right away.

The board works without Git installed, but the `code`, `review` and `merge` tasks of a project that is a Git repository need it: on a machine without Git they are refused when created, and an existing one is blocked with the reason "git not found on this host". A project folder that is not a Git repository keeps its code and review tasks. Install Git, then restart Timon. `timon doctor` lists what the missing Git switches off or reduces.

Every task agent receives the `timon-task` skill, and the `timon-worktree` skill when its task runs in a worktree: they tell it how to close its task, write a review verdict and integrate a branch. Both ship with Timon and appear on the Skills page; Timon never overwrites a copy you edited.

Inspect a task with `timon task get TASK_ID` and its Git context with `timon worktree info TASK_ID`. Record a precise completion comment; for longer text use `--comment-file`.

```bash
timon task done TASK_ID --comment-file result.md --merged-sha FULL_MERGE_SHA
```

Only close work after it is actually complete. A `code-self` task requires the full 40-character merge SHA. Use `timon task block TASK_ID --reason "…"` when a real blocker remains.

Timon checks a `merge` task before closing it as done: the branch it integrates must be in its base branch, and the merge SHA must be in the base, contain that branch and not be recorded already on another task. Otherwise the closing is refused with what to do. When the branch was already in the base before the merge task started, close it with the full SHA of the branch head.

Add `--summary "…"` (or the `summary` field of `kanban_mark_as_done`): one or two plain sentences saying what changed, for the person reading the chat. The comment stays the full report for the orchestrator.

## Task returns in the chat

When tasks finish, their returns reach the orchestrator that launched them. In its chat, each return is its own message, under the name and picture of the agent that did the work (the coder, the reviewer, the merger…), at the time it finished. Messages Timon writes itself, with no agent behind them, appear under your main agent.

Each return is a card:

- the task title, its type, and its outcome: **Done**, **Blocked**, and for a review **Approved** or **Changes requested**;
- the merge commit and the TO DO ideas the task closed or moved;
- the agent's summary, when it gave one;
- why the task is blocked, or what the review found when it asks for changes: these call for a decision, so they stay visible.

Everything written for the orchestrator (task id, full comment, review JSON) sits behind **Details**. The orchestrator still receives all the returns of a batch together, in one message, once the reviews and merges that follow its coding tasks are done too.

Returns go to the orchestrator of the task's series. A task an orchestrator creates with `kanban_add`, or with `timon task create` from its own terminal, belongs to its series. A task created otherwise (from the board, or by a raw call to the API) belongs to none: no orchestrator gets its returns, and its reviews use the project's roles instead of the series' ones. To attach such a task to a series, with the reviews, merge and documentation tasks of its chain, run `timon task attach TASK_ID --series SERIES_ID` (the series id, or the id of the orchestrator mission piloting it; `--series current` from inside that mission), or ask the orchestrator to use `kanban_attach_series`.


## When a task keeps failing

A task whose mission stops before the agent closed it (crash, timeout, process killed) is retried on its own up to three times, a few minutes apart. After that it stays **Blocked**, and its reason shows the last error the CLI reported, for example a missing sign-in or a CLI that cannot be found, and ends by saying that automatic retries are over and how to restart the task. A restart of Timon within a day of the block retries the task once more, since a restart often removes the cause; this stops after six failures in all.

An agent that ends its turn with its task still open is asked twice whether it is finished. If it still leaves the task open and then stays idle until Timon stops it, the task is not retried: it is closed as **Done** with a comment saying the agent reported nothing, and a review closed that way has no verdict, so it is blocked for you or the orchestrator to decide. This close does not count as a failure. Only Timon's own stop of an idle agent counts: if you stop the mission yourself, stop its agent or project, or reload the agent's configuration, the task follows the usual path.

An agent can no longer restart such a task as it is: it has to change its agent, backend or model in the same update (clearing a backend or model the task was pinned to counts, the project's default then applies), and its restart waits a few minutes. After six failures, only you can restart it, by setting it back to Pending from the Kanban or with `timon task update <id> --status PENDING` in a terminal. Your restart starts at once and gives the task a fresh set of retries. Fix the cause shown in the reason first: restarting a task without changing anything gives the same failure.

Interruptions caused by a usage limit, an account without credit or a backend that is unavailable are not counted: those tasks move to their fallback plan, or restart on their own once the backend reopens. The exception is a task whose mission keeps stopping while its backend is out of quota, with no sign of the limit in that mission's own output: after three such stops, the next ones count as ordinary failures.

## A branch merged outside Timon

When a task's branch was merged elsewhere (a pull request merged on GitHub, a merge you made by hand), no merge task records it, so the task can stay **Blocked** and the tasks that depend on it wait. Open the blocked `code` or `merge` task from the Kanban: **Merged outside Timon?** asks for the merge commit. **Mark as merged** closes the task as done with that commit, and the tasks that depend on it start; no review is started on it.

A `code` task can also be **Done** without its merge: its review or its merge never came, and its pull request was merged on GitHub. Its card then offers **merged?** among its actions: the commit you give is recorded on the task, which stays done, and the tasks that depend on it start.

From a terminal, `timon task mark-merged TASK_ID --sha SHA [--comment TEXT]` does the same for a blocked task or a done one.

Timon refuses a commit that your local copy of the repository has and that is not in the task's base branch. A commit it does not have yet (a pull request merged on GitHub and not fetched) is accepted and noted as not verified in the task's comment.

## A task waiting on you

When the agent of a running task asks for a permission or asks you a question, its card says **Waiting for a permission (Bash) for 3 min**, or **Waiting for an answer**, followed by the time left before the request is refused automatically (an unattended task does not wait forever). Hover the line to see whether other requests wait behind it. The task's detail shows the same line under its status. Both change as soon as a request is raised, answered or refused. The card names the tool only: the command itself, and the Allow and Deny buttons, are in the task's mission, which the card's open-mission button reaches.

`timon task get TASK_ID` and `timon status MISSION_ID` report the same wait: a `pending_permission` field in their JSON (`kind`, `tool_name`, `since`, `expires_at`, `remaining_ms`, `count`), and one readable line on stderr, so a script reading stdout is not disturbed. Agents read the same field with `kanban_get` and `mission_status`. On a running task the field is `null` when nothing waits, and also when your account can read the task but not its mission: the right to read every task does not include the right to read every mission.

## Detach a task's worktree

A pending or blocked task that has a worktree shows **Detach the worktree** in its editor. It removes the task's working folder and keeps its branch with its commits; when the task runs again, it gets a new folder on that same branch. Timon refuses it while the task is running, and Git refuses a folder that still has uncommitted changes: commit or discard them first. Once the task is done and its work merged, Timon deletes that branch, as it does for any finished task.

## When Timon removes a finished task's worktree

Timon removes a task's worktree and its local branch once the task is done and its work merged, either automatically (a few minutes after the task closes) or when you run `timon worktree dispose TASK_ID`. Before removing anything it checks the folder itself: the worktree must have no uncommitted change and no untracked file, and its current commit, not the one recorded at the merge, must already be in the merged work, the task's base or the repository's current branch. Every task sharing the folder must be done, and Timon checks again right before Git removes it. Git is never asked to force the removal, and `--force` no longer forces anything. A worktree that fails a check is kept as it is: commit or discard what it holds, and the next pass removes it. `timon worktree dispose` refuses a task that is not done: detach its worktree instead to free the folder and keep its branch.

In a project that lands its jobs through pull requests, the worktrees wait for the job's pull request to be merged. When it is merged on the forge without Timon seeing it, a finished task's folder still goes once its current commit is in the remote's target branch as your last fetch left it (for example `origin/main`), with the same checks and a merge recorded in its chain; its branch is kept. `TIMON_WORKTREE_GC_REMOTE_TARGET` turns this off. A worktree kept after its task is done also loses its build cache: a `.next` folder at its root or one level down, only when Git ignores it, once every task of the worktree is done (`TIMON_WORKTREE_GC_BUILD_CACHE`).

## When the disk is almost full

When less than 3 GB is free where Timon keeps its worktrees, no task starts and no worktree is created: the tasks wait as Pending, and you get one alert. Each task adds a worktree and writes to the database, and a full disk would stop Timon itself. Once you free some space, dispatching resumes on its own and a second notification says so. Set the floor with `TIMON_DISK_MIN_FREE_MB` (in MB, 0 turns it off), for example in `timon.config.json`:

```json
{ "settings": { "TIMON_DISK_MIN_FREE_MB": 5120 } }
```

## Delete a task

Use the task’s delete action and confirm the removal. A Pending or Blocked task
can be deleted when no other work still needs it. If deletion is refused, the
board explains what to resolve first and names the tasks in the way: stop its
running mission, delete or edit the tasks that depend on it, or ask the project
maintainer to review and dispose of its worktree. Tasks recorded as pipeline run
steps are retained for that run’s history.

Each card shows its links: **depends on N** for the tasks it waits for, and
**needed by N** for the tasks that wait for it. Click or tap a badge (or focus
it and press Enter) to list those tasks on the card; click it again to fold the
list.

A `code` task that went through the automatic review heads a **verification
chain**: its reviews and repair iterations point at it, and its card shows
**chain of N**.
Deleting it alone is refused; the board then offers to delete the whole chain at
once, with the same checks for every task in it. Agents do the same with
`kanban_delete` and `chain: true`, and the CLI with
`timon task delete <id> --chain`.

A refused deletion leaves the task intact. If your session has expired, sign in
again; if Timon is unreachable, check your connection and retry.
