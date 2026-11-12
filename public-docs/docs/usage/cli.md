---
title: Command-line interface
sidebar_position: 7
---

The `timon` executable controls agents, missions, tasks and plugins. A source installation exposes it with `npm run install:cli` in `orchestrator/`; it can also be called as `node orchestrator/bin/timon` from a checkout.

## Desktop installations

No separate Node.js installation is needed: the packaged launcher uses Timon's own runtime.

- **Linux deb:** the installer adds `timon` in `/usr/bin`. The deb is the recommended Linux beta format. Uninstalling removes the link; an existing command from another installation is preserved.
- **Windows:** the installer adds its `cli` directory to the user PATH (or the system PATH for an all-users install). Close and reopen your terminal after installing. Uninstalling removes only that directory from PATH.
- **macOS pkg:** the installer adds `/usr/local/bin/timon`. Install Timon in `/Applications`; the command follows the app's upgrades. If you later delete the app, remove its CLI symlink too.
- **macOS DMG:** drag Timon to `/Applications`, then run `sudo ln -s /Applications/Timon.app/Contents/cli/timon /usr/local/bin/timon` once. Create `/usr/local/bin` with `sudo mkdir -p /usr/local/bin` if needed. If the link already exists, inspect it before changing it. Ensure `/usr/local/bin` is on your shell's PATH.
- **AppImage:** remains a portable option and does not install a global CLI. Use the deb package when you need terminal commands; do not link into an AppImage's temporary mount directory.

Open Timon and complete first run before issuing daemon commands. `timon --help` works without a running daemon; `timon list` requires one. If a command already existed before installation, use the packaged launcher directly to avoid contacting a source installation: `/opt/Timon/cli/timon` on Linux, `/Applications/Timon.app/Contents/cli/timon` on macOS, or `cli\timon.cmd` inside your Windows installation directory.

## Getting started from the terminal

`timon` on its own shows where this installation stands: the daemon, the background service, whether the first account exists, the address of the web interface, and the one command to type next. `timon help` prints every command.

```bash
timon          # where things stand, and what to do next
timon init     # background service if missing, first account, AI tools
```

`timon init` is for the machine where Timon is installed, run by the account that owns its data. It asks for the account details in the terminal, with the password typed hidden; in a script, give `--email` (and optionally `--name`) and pipe the password with `--password-stdin`. `--yes` installs the background service without asking when it is missing. When a command cannot reach the daemon, it says how to start it.

## Inspect first

```bash
timon --help
timon backends
timon list
timon task list
timon plugin list
```

`spawn`, `task create`, plugin installation and other write commands change the instance. `wait` can block until a mission completes; use its timeout when scripting.

## Select the instance

The CLI automatically finds the local daemon from `timon.config.json`, then the desktop installation's saved port in `desktop-bootstrap.json`, under `TIMON_HOME` (normally `~/.timon`; see [Where Timon keeps its files](../installation/configuration.md#where-timon-keeps-its-files) for the Windows and macOS locations). If neither provides a usable address, the packaged command uses the port its background service gets before any configuration exists (`http://127.0.0.1:3010`), and a source installation falls back to `http://localhost:3000`.

`--daemon` selects a URL or named profile and takes precedence over `TIMON_API`. Without the flag, `TIMON_API` overrides local discovery. Authentication uses the named profile's token when selected; otherwise it reads `TIMON_API_TOKEN` or the `daemon-token` file under the same home. Whether the target comes from `--daemon <url>` or `TIMON_API`, the local file token is only sent to the local daemon's own listener, with the same protocol and port and no path: its loopback address, or the IP address set in `daemon.listen.host` when the daemon listens on a LAN address that is still assigned to this computer. A host name in `daemon.listen.host`, or an address the computer no longer holds, never receives it: set `TIMON_API_TOKEN` in that case. For a remote URL, set `TIMON_API_TOKEN` explicitly or select a profile created with `timon daemon add`; otherwise the request is unauthenticated. Use a server-to-server token only in a trusted terminal or process; do not expose it in browser code.

```bash
timon --daemon https://your-daemon.example list
```

Named daemon profiles are also supported. The generated CLI reference documents the source command syntax; avoid assuming that appending `--help` to every subcommand is harmless, because not every command has a dedicated help handler.

## Durable text inputs

For a task result, write the text to a file and call `timon task done TASK_ID --comment-file result.md`. This preserves line breaks and avoids shell quoting surprises. Use actual IDs returned by the CLI, not the placeholders used in this guide.

## Read this documentation

`timon docs` reads the pages of the documentation that shipped with your installed version. It needs no running daemon and no network. It is the command-line twin of the `docs_search` and `docs_read` tools agents use ([Tools Timon gives agents](agent-tools.md)).

```bash
timon docs search permission mode          # pages that match every word, with an excerpt
timon docs search plugin manifest --limit 5 --json
timon docs read                            # the list of every page
timon docs read /usage/cli                 # one page, as Markdown
timon docs read /usage/cli --heading "Select the instance"   # one section of it
```

A route is the path of the page on this site (`/usage/cli`); a `.md` suffix or a full `docs.timon-ai.com` address works too. `timon docs read` with an unknown route suggests the closest ones.

## Workflows

`timon workflow` drives the workflows of the Workflows module from a terminal: graphs of nodes (agents, conditions, waits…) that run from a **published** version.

```bash
timon workflow list                         # the workflows you can see
timon workflow get nightly-review           # one workflow, with its draft
timon workflow create --file nightly.json   # a new workflow from a JSON definition
timon workflow publish nightly-review       # the draft becomes the next version
timon workflow run nightly-review --input '{"branch":"main"}'
timon workflow runs nightly-review          # the runs of a workflow
timon workflow status RUN_ID                # a run with its nodes, definition and spans
timon workflow cancel RUN_ID                # stop a run
timon workflow import pipeline PIPELINE_ID  # turn a pipeline, an agent (`agent NAME`)
                                            # or a routine (`routine ID`) into a workflow
```

`timon workflow node done --output JSON [--route PORT]` is for the agent a workflow node launched: it closes that node with an output value and, optionally, the port to follow next (`done` by default). It reads the run and node from the mission's environment and only works for the mission that owns the node. Agents have the same tools, described in [Tools Timon gives agents](agent-tools.md#workflows).

## The demo project

`timon project demo` creates the demo project: a small sample repository on which you can try your agents. It is the same project the guided tour offers, and needs the permission to create projects.
