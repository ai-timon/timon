---
title: Agents, messages, skills and MCP servers
sidebar_position: 13.8
---

A plugin that connects Timon to another system often has to manage what an agent *is*: give it a picture and a personality, rename or retire it, send it what comes in, read what it says back, hand it a skill or a tool server. This page covers those calls. Creating and updating agents (`ctx.agents.create`, `update`) is in [Permissions](permissions.md) and the `plugin-agent-sync` template. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-support",
  "apiVersion": 10,
  "permissions": ["agents:manage", "agents:docs:write", "messages:send", "messages:read", "events:subscribe", "agents:read"]
}
```

| Permission | Surface | Sensitive |
| --- | --- | --- |
| `agents:manage` | `ctx.agents.delete`, `rename`, `setAvatar`, and `memoryScope` on `update` | |
| `agents:manage` (API 15) | `skills`, `mcpServers`, `team` and `reportsTo` on `create` / `update`; `ctx.agents.teams.create` and `teams.delete` (`agents:read` for `teams.list`); `purge` on `ctx.agents.delete` | yes |
| `agents:docs:read`, `agents:docs:write` | `ctx.agents.docs.*`: an agent's identity documents (`SOUL.md`…), which are its instructions | yes |
| `agents:export` (API 15) | `ctx.agents.export(name)`: the portable definition of any agent the signed-in account may read (a stable `id` that a rename keeps, prompt, documents, settings, skills, MCP servers, team, picture, routines), to recreate it elsewhere. A request only; never a secret, log or transcript | yes |
| `messages:send`, `messages:read` | `ctx.messages`: the inbox of the agents you created | `read`: yes |
| `skills:read`, `skills:write` | `ctx.skills` | `write`: yes |
| `mcp-servers:read`, `mcp-servers:write` | `ctx.mcpServers` | `write`: yes |
| `backends:read` | `ctx.backends.list`: the backends and models available | |
| `agents:read` + `events:subscribe` | `agent_created`, `agent_updated`, `agent_deleted` events | |

**Sensitive** means the call changes or reads what an agent loads on every mission: its instructions, its tools, its conversations. Declare only what you use.

## Who you can reach

Every call is bounded by who is acting:

- **In a request** (a route of your plugin, a webhook, a callback), the signed-in account must hold the same right on its own account (for example `agents:manage` to delete an agent, `skills:manage` to write a skill). An anonymous request is refused.
- **In a job** (a timer, a listener), your plugin acts as itself and reaches only what it created. What belongs to a person or to another plugin answers `not_found`, as if it did not exist.
- A request from a **superadmin** lifts the "created by this plugin" limit. It never lifts the product's own rules: a product skill, a server Timon injects and the main orchestrator's seat stay out of reach.

Errors carry a `code`: `invalid`, `not_found`, `forbidden` and, for agents, `conflict`.

## Delete, rename, picture, documents

```js
await ctx.agents.rename('hermes.support', 'hermes.billing')           // the new PluginAgent
const url = await ctx.agents.setAvatar('hermes.billing', { mime: 'image/png', data: base64 })
await ctx.agents.update('hermes.billing', { memoryScope: 'AGENT' })   // NONE, SESSION, AGENT or GLOBAL
await ctx.agents.docs.put('hermes.billing', 'SOUL.md', 'You stay calm.')
await ctx.agents.delete('hermes.billing')                              // true, kept in the agent trash when it is on
await ctx.agents.delete('hermes.draft', { purge: true })               // true, gone for good (API 15)
```

Only agents your plugin created. `{ purge: true }` skips the agent trash, so nothing is left to restore: it is meant for undoing an agent your plugin just made, and is refused (`forbidden`) on any agent your plugin did not create, even for a superadmin. The main orchestrator is never deleted (`conflict`); a name taken, whatever its case, is a `conflict`. A picture is image bytes sent inline (`{ mime, data }` or `{ dataUrl }`), up to 2 MB, or `{ clear: true }`; a URL or a path is refused. Documents are `*.md` files at the agent's root, up to 2 MB, never empty (use `docs.rm`); `system-prompt.md` can be read and written but not removed.

## Mascot look (API 15)

An agent without a picture is drawn as a mascot: a head shape, a fur colour, resting eyes and a job accessory. Your plugin reads and sets it like any other field.

```js
const [agent] = await ctx.agents.list()
agent.look   // { shape: 'gem', color: '#d4a373', eyes: 'happy', acc: 'loupe' }, or null when none is set
await ctx.agents.update('hermes.support', { look: { shape: 'hex', color: '#3fa9ff', eyes: 'star', acc: 'coffee' } })
await ctx.agents.update('hermes.support', { look: null })   // back to the default look of its job
```

The values come from closed lists, the ones the Agents page offers (`PluginAgentLookShape`, `PluginAgentLookColor`, `PluginAgentLookEyes`, `PluginAgentLookAccessory` in [the API reference](api-reference/index.md)); the colour may also be any other `#rrggbb`, a `#` then exactly six hexadecimal digits in either case (`PluginAgentLookCustomColor`), the one the colour picker mixes. TypeScript checks the `#` and the first and last digits; a colour of any other length is refused when written. `acc` may be left out (no accessory) and the colour is read back lower-case. A value off the lists, or any other key, is `invalid`: the message names the field and the accepted values, and nothing is written. The same rights as the rest of `update` apply. To draw the mascot differently, take the `agent.mascot` slot instead ([Slots](slots.md)).

