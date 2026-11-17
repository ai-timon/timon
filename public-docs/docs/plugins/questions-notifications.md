---
title: Questions and notifications
sidebar_position: 13.8
---

An inbox plugin needs two things the conversation does not give it: every question an agent is waiting on, across all projects, and the notification centre. Both are plain facades on the plugin context. Requires `apiVersion: 10`.

```json
"timon": {
  "id": "acme-inbox",
  "apiVersion": 10,
  "permissions": ["questions:read", "questions:answer", "notifications:read", "notifications:write", "events:subscribe"]
}
```

| Permission | Surface |
| --- | --- |
| `questions:read` | `ctx.questions.list`, `get`; with `events:subscribe`, `question_pending` and `question_resolved` |
| `questions:answer` | `ctx.questions.resolve` |
| `approvals:read` | `ctx.approvals.list`, `get`; with `events:subscribe`, `approval_pending` and `approval_resolved`. Requires `apiVersion: 18` |
| `approvals:resolve` | `ctx.approvals.resolve`. Requires `apiVersion: 18` |
| `notifications:read` | `ctx.notifications.list` |
| `notifications:write` | `ctx.notifications.dismiss` |

:::warning `questions:answer` is a sensitive permission
Answering unblocks the agent as if the user had clicked, and answering a Kanban plan has the agent apply it. Declare it only when your plugin really answers on the user's behalf — and show the user what is being sent.
:::

## Questions

