---
title: Configuration
sidebar_position: 7
---

Timon reads `timon.config.json` from its data directory, normally `~/.timon`. Set `TIMON_HOME` to select a different instance directory. This is a process environment variable, not a JSON configuration key.

For a source installation, create the directory and write the following JSON, replacing the example paths with existing absolute paths on your machine:

```json
{
  "version": 1,
  "profile": "linux-desktop",
  "edition": "expert",
  "daemon": {
    "installDir": "/path/to/timon/orchestrator",
    "listen": {"host": "127.0.0.1", "port": 3000},
    "supervisor": "systemd-user"
  },
  "host": {"docker": "disabled", "traefik": false},
  "app": {
    "enabled": true,
    "listen": {"host": "127.0.0.1", "port": 3100},
    "publicUrl": "http://127.0.0.1:3100"
  }
}
```

Use `profile: "macos"` and `supervisor: "launchd"` on macOS, or `"windows"` for both on Windows. Use `linux-server` for a Linux server. For Docker features, change `host.docker` as needed; do not enable both app serving modes.

## Where Timon keeps its files

Timon keeps everything in one data directory, the *Timon home*. In these docs `~` means your user folder: `/home/<user>` on Linux, `/Users/<user>` on macOS and `C:\Users\<user>` on Windows, which Windows also names `%USERPROFILE%`. Set `TIMON_HOME` to use another directory.

| What | Linux | macOS | Windows |
|---|---|---|---|
| Timon home | `~/.timon` | `~/.timon` | `%USERPROFILE%\.timon` |
| Configuration file | `~/.timon/timon.config.json` | `~/.timon/timon.config.json` | `%USERPROFILE%\.timon\timon.config.json` |
| Agents (`config.json`, `system-prompt.md`, `memory/`) | `~/.timon/agents/<name>/` | `~/.timon/agents/<name>/` | `%USERPROFILE%\.timon\agents\<name>\` |
| Project settings and memory (not your source code) | `~/.timon/projects/<slug>/` | `~/.timon/projects/<slug>/` | `%USERPROFILE%\.timon\projects\<slug>\` |
| Default working folder of the agents created during setup | `~/.timon/workspace/` | `~/.timon/workspace/` | `%USERPROFILE%\.timon\workspace\` |
| Installed plugins | `~/.timon/plugins/` | `~/.timon/plugins/` | `%USERPROFILE%\.timon\plugins\` |
| Custom LLM backends | `~/.timon/backends/<id>.json` | `~/.timon/backends/<id>.json` | `%USERPROFILE%\.timon\backends\<id>.json` |
| Logs (one file per day: `daemon-<date>.log`, `desktop-<date>.log`) | `~/.timon/tmp/` | `~/.timon/tmp/` | `%USERPROFILE%\.timon\tmp\` |
| Service output before the daemon starts | systemd journal: `journalctl --user -u timon-orchestrator` | `~/.timon/tmp/daemon.log` | `%USERPROFILE%\.timon\tmp\daemon.log` |
| Backups | `~/.timon/backups/` | `~/.timon/backups/` | `%USERPROFILE%\.timon\backups\` |
| A provider's per-conversation folders (what lets a conversation resume) | `~/.timon/provider-runs/` | `~/.timon/provider-runs/` | `%USERPROFILE%\.timon\provider-runs\` |
| Downloads a provider's CLI shares across conversations (Codex's plugin catalog and plugins) | `~/.timon/provider-cache/` | `~/.timon/provider-cache/` | `%USERPROFILE%\.timon\provider-cache\` |

Your projects' source code stays where you keep it; an agent's `cwd` is an absolute path to that folder, for example `/home/<user>/projects/<slug>` on Linux or `C:\Users\<user>\projects\<slug>` on Windows. Archives in `backups/` are written every night by the backup, on by default (see [Backups and the agent trash](../usage/settings.md#backups-and-the-agent-trash-system)). Deleted agents wait in `trash/agents/` until restored or purged.

A conversation's folder in `provider-runs/` is kept for 30 days after the conversation ends, so it can be resumed (the `TIMON_PROVIDER_SESSION_TTL_MS` setting). What its CLI downloads and can download again lives once in `provider-cache/`, shared by every conversation, and is removed from the folder of a finished conversation right away. Deleting `provider-cache/` is safe: the next conversation downloads it again.

Setup does not ask for a working folder. The main orchestrator and the agents created with it start in the `workspace` folder of the Timon home, which Timon creates when needed. A configuration you write yourself, as in the source installation above, can point them to another existing absolute folder with the optional `workspacesRoot` key. An agent that already has a working directory keeps it.

## Resolution order

The loader merges the edition preset with your file, then applies schema defaults and supported environment overrides. Your file wins over the preset. Arrays are replaced, not concatenated.

Registry settings resolve in this order: **environment → `settings` in the file → saved UI setting → default**. The UI shows the source, so a value controlled by the environment or file cannot be changed by saving another UI value.

`modules` controls bundled modules; `plugins` controls third-party plugins by manifest ID. Values can be `true`, `false`, `"auto"` or an options object with `enabled`. Plugin toggles recompose the loader without a daemon restart. Changes to daemon addresses, host configuration or process environment require an operator-managed restart.

:::warning Paths and credentials
Set `daemon.installDir` explicitly for source installations. Keep API credentials out of this file; use plugin secret settings or the secrets vault. Never disable authentication on a non-loopback listener.
:::

See the generated [configuration reference](config-reference.md) for every field, default and direct environment override.
