---
title: Land a job through a pull request
sidebar_position: 4.2
---

By default a Kanban job lands locally: each task's branch is merged into its base branch on your machine. A project whose main branch is protected, or shared with a team, can land its jobs through a pull request instead. The job's tasks merge into one integration branch (`feat/<topic>`) cut from the remote's target branch, and Timon opens a single pull request for it once the work is done. Merging that pull request stays your gesture, on the forge.

GitHub is the only forge Timon opens pull requests on for now, through the GitHub CLI (`gh`), which must be installed and signed in on the machine where Timon's daemon runs.

## Set up the project

### From the app

Open the project's window: **Edit** on its card in the agents grid, or, from a chat of the project, the project's name above the message box, then **Project settings…**. Under **Integrations**, the **Pull requests** row says how the project's jobs land, **Jobs merge locally** or the target branch and account of its pull requests (`Pull request to origin/main · account my-bot`). **Set up** (**Configure** once it is on) opens the fields:

- **Remote** and **Push URL of the remote**: pick one of the repository's remotes; the URL it pushes to is filled in for you. A remote that later points elsewhere is refused.
- **Target branch** (`main` by default) and **Branch prefix** (`feat/` by default).
- **GitHub account**: the login `gh` must be signed in as.
- **gh configuration folder** (optional): a `gh` configuration folder kept for this project, inside your home folder and outside every project folder.

**Check** asks `gh` which account it signs in as with the account and folder you typed, before anything is saved, and says why it could not answer (`gh` missing, not signed in, a folder Timon refuses). **Turn on** saves the setting. The row's menu (**…**) checks `gh`'s sign-in again later, and **Go back to the local merge** clears the setting.

The row and its fields are for accounts that hold the `projects:manage` permission: the setting names a folder of your machine and the account Timon pushes as. Without it, the row says so and its action is greyed, as is **Project settings…** in the chat.

While a project merges its jobs locally, the **Pull requests** and **Jobs** tabs of the chat's [Git stack](git.md) say so in one line, with a settings icon (**Set up pull requests**) that opens the same fields directly. Every account that sees the project gets the line; the icon is offered only to an account allowed to manage projects.

### From the command line

```bash
timon project set-integration my-app --mode pr --account my-bot \
  --remote-url git@github.com:my-org/my-app.git \
  --gh-config-dir /home/me/.config/gh-my-bot
timon project get-integration my-app --check
```

- `--account`: the GitHub login `gh` must be signed in as. Timon refuses to push when `gh` answers another one.
- `--remote-url`: the push URL the project's remote (`origin` unless `--remote` says otherwise) must have. A remote that points elsewhere is refused.
- `--gh-config-dir` (optional): a `gh` configuration folder kept for this project, inside your home folder and outside every project folder. Without it, `gh` uses its default sign-in.
- `--target` (default `main`) and `--branch-prefix` (default `feat/`) name the target branch and the prefix of the integration branches.

`--check` asks `gh` which account it signs in as, so you can confirm the setting before any job runs.

## How the project's jobs run

Once the project is in `pr` mode, its jobs land through a pull request and nothing of them is merged into the target branch on your machine:

