---
title: Projects
sidebar_position: 5
---

A project associates a working directory with its agents and default roles. Use it to keep work aimed at the right repository and to give coding, review and coordination tasks suitable workers.

1. Register the project from the project controls and choose its existing directory.
2. Associate agents with it, using paths on the **daemon host**.
3. Set the agent, backend/model and permission defaults for each role you use.
4. Create a small task and check that its assignee and working directory match the project.

Use **Browse…** beside the working directory when creating or editing a
project to choose a folder on the machine running Timon. In the desktop app on
this computer it opens your system's folder picker; connected to another
machine, or in a web browser, it lists the folders of that machine instead
(**Hidden folders** shows the ones starting with a dot). Cancelling keeps the
current path. You can always type the path directly.

If Timon cannot use the working directory, the project card says why instead of showing "no working directory": **folder not found** (the path does not exist on the computer running Timon), **access denied** with the system error code (on macOS, check System Settings › Privacy & Security for folders such as Documents or Desktop), or **not a folder**. The registered path is shown next to the reason. As the owner you may still save a path that does not exist yet; Timon warns you when you do.

Inspect project configuration from the CLI:

```bash
timon project list
timon project roles PROJECT_SLUG
```

To assign an existing agent to a role:

```bash
timon project set-role PROJECT_SLUG code PROJECT_AGENT
```

To register or edit a project from the terminal, and to see the workspaces (poles) it can belong to:

```bash
timon workspace list
timon project create acme-app --name "Acme" --cwd /srv/acme --workspace "Design Studio"
timon project update acme-app --speech "Customer portal"
```

The directory must already exist on the machine. A workspace you name must exist too; add `--create-workspace` to create it. An empty value (`--speech ""`) clears a field.

## How a branch is integrated

By default, a finished coding branch is merged locally into its base. To push the branch and merge it on GitHub instead:

```bash
timon project update acme-app --integration pull-request
timon project update acme-app --integration pull-request --merge-strategy rebase
```

`--merge-strategy` accepts `squash` (the default), `merge`, or `rebase`. Any other value is refused, as is any integration value other than `local` or `pull-request`. `--integration local` restores the local merge. An empty value clears the setting back to that default.

In `pull-request` mode, the mode itself authorises the push. A coding task pushes its branch and opens or updates one pull request against the base. When the base is a branch that already has an open pull request, the task pushes onto that branch and does not open a second pull request. The merge task resolves `<owner/name>` before it removes a worktree, and passes `--repo <owner/name>` on every `gh` command so the forge is still known after that checkout is gone. It waits for checks with `gh pr checks <n> --watch --fail-fast` (or a bounded loop of at most 30 minutes) and blocks only when a check fails, the pull request cannot be merged, or the wait runs out. It removes the worktree whose branch is the pull request head, not whichever task produced the latest commit. It then runs `gh pr merge`. It does not fast-forward the base and it does not push the base. The forge command is a single line, so a later forge can replace it. GitHub, through the `gh` command, is the forge this mode ships with.

If `gh pr merge` only queues the pull request, the task waits until `gh pr view` reports `MERGED`, at most 30 minutes, and then records `mergeCommit`. Past that wait it blocks with the reason `merge queue wait exceeded 30 minutes`. A non-zero `gh pr merge` that still has a merge commit is a merged pull request whose local branch could not be deleted: the task closes done with that sha. A `code-self` task runs those commands from its own worktree, records the merge commit, and removes the worktree only after it has closed: that worktree is the directory it is running in.

`code-group` is not supported in this mode. Each coding task would open its own pull request, and the merge brief only knows how to merge one; ordering those pull requests and resolving conflicts between them is not specified. A `code-group` task is told to block, with the reason `code-group is not supported in pull-request mode`, and not to push. Use `local` integration, or the `full` pipeline, for a group.

Worktrees are still created and refreshed from the local base branch. This mode does not move that branch, so a later task can start from a base that is behind the forge and its pull request then conflicts. How the local base should follow the forge — a fetch and a fast-forward when the base is not checked out, or worktrees created from `origin/<base>` — is an open question for the maintainers. This version does not change that worktree behaviour.

The project role is the normal default for a task; task-specific overrides are useful for exceptions. A project path is not a container path unless the daemon actually executes inside that container.

## Docker containers

When a project's directory runs a Docker Compose stack, the project card and the chat's **Docker** widget show its containers, their local address, and **Start**, **Stop**, **Restart** and **Rebuild** buttons, for the whole stack or one container.

**Start** restarts the existing containers as they were created. If they were created on a Docker network that has since been deleted or renamed (moving a reverse proxy from `traefik_network` to `proxy_net`, for instance), Timon recreates them with `docker compose up -d` on the networks of the current Compose file. If that fails too, the error names the missing network: fix the networks declared in the Compose file, then click **Rebuild**.

## Deleting a project

Open the project's edit window and use **Delete** in the danger zone. If the project still has agents, Timon asks what to do with them:

- **Move them to another project**: they keep their names and memory and join the project you pick. An agent that worked in the old project's folder now works in the new project's folder.
- **Detach them**: they stay, with no project.
- **Delete them**: their identity and memory are erased. This cannot be undone.

The project's folder under your Timon home is removed with the project; your own working directory is never touched.

## Git isolation

A coding task's worktree has its own branch and files. The final merge integrates that branch into the chosen base. Check the task's worktree information before editing or integrating: sharing a project does not mean sharing one working directory.

Databases, credentials and services outside the repository remain shared. Coordinate changes to those resources separately from Git changes.

The chat's [Git widget](git.md) shows a project's branches, its commit graph with every worktree, and its remotes.
