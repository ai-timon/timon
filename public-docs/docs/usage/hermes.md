---
title: Hermes
sidebar_position: 12
---

Timon can run agents on **Hermes**, the agent from Nous Research. It drives the `hermes-acp` command over the Agent Client Protocol; Hermes keeps its own sign-in, and Timon never sees or stores it.

If your Hermes runs as a gateway, possibly on another machine, see [Hermes Gateway](./hermes-gateway.md) instead.

## Set it up

1. Install Hermes Agent by following Hermes' own documentation. What Timon needs is the `hermes-acp` command, reachable by the OS account that runs Timon.
2. Sign in, in a terminal, under that same account:

   ```bash
   hermes setup
   ```

   With a Nous Portal subscription, `hermes portal` signs in to Nous and picks a model in one step. On Windows, if `hermes` is not on your PATH, run `%LOCALAPPDATA%\hermes\bin\hermes.exe setup`. The **Sign in** button of the Hermes card, in the onboarding and in **Settings › AI models › Providers**, copies this command with the path Timon found. Do not start `hermes-acp` yourself to sign in: Timon starts it, and run by hand it opens nothing and only waits.

3. Restart Timon. **Hermes** then appears in the model selectors.

Timon looks for `hermes-acp` on the service's PATH, in `~/.local/bin` on Linux and macOS, and in `%LOCALAPPDATA%\hermes\bin` on Windows, which is where Hermes' installer puts it.

If Hermes does not appear, run `timon doctor`: it tells you whether the `hermes-acp` binary was found. A CLI installed anywhere else may be missing from the service's PATH; set `host.binaries.hermes-acp` to its absolute path in that case. If a mission stops with "sign in first", run `hermes setup` (or `hermes portal` for Nous) in a terminal on the machine that runs Timon (not `hermes-acp`, which only waits), then start the mission again.

## Models

Timon does not pick a model for Hermes: the default is Hermes' own. The model picker lists what your Hermes account offers — dozens of models on some accounts — and you can search it. The list is asked from Hermes and refreshed at most every 12 hours; opening it starts Hermes briefly, which leaves one empty session in Hermes' own history. A model change applies from the next session.

## What agents can do

Hermes **asks before it uses a tool**. The request appears as an **Allow / Deny** card, like on the other backends: **Allow** lets that one action through, **Deny** refuses it and Hermes carries on without it. When Hermes offers it, **Allow for this session** or **Always allow** lets Hermes remember the approval on its side; nothing is allowed wider unless you click one of them. On an autonomous mission with nobody to answer, a card left open ends in a refusal after the usual delay.

Replies stream into the chat, tool calls appear with their results, and Hermes' reasoning — which can be long — shows as a single collapsed **Reasoning** block. **Stop** in a chat ends the current turn and keeps the conversation. After a restart, the mission reopens its Hermes session without replaying the old messages. Timon's own tools (Kanban, questions, missions, memory) and the stdio MCP servers configured for the agent reach Hermes.

**Compacting a conversation** and its summary when you switch it to another model run on the agent's own model, as does Dreaming for a Hermes agent: Timon starts Hermes for a short session with none of Timon's tools, then stops it. Each run leaves one session in Hermes' own history. Tool requests Hermes makes during it are refused. Conversation titles are not generated with Hermes: Timon uses another of your backends, or keeps the first message as the title.

## Limitations

- **No answer in a fenced mission on Linux.** Hermes does its work (the model, its tools, the commands it runs) in a background process of its own, its gateway, which it starts and reaches through a Unix socket. The [mission fence](mission-isolation.md) refuses Unix sockets, so a fenced Hermes mission stops with "Gateway could not start". Timon does not start that gateway outside the fence for you: everything Hermes does would then run unfenced. To use Hermes in a fenced mission, add an exception that allows Unix sockets for its agent ([Exceptions](mission-isolation.md#exceptions)). Know what it opens: the mission reaches every Unix socket of your session, and if a Hermes gateway is already running for your account (the Hermes app, its terminal interface or its scheduled jobs started it), the mission uses that one, outside the fence. [Hermes Gateway](hermes-gateway.md) is the other way: it talks over HTTP to a gateway you start yourself, which the fence never covers either. Windows missions are not fenced, so Hermes is not affected there; macOS has not been checked yet.
- **Not yet tried on a tester's own account.** Timon was checked against the Hermes agent and a scripted stand-in, not a full session on your Nous account, so a first mission may still fail. Report what you see.
- **HTTP MCP servers are not passed on.** MCP servers you added over HTTP do not reach Hermes agents.
- **No live model switch.** A model change applies from the next session.
- **No quota gauge.** Timon does not display your remaining usage.
