---
title: Running in the background
sidebar_position: 6
---

Timon's daemon runs under your operating system's supervisor, not inside the desktop window. Closing the window does not stop it. Whether it keeps working after you sign out is your choice: scheduled Kanban tasks, overnight series, routines and webhooks then carry on with nobody at the screen.

## Choose whether Timon keeps running when you log out

Setup asks the question once, right after the welcome screen:

- **Only while I'm logged in** (recommended): Timon stops when you log out and starts again when you log back in. Locking the screen keeps it running.
- **Even when I'm logged out**: Timon keeps running with no session open, as long as the computer is on.

Nothing is preselected. To change your answer later, open **Settings › System › Installation**: the **When you log out** row says what the service does now and offers the button that switches it. From a terminal:

```bash
timon service session-mode           # shows your answer and what the service does
timon service session-mode session   # stop with your session
timon service session-mode always    # keep running when logged out
```

What each answer means on each system:

| System | Only while I'm logged in | Even when I'm logged out | Details |
| --- | --- | --- | --- |
| Linux | A systemd user service, without user lingering: it stops when your last session ends. | The same service with user lingering (`loginctl enable-linger`): it starts at boot and survives logout. | [Linux](linux.md) |
| macOS | A launchd agent: it stops when you log out. | A launchd daemon: it starts at boot and survives logout. macOS asks for an administrator password, and Claude missions need a long-lived Claude token. | [macOS](macos.md#keep-timon-running-when-you-are-logged-out) |
| Windows | The `TimonOrchestrator` scheduled task, started when you sign in: Windows ends it when you sign out. | The same task, started at boot under your account: it survives sign-out. After a restart, Timon waits for your first sign-in. | [Windows](windows.md) |

Choosing **Only while I'm logged in** on Linux turns user lingering off for your whole account if it was on, so your other user services also stop when you log out. Setup and Settings say so before you choose. On macOS and Windows, the switch reinstalls the service, and the system asks for permission; from the app, Timon shows the command to run in a terminal (`timon service install`).

An installation made before this question existed keeps the behaviour it had until you choose.

Check the service at any time with:

```bash
timon service status
```

## Stopping and starting the service

Quitting the app leaves the service running on purpose. To stop everything, choose **Quit and stop the background service** in the tray or menu bar icon menu: the daemon and the programs it started (web server, mission programs, built-in terminal) end, and the app quits. The service stays installed and starts again the next time you open Timon.

From a terminal:

```bash
timon service stop
timon service start
```

| System | What the stop does | What starts the service again |
| --- | --- | --- |
| Linux | Stops the systemd user unit; it stays enabled. | Opening Timon, `timon service start`, or the next boot. |
| macOS | Unloads the launchd agent; a launchd daemon asks for an administrator password. | Opening Timon (the daemon asks for the password again), `timon service start`, or the next login (agent) or boot (daemon). |
| Windows | Disables the `TimonOrchestrator` task and ends the daemon; Windows asks for permission. | Opening Timon or `timon service start`, with one more permission prompt. A disabled task does not start at boot. |

Stopping the service also ends the programs of the missions that were still running. If the daemon ever stops without ending them (a crash, a forced stop), its next start does.

## If another Timon owns the service

On macOS and Windows the service has a single name per account, and so has the service of a Timon run from source on Linux. Before it installs, removes, stops or starts it, `timon service` checks that the service in place belongs to the same data folder and the same Timon installation. If it does not, the command changes nothing, exits with an error and shows what it found:

```text
refused: the service com.timon.daemon belongs to another data directory.
  service:    com.timon.daemon (/Users/you/Library/LaunchAgents/com.timon.daemon.plist)
  data:       /Users/you/.timon
  install:    /Users/you/.timon/desktop-runtime/releases/…/Resources/orchestrator
  executable: /Users/you/.timon/desktop-runtime/releases/…/MacOS/Timon
  this command: data /tmp/try, install /Users/you/src/timon/orchestrator
Nothing was changed. To replace it anyway: timon service install --force
```

The usual way out is to run the command from that installation, or with its `TIMON_HOME`. Reinstalling over your own service, which is how you repair or update it, needs no flag.

A service that cannot be identified is refused too: `install` and `uninstall` also stop if its definition cannot be read, or names your data folder but not the installation it runs from. Check it, then use `--force`. `stop` and `start` still work on such a service.

The Timon app checks too. Opened on another data folder, it does not offer **Quit and stop the background service**, never stops or restarts that service, and runs its own built-in daemon.

To take the service over on purpose, use `timon service install --force`. The other installation's daemon stops, and its data folder is left as it is. `timon service uninstall --force` removes the service in the same way. `stop` and `start` have no `--force`.

On Linux, a package and a source checkout use different service names, so both could end up running on the same data folder. `timon service install` and `start` refuse that too, and `timon service status` shows the other service. `timon service install --force` stops and removes it before starting its own. If both already exist, `timon service uninstall` from either one removes only that one's service.

The check reads what systemd actually runs, including drop-ins. If systemd cannot confirm a Timon unit, for instance because it was edited and not reloaded, `install` and `start` refuse, and `--force` does not remove it. Run `systemctl --user daemon-reload`, or repair or remove that unit, then try again.

`--dry-run` reports this refusal too, with `--force` it shows what would be replaced. The install button in the app gives the same refusal, and only the command can force it.

## Sign out, do not just lock

Locking the screen keeps your session open, so Timon keeps running whatever your answer. Signing out is what the question above decides. Portable mode (Linux without systemd, or a daemon started by hand) is the exception: that daemon stops with the application, together with the programs of its running missions.

## Sleep stops everything

**No system runs Timon while the computer is asleep.** Missions pause, and a task scheduled during sleep only starts once the computer wakes up. Timon does not wake the computer.

If you schedule tasks for the night, turn off automatic sleep on that computer, or at least while it is plugged in:

- **Linux:** in your desktop's power settings, set automatic suspend to off. On a machine without a desktop, `sudo systemctl mask sleep.target suspend.target` disables suspend.
- **macOS:** System Settings → Energy (or Battery → Options on a laptop): prevent automatic sleeping while the display is off.
- **Windows:** Settings → System → Power → Screen and sleep: set "When plugged in, put my device to sleep after" to **Never**.

Turning off only the display is fine: it does not stop Timon.

## After a restart

On Linux with **Even when I'm logged out**, Timon starts at boot, before anyone signs in. Otherwise it waits for you to sign in.

On Windows with **Even when I'm logged out**, Timon waits for your **first sign-in** after each restart, including restarts made by Windows Update during the night. After that sign-in you can sign out again and Timon keeps running. To keep a machine working through unattended restarts, enable automatic sign-in on it, or sign in after each restart. With **Only while I'm logged in**, Timon starts when you sign in and stops when you sign out.

On macOS with **Even when I'm logged out**, Timon starts at boot, before anyone logs in. If FileVault is turned on, nothing starts until someone unlocks the disk at the login screen. Otherwise Timon waits for you to log in.

## Limits while no session is open

A background daemon runs as you, but without the resources that only exist in an open session.

- **Tools that use the system credential store.** A CLI tool that keeps its sign-in in the operating system's credential store may not be signed in for a mission that runs while you are signed out. On macOS, this is the case of Git over HTTPS and `gh`. Git over SSH with a key file works in every case.
- **Windows: network shares.** While you are signed out, missions may not be able to reach mapped network drives (`Z:\…`) or shared folders that require your credentials. Keeping agent working directories on a local disk avoids the question.
- **No windows.** Nothing a mission launches can show a window or a prompt on your screen. A tool that needs an interactive sign-in must be signed in beforehand, from a terminal under the same account.

If a mission fails only while you are signed out, check `timon service status` and the daemon log first; see [Troubleshooting](troubleshooting.md).
