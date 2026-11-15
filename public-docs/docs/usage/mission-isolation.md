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

## What the fence does

Inside the fence, a mission:

- cannot read or change Timon's private files: tokens and keys, the database, the configuration file, licences, browser profiles, the accounts of other backends, and the folders of other agents and missions. It keeps what it needs: its working folder and its repository, its own agent's memory, the skills, and its own temporary folder;
- cannot read your SSH and GPG keys, your AWS and Google Cloud credentials, or the sign-in of the other coding CLIs: only the backend it runs on is visible to it;
- can read the rest of your home folder, but not write it, except a few folders you add yourself (see [Exceptions](#exceptions)). A mission therefore cannot change your shell profile, your git settings or the programs your account runs at sign-in;
- cannot open Unix sockets: Docker, `ssh-agent` (so no `git push` over SSH from a mission), the desktop session bus and the display server are out of its reach, because each of them would run what the mission asks for outside the fence. On Linux the session bus is also the way to the system keychain, so a CLI that keeps its sign-in only there finds none in a mission: Antigravity is signed in with a command that saves its sign-in in its own folder instead ([Antigravity](antigravity.md#set-it-up)). An exception opens them for one agent or project;
- keeps the network: the internet, your local network and Timon's own interface, where it acts with the permissions of the account that started it.

Codex and Claude Code have sandboxes of their own, which cannot run inside another one. In a fenced mission, Timon turns them off and the fence takes over: for Codex, it applies the permission level you chose, so a read-only mission cannot write its working folder either. Full access does not open your home folder for writing.

## What it does not cover

The fence protects Timon and your computer from a mission. It does not make what the mission writes safe to run:

- **Code planted in your projects.** A mission writes its working folder, and a task that works in a separate copy of the repository can also write the project's main folder, as a merge does. It can change scripts, build outputs or files you will run later, outside Timon. Read the changes before you run them.
- **The configuration folder of the backend it uses.** If missions share the backend account you use yourself in a terminal, a mission can change settings that the CLI applies the next time you start it. Give missions their own backend accounts ([Subscription accounts](subscription-accounts.md)).
- **Missions of the same agent.** They share the agent's package cache (below): a mission can leave a package there that a later mission of the same agent runs. Other agents are not affected.
- **Shared temporary folders.** `/tmp` on Linux and macOS, and the per-user temporary folder of macOS, stay readable and writable by missions, as by any program. Keep nothing secret there.
- **macOS system services.** The fence covers files and sockets, not the services macOS offers to every program of your session. In particular, a mission can still ask your login keychain for an item it holds, as any program you run can.

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

A write that the fence refuses shows up as an error in the mission ("permission denied"). If a tool you trust needs a folder of your home, add it as writable for its agent.

## Package caches

Inside the fence your home folder is read-only, including the caches of npm and the other package managers. A fenced mission's package managers therefore use a cache that belongs to its agent, inside Timon's data folder: the first `npx -y` MCP server an agent starts downloads its package once, and later missions of that agent reuse it. Missions of other agents can neither read nor write it, and your own cache is never written. Deleting or renaming the agent removes it.

Covered: `npx`, `pnpm dlx` and `uvx`. Not covered: `yarn dlx`, `bunx`, Deno's `npm:` packages, and the Python versions uv would have to download. They can fail inside the fence; adding their cache folder as writable for that agent is the way around it.

## Windows, and Linux without Landlock

There, missions run with your full account, as before: a mission can read Timon's private files, including the operator token and the vault key. On a computer only you use, that matches what a CLI started in your own terminal can do. On an installation with several accounts, it means anyone who may start missions can reach more than their permissions allow: set the mode to **Required**, so that such a computer refuses missions, or give the **Spawn missions** permission only to people you would trust with the whole installation. Separating people for real then takes separate operating-system accounts, or separate computers.
