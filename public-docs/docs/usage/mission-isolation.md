---
title: Mission isolation
---

A mission is a coding CLI that Timon starts on your computer, under your own operating-system account. Without anything more, it could read every file you can read, including Timon's own data folder: the operator token, the key of the secrets vault, the database. Where the operating system allows it, Timon therefore starts each mission inside a **fence** that the operating system itself enforces, around the CLI and every program it starts.

## What each system gets

| System | Missions are fenced | What it means |
| --- | --- | --- |
| Linux, kernel 6.12 or later, with Landlock | Yes | Full fence. |
| Linux, kernel 5.19 to 6.11, with Landlock | Yes, partly | Full fence, except that a mission can send signals to your other programs (stop them, for example). From 5.19 to 6.1, it can also empty a file it cannot read: it cannot read the content, but it can destroy it. |
| macOS | Yes | Full fence, except the system services listed below. |
| Linux without Landlock (kernel older than 5.19, or Landlock turned off in the kernel) | No | A mission can read Timon's private files. |
| Windows | No | A mission can read Timon's private files. |

Most current Linux distributions ship a kernel with Landlock turned on. `timon doctor` and **Settings › System › Security** say which case applies to your computer, and why when missions are not fenced.

On Linux, the fence is applied by a small launcher that ships with Timon and runs on any 64-bit x86 or ARM processor. If `timon doctor` or the Security tab says the fence launcher **is not compatible with this processor**, your Timon version shipped a launcher built for newer processors (some packages needed AVX2): the package is not damaged, and reinstalling the same version changes nothing. Update Timon. Until then, missions follow the mode: **Automatic** starts them unfenced, **Required** refuses them.

## What the fence does

Inside the fence, a mission:

