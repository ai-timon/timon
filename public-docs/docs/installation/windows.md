---
title: Windows
sidebar_position: 5
---

## One command

In PowerShell (Windows PowerShell or PowerShell 7):

```powershell
irm https://timon-ai.com/install.ps1 | iex
```

It downloads the Timon installer, checks it, and opens it: the installer then runs as described below. Run it in your desktop session, not over SSH: the installer window would open where nobody can see it, so the command refuses unless you add `-Silent`. Options and checks: [Install with one command](overview.md#install-with-one-command).

It works from a normal PowerShell window and from one opened with **Run as administrator**. Timon installs for your own account: from an administrator window, the command asks File Explorer to open the installer, as a double-click would, so the installer runs as you and not as administrator, then waits for it to finish. Updating an installed Timon then shows the Windows permission prompt that pauses the background service, as a double-click does. With `-Silent`, or when File Explorer cannot open it for that window (User Account Control turned off, or a window elevated with another account's password), the installer starts from the window itself; if it then ends with code `-1073741819` (`0xC0000005`), see [Troubleshooting](troubleshooting.md#windows-the-installer-ends-with-code--1073741819).

## Desktop installer

Run the supplied Timon NSIS installer, choose its installation directory and open Timon. If Node.js or Git is missing, the installer installs Node.js (LTS) and Git for Windows with `winget`, after one Windows permission prompt; this can take a few minutes. If that fails or you decline, the setup screen offers them again.

At first run it registers the daemon as the **`TimonOrchestrator` scheduled task**, which asks for the Windows permission prompt once. With **Only while I'm logged in**, the task starts when you sign in and Windows ends it when you sign out. With **Even when I'm logged out**, it starts at boot and keeps Timon running after you sign out, using your own account without storing its password; see [Running in the background](background.md#choose-whether-timon-keeps-running-when-you-log-out). It runs with your standard privileges, not as administrator. This is not a Windows NT service and does not require an administrator service wrapper. Timon uses a scheduled task rather than a service on purpose: a service runs under a system account, or needs your password stored to run as you, and would not find the sign-ins of your AI tools (`claude`, `codex`…) kept in your user folder; the task runs as you, with your folder and your sign-ins, without storing a password.

If the task is missing at launch, for example after Timon was uninstalled and reinstalled, or after you deleted it from Task Scheduler or PowerShell, Timon offers to reinstall it, with one Windows permission prompt. Until you accept, Timon runs only while its window is open. If you choose **Not now**, Timon asks again after the next update.

On some work or school accounts — typically a PC joined to Microsoft Entra ID — Windows does not keep **Even when I'm logged out**: it registers the task to run only while you are signed in, or registers it and never starts it. Timon reads the task back after registering it and checks that it started. When Windows did not keep that mode, Timon registers the task for your session instead, within the same permission prompt, and tells you once: the task stops when you sign out and starts again at your next sign-in, without a console window. Timon remembers this for your account and registers the session task directly at the next updates, without trying again; run `timon service session-mode always` to try again. If even the session task never starts, Timon removes it (or, at a later launch, turns it off), tells you, and runs its built-in daemon instead: Timon then works while its window is open and stops when you close it or sign out. To remove an unused task yourself, run `timon service uninstall` and allow the permission prompt.

Do not change the `TimonOrchestrator` task in Task Scheduler, and in particular do not select **Run only when user is logged on** in its properties: the task then opens a console window at every start, about every five minutes, and closing that window stops Timon. To switch between the two modes, use **Settings › System › Installation** or `timon service session-mode`. When the task was changed outside Timon, the app offers to repair it at launch, with one Windows permission prompt. If you decline, Timon uses the task as it is and asks again only after the next update; **Repair the service** in **Settings › System › Installation**, or `timon service install`, repairs it at any time. See [Troubleshooting](troubleshooting.md#windows-a-console-window-opens-every-few-minutes).

With **Even when I'm logged out**, after Windows restarts, Timon waits for you to sign in once before it starts: your CLI backends need the credentials that Windows only unlocks at sign-in. After that first sign-in, you can sign out and Timon keeps running. If the machine must run agents overnight, enable automatic sign-in or sign in after each restart, and turn off sleep: no scheduled task runs while Windows sleeps. See [Running in the background](background.md) for what missions cannot reach while you are signed out.

The task starts a program of the installation directly, never a script: the daemon's own Node at boot, or, with **Only while I'm logged in**, `Timon.exe` in a background mode that opens no window. That background `Timon.exe` is the one you may see in Task Manager while the Timon window is closed. If an antivirus removed the task, see [Troubleshooting](troubleshooting.md#windows-an-antivirus-quarantined-the-background-task).

The daemon writes its log to `%USERPROFILE%\.timon\tmp\daemon-<date>.log`, one file per day; the background task's own messages, and anything printed before the daemon starts, go to `daemon.log` in the same folder (at each start, a `daemon.log` larger than 10 MB is moved to `daemon.log.1`). `%USERPROFILE%` is your user folder, `C:\Users\<user>`; [Where Timon keeps its files](configuration.md#where-timon-keeps-its-files) lists the other locations, and [Troubleshooting](troubleshooting.md#diagnostic-report-and-logs) explains how to send them.

When Timon is already installed, the installer asks for the Windows permission prompt as it opens: it pauses the background task and ends its daemon while it replaces the files, and starts the task again when the installer closes. If Timon still runs in the background after that, for example because the permission prompt was refused, the installer changes nothing and says so: choose **Retry** and allow the prompt, or **Cancel**; see [Updating while the background service runs](troubleshooting.md#windows-updating-while-the-background-service-runs). The first launch after an update may ask once more, to update the task. Then approve the update in Timon's window; see [Upgrading](upgrading.md).

Follow [First run](first-run.md). Install and sign in to your CLI backend under the same Windows account. Keep agent working directories as existing absolute Windows paths; a Linux or container path is not interchangeable with one.

Setup detects npm-installed backends without restarting Timon, including installations with a custom global npm directory. If you explicitly configured a backend path in `host.binaries`, that path takes precedence; `timon doctor` reports it when the file is missing. Correct or remove the outdated path on the provider's page in **Settings → AI models → Providers**, under **Program → Advanced**; it applies without restarting Timon.

## Quitting and stopping

**Quit** in the notification-area icon menu closes the app only. The daemon run by the `TimonOrchestrator` task keeps working (your missions continue), and the task starts it again within five minutes if it stops, so ending the task from Task Scheduler is not a stop.

**Quit and stop the background service**, in the same menu, ends the daemon and every program it started (web server, mission programs, built-in terminal), disables the task and quits. Windows asks for permission once. The next time you open Timon, it asks once more and starts the service again. From a terminal, `timon service stop` and `timon service start` do the same; `timon service status` says when the service was stopped this way.

In portable mode (no task), the daemon is started by the app and stops with it, together with its web server, the programs of the running missions and the built-in terminal.

To remove the service for good, run `timon service uninstall` and allow the Windows permission prompt: it removes the task, ends the daemon and the terminal host, and keeps your data. Timon offers to install the task again at the next launch. If the permission prompt is refused, the command says so and the task stays.

## Uninstalling

Uninstall Timon from Windows Settings or Control Panel. Allow the Windows permission prompt to remove the `TimonOrchestrator` scheduled task. Your Timon data directory, including missions, agents and the database, is kept.

For unattended removal, run the installed uninstaller with `/S` from an administrator terminal. Silent removal does not ask for elevation. If permission is denied, removal of the application continues; remove any remaining `TimonOrchestrator` task from Task Scheduler with administrator rights.

## Source installation

For a source checkout, install Node 22+, Git and the native build prerequisites. In PowerShell, from the checkout root:

```powershell
cd orchestrator
npm ci
npm run build
cd ../app
npm ci
npm run build
cd ..
node orchestrator/bin/timon service install --dry-run
```

Before installing, set `profile` to `windows`, `daemon.supervisor` to `windows`, `daemon.installDir` to the absolute orchestrator directory and `app.enabled` to `true` in the [configuration file](configuration.md). Escape backslashes in JSON or use forward slashes.

```powershell
node orchestrator/bin/timon service install
node orchestrator/bin/timon service status
```

The task starts at boot (or at sign-in, with **Only while I'm logged in**) and every five minutes if the daemon stopped. If it is registered but not running, start it from Windows Task Scheduler before completing setup. Removing the supervisor does not remove Timon's data directory.
