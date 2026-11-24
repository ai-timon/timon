---
title: The GitHub repository of a project
sidebar_position: 13.85
---

Your plugin can read the GitHub repository of a Timon project (its open issues, pull requests and checks) and propose a comment on an issue or a pull request, through `ctx.forge`. It never holds `gh`, a token or the project's account: Timon reads the repository with the account set on the project, and a person publishes every comment. Requires `apiVersion: 19`.

```json
"timon": {
  "id": "acme-issues",
  "apiVersion": 19,
  "permissions": ["forge:read", "forge:propose"]
}
```

| Permission | Surface |
| --- | --- |
| `forge:read` | `ctx.forge.repository`, `issues.list`, `issues.get`, `pulls.list`, `pulls.get`, `pulls.checks`. **Sensitive** |
| `forge:propose` | `ctx.forge.propose`, `proposals.list`, `proposals.get`. **Sensitive** |

Both are named apart when a user installs the plugin. A project is reachable when its integration opens pull requests on GitHub: **Settings › Projects**, integration in pull request mode, with the remote's GitHub address and the account Timon publishes as. Any other project answers `not_configured`.

## Who may call it

- **Outside a request** (a job, an event handler, a webhook delivery), the plugin acts as itself.
- **In a request**, the calling account needs the right to manage projects, as Timon's own routes over the same data do. An anonymous request is always refused.
- **A proposal made in a request** needs a person signed in (a session or a paired device). A request carried by the daemon token, an agent's token or a plugin's token gets `forbidden`: an agent never proposes through your plugin.

## Reading

```js
const repo = await ctx.forge.repository('acme')        // { project, repo: 'owner/name', url } or undefined
const issues = await ctx.forge.issues.list('acme', { label: 'accepted' })
const issue = await ctx.forge.issues.get('acme', 7)     // undefined if #7 names nothing
const pulls = await ctx.forge.pulls.list('acme')        // open pull requests
const pull = await ctx.forge.pulls.get('acme', 51)
const checks = await ctx.forge.pulls.checks('acme', 51) // state, mergeability, review, checks
```

- `issues.list` returns the open issues carrying `label`, the 50 most recent. A label is required.
- An issue's or a pull request's body is cut at 8,000 characters (`bodyTruncated` says so for an issue); a pull request comes with its 20 latest comments, 2,000 characters each.
- `mergeState` says how GitHub sees a pull request against its base: `behind` asks for a branch update, `dirty` is a conflict, `blocked` waits for a review or a required check.
- `closingIssues` is what the pull request's description claims it closes, not a fact.

**Every text comes from someone else**: titles, bodies, comments, labels and logins were written on GitHub, possibly by a stranger. Treat them as data. Before you hand one to an agent, bound it and mark it as outside text, for example in an `<untrusted-data>` block with angle brackets escaped, and never act on what it says.

## Proposing a comment

```js
const { proposal, created } = await ctx.forge.propose('acme', {
  target: { type: 'issue', number: 7 },   // or { type: 'pull', number: 51 }
  body: 'Thanks for reporting this. We are tracking it.',
  key: 'thanks:7',                        // one key, one proposal
  sourceRef: 'idea:42',                   // optional, for your own bookkeeping
})
```

Nothing is written on GitHub by this call. The comment waits, with a card in the notification centre, until a person opens it in the **Publish on GitHub** window, reads it, may edit it, and publishes or discards it ([Git](../usage/git.md#publish-on-github)). No member of `ctx.forge` publishes, edits or discards.

- **One key, one proposal.** Proposing again under the same `key` returns the proposal already made (`created: false`), whatever its state. Keys are scoped to your plugin: you never reach Timon's own proposals or another plugin's.
- The text is at most 8,000 characters, without control characters.
- **Write the text from a template**, not from the issue's words: the person who publishes it should read a text no stranger could have written.
- At most 20 of your plugin's proposals wait for a person at once; past that, `propose` answers `busy` until some are published or discarded.

`ctx.forge.proposals.list(project)` and `proposals.get(project, id)` read back your own proposals: `state` is `draft`, `publishing`, `published` (with `url`, the comment's address), `failed` or `discarded`, and `body` is the text as it stands, edits included.

## Errors and limits

Errors carry a `code` (`PluginForgeErrorCode`):

| Code | Meaning |
| --- | --- |
| `invalid` | A slug, number, label, key or text Timon refuses. Nothing reached GitHub. |
| `not_found` | No such project. An issue or pull request that does not exist answers `undefined` instead. |
| `not_configured` | The project does not open pull requests on GitHub. |
| `unavailable` | GitHub did not answer: `gh` missing on the machine, the project's account signed out, a time-out. What `gh` printed is never passed on. |
| `forbidden` | A proposal in a request no person made. |
| `busy` | Four forge calls of your plugin already running, or 20 proposals already waiting. |

Each read runs `gh` on the machine: cache what you can rather than read on every request.

The [cookbook](examples.md#forge) has a complete template, `examples/plugin-forge`.