- cannot read or change Timon's private files: tokens and keys, the database, the configuration file, licences, browser profiles, the accounts of other backends, and the folders of other agents and missions. It keeps what it needs: its working folder and its repository, its own agent's memory, the skills, and its own temporary folder. In the desktop app, it can also read and run the files of the Timon version that is running, which start Timon's tools in the mission, but never change them;
- cannot read your SSH and GPG keys, your AWS and Google Cloud credentials, or the sign-in of the other coding CLIs: only the backend it runs on is visible to it;
- can read the rest of your home folder, but not write it, except a few folders you add yourself (see [Exceptions](#exceptions)). A mission therefore cannot change your shell profile, your git settings or the programs your account runs at sign-in;
- cannot open Unix sockets: Docker, `ssh-agent` (so no `git push` over SSH from a mission), the desktop session bus and the display server are out of its reach, because each of them would run what the mission asks for outside the fence. On Linux the session bus is also the way to the system keychain, so a CLI that keeps its sign-in only there finds none in a mission: Antigravity is signed in with a command that saves its sign-in in its own folder instead ([Antigravity](antigravity.md#set-it-up)). Hermes reaches its own background process through one, so it does not answer in a fenced mission ([Hermes](hermes.md#limitations)). An exception opens them for one agent or project;
- keeps the network: the internet, your local network and Timon's own interface, where it acts with the permissions of the account that started it.

A mission whose agent has the **orchestrator** (lead) or **merger** role, or that runs a **merge** task, also reaches what integrating the project's work needs: the working folders of that project's tasks (`~/.timon/worktrees/<task>`) and the common `.git` folder of the project's repository (objects, references, `worktrees`, configuration), for reading and writing, so `git push`, `fetch`, `merge` and `update-ref` work from those folders. The role is the one set on the agent, never guessed from its name: an agent called "merge-helper" with another role gets none of it. Other projects' folders stay closed, and so do those of a coder or a reviewer.

The project's own main folder (the reference checkout) is not opened for writing by this grant, only its `.git` folder. From a lead or merge mission, `git fetch`, `git push` and moving a branch by reference (`git push . <branch>:<base>`) therefore work, but a `git merge` or `git checkout` that rewrites the files of that checkout does not: integrate in a task folder and move the base by reference, then update the checkout yourself, or give the agent that folder as an [extra folder](#an-agents-extra-folders).

The list of those folders is made when the mission starts, because Landlock cannot add a rule to a running process. A task folder created after that is covered from the next start: the next turn of a tool that starts anew each turn, otherwise the next mission. Timon keeps every task folder directly in `~/.timon/worktrees` rather than in one folder per project, as it would take to cover future ones, because the cleanup, the series and the paths already saved on tasks all rely on that layout.

When `workspacesRoot` is not set, the agents created during setup without a project folder work in `~/.timon/workspace/home`, and the demo project lives in `~/.timon/workspace/timon-demo`. A mission never receives the `~/.timon/workspace` folder itself, which holds the other agents' folders, with one exception: an agent whose working folder is exactly that folder, as setup made it up to version 0.1.8, keeps it, for reading and writing. Its missions then also reach the other folders in it, and the daemon log says so once for each such agent. Give that agent a project folder, or a folder inside `~/.timon/workspace`, to fence it more tightly.

Codex and Claude Code have sandboxes of their own, which cannot run inside another one. In a fenced mission, Timon turns them off and the fence takes over: for Codex, it applies the permission level you chose, so a read-only mission cannot write its working folder either. Full access does not open your home folder for writing.

## What it does not cover

The fence protects Timon and your computer from a mission. It does not make what the mission writes safe to run:

- **Code planted in your projects.** A mission writes its working folder, and a task that works in a separate copy of the repository can also write the project's main folder, as a merge does. It can change scripts, build outputs or files you will run later, outside Timon. Read the changes before you run them.
- **The configuration folder of the backend it uses.** If missions share the backend account you use yourself in a terminal, a mission can change settings that the CLI applies the next time you start it. Give missions their own backend accounts ([Subscription accounts](subscription-accounts.md)).
- **Missions of the same agent.** They share the agent's package cache (below): a mission can leave a package there that a later mission of the same agent runs. Other agents are not affected.
- **Shared temporary folders.** `/tmp` on Linux and macOS, and the per-user temporary folder of macOS, stay readable and writable by missions, as by any program. Keep nothing secret there.
- **macOS system services.** The fence covers files and sockets, not the services macOS offers to every program of your session. In particular, a mission can still ask your login keychain for an item it holds, as any program you run can. It cannot add, change or delete an item, though: a command-line tool that saves its sign-in only there cannot renew it from a mission. For Claude subscription accounts, Timon moves the sign-in into the account's own folder before the mission starts ([Subscription accounts](subscription-accounts.md#sign-in)). A Claude sign-in made in Timon (**Sign in** on the Claude page, see [Settings](settings.md)) is moved the same way. The sign-in of Claude Code in your terminal stays in the keychain: if it says *OAuth token revoked* after missions ran, give Timon a long-lived token (**Settings › AI models › Providers › Claude**, row **Long-lived token**, **Create**), which missions use without renewing anything.

## Choosing the mode

**Settings › System › Security** (superadmin only) shows whether the protection is active, and sets the **Mode**:

- **Automatic**, the default: missions are fenced where this computer can do it. Elsewhere they start anyway, and the tab and `timon doctor` warn that they are not fenced.
- **Required**: Timon refuses to start a mission it cannot fence. The chat says why, and a Kanban task is blocked with the same reason.
- **Off**: missions are never fenced. Timon asks you to confirm.

The same setting is `host.isolation.filesystem` in `timon.config.json` (`auto`, `enforce` or `off`, see the [configuration reference](../installation/config-reference.md)). On an installation with [several accounts](multi-user.md), choose **Required**: in Automatic mode, a computer that cannot fence missions still runs them, and account permissions then do not hold against a mission.

## Exceptions

Some work needs more than the fence allows: a mission that builds Docker images, or pushes over SSH, or a tool that writes a folder of your home. Under **Exceptions**, **Manage** lets you allow Unix sockets, or add writable folders, for one agent or one project. An agent's exception wins over its project's. In the configuration file:

```json
{
  "host": {
    "isolation": {
      "filesystem": "enforce",
      "writable": ["~/.cache/my-tool"],
      "exceptions": {
        "agents": { "deployer": { "unixSockets": "allow" } },
        "projects": { "website": { "writable": ["~/.cache/site-builder"] } }
      }
    }
  }
}
```

Every exception widens what a mission can do: allowing Unix sockets lets that mission run commands outside the fence through Docker or the session bus. `timon doctor` lists each opening in force. Prefer an exception for one agent to a setting for every mission.

Every object of the `host.isolation` block is strict: a key Timon does not know, or a misspelt one (`writeable`, `unixSocket`), makes the configuration invalid, and the daemon refuses to start rather than run missions with a fence other than the one you wrote. `timon doctor` prints the error with the key at fault, as does the daemon log ([Configuration](../installation/configuration.md)).

A write that the fence refuses shows up as an error in the mission ("permission denied"). If a tool you trust needs a folder of your home, add it as writable for its agent. An exception on a folder that does not exist yet opens nothing: create the folder first. The daemon log and `timon doctor` name such an exception.

## When the fence refuses a path

When the fence keeps a mission from a path its command-line tool needs, the chat says so in a notice that names the fence (Landlock, or the macOS sandbox), the path, and whether it was a read or a write:

- **Before the mission starts.** Timon checks every path inside its data folder that it hands the tool (its settings, its instructions, its own folders). If the fence would refuse one, the mission is not started, rather than failing the same way turn after turn. A Kanban task is blocked with the same sentence, for you to retry once it is solved.
- **When a turn fails.** If the tool's error names a path the fence refuses while your account could reach it, the notice names it too, as does the last error of a Kanban task. A backend set aside after such failures says the fence was the cause, instead of an unknown one.
- **During a turn that goes on.** A command of the agent that meets the fence in the middle of a turn gets the same notice, even when the agent carries on with something else. A mission shows at most five of them, so that a tool walking through your home does not bury the conversation.
- **When the tool names no path.** Some tools stop on "Operation not permitted" without saying which file (Codex: `os error 1`). Timon cannot check such a refusal against the fence, so the notice quotes the tool, says the fence may be the cause, and points to the agent's extra folders and to **Settings → System → Security**. It is shown once per mission.

What to do depends on the path:

- **A path inside Timon's data folder**: extra folders cannot open it, so it is a defect of Timon. Please report it. If it is the folder of a task of the project and the mission is a lead or a merge, start the mission again: the folder was probably made after it started. Setting the **Mode** to **Off** also lets missions run, but only as a last resort, because it removes the protection for everything.
- **A folder of your home**: the chat offers it in a card instead of a notice, described below. You can also add it to the agent's [extra folders](#an-agents-extra-folders), or as writable for the agent under **Exceptions**. Either applies from the next mission: the fence of a running mission does not change.
- **A credential folder** (`~/.ssh`, other tools' sign-ins, or a path of `host.isolation.deny`): the fence always keeps it from missions, and no exception opens it.

### Allow a folder from the chat

When the refused path is one an agent may be given, the chat shows a card instead of the notice: the path, whether it was a read or a write, and the folder Timon offers to open, with **Allow for this agent**, **Allow for the project** when the agent belongs to a project, and **Refuse**.

- **Allow for this agent** adds the folder to the agent's [extra folders](#an-agents-extra-folders), read-only or read-write as the refusal needed, then starts the mission again: since the fence of a running mission cannot change, Timon stops its process and sends it a message that resumes the same conversation with the folder open. The folder stays open for the agent's next missions; remove it from the **Workspace** tab of the agent's page.
- **Allow for the project** adds the folder to the [project's extra folders](#a-projects-extra-folders) instead, so every agent of the project gets it, then starts the mission again the same way. Remove it from the project's settings, under **Agent folders**.
- **Refuse** closes the card and changes nothing.

When the refusal stopped a Kanban task before its mission started, allowing puts the task back in the queue: it starts again with the folder open, as if you had retried it from the board.

The folder offered is the refused folder itself, or the folder of a refused file. Timon offers no card for its own data folder, a credential folder, a path of `host.isolation.deny`, a whole home folder or the root of a disk: those keep the notice above. Only a person signed in to the app can answer the card; an agent, a script or the `timon` command cannot. Allowing takes the same rights as changing the agent's extra folders on its page, or the project's in its settings.

`timon doctor` checks each active backend against this computer's fence: for each one, it prepares the command line a mission of that backend would get, without running it, and has the fence open every path of Timon's data folder that command names, the folders a mission of that backend uses, and the private files of Timon a mission must never read, under the policy such a mission gets. A line marked ✗ names the path and whether the policy or the kernel refused it. When the command line cannot be prepared (a backend you are not signed in to), the line says so and only the folders the fence grants are checked. Nothing it prepares is left in Timon's data folder.

## An agent's extra folders

An agent can be given folders outside its working folder, in its **Workspace** tab under **Extra folders** (see [Agents](./agents.md#extra-folders)). The fence opens each one at the access you chose: **Read and write**, or **Read only**, which stays read-only even when the folder sits inside a folder the mission may write, so a mission cannot change it. The AI CLI is told as well: Claude Code gets the folders with `--add-dir` and refuses edits in a read-only one, GitHub Copilot gets the read and write ones with `--add-dir` (a read-only one only in **Plan** mode, since Copilot has no rule that keeps a single folder read-only), Codex gets the writable ones in its sandbox.

These folders never open what the fence protects: Timon's own folder, a folder that contains it, a whole home folder or disk, and folders of credentials are refused when you add them, and checked again at every mission, since the agent's file can be edited by hand; a folder that no longer passes is left out, and the agent's page says so. A mission cannot give its own agent a folder. The fence is set when a mission starts: a mission already running keeps the folders it started with.

## A project's extra folders

A folder several agents of one project need, a second repository or a shared data folder, can be given to the whole project instead of to each agent: in the project's settings, **Agent folders**, **Manage**, then **Add a folder** with **Whole project** chosen. The row is there even before the project has an agent, so a folder can be prepared first. Every mission of the project's agents gets it, beside its agent's own folders; when both name the same folder, the wider access wins. The same checks apply as for an agent's folders, and only a person signed in to the app can change the list: an agent, a script or the `timon` command cannot. Changing it takes the right to manage projects and the right to change privileged agent settings.

Without a fence (Windows, or **Off**), a read-only folder is only a request to the AI CLI: Claude Code is not given it at all, so an edit there stays a question for you, and nothing stops a shell command from writing in it.

## Package caches

Inside the fence your home folder is read-only, including the caches of npm and the other package managers. A fenced mission's package managers therefore use a cache that belongs to its agent, inside Timon's data folder: the first `npx -y` MCP server an agent starts downloads its package once, and later missions of that agent reuse it. Missions of other agents can neither read nor write it, and your own cache is never written. Deleting or renaming the agent removes it.

opencode keeps its own cache and state in a folder of Timon's data folder too, one per opencode profile ([opencode](opencode.md#where-missions-keep-opencodes-cache)).

Covered: `npx`, `pnpm dlx` and `uvx`. Not covered: `yarn dlx`, `bunx`, Deno's `npm:` packages, and the Python versions uv would have to download. They can fail inside the fence; adding their cache folder as writable for that agent is the way around it.

## Windows, and Linux without Landlock

There, missions run with your full account, as before: a mission can read Timon's private files, including the operator token and the vault key. On a computer only you use, that matches what a CLI started in your own terminal can do. On an installation with several accounts, it means anyone who may start missions can reach more than their permissions allow: set the mode to **Required**, so that such a computer refuses missions, or give the **Spawn missions** permission only to people you would trust with the whole installation. Separating people for real then takes separate operating-system accounts, or separate computers.
