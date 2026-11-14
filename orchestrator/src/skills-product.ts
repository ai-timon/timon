/**
 * The three skills the product itself names: the dispatcher injects
 * `timon-task` into every Kanban task and `timon-worktree` into every task that
 * runs in a worktree, the runtime preamble points at `timon-delegate`.
 *
 * They used to exist only in the home of the machine Timon was built on: a
 * fresh install spawned its tasks without the closing protocol and without the
 * `allowed_tools` these skills grant, with nothing but a `[skills] … not found`
 * warning in the daemon log. Shipped here, seeded like every bundled skill, and
 * never overwritten once present (no `version`): an operator who edited one
 * keeps their copy.
 */
export const PRODUCT_SKILLS: ReadonlyArray<{ id: string; content: string; version?: number }> = [
  {
    id: 'timon-task',
    content: `---
allowed_tools: ["Bash(timon:*)"]
---

# skill: timon-task

You work from a Kanban backlog in Timon. When the dispatcher spawns you for a
task, the first line of your input is:

\`\`\`
TASK_ID: <uuid>
\`\`\`

That \`TASK_ID\` is your current task. You **must** close it at the end of your
work: nothing else tells the dispatcher you are finished.

## Commands

The same actions exist as MCP tools (\`kanban_get\`, \`kanban_list\`,
\`kanban_add\`, \`kanban_update\`, \`kanban_mark_as_done\`,
\`kanban_mark_as_failed\`). Use whichever your tool list offers.

### Read your task
\`\`\`bash
timon task get <TASK_ID>
\`\`\`
Prints the task as JSON: title, description, deps, priority, agent.

### List tasks
\`\`\`bash
timon task list                          # all
timon task list --status PENDING         # backlog
timon task list --status IN_PROGRESS
timon task list --status DONE
timon task list --status BLOCKED
\`\`\`

### Create a sub-task
When the work splits into distinct steps that other agents can run in
parallel or in sequence:
\`\`\`bash
timon task create \\
  --title "Short, actionable description" \\
  --type code|review|merge|research|doc|chore \\
  --agent <agent-name> \\
  --description "Detailed context" \\
  --priority 3 \\
  --deps id1,id2                          # optional: tasks this one waits for
  --scheduled "2026-05-20T02:00:00"       # optional: run later
  --pipeline full|code-self|code-group    # optional: see "Pipeline of a task"
  --group-id "$GROUP_ID"                  # optional: batch of tasks, see below
  --todo <id>                             # optional: the TO DO idea this task carries out
\`\`\`
The dispatcher picks sub-tasks up by itself.

**A task that carries out an idea of the project's TO DO notebook names it**
(\`--todo <id>\`, or \`todo_id\` on \`kanban_add\` / \`kanban_update\`). The idea
then closes by itself when the chain lands: at the merge (\`full\`,
\`code-group\`), at the close with a sha (\`code-self\`), at the close (\`chore\`,
\`doc\`); a \`research\` task only marks it \`analyzed\`. An idea split over
several tasks stays \`partial\` until the last chain lands. Do not tick the idea
by hand.

### Scheduling: \`scheduled_at\` is a timestamp in MILLISECONDS

The API only accepts finite numbers, in Unix milliseconds. An ISO string, a
\`NaN\` or an epoch in seconds is refused with a 400. The CLI converts for you:
\`--scheduled "2026-01-01T02:00:00"\`.

Sending \`scheduled_at: null\` changes nothing, on purpose (a client that sends
back its whole form must not wipe the schedule). To really clear it:

\`\`\`bash
timon task update <ID> --clear-scheduled     # CLI
# API / MCP kanban_update: { "clear_scheduled_at": true }
\`\`\`

### "Tonight" is the NEXT 00:00–07:00 window, not a calendar date

A **valid** timestamp can still be **wrong**: validation checks its shape,
never its intent. Run \`date\` first (your context gives the date, never the
time), move forward to the **next midnight**: that is where the window opens.

| it is…            | "tonight" starts | gap     |
|-------------------|------------------|---------|
| 3:30 pm on May 28 | May 29, 00:00    | 8 h 30  |
| 10:45 pm on Aug 5 | Aug 6, 00:00     | 1 h 15  |
| 2:00 am on Aug 6  | already in it    | now     |

**The gap must be under 24 h.** Beyond that you shifted a day. Late in the
evening, "tomorrow" and "the coming night" are the same date: do not add a day
twice. Beyond 18 h of horizon the API answers with a \`warnings\` field: it is a
warning, not a refusal (a task really meant for next week looks the same).
If you see one, check your arithmetic.

**Usually, do NOT pass \`--backend\`, \`--model\` or \`--permission-mode\`**: the
project role picks them for each task type (see "Backend, model and
permissions per role"). These flags are one-off overrides.

### Choosing the LLM of a task (\`--backend\` + \`--model\`)

A task does not depend on an LLM: you may force a backend AND a model on it,
whatever the configuration of the agent that runs it. This is how a pipeline
chains different LLMs.

\`\`\`bash
CODE_ID=$(timon task create --title "feat X" --type code \\
  --agent <coder> --backend <backend-a> --model <model-a> | jq -r '.id')

timon task create --title "review feat X" --type review \\
  --agent <reviewer> --backend <backend-b> --model <model-b> --deps "$CODE_ID"
\`\`\`

- \`--backend\`: the LLM provider. Omitted → the role's default, else the agent's.
- \`--model\`: must belong to that backend. A model that does not is **ignored**
  (the backend's default is used). Run \`timon backends\` for the real list;
  never write a model name from memory.
- MCP: the same pair is \`backend_override\` / \`model_override\` on \`kanban_add\`.

With no reason to change LLM, **leave both empty**: the project role
(\`timon project roles <slug>\`) already carries the right pair per task type.

### Fallback of ONE task (\`--fallback-backend\` + \`--fallback-model\`)

Not the same as \`--backend\`/\`--model\` (which pick the PRIMARY backend): these
say what to do if that backend runs out of quota, for this task only.

\`\`\`bash
timon task create --title "feat X" --type code --agent <coder> \\
  --fallback-backend <backend> --fallback-model <model>
\`\`\`

\`--fallback-backend none\` = never switch automatically for this task.

**You normally set nothing here.** A task out of quota falls back, in order, on
the series rule, then Timon's global setting, then — if nothing was ever
configured — an automatic switch to an equivalent model of another backend.

### Linking a batch of tasks (\`group_id\`)

When you create **several tasks that make one piece of work** (a feature split
into N parallel parts plus a final \`merge\`), link them with a shared
\`group_id\`. The orchestrator follows the batch and wakes up when every task of
the group is finished — the review, repair iterations and merge it chains after
a \`code\` task join the batch on their own, so the recap waits for them. Mint
the UUID yourself, once, and pass it to each call:

\`\`\`bash
GROUP_ID=$(uuidgen)
timon task create --title "part A" --type code  --agent <coder>  --group-id "$GROUP_ID"
timon task create --title "part B" --type code  --agent <coder>  --group-id "$GROUP_ID"
timon task create --title "merge"  --type merge --agent <merger> --group-id "$GROUP_ID" --deps <id_A>,<id_B>
\`\`\`

### Task types

- \`code\` — implementation. If the agent works in a git repository, the
  dispatcher creates an **isolated git worktree**: commits go to a dedicated
  branch \`timon/task/<id>\`, never to the base branch.
- \`review\` — audit of the diff of a \`code\` task (put it in \`--deps\`).
  Inherits the same worktree. Read-only.
- \`merge\` — integrates the approved branch into its base. Local only; a push
  needs an explicit authorisation in the project's instructions.
- \`research\`, \`doc\` — no worktree, free work in the agent's cwd.
- \`chore\` — miscellaneous ops and cleanup.

When your task runs in a worktree, the \`timon-worktree\` skill is injected too.

### Backend, model and permissions per role

The dispatcher applies the **backend**, **model** and \`permission_mode\` that
the project maps to the task's \`type\` (\`timon project roles <slug>\`). To set
the default pair of a type:

\`\`\`bash
timon project set-role <slug> review <agent> --backend <backend> --model <model>
\`\`\`

This is the preferred place for multi-LLM chaining (rather than \`--backend\`
on every task).

**A role cannot point at another project's agent.** The API refuses (400) an
agent whose \`cwd\` differs from the project's: its tasks would create their
worktrees in the wrong repository, silently. Create an agent for the project.
If the sharing is really meant (a generic agent with no repository of its
own), send \`force: true\`.

\`auto\` is the recommended \`permission_mode\` for every type, night included:
the classifier allows the safe operations, refuses the dangerous ones and only
defers ambiguous ones to a card. On an unattended mission, a card left
unanswered resolves to an explanatory deny after about 5 minutes.

## Chaining code → review → merge → doc

The full pipeline of a feature with git:

\`\`\`
code  →  review  →  merge  →  doc (automatic)
\`\`\`

Without git, there is no merge: \`code → review → doc\`.

The \`doc\` task is **created automatically** as soon as a task is terminal
(no other non-doc task depends on it), when the project has a librarian. You
do not create it. Write a detailed close comment instead: it is copied into
the doc task.

### Pipeline of a task (\`--pipeline\`)

The \`pipeline\` field of a \`code\` task decides what follows it. It is chosen
by the person who launches the work; an agent does not guess it.

| value | automatic review | automatic doc | who integrates the branch |
|-------|------------------|---------------|---------------------------|
| \`full\` (default, field absent) | yes | yes | the chained \`merge\` task |
| \`code-self\` | **no** | no | **the coder itself**, at the end of its task |
| \`code-group\` | **no** | no | one final \`merge\` task for the whole group |

The \`code-*\` modes are the fast mode: the user watches the result live. They
also cut the verification loop, so nothing goes BLOCKED automatically.

**If your task is \`code-self\` or \`code-group\`, you create NO \`review\` or
\`merge\` task** (your brief repeats it). In \`code-self\`, you integrate your
branch yourself, with an explicit message (see "Merge messages" below), and
close with:

\`\`\`bash
timon task done <TASK_ID> --comment "…" --merged-sha <sha of the merge commit>
\`\`\`

The sha is **mandatory** in \`code-self\`: without it the task goes back to
\`BLOCKED\` (guard against a branch never integrated). A conflict you cannot
solve cleanly → \`timon task block\` with the reason, never a forced merge.

**The sha must be COMPLETE (40 hex characters).** The short form git shows
everywhere (\`fe2dd84\`) is refused: seven characters prove nothing. Get the
long one with \`git rev-parse HEAD\` (or \`git rev-parse <short-sha>\`).

### Integrate from YOUR worktree, never from the main repository

The main repository has **one** working directory, shared by every agent. A
command that writes there (\`git add\`, \`commit\`, \`checkout\`, \`reset\`,
\`update-ref\`) while another agent works there commits its intermediate state
— this is how freshly integrated work gets committed as deleted.

A merger gets its own worktree (\`timon/merge/<id>\`). Do everything there:
merge, conflicts, build, tests. Integrate each source branch with an explicit
message:

\`\`\`bash
git merge --no-ff -m "merge: integrate the task branch into <base>" <source-branch>
\`\`\`

The final integration is one command, repeated at the end of your brief:

\`\`\`bash
git -C <main-repository> merge --ff-only timon/merge/<task-id>
\`\`\`

If it refuses, the base has moved: go back to your worktree,
\`git merge --no-edit -m "merge: bring <base> into the task branch" <base>\`,
resolve, try again. Never \`--force\`. When the main repository is checked
out on another branch than the base, your brief gives the reference-only
command to use instead: follow it.

### Merge messages

Every merge commit you create carries an explicit English message (\`-m\`)
with **no task or mission id**. Git's default, \`Merge branch
'timon/task/<id>' …\`, is refused by a public repository's \`commit-msg\`
hook, which leaves the merge unfinished; where no hook stops it, it publishes
internal ids. After resolving a conflict, conclude with \`git commit
--no-edit\`: the message given with \`-m\` is kept. A fast-forward
(\`--ff-only\`, \`push .\`) creates no commit and needs no message.

**Never delete a file your branch does not ask to delete.** An automatic
check compares what your merge deleted with what your branch deleted; on a
mismatch the task comes back to you with the list of files and the command to
restore them.

Your branch may have been **brought up to date** on its base before you
started. If conflicts are open, your brief says so first: resolve and commit
them BEFORE anything else.

### Series fallback plan (quota exhausted)

A series of tasks can carry a fallback plan **per scope**: who takes over when
an actor's backend runs out of credits.

\`\`\`bash
timon series fallback list                    # rules in effect for THIS series
timon series fallback set --scope code --backend <backend> --model <model>
\`\`\`

Scopes: \`orchestrator\` (the mission steering the series, which receives every
alert), \`code\`, \`*\` (everything else), or a precise type, which wins over
\`*\`. \`--backend none\` = this scope does not fall back. **The orchestrator
sets this plan**, after asking the user; as a task agent you leave it alone
unless your task says otherwise. A task in flight is never cut.

### The code → review → merge chaining is AUTOMATIC: do not touch it

**Hard rule: never create a follow-up \`review\` or \`merge\` task yourself.**
The orchestrator does it:

- your \`code\` task goes DONE with a non-empty diff → it creates the \`review\`
  task on the project's reviewer;
- the review closes with \`verdict: pass\` → it creates the \`merge\` task;
- the review closes with \`verdict: changes_requested\` → it respawns the coder
  with the feedback, up to 3 iterations, then escalates.

You **close your task, that is all**. When an agent also chains, every step
is created twice and each one is dispatched and paid twice; the orchestrator
only recognises the tasks it created itself.

This holds for **every role**: a reviewer does not create the \`merge\` task
either. Its \`verdict: pass\` in the close comment is what triggers the merge.

## Closing your task as DONE (mandatory)
\`\`\`bash
timon task done <TASK_ID> --comment "What was done, in 1–2 sentences"
\`\`\`

Or the MCP tool \`kanban_mark_as_done\`, which closes THE task of your mission
(no id to copy). Add \`summary\`: one or two plain sentences for the user, shown
on the return card (no ids, shas or JSON).

### Long comment (review, detailed report)
An inline multi-line \`--comment\` gets mangled by shell quoting, which is what
breaks the parsing of a review verdict. Two safe forms:

\`\`\`bash
# 1. from a file (preferred)
timon task done <TASK_ID> --comment-file <path-to-your-report.md>

# 2. stdin REDIRECTED (not a pipe)
timon task done <TASK_ID> --comment-stdin < <path-to-your-report.md>
\`\`\`

**Never pipe from another command** (\`cat … | timon task done …\`): the
permission allowlist matches the **first word** of the command, so a pipe that
starts with \`cat\` is not recognised as a \`timon\` call, the classifier refuses
it, and the mission can end BEFORE writing its comment. The task then goes
BLOCKED with a misleading reason although the work was done.

The flags are \`--comment-file\` / \`--comment-stdin\`. There is **no** \`--file\`
flag on \`timon task done\`.

## Closing your task as BLOCKED
\`\`\`bash
timon task block <TASK_ID> --reason "Precise reason"
\`\`\`
Use BLOCKED when you cannot go on without a human, or when an external
dependency is not met.

## Updating metadata
\`\`\`bash
timon task update <TASK_ID> --priority 5 --title "New title"
\`\`\`

## Rules

1. **Always close your task** — \`done\` or \`block\` before you finish.
2. **Prefer sub-tasks** to doing everything yourself when the work splits and
   other agents are better equipped.
3. **Never spawn through your CLI's own sub-agent tools** (\`Task\`, \`Agent\`…):
   use \`mission_spawn\` / \`timon spawn\` (skill \`timon-delegate\`) or
   \`timon task create\`.
4. Parse the \`TASK_ID\` of your first input line once, at the start.
`,
  },
  {
    id: 'timon-worktree',
    content: `---
allowed_tools: ["Bash(timon:*)", "Bash(git:*)"]
---

# skill: timon-worktree

You work in a **git worktree** that Timon created for your task: a folder
isolated from the agent's main repository. Your commits stay on a dedicated
branch \`timon/task/<TASK_ID>\` until the code → review → merge chain is over.

The dispatcher injects this skill whenever your task runs in a worktree
(\`code\` tasks, and the \`review\` / \`merge\` tasks of their chain).

## Where you are

- \`cwd\` = your task's worktree (\`pwd\` confirms it)
- current branch = \`timon/task/<TASK_ID>\` (\`timon/merge/<TASK_ID>\` for a merger)
- base branch = the one the worktree was created from (usually \`main\`)

To read them instead of guessing:
\`\`\`bash
timon worktree info <TASK_ID>
\`\`\`

## By task type

### \`type=code\` (builder)

1. Work in your cwd as usual (read, write, code).
2. **Commit your changes on your branch.** Do not push, do not merge (except
   in \`code-self\`, see the \`timon-task\` skill).
   \`\`\`bash
   git add -A
   git commit -m "<clear message>"
   \`\`\`
3. Close: \`timon task done <TASK_ID> --comment "feature done + tests green + N commits on the branch"\`.
   **Do not create the review task**: the orchestrator creates it on the
   project's reviewer as soon as your task is DONE with a non-empty diff.

### \`type=review\` (reviewer)

You inherit the worktree of the parent \`code\` task. You **read** the diff, you
do not commit.

1. Get the diff:
   \`\`\`bash
   timon worktree info <TASK_ID>          # gives base + branch
   git diff <base>...HEAD                 # the whole diff
   git log <base>..HEAD --oneline         # the commits
   \`\`\`
2. Audit: security, quality, fit with the original request. Run the tests
   when relevant.
3. **Verdict**, as the FIRST line of your close comment (write it to a file,
   then \`--comment-file\`):
   - \`verdict: pass\` → the orchestrator creates the merge task. Do not create it.
   - \`verdict: changes_requested\` → the orchestrator respawns the coder with
     your findings: make them precise and actionable.

   Close with \`timon task done\` in both cases. \`timon task block\` is for a
   review you could not carry out, not for a negative verdict.

### \`type=merge\` (merger)

You have YOUR worktree (branch \`timon/merge/<TASK_ID>\`). You integrate
**locally only**: no push unless explicitly authorised.

1. **Check the push mandate**: look in the project's instructions (\`AGENTS.md\`,
   \`CLAUDE.md\`…) and your system prompt for an explicit authorisation. Without
   a clear one → no push.
2. In your worktree: merge the source branch with an explicit message, no
   task id in it (\`git merge --no-ff -m "merge: integrate the task branch
   into <base>" <source-branch>\`), resolve conflicts, build, test.
3. **Never write to the main repository's working directory** (\`git add\`,
   \`commit\`, \`checkout\`, \`reset\`, \`update-ref\`): other agents share it. The
   final integration is the single command your brief gives, usually:
   \`\`\`bash
   git -C <main-repository> merge --ff-only <your-branch>
   \`\`\`
   If it refuses, the base has moved: \`git merge --no-edit -m "merge: bring
   <base> into the task branch" <base>\` in your worktree, resolve, try
   again. Never force.
4. Get the COMPLETE sha (40 hex):
   \`\`\`bash
   MERGED_SHA=$(git -C <main-repository> rev-parse <base>)
   \`\`\`
5. **Only if a push is authorised**: \`git push\`. Say so in the close comment.
6. Close with the sha:
   \`\`\`bash
   timon task done <TASK_ID> --merged-sha "$MERGED_SHA" --comment "merged into <base>, push=<yes|no>"
   \`\`\`
7. Cleanup, last: \`timon worktree dispose <TASK_ID>\` removes the worktree and
   the local branch. Your \`cwd\` no longer exists afterwards: finish
   everything else before.

## Hard rules

1. **Never push** without an explicit authorisation in the project's
   instructions or your system prompt. The default mandate is local only.
2. **Never force-push, never rebase a shared branch.**
3. **Do not touch another task's worktree.** Your \`cwd\` is your scope.
4. A conflict you cannot resolve → \`timon task block <TASK_ID> --reason "conflict on <files>"\`.
   Do not guess.

## What your worktree does NOT isolate

The worktree isolates the **code**. Nothing else: whatever lives next to the
repository is shared with the other tasks of the project running in parallel.

### The database is SHARED by every worktree

A project's database (container, local server, file) is usually unique. A
migration you apply is visible **at once** to every other task in flight, long
before your branch is merged.

- **You apply a destructive migration** (dropped or renamed column/table) →
  the other tasks run code that reads columns that are gone. Before running
  it, warn the orchestrator
  (\`timon msg send <orchestrator> "destructive migration in flight on <models> — serialise the tasks that touch them"\`)
  and mention it in your commit.
- **You hit "column does not exist"** while your code is consistent → do not
  search your code: another task migrated the database under you.
  \`timon task block <TASK_ID> --reason "database migrated by another task of the batch — waits for its merge"\`.

Rebasing on the base does NOT fix this: the gap is between the code
(versioned, per worktree) and the database (shared, global).

### Docker Compose: set the project name

\`docker compose\` derives its project name from the **current folder name**.
From a worktree the folder is named after the task, so you start a parallel
stack that fails on the ports the real one already holds.

\`\`\`bash
docker compose -p <project-slug> up -d      # ALWAYS -p from a worktree
docker compose -p <project-slug> ps
\`\`\`

\`timon worktree info <TASK_ID>\` gives the original repository.
`,
  },
  {
    id: 'timon-delegate',
    content: `# timon-delegate — delegate to other agents, administer Timon

Use it when a piece of work is better served by a specialised agent, or to
manage the catalogue (skills, MCP servers).

Prefer the MCP tools of the \`timon\` server when your tool list has them
(\`agent_list\`, \`mission_spawn\`, \`mission_wait\`, \`mission_send\`,
\`mission_steer\`, \`mission_status\`,\`mission_kill\`, \`mission_summarize\`, \`mission_fork\`,
\`agent_send_message\`, \`skill_*\`, \`mcp_server_*\`). The \`timon\` CLI below
does the same; it needs \`Bash(timon:*)\` in the agent's \`allowed_tools\` (the
rest follows \`permission_mode\`, typically \`auto\`).

## Find the peers

\`\`\`bash
timon list
\`\`\`

Prints the installed agents as JSON (\`name\`, \`project\`, \`cwd\`, \`model\`,
\`skills\`). Read it before delegating to pick the right agent, and use the exact
name it returns: never guess a name from a display label.

## Spawn and wait for the answer

\`\`\`bash
MID=$(timon spawn <agent> "<complete instruction>" | jq -r .mission_id)
timon wait "$MID" --timeout=180
\`\`\`

\`timon wait\` blocks until the end of the TURN and prints the assistant text
of that turn. Size \`--timeout\` to the work. A persistent backend keeps its
process alive after the turn: the mission stays \`running\`, which is normal
and does not stop \`wait\` from returning. Keep the mission id; never spawn
again just to check on it.

## Continue the conversation

\`\`\`bash
timon send "$MID" "follow-up question"
timon wait "$MID"
\`\`\`

Opens a new turn in the same mission instead of spawning another one.

## Change course during a turn

\`\`\`bash
timon steer "$MID" "new instruction"
timon wait "$MID"
\`\`\`

\`timon send\` (\`mission_send\`) never stops a turn. \`timon steer\`
(\`mission_steer\`) redirects the turn running now: the agent reads the
instruction inside it (\`method: live\`), or the turn is stopped and the
instruction opens the next one in the same session (\`method: restart\`), so a
step it had not finished is redone. Use it when the running work has become
wrong, not to add a remark. \`no_turn_to_steer\` or \`steer_unsupported\`: send a
normal message instead. A mission cannot steer itself (\`steer_self\`).

## A message rather than a mission

To ask an agent something without starting new work, queue a message in its
inbox: \`agent_send_message\` (kind \`request\` when you need a reply), or
\`timon msg send <agent> "<text>" --kind request\`.

## Status / kill

\`\`\`bash
timon status "$MID"     # full mission detail
timon kill   "$MID"     # terminate a running mission
\`\`\`

## Permission level of a mission

\`\`\`bash
timon mission permission-mode get "$MID"          # mode, its source, the choices YOU may set
timon mission permission-mode set "$MID" plan     # applies from the mission's next message
\`\`\`

Never above your own level; beyond default, acceptEdits, plan and auto it needs
\`agents:privileged-config\`. A 403 carries the reason: report it, do not retry.

## Compact a mission (summarize + fork)

When the **context window fills up** (from about 70 %), or when the user
wants to **change LLM** mid-conversation, compact the current mission: produce
a summary, then spawn a **new mission** on the target agent seeded with it.

\`\`\`bash
# Produce (or refresh) the cross-provider summary of the mission.
timon mission summarize "$MID"

# Fork onto another agent (or the same one) with a restart message.
NEW=$(timon mission fork "$MID" --to <target-agent> --message "carry on, focus on X" | jq -r .mission_id)
\`\`\`

**When to offer it yourself**:

- your own context window is past ~70 %;
- the user reports a quota or rate limit on the current provider → suggest a
  fork onto an agent of another backend;
- the conversation has run long and the history blurs the answers.

**Target agent**: the same agent resets the context and keeps its skills, MCP
servers, permissions and cwd; another agent changes LLM (backend + model).

\`fork\` creates a **new mission id**. Tell the user explicitly:
\`→ forked to <agent> (new mission <first 8 chars>), summary seeded\`. Never
silently: the source mission stays visible but idle.

## Administer skills

\`\`\`bash
timon skill list                          # all skills, as JSON
timon skill get <id>                      # prints the SKILL.md
timon skill put <id> --file <path>        # creates or replaces a skill
timon skill put <id> --file <path> --create-only   # never replaces (409 if it exists)
timon skill rm <id>
\`\`\`

The product's own skills (\`timon-task\`, \`timon-worktree\`, \`timon-delegate\`
and the other bundled ones) are reserved to the operator: an ordinary mission
is refused.

## Administer MCP servers

\`\`\`bash
timon mcp list                            # all MCP servers, as JSON
timon mcp get <id>                        # full config (secrets masked)
timon mcp put <id> --file <server.json>   # creates or replaces one
timon mcp rm <id>
\`\`\`

\`server.json\` holds \`{ "name", "description", "transport" }\`, where
\`transport\` is \`{ "type": "http", "url": "https://…", "headers": {…} }\` for a
remote server or \`{ "type": "stdio", "command": "…", "args": […] }\` for a
local one. A stdio server runs a command on the host: from a mission it needs
the \`agents:privileged-config\` permission, otherwise the user adds it in the
app.

## Rules

- Do NOT delegate what you can solve directly and faster.
- When you delegate, say so: \`→ delegated to <agent> (mission <first 8 chars>)\`.
- Prefer an agent of your own \`project\` for project-scoped work. Cross
  projects only when needed, and say so.
- The sub-agent inherits ITS cwd and ITS skills: do not ask it for something
  outside its scope.
- Independent sub-tasks: spawn them in parallel, then \`wait\` on each.

## Rules for administrative operations

- **Always ask for confirmation** before creating, changing or deleting a
  skill or an MCP server: it affects every agent. Ask the user with the
  \`question\` tool; on an unattended mission, ask the agent that spawned you
  instead, never the user.
- Before a \`put\`, \`get\` first so you do not overwrite blindly.
- Before an \`rm\`, check that no agent still uses the skill or the server
  (read \`timon list\`, filter \`skills\` / \`mcp_servers\`).
`,
  },
];
