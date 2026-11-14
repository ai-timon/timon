---
title: Requirements
sidebar_position: 2
---

## Before you begin

- **Node.js 22 or newer**, with npm, for a source installation and development tooling. Desktop packages include their own Node.js 22, which runs the background service, its web app and the `timon` command: the Node.js installed on your machine, if any, is never used by them.
- **Operating system for the desktop app**: Windows 10 or later (x64), macOS 11 or later (Apple silicon), Linux x64 with glibc 2.28 or later (Ubuntu 20.04, Debian 10, RHEL 8 and newer).
- **Git**, recommended, available to the daemon, for coding projects and task worktrees. Timon and its Kanban run without it; only the Git plugin and the code, review and merge tasks of a Git project need it (see [Kanban](../usage/kanban.md)).
- On Windows, the desktop installer installs Node.js (LTS) and Git when they are missing.
- At least one installed, authenticated CLI backend: **`claude`, `codex`, `grok`, `copilot`** ([GitHub Copilot](../usage/github-copilot.md)), **`opencode`** ([opencode](../usage/opencode.md)) or **`hermes-acp`** ([Hermes](../usage/hermes.md)), **`agy`** ([Antigravity](../usage/antigravity.md)) or **`pi`** 1.4.0 or later ([Pi](../usage/pi.md)). Sign in using that CLI under the OS account that will run Timon. On Windows, the `codex` CLI bundled with the Codex desktop app is detected even when it is not on your PATH. On macOS, the Claude Code CLI bundled with the Claude desktop app is detected the same way.
- An existing project directory that the daemon's OS account can read and write.
- A supported supervisor: systemd user services on Linux, launchd on macOS or a scheduled task on Windows.

**Timon uses your CLI subscriptions, never token-billed APIs for its standard agent workflow.** A Timon licence does not replace your CLI subscription. You do not need to supply a token-billed API key to follow this installation guide.

From a terminal, check the tools you installed:

```bash
node --version
npm --version
git --version
```

Then open your chosen backend CLI and confirm that an ordinary conversation works. A CLI installed in your interactive shell may still be missing from a service's PATH: pin its absolute path in **Settings → AI models → Providers → CLI binaries** (or `host.binaries` in the configuration file) if necessary.

## Optional tools

Docker Engine and Compose v2 are needed only for container features. The supplied Compose configuration expects an existing `traefik_network`. Native Node dependencies (`node-pty`, `better-sqlite3`) can require a compiler, Python and platform build tools when no matching prebuilt binary is available.

Use `timon doctor` to inspect the installation and host capabilities. Missing optional tools do not mean every Timon feature is unavailable.
