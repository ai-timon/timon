---
title: Triggers
sidebar_position: 4.5
---

A trigger runs actions on its own when something happens. It has three parts:

1. a **source**: a schedule, a webhook called from outside, or an event inside Timon;
2. an optional **filter** on what the source sent;
3. one to five **actions**: create a TO DO idea, create a task for an agent, send a notification, run a workflow, or call another service.

Open **Triggers** in the navigation. The page has one tab per source: **Routines** (schedules), **Webhooks** and **Events**. It replaces the former Routines page: your routines are listed in the Routines tab, unchanged, and old `/routines` links open that tab.

The editor walks through these three parts in order. A click beside it never closes it; Escape does, but if you changed something it first asks whether to discard your changes (a second Escape keeps editing). The **✕** and **Cancel** buttons close it at once.

Creating, editing and deleting triggers needs the **Manage triggers** permission. Each account only sees, edits and deletes its own triggers and routines; a superadmin sees everyone's. A trigger can only do what its author was allowed to do when saving it: a user who cannot create Kanban tasks cannot make a trigger that does.

## Sources

### Routines (schedule)

A schedule fires at the times of a cron expression, for example `0 9 * * 1` (Mondays at 9:00). Pick a preset or type the expression, and optionally a time zone. A schedule has no incoming data, so it has no filter; its templates can use `{now}`, `{timestamp}` and `{trigger.name}`. A schedule runs at most once a minute: an optional sixth field for seconds may hold a single value (`30 * * * * *`), never several.

If Timon was not running at a scheduled time, that occurrence runs once when Timon is back, and the next run is computed from that moment, without catching up on the others. A trigger that runs a workflow waits for the Workflows module to start (up to five minutes) before it runs. When a scheduled run fails, its journal shows why and you get a notification.

A Kanban task starts with no MCP server: only those of its project role and those it names itself. An agent outside any project role therefore has none of its tools when a routine opens its task. In the routine's editor, under **MCP servers for each task**, pick the servers the agent needs: every task the routine opens carries them. The agent's own configuration is never copied on its own. From the CLI or an agent's tools, the same lists are `--extra-mcp`, `--extra-skills` and `--allow` (`extra_mcp_servers`, `extra_skills`, `extra_allowed_tools`). An agent can only pass on servers, skills and tools the routine's agent already holds: a stdio server it does not hold, or a new tool, takes you.

### Webhooks

A webhook gives an outside service an address to call. Each one has a readable route name, for example `discord-bugs`, and an address ending in `/api/triggers/hooks/discord-bugs`. Copy the full address from the trigger's row.

Every call must prove it comes from the sender you configured. Choose the scheme that matches the sender:

