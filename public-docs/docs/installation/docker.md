---
title: Docker
sidebar_position: 6
---

Docker is an optional way to run the **web app and workers**. The daemon and CLI backends still run on the host. Agent working directories must therefore be host paths, not `/workspace` paths.

## Prepare the host

Complete the host setup for your OS first. Keep `app.enabled: false` when Compose serves the app: otherwise two app processes may compete for the same port.

The supplied Compose file uses the `docker` profile for `app`, `telegram-poll`, `reply-worker` and `tts`. It expects an external `traefik_network`, a local `.env`, and a shared Timon home. Inspect the file for your installation before launching it.

1. Copy `.env.example` to `.env` and configure the values for your installation without committing credentials. The remote API refuses plain HTTP unless you [allow it](#plain-http-on-the-remote-api).
2. Set `TIMON_HOST_HOME` to the host daemon's data directory; Compose mounts it at `/data/.timon`.
3. Set the app and reply worker's `ORCHESTRATOR_URL` to the daemon address reachable from containers. The supplied file uses `http://host.docker.internal:3001`; this must match your daemon. The schema's default daemon port is 3000.
4. Confirm the reverse-proxy network exists and that the daemon's listener is reachable from the bridge, with authentication enabled. A host loopback listener is not automatically reachable through a bridge gateway.
   The embedded browser joins the network set in **Settings → Access & network → Browser → Browser docker network** (`TIMON_BROWSER_NETWORK`, default `traefik_network`) and creates it if it is missing.

From the checkout root, in your own terminal:

```bash
docker compose --profile docker up -d --build app
docker compose --profile docker ps
```

The supplied app routes include `timon.localhost`. Use the hostname actually configured in your reverse proxy. Start optional workers only when their corresponding integration is configured; do not run both container and daemon-managed copies of the same worker.

## Settings the containers do not read

Containers take their configuration from `.env`, not from **Settings**. One setting only applies to what the daemon launches itself, so it has no effect on a container:

| In Settings | In `.env` | Container |
|---|---|---|
| **Allow remote access over HTTP** | `TIMON_ALLOW_HTTP` | `app` |

Change the value in `.env`, then recreate the container named in the table: `docker compose restart` does not reread the file.

```bash
docker compose --profile docker up -d app
```

## Plain HTTP on the remote API

The remote API (`/api/remote/*`) refuses plain HTTP by default: a request that did not come over HTTPS gets `426 Upgrade Required`. Without this refusal, the remote tokens and the master token (`TIMON_REMOTE_MASTER`) would cross the network in clear text. Only this API is concerned: the web interface still opens on the HTTP route.

Prefer HTTPS: see [Remote access to the web interface](remote-access.md). The request is accepted when the proxy in front of the app sends `X-Forwarded-Proto: https`, which the supplied Traefik labels do on their HTTPS routes and `tailscale serve` does too.

To accept plain HTTP anyway, uncomment this line in `.env`, then recreate the container as above. Do it only on a network you trust, or when HTTPS ends on a proxy that cannot set that header. The value must be exactly `1`.

```bash
TIMON_ALLOW_HTTP=1
```

This default only comes with a fresh copy of `.env.example`: an existing `.env` keeps its value. If yours sets `TIMON_ALLOW_HTTP=1` and you do not need it, remove the line and recreate the container.

## Persistent data

The current configuration uses a **bind mount**, not an anonymous container filesystem. Stop or replace a container without deleting that data directory. A Timon export excludes secrets; preserve those separately when moving an installation.
