---
title: Linux
sidebar_position: 3
---

## One command

```bash
curl -fsSL https://timon-ai.com/install.sh | sh
```

It installs the deb package on Debian and Ubuntu (it asks for your password once, for `apt`) and the AppImage in `~/Applications` elsewhere. On a machine without a display, it also installs the background service and ends on `timon init`; see [Run Timon on a headless server](headless-server.md). Options and checks: [Install with one command](overview.md#install-with-one-command).

## Desktop package

Use the supplied deb package, recommended during beta: it also installs the `timon` terminal command without requiring Node.js. AppImage remains portable and does not install a global CLI. Open Timon and follow [First run](first-run.md). The setup flow checks tools and installs a systemd user service so that agent work can continue after the window closes.

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

The user service is named `timon-orchestrator`. Installation requests user lingering so it starts at boot and survives logout; see [Running in the background](background.md). On Linux without systemd, setup reports portable mode: closing the application also stops the embedded daemon and the programs of its running missions.

Open the configured web-app address (for the configuration example, `http://127.0.0.1:3100`) and complete [First run](first-run.md); if the web app listens on something other than the loopback, the form asks for the token printed by `timon setup-token` on the server. On a server without a screen, that address only answers on the server itself: see [Remote access to the web interface](remote-access.md).

:::warning Existing installation
Installing or changing a daemon service is an operator action. Finish active missions first, and do not overwrite a service belonging to another checkout or data directory.
:::
