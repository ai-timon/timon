---
title: Listening to events
sidebar_position: 13.9
---

Your plugin follows what happens in Timon by listening to events: `ctx.events.on(kind, handler)` in the host half, `ctx.events.subscribe(kind, handler)` in the browser half. Both return a function that stops listening; Timon also stops every listener when your plugin unloads. Events are read-only: a plugin never emits one on Timon's bus. Your own events go through [business events](integrations.md#business-events) or [live updates](realtime.md).

Every kind needs `events:subscribe`. Most also need the read permission of what they carry, because receiving the object is reading it. A kind that is not in the table below throws when you subscribe, and the message lists the allowed kinds.

```json
"timon": {
  "id": "acme-watch",
  "apiVersion": 10,
  "permissions": ["events:subscribe", "kanban:read"]
}
```

## Catalogue

| Events | Also needs | Payload | Browser half | Guide |
| --- | --- | --- | --- | --- |
| `mission_complete` | nothing | `missionId`, `status` (`completed`, `failed`, `terminated`), `exitCode` | yes | [below](#signals) |
| `task_done` | nothing | `taskId` | yes | [below](#signals) |
| `task_blocked` | nothing | `taskId`, `reason` | yes | [below](#signals) |
| `notifications_changed` | nothing | `ownerUserId`, `notificationId` (on a creation only) | yes | [below](#signals) |
| `workflow_run` | nothing | `runId`, `nodeId`, `status` | yes | [below](#signals) |
| `workflow_proposal` | nothing | `workflowId`, `missionId` | yes | [below](#signals) |
| `mission_started`, `turn_complete`, `mission_title_changed`, `mission_archived`, `mission_unarchived` | `missions:read` | the mission and the `origin` of the change | yes | [Controlling missions](missions-control.md#events) |
| `event`, `event_delta` | `missions:transcript` | a transcript row; a live fragment of an answer | `event` only | [Controlling missions](missions-control.md#events) |
| `task_created`, `task_updated`, `task_assigned`, `task_deleted`, `task_unblocked` | `kanban:read` | the task, `changed` and `previous` for an update, `origin` | no | [Kanban sync](kanban-sync.md#hear-the-changes) |
| `todo_done`, `todo_resolved`, `todo_deleted` | `todos:read` | the idea, `origin` | no | [Permissions](permissions.md#keeping-a-to-do-idea-and-a-ticket-in-step) |
| `ui_document_created`, `ui_document_resolved` | `ui-documents:read` | the document, its creator or the answer | no | [Documents in the conversation](ui-documents.md) |
| `question_pending`, `question_resolved` | `questions:read` | the question, `origin` | no | [Questions and notifications](questions-notifications.md#events) |
| `memory_rule_added`, `memory_rule_removed` | `memory:read` | a rule your plugin wrote, `origin` | no | [Memory](memory.md) |
| `project_created`, `project_updated` | `projects:read` (or `projects:manage`) | the project, `changed`, `origin` | no | [Projects, series and worktrees](projects-series-worktrees.md) |
| `agent_created`, `agent_updated`, `agent_deleted` | `agents:read` | an agent your plugin created, `origin` | no | [Agents](agents.md) |
| `routine_*`, `trigger_*`, `pipeline_*`, `workflow_run_started`, `workflow_run_cancelled` | the entity's read permission | the object, `origin` | no | [Automations](automations.md#events) |
| `browser_recording_*` | `browser:recordings:read` (or `:write`) | the recording's metadata, `origin` | no | [The built-in browser](browser.md#recordings) |
| `browser_annotation_*` | `browser:annotations:read` (or `:write`) | the annotation's metadata, `origin` | no | [The built-in browser](browser.md#annotations) |

`origin` is `{ kind, id }` and says who made the change: `user`, `agent`, `plugin`, `system`, or the channel that started a mission. A change your plugin made carries `{ kind: 'plugin', id: ctx.id }`: a sync ignores that echo.

```js
ctx.events.on('task_updated', (ev) => {
  if (ev.origin.kind === 'plugin' && ev.origin.id === ctx.id) return   // your own write
  if (ev.changed.includes('status')) console.log(ev.task.id, ev.previous.status, '→', ev.task.status)
})
```

The kinds with a permission of their own reach your plugin for the objects of the users allowed to use it, inside that user's identity (`ctx.user()`), and for the objects your plugin owns. Their handlers run one at a time per plugin, in event order.

## Signals

The first six kinds are signals: they carry identifiers, never the object, and need nothing but `events:subscribe`.

- **In the host half** they reach your plugin for **every account** of the installation, and the handler runs outside any request. To read what changed, call the matching façade (`ctx.missions.get`, `ctx.kanban.get`, `ctx.notifications.list`, `ctx.workflows.status`): outside a request it answers like a background job, so it sees only what your plugin owns. Do not use these identifiers to tell anyone what happened in another account's work.
- **In the browser half** they come from the signed-in user's stream, so they only carry what that user can see. `notifications_changed` reaches an account for its own notifications.

```js
// Browser half: refresh a badge when this user's notifications change.
const stop = ctx.events.subscribe('notifications_changed', () => reloadBadge())
```

What each one means:

| Event | Sent when |
| --- | --- |
| `mission_complete` | a mission's process ended. `failed` and `terminated` differ: a failure of the agent, or a stop (a person, a limit, a shutdown). A conversation that stays open sends `turn_complete` at the end of each turn instead. |
| `task_done`, `task_blocked` | a Kanban task closed as done or blocked. `task_updated` (with `kanban:read`) says the same with the task and the `origin`. |
| `notifications_changed` | a notification was created, read or dismissed. `ownerUserId` is the account it belongs to (`null` for a system notification); `notificationId` is set on a creation only. Read the list again rather than guessing what changed. |
| `workflow_run` | a workflow run or one of its nodes changed status. `nodeId` is absent for the run itself. |
| `workflow_proposal` | an agent proposed changes to a workflow from a mission. The proposal waits for a person to accept it in the workflow editor; accepting replaces the draft, it never publishes. |

Handle them as invalidations: reload what you show, and expect several in a burst.

### Why signals are bare

Both limits are deliberate, not gaps to work around:

- **Only identifiers.** A signal is delivered outside any request, so no account stands behind it. Reading the object back would show it to a plugin that has no right to see it, so the read answers as a background job: only what your plugin owns. To label a finished mission or a blocked task with its agent and title, listen to `task_updated` (with `kanban:read`), which carries the task, and keep a small `missionId` to agent map.
- **Every account.** A host-half signal does not know which account it belongs to, so it reaches the plugin for all of them. Treat it as "something changed", never as "something changed for this person". If your plugin drives something shared, such as a device on a desk, decide on your side whose activity it may show.

If either limit blocks your plugin, describe the use case in a feature request; it needs a decision on privacy, not just an option.

## Order

- **Inside one family**, handlers run one at a time per plugin, in the order the events happened. A handler that awaits finishes before the next event of that family starts. The families are the mission, task, question, TO DO, agent, project, memory, automation, UI document and browser events, each with its own queue.
- **Between families, nothing is guaranteed.** `task_blocked` and `task_updated` (or a signal and a detail event) can reach you in either order, and an event of one family can overtake a slower handler of another. There is no sequence number.
- **Between a signal and a detail event** the order is not guaranteed either, even though the two come from the same change.

So do not build a state machine that depends on one event arriving before another. Treat each event as "this object changed", then read the current state (`ctx.kanban.get`, `ctx.missions.get`) or keep the newest value by its own timestamp, such as `updated_at` on a task. A state rebuilt from the latest read cannot go stale when two events swap places.

## Handlers that fail

A handler that throws or rejects is your plugin's own failure: the daemon logs it under your plugin's id, the other listeners of the event still run, and the write that caused the event is not affected ([Manifest](manifest.md)). Catch what you can recover from.