| Scheme | For | How the call is checked |
| --- | --- | --- |
| `github` | GitHub webhooks | `X-Hub-Signature-256` with the trigger's secret |
| `gitlab` | GitLab webhooks | `X-Gitlab-Token` equal to the secret |
| `standard` | Services that follow [Standard Webhooks](https://www.standardwebhooks.com/) | `webhook-id`, `webhook-timestamp`, `webhook-signature` |
| `generic` | Your own script, bot or automation tool | `X-Timon-Timestamp` and `X-Timon-Signature`, see [Signing a call](#signing-a-call) |
| `none` | A program on the same computer only | No proof; see [Reaching Timon from outside](#reaching-timon-from-outside) |

The secret is shown **once**, when the trigger is created or when you ask for a new one. Copy it into the sender at that moment: Timon never shows it again, and keeps it encrypted, backups included. If the browser refuses the copy, the secret appears in the window, already selected, so you can copy it by hand before closing. Until a copy succeeds, Escape does not close that window: use **I copied it**. If it leaks, use **New secret** on the trigger, then update the sender.

A webhook body is limited to 256 KB and must be JSON. Each route accepts 30 calls per minute by default (adjustable from 1 to 600 in the advanced settings).

### Events

An event trigger listens to what happens inside Timon:

| Event | Fires when | Template variables |
| --- | --- | --- |
| `task_done` | a Kanban task is closed as done | `{task.title}`, `{task.agent}`, `{task.project}`, `{task.summary}`, `{task.comment}`, `{task.id}` |
| `task_blocked` | a task is blocked | `{task.title}`, `{task.agent}`, `{task.project}`, `{task.reason}`, `{task.id}` |
| `mission_complete` | an agent mission ends | `{mission.agent}`, `{mission.status}`, `{mission.reason}`, `{mission.id}` |
| `agent_message` | an agent sends a message to another | `{message.from_agent}`, `{message.to_agent}`, `{message.kind}`, `{message.text}` |
| `notification` | a notification is created | `{notification.title}`, `{notification.body}`, `{notification.type}`, `{notification.source}` |
| `todo_done` | a TO DO idea is done: ticked, tagged done, or closed when the task that implements it is merged | `{todo.text}`, `{todo.project}`, `{todo.previous_progress}`, `{todo.urgency}`, `{todo.id}` (the idea's notes are not included) |
| `todo_resolved` | a TO DO idea is given a new outcome (fixed, declined, duplicate, needs info, in progress, planned); clearing it or saving the same one again does not fire | `{todo.text}`, `{todo.resolution}`, `{todo.public_note}`, `{todo.duplicate_of}`, `{todo.project}`, `{todo.id}` (the idea's notes are not included; the public note is) |

A trigger only sees events about your own tasks, missions, messages and notifications; a superadmin's triggers see everyone's.

To avoid loops, what an event trigger creates never fires another trigger: an event trigger that creates a task will not be woken by that task finishing, and two event triggers cannot feed each other.

## Filters

A filter decides whether a call or an event runs the actions. Without a filter, everything does. A call that does not match is answered `200` with `{"status": "ignored", "reason": "filter"}` and recorded in the journal; nothing else happens.

A condition reads a value from the incoming data by its dotted path, such as `issue.title` or `sender.login`. Headers of a webhook call are available as `headers.<Name>`, for example `headers.X-GitHub-Event` (case does not matter). Secrets carried in headers are never visible to filters, templates or the journal.

| Operator | Matches when the value at the path… |
| --- | --- |
| `equals` / `not_equals` | is / is not exactly the given value |
| `contains` | contains the given text (or array item) |
| `in` | is one of the given values |
| `regex` | matches a regular expression (optionally case-insensitive) |
| `exists` / `missing` | is present / absent |

In the editor, combine several conditions with **all** or **any**. For deeper logic (`not`, nested groups), switch the filter to JSON:

```json
{ "all": [
  { "op": "equals", "path": "action", "value": "opened" },
  { "not": { "op": "contains", "path": "issue.title", "value": "[draft]" } }
] }
```

Regular expressions support the usual syntax except back-references, lookarounds and named groups, and are checked against the first 4,096 characters of the value.


### When an agent is renamed

Renaming an agent carries the event filters that test `task.agent`, `mission.agent`, `message.from_agent` or `message.to_agent` when they name it exactly: **equals**, **is not**, **in**, **contains** with the whole name, and a regex that is the whole name, `^name$` or `name`, with its dots escaped.

Any other pattern or substring that reads the new name differently is left unchanged, because rewriting it would guess what you meant. So is a **contains** or unanchored regex with the whole name when another agent's name also contains the old or the new name. These triggers are listed when you rename the agent, and their owner gets a notification. Webhook filters read someone else's data and are never touched.

## Actions

| Action | What it does |
| --- | --- |
| **TO DO idea** | Adds an idea to a project's TO DO notebook: text, notes, project and urgency (`critical`, `bug`, `minor`, `idea`). No agent runs, no token is spent. |
| **Agent task** | Creates a Kanban task for the agent you choose, with your prompt. The task is dispatched like any other. Tick **Silent return** when the agent reports somewhere else (an idea's notes, a notification): its return then never reaches your orchestrator. |
| **Notification** | Sends a report or an alert to the notification center, optionally urgent. |
| **Run a workflow** | Starts a workflow at one of its entry nodes. Offered only while the Workflows module is on. |
| **Webhook (send)** | POSTs `{"type", "timestamp", "data"}` to an https address you choose, `data` being what the trigger received and `type` its event (or `webhook` / `schedule`). Needs the **Outbound HTTP calls** permission. |
| **Script (run)** | Runs a program on your computer, with no agent and no model: a tick spends no token. Needs the **Run scripts on the host** permission; an agent can only propose one for you to approve. See [Running a script](#running-a-script). |

### Sending a webhook

Each call is signed the [Standard Webhooks](https://www.standardwebhooks.com/) way: `webhook-id`, `webhook-timestamp` and `webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`. The signing secret (`whsec_…`) is shown once, when the first webhook action is saved; paste it in the receiving service. It is never the secret of a webhook Timon receives, and **new signing secret** in the list replaces it.

The address is fixed in the editor: the incoming data never chooses where it is sent. It must be https, without a user name or password in it, and point to a public address: a private or local network address, this machine (`localhost`), or a cloud metadata address is refused, including when a name resolves to one, and a redirect is not followed. A call is sent at once; if the receiver does not answer with a 2xx, it is retried with the same `webhook-id` and body, after 1 minute, then twice as long each time (at most 6 hours), up to 10 attempts. A call that gives up is logged in the trigger's journal.

Everything the filter lets through leaves your computer: filter on what the receiver needs. For example, to tell a bug tracker that its tickets are fixed, listen to `todo_done` with the filter `todo.text` matches `^BUG-[0-9]+`. To tell the reporter what you decided, listen to `todo_resolved` instead: its data is `{"event": "todo_resolved", "todo": {"id", "text", "project", "resolution", "public_note", "duplicate_of"}}`. *Fixed*, *declined* and *duplicate* close the idea: `todo_resolved` fires first, then `todo_done`. *Needs info*, *in progress* and *planned* keep it open and fire `todo_resolved` only.

The agent of a task action is always the one you picked in the editor; the incoming data can never choose who runs.

When a trigger creates a TO DO idea and then an agent task, the task is linked to that idea, like a task promoted from the notebook: once the task is done, the idea follows (a research task marks it **analyzed**, other tasks tick it done when their work lands). With several ideas, the task takes the last one created before it; a task listed before any idea is not linked.

### Silent return

By default, when a task created by a trigger is done, its result goes back to your orchestrator, like any delegated work, and lands in the conversation of its latest mission. For work that reports on its own, such as the investigation of a ticket that writes its findings into the idea, that return is noise in an unrelated thread. **Silent return** (`silent_return: true` from the MCP tools and the command line) turns it off for that task action: the task runs, closes and updates its idea as usual, and nothing is sent to the orchestrator, even if the task is retried. A task that ends **blocked** is still reported, so a failure never goes unnoticed. It is off unless you tick it.

### Templates

Text fields of an action are templates: `{path}` is replaced by the value found at that path, for example `Bug: {issue.title}`. A path that does not exist is left empty. Values are inserted as plain text and are never read as a second template.

Data that comes from a webhook or an event is **untrusted**: anyone who can post to the sender can write it. When it ends up in an agent task, Timon tells the agent so at the top of the task, and the agent should treat it as information, not as instructions. Keep task actions on webhooks for senders you trust, and prefer a TO DO idea when a human should look first.

### Running a script

A script action runs a program you name, in a folder of one of your projects, each time the trigger fires. Use it for deterministic work on a short rhythm (check a feed every five minutes, sync a file) and let the program wake an agent only when there is something to do, for example with `timon task create`:

```bash
timon trigger create --source schedule --name "X watcher" --cron "*/5 7-22 * * *" \
  --script python3 --arg scripts/watch.py --arg poll --cwd ~/projects/growth --env TREG_API_KEY
```

- **Program and arguments.** The program is a name found on the PATH, an absolute path, or a path relative to the folder. Arguments are passed one by one, as written: there is no shell, so pipes, `&&` or `*` mean nothing unless you call a shell yourself (`--script bash --arg -c --arg "…"`). Nothing from a webhook or an event is ever inserted into the command.
- **Folder.** An absolute path inside a registered project (see [Projects](./projects.md)), checked when you save and again at every run, symbolic links resolved.
- **Environment.** The program gets the usual system variables (PATH, HOME, language…) and `TIMON_HOME`, never the environment of the Timon daemon. To give it an API key, store the key in the secrets vault in **inject** mode, grant it globally or to that project, and list its name under **Secrets to inject**. Its value is replaced by `[secret NAME]` in everything Timon keeps of the output.
- **Time limit.** 300 seconds by default, up to 3600. When it is reached, the program and what it started are stopped. On Windows, if the main process has already exited, Timon skips further attempts to stop its tree; a descendant still holding its output open may need to be stopped manually.
- **No overlap.** If the previous run is still going, the tick does nothing (unless you allow overlapping runs). At most 8 scripts run at once on the machine.
- **Outcome.** Each run adds an entry to the trigger's journal with its exit code, its duration and the end of its output. A run that fails (exit code other than 0, time limit, program not found) sends an **alert** with the end of its output, unless you untick it. After 5 failed runs in a row, the trigger switches itself off and tells you.

The **Run scripts on the host** permission is part of full access; give it to a role in **Settings → Users** only to people you would trust with a terminal on this computer. Agents never get it, and plugins cannot create a script action. The same permission is needed on the owner's account to publish or run a workflow that has a **script** node; an agent can only propose such a node, which you accept in the workflow.

#### When an agent asks for a script

An agent that calls `trigger_create` with a script action creates nothing: Timon shows a card in its conversation, **… asks to run a script**, with the whole trigger — its schedule or event, the exact command line, the folder, the secret names, the time limit, and every other action it would run. **Approve and create** creates it as yours, with your permissions; **Reject** drops it. The agent is told your decision. A notification leads to the card if you are elsewhere.

From a terminal, the same proposals are listed with `timon trigger proposals`, then `timon trigger approve <id>` or `timon trigger reject <id>`.

What an agent can propose is limited: a schedule or an event source (never a webhook), and its other actions must be ones it could create on its own — approving lifts the script restriction and nothing else. An agent can never approve its own proposal, nor change or test a trigger that runs a script.

### Running a workflow

Choose the workflow, then the entry node to start from (a start node of its **published** version). The data of the call or event becomes the run's input. If the workflow is still busy and its overlap setting is to skip, the call is accepted and no new run starts.

A workflow's own **schedule**, **webhook** and **event** start nodes are native triggers too: publishing the workflow creates one trigger per node on this page (named after the workflow and the node), updates it when the node changes, and removes it with the node. The node's panel in the builder shows the trigger, its webhook route and lets you rotate its signing secret; the journal, rate limit, grouping and filter are edited here. A trigger you create yourself with the **Run a workflow** action is listed on the node as well, and is never rewritten by the workflow.

## Grouping bursts

Some senders post many calls about the same thing in a few seconds (an issue edited five times). In the advanced settings of a webhook or event trigger, set a **grouping key** (a path such as `issue.id`), a **quiet period** and an optional **ceiling**. Calls with the same key are grouped: the actions run once, with the last call's data, after the quiet period, or when the ceiling is reached. The sender gets `202` with `{"status": "coalesced"}`.

A burst still waiting when Timon stops is dropped, and the journal says so.

## Test and journal

**Send a sample** on a trigger lets you paste a JSON payload (and headers) and see what the actions would produce, without doing anything. Tick the option to really run them.

The **journal** shows the last calls of a trigger: received, ignored by the filter, duplicate, grouped, refused, error or test, with the reason, the delivery id and an excerpt of the data.

## What a sender receives

| Status | Meaning | What the sender should do |
| --- | --- | --- |
| `200` `received` | The actions ran | Nothing |
| `200` `duplicate` | This delivery was already received | Nothing |
| `200` `ignored` | The filter did not match | Nothing |
| `202` `coalesced` | Grouped with other calls | Nothing |
| `400` | The body is not valid JSON | Fix the body |
| `401` | Wrong signature, unknown or disabled route | Check the secret and the address |
| `413` | Body over 256 KB | Send less |
| `429` | Too many calls | Retry after the `Retry-After` delay |
| `502` | The actions failed | Retry later; the reason is in the journal |

A delivery is recognised as a duplicate by its delivery id (`X-GitHub-Delivery`, `webhook-id`, `X-Timon-Delivery`…) or by its signature, for 30 days. A call whose actions all failed is not counted, so the sender's retry runs.

## Signing a call

With the `generic` scheme, the sender signs each call with the trigger's secret:

- `X-Timon-Timestamp`: the current time in Unix seconds. Calls more than 5 minutes off are refused.
- `X-Timon-Signature`: `sha256=` followed by the hexadecimal HMAC-SHA256 of `<timestamp>.<body>`, computed with the secret, over the exact bytes sent.
- `X-Timon-Delivery` (optional): a unique id for this delivery, so a retry is recognised as a duplicate.

In JavaScript (Node.js 18 or later):

```js
import { createHmac } from 'node:crypto';

const url = 'https://timon.example.com/api/triggers/hooks/discord-bugs';
const secret = process.env.TIMON_TRIGGER_SECRET;
const body = JSON.stringify({ channel: 'bugs', author: 'alice', content: 'The login button does nothing' });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = 'sha256=' + createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-timon-timestamp': timestamp,
    'x-timon-signature': signature,
    'x-timon-delivery': 'message-1234',
  },
  body,
});
console.log(response.status, await response.json());
```

From a shell:

```bash
URL='https://timon.example.com/api/triggers/hooks/discord-bugs'
BODY='{"channel":"bugs","author":"alice","content":"The login button does nothing"}'
TS=$(date +%s)
SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$TIMON_TRIGGER_SECRET" -hex | sed 's/^.* //')
curl -X POST "$URL" -H 'content-type: application/json' \
  -H "x-timon-timestamp: $TS" -H "x-timon-signature: sha256=$SIG" \
  --data-binary "$BODY"
```

## Example: a bug report on Discord becomes a TO DO idea

Discord does not call arbitrary addresses when a message is posted, so a small relay sits in between: a Discord bot of your own, or an automation tool such as n8n, Zapier or Make, that reacts to new messages in your `#bugs` channel.

1. In Timon, open **Triggers → Webhooks → New webhook**.
   - Name: `Discord bugs` (route `discord-bugs`), scheme `generic`.
   - Filter: `channel` equals `bugs`.
   - Action **TO DO idea**: text `Bug: {content}`, notes `Reported by {author} on Discord: {url}`, project your project, urgency `bug`.
2. Copy the address and the secret shown after creation.
3. In the relay, on each new message, build a JSON body such as `{"channel": "bugs", "author": "…", "content": "…", "url": "…"}`, sign it as in [Signing a call](#signing-a-call), and POST it to the address. In n8n, for example, a Crypto node (HMAC, SHA256, hex) over `<timestamp>.<body>` followed by an HTTP Request node does this. Use the Discord message id as `X-Timon-Delivery`.
4. Post a test message, then check the trigger's journal and your TO DO notebook.

The same pattern works for any service that can send an HTTP request: a monitoring alert that notifies you, a form that files an idea, a CI failure that creates a task for an agent.

## Reaching Timon from outside

Timon listens only on your own computer by default. A webhook address works out of the box for senders on the same machine; a service on the internet (GitHub, a hosted bot, n8n cloud) cannot reach it until you choose to expose it.

To receive calls from outside, put a tunnel or a reverse proxy in front of the address of the Timon app (the one you open in your browser), for example Cloudflare Tunnel, Tailscale Funnel, ngrok or Caddy. Where your tool allows it, expose only the path `/api/triggers/hooks/`, not the whole app. The webhook address to give the sender is then the public address of the tunnel followed by `/api/triggers/hooks/<route>`.

Never expose a route that uses the `none` scheme. Timon refuses those calls when they arrive through the app, through a proxy (such as `tailscale serve` or Caddy, even one running on the same computer) or from another machine, and while `daemon.behindTlsProxy` is set: `none` is only meant for a script on the same computer calling Timon's background service directly.

The same holds when you publish the background service for [Machines](./machines.md), for example with `tailscale serve`: a `none` route stays refused from the other devices of your network, and every route reachable from them should use an HMAC signature or a shared token.

## For agents

Agents can manage triggers with the MCP tools `trigger_create`, `trigger_list`, `trigger_test` and `trigger_remove`, and you can do the same from the command line with `timon trigger list|create|test|remove` (see the [CLI reference](./cli-reference.md)). A trigger created by an agent can only do what that agent was allowed to do, and an agent can never create a webhook without a secret, one that runs a workflow, or one that sends calls outside; a trigger that runs a script becomes a proposal you approve.

A trigger keeps running after the conversation that created it has ended, so **a trigger an agent creates is saved switched off**: it shows dimmed in the list and runs only once you switch it on. Switching it on keeps it as the agent made it, limited to what that agent may do and to the agents it may hand work to. An agent cannot switch a trigger on, and when it changes what an enabled trigger does (its source, filter or actions), the trigger is switched off until you look at it again; renaming it or switching it off leaves it as it is. The same applies to routines.

A trigger an agent created before this rule existed, and that nobody ever switched on, is switched off the first time Timon starts after the update. A notification lists each one: open **Triggers** and switch back on those you want to keep.