`avatar` says which head the agent shows: `'emoji'`, `'image'` (its picture) or `'mascot'` (its look). `null` means nobody picked one, and the app keeps its usual order: picture, project logo, emoji, initial. Picking a mode never erases the picture, the emoji or the look, so switching back finds them as they were.

```js
await ctx.agents.update('hermes.support', { avatar: 'mascot' })
await ctx.agents.update('hermes.support', { avatar: null })   // back to the usual order
```

## Skills, tool servers and team (API 15)

```js
const team = await ctx.agents.teams.create({ name: 'Market desk', color: '#22c55e' })
await ctx.agents.create({
  name: 'hermes.research', systemPrompt: 'You write cited briefs.', role: 'research',
  skills: ['web-brief'],              // skills that already exist
  mcpServers: ['acme-search'],        // servers your plugin declared with ctx.mcpServers.put
  team: team.id,
})
await ctx.agents.update('hermes.research', { skills: [], team: null })   // the whole set each time
const teams = await ctx.agents.teams.list()   // [{ id, name, color, createdAt }]
await ctx.agents.teams.delete(team.id)        // true; false for a team the account does not see
```

`skills` and `mcpServers` are the agent's whole set: `update` removes what it no longer names. An unknown id is `invalid` and nothing is written. Unless a superadmin makes the request, a skill that pre-authorises tools (`allowed-tools`) and a server your plugin did not declare are `forbidden`. A request sees, creates and deletes the teams of the signed-in account; a job only the teams no account owns. Deleting a team puts its members back outside any team, and is `forbidden` when it holds an agent your plugin did not create (unless a superadmin makes the request). `list` still returns an agent's identity, never its skills, servers or team.

## Reporting line

```js
const lead = (await ctx.agents.list()).find((a) => a.role === 'orchestrator' && a.project === 'billing')
await ctx.agents.create({
  name: 'billing.checker', systemPrompt: 'You check invoices.', role: 'research',
  reportsTo: lead.name,               // an existing agent
})
await ctx.agents.update('billing.checker', { reportsTo: null })   // back to the derived default
```

`reportsTo` is the agent this one reports to: its place in the hierarchy, and a manager it may always message. `list` returns it as `reportsTo` (`null` while none is set, the app then derives one). An unknown agent, the agent itself, or a manager that already reports to it (a cycle) is `invalid` and nothing is written. A request may name any existing agent; a job sees only the agents your plugin created, so it may name only those. As with every write, only agents your plugin created can be changed (unless a superadmin makes the request).

## Messages

```js
// Tell one of your agents something that came in from outside
await ctx.messages.send({ to: 'hermes.support', payload: { ticket: 'OPS-12' } })

// Let your agent ask another one, and read the answer later
const ask = await ctx.messages.send({ to: 'research.bot', kind: 'request', payload: 'Summarise OPS-12', as: 'hermes.support' })
const inbox = await ctx.messages.recv('hermes.support')                 // pending messages
await ctx.messages.pick(inbox[0].id)                                    // mark one as read
await ctx.messages.reply(inbox[0].id, 'On it.')                         // answers as hermes.support
```