- When you plan a job with an agent (the Kanban planner), Timon names the job's integration branch after the job's title, `feat/add-csv-export` for "Add CSV export" (with `-2`, `-3`… when an earlier job already used the name), or after the name the agent proposes, and every task of the job starts from it. In the planner, **Advanced** shows that name: you can change it before you launch the job (the project's prefix, `feat/`, is added for you), or pick a branch the repository already has (see [Choose the job's branch and where it ends](#choose-the-jobs-branch-and-where-it-ends)). Timon checks the name as you type and says why one cannot be used (an id in it, a name reserved for Timon's own branches, the target branch itself, a name git refuses). Once a task of the job has started, the branch exists and its name is fixed: planning the same job again shows it read-only.
- The planner follows the job's project, not only the agent's: an agent that belongs to no project but works in the project's folder plans the job the same way, and the tasks it creates name the project.
- When the first task starts, Timon creates that branch from the remote's target branch (`origin/main`), without touching your checkout. If the remote cannot be reached, the task is blocked with the reason instead of starting from your local `main`.
- Reviews and merges run as usual, into the integration branch.
- The plan ends with a final task, **Pull request — *job title***. It starts once every part of the job is merged into the branch: an agent brings the target branch in if it has moved, writes the title and the description, and opens the pull request as described below. The task is done as soon as the pull request is open; you review and merge it on the forge.

A task you create by hand in such a project without a base branch gets an integration branch named after its own title. A task whose base is the target branch itself (`main`) is blocked: in this mode no work starts from it. To add the final task by hand:

```bash
timon task create --type merge --landing pr --agent my-app.merger --base feat/add-csv-export \
  --deps <ids of the code tasks> --title "Pull request — Add CSV export"
```

Jobs already under way keep the mode they started with: changing the setting, or going back to the local merge with `timon project set-integration my-app --reset`, applies to the next jobs.

### A job run sequentially

When you pick a sequential mode in the planner (**in this mission**, or **in a new mission**), the job has no task to cut its branch, so the agent asks Timon for it first:

```bash
timon pr branch feat/add-csv-export
```

Agents use the `pr_branch` tool, which does the same. Timon checks the name, creates the branch from the remote's target branch as it does for a Kanban job (refused, never cut from your local `main`, when the remote cannot be reached), fixes its name for the job, and answers with a working folder of the agent's own on that branch. The agent codes and commits only in that folder, never in your checkout, and moves the branch forward after each commit. When the work is done, it creates the same final task, **Pull request — *job title***, which opens the pull request; the rest of the circuit is the same as for a Kanban job. Running the command again for the same job gives back the same branch and folder.

## Choose the job's branch and where it ends

In the planner, **Advanced** holds both choices, for every project. Folded, it sums them up: `feat/add-csv-export · merged into main`, `· PR to main` in a project that lands through pull requests, or `· kept on the branch`.

- **Branch**: **New** shows the name proposed for the job after the project's prefix (`feat/`), which is not typed; change the rest, and Timon checks it as you type, says why a name cannot be used, and shows the number it adds (`Created as feat/add-csv-export-2`). **Existing** lists the repository's local branches, newest first, without the target branch, with a search field when the list is long; Timon checks the branch you pick. Once a task of the job has started, the branch is fixed: planning the same job again shows it read-only.
- **At the end**: **Merge into main** (the default), read **Open a PR to main** in a project that lands through pull requests, or **Keep on the branch**. **Resolves its issues entirely** only shows when a pull request will be opened.

The planner keeps these choices, with the rest of the form, if its card comes back or the page reloads before you launch.

The plan can name the job's branch in two ways: a **new branch** (the name Timon or the agent proposes, which you may change), or a branch the repository **already has**, picked among its local branches, newest first, so that the job continues work already under way instead of starting a new branch from `origin/main`. Timon checks the choice before the plan applies: an existing branch must be in the repository, and can be neither the target branch, nor one of Timon's own task branches (`timon/…`), nor a name carrying an id, nor the branch of a job that already landed or whose pull request was closed. A new name that the repository already has gets `-2`, `-3`…

The plan also says where the branch ends up:

- **Merge into the target** (the default): in a project that lands through pull requests, the last task opens the pull request, as described above.
- **Keep on the branch**: no last task. The work stays on the branch, which is never pushed; the job's TO DO ideas stay partial (integrated into the branch) until the branch lands.

A project that merges locally can use the same choice. A job planned on a branch then runs on that branch instead of your `main`: Timon creates a new branch from the project's target branch (`main` by default, the **Target branch** of the project's setting), on your machine, without touching your checkout, or starts from the existing one. Every task of the job merges into the branch, and the job's TO DO ideas stay partial. With **Merge into the target**, the plan ends with a task **Merge into main — *job title***: once every part is merged into the branch, an agent merges the branch into `main` on your machine, never by pushing. Timon checks with git that the merge is in `main` and contains the whole branch, then closes the job's TO DO ideas and creates its documentation task. To add that task by hand:

```bash
timon task create --type merge --landing local --agent my-app.merger --base feat/add-csv-export \
  --deps <ids of the code tasks> --title "Merge into main — Add CSV export"
```

A job planned in the planner always names its branch, so in a project that merges locally it runs on a branch of its own, merged into `main` at the end unless you keep it. Tasks you create by hand, without a branch, work as before. A sequential job uses the same choice: `timon job branch` gives the agent a working folder on the chosen branch, existing or new, in either kind of project (`timon pr branch` is the same command under its first name, kept for the scripts that use it). A branch that was chosen as existing and has since been deleted blocks the job's tasks with the reason; it is never recreated.

### Land a branch you kept

When the job is done and you want its kept branch in the target after all, land it from its row in the **Jobs** tab of the chat's Git stack (**Merge into main**, or **Open the PR**: see [Jobs](git.md#jobs)), or from a terminal:

```bash
timon pr land <job>
timon pr land <job> --title "Add CSV export" --body-file pr.md   # a project that lands through pull requests
```

Name the job by its series, or by the conversation that planned it (`current` from inside that conversation); when that series holds several jobs, give the job's own id, listed by `GET /api/kanban/landings?series=<series>`. Agents use the `pr_land` tool, which does the same. It needs the permission to manage projects, and it is refused while a task of the job still waits or runs.

- **In a project that merges locally**, Timon merges the branch into the target branch on your machine, never by pushing. When the target has not moved since the branch was cut, it simply moves forward to the branch. Otherwise Timon writes the merge commit itself (`merge: integrate <branch> into <target>`, with your repository's commit identity), without creating a working folder and without running any hook. A conflict is refused with the list of files in conflict: nothing is merged and nothing is ever resolved for you; resolve it on the branch, then land again. When the target branch is checked out in a folder, your checkout follows it (a fast-forward), but only if that folder has no uncommitted change and no untracked file; otherwise the landing is refused and nothing moves.
- **In a project that lands through pull requests**, landing opens the job's pull request, with the same checks as `timon pr open`; a title is then required. Nothing is merged on your machine: the job lands once the pull request is merged, as below.

Once the branch is in the target, the job's TO DO ideas close and its documentation task is created, once. Running the command again on a job that already landed, or whose pull request is already open, says so and changes nothing. When the job's pull request was closed without being merged, landing it again opens a new pull request, with the same checks and a new title; the closed one stays as it is on GitHub. A branch under embargo (`sec/…`) never lands this way.

## Your checkout follows the branch Timon moves

Agents never write in your project's own working folder: they work in separate worktrees. When the branch they land on (your `main`, or the target of a job) is the one checked out in that folder, Timon itself brings the folder up to date after a task is merged into it, after a landing, and after it fetches the target from the remote. It does so only under strict conditions:

- the folder is on that branch (not a detached HEAD, not another branch);
- it has no uncommitted change and no untracked file that is not ignored;
- no merge, rebase, cherry-pick, revert or bisect is under way;
- the move is a fast-forward: the branch only moves forward, and the files follow it.

Otherwise nothing is touched. Timon never resets, stashes or forces a checkout: it prints a warning and records the reason in the audit log (`clone.follow.skipped`), and your folder stays as it is until you pull or commit. A branch that is not checked out in your folder keeps moving by reference alone, as before.

## Open the pull request

When the job's work is merged into its integration branch, the agent (or you) asks Timon to open the pull request:

```bash
timon pr open <task-id|series-id> --title "Add CSV export" --body-file pr.md
```

Agents use the `pr_open` tool, which does the same. The title and the description are written by whoever calls it; the account, the remote and the target come from the project's setting.

Before anything leaves your machine, Timon checks the branch. If one check fails, nothing is pushed and the answer lists every check with its result:

| Check | Refused when |
| --- | --- |
| Account | `gh` is signed in as another account than the project's, or cannot answer |
| Remote URL | the remote does not push to the URL the project expects |
| Identity | a commit of the branch was not authored and committed with the repository's `user.name` and `user.email` |
| Messages | a commit message, the title or the description carries a task id or an internal TODO number; the title and the description also carry no attribution line |
| Ignored files | the branch adds a file your `.gitignore` covers (a folder that must stay private, force-added by mistake) |
| Public tree | the repository has a `docs/oss/check-public-tree.mjs` script and it reports a blocker; without the script this check is skipped and says so |
| Remote branch | the branch already exists on the remote and has commits the local one does not contain |

Timon then adds to the description a `Fixes` or `Refs` line for each GitHub issue of the job's ideas ([The issue, the pull request and the comment](git.md#the-issue-the-pull-request-and-the-comment)).

Then Timon pushes the integration branch and opens the pull request. The push is never forced: a branch already on the remote only moves forward, and one that moved on its own is never overwritten. Merge it into your local branch, then run the command again.

A branch under embargo (`sec/<topic>`, for a security fix) is never pushed by this command, whatever the setting says: it lands by hand once the advisory is published.

If the push succeeds but the pull request cannot be created, run the command again: the branch is already there and only the pull request is opened.

Once the pull request is open, a card in your notifications gives its link, and the conversation that planned the job gets a message with it, unless the job's own final task opened it: that task's report already says so.

## Once the pull request is merged

Timon checks every few minutes whether the pull request was merged, by looking for its branch in the remote's target branch. Once it was, the job's TO DO ideas close, its documentation task is created, a card in your notifications says the pull request was merged, and the conversation that planned the job gets a message listing what closed. A pull request closed without a merge closes nothing and keeps the branches: the card is an alert, and the job's conversation is asked what comes next. Without access to the forge, `timon task mark-merged <task> --sha <merge commit>` on a task of the job does the same by hand. If the conversation that planned the job no longer exists, the card is the only notice.

## Follow the job and review contributors

The [Git stack](git.md) of an agent's chat follows what happens next. **Jobs** groups the project's jobs by what they wait for (a failing check or a conflict first) and previews what each pull request carries; **Pull requests** lists the pull requests open on the repository, contributors' ones included, and prepares their review without running their code. On a TO DO idea, the badge of its job opens the same preview. All three follow the job as it moves: a branch recorded, a pull request opened, merged or closed, or new check results show up without a reload, in a preview left open too, and the idea tags on the Kanban's task cards change once the job lands. See [Pull requests](git.md#pull-requests), [Jobs](git.md#jobs) and [From the TO DO notebook](git.md#from-the-to-do-notebook).

### Read a pull request in the app

In **Pull requests**, a click on a row (or **Enter** on a row reached with the keyboard) opens the pull request's page in a window, read only. Its header gives the state (open, draft, merged or closed), the author, the branches it merges (`owner:branch` for a fork), and when it was opened. Four tabs follow:

- **Conversation**: the description, then the comments and the reviews (approved, changes requested, reviewed) in order, with a quiet line for each label added or removed and each force-push (a link compares the branch before and after), then the review threads with the file and line they were written on, a resolved thread folded. The reactions people gave on GitHub show under the description, a comment, a review or a reply; the window only reads them.
- **Commits**: each commit's message, author, date and short hash, which opens the commit on GitHub.
- **Checks**: each check with its state and duration, failures first. On a failed job of the repository's own CI, **Show the end of the log** reads its last lines from GitHub.
- **Files**: each file with its added and removed lines. Unfold one to read its diff, with the review threads under the line they were written on.

Beside the tabs, a column opens on a card that sums up where the pull request stands, as GitHub's merge box does: its checks counted (a click opens **Checks**), whether it merges cleanly, is in conflict, behind its base, blocked by the base branch's rules or still a draft, the review decision, a lock on its branch, and the verdict of Timon's review. Under them, across the column, the gesture the pull request's state calls for is the filled button: **Resolve the conflict…** for a conflict you may resolve here, else **Update the branch** for a branch behind its base, else **Propose a comment…** for a draft, else **Show the report** when Timon's review still matches the code. Otherwise no button is filled: nothing waits on you, and the card shows where the pull request stands with outlined buttons only. One or two frequent gestures follow, **Ask the contributor** for a branch in conflict for instance. **Review brief** is always one of these secondary gestures, first of them when none is filled: it writes a brief to paste into a review mission and starts nothing ([Pull requests](git.md#pull-requests)). The card stays in view whatever the tab and however far you scroll. It shows as soon as the window opens: while GitHub is being read, or if it cannot be, one line says so (with **Try again** after a failure) and the gestures are already there. It has no merge button: you merge on GitHub. Under the card come the requested reviewers, the assignees, the labels, the milestone, the issues it closes, and, for one of your jobs, the job and its TO DO ideas; only what the pull request has is listed. The window's header keeps the title and four icons: **Read again from GitHub**, **Open on GitHub**, **…** and close. The **…** menu holds the other gestures, the job and its TO DO ideas, in the same order as the row's own menu. In a narrow window, the card moves above the tabs, across the window, and the people and links close the **Conversation** tab. A gesture the branch refuses (its author does not let the maintainers change it, or its fork was deleted) stays greyed, with the reason when you point at it, in the window and in the row's menu; a gesture being prepared shows a spinner. The window reads GitHub with the project's account, only once `gh` answers that it signs in as it (checked again after a minute): with another account it says so and reads nothing. It runs nothing from the contributor's branch. What people wrote on GitHub is shown as text: no HTML from a description or a comment runs, links open in your browser, and very long texts and lists stop with a note saying how much is left on GitHub. Review threads are read past GitHub's first hundred, up to 300, with up to 100 replies each. People show as the first letter of their login: the app loads no picture from GitHub. A page read in the last 30 seconds is shown again without asking GitHub; **Read again from GitHub** (the arrow in the window's header) asks for it now.
