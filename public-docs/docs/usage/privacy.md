---
title: Privacy and what Timon sends
sidebar_position: 9
---

Timon runs on your computer, and your agents' work stays there. A few things leave it for the Timon team, each for its own reason:

- [**usage statistics**](#usage-statistics), anonymous and optional, so we know what to fix first;
- [**your email address and its codes**](#your-email-address), so a verification or reset code can reach you;
- [**licence data**](#your-licence), so your licence key works on this computer;
- [**the agency offer**](#the-agency-offer), only if you ask for it.

What your agents send to the AI providers you connect goes to those providers, under their own terms, and never through us. What Timon keeps on your own computer is described in [What Timon keeps on your computer](#what-timon-keeps-on-your-computer).

## Usage statistics

Timon can send **anonymous usage statistics** to the Timon team: which features are used, how often agent turns succeed, where setup stops. They tell us what to fix first. Sharing is **on by default** and you can turn it off at any time.

This applies however you installed Timon: the installed app and Timon run from its source code both send them, and both turn them off the same way (see [Turning statistics off](#turning-statistics-off)).

### What is sent

Each event carries the Timon version, whether it is the installed app or Timon run from source, your operating system and processor type, and your licence tier (Free, Beta…). An event caused by a person also carries the rank of their account on this installation (1 for the first account created, 2 for the next…), never the account itself. The events themselves are:

- the app starting, being updated, and the desktop app being opened;
- the app being opened by a person, at most once a day per account;
- which part of the app you open (for example *Agents* or *Settings*), never the rest of the address: no agent, project or mission name;
- features being used (creating an agent, a project, a routine, a workflow, adding an MCP server…), whether by a person, an agent or the command line, and whether it worked, with a short fixed code when it did not (for example *not found*, *account limit reached*, *timeout*, or the status code an outside service answered, such as 429) — never the error message itself;
- once a day, a summary of the installation in numbers: how many agents, projects, routines, workflows, MCP servers, skills, accounts and plugins, which AI providers your agents use, and the size class of your computer (memory and processor cores, for example *16–32 GB* and *5–8 cores*);
- the licence page being viewed and its purchase link being opened, and an account that could not be added because of the licence;
- whether the previous run of Timon ended normally or not, and how long starting and loading the app took;
- an AI subscription reaching its usage limit (which provider and which window, for example *5 hours*);
- an agent moving to its backup AI provider when its own one is unavailable: which provider it left and which one it moved to, nothing else;
- when an agent asks you a question or a permission: what kind of request, whether it was allowed, refused or expired, and roughly how long it waited — never what it asked;
- tasks being completed: their kind, roughly how long they took, a review's verdict and whether the work was merged;
- the first time you reach a step such as your first agent, project or completed task, and how many days ago Timon was installed, in ranges;
- that an error happened in a part of the app (for example *Agents*), never the error itself;
- each setup step you complete or skip, and who you said you use Timon for (*for me*, *for my team or company*, *for my agency or my clients*) when you answer or change it; that answer also comes with the setup steps and the daily summary;
- missions and agent turns: when they start and end, how long a turn took, whether it succeeded, how many tokens it used, which AI provider ran it, and how many days after installation the turn ran (a number of days, never a date);
- which **built-in** tools agents used (for example the file editor or the terminal), as counts;
- task, plugin, licence and built-in browser actions: what kind of action, never what it acted on.

The AI model is sent only when it is one of the models Timon lists for that provider. A plugin you installed yourself is only ever counted as "third party", never by name.

### What statistics never contain

- your prompts, the agents' answers, your files or any other content;
- the names of your projects, agents, skills, routines or MCP servers, and the names of their tools;
- paths, web addresses and commands;
- error messages;
- your email, user name, account or computer name, nor whether you asked for the agency offer;
- your licence key.

### Who you are to us

Nobody in particular. On its first event, Timon draws a random identifier and keeps it, with the moment it was drawn, in `telemetry.json` in the Timon folder (see [Where Timon keeps its files](../installation/configuration.md)). It is not derived from your computer, your account or your licence. Delete the file and the next event comes from a new, unrelated identifier.

That identifier is not the only one, though. Like any server, the statistics server sees the network address each event comes from, and the program name Timon announces with it (for example *Timon/0.1.8* on *Windows*). Timon never puts your address in an event, but the server uses it on its side: with the program name, it works out its own visitor and visit identifiers, so that events sent close together count as one visit, and from the address alone an approximate location (country, city).

### Turning statistics off

Any one of these stops all sending:

- **Settings → System → Privacy**, untick **Share anonymous usage statistics**. Turning it off sends one last message that says you turned it off, and nothing after. An administrator of your Timon can change it; an agent cannot.
- In `timon.config.json`: `"telemetry": { "enabled": false }`. This wins over the setting in the app.
- The environment variable `TIMON_TELEMETRY=0`. This wins over everything else, and nothing is sent at all, not even the last message.

A value that is neither a clear yes nor a clear no (`"telemetry": { "enabled": "maybe" }`) is read as **off**. When the configuration file or the environment decides, the switch in Settings shows it and cannot be moved from there.

Sending never slows Timon down: statistics wait in a short queue, are sent in the background, and are dropped if the network does not answer.

## Your email address

Separately from usage statistics, Timon sends your email address to the Timon team, which emails you the 6-digit codes your account needs:

- **when you create your local account**: your address, the verification code, the language of the app (so the email is in it) and the installation identifier below;
- **once your address is confirmed**: your address and the installation identifier, so that a reset code can reach that address later;
- **when you use Forgot password**: your address, the reset code, the language and the installation identifier.

So the code you type in Timon does pass through our server, which needs it to write the email. Your password never leaves your computer, and the account itself stays local.

To recognise your installation, Timon keeps a random identifier in the `install-id` file of the Timon folder. It is not the usage-statistics identifier, and it is never sent with statistics. Turning usage statistics off does not change this: confirming your email needs it.

## Your licence

When you enter a licence key, and then regularly while it is active, Timon sends the Timon team what it needs to tie the key to this computer and to count the computers it is used on:

- the licence key;
- a random identifier of this installation, kept in the `device-id` file of the Timon folder;
- a fingerprint of this computer: the SHA-256 hash of the identifier your operating system gives the machine, never that identifier itself;
- the Timon version.

On activation, Timon also sends your operating system (Windows, macOS or Linux) and the short name of the computer (the part before the first dot, at most 32 characters), so that you can tell your computers apart in the list of machines that use your key. If you give this computer a name of your own in Timon, that name is sent too.

None of this travels with usage statistics, and turning them off does not change it: your licence needs it. Removing the licence from this computer tells the server, with the key and the installation identifier only, that the seat is free again.

## The agency offer

If you said you use Timon for an agency, the setup screen and **Settings › Profile** offer to email you the agency offer. Nothing is sent unless you tick the box yourself; it is a consent of its own, separate from usage statistics, so it is sent even when statistics are off.

When you ask for it, Timon sends the Timon team, and nothing else:

- the email address you entered, in lowercase;
- that you use Timon for an agency;
- the language of the app, so the email is in it;
- the Timon version;
- the date of the consent text you accepted.

The team uses that address to send you this offer only. If your computer is offline, the request waits and is sent when Timon next starts or is back online. Timon keeps, in the Timon folder, your address while the request waits or is active, and a withdrawal token the server returns; neither ever goes into usage statistics.

To withdraw, open **Settings › Profile**: the **Agency offer** row shows whether you are subscribed, and **Withdraw** tells the Timon team to stop. If you are offline, the withdrawal waits and is sent as soon as possible.

## What Timon keeps on your computer

Everything below stays in the Timon folder (`~/.timon`, or `%USERPROFILE%\.timon` on Windows; see [Where Timon keeps its files](../installation/configuration.md#where-timon-keeps-its-files)). None of it is sent to the Timon team. It is stored in plain text: anyone who can read your user folder can read it.

| What | Where | How long |
|---|---|---|
| Mission history: your messages, the agents' answers, the tools they ran and what those tools returned, including the content of files they read | the database `timon.db`, and `archive/events.db` if you turned on archiving | forever by default, see `TIMON_EVENTS_RETENTION_DAYS` below |
| Raw memory facts: short notes agents take after a mission, before the memory curation turns some into rules | the database, and `agents/<name>/memory/learnings.jsonl` (with `learnings.archive.jsonl`) | forever by default, see `TIMON_LEARNINGS_RETENTION_DAYS` below |
| Memory rules: the instructions Timon gives your agents | the database | until you delete them |
| The list of missions, with their first message, title and summary | the database | as long as the Timon folder |
| A provider's own conversation files (for example Codex's), which let a conversation resume | `provider-runs/` | 30 days after the mission ends (**Provider sessions kept after a mission ends**) |
| Files attached in chat | the Timon folder | 30 days after the mission ends (**Chat attachments kept after a mission ends**) |
| Mission timelines | the database | 90 days (`TIMON_TRACE_SPANS_RETENTION_DAYS`) |
| Logs and copies of the prompts sent to agents | `tmp/` | 14 days (`TIMON_LOG_RETENTION_DAYS`) |
| Backups | `backups/` | see [Backups and the agent trash](settings.md#backups-and-the-agent-trash-system) |

The command-line programs of your AI providers (Claude Code, Codex…) also keep their own history in their own folders, under their own rules: Timon does not manage those.

### Deleting a memory rule

When you delete a memory rule, its text goes too: the memory journal keeps that a rule was deleted, and when, but no longer what it said. The same holds for the old wording of a rule you or the memory curation rewrite. The agents the rule reached start a fresh conversation at their next mission (see [Removing or rewriting a memory rule](agents.md#removing-or-rewriting-a-memory-rule)).

### Keeping less

Two settings delete old history once a day. Both are **0 by default**, which keeps everything: nothing is deleted until you set them.

- `TIMON_EVENTS_RETENTION_DAYS`: the mission history older than this many days is deleted for good, archived history included, along with its text in the history search. A mission still running keeps its whole history. The list of missions stays.
- `TIMON_LEARNINGS_RETENTION_DAYS`: raw memory facts older than this many days are deleted for good, from the database and from each agent's `learnings.jsonl` files. Memory rules are not affected.

Set them in **Settings → System → Logs & retention**, or in `timon.config.json`:

```json
{ "settings": { "TIMON_EVENTS_RETENTION_DAYS": 365, "TIMON_LEARNINGS_RETENTION_DAYS": 180 } }
```

An environment variable of the same name wins over both. The first pass after you set them can take a while on a large history; Timon keeps working meanwhile.

### Erasing everything

- An agent's memory: delete the agent, then empty it from the trash (**Settings › System › Backups & trash**). Its memory rules and memory files go with it; the raw facts it noted stay with its project until `TIMON_LEARNINGS_RETENTION_DAYS` removes them.
- Everything: quit Timon and delete the Timon folder. Your backups are in it too, unless you moved them elsewhere.
