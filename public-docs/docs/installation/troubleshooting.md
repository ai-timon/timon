---
title: Troubleshooting
sidebar_position: 10
---

| Symptom | Check | Next action |
| --- | --- | --- |
| Mission fails with a missing executable | CLI location and service PATH | Open the provider in **Settings → AI models → Providers**: install it from **Program**, or set its path under **Program → Advanced** (applies without a restart); click **Check again** after installing it yourself (during setup: **Re-detect** in the Prerequisites panel) |
| CLI launches but authentication fails | Sign-in under the daemon's OS account | Authenticate the CLI directly, then retry a small mission |
| Mission fails before producing output, with "its working directory … does not exist" | Agent's or project's folder was moved or deleted | Restore the folder, or set an existing absolute path accessible to the daemon on the agent or the project, then retry the task: Timon blocks it instead of retrying |
| UI cannot reach the daemon | Address, port and authentication | Compare the app's daemon URL with the actual listener |
| Web interface does not open from another computer or phone | It listens on the loopback by default | See [Remote access to the web interface](remote-access.md) |
| Address already in use | Host app and Compose app both enabled | Keep one web-app serving mode |
| Configuration rejected | Error names a key | Correct that key or restore the last working file |
| Plugin visible but refused | Reason on its gallery card | Check API version, licence and signature; repeatedly toggling cannot fix admission |
| Feature or model missing | Host capabilities, enabled plugins and backend catalogue | Inspect `timon doctor`, `timon module list` and `timon backends` |
| Scheduled task did not run overnight | Whether the computer slept, and `timon service status` | Turn off automatic sleep; see [Running in the background](background.md) |
| Timon takes a minute to open on a work PC, or shows "Checking the installation…" | Antivirus scanning every file Timon reads | Exclude the Timon folders from real-time scanning; see [Slow start behind an antivirus](#slow-start-behind-an-antivirus) |
| Windows installer ends with code -1073741819 | Whether it was started from a PowerShell window opened with **Run as administrator** | Run the command again in a normal PowerShell window, or open the installer from File Explorer; see [The installer ends with code -1073741819](#windows-the-installer-ends-with-code--1073741819) |
| Windows installer says Timon cannot be closed | Whether you allowed the permission prompt when the installer opened | Choose **Quit and stop the background service** in the tray icon menu before installing; or, in an administrator PowerShell, run `schtasks /End /TN TimonOrchestrator; Stop-Process -Name Timon -Force`, then choose Retry |
| Windows installer says Timon is still running in the background or that its check did not run, or Timon says the running daemon is not the installed version | Whether you allowed the permission prompt | Choose **Retry** and allow the prompt, or restart the computer and install again; see [Updating while the background service runs](#windows-updating-while-the-background-service-runs) |
| Quota state unavailable | Whether the backend has a working usage probe | Treat unknown as unknown, not as zero usage |
| Anything else, or you need help | The diagnostic report | **Copy diagnostic** and paste it in your support request; see below |

## Diagnostic report and logs

When something goes wrong, send the **diagnostic report** with your support request rather than describing your setup: it holds what support asks for first.

**Where to get it**

- **Error boxes of the desktop app** (an update that fails, "The Timon daemon does not answer", a daemon that keeps crashing…): **Copy diagnostic**, **Save report** and **Open logs folder**. The box stays open until you click **OK**, so you can paste first. On Linux, paste before clicking OK: the clipboard empties when Timon quits. **Save report** always works and shows where the file was written.
- **Settings › System › Installation** (superadmin): **Support diagnostic**, with the same buttons and **Show report**.
- **The tray or menu bar icon**: **Support diagnostic…**.
- **A terminal**: `timon doctor --report` prints it, `timon doctor --report --save report.txt` writes it to a file. It works while the daemon is stopped.

**What it contains**: the versions of the app, the daemon and your data; the operating system and, on Windows, whether the computer is joined to a work domain or Microsoft Entra ID; how the daemon runs (background service or inside the app), what answers on its port; the state of the background service and its last run; the problems Timon recognises (a service installed without the app's marker, a Windows task that never ran, data last opened by an older version, a port held by another program, a Timon background service left behind for a data directory that no longer exists, with the commands that remove it); and the last 100 lines of each log, **newest first**, including on Windows what the last installers found running and ended (`timon-service-pause.log`). Tokens, keys, passwords and e-mail addresses are masked; read it before posting it publicly if you want to. Licence: only its edition and status.

**Logs**: one file per day in the `tmp` folder of the Timon data directory (`~/.timon/tmp/` on Linux and macOS, `%USERPROFILE%\.timon\tmp\` on Windows): `daemon-<date>.log` for the daemon, `desktop-<date>.log` for the desktop app. Every line starts with the local date and time. Inside a file, lines are in the order they were written, newest at the end; the report, the settings and `timon logs` show them newest first. Files older than 14 days are deleted, and the oldest go first past 200 MB in total: change it with the **Log retention** and **Log size ceiling** settings (type *log* in the settings search), or `TIMON_LOG_RETENTION_DAYS` and `TIMON_LOG_MAX_MB`. `timon logs` shows the last 100 daemon lines (`--desktop` for the app, `-n 300` for more).

## Reading a 403 refusal

When the CLI or an MCP agent is refused with HTTP 403, the response explains
itself instead of a bare `forbidden`. The body carries:

- `code` — a stable, machine-readable code (`operator_only`, `account_lacks_permission`, `not_in_mission_cap`, `mission_without_owner`, `override_denied`, `out_of_scope`, `explicitly_denied`, `account_required`).
- `permission` — the permission that was missing, or `null` when the route is operator-only.
- `reason` — a short sentence for a human.
- `hint` — the concrete next step (ask an administrator, run it from the UI, …).
- `caller` — what was refused: `mission`, `session` or `operator`. It never names an account.

`not_in_mission_cap` means a mission token can never carry that permission: do
the action from the UI, or ask the account owner to run it with the CLI outside
a mission. `account_lacks_permission` means an administrator can grant the
missing permission to your role. `mission_without_owner` means the mission is
not attached to any account: relaunch it from your account. `operator_only` is reserved to the operator and
is not reachable from a mission. `out_of_scope` means the request names something
your mission or session does not cover (another mission, another person's
account): act on your own, or ask the operator. `explicitly_denied` means your
role denies that permission on purpose (agent-to-agent messages, for one): only
an administrator can lift it. A message between two agents of different teams
is refused with `out_of_scope` and names both agents.

## Windows: the installer ends with code -1073741819

`-1073741819` is `0xC0000005` written as a signed number. A tester's Timon installer returned it when it started from an administrator session, and nothing was installed; the same command in a normal PowerShell window worked. (TIM-0160)

The one-line install avoids it: from an administrator window, File Explorer opens the installer, as a double-click would. The installer starts from the administrator window itself only with `-Silent`, with User Account Control turned off, or when the window was elevated with another account's password. If you still see this code:

- run the command again in a normal PowerShell window, opened from the Start menu without **Run as administrator**:

  ```powershell
  irm https://timon-ai.com/install.ps1 | iex
  ```

- or add `-DownloadOnly`, which downloads and checks the installer and prints its path, then open that file from File Explorer.

## Windows blocks the installer (Smart App Control)

The installer is not signed yet, so Windows **Smart App Control** can block it. Workaround: turn Smart App Control off in **Windows Security**, then run the installer. (TIM-0034)

## Notification area icon could not be loaded

If Timon reports that its notification area icon could not be loaded, reinstall
Timon to restore it. The window remains usable without the tray icon; closing
it quits the desktop app. A daemon running as a service stays running, while
a daemon running in portable mode stops with the app.

## Text too small or blurry in the desktop app

Use **Interface size** in **Settings › Interface › Appearance**, or **Ctrl** and **+** (**Cmd** and **+** on macOS): it enlarges Timon itself, sharply, in every window, and is remembered. See [Appearance and plugin settings](../usage/settings.md#appearance-and-plugin-settings).

On Linux, text that looks blurry rather than small usually comes from display scaling:

- **Wayland with fractional scaling** (125%, 150%): the desktop app runs as an X11 app by default, and the compositor stretches it. Start it with the environment variable `ELECTRON_OZONE_PLATFORM_HINT=auto` to run it as a Wayland app, drawn at the screen's own scale. Run that way, windows keep their size from one launch to the next but not their position: Wayland does not let an app place its own windows.
- **KDE Plasma**: alternatively, in **System Settings › Display & Monitor**, set **Legacy applications (X11)** to **Apply scaling themselves**.
- **A scale that is still wrong**, on X11 without a scale set for example: start Timon with `--force-device-scale-factor=1.2`, or the factor of your choice, added to the command or launcher that opens it.

## Forgot your password

**Forgot password** on the sign-in screen sends a 6-digit code to the e-mail address of your account. Type the code, then your new password twice. Resetting a password signs that account out everywhere. It needs an internet connection, and works only if your address was confirmed; if no code arrives within a few minutes, use one of the ways below.

An address made without a code stays unconfirmed: an account invited or created by an administrator, a first account created from a terminal, or a sign-in email you changed. Confirm it while you can still sign in: in **Profile**, under **Sign-in email**, **Confirm your address** › **Send the code**, then type the 6 digits you receive. Until you do, a **Confirm your email address** card at the bottom left of the app takes you there. The screen of **Forgot password** recalls it under the code.

Codes are limited to a few per address and per network in a quarter of an hour. If Timon answers that too many codes were requested, wait the time it shows before asking again.

When e-mail cannot help, the password is reset by someone who controls the installation:

- **You are not the administrator.** Ask an administrator to reset your password from the **Team** page of the Multi-user plugin. They hand you a temporary password; sign in with it and change it from your account.
- **You are the administrator.** Open a terminal on the computer where Timon runs and use your own e-mail address:

  ```bash
  timon user reset-password you@example.com
  ```

  The command prints a temporary password once. Resetting a password signs that account out everywhere.

## Collect a useful diagnostic

```bash
timon doctor --json
timon service status
timon app status
timon plugin list
```

For a failed mission, retain its ID and error message. Remove tokens, secret values and personal paths before sharing logs. Never post `daemon-token`, a backend authentication file or the entire Timon data directory.

A container reaching `host.docker.internal` is using the bridge address; it cannot assume access to a listener bound only to host loopback. Check the [Docker setup](docker.md) before changing authentication settings.

## An agent shows "thinking" and never answers (TIM-0049)

When a backend CLI ends a turn without answering, the chat shows a notice with its exit code, the end of what it wrote on stderr, and the mission and session ids. An access refusal, an expired sign-in or an organisation policy usually appears there in clear text.

- **GitHub Copilot:** run `copilot` in a terminal and sign in again if asked; an *Access denied by policy settings* message comes from your organisation, not from Timon (see [GitHub Copilot](../usage/github-copilot.md)).
- **Another backend:** run its CLI by hand in a terminal to see the same message, or switch the agent to another backend to confirm the problem is the provider's.
- **Reporting it:** give the mission id from the notice. The session id, when shown, is the one to look for in the provider's own logs. Remove tokens and personal paths first.

## "Unable to find the main agent" (TIM-0079)

The chat opens your main agent when no agent is named in the address. When it cannot, the screen says why:

- **The agent list could not be read:** the daemon is not reachable, or refused the request (the HTTP code is shown). Check that Timon is running, then **Retry**.
- **No agent is designated as the main agent:** each orchestrator without a project is listed with a **Make … the main agent** button. Pick the one you talk to; the chat opens it. Designating needs the right to manage agents. The same choice is in the right-click menu of an agent's avatar (**Set as main orchestrator**).
- **No cross-project orchestrator:** create one from **Open agents**, or give the orchestrator role to an agent without a project.

`timon doctor` prints a `main orchestrator` line: the agent that holds the seat, or `NONE` with the eligible orchestrators. While the seat is empty, recaps and notifications addressed to the main orchestrator have no recipient, and the notification centre shows **No main orchestrator** once. Designate one with `timon agent set-main <name>`.

When reporting it, include the line the screen shows.

## Unexpected end of input on macOS (TIM-0011)

This report remains under investigation. A successful HTTP status alone does
not prove that a script or JSON response is complete. Empty or malformed
sign-in state responses now report `[TIM-0011]`, the endpoint and HTTP status
in the renderer console.

For the packaged desktop app, quit Timon completely, then launch a build
containing the renderer diagnostic from Terminal:

```bash
TIMON_RENDERER_DIAGNOSTICS=1 /Applications/Timon.app/Contents/MacOS/Timon > "$TMPDIR/timon-renderer.log" 2>&1
```

Leave developer tools closed during capture: opening them can detach the
diagnostic session. Wait for the page to load, reload once with **Cmd+R**, then
visit a failing page. Quit Timon and extract the diagnostic records:

```bash
grep '"diagnostic":"TIM-0011"' "$TMPDIR/timon-renderer.log" > "$TMPDIR/timon-renderer-diagnostic.jsonl"
```

Send the extracted file, installed version/build SHA, page name and reproduction
steps to support. Look for `ready` before the reload; `attach-failed`,
`enable-failed` or `detached` means collection was unavailable or interrupted.
The record limit is 5,000 per window (1,000 successful script records and up to
30 failed-source fingerprints). Relaunch for another capture.

The trace records script IDs, lengths, SHA-256 fingerprints of failed sources,
stack locations, isolated execution contexts, HTTP statuses, MIME types and
transferred sizes. It does not record source text, response bodies, cookies,
headers, exception descriptions, URL query strings or local file paths.
Non-bundle URL paths are redacted. Script IDs connect parser failures to stack
locations; line and column numbers are zero-based. A `script-failed` record
identifies a parser failure, while a runtime `exception` can identify a JSON
parse caller. No source contents are saved, so a fingerprint may still need
comparison with the exact installed build. Worker targets are not collected.

Nothing is uploaded automatically. Normal launches without
`TIMON_RENDERER_DIAGNOSTICS=1` disable this capture. Delete the temporary logs
when finished; the unfiltered log can contain unrelated application output.

## Agent editor does not accept typing (TIM-0021)

This Windows report is fixed. If the Name field ever stops accepting typing
again and support asks for a focus trace, close the agent editor, open the desktop developer tools
(`Ctrl+Shift+I` on Windows), select **Console**, and run:

```js
sessionStorage.setItem('timon:diagnostic:agent-editor', '1')
```

Open **Agents → New agent**, click **Name**, type a short test name, then try
Tab and the other fields. Filter the console by `[TIM-0021]` and copy those
lines for support. If the shortcut does not open developer tools, report that
to support. Note the installed version, Windows display scaling, and whether
the issue also happens with the browser panel closed. The trace records element
types, focus, hit testing and the name's length, never field contents or typed
characters. Nothing is sent automatically. Collection stops after 150 records
per editor opening; reopen it for another attempt.

To disable collection, close the editor and run:

```js
sessionStorage.removeItem('timon:diagnostic:agent-editor')
```

The flag belongs to the current window session. No diagnostic is collected
unless explicitly enabled.

## Codex is not connected

Run `codex login` under the same OS account that runs Timon, then retry your
message. Setup displays a sign-in warning and lets you check again after login.
`timon doctor` shows the credentials path checked by the daemon:
`CODEX_AUTH_DIR/auth.json` when configured, otherwise `.codex/auth.json` in
that account's home. If you signed in under a different home, configure
`CODEX_AUTH_DIR` for the daemon to point to the directory containing that file.

Timon needs a readable authentication file for subscription login. If your CLI
stores credentials only in the OS keyring, sign in with file storage (the same
command works in Bash, zsh, PowerShell and the Command Prompt):

```bash
codex -c cli_auth_credentials_store=file login
```

An existing `CODEX_API_KEY` or `OPENAI_API_KEY` also allows launch when stored
in Timon's secrets vault in inject mode and granted to the agent (or its project).
A daemon environment key is available to missions only with the explicit
`secrets.inheritEnv` setting enabled; this setting inherits the entire daemon
environment. A variable set only in your terminal may not reach a service or
desktop application. Setup and the diagnostic check the main agent's access. The diagnostic checks local credential availability; it
does not contact the provider or verify whether a session has expired.

## Codex fails with "env: node: No such file or directory"

Codex installed with npm runs on Node.js. Timon launches it with the folder it
was found in and with the Node.js it finds on the machine (nvm, Volta,
nvm-windows, Homebrew, `~/.local/bin`, the PATH). When none is found,
`timon doctor` and the diagnostic report name the CLI: install Node.js.

The same Node.js runs Timon's own tools inside a Claude session: without it,
Claude reports that `mcp__timon_ask__request` was not found.

## Codex on Windows: commands "blocked by policy" (TIM-0062)

On Windows, a Codex agent in read-only (plan) or workspace-write mode runs its
shell commands inside Codex's own Windows sandbox. Timon starts every Codex
mission with the **unelevated** sandbox, whatever `[windows] sandbox` says in
your own `~/.codex/config.toml`: it needs no administrator rights, shows no
UAC prompt, and leaves the sandbox accounts of your own Codex untouched.

If a mission still reports `blocked by policy` or a `CreateProcess` error,
update Codex (`npm install -g @openai/codex`) and collect a diagnostic (see
above). Do not switch the agent to full access to work around it: that removes
the sandbox instead of fixing it.

## Codex on Windows: a Kanban task cannot commit (TIM-0121)

In auto or acceptEdits mode, a Codex agent works in Codex's workspace-write
sandbox. On Windows that sandbox keeps the repository's `.git` folder read-only:
the agent edits the files of its task, then `git commit` is refused. A `code` or
`merge` task needs to commit, so on Windows give those tasks to Codex in
**bypassPermissions** mode (full access: no sandbox), or run them on another
backend, for example with `timon series role set --scope code --backend claude`.

Review and merge do not follow the coder: a series role or a task override
changes one task type only. When you move the coder off Codex, move `review`
and `merge` too (`--scope review`, `--scope merge`). If a review or a merge
then blocks on a sandbox failure while its code ran on another backend, the
"Task blocked" notification says so and gives these two commands.

## Windows: Timon does not start after a password change (TIM-0107)

Timon's background task waits for a small file in `%USERPROFILE%\.timon\run` that only your Windows account can open. Resetting the account password, or rebuilding the profile, can make it unreadable: the task shows **Running**, but Timon never answers and `daemon.log` keeps saying `waiting for the first logon since boot`.

Opening the Timon app repairs it by itself. Without the app, run `timon service repair` in a normal (not administrator) terminal, signed in as the same user. `timon service status` says whether the file opens (`session witness: opens`) and, when it does not, why (`cause: …`); a service installed by this version also writes that cause once to `daemon.log`, before `waiting for the first logon since boot`.

## The daemon keeps restarting with "disk I/O error" (TIM-0109)

Timon could not read or write its database: the disk is full, read-only or returning errors. The daemon log (`~/.timon/tmp/daemon-<date>.log`) has a `[storage]` line with the database path and the free space left; the daemon then waits a minute and its supervisor starts it again. This holds whether the disk fails at startup or while Timon is already running.

Free some space on the disk that holds `~/.timon` (`timon doctor` shows `free disk space`), and check the system log for disk errors. Timon starts again by itself once the disk works. On Linux, the restarts are spaced out up to 5 minutes; `systemctl --user restart timon-desktop-…` (the unit `timon service status` names) retries at once.

## Docker: "network … not found" when starting a project's containers (TIM-0104)

The containers were created on a Docker network that no longer exists. **Start** recreates them with `docker compose up -d` on the networks of the project's current Compose file. If the error persists, the Compose file still refers to the missing network: correct it, then click **Rebuild** in the Docker widget. When the Compose file has moved or been deleted, run `docker compose up -d` yourself in the project directory.

## Web app stops during startup

When the web app port is occupied, Timon waits for it to be released: it
checks again after a few seconds, then every 30 seconds for as long as it
takes, and starts the web app as soon as the port is free. After about a
minute it raises one alert, "The web app stopped starting"; it does not repeat
it. The daemon log includes the address and, when the operating system tools
are available, the listener PID. Timon does not terminate or adopt an
unidentified listener. Close a previous Timon instance or the conflicting
application, or change `app.listen.port` (then relaunch Timon).

A clean exit (code 0 without a signal) receives up to two automatic retries
with backoff during a supervision session. A third clean exit stops automatic
restarts and produces an alert. A crash still receives bounded retries. Include the exit code,
signal and preceding startup logs when reporting either problem. A rebuild
is only suggested when the app build is missing or incomplete; packaged
users should reinstall a complete package in that case.

Once the cause is fixed, the web app starts again without restarting the
daemon, so running missions keep going: reopen the desktop app (it does this
by itself when the interface does not answer), or run `timon app restart`
in a terminal on the machine that runs Timon.

## The desktop says the daemon does not answer, yet it is starting

A packaged daemon verifies its installation, loads its plugins and checks each provider before it listens. On a managed work PC (antivirus scanning every file, a Microsoft Entra profile), that can take two or three minutes. Since the version that follows 0.1.5, the desktop waits up to three minutes for the background service, five minutes after an update, and says "still starting" rather than reporting a failed update.

If the window stays empty after that: run the support diagnostic (tray icon). Its **Daemon** block says whether nothing listens on the port (the daemon is down: read the end of `daemon.log`), or whether a Timon process holds the port without replying (it is still starting, or busy: wait, then open the window again from the tray). Adding the Timon folders to the antivirus exclusions shortens the start: see [Slow start behind an antivirus](#slow-start-behind-an-antivirus).

## "The Timon background service is slow to start" at the end of setup (TIM-0158)

At the end of the first setup, the window hands over to the background service that setup installed. The desktop waits 90 seconds for it, and on Windows up to five minutes while its `TimonOrchestrator` task is still running. If the service still does not answer, setup goes on with the daemon built into the window and shows this message. Nothing is lost and there is nothing to do: as soon as the service is ready, the window hands over to it by itself, within 30 minutes, showing a starting screen for as long as the service takes to start. Otherwise it takes over at the next launch of Timon.

In the diagnostic report, a last result of `0x800710e0` for the task means "an instance was already running": Windows refused to start the task a second time because it was already running. It is not an error.

## "The background service is not running" (TIM-0154)

The window waited two minutes for the interface and nothing listens on the daemon's port. Timon has already tried to start the daemon once more (the background service, or its built-in daemon) before showing this message. The message gives the folder of the logs, usually `.timon/tmp` in your user folder: send its `desktop-*.log` and `daemon.log` with the diagnostic (tray icon). On Windows, also check that the `TimonOrchestrator` task exists and is enabled in Task Scheduler.

## Slow start behind an antivirus

At every launch, the desktop app checks that the files of its installation are intact before it starts anything, and the background service does the same when it starts. Each file is read in full: an antivirus that scans every read can stretch this to a minute on a managed work PC. Since the version that follows 0.1.5, a small **Checking the installation…** window shows while it runs, instead of an app that seems frozen.

Excluding the Timon folders from real-time scanning shortens the start. The check itself still runs on every launch.

| Folder | What it holds |
| --- | --- |
| The installation folder: `%LOCALAPPDATA%\Programs\Timon` by default, `C:\Program Files\Timon` for an installation for all users, or the folder you chose in the installer | The app and its daemon |
| `%USERPROFILE%\.timon` | Your data, and the copy of the daemon the background service runs |

With Microsoft Defender: **Windows Security › Virus & threat protection › Manage settings › Exclusions › Add or remove exclusions › Add an exclusion › Folder**, once per folder. On a PC managed by your organisation, exclusions are usually set by the IT department: send them these two folders. On macOS and Linux, the same applies to a third-party antivirus: exclude `Timon.app` (or `/opt/Timon`) and `~/.timon`.

## Windows: an antivirus quarantined the background task

Up to version 0.1.9, Avast and AVG could flag the `TimonOrchestrator` task (the file `C:\Windows\System32\Tasks\TimonOrchestrator`, with a detection name such as `CMD:Heur.BZC.WBO.Boxter`) and move it to quarantine. Timon then no longer starts at boot or when you sign in, and runs only while its window is open.

The versions that follow start the task without any script, which these antiviruses do not flag. If yours removed the task:

1. Update Timon, and open it once: it updates the task, with one Windows permission prompt.
2. In the antivirus, open its quarantine (in Avast or AVG: **Menu › Quarantine**). Restore the `TimonOrchestrator` file, or add an exception for it, so the antivirus does not remove it again. If you prefer an exception for a folder, add the Timon installation folder (`%LOCALAPPDATA%\Programs\Timon` by default).
3. Run `timon service install` in Timon's terminal, or in PowerShell, and allow the permission prompt. It writes the task again and starts it. Opening Timon also offers to reinstall a missing task.

To check the result, open **Task Scheduler**: `TimonOrchestrator` is listed and **Running**. `%USERPROFILE%\.timon\tmp\daemon.log` then ends with a `starting the daemon` line.

## Windows: a console window opens every few minutes

A black console window (Command Prompt, PowerShell or `node.exe`) opens on its own, about every five minutes, and closing it stops Timon. The `TimonOrchestrator` task was changed after Timon registered it, usually with **Run only when user is logged on** selected in Task Scheduler: it then starts a console program in your session.

1. Run `timon doctor`. Its **Findings** list has a line that starts with "A console window opens on this PC" when the task is in this state (`windows-task-console` in the diagnostic report). `timon service status` shows the same verdict on its `console` line, next to the task's `logon` and `action`.
2. Repair the task from **Settings › System › Installation**: the service status reads "A console window opens: repair the background task". Choose **Repair the service** and allow the Windows permission prompt. When the daemon the app is connected to is that task itself, the page shows the command to run instead: run `timon service install` in Timon's terminal or in PowerShell, and allow the prompt. Either way, Timon registers a task that opens no window. Opening Timon also offers this repair at launch, once per version: if you declined it, Timon asks again only after the next update.
3. Choose when the task runs with `timon service session-mode session` (it starts when you sign in and stops when you sign out) or `timon service session-mode always` (it starts at boot and keeps running after you sign out). If Windows does not keep `always` for your account, as on some work or school PCs, Timon registers the session task instead and says so; see [Windows](windows.md#desktop-installer).

Do not change the task in Task Scheduler afterwards: switch with `timon service session-mode` or **Settings › System › Installation** instead.

## Windows: updating while the background service runs

The installer pauses the `TimonOrchestrator` task and ends its daemon before replacing the files, with the Windows permission prompt when it is granted and without it otherwise. If an older installer left Timon failing at launch (for example "ffmpeg.dll was not found"), close every `Timon.exe` from Task Manager, run the installer again, then start the task from Task Scheduler or reopen Timon.

Before it replaces anything, the installer checks that nothing of Timon still runs: no program of the installation, and nothing listening on the daemon's port. When something does, it stops there:

- **With its window**, it says "Timon is still running in the background and could not be stopped". Choose **Retry** and allow the Windows permission prompt; without that permission, a background service that keeps running when you are logged out cannot be ended. **Cancel** leaves the installed version as it is. Restarting the computer and running the installer again also works.
- **From Timon's update window** (no installer window), Timon opens again on the current version and tells you the update was not installed. Install it again and allow the permission prompt.

The installer stops the same way when it could not make that check at all: "The check that Timon is stopped in the background did not run: Windows PowerShell failed". It uses Windows PowerShell for it, and installs nothing over a Timon it could not look at. Choose **Retry**, or restart the computer and run the installer again. If the message comes back every time, Windows PowerShell (`powershell.exe`) or its scripts are blocked on this computer, usually by your organisation's policy: ask its administrator to allow the Timon installer, and send the diagnostic report.

What the installer found and ended is written to `%USERPROFILE%\.timon\tmp\timon-service-pause.log`, and the diagnostic report includes it.

### "The running daemon is not the installed version"

After an update, the background service was still running the previous version (0.1.8 and earlier could leave it so: the installer did not end it). Timon now restarts the service itself, once, with one Windows permission prompt, then goes on with the update. If you refuse the prompt, or the service does not come back, the message names both versions: quit Timon, restart the computer, then open Timon again. Timon does not start the service again over a previous daemon it could not end: the message then says that a Timon program is still running; end `node.exe` and `Timon.exe` from Task Manager, or restart the computer, then open Timon again. Your data are not changed by any of this.

On 0.1.8 or earlier, restart the computer, then open Timon; or quit Timon and, in an administrator PowerShell, end the daemon and start the task again:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*\resources\orchestrator\dist\boot.js*' -or $_.CommandLine -like '*\resources\app\*' } | ForEach-Object { taskkill /F /T /PID $_.ProcessId }
Start-ScheduledTask -TaskName TimonOrchestrator
```

## The LLM quotas widget says Codex is not signed in

The Codex gauge reads the sign-in the Codex CLI saved on this machine (`~/.codex/auth.json`, or the folder `CODEX_AUTH_DIR` names) and never renews it itself. When that sign-in is missing, unreadable, expired or refused by OpenAI, the widget shows Codex as not signed in instead of an error.

- Run `codex login` in a terminal, as the user that runs Timon, then press ↻ on the widget. A Codex mission also renews an expired session on its own.
- If your Codex configuration keeps the sign-in in the system keyring (`cli_auth_credentials_store = "keyring"` or `"auto"`), Timon cannot use it, for missions or for the gauge: sign in with `codex -c cli_auth_credentials_store=file login` instead.