- A message is written **as one of your own agents** (`as`) or as `plugin:<id>`. A plugin identity cannot be answered, so a `request` needs `as`. You never write as an agent you did not create, a superadmin included.
- A job writes only to your own agents. A request may write to any agent its account may talk to (an account can opt out of inter-agent communication). When the sender is one of your agents that sits in a team, the team rule applies to it.
- `recv`, `pick` and `reply` work on the inbox of **your agents** only, and show the messages the calling account owns. `recv` takes `status` (default `pending`), `from` and `limit` (1 to 200).
- The answer to a request sent by one of your agents lands in that agent's inbox: read it with `recv`. There is no "message received" event; `recv` is the interface.

## Skills

```js
await ctx.skills.put('howto-acme', '# How to Acme\n\nStep one…')
const skill = await ctx.skills.get('howto-acme')    // { id, title, content, mine, product, … }
await ctx.skills.rm('howto-acme')
```

A skill reaches the missions of the agents it is attached to, as a catalogue line they read on demand or pasted whole, so the rules are strict. You write by id, never a product skill, never an `allowed-tools` (or `allowed_tools`) line in the header, and you rewrite or remove only the skills you created. Attaching a skill to an agent stays with the user.

## MCP servers

```js
await ctx.mcpServers.put('acme-search', {
  name: 'Acme search',
  transport: { type: 'http', url: 'https://mcp.acme.test/sse', headers: { Authorization: 'Bearer …' } },
})
const server = await ctx.mcpServers.get('acme-search')   // headers: { Authorization: '***' }
```

Not to be confused with `ctx.mcp`, which hands an agent on another machine Timon's own tools ([Timon tools for a remote agent](remote-mcp.md)). A server declaration is a command on the host or an endpoint every attached agent calls, so:

- Only `http(s)` servers. Their host must resolve to public addresses, whoever the caller is: not the machine Timon runs on, your local network, a Tailscale network or a link-local address. It is checked again each time an agent starts with the server, and the agent only ever connects to the address that was checked. A `stdio` server (a command on the host) needs a superadmin as the caller of the request, a job never can, and its binary must also be allowed by the operator's `pluginPolicy.exec.allow`: it is empty by default, and Timon's own CLIs and generic launchers (`node`, `sh`…) are never allowed.
- You change or remove only the servers you declared. Servers Timon injects, connectors discovered by the harness and servers added by a person stay out of reach.
- Secrets are always read back masked (`***`), a superadmin's request included. Writing the masked value back keeps the stored secret as long as the server still points at the same place; if its URL changed, the write is refused.
- OAuth sign-in is a step with the user in the browser: it is never written through this API.
- You can write a `get` result back after changing a field. `put` ignores what the host stamps or observes (`id`, `mine`, `createdBy`, `source`, `last_status`, `last_seen_at`, `tools_cache`, `tools_cached_at`, `public_only`, `app_slug`). Any other unknown key is still `invalid`, so a misspelt field is not swallowed. Forged OAuth state in a transport is still refused. A server of another kind (an `external` transport) cannot be written.

## Backends

```js
const { backends, defaultBackend } = await ctx.backends.list()
const claude = backends.find((b) => b.id === 'claude')   // { id, label, models: [{ slug, … }], defaultModel, … }
```

The catalogue the Agents page shows the caller. A request sees the subscription accounts on its access list; a job sees none. Use it before `ctx.agents.create({ backend, model })`.

## Agent events

```js
ctx.events.on('agent_updated', (ev) => {
  if (ev.origin.kind === 'plugin' && ev.origin.id === ctx.id) return   // my own write
  // ev.agent: { name, backend, model, project, role, hasSystemPrompt, createdBy }
  // ev.changed: ['model'], ['system_prompt'], ['doc:SOUL.md'], ['name'] (then ev.previousName)
})
```

`agent_created`, `agent_updated` and `agent_deleted` fire whoever wrote the agent: the Agents page, the CLI, an agent, another plugin. You receive the ones for **the agents you created**, with the identity of the agent as the write left it (for a deletion, as it was before) and the `origin` of the write: `{ kind: 'user' | 'agent' | 'plugin' | 'system', id }`. Handlers run one at a time, in order. Host half only.
