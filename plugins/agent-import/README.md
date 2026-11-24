# Agent import

Built-in Timon plugin, written on the public plugin SDK only. It brings agents
from another tool (Hermes, Grok Bot, another agent tool, another Timon) into
Timon: an archive is staged, previewed, then applied. Tools that cannot export
on their own get the `timon-export` skill (below).

**Naming rule (the maintainer, 03/11/2026).** No text a user reads — UI, public docs,
CLI, CHANGELOG, error messages, the skill, this README (it ships in the
package) — names another product or sends to its tools. Details in
`docs/PROGRESS.md` and `docs/PLUGINS.md`.

Built in and enabled by default (`orchestrator/builtin-plugins.json`).
User guide: `public-docs/docs/usage/import-agents.md`.

## The assistant

Source → preview → result, in the plugin's settings category and in a dialog
opened from `agents.toolbar` (Agents and Bots pages) and `onboarding.agent`.
The preview lets the user rename each agent, pick its role (`research` by
default), project and working folder, and leave out its identity, memory,
skills, MCP servers, routines or team. Choices travel as `options` with
`preview` and `apply` once the engine answers `ready: true`
(`ImportRequest`, `AgentChoice` in `src/contract.ts`); only the fields the user
changed are sent, and « Import » waits for the preview of the last change.

