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

### When it starts

The first event, **App started**, leaves about 10 seconds after Timon starts, before any screen. The setup screen **Choose your LLM** says that statistics are sent, with a **Turn them off** link that switches them off at once; you can also do it later, see [Turning statistics off](#turning-statistics-off). After that, events wait in a short queue and leave in the background every 10 seconds.

### What is sent

Every event carries the same few facts, and nothing else about you or your computer:

| Sent with every event | Values |
|---|---|
| Where it comes from | the Timon service, the desktop app or the web app |
| Timon version, and how it was installed | for example *0.1.8*; the installed app or Timon run from its source code |
| Operating system and processor type | Windows, macOS or Linux; x64, arm64… |
| Licence tier | Free, Beta, Pro… never the key, nor whose it is |
| How long ago Timon was installed | in ranges: the same day, 1 day, 2–7, 8–30, 31–90, more than 90 days |
| The rank of the account, for an event a person caused | 1 for the first account created on this installation, 2 for the next…, never the account itself |
| The random identifier of this installation | see [Who you are to us](#who-you-are-to-us) |

The events themselves, each with exactly what it adds:

| Event | When | What it adds |
|---|---|---|
| App started | each start of Timon, once | how Timon runs (as a service, inside the desktop app, or on its own), the edition, whether the previous run ended normally, with an error, or without a trace, and how long starting took |
| App updated | the first start on a new version | the previous and the new version |
| Desktop app opened | each launch of the desktop app | its version |
| App opened | when a person opens the app, at most once a day per account | whether setup is finished, and how long loading took, in ranges |
| Page viewed | each time you open another part of the app | which part, from a fixed list (for example *Agents* or *Settings*), and *plugin* for any other page; never the rest of the address |
| Error in the app | an error in a part of the app, at most once a minute per part | which part, never the error |
| Setup step | each setup step completed, skipped or failed; each confirmation code for the first account sent or not | the step, what happened, and who you said you use Timon for (*for me*, *for my team or company*, *for my agency or my clients*) once answered; for the code, whether it was a resend, or why it was not sent from a fixed list (*no internet connection*, *email service unavailable*, *too many emails*, *address refused*, *asked again too soon*…); for the first account, whether it was confirmed with its code or made from the command line. Never the address or the code |
| Setup screen | each screen of the setup shown, and how you left it | the screen (for example *Choose your LLM*), and whether you went on, went back or it was skipped; on *Choose your LLM*, your choice (*subscription* or *local models*), the AI provider found ready if it ships with Timon (any other is *other*), or why none was (*not installed*, *signed out*, *list unreachable*). Never a key or an address. The screens before your account is created are sent too, with no account rank |
| Who you use Timon for | when an account answers or changes it | that answer, nothing else |
| Mission started, mission ended | each mission | the AI provider and model, where the mission comes from (you, a task, a routine, a trigger, another agent, a workflow, a plugin or Timon itself), whether another mission started it; at the end, whether it completed, failed or was stopped, and why from a fixed list (usage limit, stopped, timeout, crash) |
| Turn started, turn completed | each agent turn | the provider, model and origin, whether a person's message came from the app or a messaging channel (never which one); at the end, how it ended, how long it took, and how many days after installation it ran |
| Tokens used | each turn that reports them | how many tokens were read, written, read from cache and spent reasoning, as numbers |
| Tools used | the end of each turn, one per tool | the provider, the name of a **built-in** tool (for example the file editor or the terminal; any other tool is *other*), and how many times it ran |
| Usage limit reached | an AI subscription reaching its limit, at most every 30 minutes per provider | the provider, the window (*5 hours*, *7 days*) and the kind of limit |
| Backup provider used | an agent moving to its backup AI provider | the provider it left and the one it moved to |
| Request answered | an agent's question, plan or permission request answered or expired | the kind of request, whether it was allowed, refused or expired, who resolved it (you or Timon), and how long it waited, in ranges; for a permission, the built-in tool concerned. Never what it asked |
| Task created, changed, completed | each Kanban task created, changing status, deleted or done | its kind (code, review, merge…), its pipeline and status; when done, how long it took in ranges, a review's verdict and whether the work was merged. Never its title |
| Plugin | a plugin installed, removed, turned on or off | which plugin if it ships with Timon, otherwise only *third party* |
| Licence | a licence activated, renewed or lost | what happened, and why from a fixed list (expired, revoked…) |
| Built-in browser | a recording or an annotation action | the kind and the action (for example *start* or *stop*) |
| Feature used | each use of a listed feature: creating or deleting an agent, a project, a routine, a workflow, a trigger, a pipeline, a skill, an MCP server, a secret, a memory rule or a team; activating a licence; turning on backups; running a workflow or a pipeline; forking or interrupting a mission; dictating… | the feature, who used it (a person, an agent or the command line), whether it worked, and when it did not a short fixed code (for example *not found*, *account limit reached*) — never the error message |
| Operation failed | any server error inside Timon | the part of Timon (for example *agents*), the feature if it is listed, a fixed cause (*timeout*, *network*, *disk full*, *database busy*…), and the status an outside service answered (for example 429) |
| First step reached | once per installation for each: first agent, project, routine, workflow, completed turn, completed task | the step |
| Daily summary | once a day | how many agents, projects, routines (and how many are on), workflows, MCP servers, skills, accounts, teams and plugins; which AI providers your agents use; the size class of your computer (for example *16–32 GB* of memory, *5–8* processor cores); who you use Timon for |
| Licence page | the plans shown, the purchase link opened, an account refused because of the licence | what happened, and from where (for example the licence page or a banner) |
| Statistics turned off or on | when you change the setting | on or off, and whether the app or the configuration file changed it |

The AI model is sent only when it is one of the models Timon lists for that provider; any other is *other*, as is a provider you added yourself. A plugin you installed yourself is only ever counted as *third party*, never by name. Each event is checked against this list before it leaves: an event with anything else in it is dropped, never sent.

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

- **Settings → System → Privacy**: on the **Share anonymous usage statistics** row, click **Turn off** (or **Turn them off** on the setup screen). It takes effect at once, without restarting: what was waiting is dropped, one last message says you turned it off, and nothing leaves after it. An administrator of your Timon can change it; an agent cannot.
- In `timon.config.json`: `"telemetry": { "enabled": false }`. This wins over the setting in the app.
- The environment variable `TIMON_TELEMETRY=0`. This wins over everything else, and nothing is sent at all, not even the last message.

A value that is neither a clear yes nor a clear no (`"telemetry": { "enabled": "maybe" }`) is read as **off**. When the configuration file or the environment decides, the row in Settings says which one and offers no button; changing it from the app answers where to change it.

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
| Mission history: your messages, the agents' answers, the tools they ran and what those tools returned, including the content of files they read | the database `timon.db`, and `archive/events.db` if you turned on archiving | 180 days after the mission's last activity, see [Keeping less](#keeping-less) |
| Raw memory facts: short notes agents take after a mission, before the memory curation turns some into rules | the database, and `agents/<name>/memory/learnings.jsonl` (with `learnings.archive.jsonl`) | forever by default, see [Keeping less](#keeping-less) |
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

Open **Settings › System › Privacy**. The **Kept on this computer** card has one row for each kind of history, with how long it is kept; **Change** sets the number of days, and the row's **…** menu offers **Keep everything** and **Back to the default**. Timon deletes what is past the limit once a day.

- **Mission history** (`TIMON_EVENTS_RETENTION_DAYS`, **180 days** by default): when a mission has had no activity for that many days, its messages, tool calls and outputs are deleted for good, archived history included, along with their text in the history search. A whole mission goes at once: a conversation you came back to keeps its beginning. A mission still running, or one an open Kanban task or a running workflow still needs, keeps its whole history. The mission stays in the list with its title, first message and summary, but its conversation can no longer be read and its timeline can no longer be rebuilt: opening it says the history was deleted and after how many days. If you write in it again, the new messages follow a line saying the earlier ones were deleted.
- **Raw memory facts** (`TIMON_LEARNINGS_RETENTION_DAYS`, **kept** by default): facts older than that many days are deleted for good, from the database and from each agent's `learnings.jsonl` files. Memory rules are not affected.

0 keeps everything. You can also set them in `timon.config.json`:

```json
{ "settings": { "TIMON_EVENTS_RETENTION_DAYS": 365, "TIMON_LEARNINGS_RETENTION_DAYS": 180 } }
```

An environment variable of the same name wins over both, and the row then says so. The first pass on a large history deletes in small batches and can take several minutes; Timon keeps working meanwhile.

### Erasing everything

- An agent's memory: delete the agent, then empty it from the trash (**Settings › System › Backups & trash**). Its memory rules and memory files go with it; the raw facts it noted stay with its project until `TIMON_LEARNINGS_RETENTION_DAYS` removes them.
- Everything: quit Timon and delete the Timon folder. Your backups are in it too, unless you moved them elsewhere.
