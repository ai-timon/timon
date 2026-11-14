---
title: What your agents connect to
sidebar_position: 4.72
---

**The record is a witness, not a boundary.**

An agent works with the network: its backend's API, git, package registries, the web pages a task needs. Timon can keep, mission by mission, a record of the connections that go through Timon's proxy, and tell you when a mission reaches a host its project has never contacted. It is a record so you can see what left the machine. **Nothing is blocked.**

**This record is off by default.** Until you turn it on, no proxy runs, missions connect directly and nothing is recorded.

## Turn it on

Set `host.isolation.egress.mode` to `"log"` in [`timon.config.json`](../installation/configuration.md), then restart Timon:

```json
{
  "host": {
    "isolation": {
      "egress": {"mode": "log"}
    }
  }
}
```

The other keys of this block (the address and port of the proxy) are listed in the [configuration reference](../installation/config-reference.md); the defaults suit almost every installation.

With the record on, your missions' connections depend on this proxy. If missions start failing with network errors, turn it off: set the mode back to `"off"`, or remove the key, and restart Timon. Missions then start without the proxy variables and nothing more is recorded.

## What is recorded

With the record on, each mission starts with the standard proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY`) pointing to a proxy that Timon runs on your machine, reachable only from the machine itself. Every connection a mission opens through it becomes one line:

| Field | What it says |
| --- | --- |
| Method | `CONNECT` for an encrypted (HTTPS) connection, or the HTTP method of a plain-HTTP request. |
| Host and port | Where the mission connected. |
| Status | `200` when the connection was established; another code when the remote host or the network refused it. |
| Bytes | How much the mission sent, and how much it received. |
| Duration and error | How long the connection lasted, and the network error code when it failed (for example `ECONNREFUSED`). |

What a line never holds: the address path or query of a request, what was sent or received, and the mission's credentials. An HTTPS connection stays encrypted end to end: Timon sees the host name and the volume, never the content.

Connections to your own machine (`localhost`, `127.0.0.1`), Timon included, do not go through the proxy and are not recorded.

Timon keeps up to 2,000 lines per mission and 30 days of history, older lines are removed automatically.

## Read a mission's connections

From a terminal:

```bash
timon mission egress <mission_id>
timon mission egress <mission_id> --limit 50
```

The most recent connections come first, with a summary per host (number of connections, failures, volume) and the hosts this mission was the first of its project to reach. When there are more lines than fit on a page, the answer gives a `next_before` value: pass it with `--before` to read the previous page.

An agent reads the same list with the [`mission_egress` tool](agent-tools.md#the-timon-server), for example to check what another mission contacted.

You see the connections of the missions you can see: a mission of another account is answered as if it did not exist.

While the record is off, the command, the tool and the [**Mission network** widget](missions.md) say **Connection journal disabled** and how to enable it: an empty list would say nothing about what a mission reached. Lines recorded before you turned it off stay readable until they expire.

## New host alerts

With the record on, when a mission reaches a host that no mission of the same project has reached before, you receive an **Alert** in your [notifications](notifications.md), for example "New outbound host for project shop": it names the host and the agent, and gives the command that lists the mission's connections. An agent with no project is followed on its own.

- A host is new only once per project: the next missions of the project that reach it raise nothing.
- A mission that reaches many new hosts does not flood you: the first one alerts at once, the following ones are grouped into one alert every 15 minutes.
- The alert says what happened, it does not stop anything. If a host surprises you, read the mission's connections and its conversation, and stop the mission if needed.

## What it does not see

With the record on, it covers what goes through the proxy, and only that. Do not read an empty list as proof that a mission sent nothing.

- **A mission can also skip the proxy on purpose**: the variables are a convention, not a barrier. Any process can unset them or tell a tool to bypass them (for example `curl --noproxy`), and that connection is not recorded. An agent steered by content it read can do the same.
- **A program that ignores the proxy variables connects directly**, and leaves no line. Many tools follow them (curl, git over HTTPS, npm, pip), but not all: Node.js scripts using the built-in `fetch`, connections over SSH (`git@` remotes), and protocols other than HTTP are not recorded. Recent Node.js versions follow the variables when `NODE_USE_ENV_PROXY=1` is set in the environment Timon starts with; Timon does not set it for this record, because Node.js then prints a warning at the start of every script.
- **Plain `ws://` WebSockets do not work through the proxy.** Secure `wss://` WebSockets work and are recorded.
- **If your environment already sets a proxy** (`HTTP_PROXY` or `HTTPS_PROXY`, usually a company proxy), Timon leaves it in place so your missions keep working: their connections go through your proxy, and Timon records nothing for them. Timon also turns on `NODE_USE_ENV_PROXY=1` for itself and its missions (unless you set it), so Node.js programs use that proxy too, and adds the machine itself (`127.0.0.1`, `localhost`) to `NO_PROXY`; Node.js scripts then print a warning about an experimental proxy agent when they start.
- **On Windows and macOS, a proxy set only in the system settings** is not seen by Timon. If your network requires such a proxy and missions cannot connect, set `HTTPS_PROXY` (and `HTTP_PROXY`) in the environment Timon starts with, or turn the record off as shown above.
- **The content stays private, including to Timon.** A mission that sends data to a host it is expected to use (its backend's API, your git server) shows only as more volume towards that host, and a known host raises no alert.

To keep an agent from a resource, do not give it access in the first place: secrets it does not need, folders outside its project, MCP servers it should not call.