The zip goes to `stage` as a binary body (`sendArchive` in `src/client.tsx`),
which the app relays as bytes up to 50 MiB (TODO #804). An app older than that
relay refuses it before the daemon, and the assistant says the upload is not
available.

## Routes (`/api/plugins/agent-import/…`)

The import routes need a signed-in account allowed to create agents
(`agents:manage`); otherwise 401 / 403.

| Route | Body | Answer |
|---|---|---|
| `POST stage` | the zip itself, `Content-Type: application/zip` (or `application/x-zip-compressed`, `application/octet-stream`), 50 MiB at most | `201 { token, sha256, size, expiresAt }` |
| `POST preview` | `{ "token": "…", "options"?: ImportOptions }` | `{ archive, preview, ready: true }`, `preview.projects` listing the projects an agent may be put on (`[{ slug, name }]`, empty when they cannot be read); `422 invalid_manifest` without a valid manifest |
| `POST apply` | `{ "token": "…", "options"?: ImportOptions }` | spends the token, re-checks the SHA-256, then `{ agents, warnings }`, agent by agent |
| `POST discard` | `{ "token": "…" }` | `{ discarded: true }` |
| `GET hermes` | — | `{ found, label?, profiles: [{ name, displayName }] }`: the Hermes installation of the daemon's machine, never a path |
| `POST hermes/stage` | `{ "profiles"?: ["default", "coder"] }` (all when absent) | `201 { token, sha256, size, expiresAt }`, then `preview` / `apply` as above; `404` when Hermes or a profile is not found |
| `GET export-skill` | — | the `timon-export` skill (`text/markdown`, `Content-Disposition: attachment; filename="SKILL.md"`) |

| `GET agents` | — | `{ agents: [{ name, role, project }] }`: what the account may export |
| `POST export` | `{ "agents": ["name", …] }` (1 to 100) or `{ "all": true }` | the zip itself (`application/zip`), `X-Timon-Agents: <count>`; `404 not_found` for an unknown agent, `413 too_large` past one manifest |

`agents` and `export` need an account allowed to READ agents (`agents:read`
or `agents:manage`), not to create them; `ctx.agents.export` (permission
`agents:export`) checks it again, and gives only the team and the routines
the account sees.

The token is single-use, bound to the account that staged it, valid one hour,
and travels in a JSON body only. Five stagings per account at most.

## The manifest: `timon-agent-import` v1

The archive holds `timon-agent-import.json` at its root (`manifest.ts`, zod,
every object strict). The engine reads nothing else: an adapter turns its
source into this format. Evolution rule: a new field is optional; a field
whose meaning changes bumps `version`. Everything in it is untrusted text:
stored for agents to read, never run, and a secret travels by NAME only.

`ImportOptions` (in `contract.ts`): `prefix` (instead of the source app's),
and per agent (`sourceRef`) `include`, `name`, `role`, `project`, `cwd`, the
boxes of `IMPORT_ELEMENTS` (`soul`, `memory`, `skills`, `mcp`, `routines`,
`team`) and `keepRoutinesActive`.

## What an import does, per agent

Through the plugin facades only: `ctx.skills.put` (text-only skills,
`allowed-tools` removed), `ctx.mcpServers.put` (public `http` only, no
secret), `ctx.agents.create` / `update` (skills, MCP servers, team),
`ctx.agents.docs.put('SOUL.md')`, `setAvatar`, `ctx.memory.rules.add` (scope
agent, 64 at most), `ctx.triggers.create` (one `schedule` trigger per routine,
cron and time zone from `schedule-map.ts`, its instruction passed `raw`),
`ctx.agents.teams` (one team per group).

- **Routines** are imported switched off. One on at the source stays on only
  when the user chose `keepRoutinesActive` for that agent (a switch on its
  card, off by default; the preview counts them in `activeRoutines`), and the
  operator approved the plugin to start tasks — otherwise it is switched off
  with a warning. An archive alone never schedules a task.

- **Names**: `<source>.<key>`; `import.<key>` when `<source>.` already names
  another writer's agents (Hermes Gateway); `-2`, `-3`… when a name is taken.
- **Rollback**: when a step fails, the agent and what was written for it are
  removed, the next agents go on. A created agent is purged
  (`ctx.agents.delete(name, { purge: true })`, API 15): nothing of it lands in
  the agent trash. A team made for it is removed too
  (`ctx.agents.teams.delete`). A failed **re-import** gives back the prompt,
  the identity documents it wrote (`SOUL.md` and the others), the text of the
  skills it rewrote and the agent's team. Not restored, because the facades
  do not read them: the directives, settings (role, project, folder, backend,
  model, memory scope), picture, checked skills and MCP servers, and the
  address of an MCP server it rewrote. The routines of the previous import are
  removed only once the new record is written.
- **Re-import**: the store maps `source app + sourceRef + account` to the
  agent, with the fingerprint of `SOUL.md` and `system-prompt.md`. Records of
  agents, skills and MCP servers carry the account that ran the import
  (`ownerUserId`): another account importing the same source gets its own
  agent (`-2`), skill and server, never an update of the first one's. A
  superadmin reaches any account's import (the oldest when several). A record
  written before the owner existed is nobody's: only a superadmin builds on it. The same source updates
  that agent (followed through a rename); an agent changed by hand since —
  a write by anybody else, or a document that no longer matches — is skipped,
  and the preview says so.
- Left out, and said in the preview: `stdio` and local MCP servers, skills
  with companion files or scripts, `once` routines, deliveries, history,
  secrets (names listed), what the caller's account may not write.

## Secrets in MCP servers

Whatever the source, an MCP server's address and command line pass through
`src/redact.ts` (the same code for the Hermes source and the preview): the
value of a secret goes, its name joins the list of secrets to enter again.

- **Address**: user info (refused), query parameters whose name looks like a
  secret (`token`, `key`, `secret`, `password`, `auth`, `session`, `sig`…:
  `SECRETISH`), and path segments that start like a known credential
  (`sk-`, `ghp_`, `xoxb-`, `AKIA…`, `ya29.`: `BARE_TOKEN`, listed as
  `URL path token`). The server is created without them.
- **Command line** of a `stdio` server (never created, only shown): the
  program's name without its folder; the value of a secret-looking flag
  (`--api-key=<redacted>`, `--token <redacted>`), of a `NAME=value` whose name
  looks like a secret, and any argument that starts like a known credential.

**Known limit.** The masking reads names and prefixes, it does not guess: a
secret written as a bare positional argument with no known prefix
(`serve a1b2c3d4…`), or after a flag whose name says nothing
(`--workspace q9w8…`), or in a path segment without a known prefix, is shown
as it is in the preview's warning. Such a server is not created, and nothing
is stored from its command line; the test
`known limit: a secret with no telling flag…` (`agent-import-hermes.test.ts`)
pins this behaviour.

## Sources

The archive holds `timon-agent-import.json`, or another tool's export that a
source adapter (`src/sources/`) recognises. An adapter declares `detect` (the
files that identify it), `wants` (every file it reads) and `accepts`; the
engine reads the zip with its deny list and ceilings, hands the filtered tree
to `toManifest(tree)` — a pure function, no disk, no network — and validates
what comes back as any manifest. What the reader left out (secrets, links,
files too large) is added to the warnings.

- **An older export format** some tools wrote (in `src/sources/`,
  detected by its own manifest file at the root, `agents/<key>/…`), read
  silently under the « Grok Bot, Hermes or another agent » card; its errors
  say « agent export », and an export that names no app gives agents named
  `import.<key>`: name, title and description →
  `SOUL.md`; memories → agent rules; picture (PNG, JPEG, WebP, checked by its
  bytes); text-only skills (a skill with scripts or other files is listed,
  not imported); routines (`hourly`, `daily`, `weekdays`, `weekly`,
  `monthly`, `interval`, `custom`, `advanced` → `schedule-map`; `once`
  left out); Grok Bot groups (`channels`) → teams, their lead, instructions,
  routines and memories named in a warning; working files (`files/`) never
  read. Agents are named `<source app>.<key>` (`grok-bot.ada`). The format's
  own ceilings are not imposed. Written from the description of the format,
  none of its code.

## The `timon-export` skill

`skills/timon-export/SKILL.md` (Agent Skills format: front matter `name`,
`description`, then the body), written from scratch for Timon: no other
product's skill or code is read or reused. It tells
the agent of another tool how to find its agents (Hermes: the active
folder, `$HERMES_HOME` or the standard one, then the root that holds every
profile, as Hermes resolves it, so that a run from a named profile still
lists them all and keeps each one's name; a profile per agent; Grok Bot:
the Bots and groups it sees, or itself; any other tool: itself), to ask which
ones to export, to write `timon-agent-import.json` v1 with its fields and
ceilings, secrets by name only, then `timon-agents-<app>-<date>.zip` in the
Downloads folder (`.zip.part` then renamed), or attached to the conversation
when it works on a computer that is not the user's (Grok Bot).

- **Same identity as Hermes direct**: `source.app` `hermes`, `sourceRef`
  `profile:<name>`, key and name as `hermes/manifest.ts` makes them, so the
  card and the skill update the same agent. Grok Bot: `grok-bot`,
  `grok-bot:<id or key>`.
- **Shipped inside `lib/index.js`** (`src/export-skill.ts`, esbuild
  `--loader:.md=text`): an installed package carries `lib/` only. Served by
  `GET export-skill` to the accounts that may import; the card's « Download
  the export skill » and `timon agent export-skill [--out FILE]` read it there.
- **Kept honest by a test** (`agent-import-export-skill.test.ts`): the json
  block after `<!-- timon-export:example -->` passes `parseManifest` and
  `readManifestFromZip` as shipped, covers every object the skill asks for,
  and every schedule its table lists parses; the route test checks that
  `lib/index.js` serves the very bytes of `SKILL.md` (rebuild `lib/` after
  editing it).

## Hermes direct

`src/hermes/`: the daemon finds `~/.hermes` (Linux, macOS) or
`%LOCALAPPDATA%\hermes` (Windows) and its `profiles/<name>` by itself —
`HERMES_HOME`, which a service does not inherit, is not read — reads each
profile through the folder reader, and `hermesToManifest` (pure) builds the
manifest: one agent per profile (`default` → "Hermes"), `SOUL.md` without
its HTML comments, `memories/USER.md` / `MEMORY.md` split on `§` into
`preference` / `decision` rules, text skills under `skills/[category/]<name>/`
(not those of `.bundled_manifest`, not hidden folders), `cron/jobs.json` jobs
as routines (`script` / `no_agent` jobs skipped), `config.yaml` MCP servers
(http created, stdio shown with secrets redacted), model and deliveries as
labels, the NAMES of the `.env` variables (a narrow reading of its own: the
values are never decoded), history flagged as not imported.

In the assistant, `src/sources/hermes-client.tsx` occupies `agentimport.source`
like any adapter: it calls `GET hermes` (nothing painted when Hermes is not
found, or the call is refused), lists the profiles, all checked, and hands
`POST hermes/stage { profiles }` to `submitStaged('hermes', …)`; the preview
is the normal one. Its failures read `errors.hermes.*` (`failureOf('hermes/stage', …)`),
not the words of a sent archive. The CLI: `timon agent import --hermes
[profile…]` (`orchestrator/bin/cli-agent-transfer.mjs`), then the same
preview, question, `--yes` and `--json` as for a zip.

This is a stated exception: it reads the disk, which no third-party plugin
may do, so it cannot be rewritten as an unprivileged plugin until the SDK has
a hook for declared readable roots.

## What an export carries

`src/export.ts`, per agent: the system prompt, `directives`, the identity
documents (`docs`, `SOUL.md` kept verbatim on import), the active rules of
kind preference / decision / pitfall, the non-product skills (text), the MCP
servers — `http` with its address stripped of user info, query and fragment,
`stdio` by name only (no command or arguments), header and variable NAMES as
`secretNames` — the routines (cron, time zone, on/off), the picture, the team
(a group) and `hints` (`backend`, `model`, `role`, `project`, `cwd`, `main`).
`sourceRef` is `timon:<random id of this instance>:<name>`. The manifest is
checked by the import schema before it leaves; past 10 MiB it is rebuilt
without the pictures, then refused.

On import, a source `cwd` is used when it exists here; otherwise the preview
proposes `cwdSuggestion` (the source's trailing folders under this home) and
the agent has none until the user picks it. A backend or model missing here
is said (`backendMissing`, `modelMissing`) and left out; a setting Timon
refuses (directory outside every project, unknown project) falls back to the
defaults with a warning.

## Extending it

- **Source adapters** register a component in the list socket
  `agentimport.source` (`client.slots: ["agentimport.source"]`) and read
  `useAgentImport()` from `@timon-ai/plugin-agent-import/hooks` (bundle it,
  keep `react` external). `registerSource({ id, label, accepts, description?, action? })`
  lists the source as a card (a zip source gets its file button; `action:
  { label, run }` adds a button of its own, as the built-in card does for the
  export skill); a source
  that stages through its own route calls `submitStaged(id, stage)`, a zip
  picked elsewhere goes through `submitFile(id, file)`.
  A third-party adapter cannot hand a `toManifest` to the engine yet (TODO
  #808): it converts in the browser and calls `submitFile` with a zip of the
  manifest, as `examples/plugin-agent-import-source` does. Full contract:
  [Slots](../../public-docs/docs/plugins/slots.md), under `agentimport.source`.
- **Event** `agent-import:applied@1`: one per agent imported, with
  `sourceRef`, `agent`, `origin` and `sourceApp`.

## Build

`npm run build` (esbuild) writes `lib/`. `lib/` is committed: the daemon and
the tests load it as shipped.