A question is a form an agent opened with its `question` or `kanban_plan` tool and that waits for a person. A tool-use approval (Allow / Deny) is **not** a question: it is neither listed nor resolvable here. Those cards are [approvals](#approvals).

```js
const waiting = await ctx.questions.list({ kinds: ['question'], project: 'acme' });
const one = await ctx.questions.get(waiting[0].id);

await ctx.questions.resolve(one.id, {
  answers: {
    'Which database?': 'Postgres',
    'Which checks?': ['lint', 'types'],
    'Ship it now?': { choice: 'Wait', text: 'after the demo on Friday' },  // a pick and a remark
  },
});
await ctx.questions.resolve(other.id, { cancel: true });     // the form is closed, not refused
await ctx.questions.resolve(plan.id, { plan: { mode: 'kanban-full', roles: {} } });
```

- **What you read.** `PluginQuestion`: `id`, `missionId`, `agent`, `kind` (`question` or `series_plan`), `questions` (text, `header`, `options` — each with `label`, `description` and `actor`, `'agent'`, `'user'` or `null`, saying who carries an action out —, `multiSelect`, `placeholder`), `plan` (the Kanban planner's title and steps, for `series_plan`), `createdAt`, `expiresAt`. Nothing else of the agent's request reaches you.
- **Which questions.** In a request, those of the calling account's missions; in a job, those of the missions your plugin owns. A question outside that view answers `undefined` (or `not_found` for `resolve`) — Timon does not confirm it exists.
- **The answer.** Keyed by the text of each question, like the chat form: every question needs a non-empty answer, a list only on a multi-select question, and a free-text answer is accepted on any question. To add a remark to a pick, as the free-text field of the chat form does, answer that question with an object: `{ choice, text }`, `{ choices, text }` on a multi-select, or `{ text }` alone. The former top-level `note` is deprecated: it still reaches the agent, but put the text in the answer of its question. A Kanban plan is checked as the chat checks it. A wrong answer throws `invalid` and the card keeps waiting.
- **Once.** The first answer wins; a second one, or one after the card expired, throws `not_found`.
- **Who decided.** `relayedVia` is an optional short label of the channel that carried the person's answer (`telegram`, `hermes`: at most 80 characters, no line break, no secret). Timon journals it next to the plugin that answered and the account of the request. The agent never reads it. Omit it and the account is still recorded when the call runs inside a request. A click records neither.
- **Errors** throw `PluginQuestionError` with a `code`: `invalid`, `not_found`.

### Events

```js
ctx.events.on('question_pending', (ev) => { /* ev.question, ev.origin = the agent */ });
ctx.events.on('question_resolved', (ev) => {
  // ev.status: 'answered' | 'cancelled' | 'expired'
  // ev.origin: { kind: 'user' | 'plugin' | 'system', id } — who closed it
  // ev.decisionOrigin: 'ui_form_submit', 'plugin', 'auto_timeout', 'mission_end'…
  // ev.decidedBy: the account of the request when a plugin relayed the answer, or null
  // ev.relayedVia: the channel label, or null
});
```

Both need `events:subscribe` and `questions:read`. They reach your plugin for the missions you can read, in the identity of the account that owns them, one at a time and in order. The event of your own answer comes back to you with `origin: { kind: 'plugin', id }`, so you can ignore your own echo. `decidedBy` is that account; a click, a job with nobody in front of it, and an expiry leave it null.

## Approvals

An approval is an Allow / Deny card an agent opened for a tool (`Bash`, an MCP tool, anything that is not `ask_user`). Requires `apiVersion: 18`. A question is not an approval: it is neither listed nor resolvable here.

```js
const waiting = await ctx.approvals.list({ tool: 'Bash', project: 'acme' });
const one = await ctx.approvals.get(waiting[0].id);

await ctx.approvals.resolve(one.id, { behavior: 'allow', relayedVia: 'telegram' });
await ctx.approvals.resolve(other.id, { behavior: 'deny', message: 'Run the tests first.' });
```

:::warning `approvals:read` and `approvals:resolve` are sensitive permissions
Reading a card shows a view of what the agent wants to run. Resolving one allows or denies that tool as if the user had clicked, and the agent resumes. Declare them only when your plugin really decides on the user's behalf, and show the user the card you are closing.
:::

- **What you read.** `PluginApproval`: `id`, `missionId`, `agent`, `tool`, `input`, `createdAt`, `expiresAt`. `input` is a bounded, redacted view of the tool's arguments (long strings cut, credential fields replaced, vault values masked). It is never the raw payload, and it is never what the agent receives if you allow: the agent gets the input it asked with.
- **Which cards.** In a request, those of the calling account's missions; in a job, those of the missions your plugin owns. A card outside that view answers `undefined` (or `not_found` for `resolve`).
- **The decision.** `behavior` is `allow` or `deny`. A deny may carry `message` (the reason the agent reads; absent or blank, the same text as the Deny button). You cannot rewrite the input, paste a command, or widen the allow. An unknown field throws `invalid` and the card keeps waiting.
- **Who decided.** `relayedVia` is the same optional channel label as on a question. It is journaled next to the plugin and the account of the request, and a resolved event carries both `decidedBy` and `relayedVia`.
- **Once.** The first decision wins; a second one, or one after the card expired, throws `not_found`.
- **Errors** throw `PluginApprovalError` with a `code`: `invalid`, `not_found`.

### Approval events

```js
ctx.events.on('approval_pending', (ev) => { /* ev.approval, ev.origin = the agent */ });
ctx.events.on('approval_resolved', (ev) => {
  // ev.status: 'allowed' | 'denied' | 'expired'
  // ev.origin: { kind: 'user' | 'plugin' | 'system', id }
  // ev.decisionOrigin: 'ui_card_allow', 'plugin', 'auto_timeout', 'mission_end'…
  // ev.decidedBy, ev.relayedVia — the account and the channel, or null
});
```

Both need `events:subscribe` and `approvals:read`. They reach your plugin for the missions you can read, in the identity of the account that owns them, one at a time and in order. The event of your own decision comes back with `origin: { kind: 'plugin', id }`. A paste the user makes in the interface reaches the agent as a deny, and the status is `denied`.

## Notifications

```js
const unread = await ctx.notifications.list({ type: 'action_required' });   // active: true by default
const archive = await ctx.notifications.list({ active: false });            // dismissed ones
await ctx.notifications.dismiss(unread[0].id);                              // true if it was open
```

- **What you read.** `PluginNotification`: `id`, `type` (`action_required`, `alert`, `report`), `urgent`, `title`, `body`, `taskId`, `missionId`, `anchor` (the id of the question it points at, for `action_required`), `source` (`plugin:<id>` when a plugin raised it), `agent`, `createdAt`, `readAt`, `dismissedAt`.
- **Which notifications.** In a request, the calling account's (an account holding `notifications:read:all` sees everyone's); in a job, those your plugin owns. A notification outside that view answers as if it did not exist: `dismiss` returns `false`.
- **Dismissing** closes the system notification on the user's devices too, like the button in the centre. Raising a notification stays `ctx.notify` (permission `notify`).
- **Errors** throw `PluginNotificationError` with a `code`: `invalid`, `module_disabled` (the notification centre is switched off).

## Notice cards

The notification centre keeps a history; a **notice card** asks for attention now, at the bottom left of the interface, until an action or its × takes it away. It lives in the browser half, needs no permission, and requires `apiVersion: 17`:

```js
export function apply(ctx) {
  ctx.notices.push({
    id: 'welcome',
    tone: 'info',                 // 'info' | 'warning' | 'success', default 'info'
    icon: 'github',               // optional: 'github' | 'discord' | 'timon' | 'x' | 'youtube'
    title: 'Acme is connected',   // up to 120 characters, plain text
    body: 'Your boards sync every hour.', // optional, up to 400 characters
    actions: [{ label: 'Open Acme', href: '/acme' }], // two at most
    dismissible: true,            // default true: the × closes it for good
  })
}
```

- `push` shows the card, or updates the one your plugin pushed with the same `id`. Throws when the notice is invalid, with the reason.
- `icon` shows a brand logo at the head of the card instead of the tone's icon, and colours the card's corner with it (a `warning` stays amber). Timon draws the logos itself: the value is one of the names above, never an image address.
- An action needs `onSelect`, `href` or `dismiss: true`. `href` is a page of the app (`/settings`) or an `https:` address, opened in a new window; `dismiss: true` closes the card for good after the click. An action without it leaves the card up: call `ctx.notices.remove(id)` when you are done with it.
- A closed card stays closed for the person's account, on every client: pushing the same `id` again shows nothing, until the person chooses **Show closed cards again** in Settings › System › Updates. Put a version in the `id` (`update-1.4.0`) for a card that must come back each version.
- `remove(id)` takes the card off the screen without closing it for good. Your cards also leave when your plugin is switched off.
- At most three cards show at once, warnings first: keep cards rare, short, and with one clear action.

A card that depends on React state comes from an entry of the `notices` slot, which pushes with `useNotices()`; how every card is painted is the `notices.card` slot. Both are described in [Slots](slots.md#special-surfaces); template: `examples/plugin-notice`.
