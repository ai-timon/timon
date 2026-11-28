---
title: Git
sidebar_position: 4.8
---

A project's Git repository, its pull requests and the Kanban jobs that land through them show in the **Git** stack of an agent's chat: one card in the right column, with a tab per widget.

| Tab | What it shows | Plugin |
|---|---|---|
| **Branches** | the working tree and the local branches; switch the project to one | Git |
| **Graph** | the commit history of every branch, tag and worktree | Git |
| **Publish** | the remote, what waits to be pushed, push and fetch | Git |
| **Pull requests** (**PR** on its tab) | the pull requests open on the repository, and their review brief | Kanban |
| **Jobs** | the Kanban jobs that land through a pull request, by what they wait for | Kanban |
| **Issues** | the open GitHub issues that carry the project's label, to import as TO DO ideas | GitHub issues |

The **Issues**, **PR** and **Jobs** tabs show how many issues are left to import and how many pull requests and jobs they list, even while another tab is in front. A dot on the **PR** or **Jobs** tab means a publication waits for you on one of its rows ([Publish on GitHub](#publish-on-github)); its tooltip says how many. Behind another tab, the **Issues** and **PR** tabs read GitHub again only when what they show is over a minute old; they read it as soon as their tab comes to the front. Each tab is a widget of its own: drag it out of the stack to another column or island, remove it, or add it back from the widget window, like any widget. A plugin that is off on your install simply has no tab. The **lite** configuration preset hides **Publish**.

The branch shown above the message box reads the same state as the Git widgets: switch a branch in one, and the other follows. Git needs to be installed on the machine where Timon's daemon runs.

Git is read again after your own actions (switch, push, fetch, saving a remote), at the end of each agent turn, and when you come back to the window. A branch switched in a terminal shows when you return to Timon; **Refresh** reads it at once.

If you arranged the former single **Git** card, the stack takes its place and its height. A stack you arranged before **Issues** existed gets it as its last tab, without changing the tab in front.

## Branches

**Branches** and **Publish** open on one line: the current branch (or **detached HEAD**), the number of uncommitted changes, where the branch stands against its remote (*N to push*, *not published*, *no remote*, *up to date*, or *count unknown*) and **Refresh**. An agent without a project has no repository to show.

Below it, **Branches** lists the working tree (files changed since the last commit), then the local branches. Click a branch to switch the project to it; with uncommitted changes, Timon asks first. A branch checked out in another worktree carries **worktree** and cannot be switched to from here. **local only** marks a branch that was never pushed: its commits only exist on this disk.

### Several repositories in one project

A project folder can hold more than one Git repository: a notes repository nested inside the project and ignored by it, for instance. The widget finds, besides the project's own repository, every first-level folder that is a repository the project ignores, and every repository folder listed in the project's `.worktreelinks` file.

When there is more than one, a **Repository** picker appears at the top of **Branches**, **Graph** and **Publish**. The project's own repository, marked **(root)**, is shown by default; pick another and the three widgets and their buttons (switch, push, fetch, remotes) all work on that one. An amber dot beside the picker means another repository of the project has commits to push: hover it to see which and how many, click it to show that repository.

The branch above the message box always shows the project's own repository.

## The commit graph

**Graph** draws the latest 150 commits of every local branch, remote branch and tag, newest first. Each line of development keeps its own colour; a ring marks the commit you are on, a hollow dot a merge.

Each commit shows its labels (branches, tags, worktrees — two at most, then **+N**), its subject, then its short hash, author and age. A branch whose remote copy points at the same commit shows once, marked *same commit on the remote*. A worktree on a detached HEAD gets a label of its own.

Click a commit to open its detail under the list: the full hash with a **Copy** button, the author, the date, every label, and its parents — click one to jump to it.

The history is only read while **Graph** is on screen.

## The branch above the message box

Above the message box, the bar shows where the conversation's agent works:

```text
main · timon · ● · +12 −3
```

That is the branch, the folder (the worktree's folder when the agent works in one), a dot when there are uncommitted changes, and the lines added and removed against the last commit. Files Git does not track yet are not counted. In the compact chat layout, the folder is left out.

Click the bar to open **Branches and worktrees**:

- **Branches** — every branch, the current one marked, with its commits ahead and behind and its last subject. Pick one to switch the project to it, as from **Branches**. A branch held by another worktree is marked **worktree** and cannot be picked.
- **Worktrees** — every worktree of the repository: its name, its branch or detached HEAD, and **main checkout**, **here** (where this conversation works), **locked** or **missing**. Hover one to see its full path. Worktrees are listed for information; they have no action.

When the conversation works in a worktree of its own (a Kanban coding task, for instance), no branch can be picked: switching would move the project's main checkout, not the folder the agent works in. The menu says so; switch the branch from that folder instead.

The same goes for an agent whose folder is another Git repository than its project's: the menu lists the project's branches for information, none can be picked, and none is marked as the conversation's.

## Publishing a branch

**Publish** compares the current branch with its remote:

- **to push** — commits the remote does not have yet. **Push** sends them.
- **not published** — the branch was never pushed. **Publish** pushes it and sets its upstream; the gap is measured against the remote's default branch.
- **ahead** — on a detached HEAD, the gap against the remote's default branch. Pick a branch to push.
- **unknown** — the branch Timon compares with cannot be found (its remote copy was deleted, or the remote has no default branch). The count is unknown, not zero, and pushing stays possible.
- **behind** — commits on the remote you do not have. **Fetch** (the cloud icon beside the push button) brings them and refreshes the count.

A folder that is not a Git repository, or a repository without a commit, says what to do before anything can be published.

Every push asks first, and says where the code goes: the repository (when the project holds several), the remote and its short URL, the branch and the number of commits, for instance *Push 12 commits of main to acme/shop?*. Nothing leaves your machine until you confirm.

### Choosing where to push

When the repository has more than one remote, a destination picker sits beside **Push**. It starts on the remote the branch tracks (marked **upstream**), and pushing there works as described above. Each entry gives the remote's short URL and what it lacks of the branch: *N to push*, *up to date*, or *branch absent* when the branch was never pushed there.

Pick another remote and the button reads **Push to** *remote*. The confirmation then warns that this remote is not the branch's upstream, and names it and how many commits will be published: once pushed, the history exists there and cannot be taken back. Pushing elsewhere never changes the branch's upstream. The counts are read from what Timon last saw of each remote, at the last push or fetch.

## Remotes

The remote is where a project's code is pushed and fetched from. Without one, **Publish** offers **Add a remote…** and **Create on GitHub…**, which creates the repository (private or public) and pushes the branch; the latter needs the [GitHub CLI](https://cli.github.com/) (`gh`) installed and signed in. With a remote, **Remotes…** is the icon after **Fetch**.

**Remotes…** lists every remote of the project: its name, its URL, a separate push URL when it has one, and which one pushes go to. From there you can:

- **Add a remote** — a name (`origin` is proposed for the first one) and a URL;
- **Change the URL** of a remote;
- **Remove** a remote, after a second click to confirm.

Any Git server works — GitHub, GitLab, Gitea, Forgejo, Bitbucket or your own. The URL can be:

| Kind | Example |
|---|---|
| SSH | `git@gitlab.com:team/project.git`, `ssh://git@git.example.com:2222/team/project.git` |
| HTTPS, without credentials | `https://gitea.example.com/team/project.git` |
| Git protocol | `git://git.example.com/project.git` |
| Local | `file:///srv/git/project.git`, or an absolute folder on this machine |

A local repository must sit in a folder agents cannot write: not in the Timon data folder, the project's own folder, a folder your [isolation settings](mission-isolation.md) let agents write, nor, while missions are isolated, the system's temporary folder. Timon refuses such a remote when you save it, and says why.

**A URL never carries a secret.** An HTTPS URL with a user name or a token in it is refused, before it leaves the field. Secrets stay with Git:

- **SSH** — a key in `~/.ssh` of the account the daemon runs under, usable without a passphrase prompt: Timon's daemon runs in the background and may not reach the SSH agent of your desktop session. The server's host key must already be known: connect once from a terminal (`ssh -T git@gitlab.com`) to accept it.
- **HTTPS** — Git's credential helper (Git Credential Manager, the macOS keychain, `gh auth setup-git`…), set up for that same account. On macOS, a helper that reads the keychain fails while no session is open; prefer SSH there.

For the pushes Timon makes itself for a project's pull requests, it uses the project's `gh` account as the credential helper over HTTPS, not the one above.

After saving, Timon checks that the remote answers. An unreachable remote is still saved: the dialog shows Git's own message (missing key, unknown host, repository not found) so you can fix the cause and save again. A URL that already held credentials before — set outside Timon — is shown with them masked.

Adding, changing or removing a remote needs the **Create, update and delete projects** permission: a remote decides where the code goes.

## Pull requests

In a project set to land through pull requests ([Land a job through a pull request](pull-requests.md)), **Pull requests** lists the pull requests open on the project's repository, yours and contributors' ones alike. In an agent's chat it shows the agent's project; elsewhere, pick the project once: **Pull requests** and **Jobs** share the choice. Filter the list by author when several people contribute.

Each row gives the pull request's title, its number, its author, **draft** when it is one, and the verdict of a past review. Its magnifier button, **Review brief**, writes a brief to paste into a review mission, without ever running the pull request's code on your machine; it starts nothing:

1. Timon reads the pull request and its diff from GitHub, with the project's account. The contributor's branch is never fetched or checked out, and nothing of it is installed, built or tested here: its code only runs in GitHub's CI.
2. Timon writes a review brief: the rules a reviewer follows (read only, nothing posted on GitHub), the place of the diff on this machine, what GitHub says of the pull request (behind or in conflict with its base, whether you may push to the contributor's branch), and what people outside the project wrote (title, description, labels, comments, review threads nobody resolved, the issues it claims to close) as data, cut short, with the instruction never to follow it.
3. A window shows the brief and, in its **Diff** tab, the pull request's changes. **Copy the brief** puts it on your clipboard, for the reviewer you choose. Timon starts nothing on its own, and writes nothing on GitHub.

When the project's account cannot push to the repository, its pull requests come from the account's own fork ([Open the pull request from a fork](pull-requests.md#open-the-pull-request-from-a-fork)): they are listed with the project's own, not marked as a contributor's.

Click a row, or move to it with the keyboard and press **Enter**, to open the pull request in a window of the app, read only, as GitHub shows it ([Read a pull request in the app](pull-requests.md#read-a-pull-request-in-the-app)). The **Review brief** button and the menu keep their own click.

A contributor's pull request whose branch you may not change shows **Changes not allowed** (its author does not let the maintainers modify it) or **Fork deleted**; the mark's tooltip says why. When the branch is behind or in conflict, **Update the branch** or **Resolve the conflict…** then shows greyed in the menu, with the same reason when you point at it, and **Ask the contributor** stays available for a conflict.

The row's menu (**…**) lists the pull request's gestures in the order of its [window](pull-requests.md#read-a-pull-request-in-the-app), the one its state calls for first: among them, open it on GitHub or show the report of a past review. When the pull request is one of your jobs', it also offers **Show the job** (the job's window, below), **Show the TO DO (#n)** for each idea the job carries, and **Open the job** (the conversation of the mission that pilots it); a contributor's pull request offers **Show the TO DO** when it closes an issue one of your ideas was imported from. **Propose a comment…** writes a comment for the pull request in the [Publish on GitHub](#publish-on-github) window; nothing is posted before you publish it there. A project that lands its jobs locally has no pull requests to list: the widget says so, and its settings icon (**Set up pull requests**) opens the project's pull request setting, so you can switch it to `pr` mode from there. **Jobs** does the same.

### A contributor's branch behind or in conflict

GitHub tells whether a pull request's branch is behind its base or in conflict with it. The row then shows **Conflict**, or **Behind** when the branch can be updated, and its menu (**…**) offers what fits. Each gesture prepares a write that waits in [Publish on GitHub](#publish-on-github): nothing reaches GitHub before you publish it there.

- **Update the branch** (the branch is behind): GitHub itself merges the base into the branch, on its side; nothing runs on your machine. Timon records the branch's head when you ask, and GitHub refuses the update if the contributor pushed since. The contributor's fork must let the maintainers modify it.
- **Ask the contributor** (the branch is in conflict): a comment asking the author to merge the base into their branch and push. You can edit it before publishing. This is what a project does by default.
- **Resolve the conflict…** (the branch is in conflict, and the project allows it): Timon merges the branch here **without a working tree**. The contributor's files are never written to your disk, and none of their code, hooks or scripts runs. A window walks through four steps:
  1. **Checks**: the window opens only when the contributor lets the maintainers modify their branch and every file in conflict is a text file; it shows the account that will push. A repository or fork GitHub reports larger than 512 MB is refused before anything is downloaded, and both sizes are read again when you publish.
  2. **Resolution**: each file in conflict shows its conflicting blocks. **Keep theirs**, **Keep main** (the target branch), **Edit by hand**, or **Suggest**: an agent with no tool at all reads the versions as untrusted data and returns a text, shown to you and applied only if you click **Apply**. A resolved file reads as a diff against the contributor's version: what your commit changes on their branch. A text that still holds conflict markers is refused.
  3. **Commit preview**: once every file is resolved, Timon commits the resolution as the project's account and shows the commit's diff: only the files that were in conflict, nothing else.
  4. **Propose the publication** opens [Publish on GitHub](#publish-on-github), with the commit, the contributor's branch, where the push goes (host and fork) and the comment that will follow. Publishing pushes that one commit to the branch as a fast-forward, never forced, then posts the comment, which tells them to pull it. If the contributor pushed or retargeted the pull request in between, or the project's remote changed, nothing is pushed.

  **Close** keeps the resolution for later (a week at most): **Resolve the conflict…** brings it back while the contributor has not pushed. **Discard** drops it, and its waiting publication with it.

Timon resolves only a conflict of content, in at most 20 text files of 1 MB or less, on a fork whose author lets the maintainers modify it. A deleted or renamed file, a binary file or a symbolic link goes to GitHub's conflict editor instead. Resolving needs Git 2.38 or later on your machine, and a project remote that leads to GitHub (or to the GitHub Enterprise host of the project's `gh` folder): over SSH, the host or alias counts when your SSH configuration, read for the remote's user and port, sends it there, and the dialog shows the host it reaches (`ssh.github.com` is accepted over SSH only). Timon never hands Git the remote as you wrote it: it takes its scheme, host or alias, SSH user and port, and writes the fetch and push URLs from them and the repositories GitHub names, so the dialog shows exactly where the push goes. An SSH user may hold only letters, digits, `.`, `_` and `-`.

Over SSH, the push uses the key SSH picks for the remote, not the account `gh` signs in as. Point the project's remote at an SSH alias whose key belongs to the project's account (`git@github-myaccount:owner/repo.git`), or at its `https://` URL so `gh` signs the push.

To allow it, open the project's window: under **Integrations**, the **Contributors' conflicts** row says what the project does; **Configure** lets you choose **Let Timon resolve them**. The row appears for a project that lands its jobs through pull requests on GitHub. Only a signed-in person can turn it on; an agent or the daemon's token cannot. While it is on, the same goes for the project's remote URL, account, `gh` folder, remote name and landing mode: they decide where the push goes and as whom. Each change of this choice and of those fields is recorded in the audit log, with who made it, so a remote changed while the project was back to asking contributors shows there before you turn it on again. A push to the contributor's branch re-runs their checks on GitHub, and removes a `protected-paths-approved` label your repository may use: put it back after reading the change.

## Jobs

**Jobs** lists the Kanban jobs that land through a pull request, and the jobs [kept on their branch](pull-requests.md#land-a-branch-you-kept) in any project, in five groups:

| Group | Jobs in it |
|---|---|
| **Needs action** | a check fails, the branch conflicts with its target, a reviewer asked for changes, or the pull request was closed without being merged (for a week) |
| **In review** | the pull request is open and nothing is wrong with it |
| **In progress** | the job's branch is not pushed yet |
| **Kept on a branch** | the job was planned to stay on its branch: it waits for you to land it |
| **Landed · 7 days** | the pull request was merged in the last seven days |

Each row gives the job's title (its pull request's, or its branch until there is one), its branch, and where it stands: **Not pushed**, **PR #n**, **Merged**, **Landed** once Timon has closed the job's tasks and ideas, or **Closed**. While the pull request is open, the row also shows the failing or running checks (or how many passed when none fails), a conflict, a draft and an approval or a request for changes.

A kept job reads **Kept on feat/…**, with the job's first TO DO idea as its title, how many of its ideas still wait for the landing, and when a task was last merged into the branch (its commit in the tooltip; the row is read again every minute while a kept job is listed). Its button lands it after a short confirmation that says how many commits will land: **Merge into main** in a project that merges locally (**Merge feat/… into main?**); **Open the PR** in a project that lands through pull requests, under a title made from the branch name (`feat/add-csv-export` gives "Add csv export"), shown in the confirmation. To write the title yourself first, choose **Preview** in the row's menu: the job's window holds the same gesture at its foot, with the title to edit. When the job's pull request was closed without being merged, the row stays in **Needs action** and its button reads **Open a new PR**: it opens a new pull request under the closed one's title. It is greyed, with the reason in its tooltip, when your account cannot manage projects or while a task of the job still runs. When Timon refuses, a message says why: a conflict lists its files, a target branch checked out with uncommitted changes asks you to commit or stash them first. Once landed, the row moves to **Landed** and the job's ideas close.

The row's button is otherwise the repair the pull request calls for, when one may start (below); otherwise **Preview** while the job has something to land, and **Open the pull request** once it is merged or closed. Its menu (**…**) holds the other repairs the pull request calls for, **Preview** or **Open the pull request**, **Show the TO DO (#n)** for each idea the job carries, **Open the job** for the conversation of the mission that pilots it, and **Refresh the checks**. A row marked **to approve** has a comment waiting for you in [Publish on GitHub](#publish-on-github): click the mark to read it. In an agent's chat the widget lists the jobs of the conversation's project; elsewhere, the project picked for **Pull requests**, or every project.

The list is read again each time its tab comes to the front. Inside the stack, **Refresh** sits in the widget's menu (the gear, or a right click on the tabs); a **Jobs** card on its own keeps it in its header.

Timon reads the checks from GitHub when the widget appears, then about once a minute while a check is still running and the page is visible. The background poller that notices a merged pull request keeps its own five-minute pace.

**Preview** opens what the job's pull request carries, before anything is pushed, with a link to the pull request on GitHub once it exists:

- **Changes**: every file the branch changes against the target as it was last fetched, with its added and removed lines. Very large diffs are cut, and the preview says so.
- **Commits**: the commits of the branch that the target does not have.
- **Pre-checks**: the checks of `timon pr open`, run without pushing, fetching or opening anything, with the result of each. The public tree check runs a script of the repository, so it waits for the actual opening, as does the check of a title the preview does not have yet. Running the pre-checks needs the permission to manage projects, as opening the pull request does.

The preview also says whether the branch would merge into the target without a conflict. Beside it, **Links** shows where the job comes from and where it leads:

- **TO DO**: the ideas the job carries; click one to open it.
- **Issue**: the GitHub issues of those ideas, and the issues the pull request's description says it closes, marked **closes** (that is its author's statement, not Timon's).
- **Job**: **Open the mission**, the conversation of the mission that pilots the job.
- **Branch**: the job's branch and the branch it lands into.

You only see the ideas and the mission you may open.

While the pull request is open, **Checks** lists its checks as last read from GitHub, failures first (click a status to open the check on GitHub), and how many repairs the job used. The foot of the window has **Refresh**, which reads the checks again, and the repair the pull request calls for.

### Repairing a job's pull request

When a job's pull request needs work, Timon can hand it back to the job's agent, on your click only. The row's button, and the button at the foot of the job's window, is the repair the pull request calls for:

| Button | When | What the agent gets |
|---|---|---|
| **Resolve the conflict** | the branch conflicts with its target | the files in conflict; it merges the target into the branch, never rebases |
| **Fix the checks** | a check fails | the names of the failing checks and the end of their logs |
| **Address the comments** | a reviewer asked for changes, or review threads are still open | the open review threads, the text of the latest reviews and the review's decision |

A conflict comes first: GitHub does not run the checks of a branch that does not merge. The other repairs wait in the row's menu.

Timon reads the pull request again before it starts anything, and refuses when there is nothing of that kind left to fix. The repair is a Kanban task on the job's branch, for the job's agent and model, followed by the usual review. Whatever GitHub writes (logs, comments, file names) reaches the agent as data, never as instructions. The agent never pushes and never writes on GitHub: once the repair is reviewed and merged into the job's branch, Timon pushes the branch to the pull request itself, with the same checks as when it opened it, and a notification says whether it pushed, found nothing new, or could not push.

One repair runs at a time: the row shows **Repair 1/3** with a turning icon until it ends. A job gets three repairs, whatever became of them; the row then shows **Repairs 3/3**, and the job's window offers **Take over by hand**, which opens the pull request on GitHub. Asking for a repair takes a signed-in person allowed to manage projects; an agent cannot ask for one.

## From the TO DO notebook

An idea whose job lands through a pull request shows where it stands, beside its progress, on its line in the TO DO widgets, its Kanban card and its detail:

| Badge | Meaning |
| --- | --- |
| **PR not created** | the job has its integration branch, its pull request is not open yet |
| **PR #12** | the pull request is open |
| **PR #12 merged** | the pull request was merged: the work landed in the target branch |
| **PR #12 closed** | the pull request was closed without a merge: nothing landed |
| **Branch** | an embargoed branch (`sec/<topic>`), which lands by hand without a pull request |

Click the badge to open the job's preview, the same as from **Jobs**, with its links and the link to its pull request. The progress says how far the work went; this badge says how far its branch went. When the idea has several jobs, the badge shows the one furthest from landing (a closed pull request first, then one not created, a branch, an open one, a merged one), opens that one, and its tooltip lists them all. The TO DO widgets filter on **PR open** and **PR not created**.

An idea linked to a GitHub issue shows the issue's number (**#212**) among its badges; click it to open the issue on GitHub. When a publication waits for you on that issue, or on the pull request of one of the idea's jobs, the idea also shows **to approve**: click it to open [Publish on GitHub](#publish-on-github) over the page. An idea a connector wrote, from an issue or a message, is marked **external**: its text was written outside Timon, and Timon hands it to agents as data to read, never as instructions.

## GitHub issues

The built-in **GitHub issues** plugin brings an issue of the project's repository into the TO DO notebook, on your click. It lists the open issues that carry the project's label (`accepted` unless you set another one) and imports the one you pick as an idea: its text is the issue's title, its notes keep the issue's description, and it links to the issue (**#212**, marked **external**). Nothing is imported on its own, an issue is imported once only (importing it again opens the same idea), and nothing is written on GitHub. It reads the repository with the project's account, and needs you to be signed in with the **Create, update and delete projects** permission.

The issue's title and description were written by someone outside the project: the idea's notes keep them in a block marked as outside data, and a task promoted from the idea hands them to its agent as data to read, never as instructions.

Once the idea has a job, its pull request closes the issue for you (below); you never close it by hand. When a contributor's pull request closes the issue instead, the idea is done once GitHub says that pull request is merged and closed the issue as completed.

### The Issues tab

Each row is an issue: its title, then its number, its author and its label. The issues you have not imported come first. One button imports the issue as an idea; once imported, the row shows **TO DO** (and **PR #51** when the idea's job has a pull request), and the same button opens the idea. The row's menu (**…**) has **Import and plan…**, **Read the text**, **Open on GitHub**, **Copy the link** and **Do not suggest again**, which hides the issue from the list. **Import and plan…** imports the issue, then opens its idea: **Send back to the orchestrator** there hands it to the orchestrator, which plans it with you. The list is read again on its own when an imported idea is done, resolved or deleted elsewhere.

Under the list, **2 hidden issues** counts the issues you asked not to suggest again; **Review** lists them, with the title they had, and the eye button shows one again. The number on the tab (**Issues 2**) is how many issues are left to import, and **Refresh** sits in the widget's menu (the gear, or a right click on the tabs); an **Issues** card on its own shows both in its header.

**Read the text** opens the **Issue** window: the issue's description as written on GitHub, shown as plain text and marked as outside data, cut at 4,000 characters as the idea will keep it, with the project and the link the idea will keep. **Import as TO DO** imports it, **Import and plan…** imports it and opens its idea; a closed issue cannot be imported.

**+** imports an issue that does not carry the label: type its number (`212` or `#212`) or paste its GitHub link. The Issue window reads it first, then you import it. A link to another repository than the project's is refused.

### The project's label

The project's window (**Edit** on its card) lists **GitHub issues** under **Integrations**: the label the tab lists and how many issues are left to import. **Configure** changes the label for this project. The menu (**…**) has **Switch off for this project** (the tab then lists nothing and reads nothing on GitHub, until **Switch on**, there or in the tab), **Review hidden issues** and, for a label of its own, the way back to the plugin's label (`accepted`, set in the plugin's settings). Only a project that opens pull requests on GitHub has this row.

### The issue, the pull request and the comment

When a job's pull request is opened, Timon adds one line per GitHub issue of the job's ideas at the end of its description. The list comes from the ideas' links, never from what the agent or the issue wrote:

- `Fixes owner/repo#212` when the idea is carried by this job only. GitHub closes the issue when you merge the pull request.
- `Refs owner/repo#212` when other jobs work on the same idea: this one alone does not resolve it. Tick **Resolves its issues entirely** under **Advanced** in the Kanban planner to get `Fixes` anyway; folded, **Advanced** then reads **resolves its issues** beside the branch.

A `Fixes #n` or `Closes #n` the agent wrote in the description becomes `Refs #n`: only the ideas' links close issues.

Once the pull request is merged, Timon prepares a comment for each issue it fixed: "This is fixed by #51, now merged into `main`.", followed by the idea's public note when it has one (mentions are shown as text, so nobody is notified by surprise). A public note you write after the merge still reaches the comment, as long as you have not edited it. The comment waits for you in [Publish on GitHub](#publish-on-github), with a notification: read it, edit it, publish it or don't. An issue the job only mentions (`Refs`) gets no comment.

### An issue you decline

When you give an imported idea the outcome **Declined**, **Duplicate** or **Needs info**, Timon prepares an answer for its issue: a short thank-you that says what was decided, followed by the idea's public note (mentions shown as text). For **Declined** and **Duplicate**, it also prepares closing the issue, as not planned or as a duplicate. The two wait apart in [Publish on GitHub](#publish-on-github): you may answer and leave the issue open. Nothing is posted or closed before you publish it.

## Publish on GitHub

Timon writes on GitHub only through one window, **Publish on GitHub**, and only when you click **Publish** in it. An agent never publishes there. The window opens from a row marked **to approve** in **Jobs**, **Pull requests** or the TO DO notebook, from the notification card of a write waiting for you, or from a gesture of a pull request's menu: **Propose a comment…**, **Ask the contributor**, **Update the branch**, or **Propose the publication** at the end of a conflict's resolution.

On the left, the exact text that would be posted, and whether it goes on an issue or a pull request (it is public). **Edit** lets you change it and **Save** keeps your version; a draft Timon prepared says so under the text, and a comment a plugin proposed names the plugin and asks you to read every word, since a plugin, not Timon, wrote it. On the right, what would leave: where it goes, the GitHub account it would be posted as (the account set on the project), what prepared it, and the fact that it is posted once only, even if you click twice.

- **Publish** posts the text as it stands. Timon first checks that `gh` is signed in as the project's account and refuses otherwise, without posting anything. If GitHub refuses, the window stays open with the reason, and you can try again.
- **Do not publish** closes the proposal: nothing is posted, and its notification goes away.

A branch update has no text to edit: the window shows the branch GitHub updates, the base it merges in and the head it expects, and its main button reads **Update the branch**. Closing an issue has no text either: the window says why it closes and that it posts no comment; **Close the issue** closes it (an issue already closed is left as it is), **Leave it open** drops the proposal. A conflict's push shows the commit and the contributor's branch above the comment that follows it; its main button reads **Push and comment**, and **Do not push** drops it.

Without an account set on the project, **Publish** stays off. Proposing, editing and discarding need you to be signed in with the **Create, update and delete projects** permission; publishing needs the **Publish proposed writes on GitHub** permission, which an administrator grants in a role, so that managing projects does not by itself let an account speak for the project's GitHub account. A role holding every permission (`*`) holds it too, unless the role denies it explicitly. Without it, **Publish** is greyed and its tooltip names the permission. Publishing needs you signed in to this Timon itself: a [paired device](connected-devices.md) cannot publish, even for an administrator's account. An agent or the daemon's token can do none of these. A plugin holding `forge:propose` may propose a comment ([The GitHub repository of a project](../plugins/forge.md)), never edit or publish one: it waits here for you like any other.

## Who may change a repository

Anyone signed in can read a project's branches, graph and publication state. Everything that changes the repository or what is published needs the **Create, update and delete projects** permission: switching or deleting a branch, pushing, fetching, creating the repository on GitHub, and editing the remotes. Without it, these buttons are greyed out and say which permission to ask an administrator for, in the Git widgets, the branch menu above the message box and the project cards. An agent acts with the rights of the account that launched it.

## Related pages

- [Projects](projects.md) — how a project's folder and worktrees are organised.
- [Kanban](kanban.md) — coding tasks run in worktrees of their own.
- [Land a job through a pull request](pull-requests.md) — set a project to open pull requests, and what Timon checks before it pushes.
- [Built-in terminal](terminal.md) — for the Git commands the widget does not cover.
