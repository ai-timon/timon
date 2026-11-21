---
title: Syncing the Kanban
sidebar_position: 14.6
---

A plugin can keep Timon's board in step with GitHub Projects, Linear or Jira, in both directions, on the real tasks. It reads and writes tasks, ties each one to its ticket, mirrors tickets as tasks that never run an agent, and hears every change with the name of whoever made it.

Needs `"apiVersion": 10`. Permissions: `kanban:read`, `kanban:write`, and `events:subscribe` to hear changes. `kanban:delete` and `kanban:read:project` are [sensitive](permissions.md) and only for plugins that need them. TO DO ideas have their own permissions (`todos:*`): a task starts an agent, an idea does not.

## Mirror a ticket

```js
export function apply(ctx) {
  ctx.webhooks.on('issues', async (req) => {
    const { action, issue } = req.json();
    const ref = `acme/app#${issue.number}`;

    // The task of this ticket, or a new one: safe to replay.
    const { task } = await ctx.kanban.ensure(
      { title: issue.title, description: issue.body, mirror: true },
      [{ provider: 'github', ref, url: issue.html_url }],
    );
    if (action === 'closed') await ctx.kanban.update(task.id, { status: 'DONE' });
    if (action === 'reopened') await ctx.kanban.update(task.id, { status: 'PENDING' });
  });
}
```

A **mirror task** (`mirror: true`, fixed when it is created) is the image of a ticket. Timon never runs an agent for it, and closing it creates no review, no documentation task, no wake-up and no alert. It needs no `agent`. It cannot be combined with `groupId`, `planGroup`, `todoId`, `pipeline`, `base`, model or permission overrides, or the `merge` type.

A task without `mirror` is an ordinary task: it is handed to its agent as soon as it is `PENDING`.

## The API

| Call | What it does |
| --- | --- |
| `ctx.kanban.get(id)` | One task with its `links`; `undefined` when unknown or not yours to see |
| `ctx.kanban.list({ status, project, mirror, limit })` | Tasks you may see. `status` is one value or a list (`['PENDING', 'BLOCKED']`): a task matching any is returned once, and an empty list is `invalid` |
| `ctx.kanban.add(task)` | Create. Accepts the options of the `kanban_add` tool: `model`, `backend`, `permissionMode`, `fallbackBackend`, `fallbackModel`, `base`, `pipeline`, `extraSkills`, `extraMcp`, `extraAllowedTools` |
| `ctx.kanban.ensure(task, links)` | Create the task unless one of `links` already points at a task you see; returns `{ task, created }` |
| `ctx.kanban.update(id, patch)` | Title, description, priority, dependencies, date, `status`, `agent`, `type` |
| `ctx.kanban.done(id, { comment, summary?, mergedSha? })` | Close as done; the comment is required |
| `ctx.kanban.block(id, reason)` | Close as blocked; the reason is required |
| `ctx.kanban.delete(id, { chain? })` | Delete (`kanban:delete`). Refused while the task runs, has dependents, a worktree or a pipeline step |
| `ctx.kanban.refs.set / list / remove / findByRef` | Where a task lives outside Timon. One `(provider, ref)` points at one task |

`status` accepts `PENDING`, `IN_PROGRESS`, `DONE` and `BLOCKED` on a mirror task. On a task that runs it only accepts `PENDING` (put it back in the queue, with the same crash-loop rule as an agent); close it with `done` or `block`. Assigning another `agent` is a delegation, like naming the agent when you create the task.

Overrides are checked against the agent the task is assigned to: your plugin can repeat or narrow what that agent already has, never widen it (`code: 'forbidden'`).

Failures throw a `PluginTaskError` whose `code` is `invalid`, `not_found`, `conflict` or `forbidden`; a `conflict` may carry a `reason` (`task_state`, `task_dependents`, `crash_loop`…).

A task that runs starts a mission. When your plugin creates one (`add`, `ensure`, `todos.promote`) or puts one back in the queue from a background job, a webhook handler or an event handler (`ctx.events.on`), it needs the operator's approval and counts against the same quota as `ctx.missions.spawn` (`pluginPolicy.spawn`, see [Permissions](permissions.md)). Until then the call throws a `forbidden` error (`PluginTaskError`, or the TO DO error for `todos.promote`) with `reason: 'spawn_policy'` and the operator sees a card asking for the approval. Tell your user the task is waiting rather than retrying in a loop. A mirror task, and a task created in a request by a signed-in user, are not concerned.

## The shape of a task

A task you read (`get`, `list`, and the task of a `task_updated` event) uses `snake_case` field names: `agent_name`, `created_at`, `updated_at`, `blocked_reason`, `done_comment`, `owner_user_id`. Write calls (`add`, `ensure`, `update`) take `camelCase` options (`scheduledAt`, `groupId`). The two are not the same object, so do not forward a read task to a write call.

Dependencies differ in the same way. On a task you read, `deps` is a **string**: a JSON array of task ids, as the board stores it (`'["a1","b2"]'`, `'[]'` for none). Parse it with `JSON.parse`. On a write, `deps` is a plain `string[]`. Read one name for the field, `deps`; there is no `dependencies` or `dependsOn`.

The casing is part of the current contract and does not vary between SDK versions. Agents, teams and memory rules, by contrast, use `camelCase` on read. A future version may align the two; that would be announced as a change of the contract version.

## What you see and what you may write

- In a **request** you see and write what the signed-in user sees, as the board does. A request without an account cannot delete, close or link.
- In a **background job** you write only the tasks your plugin created. You also read, never write, the tasks of the projects you list in `timon.config.json`, and only if the manifest declares `kanban:read:project`:

```json
{
  "pluginPolicy": {
    "kanban": { "projects": { "acme-sync": ["my-project"] } }
  }
}
```

A task outside your view answers as one that does not exist.

## Hear the changes

```js
ctx.events.on('task_updated', async (ev) => {
  if (ev.origin.kind === 'plugin' && ev.origin.id === ctx.id) return; // our own echo
  if (!ev.changed.includes('status')) return;
  const link = ev.task.links.find((l) => l.provider === 'github');
  if (link) await closeIssue(link.ref, ev.task.status);
});
```

| Event | When |
| --- | --- |
| `task_created` | A task was created, by anyone |
| `task_updated` | A visible field changed: `changed` names the fields, `previous` holds their old values. Status moves are included, whichever way they happened |
| `task_assigned` | The task's agent changed |
| `task_deleted` | A task was deleted; the event holds its title, status, project and links as they were |
| `task_unblocked` | A blocked task is active again |

Every event carries `origin` (`{ kind: 'user' | 'agent' | 'plugin' | 'system', id }`) and a `task` snapshot taken at the time of the write. **Drop the events your own plugin caused**, or each write you make comes straight back. Handlers run one at a time, in order, and receive the tasks of the accounts allowed to use your plugin, under that account; tasks of a project you were granted reach your background job. `task_done` and `task_blocked` keep their short form (`{ taskId }`); the same change also arrives as a `task_updated`.
