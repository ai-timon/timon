---
title: Privacy and what Timon sends
sidebar_position: 9
---

Timon runs on your computer, and your agents' work stays there. Three things leave it for the Timon team, each for its own reason:

- [**usage statistics**](#usage-statistics), anonymous and optional, so we know what to fix first;
- [**your email address and its codes**](#your-email-address), so a verification or reset code can reach you;
- [**licence data**](#your-licence), so your licence key works on this computer.

What your agents send to the AI providers you connect goes to those providers, under their own terms, and never through us.

## Usage statistics

Timon can send **anonymous usage statistics** to the Timon team: which features are used, how often agent turns succeed, where setup stops. They tell us what to fix first. Sharing is **on by default** and you can turn it off at any time.

Only the installed app sends them. Timon run from a source checkout sends nothing.

### What is sent

Each event carries the Timon version, your operating system and processor type, and your licence tier (Free, Beta…). An event caused by a person also carries the rank of their account on this installation (1 for the first account created, 2 for the next…), never the account itself. The events themselves are:

- the app starting, being updated, and the desktop app being opened;
- the app being opened by a person, at most once a day per account;
- which part of the app you open (for example *Agents* or *Settings*), never the rest of the address: no agent, project or mission name;
- features being used (creating an agent, a project, a routine, a workflow, adding an MCP server…), whether by a person, an agent or the command line, and whether it worked, with a short fixed code when it did not (for example *not found*, *account limit reached*, *timeout*, or the status code an outside service answered, such as 429) — never the error message itself;
- once a day, a summary of the installation in numbers: how many agents, projects, routines, workflows, MCP servers, skills, accounts and plugins, which AI providers your agents use, and the size class of your computer (memory and processor cores, for example *16–32 GB* and *5–8 cores*);
- the licence page being viewed and its purchase link being opened, and an account that could not be added because of the licence;
- whether the previous run of Timon ended normally or not, and how long starting and loading the app took;
- an AI subscription reaching its usage limit (which provider and which window, for example *5 hours*);
- when an agent asks you a question or a permission: what kind of request, whether it was allowed, refused or expired, and roughly how long it waited — never what it asked;
- tasks being completed: their kind, roughly how long they took, a review's verdict and whether the work was merged;
- the first time you reach a step such as your first agent, project or completed task, and how many days ago Timon was installed, in ranges;
- that an error happened in a part of the app (for example *Agents*), never the error itself;
- each setup step you complete or skip;
- missions and agent turns: when they start and end, how long a turn took, whether it succeeded, how many tokens it used, which AI provider ran it, and how many days after installation the turn ran (a number of days, never a date);
- which **built-in** tools agents used (for example the file editor or the terminal), as counts;
- task, plugin, licence and built-in browser actions: what kind of action, never what it acted on.

The AI model is sent only when it is one of the models Timon lists for that provider. A plugin you installed yourself is only ever counted as "third party", never by name.

### What statistics never contain

- your prompts, the agents' answers, your files or any other content;
- the names of your projects, agents, skills, routines or MCP servers, and the names of their tools;
- paths, web addresses and commands;
- error messages;
- your email, user name, account or computer name;
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
