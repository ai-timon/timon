---
title: Memory
sidebar_position: 13.8
---

Your plugin can write memory rules for agents, search Timon's memory and read the memory files of an agent or a project. A rule is a short instruction Timon injects into the prompt of every agent in its scope. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-support",
  "apiVersion": 10,
  "permissions": ["memory:write", "memory:read", "events:subscribe"]
}
```

`memory:write` adds and removes rules; `memory:read` lists, searches and reads. Both are sensitive: a rule changes how agents behave, and agent memory can hold secrets. Declare only what you use.

```js
const rule = await ctx.memory.rules.add({
  scope: 'agent',
  agent: 'support.bot',
  text: 'Never answer a refund request without the order id.',
  kind: 'decision', // 'pitfall' (default), 'decision' or 'preference'
})
// { id, scope, agent, kind, tier, text, source: 'plugin:acme-support', mine: true, … }

await ctx.memory.rules.list({ agent: 'support.bot' })
await ctx.memory.rules.rm(rule.id)

await ctx.memory.search('refund')
await ctx.memory.overview()
await ctx.memory.show('agent', 'support.bot')              // the memory files
await ctx.memory.show('agent', 'support.bot', 'notes.md')  // { name, content }
```

## Who acts

- **In a request** (a route, a webhook or a callback of a user): the account needs `agents:read` or `agents:manage` to read and `agents:manage` to write — the same floor as agent memory in the app — in addition to your manifest permission. Otherwise the call fails with `PluginCallerError`. An anonymous request is refused.
- **In a job:** your plugin acts as itself and sees only what it wrote: its own rules, and the memory of the agents it created. It writes rules for its own agents only.

## Guarantees

- Every rule you write carries `source: "plugin:<your id>"`, set by Timon. Nobody else can write that prefix, by the API or by editing a rule.
- `rules.rm` removes only rules your plugin wrote, unless the request comes from a superadmin. Another's rule answers `forbidden` in a request and `not_found` in a job.
- Removing a rule makes the agents it could have reached start a fresh conversation at their next mission, since their earlier one still holds the rule ([Agents](../usage/agents.md#removing-or-rewriting-a-memory-rule)).
- A request may target any existing agent, project or role. `scope: "global"` and `tier: "core"` — injected everywhere, always — need a superadmin caller.
- Input is strict: an unknown field, a missing target or a rule that already exists on that scope fails with a typed error. `PluginMemoryError.code` is `invalid`, `not_found`, `conflict` or `forbidden`.

## Events

With `events:subscribe` and `memory:read`, `ctx.events.on('memory_rule_added', …)` and `ctx.events.on('memory_rule_removed', …)` (host half only) tell you about the rules **your plugin wrote**: the rule as it was, and `origin` — who acted (`plugin`, `user`, `agent`). It is how you notice that a user removed one of your rules. Rules added by an accepted proposal or the nightly synthesis, and changes of status, send nothing.
