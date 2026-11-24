---
title: Import agents
sidebar_position: 2.2
---

Bring the agents you already have elsewhere into Timon: from **Grok Bot**, **Hermes** or another agent tool through Timon's export skill, or from **another Timon**. You always see what will be created before anything is written.

## Open the import

- **Agents** page (or the foot of the **TIMs** list): **Import agents**.
- **Settings › Agent import**.
- During the first-run setup, at the agent step: **I already have agents elsewhere: import them**.

The import is a plugin that ships with Timon, on by default. If you do not see it, check that **Agent import** is on in **Plugins**.

## Choose a source

| Card | What to pick |
|---|---|
| **Hermes on the machine running Timon** | Nothing to export: tick the Hermes profiles to bring over, then **Import from Hermes**. Shown only when Timon finds Hermes on its machine. |
| **Timon agent archive (.zip)** | A `.zip` exported from another Timon (**Export** on its Agents page, **Export** in the menu of a TIM on the TIMs page, or `timon agent export`). See [Copy agents to another Timon](agents.md#copy-agents-to-another-timon). |
| **Grok Bot, Hermes or another agent** | The `.zip` that Timon's export skill writes in the other tool. Make it first, as below, then pick it here. |

### Get the export from Grok Bot or Hermes

Hermes on the machine running Timon needs none of this: use its card above. For Grok Bot, or Hermes on another machine: they do not export agents on their own, so Timon gives them a skill, `timon-export`, that does: it finds your agents, asks which ones to export, and writes one `timon-agents-<tool>-<date>.zip`. It never puts a secret value in the archive, only the names of the secrets.

1. Get the skill: **Copy the export skill** on the **Grok Bot, Hermes or another agent** card puts its text on your clipboard. From a terminal, you can write it to a file instead:

   ```bash
   timon agent export-skill --out SKILL.md
   ```

2. Paste it to the other tool and ask it to save it as a skill named `timon-export`:
   - **Hermes**: paste it in a conversation, or save it yourself in the folder of the profile you use (see **Hermes** below).
   - **Grok Bot**: paste it in a message to the Bot, or attach `SKILL.md` (see **Grok Bot (desktop)** below).
   - **Another agent tool**: add it as a skill if the tool has skills, otherwise paste it in the conversation.
3. Ask: *Export my agents for Timon*. Hermes saves the zip in your Downloads folder. Grok Bot works on a computer of its own: it attaches the zip to the conversation, download it from there.

Each Hermes profile becomes one agent, each Grok Bot Bot one agent, and each Grok Bot group a team. If a Grok Bot Bot can only export itself, ask each Bot in turn: you can import several archives one after the other.

**Grok Bot (desktop).** In Timon, choose **Copy the export skill**. Open the Bot you want to export, paste the instructions or attach `SKILL.md`, and ask: *Follow these instructions to export my agents for Timon. Ask me which agents to include, then attach the finished ZIP here.* To reuse the instructions, ask the Bot to save them as a private skill named `timon-export`. When the ZIP appears, hover over its message and choose **… › Download**. Select the ZIP in Timon and check the preview. If the Bot can only export itself, repeat with your other Bots. If it can only return text, ask for the complete export JSON, save it locally as `timon-agent-import.json` and zip that file at the top level of the archive.

**Hermes.** If Timon detects Hermes on the same machine, select the profiles under **Hermes on the machine running Timon**. On another machine, save the skill in the Hermes root (`~/.hermes` on Linux and macOS, `%LOCALAPPDATA%\hermes` on Windows): `skills/timon-export/SKILL.md` for the default profile, `profiles/work/skills/timon-export/SKILL.md` for a named profile such as `work`, then open that profile. If `HERMES_HOME` points to the profile's own folder, put it in `skills/timon-export/SKILL.md` inside that folder. Ask *Export my agents for Timon*, select the profiles to include, and bring the ZIP from that machine's Downloads folder to Timon. Run from any profile, the skill lists them all and keeps each one's name: importing a profile again, by ZIP or by the Hermes card, updates the same agent.

An archive is 50 MiB at most. Plugins can add more sources to this list.

### Hermes on the same machine

When Hermes is installed on the computer that runs Timon, this is the simplest way: Timon reads Hermes' own folder (`~/.hermes` on Linux and macOS, `%LOCALAPPDATA%\hermes` on Windows) and lists its profiles, all ticked. Untick the ones you want to leave, then **Import from Hermes**: the preview opens as for an archive.

- The card reads the machine where **Timon** runs, which may not be the one your browser is on. Hermes on another computer: make an archive there and pick it here.
- A Hermes folder moved with `HERMES_HOME` is not looked for: Timon runs as a service, which does not see that setting.
- Each profile becomes one agent: `hermes.default` for the main one, `hermes.<profile>` for the others. It brings its `SOUL.md`, its memories, its text-only skills, its scheduled jobs (switched off), and its MCP servers reached over HTTP. The model it used and its `.env` keys are listed by name, never their values.
- From a terminal: `timon agent import --hermes` (see [below](#from-a-terminal)).

## Check the preview

For each agent found, the preview shows what will happen (**create**, **update** or **skip**) and lets you:

- leave the agent out;
- change its name;
- pick its role (**Research** by default), its project (from the list of this Timon's projects) and its working folder;
- untick what it brings: **Identity (SOUL)**, **Memory**, **Skills**, **MCP servers**, **Routines**, **Team**. Each box shows how many items would be written;
- keep its routines active. Routines are imported **switched off** unless you turn on **Keep active the routines that run at the source** on the agent's card: an active routine starts tasks on its own, so check them first.

Warnings under each agent list what will not come over and why. After a change, the preview is refreshed before **Import** becomes available. Nothing is written until you confirm. The result then lists each agent: imported, updated or failed. A failed agent leaves nothing behind, and the others are still imported.

## What comes over

| From | Becomes in Timon |
|---|---|
| Name, title, description | The agent and its identity (`SOUL.md`) |
| Instructions | Its system prompt |
| Memories | Memory rules of the agent (64 at most) |
| Picture (PNG, JPEG, WebP) | Its picture |
| Skills made of text only | Skills attached to the agent |
| Routines: hourly, daily, weekdays, weekly, monthly, every N minutes, custom | Scheduled routines with the source's time zone, switched off unless you keep them active |
| MCP servers reached over HTTP | MCP servers attached to the agent, without their keys |
| Grok Bot groups | Teams with the same members |

Agents are named after the tool they come from: `grok-bot.ada`, `hermes.coder`, `timon.researcher`. When agents the import did not create already use that prefix, the import uses `import.` instead. A name already taken gets `-2`, `-3`…

Importing the same export again **updates** the agents it created, even if you renamed them since. From another Timon, a new export of an agent updates its copy too, even if the agent was renamed on that Timon in between. An agent you changed by hand in the meantime is skipped, and the preview says so. Another account importing the same export gets agents of its own: it never updates yours.

## What stays behind

- **Secret values.** API keys, tokens and passwords never travel. The preview lists their **names** so you can enter them again in the vault. A key found in an MCP server's address is removed from it, and masked in the preview.
- **Conversation history** and sessions.
- **Working files** of the other tool.
- **Deliveries** to Telegram, Discord or other platforms: connect them again in Timon if you need them.
- **MCP servers that run a command** on the machine: shown, not created. Add them by hand if you trust them.
- **Skills that carry scripts or extra files:** listed, not imported.
- **One-off routines** (run once at a date).
- For a Grok Bot group: its lead, instructions, routines and memories. A Timon team holds a name, members and a colour.

What your account may not write (skills, MCP servers, routines) is left out as well, and the preview says which.

## From a terminal

The same import runs from the command line. It accepts an archive from another Timon or one made by the export skill:

```bash
timon agent import timon-agents-hermes-2026-11-03.zip
timon agent import agents.zip --yes --prefix acme
```

Hermes installed on the machine running Timon needs no archive: `--hermes` reads all its profiles, or only those you name.

```bash
timon agent import --hermes
timon agent import --hermes default coder --yes
```

It shows the preview, then asks before writing anything. `--yes` imports without asking (for a script), `--accept-cwd` takes the proposed working folders, `--prefix` replaces the source's name prefix, and `--json` prints the result as JSON. Without `--yes` and without a terminal to answer in, nothing is imported. `timon agent export` writes the archive another Timon imports, `timon agent export-skill` prints the export skill: see [Copy agents to another Timon](agents.md#copy-agents-to-another-timon) and the [CLI reference](cli-reference.md).

Routines switched on at the source arrive **switched off** here too, and the preview counts them for each agent. To keep them on, say so: `--keep-routines` for every agent, or `--keep-routines-for` with the names the preview shows, separated by commas.

```bash
timon agent import agents.zip --keep-routines
timon agent import --hermes --keep-routines-for default,coder
```

## Who can import

Importing needs an account that can create agents. Attaching skills, MCP servers and routines also needs the matching rights; without them the agent is created and the preview says what was left out.
