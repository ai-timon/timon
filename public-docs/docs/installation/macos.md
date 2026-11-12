---
title: macOS
sidebar_position: 4
---

## One command

```bash
curl -fsSL https://timon-ai.com/install.sh | sh
```

It downloads the pkg installer, checks it, installs it (macOS asks for your administrator password once) and opens Timon. Options and checks: [Install with one command](overview.md#install-with-one-command).

## Desktop package

Use the supplied pkg installer to install Timon in `/Applications` and make the `timon` terminal command available without Node.js. The DMG also remains available; see [CLI setup](../usage/cli.md) to add its terminal command manually. Open Timon and follow [First run](first-run.md). The setup flow checks tools and installs a launchd agent so that agent work can continue after the window closes.

The daemon writes its log to `~/.timon/tmp/daemon-<date>.log`, one file per day; what launchd captures before the daemon starts goes to `daemon.log` in the same folder. See [Where Timon keeps its files](configuration.md#where-timon-keeps-its-files) and [Troubleshooting](troubleshooting.md#diagnostic-report-and-logs).

## Keep Timon running when you are logged out

By default the service is a launchd **agent**: it keeps running while the screen is locked, but it stops when you log out, and after a restart it waits for you to log in.

To keep it running with no session open, Timon needs a long-lived Claude token. On macOS, `claude` keeps its sign-in in your login keychain, which background services cannot read, even while you are logged in.

1. In a terminal, run `claude setup-token` and copy the token it prints.
2. Store it in Timon, either in **Settings → AI models → LLM backends → Claude long-lived token**, or with `timon auth claude-token set` (paste the token when asked).
3. Run `timon service install`. macOS asks once for an administrator password: the service becomes a launchd **daemon** that starts at boot and keeps running after you log out.

Every Claude mission then uses this token. Without a token nothing changes: the service stays a launchd agent. Removing the token (`timon auth claude-token clear`) and running `timon service install` again brings back the agent.

Limits of a service running with no session open:

- Git over HTTPS and `gh` also keep their credentials in the login keychain, so they fail in missions. Git over SSH with a key works.
- With FileVault turned on, nothing starts after a restart until someone unlocks the disk at the login screen.
- Updates of Timon do not ask for the administrator password again; uninstalling the service does.

Sleep stops the service like any other; see [Running in the background](background.md) to keep the Mac awake for overnight tasks.

## From an authorised source checkout

Run these commands from the root of the Timon checkout:

```bash
cd orchestrator
npm ci
npm run build
npm run install:cli
cd ../app
npm ci
npm run build
cd ..
```

The CLI installer puts `timon` in `~/.local/bin`; follow its PATH instructions. Set `daemon.installDir` to the **absolute path of this checkout's `orchestrator` directory**, following [Configuration](configuration.md). Enable `app.enabled` to let the daemon serve the built app without Docker.

Inspect the service installation before applying it:

```bash
timon service install --dry-run
timon service install
timon service status
timon doctor
```

The launchd label is `com.timon.daemon`; its plist lives in `~/Library/LaunchAgents/`, or in `/Library/LaunchDaemons/` once a Claude token is set (see [above](#keep-timon-running-when-you-are-logged-out)). `timon service status` says which one is installed. Use an explicit backend binary path when launchd cannot find a tool that works in your shell.

Open the configured web-app address (for the configuration example, `http://127.0.0.1:3100`) and complete [First run](first-run.md).

:::warning Existing installation
Installing or changing a daemon service is an operator action. Finish active missions first, and do not overwrite a service belonging to another checkout or data directory.
:::
