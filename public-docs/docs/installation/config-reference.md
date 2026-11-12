---
title: Configuration reference
sidebar_position: 11
---

<!-- Generated file. Do not edit by hand. Run npm run gen:config. -->

Generated from the configuration schema and the loader's environment override table. Defaults below are parsed from an empty configuration, before edition presets, user values and environment overrides. Nested defaults account for parent prefaults (the app port is 3100).

`TIMON_HOME` selects the data directory; it is not a schema field. A dash means no direct bootstrap environment override is declared for that field. Registry settings use their own names as environment keys. The installation-directory default is described rather than copied: it is wherever the running daemon's code lives, so a packaged install needs no value.

| Key | Type | Default | Description | Environment |
| --- | --- | --- | --- | --- |
| `version` | 1 | 1 | Configuration schema version. | — |
| `profile` | "linux-desktop" &#124; "linux-server" &#124; "macos" &#124; "windows" | "linux-desktop" | Host platform profile. | — |
| `edition` | "expert" &#124; "lite" | "expert" | Requested edition; the effective edition remains constrained by the licence. | — |
| `workspacesRoot` | string | Not set | Working folder of the agents created during onboarding; when unset, they use the workspace folder inside the Timon home. | — |
| `daemon` | object | See child fields | Daemon process and listener configuration. | — |
| `daemon.listen` | object | See child fields | Network listener configuration. | — |
| `daemon.listen.host` | string | "127.0.0.1" | Listener address; use loopback for local-only access. | — |
| `daemon.listen.port` | integer | 3000 | TCP listening port. | `PORT` |
| `daemon.listen.extraHosts` | string[] | [] | Unauthenticated extra listener addresses, for a container bridge only (e.g. 172.17.0.1). | — |
| `daemon.installDir` | string | Directory of the running daemon's code | Absolute orchestrator installation directory; defaults to where this daemon's own code lives. | `TIMON_INSTALL_DIR` |
| `daemon.supervisor` | "systemd-user" &#124; "launchd" &#124; "windows" &#124; "none" | "systemd-user" | Operating-system supervisor responsible for the daemon. | — |
| `daemon.heapMb` | integer | 4096 | Maximum Node heap size in MiB. | — |
| `daemon.auth` | "auto" &#124; "required" &#124; "off" | "auto" | Daemon authentication mode; auto requires authentication as soon as the daemon or the web app listens off loopback, or behind a TLS proxy. | — |
| `daemon.trustedProxies` | string[] | [] | Peer addresses trusted to supply forwarded client addresses. | — |
| `daemon.behindTlsProxy` | boolean | false | Force secure session cookies when HTTPS terminates at a reverse proxy. | — |
| `host` | object | See child fields | Host capabilities and binary configuration. | — |
| `host.docker` | "auto" &#124; "required" &#124; "disabled" | "auto" | Container capability policy. | — |
| `host.traefik` | boolean | true | Whether a Traefik deployment is available. | — |
| `host.gui` | "auto" &#124; "disabled" | "auto" | Native graphical integration policy. | — |
| `host.binaries` | object | {} | Binary names mapped to absolute paths; null uses PATH discovery. | — |
| `host.isolation` | object | See child fields | Requested mission filesystem restrictions. | — |
| `host.isolation.filesystem` | "auto" &#124; "off" | "auto" | Requested mission filesystem confinement mode; availability depends on the host launcher. | — |
| `host.isolation.deny` | string[] | [] | Additional paths requested to be hidden from missions. | — |
| `host.isolation.readOnly` | string[] | [] | Paths requested to remain visible but read-only. | — |
| `host.isolation.allow` | string[] | [] | Paths exempted from filesystem masking. | — |
| `host.isolation.runAs` | string &#124; null | null | Reserved OS-account isolation option; non-null values are currently refused by the runtime. | — |
| `host.isolation.egress` | object | See child fields | Outbound network proxy offered to missions. | — |
| `host.isolation.egress.mode` | "log" &#124; "off" | "off" | Outbound proxy for missions: off (no proxy, no connection journal, the default), or log each connection per mission without blocking. | — |
| `host.isolation.egress.host` | string | "127.0.0.1" | Loopback address the egress proxy listens on. | — |
| `host.isolation.egress.port` | integer | 0 | Egress proxy port; 0 lets the system choose a free one. | — |
| `app` | object | See child fields | Web app served as a daemon-managed child process. | — |
| `app.enabled` | boolean | false | Whether this feature is enabled. | `TIMON_APP_ENABLED` |
| `app.listen` | object | See child fields | Network listener configuration. | — |
| `app.listen.host` | string | "127.0.0.1" | Listener address; use loopback for local-only access. | — |
| `app.listen.port` | integer | 3100 | TCP listening port. | `TIMON_APP_PORT` |
| `app.publicUrl` | string | "http://timon.localhost" | Public URL through which users reach the web app. | — |
| `modules` | object | {} | Bundled module IDs mapped to enabled state or module-specific options. | — |
| `plugins` | object | {} | Third-party manifest IDs mapped to enabled state or plugin options; absent installed plugins are enabled. | — |
| `developer` | object | See child fields | Developer-mode preferences. | — |
| `developer.unsignedPlugins` | boolean | Not set | Developer mode: allows unsigned plugins when `true`, on Free as on a paid licence; a licence with a fixed plugin composition still refuses them. Unset or `false` refuses them. | — |
| `pluginPolicy` | object | See child fields | Operator ceilings on third-party plugin capabilities. | — |
| `pluginPolicy.spawn` | object | See child fields | Approval and rate limits for plugin mission spawning. | — |
| `pluginPolicy.spawn.max` | integer | 5 | Maximum missions one plugin may spawn in a window; zero denies spawning. | — |
| `pluginPolicy.spawn.windowMs` | integer | 3600000 | Time window in milliseconds. | — |
| `pluginPolicy.spawn.approved` | string[] | [] | Plugin IDs explicitly approved to spawn missions. | — |
| `pluginPolicy.spawn.autoApproveSigned` | boolean | true | Approve signed and built-in plugins that declare missions:spawn without listing them in approved. | — |
| `pluginPolicy.spawn.denied` | string[] | [] | Plugin IDs refused mission spawning, even when signed or listed in approved. | — |
| `pluginPolicy.exec` | object | See child fields | Allowed binaries for plugin host execution; built-in denials still apply. | — |
| `pluginPolicy.exec.allow` | string[] | [] | Operator allowlist; an empty list refuses access. | — |
| `pluginPolicy.kanban` | object | See child fields | Operator grants for plugin access to the Kanban. | — |
| `pluginPolicy.kanban.projects` | object | {} | Plugin ID to the project slugs its jobs may read tasks of; an absent plugin reads none. | — |
| `pluginPolicy.http` | object | See child fields | Allowed outbound hostnames; a wildcard covers subdomains only. | — |
| `pluginPolicy.http.allow` | string[] | [] | Operator allowlist; an empty list refuses access. | — |
| `pluginPolicy.http.byPlugin` | object | {} | Plugin ID to the hostnames that plugin alone may reach, on top of the shared allowlist. | — |
| `pluginPolicy.http.connectionApproval` | "admin" &#124; "owner" | "admin" | Who approves the destination of a user's plugin connection: an administrator, or its owner. | — |
| `authThrottle` | object | See child fields | Credential endpoint back-off and lockout policy. | — |
| `authThrottle.enabled` | boolean | true | Whether this feature is enabled. | — |
| `authThrottle.maxAttempts` | integer | 5 | Failed credential attempts allowed before lockout. | — |
| `authThrottle.windowMs` | integer | 900000 | Time window in milliseconds. | — |
| `authThrottle.lockoutMs` | integer | 60000 | Initial credential lockout duration in milliseconds. | — |
| `authThrottle.maxLockoutMs` | integer | 3600000 | Maximum credential lockout duration in milliseconds. | — |
| `authThrottle.trustProxy` | boolean | false | Use forwarded client addresses for throttling only behind a proxy that rewrites them. | — |
| `secrets` | object | See child fields | Secret injection and master-key storage preferences. | — |
| `secrets.inheritEnv` | boolean | false | Allow missions to inherit the daemon environment instead of the restricted system and granted-secret set. | — |
| `secrets.keyring` | "auto" &#124; "off" | "auto" | Store the vault master key in an available OS keyring, or use the local key file. | — |
| `ui` | object | See child fields | Instance UI visibility and home preferences. | — |
| `ui.hidden` | string[] | [] | UI zone identifiers hidden by instance configuration. | — |
| `ui.home` | "cockpit" &#124; "chat" &#124; "kanban" | "cockpit" | Initial application destination. | — |
| `telemetry` | object | See child fields | Anonymous usage statistics sent to the Timon team. | — |
| `telemetry.enabled` | boolean | Not set | Share anonymous usage statistics: true or false. Unset follows the app setting (on by default); any other value turns sharing off without invalidating the file. The TIMON_TELEMETRY environment variable overrides it. | — |
| `settings` | object | {} | Registry overrides keyed by setting name; environment overrides still take precedence. | Same key as each registry setting |

Record-valued fields accept arbitrary keys within their declared value type. Module and plugin entries accept a boolean, `"auto"`, or an options object with optional `enabled`; registry values accept strings, numbers and booleans. See [Configuration](configuration.md) for precedence and safe installation examples.
