---
title: Overview
sidebar_position: 1
---

Timon runs a local daemon that manages agents and stores mission history. A desktop client or web interface connects to that daemon. Closing a client does not stop a daemon running under an operating-system supervisor, and that daemon can keep working after you sign out; see [Running in the background](background.md), including why sleep must be turned off for overnight tasks.

For a diagram of what runs where, see [How Timon works](../usage/how-timon-works.md).

Start with [Requirements](requirements.md), then choose [Linux](linux.md), [macOS](macos.md) or [Windows](windows.md). Finish with [First run](first-run.md).

## Install with one command

On Linux and macOS, in a terminal:

```bash
curl -fsSL https://timon-ai.com/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://timon-ai.com/install.ps1 | iex
```

The command picks the package of your system (deb on Debian and Ubuntu, AppImage on other Linux distributions, pkg on macOS, the installer on Windows), downloads it from the release list that Timon publishes signed, and checks its size and checksum against that list before installing anything. Then it opens Timon, or, on a server without a display, installs the background service and tells you to run `timon init`.

To see what it would do without changing anything:

```bash
curl -fsSL https://timon-ai.com/install.sh | sh -s -- --dry-run
```

```powershell
& ([scriptblock]::Create((irm https://timon-ai.com/install.ps1))) -DryRun
```

You can read the script before running it: open [install.sh](https://timon-ai.com/install.sh) or [install.ps1](https://timon-ai.com/install.ps1). Options:

| Linux and macOS | Windows | Effect |
| --- | --- | --- |
| `--dry-run` | `-DryRun` | Check the release list and show the package; change nothing |
| `--download-only` | `-DownloadOnly` | Download and verify the package, print its path, install nothing |
| `--channel stable\|beta` | `-Channel stable\|beta` | Release channel (default: stable when published, else beta) |
| `--format deb\|appimage\|pkg` | | Force a package format |
| `--server` | | Act as on a server: install the background service, open no window |
| `--no-service`, `--no-launch` | | Install the package only |
| | `-Silent` | Run the installer without its window (it then skips Node.js and Git: install them first) |

On Linux the script checks the signature of the release list when OpenSSL 3 is installed; otherwise, and on macOS and Windows, it says so and relies on HTTPS and the package checksum, and Timon checks the signature again once installed. The packages are also attached to each release on GitHub, to download by hand.

## Choose an installation mode

| Mode | What runs where | Best suited to |
| --- | --- | --- |
| Desktop package | Desktop client, bundled daemon and web app on your computer | Interactive use |
| Host installation | Node daemon and web app on your computer | Operators with source access |
| Docker web app | Daemon on the host; app and optional workers in containers | Existing Docker installations |

Docker is optional. The current Compose file does **not** contain an orchestrator service. See [Docker](docker.md) before using it.

:::note Distribution
The desktop packages are published with each release; the one-command install above picks the right one. Building from source is described in [Linux](linux.md#from-an-authorised-source-checkout).
:::
